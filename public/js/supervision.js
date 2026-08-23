/**
 * The supervision view: the swarm without a single terminal on screen.
 *
 * Three panes, in the order a human reads them: an alert banner for whoever is
 * blocked, one card per agent, and a timeline merging every hook event from
 * every agent into one chronological stream.
 *
 * Nothing here polls the DOM or the server: every repaint comes from a store
 * subscription, and the single one second interval only advances clocks.
 */

import { el, clear } from './dom.js';
import { STATUS } from './protocol.js';
import {
  STALL_MS,
  basename,
  describeActivity,
  formatClock,
  formatCost,
  formatDuration,
  formatDurationShort,
  formatTokens,
  urgencyRank,
} from './sidebar.js';

const MAX_EVENTS = 200;

const STATUS_LABEL = {
  [STATUS.STARTING]: 'Starting',
  [STATUS.IDLE]: 'Idle',
  [STATUS.BUSY]: 'Working',
  [STATUS.AWAITING_INPUT]: 'Question',
  [STATUS.AWAITING_PERMISSION]: 'Permission',
  [STATUS.EXITED]: 'Exited',
};

const ALERT_LABEL = {
  permission: 'Waiting for permission',
  question: 'Asked a question',
  stalled: 'Stuck on the same tool',
};

const ALERT_ACTION = {
  permission: 'Review',
  question: 'Answer',
  stalled: 'Inspect',
};

function warnOnce(seen, message) {
  if (seen.has(message)) return;
  seen.add(message);
  console.warn('[orchestra/supervision] ' + message);
}

function eventKey(event) {
  return `${event.ts || 0}:${event.seq || 0}:${event.event || ''}`;
}

/**
 * Reconciles a keyed registry of `{root}` entries into `parent` in the order of
 * `items`: creates what is missing, moves what is out of place, and disposes
 * and removes what is gone. Kept in one place because both panes need exactly
 * this and a full rebuild would drop focus and scroll position.
 *
 * @param {Map<string, {root: Element, dispose?: () => void}>} registry
 */
function reconcileList(parent, registry, items, { keyOf, create, update }) {
  const seen = new Set();
  let prev = null;
  for (const item of items) {
    const key = keyOf(item);
    let entry = registry.get(key);
    if (!entry) {
      entry = create(item);
      registry.set(key, entry);
    }
    seen.add(key);
    const next = prev ? prev.nextSibling : parent.firstChild;
    if (next !== entry.root) parent.insertBefore(entry.root, next);
    prev = entry.root;
    update(entry, item);
  }
  for (const [key, entry] of [...registry]) {
    if (seen.has(key)) continue;
    if (typeof entry.dispose === 'function') entry.dispose();
    entry.root.remove();
    registry.delete(key);
  }
}

/** One readable line for a hook event, whatever the hook chose to send. */
function eventSummary(event) {
  if (event.detail) return String(event.detail);
  if (event.message) return String(event.message);
  if (event.tool) return String(event.tool);
  if (event.unmatchedReason) return `unmatched (${event.unmatchedReason})`;
  return '';
}

export class SupervisionView {
  /**
   * @param {HTMLElement} root  container, typically #view-supervision
   * @param {{store: Object, actions?: Object}} deps  without `actions` the view
   *   dispatches an `orchestra:navigate` CustomEvent instead of calling it
   */
  constructor(root, { store, actions } = {}) {
    if (!root) throw new Error('SupervisionView needs a root element');
    if (!store) throw new Error('SupervisionView needs a store');

    this.root = root;
    this.store = store;
    this.actions = actions || {};

    this._warned = new Set();
    this._unsubs = [];
    this._cards = new Map();
    this._alerts = new Map();
    this._approvals = new Map();
    this._filterAgent = 'all';
    this._filterType = 'all';
    this._timer = null;

    this._build();
    this.refresh();

    this._subscribe('sessions', () => this.refresh());
    this._subscribe('approvals', () => { this._readApprovals(); this._renderAlerts(); this._renderCards(); });
    this._subscribe('events', () => this._renderTimeline());

    this._timer = setInterval(() => this._tick(), 1000);
  }

