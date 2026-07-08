#!/usr/bin/env node
// Reads market-snapshot output via stdin and filters by liquidity + signal.
// Usage:
//   node skill-cowork/cowork-helper.mjs market-snapshot --limit 30 | \
//     node tools/agent-bridge/filter-candidates.mjs --min-liq 140000 --min-bs 1.2

import { argv, stdin } from "node:process";

const args = argv.slice(2);
function getArg(name, def) {
	const i = args.indexOf(name);
	if (i === -1) return def;
	return args[i + 1];
}

const minLiq = Number(getArg("--min-liq", 140000));
const minBs = Number(getArg("--min-bs", 1.2));
const minPc1h = Number(getArg("--min-pc1h", 0));

let buf = "";
stdin.setEncoding("utf8");
stdin.on("data", (c) => { buf += c; });
stdin.on("end", () => {
	// PowerShell prepends a UTF-8 BOM (﻿) when piping between processes.
	// Strip leading BOM + whitespace so we don't choke on Windows pipe quirks.
	const cleaned = buf.replace(/^﻿/, "").trim();
	let data;
	try { data = JSON.parse(cleaned); } catch (e) {
		console.error("bad json on stdin:", e.message);
		process.exit(2);
	}
	const cands = (data.candidates || []).map((c) => {
		const b = Number(c.buys5m || 0);
		const s = Number(c.sells5m || 0);
		const ratio = s ? b / s : (b ? 999 : 0);
		return {
			sym: c.symbol,
			mint: c.mint,
			liq: Number(c.liquidityUsd || 0),
			pc5: Number(c.priceChange5m || 0),
			pc1h: Number(c.priceChange1h || 0),
			b, s, ratio,
			vol1h: Number(c.volumeUsd1h || 0),
		};
	});

	const aboveLiq = cands.filter((c) => c.liq >= minLiq).sort((a, b) => b.pc1h - a.pc1h);
	console.log(`--- ${aboveLiq.length} candidates with liq >= $${(minLiq/1000).toFixed(0)}K (sorted by 1h %) ---`);
	for (const c of aboveLiq) {
		console.log(
			`${c.sym.padStart(12)} liq=$${(c.liq/1000).toFixed(0).padStart(4)}K  ` +
			`pc5=${c.pc5.toFixed(2).padStart(7)}%  pc1h=${c.pc1h.toFixed(2).padStart(7)}%  ` +
			`b/s=${c.b}/${c.s} (${c.ratio.toFixed(2).padStart(5)})  ` +
			`vol1h=$${(c.vol1h/1000).toFixed(0)}K  ${c.mint}`,
		);
	}

	const passing = aboveLiq.filter((c) => c.ratio >= minBs && c.pc1h > minPc1h);
	console.log(`\n--- ${passing.length} candidates passing ALL filters (liq>=$${(minLiq/1000).toFixed(0)}K, b/s>=${minBs}, pc1h>${minPc1h}) ---`);
	const scored = passing
		.map((c) => ({ ...c, score: c.ratio * c.pc1h }))
		.sort((a, b) => b.score - a.score);
	for (const c of scored) {
		console.log(
			`${c.sym.padStart(12)} score=${c.score.toFixed(1).padStart(7)}  ` +
			`liq=$${(c.liq/1000).toFixed(0)}K  pc1h=${c.pc1h.toFixed(2)}%  b/s=${c.ratio.toFixed(2)}  ${c.mint}`,
		);
	}
});
