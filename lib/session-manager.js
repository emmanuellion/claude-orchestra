'use strict';

const { EventEmitter } = require('events');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { StringDecoder } = require('string_decoder');

const config = require('./config');
const { STATUS, KIND, ENV, LIMITS } = require('./protocol');
const { RingBuffer } = require('./ring-buffer');
const { which, needsShim, splitArgs } = require('./which');
const { checkArgs, quoteForCmd } = require('./args-policy');
const { colorFor, defaultNameFor, projectLabel } = require('./project-identity');

let nodePty = null;
let nodePtyError = null;
try {
  nodePty = require('node-pty');
} catch (e) {
  nodePtyError = e;
}

/** How often a client that hit the backpressure ceiling is re-examined. */
const CATCH_UP_MS = 250;

/** Exited sessions kept around so their output is still readable. */
const EXITED_KEPT = 8;

/** Ceiling on orphans carried in the state file, which survive across runs. */
const ORPHANS_KEPT = 32;

function clamp(v, min, max, fallback) {
  const n = typeof v === 'number' && Number.isFinite(v) ? v : fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

function fail(code, message) {
  const err = new Error(message);
  err.code = code;
  return err;
}

function expandHome(p) {
  return p.startsWith('~') ? path.join(config.HOME, p.slice(1)) : p;
}

function isDirectory(p) {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/** Directory identity: a trailing separator and case are not a difference. */
function dirKey(cwd) {
  return String(cwd || '').replace(/[\\/]+$/, '').toLowerCase();
}

function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    // EPERM means the process exists and belongs to somebody else.
    return e.code === 'EPERM';
  }
}

function makeAgentState() {
  return {
    model: null,
    tool: null,
    toolDetail: null,
    toolStartedAt: null,
    lastEventAt: null,
    turns: 0,
    cost: 0,
    tokens: { input: 0, output: 0 },
    claudeSessionId: null,
    gitBranch: null,
    lastQuestion: null,
    lastPrompt: null,
  };
}

/**
 * Owns every PTY on the machine and the browser sockets watching them.
 *
 * The rule that shapes this whole class: a session's lifetime is independent of
 * any browser. Closing a tab detaches; only an explicit kill, an exit, or a TTL
 * sweep destroys. Sequenced scrollback, per-client backpressure and resync all
 * exist so a client can leave and come back without the session noticing.
 *
 * @fires SessionManager#session  a session's metadata changed
 * @fires SessionManager#output   {id, seq, data}
 * @fires SessionManager#exit     {id, code}
 * @fires SessionManager#closed   {id}
 * @fires SessionManager#warning  a string worth logging, never fatal
 */
class SessionManager extends EventEmitter {
  constructor() {
    super();
    /** @type {Map<string, any>} */
    this.sessions = new Map();
    /**
     * The record of sessions a previous server run lost when its PTYs died with
     * it, with enough detail to offer picking the work back up.
     * @type {Map<string, any>}
     */
    this.orphans = new Map();
    this.serverId = crypto.randomUUID();
    this._sweep = setInterval(() => this.sweepDetached(), 60000);
    if (this._sweep.unref) this._sweep.unref();
    this._catchUp = null;
    this._saveTimer = null;
    this._pendingWarnings = [];
    this.on('newListener', event => {
      if (event !== 'warning' || this._pendingWarnings.length === 0) return;
      const queued = this._pendingWarnings;
      this._pendingWarnings = [];
      // 'newListener' fires before the listener is registered, so the replay
      // has to wait a tick or it would be shouted into the same empty room.
      setImmediate(() => { for (const message of queued) this.emit('warning', message); });
    });
    // One state file per port, so a second instance does not read the first
    // one's live sessions as dead orphans and erase them on its first save.
    this.stateFile = path.join(config.orchestraDir, `sessions-${config.port}.json`);
    this.loadOrphans();
  }

  /**
   * Warnings are advisory, and the loudest ones happen in the constructor,
   * before the server has had a chance to subscribe. Queue those rather than
   * drop them.
   */
  warn(message) {
    if (this.listenerCount('warning') > 0) this.emit('warning', message);
    else this._pendingWarnings.push(message);
  }

