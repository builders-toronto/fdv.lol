import { createOpenAIChatClient } from "./open.js";
import { createGeminiChatClient } from "./gemini.js";
import { createGrokChatClient } from "./grok.js";

function _inferProvider({ provider, baseUrl, model } = {}) {
	try {
		const p = String(provider || "").trim().toLowerCase();
		if (p) return p;
		const mn = String(model || "").trim().toLowerCase();
		if (mn.startsWith("grok-")) return "grok";
		const u = String(baseUrl || "").trim().toLowerCase();
		if (!u) return "openai";
		if (u.includes("generativelanguage.googleapis.com")) return "gemini";
		if (u.includes("api.x.ai")) return "grok";
		// Default: OpenAI-compatible chat/completions endpoint.
		return "openai";
	} catch {
		return "openai";
	}
}

// Normalizes config to a provider-agnostic shape, while preserving back-compat with existing `openai*` fields.
export function normalizeLlmConfig(cfg = {}) {
	try {
		const c = (cfg && typeof cfg === "object") ? cfg : {};
		const provider = _inferProvider({
			provider: c.llmProvider || c.provider,
			baseUrl: c.baseUrl || c.llmBaseUrl || c.openaiBaseUrl,
			model: c.model || c.llmModel || c.openaiModel,
		});
		const defaultBaseUrl = (provider === "gemini")
			? "https://generativelanguage.googleapis.com/v1beta"
			: (provider === "grok")
				? "https://api.x.ai/v1"
				: "https://api.openai.com/v1";
		const defaultModel = (provider === "gemini")
			? "gemini-2.5-flash-lite"
			: (provider === "grok")
				? "grok-3-mini"
				: "gpt-4o-mini";
		return {
			provider,
			enabled: c.enabled !== false,
			// Accept both normalized (`apiKey`/`baseUrl`/`model`) and legacy (`openai*`) config shapes.
			apiKey: String(c.apiKey || c.llmApiKey || c.openaiApiKey || "").trim(),
			baseUrl: String(c.baseUrl || c.llmBaseUrl || c.openaiBaseUrl || defaultBaseUrl).trim() || defaultBaseUrl,
			model: String(c.model || c.llmModel || c.openaiModel || defaultModel).trim() || defaultModel,
			timeoutMs: Number.isFinite(Number(c.llmTimeoutMs))
				? Math.max(2000, Math.floor(Number(c.llmTimeoutMs)))
				: Math.max(2000, Math.floor(Number(c.timeoutMs || 12_000))),
			maxTokens: Number.isFinite(Number(c.maxTokens)) ? Math.floor(Number(c.maxTokens)) : 350,
		};
	} catch {
		return {
			provider: "openai",
			enabled: false,
			apiKey: "",
			baseUrl: "https://api.openai.com/v1",
			model: "gpt-4o-mini",
			timeoutMs: 12_000,
			maxTokens: 350,
		};
	}
}

export function createChatClient({ provider, apiKey, baseUrl, model, timeoutMs, fetchFn } = {}) {
	const p = _inferProvider({ provider, baseUrl, model });
	if (p === "openai" || p === "openai_compat" || p === "compatible") {
		return createOpenAIChatClient({ apiKey, baseUrl, model, timeoutMs, fetchFn });
	}
	if (p === "gemini") {
		return createGeminiChatClient({ apiKey, baseUrl, model, timeoutMs, fetchFn });
	}
	if (p === "grok" || p === "xai" || p === "x-ai") {
		return createGrokChatClient({ apiKey, baseUrl, model, timeoutMs, fetchFn });
	}
	throw new Error(`Unsupported LLM provider: ${String(p)}`);
}

export function createChatClientFromConfig(cfg = {}, { fetchFn } = {}) {
	const c = normalizeLlmConfig(cfg);
	if (!c.enabled) return null;
	if (!c.apiKey) return null;
	return createChatClient({
		provider: c.provider,
		apiKey: c.apiKey,
		baseUrl: c.baseUrl,
		model: c.model,
		timeoutMs: c.timeoutMs,
		fetchFn,
	});
}
