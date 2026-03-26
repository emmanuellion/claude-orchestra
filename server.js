const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const fsp = fs.promises;
const os = require('os');

const IS_WIN = os.platform() === 'win32';
const PYTHON = IS_WIN ? 'python' : 'python3';
const NEWLINE = IS_WIN ? '\r\n' : '\n';
const HOME = os.homedir();
const MAX_BUF = 64 * 1024;
const MSG_PER_SEC = 200;
const MAX_OUTPUT_BUF = 200 * 1024;

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
  const fiveHoursAgo = new Date(now.getTime() - 5 * 60 * 60 * 1000);

  const dayOfWeek = now.getDay();
  const mondayOffset = dayOfWeek === 0 ? -6 : 1 - dayOfWeek;
  const monday = new Date(now);
  monday.setDate(now.getDate() + mondayOffset);
  monday.setHours(0, 0, 0, 0);

  const nextMonday = new Date(monday);
  nextMonday.setDate(nextMonday.getDate() + 7);

  const makeBucket = () => ({ messages: 0, sessions: new Set(), inputTokens: 0, outputTokens: 0, cacheRead: 0, cacheCreate: 0, models: {} });
  const result = {
    today: makeBucket(),
    week: makeBucket(),
    fiveHour: makeBucket(),
    oldestInWindow: null,
    nextWeeklyReset: nextMonday.toISOString(),
    serverTime: now.toISOString(),
  };

  let sessionFiles = [];
  try {
    const projectDirs = await fsp.readdir(PROJECTS_DIR);
    const dirStats = await Promise.all(projectDirs.map(async (projDir) => {
      const projPath = path.join(PROJECTS_DIR, projDir);
      try {
        const stat = await fsp.stat(projPath);
        return stat.isDirectory() ? projPath : null;
      } catch { return null; }
    }));
    const dirs = dirStats.filter(Boolean);
    const fileArrays = await Promise.all(dirs.map(async (projPath) => {
      const files = (await fsp.readdir(projPath)).filter(f => f.endsWith('.jsonl'));
      const stats = await Promise.all(files.map(async (f) => {
        const fpath = path.join(projPath, f);
        try {
          const fstat = await fsp.stat(fpath);
          return fstat.mtime >= monday ? fpath : null;
        } catch { return null; }
      }));
      return stats.filter(Boolean);
    }));
    sessionFiles = fileArrays.flat();
  } catch {
    return result;
  }

  for (const fpath of sessionFiles) {
    try {
      const content = await fsp.readFile(fpath, 'utf-8');
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
        const isFiveHour = entryDate >= fiveHoursAgo;
        const msg = entry.message || {};
        const usage = msg.usage || entry.usage;

        if (entry.type === 'user' || (entry.type === 'assistant' && usage)) {
          const todayBucket = isToday ? result.today : null;
          const fiveBucket = isFiveHour ? result.fiveHour : null;

          if (entry.type === 'user') {
            result.week.messages++;
            if (sessionId) result.week.sessions.add(sessionId);
            if (todayBucket) { todayBucket.messages++; if (sessionId) todayBucket.sessions.add(sessionId); }
            if (fiveBucket) { fiveBucket.messages++; if (sessionId) fiveBucket.sessions.add(sessionId); }
          }

          if (usage) {
            const model = msg.model || entry.model || 'unknown';
            const inp = usage.input_tokens || 0;
            const out = usage.output_tokens || 0;
            const cr = usage.cache_read_input_tokens || 0;
            const cc = usage.cache_creation_input_tokens || 0;

            const addToBucket = (b) => {
              b.inputTokens += inp;
              b.outputTokens += out;
              b.cacheRead += cr;
              b.cacheCreate += cc;
              if (!b.models[model]) b.models[model] = { input: 0, output: 0, cacheRead: 0, cacheCreate: 0 };
              b.models[model].input += inp;
              b.models[model].output += out;
              b.models[model].cacheRead += cr;
              b.models[model].cacheCreate += cc;
            };

            addToBucket(result.week);
            if (todayBucket) addToBucket(todayBucket);
            if (fiveBucket) {
              addToBucket(fiveBucket);
              if (!result.oldestInWindow || entryDate.toISOString() < result.oldestInWindow) {
                result.oldestInWindow = entryDate.toISOString();
              }
            }
          }
        }
      }
    } catch {}
  }

  result.today.sessions = result.today.sessions.size;
  result.week.sessions = result.week.sessions.size;
  result.fiveHour.sessions = result.fiveHour.sessions.size;

  return result;
}

