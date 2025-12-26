import { clamp } from "./util.js";

export const DEFAULT_BUY_MAX_PRICE_IMPACT_PCT = 0.25; // 25%
export const DEFAULT_BUY_EXIT_CHECK_FRACTION = 0.25; // require sell route for 25% of expected buy output

function _clampInt(n, lo, hi, fallback) {
	const x = Math.floor(Number(n));
	if (!Number.isFinite(x)) return fallback;
	return Math.min(hi, Math.max(lo, x));
}

function _safeBigIntStr(v, fallback = "0") {
	try {
		const bi = BigInt(String(v ?? fallback));
		return bi > 0n ? bi.toString() : "0";
	} catch {
		return "0";
	}
}

export async function preflightBuyLiquidity({
	dex,
	solMint,
	mint,
	inputSol,
	slippageBps,
	maxPriceImpactPct = DEFAULT_BUY_MAX_PRICE_IMPACT_PCT,
	exitCheckFraction = DEFAULT_BUY_EXIT_CHECK_FRACTION,
} = {}) {
	try {
		const m = String(mint || "").trim();
		const sol = String(solMint || "").trim();
		if (!dex || typeof dex.quoteGeneric !== "function") return { ok: false, reason: "no-dex" };
		if (!m || !sol || m === sol) return { ok: false, reason: "bad-mint" };

		const solUi = Number(inputSol || 0);
		if (!(solUi > 0)) return { ok: false, reason: "bad-amount" };

		const slip = _clampInt(slippageBps, 1, 20_000, 250);
		const maxPi = clamp(maxPriceImpactPct, 0.01, 0.95);
		const frac = clamp(exitCheckFraction, 0.01, 1);

		const inLamports = BigInt(Math.max(1, Math.floor(solUi * 1e9)));
		const qBuy = await dex.quoteGeneric(sol, m, inLamports.toString(), slip);
		const buyOutRawNum = Number(qBuy?.outAmount || 0);
		const buyRouteLen = Array.isArray(qBuy?.routePlan) ? qBuy.routePlan.length : 0;
		if (!(buyOutRawNum > 0) || buyRouteLen <= 0) return { ok: false, reason: "no-route" };

		const piBuy = Number(qBuy?.priceImpactPct);
		if (Number.isFinite(piBuy) && piBuy >= maxPi) {
			return { ok: false, reason: "high-impact", priceImpactPct: piBuy };
		}

		let outRaw = 0n;
		try {
			outRaw = BigInt(_safeBigIntStr(qBuy?.outAmount, "0"));
		} catch {
			outRaw = 0n;
		}
		if (outRaw <= 0n) return { ok: false, reason: "no-route" };

		const checkRaw = (() => {
			try {
				const num = BigInt(Math.max(1, Math.floor(frac * 10_000)));
				return (outRaw * num) / 10_000n;
			} catch {
				return outRaw;
			}
		})();
		if (checkRaw <= 0n) return { ok: false, reason: "exit-no-route" };

		const qExit = await dex.quoteGeneric(m, sol, checkRaw.toString(), slip);
		const exitOutRawNum = Number(qExit?.outAmount || 0);
		const exitRouteLen = Array.isArray(qExit?.routePlan) ? qExit.routePlan.length : 0;
		if (!(exitOutRawNum > 0) || exitRouteLen <= 0) return { ok: false, reason: "exit-no-route" };

		const piExit = Number(qExit?.priceImpactPct);
		if (Number.isFinite(piExit) && piExit >= maxPi) {
			return { ok: false, reason: "exit-high-impact", priceImpactPct: piExit };
		}

		return {
			ok: true,
			priceImpactPct: Number.isFinite(piBuy) ? piBuy : undefined,
			exitPriceImpactPct: Number.isFinite(piExit) ? piExit : undefined,
			routeLen: buyRouteLen,
			exitRouteLen,
		};
	} catch {
		return { ok: false, reason: "quote-failed" };
	}
}
