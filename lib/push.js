'use strict';

const crypto = require('crypto');
const fs = require('fs');

const defaultConfig = require('./config');

/**
 * Web Push: the last mile of remote approval.
 *
 * Orchestra's whole remote story is that a permission prompt reaches you on a
 * phone. The browser Notification API cannot do that: it needs the page alive
 * and foregrounded, which a phone in a pocket never is. Only a push message
 * delivered to a service worker wakes a closed tab, so this file exists.
 *
 * It implements RFC 8291 (message encryption) and RFC 8292 (VAPID) directly
 * rather than pulling in `web-push`. The repo ships no dependency it does not
 * need, and both specs are small when Node already provides P-256 ECDH, HKDF
 * and AES-GCM. The one thing that would justify the dependency is getting the
 * crypto wrong, which is why test/push.test.js decrypts what this encrypts
 * using the receiver's key, independently derived.
 *
 * The server never sees the notification content after it leaves: the payload
 * is encrypted to a key only the subscribed browser holds. The push service
 * (Google, Mozilla, Apple) forwards ciphertext it cannot read.
 */

/** RFC 8188 record size. One notification is far below this; one record is sent. */
const RECORD_SIZE = 4096;

/** Uncompressed P-256 point: 0x04 || X(32) || Y(32). */
const P256_PUBLIC_BYTES = 65;

/** RFC 8291 requires exactly 16 bytes of subscriber auth secret. */
const AUTH_SECRET_BYTES = 16;

/** VAPID tokens must not outlive 24h; 12 gives room without pushing the limit. */
const VAPID_TTL_S = 12 * 3600;

/** How long a push service should hold an undelivered message. */
const DEFAULT_TTL_S = 6 * 3600;

/** A payload beyond this is a bug, not a notification. */
const MAX_PAYLOAD_BYTES = 3000;

/** Subscriptions kept. One per browser per device; nobody has more. */
const MAX_SUBSCRIPTIONS = 64;

