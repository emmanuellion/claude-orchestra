'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('events');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { AutoResume, sanitizeResumeText, STATE, QUIET_MS } = require('../lib/auto-resume');
const { STATUS, KIND } = require('../lib/protocol');

const T0 = Date.parse('2026-09-04T10:00:00Z');
const HOUR = 3600 * 1000;

/** Just the surface AutoResume actually uses. */
class FakeSessions extends EventEmitter {
  constructor() {
    super();
    this.map = new Map();
    this.writes = [];
  }

  add(patch = {}) {
    const session = {
      id: patch.id || `s${this.map.size + 1}`,
      name: patch.name || 'agent',
      cwd: '/repo',
      kind: KIND.CLAUDE,
      status: STATUS.IDLE,
      locked: false,
      ...patch,
    };
    this.map.set(session.id, session);
    return session;
  }

  get(id) {
    return this.map.get(id);
  }

  write(id, data) {
    const session = this.map.get(id);
    if (!session || session.locked) return false;
    this.writes.push({ id, data });
    return true;
  }
}

function tmpFile() {
  return path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), 'orchestra-resume-')),
    'auto-resume.json',
  );
}

function build(overrides = {}, quota = null) {
  const sessions = new FakeSessions();
  const config = {
    autoResumeFile: tmpFile(),
    autoResume: true,
    autoResumeText: 'continue',
    autoResumeGraceSeconds: 60,
    autoResumeStaggerSeconds: 30,
    autoResumeMaxAttempts: 3,
    autoResumeWaitSeconds: 600,
    ...overrides,
  };
  const usage = { read: async () => ({ quota }) };
  const resume = new AutoResume({ sessions, usage, config, logger: { warn() {}, error() {} } });
  return { sessions, resume, config };
}

const BANNER = 'Claude usage limit reached. Your limit will reset at 3pm.';

/**
 * Arms a plan at T0. Every test drives the same injected clock through both
 * noteOutput and tick, because the quiet window compares the two and mixing a
 * fake tick time with a real Date.now() silently disables that check.
 */
function block(resume, sessionId, text = BANNER, now = T0) {
  return resume.noteOutput(sessionId, text, now);
}

test('a banner arms a plan with a due time past the reset', async () => {
  const { sessions, resume } = build();
  const session = sessions.add();

  const plan = block(resume, session.id);
  assert.ok(plan, 'the banner should arm a plan');
  assert.equal(plan.state, STATE.ARMED);
  assert.ok(plan.resetsAt > Date.now());
  assert.equal(plan.dueAt, plan.resetsAt + 60 * 1000, 'grace is added to the reset instant');
});

test('output from a plain shell is never matched', () => {
  const { sessions, resume } = build();
  const shell = sessions.add({ kind: KIND.SHELL });
  assert.equal(block(resume, shell.id), null);
  assert.equal(resume.plans().length, 0);
});

test('the same banner redrawn does not stack plans or reset the attempt count', () => {
  const { sessions, resume } = build();
  const session = sessions.add();
  block(resume, session.id);
  resume._plans.get(session.id).attempts = 2;
  for (let i = 0; i < 5; i++) block(resume, session.id);
  assert.equal(resume.plans().length, 1);
  assert.equal(resume._plans.get(session.id).attempts, 2, 'a redraw is not a new block');
});

test('nothing is sent before the reset is due', async () => {
  const { sessions, resume } = build();
  const session = sessions.add();
  const plan = block(resume, session.id);
  await resume.tick(plan.dueAt - 1000);
  assert.deepEqual(sessions.writes, []);
});

test('the prompt is typed once the reset is due, with a carriage return', async () => {
  const { sessions, resume } = build();
  const session = sessions.add();
  const plan = block(resume, session.id);

  await resume.tick(plan.dueAt + 1000);
  assert.equal(sessions.writes.length, 1);
  assert.equal(sessions.writes[0].id, session.id);
  assert.equal(sessions.writes[0].data, 'continue\r');
  assert.equal(resume._plans.get(session.id).state, STATE.SENT);
});

test('switched off, a block is still tracked but nothing is typed', async () => {
  const { sessions, resume } = build({ autoResume: false });
  const session = sessions.add();
  const plan = block(resume, session.id);

  await resume.tick(plan.dueAt + HOUR);
  assert.deepEqual(sessions.writes, [], 'the toggle has to actually gate the write');
  assert.equal(resume.plans().length, 1, 'but the UI still gets to show the block');
});

test('a pending permission prompt blocks the resume', async () => {
  const { sessions, resume } = build();
  const session = sessions.add({ status: STATUS.AWAITING_PERMISSION });
  const plan = block(resume, session.id);

  await resume.tick(plan.dueAt + 1000);
  assert.deepEqual(sessions.writes, [], 'a resume prompt must never answer a permission question');
  const after = resume._plans.get(session.id);
  assert.equal(after.state, STATE.WAITING);
  assert.match(after.lastError, /permission/);
});

