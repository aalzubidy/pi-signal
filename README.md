# @aalzubidy/pi-signal

Connect [pi](https://pi.dev) to [Signal Messenger](https://signal.org/) for two-way messaging. Send a **Note-to-Self** message from your phone → pi receives it, the LLM processes it, and pi replies back automatically.

> **Only Note-to-Self messages are processed.** Messages from other senders are silently ignored for security.

## Installation

**Prerequisites:** [signal-cli](https://github.com/AsamK/signal-cli/) in PATH, Java 25+, Signal app on your phone.

Installation has two separate layers — install the pi package from npm, then provision the
system daemon that receives Signal messages:

```bash
# 1. Install the pi package (no clone needed)
pi install @aalzubidy/pi-signal

# 2. In pi, run the setup wizard command. It checks Java/signal-cli, then prints the
#    exact `bash .../setup.sh` command to run in a terminal (needs sudo + a phone QR
#    scan, which pi's command can't do for you — it just locates the script for you).
/signal-setup

# 3. Run the command it prints, in a terminal:
bash /path/it/printed/scripts/setup.sh   # guides you through device linking, systemd service - **you might need to run it as sudo since it creates systemd service file**

# 4. setup.sh prints these two exports at the end — add them to your shell
#    config (~/.bashrc, ~/.zshrc, ~/.profile), then restart your shell:
export PI_SIGNAL_ACCOUNT=+1234567890   # your Signal number (E.164)
export PI_SIGNAL_PRIMARY=true          # marks this instance as the one handling Signal

# 5. Start pi (restart it or run /reload if already running)
pi
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