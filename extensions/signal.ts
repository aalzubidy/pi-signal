// @ts-nocheck
// TypeScript types are provided by pi at runtime via jiti.
// This extension uses runtime-only imports; type checking is skipped.

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import * as http from "node:http";

// ── Configuration ─────────────────────────────────────────────────────

const PI_SIGNAL_ACCOUNT = process.env.PI_SIGNAL_ACCOUNT || "";

// The daemon exposes a JSON-RPC API for sends and an SSE endpoint for receives.
// Uses in-memory SSE streaming — no log file on disk (more secure).
const SIGNAL_DAEMON_URL =
	process.env.PI_SIGNAL_DAEMON_URL || "http://127.0.0.1:8080";

// When running multiple pi instances, only the primary instance should
// process Signal messages. Set PI_SIGNAL_PRIMARY=true on the instance
// that should handle Signal. All other instances ignore incoming messages.
const PI_SIGNAL_PRIMARY =
	process.env.PI_SIGNAL_PRIMARY === "true" ||
	process.env.PI_SIGNAL_PRIMARY === "1" ||
	process.env.PI_SIGNAL_PRIMARY === "yes";

// Default stats mode: "off" | "short" | "full"
const DEFAULT_STATS_MODE = (
	process.env.PI_SIGNAL_STATS || "short"
).toLowerCase();

// SSE reconnect backoff parameters (mirrors hermes-agent)
const SSE_RETRY_DELAY_INITIAL = 2000; // ms
const SSE_RETRY_DELAY_MAX = 60_000; // ms

