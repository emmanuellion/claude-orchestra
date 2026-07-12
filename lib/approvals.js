'use strict';

const { EventEmitter } = require('events');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const defaultConfig = require('./config');
const { STATUS, APPROVAL, APPROVAL_SCOPE } = require('./protocol');
const { redactDeep } = require('./redact');

/** Runaway agent guard: past this many blocked calls we stop queueing. */
const MAX_PENDING = 50;
const MAX_RULES = 500;
/** Decisions stay readable this long so a retried hook can pick up its answer. */
const RESOLVED_TTL_MS = 10 * 60 * 1000;
const PURGE_INTERVAL_MS = 60 * 1000;
const SUMMARY_MAX = 200;
const DETAIL_MAX = 4000;
const DIFF_HALF = 10;
const MATCH_TEXT_MAX = 4000;
const RULES_VERSION = 1;

const NOOP_LOGGER = {
  info() {},
  warn(...a) { console.warn(...a); },
  error(...a) { console.error(...a); },
};

function firstLine(text, max) {
  const line = String(text).split('\n')[0].trim();
  return line.length > max ? line.slice(0, max - 1) + '…' : line;
}

function clip(text, max) {
  const s = String(text);
  return s.length > max ? s.slice(0, max) + `\n... (${s.length - max} more characters)` : s;
}

/**
 * Builds a compact removed/added extract instead of a real diff: Edit hands us
 * two opaque strings, not hunks. We take the head of each side rather than the
 * first 20 lines overall, because a long `old_string` would otherwise push the
 * replacement text off the screen and the human would approve a change they
 * never saw.
 */
function diffExtract(oldStr, newStr) {
  const out = [];
  const push = (raw, sign) => {
    const lines = String(raw == null ? '' : raw).split('\n');
    for (const line of lines.slice(0, DIFF_HALF)) out.push(sign + ' ' + line);
    if (lines.length > DIFF_HALF) out.push(`${sign} ... (${lines.length - DIFF_HALF} more lines)`);
  };
  push(oldStr, '-');
  push(newStr, '+');
  return out.join('\n');
}

function headLines(text, count) {
  const lines = String(text == null ? '' : text).split('\n');
  const head = lines.slice(0, count).join('\n');
  return lines.length > count ? head + `\n... (${lines.length - count} more lines)` : head;
}

function safeJson(value, max) {
  let text;
  try {
    text = JSON.stringify(value);
  } catch (e) {
    text = `[unserializable input: ${e.message}]`;
  }
  if (text === undefined) text = String(value);
  return clip(text, max);
}

/**
 * Human summary of a tool call plus the text a rule pattern is matched against.
 * This is what somebody reads on a phone at arm's length, so the important part
 * has to be in `summary`; `detail` carries the rest.
 *
 * @returns {{summary:string, detail:string, matchText:string}}
 */
