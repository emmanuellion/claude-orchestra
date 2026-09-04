'use strict';

const fs = require('fs');
const path = require('path');

const { APPROVAL } = require('./protocol');

/**
 * Policy committed to the repository, rather than remembered per operator.
 *
 * Approval rules in `~/.claude/orchestra/approval-rules.json` are one person's
 * accumulated "always allow" clicks on one machine. They cannot be reviewed,
 * cannot be shared, and cannot be required. A team that wants "no agent runs
 * `rm -rf` in this repo, ever" has nowhere to put that sentence.
 *
 * `.orchestra-policy.json`, committed next to the code it governs, is that
 * place. It is read from the session's working directory upward, so a policy at
 * the repository root covers every agent working anywhere inside it.
 *
 * Two properties make it worth having rather than being a second rule list:
 *
 *  - **A policy deny is final.** No stored rule and no click can lift it. The
 *    operator can still edit the file, but that is a commit, in review, in
 *    history, which is the entire point.
 *  - **It is consulted before anything else,** so it constrains the shortcut,
 *    not just the prompt.
 *
 * Anything the policy does not mention falls through to the ordinary flow.
 *
 * ## Why `allow` is not honoured by default
 *
 * This file is read out of a repository, and a repository can be cloned from
 * anyone. A hostile `.orchestra-policy.json` carrying `{"tool":"Bash",
 * "decision":"allow"}` would turn `git clone` into a way to auto-approve every
 * command an agent runs in that checkout, silently, before a human sees it.
 *
 * So the asymmetry is deliberate: **deny and ask always apply, allow does
 * not.** A cloned policy can only ever make Orchestra more cautious. An
 * operator who controls the repositories they open can opt back in with
 * ORCHESTRA_TRUST_REPO_POLICY=1, which is the same distinction lib/workspace.js
 * already draws for `.orchestra.json`: a local operator choosing to relax the
 * permission model, rather than a cloned file choosing it for them.
 */

/** Directories walked upward from the session cwd looking for the file. */
const MAX_DEPTH = 12;

/** Re-stat at most this often; agents produce a lot of tool calls. */
const CACHE_TTL_MS = 5000;

/** A policy file bigger than this is not a policy file. */
const MAX_BYTES = 256 * 1024;

const MAX_RULES = 500;

const FILENAME = '.orchestra-policy.json';

const DECISIONS = new Set([APPROVAL.ALLOW, APPROVAL.DENY, 'ask']);

function makeLogger(logger) {
  const base = logger && typeof logger === 'object' ? logger : {};
  const bind = (name, fallback) =>
    (typeof base[name] === 'function' ? base[name].bind(base) : fallback);
  return {
    debug: bind('debug', () => {}),
    info: bind('info', () => {}),
    warn: bind('warn', console.warn.bind(console)),
    error: bind('error', console.error.bind(console)),
  };
}

/**
 * Glob to anchored regex. `*` stops at nothing, which is deliberate for a deny
 * pattern: `rm -rf*` has to catch `rm -rf /` and `rm -rf ./build` alike.
 */
function globToRegExp(pattern) {
  // Split on the wildcard first, then escape each literal piece. Escaping with
  // a placeholder character instead would put that character into the pattern,
  // and a NUL sentinel is exactly the stray control byte the hygiene test
  // exists to catch.
  const parts = String(pattern).split('*').map(part => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  return new RegExp(`^${parts.join('.*')}$`, 'i');
}

/**
 * One rule, or null when it is unusable.
 *
 * A malformed rule is dropped rather than failing the whole file. The
 * alternative is that one typo in a committed policy disables every other
 * protection in it, silently, which is the worst possible failure for a file
 * whose job is to say no.
 */
function normalizeRule(raw, index, warnings) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    warnings.push(`rule ${index} is not an object`);
    return null;
  }
  const decision = String(raw.decision || '').toLowerCase();
  if (!DECISIONS.has(decision)) {
    warnings.push(`rule ${index} has decision "${raw.decision}", expected allow, deny or ask`);
    return null;
  }
  const tool = typeof raw.tool === 'string' && raw.tool.trim() ? raw.tool.trim() : '*';
  const match = typeof raw.match === 'string' && raw.match ? raw.match : null;

  let matcher = null;
  if (match) {
    try {
      matcher = globToRegExp(match);
    } catch (err) {
      warnings.push(`rule ${index} has an unusable match pattern: ${err.message}`);
      return null;
    }
  }
  return {
    tool,
    toolMatcher: tool === '*' ? null : globToRegExp(tool),
    match,
    matcher,
    decision,
    reason: typeof raw.reason === 'string' ? raw.reason.slice(0, 300) : null,
  };
}