  /**
   * Reads what the last run left behind: the sessions it was running, which
   * died with it, plus the orphans it had not resumed yet. Without this the
   * browser shows an empty interface after a restart and the user has no idea
   * which agent was working on what.
   */
  loadOrphans() {
    let raw;
    try {
      raw = fs.readFileSync(this.stateFile, 'utf-8');
    } catch (e) {
      if (e.code !== 'ENOENT') this.warn(`could not read ${this.stateFile}: ${e.message}`);
      return;
    }
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (e) {
      this.warn(`${this.stateFile} is unreadable, ignoring it: ${e.message}`);
      return;
    }
    if (!parsed) return;
    // The process that wrote this is still running, so those PTYs are alive and
    // nothing was lost. Offering to resume one would put a second agent on a
    // conversation somebody else is holding.
    if (parsed.pid !== process.pid && isProcessAlive(parsed.pid)) {
      this.warn(`${this.stateFile} belongs to a live instance (pid ${parsed.pid}), leaving it alone`);
      return;
    }

    const lost = [
      ...(Array.isArray(parsed.sessions) ? parsed.sessions : []),
      ...(Array.isArray(parsed.orphans) ? parsed.orphans : []),
    ];
    for (const s of lost) {
      if (!s || typeof s.id !== 'string' || this.orphans.has(s.id)) continue;
      this.orphans.set(s.id, {
        ...s,
        status: STATUS.EXITED,
        orphaned: true,
        orphanedAt: s.orphanedAt || parsed.savedAt || null,
        // What can be resumed is a Claude conversation, not a PTY, so the kind
        // of terminal it was launched from is irrelevant here.
        resumable: !!s.claudeSessionId,
      });
    }
  }

  /** The specs worth writing down: enough to explain and to restart. */
  persistable() {
    return [...this.sessions.values()]
      .filter(s => s.status !== STATUS.EXITED && s.kind !== KIND.EXTERNAL)
      .map(s => ({
        id: s.id,
        name: s.name,
        kind: s.kind,
        cwd: s.cwd,
        args: s.args,
        cols: s.cols,
        rows: s.rows,
        tagColor: s.tagColor,
        colorAuto: s.colorAuto !== false,
        race: s.race,
        createdAt: s.createdAt,
        lastActivityAt: s.lastActivityAt,
        claudeSessionId: s.agent && s.agent.claudeSessionId,
        gitBranch: s.agent && s.agent.gitBranch,
        lastPrompt: s.agent && s.agent.lastPrompt,
        cost: s.agent && s.agent.cost,
      }));
  }

  /** Debounced so a chatty agent does not rewrite the file on every event. */
  scheduleSave() {
    if (this._saveTimer) return;
    this._saveTimer = setTimeout(() => {
      this._saveTimer = null;
      this.save();
    }, 1000);
    if (this._saveTimer.unref) this._saveTimer.unref();
  }

  save() {
    const payload = {
      pid: process.pid,
      port: config.port,
      savedAt: Date.now(),
      sessions: this.persistable(),
      // Orphans nobody has resumed or dismissed yet. Leaving them out would
      // delete the claudeSessionId that is the only way back into those
      // conversations.
      orphans: [...this.orphans.values()]
        .sort((a, b) => (b.orphanedAt || 0) - (a.orphanedAt || 0))
        .slice(0, ORPHANS_KEPT),
    };
    const tmp = `${this.stateFile}.tmp`;
    try {
      fs.writeFileSync(tmp, JSON.stringify(payload, null, 2));
      fs.renameSync(tmp, this.stateFile);
    } catch (e) {
      this.warn(`could not save session state: ${e.message}`);
    }
  }

  /** Names already taken, so a second agent in one repo does not collide. */
  usedNames() {
    return [...this.sessions.values()].map(s => s.name);
  }

  /** Orphans, in the same wire shape as live sessions so the UI can list both. */
  listOrphans() {
    return [...this.orphans.values()];
  }

  forgetOrphan(id) {
    if (this.orphans.delete(id)) this.scheduleSave();
  }

  /**
   * Restarts an orphan, with `--resume` when its Claude session id was captured.
   *
   * A directory that no longer exists is refused rather than quietly resolved
   * to $HOME: an agent resumed in the wrong tree reads and edits the wrong
   * files, and every approval rule scoped to that directory stops matching.
   *
   * @throws when the orphan's directory is gone
   * @returns {Object|null} the new session, or null if that orphan is unknown
   */
  resumeOrphan(id) {
    const orphan = this.orphans.get(id);
    if (!orphan) return null;

    const cwd = orphan.cwd ? path.resolve(expandHome(String(orphan.cwd))) : config.HOME;
    if (!isDirectory(cwd)) {
      throw fail('bad_request',
        `${cwd} no longer exists, so there is nowhere to resume "${orphan.name}". `
        + 'Restore that directory, or dismiss the session.');
    }

    const args = orphan.resumable
      ? `--resume ${orphan.claudeSessionId} ${orphan.args || ''}`.trim()
      : (orphan.args || '');
    const session = this.create({
      // Resuming a conversation means launching Claude, even when the original
      // PTY was a shell the user typed `claude` into.
      kind: orphan.resumable ? KIND.CLAUDE : orphan.kind,
      name: orphan.name,
      cwd,
      args,
      cols: orphan.cols,
      rows: orphan.rows,
      tagColor: orphan.tagColor,
      race: orphan.race,
    });
    this.orphans.delete(id);
    this.scheduleSave();
    return session;
  }

