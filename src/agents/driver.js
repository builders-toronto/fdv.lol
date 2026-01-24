import { createOpenAIChatClient } from "./frameworks/open.js";

function now() {
	return Date.now();
}

function _safeNum(v, fallback = 0) {
	const n = Number(v);
	return Number.isFinite(n) ? n : fallback;
}

function _clampNum(n, min, max) {
	const v = _safeNum(n, min);
	return Math.max(min, Math.min(max, v));
}

function _safeJsonParse(s) {
	try {
		return JSON.parse(String(s || ""));
	} catch {
		return null;
	}
}

function _redactDeep(obj, { maxDepth = 6, maxKeys = 200 } = {}, _depth = 0, _seen = new WeakSet()) {
	try {
		if (_depth > maxDepth) return "[truncated]";
		if (obj == null) return obj;
		if (typeof obj === "string") {
			// avoid leaking secrets in raw strings
			if (/sk-|secret|private|seed|keypair|secretKey|autoWalletSecret|rpcHeaders|authorization|bearer/i.test(obj)) return "[redacted]";
			return obj.length > 2000 ? obj.slice(0, 2000) + "…" : obj;
		}
		if (typeof obj === "number" || typeof obj === "boolean") return obj;
		if (typeof obj === "bigint") return String(obj);
		if (typeof obj === "function") return `[fn ${obj.name || "anonymous"}]`;
		if (typeof obj !== "object") return String(obj);
		if (_seen.has(obj)) return "[cycle]";
		_seen.add(obj);

		if (Array.isArray(obj)) {
			return obj.slice(0, 50).map((v) => _redactDeep(v, { maxDepth, maxKeys }, _depth + 1, _seen));
		}

		const out = {};
		let nKeys = 0;
		for (const k of Object.keys(obj)) {
			nKeys++;
			if (nKeys > maxKeys) {
				out.__truncated__ = true;
				break;
			}
			const key = String(k || "");
			if (/secret|private|seed|keypair|secretKey|autoWalletSecret|rpcHeaders|authorization|bearer/i.test(key)) {
				out[key] = "[redacted]";
				continue;
			}
			out[key] = _redactDeep(obj[key], { maxDepth, maxKeys }, _depth + 1, _seen);
		}
		return out;
	} catch {
		return "[unserializable]";
	}
}

import { GARY_SYSTEM_PROMPT } from "./agent.gary.js";

function _validateTune(tune) {
	try {
		if (!tune || typeof tune !== "object") return null;
		const out = {};
		const set = (k, v, min, max, round = null) => {
			const n = _safeNum(v, NaN);
			if (!Number.isFinite(n)) return;
			let clamped = _clampNum(n, min, max);
			if (round === "int") clamped = Math.floor(clamped);
			else if (typeof round === "number") clamped = Math.round(clamped / round) * round;
			out[k] = clamped;
		};

		// Risk / exit tuning
		set("takeProfitPct", tune.takeProfitPct, 0, 250, 0.25);
		set("stopLossPct", tune.stopLossPct, 0, 99, 0.25);
		set("trailPct", tune.trailPct, 0, 99, 0.25);
		set("minProfitToTrailPct", tune.minProfitToTrailPct, 0, 200, 0.25);

		// Hold tuning
		set("minHoldSecs", tune.minHoldSecs, 0, 20_000, "int");
		set("maxHoldSecs", tune.maxHoldSecs, 10, 20_000, "int");

		// Buy sizing / gating
		set("buyPct", tune.buyPct, 0.01, 0.5, 0.005);

		// Entry simulation tuning
		set("entrySimMinWinProb", tune.entrySimMinWinProb, 0, 1, 0.01);
		set("entrySimHorizonSecs", tune.entrySimHorizonSecs, 30, 600, "int");

		return Object.keys(out).length ? out : null;
	} catch {
		return null;
	}
}

