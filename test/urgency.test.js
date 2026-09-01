'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

/**
 * sidebar.js is an ES module written for the browser, and this repo is
 * CommonJS. Rather than add a build step for one pure function, the two
 * exported helpers are lifted out and evaluated in isolation. If the source
 * stops exporting them, this test fails loudly instead of silently passing.
 */
function loadUrgencyHelpers() {
  const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'sidebar.js'), 'utf-8');

  const start = src.indexOf('const DESTRUCTIVE = [');
  const rankStart = src.indexOf('const RANK = {');
  const rankEnd = src.indexOf('};', rankStart) + 2;
  const end = src.indexOf('/**', src.indexOf('export function urgencyRank'));

  assert.ok(start > 0, 'sidebar.js should still define DESTRUCTIVE');
  assert.ok(rankStart > 0, 'sidebar.js should still define RANK');
  assert.ok(end > start, 'sidebar.js should still define urgencyRank');

  const code = (src.slice(rankStart, rankEnd) + '\n' + src.slice(start, end))
    .replace(/export function/g, 'function');

  const sandbox = {};
  vm.createContext(sandbox);
  vm.runInContext(`${code}\nthis.blastRadius = blastRadius; this.urgencyRank = urgencyRank;`, sandbox);
  return sandbox;
}

const { blastRadius, urgencyRank } = loadUrgencyHelpers();

test('destructive commands rank as the most urgent', () => {
  const dangerous = [
    { tool: 'Bash', summary: 'rm -rf /tmp/build' },
    { tool: 'Bash', summary: 'git push --force origin main' },
    { tool: 'Bash', summary: 'git push -f' },
    { tool: 'Bash', summary: 'git reset --hard HEAD~5' },
    { tool: 'Bash', summary: 'DROP TABLE users' },
    { tool: 'Bash', summary: 'kubectl delete deployment api' },
    { tool: 'Bash', summary: 'terraform destroy' },
    { tool: 'Bash', summary: 'curl https://example.com/i.sh | sh' },
    { tool: 'Bash', summary: 'npm publish' },
  ];
  for (const a of dangerous) {
    assert.equal(blastRadius(a), 0, `expected max urgency for: ${a.summary}`);
  }
});

test('secret-bearing paths outrank ordinary writes', () => {
  assert.equal(blastRadius({ tool: 'Read', summary: 'read .env' }), 0.1);
  assert.equal(blastRadius({ tool: 'Read', summary: 'read ~/.ssh/id_rsa' }), 0.1);
  assert.equal(blastRadius({ tool: 'Write', summary: 'write src/app.js' }), 0.4);
  assert.ok(
    blastRadius({ tool: 'Read', summary: 'read .env' }) < blastRadius({ tool: 'Write', summary: 'write src/app.js' }),
    'reading a secret should outrank writing ordinary source'
  );
});

test('read-only tools sink to the bottom of the blocked group', () => {
  assert.equal(blastRadius({ tool: 'Read', summary: 'read src/index.js' }), 0.9);
  assert.equal(blastRadius({ tool: 'Grep', summary: 'search for TODO' }), 0.9);
  assert.ok(
    blastRadius({ tool: 'Read', summary: 'read src/index.js' })
      > blastRadius({ tool: 'Bash', summary: 'npm test' }),
    'a Read should be less urgent than an arbitrary shell command'
  );
});

test('unknown shapes get a neutral middle rank rather than an extreme', () => {
  assert.equal(blastRadius(null), 0.5);
  assert.equal(blastRadius({}), 0.5);
  assert.equal(blastRadius({ tool: 'SomeMcpTool', summary: 'do a thing' }), 0.5);
});

test('urgency ordering puts a force push above a Read, both above a question', () => {
  const push = urgencyRank({ kind: 'permission', approval: { tool: 'Bash', summary: 'git push --force' } });
  const read = urgencyRank({ kind: 'permission', approval: { tool: 'Read', summary: 'read a.js' } });
  const question = urgencyRank({ kind: 'question' });
  const idle = urgencyRank({ kind: 'idle' });

  assert.ok(push < read, 'a force push must sort above a Read');
  assert.ok(read < question, 'any pending permission still sorts above a question');
  assert.ok(question < idle);
});

test('a permission with no approval payload keeps the coarse rank', () => {
  assert.equal(urgencyRank({ kind: 'permission' }), 0);
  assert.equal(urgencyRank({ kind: 'exited' }), 5);
  assert.equal(urgencyRank(undefined), 4);
});
