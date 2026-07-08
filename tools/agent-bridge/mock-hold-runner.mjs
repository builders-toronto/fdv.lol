#!/usr/bin/env node
// Mock Hold runner. Simulates the full chat-driven Hold workflow against the
// real bridge contract — without touching Jupiter, RPC, or any actual funds.
// Use it to:
//   - Validate the cowork-helper Hold commands end-to-end
//   - Demo the chat-driven Hold experience without burning capital
//   - Develop / test the SKILL.md workflow safely
//
// The REAL Hold runner (separate iteration) will replace this file but speak
// the SAME contract (tools/agent-bridge/contract.mjs). Everything Claude-side
// stays the same.
//
// Usage:  node tools/agent-bridge/mock-hold-runner.mjs [--duration-sec N]
//
// What it simulates per Hold:
//   1. accepted        — runner saw the request, instantiated state machine
//   2. buy_attempted   — fake "Jupiter quote + swap"
//   3. buy_executed    — fake costSol, fake sizeUi credited (~2s after attempt)
//   4. pnl_tick        — every pollMs, random-walk the price ±0.5% per tick
//   5. sell_attempted  — when PnL >= profitPct OR stop request
//   6. sell_executed   — proceeds computed, realized PnL booked
//   7. stopped         — lifecycle end

import { writeFile, rename, mkdir, appendFile } from "node:fs/promises";
import { dirname } from "node:path";
import process from "node:process";

// Atomic JSON write used by the final flush on shutdown.
async function _atomicWriteJson(filePath, obj) {
	try { await mkdir(dirname(filePath), { recursive: true }); } catch {}
	const tmp = `${filePath}.tmp`;
	await writeFile(tmp, JSON.stringify(obj, null, 2) + "\n", { encoding: "utf8", mode: 0o600 });
	await rename(tmp, filePath);
}

import {
	TRADER_STATE_PATH,
	emptyTraderState,
	CONTRACT_VERSION,
	HOLD_BOUNDS,
} from "./contract.mjs";
import {
	startBridgeWriter,
	appendHoldEvent,
	readPendingHoldRequests,
	markHoldRequestProcessed,
	appendTraderDecision,
} from "./cli-writer.mjs";

// ─── Mock wallet + simulation parameters ──────────────────────────────

const MOCK_PUBKEY = "MockWa11et11111111111111111111111111111111";
let mockSolBalance = 0.5;            // simulated wallet SOL
let realizedPnlSol = 0;              // cumulative realized PnL
const pnlBaselineSol = 0;            // session anchor (frozen)

const HOLD_DEFAULTS = {
	pollMs: 2000,
	buyPct: 25,
	profitPct: 5,
	rugSevThreshold: 3,
	repeatBuy: false,
	uptickEnabled: true,
};

// ─── Hold state machine ───────────────────────────────────────────────

class MockHold {
	constructor({ holdId, mint, cfg }) {
		this.holdId = holdId;
		this.mint = mint;
		this.symbol = `MOCK_${mint.slice(0, 4)}`;
		this.cfg = { ...HOLD_DEFAULTS, ...cfg };
		this.status = "idle";       // idle → buying → holding → selling → stopped
		this.costSol = 0;
		this.sizeUi = 0;
		this.decimals = 6;
		this.openedAtMs = 0;
		this.estOutSol = 0;
		this.currentPnlPct = 0;
		this.currentPnlSol = 0;
		this.peakPnlPct = 0;
		this.lastTickAt = 0;
		this.lastBuyAt = 0;
		this.lastSellAt = 0;
		this._priceMultiplier = 1.0;        // random-walks during holding
		this._stopRequested = false;
		this._stopKind = null;
		this._tick = null;
	}

	async transitionTo(newStatus, payload = {}) {
		this.status = newStatus;
		await appendHoldEvent({
			holdId: this.holdId,
			kind: payload.kind || newStatus,
			payload: { ...payload, status: newStatus, mint: this.mint },
		});
	}

