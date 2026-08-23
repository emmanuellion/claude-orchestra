/**
 * Application shell: builds the store, opens the connection, mounts each view
 * on its own root, and keeps the terminal grid in sync with the sessions the
 * server reports. Every behaviour lives in a module.
 *
 * The rule it enforces everywhere: the server is the source of truth. The shell
 * never invents a session, never resurrects one from storage, and never keeps a
 * panel whose session the server has stopped reporting.
 */

import { h, clear, svg, Disposables } from './dom.js';
import { S2C, C2S, STATUS, KIND } from './protocol.js';
import { Store } from './store.js';
import { Connection } from './connection.js';
import { TerminalView, TERMINAL_THEMES } from './terminal-view.js';
import { Sidebar } from './sidebar.js';
import { SupervisionView } from './supervision.js';
import { ApprovalsView } from './approvals-ui.js';
import { RaceView } from './race-ui.js';
import { Launcher } from './launcher.js';
import {
  SettingsPanel,
  applyPreference,
  comboFromEvent,
  validateShortcuts,
  formatCombo,
  SHORTCUT_ACTIONS,
  SHORTCUT_PREFIX,
} from './settings.js';
import { Notifications } from './notifications.js';

const BOOT = window.__ORCHESTRA__ || {};

const VIEWS = [
  { id: 'terminals', label: 'Terminals', icon: 'M4 17l6-6-6-6M12 19h8' },
  { id: 'supervision', label: 'Agents', icon: 'M3 3v18h18M7 15l4-4 3 3 5-6' },
  { id: 'approvals', label: 'Approvals', icon: 'M9 12l2 2 4-4M12 3l7 4v5c0 4-3 7-7 9-4-2-7-5-7-9V7z' },
  { id: 'race', label: 'Races', icon: 'M4 4v16M4 4h12l-2 4 2 4H4' },
  { id: 'launcher', label: 'Projects', icon: 'M3 7h6l2 2h10v10H3z' },
];

/** How long the server is given to tear a session down before we recreate it. */
const RESTART_DELAY_MS = 250;

class App {
  constructor() {
    this.disposables = new Disposables();
    this.store = new Store({ logger: console });
    /** @type {Map<string, TerminalView>} */
    this.terms = new Map();
    /** Timer of the armed prefix chord, null when nothing is armed. */
    this.chordTimer = null;
    /** Shortcut map resolved from preferences; invalidated when they change. */
    this._shortcuts = null;
    /** @type {Map<string, {win: Window, timer: number}>} sessions living in their own window. */
    this.popouts = new Map();
    /** @type {Set<string>} sessions between their close and their recreation. */
    this.restarting = new Set();
    /** @type {Object|null} last /api/usage payload, kept to redraw the meter. */
    this.quota = null;

    this.connection = new Connection(this.store, {
      autoConnect: false,
      onError: err => this.toast(err.message || 'Connection error', 'error'),
    });

    // Every view reads only `token` off this and does its own fetching.
    this.api = { token: BOOT.token || this.connection.token };
  }

  start() {
    this.applyPrefs();
    // Must precede mountViews: the settings panel keeps the reference it is
    // handed, so a later instance would never reach it.
    this.notifications = new Notifications(this.store, { logger: console }).start();

    this.buildChrome();
    this.mountViews();
    this.wireConnection();
    this.wireStore();
    this.wireKeyboard();

    this.disposables.add(() => {
      for (const entry of this.popouts.values()) clearInterval(entry.timer);
      this.popouts.clear();
    });

    if (BOOT.features && BOOT.features.pty === false) {
      this.toast(BOOT.features.ptyError || 'No PTY backend available', 'error', 0);
    }

    this.connection.connect();
    this.refreshRest();
    this.showOrphans();
    this.restInterval = setInterval(() => this.refreshRest(), 60000);
  }

  /** Offers to resume, by its own id, whatever the previous server run left. */
  async showOrphans() {
    let orphans = (BOOT && BOOT.orphans) || [];
    if (!orphans.length) {
      try {
        orphans = await this.apiFetch('/api/orphans');
      } catch (err) {
        console.warn('[orchestra] could not read previous sessions:', err.message);
        return;
      }
    }
    if (!orphans.length) return;

    const bar = h('div', { class: 'orphan-bar' },
      h('div', { class: 'orphan-text' },
        h('strong', { text: `${orphans.length} session${orphans.length > 1 ? 's' : ''} from the previous run` }),
        h('span', { text: ' ended when the server stopped.' })),
      h('div', { class: 'orphan-list' },
        ...orphans.slice(0, 6).map(o => this.buildOrphanRow(o, bar))),
      h('button', { class: 'orphan-close', text: 'Dismiss all', onclick: () => bar.remove() }));

    // Not inside #views: every .view is absolutely positioned over the whole
    // area, so a bar placed there stays visible but receives no click at all.
    // #main is the flex column the bar's `flex: 0 0 auto` was written for.
    const main = document.getElementById('main');
    main.insertBefore(bar, document.getElementById('views'));
  }

  buildOrphanRow(orphan, bar) {
    const forget = node => {
      node.closest('.orphan-row').remove();
      if (!bar.querySelector('.orphan-row')) bar.remove();
    };
    return h('div', { class: 'orphan-row' },
      h('span', { class: 'orphan-name', text: orphan.name }),
      h('span', { class: 'orphan-cwd', text: basenameOf(orphan.cwd), title: orphan.cwd }),
      orphan.gitBranch ? h('span', { class: 'orphan-branch', text: orphan.gitBranch }) : null,
      orphan.lastPrompt
        ? h('span', { class: 'orphan-prompt', text: orphan.lastPrompt, title: orphan.lastPrompt })
        : null,
      h('button', {
        class: 'orphan-btn',
        text: orphan.resumable ? 'Resume' : 'Restart here',
        title: orphan.resumable
          ? 'Restart Claude with --resume, keeping the conversation'
          : 'Start a fresh session in the same directory',
        onclick: async e => {
          e.target.disabled = true;
          try {
            await this.apiFetch(`/api/orphans/${encodeURIComponent(orphan.id)}/resume`, { method: 'POST' });
            forget(e.target);
          } catch (err) {
            e.target.disabled = false;
            this.toast(`Could not resume: ${err.message}`, 'error');
          }
        },
      }),
      h('button', {
        class: 'orphan-dismiss',
        text: '×',
        title: 'Forget this one',
        onclick: async e => {
          await this.apiFetch(`/api/orphans/${encodeURIComponent(orphan.id)}`, { method: 'DELETE' })
            .catch(err => console.warn('[orchestra] could not forget a previous session:', err.message));
          forget(e.target);
        },
      }));
  }

