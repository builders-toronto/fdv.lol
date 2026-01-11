export const PNL_FADE_DEFAULTS = Object.freeze({
	enabled: true,
	minAgeMs: 12_000,
	minPeakPct: 2.0,
	minPositiveNowPct: 0.10,
	minSamples: 6,
	downtrendPoints: 3,
	epsPct: 0.05,
	dropFromPeakPct: 0.75,
	// If enabled, allow a fade exit even after crossing back to <= 0% PnL.
	allowCrossDown: false,
});

export function coercePnlFadeState(state, clamp) {
	try {
		if (!state || typeof state !== "object") return state;

		state.pnlFadeExitEnabled = state.pnlFadeExitEnabled != null ? !!state.pnlFadeExitEnabled : PNL_FADE_DEFAULTS.enabled;
		state.pnlFadeMinAgeMs = clamp(Number(state.pnlFadeMinAgeMs ?? PNL_FADE_DEFAULTS.minAgeMs), 0, 300_000);
		state.pnlFadeMinPeakPct = clamp(Number(state.pnlFadeMinPeakPct ?? PNL_FADE_DEFAULTS.minPeakPct), 0, 100);
		state.pnlFadeMinPositiveNowPct = clamp(
			Number(state.pnlFadeMinPositiveNowPct ?? PNL_FADE_DEFAULTS.minPositiveNowPct),
			-50,
			100,
		);
		state.pnlFadeMinSamples = clamp(Number(state.pnlFadeMinSamples ?? PNL_FADE_DEFAULTS.minSamples), 3, 25);
		state.pnlFadeDowntrendPoints = clamp(
			Number(state.pnlFadeDowntrendPoints ?? PNL_FADE_DEFAULTS.downtrendPoints),
			2,
			10,
		);
		state.pnlFadeEpsPct = clamp(Number(state.pnlFadeEpsPct ?? PNL_FADE_DEFAULTS.epsPct), 0, 2);
		// Optional: if pnlFadeDropFromPeakPct is not finite, treat it as "use target-based drop".
		const dropRaw = Number(state.pnlFadeDropFromPeakPct);
		state.pnlFadeDropFromPeakPct = Number.isFinite(dropRaw)
			? clamp(dropRaw, 0.05, 25)
			: null;
		state.pnlFadeAllowCrossDown = state.pnlFadeAllowCrossDown != null ? !!state.pnlFadeAllowCrossDown : PNL_FADE_DEFAULTS.allowCrossDown;
		return state;
	} catch {
		return state;
	}
}

function _getOrInitPnlFade(pos, mint, nowTs) {
	try {
		const m = String(mint || "").trim();
		if (!pos || !m) return null;
		const prev = pos._pnlFade;
		if (prev && typeof prev === "object" && String(prev.mint || "").trim() === m) return prev;
		const next = { mint: m, startedAt: nowTs, firstPositiveAt: 0, peakPct: null, peakAt: 0, samples: [] };
		pos._pnlFade = next;
		return next;
	} catch {
		return null;
	}
}

export function pushPnlFadeSample(pos, mint, pnlPct, nowTs) {
	try {
		if (!pos) return;
		const p = Number(pnlPct);
		if (!Number.isFinite(p)) return;
		const fade = _getOrInitPnlFade(pos, mint, nowTs);
		if (!fade) return;

		if (p > 0 && !Number(fade.firstPositiveAt || 0)) fade.firstPositiveAt = nowTs;
		if (fade.peakPct === null || p > Number(fade.peakPct)) {
			fade.peakPct = p;
			fade.peakAt = nowTs;
		}

		const s = Array.isArray(fade.samples) ? fade.samples : [];
		const lastT = Number(s.length ? s[s.length - 1]?.t : 0);
		if (lastT && (nowTs - lastT) < 650) return;
		s.push({ t: nowTs, p });
		while (s.length > 12) s.shift();
		fade.samples = s;
	} catch {}
}

