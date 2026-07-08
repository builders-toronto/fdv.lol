#!/usr/bin/env node
// Smoke test: verify the composite score math (mirrored in hourly-scan-prompt.md)
// matches src/core/calculate.js exactly when applied to live mints.

const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));
const normLog = (v, div = 6) => clamp(Math.log10(Math.max(v, 1) + 1) / div, 0, 1);

function compositeScore({ liquidityUsd, volume24h, fdv, txns24h, priceChange1h, priceChange6h, priceChange24h }) {
	const liq = Number(liquidityUsd) || 0;
	const vol24 = Number(volume24h) || 0;
	const fdvVal = Number(fdv) || 0;
	const tx = Number(txns24h) || 0;
	const ch1 = Number(priceChange1h) || 0;
	const ch6 = Number(priceChange6h) || 0;
	const ch24 = Number(priceChange24h) || 0;

	const turnover = vol24 / Math.max(liq, 1);
	const nVol = clamp((turnover - 0.2) / (1.5 - 0.2), 0, 1);
	const nLiq = normLog(liq, 6);

	const momRaw = clamp((ch1 + ch6 + ch24) / 100, -1, 1);
	const momSigned = momRaw > 0 ? momRaw : momRaw * 0.5;
	const nMom = clamp((momSigned + 1) / 2, 0, 1);

	const fdvM = Math.max(1, fdvVal / 1e6);
	const txPerM = tx / fdvM;
	const nAct = clamp((txPerM - 30) / (200 - 30), 0, 1);

	let score = 0.35 * nVol + 0.25 * nLiq + 0.20 * nMom + 0.20 * nAct;
	if (liq > 0 && fdvVal / Math.max(liq, 1) > 50) score -= 0.10;
	score = clamp(score, 0, 1);
	return { nVol, nLiq, nMom, nAct, score };
}

const DEX = "https://api.dexscreener.com";
const SOL_QUOTE = "So11111111111111111111111111111111111111112";

async function pairFor(mint) {
	const r = await fetch(`${DEX}/latest/dex/tokens/${encodeURIComponent(mint)}`);
	const j = await r.json();
	const pairs = (j?.pairs || []).filter((p) => p?.chainId === "solana" && p?.quoteToken?.address === SOL_QUOTE);
	if (!pairs.length) return null;
	pairs.sort((a, b) => (b?.liquidity?.usd || 0) - (a?.liquidity?.usd || 0));
	const p = pairs[0];
	return {
		mint,
		symbol: p?.baseToken?.symbol,
		liquidityUsd: Number(p?.liquidity?.usd) || 0,
		volume24h: Number(p?.volume?.h24) || 0,
		fdv: Number(p?.fdv) || 0,
		txns24h: (Number(p?.txns?.h24?.buys) || 0) + (Number(p?.txns?.h24?.sells) || 0),
		priceChange5m: Number(p?.priceChange?.m5) || 0,
		priceChange1h: Number(p?.priceChange?.h1) || 0,
		priceChange6h: Number(p?.priceChange?.h6) || 0,
		priceChange24h: Number(p?.priceChange?.h24) || 0,
	};
}

const tests = [
	// Past trades (what would have happened if we'd had this scoring)
	{ name: "PBTC (WON +0.78%)", mint: "HfMbPyDdZH6QMaDDUokjYCkHxzjoGBMpgaUvpLWGbF5p" },
	{ name: "WORLDCUP (lost -3.66%)", mint: "33eum82LaAhtv5YkUq1BdwEviSErH5CnFxqVNLT5pump" },
	{ name: "BRNDB (lost -14.3%)", mint: "9mTxwi3r1NA3NwJobe1ooDE4H9McCbwTftdQsVyepump" },
	{ name: "ALTSZN (lost -1.58%)", mint: "CcLd8HTAKLWtQHatqPwBQjtuCA72FNB9E1ckRTEzpump" },
	// Healthy deep-liq comparisons
	{ name: "BULL", mint: "3TYgKwkE2Y3rxdw9osLRSpxpXmSC1C1oo19W9KHspump" },
	{ name: "PTROLL", mint: "9FssA1B7EhdWCt7rT4RtovYbWdKg3gog1wpXWuqHpump" },
];

const HARD_LIQ = 140000;
const HARD_PC5_MAX = 30;
const SCORE_GATE = 0.55;
const BUY_LIQ = 2500;
const BUY_VOL24 = 50000;
const BUY_CH1 = 0;

const results = await Promise.all(tests.map(async (t) => {
	const c = await pairFor(t.mint);
	if (!c) return { ...t, error: "no SOL pair" };
	const s = compositeScore(c);
	const gates = {
		liq: c.liquidityUsd >= HARD_LIQ,
		pc5: c.priceChange5m <= HARD_PC5_MAX,
		score: s.score >= SCORE_GATE,
		buyRules: c.liquidityUsd >= BUY_LIQ && c.volume24h >= BUY_VOL24 && c.priceChange1h > BUY_CH1,
	};
	const allPass = Object.values(gates).every(Boolean);
	return { ...t, c, s, gates, allPass };
}));

console.log("symbol".padEnd(12), "score", "  pass  ", "nVol  nLiq  nMom  nAct ", "liq$K  vol24$K  fdv$K  ch1   ch24   pc5    why");
for (const r of results) {
	if (r.error) { console.log(r.name.padEnd(12), "ERROR:", r.error); continue; }
	const c = r.c, s = r.s, g = r.gates;
	const failed = Object.entries(g).filter(([k, v]) => !v).map(([k]) => k).join(",") || "OK";
	console.log(
		(c.symbol || "?").padEnd(12),
		s.score.toFixed(3).padStart(5),
		(r.allPass ? "[PASS]" : "[fail]").padEnd(8),
		s.nVol.toFixed(2), s.nLiq.toFixed(2), s.nMom.toFixed(2), s.nAct.toFixed(2),
		"  ",
		(c.liquidityUsd / 1000).toFixed(0).padStart(6),
		(c.volume24h / 1000).toFixed(0).padStart(7),
		(c.fdv / 1000).toFixed(0).padStart(6),
		c.priceChange1h.toFixed(2).padStart(6) + "%",
		c.priceChange24h.toFixed(2).padStart(6) + "%",
		c.priceChange5m.toFixed(2).padStart(6) + "%",
		"  " + failed,
	);
}
