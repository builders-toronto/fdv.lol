function _safeNum(v, fallback = 0) {
	const n = Number(v);
	return Number.isFinite(n) ? n : fallback;
}

function _trimSlash(s) {
	try {
		return String(s || "").trim().replace(/\/+$/, "");
	} catch {
		return "";
	}
}

function _hexFromBytes(bytes) {
	let out = "";
	for (let i = 0; i < bytes.length; i++) {
		out += bytes[i].toString(16).padStart(2, "0");
	}
	return out;
}

async function _hmacSha256Hex(secret, bodyStr) {
	try {
		const s = String(secret || "");
		if (!s) return "";
		const cryptoObj = (typeof globalThis !== "undefined") ? globalThis.crypto : null;
		const subtle = cryptoObj && cryptoObj.subtle ? cryptoObj.subtle : null;
		if (!subtle) return "";
		const enc = new TextEncoder();
		const key = await subtle.importKey(
			"raw",
			enc.encode(s),
			{ name: "HMAC", hash: "SHA-256" },
			false,
			["sign"],
		);
		const sig = await subtle.sign("HMAC", key, enc.encode(String(bodyStr || "")));
		return _hexFromBytes(new Uint8Array(sig));
	} catch {
		return "";
	}
}

export function createGaryPredictionsChatClient({
	apiKey,
	baseUrl = "",
	model = "gary-predictions-v1",
	timeoutMs = 45_000,
	fetchFn,
	hmacSecret = "",
	sendSystem = false,
} = {}) {
	const key = String(apiKey || "").trim();
	if (!key) throw new Error("Missing Gary API key");
	const urlBase = _trimSlash(baseUrl) || "";
	const m = String(model || "gary-predictions-v1").trim() || "gary-predictions-v1";
	const defaultSendSystem = Boolean(sendSystem);
	const _fetch = typeof fetchFn === "function" ? fetchFn : (typeof fetch !== "undefined" ? fetch : null);
	if (!_fetch) throw new Error("fetch unavailable");

	async function _postJson(path, obj, { timeoutMs: tms } = {}) {
		const to = Math.max(1500, Math.floor(_safeNum(tms, timeoutMs)));
		const controller = typeof AbortController !== "undefined" ? new AbortController() : null;
		let timer = null;
		if (controller) {
			timer = setTimeout(() => {
				try { controller.abort(); } catch {}
			}, to);
		}

		const bodyStr = JSON.stringify(obj ?? {});
		const headers = {
			"Content-Type": "application/json",
			"Authorization": `Bearer ${key}`,
		};
		try {
			const sig = await _hmacSha256Hex(hmacSecret, bodyStr);
			if (sig) headers["X-FDV-Signature"] = sig;
		} catch {}

		const started = Date.now();
		try {
			const res = await _fetch(`${urlBase}${path}`, {
				method: "POST",
				headers,
				body: bodyStr,
				signal: controller ? controller.signal : undefined,
			});
			const txt = await res.text();
			let json = null;
			try { json = JSON.parse(txt || "{}"); } catch { json = null; }
			if (!res.ok) {
				const detail = (json && (json.detail || json.err)) ? String(json.detail || json.err) : String(txt || res.statusText || "request_failed");
				const e = new Error(detail);
				e.status = res.status;
				throw e;
			}
			return {
				ok: true,
				json,
				elapsedMs: Math.max(0, Date.now() - started),
				rawText: txt,
			};
		} finally {
			if (timer) clearTimeout(timer);
		}
	}

	async function chatJsonWithMeta({ system, user, temperature = 0.2, maxTokens = 220, sendSystem: sendSystemOverride } = {}) {
		let userMsg = null;
		try { userMsg = JSON.parse(String(user || "{}")); } catch { userMsg = null; }
		const kind = String(userMsg?.kind || "").trim().toLowerCase();
		const t = Math.max(0.0, Math.min(2, _safeNum(temperature, 0.2)));
		const greedy = t <= 0.15;
		// Give the model enough room to close braces, but rely on server stop-on-JSON.
		const maxNew = Math.max(96, Math.min(700, Math.floor(_safeNum(maxTokens, 220) + 120)));

		const sys = String(system || "").trim();
		const sendSys = (typeof sendSystemOverride === "boolean") ? sendSystemOverride : defaultSendSystem;

		const payload = {
			kind: kind || "buy",
			...(sendSys && sys ? { system: sys } : {}),
			userMsg: (userMsg && typeof userMsg === "object") ? userMsg : undefined,
			// fallbacks if userMsg wasn't parseable
			state: (userMsg && typeof userMsg === "object") ? (userMsg.state || {}) : {},
			payload: (userMsg && typeof userMsg === "object") ? (userMsg.payload || {}) : {},
			maxNewTokens: maxNew,
			temperature: Math.max(0.0, t),
			greedy,
			strict: true,
		};

		const r = await _postJson("/v1/predict", payload, { timeoutMs });
		const js = r.json && typeof r.json === "object" ? r.json : {};
		if (!js.ok) throw new Error(String(js.err || js.detail || "predict_failed"));
		const parsed = (js && Object.prototype.hasOwnProperty.call(js, "parsed")) ? (js.parsed ?? null) : null;
		const text = String(js.text || "");
		return {
			text,
			parsed,
			provider: "gary",
			model: m,
			baseUrl: urlBase,
			elapsedMs: r.elapsedMs,
			usage: null,
			// crude heuristic for driver logging
			estPromptTokens: Math.max(0, Math.ceil((String(system || "").length + String(user || "").length) / 4)),
		};
	}

	async function chatJson(req = {}) {
		const meta = await chatJsonWithMeta(req);
		// Prefer the server-extracted JSON to avoid bot-side invalid_json blocks.
		if (meta.parsed && (typeof meta.parsed === "object" || Array.isArray(meta.parsed))) {
			try { return JSON.stringify(meta.parsed); } catch {}
		}
		return String(meta.text || "");
	}

	return {
		provider: "gary",
		chatJson,
		chatJsonWithMeta,
	};
}