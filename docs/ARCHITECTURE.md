# Architecture

Reference for contributors. It documents the WebSocket protocol message by message, the session state
machine, the hook event format, and what each module is responsible for. `README.md` covers what the
product does; this file covers how.

The single source of truth for names and constants is `lib/protocol.js`. It is re-exported verbatim by
`public/js/protocol.js`, so the two sides of the wire cannot drift. Do not type a message name by hand
anywhere else.

---

## 1. Layout

```
server.js          assembly. Express routes, WebSocket transport, the two security guards.
                   No business logic: everything it does is delegate to lib/.
bin/cli.js         argv parsing (pure, tested), health probe, browser open. Talks to server.js
                   through start(options) -> {url, port, host, token, close}.
lib/               the whole product. Every module is constructible with injected
                   {config, logger} so it can be tested without a server.
hooks/             standalone scripts run by Claude Code. They require nothing from lib/.
public/js/         ES modules, no build step, served as written.
test/              node:test. 88 tests.
```

Two rules the layout enforces:

- **`lib/` never imports from `server.js`.** Dependencies point inward.
- **`hooks/` never imports from `lib/`.** Hooks are installed globally and run in terminals Orchestra
  never spawned, possibly after the repository has moved. They read their configuration from the
  environment only, which is why env var names appear as string literals in `hooks/orchestra-hook.js`
  rather than coming from `lib/protocol.js`.

---

## 2. Transport and authentication

### HTTP

| Route | Auth | Notes |
|---|---|---|
| `GET /` , `/index.html` | none | Serves the page, injects a CSP nonce and the bootstrap payload including the token |
| `GET /api/health` | none | Product, version, `serverId`, uptime, session count. Deliberately open: it is how a second `npx` invocation detects a running instance instead of dying on `EADDRINUSE` |
| `/vendor/*`, other static | none | xterm and the client modules |
| Everything else under `/api` | token | `security.requireToken` |

The token is accepted as `Authorization: Bearer <t>`, `X-Orchestra-Token: <t>`, `?token=`, or a `token`
field in a JSON body. Comparison is constant-time (`security.tokenMatches`) and burns a comparison on
length mismatch so timing does not advertise the length.

Two further guards apply to every request:

- `security.checkHost` answers only for hostnames we expect (`localhost`, `127.0.0.1`, `::1`, the bound
  host, anything in `ORCHESTRA_ORIGINS`). This blocks DNS rebinding, where an attacker-controlled name
  resolving to loopback would otherwise yield a same-origin `Host` header.
- `security.securityHeaders(nonce)` sets a CSP with `default-src 'self'`, `script-src 'self'
  'nonce-...'`, `frame-ancestors 'none'`, `base-uri 'none'`, `form-action 'none'`.

### WebSocket upgrade

`security.checkUpgrade(req)` runs before `wss.handleUpgrade`. It requires:

1. **An allowed `Origin`, or none at all.** WebSockets are exempt from the same-origin policy: any page
   the user visits can open `ws://localhost:3000`. This check is what makes that a rejected upgrade
   rather than a shell. A missing `Origin` means a non-browser client and is allowed, because such a
   client still has to present the token, and a cross-origin page cannot read the token.
2. **A valid token**, from the query string or a header.

Failure writes a bare `HTTP/1.1 401|403` and destroys the socket.

The allowed-origin set is built from the port the server actually bound, which is why `config.setRuntime`
records the runtime port and host: a server started with `--port 3100` must accept its own page.

### Transport limits

From `LIMITS` in `lib/protocol.js`:

| Constant | Value | Meaning |
|---|---|---|
| `MAX_SESSIONS` | 24 | Hard ceiling on concurrent sessions |
| `SCROLLBACK_BYTES` | 2 MB | Retained per session for replay on attach |
| `FLUSH_BYTES` | 64 KB | Output coalescer flush threshold |
| `MSG_PER_SEC` | 400 | Client messages accepted per second per socket; excess is dropped silently |
| `MAX_FRAME_BYTES` | 1 MB | `ws` `maxPayload` |
| `BACKPRESSURE_HIGH` / `LOW` | 4 MB / 1 MB | PTY reads pause above high, resume below low |
| `HEARTBEAT_MS` | 30000 | Ping; a socket that misses a pong is terminated |

---

## 3. WebSocket protocol

`PROTOCOL_VERSION = 2`. Every frame is JSON with a `t` field naming the message type.

