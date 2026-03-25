const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const readline = require('readline');

const IS_WIN = os.platform() === 'win32';
const PYTHON = IS_WIN ? 'python' : 'python3';
const NEWLINE = IS_WIN ? '\r\n' : '\n';
const HOME = os.homedir();

let nodePty = null;
if (IS_WIN) {
  try { nodePty = require('node-pty'); } catch {}
}

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

app.use(express.static(path.join(__dirname, 'public')));

const CLAUDE_DIR = path.join(HOME, '.claude');
const STATS_FILE = path.join(CLAUDE_DIR, 'stats-cache.json');
const PROJECTS_DIR = path.join(CLAUDE_DIR, 'projects');

function readStatsCache() {
  try {
    return JSON.parse(fs.readFileSync(STATS_FILE, 'utf-8'));
  } catch {
    return null;
  }
}

async function computeRecentUsage() {
  const now = new Date();
  const todayStr = now.toISOString().split('T')[0];

  const dayOfWeek = now.getDay();
  const mondayOffset = dayOfWeek === 0 ? -6 : 1 - dayOfWeek;
  const monday = new Date(now);
  monday.setDate(now.getDate() + mondayOffset);
  monday.setHours(0, 0, 0, 0);

  const result = {
    today: { messages: 0, sessions: new Set(), inputTokens: 0, outputTokens: 0, cacheRead: 0, cacheCreate: 0, models: {} },
    week: { messages: 0, sessions: new Set(), inputTokens: 0, outputTokens: 0, cacheRead: 0, cacheCreate: 0, models: {} },
  };

  let sessionFiles = [];
  try {
    const projectDirs = fs.readdirSync(PROJECTS_DIR);
    for (const projDir of projectDirs) {
      const projPath = path.join(PROJECTS_DIR, projDir);
      if (!fs.statSync(projPath).isDirectory()) continue;
      const files = fs.readdirSync(projPath).filter(f => f.endsWith('.jsonl'));
      for (const f of files) {
        const fpath = path.join(projPath, f);
        const stat = fs.statSync(fpath);
        if (stat.mtime >= monday) {
          sessionFiles.push(fpath);
        }
      }
    }
  } catch {
    return result;
  }

  for (const fpath of sessionFiles) {
    try {
      const content = fs.readFileSync(fpath, 'utf-8');
      const lines = content.split('\n').filter(l => l.trim());
      let sessionId = null;

      for (const line of lines) {
        let entry;
        try { entry = JSON.parse(line); } catch { continue; }

        if (entry.sessionId) sessionId = entry.sessionId;

        const ts = entry.timestamp || entry.message?.timestamp;
        if (!ts) continue;

        const entryDate = new Date(ts);
        if (entryDate < monday) continue;

        const isToday = ts.startsWith(todayStr);
        const msg = entry.message || {};
        const usage = msg.usage || entry.usage;

        if (entry.type === 'user' || (entry.type === 'assistant' && usage)) {
          const bucket = isToday ? result.today : null;
          if (entry.type === 'user') {
            result.week.messages++;
            if (sessionId) result.week.sessions.add(sessionId);
            if (bucket) {
              bucket.messages++;
              if (sessionId) bucket.sessions.add(sessionId);
            }
          }

          if (usage) {
            const model = msg.model || entry.model || 'unknown';
            const inp = usage.input_tokens || 0;
            const out = usage.output_tokens || 0;
            const cr = usage.cache_read_input_tokens || 0;
            const cc = usage.cache_creation_input_tokens || 0;

            result.week.inputTokens += inp;
            result.week.outputTokens += out;
            result.week.cacheRead += cr;
            result.week.cacheCreate += cc;

            if (!result.week.models[model]) {
              result.week.models[model] = { input: 0, output: 0, cacheRead: 0, cacheCreate: 0 };
            }
            result.week.models[model].input += inp;
            result.week.models[model].output += out;
            result.week.models[model].cacheRead += cr;
            result.week.models[model].cacheCreate += cc;

            if (bucket) {
              bucket.inputTokens += inp;
              bucket.outputTokens += out;
              bucket.cacheRead += cr;
              bucket.cacheCreate += cc;

              if (!bucket.models[model]) {
                bucket.models[model] = { input: 0, output: 0, cacheRead: 0, cacheCreate: 0 };
              }
              bucket.models[model].input += inp;
              bucket.models[model].output += out;
              bucket.models[model].cacheRead += cr;
              bucket.models[model].cacheCreate += cc;
            }
          }
        }
      }
    } catch {}
  }

  result.today.sessions = result.today.sessions.size;
  result.week.sessions = result.week.sessions.size;

  return result;
}

