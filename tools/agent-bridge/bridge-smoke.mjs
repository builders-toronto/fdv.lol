// End-to-end smoke test for the cowork bridge. Simulates the trader writing
// state, the agent reading state + publishing tuning, the trader reading and
// applying tuning, and an execution request round-trip via the queue.
//
// Run from repo root:  node tools/agent-bridge/bridge-smoke.mjs

import { readFile, unlink, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import {
	startBridgeWriter,
	applyTuningIfPresent,
	appendTraderDecision,
	readTuning,
} from "./cli-writer.mjs";
import { createBridge } from "../claude-agent/lib/bridge.mjs";
import {
	TRADER_STATE_PATH,
	TUNING_PATH,
	DECISIONS_PATH,
	EXECUTION_QUEUE_PATH,
} from "./contract.mjs";

async function safeUnlink(p) { try { await unlink(p); } catch {} }
async function ensureDir(p) { try { await mkdir(dirname(p), { recursive: true }); } catch {} }

async function expect(label, cond, detail) {
	if (cond) {
		console.log(`  ✓ ${label}`);
	} else {
		console.error(`  ✗ ${label} — ${detail || ""}`);
		process.exitCode = 1;
	}
}

console.log("Bridge smoke test\n");

// Clean slate.
await safeUnlink(TRADER_STATE_PATH);
await safeUnlink(TUNING_PATH);
await safeUnlink(DECISIONS_PATH);
await safeUnlink(EXECUTION_QUEUE_PATH);
await ensureDir(TRADER_STATE_PATH);

const agent = createBridge();

// ── Scenario 1: agent reads when trader is not present ───────────────
console.log("Scenario 1: trader not running");
{
	const snap = await agent.getTraderState();
	await expect("present=false when trader hasn't written", snap.present === false);
	await expect("stale=true",                                  snap.stale === true);
}

// ── Scenario 2: trader starts writing state ──────────────────────────
console.log("\nScenario 2: trader writer publishes state");
let solBalance = 0.85;
const stop = startBridgeWriter({
	intervalMs: 500,
	getState: () => ({
		pubkey: "DhgReU7X285beojNM33zqVp5YYfWS8Ut4czpg3Rqqmbk",
		solBalance,
		positions: [
			{ mint: "FAKE1", symbol: "MOCK", sizeUi: 1234, costSol: 0.1, openedAtMs: Date.now() - 60_000, currentPnlPct: 8.4, ageSecs: 60 },
		],
		config: { riskLevel: "safe", takeProfitPct: 10, stopLossPct: 12, trailPct: 5, slippageBps: 250, maxBuySol: 1 },
		recentDecisions: [],
		pauseTrading: false,
		errorRate1m: 0,
		rpcBackoffMs: 0,
	}),
});

await new Promise((r) => setTimeout(r, 200)); // first immediate write

{
	const snap = await agent.getTraderState();
	await expect("present=true after first write",     snap.present === true);
	await expect("stale=false",                         snap.stale === false);
	await expect("solBalance round-trips",              snap.state?.solBalance === 0.85);
	await expect("positions[0].mint round-trips",       snap.state?.positions?.[0]?.mint === "FAKE1");
	await expect("config.riskLevel round-trips",        snap.state?.config?.riskLevel === "safe");
}

// ── Scenario 3: agent publishes tuning, trader picks it up ───────────
console.log("\nScenario 3: agent → tuning → trader");
const published = await agent.publishTuning({
	riskLevel: "medium",
	knobs: { takeProfitPct: 12, stopLossPct: 8, slippageBps: 300 },
	blocklist: ["scamMint1", "scamMint2"],
	pauseTrading: false,
	reason: "5m momentum up across top 10 candidates; tightening SL and widening TP.",
});
await expect("tuning version increments",          published.version === 1);
await expect("tuning.knobs.takeProfitPct=12",      published.knobs.takeProfitPct === 12);

let captured = null;
const applied = await applyTuningIfPresent({
	apply: (safeTuning) => { captured = safeTuning; },
});
await expect("applyTuningIfPresent returns true",  applied === true);
await expect("captured.riskLevel=medium",          captured?.riskLevel === "medium");
await expect("knob clamp preserved value",         captured?.knobs?.takeProfitPct === 12);
await expect("blocklist passed through",           Array.isArray(captured?.blocklist) && captured.blocklist.length === 2);

// Second apply on same version should be no-op (dedupe).
const reapplied = await applyTuningIfPresent({ apply: () => { throw new Error("should not be called"); } });
await expect("dedupe: re-apply same version skips", reapplied === false);

// ── Scenario 4: agent attempts out-of-bounds knob ────────────────────
console.log("\nScenario 4: out-of-bounds knob is clamped");
const t2 = await agent.publishTuning({
	knobs: { takeProfitPct: 9999, stopLossPct: 0.1 }, // way out of bounds
	reason: "Stress-test the clamp.",
});
await expect("takeProfitPct clamped to 100",       t2.knobs.takeProfitPct === 100);
await expect("stopLossPct clamped to 2",           t2.knobs.stopLossPct === 2);

// ── Scenario 5: invalid riskLevel rejected ───────────────────────────
console.log("\nScenario 5: invalid riskLevel rejected");
{
	let threw = false;
	try { await agent.publishTuning({ riskLevel: "yolo", reason: "x" }); } catch { threw = true; }
	await expect("publishTuning throws on bad riskLevel", threw);
}

// ── Scenario 6: shared decision log, both sides write ────────────────
console.log("\nScenario 6: decision log, both sides write");
await agent.appendDecision({ kind: "observation", payload: { note: "agent says hi" } });
await appendTraderDecision({ kind: "buy_executed", payload: { mint: "FAKE1", txSig: "abc" } });
const recent = await agent.getRecentDecisions(10);
// Note: agent.publishTuning() does NOT append to the decision log directly —
// that wrapping happens in the tool dispatcher in tools.mjs. So we expect
// only the two explicit appendDecision calls here.
await expect("decision log has 2 entries (agent + trader-via-cli-writer)", recent.length === 2);
await expect("entries include agent-runtime source",  recent.some((e) => e.source === "agent-runtime"));
await expect("entries include trader-gary source",    recent.some((e) => e.source === "trader-gary"));

// ── Scenario 7: execution queue round-trip ───────────────────────────
console.log("\nScenario 7: execution queue");
const queued = await agent.queueExecutionRequest({
	action: "buy",
	mint: "TARGET1",
	sizeSol: 0.15,
	slippageBps: 250,
	reason: "Strong 5m momentum, liquidity healthy.",
	confidence: 0.72,
	ttlSecs: 60,
});
await expect("queued has id",                      typeof queued.id === "string" && queued.id.length > 0);
await expect("queued.action=buy",                  queued.action === "buy");
await expect("queued.expiresAt is in future",      Date.parse(queued.expiresAt) > Date.now());

// Read the file as a trader-side consumer would.
const raw = await readFile(EXECUTION_QUEUE_PATH, "utf8");
const lines = raw.split("\n").filter(Boolean);
await expect("queue file has 1 entry",             lines.length === 1);
const parsed = JSON.parse(lines[0]);
await expect("queue entry round-trips id",         parsed.id === queued.id);

// ── Scenario 8: stale-state guard ────────────────────────────────────
console.log("\nScenario 8: agent detects stale trader state");
stop();
// Force the state file's mtime backwards is awkward across platforms; instead
// just check that after some sleep > STATE_STALE_MS (15s) the snap reports stale.
// We won't actually sleep 15s in the smoke — just verify the code path with a
// hand-rolled stale state.
{
	const { writeFile } = await import("node:fs/promises");
	const stale = {
		contractVersion: 1,
		ts: new Date(Date.now() - 60_000).toISOString(),
		pubkey: "x", solBalance: 0, positions: [], config: {}, recentDecisions: [], pauseTrading: false, errorRate1m: 0, rpcBackoffMs: 0,
	};
	await writeFile(TRADER_STATE_PATH, JSON.stringify(stale, null, 2), "utf8");
	const snap = await agent.getTraderState();
	await expect("present=true with hand-rolled state",  snap.present === true);
	await expect("stale=true when state ts is 60s old",  snap.stale === true);
}

// Clean up artifacts so the test leaves no residue.
await safeUnlink(TRADER_STATE_PATH);
await safeUnlink(TUNING_PATH);
await safeUnlink(DECISIONS_PATH);
await safeUnlink(EXECUTION_QUEUE_PATH);

console.log(`\n${process.exitCode ? "FAIL" : "OK"}`);
