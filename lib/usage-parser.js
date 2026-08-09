'use strict';

/**
 * Pure parsing and aggregation helpers for quota and usage data.
 *
 * Nothing here touches the disk, the clock or the network: every function is a
 * value in, value out transform, so the whole quota story is unit testable.
 * The two sources it understands are the JSON Claude Code hands to a statusLine
 * hook (`rate_limits`) and the JSONL transcripts under ~/.claude/projects.
 */

const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

const MONTHS = {
  jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5,
  jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11,
};

const WEEKDAYS = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };

const RELATIVE_UNITS = {
  s: 1000, sec: 1000, secs: 1000, second: 1000, seconds: 1000,
  m: MINUTE_MS, min: MINUTE_MS, mins: MINUTE_MS, minute: MINUTE_MS, minutes: MINUTE_MS,
  h: HOUR_MS, hr: HOUR_MS, hrs: HOUR_MS, hour: HOUR_MS, hours: HOUR_MS,
  d: DAY_MS, day: DAY_MS, days: DAY_MS,
  w: 7 * DAY_MS, week: 7 * DAY_MS, weeks: 7 * DAY_MS,
};

/**
 * Coerce a timestamp of unknown flavour to epoch milliseconds.
 *
 * Claude Code has shipped `resets_at` as epoch seconds, epoch milliseconds and
 * as an ISO string depending on the surface, so the unit is detected by
 * magnitude rather than trusted: anything below 1e11 cannot plausibly be a
 * millisecond timestamp in this decade, and anything above 1e14 is microseconds.
 *
 * @param {number|string|Date|null|undefined} value
 * @returns {number|null} epoch ms, or null when nothing usable was given
 */
