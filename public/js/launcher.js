/**
 * The launcher: the first screen when nothing is running. It has to beat
 * opening a terminal by hand, so the recent project list is keyboard first:
 * one keystroke filters, Enter starts an agent in that repository, and
 * everything else on the screen hangs off that same list.
 */

import { S2C, KIND } from './protocol.js';

const MAX_VARIANTS = 6;
/** How long to wait for the server's `created` before giving up on the id. */
const CREATE_TIMEOUT_MS = 10000;

function tokenOf(connection) {
  if (connection && typeof connection.token === 'string' && connection.token) return connection.token;
  const boot = typeof window !== 'undefined' ? window.__ORCHESTRA__ : null;
  return boot && typeof boot.token === 'string' ? boot.token : '';
}

function makeLogger(logger) {
  const c = typeof console !== 'undefined' ? console : null;
  const bind = (name) => {
    if (logger && typeof logger[name] === 'function') return logger[name].bind(logger);
    if (c && typeof c[name] === 'function') return c[name].bind(c);
    return () => {};
  };
  return { debug: bind('debug'), info: bind('info'), warn: bind('warn'), error: bind('error') };
}

/** Never assigns to innerHTML: every string here can come from disk or a hook. */
function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined && text !== null) node.textContent = String(text);
  return node;
}

function clear(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
}

function button(className, label, onClick) {
  const b = el('button', className, label);
  b.type = 'button';
  b.addEventListener('click', onClick);
  return b;
}

/**
 * Loose path equality, enough to tell "the server opened what I asked for" from
 * "the server opened something else". Separators and a trailing slash are not a
 * difference, and neither is case on Windows.
 */
function samePath(a, b, isWin) {
  const norm = (p) => {
    let s = String(p || '').replace(/\\/g, '/').replace(/\/+/g, '/');
    if (s.length > 1) s = s.replace(/\/$/, '');
    return isWin ? s.toLowerCase() : s;
  };
  return norm(a) === norm(b);
}

function relativeTime(ts) {
  if (!Number.isFinite(ts) || ts <= 0) return 'never opened';
  const delta = Date.now() - ts;
  if (delta < 0) return 'just now';
  const minutes = Math.floor(delta / 60000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days} d ago`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months} mo ago`;
  return `${Math.floor(months / 12)} y ago`;
}

/**
 * Subsequence match, so "clor" finds "claude-orchestra". Returns a score where
 * lower is better, or -1 when the needle does not fit at all.
 */
function fuzzyScore(haystack, needle) {
  if (!needle) return 0;
  const h = haystack.toLowerCase();
  const n = needle.toLowerCase();
  const direct = h.indexOf(n);
  if (direct >= 0) return direct;
  let score = 0;
  let at = -1;
  for (const ch of n) {
    const next = h.indexOf(ch, at + 1);
    if (next < 0) return -1;
    score += next - at;
    at = next;
  }
  return 1000 + score;
}

export class Launcher {
  /**
   * @param {object} deps.store        the app Store: `setActive`, `emit`, `state.server`
   * @param {object} deps.connection   the Connection: `create(spec)`, `on`, `off`, `token`
   * @param {object} [deps.api]        optional REST client; plain fetch is used without one
   * @param {Function} [deps.onNavigate] called as (view, params) when a launch changes screen
   */
  constructor(root, deps = {}) {
    if (!root) throw new Error('Launcher requires a root element');
    this.root = root;
    this.store = deps.store || null;
    this.connection = deps.connection || null;
    this.api = deps.api || null;
    this.log = makeLogger(deps.logger);
    this.onNavigate = typeof deps.onNavigate === 'function' ? deps.onNavigate : null;

    /** @type {Array<{path:string,name:string,lastUsedAt:number|null,isGit:boolean,branch:string|null,sessionCount:number,exists?:boolean}>} */
    this.projects = [];
    this.filtered = [];
    this.filter = '';
    this.activeIndex = 0;
    this.selectedPath = null;
    /** @type {Map<string, {recipe:object|null, error:string|null, loading:boolean}>} */
    this.recipes = new Map();
    this.loading = false;
    this.loadError = null;
    /** 'idle' | 'recipe' | 'race' */
    this.detailMode = 'idle';
    this.busy = false;
    this.pathMessage = null;
    this.pathMessageKind = 'info';
    this.raceDraft = { prompt: '', variants: [{ name: 'a', args: '' }, { name: 'b', args: '' }] };

    this._nodes = {};
    this._mounted = false;
  }

