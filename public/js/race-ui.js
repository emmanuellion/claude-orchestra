import { el, clear } from './dom.js';
import { S2C } from './protocol.js';

/** Below this width the arena stops being side by side and becomes tabs. */
const NARROW_QUERY = '(max-width: 900px)';
/** Cheap list refresh while at least one race is still running. */
const POLL_MS = 10000;
/** Patch lines rendered per cell before the operator has to ask for more. */
const CELL_LINES = 120;
const MIN_VARIANTS = 2;
const MAX_VARIANTS = 4;

const PRESETS = [
  { label: 'opus', name: 'opus', args: '--model opus' },
  { label: 'sonnet', name: 'sonnet', args: '--model sonnet' },
  { label: 'opus plan', name: 'opus-plan', args: '--model opus --permission-mode plan' },
];

function stateOf(store) {
  return store && store.state && typeof store.state === 'object' ? store.state : {};
}

function tokenOf(connection) {
  if (connection && typeof connection.token === 'string' && connection.token) return connection.token;
  const boot = typeof window !== 'undefined' ? window.__ORCHESTRA__ : null;
  return boot && typeof boot.token === 'string' ? boot.token : '';
}

/** The repository the operator is most likely to mean, in order of evidence. */
function defaultRepo(store) {
  const state = stateOf(store);
  const active = store && typeof store.activeSession === 'function' ? store.activeSession() : null;
  if (active && active.cwd) return active.cwd;
  const prefs = state.prefs || {};
  if (typeof prefs.lastCwd === 'string' && prefs.lastCwd) return prefs.lastCwd;
  const sessions = store && typeof store.sessionList === 'function' ? store.sessionList() : [];
  const withCwd = sessions.find(s => s.cwd);
  return withCwd ? withCwd.cwd : '';
}

function basename(p) {
  const s = String(p == null ? '' : p);
  const parts = s.split(/[\\/]+/).filter(Boolean);
  return parts.length ? parts[parts.length - 1] : s;
}

function formatCost(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '-';
  if (value === 0) return '$0.00';
  return value < 0.01 ? `$${value.toFixed(4)}` : `$${value.toFixed(2)}`;
}

function formatDuration(ms) {
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < 0) return '-';
  const total = Math.floor(ms / 1000);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}

function formatDate(ts) {
  if (typeof ts !== 'number' || !Number.isFinite(ts)) return '-';
  return new Date(ts).toLocaleString();
}

function classifyDiffLine(line) {
  if (line.startsWith('@@')) return 'diff-line diff-hunk';
  if (line.startsWith('+++') || line.startsWith('---')) return 'diff-line diff-meta';
  if (line.startsWith('diff --git') || line.startsWith('index ')) return 'diff-line diff-meta';
  if (line.startsWith('new file') || line.startsWith('deleted file')) return 'diff-line diff-meta';
  if (line.startsWith('similarity ') || line.startsWith('Binary files')) return 'diff-line diff-meta';
  if (line.startsWith('+')) return 'diff-line diff-add';
  if (line.startsWith('-')) return 'diff-line diff-del';
  return 'diff-line diff-ctx';
}

function button(cls, label) {
  const node = el('button', { class: cls, text: label });
  node.type = 'button';
  return node;
}

function metric(label, value) {
  const wrap = el('div', { class: 'race-metric' });
  wrap.appendChild(el('span', { class: 'race-metric-label', text: label }));
  const node = el('span', { class: 'race-metric-value', text: value });
  wrap.appendChild(node);
  return { wrap, node };
}

/**
 * Race mode: the same prompt handed to several agents in isolated worktrees,
 * then their diffs put side by side so a human can pick a winner on evidence
 * instead of on vibes.
 */
export class RaceView {
  /**
   * @param {{store: Object, connection: Object, api?: Object}} deps  `api` is a
   *   REST helper exposing get/post/del or request(method, path, body); without
   *   it `fetch` is used
   */
  constructor(root, { store, connection, api = null } = {}) {
    if (!root) throw new Error('RaceView needs a root element');
    this.root = root;
    this.store = store;
    this.connection = connection;
    this.api = api;

    this.tab = 'races';
    this.races = [];
    this.scoreboard = [];
    this.selectedId = null;
    this.detail = null;
    this.detailLoading = false;
    this.detailError = '';
    this.error = '';
    this.notice = '';
    this.busy = false;
    this.confirm = null;
    this.formOpen = true;
    this.form = {
      prompt: '',
      repo: null,
      variants: [
        { name: PRESETS[0].name, args: PRESETS[0].args },
        { name: PRESETS[1].name, args: PRESETS[1].args },
      ],
    };
    this.arenaVariant = null;
    this.expanded = new Set();

    this._off = [];
    this._tickTimer = null;
    this._pollTimer = null;
    this._durations = [];
    this._narrow = false;
    this._media = null;
    this._onMedia = null;
    this._mounted = false;
  }

