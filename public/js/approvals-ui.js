import { el, clear } from './dom.js';
import { C2S, S2C, APPROVAL, APPROVAL_SCOPE } from './protocol.js';

/** Below this much time left the countdown turns hostile. */
const URGENT_MS = 60 * 1000;
/** How long a sent decision may stay unanswered before we say so. */
const DECISION_WATCHDOG_MS = 15000;
/** Phone layout: one request fills the screen, the rest go behind a pager. */
const NARROW_QUERY = '(max-width: 900px)';
const MAX_DIFF_LINES = 400;

const EDIT_TOOLS = new Set(['Edit', 'MultiEdit', 'NotebookEdit']);
const COMMAND_TOOLS = new Set(['Bash', 'BashOutput', 'KillShell']);

function stateOf(store) {
  return store && store.state && typeof store.state === 'object' ? store.state : {};
}

function pendingList(store) {
  const list = stateOf(store).approvals;
  return Array.isArray(list) ? list : [];
}

function ruleList(store) {
  const list = stateOf(store).approvalRules;
  return Array.isArray(list) ? list : [];
}

function tokenOf(connection) {
  if (connection && typeof connection.token === 'string' && connection.token) return connection.token;
  const boot = typeof window !== 'undefined' ? window.__ORCHESTRA__ : null;
  return boot && typeof boot.token === 'string' ? boot.token : '';
}

function basename(p) {
  const s = String(p == null ? '' : p);
  const parts = s.split(/[\\/]+/).filter(Boolean);
  return parts.length ? parts[parts.length - 1] : s;
}

function pad2(n) {
  return n < 10 ? `0${n}` : String(n);
}

function formatCountdown(ms) {
  if (!Number.isFinite(ms)) return '--:--';
  if (ms <= 0) return 'expired';
  const seconds = Math.round(ms / 1000);
  return `${Math.floor(seconds / 60)}:${pad2(seconds % 60)}`;
}