A malformed frame gets an `error` reply and is otherwise ignored. A handler that throws is caught, logged
and answered with an `error` carrying the thrown `code`; it never takes the process down. That guard is
load-bearing: in the v1, one bad message killed the process and every agent under it.

### 3.1 Client to server (`C2S`)

#### `hello`
Reserved. Declared in the table, not currently sent by the client or handled by the server.

#### `list`
```json
{ "t": "list" }
```
Replies with a `ready` carrying `sessions` and `approvals`.

#### `create`
```json
{ "t": "create", "spec": {
  "kind": "claude|shell|powershell",
  "name": "API",
  "cwd": "/abs/or/~/path",
  "args": "--model opus",
  "prompt": "text typed into the REPL once it is up",
  "cols": 120, "rows": 30,
  "tagColor": "blue",
  "env": { "...": "..." },
  "race": { "raceId": "...", "variant": "..." }
} }
```
Every field is optional. `kind` falls back to `shell` if unrecognised. `cwd` accepts `~`, is resolved,
and falls back to `$HOME` if it is not an existing directory. `args` is capped at 2000 characters and
`name` at 120. The socket is attached to the new session immediately.

Replies `created`, then a `snapshot` if there is already output.

Errors: `limit_reached` (24 sessions), `spawn_failed` (node-pty missing or the binary would not start).

#### `attach`
```json
{ "t": "attach", "id": "<session id>", "sinceSeq": 918273 }
```
`sinceSeq` is a **byte** offset into the session's total output, not a chunk index (see `RingBuffer`).
The server replies with a `snapshot` containing only what came after it, or the whole retained buffer
with `truncated: true` when the requested offset has already fallen off the front.

Errors: `not_found`.

#### `detach`
```json
{ "t": "detach", "id": "<session id>" }
```
Removes this socket from the session's client set. The process keeps running.

#### `input`
```json
{ "t": "input", "id": "<session id>", "data": "ls -la\r" }
```
Written straight to the PTY. Ignored when the session is `locked` or has no PTY. No reply; the echo comes
back as `output`.

#### `resize`
```json
{ "t": "resize", "id": "<session id>", "cols": 120, "rows": 30 }
```
Clamped to 20..500 columns and 5..200 rows.

#### `kill`
```json
{ "t": "kill", "id": "<session id>", "remove": false }
```
`remove: false` terminates the process but keeps the record and its scrollback readable (emits `exit`).
`remove: true` destroys the record entirely (emits `closed`).

#### `rename`
```json
{ "t": "rename", "id": "<session id>", "name": "API" }
```

#### `set-meta`
```json
{ "t": "set-meta", "id": "<session id>", "patch": { "tagColor": "blue", "locked": true } }
```
Only `tagColor` (string) and `locked` (boolean) are honoured.

#### `send-to`
```json
{ "t": "send-to", "ids": ["id1", "id2"], "data": "npm test\r" }
```
The explicit replacement for the v1 broadcast. The client names its targets; the server never infers
"all sessions". The v1 wrote every keystroke into every session, so one Ctrl+C stopped all of them and a
Claude prompt landed inside plain shells.

#### `approval-decision`
```json
{ "t": "approval-decision", "requestId": "<uuid>", "decision": "allow|deny",
  "scope": "once|session|always", "pattern": "optional glob" }
```
Same effect as `POST /api/approvals/:id/decide`.

#### `ping`
```json
{ "t": "ping", "ts": 1730000000000 }
```
Replies `pong`. Application-level, distinct from the protocol-level ping used for the heartbeat.

### 3.2 Server to client (`S2C`)

#### `ready`
Sent immediately on connect, and again in reply to `list`.
```json
{ "t": "ready", "serverId": "<uuid>", "version": "2.0.0", "platform": "win32",
  "sessions": [ /* wire sessions */ ],
  "approvals": [ /* pending approval requests */ ],
  "features": { "pty": true, "ptyError": null } }
```
`serverId` changes on every server boot. A client that sees a new one knows its cached session ids are
worthless and must resubscribe from scratch. `features.pty` is false when `node-pty` failed to load, with
the reason in `ptyError`; the UI must degrade rather than offer a create button that cannot work.

#### `created`
```json
{ "t": "created", "session": { /* wire session */ } }
```

#### `snapshot`
```json
{ "t": "snapshot", "id": "<session id>", "seq": 918273, "data": "...", "truncated": false }
```
Scrollback replay. `seq` is the byte offset after `data`; the client stores it and sends it back as
`sinceSeq` on the next attach. `truncated: true` means output was lost off the front of the ring buffer.