  mount() {
    if (this._mounted) return this;
    this._mounted = true;
    this._build();
    this.refresh();
    return this;
  }

  destroy() {
    clear(this.root);
    this._nodes = {};
    this._mounted = false;
  }

  /** Called by the shell when the launcher view becomes visible. */
  activate() {
    if (!this._mounted) this.mount();
    else this.refresh();
    this.focus();
  }

  focus() {
    if (this._nodes.filter) this._nodes.filter.focus();
  }

  _build() {
    clear(this.root);
    const wrap = el('div', 'launcher');

    const head = el('header', 'launcher-head');
    head.appendChild(el('h1', 'launcher-title', 'Start an agent'));
    head.appendChild(el(
      'p',
      'launcher-sub',
      'Pick a project and press Enter. Claude Code starts there, already attached.',
    ));
    wrap.appendChild(head);

    const search = el('div', 'launcher-search');
    const filter = el('input', 'launcher-filter');
    filter.type = 'search';
    filter.placeholder = 'Filter projects';
    filter.setAttribute('aria-label', 'Filter projects');
    filter.autocomplete = 'off';
    filter.spellcheck = false;
    filter.addEventListener('input', () => this._onFilterInput(filter.value));
    filter.addEventListener('keydown', (e) => this._onFilterKey(e));
    search.appendChild(filter);
    const count = el('span', 'launcher-count', '');
    search.appendChild(count);
    search.appendChild(button('launcher-refresh', 'Reload', () => this.refresh({ force: true })));
    wrap.appendChild(search);

    const error = el('div', 'launcher-error');
    error.hidden = true;
    error.setAttribute('role', 'alert');
    wrap.appendChild(error);

    const body = el('div', 'launcher-body');
    const list = el('ul', 'launcher-list');
    list.setAttribute('role', 'listbox');
    list.setAttribute('aria-label', 'Recent projects');
    const detail = el('aside', 'launcher-detail');
    body.appendChild(list);
    body.appendChild(detail);
    wrap.appendChild(body);

    const foot = el('form', 'launcher-path');
    foot.addEventListener('submit', (e) => {
      e.preventDefault();
      this._openFreePath();
    });
    const pathLabel = el('label', 'launcher-path-label', 'Or type a folder');
    pathLabel.htmlFor = 'launcher-path-input';
    foot.appendChild(pathLabel);
    const pathInput = el('input', 'launcher-path-input');
    pathInput.id = 'launcher-path-input';
    pathInput.type = 'text';
    pathInput.spellcheck = false;
    pathInput.autocomplete = 'off';
    pathInput.placeholder = this._home() || 'Absolute path to a folder';
    pathInput.addEventListener('input', () => {
      this.pathMessage = null;
      this._renderPathMessage();
    });
    foot.appendChild(pathInput);
    const go = el('button', 'launcher-path-go', 'Open');
    go.type = 'submit';
    foot.appendChild(go);
    const pathMsg = el('span', 'launcher-path-msg');
    foot.appendChild(pathMsg);
    wrap.appendChild(foot);

    this.root.appendChild(wrap);
    this._nodes = { wrap, filter, count, error, list, detail, pathInput, pathMsg };
  }

  async refresh(opts = {}) {
    if (!this._mounted) return;
    if (this.loading && !opts.force) return;
    this.loading = true;
    this.loadError = null;
    this._renderList();
    try {
      const projects = await this._request('GET', '/api/projects');
      this.projects = Array.isArray(projects) ? projects : [];
      if (this.selectedPath && !this.projects.some((p) => p.path === this.selectedPath)) {
        this.selectedPath = null;
      }
    } catch (e) {
      this.loadError = e && e.message ? e.message : String(e);
      this.log.error(`launcher: GET /api/projects failed: ${this.loadError}`);
    } finally {
      this.loading = false;
      this._applyFilter();
      this._renderAll();
    }
  }