function _shouldPnlFadeExit({ state, ctx, clamp }) {
	try {
		if (!state?.pnlFadeExitEnabled) return { ok: false };
		if (ctx?.forceRug) return { ok: false };
		if (ctx?.inMinHold) return { ok: false };
		if (!ctx?.pos) return { ok: false };

		const pnl = Number.isFinite(Number(ctx.pnlNetPct)) ? Number(ctx.pnlNetPct) : Number(ctx.pnlPct);
		if (!Number.isFinite(pnl)) return { ok: false };

		const target = Number(ctx.pnlTargetPct);
		if (Number.isFinite(target) && pnl >= target) return { ok: false };

		const fade = ctx.pos._pnlFade;
		if (!fade || typeof fade !== "object" || String(fade.mint || "").trim() !== String(ctx.mint || "").trim()) {
			return { ok: false };
		}

		const ageMs = Number(ctx.ageMs || 0);
		const minAge = Math.max(0, Number(state.pnlFadeMinAgeMs ?? PNL_FADE_DEFAULTS.minAgeMs));
		if (minAge > 0 && ageMs < minAge) return { ok: false };

		const peak = Number(fade.peakPct);
		const minPeak = Math.max(0, Number(state.pnlFadeMinPeakPct ?? PNL_FADE_DEFAULTS.minPeakPct));
		if (!Number.isFinite(peak) || peak < minPeak) return { ok: false };

		const minNow = Number(state.pnlFadeMinPositiveNowPct ?? PNL_FADE_DEFAULTS.minPositiveNowPct);
		const allowCrossDown = !!(state.pnlFadeAllowCrossDown ?? PNL_FADE_DEFAULTS.allowCrossDown);
		const isStillGreenish = pnl >= minNow;
		const crossedBackDown = pnl <= 0 && peak >= minPeak;
		if (!(isStillGreenish || (allowCrossDown && crossedBackDown))) return { ok: false };

		const samples = Array.isArray(fade.samples) ? fade.samples : [];
		const minN = Math.max(3, Number(state.pnlFadeMinSamples ?? PNL_FADE_DEFAULTS.minSamples));
		if (samples.length < minN) return { ok: false };

		const eps = Math.max(0, Number(state.pnlFadeEpsPct ?? PNL_FADE_DEFAULTS.epsPct));
		const needDown = Math.max(2, Number(state.pnlFadeDowntrendPoints ?? PNL_FADE_DEFAULTS.downtrendPoints));
		let down = 0;
		for (let i = samples.length - 1; i > 0 && down < needDown; i--) {
			const a = Number(samples[i - 1]?.p);
			const b = Number(samples[i]?.p);
			if (!Number.isFinite(a) || !Number.isFinite(b)) break;
			if (b <= a - eps) down++;
			else break;
		}
		if (down < needDown) return { ok: false };

		let dropReq = Number(state.pnlFadeDropFromPeakPct);
		if (Number.isFinite(dropReq)) {
			dropReq = Math.max(0.05, dropReq);
		} else {
			// Hold-style: scale the required drop from peak by the configured target.
			const targetPct = Number(ctx.pnlTargetPct);
			const base = Number.isFinite(targetPct) ? clamp(targetPct * 0.25, 0.6, 2.5) : 0.75;
			dropReq = Math.max(0.05, base);
		}
		const drop = peak - pnl;
		if (!(drop >= dropReq)) return { ok: false };

		return { ok: true, peakPct: peak, pnlPct: pnl, dropPct: drop, downPoints: down };
	} catch {
		return { ok: false };
	}
}

export function createPnlFadeExitPolicy({ log, clamp, getState } = {}) {
	return function pnlFadeExitPolicy(ctx) {
		try {
			if (ctx?.forceRug) return;
			if (!ctx?.pos) return;
			if (ctx?.decision && ctx.decision.action && ctx.decision.action !== "none") {
				// Don't override any existing explicit exits.
				return;
			}

			const state = typeof getState === "function" ? getState() : null;
			const r = _shouldPnlFadeExit({ state, ctx, clamp });
			if (!r.ok) return;

			ctx.isFastExit = true;
			ctx.decision = {
				action: "sell_all",
				reason: `FADE_EXIT pnl=${Number(r.pnlPct || 0).toFixed(2)}% peak=${Number(r.peakPct || 0).toFixed(2)}% drop=${Number(r.dropPct || 0).toFixed(2)}%`,
			};
		} catch {}
	};
}
