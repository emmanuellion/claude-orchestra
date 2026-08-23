'use strict';

const { test, before } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');

/**
 * store.js is a browser ES module and this package is CommonJS, so Node refuses
 * to import the .js directly. Copying the module graph into a temp directory
 * with .mjs extensions is the smallest way to test the real file rather than a
 * transcription of it.
 */
let Store;

before(async () => {
  const src = path.join(__dirname, '..', 'public', 'js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'store-'));
  for (const name of ['protocol', 'store']) {
    const code = fs.readFileSync(path.join(src, `${name}.js`), 'utf-8')
      .replace(/from '\.\/([a-z-]+)\.js'/g, "from './$1.mjs'");
    fs.writeFileSync(path.join(dir, `${name}.mjs`), code);
  }
  ({ Store } = await import(pathToFileURL(path.join(dir, 'store.mjs')).href));
});

const makeStore = () => new Store({
  storage: null,
  autoFlush: false,
  logger: { info() {}, warn() {}, error() {} },
});

const session = (id, over = {}) => ({
  id, name: 'S-' + id, kind: 'shell', status: 'idle', cwd: '/tmp', agent: {}, ...over,
});

test('a session the server closed is not resurrected by a late message', () => {
  const store = makeStore();
  store.upsertSession(session('a'));
  assert.equal(store.getSessions().length, 1);

  store.removeSession('a');
  assert.equal(store.getSessions().length, 0);

  // This is the exact shape the review saw arriving after `closed`: node-pty
  // kept firing, the server relayed it, and the row came back.
  store.upsertSession(session('a', { status: 'busy' }));
  assert.equal(store.getSessions().length, 0, 'a closed session must stay closed');
  assert.equal(store.getSession('a'), null);
});

test('the tombstone does not block unrelated sessions', () => {
  const store = makeStore();
  store.upsertSession(session('a'));
  store.removeSession('a');
  store.upsertSession(session('b'));
  assert.equal(store.getSessions().length, 1);
  assert.equal(store.getSessions()[0].id, 'b');
});

test('setSessions from the server is authoritative and does not revive closed ids', () => {
  const store = makeStore();
  store.upsertSession(session('a'));
  store.removeSession('a');
  store.setSessions([session('b'), session('c')]);
  assert.deepEqual(store.getSessions().map(s => s.id).sort(), ['b', 'c']);
});

test('order and active id stay consistent after a close', () => {
  const store = makeStore();
  store.upsertSession(session('a'));
  store.upsertSession(session('b'));
  store.setActive('a');
  store.removeSession('a');
  assert.equal(store.state.order.includes('a'), false);
  assert.notEqual(store.state.activeId, 'a');
});

test('array preferences survive a round trip through storage', () => {
  // migratePrefs used to keep only strings, numbers, booleans and plain
  // objects, so the manual sidebar order was silently dropped on reload.
  const backing = new Map();
  const storage = {
    getItem: k => (backing.has(k) ? backing.get(k) : null),
    setItem: (k, v) => backing.set(k, String(v)),
    removeItem: k => backing.delete(k),
  };
  const first = new Store({ storage, autoFlush: false, logger: { info() {}, warn() {}, error() {} } });
  first.setPref('sidebar.order', ['id-3', 'id-1', 'id-2']);
  first.flushPrefs();

  const second = new Store({ storage, autoFlush: false, logger: { info() {}, warn() {}, error() {} } });
  assert.deepEqual(second.getPref('sidebar.order'), ['id-3', 'id-1', 'id-2']);
});
