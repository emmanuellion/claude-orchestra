import { h } from './dom.js';

/**
 * The first five minutes.
 *
 * Orchestra opens on an empty grid, and nothing on that screen says that the
 * feature the whole product is built on has to be switched on first. Hooks are
 * how the server learns what an agent is doing; without them a panel really is
 * just a terminal, and every interesting screen (agent status, remote approval,
 * the timeline, the digest) stays empty forever with no error to explain it.
 * That setting lived one click deep in a settings tab nobody opens on day one.
 *
 * So this states the order of operations, marks what is genuinely required
 * against what is optional, and puts the button that does each step next to the
 * sentence describing it. It disappears on its own once the required step is
 * done: a checklist that stays after it is satisfied is just clutter.
 */

export const SETUP_DISMISSED_PREF = 'setup.dismissed';

/** How long a freshly finished step stays ticked before the card retires. */
const SETTLE_MS = 2500;

export class SetupCard {
  /**
   * @param {HTMLElement} host  where the card is inserted, above the views
   * @param {{store: object, api: object, actions: object, push?: object,
   *          openSettings?: Function, logger?: object}} deps
   */
  constructor(host, deps = {}) {
    this.host = host;
    this.store = deps.store;
    this.api = deps.api;
    this.actions = deps.actions || {};
    this.push = deps.push || null;
    this.openSettings = deps.openSettings || null;
    this.log = deps.logger || console;

    this.node = null;
    this.hooks = null;
    this.loading = false;
    this.busy = false;
    this.error = null;
    this.pushReady = false;
    this._unsubs = [];
    this._retireTimer = null;
  }

  mount() {
    if (!this.host) return this;
    this._sub('sessions', () => this.render());
    this.refresh();
    return this;
  }

  destroy() {
    for (const off of this._unsubs) off();
    this._unsubs = [];
    if (this._retireTimer) clearTimeout(this._retireTimer);
    if (this.node) this.node.remove();
    this.node = null;
  }

  _sub(event, handler) {
    if (this.store && typeof this.store.on === 'function') {
      this._unsubs.push(this.store.on(event, handler));
    }
  }

  /** Re-reads the one thing that cannot be inferred from the store. */
  async refresh() {
    if (this.loading || !this.api) return;
    this.loading = true;
    try {
      this.hooks = await this.api.request('GET', '/api/hooks/status');
      this.error = null;
    } catch (err) {
      this.error = err && err.message ? err.message : String(err);
      this.log.warn(`[setup] ${this.error}`);
    } finally {
      this.loading = false;
      if (this.push && this.push.supported) {
        this.push.isSubscribed()
          .then((yes) => { this.pushReady = yes; this.render(); })
          .catch(() => { /* the settings pane reports why */ });
      }
      this.render();
    }
  }

  get dismissed() {
    return this.store && typeof this.store.getPref === 'function'
      ? this.store.getPref(SETUP_DISMISSED_PREF, false) === true
      : false;
  }

  dismiss() {
    if (this.store && typeof this.store.setPref === 'function') {
      this.store.setPref(SETUP_DISMISSED_PREF, true);
    }
    this.render();
  }

  /**
   * The steps, in the order they have to happen, each carrying whether it is
   * actually required. Calling the optional ones optional is the difference
   * between a checklist and a nag.
   */
  steps() {
    const hooks = this.hooks;
    const missing = hooks && Array.isArray(hooks.missing) ? hooks.missing.length : null;
    const unreadable = !!hooks && hooks.parsable === false;

    const sessions = this.store && typeof this.store.sessionList === 'function'
      ? this.store.sessionList().length
      : 0;

    return [
      {
        id: 'hooks',
        required: true,
        done: missing === 0 && !unreadable,
        title: 'Install the Claude Code hooks',
        detail: unreadable
          ? 'Your settings.json cannot be parsed, so Orchestra will not write to it. Fix the JSON by hand first.'
          : 'They are how Orchestra sees what an agent is doing. Without them a panel is just a terminal:'
            + ' no live status, no remote approval, no timeline, no honest "finished" notification.',
        action: unreadable ? null : { label: 'Install hooks', run: () => this._install() },
        secondary: { label: 'Details', run: () => this._openSettings('setup') },
      },
      {
        id: 'session',
        required: true,
        done: sessions > 0,
        title: 'Start an agent where the work is',
        detail: 'Pick a project directory. Orchestra names and colours the session after it, so several'
          + ' agents on one repository look alike without you deciding anything.',
        action: { label: 'Open projects', run: () => this._go('launcher') },
      },
      {
        id: 'approvals',
        required: false,
        done: !!(hooks && hooks.approvals && hooks.approvals.installed),
        title: 'Approve tool calls yourself',
        detail: 'Every tool call pauses until you allow or deny it, here or on your phone. Off by'
          + ' default because it genuinely changes how agents run: they stop and wait for a human.',
        action: unreadable ? null : { label: 'Turn on', run: () => this._enableApprovals() },
      },
      {
        id: 'push',
        required: false,
        done: this.pushReady,
        title: 'Get told on your phone',
        detail: this.push && !this.push.supported
          ? (this.push.unsupportedReason() || 'Push is not available in this browser.')
          : 'A permission request blocks an agent until it is answered. Push is what reaches you when'
            + ' this tab is closed.',
        action: this.push && this.push.supported
          ? { label: 'Set up push', run: () => this._openSettings('remote') }
          : null,
      },
    ];
  }

