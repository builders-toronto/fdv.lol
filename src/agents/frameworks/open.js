function _safeNum(v, fallback = 0) {
	const n = Number(v);
	return Number.isFinite(n) ? n : fallback;
}

export function createOpenAIChatClient({
	apiKey,
	baseUrl = "https://api.openai.com/v1",
	model = "gpt-4o-mini",
	timeoutMs = 12_000,
	fetchFn,
} = {}) {
	const key = String(apiKey || "").trim();
	if (!key) throw new Error("Missing OpenAI apiKey");
	const urlBase = String(baseUrl || "https://api.openai.com/v1").trim() || "https://api.openai.com/v1";
	const m = String(model || "gpt-4o-mini").trim() || "gpt-4o-mini";
	const _fetch = typeof fetchFn === "function" ? fetchFn : (typeof fetch !== "undefined" ? fetch : null);
	if (!_fetch) throw new Error("fetch unavailable");

	function _normModel(modelName) {
		try {
			return String(modelName || "").trim().toLowerCase();
		} catch {
			return "";
		}
	}

	function _isGpt5(modelName) {
		const s = _normModel(modelName);
		return /(?:^|\/)gpt-5\b/.test(s);
	}

	function _isGpt5OrO(modelName) {
		const s = _normModel(modelName);
		return /(?:^|\/)gpt-5\b/.test(s) || /(?:^|\/)o\d+\b/.test(s);
	}

	function _prefersResponsesApi(modelName) {
		try {
			return _isGpt5OrO(modelName);
		} catch {
			return false;
		}
	}

	function _usesMaxCompletionTokens(modelName) {
		try {
			return _isGpt5OrO(modelName);
		} catch {
			return false;
		}
	}

	function _supportsTemperature(modelName) {
		try {
			return !_isGpt5OrO(modelName);
		} catch {
			return true;
		}
	}

	function _looksLikeTruncatedJson(text) {
		try {
			const s = String(text || "");
			const t = s.trim();
			if (!t) return false;
			if (t.startsWith("{")) return !t.endsWith("}");
			if (t.startsWith("[")) return !t.endsWith("]");

			// If the JSON is embedded after a preface, still detect likely cut-off.
			const i0 = t.indexOf("{");
			if (i0 >= 0) {
				const i1 = t.lastIndexOf("}");
				if (i1 < i0) return true;
				const open = (t.match(/\{/g) || []).length;
				const close = (t.match(/\}/g) || []).length;
				if (open > 0 && close > 0 && close < open) return true;
			}
			return false;
		} catch {
			return false;
		}
	}

	function _extractTextFromResponsesOutput(output) {
		try {
			if (!output) return { text: "", why: "responses_no_output" };
			const items = Array.isArray(output) ? output : [output];
			const outParts = [];
			for (const item of items) {
				if (!item || typeof item !== "object") continue;
				// Common: { type: 'message', role: 'assistant', content: [{type:'output_text', text:'...'}] }
				if (Array.isArray(item.content)) {
					for (const c of item.content) {
						if (!c || typeof c !== "object") continue;
						if (typeof c.text === "string" && c.text) outParts.push(c.text);
						else if (typeof c.content === "string" && c.content) outParts.push(c.content);
						else if (typeof c.output_text === "string" && c.output_text) outParts.push(c.output_text);
						// Some SDKs wrap text in { value: '...' }
						else if (c.text && typeof c.text === "object" && typeof c.text.value === "string" && c.text.value) outParts.push(c.text.value);
					}
					continue;
				}
				// Tool/function-call style output.
				if (typeof item.arguments === "string" && item.arguments) outParts.push(item.arguments);
				if (typeof item.output_text === "string" && item.output_text) outParts.push(item.output_text);
			}
			const joined = outParts.join("");
			if (joined.trim()) return { text: joined, why: "responses_output" };
			return { text: "", why: "responses_output_empty" };
		} catch {
			return { text: "", why: "responses_output_err" };
		}
	}

	function _extractResponsesEnvelope(json) {
		try {
			if (!json || typeof json !== "object") return null;
			if (Array.isArray(json.output) || (json.output && typeof json.output === "object")) return json.output;
			if (json.response && (Array.isArray(json.response.output) || typeof json.response.output === "object")) return json.response.output;
			if (json.data && (Array.isArray(json.data.output) || typeof json.data.output === "object")) return json.data.output;
			if (Array.isArray(json.responses) && json.responses[0] && (Array.isArray(json.responses[0].output) || typeof json.responses[0].output === "object")) return json.responses[0].output;
			return null;
		} catch {
			return null;
		}
	}

	function _extractTextFromResponse(json) {
		try {
			if (!json || typeof json !== "object") return { text: "", why: "no_json" };
			if (json?.error?.message) return { text: "", why: `error:${String(json.error.message).slice(0, 120)}` };

			// Responses API shapes (OpenAI GPT-5 / o*)
			const env = _extractResponsesEnvelope(json);
			if (env) {
				const r = _extractTextFromResponsesOutput(env);
				if (r && typeof r.text === "string" && r.text.trim()) return r;
			}

			// Some providers / endpoints may place the final output text elsewhere.
			if (typeof json?.output_text === "string") {
				if (!json.output_text.trim()) return { text: "", why: "output_text_empty" };
				return { text: json.output_text, why: "output_text" };
			}
			if (Array.isArray(json?.output)) {
				const r = _extractTextFromResponsesOutput(json.output);
				if (r && typeof r.text === "string" && r.text.trim()) return { text: r.text, why: "output_content" };
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
		// Practical heuristic: ~1 token per ~4 chars for typical English, ~1 per ~3-5 chars for JSON.
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

	function _buildBody({ system, user, temperature, maxTokens, verbosity, useMaxCompletionTokens, omitTemperature = false, omitResponseFormat = false }) {
		const body = {
			model: m,
			messages: [
				{ role: "system", content: String(system || "") },
				{ role: "user", content: String(user || "") },
			],
		};
		if (_isGpt5(m) && typeof verbosity === "string" && verbosity.trim()) {
			body.verbosity = verbosity.trim();
		}
		if (!omitResponseFormat) {
			body.response_format = { type: "json_object" };
		}
		const canUseTemp = !omitTemperature && _supportsTemperature(m);
		if (canUseTemp) {
			// OpenAI temperature range is typically 0..2; keep it conservative.
			body.temperature = Math.max(0, Math.min(2, _safeNum(temperature, 0.15)));
		}
		const mt = Math.max(64, Math.min(1200, Math.floor(_safeNum(maxTokens, 350))));
		if (useMaxCompletionTokens) body.max_completion_tokens = mt;
		else body.max_tokens = mt;
		return body;
	}

	function _mapVerbosityToEffort(verbosity) {
		try {
			const v = String(verbosity || "").trim().toLowerCase();
			if (v === "high") return "high";
			if (v === "medium") return "medium";
			return "low";
		} catch {
			return "low";
		}
	}

	function _buildResponsesBody({ system, user, temperature, maxTokens, verbosity, omitTemperature = false, omitResponseFormat = false }) {
		const body = {
			model: m,
			input: [
				{ role: "developer", content: String(system || "") },
				{ role: "user", content: String(user || "") },
			],
		};
		// Reasoning models (GPT-5 / o*) generally behave better via Responses API.
		if (_isGpt5OrO(m)) {
			body.reasoning = { effort: _mapVerbosityToEffort(verbosity) };
		}
		if (!omitResponseFormat) {
			// Some models/endpoints may not accept this; we retry without it.
			body.response_format = { type: "json_object" };
		}
		if (!omitTemperature) {
			// Some reasoning models may ignore/reject temperature; we retry without it.
			body.temperature = Math.max(0, Math.min(2, _safeNum(temperature, 0.15)));
		}
		const mt = Math.max(64, Math.min(1200, Math.floor(_safeNum(maxTokens, 350))));
		body.max_output_tokens = mt;
		return body;
	}

	async function chatJsonWithMeta({ system, user, temperature = 0.15, maxTokens = 950, verbosity = "low" } = {}) {
		const ctl = new AbortController();
		const to = setTimeout(() => {
			try { ctl.abort(); } catch {}
		}, Math.max(2000, _safeNum(timeoutMs, 12_000)));

		try {
			const estPromptTokens =
				estimateTokensForText(system) +
				estimateTokensForText(user) +
				60; // overhead (roles, JSON, etc.)

			const wantsResponses = _prefersResponsesApi(m);
			let mode = wantsResponses ? "responses" : "chat";
			let endpoint = wantsResponses
				? `${urlBase.replace(/\/$/, "")}/responses`
				: `${urlBase.replace(/\/$/, "")}/chat/completions`;
			const baseReq = {
				method: "POST",
				signal: ctl.signal,
				headers: {
					"Content-Type": "application/json",
					"Authorization": `Bearer ${key}`,
				},
			};

			const preferred = _usesMaxCompletionTokens(m);
			let omitTemperature = !_supportsTemperature(m);
			let omitResponseFormat = false;
			let maxTokensLocal = maxTokens;

			const buildBody = () => {
				if (mode === "responses") {
					return _buildResponsesBody({ system, user, temperature, maxTokens: maxTokensLocal, verbosity, omitTemperature, omitResponseFormat });
				}
				return _buildBody({ system, user, temperature, maxTokens: maxTokensLocal, verbosity, useMaxCompletionTokens: preferred, omitTemperature, omitResponseFormat });
			};

			let resp = await _fetch(endpoint, { ...baseReq, body: JSON.stringify(buildBody()) });

			// Responses API fallback: if /responses isn't available in this environment, fall back to chat/completions.
			if (mode === "responses" && !resp.ok && (resp.status === 404 || resp.status === 405)) {
				const fallbackEndpoint = `${urlBase.replace(/\/$/, "")}/chat/completions`;
				mode = "chat";
				endpoint = fallbackEndpoint;
				resp = await _fetch(fallbackEndpoint, {
					...baseReq,
					body: JSON.stringify(
						_buildBody({ system, user, temperature, maxTokens: maxTokensLocal, verbosity, useMaxCompletionTokens: preferred, omitTemperature, omitResponseFormat })
					),
				});
			}

			// Robustness: handle common parameter mismatches.
			if (!resp.ok) {
				const txt = await resp.text().catch(() => "");
				const wantsMaxCompletion = /max_completion_tokens/i.test(txt) || /Use\s+'max_completion_tokens'/i.test(txt);
				const tempUnsupported = /temperature/i.test(txt) && /Only the default \(1\) value is supported/i.test(txt);
				const responseFormatUnsupported = /response_format/i.test(txt) && /(unknown|unsupported|not allowed|unrecognized)/i.test(txt);

				// Retry 1: strip temperature if the model rejects it.
				if (!omitTemperature && resp.status === 400 && tempUnsupported) {
					omitTemperature = true;
					resp = await _fetch(endpoint, { ...baseReq, body: JSON.stringify(buildBody()) });
					if (!resp.ok) {
						const txtT = await resp.text().catch(() => "");
						throw new Error(`OpenAI HTTP ${resp.status}: ${txtT.slice(0, 300)}`);
					}
				} else if (!omitResponseFormat && resp.status === 400 && responseFormatUnsupported) {
					omitResponseFormat = true;
					resp = await _fetch(endpoint, { ...baseReq, body: JSON.stringify(buildBody()) });
					if (!resp.ok) {
						const txtF = await resp.text().catch(() => "");
						throw new Error(`OpenAI HTTP ${resp.status}: ${txtF.slice(0, 300)}`);
					}
				} else {
					// Chat Completions only: retry once with max_completion_tokens if required.
					const canRetry = mode === "chat" && !preferred && resp.status === 400 && wantsMaxCompletion;
					if (canRetry) {
						resp = await _fetch(endpoint, {
							...baseReq,
							body: JSON.stringify(
								_buildBody({ system, user, temperature, maxTokens, useMaxCompletionTokens: true, omitTemperature, omitResponseFormat })
							),
						});
						if (!resp.ok) {
							const txt2 = await resp.text().catch(() => "");
							throw new Error(`OpenAI HTTP ${resp.status}: ${txt2.slice(0, 300)}`);
						}
					} else {
						throw new Error(`OpenAI HTTP ${resp.status}: ${txt.slice(0, 300)}`);
					}
				}
			}

			const reqId = (() => {
				try {
					return String(resp?.headers?.get("x-request-id") || resp?.headers?.get("x-requestid") || "").trim();
				} catch {
					return "";
				}
			})();

			let json = await resp.json();
			if (json?.error?.message) throw new Error(`OpenAI error: ${String(json.error.message).slice(0, 220)}`);
			let usage = _extractUsageFromResponse(json);

			let ext = _extractTextFromResponse(json);
			let out = String(ext?.text || "");

			// Responses API: if the model got cut off mid-JSON (or returned incomplete output), retry once with a higher max_output_tokens.
			if (mode === "responses") {
				try {
					const status = String(json?.status || "").trim().toLowerCase();
					const incompleteReason = String(json?.incomplete_details?.reason || "").trim().toLowerCase();
					const shouldRetry = _looksLikeTruncatedJson(out) ||
						(!out.trim() && status && status !== "completed") ||
						(!out.trim() && incompleteReason);
					if (shouldRetry) {
						const bumped = Math.min(1200, Math.max(Math.floor(_safeNum(maxTokensLocal, 550) * 2), 900));
						if (bumped > Math.floor(_safeNum(maxTokensLocal, 0))) {
							maxTokensLocal = bumped;
							resp = await _fetch(endpoint, { ...baseReq, body: JSON.stringify(buildBody()) });
							if (!resp.ok) {
								const txtR = await resp.text().catch(() => "");
								throw new Error(`OpenAI HTTP ${resp.status}: ${txtR.slice(0, 300)}`);
							}
							json = await resp.json();
							if (json?.error?.message) throw new Error(`OpenAI error: ${String(json.error.message).slice(0, 220)}`);
							usage = _extractUsageFromResponse(json) || usage;
							ext = _extractTextFromResponse(json);
							out = String(ext?.text || "");
						}
					}
				} catch {
					// If retry detection fails, continue with normal handling.
				}
			}
			if (out && out.trim()) {
				return {
					text: out,
					usage,
					requestId: reqId || "",
					model: String(json?.model || m || ""),
					estPromptTokens,
				};
			}

			if (mode === "chat") {
				try {
					const finish0 = String(json?.choices?.[0]?.finish_reason || "").toLowerCase();
					if (finish0 === "length") {
						const bumped = Math.min(1200, Math.max(Math.floor(_safeNum(maxTokensLocal, 550) * 2), 900));
						if (bumped > Math.floor(_safeNum(maxTokensLocal, 0))) {
							maxTokensLocal = bumped;
							resp = await _fetch(endpoint, {
								...baseReq,
								body: JSON.stringify(buildBody()),
							});
							if (!resp.ok) {
								const txtL = await resp.text().catch(() => "");
								throw new Error(`OpenAI HTTP ${resp.status}: ${txtL.slice(0, 300)}`);
							}
							const jsonL = await resp.json();
							if (jsonL?.error?.message) throw new Error(`OpenAI error: ${String(jsonL.error.message).slice(0, 220)}`);
							const extL = _extractTextFromResponse(jsonL);
							const outL = String(extL?.text || "");
							if (outL && outL.trim()) {
								return {
									text: outL,
									usage: _extractUsageFromResponse(jsonL) || usage,
									requestId: reqId || "",
									model: String(jsonL?.model || json?.model || m || ""),
									estPromptTokens,
								};
							}
						}
					}
				} catch {
					// If the bump retry fails, fall through to the normal empty-content handling.
				}
			}

			if (!omitResponseFormat) {
				omitResponseFormat = true;
				resp = await _fetch(endpoint, {
					...baseReq,
					body: JSON.stringify(buildBody()),
				});
				if (!resp.ok) {
					const txt3 = await resp.text().catch(() => "");
					throw new Error(`OpenAI HTTP ${resp.status}: ${txt3.slice(0, 300)}`);
				}
				const json2 = await resp.json();
				if (json2?.error?.message) throw new Error(`OpenAI error: ${String(json2.error.message).slice(0, 220)}`);
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

			const finish = (() => {
				try {
					return String(json?.choices?.[0]?.finish_reason || "");
				} catch {
					return "";
				}
			})();
			const why = String(ext?.why || "unknown");
			const modelName = String(json?.model || m || "");
			throw new Error(
				`OpenAI: empty content (why=${why}` +
				(finish ? ` finish=${finish}` : "") +
				(modelName ? ` model=${modelName}` : "") +
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
