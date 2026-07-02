'use strict';

const { EventEmitter } = require('events');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const { execFile } = require('child_process');

const defaultConfig = require('./config');
const { STATUS, HOOK_EVENT } = require('./protocol');
const { redactDeep } = require('./redact');

/** A tool running longer than this on a BUSY session is reported as stalled. */
const STALL_TOOL_MS = 120000;
/** A question left unanswered longer than this is reported as stalled. */
const STALL_INPUT_MS = 60000;
const STALL_INTERVAL_MS = 15000;

/** Size at which the day's JSONL file is rotated aside. */
const MAX_LOG_BYTES = 20 * 1024 * 1024;
/** Hard ceiling on lines held in memory by a single `timeline()` call. */
const MAX_TIMELINE_LINES = 5000;
/** Bytes read from the tail of each JSONL file when answering `timeline()`. */
const TAIL_BYTES = 2 * 1024 * 1024;
const DEFAULT_TIMELINE_LIMIT = 200;

const GIT_BRANCH_TTL_MS = 30000;
const GIT_TIMEOUT_MS = 1500;

const LOG_FILE_RE = /^(\d{4}-\d{2}-\d{2})(?:\.(\d+))?\.jsonl$/;

/** Collapses whitespace and clips, so a detail always renders on one line. */
function oneLine(value, max) {
  if (value === null || value === undefined) return null;
  const text = String(value).replace(/\s+/g, ' ').trim();
  if (!text) return null;
  return text.length > max ? text.slice(0, Math.max(1, max - 3)) + '...' : text;
}

function shortPath(value, cwd) {
  if (typeof value !== 'string' || !value) return null;
  if (!cwd) return oneLine(value, 120);
  let rel;
  try {
    rel = path.relative(cwd, value);
  } catch {
    return oneLine(value, 120);
  }
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return oneLine(value, 120);
  return oneLine(rel.split(path.sep).join('/'), 120);
}

function domainOf(url) {
  if (typeof url !== 'string' || !url) return null;
  try {
    return new URL(url).host || null;
  } catch {
    return oneLine(url, 80);
  }
}

/**
 * Turns a tool_input into a short line a human can read at a glance in the
 * session list: the difference between "Bash" and "Bash npm test --watch=false",
 * which is the whole point of the sidebar.
 */
function summarizeToolInput(tool, input, cwd) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  const name = typeof tool === 'string' ? tool : '';

  switch (name) {
    case 'Bash':
      return oneLine(input.command, 120);
    case 'BashOutput':
    case 'KillShell':
      return oneLine(input.bash_id || input.shell_id, 60);
    case 'Read':
    case 'Write':
    case 'NotebookEdit':
      return shortPath(input.file_path || input.notebook_path || input.path, cwd);
    case 'Edit':
    case 'MultiEdit':
      return shortPath(input.file_path || input.path, cwd);
    case 'Glob':
      return oneLine(input.pattern, 100);
    case 'Grep': {
      const where = input.path ? ` in ${shortPath(input.path, cwd)}` : '';
      return oneLine((input.pattern || '') + where, 120);
    }
    case 'WebFetch':
      return domainOf(input.url);
    case 'WebSearch':
      return oneLine(input.query, 100);
    case 'Task':
      return oneLine(input.description || input.subagent_type, 100);
    case 'Skill':
      return oneLine(input.skill || input.name, 80);
    case 'TodoWrite': {
      const todos = Array.isArray(input.todos) ? input.todos : [];
      const active = todos.find(t => t && t.status === 'in_progress');
      if (active) return oneLine(active.content || active.activeForm, 100);
      return todos.length ? `${todos.length} todos` : null;
    }
    default:
      break;
  }

  // MCP tools and anything new: show the first field that reads like a subject.
  for (const key of ['command', 'file_path', 'path', 'pattern', 'query', 'url', 'prompt', 'description', 'name', 'id']) {
    const value = input[key];
    if (typeof value === 'string' && value.trim()) {
      return key === 'url' ? domainOf(value) : oneLine(value, 120);
    }
  }
  const keys = Object.keys(input);
  return keys.length ? oneLine(keys.slice(0, 4).join(', '), 100) : null;
}

/** True when a PostToolUse response reports a failure. */
function toolFailed(payload) {
  const r = payload.tool_response;
  if (r && typeof r === 'object') {
    if (r.is_error === true || r.isError === true) return true;
    if (typeof r.error === 'string' && r.error) return true;
  }
  if (payload.tool_error === true) return true;
  return typeof payload.error === 'string' && payload.error.length > 0;
}

