'use strict';

const { EventEmitter } = require('events');
const fs = require('fs');

const defaultConfig = require('./config');
const { STATUS } = require('./protocol');

/**
 * Spend caps that actually stop an agent.
 *
 * Orchestra has always measured cost: every hook reports a running total and it
 * lands in `session.agent.cost`. Measuring is not controlling. A dashboard that
 * shows $40 after the fact is a receipt, not a budget, and an agent in a retry
 * loop overnight is exactly the case where nobody is reading the dashboard.
 *
 * So this reads the same number and, at the cap, locks the session. `locked` is
 * an existing property the whole system already respects: `SessionManager.write`
 * refuses to write to a locked session, and so does the quota auto resume. One
 * flag, already honoured everywhere, is the entire enforcement mechanism.
 *
 * Locking rather than killing is deliberate. The agent's context, its scrollback
 * and its worktree all survive, and a human can lift the lock in one click.
 * Killing would destroy work to save money that was already spent.
 *
 * @fires BudgetGuard#breach   a session hit its cap and was locked
 * @fires BudgetGuard#warning  a session crossed the warning threshold
 * @fires BudgetGuard#state    the ledger changed, for UI fanout
 */

/** Fraction of a cap at which a warning is raised once. */
const WARN_RATIO = 0.8;

/** Ledger days retained. Enough for a month of review, bounded. */
const LEDGER_DAYS = 45;

/** Debounce for the ledger write; hook events arrive constantly. */
const SAVE_DEBOUNCE_MS = 2000;

const BOUNDS = {
  sessionCap: [0, 10000],
  dailyCap: [0, 100000],
};

const ACTIONS = new Set(['lock', 'warn']);

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

