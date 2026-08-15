#!/usr/bin/env node
'use strict';

/**
 * `npx claude-orchestra` entry point.
 *
 * The contract it is written against, provided by server.js:
 *   - `start({ port, host, cwd, workspace, open })` resolves once listening,
 *     with `{ url, port, host, token, close?/stop? }`, and rejects with
 *     `code === 'EADDRINUSE'` when the port is taken. This file turns that
 *     rejection into "already running, here it is", never a stack trace.
 *   - `close()`/`stop()` are optional; SIGINT awaits one with a deadline.
 *   - `GET /api/health` answers without a token, with a body carrying
 *     `product: 'claude-orchestra'`. That is what lets a second `npx` open the
 *     running instance instead of dying on a port conflict.
 *   - `cwd` is the directory the user typed the command in, which is what turns
 *     launching, opening a browser and picking a folder into one gesture.
 */

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

const PKG_PATH = path.join(__dirname, '..', 'package.json');

const VALUE_FLAGS = new Set(['--port', '--host', '--cwd', '--workspace', '--token']);

function readVersion() {
  try {
    return String(JSON.parse(fs.readFileSync(PKG_PATH, 'utf-8')).version || '0.0.0');
  } catch (err) {
    process.stderr.write(`Could not read ${PKG_PATH}: ${err.message}\n`);
    return '0.0.0';
  }
}

function helpText() {
  return [
    'claude-orchestra - control plane for a swarm of Claude Code agents',
    '',
    'Usage:',
    '  npx claude-orchestra [directory] [options]',
    '',
    'Options:',
    '  -p, --port <n>         Port to listen on (default 3000, or $PORT)',
    '      --host <h>         Address to bind (default 127.0.0.1, or $HOST)',
    '      --cwd <path>       Directory the first agent starts in (default: here)',
    '      --workspace <name> Apply a named recipe from .orchestra.json on start',
    '      --token <t>        Use this access token instead of the stored one (32+ characters)',
    '      --open             Open the browser once ready (default)',
    '      --no-open          Do not open the browser',
    '  -v, --version          Print the version and exit',
    '  -h, --help             Print this help and exit',
    '',
    'Examples:',
    '  npx claude-orchestra                     Serve the current directory',
    '  npx claude-orchestra ../api --port 3100  Serve another repo on another port',
    '  npx claude-orchestra --no-open           Headless, print the URL only',
    '',
  ].join('\n');
}

/**
 * Hand-rolled parser: the flag set is small enough that a library would be more
 * surface than help. Pure (no fs, no env, no exit) so it can be tested.
 *
 * @param {string[]} argv arguments after `node cli.js`
 * @returns {{options: object, errors: string[]}}
 */
function parseArgs(argv) {
  const options = {
    port: null,
    host: null,
    cwd: null,
    workspace: null,
    token: null,
    open: true,
    help: false,
    version: false,
  };
  const errors = [];
  const positionals = [];

  for (let i = 0; i < argv.length; i++) {
    const raw = String(argv[i]);
    let flag = raw;
    let inlineValue = null;

    if (raw.startsWith('--')) {
      const eq = raw.indexOf('=');
      if (eq !== -1) {
        flag = raw.slice(0, eq);
        inlineValue = raw.slice(eq + 1);
      }
    }

    const takeValue = () => {
      if (inlineValue !== null) return inlineValue;
      const next = argv[i + 1];
      if (next === undefined || (String(next).startsWith('-') && String(next) !== '-')) {
        errors.push(`${flag} needs a value`);
        return null;
      }
      i += 1;
      return String(next);
    };

    if (!VALUE_FLAGS.has(flag) && inlineValue !== null) {
      errors.push(`${flag} does not take a value`);
      continue;
    }

    switch (flag) {
      case '-h':
      case '--help':
        options.help = true;
        break;
      case '-v':
      case '--version':
        options.version = true;
        break;
      case '--open':
        options.open = true;
        break;
      case '--no-open':
        options.open = false;
        break;
      case '-p':
      case '--port': {
        const v = takeValue();
        if (v === null) break;
        if (!/^\d+$/.test(v)) {
          errors.push(`--port expects a number, got "${v}"`);
          break;
        }
        const n = Number(v);
        if (n < 1 || n > 65535) {
          errors.push(`--port must be between 1 and 65535, got ${n}`);
          break;
        }
        options.port = n;
        break;
      }
      case '--host': {
        const v = takeValue();
        if (v !== null) options.host = v;
        break;
      }
      case '--cwd': {
        const v = takeValue();
        if (v !== null) options.cwd = path.resolve(v);
        break;
      }
      case '--workspace': {
        const v = takeValue();
        if (v !== null) options.workspace = v;
        break;
      }
      case '--token': {
        const v = takeValue();
        if (v === null) break;
        // Same floor as lib/config.MIN_TOKEN_LENGTH and as the token file the
        // hooks read back. Hardcoded rather than imported because this parser
        // must stay pure: requiring config creates directories and a token.
        if (v.length < 32) {
          errors.push('--token must be at least 32 characters');
          break;
        }
        options.token = v;
        break;
      }
      default:
        if (raw.startsWith('-') && raw !== '-') errors.push(`unknown option "${raw}"`);
        else positionals.push(raw);
    }
  }

  if (positionals.length > 1) {
    errors.push(`expected at most one directory, got ${positionals.length}`);
  } else if (positionals.length === 1 && options.cwd === null) {
    options.cwd = path.resolve(positionals[0]);
  } else if (positionals.length === 1) {
    errors.push('a directory and --cwd were both given, pick one');
  }

  return { options, errors };
}

