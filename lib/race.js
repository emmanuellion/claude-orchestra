'use strict';

const { EventEmitter } = require('events');
const { execFile } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const { setTimeout: sleep } = require('timers/promises');

const defaultConfig = require('./config');
const { KIND } = require('./protocol');
const { which } = require('./which');

/** Per-file patch ceiling. Beyond this the patch is cut and flagged. */
const MAX_PATCH_BYTES = 200 * 1024;
/** Files per variant for which we are willing to spawn a `git diff`. */
const MAX_PATCH_FILES = 200;
/** Upper bound on variants in one race. */
const MAX_VARIANTS = 8;
/** Entries kept in the scoreboard file. */
const MAX_SCOREBOARD_ENTRIES = 500;

const GIT_TIMEOUT_MS = 120000;
/** Merges and commits can run user hooks, which can run a test suite. */
const GIT_SLOW_TIMEOUT_MS = 600000;

const RACE_STATUS = {
  RUNNING: 'running',
  ADOPTED: 'adopted',
  DISCARDED: 'discarded',
};

const RACE_ID_RE = /^[0-9a-fA-F][0-9a-fA-F-]{7,63}$/;

/**
 * Strip a user-supplied variant label down to something that is safe both as a
 * path segment and as a git ref component. Done before any concatenation, so a
 * name can never escape the races directory or smuggle a ref qualifier.
 */
function sanitizeVariantName(raw) {
  return String(raw == null ? '' : raw)
    .replace(/[^a-zA-Z0-9_-]+/g, '-')
    .replace(/^[-.]+/, '')
    .replace(/[-.]+$/, '')
    .slice(0, 40);
}

function shortId(raceId) {
  return String(raceId).replace(/-/g, '').slice(0, 8);
}

function isRaceId(id) {
  return typeof id === 'string' && RACE_ID_RE.test(id) && !id.includes('..');
}

/** The most informative thing a failed git run said, in one string. */
function gitDetail(res, fallback = '') {
  return (res.stderr || res.stdout || res.failure || fallback).trim();
}

function badRequest(message) {
  const err = new Error(message);
  err.code = 'bad_request';
  return err;
}

function notFound(message) {
  const err = new Error(message);
  err.code = 'not_found';
  return err;
}

async function pathExists(target) {
  try {
    await fsp.access(target);
    return true;
  } catch {
    return false;
  }
}

/** How long a variant's agent has been at it, or null when it is gone. */
function durationOf(session) {
  return session ? (session.exitedAt || Date.now()) - session.createdAt : null;
}

function numberOr(value, fallback) {
  return typeof value === 'number' ? value : fallback;
}

/**
 * Turn the requested variants into unique names, branches and worktree paths.
 * Names collide easily once sanitized ("fix it!" and "fix it?" are one label),
 * and two variants sharing a directory would race for the same files.
 */
function planVariants(variants, { dir, sid }) {
  const planned = [];
  const used = new Set();
  for (let i = 0; i < variants.length; i++) {
    const spec = variants[i] || {};
    const name = sanitizeVariantName(spec.name) || `variant-${i + 1}`;
    let unique = name;
    let n = 2;
    while (used.has(unique)) unique = `${name}-${n++}`;
    used.add(unique);
    planned.push({
      name: unique,
      args: typeof spec.args === 'string' ? spec.args.slice(0, 2000) : '',
      branch: `orchestra/race-${sid}-${unique}`,
      path: path.join(dir, unique),
      sessionId: null,
    });
  }
  return planned;
}

/**
 * Write JSON through a temp file and a rename, optionally keeping the previous
 * content as `.bak`. A half written descriptor is worse than a missing one: the
 * race would still hold worktrees nobody could find again.
 */
async function writeJsonAtomic(file, data, { backup = false } = {}) {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  if (backup) {
    try {
      await fsp.copyFile(file, `${file}.bak`);
    } catch (e) {
      if (e.code !== 'ENOENT') throw e;
    }
  }
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  const handle = await fsp.open(tmp, 'w');
  try {
    await handle.writeFile(JSON.stringify(data, null, 2));
    await handle.sync();
  } finally {
    await handle.close();
  }
  await fsp.rename(tmp, file);
}