function b64url(buf) {
  return Buffer.from(buf).toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

function unb64url(str) {
  const s = String(str).replace(/-/g, '+').replace(/_/g, '/');
  return Buffer.from(s + '='.repeat((4 - (s.length % 4)) % 4), 'base64');
}

/** hkdfSync returns an ArrayBuffer on some Node versions; normalise it. */
function hkdf(ikm, salt, info, length) {
  return Buffer.from(crypto.hkdfSync('sha256', ikm, salt, info, length));
}

/** A P-256 keypair in the raw form both the browser and RFC 8292 speak. */
function generateVapidKeys() {
  const ecdh = crypto.createECDH('prime256v1');
  ecdh.generateKeys();
  return {
    publicKey: b64url(ecdh.getPublicKey()),
    privateKey: b64url(ecdh.getPrivateKey()),
  };
}

/**
 * Raw P-256 scalars are what the browser and the VAPID header use, but
 * crypto.sign needs a KeyObject. JWK is the only import format that takes the
 * bare numbers without hand-assembling DER.
 */
function privateKeyObject(rawPrivate, rawPublic) {
  const pub = Buffer.from(rawPublic);
  if (pub.length !== P256_PUBLIC_BYTES || pub[0] !== 0x04) {
    throw new Error('VAPID public key must be a 65 byte uncompressed P-256 point');
  }
  return crypto.createPrivateKey({
    format: 'jwk',
    key: {
      kty: 'EC',
      crv: 'P-256',
      d: b64url(rawPrivate),
      x: b64url(pub.subarray(1, 33)),
      y: b64url(pub.subarray(33, 65)),
    },
  });
}

/** The `aud` claim is the push service origin, never the full endpoint. */
function audienceOf(endpoint) {
  const url = new URL(endpoint);
  return `${url.protocol}//${url.host}`;
}

/**
 * The `Authorization: vapid ...` header proving the push service that this
 * server owns the key the browser subscribed with.
 *
 * @param {{endpoint:string, publicKey:string, privateKey:string, subject:string,
 *          now?:number}} opts
 */
function vapidAuthorization({ endpoint, publicKey, privateKey, subject, now = Date.now() }) {
  const header = b64url(Buffer.from(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const claims = b64url(Buffer.from(JSON.stringify({
    aud: audienceOf(endpoint),
    exp: Math.floor(now / 1000) + VAPID_TTL_S,
    sub: subject,
  })));
  const signingInput = `${header}.${claims}`;

  // ES256 is a raw 64 byte r||s pair. Node signs DER unless told otherwise,
  // and a DER signature is silently rejected by every push service.
  const signature = crypto.sign(
    'sha256',
    Buffer.from(signingInput),
    { key: privateKeyObject(unb64url(privateKey), unb64url(publicKey)), dsaEncoding: 'ieee-p1363' },
  );

  return `vapid t=${signingInput}.${b64url(signature)}, k=${publicKey}`;
}

/**
 * Encrypts one payload to a subscription, RFC 8291 with aes128gcm.
 *
 * @param {{p256dh:string, auth:string}} keys  from the browser's PushSubscription
 * @param {string|Buffer} payload
 * @param {Buffer} [salt]        injectable so a test can be deterministic
 * @param {crypto.ECDH} [ecdh]   likewise for the ephemeral key
 * @returns {Buffer} the request body: header || ciphertext
 */
function encrypt(keys, payload, salt = crypto.randomBytes(16), ecdh = null) {
  const uaPublic = unb64url(keys && keys.p256dh);
  const authSecret = unb64url(keys && keys.auth);
  if (uaPublic.length !== P256_PUBLIC_BYTES || uaPublic[0] !== 0x04) {
    throw new Error('subscription p256dh is not a 65 byte uncompressed P-256 point');
  }
  if (authSecret.length !== AUTH_SECRET_BYTES) {
    throw new Error(`subscription auth must be ${AUTH_SECRET_BYTES} bytes`);
  }

  const plaintext = Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload), 'utf-8');
  if (plaintext.length > MAX_PAYLOAD_BYTES) {
    throw new Error(`push payload is ${plaintext.length} bytes, over the ${MAX_PAYLOAD_BYTES} limit`);
  }

  const server = ecdh || crypto.createECDH('prime256v1');
  if (!ecdh) server.generateKeys();
  const asPublic = server.getPublicKey();
  const shared = server.computeSecret(uaPublic);

  // Two rounds on purpose. The first mixes the subscriber's auth secret into
  // the ECDH output, which is what stops a push service that observed the
  // public keys from deriving the content key.
  const ikm = hkdf(
    shared,
    authSecret,
    Buffer.concat([Buffer.from('WebPush: info\0'), uaPublic, asPublic]),
    32,
  );
  const cek = hkdf(ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16);
  const nonce = hkdf(ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12);

  // 0x02 marks the last record. Without the delimiter the receiver treats the
  // record as truncated and drops the message.
  const padded = Buffer.concat([plaintext, Buffer.from([0x02])]);
  const cipher = crypto.createCipheriv('aes-128-gcm', cek, nonce);
  const body = Buffer.concat([cipher.update(padded), cipher.final(), cipher.getAuthTag()]);

  const header = Buffer.alloc(21);
  salt.copy(header, 0);
  header.writeUInt32BE(RECORD_SIZE, 16);
  header.writeUInt8(asPublic.length, 20);

  return Buffer.concat([header, asPublic, body]);
}

/**
 * The inverse, from the subscriber's side. Not used in production: it exists so
 * the test suite can prove the encryption above is the one a browser will be
 * able to open, rather than merely self-consistent.
 *
 * @param {Buffer} body            what `encrypt` produced
 * @param {Buffer} uaPrivate       the subscriber's raw private key
 * @param {Buffer} uaPublic        the subscriber's raw public key
 * @param {Buffer} authSecret      the subscriber's auth secret
 * @returns {Buffer} the original plaintext
 */
function decrypt(body, uaPrivate, uaPublic, authSecret) {
  const salt = body.subarray(0, 16);
  const idlen = body.readUInt8(20);
  const asPublic = body.subarray(21, 21 + idlen);
  const payload = body.subarray(21 + idlen);

  const ecdh = crypto.createECDH('prime256v1');
  ecdh.setPrivateKey(uaPrivate);
  const shared = ecdh.computeSecret(asPublic);

  const ikm = hkdf(
    shared,
    authSecret,
    Buffer.concat([Buffer.from('WebPush: info\0'), uaPublic, asPublic]),
    32,
  );
  const cek = hkdf(ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16);
  const nonce = hkdf(ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12);

  const tag = payload.subarray(payload.length - 16);
  const decipher = crypto.createDecipheriv('aes-128-gcm', cek, nonce);
  decipher.setAuthTag(tag);
  const plain = Buffer.concat([
    decipher.update(payload.subarray(0, payload.length - 16)),
    decipher.final(),
  ]);

  // Strip the record delimiter and any padding behind it.
  let end = plain.length - 1;
  while (end >= 0 && plain[end] === 0x00) end -= 1;
  return plain.subarray(0, end);
}

function validSubscription(sub) {
  return !!(sub
    && typeof sub === 'object'
    && typeof sub.endpoint === 'string'
    && /^https:\/\//.test(sub.endpoint)
    && sub.keys
    && typeof sub.keys.p256dh === 'string'
    && typeof sub.keys.auth === 'string');
}

function writeJsonAtomic(file, data) {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, { encoding: 'utf-8', mode: 0o600 });
  fs.renameSync(tmp, file);
}

