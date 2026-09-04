/**
 * The browser end of the Orchestra wire protocol.
 *
 * Two properties matter more than anything else here:
 *
 *  1. A reconnect must RESTORE, not restart. Sessions outlive sockets on the
 *     server, so on every fresh socket we replay `attach` for every session we
 *     were watching, carrying the last sequence number we actually rendered.
 *     The server answers with the delta only, so a phone that lost signal for
 *     two minutes redraws two minutes of output, not two hours.
 *  2. Nothing is swallowed. A malformed frame, a routing failure, a server-side
 *     error message and a dead heartbeat all reach `onError`; a caught-and-
 *     dropped one would surface only as "the button does nothing".
 */

import { C2S, S2C } from './protocol.js';

const HEARTBEAT_MS = 30000;
const PONG_TIMEOUT_MS = 10000;
/** A socket that opens but never says `ready` is not usable. */
const READY_TIMEOUT_MS = 10000;
const BACKOFF_MIN_MS = 1000;
const BACKOFF_MAX_MS = 30000;
const BACKOFF_JITTER = 0.25;
const QUEUE_MAX = 100;

export const CONN_STATE = {
  CONNECTING: 'connecting',
  OPEN: 'open',
  RECONNECTING: 'reconnecting',
  CLOSED: 'closed',
};

/**
 * Non-protocol events emitted by the Connection itself. READY and ERROR carry a
 * `conn:` namespace because listeners are keyed by a plain string and 'ready'
 * and 'error' are also S2C message types: without it a transport failure would
 * reach whoever subscribed to the server's own error frame.
 */
export const CONN_EVENT = {
  STATE: 'state',
  OPEN: 'open',
  READY: 'conn:ready',
  CLOSE: 'close',
  MESSAGE: 'message',
  ERROR: 'conn:error',
  SERVER_RESTART: 'server-restart',
  SESSION_GONE: 'session-gone',
  RECONNECT_SCHEDULED: 'reconnect-scheduled',
};

/**
 * Reads the session token. `?token=` exists for a link pasted from the CLI and
 * is stripped from the address bar at once, so it survives neither in history,
 * nor in a bookmark, nor in a Referer.
 */
function readToken(report) {
  const boot = typeof window !== 'undefined' ? window.__ORCHESTRA__ : null;
  if (boot && typeof boot.token === 'string' && boot.token) return boot.token;
  try {
    const url = new URL(window.location.href);
    const fromQuery = url.searchParams.get('token');
    if (!fromQuery) return '';
    url.searchParams.delete('token');
    window.history.replaceState(null, '', url.pathname + url.search + url.hash);
    return fromQuery;
  } catch (err) {
    report('Could not read the token from the URL', err);
    return '';
  }
}

function socketUrl(token) {
  const loc = window.location;
  const scheme = loc.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${scheme}//${loc.host}/?token=${encodeURIComponent(token)}`;
}

export class Connection {
  /**
   * @param {Object} store  application store; see `_toStore` for the methods it
   *   is expected to expose
   * @param {{onError?: (err: {message:string, code?:string, id?:string, cause?:any}) => void,
   *          log?: Console, url?: string, autoConnect?: boolean}} [options]
   *   `url` overrides the socket URL (tests, popout); `autoConnect` defaults to true
   */
  constructor(store, options = {}) {
    this.store = store || null;
    this.log = options.log || console;
    this.onError = typeof options.onError === 'function' ? options.onError : null;

    this.token = readToken((message, cause) => this._fail(message, { cause }));
    this.url = options.url || socketUrl(this.token);

    this.ws = null;
    this.state = CONN_STATE.CLOSED;
    this.serverId = null;

    /** @type {Map<string, {seq: number}>} sessions this client is watching. */
    this.attached = new Map();
    this.queue = [];
    this.droppedMessages = 0;

    this.attempt = 0;
    this.stopped = false;

    this._listeners = new Map();
    this._storeGaps = new Set();
    this._pingTimer = null;
    this._pongTimer = null;
    this._readyTimer = null;
    this._reconnectTimer = null;
    this._pendingReattach = false;

    this._onOnline = () => this.reconnectNow('network came back');
    this._onVisible = () => {
      if (document.visibilityState === 'visible' && !this.isOpen) {
        this.reconnectNow('tab became visible');
      }
    };
    window.addEventListener('online', this._onOnline);
    document.addEventListener('visibilitychange', this._onVisible);

    if (options.autoConnect !== false) this.connect();
  }

