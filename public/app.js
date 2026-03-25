const IC = {
  min:     '<svg viewBox="0 0 24 24"><line x1="5" y1="18" x2="19" y2="18"/></svg>',
  restore: '<svg viewBox="0 0 24 24"><rect x="5" y="5" width="14" height="14" rx="2"/></svg>',
  close:   '<svg viewBox="0 0 24 24"><line x1="6" y1="6" x2="18" y2="18"/><line x1="18" y1="6" x2="6" y2="18"/></svg>',
  restart: '<svg viewBox="0 0 24 24"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg>',
};

function fmtTok(n) {
  if (n == null) return '-';
  if (n >= 1e9) return (n / 1e9).toFixed(2) + 'B tok';
  if (n >= 1e6) return (n / 1e6).toFixed(2) + 'M tok';
  if (n >= 1e3) return (n / 1e3).toFixed(1) + 'K tok';
  return n + ' tok';
}

class Orchestra {
  constructor() {
    this.ws = null;
    this.terms = new Map();
    this.activeTab = null;
    this.layout = 'grid';
    this.broadcast = false;
    this.IDLE_MS = 3000;
    this.init();
  }

  init() {
    this.connect();
    this.bind();
    this.loadUsage();
    this.requestNotifPermission();
  }

  requestNotifPermission() {
    if ('Notification' in window && Notification.permission === 'default') {
      Notification.requestPermission();
    }
  }

  notify(title, body) {
    if (!document.hidden) return;
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
    this.ws.onmessage = e => this.onMsg(JSON.parse(e.data));
    this.ws.onclose = () => setTimeout(() => this.connect(), 2000);
  }

  tx(d) { if (this.ws?.readyState === 1) this.ws.send(JSON.stringify(d)); }

  onMsg(m) {
    if (m.type === 'created') this.onCreated(m.id, m.name);
    else if (m.type === 'output') this.onOutput(m.id, m.data);
    else if (m.type === 'exit') this.onExit(m.id, m.exitCode);
  }

  async loadUsage() {
    const el = document.getElementById('usage-content');
    try {
      const r = await fetch('/api/stats');
      const d = await r.json();
      if (!d) { el.innerHTML = '<div class="usage-loading">Aucune donnee</div>'; return; }
      this.renderUsage(d);
    } catch { el.innerHTML = '<div class="usage-loading">Erreur</div>'; }
  }

  renderUsage({ cached, recent }) {
    const el = document.getElementById('usage-content');
    const models = {};

    for (const [n, m] of Object.entries(cached?.modelUsage || {})) {
      const s = n.replace('claude-', '').replace(/-\d{8}$/, '');
      models[s] = { i: m.inputTokens || 0, o: m.outputTokens || 0, cr: m.cacheReadInputTokens || 0, cc: m.cacheCreationInputTokens || 0 };
    }
    if (recent?.week) {
      for (const [n, m] of Object.entries(recent.week.models || {})) {
        const s = n.replace('claude-', '').replace(/-\d{8}$/, '');
        if (!models[s]) models[s] = { i: 0, o: 0, cr: 0, cc: 0 };
        models[s].i += m.input || 0;
        models[s].o += m.output || 0;
        models[s].cr += m.cacheRead || 0;
        models[s].cc += m.cacheCreate || 0;
      }
    }

    const entries = Object.entries(models);
    if (!entries.length) { el.innerHTML = '<div class="usage-loading">Aucune donnee</div>'; return; }
    const maxO = Math.max(...entries.map(([, m]) => m.o), 1);
    let h = '';
    for (const [name, m] of entries) {
      const pct = (m.o / maxO) * 100;
      h += `<div class="usage-model-section">
        <div class="usage-model-name">${name}</div>
        <div class="usage-row"><span class="usage-row-label">Input</span><span class="usage-row-value">${fmtTok(m.i)}</span></div>
        <div class="usage-row"><span class="usage-row-label">Output</span><span class="usage-row-value">${fmtTok(m.o)}</span></div>
        <div class="usage-bar-track"><div class="usage-bar-fill" style="width:${pct}%"></div></div>
        ${m.cr > 0 ? `<div class="usage-row"><span class="usage-row-label">Cache read</span><span class="usage-row-value">${fmtTok(m.cr)}</span></div>` : ''}
        ${m.cc > 0 ? `<div class="usage-row"><span class="usage-row-label">Cache write</span><span class="usage-row-value">${fmtTok(m.cc)}</span></div>` : ''}
      </div>`;
    }
    el.innerHTML = h;
  }

