#!/usr/bin/env node
// Smoke test: given a FIXED 3% profit target, compute the minimum buy size
// that nets positive wallet growth, and recommend buyPct accordingly.
//
// Mirrors src/vista/addons/auto/lib/{constants.js, edgeCase.js, env.js} and the
// formula now baked into tools/agent-bridge/hourly-scan-prompt.md.

// ──────────────────────────────────────────────────────────────────────
// Constants (from src/vista/addons/auto/lib/constants.js + src/config/env.js)
// ──────────────────────────────────────────────────────────────────────
const ATA_RENT_SOL              = 0.00204;   // Token-2022 ATA rent (worst case; new mint requires new account)
const TX_FEE_PER_TX_SOL         = 0.00015;   // EDGE_TX_FEE_ESTIMATE_LAMPORTS / 1e9
const PLATFORM_FEE_BPS_PER_SIDE = 25;        // FDV_PLATFORM_FEE_BPS
const SOL_USD_APPROX            = 95;
const HOLD_BUYPCT_MIN           = 10;        // HOLD_BOUNDS.buyPct.min
const HOLD_BUYPCT_MAX           = 70;        // HOLD_BOUNDS.buyPct.max
const PROFIT_TARGET_PCT         = 3;         // ALWAYS — keep the safe 3% target
const TARGET_NET_PCT            = 1.0;       // Want the trading wallet to actually grow by ≥1% on a winning trade
const POOL_POSITION_CAP_PCT     = 5;         // Position must be ≤5% of pool liquidity (existing rule)
const WALLET_RESERVE_PCT_MAX    = 50;        // Never commit more than 50% of wallet to a single Hold

// ──────────────────────────────────────────────────────────────────────
// Per-trade wallet-growth math
// ──────────────────────────────────────────────────────────────────────
//
// Jupiter's exit quote ALREADY reflects platform fee + slippage (the bot's
// `pnlPct` = (estOut − cost) / cost where estOut is post-fee post-slippage).
// So when the bot exits at +profitPct%, the trading wallet receives
//   cost × (1 + profitPct/100)
// SOL from the swap, but loses the one-time fixed costs (ATA rent + 2 tx fees)
// that aren't refunded.
//
// wallet_growth_sol = cost × profitPct/100  −  ATA_RENT_SOL  −  2 × TX_FEE_PER_TX_SOL
//
// For wallet_growth ≥ TARGET_NET_PCT% × cost:
//   cost × (profitPct − TARGET_NET_PCT)/100  ≥  ATA_RENT_SOL + 2 × TX_FEE_PER_TX_SOL
//   cost ≥ (ATA_RENT_SOL + 2 × TX_FEE_PER_TX_SOL) / ((profitPct − TARGET_NET_PCT)/100)
//
// Below this min-cost, a 3% bot exit nets LESS than 1% wallet growth (and
// sub-min-cost trades may even lose money outright).

const fixedCostsSol = ATA_RENT_SOL + 2 * TX_FEE_PER_TX_SOL;  // 0.00234 SOL
const minCostSol    = fixedCostsSol / ((PROFIT_TARGET_PCT - TARGET_NET_PCT) / 100);
// = 0.00234 / 0.02 = 0.117 SOL ≈ $11.12 (at $95/SOL)

