#!/usr/bin/env node
'use strict';

/**
 * Claude Code statusLine hook. Two jobs, both load bearing:
 *   1. persist the exact rate limits to ~/.claude/orchestra-quota.json, the
 *      Orchestra UI's primary quota source;
 *   2. print a status line on stdout. Claude Code renders whatever a statusLine
 *      command writes there, so a hook that only wrote the file would blank the
 *      user's status bar the moment Orchestra installs itself.
 *
 * Exit code is always 0, and a failure prints nothing rather than garbage: a
 * wrong status bar is worse than the default one.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

const MAX_STDIN_BYTES = 1024 * 1024;
const SEPARATOR = '  |  ';

/**
 * The shared parser understands every spelling of the payload Claude Code has
 * shipped, but the status bar must survive a half-installed checkout, so a
 * failed require degrades to the few fields we can read here rather than
 * killing the line.
 */
let parseStatusLinePayload = null;
try {
  ({ parseStatusLinePayload } = require('../lib/usage-parser'));
} catch (err) {
  process.stderr.write(`quota-hook: falling back to minimal parsing (${err.message})\n`);
}

function readStdin() {
  return new Promise(resolve => {
    if (process.stdin.isTTY) return resolve('');
    let input = '';
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      resolve(input);
    };
    process.stdin.setEncoding('utf-8');
    process.stdin.on('data', chunk => {
      input += chunk;
      if (input.length > MAX_STDIN_BYTES) {
        process.stdin.destroy();
        finish();
      }
    });
    process.stdin.on('end', finish);
    process.stdin.on('error', err => {
      process.stderr.write(`quota-hook: stdin error: ${err.message}\n`);
      finish();
    });
  });
}

/** Persist the quota block. Atomic: the UI polls this file while we write it. */
function writeQuotaFile(data) {
  const file = path.join(os.homedir(), '.claude', 'orchestra-quota.json');
  const tmp = `${file}.${process.pid}.tmp`;
  const payload = JSON.stringify({
    five_hour: data.rate_limits.five_hour || null,
    seven_day: data.rate_limits.seven_day || null,
    model: data.model || null,
    cost: data.cost || null,
    updated: Date.now(),
  });
  try {
    fs.writeFileSync(tmp, payload, 'utf-8');
    fs.renameSync(tmp, file);
  } catch (err) {
    process.stderr.write(`quota-hook: cannot write ${file}: ${err.message}\n`);
    try { fs.unlinkSync(tmp); } catch { /* the temp file may never have been created */ }
  }
}

function modelName(data, parsed) {
  if (parsed && parsed.model) return parsed.model.displayName || parsed.model.id;
  const m = data && data.model;
  if (typeof m === 'string') return m;
  if (m && typeof m === 'object') {
    return m.display_name || m.displayName || m.id || null;
  }
  return null;
}

function directoryName(data) {
  const ws = data && data.workspace;
  const dir = (ws && (ws.current_dir || ws.currentDir || ws.project_dir))
    || (data && data.cwd)
    || null;
  return dir ? path.basename(String(dir)) : null;
}

/** "5h 42%", plus the weekly window when it is known. */
function quotaText(parsed) {
  if (!parsed) return null;
  const parts = [];
  const add = (label, window) => {
    if (window && typeof window.usedPercentage === 'number') {
      parts.push(`${label} ${Math.round(window.usedPercentage)}%`);
    }
  };
  add('5h', parsed.five_hour);
  add('7d', parsed.seven_day);
  return parts.length ? parts.join(' ') : null;
}

async function main() {
  const raw = await readStdin();
  if (!raw.trim()) return;

  let data;
  try {
    data = JSON.parse(raw);
  } catch (err) {
    process.stderr.write(`quota-hook: unreadable status line payload: ${err.message}\n`);
    return;
  }
  if (!data || typeof data !== 'object') return;

  if (data.rate_limits && typeof data.rate_limits === 'object') {
    writeQuotaFile(data);
  }

  let parsed = null;
  if (parseStatusLinePayload) {
    try {
      parsed = parseStatusLinePayload(data);
    } catch (err) {
      process.stderr.write(`quota-hook: cannot read the quota block: ${err.message}\n`);
    }
  }

  const line = [modelName(data, parsed), directoryName(data), quotaText(parsed)]
    .filter(Boolean)
    .join(SEPARATOR);
  if (line) process.stdout.write(line + '\n');
}

main().catch(err => {
  process.stderr.write(`quota-hook: ${err && err.message ? err.message : err}\n`);
});
