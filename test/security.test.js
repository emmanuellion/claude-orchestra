'use strict';

const os = require('os');
const path = require('path');
const fs = require('fs');

// lib/security pulls lib/config, which resolves the port, the token and the
// on-disk state at require time. Pin all three at a known value here, into a
// throwaway home, so the assertions below are about the policy and not about
// whatever happens to be in the developer's profile.
const SANDBOX_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'orchestra-sec-'));
process.env.HOME = SANDBOX_HOME;
process.env.USERPROFILE = SANDBOX_HOME;
process.env.PORT = '39917';
process.env.HOST = '127.0.0.1';
process.env.ORCHESTRA_ORIGINS = '';
const TOKEN = 'f'.repeat(64);
process.env.ORCHESTRA_TOKEN = TOKEN;

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { originAllowed, tokenMatches, checkUpgrade, headerToken } = require('../lib/security');
const config = require('../lib/config');
const PORT = config.port;

test('the sandbox really is configured as the tests assume', () => {
  assert.equal(PORT, 39917);
  assert.equal(config.token, TOKEN);
});

test('loopback origins on our own port are allowed', () => {
  assert.equal(originAllowed(`http://localhost:${PORT}`), true);
  assert.equal(originAllowed(`http://127.0.0.1:${PORT}`), true);
  assert.equal(originAllowed(`http://[::1]:${PORT}`), true);
  assert.equal(originAllowed(`https://localhost:${PORT}`), true);
});

test('loopback on a different port is refused', () => {
  // Another local dev server is still another origin: it must not be able to
  // drive the terminals just because it runs on the same machine.
  assert.equal(originAllowed(`http://localhost:${PORT + 1}`), false);
  assert.equal(originAllowed('http://127.0.0.1:3000'), false);
  assert.equal(originAllowed('http://localhost'), false);
});

test('a third party site is refused', () => {
  assert.equal(originAllowed('https://evil.example'), false);
  assert.equal(originAllowed(`https://evil.example:${PORT}`), false);
  assert.equal(originAllowed(`http://localhost.evil.example:${PORT}`), false);
  assert.equal(originAllowed('null'), false);
});

test('a missing origin is allowed, because it is not a browser', () => {
  // curl, a hook process and native clients send no Origin. They still have to
  // present the token, which a cross-origin page cannot read.
  assert.equal(originAllowed(undefined), true);
  assert.equal(originAllowed(''), true);
  assert.equal(originAllowed(null), true);
});

test('tokenMatches accepts only the exact token', () => {
  assert.equal(tokenMatches(TOKEN), true);
});

test('tokenMatches rejects a wrong token of the same length', () => {
  const wrong = 'e'.repeat(64);
  assert.equal(wrong.length, TOKEN.length);
  assert.equal(tokenMatches(wrong), false);
});

test('tokenMatches rejects a prefix, a suffix and any other length', () => {
  assert.equal(tokenMatches(TOKEN.slice(0, -1)), false);
  assert.equal(tokenMatches(`${TOKEN}x`), false);
  assert.equal(tokenMatches('f'), false);
});

test('tokenMatches rejects empty and non string candidates', () => {
  assert.equal(tokenMatches(''), false);
  assert.equal(tokenMatches(null), false);
  assert.equal(tokenMatches(undefined), false);
  assert.equal(tokenMatches(0), false);
  assert.equal(tokenMatches({}), false);
  assert.equal(tokenMatches([]), false);
  assert.equal(tokenMatches(Buffer.from(TOKEN)), false);
});

test('headerToken reads both the bearer and the custom header', () => {
  assert.equal(headerToken({ headers: { authorization: `Bearer ${TOKEN}` } }), TOKEN);
  assert.equal(headerToken({ headers: { 'x-orchestra-token': TOKEN } }), TOKEN);
  assert.equal(headerToken({ headers: {} }), '');
  assert.equal(headerToken({ headers: { authorization: TOKEN } }), '');
});

function upgradeRequest(url, headers) {
  return { url, headers: headers || {} };
}

test('an upgrade needs a good origin and a good token', () => {
  const ok = checkUpgrade(upgradeRequest(`/ws?token=${TOKEN}`, {
    origin: `http://localhost:${PORT}`,
  }));
  assert.deepEqual(ok, { ok: true });
});

test('an upgrade from a foreign origin is refused before the token is read', () => {
  const res = checkUpgrade(upgradeRequest(`/ws?token=${TOKEN}`, {
    origin: 'https://evil.example',
  }));
  assert.equal(res.ok, false);
  assert.equal(res.code, 403);
});

test('an upgrade without a token is refused even from the right origin', () => {
  const res = checkUpgrade(upgradeRequest('/ws', { origin: `http://localhost:${PORT}` }));
  assert.equal(res.ok, false);
  assert.equal(res.code, 401);
});

test('an upgrade with no origin is accepted only with the token', () => {
  assert.equal(checkUpgrade(upgradeRequest(`/ws?token=${TOKEN}`)).ok, true);
  assert.equal(checkUpgrade(upgradeRequest('/ws?token=nope')).ok, false);
});

test('the token may also arrive in a header on the upgrade', () => {
  const res = checkUpgrade(upgradeRequest('/ws', {
    origin: `http://127.0.0.1:${PORT}`,
    'x-orchestra-token': TOKEN,
  }));
  assert.deepEqual(res, { ok: true });
});
