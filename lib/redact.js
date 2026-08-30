'use strict';

/**
 * Secret redaction for anything Orchestra persists.
 *
 * The event timeline and the audit log keep what agents did, in plain files,
 * for as long as the user keeps them. Without this, an agent that types
 * `export STRIPE_KEY=...` turns the governance feature into a durable secret
 * store. The rule throughout: keep the shape, drop the value, so the record
 * still reads as a record.
 */

const REDACTED = '[redacted]';

const keepHead = (_m, head) => `${head}${REDACTED}`;
const keepHeadQuoted = (_m, head, quote) => `${head}${quote}${REDACTED}${quote}`;
const blank = () => REDACTED;

/** Applied in order. Authorization must precede the generic name rule. */
const RULES = [
  // The generic rule would match "Authorization:" and swallow only the scheme
  // word, leaving the token beside it. That leak is what this file exists for.
  { re: /\b(Authorization\s*:\s*(?:Bearer|Basic|Token|Digest)?\s*)(\S+)/gi, replace: keepHead },

  // KEY=value for names that announce a secret. AUTH is deliberately absent:
  // it is a substring of "author", and redacting commit authors is both wrong
  // and unhelpful.
  {
    re: /\b((?:[A-Za-z0-9_]*(?:SECRET|TOKEN|PASSWORD|PASSWD|APIKEY|API_KEY|ACCESS_KEY|PRIVATE_KEY|CREDENTIAL|SESSION_KEY|AUTH_KEY|AUTH_TOKEN)[A-Za-z0-9_]*)\s*[=:]\s*)(['"]?)([^\s'"`;&|]+)\2/gi,
    replace: keepHeadQuoted,
  },
  { re: /(--(?:token|password|api-key|apikey|secret|auth)[= ])(['"]?)([^\s'"`;&|]+)\2/gi, replace: keepHeadQuoted },

  // Provider key shapes, which leak with no name in front of them.
  { re: /\bsk-[A-Za-z0-9_-]{16,}/g, replace: blank },
  { re: /\bsk_(?:live|test)_[A-Za-z0-9]{10,}/g, replace: blank },
  { re: /\bgh[pousr]_[A-Za-z0-9]{20,}/g, replace: blank },
  { re: /\bxox[abposr]-[A-Za-z0-9-]{10,}/g, replace: blank },
  { re: /\bAKIA[0-9A-Z]{16}\b/g, replace: blank },
  { re: /\bya29\.[A-Za-z0-9_-]{20,}/g, replace: blank },
  { re: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, replace: blank },

  {
    re: /-----BEGIN[ A-Z]*PRIVATE KEY-----[\s\S]*?-----END[ A-Z]*PRIVATE KEY-----/g,
    replace: () => `-----BEGIN PRIVATE KEY----- ${REDACTED} -----END PRIVATE KEY-----`,
  },
  { re: /\b([a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:)([^\s@/]+)@/gi, replace: keepHead2 },
];

/** URL credentials keep the trailing `@` that ends the userinfo part. */
function keepHead2(_m, head) {
  return `${head}${REDACTED}@`;
}

/** Files whose content should never be persisted, whatever it looks like. */
const SECRET_FILE = /(^|[\s"'`([\\/])\.(env|npmrc|netrc|pgpass)\b|(^|[\\/])(id_[a-z]+|[^\s/\\]*\.pem|[^\s/\\]*\.key)$|(^|[\\/])\.(aws|ssh|gnupg)[\\/]/i;

/** Keys naming the file a tool is about to touch. */
const PATH_KEYS = ['file_path', 'filePath', 'path', 'notebook_path', 'target'];
/** Keys carrying the bytes that would be written into it. */
const BODY_KEYS = new Set(['content', 'new_string', 'old_string', 'text', 'body', 'patch']);

const MAX_DEPTH = 8;

/** Non-strings pass through untouched. */
function redact(value) {
  if (typeof value !== 'string' || !value) return value;
  return RULES.reduce((out, rule) => out.replace(rule.re, rule.replace), value);
}

function isSecretFile(p) {
  return typeof p === 'string' && SECRET_FILE.test(p);
}

/**
 * Deep-redacts a value for persistence.
 *
 * Strings are scrubbed pattern by pattern, except a body destined for a
 * credential file, which is dropped whole: a `.env` is secret line by line, so
 * matching known shapes inside it would miss most of it.
 *
 * @param {*} value
 * @param {{maxString?: number}} [opts]
 */
function redactDeep(value, opts = {}) {
  const maxString = opts.maxString || 8000;
  const seen = new WeakSet();

  const walk = (node, depth, dropBody, keyHint) => {
    if (depth > MAX_DEPTH) return '[truncated]';

    if (typeof node === 'string') {
      if (dropBody && BODY_KEYS.has(keyHint)) return REDACTED;
      const scrubbed = redact(node);
      return scrubbed.length > maxString ? `${scrubbed.slice(0, maxString)}[...]` : scrubbed;
    }
    if (!node || typeof node !== 'object') return node;
    if (seen.has(node)) return '[circular]';
    seen.add(node);

    if (Array.isArray(node)) return node.map(v => walk(v, depth + 1, dropBody, keyHint));

    // Decided once per object: `content` only knows which file it belongs to by
    // looking at its sibling path key.
    const secretTarget = PATH_KEYS.some(k => isSecretFile(node[k]));
    return Object.fromEntries(Object.entries(node)
      .map(([k, v]) => [k, walk(v, depth + 1, dropBody || secretTarget, k)]));
  };

  return walk(value, 0, false, undefined);
}

module.exports = { redact, redactDeep, isSecretFile, REDACTED };