  bind() {
    document.getElementById('btn-add-claude').onclick = () => this.create('claude');
    document.getElementById('btn-add-shell').onclick = () => this.create('shell');
    document.querySelectorAll('.layout-btn').forEach(b => b.onclick = () => this.setLayout(b.dataset.layout));
    document.getElementById('broadcast-mode').onchange = e => {
      this.broadcast = e.target.checked;
      document.getElementById('broadcast-bar').classList.toggle('hidden', !this.broadcast);
    };
    document.getElementById('broadcast-send').onclick = () => this.sendBroadcast();
    document.getElementById('broadcast-input').onkeydown = e => { if (e.key === 'Enter') this.sendBroadcast(); };
    document.getElementById('btn-refresh-usage').onclick = () => this.loadUsage();
    this.emptyState();
  }

  autoLayout() {
    const vis = [...this.terms.values()].filter(t => t.visible).length;
    const next = vis <= 1 ? 'grid' : vis === 2 ? 'cols' : 'grid';
    if (next !== this.layout) this.setLayout(next);
  }

  create(cmd) {
    const n = cmd === 'claude' ? `Claude ${this.terms.size + 1}` : `Shell ${this.terms.size + 1}`;
    this.tx({ type: 'create', command: cmd, name: n, cols: 120, rows: 30 });
  }

  onCreated(id, name) {
    const isClaude = name.toLowerCase().includes('claude');
    const xterm = new window.Terminal({
      theme: {
        background: '#09090b', foreground: '#fafafa',
        cursor: '#d4a574', cursorAccent: '#09090b',
        selectionBackground: 'rgba(212,165,116,.2)',
        black: '#18181b', red: '#ef4444', green: '#22c55e', yellow: '#eab308',
        blue: '#3b82f6', magenta: '#a855f7', cyan: '#06b6d4', white: '#e4e4e7',
        brightBlack: '#3f3f46', brightRed: '#f87171', brightGreen: '#4ade80',
        brightYellow: '#facc15', brightBlue: '#60a5fa', brightMagenta: '#c084fc',
        brightCyan: '#22d3ee', brightWhite: '#ffffff',
      },
      fontSize: 13,
      fontFamily: "'SF Mono','Fira Code','JetBrains Mono',monospace",
      cursorBlink: true,
      scrollback: 10000,
      allowProposedApi: true,
    });
    const fit = new window.FitAddon.FitAddon();
    xterm.loadAddon(fit);
    xterm.loadAddon(new window.WebLinksAddon.WebLinksAddon());

    this.terms.set(id, { xterm, fit, name, alive: true, isClaude, visible: true, status: 'idle', timer: null, ro: null });
    this.buildPanel(id, name, isClaude);

    const body = document.querySelector(`#term-${id} .term-body`);
    xterm.open(body);
    requestAnimationFrame(() => { fit.fit(); this.tx({ type: 'resize', id, cols: xterm.cols, rows: xterm.rows }); });

    xterm.onData(d => {
      if (this.broadcast) this.tx({ type: 'broadcast', data: d });
      else this.tx({ type: 'input', id, data: d });
    });

    let rt;
    const ro = new ResizeObserver(() => {
      clearTimeout(rt);
      rt = setTimeout(() => { const t = this.terms.get(id); if (t?.visible) { try { t.fit.fit(); this.tx({ type: 'resize', id, cols: t.xterm.cols, rows: t.xterm.rows }); } catch {} } }, 80);
    });
    ro.observe(body);
    this.terms.get(id).ro = ro;

    this.autoLayout();
    this.sidebar();
    this.emptyState();
  }

