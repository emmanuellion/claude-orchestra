const IC = {
  min:     '<svg viewBox="0 0 24 24"><line x1="5" y1="18" x2="19" y2="18"/></svg>',
  restore: '<svg viewBox="0 0 24 24"><rect x="5" y="5" width="14" height="14" rx="2"/></svg>',
  close:   '<svg viewBox="0 0 24 24"><line x1="6" y1="6" x2="18" y2="18"/><line x1="18" y1="6" x2="6" y2="18"/></svg>',
  restart: '<svg viewBox="0 0 24 24"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg>',
  export:  '<svg viewBox="0 0 24 24"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>',
  lock:    '<svg viewBox="0 0 24 24"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>',
  unlock:  '<svg viewBox="0 0 24 24"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 9.9-1"/></svg>',
  float:   '<svg viewBox="0 0 24 24"><rect x="2" y="2" width="14" height="14" rx="2"/><path d="M8 18v2a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V10a2 2 0 0 0-2-2h-2"/></svg>',
  dock:    '<svg viewBox="0 0 24 24"><rect x="3" y="3" width="18" height="18" rx="2"/><line x1="9" y1="3" x2="9" y2="21"/></svg>',
  popout:  '<svg viewBox="0 0 24 24"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>',
};

const MAX_TERMS = 10;

const XTERM_DARK = {
  background: '#09090b', foreground: '#fafafa',
  cursor: '#d4a574', cursorAccent: '#09090b',
  selectionBackground: 'rgba(212,165,116,.2)',
  black: '#18181b', red: '#ef4444', green: '#22c55e', yellow: '#eab308',
  blue: '#3b82f6', magenta: '#a855f7', cyan: '#06b6d4', white: '#e4e4e7',
  brightBlack: '#3f3f46', brightRed: '#f87171', brightGreen: '#4ade80',
  brightYellow: '#facc15', brightBlue: '#60a5fa', brightMagenta: '#c084fc',
  brightCyan: '#22d3ee', brightWhite: '#ffffff',
};

const XTERM_LIGHT = {
  background: '#f4f4f5', foreground: '#18181b',
  cursor: '#b07a3e', cursorAccent: '#f4f4f5',
  selectionBackground: 'rgba(176,122,62,.15)',
  black: '#18181b', red: '#dc2626', green: '#16a34a', yellow: '#ca8a04',
  blue: '#2563eb', magenta: '#9333ea', cyan: '#0891b2', white: '#d4d4d8',
  brightBlack: '#71717a', brightRed: '#ef4444', brightGreen: '#22c55e',
  brightYellow: '#eab308', brightBlue: '#3b82f6', brightMagenta: '#a855f7',
  brightCyan: '#06b6d4', brightWhite: '#ffffff',
};