/**
 * Holds the device subscriptions and delivers to them.
 *
 * Delivery is best effort by design: a push that fails must never propagate
 * into the thing that raised it. An agent's permission request has to keep
 * working when the notification cannot be sent.
 */
class PushSender {
  /**
   * @param {{config?:Object, logger?:Object, fetchImpl?:Function}} [deps]
   */
  constructor({ config = defaultConfig, logger = null, fetchImpl = null } = {}) {
    this.config = config;
    this.log = logger || { info() {}, warn() {}, error() {} };
    this.fetch = fetchImpl || ((...a) => globalThis.fetch(...a));
    this.file = config.pushFile;
    this.subject = config.pushSubject;

    const stored = this._load();
    this.keys = stored.keys;
    /** @type {Map<string, Object>} endpoint -> subscription */
    this.subs = new Map(stored.subscriptions.map(s => [s.endpoint, s]));

    if (!stored.hadKeys) this._persist();
  }

  /** The applicationServerKey the browser needs to subscribe. */
  publicKey() {
    return this.keys.publicKey;
  }

  /** @returns {boolean} whether anything is subscribed to push at all. */
  get enabled() {
    return this.subs.size > 0;
  }

  list() {
    return [...this.subs.values()].map(s => ({
      endpoint: s.endpoint,
      // Never hand the keys back out: they are the only thing that makes a
      // stolen subscription list useless to whoever took it.
      host: (() => { try { return new URL(s.endpoint).host; } catch { return 'unknown'; } })(),
      label: s.label || null,
      createdAt: s.createdAt,
      lastSentAt: s.lastSentAt || null,
      failures: s.failures || 0,
    }));
  }

  /** @returns {{ok:boolean, error?:string}} */
  subscribe(sub, label = null) {
    if (!validSubscription(sub)) return { ok: false, error: 'malformed subscription' };
    try {
      unb64url(sub.keys.p256dh);
      unb64url(sub.keys.auth);
    } catch {
      return { ok: false, error: 'subscription keys are not base64url' };
    }
    if (this.subs.size >= MAX_SUBSCRIPTIONS && !this.subs.has(sub.endpoint)) {
      return { ok: false, error: `at most ${MAX_SUBSCRIPTIONS} devices` };
    }
    const existing = this.subs.get(sub.endpoint);
    this.subs.set(sub.endpoint, {
      endpoint: sub.endpoint,
      keys: { p256dh: sub.keys.p256dh, auth: sub.keys.auth },
      label: typeof label === 'string' && label ? label.slice(0, 60) : (existing && existing.label) || null,
      createdAt: existing ? existing.createdAt : Date.now(),
      lastSentAt: existing ? existing.lastSentAt : null,
      failures: 0,
    });
    this._persist();
    return { ok: true };
  }

  unsubscribe(endpoint) {
    const had = this.subs.delete(endpoint);
    if (had) this._persist();
    return { ok: had, error: had ? undefined : 'not subscribed' };
  }

