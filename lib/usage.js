'use strict';

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const readline = require('readline');

const {
  parseStatusLinePayload,
  parseResetTime,
  summarizeJsonlUsage,
  toEpochMs,
  startOfLocalWeek,
} = require('./usage-parser');

/** Past this age the statusLine quota snapshot is treated as unknown. */
const QUOTA_MAX_AGE_MS = 6 * 60 * 60 * 1000;

/** Aggregating every transcript is cheap but not free; one pass per minute. */
const CACHE_TTL_MS = 60 * 1000;

/** Open file descriptors held at once while streaming transcripts. */
const READ_CONCURRENCY = 8;

/** Newest transcripts first, capped so a huge ~/.claude never stalls a request. */
const MAX_FILES = 400;

/** A transcript line longer than this is a runaway write, not a message. */
const MAX_LINE_BYTES = 4 * 1024 * 1024;

function makeLogger(logger) {
  const base = logger && typeof logger === 'object' ? logger : {};
  const bind = (name, fallback) =>
    (typeof base[name] === 'function' ? base[name].bind(base) : fallback);
  return {
    debug: bind('debug', () => {}),
    info: bind('info', console.log.bind(console)),
    warn: bind('warn', console.warn.bind(console)),
    error: bind('error', console.error.bind(console)),
  };
}

async function mapWithLimit(items, limit, fn) {
  const out = new Array(items.length);
  let cursor = 0;
  const workerCount = Math.max(1, Math.min(limit, items.length));
  const workers = [];
  for (let i = 0; i < workerCount; i++) {
    workers.push((async () => {
      for (;;) {
        const index = cursor++;
        if (index >= items.length) return;
        out[index] = await fn(items[index], index);
      }
    })());
  }
  await Promise.all(workers);
  return out;
}

/**
 * Quota and usage, read from sources that cost nothing.
 *
 * Two inputs, no side effects on the user's account:
 *  - `config.quotaFile`, written by the statusLine hook, holds the exact
 *    rate_limits Claude Code reports. Primary, but only as fresh as the last
 *    status line render, hence the age check.
 *  - the JSONL transcripts under `config.projectsDir`, streamed line by line,
 *    give the token and message totals for today / this week / the last five
 *    hours.
 *
 * It never spawns `claude` and never scrapes a screen: displaying a percentage
 * must not itself burn quota or answer a trust prompt on the user's behalf.
 *
 * Per-session spend is deliberately not here. It used to be, as a map nothing
 * ever wrote to and nothing ever read, with a comment claiming the hook bus fed
 * it. `lib/budget.js` owns that now, against a ledger that survives a restart
 * and can actually stop a session.
 */
class UsageTracker {
  /** @param {{config: object, logger?: object}} deps */
  constructor({ config, logger } = {}) {
    if (!config) throw new TypeError('UsageTracker requires a config');
    this.config = config;
    this.log = makeLogger(logger);

    this.quotaFile = config.quotaFile;
    this.projectsDir = config.projectsDir;

    /** @type {{value: object, at: number}|null} */
    this._cache = null;
    /** @type {Promise<object>|null} */
    this._inflight = null;

  }

  /**
   * @param {{force?: boolean, now?: number}} [opts]
   * @returns {Promise<{quota:object|null, recent:object, source:string, updatedAt:number}>}
   */
  async read(opts = {}) {
    const now = toEpochMs(opts.now) ?? Date.now();
    if (!opts.force && this._cache && now - this._cache.at < CACHE_TTL_MS) {
      return this._cache.value;
    }
    if (this._inflight) return this._inflight;

    this._inflight = this._compute(now)
      .then((value) => {
        this._cache = { value, at: now };
        return value;
      })
      .finally(() => {
        this._inflight = null;
      });

    return this._inflight;
  }

  /** Drop the cached snapshot so the next read() hits disk again. */
  invalidate() {
    this._cache = null;
  }

  async _compute(now) {
    const [quota, recent] = await Promise.all([
      this._readQuota(now),
      this._readRecent(now),
    ]);
    return {
      quota,
      recent,
      source: quota ? 'statusline' : 'transcripts',
      updatedAt: now,
    };
  }

  /**
   * The statusLine snapshot, or null when it is missing or too old to trust.
   * A stale file is not an error: the user may simply not have rendered a
   * status line in a while.
   */
  async _readQuota(now) {
    let raw;
    try {
      raw = await fsp.readFile(this.quotaFile, 'utf-8');
    } catch (err) {
      if (err.code !== 'ENOENT') {
        this.log.warn(`usage: cannot read quota file ${this.quotaFile}: ${err.message}`);
      }
      return null;
    }

    let payload;
    try {
      payload = JSON.parse(raw);
    } catch (err) {
      this.log.warn(`usage: quota file ${this.quotaFile} is not valid JSON: ${err.message}`);
      return null;
    }

    const parsed = parseStatusLinePayload(payload);
    if (!parsed) {
      this.log.debug(`usage: quota file ${this.quotaFile} carries no rate limits`);
      return null;
    }

    let updatedAt = toEpochMs(payload.updatedAt ?? payload.updated ?? payload.timestamp);
    if (updatedAt === null) {
      try {
        const st = await fsp.stat(this.quotaFile);
        updatedAt = Math.round(st.mtimeMs);
      } catch (err) {
        this.log.warn(`usage: cannot stat quota file ${this.quotaFile}: ${err.message}`);
        return null;
      }
    }

    const ageMs = now - updatedAt;
    if (ageMs > QUOTA_MAX_AGE_MS) {
      this.log.debug(`usage: quota snapshot is ${Math.round(ageMs / 60000)} min old, dropping it`);
      return null;
    }

    // Some payloads carry only a human phrase ("Resets 10:30am"); turn it into
    // an absolute instant here so the browser never has to guess.
    for (const key of ['five_hour', 'seven_day', 'extra']) {
      const window = parsed[key];
      if (window && window.resetsAt === null && window.resetsText) {
        window.resetsAt = parseResetTime(window.resetsText, now);
      }
    }

    return { ...parsed, updatedAt, ageMs };
  }

