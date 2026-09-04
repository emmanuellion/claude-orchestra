'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { Digest } = require('../lib/digest');
const { STATUS, HOOK_EVENT } = require('../lib/protocol');

const NOW = Date.now();
const HOUR = 3600e3;

function fakeSessions(list) {
  return {
    list: () => list,
    get: id => list.find(s => s.id === id) || null,
  };
}

function session(patch = {}) {
  return {
    id: 'a',
    name: 'api worker',
    project: 'api',
    cwd: '/srv/api',
    status: STATUS.IDLE,
    locked: false,
    createdAt: NOW - 2 * HOUR,
    exitedAt: null,
    exitCode: null,
    agent: { cost: 0, lastQuestion: null },
    ...patch,
  };
}

function fakeBus(events) {
  return { timeline: async () => events };
}

function ev(patch) {
  return { ts: NOW - HOUR, event: HOOK_EVENT.POST_TOOL_USE, ok: true, ...patch };
}

test('an empty window says so rather than inventing activity', async () => {
  const digest = new Digest({ sessions: fakeSessions([]), hookBus: fakeBus([]) });
  const out = await digest.build({ since: NOW - HOUR });

  assert.equal(out.work.turns, 0);
  assert.deepEqual(out.highlights, ['Nothing happened while you were away.']);
});

test('turns, tool calls and failures are counted from the timeline', async () => {
  const events = [
    ev({ event: HOOK_EVENT.USER_PROMPT_SUBMIT }),
    ev({ event: HOOK_EVENT.USER_PROMPT_SUBMIT }),
    ev({ tool: 'Read', durationMs: 100 }),
    ev({ tool: 'Read', durationMs: 150 }),
    ev({ tool: 'Bash', ok: false, durationMs: 900 }),
    ev({ event: HOOK_EVENT.SUBAGENT_STOP }),
  ];
  const digest = new Digest({ sessions: fakeSessions([]), hookBus: fakeBus(events) });
  const out = await digest.build({ since: NOW - 2 * HOUR });

  assert.equal(out.work.turns, 2);
  assert.equal(out.work.toolCalls, 3);
  assert.equal(out.work.toolFailures, 1);
  assert.equal(out.work.subagents, 1);
  assert.equal(out.work.topTools[0].tool, 'Read');
  assert.equal(out.work.topTools[0].count, 2);
  assert.equal(out.work.topTools[1].failures, 1);
});

test('events outside the window are excluded', async () => {
  const events = [
    ev({ ts: NOW - 10 * HOUR, event: HOOK_EVENT.USER_PROMPT_SUBMIT }),
    ev({ ts: NOW - 30e3, event: HOOK_EVENT.USER_PROMPT_SUBMIT }),
  ];
  const digest = new Digest({ sessions: fakeSessions([]), hookBus: fakeBus(events) });
  const out = await digest.build({ since: NOW - HOUR });
  assert.equal(out.work.turns, 1);
});

test('pending approvals lead the summary, because they block an agent', async () => {
  const approvals = {
    pending: () => [
      { id: 'r1', sessionId: 'a', sessionName: 'api worker', tool: 'Bash', summary: 'rm -rf build', createdAt: NOW - 5 * 60e3 },
      { id: 'r2', sessionId: 'b', sessionName: 'web', tool: 'Write', summary: 'index.js', createdAt: NOW - 60e3 },
    ],
  };
  const digest = new Digest({ sessions: fakeSessions([]), hookBus: fakeBus([]), approvals });
  const out = await digest.build({ since: NOW - HOUR });

  assert.equal(out.attention.pendingApprovals.length, 2);
  assert.match(out.highlights[0], /2 permission requests waiting/);
  assert.match(out.highlights[0], /api worker/, 'the oldest is the one worth naming');
});

test('a question that stopped an agent is reported', async () => {
  const sessions = fakeSessions([
    session({ status: STATUS.AWAITING_INPUT, agent: { cost: 0, lastQuestion: 'Which database?' } }),
  ]);
  const digest = new Digest({ sessions, hookBus: fakeBus([]) });
  const out = await digest.build({ since: NOW - HOUR });

  assert.equal(out.attention.questions.length, 1);
  assert.equal(out.attention.questions[0].question, 'Which database?');
});