#### `output`
```json
{ "t": "output", "id": "<session id>", "seq": 918512, "data": "..." }
```
Coalesced PTY output. `seq` is monotonic per session and counts bytes.

#### `session`
```json
{ "t": "session", "session": { /* wire session */ } }
```
Broadcast on any state change: status, name, tag, lock, attach count, agent state. This is the only
message that carries session state; there is no partial patch.

#### `exit`
```json
{ "t": "exit", "id": "<session id>", "code": 0 }
```
The process ended. The record survives and its scrollback stays readable.

#### `closed`
```json
{ "t": "closed", "id": "<session id>" }
```
The record is gone (explicit remove, or a detach TTL sweep).

#### `agent-event`
```json
{ "t": "agent-event", "event": { /* see section 5 */ } }
```
One normalized hook event. Also carries synthesized `Stalled` events (section 5.4).

#### `approval-request`
```json
{ "t": "approval-request", "request": {
  "id": "<uuid>", "sessionId": "...", "sessionName": "API",
  "tool": "Bash", "cwd": "/repo",
  "summary": "rm -rf build/",
  "detail": "full command, or a diff extract, or the serialized input",
  "patternSuggestion": "rm -rf build/",
  "createdAt": 1730000000000, "expiresAt": 1730000300000
} }
```
`summary` is what a person reads on a phone; `detail` is everything else. `patternSuggestion` pre-fills
the "always" pattern field.

#### `approval-resolved`
```json
{ "t": "approval-resolved", "id": "<uuid>", "sessionId": "...", "tool": "Bash",
  "summary": "...", "decision": "allow|deny", "scope": "once|session|always",
  "reason": "...", "source": "human|rule|timeout", "ruleId": null,
  "resolvedAt": 1730000012345 }
```
Sent for every resolution, including those a stored rule decided without ever reaching a human. The same
message type is also used with only a `rules` array to broadcast a changed rule set, so a tab does not
keep showing a rule that was just revoked.

#### `quota`
Declared in `S2C`. Not currently emitted by the server: the Usage panel polls `GET /api/usage`.

#### `race`
```json
{ "t": "race", "race": { /* decorated race descriptor */ } }
```
Declared and emitted by `RaceManager`; the fanout to sockets is wired where the race view needs it.

#### `error`
```json
{ "t": "error", "id": "<session id, when the failure had one>",
  "code": "unauthorized|bad_request|not_found|limit_reached|spawn_failed|internal|rate_limited",
  "message": "human readable" }
```

#### `pong`
```json
{ "t": "pong", "ts": 1730000000000 }
```

### 3.3 The wire session object

Produced by `SessionManager.toWire`. This is the complete shape; nothing else about a session crosses the
wire.

```json
{
  "id": "<uuid>",
  "name": "API",
  "kind": "claude",
  "cwd": "/repo/services/api",
  "args": "--model opus",
  "cols": 120, "rows": 30,
  "status": "busy",
  "createdAt": 1730000000000,
  "exitedAt": null,
  "exitCode": null,
  "attached": 1,
  "detachedAt": null,
  "seq": 918512,
  "tagColor": "blue",
  "locked": false,
  "lastActivityAt": 1730000009000,
  "race": { "raceId": "...", "variant": "variant-a" },
  "agent": {
    "model": "claude-opus-4",
    "tool": "Edit",
    "toolDetail": "src/db.js",
    "toolStartedAt": 1730000008000,
    "lastEventAt": 1730000009000,
    "turns": 3,
    "cost": 0.42,
    "tokens": { "input": 120400, "output": 8300 },
    "claudeSessionId": "<claude's own id>",
    "gitBranch": "main",
    "lastQuestion": null,
    "lastPrompt": "Read services/api/README.md, then..."
  }
}
```

`attached` is the number of live browser sockets. `attached === 0` with a non-null `detachedAt` is the
detached state; it is orthogonal to `status`, which is why it is not one of the status values.

`HookBus` also writes `lastTool`, `lastToolMs`, `lastToolError` and `subagents` into `agent`. They are
present at runtime but are not in `makeAgentState()` nor in the `AgentState` typedef.

---

## 4. Session lifecycle

### 4.1 States

