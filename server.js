'use strict';

const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');
const fsp = fs.promises;
const os = require('os');
const crypto = require('crypto');
const WebSocket = require('ws');

const config = require('./lib/config');
const security = require('./lib/security');
const {
  C2S, S2C, ERROR_CODE, LIMITS, HOOK_EVENT, KIND, APPROVAL, APPROVAL_SCOPE,
} = require('./lib/protocol');
const { SessionManager } = require('./lib/session-manager');
const { HookBus } = require('./lib/hook-bus');
const { ApprovalQueue } = require('./lib/approvals');
const { RaceManager } = require('./lib/race');
const { UsageTracker } = require('./lib/usage');
const { AutoResume } = require('./lib/auto-resume');
const { Policy } = require('./lib/policy');
const { BudgetGuard } = require('./lib/budget');
const { Digest } = require('./lib/digest');
const { PushSender } = require('./lib/push');
const { ProjectIndex } = require('./lib/projects');
const { Workspace } = require('./lib/workspace');
const hooksInstall = require('./lib/hooks-install');

const pkg = require('./package.json');

const logger = {
  info: (...a) => console.log('[orchestra]', ...a),
  warn: (...a) => console.warn('[orchestra]', ...a),
  error: (...a) => console.error('[orchestra]', ...a),
};

/**
 * Wires the modules together and returns a running server. This file is only
 * assembly, transport, and the two guards that make the transport safe: an
 * Origin check on the WebSocket upgrade, a session token on everything else.
 *
 * @param {{port?:number, host?:string, cwd?:string}} [options]
 * @returns {Promise<{url:string, port:number, host:string, token:string, close:()=>Promise<void>}>}
 */
