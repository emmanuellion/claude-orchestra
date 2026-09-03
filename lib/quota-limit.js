'use strict';

const { parseResetTime, toEpochMs } = require('./usage-parser');

/**
 * Recognising, in a stream of terminal bytes, the moment Claude Code stops
 * because the account ran out of quota.
 *
 * This is deliberately the only screen reading left in Orchestra, and it is a
 * different thing from the `/usage` scraper that was removed: nothing is
 * spawned, no TUI is driven, no trust prompt is answered. These are bytes the
 * PTY was going to deliver to the browser anyway, read on the way past.
 *
 * It has to be here because no hook fires for this. `Stop` cannot tell a
 * finished turn from an interrupted one, and the statusLine snapshot says the
 * account is at 100% without saying which of six panels got cut off. The banner
 * is the only signal that names the session, and the only one that carries the
 * reset time at the instant of the block.
 *
 * A match is a suspicion, never a fact: lib/auto-resume.js confirms it against
 * the statusLine quota before acting on it.
 */

const ESC = String.fromCharCode(27);
const BEL = String.fromCharCode(7);

/**
 * CSI, OSC and the two character escapes, in that order. The banner arrives
 * wrapped in colour and cursor moves, and an unstripped escape sits between
 * "limit" and "reached" often enough to lose the match.
 *
 * Assembled from char codes rather than written as a literal, because a raw ESC
 * byte in a source file is the exact thing test/source-hygiene.test.js exists to
 * catch: git reclassifies the file as binary and every later diff is unreadable.
 */
const ANSI = new RegExp(
  ESC + '\\[[0-9;?]*[ -/]*[@-~]'
  + '|' + ESC + '\\][^' + BEL + ESC + ']*(?:' + BEL + '|' + ESC + '\\\\)'
  + '|' + ESC + '[@-Z\\\\-_]',
  'g',
);

/**
 * Box drawing, block elements and the bullets Claude Code pads its panels with.
 * Left in, they break the word boundaries below and split "limit reached" into
 * what a regex reads as two unrelated words.
 */
const DECORATION = /[─-▟■-◿•·∙]/g;

/** Enough to hold the banner plus the frame it is drawn in, and no more. */
const TAIL_CHARS = 8192;

/** A resets phrase past this length is a paragraph, not a timestamp. */
const RESET_TEXT_MAX = 60;

/** How much text around the matched phrase the reset time is looked for in. */
const CONTEXT_CHARS = 240;

/**
 * Phrases that mean "this account is out of quota right now".
 *
 * Every one requires the word "limit" beside a word meaning it was hit. Loose
 * matching is expensive here: a false positive makes Orchestra type into a
 * terminal that was never blocked, so text that merely mentions limits (docs,
 * an agent explaining rate limits, a /usage screen the user opened) must not
 * match.
 */
const LIMIT_PATTERNS = [
  /\busage limit reached\b/i,
  /\b(?:5|five)[- ]hour limit reached\b/i,
  /\b(?:weekly|7[- ]day|seven[- ]day) limit reached\b/i,
  /\bopus limit reached\b/i,
  /\byou(?:'ve|’ve| have) (?:reached|hit) your (?:usage|account|weekly|api) limit\b/i,
  /\brate[_ ]limit[_ ]error\b/i,
  /\blimit reached\b[^.\n]{0,60}\bresets?\b/i,
];

/**
 * Phrases that mean the opposite and veto a match in the same context.
 *
 * The first two are the warning Claude Code prints next to a limit it is
 * *approaching*; the rest are a user reading about limits rather than hitting
 * one. Without the veto, "you will reach your usage limit" matches the pattern
 * for having reached it.
 */
const NEGATIVE_PATTERNS = [
  /\bapproaching\b/i,
  /\bwill (?:reach|hit|be reached)\b/i,
  /\bbefore you (?:reach|hit)\b/i,
  /\bif you (?:reach|hit)\b/i,
  /\bhow (?:do|to|does)\b/i,
  /\bwhat happens when\b/i,
];

/** Which quota window the banner is talking about, when it says at all. */
const WINDOW_PATTERNS = [
  [/\b(?:5|five)[- ]hour\b|\bsession limit\b/i, 'five_hour'],
  [/\b(?:weekly|7[- ]day|seven[- ]day)\b/i, 'seven_day'],
  [/\bopus\b/i, 'extra'],
];

/**
 * Where the reset instant hides. Most specific first: an ISO timestamp is
 * unambiguous, a bare "3pm" needs the local clock to place it, and taking them
 * in the other order turns the "2026" of a timestamp into an hour.
 */
const RESET_PATTERNS = [
  /\b(?:limit )?(?:will )?resets? (?:at |on )?(\d{4}-\d{2}-\d{2}[T ][\d:]+(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?)/i,
  /\b(?:your limit will reset|limit resets|resets?) (?:at |on |in )?([^.,;)\n]{1,60})/i,
  /\btry again (?:at |in |after )([^.,;)\n]{1,60})/i,
  /\bavailable again (?:at |in )([^.,;)\n]{1,60})/i,
];