  /**
   * Delivers to every device. Never throws and never rejects.
   *
   * @param {{title:string, body?:string, tag?:string, url?:string, data?:Object}} message
   * @returns {Promise<{sent:number, failed:number, pruned:number}>}
   */
  async send(message) {
    if (!this.subs.size) return { sent: 0, failed: 0, pruned: 0 };

    const payload = JSON.stringify({
      title: String(message.title || 'Claude Orchestra').slice(0, 120),
      body: String(message.body || '').slice(0, 300),
      tag: message.tag ? String(message.tag).slice(0, 80) : undefined,
      url: message.url ? String(message.url).slice(0, 300) : undefined,
      reason: message.reason || null,
      sessionId: message.sessionId || null,
      requireInteraction: !!message.requireInteraction,
      ts: Date.now(),
    });

    const results = await Promise.all(
      [...this.subs.values()].map(sub => this._sendOne(sub, payload)),
    );

    let sent = 0;
    let failed = 0;
    const gone = [];
    for (const r of results) {
      if (r.ok) sent += 1;
      else failed += 1;
      if (r.gone) gone.push(r.endpoint);
    }
    for (const endpoint of gone) this.subs.delete(endpoint);
    if (gone.length || sent) this._persist();
    return { sent, failed, pruned: gone.length };
  }

  async _sendOne(sub, payload) {
    let body;
    let authorization;
    try {
      body = encrypt(sub.keys, payload);
      authorization = vapidAuthorization({
        endpoint: sub.endpoint,
        publicKey: this.keys.publicKey,
        privateKey: this.keys.privateKey,
        subject: this.subject,
      });
    } catch (err) {
      this.log.warn(`[push] could not build a message for ${sub.endpoint}: ${err.message}`);
      return { ok: false, gone: false, endpoint: sub.endpoint };
    }

    try {
      const res = await this.fetch(sub.endpoint, {
        method: 'POST',
        headers: {
          'Content-Encoding': 'aes128gcm',
          'Content-Type': 'application/octet-stream',
          TTL: String(DEFAULT_TTL_S),
          Urgency: 'high',
          Authorization: authorization,
        },
        body,
      });

      if (res.status === 404 || res.status === 410) {
        // The browser dropped the subscription. Keeping it would mean retrying
        // a dead endpoint on every approval forever.
        this.log.info(`[push] subscription gone, forgetting ${new URL(sub.endpoint).host}`);
        return { ok: false, gone: true, endpoint: sub.endpoint };
      }
      if (!res.ok) {
        sub.failures = (sub.failures || 0) + 1;
        this.log.warn(`[push] ${res.status} from ${new URL(sub.endpoint).host}`);
        return { ok: false, gone: sub.failures > 20, endpoint: sub.endpoint };
      }
      sub.lastSentAt = Date.now();
      sub.failures = 0;
      return { ok: true, gone: false, endpoint: sub.endpoint };
    } catch (err) {
      // Offline, DNS, TLS. Not the subscription's fault, so it is kept.
      sub.failures = (sub.failures || 0) + 1;
      this.log.warn(`[push] delivery failed: ${err.message}`);
      return { ok: false, gone: false, endpoint: sub.endpoint };
    }
  }

  _load() {
    const empty = { keys: generateVapidKeys(), subscriptions: [], hadKeys: false };
    if (!this.file) return empty;
    let raw;
    try {
      raw = fs.readFileSync(this.file, 'utf-8');
    } catch (err) {
      if (err.code !== 'ENOENT') this.log.warn(`[push] cannot read ${this.file}: ${err.message}`);
      return empty;
    }
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      this.log.warn(`[push] ${this.file} is not valid JSON (${err.message}); starting fresh`);
      return empty;
    }
    const keys = parsed && parsed.keys;
    // Rotating the VAPID key invalidates every existing subscription, so a
    // half-readable file keeps its keys rather than silently orphaning devices.
    if (!keys || typeof keys.publicKey !== 'string' || typeof keys.privateKey !== 'string') {
      return empty;
    }
    const subscriptions = Array.isArray(parsed.subscriptions)
      ? parsed.subscriptions.filter(validSubscription).slice(0, MAX_SUBSCRIPTIONS)
      : [];
    return { keys, subscriptions, hadKeys: true };
  }

  _persist() {
    if (!this.file) return;
    try {
      writeJsonAtomic(this.file, { keys: this.keys, subscriptions: [...this.subs.values()] });
    } catch (err) {
      this.log.warn(`[push] could not save ${this.file}: ${err.message}`);
    }
  }
}

module.exports = {
  PushSender,
  generateVapidKeys,
  vapidAuthorization,
  encrypt,
  decrypt,
  validSubscription,
  b64url,
  unb64url,
  RECORD_SIZE,
  MAX_PAYLOAD_BYTES,
  MAX_SUBSCRIPTIONS,
};
