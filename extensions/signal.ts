// @ts-nocheck
// TypeScript types are provided by pi at runtime via jiti.
// This extension uses runtime-only imports; type checking is skipped.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

// ── Configuration ─────────────────────────────────────────────────────

const PI_SIGNAL_ACCOUNT = process.env.PI_SIGNAL_ACCOUNT || "";

// The daemon locks the config file, blocking all CLI commands.
// Use the daemon's JSON-RPC API instead.
const SIGNAL_DAEMON_URL =
	process.env.PI_SIGNAL_DAEMON_URL || "http://127.0.0.1:8080";

const PI_SIGNAL_INCOMING_LOG =
	process.env.PI_SIGNAL_INCOMING_LOG ||
	path.join(os.homedir(), ".local", "share", "signal-cli", "incoming.log");

// When running multiple pi instances, only the primary instance should
// process Signal messages. Set PI_SIGNAL_PRIMARY=true on the instance
// that should handle Signal. All other instances ignore incoming messages.
const PI_SIGNAL_PRIMARY =
	process.env.PI_SIGNAL_PRIMARY === "true" ||
	process.env.PI_SIGNAL_PRIMARY === "1" ||
	process.env.PI_SIGNAL_PRIMARY === "yes";

// ── Extension ──────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
	// Native-mode state
	let fileWatcher: fs.FSWatcher | null = null;
	let lastPosition = 0;

	// Pending reaction (Note-to-Self feedback cycle)
	let pendingReaction: {
		recipient: string;
		targetAuthor: string;
		timestamp: number;
	} | null = null;

	// Track the current Signal sender context so we can send the agent's
	// response back to Signal automatically.
	let currentSignalSender: {
		number: string;
		sender: string;
		timestamp: number;
	} | null = null;

	// ── Helpers ──────────────────────────────────────────────────────

	function getLogPath(): string {
		return PI_SIGNAL_INCOMING_LOG;
	}

	async function ensureLogfile(): Promise<string> {
		const logPath = getLogPath();
		const dir = path.dirname(logPath);
		fs.mkdirSync(dir, { recursive: true });
		if (!fs.existsSync(logPath)) {
			fs.writeFileSync(logPath, "");
		}
		return logPath;
	}

	/**
	 * Parse a single JSON line from the signal-cli daemon SSE stream.
	 * Format: { envelope: { source, sourceName, dataMessage, syncMessage } }
	 */
	function parseEnvelope(line: string): {
		sender: string;
		number: string;
		body: string;
		timestamp: number;
	} | null {
		let raw: unknown;
		try {
			raw = JSON.parse(line);
		} catch {
			return null;
		}
		if (!raw || typeof raw !== "object") return null;

		// Extract envelope from native SSE format
		let env: Record<string, unknown> | null = null;
		if (
			raw !== null &&
			typeof raw === "object" &&
			"envelope" in (raw as Record<string, unknown>)
		) {
			env = (raw as Record<string, unknown>).envelope as Record<
				string,
				unknown
			>;
		}
		if (!env) return null;

		// Extract message body
		// Note: "Note to Self" messages arrive as syncMessage.sentMessage (not dataMessage)
		let body: string | undefined;
		let isNoteToSelf = false;
		if (env.dataMessage && typeof env.dataMessage === "object") {
			const dm = env.dataMessage as Record<string, unknown>;
			body =
				(dm.body as string | undefined) || (dm.message as string | undefined);
		}
		// Check for syncMessage (Note to Self / messages synced from other devices)
		if (!body && env.syncMessage && typeof env.syncMessage === "object") {
			const sm = env.syncMessage as Record<string, unknown>;
			// Note to Self: body is in syncMessage.sentMessage.message
			if (sm.sentMessage && typeof sm.sentMessage === "object") {
				const sentMsg = sm.sentMessage as Record<string, unknown>;
				body =
					(sentMsg.message as string | undefined) ||
					(sentMsg.body as string | undefined);
				if (body) isNoteToSelf = true;
			}
			// Fallback: direct body on syncMessage (some sync events)
			if (!body) {
				body =
					(sm.body as string | undefined) || (sm.message as string | undefined);
			}
		}
		if (!body || typeof body !== "string" || body.trim() === "") return null;

		// Extract message timestamp
		let timestamp: number = 0;
		if (env.dataMessage && typeof env.dataMessage === "object") {
			timestamp =
				((env.dataMessage as Record<string, unknown>).timestamp as number) || 0;
		}
		// For sync messages, get timestamp from sentMessage
		if (
			!timestamp &&
			isNoteToSelf &&
			env.syncMessage &&
			typeof env.syncMessage === "object"
		) {
			const sm = env.syncMessage as Record<string, unknown>;
			if (sm.sentMessage && typeof sm.sentMessage === "object") {
				timestamp =
					((sm.sentMessage as Record<string, unknown>).timestamp as number) ||
					0;
			}
		}

		// Extract sender number
		// For Note to Self messages, sender is the account itself
		let number = "unknown";
		if (isNoteToSelf && PI_SIGNAL_ACCOUNT) {
			number = PI_SIGNAL_ACCOUNT;
		} else if (typeof env.sourceNumber === "string") {
			number = env.sourceNumber;
		} else if (typeof env.source === "string") {
			number = env.source;
		}

		// Extract sender display name
		let sender: string = number;
		if (isNoteToSelf) {
			sender = "Self";
		} else if (typeof env.sourceName === "string" && env.sourceName) {
			sender = env.sourceName;
		}

		return { sender, number, body: body.trim(), timestamp };
	}

	function injectMessage(parsed: {
		sender: string;
		number: string;
		body: string;
		timestamp: number;
	}) {
		// Only process Note-to-Self messages (from own account)
		if (parsed.number !== PI_SIGNAL_ACCOUNT) {
			console.log(
				`[signal] ignoring message from ${parsed.number} (not PI_SIGNAL_ACCOUNT)`,
			);
			return;
		}

		// Track sender context for auto-response
		currentSignalSender = {
			number: parsed.number,
			sender: parsed.sender,
			timestamp: parsed.timestamp,
		};

		// Send 👀 reaction immediately on received message
		if (parsed.timestamp) {
			pendingReaction = {
				recipient: parsed.number,
				targetAuthor: parsed.number,
				timestamp: parsed.timestamp,
			};
			sendReaction(parsed.number, parsed.number, parsed.timestamp, "👀").then(
				(ok) => {
					if (!ok) console.error("[signal] failed to send 👀 reaction");
				},
			);
		}

		const formatted = `[Signal from ${parsed.sender} (${parsed.number})]: ${parsed.body}`;
		pi.sendUserMessage(formatted, { deliverAs: "followUp" });
	}

	// ── Daemon JSON-RPC helpers ──────────────────────────────────────

	/** Call the signal-cli daemon JSON-RPC API. */
	async function daemonRpc(
		method: string,
		params: Record<string, unknown>,
	): Promise<{ ok: boolean; result?: unknown; error?: unknown }> {
		const payload = JSON.stringify({
			jsonrpc: "2.0",
			method,
			params,
			id: Date.now(),
		});
		const result = await pi.exec(
			"curl",
			[
				"-s",
				"-f",
				"-X",
				"POST",
				`${SIGNAL_DAEMON_URL}/api/v1/rpc`,
				"-H",
				"Content-Type: application/json",
				"-d",
				payload,
				"--max-time",
				"15",
			],
			{ timeout: 20_000 },
		);
		if (result.code !== 0) return { ok: false };
		try {
			const json = JSON.parse(result.stdout);
			if (json.error) return { ok: false, error: json.error };
			return { ok: true, result: json.result };
		} catch {
			return { ok: false };
		}
	}

	/** Send an emoji reaction to a Signal message. */
	async function sendReaction(
		destination: string,
		targetAuthor: string,
		timestamp: number,
		emoji: string,
	): Promise<boolean> {
		if (!PI_SIGNAL_ACCOUNT) return false;

		// Use JSON-RPC API (CLI deadlocks on config lock held by daemon)
		const res = await daemonRpc("sendReaction", {
			recipient: destination,
			targetAuthor: targetAuthor,
			targetTimestamp: timestamp,
			emoji,
		});
		return res.ok;
	}

	/** Remove all reactions from a Signal message. */
	async function removeReaction(
		destination: string,
		targetAuthor: string,
		timestamp: number,
	): Promise<boolean> {
		if (!PI_SIGNAL_ACCOUNT) return false;

		// Use JSON-RPC API with remove flag
		const res = await daemonRpc("sendReaction", {
			recipient: destination,
			targetAuthor: targetAuthor,
			targetTimestamp: timestamp,
			emoji: "\u200b", // empty marker — remove=true handles it
			remove: true,
		});
		return res.ok;
	}

	// ── Native mode: file watcher ─────────────────────────────────────

	async function startNativeMode(_ctx: unknown): Promise<void> {
		// Skip if not the primary instance
		if (!PI_SIGNAL_PRIMARY) {
			console.log(
				"[signal] PI_SIGNAL_PRIMARY is not set — skipping Signal listener (another instance handles it).",
			);
			return;
		}

		const logPath = await ensureLogfile();

		try {
			lastPosition = fs.statSync(logPath).size;
		} catch {
			lastPosition = 0;
		}

		const onWatchEvent = async () => {
			try {
				if (!fs.existsSync(logPath)) return;
				const content = fs.readFileSync(logPath, "utf8");
				if (content.length <= lastPosition) {
					lastPosition = 0;
				}
				const newContent = content.slice(lastPosition);
				lastPosition = content.length;
				if (!newContent.trim()) return;

				for (const line of newContent.split("\n")) {
					if (!line.trim()) continue;
					const parsed = parseEnvelope(line);
					if (parsed) injectMessage(parsed);
				}
			} catch (err) {
				console.error("[signal] processNewLines error:", err);
			}
		};

		try {
			fileWatcher = fs.watch(logPath, onWatchEvent);
		} catch (err) {
			console.error("[signal] failed to create watcher:", err);
		}

		// Notify if the systemd service is not running
		const result = await pi.exec("systemctl", [
			"is-active",
			"signal-receive.service",
		]);
		if (result.code !== 0) {
			if (_ctx && typeof _ctx === "object" && "ui" in _ctx) {
				(_ctx as Record<string, unknown>).ui?.notify?.(
					"signal-receive.service is not running. Run /signal-start to start it, or see /signal-setup.",
					"warning",
				);
			}
		}
	}

	// ── Send response back to Signal ──────────────────────────────

	/**
	 * Send a text message back to Signal via the daemon JSON-RPC API.
	 * Used for auto-replying with the agent's response.
	 *
	 * Color note (Note-to-Self): signal-cli has two delivery paths when the
	 * recipient is self. The default (notifySelf omitted / false) wraps the
	 * message in a SentTranscriptMessage and sends it as a
	 * SignalServiceSyncMessage — your phone renders that as a synced message
	 * from another linked device, i.e. **grey**. Setting notifySelf: true
	 * sends a normal outgoing dataMessage instead, which renders **blue**.
	 *
	 * We always want grey for auto-replies so the conversation reads as
	 * alternating sides. `noteToSelf: true` is used instead of `recipient`
	 * because it makes the self-routing explicit (signal-cli doesn't have to
	 * run the RecipientAddress.matches() self-check).
	 *
	 * Prerequisite: the Signal phone app must be a separate linked device
	 * from the daemon. If you only have one device, `sendSelfMessage` in
	 * signal-cli's SendHelper is a no-op (`!account.isMultiDevice()` guard)
	 * and the message will fall through to the normal outgoing path (blue).
	 */
	async function sendToSignal(
		_recipient: string,
		message: string,
	): Promise<boolean> {
		if (!message || !message.trim()) return false;

		// Truncate very long messages (Signal limit is ~8000 chars)
		const maxLen = 7800;
		let text = message.trim();
		if (text.length > maxLen) {
			text =
				text.slice(0, maxLen) +
				"\n\n[truncated — response too long for Signal]";
		}

		// Force the sync-message path so replies show up grey (synced from
		// another device) instead of blue (outgoing from your own number).
		const res = await daemonRpc("send", {
			noteToSelf: true,
			message: text,
			notifySelf: false,
		});
		return res.ok;
	}

	// ── Lifecycle ─────────────────────────────────────────────────────

	pi.on("session_start", async (_event: unknown, ctx: unknown) => {
		await startNativeMode(ctx);
	});

	// Auto-send agent responses back to Signal
	pi.on("agent_end", async (event: unknown) => {
		if (!currentSignalSender) return;

		const sender = currentSignalSender;
		currentSignalSender = null;

		try {
			// Extract assistant messages from this turn
			const messages =
				(event as { messages?: Array<{ role?: string; content?: unknown }> })
					.messages ?? [];
			const assistantMessages = messages.filter((m) => m.role === "assistant");

			if (assistantMessages.length === 0) return;

			// Combine all assistant text content
			const textParts: string[] = [];
			for (const msg of assistantMessages) {
				const content = msg.content;
				if (typeof content === "string") {
					textParts.push(content);
				} else if (Array.isArray(content)) {
					for (const part of content) {
						if (
							part &&
							typeof part === "object" &&
							(part as { type?: string }).type === "text"
						) {
							const text = (part as { text?: string }).text;
							if (text) textParts.push(text);
						}
					}
				}
			}

			const fullText = textParts.join("\n").trim();
			if (!fullText) return;

			const ok = await sendToSignal(sender.number, fullText);
			if (ok) {
				console.log(`[signal] auto-reply sent to ${sender.number}`);
				// Swap 👀 → ✅
				if (sender.timestamp) {
					await removeReaction(sender.number, sender.number, sender.timestamp);
					await sendReaction(
						sender.number,
						sender.number,
						sender.timestamp,
						"✅",
					);
				}
			} else {
				console.error(`[signal] failed to auto-reply to ${sender.number}`);
				if (sender.timestamp) {
					await removeReaction(sender.number, sender.number, sender.timestamp);
					await sendReaction(
						sender.number,
						sender.number,
						sender.timestamp,
						"❌",
					);
				}
			}
		} catch (err) {
			console.error("[signal] auto-reply error:", err);
		}
	});

	pi.on("session_shutdown", async () => {
		if (fileWatcher) {
			fileWatcher.close();
			fileWatcher = null;
		}
	});

	// ── Tool: signal_send ──────────────────────────────────────────

	pi.registerTool({
		name: "signal_send",
		label: "Signal Send",
		description:
			"Send a text message to a Signal user. " +
			"Recipient must be a phone number in E.164 format, e.g. +1234567890. " +
			"Uses the signal-cli daemon JSON-RPC API.",
		parameters: Type.Object({
			recipient: Type.String({
				description:
					"Recipient phone number in E.164 format, e.g. +1234567890. Include the leading +.",
			}),
			message: Type.String({ description: "The message text to send." }),
		}),
		async execute(
			_toolCallId: string,
			params: { recipient: string; message: string },
			_signal?: AbortSignal,
		) {
			const cleaned = params.recipient.replace(/[\s\-().]/g, "");
			if (!/^\+[1-9]\d{1,14}$/.test(cleaned)) {
				throw new Error(
					`Invalid recipient "${params.recipient}". Must be E.164 format, e.g. +1234567890.`,
				);
			}

			// Force `notifySelf: false` so that if the recipient is the user
			// themselves (Note-to-Self), signal-cli takes the sync-message path
			// (grey) rather than the outgoing path (blue). For other
			// recipients `notifySelf` has no effect.
			const res = await daemonRpc("send", {
				recipient: cleaned,
				message: params.message,
				notifySelf: false,
			});
			if (!res.ok) {
				throw new Error(
					`Signal daemon send failed: ${JSON.stringify(res.error || "unknown error")}`,
				);
			}

			// Update reaction: 👀 → ✅
			if (pendingReaction) {
				const pr = pendingReaction;
				pendingReaction = null;
				removeReaction(pr.recipient, pr.targetAuthor, pr.timestamp)
					.then(() => {
						sendReaction(
							pr.recipient,
							pr.targetAuthor,
							pr.timestamp,
							"✅",
						).catch(() => {});
					})
					.catch(() => {});
			}

			// Clear signal sender context to prevent agent_end auto-reply
			// from also sending (would cause duplicate messages)
			currentSignalSender = null;

			return {
				content: [{ type: "text", text: `Message sent to ${cleaned}.` }],
				details: {
					recipient: cleaned,
					message: params.message,
				},
			};
		},
	});

	// ── Tool: signal_status ───────────────────────────────────────

	pi.registerTool({
		name: "signal_status",
		label: "Signal Status",
		description:
			"Check whether signal-cli is installed, the daemon is running, " +
			"and the incoming-message log file is being written.",
		parameters: Type.Object({}),
		async execute(
			_toolCallId: string,
			_params: Record<string, unknown>,
			_signal?: AbortSignal,
		) {
			const lines: string[] = [];

			lines.push(`Account: ${PI_SIGNAL_ACCOUNT || "(not set)"}`);

			// Check signal-cli binary
			const cli = await pi.exec("which", ["signal-cli"], { timeout: 5_000 });
			lines.push(
				`signal-cli binary: ${cli.code === 0 ? `✓ ${cli.stdout.trim()}` : "✗ NOT installed"}`,
			);

			// Check daemon HTTP API
			if (SIGNAL_DAEMON_URL) {
				const daemon = await daemonRpc("version", {});
				lines.push(
					`daemon API (${SIGNAL_DAEMON_URL}): ${daemon.ok ? `✓ v${(daemon.result as { version?: string })?.version || "?"}` : "✗ not reachable"}`,
				);
			}

			// Check incoming log
			const logPath = getLogPath();
			if (fs.existsSync(logPath)) {
				const stats = fs.statSync(logPath);
				lines.push(`incoming.log: ${stats.size} bytes (${logPath})`);
			} else {
				lines.push(`incoming.log: not found at ${logPath}`);
			}

			return {
				content: [{ type: "text", text: lines.join("\n") }],
				details: { lines },
			};
		},
	});

	// ── Command: /signal-setup ─────────────────────────────────

	pi.registerCommand("signal-setup", {
		description:
			"Interactive setup wizard for Signal ↔ pi integration",
		async handler(_args: string, ctx: unknown) {
			const extensionCtx = ctx as {
				ui?: {
					notify: (msg: string, level: string) => void;
					confirm: (title: string, msg: string) => Promise<boolean>;
				};
			};

			extensionCtx.ui?.notify?.("Starting Signal setup wizard…", "info");
			await setupNativeMode(extensionCtx);
		},
	});

	// ── Command: /signal-start ──────────────────────────────

	pi.registerCommand("signal-start", {
		description:
			"Start the Signal message-receive systemd service",
		async handler(_args: string, ctx: unknown) {
			const extensionCtx = ctx as {
				ui?: { notify: (msg: string, level: string) => void };
			};

			const result = await pi.exec(
				"sudo",
				["systemctl", "start", "signal-receive.service"],
				{ timeout: 15_000 },
			);
			if (result.code === 0) {
				extensionCtx.ui?.notify?.("signal-receive.service started.", "info");
			} else {
				extensionCtx.ui?.notify?.(
					`Failed to start service: ${result.stderr || result.stdout}`,
					"error",
				);
			}
		},
	});

	// ── Command: /signal-stop ───────────────────────────────

	pi.registerCommand("signal-stop", {
		description: "Stop the Signal message-receive systemd service",
		async handler(_args: string, ctx: unknown) {
			const extensionCtx = ctx as {
				ui?: { notify: (msg: string, level: string) => void };
			};

			const result = await pi.exec(
				"sudo",
				["systemctl", "stop", "signal-receive.service"],
				{ timeout: 15_000 },
			);
			if (result.code === 0) {
				extensionCtx.ui?.notify?.("signal-receive.service stopped.", "info");
			} else {
				extensionCtx.ui?.notify?.(
					`Failed to stop service: ${result.stderr || result.stdout}`,
					"error",
				);
			}
		},
	});

	// ── Command: /signal-status ──────────────────────────────

	pi.registerCommand("signal-status", {
		description:
			"Show Signal integration status (account, service health)",
		async handler(_args: string, ctx: unknown) {
			const extensionCtx = ctx as {
				ui?: { notify: (msg: string, level: string) => void };
			};
			const statusLines: string[] = [];

			const cli = await pi.exec("which", ["signal-cli"], { timeout: 5_000 });
			statusLines.push(
				`signal-cli: ${cli.code === 0 ? "✓ " + cli.stdout.trim() : "✗ NOT installed"}`,
			);

			if (SIGNAL_DAEMON_URL) {
				const daemon = await daemonRpc("version", {});
				statusLines.push(
					`daemon API (${SIGNAL_DAEMON_URL}): ${daemon.ok ? `✓ v${(daemon.result as { version?: string })?.version || "?"}` : "✗ not reachable"}`,
				);
			}

			const logExists = fs.existsSync(getLogPath());
			const logSize = logExists ? fs.statSync(getLogPath()).size : 0;
			statusLines.push(
				`incoming.log: ${logExists ? `${logSize} bytes` : "not found"}`,
			);

			const msg = [
				`Account: ${PI_SIGNAL_ACCOUNT || "(not set)"}`,
				``,
				...statusLines,
			].join("\n");

			extensionCtx.ui?.notify?.(msg, "info");
		},
	});

	// ── Setup helpers ──────────────────────────────────────────────────

	async function setupNativeMode(ctx: {
		notify?: (msg: string, level: string) => void;
		confirm?: (title: string, msg: string) => Promise<boolean>;
	}): Promise<void> {
		// Step 1: Check Java 25+
		const javaCheck = await pi.exec("java", ["-version"], { timeout: 5_000 });
		if (javaCheck.code !== 0) {
			ctx.notify?.(
				"Java 25+ is required. Install it: https://adoptium.net/",
				"error",
			);
			return;
		}
		ctx.notify?.("✓ Java is installed", "info");

		// Step 2: Check signal-cli
		const cliCheck = await pi.exec("which", ["signal-cli"], { timeout: 5_000 });
		if (cliCheck.code !== 0) {
			ctx.notify?.(
				"signal-cli not found. It will be downloaded from GitHub releases.\n" +
					"  See: https://github.com/AsamK/signal-cli/wiki/Quickstart",
				"info",
			);
			ctx.notify?.(
				"Run:  bash scripts/setup.sh  to download signal-cli and create the systemd service.",
				"info",
			);
		} else {
			ctx.notify?.(
				`✓ signal-cli is installed: ${cliCheck.stdout.trim()}`,
				"info",
			);
		}

		// Step 3: Link device
		const linked = await ctx.confirm?.(
			"Link Signal device?",
			"Does your Signal account already have this pi instance linked? (If not, we can generate a linking URI.)",
		);
		if (!linked) {
			ctx.notify?.(
				"Run:  signal-cli -a +YOUR_NUMBER link -n pi\n" +
					"Then open the sgnl:// URI on your phone and confirm.",
				"info",
			);
		}

		// Step 4: Set up systemd service
		const svcStatus = await pi.exec(
			"systemctl",
			["is-active", "signal-receive.service"],
			{
				timeout: 5_000,
			},
		);
		if (svcStatus.code !== 0) {
			ctx.notify?.(
				"The signal-receive service is not running.\n" +
					"  Run:  bash scripts/setup.sh  to create and start the systemd service.",
				"warning",
			);
		} else {
			ctx.notify?.("✓ signal-receive.service is already running", "info");
		}

		ctx.notify?.("✓ Setup complete!", "info");
	}
}