function formatHost(host) {
  if (host.includes(':') && !host.startsWith('[')) return `[${host}]`;
  return host;
}

/** The address a browser on this machine can actually reach. */
function browsableHost(host) {
  if (host === '0.0.0.0' || host === '::' || host === '[::]') return '127.0.0.1';
  return host;
}

function localBase(host, port) {
  return `http://${formatHost(browsableHost(host))}:${port}`;
}

/**
 * Is something on this port a running Orchestra? A failed probe is a legitimate
 * answer here ("not us"), not a swallowed error, so it resolves to null; the
 * reason is still printed under ORCHESTRA_DEBUG.
 */
async function probeHealth(host, port) {
  const url = `${localBase(host, port)}/api/health`;
  try {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(1500),
      headers: { accept: 'application/json' },
    });
    if (!res.ok) return null;
    const body = await res.json();
    if (!body || typeof body !== 'object') return null;
    // Only the documented shape: this answer decides whether we treat the port
    // as ours, and a looser match covers almost any local service.
    return body.product === 'claude-orchestra' ? body : null;
  } catch (err) {
    if (process.env.ORCHESTRA_DEBUG) {
      process.stderr.write(`health probe on ${url} failed: ${err.message}\n`);
    }
    return null;
  }
}

/**
 * Ask the desktop to open a URL. Resolves with null on success or the Error on
 * failure: a browser that will not open must never take the server down with
 * it, the URL is printed either way.
 */
function openBrowser(url) {
  return new Promise((resolve) => {
    if (!/^https?:\/\//.test(url)) {
      resolve(new Error(`refusing to open a non-http url: ${url}`));
      return;
    }
    let file;
    let args;
    if (process.platform === 'win32') {
      // The empty string is the window title `start` insists on consuming;
      // without it, a quoted URL would be taken as the title and nothing opens.
      file = process.env.COMSPEC || 'cmd.exe';
      args = ['/c', 'start', '', url];
    } else if (process.platform === 'darwin') {
      file = 'open';
      args = [url];
    } else {
      file = 'xdg-open';
      args = [url];
    }
    execFile(file, args, { windowsHide: true }, (err) => resolve(err || null));
  });
}

async function openAndReport(url) {
  const err = await openBrowser(url);
  if (err) {
    process.stdout.write(`Could not open a browser (${err.message}).\n`);
    process.stdout.write(`Open ${url} yourself.\n`);
  }
}

/**
 * Builds a link that authenticates by itself. Nothing in this file uses it: the
 * page served on `/` carries the token inline. It is kept for the places that
 * need a standalone link, such as the QR code shown for a phone.
 */
function urlWithToken(baseUrl, token) {
  if (!token) return baseUrl;
  const sep = baseUrl.includes('?') ? '&' : '?';
  return `${baseUrl}${sep}token=${encodeURIComponent(token)}`;
}

/**
 * A second `npx claude-orchestra` should land the user in the instance already
 * running, not in an error; anything else on the port gets an actionable
 * message.
 *
 * The URL carries no token on purpose. We did not start whatever answers there
 * and a health response proves nothing, since any local process can copy the
 * body. If it really is Orchestra its own page authenticates the browser; if it
 * is not, an impostor gets nothing out of us.
 */
async function handlePortInUse(host, port, shouldOpen) {
  const health = await probeHealth(host, port);
  const base = localBase(host, port);

  if (!health) {
    process.stderr.write(`Port ${port} is already in use by another program.\n`);
    process.stderr.write(`Start Orchestra somewhere else, for example:\n`);
    process.stderr.write(`  npx claude-orchestra --port ${port + 1}\n`);
    return 1;
  }

  process.stdout.write(`Claude Orchestra is already running on ${base}\n`);
  if (health.version) process.stdout.write(`  version ${health.version}\n`);
  process.stdout.write('Reusing it instead of starting a second one.\n');
  if (shouldOpen) await openAndReport(base);
  else process.stdout.write(`  ${base}\n`);
  return 0;
}

/**
 * Turns a failed `server.start` into one line the user can act on. A stack
 * trace would bury that line; it stays available behind ORCHESTRA_DEBUG.
 */
function reportStartFailure(err, host, port) {
  const message = err && err.message ? err.message : String(err);
  process.stderr.write(`claude-orchestra: failed to start: ${message}\n`);

  const code = err && err.code;
  if (code === 'EACCES') {
    process.stderr.write(`Port ${port} needs elevated rights on this system; pick one above 1024:\n`);
    process.stderr.write('  npx claude-orchestra --port 3000\n');
  } else if (code === 'EADDRNOTAVAIL') {
    process.stderr.write(`No interface on this machine carries ${host}; bind an address it has, or 127.0.0.1.\n`);
  }

  if (process.env.ORCHESTRA_DEBUG && err && err.stack) {
    process.stderr.write(`${err.stack}\n`);
  }
}