  mount() {
    if (this._mounted) return this;
    this._mounted = true;
    this.root.classList.add('race-view');

    if (typeof window.matchMedia === 'function') {
      this._media = window.matchMedia(NARROW_QUERY);
      this._narrow = this._media.matches;
      this._onMedia = event => {
        this._narrow = event.matches;
        this.render();
      };
      if (typeof this._media.addEventListener === 'function') {
        this._media.addEventListener('change', this._onMedia);
      } else {
        this._media.addListener(this._onMedia);
      }
    }

    this._subscribeStore('sessions');
    this._listen(S2C.RACE, () => this.loadRaces());

    // Seed from whatever the bootstrap snapshot already put in the store so
    // the panel is never blank while the first fetch is in flight.
    const seeded = stateOf(this.store).races;
    if (Array.isArray(seeded) && seeded.length) {
      this.races = seeded;
      this.selectedId = seeded[0].id;
    }

    this._tickTimer = window.setInterval(() => this.tick(), 1000);
    this._pollTimer = window.setInterval(() => {
      if (this.races.some(r => r.status === 'running')) this.loadRaces();
    }, POLL_MS);

    this.render();
    this.loadRaces();
    this.loadScoreboard();
    return this;
  }

  destroy() {
    this._mounted = false;
    if (this._tickTimer) {
      window.clearInterval(this._tickTimer);
      this._tickTimer = null;
    }
    if (this._pollTimer) {
      window.clearInterval(this._pollTimer);
      this._pollTimer = null;
    }
    if (this._media && this._onMedia) {
      if (typeof this._media.removeEventListener === 'function') {
        this._media.removeEventListener('change', this._onMedia);
      } else {
        this._media.removeListener(this._onMedia);
      }
    }
    for (const off of this._off) off();
    this._off = [];
    this._durations = [];
    clear(this.root);
    this.root.classList.remove('race-view');
  }

  _subscribeStore(event) {
    const store = this.store;
    if (!store || typeof store.on !== 'function') return;
    this._off.push(store.on(event, () => this.render()));
  }

  _listen(type, fn) {
    const conn = this.connection;
    if (!conn || typeof conn.on !== 'function') return;
    this._off.push(conn.on(type, fn));
  }