app.get('/api/platform', (_req, res) => {
  res.json({ platform: os.platform() });
});

app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok', uptime: process.uptime(), terminals: terminals.size });
});

app.get('/api/stats', async (_req, res) => {
  const cached = readStatsCache();
  const recent = await computeRecentUsage();
  res.json({ cached, recent });
});

const QUOTA_FILE = path.join(CLAUDE_DIR, 'orchestra-quota.json');
const SETTINGS_FILE = path.join(CLAUDE_DIR, 'settings.json');
const HOOK_PATH = path.join(__dirname, 'quota-hook.js');

const QUOTA_POLL_MS = 120000;
let quotaWatcher = null;
let quotaWatcherAutoRestart = false;

function stripAnsiServer(s) {
  return s.replace(/\x1b\[[0-9;]*[a-zA-Z]|\x1b\][^\x07]*(?:\x07|\x1b\\)|\x1b[()][A-Z0-9]|\x1b[#?][0-9]|\x1b./g, '');
}

function renderScreen(raw, numRows, numCols) {
  numRows = numRows || 40;
  numCols = numCols || 120;
  const buf = Array.from({ length: numRows }, () => new Array(numCols).fill(' '));
  let r = 0, c = 0;
  let i = 0;
  while (i < raw.length) {
    const ch = raw[i];
    if (ch === '\x1b') {
      if (raw[i + 1] === '[') {
        let j = i + 2;
        let params = '';
        while (j < raw.length && ((raw[j] >= '0' && raw[j] <= '9') || raw[j] === ';' || raw[j] === '?')) {
          params += raw[j]; j++;
        }
        const cmd = raw[j] || '';
        const clean = params.replace(/^\?/, '');
        const parts = clean ? clean.split(';').map(Number) : [];
        switch (cmd) {
          case 'H': case 'f':
            r = Math.min(numRows - 1, Math.max(0, (parts[0] || 1) - 1));
            c = Math.min(numCols - 1, Math.max(0, (parts[1] || 1) - 1));
            break;
          case 'A': r = Math.max(0, r - (parts[0] || 1)); break;
          case 'B': r = Math.min(numRows - 1, r + (parts[0] || 1)); break;
          case 'C': c = Math.min(numCols - 1, c + (parts[0] || 1)); break;
          case 'D': c = Math.max(0, c - (parts[0] || 1)); break;
          case 'G': c = Math.min(numCols - 1, Math.max(0, (parts[0] || 1) - 1)); break;
          case 'd': r = Math.min(numRows - 1, Math.max(0, (parts[0] || 1) - 1)); break;
          case 'J':
            if ((parts[0] || 0) === 2 || parts[0] === 3) {
              buf.forEach(row => row.fill(' '));
            } else if (parts[0] === 1) {
              for (let ri = 0; ri < r; ri++) buf[ri].fill(' ');
              for (let ci = 0; ci <= c; ci++) buf[r][ci] = ' ';
            } else {
              for (let ci = c; ci < numCols; ci++) buf[r][ci] = ' ';
              for (let ri = r + 1; ri < numRows; ri++) buf[ri].fill(' ');
            }
            break;
          case 'K':
            if ((parts[0] || 0) === 0) {
              for (let ci = c; ci < numCols; ci++) buf[r][ci] = ' ';
            } else if (parts[0] === 1) {
              for (let ci = 0; ci <= c; ci++) buf[r][ci] = ' ';
            } else if (parts[0] === 2) {
              buf[r].fill(' ');
            }
            break;
          case 'E': r = Math.min(numRows - 1, r + (parts[0] || 1)); c = 0; break;
          case 'F': r = Math.max(0, r - (parts[0] || 1)); c = 0; break;
        }
        i = j + 1;
      } else if (raw[i + 1] === ']') {
        let j = i + 2;
        while (j < raw.length && raw[j] !== '\x07' && !(raw[j] === '\x1b' && raw[j + 1] === '\\')) j++;
        i = raw[j] === '\x07' ? j + 1 : j + 2;
      } else {
        i += 2;
      }
    } else if (ch === '\r') {
      c = 0; i++;
    } else if (ch === '\n') {
      r = Math.min(numRows - 1, r + 1); i++;
    } else if (ch === '\t') {
      c = Math.min(numCols - 1, (Math.floor(c / 8) + 1) * 8); i++;
    } else if (ch.charCodeAt(0) < 32) {
      i++;
    } else {
      if (r >= 0 && r < numRows && c >= 0 && c < numCols) {
        buf[r][c] = ch;
        c++;
        if (c >= numCols) c = numCols - 1;
      }
      i++;
    }
  }
  return buf.map(row => row.join('').trimEnd()).filter(l => l.length > 0).join('\n');
}

function parseResetTime(text, isWeekly) {
  const timeMatch = text.match(/(\d{1,2})\s*(am|pm)/i);
  if (timeMatch) {
    let h = parseInt(timeMatch[1]);
    const isPM = timeMatch[2].toLowerCase() === 'pm';
    h = isPM ? (h === 12 ? 12 : h + 12) : (h === 12 ? 0 : h);
    const now = new Date();
    const target = new Date(now);
    target.setHours(h, 0, 0, 0);
    if (isWeekly) {
      const day = now.getDay();
      const toMon = day === 0 ? 1 : day === 1 && now < target ? 0 : 8 - day;
      target.setDate(now.getDate() + toMon);
      if (target <= now) target.setDate(target.getDate() + 7);
    } else {
      if (target <= now) target.setDate(target.getDate() + 1);
    }
    return Math.floor(target.getTime() / 1000);
  }

  const dayNames = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };
  const dayMatch = text.match(/\b(sun|mon|tue|wed|thu|fri|sat)\w*/i);
  if (dayMatch) {
    const targetDay = dayNames[dayMatch[1].toLowerCase()];
    if (targetDay !== undefined) {
      const now = new Date();
      const current = now.getDay();
      let diff = targetDay - current;
      if (diff <= 0) diff += 7;
      const target = new Date(now);
      target.setDate(now.getDate() + diff);
      target.setHours(0, 0, 0, 0);
      return Math.floor(target.getTime() / 1000);
    }
  }

  const dateMatch = text.match(/(\w{3})\s+(\d{1,2})/i);
  if (dateMatch) {
    const months = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };
    const mon = months[dateMatch[1].toLowerCase()];
    const day = parseInt(dateMatch[2]);
    if (mon !== undefined) {
      const now = new Date();
      const target = new Date(now.getFullYear(), mon, day);
      if (target <= now) target.setFullYear(target.getFullYear() + 1);
      return Math.floor(target.getTime() / 1000);
    }
  }
  return null;
}

