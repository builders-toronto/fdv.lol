import { createAgentJsonRunner } from "./driver.js";
import { GARY_SENTRY_SYSTEM_PROMPT } from "./personas/agent.gary.sentry.js";

const _safeNum = (v, fallback = 0) => {
	const n = Number(v);
	return Number.isFinite(n) ? n : fallback;
};

const _clamp = (v, lo, hi, fallback = lo) => {
	const n = Number(v);
	if (!Number.isFinite(n)) return fallback;
	return Math.max(lo, Math.min(hi, n));
};

const _clamp01 = (v, fallback = 0) => _clamp(v, 0, 1, fallback);

function _safeJsonParse(s) {
	try {
		const txt = String(s || "").trim();
		if (!txt) return null;
		return JSON.parse(txt);
	} catch {
		return null;
	}
}

function _short(s, n = 220) {
	try {
		return String(s || "").replace(/\s+/g, " ").trim().slice(0, n);
	} catch {
		return "";
	}
}

function _validateSentryDecision(x) {
	try {
		if (!x || typeof x !== "object") return null;

		const actionRaw = String(x.action || "").trim().toLowerCase();
		const action = (actionRaw === "allow" || actionRaw === "blacklist" || actionRaw === "exit_and_blacklist")
			? actionRaw
			: "allow";

		const confidence = _clamp01(x.confidence, 0.0);
		const riskScore = Math.floor(_clamp(x.riskScore, 0, 100, 0));
		const reason = _short(x.reason || x.note || "");

		let blacklistMs = null;
		if (x.blacklistMs != null) {
			const ms = Math.floor(_safeNum(x.blacklistMs, 0));
			if (Number.isFinite(ms) && ms > 0) blacklistMs = Math.max(5_000, Math.min(7 * 24 * 60 * 60 * 1000, ms));
		}

		const flagsIn = Array.isArray(x.flags) ? x.flags : [];
		const flags = flagsIn.slice(0, 8).map((f) => {
			try {
				const type = _short(f?.type || "other", 40) || "other";
				const severity = _clamp01(f?.severity, 0);
				const fr = _short(f?.reason || f?.note || "", 260);
				return { type, severity, reason: fr };
			} catch {
				return null;
			}
		}).filter(Boolean);

		// Normalize: don't allow an "exit" action with near-zero confidence.
		const normalizedAction = (action === "exit_and_blacklist" && confidence < 0.55)
			? "blacklist"
			: action;

		return {
			action: normalizedAction,
			confidence,
			riskScore,
			reason,
			blacklistMs,
			flags,
		};
	} catch {
		return null;
	}
}

export function createAgentGarySentry({
	log,
	getConfig,
	fetchFn,
	cacheTtlMs = 30_000,
} = {}) {
	const _log = typeof log === "function" ? log : () => {};

	const runner = createAgentJsonRunner({
		log,
		getConfig,
		fetchFn,
		prefix: "SENTRY",
		// This is *in addition* to the per-mint cache below.
		cacheTtlMs: 1200,
	});

	const cache = new Map();

	function _getCfg() {
		try {
			const c = (typeof getConfig === "function") ? (getConfig() || {}) : {};
			return {
				enabled: c && (c.enabled !== false),
				apiKey: String(c.apiKey || c.llmApiKey || c.openaiApiKey || "").trim(),
				maxTokens: Math.floor(_safeNum(c.maxTokens, 350)),
			};
		} catch {
			return { enabled: false, apiKey: "" };
		}
	}

	function _cacheGet(k) {
		const rec = cache.get(k);
		if (!rec) return null;
		if (Date.now() - rec.at > cacheTtlMs) { cache.delete(k); return null; }
		return rec.res;
	}

	function _cacheSet(k, res) {
		cache.set(k, { at: Date.now(), res });
	}

	async function assessMint({ mint, stage = "scan", signals = null } = {}) {
		const m = String(mint || "").trim();
		if (!m) return { ok: false, err: "bad_mint" };

		const cfg = _getCfg();
		if (!cfg.enabled) return { ok: true, skipped: true, why: "disabled" };
		if (!cfg.apiKey) return { ok: true, skipped: true, why: "missing_key" };

		const st = String(stage || "scan").trim().toLowerCase() || "scan";
		const cacheKey = `${st}:${m}`;
		const cached = _cacheGet(cacheKey);
		if (cached) return cached;

		let user;
		try {
			user = JSON.stringify({
				mint: m,
				stage: st,
				ts: Date.now(),
				signals: (signals && typeof signals === "object") ? signals : {},
			});
		} catch {
			user = JSON.stringify({ mint: m, stage: st, ts: Date.now(), signals: {} });
		}

		try {
			const meta = await runner.chatJsonWithMeta({
				system: GARY_SENTRY_SYSTEM_PROMPT,
				user,
				temperature: 0.1,
				maxTokens: Math.max(220, Math.min(900, cfg.maxTokens || 350)),
				cacheKey: `sentry:${st}:${m}`,
			});

			if (!meta || meta.ok !== true) {
				// Don't cache disabled results: config/key may not be hydrated yet at startup.
				if (meta && meta.disabled) {
					return { ok: true, skipped: true, why: "disabled" };
				}
				const res = { ok: false, err: String(meta?.err || "error") };
				_cacheSet(cacheKey, res);
				return res;
			}

			const parsed = (meta.parsed && typeof meta.parsed === "object") ? meta.parsed : _safeJsonParse(meta?.text);
			const validated = _validateSentryDecision(parsed);
			const res = validated ? { ok: true, decision: validated, meta } : { ok: false, err: "invalid_json", meta };
			_cacheSet(cacheKey, res);
			return res;
		} catch (e) {
			const res = { ok: false, err: String(e?.message || e || "error") };
			_cacheSet(cacheKey, res);
			try { _log(`[SENTRY] request failed ${m.slice(0, 4)}… ${_short(res.err, 160)}`, "warn"); } catch {}
			return res;
		}
	}

	return { assessMint };
}
