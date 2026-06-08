'use strict';

const os = require('os');
const path = require('path');
const fs = require('fs');

// lib/which requires lib/config, which touches ~/.claude at load time. Point
// "home" at a throwaway directory before anything pulls it in so the suite
// never writes into the real profile.
const SANDBOX_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'orchestra-which-'));
process.env.HOME = SANDBOX_HOME;
process.env.USERPROFILE = SANDBOX_HOME;
process.env.ORCHESTRA_TOKEN = 'a'.repeat(64);

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { splitArgs, needsShim, which } = require('../lib/which');

test('a flag and its value become two arguments', () => {
  assert.deepEqual(splitArgs('--model sonnet'), ['--model', 'sonnet']);
});

test('empty and blank input produce no arguments', () => {
  assert.deepEqual(splitArgs(''), []);
  assert.deepEqual(splitArgs('   '), []);
  assert.deepEqual(splitArgs(null), []);
  assert.deepEqual(splitArgs(undefined), []);
});

test('runs of whitespace collapse into a single separator', () => {
  assert.deepEqual(splitArgs('  --model    sonnet  '), ['--model', 'sonnet']);
  assert.deepEqual(splitArgs('a\tb\nc'), ['a', 'b', 'c']);
});

test('a quoted value keeps its spaces in one argument', () => {
  assert.deepEqual(
    splitArgs('--append-system-prompt "be very brief"'),
    ['--append-system-prompt', 'be very brief'],
  );
  assert.deepEqual(splitArgs("--x 'a b c'"), ['--x', 'a b c']);
});

test('quotes can open mid-token and the halves join', () => {
  assert.deepEqual(splitArgs('--path=/a" "b'), ['--path=/a b']);
});

test('an explicitly empty quoted argument survives', () => {
  assert.deepEqual(splitArgs('a "" b'), ['a', '', 'b']);
});

test('an unterminated quote still yields the argument it started', () => {
  assert.deepEqual(splitArgs('--model "sonnet'), ['--model', 'sonnet']);
  assert.deepEqual(splitArgs("--model 'son net"), ['--model', 'son net']);
});

test('a semicolon stays inside its argument instead of ending a command', () => {
  // The whole point of argv splitting: nothing here may become a second
  // command. `; whoami` must arrive at the binary as plain text.
  const args = splitArgs('--model sonnet; whoami');
  assert.deepEqual(args, ['--model', 'sonnet;', 'whoami']);
  assert.ok(args.every(a => typeof a === 'string'));
});

test('shell operators are literal characters, not separators', () => {
  assert.deepEqual(splitArgs('sonnet&&whoami'), ['sonnet&&whoami']);
  assert.deepEqual(splitArgs('a|b'), ['a|b']);
  assert.deepEqual(splitArgs('a>out.txt'), ['a>out.txt']);
  assert.deepEqual(splitArgs('$(whoami)'), ['$(whoami)']);
  assert.deepEqual(splitArgs('`whoami`'), ['`whoami`']);
});

test('a quoted injection attempt collapses into a single harmless argument', () => {
  assert.deepEqual(splitArgs('"; rm -rf ~"'), ['; rm -rf ~']);
  assert.deepEqual(
    splitArgs('--model "claude x"; rm -rf ~'),
    ['--model', 'claude x;', 'rm', '-rf', '~'],
  );
});

test('backslashes in Windows paths are preserved verbatim', () => {
  assert.deepEqual(
    splitArgs('--cwd C:\\Users\\me\\repo'),
    ['--cwd', 'C:\\Users\\me\\repo'],
  );
  assert.deepEqual(splitArgs('--cwd "C:\\Program Files\\x"'), ['--cwd', 'C:\\Program Files\\x']);
});

test('needsShim only fires for Windows batch shims', () => {
  const isWin = os.platform() === 'win32';
  assert.equal(needsShim(null), false);
  assert.equal(needsShim(''), false);
  assert.equal(needsShim('C:\\bin\\claude.exe'), false);
  assert.equal(needsShim('/usr/local/bin/claude'), false);
  assert.equal(needsShim('C:\\bin\\claude.cmd'), isWin);
  assert.equal(needsShim('C:\\bin\\claude.BAT'), isWin);
});

test('which returns null for a command that cannot exist', () => {
  assert.equal(which(''), null);
  assert.equal(which(null), null);
  assert.equal(which('orchestra-no-such-binary-9f3a'), null);
});

test('which resolves an explicit path only when it is a real file', () => {
  const file = path.join(SANDBOX_HOME, 'fake-tool');
  fs.writeFileSync(file, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  assert.equal(which(file), file);
  assert.equal(which(path.join(SANDBOX_HOME, 'missing-tool')), null);
  assert.equal(which(SANDBOX_HOME), null, 'a directory is not an executable');
});
