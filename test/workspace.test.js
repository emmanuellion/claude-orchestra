'use strict';

const os = require('os');
const path = require('path');
const fs = require('fs');

const SANDBOX_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'orchestra-ws-home-'));
process.env.HOME = SANDBOX_HOME;
process.env.USERPROFILE = SANDBOX_HOME;
process.env.ORCHESTRA_TOKEN = 'd'.repeat(64);

const { test } = require('node:test');
const assert = require('node:assert/strict');

const workspace = require('../lib/workspace');
const { KIND } = require('../lib/protocol');

/**
 * Contract under test:
 *   validate(raw: unknown, {baseDir, isWin}) -> {ok, errors: string[], recipe}
 *
 * `check` below also tolerates a thrown error or a `{valid}` flag, so the
 * assertions stay about which recipes get through rather than about how the
 * rejection is spelled.
 */

const VALIDATORS = ['validate', 'validateWorkspace', 'parseWorkspace', 'parse'];

const validator = VALIDATORS.map(n => workspace[n]).find(f => typeof f === 'function');

/** The repo a recipe is allowed to touch. Created once, never written into. */
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'orchestra-ws-root-'));
fs.mkdirSync(path.join(ROOT, 'server'), { recursive: true });
fs.mkdirSync(path.join(ROOT, 'web'), { recursive: true });

function check(raw, opts) {
  let result;
  try {
    result = validator(raw, Object.assign({ baseDir: ROOT }, opts));
  } catch (err) {
    return { ok: false, errors: [err.message] };
  }
  if (result === null || result === undefined || result === false) {
    return { ok: false, errors: ['validator returned nothing'] };
  }
  if (result.ok === false || result.valid === false) {
    return { ok: false, errors: result.errors || ['rejected'] };
  }
  if (Array.isArray(result.errors) && result.errors.length > 0) {
    return { ok: false, errors: result.errors };
  }
  return { ok: true, value: result };
}

/** The agents of an accepted recipe, whatever wrapper they come back in. */
function agentsOf(res) {
  const v = res.value || {};
  const list = (v.recipe && v.recipe.agents) || v.agents || (v.workspace && v.workspace.agents);
  assert.ok(Array.isArray(list), 'an accepted recipe must expose its agents');
  return list;
}

function agent(over) {
  return Object.assign({ name: 'Backend', kind: KIND.CLAUDE, cwd: 'server' }, over);
}

function recipe(over) {
  return Object.assign({ version: 1, name: 'demo', agents: [agent()] }, over);
}

test('lib/workspace exposes a validator', () => {
  assert.equal(
    typeof validator,
    'function',
    `lib/workspace must export one of: ${VALIDATORS.join(', ')}`,
  );
});

test('a well formed recipe is accepted', () => {
  const res = check(recipe({
    agents: [
      agent({ name: 'Backend', kind: KIND.CLAUDE, cwd: 'server', args: '--model sonnet' }),
      agent({ name: 'Frontend', kind: KIND.CLAUDE, cwd: 'web', prompt: 'Fix the header' }),
      agent({ name: 'Logs', kind: KIND.SHELL, cwd: '.' }),
    ],
  }));
  assert.equal(res.ok, true, `expected acceptance, got: ${JSON.stringify(res.errors)}`);
});

test('a recipe with a single minimal agent is accepted', () => {
  const res = check({ agents: [{ name: 'Solo', kind: KIND.CLAUDE }] });
  assert.equal(res.ok, true, `expected acceptance, got: ${JSON.stringify(res.errors)}`);
});

test('every kind the protocol declares is accepted', () => {
  for (const kind of Object.values(KIND)) {
    const res = check(recipe({ agents: [agent({ kind })] }));
    assert.equal(res.ok, true, `kind "${kind}" should be valid: ${JSON.stringify(res.errors)}`);
  }
});

test('an unknown kind is rejected', () => {
  for (const kind of ['bash', 'node', 'zsh', 'CLAUDE', 42, true, {}, ['claude']]) {
    const res = check(recipe({ agents: [agent({ kind })] }));
    assert.equal(res.ok, false, `kind ${JSON.stringify(kind)} must be rejected`);
  }
});

