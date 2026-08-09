'use strict';

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { execFile } = require('child_process');

const defaultConfig = require('./config');

/** Only the tail of history.jsonl is parsed; older lines cannot win the sort anyway. */
const HISTORY_TAIL_BYTES = 4 * 1024 * 1024;
const BRANCH_TTL_MS = 30000;
const GIT_TIMEOUT_MS = 2500;
const SCAN_TIMEOUT_MS = 5000;
const SCAN_MAX_DIRS = 4000;
const DECODE_MAX_LISTINGS = 600;
const MAX_ENTRIES_PER_DIR = 2000;

const SCAN_SKIP = new Set(['node_modules', '.git']);

/**
 * Accepts anything console-shaped. Without a logger, warnings and errors still
 * reach the console: this module must never fail silently, but it must not spam
 * debug lines into a plain `node -e` either.
 */
function makeLogger(logger) {
  const noop = () => {};
  const bind = (obj, name, alt) => {
    if (obj && typeof obj[name] === 'function') return obj[name].bind(obj);
    if (obj && alt && typeof obj[alt] === 'function') return obj[alt].bind(obj);
    return null;
  };
  return {
    debug: bind(logger, 'debug', 'log') || noop,
    info: bind(logger, 'info', 'log') || noop,
    warn: bind(logger, 'warn', 'error') || bind(console, 'warn') || noop,
    error: bind(logger, 'error', 'warn') || bind(console, 'error') || noop,
  };
}

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  const workers = new Array(Math.min(limit, items.length || 1)).fill(null).map(async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return out;
}

/**
 * Every spelling of a directory name that could have produced a slug token.
 * Claude Code encodes a project path by turning each non-alphanumeric character
 * into a dash; underscores may or may not survive, so both are tried.
 */
function slugCandidates(name) {
  const out = new Set([
    name.replace(/[^A-Za-z0-9]/g, '-'),
    name.replace(/[^A-Za-z0-9_]/g, '-'),
    name,
  ]);
  out.delete('');
  return out;
}

function normalizeKey(p, isWin) {
  let out = path.normalize(p);
  if (out.length > 1 && (out.endsWith(path.sep) || out.endsWith('/'))) {
    const trimmed = out.slice(0, -1);
    // Keep "C:\" and "/" intact, they are real roots.
    if (!/^[A-Za-z]:$/.test(trimmed) && trimmed !== '') out = trimmed;
  }
  return isWin ? out.toLowerCase() : out;
}

function displayName(p) {
  const base = path.basename(p);
  return base || p;
}

const EXPECTED_STAT_ERRORS = new Set(['ENOENT', 'ENOTDIR', 'EACCES', 'EPERM', 'ELOOP', 'ENAMETOOLONG', 'EINVAL', 'EBUSY']);

async function isDirectory(p, log) {
  try {
    const st = await fsp.stat(p);
    return st.isDirectory();
  } catch (e) {
    if (!EXPECTED_STAT_ERRORS.has(e.code) && log) {
      log.warn(`projects: unexpected error on ${p}: ${e.code || e.message}`);
    }
    return false;
  }
}

/**
 * Index of the projects the user has actually worked in.
 *
 * Primary source is ~/.claude/history.jsonl, which carries the absolute path
 * verbatim. The directory names under ~/.claude/projects are only a fallback:
 * they are lossy slugs, so they get resolved against the real filesystem and
 * are reported with `exists:false` when they cannot be resolved.
 */
class ProjectIndex {
  constructor({ config = defaultConfig, logger = null } = {}) {
    this.config = config;
    this.log = makeLogger(logger);
    this.isWin = config.IS_WIN !== undefined ? config.IS_WIN : process.platform === 'win32';

    /** @type {Map<string, {value: string|null, at: number}>} */
    this._branchCache = new Map();
    /** @type {{mtimeMs: number, size: number, entries: Map<string, {path: string, lastUsedAt: number, sessions: Set<string>}>}|null} */
    this._historyCache = null;
    this._gitMissing = false;
    this._lastScanTruncated = false;
  }