  async apiFetch(path, init = {}) {
    const res = await fetch(path, {
      ...init,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.api.token}`,
        ...(init.headers || {}),
      },
    });
    if (!res.ok) {
      let detail = res.statusText;
      try {
        const body = await res.json();
        detail = body.error || detail;
      } catch {
        // A non-JSON error body is not worth a second failure.
      }
      throw new Error(`${path}: ${detail}`);
    }
    return res.status === 204 ? null : res.json();
  }

  /** REST-only state that has no push channel yet. */
  async refreshRest() {
    const jobs = [
      ['projects', () => this.apiFetch('/api/projects').then(p => this.store.setProjects(p))],
      ['approvals', () => this.apiFetch('/api/approvals').then(a => this.store.setApprovals(a.pending, a.rules))],
      ['usage', () => this.apiFetch('/api/usage').then(u => this.store.setQuota(u))],
      ['timeline', () => this.apiFetch('/api/timeline?limit=200').then(e => this.store.setEvents(e))],
    ];
    for (const [name, run] of jobs) {
      try {
        await run();
      } catch (err) {
        console.warn(`[orchestra] ${name} refresh failed:`, err.message);
      }
    }
  }

  applyPrefs() {
    const prefs = this.store.prefs();
    applyPreference('theme', prefs.theme);
    applyPreference('fontSize', prefs.fontSize);
    document.documentElement.dataset.theme = resolveTheme(prefs.theme);

    const sidebar = document.getElementById('sidebar');
    if (prefs.sidebarWidth) sidebar.style.width = `${prefs.sidebarWidth}px`;
    sidebar.classList.toggle('collapsed', !!prefs.sidebarCollapsed);

    this.disposables.add(this.store.on('pref:theme', v => {
      document.documentElement.dataset.theme = resolveTheme(v);
      const theme = resolveTheme(v) === 'light' ? TERMINAL_THEMES.light : TERMINAL_THEMES.dark;
      for (const view of this.terms.values()) view.setTheme(theme);
    }));
    this.disposables.add(this.store.on('pref:fontSize', v => {
      for (const view of this.terms.values()) view.setFontSize(v);
    }));
  }

  buildChrome() {
    const tabs = document.getElementById('view-tabs');
    clear(tabs);
    for (const v of VIEWS) {
      const btn = h('button', {
        type: 'button',
        id: `view-tab-${v.id}`,
        class: 'view-tab',
        role: 'tab',
        'aria-selected': 'false',
        'aria-controls': `view-${v.id}`,
        tabIndex: -1,
        dataset: { view: v.id },
        title: v.label,
        onclick: () => this.setView(v.id),
      }, svg(v.icon, { class: 'view-tab-icon' }), h('span', { class: 'view-tab-label', text: v.label }));
      tabs.appendChild(btn);

      const section = document.getElementById(`view-${v.id}`);
      if (section) {
        section.setAttribute('role', 'tabpanel');
        section.setAttribute('aria-labelledby', `view-tab-${v.id}`);
      }
    }
    this.disposables.listen(tabs, 'keydown', e => this.onTabsKeydown(e));

    this.alertPill = this.buildAlertPill();
    this.quotaEl = this.buildQuotaMeter();

    const btnSidebar = document.getElementById('btn-sidebar');
    btnSidebar.appendChild(svg('M3 5h18M3 12h18M3 19h18'));
    this.disposables.listen(btnSidebar, 'click', () => this.toggleSidebar());

    const btnSettings = document.getElementById('btn-settings');
    btnSettings.appendChild(svg([
      'M12 15a3 3 0 100-6 3 3 0 000 6z',
      'M19.4 15a1.7 1.7 0 00.3 1.8l.1.1a2 2 0 11-2.8 2.8l-.1-.1a1.7 1.7 0 00-1.8-.3 1.7 1.7 0 00-1 1.5V21a2 2 0 11-4 0v-.1A1.7 1.7 0 009 19.4a1.7 1.7 0 00-1.8.3l-.1.1a2 2 0 11-2.8-2.8l.1-.1a1.7 1.7 0 00.3-1.8 1.7 1.7 0 00-1.5-1H3a2 2 0 110-4h.1A1.7 1.7 0 004.6 9a1.7 1.7 0 00-.3-1.8l-.1-.1a2 2 0 112.8-2.8l.1.1a1.7 1.7 0 001.8.3H9a1.7 1.7 0 001-1.5V3a2 2 0 114 0v.1a1.7 1.7 0 001 1.5 1.7 1.7 0 001.8-.3l.1-.1a2 2 0 112.8 2.8l-.1.1a1.7 1.7 0 00-.3 1.8V9a1.7 1.7 0 001.5 1H21a2 2 0 110 4h-.1a1.7 1.7 0 00-1.5 1z',
    ]));
    this.disposables.listen(btnSettings, 'click', () => this.settings.toggle());

    this.initSidebarResize();
  }

  onTabsKeydown(e) {
    const target = e.target instanceof Element ? e.target.closest('.view-tab') : null;
    if (!target) return;
    const order = VIEWS.map(v => v.id);
    const index = order.indexOf(target.dataset.view);
    if (index < 0) return;

    let next;
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') next = (index + 1) % order.length;
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') next = (index - 1 + order.length) % order.length;
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = order.length - 1;
    else return;

    e.preventDefault();
    this.setView(order[next]);
    const btn = document.getElementById(`view-tab-${order[next]}`);
    if (btn) btn.focus();
  }

  /**
   * The alert pill is the only visible way to reach a blocked agent, so it has
   * to be a real button. index.html declares a span, which no keyboard and no
   * screen reader can act on.
   */
  buildAlertPill() {
    const current = document.getElementById('alert-pill');
    if (!current) return null;
    if (current.tagName === 'BUTTON') return current;
    const button = h('button', {
      type: 'button',
      id: 'alert-pill',
      hidden: true,
      // #alert-pill in the stylesheet carries the look; only the font, which a
      // button does not inherit, has to be restated here.
      style: { font: 'inherit', fontSize: '12px', fontWeight: '600' },
      onclick: () => this.setView(this.store.getApprovals().length ? 'approvals' : 'supervision'),
    });
    current.replaceWith(button);
    return button;
  }

  buildQuotaMeter() {
    const right = document.getElementById('topbar-right');
    if (!right) return null;
    const el = h('span', {
      id: 'quota-meter',
      hidden: true,
      style: {
        display: 'inline-flex',
        alignItems: 'center',
        gap: '6px',
        flex: '0 0 auto',
        fontSize: '11px',
        fontVariantNumeric: 'tabular-nums',
        whiteSpace: 'nowrap',
        color: 'var(--text-3)',
        cursor: 'default',
      },
    });
    const conn = document.getElementById('conn-status');
    if (conn && conn.parentNode === right) right.insertBefore(el, conn);
    else right.appendChild(el);

    // The topbar already drops its tab labels below 900px; a usage reading has
    // no room there either.
    if (typeof window.matchMedia === 'function') {
      this.quotaMedia = window.matchMedia('(min-width: 901px)');
      const onChange = () => this.renderQuota();
      if (typeof this.quotaMedia.addEventListener === 'function') {
        this.quotaMedia.addEventListener('change', onChange);
        this.disposables.add(() => this.quotaMedia.removeEventListener('change', onChange));
      }
    }
    return el;
  }

  renderQuota(payload) {
    if (payload !== undefined) this.quota = payload;
    const el = this.quotaEl;
    if (!el) return;
    const narrow = !!this.quotaMedia && !this.quotaMedia.matches;
    const summary = narrow ? null : quotaSummary(this.quota);
    if (!summary) {
      el.hidden = true;
      el.textContent = '';
      el.removeAttribute('title');
      el.removeAttribute('aria-label');
      return;
    }
    el.hidden = false;
    el.textContent = summary.text;
    el.title = summary.detail;
    el.setAttribute('aria-label', summary.aria);
  }

  initSidebarResize() {
    const sidebar = document.getElementById('sidebar');
    const handle = document.getElementById('sidebar-resize');
    let startX = 0;
    let startW = 0;

    const move = e => {
      const w = Math.min(520, Math.max(200, startW + (e.clientX - startX)));
      sidebar.style.width = `${w}px`;
    };
    const up = () => {
      document.removeEventListener('mousemove', move);
      document.removeEventListener('mouseup', up);
      document.body.classList.remove('resizing');
      this.store.setPref('sidebarWidth', sidebar.offsetWidth);
      this.fitAll();
    };
    this.disposables.listen(handle, 'mousedown', e => {
      e.preventDefault();
      startX = e.clientX;
      startW = sidebar.offsetWidth;
      document.body.classList.add('resizing');
      document.addEventListener('mousemove', move);
      document.addEventListener('mouseup', up);
    });
  }

  toggleSidebar() {
    const sidebar = document.getElementById('sidebar');
    const collapsed = !sidebar.classList.contains('collapsed');
    sidebar.classList.toggle('collapsed', collapsed);
    this.store.setPref('sidebarCollapsed', collapsed);
    setTimeout(() => this.fitAll(), 220);
  }

  mountViews() {
    const actions = {
      focusSession: id => this.focusSession(id),
      minimizeSession: id => this.toggleMinimized(id),
      closeSession: id => this.closeSession(id),
      newAgent: spec => this.connection.create(spec),
      setView: (view, sessionId) => this.setView(view, sessionId),
      openLauncher: () => this.setView('launcher'),
    };

    this.sidebar = new Sidebar(document.getElementById('sidebar-root'), {
      store: this.store, connection: this.connection, actions,
    });

    this.supervision = new SupervisionView(document.getElementById('view-supervision'), {
      store: this.store, connection: this.connection, actions,
    });

    this.approvals = new ApprovalsView(document.getElementById('view-approvals'), {
      store: this.store, connection: this.connection, api: this.api,
    }).mount();

    this.race = new RaceView(document.getElementById('view-race'), {
      store: this.store, connection: this.connection, api: this.api,
    }).mount();

    this.launcher = new Launcher(document.getElementById('view-launcher'), {
      store: this.store,
      connection: this.connection,
      api: this.api,
      logger: console,
      onNavigate: (view, params) => this.setView(view, params && params.sessionId),
    }).mount();

    this.settings = new SettingsPanel(document.getElementById('settings-root'), {
      store: this.store,
      connection: this.connection,
      api: this.api,
      notifications: this.notifications,
      logger: console,
    }).mount();

    this.grid = h('div', { class: 'term-grid' });
    const terminals = document.getElementById('view-terminals');
    clear(terminals);
    terminals.appendChild(this.grid);

    // Views that do not take an `actions` object navigate by event instead.
    this.disposables.listen(document.body, 'orchestra:navigate', e => {
      if (e.detail && e.detail.view) this.setView(e.detail.view, e.detail.sessionId);
    });
    this.disposables.add(this.store.on('navigate', d => {
      if (d && d.view) this.setView(d.view, d.sessionId);
    }));

    this.setView(this.store.getPref('view', 'terminals'));
  }

  setView(id, sessionId) {
    if (!VIEWS.some(v => v.id === id)) return;
    this.currentView = id;
    for (const v of VIEWS) {
      const section = document.getElementById(`view-${v.id}`);
      if (section) section.hidden = v.id !== id;
    }
    for (const btn of document.querySelectorAll('.view-tab')) {
      const selected = btn.dataset.view === id;
      btn.classList.toggle('is-active', selected);
      btn.setAttribute('aria-selected', String(selected));
      // Roving tabindex: one stop for the whole tablist, arrows do the rest.
      btn.tabIndex = selected ? 0 : -1;
    }
    this.store.setPref('view', id);

    if (id === 'terminals') {
      if (sessionId) this.focusSession(sessionId);
      requestAnimationFrame(() => this.fitAll());
    }
    if (id === 'supervision' && this.supervision.refresh) this.supervision.refresh();
    if (id === 'launcher' && this.launcher.activate) this.launcher.activate();
    if (id === 'approvals' && this.approvals.render) this.approvals.render();
  }

  wireStore() {
    this.disposables.add(this.store.on('sessions', () => {
      this.syncGrid();
      // The pill counts blocked sessions and only this event reports one; the
      // approvals poll is up to a minute behind.
      this.updateAlertPill();
    }));
    this.disposables.add(this.store.on('approvals', () => this.updateAlertPill()));
    this.disposables.add(this.store.on('connection', s => this.updateConnStatus(s)));
    this.disposables.add(this.store.on('quota', q => this.renderQuota(q)));
    this.disposables.add(this.store.on('pref:shortcuts', () => { this._shortcuts = null; }));
    this.disposables.listen(window, 'resize', () => this.fitAll());
  }

  dropTerm(id) {
    const view = this.terms.get(id);
    if (!view) return;
    view.dispose();
    (view.panel || view.el).remove();
    this.terms.delete(id);
  }

  syncGrid() {
    const sessions = this.store.getSessions();
    const alive = new Set(sessions.map(s => s.id));

    for (const id of [...this.terms.keys()]) {
      if (!alive.has(id)) this.dropTerm(id);
    }

    const minimized = this.store.getPref('collapsedPanels', {});
    for (const session of sessions) {
      if (minimized[session.id] || this.popouts.has(session.id)) {
        if (this.terms.has(session.id)) {
          this.dropTerm(session.id);
          this.connection.detach(session.id);
        }
        continue;
      }
      const existing = this.terms.get(session.id);
      if (existing) {
        existing.update(session);
        this.updatePanelHeader(existing, session);
        continue;
      }
      const view = new TerminalView(session, {
        store: this.store,
        connection: this.connection,
        theme: resolveTheme(this.store.getPref('theme')) === 'light' ? TERMINAL_THEMES.light : TERMINAL_THEMES.dark,
        fontSize: this.store.getPref('fontSize', 14),
        onEvent: ev => this.onTerminalEvent(session.id, ev),
      });
      const panel = this.buildPanel(session, view);
      this.grid.appendChild(panel);
      view.mount(panel);
      view.panel = panel;
      this.terms.set(session.id, view);
      // create() attaches server-side, but a panel built here is empty: ask
      // for the whole buffer, not the delta this client happens to be missing.
      this.connection.attach(session.id, 0, { fromStart: true });
    }

    // Keep DOM order aligned with the sidebar order.
    for (const session of sessions) {
      const view = this.terms.get(session.id);
      const node = view && (view.panel || view.el);
      if (node && node.parentNode === this.grid) this.grid.appendChild(node);
    }

    this.grid.dataset.count = String(this.terms.size);
    this.renderEmptyState(sessions.length);
    requestAnimationFrame(() => this.fitAll());
  }

  /** The chrome around a terminal: TerminalView owns only the screen. */
  buildPanel(session, view) {
    const title = h('input', {
      class: 'panel-name',
      value: session.name,
      spellcheck: false,
      title: 'Rename',
      onchange: e => this.connection.rename(session.id, e.target.value),
    });
    const state = h('span', { class: 'panel-state', text: session.status });
    const dot = h('span', { class: 'panel-dot' });

    const act = (cls, label, path, fn) => h('button', {
      class: ['panel-btn', cls], title: label, 'aria-label': label, onclick: fn,
    }, svg(path));

    const project = h('span', { class: 'panel-project', text: session.project || '', title: session.cwd || '' });

    const header = h('div', { class: 'panel-header' },
      h('div', { class: 'panel-head-left' }, dot, title,
        h('span', { class: ['panel-kind', `kind-${session.kind}`], text: session.kind.toUpperCase() }),
        project, state),
      h('div', { class: 'panel-actions' },
        act('panel-popout', 'Pop out', 'M18 13v6a2 2 0 01-2 2H5a2 2 0 01-2-2V8a2 2 0 012-2h6M15 3h6v6M10 14L21 3',
          () => this.popOut(session.id)),
        act('panel-export', 'Export output', 'M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4M7 10l5 5 5-5M12 15V3',
          () => this.exportSession(session.id)),
        act('panel-restart', 'Restart', 'M23 4v6h-6M20.5 15a9 9 0 11-2.1-9.4L23 10',
          () => this.restartSession(session.id)),
        act('panel-min', 'Minimize', 'M5 18h14', () => this.toggleMinimized(session.id)),
        act('panel-kill', 'Close', 'M6 6l12 12M18 6L6 18', () => this.closeSession(session.id))));

    const panel = h('div', {
      class: 'term-panel',
      dataset: { sessionId: session.id, status: session.status, tag: session.tagColor || 'none' },
    }, header);
    view._header = { title, state, dot, panel, project };
    return panel;
  }

  updatePanelHeader(view, session) {
    if (!view._header) return;
    const { title, state, panel, project } = view._header;
    panel.dataset.tag = session.tagColor || 'none';
    panel.dataset.status = session.status;

    const label = session.project || '';
    if (project.textContent !== label) project.textContent = label;
    project.title = session.cwd || '';
    project.hidden = !label || label === session.name;

    if (document.activeElement !== title && title.value !== session.name) title.value = session.name;

    if (session.agent && session.agent.tool) {
      state.textContent = session.agent.tool;
    } else if (session.status === STATUS.EXITED) {
      state.textContent = `exited ${session.exitCode == null ? '' : session.exitCode}`.trim();
    } else {
      state.textContent = session.status;
    }
  }

  /**
   * Moves a session into its own window. The grid panel steps aside while it is
   * out there: two views of one PTY both resize it, so the last window sized
   * wins and the other renders at the wrong width.
   */
  popOut(id) {
    const existing = this.popouts.get(id);
    if (existing) {
      this.focusWindow(existing.win);
      return;
    }

    const win = window.open(
      `/popout.html?id=${encodeURIComponent(id)}`, `orchestra-${id}`, 'width=900,height=600');
    if (!win) {
      this.toast('The browser blocked the pop-out window', 'error');
      return;
    }

    // No cross-window event fires reliably on close, so the window is polled.
    const timer = setInterval(() => {
      if (!win.closed) return;
      clearInterval(timer);
      this.popouts.delete(id);
      this.syncGrid();
    }, 1000);
    this.popouts.set(id, { win, timer });
    this.syncGrid();
  }

  focusWindow(win) {
    try {
      win.focus();
    } catch (err) {
      console.warn('[orchestra] could not focus the pop-out window', err);
    }
  }

  /**
   * Replaces a session with a fresh one carrying the same spec. Close first,
   * then create: a bare CREATE leaves the old process running and adds a second
   * panel rather than restarting anything.
   */
  restartSession(id) {
    const session = this.store.getSession(id);
    // The Restart button stays on screen until the replacement is asked for, so
    // without this guard a second click starts a second agent.
    if (!session || this.restarting.has(id)) return;
    if (!this.confirmStop(session, `Restart "${session.name}"? The running process will be terminated.`)) {
      return;
    }
    const spec = {
      kind: session.kind,
      name: session.name,
      cwd: session.cwd,
      args: session.args,
      cols: session.cols,
      rows: session.rows,
      tagColor: session.tagColor,
    };
    this.restarting.add(id);
    this.connection.close(id);
    // Give the server a beat to tear the old one down so the new panel does not
    // land next to a corpse.
    setTimeout(() => {
      this.restarting.delete(id);
      this.connection.create(spec);
    }, RESTART_DELAY_MS);
  }

  /**
   * Asks before killing a live process, when the preference says to; a session
   * that already exited has nothing left to terminate.
   * @returns {boolean} true when the caller may go ahead
   */
  confirmStop(session, message) {
    if (session.status === STATUS.EXITED) return true;
    if (!this.store.getPref('confirmClose', true)) return true;
    return window.confirm(message);
  }

  exportSession(id) {
    const view = this.terms.get(id);
    const session = this.store.getSession(id);
    if (!view || !session) return;
    const blob = new Blob([view.exportText()], { type: 'text/plain' });
    const a = h('a', {
      href: URL.createObjectURL(blob),
      download: `${session.name.replace(/[^a-zA-Z0-9]+/g, '_')}.txt`,
    });
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  renderEmptyState(count) {
    const container = document.getElementById('view-terminals');
    const existing = container.querySelector('.grid-empty');
    if (count > 0 || this.terms.size > 0) {
      if (existing) existing.remove();
      return;
    }
    if (existing) return;
    container.appendChild(h('div', { class: 'grid-empty' },
      svg('M12 15a3 3 0 100-6 3 3 0 000 6zM5 8V6a1 1 0 011-1h2M19 8V6a1 1 0 00-1-1h-2M5 16v2a1 1 0 001 1h2M19 16v2a1 1 0 01-1 1h-2', { class: 'grid-empty-icon' }),
      h('p', { class: 'grid-empty-title', text: 'No agents running' }),
      h('p', { class: 'grid-empty-hint', text: 'Pick a project to start one where the work is.' }),
      h('button', { class: 'grid-empty-btn', text: 'Open projects', onclick: () => this.setView('launcher') })));
  }

  onTerminalEvent(id, ev) {
    if (ev.type === 'error') this.toast(ev.message || 'Terminal error', 'error');
    if (ev.type === 'search-open') this.openSearch(id);
  }

  /** The scrollback search bar TerminalView asks for with `search-open`. */
  openSearch(sessionId) {
    const id = sessionId || (this.store.activeSession() && this.store.activeSession().id);
    const view = id ? this.terms.get(id) : null;
    if (!view) {
      this.toast('Open a session first to search its output');
      return;
    }
    if (this.currentView !== 'terminals') this.setView('terminals');

    if (view._searchBar) {
      view._searchBar.input.focus();
      view._searchBar.input.select();
      return;
    }

    const status = h('span', { style: { color: 'var(--text-3)', minWidth: '52px' } });
    const run = dir => {
      const term = input.value;
      if (!term) {
        view.clearSearch();
        status.textContent = '';
        return;
      }
      status.textContent = view.search(term, dir) ? '' : 'no match';
    };
    const close = () => {
      view.clearSearch();
      bar.remove();
      view._searchBar = null;
      view.focus();
    };
    const input = h('input', {
      type: 'search',
      placeholder: 'Search the scrollback',
      spellcheck: false,
      style: {
        flex: '1 1 auto', minWidth: '0', height: '24px', padding: '0 8px',
        border: '1px solid var(--border)', borderRadius: '4px',
        background: 'var(--surface-2)', color: 'var(--text)', font: 'inherit',
      },
      onkeydown: e => {
        if (e.key === 'Enter') {
          e.preventDefault();
          run(e.shiftKey ? -1 : 1);
        } else if (e.key === 'Escape') {
          e.preventDefault();
          close();
        }
      },
    });
    const button = (label, fn) => h('button', {
      type: 'button', class: 'panel-btn', title: label, 'aria-label': label, text: label,
      style: { width: 'auto', padding: '0 8px', font: 'inherit' },
      onclick: fn,
    });
    const bar = h('div', {
      class: 'panel-search',
      style: {
        display: 'flex', alignItems: 'center', gap: '6px',
        padding: '4px 8px', borderBottom: '1px solid var(--border)',
        background: 'var(--surface)',
      },
    }, input, status, button('Prev', () => run(-1)), button('Next', () => run(1)), button('Close', close));

    const panel = view.panel || view.el;
    const header = panel.querySelector('.panel-header');
    panel.insertBefore(bar, header ? header.nextSibling : panel.firstChild);
    view._searchBar = { bar, input };
    input.focus();
  }

  focusSession(id) {
    const popped = this.popouts.get(id);
    if (popped) {
      this.store.setActive(id);
      this.focusWindow(popped.win);
      return;
    }
    const minimized = { ...this.store.getPref('collapsedPanels', {}) };
    if (minimized[id]) {
      delete minimized[id];
      this.store.setPref('collapsedPanels', minimized);
      this.syncGrid();
    }
    this.store.setActive(id);
    if (this.currentView !== 'terminals') this.setView('terminals');
    const view = this.terms.get(id);
    if (view) {
      (view.panel || view.el).scrollIntoView({ block: 'nearest' });
      view.focus();
    }
  }

  toggleMinimized(id) {
    const minimized = { ...this.store.getPref('collapsedPanels', {}) };
    if (minimized[id]) delete minimized[id];
    else minimized[id] = true;
    this.store.setPref('collapsedPanels', minimized);
    this.syncGrid();
  }

  closeSession(id) {
    const session = this.store.getSession(id);
    if (session && !this.confirmStop(session, `Close "${session.name}"? The process will be terminated.`)) {
      return;
    }
    this.connection.close(id);
  }

  fitAll() {
    for (const view of this.terms.values()) {
      try {
        view.fit();
      } catch (err) {
        console.warn('[orchestra] fit failed', err);
      }
    }
  }

  wireConnection() {
    const c = this.connection;
    this.disposables.add(c.on(S2C.OUTPUT, m => {
      const view = this.terms.get(m.id);
      if (view) view.write(m.data);
    }));
    this.disposables.add(c.on(S2C.SNAPSHOT, m => {
      const view = this.terms.get(m.id);
      if (view) view.applySnapshot(m);
    }));
    this.disposables.add(c.on(S2C.CREATED, m => {
      if (m.session) {
        this.store.setActive(m.session.id);
        if (this.currentView === 'launcher') this.setView('terminals');
      }
    }));
    this.disposables.add(c.on('session-gone', ({ id }) => this.dropTerm(id)));
    this.disposables.add(c.on(S2C.APPROVAL_REQUEST, () => {
      this.updateAlertPill();
      this.refreshApprovals();
    }));
    this.disposables.add(c.on(S2C.APPROVAL_RESOLVED, () => this.updateAlertPill()));
    this.disposables.add(c.on('server-restart', () => {
      this.toast('The server restarted. Sessions from the previous run are gone.', 'error');
    }));
  }

  async refreshApprovals() {
    try {
      const a = await this.apiFetch('/api/approvals');
      this.store.setApprovals(a.pending, a.rules);
    } catch (err) {
      console.warn('[orchestra] approvals refresh failed:', err.message);
    }
  }

  updateConnStatus(state) {
    const el = document.getElementById('conn-status');
    if (!el) return;
    el.className = `conn conn-${state}`;
    el.title = { online: 'Connected', connecting: 'Reconnecting', offline: 'Disconnected' }[state] || state;
  }

  updateAlertPill() {
    const pill = this.alertPill || document.getElementById('alert-pill');
    if (!pill) return;
    const pending = this.store.getApprovals().length;
    const blocked = this.store.getSessions()
      .filter(s => s.status === STATUS.AWAITING_INPUT || s.status === STATUS.AWAITING_PERMISSION).length;
    pill.hidden = pending + blocked === 0;
    const label = pending
      ? `${pending} waiting for you`
      : `${blocked} need${blocked === 1 ? 's' : ''} an answer`;
    pill.textContent = label;
    pill.setAttribute('aria-label', pending
      ? `${label}. Open the approvals queue.`
      : `${label}. Open the agents view.`);
  }

  /**
   * A prefix chord (Ctrl+K then a key) rather than single combos: binding
   * Escape, Ctrl+W or Ctrl+N globally takes exactly the keys a terminal needs,
   * and Ctrl+W closes the tab with every PTY in it. The bindings come from the
   * preference the Shortcuts tab writes, so both show the same table.
   */
  wireKeyboard() {
    const handlers = this.shortcutHandlers();
    const missing = SHORTCUT_ACTIONS.filter(a => typeof handlers[a.id] !== 'function').map(a => a.id);
    if (missing.length) {
      console.warn('[orchestra] shortcut actions with no handler:', missing.join(', '));
    }

    this.disposables.listen(window, 'keydown', e => this.onKeydown(e, handlers), true);
    // A chord left armed while the page loses focus would steal the first key
    // typed on the way back.
    this.disposables.listen(window, 'blur', () => this.disarmChord());
    this.disposables.listen(window, 'mousedown', () => this.disarmChord(), true);
  }

  /** @returns {Object<string, (arg?: any) => void>} one entry per SHORTCUT_ACTIONS id */
  shortcutHandlers() {
    return {
      launcher: () => this.setView('launcher'),
      newAgent: () => this.connection.create({ kind: KIND.CLAUDE, cwd: this.currentCwd() }),
      newShell: () => this.connection.create({ kind: KIND.SHELL, cwd: this.currentCwd() }),
      closeSession: () => this.withActive(s => this.closeSession(s.id)),
      renameSession: () => this.withActive(s => this.renamePrompt(s.id)),
      nextSession: () => this.cycleSession(1),
      prevSession: () => this.cycleSession(-1),
      jumpToIndex: index => this.jumpToSession(index),
      toggleSidebar: () => this.toggleSidebar(),
      viewSupervision: () => this.setView('supervision'),
      viewApprovals: () => this.setView('approvals'),
      viewRace: () => this.setView('race'),
      search: () => this.openSearch(),
      broadcast: () => this.focusBroadcast(),
      settings: () => this.settings.toggle(),
      zoomIn: () => this.zoomBy(1),
      zoomOut: () => this.zoomBy(-1),
    };
  }

  /** The bindings in force, defaults filled in and conflicts dropped. */
  shortcuts() {
    if (!this._shortcuts) {
      const stored = this.store.getPref('shortcuts', {});
      this._shortcuts = validateShortcuts(stored && typeof stored === 'object' ? stored : {}).map;
    }
    return this._shortcuts;
  }

  onKeydown(e, handlers) {
    if (e.defaultPrevented) return;
    // The settings panel records key combos and owns Escape while it is open;
    // this listener runs first in the capture phase and would take them.
    if (this.settings && typeof this.settings.isOpen === 'function' && this.settings.isOpen()) return;
    const combo = comboFromEvent(e);
    if (!combo) return;

    // Once armed, the next key belongs to the shell wherever the focus is: the
    // chord is only ever armed by an explicit prefix press, and a key matching
    // no binding still reaches the terminal untouched.
    if (this.chordTimer) {
      this.disarmChord();
      this.runShortcut(this.matchShortcut(combo, e.key, true), handlers, e);
      return;
    }

    // The prefix has to arm from inside a terminal too: focusSession puts the
    // focus in xterm's textarea, so refusing to arm while "typing" would make
    // every prefixed binding unreachable. stopPropagation keeps the key from
    // also reaching the terminal, where Ctrl+K kills a line.
    const prefix = this.store.getPref('shortcutPrefix', SHORTCUT_PREFIX);
    if (combo.toLowerCase() === String(prefix).toLowerCase()) {
      e.preventDefault();
      e.stopPropagation();
      this.armChord(prefix);
      return;
    }

    // Unprefixed bindings must never take a key from a terminal or a field.
    if (isTypingTarget(e.target)) return;
    this.runShortcut(this.matchShortcut(combo, e.key, false), handlers, e);
  }

  /**
   * @param {string} key   raw key, for the digit range of jumpToIndex
   * @param {boolean} armed whether the prefix chord is waiting
   * @returns {{id: string, arg: any}|null}
   */
  matchShortcut(combo, key, armed) {
    const map = this.shortcuts();
    for (const [id, binding] of Object.entries(map)) {
      if (!binding || !!binding.prefix !== armed) continue;
      if (binding.combo === '1-9') {
        if (/^[1-9]$/.test(key)) return { id, arg: Number(key) };
        continue;
      }
      if (binding.combo.toLowerCase() === combo.toLowerCase()) return { id, arg: undefined };
    }
    return null;
  }

  /** Runs a matched binding and takes the key from the page. A miss is a no-op. */
  runShortcut(match, handlers, event) {
    if (!match) return;
    event.preventDefault();
    event.stopPropagation();
    const run = handlers[match.id];
    if (typeof run !== 'function') return;
    try {
      run(match.arg);
    } catch (err) {
      console.error('[orchestra] shortcut failed', match.id, err);
      this.toast(`Shortcut "${match.id}" failed: ${err.message}`, 'error');
    }
  }

  armChord(prefix) {
    this.disarmChord();
    document.body.classList.add('chord-armed');
    this.chordHint = this.toast(`${formatCombo(prefix)} armed, waiting for the next key`, 'info', 2000);
    this.chordTimer = setTimeout(() => this.disarmChord(), 2000);
  }

  disarmChord() {
    if (!this.chordTimer) return;
    clearTimeout(this.chordTimer);
    this.chordTimer = null;
    document.body.classList.remove('chord-armed');
    if (this.chordHint) {
      this.chordHint.remove();
      this.chordHint = null;
    }
  }

  currentCwd() {
    const active = this.store.activeSession();
    return (active && active.cwd) || this.store.getPref('sidebar.cwd') || undefined;
  }

  withActive(fn) {
    const active = this.store.activeSession();
    if (!active) {
      this.toast('No session is selected');
      return;
    }
    fn(active);
  }

  cycleSession(step) {
    const sessions = this.store.getSessions();
    if (!sessions.length) return;
    const active = this.store.activeSession();
    const index = active ? sessions.findIndex(s => s.id === active.id) : -1;
    const next = index < 0
      ? (step > 0 ? 0 : sessions.length - 1)
      : (index + step + sessions.length) % sessions.length;
    this.focusSession(sessions[next].id);
  }

  jumpToSession(index) {
    const sessions = this.store.getSessions();
    const session = sessions[index - 1];
    if (!session) {
      this.toast(`There is no session ${index}`);
      return;
    }
    this.focusSession(session.id);
  }

  /** Puts the caret in the panel's name field, which is where renaming happens. */
  renamePrompt(id) {
    this.focusSession(id);
    const view = this.terms.get(id);
    const input = view && view._header && view._header.title;
    if (!input) {
      this.toast('That session has no panel to rename from');
      return;
    }
    input.focus();
    input.select();
  }

  focusBroadcast() {
    const input = this.sidebar && this.sidebar.broadcastInput;
    if (!input) {
      this.toast('The broadcast field is not available');
      return;
    }
    // Focusing a disabled input is a silent no-op, so say why instead.
    if (input.disabled) {
      this.toast('Tag some agents first, then filter on that colour to broadcast');
      return;
    }
    const sidebar = document.getElementById('sidebar');
    if (sidebar && sidebar.classList.contains('collapsed')) this.toggleSidebar();
    requestAnimationFrame(() => {
      input.focus();
      input.select();
    });
  }

  zoomBy(step) {
    const current = Number(this.store.getPref('fontSize', 14)) || 14;
    const next = Math.min(24, Math.max(9, current + step));
    if (next === current) return;
    this.store.setPref('fontSize', next);
  }

  toast(message, kind = 'info', timeout = 5000) {
    const root = document.getElementById('toast-root');
    const node = h('div', { class: ['toast', `toast-${kind}`] },
      h('span', { class: 'toast-text', text: String(message) }),
      h('button', { class: 'toast-close', text: '×', title: 'Dismiss', onclick: () => node.remove() }));
    root.appendChild(node);
    requestAnimationFrame(() => node.classList.add('is-visible'));
    if (timeout > 0) {
      setTimeout(() => {
        node.classList.remove('is-visible');
        setTimeout(() => node.remove(), 250);
      }, timeout);
    }
    return node;
  }
}

/**
 * True when the key belongs to whatever the user is typing into. The keyboard
 * handler listens on window in the capture phase, so without this it takes the
 * key before xterm or an input ever sees it.
 */
function isTypingTarget(node) {
  const el = node && node.nodeType === 1 ? node : null;
  if (!el) return false;
  if (el.isContentEditable) return true;
  const tag = el.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
  return typeof el.closest === 'function' && !!el.closest('.term-screen, .xterm');
}

function formatTokens(n) {
  const v = Number(n) || 0;
  if (v >= 1e6) return `${(v / 1e6).toFixed(1)}M`;
  if (v >= 1e3) return `${Math.round(v / 1e3)}k`;
  return String(v);
}

/** Coarse "1h 12m" style duration; null when the input is not a future delay. */
function formatDelay(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return null;
  const minutes = Math.round(ms / 60000);
  if (minutes < 60) return `${Math.max(1, minutes)}m`;
  const hours = Math.floor(minutes / 60);
  const restMinutes = minutes % 60;
  if (hours < 24) return restMinutes ? `${hours}h ${restMinutes}m` : `${hours}h`;
  const days = Math.floor(hours / 24);
  const restHours = hours % 24;
  return restHours ? `${days}d ${restHours}h` : `${days}d`;
}

/** Time left before a usage window resets, null when the payload carries none. */
function resetsIn(win, now) {
  if (!win || win.resetsAt === null || win.resetsAt === undefined) return null;
  return formatDelay(win.resetsAt - now);
}

function windowLine(label, win, now) {
  if (!win) return null;
  const bits = [];
  if (win.usedPercentage !== null && win.usedPercentage !== undefined) {
    bits.push(`${Math.round(win.usedPercentage)}% used`);
  }
  const left = resetsIn(win, now);
  if (left) bits.push(`resets in ${left}`);
  else if (win.resetsText) bits.push(`resets ${win.resetsText}`);
  if (!bits.length) return null;
  return `${label}: ${bits.join(', ')}.`;
}

const QUOTA_WINDOWS = [
  ['5h', 'Session window (5 hours)', 'five_hour'],
  ['7d', 'Weekly window (7 days)', 'seven_day'],
];

/**
 * The reading built from the Claude Code status line snapshot, the only source
 * that knows the plan's limits. The dollar figure is the list price for the
 * same tokens, not what a subscriber pays, so it is labelled and kept out of
 * the headline.
 * @returns {{text: string, detail: string, aria: string}|null}
 */
function quotaFromStatusLine(quota, now) {
  const parts = [];
  const aria = [];
  for (const [short, label, key] of QUOTA_WINDOWS) {
    const win = quota[key];
    if (!win || win.usedPercentage === null || win.usedPercentage === undefined) continue;
    const percent = Math.round(win.usedPercentage);
    const left = resetsIn(win, now);
    parts.push(left ? `${short} ${percent}% (${left})` : `${short} ${percent}%`);
    aria.push(left
      ? `${label} ${percent} percent used, resets in ${left}`
      : `${label} ${percent} percent used`);
  }
  if (!parts.length) return null;

  const detail = ['Usage against your plan limits.'];
  for (const [, label, key] of QUOTA_WINDOWS) {
    const line = windowLine(label, quota[key], now);
    if (line) detail.push(line);
  }
  const extra = windowLine('Extra usage', quota.extra, now);
  if (extra) detail.push(extra);
  if (quota.model && quota.model.displayName) detail.push(`Model: ${quota.model.displayName}.`);
  if (quota.cost && Number.isFinite(quota.cost.totalUsd)) {
    detail.push(`List price of this usage: $${quota.cost.totalUsd.toFixed(2)}. `
      + 'That is the pay-as-you-go price for the same tokens, not a subscription bill.');
  }
  const age = formatDelay(Number(quota.ageMs));
  detail.push(age
    ? `Read from the Claude Code status line, ${age} old.`
    : 'Read from the Claude Code status line.');
  detail.push('Brackets show the time left before that window resets.');

  return { text: parts.join(' · '), detail: detail.join('\n'), aria: `Usage: ${aria.join('. ')}.` };
}

/**
 * The fallback reading, counted from the local transcripts. It knows nothing
 * about the plan's limits, so it never pretends to be a percentage.
 * @returns {{text: string, detail: string, aria: string}|null}
 */
function quotaFromTranscripts(recent, now) {
  const five = recent && recent.fiveHour;
  if (!five || (!recent.entriesCounted && !five.messages)) return null;
  const week = recent.week || { messages: 0, inputTokens: 0, outputTokens: 0 };

  const detail = [
    'No quota snapshot from the Claude Code status line, so the share of your plan '
      + 'that is used cannot be shown.',
    'These numbers are counted from the local transcripts instead.',
    `Last 5 hours: ${five.messages} prompts, `
      + `${formatTokens(five.inputTokens + five.outputTokens)} tokens in and out.`,
    `This week: ${week.messages} prompts, `
      + `${formatTokens(week.inputTokens + week.outputTokens)} tokens in and out.`,
  ];
  const reset = formatDelay(Number(recent.nextWeeklyReset) - now);
  if (reset) detail.push(`The weekly count restarts in ${reset}.`);

  return {
    text: `5h ${five.messages} prompt${five.messages === 1 ? '' : 's'}`,
    detail: detail.join('\n'),
    aria: `Usage: ${five.messages} prompts in the last five hours, counted from transcripts.`,
  };
}

/** @returns {{text: string, detail: string, aria: string}|null} the topbar reading */
function quotaSummary(payload, now = Date.now()) {
  if (!payload || typeof payload !== 'object') return null;
  const fromStatusLine = payload.quota ? quotaFromStatusLine(payload.quota, now) : null;
  return fromStatusLine || quotaFromTranscripts(payload.recent, now);
}

function basenameOf(p) {
  const text = String(p || '');
  return text.split('/').filter(Boolean).pop() || text;
}

function resolveTheme(pref) {
  if (pref === 'light' || pref === 'dark') return pref;
  return window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
}

const app = new App();
window.__orchestraApp = app;

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => app.start(), { once: true });
} else {
  app.start();
}

// A crash in a view must not leave the page looking merely idle.
window.addEventListener('error', e => {
  console.error('[orchestra] uncaught', e.error || e.message);
  if (app.toast) app.toast(`Unexpected error: ${e.message}`, 'error');
});
window.addEventListener('unhandledrejection', e => {
  console.error('[orchestra] unhandled rejection', e.reason);
  if (app.toast) app.toast(`Unexpected error: ${e.reason && e.reason.message ? e.reason.message : e.reason}`, 'error');
});

export { App };