class RaceManager extends EventEmitter {
  /**
   * @param {{sessions: import('./session-manager').SessionManager,
   *          config?: Object, logger?: {info?:Function, warn?:Function, error?:Function}}} deps
   */
  constructor({ sessions, config, logger } = {}) {
    super();
    if (!sessions) throw new Error('RaceManager requires a SessionManager');
    this.sessions = sessions;
    this.config = config || defaultConfig;
    this.logger = logger || console;
    this.gitBin = which('git');
  }

  get available() {
    return !!this.gitBin;
  }

  get unavailableReason() {
    return this.gitBin ? null : 'git was not found in PATH. Race mode needs git worktrees.';
  }

  log(level, message) {
    const fn = this.logger && this.logger[level];
    if (typeof fn === 'function') fn.call(this.logger, message);
  }

  /**
   * Run git with argv, never a shell. Every branch name, path and commit that
   * reaches this function came from user input at some point, so the argument
   * vector is the only thing standing between a variant label and a command.
   *
   * @returns {Promise<{code:number, stdout:string, stderr:string, failure:string|null}>}
   */
  gitTry(args, cwd, opts = {}) {
    if (!this.gitBin) {
      return Promise.resolve({
        code: -1, stdout: '', stderr: '', failure: this.unavailableReason,
      });
    }
    return new Promise(resolve => {
      execFile(this.gitBin, args, {
        cwd,
        maxBuffer: 64 * 1024 * 1024,
        timeout: opts.timeout || GIT_TIMEOUT_MS,
        windowsHide: true,
        encoding: 'utf8',
        env: {
          ...process.env,
          // A credential or pager prompt inside a spawned git would hang the
          // request forever with nothing on screen to explain it.
          GIT_TERMINAL_PROMPT: '0',
          GIT_PAGER: 'cat',
          GIT_OPTIONAL_LOCKS: '0',
        },
      }, (error, stdout, stderr) => {
        const out = stdout == null ? '' : String(stdout);
        const err = stderr == null ? '' : String(stderr);
        if (error) {
          const code = typeof error.code === 'number' ? error.code : 1;
          // stderr stays raw: a failing `git merge` says CONFLICT on stdout and
          // nothing on stderr, and that is the line the user needs to read.
          resolve({ code, stdout: out, stderr: err, failure: error.message });
          return;
        }
        resolve({ code: 0, stdout: out, stderr: err, failure: null });
      });
    });
  }

  /** Same, but a non-zero exit becomes an Error carrying git's own output. */
  async git(args, cwd, opts) {
    const res = await this.gitTry(args, cwd, opts);
    if (res.code !== 0) {
      const detail = gitDetail(res).split('\n').slice(0, 6).join('\n');
      const err = new Error(`git ${args.join(' ')} failed: ${detail || `exit ${res.code}`}`);
      err.code = 'git_failed';
      err.exitCode = res.code;
      err.stderr = res.stderr;
      throw err;
    }
    return res;
  }

  raceDir(raceId) {
    if (!isRaceId(raceId)) throw badRequest('Invalid race id');
    return path.join(this.config.racesDir, raceId);
  }

  raceFile(raceId) {
    return path.join(this.raceDir(raceId), 'race.json');
  }

  async readRace(raceId) {
    let text;
    try {
      text = await fsp.readFile(this.raceFile(raceId), 'utf-8');
    } catch (e) {
      if (e.code === 'ENOENT') return null;
      throw e;
    }
    try {
      return JSON.parse(text);
    } catch (e) {
      this.log('error', `Race descriptor ${raceId} is unreadable: ${e.message}`);
      return null;
    }
  }

  async saveRace(race) {
    await writeJsonAtomic(this.raceFile(race.id), race, { backup: true });
    return race;
  }

  /**
   * Descriptors live on disk, so a server restart does not lose the worktrees
   * it created. Live session state is layered back on top when it still exists.
   */
  async list() {
    let names;
    try {
      names = await fsp.readdir(this.config.racesDir);
    } catch (e) {
      if (e.code === 'ENOENT') return [];
      throw e;
    }
    const races = [];
    for (const name of names) {
      if (!isRaceId(name)) continue;
      let race;
      try {
        race = await this.readRace(name);
      } catch (e) {
        this.log('warn', `Skipping race ${name}: ${e.message}`);
        continue;
      }
      if (race && race.id) races.push(this.decorate(race));
    }
    races.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
    return races;
  }

