/**
 * Client state.
 *
 * One rule shapes this file: the server owns sessions. The store never invents
 * a session, never keeps one after a `closed`, and never rebuilds the list from
 * localStorage, because a cached terminal outliving a server restart is a ghost
 * tab that cannot be attached, killed or removed.
 *
 * localStorage holds preferences only, under a single versioned key.
 */

import { STATUS } from './protocol.js';

/** Single localStorage key. Everything the client persists lives inside it. */
export const STORAGE_KEY = 'orchestra.v2';

/** Bumped when the shape of the prefs object changes incompatibly. */
export const PREFS_VERSION = 1;

/** Ceiling on the in-memory timeline. */
export const MAX_EVENTS = 500;

const WRITE_DEBOUNCE_MS = 250;

/** How long a closed session id stays refused, so a reused id is not blocked forever. */
const TOMBSTONE_MS = 60000;

export const DEFAULT_PREFS = Object.freeze({
  version: PREFS_VERSION,
  theme: 'dark',
  sidebarWidth: 300,
  sidebarCollapsed: false,
  layout: { mode: 'single', paneIds: [] },
  zoom: 1,
  fontSize: 14,
  /** panelId -> true when collapsed. */
  collapsedPanels: {},
  /** action name -> key combo, overriding the built-in table. */
  shortcuts: {},
  /** Reopened on load only if the server still reports that session. */
  lastActiveId: null,
  lastCwd: null,
  timelineFilter: 'all',
  showTimeline: true,
  showApprovals: true,
  notifyOnApproval: true,
  soundOnApproval: false,

  /** Which top-level view is showing. */
  view: 'terminals',

  // Keys owned by settings.js.
  notifications: true,
  confirmClose: true,
  shortcutPrefix: 'Ctrl+K',

  // Keys owned by sidebar.js. They carry dots because the sidebar namespaces
  // its own preferences; setPref treats a key as opaque, so this is fine, but
  // they have to be declared here or migratePrefs drops them on reload.
  'sidebar.order': [],
  'sidebar.sort': 'urgency',
  // An empty list, not null: migratePrefs types each key off its default, so a
  // null default would reset every stored tag filter on reload.
  'sidebar.tagFilter': [],
  'sidebar.args': '',
  'sidebar.cwd': null,
});