function parseUsageOutput(raw) {
  const screen = renderScreen(raw, 40, 120);
  const lines = screen.split('\n');
  const result = {};

  console.log(`Quota parser: screen ${lines.length} lines`);
  for (const l of lines) {
    if (l.trim()) console.log(`  | ${l}`);
  }

  for (let i = 0; i < lines.length; i++) {
    const pctMatch = lines[i].match(/(\d+(?:\.\d+)?)\s*%\s*.?used/i);
    if (!pctMatch) continue;
    const pct = parseFloat(pctMatch[1]);

    let ctx = lines[i].toLowerCase();
    for (let j = i - 1; j >= Math.max(0, i - 3); j--) {
      ctx = lines[j].toLowerCase() + ' ' + ctx;
    }

    if (!result.five_hour && ctx.includes('session')) {
      result.five_hour = { used_percentage: pct };
    } else if (!result.seven_day && ctx.includes('week') && !ctx.includes('sonnet only')) {
      result.seven_day = { used_percentage: pct };
    } else if (!result.extra && ctx.includes('extra')) {
      result.extra = { used_percentage: pct };
    }
  }

  for (const line of lines) {
    const resetMatch = line.match(/[Rr]esets?\s+(.+)/);
    if (!resetMatch) continue;
    const resetText = resetMatch[1].trim();
    const lower = line.toLowerCase();

    let section = null;
    if (lower.includes('session') || lower.includes('5h')) section = 'five_hour';
    else if (lower.includes('week') || lower.includes('7 day')) section = 'seven_day';
    else if (lower.includes('extra') || lower.includes('overage')) section = 'extra';

    if (!section) {
      const lineIdx = lines.indexOf(line);
      for (let j = lineIdx - 1; j >= Math.max(0, lineIdx - 4); j--) {
        const prev = lines[j].toLowerCase();
        if (prev.includes('session') || prev.includes('5h')) { section = 'five_hour'; break; }
        if (prev.includes('week') || prev.includes('7 day')) { section = 'seven_day'; break; }
        if (prev.includes('extra') || prev.includes('overage')) { section = 'extra'; break; }
      }
    }

    if (section && result[section] && !result[section].resets_text) {
      result[section].resets_text = resetText;
      result[section].resets_at = parseResetTime(resetText, section !== 'five_hour');
    }
  }

  for (const line of lines) {
    const costMatch = line.match(/\$([\d.]+)\s*\/\s*\$([\d.]+)/);
    if (costMatch) {
      result.extra = result.extra || {};
      result.extra.spent = parseFloat(costMatch[1]);
      result.extra.limit = parseFloat(costMatch[2]);
    }
  }

  console.log(`Quota parser: result = ${JSON.stringify(result)}`);
  if (!result.five_hour && !result.seven_day && !result.extra) return null;
  return result;
}

