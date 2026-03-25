<div align="center">

# Claude Orchestra

### Run multiple Claude Code instances in parallel from one interface

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Node.js](https://img.shields.io/badge/Node.js-18+-339933?logo=node.js&logoColor=white)](https://nodejs.org/)
[![Claude Code](https://img.shields.io/badge/Claude_Code-compatible-d4a574?logo=anthropic&logoColor=white)](https://docs.anthropic.com/en/docs/claude-code)
[![Platform](https://img.shields.io/badge/Platform-macOS%20%7C%20Linux%20%7C%20Windows-blue)]()
[![100% Local](https://img.shields.io/badge/Privacy-100%25_Local-22c55e)]()

Launch, monitor and communicate with multiple [Claude Code](https://docs.anthropic.com/en/docs/claude-code) instances simultaneously. Terminal multiplexer for AI coding agents. Fully local, zero telemetry.

![Main view](docs/screenshot-main.svg)

</div>

---

## Why Orchestra?

When working on complex projects, a single Claude Code instance isn't always enough. Orchestra lets you:

- Run **multiple Claude Code instances in parallel**, each on a different task
- See at a glance **who's working, who's waiting, who's finished**
- **Minimize** a terminal without stopping it — it keeps running in the background
- **Broadcast** a command to all terminals at once
- Track your **token usage** per model in real time
- Get **desktop notifications** when a terminal finishes its task

## 100% Local — No data sent anywhere

**Orchestra runs entirely on your machine.** No remote server, no telemetry, no tracking.

- The web server runs on `localhost` only
- Terminals are local processes (native PTY)
- Usage stats are read from `~/.claude/` local files
- Preferences are stored in `localStorage` in your browser
- **Zero outbound network requests** (except xterm.js CDN on first load)
- The code is open-source and auditable

---

## Screenshots

<table>
<tr>
<td width="60%">

### Sidebar — Terminal status
Each terminal shows its real-time state:
- **Gold spinner** — running / executing
- **Gray dot** — idle, waiting for input
- **Red dot** — process exited
- **Reduced opacity** — minimized (still running in background)

</td>
<td>

![Sidebar](docs/screenshot-sidebar.svg)

</td>
</tr>
<tr>
<td>

### Usage — Per-model token tracking
Real-time token consumption per model:
- Input, output, cache read and cache creation tokens
- Data from `~/.claude/projects/` session files
- Refreshable with one click

</td>
<td>

![Usage](docs/screenshot-usage.svg)

</td>
</tr>
</table>

---

## Installation

### Prerequisites

| Tool | Min. version | Check |
|------|-------------|-------|
| **Node.js** | 18+ | `node --version` |
| **Python** | 3.8+ | `python3 --version` (`python --version` on Windows) |
| **Claude Code** | — | `claude --version` |

### macOS / Linux

```bash
git clone https://github.com/your-user/claude-orchestra.git
cd claude-orchestra
npm install
npm run dev
```

### Windows

```powershell
git clone https://github.com/your-user/claude-orchestra.git
cd claude-orchestra
npm install
npm run dev
```

> **Windows note:** Python must be accessible via the `python` command in your PATH. If you use `python3`, create an alias or change the `PYTHON` variable in `server.js`.

### Then open

```
http://localhost:3000
```

---

## Usage

### Launching terminals

| Action | Description |
|--------|-------------|
| **+ Claude Code** | Opens a terminal and launches `claude` automatically |
| **+ Shell** | Opens a standard shell terminal (zsh/bash/cmd) |

### Managing terminals

| Button | Action |
|--------|--------|
| **Minimize** | Hides the panel, the process keeps running in the background |
| **Restore** | Re-displays a minimized terminal |
| **Restart** | Kills and relaunches the terminal |
| **Kill** | Terminates the process and removes the terminal |

### Layouts

| Icon | Mode | Description |
|------|------|-------------|
| Grid | **Grid** | Auto-adaptive grid layout |
| Tabs | **Tabs** | Single terminal visible, navigate via sidebar |
| Cols | **Columns** | Terminals side by side |

Auto-detection: 1 terminal = grid, 2 = columns, 3+ = grid.

### Broadcast

Enable the **Broadcast** toggle in the footer to send the same command to **all** terminals simultaneously. Useful for:
- Running the same task across multiple projects
- Sending a global stop signal
- Testing a command in parallel

### Quick input

Each terminal has an input bar at the bottom. Type text and press **Enter** to inject a command without clicking inside the terminal.

### Usage panel

The **Usage** panel in the sidebar shows per-model token consumption:
- Input and output tokens
- Cache read and creation tokens
- Data scanned from `~/.claude/projects/` session JSONL files

Click the refresh button to update.

### Notifications

When a terminal finishes its task (goes from busy to idle), Orchestra sends a **desktop notification** with the terminal name. Notifications are only sent when:
- You're on a different tab or another window is focused
- You've granted notification permission

This way you can work on something else and get notified when Claude is done.

---

## Architecture

```
claude-orchestra/
├── server.js          # Express + WebSocket server
├── pty-helper.py      # Cross-platform PTY bridge (macOS/Linux/Windows)
├── public/
│   ├── index.html     # Main page
│   ├── style.css      # Styles (dark theme)
│   └── app.js         # Client WebSocket + xterm.js
├── docs/
│   └── *.svg          # Screenshots
├── package.json
└── README.md
```

### How it works

```
┌─────────────┐     WebSocket      ┌──────────────┐     stdin/stdout     ┌─────────────┐
│   Browser    │ ◄──────────────► │  server.js    │ ◄────────────────► │ pty-helper.py│
│  (xterm.js)  │                   │  (Express+WS) │                     │ (native PTY) │
└─────────────┘                    └──────────────┘                     └──────┬──────┘
                                                                               │
                                                                        fork / spawn
                                                                               │
                                                                       ┌──────▼──────┐
                                                                       │  zsh / bash  │
                                                                       │  / cmd.exe   │
                                                                       │  → claude    │
                                                                       └─────────────┘
```

1. The browser opens a WebSocket connection to the local server
2. For each new terminal, the server launches `pty-helper.py`
3. The Python helper allocates a real PTY (Unix) or subprocess (Windows)
4. The shell starts in the PTY, and optionally launches `claude`
5. All communication goes through stdin/stdout — **nothing leaves localhost**

### Compatibility

| OS | Default shell | PTY |
|----|--------------|-----|
| **macOS** | `$SHELL` (zsh) | `pty.openpty()` + `fork` |
| **Linux** | `$SHELL` (bash) | `pty.openpty()` + `fork` |
| **Windows** | `%COMSPEC%` (cmd) | `subprocess.Popen` |

---

## Configuration

### Environment variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3000` | Web server port |
| `SHELL` | `/bin/zsh` or `/bin/bash` | Shell to use (Unix) |
| `COMSPEC` | `cmd.exe` | Shell to use (Windows) |

---

## Development

```bash
# Development mode (auto-reload)
npm run dev

# Production mode
npm start
```

Dev mode uses `nodemon` to automatically reload the server on file changes.

---

## Security & Privacy

- **No data leaves your machine**
- No accounts, no third-party authentication
- No telemetry, no analytics
- No third-party cookies
- The server listens only on `localhost`
- The only outbound network connections are those made by Claude Code itself (to the Anthropic API), exactly as if you were using it directly in your terminal

---

## Contributing

Contributions are welcome! Feel free to open an issue or submit a pull request.

---

## Star History

If you find this project useful, please consider giving it a star on GitHub! It helps others discover it.

---

## License

MIT

---

<div align="center">
<sub>Built for developers who run multiple AI coding agents in parallel.<br>
Works with Claude Code, Anthropic CLI, and any terminal-based tool.</sub>
</div>
