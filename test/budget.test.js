'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('events');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { BudgetGuard, dayKey } = require('../lib/budget');
const { STATUS, KIND } = require('../lib/protocol');

const QUIET = { debug() {}, info() {}, warn() {}, error() {} };

/** The slice of SessionManager the guard uses: get, setMeta, and the event. */
class FakeSessions extends EventEmitter {
  constructor() {
    super();
    this.map = new Map();
    this.metaCalls = [];
  }

  add(patch = {}) {
    const session = {
      id: patch.id || `s${this.map.size + 1}`,
      name: patch.name || 'agent',
      cwd: patch.cwd || '/repo',
      kind: KIND.CLAUDE,
      status: STATUS.BUSY,
      locked: false,
      agent: { cost: 0 },
      ...patch,
    };
    this.map.set(session.id, session);
    return session;
  }

  get(id) {
    return this.map.get(id);
  }

  setMeta(id, patch) {
    this.metaCalls.push({ id, patch });
    const s = this.map.get(id);
    if (s && typeof patch.locked === 'boolean') s.locked = patch.locked;
  }

  /** What SessionManager broadcasts, which is what the guard listens to. */
  report(session, cost) {
    session.agent.cost = cost;
    const wire = {
      id: session.id, name: session.name, cwd: session.cwd,
      status: session.status, locked: session.locked, agent: { ...session.agent },
    };
    this.emit('session', wire);
    return wire;
  }
}

function tmpFile() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'orchestra-budget-')), 'budget.json');
}

function build(overrides = {}, policy = null) {
  const sessions = new FakeSessions();
  const config = {
    budgetFile: tmpFile(),
    budgetEnabled: true,
    budgetSessionCap: 5,
    budgetDailyCap: 0,
    budgetAction: 'lock',
    ...overrides,
  };
  const guard = new BudgetGuard({ sessions, policy, config, logger: QUIET }).start();
  return { sessions, guard, config };
}

test('spend is recorded even with enforcement off', () => {
  const { sessions, guard } = build({ budgetEnabled: false });
  const s = sessions.add();
  sessions.report(s, 1.25);

  assert.equal(guard.todayTotal(), 1.25);
  assert.deepEqual(sessions.metaCalls, [], 'nothing is locked while it is off');
});

test('a session is locked at its cap', () => {
  const { sessions, guard } = build({ budgetSessionCap: 2 });
  const s = sessions.add({ name: 'api worker' });

  const breaches = [];
  guard.on('breach', b => breaches.push(b));

  sessions.report(s, 1.5);
  assert.deepEqual(sessions.metaCalls, [], 'under the cap, nothing happens');

  sessions.report(s, 2.0);
  assert.equal(breaches.length, 1);
  assert.equal(breaches[0].scope, 'session');
  assert.equal(breaches[0].locked, true);
  assert.deepEqual(sessions.metaCalls, [{ id: s.id, patch: { locked: true } }]);
});

test('one breach locks once, however many events follow', () => {
  const { sessions } = build({ budgetSessionCap: 1 });
  const s = sessions.add();
  for (const cost of [1, 2, 3, 4]) sessions.report(s, cost);
  assert.equal(sessions.metaCalls.length, 1);
});

test('the warn action alerts without stopping anything', () => {
  const { sessions, guard } = build({ budgetSessionCap: 1, budgetAction: 'warn' });
  const s = sessions.add();
  const breaches = [];
  guard.on('breach', b => breaches.push(b));

  sessions.report(s, 5);
  assert.equal(breaches.length, 1);
  assert.equal(breaches[0].locked, false);
  assert.deepEqual(sessions.metaCalls, [], 'warn must never touch the session');
});

test('a warning fires once at the threshold, before the cap', () => {
  const { sessions, guard } = build({ budgetSessionCap: 10 });
  const s = sessions.add();
  const warnings = [];
  guard.on('warning', w => warnings.push(w));

  sessions.report(s, 7);
  assert.equal(warnings.length, 0, 'below the threshold');
  sessions.report(s, 8);
  assert.equal(warnings.length, 1, 'at 80%');
  sessions.report(s, 9);
  assert.equal(warnings.length, 1, 'and not again');
});

test('a daily cap counts across every session', () => {
  const { sessions, guard } = build({ budgetSessionCap: 0, budgetDailyCap: 3 });
  const a = sessions.add({ id: 'a' });
  const b = sessions.add({ id: 'b' });
  const breaches = [];
  guard.on('breach', x => breaches.push(x));

  sessions.report(a, 2);
  assert.equal(breaches.length, 0);
  sessions.report(b, 1.5);
  assert.equal(breaches.length, 1);
  assert.equal(breaches[0].scope, 'daily');
  assert.equal(guard.todayTotal(), 3.5);
});

test('cost only ever moves up, so a replayed hook is not a refund', () => {
  const { sessions, guard } = build();
  const s = sessions.add();
  sessions.report(s, 3);
  sessions.report(s, 1);
  assert.equal(guard.todayTotal(), 3);
});

