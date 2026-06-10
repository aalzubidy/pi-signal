---
name: signal
description: >
  Connect pi to Signal Messenger via native signal-cli daemon. Use when the user
  wants to set up two-way messaging between pi and a mobile Signal account,
  or asks to "set up signal", "connect signal", "text pi on signal".
---

# Signal ↔ pi Integration

Two-way messaging between pi and Signal via signal-cli daemon with in-memory SSE streaming.

## Prerequisites

- Java 25+ (see [adoptium.net](https://adoptium.net/))
- systemd (Linux)
- Signal app on your phone

## Step 1 — Run the setup wizard

```bash
cd /path/to/pi-signal
bash scripts/setup.sh
```

This will:
1. Check Java 25+ and signal-cli
2. Link your Signal device (`signal-cli -a NUMBER link -n pi`)
3. Fix file ownership (handles sudo correctly)
4. Create a systemd service (`/etc/systemd/system/signal-receive.service`)
5. Start the service and verify the daemon is ready

## Step 2 — Set environment variables

Add to your shell config (`~/.profile`, `~/.zshrc`, etc.):

```bash
export PI_SIGNAL_ACCOUNT=+1234567890   # your phone number with +
```

Then reload: `source ~/.profile`

## Step 3 — Install the pi package

```bash
pi install /path/to/pi-signal
```

Restart pi or run `/reload`.

## Step 4 — Test it

Send a Note-to-Self message from your phone. pi receives it and responds.

---

## How It Works

```
signal-cli daemon (-a NUMBER --http 127.0.0.1:8080)
  ├── SSE endpoint: /api/v1/events?account=+NUMBER
  │   └── Streams incoming messages in-memory (no log file)
  └── RPC endpoint: /api/v1/rpc
      └── JSON-RPC 2.0 for send, sendReaction, etc.

signal-receive-loop.sh
  ├── Starts daemon in single-account mode (-a NUMBER)
  ├── Monitors daemon health (periodic HTTP check)
  ├── Waits for port 8080 TIME_WAIT drain before restart
  └── Restarts daemon on failure — no log file written

pi extension (signal.ts)
  ├── SSE HTTP stream (in-memory, no log file)
  │   ├── Connects directly to daemon SSE endpoint
  │   ├── Auto-reconnects with exponential backoff (2s–60s)
  │   └── Parses data: lines, extracts JSON
  ├── parseEnvelope() — handles dataMessage + syncMessage
  ├── Sender filter — only PI_SIGNAL_ACCOUNT
  ├── React with 👀
  └── Command dispatch:
      ├── /model <name>    → fuzzy match & switch model
      ├── /abort           → stop current generation
      ├── /clear           → new session / reset context
      ├── /stats [on/off]  → toggle usage stats
      └── else             → pi.sendUserMessage() → LLM processes
         └── agent_end → auto-reply via daemonRpc("send") + stats footer
            └── Swap 👀 → ✅
```

**Key architectural decision:** The daemon runs in **single-account mode** (`-a NUMBER`). This pre-loads the account at startup, avoiding `NotRegisteredException` that occurs in multi-account mode when the SSE endpoint tries to lazily load the account manager.

**Security:** Messages are streamed in-memory via SSE — no message content is written to a log file on disk.

---

## Environment Variables

| Variable | Required | Default | Description |
|---|---|---|---|
| `PI_SIGNAL_ACCOUNT` | Yes | — | Your Signal phone number, E.164 format: `+1234567890` |
| `PI_SIGNAL_PRIMARY` | No | `false` | Set to `"true"` on the ONE instance that should handle Signal messages |
| `PI_SIGNAL_DAEMON_URL` | No | `http://127.0.0.1:8080` | Daemon URL for JSON-RPC and SSE |
| `PI_SIGNAL_STATS` | No | `short` | Default stats mode: `off`, `short`, or `full` |
| `PI_SIGNAL_QUIET_DAEMON` | No | `false` | Set to `"true"` to silence signal-cli daemon stdout (hides message content from `journalctl`). Default `false` — logs visible. |

> **Note:** The `PI_SIGNAL_INCOMING_LOG` variable has been removed. Messages are now streamed in-memory via SSE for better security.

## Auto-Reply Behavior

1. Message arrives → extension sends 👀 reaction
2. Message forwarded to LLM via `pi.sendUserMessage()`
3. LLM responds → `agent_end` event fires
4. Response auto-sent to Signal via daemon JSON-RPC
   - Sends as **sync message** (recipient-based delivery with resolved UUID) so it appears **grey** (synced from another device), not blue (outgoing). Requires the phone to be a separate linked device.
5. 👀 swapped to ✅ (or ❌ on failure)
6. **Stats footer** appended after response (if `PI_SIGNAL_STATS != off`)

If the agent calls `signal_send` during processing, auto-reply is suppressed to prevent duplicates.

---

## Signal Commands

Send these as Note-to-Self messages from your phone. Commands are intercepted by the extension and handled locally (not sent to the LLM).

| Command | Args | Purpose |
|---|---|---|
| `/model <partial>` | Model name fragment | Fuzzy-match and switch to a model. E.g. `/model claude`, `/model gpt-4o`, `/model sonnet`. Shows closest matches if ambiguous. |
| `/abort` | — | Stop the current LLM generation immediately. Swaps 👀 → 🛑 on your original message. |
| `/clear` | — | Start a fresh session — clears conversation context and restarts. Aborts any in-progress generation first. |
| `/stats` | `short` / `full` / `off` | View current stats mode or change it. `/stats full` enables detailed stats, `/stats off` disables them. |
| `/ping` | — | Test end-to-end connectivity. Returns "pong" via the Signal send path. |
| `/help` | — | Show a list of available phone commands. |

### `/model` — Fuzzy Matching Details

The extension matches your query against model names and provider IDs:

1. **Exact match** (case-insensitive) — switches immediately
2. **Substring match** — e.g. `sonnet` matches any model with "sonnet" in its name
3. **Levenshtein (typo-tolerant)** — e.g. `claud` matches `claude`
4. **Closest matches shown** — if nothing close, shows top 5 candidates

---

## Usage Stats

A stats footer is appended to every LLM response (configurable). This shows context usage and model info.

**Short format (default):**
```
───
Claude Sonnet 4 · 1.2K ctx · 24%
```

**Full format:**
```
───
Model: Claude Sonnet 4 (anthropic/claude-sonnet-4-20250514)
Context: 1,234 tokens
Window: 200,000 tokens
Usage: 24%
```

Control via `/stats` command or `PI_SIGNAL_STATS` environment variable.

---

## Commands (in pi TUI)

These are also available as slash commands in pi's interactive TUI mode:

| Command | Purpose |
|---|---|
| `/signal-setup` | Interactive setup wizard |
| `/signal-start` | Start systemd service |
| `/signal-stop` | ⚠️ Stop systemd service (stops Signal message receiving) |
| `/signal-status` | Show connection status, account, SSE stream status, stats mode |
| `/signal-model <name>` | Switch model by fuzzy-matching partial name |
| `/signal-abort` | Stop current LLM generation |
| `/signal-stats [short\|full\|off]` | View or toggle stats mode |

## Tools (LLM-accessible)

| Tool | Purpose |
|---|---|
| `signal_send` | Send a Signal message to a phone number (E.164) |
| `signal_status` | Check connection status and health |

---

## Troubleshooting

### Daemon not starting

```bash
sudo journalctl -u signal-receive -f
```

Common issues:
- **"NotRegisteredException"** — daemon was started without `-a` flag (multi-account mode). The receive loop script handles this with `-a NUMBER`.
- **"Permission denied"** — data files owned by root (from running setup.sh with sudo). Fix: `sudo chown -R $USER ~/.local/share/signal-cli/`
- **"Failed to initialize HTTP Server"** — port 8080 in TIME_WAIT from a previous daemon. The receive loop now waits for TIME_WAIT to drain. If it still occurs: `ss -tan sport = :8080` to check, then `sudo systemctl restart signal-receive.service`.

### Messages not appearing in pi

```bash
# Is the service running?
sudo systemctl status signal-receive.service

# Is the daemon healthy?
curl -s http://127.0.0.1:8080/api/v1/check

# Can the daemon serve the account?
curl -s -N --max-time 3 "http://127.0.0.1:8080/api/v1/events?account=+YOUR_NUMBER"

# Check pi's SSE connection status via /signal-status in pi
```

> **Note:** There is no log file to tail. Messages are streamed in-memory via SSE directly from the daemon. Check `sudo journalctl -u signal-receive -f` and the pi extension logs for diagnostics.

### Commands not working

- If `/model`, `/abort`, `/clear`, or `/stats` don't respond, the extension may not have captured the session context yet. Ensure the extension loaded correctly with `/signal-status`.
- Check pi's logs for any errors from the signal extension.

### General

- `/signal-status` in pi — shows account, SSE connection health, stats mode
- `signal-cli --version` — verify installation
- `java -version` — verify Java 25+

---

## File Locations

| File | Path |
|---|---|
| signal-cli data | `~/.local/share/signal-cli/data/` |
| Receive loop script | `/usr/local/bin/signal-receive-loop.sh` |
| systemd service | `/etc/systemd/system/signal-receive.service` |