```
                         create()
                            |
                            v
                     +-------------+
                     |  starting   |   PTY spawned, nothing heard from the agent yet
                     +------+------+
                            | SessionStart hook
                            v
   Notification  +------> idle <------+  Stop hook
   hook          |          |         |
                 |          | UserPromptSubmit hook
                 |          v         |
        +--------+-----+  busy -------+
        | awaiting-    |   ^  |
        | input        |   |  | PreToolUse blocked by the approval gate
        +--------------+   |  v
                           | +--------------------+
        approval decided --+ | awaiting-permission|
                             +--------------------+

   any state --(process exits, or kill)--> exited   [terminal]
```

| Status | Set by | Meaning |
|---|---|---|
| `starting` | `SessionManager.spawn` | The PTY exists. Nothing has been heard from the agent |
| `idle` | `SessionStart`, `Stop` | Waiting for you |
| `busy` | `UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `SubagentStop`, and an approval resolution | Working |
| `awaiting-input` | `Notification` | Claude is asking a question |
| `awaiting-permission` | `ApprovalQueue.request` | A tool call is blocked on a human |
| `exited` | process exit, `kill` | Terminal. `setStatus` refuses to move a session out of it |

Two precedence rules matter:

- `Notification` fires for the same pause that produced a blocked `PreToolUse`. When the session is
  already `awaiting-permission`, the notification only patches the agent state and does not downgrade the
  status to the vaguer `awaiting-input`. The approvals module owns that state.
- When an approval resolves, `markSession` moves the session back to `busy` **only** if it is still
  `awaiting-permission`. If something else already moved it on, the patch is applied without dragging the
  status backwards.

`SessionEnd` deliberately does not set `exited`: the PTY can outlive Claude's own session (`--continue`,
a rerun in the same shell). Only the process actually ending does that.

**Sessions with no hooks installed.** A `claude` session whose hooks are not installed stays `starting`
forever, because nothing ever reports on it. Shell and PowerShell sessions instead use
`markActivity()`: any PTY output sets `busy`, and 800 ms of quiet returns to `idle`. That timer heuristic
is applied to non-Claude kinds only. Guessing agent state from the byte stream is exactly what the v2
removed.

### 4.2 Attach, detach, and lifetime

A session's lifetime is independent of any browser.

- **Attach** (`attach(id, ws, sinceSeq)`) adds the socket to `session.clients` with its own cursor,
  clears `detachedAt`, and returns the scrollback tail after `sinceSeq`. Several sockets can watch one
  session, each with its own cursor.
- **Detach** (`detach`, or `detachAll(ws)` on socket close) removes the socket. When the last one goes,
  `detachedAt` is stamped. **The process is not touched.** In the v1 this path killed the PTY, which is
  why refreshing the page destroyed the work.
- **Kill** ends the process, keeps the record and its scrollback (`exit`).
- **Close** destroys the record (`closed`).
- **Sweep**: a periodic pass closes sessions that have been detached longer than their TTL.
  `ORCHESTRA_DETACH_TTL` governs `claude` sessions and defaults to `0`, meaning never.
  `ORCHESTRA_SHELL_DETACH_TTL` governs shells and defaults to 24 hours. A TTL of `0` disables the sweep
  for that kind.

### 4.3 Output path

PTY bytes are decoded through a `StringDecoder` (so a multi-byte character split across two reads is not
corrupted), appended to the session's `RingBuffer`, and coalesced before being sent. Each attached socket
carries its own `seq` cursor, so a slow client falls behind without holding anyone else up. Above
`BACKPRESSURE_HIGH` of unflushed socket backlog, PTY reads are paused until the backlog drains below
`BACKPRESSURE_LOW`.

`RingBuffer` sequence numbers count **characters ever written**, not chunks. That makes `since(n)` simple
arithmetic and keeps it correct across re-chunking. `dropped` records what fell off the front, which is
what produces `truncated: true` on a snapshot.

### 4.4 Spawning

`claude` is launched as its own process with its arguments as argv entries, not typed into a shell. This
removes the timing race the v1 depended on, and means user-supplied `args` are never re-interpreted by a
shell. `lib/which.js` resolves the binary against `PATH` the way a shell would (including `PATHEXT` and
`.cmd` shims on Windows) so we spawn a real path rather than a name and a hope.

Every PTY gets these injected:

| Variable | Value |
|---|---|
| `ORCHESTRA_SESSION_ID` | The session id, the exact identity hooks report back |
| `ORCHESTRA_URL` | `config.baseUrl`, where hooks POST |
| `ORCHESTRA_TOKEN` | The session token |
| `ORCHESTRA_RACE_ID` | Race sessions only |
| `ORCHESTRA_RACE_VARIANT` | Race sessions only |

Claude Code's own `CLAUDE*` shell markers are stripped from the inherited environment, so a session
Orchestra spawns is not mistaken for a shell Claude Code spawned.

An initial `prompt` is typed only once the REPL is actually up, detected by Claude's prompt glyph rather
than by a timer, so a slow machine does not swallow half of it.

---

## 5. Hook events

### 5.1 Ingress

`hooks/orchestra-hook.js` is installed as a `command` hook for each subscribed event. It reads Claude
Code's payload on stdin, adds the Orchestra identity fields, and POSTs to
`POST /api/hooks/event/<EventName>` with `Authorization: Bearer <token>`.

Three invariants govern that script:

1. **It never fails a tool call.** Every path exits 0. A 1500 ms request timeout sits inside a 2500 ms
   hard deadline that also covers a stdin which never reaches EOF.
2. **It never writes to stdout.** Claude Code parses a hook's stdout as control output; a stray line
   there can block or rewrite a tool call. Diagnostics go to stderr through `fs.writeSync` so they
   survive `process.exit`.
3. **It is standalone.** No `require` outside Node builtins. Without `ORCHESTRA_URL` and
   `ORCHESTRA_TOKEN` in the environment it returns silently, which is the normal case in a plain shell.

stdin is capped at 1 MB; over the cap the head is kept and `orchestraTruncated: true` is set, because
knowing an event happened is worth more than its arguments. An unparseable payload still produces an
event, tagged `orchestraParseError`. Event names must match `/^[A-Za-z][A-Za-z0-9_]{0,63}$/`, on both
sides, because the name reaches a URL path.

### 5.2 Fields the hook adds

```json
{
  "...": "everything Claude Code sent",
  "hook_event_name": "PreToolUse",
  "orchestraEvent": "PreToolUse",
  "orchestraTs": 1730000000000,
  "orchestraSessionId": "<ORCHESTRA_SESSION_ID or null>",
  "orchestraRaceId": null,
  "orchestraRaceVariant": null,
  "orchestraTruncated": true,
  "orchestraParseError": "..."
}
```

### 5.3 Session resolution

`HookBus._resolve` attributes an event to a session, in order:

1. `orchestraSessionId`. Exact, since it is the PTY's own environment. An unknown value yields
   `unmatched: unknown-session-id`.
2. Claude's `session_id`, if exactly one live session has already recorded it.
3. A unique `cwd` match among live sessions.

When two live sessions share a cwd, resolution **gives up** (`ambiguous-cwd`). Showing the wrong agent's
activity is worse than showing none. This is the case that makes two agents in one repository work
correctly, and it is why the session id env var exists.

### 5.4 The normalized event

Persisted one per line to `~/.claude/orchestra/events/YYYY-MM-DD.jsonl` and broadcast as `agent-event`.

```json
{
  "ts": 1730000000000,
  "seq": 4211,
  "event": "PostToolUse",
  "sessionId": "<uuid or null>",
  "matched": true,
  "claudeSessionId": "...",
  "cwd": "/repo",
  "raceId": null,
  "variant": null,
  "tool": "Edit",
  "detail": "src/db.js",
  "status": "busy",
  "message": null,
  "durationMs": 1840,
  "ok": true,
  "unmatchedReason": "ambiguous-cwd",
  "parseError": "...",
  "truncated": true
}
```

`ts` prefers the hook's own `orchestraTs`, since it comes from the same machine and is more accurate than
arrival time, but a value more than 5 minutes from now is discarded rather than trusted: a skewed clock
would corrupt timeline ordering permanently. `status` is the session's status **after** the event was
applied. The last three fields appear only when relevant.

Per event:

| Event | Status after | Populates |
|---|---|---|
| `SessionStart` | `idle` | Clears the current tool, refreshes the git branch |
| `UserPromptSubmit` | `busy` | `message`/`detail` = prompt (200 chars), `agent.turns += 1`, `agent.lastPrompt` |
| `PreToolUse` | `busy` | `tool`, `detail` = summarized input, `agent.toolStartedAt` |
| `PostToolUse` | `busy` | `tool`, `detail`, `durationMs` (from `toolStartedAt`), `ok`, `agent.lastTool*` |
| `Notification` | `awaiting-input`, unless already `awaiting-permission` | `message`/`detail`, `agent.lastQuestion` |
| `Stop` | `idle` | Clears tool and question. The honest "turn finished" signal |
| `SubagentStop` | `busy` | `agent.subagents += 1` |
| `SessionEnd` | unchanged | `detail` = reason |
| anything else | unchanged | Recorded, not acted on (`PreCompact`, future events) |

Cost and token totals are harvested from whatever shape the payload carries (`total_cost_usd`,
`cost.total_cost_usd`, a bare numeric `cost`) on **every** event, and only ever move upward.

**Stalled.** A sweep every 15 s emits a synthetic event with `event: "Stalled"` for a `busy` session whose
current tool has been running over 120 s, or an `awaiting-input` session unanswered for over 60 s. It is
emitted once per distinct condition, not repeatedly, and cleared by the next real event.

**Log rotation.** The day's JSONL file is rotated aside at 20 MB (`YYYY-MM-DD.1.jsonl`). `timeline()`
reads the tail of each file, newest file first, capped at 2 MB and 5000 lines per file, and returns
events oldest-first. Malformed lines are counted and skipped, never fatal.

---

## 6. The approval path

```
 agent            orchestra-approve.js        server                   browser
   |                     |                      |                         |
   |-- PreToolUse ------>|                      |                         |
   |   (blocked)         |-- POST /api/approvals|                         |
   |                     |   (held open)  ----->|                         |
   |                     |                      |-- approval-request ---->|
   |                     |                      |                         | human taps
   |                     |                      |<-- approval-decision ---|
   |                     |<--- 200 {decision} --|                         |
   |<-- stdout verdict --|                      |-- approval-resolved --->|
   |   resumes           |                      |                         |
