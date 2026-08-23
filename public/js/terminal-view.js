/**
 * One xterm.js instance bound to one server session.
 *
 * Deliberately dumb about content: this view renders bytes and forwards
 * keystrokes. It does not strip ANSI, sniff the working directory, guess
 * whether the agent is busy, or parse a cost out of the screen. All of that is
 * reported by the Claude Code hooks and arrives through the store.
 *
 * xterm and its addons are loaded as classic scripts from /vendor (see
 * index.html), never from a CDN, and a failed load is announced on screen
 * rather than leaving an empty black rectangle.
 */

import { STATUS } from './protocol.js';

const DEFAULT_FONT_FAMILY =
  '"Cascadia Mono", "JetBrains Mono", "Fira Code", Menlo, Consolas, "DejaVu Sans Mono", monospace';

export const TERMINAL_THEMES = {
  dark: {
    background: '#0f1115',
    foreground: '#d5d9e0',
    cursor: '#e6b673',
    cursorAccent: '#0f1115',
    selectionBackground: '#2f3b52',
    black: '#20242c',
    red: '#e06c75',
    green: '#98c379',
    yellow: '#e5c07b',
    blue: '#61afef',
    magenta: '#c678dd',
    cyan: '#56b6c2',
    white: '#c8ccd4',
    brightBlack: '#5c6370',
    brightRed: '#ef8a92',
    brightGreen: '#b3dc94',
    brightYellow: '#f0d399',
    brightBlue: '#84c4f5',
    brightMagenta: '#d99ae8',
    brightCyan: '#77ccd6',
    brightWhite: '#f0f2f5',
  },
  light: {
    background: '#fbfbfa',
    foreground: '#24292f',
    cursor: '#b35900',
    cursorAccent: '#fbfbfa',
    selectionBackground: '#cfe3fb',
    black: '#24292f',
    red: '#cf222e',
    green: '#1a7f37',
    yellow: '#9a6700',
    blue: '#0969da',
    magenta: '#8250df',
    cyan: '#1b7c83',
    white: '#6e7781',
    brightBlack: '#57606a',
    brightRed: '#a40e26',
    brightGreen: '#116329',
    brightYellow: '#7d4e00',
    brightBlue: '#0550ae',
    brightMagenta: '#6639ba',
    brightCyan: '#136061',
    brightWhite: '#24292f',
  },
};

const SEARCH_DECORATIONS = {
  matchBackground: '#5c4a1e',
  matchOverviewRuler: '#e5c07b',
  activeMatchBackground: '#e5c07b',
  activeMatchColorOverviewRuler: '#e5c07b',
  activeMatchBorder: '#f0d399',
};

/**
 * The UMD builds put a namespace object on `window` under the same name as the
 * class it holds, except xterm itself which assigns its export directly.
 * Accept both shapes.
 */
function globalCtor(name) {
  const found = typeof window !== 'undefined' ? window[name] : undefined;
  if (!found) return null;
  if (typeof found === 'function') return found;
  const named = found[name];
  return typeof named === 'function' ? named : null;
}

function resolveTheme(theme) {
  if (theme && typeof theme === 'object') return theme;
  return TERMINAL_THEMES[theme] || TERMINAL_THEMES.dark;
}

export class TerminalView {
  /**
   * @param {Object} session  session record as sent by the server
   * @param {{store?: Object, connection?: Object, theme?: string|Object,
   *          fontSize?: number, fontFamily?: string,
   *          onEvent?: (event: {type: string, id: string}) => void}} [options]
   *   `connection` receives input and resize; `theme` is 'dark', 'light', or a
   *   full xterm theme object
   */
  constructor(session, options = {}) {
    if (!session || !session.id) throw new TypeError('TerminalView needs a session with an id');

    this.session = session;
    this.id = session.id;
    this.store = options.store || null;
    this.connection = options.connection || null;
    this.onEvent = typeof options.onEvent === 'function' ? options.onEvent : null;

    this.theme = options.theme || 'dark';
    this.fontSize = options.fontSize || 13;
    this.fontFamily = options.fontFamily || DEFAULT_FONT_FAMILY;

    this.disposed = false;
    this.failed = false;
    this.opened = false;
    this.term = null;
    this.fitAddon = null;
    this.searchAddon = null;

    this._disposables = [];
    this._resizeObserver = null;
    this._resizeTimer = null;
    this._unsubscribeStore = null;
    this._lastCols = session.cols || 0;
    this._lastRows = session.rows || 0;

    this.el = document.createElement('div');
    this.el.className = 'term-view';
    this.el.dataset.sessionId = this.id;

    this.banner = document.createElement('div');
    this.banner.className = 'term-banner';
    this.banner.hidden = true;
    this.el.appendChild(this.banner);

    this.screen = document.createElement('div');
    this.screen.className = 'term-screen';
    this.el.appendChild(this.screen);

    const Terminal = globalCtor('Terminal');
    if (!Terminal) {
      this._renderRuntimeFailure();
      return;
    }

    this.term = new Terminal(this._terminalOptions());
    this._loadAddons();
    this._wireTerminal();
    this._subscribeStore();
    this.update(session);
  }