  get available() {
    return !!nodePty;
  }

  get unavailableReason() {
    if (nodePty) return null;
    return `node-pty failed to load (${nodePtyError && nodePtyError.message}). `
      + 'Run "npm rebuild node-pty" or reinstall with build tools available.';
  }

  /** Public view of a session, safe to send over the wire. */
  toWire(s) {
    return {
      id: s.id,
      name: s.name,
      kind: s.kind,
      cwd: s.cwd,
      args: s.args,
      cols: s.cols,
      rows: s.rows,
      status: s.status,
      createdAt: s.createdAt,
      exitedAt: s.exitedAt,
      exitCode: s.exitCode,
      attached: s.clients.size,
      detachedAt: s.detachedAt,
      seq: s.buffer.seq,
      tagColor: s.tagColor,
      locked: s.locked,
      agent: s.agent,
      race: s.race,
      lastActivityAt: s.lastActivityAt,
      warnings: s.warnings || [],
      project: projectLabel(s.cwd),
      colorAuto: s.colorAuto !== false,
      external: s.external || null,
    };
  }

  list() {
    return [...this.sessions.values()].map(s => this.toWire(s));
  }

  get(id) {
    return this.sessions.get(id);
  }

  /**
   * @param {Object} spec
   * @param {string} [spec.kind]    'claude' | 'shell' | 'powershell'
   * @param {string} [spec.cwd]     working directory, `~` accepted
   * @param {string} [spec.args]    extra argv for claude, as typed
   * @param {string} [spec.prompt]  typed into the REPL once it is up
   * @param {string} [spec.trust]   'untrusted' for a spec read out of a repository
   * @param {Object} [spec.env]     extra environment
   * @param {Object} [spec.race]    {raceId, variant}
   */
  create(spec = {}) {
    if (!nodePty) throw fail('spawn_failed', this.unavailableReason);

    // Only running sessions count against the cap. An exited one is a
    // transcript somebody may still want to read, not a slot.
    this.reapExited();
    // External agents are records, not processes, so they do not consume a slot.
    const live = [...this.sessions.values()]
      .filter(s => s.status !== STATUS.EXITED && s.kind !== KIND.EXTERNAL).length;
    if (live >= LIMITS.MAX_SESSIONS) {
      throw fail('limit_reached', `Maximum of ${LIMITS.MAX_SESSIONS} running sessions reached`);
    }

    const kind = Object.values(KIND).includes(spec.kind) ? spec.kind : KIND.SHELL;
    const cwd = this.resolveCwd(spec.cwd);
    const cols = clamp(spec.cols, 20, 500, 120);
    const rows = clamp(spec.rows, 5, 200, 30);
    const id = crypto.randomUUID();

    const session = {
      id,
      name: String(spec.name || defaultNameFor(cwd, kind, this.usedNames())).slice(0, 120),
      kind,
      cwd,
      args: typeof spec.args === 'string' ? spec.args.slice(0, 2000) : '',
      // 'untrusted' for anything read out of a file in a repository: the
      // difference between a local operator choosing to disable the permission
      // model and a cloned recipe choosing it for them.
      trust: spec.trust === 'untrusted' ? 'untrusted' : 'trusted',
      warnings: [],
      cols,
      rows,
      status: STATUS.STARTING,
      createdAt: Date.now(),
      lastActivityAt: Date.now(),
      exitedAt: null,
      exitCode: null,
      // Detached from birth: a session nobody has attached to yet is exactly
      // what the detach TTL is meant to reclaim. attach() clears this.
      detachedAt: Date.now(),
      // A colour derived from the directory, so every agent in one repository
      // matches without anyone choosing anything. An explicit choice wins and
      // is remembered as such, so a later auto-assignment cannot overwrite it.
      tagColor: spec.tagColor || colorFor(cwd, [...this.sessions.values()]),
      colorAuto: !spec.tagColor,
      locked: false,
      agent: makeAgentState(),
      race: spec.race || null,
      clients: new Map(),
      buffer: new RingBuffer(LIMITS.SCROLLBACK_BYTES),
      decoder: new StringDecoder('utf8'),
      pty: null,
      pending: '',
      flushHandle: null,
      idleTimer: null,
      prompt: typeof spec.prompt === 'string' ? spec.prompt : null,
      promptSent: false,
    };

    this.sessions.set(id, session);
    this.scheduleSave();

    try {
      this.spawn(session, spec.env || {});
    } catch (e) {
      this.sessions.delete(id);
      // A refused argument is a bad request, not a spawn failure. Keeping the
      // original code lets the caller answer 400 rather than 500.
      throw fail(e.code === 'bad_request' ? 'bad_request' : 'spawn_failed',
        `Could not start ${kind}: ${e.message}`);
    }

    return session;
  }