// ── Extension ──────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
	// SSE stream state
	let sseRequest: http.ClientRequest | null = null;
	let sseReconnectTimer: ReturnType<typeof setTimeout> | null = null;
	let sseReconnectDelay = SSE_RETRY_DELAY_INITIAL;
	let sseConnected = false;

	// Resolved Signal UUID (ACI) for our own account — resolves from
	// phone number to UUID at startup via listContacts RPC. Using the
	// UUID rather than the raw phone number in recipient triggers
	// signal-cli's sendSelfMessage() path → grey (synced) bubbles.
	let resolvedAccountId: string | null = null;

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

	// ── Feature state ────────────────────────────────────────────────

	/** Stored extension context (captured from session_start) for command handling */
	let extCtx: ExtensionContext | null = null;

	/** Stats verbosity mode. Can be changed via /stats command. */
	let statsMode: "off" | "short" | "full" =
		DEFAULT_STATS_MODE === "full" ? "full"
		: DEFAULT_STATS_MODE === "off" ? "off"
		: "short";

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

	// ── Command Handlers ────────────────────────────────────────────

	/** Build a stats footer string for the current context. */
	function buildStatsFooter(
		ctx: ExtensionContext | null,
	): string {
		if (!ctx || statsMode === "off") return "";

		const usage = ctx.getContextUsage?.();
		const model = ctx.model;
		const modelName = model?.name || model?.id || "unknown";
		const provider = model?.provider || "";

		const tokensIn = usage?.tokens != null ? usage.tokens : null;
		const ctxWindow = usage?.contextWindow || null;
		const pct = usage?.percent != null ? usage.percent : null;

		if (statsMode === "short") {
			// e.g. "───\nClaude Sonnet 4 · 1.2K ctx · 24%"
			const parts: string[] = [modelName];
			if (tokensIn != null) {
				parts.push(formatTokens(tokensIn) + " ctx");
			}
			if (pct != null) {
				parts.push(Math.round(pct) + "%");
			}
			return "\n───\n" + parts.join(" · ");
		}

		// Full mode
		const lines: string[] = ["───"];
		lines.push(`Model: ${modelName}${provider ? " (" + provider + ")" : ""}`);
		if (tokensIn != null) {
			lines.push(`Context: ${tokensIn.toLocaleString()} tokens`);
		}
		if (ctxWindow != null) {
			lines.push(`Window: ${ctxWindow.toLocaleString()} tokens`);
		}
		if (pct != null) {
			lines.push(`Usage: ${Math.round(pct)}%`);
		}
		return "\n" + lines.join("\n");
	}

	function formatTokens(n: number): string {
		if (n >= 1000) return (n / 1000).toFixed(1) + "K";
		return String(n);
	}

	/** Simple Levenshtein distance between two strings. */
	function levenshtein(a: string, b: string): number {
		const m = a.length;
		const n = b.length;
		const dp: number[][] = [];
		for (let i = 0; i <= m; i++) {
			dp[i] = [i];
		}
		for (let j = 0; j <= n; j++) {
			dp[0][j] = j;
		}
		for (let i = 1; i <= m; i++) {
			for (let j = 1; j <= n; j++) {
				dp[i][j] = a[i - 1] === b[j - 1]
					? dp[i - 1][j - 1]
					: Math.min(dp[i - 1][j - 1], dp[i][j - 1], dp[i - 1][j]) + 1;
			}
		}
		return dp[m][n];
	}

	/**
	 * Fuzzy-match a partial query against a list of model labels.
	 * Returns sorted matches with scores (0 = exact, higher = worse).
	 */
	function fuzzyMatchModels(
		query: string,
		models: Array<{ label: string; model: unknown }>,
	): Array<{ label: string; model: unknown; score: number }> {
		const q = query.toLowerCase().trim();
		if (!q) return [];

		const scored: Array<{ label: string; model: unknown; score: number }> = [];

		for (const entry of models) {
			const label = entry.label.toLowerCase();
			let score = Infinity;

			// Exact match (case-insensitive)
			if (label === q) {
				score = 0;
			} else if (label.includes(q)) {
		// Substring match — strong signal with slight position bonus
		const pos = label.indexOf(q);
		score = 0.02 + (pos / Math.max(label.length, 1)) * 0.05;
			} else {
				// Levenshtein distance normalized by max length
				const dist = levenshtein(label, q);
				const maxLen = Math.max(label.length, q.length);
				score = dist / Math.max(maxLen, 1);
			}

			scored.push({ label: entry.label, model: entry.model, score });
		}

		// Sort by score ascending, then by label length (prefer shorter matches)
		scored.sort((a, b) => {
			if (a.score !== b.score) return a.score - b.score;
			return a.label.length - b.label.length;
		});

		return scored;
	}

	/** Get all available models from context, formatted as {label, model} entries. */
	function getModelList(ctx: ExtensionContext): Array<{ label: string; model: unknown }> {
		const registry = ctx.modelRegistry;
		if (!registry || typeof registry.getAll !== "function") return [];

		try {
			const models = registry.getAll() as Array<{
				provider?: string;
				id?: string;
				name?: string;
			}>;
			return models.map((m) => ({
				label: `${m.name || m.id || "unknown"} (${m.provider || "?"}/${m.id || "?"})`,
				model: m,
			}));
		} catch {
			return [];
		}
	}

	/** Handle a Signal message that is a command (/model, /abort, /clear, /stats). */
	async function handleCommand(
		parsed: { sender: string; number: string; body: string; timestamp: number },
		cmd: string,
		args: string[],
	): Promise<void> {
		const ctx = extCtx;
		if (!ctx) {
			// Can't handle commands without context — forward to LLM
			forwardToAgent(parsed);
			return;
		}

		const reply = (text: string) => {
			currentSignalSender = {
				number: parsed.number,
				sender: parsed.sender,
				timestamp: parsed.timestamp,
			};
			// Use sendToSignal directly since we're handling inline
			sendToSignal(parsed.number, text).then((ok) => {
				if (ok) {
					console.log(`[signal] command reply sent: ${cmd}`);
				} else {
					console.error(`[signal] failed to send command reply: ${cmd}`);
				}
			}).finally(() => {
				currentSignalSender = null;
			});
		};

		switch (cmd) {
			case "model":
				return handleModelCommand(ctx, args, reply);
			case "abort":
				return handleAbortCommand(ctx, parsed, reply);
			case "clear":
				return handleClearCommand(ctx, parsed, reply);
			case "stats":
				return handleStatsCommand(parsed, args, reply);
			case "ping":
				return handlePingCommand(parsed, reply);
			case "help":
				return handleHelpCommand(parsed, reply);
			default:
				// Unknown command — forward to LLM as normal message
				forwardToAgent(parsed);
		}
	}

	/** /model <partial_name> — fuzzy-match and switch model */
	async function handleModelCommand(
		ctx: ExtensionContext,
		args: string[],
		reply: (text: string) => void,
	): Promise<void> {
		const query = args.join(" ").trim();
		if (!query) {
			const current = ctx.model;
			const name = current?.name || current?.id || "unknown";
			reply(`Current model: ${name} (${current?.provider || "?"})\n\nUsage: /model <partial name>\nExamples: /model claude, /model gpt, /model sonnet`);
			return;
		}

		const models = getModelList(ctx);
		if (models.length === 0) {
			reply("No models available. Configure a provider first.");
			return;
		}

		const matches = fuzzyMatchModels(query, models);

		// Check for exact model ID match before fuzzy matching
		const qLower = query.toLowerCase().trim();
		for (const entry of models) {
			const entryObj = entry.model as { id?: string };
			if (entryObj.id && entryObj.id.toLowerCase() === qLower) {
				const ok = await pi.setModel(entry.model as any);
				if (ok) {
					reply(`Switched to ${entry.label}`);
				} else {
					reply(`Failed to switch to ${entry.label}. Check API key configuration.`);
				}
				return;
			}
		}

		// Filter to reasonable matches (score < 0.5)
		const good = matches.filter((m) => m.score < 0.5);
		if (good.length === 0) {
			// Show closest few
			const closest = matches.slice(0, 5);
			const lines = closest.map(
				(m, i) => `${i + 1}. ${m.label}`,
			);
			reply(
				`No close match for "${query}". Did you mean:\n${lines.join("\n")}`,
			);
			return;
		}

		// If exact or very close match (score < 0.15), switch immediately
		const best = good[0];
		if (good.length === 1 && best.score < 0.15) {
			const ok = await pi.setModel(best.model as any);
			if (ok) {
				reply(`Switched to ${best.label}`);
			} else {
				reply(`Failed to switch to ${best.label}. Check API key configuration.`);
			}
			return;
		}

		// Multiple matches — show options
		const show = good.slice(0, 10);
		const lines = show.map((m, i) => `${i + 1}. ${m.label}`);
		reply(
			`Multiple matches for "${query}":\n${lines.join("\n")}\n\nSend a more specific query.`,
		);
	}

	/** /abort — stop the current LLM generation */
	async function handleAbortCommand(
		ctx: ExtensionContext,
		parsed: { sender: string; number: string; body: string; timestamp: number },
		reply: (text: string) => void,
	): Promise<void> {
		if (ctx.isIdle()) {
			reply("Nothing to abort — the agent is idle.");
			return;
		}

		ctx.abort();
		reply("⏹ Response aborted.");

		// Swap 👀 → 🛑 on the original message
		if (parsed.timestamp) {
			await removeReaction(parsed.number, parsed.number, parsed.timestamp);
			await sendReaction(parsed.number, parsed.number, parsed.timestamp, "🛑");
		}
	}

	/** /clear — start a new session */
	async function handleClearCommand(
		ctx: ExtensionContext,
		parsed: { sender: string; number: string; body: string; timestamp: number },
		reply: (text: string) => void,
	): Promise<void> {
		// If currently streaming, abort first
		if (!ctx.isIdle()) {
			ctx.abort();
			// Small wait to let abort settle
			await new Promise((r) => setTimeout(r, 300));
		}

		reply("🧹 Starting new session…");

		try {
			if (typeof (ctx as any).newSession === "function") {
				await (ctx as any).newSession({
					withSession: async (_newCtx: unknown) => {
						console.log("[signal] new session started via /clear");
					},
				});
			} else {
				console.log("[signal] newSession not available on context");
			}
		} catch (err) {
			console.error("[signal] /clear error:", err);
		}
	}

	/** /stats [short|full|off] — view or change stats mode */
	async function handleStatsCommand(
		parsed: { sender: string; number: string; body: string; timestamp: number },
		args: string[],
		reply: (text: string) => void,
	): Promise<void> {
		const arg = args[0]?.toLowerCase();

		if (!arg) {
			// Show current stats mode and usage
			const ctx = extCtx;
			let usageLine = "";
			if (ctx) {
				const usage = ctx.getContextUsage?.();
				if (usage?.percent != null) {
					usageLine = ` · ${Math.round(usage.percent)}% context used`;
				}
			}
			reply(`Stats mode: ${statsMode}${usageLine}\n\nUsage:\n/stats short — enable short stats (default)\n/stats full  — enable full stats\n/stats off   — disable stats`);
			return;
		}

		if (arg === "short" || arg === "full" || arg === "off") {
			statsMode = arg;
			reply(`Stats mode set to: ${arg}`);
		} else {
			reply(`Invalid stats mode "${arg}". Use: short, full, off`);
		}
	}

	/** Forward a message to the LLM agent (normal flow). */
	function forwardToAgent(parsed: {
		sender: string;
		number: string;
		body: string;
		timestamp: number;
	}) {
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

	/** /ping — test connectivity */
	async function handlePingCommand(
		parsed: { sender: string; number: string; body: string; timestamp: number },
		reply: (text: string) => void,
	): Promise<void> {
		reply("pong");
	}

	/** /help — list available commands */
	async function handleHelpCommand(
		parsed: { sender: string; number: string; body: string; timestamp: number },
		reply: (text: string) => void,
	): Promise<void> {
		reply(
			"Available commands:\n" +
			"/model <name> — switch model (fuzzy match)\n" +
			"/abort — stop current generation\n" +
			"/clear — start new session\n" +
			"/stats [short|full|off] — toggle usage stats\n" +
			"/ping — test connectivity\n" +
			"/help — show this help",
		);
	}

	/** Intercept commands from Signal: /model, /abort, /clear, /stats, /ping, /help */
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

		const body = parsed.body.trim();

		// Check for commands
		if (body.startsWith("/")) {
			const parts = body.slice(1).split(/\s+/);
			const cmd = parts[0].toLowerCase();
			const args = parts.slice(1);
			handleCommand(parsed, cmd, args).catch((err) => {
				console.error(`[signal] command error (${cmd}):`, err);
			});
			return;
		}

		// Normal message — forward to agent
		forwardToAgent(parsed);
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

	// ── SSE Listener (in-memory, no log file) ─────────────────────────

	/**
	 * Connect to the signal-cli daemon's SSE endpoint and stream incoming
	 * messages in-memory.  Reconnects automatically with exponential backoff
	 * on connection drops — mirrors hermes-agent's _sse_listener pattern.
	 *
	 * No log file is written — all message processing happens in-memory
	 * for better security.
	 */
	function startSSEListener(): void {
		// Skip if not the primary instance
		if (!PI_SIGNAL_PRIMARY) {
			console.log(
				"[signal] PI_SIGNAL_PRIMARY is not set — skipping SSE listener (another instance handles it).",
			);
			return;
		}

		if (!PI_SIGNAL_ACCOUNT) {
			console.warn("[signal] PI_SIGNAL_ACCOUNT is not set — cannot start SSE listener.");
			return;
		}

		doConnect();
	}

	function doConnect() {
		// Clean up any existing connection
		cleanupSSE();

		const daemonUrl = new URL(SIGNAL_DAEMON_URL);
		const ssePath = `/api/v1/events?account=${encodeURIComponent(PI_SIGNAL_ACCOUNT)}`;

		console.log(`[signal] connecting SSE to ${SIGNAL_DAEMON_URL}${ssePath}`);

		const req = http.get(
			{
				hostname: daemonUrl.hostname,
				port: daemonUrl.port || 8080,
				path: ssePath,
				timeout: 0, // no timeout — stream stays open
			},
			(res) => {
				const statusCode = res.statusCode || 0;

				if (statusCode !== 200) {
					console.error(`[signal] SSE connection failed with status ${statusCode}`);
					res.resume(); // drain the response
					scheduleReconnect();
					return;
				}

				console.log("[signal] SSE connected — listening for incoming messages");
				sseConnected = true;
				sseReconnectDelay = SSE_RETRY_DELAY_INITIAL; // reset backoff

				let buffer = "";

				res.on("data", (chunk: Buffer) => {
					buffer += chunk.toString("utf8");

					// Process complete lines from the buffer
					const lines = buffer.split("\n");
					buffer = lines.pop() || ""; // keep incomplete line in buffer

					for (const line of lines) {
						const trimmed = line.trim();
						if (!trimmed) continue;
						if (trimmed.startsWith(":")) continue; // SSE comment

						// Parse SSE "data:" prefix
						if (trimmed.startsWith("data:")) {
							const data = trimmed.slice(5).trim();
							if (!data) continue;

							const parsed = parseEnvelope(data);
							if (parsed) injectMessage(parsed);
						}
					}
				});

				res.on("end", () => {
					console.log("[signal] SSE stream ended");
					sseConnected = false;
					scheduleReconnect();
				});

				res.on("error", (err) => {
					console.error("[signal] SSE stream error:", err.message);
					sseConnected = false;
					scheduleReconnect();
				});
			},
		);

		req.on("error", (err) => {
			console.error(`[signal] SSE connection error: ${err.message}`);
			sseConnected = false;
			scheduleReconnect();
		});

		req.setTimeout(0); // no timeout

		sseRequest = req;
	}

	function scheduleReconnect() {
		if (sseReconnectTimer) return; // already scheduled

		const delay = sseReconnectDelay;
		console.log(`[signal] reconnecting SSE in ${delay}ms`);

		sseReconnectTimer = setTimeout(() => {
			sseReconnectTimer = null;
			// Exponential backoff, capped at max
			sseReconnectDelay = Math.min(
				sseReconnectDelay * 2,
				SSE_RETRY_DELAY_MAX,
			);
			doConnect();
		}, delay);
	}

	function cleanupSSE() {
		if (sseReconnectTimer) {
			clearTimeout(sseReconnectTimer);
			sseReconnectTimer = null;
		}
		if (sseRequest) {
			sseRequest.destroy();
			sseRequest = null;
		}
		sseConnected = false;
	}

	// ── Account ID resolution ──────────────────────────────────────

	/**
	 * Resolve our own phone number (PI_SIGNAL_ACCOUNT) to a Signal UUID
	 * by calling the listContacts RPC.  Using the UUID (ACI) rather than
	 * the raw phone number in the `recipient` array is the key to getting
	 * signal-cli's `sendSelfMessage()` path to fire, which produces grey
	 * (synced) bubbles instead of blue (outgoing) ones.
	 *
	 * This mirrors what hermes-agent does:
	 * https://github.com/NousResearch/hermes-agent/blob/main/gateway/platforms/signal.py
	 */
	async function resolveAccountId(): Promise<string | null> {
		if (!PI_SIGNAL_ACCOUNT) return null;

		const res = await daemonRpc("listContacts", {
			account: PI_SIGNAL_ACCOUNT,
			allRecipients: true,
		});
		if (!res.ok || !Array.isArray(res.result)) {
			console.log("[signal] listContacts failed — falling back to phone number");
			return null;
		}

		const contacts = res.result as Array<Record<string, unknown>>;
		for (const contact of contacts) {
			const number = contact.number as string | undefined;
			if (number && number === PI_SIGNAL_ACCOUNT) {
				// Try uuid first, then aci (older signal-cli uses "uuid")
				const uuid = (contact.uuid as string) || (contact.aci as string) || null;
				if (uuid) {
					console.log(`[signal] resolved account UUID: ${uuid}`);
					return uuid;
				}
			}
		}

		console.log("[signal] account not found in contacts — falling back to phone number");
		return null;
	}

	// ── Send response back to Signal ──────────────────────────────

	/**
	 * Send a text message back to Signal via the daemon JSON-RPC API.
	 * Used for auto-replying with the agent's response.
	 *
	 * Color note (Note-to-Self): to make replies show up **grey** (as if
	 * synced from another linked device) we send with `recipient` set to
	 * the account number and let signal-cli's own self-detection route the
	 * message through `SendHelper.sendSelfMessage()`. That method wraps the
	 * message in a `SentTranscriptMessage` and delivers it as a
	 * `SignalServiceSyncMessage`, which the phone app renders as grey.
	 *
	 * Do NOT use `noteToSelf` — it bypasses the `sendSelfMessage()` path on
	 * some signal-cli versions and falls through to a normal outgoing
	 * dataMessage, which renders **blue** (as if you typed it).
	 *
	 * Do NOT use `notifySelf: true` — that also forces the outgoing
	 * dataMessage path (blue).
	 *
	 * Prerequisite: the Signal phone app must be a separate linked device
	 * from the daemon (multi-device). If you only have one device,
	 * `sendSelfMessage` in signal-cli's SendHelper is a no-op
	 * (`!account.isMultiDevice()` guard) and the message will fall through
	 * to the normal outgoing path (blue).
	 *
	 * This approach matches what hermes-agent does (see
	 * https://github.com/NousResearch/hermes-agent/blob/main/gateway/platforms/signal.py).
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

		// Use the resolved UUID (if available) so signal-cli's self-detection
		// kicks in and routes through sendSelfMessage → grey (synced) rendering.
		// Include the `account` parameter as signal-cli needs it to know which
		// linked device to act as.
		const targetId = resolvedAccountId || PI_SIGNAL_ACCOUNT;
		const res = await daemonRpc("send", {
			account: PI_SIGNAL_ACCOUNT,
			recipient: [targetId],
			message: text,
		});
		return res.ok;
	}

	// ── Lifecycle ─────────────────────────────────────────────────────

	pi.on("session_start", async (_event: unknown, ctx: unknown) => {
		// Store context for command handlers
		extCtx = ctx as ExtensionContext | null;

		// Resolve our phone number to a Signal UUID so outgoing messages
		// use the recipient-based sync path (grey bubbles instead of blue).
		resolvedAccountId = await resolveAccountId();

		// Start the SSE listener for incoming messages (in-memory)
		startSSEListener();

		// Notify if the systemd service is not running
		const result = await pi.exec("systemctl", [
			"is-active",
			"signal-receive.service",
		]);
		if (result.code !== 0) {
			if (ctx && typeof ctx === "object" && "ui" in ctx) {
				(ctx as Record<string, unknown>).ui?.notify?.(
					"signal-receive.service is not running. Run /signal-start to start it, or see /signal-setup.",
					"warning",
				);
			}
		}
	});

	// Auto-send agent responses back to Signal, with stats footer
	pi.on("agent_end", async (event: unknown, ctx: unknown) => {
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

			let fullText = textParts.join("\n").trim();
			if (!fullText) return;

			// Append stats footer if enabled
			if (statsMode !== "off") {
				const statsFooter = buildStatsFooter(ctx as ExtensionContext | null);
				if (statsFooter) {
					fullText += statsFooter;
				}
			}

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

	pi.on("model_select", async (event: unknown) => {
		const ev = event as { model?: { name?: string; id?: string } };
		if (ev?.model) {
			console.log(
				`[signal] model switched to ${ev.model.name || ev.model.id || "unknown"}`,
			);
		}
	});

	pi.on("session_shutdown", async () => {
		cleanupSSE();
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

			// For self-recipient (Note-to-Self), use the resolved UUID so
			// signal-cli routes through sendSelfMessage → grey (synced)
			// rendering. Always include `account` — signal-cli needs it to
			// identify which linked device to act as.
			const isSelf = cleaned === PI_SIGNAL_ACCOUNT;
			const targetId = isSelf && resolvedAccountId ? resolvedAccountId : cleaned;
			const res = await daemonRpc("send", {
				account: PI_SIGNAL_ACCOUNT,
				recipient: [targetId],
				message: params.message,
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
			"and the SSE stream is connected.",
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

			// Check SSE stream status (in-memory, no log file)
			lines.push(`SSE stream: ${sseConnected ? "✓ connected" : "✗ disconnected"}`);

			// Add stats mode info
			lines.push(`Stats mode: ${statsMode}`);

			return {
				content: [{ type: "text", text: lines.join("\n") }],
				details: { lines },
			};
		},
	});

	// ── Signal Commands (available in TUI) ───────────────────────

	pi.registerCommand("signal-model", {
		description:
			"Switch to a model by fuzzy-matching a partial name. Examples: /signal-model claude, /signal-model sonnet",
		async handler(args: string, ctx: unknown) {
			const extensionCtx = ctx as ExtensionContext;
			const models = getModelList(extensionCtx);
			const query = args.trim();
			if (!query) {
				const current = extensionCtx.model;
				const name = current?.name || current?.id || "unknown";
				(extensionCtx.ui as any)?.notify?.(
					`Current model: ${name} (${current?.provider || "?"})\nUsage: /signal-model <partial name>`,
					"info",
				);
				return;
			}

			const matches = fuzzyMatchModels(query, models);
			const best = matches.find((m) => m.score < 0.15);
			if (best) {
				const ok = await pi.setModel(best.model as any);
				(extensionCtx.ui as any)?.notify?.(
					ok ? `Switched to ${best.label}` : `Failed to switch to ${best.label}`,
					ok ? "info" : "error",
				);
			} else {
				const closest = matches.slice(0, 5).map((m) => m.label).join("\n");
				(extensionCtx.ui as any)?.notify?.(
					`No close match for "${query}". Closest:\n${closest}`,
					"warning",
				);
			}
		},
	});

	pi.registerCommand("signal-abort", {
		description: "Stop the current LLM generation",
		async handler(_args: string, ctx: unknown) {
			const extensionCtx = ctx as ExtensionContext;
			if (extensionCtx.isIdle()) {
				(extensionCtx.ui as any)?.notify?.("Nothing to abort — agent is idle.", "info");
				return;
			}
			extensionCtx.abort();
			(extensionCtx.ui as any)?.notify?.("⏹ Response aborted.", "info");
		},
	});

	pi.registerCommand("signal-stats", {
		description: "View or toggle stats mode. Usage: /signal-stats [short|full|off]",
		async handler(args: string, ctx: unknown) {
			const extensionCtx = ctx as ExtensionContext;
			const arg = args.trim().toLowerCase();
			if (!arg) {
				const usage = extensionCtx.getContextUsage?.();
				const usageLine = usage?.percent != null
					? ` · ${Math.round(usage.percent)}% context used`
					: "";
				(extensionCtx.ui as any)?.notify?.(
					`Stats mode: ${statsMode}${usageLine}`,
					"info",
				);
				return;
			}
			if (arg === "short" || arg === "full" || arg === "off") {
				statsMode = arg;
				(extensionCtx.ui as any)?.notify?.(`Stats mode set to: ${arg}`, "info");
			} else {
				(extensionCtx.ui as any)?.notify?.(
					`Invalid stats mode "${arg}". Use: short, full, off`,
					"error",
				);
			}
		},
	});

	// ── Legacy Commands ─────────────────────────────────────────

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

	pi.registerCommand("signal-stop", {
		description:
			"⚠️ Stop the Signal message-receive systemd service. " +
			"WARNING: pi will no longer receive incoming Signal messages until /signal-start is run.",
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
				extensionCtx.ui?.notify?.(
					"⚠️ signal-receive.service stopped. pi will not receive Signal messages until /signal-start is run.",
					"warning",
				);
			} else {
				extensionCtx.ui?.notify?.(
					`Failed to stop service: ${result.stderr || result.stdout}`,
					"error",
				);
			}
		},
	});

	pi.registerCommand("signal-status", {
		description:
			"Show Signal integration status (account, service health, stats mode)",
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

			statusLines.push(`SSE stream: ${sseConnected ? "✓ connected" : "✗ disconnected"}`);

			statusLines.push(`Stats mode: ${statsMode}`);

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