  _terminalOptions() {
    const boot = typeof window !== 'undefined' ? window.__ORCHESTRA__ : null;
    const opts = {
      allowProposedApi: true,
      allowTransparency: false,
      convertEol: false,
      cursorBlink: true,
      cursorStyle: 'bar',
      drawBoldTextInBrightColors: true,
      fontFamily: this.fontFamily,
      fontSize: this.fontSize,
      lineHeight: 1.15,
      letterSpacing: 0,
      macOptionIsMeta: true,
      minimumContrastRatio: 1,
      rightClickSelectsWord: true,
      scrollback: Number.isFinite(this.session.scrollback) ? this.session.scrollback : 8000,
      scrollOnUserInput: true,
      theme: resolveTheme(this.theme),
      windowsMode: false,
    };
    // ConPTY rewrites the screen on resize; telling xterm about it is what
    // keeps wrapped lines from duplicating when the panel is made narrower.
    if (boot && boot.platform === 'win32') opts.windowsPty = { backend: 'conpty' };
    return opts;
  }

  _loadAddons() {
    const load = (globalName, missingMessage) => {
      const Ctor = globalCtor(globalName);
      if (!Ctor) {
        this._report(missingMessage);
        return null;
      }
      const addon = new Ctor();
      this.term.loadAddon(addon);
      return addon;
    };

    this.fitAddon = load('FitAddon',
      'The fit addon did not load; the terminal will not follow the panel size.');
    load('WebLinksAddon',
      'The web-links addon did not load; URLs will not be clickable.');
    this.searchAddon = load('SearchAddon',
      'The search addon did not load; in-terminal search is unavailable.');
  }

  _wireTerminal() {
    const push = disposable => {
      if (disposable && typeof disposable.dispose === 'function') this._disposables.push(disposable);
    };

    push(this.term.onData(data => {
      if (this.connection) this.connection.input(this.id, data);
      this._fire({ type: 'data', bytes: data.length });
    }));

    push(this.term.onBinary(data => {
      if (!this.connection) return;
      let out = '';
      for (let i = 0; i < data.length; i += 1) out += String.fromCharCode(data.charCodeAt(i) & 255);
      this.connection.input(this.id, out);
    }));

    push(this.term.onTitleChange(title => this._fire({ type: 'title', title })));
    push(this.term.onBell(() => this._fire({ type: 'bell' })));
    push(this.term.onSelectionChange(() => {
      this._fire({ type: 'selection', hasSelection: this.term.hasSelection() });
    }));

    this.term.attachCustomKeyEventHandler(event => this._onKey(event));
  }

  /**
   * Returns true to let the terminal have the key.
   *
   * Only combinations carrying an explicit Ctrl+Shift (Cmd+Shift on macOS)
   * prefix are intercepted. Escape, Ctrl+C, Ctrl+D, Ctrl+R, Ctrl+W, Ctrl+B,
   * Ctrl+M and Ctrl+N are load-bearing inside a REPL and always go through:
   * stealing them for app shortcuts breaks tmux, readline and Claude's own
   * interrupt.
   */
  _onKey(event) {
    if (event.type !== 'keydown') return true;
    const prefix = (event.ctrlKey || event.metaKey) && event.shiftKey && !event.altKey;
    if (!prefix) return true;

    switch (event.key.toLowerCase()) {
      case 'c':
        if (!this.term.hasSelection()) return true;
        this.copySelection();
        return false;
      case 'v':
        this.pasteFromClipboard();
        return false;
      case 'f':
        this._fire({ type: 'search-open' });
        return false;
      case 'k':
        this.clear();
        return false;
      default:
        return true;
    }
  }

  _subscribeStore() {
    if (!this.store || typeof this.store.subscribe !== 'function') return;
    this._unsubscribeStore = this.store.subscribe(`session:${this.id}`, (next) => {
      if (this.disposed) return;
      if (next) this.update(next);
    });
  }