function toEpochMs(value) {
  if (value === null || value === undefined || value === '') return null;
  if (value instanceof Date) {
    const t = value.getTime();
    return Number.isFinite(t) ? t : null;
  }
  let n = null;
  if (typeof value === 'number') {
    n = value;
  } else if (typeof value === 'string' && /^-?\d+(\.\d+)?$/.test(value.trim())) {
    n = Number(value.trim());
  }
  if (n !== null) {
    if (!Number.isFinite(n) || n <= 0) return null;
    if (n >= 1e14) return Math.round(n / 1000);
    if (n >= 1e11) return Math.round(n);
    return Math.round(n * 1000);
  }
  if (typeof value === 'string') {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function toNumber(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string' && value.trim() !== '') {
    const n = Number(value.replace('%', '').trim());
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function firstDefined(obj, keys) {
  if (!obj || typeof obj !== 'object') return undefined;
  for (const key of keys) {
    if (obj[key] !== undefined && obj[key] !== null) return obj[key];
  }
  return undefined;
}

/**
 * Window length hinted by a string such as "5h", "7d", "five_hour".
 * @returns {number|null} minutes
 */
function windowMinutesFromLabel(label) {
  if (typeof label !== 'string') return null;
  const s = label.toLowerCase();
  if (s.includes('five_hour') || s.includes('fivehour') || s.includes('5h')) return 5 * 60;
  if (s.includes('seven_day') || s.includes('sevenday') || s.includes('7d')) return 7 * 24 * 60;
  const m = s.match(/^(\d+(?:\.\d+)?)\s*(m|min|mins|minute|minutes|h|hr|hrs|hour|hours|d|day|days|w|week|weeks)$/);
  if (!m) return null;
  const n = Number(m[1]);
  const unit = RELATIVE_UNITS[m[2]];
  if (!Number.isFinite(n) || !unit) return null;
  return Math.round((n * unit) / MINUTE_MS);
}

/**
 * Normalize one rate limit window from a statusLine payload.
 *
 * Accepts snake_case (what Claude Code emits), camelCase (what a hand written
 * hook might emit) and tolerates a missing reset time.
 *
 * @param {number|null} [defaultWindowMinutes] fallback when the payload does
 *   not state the window length itself.
 * @returns {{usedPercentage:number|null, resetsAt:number|null, windowMinutes:number|null, resetsText:string|null}|null}
 */
function normalizeRateLimit(raw, defaultWindowMinutes = null) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;

  const usedPercentage = toNumber(firstDefined(raw, [
    'used_percentage', 'usedPercentage', 'percent_used', 'percentUsed',
    'utilization', 'used_pct', 'usedPct', 'percentage', 'percent',
  ]));

  const resetsAt = toEpochMs(firstDefined(raw, [
    'resets_at', 'resetsAt', 'reset_at', 'resetAt', 'resets_at_iso', 'reset',
  ]));

  const resetsTextRaw = firstDefined(raw, ['resets_text', 'resetsText', 'reset_text']);
  const resetsText = typeof resetsTextRaw === 'string' && resetsTextRaw.trim()
    ? resetsTextRaw.trim()
    : null;

  const windowMinutes = toNumber(firstDefined(raw, ['window_minutes', 'windowMinutes']))
    ?? windowMinutesFromLabel(firstDefined(raw, ['window', 'name', 'label']))
    ?? defaultWindowMinutes;

  if (usedPercentage === null && resetsAt === null && resetsText === null) return null;

  return {
    usedPercentage: usedPercentage === null ? null : clampPercent(usedPercentage),
    resetsAt,
    windowMinutes: windowMinutes === null || windowMinutes === undefined ? null : windowMinutes,
    resetsText,
  };
}

function clampPercent(n) {
  if (n < 0) return 0;
  // Overage windows legitimately report above 100, so only the floor is clamped.
  return n;
}

function normalizeModel(raw) {
  if (!raw) return null;
  if (typeof raw === 'string') return { id: raw, displayName: raw };
  if (typeof raw !== 'object') return null;
  const id = typeof raw.id === 'string' ? raw.id : (typeof raw.model === 'string' ? raw.model : null);
  const displayName = typeof raw.display_name === 'string'
    ? raw.display_name
    : (typeof raw.displayName === 'string' ? raw.displayName : id);
  if (!id && !displayName) return null;
  return { id: id || displayName, displayName: displayName || id };
}

function normalizeCost(raw) {
  if (raw === null || raw === undefined) return null;
  if (typeof raw === 'number') {
    return Number.isFinite(raw) ? { totalUsd: raw, durationMs: null, apiDurationMs: null, linesAdded: null, linesRemoved: null } : null;
  }
  if (typeof raw !== 'object') return null;
  const totalUsd = toNumber(firstDefined(raw, ['total_cost_usd', 'totalCostUsd', 'total_usd', 'usd', 'cost']));
  const durationMs = toNumber(firstDefined(raw, ['total_duration_ms', 'totalDurationMs', 'duration_ms']));
  const apiDurationMs = toNumber(firstDefined(raw, ['total_api_duration_ms', 'totalApiDurationMs', 'api_duration_ms']));
  const linesAdded = toNumber(firstDefined(raw, ['total_lines_added', 'totalLinesAdded', 'lines_added']));
  const linesRemoved = toNumber(firstDefined(raw, ['total_lines_removed', 'totalLinesRemoved', 'lines_removed']));
  if (totalUsd === null && durationMs === null && linesAdded === null && linesRemoved === null) return null;
  return { totalUsd, durationMs, apiDurationMs, linesAdded, linesRemoved };
}

/**
 * Read the quota block out of the JSON Claude Code hands a statusLine hook.
 *
 * This is the primary quota source: it is exact, it is pushed to us on every
 * status line render, and reading it costs nothing.
 *
 * @param {object|string} payload the hook JSON, already parsed or still raw
 * @returns {{five_hour:object|null, seven_day:object|null, extra:object|null, model:object|null, cost:object|null}|null}
 */
function parseStatusLinePayload(payload) {
  let data = payload;
  if (typeof data === 'string') {
    try {
      data = JSON.parse(data);
    } catch (err) {
      return null;
    }
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null;

  // The quota file we persist stores the windows at the top level, while the
  // live hook payload nests them under rate_limits. Accept both.
  const limits = (data.rate_limits && typeof data.rate_limits === 'object')
    ? data.rate_limits
    : ((data.rateLimits && typeof data.rateLimits === 'object') ? data.rateLimits : data);

  const five = normalizeRateLimit(
    firstDefined(limits, ['five_hour', 'fiveHour', 'five_hour_limit', 'session']),
    5 * 60,
  );
  const seven = normalizeRateLimit(
    firstDefined(limits, ['seven_day', 'sevenDay', 'seven_day_limit', 'week', 'weekly']),
    7 * 24 * 60,
  );
  const extra = normalizeRateLimit(
    firstDefined(limits, ['extra', 'extra_usage', 'extraUsage', 'overage', 'seven_day_opus', 'sevenDayOpus']),
    null,
  );

  const model = normalizeModel(data.model);
  const cost = normalizeCost(data.cost);

  if (!five && !seven && !extra && !model && !cost) return null;

  return { five_hour: five, seven_day: seven, extra, model, cost };
}

function matchTimeOfDay(text) {
  // Minutes are part of the same match, and a digit or colon immediately before
  // the hour rules the candidate out. Without both, "10:30am" matches on its
  // "30am" and reports a reset 30 hours out.
  const ampm = text.match(/(?<![\d:])(\d{1,2})(?::(\d{2}))?\s*(a\.?m\.?|p\.?m\.?)(?![a-z])/);
  if (ampm) {
    let hours = Number(ampm[1]);
    const minutes = ampm[2] === undefined ? 0 : Number(ampm[2]);
    if (hours < 1 || hours > 12 || minutes > 59) return null;
    const isPm = ampm[3].startsWith('p');
    if (isPm) hours = hours === 12 ? 12 : hours + 12;
    else hours = hours === 12 ? 0 : hours;
    return { hours, minutes };
  }
  const h24 = text.match(/(?<![\d:])([01]?\d|2[0-3]):([0-5]\d)(?::[0-5]\d)?(?![\d:])/);
  if (h24) return { hours: Number(h24[1]), minutes: Number(h24[2]) };
  return null;
}

function atLocalTime(baseMs, dayOffset, time) {
  const d = new Date(baseMs);
  d.setDate(d.getDate() + dayOffset);
  d.setHours(time ? time.hours : 0, time ? time.minutes : 0, 0, 0);
  return d.getTime();
}

/**
 * Turn a human reset phrase into an absolute epoch ms.
 *
 * Understands "10:30am", "10am", "3pm", "23:15", "Jan 15", "15 Jan", "Mon",
 * "Monday at 9am", "tomorrow at 8am", "in 2 hours". Returns null when nothing
 * is recognised, which is deliberate: a wrong reset time is worse than none.
 *
 * `now` is always injected so the function stays pure and testable.
 *
 * @param {number|Date} now
 * @returns {number|null} epoch ms
 */
function parseResetTime(text, now) {
  if (typeof text !== 'string') return null;
  const nowMs = toEpochMs(now);
  if (nowMs === null) return null;

  const s = text.toLowerCase().replace(/\s+/g, ' ').trim();
  if (!s) return null;

  const relative = s.match(/\bin (\d+(?:\.\d+)?) ?([a-z]+)\b/);
  if (relative) {
    const n = Number(relative[1]);
    const unit = RELATIVE_UNITS[relative[2]];
    if (Number.isFinite(n) && unit) return Math.round(nowMs + n * unit);
  }

  const time = matchTimeOfDay(s);

  const monthFirst = s.match(/\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.? (\d{1,2})(?:st|nd|rd|th)?\b/);
  const dayFirst = s.match(/\b(\d{1,2})(?:st|nd|rd|th)? (jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\b/);
  if (monthFirst || dayFirst) {
    const monthKey = monthFirst ? monthFirst[1] : dayFirst[2];
    const dayNum = Number(monthFirst ? monthFirst[2] : dayFirst[1]);
    const month = MONTHS[monthKey];
    if (month !== undefined && dayNum >= 1 && dayNum <= 31) {
      const base = new Date(nowMs);
      const d = new Date(
        base.getFullYear(), month, dayNum,
        time ? time.hours : 0, time ? time.minutes : 0, 0, 0,
      );
      // Guard against a rolled over day such as "Feb 31".
      if (d.getMonth() !== month) return null;
      if (d.getTime() <= nowMs) d.setFullYear(d.getFullYear() + 1);
      return d.getTime();
    }
  }

  if (/\btomorrow\b/.test(s)) return atLocalTime(nowMs, 1, time);
  if (/\btoday\b|\btonight\b/.test(s)) return atLocalTime(nowMs, 0, time);

  const weekday = s.match(/\b(sun|mon|tue|wed|thu|fri|sat)[a-z]*\b/);
  if (weekday) {
    const target = WEEKDAYS[weekday[1]];
    if (target !== undefined) {
      const current = new Date(nowMs).getDay();
      let diff = target - current;
      if (diff < 0) diff += 7;
      let ts = atLocalTime(nowMs, diff, time);
      if (ts <= nowMs) ts = atLocalTime(nowMs, diff + 7, time);
      return ts;
    }
  }

  if (time) {
    const ts = atLocalTime(nowMs, 0, time);
    return ts > nowMs ? ts : atLocalTime(nowMs, 1, time);
  }

  return null;
}

function startOfLocalDay(ms) {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** Monday 00:00 local, matching how the weekly quota window is presented. */
function startOfLocalWeek(ms) {
  const d = new Date(ms);
  const dow = d.getDay();
  const offset = dow === 0 ? -6 : 1 - dow;
  d.setDate(d.getDate() + offset);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/**
 * Same wall-clock time N days later. Adding `n * DAY_MS` instead lands an hour
 * off on the two days a year the local offset changes, which would announce the
 * weekly reset at 23:00 on a Sunday.
 */
function addLocalDays(ms, days) {
  const d = new Date(ms);
  d.setDate(d.getDate() + days);
  return d.getTime();
}

function makeBucket() {
  return {
    messages: 0,
    sessions: new Set(),
    inputTokens: 0,
    outputTokens: 0,
    cacheRead: 0,
    cacheCreate: 0,
    models: {},
  };
}

function finishBucket(bucket) {
  return {
    messages: bucket.messages,
    sessions: bucket.sessions.size,
    inputTokens: bucket.inputTokens,
    outputTokens: bucket.outputTokens,
    cacheRead: bucket.cacheRead,
    cacheCreate: bucket.cacheCreate,
    models: bucket.models,
  };
}

function addUsage(bucket, model, usage) {
  bucket.inputTokens += usage.input;
  bucket.outputTokens += usage.output;
  bucket.cacheRead += usage.cacheRead;
  bucket.cacheCreate += usage.cacheCreate;
  let m = bucket.models[model];
  if (!m) {
    m = { input: 0, output: 0, cacheRead: 0, cacheCreate: 0, requests: 0 };
    bucket.models[model] = m;
  }
  m.input += usage.input;
  m.output += usage.output;
  m.cacheRead += usage.cacheRead;
  m.cacheCreate += usage.cacheCreate;
  m.requests += 1;
}

function readUsageBlock(entry) {
  const msg = entry.message && typeof entry.message === 'object' ? entry.message : null;
  const raw = (msg && msg.usage) || entry.usage;
  if (!raw || typeof raw !== 'object') return null;
  return {
    input: toNumber(raw.input_tokens) || 0,
    output: toNumber(raw.output_tokens) || 0,
    cacheRead: toNumber(raw.cache_read_input_tokens) || 0,
    cacheCreate: toNumber(raw.cache_creation_input_tokens) || 0,
  };
}

/**
 * Aggregate already parsed transcript entries into today / week / five hour
 * buckets. The caller does the IO and hands over plain objects, so the maths
 * stays testable without a filesystem.
 *
 * Entries may be raw transcript lines or the compacted shape the reader emits
 * ({timestamp, type, sessionId, model, usage, messageId}).
 *
 * Timestamps returned are epoch ms; the UI formats them.
 *
 * @param {number|Date} [now]
 * @returns {{today:object, week:object, fiveHour:object, dayStart:number, weekStart:number, fiveHourStart:number, nextWeeklyReset:number, oldestInWindow:number|null, entriesCounted:number, serverTime:number}}
 */
function summarizeJsonlUsage(entries, now = Date.now()) {
  const nowMs = toEpochMs(now);
  if (nowMs === null) throw new TypeError('summarizeJsonlUsage: `now` must be an epoch or a Date');

  const dayStart = startOfLocalDay(nowMs);
  const weekStart = startOfLocalWeek(nowMs);
  const fiveHourStart = nowMs - 5 * HOUR_MS;
  // Before 05:00 on a Monday the rolling five hour window reaches back into the
  // previous week, so the entry filter has to floor on whichever bound is older
  // and each bucket re-checks its own. Flooring on weekStart alone would empty
  // the five hour window every Monday morning.
  const floor = Math.min(weekStart, fiveHourStart);

  const today = makeBucket();
  const week = makeBucket();
  const fiveHour = makeBucket();

  let oldestInWindow = null;
  let entriesCounted = 0;
  const seenMessages = new Set();

  for (const entry of Array.isArray(entries) ? entries : []) {
    if (!entry || typeof entry !== 'object') continue;

    const ts = toEpochMs(entry.timestamp || (entry.message && entry.message.timestamp));
    if (ts === null || ts < floor || ts > nowMs + DAY_MS) continue;

    const sessionId = typeof entry.sessionId === 'string' ? entry.sessionId : null;
    const usage = readUsageBlock(entry);
    const isUser = entry.type === 'user';
    if (!isUser && !usage) continue;

    // Claude Code writes local error and interrupt records as `<synthetic>`
    // assistant messages with an all zero usage block. They cost nothing and
    // would otherwise show up as a model in the breakdown.
    if (usage && !isUser
      && usage.input + usage.output + usage.cacheRead + usage.cacheCreate === 0) continue;

    // Transcript files can carry the same assistant response twice (resume,
    // sidechain replay). Counting it twice inflates the token totals.
    const messageId = entry.messageId
      || (entry.message && typeof entry.message === 'object' ? entry.message.id : null);
    if (usage && typeof messageId === 'string' && messageId) {
      if (seenMessages.has(messageId)) continue;
      seenMessages.add(messageId);
    }

    entriesCounted += 1;
    const inWeek = ts >= weekStart;
    const inToday = ts >= dayStart;
    const inFive = ts >= fiveHourStart;

    if (isUser) {
      if (inWeek) {
        week.messages += 1;
        if (sessionId) week.sessions.add(sessionId);
      }
      if (inToday) {
        today.messages += 1;
        if (sessionId) today.sessions.add(sessionId);
      }
      if (inFive) {
        fiveHour.messages += 1;
        if (sessionId) fiveHour.sessions.add(sessionId);
      }
    }

    if (usage) {
      const model = (entry.message && entry.message.model) || entry.model || 'unknown';
      if (inWeek) {
        addUsage(week, model, usage);
        if (sessionId) week.sessions.add(sessionId);
      }
      if (inToday) {
        addUsage(today, model, usage);
        if (sessionId) today.sessions.add(sessionId);
      }
      if (inFive) {
        addUsage(fiveHour, model, usage);
        if (sessionId) fiveHour.sessions.add(sessionId);
        if (oldestInWindow === null || ts < oldestInWindow) oldestInWindow = ts;
      }
    }
  }

  return {
    today: finishBucket(today),
    week: finishBucket(week),
    fiveHour: finishBucket(fiveHour),
    dayStart,
    weekStart,
    fiveHourStart,
    nextWeeklyReset: addLocalDays(weekStart, 7),
    oldestInWindow,
    entriesCounted,
    serverTime: nowMs,
  };
}

module.exports = {
  parseStatusLinePayload,
  normalizeRateLimit,
  parseResetTime,
  summarizeJsonlUsage,
  toEpochMs,
  startOfLocalDay,
  startOfLocalWeek,
  windowMinutesFromLabel,
  MINUTE_MS,
  HOUR_MS,
  DAY_MS,
};