  async get(raceId) {
    const race = await this.readRace(raceId);
    return race ? this.decorate(race) : null;
  }

  /** Attaches whatever the SessionManager still knows about each variant. */
  decorate(race) {
    const variants = (race.variants || []).map(v => {
      const session = v.sessionId ? this.sessions.get(v.sessionId) : null;
      return {
        ...v,
        session: session
          ? {
            id: session.id,
            status: session.status,
            exitCode: session.exitCode,
            cost: session.agent.cost,
            turns: session.agent.turns,
            model: session.agent.model,
            tool: session.agent.tool,
            durationMs: durationOf(session),
          }
          : null,
      };
    });
    return { ...race, variants };
  }

  /** Absolute path of an existing git repository, or a bad request. */
  async resolveRepo(repo) {
    if (typeof repo !== 'string' || !repo.trim()) {
      throw badRequest('A race needs a repository path');
    }
    const repoPath = path.resolve(repo.startsWith('~')
      ? path.join(this.config.HOME, repo.slice(1))
      : repo);

    let stat;
    try {
      stat = await fsp.stat(repoPath);
    } catch {
      throw badRequest(`${repoPath} does not exist`);
    }
    if (!stat.isDirectory()) throw badRequest(`${repoPath} is not a directory`);

    const gitDir = await this.gitTry(['rev-parse', '--git-dir'], repoPath);
    if (gitDir.code !== 0) throw badRequest(`${repoPath} is not a git repository`);
    return repoPath;
  }

  /**
   * One worktree and one agent per variant, all from the same base commit.
   * `variants` is `[{name, args?}]`.
   */
  async create({ prompt, repo, variants } = {}) {
    if (!this.gitBin) throw badRequest(this.unavailableReason);
    if (typeof prompt !== 'string' || !prompt.trim()) {
      throw badRequest('A race needs a prompt');
    }
    const repoPath = await this.resolveRepo(repo);
    if (!Array.isArray(variants) || variants.length === 0) {
      throw badRequest('A race needs at least one variant');
    }
    if (variants.length > MAX_VARIANTS) {
      throw badRequest(`A race takes at most ${MAX_VARIANTS} variants`);
    }

    const baseCommit = (await this.git(['rev-parse', 'HEAD'], repoPath)).stdout.trim();
    const headRef = (await this.git(['rev-parse', '--abbrev-ref', 'HEAD'], repoPath)).stdout.trim();
    const baseBranch = headRef === 'HEAD' ? null : headRef;

    const status = await this.gitTry(['status', '--porcelain'], repoPath);
    const dirtyBase = status.code === 0 && status.stdout.trim().length > 0;
    if (dirtyBase) {
      this.log('warn',
        `Race base ${repoPath} has uncommitted changes; worktrees start from ${baseCommit.slice(0, 8)} without them`);
    }
    if (!baseBranch) {
      this.log('warn', `Race base ${repoPath} is on a detached HEAD; adopt will need an explicit branch`);
    }

    const raceId = crypto.randomUUID();
    const dir = this.raceDir(raceId);
    await fsp.mkdir(dir, { recursive: true });
    const planned = planVariants(variants, { dir, sid: shortId(raceId) });

    const createdWorktrees = [];
    const createdSessions = [];
    try {
      for (const variant of planned) {
        await this.git(
          ['worktree', 'add', '-b', variant.branch, variant.path, baseCommit],
          repoPath
        );
        createdWorktrees.push(variant);

        const session = this.sessions.create({
          kind: KIND.CLAUDE,
          name: variant.name,
          cwd: variant.path,
          args: variant.args,
          prompt,
          race: { raceId, variant: variant.name },
        });
        variant.sessionId = session.id;
        createdSessions.push(session.id);
      }
    } catch (e) {
      await this.rollback(repoPath, createdWorktrees, createdSessions, dir);
      throw e;
    }

    const race = {
      id: raceId,
      prompt,
      repo: repoPath,
      baseCommit,
      baseBranch,
      dirtyBase,
      createdAt: Date.now(),
      finishedAt: null,
      variants: planned,
      status: RACE_STATUS.RUNNING,
      winner: null,
    };

    await this.saveRace(race);
    const decorated = this.decorate(race);
    this.emit('race', decorated);
    return decorated;
  }