  /**
   * Registers an agent Orchestra did not spawn.
   *
   * Hooks already reach this server from anywhere that has ORCHESTRA_URL and a
   * token, which is how an agent on a second machine can already have its
   * permission requests answered here. What was missing is that the server had
   * nowhere to put it: an event that matched no session was logged and dropped,
   * so the agent existed in the approval queue and nowhere else.
   *
   * The record is deliberately the same shape as a spawned session. Everything
   * downstream, the sidebar, the approval queue, the budget guard, the digest,
   * then works on it without knowing the difference. The only difference is
   * `pty: null`, which every write path already checks.
   *
   * The id is derived from host and Claude session id rather than random, so a
   * reconnecting agent lands back on its own record instead of accumulating a
   * new one per restart.
   *
   * @param {{claudeSessionId:string, host?:string, cwd?:string, name?:string}} spec
   * @returns {Object|null} the session, or null when it cannot be adopted
   */
  adoptExternal(spec = {}) {
    const claudeSessionId = typeof spec.claudeSessionId === 'string' ? spec.claudeSessionId.trim() : '';
    if (!claudeSessionId) return null;

    const host = (typeof spec.host === 'string' && spec.host.trim() ? spec.host.trim() : 'unknown').slice(0, 80);
    const id = `ext-${crypto.createHash('sha256').update(`${host}|${claudeSessionId}`).digest('hex').slice(0, 12)}`;

    const existing = this.sessions.get(id);
    if (existing) {
      if (existing.status === STATUS.EXITED) {
        // It came back. Reviving beats leaving a dead row next to a live agent.
        existing.status = STATUS.IDLE;
        existing.exitedAt = null;
        existing.exitCode = null;
      }
      existing.lastActivityAt = Date.now();
      return existing;
    }

    const external = [...this.sessions.values()]
      .filter(s => s.kind === KIND.EXTERNAL && s.status !== STATUS.EXITED).length;
    if (external >= LIMITS.MAX_EXTERNAL) {
      this.warn(`refusing to adopt another external agent: ${LIMITS.MAX_EXTERNAL} already tracked`);
      return null;
    }

    const cwd = typeof spec.cwd === 'string' && spec.cwd ? spec.cwd : config.HOME;
    const label = projectLabel(cwd) || host;
    const session = {
      id,
      name: String(spec.name || `${label} @ ${host}`).slice(0, 120),
      kind: KIND.EXTERNAL,
      cwd,
      args: '',
      trust: 'untrusted',
      warnings: [],
      cols: 80,
      rows: 24,
      status: STATUS.IDLE,
      createdAt: Date.now(),
      lastActivityAt: Date.now(),
      exitedAt: null,
      exitCode: null,
      // Never detached, because nothing can attach: the detach TTL must not
      // reclaim a record that is behaving exactly as designed.
      detachedAt: null,
      tagColor: colorFor(cwd, [...this.sessions.values()]),
      colorAuto: true,
      locked: false,
      agent: makeAgentState(),
      race: null,
      external: { host, claudeSessionId, adoptedAt: Date.now() },
      clients: new Map(),
      buffer: new RingBuffer(LIMITS.SCROLLBACK_BYTES),
      decoder: new StringDecoder('utf8'),
      pty: null,
      pending: '',
      flushHandle: null,
      idleTimer: null,
      prompt: null,
      promptSent: true,
    };
    session.agent.claudeSessionId = claudeSessionId;

    this.sessions.set(id, session);
    this.emit('session', this.toWire(session));
    return session;
  }