function describeToolCall(tool, rawInput) {
  const input = rawInput && typeof rawInput === 'object' ? rawInput : {};
  const name = String(tool || 'unknown');

  const file = typeof input.file_path === 'string' ? input.file_path
    : (typeof input.path === 'string' ? input.path : '');

  let summary = '';
  let detail = '';
  let matchText = '';

  switch (name) {
    case 'Bash': {
      const command = String(input.command || '');
      matchText = command;
      summary = firstLine(command || name, SUMMARY_MAX);
      detail = clip(command, DETAIL_MAX);
      if (typeof input.description === 'string' && input.description) {
        detail = `${input.description}\n\n${detail}`;
      }
      if (input.run_in_background) detail += '\n\n(runs in background)';
      break;
    }
    case 'BashOutput':
    case 'KillShell': {
      // These two identify a running shell, never a command line: the field is
      // `bash_id`, and reading `command` here would yield no match text at all.
      const shell = String(input.bash_id || input.shell_id || '');
      matchText = shell;
      summary = firstLine(shell ? `${name} ${shell}` : name, SUMMARY_MAX);
      detail = clip(safeJson(input, DETAIL_MAX), DETAIL_MAX);
      break;
    }
    case 'Edit':
    case 'NotebookEdit': {
      matchText = file;
      summary = firstLine(file || name, SUMMARY_MAX);
      detail = `${file}\n\n${diffExtract(input.old_string ?? input.old_source, input.new_string ?? input.new_source)}`;
      detail = clip(detail, DETAIL_MAX);
      break;
    }
    case 'MultiEdit': {
      matchText = file;
      const edits = Array.isArray(input.edits) ? input.edits : [];
      summary = firstLine(`${file} (${edits.length} edit${edits.length === 1 ? '' : 's'})`, SUMMARY_MAX);
      const first = edits[0] || {};
      detail = clip(`${file}\n\n${diffExtract(first.old_string, first.new_string)}`, DETAIL_MAX);
      break;
    }
    case 'Write': {
      matchText = file;
      summary = firstLine(file || name, SUMMARY_MAX);
      detail = clip(`${file}\n\n${headLines(input.content, DIFF_HALF * 2)}`, DETAIL_MAX);
      break;
    }
    case 'Read':
    case 'Glob':
    case 'Grep': {
      const target = file || String(input.pattern || '');
      matchText = target;
      const where = typeof input.path === 'string' && input.path !== target ? ` in ${input.path}` : '';
      summary = firstLine(target + where, SUMMARY_MAX);
      detail = clip(safeJson(input, DETAIL_MAX), DETAIL_MAX);
      break;
    }
    case 'WebFetch': {
      const url = String(input.url || '');
      matchText = url;
      summary = firstLine(url, SUMMARY_MAX);
      detail = clip(url + (input.prompt ? `\n\n${input.prompt}` : ''), DETAIL_MAX);
      break;
    }
    case 'WebSearch': {
      const query = String(input.query || '');
      matchText = query;
      summary = firstLine(query, SUMMARY_MAX);
      detail = clip(query, DETAIL_MAX);
      break;
    }
    case 'Task': {
      const desc = String(input.description || '');
      matchText = String(input.subagent_type || desc);
      summary = firstLine(`${input.subagent_type || 'agent'}: ${desc}`, SUMMARY_MAX);
      detail = clip(String(input.prompt || desc), DETAIL_MAX);
      break;
    }
    default: {
      matchText = safeJson(input, MATCH_TEXT_MAX);
      summary = firstLine(matchText, SUMMARY_MAX);
      detail = clip(safeJson(input, DETAIL_MAX), DETAIL_MAX);
    }
  }

  if (!summary) summary = name;
  // A tool called without the field we read still has to produce something a
  // rule can be keyed on. Falling back to the serialized input keeps a rule
  // narrow; leaving the match text empty would make it match everything.
  if (!matchText) matchText = safeJson(input, MATCH_TEXT_MAX);
  return {
    summary,
    detail,
    matchText: String(matchText).slice(0, MATCH_TEXT_MAX),
  };
}

/**
 * Wildcard-only glob. User supplied regexes are deliberately not accepted: they
 * are a ReDoS vector, and more importantly a mistyped one silently matches more
 * than its author meant, which for an allow rule is a permission the human
 * never granted.
 */
function globToRegExp(pattern) {
  const escaped = String(pattern).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const body = escaped.split('\\*').join('[\\s\\S]*');
  return new RegExp('^' + body + '$');
}

function normalizeDir(p) {
  if (!p || typeof p !== 'string') return null;
  let resolved = path.resolve(p).replace(/[\\/]+$/, '');
  if (process.platform === 'win32') resolved = resolved.toLowerCase();
  return resolved || null;
}

function isUnder(child, parent) {
  if (!parent) return true;
  if (!child) return false;
  if (child === parent) return true;
  return child.startsWith(parent + path.sep) || child.startsWith(parent + '/');
}

function writeJsonAtomic(file, data) {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', { encoding: 'utf-8', mode: 0o600 });
  if (fs.existsSync(file)) {
    // Backup before the rename, never after: a crash mid-write must still leave
    // a readable previous generation.
    fs.copyFileSync(file, `${file}.bak`);
  }
  fs.renameSync(tmp, file);
}

/**
 * The remote permission queue.
 *
 * A blocked `PreToolUse` hook POSTs here and the HTTP response is held open
 * until a human decides, a stored rule decides for them, or the request times
 * out. Everything the browser shows about a pending permission comes from
 * `pending()`; everything it does comes back through `decide()`.
 *
 * @fires ApprovalQueue#request   a new request needs a human
 * @fires ApprovalQueue#resolved  a request got an answer, from any source
 * @fires ApprovalQueue#rules     the persisted rule set changed
 */
