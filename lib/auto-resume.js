'use strict';

const { EventEmitter } = require('events');
const fs = require('fs');

const defaultConfig = require('./config');
const { STATUS, KIND } = require('./protocol');
const { detectQuotaLimit, appendTail } = require('./quota-limit');

/**
 * Waking a session back up when the quota that blocked it comes back.
 *
 * The problem this solves is a scheduling one, not a technical one: the five
 * hour window resets at an hour nobody chose, frequently overnight, and an
 * agent that was cut off mid task sits at an idle prompt until a human happens
 * to return. The work is done, the quota is back, and nothing connects the two.
 *
 * The whole feature is one prompt typed into a terminal at the right moment,
 * which is also why most of this file is refusals. Typing into a live shell is
 * the same class of action as the argument policy in lib/args-policy.js, so the
 * defaults are closed: off unless switched on, Claude sessions only, never over
 * a pending permission prompt, never into a session that is still producing
 * output, and never more than a handful of times before it gives up and leaves
 * the session alone.
 *
 * @fires AutoResume#plans    the full plan list, whenever any of it changes
 * @fires AutoResume#resumed  a session that was actually sent its prompt
 */

/** Wall clock sweep. Not setTimeout: a laptop that slept through the reset
 *  would otherwise wake with a timer that fires hours late, or not at all. */
const TICK_MS = 5000;

/** Above this the statusLine snapshot still reports the window as exhausted. */
const BLOCKED_PERCENT = 99;

/** Quiet time after the last byte before a session counts as settled. */
const QUIET_MS = 10 * 1000;

/** With no reset time from anywhere, look again this often. */
const BLIND_RETRY_MS = 15 * 60 * 1000;

/**
 * How long a cancelled session is left alone before a fresh block can arm it
 * again. Cancelling means "not this one", not "never again": a session running
 * for days will hit the limit more than once. The delay only has to outlast the
 * TUI redrawing the banner it was just cancelled on.
 */
const CANCEL_COOLDOWN_MS = 5 * 60 * 1000;

/** Plans kept at once. A plan is one blocked session, so this is generous. */
const MAX_PLANS = 64;

/** Longest resume prompt accepted, and the ceiling the UI validates against. */
const MAX_TEXT = 500;

const SETTING_BOUNDS = {
  graceSeconds: [0, 3600],
  staggerSeconds: [0, 900],
  maxAttempts: [1, 10],
  waitForIdleSeconds: [30, 7200],
};

const STATE = {
  /** Reset time known, waiting for it. */
  ARMED: 'armed',
  /** Reset time reached, holding for the session to be safe to type into. */
  WAITING: 'waiting',
  /** Prompt delivered. */
  SENT: 'sent',
  /** Gave up: too many attempts, or the session never became safe. */
  EXPIRED: 'expired',
  /** A human cancelled it. */
  CANCELLED: 'cancelled',
};

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

function clampInt(value, [min, max], fallback) {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

/**
 * Reduces a configured prompt to one line of printable text.
 *
 * A carriage return inside the text would submit halfway through and leave the
 * rest to be read as a second prompt; an escape sequence would be interpreted
 * by the TUI rather than typed. Both are far more likely to be a paste accident
 * than an intention, so they are flattened rather than rejected.
 *
 * @returns {string|null} null when nothing printable survives
 */
function sanitizeResumeText(value) {
  if (typeof value !== 'string') return null;
  const clean = value
    .split('')
    .map(ch => (ch.charCodeAt(0) < 32 || ch.charCodeAt(0) === 127 ? ' ' : ch))
    .join('')
    .replace(/\s+/g, ' ')
    .trim();
  return clean ? clean.slice(0, MAX_TEXT) : null;
}

/** Atomic, and 0600: the file holds a string this server will type into a shell. */
function writeJsonAtomic(file, data) {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, { encoding: 'utf-8', mode: 0o600 });
  fs.renameSync(tmp, file);
}

