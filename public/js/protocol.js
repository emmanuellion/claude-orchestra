/**
 * Wire contract, browser side.
 *
 * MUST stay byte-for-byte in sync with lib/protocol.js. That file is the
 * authority; this one exists only because the browser needs ES module exports
 * and we refuse to add a build step. When you touch lib/protocol.js, touch this
 * file in the same commit or the two sides drift silently.
 */

export const PROTOCOL_VERSION = 2;

/** Messages the browser sends to the server. */
export const C2S = {
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
export const S2C = {
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
  QUOTA: 'quota',
  RACE: 'race',
  ERROR: 'error',
  PONG: 'pong',
};

/** Session lifecycle. */
export const STATUS = {
  STARTING: 'starting',
  IDLE: 'idle',
  BUSY: 'busy',
  AWAITING_INPUT: 'awaiting-input',
  AWAITING_PERMISSION: 'awaiting-permission',
  EXITED: 'exited',
};

/** Terminal kinds the server knows how to spawn. */
export const KIND = {
  CLAUDE: 'claude',
  SHELL: 'shell',
  POWERSHELL: 'powershell',
};

/** Claude Code hook events Orchestra subscribes to. */
export const HOOK_EVENT = {
  SESSION_START: 'SessionStart',
  USER_PROMPT_SUBMIT: 'UserPromptSubmit',
  PRE_TOOL_USE: 'PreToolUse',
  POST_TOOL_USE: 'PostToolUse',
  NOTIFICATION: 'Notification',
  STOP: 'Stop',
  SUBAGENT_STOP: 'SubagentStop',
  SESSION_END: 'SessionEnd',
};

/** Decisions a human can return for a blocked PreToolUse request. */
export const APPROVAL = {
  ALLOW: 'allow',
  DENY: 'deny',
};

/** How long an approval decision applies. */
export const APPROVAL_SCOPE = {
  ONCE: 'once',
  SESSION: 'session',
  ALWAYS: 'always',
};

export const ERROR_CODE = {
  UNAUTHORIZED: 'unauthorized',
  BAD_REQUEST: 'bad_request',
  NOT_FOUND: 'not_found',
  LIMIT_REACHED: 'limit_reached',
  SPAWN_FAILED: 'spawn_failed',
  INTERNAL: 'internal',
  RATE_LIMITED: 'rate_limited',
};

export const LIMITS = {
  MAX_SESSIONS: 24,
  SCROLLBACK_BYTES: 2 * 1024 * 1024,
  FLUSH_BYTES: 64 * 1024,
  MSG_PER_SEC: 400,
  MAX_FRAME_BYTES: 1024 * 1024,
  BACKPRESSURE_HIGH: 4 * 1024 * 1024,
  BACKPRESSURE_LOW: 1 * 1024 * 1024,
  HEARTBEAT_MS: 30000,
};

/** Statuses that mean the agent is waiting on a human. */
export const BLOCKED_STATUSES = [STATUS.AWAITING_INPUT, STATUS.AWAITING_PERMISSION];

/** Human labels for STATUS values, for badges and tooltips. */
export const STATUS_LABEL = {
  [STATUS.STARTING]: 'Starting',
  [STATUS.IDLE]: 'Idle',
  [STATUS.BUSY]: 'Working',
  [STATUS.AWAITING_INPUT]: 'Needs input',
  [STATUS.AWAITING_PERMISSION]: 'Needs approval',
  [STATUS.EXITED]: 'Exited',
};
