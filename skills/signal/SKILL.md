---
name: signal
description: >
  Connect pi to Signal Messenger via native signal-cli daemon. Use when the user
  wants to set up two-way messaging between pi and a mobile Signal account,
  or asks to "set up signal", "connect signal", "text pi on signal".
---

# Signal ↔ pi Integration

Two-way messaging between pi and Signal via signal-cli daemon with SSE streaming.

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
  │   └── Streams incoming messages (including Note-to-Self / syncMessage)
  └── RPC endpoint: /api/v1/rpc
      └── JSON-RPC 2.0 for send, sendReaction, etc.

signal-receive-loop.sh
  ├── Starts daemon in single-account mode (-a NUMBER)
  ├── Pipes SSE stream through while-read loop
  ├── Waits for port 8080 TIME_WAIT drain before restart
  ├── Parses data: lines, extracts JSON
  └── Appends to incoming.log

pi extension (signal.ts)
  ├── fs.watch on incoming.log
  ├── parseEnvelope() — handles dataMessage + syncMessage
  ├── Sender filter — only PI_SIGNAL_ACCOUNT
  ├── React with 👀
  ├── pi.sendUserMessage() → LLM processes
  ├── agent_end → auto-reply via daemonRpc("send")
  └── Swap 👀 → ✅
```

**Key architectural decision:** The daemon runs in **single-account mode** (`-a NUMBER`). This pre-loads the account at startup, avoiding `NotRegisteredException` that occurs in multi-account mode when the SSE endpoint tries to lazily load the account manager.

---

## Environment Variables

| Variable | Required | Default | Description |
|---|---|---|---|
| `PI_SIGNAL_ACCOUNT` | Yes | — | Your Signal phone number, E.164 format: `+1234567890` |
| `PI_SIGNAL_PRIMARY` | No | `false` | Set to `"true"` on the ONE instance that should handle Signal messages |
| `PI_SIGNAL_DAEMON_URL` | No | `http://127.0.0.1:8080` | Daemon URL for JSON-RPC |
| `PI_SIGNAL_INCOMING_LOG` | No | `~/.local/share/signal-cli/incoming.log` | Log file path |

## Auto-Reply Behavior

1. Message arrives → extension sends 👀 reaction
2. Message forwarded to LLM via `pi.sendUserMessage()`
3. LLM responds → `agent_end` event fires
4. Response auto-sent to Signal via daemon JSON-RPC
   - Sends as **sync message** (`noteToSelf: true`, `notifySelf: false`) so it appears **grey** (synced from another device), not blue (outgoing). Requires the phone to be a separate linked device.
5. 👀 swapped to ✅ (or ❌ on failure)

If the agent calls `signal_send` during processing, auto-reply is suppressed to prevent duplicates.

## Commands (in pi)

| Command | Purpose |
|---|---|
| `/signal-setup` | Interactive setup wizard |
| `/signal-start` | Start systemd service |
| `/signal-stop` | Stop systemd service |
| `/signal-status` | Show connection status and account |

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

# Is incoming.log growing?
tail -f ~/.local/share/signal-cli/incoming.log

# Is the daemon healthy?
curl -s http://127.0.0.1:8080/api/v1/check

# Can the daemon serve the account?
curl -s -N --max-time 3 "http://127.0.0.1:8080/api/v1/events?account=+YOUR_NUMBER"
```

### General

- `/signal-status` in pi — shows account, connection health
- `signal-cli --version` — verify installation
- `java -version` — verify Java 25+

---

## File Locations

| File | Path |
|---|---|
| signal-cli data | `~/.local/share/signal-cli/data/` |
| Incoming message log | `~/.local/share/signal-cli/incoming.log` |
| Receive loop script | `/usr/local/bin/signal-receive-loop.sh` |
| systemd service | `/etc/systemd/system/signal-receive.service` |