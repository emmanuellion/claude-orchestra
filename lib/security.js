'use strict';

const crypto = require('crypto');
const os = require('os');
const config = require('./config');

/**
 * Addresses that mean "bind every interface". They are bind targets, never
 * something a client puts in a Host header or a browser puts in an Origin, so
 * they must never end up in the accepted-name set as themselves.
 */
const WILDCARD_HOSTS = new Set(['0.0.0.0', '::', '[::]', '0:0:0:0:0:0:0:0', '::0']);
const LOOPBACK_NAMES = ['localhost', '127.0.0.1', '::1'];

/**
 * networkInterfaces() is a syscall and both checks below run on every request.
 * Interfaces do change (a phone joins a hotspot), so the set is rebuilt on a
 * short interval rather than pinned at boot.
 */
const HOST_CACHE_MS = 30000;
let hostCache = { key: null, at: 0, names: null };

function isWildcardHost(host) {
  return WILDCARD_HOSTS.has(String(host || ''));
}

/** Bare comparable hostname: no brackets, no IPv6 zone index, lowercase. */
function normalizeName(name) {
  return String(name || '')
    .replace(/^\[|\]$/g, '')
    .replace(/%.*$/, '')
    .toLowerCase();
}

/** An IPv6 literal has to go back inside brackets to be a legal URL host. */
function hostForUrl(name) {
  return name.includes(':') ? `[${name}]` : name;
}

/**
 * Every hostname this server legitimately answers to.
 *
 * With a wildcard bind the configured host ('0.0.0.0') is not a name any client
 * can send, so the set is built from the addresses that bind actually covers
 * plus the machine's own name. That keeps "only expected names are accepted"
 * while making HOST=0.0.0.0 reachable from the LAN.
 */
function expectedHostnames() {
  const { host, extraOrigins } = config;
  const key = `${host}|${extraOrigins.join(',')}`;
  const now = Date.now();
  if (hostCache.names && hostCache.key === key && now - hostCache.at < HOST_CACHE_MS) {
    return hostCache.names;
  }

  const names = new Set(LOOPBACK_NAMES);
  if (isWildcardHost(host)) {
    for (const list of Object.values(os.networkInterfaces())) {
      for (const iface of list || []) names.add(normalizeName(iface.address));
    }
    const own = os.hostname();
    if (own) names.add(normalizeName(own));
  } else if (host) {
    names.add(normalizeName(host));
  }
  for (const origin of extraOrigins) {
    try {
      names.add(normalizeName(new URL(origin).hostname));
    } catch {
      // A malformed ORCHESTRA_ORIGINS entry contributes no hostname; the
      // origin string itself is still honoured verbatim in allowedOrigins().
    }
  }

  hostCache = { key, at: now, names };
  return names;
}

/** Constant-time comparison that does not leak a length mismatch either. */
function tokenMatches(candidate) {
  if (typeof candidate !== 'string' || candidate.length === 0) return false;
  const a = Buffer.from(candidate);
  const b = Buffer.from(config.token);
  if (a.length !== b.length) {
    // Still burn a comparison so the timing does not advertise the length.
    crypto.timingSafeEqual(b, b);
    return false;
  }
  return crypto.timingSafeEqual(a, b);
}

function allowedOrigins() {
  const { port, extraOrigins } = config;
  const set = new Set(extraOrigins);
  for (const name of expectedHostnames()) {
    const h = hostForUrl(name);
    set.add(`http://${h}:${port}`);
    set.add(`https://${h}:${port}`);
    // A browser omits the port from Origin on the two default ports.
    if (port === 80) set.add(`http://${h}`);
    if (port === 443) set.add(`https://${h}`);
  }
  return set;
}

/**
 * WebSockets are exempt from the same-origin policy: any page the user visits
 * can open ws://localhost:3000 unless the server checks who is calling.
 *
 * A missing Origin header means a non-browser client (curl, a hook, a native
 * app). Those are allowed only when they present the token, which browsers
 * from another origin cannot read.
 */
function originAllowed(origin) {
  if (!origin) return true;
  return allowedOrigins().has(origin);
}

/**
 * @param {import('http').IncomingMessage} req
 * @returns {{ok: true} | {ok: false, code: number, reason: string}}
 */
function checkUpgrade(req) {
  const origin = req.headers.origin;
  if (!originAllowed(origin)) {
    return { ok: false, code: 403, reason: 'origin not allowed' };
  }
  const url = new URL(req.url, 'http://localhost');
  const token = url.searchParams.get('token') || headerToken(req);
  if (!tokenMatches(token)) {
    return { ok: false, code: 401, reason: 'bad or missing token' };
  }
  return { ok: true };
}

function headerToken(req) {
  const auth = req.headers.authorization || '';
  if (auth.startsWith('Bearer ')) return auth.slice(7).trim();
  const h = req.headers['x-orchestra-token'];
  return typeof h === 'string' ? h : '';
}

/**
 * Express middleware for the mutating and data-bearing routes. Read-only static
 * assets stay open so the page can bootstrap and read its own token out of the
 * served HTML.
 */
function requireToken(req, res, next) {
  const origin = req.headers.origin;
  if (origin && !originAllowed(origin)) {
    return res.status(403).json({ error: 'origin not allowed' });
  }
  const token = headerToken(req)
    || (typeof req.query?.token === 'string' ? req.query.token : '')
    || (req.body && typeof req.body.token === 'string' ? req.body.token : '');
  if (!tokenMatches(token)) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  next();
}

/**
 * Blocks the classic DNS-rebinding shape: an attacker-controlled hostname that
 * resolves to 127.0.0.1, letting a remote page talk to a loopback service with
 * a same-origin Host header. We only ever answer to hostnames we expect.
 */
function checkHost(req, res, next) {
  const name = normalizeName(String(req.headers.host || '').replace(/:\d+$/, ''));
  if (!expectedHostnames().has(name)) return res.status(403).send('bad host');
  next();
}

/** A conservative CSP: no CDN, no inline scripts beyond the bootstrap nonce. */
function securityHeaders(nonce) {
  return {
    'Content-Security-Policy': [
      "default-src 'self'",
      `script-src 'self' 'nonce-${nonce}'`,
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data:",
      "font-src 'self' data:",
      "connect-src 'self' ws: wss:",
      // Stated rather than inherited. worker-src falls back to script-src,
      // which carries a nonce, and a reader should not have to know that the
      // fallback still permits 'self' before trusting that /sw.js can load.
      "worker-src 'self'",
      "frame-ancestors 'none'",
      "base-uri 'none'",
      "form-action 'none'",
    ].join('; '),
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'X-Frame-Options': 'DENY',
  };
}

module.exports = {
  tokenMatches,
  originAllowed,
  checkUpgrade,
  requireToken,
  checkHost,
  securityHeaders,
  headerToken,
};
