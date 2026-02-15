
import { collectInstantSolana } from "../../../../../data/feeds.js";
import { fetchTokenInfo } from "../../../../../data/dexscreener.js";
import { ingestSnapshot } from "../../../../../vista/meme/metrics/ingest.js";
import { fetchJupiterTrendingModels, getJupiterApiKey } from "../../../../../data/jupiter.js";

function sleep(ms) {
	return new Promise((r) => setTimeout(r, ms));
}

function isRateLimitError(e) {
	try {
		const msg = String(e?.message || e || "");
		return /429|too\s*many|rate\s*limit/i.test(msg);
	} catch {
		return false;
	}
}

function toSnapshotItemFromJup(m) {
	const mint = String(m?.mint || "");
	if (!mint) return null;
	const volume = {
		m5: Number(m?.v5mTotal ?? 0) || 0,
		h1: Number(m?.v1hTotal ?? 0) || 0,
		h6: Number(m?.v6hTotal ?? 0) || 0,
		h24: Number(m?.v24hTotal ?? 0) || 0,
	};
	return {
		mint,
		symbol: String(m?.symbol || ""),
		name: String(m?.name || ""),
		imageUrl: String(m?.imageUrl || ""),
		pairUrl: String(m?.headlineUrl || ""),

		priceUsd: Number(m?.priceUsd ?? 0) || 0,
		liqUsd: Number(m?.liquidityUsd ?? 0) || 0,

		change5m: Number(m?.change5m ?? 0) || 0,
		change1h: Number(m?.change1h ?? 0) || 0,
		change6h: Number(m?.change6h ?? 0) || 0,
		change24h: Number(m?.change24h ?? 0) || 0,

		v5mTotal: volume.m5,
		v1hTotal: volume.h1,
		v6hTotal: volume.h6,
		vol24hUsd: volume.h24,
		buySell24h: Number.isFinite(Number(m?.buySell24h)) ? Number(m.buySell24h) : 0,

		volume,
	};
}

function toSnapshotItemFromDexHit(hit) {
	const mint = String(hit?.mint || "");
	if (!mint) return null;
	const v24 = Number(hit?.volume24 ?? 0) || 0;
	const volume = { m5: 0, h1: 0, h6: 0, h24: v24 };
	return {
		mint,
		symbol: String(hit?.symbol || ""),
		name: String(hit?.name || ""),
		imageUrl: String(hit?.imageUrl || ""),
		pairUrl: String(hit?.url || ""),

		priceUsd: Number(hit?.priceUsd ?? 0) || 0,
		liqUsd: Number(hit?.bestLiq ?? 0) || 0,

		change5m: Number(hit?.change5m ?? 0) || 0,
		change1h: Number(hit?.change1h ?? 0) || 0,
		change6h: Number(hit?.change6h ?? 0) || 0,
		change24h: Number(hit?.change24h ?? 0) || 0,

		v5mTotal: volume.m5,
		v1hTotal: volume.h1,
		v6hTotal: volume.h6,
		vol24hUsd: volume.h24,
		buySell24h: 0,
		volume,
	};
}

async function mapWithLimit(items, limit, fn, { spacingMs = 0 } = {}) {
	const arr = Array.isArray(items) ? items : [];
	const results = new Array(arr.length);
	let idx = 0;
	let active = 0;
	let resolveAll;
	const done = new Promise((r) => (resolveAll = r));

	const next = async () => {
		if (idx >= arr.length) {
			if (active === 0) resolveAll();
			return;
		}

		const myIdx = idx++;
		active++;
		try {
			if (spacingMs && myIdx > 0) await sleep(spacingMs);
			results[myIdx] = await fn(arr[myIdx], myIdx);
		} finally {
			active--;
			next();
		}
	};

	const starters = Math.min(Math.max(1, limit | 0), arr.length);
	for (let i = 0; i < starters; i++) next();
	await done;
	return results;
}