  get isOpen() {
    return !!this.ws && this.ws.readyState === WebSocket.OPEN;
  }

  /** @returns {() => void} an unsubscribe function */
  on(type, handler) {
    if (typeof handler !== 'function') {
      throw new TypeError(`Connection.on(${type}) needs a function`);
    }
    let set = this._listeners.get(type);
    if (!set) {
      set = new Set();
      this._listeners.set(type, set);
    }
    set.add(handler);
    return () => this.off(type, handler);
  }

  off(type, handler) {
    const set = this._listeners.get(type);
    if (set) set.delete(handler);
  }

  _emit(type, payload) {
    const set = this._listeners.get(type);
    if (!set) return;
    for (const handler of [...set]) {
      try {
        handler(payload);
      } catch (err) {
        // One broken view must not stop the others from seeing the message.
        this._fail(`listener for "${type}" threw: ${err.message}`, { cause: err });
      }
    }
  }

  connect() {
    if (this.stopped) return;
    if (this.ws && (this.ws.readyState === WebSocket.CONNECTING || this.ws.readyState === WebSocket.OPEN)) {
      return;
    }
    this._clearTimer('_reconnectTimer');

    let ws;
    try {
      ws = new WebSocket(this.url);
    } catch (err) {
      this._fail(`Could not open a WebSocket to ${this.url}`, { cause: err });
      this._scheduleReconnect();
      return;
    }

    this.ws = ws;
    this._setState(CONN_STATE.CONNECTING);

    ws.onopen = () => {
      if (this.ws !== ws) return;
      this._pendingReattach = true;
      this._setState(CONN_STATE.OPEN);
      this._flushQueue();
      this._startHeartbeat();
      this._readyTimer = setTimeout(() => {
        this._readyTimer = null;
        this._fail('The server accepted the socket but never sent "ready"', { code: 'no_ready' });
        this._forceReconnect();
      }, READY_TIMEOUT_MS);
      this._emit(CONN_EVENT.OPEN, { url: this.url });
    };

    ws.onmessage = event => {
      if (this.ws !== ws) return;
      let msg;
      try {
        msg = JSON.parse(typeof event.data === 'string' ? event.data : String(event.data));
      } catch (err) {
        this._fail('Received a frame that is not JSON', { code: 'bad_frame', cause: err });
        return;
      }
      if (!msg || typeof msg !== 'object') {
        this._fail('Received a frame that is not an object', { code: 'bad_frame' });
        return;
      }
      try {
        this._route(msg);
      } catch (err) {
        this._fail(`Failed to handle "${msg.t}": ${err.message}`, { code: 'route_failed', cause: err });
      }
    };

    ws.onerror = () => {
      if (this.ws !== ws) return;
      // The browser deliberately hides the reason; `onclose` carries the code.
      this.log.warn('[orchestra] websocket error');
    };

    ws.onclose = event => {
      if (this.ws !== ws) return;
      this.ws = null;
      this._stopHeartbeat();
      this._clearTimer('_readyTimer');
      this._emit(CONN_EVENT.CLOSE, { code: event.code, reason: event.reason, clean: event.wasClean });
      if (this.stopped) {
        this._setState(CONN_STATE.CLOSED);
        return;
      }
      if (event.code === 1008 || event.code === 4401) {
        this._fail('The server rejected this token. Reload the page from the CLI link.', {
          code: 'unauthorized',
        });
      }
      this._setState(CONN_STATE.RECONNECTING);
      this._scheduleReconnect();
    };
  }

