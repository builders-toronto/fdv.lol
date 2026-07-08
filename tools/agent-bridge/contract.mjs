// Single source of truth for the trader <-> claude-agent cowork contract.
// Imported by BOTH:
//   - tools/agent-bridge/cli-writer.mjs  (used by the deterministic trader)
//   - tools/claude-agent/lib/bridge.mjs  (used by the Claude Agent runtime)
//
// If you change a path or a safety bound here, both sides update together.

import { resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export const BRIDGE_DIR = __dirname;
export const TRADER_STATE_PATH = resolvePath(BRIDGE_DIR, "trader-state.json");
export const TUNING_PATH = resolvePath(BRIDGE_DIR, "tuning.json");
export const DECISIONS_PATH = resolvePath(BRIDGE_DIR, "decisions.jsonl");
export const EXECUTION_QUEUE_PATH = resolvePath(BRIDGE_DIR, "execution-queue.jsonl");
export const EXECUTION_RESULTS_PATH = resolvePath(BRIDGE_DIR, "execution-results.jsonl");

// Hold-specific channels (added in contract version 2).
export const HOLD_REQUESTS_PATH = resolvePath(BRIDGE_DIR, "hold-requests.jsonl");
export const HOLD_EVENTS_PATH = resolvePath(BRIDGE_DIR, "hold-events.jsonl");

// Bumped from 1 → 2 with the Hold + PnL additions. Existing fields are
// backward-compatible; new fields are optional and ignored by older readers.
export const CONTRACT_VERSION = 2;

// ─── Trader state shape ────────────────────────────────────────────────
//
// The trader writes this file every ~3 seconds. Agent reads it before each
// cycle. Stale state (> STATE_STALE_MS old) should be treated as "trader is
// not running" — agent must not propose execution against stale state.

export const STATE_STALE_MS = 15_000;

export function emptyTraderState() {
	return {
		contractVersion: CONTRACT_VERSION,
		ts: null,
		pubkey: "",
		solBalance: 0,
		positions: [],          // [{mint, symbol, sizeUi, costSol, openedAtMs, currentPnlPct, ageSecs}]
		config: {},             // {riskLevel, takeProfitPct, stopLossPct, trailPct, slippageBps, maxBuySol}
		recentDecisions: [],    // [{cycleOrIso, action, mint, outcome, reason}]
		pauseTrading: false,
		errorRate1m: 0,
		rpcBackoffMs: 0,

		// ─── Hold state (v2) ───────────────────────────────────────────
		// Per-hold snapshot, refreshed every ~1.5s by the Hold runner.
		// Each entry: {
		//   holdId, mint, symbol, status ("idle"|"buying"|"holding"|"selling"|"stopped"),
		//   sizeUi, decimals, costSol, openedAtMs, ageSecs,
		//   currentPnlPct, currentPnlSol, estOutSol,
		//   profitTargetPct, rugSevThreshold, pollMs, buyPct, repeatBuy, uptickEnabled,
		//   peakPnlPct, lastTickAt, lastBuyAt, lastSellAt
		// }
		holds: [],

		// ─── Wallet-level PnL summary (v2) ─────────────────────────────
		wallet: {
			realizedPnlSol: 0,      // cumulative since process start (matches state.moneyMadeSol)
			sessionPnlSol: 0,       // realized - pnlBaselineSol
			unrealizedPnlSol: 0,    // sum of all open positions' (estOut - cost)
			lastUpdatedAtMs: 0,
		},

		// ─── Flamebar leader (v2, optional) ────────────────────────────
		// Top market mover; useful for Claude to pick candidates.
		flamebar: {
			leaderMint: "",
			leaderSymbol: "",
			leaderPnl15mPct: 0,
			leaderMode: "",         // "pump" | "pnl" | "instant" | ""
		},
	};
}

// ─── Tuning shape (Claude → trader) ────────────────────────────────────
//
// Agent writes this whole file (not append) each time it wants to update
// guidance. The trader reads it on its loop tick and applies the SAFE SUBSET.
//
// Safety: the trader must NEVER apply tuning fields outside this contract.
// New fields require updating BOTH this module and the trader's apply path.

export const TUNING_RISK_LEVELS = ["safe", "medium", "degen"];

// Bounds the trader enforces when applying knob overrides from tuning.json.
// Claude can propose anything in `knobs`; trader clamps to these bounds.
export const TUNING_KNOB_BOUNDS = {
	takeProfitPct:   { min: 1,    max: 100 },
	stopLossPct:     { min: 2,    max: 50  },
	trailPct:        { min: 0.5,  max: 20  },
	slippageBps:     { min: 50,   max: 1000 },
	// Note: maxBuySol is intentionally NOT here. Claude cannot raise the buy
	// ceiling via tuning — that requires a profile change by a human.
};

export const TUNING_MAX_WATCHLIST = 20;
export const TUNING_MAX_BLOCKLIST = 200;

export function emptyTuning() {
	return {
		contractVersion: CONTRACT_VERSION,
		ts: null,
		version: 0,              // monotonic counter, trader ignores duplicates
		riskLevel: null,         // null = no change
		watchlist: [],
		blocklist: [],
		knobs: {},               // subset of TUNING_KNOB_BOUNDS keys
		pauseTrading: null,      // null = no change; true/false set explicitly
		reason: "",
	};
}

export function clampKnob(name, value) {
	const bound = TUNING_KNOB_BOUNDS[name];
	if (!bound) return null;
	const v = Number(value);
	if (!Number.isFinite(v)) return null;
	return Math.max(bound.min, Math.min(bound.max, v));
}

// ─── Decisions log (append-only, both write) ───────────────────────────
//
// JSONL. Each line is {ts, source, ...}. Both the in-trader Claude (Agent
// Gary) and the standalone Claude Agent runtime append here. Either side can
// read recent N lines for context.

export const DECISION_SOURCES = ["trader-gary", "agent-runtime", "system"];

export function buildDecisionLine({ source, kind, payload }) {
	if (!DECISION_SOURCES.includes(source)) {
		throw new Error(`Unknown decision source: ${source}`);
	}
	return JSON.stringify({
		contractVersion: CONTRACT_VERSION,
		ts: new Date().toISOString(),
		source,
		kind: String(kind || ""),
		...payload,
	}) + "\n";
}

// ─── Execution queue (Claude → trader, gated) ──────────────────────────
//
// CRITICAL: the trader MUST refuse to consume this file unless started with
// an explicit opt-in flag (e.g. --accept-claude-execution). Even with the
// flag, every queued action is re-validated through the trader's existing
// safety policies before any swap happens.

export const EXECUTION_ACTIONS = ["buy", "sell"];
export const EXECUTION_TTL_SECS_DEFAULT = 60;
export const EXECUTION_TTL_SECS_MAX = 300;

export function buildExecutionRequest({ id, action, mint, sizeSol, fraction, slippageBps, reason, confidence, ttlSecs }) {
	if (!EXECUTION_ACTIONS.includes(action)) {
		throw new Error(`Unknown execution action: ${action}`);
	}
	const ttl = Math.min(
		EXECUTION_TTL_SECS_MAX,
		Math.max(5, Number(ttlSecs) || EXECUTION_TTL_SECS_DEFAULT),
	);
	const req = {
		contractVersion: CONTRACT_VERSION,
		id: String(id || `exec_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`),
		ts: new Date().toISOString(),
		action,
		mint: String(mint || ""),
		slippageBps: Math.floor(Number(slippageBps) || 250),
		reason: String(reason || "").slice(0, 500),
		confidence: Number(confidence) || 0,
		ttlSecs: ttl,
		expiresAt: new Date(Date.now() + ttl * 1000).toISOString(),
	};
	if (action === "buy") {
		const s = Number(sizeSol);
		if (!Number.isFinite(s) || s <= 0) throw new Error("buy requires positive sizeSol");
		req.sizeSol = s;
	} else {
		const f = Number(fraction);
		if (!Number.isFinite(f) || f <= 0 || f > 1) throw new Error("sell requires fraction in (0, 1]");
		req.fraction = f;
	}
	return JSON.stringify(req) + "\n";
}

// ─── Execution results (trader → Claude) ───────────────────────────────
//
// Trader appends one line per request it processed (executed, rejected, or
// expired). Agent reads to learn the outcome.

export const EXECUTION_OUTCOMES = ["executed", "rejected", "expired", "policy_blocked"];

export function buildExecutionResultLine({ id, outcome, txSig, error, appliedBps, executedSol, notes }) {
	if (!EXECUTION_OUTCOMES.includes(outcome)) {
		throw new Error(`Unknown execution outcome: ${outcome}`);
	}
	return JSON.stringify({
		contractVersion: CONTRACT_VERSION,
		id: String(id || ""),
		ts: new Date().toISOString(),
		outcome,
		txSig: txSig || null,
		error: error || null,
		appliedBps: appliedBps != null ? Math.floor(Number(appliedBps)) : null,
		executedSol: executedSol != null ? Number(executedSol) : null,
		notes: String(notes || "").slice(0, 500),
	}) + "\n";
}

// ─── Hold contract (v2) ───────────────────────────────────────────────
//
// Hold requests flow Claude → Hold runner via HOLD_REQUESTS_PATH.
// The runner reads, validates against Hold's bounds (below), and starts
// the Hold lifecycle. Events flow back via HOLD_EVENTS_PATH.

// Bounds enforced by both helper and runner (mirroring Hold's runtime
// coercion in src/vista/addons/auto/hold/index.js:371-373).
export const HOLD_BOUNDS = {
	pollMs:           { min: 250,  max: 60_000 },
	buyPct:           { min: 10,   max: 70 },
	profitPct:        { min: 0.1,  max: 500 },
	rugSevThreshold:  { min: 1,    max: 4 },
};

export const HOLD_ACTIONS = ["start", "update", "stop"];
export const HOLD_STOP_KINDS = ["liquidate", "cancel"];
export const HOLD_STATUSES = ["idle", "ready", "buying", "holding", "selling", "stopped", "errored"];
export const HOLD_EVENT_KINDS = [
	"requested",       // Claude asked for it
	"accepted",        // runner started the Hold
	"buy_attempted",   // Jupiter swap initiated
	"buy_executed",    // tokens credited
	"buy_failed",      // preflight / quote / submit failure
	"pnl_tick",        // periodic PnL update
	"sell_attempted",  // exit initiated
	"sell_executed",   // proceeds credited
	"sell_failed",     // exit failed
	"rug_detected",    // rug/crash/fade signal observed
	"stopped",         // lifecycle ended (any reason)
	"errored",         // unexpected error
];

function clampHoldField(name, value) {
	const bound = HOLD_BOUNDS[name];
	if (!bound) return null;
	const v = Number(value);
	if (!Number.isFinite(v)) return null;
	return Math.max(bound.min, Math.min(bound.max, v));
}

export function buildHoldRequest({ id, action, holdId, mint, pollMs, buyPct, profitPct, rugSevThreshold, repeatBuy, uptickEnabled, stopKind, reason, ttlSecs }) {
	if (!HOLD_ACTIONS.includes(action)) {
		throw new Error(`Unknown hold action: ${action}. Must be one of ${HOLD_ACTIONS.join(", ")}`);
	}
	const ttl = Math.min(
		EXECUTION_TTL_SECS_MAX,
		Math.max(5, Number(ttlSecs) || EXECUTION_TTL_SECS_DEFAULT),
	);
	const req = {
		contractVersion: CONTRACT_VERSION,
		id: String(id || `hreq_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`),
		ts: new Date().toISOString(),
		action,
		reason: String(reason || "").slice(0, 500),
		ttlSecs: ttl,
		expiresAt: new Date(Date.now() + ttl * 1000).toISOString(),
	};
	if (action === "start") {
		if (!mint) throw new Error("start requires mint");
		req.mint = String(mint);
		// All knobs are optional on start; runner fills missing with Hold defaults.
		if (pollMs != null) req.pollMs = clampHoldField("pollMs", pollMs);
		if (buyPct != null) req.buyPct = clampHoldField("buyPct", buyPct);
		if (profitPct != null) req.profitPct = clampHoldField("profitPct", profitPct);
		if (rugSevThreshold != null) req.rugSevThreshold = Math.floor(clampHoldField("rugSevThreshold", rugSevThreshold));
		if (typeof repeatBuy === "boolean") req.repeatBuy = repeatBuy;
		if (typeof uptickEnabled === "boolean") req.uptickEnabled = uptickEnabled;
	} else if (action === "update") {
		if (!holdId) throw new Error("update requires holdId");
		req.holdId = String(holdId);
		// Only tunable knobs are accepted mid-flight.
		if (profitPct != null) req.profitPct = clampHoldField("profitPct", profitPct);
		if (rugSevThreshold != null) req.rugSevThreshold = Math.floor(clampHoldField("rugSevThreshold", rugSevThreshold));
		if (pollMs != null) req.pollMs = clampHoldField("pollMs", pollMs);
		if (typeof repeatBuy === "boolean") req.repeatBuy = repeatBuy;
	} else if (action === "stop") {
		if (!holdId) throw new Error("stop requires holdId");
		req.holdId = String(holdId);
		const kind = String(stopKind || "liquidate").toLowerCase();
		if (!HOLD_STOP_KINDS.includes(kind)) {
			throw new Error(`stopKind must be one of ${HOLD_STOP_KINDS.join(", ")}`);
		}
		req.stopKind = kind;
	}
	return JSON.stringify(req) + "\n";
}

export function buildHoldEventLine({ holdId, kind, payload }) {
	if (!HOLD_EVENT_KINDS.includes(kind)) {
		throw new Error(`Unknown hold event kind: ${kind}. Must be one of ${HOLD_EVENT_KINDS.join(", ")}`);
	}
	return JSON.stringify({
		contractVersion: CONTRACT_VERSION,
		ts: new Date().toISOString(),
		holdId: String(holdId || ""),
		kind,
		...(payload && typeof payload === "object" ? payload : {}),
	}) + "\n";
}

export { clampHoldField };