/** Strips escapes and box drawing so the phrases above match plain words. */
function stripAnsi(text) {
  if (typeof text !== 'string' || !text) return '';
  return text.replace(ANSI, '').replace(DECORATION, ' ');
}

/**
 * Collapses a decorated terminal frame into one line of words.
 *
 * The banner is drawn inside a box, so "usage limit" and "reached" routinely
 * land on different rows with a border between them. Folding the whitespace is
 * what lets one regex see the sentence a human sees.
 */
function flatten(text) {
  return collapse(text).trim();
}

/**
 * The same fold without the trim, which is the version the rolling tail needs.
 *
 * A PTY chunk boundary is a byte offset, not a word boundary: "usage li" and
 * "mit reached" routinely arrive as two flushes. Trimming each piece before
 * joining inserts a space into the middle of that word and loses the match,
 * so edges are left exactly as the terminal sent them.
 */
function collapse(text) {
  return stripAnsi(text).replace(/\s+/g, ' ');
}

/**
 * The rolling window a session's output is matched against.
 *
 * A 60 byte chunk cannot contain the whole banner, so matching chunk by chunk
 * misses it nearly every time. Callers keep the returned tail and hand it back
 * with the next chunk.
 *
 * @param {string} previous  tail returned by the last call, or ''
 * @param {string} chunk     raw PTY output
 * @returns {string} the last TAIL_CHARS characters of the two, flattened
 */
function appendTail(previous, chunk) {
  const head = typeof previous === 'string' ? previous : '';
  const joined = head + collapse(chunk);
  return joined.length > TAIL_CHARS ? joined.slice(joined.length - TAIL_CHARS) : joined;
}

function matchWindow(text) {
  for (const [pattern, name] of WINDOW_PATTERNS) {
    if (pattern.test(text)) return name;
  }
  return null;
}

/**
 * Pulls the reset instant out of the banner.
 *
 * Returns the phrase as well as the timestamp: when the wording is one
 * `parseResetTime` does not know, the caller still has something to show a
 * human and can fall back to the statusLine snapshot for the instant itself.
 *
 * @returns {{resetsAt: number|null, resetsText: string|null}}
 */
function extractReset(text, now) {
  for (const pattern of RESET_PATTERNS) {
    const m = text.match(pattern);
    if (!m || !m[1]) continue;
    const phrase = m[1].trim().slice(0, RESET_TEXT_MAX);
    if (!phrase) continue;
    // An ISO stamp stands on its own; anything else is relative to now.
    const direct = /^\d{4}-\d{2}-\d{2}/.test(phrase) ? toEpochMs(phrase) : null;
    // The patterns above swallow the preposition, which is the one word
    // parseResetTime needs to read "2 days" as a duration rather than give up.
    const resetsAt = direct !== null
      ? direct
      : (parseResetTime(phrase, now) ?? parseResetTime(`in ${phrase}`, now));
    return { resetsAt, resetsText: phrase };
  }
  return { resetsAt: null, resetsText: null };
}

/**
 * The text around a match, so the veto and the reset lookup both stay local.
 * A whole scrollback can hold a real banner and an unrelated question about
 * limits; judging them together would let either one decide for the other.
 */
function contextAround(text, pattern) {
  const m = text.match(pattern);
  if (!m || m.index === undefined) return text;
  const start = Math.max(0, m.index - CONTEXT_CHARS);
  const end = Math.min(text.length, m.index + m[0].length + CONTEXT_CHARS);
  return text.slice(start, end);
}

/**
 * Decides whether a session's recent output says it just ran out of quota.
 *
 * @param {string} tail  a window from `appendTail`, or any already flat text
 * @param {number} [now] epoch ms, for resolving "resets 3pm"
 * @returns {{window: string|null, resetsAt: number|null, resetsText: string|null,
 *            matched: string}|null} null when nothing matched
 */
function detectQuotaLimit(tail, now = Date.now()) {
  const text = typeof tail === 'string' ? tail : '';
  if (!text || !/limit/i.test(text)) return null;

  const hit = LIMIT_PATTERNS.find(pattern => pattern.test(text));
  if (!hit) return null;

  const context = contextAround(text, hit);
  if (NEGATIVE_PATTERNS.some(pattern => pattern.test(context))) return null;

  const { resetsAt, resetsText } = extractReset(context, now);
  return {
    window: matchWindow(context),
    resetsAt,
    resetsText,
    matched: (text.match(hit) || [''])[0],
  };
}

module.exports = {
  detectQuotaLimit,
  appendTail,
  stripAnsi,
  flatten,
  collapse,
  extractReset,
  contextAround,
  TAIL_CHARS,
  LIMIT_PATTERNS,
  NEGATIVE_PATTERNS,
};
