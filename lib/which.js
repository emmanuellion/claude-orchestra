'use strict';

const fs = require('fs');
const path = require('path');
const config = require('./config');

/**
 * Resolve a command name against PATH the way the shell would, so we can spawn
 * the real binary instead of writing its name into a shell and hoping. Returns
 * the absolute path, or null; on Windows it may be a `.cmd`/`.bat` shim, which
 * `needsShim` identifies for the caller.
 */
function which(cmd) {
  if (!cmd) return null;
  if (cmd.includes('/') || cmd.includes('\\')) {
    return isExecutable(cmd) ? cmd : null;
  }

  const dirs = (process.env.PATH || '').split(path.delimiter).filter(Boolean);
  const exts = config.IS_WIN
    ? (process.env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean)
    : [''];

  for (const dir of dirs) {
    for (const ext of exts) {
      const candidate = path.join(dir, cmd + ext);
      if (isExecutable(candidate)) return candidate;
    }
  }
  return null;
}

function isExecutable(p) {
  try {
    const st = fs.statSync(p);
    if (!st.isFile()) return false;
    if (config.IS_WIN) return true;
    fs.accessSync(p, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** True when the resolved path is a Windows batch shim that needs cmd.exe. */
function needsShim(resolved) {
  if (!resolved || !config.IS_WIN) return false;
  const ext = path.extname(resolved).toLowerCase();
  return ext === '.cmd' || ext === '.bat';
}

/**
 * Split a user-typed argument string into argv, honouring single and double
 * quotes, so `--model "claude x"; rm -rf ~` reaches the binary as literal text
 * rather than as a second shell command.
 */
function splitArgs(str) {
  if (!str) return [];
  const out = [];
  let cur = '';
  let quote = null;
  let started = false;

  for (let i = 0; i < str.length; i++) {
    const ch = str[i];
    if (quote) {
      if (ch === quote) quote = null;
      else cur += ch;
      continue;
    }
    if (ch === '"' || ch === "'") { quote = ch; started = true; continue; }
    if (/\s/.test(ch)) {
      if (started || cur) { out.push(cur); cur = ''; started = false; }
      continue;
    }
    cur += ch;
    started = true;
  }
  if (started || cur) out.push(cur);
  return out;
}

module.exports = { which, needsShim, splitArgs };