function writeQuotaFile(parsed) {
  try {
    let existing = {};
    try { existing = JSON.parse(fs.readFileSync(QUOTA_FILE, 'utf-8')); } catch {}
    fs.writeFileSync(QUOTA_FILE, JSON.stringify({ ...existing, ...parsed, updated: Date.now(), source: 'watcher' }));
  } catch {}
}

function startQuotaWatcher() {
  if (quotaWatcher) return { status: 'already_running' };

  const pty = nodePty || (() => { try { return require('node-pty'); } catch { return null; } })();
  if (!pty) return { status: 'error', message: 'node-pty not available' };

  quotaWatcherAutoRestart = true;

  const shell = IS_WIN ? (process.env.COMSPEC || 'cmd.exe') : (process.env.SHELL || '/bin/bash');

  try {
    const cleanEnv = { ...process.env };
    delete cleanEnv.CLAUDECODE;
    delete cleanEnv.CLAUDE_CODE_ENTRYPOINT;

    const proc = pty.spawn(shell, [], {
      name: 'xterm-256color',
      cols: 120, rows: 40,
      cwd: HOME,
      env: cleanEnv,
    });

    let allOutput = '';
    let activeTimer = null;
    let state = 'starting';
    let dataCount = 0;

    const delay = (ms) => new Promise(r => { activeTimer = setTimeout(r, ms); });
    const clearActive = () => { if (activeTimer) { clearTimeout(activeTimer); activeTimer = null; } };

    proc.onExit(() => {
      clearActive();
      const shouldRestart = quotaWatcherAutoRestart;
      quotaWatcher = null;
      if (shouldRestart) {
        console.log('Quota watcher: exited, restarting in 60s');
        setTimeout(() => { if (!quotaWatcher && quotaWatcherAutoRestart) startQuotaWatcher(); }, 60000);
      }
    });

    const sendUsage = async () => {
      if (!quotaWatcher) return;

      const dataBefore = dataCount;
      proc.write('\x1b');
      await delay(300);
      if (!quotaWatcher) return;
      proc.write('\x15');
      await delay(300);
      if (!quotaWatcher) return;
      const m2 = allOutput.length;
      proc.write('/usage');
      await delay(300);
      if (!quotaWatcher) return;
      proc.write('\r');
      console.log('Quota watcher: /usage + Enter sent');
      await delay(12000);
      if (!quotaWatcher) return;

      const newData = allOutput.slice(m2);
      console.log(`Quota watcher: ${newData.length} bytes, ${dataCount - dataBefore} chunks`);
      proc.write('\x1b');
      proc.write('q');
      await delay(500);
      if (!quotaWatcher) return;

      const parsed = parseUsageOutput(newData);
      if (parsed) {
        writeQuotaFile(parsed);
        console.log('Quota watcher: OK -', JSON.stringify(parsed).slice(0, 400));
      } else {
        console.log('Quota watcher: no quota found in output');
        const screen = renderScreen(newData, 40, 120);
        console.log('Quota watcher: screen dump:\n' + screen.split('\n').filter(l => l.trim()).map(l => '  > ' + l).join('\n'));
      }
      await delay(QUOTA_POLL_MS);
      if (quotaWatcher) sendUsage();
    };

    quotaWatcher = {
      proc, state: () => state,
      poll() {
        if (state !== 'running') return;
        clearActive();
        sendUsage();
      },
      kill() {
        clearActive();
        quotaWatcherAutoRestart = false;
        try { proc.kill(); } catch {}
        quotaWatcher = null;
      }
    };

    proc.onData((data) => {
      allOutput += data;
      dataCount++;
      if (allOutput.length > 500000) allOutput = allOutput.slice(-250000);
    });

    activeTimer = setTimeout(() => {
      if (!quotaWatcher) return;
      console.log(`Quota watcher: shell ready (${dataCount} events, ${allOutput.length} bytes)`);
      proc.write(`claude\r`);
      state = 'waiting';
    }, 2000);

    let trustHandled = false;
    let readyChecks = 0;
    let claudeMarker = 0;

    const checkReady = () => {
      if (!quotaWatcher) return;
      readyChecks++;
      const clean = stripAnsiServer(allOutput);

      if (!trustHandled && (clean.includes('trust') || clean.includes('Trust'))) {
        console.log('Quota watcher: trust prompt detected, confirming');
        proc.write('\r');
        trustHandled = true;
      }

      if (clean.includes('not recognized') || clean.includes('not found') || clean.includes('cannot be launched')) {
        console.log('Quota watcher: claude failed to start, stopping');
        quotaWatcherAutoRestart = false;
        try { proc.kill(); } catch {}
        quotaWatcher = null;
        return;
      }

      const recentOutput = allOutput.slice(claudeMarker);
      const screen = renderScreen(recentOutput, 40, 120);
      const hasPrompt = screen.includes('\u276f') || /^\s*[❯]\s*$/m.test(screen);
      if (hasPrompt && readyChecks >= 5) {
        console.log(`Quota watcher: REPL prompt detected after ~${5 + readyChecks * 2}s`);
        state = 'running';
        activeTimer = setTimeout(sendUsage, 2000);
        return;
      }

      if (readyChecks >= 30) {
        console.log('Quota watcher: timeout waiting for prompt, trying anyway');
        state = 'running';
        sendUsage();
        return;
      }

      activeTimer = setTimeout(checkReady, 2000);
    };

    activeTimer = setTimeout(() => {
      claudeMarker = allOutput.length;
      checkReady();
    }, 8000);

    console.log('Quota watcher: starting shell...');
    return { status: 'started' };
  } catch (e) {
    console.log('Quota watcher: failed -', e.message);
    return { status: 'error', message: e.message };
  }
}