  /** Reconnects at once, resetting the backoff. */
  reconnectNow(reason) {
    if (this.stopped) return;
    this.attempt = 0;
    this._clearTimer('_reconnectTimer');
    if (this.isOpen) return;
    if (reason) this.log.info('[orchestra] reconnecting:', reason);
    this.connect();
  }

  /** Closes for good; the instance stops reconnecting. */
  destroy() {
    this.stopped = true;
    this._clearTimer('_reconnectTimer');
    this._stopHeartbeat();
    this._clearTimer('_readyTimer');
    window.removeEventListener('online', this._onOnline);
    document.removeEventListener('visibilitychange', this._onVisible);
    this._dropSocket(1000, 'client shutdown');
    this._listeners.clear();
    this._setState(CONN_STATE.CLOSED);
  }

  _forceReconnect() {
    this._stopHeartbeat();
    this._clearTimer('_readyTimer');
    this._dropSocket(4000, 'client forced reconnect');
    this._setState(CONN_STATE.RECONNECTING);
    this._scheduleReconnect();
  }

  /**
   * Abandons the current socket, handlers first: a zombie socket may never fire
   * `close`, and a late event from it must not disturb its replacement.
   */
  _dropSocket(code, reason) {
    const ws = this.ws;
    this.ws = null;
    if (!ws) return;
    ws.onopen = ws.onmessage = ws.onerror = ws.onclose = null;
    try {
      ws.close(code, reason);
    } catch (err) {
      this.log.warn('[orchestra] close failed', err);
    }
  }

  _scheduleReconnect() {
    if (this.stopped || this._reconnectTimer) return;
    const step = Math.min(BACKOFF_MAX_MS, BACKOFF_MIN_MS * Math.pow(2, this.attempt));
    this.attempt += 1;
    const jitter = step * BACKOFF_JITTER * (Math.random() * 2 - 1);
    const delay = Math.max(250, Math.round(step + jitter));
    this._emit(CONN_EVENT.RECONNECT_SCHEDULED, { delay, attempt: this.attempt });
    this._reconnectTimer = setTimeout(() => {
      this._reconnectTimer = null;
      this.connect();
    }, delay);
  }

  _setState(state) {
    if (this.state === state) return;
    this.state = state;
    this._toStore('setConnectionState', state, {
      attempt: this.attempt,
      serverId: this.serverId,
    });
    this._emit(CONN_EVENT.STATE, state);
  }

  _startHeartbeat() {
    this._stopHeartbeat();
    this._pingTimer = setInterval(() => this._beat(), HEARTBEAT_MS);
  }

  _stopHeartbeat() {
    this._clearTimer('_pingTimer', clearInterval);
    this._clearTimer('_pongTimer');
  }

  /**
   * A mobile network can leave a socket reporting OPEN forever while no byte
   * moves either way, and the UI would sit on it showing a green dot.
   */
  _beat() {
    if (!this.isOpen) return;
    this.send({ t: C2S.PING, ts: Date.now() });
    if (this._pongTimer) return;
    this._pongTimer = setTimeout(() => {
      this._pongTimer = null;
      this._fail('No answer to the heartbeat, treating the socket as dead', { code: 'heartbeat' });
      this._forceReconnect();
    }, PONG_TIMEOUT_MS);
  }

  _clearTimer(name, clear = clearTimeout) {
    if (this[name]) {
      clear(this[name]);
      this[name] = null;
    }
  }