class AutoResume extends EventEmitter {
  /**
   * @param {Object} deps
   * @param {import('./session-manager').SessionManager} deps.sessions
   * @param {import('./usage').UsageTracker} [deps.usage] quota cross check
   * @param {Object} [deps.config] defaults to lib/config
   * @param {Object} [deps.logger]
   */
  constructor({ sessions, usage, config, logger } = {}) {
    super();
    if (!sessions) throw new Error('AutoResume requires a SessionManager');
    this.sessions = sessions;
    this.usage = usage || null;
    this.config = config || defaultConfig;
    this.log = makeLogger(logger);

    this.file = this.config.autoResumeFile;

    /** @type {Map<string, Object>} sessionId -> plan */
    this._plans = new Map();
    /** @type {Map<string, string>} sessionId -> rolling output tail */
    this._tails = new Map();
    /** @type {Map<string, number>} sessionId -> epoch ms of last PTY byte */
    this._lastOutput = new Map();

    this._settings = this._load();
    this._timer = null;
    this._ticking = false;
    this._lastFiredAt = 0;
    this._started = false;

    this._onClosed = ({ id }) => this.forget(id);
    this._onExit = ({ id }) => this.forget(id);
  }

  /** Starts the sweep. Safe to call twice. */
  start() {
    this._started = true;
    if (this._timer) return this;
    this._timer = setInterval(() => {
      this.tick().catch(err => this.log.error(`auto-resume: sweep failed: ${err.message}`));
    }, TICK_MS);
    if (this._timer.unref) this._timer.unref();
    this.sessions.on('closed', this._onClosed);
    this.sessions.on('exit', this._onExit);
    return this;
  }

  stop() {
    this._started = false;
    if (this._timer) {
      clearInterval(this._timer);
      this._timer = null;
    }
    this.sessions.removeListener('closed', this._onClosed);
    this.sessions.removeListener('exit', this._onExit);
  }

  settings() {
    return { ...this._settings };
  }

  /**
   * Applies a settings patch and persists it. Unknown keys are ignored and
   * every number is clamped, so a hand edited file cannot arm a resume every
   * second or hold a session for a week.
   *
   * @returns {{settings: Object, error: string|null}}
   */
  updateSettings(patch = {}) {
    const next = { ...this._settings };

    // All or nothing. A patch that sets the toggle and the prompt together is
    // one decision, and applying the half that parsed would leave auto resume
    // armed by a request the server had just rejected.
    if (patch.text !== undefined) {
      const text = sanitizeResumeText(patch.text);
      if (!text) {
        return { settings: this.settings(), error: 'the resume prompt cannot be empty' };
      }
      next.text = text;
    }

    if (patch.enabled !== undefined) next.enabled = !!patch.enabled;

    for (const key of Object.keys(SETTING_BOUNDS)) {
      if (patch[key] !== undefined) {
        next[key] = clampInt(patch[key], SETTING_BOUNDS[key], this._settings[key]);
      }
    }

    // Switching on with no usable prompt would arm plans that can never fire.
    if (next.enabled && !sanitizeResumeText(next.text)) {
      return { settings: this.settings(), error: 'set a resume prompt before turning this on' };
    }

    this._settings = next;
    this._persist();
    this._changed();
    return { settings: this.settings(), error: null };
  }

  /** Every plan, newest first, in the shape the browser renders. */
  plans() {
    return [...this._plans.values()]
      .sort((a, b) => b.detectedAt - a.detectedAt)
      .map(plan => ({ ...plan }));
  }

  /** What the ready payload and GET /api/auto-resume both answer with. */
  snapshot() {
    return { settings: this.settings(), plans: this.plans() };
  }

