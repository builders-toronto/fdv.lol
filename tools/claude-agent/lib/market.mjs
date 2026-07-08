// DexScreener client — public, no API key required.
// Endpoint reference: https://docs.dexscreener.com/api/reference

const DEX_BASE = "https://api.dexscreener.com";
const SOL_QUOTE = "So11111111111111111111111111111111111111112";

function safeNum(v) {
	const n = Number(v);
	return Number.isFinite(n) ? n : null;
}

function shapePair(p) {
	if (!p || typeof p !== "object") return null;
	const baseToken = p.baseToken || {};
	const priceChange = p.priceChange || {};
	const volume = p.volume || {};
	const txns = p.txns || {};
	const txns5m = txns.m5 || {};
	const txnsH1 = txns.h1 || {};
	return {
		pairAddress: String(p.pairAddress || ""),
		mint: String(baseToken.address || ""),
		symbol: String(baseToken.symbol || ""),
		name: String(baseToken.name || ""),
		priceUsd: safeNum(p.priceUsd),
		priceSol: safeNum(p.priceNative),
		liquidityUsd: safeNum(p.liquidity?.usd),
		fdvUsd: safeNum(p.fdv),
		volumeUsd24h: safeNum(volume.h24),
		volumeUsd1h: safeNum(volume.h1),
		priceChange5m: safeNum(priceChange.m5),
		priceChange1h: safeNum(priceChange.h1),
		priceChange24h: safeNum(priceChange.h24),
		buys5m: safeNum(txns5m.buys),
		sells5m: safeNum(txns5m.sells),
		buys1h: safeNum(txnsH1.buys),
		sells1h: safeNum(txnsH1.sells),
		dexId: String(p.dexId || ""),
		pairCreatedAtMs: safeNum(p.pairCreatedAt),
		url: String(p.url || ""),
	};
}

export function createMarketClient({ fetchFn } = {}) {
	const _fetch = typeof fetchFn === "function" ? fetchFn : (typeof fetch !== "undefined" ? fetch : null);
	if (!_fetch) throw new Error("fetch unavailable");

	async function get(path) {
		const resp = await _fetch(`${DEX_BASE}${path}`, {
			headers: { "Accept": "application/json", "User-Agent": "fdv-claude-agent/0.1" },
		});
		if (!resp.ok) {
			const txt = await resp.text().catch(() => "");
			throw new Error(`DexScreener HTTP ${resp.status}: ${txt.slice(0, 200)}`);
		}
		return resp.json();
	}

	function dedupeKeepFirst(arr, keyFn) {
		const seen = new Set();
		const out = [];
		for (const x of arr) {
			const k = keyFn(x);
			if (!k || seen.has(k)) continue;
			seen.add(k);
			out.push(x);
		}
		return out;
	}

	return {
		async getTopSolanaCandidates({ limit = 15, minLiquidityUsd = 5000, minVolume1hUsd = 10_000 } = {}) {
			// Strategy: pull trending Solana tokens from DexScreener's boost endpoints
			// (latest + top), batch-fetch their pair data, then rank SOL-quoted pairs
			// by recent momentum weighted by sqrt(liquidity). Searching for "SOL"
			// returns SOL-base pairs which are not what we want.
			const [latest, top] = await Promise.all([
				get("/token-boosts/latest/v1").catch(() => []),
				get("/token-boosts/top/v1").catch(() => []),
			]);
			const allBoosts = [
				...(Array.isArray(latest) ? latest : []),
				...(Array.isArray(top) ? top : []),
			].filter((b) => b?.chainId === "solana" && b?.tokenAddress);
			const addrs = dedupeKeepFirst(allBoosts.map((b) => String(b.tokenAddress)), (a) => a).slice(0, 30);
			if (!addrs.length) return [];

			// DexScreener accepts comma-separated mint addresses (up to 30).
			const tokensRes = await get(`/latest/dex/tokens/${addrs.join(",")}`);
			const allPairs = Array.isArray(tokensRes?.pairs) ? tokensRes.pairs : [];

			const solPairs = allPairs
				.filter((p) => p?.chainId === "solana" && p?.quoteToken?.address === SOL_QUOTE)
				.map(shapePair)
				.filter((p) => p
					&& Number.isFinite(p.liquidityUsd)
					&& p.liquidityUsd >= minLiquidityUsd
					&& Number.isFinite(p.volumeUsd1h)
					&& p.volumeUsd1h >= minVolume1hUsd
					&& Number.isFinite(p.priceChange5m));

			// Per mint, keep only the deepest-liquidity pair (avoid duplicate
			// recommendations of the same token across multiple DEX pools).
			const bestPerMint = new Map();
			for (const p of solPairs) {
				const prev = bestPerMint.get(p.mint);
				if (!prev || (p.liquidityUsd || 0) > (prev.liquidityUsd || 0)) {
					bestPerMint.set(p.mint, p);
				}
			}

			return [...bestPerMint.values()]
				.sort((a, b) => {
					// Rank by recent momentum * sqrt(liquidity) — "hot but not insolvent".
					const ascore = (a.priceChange5m || 0) * Math.sqrt(a.liquidityUsd || 0);
					const bscore = (b.priceChange5m || 0) * Math.sqrt(b.liquidityUsd || 0);
					return bscore - ascore;
				})
				.slice(0, limit);
		},

		async getTokenInfo(mint) {
			const m = String(mint || "").trim();
			if (!m) throw new Error("mint is required");
			const json = await get(`/latest/dex/tokens/${encodeURIComponent(m)}`);
			const pairs = Array.isArray(json?.pairs) ? json.pairs : [];
			const solPairs = pairs
				.filter((p) => p?.chainId === "solana")
				.map(shapePair)
				.filter(Boolean);
			if (!solPairs.length) return null;
			// Return the pair with the highest USD liquidity as the canonical view.
			solPairs.sort((a, b) => (b.liquidityUsd || 0) - (a.liquidityUsd || 0));
			return {
				mint: m,
				bestPair: solPairs[0],
				pairCount: solPairs.length,
			};
		},
	};
}
