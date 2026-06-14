'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { RingBuffer } = require('../lib/ring-buffer');

test('append returns the running sequence and since(0) replays everything', () => {
  const rb = new RingBuffer(1024);
  assert.equal(rb.seq, 0);
  assert.equal(rb.append('hello'), 5);
  assert.equal(rb.append(' world'), 11);

  const all = rb.since(0);
  assert.equal(all.data, 'hello world');
  assert.equal(all.seq, 11);
  assert.equal(all.truncated, false);
});

test('since(n) returns only the tail after n', () => {
  const rb = new RingBuffer(1024);
  rb.append('abcdef');
  const tail = rb.since(2);
  assert.equal(tail.data, 'cdef');
  assert.equal(tail.seq, 6);
  assert.equal(tail.truncated, false);
});

test('since(seq) at the current sequence returns nothing', () => {
  const rb = new RingBuffer(1024);
  rb.append('abcdef');
  const nothing = rb.since(rb.seq);
  assert.equal(nothing.data, '');
  assert.equal(nothing.seq, 6);
  assert.equal(nothing.truncated, false);
});

test('since(seq) beyond the current sequence still returns nothing', () => {
  const rb = new RingBuffer(1024);
  rb.append('abcdef');
  const ahead = rb.since(999);
  assert.equal(ahead.data, '');
  assert.equal(ahead.seq, 6);
  assert.equal(ahead.truncated, false);
});

test('appending an empty chunk is a no-op', () => {
  const rb = new RingBuffer(1024);
  rb.append('abc');
  assert.equal(rb.append(''), 3);
  assert.equal(rb.chunks.length, 1);
  assert.equal(rb.since(0).data, 'abc');
});

test('a full replay is never flagged truncated, even after eviction', () => {
  const rb = new RingBuffer(10);
  rb.append('aaaa');
  rb.append('bbbb');
  rb.append('cccc');

  assert.equal(rb.seq, 12);
  assert.equal(rb.dropped, 4, 'the oldest chunk should have been evicted');

  // A client with no history asks for everything the buffer still has. It has
  // nothing to redraw over, so this must not be reported as a gap.
  const full = rb.since(0);
  assert.equal(full.data, 'bbbbcccc');
  assert.equal(full.seq, 12);
  assert.equal(full.truncated, false);
});

test('truncated is true only when the caller asks for evicted bytes', () => {
  const rb = new RingBuffer(10);
  rb.append('aaaa');
  rb.append('bbbb');
  rb.append('cccc');

  const stale = rb.since(2);
  assert.equal(stale.truncated, true, 'seq 2 aged out, the client must clear');
  assert.equal(stale.data, 'bbbbcccc');

  const exactlyAtBoundary = rb.since(4);
  assert.equal(exactlyAtBoundary.truncated, false, 'seq 4 is the first byte still held');
  assert.equal(exactlyAtBoundary.data, 'bbbbcccc');

  const fresh = rb.since(8);
  assert.equal(fresh.truncated, false);
  assert.equal(fresh.data, 'cccc');
});

test('a single chunk larger than the cap is shrunk to the cap', () => {
  const rb = new RingBuffer(10);
  rb.append('x'.repeat(25));

  assert.equal(rb.seq, 25);
  assert.equal(rb.size, 10, 'one noisy write must not pin the buffer above its limit');
  assert.equal(rb.dropped, 15);
  assert.equal(rb.chunks.length, 1);

  const full = rb.since(0);
  assert.equal(full.data, 'x'.repeat(10));
  assert.equal(full.seq, 25);
  assert.equal(full.truncated, false);

  assert.equal(rb.since(10).truncated, true);
  assert.equal(rb.since(20).data, 'x'.repeat(5));
  assert.equal(rb.since(20).truncated, false);
});

test('the retained size stays under the cap across many writes', () => {
  const rb = new RingBuffer(64);
  for (let i = 0; i < 200; i++) rb.append(`chunk-${i};`);
  assert.ok(rb.size <= 64, `size ${rb.size} should stay within the cap`);
  assert.equal(rb.since(0).data.length, rb.size);
  assert.equal(rb.seq, rb.dropped + rb.size);
});

test('sequence numbers are monotonic and count characters', () => {
  const rb = new RingBuffer(16);
  let previous = 0;
  const writes = ['a', 'bb', 'ccc', 'dddddddddddddddddddd', 'e'];
  let total = 0;
  for (const w of writes) {
    const seq = rb.append(w);
    total += w.length;
    assert.ok(seq > previous, 'seq must never go backwards');
    assert.equal(seq, total, 'seq counts every character ever written');
    previous = seq;
  }
});

test('a negative or missing sinceSeq is treated as a full replay', () => {
  const rb = new RingBuffer(1024);
  rb.append('abc');
  assert.equal(rb.since(-1).data, 'abc');
  assert.equal(rb.since(-1).truncated, false);
  assert.equal(rb.since().data, 'abc');
  assert.equal(rb.since(NaN).data, 'abc');
  assert.equal(rb.since(undefined).truncated, false);
});

test('clear empties the retained data but keeps the sequence', () => {
  const rb = new RingBuffer(1024);
  rb.append('abcdef');
  rb.clear();
  assert.equal(rb.size, 0);
  assert.equal(rb.since(0).data, '');
  assert.equal(rb.seq, 6, 'clearing the screen must not rewind the wire sequence');
});