  /** Undo a partially built race so a failure never leaves orphan worktrees. */
  async rollback(repoPath, worktrees, sessionIds, dir) {
    for (const id of sessionIds) {
      try {
        this.sessions.close(id);
      } catch (e) {
        this.log('error', `Rollback could not close session ${id}: ${e.message}`);
      }
    }
    for (const variant of worktrees) {
      await this.removeWorktree(repoPath, variant, { deleteBranch: true });
    }
    try {
      await fsp.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    } catch (e) {
      this.log('error', `Rollback could not remove ${dir}: ${e.message}`);
    }
  }

  /**
   * Side by side view of what every variant did to the base commit.
   *
   * @returns {Promise<{files:Array, summary:Object, race:Object}>}
   */
  async diffs(raceId) {
    const race = await this.readRace(raceId);
    if (!race) throw notFound(`Race ${raceId} not found`);

    const names = race.variants.map(v => v.name);
    /** @type {Map<string, {path:string, variants:Object}>} */
    const byPath = new Map();
    const summary = {};

    for (const variant of race.variants) {
      const session = variant.sessionId ? this.sessions.get(variant.sessionId) : null;
      const entry = {
        files: 0,
        additions: 0,
        deletions: 0,
        cost: session ? session.agent.cost : null,
        durationMs: durationOf(session),
        error: null,
      };
      summary[variant.name] = entry;

      if (!(await pathExists(variant.path))) {
        entry.error = 'worktree is gone';
        continue;
      }

      let changes;
      try {
        changes = await this.variantChanges(variant, race.baseCommit);
      } catch (e) {
        entry.error = e.message;
        this.log('error', `Diff for race ${raceId} variant ${variant.name} failed: ${e.message}`);
        continue;
      }

      entry.files = changes.length;
      for (const change of changes) {
        entry.additions += change.additions;
        entry.deletions += change.deletions;
        let row = byPath.get(change.path);
        if (!row) {
          row = { path: change.path, variants: {} };
          for (const n of names) row.variants[n] = null;
          byPath.set(change.path, row);
        }
        row.variants[variant.name] = {
          status: change.status,
          additions: change.additions,
          deletions: change.deletions,
          binary: change.binary,
          patch: change.patch,
          truncated: change.truncated,
        };
      }
    }

    const files = [...byPath.values()].sort((a, b) => a.path.localeCompare(b.path));
    return { race: this.decorate(race), files, summary };
  }

  /** Numstat plus per-file patch for one worktree against the base commit. */
  async variantChanges(variant, baseCommit) {
    // Register untracked files in the index without staging their content, so
    // a brand new file shows up in `git diff` like every other change. Safe
    // here because the worktree belongs to Orchestra, not to the user.
    const intent = await this.gitTry(['add', '-A', '-N'], variant.path);
    if (intent.code !== 0) {
      this.log('warn', `intent-to-add failed in ${variant.path}: ${gitDetail(intent)}`);
    }

    const base = ['diff', '--no-renames', baseCommit];
    const numstat = await this.git([...base, '--numstat', '-z'], variant.path);
    const namestatus = await this.git([...base, '--name-status', '-z'], variant.path);

    const statusByPath = new Map();
    const nsTokens = namestatus.stdout.split('\0').filter(t => t !== '');
    for (let i = 0; i + 1 < nsTokens.length; i += 2) {
      statusByPath.set(nsTokens[i + 1], nsTokens[i].trim());
    }

    const changes = [];
    // `--numstat -z` writes one NUL terminated record per file, shaped
    // `adds \t dels \t path`. Renames would split the path across two extra
    // records, which is exactly why `--no-renames` is on.
    const tokens = numstat.stdout.split('\0').filter(t => t !== '');
    for (const token of tokens) {
      const m = token.match(/^(\d+|-)\t(\d+|-)\t([\s\S]+)$/);
      if (!m) {
        this.log('warn', `Unparsed numstat record in ${variant.path}: ${JSON.stringify(token)}`);
        continue;
      }
      const filePath = m[3];
      const binary = m[1] === '-' || m[2] === '-';
      changes.push({
        path: filePath,
        status: statusByPath.get(filePath) || 'M',
        additions: binary ? 0 : Number(m[1]),
        deletions: binary ? 0 : Number(m[2]),
        binary,
        patch: null,
        truncated: false,
      });
    }

    for (let i = 0; i < changes.length; i++) {
      const change = changes[i];
      if (change.binary) continue;
      if (i >= MAX_PATCH_FILES) {
        change.truncated = true;
        continue;
      }
      const res = await this.gitTry([...base, '--', change.path], variant.path);
      if (res.code !== 0) {
        this.log('warn', `Patch for ${change.path} failed: ${gitDetail(res)}`);
        continue;
      }
      if (res.stdout.length > MAX_PATCH_BYTES) {
        change.patch = res.stdout.slice(0, MAX_PATCH_BYTES);
        change.truncated = true;
      } else {
        change.patch = res.stdout;
      }
    }

    return changes;
  }

