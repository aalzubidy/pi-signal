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

## Installation

Installing the pi package (via npm) and provisioning the system daemon (via `setup.sh`) are two
separate steps — the package ships `scripts/setup.sh` inside it, so no `git clone` is needed.

```bash
# 1. Install the pi package
pi install @aalzubidy/pi-signal
```

Restart pi or run `/reload`.

## Step 2 — Run the setup wizard

```
/signal-setup
```

This checks Java 25+ and signal-cli, then prints the exact `bash <installed-path>/scripts/setup.sh`
command to run. pi's command can't run it for you — the script needs a sudo password prompt and a
blocking phone QR scan, and `pi.exec` runs commands without a terminal attached.

Run the printed command in a real terminal. It will:
1. Check Java 25+ and signal-cli
2. Link your Signal device (`signal-cli -a NUMBER link -n pi`)
3. Fix file ownership (handles sudo correctly)
4. Create a systemd service (`/etc/systemd/system/signal-receive.service`)
5. Start the service and verify the daemon is ready

## Step 3 — Set environment variables

Add to your shell config (`~/.profile`, `~/.zshrc`, etc.):

```bash
export PI_SIGNAL_ACCOUNT=+1234567890   # your phone number with +
```

Then reload: `source ~/.profile`

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
      ├── /status /whoami  → in-memory status (no network, no hang)
      ├── /resend          → replay last reply
      ├── /pause /resume   → gate message forwarding
      └── else             → pi.sendUserMessage() → LLM processes
         └── agent_end → auto-reply via daemonRpc("send") + stats footer
            └── Swap 👀 → ✅
```

**Key architectural decision:** The daemon runs in **single-account mode** (`-a NUMBER`). This pre-loads the account at startup, avoiding `NotRegisteredException` that occurs in multi-account mode when the SSE endpoint tries to lazily load the account manager.

## Security model

- **In-memory streaming.** Messages are streamed in-memory via SSE — no message content is written to a log file on disk. By default (`PI_SIGNAL_QUIET_DAEMON=true`) the signal-cli daemon's stdout is also discarded, so message bodies do **not** land in `journalctl`. Set `PI_SIGNAL_QUIET_DAEMON=false` only when debugging (this surfaces daemon output, including message content, in the journal).
- **Contact names are treated as untrusted.** Display names and usernames returned by `signal_list_contacts` come from third-party Signal profiles, so they are sanitized (control characters, newlines, and zero-width/bidi marks stripped; length capped) before reaching the agent, to blunt prompt-injection via a crafted profile name.
- **The local daemon is unauthenticated — trust boundary.** signal-cli's `daemon --http` exposes JSON-RPC and SSE on `127.0.0.1:8080` with **no authentication token** (a signal-cli limitation, not configurable here). It is bound to loopback, so it is not reachable over the network — but **any local user or process on the host** can reach it. Such a process could send Signal messages as your account, read incoming message content and your contact list, or drive the pi agent by injecting a Note-to-Self. **Run pi-signal only on a single-trusted-user host.** Do not expose port 8080 beyond loopback.

---

## Environment Variables

| Variable | Required | Default | Description |
|---|---|---|---|
| `PI_SIGNAL_ACCOUNT` | Yes | — | Your Signal phone number, E.164 format: `+1234567890` |
| `PI_SIGNAL_PRIMARY` | No | `false` | Set to `"true"` on the ONE instance that should handle Signal messages |
| `PI_SIGNAL_DAEMON_URL` | No | `http://127.0.0.1:8080` | Daemon URL for JSON-RPC and SSE |
| `PI_SIGNAL_STATS` | No | `short` | Default stats mode: `off`, `short`, or `full` |
| `PI_SIGNAL_QUIET_DAEMON` | No | `true` | Silence signal-cli daemon stdout so message content stays out of `journalctl` (the secure default). Set to `"false"` to surface daemon output in the journal for debugging. |

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
| `/status` | — | Report live connection & model info from in-memory state (no network call, cannot hang). **Only ever answers when pi is up** — if pi or the daemon is down, the message is never received, so no reply comes. Use it as a liveness ping, not a down-detector. |
| `/whoami` | — | Show current model/provider, working directory, and session name. |
| `/resend` | — | Re-send the exact text of the last reply. Recovers a message Signal dropped without re-running the LLM. |
| `/pause` | — | Stop forwarding incoming messages to the agent. Commands (including `/resume`) still work. |
| `/resume` | — | Resume forwarding messages to the agent. |
| `/help` | — | Show a list of available phone commands. |

### Sending to another number from the phone

There is no `/send` command — instead, ask the LLM naturally: *"summarize the last email and text it to +15551234567."* The agent calls the `signal_send` tool with that recipient, which delivers the message to that number. Because the recipient is not yourself, the extension keeps the reply context, so the agent's own confirmation (e.g. *"I've sent the summary to +15551234567."*) comes back to your Note-to-Self.

You can also refer to people **by name** — *"send this to Mike."* The agent first calls `signal_list_contacts` (optionally with a `query` like "Mike") to resolve the name to a number, asks you which one if several match, then sends. A name only resolves if signal-cli knows it: a contact name synced from your phone's address book, or the person's Signal profile name. Contacts with no phone number (uuid-only) are not offered, since `signal_send` needs an E.164 number.

> The confirmation is the agent's final message. If a model returns only the tool call with no closing text, no confirmation is sent — but in practice models narrate after sending. When the agent sends to **yourself**, the self auto-reply is suppressed to avoid a duplicate.

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
| `/signal-restart` | Restart the systemd service (recovers a wedged daemon / TIME_WAIT) |
| `/signal-status` | Show connection status, account, SSE stream status, stats mode |
| `/signal-logs [n]` | Show the last `n` (default 50) journal lines for `signal-receive`. Runs without sudo; if permission is denied it prints the `sudo journalctl` command to run manually. |
| `/signal-send <+E164> <msg>` | Send a Signal message from the TUI (validates E.164, reuses the daemon send path) |
| `/signal-model <name>` | Switch model by fuzzy-matching partial name |
| `/signal-abort` | Stop current LLM generation |
| `/signal-stats [short\|full\|off]` | View or toggle stats mode |

## Tools (LLM-accessible)

| Tool | Purpose |
|---|---|
| `signal_send` | Send a Signal message to a phone number (E.164) |
| `signal_status` | Check connection status and health |
| `signal_list_contacts` | List contacts as name → number pairs (optional `query` filter) so the agent can resolve a name to a number before `signal_send` |

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