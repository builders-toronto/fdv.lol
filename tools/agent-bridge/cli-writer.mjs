// Trader-side bridge writer. Imported by the deterministic trader (cli/app.js
// or similar) to expose its current state to the Claude Agent runtime.
//
// USAGE in the trader's CLI loop:
//
//   import { startBridgeWriter, applyTuningIfPresent } from "../../../tools/agent-bridge/cli-writer.mjs";
//   const bridgeStop = startBridgeWriter({
//       intervalMs: 3000,
//       getState: () => ({
//           pubkey: walletPubkey,
//           solBalance: lamportsToSol(currentSolLamports),
//           positions: enumeratePositions(),
//           config: { riskLevel, takeProfitPct, ... },
//           recentDecisions: recentRingBuffer.slice(-20),
//           pauseTrading: false,
//           errorRate1m: errorTracker.rate(),
//           rpcBackoffMs: rpc.currentBackoff(),
//       }),
//   });
//   // ...on every loop tick, optionally:
//   applyTuningIfPresent({ apply: (tuning) => { /* trader-side merge */ } });
//   // ...on shutdown:
//   bridgeStop();
//
// This module never reads/writes anything outside tools/agent-bridge/.
// It is safe to import even if no Claude agent is running — writes go to a
// file that's gitignored and harmless when ignored.

import { writeFile, readFile, mkdir, appendFile } from "node:fs/promises";
import { dirname } from "node:path";
import {
	TRADER_STATE_PATH,
	TUNING_PATH,
	DECISIONS_PATH,
	HOLD_REQUESTS_PATH,
	HOLD_EVENTS_PATH,
	emptyTraderState,
	emptyTuning,
	clampKnob,
	TUNING_RISK_LEVELS,
	TUNING_MAX_WATCHLIST,
	TUNING_MAX_BLOCKLIST,
	buildDecisionLine,
	buildHoldEventLine,
	CONTRACT_VERSION,
} from "./contract.mjs";

async function ensureDir(filePath) {
	try { await mkdir(dirname(filePath), { recursive: true }); } catch {}
}

async function atomicWriteJson(filePath, obj) {
	await ensureDir(filePath);
	const tmp = `${filePath}.tmp`;
	const body = JSON.stringify(obj, null, 2) + "\n";
	await writeFile(tmp, body, { encoding: "utf8", mode: 0o600 });
	// fs.rename is atomic on the same filesystem.
	const { rename } = await import("node:fs/promises");
	await rename(tmp, filePath);
}

export function startBridgeWriter({ intervalMs = 3000, getState }) {
	if (typeof getState !== "function") {
		throw new Error("startBridgeWriter: getState must be a function");
	}
	let stopped = false;
	let inFlight = false;

	const tick = async () => {
		if (stopped || inFlight) return;
		inFlight = true;
		try {
			const stateBase = emptyTraderState();
			let userState = {};
			try { userState = getState() || {}; } catch (e) {
				userState = { error: String(e?.message || e) };
			}
			const merged = {
				...stateBase,
				...userState,
				contractVersion: CONTRACT_VERSION,
				ts: new Date().toISOString(),
			};
			await atomicWriteJson(TRADER_STATE_PATH, merged);
		} catch {
			// swallow — bridge failures must never crash the trader
		} finally {
			inFlight = false;
		}
	};

	const timer = setInterval(tick, Math.max(500, Number(intervalMs) || 3000));
	timer.unref?.(); // don't keep the process alive just for this
	tick(); // first write happens immediately

	return function stop() {
		stopped = true;
		clearInterval(timer);
	};
}

// Read tuning.json. Returns null if missing or malformed. Returns the FULL
// tuning object — the caller decides which fields to honor.
export async function readTuning() {
	try {
		const raw = await readFile(TUNING_PATH, "utf8");
		const parsed = JSON.parse(raw);
		if (!parsed || typeof parsed !== "object") return null;
		if (parsed.contractVersion !== CONTRACT_VERSION) return null;
		return parsed;
	} catch {
		return null;
	}
}

// Apply a tuning object via the caller's `apply` callback. Filters the tuning
// down to its SAFE subset (clamped knobs, validated risk level, bounded lists)
// and passes only that filtered view to the caller. The caller is responsible
// for the actual merge into trader state.
//
// The trader should call this each loop tick; it dedupes via the `version`
// counter, so unchanged tuning is a no-op.
//
// Returns true if a new tuning was applied.
let _lastAppliedVersion = -1;

