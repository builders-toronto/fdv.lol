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
			const delta = choice?.delta;
			if (typeof delta?.content === "string") {
				if (!delta.content.trim()) return { text: "", why: "delta_content_empty" };
				return { text: delta.content, why: "delta_content" };
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

	async function chatJson({ system, user, temperature = 0.15, maxTokens = 950, verbosity = "low" } = {}) {
		const ctl = new AbortController();
		const to = setTimeout(() => {
			try { ctl.abort(); } catch {}
		}, Math.max(2000, _safeNum(timeoutMs, 12_000)));

		try {
			const endpoint = `${urlBase.replace(/\/$/, "")}/chat/completions`;
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
			let resp = await _fetch(endpoint, {
				...baseReq,
				body: JSON.stringify(_buildBody({ system, user, temperature, maxTokens: maxTokensLocal, verbosity, useMaxCompletionTokens: preferred, omitTemperature, omitResponseFormat })),
			});

			// Robustness: if OpenAI rejects max_tokens, retry once with max_completion_tokens.
			if (!resp.ok) {
				const txt = await resp.text().catch(() => "");
				const wantsMaxCompletion = /max_completion_tokens/i.test(txt) || /Use\s+'max_completion_tokens'/i.test(txt);
				const tempUnsupported = /temperature/i.test(txt) && /Only the default \(1\) value is supported/i.test(txt);

				// Retry 1: strip temperature if the model rejects it.
				if (!omitTemperature && resp.status === 400 && tempUnsupported) {
					omitTemperature = true;
					resp = await _fetch(endpoint, {
						...baseReq,
						body: JSON.stringify(
							_buildBody({ system, user, temperature, maxTokens, useMaxCompletionTokens: preferred, omitTemperature, omitResponseFormat })
						),
					});
					if (!resp.ok) {
						const txtT = await resp.text().catch(() => "");
						throw new Error(`OpenAI HTTP ${resp.status}: ${txtT.slice(0, 300)}`);
					}
				} else {
					const canRetry = !preferred && resp.status === 400 && wantsMaxCompletion;
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

			const json = await resp.json();
			if (json?.error?.message) throw new Error(`OpenAI error: ${String(json.error.message).slice(0, 220)}`);

			const ext = _extractTextFromResponse(json);
			const out = String(ext?.text || "");
			if (out && out.trim()) return out;

			try {
				const finish0 = String(json?.choices?.[0]?.finish_reason || "").toLowerCase();
				if (finish0 === "length") {
					const bumped = Math.min(1200, Math.max(Math.floor(_safeNum(maxTokensLocal, 550) * 2), 900));
					if (bumped > Math.floor(_safeNum(maxTokensLocal, 0))) {
						maxTokensLocal = bumped;
						resp = await _fetch(endpoint, {
							...baseReq,
							body: JSON.stringify(
								_buildBody({ system, user, temperature, maxTokens: maxTokensLocal, verbosity, useMaxCompletionTokens: preferred, omitTemperature, omitResponseFormat })
							),
						});
						if (!resp.ok) {
							const txtL = await resp.text().catch(() => "");
							throw new Error(`OpenAI HTTP ${resp.status}: ${txtL.slice(0, 300)}`);
						}
						const jsonL = await resp.json();
						if (jsonL?.error?.message) throw new Error(`OpenAI error: ${String(jsonL.error.message).slice(0, 220)}`);
						const extL = _extractTextFromResponse(jsonL);
						const outL = String(extL?.text || "");
						if (outL && outL.trim()) return outL;
					}
				}
			} catch {
				// If the bump retry fails, fall through to the normal empty-content handling.
			}

			if (!omitResponseFormat) {
				omitResponseFormat = true;
				resp = await _fetch(endpoint, {
					...baseReq,
					body: JSON.stringify(
						_buildBody({ system, user, temperature, maxTokens, verbosity, useMaxCompletionTokens: preferred, omitTemperature, omitResponseFormat })
					),
				});
				if (!resp.ok) {
					const txt3 = await resp.text().catch(() => "");
					throw new Error(`OpenAI HTTP ${resp.status}: ${txt3.slice(0, 300)}`);
				}
				const json2 = await resp.json();
				if (json2?.error?.message) throw new Error(`OpenAI error: ${String(json2.error.message).slice(0, 220)}`);
				const ext2 = _extractTextFromResponse(json2);
				const out2 = String(ext2?.text || "");
				if (out2 && out2.trim()) return out2;
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

	return { chatJson };
}