  /** True when the last scan() stopped on its own budget rather than on exhaustion. */
  get lastScanTruncated() {
    return this._lastScanTruncated;
  }

  clearCache() {
    this._branchCache.clear();
    this._historyCache = null;
  }

  /**
   * @returns {Promise<Array<{path:string,name:string,lastUsedAt:number|null,isGit:boolean,branch:string|null,sessionCount:number,exists:boolean}>>}
   */
  async recent(limit = 30) {
    const max = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : 30;

    /** @type {Map<string, {path:string,lastUsedAt:number|null,sessions:Set<string>,exists:boolean|null}>} */
    const merged = new Map();

    const add = (rawPath, lastUsedAt, sessionIds, exists) => {
      if (!rawPath || typeof rawPath !== 'string') return;
      const key = normalizeKey(rawPath, this.isWin);
      let entry = merged.get(key);
      if (!entry) {
        entry = { path: path.normalize(rawPath), lastUsedAt: null, sessions: new Set(), exists };
        merged.set(key, entry);
      }
      if (typeof lastUsedAt === 'number' && Number.isFinite(lastUsedAt)) {
        if (entry.lastUsedAt === null || lastUsedAt > entry.lastUsedAt) entry.lastUsedAt = lastUsedAt;
      }
      for (const id of sessionIds || []) entry.sessions.add(id);
      if (exists === true) entry.exists = true;
      else if (exists === false && entry.exists === null) entry.exists = false;
    };

    const history = await this._readHistory();
    for (const h of history.values()) add(h.path, h.lastUsedAt, h.sessions, null);

    const fromDirs = await this._readProjectsDir();
    for (const d of fromDirs) add(d.path, d.lastUsedAt, d.sessions, d.exists);

    const sorted = [...merged.values()].sort((a, b) => {
      const av = a.lastUsedAt === null ? -1 : a.lastUsedAt;
      const bv = b.lastUsedAt === null ? -1 : b.lastUsedAt;
      if (bv !== av) return bv - av;
      return a.path.localeCompare(b.path);
    });

    const top = sorted.slice(0, max);

    return mapLimit(top, 8, async entry => {
      const exists = entry.exists === false ? false : await isDirectory(entry.path, this.log);
      const isGit = exists ? await this._hasGitDir(entry.path) : false;
      const branch = isGit ? await this.branch(entry.path) : null;
      return {
        path: entry.path,
        name: displayName(entry.path),
        lastUsedAt: entry.lastUsedAt,
        isGit,
        branch,
        sessionCount: entry.sessions.size,
        exists,
      };
    });
  }

  /**
   * Current branch of a git working tree, or null. Cached for 30 s per path so
   * a UI that polls the launcher does not fork git on every tick.
   * @returns {Promise<string|null>}
   */
  async branch(dir) {
    if (!dir || typeof dir !== 'string') return null;
    const key = normalizeKey(dir, this.isWin);
    const hit = this._branchCache.get(key);
    const now = Date.now();
    if (hit && now - hit.at < BRANCH_TTL_MS) return hit.value;

    let value = null;
    if (!this._gitMissing) {
      const res = await this._git(dir, ['rev-parse', '--abbrev-ref', 'HEAD']);
      if (res.ok) {
        value = res.out || null;
        if (value === 'HEAD') {
          const sha = await this._git(dir, ['rev-parse', '--short', 'HEAD']);
          value = sha.ok && sha.out ? `detached@${sha.out}` : 'detached';
        }
      } else if (!res.missing) {
        // An empty repo with no commit yet answers on stderr; that is expected.
        this.log.debug(`projects: git branch failed in ${dir}: ${res.reason}`);
      }
    }

    this._branchCache.set(key, { value, at: now });
    return value;
  }

