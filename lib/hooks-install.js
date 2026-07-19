'use strict';

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');

const config = require('./config');
const { HOOK_EVENT } = require('./protocol');
const { which } = require('./which');

/**
 * Safe installation of Orchestra's hooks into ~/.claude/settings.json.
 *
 * That file is the user's whole global configuration, so: nothing is written
 * unless the current content was understood, every write is preceded by a
 * timestamped backup, and the merge only touches `hooks.<Event>` entries whose
 * command carries one of our markers, plus `statusLine` when it is ours.
 */

const HOOK_SCRIPT = 'orchestra-hook.js';
const APPROVE_SCRIPT = 'orchestra-approve.js';

/**
 * Tools the approval gate actually watches, as a matcher pattern.
 *
 * Read-only tools are deliberately absent. Escalating them produces one
 * blocking prompt per file an agent looks at: useless to decide on, and enough
 * to saturate the pending queue before a handful of agents are running. What
 * deserves a human is an action that changes something or reaches outward.
 */
const MUTATING_TOOLS = 'Bash|Write|Edit|MultiEdit|NotebookEdit|WebFetch|KillShell';
const STATUS_SCRIPT = 'quota-hook.js';

const STATUSLINE_MARKERS = ['quota-hook', 'orchestra-hook', 'orchestra-status'];

const BACKUP_PREFIX = 'settings.json.orchestra-backup-';
const BACKUPS_KEPT = 5;
const TMP_PREFIX = 'settings.json.orchestra-tmp-';

/** The generic hook only posts a line of JSON, so it must never linger. */
const GENERIC_TIMEOUT_S = 10;

const ALL_EVENTS = Object.values(HOOK_EVENT);
const DEFAULT_EVENTS = ALL_EVENTS.slice();

/** Events whose config entries are keyed by a tool-name matcher. */
const TOOL_EVENTS = new Set([HOOK_EVENT.PRE_TOOL_USE, HOOK_EVENT.POST_TOOL_USE]);

const RENAME_RETRIES = 5;
const RENAME_RETRY_MS = 60;