function stopQuotaWatcher() {
  if (!quotaWatcher) return { status: 'not_running' };
  quotaWatcher.kill();
  return { status: 'stopped' };
}

app.get('/api/quota', (_req, res) => {
  try {
    const data = JSON.parse(fs.readFileSync(QUOTA_FILE, 'utf-8'));
    const age = Date.now() - (data.updated || 0);
    if (age > 6 * 3600000) { res.json(null); return; }
    res.json(data);
  } catch {
    res.json(null);
  }
});

app.get('/api/quota/status', (_req, res) => {
  try {
    const settings = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf-8'));
    const cmd = settings.statusLine?.command || '';
    const configured = cmd.includes('quota-hook');
    const hasExisting = !!settings.statusLine && !configured;
    res.json({ configured, hasExisting, currentCommand: cmd || null });
  } catch {
    res.json({ configured: false, hasExisting: false, currentCommand: null });
  }
});

app.get('/api/quota/watcher', (_req, res) => {
  res.json({
    running: !!quotaWatcher,
    state: quotaWatcher ? quotaWatcher.state() : 'stopped',
  });
});

app.use(express.json());

app.post('/api/quota/watcher/start', (_req, res) => {
  res.json(startQuotaWatcher());
});

app.post('/api/quota/watcher/poll', (_req, res) => {
  if (!quotaWatcher || quotaWatcher.state() !== 'running') {
    return res.json({ status: 'not_running' });
  }
  quotaWatcher.poll();
  res.json({ status: 'polling' });
});

