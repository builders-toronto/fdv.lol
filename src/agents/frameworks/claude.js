function _safeNum(v, fallback = 0) {
	const n = Number(v);
	return Number.isFinite(n) ? n : fallback;
}

function _stripCodeFence(s) {
	try {
		const t = String(s || "").trim();
		if (!t) return "";
		// ```json ... ``` or ``` ... ```
		const m = t.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
		if (m && m[1]) return m[1].trim();
		return t;
	} catch {
		return String(s || "");
	}
}

function _extractTextFromResponse(json) {
	try {
		if (!json || typeof json !== "object") return { text: "", why: "no_json" };
		if (json?.error?.message) return { text: "", why: `error:${String(json.error.message).slice(0, 120)}` };
		if (json?.type === "error") {
			const m = String(json?.error?.message || json?.message || "anthropic_error");
			return { text: "", why: `error:${m.slice(0, 120)}` };
		}

		const content = json?.content;
		if (!Array.isArray(content) || !content.length) return { text: "", why: "no_content" };

		const parts = [];
		for (const block of content) {
			if (!block || typeof block !== "object") continue;
			const t = String(block.type || "").toLowerCase();
			if (t === "text" && typeof block.text === "string") {
				parts.push(block.text);
			} else if (t === "tool_use" && block.input && typeof block.input === "object") {
				try { parts.push(JSON.stringify(block.input)); } catch {}
			} else if (typeof block.text === "string") {
				parts.push(block.text);
			}
		}
		const joined = parts.join("");
		if (!joined.trim()) return { text: "", why: "content_empty" };
		return { text: joined, why: "content" };
	} catch {
		return { text: "", why: "extract_err" };
	}
}

function estimateTokensForText(text) {
	try {
		const s = String(text || "");
		if (!s) return 0;
		// Claude's tokenizer is similar density to GPT; ~1 token / ~3.5-4 chars is a fine estimate.
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
			? (promptTokens + completionTokens)
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

function _buildBody({ model, system, user, temperature, maxTokens, jsonPrefill = true }) {
	const sys = String(system || "").trim();
	const usr = String(user || "");
	const messages = [{ role: "user", content: usr }];
	if (jsonPrefill) {
		// Force JSON output via assistant prefill — Anthropic has no `response_format: json_object`,
		// so we seed the assistant turn with `{` and stitch it back onto the response text.
		messages.push({ role: "assistant", content: "{" });
	}
	const body = {
		model,
		max_tokens: Math.max(64, Math.min(4096, Math.floor(_safeNum(maxTokens, 350)))),
		messages,
	};
	if (sys) body.system = sys;
	// Claude accepts 0..1 for temperature.
	body.temperature = Math.max(0, Math.min(1, _safeNum(temperature, 0.15)));
	return body;
}

export function createClaudeChatClient({
	apiKey,
	baseUrl = "https://api.anthropic.com",
	model = "claude-haiku-4-5",
	timeoutMs = 12_000,
	fetchFn,
	anthropicVersion = "2023-06-01",
} = {}) {
	const key = String(apiKey || "").trim();
	if (!key) throw new Error("Missing Anthropic apiKey");
	const urlBase = String(baseUrl || "https://api.anthropic.com").trim() || "https://api.anthropic.com";
	const m = String(model || "claude-haiku-4-5").trim() || "claude-haiku-4-5";
	const _fetch = typeof fetchFn === "function" ? fetchFn : (typeof fetch !== "undefined" ? fetch : null);
	if (!_fetch) throw new Error("fetch unavailable");
	const apiVersion = String(anthropicVersion || "2023-06-01").trim() || "2023-06-01";

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

			const endpoint = `${urlBase.replace(/\/$/, "")}/v1/messages`;
			const baseReq = {
				method: "POST",
				signal: ctl.signal,
				headers: {
					"Content-Type": "application/json",
					"x-api-key": key,
					"anthropic-version": apiVersion,
					// Required when calling the API directly from a browser-like fetch implementation.
					"anthropic-dangerous-direct-browser-access": "true",
				},
			};

			let jsonPrefill = true;
			const doReq = () => _fetch(endpoint, {
				...baseReq,
				body: JSON.stringify(_buildBody({ model: m, system, user, temperature, maxTokens, jsonPrefill })),
			});

			let resp = await doReq();
			if (!resp.ok) {
				const txt = await resp.text().catch(() => "");
				// If prefill caused a 400 (rare provider quirks), retry once without it.
				if (resp.status === 400 && jsonPrefill && /assistant|prefill|trailing|whitespace/i.test(txt)) {
					jsonPrefill = false;
					resp = await doReq();
					if (!resp.ok) {
						const txt2 = await resp.text().catch(() => "");
						throw new Error(`Anthropic HTTP ${resp.status}: ${txt2.slice(0, 300)}`);
					}
				} else {
					throw new Error(`Anthropic HTTP ${resp.status}: ${txt.slice(0, 300)}`);
				}
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
			let out = String(ext?.text || "");
			if (jsonPrefill && out) {
				// Stitch back the prefilled `{` so downstream JSON.parse works.
				const trimmed = out.trimStart();
				if (!trimmed.startsWith("{")) out = "{" + out;
			}
			out = _stripCodeFence(out);

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
//         "max_tokens": 512,
//         "system": "Reply with valid JSON only.",
//         "messages": [
//           {"role": "user", "content": "Return {\"ok\":true}"}
//         ]
//       }'