function isPlainObject(v) {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

/** A new list with `item` appended, or merged onto the entry sharing its id. */
function upsertById(list, item) {
  const index = list.findIndex(entry => entry.id === item.id);
  if (index === -1) return [...list, item];
  const next = [...list];
  next[index] = { ...next[index], ...item };
  return next;
}

function cloneDefaults() {
  const out = {
    ...DEFAULT_PREFS,
    layout: { ...DEFAULT_PREFS.layout, paneIds: [] },
    collapsedPanels: {},
    shortcuts: {},
  };
  // Arrays in DEFAULT_PREFS are frozen and shared; every store needs its own,
  // or two instances would mutate the same list.
  for (const [key, value] of Object.entries(DEFAULT_PREFS)) {
    if (Array.isArray(value)) out[key] = [...value];
  }
  return out;
}

/**
 * Merges a stored blob onto the defaults, keeping only keys we know about so a
 * downgrade or a hand-edited value cannot poison the client.
 */
function migratePrefs(stored, logger) {
  const out = cloneDefaults();
  if (!isPlainObject(stored)) return out;
  const storedVersion = Number(stored.version);
  if (Number.isFinite(storedVersion) && storedVersion !== PREFS_VERSION) {
    logger.info(`prefs: migrating from version ${storedVersion} to ${PREFS_VERSION}`);
  }
  for (const key of Object.keys(DEFAULT_PREFS)) {
    if (key === 'version') continue;
    const value = stored[key];
    if (value === undefined || value === null) continue;
    const def = DEFAULT_PREFS[key];
    if (Array.isArray(def)) {
      if (Array.isArray(value)) out[key] = [...value];
      continue;
    }
    if (isPlainObject(def)) {
      if (isPlainObject(value)) out[key] = { ...def, ...value };
      continue;
    }
    if (typeof def === 'number') {
      const n = Number(value);
      if (Number.isFinite(n)) out[key] = n;
      continue;
    }
    if (typeof def === 'boolean') {
      out[key] = !!value;
      continue;
    }
    if (typeof value === 'string') out[key] = value;
  }
  return out;
}

const NOOP_LOGGER = {
  info: (...a) => console.info(...a),
  warn: (...a) => console.warn(...a),
  error: (...a) => console.error(...a),
};

/**
 * Central client state and a small event bus.
 *
 * Views subscribe to the narrow channel they care about so a single agent event
 * does not repaint the whole app. No view reads state back out of the DOM.
 *
 * Channels: "ready", "sessions" {sessions, order}, "session:<id>" (the session
 * or null once it is gone), "approvals" {pending, rules}, "quota", "connection"
 * ("connecting" | "online" | "offline"), "events" {event, events}, "races",
 * "projects", "active", "layout", "prefs", "pref:<key>", "navigate",
 * "server-restart", "stalled".
 */
export class Store {
  /**
   * @param {Object} [options]
   * @param {Storage|null} [options.storage]  defaults to window.localStorage
   * @param {Object} [options.logger]         {info, warn, error}
   * @param {boolean} [options.autoFlush]     flush prefs on pagehide, default true
   */
  constructor(options = {}) {
    this.logger = options.logger || NOOP_LOGGER;
    this._storage = options.storage !== undefined
      ? options.storage
      : (typeof localStorage !== 'undefined' ? localStorage : null);
    this._storageBroken = false;

    /** @type {Map<string, Set<Function>>} */
    this._listeners = new Map();

    this._prefs = this._loadPrefs();
    this._writeTimer = null;

    this.state = {
      sessions: new Map(),
      /** @type {string[]} */
      order: [],
      approvals: [],
      approvalRules: [],
      races: [],
      projects: [],
      quota: null,
      events: [],
      connection: 'connecting',
      /** @type {string|null} */
      activeId: null,
      layout: { ...this._prefs.layout, paneIds: [...(this._prefs.layout.paneIds || [])] },
      prefs: this._prefs,
      /** Filled by applyReady. */
      server: { serverId: null, platform: null, version: null, home: null, features: {} },
    };

    this._onPageHide = null;
    if (options.autoFlush !== false && typeof window !== 'undefined') {
      this._onPageHide = () => this.flushPrefs();
      window.addEventListener('pagehide', this._onPageHide);
      window.addEventListener('beforeunload', this._onPageHide);
    }
  }

  /**
   * @returns {() => void} unsubscribe
   */
  on(event, handler) {
    if (typeof event !== 'string' || event === '') {
      this.logger.warn(`store.on: event name must be a non-empty string, got ${typeof event}`);
      return () => {};
    }
    if (typeof handler !== 'function') {
      this.logger.warn(`store.on("${event}"): handler is not a function`);
      return () => {};
    }
    let set = this._listeners.get(event);
    if (!set) {
      set = new Set();
      this._listeners.set(event, set);
    }
    set.add(handler);
    let done = false;
    return () => {
      if (done) return;
      done = true;
      this.off(event, handler);
    };
  }

  off(event, handler) {
    const set = this._listeners.get(event);
    if (!set) return;
    set.delete(handler);
    if (set.size === 0) this._listeners.delete(event);
  }

  emit(event, payload) {
    const set = this._listeners.get(event);
    if (!set) return;
    for (const handler of [...set]) {
      try {
        handler(payload);
      } catch (err) {
        this.logger.error(`store: listener for "${event}" threw`, err);
      }
    }
  }

  /** Ordered session list, the only order any view should render. */
  sessionList() {
    const out = [];
    for (const id of this.state.order) {
      const s = this.state.sessions.get(id);
      if (s) out.push(s);
    }
    return out;
  }

  getSession(id) {
    return this.state.sessions.get(id) || null;
  }

  activeSession() {
    return this.state.activeId ? this.getSession(this.state.activeId) : null;
  }

  /**
   * Adopts a full server snapshot. Anything not in the payload stops existing.
   * @param {Object} payload {serverId, platform, version, home, features,
   *   sessions, approvals, rules, races, quota, events, activeId?}
   */
  applyReady(payload) {
    const p = isPlainObject(payload) ? payload : {};

    // Not every `ready` carries the identity block: the answer to a `list` is
    // the same message type with sessions only. A field absent from the payload
    // keeps the value we already hold, or serverId (which arms restart
    // detection) and the launcher's home and platform would be erased.
    const server = this.state.server;
    this.state.server = {
      serverId: p.serverId || server.serverId || null,
      platform: p.platform || server.platform || null,
      version: p.version || server.version || null,
      home: p.home || server.home || null,
      features: isPlainObject(p.features) ? p.features : server.features,
    };

    // Same reasoning: a payload with no session list says nothing about the
    // sessions, so it must not be read as "the server has none".
    if (Array.isArray(p.sessions)) this.setSessions(p.sessions);

    if (Array.isArray(p.approvals) || Array.isArray(p.rules)) {
      this.setApprovals(p.approvals, p.rules);
    }
    if (Array.isArray(p.races)) this.setRaces(p.races);
    if (p.quota !== undefined) this.setQuota(p.quota);
    if (Array.isArray(p.events)) this.setEvents(p.events);

    // Restore the last panel only if the server still knows about it.
    const wanted = typeof p.activeId === 'string' ? p.activeId : this._prefs.lastActiveId;
    if (!this.state.activeId) {
      if (wanted && this.state.sessions.has(wanted)) this.setActive(wanted);
      else if (this.state.order.length) this.setActive(this.state.order[0]);
    }

    this.setConnection('online');
    this.emit('ready', { ...this.state.server, sessions: this.sessionList() });
  }

  /** Replaces the whole session table with the server's view of it. */
  setSessions(list) {
    const next = new Map();
    const order = [];
    for (const raw of Array.isArray(list) ? list : []) {
      if (!raw || typeof raw.id !== 'string') continue;
      next.set(raw.id, raw);
      order.push(raw.id);
    }

    const gone = [];
    for (const id of this.state.sessions.keys()) {
      if (!next.has(id)) gone.push(id);
    }

    this.state.sessions = next;
    this.state.order = order;

    for (const id of gone) this.emit(`session:${id}`, null);
    for (const id of order) this.emit(`session:${id}`, next.get(id));

    if (this.state.activeId && !next.has(this.state.activeId)) {
      this.setActive(order.length ? order[0] : null);
    }
    this._pruneLayout();
    this._emitSessions();
  }

  /**
   * Merges a session record coming from the server. Partial patches are merged
   * onto what we already hold, so an agent-event carrying only {id, agent} does
   * not blank out the rest.
   */
  upsertSession(s) {
    if (!s || typeof s.id !== 'string') {
      this.logger.warn('store.upsertSession: payload has no id');
      return null;
    }
    // A late message about a session the server already closed would put a dead
    // row back in the sidebar and rebuild a panel that can never attach.
    if (this._isClosed(s.id)) return null;
    const existing = this.state.sessions.get(s.id);
    const merged = existing ? { ...existing, ...s } : s;
    if (existing && isPlainObject(existing.agent) && isPlainObject(s.agent)) {
      merged.agent = { ...existing.agent, ...s.agent };
    }
    this.state.sessions.set(s.id, merged);
    if (!existing) this.state.order.push(s.id);

    this.emit(`session:${s.id}`, merged);
    this._emitSessions();
    if (!this.state.activeId) this.setActive(s.id);
    return merged;
  }

  /**
   * Drops a session for good. Called on `closed`, never on `exit`: an exited
   * session keeps its scrollback and stays selectable until the server closes it.
   */
  removeSession(id) {
    // A PTY can keep emitting for a moment after the server announced the
    // session closed, so the id is remembered briefly (see _tombstone).
    this._tombstone(id);
    if (!this.state.sessions.has(id)) return false;
    const index = this.state.order.indexOf(id);
    this.state.sessions.delete(id);
    if (index !== -1) this.state.order.splice(index, 1);

    if (this.state.activeId === id) {
      const order = this.state.order;
      const nextId = order[Math.min(index, order.length - 1)] || null;
      this.setActive(nextId);
    }
    this._pruneLayout();
    this.emit(`session:${id}`, null);
    this._emitSessions();
    return true;
  }

  /** Records an id the server has closed, and expires stale entries. */
  _tombstone(id) {
    if (!this._closedIds) this._closedIds = new Map();
    this._closedIds.set(id, Date.now());
    if (this._closedIds.size > 200) {
      const cutoff = Date.now() - TOMBSTONE_MS;
      for (const [key, at] of this._closedIds) {
        if (at < cutoff) this._closedIds.delete(key);
      }
    }
  }

  /** True while a recently closed id must not be resurrected. */
  _isClosed(id) {
    if (!this._closedIds) return false;
    const at = this._closedIds.get(id);
    if (at === undefined) return false;
    if (Date.now() - at > TOMBSTONE_MS) {
      this._closedIds.delete(id);
      return false;
    }
    return true;
  }

  /** Applies an exit notice without removing the session. */
  markExited(id, exitCode) {
    const s = this.state.sessions.get(id);
    if (!s) return null;
    return this.upsertSession({
      id,
      status: STATUS.EXITED,
      exitCode: exitCode === undefined ? s.exitCode : exitCode,
      exitedAt: Date.now(),
    });
  }

  setActive(id) {
    const next = id && this.state.sessions.has(id) ? id : (id === null ? null : this.state.activeId);
    if (next === this.state.activeId) return;
    this.state.activeId = next;
    if (next) this.setPref('lastActiveId', next);
    this.emit('active', next);
  }

  _emitSessions() {
    this.emit('sessions', { sessions: this.sessionList(), order: [...this.state.order] });
  }

  setApprovals(pending, rules) {
    if (Array.isArray(pending)) this.state.approvals = pending;
    if (Array.isArray(rules)) this.state.approvalRules = rules;
    this._emitApprovals();
  }

  addApproval(entry) {
    if (!entry || typeof entry.id !== 'string') {
      this.logger.warn('store.addApproval: payload has no id');
      return;
    }
    this.state.approvals = upsertById(this.state.approvals, entry);
    this._emitApprovals();
  }

  /** Removes a pending entry once the server reports it resolved. */
  removeApproval(id) {
    const next = this.state.approvals.filter(a => a.id !== id);
    if (next.length === this.state.approvals.length) return false;
    this.state.approvals = next;
    this._emitApprovals();
    return true;
  }

  _emitApprovals() {
    this.emit('approvals', {
      pending: this.state.approvals,
      rules: this.state.approvalRules,
    });
  }

  /** Appends a timeline event, keeping the last MAX_EVENTS. */
  addEvent(e) {
    if (!e || typeof e !== 'object') {
      this.logger.warn('store.addEvent: expected an event object');
      return;
    }
    this.state.events.push(e);
    if (this.state.events.length > MAX_EVENTS) {
      this.state.events.splice(0, this.state.events.length - MAX_EVENTS);
    }
    this.emit('events', { event: e, events: this.state.events });
  }

  /** Replaces the timeline, e.g. after GET /api/timeline. */
  setEvents(list) {
    const events = Array.isArray(list) ? list.filter(e => e && typeof e === 'object') : [];
    this.state.events = events.length > MAX_EVENTS ? events.slice(-MAX_EVENTS) : events;
    this.emit('events', { event: null, events: this.state.events });
  }

  setRaces(list) {
    this.state.races = Array.isArray(list) ? list : [];
    this.emit('races', this.state.races);
  }

  upsertRace(race) {
    if (!race || typeof race.id !== 'string') {
      this.logger.warn('store.upsertRace: payload has no id');
      return;
    }
    this.state.races = upsertById(this.state.races, race);
    this.emit('races', this.state.races);
  }

  setQuota(q) {
    this.state.quota = q || null;
    this.emit('quota', this.state.quota);
  }

  /** @param {"connecting"|"online"|"offline"} s */
  setConnection(s) {
    if (s !== 'connecting' && s !== 'online' && s !== 'offline') {
      this.logger.warn(`store.setConnection: unknown state "${s}"`);
      return;
    }
    if (this.state.connection === s) return;
    this.state.connection = s;
    this.emit('connection', s);
  }

  /** @param {Object} patch {mode?, paneIds?} */
  setLayout(patch) {
    if (!isPlainObject(patch)) return;
    const next = { ...this.state.layout, ...patch };
    if (Array.isArray(patch.paneIds)) {
      next.paneIds = patch.paneIds.filter(id => this.state.sessions.has(id));
    }
    this.state.layout = next;
    this.setPref('layout', next);
    this.emit('layout', next);
  }

  _pruneLayout() {
    const paneIds = (this.state.layout.paneIds || []).filter(id => this.state.sessions.has(id));
    if (paneIds.length === (this.state.layout.paneIds || []).length) return;
    this.state.layout = { ...this.state.layout, paneIds };
    this.setPref('layout', this.state.layout);
    this.emit('layout', this.state.layout);
  }

  /**
   * The live preference object. Treat it as read only and go through setPref to
   * change anything, otherwise nothing is persisted and nothing is emitted.
   */
  prefs() {
    return this._prefs;
  }

  getPref(key, fallback) {
    const v = this._prefs[key];
    return v === undefined ? fallback : v;
  }

  /** Updates one preference and schedules a debounced write. */
  setPref(key, value) {
    if (typeof key !== 'string' || key === '' || key === 'version') {
      this.logger.warn(`store.setPref: invalid key "${key}"`);
      return;
    }
    if (this._prefs[key] === value) return;
    this._prefs[key] = value;
    this.state.prefs = this._prefs;
    this.emit(`pref:${key}`, value);
    this.emit('prefs', this._prefs);
    this._schedulePrefWrite();
  }

  // The views and the connection spell parts of this contract differently.
  // The aliases below reconcile them in one visible place.

  getSessions() {
    return this.sessionList();
  }

  getApprovals() {
    return this.state.approvals;
  }

  getEvents() {
    return this.state.events;
  }

  getProjects() {
    return this.state.projects || [];
  }

  setProjects(list) {
    this.state.projects = Array.isArray(list) ? list : [];
    this.emit('projects', this.state.projects);
  }

  /** Topic-style alias used by the sidebar and supervision views. */
  subscribe(topic, handler) {
    return this.on(topic, handler);
  }

  /**
   * A hook event carries both a timeline entry and, sometimes, a fresher view
   * of the session that produced it.
   */
  applyAgentEvent(event) {
    if (!event || typeof event !== 'object') return;
    this.addEvent(event);
    if (event.session) this.upsertSession(event.session);
    if (event.event === 'Stalled') this.emit('stalled', event);
  }

  /** Drops a resolved approval, whether the server named it `id` or `requestId`. */
  resolveApproval(msg) {
    const id = typeof msg === 'string' ? msg : (msg && (msg.id || msg.requestId));
    if (id) this.removeApproval(id);
  }

  setConnectionState(state, meta) {
    const map = { open: 'online', connecting: 'connecting', reconnecting: 'connecting', closed: 'offline' };
    this.setConnection(map[state] || state);
    if (meta && meta.serverId && this.state.server.serverId
        && meta.serverId !== this.state.server.serverId) {
      // A different server answered: the previous session ids are meaningless.
      this.emit('server-restart', meta);
    }
  }

  /** Current top-level view, persisted so a reload lands where you left. */
  setView(view, params) {
    if (typeof view !== 'string' || !view) return;
    this.setPref('view', view);
    this.emit('navigate', { view, ...(params || {}) });
  }

  _schedulePrefWrite() {
    if (this._writeTimer !== null) return;
    this._writeTimer = setTimeout(() => {
      this._writeTimer = null;
      this._writePrefs();
    }, WRITE_DEBOUNCE_MS);
  }

  /** Writes any pending preference change right now. */
  flushPrefs() {
    if (this._writeTimer !== null) {
      clearTimeout(this._writeTimer);
      this._writeTimer = null;
    }
    this._writePrefs();
  }

  _loadPrefs() {
    const defaults = cloneDefaults();
    if (!this._storage) return defaults;
    let raw;
    try {
      raw = this._storage.getItem(STORAGE_KEY);
    } catch (err) {
      // Private browsing and some enterprise policies throw on access.
      this._storageBroken = true;
      this.logger.warn(`prefs: localStorage is unreadable (${err.message}), using defaults`);
      return defaults;
    }
    if (!raw) return defaults;
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      this.logger.warn(`prefs: stored value is not valid JSON (${err.message}), using defaults`);
      return defaults;
    }
    return migratePrefs(parsed, this.logger);
  }

  _writePrefs() {
    if (!this._storage || this._storageBroken) return;
    let payload;
    try {
      payload = JSON.stringify({ ...this._prefs, version: PREFS_VERSION });
    } catch (err) {
      this.logger.error(`prefs: cannot serialize preferences (${err.message})`);
      return;
    }
    try {
      this._storage.setItem(STORAGE_KEY, payload);
    } catch (err) {
      this._storageBroken = true;
      this.logger.warn(`prefs: localStorage is unwritable (${err.message}), preferences will not persist`);
    }
  }

  /** Flushes preferences, drops listeners. For popouts and tests. */
  destroy() {
    this.flushPrefs();
    if (this._onPageHide && typeof window !== 'undefined') {
      window.removeEventListener('pagehide', this._onPageHide);
      window.removeEventListener('beforeunload', this._onPageHide);
      this._onPageHide = null;
    }
    this._listeners.clear();
  }
}
