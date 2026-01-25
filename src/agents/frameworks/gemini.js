function _safeNum(v, fallback = 0) {
	const n = Number(v);
	return Number.isFinite(n) ? n : fallback;
}

function _clampInt(v, min, max, fallback) {
	try {
		const n = Math.floor(Number(v));
		if (!Number.isFinite(n)) return fallback;
		return Math.max(min, Math.min(max, n));
	} catch {
		return fallback;
	}
}

function _extractTextFromResponse(json) {
	try {
		if (!json || typeof json !== "object") return { text: "", why: "no_json" };
		if (json?.error?.message) return { text: "", why: `error:${String(json.error.message).slice(0, 120)}` };

		const c0 = json?.candidates?.[0] || null;
		const parts = c0?.content?.parts;
		if (Array.isArray(parts)) {
			const out = parts
				.map((p) => {
					if (!p) return "";
					if (typeof p.text === "string") return p.text;
					return "";
				})
				.filter(Boolean)
				.join("");
			if (out.trim()) return { text: out, why: "parts_text" };
		}

		// Some API variants may return a direct string.
		if (typeof c0?.output === "string" && c0.output.trim()) return { text: c0.output, why: "candidate_output" };

		const blocked = json?.promptFeedback?.blockReason || c0?.finishReason;
		if (blocked) return { text: "", why: `blocked:${String(blocked).slice(0, 120)}` };
		return { text: "", why: "no_content" };
	} catch {
		return { text: "", why: "extract_err" };
	}
}

function _extractUsageFromResponse(json) {
	try {
		const u = json?.usageMetadata;
		if (!u || typeof u !== "object") return null;
		const promptTokens = Number(u.promptTokenCount ?? NaN);
		const completionTokens = Number(u.candidatesTokenCount ?? NaN);
		const totalTokens = Number(u.totalTokenCount ?? NaN);
		return {
			promptTokens: Number.isFinite(promptTokens) ? Math.floor(promptTokens) : null,
			completionTokens: Number.isFinite(completionTokens) ? Math.floor(completionTokens) : null,
			totalTokens: Number.isFinite(totalTokens) ? Math.floor(totalTokens) : null,
		};
	} catch {
		return null;
	}
}

function _normModelForPath(model) {
	try {
		let s = String(model || "").trim();
		if (!s) return "";
		// Accept callers passing "models/<name>"; endpoint expects "models/<name>".
		if (!/^models\//i.test(s)) s = `models/${s}`;
		return s;
	} catch {
		return "";
	}
}

export function createGeminiChatClient({
	apiKey,
	baseUrl = "https://generativelanguage.googleapis.com/v1beta",
	model = "gemini-2.5-flash-lite",
	timeoutMs = 12_000,
	fetchFn,
} = {}) {
	const key = String(apiKey || "").trim();
	if (!key) throw new Error("Missing Gemini apiKey");

	const urlBase = String(baseUrl || "https://generativelanguage.googleapis.com/v1beta").trim() || "https://generativelanguage.googleapis.com/v1beta";
	const m = String(model || "gemini-2.5-flash-lite").trim() || "gemini-2.5-flash-lite";
	const modelPath = _normModelForPath(m);
	if (!modelPath) throw new Error("Missing Gemini model");

	const _fetch = typeof fetchFn === "function" ? fetchFn : (typeof fetch !== "undefined" ? fetch : null);
	if (!_fetch) throw new Error("fetch unavailable");

	function estimateTokensForText(text) {
		try {
			const s = String(text || "");
			if (!s) return 0;
			return Math.max(0, Math.ceil(s.length / 4));
		} catch {
			return 0;
		}
	}

	async function chatJsonWithMeta({ system, user, temperature = 0.15, maxTokens = 950 } = {}) {
		const ctl = new AbortController();
		const to = setTimeout(() => {
			try { ctl.abort(); } catch {}
		}, Math.max(2000, _safeNum(timeoutMs, 12_000)));

		try {
			const estPromptTokens =
				estimateTokensForText(system) +
				estimateTokensForText(user) +
				60;

			const endpoint = `${urlBase.replace(/\/$/, "")}/${modelPath}:generateContent`;
			const url = `${endpoint}?key=${encodeURIComponent(key)}`;

			const body = {
				systemInstruction: {
					parts: [{ text: String(system || "") }],
				},
				contents: [
					{
						role: "user",
						parts: [{ text: String(user || "") }],
					},
				],
				generationConfig: {
					temperature: Math.max(0, Math.min(2, _safeNum(temperature, 0.15))),
					maxOutputTokens: _clampInt(maxTokens, 64, 8192, 950),
					// Strong hint for strict JSON responses.
					responseMimeType: "application/json",
				},
			};

			const resp = await _fetch(url, {
				method: "POST",
				signal: ctl.signal,
				headers: {
					"Content-Type": "application/json",
					// Header is redundant when using ?key=, but helps for proxies.
					"x-goog-api-key": key,
				},
				body: JSON.stringify(body),
			});

			if (!resp.ok) {
				const txt = await resp.text().catch(() => "");
				throw new Error(`Gemini HTTP ${resp.status}: ${txt.slice(0, 300)}`);
			}

			const reqId = (() => {
				try {
					return String(
						resp?.headers?.get("x-request-id") ||
						resp?.headers?.get("x-goog-request-id") ||
						resp?.headers?.get("x-requestid") ||
						""
					).trim();
				} catch {
					return "";
				}
			})();

			const json = await resp.json();
			if (json?.error?.message) throw new Error(`Gemini error: ${String(json.error.message).slice(0, 220)}`);
			const usage = _extractUsageFromResponse(json);

			const ext = _extractTextFromResponse(json);
			const out = String(ext?.text || "");
			if (out && out.trim()) {
				return {
					text: out,
					usage,
					requestId: reqId,
					model: m,
					estPromptTokens,
				};
			}

			const why = String(ext?.why || "unknown");
			throw new Error(`Gemini: empty content (why=${why}${reqId ? ` reqId=${reqId}` : ""})`);
		} finally {
			clearTimeout(to);
		}
	}

	async function chatJson({ system, user, temperature = 0.15, maxTokens = 950 } = {}) {
		const res = await chatJsonWithMeta({ system, user, temperature, maxTokens });
		return String(res?.text || "");
	}

	return { chatJson, chatJsonWithMeta, estimateTokensForText };
}