test('an omitted kind falls back to claude rather than to a shell', () => {
  // The fallback has to be the safe, expected one: a recipe that forgets the
  // field must not silently open a raw shell.
  for (const raw of [{ name: 'A' }, { name: 'A', kind: null }, { name: 'A', kind: '' }]) {
    const res = check({ agents: [raw] });
    assert.equal(res.ok, true, `${JSON.stringify(raw)} should be accepted`);
    assert.equal(agentsOf(res)[0].kind, KIND.CLAUDE);
  }
});

test('a cwd that escapes the repo is rejected', () => {
  // A recipe is checked into the repo it describes, so it may be authored by
  // whoever opened a pull request. It must not be able to point an agent at the
  // home directory.
  const escapes = ['../..', '../../etc', 'server/../../..', './../outside'];
  if (process.platform === 'win32') escapes.push('..\\..\\Windows');
  for (const cwd of escapes) {
    const res = check(recipe({ agents: [agent({ cwd })] }));
    assert.equal(res.ok, false, `cwd ${JSON.stringify(cwd)} must be rejected`);
  }
});

test('an absolute cwd is rejected', () => {
  const outside = path.join(os.tmpdir(), 'orchestra-not-the-repo');
  assert.equal(check(recipe({ agents: [agent({ cwd: outside })] })).ok, false);
  assert.equal(check(recipe({ agents: [agent({ cwd: '/etc' })] })).ok, false);
  if (process.platform === 'win32') {
    assert.equal(check(recipe({ agents: [agent({ cwd: 'C:\\Windows' })] })).ok, false);
  }
});

test('a relative cwd inside the repo is accepted', () => {
  assert.equal(check(recipe({ agents: [agent({ cwd: 'server' })] })).ok, true);
  assert.equal(check(recipe({ agents: [agent({ cwd: './server' })] })).ok, true);
  assert.equal(check(recipe({ agents: [agent({ cwd: '.' })] })).ok, true);
});

test('twelve agents are allowed and thirteen are not', () => {
  const twelve = Array.from({ length: 12 }, (_, i) => agent({ name: `A${i}` }));
  assert.equal(
    check(recipe({ agents: twelve })).ok,
    true,
    'twelve is the documented ceiling and must still pass',
  );

  const thirteen = Array.from({ length: 13 }, (_, i) => agent({ name: `A${i}` }));
  assert.equal(check(recipe({ agents: thirteen })).ok, false);

  const many = Array.from({ length: 500 }, (_, i) => agent({ name: `A${i}` }));
  assert.equal(check(recipe({ agents: many })).ok, false);
});

test('a recipe with no agents at all is rejected', () => {
  assert.equal(check({ version: 1, name: 'demo' }).ok, false, 'missing agents');
  assert.equal(check(recipe({ agents: [] })).ok, false, 'empty agents');
  assert.equal(check(recipe({ agents: {} })).ok, false, 'agents must be an array');
  assert.equal(check(recipe({ agents: 'claude' })).ok, false);
});

test('an unsupported schema version is rejected', () => {
  assert.equal(check(recipe({ version: 2 })).ok, false);
  assert.equal(check(recipe({ version: '1' })).ok, false);
  assert.equal(check(recipe({ version: undefined })).ok, true, 'version is optional');
});

test('a recipe that is not an object is rejected', () => {
  for (const bad of [null, undefined, '', 'agents', 42, []]) {
    assert.equal(check(bad).ok, false, `${JSON.stringify(bad)} must be rejected`);
  }
});

test('fields of the wrong type are rejected', () => {
  // A recipe is untrusted input that ends up in the session list and therefore
  // in the DOM, so a number where a name belongs has to be refused here.
  assert.equal(check(recipe({ agents: [agent({ name: 42 })] })).ok, false);
  assert.equal(check(recipe({ agents: [agent({ cwd: 7 })] })).ok, false);
  assert.equal(check(recipe({ agents: [null] })).ok, false);
  assert.equal(check(recipe({ agents: ['claude'] })).ok, false);
});

test('validation never writes to disk', () => {
  const before = fs.readdirSync(ROOT).sort();
  check(recipe());
  check(recipe({ agents: [agent({ cwd: '../..' })] }));
  assert.deepEqual(fs.readdirSync(ROOT).sort(), before);
});