  /**
   * Feeds one chunk of PTY output through the detector.
   *
   * Called for every session on every flush, so the cheap rejections come
   * first: a plain shell can print whatever it likes about usage limits and
   * will never be typed into.
   *
   * @param {string} sessionId
   * @param {string} chunk  raw PTY output
   * @param {number} [now]  injected clock, shared with tick()
   */
  noteOutput(sessionId, chunk, now = Date.now()) {
    if (typeof sessionId !== 'string' || typeof chunk !== 'string' || !chunk) return null;
    const session = this.sessions.get(sessionId);
    if (!session || session.kind !== KIND.CLAUDE) return null;

    // The caller's clock, not ours: _unsafeReason compares this against the
    // time tick() was given, and two clocks there means the quiet window is
    // measured against a number it has no relation to.
    this._lastOutput.set(sessionId, now);

    const tail = appendTail(this._tails.get(sessionId) || '', chunk);
    this._tails.set(sessionId, tail);

    const hit = detectQuotaLimit(tail, now);
    if (!hit) return null;

    // The TUI redraws the same banner on every render. Dropping the tail means
    // one block produces one plan rather than one per frame.
    this._tails.set(sessionId, '');
    return this._arm(session, hit, now);
  }

  /**
   * Records, or refreshes, the plan for a blocked session.
   * An existing plan keeps its attempt count: the same block being redrawn is
   * not a new block, and resetting the counter would defeat the attempt cap.
   */
  _arm(session, hit, now) {
    const existing = this._plans.get(session.id);
    const grace = this._settings.graceSeconds * 1000;

    if (existing && (existing.state === STATE.ARMED || existing.state === STATE.WAITING)) {
      if (hit.resetsAt && hit.resetsAt !== existing.resetsAt) {
        existing.resetsAt = hit.resetsAt;
        existing.resetsText = hit.resetsText;
        existing.dueAt = hit.resetsAt + grace;
        this._changed();
      }
      return existing;
    }

    // A cancel applies to the block it was pressed on. Past the cooldown this
    // is a new block hours later, and refusing it forever would quietly turn
    // one click into an opt-out nobody asked for.
    if (existing && existing.state === STATE.CANCELLED) {
      const since = now - (existing.cancelledAt || existing.detectedAt);
      if (since < CANCEL_COOLDOWN_MS) return existing;
    }

    if (this._plans.size >= MAX_PLANS && !existing) {
      this._evictOldest();
    }

    const plan = {
      sessionId: session.id,
      name: session.name,
      cwd: session.cwd,
      detectedAt: now,
      window: hit.window,
      resetsAt: hit.resetsAt,
      resetsText: hit.resetsText,
      dueAt: hit.resetsAt === null ? null : hit.resetsAt + grace,
      state: STATE.ARMED,
      // A block that survived a cancel and the cooldown starts its own budget.
      attempts: (existing && existing.state !== STATE.CANCELLED) ? existing.attempts : 0,
      lastSentAt: existing ? existing.lastSentAt : null,
      waitingSince: null,
      lastError: null,
      matched: hit.matched,
    };
    this._plans.set(session.id, plan);
    this.log.info(
      `auto-resume: ${session.name} hit a quota limit`
      + (plan.resetsText ? `, resets ${plan.resetsText}` : ', reset time unknown'),
    );
    this._changed();
    return plan;
  }