  destroy() {
    clearInterval(this._timer);
    this._timer = null;
    for (const off of this._unsubs) off();
    this._unsubs.length = 0;
    for (const card of this._cards.values()) card.dispose();
    this._cards.clear();
    this._alerts.clear();
    clear(this.root);
  }

  /** Full repaint, cheap enough to call whenever the view is shown again. */
  refresh() {
    this._readApprovals();
    this._renderAlerts();
    this._renderCards();
    this._renderAgentFilter();
    this._renderTimeline();
  }

  _subscribe(topic, handler) {
    if (typeof this.store.subscribe !== 'function') {
      warnOnce(this._warned, 'store.subscribe is missing, supervision will not update');
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

  _events() {
    if (typeof this.store.getEvents !== 'function') {
      warnOnce(this._warned, 'store.getEvents is missing, the timeline stays empty');
      return [];
    }
    const list = this.store.getEvents();
    return Array.isArray(list) ? list : [];
  }

  _readApprovals() {
    this._approvals = new Map();
    if (typeof this.store.getApprovals !== 'function') {
      warnOnce(this._warned, 'store.getApprovals is missing, permission alerts are off');
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

  /** The shell owns the views, so navigation is a request it may or may not answer. */
  _askShell(view, sessionId) {
    this.root.dispatchEvent(new CustomEvent('orchestra:navigate', {
      bubbles: true,
      detail: { view, sessionId: sessionId || null },
    }));
  }

  _navigate(view, sessionId) {
    if (typeof this.actions.setView === 'function') this.actions.setView(view, sessionId);
    else this._askShell(view, sessionId);
  }

  _focus(sessionId) {
    if (typeof this.actions.focusSession === 'function') this.actions.focusSession(sessionId);
    else this._askShell('terminals', sessionId);
  }

  _build() {
    clear(this.root);

    const wrap = el('div', { class: 'sv' });

    this.alertsEl = el('div', { class: 'sv-alerts' });
    this.alertsEl.setAttribute('role', 'region');
    this.alertsEl.setAttribute('aria-label', 'Agents needing a human');
    this.alertsTitle = el('div', { class: 'sv-alerts-title' });
    this.alertsList = el('ul', { class: 'sv-alerts-list' });
    this.alertsEl.append(this.alertsTitle, this.alertsList);
    this.alertsEl.hidden = true;

    const body = el('div', { class: 'sv-body' });

    this.cardsEl = el('div', { class: 'sv-cards' });
    this.cardsEmpty = el('div', { class: 'sv-empty', text: 'No agent running.' });
    this.cardsEmpty.hidden = true;

    const cardsPane = el('div', { class: 'sv-pane sv-pane-cards' });
    cardsPane.append(this.cardsEl, this.cardsEmpty);

    const timelinePane = el('aside', { class: 'sv-pane sv-pane-timeline' });
    const timelineHead = el('div', { class: 'sv-timeline-head' });
    const timelineTitle = el('h2', { class: 'sv-timeline-title', text: 'Timeline' });

    this.agentFilter = el('select', { class: 'sv-filter sv-filter-agent' });
    this.agentFilter.title = 'Filter the timeline by agent';
    this.typeFilter = el('select', { class: 'sv-filter sv-filter-type' });
    this.typeFilter.title = 'Filter the timeline by event type';

    timelineHead.append(timelineTitle, this.agentFilter, this.typeFilter);

    this.eventsEl = el('ol', { class: 'sv-events' });
    this.eventsEmpty = el('div', { class: 'sv-empty', text: 'No agent event yet. Install the hooks to populate this.' });
    this.eventsEmpty.hidden = true;

    timelinePane.append(timelineHead, this.eventsEl, this.eventsEmpty);

    body.append(cardsPane, timelinePane);
    wrap.append(this.alertsEl, body);
    this.root.append(wrap);

    this.agentFilter.addEventListener('change', () => {
      this._filterAgent = this.agentFilter.value;
      this._rebuildTimeline();
    });
    this.typeFilter.addEventListener('change', () => {
      this._filterType = this.typeFilter.value;
      this._rebuildTimeline();
    });
  }

  /** Everything that is waiting on a human, most urgent first. */
  _collectAlerts(now) {
    const alerts = [];
    for (const session of this._sessions()) {
      const approval = this._approvals.get(session.id) || null;
      const activity = describeActivity(session, now, approval);
      if (!activity.urgent) continue;
      alerts.push({
        key: activity.kind + ':' + session.id,
        kind: activity.kind,
        sessionId: session.id,
        name: session.name,
        text: activity.detail || activity.label,
        since: activity.since,
        rank: urgencyRank(activity),
        approvalId: approval ? approval.id : null,
      });
    }
    alerts.sort((a, b) => {
      if (a.rank !== b.rank) return a.rank - b.rank;
      return (a.since || now) - (b.since || now);
    });
    return alerts;
  }

  _renderAlerts() {
    const now = Date.now();
    const alerts = this._collectAlerts(now);

    this.alertsEl.hidden = alerts.length === 0;
    this.alertsTitle.textContent = alerts.length === 1
      ? '1 agent is waiting on you'
      : `${alerts.length} agents are waiting on you`;

    reconcileList(this.alertsList, this._alerts, alerts, {
      keyOf: alert => alert.key,
      create: alert => this._createAlert(alert),
      update: (entry, alert) => this._updateAlert(entry, alert, now),
    });
  }

  _createAlert(alert) {
    const root = el('li', { class: 'sv-alert' });
    root.dataset.kind = alert.kind;

    const name = el('span', { class: 'sv-alert-name' });
    const label = el('span', { class: 'sv-alert-label' });
    const text = el('span', { class: 'sv-alert-text' });
    const age = el('span', { class: 'sv-alert-age' });
    const button = el('button', { class: 'sv-alert-btn' });
    button.type = 'button';

    button.addEventListener('click', () => {
      if (alert.kind === 'permission') this._navigate('approvals', alert.sessionId);
      else this._focus(alert.sessionId);
    });

    root.append(name, label, text, age, button);
    return { root, name, label, text, age, button, since: alert.since, textKey: null };
  }

  _updateAlert(entry, alert, now) {
    if (entry.name.textContent !== alert.name) entry.name.textContent = alert.name;
    const label = ALERT_LABEL[alert.kind] || alert.kind;
    if (entry.label.textContent !== label) entry.label.textContent = label;
    if (entry.textKey !== alert.text) {
      entry.textKey = alert.text;
      entry.text.textContent = alert.text;
      entry.text.title = alert.text;
    }
    const action = ALERT_ACTION[alert.kind] || 'Open';
    if (entry.button.textContent !== action) entry.button.textContent = action;
    entry.button.title = `${action}: ${alert.name}`;
    entry.since = alert.since;
    entry.age.textContent = alert.since ? formatDuration(now - alert.since) : '';
  }

  _renderCards() {
    const now = Date.now();
    const sessions = [...this._sessions()].sort((a, b) => {
      const ra = urgencyRank(describeActivity(a, now, this._approvals.get(a.id) || null));
      const rb = urgencyRank(describeActivity(b, now, this._approvals.get(b.id) || null));
      if (ra !== rb) return ra - rb;
      return (a.createdAt || 0) - (b.createdAt || 0);
    });

    reconcileList(this.cardsEl, this._cards, sessions, {
      keyOf: session => session.id,
      create: session => this._createCard(session.id),
      update: (card, session) => this._updateCard(card, session, now),
    });

    this.cardsEmpty.hidden = sessions.length > 0;
  }

  _createCard(id) {
    const root = el('article', { class: 'sv-card' });
    root.dataset.id = id;

    const head = el('header', { class: 'sv-card-head' });
    const dot = el('span', { class: 'sv-card-dot' });
    dot.setAttribute('aria-hidden', 'true');
    const name = el('h3', { class: 'sv-card-name' });
    const kind = el('span', { class: 'sv-card-kind' });
    // Started with the permission model disabled: nothing will ask before a
    // tool runs, so the card says it outright. Colours are inline because
    // style.css has no .sv-card-warn rule.
    const warn = el('span', {
      class: 'sv-card-kind sv-card-warn',
      style: { background: 'var(--red-dim)', color: 'var(--red)' },
      text: 'unguarded',
    });
    warn.hidden = true;
    const open = el('button', { class: 'sv-card-open', text: 'Open terminal' });
    open.type = 'button';
    open.addEventListener('click', () => this._focus(id));
    head.append(dot, name, kind, warn, open);

    const where = el('div', { class: 'sv-card-where' });
    const project = el('span', { class: 'sv-card-project' });
    const branch = el('span', { class: 'sv-card-branch' });
    where.append(project, branch);

    const state = el('div', { class: 'sv-card-state' });
    const stateLabel = el('span', { class: 'sv-card-state-label' });
    const timer = el('span', { class: 'sv-card-timer' });
    state.append(stateLabel, timer);

    const detail = el('div', { class: 'sv-card-detail' });

    const facts = el('dl', { class: 'sv-card-facts' });
    const question = this._fact(facts, 'Last question', 'sv-card-question');
    const prompt = this._fact(facts, 'Last prompt', 'sv-card-prompt');

    const stats = el('footer', { class: 'sv-card-stats' });
    const turns = el('span', { class: 'sv-stat sv-stat-turns' });
    const cost = el('span', { class: 'sv-stat sv-stat-cost' });
    const tokens = el('span', { class: 'sv-stat sv-stat-tokens' });
    const model = el('span', { class: 'sv-stat sv-stat-model' });
    stats.append(turns, cost, tokens, model);

    root.append(head, where, state, detail, facts, stats);

    const card = {
      id,
      root,
      dot,
      name,
      kind,
      warn,
      project,
      branch,
      stateLabel,
      timer,
      detail,
      question,
      prompt,
      turns,
      cost,
      tokens,
      model,
      activityKey: null,
      since: null,
      long: false,
      unsub: () => {},
      dispose() { this.unsub(); },
    };

    if (typeof this.store.subscribe === 'function') {
      const off = this.store.subscribe('session:' + id, () => this._onSessionChanged(id));
      if (typeof off === 'function') card.unsub = off;
    }

    return card;
  }

  /** Adds a term/definition pair and returns the definition element. */
  _fact(list, term, className) {
    const row = el('div', { class: 'sv-fact' });
    const dt = el('dt', { class: 'sv-fact-term', text: term });
    const dd = el('dd', { class: 'sv-fact-value ' + className });
    row.append(dt, dd);
    list.append(row);
    return { row, dd };
  }

  _updateCard(card, session, now) {
    const agent = session.agent || {};
    const approval = this._approvals.get(session.id) || null;
    const activity = describeActivity(session, now, approval);

    card.root.dataset.status = session.status;
    card.root.dataset.activity = activity.kind;
    card.root.dataset.urgent = activity.urgent ? 'yes' : 'no';
    card.root.dataset.tag = session.tagColor || 'none';

    if (card.name.textContent !== session.name) card.name.textContent = session.name;
    card.dot.title = STATUS_LABEL[session.status] || session.status;

    const kindLabel = session.kind;
    if (card.kind.textContent !== kindLabel) card.kind.textContent = kindLabel;

    const warnings = Array.isArray(session.warnings)
      ? session.warnings.filter(w => typeof w === 'string' && w)
      : [];
    card.warn.hidden = warnings.length === 0;
    card.warn.title = warnings.join('\n');

    const folder = basename(session.cwd) || session.cwd || '';
    if (card.project.textContent !== folder) card.project.textContent = folder;
    card.project.title = session.cwd || '';

    const branch = agent.gitBranch || '';
    if (card.branch.textContent !== branch) card.branch.textContent = branch;
    card.branch.hidden = !branch;

    if (card.activityKey !== activity.key) {
      card.activityKey = activity.key;
      card.stateLabel.textContent = STATUS_LABEL[session.status] || session.status;
      card.detail.textContent = activity.detail === activity.label ? activity.label : activity.detail;
      card.detail.title = activity.detail;
      card.detail.hidden = !activity.detail;
    }
    card.since = activity.since;
    card.long = activity.long;
    this._applyTimer(card, now);

    const question = agent.lastQuestion || '';
    if (card.question.dd.textContent !== question) {
      card.question.dd.textContent = question;
      card.question.dd.title = question;
    }
    card.question.row.hidden = !question;

    const prompt = agent.lastPrompt || '';
    if (card.prompt.dd.textContent !== prompt) {
      card.prompt.dd.textContent = prompt;
      card.prompt.dd.title = prompt;
    }
    card.prompt.row.hidden = !prompt;

    const turns = Number(agent.turns) || 0;
    const turnsText = turns === 1 ? '1 turn' : `${turns} turns`;
    if (card.turns.textContent !== turnsText) card.turns.textContent = turnsText;

    const costText = formatCost(agent.cost) || '$0.00';
    if (card.cost.textContent !== costText) card.cost.textContent = costText;
    card.cost.title = 'Cost reported by hooks';

    const tokensIn = agent.tokens ? agent.tokens.input : 0;
    const tokensOut = agent.tokens ? agent.tokens.output : 0;
    const tokensText = `${formatTokens(tokensIn)} in / ${formatTokens(tokensOut)} out`;
    if (card.tokens.textContent !== tokensText) card.tokens.textContent = tokensText;
    card.tokens.title = 'Tokens in and out';

    const model = agent.model || '';
    if (card.model.textContent !== model) card.model.textContent = model;
    card.model.hidden = !model;
  }

  _applyTimer(holder, now) {
    if (!holder.since) {
      if (!holder.timer.hidden) holder.timer.hidden = true;
      return;
    }
    const elapsed = now - holder.since;
    const text = holder.long ? formatDuration(elapsed) : formatDurationShort(elapsed);
    if (holder.timer.textContent !== text) holder.timer.textContent = text;
    if (holder.timer.hidden) holder.timer.hidden = false;
  }

  _onSessionChanged(id) {
    const session = this._session(id);
    const card = this._cards.get(id);
    if (!session || !card) {
      this._renderCards();
      this._renderAlerts();
      return;
    }
    const now = Date.now();
    this._updateCard(card, session, now);
    this._renderAlerts();
  }

  /**
   * Refills a filter dropdown, but only when its options really changed:
   * rebuilding one under an open menu closes it, and these two are repainted on
   * every store event.
   *
   * @param {Array<{value:string,label:string}>} items entries after the "all" row
   * @returns {string} the value now selected, 'all' when the old one is gone
   */
  _syncFilter(select, current, allLabel, items) {
    const wanted = ['all', ...items.map(i => i.value)];
    const present = [...select.options].map(o => o.value);
    if (wanted.join(',') === present.join(',')) return current;

    clear(select);
    const all = el('option', { text: allLabel });
    all.value = 'all';
    select.append(all);
    for (const item of items) {
      const option = el('option', { text: item.label });
      option.value = item.value;
      select.append(option);
    }
    const next = wanted.includes(current) ? current : 'all';
    select.value = next;
    return next;
  }

  _renderAgentFilter() {
    const items = this._sessions().map(s => ({ value: s.id, label: s.name }));
    this._filterAgent = this._syncFilter(this.agentFilter, this._filterAgent, 'All agents', items);
  }

  _renderTypeFilter(events) {
    const items = [...new Set(events.map(e => e.event).filter(Boolean))]
      .sort()
      .map(type => ({ value: type, label: type }));
    this._filterType = this._syncFilter(this.typeFilter, this._filterType, 'All events', items);
  }

  /** Newest first, filtered, capped. */
  _visibleEvents() {
    const events = this._events().filter(e => e && typeof e === 'object');
    const filtered = events.filter(event => {
      if (this._filterAgent !== 'all' && event.sessionId !== this._filterAgent) return false;
      if (this._filterType !== 'all' && event.event !== this._filterType) return false;
      return true;
    });
    filtered.sort((a, b) => {
      const ta = Number(a.ts) || 0;
      const tb = Number(b.ts) || 0;
      if (ta !== tb) return tb - ta;
      return (Number(b.seq) || 0) - (Number(a.seq) || 0);
    });
    return filtered.slice(0, MAX_EVENTS);
  }

  _renderTimeline() {
    const events = this._events();
    this._renderTypeFilter(events);

    const visible = this._visibleEvents();
    const first = this.eventsEl.firstElementChild;
    const firstKey = first ? first.dataset.key : null;

    // The common case is a handful of events arriving at the head of a list
    // that is otherwise unchanged, so splice those in rather than rebuilding.
    const anchorIndex = firstKey ? visible.findIndex(e => eventKey(e) === firstKey) : -1;
    if (firstKey === null || anchorIndex < 0) {
      this._rebuildTimeline(visible);
      return;
    }
    for (let i = anchorIndex - 1; i >= 0; i--) {
      this.eventsEl.insertBefore(this._createEventRow(visible[i]), this.eventsEl.firstChild);
    }
    this._trimTimeline(visible.length);
    this.eventsEmpty.hidden = visible.length > 0;
  }

  _rebuildTimeline(precomputed) {
    const visible = precomputed || this._visibleEvents();
    clear(this.eventsEl);
    for (const event of visible) this.eventsEl.append(this._createEventRow(event));
    this.eventsEmpty.hidden = visible.length > 0;
  }

  _trimTimeline(limit) {
    while (this.eventsEl.children.length > Math.min(limit, MAX_EVENTS)) {
      const last = this.eventsEl.lastElementChild;
      if (!last) break;
      last.remove();
    }
  }

  _createEventRow(event) {
    const row = el('li', { class: 'sv-event' });
    row.dataset.key = eventKey(event);
    row.dataset.event = event.event || 'unknown';
    if (event.ok === false) row.classList.add('is-error');
    if (event.matched === false) row.classList.add('is-unmatched');

    const time = el('span', { class: 'sv-ev-time', text: formatClock(event.ts) });
    time.title = event.ts ? new Date(Number(event.ts)).toLocaleString() : '';

    const session = event.sessionId ? this._session(event.sessionId) : null;
    const agentName = session ? session.name : (event.cwd ? basename(event.cwd) : 'unmatched');
    const agent = el('span', { class: 'sv-ev-agent', text: agentName });
    agent.title = session ? session.cwd || '' : (event.cwd || '');

    const type = el('span', { class: 'sv-ev-type', text: event.event || '' });

    const tool = el('span', { class: 'sv-ev-tool', text: event.tool || '' });
    tool.hidden = !event.tool;

    const summary = eventSummary(event);
    const detail = el('span', { class: 'sv-ev-detail', text: summary });
    detail.title = summary;

    const duration = el('span', { class: 'sv-ev-duration' });
    if (Number.isFinite(Number(event.durationMs))) {
      duration.textContent = formatDuration(Number(event.durationMs));
    } else {
      duration.hidden = true;
    }

    row.append(time, agent, type, tool, detail, duration);

    if (event.sessionId) {
      row.tabIndex = 0;
      row.addEventListener('click', () => this._focus(event.sessionId));
      row.addEventListener('keydown', ev => {
        if (ev.key !== 'Enter') return;
        ev.preventDefault();
        this._focus(event.sessionId);
      });
    }

    return row;
  }

  /**
   * One interval for the whole view. When the view is hidden the app leaves
   * `root.hidden` set, and there is nothing to advance.
   */
  _tick() {
    if (this.root.hidden) return;
    const now = Date.now();

    for (const [id, card] of this._cards) {
      const session = this._session(id);
      if (!session) continue;
      const activity = describeActivity(session, now, this._approvals.get(id) || null);
      // A tool crossing the stall threshold changes the card without any event
      // arriving, so recompute rather than only advancing the clock.
      if (card.activityKey !== activity.key) {
        this._updateCard(card, session, now);
      } else {
        card.since = activity.since;
        card.long = activity.long;
        this._applyTimer(card, now);
      }
    }

    for (const entry of this._alerts.values()) {
      entry.age.textContent = entry.since ? formatDuration(now - entry.since) : '';
    }

    // A busy agent becomes an alert purely by elapsing STALL_MS, so the banner
    // has to be re-evaluated on the clock, not only on store events.
    if (this._hasNewStall(now)) this._renderAlerts();
  }

  _hasNewStall(now) {
    for (const session of this._sessions()) {
      if (session.status !== STATUS.BUSY) continue;
      const agent = session.agent || {};
      if (!agent.tool || !agent.toolStartedAt) continue;
      if (now - agent.toolStartedAt <= STALL_MS) continue;
      if (!this._alerts.has('stalled:' + session.id)) return true;
    }
    for (const key of this._alerts.keys()) {
      if (!key.startsWith('stalled:')) continue;
      const session = this._session(key.slice('stalled:'.length));
      if (!session) return true;
      const agent = session.agent || {};
      if (session.status !== STATUS.BUSY || !agent.toolStartedAt) return true;
      if (now - agent.toolStartedAt <= STALL_MS) return true;
    }
    return false;
  }
}

export default SupervisionView;