  /**
   * True while there is a terminal worth talking to. Every public method starts
   * here: a view survives both a failed engine load and its own disposal, and
   * the app shell keeps calling into it in either case.
   */
  _live() {
    return !this.failed && !this.disposed && !!this.term;
  }

  /** Attaches to the DOM and opens xterm. Safe to call once. */
  mount(parent) {
    if (this.disposed) return this;
    if (parent && this.el.parentNode !== parent) parent.appendChild(this.el);
    if (this.failed || this.opened || !this.term) return this;

    this.term.open(this.screen);
    this.opened = true;
    this._observeResize();
    this.fit();
    this._fire({ type: 'ready', cols: this.term.cols, rows: this.term.rows });
    return this;
  }

  _observeResize() {
    if (typeof ResizeObserver !== 'function') {
      this._report('ResizeObserver is unavailable; the terminal will not resize automatically.');
      return;
    }
    this._resizeObserver = new ResizeObserver(() => {
      if (this._resizeTimer) clearTimeout(this._resizeTimer);
      this._resizeTimer = setTimeout(() => {
        this._resizeTimer = null;
        this.fit();
      }, 80);
    });
    this._resizeObserver.observe(this.screen);
  }

  write(data) {
    if (!this._live() || !data) return;
    this.term.write(data);
  }

  /**
   * Applies a server snapshot. `truncated` means the bytes we asked for had
   * already aged out of the ring buffer, so the screen must be reset first or
   * the replay would be spliced into the middle of an unrelated frame.
   */
  applySnapshot(snapshot) {
    if (!this._live() || !snapshot) return;
    if (snapshot.truncated) this.term.reset();
    if (snapshot.data) this.term.write(snapshot.data);
  }

  clear() {
    if (!this._live()) return;
    this.term.clear();
    this._fire({ type: 'clear' });
  }

  fit() {
    if (!this._live() || !this.opened || !this.fitAddon) return;
    const rect = this.screen.getBoundingClientRect();
    if (rect.width < 8 || rect.height < 8) return;

    try {
      this.fitAddon.fit();
    } catch (err) {
      this._report(`Could not fit the terminal: ${err.message}`, err);
      return;
    }

    const { cols, rows } = this.term;
    if (cols === this._lastCols && rows === this._lastRows) return;
    this._lastCols = cols;
    this._lastRows = rows;
    if (this.connection) this.connection.resize(this.id, cols, rows);
    this._fire({ type: 'resize', cols, rows });
  }

  focus() {
    if (!this._live()) return;
    this.term.focus();
  }

  /** @param {string|Object} theme 'dark', 'light', or a full xterm theme */
  setTheme(theme) {
    this.theme = theme;
    if (!this._live()) return;
    this.term.options.theme = resolveTheme(theme);
  }

  setFontSize(px) {
    const size = Math.min(32, Math.max(8, Math.round(Number(px) || this.fontSize)));
    this.fontSize = size;
    if (!this._live()) return;
    this.term.options.fontSize = size;
    this.fit();
  }

  /**
   * @param {number} [dir] 1 forwards, -1 backwards
   * @returns {boolean} whether a match was found
   */
  search(term, dir = 1) {
    if (!this._live() || !this.searchAddon) return false;
    if (typeof term !== 'string' || term === '') {
      this.clearSearch();
      return false;
    }
    const options = {
      regex: false,
      wholeWord: false,
      caseSensitive: false,
      incremental: false,
      decorations: SEARCH_DECORATIONS,
    };
    try {
      return dir < 0
        ? this.searchAddon.findPrevious(term, options)
        : this.searchAddon.findNext(term, options);
    } catch (err) {
      this._report(`Search failed: ${err.message}`, err);
      return false;
    }
  }

  clearSearch() {
    if (!this._live() || !this.searchAddon) return;
    if (typeof this.searchAddon.clearDecorations === 'function') {
      this.searchAddon.clearDecorations();
    }
  }

  selection() {
    if (!this._live()) return '';
    return this.term.getSelection();
  }

  copySelection() {
    const text = this.selection();
    if (!text) return;
    if (!navigator.clipboard || typeof navigator.clipboard.writeText !== 'function') {
      this._report('The clipboard is unavailable in this browser context.');
      return;
    }
    navigator.clipboard.writeText(text)
      .then(() => this._fire({ type: 'copy', length: text.length }))
      .catch(err => this._report(`Copy failed: ${err.message}`, err));
  }

