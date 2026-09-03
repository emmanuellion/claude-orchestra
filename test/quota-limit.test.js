'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  detectQuotaLimit,
  appendTail,
  stripAnsi,
  flatten,
  extractReset,
  TAIL_CHARS,
} = require('../lib/quota-limit');

const ESC = String.fromCharCode(27);
const NOW = Date.parse('2026-09-04T10:00:00Z');

/** Matching a chunk the way lib/auto-resume.js does, tail and all. */
function detect(text, now = NOW) {
  return detectQuotaLimit(appendTail('', text), now);
}

test('strips CSI colour and cursor sequences', () => {
  const painted = `${ESC}[1m${ESC}[31mred${ESC}[0m`;
  assert.equal(stripAnsi(painted), 'red');
});

test('strips an OSC title sequence terminated by BEL', () => {
  const bel = String.fromCharCode(7);
  assert.equal(stripAnsi(`${ESC}]0;a title${bel}text`), 'text');
});

test('flatten folds a boxed banner into one line', () => {
  const boxed = [
    '╭──────────────────────────────╮',
    '│  Claude usage limit reached  │',
    '│  Resets at 3pm               │',
    '╰──────────────────────────────╯',
  ].join('\n');
  const flat = flatten(boxed);
  assert.match(flat, /Claude usage limit reached/);
  assert.equal(flat.includes('\n'), false);
});

test('recognises the plain banner and resolves the reset time', () => {
  const hit = detect('Claude usage limit reached. Your limit will reset at 3pm.');
  assert.ok(hit);
  assert.equal(hit.resetsText, '3pm');
  assert.ok(hit.resetsAt > NOW, 'the reset must land in the future');
});

test('reads the five hour window off the status line phrasing', () => {
  const hit = detect('5-hour limit reached ∙ resets 1:30pm');
  assert.ok(hit);
  assert.equal(hit.window, 'five_hour');
  assert.equal(hit.resetsText, '1:30pm');
});

test('reads the weekly window and a relative reset', () => {
  const hit = detect('Weekly limit reached, try again in 2 days');
  assert.ok(hit);
  assert.equal(hit.window, 'seven_day');
  // The pattern swallows the preposition, so the parser has to be retried with
  // it; without that fix this came back null and the plan never armed.
  assert.ok(hit.resetsAt > NOW);
});

test('parses an absolute ISO reset without treating the year as an hour', () => {
  const hit = detect('usage limit reached. Resets at 2026-09-04T15:00:00Z');
  assert.ok(hit);
  assert.equal(hit.resetsAt, Date.parse('2026-09-04T15:00:00Z'));
});

test('a banner split across two chunks still matches', () => {
  let tail = appendTail('', `${ESC}[31mClaude usage li`);
  assert.equal(detectQuotaLimit(tail, NOW), null);
  tail = appendTail(tail, `mit reached. Resets at 4pm.${ESC}[0m`);
  const hit = detectQuotaLimit(tail, NOW);
  assert.ok(hit, 'the rolling tail is what makes a split banner detectable');
  assert.equal(hit.resetsText, '4pm');
});

test('the warning about approaching a limit is not a block', () => {
  assert.equal(detect('You are approaching your usage limit reached threshold'), null);
  assert.equal(detect('You will reach your usage limit in about an hour'), null);
});

test('an agent explaining limits is not a block', () => {
  assert.equal(detect('How do I tell when the usage limit reached state applies?'), null);
  assert.equal(detect('What happens when usage limit reached shows up?'), null);
});

test('ordinary output never matches', () => {
  for (const line of [
    'npm install finished with 0 vulnerabilities',
    'ulimit -n 4096',
    'Running 42 tests, 0 failures',
    'const LIMIT = 10;',
  ]) {
    assert.equal(detect(line), null, `matched on: ${line}`);
  }
});

test('the tail is bounded, so a chatty session cannot grow it forever', () => {
  let tail = '';
  for (let i = 0; i < 200; i++) tail = appendTail(tail, 'x'.repeat(500));
  assert.ok(tail.length <= TAIL_CHARS, `tail grew to ${tail.length}`);
});

test('a limit far behind the newest output falls out of the window', () => {
  let tail = appendTail('', 'Claude usage limit reached. Resets at 3pm.');
  assert.ok(detectQuotaLimit(tail, NOW));
  for (let i = 0; i < 40; i++) tail = appendTail(tail, 'y'.repeat(500));
  assert.equal(detectQuotaLimit(tail, NOW), null, 'an old banner must not re-arm forever');
});

test('extractReset returns the phrase even when it cannot be parsed', () => {
  const out = extractReset('resets when the moon is right', NOW);
  assert.equal(out.resetsAt, null);
  assert.equal(out.resetsText, 'when the moon is right');
});

test('detect tolerates junk input', () => {
  assert.equal(detectQuotaLimit(null, NOW), null);
  assert.equal(detectQuotaLimit('', NOW), null);
  assert.equal(detectQuotaLimit(42, NOW), null);
});