function toolErrorMessage(payload) {
  const r = payload.tool_response;
  if (r && typeof r === 'object') {
    if (typeof r.error === 'string') return oneLine(r.error, 200);
    if (typeof r.stderr === 'string' && r.stderr) return oneLine(r.stderr, 200);
    if (typeof r.content === 'string' && (r.is_error || r.isError)) return oneLine(r.content, 200);
  }
  if (typeof payload.error === 'string') return oneLine(payload.error, 200);
  return null;
}

function num(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** No tool is running any more. */
function clearTool(patch) {
  patch.tool = null;
  patch.toolDetail = null;
  patch.toolStartedAt = null;
}

function samePath(a, b, isWin) {
  if (!a || !b) return false;
  let pa;
  let pb;
  try {
    pa = path.resolve(a);
    pb = path.resolve(b);
  } catch {
    return false;
  }
  return isWin ? pa.toLowerCase() === pb.toLowerCase() : pa === pb;
}

function dayKey(ts) {
  const d = new Date(ts);
  const pad = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/**
 * Reads the tail of a file as lines, bounded in both bytes and lines so a
 * 20 MB log can never be pulled into memory whole.
 *
 * @returns {Promise<string[]>} newest lines last; a leading partial line is dropped
 */
async function readTailLines(file, maxBytes, maxLines) {
  const handle = await fsp.open(file, 'r');
  try {
    const stat = await handle.stat();
    const start = Math.max(0, stat.size - maxBytes);
    const length = stat.size - start;
    if (length <= 0) return [];
    const buf = Buffer.allocUnsafe(length);
    let filled = 0;
    while (filled < length) {
      const { bytesRead } = await handle.read(buf, filled, length - filled, start + filled);
      if (bytesRead <= 0) break;
      filled += bytesRead;
    }
    let lines = buf.subarray(0, filled).toString('utf8').split('\n');
    if (start > 0) lines.shift();
    if (lines.length > maxLines) lines = lines.slice(-maxLines);
    return lines.filter(line => line.length > 0);
  } finally {
    await handle.close();
  }
}

/**
 * The event bus between Claude Code's hooks and the rest of Orchestra.
 *
 * Everything the UI knows about what an agent is doing right now arrives
 * through `ingest`, which moves the owning session's state machine, appends the
 * normalized event to a durable per-day JSONL timeline, and re-emits it.
 *
 * @fires HookBus#event    the normalized event, for WS fanout
 * @fires HookBus#stalled  a session that has been stuck long enough to report
 */
class HookBus extends EventEmitter {
  /**
   * @param {Object} deps
   * @param {import('./session-manager').SessionManager} deps.sessions
   * @param {Object} [deps.config]  defaults to lib/config
   * @param {{info?:Function,warn?:Function,error?:Function,debug?:Function}} [deps.logger]
   */
  constructor({ sessions, config, logger } = {}) {
    super();
    if (!sessions) throw new Error('HookBus requires a SessionManager');
    this.sessions = sessions;
    this.config = config || defaultConfig;
    this.logger = logger || null;

    this.eventsDir = this.config.eventsDir;
    this.isWin = !!this.config.IS_WIN;

    /** Monotonic counter so two events in the same millisecond stay ordered. */
    this._seq = 0;
    /** @type {Map<string, {branch: string|null, at: number, pending: boolean}>} */
    this._branchCache = new Map();
    /** @type {Map<string, string>} sessionId -> last emitted stall key */
    this._stalled = new Map();

    this._stream = null;
    this._streamDay = null;
    this._streamFile = null;
    this._streamBytes = 0;
    this._rotating = false;
    /** @type {string[]} lines held while a rotation rename is in flight */
    this._queued = [];

    this._timer = null;
    /**
     * Set by stop(). Every write path checks it, because a hook request already
     * in flight when the server closed would otherwise reopen a write stream
     * that nothing is left to close.
     */
    this._stopped = false;
    this._onSessionClosed = ({ id }) => {
      this._stalled.delete(id);
    };
  }

  /** Starts the stall sweep. Safe to call twice. */
  start() {
    this._stopped = false;
    if (this._timer) return;
    this._timer = setInterval(() => this.checkStalled(), STALL_INTERVAL_MS);
    if (this._timer.unref) this._timer.unref();
    this.sessions.on('closed', this._onSessionClosed);
  }

  /** Stops the sweep and closes the timeline stream. */
  stop() {
    this._stopped = true;
    if (this._timer) {
      clearInterval(this._timer);
      this._timer = null;
    }
    this.sessions.removeListener('closed', this._onSessionClosed);
    // A rotation in flight would replay these through _write(); drop them
    // rather than have its callback reopen the file we are closing.
    this._queued = [];
    this._rotating = false;
    if (this._stream) {
      const stream = this._stream;
      this._stream = null;
      this._streamDay = null;
      this._streamFile = null;
      this._streamBytes = 0;
      stream.end();
    }
  }

  /**
   * Normalizes one hook event, applies it to the owning session, persists it
   * and emits it.
   *
   * @param {string} eventName  e.g. 'PreToolUse'
   * @param {Object} payload    Claude Code's payload plus the orchestra* fields
   *                            added by hooks/orchestra-hook.js
   * @returns {{ok: boolean, matched: boolean, sessionId: string|null, event: Object|null, error?: string}}
   */
  ingest(eventName, payload) {
    const name = typeof eventName === 'string' ? eventName.trim() : '';
    if (!/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(name)) {
      return { ok: false, matched: false, sessionId: null, event: null, error: 'invalid event name' };
    }
    const body = payload && typeof payload === 'object' && !Array.isArray(payload) ? payload : {};

    const ts = this._timestamp(body);
    const { session, matched, reason } = this._resolve(body);

    const event = {
      ts,
      seq: ++this._seq,
      event: name,
      sessionId: session ? session.id : null,
      matched,
      claudeSessionId: typeof body.session_id === 'string' ? body.session_id : null,
      cwd: typeof body.cwd === 'string' ? body.cwd : (session ? session.cwd : null),
      raceId: body.orchestraRaceId || (session && session.race ? session.race.raceId : null),
      variant: body.orchestraRaceVariant || (session && session.race ? session.race.variant : null),
      tool: null,
      detail: null,
      status: null,
      message: null,
      durationMs: null,
      ok: null,
    };
    if (!matched && reason) event.unmatchedReason = reason;
    if (body.orchestraParseError) event.parseError = String(body.orchestraParseError).slice(0, 200);
    if (body.orchestraTruncated) event.truncated = true;

    if (session) {
      this._apply(session, name, body, event, ts);
      event.status = session.status;
    } else {
      this._log('debug', `hook ${name} did not match a session (${reason || 'no candidate'})`);
    }

    this._append(event);
    this.emit('event', event);

    return { ok: true, matched, sessionId: event.sessionId, event };
  }

  /**
   * The live session objects, through the manager's public API only. `list()`
   * returns wire copies, which are not what `setStatus` needs.
   */
  _allSessions() {
    const out = [];
    for (const wire of this.sessions.list()) {
      const session = this.sessions.get(wire.id);
      if (session) out.push(session);
    }
    return out;
  }

  /**
   * Hook timestamps come from the same machine as the server, so they are more
   * accurate than arrival time. A wildly skewed one is ignored rather than
   * trusted, because it would corrupt the timeline ordering forever.
   */
  _timestamp(body) {
    const now = Date.now();
    const stamped = num(body.orchestraTs);
    if (stamped !== null && Math.abs(stamped - now) < 5 * 60 * 1000) return stamped;
    return now;
  }

  /**
   * Finds the session an event belongs to: the PTY's own env var first, since
   * it is exact, then the Claude session id we may already have recorded, then
   * a unique cwd match among live sessions. When two live sessions share a cwd
   * we deliberately give up, because showing the wrong agent's activity is
   * worse than showing none.
   *
   * @returns {{session: Object|null, matched: boolean, reason: string|null}}
   */
  _resolve(body) {
    const explicit = typeof body.orchestraSessionId === 'string' ? body.orchestraSessionId : '';
    if (explicit) {
      const session = this.sessions.get(explicit);
      if (session) return { session, matched: true, reason: null };
      return { session: null, matched: false, reason: 'unknown-session-id' };
    }

    const live = this._allSessions().filter(s => s.status !== STATUS.EXITED);

    const claudeId = typeof body.session_id === 'string' ? body.session_id : '';
    if (claudeId) {
      const byClaude = live.filter(s => s.agent && s.agent.claudeSessionId === claudeId);
      if (byClaude.length === 1) return { session: byClaude[0], matched: true, reason: null };
    }

    const cwd = typeof body.cwd === 'string' ? body.cwd : '';
    if (!cwd) return { session: null, matched: false, reason: 'no-session-id-no-cwd' };

    const byCwd = live.filter(s => samePath(s.cwd, cwd, this.isWin));
    if (byCwd.length === 1) return { session: byCwd[0], matched: true, reason: null };
    if (byCwd.length === 0) return { session: null, matched: false, reason: 'no-cwd-match' };
    return { session: null, matched: false, reason: 'ambiguous-cwd' };
  }

  /** Applies one event to a session's state machine. */
  _apply(session, name, body, event, ts) {
    const agent = session.agent;
    const patch = { lastEventAt: ts };
    this._collectUsage(agent, body, patch);

    if (typeof body.session_id === 'string' && body.session_id) {
      patch.claudeSessionId = body.session_id;
    }
    const model = this._modelOf(body);
    if (model) patch.model = model;

    switch (name) {
      case HOOK_EVENT.SESSION_START: {
        clearTool(patch);
        this._setStatus(session, STATUS.IDLE, patch);
        this._refreshGitBranch(session);
        return;
      }

      case HOOK_EVENT.USER_PROMPT_SUBMIT: {
        const prompt = typeof body.prompt === 'string' ? body.prompt : '';
        patch.lastPrompt = prompt ? prompt.slice(0, 200) : agent.lastPrompt;
        patch.turns = (num(agent.turns) || 0) + 1;
        patch.lastQuestion = null;
        event.message = oneLine(prompt, 200);
        event.detail = event.message;
        this._setStatus(session, STATUS.BUSY, patch);
        return;
      }

      case HOOK_EVENT.PRE_TOOL_USE: {
        const tool = typeof body.tool_name === 'string' ? body.tool_name : null;
        const detail = summarizeToolInput(tool, body.tool_input, session.cwd);
        patch.tool = tool;
        patch.toolDetail = detail;
        patch.toolStartedAt = ts;
        event.tool = tool;
        event.detail = detail;
        this._setStatusUnlessBlocked(session, STATUS.BUSY, patch);
        return;
      }

      case HOOK_EVENT.POST_TOOL_USE: {
        const tool = typeof body.tool_name === 'string' ? body.tool_name : agent.tool;
        const startedAt = num(agent.toolStartedAt);
        const duration = startedAt !== null ? Math.max(0, ts - startedAt) : null;
        const failed = toolFailed(body);
        clearTool(patch);
        patch.lastTool = tool;
        patch.lastToolMs = duration;
        patch.lastToolError = failed ? toolErrorMessage(body) : null;
        event.tool = tool;
        event.detail = summarizeToolInput(tool, body.tool_input, session.cwd) || agent.toolDetail;
        event.durationMs = duration;
        event.ok = !failed;
        this._setStatusUnlessBlocked(session, STATUS.BUSY, patch);
        return;
      }

      case HOOK_EVENT.NOTIFICATION: {
        const message = oneLine(body.message, 300);
        patch.lastQuestion = message;
        event.message = message;
        event.detail = message;
        this._setStatusUnlessBlocked(session, STATUS.AWAITING_INPUT, patch);
        return;
      }

      case HOOK_EVENT.STOP: {
        clearTool(patch);
        patch.lastQuestion = null;
        this._setStatus(session, STATUS.IDLE, patch);
        return;
      }

      case HOOK_EVENT.SUBAGENT_STOP: {
        patch.subagents = (num(agent.subagents) || 0) + 1;
        event.detail = `${patch.subagents} subagents`;
        this._setStatusUnlessBlocked(session, STATUS.BUSY, patch);
        return;
      }

      case HOOK_EVENT.SESSION_END: {
        // The PTY can outlive Claude's own session (a --continue, a rerun), so
        // the status is left alone and only the counters are updated.
        event.detail = oneLine(body.reason, 100);
        this._patch(session, patch);
        return;
      }

      default: {
        // PreCompact, and anything Claude Code adds later: recorded, not acted on.
        event.detail = oneLine(body.trigger || body.reason || body.message, 120);
        this._patch(session, patch);
      }
    }
  }

  _modelOf(body) {
    if (typeof body.model === 'string' && body.model) return body.model;
    if (body.model && typeof body.model === 'object') {
      if (typeof body.model.id === 'string') return body.model.id;
      if (typeof body.model.display_name === 'string') return body.model.display_name;
    }
    return null;
  }

  /**
   * Cost and token counters. `total_cost_usd` and a `tokens` object are
   * cumulative for the Claude session, so they are taken with max() and a
   * redelivered event cannot make the number jump. A `usage` block is
   * per-message and is added.
   */
  _collectUsage(agent, body, patch) {
    const totals = [
      body.total_cost_usd,
      body.cost && body.cost.total_cost_usd,
      typeof body.cost === 'number' ? body.cost : null,
    ];
    for (const candidate of totals) {
      const value = num(candidate);
      if (value !== null && value >= 0) {
        patch.cost = Math.max(num(patch.cost) ?? num(agent.cost) ?? 0, value);
      }
    }

    const current = agent.tokens && typeof agent.tokens === 'object'
      ? agent.tokens
      : { input: 0, output: 0 };
    let input = num(current.input) || 0;
    let output = num(current.output) || 0;
    let touched = false;

    const usage = body.usage && typeof body.usage === 'object' ? body.usage : null;
    if (usage) {
      const inc = (num(usage.input_tokens) || 0)
        + (num(usage.cache_creation_input_tokens) || 0)
        + (num(usage.cache_read_input_tokens) || 0);
      const outc = num(usage.output_tokens) || 0;
      if (inc || outc) {
        input += inc;
        output += outc;
        touched = true;
      }
    }

    const cumulative = body.tokens && typeof body.tokens === 'object' ? body.tokens : null;
    if (cumulative) {
      const ci = num(cumulative.input);
      const co = num(cumulative.output);
      if (ci !== null) { input = Math.max(input, ci); touched = true; }
      if (co !== null) { output = Math.max(output, co); touched = true; }
    }

    if (touched) patch.tokens = { input, output };
  }

  _setStatus(session, status, patch) {
    this.sessions.setStatus(session, status, patch);
    this._stalled.delete(session.id);
  }

  /**
   * Moves the state machine unless an approval is holding the session.
   *
   * AWAITING_PERMISSION is owned by the approvals queue and means a hook is
   * literally blocking an agent right now. Claude Code fires PreToolUse,
   * PostToolUse and Notification around that same pause; letting any of them
   * write BUSY over it would hide the block from the operator and make the
   * stall sweep report a stuck tool. The agent fields are still recorded, only
   * the status is left alone.
   */
  _setStatusUnlessBlocked(session, status, patch) {
    if (session.status === STATUS.AWAITING_PERMISSION) this._patch(session, patch);
    else this._setStatus(session, status, patch);
  }

  /** Updates agent fields without touching the state machine. */
  _patch(session, patch) {
    this.sessions.setStatus(session, session.status, patch);
  }

  /**
   * Resolves the git branch for a session's cwd and patches it in when it
   * differs. Kept off the ingest path: an ingest must answer the hook in
   * microseconds, and a cold `git` on Windows is not that.
   */
  _refreshGitBranch(session) {
    const cwd = session.cwd;
    if (!cwd) return;
    const cached = this._branchCache.get(cwd);
    const now = Date.now();
    if (cached) {
      if (cached.pending) return;
      if (now - cached.at < GIT_BRANCH_TTL_MS) {
        if (cached.branch && session.agent.gitBranch !== cached.branch) {
          this._patch(session, { gitBranch: cached.branch });
        }
        return;
      }
    }
    this._branchCache.set(cwd, { branch: cached ? cached.branch : null, at: now, pending: true });

    execFile(
      'git',
      ['rev-parse', '--abbrev-ref', 'HEAD'],
      { cwd, timeout: GIT_TIMEOUT_MS, windowsHide: true },
      (err, stdout) => {
        const branch = err ? null : String(stdout || '').trim() || null;
        this._branchCache.set(cwd, { branch, at: Date.now(), pending: false });
        if (err) {
          // Not a repo is the common, uninteresting case; anything else is not.
          if (!/not a git repository/i.test(String(err.message || ''))) {
            this._log('debug', `git branch lookup failed in ${cwd}: ${err.message}`);
          }
          return;
        }
        const live = this.sessions.get(session.id);
        if (live && branch && live.agent.gitBranch !== branch) {
          this._patch(live, { gitBranch: branch });
        }
      }
    );
  }

  /**
   * Reports sessions that look stuck: a tool running past STALL_TOOL_MS, or a
   * question left unanswered past STALL_INPUT_MS. Each occurrence is emitted
   * once, and a session only becomes reportable again after its state changes,
   * so this can run on a timer without spamming.
   *
   * @returns {Array<Object>} the stall descriptors emitted by this call
   */
  checkStalled() {
    const now = Date.now();
    const emitted = [];

    for (const session of this._allSessions()) {
      const agent = session.agent || {};
      let reason = null;
      let since = null;

      if (session.status === STATUS.BUSY) {
        const startedAt = num(agent.toolStartedAt);
        if (startedAt !== null && now - startedAt > STALL_TOOL_MS) {
          reason = 'tool';
          since = startedAt;
        }
      } else if (session.status === STATUS.AWAITING_INPUT) {
        const at = num(agent.lastEventAt) ?? num(session.lastActivityAt);
        if (at !== null && now - at > STALL_INPUT_MS) {
          reason = 'awaiting-input';
          since = at;
        }
      }

      if (!reason) {
        this._stalled.delete(session.id);
        continue;
      }
      const key = `${reason}:${since}`;
      if (this._stalled.get(session.id) === key) continue;
      this._stalled.set(session.id, key);

      const info = {
        sessionId: session.id,
        name: session.name,
        status: session.status,
        reason,
        since,
        elapsedMs: now - since,
        tool: agent.tool || null,
        detail: agent.toolDetail || agent.lastQuestion || null,
      };
      emitted.push(info);
      this.emit('stalled', info);
    }

    // Sessions that vanished between sweeps must not pin their key forever.
    for (const id of [...this._stalled.keys()]) {
      if (!this.sessions.get(id)) this._stalled.delete(id);
    }

    return emitted;
  }

  /**
   * Reads back the persisted timeline, newest files first, oldest event first
   * in the returned array.
   *
   * @param {Object} [query]
   * @param {string|null} [query.sessionId] restrict to one session
   * @param {number} [query.limit]          default 200, capped at 5000
   * @param {number} [query.since]          epoch ms, exclusive
   * @returns {Promise<Array<Object>>}
   */
  async timeline({ sessionId = null, limit = DEFAULT_TIMELINE_LIMIT, since = 0 } = {}) {
    const requested = Number.isFinite(limit) ? Math.floor(limit) : DEFAULT_TIMELINE_LIMIT;
    const cap = Math.min(MAX_TIMELINE_LINES, Math.max(1, requested || DEFAULT_TIMELINE_LIMIT));
    const floor = Number.isFinite(since) ? since : 0;

    const out = [];
    let scanned = 0;
    let malformed = 0;

    for (const file of await this._logFiles()) {
      if (out.length >= cap || scanned >= MAX_TIMELINE_LINES) break;
      let lines;
      try {
        lines = await readTailLines(path.join(this.eventsDir, file), TAIL_BYTES, MAX_TIMELINE_LINES);
      } catch (err) {
        this._log('warn', `timeline: could not read ${file}: ${err.message}`);
        continue;
      }

      let exhausted = false;
      for (let i = lines.length - 1; i >= 0; i--) {
        if (out.length >= cap || scanned >= MAX_TIMELINE_LINES) break;
        scanned++;
        let ev;
        try {
          ev = JSON.parse(lines[i]);
        } catch {
          malformed++;
          continue;
        }
        if (!ev || typeof ev !== 'object') { malformed++; continue; }
        // Lines are appended in timestamp order, so the first one at or before
        // the floor means everything further back is too old.
        if (floor && num(ev.ts) !== null && ev.ts <= floor) { exhausted = true; break; }
        if (sessionId && ev.sessionId !== sessionId) continue;
        out.push(ev);
      }
      if (exhausted) break;
    }

    if (malformed) this._log('warn', `timeline: skipped ${malformed} malformed line(s)`);
    return out.reverse();
  }

  /** Day files, newest first. */
  async _logFiles() {
    let names;
    try {
      names = await fsp.readdir(this.eventsDir);
    } catch (err) {
      if (err.code !== 'ENOENT') this._log('warn', `timeline: cannot list ${this.eventsDir}: ${err.message}`);
      return [];
    }
    return names
      .map(n => {
        const m = LOG_FILE_RE.exec(n);
        // The unsuffixed file is the live one, so it sorts newest within a day.
        return m ? { name: n, day: m[1], index: m[2] === undefined ? Infinity : Number(m[2]) } : null;
      })
      .filter(Boolean)
      .sort((a, b) => (a.day === b.day ? b.index - a.index : (a.day < b.day ? 1 : -1)))
      .map(e => e.name);
  }

  /**
   * Appends one normalized event to today's JSONL file, redacted on the way to
   * disk: this file keeps every command, prompt and edit an agent produced, so
   * persisting a secret one happened to type would turn the governance feature
   * into a durable credential store. The in-memory event broadcast to the UI is
   * left intact, because a human approving a command needs to see it.
   */
  _append(event) {
    if (this._stopped) return;
    let line;
    try {
      line = JSON.stringify(redactDeep(event)) + '\n';
    } catch (err) {
      this._log('error', `timeline: could not serialize ${event.event}: ${err.message}`);
      return;
    }
    if (this._rotating) {
      // Bounded so a rename that never completes cannot grow without limit.
      if (this._queued.length < 10000) this._queued.push(line);
      return;
    }
    this._write(line, event.ts);
  }

  _write(line, ts) {
    if (this._stopped) return;
    const stream = this._streamFor(ts);
    if (!stream) return;
    this._streamBytes += Buffer.byteLength(line);
    stream.write(line, err => {
      if (err) this._log('error', `timeline: write failed: ${err.message}`);
    });
    if (this._streamBytes > MAX_LOG_BYTES) this._rotate();
  }

  _streamFor(ts) {
    if (this._stopped) return null;
    const day = dayKey(ts);
    if (this._stream && this._streamDay === day) return this._stream;
    if (this._stream) {
      const old = this._stream;
      this._stream = null;
      old.end();
    }

    const file = path.join(this.eventsDir, `${day}.jsonl`);
    try {
      fs.mkdirSync(this.eventsDir, { recursive: true });
    } catch (err) {
      this._log('error', `timeline: cannot create ${this.eventsDir}: ${err.message}`);
      return null;
    }

    let size = 0;
    try {
      size = fs.statSync(file).size;
    } catch (err) {
      if (err.code !== 'ENOENT') this._log('warn', `timeline: cannot stat ${file}: ${err.message}`);
    }

    let stream;
    try {
      stream = fs.createWriteStream(file, { flags: 'a' });
    } catch (err) {
      this._log('error', `timeline: cannot open ${file}: ${err.message}`);
      return null;
    }
    stream.on('error', err => {
      this._log('error', `timeline: stream error on ${file}: ${err.message}`);
      if (this._stream === stream) {
        this._stream = null;
        this._streamDay = null;
        this._streamFile = null;
      }
    });

    this._stream = stream;
    this._streamDay = day;
    this._streamFile = file;
    this._streamBytes = size;
    return stream;
  }

  /**
   * Moves the day's file aside once it passes the size cap. Events that arrive
   * mid rename are queued rather than written, so none of them land in the file
   * being renamed away.
   */
  _rotate() {
    const stream = this._stream;
    const file = this._streamFile;
    if (!stream || !file) return;

    this._rotating = true;
    this._stream = null;
    this._streamDay = null;
    this._streamFile = null;
    this._streamBytes = 0;

    const done = () => {
      this._rotating = false;
      const queued = this._queued;
      this._queued = [];
      const now = Date.now();
      for (const line of queued) this._write(line, now);
    };

    stream.end(() => {
      const target = this._rotatedName(file);
      if (!target) {
        this._log('warn', `timeline: no free rotation slot for ${file}`);
        done();
        return;
      }
      fs.rename(file, target, err => {
        if (err) this._log('warn', `timeline: rotation of ${file} failed: ${err.message}`);
        done();
      });
    });
  }

  _rotatedName(file) {
    const dir = path.dirname(file);
    const day = path.basename(file, '.jsonl');
    for (let i = 1; i < 1000; i++) {
      const candidate = path.join(dir, `${day}.${i}.jsonl`);
      if (!fs.existsSync(candidate)) return candidate;
    }
    return null;
  }

  _log(level, message) {
    const fn = this.logger && typeof this.logger[level] === 'function' ? this.logger[level] : null;
    if (fn) fn.call(this.logger, `[hook-bus] ${message}`);
    else if (level === 'error' || level === 'warn') console.error(`[hook-bus] ${message}`);
  }
}

module.exports = { HookBus };