function clampNumber(value, [min, max], fallback) {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

/** Local calendar day. Spend is judged the way a human reads a bill. */
function dayKey(now = Date.now()) {
  const d = new Date(now);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function writeJsonAtomic(file, data) {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, { encoding: 'utf-8', mode: 0o600 });
  fs.renameSync(tmp, file);
}

class BudgetGuard extends EventEmitter {
  /**
   * @param {Object} deps
   * @param {import('./session-manager').SessionManager} deps.sessions
   * @param {import('./policy').Policy} [deps.policy] per-repo caps
   * @param {Object} [deps.config]
   * @param {Object} [deps.logger]
   */
  constructor({ sessions, policy = null, config = defaultConfig, logger = null } = {}) {
    super();
    if (!sessions) throw new Error('BudgetGuard requires a SessionManager');
    this.sessions = sessions;
    this.policy = policy;
    this.config = config;
    this.log = makeLogger(logger);
    this.file = config.budgetFile;

    const loaded = this._load();
    this._settings = loaded.settings;
    /** @type {Object<string, Object<string, number>>} day -> sessionId -> cost */
    this.ledger = loaded.ledger;

    /** Sessions already acted on, so one breach produces one lock and one alert. */
    this._breached = new Set();
    this._warned = new Set();
    /**
     * Ceilings raised by an operator unlocking a session, absolute rather than
     * additive.
     *
     * Without this, "unlock" is a button that undoes itself: the session is
     * already past its cap, so the very next hook event carrying a cost locks
     * it again before anyone can type. Granting a fixed increment does not fix
     * it either, because the overshoot at the moment of the breach is unknown.
     *
     * So unlocking sets a new ceiling at "what it has spent, plus one more
     * cap". The limit still exists and will stop the session again; it was
     * deliberately raised, once, by a human.
     */
    this._ceiling = new Map();
    this._dailyCeiling = null;
    /** @type {Object[]} recent breaches, for the digest and the UI */
    this._events = [];

    this._saveTimer = null;
    this._started = false;
    this._onSession = wire => this.observe(wire);
  }

  start() {
    if (this._started) return this;
    this._started = true;
    this.sessions.on('session', this._onSession);
    return this;
  }

  stop() {
    this._started = false;
    this.sessions.removeListener('session', this._onSession);
    if (this._saveTimer) {
      clearTimeout(this._saveTimer);
      this._saveTimer = null;
      this._persist();
    }
  }

  settings() {
    return { ...this._settings };
  }

  /** @returns {{settings:Object, error:string|null}} */
  updateSettings(patch = {}) {
    const next = { ...this._settings };
    if (patch.enabled !== undefined) next.enabled = !!patch.enabled;
    if (patch.action !== undefined) {
      const action = String(patch.action);
      if (!ACTIONS.has(action)) {
        return { settings: this.settings(), error: 'action must be "lock" or "warn"' };
      }
      next.action = action;
    }
    for (const key of Object.keys(BOUNDS)) {
      if (patch[key] !== undefined) {
        next[key] = clampNumber(patch[key], BOUNDS[key], this._settings[key]);
      }
    }
    if (next.enabled && !next.sessionCap && !next.dailyCap) {
      return { settings: this.settings(), error: 'set a session cap or a daily cap before turning this on' };
    }
    this._settings = next;
    this._persist();
    this.emit('state', this.state());
    return { settings: this.settings(), error: null };
  }

  /**
   * Records a session's reported spend and enforces the caps.
   *
   * Cost only ever moves up, so a lower report is a truncated or replayed hook
   * payload rather than a refund, and is ignored.
   *
   * @param {Object} wire  a wire session, as broadcast by SessionManager
   */
  observe(wire, now = Date.now()) {
    if (!wire || typeof wire.id !== 'string') return null;
    const cost = Number(wire.agent && wire.agent.cost);
    if (!Number.isFinite(cost) || cost < 0) return null;

    const day = dayKey(now);
    const today = this.ledger[day] || (this.ledger[day] = {});
    const previous = Number(today[wire.id]) || 0;
    if (cost <= previous) return null;

    today[wire.id] = cost;
    this._scheduleSave();

    if (!this._settings.enabled) {
      this.emit('state', this.state(now));
      return null;
    }
    return this._enforce(wire, cost, now);
  }

  _enforce(wire, cost, now) {
    const sessionCap = this.effectiveCap(wire);
    const dailyCap = this._settings.dailyCap > 0
      ? Math.max(this._settings.dailyCap, this._dailyCeiling || 0)
      : 0;
    const dayTotal = this.todayTotal(now);

    const overSession = sessionCap > 0 && cost >= sessionCap;
    const overDaily = dailyCap > 0 && dayTotal >= dailyCap;

    if (overSession || overDaily) {
      if (this._breached.has(wire.id)) return null;
      this._breached.add(wire.id);

      const scope = overSession ? 'session' : 'daily';
      const cap = overSession ? sessionCap : dailyCap;
      const spent = overSession ? cost : dayTotal;
      const locked = this._settings.action === 'lock' && this._lock(wire.id);

      const info = {
        sessionId: wire.id,
        name: wire.name,
        scope,
        cap,
        spent,
        locked,
        action: this._settings.action,
        at: now,
      };
      this._remember(info);
      this.log.warn(
        `[budget] ${wire.name} reached the ${scope} cap ($${spent.toFixed(2)} of $${cap.toFixed(2)})`
        + (locked ? ', session locked' : ', not locked'),
      );
      this.emit('breach', info);
      this.emit('state', this.state(now));
      return info;
    }

    // One warning per session per run. A cap crossed repeatedly by rounding is
    // not news, and an alert nobody can act on twice is noise.
    const ratio = sessionCap > 0 ? cost / sessionCap : (dailyCap > 0 ? dayTotal / dailyCap : 0);
    if (ratio >= WARN_RATIO && !this._warned.has(wire.id)) {
      this._warned.add(wire.id);
      const info = {
        sessionId: wire.id,
        name: wire.name,
        scope: sessionCap > 0 ? 'session' : 'daily',
        cap: sessionCap > 0 ? sessionCap : dailyCap,
        spent: sessionCap > 0 ? cost : dayTotal,
        ratio,
        at: now,
      };
      this.emit('warning', info);
      this.emit('state', this.state(now));
      return info;
    }

    this.emit('state', this.state(now));
    return null;
  }

  /**
   * The cap for one session: the global one, or the repository's own if its
   * committed policy asks for something stricter. A policy may tighten a cap
   * and never loosen it, which is what makes the file worth committing.
   */
  /** The cap actually applied to a session, once a manual unlock is counted. */
  effectiveCap(wire) {
    const base = this.capFor(wire);
    if (!base) return 0;
    const raised = this._ceiling.get(wire.id);
    return raised ? Math.max(base, raised) : base;
  }

  capFor(wire) {
    const global = this._settings.sessionCap;
    const fromPolicy = this.policy && wire && wire.cwd ? this.policy.budgetForCwd(wire.cwd) : null;
    if (fromPolicy === null || fromPolicy === undefined) return global;
    if (!global) return fromPolicy;
    return Math.min(global, fromPolicy);
  }

  _lock(sessionId) {
    const session = this.sessions.get(sessionId);
    if (!session || session.status === STATUS.EXITED) return false;
    if (session.locked) return true;
    this.sessions.setMeta(sessionId, { locked: true });
    return true;
  }

  /**
   * Lifts a lock this guard applied, and forgives the session so it is not
   * immediately locked again by the next hook event carrying the same total.
   */
  release(sessionId) {
    const session = this.sessions.get(sessionId);
    if (!session) return { ok: false, error: 'unknown session' };

    // Raise both ceilings it could have tripped, from where it actually stands
    // rather than from zero: the session is already past the cap, so an
    // increment measured from the cap would leave it breached on release.
    const cap = this.capFor(session);
    const spent = Number((this.ledger[dayKey()] || {})[sessionId]) || 0;
    if (cap > 0) this._ceiling.set(sessionId, spent + cap);
    if (this._settings.dailyCap > 0) {
      this._dailyCeiling = this.todayTotal() + this._settings.dailyCap;
    }

    this._breached.delete(sessionId);
    this._warned.delete(sessionId);
    if (session.locked) this.sessions.setMeta(sessionId, { locked: false });
    this.emit('state', this.state());
    return { ok: true, newCap: cap > 0 ? spent + cap : null };
  }

  todayTotal(now = Date.now()) {
    const today = this.ledger[dayKey(now)];
    if (!today) return 0;
    let total = 0;
    for (const value of Object.values(today)) total += Number(value) || 0;
    return total;
  }

  /** @returns {{settings:Object, today:Object, breaches:Object[]}} */
  state(now = Date.now()) {
    const day = dayKey(now);
    const today = this.ledger[day] || {};
    const bySession = [];
    for (const [id, cost] of Object.entries(today)) {
      const session = this.sessions.get(id);
      bySession.push({
        sessionId: id,
        name: session ? session.name : null,
        live: !!session && session.status !== STATUS.EXITED,
        locked: !!(session && session.locked),
        cost: Number(cost) || 0,
        cap: session ? this.effectiveCap(session) : this._settings.sessionCap,
        // Flagged so the panel can say a cap was raised by hand rather than
        // silently showing a number nobody configured.
        raised: this._ceiling.has(id),
      });
    }
    bySession.sort((a, b) => b.cost - a.cost);

    return {
      settings: this.settings(),
      today: { day, total: this.todayTotal(now), bySession },
      breaches: this._events.slice(0, 20),
    };
  }

  /** Per-day totals, oldest first, for the digest and any future chart. */
  history() {
    return Object.keys(this.ledger)
      .sort()
      .map(day => {
        let total = 0;
        for (const value of Object.values(this.ledger[day])) total += Number(value) || 0;
        return { day, total };
      });
  }

  _remember(info) {
    this._events.unshift(info);
    if (this._events.length > 50) this._events.length = 50;
  }

  _scheduleSave() {
    if (this._saveTimer) return;
    this._saveTimer = setTimeout(() => {
      this._saveTimer = null;
      this._persist();
    }, SAVE_DEBOUNCE_MS);
    if (this._saveTimer.unref) this._saveTimer.unref();
  }

  _defaults() {
    const c = this.config;
    return {
      enabled: !!c.budgetEnabled,
      sessionCap: clampNumber(c.budgetSessionCap, BOUNDS.sessionCap, 0),
      dailyCap: clampNumber(c.budgetDailyCap, BOUNDS.dailyCap, 0),
      action: ACTIONS.has(c.budgetAction) ? c.budgetAction : 'lock',
    };
  }

  _load() {
    const defaults = { settings: this._defaults(), ledger: {} };
    if (!this.file) return defaults;
    let raw;
    try {
      raw = fs.readFileSync(this.file, 'utf-8');
    } catch (err) {
      if (err.code !== 'ENOENT') this.log.warn(`[budget] cannot read ${this.file}: ${err.message}`);
      return defaults;
    }
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      this.log.warn(`[budget] ${this.file} is not valid JSON (${err.message}), using defaults`);
      return defaults;
    }
    if (!parsed || typeof parsed !== 'object') return defaults;

    const settings = { ...defaults.settings };
    const s = parsed.settings && typeof parsed.settings === 'object' ? parsed.settings : {};
    if (typeof s.enabled === 'boolean') settings.enabled = s.enabled;
    if (ACTIONS.has(s.action)) settings.action = s.action;
    for (const key of Object.keys(BOUNDS)) {
      if (s[key] !== undefined) settings[key] = clampNumber(s[key], BOUNDS[key], defaults.settings[key]);
    }

    const ledger = {};
    const rawLedger = parsed.ledger && typeof parsed.ledger === 'object' ? parsed.ledger : {};
    for (const day of Object.keys(rawLedger).sort().slice(-LEDGER_DAYS)) {
      const entry = rawLedger[day];
      if (!entry || typeof entry !== 'object') continue;
      const clean = {};
      for (const [id, value] of Object.entries(entry)) {
        const n = Number(value);
        if (Number.isFinite(n) && n >= 0) clean[id] = n;
      }
      ledger[day] = clean;
    }
    return { settings, ledger };
  }

  _persist() {
    if (!this.file) return;
    // Trim before writing rather than on read, so the file does not grow
    // forever on a machine that is never restarted.
    const days = Object.keys(this.ledger).sort();
    for (const day of days.slice(0, Math.max(0, days.length - LEDGER_DAYS))) {
      delete this.ledger[day];
    }
    try {
      writeJsonAtomic(this.file, { settings: this._settings, ledger: this.ledger });
    } catch (err) {
      this.log.warn(`[budget] could not save ${this.file}: ${err.message}`);
    }
  }
}

module.exports = { BudgetGuard, dayKey, WARN_RATIO, LEDGER_DAYS, BOUNDS };
