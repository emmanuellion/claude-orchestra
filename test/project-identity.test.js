'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { PALETTE, projectLabel, colorFor, defaultNameFor } = require('../lib/project-identity');
const { KIND } = require('../lib/protocol');

test('a project label is the directory a human would name', () => {
  assert.equal(projectLabel('C:/Users/x/Documents/git/claude-orchestra'), 'claude-orchestra');
  assert.equal(projectLabel('/home/x/code/mariage'), 'mariage');
});

test('a generic leaf directory borrows its parent for context', () => {
  // "Frontend" alone is useless when three repos each have one.
  assert.equal(projectLabel('C:/git/buyandrent/Frontend'), 'buyandrent Frontend');
  assert.equal(projectLabel('/home/x/myapp/src'), 'myapp src');
  assert.equal(projectLabel('/home/x/myapp/packages'), 'myapp packages');
});

test('a meaningful leaf is left alone even under a generic parent', () => {
  assert.equal(projectLabel('/home/x/git/orchestra'), 'orchestra');
  assert.equal(projectLabel('/home/x/projects/invoicer'), 'invoicer');
});

test('project labels survive odd paths', () => {
  assert.equal(projectLabel(''), '');
  assert.equal(projectLabel(null), '');
  assert.equal(projectLabel('C:/'), '');
  assert.equal(projectLabel('/'), '');
});

test('the same directory always gets the same colour', () => {
  const a = colorFor('C:/git/thing');
  assert.equal(colorFor('C:/git/thing'), a);
  assert.equal(colorFor('C:/git/thing/'), a, 'a trailing separator must not change it');
  assert.equal(colorFor('C:/GIT/THING'), a, 'case must not change it on Windows paths');
  assert.ok(PALETTE.includes(a));
});

test('a session in a directory already on screen inherits its colour', () => {
  const live = [{ cwd: 'C:/git/thing', tagColor: 'green' }];
  // Not the hashed colour: the one its sibling already wears.
  assert.equal(colorFor('C:/git/thing', live), 'green');
  assert.equal(colorFor('C:/git/thing/', live), 'green');
});

test('different projects never share a colour while colours remain', () => {
  const paths = ['/a/one', '/a/two', '/a/three', '/a/four', '/a/five', '/a/six', '/a/seven'];
  const live = [];
  for (const p of paths) live.push({ cwd: p, tagColor: colorFor(p, live) });
  const used = new Set(live.map(s => s.tagColor));
  assert.equal(used.size, PALETTE.length, `expected ${PALETTE.length} distinct colours, got ${[...used]}`);
});

test('an eighth project reuses a colour rather than going unmarked', () => {
  const live = PALETTE.map((c, i) => ({ cwd: `/a/${i}`, tagColor: c }));
  const colour = colorFor('/a/eighth', live);
  assert.ok(PALETTE.includes(colour));
  assert.notEqual(colour, 'none');
});

test('an empty path gets no colour rather than a misleading one', () => {
  assert.equal(colorFor(''), 'none');
  assert.equal(colorFor(null), 'none');
});

test('default names describe the project, not the tool', () => {
  const cwd = 'C:/git/claude-orchestra';
  assert.equal(defaultNameFor(cwd, KIND.CLAUDE), 'claude-orchestra');
  assert.equal(defaultNameFor(cwd, KIND.SHELL), 'claude-orchestra shell');
  assert.equal(defaultNameFor(cwd, KIND.POWERSHELL), 'claude-orchestra pwsh');
});

test('a second agent in the same project is numbered, not duplicated', () => {
  const cwd = '/a/thing';
  assert.equal(defaultNameFor(cwd, KIND.CLAUDE, ['thing']), 'thing 2');
  assert.equal(defaultNameFor(cwd, KIND.CLAUDE, ['thing', 'thing 2']), 'thing 3');
});

test('with no directory the name falls back to the kind', () => {
  assert.equal(defaultNameFor('', KIND.CLAUDE), 'Claude');
  assert.equal(defaultNameFor('', KIND.SHELL), 'Shell');
  assert.equal(defaultNameFor('/', KIND.POWERSHELL), 'PowerShell');
});