	async start() {
		await this.transitionTo("buying", { kind: "accepted", cfg: this.cfg });
		// Simulate buy after a short delay.
		setTimeout(async () => {
			try {
				await this._executeBuy();
				this._startPolling();
			} catch (e) {
				await this.transitionTo("errored", { kind: "errored", error: String(e?.message || e) });
			}
		}, 1200);
	}

	async _executeBuy() {
		const buySol = Math.max(0.001, mockSolBalance * (this.cfg.buyPct / 100));
		if (mockSolBalance < buySol + 0.01) {
			await this.transitionTo("errored", { kind: "buy_failed", error: "insufficient mock SOL" });
			return;
		}
		await appendHoldEvent({
			holdId: this.holdId,
			kind: "buy_attempted",
			payload: { mint: this.mint, planSol: buySol, slippageBps: 250 },
		});
		// Simulate slippage + ATA rent (~3% friction)
		await new Promise((r) => setTimeout(r, 800));
		this.costSol = buySol;
		this.sizeUi = Math.round(buySol / (Math.random() * 0.0000001 + 0.0000003)); // arbitrary
		this.openedAtMs = Date.now();
		this.lastBuyAt = this.openedAtMs;
		mockSolBalance -= buySol;
		this._priceMultiplier = 1.0;        // entry baseline
		this.status = "holding";
		await appendHoldEvent({
			holdId: this.holdId,
			kind: "buy_executed",
			payload: { mint: this.mint, costSol: this.costSol, sizeUi: this.sizeUi, txSig: `mockTxBuy_${Date.now()}` },
		});
	}

	_startPolling() {
		this._tick = setInterval(() => this._poll().catch(() => {}), Math.max(500, this.cfg.pollMs));
		this._poll(); // immediate first tick
	}

	async _poll() {
		if (this.status !== "holding") return;
		// Random walk: ±0.7% per tick, slight upward drift so eventually we hit TP.
		const delta = (Math.random() - 0.45) * 0.014;
		this._priceMultiplier *= (1 + delta);
		this.estOutSol = this.costSol * this._priceMultiplier * 0.97;  // subtract fake exit slippage
		this.currentPnlPct = ((this.estOutSol - this.costSol) / this.costSol) * 100;
		this.currentPnlSol = this.estOutSol - this.costSol;
		if (this.currentPnlPct > this.peakPnlPct) this.peakPnlPct = this.currentPnlPct;
		this.lastTickAt = Date.now();

		await appendHoldEvent({
			holdId: this.holdId,
			kind: "pnl_tick",
			payload: {
				mint: this.mint,
				costSol: this.costSol,
				estOutSol: this.estOutSol,
				pnlPct: this.currentPnlPct,
				pnlSol: this.currentPnlSol,
				peakPnlPct: this.peakPnlPct,
			},
		});

		// Exit conditions
		if (this._stopRequested) {
			await this._executeSell(this._stopKind === "cancel" ? "cancel" : "stop_requested");
			return;
		}
		if (this.currentPnlPct >= this.cfg.profitPct) {
			await this._executeSell("profit_target");
			return;
		}
		// PnL fade: peak ≥ 0.75×target, now ≥ 0.10×target, dropped ≥ 3 ticks
		if (this.peakPnlPct >= this.cfg.profitPct * 0.75 && this.currentPnlPct >= this.cfg.profitPct * 0.10) {
			if ((this.peakPnlPct - this.currentPnlPct) >= 3) {
				await this._executeSell("pnl_fade");
				return;
			}
		}
		// PnL crash (mock rug)
		if (this.currentPnlPct <= -30) {
			await this._executeSell("rug_crash");
			return;
		}
	}

