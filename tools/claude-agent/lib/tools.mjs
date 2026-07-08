// Tool definitions exposed to Claude + the dispatcher that executes them.
//
// SAFETY MODEL:
//   - Read-only tools: get_wallet_state, get_market_snapshot, get_token_info,
//     get_trader_state, get_recent_decisions, get_recent_execution_results
//   - Write-but-safe tools: log_observation, propose_buy, propose_sell,
//     append_decision (only write to local log files)
//   - Cowork tools: publish_tuning, request_execute (write to bridge — the
//     trader picks them up and applies its OWN safety policies before any
//     swap happens; the agent never signs or submits transactions itself)
//
// The agent NEVER holds keys for signing. Execution flows through the bridge
// to the deterministic trader, which validates everything against its
// existing safety policies (preflight, slippage, urgent-sell guards, etc.).

import { lamportsToSol } from "./wallet.mjs";

export const TOOL_DEFINITIONS = [
	{
		name: "get_wallet_state",
		description: "Return the auto-wallet's current SOL balance (in SOL, not lamports) and the list of SPL token positions held. Token positions include mint, uiAmount, and decimals. Call this on every cycle where you intend to make a decision. Cheap and fast.",
		input_schema: {
			type: "object",
			properties: {},
			required: [],
		},
	},
	{
		name: "get_market_snapshot",
		description: "Return the top Solana SOL-paired tokens ranked by recent 5-minute momentum, filtered for minimum liquidity ($5k+) and minimum 1-hour volume ($10k+). Each entry includes mint, symbol, priceUsd, liquidityUsd, volumeUsd1h, priceChange5m, priceChange1h, buys5m, sells5m. Call AT MOST ONCE per cycle — cache the result in your reasoning.",
		input_schema: {
			type: "object",
			properties: {
				limit: {
					type: "integer",
					description: "Max number of candidates to return. Default 15, max 30.",
					minimum: 1,
					maximum: 30,
				},
			},
			required: [],
		},
	},
	{
		name: "get_token_info",
		description: "Fetch the canonical DexScreener pair for a specific mint. Returns priceUsd, liquidityUsd, fdvUsd, full 5m/1h/24h price action, buys/sells counts. Call AT MOST 3 TIMES per cycle. Use to drill into a candidate from get_market_snapshot.",
		input_schema: {
			type: "object",
			properties: {
				mint: {
					type: "string",
					description: "Solana mint address (base58, ~32-44 chars).",
				},
			},
			required: ["mint"],
		},
	},
	{
		name: "log_observation",
		description: "Record a short observation in the decision log. Use when conditions are interesting but you don't want to propose an action. Examples: 'Market is quiet, no candidates above $50k 1h volume.' or 'Symbol XYZ is pumping +25% in 5m, watching for entry.'",
		input_schema: {
			type: "object",
			properties: {
				text: {
					type: "string",
					description: "1-2 sentence observation. Will be truncated to 1000 chars.",
				},
			},
			required: ["text"],
		},
	},
	{
		name: "propose_buy",
		description: "Record an intent to buy a mint. In safety mode this DOES NOT execute — it logs the proposal so a human can review later. Use sparingly: only when get_market_snapshot + get_token_info give a strong signal.",
		input_schema: {
			type: "object",
			properties: {
				mint: { type: "string", description: "Mint to buy." },
				sizeSol: {
					type: "number",
					description: "SOL amount to propose buying. Default 0.1–0.3 for safe risk; never above 1.0 without strong reason.",
					minimum: 0.01,
					maximum: 5,
				},
				slippageBps: {
					type: "integer",
					description: "Slippage tolerance in basis points (250 = 2.5%). Default 250. Use 500 only for highly volatile candidates.",
					minimum: 50,
					maximum: 5000,
				},
				reason: {
					type: "string",
					description: "1-2 sentences justifying the proposal. Cite the specific signals (price change, volume, buys/sells ratio).",
				},
				confidence: {
					type: "number",
					description: "0.0–1.0 score reflecting strength of signal.",
					minimum: 0,
					maximum: 1,
				},
			},
			required: ["mint", "sizeSol", "slippageBps", "reason", "confidence"],
		},
	},
	{
		name: "propose_sell",
		description: "Record an intent to sell a fraction of an existing position. In safety mode this DOES NOT execute — it logs the proposal. Only propose sells on mints currently in get_wallet_state.",
		input_schema: {
			type: "object",
			properties: {
				mint: { type: "string", description: "Mint of position to sell (must be currently held)." },
				fraction: {
					type: "number",
					description: "Fraction of the position to sell (0.0–1.0). 1.0 means full exit.",
					minimum: 0.05,
					maximum: 1,
				},
				slippageBps: {
					type: "integer",
					description: "Slippage tolerance in basis points. Default 250.",
					minimum: 50,
					maximum: 5000,
				},
				reason: {
					type: "string",
					description: "1-2 sentences justifying the exit (TP, SL, momentum fade, rug signal).",
				},
				confidence: {
					type: "number",
					description: "0.0–1.0 score.",
					minimum: 0,
					maximum: 1,
				},
			},
			required: ["mint", "fraction", "slippageBps", "reason", "confidence"],
		},
	},
	// ─── Cowork tools (bridge to the deterministic trader) ──────────────
	{
		name: "get_trader_state",
		description: "Read the deterministic trader's current state via the bridge file. Returns {present, stale, ageMs, state}. `present=false` means the trader isn't running. `stale=true` means the trader hasn't updated state recently (>15s); treat as not-coworking. When `state` is present, it includes: pubkey, solBalance, positions[], config (riskLevel/TP/SL/etc.), recentDecisions, pauseTrading, errorRate1m, rpcBackoffMs. Use this to coordinate: don't propose actions on positions the trader is already managing without good reason.",
		input_schema: { type: "object", properties: {}, required: [] },
	},
	{
		name: "publish_tuning",
		description: "Write tuning guidance for the deterministic trader to read on its next loop tick. The trader applies only the SAFE SUBSET (clamps knobs, validates risk level). Use to: (a) shift risk level, (b) tighten/loosen TP/SL during regime shifts, (c) blocklist a mint that looks like a rug, (d) emergency pause. NOT for: raising buy ceilings (impossible — that requires a profile change), forcing buys (use request_execute for that). Each call increments a version counter; the trader ignores duplicates.",
		input_schema: {
			type: "object",
			properties: {
				riskLevel: {
					type: "string",
					enum: ["safe", "medium", "degen"],
					description: "Override the trader's risk preset. Omit to leave unchanged.",
				},
				watchlist: {
					type: "array",
					items: { type: "string" },
					description: "Mints the trader should prioritize considering. Max 20. Just a hint — does not force buys.",
				},
				blocklist: {
					type: "array",
					items: { type: "string" },
					description: "Mints the trader must NOT buy. Max 200. Only restrictive, never expansive.",
				},
				knobs: {
					type: "object",
					description: "Trader knob overrides. Each value is clamped to safe bounds. Supported: takeProfitPct (1-100), stopLossPct (2-50), trailPct (0.5-20), slippageBps (50-1000).",
					properties: {
						takeProfitPct: { type: "number" },
						stopLossPct: { type: "number" },
						trailPct: { type: "number" },
						slippageBps: { type: "integer" },
					},
				},
				pauseTrading: {
					type: "boolean",
					description: "Set true to halt new trader buys (existing positions still managed). Set false to resume. Omit to leave unchanged.",
				},
				reason: {
					type: "string",
					description: "1-2 sentences explaining why. Appears in the trader's logs.",
				},
			},
			required: ["reason"],
		},
	},
	{
		name: "request_execute",
		description: "Queue an execution request for the deterministic trader to consider. The trader picks it up only when started with --accept-claude-execution, and even then runs the request through ALL its safety policies (preflight, slippage adjust, urgent-sell guards) before any swap. Use sparingly and only when you have a strong, well-justified setup. Request expires after `ttlSecs` (default 60s, max 300s) — by design, stale conviction shouldn't execute.",
		input_schema: {
			type: "object",
			properties: {
				action: { type: "string", enum: ["buy", "sell"], description: "buy or sell" },
				mint: { type: "string", description: "Target mint" },
				sizeSol: { type: "number", description: "For buy only. SOL amount to commit. Range: 0.01–5.0. Trader may shrink based on its own caps." },
				fraction: { type: "number", description: "For sell only. Fraction of held position. Range: (0, 1]." },
				slippageBps: { type: "integer", description: "Slippage tolerance bps. Default 250. Trader may raise under backoff.", minimum: 50, maximum: 5000 },
				reason: { type: "string", description: "1-3 sentences. Cite specific signals." },
				confidence: { type: "number", minimum: 0, maximum: 1 },
				ttlSecs: { type: "integer", description: "How long this request is valid. Default 60, max 300.", minimum: 5, maximum: 300 },
			},
			required: ["action", "mint", "slippageBps", "reason", "confidence"],
		},
	},
	{
		name: "get_recent_decisions",
		description: "Read recent entries from the shared decision log (both this agent's own decisions and the trader's Agent Gary decisions). Use to: avoid contradicting yourself, learn from recent outcomes, see what the trader has been doing autonomously. Returns up to N most recent entries (default 20).",
		input_schema: {
			type: "object",
			properties: {
				limit: { type: "integer", minimum: 1, maximum: 100, description: "Max entries to return. Default 20." },
			},
			required: [],
		},
	},
	{
		name: "get_recent_execution_results",
		description: "Read recent outcomes from execution requests the trader has processed. Each entry: {id, outcome, txSig, error, appliedBps, executedSol, notes}. outcome is one of: executed, rejected, expired, policy_blocked. Use after request_execute to learn whether the trader took the action.",
		input_schema: {
			type: "object",
			properties: {
				limit: { type: "integer", minimum: 1, maximum: 100, description: "Max entries to return. Default 20." },
			},
			required: [],
		},
	},
];

