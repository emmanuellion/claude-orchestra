'use strict';

const { STATUS, HOOK_EVENT } = require('./protocol');

/**
 * What happened while you were away.
 *
 * Everything here already existed and was unreadable: the hook timeline is a
 * JSONL file nobody opens, the costs are a number per panel, the quota blocks
 * and budget locks are events that scrolled past at 03:00. Coming back to six
 * agents means reconstructing a night from six scrollbacks.
 *
 * This is the other half of unattended work. Auto resume lets an agent keep
 * going without you; a digest lets you rejoin without reading everything. It
 * introduces no new data source on purpose, it only answers the question the
 * existing ones cannot: what changed, what did it cost, and what is waiting
 * for me.
 *
 * The output leads with `attention`, because after eight hours the only urgent
 * question is what is blocked.
 */

/** Timeline events read for one digest. The bus caps at 5000 regardless. */
const MAX_EVENTS = 5000;

/** Tools listed in the "what it did" breakdown. */
const TOP_TOOLS = 8;

/** Default window when the caller does not say: one working absence. */
const DEFAULT_WINDOW_MS = 12 * 3600 * 1000;

function makeLogger(logger) {
  const base = logger && typeof logger === 'object' ? logger : {};
  const bind = (name, fallback) =>
    (typeof base[name] === 'function' ? base[name].bind(base) : fallback);
  return { info: bind('info', () => {}), warn: bind('warn', console.warn.bind(console)) };
}

function plural(n, one, many) {
  return `${n} ${n === 1 ? one : many || `${one}s`}`;
}

function shortDuration(ms) {
  if (!Number.isFinite(ms) || ms < 0) return '';
  const mins = Math.round(ms / 60000);
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  const rest = mins % 60;
  return rest ? `${hours}h${String(rest).padStart(2, '0')}` : `${hours}h`;
}

class Digest {
  /**
   * @param {Object} deps
   * @param {import('./session-manager').SessionManager} deps.sessions
   * @param {import('./hook-bus').HookBus} deps.hookBus
   * @param {import('./budget').BudgetGuard} [deps.budget]
   * @param {import('./auto-resume').AutoResume} [deps.autoResume]
   * @param {import('./approvals').ApprovalQueue} [deps.approvals]
   * @param {Object} [deps.logger]
   */
  constructor({ sessions, hookBus, budget = null, autoResume = null, approvals = null, logger = null } = {}) {
    if (!sessions) throw new Error('Digest requires a SessionManager');
    if (!hookBus) throw new Error('Digest requires a HookBus');
    this.sessions = sessions;
    this.hookBus = hookBus;
    this.budget = budget;
    this.autoResume = autoResume;
    this.approvals = approvals;
    this.log = makeLogger(logger);
  }

  /**
   * @param {{since?:number, until?:number}} [range]
   * @returns {Promise<Object>}
   */
  async build({ since, until } = {}) {
    const now = Date.now();
    const end = Number.isFinite(until) ? until : now;
    const start = Number.isFinite(since) ? since : end - DEFAULT_WINDOW_MS;

    let events = [];
    try {
      events = await this.hookBus.timeline({ since: start, limit: MAX_EVENTS });
    } catch (err) {
      this.log.warn(`[digest] could not read the timeline: ${err.message}`);
    }
    const inWindow = events.filter(e => e && e.ts >= start && e.ts <= end);

    const work = this._work(inWindow);
    const sessions = this._sessions(start, end);
    const cost = this._cost(start);
    const attention = this._attention(inWindow);

    return {
      since: start,
      until: end,
      windowMs: end - start,
      attention,
      sessions,
      work,
      cost,
      events: { total: inWindow.length, firstAt: inWindow.length ? inWindow[0].ts : null, lastAt: inWindow.length ? inWindow[inWindow.length - 1].ts : null },
      highlights: this._highlights({ attention, sessions, work, cost, windowMs: end - start }),
    };
  }

  _work(events) {
    const tools = new Map();
    let turns = 0;
    let toolCalls = 0;
    let toolFailures = 0;
    let subagents = 0;
    let totalToolMs = 0;

    for (const e of events) {
      if (e.event === HOOK_EVENT.USER_PROMPT_SUBMIT) turns += 1;
      if (e.event === HOOK_EVENT.SUBAGENT_STOP) subagents += 1;
      if (e.event === HOOK_EVENT.POST_TOOL_USE) {
        toolCalls += 1;
        if (e.ok === false) toolFailures += 1;
        if (Number.isFinite(e.durationMs)) totalToolMs += e.durationMs;
        const name = e.tool || 'unknown';
        const entry = tools.get(name) || { tool: name, count: 0, failures: 0, totalMs: 0 };
        entry.count += 1;
        if (e.ok === false) entry.failures += 1;
        if (Number.isFinite(e.durationMs)) entry.totalMs += e.durationMs;
        tools.set(name, entry);
      }
    }

    return {
      turns,
      toolCalls,
      toolFailures,
      subagents,
      totalToolMs,
      topTools: [...tools.values()].sort((a, b) => b.count - a.count).slice(0, TOP_TOOLS),
    };
  }