```

The route calls `req.setTimeout(0)` and `res.setTimeout(0)`: Node would otherwise time the socket out
long before a human on a phone gets to it.

`ApprovalQueue.request()` returns a promise that settles from exactly one of four sources:

1. **A stored rule**, evaluated before anything is queued. Resolves immediately with `source: "rule"`.
2. **A human**, via `decide()` from either the WebSocket or `POST /api/approvals/:id/decide`.
   `source: "human"`.
3. **The timeout** (`ORCHESTRA_APPROVAL_TIMEOUT`, 300 s). `deny`, `source: "timeout"`.
4. **Queue full** (50 pending), **session gone**, or **server shutting down**. `deny`.

The hook maps the answer to Claude Code's `permissionDecision`, and maps every failure of its own to
`ask`. The asymmetry is deliberate and documented at the top of `hooks/orchestra-approve.js`: a broken
control plane must never grant a permission, and must never make `claude` in a plain terminal behave
differently from `claude` without the hook.

### Rule matching

A rule is `{id, tool, pattern, exact, cwd, decision, createdAt, hits}`.

- `tool` must equal the tool name, or be `*`.
- `cwd`, when set, restricts the rule to that directory and everything under it (case-insensitive on
  Windows).
- `pattern` is matched against `matchText`, which `describeToolCall` derives per tool: the command for
  `Bash`, the file path for `Edit`/`Write`/`MultiEdit`, the URL for `WebFetch`, the query for
  `WebSearch`, the subagent type for `Task`, the serialized input otherwise.
- `exact: true` (the default for a rule captured from a decision) compares literally. `exact: false`
  compiles the pattern as a **wildcard-only** glob where only `*` is special. User regexes are never
  accepted.

**Denies are evaluated before allows**, over session rules then persisted rules, so a broad allow cannot
shadow a narrow deny.

Two decisions in that design are worth preserving:

- A rule captured from a decision is literal because the glob language has no escape for `*`: treating an
  observed `rm *.log` as a wildcard would authorize `rm -rf /`.
- Regexes are refused because a mistyped one silently matches more than its author meant, and for an
  allow rule that is a permission nobody granted.

Persisted rules live in `~/.claude/orchestra/approval-rules.json` (max 500), written temp-file-then-rename
with a `.bak` taken **before** the rename. A file that fails to parse is moved to `.corrupt-<ts>` and the
rule set starts empty; it is never silently rewritten. Every decision, whatever its source, is appended to
`~/.claude/orchestra/audit.log`.

---

## 7. Race mode

```
create()   git rev-parse HEAD
           for each variant:
             git worktree add -b orchestra/race-<sid>-<name> <dir>/<name> <baseCommit>
             sessions.create({kind: claude, cwd: worktree, prompt, race: {...}})
           any failure -> rollback(): kill sessions, remove worktrees, remove dir
           persist descriptor to ~/.claude/orchestra/races/<raceId>/race.json