function _validateBuyDecision(obj) {
	if (!obj || typeof obj !== "object") return null;
	const action = String(obj.action || "").toLowerCase();
	if (action !== "buy" && action !== "skip") return null;
	const confidence = _clampNum(obj.confidence, 0, 1);
	const reason = String(obj.reason || "").slice(0, 220);
	const out = { kind: "buy", action, confidence, reason };
	if (obj.buy && typeof obj.buy === "object") {
		const solUi = _safeNum(obj.buy.solUi, NaN);
		const slippageBps = _safeNum(obj.buy.slippageBps, NaN);
		out.buy = {};
		if (Number.isFinite(solUi) && solUi > 0) out.buy.solUi = solUi;
		if (Number.isFinite(slippageBps) && slippageBps > 0) out.buy.slippageBps = Math.floor(slippageBps);
	}
	const tune = _validateTune(obj.tune);
	if (tune) out.tune = tune;
	// Optional evolve feedback (ignored by bot execution, used for long-term improvement).
	try {
		if (obj.evolve && typeof obj.evolve === "object") {
			const outcomeTs = _safeNum(obj.evolve.outcomeTs, 0);
			const selfCritique = String(obj.evolve.selfCritique || "").slice(0, 220);
			const lesson = String(obj.evolve.lesson || "").slice(0, 220);
			if (Number.isFinite(outcomeTs) && outcomeTs > 0 && (selfCritique || lesson)) {
				out.evolve = { outcomeTs };
				if (selfCritique) out.evolve.selfCritique = selfCritique;
				if (lesson) out.evolve.lesson = lesson;
			}
		}
	} catch {}
	return out;
}

function _validateSellDecision(obj) {
	if (!obj || typeof obj !== "object") return null;
	const action = String(obj.action || "").toLowerCase();
	if (action !== "sell_all" && action !== "sell_partial" && action !== "hold") return null;
	const confidence = _clampNum(obj.confidence, 0, 1);
	const reason = String(obj.reason || "").slice(0, 220);
	const out = { kind: "sell", action, confidence, reason };
	if (action === "sell_partial") {
		const pct = _clampNum(obj?.sell?.pct, 1, 100);
		out.sell = { pct: Math.floor(pct) };
	}
	const tune = _validateTune(obj.tune);
	if (tune) out.tune = tune;
	// Optional evolve feedback (ignored by bot execution, used for long-term improvement).
	try {
		if (obj.evolve && typeof obj.evolve === "object") {
			const outcomeTs = _safeNum(obj.evolve.outcomeTs, 0);
			const selfCritique = String(obj.evolve.selfCritique || "").slice(0, 220);
			const lesson = String(obj.evolve.lesson || "").slice(0, 220);
			if (Number.isFinite(outcomeTs) && outcomeTs > 0 && (selfCritique || lesson)) {
				out.evolve = { outcomeTs };
				if (selfCritique) out.evolve.selfCritique = selfCritique;
				if (lesson) out.evolve.lesson = lesson;
			}
		}
	} catch {}
	return out;
}

function _validateConfigScanDecision(obj) {
	try {
		if (!obj || typeof obj !== "object") return null;
		const action = String(obj.action || "").toLowerCase();
		if (action !== "apply" && action !== "skip") return null;
		const confidence = _clampNum(obj.confidence, 0, 1);
		const reason = String(obj.reason || "").slice(0, 220);
		const out = { kind: "config_scan", action, confidence, reason };
		if (obj.config && typeof obj.config === "object") {
			const cfg = {};
			let n = 0;
			for (const [k, v] of Object.entries(obj.config)) {
				n++;
				if (n > 120) break;
				const key = String(k || "").slice(0, 80);
				if (!key) continue;
				const t = typeof v;
				if (t === "number" || t === "boolean" || t === "string") cfg[key] = v;
			}
			if (Object.keys(cfg).length) out.config = cfg;
		}
		return out;
	} catch {
		return null;
	}
}