  /**
   * One sweep: resolve missing reset times, then fire whatever is due.
   *
   * Firing is deliberately at most one plan per sweep. Six agents released at
   * the same instant re-consume the window they were just given and block again
   * together, which is the failure this feature would otherwise automate.
   */
  async tick(now = Date.now()) {
    if (this._ticking) return [];
    this._ticking = true;
    try {
      const fired = [];
      let dirty = false;

      const live = [...this._plans.values()].filter(
        plan => plan.state === STATE.ARMED || plan.state === STATE.WAITING,
      );
      if (!live.length) return fired;

      for (const plan of live) {
        if (!this.sessions.get(plan.sessionId)) {
          this._plans.delete(plan.sessionId);
          dirty = true;
        }
      }

      if (!this._settings.enabled) {
        if (dirty) this._changed();
        return fired;
      }

      // Resolve any plan that never learned its reset time before sorting, so
      // an unresolved one cannot jump the queue with a null dueAt.
      for (const plan of live) {
        if (plan.dueAt === null && this._plans.has(plan.sessionId)) {
          dirty = (await this._resolveDue(plan, now)) || dirty;
        }
      }

      const due = live
        .filter(plan => this._plans.has(plan.sessionId) && plan.dueAt !== null && plan.dueAt <= now)
        .sort((a, b) => a.dueAt - b.dueAt);

      const stagger = this._settings.staggerSeconds * 1000;
      for (const plan of due) {
        if (stagger > 0 && this._lastFiredAt && now - this._lastFiredAt < stagger) break;
        const outcome = await this._fire(plan, now);
        if (outcome.changed) dirty = true;
        if (outcome.sent) {
          this._lastFiredAt = now;
          fired.push(plan.sessionId);
          break;
        }
      }

      if (dirty) this._changed();
      return fired;
    } finally {
      this._ticking = false;
    }
  }

  /**
   * Fills in a reset time the banner did not carry, from the statusLine
   * snapshot. When neither knows, the plan is retried blind on a slow loop
   * rather than dropped: the quota does come back, we simply cannot say when.
   *
   * @returns {Promise<boolean>} whether the plan changed
   */
  async _resolveDue(plan, now) {
    const grace = this._settings.graceSeconds * 1000;
    const quota = await this._quota();

    if (quota) {
      const keys = plan.window ? [plan.window] : ['five_hour', 'seven_day', 'extra'];
      for (const key of keys) {
        const win = quota[key];
        if (win && typeof win.resetsAt === 'number' && win.resetsAt > plan.detectedAt) {
          plan.resetsAt = win.resetsAt;
          plan.resetsText = plan.resetsText || win.resetsText;
          plan.dueAt = win.resetsAt + grace;
          return true;
        }
      }
    }

    plan.dueAt = plan.detectedAt + BLIND_RETRY_MS;
    plan.lastError = 'no reset time reported, retrying periodically';
    return true;
  }

  /**
   * Everything that has to be true before Orchestra types into a terminal.
   *
   * @returns {Promise<{sent: boolean, changed: boolean}>}
   */
  async _fire(plan, now) {
    const session = this.sessions.get(plan.sessionId);
    if (!session || session.status === STATUS.EXITED) {
      this._plans.delete(plan.sessionId);
      return { sent: false, changed: true };
    }

    const text = sanitizeResumeText(this._settings.text);
    if (!text) {
      plan.state = STATE.EXPIRED;
      plan.lastError = 'no resume prompt is configured';
      return { sent: false, changed: true };
    }

    if (plan.attempts >= this._settings.maxAttempts) {
      plan.state = STATE.EXPIRED;
      plan.lastError = `gave up after ${plan.attempts} attempt(s)`;
      this.log.warn(`auto-resume: ${session.name} still blocked after ${plan.attempts} attempts, leaving it alone`);
      return { sent: false, changed: true };
    }

    const unsafe = this._unsafeReason(session, now);
    if (unsafe) {
      if (plan.state !== STATE.WAITING) {
        plan.state = STATE.WAITING;
        plan.waitingSince = now;
      }
      plan.lastError = unsafe;
      const waited = now - (plan.waitingSince || now);
      if (waited > this._settings.waitForIdleSeconds * 1000) {
        plan.state = STATE.EXPIRED;
        plan.lastError = `never became safe to resume (${unsafe})`;
        this.log.warn(`auto-resume: giving up on ${session.name}: ${unsafe}`);
      }
      return { sent: false, changed: true };
    }

    // Last word goes to the account, not to the banner we matched. A window
    // still at 100% means the reset has not landed yet whatever the clock says.
    const blocked = await this._stillBlocked(plan);
    if (blocked.blocked) {
      plan.dueAt = (blocked.resetsAt && blocked.resetsAt > now)
        ? blocked.resetsAt + this._settings.graceSeconds * 1000
        : now + BLIND_RETRY_MS;
      plan.resetsAt = blocked.resetsAt || plan.resetsAt;
      plan.state = STATE.ARMED;
      plan.lastError = 'quota still reports the window as exhausted';
      return { sent: false, changed: true };
    }

    const ok = this.sessions.write(plan.sessionId, `${text}\r`);
    if (!ok) {
      plan.state = STATE.WAITING;
      plan.lastError = 'the session refused the write (locked, or no live terminal)';
      return { sent: false, changed: true };
    }

    plan.attempts += 1;
    plan.state = STATE.SENT;
    plan.lastSentAt = now;
    plan.lastError = null;
    plan.sentText = text;
    this.log.info(`auto-resume: resumed ${session.name} with ${JSON.stringify(text)}`);
    this.emit('resumed', {
      sessionId: plan.sessionId,
      name: session.name,
      text,
      attempt: plan.attempts,
      at: now,
    });
    return { sent: true, changed: true };
  }

