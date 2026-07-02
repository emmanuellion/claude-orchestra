#!/usr/bin/env node
'use strict';

/**
 * Claude Code hook shim: `node orchestra-hook.js <EventName>` reads the event
 * payload on stdin, stamps it with the identity of the PTY it runs inside, and
 * POSTs it to the server.
 *
 * Three rules govern everything below:
 *   1. Never fail a tool call. Every path exits 0 and nothing outlives the
 *      deadline.
 *   2. Never write to stdout. Claude Code parses a hook's stdout as control
 *      output; a stray line there can block or rewrite a tool call.
 *      Diagnostics go to stderr through fs.writeSync so they survive exit().
 *   3. Stay standalone. Installed globally, it also runs in terminals Orchestra
 *      never spawned, so it requires nothing from the repo and reads its
 *      configuration from the environment only. Hence the env var names as
 *      literals here rather than from lib/protocol.js.
 */

const fs = require('fs');

const REQUEST_TIMEOUT_MS = 1500;
/** Covers a stdin that never reaches EOF, on top of the request timeout. */
const HARD_DEADLINE_MS = 2500;
const MAX_STDIN_BYTES = 1024 * 1024;
const MAX_STDERR_LINE = 400;

const deadline = setTimeout(() => {
  warn('orchestra-hook: deadline reached, giving up');
  finish();
}, HARD_DEADLINE_MS);

function warn(message) {
  try {
    fs.writeSync(2, String(message).slice(0, MAX_STDERR_LINE) + '\n');
  } catch {
    // stderr itself is gone (closed pipe). Nothing left to report it with, and
    // the hook must still exit 0, so this is the one place we can only drop it.
  }
}

function finish() {
  clearTimeout(deadline);
  process.exit(0);
}

/**
 * Reads all of stdin, capped. Over the cap we keep the head and flag the
 * payload as truncated rather than dropping the event: knowing that an event
 * happened is worth more than its arguments.
 *
 * @returns {Promise<{text: string, truncated: boolean}>}
 */
function readStdin(maxBytes) {
  return new Promise(resolve => {
    const stdin = process.stdin;
    if (stdin.isTTY) {
      resolve({ text: '', truncated: false });
      return;
    }
    const chunks = [];
    let size = 0;
    let truncated = false;
    let done = false;

    const settle = () => {
      if (done) return;
      done = true;
      resolve({ text: Buffer.concat(chunks).toString('utf8'), truncated });
    };

    stdin.on('data', chunk => {
      if (truncated) return;
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
      if (size + buf.length > maxBytes) {
        const keep = maxBytes - size;
        if (keep > 0) chunks.push(buf.subarray(0, keep));
        size = maxBytes;
        truncated = true;
        return;
      }
      chunks.push(buf);
      size += buf.length;
    });
    stdin.on('end', settle);
    stdin.on('close', settle);
    stdin.on('error', err => {
      warn(`orchestra-hook: stdin error ${err && err.message}`);
      settle();
    });
  });
}

/** Event names come from argv and end up in a URL path, so they stay strict. */
function normalizeEventName(raw) {
  const name = String(raw || '').trim();
  return /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(name) ? name : null;
}

async function main() {
  const { text, truncated } = await readStdin(MAX_STDIN_BYTES);

  const url = String(process.env.ORCHESTRA_URL || '').trim().replace(/\/+$/, '');
  const token = String(process.env.ORCHESTRA_TOKEN || '').trim();
  // Not an Orchestra terminal. Installed globally, so this is the normal case
  // in a plain shell, and it must stay completely silent.
  if (!url || !token) return;

  let payload = null;
  let parseError = null;
  if (text) {
    try {
      const parsed = JSON.parse(text);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) payload = parsed;
      else parseError = 'payload was not a JSON object';
    } catch (err) {
      parseError = String((err && err.message) || err);
    }
  }

  const event = normalizeEventName(process.argv[2])
    || normalizeEventName(payload && payload.hook_event_name);
  if (!event) {
    warn('orchestra-hook: missing or invalid event name');
    return;
  }

  const body = {
    ...(payload || {}),
    hook_event_name: (payload && payload.hook_event_name) || event,
    orchestraEvent: event,
    orchestraTs: Date.now(),
    orchestraSessionId: process.env.ORCHESTRA_SESSION_ID || null,
    orchestraRaceId: process.env.ORCHESTRA_RACE_ID || null,
    orchestraRaceVariant: process.env.ORCHESTRA_RACE_VARIANT || null,
  };
  if (truncated) body.orchestraTruncated = true;
  if (parseError) body.orchestraParseError = parseError.slice(0, 200);

  let endpoint;
  try {
    endpoint = new URL(`/api/hooks/event/${encodeURIComponent(event)}`, url).toString();
  } catch (err) {
    warn(`orchestra-hook: bad ORCHESTRA_URL "${url}" (${err && err.message})`);
    return;
  }

  let serialized;
  try {
    serialized = JSON.stringify(body);
  } catch (err) {
    // A tool_input holding a circular structure would land here.
    warn(`orchestra-hook: could not serialize ${event} (${err && err.message})`);
    serialized = JSON.stringify({
      hook_event_name: event,
      orchestraEvent: event,
      orchestraTs: Date.now(),
      orchestraSessionId: process.env.ORCHESTRA_SESSION_ID || null,
      orchestraSerializeError: true,
    });
  }

  const res = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: serialized,
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });

  // Draining keeps the socket from lingering past process exit.
  const replyText = await res.text();
  if (!res.ok) {
    warn(`orchestra-hook: ${event} -> HTTP ${res.status} ${replyText.slice(0, 200)}`);
  }
}

main().then(finish, err => {
  // AbortError is the expected shape when the server is slow or gone. Still
  // reported: a hook that drops events silently is impossible to diagnose.
  warn(`orchestra-hook: ${(err && err.message) || String(err)}`);
  finish();
});
