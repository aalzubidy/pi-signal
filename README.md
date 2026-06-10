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

## Quick Start

**Prerequisites:** Linux with systemd, Java 25+ ([adoptium.net](https://adoptium.net/)), [signal-cli](https://github.com/AsamK/signal-cli/wiki/Quickstart) in PATH, Signal app on your phone.

```bash
# 1. Run the setup wizard
bash scripts/setup.sh        # links device, creates systemd service

# 2. Set your phone number
export PI_SIGNAL_ACCOUNT=+1234567890   # add to ~/.profile

# 3. Install and restart pi
pi install npm:@aalzubidy/pi-signal
# Then restart pi or run /reload
```

Send a Note-to-Self from your phone. pi receives it (👀), processes it, and replies automatically (✅).

## How It Works

```
Phone (Note-to-Self) → signal-cli daemon (SSE in-memory) → pi extension
    → 👀 reaction → LLM processes → auto-reply → ✅ reaction
```

The extension connects directly to the signal-cli daemon's SSE endpoint over HTTP — **no log file on disk** (messages are streamed in-memory).

Commands (`/model`, `/abort`, `/clear`, `/stats`, `/ping`, `/help`) are handled locally without LLM. Everything else is forwarded to the LLM.

## Environment Variables

| Variable | Required | Default | Description |
|---|---|---|---|
| `PI_SIGNAL_ACCOUNT` | Yes | — | Your Signal number in E.164: `+1234567890` |
| `PI_SIGNAL_PRIMARY` | No | `false` | Set `"true"` on the ONE instance handling Signal messages |
| `PI_SIGNAL_DAEMON_URL` | No | `http://127.0.0.1:8080` | Daemon URL for JSON-RPC and SSE |
| `PI_SIGNAL_STATS` | No | `short` | Stats mode: `off`, `short`, or `full` |
| `PI_SIGNAL_QUIET_DAEMON` | No | `false` | Silence daemon stdout in journalctl |

## Commands (from Signal)

| Command | Purpose |
|---|---|
| `/model <name>` | Switch model (fuzzy match) |
| `/abort` | Stop current generation |
| `/clear` | New session |
| `/stats [short\|full\|off]` | Toggle usage stats |
| `/ping` | Test connectivity |
| `/help` | Show available commands |

## TUI Commands (in pi)

`/signal-setup`, `/signal-start`, `/signal-stop`, `/signal-status`, `/signal-model`, `/signal-abort`, `/signal-stats`

## Tools (LLM-accessible)

- **`signal_send`** — Send a Signal message to a phone number (E.164)
- **`signal_status`** — Check connection status and health

## Multiple Instances

Set `PI_SIGNAL_PRIMARY=true` on one pi instance. Other instances ignore Signal messages.

## Troubleshooting

```bash
sudo systemctl status signal-receive.service
sudo journalctl -u signal-receive -f
curl -s http://127.0.0.1:8080/api/v1/check
# /signal-status in pi
```

See [skills/signal/SKILL.md](skills/signal/SKILL.md) for full troubleshooting.

## Files

```
pi-signal/
├── package.json
├── README.md
├── LICENSE
├── extensions/
│   └── signal.ts                # Main extension
├── skills/
│   └── signal/SKILL.md          # Full setup & troubleshooting guide
└── scripts/
    ├── setup.sh                 # Interactive setup wizard
    ├── signal-receive-loop.sh   # Native daemon manager
    └── signal-receive.service   # systemd unit template
```

## License

MPL-2.0 — see [LICENSE](LICENSE).