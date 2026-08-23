/**
 * Desktop notifications driven by hook events.
 *
 * Nothing here looks at terminal output: a quiet PTY means a pause for thought
 * as often as a finished turn, so an agent is announced as done only when
 * Claude Code says so through the Stop hook.
 *
 * Everything is read off the store's own channels: "events" for hook events,
 * "approvals" for blocked tool calls, "sessions" for exits, and "stalled" for
 * the server's stall detector once the shell bridges it.
 */

import { HOOK_EVENT, STATUS } from './protocol.js';

/** Why a notification was raised. Exported so callers can filter or test. */
export const NOTIFY_REASON = {
  TURN_DONE: 'turn-done',
  QUESTION: 'question',
  PERMISSION: 'permission',
  EXITED: 'exited',
  STALLED: 'stalled',
};

/** Minimum delay between two *alerting* notifications for the same session. */
const GROUP_WINDOW_MS = 10000;

/** Name the hook bus uses for a stall pushed through the event channel. */
const STALLED_EVENT = 'Stalled';

const MAX_TITLE = 90;
const MAX_BODY = 180;

const ICON = '/favicon.svg';

function oneLine(value, max) {
  if (value === undefined || value === null) return '';
  const text = String(value).replace(/\s+/g, ' ').trim();
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(0, max - 1))}...`;
}

function makeLogger(logger) {
  const c = typeof console !== 'undefined' ? console : null;
  const bind = (name) => {
    if (logger && typeof logger[name] === 'function') return logger[name].bind(logger);
    if (c && typeof c[name] === 'function') return c[name].bind(c);
    return () => {};
  };
  return { debug: bind('debug'), info: bind('info'), warn: bind('warn'), error: bind('error') };
}

export class Notifications {
  /**
   * @param {object} store  the app Store: `on`/`off`, `getPref`, `getSession`, `setActive`
   * @param {{window?: Window, logger?: object, groupWindowMs?: number}} [deps]
   */
  constructor(store, deps = {}) {
    if (!store) throw new Error('Notifications requires a store');
    this.store = store;
    this.log = makeLogger(deps.logger);
    this.win = deps.window || (typeof window !== 'undefined' ? window : null);
    this.doc = this.win ? this.win.document : null;
    this.groupWindowMs = Number.isFinite(deps.groupWindowMs) ? deps.groupWindowMs : GROUP_WINDOW_MS;

    this.supported = !!(this.win && typeof this.win.Notification === 'function');

    /** @type {Map<string, {lastAlertAt:number, notification:Notification|null, reason:string|null}>} */
    this.perSession = new Map();
    /** Ids of approvals already announced, so a resend of the list is quiet. */
    this._seenApprovals = new Set();
    /** id -> last seen status, to spot the transition into `exited`. */
    this._lastStatus = new Map();
    this._unsubs = [];
    this._started = false;
    this._permissionPending = null;
    /** Set when a browser refuses notifications, so the UI can say why. */
    this.lastError = null;
  }

  start() {
    if (this._started) return this;
    this._started = true;

    this._sub('events', (payload) => {
      if (payload && payload.event) this._onHookEvent(payload.event);
    });
    this._sub('approvals', (payload) => this._onApprovals(payload));
    this._sub('sessions', (payload) => this._onSessions(payload));
    // The server's hook bus emits "stalled" on its own channel. Whatever wires
    // the socket to the store forwards it here; until then the Stalled event
    // name on the "events" channel does the same job.
    this._sub('stalled', (info) => this._onStalled(info));
    return this;
  }

  stop() {
    if (!this._started) return;
    this._started = false;
    for (const off of this._unsubs) {
      try {
        off();
      } catch (e) {
        this.log.warn(`notifications: unsubscribe failed: ${e && e.message}`);
      }
    }
    this._unsubs = [];
    this.closeAll();
  }

  destroy() {
    this.stop();
    this.perSession.clear();
    this._seenApprovals.clear();
    this._lastStatus.clear();
  }

  _sub(name, handler) {
    const store = this.store;
    if (typeof store.on !== 'function') {
      throw new Error('Notifications requires store.on(event, handler)');
    }
    const wrapped = (payload) => {
      try {
        handler(payload);
      } catch (e) {
        this.log.error(`notifications: handler for "${name}" threw: ${e && e.message}`);
      }
    };
    const off = store.on(name, wrapped);
    if (typeof off === 'function') {
      this._unsubs.push(off);
    } else if (typeof store.off === 'function') {
      this._unsubs.push(() => store.off(name, wrapped));
    } else {
      this.log.warn(`notifications: store.on("${name}") returned no unsubscribe and store.off is missing`);
    }
  }

  _onHookEvent(ev) {
    if (!ev || !ev.sessionId) return;

    if (ev.event === HOOK_EVENT.STOP) {
      this.notify({
        sessionId: ev.sessionId,
        reason: NOTIFY_REASON.TURN_DONE,
        title: `${this._sessionName(ev.sessionId)} finished its turn`,
        body: oneLine(ev.detail || ev.message, MAX_BODY) || 'Waiting for your next prompt.',
      });
      return;
    }

    if (ev.event === HOOK_EVENT.NOTIFICATION) {
      this.notify({
        sessionId: ev.sessionId,
        reason: NOTIFY_REASON.QUESTION,
        title: `${this._sessionName(ev.sessionId)} needs an answer`,
        body: oneLine(ev.message || ev.detail, MAX_BODY) || 'The agent is waiting on you.',
      });
      return;
    }

    if (ev.event === STALLED_EVENT) {
      this._onStalled({
        sessionId: ev.sessionId,
        name: null,
        reason: ev.status || null,
        detail: ev.detail || ev.message || null,
        elapsedMs: ev.durationMs || 0,
      });
    }
  }

  _onApprovals(payload) {
    const pending = payload && Array.isArray(payload.pending) ? payload.pending : [];
    const live = new Set();
    for (const entry of pending) {
      if (!entry || !entry.id) continue;
      live.add(entry.id);
      if (this._seenApprovals.has(entry.id)) continue;
      this._seenApprovals.add(entry.id);
      if (!entry.sessionId) continue;
      this.notify({
        sessionId: entry.sessionId,
        reason: NOTIFY_REASON.PERMISSION,
        title: `${entry.sessionName || this._sessionName(entry.sessionId)} wants permission`,
        body: oneLine(entry.summary || entry.detail || entry.tool, MAX_BODY) || 'A tool call is blocked.',
        // A blocked agent is frozen until a human answers, so this one must not
        // auto dismiss on platforms that honour the flag.
        requireInteraction: true,
      });
    }

    for (const id of [...this._seenApprovals]) {
      if (live.has(id)) continue;
      this._seenApprovals.delete(id);
    }
    // A permission notification that no longer has a pending request behind it
    // is stale: nothing is blocked any more.
    if (!pending.length) {
      for (const [key, state] of this.perSession) {
        if (state.reason === NOTIFY_REASON.PERMISSION) this._close(key);
      }
    }
  }

  _onSessions(payload) {
    const list = payload && Array.isArray(payload.sessions)
      ? payload.sessions
      : (Array.isArray(payload) ? payload : null);
    if (!list) return;

    const seen = new Set();
    for (const session of list) {
      if (!session || !session.id) continue;
      seen.add(session.id);
      const previous = this._lastStatus.get(session.id);
      this._lastStatus.set(session.id, session.status);
      if (previous === undefined) continue;
      if (previous !== STATUS.EXITED && session.status === STATUS.EXITED) {
        const code = session.exitCode;
        const clean = code === 0 || code === null || code === undefined;
        this.notify({
          sessionId: session.id,
          reason: NOTIFY_REASON.EXITED,
          title: `${session.name || this._sessionName(session.id)} exited`,
          body: clean ? 'The process ended.' : `The process ended with code ${code}.`,
        });
      }
    }

    for (const id of [...this._lastStatus.keys()]) {
      if (!seen.has(id)) {
        this._lastStatus.delete(id);
        this._forget(id);
      }
    }
  }

  _onStalled(info) {
    if (!info || !info.sessionId) return;
    const minutes = Math.max(1, Math.round((info.elapsedMs || 0) / 60000));
    this.notify({
      sessionId: info.sessionId,
      reason: NOTIFY_REASON.STALLED,
      title: `${info.name || this._sessionName(info.sessionId)} looks stuck`,
      body: oneLine(info.detail, MAX_BODY) || `No progress for ${minutes} min (${info.reason || 'unknown'}).`,
    });
  }

  /** True when the browser window itself has focus, multi monitor included. */
  _hasFocus() {
    // document.hidden stays false when the tab is visible on a second screen
    // but the window is not focused, which is exactly the case that matters.
    if (!this.doc || typeof this.doc.hasFocus !== 'function') return false;
    return this.doc.hasFocus();
  }

  _enabled() {
    const store = this.store;
    if (typeof store.getPref === 'function') return store.getPref('notifications', true) !== false;
    return true;
  }

  /**
   * The only way a notification is ever shown. Also the settings panel's test
   * button, which passes `force` to bypass the preference and focus checks.
   *
   * @param {{sessionId?:string, reason?:string, title:string, body?:string,
   *          requireInteraction?:boolean, force?:boolean}} spec
   * @returns {Promise<boolean>} whether a notification was shown
   */
  async notify(spec) {
    if (!spec || !spec.title) return false;
    if (!this.supported) {
      this.lastError = 'This browser has no Notification API.';
      return false;
    }
    if (!spec.force) {
      if (!this._enabled()) return false;
      if (this._hasFocus()) return false;
    }

    const granted = await this._ensurePermission();
    if (!granted) return false;

    const key = spec.sessionId || 'orchestra';
    const now = Date.now();
    const prev = this.perSession.get(key);
    // The same tag replaces the visible notification instead of stacking. Inside
    // the grouping window the replacement is silent, so the content updates
    // without alerting a second time.
    const silent = !!prev && now - prev.lastAlertAt < this.groupWindowMs;

    const options = {
      body: oneLine(spec.body, MAX_BODY),
      tag: `orchestra:${key}`,
      icon: ICON,
      badge: ICON,
      silent,
      renotify: false,
      data: { sessionId: spec.sessionId || null, reason: spec.reason || null },
    };
    if (spec.requireInteraction) options.requireInteraction = true;

    let notification;
    try {
      notification = new this.win.Notification(oneLine(spec.title, MAX_TITLE), options);
    } catch (e) {
      // Some platforms refuse non persistent notifications outside a service
      // worker; that throws here rather than returning anything.
      this.lastError = e && e.message ? e.message : String(e);
      this.log.warn(`notifications: could not show a notification: ${this.lastError}`);
      return false;
    }

    notification.onclick = () => {
      this._activate(spec.sessionId || null);
      try {
        notification.close();
      } catch (e) {
        this.log.debug(`notifications: close after click failed: ${e && e.message}`);
      }
    };
    notification.onerror = () => {
      this.log.warn(`notifications: the browser reported an error for "${spec.title}"`);
    };
    notification.onclose = () => {
      const state = this.perSession.get(key);
      if (state && state.notification === notification) state.notification = null;
    };

    this.perSession.set(key, {
      lastAlertAt: silent && prev ? prev.lastAlertAt : now,
      notification,
      reason: spec.reason || null,
    });
    return true;
  }

  /** Focus the window and bring the session that raised the event forward. */
  _activate(sessionId) {
    if (this.win && typeof this.win.focus === 'function') {
      try {
        this.win.focus();
      } catch (e) {
        this.log.debug(`notifications: window.focus failed: ${e && e.message}`);
      }
    }
    if (!sessionId) return;
    const store = this.store;
    if (typeof store.setActive === 'function') store.setActive(sessionId);
    else if (typeof store.selectSession === 'function') store.selectSession(sessionId);
    else this.log.warn('notifications: the store has no setActive, a click cannot focus the session');
  }

  _close(key) {
    const state = this.perSession.get(key);
    if (!state || !state.notification) return;
    try {
      state.notification.close();
    } catch (e) {
      this.log.debug(`notifications: close failed: ${e && e.message}`);
    }
    state.notification = null;
  }

  closeAll() {
    for (const key of this.perSession.keys()) this._close(key);
  }

  _forget(sessionId) {
    if (!sessionId) return;
    this._close(sessionId);
    this.perSession.delete(sessionId);
  }

  /** Current browser permission, or 'unsupported'. */
  get permission() {
    if (!this.supported) return 'unsupported';
    return this.win.Notification.permission;
  }

  /**
   * Asks the browser for permission, once, and only when there is something to
   * announce. Asking at load is what trains people to click Block.
   * @returns {Promise<boolean>}
   */
  async _ensurePermission() {
    if (!this.supported) return false;
    const current = this.win.Notification.permission;
    if (current === 'granted') return true;
    if (current === 'denied') {
      this.lastError = 'Notifications are blocked for this site in the browser settings.';
      return false;
    }
    if (this._permissionPending) return this._permissionPending;

    this._permissionPending = Promise.resolve()
      .then(() => this.win.Notification.requestPermission())
      .then((result) => {
        this._permissionPending = null;
        if (result !== 'granted') {
          this.lastError = `Permission was not granted (${result}).`;
          return false;
        }
        this.lastError = null;
        return true;
      })
      .catch((e) => {
        this._permissionPending = null;
        this.lastError = e && e.message ? e.message : String(e);
        this.log.warn(`notifications: requestPermission failed: ${this.lastError}`);
        return false;
      });
    return this._permissionPending;
  }

  /**
   * Asks for permission on purpose, from the settings panel, where the click
   * that triggers it is the user gesture browsers want.
   * @returns {Promise<string>} the resulting permission state
   */
  async requestPermission() {
    if (!this.supported) return 'unsupported';
    await this._ensurePermission();
    return this.win.Notification.permission;
  }

  _sessionName(sessionId) {
    const store = this.store;
    let session = null;
    if (typeof store.getSession === 'function') session = store.getSession(sessionId);
    if (session && session.name) return oneLine(session.name, 60);
    return 'Agent';
  }
}

export default Notifications;