// dispatchTool executes a tool by name. Returns a string result. Throwing here
// is fine — run.mjs catches and packages as a tool_result with is_error: true.
export async function dispatchTool({ name, input, ctx, callBudget }) {
	const ipt = input && typeof input === "object" ? input : {};
	switch (name) {
		case "get_wallet_state": {
			const lamports = await ctx.rpc.getSolBalanceLamports(ctx.walletPubkey);
			const tokens = await ctx.rpc.getTokenAccountsByOwner(ctx.walletPubkey).catch(() => []);
			return JSON.stringify({
				pubkey: ctx.walletPubkey,
				solBalance: lamportsToSol(lamports),
				positions: tokens.map((t) => ({
					mint: t.mint,
					uiAmount: t.uiAmount,
					decimals: t.decimals,
				})),
				positionCount: tokens.length,
			});
		}

		case "get_market_snapshot": {
			if ((callBudget.get_market_snapshot || 0) >= 1) {
				throw new Error("get_market_snapshot already called this cycle (limit: 1)");
			}
			callBudget.get_market_snapshot = (callBudget.get_market_snapshot || 0) + 1;
			const limit = Math.min(30, Math.max(1, Number(ipt.limit) || 15));
			const candidates = await ctx.market.getTopSolanaCandidates({ limit });
			return JSON.stringify({
				count: candidates.length,
				candidates: candidates.map((c) => ({
					mint: c.mint,
					symbol: c.symbol,
					priceUsd: c.priceUsd,
					liquidityUsd: c.liquidityUsd,
					volumeUsd1h: c.volumeUsd1h,
					priceChange5m: c.priceChange5m,
					priceChange1h: c.priceChange1h,
					buys5m: c.buys5m,
					sells5m: c.sells5m,
				})),
			});
		}

		case "get_token_info": {
			const used = callBudget.get_token_info || 0;
			if (used >= 3) {
				throw new Error("get_token_info already called 3 times this cycle (limit: 3)");
			}
			callBudget.get_token_info = used + 1;
			const mint = String(ipt.mint || "").trim();
			if (!mint) throw new Error("mint is required");
			const info = await ctx.market.getTokenInfo(mint);
			if (!info) return JSON.stringify({ found: false, mint });
			return JSON.stringify({ found: true, ...info });
		}

		case "log_observation": {
			const text = String(ipt.text || "").trim();
			if (!text) throw new Error("text is required");
			await ctx.state.recordObservation(text);
			return JSON.stringify({ ok: true, recorded: text.slice(0, 200) });
		}

		case "propose_buy": {
			const mint = String(ipt.mint || "").trim();
			if (!mint) throw new Error("mint is required");
			const sizeSol = Number(ipt.sizeSol);
			if (!Number.isFinite(sizeSol) || sizeSol <= 0) throw new Error("sizeSol must be a positive number");
			const slippageBps = Math.floor(Number(ipt.slippageBps));
			if (!Number.isFinite(slippageBps) || slippageBps < 50) throw new Error("slippageBps must be ≥ 50");
			const proposal = await ctx.state.recordProposal({
				actionType: "buy",
				mint,
				sizeSol,
				reason: ipt.reason,
				confidence: ipt.confidence,
			});
			return JSON.stringify({
				ok: true,
				executed: false,
				note: "Safety mode: proposal logged but no swap will happen.",
				proposal,
			});
		}

		case "propose_sell": {
			const mint = String(ipt.mint || "").trim();
			if (!mint) throw new Error("mint is required");
			const fraction = Number(ipt.fraction);
			if (!Number.isFinite(fraction) || fraction <= 0 || fraction > 1) {
				throw new Error("fraction must be in (0, 1]");
			}
			const slippageBps = Math.floor(Number(ipt.slippageBps));
			if (!Number.isFinite(slippageBps) || slippageBps < 50) throw new Error("slippageBps must be ≥ 50");
			const proposal = await ctx.state.recordProposal({
				actionType: "sell",
				mint,
				sizeSol: fraction,
				reason: ipt.reason,
				confidence: ipt.confidence,
			});
			return JSON.stringify({
				ok: true,
				executed: false,
				note: "Safety mode: proposal logged but no swap will happen.",
				proposal,
			});
		}

		case "get_trader_state": {
			if (!ctx.bridge) throw new Error("bridge not available");
			const snap = await ctx.bridge.getTraderState();
			return JSON.stringify(snap);
		}

		case "publish_tuning": {
			if (!ctx.bridge) throw new Error("bridge not available");
			const used = callBudget.publish_tuning || 0;
			if (used >= 1) {
				throw new Error("publish_tuning already called this cycle (limit: 1). Coalesce all tuning into a single call.");
			}
			callBudget.publish_tuning = used + 1;
			if (!ipt.reason || !String(ipt.reason).trim()) {
				throw new Error("reason is required — tuning without justification is rejected");
			}
			const result = await ctx.bridge.publishTuning(ipt);
			await ctx.bridge.appendDecision({ kind: "tuning_published", payload: { version: result.version, riskLevel: result.riskLevel, knobs: result.knobs, reason: result.reason } });
			return JSON.stringify({ ok: true, published: result });
		}

		case "request_execute": {
			if (!ctx.bridge) throw new Error("bridge not available");
			const used = callBudget.request_execute || 0;
			if (used >= 3) {
				throw new Error("request_execute already called 3 times this cycle (limit: 3). Be more selective.");
			}
			callBudget.request_execute = used + 1;
			// Verify trader is actually running — refusing to queue against a dead trader avoids stale requests piling up.
			const snap = await ctx.bridge.getTraderState();
			if (!snap.present) {
				throw new Error("Trader state not present — cannot queue execution against a trader that isn't running. Use propose_buy / propose_sell to log intent instead.");
			}
			if (snap.stale) {
				throw new Error(`Trader state is stale (ageMs=${snap.ageMs}). Trader may not be running. Use propose_* to log intent instead.`);
			}
			const queued = await ctx.bridge.queueExecutionRequest(ipt);
			await ctx.bridge.appendDecision({ kind: "execute_requested", payload: { id: queued.id, action: queued.action, mint: queued.mint, sizeSol: queued.sizeSol, fraction: queued.fraction, reason: queued.reason } });
			return JSON.stringify({ ok: true, queued, note: "Queued in execution-queue.jsonl. Trader will process IFF started with --accept-claude-execution AND request passes safety policies. Check get_recent_execution_results for outcome." });
		}

		case "get_recent_decisions": {
			if (!ctx.bridge) throw new Error("bridge not available");
			const limit = Math.min(100, Math.max(1, Number(ipt.limit) || 20));
			const entries = await ctx.bridge.getRecentDecisions(limit);
			return JSON.stringify({ count: entries.length, entries });
		}

		case "get_recent_execution_results": {
			if (!ctx.bridge) throw new Error("bridge not available");
			const limit = Math.min(100, Math.max(1, Number(ipt.limit) || 20));
			const entries = await ctx.bridge.getRecentExecutionResults(limit);
			return JSON.stringify({ count: entries.length, entries });
		}

		default:
			throw new Error(`Unknown tool: ${name}`);
	}
}