app.post('/api/quota/watcher/stop', (_req, res) => {
  res.json(stopQuotaWatcher());
});

app.post('/api/quota/setup', (_req, res) => {
  try {
    let settings = {};
    try { settings = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf-8')); } catch {}

    const cmd = settings.statusLine?.command || '';
    if (cmd.includes('quota-hook')) {
      return res.json({ status: 'already_configured' });
    }

    const nodeCmd = `node "${HOOK_PATH.replace(/\\/g, '/')}"`;
    settings.statusLine = { type: 'command', command: nodeCmd };

    fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2));
    res.json({ status: 'configured' });
  } catch (e) {
    res.json({ status: 'error', message: e.message });
  }
});

const terminals = new Map();
let nextId = 1;
const PTY_HELPER = path.join(__dirname, 'pty-helper.py');

function clamp(v, min, max, fallback) {
  const n = typeof v === 'number' ? v : fallback;
  return Math.min(max, Math.max(min, n));
}

function broadcast(id, msg) {
  const t = terminals.get(id);
  if (!t) return;
  const str = JSON.stringify(msg);
  for (const c of t.clients) {
    if (c.readyState === WebSocket.OPEN) c.send(str);
  }
  if (msg.type === 'output') {
    t.outputBuffer += msg.data;
    if (t.outputBuffer.length > MAX_OUTPUT_BUF) {
      t.outputBuffer = t.outputBuffer.slice(-MAX_OUTPUT_BUF);
    }
  }
}

function makeOutputFlusher(id) {
  let buf = '';
  let handle = null;
  const flush = () => {
    if (buf) broadcast(id, { type: 'output', id, data: buf });
    buf = '';
    handle = null;
  };
  return {
    push(data) {
      buf += (typeof data === 'string') ? data : data.toString('utf-8');
      if (buf.length >= MAX_BUF) { if (handle) clearImmediate(handle); flush(); }
      else if (!handle) handle = setImmediate(flush);
    },
    drain() { if (handle) { clearImmediate(handle); flush(); } },
  };
}