  /**
   * Find git repositories under `root`.
   * @param {number} [depth] how many levels below `root` to walk (0 = root only)
   * @returns {Promise<Array<{path:string,name:string,lastUsedAt:number|null,isGit:boolean,branch:string|null,sessionCount:number,exists:boolean}>>}
   */
  async scan(root, depth = 2) {
    this._lastScanTruncated = false;
    if (!root || typeof root !== 'string') return [];

    let base = root;
    if (base.startsWith('~')) base = path.join(this.config.HOME, base.slice(1));
    base = path.resolve(base);

    if (!(await isDirectory(base, this.log))) {
      this.log.warn(`projects: scan root is not a directory: ${base}`);
      return [];
    }

    const maxDepth = Number.isFinite(depth) && depth >= 0 ? Math.floor(depth) : 2;
    const deadline = Date.now() + SCAN_TIMEOUT_MS;
    const found = [];
    const seen = new Set();
    let visited = 0;

    const walk = async (dir, level) => {
      if (Date.now() > deadline || visited >= SCAN_MAX_DIRS) {
        this._lastScanTruncated = true;
        return;
      }
      visited++;

      if (await this._hasGitDir(dir)) {
        const key = normalizeKey(dir, this.isWin);
        if (!seen.has(key)) {
          seen.add(key);
          found.push(dir);
        }
        // A repository is a leaf for this purpose: walking into it would drown
        // the result in vendored checkouts and worktrees.
        return;
      }

      if (level >= maxDepth) return;

      let handle;
      try {
        handle = await fsp.opendir(dir);
      } catch (e) {
        this.log.debug(`projects: cannot open ${dir}: ${e.code || e.message}`);
        return;
      }

      const children = [];
      try {
        let count = 0;
        for await (const entry of handle) {
          if (count++ >= MAX_ENTRIES_PER_DIR) {
            this._lastScanTruncated = true;
            break;
          }
          if (!entry.isDirectory()) continue;
          const name = entry.name;
          if (name.startsWith('.')) continue;
          if (SCAN_SKIP.has(name)) continue;
          children.push(path.join(dir, name));
        }
      } catch (e) {
        this.log.warn(`projects: scan of ${dir} stopped: ${e.message}`);
        // opendir's iterator closes itself when it throws or completes.
        return;
      }

      for (const child of children) {
        if (Date.now() > deadline) {
          this._lastScanTruncated = true;
          return;
        }
        await walk(child, level + 1);
      }
    };

    await walk(base, 0);

    if (this._lastScanTruncated) {
      this.log.warn(`projects: scan of ${base} hit its budget (${SCAN_TIMEOUT_MS} ms / ${SCAN_MAX_DIRS} dirs), results are partial`);
    }

    const history = await this._readHistory();

    return mapLimit(found, 8, async dir => {
      const h = history.get(normalizeKey(dir, this.isWin));
      return {
        path: dir,
        name: displayName(dir),
        lastUsedAt: h ? h.lastUsedAt : null,
        isGit: true,
        branch: await this.branch(dir),
        sessionCount: h ? h.sessions.size : 0,
        exists: true,
      };
    });
  }

  async _hasGitDir(dir) {
    try {
      // A worktree or submodule has a .git file, not a directory.
      await fsp.stat(path.join(dir, '.git'));
      return true;
    } catch (e) {
      if (e.code !== 'ENOENT' && e.code !== 'ENOTDIR' && e.code !== 'EACCES' && e.code !== 'EPERM') {
        this.log.debug(`projects: stat .git in ${dir}: ${e.code || e.message}`);
      }
      return false;
    }
  }

  _git(cwd, args) {
    return new Promise(resolve => {
      execFile('git', args, {
        cwd,
        timeout: GIT_TIMEOUT_MS,
        windowsHide: true,
        maxBuffer: 1024 * 1024,
      }, (err, stdout, stderr) => {
        if (!err) {
          resolve({ ok: true, out: String(stdout || '').trim() });
          return;
        }
        if (err.code === 'ENOENT') {
          if (!this._gitMissing) {
            this._gitMissing = true;
            this.log.warn('projects: "git" was not found in PATH, branch information is disabled');
          }
          resolve({ ok: false, missing: true, reason: 'git not found' });
          return;
        }
        const reason = String(stderr || '').trim() || err.message;
        resolve({ ok: false, missing: false, reason });
      });
    });
  }