/**
 * Parses a policy document. Exported so a test, and the settings panel, can
 * validate a file without a live Policy instance watching the disk.
 *
 * @returns {{policy: Object|null, warnings: string[], error: string|null}}
 */
function parsePolicy(text, source = FILENAME) {
  const warnings = [];
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    return { policy: null, warnings, error: `${source} is not valid JSON: ${err.message}` };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { policy: null, warnings, error: `${source} must contain a JSON object` };
  }

  const rawRules = Array.isArray(parsed.rules) ? parsed.rules : [];
  if (rawRules.length > MAX_RULES) {
    warnings.push(`only the first ${MAX_RULES} rules are used`);
  }
  const rules = [];
  rawRules.slice(0, MAX_RULES).forEach((raw, i) => {
    const rule = normalizeRule(raw, i, warnings);
    if (rule) rules.push(rule);
  });

  const defaultDecision = DECISIONS.has(String(parsed.defaultDecision || '').toLowerCase())
    ? String(parsed.defaultDecision).toLowerCase()
    : null;

  const budget = parsed.budget && typeof parsed.budget === 'object' ? parsed.budget : null;
  const sessionBudget = budget && Number.isFinite(Number(budget.session))
    ? Math.max(0, Number(budget.session))
    : null;

  return {
    policy: {
      version: Number(parsed.version) || 1,
      name: typeof parsed.name === 'string' ? parsed.name.slice(0, 80) : null,
      rules,
      defaultDecision,
      sessionBudget,
      ruleCount: rules.length,
    },
    warnings,
    error: null,
  };
}

class Policy {
  /**
   * @param {{logger?: Object, filename?: string, trustAllow?: boolean}} [deps]
   *   `trustAllow` honours `allow` rules from the repository. Off by default;
   *   see the note above on why a cloned file may only tighten.
   */
  constructor({ logger = null, filename = FILENAME, trustAllow = false } = {}) {
    this.log = makeLogger(logger);
    this.filename = filename;
    this.trustAllow = !!trustAllow;
    /** @type {Map<string, {at:number, file:string|null, mtimeMs:number|null, policy:Object|null, warnings:string[], error:string|null}>} */
    this._cache = new Map();
  }

  /** Forgets every cached lookup. Called when a session is created or moved. */
  invalidate() {
    this._cache.clear();
  }

  /**
   * The policy governing a directory, or null when there is none.
   * @returns {{file:string, policy:Object, warnings:string[], error:string|null}|null}
   */
  forCwd(cwd, now = Date.now()) {
    if (typeof cwd !== 'string' || !cwd) return null;
    const cached = this._cache.get(cwd);
    if (cached && now - cached.at < CACHE_TTL_MS) {
      return cached.policy ? { file: cached.file, policy: cached.policy, warnings: cached.warnings, error: cached.error } : null;
    }

    const found = this._find(cwd);
    this._cache.set(cwd, { at: now, ...found });
    return found.policy ? { file: found.file, policy: found.policy, warnings: found.warnings, error: found.error } : null;
  }

  _find(cwd) {
    const miss = { file: null, mtimeMs: null, policy: null, warnings: [], error: null };
    let dir;
    try {
      dir = path.resolve(cwd);
    } catch {
      return miss;
    }

    for (let depth = 0; depth < MAX_DEPTH; depth++) {
      const file = path.join(dir, this.filename);
      let stat;
      try {
        stat = fs.statSync(file);
      } catch {
        const parent = path.dirname(dir);
        if (parent === dir) break;
        dir = parent;
        continue;
      }
      if (!stat.isFile()) break;
      if (stat.size > MAX_BYTES) {
        this.log.warn(`[policy] ${file} is ${stat.size} bytes, refusing to read it`);
        return { ...miss, file, error: 'policy file is too large' };
      }
      let text;
      try {
        text = fs.readFileSync(file, 'utf-8');
      } catch (err) {
        return { ...miss, file, error: `cannot read ${file}: ${err.message}` };
      }
      const { policy, warnings, error } = parsePolicy(text, file);
      if (error) {
        // A broken policy must not read as "no policy". Anything it would have
        // governed is held at ask rather than falling through to the stored
        // rules, because the file exists precisely to be the stricter word.
        this.log.warn(`[policy] ${error}`);
        return {
          file,
          mtimeMs: stat.mtimeMs,
          policy: { version: 1, name: null, rules: [], defaultDecision: 'ask', sessionBudget: null, ruleCount: 0, broken: true },
          warnings,
          error,
        };
      }
      for (const w of warnings) this.log.warn(`[policy] ${file}: ${w}`);
      return { file, mtimeMs: stat.mtimeMs, policy, warnings, error: null };
    }
    return miss;
  }

