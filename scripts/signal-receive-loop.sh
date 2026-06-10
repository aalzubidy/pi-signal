#!/bin/bash
# signal-receive-loop.sh — runs signal-cli daemon and streams messages to incoming.log
# Installed to /usr/local/bin/ by setup.sh.
# Not intended to be run directly; managed by systemd.
#
# Architecture (mirrors hermes-agent):
#   - Daemon runs in single-account mode (-a NUMBER) — account pre-loaded at startup
#   - SSE listener retries independently with exponential backoff
#   - Daemon restarts only on health check failure

LOG_FILE="$HOME/.local/share/signal-cli/incoming.log"
mkdir -p "$(dirname "$LOG_FILE")"

# Auto-discover account from accounts.json if PI_SIGNAL_ACCOUNT is not set
if [ -z "$PI_SIGNAL_ACCOUNT" ]; then
	ACCOUNTS_FILE="$HOME/.local/share/signal-cli/data/accounts.json"
	if [ -f "$ACCOUNTS_FILE" ]; then
		PI_SIGNAL_ACCOUNT=$(grep -o '"number"[[:space:]]*:[[:space:]]*"[^"]*"' "$ACCOUNTS_FILE" | head -1 | sed 's/.*"\([+0-9]*\)"$/\1/' || true)
	fi
	if [ -z "$PI_SIGNAL_ACCOUNT" ]; then
		echo "ERROR: PI_SIGNAL_ACCOUNT is not set and could not be auto-discovered from accounts.json" >&2
		echo "  Set it manually: export PI_SIGNAL_ACCOUNT=+1234567890" >&2
		exit 1
	fi
	echo "Auto-discovered PI_SIGNAL_ACCOUNT=$PI_SIGNAL_ACCOUNT"
fi

DAEMON_PID=""

# Cleanup on exit
cleanup() {
	if [ -n "$DAEMON_PID" ]; then
		kill "$DAEMON_PID" 2>/dev/null
		wait "$DAEMON_PID" 2>/dev/null
	fi
	exit 0
}
trap cleanup EXIT INT TERM

# Rotate log at ~10 MB to keep it from growing unbounded
rotate_log() {
	if [ -f "$LOG_FILE" ]; then
		SIZE=$(stat -c%s "$LOG_FILE" 2>/dev/null || echo 0)
		if [ "$SIZE" -gt $((10 * 1024 * 1024)) ]; then
			mv "$LOG_FILE" "$LOG_FILE.$(date +%s)"
			touch "$LOG_FILE"
		fi
	fi
}

# Wait for port 8080 to be fully released (including kernel TIME_WAIT state).
# signal-cli's Java HTTP server does not set SO_REUSEADDR, so if a previous
# daemon just died, the port can be stuck in TIME_WAIT for ~60 seconds.
# This prevents the "Failed to initialize HTTP Server" error on restart.
wait_for_port_free() {
	local port=8080
	for _ in $(seq 1 90); do
		# Check for anything listening on the port
		if ss -tan "sport = :$port" | grep -q "LISTEN"; then
			sleep 1
			continue
		fi
		# Check for TIME_WAIT sockets that would block bind()
		if ss -tan "sport = :$port" | grep -q "TIME-WAIT"; then
			sleep 1
			continue
		fi
		# Port is fully free
		return 0
	done
	# Timed out — proceed anyway, the daemon will report its own error
	echo "WARN: port $port may still be in use after 90s, attempting startup anyway" >&2
}

# ── Start signal-cli daemon (single-account mode, matches hermes-agent) ──
# Kill any existing daemon to avoid port conflicts
pkill -f "signal-cli daemon --http" 2>/dev/null || true
sleep 1
pkill -9 -f "signal-cli daemon --http" 2>/dev/null || true
sleep 1

wait_for_port_free

# Start daemon in single-account mode (-a) — this pre-loads the account
# at startup, avoiding the NotRegisteredException that multi-account mode
# hits when SSE tries to lazily load the account manager.
signal-cli -a "$PI_SIGNAL_ACCOUNT" daemon --http 127.0.0.1:8080 &
DAEMON_PID=$!

echo "Waiting for signal-cli daemon (PID $DAEMON_PID)..."
DAEMON_READY=0
for _ in $(seq 1 60); do
	if curl -s http://127.0.0.1:8080/api/v1/check >/dev/null 2>&1; then
		echo "signal-cli daemon is ready"
		DAEMON_READY=1
		break
	fi
	if ! kill -0 "$DAEMON_PID" 2>/dev/null; then
		echo "signal-cli daemon exited unexpectedly" >&2
		exit 1
	fi
	sleep 1
done

if [ "$DAEMON_READY" -ne 1 ]; then
	echo "ERROR: signal-cli daemon did not start within 60s" >&2
	exit 1
fi

# ── SSE event stream with independent retry (hermes-agent pattern) ──
# The daemon stays running; only the SSE connection retries on failure.
echo "signal-cli daemon is running, streaming SSE events..."

while true; do
	# Verify daemon is still alive before trying SSE
	if ! kill -0 "$DAEMON_PID" 2>/dev/null; then
		echo "signal-cli daemon died, restarting..."
		wait_for_port_free
		signal-cli -a "$PI_SIGNAL_ACCOUNT" daemon --http 127.0.0.1:8080 &
		DAEMON_PID=$!
		sleep 5
	fi

	rotate_log

	# Stream SSE events to log file — curl streams the event stream,
	# we parse data: lines and append JSON to incoming.log.
	# When curl exits (connection drop), outer loop retries with backoff.
	curl -s -N "http://127.0.0.1:8080/api/v1/events?account=$PI_SIGNAL_ACCOUNT" 2>/dev/null | while IFS= read -r line; do
		[[ "$line" =~ ^[[:space:]]*$ ]] && continue
		[[ "$line" =~ ^[[:space:]]*":" ]] && continue
		if [[ "$line" =~ ^data:[[:space:]]*(.*) ]]; then
			data="${BASH_REMATCH[1]}"
			[ -n "$data" ] && echo "$data" >>"$LOG_FILE"
		fi
	done

	# Connection dropped — retry
	sleep 2
done