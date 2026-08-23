/**
 * The pop-out window: one session, full frame, nothing else.
 *
 * It speaks no protocol of its own; it builds the same Store, Connection and
 * TerminalView the shell builds, so a change in protocol.js reaches it free.
 *
 * How it gets the token: index.html is rendered by the server, which injects
 * `window.__ORCHESTRA__` under a CSP nonce, but this page is served as a static
 * file and never receives that injection. So it looks in two places, in order:
 *
 *   1. `window.opener.__ORCHESTRA__.token`, read straight out of the same-origin
 *      parent. The token never touches a URL, so it cannot land in history, in
 *      a bookmark or in a Referer. The opener must NOT pass `noopener`, which
 *      severs `window.opener` and disables this path.
 *   2. `?token=` on our own URL, for a hand-pasted link or a pop-out reopened
 *      after the parent closed. Read once, then stripped with replaceState.
 *
 * Either way the token is confirmed against `GET /api/bootstrap`, which also
 * returns the platform (xterm needs it for ConPTY mode) and the feature flags,
 * and the result is assembled into `window.__ORCHESTRA__` before any module is
 * instantiated.
 */

import { h, clear, svg } from '/js/dom.js';
import { S2C, STATUS, STATUS_LABEL, ERROR_CODE } from '/js/protocol.js';
import { Store, STORAGE_KEY } from '/js/store.js';
import { Connection } from '/js/connection.js';
import { TerminalView, TERMINAL_THEMES } from '/js/terminal-view.js';

const CONN_TITLES = { online: 'Connected', connecting: 'Reconnecting', offline: 'Disconnected' };

const ui = {
  name: document.getElementById('popout-name'),
  kind: document.getElementById('popout-kind'),
  state: document.getElementById('popout-state'),
  statusText: document.getElementById('popout-status-text'),
  detail: document.getElementById('popout-detail'),
  conn: document.getElementById('popout-conn'),
  focusMain: document.getElementById('popout-focus-main'),
  focusLabel: document.getElementById('popout-focus-label'),
  stage: document.getElementById('popout-stage'),
};

ui.focusMain.prepend(svg('M4 14v6h6M20 10V4h-6M14 10l6-6M10 14l-6 6', { size: 13 }));

/**
 * The opener, but only when it is genuinely ours: same origin, still open, and
 * reachable without throwing. Anything else is treated as absent.
 */
function safeOpener() {
  try {
    const opener = window.opener;
    if (!opener || opener.closed) return null;
    // Reading `location.origin` on a cross-origin window throws, so this is
    // both the check and the proof that the reads below are allowed.
    if (opener.location.origin !== window.location.origin) return null;
    return opener;
  } catch {
    return null;
  }
}

/** The opener first, then `?token=`, as documented at the top of the file. */
function resolveToken() {
  const opener = safeOpener();
  if (opener) {
    try {
      const boot = opener.__ORCHESTRA__;
      if (boot && typeof boot.token === 'string' && boot.token) {
        return { token: boot.token, source: 'opener' };
      }
    } catch {
      // The opener is same origin but has not booted; fall through to the URL.
    }
  }
  try {
    const url = new URL(window.location.href);
    const fromQuery = url.searchParams.get('token');
    if (fromQuery) {
      url.searchParams.delete('token');
      window.history.replaceState(null, '', url.pathname + url.search + url.hash);
      return { token: fromQuery, source: 'url' };
    }
  } catch {
    // A URL we cannot parse is a URL with no token in it.
  }
  return { token: '', source: 'none' };
}

/**
 * Preferences are shared with the main window through one localStorage key.
 * The pop-out reads them (theme, font size) and never writes: it must not be
 * able to move the shell's active panel, layout or view from another window.
 */
function readOnlyStorage() {
  try {
    if (typeof localStorage === 'undefined' || !localStorage) return null;
  } catch {
    return null;
  }
  return {
    getItem: key => localStorage.getItem(key),
    setItem: () => {},
    removeItem: () => {},
  };
}

function resolveTheme(pref) {
  if (pref === 'light' || pref === 'dark') return pref;
  return window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
}

/** The action offered on every dead-end screen in this window. */
const OPEN_MAIN = { label: 'Open the main window', run: () => focusMainWindow(null) };