  _applyFilter() {
    const needle = this.filter.trim();
    if (!needle) {
      this.filtered = this.projects.slice();
    } else {
      const scored = [];
      for (const p of this.projects) {
        const hits = [fuzzyScore(p.name || '', needle), fuzzyScore(p.path || '', needle)]
          .filter((score) => score >= 0);
        if (hits.length) scored.push({ p, best: Math.min(...hits) });
      }
      scored.sort((a, b) => a.best - b.best);
      this.filtered = scored.map((s) => s.p);
    }
    if (this.activeIndex >= this.filtered.length) this.activeIndex = Math.max(0, this.filtered.length - 1);
    const active = this.filtered[this.activeIndex];
    if (active) this._select(active.path, { silent: true });
  }

  _select(path, opts = {}) {
    if (this.selectedPath === path && !opts.force) {
      if (!opts.silent) this._renderDetail();
      return;
    }
    this.selectedPath = path;
    this.detailMode = 'idle';
    this._loadRecipe(path);
    if (!opts.silent) {
      this._renderList();
      this._renderDetail();
    }
  }

  async _loadRecipe(path) {
    if (!path) return;
    const cached = this.recipes.get(path);
    if (cached && !cached.loading) return;
    this.recipes.set(path, { recipe: null, error: null, loading: true });
    try {
      const res = await this._request('GET', `/api/workspace?cwd=${encodeURIComponent(path)}`);
      this.recipes.set(path, { recipe: res || null, error: null, loading: false });
    } catch (e) {
      const message = e && e.message ? e.message : String(e);
      this.recipes.set(path, { recipe: null, error: message, loading: false });
      this.log.warn(`launcher: GET /api/workspace for ${path} failed: ${message}`);
    }
    if (this.selectedPath === path) this._renderDetail();
  }

  _renderAll() {
    if (!this._mounted) return;
    this._renderError();
    this._renderList();
    this._renderDetail();
    this._renderPathMessage();
  }

  _renderError() {
    const node = this._nodes.error;
    if (!node) return;
    if (!this.loadError) {
      node.hidden = true;
      clear(node);
      return;
    }
    clear(node);
    node.hidden = false;
    node.appendChild(el('strong', null, 'Could not list projects. '));
    node.appendChild(el('span', null, this.loadError));
    node.appendChild(button('launcher-retry', 'Retry', () => this.refresh({ force: true })));
  }

  _renderList() {
    const list = this._nodes.list;
    if (!list) return;
    clear(list);

    if (this._nodes.count) {
      this._nodes.count.textContent = this.loading
        ? 'loading...'
        : `${this.filtered.length} of ${this.projects.length}`;
    }

    if (this.loading && this.projects.length === 0) {
      list.appendChild(el('li', 'launcher-empty', 'Looking for recent projects...'));
      return;
    }

    if (this.projects.length === 0) {
      list.appendChild(this._emptyState());
      return;
    }

    if (this.filtered.length === 0) {
      const li = el('li', 'launcher-empty');
      li.appendChild(el('p', null, `Nothing matches "${this.filter}".`));
      li.appendChild(el('p', 'launcher-empty-hint', 'Clear the filter, or type a folder below.'));
      list.appendChild(li);
      return;
    }

    this.filtered.forEach((project, index) => {
      list.appendChild(this._projectRow(project, index));
    });
  }

