function _safeNum(v, fallback = 0) {
	const n = Number(v);
	return Number.isFinite(n) ? n : fallback;
}

function _extractTextFromResponse(json) {
	try {
		if (!json || typeof json !== "object") return { text: "", why: "no_json" };
		if (json?.error?.message) return { text: "", why: `error:${String(json.error.message).slice(0, 120)}` };

		// Anthropic Messages API: { content: [{ type: "text", text: "..." }, ...] }
		const blocks = Array.isArray(json?.content) ? json.content : null;
		if (!blocks || !blocks.length) return { text: "", why: "no_content_blocks" };

		const parts = blocks
			.map((b) => {
				if (typeof b === "string") return b;
				if (b && typeof b === "object" && b.type === "text") return String(b.text || "");
				return "";
			})
			.filter(Boolean);

		if (parts.length) {
			const text = parts.join("");
			if (!text.trim()) return { text: "", why: "content_empty" };
			return { text, why: "content_blocks" };
		}

		if (json?.stop_reason === "max_tokens") return { text: "", why: "max_tokens_no_text" };
		return { text: "", why: "no_text_blocks" };
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
		const promptTokens = Number(u.input_tokens ?? NaN);
		const completionTokens = Number(u.output_tokens ?? NaN);
		const totalTokens = (Number.isFinite(promptTokens) && Number.isFinite(completionTokens))
			? promptTokens + completionTokens
			: NaN;
		return {
			promptTokens: Number.isFinite(promptTokens) ? Math.floor(promptTokens) : null,
			completionTokens: Number.isFinite(completionTokens) ? Math.floor(completionTokens) : null,
			totalTokens: Number.isFinite(totalTokens) ? Math.floor(totalTokens) : null,
		};
	} catch {
		return null;
	}
}

function _buildBody({ model, system, user, temperature, maxTokens }) {
	return {
		model,
		system: String(system || ""),
		messages: [
			{ role: "user", content: String(user || "") },
		],
		// Anthropic temperature range is 0..1.
		temperature: Math.max(0, Math.min(1, _safeNum(temperature, 0.15))),
		max_tokens: Math.max(64, Math.min(1200, Math.floor(_safeNum(maxTokens, 350)))),
		stream: false,
	};
}

export function createAnthropicChatClient({
	apiKey,
	baseUrl = "https://api.anthropic.com",
	model = "claude-haiku-4-5",
	timeoutMs = 12_000,
	fetchFn,
} = {}) {
	const key = String(apiKey || "").trim();
	if (!key) throw new Error("Missing Anthropic apiKey");
	const urlBase = String(baseUrl || "https://api.anthropic.com").trim() || "https://api.anthropic.com";
	const m = String(model || "claude-haiku-4-5").trim() || "claude-haiku-4-5";
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

			// Tolerate base URLs given with or without a trailing /v1.
			const root = urlBase.replace(/\/$/, "").replace(/\/v1$/, "");
			const endpoint = `${root}/v1/messages`;
			const body = _buildBody({ model: m, system, user, temperature, maxTokens });

			const resp = await _fetch(endpoint, {
				method: "POST",
				signal: ctl.signal,
				headers: {
					"Content-Type": "application/json",
					"x-api-key": key,
					"anthropic-version": "2023-06-01",
					// Required for client-side (browser) calls; harmless in Node.
					"anthropic-dangerous-direct-browser-access": "true",
				},
				body: JSON.stringify(body),
			});

			if (!resp.ok) {
				const txt = await resp.text().catch(() => "");
				throw new Error(`Anthropic HTTP ${resp.status}: ${txt.slice(0, 300)}`);
			}

			const reqId = (() => {
				try {
					return String(resp?.headers?.get("request-id") || resp?.headers?.get("x-request-id") || "").trim();
				} catch {
					return "";
				}
			})();

			const json = await resp.json();
			if (json?.error?.message) throw new Error(`Anthropic error: ${String(json.error.message).slice(0, 220)}`);
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
			throw new Error(`Anthropic: empty content (why=${why}${reqId ? ` reqId=${reqId}` : ""})`);
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

// curl https://api.anthropic.com/v1/messages \
//   -H "Content-Type: application/json" \
//   -H "x-api-key: ${ANTHROPIC_API_KEY}" \
//   -H "anthropic-version: 2023-06-01" \
//   -d '{
//         "model": "claude-haiku-4-5",
//         "max_tokens": 350,
//         "system": "You are a helpful assistant.",
//         "messages": [{"role": "user", "content": "Hello!"}]
//       }'