  /**
   * Sends now, or queues until the socket opens. The queue is bounded: a long
   * outage must not become an unbounded array of stale keystrokes.
   */
  send(msg) {
    if (!this.isOpen) {
      this._enqueue(msg);
      return false;
    }
    try {
      this.ws.send(JSON.stringify(msg));
      return true;
    } catch (err) {
      this._fail(`Could not send "${msg && msg.t}"`, { code: 'send_failed', cause: err });
      this._enqueue(msg);
      this._forceReconnect();
      return false;
    }
  }

  _enqueue(msg) {
    if (this.queue.length >= QUEUE_MAX) {
      this.queue.shift();
      this.droppedMessages += 1;
      if (this.droppedMessages === 1) {
        this._fail('The offline queue is full; the oldest messages are being dropped', {
          code: 'queue_overflow',
        });
      }
    }
    this.queue.push(msg);
  }

  _flushQueue() {
    if (!this.queue.length) return;
    const pending = this.queue;
    this.queue = [];
    this.droppedMessages = 0;
    for (const msg of pending) this.send(msg);
  }

  _route(msg) {
    switch (msg.t) {
      case S2C.READY:
        this._onReady(msg);
        break;

      case S2C.CREATED:
        if (msg.session && msg.session.id) {
          // The server attaches the creating socket itself, so we must start
          // tracking the session here or the next reconnect would forget it.
          this._track(msg.session.id, msg.session.seq);
          this._toStore('upsertSession', msg.session);
        }
        break;

      case S2C.SNAPSHOT:
      case S2C.OUTPUT:
        this._track(msg.id, msg.seq);
        break;

      case S2C.SESSION:
        if (msg.session) this._toStore('upsertSession', msg.session);
        break;

      case S2C.EXIT:
        this._toStore('markExited', msg.id, msg.code);
        break;

      case S2C.CLOSED:
        this.attached.delete(msg.id);
        this._toStore('removeSession', msg.id);
        break;

      case S2C.AGENT_EVENT:
        this._toStore('applyAgentEvent', msg.event);
        break;

      case S2C.APPROVAL_REQUEST:
        this._toStore('addApproval', msg.request);
        break;

      case S2C.APPROVAL_RESOLVED:
        this._toStore('resolveApproval', msg);
        break;

      case S2C.QUOTA:
        this._toStore('setQuota', msg.quota !== undefined ? msg.quota : msg);
        break;

      case S2C.AUTO_RESUME:
        this._toStore('setAutoResume', { plans: msg.plans, settings: msg.settings });
        break;

      case S2C.BUDGET:
        this._toStore('setBudget', msg);
        break;

      case S2C.RACE:
        this._toStore('upsertRace', msg.race !== undefined ? msg.race : msg);
        break;

      case S2C.PONG:
        this._clearTimer('_pongTimer');
        break;

      case S2C.ERROR:
        this._fail(msg.message || 'The server reported an error', {
          code: msg.code,
          id: msg.id,
          fromServer: true,
        });
        break;

      default:
        this.log.warn('[orchestra] unknown message from server:', msg.t);
        break;
    }

    // Views subscribe by protocol type; `message` carries everything for the
    // few consumers that want the raw stream.
    if (msg.t) this._emit(msg.t, msg);
    this._emit(CONN_EVENT.MESSAGE, msg);
  }

  _onReady(msg) {
    this._clearTimer('_readyTimer');
    this.attempt = 0;

    const restarted = !!(msg.serverId && this.serverId && msg.serverId !== this.serverId);
    if (restarted) {
      // A new server process means new PTYs: every sequence number we hold is
      // meaningless, and replaying them would splice two unrelated streams.
      for (const state of this.attached.values()) state.seq = 0;
      this._emit(CONN_EVENT.SERVER_RESTART, { serverId: msg.serverId, previous: this.serverId });
    }
    if (msg.serverId) this.serverId = msg.serverId;

    // Reattach BEFORE the store hears about the sessions. `applyReady` emits
    // `sessions` synchronously and every new panel attaches for itself, so
    // reattaching afterwards would send a second ATTACH per session and the
    // server would answer both, opening each terminal with two scrollbacks.
    // On a first connection the map is empty and this loop does nothing.
    if (this._pendingReattach) {
      this._pendingReattach = false;
      this._reattachAll(Array.isArray(msg.sessions) ? msg.sessions : null);
    }

    this._toStore('applyReady', msg);
    this._setState(CONN_STATE.OPEN);

    this._emit(CONN_EVENT.READY, msg);
  }

