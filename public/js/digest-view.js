import { h, clear } from './dom.js';

/**
 * "What happened while I was away", as a view rather than a settings pane.
 *
 * The data behind this already existed and was unreadable: a JSONL timeline
 * nobody opens, a cost per panel, a quota block that scrolled past at 03:00.
 * Coming back to six agents meant reconstructing a night from six scrollbacks.
 *
 * So the ordering here is not by category, it is by what a returning operator
 * has to act on. Anything blocked comes first and everything else is
 * background, because after eight hours away the only urgent question is what
 * is waiting for a human.
 */

const WINDOWS = [
  ['1h', 3600e3],
  ['8h', 8 * 3600e3],
  ['24h', 24 * 3600e3],
  ['7d', 7 * 24 * 3600e3],
];

const DEFAULT_WINDOW_MS = 12 * 3600e3;

function money(n) {
  const v = Number(n);
  return Number.isFinite(v) ? `$${v.toFixed(2)}` : '$0.00';
}

function clock(ts) {
  if (!Number.isFinite(ts)) return '';
  return new Date(ts).toLocaleString();
}

function relative(ts, now = Date.now()) {
  if (!Number.isFinite(ts)) return '';
  const mins = Math.round((now - ts) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

export class DigestView {
  /**
   * @param {HTMLElement} root  `#view-digest`
   * @param {{api: object, actions?: object, logger?: object}} deps
   */
  constructor(root, deps = {}) {
    if (!root) throw new Error('DigestView requires a root element');
    this.root = root;
    this.api = deps.api || null;
    this.actions = deps.actions || {};
    this.log = deps.logger || console;

    this.windowMs = DEFAULT_WINDOW_MS;
    this.data = null;
    this.loading = false;
    this.error = null;
    this._loadedOnce = false;
  }

  mount() {
    this.render();
    return this;
  }

  /** Called when the view becomes visible. */
  activate() {
    // Always refetch: a digest showing yesterday's night is worse than a
    // spinner, and the request is one JSON read.
    this.refresh();
  }

  async refresh() {
    if (this.loading || !this.api) return;
    this.loading = true;
    this.error = null;
    this.render();
    try {
      const since = Date.now() - this.windowMs;
      this.data = await this.api.request('GET', `/api/digest?since=${since}`);
    } catch (err) {
      this.error = err && err.message ? err.message : String(err);
      this.log.warn(`[digest] ${this.error}`);
    } finally {
      this.loading = false;
      this._loadedOnce = true;
      this.render();
    }
  }

  render() {
    clear(this.root);
    const page = h('div', { class: 'digest' });

    page.appendChild(this._header());

    if (this.error) {
      page.appendChild(h('div', { class: 'digest-alert' },
        h('strong', { text: 'Could not build the digest. ' }),
        h('span', { text: this.error })));
    }
    if (this.loading && !this.data) {
      page.appendChild(h('p', { class: 'digest-note', text: 'Reading the timeline...' }));
      this.root.appendChild(page);
      return;
    }
    if (!this.data) {
      if (!this._loadedOnce) this.refresh();
      this.root.appendChild(page);
      return;
    }

    const d = this.data;
    page.appendChild(this._highlights(d));
    const attention = this._attention(d.attention);
    if (attention) page.appendChild(attention);
    page.appendChild(this._stats(d));
    const cost = this._cost(d.cost);
    if (cost) page.appendChild(cost);

    this.root.appendChild(page);
  }

  _header() {
    const head = h('header', { class: 'digest-head' },
      h('div', {},
        h('h2', { class: 'digest-title', text: 'While you were away' }),
        h('p', {
          class: 'digest-sub',
          text: this.data
            ? `${clock(this.data.since)} to now`
            : 'A summary of what the agents did unattended.',
        })));

    const controls = h('div', { class: 'digest-controls' });
    for (const [label, ms] of WINDOWS) {
      controls.appendChild(h('button', {
        class: `digest-range${this.windowMs === ms ? ' is-active' : ''}`,
        text: label,
        onclick: () => { this.windowMs = ms; this.refresh(); },
      }));
    }
    controls.appendChild(h('button', {
      class: 'digest-refresh',
      text: this.loading ? 'Loading...' : 'Refresh',
      disabled: this.loading,
      onclick: () => this.refresh(),
    }));
    head.appendChild(controls);
    return head;
  }

  _highlights(d) {
    const box = h('section', { class: 'digest-highlights' });
    for (const line of d.highlights || []) {
      box.appendChild(h('p', { class: 'digest-highlight', text: line }));
    }
    return box;
  }

  /**
   * The blocked things, each with the button that unblocks it. A digest that
   * only tells you an agent is waiting has moved the problem, not solved it.
   */
  _attention(a) {
    if (!a) return null;
    const rows = [];

    for (const req of a.pendingApprovals || []) {
      rows.push(this._row('permission', `${req.sessionName || 'An agent'} wants permission`,
        `${req.tool}: ${req.summary || ''}`, relative(req.createdAt),
        { label: 'Review', onClick: () => this._go('approvals', req.sessionId) }));
    }
    for (const q of a.questions || []) {
      rows.push(this._row('question', `${q.name} asked a question`, q.question || '', '',
        { label: 'Open', onClick: () => this._go('terminals', q.id) }));
    }
    for (const b of a.budgetBreaches || []) {
      rows.push(this._row('budget', `${b.name || 'A session'} hit its ${b.scope} budget`,
        `${money(b.spent)} of ${money(b.cap)}${b.locked ? ', locked' : ''}`, relative(b.at),
        b.locked ? { label: 'Unlock', onClick: () => this._release(b.sessionId) } : null));
    }
    for (const q of a.quotaBlocked || []) {
      rows.push(this._row('quota', `${q.name} is waiting on a quota reset`,
        q.resetsAt ? `resets ${clock(q.resetsAt)}` : (q.resetsText ? `resets ${q.resetsText}` : 'reset time unknown'),
        '', { label: 'Open', onClick: () => this._go('terminals', q.sessionId) }));
    }
    for (const g of a.giveUps || []) {
      rows.push(this._row('giveup', `${g.name} could not be resumed`, g.reason || '', '',
        { label: 'Open', onClick: () => this._go('terminals', g.sessionId) }));
    }
    for (const r of a.resumed || []) {
      rows.push(this._row('resumed', `${r.name} resumed automatically`,
        `after the quota reset, attempt ${r.attempts}`, relative(r.at), null));
    }

    if (!rows.length) return null;
    const box = h('section', { class: 'digest-section' },
      h('h3', { class: 'digest-h3', text: 'Needs you' }));
    for (const row of rows) box.appendChild(row);
    return box;
  }

  _row(kind, title, detail, when, action) {
    const row = h('div', { class: `digest-row is-${kind}` },
      h('div', { class: 'digest-row-text' },
        h('strong', { class: 'digest-row-title', text: title }),
        detail ? h('span', { class: 'digest-row-detail', text: detail }) : null,
        when ? h('span', { class: 'digest-row-when', text: when }) : null));
    if (action) {
      row.appendChild(h('button', {
        class: 'digest-row-btn', text: action.label, onclick: action.onClick,
      }));
    }
    return row;
  }

  _stats(d) {
    const w = d.work || {};
    const s = d.sessions || {};
    const box = h('section', { class: 'digest-section' },
      h('h3', { class: 'digest-h3', text: 'What ran' }),
      h('div', { class: 'digest-stats' },
        this._stat('Turns', w.turns || 0),
        this._stat('Tool calls', w.toolCalls || 0),
        this._stat('Failures', w.toolFailures || 0),
        this._stat('Subagents', w.subagents || 0),
        this._stat('Started', s.startedInWindow || 0),
        this._stat('Ended', s.exitedInWindow || 0)));

    if (w.topTools && w.topTools.length) {
      const list = h('ul', { class: 'digest-tools' });
      for (const t of w.topTools) {
        list.appendChild(h('li', { class: 'digest-tool' },
          h('span', { class: 'digest-tool-name', text: t.tool }),
          h('span', { class: 'digest-tool-count', text: String(t.count) }),
          t.failures
            ? h('span', { class: 'digest-tool-fail', text: `${t.failures} failed` })
            : null));
      }
      box.appendChild(list);
    }

    if (s.exited && s.exited.length) {
      const list = h('ul', { class: 'digest-exits' });
      for (const e of s.exited) {
        list.appendChild(h('li', {
          class: `digest-exit${e.exitCode ? ' is-bad' : ''}`,
          text: `${e.name} exited${e.exitCode ? ` (${e.exitCode})` : ''} ${relative(e.exitedAt)}`,
        }));
      }
      box.appendChild(list);
    }
    return box;
  }

  _stat(label, value) {
    return h('div', { class: 'digest-stat' },
      h('span', { class: 'digest-stat-value', text: String(value) }),
      h('span', { class: 'digest-stat-label', text: label }));
  }

  _cost(cost) {
    if (!cost || !cost.bySession || !cost.bySession.length) return null;
    const box = h('section', { class: 'digest-section' },
      h('h3', { class: 'digest-h3', text: 'Cost' }),
      h('p', { class: 'digest-note',
        text: cost.today !== null && cost.today !== undefined
          ? `${money(cost.total)} on live sessions, ${money(cost.today)} charged today.`
          : `${money(cost.total)} across live sessions.` }));

    const list = h('ul', { class: 'digest-costs' });
    for (const s of cost.bySession.slice(0, 10)) {
      list.appendChild(h('li', { class: 'digest-cost' },
        h('span', { class: 'digest-cost-name', text: s.name || s.id }),
        h('span', { class: 'digest-cost-project', text: s.project || '' }),
        h('span', { class: 'digest-cost-value', text: money(s.cost) })));
    }
    box.appendChild(list);
    return box;
  }

  _go(view, sessionId) {
    if (typeof this.actions.setView === 'function') this.actions.setView(view, sessionId);
  }

  async _release(sessionId) {
    if (!this.api) return;
    try {
      await this.api.request('POST', `/api/budget/${encodeURIComponent(sessionId)}/release`);
      this.refresh();
    } catch (err) {
      this.error = err && err.message ? err.message : String(err);
      this.render();
    }
  }
}

export default DigestView;