	async _executeSell(reason) {
		if (this.status === "selling" || this.status === "stopped") return;
		this.status = "selling";
		clearInterval(this._tick);
		this._tick = null;
		await appendHoldEvent({
			holdId: this.holdId,
			kind: "sell_attempted",
			payload: { mint: this.mint, reason, estOutSol: this.estOutSol },
		});
		await new Promise((r) => setTimeout(r, 600));
		const isCancel = reason === "cancel";
		if (isCancel) {
			// Position stays in wallet (mock)
			this.status = "stopped";
			await appendHoldEvent({
				holdId: this.holdId,
				kind: "stopped",
				payload: { mint: this.mint, reason: "cancel — position retained" },
			});
			return;
		}
		const proceeds = Math.max(0, this.estOutSol);
		const pnl = proceeds - this.costSol;
		realizedPnlSol += pnl;
		mockSolBalance += proceeds;
		this.lastSellAt = Date.now();
		await appendHoldEvent({
			holdId: this.holdId,
			kind: "sell_executed",
			payload: {
				mint: this.mint,
				proceedsSol: proceeds,
				realizedPnlSol: pnl,
				reason,
				txSig: `mockTxSell_${Date.now()}`,
			},
		});
		this.status = "stopped";
		await appendHoldEvent({
			holdId: this.holdId,
			kind: "stopped",
			payload: { mint: this.mint, reason },
		});
	}

	update(patch) {
		if (typeof patch.profitPct === "number") this.cfg.profitPct = patch.profitPct;
		if (typeof patch.rugSevThreshold === "number") this.cfg.rugSevThreshold = patch.rugSevThreshold;
		if (typeof patch.pollMs === "number") {
			this.cfg.pollMs = patch.pollMs;
			if (this._tick) { clearInterval(this._tick); this._startPolling(); }
		}
		if (typeof patch.repeatBuy === "boolean") this.cfg.repeatBuy = patch.repeatBuy;
	}

	requestStop(stopKind = "liquidate") {
		this._stopRequested = true;
		this._stopKind = stopKind;
		// Force an immediate poll/exit
		this._poll().catch(() => {});
	}

	snapshot() {
		const ageSecs = this.openedAtMs ? Math.floor((Date.now() - this.openedAtMs) / 1000) : 0;
		return {
			holdId: this.holdId,
			mint: this.mint,
			symbol: this.symbol,
			status: this.status,
			sizeUi: this.sizeUi,
			decimals: this.decimals,
			costSol: this.costSol,
			openedAtMs: this.openedAtMs,
			ageSecs,
			currentPnlPct: this.currentPnlPct,
			currentPnlSol: this.currentPnlSol,
			estOutSol: this.estOutSol,
			profitTargetPct: this.cfg.profitPct,
			rugSevThreshold: this.cfg.rugSevThreshold,
			pollMs: this.cfg.pollMs,
			buyPct: this.cfg.buyPct,
			repeatBuy: this.cfg.repeatBuy,
			uptickEnabled: this.cfg.uptickEnabled,
			peakPnlPct: this.peakPnlPct,
			lastTickAt: this.lastTickAt,
			lastBuyAt: this.lastBuyAt,
			lastSellAt: this.lastSellAt,
		};
	}
}

// ─── Runner main loop ─────────────────────────────────────────────────

const holds = new Map(); // holdId → MockHold

function buildStateSnapshot() {
	const allHolds = [...holds.values()].map((h) => h.snapshot());
	const activeHolds = allHolds.filter((h) => h.status === "holding" || h.status === "buying");
	const unrealizedPnlSol = activeHolds.reduce((s, h) => s + (Number(h.currentPnlSol) || 0), 0);
	const base = emptyTraderState();
	return {
		...base,
		pubkey: MOCK_PUBKEY,
		solBalance: mockSolBalance,
		positions: [],   // mock runner doesn't track raw positions
		holds: allHolds,
		wallet: {
			realizedPnlSol,
			sessionPnlSol: realizedPnlSol - pnlBaselineSol,
			unrealizedPnlSol,
			lastUpdatedAtMs: Date.now(),
		},
		flamebar: {
			leaderMint: "",
			leaderSymbol: "",
			leaderPnl15mPct: 0,
			leaderMode: "",
		},
		config: { riskLevel: "mock", takeProfitPct: 0, stopLossPct: 0, trailPct: 0, slippageBps: 250, maxBuySol: 1 },
		recentDecisions: [],
		pauseTrading: false,
		errorRate1m: 0,
		rpcBackoffMs: 0,
		contractVersion: CONTRACT_VERSION,
	};
}

