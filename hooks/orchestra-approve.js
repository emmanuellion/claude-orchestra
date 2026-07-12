#!/usr/bin/env node
'use strict';

/**
 * PreToolUse hook: forwards the payload to `POST /api/approvals`, which holds
 * the response open until somebody taps allow or deny in the Orchestra UI.
 *
 * The failure directions are deliberately asymmetric:
 *   - Orchestra unreachable, no URL, no token, bad response -> say nothing.
 *     Claude Code reads an empty stdout as "this hook has no opinion" and runs
 *     its normal permission flow, exactly as if the hook were not installed.
 *     Answering "ask" instead would force a prompt even for tools the user
 *     already allowed, so a merely absent control plane would change how every
 *     session behaves.
 *   - Orchestra denied, or the wait timed out server side -> "deny".
 *   - Orchestra answered "ask" on purpose (queue full) -> "ask".
 *
 * Exit code is always 0. stdout carries the verdict JSON and nothing else;
 * every diagnostic goes to stderr.
 */

const http = require('http');
const https = require('https');
const fs = require('fs');
const os = require('os');
const path = require('path');

const MAX_STDIN_BYTES = 4 * 1024 * 1024;
const DEFAULT_TIMEOUT_SEC = 300;
/** The server owns the deadline; we only need to outlive it. */
const CLIENT_MARGIN_MS = 15000;

let answered = false;

function emit(decision, reason) {
  if (answered) return;
  answered = true;
  const payload = {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: decision,
      permissionDecisionReason: reason,
    },
  };
  process.stdout.write(JSON.stringify(payload) + '\n');
}

/**
 * Declines to decide. Writing nothing to stdout leaves Claude Code's own
 * permission flow untouched: any `permissionDecision` we print, "ask"
 * included, overrides what the user configured.
 */
function passthrough(reason) {
  if (answered) return;
  answered = true;
  process.stderr.write(`orchestra-approve: standing aside (${reason})\n`);
}

function readStdin() {
  return new Promise(resolve => {
    if (process.stdin.isTTY) return resolve('');
    const chunks = [];
    let size = 0;
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      resolve(Buffer.concat(chunks).toString('utf-8'));
    };
    process.stdin.on('data', chunk => {
      size += chunk.length;
      if (size > MAX_STDIN_BYTES) {
        process.stdin.destroy();
        return finish();
      }
      chunks.push(chunk);
    });
    process.stdin.on('end', finish);
    process.stdin.on('error', err => {
      process.stderr.write(`orchestra-approve: stdin error: ${err.message}\n`);
      finish();
    });
  });
}

function readTokenFile() {
  const file = path.join(os.homedir(), '.claude', 'orchestra', 'session-token');
  try {
    const value = fs.readFileSync(file, 'utf-8').trim();
    return value.length >= 32 ? value : '';
  } catch (e) {
    if (e.code !== 'ENOENT') {
      process.stderr.write(`orchestra-approve: cannot read ${file}: ${e.message}\n`);
    }
    return '';
  }
}

/**
 * Minimal POST on node:http so the hook keeps working under whatever Node
 * version is on PATH, and so the socket timeout is ours to set.
 *
 * @returns {Promise<{status:number, body:string}>}
 */
function postJson(target, body, token, timeoutMs) {
  return new Promise((resolve, reject) => {
    let url;
    try {
      url = new URL(target);
    } catch (e) {
      return reject(new Error(`bad ORCHESTRA_URL: ${e.message}`));
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      return reject(new Error(`unsupported ORCHESTRA_URL protocol ${url.protocol}`));
    }
    const transport = url.protocol === 'https:' ? https : http;
    const payload = Buffer.from(body, 'utf-8');

    const req = transport.request(
      {
        protocol: url.protocol,
        hostname: url.hostname,
        port: url.port || (url.protocol === 'https:' ? 443 : 80),
        path: url.pathname + url.search,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': payload.length,
          Authorization: `Bearer ${token}`,
          'X-Orchestra-Token': token,
        },
      },
      res => {
        const chunks = [];
        res.on('data', c => chunks.push(c));
        res.on('end', () => {
          resolve({ status: res.statusCode || 0, body: Buffer.concat(chunks).toString('utf-8') });
        });
      }
    );

    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error(`no answer from Orchestra after ${Math.round(timeoutMs / 1000)}s`));
    });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

