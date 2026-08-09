'use strict';

const os = require('os');
const path = require('path');
const fs = require('fs');

const SANDBOX_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'orchestra-usage-'));
process.env.HOME = SANDBOX_HOME;
process.env.USERPROFILE = SANDBOX_HOME;
process.env.ORCHESTRA_TOKEN = 'c'.repeat(64);

const { test } = require('node:test');
const assert = require('node:assert/strict');

const usage = require('../lib/usage-parser');

/**
 * Contract under test:
 *   parseResetTime(text: string, nowMs: number) -> number|null   epoch ms
 *   normalizeRateLimit(payload: object) -> object|null
 *
 * The reset timestamp on the normalized object is read through `resetMs` below
 * so the field can be named `resetsAt` or `resetAt` and hold either epoch ms or
 * a Date: those are presentation choices. The unit conversion it encodes is
 * not, and that is what these tests pin down.
 */

const HOUR = 3600 * 1000;
const DAY = 24 * HOUR;

function parse(text, now) {
  const nowMs = now instanceof Date ? now.getTime() : now;
  const out = usage.parseResetTime(text, nowMs);
  if (out === null || out === undefined) return null;
  if (out instanceof Date) return out.getTime();
  assert.equal(typeof out, 'number', `parseResetTime(${JSON.stringify(text)}) must return epoch ms or null`);
  assert.ok(Number.isFinite(out), `parseResetTime(${JSON.stringify(text)}) returned ${out}`);
  return out;
}

function resetMs(normalized) {
  assert.ok(normalized && typeof normalized === 'object', 'normalizeRateLimit must return an object');
  const raw = normalized.resetsAt !== undefined ? normalized.resetsAt
    : normalized.resetAt !== undefined ? normalized.resetAt
      : normalized.resets_at;
  if (raw === null || raw === undefined) return null;
  if (raw instanceof Date) return raw.getTime();
  return raw;
}

test('a wall clock time resolves to that time today, not to a duration', () => {
  // The v1 bug: "Resets 10:30am" was read as "10 hours 30 minutes from now",
  // so the quota bar claimed a reset 30 hours away when it was 90 minutes away.
  const now = new Date(2026, 0, 15, 8, 0, 0, 0);
  const at = parse('Resets 10:30am', now);
  assert.ok(at !== null, '"Resets 10:30am" must be recognised');

  const d = new Date(at);
  assert.equal(d.getFullYear(), 2026);
  assert.equal(d.getMonth(), 0);
  assert.equal(d.getDate(), 15, 'still today, the time has not passed yet');
  assert.equal(d.getHours(), 10);
  assert.equal(d.getMinutes(), 30);

  const delta = at - now.getTime();
  assert.equal(delta, 2.5 * HOUR);
  assert.ok(delta < 26 * HOUR, 'must never be read as a 10h30 offset from now');
});

test('a wall clock time already past today rolls to tomorrow', () => {
  const now = new Date(2026, 0, 15, 12, 0, 0, 0);
  const at = parse('Resets 10:30am', now);
  assert.ok(at !== null);

  const d = new Date(at);
  assert.equal(d.getDate(), 16, 'the next 10:30am is tomorrow');
  assert.equal(d.getHours(), 10);
  assert.equal(d.getMinutes(), 30);
  assert.ok(at > now.getTime(), 'a reset time is always in the future');
  assert.ok(at - now.getTime() < DAY);
});

test('an hour without minutes is understood', () => {
  const now = new Date(2026, 0, 15, 9, 0, 0, 0);
  const at = parse('3pm', now);
  assert.ok(at !== null, '"3pm" must be recognised');

  const d = new Date(at);
  assert.equal(d.getDate(), 15);
  assert.equal(d.getHours(), 15);
  assert.equal(d.getMinutes(), 0);
});

test('noon and midnight are not off by twelve hours', () => {
  const now = new Date(2026, 0, 15, 6, 0, 0, 0);
  const noon = parse('Resets 12pm', now);
  assert.ok(noon !== null);
  assert.equal(new Date(noon).getHours(), 12);

  const midnight = parse('Resets 12am', now);
  assert.ok(midnight !== null);
  assert.equal(new Date(midnight).getHours(), 0);
  assert.ok(midnight > now.getTime(), 'the next midnight is tomorrow, not this morning');
});