  resolveCwd(cwd) {
    if (!cwd || typeof cwd !== 'string') return config.HOME;
    const resolved = path.resolve(expandHome(cwd));
    return isDirectory(resolved) ? resolved : config.HOME;
  }

  /**
   * Build argv and spawn. `claude` is launched as its own process rather than
   * typed into a shell, so user-supplied arguments arrive as argv entries
   * instead of as text a shell would re-interpret.
   */
  spawn(session, extraEnv) {
    const env = {
      ...process.env,
      TERM: 'xterm-256color',
      COLORTERM: 'truecolor',
      [ENV.SESSION_ID]: session.id,
      [ENV.URL]: config.baseUrl,
      [ENV.TOKEN]: config.token,
      ...extraEnv,
    };
    if (session.race) {
      env[ENV.RACE_ID] = session.race.raceId;
      env[ENV.RACE_VARIANT] = session.race.variant;
    }
    // Claude Code sets these when it spawns a shell; leaving them in would make
    // a nested `claude` think it is running inside itself.
    delete env.CLAUDECODE;
    delete env.CLAUDE_CODE_ENTRYPOINT;

    let file;
    let argv;

    if (session.kind === KIND.CLAUDE) {
      const resolved = which(config.claudeBin);
      if (!resolved) {
        throw new Error(
          `"${config.claudeBin}" was not found in PATH. Install Claude Code, or set ORCHESTRA_CLAUDE_BIN.`
        );
      }
      const userArgs = splitArgs(session.args);
      const verdict = checkArgs(session.args, userArgs, session.trust || 'trusted');
      if (!verdict.ok) throw fail('bad_request', verdict.reason);
      session.warnings = verdict.warnings;

      if (needsShim(resolved)) {
        // `claude` installed by npm on Windows is a .cmd shim, so cmd.exe is
        // the only way in, and cmd's quoting rules fight with node-pty's:
        // node-pty escapes an inner quote the MSVC way (\"), which cmd does not
        // understand, and handing cmd separate argv entries instead trips its
        // other rule, where more than two quotes on the line make it strip the
        // outermost pair and cut the path at its first space.
        //
        // So: build the line here, quote it the way cmd expects, and pass it as
        // a string, which makes node-pty forward it verbatim. `/s` is what
        // makes cmd strip exactly the outer pair and take the rest literally.
        // checkArgs has already refused everything cmd treats as syntax.
        file = process.env.COMSPEC || 'cmd.exe';
        const parts = [resolved, ...userArgs].map(quoteForCmd);
        argv = `/d /s /c "${parts.join(' ')}"`;
      } else {
        file = resolved;
        argv = userArgs;
      }
    } else if (session.kind === KIND.POWERSHELL) {
      file = which('pwsh') || which('powershell') || 'powershell.exe';
      argv = ['-NoLogo'];
    } else {
      file = config.defaultShell;
      argv = config.IS_WIN ? [] : ['-i'];
    }

    const pty = nodePty.spawn(file, argv, {
      name: 'xterm-256color',
      cols: session.cols,
      rows: session.rows,
      cwd: session.cwd,
      env,
      useConpty: config.IS_WIN ? undefined : false,
    });

    session.pty = pty;
    session.ptyListeners = [
      pty.onData(chunk => this.onPtyData(session, chunk)),
      pty.onExit(({ exitCode, signal }) => this.onPtyExit(session, exitCode, signal)),
    ];

    this.setStatus(session, STATUS.STARTING);
  }

  /**
   * node-pty hands us strings already, but a raw Buffer can arrive on some
   * builds. Decoding through StringDecoder keeps a multi-byte character that
   * straddles a chunk boundary from turning into two replacement glyphs.
   */
  onPtyData(session, chunk) {
    const text = typeof chunk === 'string' ? chunk : session.decoder.write(chunk);
    if (!text) return;

    session.lastActivityAt = Date.now();
    session.pending += text;

    if (session.pending.length >= LIMITS.FLUSH_BYTES) {
      if (session.flushHandle) { clearImmediate(session.flushHandle); session.flushHandle = null; }
      this.flush(session);
    } else if (!session.flushHandle) {
      session.flushHandle = setImmediate(() => this.flush(session));
    }

    // A shell or REPL that is producing output is, by definition, working.
    // Hooks carry the truth for Claude sessions; for a plain shell this stays
    // the only signal available.
    if (session.kind !== KIND.CLAUDE) this.markActivity(session);
  }

