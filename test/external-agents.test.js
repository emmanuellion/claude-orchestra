'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { SessionManager } = require('../lib/session-manager');
const { HookBus } = require('../lib/hook-bus');
const { STATUS, KIND, LIMITS, HOOK_EVENT } = require('../lib/protocol');

const QUIET = { debug() {}, info() {}, warn() {}, error() {} };

/**
 * A real SessionManager. `create()` needs node-pty and is never called here:
 * adopting an agent we did not spawn is precisely the path that does not.
 */
function manager() {
  const sessions = new SessionManager();
  sessions.on('warning', () => {});
  return sessions;
}

function busFor(sessions, config = {}) {
  return new HookBus({
    sessions,
    config: {
      eventsDir: require('os').tmpdir(),
      IS_WIN: false,
      adoptExternal: true,
      ...config,
    },
    logger: QUIET,
  });
}

test('an agent we did not spawn can be adopted', () => {
  const sessions = manager();
  const s = sessions.adoptExternal({ claudeSessionId: 'abc', host: 'workstation', cwd: '/srv/api' });

  assert.ok(s);
  assert.equal(s.kind, KIND.EXTERNAL);
  assert.equal(s.pty, null, 'there is no terminal behind it');
  assert.equal(s.status, STATUS.IDLE);
  assert.equal(s.external.host, 'workstation');
  assert.equal(s.agent.claudeSessionId, 'abc');
  assert.match(s.name, /workstation/);
  sessions.shutdown();
});

test('the id is derived, so a reconnecting agent lands on its own record', () => {
  const sessions = manager();
  const first = sessions.adoptExternal({ claudeSessionId: 'abc', host: 'box' });
  const again = sessions.adoptExternal({ claudeSessionId: 'abc', host: 'box' });
  const other = sessions.adoptExternal({ claudeSessionId: 'abc', host: 'laptop' });

  assert.equal(first.id, again.id, 'the same agent must not accumulate records');
  assert.notEqual(first.id, other.id, 'the same Claude id on another machine is another agent');
  assert.equal(sessions.list().length, 2);
  sessions.shutdown();
});

test('it survives the wire, marked as external', () => {
  const sessions = manager();
  const s = sessions.adoptExternal({ claudeSessionId: 'abc', host: 'box', cwd: '/srv' });
  const wire = sessions.toWire(s);

  assert.equal(wire.kind, KIND.EXTERNAL);
  assert.equal(wire.external.host, 'box');
  assert.equal(wire.attached, 0);
  sessions.shutdown();
});

test('an external agent accepts no input', () => {
  const sessions = manager();
  const s = sessions.adoptExternal({ claudeSessionId: 'abc' });
  // No PTY means write() already refuses. Nothing typed at a panel, and nothing
  // from the quota auto resume, can reach a machine we do not own.
  assert.equal(sessions.write(s.id, 'rm -rf /\r'), false);
  sessions.shutdown();
});

test('it is not offered as an orphan to resume after a restart', () => {
  const sessions = manager();
  sessions.adoptExternal({ claudeSessionId: 'abc', host: 'box' });
  assert.deepEqual(sessions.persistable(), [], 'we cannot respawn what we never spawned');
  sessions.shutdown();
});

test('restart and duplicate refuse rather than trying', () => {
  const sessions = manager();
  const s = sessions.adoptExternal({ claudeSessionId: 'abc' });
  assert.throws(() => sessions.restart(s.id), /not ours to restart/);
  assert.throws(() => sessions.duplicate(s.id), /cannot be duplicated/);
  sessions.shutdown();
});

test('silence, not detachment, is what ends an external agent', () => {
  const sessions = manager();
  const s = sessions.adoptExternal({ claudeSessionId: 'abc' });

  // Nothing ever attaches to one of these, so the ordinary detach TTL would
  // reclaim every one of them within the hour.
  sessions.sweepDetached();
  assert.equal(sessions.get(s.id).status, STATUS.IDLE);

  s.lastActivityAt = Date.now() - LIMITS.EXTERNAL_TTL_MS - 1000;
  sessions.sweepDetached();
  assert.equal(sessions.get(s.id).status, STATUS.EXITED);
  sessions.shutdown();
});

