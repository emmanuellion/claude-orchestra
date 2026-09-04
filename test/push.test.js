'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  PushSender,
  generateVapidKeys,
  vapidAuthorization,
  encrypt,
  decrypt,
  validSubscription,
  b64url,
  unb64url,
  MAX_PAYLOAD_BYTES,
} = require('../lib/push');

/**
 * A stand-in for the browser side of a PushSubscription: a P-256 keypair and a
 * 16 byte auth secret, exactly what `pushManager.subscribe()` produces.
 */
function fakeBrowserSubscription(endpoint = 'https://push.example.com/abc') {
  const ecdh = crypto.createECDH('prime256v1');
  ecdh.generateKeys();
  const auth = crypto.randomBytes(16);
  return {
    subscription: {
      endpoint,
      keys: { p256dh: b64url(ecdh.getPublicKey()), auth: b64url(auth) },
    },
    private: ecdh.getPrivateKey(),
    public: ecdh.getPublicKey(),
    auth,
  };
}

function tmpFile(name = 'push.json') {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'orchestra-push-')), name);
}

test('what the server encrypts, the subscriber can decrypt', () => {
  const browser = fakeBrowserSubscription();
  const message = JSON.stringify({ title: 'api worker wants permission', body: 'Bash: rm -rf build' });

  const body = encrypt(browser.subscription.keys, message);
  const out = decrypt(body, browser.private, browser.public, browser.auth);

  assert.equal(out.toString('utf-8'), message);
});

test('the body carries a well formed RFC 8188 header', () => {
  const browser = fakeBrowserSubscription();
  const salt = crypto.randomBytes(16);
  const body = encrypt(browser.subscription.keys, 'hello', salt);

  assert.deepEqual(body.subarray(0, 16), salt, 'salt comes first');
  assert.equal(body.readUInt32BE(16), 4096, 'record size');
  assert.equal(body.readUInt8(20), 65, 'key id length is an uncompressed P-256 point');
  assert.equal(body[21], 0x04, 'and that point is uncompressed');
  // header(21) + key(65) + ciphertext(plaintext + delimiter + 16 byte tag)
  assert.equal(body.length, 21 + 65 + 'hello'.length + 1 + 16);
});

test('every message uses a fresh ephemeral key and salt', () => {
  const browser = fakeBrowserSubscription();
  const a = encrypt(browser.subscription.keys, 'same text');
  const b = encrypt(browser.subscription.keys, 'same text');

  assert.notDeepEqual(a.subarray(0, 16), b.subarray(0, 16), 'salt must not repeat');
  assert.notDeepEqual(a.subarray(21, 86), b.subarray(21, 86), 'nor the ephemeral public key');
  assert.notDeepEqual(a, b);
  // Both still open, which is what proves the reuse was not the thing making
  // decryption work.
  assert.equal(decrypt(a, browser.private, browser.public, browser.auth).toString(), 'same text');
  assert.equal(decrypt(b, browser.private, browser.public, browser.auth).toString(), 'same text');
});

test('a different subscriber cannot open the message', () => {
  const alice = fakeBrowserSubscription();
  const mallory = fakeBrowserSubscription();
  const body = encrypt(alice.subscription.keys, 'secret');

  assert.throws(() => decrypt(body, mallory.private, mallory.public, mallory.auth));
});

test('the auth secret is load bearing, not decoration', () => {
  const browser = fakeBrowserSubscription();
  const body = encrypt(browser.subscription.keys, 'secret');
  const wrongAuth = crypto.randomBytes(16);

  assert.throws(
    () => decrypt(body, browser.private, browser.public, wrongAuth),
    'knowing both public keys must not be enough to derive the content key',
  );
});

test('malformed subscription keys are refused, not guessed at', () => {
  assert.throws(() => encrypt({ p256dh: b64url(Buffer.alloc(10)), auth: b64url(Buffer.alloc(16)) }, 'x'), /P-256/);
  assert.throws(() => encrypt({ p256dh: b64url(Buffer.alloc(65, 4)), auth: b64url(Buffer.alloc(8)) }, 'x'), /auth/);
});

test('an oversized payload is rejected before it reaches a push service', () => {
  const browser = fakeBrowserSubscription();
  assert.throws(() => encrypt(browser.subscription.keys, 'x'.repeat(MAX_PAYLOAD_BYTES + 1)), /over the/);
});

test('VAPID keys are a usable raw P-256 pair', () => {
  const keys = generateVapidKeys();
  assert.equal(unb64url(keys.publicKey).length, 65);
  assert.equal(unb64url(keys.publicKey)[0], 0x04);
  assert.equal(unb64url(keys.privateKey).length, 32);
});