test('a repository policy may tighten the cap but never loosen it', () => {
  const policy = { budgetForCwd: (cwd) => (cwd === '/strict' ? 1 : 100) };
  const { sessions } = build({ budgetSessionCap: 5 }, policy);

  const strict = sessions.add({ id: 'strict', cwd: '/strict' });
  const loose = sessions.add({ id: 'loose', cwd: '/loose' });

  sessions.report(strict, 1.2);
  assert.equal(strict.locked, true, 'the repo asked for a lower cap and got it');

  sessions.report(loose, 4);
  assert.equal(loose.locked, false, 'a policy asking for 100 cannot raise the global 5');
  sessions.report(loose, 5);
  assert.equal(loose.locked, true);
});

test('release unlocks and forgives, so the next event does not relock', () => {
  const { sessions, guard } = build({ budgetSessionCap: 1 });
  const s = sessions.add();
  sessions.report(s, 2);
  assert.equal(s.locked, true);

  assert.equal(guard.release(s.id).ok, true);
  assert.equal(s.locked, false);

  sessions.report(s, 2.5);
  assert.equal(s.locked, false, 'forgiving has to outlast the next hook carrying the same total');
});

test('an exited session is not locked', () => {
  const { sessions } = build({ budgetSessionCap: 1 });
  const s = sessions.add({ status: STATUS.EXITED });
  sessions.report(s, 5);
  assert.deepEqual(sessions.metaCalls, []);
});

test('the ledger and settings survive a restart', () => {
  const { sessions, guard, config } = build();
  const s = sessions.add({ id: 'keeper' });
  sessions.report(s, 4.5);
  guard.stop();

  const revived = new BudgetGuard({ sessions: new FakeSessions(), config, logger: QUIET });
  assert.equal(revived.todayTotal(), 4.5);
  assert.equal(revived.settings().sessionCap, 5);
});

test('settings are validated as one decision', () => {
  const { guard } = build({ budgetEnabled: false, budgetSessionCap: 0, budgetDailyCap: 0 });

  const refused = guard.updateSettings({ enabled: true });
  assert.match(refused.error, /set a session cap or a daily cap/);
  assert.equal(refused.settings.enabled, false, 'enforcing nothing must not read as enforcing');

  const badAction = guard.updateSettings({ action: 'explode' });
  assert.match(badAction.error, /lock/);

  const ok = guard.updateSettings({ enabled: true, sessionCap: 3 });
  assert.equal(ok.error, null);
  assert.equal(ok.settings.enabled, true);
  assert.equal(ok.settings.sessionCap, 3);
});

test('caps are clamped rather than trusted', () => {
  const { guard } = build();
  assert.equal(guard.updateSettings({ sessionCap: 1e9 }).settings.sessionCap, 10000);
  // A negative cap clamps to 0, which with enforcement on means no cap at all,
  // so the whole patch is refused rather than quietly disarming the guard.
  const refused = guard.updateSettings({ sessionCap: -5 });
  assert.match(refused.error, /set a session cap or a daily cap/);
  assert.equal(refused.settings.sessionCap, 10000);
  // With enforcement off there is nothing to disarm, so it clamps and applies.
  guard.updateSettings({ enabled: false });
  assert.equal(guard.updateSettings({ sessionCap: -5 }).settings.sessionCap, 0);
});

test('unlocking grants another cap rather than an exemption', () => {
  const { sessions, guard } = build({ budgetSessionCap: 1 });
  const s = sessions.add();
  sessions.report(s, 2);
  assert.equal(s.locked, true);

  guard.release(s.id);
  sessions.report(s, 2.5);
  assert.equal(s.locked, false, 'the unlock has to outlast the next event');

  // The cap still exists: it was raised to what it had spent plus one more.
  sessions.report(s, 99);
  assert.equal(s.locked, true, 'a raised cap is still a cap');
});

test('state names the sessions so a UI can act on them', () => {
  const { sessions, guard } = build({ budgetSessionCap: 1 });
  const s = sessions.add({ name: 'api worker' });
  sessions.report(s, 2);

  const state = guard.state();
  assert.equal(state.today.total, 2);
  assert.equal(state.today.bySession[0].name, 'api worker');
  assert.equal(state.today.bySession[0].locked, true);
  assert.equal(state.breaches.length, 1);
});

test('a corrupt ledger file falls back to defaults instead of throwing', () => {
  const file = tmpFile();
  fs.writeFileSync(file, 'not json at all');
  const guard = new BudgetGuard({
    sessions: new FakeSessions(),
    config: { budgetFile: file, budgetSessionCap: 7 },
    logger: QUIET,
  });
  assert.equal(guard.todayTotal(), 0);
  assert.equal(guard.settings().sessionCap, 7);
});

test('dayKey follows the local calendar, which is how a bill reads', () => {
  const noon = new Date(2026, 8, 4, 12, 0, 0).getTime();
  assert.equal(dayKey(noon), '2026-09-04');
});