function toSnapshotItem(info, fallbackHit) {
	const mint = String(info?.mint || fallbackHit?.mint || "");
	if (!mint) return null;

	const volume = {
		m5: Number(info?.v5mTotal ?? 0) || 0,
		h1: Number(info?.v1hTotal ?? 0) || 0,
		h6: Number(info?.v6hTotal ?? 0) || 0,
		h24: Number(info?.v24hTotal ?? fallbackHit?.volume24 ?? 0) || 0,
	};

	return {
		mint,
		symbol: String(info?.symbol || fallbackHit?.symbol || ""),
		name: String(info?.name || fallbackHit?.name || ""),
		imageUrl: String(info?.imageUrl || fallbackHit?.imageUrl || ""),
		pairUrl: String(info?.headlineUrl || fallbackHit?.url || ""),

		priceUsd: Number(info?.priceUsd ?? fallbackHit?.priceUsd ?? 0) || 0,
		liqUsd: Number(info?.liquidityUsd ?? fallbackHit?.bestLiq ?? 0) || 0,

		change5m: Number(info?.change5m ?? fallbackHit?.change5m ?? 0) || 0,
		change1h: Number(info?.change1h ?? fallbackHit?.change1h ?? 0) || 0,
		change6h: Number(info?.change6h ?? fallbackHit?.change6h ?? 0) || 0,
		change24h: Number(info?.change24h ?? fallbackHit?.change24h ?? 0) || 0,

		v5mTotal: volume.m5,
		v1hTotal: volume.h1,
		v6hTotal: volume.h6,
		vol24hUsd: volume.h24,
		buySell24h: Number.isFinite(Number(info?.buySell24h)) ? Number(info.buySell24h) : 0,

		volume,
	};
}