class ApprovalQueue extends EventEmitter {
  /**
   * @param {Object} deps
   * @param {import('./session-manager').SessionManager} [deps.sessions]
   * @param {Object} [deps.config]
   * @param {{info:Function,warn:Function,error:Function}} [deps.logger]
   */
  constructor({ sessions = null, config = defaultConfig, logger = NOOP_LOGGER } = {}) {
    super();
    this.sessions = sessions;
    this.config = config;
    this.logger = logger || NOOP_LOGGER;

    /** @type {Map<string, any>} id -> pending entry */
    this.pendingById = new Map();
    /** @type {Map<string, any>} id -> {resolvedAt, result} */
    this.recent = new Map();
    /** @type {Array<any>} persisted rules */
    this.rules = [];
    /** @type {Map<string, Array<any>>} sessionId -> in-memory rules */
    this.sessionRules = new Map();
    /** @type {Map<string, RegExp>} compiled pattern cache */
    this._regexCache = new Map();
    this._saveTimer = null;
    this._dirty = false;

    this.loadRules();

    this._purgeTimer = setInterval(() => this.purge(), PURGE_INTERVAL_MS);
    if (this._purgeTimer.unref) this._purgeTimer.unref();

    this._onSessionGone = ({ id }) => this.abandonSession(id, 'session ended');
    if (this.sessions && typeof this.sessions.on === 'function') {
      this.sessions.on('closed', this._onSessionGone);
      this.sessions.on('exit', this._onSessionGone);
    }
  }

  /**
   * Blocks until a decision exists.
   *
   * @param {Object} req
   * @param {string} req.sessionId  Orchestra session id from ORCHESTRA_SESSION_ID
   * @param {string} req.tool       Claude Code tool name
   * @param {Object} req.input      raw tool input
   * @param {string} [req.cwd]      directory the agent is working in
   * @returns {Promise<{id:string, decision:string, scope:string, reason:string, source:string}>}
   */
  request({ sessionId, tool, input, cwd } = {}) {
    const id = crypto.randomUUID();
    const toolName = String(tool || 'unknown').slice(0, 120);
    const described = describeToolCall(toolName, input);
    const session = this.sessions && sessionId ? this.sessions.get(sessionId) : null;
    const effectiveCwd = cwd || (session && session.cwd) || null;

    const entry = {
      id,
      sessionId: sessionId || null,
      sessionName: session ? session.name : null,
      tool: toolName,
      cwd: effectiveCwd,
      summary: described.summary,
      detail: described.detail,
      matchText: described.matchText,
      createdAt: Date.now(),
      expiresAt: Date.now() + this.timeoutMs,
      resolve: null,
      timer: null,
    };

    const matched = this.matchRule(entry);
    if (matched) {
      matched.hits += 1;
      this._touchRules(matched);
      const result = {
        id,
        decision: matched.decision,
        scope: APPROVAL_SCOPE.ONCE,
        reason: `matched rule ${matched.id}`,
        source: 'rule',
        ruleId: matched.id,
      };
      this.audit(entry, result);
      this.emit('resolved', this.toWireResolution(entry, result));
      return Promise.resolve(result);
    }

    if (this.pendingById.size >= MAX_PENDING) {
      // Hand the decision back to Claude Code's own prompt rather than deny.
      // A full queue is our problem, not evidence that the action is unsafe,
      // and denying here silently kills legitimate work at exactly the moment
      // the operator is busiest. The hook translates 'ask' into the native
      // prompt, so a human still decides; they just decide in the terminal.
      const result = {
        id,
        decision: 'ask',
        scope: APPROVAL_SCOPE.ONCE,
        reason: `Orchestra approval queue is full (${MAX_PENDING} pending); asking in the terminal instead`,
        source: 'queue-full',
      };
      this.logger.warn(`[approvals] queue full, deferring ${toolName} to the native prompt for session ${entry.sessionId}`);
      this.audit(entry, result);
      this.emit('resolved', this.toWireResolution(entry, result));
      return Promise.resolve(result);
    }

    return new Promise(resolve => {
      entry.resolve = resolve;
      this.pendingById.set(id, entry);

      entry.timer = setTimeout(() => {
        // Fail closed, and deliberately not configurable to fail open: a
        // request nobody answered is a request nobody consented to. An agent
        // left running overnight must not be able to outlast its operator.
        this._denyPending(entry, 'timeout');
      }, this.timeoutMs);

      this.markSession(entry.sessionId, STATUS.AWAITING_PERMISSION, {
        lastQuestion: `${toolName}: ${entry.summary}`,
      });
      this.emit('request', this.toWire(entry));
      this.logger.info(`[approvals] ${toolName} awaiting decision (${id}) session=${entry.sessionId}`);
    });
  }