async function main() {
  const raw = await readStdin();

  let hook = {};
  if (raw.trim()) {
    try {
      hook = JSON.parse(raw);
    } catch (e) {
      return passthrough(`unreadable hook payload: ${e.message}`);
    }
  }
  if (!hook || typeof hook !== 'object') hook = {};

  const base = (process.env.ORCHESTRA_URL || '').trim().replace(/\/+$/, '');
  if (!base) {
    return passthrough('ORCHESTRA_URL is unset, so this session is not managed by Orchestra');
  }

  const token = (process.env.ORCHESTRA_TOKEN || '').trim() || readTokenFile();
  if (!token) {
    return passthrough('no Orchestra token in the environment or the token file');
  }

  const seconds = Number.parseInt(process.env.ORCHESTRA_APPROVAL_TIMEOUT, 10);
  const timeoutSec = Number.isFinite(seconds) && seconds > 0 ? seconds : DEFAULT_TIMEOUT_SEC;

  const body = JSON.stringify({
    orchestraSessionId: process.env.ORCHESTRA_SESSION_ID || null,
    raceId: process.env.ORCHESTRA_RACE_ID || null,
    raceVariant: process.env.ORCHESTRA_RACE_VARIANT || null,
    hookEventName: hook.hook_event_name || 'PreToolUse',
    claudeSessionId: hook.session_id || null,
    transcriptPath: hook.transcript_path || null,
    permissionMode: hook.permission_mode || null,
    cwd: hook.cwd || process.cwd(),
    tool: hook.tool_name || null,
    input: hook.tool_input || {},
    timeoutSec,
  });

  let response;
  try {
    response = await postJson(base + '/api/approvals', body, token, timeoutSec * 1000 + CLIENT_MARGIN_MS);
  } catch (e) {
    return passthrough(`Orchestra unreachable: ${e.message}`);
  }

  if (response.status === 401 || response.status === 403) {
    return passthrough(`Orchestra rejected the hook credentials (HTTP ${response.status})`);
  }
  if (response.status < 200 || response.status >= 300) {
    return passthrough(`Orchestra returned HTTP ${response.status}`);
  }

  let verdict;
  try {
    verdict = JSON.parse(response.body);
  } catch (e) {
    return passthrough(`Orchestra sent an unreadable response: ${e.message}`);
  }

  if (!verdict || typeof verdict !== 'object') {
    return passthrough('Orchestra sent a response that is not a JSON object');
  }

  const reason = typeof verdict.reason === 'string' && verdict.reason
    ? verdict.reason
    : 'Decided in Orchestra.';

  if (verdict.decision === 'allow') return emit('allow', `Approved in Orchestra: ${reason}`);
  if (verdict.decision === 'deny') return emit('deny', `Denied in Orchestra: ${reason}`);
  // Orchestra can decide to abstain, for instance when its queue is full. That
  // is a deliberate "let a human answer in the terminal", not a failure.
  if (verdict.decision === 'ask') return emit('ask', `Orchestra deferred to you: ${reason}`);

  return passthrough(`Orchestra returned no usable decision (${reason})`);
}

/** Whatever broke, the hook stands aside; the stack stays behind the flag. */
function standAside(label, err) {
  if (process.env.ORCHESTRA_DEBUG && err && err.stack) process.stderr.write(`${err.stack}\n`);
  passthrough(`${label}: ${err && err.message ? err.message : err}`);
}

main().catch(err => standAside('hook failed', err));

process.on('uncaughtException', err => {
  standAside('uncaught error', err);
  process.exit(0);
});