test('a session still producing output is left alone until it settles', async () => {
  const { sessions, resume } = build();
  const session = sessions.add();
  const plan = block(resume, session.id);

  // The agent printed something a second before the reset came due. Typing on
  // top of live output lands mid render and is read as anything but a prompt.
  block(resume, session.id, 'thinking...', plan.dueAt - 1000);
  await resume.tick(plan.dueAt + 1000);
  assert.deepEqual(sessions.writes, []);
  assert.match(resume._plans.get(session.id).lastError, /still producing output/);

  await resume.tick(plan.dueAt + QUIET_MS + 2000);
  assert.equal(sessions.writes.length, 1);
});

test('a locked session is not written to', async () => {
  const { sessions, resume } = build();
  const session = sessions.add({ locked: true });
  const plan = block(resume, session.id);

  await resume.tick(plan.dueAt + 1000);
  assert.deepEqual(sessions.writes, []);
  assert.match(resume._plans.get(session.id).lastError, /locked/);
});

test('two sessions due together are staggered, not released at once', async () => {
  const { sessions, resume } = build();
  const a = sessions.add({ id: 'a' });
  const b = sessions.add({ id: 'b' });
  const planA = block(resume, a.id);
  block(resume, b.id);

  const due = planA.dueAt + 1000;
  await resume.tick(due);
  assert.equal(sessions.writes.length, 1, 'the whole point is not to re-consume the window at once');

  await resume.tick(due + 5000);
  assert.equal(sessions.writes.length, 1, 'still inside the 30s gap');

  await resume.tick(due + 31000);
  assert.equal(sessions.writes.length, 2);
  assert.notEqual(sessions.writes[0].id, sessions.writes[1].id);
});

test('a window the account still reports as exhausted defers the resume', async () => {
  const stillBlocked = {
    five_hour: { usedPercentage: 100, resetsAt: null, resetsText: null, windowMinutes: 300 },
  };
  const { sessions, resume } = build({}, stillBlocked);
  const session = sessions.add();
  const plan = block(resume, session.id);
  // The account reports a reset later than the banner promised, which is the
  // case that matters: the clock said go, the account says not yet.
  stillBlocked.five_hour.resetsAt = plan.dueAt + 4 * HOUR;

  await resume.tick(plan.dueAt + 1000);
  assert.deepEqual(sessions.writes, [], 'the banner is a suspicion, the account is the authority');
  const after = resume._plans.get(session.id);
  assert.equal(after.state, STATE.ARMED);
  assert.equal(after.dueAt, stillBlocked.five_hour.resetsAt + 60 * 1000, 're-armed on the reported reset');
});

test('a quota snapshot showing head room lets the resume through', async () => {
  const recovered = {
    five_hour: { usedPercentage: 4, resetsAt: null, resetsText: null, windowMinutes: 300 },
  };
  const { sessions, resume } = build({}, recovered);
  const session = sessions.add();
  const plan = block(resume, session.id);

  await resume.tick(plan.dueAt + 1000);
  assert.equal(sessions.writes.length, 1);
});

test('a session that keeps blocking is given up on after the attempt cap', async () => {
  const { sessions, resume } = build({ autoResumeMaxAttempts: 2, autoResumeStaggerSeconds: 0 });
  const session = sessions.add();
  let plan = block(resume, session.id);

  for (let i = 0; i < 5; i++) {
    await resume.tick(plan.dueAt + 1000 + i * 1000);
    // The block comes straight back, exactly as it would in a real terminal.
    plan = block(resume, session.id);
    }

  assert.ok(sessions.writes.length <= 2, `wrote ${sessions.writes.length} times, cap is 2`);
  await resume.tick(plan.dueAt + 100000);
  assert.equal(resume._plans.get(session.id).state, STATE.EXPIRED);
});

test('a plan that never becomes safe expires instead of waiting forever', async () => {
  const { sessions, resume } = build({ autoResumeWaitSeconds: 30 });
  const session = sessions.add({ status: STATUS.AWAITING_PERMISSION });
  const plan = block(resume, session.id);

  await resume.tick(plan.dueAt);
  await resume.tick(plan.dueAt + 31000);
  assert.equal(resume._plans.get(session.id).state, STATE.EXPIRED);
  assert.deepEqual(sessions.writes, []);
});

test('a plan with no reset time anywhere retries blind rather than firing at once', async () => {
  const { sessions, resume } = build();
  const session = sessions.add();
  const plan = block(resume, session.id, 'Claude usage limit reached.');
  assert.equal(plan.resetsAt, null);
  assert.equal(plan.dueAt, null);

  await resume.tick(T0 + 1000);
  assert.deepEqual(sessions.writes, [], 'an unknown reset must not mean "now"');
  assert.ok(resume._plans.get(session.id).dueAt > T0 + 1000, 'it backs off instead of firing');
});

test('an exited session drops its plan', async () => {
  const { sessions, resume } = build();
  const session = sessions.add();
  block(resume, session.id);
  assert.equal(resume.plans().length, 1);

  resume.start();
  sessions.emit('exit', { id: session.id });
  assert.equal(resume.plans().length, 0);
  resume.stop();
});