  /**
   * Why this session must not be typed into right now, or null when it is fine.
   *
   * The permission check is the sharp one. A pending approval prompt reads the
   * next line as a menu choice, so a resume prompt arriving there would answer
   * a permission question on the user's behalf, which is the one thing this
   * whole product exists to keep in human hands.
   */
  _unsafeReason(session, now) {
    if (session.locked) return 'the session is locked';
    if (session.status === STATUS.AWAITING_PERMISSION) return 'a permission prompt is waiting for a human';
    if (session.status === STATUS.STARTING) return 'the session is still starting';

    // Trusting the hook status alone is not enough: a turn killed mid tool
    // never emits Stop, so a genuinely dead session can sit at busy forever.
    // Silence on the PTY is the signal that actually correlates with a prompt.
    const last = this._lastOutput.get(session.id);
    if (last && now - last < QUIET_MS) return 'the session is still producing output';
    return null;
  }

  /** @returns {Promise<{blocked: boolean, resetsAt: number|null}>} */
  async _stillBlocked(plan) {
    const quota = await this._quota();
    // No snapshot is not evidence of a block. The statusLine hook only runs
    // while a session renders one, so a set of blocked agents stops refreshing
    // it exactly when this would consult it.
    if (!quota) return { blocked: false, resetsAt: null };

    const keys = plan.window ? [plan.window] : ['five_hour', 'seven_day', 'extra'];
    for (const key of keys) {
      const win = quota[key];
      if (!win) continue;
      if (typeof win.usedPercentage === 'number' && win.usedPercentage >= BLOCKED_PERCENT) {
        return { blocked: true, resetsAt: win.resetsAt };
      }
    }
    return { blocked: false, resetsAt: null };
  }

  async _quota() {
    if (!this.usage) return null;
    try {
      const snapshot = await this.usage.read();
      return snapshot && snapshot.quota ? snapshot.quota : null;
    } catch (err) {
      this.log.warn(`auto-resume: could not read the quota snapshot: ${err.message}`);
      return null;
    }
  }

  /**
   * Sends the prompt now, skipping the clock but not the safety checks.
   * This is the button a human presses when they are back at the keyboard.
   */
  async resumeNow(sessionId, now = Date.now()) {
    const plan = this._plans.get(sessionId);
    const session = this.sessions.get(sessionId);
    if (!session) return { ok: false, error: 'unknown session' };
    if (session.kind !== KIND.CLAUDE) return { ok: false, error: 'not a Claude session' };

    const target = plan || this._arm(session, {
      window: null,
      resetsAt: null,
      resetsText: null,
      matched: 'resumed by hand',
    }, now);

    // A manual resume is a decision, so the attempt cap and the clock do not
    // apply to it; the permission and quiet checks inside _fire still do.
    target.state = STATE.ARMED;
    target.attempts = 0;
    target.dueAt = now;
    const outcome = await this._fire(target, now);
    this._changed();
    return outcome.sent
      ? { ok: true, plan: { ...target } }
      : { ok: false, error: target.lastError || 'the session was not ready' };
  }

