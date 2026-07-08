// Tiny mock trader for skill-cowork tests. Publishes a fixed state every 1s
// for the duration provided. Not a real trader — just a writer.
//
// Usage: node mock-trader.mjs <durationSec>

import { startBridgeWriter, applyTuningIfPresent, appendTraderDecision } from "./cli-writer.mjs";

const durationSec = Number(process.argv[2]) || 8;
const startedAt = Date.now();

const fakePositions = [
	{ mint: "FAKE1", symbol: "MOCK1", sizeUi: 12340, costSol: 0.1, openedAtMs: Date.now() - 90_000, currentPnlPct: 8.4, ageSecs: 90 },
	{ mint: "FAKE2", symbol: "MOCK2", sizeUi: 9870,  costSol: 0.05, openedAtMs: Date.now() - 45_000, currentPnlPct: -3.1, ageSecs: 45 },
];

const initialState = {
	pubkey: "DhgReU7X285beojNM33zqVp5YYfWS8Ut4czpg3Rqqmbk",
	solBalance: 0.345,
	positions: fakePositions,
	config: { riskLevel: "safe", takeProfitPct: 10, stopLossPct: 12, trailPct: 5, slippageBps: 250, maxBuySol: 1 },
	recentDecisions: [
		{ ts: new Date(Date.now() - 60_000).toISOString(), kind: "buy_executed", mint: "FAKE1", reason: "5m momentum +6%" },
		{ ts: new Date(Date.now() - 30_000).toISOString(), kind: "buy_executed", mint: "FAKE2", reason: "Boosted token, healthy liq" },
	],
	pauseTrading: false,
	errorRate1m: 0,
	rpcBackoffMs: 0,
};

let currentConfig = { ...initialState.config };
let pauseTrading = initialState.pauseTrading;

const stop = startBridgeWriter({
	intervalMs: 1000,
	getState: () => ({
		...initialState,
		config: currentConfig,
		pauseTrading,
	}),
});

const tuningTick = setInterval(async () => {
	await applyTuningIfPresent({
		apply: async (safe) => {
			if (safe.riskLevel) currentConfig.riskLevel = safe.riskLevel;
			if (safe.knobs) Object.assign(currentConfig, safe.knobs);
			if (safe.pauseTrading != null) pauseTrading = safe.pauseTrading;
			await appendTraderDecision({
				kind: "tuning_applied",
				payload: { version: safe.version, riskLevel: safe.riskLevel, knobs: safe.knobs, pauseTrading: safe.pauseTrading },
			});
		},
	});
}, 1000);

setTimeout(() => {
	stop();
	clearInterval(tuningTick);
	const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
	console.log(JSON.stringify({ stopped: true, durationSec, elapsedSec: elapsed }));
	process.exit(0);
}, durationSec * 1000);