  /**
   * Applies an operator decision.
   *
   * The decision itself is never lost: whatever happens to the rule the
   * operator asked for, the waiting hook is settled with the allow or deny
   * they clicked. A scope that cannot be honoured is narrowed to `once` and
   * reported back in `warnings` rather than dropped, because the alternative
   * is an agent that hangs until the deadline and is then denied by a timeout
   * the operator never saw.
   *
   * @param {{decision:string, scope?:string, pattern?:string, cwd?:string, tool?:string}} choice
   * @returns {{ok:boolean, error?:string, rule?:Object, scope?:string, warnings?:string[]}}
   */
  decide(id, choice = {}) {
    const entry = this.pendingById.get(id);
    if (!entry) {
      const already = this.recent.get(id);
      if (already) return { ok: false, error: 'already decided' };
      return { ok: false, error: 'not found' };
    }

    const decision = choice.decision === APPROVAL.ALLOW ? APPROVAL.ALLOW : APPROVAL.DENY;
    const asked = Object.values(APPROVAL_SCOPE).includes(choice.scope)
      ? choice.scope
      : APPROVAL_SCOPE.ONCE;

    const warnings = [];
    let scope = asked;

    // Every anonymous request would otherwise land in the same `null` bucket,
    // so "this session" would silently mean "every agent that does not
    // identify itself".
    if (scope === APPROVAL_SCOPE.SESSION && !entry.sessionId) {
      scope = APPROVAL_SCOPE.ONCE;
      warnings.push('this request carries no session id, so it was applied once instead of for the session');
    }

    let rule = null;
    if (scope === APPROVAL_SCOPE.SESSION || scope === APPROVAL_SCOPE.ALWAYS) {
      rule = this.buildRule(entry, decision, choice);
      // No pattern means no evidence of what was approved, and ruleMatches
      // would let it stand for every call of the tool. Refuse to remember a
      // decision we cannot describe.
      if (!rule.pattern) {
        rule = null;
        scope = APPROVAL_SCOPE.ONCE;
        warnings.push('nothing identifies this call, so no rule was saved and the decision applies once');
      }
    }

    if (rule && scope === APPROVAL_SCOPE.SESSION) {
      const list = this.sessionRules.get(entry.sessionId) || [];
      list.push(rule);
      this.sessionRules.set(entry.sessionId, list);
    }
    if (rule && scope === APPROVAL_SCOPE.ALWAYS) {
      const added = this.addRule(rule);
      if (!added.ok) {
        rule = null;
        scope = APPROVAL_SCOPE.ONCE;
        warnings.push(`the rule could not be saved (${added.error}), so the decision applies once`);
        this.logger.warn(`[approvals] could not persist rule for ${entry.tool}: ${added.error}`);
      }
    }

    const reason = typeof choice.reason === 'string' && choice.reason
      ? choice.reason.slice(0, 500)
      : 'decided by operator';

    this.settle(entry, {
      id,
      decision,
      scope,
      reason: warnings.length ? `${reason} (${warnings.join('; ')})` : reason,
      source: 'human',
      ruleId: rule ? rule.id : null,
    });
    return warnings.length
      ? { ok: true, rule, scope, warnings }
      : { ok: true, rule, scope };
  }

  settle(entry, result) {
    if (!this.pendingById.delete(entry.id)) return;
    clearTimeout(entry.timer);
    this.recent.set(entry.id, { resolvedAt: Date.now(), result });
    this.audit(entry, result);
    // One agent can have several tool calls blocked at once, and answering one
    // of them leaves the others still holding their hooks open. The session
    // stays reported as blocked until none are left, showing the next question
    // instead of clearing it.
    const next = this._nextPendingFor(entry.sessionId);
    if (next) {
      this.markSession(entry.sessionId, STATUS.AWAITING_PERMISSION, {
        lastQuestion: `${next.tool}: ${next.summary}`,
      });
    } else {
      this.markSession(entry.sessionId, STATUS.BUSY, { lastQuestion: null });
    }
    this.emit('resolved', this.toWireResolution(entry, result));
    if (typeof entry.resolve === 'function') entry.resolve(result);
  }