  /**
   * Asks for every session we were watching again, from the exact byte we last
   * rendered. `sessions`, when the server sent one, prunes the ones it dropped.
   */
  _reattachAll(sessions) {
    const alive = sessions ? new Set(sessions.map(s => s && s.id)) : null;
    for (const [id, state] of [...this.attached]) {
      if (alive && !alive.has(id)) {
        this.attached.delete(id);
        this._emit(CONN_EVENT.SESSION_GONE, { id });
        continue;
      }
      this.send({ t: C2S.ATTACH, id, sinceSeq: state.seq });
    }
  }

  /** The watch entry for a session, created on first use. */
  _stateFor(id) {
    let state = this.attached.get(id);
    if (!state) {
      state = { seq: 0 };
      this.attached.set(id, state);
    }
    return state;
  }

  _track(id, seq) {
    if (!id) return;
    const state = this._stateFor(id);
    if (Number.isFinite(seq) && seq > state.seq) state.seq = seq;
  }

  /** A missing store method is a wiring bug: report it once by name. */
  _toStore(method, ...args) {
    if (!this.store) return false;
    const fn = this.store[method];
    if (typeof fn !== 'function') {
      if (!this._storeGaps.has(method)) {
        this._storeGaps.add(method);
        this.log.warn(`[orchestra] store has no ${method}(); those updates are only visible through connection.on()`);
      }
      return false;
    }
    fn.apply(this.store, args);
    return true;
  }

  _fail(message, extra = {}) {
    const err = { message, ...extra };
    if (extra.cause) this.log.error('[orchestra]', message, extra.cause);
    else this.log.error('[orchestra]', message);
    this._emit(CONN_EVENT.ERROR, err);
    if (this.onError) {
      try {
        this.onError(err);
      } catch (handlerError) {
        this.log.error('[orchestra] onError handler threw', handlerError);
      }
    }
  }

  create(spec) {
    return this.send({ t: C2S.CREATE, spec: spec || {} });
  }

  /**
   * Starts watching a session and remembers it across reconnects.
   *
   * @param {number} [sinceSeq] offset to resume from; the tracked offset wins
   *   when it is higher, so a reconnect only asks for the delta
   * @param {{fromStart?: boolean}} [opts] `fromStart` replays everything, which
   *   is what a brand new empty panel needs: resuming from the tracked offset
   *   there sends only what arrived since, and the panel opens blank
   */
  attach(id, sinceSeq, opts = {}) {
    if (!id) return false;
    const state = this._stateFor(id);
    if (opts.fromStart) state.seq = 0;
    else if (Number.isFinite(sinceSeq) && sinceSeq > state.seq) state.seq = sinceSeq;
    return this.send({ t: C2S.ATTACH, id, sinceSeq: state.seq });
  }

  detach(id) {
    if (!id) return false;
    this.attached.delete(id);
    return this.send({ t: C2S.DETACH, id });
  }

  input(id, data) {
    return this.send({ t: C2S.INPUT, id, data });
  }

  resize(id, cols, rows) {
    return this.send({ t: C2S.RESIZE, id, cols, rows });
  }

  /** Ends the process and forgets the session entirely. */
  close(id) {
    this.attached.delete(id);
    return this.send({ t: C2S.KILL, id, remove: true });
  }

  rename(id, name) {
    return this.send({ t: C2S.RENAME, id, name });
  }

  setMeta(id, patch) {
    return this.send({ t: C2S.SET_META, id, patch: patch || {} });
  }
}

export default Connection;