diffs()    per variant: git diff --numstat <base>..worktree, plus the patch

adopt()    commit whatever the winner left uncommitted in its worktree
           git merge --no-ff <winner branch>   into the branch the race started from
           conflict -> STOP, leave the repository exactly as git left it
           success  -> record the scoreboard entry, mark the race adopted

discard()  git worktree remove --force, git worktree prune, delete the race dir
```

Invariants:

- **Every git call is `execFile` with an argv**, never a shell string. Variant names, branches and paths
  all originate in user input; the argument vector is the only thing between a variant label and a
  command. Names are additionally sanitized to be safe as both a path segment and a git ref component
  before any concatenation.
- **Worktrees start from the commit**, not the working tree. A dirty base is reported, not silently
  carried in.
- **A conflicting merge is never aborted.** `git merge --abort` would throw away the work the race was run
  to produce. Orchestra leaves the conflict markers, says so, and keeps the worktrees.
- **Descriptors live on disk**, so a server restart does not lose the worktrees it created. Live session
  state is layered back on top when it still exists.
- **Adopt is refused, not guessed**, when the base branch is no longer checked out or the race began on a
  detached HEAD.
- Max 8 variants; the scoreboard keeps the last 500 entries.

---

## 8. Module contracts

Every module takes `{config, logger}` by injection and is usable without a server. `logger` is duck-typed
(`info`/`warn`/`error`, optionally `debug`); passing nothing still routes warnings and errors to the
console, because none of these may fail silently.

| Module | Owns | Never does |
|---|---|---|
| `config` | Env parsing, paths, token generation and persistence. `setRuntime()` records the address actually bound, which the origin allowlist is built from | Read anything at request time |
| `security` | Constant-time token compare, origin allowlist, upgrade check, host check, CSP | Know about sessions |
| `protocol` | Every message name, status, limit and env var name, shared with the browser | Contain logic |
| `ring-buffer` | Byte-sequenced scrollback and tail queries | Know about sockets |
| `session-manager` | PTY lifetime, attach/detach, status transitions, output fanout, backpressure. Emits `deliver`, `resync`, `session`, `exit`, `closed` | Kill a session because a socket closed |
| `hook-bus` | Event normalization, session resolution, applying events to state, the JSONL timeline, stall detection. Emits `event`, `stalled` | Infer anything from PTY output |
| `approvals` | The long-poll queue, rule matching and persistence, the audit log. Emits `request`, `resolved`, `rules` | Fail open on timeout |
| `race` | Worktrees, diffs, adoption, scoreboard. Emits `race` | Run git through a shell, or abort a conflicted merge |
| `usage` | Quota snapshot from the statusLine hook plus transcript aggregation, cached 60 s | Drive a TUI |
| `usage-parser` | Pure parsing of quota and transcript shapes, fully unit-tested | Touch the filesystem |
| `projects` | Recent-project index from `~/.claude/history.jsonl` and a bounded scan | Scan without a budget |
| `workspace` | `.orchestra.json` validation and expansion into specs | Trust the file, or let a path escape the recipe directory |
| `hooks-install` | Safe merge into `~/.claude/settings.json` | Write a file it failed to parse |
| `which` | PATH resolution to an absolute binary | Return a bare command name |

Server-side event fanout is wired in `server.js` and nowhere else. A module emits; it does not know a
WebSocket exists.

### Client modules

`public/js/` mirrors that split: `store.js` holds state, `connection.js` owns the socket and reconnection,
`protocol.js` re-exports the shared table, and each view (`terminal-view`, `sidebar`, `supervision`,
`approvals-ui`, `race-ui`, `launcher`, `settings`, `notifications`) reads the store and sends protocol
messages. `dom.js` is the only place that builds elements. `app.js` is the shell that wires them together,
and like `server.js` it should stay assembly only.

---

## 9. Testing

```bash
npm test    # node --test test/*.test.js, 88 tests
npm run lint
```

Current coverage is the pure and security-critical surface: `cli-args`, `ring-buffer`, `security`,
`usage-parser`, `which`, `workspace`. New logic belongs in a `lib/` module with an injectable config so it
can be tested the same way, rather than inline in `server.js`.