  async _readRecent(now) {
    const since = startOfLocalWeek(now);
    const files = await this._listTranscripts(since);
    if (files.length === 0) return summarizeJsonlUsage([], now);

    const perFile = await mapWithLimit(files, READ_CONCURRENCY, (file) =>
      this._readTranscript(file, since));

    const summary = summarizeJsonlUsage(perFile.filter(Boolean).flat(), now);
    summary.filesScanned = files.length;
    return summary;
  }

  /**
   * Transcript files touched since `since`, newest first.
   * A file whose mtime predates the window cannot hold an entry inside it.
   */
  async _listTranscripts(since) {
    let projectDirs;
    try {
      projectDirs = await fsp.readdir(this.projectsDir, { withFileTypes: true });
    } catch (err) {
      if (err.code !== 'ENOENT') {
        this.log.warn(`usage: cannot list ${this.projectsDir}: ${err.message}`);
      }
      return [];
    }

    const found = [];
    for (const dirent of projectDirs) {
      if (!dirent.isDirectory()) continue;
      const dir = path.join(this.projectsDir, dirent.name);
      let names;
      try {
        names = await fsp.readdir(dir);
      } catch (err) {
        this.log.warn(`usage: cannot list ${dir}: ${err.message}`);
        continue;
      }
      const jsonl = names.filter((n) => n.endsWith('.jsonl'));
      const stats = await mapWithLimit(jsonl, READ_CONCURRENCY, async (name) => {
        const file = path.join(dir, name);
        try {
          const st = await fsp.stat(file);
          if (!st.isFile() || st.mtimeMs < since) return null;
          return { file, mtimeMs: st.mtimeMs };
        } catch (err) {
          if (err.code !== 'ENOENT') {
            this.log.warn(`usage: cannot stat ${file}: ${err.message}`);
          }
          return null;
        }
      });
      for (const hit of stats) if (hit) found.push(hit);
    }

    found.sort((a, b) => b.mtimeMs - a.mtimeMs);
    if (found.length > MAX_FILES) {
      this.log.warn(`usage: ${found.length} transcripts in window, scanning the ${MAX_FILES} most recent`);
      found.length = MAX_FILES;
    }
    return found.map((h) => h.file);
  }

  /**
   * Stream one transcript and keep only what the aggregator needs. Never
   * readFile: a long running project transcript reaches tens of megabytes,
   * and every poll would load all of them into memory at once.
   */
  async _readTranscript(file, since) {
    const out = [];
    // Claude Code names each transcript after its session id, which is the
    // reliable fallback for lines that omit sessionId.
    let sessionId = path.basename(file, '.jsonl');
    let badLines = 0;
    let stream;

    try {
      stream = fs.createReadStream(file, { encoding: 'utf-8' });
      const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
      for await (const line of rl) {
        if (!line || line.length < 2) continue;
        if (line.length > MAX_LINE_BYTES) {
          badLines += 1;
          continue;
        }
        let entry;
        try {
          entry = JSON.parse(line);
        } catch {
          badLines += 1;
          continue;
        }
        if (!entry || typeof entry !== 'object') continue;
        if (typeof entry.sessionId === 'string' && entry.sessionId) sessionId = entry.sessionId;

        const ts = toEpochMs(entry.timestamp || (entry.message && entry.message.timestamp));
        if (ts === null || ts < since) continue;

        const message = entry.message && typeof entry.message === 'object' ? entry.message : null;
        const usage = (message && message.usage) || entry.usage || null;
        if (entry.type !== 'user' && !usage) continue;

        out.push({
          timestamp: ts,
          type: entry.type,
          sessionId,
          model: (message && message.model) || entry.model || null,
          messageId: (message && message.id) || null,
          usage: usage || null,
        });
      }
    } catch (err) {
      this.log.warn(`usage: failed reading ${file}: ${err.message}`);
      return out;
    } finally {
      if (stream && !stream.destroyed) stream.destroy();
    }

    if (badLines > 0) {
      this.log.debug(`usage: skipped ${badLines} unparsable line(s) in ${file}`);
    }
    return out;
  }

}

module.exports = {
  UsageTracker,
  QUOTA_MAX_AGE_MS,
  CACHE_TTL_MS,
  READ_CONCURRENCY,
  MAX_FILES,
};