function esc(s) {
  if (!s) return '';
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function basename(p) {
  return p.replace(/\\/g, '/').split('/').filter(Boolean).pop() || p;
}

function stripAnsi(s) {
  return s.replace(/\x1b\[[0-9;]*[a-zA-Z]|\x1b\][^\x07]*(?:\x07|\x1b\\)|\x1b[()][A-Z0-9]|\x1b[#?][0-9]|\x1b./g, '');
}

function termType(t) {
  return t.isClaude ? 'claude' : t.isPowershell ? 'powershell' : 'shell';
}

class Orchestra {
  constructor() {
    this.ws = null;
    this.terms = new Map();
    this.activeTab = null;
    this.layout = 'grid';
    this.broadcast = false;
    this.notifs = localStorage.getItem('orchestra-notifs') !== 'off';
    this.confirmClose = localStorage.getItem('orchestra-confirm-close') !== 'off';
    this.IDLE_MS = 1500;
    this.reconnectDelay = 1000;
    this.restoring = false;
    this._usageLoading = false;
    this._refitTimer = null;
    this.init();
  }

  init() {
    this.initTheme();
    this.initSidebarResize();
    this.initSidebarCollapse();
    this.connect();
    this.bind();
    this.loadUsage();
    this.requestNotifPermission();
    this.detectPlatform();
  }

  xtermTheme() {
    return document.documentElement.dataset.theme === 'light' ? XTERM_LIGHT : XTERM_DARK;
  }

  initTheme() {
    const saved = localStorage.getItem('orchestra-theme');
    if (saved) {
      document.documentElement.dataset.theme = saved;
    } else if (window.matchMedia('(prefers-color-scheme: light)').matches) {
      document.documentElement.dataset.theme = 'light';
    }
  }

  toggleTheme() {
    const next = document.documentElement.dataset.theme === 'light' ? 'dark' : 'light';
    document.documentElement.dataset.theme = next;
    localStorage.setItem('orchestra-theme', next);
    const theme = this.xtermTheme();
    for (const [, t] of this.terms) {
      t.xterm.options.theme = theme;
    }
  }

  initSidebarResize() {
    const sidebar = document.getElementById('sidebar');
    const handle = document.getElementById('sidebar-resize');
    const saved = localStorage.getItem('orchestra-sidebar-width');
    if (saved) sidebar.style.width = saved + 'px';

    let startX, startW;
    const onMove = (e) => {
      const w = Math.min(480, Math.max(180, startW + (e.clientX - startX)));
      sidebar.style.width = w + 'px';
    };
    const onUp = () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      document.body.classList.remove('sidebar-resizing');
      localStorage.setItem('orchestra-sidebar-width', parseInt(sidebar.style.width));
      this.refit();
    };
    handle.addEventListener('mousedown', (e) => {
      e.preventDefault();
      startX = e.clientX;
      startW = sidebar.offsetWidth;
      document.body.classList.add('sidebar-resizing');
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    });
  }

  initSidebarCollapse() {
    if (localStorage.getItem('orchestra-sidebar-collapsed') === 'true') {
      document.getElementById('sidebar').classList.add('collapsed');
    }
  }

  toggleSidebar() {
    const sidebar = document.getElementById('sidebar');
    sidebar.classList.toggle('collapsed');
    localStorage.setItem('orchestra-sidebar-collapsed', sidebar.classList.contains('collapsed'));
    this.refit();
  }

  toast(msg) {
    let container = document.getElementById('toast-container');
    if (!container) {
      container = document.createElement('div');
      container.id = 'toast-container';
      document.body.appendChild(container);
    }
    const t = document.createElement('div');
    t.className = 'toast';
    t.textContent = msg;
    container.appendChild(t);
    requestAnimationFrame(() => t.classList.add('show'));
    setTimeout(() => { t.classList.remove('show'); setTimeout(() => t.remove(), 300); }, 3000);
  }

  async detectPlatform() {
    try {
      const r = await fetch('/api/platform');
      const { platform } = await r.json();
      if (platform === 'win32') {
        document.getElementById('btn-add-powershell').style.display = '';
      }
    } catch {}
  }

  requestNotifPermission() {
    if ('Notification' in window && Notification.permission === 'default') {
      Notification.requestPermission();
    }
  }

  notify(title, body) {
    if (!this.notifs || !document.hidden) return;
    if (!('Notification' in window) || Notification.permission !== 'granted') return;
    const n = new Notification(title, {
      body,
      icon: 'favicon.svg',
      tag: 'orchestra-' + Date.now(),
      silent: false,
    });
    n.onclick = () => { window.focus(); n.close(); };
    setTimeout(() => n.close(), 8000);
  }

  connect() {
    const p = location.protocol === 'https:' ? 'wss:' : 'ws:';
    this.ws = new WebSocket(`${p}//${location.host}`);
    this.updateWsStatus('reconnecting');
    this.ws.onopen = () => {
      this.reconnectDelay = 1000;
      this.updateWsStatus('connected');
      this.restoreWorkspace();
    };
    this.ws.onmessage = e => {
      try { this.onMsg(JSON.parse(e.data)); } catch {}
    };
    this.ws.onclose = () => {
      this.updateWsStatus('disconnected');
      const delay = this.reconnectDelay;
      this.reconnectDelay = Math.min(delay * 2, 30000);
      setTimeout(() => this.connect(), delay);
    };
  }

  updateWsStatus(state) {
    const el = document.getElementById('ws-status');
    if (!el) return;
    el.className = 'ws-status ws-' + state;
    el.title = state.charAt(0).toUpperCase() + state.slice(1);
  }

  tx(d) { if (this.ws?.readyState === 1) this.ws.send(JSON.stringify(d)); }

  onMsg(m) {
    if (m.type === 'created') this.onCreated(m.id, m.name, m.cwd);
    else if (m.type === 'output') this.onOutput(m.id, m.data);
    else if (m.type === 'exit') this.onExit(m.id, m.exitCode);
  }

  async loadUsage(poll) {
    if (this._usageLoading) return;
    this._usageLoading = true;
    const el = document.getElementById('usage-content');
    const btn = document.getElementById('btn-refresh-usage');
    if (btn) { btn.classList.add('refreshing'); btn.disabled = true; }
    try {
      let watcher = null;
      try {
        const wr = await fetch('/api/quota/watcher');
        if (wr.ok) watcher = await wr.json();
      } catch {}

      if (poll && watcher?.running && watcher.state === 'running') {
        await fetch('/api/quota/watcher/poll', { method: 'POST' });
        const oldQuota = await fetch('/api/quota').then(r => r.json());
        const oldTs = oldQuota?.updated || 0;
        let freshQuota = oldQuota;
        for (let i = 0; i < 10; i++) {
          await new Promise(r => setTimeout(r, 2000));
          freshQuota = await fetch('/api/quota').then(r => r.json());
          if (freshQuota?.updated && freshQuota.updated > oldTs) break;
        }
        this.renderUsage(freshQuota, watcher);
      } else {
        const quota = await fetch('/api/quota').then(r => r.json());
        this.renderUsage(quota, watcher);
      }
    } catch { el.innerHTML = '<div class="usage-loading">Error</div>'; }
    finally {
      this._usageLoading = false;
      if (btn) { btn.classList.remove('refreshing'); btn.disabled = false; }
    }
  }

  fmtCountdown(ms) {
    if (ms <= 0) return 'now';
    const h = Math.floor(ms / 3600000);
    const m = Math.floor((ms % 3600000) / 60000);
    if (h >= 24) { const d = Math.floor(h / 24); return `${d}d ${h % 24}h`; }
    if (h > 0) return `${h}h ${m}m`;
    return `${m}m`;
  }

  renderQuotaBar(label, pct, resetText) {
    const color = pct >= 90 ? 'var(--red)' : pct >= 70 ? 'var(--yellow)' : 'var(--accent)';
    return `<div class="quota-section">
      <div class="quota-header">
        <span class="quota-label">${label}</span>
        <span class="quota-pct" style="color:${color}">${Math.round(pct)}%</span>
      </div>
      <div class="quota-bar"><div class="quota-bar-fill" style="width:${pct}%;background:${color}"></div></div>
      <div class="quota-reset">${resetText}</div>
    </div>`;
  }

  async setupQuotaHook() {
    try {
      const r = await fetch('/api/quota/setup', { method: 'POST', headers: { 'Content-Type': 'application/json' } });
      const d = await r.json();
      if (d.status === 'configured' || d.status === 'already_configured') {
        this.toast('Quota tracking configured. Use Claude Code to see real data.');
        this.loadUsage();
      } else {
        this.toast('Setup failed: ' + (d.message || 'unknown error'));
      }
    } catch { this.toast('Setup failed'); }
  }

  async startWatcher() {
    try {
      const r = await fetch('/api/quota/watcher/start', { method: 'POST' });
      const d = await r.json();
      if (d.status === 'started' || d.status === 'already_running') {
        this.toast('Live monitoring started. Data will appear in ~20s.');
        this.loadUsage();
      } else {
        this.toast('Failed: ' + (d.message || d.status));
      }
    } catch { this.toast('Failed to start watcher'); }
  }

  async stopWatcher() {
    try {
      await fetch('/api/quota/watcher/stop', { method: 'POST' });
      this.toast('Monitoring stopped.');
      this.loadUsage();
    } catch { this.toast('Failed to stop watcher'); }
  }

  async restartWatcher() {
    try {
      await fetch('/api/quota/watcher/stop', { method: 'POST' });
      await new Promise(r => setTimeout(r, 500));
      const r = await fetch('/api/quota/watcher/start', { method: 'POST' });
      const d = await r.json();
      if (d.status === 'started' || d.status === 'already_running') {
        this.toast('Monitoring restarting...');
        this.loadUsage();
      } else {
        this.toast('Failed: ' + (d.message || d.status));
      }
    } catch { this.toast('Failed to restart'); }
  }

  renderUsage(quota, watcher) {
    const el = document.getElementById('usage-content');
    const now = Date.now();
    const watcherRunning = watcher?.running;
    let h = '';

    if (watcherRunning) {
      let stateDesc = '';
      if (watcher.state === 'starting') stateDesc = 'Opening terminal...';
      else if (watcher.state === 'waiting') stateDesc = 'Launching Claude Code...';
      else stateDesc = 'Polling /usage every 2 min';
      h += `<div class="watcher-status">
        <span class="watcher-dot${watcher.state === 'running' ? '' : ' starting'}"></span>
        <div class="watcher-info">
          <span class="watcher-label">${watcher.state === 'running' ? 'Monitoring active' : 'Starting...'}</span>
          <span class="watcher-desc">${stateDesc}</span>
        </div>
        <button id="btn-restart-watcher" class="watcher-restart-btn" title="Restart monitoring">${IC.restart}</button>
        <button id="btn-stop-watcher" class="watcher-stop-btn" title="Stop monitoring">Stop</button>
      </div>`;
    }

    if (quota) {
      const age = now - (quota.updated || 0);
      const ageMin = Math.round(age / 60000);
      const ageStr = ageMin < 1 ? 'just now' : ageMin < 60 ? `${ageMin}m ago` : `${Math.round(ageMin / 60)}h ago`;

      h += `<div class="quota-source">Updated <span class="quota-age">${ageStr}</span></div>`;

      if (quota.five_hour) {
        const pct = quota.five_hour.used_percentage || 0;
        let resetStr = 'Sliding window';
        if (quota.five_hour.resets_at) {
          const resetMs = quota.five_hour.resets_at * 1000 - now;
          resetStr = resetMs > 0 ? `Resets in ${this.fmtCountdown(resetMs)}` : 'Resetting soon';
        } else if (quota.five_hour.resets_text) {
          resetStr = `Reset ${quota.five_hour.resets_text}`;
        }
        h += this.renderQuotaBar('Session', pct, resetStr);
      }

      if (quota.seven_day) {
        const pct = quota.seven_day.used_percentage || 0;
        let resetStr = 'Sliding window';
        if (quota.seven_day.resets_at) {
          const resetMs = quota.seven_day.resets_at * 1000 - now;
          const resetDate = new Date(quota.seven_day.resets_at * 1000);
          const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
          resetStr = resetMs > 0 ? `Reset ${days[resetDate.getDay()]} (${this.fmtCountdown(resetMs)})` : 'Resetting soon';
        } else if (quota.seven_day.resets_text) {
          resetStr = `Reset ${quota.seven_day.resets_text}`;
        }
        h += this.renderQuotaBar('Weekly', pct, resetStr);
      }

      if (quota.extra) {
        const pct = quota.extra.used_percentage || 0;
        let resetStr = '';
        if (quota.extra.spent != null && quota.extra.limit) {
          resetStr = `$${quota.extra.spent.toFixed(2)} / $${quota.extra.limit.toFixed(2)}`;
        }
        if (quota.extra.resets_at) {
          const resetMs = quota.extra.resets_at * 1000 - now;
          if (resetStr) resetStr += ' · ';
          resetStr += resetMs > 0 ? `Resets in ${this.fmtCountdown(resetMs)}` : '';
        } else if (quota.extra.resets_text) {
          if (resetStr) resetStr += ' · ';
          resetStr += `Reset ${quota.extra.resets_text}`;
        }
        h += this.renderQuotaBar('Extra', pct, resetStr);
      }

      if (!watcherRunning) {
        h += `<button id="btn-start-watcher-inline" class="quota-setup-btn" style="margin-top:8px">Start monitoring</button>`;
      }
    } else if (!watcherRunning) {
      h += `<div class="quota-setup">
        <div class="quota-setup-title">Subscription limits</div>
        <div class="quota-setup-text">See your Claude quota usage in real time (5h session + weekly) and when they reset.</div>
        <div class="quota-setup-how">
          <div class="quota-setup-step"><span class="step-num">1</span> A hidden Claude terminal starts in the background</div>
          <div class="quota-setup-step"><span class="step-num">2</span> The <code>/usage</code> command is sent every 2 min</div>
          <div class="quota-setup-step"><span class="step-num">3</span> Percentages and reset timers are displayed here</div>
        </div>
        <button id="btn-start-watcher" class="quota-setup-btn">Start monitoring</button>
        <div class="quota-setup-hint">The process stops automatically with Orchestra</div>
      </div>`;
    }

    el.innerHTML = h;

    const startBtn = document.getElementById('btn-start-watcher');
    if (startBtn) startBtn.onclick = () => this.startWatcher();

    const startInlineBtn = document.getElementById('btn-start-watcher-inline');
    if (startInlineBtn) startInlineBtn.onclick = () => this.startWatcher();

    const restartBtn = document.getElementById('btn-restart-watcher');
    if (restartBtn) restartBtn.onclick = () => this.restartWatcher();

    const stopBtn = document.getElementById('btn-stop-watcher');
    if (stopBtn) stopBtn.onclick = () => this.stopWatcher();

    clearInterval(this._usageRefresh);
    if (watcherRunning || quota) {
      this._usageRefresh = setInterval(() => this.loadUsage(), quota ? 30000 : 10000);
    }
  }

  bind() {
    document.getElementById('btn-add-claude').onclick = () => this.create('claude');
    document.getElementById('btn-add-shell').onclick = () => this.create('shell');
    document.getElementById('btn-add-powershell').onclick = () => this.create('powershell');
    const argsEl = document.getElementById('claude-args');
    const savedArgs = localStorage.getItem('orchestra-claude-args');
    if (savedArgs) argsEl.value = savedArgs;
    document.querySelectorAll('.layout-btn').forEach(b => {
      if (b.dataset.layout) b.onclick = () => this.setLayout(b.dataset.layout);
    });
    document.getElementById('broadcast-mode').onchange = e => {
      this.broadcast = e.target.checked;
      document.getElementById('broadcast-bar').classList.toggle('hidden', !this.broadcast);
    };
    const notifEl = document.getElementById('notif-toggle');
    notifEl.checked = this.notifs;
    notifEl.onchange = e => {
      this.notifs = e.target.checked;
      localStorage.setItem('orchestra-notifs', this.notifs ? 'on' : 'off');
    };
    const confirmEl = document.getElementById('confirm-close-toggle');
    confirmEl.checked = this.confirmClose;
    confirmEl.onchange = e => {
      this.confirmClose = e.target.checked;
      localStorage.setItem('orchestra-confirm-close', this.confirmClose ? 'on' : 'off');
    };
    document.getElementById('broadcast-send').onclick = () => this.sendBroadcast();
    document.getElementById('broadcast-input').onkeydown = e => { if (e.key === 'Enter') this.sendBroadcast(); };
    document.getElementById('btn-refresh-usage').onclick = (e) => { e.stopPropagation(); this.loadUsage(true); };
    document.getElementById('usage-toggle').onclick = (e) => {
      if (e.target.closest('.btn-refresh')) return;
      const content = document.getElementById('usage-content');
      const toggle = document.getElementById('usage-toggle');
      toggle.classList.toggle('expanded');
      content.classList.toggle('hidden');
      localStorage.setItem('orchestra-usage-collapsed', content.classList.contains('hidden'));
    };
    if (localStorage.getItem('orchestra-usage-collapsed') === 'true') {
      document.getElementById('usage-toggle').classList.remove('expanded');
      document.getElementById('usage-content').classList.add('hidden');
    } else {
      document.getElementById('usage-toggle').classList.add('expanded');
    }
    document.getElementById('btn-theme').onclick = () => this.toggleTheme();
    document.getElementById('btn-collapse-sidebar').onclick = () => this.toggleSidebar();

    document.addEventListener('keydown', e => {
      if (e.ctrlKey && e.key === 'Tab') {
        e.preventDefault();
        this.focusTermByOffset(e.shiftKey ? -1 : 1);
      }
    });

    this.updateAddButtons();
    this.emptyState();
  }

  autoLayout() {
    const vis = [...this.terms.values()].filter(t => t.visible).length;
    const next = vis <= 1 ? 'grid' : vis === 2 ? 'cols' : 'grid';
    if (next !== this.layout) this.setLayout(next);
  }

  create(cmd) {
    if (this.terms.size >= MAX_TERMS) {
      this.toast(`Maximum ${MAX_TERMS} terminals reached`);
      return;
    }
    const names = { claude: 'Claude', shell: 'Shell', powershell: 'PowerShell' };
    const n = `${names[cmd] || 'Shell'} ${this.terms.size + 1}`;
    const msg = { type: 'create', command: cmd, name: n, cols: 120, rows: 30 };
    if (cmd === 'claude') {
      const argsEl = document.getElementById('claude-args');
      const args = argsEl ? argsEl.value.trim() : '';
      if (args) {
        msg.claudeArgs = args;
        localStorage.setItem('orchestra-claude-args', args);
      }
    }
    this.tx(msg);
  }

  fitAndSync(id) {
    const t = this.terms.get(id);
    if (!t) return;
    try { t.fit.fit(); this.tx({ type: 'resize', id, cols: t.xterm.cols, rows: t.xterm.rows }); } catch {}
  }

  destroyTerminal(id) {
    const t = this.terms.get(id);
    if (!t) return;
    if (t.floating) this.toggleFloat(id);
    if (t._floatDragHandler) {
      const header = document.querySelector(`#term-${id} .term-header`);
      if (header) header.removeEventListener('mousedown', t._floatDragHandler);
    }
    clearTimeout(t.timer);
    t.ro?.disconnect();
    const body = document.querySelector(`#term-${id} .term-body`);
    if (body && t.wheelHandler) body.removeEventListener('wheel', t.wheelHandler);
    t.xterm.dispose();
    this.terms.delete(id);
    document.getElementById(`term-${id}`)?.remove();
  }

  refreshLayout() {
    this.refit();
    this.emptyState();
    if (this.layout === 'cols') this.addColSplitters();
  }

  onCreated(id, name, cwd) {
    const lower = name.toLowerCase();
    const isClaude = lower.includes('claude');
    const isPowershell = lower.includes('powershell');
    const xterm = new window.Terminal({
      theme: this.xtermTheme(),
      fontSize: 13,
      fontFamily: "'SF Mono','Fira Code','JetBrains Mono',monospace",
      cursorBlink: true,
      scrollback: 10000,
      allowProposedApi: true,
    });
    const fit = new window.FitAddon.FitAddon();
    xterm.loadAddon(fit);
    xterm.loadAddon(new window.WebLinksAddon.WebLinksAddon());

    let search = null;
    if (window.SearchAddon) {
      search = new window.SearchAddon.SearchAddon();
      xterm.loadAddon(search);
    }

    this.terms.set(id, {
      xterm, fit, search, name, cwd: cwd || '',
      alive: true, isClaude, isPowershell, visible: true,
      status: 'idle', timer: null, ro: null,
      locked: false, history: [], historyIdx: -1, wheelHandler: null,
      detectedCwd: '', cost: 0, tokens: { input: 0, output: 0 },
      floating: false, _floatDragHandler: null,
    });
    this.buildPanel(id, name, isClaude, isPowershell);

    const body = document.querySelector(`#term-${id} .term-body`);
    xterm.open(body);
    requestAnimationFrame(() => this.fitAndSync(id));

    xterm.onTitleChange((title) => {
      const t = this.terms.get(id);
      if (!t) return;
      const m = title.match(/(?:^|:\s*)(~\/[^\s]+|\/[^\s]+|[A-Z]:\\[^\s]+)/)
        || title.match(/^PS\s+([A-Z]:\\[^\s>]+)/i);
      if (m) {
        t.detectedCwd = m[1];
        this.updateSidebarCwd(id);
      }
    });

    xterm.attachCustomKeyEventHandler(ev => {
      if (ev.type !== 'keydown') return true;
      const mod = ev.ctrlKey || ev.metaKey;
      if (mod && ev.key === 'v') return false;
      if (mod && ev.key === 'c' && xterm.hasSelection()) return false;
      if ((ev.ctrlKey || ev.metaKey) && ev.shiftKey && ev.code === 'KeyF') { this.toggleSearch(id); return false; }
      if (ev.key === 'Escape') {
        const bar = document.querySelector(`#term-${id} .term-search`);
        if (bar && !bar.classList.contains('hidden')) { this.toggleSearch(id); return false; }
      }
      return true;
    });

    xterm.onData(d => {
      const t = this.terms.get(id);
      if (t?.locked) return;
      if (this.broadcast) this.tx({ type: 'broadcast', data: d });
      else this.tx({ type: 'input', id, data: d });
    });

    const wheelHandler = (ev) => {
      if (!ev.ctrlKey) return;
      ev.preventDefault();
      const t = this.terms.get(id);
      if (!t) return;
      const cur = t.xterm.options.fontSize || 13;
      const next = Math.min(24, Math.max(8, cur + (ev.deltaY < 0 ? 1 : -1)));
      if (next === cur) return;
      t.xterm.options.fontSize = next;
      this.fitAndSync(id);
    };
    body.addEventListener('wheel', wheelHandler, { passive: false });
    this.terms.get(id).wheelHandler = wheelHandler;

    if (search) {
      const countEl = document.querySelector(`#term-${id} .search-count`);
      if (search.onDidChangeResults) {
        search.onDidChangeResults(({ resultIndex, resultCount }) => {
          if (countEl) countEl.textContent = resultCount > 0 ? `${resultIndex + 1}/${resultCount}` : '';
        });
      }
    }

    let rt;
    const ro = new ResizeObserver(() => {
      clearTimeout(rt);
      rt = setTimeout(() => { const t = this.terms.get(id); if (t?.visible) this.fitAndSync(id); }, 80);
    });
    ro.observe(body);
    this.terms.get(id).ro = ro;

    this.autoLayout();
    this.sidebar();
    this.emptyState();
    this.updateAddButtons();
    if (this.layout === 'cols') this.addColSplitters();
    if (!this.restoring) this.saveWorkspace();
  }

  buildPanel(id, name, isClaude, isPowershell) {
    const c = document.getElementById('terminals-container');
    const p = document.createElement('div');
    p.className = 'terminal-panel tab-active';
    p.id = `term-${id}`;
    const badge = isClaude ? 'claude' : isPowershell ? 'powershell' : 'shell';
    const label = isClaude ? 'CLAUDE' : isPowershell ? 'PWSH' : 'SHELL';
    p.innerHTML = `
      <div class="term-header">
        <div class="term-header-left">
          <div class="term-status"></div>
          <input class="term-name" value="${esc(name)}" spellcheck="false">
          <span class="term-badge ${badge}">${label}</span>
        </div>
        <div class="term-actions">
          <button class="act-float" title="Float">${IC.float}</button>
          <button class="act-popout" title="Pop out">${IC.popout}</button>
          <button class="act-export" title="Export output">${IC.export}</button>
          <button class="act-lock" title="Lock input">${IC.lock}</button>
          <button class="act-restart" title="Restart">${IC.restart}</button>
          <button class="act-min" title="Minimize">${IC.min}</button>
          <button class="act-kill" title="Close">${IC.close}</button>
        </div>
      </div>
      <div class="term-search hidden">
        <input type="text" placeholder="Search...">
        <span class="search-count"></span>
        <button class="search-prev" title="Previous">\u2191</button>
        <button class="search-next" title="Next">\u2193</button>
        <button class="search-close" title="Close">\u00d7</button>
      </div>
      <div class="term-body"></div>
      <div class="term-input">
        <input type="text" placeholder="Quick command...">
        <button>Send</button>
      </div>`;
    c.appendChild(p);

    p.querySelector('.act-kill').onclick = () => this.kill(id);
    p.querySelector('.act-min').onclick = () => this.toggle(id);
    p.querySelector('.act-restart').onclick = () => this.restart(id);
    p.querySelector('.act-export').onclick = () => this.exportTerminal(id);
    p.querySelector('.act-lock').onclick = () => this.toggleLock(id);
    p.querySelector('.act-float').onclick = () => this.toggleFloat(id);
    p.querySelector('.act-popout').onclick = () => this.popOut(id);

    const qi = p.querySelector('.term-input input');
    const qb = p.querySelector('.term-input button');
    const go = () => {
      if (!qi.value) return;
      const t = this.terms.get(id);
      if (t?.locked) return;
      if (t) {
        t.history.push(qi.value);
        t.historyIdx = t.history.length;
      }
      this.tx({ type: 'input', id, data: qi.value + '\n' });
      qi.value = '';
    };
    qb.onclick = go;
    qi.onkeydown = e => {
      if (e.key === 'Enter') { go(); return; }
      const t = this.terms.get(id);
      if (!t || !t.history.length) return;
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        if (t.historyIdx > 0) t.historyIdx--;
        qi.value = t.history[t.historyIdx] || '';
      } else if (e.key === 'ArrowDown') {
        e.preventDefault();
        if (t.historyIdx < t.history.length) t.historyIdx++;
        qi.value = t.historyIdx < t.history.length ? t.history[t.historyIdx] : '';
      }
    };
    p.querySelector('.term-name').onchange = e => {
      const t = this.terms.get(id);
      if (t) { t.name = e.target.value; this.sidebar(); this.saveWorkspace(); }
    };

    const si = p.querySelector('.term-search input');
    const doSearch = (dir) => {
      const t = this.terms.get(id);
      if (!t?.search || !si.value) return;
      if (dir === 'next') t.search.findNext(si.value);
      else t.search.findPrevious(si.value);
    };
    si.oninput = () => {
      const t = this.terms.get(id);
      if (t?.search) {
        if (si.value) t.search.findNext(si.value, { incremental: true });
        else { t.search.clearDecorations(); const cnt = p.querySelector('.search-count'); if (cnt) cnt.textContent = ''; }
      }
    };
    si.onkeydown = e => {
      if (e.key === 'Enter') { e.preventDefault(); doSearch(e.shiftKey ? 'prev' : 'next'); }
      if (e.key === 'Escape') this.toggleSearch(id);
    };
    p.querySelector('.search-next').onclick = () => doSearch('next');
    p.querySelector('.search-prev').onclick = () => doSearch('prev');
    p.querySelector('.search-close').onclick = () => this.toggleSearch(id);
  }

  onOutput(id, data) {
    const t = this.terms.get(id);
    if (!t) return;
    t.xterm.write(data);

    const clean = stripAnsi(data);
    const visible = clean.replace(/[\s\r\n\x00-\x1f]/g, '');

    if (visible.length > 0) {
      if (t.isClaude && /^[>❯]$/.test(visible)) {
        this.markBusy(id, 400);
      } else {
        this.markBusy(id);
      }
    }

    this.detectCwd(id, clean);
    this.parseCost(id, clean);
  }

  detectCwd(id, clean) {
    const t = this.terms.get(id);
    if (!t) return;
    let m = clean.match(/PS\s+([A-Z]:\\[^\r\n>]+)/i);
    if (!m) m = clean.match(/^([A-Z]:\\[^\r\n>]+)>/m);
    if (!m) m = clean.match(/\w+@[\w.-]+:(~?\/[^\s$#]+)/);
    if (m) {
      t.detectedCwd = m[1].trim();
      this.updateSidebarCwd(id);
    }
  }

  updateSidebarCwd(id) {
    const t = this.terms.get(id);
    if (!t) return;
    const cwd = t.detectedCwd || t.cwd;
    const el = document.querySelector(`.sidebar-item[data-id="${id}"] .si-cwd`);
    if (el) {
      el.textContent = basename(cwd);
      el.title = cwd;
    } else if (cwd) {
      const info = document.querySelector(`.sidebar-item[data-id="${id}"] .si-info`);
      if (info) {
        const nameEl = info.querySelector('.si-name');
        if (nameEl && !info.querySelector('.si-cwd')) {
          const cwdEl = document.createElement('div');
          cwdEl.className = 'si-cwd';
          cwdEl.title = cwd;
          cwdEl.textContent = basename(cwd);
          nameEl.after(cwdEl);
        }
      }
    }
  }

  parseCost(id, clean) {
    const t = this.terms.get(id);
    if (!t || !t.isClaude) return;
    const costMatch = clean.match(/(?:Total\s+)?[Cc]ost:\s*~?\$(\d+\.?\d*)/);
    if (costMatch) {
      const val = parseFloat(costMatch[1]);
      if (val > t.cost) {
        t.cost = val;
        this.updateCostDisplay(id);
      }
    }
    const inMatch = clean.match(/([\d,]+)\s*input\s*tokens?/i);
    const outMatch = clean.match(/([\d,]+)\s*output\s*tokens?/i);
    if (inMatch) t.tokens.input = parseInt(inMatch[1].replace(/,/g, ''));
    if (outMatch) t.tokens.output = parseInt(outMatch[1].replace(/,/g, ''));
  }

  updateCostDisplay(id) {
    const t = this.terms.get(id);
    if (!t) return;
    const el = document.querySelector(`.sidebar-item[data-id="${id}"] .si-cost`);
    if (el) {
      el.textContent = '$' + t.cost.toFixed(2);
      el.classList.toggle('has-cost', t.cost > 0);
    }
  }

  markBusy(id, ms) {
    const t = this.terms.get(id);
    if (!t?.alive) return;
    const was = t.status !== 'busy';
    t.status = 'busy';
    clearTimeout(t.timer);
    t.timer = setTimeout(() => {
      if (t.alive) {
        t.status = 'idle';
        this.statusUI(id);
        this.notify(`${t.name} finished`, 'Terminal is waiting for input.');
      }
    }, ms || this.IDLE_MS);
    if (was) this.statusUI(id);
  }

  statusUI(id) {
    const t = this.terms.get(id);
    if (!t) return;
    const el = document.querySelector(`#term-${id} .term-status`);
    if (el) el.className = `term-status is-${t.status}`;
    this.updateSidebarStatus(id);
  }

  updateSidebarStatus(id) {
    const t = this.terms.get(id);
    if (!t) return;
    const el = document.querySelector(`.sidebar-item[data-id="${id}"]`);
    if (!el) return;
    el.className = `sidebar-item status-${t.status}${!t.visible ? ' minimized' : ''}${id === this.activeTab && this.layout === 'tabs' ? ' active' : ''}`;
    const txt = el.querySelector('.si-status-text');
    if (txt) txt.textContent = t.status === 'busy' ? 'Active' : t.status === 'dead' ? 'Exited' : 'Idle';
  }

  onExit(id, code) {
    const t = this.terms.get(id);
    if (!t) return;
    const wasBusy = t.status === 'busy';
    t.alive = false; t.status = 'dead';
    clearTimeout(t.timer);
    t.xterm.write(`\r\n\x1b[31m[exited ${code}]\x1b[0m\r\n`);
    this.statusUI(id);
    if (wasBusy) this.notify(`${t.name} stopped`, `Process exited with code ${code}.`);
  }

  toggle(id) {
    const t = this.terms.get(id);
    if (!t) return;
    if (t.floating) this.toggleFloat(id);
    t.visible = !t.visible;
    const p = document.getElementById(`term-${id}`);
    if (p) p.classList.toggle('hidden-panel', !t.visible);
    this.autoLayout();
    if (t.visible) setTimeout(() => { this.fitAndSync(id); t.xterm.focus(); }, 150);
    this.sidebar();
    this.refreshLayout();
  }

  kill(id) {
    const t = this.terms.get(id);
    if (t?.alive && this.confirmClose && !confirm(`Close "${t.name}"?`)) return;
    this.tx({ type: 'kill', id });
    this.destroyTerminal(id);
    this.autoLayout();
    this.sidebar();
    this.updateAddButtons();
    this.refreshLayout();
    if (!this.restoring) this.saveWorkspace();
  }

  restart(id) {
    const t = this.terms.get(id);
    if (!t) return;
    const command = termType(t);
    const { name, isClaude } = t;
    this.tx({ type: 'kill', id });
    this.destroyTerminal(id);
    this.updateAddButtons();
    const msg = { type: 'create', command, name, cols: 120, rows: 30 };
    if (isClaude) {
      const args = localStorage.getItem('orchestra-claude-args') || '';
      if (args) msg.claudeArgs = args;
    }
    setTimeout(() => this.tx(msg), 300);
  }

  refit() {
    clearTimeout(this._refitTimer);
    this._refitTimer = setTimeout(() => {
      for (const [id, t] of this.terms) {
        if (t.visible) this.fitAndSync(id);
      }
    }, 200);
  }

  sendBroadcast() {
    const i = document.getElementById('broadcast-input');
    if (i.value) { this.tx({ type: 'broadcast', data: i.value + '\n' }); i.value = ''; }
  }

  setLayout(l) {
    this.removeColSplitters();
    this.layout = l;
    document.getElementById('terminals-container').className = `layout-${l}`;
    document.querySelectorAll('.layout-btn').forEach(b => {
      if (b.dataset.layout) b.classList.toggle('active', b.dataset.layout === l);
    });
    document.body.classList.toggle('layout-tabs-mode', l === 'tabs');
    if (l === 'tabs') {
      const first = [...this.terms.entries()].find(([, t]) => t.visible);
      if (first && !this.activeTab) this.setTab(first[0]);
      else if (this.activeTab) this.setTab(this.activeTab);
    } else {
      document.querySelectorAll('.terminal-panel').forEach(p => { if (!p.classList.contains('hidden-panel')) p.classList.add('tab-active'); });
    }
    if (l === 'cols') this.addColSplitters();
    this.refit();
    if (!this.restoring) this.saveWorkspace();
  }

  addColSplitters() {
    this.removeColSplitters();
    if (this.layout !== 'cols') return;
    const container = document.getElementById('terminals-container');
    const panels = [...container.querySelectorAll('.terminal-panel:not(.hidden-panel):not(.floating-panel)')];
    if (panels.length < 2) return;
    for (let i = 0; i < panels.length - 1; i++) {
      const splitter = document.createElement('div');
      splitter.className = 'col-splitter';
      panels[i].after(splitter);
      const left = panels[i];
      const right = panels[i + 1];
      let startX, startLW, startRW;
      const onMove = (e) => {
        const dx = e.clientX - startX;
        left.style.flex = `0 0 ${Math.max(200, startLW + dx)}px`;
        right.style.flex = `0 0 ${Math.max(200, startRW - dx)}px`;
      };
      const onUp = () => {
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
        document.body.classList.remove('col-resizing');
        this.refit();
      };
      splitter.addEventListener('mousedown', (e) => {
        e.preventDefault();
        startX = e.clientX;
        startLW = left.offsetWidth;
        startRW = right.offsetWidth;
        document.body.classList.add('col-resizing');
        document.addEventListener('mousemove', onMove);
        document.addEventListener('mouseup', onUp);
      });
    }
  }

  removeColSplitters() {
    document.querySelectorAll('.col-splitter').forEach(s => s.remove());
    document.querySelectorAll('.terminal-panel').forEach(p => { p.style.flex = ''; });
  }

  setTab(id) {
    this.activeTab = id;
    document.querySelectorAll('.terminal-panel').forEach(p => {
      const tid = parseInt(p.id.replace('term-', ''));
      const t = this.terms.get(tid);
      if (t?.visible) p.classList.toggle('tab-active', p.id === `term-${id}`);
    });
    const t = this.terms.get(id);
    if (t) setTimeout(() => { this.fitAndSync(id); t.xterm.focus(); }, 50);
    this.sidebar();
  }

  sidebar() {
    const list = document.getElementById('sidebar-list');
    list.innerHTML = '';
    for (const [id, t] of this.terms) {
      const el = document.createElement('div');
      el.className = `sidebar-item status-${t.status}`;
      el.dataset.id = id;
      if (!t.visible) el.classList.add('minimized');
      if (id === this.activeTab && this.layout === 'tabs') el.classList.add('active');

      const st = t.status === 'busy' ? 'Active' : t.status === 'dead' ? 'Exited' : 'Idle';
      const badge = termType(t);
      const label = t.isClaude ? 'CLAUDE' : t.isPowershell ? 'PWSH' : 'SHELL';
      const tIcon = t.visible ? IC.min : IC.restore;
      const cwd = t.detectedCwd || t.cwd;
      const cwdHtml = cwd ? `<div class="si-cwd" title="${esc(cwd)}">${esc(basename(cwd))}</div>` : '';
      const costHtml = t.isClaude ? `<span class="si-cost${t.cost > 0 ? ' has-cost' : ''}">${t.cost > 0 ? '$' + t.cost.toFixed(2) : ''}</span>` : '';

      el.innerHTML = `
        <div class="si-status"></div>
        <div class="si-info">
          <div class="si-name">${esc(t.name)}</div>
          ${cwdHtml}
          <div class="si-meta">
            <span class="si-badge ${badge}">${label}</span>
            <span class="si-status-text">${st}</span>
            ${costHtml}
            ${!t.visible ? '<span style="color:var(--yellow);font-size:9px">minimized</span>' : ''}
            ${t.locked ? '<span style="color:var(--red);font-size:9px">locked</span>' : ''}
          </div>
        </div>
        <div class="si-actions">
          <button class="act-toggle" title="${t.visible ? 'Minimize' : 'Restore'}">${tIcon}</button>
          <button class="act-kill" title="Close">${IC.close}</button>
        </div>`;

      el.onclick = e => {
        if (e.target.closest('.si-actions')) return;
        if (!t.visible) this.toggle(id);
        if (this.layout === 'tabs') this.setTab(id);
        else t.xterm.focus();
      };
      el.querySelector('.act-toggle').onclick = e => { e.stopPropagation(); this.toggle(id); };
      el.querySelector('.act-kill').onclick = e => { e.stopPropagation(); this.kill(id); };
      list.appendChild(el);
    }
    this.initDragReorder();
  }

  initDragReorder() {
    const list = document.getElementById('sidebar-list');
    let draggedEl = null;
    let highlightedEl = null;

    list.addEventListener('dragstart', (e) => {
      const item = e.target.closest('.sidebar-item');
      if (!item) return;
      draggedEl = item;
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', item.dataset.id);
      requestAnimationFrame(() => item.classList.add('dragging'));
    });

    list.addEventListener('dragend', () => {
      if (draggedEl) draggedEl.classList.remove('dragging');
      if (highlightedEl) { highlightedEl.classList.remove('drag-over-above', 'drag-over-below'); highlightedEl = null; }
      draggedEl = null;
    });

    list.addEventListener('dragover', (e) => {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      const item = e.target.closest('.sidebar-item');
      if (!item || item === draggedEl) return;
      if (highlightedEl && highlightedEl !== item) {
        highlightedEl.classList.remove('drag-over-above', 'drag-over-below');
      }
      const rect = item.getBoundingClientRect();
      const cls = e.clientY < rect.top + rect.height / 2 ? 'drag-over-above' : 'drag-over-below';
      item.classList.remove('drag-over-above', 'drag-over-below');
      item.classList.add(cls);
      highlightedEl = item;
    });

    list.addEventListener('dragleave', (e) => {
      const item = e.target.closest('.sidebar-item');
      if (item && !item.contains(e.relatedTarget)) {
        item.classList.remove('drag-over-above', 'drag-over-below');
      }
    });

    list.addEventListener('drop', (e) => {
      e.preventDefault();
      if (highlightedEl) { highlightedEl.classList.remove('drag-over-above', 'drag-over-below'); highlightedEl = null; }
      const item = e.target.closest('.sidebar-item');
      if (!item) return;
      const draggedId = parseInt(e.dataTransfer.getData('text/plain'));
      const targetId = parseInt(item.dataset.id);
      if (draggedId === targetId) return;
      const rect = item.getBoundingClientRect();
      const before = e.clientY < rect.top + rect.height / 2;
      const ids = [...this.terms.keys()];
      const fromIdx = ids.indexOf(draggedId);
      ids.splice(fromIdx, 1);
      let toIdx = ids.indexOf(targetId);
      if (!before) toIdx++;
      ids.splice(toIdx, 0, draggedId);
      this.reorderTerminals(ids);
    });

    document.querySelectorAll('#sidebar-list .sidebar-item').forEach(item => { item.draggable = true; });
  }

  reorderTerminals(ids) {
    const newMap = new Map();
    for (const id of ids) {
      const t = this.terms.get(id);
      if (t) newMap.set(id, t);
    }
    this.terms = newMap;
    const container = document.getElementById('terminals-container');
    for (const id of ids) {
      const panel = document.getElementById(`term-${id}`);
      if (panel) container.appendChild(panel);
    }
    this.sidebar();
    this.saveWorkspace();
    if (this.layout === 'cols') this.addColSplitters();
  }

  toggleFloat(id) {
    const t = this.terms.get(id);
    if (!t) return;
    const panel = document.getElementById(`term-${id}`);
    if (!panel) return;
    const btn = panel.querySelector('.act-float');

    if (!t.floating) {
      const rect = panel.getBoundingClientRect();
      panel.style.position = 'fixed';
      panel.style.left = rect.left + 'px';
      panel.style.top = rect.top + 'px';
      panel.style.width = rect.width + 'px';
      panel.style.height = rect.height + 'px';
      panel.style.zIndex = '100';
      panel.classList.add('floating-panel');
      if (btn) { btn.innerHTML = IC.dock; btn.title = 'Dock'; }
      const handle = document.createElement('div');
      handle.className = 'float-resize-handle';
      panel.appendChild(handle);
      this.initFloatDrag(id, panel);
      this.initFloatResize(id, panel, handle);
      t.floating = true;
      if (this.layout === 'cols') this.addColSplitters();
    } else {
      const header = panel.querySelector('.term-header');
      if (t._floatDragHandler && header) {
        header.removeEventListener('mousedown', t._floatDragHandler);
        t._floatDragHandler = null;
      }
      panel.style.position = '';
      panel.style.left = '';
      panel.style.top = '';
      panel.style.width = '';
      panel.style.height = '';
      panel.style.zIndex = '';
      panel.classList.remove('floating-panel');
      if (btn) { btn.innerHTML = IC.float; btn.title = 'Float'; }
      const handle = panel.querySelector('.float-resize-handle');
      if (handle) handle.remove();
      t.floating = false;
      setTimeout(() => this.fitAndSync(id), 100);
      if (this.layout === 'cols') this.addColSplitters();
    }
  }

  initFloatDrag(id, panel) {
    const header = panel.querySelector('.term-header');
    const t = this.terms.get(id);
    const onDown = (e) => {
      if (e.target.closest('.term-actions') || e.target.closest('.term-name')) return;
      e.preventDefault();
      const startX = e.clientX;
      const startY = e.clientY;
      const startL = parseInt(panel.style.left);
      const startT = parseInt(panel.style.top);
      const onMove = (ev) => {
        document.body.classList.add('float-dragging');
        panel.style.left = (startL + ev.clientX - startX) + 'px';
        panel.style.top = (startT + ev.clientY - startY) + 'px';
      };
      const onUp = () => {
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
        document.body.classList.remove('float-dragging');
      };
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    };
    if (t) t._floatDragHandler = onDown;
    header.addEventListener('mousedown', onDown);
  }

  initFloatResize(id, panel, handle) {
    handle.addEventListener('mousedown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const startX = e.clientX;
      const startY = e.clientY;
      const startW = panel.offsetWidth;
      const startH = panel.offsetHeight;
      const onMove = (ev) => {
        document.body.classList.add('float-resizing');
        panel.style.width = Math.max(400, startW + ev.clientX - startX) + 'px';
        panel.style.height = Math.max(250, startH + ev.clientY - startY) + 'px';
      };
      const onUp = () => {
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
        document.body.classList.remove('float-resizing');
        this.fitAndSync(id);
      };
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    });
  }

  popOut(id) {
    const t = this.terms.get(id);
    if (!t) return;
    const w = window.open(
      `/popout.html?id=${id}&name=${encodeURIComponent(t.name)}`,
      `terminal-${id}`,
      'width=900,height=600,menubar=no,toolbar=no,location=no,status=no'
    );
    if (!w) this.toast('Pop-up blocked. Allow pop-ups for this site.');
  }

  emptyState() {
    const c = document.getElementById('terminals-container');
    const ex = c.querySelector('.empty-state');
    const vis = [...this.terms.values()].filter(t => t.visible).length;
    if (vis === 0) {
      if (!ex) {
        const d = document.createElement('div');
        d.className = 'empty-state';
        const min = this.terms.size > 0;
        d.innerHTML = `
          <svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="3"/><circle cx="5" cy="6" r="2"/><circle cx="19" cy="6" r="2"/><circle cx="5" cy="18" r="2"/><circle cx="19" cy="18" r="2"/><line x1="7" y1="7" x2="10" y2="10"/><line x1="17" y1="7" x2="14" y2="10"/><line x1="7" y1="17" x2="10" y2="14"/><line x1="17" y1="17" x2="14" y2="14"/></svg>
          <p>${min ? 'All terminals are minimized' : 'No active instances'}</p>
          <p>${min ? 'Click an instance in the sidebar' : 'Click <strong>+ Claude Code</strong> to get started'}</p>`;
        c.appendChild(d);
      }
    } else ex?.remove();
  }

  updateAddButtons() {
    const dis = this.terms.size >= MAX_TERMS;
    document.getElementById('btn-add-claude').disabled = dis;
    document.getElementById('btn-add-shell').disabled = dis;
    document.getElementById('btn-add-powershell').disabled = dis;
  }

  toggleSearch(id) {
    const panel = document.getElementById(`term-${id}`);
    const bar = panel?.querySelector('.term-search');
    const t = this.terms.get(id);
    if (!bar || !t) return;
    const visible = !bar.classList.contains('hidden');
    if (visible) {
      bar.classList.add('hidden');
      if (t.search) t.search.clearDecorations();
      const cnt = bar.querySelector('.search-count');
      if (cnt) cnt.textContent = '';
      t.xterm.focus();
    } else {
      bar.classList.remove('hidden');
      const inp = bar.querySelector('input');
      inp.focus();
      inp.select();
    }
  }

  toggleLock(id) {
    const t = this.terms.get(id);
    if (!t) return;
    t.locked = !t.locked;
    const btn = document.querySelector(`#term-${id} .act-lock`);
    if (btn) {
      btn.innerHTML = t.locked ? IC.unlock : IC.lock;
      btn.title = t.locked ? 'Unlock input' : 'Lock input';
      btn.classList.toggle('is-locked', t.locked);
    }
    const panel = document.getElementById(`term-${id}`);
    if (panel) panel.classList.toggle('term-locked', t.locked);
    this.sidebar();
  }

  exportTerminal(id) {
    const t = this.terms.get(id);
    if (!t) return;
    const buf = t.xterm.buffer.active;
    let text = '';
    for (let i = 0; i < buf.length; i++) {
      const line = buf.getLine(i);
      if (line) text += line.translateToString(true) + '\n';
    }
    const blob = new Blob([text], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${t.name.replace(/[^a-zA-Z0-9]/g, '_')}_${new Date().toISOString().slice(0, 19).replace(/:/g, '-')}.txt`;
    a.click();
    URL.revokeObjectURL(url);
    this.toast('Output exported');
  }

  getVisibleIds() {
    return [...this.terms.entries()].filter(([, t]) => t.visible).map(([id]) => id);
  }

  focusTermByOffset(offset) {
    const ids = this.getVisibleIds();
    if (!ids.length) return;
    const active = document.activeElement?.closest('.terminal-panel');
    let idx = active ? ids.indexOf(parseInt(active.id.replace('term-', ''))) : -1;
    if (idx === -1) idx = 0;
    else idx = (idx + offset + ids.length) % ids.length;
    const targetId = ids[idx];
    if (this.layout === 'tabs') this.setTab(targetId);
    else this.terms.get(targetId)?.xterm.focus();
  }

  saveWorkspace() {
    const terminals = [];
    for (const [, t] of this.terms) {
      terminals.push({ command: termType(t), name: t.name });
    }
    localStorage.setItem('orchestra-workspace', JSON.stringify({ layout: this.layout, terminals }));
  }

  restoreWorkspace() {
    if (this.restoring || this.terms.size > 0) return;
    const raw = localStorage.getItem('orchestra-workspace');
    if (!raw) return;
    try {
      const { layout, terminals } = JSON.parse(raw);
      if (!terminals?.length) return;
      this.restoring = true;
      if (layout) this.setLayout(layout);
      for (const { command, name } of terminals) {
        this.tx({ type: 'create', command, name, cols: 120, rows: 30 });
      }
      setTimeout(() => { this.restoring = false; }, 3000);
    } catch {}
  }
}

addEventListener('DOMContentLoaded', () => window.app = new Orchestra());