  /** Drops a plan without acting on it. `now` shares the caller's clock. */
  cancel(sessionId, now = Date.now()) {
    const plan = this._plans.get(sessionId);
    if (!plan) return { ok: false, error: 'no plan for that session' };
    plan.state = STATE.CANCELLED;
    plan.cancelledAt = now;
    plan.lastError = null;
    this._changed();
    return { ok: true, plan: { ...plan } };
  }

  /** Forgets everything about a session that is gone. */
  forget(sessionId) {
    this._tails.delete(sessionId);
    this._lastOutput.delete(sessionId);
    if (this._plans.delete(sessionId)) this._changed();
  }

  _evictOldest() {
    let oldest = null;
    for (const plan of this._plans.values()) {
      if (plan.state === STATE.ARMED || plan.state === STATE.WAITING) continue;
      if (!oldest || plan.detectedAt < oldest.detectedAt) oldest = plan;
    }
    if (oldest) this._plans.delete(oldest.sessionId);
  }

  _changed() {
    this.emit('plans', this.plans());
  }

  _defaults() {
    const c = this.config;
    return {
      enabled: !!c.autoResume,
      text: sanitizeResumeText(c.autoResumeText) || 'continue',
      graceSeconds: clampInt(c.autoResumeGraceSeconds, SETTING_BOUNDS.graceSeconds, 60),
      staggerSeconds: clampInt(c.autoResumeStaggerSeconds, SETTING_BOUNDS.staggerSeconds, 30),
      maxAttempts: clampInt(c.autoResumeMaxAttempts, SETTING_BOUNDS.maxAttempts, 3),
      waitForIdleSeconds: clampInt(c.autoResumeWaitSeconds, SETTING_BOUNDS.waitForIdleSeconds, 600),
    };
  }

  /**
   * Environment first, then the file the UI writes. A malformed file falls back
   * to the defaults rather than throwing: this runs during server construction,
   * and a bad preference must not stop every agent from starting.
   */
  _load() {
    const defaults = this._defaults();
    if (!this.file) return defaults;
    let raw;
    try {
      raw = fs.readFileSync(this.file, 'utf-8');
    } catch (err) {
      if (err.code !== 'ENOENT') {
        this.log.warn(`auto-resume: cannot read ${this.file}: ${err.message}`);
      }
      return defaults;
    }
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      this.log.warn(`auto-resume: ${this.file} is not valid JSON (${err.message}), using defaults`);
      return defaults;
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return defaults;

    const out = { ...defaults };
    if (typeof parsed.enabled === 'boolean') out.enabled = parsed.enabled;
    const text = sanitizeResumeText(parsed.text);
    if (text) out.text = text;
    for (const key of Object.keys(SETTING_BOUNDS)) {
      if (parsed[key] !== undefined) {
        out[key] = clampInt(parsed[key], SETTING_BOUNDS[key], defaults[key]);
      }
    }
    return out;
  }

  _persist() {
    if (!this.file) return;
    try {
      writeJsonAtomic(this.file, this._settings);
    } catch (err) {
      this.log.warn(`auto-resume: could not save ${this.file}: ${err.message}`);
    }
  }
}

module.exports = {
  AutoResume,
  sanitizeResumeText,
  STATE,
  TICK_MS,
  QUIET_MS,
  BLOCKED_PERCENT,
  BLIND_RETRY_MS,
  CANCEL_COOLDOWN_MS,
  MAX_TEXT,
  SETTING_BOUNDS,
};