  buildPanel(id, name, isClaude) {
    const c = document.getElementById('terminals-container');
    const p = document.createElement('div');
    p.className = 'terminal-panel tab-active';
    p.id = `term-${id}`;
    const badge = isClaude ? 'claude' : 'shell';
    const label = isClaude ? 'CLAUDE' : 'SHELL';
    p.innerHTML = `
      <div class="term-header">
        <div class="term-header-left">
          <div class="term-status"></div>
          <input class="term-name" value="${name}" spellcheck="false">
          <span class="term-badge ${badge}">${label}</span>
        </div>
        <div class="term-actions">
          <button class="act-restart" title="Redemarrer">${IC.restart}</button>
          <button class="act-min" title="Minimiser">${IC.min}</button>
          <button class="act-kill" title="Fermer">${IC.close}</button>
        </div>
      </div>
      <div class="term-body"></div>
      <div class="term-input">
        <input type="text" placeholder="Commande rapide...">
        <button>Envoyer</button>
      </div>`;
    c.appendChild(p);

    p.querySelector('.act-kill').onclick = () => this.kill(id);
    p.querySelector('.act-min').onclick = () => this.toggle(id);
    p.querySelector('.act-restart').onclick = () => this.restart(id);

    const qi = p.querySelector('.term-input input');
    const qb = p.querySelector('.term-input button');
    const go = () => { if (qi.value) { this.tx({ type: 'input', id, data: qi.value + '\n' }); qi.value = ''; } };
    qb.onclick = go;
    qi.onkeydown = e => { if (e.key === 'Enter') go(); };
    p.querySelector('.term-name').onchange = e => { const t = this.terms.get(id); if (t) { t.name = e.target.value; this.sidebar(); } };
  }

  onOutput(id, data) {
    const t = this.terms.get(id);
    if (!t) return;
    t.xterm.write(data);
    this.markBusy(id);
  }

  markBusy(id) {
    const t = this.terms.get(id);
    if (!t?.alive) return;
    const was = t.status !== 'busy';
    t.status = 'busy';
    clearTimeout(t.timer);
    t.timer = setTimeout(() => { if (t.alive) { t.status = 'idle'; this.statusUI(id); this.notify(`${t.name} a termine`, 'Le terminal est en attente de nouvelles instructions.'); } }, this.IDLE_MS);
    if (was) this.statusUI(id);
  }

  statusUI(id) {
    const t = this.terms.get(id);
    if (!t) return;
    const el = document.querySelector(`#term-${id} .term-status`);
    if (el) el.className = `term-status is-${t.status}`;
    this.sidebar();
  }

  onExit(id, code) {
    const t = this.terms.get(id);
    if (!t) return;
    const wasBusy = t.status === 'busy';
    t.alive = false; t.status = 'dead';
    clearTimeout(t.timer);
    t.xterm.write(`\r\n\x1b[31m[exited ${code}]\x1b[0m\r\n`);
    this.statusUI(id);
    if (wasBusy) this.notify(`${t.name} s'est arrete`, `Le processus s'est termine avec le code ${code}.`);
  }

  toggle(id) {
    const t = this.terms.get(id);
    if (!t) return;
    t.visible = !t.visible;
    const p = document.getElementById(`term-${id}`);
    if (p) p.classList.toggle('hidden-panel', !t.visible);
    this.autoLayout();
    if (t.visible) setTimeout(() => { try { t.fit.fit(); } catch {} this.tx({ type: 'resize', id, cols: t.xterm.cols, rows: t.xterm.rows }); t.xterm.focus(); }, 150);
    this.refit();
    this.sidebar();
    this.emptyState();
  }

