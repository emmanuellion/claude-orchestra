# Claude Orchestra

**The control plane for a swarm of [Claude Code](https://docs.anthropic.com/en/docs/claude-code) agents.**

Orchestra runs N Claude Code agents at once and gives you the layer a terminal cannot provide:
sessions that outlive the browser tab, agent state that comes from Claude Code's own hooks instead of
guesswork on the ANSI stream, permission prompts you can answer from a phone, and a Race Mode that runs
the same task in isolated git worktrees so you can compare the diffs and adopt a winner.

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Node.js](https://img.shields.io/badge/Node.js-20+-339933?logo=node.js&logoColor=white)](https://nodejs.org/)
[![Tests](https://img.shields.io/badge/tests-88%20passing-brightgreen)]()

---

## Why not just several terminals?

A tmux window or four terminal tabs will happily run four `claude` processes. Four things stay out of
reach when you do, and they are the reason this project exists.

**1. A tty carries bytes, not events.** Watching the output stream, "is this agent working or waiting?"
is a guess made by pattern-matching escape sequences, and it is wrong often enough to be useless.
Claude Code emits structured hook events (`PreToolUse`, `Notification`, `Stop`, ...) that say exactly
which tool is running, which model, what it cost, and when the turn ended. Orchestra installs a hook
that posts those events back over HTTP, so status is reported, never inferred. The v1 heuristics are
gone entirely.

**2. A tty dies with its client.** Close the tab, lose the shell. Orchestra owns the PTY; a browser is
only an attached viewer. Closing a tab detaches, and by default a Claude session detached with nobody
watching survives forever (`ORCHESTRA_DETACH_TTL=0`). Reattaching replays only the scrollback you
missed, addressed by byte offset, not the whole screen.

A PTY still dies with the server that owns it, and no amount of design changes that. What Orchestra does
instead is refuse to pretend it never happened: every live session is written to
`~/.claude/orchestra/sessions.json`, so a restart opens with a banner listing what the previous run was
working on, with each agent's directory, git branch and last prompt. A Claude conversation whose own
session id the hook bus captured comes back with `claude --resume`, keeping the conversation; anything
else restarts fresh in the same directory. The alternative, which the v1 shipped, was an empty screen.

**3. A tty cannot block on a human who is somewhere else.** When Claude Code needs permission to run a
command, it prompts on the terminal that owns it, and that terminal is on your desk. Orchestra installs
a blocking `PreToolUse` hook: the tool call is held, the request appears in the Orchestra UI on any
device, and the agent resumes with your answer. It is the difference between leaving four agents running
while you go get coffee and finding four agents stopped on a prompt.

**4. A tty has no notion of "the same task, four ways".** Race Mode creates one git worktree per variant
off the current commit, launches an agent in each, and then shows the four diffs side by side with cost
and duration. Nothing touches your working tree until you adopt a winner.

---

## Getting started

### Requirements

| | Minimum | Check |
|---|---|---|
| **Node.js** | 20 | `node --version` |
| **Claude Code** | any | `claude --version` |
| **git** | any | `git --version` (only needed for Race Mode) |

No Python. The v1 shipped a `pty-helper.py` bridge; the v2 uses `node-pty` on every platform, so
Windows, macOS and Linux take the same code path.

### Run it

In the repository you want to work in:

```bash
npx claude-orchestra
```

That serves the current directory, prints a URL carrying the access token, and opens a browser.

```
npx claude-orchestra ../api --port 3100   # another repo, another port
npx claude-orchestra --no-open            # headless, print the URL only
npx claude-orchestra --help               # every flag
```

### Or from a clone

```bash
git clone https://github.com/emmanuellion/claude-orchestra.git
cd claude-orchestra
npm install
npm start
```

Then open the printed URL. `npm start` runs the same CLI as `npx`; `npm run serve` starts the bare
server without the browser-opening wrapper.

> There is no watch-mode start script in the install path on purpose. A file watcher restarting the
> server takes every running agent down with it.

---

## Screens

No screenshots are published yet. The three SVG files that used to sit here were hand-drawn mockups, not
captures of the running app, and calling them screenshots was a lie. An animated demo of the real UI is
planned; until it lands, here is the honest version, the shape of the interface:

```
+---------------------------+--------------------------------------------------+
| SIDEBAR                   |  Terminals | Supervision | Approvals | Race | +   |
|                           +--------------------------------------------------+
| > api-refactor    busy    |                                                  |
|     Edit src/db.js        |   xterm view of the focused session,              |
| > docs-pass    idle       |   grid / columns / tabs                          |
| > migration  awaiting     |                                                  |
|     Bash: rm -rf build/   |   Supervision: one card per agent, live tool      |
| > race:variant-a  busy    |   feed from the hook timeline                    |
|                           |                                                  |
| Usage  session 41%        |   Approvals: pending permission requests,         |
|        weekly   12%       |   allow / deny, once / session / always          |
+---------------------------+--------------------------------------------------+
```

Status on the left comes from hooks, not from reading the terminal: `starting`, `idle`, `busy`,
`awaiting-input`, `awaiting-permission`, `exited`, plus a detached marker when no browser is attached.

---

## Telling sessions apart

With four agents open, `Claude 1..4` tells you nothing, and picking a colour by hand for each one is a
chore nobody repeats. Both are derived from where the agent works.

**Names** come from the working directory. An agent in `~/git/invoicer` is called `invoicer`; a shell
there is `invoicer shell`; a second agent on the same repo becomes `invoicer 2`. Generic leaf
directories borrow their parent, so `~/git/buyandrent/Frontend` reads as `buyandrent Frontend` rather
than a `Frontend` shared by three repositories. Type something in the **Name** field before starting an
agent to override it, or rename any session in place afterwards by clicking its name.

**Colours** are a pure function of the directory, so every agent in one repository matches, on every
machine and across restarts. Two different projects never get the same colour while colours remain: a
second directory landing on a taken one walks to the next free colour. The colour paints the spine of
the sidebar row and of the terminal panel, so a row and its terminal are recognisably the same thing.

Picking a colour by hand overrides the derived one and recolours the other agents in that same
directory, because the colour identifies the project rather than the terminal. Sessions somebody
coloured by hand keep their choice.

Colours also drive the tag filter and the broadcast target in the sidebar footer, so "send this to
everything running on this repo" is a colour click away.

---

## Hooks

Hooks are the whole difference between a panel and a terminal. Without them Orchestra shows you bytes;
with them it shows you what each agent is doing.

Install them from **Settings > Hooks**. Orchestra writes to `~/.claude/settings.json`.

| Event | What Orchestra does with it |
|---|---|
| `SessionStart` | Binds the Claude session id to the panel, marks it `idle` |
| `UserPromptSubmit` | Turn started, marks the session `busy` |
| `PreToolUse` | Names the tool about to run; also what makes remote approval possible |
| `PostToolUse` | Tool finished, with duration and success |
| `Notification` | Claude is asking a question, marks the session `awaiting-input` |
| `Stop` | Turn finished, marks the session `idle`; this is the honest "done" signal for notifications |
| `SubagentStop` | A subagent finished, the parent turn continues |
| `SessionEnd` | The agent is gone |

Two more entries are optional and installed separately:

- **The approval gate** (`PreToolUse`, blocking): `hooks/orchestra-approve.js`. See the next section.
- **The status line** (`statusLine`): `hooks/quota-hook.js` writes the subscription quota snapshot
  Claude Code reports into `~/.claude/orchestra-quota.json`, which feeds the Usage panel.

The generic event hook is installed with a 10 second timeout and marked non-blocking, so a slow or dead
Orchestra can never stall an agent. It exits 0 on every path and never writes to stdout.

### What the installer guarantees

`~/.claude/settings.json` is your global Claude Code config, and the v1 route this replaces could
destroy it. The v2 installer:

- **refuses to write at all** if the current file is not valid JSON, and tells you to repair it first.
  It never starts from `{}` and never overwrites a file it did not understand.
- **backs up before every write**, to `settings.json.orchestra-backup-<timestamp>`, keeping the last 5.
- **writes through a temp file and a rename**, so a crash mid-write cannot leave a truncated config.
- **only touches entries that are ours**, identified by the `orchestra-hook` / `orchestra-approve`
  markers in the command, plus `statusLine` when it is already ours. A third-party hook on the same
  event is left alone, and uninstalling removes only Orchestra's entries.
- **writes an absolute path to the node binary**, resolved past per-shell version-manager shims
  (`fnm_multishells`, `nvm_multishells`), because a hook command that only works inside today's shell is
  a hook that silently stops working tomorrow. If no stable node can be found, the install warns.

Hooks are installed globally, so `orchestra-hook.js` also runs in terminals Orchestra never spawned. In
that case `ORCHESTRA_URL` and `ORCHESTRA_TOKEN` are absent from the environment and the hook exits
silently, doing nothing.

---

## Remote permissions

An agent that needs permission stops. If the human is in another room, the agent stops for as long as
the human is in another room. Orchestra moves that decision to wherever you are.

**How it works.** The `PreToolUse` gate hook receives the tool call on stdin and POSTs it to
`/api/approvals`. That request is a long poll: the server holds the HTTP response open, pushes the
request to every connected browser, and answers only once a decision exists. The hook then writes
`allow`, `deny` or `ask` back to Claude Code on stdout. The tool call is genuinely blocked for the whole
wait, which is why this hook is the one entry installed as blocking rather than async.

What you see is built for a phone at arm's length: a one-line summary (the command, the file being
edited, the URL being fetched) with the full detail underneath. An `Edit` shows the head of both the
removed and the added text, not the first twenty lines overall, so a long `old_string` cannot push the
replacement off screen and get you to approve a change you never saw.

**Failure behaviour, and it is deliberately asymmetric.**

| Situation | Result |
|---|---|
| No `ORCHESTRA_URL` (a plain terminal, not an Orchestra session) | **ask** |
| No token available | **ask** |
| Orchestra unreachable, or answers a non-2xx, or answers something unreadable | **ask** |
| Orchestra says allow / deny | **allow / deny** |
| Nobody answered before the server-side deadline (`ORCHESTRA_APPROVAL_TIMEOUT`, 300s) | **deny** |
| More than 50 requests already pending | **ask** |
| The session ended, or Orchestra is shutting down, while the request was pending | **deny** |

Fail **open to `ask`** when the control plane is broken: `claude` in a plain terminal must behave exactly
as if this hook did not exist, and a broken control plane must never grant a permission nobody gave.
Fail **closed to `deny`** when the wait expires: a request nobody answered is a request nobody consented
to, and an agent left running overnight must not be able to outlast its operator. The timeout deny is
not configurable to fail open.

A full queue is the one saturation case that falls back to `ask` rather than `deny`. A queue that has
filled up is Orchestra's problem, not evidence that the action is unsafe, and denying there would kill
legitimate work at exactly the moment the operator is busiest. The human still decides, in the terminal.

**Which tools are gated.** The approval hook is installed with a matcher covering `Bash`, `Write`,
`Edit`, `MultiEdit`, `NotebookEdit`, `WebFetch` and `KillShell` only. Read-only tools are deliberately
left out: gating them produces one blocking prompt per file an agent looks at, which is not a decision
anyone can meaningfully make and is enough on its own to saturate the queue.

**Remembered decisions.** Every decision has a scope:

- `once`, the default, applies to this call only.
- `session` keeps the rule in memory for that agent, and it dies with it.
- `always` persists to `~/.claude/orchestra/approval-rules.json`.

A rule is `{tool, pattern, cwd, decision}`. Two properties matter:

- A rule captured from a decision matches **literally**. The pattern language has no escape for `*`, so
  treating an observed `rm *.log` as a wildcard would quietly authorize `rm -rf /`. Only a pattern you
  typed yourself is expanded, and only `*` is expanded: user regexes are not accepted, because a
  mistyped one silently matches more than its author meant, and for an allow rule that is a permission
  you never granted.
- **Deny rules are evaluated before allow rules**, so a broad allow can never shadow a narrow deny. A
  `cwd` on a rule scopes it to that directory and everything under it.

Every decision, whoever made it, is appended to `~/.claude/orchestra/audit.log`, one JSON object per
line, never rewritten. Rules are managed in **Settings > Approvals**.

---

## Race Mode

Run the same prompt N ways, compare, keep one.

**The worktrees.** A race resolves the repository's `HEAD`, then creates one `git worktree` per variant
at `~/.claude/orchestra/races/<race-id>/<variant>`, on a branch named
`orchestra/race-<short-id>-<variant>`. Up to 8 variants. Each gets its own Claude session, its own
optional extra CLI args, and the same prompt. Your working tree is never touched, and uncommitted
changes in the base repo are deliberately not carried into the worktrees; the race starts from the
commit, and you are warned when the base was dirty. If any worktree fails to create, the whole race is
rolled back rather than leaving orphans behind.

**The arena.** While the race runs, the Race view shows every variant's diff against the base commit:
per-file numstat plus the patch, side by side, with the cost and duration each agent reported through
its hooks.

**Adoption.** Pick a winner and Orchestra commits whatever that agent left uncommitted in its worktree,
then merges the branch back into the branch the race started from with `--no-ff`.

**A merge conflict never destroys the work.** If the merge conflicts, Orchestra leaves the repository
exactly as git left it, conflict markers and all, and tells you so. It does not run `git merge --abort`:
aborting would silently throw away the thing the race was run to produce. The worktrees stay in place
until you discard the race. Adoption is also refused, rather than guessed at, when the base branch is no
longer checked out or when the race started from a detached HEAD.

**The scoreboard.** Every adopted race appends an entry to `~/.claude/orchestra/scoreboard.json`
(newest first, last 500): the prompt, the repo, the winner, and per variant the cost, duration, files
touched, additions and deletions. Over time it is the only honest record of which prompt shapes and
which model flags actually pay off.

Race Mode needs `git` on your PATH. Without it the feature reports itself unavailable instead of failing
halfway.

---

## Recipes: `.orchestra.json`

A swarm you retype every morning is a swarm you stop using. Commit the layout in the repository instead.
Orchestra reads `.orchestra.json` from the working directory and offers to apply it.

```json
{
  "version": 1,
  "name": "Payments refactor",
  "agents": [
    {
      "name": "API",
      "kind": "claude",
      "cwd": "services/api",
      "args": "--model opus",
      "prompt": "Read services/api/README.md, then list the endpoints that still write to the legacy ledger table.",
      "tagColor": "blue"
    },
    {
      "name": "Web",
      "kind": "claude",
      "cwd": "apps/web",
      "prompt": "Find every component that renders a currency amount and check it goes through formatMoney.",
      "tagColor": "green"
    },
    {
      "name": "Tests",
      "kind": "claude",
      "cwd": ".",
      "args": "--model sonnet",
      "prompt": "Run the full test suite and summarise only the failures.",
      "tagColor": "orange"
    },
    {
      "name": "Shell",
      "kind": "shell",
      "cwd": "."
    }
  ]
}
```

| Field | Required | Notes |
|---|---|---|
| `version` | yes | `1` |
| `name` | no | Used to name unnamed agents (`Payments refactor 1`, ...) |
| `agents[].kind` | no | `claude` (default), `shell`, or `powershell` |
| `agents[].name` | no | Panel name |
| `agents[].cwd` | no | Relative to the recipe, default `.` |
| `agents[].args` | no | Extra CLI arguments, max 2000 chars |
| `agents[].prompt` | no | Typed into the REPL once it is actually up, max 10000 chars |
| `agents[].tagColor` | no | `none`, `red`, `orange`, `yellow`, `green`, `cyan`, `blue`, `purple`, `pink` |

Maximum 12 agents per recipe.

A recipe is a file in a repository that may have been cloned from anywhere, so it is treated as
untrusted input. `kind` and `tagColor` come from fixed lists. `cwd` must be relative, must stay inside
the recipe's own directory, cannot start with `~`, cannot carry a drive letter (on Windows `C:foo` is
drive-relative and would escape), and is rejected if it reaches outside through a symlink. There is
deliberately **no `env` field**: a recipe cannot inject environment variables into a process on your
machine.

---

## Security

Orchestra spawns shells on your machine, on request, over HTTP. That is worth being precise about.

**Session token.** A 256-bit token is generated on first boot and stored at
`~/.claude/orchestra/session-token` with mode `0600`. Every API route and every WebSocket upgrade
requires it. The page receives it inlined into the HTML at render time, not in a URL the browser will
keep in history. Token comparison is constant-time and does not leak length through an early return.

**Secret redaction in everything written to disk.** The event timeline
(`~/.claude/orchestra/events/*.jsonl`) and the audit log record every command, prompt and edit an agent
produced, and they are kept for as long as you keep them. Without scrubbing, a governance feature would
quietly become a durable credential store. Values are redacted while their shape survives, so
`export STRIPE_SECRET=sk_live_...` is stored as `export STRIPE_SECRET=[redacted]` and stays readable as
a record. Content destined for a file that looks like a credential store (`.env`, `.npmrc`, `id_rsa`,
anything under `.aws` or `.ssh`) is dropped whole rather than pattern-matched, because those files are
secret line by line. Named assignments, `--token`-style flags, `Authorization` headers, provider key
formats, JWTs, PEM private keys and credentials embedded in URLs are all covered; see `lib/redact.js`
and its tests. What the browser shows you while you decide is **not** redacted, because a human
approving a command needs to see the command.

**Origin check on the WebSocket upgrade, and why it is not optional.** WebSockets are exempt from the
same-origin policy. A browser will happily let `https://some-blog.example` open a connection to
`ws://localhost:3000` and read the replies, and the server sees a perfectly ordinary connection. Without
an Origin check, any page you visited while Orchestra was running could open a shell on your machine.
Orchestra rejects the upgrade unless the `Origin` header is one it expects (loopback on the port it is
actually bound to, plus anything in `ORCHESTRA_ORIGINS`) **and** a valid token is presented. A missing
`Origin` means a non-browser client (curl, our own hooks) and is allowed on the token alone, which is
safe precisely because a cross-origin page cannot read that token.

**Host check.** Requests are answered only for hostnames we expect, which blocks the DNS-rebinding shape
where an attacker-controlled name resolves to `127.0.0.1` to obtain a same-origin `Host` header.

**CSP.** `default-src 'self'`, scripts only from `'self'` plus a per-request nonce for the bootstrap
line, `frame-ancestors 'none'`, `base-uri 'none'`, `form-action 'none'`, plus `nosniff`,
`Referrer-Policy: no-referrer` and `X-Frame-Options: DENY`.

**No CDN.** xterm.js and its addons are served from `node_modules` under `/vendor/`. Nothing is fetched
from a third-party host, the app works offline, and no third party learns when you open it. The v1
loaded xterm from a CDN while claiming to be fully local.

**Loopback by default.** The server binds `127.0.0.1`. Passing a non-loopback `HOST` is refused outright
unless you set `ORCHESTRA_ALLOW_REMOTE=1`, and even then it logs a warning on every start, because
anyone who reaches that port and holds the token gets a shell.

**Also enforced:** at most 24 concurrent sessions, 400 client messages per second per socket, a 1 MB
cap on a single inbound WebSocket frame, PTY reads paused above 4 MB of unflushed socket backlog, and a
30 second heartbeat that terminates dead sockets.

### Reaching it from a phone

Do not expose the port. Put a tunnel with TLS in front of loopback (Tailscale, Cloudflare Tunnel, an SSH
`-L` forward, a reverse proxy you control), and add the tunnel's public origin to `ORCHESTRA_ORIGINS`
so the WebSocket upgrade is accepted from it. Keep the bind on `127.0.0.1`. `ORCHESTRA_ALLOW_REMOTE=1`
plus a plain LAN bind means an unencrypted token crossing your network and a shell one guess away; it
exists for people who know exactly why they want it.

---

## Configuration

All optional. Orchestra runs with none of these set.

| Variable | Default | Effect |
|---|---|---|
| `PORT` | `3000` | Port to listen on |
| `HOST` | `127.0.0.1` | Address to bind. Anything non-loopback needs `ORCHESTRA_ALLOW_REMOTE` |
| `ORCHESTRA_TOKEN` | generated | Use this token instead of the stored one |
| `ORCHESTRA_ROTATE_TOKEN` | `0` | Delete the stored token on boot and generate a fresh one |
| `ORCHESTRA_ALLOW_REMOTE` | `0` | Permit binding a non-loopback address |
| `ORCHESTRA_ORIGINS` | empty | Comma-separated extra origins accepted on the WS upgrade |
| `ORCHESTRA_APPROVAL_TIMEOUT` | `300` | Seconds a blocked `PreToolUse` waits before failing closed |
| `ORCHESTRA_DETACH_TTL` | `0` | Seconds a detached **Claude** session survives unwatched. `0` means forever |
| `ORCHESTRA_SHELL_DETACH_TTL` | `86400` | Same, for plain shell sessions |
| `ORCHESTRA_CLAUDE_BIN` | `claude` | Path to the Claude Code binary |

Booleans accept `0`, `false`, `no`, `off` as false; anything else present counts as true.

Orchestra also reads the standard `SHELL` (Unix) and `COMSPEC` (Windows) to pick the default shell for
`+ Shell` panels.

CLI flags override the environment: `--port`, `--host`, `--cwd`, `--workspace`, `--token`,
`--open` / `--no-open`.

State lives under `~/.claude/orchestra/`:

```
session-token          the access token, mode 0600
sessions.json          live sessions, so a restart can report what was lost
approval-rules.json    persisted "always" rules (+ .bak)
audit.log              append-only decision log, secrets redacted
events/YYYY-MM-DD.jsonl  hook timeline, rotated at 20 MB, secrets redacted
races/<race-id>/<variant>/  race worktrees
scoreboard.json        adopted race outcomes
```

---

## Architecture

```
claude-orchestra/
├── server.js                 assembly only: routes, WebSocket transport, the two guards
├── bin/cli.js                npx entry point, arg parsing, health probe, browser open
├── lib/
│   ├── config.js             env, paths, token generation
│   ├── security.js           token compare, Origin/Host checks, CSP
│   ├── protocol.js           the wire contract, shared verbatim with the browser
│   ├── ring-buffer.js        sequenced scrollback, so reattach replays only the tail
│   ├── session-manager.js    PTY lifecycle, attach/detach, status machine
│   ├── hook-bus.js           ingests hook events, applies them, persists the timeline
│   ├── approvals.js          the long-poll permission queue, rules, audit log
│   ├── race.js               worktrees, diffs, adoption, scoreboard
│   ├── usage.js              quota snapshot + transcript aggregation
│   ├── usage-parser.js       pure parsers for the above
│   ├── projects.js           recent-project index from ~/.claude
│   ├── workspace.js          .orchestra.json validation and expansion
│   ├── hooks-install.js      safe merge into ~/.claude/settings.json
│   └── which.js              PATH resolution, so we spawn binaries not shell strings
├── hooks/
│   ├── orchestra-hook.js     generic event shim, non-blocking, never writes stdout
│   ├── orchestra-approve.js  blocking PreToolUse gate
│   └── quota-hook.js         statusLine quota snapshot
├── public/
│   ├── index.html            skeleton, nonce and bootstrap injection points
│   └── js/                   app, dom, store, protocol, connection, terminal-view,
│                             sidebar, supervision, approvals-ui, race-ui, launcher,
│                             settings, notifications
└── test/                     88 node:test tests
```

### How it flows

```
   BROWSER                         ORCHESTRA SERVER                    AGENT
+------------+                  +--------------------+          +----------------+
|  xterm.js  |                  |  session-manager   |          |     PTY        |
|  sidebar   | <== WebSocket == |  ring-buffer       | <=====>  |  claude ...    |
|  approvals |   output/input   |  approvals queue   |  bytes   |                |
|  race view |   session state  |  hook-bus          |          +-------+--------+
+------------+                  +---------^----------+                  |
                                          |                             | env:
                        POST /api/hooks/event/<Event>                   | ORCHESTRA_SESSION_ID
                        POST /api/approvals (held open)                 | ORCHESTRA_URL
                                          |                             | ORCHESTRA_TOKEN
                                          |                     +-------v--------+
                                          +-------------------- | hook scripts   |
                                             HTTP, token auth   +----------------+
```

The loop back from the agent is the new part. Orchestra injects `ORCHESTRA_SESSION_ID`,
`ORCHESTRA_URL` and `ORCHESTRA_TOKEN` into every PTY it spawns (plus `ORCHESTRA_RACE_ID` and
`ORCHESTRA_RACE_VARIANT` for race sessions). The hooks read those back out and post events to the
server, which is what lets two agents working in the same repository stay distinguishable: matching is
by session id first, then by Claude's own session id, then by unique cwd, and when two live sessions
share a cwd the event is reported unmatched rather than attributed to the wrong agent.

The approval route is the same loop with the response held open until a human answers.

For the message-by-message protocol, the session state machine and the module contracts, see
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

---

## Migrating from v1

| Gone | Why |
|---|---|
| `pty-helper.py` and the Python requirement | `node-pty` handles Unix PTY and Windows ConPTY. One code path, one less runtime to install |
| ANSI-stream status heuristics | Replaced by hook events. Guessing "busy" from escape sequences was wrong often enough to be worse than nothing |
| The TUI-driven quota watcher | It drove the `/usage` TUI on a timer and scraped it. Quota now comes from the `statusLine` hook snapshot plus transcript aggregation, with no process to babysit |
| Untargeted broadcast | Writing every keystroke into every session meant one Ctrl+C stopped all of them and a Claude prompt landed inside plain shells. Replaced by `send-to`, which takes an explicit list of session ids |
| `localStorage` profiles | Layouts lived in one browser and could not be shared or reviewed. Replaced by `.orchestra.json`, committed in the repo it describes |
| CDN-loaded xterm | Served from `node_modules`. The app works offline and no third party sees your usage |
| Killing sessions on socket close | Closing a tab now detaches. This is the single change the rewrite exists for |
| Binding `0.0.0.0` | Loopback by default, non-loopback refused without `ORCHESTRA_ALLOW_REMOTE=1` |

Nothing carries over automatically. Reinstall the hooks from Settings > Hooks, and write an
`.orchestra.json` for any layout you want back.

---

## Development

```bash
npm test     # 88 node:test tests
npm run lint # syntax check
npm run serve  # bare server, no browser
```

No runtime dependency beyond `express`, `ws`, `node-pty` and the `@xterm` packages, and no build step:
`public/js` ships as ES modules, served as written.

`package.json` does carry a watch-mode script, but restarting the server kills every running agent with
it. It is for working on `lib/` with nothing important attached, never for daily use.

---

## Contributing

Issues and pull requests welcome. Read [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) first; it documents
the wire protocol and the invariants each module is responsible for.

## License

MIT