function domainOf(url) {
  const raw = String(url == null ? '' : url).trim();
  try {
    return new URL(raw).host;
  } catch (e) {
    // Not a parseable URL (a template, a relative path). Fall back to a
    // textual host guess rather than showing nothing at all.
    const m = raw.match(/^[a-z][a-z0-9+.-]*:\/\/([^/?#\s]+)/i);
    return m ? m[1] : raw.split(/[/?#\s]/)[0];
  }
}

/**
 * `detail` for path-shaped tools is `path\n\n<body>`. Command details are
 * never split: a shell command legitimately contains blank lines, and cutting
 * one in half would show the operator something other than what runs.
 */
function splitDetail(detail) {
  const text = String(detail == null ? '' : detail);
  const idx = text.indexOf('\n\n');
  if (idx === -1) return { head: text, body: '' };
  return { head: text.slice(0, idx), body: text.slice(idx + 2) };
}

function diffBlock(text, forceAdd) {
  const wrap = el('div', { class: 'approval-diff' });
  const lines = String(text == null ? '' : text).split('\n');
  const shown = lines.slice(0, MAX_DIFF_LINES);
  for (const line of shown) {
    let cls = 'diff-line diff-ctx';
    if (forceAdd) cls = 'diff-line diff-add';
    else if (line.startsWith('+')) cls = 'diff-line diff-add';
    else if (line.startsWith('-')) cls = 'diff-line diff-del';
    const row = el('div', { class: cls });
    row.textContent = line === '' ? ' ' : line;
    wrap.appendChild(row);
  }
  if (lines.length > shown.length) {
    wrap.appendChild(el('div', {
      class: 'diff-line diff-meta',
      text: `... ${lines.length - shown.length} more lines`,
    }));
  }
  return wrap;
}

function button(cls, label) {
  const node = el('button', { class: cls, text: label });
  node.type = 'button';
  return node;
}

/** Verbatim text, set through textContent so a payload cannot become markup. */
function commandBlock(text) {
  const pre = el('pre', { class: 'approval-command' });
  pre.textContent = text;
  return pre;
}

function field(labelText, value, hintText) {
  const wrap = el('div', { class: 'approval-rule-field' });
  const label = el('label', { class: 'approval-rule-label', text: labelText });
  const input = el('input', { class: 'approval-rule-input' });
  input.type = 'text';
  input.value = value == null ? '' : String(value);
  input.spellcheck = false;
  input.autocapitalize = 'off';
  input.autocomplete = 'off';
  label.appendChild(input);
  wrap.appendChild(label);
  if (hintText) wrap.appendChild(el('div', { class: 'approval-rule-hint', text: hintText }));
  return { wrap, input };
}

/**
 * The permission queue, built for a phone held in one hand.
 *
 * Every card carries the exact text of what is about to run, because the
 * operator answering from a bus stop cannot open the terminal to check. The
 * "always allow" path never writes a rule without first spelling out what that
 * rule will authorise, and where.
 */
export class ApprovalsView {
  /**
   * @param {{store: Object, connection: Object, api?: Object}} deps  `api` is an
   *   optional REST helper for rule revocation; without it `fetch` is used
   */
  constructor(root, { store, connection, api = null } = {}) {
    if (!root) throw new Error('ApprovalsView needs a root element');
    this.root = root;
    this.store = store;
    this.connection = connection;
    this.api = api;

    this.index = 0;
    this.rulesOpen = false;
    this.error = '';
    /** id -> {pattern, cwd} while the "always allow" form is open. */
    this.ruleDraft = new Map();
    /** ids whose decision has been sent and not yet confirmed. */
    this.submitting = new Map();
    /** Rules revoked here, hidden until the store catches up with the server. */
    this.revoked = new Set();
    /**
     * Requests the server called resolved. The card goes on that word alone, so
     * a store that has not pruned its list yet cannot leave a dead request on
     * screen with live looking buttons.
     */
    this.resolved = new Set();

    this._off = [];
    this._tickTimer = null;
    this._countdowns = [];
    this._narrow = false;
    this._media = null;
    this._onMedia = null;
    this._mounted = false;
  }

  mount() {
    if (this._mounted) return this;
    this._mounted = true;
    this.root.classList.add('approvals-view');

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

    this._subscribeStore('approvals');
    this._subscribeStore('sessions');
    this._listen(S2C.APPROVAL_REQUEST, () => {
      this.error = '';
      this.render();
      this.alert();
    });
    this._listen(S2C.APPROVAL_RESOLVED, message => {
      const id = message && (message.id || message.requestId);
      if (id) this.settle(id);
      this.render();
    });
    this._listen(S2C.ERROR, message => {
      if (!message) return;
      this.error = String(message.message || message.error || 'The server rejected the decision.');
      this.submitting.clear();
      this.render();
    });

    this._tickTimer = window.setInterval(() => this.tick(), 1000);
    this.render();
    return this;
  }

  destroy() {
    this._mounted = false;
    if (this._tickTimer) {
      window.clearInterval(this._tickTimer);
      this._tickTimer = null;
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
    this._countdowns = [];
    clear(this.root);
    this.root.classList.remove('approvals-view');
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

  /** Requests still waiting for a human, oldest first. */
  pending() {
    const raw = pendingList(this.store).filter(Boolean);
    const known = new Set(raw.map(p => p.id));
    for (const id of this.resolved) {
      if (!known.has(id)) this.resolved.delete(id);
    }
    return raw.filter(p => !this.resolved.has(p.id));
  }

  alert() {
    if (typeof navigator.vibrate === 'function') navigator.vibrate(40);
  }

  send(id, decision, scope, extra) {
    const conn = this.connection;
    if (!conn || typeof conn.send !== 'function') {
      this.error = 'Not connected to Orchestra, so the decision was not sent.';
      this.render();
      return;
    }
    this.error = '';
    this.submitting.set(id, Date.now());
    const sent = conn.send({
      t: C2S.APPROVAL_DECISION,
      requestId: id,
      decision,
      scope,
      ...(extra || {}),
    });
    if (sent === false) {
      // The socket is down and the message went to the offline queue. Say so:
      // the agent on the other end is blocked until this actually lands.
      this.error = 'Offline. The decision is queued and will be sent when the connection returns.';
    }
    this.render();
  }

  settle(id) {
    this.submitting.delete(id);
    this.ruleDraft.delete(id);
    this.resolved.add(id);
  }

  allowOnce(entry) {
    this.send(entry.id, APPROVAL.ALLOW, APPROVAL_SCOPE.ONCE);
  }

  deny(entry) {
    this.send(entry.id, APPROVAL.DENY, APPROVAL_SCOPE.ONCE);
  }

  allowSession(entry) {
    this.send(entry.id, APPROVAL.ALLOW, APPROVAL_SCOPE.SESSION);
  }

  openRuleForm(entry) {
    this.ruleDraft.set(entry.id, {
      pattern: entry.patternSuggestion == null ? '' : String(entry.patternSuggestion),
      cwd: entry.cwd == null ? '' : String(entry.cwd),
    });
    this.render();
  }

  closeRuleForm(entry) {
    this.ruleDraft.delete(entry.id);
    this.render();
  }

  saveRule(entry) {
    const draft = this.ruleDraft.get(entry.id);
    if (!draft) return;
    this.send(entry.id, APPROVAL.ALLOW, APPROVAL_SCOPE.ALWAYS, {
      tool: entry.tool,
      pattern: draft.pattern,
      cwd: draft.cwd,
    });
  }

  async revokeRule(rule) {
    const path = `/api/approvals/rules/${encodeURIComponent(rule.id)}`;
    try {
      await this.request('DELETE', path);
      this.revoked.add(rule.id);
      this.error = '';
    } catch (e) {
      this.error = `Could not revoke the rule: ${e.message}`;
    }
    this.render();
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
        // A non-JSON body is still worth reporting verbatim.
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

  tick() {
    const now = Date.now();
    for (const entry of this._countdowns) {
      const left = entry.expiresAt - now;
      entry.node.textContent = formatCountdown(left);
      entry.node.classList.toggle('is-urgent', left > 0 && left <= URGENT_MS);
      entry.node.classList.toggle('is-expired', left <= 0);
      if (entry.card) entry.card.classList.toggle('is-urgent', left > 0 && left <= URGENT_MS);
    }
    let stale = false;
    for (const [id, sentAt] of this.submitting) {
      if (now - sentAt > DECISION_WATCHDOG_MS) {
        this.submitting.delete(id);
        stale = true;
      }
    }
    if (stale) {
      this.error = 'The server did not confirm the last decision. Try again.';
      this.render();
    }
  }

  render() {
    if (!this._mounted) return;
    const pending = this.pending();
    const rules = ruleList(this.store);

    if (this.index >= pending.length) this.index = Math.max(0, pending.length - 1);
    this._countdowns = [];

    clear(this.root);
    this.root.classList.toggle('is-narrow', this._narrow);

    this.root.appendChild(this.renderHeader(pending));
    if (this.error) {
      const box = el('div', { class: 'approval-error', text: this.error });
      const dismiss = button('approval-error-dismiss', 'Dismiss');
      dismiss.addEventListener('click', () => {
        this.error = '';
        this.render();
      });
      box.appendChild(dismiss);
      this.root.appendChild(box);
    }

    if (pending.length === 0) {
      this.root.appendChild(el('div', {
        class: 'approvals-empty',
        text: 'No agent is waiting for permission.',
      }));
    } else {
      const list = el('div', { class: 'approvals-list' });
      const visible = this._narrow ? [pending[this.index]] : pending;
      for (const entry of visible) {
        if (entry) list.appendChild(this.renderCard(entry));
      }
      this.root.appendChild(list);
      if (this._narrow && pending.length > 1) {
        this.root.appendChild(this.renderPager(pending));
      }
    }

    this.root.appendChild(this.renderRules(rules));
  }

  renderHeader(pending) {
    const head = el('div', { class: 'approvals-header' });
    head.appendChild(el('h2', { class: 'approvals-title', text: 'Permissions' }));
    const count = pending.length === 1 ? '1 request waiting' : `${pending.length} requests waiting`;
    head.appendChild(el('span', { class: 'approvals-count', text: count }));
    return head;
  }

  renderPager(pending) {
    const pager = el('div', { class: 'approvals-pager' });
    const prev = button('approvals-pager-btn', 'Previous');
    prev.disabled = this.index <= 0;
    prev.addEventListener('click', () => {
      this.index = Math.max(0, this.index - 1);
      this.render();
    });
    const next = button('approvals-pager-btn', 'Next');
    next.disabled = this.index >= pending.length - 1;
    next.addEventListener('click', () => {
      this.index = Math.min(pending.length - 1, this.index + 1);
      this.render();
    });
    pager.appendChild(prev);
    pager.appendChild(el('span', {
      class: 'approvals-pager-label',
      text: `${this.index + 1} of ${pending.length}`,
    }));
    pager.appendChild(next);
    return pager;
  }

  renderCard(entry) {
    const session = this.store && typeof this.store.getSession === 'function' && entry.sessionId
      ? this.store.getSession(entry.sessionId)
      : null;
    const card = el('article', { class: 'approval-card' });
    card.dataset.approvalId = entry.id;

    const head = el('div', { class: 'approval-card-head' });
    const who = el('div', { class: 'approval-who' });
    const agentName = entry.sessionName || (session && session.name) || 'Unknown agent';
    who.appendChild(el('span', { class: 'approval-agent', text: agentName }));
    const cwd = entry.cwd || (session && session.cwd) || '';
    const project = el('span', { class: 'approval-project', text: basename(cwd) || 'no project' });
    if (cwd) project.title = cwd;
    who.appendChild(project);
    head.appendChild(who);

    const tool = el('span', { class: 'approval-tool-badge', text: entry.tool || 'tool' });
    head.appendChild(tool);

    const left = Number(entry.expiresAt) - Date.now();
    const countdown = el('span', { class: 'approval-countdown', text: formatCountdown(left) });
    countdown.title = 'Auto denied when this reaches zero';
    if (left > 0 && left <= URGENT_MS) {
      countdown.classList.add('is-urgent');
      card.classList.add('is-urgent');
    }
    if (left <= 0) countdown.classList.add('is-expired');
    head.appendChild(countdown);
    this._countdowns.push({ node: countdown, card, expiresAt: Number(entry.expiresAt) });

    card.appendChild(head);
    card.appendChild(el('p', { class: 'approval-summary', text: entry.summary || '' }));
    card.appendChild(this.renderPayload(entry));

    if (this.ruleDraft.has(entry.id)) {
      card.appendChild(this.renderRuleForm(entry));
    } else {
      card.appendChild(this.renderActions(entry));
    }
    return card;
  }

  /** The literal thing about to happen, shaped by tool family. */
  renderPayload(entry) {
    const body = el('div', { class: 'approval-body' });
    const tool = String(entry.tool || '');
    const detail = String(entry.detail == null ? '' : entry.detail);

    if (COMMAND_TOOLS.has(tool)) {
      body.appendChild(commandBlock(detail));
      return body;
    }

    if (EDIT_TOOLS.has(tool) || tool === 'Write') {
      const parts = splitDetail(detail);
      const path = el('div', { class: 'approval-path' });
      path.textContent = parts.head;
      body.appendChild(path);
      body.appendChild(diffBlock(parts.body, tool === 'Write'));
      if (tool === 'Write') {
        body.appendChild(el('div', {
          class: 'approval-note',
          text: 'The whole file is replaced with this content.',
        }));
      }
      return body;
    }

    if (tool === 'WebFetch') {
      const parts = splitDetail(detail);
      const url = parts.head || detail;
      body.appendChild(el('div', { class: 'approval-domain', text: domainOf(url) || 'unknown host' }));
      const full = el('div', { class: 'approval-url' });
      full.textContent = url;
      body.appendChild(full);
      if (parts.body) body.appendChild(commandBlock(parts.body));
      return body;
    }

    body.appendChild(commandBlock(detail));
    return body;
  }

  renderActions(entry) {
    const busy = this.submitting.has(entry.id);
    const actions = el('div', { class: 'approval-actions' });

    const allow = button('approval-btn approval-btn-allow', busy ? 'Sending...' : 'Allow once');
    allow.disabled = busy;
    allow.addEventListener('click', () => this.allowOnce(entry));

    const deny = button('approval-btn approval-btn-deny', 'Deny');
    deny.disabled = busy;
    deny.addEventListener('click', () => this.deny(entry));

    const session = button('approval-btn approval-btn-session', 'Allow for this session');
    session.disabled = busy;
    session.addEventListener('click', () => this.allowSession(entry));

    const rule = button('approval-btn approval-btn-rule', 'Always allow this pattern here');
    rule.disabled = busy;
    rule.addEventListener('click', () => this.openRuleForm(entry));

    actions.appendChild(allow);
    actions.appendChild(deny);
    actions.appendChild(session);
    actions.appendChild(rule);
    return actions;
  }

  /**
   * A permanent rule is never written from a single tap. The form shows the
   * pattern, the folder, and a sentence describing exactly what the rule will
   * let through before anything is stored.
   */
  renderRuleForm(entry) {
    const draft = this.ruleDraft.get(entry.id);
    const form = el('div', { class: 'approval-rule-form' });
    form.appendChild(el('div', {
      class: 'approval-rule-title',
      text: `Remember a rule for ${entry.tool}`,
    }));

    const patternField = field('Pattern to remember', draft.pattern, 'Use * to match any text.');
    const cwdField = field('Folder it applies to', draft.cwd, 'Includes every folder inside it. Leave empty to apply everywhere.');
    form.appendChild(patternField.wrap);
    form.appendChild(cwdField.wrap);

    const preview = el('div', { class: 'approval-rule-preview' });
    const warning = el('div', { class: 'approval-rule-warning' });
    warning.hidden = true;
    form.appendChild(preview);
    form.appendChild(warning);

    const update = () => {
      draft.pattern = patternField.input.value;
      draft.cwd = cwdField.input.value;
      const where = draft.cwd ? draft.cwd : 'any folder';
      preview.textContent = draft.pattern
        ? `Every ${entry.tool} call in ${where} matching "${draft.pattern}" will be allowed without asking.`
        : `Every ${entry.tool} call in ${where} will be allowed without asking.`;
      const messages = [];
      if (!draft.pattern) {
        messages.push('An empty pattern allows every call of this tool there.');
      } else if (draft.pattern.includes('*')) {
        messages.push('This pattern contains *, so it matches more than the text above.');
      }
      if (!draft.cwd) messages.push('With no folder, the rule applies to every project on this machine.');
      warning.textContent = messages.join(' ');
      warning.hidden = messages.length === 0;
    };
    patternField.input.addEventListener('input', update);
    cwdField.input.addEventListener('input', update);
    update();

    const actions = el('div', { class: 'approval-actions approval-rule-confirm' });
    const save = button('approval-btn approval-btn-allow', 'Save rule and allow');
    save.disabled = this.submitting.has(entry.id);
    save.addEventListener('click', () => this.saveRule(entry));
    const cancel = button('approval-btn approval-rule-cancel', 'Cancel');
    cancel.addEventListener('click', () => this.closeRuleForm(entry));
    actions.appendChild(save);
    actions.appendChild(cancel);
    form.appendChild(actions);
    return form;
  }

  renderRules(all) {
    const known = new Set(all.map(r => r.id));
    for (const id of this.revoked) {
      if (!known.has(id)) this.revoked.delete(id);
    }
    const rules = all.filter(r => !this.revoked.has(r.id));

    const section = el('section', { class: 'approvals-rules' });
    const toggle = button('approvals-rules-toggle', `${this.rulesOpen ? 'Hide' : 'Show'} standing rules (${rules.length})`);
    toggle.setAttribute('aria-expanded', this.rulesOpen ? 'true' : 'false');
    toggle.addEventListener('click', () => {
      this.rulesOpen = !this.rulesOpen;
      this.render();
    });
    section.appendChild(toggle);

    const list = el('div', { class: 'approvals-rules-list' });
    list.hidden = !this.rulesOpen;
    if (rules.length === 0) {
      list.appendChild(el('div', { class: 'approvals-empty', text: 'No standing rules.' }));
    }
    for (const rule of rules) {
      const row = el('div', { class: 'approval-rule-row' });
      const verb = rule.decision === APPROVAL.DENY ? 'Deny' : 'Allow';
      const match = rule.pattern
        ? `${rule.exact === false ? 'matching' : 'exactly'} ${rule.pattern}`
        : 'anything';
      const where = rule.cwd ? rule.cwd : 'any folder';
      const text = el('div', { class: 'approval-rule-text' });
      text.textContent = `${verb} ${rule.tool} ${match}`;
      const meta = el('div', { class: 'approval-rule-meta' });
      meta.textContent = `${where} - used ${Number(rule.hits) || 0} time(s)`;
      const revoke = button('approval-rule-revoke', 'Revoke');
      revoke.addEventListener('click', () => this.revokeRule(rule));
      row.appendChild(text);
      row.appendChild(meta);
      row.appendChild(revoke);
      list.appendChild(row);
    }
    section.appendChild(list);
    return section;
  }
}

export default ApprovalsView;