  /** Settles a request nobody answered: a timeout, a dead session, a shutdown. */
  _denyPending(entry, reason) {
    this.settle(entry, {
      id: entry.id,
      decision: APPROVAL.DENY,
      scope: APPROVAL_SCOPE.ONCE,
      reason,
      source: 'timeout',
    });
  }

  /** Oldest request still blocking `sessionId`, or null. */
  _nextPendingFor(sessionId) {
    if (!sessionId) return null;
    for (const entry of this.pendingById.values()) {
      if (entry.sessionId === sessionId) return entry;
    }
    return null;
  }

  /** Resolves every request belonging to a session that is gone. */
  abandonSession(sessionId, reason) {
    if (!sessionId) return;
    for (const entry of [...this.pendingById.values()]) {
      if (entry.sessionId !== sessionId) continue;
      this._denyPending(entry, reason);
    }
    this.sessionRules.delete(sessionId);
  }

  /** Pending requests, serializable, oldest first. */
  pending() {
    return [...this.pendingById.values()]
      .sort((a, b) => a.createdAt - b.createdAt)
      .map(e => this.toWire(e));
  }

  toWire(entry) {
    return {
      id: entry.id,
      sessionId: entry.sessionId,
      sessionName: entry.sessionName,
      tool: entry.tool,
      cwd: entry.cwd,
      summary: entry.summary,
      detail: entry.detail,
      /** Pre-filled value for the "always allow" pattern field in the UI. */
      patternSuggestion: entry.matchText,
      createdAt: entry.createdAt,
      expiresAt: entry.expiresAt,
    };
  }

  toWireResolution(entry, result) {
    return {
      id: entry.id,
      sessionId: entry.sessionId,
      tool: entry.tool,
      summary: entry.summary,
      decision: result.decision,
      scope: result.scope,
      reason: result.reason,
      source: result.source,
      ruleId: result.ruleId || null,
      resolvedAt: Date.now(),
    };
  }

  get timeoutMs() {
    const ms = Number(this.config && this.config.approvalTimeoutMs);
    return Number.isFinite(ms) && ms > 1000 ? ms : 300000;
  }

  markSession(sessionId, status, patch) {
    if (!this.sessions || !sessionId) return;
    const session = this.sessions.get(sessionId);
    if (!session) return;
    if (status === STATUS.BUSY && session.status !== STATUS.AWAITING_PERMISSION) {
      // Somebody already moved the session on; do not drag it back to busy.
      if (patch) Object.assign(session.agent, patch);
      return;
    }
    this.sessions.setStatus(session, status, patch);
  }

  buildRule(entry, decision, choice) {
    const hasPattern = typeof choice.pattern === 'string' && choice.pattern.length > 0;
    return {
      id: crypto.randomUUID(),
      tool: typeof choice.tool === 'string' && choice.tool ? choice.tool.slice(0, 120) : entry.tool,
      pattern: hasPattern ? choice.pattern.slice(0, MATCH_TEXT_MAX) : entry.matchText,
      /**
       * A rule generated from a decision matches the observed text literally.
       * The glob language has no escape for `*`, so treating a captured
       * `rm *.log` as a wildcard would quietly authorise `rm -rf /`.
       * Only a pattern the operator typed on purpose is expanded.
       */
      exact: !hasPattern,
      cwd: typeof choice.cwd === 'string' && choice.cwd ? choice.cwd : (entry.cwd || null),
      decision,
      createdAt: Date.now(),
      hits: 0,
    };
  }

  /**
   * First matching rule wins, with denies evaluated before allows so a broad
   * allow can never shadow a narrow deny.
   */
  matchRule(entry) {
    const candidates = [
      ...(this.sessionRules.get(entry.sessionId) || []),
      ...this.rules,
    ];
    for (const rule of candidates) {
      if (rule.decision === APPROVAL.DENY && this.ruleMatches(rule, entry)) return rule;
    }
    for (const rule of candidates) {
      if (rule.decision !== APPROVAL.DENY && this.ruleMatches(rule, entry)) return rule;
    }
    return null;
  }