async function processPendingRequests() {
	const reqs = await readPendingHoldRequests();
	for (const r of reqs) {
		try {
			if (r.action === "start") {
				const id = `hold_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
				const cfg = {};
				for (const k of ["pollMs", "buyPct", "profitPct", "rugSevThreshold", "repeatBuy", "uptickEnabled"]) {
					if (r[k] != null) cfg[k] = r[k];
				}
				const hold = new MockHold({ holdId: id, mint: r.mint, cfg });
				holds.set(id, hold);
				await appendTraderDecision({
					kind: "hold_accepted",
					payload: { holdId: id, mint: r.mint, hreqId: r.id, reason: r.reason },
				});
				await hold.start();
			} else if (r.action === "update") {
				const h = holds.get(r.holdId);
				if (!h) {
					await appendHoldEvent({ holdId: r.holdId, kind: "errored", payload: { reason: "hold not found for update" } });
				} else {
					const patch = {};
					for (const k of ["profitPct", "rugSevThreshold", "pollMs", "repeatBuy"]) {
						if (r[k] != null) patch[k] = r[k];
					}
					h.update(patch);
					await appendHoldEvent({ holdId: r.holdId, kind: "pnl_tick", payload: { kind: "updated", patch, reason: r.reason } });
				}
			} else if (r.action === "stop") {
				const h = holds.get(r.holdId);
				if (!h) {
					await appendHoldEvent({ holdId: r.holdId, kind: "errored", payload: { reason: "hold not found for stop" } });
				} else {
					h.requestStop(r.stopKind || "liquidate");
				}
			}
		} catch (e) {
			await appendHoldEvent({ holdId: r.holdId || "?", kind: "errored", payload: { reason: String(e?.message || e) } });
		} finally {
			markHoldRequestProcessed(r.id);
		}
	}
}

async function main() {
	const durationSec = Number(process.argv.find((a, i, arr) => arr[i - 1] === "--duration-sec")) || 0;
	const stopBridge = startBridgeWriter({ intervalMs: 1500, getState: () => buildStateSnapshot() });

	// Poll the hold-requests queue every 500ms.
	const reqTick = setInterval(() => { processPendingRequests().catch(() => {}); }, 500);

	let stopping = false;
	const shutdown = async (sig) => {
		if (stopping) return;
		stopping = true;
		clearInterval(reqTick);
		// Liquidate (mock) any holds still in flight
		for (const h of holds.values()) {
			try { h.requestStop("liquidate"); } catch {}
		}
		// Let liquidations complete (sell_executed + stopped events fire on the
		// hold-events log; wallet aggregates update via _executeSell mutations).
		await new Promise((r) => setTimeout(r, 1500));
		stopBridge();
		// Final flush — capture post-liquidation wallet + hold state so the
		// post-mortem read sees the actual outcome, not the pre-shutdown snapshot.
		try {
			const finalSnap = buildStateSnapshot();
			finalSnap.ts = new Date().toISOString();
			await _atomicWriteJson(TRADER_STATE_PATH, finalSnap);
		} catch {}
		console.error(`[mock-hold-runner] shutdown (${sig || "ok"}). final realized=${realizedPnlSol.toFixed(6)} SOL`);
		process.exit(0);
	};
	process.on("SIGINT", () => shutdown("SIGINT"));
	process.on("SIGTERM", () => shutdown("SIGTERM"));

	if (durationSec > 0) {
		setTimeout(() => shutdown("duration"), durationSec * 1000);
	}

	console.error(`[mock-hold-runner] started (pubkey=${MOCK_PUBKEY}, balance=${mockSolBalance} mock SOL). polling hold-requests every 500ms.`);
}

main().catch((e) => {
	console.error("[mock-hold-runner] fatal:", String(e?.stack || e?.message || e));
	process.exit(1);
});