  flush(session) {
    session.flushHandle = null;
    if (session.closed) return;
    const data = session.pending;
    session.pending = '';
    if (!data) return;

    const seq = session.buffer.append(data);
    this.maybeSendPrompt(session, data);

    for (const [ws, state] of session.clients) {
      if (ws.readyState !== 1) continue;

      // Per-client backpressure. A background tab or a phone on a bad link can
      // fall behind an `npm install`; rather than growing the socket buffer
      // without bound, stop sending to that client and let it resync from the
      // ring buffer once it drains.
      if (state.behind) {
        if (ws.bufferedAmount < LIMITS.BACKPRESSURE_LOW) this.resync(session, ws, state);
        continue;
      }
      if (ws.bufferedAmount > LIMITS.BACKPRESSURE_HIGH) {
        state.behind = true;
        this.armCatchUp();
        continue;
      }
      state.seq = seq;
      this.emit('deliver', { ws, id: session.id, seq, data });
    }

    this.emit('output', { id: session.id, seq, data });
  }

  resync(session, ws, state) {
    const { data, seq, truncated } = session.buffer.since(state.seq);
    state.behind = false;
    state.seq = seq;
    this.emit('resync', { ws, id: session.id, seq, data, truncated });
    // The catch-up payload is the whole backlog and can overflow the socket it
    // was meant to rescue. If it did, the client stays under watch.
    if (ws.bufferedAmount > LIMITS.BACKPRESSURE_HIGH) {
      state.behind = true;
      this.armCatchUp();
    }
  }

  /**
   * Starts watching the clients that fell behind.
   *
   * flush() is the only other place a behind client is reconsidered, so without
   * this a client whose socket drains after the last byte of a burst stays
   * permanently short of that burst's tail. The timer stops itself as soon as
   * no client is behind, so the steady state costs nothing.
   */
  armCatchUp() {
    if (this._catchUp) return;
    this._catchUp = setInterval(() => this.catchUp(), CATCH_UP_MS);
    if (this._catchUp.unref) this._catchUp.unref();
  }

  catchUp() {
    let stillBehind = false;
    for (const session of this.sessions.values()) {
      for (const [ws, state] of session.clients) {
        if (!state.behind) continue;
        if (ws.readyState !== 1) {
          // A closing socket is not going to drain; detachAll will drop it.
          state.behind = false;
          continue;
        }
        if (ws.bufferedAmount < LIMITS.BACKPRESSURE_LOW) this.resync(session, ws, state);
        if (state.behind) stillBehind = true;
      }
    }
    if (!stillBehind) this.stopCatchUp();
  }

  stopCatchUp() {
    if (!this._catchUp) return;
    clearInterval(this._catchUp);
    this._catchUp = null;
  }

  /**
   * Types the initial prompt once the REPL is actually up. We wait for Claude's
   * prompt glyph rather than guessing with a timer, so a slow machine does not
   * swallow half the prompt.
   */
  maybeSendPrompt(session, chunk) {
    if (!session.prompt || session.promptSent) return;
    if (session.kind !== KIND.CLAUDE) {
      session.promptSent = true;
      this.write(session.id, session.prompt + '\r');
      return;
    }
    if (/[❯>]\s*$/m.test(chunk) || /Try "/.test(chunk)) {
      session.promptSent = true;
      const text = session.prompt;
      setTimeout(() => this.write(session.id, text + '\r'), 250);
    }
  }

  /**
   * Everything a dying PTY still owes the scrollback: the pending chunk, then
   * whatever the decoder holds of a multi-byte character cut in half.
   */
  drain(session) {
    if (session.flushHandle) { clearImmediate(session.flushHandle); session.flushHandle = null; }
    this.flush(session);
    const tail = session.decoder.end();
    if (tail) session.buffer.append(tail);
  }

  /**
   * Drops the timers and the PTY subscriptions of a session that is over.
   * node-pty keeps firing onData after a kill on Windows, so unsubscribing is
   * the only thing that stops a session already announced as exited from going
   * on emitting output. Idempotent.
   */
  release(session) {
    clearTimeout(session.idleTimer);
    if (session.flushHandle) { clearImmediate(session.flushHandle); session.flushHandle = null; }
    for (const d of session.ptyListeners || []) {
      try {
        if (d && typeof d.dispose === 'function') d.dispose();
      } catch (e) {
        this.warn(`could not detach a PTY listener: ${e.message}`);
      }
    }
    session.ptyListeners = [];
  }