test('quota blocks, resumes and give-ups each get their own line', async () => {
  const autoResume = {
    plans: () => [
      { sessionId: 'a', name: 'api worker', state: 'armed', resetsAt: NOW + HOUR, resetsText: '3pm' },
      { sessionId: 'b', name: 'web', state: 'sent', lastSentAt: NOW - 20 * 60e3, attempts: 1 },
      { sessionId: 'c', name: 'docs', state: 'expired', lastError: 'never became safe' },
    ],
  };
  const digest = new Digest({ sessions: fakeSessions([]), hookBus: fakeBus([]), autoResume });
  const out = await digest.build({ since: NOW - HOUR });

  assert.equal(out.attention.quotaBlocked.length, 1);
  assert.equal(out.attention.resumed.length, 1);
  assert.equal(out.attention.giveUps.length, 1);
  const text = out.highlights.join(' ');
  assert.match(text, /waiting on a quota reset/);
  assert.match(text, /resumed automatically/);
  assert.match(text, /could not be resumed/);
});

test('a budget lock is surfaced with the fact that it locked', async () => {
  const budget = {
    state: () => ({ breaches: [{ sessionId: 'a', name: 'api worker', scope: 'session', cap: 5, spent: 5.2, locked: true, at: NOW }] }),
    todayTotal: () => 5.2,
    history: () => [{ day: '2026-09-04', total: 5.2 }],
  };
  const digest = new Digest({ sessions: fakeSessions([]), hookBus: fakeBus([]), budget });
  const out = await digest.build({ since: NOW - HOUR });

  assert.equal(out.attention.budgetBreaches.length, 1);
  assert.match(out.highlights.join(' '), /1 budget cap reached, 1 session locked/);
});

test('cost is totalled and attributed', async () => {
  const sessions = fakeSessions([
    session({ id: 'a', name: 'api', agent: { cost: 2.5 } }),
    session({ id: 'b', name: 'web', agent: { cost: 1.25 } }),
    session({ id: 'c', name: 'idle', agent: { cost: 0 } }),
  ]);
  const digest = new Digest({ sessions, hookBus: fakeBus([]) });
  const out = await digest.build({ since: NOW - HOUR });

  assert.equal(out.cost.total, 3.75);
  assert.equal(out.cost.bySession.length, 2, 'a session that cost nothing is not a line item');
  assert.equal(out.cost.bySession[0].name, 'api');
  assert.match(out.highlights.join(' '), /\$3\.75/);
});

test('sessions that ended in the window are named, not just counted', async () => {
  const sessions = fakeSessions([
    session({ id: 'a', name: 'crashed', status: STATUS.EXITED, exitedAt: NOW - 30 * 60e3, exitCode: 1 }),
    session({ id: 'b', name: 'clean', status: STATUS.EXITED, exitedAt: NOW - 20 * 60e3, exitCode: 0 }),
    session({ id: 'c', name: 'old', status: STATUS.EXITED, exitedAt: NOW - 40 * HOUR, exitCode: 0 }),
  ]);
  const digest = new Digest({ sessions, hookBus: fakeBus([]) });
  const out = await digest.build({ since: NOW - HOUR });

  assert.equal(out.sessions.exitedInWindow, 2, 'the one from two days ago is not news');
  assert.deepEqual(out.sessions.exited.map(s => s.name).sort(), ['clean', 'crashed']);
  assert.match(out.highlights.join(' '), /1 with a non-zero exit code/);
});

test('a timeline that cannot be read degrades instead of failing', async () => {
  const hookBus = { timeline: async () => { throw new Error('disk gone'); } };
  const digest = new Digest({ sessions: fakeSessions([]), hookBus, logger: { warn() {} } });
  const out = await digest.build({ since: NOW - HOUR });

  assert.equal(out.work.turns, 0);
  assert.ok(Array.isArray(out.highlights), 'a broken timeline must still produce a digest');
});

test('the default window is used when the caller gives no range', async () => {
  const digest = new Digest({ sessions: fakeSessions([]), hookBus: fakeBus([]) });
  const out = await digest.build();
  assert.equal(out.windowMs, 12 * HOUR);
  assert.ok(out.since < out.until);
});