/** Replaces the stage with a readable failure instead of an empty black frame. */
function showMessage(title, hint, actions = []) {
  clear(ui.stage);
  ui.stage.appendChild(h('div', { class: 'popout-message' },
    h('p', { class: 'popout-message-title', text: title }),
    h('p', { class: 'popout-message-hint', text: hint }),
    h('div', { class: 'popout-message-actions' },
      ...actions.map(a => h('button', { type: 'button', text: a.label, onclick: a.run })))));
}

/**
 * Brings the shell forward and asks it to select this session. `app.js` listens
 * for `orchestra:navigate` on document.body, so the event has to be built in
 * the opener's realm to be an instance of its Event constructor.
 */
function focusMainWindow(sessionId) {
  const opener = safeOpener();
  if (opener) {
    try {
      opener.focus();
      if (sessionId && opener.document && opener.document.body) {
        const CE = opener.CustomEvent || window.CustomEvent;
        opener.document.body.dispatchEvent(new CE('orchestra:navigate', {
          detail: { view: 'terminals', sessionId },
          bubbles: true,
        }));
      }
      return true;
    } catch (err) {
      console.warn('[orchestra] could not reach the main window', err);
    }
  }
  // No usable opener: open the shell in its own named window rather than
  // stacking a new one on every click.
  const main = window.open('/', 'orchestra-main');
  if (main) {
    main.focus();
    return true;
  }
  return false;
}

async function fetchBootstrap(token) {
  const res = await fetch('/api/bootstrap', {
    headers: { Authorization: `Bearer ${token}` },
    cache: 'no-store',
  });
  if (res.status === 401 || res.status === 403) {
    const err = new Error('unauthorized');
    err.unauthorized = true;
    throw err;
  }
  if (!res.ok) throw new Error(`/api/bootstrap: ${res.status} ${res.statusText}`);
  return res.json();
}

class Popout {
  constructor(sessionId) {
    this.sessionId = sessionId;
    this.store = null;
    this.connection = null;
    this.view = null;
    this.gone = false;
    this.tornDown = false;
    this.attachRequested = false;
    this._lastReady = null;
    this._onStorage = null;
    this.fontSize = 14;
    this._unsubscribes = [];
  }

  start() {
    this.store = new Store({ logger: console, storage: readOnlyStorage(), autoFlush: false });

    const theme = resolveTheme(this.store.getPref('theme'));
    document.documentElement.dataset.theme = theme;
    this.fontSize = this.store.getPref('fontSize', 14);

    this.connection = new Connection(this.store, {
      autoConnect: false,
      onError: err => this.onConnectionError(err),
    });

    this.wireStore();
    this.wireConnection();
    this.wireWindow();

    this.connection.connect();
  }

  wireStore() {
    const store = this.store;
    this._unsubscribes.push(store.on('connection', state => {
      ui.conn.dataset.conn = state;
      ui.conn.title = CONN_TITLES[state] || state;
    }));
    this._unsubscribes.push(store.on(`session:${this.sessionId}`, session => {
      if (!session) {
        this.onSessionGone();
        return;
      }
      // The server sends `session` and `closed` back to back when a session is
      // removed, and a late `session` re-adds it to the store. Once this window
      // has said the session is gone, it stays gone.
      if (this.gone) return;
      this.renderHeader(session);
      if (this.view) this.view.update(session);
    }));

    // The shell writes preferences; this window follows them read-only.
    this._onStorage = event => {
      if (event.key !== STORAGE_KEY || !event.newValue) return;
      let prefs;
      try {
        prefs = JSON.parse(event.newValue);
      } catch {
        return;
      }
      const nextTheme = resolveTheme(prefs.theme);
      document.documentElement.dataset.theme = nextTheme;
      if (this.view) {
        this.view.setTheme(nextTheme === 'light' ? TERMINAL_THEMES.light : TERMINAL_THEMES.dark);
        if (Number.isFinite(prefs.fontSize)) this.view.setFontSize(prefs.fontSize);
      }
    };
    window.addEventListener('storage', this._onStorage);
  }

