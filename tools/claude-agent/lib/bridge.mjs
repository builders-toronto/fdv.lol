// Agent-side view of the cowork bridge.
//
// Reads the trader's state (if the trader is running with the bridge writer
// active), publishes tuning updates back to the trader, and appends the
// agent's decisions to the shared JSONL log.
//
// All paths and shapes come from ../../agent-bridge/contract.mjs so the
// trader-side writer and this reader cannot drift.

import { readFile, writeFile, appendFile, mkdir, rename } from "node:fs/promises";
import { dirname } from "node:path";
import {
	TRADER_STATE_PATH,
	TUNING_PATH,
	DECISIONS_PATH,
	EXECUTION_QUEUE_PATH,
	EXECUTION_RESULTS_PATH,
	HOLD_REQUESTS_PATH,
	HOLD_EVENTS_PATH,
	STATE_STALE_MS,
	CONTRACT_VERSION,
	emptyTuning,
	clampKnob,
	TUNING_RISK_LEVELS,
	TUNING_MAX_WATCHLIST,
	TUNING_MAX_BLOCKLIST,
	buildDecisionLine,
	buildExecutionRequest,
	buildHoldRequest,
} from "../../agent-bridge/contract.mjs";

async function ensureDir(filePath) {
	try { await mkdir(dirname(filePath), { recursive: true }); } catch {}
}

async function atomicWriteJson(filePath, obj) {
	await ensureDir(filePath);
	const tmp = `${filePath}.tmp`;
	await writeFile(tmp, JSON.stringify(obj, null, 2) + "\n", { encoding: "utf8", mode: 0o600 });
	await rename(tmp, filePath);
}

async function readJsonOrNull(filePath) {
	try {
		const raw = await readFile(filePath, "utf8");
		return JSON.parse(raw);
	} catch {
		return null;
	}
}

async function readJsonlTail(filePath, n) {
	try {
		const raw = await readFile(filePath, "utf8");
		const lines = raw.split("\n").filter(Boolean);
		const tail = lines.slice(-Math.max(0, Math.floor(n)));
		const out = [];
		for (const line of tail) {
			try { out.push(JSON.parse(line)); } catch {}
		}
		return out;
	} catch {
		return [];
	}
}

export function createBridge() {
	let _localTuningVersion = 0;

	async function getTraderState() {
		const state = await readJsonOrNull(TRADER_STATE_PATH);
		if (!state) {
			return { present: false, stale: true, ageMs: null, state: null };
		}
		const ts = state.ts ? Date.parse(state.ts) : NaN;
		const ageMs = Number.isFinite(ts) ? Math.max(0, Date.now() - ts) : null;
		const stale = ageMs == null || ageMs > STATE_STALE_MS;
		return { present: true, stale, ageMs, state };
	}

	async function publishTuning({ riskLevel, watchlist, blocklist, knobs, pauseTrading, reason }) {
		// Filter to the safe contract surface before writing.
		const tuning = emptyTuning();
		tuning.ts = new Date().toISOString();
		tuning.contractVersion = CONTRACT_VERSION;
		_localTuningVersion += 1;
		tuning.version = _localTuningVersion;
		tuning.reason = String(reason || "").slice(0, 500);

		if (riskLevel != null) {
			const rl = String(riskLevel).trim().toLowerCase();
			if (!TUNING_RISK_LEVELS.includes(rl)) {
				throw new Error(`Invalid riskLevel: ${riskLevel}. Must be one of ${TUNING_RISK_LEVELS.join(", ")}`);
			}
			tuning.riskLevel = rl;
		}

		if (Array.isArray(watchlist)) {
			tuning.watchlist = watchlist
				.map((m) => String(m || "").trim())
				.filter(Boolean)
				.slice(0, TUNING_MAX_WATCHLIST);
		}

		if (Array.isArray(blocklist)) {
			tuning.blocklist = blocklist
				.map((m) => String(m || "").trim())
				.filter(Boolean)
				.slice(0, TUNING_MAX_BLOCKLIST);
		}

		if (knobs && typeof knobs === "object") {
			const out = {};
			for (const [k, v] of Object.entries(knobs)) {
				const clamped = clampKnob(k, v);
				if (clamped == null) {
					throw new Error(`Unknown or out-of-bounds tuning knob: ${k}`);
				}
				out[k] = clamped;
			}
			tuning.knobs = out;
		}

		if (typeof pauseTrading === "boolean") {
			tuning.pauseTrading = pauseTrading;
		}

		await atomicWriteJson(TUNING_PATH, tuning);
		return tuning;
	}

	async function appendDecision({ kind, payload }) {
		await ensureDir(DECISIONS_PATH);
		await appendFile(DECISIONS_PATH, buildDecisionLine({ source: "agent-runtime", kind, payload: payload || {} }), "utf8");
	}

	async function getRecentDecisions(n = 20) {
		return readJsonlTail(DECISIONS_PATH, n);
	}

	async function queueExecutionRequest(req) {
		await ensureDir(EXECUTION_QUEUE_PATH);
		const line = buildExecutionRequest(req);
		await appendFile(EXECUTION_QUEUE_PATH, line, "utf8");
		return JSON.parse(line);
	}

	async function getRecentExecutionResults(n = 20) {
		return readJsonlTail(EXECUTION_RESULTS_PATH, n);
	}

	// ─── Hold cowork helpers (v2) ─────────────────────────────────────

	async function getHolds() {
		const snap = await getTraderState();
		const holds = snap?.state?.holds || [];
		const wallet = snap?.state?.wallet || null;
		return {
			present: snap.present,
			stale: snap.stale,
			ageMs: snap.ageMs,
			count: holds.length,
			holds,
			wallet,
		};
	}

	async function getHold(holdId) {
		const snap = await getTraderState();
		const holds = snap?.state?.holds || [];
		const hold = holds.find((h) => h.holdId === holdId) || null;
		return {
			present: snap.present,
			stale: snap.stale,
			found: !!hold,
			hold,
		};
	}

	async function queueHoldRequest(opts) {
		await ensureDir(HOLD_REQUESTS_PATH);
		const line = buildHoldRequest(opts);
		await appendFile(HOLD_REQUESTS_PATH, line, "utf8");
		return JSON.parse(line);
	}

	async function getRecentHoldEvents(n = 30) {
		return readJsonlTail(HOLD_EVENTS_PATH, n);
	}

	async function getPnlSummary() {
		const snap = await getTraderState();
		if (!snap.present) return { present: false, stale: true };
		const state = snap.state || {};
		const wallet = state.wallet || {};
		const positions = state.positions || [];
		const holds = state.holds || [];
		return {
			present: true,
			stale: snap.stale,
			ageMs: snap.ageMs,
			solBalance: state.solBalance || 0,
			realizedPnlSol: Number(wallet.realizedPnlSol || 0),
			sessionPnlSol: Number(wallet.sessionPnlSol || 0),
			unrealizedPnlSol: Number(wallet.unrealizedPnlSol || 0),
			openPositionCount: positions.length,
			openHoldCount: holds.filter((h) => h.status === "holding" || h.status === "buying").length,
		};
	}

	return {
		getTraderState,
		publishTuning,
		appendDecision,
		getRecentDecisions,
		queueExecutionRequest,
		getRecentExecutionResults,
		// Hold + PnL surface (v2)
		getHolds,
		getHold,
		queueHoldRequest,
		getRecentHoldEvents,
		getPnlSummary,
	};
}