function recommendBuyPct({ solBalance, liquidityUsd }) {
	const liqSol = liquidityUsd / SOL_USD_APPROX;
	const poolCapSol = liqSol * (POOL_POSITION_CAP_PCT / 100);
	const walletCapSol = solBalance * (WALLET_RESERVE_PCT_MAX / 100);

	const desiredCostSol = minCostSol;
	const cappedCostSol = Math.min(desiredCostSol, poolCapSol, walletCapSol);

	const buyPctRaw = (cappedCostSol / solBalance) * 100;
	const buyPct = Math.max(HOLD_BUYPCT_MIN, Math.min(HOLD_BUYPCT_MAX, Math.round(buyPctRaw)));
	const actualCostSol = solBalance * (buyPct / 100);

	const grossProfitSol  = actualCostSol * (PROFIT_TARGET_PCT / 100);
	const walletGrowthSol = grossProfitSol - fixedCostsSol;
	const walletGrowthPct = (walletGrowthSol / actualCostSol) * 100;

	const tradeable = walletGrowthSol > 0;

	return {
		buyPct,
		actualCostSol: Number(actualCostSol.toFixed(4)),
		actualCostUsd: Number((actualCostSol * SOL_USD_APPROX).toFixed(2)),
		profitTargetPct: PROFIT_TARGET_PCT,
		grossProfitSol: Number(grossProfitSol.toFixed(5)),
		grossProfitUsd: Number((grossProfitSol * SOL_USD_APPROX).toFixed(3)),
		fixedCostsSol: Number(fixedCostsSol.toFixed(5)),
		fixedCostsUsd: Number((fixedCostsSol * SOL_USD_APPROX).toFixed(3)),
		walletGrowthSol: Number(walletGrowthSol.toFixed(5)),
		walletGrowthUsd: Number((walletGrowthSol * SOL_USD_APPROX).toFixed(3)),
		walletGrowthPct: Number(walletGrowthPct.toFixed(2)),
		positionVsPoolPct: Number(((actualCostUsd => actualCostUsd / liquidityUsd * 100)(actualCostSol * SOL_USD_APPROX)).toFixed(3)),
		minCostSol: Number(minCostSol.toFixed(4)),
		tradeable,
		reason: tradeable
			? `at 3% target nets +${walletGrowthPct.toFixed(2)}% wallet growth ($${(walletGrowthSol * SOL_USD_APPROX).toFixed(2)})`
			: `at 3% target loses ${Math.abs(walletGrowthSol * SOL_USD_APPROX).toFixed(2)}$ to fixed costs — position too small`,
	};
}

// ──────────────────────────────────────────────────────────────────────
// Scenarios
// ──────────────────────────────────────────────────────────────────────
console.log(`KEY INVARIANTS:`);
console.log(`  ATA rent + 2 tx fees (FIXED, one-time): ${fixedCostsSol.toFixed(5)} SOL = $${(fixedCostsSol*SOL_USD_APPROX).toFixed(2)}`);
console.log(`  Profit target (ALWAYS): ${PROFIT_TARGET_PCT}%`);
console.log(`  Target net wallet growth: ≥${TARGET_NET_PCT}% of position`);
console.log(`  → MIN position size: ${minCostSol.toFixed(4)} SOL = $${(minCostSol*SOL_USD_APPROX).toFixed(2)}`);
console.log("");
console.log("scenario".padEnd(46), "buyPct  cost$  netGrowth$  netGrowth%  tradeable?");
console.log("=".repeat(96));

const scenarios = [
	{ label: "wallet $66 (current), pool $300K", solBalance: 0.70, liquidityUsd: 300_000 },
	{ label: "wallet $66, pool $140K (our min liq)", solBalance: 0.70, liquidityUsd: 140_000 },
	{ label: "wallet $66, pool $25K (BRNDB-like — would fail liq gate)", solBalance: 0.70, liquidityUsd: 25_000 },
	{ label: "wallet $66, pool $1M (very deep)", solBalance: 0.70, liquidityUsd: 1_000_000 },
	{ label: "wallet $15 (low), pool $300K", solBalance: 0.16, liquidityUsd: 300_000 },
	{ label: "wallet $9 (very low), pool $300K", solBalance: 0.095, liquidityUsd: 300_000 },
	{ label: "wallet $190 (3× topup), pool $300K", solBalance: 2.0, liquidityUsd: 300_000 },
	{ label: "wallet $190, pool $140K", solBalance: 2.0, liquidityUsd: 140_000 },
];

for (const s of scenarios) {
	const r = recommendBuyPct(s);
	console.log(
		s.label.padEnd(46),
		String(r.buyPct + "%").padStart(6),
		String("$" + r.actualCostUsd).padStart(6),
		String("$" + r.walletGrowthUsd).padStart(11),
		String(r.walletGrowthPct + "%").padStart(11),
		r.tradeable ? "YES" : "NO (skip)",
	);
}

console.log("");
console.log("Detail for current wallet + deep pool:");
console.log(JSON.stringify(recommendBuyPct(scenarios[0]), null, 2));