function installSignalHandlers(info) {
  let closing = false;
  let stop = null;
  if (info && typeof info.close === 'function') stop = info.close;
  else if (info && typeof info.stop === 'function') stop = info.stop;

  const shutdown = async (signal) => {
    if (closing) {
      // A second Ctrl+C means the user is done waiting for a clean shutdown.
      process.exit(1);
      return;
    }
    closing = true;
    process.stdout.write(`\nStopping Orchestra (${signal}).\n`);
    if (stop) {
      try {
        await Promise.race([
          Promise.resolve(stop.call(info)),
          new Promise((resolve) => setTimeout(resolve, 3000).unref()),
        ]);
      } catch (err) {
        process.stderr.write(`Shutdown reported an error: ${err.message}\n`);
      }
    }
    process.exit(0);
  };
  process.on('SIGINT', () => { shutdown('SIGINT'); });
  process.on('SIGTERM', () => { shutdown('SIGTERM'); });
}

async function main(argv) {
  const { options, errors } = parseArgs(argv);

  if (options.help) {
    process.stdout.write(helpText());
    return 0;
  }
  if (options.version) {
    process.stdout.write(`${readVersion()}\n`);
    return 0;
  }
  if (errors.length) {
    for (const e of errors) process.stderr.write(`claude-orchestra: ${e}\n`);
    process.stderr.write('Run "npx claude-orchestra --help" for the full list.\n');
    return 2;
  }

  const cwd = options.cwd || process.cwd();
  let stat = null;
  try {
    stat = fs.statSync(cwd);
  } catch (err) {
    process.stderr.write(`claude-orchestra: cannot use ${cwd} (${err.code || err.message})\n`);
    return 2;
  }
  if (!stat.isDirectory()) {
    process.stderr.write(`claude-orchestra: ${cwd} is not a directory\n`);
    return 2;
  }

  // config.js reads these once, at require time, so they have to be in place
  // before anything below pulls it in. ORCHESTRA_WORKSPACE included: config
  // exposes it as `config.workspace`, which is what start() receives when the
  // flag is absent.
  if (options.port !== null) process.env.PORT = String(options.port);
  if (options.host !== null) process.env.HOST = options.host;
  if (options.token !== null) process.env.ORCHESTRA_TOKEN = options.token;
  if (options.workspace !== null) process.env.ORCHESTRA_WORKSPACE = options.workspace;

  let config;
  try {
    config = require('../lib/config');
  } catch (err) {
    process.stderr.write(`claude-orchestra: configuration failed to load: ${err.message}\n`);
    return 1;
  }

  const port = options.port !== null ? options.port : config.port;
  const host = options.host !== null ? options.host : config.host;
  const workspace = options.workspace !== null ? options.workspace : config.workspace;

  let server;
  try {
    server = require('../server');
  } catch (err) {
    process.stderr.write(`claude-orchestra: could not load the server: ${err.message}\n`);
    process.stderr.write('If you are running from a checkout, try "npm install" first.\n');
    return 1;
  }
  if (typeof server.start !== 'function') {
    process.stderr.write('claude-orchestra: server.js does not export start(); this build is broken.\n');
    return 1;
  }

  let info;
  try {
    info = await server.start({
      port,
      host,
      cwd,
      workspace,
      open: options.open,
    });
  } catch (err) {
    if (err && (err.code === 'EADDRINUSE' || /EADDRINUSE/.test(String(err.message)))) {
      return handlePortInUse(host, port, options.open);
    }
    reportStartFailure(err, host, port);
    return 1;
  }

  const base = info && info.url ? info.url : localBase(host, port);

  // Printed and opened without the token: the page served on `/` carries it
  // inline, and a token in the URL would land in the scrollback, in any
  // captured log, and in the browser process's argument list.
  process.stdout.write('\n  Claude Orchestra\n');
  process.stdout.write(`  ${base}\n`);
  process.stdout.write(`  working directory: ${cwd}\n`);
  if (workspace) process.stdout.write(`  workspace: ${workspace}\n`);
  process.stdout.write('  Ctrl+C to stop\n\n');

  installSignalHandlers(info);

  if (options.open) await openAndReport(base);

  return null;
}

if (require.main === module) {
  main(process.argv.slice(2)).then((code) => {
    // null means "listening, keep the process alive".
    if (code !== null) process.exit(code);
  }).catch((err) => {
    process.stderr.write(`claude-orchestra: ${err && err.message ? err.message : err}\n`);
    if (process.env.ORCHESTRA_DEBUG && err && err.stack) process.stderr.write(`${err.stack}\n`);
    process.exit(1);
  });
}

module.exports = {
  parseArgs,
  main,
  helpText,
  openBrowser,
  probeHealth,
  urlWithToken,
  formatHost,
  browsableHost,
};
