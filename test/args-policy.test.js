'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { checkArgs } = require('../lib/args-policy');
const { splitArgs } = require('../lib/which');

const check = (args, trust = 'trusted') => checkArgs(args, splitArgs(args), trust);

test('ordinary claude flags are accepted', () => {
  for (const args of ['', '--model sonnet', '--model opus --verbose', '--resume abc-123']) {
    const r = check(args);
    assert.equal(r.ok, true, `should accept: ${args}`);
    assert.deepEqual(r.warnings, []);
  }
});

test('cmd.exe metacharacters are refused, closing the Windows shim injection', () => {
  // These are the exact shapes the review reproduced into a real RCE.
  const attacks = [
    '--model sonnet & echo PWNED>C:\\tmp\\proof.txt',
    '--model sonnet | echo OWNED>proof.txt',
    '--model sonnet && calc.exe',
    '--model sonnet ^& whoami',
    '--model sonnet > out.txt',
    '--model sonnet %COMSPEC%',
    '--model sonnet\n& powershell -enc AAAA',
  ];
  for (const args of attacks) {
    const r = check(args);
    assert.equal(r.ok, false, `should have been refused: ${JSON.stringify(args)}`);
    assert.match(r.reason, /metacharacter/i);
  }
});

test('an untrusted recipe cannot disable the permission model', () => {
  const bypasses = [
    '--dangerously-skip-permissions',
    '--model sonnet --dangerously-skip-permissions',
    '--permission-mode bypassPermissions',
    '--permission-mode=bypassPermissions',
    '--permission-prompts none',
  ];
  for (const args of bypasses) {
    const r = check(args, 'untrusted');
    assert.equal(r.ok, false, `recipe should not be allowed: ${args}`);
    assert.match(r.reason, /permission model/i);
  }
});

test('a local operator may still bypass, but is warned', () => {
  const r = check('--dangerously-skip-permissions', 'trusted');
  assert.equal(r.ok, true, 'the person at the keyboard keeps the choice');
  assert.equal(r.warnings.length, 1);
  assert.match(r.warnings[0], /approvals will not fire/i);
});

test('a restrictive permission mode is not treated as a bypass', () => {
  for (const args of ['--permission-mode plan', '--permission-mode=plan']) {
    const r = check(args, 'untrusted');
    assert.equal(r.ok, true, `plan mode restricts, it does not bypass: ${args}`);
    assert.deepEqual(r.warnings, []);
  }
});

test('splitArgs keeps an injection inside one argument rather than creating a command', () => {
  // Even if checkArgs were bypassed, the splitter must not help an attacker by
  // turning `;` or `&&` into argument boundaries.
  const parts = splitArgs('--model "sonnet; rm -rf ~"');
  assert.equal(parts.length, 2);
  assert.equal(parts[1], 'sonnet; rm -rf ~');
});