test('an agent that comes back is revived rather than duplicated', () => {
  const sessions = manager();
  const s = sessions.adoptExternal({ claudeSessionId: 'abc', host: 'box' });
  s.status = STATUS.EXITED;
  s.exitedAt = Date.now();

  const again = sessions.adoptExternal({ claudeSessionId: 'abc', host: 'box' });
  assert.equal(again.id, s.id);
  assert.equal(again.status, STATUS.IDLE);
  assert.equal(sessions.list().length, 1);
  sessions.shutdown();
});

test('adoption is capped', () => {
  const sessions = manager();
  for (let i = 0; i < LIMITS.MAX_EXTERNAL + 5; i++) {
    sessions.adoptExternal({ claudeSessionId: `agent-${i}`, host: 'box' });
  }
  assert.equal(sessions.list().length, LIMITS.MAX_EXTERNAL);
  sessions.shutdown();
});

test('an event from an unknown agent adopts it and applies its state', () => {
  const sessions = manager();
  const bus = busFor(sessions);

  const out = bus.ingest(HOOK_EVENT.USER_PROMPT_SUBMIT, {
    session_id: 'claude-123',
    orchestraHost: 'build-box',
    cwd: '/srv/api',
    prompt: 'fix the flaky test',
  });

  assert.equal(out.ok, true);
  assert.equal(out.matched, true, 'adoption is what turns an orphan event into a matched one');

  const session = sessions.get(out.sessionId);
  assert.equal(session.kind, KIND.EXTERNAL);
  assert.equal(session.status, STATUS.BUSY, 'the state machine applies to it like any other');
  assert.equal(session.agent.lastPrompt, 'fix the flaky test');
  bus.stop();
  sessions.shutdown();
});

test('two local sessions sharing a directory do not spawn a phantom', () => {
  const sessions = manager();
  const bus = busFor(sessions);

  // Ambiguous cwd is the case where resolution already refuses to guess.
  // Adopting there would hang a third agent next to two real ones.
  const a = sessions.adoptExternal({ claudeSessionId: 'a', host: 'h', cwd: '/shared' });
  const b = sessions.adoptExternal({ claudeSessionId: 'b', host: 'h', cwd: '/shared' });
  a.kind = KIND.CLAUDE;
  b.kind = KIND.CLAUDE;
  a.agent.claudeSessionId = null;
  b.agent.claudeSessionId = null;

  const before = sessions.list().length;
  const out = bus.ingest(HOOK_EVENT.STOP, { cwd: '/shared' });
  assert.equal(out.matched, false);
  assert.equal(sessions.list().length, before, 'no third record');
  bus.stop();
  sessions.shutdown();
});

test('an event with no Claude session id has nothing stable to key on', () => {
  const sessions = manager();
  const bus = busFor(sessions);
  const out = bus.ingest(HOOK_EVENT.STOP, { cwd: '/nowhere/at/all' });
  assert.equal(out.matched, false);
  assert.equal(sessions.list().length, 0, 'otherwise every event would create a record');
  bus.stop();
  sessions.shutdown();
});

test('adoption can be switched off', () => {
  const sessions = manager();
  const bus = busFor(sessions, { adoptExternal: false });
  const out = bus.ingest(HOOK_EVENT.STOP, { session_id: 'x', cwd: '/nowhere' });
  assert.equal(out.matched, false);
  assert.equal(sessions.list().length, 0);
  bus.stop();
  sessions.shutdown();
});

test('repeated events from one agent keep landing on one record', () => {
  const sessions = manager();
  const bus = busFor(sessions);
  for (let i = 0; i < 10; i++) {
    bus.ingest(HOOK_EVENT.PRE_TOOL_USE, {
      session_id: 'claude-123', orchestraHost: 'box', cwd: '/srv', tool_name: 'Read',
    });
  }
  assert.equal(sessions.list().length, 1);
  bus.stop();
  sessions.shutdown();
});
