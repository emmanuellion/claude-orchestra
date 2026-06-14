'use strict';

/**
 * Shared wire contract between server and browser. `public/js/protocol.js`
 * re-exports the same table as an ES module, so both sides import these names
 * instead of typing message strings by hand and cannot drift apart.
 */

const PROTOCOL_VERSION = 2;

/** Messages the browser sends to the server. */
const C2S = {
  HELLO: 'hello',
  LIST: 'list',
  CREATE: 'create',
  ATTACH: 'attach',
  DETACH: 'detach',
  INPUT: 'input',
  RESIZE: 'resize',
  KILL: 'kill',
  RENAME: 'rename',
  SET_META: 'set-meta',
  SEND_TO: 'send-to',
  APPROVAL_DECISION: 'approval-decision',
  PING: 'ping',
};

/** Messages the server sends to the browser. */
const S2C = {
  READY: 'ready',
  CREATED: 'created',
  SNAPSHOT: 'snapshot',
  OUTPUT: 'output',
  SESSION: 'session',
  EXIT: 'exit',
  CLOSED: 'closed',
  AGENT_EVENT: 'agent-event',
  APPROVAL_REQUEST: 'approval-request',
  APPROVAL_RESOLVED: 'approval-resolved',
  /** The whole rule list after any rule change, not one request resolution. */
  APPROVAL_RULES: 'approval-rules',
  QUOTA: 'quota',
  RACE: 'race',
  ERROR: 'error',
  PONG: 'pong',
};

/**
 * `starting` -> `idle` <-> `busy`, with `awaiting-*` as interrupt states pushed
 * by hooks and `exited` as the terminal state. `detached` is orthogonal and
 * lives on `session.attached === 0`.
 */
const STATUS = {
  STARTING: 'starting',
  IDLE: 'idle',
  BUSY: 'busy',
  AWAITING_INPUT: 'awaiting-input',
  AWAITING_PERMISSION: 'awaiting-permission',
  EXITED: 'exited',
};

const KIND = {
  CLAUDE: 'claude',
  SHELL: 'shell',
  POWERSHELL: 'powershell',
};

/** The subset of Claude Code hook events Orchestra subscribes to. */
const HOOK_EVENT = {
  SESSION_START: 'SessionStart',
  USER_PROMPT_SUBMIT: 'UserPromptSubmit',
  PRE_TOOL_USE: 'PreToolUse',
  POST_TOOL_USE: 'PostToolUse',
  NOTIFICATION: 'Notification',
  STOP: 'Stop',
  SUBAGENT_STOP: 'SubagentStop',
  SESSION_END: 'SessionEnd',
};

const APPROVAL = {
  ALLOW: 'allow',
  DENY: 'deny',
};

/** How long an approval decision applies. */
const APPROVAL_SCOPE = {
  ONCE: 'once',
  SESSION: 'session',
  ALWAYS: 'always',
};

const ERROR_CODE = {
  UNAUTHORIZED: 'unauthorized',
  BAD_REQUEST: 'bad_request',
  NOT_FOUND: 'not_found',
  LIMIT_REACHED: 'limit_reached',
  SPAWN_FAILED: 'spawn_failed',
  INTERNAL: 'internal',
  RATE_LIMITED: 'rate_limited',
};

/**
 * Injected into every PTY Orchestra spawns. The hooks read them back to
 * correlate an event with the exact panel that produced it, which is what
 * makes two agents in the same repo distinguishable.
 */
const ENV = {
  SESSION_ID: 'ORCHESTRA_SESSION_ID',
  URL: 'ORCHESTRA_URL',
  TOKEN: 'ORCHESTRA_TOKEN',
  RACE_ID: 'ORCHESTRA_RACE_ID',
  RACE_VARIANT: 'ORCHESTRA_RACE_VARIANT',
};

const LIMITS = {
  MAX_SESSIONS: 24,
  /** Bytes of scrollback retained per session for replay on attach. */
  SCROLLBACK_BYTES: 2 * 1024 * 1024,
  /** Flush threshold for the output coalescer. */
  FLUSH_BYTES: 64 * 1024,
  /** Client messages accepted per second per socket. */
  MSG_PER_SEC: 400,
  /** Bytes of a single inbound WS frame we are willing to parse. */
  MAX_FRAME_BYTES: 1024 * 1024,
  /** Pause reading the PTY above this much unflushed socket backlog. */
  BACKPRESSURE_HIGH: 4 * 1024 * 1024,
  BACKPRESSURE_LOW: 1 * 1024 * 1024,
  HEARTBEAT_MS: 30000,
};

/**
 * @typedef {Object} AgentState
 * @property {string|null} model            Model reported by the last hook.
 * @property {string|null} tool             Tool currently running, if any.
 * @property {string|null} toolDetail       Short human summary of that tool call.
 * @property {number|null} toolStartedAt    Epoch ms the current tool started.
 * @property {number|null} lastEventAt      Epoch ms of the last hook event.
 * @property {number} turns                 Assistant turns observed.
 * @property {number} cost                  Cumulative USD reported by hooks.
 * @property {{input:number,output:number}} tokens
 * @property {string|null} claudeSessionId  Claude Code's own session id.
 * @property {string|null} gitBranch
 * @property {string|null} lastQuestion     Text of the last Notification event.
 */

/**
 * @typedef {Object} Session
 * @property {string} id
 * @property {string} name
 * @property {string} kind
 * @property {string} cwd
 * @property {string} args
 * @property {number} cols
 * @property {number} rows
 * @property {string} status
 * @property {number} createdAt
 * @property {number|null} exitedAt
 * @property {number|null} exitCode
 * @property {number} attached      Number of live browser sockets.
 * @property {number|null} detachedAt
 * @property {number} seq           Monotonic output sequence number.
 * @property {string} tagColor
 * @property {boolean} locked
 * @property {AgentState} agent
 * @property {{raceId:string,variant:string}|null} race
 */

module.exports = {
  PROTOCOL_VERSION,
  C2S,
  S2C,
  STATUS,
  KIND,
  HOOK_EVENT,
  APPROVAL,
  APPROVAL_SCOPE,
  ERROR_CODE,
  ENV,
  LIMITS,
};