test('cancel stops that plan from firing', async () => {
  const { sessions, resume } = build();
  const session = sessions.add();
  const plan = block(resume, session.id);

  assert.equal(resume.cancel(session.id, T0).ok, true);
  await resume.tick(plan.dueAt + HOUR);
  assert.deepEqual(sessions.writes, []);
});

test('a cancel does not silently opt the session out forever', async () => {
  const { sessions, resume } = build();
  const session = sessions.add();
  block(resume, session.id);
  resume.cancel(session.id, T0);

  // The TUI redrawing the banner it was just cancelled on must not re-arm it.
  block(resume, session.id, BANNER, T0 + 1000);
  assert.equal(resume._plans.get(session.id).state, STATE.CANCELLED);

  // A genuinely new block hours later is a different block.
  const later = T0 + 6 * HOUR;
  const fresh = block(resume, session.id, BANNER, later);
  assert.equal(fresh.state, STATE.ARMED);
  assert.equal(fresh.attempts, 0, 'a new block after a cancel starts its own budget');

  await resume.tick(fresh.dueAt + 1000);
  assert.equal(sessions.writes.length, 1);
});

test('resume now skips the clock but not the permission check', async () => {
  const { sessions, resume } = build();
  const session = sessions.add({ status: STATUS.AWAITING_PERMISSION });
  block(resume, session.id);

  const refused = await resume.resumeNow(session.id, T0 + HOUR);
  assert.equal(refused.ok, false);
  assert.deepEqual(sessions.writes, []);

  session.status = STATUS.IDLE;
  const accepted = await resume.resumeNow(session.id, T0 + HOUR);
  assert.equal(accepted.ok, true);
  assert.equal(sessions.writes.length, 1, 'the reset was hours away and it still went');
});

test('resume now works on a session that was never detected as blocked', async () => {
  const { sessions, resume } = build();
  const session = sessions.add();
  const result = await resume.resumeNow(session.id, T0);
  assert.equal(result.ok, true);
  assert.equal(sessions.writes[0].data, 'continue\r');
});

test('resume now refuses a shell', async () => {
  const { sessions, resume } = build();
  const shell = sessions.add({ kind: KIND.SHELL });
  const result = await resume.resumeNow(shell.id, T0);
  assert.equal(result.ok, false);
  assert.deepEqual(sessions.writes, []);
});

test('the resume prompt is flattened to a single submitted line', () => {
  assert.equal(sanitizeResumeText('reprends\rrm -rf /'), 'reprends rm -rf /');
  assert.equal(sanitizeResumeText('a\nb\tc'), 'a b c');
  assert.equal(sanitizeResumeText('  padded  '), 'padded');
  assert.equal(sanitizeResumeText('   '), null);
  assert.equal(sanitizeResumeText(''), null);
  assert.equal(sanitizeResumeText(null), null);
  assert.equal(sanitizeResumeText('x'.repeat(900)).length, 500);
});

test('a prompt carrying an escape sequence cannot drive the TUI', () => {
  const esc = String.fromCharCode(27);
  const clean = sanitizeResumeText(`${esc}[2Jcontinue`);
  assert.equal(clean.includes(esc), false);
  assert.equal(clean, '[2Jcontinue');
});

test('settings are clamped, persisted, and read back', () => {
  const { resume, config } = build();
  const { settings } = resume.updateSettings({
    graceSeconds: 99999,
    staggerSeconds: -5,
    maxAttempts: 0,
    text: '  reprends  ',
  });
  assert.equal(settings.graceSeconds, 3600);
  assert.equal(settings.staggerSeconds, 0);
  assert.equal(settings.maxAttempts, 1);
  assert.equal(settings.text, 'reprends');

  const onDisk = JSON.parse(fs.readFileSync(config.autoResumeFile, 'utf-8'));
  assert.equal(onDisk.text, 'reprends');

  const reloaded = new AutoResume({ sessions: new FakeSessions(), config });
  assert.equal(reloaded.settings().text, 'reprends');
  assert.equal(reloaded.settings().graceSeconds, 3600);
});

test('it refuses to switch on with no prompt to send', () => {
  const { resume } = build({ autoResume: false });
  const { settings, error } = resume.updateSettings({ enabled: true, text: '   ' });
  assert.ok(error, 'arming with nothing to type would be a silent no-op');
  assert.equal(settings.enabled, false);
});

test('a corrupt settings file falls back to the defaults instead of throwing', () => {
  const file = tmpFile();
  fs.writeFileSync(file, '{ not json');
  const resume = new AutoResume({
    sessions: new FakeSessions(),
    config: { autoResumeFile: file, autoResumeText: 'continue' },
    logger: { warn() {}, error() {} },
  });
  assert.equal(resume.settings().text, 'continue');
  assert.equal(resume.settings().enabled, false);
});

test('plans() hands out copies, so a caller cannot mutate the scheduler', () => {
  const { sessions, resume } = build();
  const session = sessions.add();
  block(resume, session.id);
  const copy = resume.plans()[0];
  copy.state = 'tampered';
  assert.equal(resume.plans()[0].state, STATE.ARMED);
});