  kill(id) {
    this.tx({ type: 'kill', id });
    const t = this.terms.get(id);
    if (t) { clearTimeout(t.timer); t.ro?.disconnect(); t.xterm.dispose(); }
    this.terms.delete(id);
    document.getElementById(`term-${id}`)?.remove();
    this.autoLayout();
    this.refit();
    this.sidebar();
    this.emptyState();
  }

  restart(id) {
    const t = this.terms.get(id);
    if (!t) return;
    const { isClaude, name } = t;
    this.kill(id);
    setTimeout(() => this.tx({ type: 'create', command: isClaude ? 'claude' : 'shell', name, cols: 120, rows: 30 }), 300);
  }

  refit() {
    setTimeout(() => {
      for (const [id, t] of this.terms) {
        if (t.visible) { try { t.fit.fit(); this.tx({ type: 'resize', id, cols: t.xterm.cols, rows: t.xterm.rows }); } catch {} }
      }
    }, 200);
  }

  sendBroadcast() {
    const i = document.getElementById('broadcast-input');
    if (i.value) { this.tx({ type: 'broadcast', data: i.value + '\n' }); i.value = ''; }
  }

  setLayout(l) {
    this.layout = l;
    document.getElementById('terminals-container').className = `layout-${l}`;
    document.querySelectorAll('.layout-btn').forEach(b => b.classList.toggle('active', b.dataset.layout === l));
    document.body.classList.toggle('layout-tabs-mode', l === 'tabs');
    if (l === 'tabs') {
      const first = [...this.terms.entries()].find(([, t]) => t.visible);
      if (first && !this.activeTab) this.setTab(first[0]);
      else if (this.activeTab) this.setTab(this.activeTab);
    } else {
      document.querySelectorAll('.terminal-panel').forEach(p => { if (!p.classList.contains('hidden-panel')) p.classList.add('tab-active'); });
    }
    this.refit();
  }

  setTab(id) {
    this.activeTab = id;
    document.querySelectorAll('.terminal-panel').forEach(p => {
      const tid = parseInt(p.id.replace('term-', ''));
      const t = this.terms.get(tid);
      if (t?.visible) p.classList.toggle('tab-active', p.id === `term-${id}`);
    });
    const t = this.terms.get(id);
    if (t) setTimeout(() => { try { t.fit.fit(); } catch {} t.xterm.focus(); }, 50);
    this.sidebar();
  }

  sidebar() {
    const list = document.getElementById('sidebar-list');
    list.innerHTML = '';
    for (const [id, t] of this.terms) {
      const el = document.createElement('div');
      el.className = `sidebar-item status-${t.status}`;
      if (!t.visible) el.classList.add('minimized');
      if (id === this.activeTab && this.layout === 'tabs') el.classList.add('active');

      const st = t.status === 'busy' ? 'En cours' : t.status === 'dead' ? 'Termine' : 'En attente';
      const badge = t.isClaude ? 'claude' : 'shell';
      const label = t.isClaude ? 'CLAUDE' : 'SHELL';
      const tIcon = t.visible ? IC.min : IC.restore;

      el.innerHTML = `
        <div class="si-status"></div>
        <div class="si-info">
          <div class="si-name">${t.name}</div>
          <div class="si-meta">
            <span class="si-badge ${badge}">${label}</span>
            <span class="si-status-text">${st}</span>
            ${!t.visible ? '<span style="color:var(--yellow);font-size:9px">minimise</span>' : ''}
          </div>
        </div>
        <div class="si-actions">
          <button class="act-toggle" title="${t.visible ? 'Minimiser' : 'Restaurer'}">${tIcon}</button>
          <button class="act-kill" title="Fermer">${IC.close}</button>
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
          <p>${min ? 'Tous les terminaux sont minimises' : 'Aucune instance active'}</p>
          <p>${min ? 'Cliquez sur une instance dans la sidebar' : 'Cliquez sur <strong>+ Claude Code</strong> pour commencer'}</p>`;
        c.appendChild(d);
      }
    } else ex?.remove();
  }
}

addEventListener('DOMContentLoaded', () => window.app = new Orchestra());
