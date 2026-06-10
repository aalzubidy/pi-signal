#!/bin/bash
# setup.sh — Interactive setup wizard for pi-signal (native mode only)
# Usage: bash scripts/setup.sh   (run from the pi-signal package root)
# Installs signal-cli daemon with systemd for native message receiving.

set -euo pipefail

COLOR_RED='\033[0;31m'
COLOR_GREEN='\033[0;32m'
COLOR_YELLOW='\033[1;33m'
COLOR_BLUE='\033[0;34m'
COLOR_RESET='\033[0m'

log_info() { echo -e "${COLOR_BLUE}[INFO]${COLOR_RESET} $*"; }
log_ok() { echo -e "${COLOR_GREEN}[OK]${COLOR_RESET}   $*"; }
log_warn() { echo -e "${COLOR_YELLOW}[WARN]${COLOR_RESET} $*"; }
log_error() { echo -e "${COLOR_RED}[ERROR]${COLOR_RESET} $*"; }

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PACKAGE_DIR="$(dirname "$SCRIPT_DIR")"

# ═══════════════════════════════════════════════════════════════════
# Native mode — guides the user step by step, no auto-install
# ═══════════════════════════════════════════════════════════════════

setup_native_mode() {
	# Capture the real user (handles sudo correctly)
	REAL_USER="${SUDO_USER:-$USER}"
	REAL_HOME=$(eval echo "~$REAL_USER")

	echo ""
	log_info "=== Native Mode Setup ==="
	echo ""

	# ─── Step 1: Check Java 25+ ───────────────────────────────────
	log_info "Step 1/4: Checking Java 25+ dependency..."
	echo ""
	if ! command -v java &>/dev/null; then
		log_error "Java is not installed. signal-cli requires Java 25+."
		echo ""
		echo "  Install Java 25:"
		echo ""
		echo "    Ubuntu/Debian:"
		echo "      sudo apt install openjdk-25-jdk"
		echo ""
		echo "    Fedora/RHEL:"
		echo "      sudo dnf install java-25-openjdk-devel"
		echo ""
		echo "    Arch:"
		echo "      sudo pacman -S jdk25-openjdk"
		echo ""
		echo "    Or download from Adoptium: https://adoptium.net/"
		echo ""
		echo "  Then re-run this script."
		exit 1
	fi
	local java_version
	java_version=$(java -version 2>&1 | head -1 | sed -E 's/.*version "([0-9]+).*/\1/')
	if [ "$java_version" -lt 25 ]; then
		log_error "Java 25+ required, found version $java_version."
		echo ""
		echo "  Update Java and re-run this script."
		exit 1
	fi
	log_ok "Java $java_version found."
	echo ""

	# ─── Step 2: Check signal-cli ─────────────────────────────────
	log_info "Step 2/4: Checking signal-cli installation..."
	echo ""
	if command -v signal-cli &>/dev/null; then
		log_ok "signal-cli found: $(which signal-cli)"
	else
		log_error "signal-cli is not installed or not in PATH."
		echo ""
		echo "  Install signal-cli (JVM build):"
		echo ""
		echo "    # Download latest release:"
		echo '    VERSION=$(curl -sL -o /dev/null -w '"'"'%{url_effective}'"'"' https://github.com/AsamK/signal-cli/releases/latest | sed '"'"'s|.*/v||'"'"')'
		echo '    curl -L -O "https://github.com/AsamK/signal-cli/releases/download/v${VERSION}/signal-cli-${VERSION}.tar.gz"'
		echo ""
		echo "    # Extract and link:"
		echo '    sudo tar xf signal-cli-${VERSION}.tar.gz -C /opt'
		echo '    sudo ln -sf /opt/signal-cli-${VERSION}/bin/signal-cli /usr/local/bin/'
		echo ""
		echo "  Full install docs: https://github.com/AsamK/signal-cli/#install"
		echo ""
		echo "  After installing, ensure 'signal-cli' is in your PATH, then re-run this script."
		exit 1
	fi
	echo ""

	# ─── Step 3: Link device ─────────────────────────────────────
	local account=""
	local accounts_file="$REAL_HOME/.local/share/signal-cli/data/accounts.json"
	if [ -f "$accounts_file" ]; then
		account=$(grep -o '"number"[[:space:]]*:[[:space:]]*"[^"]*"' "$accounts_file" | head -1 | sed 's/.*"\([+0-9]*\)"$/\1/' || true)
	fi

	log_info "Step 3/4: Link your Signal device"
	echo ""

	if [ -n "$account" ]; then
		log_ok "Already linked to account: $account"
		echo ""
		read -r -p "  Re-link device? [y/N]: " relink
		relink="${relink:-N}"
		if [[ "$relink" =~ ^[Yy]$ ]]; then
			account="" # clear so linking runs below
		fi
	fi

	if [ -z "$account" ]; then
		echo "  This links signal-cli as a secondary device on your Signal account."
		echo "  You'll need your phone with Signal installed."
		echo ""
		read -r -p "  Ready to link? [Y/n]: " ready
		ready="${ready:-Y}"
		if [[ ! "$ready" =~ ^[Yy]$ ]]; then
			log_warn "Skipped linking. Run 'signal-cli link -n pi' manually when ready."
		else
			# Kill any existing signal-cli daemon — it holds a lock on the data
			# directory, which prevents link from writing account data.
			if pgrep -f "signal-cli daemon" >/dev/null 2>&1; then
				log_info "Stopping running signal-cli daemon..."
				pkill -f "signal-cli daemon" 2>/dev/null || true
				sleep 2
				# Force kill if still running
				pkill -9 -f "signal-cli daemon" 2>/dev/null || true
				sleep 1
			fi

			# Also stop the systemd service if running
			if sudo systemctl is-active --quiet signal-receive.service 2>/dev/null; then
				log_info "Stopping signal-receive.service..."
				sudo systemctl stop signal-receive.service 2>/dev/null || true
				sleep 1
			fi

			# Wait for port 8080 to be free (including TIME_WAIT sockets)
			for _ in $(seq 1 10); do
				if ! lsof -ti:8080 >/dev/null 2>&1; then
					break
				fi
				sleep 1
			done

			local max_attempts=3
			for attempt in $(seq 1 $max_attempts); do
				if [ "$attempt" -gt 1 ]; then
					log_warn "Retry $attempt/$max_attempts..."
					echo ""
				fi

				log_info "Running: signal-cli link -n pi"
				echo ""
				echo "  A QR code or sgnl:// link will appear below."
				echo "  On your phone: Signal -> Settings -> Linked Devices -> Link New Device"
				echo "  Then scan the QR code or open the link."
				echo ""

				# Generate the link (blocks until user scans or times out)
				# Run as the real user so files are created with correct ownership.
				# -H sets HOME to the target user's home (signal-cli uses $HOME for data dir).
				sudo -u "$REAL_USER" -H signal-cli link -n pi
				echo ""
				read -r -p "  Press Enter after you've scanned/linked on your phone..."

				# Verify the link worked — wait up to 10s for account data to appear
				account=""
				log_info "Verifying link..."
				for _ in $(seq 1 10); do
					if [ -f "$accounts_file" ]; then
						account=$(grep -o '"number"[[:space:]]*:[[:space:]]*"[^"]*"' "$accounts_file" | head -1 | sed 's/.*"\([+0-9]*\)"$/\1/' || true)
					fi
					if [ -n "$account" ]; then
						break
					fi
					sleep 1
				done

				# Fallback: try getUserStatus if accounts.json is still empty
				if [ -z "$account" ]; then
					# Try to detect the linked number from signal-cli
					local status_output
					status_output=$(sudo -u "$REAL_USER" -H signal-cli getUserStatus 2>&1 || true)
					if echo "$status_output" | grep -q "is registered"; then
						account=$(echo "$status_output" | grep -o '+[0-9]*' | head -1 || true)
					fi

					# Also check if there's a data directory with account files
					if [ -z "$account" ] && [ -d "$REAL_HOME/.local/share/signal-cli/data" ]; then
						account=$(ls "$REAL_HOME/.local/share/signal-cli/data" 2>/dev/null | grep '^+' | head -1 || true)
					fi
				fi

				if [ -n "$account" ]; then
					break
				fi

				if [ "$attempt" -lt "$max_attempts" ]; then
					log_warn "No linked account found. The link may have failed."
					read -r -p "  Try again? [Y/n]: " retry
					retry="${retry:-Y}"
					if [[ ! "$retry" =~ ^[Yy]$ ]]; then
						break
					fi
				fi
			done
		fi
	fi

	if [ -n "$account" ]; then
		# Fix ownership: signal-cli link ran as root (via sudo), but the service
		# runs as $REAL_USER. Ensure all data files are owned by the correct user.
		local data_dir="$REAL_HOME/.local/share/signal-cli"
		if [ -d "$data_dir" ]; then
			sudo chown -R "$REAL_USER:$REAL_USER" "$data_dir"
			log_ok "Fixed ownership: $data_dir -> $REAL_USER"
		fi
		log_ok "Linked account: $account"
	else
		log_warn "No linked account -- messages won't work until you link."
	fi
	echo ""

	# ─── Step 4: Create systemd service ───────────────────────────
	log_info "Step 4/4: Setting up background message receiver"
	echo ""
	echo "  signal-cli needs to run continuously to receive incoming messages."
	echo "  We'll create a systemd service that keeps it alive in the background."
	echo "  This is required -- without it, pi won't see incoming Signal messages."
	echo ""

	local service_exists=0
	if [ -f "/etc/systemd/system/signal-receive.service" ]; then
		service_exists=1
		local svc_account=""
		svc_account=$(grep -o 'PI_SIGNAL_ACCOUNT=.*' /etc/systemd/system/signal-receive.service | head -1 | sed 's/PI_SIGNAL_ACCOUNT=//' || true)
		log_ok "Service already exists (account: ${svc_account:-unknown})"
		echo ""
		read -r -p "  Recreate the systemd service? [y/N]: " recreate
		recreate="${recreate:-N}"
		if [[ ! "$recreate" =~ ^[Yy]$ ]]; then
			log_info "Keeping existing service."
		else
			service_exists=0 # will recreate below
		fi
	fi

	if [ "$service_exists" -eq 0 ]; then
		read -r -p "  Create the systemd service now? [Y/n]: " create_svc
		create_svc="${create_svc:-Y}"

		if [[ ! "$create_svc" =~ ^[Yy]$ ]]; then
			log_warn "Skipped. To create later, run this script again or:"
			echo "  Copy pi-signal/scripts/signal-receive.service to /etc/systemd/system/"
			echo "  Then: sudo systemctl daemon-reload && sudo systemctl enable --now signal-receive.service"
		else
			# Stop existing service if running
			if sudo systemctl is-active --quiet signal-receive.service 2>/dev/null; then
				log_info "Stopping existing signal-receive.service..."
				sudo systemctl stop signal-receive.service 2>/dev/null || true
			fi

			# Kill any orphan signal-cli daemon processes
			if pgrep -f "signal-cli daemon" >/dev/null 2>&1; then
				log_info "Killing orphan signal-cli daemon processes..."
				pkill -f "signal-cli daemon" 2>/dev/null || true
				sleep 1
				pkill -9 -f "signal-cli daemon" 2>/dev/null || true
				sleep 1
			fi

			# Install the loop script
			local script_dest="/usr/local/bin/signal-receive-loop.sh"
			mkdir -p "$(dirname "$script_dest")"

			cat >"$script_dest" <<'SCRIPT_EOF'
#!/bin/bash
# signal-receive-loop.sh — runs signal-cli daemon and streams messages to incoming.log
# Managed by pi-signal.
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

# -- Start signal-cli daemon (single-account mode, matches hermes-agent) --
pkill -f "signal-cli daemon --http" 2>/dev/null || true
sleep 1
pkill -9 -f "signal-cli daemon --http" 2>/dev/null || true
sleep 1

wait_for_port_free

# Start daemon in single-account mode (-a) — pre-loads account at startup,
# avoiding NotRegisteredException from multi-account mode SSE.
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

# -- SSE event stream with independent retry (hermes-agent pattern) --
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
  # When curl exits (connection drop), outer loop retries.
  curl -s -N "http://127.0.0.1:8080/api/v1/events?account=$PI_SIGNAL_ACCOUNT" 2>/dev/null | while IFS= read -r line; do
    [[ "$line" =~ ^[[:space:]]*$ ]] && continue
    [[ "$line" =~ ^[[:space:]]*":" ]] && continue
    if [[ "$line" =~ ^data:[[:space:]]*(.*) ]]; then
      data="${BASH_REMATCH[1]}"
      [ -n "$data" ] && echo "$data" >> "$LOG_FILE"
    fi
  done

  # Connection dropped — retry
  sleep 2
done
SCRIPT_EOF

			chmod +x "$script_dest"
			log_ok "Receive loop script: $script_dest"

			# Create the systemd system unit (runs without user login)
			local service_dir="/etc/systemd/system"

			cat >"$service_dir/signal-receive.service" <<SERVICE_EOF
[Unit]
Description=Signal message receiver for pi
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=$REAL_USER
ExecStart=$script_dest
Restart=always
RestartSec=15
TimeoutStopSec=15
Environment=HOME=$REAL_HOME
Environment=PATH=/usr/local/bin:/usr/bin:/bin
Environment=PI_SIGNAL_ACCOUNT=$account

[Install]
WantedBy=multi-user.target
SERVICE_EOF

			log_ok "systemd unit: $service_dir/signal-receive.service"

			# Fix ownership before starting: data files may be root-owned from sudo
			local data_dir="$REAL_HOME/.local/share/signal-cli"
			if [ -d "$data_dir" ]; then
				sudo chown -R "$REAL_USER:$REAL_USER" "$data_dir"
			fi

			# Enable and start
			sudo systemctl daemon-reload
			sudo systemctl enable --now signal-receive.service

			# Wait for daemon to be ready AND account to be loadable
			log_info "Waiting for daemon to start and verify account..."
			local daemon_ready=0
			for _ in $(seq 1 30); do
				if curl -s http://127.0.0.1:8080/api/v1/check >/dev/null 2>&1; then
					# Health check passed — now verify account is loadable
					local sse_check
					sse_check=$(curl -s -N --max-time 3 "http://127.0.0.1:8080/api/v1/events?account=$account" 2>&1 || true)
					if echo "$sse_check" | grep -qi "NotRegistered\|not registered"; then
						log_warn "Daemon started but account not ready yet..."
						sleep 2
						continue
					fi
					daemon_ready=1
					break
				fi
				if ! sudo systemctl is-active --quiet signal-receive.service 2>/dev/null; then
					break
				fi
				sleep 1
			done

			if [ "$daemon_ready" -eq 1 ]; then
				log_ok "signal-receive.service is running and account is ready!"
			else
				log_warn "Service started but daemon may not be ready. Check: sudo journalctl -u signal-receive -f"
			fi
		fi
	fi
	echo ""

	# ─── Smoke test ───────────────────────────────────────────────
	log_info "Running quick smoke test..."
	local test_result
	test_result=$(signal-cli --version 2>&1) || true
	if [ -n "$test_result" ]; then
		log_ok "signal-cli responds: $test_result"
	else
		log_warn "signal-cli --version returned nothing. Check your install."
	fi

	# Test send to self (via daemon JSON-RPC, since daemon holds the data lock)
	if [ -n "$account" ]; then
		log_info "Sending a test message to yourself ($account)..."
		# Wait for daemon to be ready (service just started)
		for _ in $(seq 1 10); do
			if curl -s http://127.0.0.1:8080/api/v1/check >/dev/null 2>&1; then
				break
			fi
			sleep 1
		done
		local send_result
		send_result=$(curl -s -X POST http://127.0.0.1:8080/api/v1/rpc \
			-H 'Content-Type: application/json' \
			-d '{"jsonrpc":"2.0","method":"send","params":{"recipient":"'"$account"'","message":"pi-signal setup test"},"id":1}' \
			--max-time 15 2>&1) || true
		if echo "$send_result" | grep -q '"result"'; then
			log_ok "Test message sent! Check your Signal app."
		else
			log_warn "Test send failed (non-fatal). You can test manually later with:"
			echo "    curl -X POST http://127.0.0.1:8080/api/v1/rpc -H 'Content-Type: application/json' -d '{\"method\":\"send\",\"params\":{\"recipient\":\"$account\",\"message\":\"test\"}}'"
		fi
	fi
	echo ""

	# ─── Summary ──────────────────────────────────────────────────
	echo "════════════════════════════════════════════════"
	log_ok "Setup complete!"
	echo ""
	echo "  Account: $account"
	echo ""
	echo "  Add these to your shell config (~/.profile, ~/.zshrc, etc.):"
	echo ""
	echo "    export PI_SIGNAL_ACCOUNT=$account"
	echo ""
	echo "  Then install the pi package:"
	echo ""
	echo "    pi install $PACKAGE_DIR"
	echo ""
	echo "  Useful commands:"
	echo "    signal-cli daemon --http  # run daemon manually"
	echo "    sudo systemctl status signal-receive  # check service"
	echo "    sudo journalctl -u signal-receive -f   # tail service logs"
	echo "════════════════════════════════════════════════"
	echo ""
}

# ═══════════════════════════════════════════════════════════════════
# Main
# ═══════════════════════════════════════════════════════════════════

main() {
	echo ""
	echo "════════════════════════════════════════════════"
	echo "  pi-signal — Setup Wizard"
	echo "════════════════════════════════════════════════"
	echo ""
	setup_native_mode
}

main "$@"