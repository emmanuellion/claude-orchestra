/**
 * The roster of the swarm, built to answer "which of my agents is stuck?".
 * A row does not say "running", it says "Bash: npm test" with a clock.
 *
 * Rendering is incremental by contract: one row per session, kept alive across
 * updates, subscribed individually to `session:<id>`. A session changing never
 * touches another session's DOM, and the drag listeners are attached to the
 * container once, at construction, not on every paint.
 */

import { el, clear } from './dom.js';
import { C2S, STATUS, KIND } from './protocol.js';

/** A tool running longer than this on a busy agent is treated as stuck. */
export const STALL_MS = 120000;

export const TAG_COLORS = ['none', 'red', 'orange', 'yellow', 'green', 'blue', 'purple', 'pink'];

const PREF = {
  ORDER: 'sidebar.order',
  SORT: 'sidebar.sort',
  TAG_FILTER: 'sidebar.tagFilter',
  ARGS: 'sidebar.args',
  CWD: 'sidebar.cwd',
};

const KIND_LABEL = {
  [KIND.CLAUDE]: 'claude',
  [KIND.SHELL]: 'shell',
  [KIND.POWERSHELL]: 'pwsh',
};

const STATUS_LABEL = {
  [STATUS.STARTING]: 'Starting',
  [STATUS.IDLE]: 'Idle',
  [STATUS.BUSY]: 'Working',
  [STATUS.AWAITING_INPUT]: 'Asked a question',
  [STATUS.AWAITING_PERMISSION]: 'Waiting for permission',
  [STATUS.EXITED]: 'Exited',
};

/**
 * Urgency classes, lowest first: humans blocking agents, then agents blocking
 * themselves, then everything that can wait.
 */
const RANK = {
  permission: 0,
  question: 1,
  stalled: 2,
  tool: 3,
  busy: 3,
  starting: 3,
  idle: 4,
  exited: 5,
};

export function basename(p) {
  if (typeof p !== 'string' || !p) return '';
  const parts = p.split(/[\\/]+/).filter(Boolean);
  return parts.length ? parts[parts.length - 1] : p;
}

function pad2(n) {
  return n < 10 ? '0' + n : String(n);
}

/** Precise elapsed time, for anything a human is actively waiting on. */
export function formatDuration(ms) {
  if (!Number.isFinite(ms) || ms < 0) return '';
  const s = Math.floor(ms / 1000);
  if (s < 60) return s + 's';
  const m = Math.floor(s / 60);
  if (m < 60) return m + 'm' + pad2(s % 60);
  const h = Math.floor(m / 60);
  if (h < 24) return h + 'h' + pad2(m % 60);
  const d = Math.floor(h / 24);
  return d + 'd' + (h % 24) + 'h';
}

/** Coarse elapsed time, for things nobody is waiting on. */
export function formatDurationShort(ms) {
  if (!Number.isFinite(ms) || ms < 0) return '';
  const s = Math.floor(ms / 1000);
  if (s < 60) return s + 's';
  const m = Math.floor(s / 60);
  if (m < 60) return m + 'm';
  const h = Math.floor(m / 60);
  if (h < 24) return h + 'h';
  return Math.floor(h / 24) + 'd';
}

export function formatCost(value) {
  const v = Number(value);
  if (!Number.isFinite(v) || v <= 0) return '';
  if (v < 100) return '$' + v.toFixed(2);
  return '$' + Math.round(v);
}

export function formatTokens(value) {
  const v = Number(value);
  if (!Number.isFinite(v) || v <= 0) return '0';
  if (v < 1000) return String(Math.round(v));
  if (v < 1e6) return (v / 1000).toFixed(v < 10000 ? 1 : 0) + 'k';
  return (v / 1e6).toFixed(1) + 'M';
}

export function formatClock(ts) {
  const n = Number(ts);
  if (!Number.isFinite(n) || n <= 0) return '';
  const d = new Date(n);
  return pad2(d.getHours()) + ':' + pad2(d.getMinutes()) + ':' + pad2(d.getSeconds());
}

/**
 * What this agent is doing right now, in one line.
 *
 * @param {number} now  epoch ms, passed in so a whole list shares one clock
 * @param {Object|null} approval  the oldest pending approval for this session
 * @returns {{kind:string, key:string, label:string, detail:string,
 *            since:number|null, long:boolean, urgent:boolean}}
 */
export function describeActivity(session, now = Date.now(), approval = null) {
  if (!session) {
    return { kind: 'idle', key: 'idle', label: 'Idle', detail: 'Idle', since: null, long: false, urgent: false };
  }
  const agent = session.agent || {};
  const status = session.status;

  if (status === STATUS.EXITED) {
    const label = session.exitCode ? `Exited (${session.exitCode})` : 'Exited';
    return { kind: 'exited', key: 'exited|' + label, label, detail: label, since: session.exitedAt || null, long: false, urgent: false };
  }

  if (approval || status === STATUS.AWAITING_PERMISSION) {
    const tool = (approval && approval.tool) || agent.tool;
    const label = tool ? `Waiting for permission: ${tool}` : 'Waiting for permission';
    const detail = (approval && approval.summary) || label;
    const since = approval ? approval.createdAt : (agent.lastEventAt || session.lastActivityAt || null);
    // `approval` is carried through so urgencyRank can weigh what the action
    // would actually do, not just that something is blocked.
    return { kind: 'permission', key: 'permission|' + label + '|' + detail, label, detail, since, long: true, urgent: true, approval };
  }

  if (status === STATUS.AWAITING_INPUT) {
    const question = agent.lastQuestion || '';
    const since = agent.lastEventAt || session.lastActivityAt || null;
    return {
      kind: 'question',
      key: 'question|' + question,
      label: 'Asked a question',
      detail: question || 'Asked a question',
      since,
      long: true,
      urgent: true,
    };
  }

  if (status === STATUS.STARTING) {
    return { kind: 'starting', key: 'starting', label: 'Starting', detail: 'Starting', since: session.createdAt || null, long: false, urgent: false };
  }

  if (status === STATUS.BUSY) {
    if (agent.tool) {
      const label = agent.toolDetail ? `${agent.tool}: ${agent.toolDetail}` : String(agent.tool);
      const since = agent.toolStartedAt || agent.lastEventAt || null;
      const stalled = since !== null && now - since > STALL_MS;
      const kind = stalled ? 'stalled' : 'tool';
      return { kind, key: kind + '|' + label, label, detail: label, since, long: true, urgent: stalled };
    }
    return { kind: 'busy', key: 'busy', label: 'Working', detail: 'Working', since: session.lastActivityAt || null, long: true, urgent: false };
  }

  const since = session.lastActivityAt || session.createdAt || null;
  return { kind: 'idle', key: 'idle', label: 'Idle', detail: 'Idle', since, long: false, urgent: false };
}