  /** Whether the card has anything left to say. */
  visible() {
    if (!this.host || !this.hooks) return false;
    const steps = this.steps();
    const requiredLeft = steps.some(s => s.required && !s.done);
    if (requiredLeft) return true;
    // Everything required is done, so from here it is only a suggestion and
    // dismissing has to be honoured.
    return !this.dismissed && steps.some(s => !s.done);
  }

  render() {
    if (!this.host) return;
    if (!this.visible()) {
      if (this.node) {
        this.node.remove();
        this.node = null;
      }
      return;
    }

    const steps = this.steps();
    const card = h('section', { class: 'setup' });

    const head = h('div', { class: 'setup-head' },
      h('div', {},
        h('strong', { class: 'setup-title', text: 'Set up Orchestra' }),
        h('p', {
          class: 'setup-sub',
          text: `${steps.filter(s => s.done).length} of ${steps.length} done.`
            + ` ${steps.filter(s => s.required).length} of them are required.`,
        })),
      h('button', {
        class: 'setup-close',
        text: 'Hide',
        title: steps.some(s => s.required && !s.done)
          ? 'Finish the required steps to hide this'
          : 'Hide this checklist',
        disabled: steps.some(s => s.required && !s.done),
        onclick: () => this.dismiss(),
      }));
    card.appendChild(head);

    if (this.error) {
      card.appendChild(h('p', { class: 'setup-error', text: `Could not read the hook status: ${this.error}` }));
    }

    for (const [index, step] of steps.entries()) {
      card.appendChild(this._step(step, index + 1));
    }

    if (this.node) {
      this.node.replaceWith(card);
    } else {
      // Before #views, not at the top of #main: the first child there is the
      // topbar, and a card inserted ahead of it pushes the whole chrome down.
      this.host.insertBefore(card, this.host.querySelector('#views'));
    }
    this.node = card;
  }

  _step(step, number) {
    const row = h('div', { class: `setup-step${step.done ? ' is-done' : ''}${step.required ? '' : ' is-optional'}` });

    row.appendChild(h('span', {
      class: 'setup-mark',
      text: step.done ? '✓' : String(number),
      'aria-hidden': 'true',
    }));

    const text = h('div', { class: 'setup-text' },
      h('span', { class: 'setup-step-title', text: step.title },
        step.required ? null : h('span', { class: 'setup-optional', text: 'optional' })),
      h('span', { class: 'setup-detail', text: step.detail }));
    row.appendChild(text);

    if (!step.done) {
      const buttons = h('div', { class: 'setup-actions' });
      if (step.action) {
        buttons.appendChild(h('button', {
          class: 'setup-btn setup-btn-primary',
          text: this.busy === step.id ? 'Working...' : step.action.label,
          disabled: this.busy === step.id,
          onclick: () => step.action.run(),
        }));
      }
      if (step.secondary) {
        buttons.appendChild(h('button', {
          class: 'setup-btn',
          text: step.secondary.label,
          onclick: () => step.secondary.run(),
        }));
      }
      row.appendChild(buttons);
    }
    return row;
  }

  async _install() {
    if (this.busy) return;
    this.busy = 'hooks';
    this.error = null;
    this.render();
    try {
      // Every event, plus the status line that feeds the quota meter. Not the
      // blocking approval hook: that one makes agents stop and wait for a human
      // on every tool call, which is a decision to take deliberately rather
      // than a side effect of clicking "install". It has its own step below.
      await this.api.request('POST', '/api/hooks/install', { statusLine: true });
    } catch (err) {
      this.error = err && err.message ? err.message : String(err);
    } finally {
      this.busy = false;
      await this.refresh();
      // Let a finished step be seen ticked before the card decides to retire.
      if (this._retireTimer) clearTimeout(this._retireTimer);
      this._retireTimer = setTimeout(() => this.render(), SETTLE_MS);
    }
  }

  async _enableApprovals() {
    if (this.busy) return;
    this.busy = 'approvals';
    this.error = null;
    this.render();
    try {
      const res = await this.api.request('POST', '/api/hooks/install', { approvals: true });
      // hooks-install answers {ok:false, reason} rather than throwing when it
      // refuses the write, so a thrown error is not the only failure to catch.
      if (res && res.ok === false) {
        this.error = `Could not install the approval hook: ${res.message || res.reason || 'the server refused the write'}`;
      }
    } catch (err) {
      this.error = err && err.message ? err.message : String(err);
    } finally {
      this.busy = false;
      await this.refresh();
    }
  }

  _go(view) {
    if (typeof this.actions.setView === 'function') this.actions.setView(view);
  }

  _openSettings(tab) {
    if (typeof this.openSettings === 'function') this.openSettings(tab);
  }
}

export default SetupCard;
