#!/usr/bin/env node
// fdv-claude-agent — Claude-driven observer for the fdv.lol auto-trader.
//
// Safety-first MVP: read-only + propose-only tools, no live swaps.
// Each "cycle" is a fresh conversation seeded with a tiny state summary.
// The system prompt + tool definitions are cached across cycles via Anthropic
// prompt caching, so per-cycle cost is dominated by the small per-turn input
// plus the model's tool calls and final text.

import process from "node:process";
import Anthropic from "@anthropic-ai/sdk";

import {
	parseCliArgs,
	helpText,
	loadProfile,
	resolveAnthropicKey,
	resolveModel,
	resolveRpcUrl,
	resolveRpcHeaders,
} from "./lib/config.mjs";
import { deriveWalletPubkey, createRpcClient } from "./lib/wallet.mjs";
import { createMarketClient } from "./lib/market.mjs";
import { createState } from "./lib/state.mjs";
import { createBridge } from "./lib/bridge.mjs";
import { TOOL_DEFINITIONS, dispatchTool } from "./lib/tools.mjs";
import { buildSystemPrompt, buildCycleUserMessage } from "./lib/prompt.mjs";

const MAX_TURNS_PER_CYCLE = 10; // hard ceiling so a runaway model can't burn tokens

function log(eventKind, payload, { toConsole }) {
	if (!toConsole) return;
	const ts = new Date().toISOString();
	const line = JSON.stringify({ ts, kind: eventKind, ...payload });
	// eslint-disable-next-line no-console
	console.log(line);
}

async function runOneCycle({ client, model, system, ctx, state, cycle, logEnabled }) {
	const t0 = Date.now();
	const cycleNo = state.nextCycle();

	const userMessage = buildCycleUserMessage({
		cycle: cycleNo,
		walletPubkey: ctx.walletPubkey,
		recentSummary: state.buildRecentSummary({ recentN: 5 }),
		nowIso: new Date().toISOString(),
	});

	// Conversation begins fresh each cycle. Only the system + tools are stable
	// across cycles (and therefore cached).
	const messages = [{ role: "user", content: userMessage }];

	// Per-cycle call budget for rate-limited tools.
	const callBudget = {};
	let usage = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
	let finalText = "";

	for (let turn = 0; turn < MAX_TURNS_PER_CYCLE; turn += 1) {
		const response = await client.messages.create({
			model,
			max_tokens: 1024,
			system,
			tools: TOOL_DEFINITIONS,
			messages,
		});

		// Accumulate usage across the cycle's turns.
		if (response?.usage) {
			usage.input_tokens += response.usage.input_tokens || 0;
			usage.output_tokens += response.usage.output_tokens || 0;
			usage.cache_read_input_tokens += response.usage.cache_read_input_tokens || 0;
			usage.cache_creation_input_tokens += response.usage.cache_creation_input_tokens || 0;
		}

		// Pull the model's text blocks into the running text (final-text comes from
		// the last assistant turn, but earlier turns may include preface text too).
		const textBlocks = response.content.filter((b) => b.type === "text");
		const turnText = textBlocks.map((b) => b.text).join("");
		if (turnText.trim()) finalText = turnText.trim();

		log("turn", { cycle: cycleNo, turn, stop_reason: response.stop_reason, text_chars: turnText.length }, { toConsole: logEnabled });

		if (response.stop_reason === "end_turn") {
			break;
		}

		if (response.stop_reason !== "tool_use") {
			// Unexpected stop reason (max_tokens, refusal, ...). Bail out of the cycle.
			log("unexpected_stop", { cycle: cycleNo, turn, stop_reason: response.stop_reason }, { toConsole: logEnabled });
			break;
		}

		// Append assistant's full content (text + tool_use blocks) to preserve
		// the tool_use IDs that the upcoming tool_result blocks reference.
		messages.push({ role: "assistant", content: response.content });

		// Run all tool_use blocks in parallel.
		const toolUses = response.content.filter((b) => b.type === "tool_use");
		const toolResults = await Promise.all(toolUses.map(async (block) => {
			const startedAt = Date.now();
			try {
				const result = await dispatchTool({
					name: block.name,
					input: block.input,
					ctx,
					callBudget,
				});
				log("tool_ok", {
					cycle: cycleNo,
					turn,
					tool: block.name,
					duration_ms: Date.now() - startedAt,
				}, { toConsole: logEnabled });
				return {
					type: "tool_result",
					tool_use_id: block.id,
					content: result,
				};
			} catch (err) {
				const msg = String(err?.message || err);
				log("tool_err", {
					cycle: cycleNo,
					turn,
					tool: block.name,
					duration_ms: Date.now() - startedAt,
					error: msg,
				}, { toConsole: logEnabled });
				return {
					type: "tool_result",
					tool_use_id: block.id,
					content: `Tool error: ${msg}`,
					is_error: true,
				};
			}
		}));

		messages.push({ role: "user", content: toolResults });
	}

	const durationMs = Date.now() - t0;
	const summary = await state.recordCycleSummary({
		text: finalText || "(no final text emitted)",
		usage,
		model,
		durationMs,
	});

	log("cycle_done", {
		cycle: cycleNo,
		duration_ms: durationMs,
		usage,
		summary_text: summary.text.slice(0, 200),
	}, { toConsole: logEnabled });

	return summary;
}