  /**
   * Decides a tool call against the policy governing its directory.
   *
   * @param {{tool:string, matchText?:string, cwd:string}} call
   * @returns {{decision:string, reason:string, file:string, rule:Object|null}|null}
   *   null when no policy applies and the ordinary flow should continue.
   */
  evaluate({ tool, matchText, cwd } = {}, now = Date.now()) {
    const found = this.forCwd(cwd, now);
    if (!found) return null;
    const { policy, file } = found;

    if (policy.broken) {
      return {
        decision: 'ask',
        reason: `the policy in ${file} could not be parsed, so nothing is being taken on trust`,
        file,
        rule: null,
      };
    }

    const toolName = String(tool || '');
    const text = typeof matchText === 'string' ? matchText : '';

    // Deny is scanned first and independently of order. A policy that lists an
    // allow before a deny still denies: the file is a boundary, not a
    // first-match dispatch table, and relying on ordering for a safety rule is
    // how a reviewer misses one.
    for (const pass of [APPROVAL.DENY, APPROVAL.ALLOW, 'ask']) {
      // An allow out of a repository is a privilege grant written by whoever
      // wrote the repository. It is skipped rather than obeyed unless the
      // operator has said they trust these files.
      if (pass === APPROVAL.ALLOW && !this.trustAllow) continue;
      for (const rule of policy.rules) {
        if (rule.decision !== pass) continue;
        if (rule.toolMatcher && !rule.toolMatcher.test(toolName)) continue;
        if (rule.matcher && !rule.matcher.test(text)) continue;
        return {
          decision: rule.decision,
          reason: rule.reason || `${file}: ${rule.decision} ${rule.tool}${rule.match ? ` ${rule.match}` : ''}`,
          file,
          rule: { tool: rule.tool, match: rule.match, decision: rule.decision },
        };
      }
    }

    // Same reasoning for a blanket default: "allow everything here" is exactly
    // the sentence a hostile repository would want to write.
    if (policy.defaultDecision && (policy.defaultDecision !== APPROVAL.ALLOW || this.trustAllow)) {
      return {
        decision: policy.defaultDecision,
        reason: `${file}: default ${policy.defaultDecision}`,
        file,
        rule: null,
      };
    }
    return null;
  }

  /** The per-session spend cap this directory's policy asks for, if any. */
  budgetForCwd(cwd, now = Date.now()) {
    const found = this.forCwd(cwd, now);
    return found && found.policy ? found.policy.sessionBudget : null;
  }

  /** What the settings panel shows: the policy in force for a directory. */
  describe(cwd) {
    const found = this.forCwd(cwd);
    if (!found) return { found: false, file: null, policy: null, warnings: [], error: null };
    return {
      found: true,
      file: found.file,
      // Surfaced so the settings pane can say that allow rules are being
      // ignored, rather than showing a rule that looks active and is not.
      trustAllow: this.trustAllow,
      policy: {
        name: found.policy.name,
        version: found.policy.version,
        ruleCount: found.policy.ruleCount,
        defaultDecision: found.policy.defaultDecision,
        sessionBudget: found.policy.sessionBudget,
        broken: !!found.policy.broken,
        rules: found.policy.rules.map(r => ({ tool: r.tool, match: r.match, decision: r.decision, reason: r.reason })),
      },
      warnings: found.warnings,
      error: found.error,
    };
  }
}

module.exports = { Policy, parsePolicy, globToRegExp, FILENAME, MAX_RULES, CACHE_TTL_MS };
