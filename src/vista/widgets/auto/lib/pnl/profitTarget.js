export const PNL_TARGET_DEFAULT_UNDERPERF_MULT = 3;
export const PNL_TARGET_DEFAULT_UNDERPERF_PNL_PCT = -0.25;

export function coercePnlTargetUnderperformTuning(state, clamp) {
	try {
		if (!state || typeof state !== "object") return state;
		state.pnlDecayUnderperformMult = clamp(
			Number(state.pnlDecayUnderperformMult ?? PNL_TARGET_DEFAULT_UNDERPERF_MULT),
			1,
			25,
		);
		state.pnlDecayUnderperformPnlPct = clamp(
			Number(state.pnlDecayUnderperformPnlPct ?? PNL_TARGET_DEFAULT_UNDERPERF_PNL_PCT),
			-50,
			50,
		);
		return state;
	} catch {
		return state;
	}
}

export function createProfitTargetGetter({ getState, clamp, defaults } = {}) {
	const d = defaults && typeof defaults === "object" ? defaults : {};
	return function getProfitTargetPct(pos = null, nowTs = Date.now(), ctx = null) {
		try {
			const state = typeof getState === "function" ? getState() : null;
			const start = clamp(Number(state?.pnlTargetStartPct ?? d.startPct), 0, 50);
			const floor = clamp(Number(state?.pnlTargetFloorPct ?? d.floorPct), 0, start);
			let decayPct = clamp(Number(state?.pnlTargetDecayPct ?? d.decayPct), 0, 50);
			const windowMin = clamp(Number(state?.pnlTargetDecayWindowMin ?? d.decayWindowMin), 1, 240);
			const windowMs = windowMin * 60_000;
			const anchor = Number(pos?.lastBuyAt || pos?.acquiredAt || nowTs);
			const ageMs = Math.max(0, Number(nowTs) - anchor);

			// If a coin is currently underperforming, decay the target faster so we don't
			// spend too long waiting for the original target to hit.
			try {
				const underThr = clamp(
					Number(state?.pnlDecayUnderperformPnlPct ?? PNL_TARGET_DEFAULT_UNDERPERF_PNL_PCT),
					-50,
					50,
				);
				const multBase = clamp(
					Number(state?.pnlDecayUnderperformMult ?? PNL_TARGET_DEFAULT_UNDERPERF_MULT),
					1,
					25,
				);
				const pnl = Number.isFinite(Number(ctx?.pnlNetPct)) ? Number(ctx.pnlNetPct) : Number(ctx?.pnlPct);
				if (Number.isFinite(pnl) && pnl <= underThr && decayPct > 0) {
					// Smooth ramp: deeper drawdown -> slightly more decay, capped.
					const depth = Math.max(0, underThr - pnl);
					const ramp = clamp(1 + depth / 6, 1, 2.25);
					decayPct = clamp(decayPct * multBase * ramp, 0, 50);
				}
			} catch {}

			const dec = (ageMs / Math.max(1, windowMs)) * decayPct;
			return clamp(start - dec, floor, start);
		} catch {
			return Number(d.startPct || 0) || 0;
		}
	};
}