  ruleMatches(rule, entry) {
    if (!rule || typeof rule !== 'object') return false;
    if (rule.tool && rule.tool !== '*' && rule.tool !== entry.tool) return false;
    if (rule.cwd) {
      if (!isUnder(normalizeDir(entry.cwd), normalizeDir(rule.cwd))) return false;
    }
    // A rule without a pattern matches nothing. Reading it as "matches
    // everything" would turn one careless "always allow" into a standing
    // permission for the whole tool; that is spelled `pattern: '*'` with
    // `exact: false`, on purpose and visibly.
    if (!rule.pattern) return false;
    if (rule.exact) return rule.pattern === entry.matchText;
    const re = this.compile(rule.pattern);
    if (!re) return false;
    return re.test(entry.matchText);
  }

  compile(pattern) {
    const cached = this._regexCache.get(pattern);
    if (cached) return cached;
    let re;
    try {
      re = globToRegExp(pattern);
    } catch (e) {
      this.logger.error(`[approvals] unusable rule pattern ${JSON.stringify(pattern)}: ${e.message}`);
      return null;
    }
    if (this._regexCache.size > MAX_RULES * 2) this._regexCache.clear();
    this._regexCache.set(pattern, re);
    return re;
  }

  listRules() {
    return this.rules.map(r => ({ ...r }));
  }

  /** @returns {{ok:boolean, error?:string, rule?:Object}} */
  addRule(rule) {
    if (!rule || typeof rule.tool !== 'string' || !rule.tool) {
      return { ok: false, error: 'rule needs a tool' };
    }
    if (rule.decision !== APPROVAL.ALLOW && rule.decision !== APPROVAL.DENY) {
      return { ok: false, error: 'rule needs a decision' };
    }
    if (this.rules.length >= MAX_RULES) {
      return { ok: false, error: `rule limit reached (${MAX_RULES})` };
    }
    if (typeof rule.pattern !== 'string' || !rule.pattern) {
      return { ok: false, error: "rule needs a pattern; use '*' to mean every call of the tool" };
    }
    const stored = {
      id: rule.id || crypto.randomUUID(),
      tool: rule.tool.slice(0, 120),
      pattern: typeof rule.pattern === 'string' ? rule.pattern.slice(0, MATCH_TEXT_MAX) : '',
      exact: rule.exact !== false,
      cwd: typeof rule.cwd === 'string' && rule.cwd ? rule.cwd : null,
      decision: rule.decision,
      createdAt: Number.isFinite(rule.createdAt) ? rule.createdAt : Date.now(),
      hits: Number.isFinite(rule.hits) ? rule.hits : 0,
    };
    if (!stored.exact && !this.compile(stored.pattern)) {
      return { ok: false, error: 'invalid pattern' };
    }
    this.rules.push(stored);
    this.saveRules();
    this.emit('rules', this.listRules());
    return { ok: true, rule: { ...stored } };
  }

  deleteRule(id) {
    const before = this.rules.length;
    this.rules = this.rules.filter(r => r.id !== id);
    if (this.rules.length === before) return { ok: false, error: 'not found' };
    this.saveRules();
    this.emit('rules', this.listRules());
    return { ok: true };
  }