  wireConnection() {
    const c = this.connection;
    // `ready` is emitted twice per socket: once as CONN_EVENT.READY, once as the
    // raw protocol message. Same object both times, so dedupe on identity.
    this._unsubscribes.push(c.on(S2C.READY, msg => this.onReady(msg)));
    this._unsubscribes.push(c.on(S2C.OUTPUT, m => {
      if (m.id === this.sessionId && this.view) this.view.write(m.data);
    }));
    this._unsubscribes.push(c.on(S2C.SNAPSHOT, m => {
      if (m.id === this.sessionId && this.view) this.view.applySnapshot(m);
    }));
    this._unsubscribes.push(c.on('session-gone', ({ id }) => {
      if (id === this.sessionId) this.onSessionGone();
    }));
    this._unsubscribes.push(c.on('server-restart', () => {
      // New server process, new PTYs: whatever we were watching is not there.
      this.onSessionGone('The server restarted, so the sessions from the previous run are gone.');
    }));
  }

  wireWindow() {
    ui.focusMain.addEventListener('click', () => {
      if (focusMainWindow(this.sessionId)) return;
      // A pop-up blocker refused to open the shell and there is no opener left.
      ui.focusLabel.textContent = 'Blocked by the browser';
      ui.focusMain.title = 'Allow pop-ups for this address, or open the main window yourself.';
    });

    window.addEventListener('resize', () => {
      if (this.view) this.view.fit();
    });

    // Detach, never kill: the session keeps running on the server and the main
    // window keeps rendering it. Closing the socket would detach us anyway;
    // sending it explicitly makes the server's attach count right immediately.
    const teardown = () => this.teardown();
    window.addEventListener('beforeunload', teardown);
    window.addEventListener('pagehide', teardown);
  }

  onReady(msg) {
    if (msg && this._lastReady === msg) return;
    this._lastReady = msg || null;
    const session = this.store.getSession(this.sessionId);
    if (!session) {
      this.onSessionGone();
      return;
    }
    this.gone = false;
    this.renderHeader(session);
    this.mountTerminal(session);
    // Attach exactly once. seq 0 replays the whole retained scrollback; every
    // later reattach is Connection's job, from the last sequence we rendered,
    // so asking again here would splice a second snapshot into the stream.
    if (!this.attachRequested) {
      this.attachRequested = true;
      this.connection.attach(this.sessionId, 0);
    }
  }

  mountTerminal(session) {
    if (this.view) return;
    clear(ui.stage);
    const theme = resolveTheme(this.store.getPref('theme'));
    this.view = new TerminalView(session, {
      store: this.store,
      connection: this.connection,
      theme: theme === 'light' ? TERMINAL_THEMES.light : TERMINAL_THEMES.dark,
      fontSize: this.fontSize,
      onEvent: ev => this.onTerminalEvent(ev),
    });
    this.view.mount(ui.stage);
    this.view.focus();
  }

  /**
   * The header is fed by the store, which is fed by the hooks. A title escape
   * sequence out of the PTY is deliberately ignored: the state on screen is
   * never guessed from the byte stream.
   */
  onTerminalEvent(ev) {
    if (ev.type === 'error') console.warn('[orchestra]', ev.message);
  }

  onSessionGone(reason) {
    if (this.gone) return;
    this.gone = true;
    if (this.view) {
      this.view.dispose();
      this.view = null;
    }
    ui.state.dataset.status = STATUS.EXITED;
    ui.statusText.textContent = 'Gone';
    ui.detail.textContent = '';
    showMessage(
      'This session is no longer on the server.',
      reason || 'It was closed from the main window, or the server was restarted. '
        + 'Nothing was lost here: the pop-out only ever displays a session, it never owns one.',
      [
        OPEN_MAIN,
        { label: 'Close this window', run: () => window.close() },
      ]
    );
  }

  onConnectionError(err) {
    if (!err) return;
    if (err.code === ERROR_CODE.UNAUTHORIZED) {
      showMessage(
        'The server rejected this window.',
        'The token this pop-out is using is not the one the server expects. Close it and open the '
          + 'pop-out again from the main window.',
        [OPEN_MAIN]
      );
      return;
    }
    if (err.code === ERROR_CODE.NOT_FOUND && err.id === this.sessionId) {
      this.onSessionGone();
      return;
    }
    // Everything else is transient: Connection is already backing off, and the
    // header dot shows the state. Say it once in the console, not on screen.
    console.warn('[orchestra]', err.message);
  }