test('a calendar date resolves to the next such date', () => {
  const now = new Date(2026, 0, 10, 9, 0, 0, 0);
  const at = parse('Jan 15', now);
  assert.ok(at !== null, '"Jan 15" must be recognised');

  const d = new Date(at);
  assert.equal(d.getMonth(), 0);
  assert.equal(d.getDate(), 15);
  assert.ok(at > now.getTime());
  assert.ok(at - now.getTime() < 366 * DAY);
});

test('a weekday name resolves to the next occurrence of that weekday', () => {
  // 2026-01-15 is a Thursday, so the next Monday is 2026-01-19.
  const now = new Date(2026, 0, 15, 9, 0, 0, 0);
  const at = parse('Mon', now);
  assert.ok(at !== null, '"Mon" must be recognised');

  const d = new Date(at);
  assert.equal(d.getDay(), 1, 'must land on a Monday');
  assert.ok(at > now.getTime());
  assert.ok(at - now.getTime() <= 7 * DAY);
});

test('a relative duration is added to now', () => {
  const now = new Date(2026, 0, 15, 9, 0, 0, 0);
  const at = parse('in 2 hours', now);
  assert.ok(at !== null, '"in 2 hours" must be recognised');
  assert.ok(
    Math.abs(at - (now.getTime() + 2 * HOUR)) < 60 * 1000,
    `expected about two hours out, got ${(at - now.getTime()) / HOUR}h`,
  );

  const minutes = parse('in 45 minutes', now);
  if (minutes !== null) {
    assert.ok(Math.abs(minutes - (now.getTime() + 45 * 60 * 1000)) < 60 * 1000);
  }
});

test('unrecognised text yields null rather than a bogus timestamp', () => {
  const now = new Date(2026, 0, 15, 9, 0, 0, 0);
  for (const bad of ['', '   ', 'banana', 'Resets', 'soon', '??', null, undefined]) {
    assert.equal(
      parse(bad, now),
      null,
      `${JSON.stringify(bad)} must not be turned into a timestamp`,
    );
  }
});

test('parseResetTime does not mutate or depend on the ambient clock', () => {
  const now = new Date(2026, 0, 15, 8, 0, 0, 0);
  const first = parse('Resets 10:30am', now);
  const second = parse('Resets 10:30am', now);
  assert.equal(first, second, 'same input, same answer');
  assert.equal(now.getHours(), 8, 'the caller\'s Date must not be mutated');
});

test('normalizeRateLimit reads resets_at given in seconds', () => {
  const expected = Date.UTC(2026, 0, 15, 10, 30, 0);
  const out = usage.normalizeRateLimit({ resets_at: expected / 1000 });
  assert.equal(resetMs(out), expected, 'a ten digit epoch is seconds and must be scaled up');
});

test('normalizeRateLimit reads resets_at given in milliseconds', () => {
  const expected = Date.UTC(2026, 0, 15, 10, 30, 0);
  const out = usage.normalizeRateLimit({ resets_at: expected });
  assert.equal(resetMs(out), expected, 'a thirteen digit epoch is already ms and must be left alone');
});

test('normalizeRateLimit reads resets_at given as an ISO string', () => {
  const expected = Date.UTC(2026, 0, 15, 10, 30, 0);
  const out = usage.normalizeRateLimit({ resets_at: new Date(expected).toISOString() });
  assert.equal(resetMs(out), expected);
});

test('the three resets_at spellings agree with each other', () => {
  const expected = Date.UTC(2026, 5, 1, 0, 0, 0);
  const seconds = resetMs(usage.normalizeRateLimit({ resets_at: expected / 1000 }));
  const millis = resetMs(usage.normalizeRateLimit({ resets_at: expected }));
  const iso = resetMs(usage.normalizeRateLimit({ resets_at: new Date(expected).toISOString() }));
  assert.equal(seconds, expected);
  assert.equal(millis, expected);
  assert.equal(iso, expected);
});

test('a missing or unparseable resets_at yields no timestamp, never NaN', () => {
  for (const payload of [{}, { resets_at: null }, { resets_at: 'sometime' }, { resets_at: 0 }]) {
    const out = usage.normalizeRateLimit(payload);
    if (out === null || out === undefined) continue;
    const ms = resetMs(out);
    assert.ok(
      ms === null || ms === undefined,
      `${JSON.stringify(payload)} produced ${ms}`,
    );
  }
});

test('normalizeRateLimit survives junk input without throwing', () => {
  for (const bad of [null, undefined, 'nope', 42, []]) {
    assert.doesNotThrow(() => usage.normalizeRateLimit(bad), `input ${JSON.stringify(bad)}`);
  }
});