export async function applyTuningIfPresent({ apply }) {
	const t = await readTuning();
	if (!t) return false;
	const v = Number(t.version);
	if (!Number.isFinite(v) || v <= _lastAppliedVersion) return false;

	const safe = {
		version: v,
		ts: t.ts,
		reason: String(t.reason || "").slice(0, 500),
	};

	if (t.riskLevel != null) {
		const rl = String(t.riskLevel).trim().toLowerCase();
		if (TUNING_RISK_LEVELS.includes(rl)) safe.riskLevel = rl;
	}

	if (Array.isArray(t.watchlist)) {
		safe.watchlist = t.watchlist
			.map((m) => String(m || "").trim())
			.filter(Boolean)
			.slice(0, TUNING_MAX_WATCHLIST);
	}

	if (Array.isArray(t.blocklist)) {
		safe.blocklist = t.blocklist
			.map((m) => String(m || "").trim())
			.filter(Boolean)
			.slice(0, TUNING_MAX_BLOCKLIST);
	}

	if (t.knobs && typeof t.knobs === "object") {
		const knobs = {};
		for (const [k, v] of Object.entries(t.knobs)) {
			const clamped = clampKnob(k, v);
			if (clamped != null) knobs[k] = clamped;
		}
		if (Object.keys(knobs).length) safe.knobs = knobs;
	}

	if (typeof t.pauseTrading === "boolean") {
		safe.pauseTrading = t.pauseTrading;
	}

	try { await apply(safe); } catch {
		// caller failures don't update the version cursor — they'll retry next tick
		return false;
	}

	_lastAppliedVersion = v;
	return true;
}

// Append a trader-side decision to the shared decision log. Source is always
// "trader-gary" when called from the deterministic trader's Agent Gary path.
export async function appendTraderDecision({ kind, payload }) {
	try {
		await ensureDir(DECISIONS_PATH);
		await appendFile(DECISIONS_PATH, buildDecisionLine({ source: "trader-gary", kind, payload }), "utf8");
	} catch {}
}

// ─── Hold helpers (v2) ────────────────────────────────────────────────
//
// The Hold runner uses these to publish hold lifecycle events and to
// consume requests from the Hold-requests queue.

export async function appendHoldEvent({ holdId, kind, payload }) {
	try {
		await ensureDir(HOLD_EVENTS_PATH);
		await appendFile(HOLD_EVENTS_PATH, buildHoldEventLine({ holdId, kind, payload }), "utf8");
	} catch {}
}

// Read pending hold requests from the queue. Returns an array of parsed
// requests with their original line offset (used by the runner to track
// which lines have been processed without rewriting the file constantly).
// Stale entries (expired by their TTL) are filtered out.
let _processedHoldRequestIds = new Set();

export async function readPendingHoldRequests() {
	let raw = "";
	try {
		raw = await readFile(HOLD_REQUESTS_PATH, "utf8");
	} catch { return []; }
	const lines = raw.split("\n").filter(Boolean);
	const now = Date.now();
	const out = [];
	for (const line of lines) {
		try {
			const req = JSON.parse(line);
			if (!req || typeof req !== "object") continue;
			if (req.contractVersion !== CONTRACT_VERSION && req.contractVersion !== 1) continue;
			if (_processedHoldRequestIds.has(req.id)) continue;
			const exp = req.expiresAt ? Date.parse(req.expiresAt) : NaN;
			if (Number.isFinite(exp) && now > exp) {
				// Expired — mark as processed so we don't keep re-checking it.
				_processedHoldRequestIds.add(req.id);
				continue;
			}
			out.push(req);
		} catch {}
	}
	return out;
}

// Call after the runner has handled a request (started/updated/stopped/rejected).
// The id is marked as processed in-memory so subsequent reads skip it.
export function markHoldRequestProcessed(id) {
	if (id) _processedHoldRequestIds.add(String(id));
}

// Reset the processed-set (e.g. on runner restart after the queue file has been
// truncated). The runner can also call this if it wants to re-replay all
// non-expired requests at boot.
export function resetHoldRequestCursor() {
	_processedHoldRequestIds = new Set();
}