  _projectRow(project, index) {
    const li = el('li', 'launcher-item');
    li.setAttribute('role', 'option');
    if (index === this.activeIndex) li.classList.add('is-active');
    if (project.path === this.selectedPath) li.classList.add('is-selected');
    li.setAttribute('aria-selected', project.path === this.selectedPath ? 'true' : 'false');
    if (project.exists === false) li.classList.add('is-missing');

    const main = el('div', 'launcher-item-main');
    main.appendChild(el('span', 'launcher-item-name', project.name || project.path));
    main.appendChild(el('span', 'launcher-item-path', project.path));
    li.appendChild(main);

    const meta = el('div', 'launcher-item-meta');
    if (project.isGit && project.branch) {
      meta.appendChild(el('span', 'launcher-branch', project.branch));
    } else if (project.isGit) {
      meta.appendChild(el('span', 'launcher-branch', 'git'));
    }
    if (project.sessionCount) {
      meta.appendChild(el('span', 'launcher-sessions', `${project.sessionCount} past session${project.sessionCount === 1 ? '' : 's'}`));
    }
    meta.appendChild(el('span', 'launcher-when', relativeTime(project.lastUsedAt)));
    if (project.exists === false) meta.appendChild(el('span', 'launcher-gone', 'folder is gone'));
    const recipe = this.recipes.get(project.path);
    if (recipe && recipe.recipe) {
      meta.appendChild(el('span', 'launcher-recipe-badge', `recipe: ${recipe.recipe.agents.length} agents`));
    }
    li.appendChild(meta);

    li.addEventListener('click', () => {
      this.activeIndex = index;
      this._select(project.path, { force: true });
    });
    li.addEventListener('dblclick', () => this._launchAgent(project.path));
    return li;
  }

  _emptyState() {
    const li = el('li', 'launcher-empty');
    li.appendChild(el('h2', 'launcher-empty-title', 'No recent projects yet'));
    li.appendChild(el(
      'p',
      null,
      'This list is built from the projects Claude Code already knows about, under ~/.claude/projects'
      + ' and the prompt history. Run Claude Code once in a repository and it shows up here.',
    ));
    li.appendChild(el(
      'p',
      'launcher-empty-hint',
      'In the meantime, type a folder in the field below and open it directly.',
    ));
    const actions = el('div', 'launcher-empty-actions');
    const home = this._home();
    if (home) {
      actions.appendChild(button('launcher-btn', `Open ${home}`, () => this._launchAgent(home)));
    }
    actions.appendChild(button('launcher-btn launcher-btn-ghost', 'Type a folder', () => {
      if (this._nodes.pathInput) this._nodes.pathInput.focus();
    }));
    li.appendChild(actions);
    return li;
  }

  _renderDetail() {
    const detail = this._nodes.detail;
    if (!detail) return;
    clear(detail);

    const project = this.projects.find((p) => p.path === this.selectedPath) || null;
    const path = project ? project.path : this.selectedPath;

    if (!path) {
      detail.appendChild(el('p', 'launcher-detail-empty', 'Select a project to see what you can start in it.'));
      return;
    }

    const head = el('div', 'launcher-detail-head');
    head.appendChild(el('h2', 'launcher-detail-name', project ? (project.name || path) : path));
    head.appendChild(el('code', 'launcher-detail-path', path));
    if (project) {
      const facts = el('div', 'launcher-detail-facts');
      if (project.isGit) facts.appendChild(el('span', 'launcher-branch', project.branch || 'git'));
      facts.appendChild(el('span', 'launcher-when', relativeTime(project.lastUsedAt)));
      if (project.exists === false) facts.appendChild(el('span', 'launcher-gone', 'folder is gone'));
      head.appendChild(facts);
    }
    detail.appendChild(head);

    const actions = el('div', 'launcher-actions');
    actions.appendChild(button('launcher-btn launcher-btn-primary', 'New agent here', () => this._launchAgent(path)));
    actions.appendChild(button('launcher-btn', 'New shell here', () => this._launchShell(path)));
    actions.appendChild(button('launcher-btn', 'Start a race here', () => {
      this.detailMode = this.detailMode === 'race' ? 'idle' : 'race';
      this._renderDetail();
    }));
    detail.appendChild(actions);

    detail.appendChild(this._recipeBlock(path));

    if (this.detailMode === 'race') detail.appendChild(this._raceForm(path));
  }