  /**
   * @returns {Promise<Map<string, {path:string,lastUsedAt:number,sessions:Set<string>}>>}
   */
  async _readHistory() {
    const file = this.config.historyFile;
    let st;
    try {
      st = await fsp.stat(file);
    } catch (e) {
      if (e.code !== 'ENOENT') this.log.warn(`projects: cannot stat ${file}: ${e.message}`);
      return new Map();
    }

    const cache = this._historyCache;
    if (cache && cache.size === st.size && cache.mtimeMs === st.mtimeMs) return cache.entries;

    let text;
    let partialFirstLine = false;
    let fh;
    try {
      fh = await fsp.open(file, 'r');
      const length = Math.min(st.size, HISTORY_TAIL_BYTES);
      const position = st.size - length;
      partialFirstLine = position > 0;
      const buf = Buffer.allocUnsafe(length);
      const { bytesRead } = await fh.read(buf, 0, length, position);
      text = buf.subarray(0, bytesRead).toString('utf8');
    } catch (e) {
      this.log.warn(`projects: cannot read ${file}: ${e.message}`);
      return new Map();
    } finally {
      if (fh) {
        try {
          await fh.close();
        } catch (e) {
          this.log.debug(`projects: closing ${file}: ${e.message}`);
        }
      }
    }

    const entries = new Map();
    const lines = text.split('\n');
    if (partialFirstLine) lines.shift();
    let malformed = 0;

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let obj;
      try {
        obj = JSON.parse(trimmed);
      } catch {
        malformed++;
        continue;
      }
      if (!obj || typeof obj !== 'object') { malformed++; continue; }
      const project = typeof obj.project === 'string' ? obj.project : (typeof obj.cwd === 'string' ? obj.cwd : null);
      if (!project) continue;
      const ts = Number.isFinite(obj.timestamp) ? obj.timestamp : 0;
      const key = normalizeKey(project, this.isWin);
      let entry = entries.get(key);
      if (!entry) {
        entry = { path: path.normalize(project), lastUsedAt: ts, sessions: new Set() };
        entries.set(key, entry);
      } else if (ts > entry.lastUsedAt) {
        entry.lastUsedAt = ts;
      }
      if (typeof obj.sessionId === 'string' && obj.sessionId) entry.sessions.add(obj.sessionId);
    }

    if (malformed) {
      this.log.debug(`projects: skipped ${malformed} malformed line(s) in ${file}`);
    }

