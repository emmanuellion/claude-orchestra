'use strict';

const { test, before } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');

/**
 * The checklist decides what a first-time user is told to do, and in what
 * order, so its logic is worth pinning down. Only `steps()` and `visible()` are
 * exercised: they are pure, and `render()` is the part that needs a DOM.
 *
 * Same trick as store-tombstone.test.js: the module graph is copied to .mjs so
 * the real file is under test rather than a transcription of it.
 */
let SetupCard;

before(async () => {
  const src = path.join(__dirname, '..', 'public', 'js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'setup-'));
  for (const name of ['dom', 'setup']) {
    const code = fs.readFileSync(path.join(src, `${name}.js`), 'utf-8')
      .replace(/from '\.\/([a-z-]+)\.js'/g, "from './$1.mjs'");
    fs.writeFileSync(path.join(dir, `${name}.mjs`), code);
  }
  ({ SetupCard } = await import(pathToFileURL(path.join(dir, 'setup.mjs')).href));
});

function fakeStore(sessions = [], prefs = {}) {
  return {
    sessionList: () => sessions,
    getPref: (key, fallback) => (key in prefs ? prefs[key] : fallback),
    setPref: (key, value) => { prefs[key] = value; },
    on: () => () => {},
    _prefs: prefs,
  };
}

/** A truthy host is all `visible()` needs; nothing here calls render(). */
function card(overrides = {}) {
  const c = new SetupCard({}, {
    store: overrides.store || fakeStore(),
    api: { request: async () => ({}) },
    push: overrides.push === undefined ? null : overrides.push,
    logger: { warn() {} },
  });
  c.hooks = overrides.hooks === undefined
    ? { missing: [], parsable: true, approvals: { installed: true } }
    : overrides.hooks;
  if (overrides.pushReady !== undefined) c.pushReady = overrides.pushReady;
  return c;
}

test('nothing is shown until the hook status has actually been read', () => {
  const c = card({ hooks: null });
  assert.equal(c.visible(), false, 'a checklist that guesses would flash wrong advice');
});

test('missing hooks make the first step the required one', () => {
  const c = card({ hooks: { missing: ['Stop', 'PreToolUse'], parsable: true } });
  const [hooks] = c.steps();

  assert.equal(hooks.id, 'hooks');
  assert.equal(hooks.required, true);
  assert.equal(hooks.done, false);
  assert.ok(hooks.action, 'and it has to offer the fix, not just name it');
  assert.equal(c.visible(), true);
});

test('an unparsable settings.json is named as such and offers no write', () => {
  const c = card({ hooks: { missing: ['Stop'], parsable: false } });
  const [hooks] = c.steps();

  assert.equal(hooks.done, false);
  assert.equal(hooks.action, null, 'Orchestra must not offer to write a file it could not read');
  assert.match(hooks.detail, /cannot be parsed/);
});

test('the second step tracks whether any agent exists', () => {
  const empty = card();
  assert.equal(empty.steps()[1].done, false);

  const running = card({ store: fakeStore([{ id: 'a' }]) });
  assert.equal(running.steps()[1].done, true);
});

test('push is marked optional and never blocks the checklist from retiring', () => {
  const c = card({ store: fakeStore([{ id: 'a' }]), pushReady: false });
  const push = c.steps()[3];

  assert.equal(push.required, false);
  assert.equal(push.done, false);
  // Everything required is done, so the card is now only a suggestion.
  assert.equal(c.visible(), true, 'it still offers the optional step');
  c.dismiss();
  assert.equal(c.visible(), false, 'and dismissing has to be honoured');
});

test('dismissing cannot hide a required step', () => {
  const prefs = { 'setup.dismissed': true };
  const c = card({
    store: fakeStore([], prefs),
    hooks: { missing: ['Stop'], parsable: true },
  });
  assert.equal(c.dismissed, true);
  assert.equal(c.visible(), true, 'the product does not work without hooks; saying so is not a nag');
});

test('the card retires on its own once everything is done', () => {
  const c = card({ store: fakeStore([{ id: 'a' }]), pushReady: true });
  assert.deepEqual(c.steps().map(s => s.done), [true, true, true, true]);
  assert.equal(c.visible(), false, 'a satisfied checklist is clutter');
});

test('blocking approvals are offered, never switched on by installing hooks', () => {
  const c = card({
    store: fakeStore([{ id: 'a' }]),
    hooks: { missing: [], parsable: true, approvals: { installed: false } },
  });
  const step = c.steps().find(s => s.id === 'approvals');

  assert.equal(step.required, false, 'agents stopping on every tool call is a choice');
  assert.equal(step.done, false);
  assert.match(step.detail, /stop and wait/);
  assert.equal(c.visible(), true, 'and it is offered rather than hidden');
});

test('a browser that cannot do push says why instead of offering a button', () => {
  const c = card({
    store: fakeStore([{ id: 'a' }]),
    push: { supported: false, unsupportedReason: () => 'push needs a secure context' },
  });
  const push = c.steps()[3];

  assert.equal(push.action, null);
  assert.match(push.detail, /secure context/);
});

test('a usable push client gets a button into the right settings tab', () => {
  const c = card({
    store: fakeStore([{ id: 'a' }]),
    push: { supported: true, unsupportedReason: () => null, isSubscribed: async () => false },
  });
  const push = c.steps()[3];
  assert.ok(push.action);
  assert.equal(push.action.label, 'Set up push');
});
