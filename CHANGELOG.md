# Changelog

## 1.1.0

### Added
- **Phone commands:** `/status` (live connection & model info, in-memory — never hangs), `/whoami` (model, directory, session), `/resend` (re-send last reply), `/pause` and `/resume` (gate message processing without stopping the service).
- **TUI commands:** `/signal-restart` (restart the systemd service), `/signal-logs [n]` (recent journal lines), `/signal-send <+E164> <msg>` (send from the TUI).
- **`signal_list_contacts` tool:** resolves a contact name to a number so you can say *"send this to Mike"* — the agent looks up the number, then sends.

### Changed
- Sending your response to another number now returns the agent's confirmation to your Note-to-Self, so you can see it was sent and to whom (self-sends still suppress the duplicate).

### Removed
- `/ping` — superseded by `/status`.
