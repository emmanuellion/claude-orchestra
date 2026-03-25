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

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

app.use(express.static(path.join(__dirname, 'public')));

// ──────── Usage / stats endpoint ────────

const CLAUDE_DIR = path.join(HOME, '.claude');
const STATS_FILE = path.join(CLAUDE_DIR, 'stats-cache.json');
const PROJECTS_DIR = path.join(CLAUDE_DIR, 'projects');

// Read stats-cache.json
function readStatsCache() {
  try {
    return JSON.parse(fs.readFileSync(STATS_FILE, 'utf-8'));
  } catch {
    return null;
  }
}

// Scan recent session JSONL files to compute live usage for today/this week
async function computeRecentUsage() {
  const now = new Date();
  const todayStr = now.toISOString().split('T')[0];

  // Monday of this week
  const dayOfWeek = now.getDay();
  const mondayOffset = dayOfWeek === 0 ? -6 : 1 - dayOfWeek;
  const monday = new Date(now);
  monday.setDate(now.getDate() + mondayOffset);
  monday.setHours(0, 0, 0, 0);

  const result = {
    today: { messages: 0, sessions: new Set(), inputTokens: 0, outputTokens: 0, cacheRead: 0, cacheCreate: 0, models: {} },
    week: { messages: 0, sessions: new Set(), inputTokens: 0, outputTokens: 0, cacheRead: 0, cacheCreate: 0, models: {} },
  };

  // Find all session JSONL files modified this week
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
          // Always add to week
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

  // Convert sets to counts
  result.today.sessions = result.today.sessions.size;
  result.week.sessions = result.week.sessions.size;

  return result;
}

app.get('/api/stats', async (_req, res) => {
  const cached = readStatsCache();
  const recent = await computeRecentUsage();
  res.json({ cached, recent });
});

// ──────── Terminal management ────────

const terminals = new Map();
let nextId = 1;
const PTY_HELPER = path.join(__dirname, 'pty-helper.py');

function createTerminalProcess(cols, rows, cwd) {
  const targetCwd = cwd || HOME;
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
  return proc;
}

function killProc(proc) {
  try {
    if (IS_WIN) {
      spawn('taskkill', ['/pid', String(proc.pid), '/T', '/F'], { stdio: 'ignore' });
    } else {
      proc.kill('SIGTERM');
    }
  } catch {}
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

        const proc = createTerminalProcess(cols, rows, cwd);
        terminals.set(id, { proc, ws, name: data.name || `Terminal ${id}` });

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

        ws.send(JSON.stringify({ type: 'created', id, name: terminals.get(id).name }));

        if (launchClaude) {
          setTimeout(() => {
            if (proc.stdin.writable) proc.stdin.write(`claude${NEWLINE}`);
          }, 500);
        }
        break;
      }

      case 'input': {
        const t = terminals.get(data.id);
        if (t && t.proc.stdin.writable) t.proc.stdin.write(data.data);
        break;
      }

      case 'resize': {
        const t = terminals.get(data.id);
        if (t && t.proc.stdin.writable) {
          t.proc.stdin.write(`\x1b]boss:resize:${data.rows}:${data.cols}\\`);
        }
        break;
      }

      case 'kill': {
        const t = terminals.get(data.id);
        if (t) { killProc(t.proc); terminals.delete(data.id); }
        break;
      }

      case 'broadcast': {
        for (const [, t] of terminals) {
          if (t.proc.stdin.writable) t.proc.stdin.write(data.data);
        }
        break;
      }
    }
  });

  ws.on('close', () => {
    for (const [id, t] of terminals) {
      if (t.ws === ws) { killProc(t.proc); terminals.delete(id); }
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Claude Orchestra running at http://localhost:${PORT}`);
});
