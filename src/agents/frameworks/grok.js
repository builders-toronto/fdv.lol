function _safeNum(v, fallback = 0) {
	const n = Number(v);
	return Number.isFinite(n) ? n : fallback;
}

function _extractTextFromResponse(json) {
	try {
		if (!json || typeof json !== "object") return { text: "", why: "no_json" };
		if (json?.error?.message) return { text: "", why: `error:${String(json.error.message).slice(0, 120)}` };

		// Some providers / endpoints may place the final output text elsewhere.
		if (typeof json?.output_text === "string") {
			if (!json.output_text.trim()) return { text: "", why: "output_text_empty" };
			return { text: json.output_text, why: "output_text" };
		}
		if (Array.isArray(json?.output)) {
			const outParts = [];
			for (const item of json.output) {
				const content = item?.content;
				if (!Array.isArray(content)) continue;
				for (const c of content) {
					const t = c?.text;
					if (typeof t === "string" && t) outParts.push(t);
					else if (typeof c?.content === "string" && c.content) outParts.push(c.content);
				}
			}
			const joined = outParts.join("");
			if (joined.trim()) return { text: joined, why: "output_content" };
		}

		const choice = json?.choices?.[0] || null;
		if (!choice) return { text: "", why: "no_choices" };

		// Older / alternate shapes
		if (typeof choice?.text === "string") {
			if (!choice.text.trim()) return { text: "", why: "choice_text_empty" };
			return { text: choice.text, why: "choice_text" };
		}
		const msg = choice?.message || null;
		if (typeof msg?.output_text === "string") {
			if (!msg.output_text.trim()) return { text: "", why: "msg_output_text_empty" };
			return { text: msg.output_text, why: "msg_output_text" };
		}

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

		// Only consult delta *after* message.content to avoid returning a partial fragment.
		const delta = choice?.delta;
		if (typeof delta?.content === "string") {
			if (!delta.content.trim()) return { text: "", why: "delta_content_empty" };
			return { text: delta.content, why: "delta_content" };
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

function _wantsInputSchema(errText) {
	try {
		const s = String(errText || "").toLowerCase();
		return (
			s.includes("unknown field") && s.includes("messages")
		) || (
			s.includes("required") && s.includes("input")
		) || (
			s.includes("input") && s.includes("instead of") && s.includes("messages")
		);
	} catch {
		return false;
	}
}

function _buildBodyMessages({ model, system, user, temperature, maxTokens, omitTemperature = false, omitResponseFormat = false }) {
	const body = {
		model,
		messages: [
			{ role: "system", content: String(system || "") },
			{ role: "user", content: String(user || "") },
		],
	};
	if (!omitResponseFormat) body.response_format = { type: "json_object" };
	if (!omitTemperature) body.temperature = Math.max(0, Math.min(2, _safeNum(temperature, 0.15)));
	body.max_tokens = Math.max(64, Math.min(1200, Math.floor(_safeNum(maxTokens, 350))));
	return body;
}

function _buildBodyInput({ model, system, user, temperature, maxTokens, omitTemperature = false, omitResponseFormat = false }) {
	const body = {
		model,
		input: [
			{ role: "system", content: String(system || "") },
			{ role: "user", content: String(user || "") },
		],
	};
	// Some xAI-compatible endpoints accept response_format; if not, we retry without it.
	if (!omitResponseFormat) body.response_format = { type: "json_object" };
	if (!omitTemperature) body.temperature = Math.max(0, Math.min(2, _safeNum(temperature, 0.15)));
	body.max_tokens = Math.max(64, Math.min(1200, Math.floor(_safeNum(maxTokens, 350))));
	return body;
}

export function createGrokChatClient({
	apiKey,
	baseUrl = "https://api.x.ai/v1",
	model = "grok-3-mini",
	timeoutMs = 12_000,
	fetchFn,
} = {}) {
	const key = String(apiKey || "").trim();
	if (!key) throw new Error("Missing xAI apiKey");
	const urlBase = String(baseUrl || "https://api.x.ai/v1").trim() || "https://api.x.ai/v1";
	const m = String(model || "grok-3-mini").trim() || "grok-3-mini";
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
			let useInputSchema = false;

			const doReq = async () => {
				const body = useInputSchema
					? _buildBodyInput({ model: m, system, user, temperature, maxTokens, omitTemperature, omitResponseFormat })
					: _buildBodyMessages({ model: m, system, user, temperature, maxTokens, omitTemperature, omitResponseFormat });
				return _fetch(endpoint, { ...baseReq, body: JSON.stringify(body) });
			};

			let resp = await doReq();
			if (!resp.ok) {
				const txt = await resp.text().catch(() => "");
				// Retry 1: if endpoint expects input[] instead of messages[]
				if (!useInputSchema && resp.status === 400 && _wantsInputSchema(txt)) {
					useInputSchema = true;
					resp = await doReq();
				}
				if (!resp.ok) {
					throw new Error(`xAI HTTP ${resp.status}: ${txt.slice(0, 300)}`);
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
			if (json?.error?.message) throw new Error(`xAI error: ${String(json.error.message).slice(0, 220)}`);
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

			// Retry once without response_format if structured output isn't supported.
			if (!omitResponseFormat) {
				omitResponseFormat = true;
				resp = await doReq();
				if (!resp.ok) {
					const txt2 = await resp.text().catch(() => "");
					throw new Error(`xAI HTTP ${resp.status}: ${txt2.slice(0, 300)}`);
				}
				const json2 = await resp.json();
				if (json2?.error?.message) throw new Error(`xAI error: ${String(json2.error.message).slice(0, 220)}`);
				const ext2 = _extractTextFromResponse(json2);
				const out2 = String(ext2?.text || "");
				if (out2 && out2.trim()) {
					return {
						text: out2,
						usage: _extractUsageFromResponse(json2) || usage,
						requestId: reqId || "",
						model: String(json2?.model || json?.model || m || ""),
						estPromptTokens,
					};
				}
			}

			const why = String(ext?.why || "unknown");
			throw new Error(
				`xAI: empty content (why=${why}` +
					(m ? ` model=${m}` : "") +
					(reqId ? ` reqId=${reqId}` : "") +
				`)`
			);
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