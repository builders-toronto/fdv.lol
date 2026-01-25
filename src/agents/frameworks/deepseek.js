function _safeNum(v, fallback = 0) {
	const n = Number(v);
	return Number.isFinite(n) ? n : fallback;
}

function _extractTextFromResponse(json) {
	try {
		if (!json || typeof json !== "object") return { text: "", why: "no_json" };
		if (json?.error?.message) return { text: "", why: `error:${String(json.error.message).slice(0, 120)}` };

		const choice = json?.choices?.[0] || null;
		if (!choice) return { text: "", why: "no_choices" };

		// Older / alternate shapes
		if (typeof choice?.text === "string") {
			if (!choice.text.trim()) return { text: "", why: "choice_text_empty" };
			return { text: choice.text, why: "choice_text" };
		}

		const msg = choice?.message || null;
		const c = msg?.content;
		if (typeof c === "string") {
			if (!c.trim()) return { text: "", why: "content_empty" };
			return { text: c, why: "content" };
		}
		if (Array.isArray(c)) {
			const parts = c
				.map((p) => {
					if (typeof p === "string") return p;
					if (p && typeof p === "object") return String(p.text || p.content || "");
					return "";
				})
				.filter(Boolean);
			if (parts.length) return { text: parts.join(""), why: "content_parts" };
		}

		const toolArgs = msg?.tool_calls?.[0]?.function?.arguments;
		if (typeof toolArgs === "string") {
			if (!toolArgs.trim()) return { text: "", why: "tool_call_args_empty" };
			return { text: toolArgs, why: "tool_call_args" };
		}

		const refusal = msg?.refusal ?? choice?.refusal;
		if (refusal) return { text: "", why: `refusal:${String(refusal).slice(0, 120)}` };

		return { text: "", why: "no_content" };
	} catch {
		return { text: "", why: "extract_err" };
	}
}

function estimateTokensForText(text) {
	try {
		const s = String(text || "");
		if (!s) return 0;
		// Practical heuristic: ~1 token per ~4 chars.
		return Math.max(0, Math.ceil(s.length / 4));
	} catch {
		return 0;
	}
}

function _extractUsageFromResponse(json) {
	try {
		const u = json?.usage;
		if (!u || typeof u !== "object") return null;
		const promptTokens = Number(u.prompt_tokens ?? u.input_tokens ?? NaN);
		const completionTokens = Number(u.completion_tokens ?? u.output_tokens ?? NaN);
		const totalTokens = Number(u.total_tokens ?? NaN);
		return {
			promptTokens: Number.isFinite(promptTokens) ? Math.floor(promptTokens) : null,
			completionTokens: Number.isFinite(completionTokens) ? Math.floor(completionTokens) : null,
			totalTokens: Number.isFinite(totalTokens) ? Math.floor(totalTokens) : null,
		};
	} catch {
		return null;
	}
}

function _wantsNoResponseFormat(errText) {
	try {
		const s = String(errText || "").toLowerCase();
		return (
			s.includes("unknown") && s.includes("response_format")
		) || (
			s.includes("unrecognized") && s.includes("response_format")
		) || (
			s.includes("extra fields") && s.includes("response_format")
		);
	} catch {
		return false;
	}
}

function _buildBody({ model, system, user, temperature, maxTokens, omitTemperature = false, omitResponseFormat = false }) {
	const body = {
		model,
		messages: [
			{ role: "system", content: String(system || "") },
			{ role: "user", content: String(user || "") },
		],
		stream: false,
	};
	if (!omitResponseFormat) body.response_format = { type: "json_object" };
	if (!omitTemperature) body.temperature = Math.max(0, Math.min(2, _safeNum(temperature, 0.15)));
	body.max_tokens = Math.max(64, Math.min(1200, Math.floor(_safeNum(maxTokens, 350))));
	return body;
}

export function createDeepSeekChatClient({
	apiKey,
	baseUrl = "https://api.deepseek.com",
	model = "deepseek-chat",
	timeoutMs = 12_000,
	fetchFn,
} = {}) {
	const key = String(apiKey || "").trim();
	if (!key) throw new Error("Missing DeepSeek apiKey");
	const urlBase = String(baseUrl || "https://api.deepseek.com").trim() || "https://api.deepseek.com";
	const m = String(model || "deepseek-chat").trim() || "deepseek-chat";
	const _fetch = typeof fetchFn === "function" ? fetchFn : (typeof fetch !== "undefined" ? fetch : null);
	if (!_fetch) throw new Error("fetch unavailable");

	async function chatJsonWithMeta({ system, user, temperature = 0.15, maxTokens = 950, verbosity = "low" } = {}) {
		void verbosity;
		const ctl = new AbortController();
		const to = setTimeout(() => {
			try { ctl.abort(); } catch {}
		}, Math.max(2000, _safeNum(timeoutMs, 12_000)));

		try {
			const estPromptTokens =
				estimateTokensForText(system) +
				estimateTokensForText(user) +
				60;

			const endpoint = `${urlBase.replace(/\/$/, "")}/chat/completions`;
			const baseReq = {
				method: "POST",
				signal: ctl.signal,
				headers: {
					"Content-Type": "application/json",
					"Authorization": `Bearer ${key}`,
				},
			};

			let omitTemperature = false;
			let omitResponseFormat = false;

			const doReq = async () => {
				const body = _buildBody({ model: m, system, user, temperature, maxTokens, omitTemperature, omitResponseFormat });
				return _fetch(endpoint, { ...baseReq, body: JSON.stringify(body) });
			};

			let resp = await doReq();
			if (!resp.ok) {
				const txt = await resp.text().catch(() => "");
				if (!omitResponseFormat && resp.status === 400 && _wantsNoResponseFormat(txt)) {
					omitResponseFormat = true;
					resp = await doReq();
				}
				if (!resp.ok) {
					throw new Error(`DeepSeek HTTP ${resp.status}: ${txt.slice(0, 300)}`);
				}
			}

			const reqId = (() => {
				try {
					return String(resp?.headers?.get("x-request-id") || resp?.headers?.get("x-requestid") || "").trim();
				} catch {
					return "";
				}
			})();

			const json = await resp.json();
			if (json?.error?.message) throw new Error(`DeepSeek error: ${String(json.error.message).slice(0, 220)}`);
			const usage = _extractUsageFromResponse(json);

			const ext = _extractTextFromResponse(json);
			const out = String(ext?.text || "");
			if (out && out.trim()) {
				return {
					text: out,
					usage,
					requestId: reqId || "",
					model: String(json?.model || m || ""),
					estPromptTokens,
				};
			}

			const why = String(ext?.why || "unknown");
			throw new Error(`DeepSeek: empty content (why=${why}${reqId ? ` reqId=${reqId}` : ""})`);
		} finally {
			clearTimeout(to);
		}
	}

	async function chatJson({ system, user, temperature = 0.15, maxTokens = 950, verbosity = "low" } = {}) {
		const res = await chatJsonWithMeta({ system, user, temperature, maxTokens, verbosity });
		return String(res?.text || "");
	}

	return { chatJson, chatJsonWithMeta, estimateTokensForText };
}

// curl https://api.deepseek.com/chat/completions \
//   -H "Content-Type: application/json" \
//   -H "Authorization: Bearer ${DEEPSEEK_API_KEY}" \
//   -d '{
//         "model": "deepseek-chat",
//         "messages": [
//           {"role": "system", "content": "You are a helpful assistant."},
//           {"role": "user", "content": "Hello!"}
//         ],
//         "stream": false
//       }'