  renderHeader(session) {
    const name = session.name || this.sessionId;
    ui.name.textContent = name;
    ui.name.title = session.cwd ? `${name}\n${session.cwd}` : name;
    document.title = `${name} - Claude Orchestra`;

    if (session.kind) {
      ui.kind.hidden = false;
      ui.kind.textContent = session.kind;
    } else {
      ui.kind.hidden = true;
    }

    const status = session.status || STATUS.STARTING;
    ui.state.dataset.status = status;
    ui.statusText.textContent = STATUS_LABEL[status] || status;
    ui.detail.textContent = detailFor(session);
  }

  teardown() {
    if (this.tornDown) return;
    this.tornDown = true;
    for (const off of this._unsubscribes) {
      try {
        off();
      } catch {
        // A listener that is already gone is not a failure.
      }
    }
    this._unsubscribes = [];
    if (this._onStorage) window.removeEventListener('storage', this._onStorage);
    if (this.connection) {
      this.connection.detach(this.sessionId);
      this.connection.destroy();
    }
    if (this.view) {
      this.view.dispose();
      this.view = null;
    }
    if (this.store) this.store.destroy();
  }
}

/** One short line under the name: what the agent is doing, or why it stopped. */
function detailFor(session) {
  const agent = session.agent || {};
  if (session.status === STATUS.EXITED) {
    return Number.isFinite(session.exitCode) ? `exit code ${session.exitCode}` : '';
  }
  if (session.status === STATUS.AWAITING_INPUT || session.status === STATUS.AWAITING_PERMISSION) {
    return agent.lastQuestion || '';
  }
  if (agent.tool) return agent.toolDetail ? `${agent.tool} - ${agent.toolDetail}` : agent.tool;
  return session.cwd || '';
}

async function boot() {
  const params = new URL(window.location.href).searchParams;
  const sessionId = params.get('id');

  if (!sessionId) {
    showMessage(
      'No session was requested.',
      'A pop-out needs the session to display: open it from the main window, or add ?id=<sessionId> '
        + 'to this address.',
      [OPEN_MAIN]
    );
    return;
  }

  const { token, source } = resolveToken();
  if (!token) {
    showMessage(
      'This window has no token.',
      'The pop-out reads it from the window that opened it, or from a ?token= parameter. This one '
        + 'was opened without either, so it cannot talk to the server.',
      [OPEN_MAIN]
    );
    return;
  }

  // Assemble the bootstrap object the server injects into index.html. Doing it
  // before anything else means Connection and TerminalView see exactly the same
  // window.__ORCHESTRA__ here as they do in the shell.
  let bootstrap = null;
  try {
    bootstrap = await fetchBootstrap(token);
  } catch (err) {
    if (err && err.unauthorized) {
      showMessage(
        'The server rejected this token.',
        source === 'url'
          ? 'The token in this address is not the one the server expects. Open the pop-out from the '
            + 'main window instead of reusing an old link.'
          : 'The main window is holding a token this server does not accept. Reload the main window '
            + 'from the CLI link, then open the pop-out again.',
        [OPEN_MAIN]
      );
      return;
    }
    // The server may simply be restarting. Carry on with what we know and let
    // the socket, which retries on its own, be the judge.
    console.warn('[orchestra] bootstrap failed:', err.message);
  }

  window.__ORCHESTRA__ = { ...(bootstrap || {}), token };

  const popout = new Popout(sessionId);
  window.__orchestraPopout = popout;
  popout.start();
}

boot().catch(err => {
  console.error('[orchestra] popout failed to start', err);
  showMessage('This pop-out could not start.', String((err && err.message) || err), [
    { label: 'Reload', run: () => window.location.reload() },
  ]);
});

// A swallowed crash makes a broken window and an idle agent look the same.
window.addEventListener('error', e => {
  console.error('[orchestra] uncaught', e.error || e.message);
});
window.addEventListener('unhandledrejection', e => {
  console.error('[orchestra] unhandled rejection', e.reason);
});
