function _now(nowFn) {
	try {
		return typeof nowFn === "function" ? nowFn() : Date.now();
	} catch {
		return Date.now();
	}
}

function _safeJsonParse(v, fallback = null) {
	try {
		if (!v) return fallback;
		return JSON.parse(String(v));
	} catch {
		return fallback;
	}
}

function _safeJsonStringify(v, fallback = "") {
	try {
		return JSON.stringify(v);
	} catch {
		return fallback;
	}
}

function _toNum(v) {
	const n = Number(v);
	return Number.isFinite(n) ? n : NaN;
}

function _clamp(n, a, b) {
	const x = _toNum(n);
	if (!Number.isFinite(x)) return a;
	return Math.max(a, Math.min(b, x));
}

export const SOLANA_STABLE_MINTS = [
  "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", // USDC
  "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB", // USDT
  "2b1kV6DkPAnxd5ixfnxCpjxmKwqjjaYmCZfHsFu24GXo", // PYUSD
  "2u1tszSeqZ3qBWF3uNGPFc8TzMk2tdiwknnRMWGWjGWH", // USDG
];
export function createStablecoinHealthTracker({
	getConn,
	loadWeb3,
	nowFn,
	storageKey = "fdv_stable_health_v1",
	mints = DEFAULT_STABLE_MINTS,
	maxPointsPerMint = 96,
	minSampleGapMs = 60_000,
	commitment = "confirmed",
} = {}) {
	let _lastSampleAt = 0;

	function _load() {
		try {
			if (typeof localStorage === "undefined") return { byMint: {} };
			const raw = localStorage.getItem(storageKey);
			const parsed = _safeJsonParse(raw, { byMint: {} });
			if (!parsed || typeof parsed !== "object") return { byMint: {} };
			if (!parsed.byMint || typeof parsed.byMint !== "object") parsed.byMint = {};
			return parsed;
		} catch {
			return { byMint: {} };
		}
	}

	function _save(data) {
		try {
			if (typeof localStorage === "undefined") return;
			localStorage.setItem(storageKey, _safeJsonStringify(data, ""));
		} catch {}
	}

	async function sample({ force = false } = {}) {
		const ts = _now(nowFn);
		if (!force && (ts - _lastSampleAt) < Math.max(5_000, minSampleGapMs)) return null;
		_lastSampleAt = ts;

		if (!getConn || typeof getConn !== "function") throw new Error("missing getConn");
		const conn = await getConn();
		if (!conn) throw new Error("no connection");

		let PublicKey = null;
		try {
			if (typeof loadWeb3 === "function") {
				const w3 = await loadWeb3();
				PublicKey = w3?.PublicKey || null;
			} else {
				const w3 = (typeof globalThis !== "undefined") ? globalThis.solanaWeb3 : null;
				PublicKey = w3?.PublicKey || null;
			}
		} catch {
			PublicKey = null;
		}
		if (!PublicKey) throw new Error("missing PublicKey");

		const store = _load();
		const byMint = store.byMint || (store.byMint = {});

		const out = [];
		for (const mint of Array.isArray(mints) ? mints : []) {
			const m = String(mint || "").trim();
			if (!m) continue;
			let uiAmount = NaN;
			try {
				const res = await conn.getTokenSupply(new PublicKey(m), commitment);
				uiAmount = _toNum(res?.value?.uiAmountString ?? res?.value?.uiAmount ?? NaN);
			} catch {
				uiAmount = NaN;
			}

			if (!Number.isFinite(uiAmount) || uiAmount <= 0) continue;
			if (!Array.isArray(byMint[m])) byMint[m] = [];
			byMint[m].push({ ts, uiAmount });
			// keep last N
			if (byMint[m].length > maxPointsPerMint) byMint[m].splice(0, byMint[m].length - maxPointsPerMint);
			out.push({ mint: m, ts, uiAmount });
		}

		_save(store);
		return out;
	}

	function summarize({ windowMs = 6 * 60 * 60_000 } = {}) {
		const ts = _now(nowFn);
		const w = Math.max(60_000, Number(windowMs || 0));
		const store = _load();
		const byMint = store?.byMint && typeof store.byMint === "object" ? store.byMint : {};

		let totalNow = 0;
		let totalThen = 0;
		let points = 0;

		for (const mint of Object.keys(byMint)) {
			const series = Array.isArray(byMint[mint]) ? byMint[mint] : [];
			if (!series.length) continue;

			const latest = series[series.length - 1];
			const nowAmt = _toNum(latest?.uiAmount);
			if (!Number.isFinite(nowAmt)) continue;

			// find oldest point still within window
			let thenAmt = nowAmt;
			for (let i = series.length - 1; i >= 0; i--) {
				const p = series[i];
				if (!p || (ts - Number(p.ts || 0)) > w) break;
				const v = _toNum(p.uiAmount);
				if (Number.isFinite(v)) thenAmt = v;
			}

			totalNow += nowAmt;
			totalThen += thenAmt;
			points++;
		}

		const delta = totalNow - totalThen;
		const ratePerHour = w > 0 ? (delta / (w / 3600000)) : 0;

		return {
			ok: points > 0,
			windowMs: w,
			mintsTracked: points,
			totalNowUi: totalNow,
			totalThenUi: totalThen,
			deltaUi: delta,
			ratePerHourUi: ratePerHour,
			// a coarse risk knob: negative inflow increases risk score
			riskScore01: _clamp(delta < 0 ? Math.min(1, Math.abs(delta) / Math.max(1, totalNow) * 10) : 0, 0, 1),
		};
	}

	return { sample, summarize };
}
