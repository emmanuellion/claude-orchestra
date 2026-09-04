# Claude Orchestra

**The control plane for a swarm of [Claude Code](https://docs.anthropic.com/en/docs/claude-code) agents.**

Orchestra runs N Claude Code agents at once and adds the layer a terminal cannot: sessions that
outlive the browser tab, agent state read from Claude Code's own hook events instead of guessed from
the ANSI stream, permission prompts you answer from your phone, and isolated git worktrees racing the
same task so you can compare the diffs and adopt a winner.

It is built just as much for the hours you are **not** watching. Agents resume themselves when a quota
window resets, stop themselves at a spend cap, obey rules committed to the repository they are working
in, and hand you a summary of the night when you come back.

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Node.js](https://img.shields.io/badge/Node.js-20+-339933?logo=node.js&logoColor=white)](https://nodejs.org/)
[![Tests](https://img.shields.io/badge/tests-259%20passing-brightgreen)]()

### What is in here

**Running agents** &nbsp;·&nbsp; [Why not just several terminals?](#why-not-just-several-terminals)
&nbsp;·&nbsp; [Getting started](#getting-started)
&nbsp;·&nbsp; [Telling sessions apart](#telling-sessions-apart)
&nbsp;·&nbsp; [Hooks](#hooks)
&nbsp;·&nbsp; [Race Mode](#race-mode)
&nbsp;·&nbsp; [Recipes](#recipes-orchestrajson)

**Deciding what agents may do** &nbsp;·&nbsp; [Remote permissions](#remote-permissions)
&nbsp;·&nbsp; [Policy a repository carries](#policy-rules-a-repository-can-carry)
&nbsp;·&nbsp; [Spend caps](#spend-caps-that-stop)

**Working unattended** &nbsp;·&nbsp; [Quota blocks and auto resume](#quota-blocks-and-auto-resume)
&nbsp;·&nbsp; [Push notifications](#push-the-last-mile-of-remote-approval)
&nbsp;·&nbsp; [The recap](#the-recap-while-you-were-away)
&nbsp;·&nbsp; [Agents on other machines](#agents-on-other-machines)

**Operating it** &nbsp;·&nbsp; [Security](#security)
&nbsp;·&nbsp; [Configuration](#configuration)
&nbsp;·&nbsp; [Architecture](#architecture)
&nbsp;·&nbsp; [Migrating from v1](#migrating-from-v1)

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

**5. A tty cannot be trusted to run alone.** The interesting hours are the ones nobody is watching, and
that is exactly when an agent hits a quota wall at 03:00 and sits there until morning, or loops on a
failing test until it has spent forty dollars. Orchestra treats unattended work as the normal case:
it notices the quota block and types the prompt back when the window resets, stops a session at a spend
cap without killing its context, enforces rules committed to the repository rather than remembered in
one operator's browser, and greets you with what happened and what is still blocked. None of it is on
by default, because a server that types into your terminals should be something you switched on.

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

### The first run

Orchestra opens on an empty grid and a short checklist. Two steps are required:
install the Claude Code hooks, and start an agent in a project directory.

The hooks matter more than the checklist makes them sound. They are how the
server learns what an agent is doing; without them every panel is a plain
terminal and the interesting screens (agent status, approvals, the timeline, the
recap) stay empty with no error to explain it. That is why it is step one and
why the checklist cannot be dismissed until it is done.

The two optional steps change how things behave, so neither is switched on by
installing hooks: **approving tool calls yourself** makes agents stop and wait
for a human on every tool call, and **push** is what reaches your phone when the
tab is closed. Both can be turned on later from Settings.

The checklist removes itself once there is nothing left to say.

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

No screenshots are published yet. The SVG files that used to sit here were hand-drawn mockups, not
captures of the running app, and calling them screenshots was a lie. An animated demo of the real UI is
planned; until it lands, here is the honest version, the shape of the interface:

```
+---------------------------+---------------------------------------------------+
| SIDEBAR                   | Terminals  Agents  Approvals  Races  Recap  Projects
|                           +---------------------------------------------------+
| > api-refactor    busy    |                                                   |
|     Edit src/db.js        |   Set up Orchestra              2 of 4 done  Hide |
| > docs-pass       idle    |   [1] Install the Claude Code hooks     [Install] |
| > migration  awaiting     |   (shown on first run, retires by itself)         |
|     Bash: rm -rf build/   +---------------------------------------------------+
| > race:variant-a  busy    |                                                   |
| > api @ build-box  ext    |   xterm view of the focused session,               |
|                           |   grid / columns / tabs                           |
| Usage  session 41%        |                                                   |
|        weekly   12%       |                                                   |
+---------------------------+---------------------------------------------------+
```

Six top-level views, and the tooltip on each says what it is for:

| View | What it answers |
|---|---|
| **Terminals** | The agents themselves. Type here like any terminal |
| **Agents** | Every agent at a glance: what it is doing, for how long, at what cost |
| **Approvals** | Tool calls an agent is blocked on, waiting for you |
| **Races** | One prompt run several ways in isolated worktrees, then adopt a winner |
| **Recap** | What happened while you were not watching, and what is still waiting |
| **Projects** | Start an agent in a project directory |

Status on the left comes from hooks, not from reading the terminal: `starting`, `idle`, `busy`,
`awaiting-input`, `awaiting-permission`, `exited`, plus a detached marker when no browser is attached.
A row marked `ext` is an agent on another machine, adopted through its hooks.

Settings are six tabs rather than the nine these options would otherwise need: **Setup** (hooks),
**General**, **Safety** (live approvals and repository policy), **Limits** (quota resume and spend
caps), **Remote** (address, QR code, push) and **Shortcuts**. Approvals and policy are one question
asked twice, and so are quota and budget; splitting them gave every pane an accurate name and left
nobody able to guess which one to open.

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

Install them from **Settings > Setup**, or from the checklist Orchestra shows on first run. Orchestra writes to `~/.claude/settings.json`.

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
line, never rewritten. Rules are managed in **Settings > Safety**.

---

## Push: the last mile of remote approval

Remote approval only means something if the request reaches you. The browser
Notification API cannot do that: it needs the page alive and foregrounded, which
a phone in a pocket never is. So Orchestra speaks Web Push, and a permission
request wakes a closed tab.

Enable it in **Settings > Remote**, on the device you want notified. What gets
pushed: a permission request (the only one marked as requiring interaction,
because an agent is blocked until it is answered and then fails closed), a
budget cap being hit, a session resumed after a quota reset, and a stall.

**The payload is encrypted to a key only your browser holds.** RFC 8291 with
`aes128gcm`, signed with a VAPID keypair generated on first run and kept in
`~/.claude/orchestra/push.json`. The push service (Google, Mozilla, Apple)
forwards ciphertext it cannot read, and the server never sees the content again
after it leaves. Both specs are implemented directly in `lib/push.js` rather than
through `web-push`, because the repository ships no dependency it does not need;
`test/push.test.js` decrypts what the encrypter produces using an independently
derived subscriber key, and verifies the VAPID signature against the advertised
public key.

**Push needs a secure context.** Over plain http on a LAN address there is no
service worker at all and the failure is otherwise silent, so the settings pane
says so rather than offering a button that cannot work. Reach Orchestra over a
tunnel with TLS, which is what the Remote tab is already telling you to do.

`public/sw.js` is the only part of Orchestra that runs with the tab closed. It
caches nothing on purpose: a stale cached copy of an app whose whole job is
showing live agent state would be worse than no app.

---

## Spend caps that stop

Cost was always visible. Visible is not the same as bounded, and an agent in a
retry loop overnight is exactly the case where nobody is reading the dashboard.

A cap turns the number Orchestra already reads into a limit. At the ceiling the
session is **locked**, not killed: `locked` is a property the rest of the system
already respects, so `SessionManager.write` refuses input and so does the quota
auto resume. One flag, already honoured everywhere, is the whole enforcement
mechanism. The context, the scrollback and the worktree all survive, because
killing would destroy work to save money that was already spent.

Caps come in two shapes, both in **Settings > Limits**: per session, and per
calendar day across everything on the machine. A repository may ask for a
stricter per-session cap in its own policy file (below); it can tighten the
global number and never loosen it.

**Unlocking grants another cap's worth, not an exemption.** The session is
already past its limit when you unlock it, so a plain unlock would be undone by
the very next hook event carrying a cost. Instead the ceiling is raised to what
it has spent plus one more cap: the limit still exists, it was deliberately
raised once, and it will stop the session again.

The ledger lives in `~/.claude/orchestra/budget.json`, per day and per session,
45 days deep, so a restart does not reset today's total.

---

## Policy: rules a repository can carry

An approval rule is one operator's accumulated "always allow" clicks, on one
machine. It cannot be reviewed, shared or required. A team that wants "no agent
runs `rm -rf` in this repo, ever" has nowhere to put that sentence.

`.orchestra-policy.json`, committed next to the code it governs, is that place.
It is read from a session's working directory upward, so a policy at the
repository root covers every agent working anywhere inside it, and the nearest
one wins.

```json
{
  "version": 1,
  "name": "backend",
  "rules": [
    { "tool": "Bash", "match": "rm -rf*", "decision": "deny", "reason": "never from an agent" },
    { "tool": "Bash", "match": "git push*", "decision": "deny" },
    { "tool": "Read", "decision": "allow" },
    { "tool": "*", "match": "*secret*", "decision": "deny" }
  ],
  "defaultDecision": "ask",
  "budget": { "session": 5 }
}
```

Four properties make it worth having rather than being a second rule list:

- **A policy deny is final.** No stored rule and no click can lift it. You can
  still edit the file, but that is a commit, in review, in history, which is the
  entire point.
- **It is consulted before anything else,** so it constrains the shortcut and
  not just the prompt. A policy that says `ask` deliberately suppresses your
  stored rules for that call.
- **Deny is evaluated before allow, regardless of the order rules are written
  in.** The file is a boundary, not a first-match dispatch table; relying on
  ordering for a safety rule is how a reviewer misses one.
- **`allow` is ignored by default.** This file arrives with `git clone`. A
  hostile repository carrying `{"tool": "Bash", "decision": "allow"}` would turn
  cloning it into a way to auto-approve every command an agent runs in that
  checkout, before a human ever sees one. So a policy read out of a repository
  may only ever tighten: deny and ask always apply, allow does not, unless you
  set `ORCHESTRA_TRUST_REPO_POLICY=1` for repositories you control. The settings
  pane says so rather than showing rules that look active and are not.

The same asymmetry governs the budget line: `budget.session` can lower the
global per-session cap for that repository and can never raise it.

A malformed rule is dropped and reported rather than failing the file, but a
file that will not parse at all holds everything it would have governed at
`ask`. A typo must not silently read as "no policy".

**Settings > Safety** shows the policy in force for the session you are looking
at. It is read only, deliberately: a policy a settings pane could edit would be
a preference with extra steps.

---

## Agents on other machines

Hooks reach Orchestra from anywhere that has `ORCHESTRA_URL` and a token, so an
agent on a second machine could already have its permission requests answered
here. What was missing is that the server had nowhere to put it: an event
matching no local session was logged and dropped, and the agent existed in the
approval queue and nowhere else.

Now it is adopted. Point a `claude` on another box at this Orchestra (install
the hooks there with `ORCHESTRA_URL` set to the tunnel) and it appears in the
sidebar with full agent state: status, current tool, turns, cost, git-less but
otherwise complete. It takes part in approvals, budgets, the timeline and the
digest.

An external agent has **no PTY**, so there is no terminal and it accepts no
input. Nothing typed at a panel and nothing from the quota auto resume can reach
a machine Orchestra does not own.

Adoption is precise about what it will not do. An event carrying no Claude
session id has nothing stable to key on, so it is ignored rather than creating a
record per event. An event whose directory matches two local sessions is the
case where resolution already refuses to guess, and adopting there would hang a
phantom agent beside two real ones. Records are keyed by host plus Claude
session id, so a reconnecting agent lands back on its own row. Silence for 30
minutes, not detachment, is what ends one.

This grants no new access: those hooks already hold a valid token and their
approvals already queued here. It only decides whether the agent is visible
while that happens. `ORCHESTRA_ADOPT_EXTERNAL=0` turns it off.

---

## The recap: while you were away

The **Recap** tab answers the question you actually have after eight hours: what
is blocked, what happened, what did it cost.

It introduces no new data. The hook timeline, the costs, the quota blocks and
the budget locks all already existed and were unreadable, scattered across a
JSONL file nobody opens and six scrollbacks. The digest orders them by what a
returning operator has to act on, leads with a handful of plain sentences that
survive being read on a phone, and puts the button that unblocks a thing next to
the thing.

Pick a window (1h, 8h, 24h, 7d) or read `GET /api/digest?since=<epoch ms>`.

---

## Quota blocks and auto resume

Claude Code stops when the account runs out of quota. The turn ends mid task, the session drops back to
an idle prompt, and it stays there. The five hour window resets at an hour nobody chose, often
overnight, so the work sits finished-but-unfinished until someone comes back and types one word.

Orchestra can type that word.

**Noticing.** No hook fires for a quota block. `Stop` cannot tell a finished turn from an interrupted
one, and the statusLine snapshot says the *account* is exhausted without saying which of six panels got
cut off. So the banner in the terminal is the signal: `lib/quota-limit.js` reads the bytes already on
their way to the browser, strips the ANSI and the box drawing, and matches a short list of phrases
against a rolling 8 KB window (the banner routinely spans two PTY flushes). This is the only screen
reading left in Orchestra and it is not the `/usage` scraper that was removed in v2: nothing is spawned,
no TUI is driven, no trust prompt is answered on your behalf.

**Confirming.** A match is a suspicion. Before typing anything, `lib/auto-resume.js` re-reads the
statusLine quota snapshot; a window still reporting 100% means the reset has not really landed, whatever
the banner said, and the plan re-arms on the reset the account reports instead.

**Resuming.** At the reset instant plus a grace period, one prompt is typed and submitted. Which prompt
is yours to choose, in **Settings > Limits**.

It is **off by default**, and while it is off Orchestra still shows you what is blocked and when it
resets. It just does not type. Turning it on gives a background process permission to write into a live
terminal unattended, which is why the refusals are the bulk of the feature:

| It will not resume | Why |
|---|---|
| Anything that is not a Claude session | A shell would *execute* the word, not prompt with it |
| A session holding a permission prompt | The next line would be read as the menu answer, deciding a permission for you |
| A session still producing output | Typing into a live render lands anywhere but the prompt |
| A locked session | Locking a panel means hands off, including ours |
| More than `maxAttempts` times | A session that keeps re-blocking is left alone rather than looped |
| Every blocked session at once | They are staggered; releasing six agents into a fresh window re-consumes it and they block again together |

The prompt itself is flattened to one printable line before it is sent: control characters and escape
sequences become spaces, so a pasted multi-line string cannot submit halfway through and leave the rest
to be read as a second prompt, and cannot drive the TUI.

Timing is checked on a five second wall-clock sweep rather than a `setTimeout`, because a laptop that
slept through the reset would otherwise wake with a timer that fires hours late or not at all.

Settings persist to `~/.claude/orchestra/auto-resume.json`. The API is `GET`/`PUT /api/auto-resume`,
`POST /api/auto-resume/<sessionId>/now` to resume one immediately, and `DELETE /api/auto-resume/<sessionId>`
to cancel a plan.

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

**A repository cannot grant itself permissions.** `.orchestra-policy.json` is read from the working
directory, which means it can arrive by cloning someone else's code. Its `deny` and `ask` rules are
obeyed, its `allow` rules are not, and its budget line may only lower a cap. Turning allows on is an
explicit `ORCHESTRA_TRUST_REPO_POLICY=1`, the same distinction `.orchestra.json` already draws between
a local operator relaxing the permission model and a cloned file relaxing it for them.

**Adopting an agent from another machine grants no new access.** Those hooks already hold a valid token
and their approvals already queued here; adoption only decides whether the agent is visible while that
happens. An external agent has no PTY, so nothing typed in the UI can reach the machine it runs on.
`ORCHESTRA_ADOPT_EXTERNAL=0` turns it off.

**Push payloads are encrypted to the subscribed browser.** RFC 8291 with `aes128gcm`: the push service
forwards ciphertext it cannot read, and the VAPID keypair stays in `~/.claude/orchestra/push.json` at
mode `0600`. The subscription list is never handed back out by the API, because the endpoint plus its
keys is what would let someone else deliver notifications to your devices.

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
| `ORCHESTRA_AUTO_RESUME` | `0` | Resume quota-blocked sessions automatically. Off unless you say otherwise |
| `ORCHESTRA_AUTO_RESUME_TEXT` | `continue` | The prompt typed when the quota comes back |
| `ORCHESTRA_AUTO_RESUME_GRACE` | `60` | Seconds waited past the reset instant before typing |
| `ORCHESTRA_AUTO_RESUME_STAGGER` | `30` | Seconds between two sessions resuming |
| `ORCHESTRA_AUTO_RESUME_MAX` | `3` | Resumes tried on one session before it is left alone |
| `ORCHESTRA_AUTO_RESUME_WAIT` | `600` | Seconds a due resume waits for a session to be safe to type into |
| `ORCHESTRA_BUDGET` | `0` | Enforce spend caps. Off unless you say otherwise |
| `ORCHESTRA_BUDGET_SESSION` | `0` | USD one session may spend before it is locked. `0` is no cap |
| `ORCHESTRA_BUDGET_DAILY` | `0` | USD per calendar day across every session. `0` is no cap |
| `ORCHESTRA_BUDGET_ACTION` | `lock` | `lock` freezes the session at the cap, `warn` only alerts |
| `ORCHESTRA_PUSH_SUBJECT` | `mailto:orchestra@localhost` | The `sub` claim in every VAPID token |
| `ORCHESTRA_ADOPT_EXTERNAL` | `1` | Show agents this server did not spawn but whose hooks reach it |
| `ORCHESTRA_TRUST_REPO_POLICY` | `0` | Honour `allow` rules from a repository's policy file. Deny and ask always apply |

These are the defaults **Settings > Limits** starts from; the panel writes
`~/.claude/orchestra/auto-resume.json`, which wins on later boots.

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
auto-resume.json       quota auto resume settings, mode 0600
budget.json            spend caps and the per-day ledger, mode 0600
push.json              VAPID keypair and device subscriptions, mode 0600
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
│   ├── session-manager.js    PTY lifecycle, attach/detach, status machine, external agents
│   ├── hook-bus.js           ingests hook events, applies them, persists the timeline
│   ├── approvals.js          the long-poll permission queue, rules, audit log
│   ├── policy.js             .orchestra-policy.json, consulted ahead of any stored rule
│   ├── args-policy.js        refuses shell metacharacters in launch arguments
│   ├── redact.js             strips secrets before anything is written to disk
│   ├── race.js               worktrees, diffs, adoption, scoreboard
│   ├── usage.js              quota snapshot + transcript aggregation
│   ├── usage-parser.js       pure parsers for the above
│   ├── quota-limit.js        recognises a quota block in a stream of terminal bytes
│   ├── auto-resume.js        types the prompt back when the window resets
│   ├── budget.js             spend caps, the per-day ledger, and the lock that enforces them
│   ├── digest.js             the recap: what happened while nobody was watching
│   ├── push.js               RFC 8291 / 8292 Web Push, no dependency
│   ├── projects.js           recent-project index from ~/.claude
│   ├── project-identity.js   names and colours derived from the working directory
│   ├── workspace.js          .orchestra.json validation and expansion
│   ├── hooks-install.js      safe merge into ~/.claude/settings.json
│   └── which.js              PATH resolution, so we spawn binaries not shell strings
├── hooks/
│   ├── orchestra-hook.js     generic event shim, non-blocking, never writes stdout
│   ├── orchestra-approve.js  blocking PreToolUse gate
│   └── quota-hook.js         statusLine quota snapshot
├── public/
│   ├── index.html            skeleton, nonce and bootstrap injection points
│   ├── sw.js                 service worker: the only code that runs with the tab closed
│   └── js/                   app, dom, store, protocol, connection, terminal-view,
│                             sidebar, supervision, approvals-ui, race-ui, launcher,
│                             settings, notifications, setup, push, digest-view
└── test/                     259 node:test tests
```

### How it flows

```
   BROWSER                         ORCHESTRA SERVER                    AGENT
+------------+                  +--------------------+          +----------------+
|  xterm.js  |                  |  session-manager   |          |     PTY        |
|  sidebar   | <== WebSocket == |  ring-buffer       | <=====>  |  claude ...    |
|  approvals |   output/input   |  approvals+policy  |  bytes   |                |
|  recap     |   session state  |  hook-bus          |          +-------+--------+
+------------+                  |  budget, resume    |                  |
                                +---------^----------+                  |
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

**Two things extend that picture.** Nothing about the loop requires the agent to be on this machine:
a `claude` anywhere that can reach `ORCHESTRA_URL` with a valid token posts to the same endpoint, and
an event matching no local session is adopted as an external agent rather than dropped. It gets full
agent state, approvals, budgets and a place in the recap; it has no PTY, so it has no terminal and
accepts no input.

And the loop no longer ends at an open browser tab. A permission request, a budget lock, a resumed
session and a stall are also delivered as encrypted Web Push messages, which a service worker shows
with the tab closed. That is the only path that reaches a phone in a pocket, and it is the difference
between remote approval being a demo and being usable.

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

Nothing carries over automatically. Reinstall the hooks from Settings > Setup, and write an
`.orchestra.json` for any layout you want back.

---

## Development

```bash
npm test     # 259 node:test tests
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