export function startKpiFeeder({
	log = () => {},
	intervalMs = 10_000,
	minIntervalMs = 2000,
	topN = 60,
	source = "jupiter",
	window = "5m",
	dexIntervalMs = 20_000,
	dexLimit = 80,
	dexMaxBoostedTokens = 20,
	dexHydrateTopN = 0,
	maxConcurrent = 4,
	spacingMs = 150,
	ttlMs = 15_000,
	onRateLimit = null,
} = {}) {
	const state = {
		stopped: false,
		running: false,
		timer: null,
		ac: null,
		lastEmptyLogAt: 0,
		lastJupErrLogAt: 0,
		lastDexAt: 0,
		lastDexErrLogAt: 0,
	};

	const stop = () => {
		if (state.stopped) return;
		state.stopped = true;
		try {
			if (state.timer) clearInterval(state.timer);
		} catch {}
		state.timer = null;
		try {
			if (state.ac) state.ac.abort();
		} catch {}
		state.ac = null;
	};

	const tick = async () => {
		if (state.stopped || state.running) return;
		state.running = true;

		try {
			const ac = new AbortController();
			state.ac = ac;

			const src = String(source || "jupiter").trim().toLowerCase();
			const wantJup = (src === "jupiter" || src === "jup" || src === "hybrid" || src === "mix" || src === "both");
			const wantDex = (src === "dexscreener" || src === "dex" || src === "ds" || src === "hybrid" || src === "mix" || src === "both");

			if (wantJup) {
				const want = Math.max(12, topN * 3);
				const models = await fetchJupiterTrendingModels({ window, limit: want, signal: ac.signal }).catch((e) => {
					try { if (typeof onRateLimit === "function" && isRateLimitError(e)) onRateLimit(e); } catch {}
					const now = Date.now();
					if (now - Number(state.lastJupErrLogAt || 0) > 10_000) {
						state.lastJupErrLogAt = now;
						try { log(`KPI feeder: jupiter trending failed: ${e?.message || e}`); } catch {}
					}
					return [];
				});
				const sorted = (Array.isArray(models) ? models : []).slice().sort((a, b) => Number(b?.liquidityUsd || 0) - Number(a?.liquidityUsd || 0));
				const pick = sorted.slice(0, Math.max(1, topN));
				const snapshot = pick.map(toSnapshotItemFromJup).filter(Boolean);
				if (!snapshot.length) {
					const now = Date.now();
					if (now - Number(state.lastEmptyLogAt || 0) > 10_000) {
						state.lastEmptyLogAt = now;
						try {
							const hasKey = !!String(getJupiterApiKey?.() || "").trim();
							if (!hasKey) log("KPI feeder: missing Jupiter API key (set JUP_API_KEY / FDV_JUP_API_KEY or storage key fdv_jup_api_key).");
							else log("KPI feeder: no mints from jupiter trending.");
						} catch {}
					}
					// In hybrid mode, still allow Dexscreener discovery even if Jupiter is empty.
				} else {
					try {
						ingestSnapshot(snapshot);
						log(`KPI feeder: ingested ${snapshot.length} items (jupiter).`);
					} catch (e) {
						log(`KPI feeder: ingest failed (jupiter): ${e?.message || e}`);
					}
				}
			}

			if (!wantDex) return;
			const now = Date.now();
			const dexEvery = Math.max(10_000, Number(dexIntervalMs) || 0) || 60_000;
			if (now - Number(state.lastDexAt || 0) < dexEvery) return;
			state.lastDexAt = now;

			// Dexscreener discovery (very light): ingest directly from toplist hits.
			const hits = await collectInstantSolana({
				limit: Math.max(24, Number(dexLimit) || 0) || 80,
				maxBoostedTokens: Math.max(0, Number(dexMaxBoostedTokens) || 0) || 20,
				signal: ac.signal,
			}).catch((e) => {
				try { if (typeof onRateLimit === "function" && isRateLimitError(e)) onRateLimit(e); } catch {}
				const t = Date.now();
				if (t - Number(state.lastDexErrLogAt || 0) > 10_000) {
					state.lastDexErrLogAt = t;
					try { log(`KPI feeder: dexscreener discovery failed: ${e?.message || e}`); } catch {}
				}
				return [];
			});
			const sorted = (Array.isArray(hits) ? hits : [])
				.slice()
				.sort((a, b) => Number(b?.bestLiq || 0) - Number(a?.bestLiq || 0));

			const pick = sorted.slice(0, Math.max(1, topN));
			if (!pick.length) {
				const now = Date.now();
				if (now - Number(state.lastEmptyLogAt || 0) > 10_000) {
					state.lastEmptyLogAt = now;
					try { log("KPI feeder: no mints from dexscreener discovery."); } catch {}
				}
				return;
			}

			// Optional ultra-light hydrate (off by default): only hydrate a few top mints, and let cache do the work.
			let byMint = null;
			const hydrateN = Math.max(0, Number(dexHydrateTopN) || 0);
			if (hydrateN > 0) {
				const mints = pick.slice(0, hydrateN).map((h) => h?.mint).filter(Boolean);
				const infos = await mapWithLimit(
					mints,
					Math.max(1, Math.min(2, maxConcurrent | 0)),
					async (mint) => {
						if (ac.signal.aborted) return null;
						return await fetchTokenInfo(String(mint), { signal: ac.signal, ttlMs: Math.max(30_000, Number(ttlMs) || 0) }).catch((e) => {
							try { if (typeof onRateLimit === "function" && isRateLimitError(e)) onRateLimit(e); } catch {}
							return null;
						});
					},
					{ spacingMs: Math.max(250, Number(spacingMs) || 0) }
				);
				byMint = new Map();
				for (const info of infos) {
					if (info?.mint) byMint.set(String(info.mint), info);
				}
			}

			const snapshot = [];
			for (const hit of pick) {
				const mint = String(hit?.mint || "");
				if (!mint) continue;
				const info = byMint?.get(mint) || null;
				const item = info ? toSnapshotItem(info, hit) : toSnapshotItemFromDexHit(hit);
				if (item) snapshot.push(item);
			}

			try {
				ingestSnapshot(snapshot);
				log(`KPI feeder: ingested ${snapshot.length} items (dexscreener).`);
			} catch (e) {
				log(`KPI feeder: ingest failed (dexscreener): ${e?.message || e}`);
			}
		} finally {
			state.ac = null;
			state.running = false;
		}
	};

	try {
		log(
			`KPI feeder started (source=${String(source || "jupiter")} window=${String(window || "5m")} ` +
			`interval=${intervalMs}ms min=${minIntervalMs}ms topN=${topN} dexEvery=${Math.max(10_000, Number(dexIntervalMs) || 0)}ms).`
		);
	} catch {}

	Promise.resolve().then(tick);
	state.timer = setInterval(tick, Math.max(Math.max(100, Number(minIntervalMs) || 0), Number(intervalMs) || 10_000));

	return stop;
}