  pasteFromClipboard() {
    if (!navigator.clipboard || typeof navigator.clipboard.readText !== 'function') {
      this._report('The clipboard is unavailable in this browser context.');
      return;
    }
    navigator.clipboard.readText()
      .then(text => {
        if (text) this.paste(text);
      })
      .catch(err => this._report(`Paste failed: ${err.message}`, err));
  }

  /** Sends text as if typed. Goes through the server, never into the DOM. */
  paste(text) {
    if (!this._live() || typeof text !== 'string' || !text) return;
    if (this.connection) this.connection.input(this.id, text);
    this._fire({ type: 'paste', length: text.length });
  }

  /** The visible buffer plus scrollback, as plain text. */
  exportText() {
    if (!this._live()) return '';
    const buffer = this.term.buffer.active;
    const lines = [];
    for (let i = 0; i < buffer.length; i += 1) {
      const line = buffer.getLine(i);
      lines.push(line ? line.translateToString(true) : '');
    }
    while (lines.length && lines[lines.length - 1] === '') lines.pop();
    return lines.join('\n');
  }

  /** Refreshes the banner from a session record. Never touches the stream. */
  update(session) {
    if (!session || session.id !== this.id) return;
    this.session = session;
    if (this.failed || this.disposed) return;

    if (session.status === STATUS.EXITED) {
      const code = session.exitCode;
      const suffix = Number.isFinite(code) ? ` (exit code ${code})` : '';
      this._setBanner(`This session has ended${suffix}. The output above is kept for reading.`, 'dead');
      return;
    }
    if (session.attached === 0) {
      this._setBanner('Detached. Output is still being buffered on the server.', 'detached');
      return;
    }
    this._setBanner(null);
  }

  _setBanner(text, kind) {
    if (!text) {
      this.banner.hidden = true;
      this.banner.textContent = '';
      this.banner.className = 'term-banner';
      return;
    }
    // textContent, never innerHTML: this string is built from server state.
    this.banner.textContent = text;
    this.banner.className = `term-banner term-banner-${kind}`;
    this.banner.hidden = false;
  }

  /** Names, on screen, which script failed to define which global. */
  _renderRuntimeFailure() {
    this.failed = true;
    this.screen.classList.add('term-error');

    const title = document.createElement('p');
    title.className = 'term-error-title';
    title.textContent = 'The terminal engine did not load.';

    const hint = document.createElement('p');
    hint.className = 'term-error-hint';
    hint.textContent =
      'xterm.js is served from /vendor/xterm/lib/xterm.js. Check that request in the network panel, '
      + 'then run "npm install" and reload.';

    const missing = document.createElement('ul');
    missing.className = 'term-error-list';
    for (const [globalName, pkg] of [
      ['Terminal', '@xterm/xterm'],
      ['FitAddon', '@xterm/addon-fit'],
      ['WebLinksAddon', '@xterm/addon-web-links'],
      ['SearchAddon', '@xterm/addon-search'],
    ]) {
      if (window[globalName]) continue;
      const item = document.createElement('li');
      item.textContent = `${pkg} did not define window.${globalName}`;
      missing.appendChild(item);
    }

    this.screen.append(title, hint, missing);
    this._report('xterm.js is missing, so this session cannot be displayed.');
  }

  _fire(event) {
    if (!this.onEvent) return;
    try {
      this.onEvent({ ...event, id: this.id });
    } catch (err) {
      console.error('[orchestra] terminal onEvent handler threw', err);
    }
  }

  _report(message, cause) {
    if (cause) console.error('[orchestra]', message, cause);
    else console.warn('[orchestra]', message);
    this._fire({ type: 'error', message, cause });
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;

    if (this._resizeTimer) {
      clearTimeout(this._resizeTimer);
      this._resizeTimer = null;
    }
    if (this._resizeObserver) {
      this._resizeObserver.disconnect();
      this._resizeObserver = null;
    }
    if (typeof this._unsubscribeStore === 'function') {
      this._unsubscribeStore();
      this._unsubscribeStore = null;
    }
    for (const disposable of this._disposables) {
      try {
        disposable.dispose();
      } catch (err) {
        console.warn('[orchestra] terminal listener dispose failed', err);
      }
    }
    this._disposables = [];

    if (this.term) {
      try {
        this.term.dispose();
      } catch (err) {
        console.error('[orchestra] xterm dispose failed', err);
      }
      this.term = null;
    }
    this.fitAddon = null;
    this.searchAddon = null;
    this.onEvent = null;

    if (this.el.parentNode) this.el.parentNode.removeChild(this.el);
  }
}

export default TerminalView;