function createTerminal(id, cols, rows, cwd, shellOverride) {
  const targetCwd = cwd || HOME;
  const flusher = makeOutputFlusher(id);

  if (IS_WIN && nodePty) {
    const shell = shellOverride || process.env.COMSPEC || 'cmd.exe';
    const ptyProc = nodePty.spawn(shell, [], {
      name: 'xterm-256color',
      cols, rows,
      cwd: targetCwd,
      env: process.env,
    });

    ptyProc.onData((data) => flusher.push(data));
    ptyProc.onExit(({ exitCode }) => {
      flusher.drain();
      broadcast(id, { type: 'exit', id, exitCode: exitCode || 0 });
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

  const defaultShell = shellOverride
    || (IS_WIN ? (process.env.COMSPEC || 'cmd.exe') : (process.env.SHELL || '/bin/bash'));

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

  proc.stdout.on('data', (chunk) => flusher.push(chunk));
  proc.stderr.on('data', (chunk) => flusher.push(chunk));
  proc.on('exit', (exitCode) => {
    flusher.drain();
    broadcast(id, { type: 'exit', id, exitCode: exitCode || 0 });
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
  let msgCount = 0;
  const msgReset = setInterval(() => { msgCount = 0; }, 1000);

  ws.on('message', (msg) => {
    if (++msgCount > MSG_PER_SEC) return;

    let data;
    try { data = JSON.parse(msg); } catch { return; }

    switch (data.type) {
      case 'create': {
        const id = nextId++;
        const launchClaude = data.command === 'claude';
        const isPowershell = data.command === 'powershell';
        const cols = clamp(data.cols, 40, 300, 120);
        const rows = clamp(data.rows, 10, 100, 30);
        const cwd = data.cwd || HOME;
        const shellOverride = isPowershell ? 'powershell.exe' : null;
        const name = data.name || `Terminal ${id}`;

        terminals.set(id, { term: null, clients: new Set([ws]), name, outputBuffer: '' });
        const term = createTerminal(id, cols, rows, cwd, shellOverride);
        const entry = terminals.get(id);
        if (entry) entry.term = term;

        ws.send(JSON.stringify({ type: 'created', id, name, cwd }));

        if (launchClaude) {
          const args = data.claudeArgs ? ` ${data.claudeArgs}` : '';
          setTimeout(() => term.write(`claude${args}${NEWLINE}`), 500);
        }
        break;
      }

      case 'attach': {
        const t = terminals.get(data.id);
        if (t) {
          t.clients.add(ws);
          ws.send(JSON.stringify({ type: 'attached', id: data.id, name: t.name }));
          if (t.outputBuffer) {
            ws.send(JSON.stringify({ type: 'output', id: data.id, data: t.outputBuffer }));
          }
        }
        break;
      }

      case 'input': {
        const t = terminals.get(data.id);
        if (t?.term) t.term.write(data.data);
        break;
      }

      case 'resize': {
        const t = terminals.get(data.id);
        if (t?.term) {
          const r = clamp(data.rows, 10, 100, 30);
          const c = clamp(data.cols, 40, 300, 120);
          t.term.resize(r, c);
        }
        break;
      }

      case 'kill': {
        const t = terminals.get(data.id);
        if (t) {
          broadcast(data.id, { type: 'exit', id: data.id, exitCode: 0 });
          if (t.term) t.term.kill();
          terminals.delete(data.id);
        }
        break;
      }

      case 'broadcast': {
        for (const [, t] of terminals) {
          if (t.term) t.term.write(data.data);
        }
        break;
      }
    }
  });

  ws.on('close', () => {
    clearInterval(msgReset);
    for (const [id, t] of terminals) {
      t.clients.delete(ws);
      if (t.clients.size === 0) {
        if (t.term) t.term.kill();
        terminals.delete(id);
      }
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Claude Orchestra running at http://localhost:${PORT}`);
});

function shutdown() {
  console.log('Shutting down...');
  if (quotaWatcher) { try { quotaWatcher.kill(); } catch {} }
  for (const [id, t] of terminals) {
    try { if (t.term) t.term.kill(); } catch {}
    terminals.delete(id);
  }
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 5000);
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