  async request(method, path, body) {
    const api = this.api;
    if (api) {
      if (method === 'GET' && typeof api.get === 'function') return api.get(path);
      if (method === 'POST' && typeof api.post === 'function') return api.post(path, body);
      if (method === 'DELETE') {
        const del = api.del || api.delete;
        if (typeof del === 'function') return del.call(api, path);
      }
      if (typeof api.request === 'function') return api.request(method, path, body);
    }
    const headers = { Accept: 'application/json' };
    const token = tokenOf(this.connection);
    if (token) headers.Authorization = `Bearer ${token}`;
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const res = await fetch(path, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let parsed = null;
    if (text) {
      try {
        parsed = JSON.parse(text);
      } catch (e) {
        if (!res.ok) throw new Error(text.slice(0, 300));
        throw new Error(`unreadable server response: ${e.message}`);
      }
    }
    if (!res.ok) {
      const message = parsed && (parsed.error || parsed.message);
      throw new Error(message || `HTTP ${res.status}`);
    }
    return parsed;
  }

  async loadRaces() {
    try {
      const races = await this.request('GET', '/api/race');
      this.races = Array.isArray(races) ? races : [];
      if (this.selectedId && !this.races.some(r => r.id === this.selectedId)) {
        this.selectedId = null;
        this.detail = null;
      }
      if (!this.selectedId && this.races.length) this.select(this.races[0].id);
      else this.render();
    } catch (e) {
      this.error = `Could not load races: ${e.message}`;
      this.render();
    }
  }

  async loadScoreboard() {
    try {
      const entries = await this.request('GET', '/api/scoreboard');
      this.scoreboard = Array.isArray(entries) ? entries : [];
    } catch (e) {
      this.error = `Could not load the scoreboard: ${e.message}`;
    }
    this.render();
  }

  async select(raceId) {
    this.selectedId = raceId;
    this.detail = null;
    this.detailError = '';
    this.arenaVariant = null;
    this.expanded.clear();
    this.render();
    await this.loadDetail();
  }

  async loadDetail() {
    if (!this.selectedId) return;
    const wanted = this.selectedId;
    this.detailLoading = true;
    this.detailError = '';
    this.render();
    try {
      const detail = await this.request('GET', `/api/race/${encodeURIComponent(wanted)}`);
      if (this.selectedId !== wanted) return;
      this.detail = detail && typeof detail === 'object' ? detail : null;
      if (this.detail && this.detail.race && !this.arenaVariant) {
        const first = (this.detail.race.variants || [])[0];
        this.arenaVariant = first ? first.name : null;
      }
    } catch (e) {
      if (this.selectedId === wanted) this.detailError = e.message;
    } finally {
      if (this.selectedId === wanted) this.detailLoading = false;
      this.render();
    }
  }

  async startRace() {
    const prompt = this.form.prompt.trim();
    if (!prompt) {
      this.error = 'A race needs a prompt.';
      this.render();
      return;
    }
    const repo = (this.form.repo || '').trim();
    if (!repo) {
      this.error = 'A race needs a repository path.';
      this.render();
      return;
    }
    const variants = this.form.variants
      .map(v => ({ name: v.name.trim(), args: v.args.trim() }))
      .filter(v => v.name);
    if (variants.length < MIN_VARIANTS) {
      this.error = `A race needs at least ${MIN_VARIANTS} named variants.`;
      this.render();
      return;
    }

    this.busy = true;
    this.error = '';
    this.notice = '';
    this.render();
    try {
      const race = await this.request('POST', '/api/race', { prompt, repo, variants });
      this.notice = `Race started with ${variants.length} variants.`;
      this.formOpen = false;
      await this.loadRaces();
      if (race && race.id) await this.select(race.id);
    } catch (e) {
      this.error = `Could not start the race: ${e.message}`;
    } finally {
      this.busy = false;
      this.render();
    }
  }

  async adopt(raceId, variantName) {
    this.busy = true;
    this.error = '';
    this.notice = '';
    this.confirm = null;
    this.render();
    try {
      const result = await this.request('POST', `/api/race/${encodeURIComponent(raceId)}/adopt`, {
        variant: variantName,
      });
      if (!result || result.ok !== true) {
        const message = (result && result.message) || 'The server refused the adoption.';
        this.error = result && result.conflict
          ? `Merge conflict. ${message}`
          : message;
      } else {
        const removed = Array.isArray(result.removed) ? result.removed : [];
        this.notice = `Merged ${result.branch} into ${result.target}`
          + (result.mergeCommit ? ` as ${String(result.mergeCommit).slice(0, 8)}` : '')
          + (removed.length ? `. Removed ${removed.length} losing worktree(s): ${removed.join(', ')}.` : '.');
      }
    } catch (e) {
      this.error = `Adoption failed: ${e.message}`;
    } finally {
      this.busy = false;
      await this.loadRaces();
      await this.loadScoreboard();
      if (this.selectedId === raceId) await this.loadDetail();
      this.render();
    }
  }

  async discard(raceId) {
    this.busy = true;
    this.error = '';
    this.notice = '';
    this.confirm = null;
    this.render();
    try {
      const result = await this.request('DELETE', `/api/race/${encodeURIComponent(raceId)}`);
      const problems = result && Array.isArray(result.problems) ? result.problems : [];
      if (problems.length) this.error = `Cleanup left problems: ${problems.join('; ')}`;
      else this.notice = 'Race discarded and worktrees removed.';
      if (this.selectedId === raceId) {
        this.selectedId = null;
        this.detail = null;
      }
    } catch (e) {
      this.error = `Could not discard the race: ${e.message}`;
    } finally {
      this.busy = false;
      await this.loadRaces();
      await this.loadScoreboard();
      this.render();
    }
  }

  /** Live agent state for a variant, store first, server decoration second. */
  variantState(variant) {
    const session = variant.sessionId && this.store && typeof this.store.getSession === 'function'
      ? this.store.getSession(variant.sessionId)
      : null;
    if (session) {
      const agent = session.agent || {};
      return {
        status: session.status || 'unknown',
        model: agent.model || null,
        tool: agent.tool || null,
        cost: typeof agent.cost === 'number' ? agent.cost : null,
        turns: typeof agent.turns === 'number' ? agent.turns : null,
        startedAt: session.createdAt || null,
        endedAt: session.exitedAt || null,
        live: !session.exitedAt,
      };
    }
    const decorated = variant.session;
    if (decorated) {
      return {
        status: decorated.status || 'unknown',
        model: decorated.model || null,
        tool: decorated.tool || null,
        cost: typeof decorated.cost === 'number' ? decorated.cost : null,
        turns: typeof decorated.turns === 'number' ? decorated.turns : null,
        startedAt: null,
        endedAt: null,
        durationMs: typeof decorated.durationMs === 'number' ? decorated.durationMs : null,
        live: false,
      };
    }
    return {
      status: 'gone', model: null, tool: null, cost: null, turns: null,
      startedAt: null, endedAt: null, durationMs: null, live: false,
    };
  }

  durationOf(vs) {
    if (typeof vs.durationMs === 'number') return vs.durationMs;
    if (!vs.startedAt) return null;
    return (vs.endedAt || Date.now()) - vs.startedAt;
  }

  tick() {
    const now = Date.now();
    for (const item of this._durations) {
      if (!item.startedAt) continue;
      item.node.textContent = formatDuration((item.endedAt || now) - item.startedAt);
    }
  }

  render() {
    if (!this._mounted) return;
    if (this.form.repo === null) this.form.repo = defaultRepo(this.store);
    this._durations = [];

    clear(this.root);
    this.root.classList.toggle('is-narrow', this._narrow);
    this.root.appendChild(this.renderTabs());

    if (this.notice) {
      this.root.appendChild(el('div', { class: 'race-notice', text: this.notice }));
    }
    if (this.error) {
      const box = el('div', { class: 'race-error' });
      box.appendChild(el('span', { class: 'race-error-text', text: this.error }));
      const dismiss = button('race-error-dismiss', 'Dismiss');
      dismiss.addEventListener('click', () => {
        this.error = '';
        this.render();
      });
      box.appendChild(dismiss);
      this.root.appendChild(box);
    }

    if (this.tab === 'scoreboard') {
      this.root.appendChild(this.renderScoreboard());
      return;
    }

    this.root.appendChild(this.renderLaunchForm());
    this.root.appendChild(this.renderRaceList());
    if (this.confirm) this.root.appendChild(this.renderConfirm());
    const selected = this.races.find(r => r.id === this.selectedId);
    if (selected) {
      this.root.appendChild(this.renderRunning(selected));
      this.root.appendChild(this.renderArena(selected));
    }
  }

  renderTabs() {
    const tabs = el('div', { class: 'race-tabs' });
    for (const [key, label] of [['races', 'Races'], ['scoreboard', 'Scoreboard']]) {
      const tab = button(`race-tab${this.tab === key ? ' is-active' : ''}`, label);
      tab.addEventListener('click', () => {
        this.tab = key;
        if (key === 'scoreboard') this.loadScoreboard();
        else this.render();
      });
      tabs.appendChild(tab);
    }
    return tabs;
  }

  renderLaunchForm() {
    const section = el('section', { class: 'race-launch' });
    const toggle = button('race-launch-toggle', this.formOpen ? 'Hide new race' : 'New race');
    toggle.addEventListener('click', () => {
      this.formOpen = !this.formOpen;
      this.render();
    });
    section.appendChild(toggle);

    const body = el('div', { class: 'race-launch-body' });
    body.hidden = !this.formOpen;

    const promptField = el('div', { class: 'race-field' });
    promptField.appendChild(el('label', { class: 'race-label', text: 'Prompt' }));
    const prompt = el('textarea', { class: 'race-prompt' });
    prompt.rows = 4;
    prompt.value = this.form.prompt;
    prompt.placeholder = 'What every variant should do';
    prompt.addEventListener('input', () => { this.form.prompt = prompt.value; });
    promptField.appendChild(prompt);
    body.appendChild(promptField);

    const repoField = el('div', { class: 'race-field' });
    repoField.appendChild(el('label', { class: 'race-label', text: 'Repository' }));
    const repo = el('input', { class: 'race-repo' });
    repo.type = 'text';
    repo.spellcheck = false;
    repo.value = this.form.repo || '';
    repo.placeholder = 'Path to a git repository';
    repo.addEventListener('input', () => { this.form.repo = repo.value; });
    repoField.appendChild(repo);
    body.appendChild(repoField);

    const variants = el('div', { class: 'race-variants' });
    variants.appendChild(el('div', { class: 'race-label', text: `Variants (${MIN_VARIANTS} to ${MAX_VARIANTS})` }));
    this.form.variants.forEach((variant, index) => {
      variants.appendChild(this.renderVariantRow(variant, index));
    });
    const add = button('race-add-variant', 'Add variant');
    add.disabled = this.form.variants.length >= MAX_VARIANTS;
    add.addEventListener('click', () => {
      const preset = PRESETS[this.form.variants.length % PRESETS.length];
      this.form.variants.push({ name: `${preset.name}-${this.form.variants.length + 1}`, args: preset.args });
      this.render();
    });
    variants.appendChild(add);
    body.appendChild(variants);

    const submit = button('race-submit', this.busy ? 'Working...' : 'Start race');
    submit.disabled = this.busy;
    submit.addEventListener('click', () => this.startRace());
    body.appendChild(submit);

    section.appendChild(body);
    return section;
  }

  renderVariantRow(variant, index) {
    const row = el('div', { class: 'race-variant-row' });

    const name = el('input', { class: 'race-variant-name' });
    name.type = 'text';
    name.value = variant.name;
    name.placeholder = 'name';
    name.spellcheck = false;
    name.addEventListener('input', () => { variant.name = name.value; });
    row.appendChild(name);

    const args = el('input', { class: 'race-variant-args' });
    args.type = 'text';
    args.value = variant.args;
    args.placeholder = 'claude arguments';
    args.spellcheck = false;
    args.addEventListener('input', () => { variant.args = args.value; });
    row.appendChild(args);

    const presets = el('div', { class: 'race-presets' });
    for (const preset of PRESETS) {
      const chip = button('race-preset', preset.label);
      chip.title = preset.args;
      chip.addEventListener('click', () => {
        variant.name = preset.name;
        variant.args = preset.args;
        this.render();
      });
      presets.appendChild(chip);
    }
    row.appendChild(presets);

    const remove = button('race-variant-remove', 'Remove');
    remove.disabled = this.form.variants.length <= MIN_VARIANTS;
    remove.addEventListener('click', () => {
      this.form.variants.splice(index, 1);
      this.render();
    });
    row.appendChild(remove);
    return row;
  }

  renderRaceList() {
    const section = el('section', { class: 'race-list' });
    if (this.races.length === 0) {
      section.appendChild(el('div', { class: 'race-empty', text: 'No race yet.' }));
      return section;
    }
    for (const race of this.races) {
      const item = el('div', { class: `race-list-item${race.id === this.selectedId ? ' is-selected' : ''}` });
      const open = button('race-list-open', '');
      const prompt = el('span', { class: 'race-list-prompt' });
      prompt.textContent = race.prompt || '(no prompt)';
      open.appendChild(prompt);
      const meta = el('span', { class: 'race-list-meta' });
      const names = (race.variants || []).map(v => v.name).join(', ');
      meta.textContent = `${basename(race.repo)} - ${race.status}`
        + (race.winner ? ` - won by ${race.winner}` : '')
        + ` - ${names} - ${formatDate(race.createdAt)}`;
      open.appendChild(meta);
      open.addEventListener('click', () => this.select(race.id));
      item.appendChild(open);

      const drop = button('race-discard', 'Discard');
      drop.disabled = this.busy;
      drop.addEventListener('click', () => {
        this.confirm = { kind: 'discard', raceId: race.id };
        this.render();
      });
      item.appendChild(drop);
      section.appendChild(item);
    }
    return section;
  }

  renderRunning(race) {
    const section = el('section', { class: 'race-running' });
    const head = el('div', { class: 'race-running-head' });
    const title = el('h3', { class: 'race-running-title' });
    title.textContent = race.prompt || '(no prompt)';
    head.appendChild(title);
    const sub = el('div', { class: 'race-running-meta' });
    sub.textContent = `${race.repo} - base ${String(race.baseCommit || '').slice(0, 8)}`
      + (race.baseBranch ? ` on ${race.baseBranch}` : ' on a detached HEAD');
    head.appendChild(sub);
    section.appendChild(head);

    if (race.dirtyBase) {
      section.appendChild(el('div', {
        class: 'race-warning',
        text: 'The repository had uncommitted changes when this race started. The worktrees do not contain them.',
      }));
    }
    if (!race.baseBranch) {
      section.appendChild(el('div', {
        class: 'race-warning',
        text: 'This race started from a detached HEAD, so adoption cannot merge automatically.',
      }));
    }

    const columns = el('div', { class: 'race-columns' });
    for (const variant of race.variants || []) {
      columns.appendChild(this.renderVariantColumn(race, variant));
    }
    section.appendChild(columns);
    return section;
  }

  renderVariantColumn(race, variant) {
    const vs = this.variantState(variant);
    const column = el('div', { class: 'race-column' });
    if (race.winner === variant.name) column.classList.add('is-winner');

    const head = el('div', { class: 'race-column-head' });
    head.appendChild(el('span', { class: 'race-column-name', text: variant.name }));
    const status = el('span', { class: `race-column-status status-${vs.status}`, text: vs.status });
    head.appendChild(status);
    column.appendChild(head);

    const args = el('div', { class: 'race-column-args' });
    args.textContent = variant.args || 'no extra arguments';
    column.appendChild(args);

    const metrics = el('div', { class: 'race-column-metrics' });
    metrics.appendChild(metric('cost', formatCost(vs.cost)).wrap);
    const duration = metric('duration', formatDuration(this.durationOf(vs)));
    metrics.appendChild(duration.wrap);
    this._durations.push({ node: duration.node, startedAt: vs.startedAt, endedAt: vs.endedAt });
    metrics.appendChild(metric('turns', vs.turns == null ? '-' : String(vs.turns)).wrap);
    metrics.appendChild(metric('model', vs.model || '-').wrap);
    metrics.appendChild(metric('tool', vs.tool || 'idle').wrap);
    column.appendChild(metrics);

    const branch = el('div', { class: 'race-column-branch' });
    branch.textContent = variant.branch || '';
    column.appendChild(branch);

    if (race.status === 'running') {
      const adopt = button('race-adopt', `Adopt ${variant.name}`);
      adopt.disabled = this.busy;
      adopt.addEventListener('click', () => {
        this.confirm = { kind: 'adopt', raceId: race.id, variant: variant.name };
        this.render();
      });
      column.appendChild(adopt);
    }
    return column;
  }

  renderConfirm() {
    const race = this.races.find(r => r.id === this.confirm.raceId);
    const box = el('div', { class: 'race-confirm' });
    const text = el('p', { class: 'race-confirm-text' });

    if (!race) {
      text.textContent = 'That race is gone.';
    } else if (this.confirm.kind === 'adopt') {
      const winner = (race.variants || []).find(v => v.name === this.confirm.variant);
      const losers = (race.variants || []).filter(v => v.name !== this.confirm.variant);
      const target = race.baseBranch || 'no branch (detached HEAD)';
      text.textContent = `Commit anything left in the "${this.confirm.variant}" worktree, merge `
        + `${winner ? winner.branch : this.confirm.variant} into ${target}, then stop the `
        + `${losers.length} losing agent(s) and delete their worktrees and branches`
        + (losers.length ? ` (${losers.map(v => v.name).join(', ')})` : '')
        + `. The winner keeps its worktree and session.`;
    } else {
      const count = (race.variants || []).length;
      text.textContent = `Stop all ${count} agents, delete their worktrees and branches, and remove this `
        + 'race. Nothing is merged and the work is lost.';
    }
    box.appendChild(text);

    const actions = el('div', { class: 'race-confirm-actions' });
    const yes = button('race-confirm-yes', this.confirm.kind === 'adopt' ? 'Adopt' : 'Discard');
    yes.disabled = !race || this.busy;
    yes.addEventListener('click', () => {
      if (this.confirm.kind === 'adopt') this.adopt(this.confirm.raceId, this.confirm.variant);
      else this.discard(this.confirm.raceId);
    });
    const no = button('race-confirm-no', 'Cancel');
    no.addEventListener('click', () => {
      this.confirm = null;
      this.render();
    });
    actions.appendChild(yes);
    actions.appendChild(no);
    box.appendChild(actions);
    return box;
  }

  renderArena(race) {
    const section = el('section', { class: 'arena' });
    const head = el('div', { class: 'arena-head' });
    head.appendChild(el('h3', { class: 'arena-title', text: 'Arena' }));
    const refresh = button('arena-refresh', this.detailLoading ? 'Loading...' : 'Refresh diffs');
    refresh.disabled = this.detailLoading;
    refresh.addEventListener('click', () => this.loadDetail());
    head.appendChild(refresh);
    section.appendChild(head);

    if (this.detailError) {
      section.appendChild(el('div', { class: 'race-error', text: `Could not read the diffs: ${this.detailError}` }));
      return section;
    }
    if (!this.detail) {
      section.appendChild(el('div', {
        class: 'race-loading',
        text: this.detailLoading ? 'Reading the worktrees...' : 'No diff loaded.',
      }));
      return section;
    }

    const names = (race.variants || []).map(v => v.name);
    section.appendChild(this.renderArenaSummary(race, names));

    const files = Array.isArray(this.detail.files) ? this.detail.files : [];
    if (files.length === 0) {
      section.appendChild(el('div', { class: 'race-empty', text: 'No variant has changed a file yet.' }));
      return section;
    }

    if (this._narrow) {
      section.appendChild(this.renderArenaVariantTabs(names));
    }
    for (const file of files) {
      section.appendChild(this.renderArenaFile(file, names));
    }
    return section;
  }

  renderArenaSummary(race, names) {
    const summary = this.detail.summary || {};
    const table = el('div', { class: 'arena-summary' });
    const header = el('div', { class: 'arena-summary-row is-head' });
    for (const label of ['variant', 'files', 'added', 'removed', 'cost', 'duration', 'status']) {
      header.appendChild(el('span', { class: 'arena-summary-cell', text: label }));
    }
    table.appendChild(header);

    for (const name of names) {
      const s = summary[name] || {};
      const variant = (race.variants || []).find(v => v.name === name) || { name };
      const vs = this.variantState(variant);
      const row = el('div', { class: 'arena-summary-row' });
      if (race.winner === name) row.classList.add('is-winner');
      row.appendChild(el('span', { class: 'arena-summary-cell', text: name }));
      row.appendChild(el('span', { class: 'arena-summary-cell', text: String(s.files || 0) }));
      row.appendChild(el('span', { class: 'arena-summary-cell diff-add', text: `+${s.additions || 0}` }));
      row.appendChild(el('span', { class: 'arena-summary-cell diff-del', text: `-${s.deletions || 0}` }));
      row.appendChild(el('span', {
        class: 'arena-summary-cell',
        text: formatCost(typeof s.cost === 'number' ? s.cost : vs.cost),
      }));
      const durationCell = el('span', { class: 'arena-summary-cell' });
      const ms = typeof s.durationMs === 'number' ? s.durationMs : this.durationOf(vs);
      durationCell.textContent = formatDuration(ms);
      if (vs.live && vs.startedAt) {
        this._durations.push({ node: durationCell, startedAt: vs.startedAt, endedAt: vs.endedAt });
      }
      row.appendChild(durationCell);
      row.appendChild(el('span', { class: 'arena-summary-cell', text: s.error ? s.error : vs.status }));
      table.appendChild(row);
    }
    return table;
  }

  renderArenaVariantTabs(names) {
    const tabs = el('div', { class: 'arena-variant-tabs' });
    for (const name of names) {
      const tab = button(`arena-variant-tab${this.arenaVariant === name ? ' is-active' : ''}`, name);
      tab.addEventListener('click', () => {
        this.arenaVariant = name;
        this.render();
      });
      tabs.appendChild(tab);
    }
    return tabs;
  }

  renderArenaFile(file, names) {
    const block = el('div', { class: 'arena-file' });
    const head = el('div', { class: 'arena-file-head' });
    const path = el('span', { class: 'arena-file-path' });
    path.textContent = file.path;
    head.appendChild(path);
    const touched = names.filter(n => file.variants && file.variants[n]);
    head.appendChild(el('span', {
      class: 'arena-file-meta',
      text: `${touched.length} of ${names.length} variants`,
    }));
    block.appendChild(head);

    const grid = el('div', { class: 'arena-grid' });
    const shown = this._narrow && this.arenaVariant ? [this.arenaVariant] : names;
    grid.dataset.columns = String(shown.length);
    for (const name of shown) {
      grid.appendChild(this.renderArenaCell(file, name));
    }
    block.appendChild(grid);
    return block;
  }

  renderArenaCell(file, name) {
    const entry = file.variants ? file.variants[name] : null;
    const cell = el('div', { class: 'arena-cell' });
    const head = el('div', { class: 'arena-cell-head' });
    head.appendChild(el('span', { class: 'arena-cell-name', text: name }));

    if (!entry) {
      head.appendChild(el('span', { class: 'arena-cell-tag', text: 'unchanged' }));
      cell.classList.add('arena-cell-unchanged');
      cell.appendChild(head);
      return cell;
    }

    head.appendChild(el('span', { class: 'arena-cell-tag', text: entry.status || 'M' }));
    head.appendChild(el('span', { class: 'arena-cell-stat diff-add', text: `+${entry.additions || 0}` }));
    head.appendChild(el('span', { class: 'arena-cell-stat diff-del', text: `-${entry.deletions || 0}` }));
    cell.appendChild(head);

    if (entry.binary) {
      cell.classList.add('arena-cell-binary');
      cell.appendChild(el('div', { class: 'arena-cell-note', text: 'Binary file, no textual diff.' }));
      return cell;
    }
    if (!entry.patch) {
      cell.appendChild(el('div', {
        class: 'arena-cell-note',
        text: entry.truncated ? 'Patch omitted: too many changed files.' : 'No patch available.',
      }));
      return cell;
    }

    const key = `${file.path}::${name}`;
    const lines = String(entry.patch).split('\n');
    const expanded = this.expanded.has(key);
    const shown = expanded ? lines : lines.slice(0, CELL_LINES);
    const body = el('div', { class: 'arena-cell-diff' });
    for (const line of shown) {
      const row = el('div', { class: classifyDiffLine(line) });
      row.textContent = line === '' ? ' ' : line;
      body.appendChild(row);
    }
    cell.appendChild(body);

    if (lines.length > shown.length) {
      const more = button('arena-more', `Show all ${lines.length} lines`);
      more.addEventListener('click', () => {
        this.expanded.add(key);
        this.render();
      });
      cell.appendChild(more);
    }
    if (entry.truncated) {
      cell.appendChild(el('div', { class: 'arena-cell-note', text: 'Patch truncated by the server.' }));
    }
    return cell;
  }

  renderScoreboard() {
    const section = el('section', { class: 'scoreboard' });
    if (this.scoreboard.length === 0) {
      section.appendChild(el('div', { class: 'race-empty', text: 'No finished race yet.' }));
      return section;
    }

    section.appendChild(this.renderAggregate());

    const table = el('div', { class: 'scoreboard-table' });
    const head = el('div', { class: 'scoreboard-row is-head' });
    for (const label of ['when', 'repo', 'prompt', 'winner', 'variants']) {
      head.appendChild(el('span', { class: 'scoreboard-cell', text: label }));
    }
    table.appendChild(head);

    for (const entry of this.scoreboard) {
      const row = el('div', { class: 'scoreboard-row' });
      row.appendChild(el('span', { class: 'scoreboard-cell', text: formatDate(entry.ts) }));
      const repo = el('span', { class: 'scoreboard-cell' });
      repo.textContent = basename(entry.repo);
      repo.title = entry.repo || '';
      row.appendChild(repo);
      const prompt = el('span', { class: 'scoreboard-cell scoreboard-prompt' });
      prompt.textContent = entry.prompt || '';
      prompt.title = entry.prompt || '';
      row.appendChild(prompt);
      row.appendChild(el('span', {
        class: 'scoreboard-cell scoreboard-winner',
        text: entry.winner || 'none',
      }));
      const variants = el('span', { class: 'scoreboard-cell scoreboard-variants' });
      for (const variant of entry.variants || []) {
        const chip = el('span', { class: 'scoreboard-chip' });
        if (variant.name === entry.winner) chip.classList.add('is-winner');
        chip.textContent = `${variant.name} ${formatCost(variant.cost)} ${formatDuration(variant.durationMs)} `
          + `+${variant.additions || 0}/-${variant.deletions || 0}`;
        variants.appendChild(chip);
      }
      row.appendChild(variants);
      table.appendChild(row);
    }
    section.appendChild(table);
    return section;
  }

  renderAggregate() {
    const totals = new Map();
    for (const entry of this.scoreboard) {
      for (const variant of entry.variants || []) {
        let agg = totals.get(variant.name);
        if (!agg) {
          agg = { name: variant.name, races: 0, wins: 0, cost: 0, costed: 0, duration: 0, timed: 0 };
          totals.set(variant.name, agg);
        }
        agg.races += 1;
        if (entry.winner === variant.name) agg.wins += 1;
        if (typeof variant.cost === 'number') {
          agg.cost += variant.cost;
          agg.costed += 1;
        }
        if (typeof variant.durationMs === 'number') {
          agg.duration += variant.durationMs;
          agg.timed += 1;
        }
      }
    }

    const rows = [...totals.values()].sort((a, b) => b.wins - a.wins || b.races - a.races);
    for (const row of rows) {
      row.avgCost = row.costed ? row.cost / row.costed : null;
      row.avgDuration = row.timed ? row.duration / row.timed : null;
    }
    const cheapest = rows
      .filter(r => typeof r.avgCost === 'number' && r.avgCost > 0)
      .sort((a, b) => a.avgCost - b.avgCost)[0] || null;

    const box = el('div', { class: 'scoreboard-aggregate' });
    box.appendChild(el('h3', { class: 'scoreboard-aggregate-title', text: 'Per variant' }));
    for (const row of rows) {
      const line = el('div', { class: 'scoreboard-agg-row' });
      let text = `${row.name} won ${row.wins} of ${row.races} races`;
      if (row.avgCost != null) text += `, ${formatCost(row.avgCost)} per race on average`;
      if (row.avgDuration != null) text += `, ${formatDuration(row.avgDuration)} per race`;
      if (cheapest && cheapest.name !== row.name && row.avgCost != null) {
        text += `, ${(row.avgCost / cheapest.avgCost).toFixed(1)}x the cost of ${cheapest.name}`;
      }
      line.textContent = `${text}.`;
      box.appendChild(line);
    }
    return box;
  }
}

export default RaceView;
