'use strict';

const os = require('os');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const HOME = os.homedir();
const IS_WIN = os.platform() === 'win32';
const ROOT = path.join(__dirname, '..');

const CLAUDE_DIR = path.join(HOME, '.claude');
const ORCHESTRA_DIR = path.join(CLAUDE_DIR, 'orchestra');

function ensureDir(dir) {
  try { fs.mkdirSync(dir, { recursive: true }); } catch {}
  return dir;
}

/** Absent means `fallback`; anything but the usual falsey spellings is true. */
function envFlag(name, fallback) {
  const v = process.env[name];
  if (v === undefined || v === '') return fallback;
  return !['0', 'false', 'no', 'off'].includes(String(v).toLowerCase());
}

function envInt(name, fallback) {
  const n = parseInt(process.env[name], 10);
  return Number.isFinite(n) ? n : fallback;
}

/**
 * Below the floor a human on a phone cannot answer in time and every request
 * fails closed; above the ceiling an agent blocked overnight outlives its
 * operator, which is the case the deadline exists to prevent.
 */
const APPROVAL_TIMEOUT_MIN_S = 10;
const APPROVAL_TIMEOUT_MAX_S = 3600;

function clampApprovalSeconds(seconds) {
  if (!Number.isFinite(seconds)) return 300;
  return Math.min(APPROVAL_TIMEOUT_MAX_S, Math.max(APPROVAL_TIMEOUT_MIN_S, seconds));
}

/**
 * Shortest token accepted anywhere. The hooks apply the same floor to the token
 * file, so one number has to hold for the environment, the CLI flag and the
 * file, otherwise a token accepted at startup is rejected later by a hook.
 */
const MIN_TOKEN_LENGTH = 32;

/**
 * The session token, persisted under ~/.claude/orchestra rather than
 * regenerated per boot: hooks run in their own processes and, when they were
 * not started from an Orchestra PTY, the file is the only way they can
 * authenticate. A token supplied through the environment is written there too,
 * otherwise those hooks keep presenting the token of a previous run.
 */
function loadOrCreateToken() {
  const file = path.join(ensureDir(ORCHESTRA_DIR), 'session-token');
  if (envFlag('ORCHESTRA_ROTATE_TOKEN', false)) {
    try { fs.unlinkSync(file); } catch {}
  }

  const fromEnv = String(process.env.ORCHESTRA_TOKEN || '').trim();
  if (fromEnv) {
    if (fromEnv.length < MIN_TOKEN_LENGTH) {
      throw new Error(
        `ORCHESTRA_TOKEN is ${fromEnv.length} characters; at least ${MIN_TOKEN_LENGTH} are required. `
        + 'That token is the only thing between this port and a shell, and nothing here rate limits '
        + 'guesses. Generate one with: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))" '
        + 'or unset ORCHESTRA_TOKEN and let Orchestra create one.'
      );
    }
    persistToken(file, fromEnv);
    return fromEnv;
  }

  try {
    const existing = fs.readFileSync(file, 'utf-8').trim();
    if (existing.length >= MIN_TOKEN_LENGTH) return existing;
  } catch {}
  const token = crypto.randomBytes(32).toString('hex');
  persistToken(file, token);
  return token;
}

function persistToken(file, token) {
  try {
    fs.writeFileSync(file, token, { mode: 0o600 });
  } catch (err) {
    // Not fatal: hooks started from an Orchestra PTY inherit ORCHESTRA_TOKEN
    // and never read the file. Say so once instead of failing the boot.
    process.stderr.write(`orchestra: could not store the token in ${file}: ${err.message}\n`);
  }
}

const port = envInt('PORT', 3000);
const host = process.env.HOST || '127.0.0.1';
const isLoopback = host === '127.0.0.1' || host === '::1' || host === 'localhost';

const config = {
  HOME,
  IS_WIN,

  port,
  host,
  isLoopback,

  MIN_TOKEN_LENGTH,

  /**
   * Named recipe from .orchestra.json to apply on start. `--workspace` sets
   * ORCHESTRA_WORKSPACE before this module is required, exactly like PORT and
   * HOST, so the flag and the environment variable are one contract.
   */
  workspace: process.env.ORCHESTRA_WORKSPACE || null,

  /** Extra origins accepted on the WS upgrade, comma separated. */
  extraOrigins: (process.env.ORCHESTRA_ORIGINS || '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean),

  token: loadOrCreateToken(),

  /** Refuse to bind a non-loopback host unless the operator opts in. */
  allowRemote: envFlag('ORCHESTRA_ALLOW_REMOTE', false),

  orchestraDir: ensureDir(ORCHESTRA_DIR),
  settingsFile: path.join(CLAUDE_DIR, 'settings.json'),
  projectsDir: path.join(CLAUDE_DIR, 'projects'),
  historyFile: path.join(CLAUDE_DIR, 'history.jsonl'),
  quotaFile: path.join(CLAUDE_DIR, 'orchestra-quota.json'),

  approvalRulesFile: path.join(ORCHESTRA_DIR, 'approval-rules.json'),
  auditLogFile: path.join(ORCHESTRA_DIR, 'audit.log'),
  eventsDir: ensureDir(path.join(ORCHESTRA_DIR, 'events')),
  racesDir: ensureDir(path.join(ORCHESTRA_DIR, 'races')),
  scoreboardFile: path.join(ORCHESTRA_DIR, 'scoreboard.json'),

  hooksDir: path.join(ROOT, 'hooks'),

  /**
   * Seconds a blocked PreToolUse request waits before failing closed. The
   * `timeout` written into ~/.claude/settings.json comes from hooks-install, so
   * changing this needs a hook reinstall or the hook gives up first.
   */
  approvalTimeoutMs: clampApprovalSeconds(envInt('ORCHESTRA_APPROVAL_TIMEOUT', 300)) * 1000,

  /** How long a detached session survives with nobody watching; 0 is forever. */
  detachTtlMs: envInt('ORCHESTRA_DETACH_TTL', 0) * 1000,
  shellDetachTtlMs: envInt('ORCHESTRA_SHELL_DETACH_TTL', 24 * 3600) * 1000,

  defaultShell: IS_WIN
    ? (process.env.COMSPEC || 'cmd.exe')
    : (process.env.SHELL || '/bin/bash'),

  claudeBin: process.env.ORCHESTRA_CLAUDE_BIN || 'claude',

  /**
   * Records the address actually bound. The port matters beyond bookkeeping:
   * the allowed-origin set is built from it, so a server started on a
   * non-default port would otherwise reject its own page.
   */
  setRuntime({ port: p, host: h }) {
    if (Number.isFinite(p)) config.port = p;
    if (h) {
      config.host = h;
      config.isLoopback = ['127.0.0.1', '::1', 'localhost'].includes(h);
    }
    return config;
  },

  get baseUrl() {
    const h = config.isLoopback ? '127.0.0.1' : config.host;
    return `http://${h}:${config.port}`;
  },
};

module.exports = config;
