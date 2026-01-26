
import { collectInstantSolana } from "../../../../../data/feeds.js";
import { fetchTokenInfo } from "../../../../../data/dexscreener.js";
import { ingestSnapshot } from "../../../../../vista/meme/metrics/ingest.js";

function sleep(ms) {
	return new Promise((r) => setTimeout(r, ms));
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
		h24: Number(info?.v24hTotal ?? 0) || 0,
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
	topN = 60,
	maxConcurrent = 4,
	spacingMs = 150,
	ttlMs = 15_000,
} = {}) {
	const state = {
		stopped: false,
		running: false,
		timer: null,
		ac: null,
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

			const hits = await collectInstantSolana({ limit: Math.max(120, topN * 3), signal: ac.signal }).catch(() => []);
			const sorted = (Array.isArray(hits) ? hits : [])
				.slice()
				.sort((a, b) => Number(b?.bestLiq || 0) - Number(a?.bestLiq || 0));

			const pick = sorted.slice(0, Math.max(1, topN));
			const mints = pick.map((h) => h?.mint).filter(Boolean);

			if (!mints.length) {
				try { log("KPI feeder: no mints from instant feed."); } catch {}
				return;
			}

			const infos = await mapWithLimit(
				mints,
				Math.max(1, maxConcurrent | 0),
				async (mint) => {
					if (ac.signal.aborted) return null;
					return await fetchTokenInfo(String(mint), { signal: ac.signal, ttlMs }).catch(() => null);
				},
				{ spacingMs }
			);

			const byMint = new Map();
			for (const info of infos) {
				if (info?.mint) byMint.set(String(info.mint), info);
			}

			const snapshot = [];
			for (const hit of pick) {
				const mint = String(hit?.mint || "");
				if (!mint) continue;
				const info = byMint.get(mint) || null;
				const item = toSnapshotItem(info, hit);
				if (item) snapshot.push(item);
			}

			if (!snapshot.length) {
				try { log("KPI feeder: empty snapshot after hydrate."); } catch {}
				return;
			}

			try {
				ingestSnapshot(snapshot);
				log(`KPI feeder: ingested ${snapshot.length} items.`);
			} catch (e) {
				log(`KPI feeder: ingest failed: ${e?.message || e}`);
			}
		} finally {
			state.ac = null;
			state.running = false;
		}
	};

	try { log(`KPI feeder started (interval=${intervalMs}ms topN=${topN}).`); } catch {}

	Promise.resolve().then(tick);
	state.timer = setInterval(tick, Math.max(2000, Number(intervalMs) || 10_000));

	return stop;
}

