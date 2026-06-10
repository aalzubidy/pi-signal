# @aalzubidy/pi-signal

Connect [pi](https://pi.dev) to [Signal Messenger](https://signal.org/) for two-way messaging. Send a **Note-to-Self** message from your phone → pi receives it, the LLM processes it, and pi replies back automatically.

> **Only Note-to-Self messages are processed.** Messages from other senders are silently ignored for security.

## Installation

```bash
pi install npm:@aalzubidy/pi-signal
```

For a temporary test run (no install):

```bash
pi -e npm:@aalzubidy/pi-signal
```

## How to Use

### Prerequisites

- Linux with systemd
- Java 25+ ([adoptium.net](https://adoptium.net/))
- [signal-cli](https://github.com/AsamK/signal-cli/wiki/Quickstart) installed and in PATH
- Signal app on your phone

### Step 1 — Run the setup wizard

```bash
# Clone or download the package, then:
cd pi-signal
bash scripts/setup.sh
```

This links your Signal device, creates a systemd service, and starts the daemon. Follow the on-screen prompts.

### Step 2 — Set environment variable

Add to your shell config (`~/.profile`, `~/.zshrc`, etc.):

```bash
export PI_SIGNAL_ACCOUNT=+1234567890   # your phone number with +
```

Then reload: `source ~/.profile`

### Step 3 — Install & restart pi

```bash
pi install npm:@aalzubidy/pi-signal
# Restart pi or run /reload
```

### Step 4 — Test it

Send a Note-to-Self message from your phone. pi receives it, reacts with 👀, generates a response, and sends it back. The 👀 swaps to ✅ (or ❌ on failure).

## How It Works

```
Phone (Note-to-Self) → signal-cli daemon → SSE stream → incoming.log
    → pi extension → 👀 reaction
      ├── Commands handled locally:
      │   ├── /model <name>    → fuzzy match & switch model
      │   ├── /abort           → stop current generation
      │   ├── /clear           → new session / reset context
      │   ├── /stats [off|short|full] → toggle usage stats footer
      │   ├── /ping            → test connectivity (returns pong)
      │   └── /help            → list available commands
      └── Regular message → LLM processes → response auto-sent
          → stats footer appended → ✅ reaction
```

1. You send a Note-to-Self message from your phone
2. The extension detects it and checks for command prefixes
3. **Commands** (`/model`, `/abort`, `/clear`, `/stats`) are handled locally without LLM
4. **Regular messages** are forwarded to the LLM with 👀 reaction
5. The LLM generates a response
6. The response is auto-sent to Signal with a **stats footer** appended
7. The 👀 reaction is swapped to ✅ (or ❌ on failure)

## Environment Variables

| Variable | Required | Default | Description |
|---|---|---|---|
| `PI_SIGNAL_ACCOUNT` | Yes | — | Your Signal phone number in E.164: `+1234567890` |
| `PI_SIGNAL_PRIMARY` | No | `false` | Set to `"true"` on the ONE instance that should handle Signal messages |
| `PI_SIGNAL_DAEMON_URL` | No | `http://127.0.0.1:8080` | Daemon URL for JSON-RPC |
| `PI_SIGNAL_INCOMING_LOG` | No | `~/.local/share/signal-cli/incoming.log` | Log file path |
| `PI_SIGNAL_STATS` | No | `short` | Default stats mode: `off`, `short`, or `full` |

## Multiple Instances

When running multiple pi instances against the same signal-cli, only ONE should process Signal messages. Set `PI_SIGNAL_PRIMARY=true` on that instance. Other instances will log a message and skip the Signal listener.

## Emoji Feedback

| Event | Reaction |
|---|---|
| Message received, processing started | 👀 |
| Generation aborted | 👀 → 🛑 |
| Response sent successfully | 👀 → ✅ |
| Send failed | 👀 → ❌ |

## Phone Commands (Note-to-Self)

Send these from your phone as Note-to-Self messages. They are intercepted locally (never sent to the LLM):

| Command | Purpose |
|---|---|
| `/model <name>` | Switch model by fuzzy-matching partial name |
| `/abort` | Stop current LLM generation |
| `/clear` | Start a new session |
| `/stats [short\|full\|off]` | View or toggle usage stats |
| `/ping` | Test connectivity (returns "pong") |
| `/help` | Show available commands |

## TUI Commands (in pi)

| Command | Purpose |
|---|---|
| `/signal-setup` | Interactive setup wizard |
| `/signal-start` | Start systemd service |
| `/signal-stop` | ⚠️ Stop systemd service (stops Signal message receiving) |
| `/signal-status` | Show account, service health, stats mode |
| `/signal-model <name>` | Switch model by fuzzy-matching partial name |
| `/signal-abort` | Stop current LLM generation |
| `/signal-stats [short\|full\|off]` | View or toggle stats mode |

## Tools (LLM-accessible)

| Tool | Purpose |
|---|---|
| `signal_send` | Send a Signal message to a phone number (E.164 format) |
| `signal_status` | Check connection status and health |

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│ signal-cli daemon -a +NUMBER --http 127.0.0.1:8080              │
│   ├── Single-account mode — account pre-loaded at startup       │
│   ├── SSE: /api/v1/events?account=+NUMBER                       │
│   └── RPC: /api/v1/rpc (JSON-RPC 2.0)                           │
│                                                                  │
│ signal-receive-loop.sh (systemd service)                         │
│   ├── Pipes SSE stream → parse data: lines → incoming.log        │
│   ├── Waits for port 8080 TIME_WAIT drain before restart         │
│   └── Daemon restart on health check failure                     │
│                                                                  │
│ pi extension (signal.ts)                                         │
│   ├── fs.watch on incoming.log                                   │
│   ├── parseEnvelope() → syncMessage.sentMessage                  │
│   ├── React 👀 → LLM → auto-reply → swap ✅                      │
│   └── Send via daemonRpc("send")                                 │
│       (noteToSelf + notifySelf:false → replies appear grey)     │
└─────────────────────────────────────────────────────────────────┘
```

> **Note-to-Self color:** auto-replies use signal-cli's sync-message delivery (`noteToSelf: true`, `notifySelf: false`) so they appear in **grey** (synced from another device) instead of **blue** (outgoing from your own number). The phone must be a separate linked device from the daemon for this to take effect.

## Security

Only messages from `PI_SIGNAL_ACCOUNT` (your own number) are processed — i.e. Note-to-Self messages only. Messages from other senders are silently dropped.

## Troubleshooting

```bash
# Check service
sudo systemctl status signal-receive.service
sudo journalctl -u signal-receive -f

# Check daemon health
curl -s http://127.0.0.1:8080/api/v1/check

# Any mode: check pi
# → Type /signal-status in pi
```

See [skills/signal/SKILL.md](skills/signal/SKILL.md) for full troubleshooting.

## Files

```
pi-signal/
├── package.json
├── README.md
├── AGENTS.md
├── extensions/
│   └── signal.ts                # Main extension
├── skills/
│   └── signal/SKILL.md          # Full setup guide
└── scripts/
    ├── setup.sh                 # Interactive setup wizard
    ├── signal-receive-loop.sh   # Native daemon manager
    └── signal-receive.service   # systemd unit template
```

## References

- [signal-cli GitHub](https://github.com/AsamK/signal-cli)
- [signal-cli JSON-RPC spec](https://github.com/AsamK/signal-cli/blob/master/man/signal-cli-jsonrpc.5.adoc)
- [Hermes Agent Signal adapter](https://github.com/NousResearch/hermes-agent/blob/main/gateway/platforms/signal.py) — reference implementation

## License

MIT