async function main() {
	let opts;
	try {
		opts = parseCliArgs();
	} catch (e) {
		// eslint-disable-next-line no-console
		console.error(String(e?.message || e));
		process.exit(2);
		return;
	}
	if (opts.help) {
		// eslint-disable-next-line no-console
		console.log(helpText());
		return;
	}

	if (opts.enableTrading) {
		// eslint-disable-next-line no-console
		console.error("--enable-trading is reserved. Live trading is not yet implemented in this MVP. Aborting.");
		process.exit(3);
		return;
	}

	const profile = await loadProfile(opts.profilePath);
	const apiKey = resolveAnthropicKey(profile);
	if (!apiKey) {
		// eslint-disable-next-line no-console
		console.error("Missing Anthropic API key. Set ANTHROPIC_API_KEY in env or agentGaryFullAi.apiKey in the profile.");
		process.exit(4);
		return;
	}

	const model = resolveModel(profile, opts.modelOverride);
	const rpcUrl = resolveRpcUrl(profile);
	const rpcHeaders = resolveRpcHeaders(profile);

	const walletPubkey = deriveWalletPubkey(profile);
	const rpc = createRpcClient({ url: rpcUrl, headers: rpcHeaders });
	const market = createMarketClient();
	const state = createState({ logFilePath: opts.logFile, maxRecent: 20 });
	const bridge = createBridge();

	const client = new Anthropic({ apiKey });

	// System prompt is built once and reused for every cycle so its bytes are
	// stable — required for the cache_control breakpoint to actually hit.
	// We place cache_control on the last (only) system text block; tools render
	// before system, so the cached prefix covers tools + system together.
	const systemText = buildSystemPrompt({ enableTrading: false });
	const system = [{ type: "text", text: systemText, cache_control: { type: "ephemeral" } }];

	const ctx = { rpc, market, state, bridge, walletPubkey };

	log("start", {
		model,
		cycleMs: opts.cycleMs,
		walletPubkey,
		profilePath: opts.profilePath,
		maxCycles: opts.maxCycles || "unbounded",
	}, { toConsole: opts.logToConsole });

	let stopping = false;
	const stop = () => { stopping = true; };
	process.on("SIGINT", stop);
	process.on("SIGTERM", stop);

	let cyclesRun = 0;
	while (!stopping) {
		const cycleStartedAt = Date.now();
		try {
			await runOneCycle({
				client,
				model,
				system,
				ctx,
				state,
				cycle: cyclesRun + 1,
				logEnabled: opts.logToConsole,
			});
		} catch (err) {
			await state.recordError(err);
			log("cycle_error", { cycle: cyclesRun + 1, error: String(err?.message || err) }, { toConsole: opts.logToConsole });
			// Typed retry: rate-limit / overload get a longer back-off; everything else
			// uses the normal cycle interval.
			if (err instanceof Anthropic.RateLimitError || err instanceof Anthropic.InternalServerError) {
				await new Promise((r) => setTimeout(r, Math.max(opts.cycleMs, 60_000)));
			}
		}
		cyclesRun += 1;
		if (opts.maxCycles && cyclesRun >= opts.maxCycles) {
			log("max_cycles_reached", { cyclesRun }, { toConsole: opts.logToConsole });
			break;
		}

		// Sleep up to the configured cadence, but allow SIGINT to break out fast.
		const elapsed = Date.now() - cycleStartedAt;
		const sleepFor = Math.max(0, opts.cycleMs - elapsed);
		if (sleepFor > 0 && !stopping) {
			await new Promise((resolve) => {
				const t = setTimeout(resolve, sleepFor);
				const onStop = () => { clearTimeout(t); resolve(); };
				process.once("SIGINT", onStop);
				process.once("SIGTERM", onStop);
			});
		}
	}

	log("stopped", { cyclesRun }, { toConsole: opts.logToConsole });
}

main().catch((err) => {
	// eslint-disable-next-line no-console
	console.error(String(err?.stack || err?.message || err));
	process.exit(1);
});