function isPlainObject(v) {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

function toPosix(p) {
  return String(p).replace(/\\/g, '/');
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function hookScriptPath(name) {
  return path.join(config.hooksDir, name);
}

/**
 * Version managers hand the running process a per-shell shim whose directory
 * is deleted when that shell exits, so baking process.execPath into a config
 * file that outlives the shell yields a hook that stops resolving tomorrow.
 */
const EPHEMERAL_NODE_MARKERS = ['fnm_multishells', 'nvm_multishells'];

let cachedNode = null;

function looksEphemeral(p) {
  const s = toPosix(p).toLowerCase();
  return EPHEMERAL_NODE_MARKERS.some(m => s.includes(m));
}

/**
 * The node binary written into hook commands.
 *
 * @returns {{path:string, source:string, ephemeral:boolean, error:string|null}}
 */
function nodeInfo() {
  if (cachedNode) return cachedNode;
  let real = null;
  let error = null;
  try {
    // The shim directory is a symlink, so realpath lands on the installation.
    real = fs.realpathSync.native(process.execPath);
  } catch (e) {
    error = e.message;
  }

  const tries = [
    real && { path: real, source: 'realpath' },
    { path: process.execPath, source: 'execPath' },
  ].filter(Boolean);

  for (const t of tries) {
    if (!looksEphemeral(t.path)) {
      cachedNode = { ...t, ephemeral: false, error };
      return cachedNode;
    }
  }

  const onPath = which('node');
  if (onPath && !looksEphemeral(onPath)) {
    cachedNode = { path: onPath, source: 'path', ephemeral: false, error };
    return cachedNode;
  }

  cachedNode = { ...tries[0], ephemeral: true, error };
  return cachedNode;
}

/**
 * Hook commands run through the platform shell with whatever PATH Claude Code
 * happened to inherit, which on Windows is frequently not the one that has
 * node on it. Naming the interpreter by absolute path removes that whole class
 * of "works in my terminal" failure.
 */
function commandFor(scriptPath, args = []) {
  return [
    `"${toPosix(nodeInfo().path)}"`,
    `"${toPosix(scriptPath)}"`,
    ...args.map(String),
  ].join(' ');
}

function hookCommand(event) {
  return commandFor(hookScriptPath(HOOK_SCRIPT), [event]);
}

function approveCommand() {
  return commandFor(hookScriptPath(APPROVE_SCRIPT), [HOOK_EVENT.PRE_TOOL_USE]);
}

function statusLineCommand() {
  return commandFor(hookScriptPath(STATUS_SCRIPT));
}

/** The blocking hook must outlive the human it is waiting on. */
function approvalTimeoutSeconds() {
  const s = Math.ceil((config.approvalTimeoutMs || 0) / 1000);
  return Math.max(30, s + 10);
}

function commandOf(entry) {
  if (typeof entry === 'string') return entry;
  if (isPlainObject(entry) && typeof entry.command === 'string') return entry.command;
  return '';
}

function isGenericHookCommand(cmd) {
  return String(cmd).includes('orchestra-hook');
}

function isApproveHookCommand(cmd) {
  return String(cmd).includes('orchestra-approve');
}

/** Only entries naming one of our own scripts are ours to add or remove. */
function isOurHookCommand(cmd) {
  return isGenericHookCommand(cmd) || isApproveHookCommand(cmd);
}

/**
 * Only a command naming one of our own scripts is ours to replace or remove.
 *
 * Several markers, because an older install put the script at the repo root and
 * a checkout can live at another path (npx cache, a second clone). Claiming any
 * command that merely mentions the repo root instead would swallow a
 * contributor's own status line script kept inside the checkout.
 */
function isOurStatusLineCommand(cmd) {
  const c = String(cmd);
  if (!c) return false;
  return STATUSLINE_MARKERS.some(m => c.includes(m));
}

/**
 * Walks one `hooks.<Event>` array, tolerating both shapes Claude Code has
 * shipped: matcher groups (`[{matcher, hooks:[{type,command}]}]`) and the
 * flat list of command entries (`[{type,command}]`).
 */
function eachEntry(list, visit) {
  if (!Array.isArray(list)) return;
  for (const node of list) {
    if (!isPlainObject(node)) continue;
    if (Array.isArray(node.hooks)) {
      for (const entry of node.hooks) {
        if (!isPlainObject(entry) && typeof entry !== 'string') continue;
        visit({ entry, matcher: node.matcher });
      }
    } else if (typeof node.command === 'string') {
      visit({ entry: node, matcher: node.matcher });
    }
  }
}

/**
 * The shape to write in, judged only on the entries the user wrote.
 *
 * Our own entries are skipped on purpose. The approval gate needs a matcher and
 * so is always a group; letting that group decide the shape would report
 * 'grouped' for a hand-written flat file, move the generic hook into a group on
 * the next install, and report a change on every reinstall forever.
 *
 * @returns {'grouped'|'flat'|null} null when no foreign entry settles it, which
 *   leaves the choice to detectShape and ultimately to 'grouped'.
 */
function userShape(list) {
  if (!Array.isArray(list)) return null;
  let flat = null;
  for (const node of list) {
    if (!isPlainObject(node)) continue;
    if (Array.isArray(node.hooks)) {
      if (node.hooks.some(entry => !isOurHookCommand(commandOf(entry)))) return 'grouped';
    } else if (typeof node.command === 'string' && !isOurHookCommand(node.command)) {
      flat = 'flat';
    }
  }
  return flat;
}

/** 'grouped' when entries are wrapped in matcher objects, 'flat' otherwise. */
function detectShape(list) {
  if (!Array.isArray(list) || list.length === 0) return null;
  for (const node of list) {
    if (isPlainObject(node) && Array.isArray(node.hooks)) return 'grouped';
  }
  for (const node of list) {
    if (isPlainObject(node) && typeof node.command === 'string') return 'flat';
  }
  return null;
}

/** True when any existing entry uses `async`, which proves the CLI accepts it. */
function detectAsyncSupport(settings) {
  const hooks = settings && settings.hooks;
  if (!isPlainObject(hooks)) return false;
  let seen = false;
  for (const list of Object.values(hooks)) {
    eachEntry(list, ({ entry }) => {
      if (isPlainObject(entry) && typeof entry.async === 'boolean') seen = true;
    });
  }
  return seen;
}

function normalizeMatcher(m) {
  if (m === undefined || m === null) return '';
  return String(m);
}

/**
 * Removes every entry the predicate claims, pruning matcher groups that are
 * left empty. Returns the removed commands so callers can report them.
 */
function removeEntries(list, predicate) {
  const removed = [];
  if (!Array.isArray(list)) return { list, removed };
  const next = [];
  for (const node of list) {
    if (!isPlainObject(node)) { next.push(node); continue; }
    if (Array.isArray(node.hooks)) {
      const kept = [];
      for (const entry of node.hooks) {
        const cmd = commandOf(entry);
        if (cmd && predicate(cmd)) removed.push(cmd);
        else kept.push(entry);
      }
      if (kept.length === 0 && node.hooks.length > 0) continue;
      node.hooks = kept;
      next.push(node);
      continue;
    }
    const cmd = commandOf(node);
    if (cmd && predicate(cmd)) { removed.push(cmd); continue; }
    next.push(node);
  }
  return { list: next, removed };
}

/**
 * Appends one command entry using the shape already present in the file, so a
 * user who hand-wrote the flat form does not get a mixed file back.
 */
function addEntry(list, { event, command, timeout, async: isAsync, shape, matcher: wanted }) {
  const entry = { type: 'command', command };
  if (Number.isFinite(timeout)) entry.timeout = timeout;
  if (isAsync) entry.async = true;

  // A caller-supplied matcher is a restriction, not a preference. The flat
  // shape has nowhere to put one, so honouring the shape would install the
  // blocking approval gate on every tool the agent touches. Matching the
  // file's shape loses to keeping the restriction.
  const useShape = shape || detectShape(list) || 'grouped';
  if (useShape === 'flat' && wanted === undefined) {
    list.push(entry);
    return list;
  }

  // Only tool events are matched by tool name; giving the others a matcher
  // makes the CLI test it against values that are not tool names.
  const matcher = wanted !== undefined
    ? wanted
    : (TOOL_EVENTS.has(event) ? '*' : undefined);
  const target = list.find(node =>
    isPlainObject(node)
    && Array.isArray(node.hooks)
    && normalizeMatcher(node.matcher) === normalizeMatcher(matcher));

  if (target) {
    target.hooks.push(entry);
    return list;
  }
  const group = matcher === undefined ? { hooks: [entry] } : { matcher, hooks: [entry] };
  list.push(group);
  return list;
}

/**
 * Checks that the hook scripts exist and are readable before their paths are
 * written into settings.json. Declaring a script that is not there turns every
 * Claude Code turn into a shell error.
 *
 * @param {string[]} [names] file names inside hooks/, defaults to all three
 * @returns {Promise<{ok:boolean, dir:string, scripts:Array<{name:string,path:string,exists:boolean,readable:boolean,error:string|null}>, missing:string[]}>}
 */
async function verifyHookScripts(names) {
  const list = Array.isArray(names) && names.length
    ? names
    : [HOOK_SCRIPT, APPROVE_SCRIPT, STATUS_SCRIPT];

  const scripts = [];
  for (const name of list) {
    const full = hookScriptPath(name);
    const info = { name, path: full, exists: false, readable: false, error: null };
    try {
      const st = await fsp.stat(full);
      info.exists = true;
      if (!st.isFile()) {
        info.error = 'not a file';
      } else {
        await fsp.access(full, fs.constants.R_OK);
        info.readable = true;
      }
    } catch (e) {
      info.error = e.code === 'ENOENT' ? 'missing' : e.message;
    }
    scripts.push(info);
  }

  const missing = scripts.filter(s => !s.readable).map(s => s.name);
  return { ok: missing.length === 0, dir: config.hooksDir, scripts, missing };
}

/**
 * @returns {Promise<{settingsPath:string, exists:boolean, parsable:boolean, empty:boolean, raw:string|null, settings:Object, error:string|null, mode:number|null}>}
 */
async function readSettings() {
  const settingsPath = config.settingsFile;
  const out = {
    settingsPath,
    exists: false,
    parsable: true,
    empty: false,
    raw: null,
    settings: {},
    error: null,
    mode: null,
  };

  let raw;
  try {
    raw = await fsp.readFile(settingsPath, 'utf-8');
  } catch (e) {
    if (e.code === 'ENOENT') return out;
    out.exists = true;
    out.parsable = false;
    out.error = `cannot read settings: ${e.message}`;
    return out;
  }

  out.exists = true;
  out.raw = raw;
  try {
    const st = await fsp.stat(settingsPath);
    out.mode = st.mode & 0o777;
  } catch {
    out.mode = null;
  }

  if (raw.trim() === '') {
    // An empty file holds no configuration, so rewriting it destroys nothing.
    out.empty = true;
    return out;
  }

  try {
    const parsed = JSON.parse(raw);
    if (!isPlainObject(parsed)) {
      out.parsable = false;
      out.error = 'settings.json does not contain a JSON object';
      return out;
    }
    out.settings = parsed;
  } catch (e) {
    out.parsable = false;
    out.error = e.message;
  }
  return out;
}

function detectIndent(raw) {
  if (typeof raw !== 'string') return 2;
  const m = raw.match(/\n([ \t]+)"/);
  if (!m) return 2;
  return m[1].includes('\t') ? '\t' : m[1].length;
}

function serialize(settings, raw) {
  const text = JSON.stringify(settings, null, detectIndent(raw));
  return text.endsWith('\n') ? text : text + '\n';
}

async function pruneBackups(dir, warnings) {
  let names;
  try {
    names = await fsp.readdir(dir);
  } catch (e) {
    warnings.push({ code: 'backup-prune-failed', message: e.message });
    return;
  }
  const backups = names.filter(n => n.startsWith(BACKUP_PREFIX)).sort().reverse();
  for (const name of backups.slice(BACKUPS_KEPT)) {
    try {
      await fsp.unlink(path.join(dir, name));
    } catch (e) {
      warnings.push({ code: 'backup-prune-failed', message: `${name}: ${e.message}` });
    }
  }
}

async function makeBackup(raw, warnings) {
  const dir = path.dirname(config.settingsFile);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const file = path.join(dir, `${BACKUP_PREFIX}${stamp}`);
  await fsp.writeFile(file, raw, 'utf-8');
  await pruneBackups(dir, warnings);
  return file;
}

/**
 * Windows hands out EPERM when an indexer or editor has the destination open
 * for a few milliseconds, and that is exactly when the user is watching.
 */
async function renameWithRetry(from, to) {
  let last = null;
  for (let i = 0; i < RENAME_RETRIES; i++) {
    try {
      await fsp.rename(from, to);
      return;
    } catch (e) {
      last = e;
      if (!['EPERM', 'EACCES', 'EBUSY'].includes(e.code)) break;
      await delay(RENAME_RETRY_MS);
    }
  }
  throw last;
}

/**
 * Backup, then temp file in the same directory, then rename. Never a partial
 * settings.json on disk, whatever happens mid-write.
 */
async function writeSettings(settings, read, warnings) {
  const target = config.settingsFile;
  const dir = path.dirname(target);
  await fsp.mkdir(dir, { recursive: true });

  const backup = read.exists && read.raw !== null && !read.empty
    ? await makeBackup(read.raw, warnings)
    : null;

  const tmp = path.join(dir, `${TMP_PREFIX}${process.pid}-${Date.now().toString(36)}`);
  const mode = read.mode === null ? 0o600 : read.mode;
  await fsp.writeFile(tmp, serialize(settings, read.raw), { encoding: 'utf-8', mode });
  try {
    await renameWithRetry(tmp, target);
  } catch (e) {
    try {
      await fsp.unlink(tmp);
    } catch (cleanupError) {
      warnings.push({ code: 'temp-file-left', message: `${tmp}: ${cleanupError.message}` });
    }
    throw e;
  }
  return backup;
}

/**
 * Reads settings.json and hands back an editable clone plus its serialized
 * `before` state, or an `{ok:false}` refusal the caller returns as its own.
 *
 * Refusing on a file we could not parse is the core guarantee of this module:
 * settings we did not understand are never written back.
 *
 * @param {string} advice  how to recover, appended to the refusal message
 */
async function openForEdit(advice) {
  const read = await readSettings();
  if (read.exists && !read.parsable) {
    return {
      ok: false,
      reason: 'unparsable',
      settingsPath: read.settingsPath,
      error: read.error,
      message: `settings.json is not valid JSON. Orchestra will not overwrite it; ${advice}`,
    };
  }

  const settings = structuredClone(read.settings);
  if (settings.hooks !== undefined && !isPlainObject(settings.hooks)) {
    return {
      ok: false,
      reason: 'unexpected-shape',
      settingsPath: read.settingsPath,
      error: 'the "hooks" key is not an object',
    };
  }
  return { ok: true, read, settings, before: JSON.stringify(settings) };
}

/**
 * Writes the edited settings only when they differ from `before`, then flushes
 * the collected warnings to the logger.
 *
 * @returns {Promise<{ok:true, changed:boolean, backup:string|null}|{ok:false}>}
 */
async function commit(settings, before, read, warnings, logger) {
  const warn = logger && typeof logger.warn === 'function'
    ? message => logger.warn(`hooks-install: ${message}`)
    : () => {};

  const changed = JSON.stringify(settings) !== before;
  let backup = null;
  if (changed) {
    try {
      backup = await writeSettings(settings, read, warnings);
    } catch (e) {
      warn(`write failed: ${e.message}`);
      return {
        ok: false,
        reason: 'write-failed',
        settingsPath: read.settingsPath,
        error: e.message,
        warnings,
      };
    }
  }

  for (const w of warnings) warn(`${w.code}: ${w.message}`);
  return { ok: true, changed, backup };
}

function statusLineView(settings) {
  const sl = settings && settings.statusLine;
  let command = '';
  if (isPlainObject(sl) && typeof sl.command === 'string') command = sl.command;
  else if (typeof sl === 'string') command = sl;
  const present = command !== '' || isPlainObject(sl);
  const ours = isOurStatusLineCommand(command);
  const expected = statusLineCommand();
  return {
    configured: present && ours,
    present,
    ours,
    // Ours but pointing elsewhere, typically an older install: reinstalling
    // repoints it, which is why install() may rewrite an existing statusLine.
    stale: ours && command !== expected,
    command: command || null,
    expected,
  };
}

/**
 * Current state of the installation, as read from disk.
 *
 * `foreign` lists hook entries that are not ours, per event; uninstall never
 * touches them and install never reorders them.
 */
async function status() {
  const read = await readSettings();
  const scripts = await verifyHookScripts();
  const base = {
    settingsPath: read.settingsPath,
    exists: read.exists,
    parsable: read.parsable,
    error: read.error,
    installed: [],
    missing: DEFAULT_EVENTS.slice(),
    approvals: { installed: false, command: approveCommand() },
    statusLine: statusLineView({}),
    foreign: [],
    events: ALL_EVENTS.slice(),
    scripts,
    node: nodeInfo(),
    async: false,
  };

  if (!read.parsable) return base;

  const settings = read.settings;
  const hooks = isPlainObject(settings.hooks) ? settings.hooks : {};

  for (const [event, list] of Object.entries(hooks)) {
    eachEntry(list, ({ entry, matcher }) => {
      const cmd = commandOf(entry);
      if (!cmd) return;
      if (isGenericHookCommand(cmd)) {
        if (!base.installed.includes(event)) base.installed.push(event);
        return;
      }
      if (isApproveHookCommand(cmd)) {
        base.approvals.installed = base.approvals.installed || event === HOOK_EVENT.PRE_TOOL_USE;
        return;
      }
      base.foreign.push({ event, command: cmd, matcher: matcher === undefined ? null : matcher });
    });
  }

  base.missing = DEFAULT_EVENTS.filter(e => !base.installed.includes(e));
  base.statusLine = statusLineView(settings);
  base.async = detectAsyncSupport(settings);
  if (settings.hooks !== undefined && !isPlainObject(settings.hooks)) {
    base.error = 'the "hooks" key is not an object';
  }
  return base;
}

function normalizeEvents(events) {
  const list = Array.isArray(events) ? events : [events];
  const wanted = [];
  const unknown = [];
  for (const raw of list) {
    if (raw === undefined || raw === null) continue;
    const e = String(raw);
    if (!ALL_EVENTS.includes(e)) { unknown.push(e); continue; }
    if (!wanted.includes(e)) wanted.push(e);
  }
  return { events: wanted, unknown };
}

/**
 * Installs the generic hook for `events`, optionally the blocking approval
 * hook on PreToolUse, and the statusLine when nothing else owns it.
 *
 * `approvals` is tri-state on purpose: `true` installs, `false` removes ours,
 * and leaving it out keeps whatever is already configured.
 *
 * @param {Object} [options]
 * @param {string[]} [options.events]      defaults to every event Orchestra knows
 * @param {boolean} [options.approvals]    install/remove the PreToolUse gate
 * @param {boolean} [options.statusLine=true]  configure the quota statusLine
 * @param {boolean} [options.asyncHooks=true]  mark generic hooks non-blocking
 * @param {{warn?:Function}} [options.logger]
 * @returns {Promise<Object>} `{ok:false, reason}` or `{ok:true, changed, installed, backup, ...}`
 */
async function install(options = {}) {
  const opts = isPlainObject(options) ? options : {};
  const approvals = opts.approvals;
  const wantStatusLine = opts.statusLine !== false;
  const asyncHooks = opts.asyncHooks !== false;
  const logger = opts.logger || null;
  const warnings = [];

  const { events, unknown } = normalizeEvents(
    opts.events === undefined ? DEFAULT_EVENTS : opts.events);
  if (unknown.length) {
    return {
      ok: false,
      reason: 'unknown-event',
      unknown,
      known: ALL_EVENTS.slice(),
      settingsPath: config.settingsFile,
    };
  }

  const node = nodeInfo();
  if (node.ephemeral) {
    warnings.push({
      code: 'node-path-ephemeral',
      message: `${node.path} belongs to a per-shell version manager directory and `
        + 'may disappear; install Orchestra with a permanently installed node.',
    });
  }

  const needed = [];
  if (events.length) needed.push(HOOK_SCRIPT);
  if (approvals === true) needed.push(APPROVE_SCRIPT);
  if (needed.length) {
    const check = await verifyHookScripts(needed);
    if (!check.ok) {
      return {
        ok: false,
        reason: 'missing-scripts',
        missing: check.missing,
        scripts: check.scripts,
        hooksDir: config.hooksDir,
        settingsPath: config.settingsFile,
      };
    }
  }

  const opened = await openForEdit('repair or move the file, then install the hooks again.');
  if (!opened.ok) return opened;
  const { read, settings, before } = opened;

  if (!isPlainObject(settings.hooks)) settings.hooks = {};

  for (const event of events) {
    const current = Array.isArray(settings.hooks[event]) ? settings.hooks[event] : [];
    const shape = userShape(current);
    const { list } = removeEntries(current, isGenericHookCommand);
    // Older CLI builds ignore an unknown `async` key rather than rejecting it,
    // and the short timeout keeps the hook harmless even when it is ignored.
    settings.hooks[event] = addEntry(list, {
      event,
      command: hookCommand(event),
      timeout: GENERIC_TIMEOUT_S,
      async: asyncHooks,
      shape,
    });
  }

  if (approvals !== undefined) {
    const event = HOOK_EVENT.PRE_TOOL_USE;
    const current = Array.isArray(settings.hooks[event]) ? settings.hooks[event] : [];
    const shape = userShape(current);
    const { list } = removeEntries(current, isApproveHookCommand);
    if (approvals === true) {
      if (shape === 'flat') {
        warnings.push({
          code: 'matcher-needs-group',
          message: `your ${event} hooks use the flat form, which cannot carry a tool matcher; `
            + 'the approval gate was added as a matcher group next to them so it stays '
            + `limited to ${MUTATING_TOOLS}.`,
        });
      }
      // Never async: the whole point is to hold the tool call until a human
      // answers, which an async hook cannot do.
      settings.hooks[event] = addEntry(list, {
        event,
        command: approveCommand(),
        timeout: approvalTimeoutSeconds(),
        async: false,
        shape,
        matcher: MUTATING_TOOLS,
      });
    } else if (list.length) {
      settings.hooks[event] = list;
    } else {
      delete settings.hooks[event];
    }
  }

  if (Object.keys(settings.hooks).length === 0) delete settings.hooks;

  const slBefore = statusLineView(settings);
  if (wantStatusLine) {
    const check = await verifyHookScripts([STATUS_SCRIPT]);
    if (!check.ok) {
      warnings.push({
        code: 'statusline-script-missing',
        message: `${hookScriptPath(STATUS_SCRIPT)} is missing, statusLine left untouched`,
      });
    } else if (slBefore.present && !slBefore.ours) {
      warnings.push({
        code: 'statusline-foreign',
        message: 'a statusLine is already configured by something else and was left alone',
        command: slBefore.command,
      });
    } else {
      settings.statusLine = { type: 'command', command: statusLineCommand() };
    }
  }

  const written = await commit(settings, before, read, warnings, logger);
  if (!written.ok) return written;

  return {
    ok: true,
    changed: written.changed,
    settingsPath: read.settingsPath,
    installed: events,
    approvals: approvals === true,
    statusLine: statusLineView(settings),
    backup: written.backup,
    warnings,
    node,
    async: asyncHooks,
  };
}

/**
 * Removes only Orchestra's entries. Foreign hooks, foreign statusLines and
 * every other key in the file survive untouched.
 *
 * @param {{logger?:{warn?:Function}}} [options]
 */
async function uninstall(options = {}) {
  const opts = isPlainObject(options) ? options : {};
  const logger = opts.logger || null;
  const warnings = [];

  const opened = await openForEdit('repair the file, then uninstall the hooks again.');
  if (!opened.ok) return opened;
  const { read, settings, before } = opened;

  if (!read.exists) {
    return {
      ok: true,
      changed: false,
      settingsPath: read.settingsPath,
      removed: [],
      statusLineRemoved: false,
      backup: null,
      warnings,
    };
  }
  const removed = [];

  if (isPlainObject(settings.hooks)) {
    for (const event of Object.keys(settings.hooks)) {
      const { list, removed: gone } = removeEntries(settings.hooks[event], isOurHookCommand);
      for (const command of gone) removed.push({ event, command });
      if (Array.isArray(list) && list.length === 0) delete settings.hooks[event];
      else settings.hooks[event] = list;
    }
    if (Object.keys(settings.hooks).length === 0) delete settings.hooks;
  }

  const sl = statusLineView(settings);
  let statusLineRemoved = false;
  if (sl.present && sl.ours) {
    delete settings.statusLine;
    statusLineRemoved = true;
  }

  const written = await commit(settings, before, read, warnings, logger);
  if (!written.ok) return written;

  return {
    ok: true,
    changed: written.changed,
    settingsPath: read.settingsPath,
    removed,
    statusLineRemoved,
    backup: written.backup,
    warnings,
  };
}

module.exports = { status, install, uninstall };