  /**
   * Merge one variant back into the branch the race started from.
   *
   * A conflicting merge is left exactly as git left it: the conflict markers
   * are the user's to resolve. Aborting would silently throw away the work the
   * race was run to produce.
   *
   * @returns {Promise<{ok:boolean, conflict:boolean, message?:string, race?:Object,
   *                    branch?:string, target?:string, mergeCommit?:string|null, removed?:string[]}>}
   */
  async adopt(raceId, variantName) {
    const race = await this.readRace(raceId);
    if (!race) throw notFound(`Race ${raceId} not found`);
    const name = sanitizeVariantName(variantName);
    const variant = race.variants.find(v => v.name === name);
    if (!variant) throw notFound(`Race ${raceId} has no variant "${variantName}"`);
    if (race.status === RACE_STATUS.ADOPTED) {
      return { ok: false, conflict: false, message: `Race already adopted "${race.winner}"` };
    }
    if (!race.baseBranch) {
      return {
        ok: false,
        conflict: false,
        message: 'The race started from a detached HEAD, so there is no branch to merge into. '
          + `Merge ${variant.branch} by hand.`,
      };
    }

    // Snapshot the numbers before anything is removed; the scoreboard is the
    // only reason these races are worth running twice.
    let snapshot = null;
    try {
      snapshot = await this.diffs(raceId);
    } catch (e) {
      this.log('warn', `Could not measure race ${raceId} before adopting: ${e.message}`);
    }

    const commit = await this.commitWorktree(race, variant);
    if (!commit.ok) return commit;

    const current = await this.gitTry(['rev-parse', '--abbrev-ref', 'HEAD'], race.repo);
    const currentBranch = current.code === 0 ? current.stdout.trim() : null;
    if (currentBranch !== race.baseBranch) {
      return {
        ok: false,
        conflict: false,
        message: `${race.repo} is on "${currentBranch || 'an unknown ref'}" but the race started on `
          + `"${race.baseBranch}". Check that branch out, then adopt again.`,
      };
    }

    const merge = await this.gitTry(
      ['merge', '--no-ff', '-m', `orchestra: adopt race ${shortId(race.id)} variant ${variant.name}`, variant.branch],
      race.repo,
      { timeout: GIT_SLOW_TIMEOUT_MS }
    );

    if (merge.code !== 0) {
      const unmerged = await this.gitTry(['ls-files', '--unmerged'], race.repo);
      const conflict = (unmerged.code === 0 && unmerged.stdout.trim().length > 0)
        || /conflict/i.test(`${merge.stdout}\n${merge.stderr}`);
      const message = gitDetail(merge, 'merge failed');
      this.log('warn', `Adopting race ${raceId} variant ${name} failed: ${message}`);
      return {
        ok: false,
        conflict,
        message: conflict
          ? `Merging ${variant.branch} conflicts. Nothing was undone: resolve the conflict in `
            + `${race.repo}, then commit. The race worktrees are still there.`
          : message,
        branch: variant.branch,
        detail: message,
      };
    }

    const head = await this.gitTry(['rev-parse', 'HEAD'], race.repo);
    const mergeCommit = head.code === 0 ? head.stdout.trim() : null;

    // Adoption is a full stop. Keeping the winner's worktree alive would leave
    // an agent working in a directory whose branch is already merged, so its
    // later edits would land nowhere the user is looking, and every race would
    // leave another entry in `git worktree list` forever. The winner's branch
    // is kept (the merge commit references it) but its checkout is torn down.
    const removed = [];
    for (const other of race.variants) {
      const isWinner = other.name === variant.name;
      if (other.sessionId) {
        try {
          // close(), not kill(): kill leaves the record in the session map, and
          // the map is what MAX_SESSIONS counts, so adopted races would fill it
          // with corpses until nothing could start. close() still kills the PTY
          // first, which Windows needs before the directory can go.
          this.sessions.close(other.sessionId);
        } catch (e) {
          this.log('warn', `Could not stop session ${other.sessionId}: ${e.message}`);
        }
      }
      const gone = await this.removeWorktree(race.repo, other, { deleteBranch: !isWinner });
      if (gone) removed.push(other.name);
    }

    race.status = RACE_STATUS.ADOPTED;
    race.winner = variant.name;
    race.finishedAt = Date.now();
    race.mergeCommit = mergeCommit;
    await this.saveRace(race);

    try {
      await this.recordOutcome(this.buildScoreboardEntry(race, snapshot, variant.name));
    } catch (e) {
      this.log('error', `Could not write the scoreboard: ${e.message}`);
    }

    const decorated = this.decorate(race);
    this.emit('race', decorated);
    return {
      ok: true,
      conflict: false,
      race: decorated,
      branch: variant.branch,
      target: race.baseBranch,
      mergeCommit,
      removed,
    };
  }

