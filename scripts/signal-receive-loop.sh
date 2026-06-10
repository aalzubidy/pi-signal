#!/bin/bash
# signal-receive-loop.sh — runs signal-cli daemon for in-memory SSE streaming
# Installed to /usr/local/bin/ by setup.sh.
# Not intended to be run directly; managed by systemd.
#
# Architecture (mirrors hermes-agent):
#   - Daemon runs in single-account mode (-a NUMBER) — account pre-loaded at startup
#   - SSE listener connects directly from the pi extension via Node.js http module
#   - No log file is used — messages are streamed in-memory for security
#   - Daemon restarts only on health check failure

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

# ── Keep daemon alive ──────────────────────────────────────────────────
# The pi extension connects directly to the daemon SSE endpoint over HTTP
# and streams messages in-memory.  No log file is written.
# This loop only monitors the daemon process and restarts it if it dies.
echo "signal-cli daemon is running. pi will connect to SSE endpoint directly."

while true; do
	# Verify daemon is still alive
	if ! kill -0 "$DAEMON_PID" 2>/dev/null; then
		echo "signal-cli daemon died, restarting..."
		wait_for_port_free
		signal-cli -a "$PI_SIGNAL_ACCOUNT" daemon --http 127.0.0.1:8080 &
		DAEMON_PID=$!
		sleep 5
	fi

	# Check health endpoint periodically
	if ! curl -s --max-time 5 http://127.0.0.1:8080/api/v1/check >/dev/null 2>&1; then
		echo "signal-cli daemon health check failed, restarting..."
		kill "$DAEMON_PID" 2>/dev/null
		wait "$DAEMON_PID" 2>/dev/null
		wait_for_port_free
		signal-cli -a "$PI_SIGNAL_ACCOUNT" daemon --http 127.0.0.1:8080 &
		DAEMON_PID=$!
		sleep 5
	fi

	sleep 30
done