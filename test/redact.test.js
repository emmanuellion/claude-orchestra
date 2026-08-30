'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { redact, redactDeep, isSecretFile, REDACTED } = require('../lib/redact');

test('named secret assignments keep their shape and lose their value', () => {
  const cases = [
    'export STRIPE_SECRET=sk_live_abcdef1234567890',
    'AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMIK7MDENGbPxRfiCYEXAMPLEKEY',
    'DB_PASSWORD="hunter2hunter2"',
    "API_KEY: 'abc123def456ghi'",
    'GITHUB_TOKEN=ghp_0123456789abcdefghijklmnopqrstuvwxyz',
  ];
  for (const input of cases) {
    const out = redact(input);
    assert.ok(out.includes(REDACTED), `expected redaction in: ${input}`);
    assert.ok(!/hunter2|sk_live_abcdef|wJalrXUtn|abc123def456|0123456789abcdef/.test(out),
      `secret survived redaction: ${out}`);
  }
});

test('the variable name survives so the log stays readable', () => {
  const out = redact('export STRIPE_SECRET=sk_live_abcdef1234567890');
  assert.ok(out.includes('STRIPE_SECRET'), 'the name must survive');
  assert.ok(out.startsWith('export '), 'the command shape must survive');
});

test('provider key formats are caught even without a name in front', () => {
  const bare = [
    'curl -H "x: sk-proj-AAAAAAAAAAAAAAAAAAAAAAAA" https://api.example.com',
    'token ghp_abcdefghijklmnopqrstuvwxyz0123456789',
    'AKIAIOSFODNN7EXAMPLE',
    'xoxb-1234567890-abcdefghijkl',
  ];
  for (const input of bare) {
    assert.ok(redact(input).includes(REDACTED), `not redacted: ${input}`);
  }
});

test('authorization headers and URL credentials are redacted', () => {
  // Asserting only that REDACTED appears is what let a real leak through: the
  // rule matched the scheme word and left the token beside it. Every case here
  // asserts the secret is GONE.
  const header = redact('curl -H "Authorization: Bearer sup3rs3cr3ttoken0987654321" https://api.internal/x');
  assert.ok(header.includes(REDACTED), header);
  assert.ok(!header.includes('sup3rs3cr3ttoken0987654321'), `token survived: ${header}`);
  assert.ok(header.includes('Authorization'), 'the header name should survive');

  for (const scheme of ['Bearer', 'Basic', 'Token', '']) {
    const line = redact(`Authorization: ${scheme} s3cr3tvalue123456`.replace(/\s+/g, ' '));
    assert.ok(!line.includes('s3cr3tvalue123456'), `survived with scheme "${scheme}": ${line}`);
  }
  assert.ok(redact('Authorization: Bearer eyJhbGciOiJIUzI1NiJ9').includes(REDACTED));
  const url = redact('git clone https://user:s3cr3tpass@github.com/x/y.git');
  assert.ok(url.includes(REDACTED));
  assert.ok(!url.includes('s3cr3tpass'));
  assert.ok(url.includes('user:'), 'the username is not a secret and should survive');
});

test('a JWT is redacted wherever it appears', () => {
  const out = redact('cookie=eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1gFWFOEjXk');
  assert.ok(out.includes(REDACTED));
});

test('ordinary commands are left completely alone', () => {
  const harmless = [
    'npm test -- --watch',
    'git status --short',
    'rm -rf node_modules',
    'echo hello world',
    'SELECT * FROM users WHERE id = 3',
    // "author" contains "auth"; redacting commit authors made the timeline
    // both wrong and less useful.
    'git commit --author: Jane Doe',
    'author: jane@example.com',
    'src/authentication.js',
    'read the password policy document',
  ];
  for (const input of harmless) {
    assert.equal(redact(input), input, `should not have been touched: ${input}`);
  }
});

test('redactDeep walks nested structures and arrays', () => {
  const out = redactDeep({
    tool: 'Bash',
    input: { command: 'export TOKEN=ghp_abcdefghijklmnopqrstuvwxyz012345 && deploy' },
    history: [{ cmd: 'PASSWORD=letmein psql' }],
  });
  assert.ok(out.input.command.includes(REDACTED));
  assert.ok(!out.input.command.includes('ghp_abcdef'));
  assert.ok(out.input.command.includes('&& deploy'), 'the rest of the command survives');
  assert.ok(out.history[0].cmd.includes(REDACTED));
  assert.equal(out.tool, 'Bash');
});

test('content written into a credential file is dropped entirely', () => {
  const out = redactDeep({ file_path: '/app/.env', content: 'PLAIN=value\nOTHER=thing' });
  assert.equal(out.content, REDACTED);
  assert.equal(out.file_path, '/app/.env', 'the path itself stays, only the body goes');
});

test('redactDeep survives cycles and truncates very long strings', () => {
  const cyclic = { name: 'x' };
  cyclic.self = cyclic;
  assert.equal(redactDeep(cyclic).self, '[circular]');

  const long = redactDeep({ blob: 'a'.repeat(20000) }, { maxString: 100 });
  assert.ok(long.blob.length < 200);
  assert.ok(long.blob.endsWith('[...]'));
});

test('isSecretFile recognises the usual credential stores', () => {
  for (const p of ['.env', '/app/.env', 'C:\\x\\.npmrc', '~/.ssh/id_rsa', '/home/u/.aws/credentials', 'server.pem']) {
    assert.equal(isSecretFile(p), true, `should be secret: ${p}`);
  }
  for (const p of ['src/index.js', 'README.md', 'environment.ts']) {
    assert.equal(isSecretFile(p), false, `should not be secret: ${p}`);
  }
});

test('non-string values pass through untouched', () => {
  assert.equal(redact(null), null);
  assert.equal(redact(42), 42);
  assert.equal(redact(undefined), undefined);
  assert.deepEqual(redactDeep([1, 2, 3]), [1, 2, 3]);
});