    this._historyCache = { size: st.size, mtimeMs: st.mtimeMs, entries };
    return entries;
  }

  /**
   * Secondary source: ~/.claude/projects holds one directory per project, named
   * with a lossy slug of the absolute path. The slug is decoded by walking the
   * real filesystem, because "claude-orchestra" and "claude/orchestra" encode
   * identically and only the disk can tell them apart.
   */
  async _readProjectsDir() {
    const dir = this.config.projectsDir;
    let names;
    try {
      names = await fsp.readdir(dir, { withFileTypes: true });
    } catch (e) {
      if (e.code !== 'ENOENT') this.log.warn(`projects: cannot read ${dir}: ${e.message}`);
      return [];
    }

    const listings = new Map();
    const budget = { left: DECODE_MAX_LISTINGS };
    const out = [];

    for (const dirent of names) {
      if (!dirent.isDirectory()) continue;
      const slug = dirent.name;
      const decoded = await this._decodeSlug(slug, listings, budget);
      if (!decoded) continue;
      const meta = await this._projectDirMeta(path.join(dir, slug));
      out.push({
        path: decoded.path,
        lastUsedAt: meta.lastUsedAt,
        sessions: meta.sessions,
        exists: decoded.exists,
      });
    }

    return out;
  }

  /** Sessions recorded on disk for one ~/.claude/projects entry. */
  async _projectDirMeta(dir) {
    const sessions = new Set();
    let lastUsedAt = null;
    let entries;
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch (e) {
      this.log.debug(`projects: cannot read ${dir}: ${e.code || e.message}`);
      return { sessions, lastUsedAt };
    }

    const files = entries
      .filter(e => e.isFile() && e.name.endsWith('.jsonl'))
      .slice(0, 200);

    for (const f of files) {
      sessions.add(f.name.slice(0, -'.jsonl'.length));
      try {
        const st = await fsp.stat(path.join(dir, f.name));
        const mtime = Math.round(st.mtimeMs);
        if (lastUsedAt === null || mtime > lastUsedAt) lastUsedAt = mtime;
      } catch (e) {
        this.log.debug(`projects: cannot stat ${f.name}: ${e.code || e.message}`);
      }
    }

    return { sessions, lastUsedAt };
  }

  /**
   * @param {Map<string, string[]>} listings shared directory listing cache
   * @param {{left:number}} budget
   * @returns {Promise<{path:string, exists:boolean}|null>}
   */
  async _decodeSlug(slug, listings, budget) {
    let root = null;
    let rest = null;

    if (slug.startsWith('-')) {
      root = path.sep === '\\' ? '\\' : '/';
      rest = slug.slice(1);
    } else {
      const m = /^([A-Za-z])--(.*)$/.exec(slug);
      if (m) {
        root = `${m[1]}:\\`;
        rest = m[2];
      }
    }

    if (root === null) {
      this.log.debug(`projects: unrecognised project slug "${slug}"`);
      return null;
    }

    const tokens = rest.length ? rest.split('-') : [];
    if (!tokens.length) return { path: root, exists: await isDirectory(root, this.log) };

    const resolved = await this._matchTokens(root, tokens, 0, listings, budget);
    if (resolved) return { path: resolved, exists: true };

    // Best effort so the launcher can still show something honest, flagged as
    // not resolvable on this machine.
    return { path: path.join(root, tokens.join(path.sep)), exists: false };
  }

  async _matchTokens(dir, tokens, index, listings, budget) {
    if (index >= tokens.length) return dir;
    if (budget.left <= 0) return null;

    const children = await this._listChildDirs(dir, listings, budget);
    const remaining = tokens.slice(index).join('-');

    // Exact matches win over prefixes, across every child rather than within
    // one. "src/my-app" and "src/my/app" encode to the same slug, so no decoder
    // can be right for both; without this pass the first child that merely
    // prefixes the remainder ("my") would consume it and "my-app" never be tried.
    for (const name of children) {
      if (slugCandidates(name).has(remaining)) return path.join(dir, name);
    }

    const prefixes = [];
    for (const name of children) {
      for (const cand of slugCandidates(name)) {
        if (remaining.startsWith(`${cand}-`)) prefixes.push({ name, cand });
      }
    }
    // Longest first, so a deeper child is preferred over a shorter sibling that
    // happens to spell its opening tokens.
    prefixes.sort((a, b) => b.cand.length - a.cand.length);

    for (const { name, cand } of prefixes) {
      const consumed = cand.split('-').length;
      const hit = await this._matchTokens(path.join(dir, name), tokens, index + consumed, listings, budget);
      if (hit) return hit;
    }

    return null;
  }

  /** Subdirectory names of `dir`, memoized in `listings` and charged to `budget`. */
  async _listChildDirs(dir, listings, budget) {
    const key = normalizeKey(dir, this.isWin);
    const cached = listings.get(key);
    if (cached) return cached;

    budget.left--;
    let children = [];
    try {
      const entries = await fsp.readdir(dir, { withFileTypes: true });
      children = entries.filter(e => e.isDirectory()).map(e => e.name);
    } catch (e) {
      this.log.debug(`projects: cannot list ${dir}: ${e.code || e.message}`);
    }
    listings.set(key, children);
    return children;
  }
}

module.exports = { ProjectIndex };