app.get('/api/stats', async (_req, res) => {
  const cached = readStatsCache();
  const recent = await computeRecentUsage();
  res.json({ cached, recent });
});

const terminals = new Map();
let nextId = 1;
const PTY_HELPER = path.join(__dirname, 'pty-helper.py');

function createTerminal(id, cols, rows, cwd, ws) {
  const targetCwd = cwd || HOME;

  if (IS_WIN && nodePty) {
    const shell = process.env.COMSPEC || 'cmd.exe';
    const ptyProc = nodePty.spawn(shell, [], {
      name: 'xterm-256color',
      cols, rows,
      cwd: targetCwd,
      env: process.env,
    });

    ptyProc.onData((data) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'output', id, data }));
      }
    });

    ptyProc.onExit(({ exitCode }) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'exit', id, exitCode: exitCode || 0 }));
      }
      terminals.delete(id);
    });

    return {
      usePty: true,
      pty: ptyProc,
      write(d) { ptyProc.write(d); },
      resize(r, c) { try { ptyProc.resize(c, r); } catch {} },
      kill() { try { ptyProc.kill(); } catch {} },
    };
  }

  const defaultShell = IS_WIN
    ? (process.env.COMSPEC || 'cmd.exe')
    : (process.env.SHELL || '/bin/bash');

  const proc = spawn(PYTHON, [PTY_HELPER], {
    cwd: targetCwd,
    env: {
      ...process.env,
      TERM: 'xterm-256color',
      COLUMNS: String(cols),
      LINES: String(rows),
      PTY_CWD: targetCwd,
      SHELL: defaultShell,
      COMSPEC: process.env.COMSPEC || 'cmd.exe',
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  proc.stdout.on('data', (chunk) => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'output', id, data: chunk.toString('utf-8') }));
    }
  });

  proc.stderr.on('data', (chunk) => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'output', id, data: chunk.toString('utf-8') }));
    }
  });

  proc.on('exit', (exitCode) => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'exit', id, exitCode: exitCode || 0 }));
    }
    terminals.delete(id);
  });

  return {
    usePty: false,
    proc,
    write(d) { if (proc.stdin.writable) proc.stdin.write(d); },
    resize(r, c) { if (proc.stdin.writable) proc.stdin.write(`\x1b]boss:resize:${r}:${c}\\`); },
    kill() {
      try {
        if (IS_WIN) spawn('taskkill', ['/pid', String(proc.pid), '/T', '/F'], { stdio: 'ignore' });
        else proc.kill('SIGTERM');
      } catch {}
    },
  };
}

wss.on('connection', (ws) => {
  ws.on('message', (msg) => {
    let data;
    try { data = JSON.parse(msg); } catch { return; }

    switch (data.type) {
      case 'create': {
        const id = nextId++;
        const launchClaude = data.command === 'claude';
        const cols = data.cols || 120;
        const rows = data.rows || 30;
        const cwd = data.cwd || HOME;

        const term = createTerminal(id, cols, rows, cwd, ws);
        terminals.set(id, { term, ws, name: data.name || `Terminal ${id}` });

        ws.send(JSON.stringify({ type: 'created', id, name: terminals.get(id).name }));

        if (launchClaude) {
          setTimeout(() => term.write(`claude${NEWLINE}`), 500);
        }
        break;
      }

      case 'input': {
        const t = terminals.get(data.id);
        if (t) t.term.write(data.data);
        break;
      }

      case 'resize': {
        const t = terminals.get(data.id);
        if (t) t.term.resize(data.rows, data.cols);
        break;
      }

      case 'kill': {
        const t = terminals.get(data.id);
        if (t) { t.term.kill(); terminals.delete(data.id); }
        break;
      }

      case 'broadcast': {
        for (const [, t] of terminals) {
          t.term.write(data.data);
        }
        break;
      }
    }
  });

  ws.on('close', () => {
    for (const [id, t] of terminals) {
      if (t.ws === ws) { t.term.kill(); terminals.delete(id); }
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Claude Orchestra running at http://localhost:${PORT}`);
});