  _recipeBlock(path) {
    const box = el('section', 'launcher-recipe');
    const state = this.recipes.get(path);

    if (!state || state.loading) {
      box.appendChild(el('p', 'launcher-recipe-loading', 'Looking for .orchestra.json...'));
      return box;
    }
    if (state.error) {
      box.appendChild(el('p', 'launcher-recipe-error', `Could not read .orchestra.json: ${state.error}`));
      return box;
    }
    if (!state.recipe) {
      box.appendChild(el(
        'p',
        'launcher-recipe-none',
        'No .orchestra.json here. Commit one to describe the agents this repository usually needs.',
      ));
      return box;
    }

    const recipe = state.recipe;
    const agents = Array.isArray(recipe.agents) ? recipe.agents : [];
    box.appendChild(el('h3', 'launcher-recipe-title', recipe.name ? `Recipe: ${recipe.name}` : 'Recipe'));
    box.appendChild(el('p', 'launcher-recipe-sub', `${agents.length} agent${agents.length === 1 ? '' : 's'} described in .orchestra.json`));

    const ul = el('ul', 'launcher-recipe-list');
    for (const agent of agents) {
      const li = el('li', 'launcher-recipe-item');
      li.appendChild(el('span', 'launcher-recipe-kind', agent.kind || KIND.CLAUDE));
      li.appendChild(el('span', 'launcher-recipe-name', agent.name || '(unnamed)'));
      if (agent.cwd && agent.cwd !== '.') li.appendChild(el('code', 'launcher-recipe-cwd', agent.cwd));
      if (agent.args) li.appendChild(el('code', 'launcher-recipe-args', agent.args));
      if (agent.prompt) li.appendChild(el('span', 'launcher-recipe-prompt', agent.prompt));
      ul.appendChild(li);
    }
    box.appendChild(ul);

    if (this.detailMode === 'recipe') {
      const confirm = el('div', 'launcher-confirm');
      confirm.appendChild(el(
        'p',
        'launcher-confirm-text',
        `About to start ${agents.length} session${agents.length === 1 ? '' : 's'} in ${path}. Nothing else is touched.`,
      ));
      const row = el('div', 'launcher-confirm-actions');
      const go = button('launcher-btn launcher-btn-primary', `Start ${agents.length}`, () => this._applyRecipe(path));
      go.disabled = this.busy;
      row.appendChild(go);
      row.appendChild(button('launcher-btn launcher-btn-ghost', 'Cancel', () => {
        this.detailMode = 'idle';
        this._renderDetail();
      }));
      confirm.appendChild(row);
      box.appendChild(confirm);
    } else {
      box.appendChild(button('launcher-btn launcher-btn-primary', 'Run this recipe', () => {
        this.detailMode = 'recipe';
        this._renderDetail();
      }));
    }
    return box;
  }