  onPtyExit(session, exitCode, signal) {
    if (session.closed) return;
    this.drain(session);
    session.status = STATUS.EXITED;
    session.exitedAt = Date.now();
    session.exitCode = typeof exitCode === 'number' ? exitCode : (signal ? 128 + signal : 0);
    session.pty = null;
    this.release(session);

    this.emit('exit', { id: session.id, code: session.exitCode });
    this.emit('session', this.toWire(session));
  }

  /** Marks a non-agent session busy, falling back to idle after quiet. */
  markActivity(session) {
    if (session.status === STATUS.EXITED) return;
    if (session.status !== STATUS.BUSY) {
      session.status = STATUS.BUSY;
      this.emit('session', this.toWire(session));
    }
    clearTimeout(session.idleTimer);
    session.idleTimer = setTimeout(() => {
      if (session.status === STATUS.BUSY) {
        session.status = STATUS.IDLE;
        this.emit('session', this.toWire(session));
      }
    }, 800);
  }

  setStatus(session, status, patch) {
    if (session.closed) return;
    if (patch) Object.assign(session.agent, patch);
    // The claudeSessionId that makes a resume possible arrives through here.
    this.scheduleSave();
    if (session.status === STATUS.EXITED && status !== STATUS.EXITED) return;
    session.status = status;
    session.lastActivityAt = Date.now();
    clearTimeout(session.idleTimer);
    this.emit('session', this.toWire(session));
  }

  /** @returns {{session: Object, snapshot: {data: string, seq: number, truncated: boolean}}|null} */
  attach(id, ws, sinceSeq) {
    const session = this.sessions.get(id);
    if (!session) return null;
    const state = { seq: Number.isFinite(sinceSeq) ? sinceSeq : 0, behind: false };
    session.clients.set(ws, state);
    session.detachedAt = null;
    const snapshot = session.buffer.since(state.seq);
    state.seq = snapshot.seq;
    this.emit('session', this.toWire(session));
    return { session, snapshot };
  }

  detach(id, ws) {
    const session = this.sessions.get(id);
    if (!session) return;
    session.clients.delete(ws);
    if (session.clients.size === 0) session.detachedAt = Date.now();
    this.emit('session', this.toWire(session));
  }

  /** Called when a socket dies: it detaches everywhere, it never kills. */
  detachAll(ws) {
    for (const session of this.sessions.values()) {
      if (session.clients.delete(ws)) {
        if (session.clients.size === 0) session.detachedAt = Date.now();
        this.emit('session', this.toWire(session));
      }
    }
  }

  write(id, data) {
    const session = this.sessions.get(id);
    if (!session || !session.pty || session.locked) return false;
    try {
      session.pty.write(data);
      return true;
    } catch {
      return false;
    }
  }

  resize(id, cols, rows) {
    const session = this.sessions.get(id);
    if (!session) return;
    session.cols = clamp(cols, 20, 500, session.cols);
    session.rows = clamp(rows, 5, 200, session.rows);
    if (!session.pty) return;
    try { session.pty.resize(session.cols, session.rows); } catch {}
  }

  rename(id, name) {
    const session = this.sessions.get(id);
    if (!session || typeof name !== 'string') return;
    session.name = name.slice(0, 120) || session.name;
    this.emit('session', this.toWire(session));
    // A shell emits no hooks, so nothing else would ever save this name, and
    // the orphan list would offer the work back under a name the user replaced.
    this.scheduleSave();
  }

  setMeta(id, patch = {}) {
    const session = this.sessions.get(id);
    if (!session) return;

    if (typeof patch.tagColor === 'string') {
      session.tagColor = patch.tagColor;
      session.colorAuto = false;
      // The colour identifies the project, not the terminal, so recolouring one
      // agent recolours its siblings in the same directory. Sessions someone
      // coloured by hand keep their choice.
      const key = dirKey(session.cwd);
      for (const other of this.sessions.values()) {
        if (other === session || other.colorAuto === false) continue;
        if (dirKey(other.cwd) !== key) continue;
        other.tagColor = patch.tagColor;
        this.emit('session', this.toWire(other));
      }
    }

    if (typeof patch.locked === 'boolean') session.locked = patch.locked;
    this.emit('session', this.toWire(session));
    this.scheduleSave();
  }