  _sessions(start, end) {
    const all = this.sessions.list();
    const live = all.filter(s => s.status !== STATUS.EXITED);
    const exitedInWindow = all.filter(
      s => s.status === STATUS.EXITED && s.exitedAt && s.exitedAt >= start && s.exitedAt <= end,
    );
    const startedInWindow = all.filter(s => s.createdAt >= start && s.createdAt <= end);

    const byProject = new Map();
    for (const s of all) {
      const key = s.project || s.cwd || 'unknown';
      const entry = byProject.get(key) || { project: key, sessions: 0, cost: 0 };
      entry.sessions += 1;
      entry.cost += Number(s.agent && s.agent.cost) || 0;
      byProject.set(key, entry);
    }

    return {
      total: all.length,
      live: live.length,
      startedInWindow: startedInWindow.length,
      exitedInWindow: exitedInWindow.length,
      locked: live.filter(s => s.locked).length,
      byProject: [...byProject.values()].sort((a, b) => b.cost - a.cost),
      // Named, because "3 exited" is a statistic and "api worker exited (1)"
      // is something to go and look at.
      exited: exitedInWindow.map(s => ({
        id: s.id, name: s.name, exitCode: s.exitCode, exitedAt: s.exitedAt,
      })),
    };
  }

  _cost(start) {
    const bySession = this.sessions.list()
      .map(s => ({
        id: s.id,
        name: s.name,
        project: s.project,
        cost: Number(s.agent && s.agent.cost) || 0,
        live: s.status !== STATUS.EXITED,
      }))
      .filter(s => s.cost > 0)
      .sort((a, b) => b.cost - a.cost);

    const total = bySession.reduce((sum, s) => sum + s.cost, 0);
    const today = this.budget ? this.budget.todayTotal() : null;
    const history = this.budget ? this.budget.history().filter(d => Date.parse(d.day) >= start - 86400000) : [];

    return { total, today, bySession, history };
  }

  _attention(events) {
    const pending = this.approvals ? this.approvals.pending() : [];
    const plans = this.autoResume ? this.autoResume.plans() : [];
    const budgetState = this.budget ? this.budget.state() : null;

    const questions = this.sessions.list()
      .filter(s => s.status === STATUS.AWAITING_INPUT)
      .map(s => ({ id: s.id, name: s.name, question: (s.agent && s.agent.lastQuestion) || null }));

    const stalls = events.filter(e => e.event === 'Stalled').length;

    return {
      pendingApprovals: pending.map(p => ({
        id: p.id, sessionId: p.sessionId, sessionName: p.sessionName, tool: p.tool, summary: p.summary, createdAt: p.createdAt,
      })),
      questions,
      stalls,
      quotaBlocked: plans
        .filter(p => p.state === 'armed' || p.state === 'waiting')
        .map(p => ({ sessionId: p.sessionId, name: p.name, resetsAt: p.resetsAt, resetsText: p.resetsText, state: p.state })),
      resumed: plans
        .filter(p => p.state === 'sent' && p.lastSentAt)
        .map(p => ({ sessionId: p.sessionId, name: p.name, at: p.lastSentAt, attempts: p.attempts })),
      giveUps: plans.filter(p => p.state === 'expired').map(p => ({ sessionId: p.sessionId, name: p.name, reason: p.lastError })),
      budgetBreaches: budgetState ? budgetState.breaches : [],
      lockedSessions: this.sessions.list()
        .filter(s => s.locked && s.status !== STATUS.EXITED)
        .map(s => ({ id: s.id, name: s.name })),
    };
  }

  /**
   * The digest in sentences, ordered by what a returning operator has to act on
   * first. Everything above is available for a UI to render richly; this is what
   * survives being read on a phone at a bus stop.
   */
  _highlights({ attention, sessions, work, cost, windowMs }) {
    const out = [];
    const window = shortDuration(windowMs);

    if (attention.pendingApprovals.length) {
      const oldest = attention.pendingApprovals
        .reduce((a, b) => (a.createdAt <= b.createdAt ? a : b));
      out.push(
        `${plural(attention.pendingApprovals.length, 'permission request')} waiting, `
        + `the oldest from ${oldest.sessionName || 'an agent'} (${oldest.tool}).`,
      );
    }
    if (attention.questions.length) {
      out.push(`${plural(attention.questions.length, 'agent')} asked a question and stopped.`);
    }
    if (attention.budgetBreaches.length) {
      const locked = attention.budgetBreaches.filter(b => b.locked).length;
      out.push(
        `${plural(attention.budgetBreaches.length, 'budget cap')} reached`
        + (locked ? `, ${locked} session${locked > 1 ? 's' : ''} locked.` : '.'),
      );
    }
    if (attention.quotaBlocked.length) {
      out.push(`${plural(attention.quotaBlocked.length, 'session')} still waiting on a quota reset.`);
    }
    if (attention.resumed.length) {
      out.push(`${plural(attention.resumed.length, 'session')} resumed automatically after a quota reset.`);
    }
    if (attention.giveUps.length) {
      out.push(`${plural(attention.giveUps.length, 'session')} could not be resumed and was left alone.`);
    }
    if (attention.stalls) {
      out.push(`${plural(attention.stalls, 'stall')} reported.`);
    }

    if (work.turns || work.toolCalls) {
      const failure = work.toolFailures
        ? `, ${plural(work.toolFailures, 'failure')}`
        : '';
      out.push(
        `Over ${window}: ${plural(work.turns, 'turn')}, ${plural(work.toolCalls, 'tool call')}${failure}.`,
      );
    }
    if (sessions.exitedInWindow) {
      const bad = sessions.exited.filter(s => s.exitCode).length;
      out.push(
        `${plural(sessions.exitedInWindow, 'session')} ended`
        + (bad ? `, ${bad} with a non-zero exit code.` : '.'),
      );
    }
    if (cost.total > 0) {
      out.push(`$${cost.total.toFixed(2)} across ${plural(cost.bySession.length, 'session')}.`);
    }

    if (!out.length) out.push('Nothing happened while you were away.');
    return out;
  }
}

module.exports = { Digest, DEFAULT_WINDOW_MS, MAX_EVENTS };