async function start(options = {}) {
  const port = options.port || config.port;
  const host = options.host || config.host;
  const isLoopback = ['127.0.0.1', '::1', 'localhost'].includes(host);

  if (!isLoopback && !config.allowRemote) {
    throw new Error(
      `Refusing to bind ${host}: that exposes a shell to your network. `
      + 'Set ORCHESTRA_ALLOW_REMOTE=1 if you really mean it, and put a tunnel with TLS in front.'
    );
  }

  // Do this before anything reads config: the origin allowlist and the
  // ORCHESTRA_URL handed to hooks are both derived from the bound address.
  config.setRuntime({ port, host });

  const sessions = new SessionManager();
  const hookBus = new HookBus({ sessions, config, logger });
  // Built before the approval queue, which consults it on every tool call.
  const policy = new Policy({ logger, trustAllow: config.trustRepoPolicy });
  const approvals = new ApprovalQueue({ sessions, policy, config, logger });
  const races = new RaceManager({ sessions, config, logger });
  const usage = new UsageTracker({ config, logger });
  const autoResume = new AutoResume({ sessions, usage, config, logger });
  const budget = new BudgetGuard({ sessions, policy, config, logger });
  const push = new PushSender({ config, logger });
  const digest = new Digest({ sessions, hookBus, budget, autoResume, approvals, logger });
  const projects = new ProjectIndex({ config, logger });
  const workspace = new Workspace({ config, logger });

  const app = express();
  const server = http.createServer(app);
  const wss = new WebSocket.Server({ noServer: true, maxPayload: LIMITS.MAX_FRAME_BYTES });

  app.disable('x-powered-by');
  app.use(security.checkHost);

  // Every response carries the CSP, not just the index: popout.html resolves a
  // token and opens its own WebSocket, so unprotected it would be frameable and
  // the softest target for any future XSS.
  app.use((_req, res, next) => {
    const nonce = crypto.randomBytes(16).toString('base64');
    res.locals.cspNonce = nonce;
    res.set(security.securityHeaders(nonce));
    next();
  });

  app.use(express.json({ limit: '4mb' }));

  const indexTemplate = await fsp.readFile(path.join(__dirname, 'public', 'index.html'), 'utf-8');

  app.get(['/', '/index.html'], (_req, res) => {
    res.type('html').send(renderIndex(indexTemplate, res.locals.cspNonce, {
      token: config.token,
      platform: os.platform(),
      version: pkg.version,
      serverId: sessions.serverId,
      home: config.HOME,
      startCwd: options.cwd || null,
      features: {
        pty: sessions.available,
        ptyError: sessions.unavailableReason,
        remote: !isLoopback,
      },
    }));
  });

  // xterm comes from node_modules, not a CDN: the app stays offline and local.
  app.use('/vendor/xterm', express.static(path.join(__dirname, 'node_modules', '@xterm', 'xterm')));
  app.use('/vendor/addon-fit', express.static(path.join(__dirname, 'node_modules', '@xterm', 'addon-fit')));
  app.use('/vendor/addon-web-links', express.static(path.join(__dirname, 'node_modules', '@xterm', 'addon-web-links')));
  app.use('/vendor/addon-search', express.static(path.join(__dirname, 'node_modules', '@xterm', 'addon-search')));
  app.use(express.static(path.join(__dirname, 'public'), { index: false }));

  app.get('/api/health', (_req, res) => {
    res.json({
      status: 'ok',
      product: 'claude-orchestra',
      version: pkg.version,
      serverId: sessions.serverId,
      uptime: process.uptime(),
      sessions: sessions.sessions.size,
    });
  });

  const api = express.Router();
  api.use(security.requireToken);

  /** Error codes modules raise, mapped to what they mean over HTTP. */
  const STATUS_FOR = {
    [ERROR_CODE.BAD_REQUEST]: 400,
    [ERROR_CODE.NOT_FOUND]: 404,
    [ERROR_CODE.LIMIT_REACHED]: 429,
    [ERROR_CODE.SPAWN_FAILED]: 400,
  };

  const wrap = fn => (req, res) => {
    Promise.resolve(fn(req, res)).catch(err => {
      const status = err.status || STATUS_FOR[err.code] || 500;
      // A rejected argument is the caller's problem, not a server fault; only
      // log a stack for the ones that really are ours.
      if (status >= 500) logger.error(req.method, req.path, err);
      else logger.warn(`${req.method} ${req.path}: ${err.message}`);
      if (!res.headersSent) {
        res.status(status).json({ error: err.message, code: err.code || ERROR_CODE.INTERNAL });
      }
    });
  };

  api.get('/bootstrap', (_req, res) => {
    res.json({
      token: config.token,
      platform: os.platform(),
      version: pkg.version,
      serverId: sessions.serverId,
      home: config.HOME,
      sessions: sessions.list(),
      orphans: sessions.listOrphans(),
      features: { pty: sessions.available, ptyError: sessions.unavailableReason },
    });
  });

  api.get('/sessions', (_req, res) => res.json(sessions.list()));

  api.get('/orphans', (_req, res) => res.json(sessions.listOrphans()));

  api.post('/orphans/:id/resume', wrap(async (req, res) => {
    const session = sessions.resumeOrphan(req.params.id);
    if (!session) return res.status(404).json({ error: 'unknown orphan' });
    res.json(sessions.toWire(session));
  }));

  api.delete('/orphans/:id', (req, res) => {
    sessions.forgetOrphan(req.params.id);
    res.json({ ok: true });
  });

  api.get('/projects', wrap(async (_req, res) => res.json(await projects.recent())));

  api.get('/workspace', wrap(async (req, res) => {
    res.json(await workspace.read(String(req.query.cwd || '')));
  }));

  api.post('/workspace/apply', wrap(async (req, res) => {
    const cwd = String(req.body.cwd || '');
    const recipe = await workspace.read(cwd);
    if (!recipe) return res.status(404).json({ error: 'no .orchestra.json in that directory' });
    const specs = workspace.toSpecs(recipe, cwd);
    const created = specs.map(spec => sessions.toWire(sessions.create(spec)));
    res.json({ created });
  }));

  api.get('/usage', wrap(async (_req, res) => res.json(await usage.read())));

  api.get('/budget', (_req, res) => res.json(budget.state()));

  api.put('/budget', wrap(async (req, res) => {
    const { settings, error } = budget.updateSettings(req.body || {});
    if (error) return res.status(400).json({ error, code: ERROR_CODE.BAD_REQUEST, settings });
    res.json(budget.state());
  }));

  api.post('/budget/:id/release', wrap(async (req, res) => {
    const result = budget.release(req.params.id);
    if (!result.ok) return res.status(404).json({ error: result.error, code: ERROR_CODE.NOT_FOUND });
    res.json(budget.state());
  }));

  api.get('/budget/history', (_req, res) => res.json({ history: budget.history() }));

  api.get('/digest', wrap(async (req, res) => {
    res.json(await digest.build({
      since: req.query.since ? Number(req.query.since) : undefined,
      until: req.query.until ? Number(req.query.until) : undefined,
    }));
  }));

  api.get('/policy', wrap(async (req, res) => {
    // Read fresh: the panel is how someone checks a file they just edited.
    policy.invalidate();
    res.json(policy.describe(String(req.query.cwd || config.HOME)));
  }));

  api.get('/push/key', (_req, res) => res.json({
    publicKey: push.publicKey(),
    subscriptions: push.list(),
  }));

  api.post('/push/subscribe', wrap(async (req, res) => {
    const result = push.subscribe(req.body && req.body.subscription, req.body && req.body.label);
    if (!result.ok) return res.status(400).json({ error: result.error, code: ERROR_CODE.BAD_REQUEST });
    res.json({ ok: true, subscriptions: push.list() });
  }));

  api.post('/push/unsubscribe', wrap(async (req, res) => {
    const result = push.unsubscribe(String((req.body && req.body.endpoint) || ''));
    if (!result.ok) return res.status(404).json({ error: result.error, code: ERROR_CODE.NOT_FOUND });
    res.json({ ok: true, subscriptions: push.list() });
  }));

  api.post('/push/test', wrap(async (req, res) => {
    res.json(await push.send({
      title: 'Claude Orchestra',
      body: 'Push works. This is how a permission request will reach you.',
      reason: 'test',
      tag: 'orchestra-test',
    }));
  }));

  api.get('/auto-resume', (_req, res) => res.json(autoResume.snapshot()));

  api.put('/auto-resume', wrap(async (req, res) => {
    const { settings, error } = autoResume.updateSettings(req.body || {});
    // A rejected patch still returns the settings in force, so the panel can
    // show the error next to the values that are actually live.
    if (error) return res.status(400).json({ error, code: ERROR_CODE.BAD_REQUEST, settings });
    res.json({ settings, plans: autoResume.plans() });
  }));

  api.post('/auto-resume/:id/now', wrap(async (req, res) => {
    const result = await autoResume.resumeNow(req.params.id);
    if (!result.ok) return res.status(409).json({ error: result.error, code: ERROR_CODE.BAD_REQUEST });
    res.json(result);
  }));

  api.delete('/auto-resume/:id', (req, res) => {
    const result = autoResume.cancel(req.params.id);
    if (!result.ok) return res.status(404).json({ error: result.error, code: ERROR_CODE.NOT_FOUND });
    res.json(result);
  });

  api.get('/hooks/status', wrap(async (_req, res) => res.json(await hooksInstall.status())));
  api.post('/hooks/install', wrap(async (req, res) => res.json(await hooksInstall.install(req.body || {}))));
  api.post('/hooks/uninstall', wrap(async (_req, res) => res.json(await hooksInstall.uninstall())));

  api.get('/timeline', wrap(async (req, res) => {
    res.json(await hookBus.timeline({
      sessionId: req.query.sessionId ? String(req.query.sessionId) : undefined,
      limit: Number(req.query.limit) || 200,
    }));
  }));

  api.get('/approvals', (_req, res) => {
    res.json({ pending: approvals.pending(), rules: approvals.listRules() });
  });

  api.post('/approvals/:id/decide', wrap(async (req, res) => {
    res.json(await approvals.decide(req.params.id, {
      decision: req.body.decision,
      scope: req.body.scope,
      pattern: req.body.pattern,
      cwd: req.body.cwd,
      tool: req.body.tool,
    }));
  }));

  api.delete('/approvals/rules/:ruleId', wrap(async (req, res) => {
    // deleteRule already answers {ok, error}; forward it rather than wrapping.
    const result = await approvals.deleteRule(req.params.ruleId);
    if (!result.ok) {
      return res.status(404).json({ error: result.error, code: ERROR_CODE.NOT_FOUND });
    }
    res.json(result);
  }));

  api.get('/race', wrap(async (_req, res) => res.json(await races.list())));
  api.post('/race', wrap(async (req, res) => res.json(await races.create(req.body || {}))));
  api.get('/race/:id', wrap(async (req, res) => {
    const race = await races.get(req.params.id);
    if (!race) return res.status(404).json({ error: 'unknown race' });
    // The arena reads files/summary at the top level, so flatten the diff here
    // rather than making the view understand two shapes.
    const diffs = await races.diffs(req.params.id);
    res.json({ race, files: diffs.files || [], summary: diffs.summary || {} });
  }));
  api.post('/race/:id/adopt', wrap(async (req, res) => {
    res.json(await races.adopt(req.params.id, String(req.body.variant || '')));
  }));
  api.delete('/race/:id', wrap(async (req, res) => res.json(await races.discard(req.params.id))));
  api.get('/scoreboard', wrap(async (_req, res) => res.json(await races.scoreboard())));

  app.use('/api', api);

  /**
   * Hook ingress, called by our own hook scripts inside the PTYs. Mounted on
   * the router so they inherit its auth, declared apart because the approval
   * route deliberately holds its response open.
   */
  api.post('/hooks/event/:event', wrap(async (req, res) => {
    const result = await hookBus.ingest(req.params.event, req.body || {});
    if (!result.ok) {
      // JSON.stringify keeps a hostile event name on a single log line.
      logger.warn(`rejected hook event ${JSON.stringify(String(req.params.event).slice(0, 80))}: ${result.error}`);
      return res.status(400).json({ ok: false, matched: false, error: result.error || 'rejected' });
    }
    res.json({ ok: true, matched: result.matched });
  }));

  api.post('/approvals', wrap(async (req, res) => {
    // Long poll: the hook is blocking a tool call in a real agent while a human
    // decides, possibly on a phone. Node would otherwise time the socket out.
    req.setTimeout(0);
    res.setTimeout(0);
    const body = req.body || {};

    const known = new Set(approvals.pendingById.keys());
    const pending = approvals.request({
      sessionId: body.orchestraSessionId || body.sessionId || null,
      tool: body.tool_name || body.tool || 'unknown',
      input: body.tool_input || body.input || {},
      cwd: body.cwd || null,
    });
    // request() registers its entry synchronously, so the one id that was not
    // pending a moment ago is the one this request owns.
    const id = [...approvals.pendingById.keys()].find(key => !known.has(key)) || null;

    let clientGone = false;
    const onClose = () => {
      if (res.writableEnded) return;
      clientGone = true;
      const entry = id ? approvals.pendingById.get(id) : null;
      if (!entry) return;
      // The agent that asked is gone (killed, or the user pressed Escape).
      // Left alone, an operator could still "Allow always" a tool call that
      // will never run, writing a rule for consent that governed nothing.
      approvals.settle(entry, {
        id,
        decision: APPROVAL.DENY,
        scope: APPROVAL_SCOPE.ONCE,
        reason: 'the agent that asked disconnected',
        source: 'abandoned',
      });
    };
    res.on('close', onClose);

    const decision = await pending;
    res.off('close', onClose);
    if (clientGone) return;
    res.json(decision);
  }));

  app.use((req, res) => res.status(404).json({ error: 'not found', path: req.path }));

  // Express 5 forwards async errors here. Without it a single malformed request
  // kills the process, and every agent running under it.
  app.use((err, _req, res, _next) => {
    logger.error('unhandled route error', err);
    if (!res.headersSent) res.status(500).json({ error: 'internal error' });
  });

  server.on('upgrade', (req, socket, head) => {
    const verdict = security.checkUpgrade(req);
    if (!verdict.ok) {
      logger.warn('rejected upgrade:', verdict.reason, 'origin =', req.headers.origin || '(none)');
      socket.write(`HTTP/1.1 ${verdict.code} Forbidden\r\nConnection: close\r\n\r\n`);
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, ws => wss.emit('connection', ws, req));
  });

  const clients = new Set();

  const sendTo = (ws, msg) => {
    if (ws.readyState === WebSocket.OPEN) {
      try { ws.send(JSON.stringify(msg)); } catch (e) { logger.warn('send failed', e.message); }
    }
  };
  const broadcast = msg => { for (const ws of clients) sendTo(ws, msg); };

  // The client adopts a ready as a full snapshot: whatever the payload omits is
  // erased. Hence one builder, used by both the greeting and the answer to LIST.
  const readyPayload = () => ({
    t: S2C.READY,
    serverId: sessions.serverId,
    version: pkg.version,
    platform: os.platform(),
    home: config.HOME,
    sessions: sessions.list(),
    orphans: sessions.listOrphans(),
    approvals: approvals.pending(),
    rules: approvals.listRules(),
    autoResume: autoResume.snapshot(),
    budget: budget.state(),
    push: { publicKey: push.publicKey(), devices: push.list().length },
    features: { pty: sessions.available, ptyError: sessions.unavailableReason },
  });

  sessions.on('deliver', ({ ws, id, seq, data }) => sendTo(ws, { t: S2C.OUTPUT, id, seq, data }));
  sessions.on('resync', ({ ws, id, seq, data, truncated }) =>
    sendTo(ws, { t: S2C.SNAPSHOT, id, seq, data, truncated }));
  sessions.on('session', s => broadcast({ t: S2C.SESSION, session: s }));
  sessions.on('exit', e => broadcast({ t: S2C.EXIT, id: e.id, code: e.code }));
  sessions.on('closed', e => broadcast({ t: S2C.CLOSED, id: e.id }));
  sessions.on('warning', message => logger.warn(message));
  // Every flush, for every session. AutoResume rejects anything that is not a
  // Claude panel before it looks at a byte.
  sessions.on('output', ({ id, data }) => autoResume.noteOutput(id, data));

  hookBus.on('event', e => broadcast({ t: S2C.AGENT_EVENT, event: e }));
  hookBus.on('stalled', e => broadcast({ t: S2C.AGENT_EVENT, event: { ...e, event: 'Stalled' } }));
  approvals.on('request', r => broadcast({ t: S2C.APPROVAL_REQUEST, request: r }));
  approvals.on('resolved', r => broadcast({ t: S2C.APPROVAL_RESOLVED, ...r }));
  // Its own type: APPROVAL_RESOLVED is keyed by request id, so a rule list sent
  // under it would decode as a resolution with no id.
  approvals.on('rules', rules => broadcast({ t: S2C.APPROVAL_RULES, rules }));
  races.on('race', race => broadcast({ t: S2C.RACE, race }));
  autoResume.on('plans', plans => broadcast({ t: S2C.AUTO_RESUME, plans, settings: autoResume.settings() }));
  budget.on('state', state => broadcast({ t: S2C.BUDGET, ...state }));

  /**
   * Push is the only path that reaches a closed tab, so the events that need a
   * human are mirrored to it. Every send is fire and forget: a notification
   * that cannot be delivered must never hold up the agent that triggered it.
   */
  const notify = message => {
    push.send(message).catch(err => logger.warn(`push: ${err.message}`));
  };

  approvals.on('request', r => notify({
    title: `${r.sessionName || 'An agent'} wants permission`,
    body: `${r.tool}: ${r.summary || ''}`.slice(0, 200),
    reason: 'permission',
    sessionId: r.sessionId,
    tag: `approval-${r.id}`,
    // The one notification worth interrupting for: an agent is blocked until
    // it is answered, and it fails closed on the deadline.
    requireInteraction: true,
    url: '/?view=approvals',
  }));

  budget.on('breach', info => notify({
    title: `${info.name || 'A session'} hit its ${info.scope} budget`,
    body: `$${info.spent.toFixed(2)} of $${info.cap.toFixed(2)}`
      + (info.locked ? '. The session is locked.' : '.'),
    reason: 'budget',
    sessionId: info.sessionId,
    tag: `budget-${info.sessionId}`,
  }));

  autoResume.on('resumed', info => {
    logger.info(`auto-resume: sent ${JSON.stringify(info.text)} to ${info.name}`);
    notify({
      title: `${info.name} resumed`,
      body: `The quota reset, so it was sent ${JSON.stringify(info.text)}.`,
      reason: 'resumed',
      sessionId: info.sessionId,
      tag: `resume-${info.sessionId}`,
    });
  });

  hookBus.on('stalled', info => notify({
    title: `${info.name || 'An agent'} looks stuck`,
    body: info.detail || info.reason,
    reason: 'stalled',
    sessionId: info.sessionId,
    tag: `stall-${info.sessionId}`,
  }));

  wss.on('connection', ws => {
    clients.add(ws);
    let budget = 0;
    const budgetTimer = setInterval(() => { budget = 0; }, 1000);
    let alive = true;
    ws.on('pong', () => { alive = true; });
    const heartbeat = setInterval(() => {
      if (!alive) { ws.terminate(); return; }
      alive = false;
      try { ws.ping(); } catch { /* socket already gone */ }
    }, LIMITS.HEARTBEAT_MS);

    sendTo(ws, readyPayload());

    ws.on('message', raw => {
      if (++budget > LIMITS.MSG_PER_SEC) return;
      let msg;
      try {
        msg = JSON.parse(raw);
      } catch {
        return sendTo(ws, { t: S2C.ERROR, code: ERROR_CODE.BAD_REQUEST, message: 'malformed message' });
      }
      try {
        handleMessage(ws, msg);
      } catch (err) {
        // One malformed message must never take every agent down with it.
        logger.error('ws handler', msg && msg.t, err);
        sendTo(ws, {
          t: S2C.ERROR,
          id: msg && msg.id,
          code: err.code || ERROR_CODE.INTERNAL,
          message: err.message,
        });
      }
    });

    ws.on('error', err => logger.warn('socket error', err.message));

    ws.on('close', () => {
      clearInterval(budgetTimer);
      clearInterval(heartbeat);
      clients.delete(ws);
      // Detach, never kill: this is what lets a session survive a page refresh.
      sessions.detachAll(ws);
    });
  });

  function handleMessage(ws, msg) {
    switch (msg.t) {
      case C2S.PING:
        return sendTo(ws, { t: S2C.PONG, ts: Date.now() });

      case C2S.LIST:
        return sendTo(ws, readyPayload());

      case C2S.CREATE: {
        const session = sessions.create(msg.spec || {});
        const attached = sessions.attach(session.id, ws, 0);
        sendTo(ws, { t: S2C.CREATED, session: sessions.toWire(session) });
        if (attached && attached.snapshot.data) {
          sendTo(ws, { t: S2C.SNAPSHOT, id: session.id, seq: attached.snapshot.seq, data: attached.snapshot.data });
        }
        return;
      }

      case C2S.ATTACH: {
        const attached = sessions.attach(msg.id, ws, msg.sinceSeq);
        if (!attached) {
          return sendTo(ws, { t: S2C.ERROR, id: msg.id, code: ERROR_CODE.NOT_FOUND, message: 'unknown session' });
        }
        return sendTo(ws, {
          t: S2C.SNAPSHOT,
          id: msg.id,
          seq: attached.snapshot.seq,
          data: attached.snapshot.data,
          truncated: attached.snapshot.truncated,
        });
      }

      case C2S.DETACH:
        return sessions.detach(msg.id, ws);

      case C2S.INPUT:
        return void sessions.write(msg.id, String(msg.data == null ? '' : msg.data));

      case C2S.RESIZE:
        return sessions.resize(msg.id, msg.cols, msg.rows);

      case C2S.RENAME:
        return sessions.rename(msg.id, msg.name);

      case C2S.SET_META:
        return sessions.setMeta(msg.id, msg.patch || {});

      case C2S.KILL:
        return msg.remove ? sessions.close(msg.id) : sessions.kill(msg.id);

      case C2S.SEND_TO: {
        // Targeted, never "every terminal on the machine": a broadcast Ctrl+C
        // would stop every session and prompts would land in plain shells.
        const ids = Array.isArray(msg.ids) ? msg.ids : [];
        for (const id of ids) sessions.write(id, String(msg.data == null ? '' : msg.data));
        return;
      }

      case C2S.APPROVAL_DECISION:
        // tool and cwd come from the rule form, where an empty directory means
        // "everywhere"; drop them and every rule pins to one cwd.
        return void approvals.decide(msg.requestId, {
          decision: msg.decision,
          scope: msg.scope,
          pattern: msg.pattern,
          cwd: msg.cwd,
          tool: msg.tool,
        });

      default:
        return sendTo(ws, { t: S2C.ERROR, code: ERROR_CODE.BAD_REQUEST, message: `unknown message ${msg.t}` });
    }
  }

  await new Promise((resolve, reject) => {
    const onError = err => {
      server.off('listening', onListening);
      if (err.code === 'EADDRINUSE') {
        err.message = `Port ${port} is already in use. Start with --port <n>, or open the running instance.`;
      }
      reject(err);
    };
    const onListening = () => {
      server.off('error', onError);
      resolve();
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, host);
  });

  // The sweeps only run once the server is actually up, so a failed bind does
  // not leave orphan intervals behind.
  hookBus.start();
  autoResume.start();
  budget.start();

  if (options.workspace && options.cwd) {
    try {
      const recipe = await workspace.read(options.cwd);
      if (!recipe) {
        logger.warn(`no .orchestra.json in ${options.cwd}, nothing to apply for --workspace`);
      } else if (recipe.name && recipe.name !== options.workspace) {
        logger.warn(`.orchestra.json defines "${recipe.name}", not "${options.workspace}"; starting it anyway`);
      }
      if (recipe) {
        for (const spec of workspace.toSpecs(recipe, options.cwd)) sessions.create(spec);
        logger.info(`applied recipe "${recipe.name || 'unnamed'}"`);
      }
    } catch (err) {
      logger.error(`could not apply the recipe: ${err.message}`);
    }
  }

  const url = `http://${isLoopback ? '127.0.0.1' : host}:${port}`;
  logger.info(`listening on ${url}`);
  if (!sessions.available) logger.warn(sessions.unavailableReason);
  if (!isLoopback) logger.warn('bound to a non-loopback address: anyone who reaches this port and holds the token gets a shell');

  let closing = false;
  const close = async () => {
    if (closing) return;
    closing = true;
    logger.info('shutting down');
    hookBus.stop();
    autoResume.stop();
    budget.stop();
    approvals.shutdown();
    for (const ws of clients) { try { ws.close(); } catch { /* already closed */ } }
    sessions.shutdown();
    await new Promise(resolve => server.close(resolve));
  };

  return { url, port, host, token: config.token, close, sessions, autoResume, budget, policy, digest, push, app, server };
}

/**
 * Injects the bootstrap payload, session token included, into the page itself:
 * the token never travels in a URL the browser will keep, and a page from
 * another origin cannot read it, which is what makes the WS check meaningful.
 */
function renderIndex(template, nonce, bootstrap) {
  const json = JSON.stringify(bootstrap).replace(/</g, '\\u003c');
  return template
    .replace(/__ORCHESTRA_NONCE__/g, nonce)
    .replace('__ORCHESTRA_BOOTSTRAP__', json);
}

if (require.main === module) {
  process.on('uncaughtException', err => {
    logger.error('uncaught exception', err);
  });
  process.on('unhandledRejection', err => {
    logger.error('unhandled rejection', err);
  });

  start()
    .then(({ url, close }) => {
      logger.info(`open ${url}`);
      const shutdown = () => {
        close().then(() => process.exit(0)).catch(() => process.exit(1));
        setTimeout(() => process.exit(0), 5000).unref();
      };
      process.on('SIGINT', shutdown);
      process.on('SIGTERM', shutdown);
    })
    .catch(err => {
      logger.error(err.message);
      process.exit(1);
    });
}

module.exports = { start };
