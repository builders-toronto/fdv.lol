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

	async function chatJson({ system, user, temperature = 0.15, maxTokens = 350 } = {}) {
		const ctl = new AbortController();
		const to = setTimeout(() => {
			try { ctl.abort(); } catch {}
		}, Math.max(2000, _safeNum(timeoutMs, 12_000)));

		try {
			const resp = await _fetch(`${urlBase.replace(/\/$/, "")}/chat/completions`, {
				method: "POST",
				signal: ctl.signal,
				headers: {
					"Content-Type": "application/json",
					"Authorization": `Bearer ${key}`,
				},
				body: JSON.stringify({
					model: m,
					temperature: Math.max(0, Math.min(1, _safeNum(temperature, 0.15))),
					max_tokens: Math.max(64, Math.min(1200, Math.floor(_safeNum(maxTokens, 350)))),
					response_format: { type: "json_object" },
					messages: [
						{ role: "system", content: String(system || "") },
						{ role: "user", content: String(user || "") },
					],
				}),
			});
			if (!resp.ok) {
				const txt = await resp.text().catch(() => "");
				throw new Error(`OpenAI HTTP ${resp.status}: ${txt.slice(0, 300)}`);
			}
			const json = await resp.json();
			const content = json?.choices?.[0]?.message?.content;
			if (!content) throw new Error("OpenAI: empty content");
			return String(content);
		} finally {
			clearTimeout(to);
		}
	}

	return { chatJson };
}