/**
 * How much it costs to keep an agent waiting.
 *
 * Ranking by event kind alone puts a pending `Read` and a pending
 * `git push --force` on the same line and lets wait time decide between them.
 * What matters instead is what the action would do if you approved it without
 * looking. The score is a fraction added to the coarse rank, so a dangerous
 * permission sorts above a harmless one without crossing into another class.
 */
const DESTRUCTIVE = [
  /\brm\s+-[a-z]*[rf]/i,
  /\bgit\s+push\b[^\n]*--force|\bgit\s+push\s+-f\b/i,
  /\bgit\s+(reset\s+--hard|clean\s+-[a-z]*f)/i,
  /\b(drop|truncate)\s+(table|database|schema)\b/i,
  /\b(kubectl|docker)\s+(delete|rm|prune)\b/i,
  /\b(shutdown|reboot|mkfs|dd\s+if=)/i,
  /\bnpm\s+(publish|unpublish)\b|\bcargo\s+publish\b|\btwine\s+upload\b/i,
  /\bterraform\s+(apply|destroy)\b/i,
  /\b(chmod|chown)\s+-R\b/i,
  /\bcurl\b[^\n|]*\|\s*(ba)?sh\b/i,
];
// The leading class allows a bare relative path after a space or a quote, not
// just one preceded by a separator: approval summaries routinely read
// "Read: .env" with no directory in front of it.
const SENSITIVE_PATH = /(^|[\s"'`([\\/])\.(env|npmrc|aws|ssh|gnupg|kube|netrc)\b|credentials|secrets?\b|id_rsa|\.pem\b/i;
const READ_ONLY_TOOLS = new Set(['Read', 'Glob', 'Grep', 'NotebookRead', 'TodoWrite', 'WebSearch']);

/** @returns {number} 0 for the most dangerous, up to 0.9 for read-only */
export function blastRadius(approval) {
  if (!approval) return 0.5;
  const tool = String(approval.tool || '');
  const text = `${approval.summary || ''} ${approval.detail || ''}`;

  if (DESTRUCTIVE.some(re => re.test(text))) return 0;
  if (SENSITIVE_PATH.test(text)) return 0.1;
  if (tool === 'Bash') return 0.3;
  if (tool === 'Write' || tool === 'Edit' || tool === 'NotebookEdit') return 0.4;
  if (tool === 'WebFetch') return 0.6;
  if (READ_ONLY_TOOLS.has(tool)) return 0.9;
  return 0.5;
}

export function urgencyRank(activity) {
  const rank = RANK[activity && activity.kind];
  const base = Number.isFinite(rank) ? rank : 4;
  if (base === 0 && activity && activity.approval) {
    return base + blastRadius(activity.approval);
  }
  return base;
}

/**
 * Comparator for urgency sort. Inside the blocking ranks the oldest wait comes
 * first, because the agent that has been stuck for eleven minutes matters more
 * than the one that stopped four seconds ago. Inside the running ranks it is
 * the reverse: freshest first.
 */
function compareUrgency(a, b, now) {
  const ra = urgencyRank(a.activity);
  const rb = urgencyRank(b.activity);
  if (ra !== rb) return ra - rb;
  const sa = a.activity.since === null ? now : a.activity.since;
  const sb = b.activity.since === null ? now : b.activity.since;
  if (sa !== sb) return ra <= 2 ? sa - sb : sb - sa;
  return a.index - b.index;
}

function warnOnce(seen, message) {
  if (seen.has(message)) return;
  seen.add(message);
  console.warn('[orchestra/sidebar] ' + message);
}

export class Sidebar {
  /**
   * @param {HTMLElement} root  container, typically #sidebar-root
   * @param {Object} deps.store        reactive store (see module docs)
   * @param {Object} deps.connection   WebSocket wrapper with send(msg)
   * @param {Object} [deps.actions]    app level callbacks
   */
  constructor(root, { store, connection, actions } = {}) {
    if (!root) throw new Error('Sidebar needs a root element');
    if (!store) throw new Error('Sidebar needs a store');

    this.root = root;
    this.store = store;
    this.connection = connection || null;
    this.actions = actions || {};

    this._warned = new Set();
    this._rows = new Map();
    this._unsubs = [];
    this._approvals = new Map();
    this._projects = [];
    this._domOrder = '';
    this._editing = null;
    this._dragId = null;
    this._dropBefore = null;
    this._menu = null;
    this._timer = null;
    this._localPrefs = new Map();

    this._sortMode = this._pref(PREF.SORT, 'urgency') === 'manual' ? 'manual' : 'urgency';
    this._tagFilter = new Set(this._normalizeFilter(this._pref(PREF.TAG_FILTER, [])));
    this._activeId = this._readActiveId();

    this._build();
    this._bindDelegates();
    this._readApprovals();
    this._readProjects();
    this._renderList();

    this._subscribe('sessions', () => this._renderList());
    this._subscribe('approvals', () => { this._readApprovals(); this._renderList(); });
    this._subscribe('projects', () => { this._readProjects(); this._renderProjects(); });
    this._subscribe('prefs', () => this._syncFromPrefs());
    this._subscribe('active', id => this._setActive(id));

    this._timer = setInterval(() => this._tick(), 1000);
  }

  destroy() {
    clearInterval(this._timer);
    this._timer = null;
    this._closeMenu();
    for (const off of this._unsubs) off();
    this._unsubs.length = 0;
    for (const entry of this._rows.values()) entry.dispose();
    this._rows.clear();
    clear(this.root);
  }

  _subscribe(topic, handler) {
    if (typeof this.store.subscribe !== 'function') {
      warnOnce(this._warned, 'store.subscribe is missing, the sidebar will not update');
      return;
    }
    const off = this.store.subscribe(topic, handler);
    this._unsubs.push(typeof off === 'function' ? off : () => {});
  }

  _sessions() {
    if (typeof this.store.getSessions !== 'function') {
      warnOnce(this._warned, 'store.getSessions is missing');
      return [];
    }
    const list = this.store.getSessions();
    return Array.isArray(list) ? list : [];
  }

  _session(id) {
    if (typeof this.store.getSession === 'function') return this.store.getSession(id);
    return this._sessions().find(s => s.id === id) || null;
  }

  _pref(key, fallback) {
    if (typeof this.store.getPref === 'function') {
      const value = this.store.getPref(key, fallback);
      return value === undefined ? fallback : value;
    }
    warnOnce(this._warned, 'store.getPref is missing, preferences stay in memory');
    return this._localPrefs.has(key) ? this._localPrefs.get(key) : fallback;
  }

  _setPref(key, value) {
    this._localPrefs.set(key, value);
    if (typeof this.store.setPref === 'function') {
      this.store.setPref(key, value);
      return;
    }
    warnOnce(this._warned, 'store.setPref is missing, preferences stay in memory');
  }

  _send(msg) {
    if (this.connection && typeof this.connection.send === 'function') {
      this.connection.send(msg);
      return true;
    }
    warnOnce(this._warned, 'connection.send is missing, cannot reach the server');
    return false;
  }

  _act(name, ...args) {
    const fn = this.actions[name];
    if (typeof fn === 'function') {
      fn(...args);
      return true;
    }
    warnOnce(this._warned, `actions.${name} is not wired`);
    return false;
  }

  _build() {
    clear(this.root);

    const shell = el('div', { class: 'sb' });

    const head = el('div', { class: 'sb-head' });

    const launch = el('div', { class: 'sb-launch' });
    this.newBtn = el('button', { class: 'sb-new', text: 'New agent' });
    this.newBtn.type = 'button';
    this.newBtn.title = 'Start a Claude agent in the selected project';

    this.projectSel = el('select', { class: 'sb-project' });
    this.projectSel.title = 'Working directory for the next agent';

    // Left empty, the server names the session after its project. The field is
    // there for when two agents on one repo do different jobs.
    this.nameInput = el('input', { class: 'sb-name-input' });
    this.nameInput.type = 'text';
    this.nameInput.placeholder = 'Name (optional)';
    this.nameInput.spellcheck = false;
    this.nameInput.title = 'Leave empty to name it after the project';

    this.argsInput = el('input', { class: 'sb-args' });
    this.argsInput.type = 'text';
    this.argsInput.placeholder = 'Extra claude arguments';
    this.argsInput.value = String(this._pref(PREF.ARGS, '') || '');
    this.argsInput.spellcheck = false;

    launch.append(this.newBtn, this.projectSel, this.nameInput, this.argsInput);

    const tools = el('div', { class: 'sb-tools' });
    this.sortBtn = el('button', { class: 'sb-sort' });
    this.sortBtn.type = 'button';
    this.filterBar = el('div', { class: 'sb-filter' });
    tools.append(this.sortBtn, this.filterBar);

    head.append(launch, tools);

    this.listEl = el('div', { class: 'sb-list' });
    this.listEl.setAttribute('role', 'list');

    this.emptyEl = el('div', { class: 'sb-empty', text: 'No agent yet. Start one above.' });
    this.emptyEl.hidden = true;

    const foot = el('div', { class: 'sb-foot' });
    this.broadcastForm = el('form', { class: 'sb-broadcast' });
    this.broadcastInput = el('input', { class: 'sb-broadcast-input' });
    this.broadcastInput.type = 'text';
    this.broadcastSend = el('button', { class: 'sb-broadcast-send', text: 'Send' });
    this.broadcastSend.type = 'submit';
    this.broadcastForm.append(this.broadcastInput, this.broadcastSend);

    this.countsEl = el('div', { class: 'sb-counts' });
    this.countTotal = el('span', { class: 'sb-count' });
    this.countAlert = el('button', { class: 'sb-count sb-count-alert' });
    this.countAlert.type = 'button';
    this.countAlert.title = 'Open supervision';
    this.countAlert.hidden = true;
    this.countsEl.append(this.countTotal, this.countAlert);

    foot.append(this.broadcastForm, this.countsEl);

    shell.append(head, this.listEl, this.emptyEl, foot);
    this.root.append(shell);

    this._renderProjects();
    this._renderSortButton();
    this._renderFilterBar();
  }

  _bindDelegates() {
    this.newBtn.addEventListener('click', () => this._newAgent());

    this.projectSel.addEventListener('change', () => {
      const value = this.projectSel.value;
      if (value === '__browse__') {
        this.projectSel.value = String(this._pref(PREF.CWD, '') || '');
        this._act('openLauncher', { cwd: this._pref(PREF.CWD, ''), args: this.argsInput.value });
        return;
      }
      this._setPref(PREF.CWD, value);
    });

    this.argsInput.addEventListener('change', () => this._setPref(PREF.ARGS, this.argsInput.value));

    for (const input of [this.nameInput, this.argsInput]) {
      input.addEventListener('keydown', ev => {
        if (ev.key !== 'Enter') return;
        ev.preventDefault();
        this._newAgent();
      });
    }

    this.sortBtn.addEventListener('click', () => {
      this._sortMode = this._sortMode === 'urgency' ? 'manual' : 'urgency';
      this._setPref(PREF.SORT, this._sortMode);
      this._renderSortButton();
      this._renderList();
    });

    this.broadcastForm.addEventListener('submit', ev => {
      ev.preventDefault();
      this._broadcast();
    });

    this.countAlert.addEventListener('click', () => this._act('setView', 'supervision'));

    // One set of listeners for the whole list, forever: rebinding drag handlers
    // on every render is how a single drop ends up firing twice.
    const list = this.listEl;
    list.addEventListener('click', ev => this._onListClick(ev));
    list.addEventListener('dblclick', ev => this._onListDblClick(ev));
    list.addEventListener('keydown', ev => this._onListKeydown(ev));
    list.addEventListener('focusout', ev => this._onListFocusOut(ev));
    list.addEventListener('dragstart', ev => this._onDragStart(ev));
    list.addEventListener('dragover', ev => this._onDragOver(ev));
    list.addEventListener('dragleave', ev => this._onDragLeave(ev));
    list.addEventListener('drop', ev => this._onDrop(ev));
    list.addEventListener('dragend', () => this._clearDrag());
  }

  _renderSortButton() {
    this.sortBtn.textContent = this._sortMode === 'urgency' ? 'Sort: urgency' : 'Sort: manual';
    this.sortBtn.title = this._sortMode === 'urgency'
      ? 'Blocked agents first. Switch to manual order to drag rows.'
      : 'Your own order, drag to rearrange. Switch to urgency to surface blocked agents.';
    this.sortBtn.dataset.mode = this._sortMode;
    for (const entry of this._rows.values()) entry.root.draggable = this._sortMode === 'manual';
  }

  _renderFilterBar() {
    clear(this.filterBar);
    if (this._tagFilter.size === 0) {
      const hint = el('span', { class: 'sb-filter-hint', text: 'All tags' });
      this.filterBar.append(hint);
      return;
    }
    for (const color of this._tagFilter) {
      const chip = el('button', { class: 'sb-filter-chip' });
      chip.type = 'button';
      chip.dataset.color = color;
      chip.title = `Stop filtering on ${color}`;
      chip.textContent = color;
      chip.addEventListener('click', () => this._toggleTagFilter(color));
      this.filterBar.append(chip);
    }
    const clearBtn = el('button', { class: 'sb-filter-clear', text: 'Clear' });
    clearBtn.type = 'button';
    clearBtn.addEventListener('click', () => {
      this._tagFilter.clear();
      this._setPref(PREF.TAG_FILTER, []);
      this._renderFilterBar();
      this._renderList();
    });
    this.filterBar.append(clearBtn);
  }

  _renderProjects() {
    const selected = String(this._pref(PREF.CWD, '') || '');
    clear(this.projectSel);

    const home = el('option', { text: 'Home directory' });
    home.value = '';
    this.projectSel.append(home);

    for (const project of this._projects) {
      if (!project || typeof project.path !== 'string') continue;
      const label = project.branch
        ? `${project.name || basename(project.path)} (${project.branch})`
        : (project.name || basename(project.path));
      const option = el('option', { text: label });
      option.value = project.path;
      option.title = project.path;
      this.projectSel.append(option);
    }

    if (selected && !this._projects.some(p => p && p.path === selected)) {
      const option = el('option', { text: basename(selected) });
      option.value = selected;
      option.title = selected;
      this.projectSel.append(option);
    }

    const browse = el('option', { text: 'Browse...' });
    browse.value = '__browse__';
    this.projectSel.append(browse);

    this.projectSel.value = selected;
  }

  _readProjects() {
    if (typeof this.store.getProjects !== 'function') {
      this._projects = [];
      return;
    }
    const list = this.store.getProjects();
    this._projects = Array.isArray(list) ? list : [];
  }

  _readApprovals() {
    this._approvals = new Map();
    if (typeof this.store.getApprovals !== 'function') {
      warnOnce(this._warned, 'store.getApprovals is missing, permission waits will not be highlighted');
      return;
    }
    const list = this.store.getApprovals();
    if (!Array.isArray(list)) return;
    for (const request of list) {
      if (!request || !request.sessionId) continue;
      const current = this._approvals.get(request.sessionId);
      if (!current || (request.createdAt || 0) < (current.createdAt || 0)) {
        this._approvals.set(request.sessionId, request);
      }
    }
  }

  _syncFromPrefs() {
    const sort = this._pref(PREF.SORT, this._sortMode) === 'manual' ? 'manual' : 'urgency';
    const filter = this._normalizeFilter(this._pref(PREF.TAG_FILTER, []));
    const filterChanged = filter.join(',') !== [...this._tagFilter].join(',');
    const sortChanged = sort !== this._sortMode;
    if (sortChanged) {
      this._sortMode = sort;
      this._renderSortButton();
    }
    if (filterChanged) {
      this._tagFilter = new Set(filter);
      this._renderFilterBar();
    }
    const args = String(this._pref(PREF.ARGS, '') || '');
    if (document.activeElement !== this.argsInput && args !== this.argsInput.value) {
      this.argsInput.value = args;
    }
    const cwd = String(this._pref(PREF.CWD, '') || '');
    if (cwd !== this.projectSel.value) this._renderProjects();
    if (sortChanged || filterChanged) this._renderList();
  }

  _readActiveId() {
    const state = this.store && this.store.state ? this.store.state : null;
    return state && typeof state.activeId === 'string' ? state.activeId : null;
  }

  _setActive(id) {
    const next = typeof id === 'string' ? id : null;
    if (next === this._activeId) return;
    const previous = this._activeId;
    this._activeId = next;
    for (const rowId of [previous, next]) {
      const entry = rowId ? this._rows.get(rowId) : null;
      if (entry) this._applyActive(entry);
    }
  }

  _applyActive(entry) {
    const on = entry.id === this._activeId;
    entry.root.classList.toggle('is-active', on);
    if (on) entry.root.setAttribute('aria-current', 'true');
    else entry.root.removeAttribute('aria-current');
    // Inline because style.css has no rule for a selected row, and box-shadow
    // rather than a border so the border stays free for the urgency colours.
    entry.root.style.boxShadow = on ? 'inset 0 0 0 1px var(--accent)' : '';
  }

  _normalizeFilter(value) {
    if (!Array.isArray(value)) return [];
    return value.filter(c => typeof c === 'string' && TAG_COLORS.includes(c) && c !== 'none');
  }

  _manualOrder(sessions) {
    const stored = this._pref(PREF.ORDER, []);
    const order = Array.isArray(stored) ? stored : [];
    const index = new Map(order.map((id, i) => [id, i]));
    return [...sessions].sort((a, b) => {
      const ia = index.has(a.id) ? index.get(a.id) : Number.MAX_SAFE_INTEGER;
      const ib = index.has(b.id) ? index.get(b.id) : Number.MAX_SAFE_INTEGER;
      if (ia !== ib) return ia - ib;
      return (a.createdAt || 0) - (b.createdAt || 0);
    });
  }

  /** Every session, filter applied, in the order the list should show. */
  _ordered(now = Date.now()) {
    const all = this._manualOrder(this._sessions());
    const visible = all.filter(s => this._matchesFilter(s));
    if (this._sortMode === 'manual') return visible;
    const decorated = visible.map((session, index) => ({
      session,
      index,
      activity: describeActivity(session, now, this._approvals.get(session.id) || null),
    }));
    decorated.sort((a, b) => compareUrgency(a, b, now));
    return decorated.map(d => d.session);
  }

  _matchesFilter(session) {
    if (this._tagFilter.size === 0) return true;
    return this._tagFilter.has(session.tagColor);
  }

  _renderList() {
    const now = Date.now();
    const sessions = this._ordered(now);

    const seen = new Set();
    let prev = null;
    for (const session of sessions) {
      let entry = this._rows.get(session.id);
      if (!entry) {
        entry = this._createRow(session.id);
        this._rows.set(session.id, entry);
      }
      seen.add(session.id);
      const next = prev ? prev.nextSibling : this.listEl.firstChild;
      if (next !== entry.root) this.listEl.insertBefore(entry.root, next);
      prev = entry.root;
      this._updateRow(entry, session, now);
    }

    for (const [id, entry] of [...this._rows]) {
      if (seen.has(id)) continue;
      if (this._editing && this._editing.id === id) this._editing = null;
      entry.dispose();
      entry.root.remove();
      this._rows.delete(id);
    }

    this._domOrder = sessions.map(s => s.id).join(',');
    this.emptyEl.hidden = sessions.length > 0;
    this._renderFooter(now);
  }

  _renderFooter(now) {
    const all = this._sessions();
    const live = all.filter(s => s.status !== STATUS.EXITED).length;
    this.countTotal.textContent = all.length === 1
      ? `1 agent, ${live} live`
      : `${all.length} agents, ${live} live`;

    let needsHuman = 0;
    for (const session of all) {
      const activity = describeActivity(session, now, this._approvals.get(session.id) || null);
      if (activity.urgent) needsHuman++;
    }
    this.countAlert.hidden = needsHuman === 0;
    this.countAlert.textContent = needsHuman === 1 ? '1 needs you' : `${needsHuman} need you`;

    // Broadcasting is deliberately limited to a tag: sending a prompt to every
    // agent at once is not something anyone means to do by accident.
    const tagged = this._tagFilter.size > 0;
    const targets = this._broadcastTargets();
    this.broadcastInput.disabled = !tagged;
    this.broadcastSend.disabled = !tagged || targets.length === 0;
    if (!tagged) this.broadcastInput.placeholder = 'Pick a tag colour to broadcast';
    else if (targets.length === 1) this.broadcastInput.placeholder = 'Send to 1 tagged agent';
    else this.broadcastInput.placeholder = `Send to ${targets.length} tagged agents`;
  }

  _createRow(id) {
    const root = el('div', { class: 'sb-row' });
    root.dataset.id = id;
    root.setAttribute('role', 'listitem');
    root.tabIndex = 0;
    root.draggable = this._sortMode === 'manual';

    const dot = el('span', { class: 'sb-dot' });
    dot.setAttribute('aria-hidden', 'true');

    const main = el('div', { class: 'sb-main' });

    const line1 = el('div', { class: 'sb-line sb-line-head' });
    const name = el('span', { class: 'sb-name' });
    name.title = 'Double click to rename';
    const kind = el('span', { class: 'sb-kind' });
    // An agent started with the permission model off has no approval gate, so
    // it says so on its own row. Colours inline for want of a .sb-warn rule.
    const warn = el('span', {
      class: 'sb-kind sb-warn',
      style: { background: 'var(--red-dim)', color: 'var(--red)' },
      text: 'unguarded',
    });
    warn.hidden = true;
    const tag = el('button', { class: 'sb-tag' });
    tag.type = 'button';
    tag.dataset.act = 'tag';
    tag.title = 'Tag colour, filter and broadcast target';
    line1.append(name, kind, warn, tag);

    const line2 = el('div', { class: 'sb-line sb-line-where' });
    const cwd = el('span', { class: 'sb-cwd' });
    const branch = el('span', { class: 'sb-branch' });
    line2.append(cwd, branch);

    const line3 = el('div', { class: 'sb-line sb-line-activity' });
    const activity = el('span', { class: 'sb-activity' });
    const timer = el('span', { class: 'sb-timer' });
    const cost = el('span', { class: 'sb-cost' });
    line3.append(activity, timer, cost);

    main.append(line1, line2, line3);

    const actions = el('div', { class: 'sb-actions' });
    for (const [act, label, title] of [
      ['focus', 'Focus', 'Show this terminal'],
      ['minimize', 'Hide', 'Minimise this terminal'],
      ['close', 'Close', 'Close this session for good'],
    ]) {
      const button = el('button', { class: 'sb-action', text: label });
      button.type = 'button';
      button.dataset.act = act;
      button.title = title;
      actions.append(button);
    }

    root.append(dot, main, actions);

    const entry = {
      id,
      root,
      dot,
      name,
      kind,
      warn,
      tag,
      cwd,
      branch,
      activity,
      timer,
      cost,
      activityKey: null,
      since: null,
      long: false,
      unsub: () => {},
      dispose() { this.unsub(); },
    };

    if (typeof this.store.subscribe === 'function') {
      const off = this.store.subscribe('session:' + id, () => this._onSessionChanged(id));
      if (typeof off === 'function') entry.unsub = off;
    }

    return entry;
  }

  _updateRow(entry, session, now) {
    const root = entry.root;
    root.dataset.status = session.status;
    root.dataset.kind = session.kind;
    root.dataset.tag = session.tagColor || 'none';
    root.dataset.detached = session.attached > 0 ? 'no' : 'yes';

    entry.dot.title = STATUS_LABEL[session.status] || session.status;

    if (!this._editing || this._editing.id !== session.id) {
      if (entry.name.textContent !== session.name) entry.name.textContent = session.name;
    }

    const kindLabel = KIND_LABEL[session.kind] || session.kind;
    if (entry.kind.textContent !== kindLabel) entry.kind.textContent = kindLabel;

    const warnings = Array.isArray(session.warnings)
      ? session.warnings.filter(w => typeof w === 'string' && w)
      : [];
    entry.warn.hidden = warnings.length === 0;
    entry.warn.title = warnings.join('\n');

    this._applyActive(entry);

    const tagColor = session.tagColor || 'none';
    entry.tag.dataset.color = tagColor;
    entry.tag.textContent = '';
    entry.tag.setAttribute('aria-label', `Tag: ${tagColor}`);

    // The server's project label walks past generic directories, so
    // `git/buyandrent/Frontend` reads as "buyandrent Frontend" rather than a
    // "Frontend" shared by three repositories.
    const folder = session.project || basename(session.cwd) || session.cwd || '';
    if (entry.cwd.textContent !== folder) entry.cwd.textContent = folder;
    entry.cwd.title = session.cwd || '';
    // A renamed session no longer says where it is, so the folder earns weight.
    entry.cwd.dataset.strong = session.name === folder ? 'no' : 'yes';

    const agent = session.agent || {};
    const branch = agent.gitBranch || '';
    if (entry.branch.textContent !== branch) entry.branch.textContent = branch;
    entry.branch.hidden = !branch;

    const cost = formatCost(agent.cost);
    if (entry.cost.textContent !== cost) entry.cost.textContent = cost;
    entry.cost.hidden = !cost;
    entry.cost.title = cost ? `Cost so far: ${cost}` : '';

    const activity = describeActivity(session, now, this._approvals.get(session.id) || null);
    this._applyActivity(entry, activity, now);
  }

  _applyActivity(entry, activity, now) {
    if (entry.activityKey !== activity.key) {
      entry.activityKey = activity.key;
      entry.activity.textContent = activity.label;
      entry.activity.title = activity.detail;
      entry.root.dataset.activity = activity.kind;
      entry.root.dataset.urgent = activity.urgent ? 'yes' : 'no';
    }
    entry.since = activity.since;
    entry.long = activity.long;
    this._applyTimer(entry, now);
  }

  _applyTimer(entry, now) {
    if (!entry.since) {
      if (!entry.timer.hidden) entry.timer.hidden = true;
      return;
    }
    const elapsed = now - entry.since;
    const text = entry.long ? formatDuration(elapsed) : formatDurationShort(elapsed);
    if (entry.timer.textContent !== text) entry.timer.textContent = text;
    if (entry.timer.hidden) entry.timer.hidden = false;
  }

  _onSessionChanged(id) {
    const entry = this._rows.get(id);
    const session = this._session(id);
    if (!session) {
      this._renderList();
      return;
    }
    // A tag change can push the session in or out of the filter: that is a
    // membership change, so it needs the reconciler, not a row update.
    if (!entry || !this._matchesFilter(session)) {
      this._renderList();
      return;
    }
    const now = Date.now();
    this._updateRow(entry, session, now);
    this._renderFooter(now);
    if (this._sortMode === 'urgency') this._reorderIfNeeded(now);
  }

  _reorderIfNeeded(now) {
    const order = this._ordered(now).map(s => s.id).join(',');
    if (order !== this._domOrder) this._renderList();
  }

  /** One clock for the whole list, whatever the number of rows. */
  _tick() {
    const now = Date.now();
    for (const [id, entry] of this._rows) {
      const session = this._session(id);
      if (!session) continue;
      // The stall threshold turns a running tool urgent purely with the passage
      // of time, so the label is recomputed rather than just ticked.
      const activity = describeActivity(session, now, this._approvals.get(id) || null);
      this._applyActivity(entry, activity, now);
    }
    if (this._sortMode === 'urgency') this._reorderIfNeeded(now);
    this._renderFooter(now);
  }

  _newAgent() {
    const cwd = String(this._pref(PREF.CWD, '') || '');
    const args = this.argsInput.value.trim();
    const name = this.nameInput.value.trim();
    this._setPref(PREF.ARGS, args);
    // A name is for one agent, not a standing preference.
    this.nameInput.value = '';

    const spec = { kind: KIND.CLAUDE, cwd, args };
    if (name) spec.name = name;
    this._actOrSend('newAgent', [spec], { t: C2S.CREATE, spec });
  }

  _broadcast() {
    const text = this.broadcastInput.value;
    if (!text) return;
    const ids = this._broadcastTargets();
    if (ids.length === 0) return;
    if (this._send({ t: C2S.SEND_TO, ids, data: text + '\r' })) {
      this.broadcastInput.value = '';
    }
  }

  _broadcastTargets() {
    if (this._tagFilter.size === 0) return [];
    return this._sessions()
      .filter(s => s.status !== STATUS.EXITED && this._tagFilter.has(s.tagColor))
      .map(s => s.id);
  }

  /**
   * Prefers the app callback, so the shell can confirm or animate; falls back
   * to the raw protocol frame when the sidebar is used on its own.
   */
  _actOrSend(name, args, frame) {
    const fn = this.actions[name];
    if (typeof fn === 'function') fn(...args);
    else this._send(frame);
  }

  _rename(id, name) {
    const trimmed = String(name || '').trim().slice(0, 120);
    if (!trimmed) return;
    this._actOrSend('renameSession', [id, trimmed], { t: C2S.RENAME, id, name: trimmed });
  }

  _setMeta(id, patch) {
    this._actOrSend('setMeta', [id, patch], { t: C2S.SET_META, id, patch });
  }

  _close(id) {
    this._actOrSend('closeSession', [id], { t: C2S.KILL, id, remove: true });
  }

  _toggleTagFilter(color) {
    if (color === 'none') return;
    if (this._tagFilter.has(color)) this._tagFilter.delete(color);
    else this._tagFilter.add(color);
    this._setPref(PREF.TAG_FILTER, [...this._tagFilter]);
    this._renderFilterBar();
    this._renderList();
  }

  _rowIdFrom(node) {
    const row = node && node.closest ? node.closest('.sb-row') : null;
    return row ? row.dataset.id : null;
  }

  _onListClick(ev) {
    const id = this._rowIdFrom(ev.target);
    if (!id) return;
    const button = ev.target.closest('[data-act]');
    const act = button ? button.dataset.act : null;

    if (act === 'tag') {
      ev.stopPropagation();
      this._openTagMenu(id, button);
      return;
    }
    if (act === 'minimize') {
      this._act('minimizeSession', id);
      return;
    }
    if (act === 'close') {
      this._close(id);
      return;
    }
    if (act === 'focus') {
      this._act('focusSession', id);
      return;
    }
    if (this._editing && this._editing.id === id) return;
    this._act('focusSession', id);
  }

  _onListDblClick(ev) {
    const nameEl = ev.target.closest ? ev.target.closest('.sb-name') : null;
    if (!nameEl) return;
    const id = this._rowIdFrom(nameEl);
    if (!id) return;
    ev.preventDefault();
    this._startEdit(id, nameEl);
  }

  _startEdit(id, nameEl) {
    if (this._editing) this._commitEdit();
    this._editing = { id, el: nameEl, original: nameEl.textContent };
    nameEl.contentEditable = 'true';
    nameEl.spellcheck = false;
    nameEl.classList.add('is-editing');
    nameEl.focus();
    const range = document.createRange();
    range.selectNodeContents(nameEl);
    const selection = window.getSelection();
    if (selection) {
      selection.removeAllRanges();
      selection.addRange(range);
    }
  }

  _commitEdit() {
    const editing = this._editing;
    if (!editing) return;
    this._editing = null;
    const nameEl = editing.el;
    nameEl.contentEditable = 'false';
    nameEl.classList.remove('is-editing');
    const value = nameEl.textContent.replace(/\s+/g, ' ').trim();
    if (!value) {
      nameEl.textContent = editing.original;
      return;
    }
    if (value !== editing.original) this._rename(editing.id, value);
    nameEl.textContent = value.slice(0, 120);
  }

  _cancelEdit() {
    const editing = this._editing;
    if (!editing) return;
    this._editing = null;
    editing.el.contentEditable = 'false';
    editing.el.classList.remove('is-editing');
    editing.el.textContent = editing.original;
  }

  _onListFocusOut(ev) {
    if (!this._editing) return;
    if (ev.target === this._editing.el) this._commitEdit();
  }

  _onListKeydown(ev) {
    if (this._editing && ev.target === this._editing.el) {
      if (ev.key === 'Enter') {
        ev.preventDefault();
        this._commitEdit();
      } else if (ev.key === 'Escape') {
        ev.preventDefault();
        this._cancelEdit();
      }
      return;
    }

    const id = this._rowIdFrom(ev.target);
    if (!id) return;

    if (ev.key === 'Enter') {
      ev.preventDefault();
      this._act('focusSession', id);
      return;
    }
    if (ev.key === 'F2') {
      ev.preventDefault();
      const entry = this._rows.get(id);
      if (entry) this._startEdit(id, entry.name);
      return;
    }
    // Keyboard reordering, because drag and drop is unusable on a touchpad.
    if (ev.altKey && (ev.key === 'ArrowUp' || ev.key === 'ArrowDown')) {
      ev.preventDefault();
      this._moveByKeyboard(id, ev.key === 'ArrowUp' ? -1 : 1);
    }
  }

  _moveByKeyboard(id, delta) {
    if (this._sortMode !== 'manual') {
      this._sortMode = 'manual';
      this._setPref(PREF.SORT, 'manual');
      this._renderSortButton();
    }
    const all = this._manualOrder(this._sessions()).map(s => s.id);
    const from = all.indexOf(id);
    if (from < 0) return;
    const to = Math.min(all.length - 1, Math.max(0, from + delta));
    if (to === from) return;
    all.splice(to, 0, all.splice(from, 1)[0]);
    this._setPref(PREF.ORDER, all);
    this._renderList();
    const entry = this._rows.get(id);
    if (entry) entry.root.focus();
  }

  _onDragStart(ev) {
    if (this._sortMode !== 'manual') {
      ev.preventDefault();
      return;
    }
    const id = this._rowIdFrom(ev.target);
    if (!id) return;
    this._dragId = id;
    const entry = this._rows.get(id);
    if (entry) entry.root.classList.add('is-dragging');
    if (ev.dataTransfer) {
      ev.dataTransfer.effectAllowed = 'move';
      // Some browsers refuse to start a drag without any payload.
      ev.dataTransfer.setData('text/plain', id);
    }
  }

  _onDragOver(ev) {
    if (!this._dragId) return;
    ev.preventDefault();
    if (ev.dataTransfer) ev.dataTransfer.dropEffect = 'move';
    const before = this._dropTargetAt(ev.clientY);
    if (before === this._dropBefore) return;
    this._paintDropMarker(before);
  }

  _onDragLeave(ev) {
    if (!this._dragId) return;
    if (ev.relatedTarget && this.listEl.contains(ev.relatedTarget)) return;
    this._paintDropMarker(null);
  }

  _onDrop(ev) {
    if (!this._dragId) return;
    ev.preventDefault();
    const dragged = this._dragId;
    const beforeId = this._dropBefore;
    this._clearDrag();
    if (beforeId === dragged) return;

    const all = this._manualOrder(this._sessions()).map(s => s.id);
    const from = all.indexOf(dragged);
    if (from < 0) return;
    all.splice(from, 1);
    const at = beforeId ? all.indexOf(beforeId) : -1;
    if (at < 0) all.push(dragged);
    else all.splice(at, 0, dragged);

    this._setPref(PREF.ORDER, all);
    this._renderList();
  }

  /** Id of the row the dragged one would land before, or null for the end. */
  _dropTargetAt(clientY) {
    for (const child of this.listEl.children) {
      const rect = child.getBoundingClientRect();
      if (clientY < rect.top + rect.height / 2) return child.dataset.id || null;
    }
    return null;
  }

  _paintDropMarker(beforeId) {
    for (const entry of this._rows.values()) entry.root.classList.remove('is-drop-before');
    this.listEl.classList.toggle('is-drop-end', this._dragId !== null && beforeId === null);
    if (beforeId) {
      const entry = this._rows.get(beforeId);
      if (entry) entry.root.classList.add('is-drop-before');
    }
    this._dropBefore = beforeId;
  }

  _clearDrag() {
    if (this._dragId) {
      const entry = this._rows.get(this._dragId);
      if (entry) entry.root.classList.remove('is-dragging');
    }
    this._dragId = null;
    // With _dragId already cleared, this also drops the end-of-list marker and
    // resets _dropBefore.
    this._paintDropMarker(null);
  }

  _openTagMenu(id, anchor) {
    this._closeMenu();
    const session = this._session(id);
    if (!session) return;

    const menu = el('div', { class: 'sb-tagmenu' });
    menu.setAttribute('role', 'menu');

    const swatches = el('div', { class: 'sb-tagmenu-colors' });
    for (const color of TAG_COLORS) {
      const swatch = el('button', { class: 'sb-swatch' });
      swatch.type = 'button';
      swatch.dataset.color = color;
      swatch.title = color === 'none' ? 'Remove tag' : `Tag ${color}`;
      swatch.setAttribute('aria-label', swatch.title);
      if ((session.tagColor || 'none') === color) swatch.classList.add('is-current');
      swatch.addEventListener('click', () => {
        this._setMeta(id, { tagColor: color });
        this._closeMenu();
      });
      swatches.append(swatch);
    }

    const current = session.tagColor || 'none';
    const filterBtn = el('button', { class: 'sb-tagmenu-item' });
    filterBtn.type = 'button';
    if (current === 'none') {
      filterBtn.textContent = 'Tag this agent to filter on it';
      filterBtn.disabled = true;
    } else if (this._tagFilter.has(current)) {
      filterBtn.textContent = `Stop filtering on ${current}`;
    } else {
      filterBtn.textContent = `Filter on ${current}`;
    }
    filterBtn.addEventListener('click', () => {
      this._toggleTagFilter(current);
      this._closeMenu();
    });

    const broadcastBtn = el('button', { class: 'sb-tagmenu-item' });
    broadcastBtn.type = 'button';
    broadcastBtn.textContent = current === 'none'
      ? 'Tag this agent to broadcast to it'
      : `Broadcast to every ${current} agent`;
    broadcastBtn.disabled = current === 'none';
    broadcastBtn.addEventListener('click', () => {
      if (!this._tagFilter.has(current)) this._toggleTagFilter(current);
      this._closeMenu();
      this.broadcastInput.focus();
    });

    menu.append(swatches, filterBtn, broadcastBtn);
    document.body.append(menu);

    // Fixed positioning keeps the menu independent of the sidebar's own
    // scrolling and stacking context.
    const rect = anchor.getBoundingClientRect();
    menu.style.position = 'fixed';
    menu.style.left = Math.round(Math.min(rect.left, window.innerWidth - menu.offsetWidth - 8)) + 'px';
    const below = rect.bottom + 6;
    const fits = below + menu.offsetHeight < window.innerHeight;
    menu.style.top = Math.round(fits ? below : Math.max(8, rect.top - menu.offsetHeight - 6)) + 'px';

    const onOutside = ev => {
      if (menu.contains(ev.target)) return;
      this._closeMenu();
    };
    const onKey = ev => {
      if (ev.key === 'Escape') this._closeMenu();
    };
    document.addEventListener('mousedown', onOutside, true);
    document.addEventListener('keydown', onKey, true);
    window.addEventListener('resize', () => this._closeMenu(), { once: true });

    this._menu = {
      el: menu,
      close: () => {
        document.removeEventListener('mousedown', onOutside, true);
        document.removeEventListener('keydown', onKey, true);
        menu.remove();
      },
    };
  }

  _closeMenu() {
    if (!this._menu) return;
    const menu = this._menu;
    this._menu = null;
    menu.close();
  }
}

export default Sidebar;