  /** Commits whatever the agent left uncommitted in its worktree. */
  async commitWorktree(race, variant) {
    if (!(await pathExists(variant.path))) {
      return {
        ok: false,
        conflict: false,
        message: `The worktree for "${variant.name}" is gone; nothing left to adopt.`,
      };
    }

    const add = await this.gitTry(['add', '-A'], variant.path);
    if (add.code !== 0) {
      return { ok: false, conflict: false, message: gitDetail(add, 'git add failed') };
    }

    const staged = await this.gitTry(['diff', '--cached', '--quiet'], variant.path);
    if (staged.code === 0) return { ok: true, committed: false };

    const message = `orchestra: race ${shortId(race.id)} variant ${variant.name}\n\n${race.prompt}`;
    const commit = await this.gitTry(['commit', '-m', message], variant.path, {
      timeout: GIT_SLOW_TIMEOUT_MS,
    });
    if (commit.code !== 0) {
      const detail = gitDetail(commit, 'git commit failed');
      this.log('warn', `Committing variant ${variant.name} failed: ${detail}`);
      return {
        ok: false,
        conflict: false,
        message: `Could not commit the work in "${variant.name}": ${detail}`,
      };
    }
    return { ok: true, committed: true };
  }

  /**
   * Tear a race down. Never throws: it is the cleanup path, and a worktree
   * that already vanished is exactly the state we were aiming for.
   *
   * @returns {Promise<{ok:boolean, removed:string[], problems:string[]}>}
   */
  async discard(raceId) {
    const problems = [];
    let race = null;
    try {
      race = await this.readRace(raceId);
    } catch (e) {
      problems.push(`descriptor unreadable: ${e.message}`);
    }
    if (!race) {
      // Still try to drop the directory, so a corrupt descriptor is not a leak.
      try {
        await fsp.rm(this.raceDir(raceId), { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
      } catch (e) {
        problems.push(e.message);
      }
      return { ok: problems.length === 0, removed: [], problems };
    }

    let snapshot = null;
    if (race.status === RACE_STATUS.RUNNING) {
      try {
        snapshot = await this.diffs(raceId);
      } catch (e) {
        this.log('warn', `Could not measure race ${raceId} before discarding: ${e.message}`);
      }
    }

    for (const variant of race.variants) {
      if (!variant.sessionId) continue;
      try {
        this.sessions.close(variant.sessionId);
      } catch (e) {
        problems.push(`session ${variant.sessionId}: ${e.message}`);
      }
    }
    // Windows keeps a directory locked until the process that lived in it is
    // really gone, and a PTY exit is not instantaneous.
    await sleep(200);

    const removed = [];
    for (const variant of race.variants) {
      const gone = await this.removeWorktree(race.repo, variant, { deleteBranch: true });
      if (gone) removed.push(variant.name);
      else problems.push(`worktree ${variant.name} could not be removed cleanly`);
    }

    const prune = await this.gitTry(['worktree', 'prune'], race.repo);
    if (prune.code !== 0) problems.push(`worktree prune: ${gitDetail(prune)}`);

    if (snapshot) {
      try {
        await this.recordOutcome(this.buildScoreboardEntry(race, snapshot, null));
      } catch (e) {
        problems.push(`scoreboard: ${e.message}`);
      }
    }

    try {
      await fsp.rm(this.raceDir(raceId), { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    } catch (e) {
      problems.push(`race directory: ${e.message}`);
    }

    for (const problem of problems) this.log('warn', `Discarding race ${raceId}: ${problem}`);
    this.emit('race', { ...race, status: RACE_STATUS.DISCARDED });
    return { ok: problems.length === 0, removed, problems };
  }

  /**
   * Remove one worktree and, optionally, its branch. Returns whether the
   * directory is actually gone; failures are logged, never thrown.
   */
  async removeWorktree(repoPath, variant, { deleteBranch = false } = {}) {
    if (await pathExists(variant.path)) {
      const res = await this.gitTry(['worktree', 'remove', '--force', variant.path], repoPath);
      if (res.code !== 0) {
        this.log('warn', `git worktree remove ${variant.path}: ${gitDetail(res)}`);
        try {
          await fsp.rm(variant.path, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
        } catch (e) {
          this.log('error', `Could not delete ${variant.path}: ${e.message}`);
        }
        await this.gitTry(['worktree', 'prune'], repoPath);
      }
    }

    if (deleteBranch && variant.branch) {
      const del = await this.gitTry(['branch', '-D', variant.branch], repoPath);
      if (del.code !== 0 && !/not found/i.test(gitDetail(del))) {
        this.log('warn', `git branch -D ${variant.branch}: ${gitDetail(del)}`);
      }
    }

    return !(await pathExists(variant.path));
  }

  buildScoreboardEntry(race, snapshot, winner) {
    const summary = snapshot && snapshot.summary ? snapshot.summary : {};
    return {
      raceId: race.id,
      prompt: race.prompt,
      repo: race.repo,
      ts: Date.now(),
      winner,
      variants: race.variants.map(v => {
        const s = summary[v.name] || {};
        return {
          name: v.name,
          args: v.args,
          cost: numberOr(s.cost, null),
          durationMs: numberOr(s.durationMs, null),
          files: numberOr(s.files, 0),
          additions: numberOr(s.additions, 0),
          deletions: numberOr(s.deletions, 0),
        };
      }),
    };
  }

  /** Newest first. Returns [] rather than throwing on a corrupt file. */
  scoreboard() {
    let text;
    try {
      text = fs.readFileSync(this.config.scoreboardFile, 'utf-8');
    } catch (e) {
      if (e.code !== 'ENOENT') {
        this.log('error', `Could not read the scoreboard: ${e.message}`);
      }
      return [];
    }
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch (e) {
      this.log('error', `Scoreboard is corrupt (${e.message}); the previous copy is at `
        + `${this.config.scoreboardFile}.bak`);
      return [];
    }
    const entries = Array.isArray(parsed) ? parsed : parsed && parsed.entries;
    if (!Array.isArray(entries)) return [];
    return entries.slice().sort((a, b) => (b.ts || 0) - (a.ts || 0));
  }

  async recordOutcome(entry) {
    const entries = this.scoreboard();
    entries.unshift(entry);
    await writeJsonAtomic(this.config.scoreboardFile, entries.slice(0, MAX_SCOREBOARD_ENTRIES), {
      backup: true,
    });
    return entry;
  }
}

module.exports = { RaceManager };