function _readLs(key, fallback = "") {
	try {
		if (typeof localStorage === "undefined") return fallback;
		return String(localStorage.getItem(String(key || "")) || fallback);
	} catch {
		return fallback;
	}
}

function _readBoolLs(key, fallback = false) {
	try {
		const v = _readLs(key, "").trim().toLowerCase();
		if (!v) return fallback;
		if (v === "1" || v === "true" || v === "yes" || v === "on") return true;
		if (v === "0" || v === "false" || v === "no" || v === "off") return false;
		return fallback;
	} catch {
		return fallback;
	}
}

function _readLsJson(key, fallback = null) {
	try {
		const raw = _readLs(key, "");
		if (!raw) return fallback;
		const json = _safeJsonParse(raw);
		return json ?? fallback;
	} catch {
		return fallback;
	}
}

export function createAutoTraderAgentDriver({
	log,
	getState,
	getConfig,
} = {}) {
	const _rawLog = typeof log === "function" ? log : () => {};
	const _log = (msg, type) => {
		try {
			_rawLog(`[AGENT GARY] ${String(msg ?? "")}`, type);
		} catch {
			try { _rawLog(String(msg ?? ""), type); } catch {}
		}
	};
	const _getState = typeof getState === "function" ? getState : () => ({});
	const _getConfig = typeof getConfig === "function" ? getConfig : () => ({ });

	const cache = new Map();
	const CACHE_TTL_MS = 2500;

	function _enabled() {
		try {
			const cfg = _getConfig() || {};
			if (cfg.enabled === false) return false;
			// Only enable if an API key is present.
			const k = String(cfg.openaiApiKey || "").trim();
			return !!k;
		} catch {
			return false;
		}
	}

	function _fmtShortJson(obj, maxLen = 2200) {
		try {
			const s = JSON.stringify(obj);
			if (typeof s !== "string") return "";
			return s.length > maxLen ? s.slice(0, maxLen) + "…" : s;
		} catch {
			return "";
		}
	}

	function _getClient() {
		const cfg = _getConfig() || {};
		const apiKey = String(cfg.openaiApiKey || "").trim();
		if (!apiKey) return null;
		return createOpenAIChatClient({
			apiKey,
			baseUrl: String(cfg.openaiBaseUrl || "https://api.openai.com/v1").trim() || "https://api.openai.com/v1",
			model: String(cfg.openaiModel || "gpt-4o-mini").trim() || "gpt-4o-mini",
			timeoutMs: Math.max(5000, Number(cfg.timeoutMs || 12_000)),
		});
	}

	async function _run(kind, payload, opts = null) {
		if (!_enabled()) return { ok: false, disabled: true };
		const client = _getClient();
		if (!client) return { ok: false, disabled: true };
		const body = _redactDeep(payload);
		const options = (opts && typeof opts === "object") ? opts : {};

		const key = (() => {
			try {
				const mint = String(payload?.mint || payload?.targetMint || "");
				const ck = String(payload?.cacheKey || options?.cacheKey || "");
				return `${kind}:${mint || ck || "global"}`;
			} catch {
				return `${kind}:unknown`;
			}
		})();
		const prev = cache.get(key);
		if (prev && (now() - prev.at) < CACHE_TTL_MS) {
			try {
				const cfg = _getConfig() || {};
				const model = String(cfg.openaiModel || "gpt-4o-mini").trim() || "gpt-4o-mini";
				const mint = String(payload?.mint || payload?.targetMint || "").slice(0, 8);
				_log(`call kind=${String(kind)} mint=${mint} model=${model} (cache-hit)`, "info");
				const js = _fmtShortJson(body);
				if (js) _log(`payload ${js}`, "info");
				if (prev?.res?.ok) _log(`decision ${_fmtShortJson(prev.res.decision || {}, 1200)}`, "info");
			} catch {}
			return prev.res;
		}

		try {
			const cfg = _getConfig() || {};
			const model = String(cfg.openaiModel || "gpt-4o-mini").trim() || "gpt-4o-mini";
			const mint = String(payload?.mint || payload?.targetMint || "").slice(0, 8);
			_log(`call kind=${String(kind)} mint=${mint} model=${model}`, "info");
			const js = _fmtShortJson(body);
			if (js) _log(`payload ${js}`, "info");
		} catch {}

		const state = options.omitState
			? {}
			: _redactDeep(("stateOverride" in options) ? options.stateOverride : _getState());
		const userMsg = {
			source: "fdv_auto_trader",
			kind,
			state,
			payload: body,
		};

		const evolveSummary = (() => {
			try {
				const s = _readLsJson("fdv_agent_evolve_summary_v1", null);
				const txt = String(s?.text || "").trim();
				return txt ? txt.slice(0, 1400) : "";
			} catch {
				return "";
			}
		})();
		const systemPrompt = evolveSummary
			? `${GARY_SYSTEM_PROMPT}\n\n${evolveSummary}`
			: GARY_SYSTEM_PROMPT;

		let text = "";
		let meta = null;
		try {
			const req = {
				system: systemPrompt,
				user: JSON.stringify(userMsg),
				temperature: Number.isFinite(Number(options.temperature)) ? Number(options.temperature) : 0.15,
				maxTokens: Math.max(
					120,
					Number.isFinite(Number(options.maxTokens))
						? Number(options.maxTokens)
						: Number((_getConfig() || {}).maxTokens || 350)
				),
			};
			if (client && typeof client.chatJsonWithMeta === "function") {
				meta = await client.chatJsonWithMeta(req);
				text = String(meta?.text || "");
			} else {
				text = await client.chatJson(req);
			}
		} catch (e) {
			try { _log(`request failed: ${String(e?.message || e || "")}` , "warn"); } catch {}
			const res = { ok: false, err: String(e?.message || e || "") };
			cache.set(key, { at: now(), res });
			return res;
		}

		try {
			if (meta && typeof meta === "object") {
				const est = Number(meta.estPromptTokens || 0);
				const u = meta.usage || null;
				const pt = u && Number.isFinite(Number(u.promptTokens)) ? Number(u.promptTokens) : null;
				const ct = u && Number.isFinite(Number(u.completionTokens)) ? Number(u.completionTokens) : null;
				const tt = u && Number.isFinite(Number(u.totalTokens)) ? Number(u.totalTokens) : null;
				const parts = [];
				if (est > 0) parts.push(`estPrompt≈${est}`);
				if (pt !== null) parts.push(`prompt=${pt}`);
				if (ct !== null) parts.push(`completion=${ct}`);
				if (tt !== null) parts.push(`total=${tt}`);
				if (parts.length) _log(`tokens ${parts.join(" ")}`, "info");
			}
		} catch {}

		const parsed = _safeJsonParse(text);
		const validated = (kind === "buy")
			? _validateBuyDecision(parsed)
			: (kind === "sell")
				? _validateSellDecision(parsed)
				: (kind === "config_scan")
					? _validateConfigScanDecision(parsed)
					: null;
		const res = validated
			? { ok: true, decision: validated }
			: { ok: false, err: "invalid_json" };
		try {
			if (res.ok) {
				const d = res.decision || {};
				_log(`decision ${_fmtShortJson(d, 1200)}`, "info");
			} else {
				const snippet = String(text || "").slice(0, 600);
				_log(`bad response err=${String(res.err || "unknown")} raw=${_fmtShortJson(_redactDeep(snippet), 800)}`, "warn");
			}
		} catch {}
		cache.set(key, { at: now(), res });
		return res;
	}

	return {
		getConfigFromRuntime() {
			try {
				// Priority: explicit overrides on window -> localStorage.
				const g = (typeof window !== "undefined") ? window : globalThis;
				const o = g && g.__fdvAgentOverrides && typeof g.__fdvAgentOverrides === "object" ? g.__fdvAgentOverrides : null;
				const lsEnabled = _readBoolLs("fdv_agent_enabled", true);
				const riskRaw = String((o && o.riskLevel) ? o.riskLevel : _readLs("fdv_agent_risk", "safe")).trim().toLowerCase();
				const riskLevel = (riskRaw === "safe" || riskRaw === "medium" || riskRaw === "degen") ? riskRaw : "safe";
				return {
					enabled: o && ("enabled" in o) ? !!o.enabled : lsEnabled,
					riskLevel,
					openaiApiKey: (o && o.openaiApiKey) ? String(o.openaiApiKey) : _readLs("fdv_openai_key", ""),
					openaiModel: (o && o.openaiModel) ? String(o.openaiModel) : _readLs("fdv_openai_model", "gpt-4o-mini"),
					openaiBaseUrl: (o && o.openaiBaseUrl) ? String(o.openaiBaseUrl) : _readLs("fdv_openai_base_url", "https://api.openai.com/v1"),
					timeoutMs: _safeNum((o && o.timeoutMs) ? o.timeoutMs : _readLs("fdv_openai_timeout_ms", "12000"), 12000),
					maxTokens: _safeNum((o && o.maxTokens) ? o.maxTokens : _readLs("fdv_openai_max_tokens", "350"), 350),
				};
			} catch {
				return { enabled: false, openaiApiKey: "" };
			}
		},

		async decideBuy({ mint, proposedBuySolUi, proposedSlippageBps, signals } = {}) {
			const payload = {
				mint: String(mint || "").trim(),
				proposed: {
					buySolUi: _safeNum(proposedBuySolUi, 0),
					slippageBps: Math.floor(_safeNum(proposedSlippageBps, 0)),
				},
				signals: signals && typeof signals === "object" ? signals : {},
			};
			return await _run("buy", payload);
		},

		async decideSell({ mint, pos, ctx } = {}) {
			const payload = {
				mint: String(mint || "").trim(),
				pos: pos && typeof pos === "object" ? pos : {},
				ctx: ctx && typeof ctx === "object" ? ctx : {},
			};
			return await _run("sell", payload);
		},

		async scanConfig({ market, allowedKeys, keyHints, note, stateSummary } = {}) {
			const payload = {
				cacheKey: "startup",
				market: market && typeof market === "object" ? market : {},
				allowedKeys: Array.isArray(allowedKeys) ? allowedKeys.slice(0, 80).map(String) : [],
				// Keep request cheap: omit keyHints by default unless explicitly provided.
				keyHints: (keyHints && typeof keyHints === "object" && Object.keys(keyHints).length) ? keyHints : undefined,
				note: String(note || "").slice(0, 500),
			};
			const first = await _run("config_scan", payload, {
				cacheKey: "startup",
				temperature: 0.1,
				maxTokens: 650,
				stateOverride: stateSummary && typeof stateSummary === "object" ? stateSummary : {},
			});

			// Retry once if the model produced truncated/invalid JSON.
			if (first && first.ok === false && String(first.err || "") === "invalid_json") {
				const payload2 = {
					cacheKey: "startup_retry",
					market: market && typeof market === "object" ? market : {},
					allowedKeys: Array.isArray(allowedKeys) ? allowedKeys.slice(0, 80).map(String) : [],
					note: (String(note || "").slice(0, 380) + "\nRetry: return minimal JSON, only keys you would change. No prose.").slice(0, 500),
				};
				return await _run("config_scan", payload2, {
					cacheKey: "startup_retry",
					temperature: 0.05,
					maxTokens: 950,
					stateOverride: stateSummary && typeof stateSummary === "object" ? stateSummary : {},
				});
			}
			return first;
		},
	};
}
