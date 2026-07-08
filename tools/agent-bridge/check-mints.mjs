#!/usr/bin/env node
// Quick check of one or more mints via DexScreener — prints a one-line summary
// for each, focused on the liquidity rule + recent signal.
// Usage:  node tools/agent-bridge/check-mints.mjs <mint> [<mint> ...]

import { argv } from "node:process";

const SOLANA_MINT_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const rawArgs = argv.slice(2);
const mints = rawArgs.filter((m) => SOLANA_MINT_RE.test(m));
const dropped = rawArgs.filter((m) => !SOLANA_MINT_RE.test(m));
if (!mints.length) {
	console.error("usage: check-mints.mjs <mint> [<mint> ...]");
	if (dropped.length) console.error(`(rejected ${dropped.length} non-base58 arg(s): ${dropped.map((d) => d.slice(0, 20)).join(", ")})`);
	process.exit(1);
}
if (dropped.length) {
	console.error(`[warn] dropping ${dropped.length} arg(s) that are not valid base58 Solana mints: ${dropped.map((d) => `"${d.slice(0, 20)}${d.length > 20 ? "…" : ""}"`).join(", ")}`);
}

const DEX = "https://api.dexscreener.com";
const SOL_QUOTE = "So11111111111111111111111111111111111111112";

async function one(mint) {
	try {
		const r = await fetch(`${DEX}/latest/dex/tokens/${encodeURIComponent(mint)}`);
		if (!r.ok) return { mint, error: `HTTP ${r.status}` };
		const j = await r.json();
		const pairs = (j?.pairs || []).filter((p) => p?.chainId === "solana" && p?.quoteToken?.address === SOL_QUOTE);
		if (!pairs.length) return { mint, error: "no SOL pair" };
		pairs.sort((a, b) => (b?.liquidity?.usd || 0) - (a?.liquidity?.usd || 0));
		const p = pairs[0];
		const b = Number(p?.txns?.m5?.buys) || 0;
		const s = Number(p?.txns?.m5?.sells) || 0;
		return {
			mint,
			sym: p?.baseToken?.symbol,
			liq: Number(p?.liquidity?.usd) || 0,
			pc5: Number(p?.priceChange?.m5) || 0,
			pc1h: Number(p?.priceChange?.h1) || 0,
			pc24: Number(p?.priceChange?.h24) || 0,
			b, s,
			ratio: s ? b / s : (b ? 999 : 0),
			vol1h: Number(p?.volume?.h1) || 0,
		};
	} catch (e) {
		return { mint, error: String(e?.message || e) };
	}
}

const results = await Promise.all(mints.map(one));
for (const r of results) {
	if (r.error) {
		console.log(`${r.mint.slice(0, 10)}…  ERROR ${r.error}`);
		continue;
	}
	const liqK = (r.liq / 1000).toFixed(0);
	const vol1hK = (r.vol1h / 1000).toFixed(0);
	const positionUsd = 7;
	const pctOfPool = ((positionUsd / r.liq) * 100).toFixed(1);
	const passes = r.liq >= 140000 && r.ratio >= 1.2 && r.pc1h > 0;
	const flag = passes ? "PASS" : "fail";
	console.log(
		`[${flag}] ${(r.sym || "?").padStart(10)}  ` +
		`liq=$${liqK.padStart(5)}K (${pctOfPool}% of pool)  ` +
		`pc5=${r.pc5.toFixed(2).padStart(7)}%  pc1h=${r.pc1h.toFixed(2).padStart(7)}%  pc24=${r.pc24.toFixed(2).padStart(7)}%  ` +
		`b/s=${r.b}/${r.s} (${r.ratio.toFixed(2)})  vol1h=$${vol1hK}K  ${r.mint}`,
	);
}