  /** Terminates the process but keeps the record so its output stays readable. */
  kill(id) {
    const session = this.sessions.get(id);
    if (!session) return;
    if (session.pty) {
      try { session.pty.kill(); } catch {}
    }
    if (session.status !== STATUS.EXITED) {
      this.drain(session);
      session.status = STATUS.EXITED;
      session.exitedAt = Date.now();
      session.exitCode = session.exitCode ?? 0;
      this.emit('exit', { id, code: session.exitCode });
      this.emit('session', this.toWire(session));
    }
    // The PTY is gone either way, and its callbacks must go with it.
    session.pty = null;
    this.release(session);
  }

  /** Kills and forgets. */
  close(id) {
    const session = this.sessions.get(id);
    if (!session) return;
    this.kill(id);
    // Nothing may be delivered to a client on behalf of this session again.
    session.clients.clear();
    session.closed = true;
    this.sessions.delete(id);
    this.scheduleSave();
    this.emit('closed', { id });
  }

  /** The fields that define a session, for building another one like it. */
  specOf(session) {
    return {
      kind: session.kind,
      name: session.name,
      cwd: session.cwd,
      args: session.args,
      cols: session.cols,
      rows: session.rows,
      tagColor: session.tagColor,
      race: session.race,
    };
  }

  /** Recreate a session with the same spec: name, cwd, args, colour and size. */
  restart(id) {
    const old = this.sessions.get(id);
    if (!old) return null;
    if (old.kind === KIND.EXTERNAL) throw fail('bad_request', 'an external agent is not ours to restart');
    const spec = this.specOf(old);
    this.close(id);
    return this.create(spec);
  }

  /** Same spec, new session, name suffixed with the next free number. */
  duplicate(id) {
    const src = this.sessions.get(id);
    if (!src) return null;
    if (src.kind === KIND.EXTERNAL) throw fail('bad_request', 'an external agent cannot be duplicated');
    const base = src.name.replace(/\s+\d+$/, '');
    const numbers = [...this.sessions.values()]
      .filter(s => s.name.startsWith(base))
      .map(s => {
        const m = s.name.match(/(\d+)$/);
        return m ? Number(m[1]) : 1;
      });
    return this.create({
      ...this.specOf(src),
      name: `${base} ${Math.max(0, ...numbers) + 1}`,
      // A copy is its own work, not a second entry in someone else's race.
      race: null,
    });
  }

  sweepDetached() {
    const now = Date.now();
    for (const session of this.sessions.values()) {
      // An external agent has no PTY and nothing ever attaches to it, so the
      // detach TTL would reclaim every one of them within the hour. Silence on
      // its hooks is the only evidence that it is gone.
      if (session.kind === KIND.EXTERNAL) {
        if (session.status !== STATUS.EXITED
            && now - (session.lastActivityAt || session.createdAt) > LIMITS.EXTERNAL_TTL_MS) {
          session.status = STATUS.EXITED;
          session.exitedAt = now;
          session.exitCode = null;
          this.emit('exit', { id: session.id, code: null });
          this.emit('session', this.toWire(session));
        }
        continue;
      }
      if (session.clients.size > 0 || !session.detachedAt) continue;
      const ttl = session.kind === KIND.CLAUDE ? config.detachTtlMs : config.shellDetachTtlMs;
      if (ttl > 0 && now - session.detachedAt > ttl) this.close(session.id);
    }
    this.reapExited();
  }

  /**
   * Drops the oldest exited sessions once there are more than a screenful.
   * Their output stays readable for a while after the process dies, which is
   * the point, but they must not accumulate forever.
   */
  reapExited() {
    const exited = [...this.sessions.values()]
      .filter(s => s.status === STATUS.EXITED && s.clients.size === 0)
      .sort((a, b) => (a.exitedAt || 0) - (b.exitedAt || 0));
    for (const session of exited.slice(0, Math.max(0, exited.length - EXITED_KEPT))) {
      this.close(session.id);
    }
  }

  shutdown() {
    clearInterval(this._sweep);
    this.stopCatchUp();
    if (this._saveTimer) clearTimeout(this._saveTimer);
    // Write once more on the way out, so a clean stop leaves the same record a
    // crash would rather than a stale one.
    this.save();
    for (const session of this.sessions.values()) {
      this.release(session);
      // Same contract as close(): nothing may be delivered on behalf of this
      // session again, whatever a late callback still holds.
      session.closed = true;
      session.clients.clear();
      if (session.pty) {
        try { session.pty.kill(); } catch (e) { this.warn(`kill failed: ${e.message}`); }
      }
    }
    this.sessions.clear();
  }
}

module.exports = { SessionManager };