  _raceForm(path) {
    const form = el('form', 'launcher-race');
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      this._startRace(path);
    });

    form.appendChild(el('h3', 'launcher-race-title', 'Race variants against each other'));
    form.appendChild(el(
      'p',
      'launcher-race-sub',
      'Each variant gets its own git worktree and the same prompt. Adopt the one you like afterwards.',
    ));

    const promptLabel = el('label', 'launcher-race-label', 'Prompt');
    const prompt = el('textarea', 'launcher-race-prompt');
    prompt.rows = 3;
    prompt.placeholder = 'What should every variant try to do?';
    prompt.value = this.raceDraft.prompt;
    prompt.addEventListener('input', () => { this.raceDraft.prompt = prompt.value; });
    promptLabel.appendChild(prompt);
    form.appendChild(promptLabel);

    const variants = el('div', 'launcher-race-variants');
    this.raceDraft.variants.forEach((variant, i) => {
      const row = el('div', 'launcher-race-variant');
      const name = el('input', 'launcher-race-variant-name');
      name.type = 'text';
      name.value = variant.name;
      name.placeholder = 'name';
      name.setAttribute('aria-label', `Variant ${i + 1} name`);
      name.addEventListener('input', () => { variant.name = name.value; });
      row.appendChild(name);

      const args = el('input', 'launcher-race-variant-args');
      args.type = 'text';
      args.value = variant.args;
      args.placeholder = 'extra claude arguments (optional)';
      args.setAttribute('aria-label', `Variant ${i + 1} arguments`);
      args.addEventListener('input', () => { variant.args = args.value; });
      row.appendChild(args);

      const remove = button('launcher-race-variant-remove', 'Remove', () => {
        this.raceDraft.variants.splice(i, 1);
        this._renderDetail();
      });
      remove.disabled = this.raceDraft.variants.length <= 2;
      row.appendChild(remove);
      variants.appendChild(row);
    });
    form.appendChild(variants);

    const actions = el('div', 'launcher-race-actions');
    const add = button('launcher-btn launcher-btn-ghost', 'Add a variant', () => {
      if (this.raceDraft.variants.length >= MAX_VARIANTS) return;
      const letter = String.fromCharCode(97 + this.raceDraft.variants.length);
      this.raceDraft.variants.push({ name: letter, args: '' });
      this._renderDetail();
    });
    add.disabled = this.raceDraft.variants.length >= MAX_VARIANTS;
    actions.appendChild(add);
    const start = el('button', 'launcher-btn launcher-btn-primary', 'Start the race');
    start.type = 'submit';
    start.disabled = this.busy;
    actions.appendChild(start);
    actions.appendChild(button('launcher-btn launcher-btn-ghost', 'Cancel', () => {
      this.detailMode = 'idle';
      this._renderDetail();
    }));
    form.appendChild(actions);
    return form;
  }

  _renderPathMessage() {
    const node = this._nodes.pathMsg;
    if (!node) return;
    node.textContent = this.pathMessage || '';
    node.className = `launcher-path-msg${this.pathMessage ? ` is-${this.pathMessageKind}` : ''}`;
  }

  _onFilterInput(value) {
    this.filter = value;
    this.activeIndex = 0;
    this._applyFilter();
    this._renderList();
    this._renderDetail();
  }

  _onFilterKey(e) {
    if (e.key === 'ArrowDown' || (e.key === 'Tab' && !e.shiftKey && this.filtered.length > 1)) {
      e.preventDefault();
      this._move(1);
      return;
    }
    if (e.key === 'ArrowUp' || (e.key === 'Tab' && e.shiftKey && this.filtered.length > 1)) {
      e.preventDefault();
      this._move(-1);
      return;
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      const project = this.filtered[this.activeIndex];
      if (!project) return;
      if (e.shiftKey) this._launchShell(project.path);
      else this._launchAgent(project.path);
      return;
    }
    if (e.key === 'Escape') {
      // The shell ignores every shortcut while a text field has the focus, so
      // this field is the only way out: Escape clears the filter, and on an
      // empty filter it hands the keyboard back rather than trapping the user.
      e.preventDefault();
      e.stopPropagation();
      if (this.filter) {
        this._nodes.filter.value = '';
        this._onFilterInput('');
        return;
      }
      this._nodes.filter.blur();
    }
  }

  _move(delta) {
    if (this.filtered.length === 0) return;
    const next = (this.activeIndex + delta + this.filtered.length) % this.filtered.length;
    this.activeIndex = next;
    const project = this.filtered[next];
    this._select(project.path, { force: true });
    const list = this._nodes.list;
    const row = list ? list.children[next] : null;
    if (row && typeof row.scrollIntoView === 'function') {
      row.scrollIntoView({ block: 'nearest' });
    }
  }

  async _launchAgent(cwd) {
    await this._launch({ kind: KIND.CLAUDE, cwd, name: this._nameFor(cwd) });
  }

  async _launchShell(cwd) {
    await this._launch({ kind: KIND.SHELL, cwd, name: `${this._nameFor(cwd)} shell` });
  }

  _nameFor(cwd) {
    const parts = String(cwd || '').split(/[\\/]/).filter(Boolean);
    return parts.length ? parts[parts.length - 1] : 'agent';
  }

  async _launch(spec) {
    if (this.busy) return;
    this.busy = true;
    this._renderDetail();
    try {
      const created = await this._create(spec);
      const id = created && created.id ? created.id : null;
      if (id && this.store && typeof this.store.setActive === 'function') {
        this.store.setActive(id);
      }
      // The server falls back to the home directory when it cannot use the
      // folder we asked for. Nothing here can see the filesystem, so this
      // comparison is the only place that substitution can be caught, and it
      // must not be swallowed: an agent in the home directory has all of it
      // in reach.
      const elsewhere = created && created.cwd && spec.cwd
        && !samePath(created.cwd, this._expandHome(spec.cwd), this._isWindows());
      if (elsewhere) {
        this._setPathMessage(
          `The server could not open "${spec.cwd}", so this agent started in "${created.cwd}" instead.`
          + ' Check the path, then close that session if it is not where you meant to work.',
          'error',
        );
        return;
      }
      this._navigate('terminals', { sessionId: id });
      this._setPathMessage(null);
    } catch (e) {
      const message = e && e.message ? e.message : String(e);
      this.log.error(`launcher: could not create a session in ${spec.cwd}: ${message}`);
      this._setPathMessage(message, 'error');
    } finally {
      this.busy = false;
      this._renderDetail();
    }
  }

  async _applyRecipe(cwd) {
    if (this.busy) return;
    this.busy = true;
    this._renderDetail();
    try {
      const res = await this._request('POST', '/api/workspace/apply', { cwd });
      // The route answers {created: [...]}, never {sessions: [...]}.
      const started = res && Array.isArray(res.created) ? res.created.length : null;
      this.detailMode = 'idle';
      this._navigate('terminals', {});
      this._setPathMessage(
        started === null ? 'Recipe applied.' : `Started ${started} session${started === 1 ? '' : 's'}.`,
        'info',
      );
    } catch (e) {
      const message = e && e.message ? e.message : String(e);
      this.log.error(`launcher: POST /api/workspace/apply for ${cwd} failed: ${message}`);
      this._setPathMessage(message, 'error');
    } finally {
      this.busy = false;
      this._renderDetail();
    }
  }

  async _startRace(repo) {
    if (this.busy) return;
    const prompt = this.raceDraft.prompt.trim();
    if (!prompt) {
      this._setPathMessage('A race needs a prompt.', 'error');
      return;
    }
    const variants = this.raceDraft.variants
      .map((v, i) => ({ name: (v.name || '').trim() || String.fromCharCode(97 + i), args: (v.args || '').trim() }));
    const names = new Set();
    for (const v of variants) {
      if (names.has(v.name)) {
        this._setPathMessage(`Two variants are both called "${v.name}".`, 'error');
        return;
      }
      names.add(v.name);
    }

    this.busy = true;
    this._renderDetail();
    try {
      const race = await this._request('POST', '/api/race', { prompt, repo, variants });
      this.detailMode = 'idle';
      this._navigate('race', { raceId: race && race.id ? race.id : null });
      this._setPathMessage(null);
    } catch (e) {
      const message = e && e.message ? e.message : String(e);
      this.log.error(`launcher: POST /api/race in ${repo} failed: ${message}`);
      this._setPathMessage(message, 'error');
    } finally {
      this.busy = false;
      this._renderDetail();
    }
  }

  /**
   * The free path field. /api/workspace reports whether a `.orchestra.json`
   * could be read there, never whether the folder exists, so this cannot
   * pre-validate the path. The real check happens once the session comes back,
   * in _launch, where the folder the server actually used is known.
   */
  async _openFreePath() {
    const input = this._nodes.pathInput;
    if (!input) return;
    const value = input.value.trim();
    if (!value) {
      this._setPathMessage('Type a folder first.', 'error');
      return;
    }
    this._setPathMessage('Starting...', 'info');
    let probe;
    try {
      probe = await this._request('GET', `/api/workspace?cwd=${encodeURIComponent(value)}`);
    } catch (e) {
      const message = e && e.message ? e.message : String(e);
      this.log.warn(`launcher: server rejected the path ${value}: ${message}`);
      this._setPathMessage(message, 'error');
      return;
    }
    const resolved = probe && typeof probe.baseDir === 'string' ? probe.baseDir : value;
    if (probe) this.recipes.set(resolved, { recipe: probe, error: null, loading: false });
    this.selectedPath = resolved;
    this.detailMode = 'idle';
    this._renderDetail();
    await this._launchAgent(resolved);
  }

  _setPathMessage(text, kind) {
    this.pathMessage = text || null;
    this.pathMessageKind = kind || 'info';
    this._renderPathMessage();
  }

  /**
   * The app shell owns the view tabs, so navigation is a request, not a call
   * into another module. `onNavigate` is the wired path; the store event is the
   * fallback for a shell that prefers to listen.
   */
  _navigate(view, params) {
    if (this.onNavigate) {
      this.onNavigate(view, params || {});
      return;
    }
    if (this.store && typeof this.store.setView === 'function') {
      this.store.setView(view, params || {});
      return;
    }
    if (this.store && typeof this.store.emit === 'function') {
      this.store.emit('navigate', { view, ...(params || {}) });
      return;
    }
    this.log.warn(`launcher: nothing can switch to the "${view}" view, wire onNavigate`);
  }

  /**
   * Session creation goes over the WebSocket, not REST, because the server
   * answers with the session and then streams its output on the same socket.
   * `connection.create` only reports that the frame left, so the new id is
   * picked up from the matching `created` message.
   */
  async _create(spec) {
    const c = this.connection;
    if (!c) throw new Error('The launcher has no connection to the server.');
    if (typeof c.create !== 'function') {
      throw new Error('The connection exposes no create().');
    }

    const waiter = this._awaitCreated(spec);
    const queued = c.create(spec);
    if (queued === false) {
      waiter.cancel();
      throw new Error('The connection is down, the request was not sent.');
    }
    return waiter.promise;
  }

  /**
   * Resolves with the session the server just created, or with null when the
   * connection cannot report it back. Never rejects on a timeout: the session
   * may well exist, we simply cannot name it.
   */
  _awaitCreated(spec) {
    const c = this.connection;
    if (typeof c.on !== 'function' || typeof c.off !== 'function') {
      return { promise: Promise.resolve(null), cancel: () => {} };
    }
    let settle = null;
    let timer = null;
    const onCreated = (msg) => {
      const session = msg && msg.session;
      if (!session || !session.id) return;
      // The cwd is deliberately not part of the match: the server may have
      // replaced it, and requiring equality would drop exactly the answer that
      // carries that bad news. `created` reaches only the socket that asked and
      // a launch is serialised by this.busy, so the kind is enough.
      if (spec && spec.kind && session.kind && session.kind !== spec.kind) return;
      finish(session);
    };
    const onError = (err) => {
      finish(null, new Error((err && err.message) || 'The server refused to create the session.'));
    };
    function cleanup() {
      if (timer !== null) clearTimeout(timer);
      timer = null;
      c.off(S2C.CREATED, onCreated);
      c.off(S2C.ERROR, onError);
    }
    function finish(value, error) {
      if (!settle) return;
      const done = settle;
      settle = null;
      cleanup();
      done(value, error);
    }
    const promise = new Promise((resolve, reject) => {
      settle = (value, error) => (error ? reject(error) : resolve(value));
      c.on(S2C.CREATED, onCreated);
      c.on(S2C.ERROR, onError);
      timer = setTimeout(() => finish(null), CREATE_TIMEOUT_MS);
    });
    return { promise, cancel: () => finish(null) };
  }

  async _request(method, path, body) {
    const api = this.api;
    const verb = method.toUpperCase();
    if (api) {
      if (verb === 'GET' && typeof api.get === 'function') return api.get(path);
      if (verb === 'POST' && typeof api.post === 'function') return api.post(path, body);
      if (typeof api.request === 'function') return api.request(verb, path, body);
    }
    const headers = { Accept: 'application/json' };
    const token = tokenOf(this.connection);
    if (token) headers.Authorization = `Bearer ${token}`;
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const res = await fetch(path, {
      method: verb,
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

  _isWindows() {
    const store = this.store;
    const server = store && store.state ? store.state.server : null;
    if (server && typeof server.platform === 'string') return server.platform === 'win32';
    const boot = typeof window !== 'undefined' ? window.__ORCHESTRA__ : null;
    return !!(boot && boot.platform === 'win32');
  }

  /** The server expands a leading ~ before resolving, so we compare like for like. */
  _expandHome(p) {
    const value = String(p || '');
    if (!value.startsWith('~')) return value;
    const home = this._home();
    if (!home) return value;
    return home.replace(/[\\/]$/, '') + '/' + value.slice(1).replace(/^[\\/]/, '');
  }

  _home() {
    const store = this.store;
    const server = store && store.state ? store.state.server : null;
    if (server && typeof server.home === 'string' && server.home) return server.home;
    const boot = typeof window !== 'undefined' ? window.__ORCHESTRA__ : null;
    return boot && typeof boot.home === 'string' ? boot.home : '';
  }
}

export default Launcher;
