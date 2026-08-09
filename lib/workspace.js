'use strict';

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');

const defaultConfig = require('./config');
const { KIND } = require('./protocol');

const WORKSPACE_FILE = '.orchestra.json';
const SCHEMA_VERSION = 1;

const MAX_AGENTS = 12;
const MAX_NAME = 80;
const MAX_AGENT_NAME = 120;
const MAX_ARGS = 2000;
const MAX_PROMPT = 10000;
const MAX_CWD = 400;
const MAX_FILE_BYTES = 256 * 1024;

const KINDS = new Set(Object.values(KIND));
const TAG_COLORS = new Set([
  'none', 'red', 'orange', 'yellow', 'green', 'cyan', 'blue', 'purple', 'pink',
]);

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

function isPlainObject(v) {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

function badRequest(message, errors) {
  const err = new Error(message);
  err.code = 'bad_request';
  err.errors = errors || [message];
  return err;
}

function sameOrInside(baseDir, target, isWin) {
  const base = path.resolve(baseDir);
  const child = path.resolve(target);
  const a = isWin ? base.toLowerCase() : base;
  const b = isWin ? child.toLowerCase() : child;
  if (a === b) return true;
  const prefix = a.endsWith(path.sep) ? a : a + path.sep;
  return b.startsWith(prefix);
}

/**
 * Shapes a recipe path is never allowed to take, whatever it resolves to.
 * "C:foo" matters here: on Windows that is drive relative, so path.resolve
 * anchors it on the current directory of drive C, which is not the workspace.
 */
function badPathShape(value) {
  if (value.includes('\0')) return 'contains a null byte';
  if (value.startsWith('~')) return 'must not start with ~';
  if (/^[A-Za-z]:/.test(value)) return 'must not carry a drive letter';
  if (path.win32.isAbsolute(value) || path.posix.isAbsolute(value)) {
    return 'must be a relative path';
  }
  return null;
}

/**
 * Resolve a recipe path against the recipe's own directory.
 * @returns {{ok: true, path: string}|{ok: false, reason: string}}
 */
function resolveInside(baseDir, raw, isWin) {
  const value = raw === undefined || raw === null || raw === '' ? '.' : raw;
  if (typeof value !== 'string') return { ok: false, reason: 'must be a string' };
  const shape = badPathShape(value);
  if (shape) return { ok: false, reason: shape };
  const resolved = path.resolve(baseDir, value);
  if (!sameOrInside(baseDir, resolved, isWin)) {
    return { ok: false, reason: 'escapes the workspace' };
  }
  return { ok: true, path: resolved };
}

/** Relative paths are stored with forward slashes so a committed recipe is portable. */
function toPortableRelative(baseDir, target) {
  const rel = path.relative(baseDir, target);
  if (!rel) return '.';
  return rel.split(path.sep).join('/');
}

function checkString(value, field, max, errors) {
  if (value === undefined || value === null) return '';
  if (typeof value !== 'string') {
    errors.push(`${field} must be a string`);
    return null;
  }
  if (value.length > max) {
    errors.push(`${field} exceeds ${max} characters`);
    return null;
  }
  if (value.includes('\0')) {
    errors.push(`${field} contains a null byte`);
    return null;
  }
  return value;
}

/**
 * Strict validation of a recipe object.
 *
 * A recipe is a file committed in a repository that may have been cloned from
 * anywhere, so it is treated as untrusted input: kinds come from a fixed list,
 * paths must stay inside the repository, and unknown keys are dropped rather
 * than forwarded to the spawner (which is why `env` can never be injected here).
 *
 * @param {{baseDir?: string, isWin?: boolean}} [opts]
 * @returns {{ok: boolean, errors: string[], recipe: object|null}}
 */
function validate(obj, opts = {}) {
  const errors = [];
  const isWin = opts.isWin !== undefined ? opts.isWin : process.platform === 'win32';
  const baseDir = opts.baseDir ? path.resolve(opts.baseDir) : null;

  if (!isPlainObject(obj)) {
    return { ok: false, errors: ['recipe must be a JSON object'], recipe: null };
  }

  if (obj.version !== undefined && obj.version !== SCHEMA_VERSION) {
    errors.push(`unsupported version ${JSON.stringify(obj.version)}, expected ${SCHEMA_VERSION}`);
  }

  const name = checkString(obj.name, 'name', MAX_NAME, errors);

  if (!Array.isArray(obj.agents)) {
    errors.push('agents must be an array');
    return { ok: false, errors, recipe: null };
  }
  if (obj.agents.length === 0) errors.push('agents must contain at least one entry');
  if (obj.agents.length > MAX_AGENTS) errors.push(`agents contains ${obj.agents.length} entries, the maximum is ${MAX_AGENTS}`);

  const agents = [];

  obj.agents.slice(0, MAX_AGENTS).forEach((raw, i) => {
    const at = `agents[${i}]`;
    if (!isPlainObject(raw)) {
      errors.push(`${at} must be an object`);
      return;
    }

    const kind = raw.kind === undefined || raw.kind === null || raw.kind === '' ? KIND.CLAUDE : raw.kind;
    const kindOk = typeof kind === 'string' && KINDS.has(kind);
    if (!kindOk) errors.push(`${at}.kind must be one of ${[...KINDS].join(', ')}`);

    const agentName = checkString(raw.name, `${at}.name`, MAX_AGENT_NAME, errors);
    const args = checkString(raw.args, `${at}.args`, MAX_ARGS, errors);
    const prompt = checkString(raw.prompt, `${at}.prompt`, MAX_PROMPT, errors);
    const cwdRaw = checkString(raw.cwd, `${at}.cwd`, MAX_CWD, errors);

    let tagColor = 'none';
    if (raw.tagColor !== undefined && raw.tagColor !== null) {
      if (typeof raw.tagColor !== 'string' || !TAG_COLORS.has(raw.tagColor)) {
        errors.push(`${at}.tagColor must be one of ${[...TAG_COLORS].join(', ')}`);
      } else {
        tagColor = raw.tagColor;
      }
    }

    let cwd = cwdRaw === null ? null : (cwdRaw || '.');
    if (cwd !== null && baseDir) {
      const resolved = resolveInside(baseDir, cwd, isWin);
      if (!resolved.ok) {
        errors.push(`${at}.cwd ${resolved.reason}: ${JSON.stringify(cwdRaw)}`);
        cwd = null;
      } else {
        cwd = toPortableRelative(baseDir, resolved.path);
      }
    } else if (cwd !== null && cwd !== '.') {
      // Without a baseDir the containment check cannot run, so refuse every
      // shape that could climb out once a base is known.
      const shape = badPathShape(cwd);
      if (shape || cwd.split(/[\\/]/).includes('..')) {
        errors.push(`${at}.cwd ${shape || 'escapes the workspace'}: ${JSON.stringify(cwdRaw)}`);
        cwd = null;
      }
    }

    agents.push({
      name: agentName || '',
      kind: kindOk ? kind : KIND.CLAUDE,
      cwd: cwd === null ? '.' : cwd,
      args: args || '',
      prompt: prompt || '',
      tagColor,
    });
  });

  if (errors.length) return { ok: false, errors, recipe: null };

  return {
    ok: true,
    errors: [],
    recipe: {
      version: SCHEMA_VERSION,
      name: name || '',
      agents,
    },
  };
}

/**
 * Turn a validated recipe into specs for SessionManager.create.
 * Throws a `bad_request` error carrying `.errors` when the recipe is invalid.
 *
 * @param {string} baseDir directory the recipe lives in
 * @returns {Array<{kind:string,name:string,cwd:string,args:string,prompt:string,tagColor:string}>}
 */
function toSpecs(recipe, baseDir, opts = {}) {
  const isWin = opts.isWin !== undefined ? opts.isWin : process.platform === 'win32';
  if (!baseDir || typeof baseDir !== 'string') {
    throw badRequest('toSpecs requires a baseDir');
  }
  const base = path.resolve(baseDir);
  const res = validate(recipe, { baseDir: base, isWin });
  if (!res.ok) {
    throw badRequest(`Invalid ${WORKSPACE_FILE}: ${res.errors.join('; ')}`, res.errors);
  }

  return res.recipe.agents.map((a, i) => ({
    kind: a.kind,
    name: a.name || `${res.recipe.name || 'Agent'} ${i + 1}`,
    cwd: path.resolve(base, a.cwd),
    args: a.args,
    prompt: a.prompt || null,
    tagColor: a.tagColor,
    // This file may have been cloned from anywhere. The session manager uses
    // this to refuse arguments that would switch off the permission model:
    // that is a choice only the person at the keyboard gets to make.
    trust: 'untrusted',
  }));
}

/** Reads, validates and writes `.orchestra.json`, the versioned recipe file. */
class Workspace {
  constructor({ config = defaultConfig, logger = null } = {}) {
    this.config = config;
    this.log = makeLogger(logger);
    this.isWin = config.IS_WIN !== undefined ? config.IS_WIN : process.platform === 'win32';
  }

  _baseDir(cwd) {
    if (!cwd || typeof cwd !== 'string') return path.resolve(this.config.HOME);
    let dir = cwd;
    if (dir.startsWith('~')) dir = path.join(this.config.HOME, dir.slice(1));
    dir = path.resolve(dir);
    if (path.basename(dir) === WORKSPACE_FILE) dir = path.dirname(dir);
    return dir;
  }

  /**
   * @returns {Promise<{version:number,name:string,agents:object[],path:string,baseDir:string}|null>}
   */
  async read(cwd) {
    const baseDir = this._baseDir(cwd);
    const file = path.join(baseDir, WORKSPACE_FILE);

    let raw;
    try {
      const st = await fsp.stat(file);
      if (!st.isFile()) {
        this.log.warn(`workspace: ${file} is not a regular file`);
        return null;
      }
      if (st.size > MAX_FILE_BYTES) {
        this.log.warn(`workspace: ${file} is ${st.size} bytes, refusing to parse it`);
        return null;
      }
      raw = await fsp.readFile(file, 'utf8');
    } catch (e) {
      if (e.code === 'ENOENT') return null;
      this.log.warn(`workspace: cannot read ${file}: ${e.message}`);
      return null;
    }

    let parsed;
    try {
      parsed = JSON.parse(raw.replace(/^\uFEFF/, ''));
    } catch (e) {
      this.log.warn(`workspace: ${file} is not valid JSON: ${e.message}`);
      return null;
    }

    const res = validate(parsed, { baseDir, isWin: this.isWin });
    if (!res.ok) {
      this.log.warn(`workspace: ${file} is invalid: ${res.errors.join('; ')}`);
      return null;
    }

    const escaped = await this._symlinkEscape(res.recipe, baseDir);
    if (escaped) {
      this.log.warn(`workspace: ${file} points outside the workspace through a link: ${escaped}`);
      return null;
    }

    return { ...res.recipe, path: file, baseDir };
  }

  /**
   * Containment in validate() is lexical, which a symlink can defeat. Any agent
   * directory that already exists is therefore re-checked through realpath.
   * @returns {Promise<string|null>} the offending path, if any
   */
  async _symlinkEscape(recipe, baseDir) {
    let realBase;
    try {
      realBase = await fsp.realpath(baseDir);
    } catch (e) {
      if (e.code !== 'ENOENT') this.log.debug(`workspace: realpath ${baseDir}: ${e.code || e.message}`);
      return null;
    }

    for (const agent of recipe.agents) {
      const target = path.resolve(baseDir, agent.cwd);
      let real;
      try {
        real = await fsp.realpath(target);
      } catch (e) {
        if (e.code === 'ENOENT') continue;
        this.log.debug(`workspace: realpath ${target}: ${e.code || e.message}`);
        continue;
      }
      if (!sameOrInside(realBase, real, this.isWin)) return target;
    }
    return null;
  }

  validate(obj, baseDir) {
    return validate(obj, { baseDir: baseDir ? this._baseDir(baseDir) : null, isWin: this.isWin });
  }

  toSpecs(recipe, baseDir) {
    return toSpecs(recipe, this._baseDir(baseDir), { isWin: this.isWin });
  }

  /**
   * Atomic write with a backup: the previous file is copied to
   * `.orchestra.json.bak` and the new one lands through a rename, so an
   * interrupted write can never leave a truncated recipe on disk.
   *
   * @returns {Promise<{path:string, backup:string|null}>}
   */
  async write(cwd, recipe) {
    const baseDir = this._baseDir(cwd);
    const res = validate(recipe, { baseDir, isWin: this.isWin });
    if (!res.ok) {
      throw badRequest(`Invalid ${WORKSPACE_FILE}: ${res.errors.join('; ')}`, res.errors);
    }

    const file = path.join(baseDir, WORKSPACE_FILE);
    const backupFile = `${file}.bak`;
    const tmp = path.join(baseDir, `${WORKSPACE_FILE}.${crypto.randomBytes(6).toString('hex')}.tmp`);
    const body = `${JSON.stringify(res.recipe, null, 2)}\n`;
    const removeTmp = async () => {
      try {
        await fsp.unlink(tmp);
      } catch (e) {
        if (e.code !== 'ENOENT') this.log.debug(`workspace: removing ${tmp}: ${e.message}`);
      }
    };

    let backup = null;
    try {
      await fsp.copyFile(file, backupFile);
      backup = backupFile;
    } catch (e) {
      if (e.code !== 'ENOENT') {
        this.log.warn(`workspace: could not back up ${file}: ${e.message}`);
      }
    }

    let handle;
    try {
      handle = await fsp.open(tmp, 'w');
      await handle.writeFile(body, 'utf8');
      await handle.sync();
    } catch (e) {
      if (handle) {
        try {
          await handle.close();
        } catch (closeErr) {
          this.log.debug(`workspace: closing ${tmp}: ${closeErr.message}`);
        }
        handle = null;
      }
      await removeTmp();
      throw new Error(`Could not write ${file}: ${e.message}`);
    }

    try {
      await handle.close();
    } catch (e) {
      this.log.debug(`workspace: closing ${tmp}: ${e.message}`);
    }

    try {
      await fsp.rename(tmp, file);
    } catch (e) {
      await removeTmp();
      throw new Error(`Could not replace ${file}: ${e.message}`);
    }

    return { path: file, backup };
  }

  /**
   * Build a recipe out of live sessions, for a "Save as recipe" button.
   * Sessions running outside `baseDir` are dropped: a recipe that pointed
   * outside its own repository would fail validation on the next read.
   *
   * @param {Array<object>} sessions wire or internal session objects
   * @returns {Promise<{version:number,name:string,agents:object[]}>}
   */
  async fromSessions(sessions, baseDir) {
    const base = this._baseDir(baseDir);
    const list = Array.isArray(sessions) ? sessions : [];
    const agents = [];
    let dropped = 0;

    for (const s of list) {
      if (!s || typeof s !== 'object') continue;
      if (s.status === 'exited') continue;
      if (agents.length >= MAX_AGENTS) {
        dropped++;
        continue;
      }

      const cwd = typeof s.cwd === 'string' && s.cwd ? path.resolve(s.cwd) : base;
      if (!sameOrInside(base, cwd, this.isWin)) {
        dropped++;
        this.log.info(`workspace: session "${s.name || s.id}" runs outside ${base}, not saved in the recipe`);
        continue;
      }

      const kind = typeof s.kind === 'string' && KINDS.has(s.kind) ? s.kind : KIND.CLAUDE;
      const tagColor = typeof s.tagColor === 'string' && TAG_COLORS.has(s.tagColor) ? s.tagColor : 'none';
      const prompt = typeof s.prompt === 'string' ? s.prompt.slice(0, MAX_PROMPT) : '';

      agents.push({
        name: typeof s.name === 'string' ? s.name.slice(0, MAX_AGENT_NAME) : '',
        kind,
        cwd: toPortableRelative(base, cwd),
        args: typeof s.args === 'string' ? s.args.slice(0, MAX_ARGS) : '',
        prompt,
        tagColor,
      });
    }

    if (dropped) {
      this.log.info(`workspace: ${dropped} session(s) left out of the recipe for ${base}`);
    }

    const existing = await this.read(base);
    return {
      version: SCHEMA_VERSION,
      name: (existing && existing.name) || path.basename(base) || 'workspace',
      agents,
    };
  }
}

module.exports = {
  Workspace,
  WORKSPACE_FILE,
  SCHEMA_VERSION,
  MAX_AGENTS,
  TAG_COLORS,
  validate,
  toSpecs,
};