  loadRules() {
    const file = this.config.approvalRulesFile;
    let raw;
    try {
      raw = fs.readFileSync(file, 'utf-8');
    } catch (e) {
      if (e.code !== 'ENOENT') {
        this.logger.error(`[approvals] cannot read ${file}: ${e.message}`);
      }
      this.rules = [];
      return;
    }
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (e) {
      // Never overwrite a file we failed to understand: move it aside, keep it,
      // and say so loudly. Rewriting it would destroy rules the operator set.
      const quarantine = `${file}.corrupt-${Date.now()}`;
      try {
        fs.renameSync(file, quarantine);
        this.logger.error(`[approvals] ${file} is not valid JSON (${e.message}); moved to ${quarantine}`);
      } catch (moveErr) {
        this.logger.error(`[approvals] ${file} is not valid JSON (${e.message}) and could not be moved aside: ${moveErr.message}`);
      }
      this.rules = [];
      return;
    }
    const list = Array.isArray(parsed) ? parsed : (Array.isArray(parsed.rules) ? parsed.rules : []);
    this.rules = [];
    let droppedBlanks = 0;
    for (const item of list.slice(0, MAX_RULES)) {
      if (!item || typeof item !== 'object') continue;
      if (item.decision !== APPROVAL.ALLOW && item.decision !== APPROVAL.DENY) continue;
      if (typeof item.tool !== 'string' || !item.tool) continue;
      let pattern = typeof item.pattern === 'string' ? item.pattern.slice(0, MATCH_TEXT_MAX) : '';
      let exact = item.exact !== false;
      if (!pattern) {
        // Written by the version that turned an empty match text into a rule.
        // A blank deny covered the whole tool and still should, so it is
        // rewritten as an explicit tool-wide deny; a blank allow granted more
        // than anyone chose and is dropped.
        if (item.decision === APPROVAL.DENY) {
          pattern = '*';
          exact = false;
        } else {
          droppedBlanks += 1;
          continue;
        }
      }
      this.rules.push({
        id: typeof item.id === 'string' ? item.id : crypto.randomUUID(),
        tool: item.tool.slice(0, 120),
        pattern,
        exact,
        cwd: typeof item.cwd === 'string' && item.cwd ? item.cwd : null,
        decision: item.decision,
        createdAt: Number.isFinite(item.createdAt) ? item.createdAt : Date.now(),
        hits: Number.isFinite(item.hits) ? item.hits : 0,
      });
    }
    if (droppedBlanks) {
      this.logger.warn(`[approvals] dropped ${droppedBlanks} allow rule(s) from ${file} with no pattern: `
        + 'they matched every call of their tool. Approve those calls again to record a rule that says what it allows.');
    }
    this.logger.info(`[approvals] loaded ${this.rules.length} rule(s) from ${file}`);
  }

  saveRules() {
    if (this._saveTimer) {
      clearTimeout(this._saveTimer);
      this._saveTimer = null;
    }
    this._dirty = false;
    try {
      writeJsonAtomic(this.config.approvalRulesFile, {
        version: RULES_VERSION,
        updatedAt: Date.now(),
        rules: this.rules,
      });
      return { ok: true };
    } catch (e) {
      this.logger.error(`[approvals] could not persist rules to ${this.config.approvalRulesFile}: ${e.message}`);
      return { ok: false, error: e.message };
    }
  }

  /** Hit counters are not worth an fsync each; batch them. */
  _touchRules(rule) {
    if (!this.rules.includes(rule)) return;
    this._dirty = true;
    if (this._saveTimer) return;
    this._saveTimer = setTimeout(() => {
      this._saveTimer = null;
      if (this._dirty) this.saveRules();
    }, 5000);
    if (this._saveTimer.unref) this._saveTimer.unref();
  }

  /**
   * Appends one decision to the append-only log: one JSON object per line,
   * never rewritten. Redacted for the same reason as the timeline, since the
   * summary of a Bash call carries the whole command line, secrets included.
   */
  audit(entry, result) {
    const line = JSON.stringify(redactDeep({
      ts: new Date().toISOString(),
      sessionId: entry.sessionId,
      tool: entry.tool,
      cwd: entry.cwd,
      summary: entry.summary,
      decision: result.decision,
      scope: result.scope,
      source: result.source,
      reason: result.reason,
      ruleId: result.ruleId || null,
    })) + '\n';
    fs.appendFile(this.config.auditLogFile, line, 'utf-8', err => {
      if (err) this.logger.error(`[approvals] audit write failed: ${err.message}`);
    });
  }

  purge() {
    const cutoff = Date.now() - RESOLVED_TTL_MS;
    for (const [id, record] of this.recent) {
      if (record.resolvedAt < cutoff) this.recent.delete(id);
    }
    for (const sessionId of [...this.sessionRules.keys()]) {
      if (this.sessions && !this.sessions.get(sessionId)) this.sessionRules.delete(sessionId);
    }
  }

  shutdown() {
    clearInterval(this._purgeTimer);
    if (this._saveTimer) {
      clearTimeout(this._saveTimer);
      this._saveTimer = null;
    }
    if (this._dirty) this.saveRules();
    if (this.sessions && typeof this.sessions.off === 'function') {
      this.sessions.off('closed', this._onSessionGone);
      this.sessions.off('exit', this._onSessionGone);
    }
    for (const entry of [...this.pendingById.values()]) {
      this._denyPending(entry, 'orchestra shutting down');
    }
  }
}

module.exports = {
  ApprovalQueue,
  describeToolCall,
  globToRegExp,
  writeJsonAtomic,
  MAX_PENDING,
  MAX_RULES,
};