test('the VAPID header is a verifiable ES256 JWT for the right audience', () => {
  const keys = generateVapidKeys();
  const now = Date.parse('2026-09-04T10:00:00Z');
  const header = vapidAuthorization({
    endpoint: 'https://fcm.googleapis.com/fcm/send/xyz?a=b',
    publicKey: keys.publicKey,
    privateKey: keys.privateKey,
    subject: 'mailto:dev@example.com',
    now,
  });

  const m = header.match(/^vapid t=([^,]+), k=(.+)$/);
  assert.ok(m, `unexpected header shape: ${header}`);
  assert.equal(m[2], keys.publicKey);

  const [h, c, sig] = m[1].split('.');
  assert.deepEqual(JSON.parse(unb64url(h).toString()), { typ: 'JWT', alg: 'ES256' });

  const claims = JSON.parse(unb64url(c).toString());
  assert.equal(claims.aud, 'https://fcm.googleapis.com', 'audience is the origin, not the endpoint');
  assert.equal(claims.sub, 'mailto:dev@example.com');
  assert.equal(claims.exp, Math.floor(now / 1000) + 12 * 3600);

  // A DER signature here is the classic failure: every push service rejects it
  // and the only symptom is a 401 nobody can explain.
  const raw = unb64url(sig);
  assert.equal(raw.length, 64, 'ES256 must be raw r||s, not DER');

  const pub = unb64url(keys.publicKey);
  const verified = crypto.verify(
    'sha256',
    Buffer.from(`${h}.${c}`),
    {
      key: crypto.createPublicKey({
        format: 'jwk',
        key: {
          kty: 'EC',
          crv: 'P-256',
          x: b64url(pub.subarray(1, 33)),
          y: b64url(pub.subarray(33, 65)),
        },
      }),
      dsaEncoding: 'ieee-p1363',
    },
    raw,
  );
  assert.equal(verified, true, 'the signature must verify against the advertised key');
});

test('validSubscription rejects anything a browser would not have produced', () => {
  assert.equal(validSubscription(null), false);
  assert.equal(validSubscription({ endpoint: 'http://insecure.example/x', keys: { p256dh: 'a', auth: 'b' } }), false);
  assert.equal(validSubscription({ endpoint: 'https://ok.example/x' }), false);
  assert.equal(validSubscription({ endpoint: 'https://ok.example/x', keys: { p256dh: 'a', auth: 'b' } }), true);
});

test('the sender stores subscriptions and reuses its VAPID keys across restarts', () => {
  const file = tmpFile();
  const config = { pushFile: file, pushSubject: 'mailto:a@b.c' };
  const first = new PushSender({ config });
  const browser = fakeBrowserSubscription();

  assert.equal(first.subscribe(browser.subscription, 'phone').ok, true);
  assert.equal(first.enabled, true);

  const second = new PushSender({ config });
  assert.equal(second.publicKey(), first.publicKey(), 'rotating the key would orphan every device');
  assert.equal(second.subs.size, 1);
  assert.equal(second.list()[0].label, 'phone');
});

test('the listing never hands the subscription keys back out', () => {
  const sender = new PushSender({ config: { pushFile: tmpFile(), pushSubject: 'mailto:a@b.c' } });
  sender.subscribe(fakeBrowserSubscription().subscription);
  const row = sender.list()[0];
  assert.equal(row.keys, undefined);
  assert.equal(row.host, 'push.example.com');
});

test('a delivery failure never propagates to the caller', async () => {
  const sender = new PushSender({
    config: { pushFile: tmpFile(), pushSubject: 'mailto:a@b.c' },
    fetchImpl: async () => { throw new Error('offline'); },
  });
  sender.subscribe(fakeBrowserSubscription().subscription);

  const out = await sender.send({ title: 'x' });
  assert.deepEqual(out, { sent: 0, failed: 1, pruned: 0 });
  assert.equal(sender.subs.size, 1, 'a network blip must not drop the device');
});

test('a 410 prunes the dead subscription', async () => {
  const sender = new PushSender({
    config: { pushFile: tmpFile(), pushSubject: 'mailto:a@b.c' },
    logger: { info() {}, warn() {}, error() {} },
    fetchImpl: async () => ({ ok: false, status: 410 }),
  });
  sender.subscribe(fakeBrowserSubscription().subscription);

  const out = await sender.send({ title: 'x' });
  assert.equal(out.pruned, 1);
  assert.equal(sender.subs.size, 0);
});

test('a successful send reaches the endpoint with the right content coding', async () => {
  const calls = [];
  const sender = new PushSender({
    config: { pushFile: tmpFile(), pushSubject: 'mailto:a@b.c' },
    fetchImpl: async (url, opts) => { calls.push({ url, opts }); return { ok: true, status: 201 }; },
  });
  const browser = fakeBrowserSubscription();
  sender.subscribe(browser.subscription);

  const out = await sender.send({ title: 'Permission', body: 'Bash', reason: 'permission' });
  assert.deepEqual(out, { sent: 1, failed: 0, pruned: 0 });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, browser.subscription.endpoint);
  assert.equal(calls[0].opts.headers['Content-Encoding'], 'aes128gcm');
  assert.match(calls[0].opts.headers.Authorization, /^vapid t=.+, k=.+$/);

  // And the browser really can read what was posted.
  const plain = decrypt(calls[0].opts.body, browser.private, browser.public, browser.auth);
  assert.equal(JSON.parse(plain.toString()).title, 'Permission');
});

test('sending with nobody subscribed is a no-op, not an error', async () => {
  const sender = new PushSender({ config: { pushFile: tmpFile(), pushSubject: 'mailto:a@b.c' } });
  assert.deepEqual(await sender.send({ title: 'x' }), { sent: 0, failed: 0, pruned: 0 });
});
