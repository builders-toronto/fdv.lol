import { createChatClientFromConfig, normalizeLlmConfig } from "./frameworks/index.js";
import { TRAINING_CAPTURE } from "../config/env.js";
import { appendTrainingCapture, clearTrainingCaptures, downloadTrainingCapturesJsonl, getTrainingCaptures, isTrainingCaptureEnabled } from "./training.js";
import { createDecisionMemory } from "./memory.js";

function now() {
	return Date.now();
}

function _safeNum(v, fallback = 0) {
	const n = Number(v);
	return Number.isFinite(n) ? n : fallback;
}

function _clampNum(n, min, max) {
	const v = _safeNum(n, min);
	return Math.max(min, Math.min(max, v));
}

function _safeJsonParse(s) {
	try {
		return JSON.parse(String(s || ""));
	} catch {
		try {
			const _stripTrailingCommas = (t) => {
				try {
					return String(t || "").replace(/,\s*([}\]])/g, "$1");
				} catch {
					return String(t || "");
				}
			};
			const _balanceClosers = (t) => {
				try {
					let inStr = false;
					let esc = false;
					let openObj = 0;
					let openArr = 0;
					for (let i = 0; i < t.length; i++) {
						const ch = t[i];
						if (inStr) {
							if (esc) { esc = false; continue; }
							if (ch === "\\") { esc = true; continue; }
							if (ch === '"') { inStr = false; continue; }
							continue;
						}
						if (ch === '"') { inStr = true; continue; }
						if (ch === "{") openObj++;
						else if (ch === "}") openObj = Math.max(0, openObj - 1);
						else if (ch === "[") openArr++;
						else if (ch === "]") openArr = Math.max(0, openArr - 1);
					}
					let out = t;
					// Close arrays first, then objects.
					if (openArr) out += "]".repeat(openArr);
					if (openObj) out += "}".repeat(openObj);
					return out;
				} catch {
					return String(t || "");
				}
			};
			const _tryRepairParse = (t) => {
				try {
					let u = String(t || "");
					u = _stripTrailingCommas(u);
					u = _balanceClosers(u);
					u = _stripTrailingCommas(u);
					return JSON.parse(u);
				} catch {
					return null;
				}
			};

			let t = String(s || "");
			// ```json ... ``` or ``` ... ```
			t = t.replace(/^\s*```(?:json)?\s*/i, "").replace(/\s*```\s*$/i, "");
			const firstObj = t.indexOf("{");
			const lastObj = t.lastIndexOf("}");
			if (firstObj >= 0 && lastObj > firstObj) {
				const slice = t.slice(firstObj, lastObj + 1);
				try { return JSON.parse(slice); } catch {}
				const repaired = _tryRepairParse(slice);
				if (repaired) return repaired;
			}
			const firstArr = t.indexOf("[");
			const lastArr = t.lastIndexOf("]");
			if (firstArr >= 0 && lastArr > firstArr) {
				const slice = t.slice(firstArr, lastArr + 1);
				try { return JSON.parse(slice); } catch {}
				const repaired = _tryRepairParse(slice);
				if (repaired) return repaired;
			}

			// Last chance: attempt repair on any leading '{'/'[' content, even if truncated.
			try {
				if (firstObj >= 0) {
					const repaired = _tryRepairParse(t.slice(firstObj));
					if (repaired) return repaired;
				}
				if (firstArr >= 0) {
					const repaired = _tryRepairParse(t.slice(firstArr));
					if (repaired) return repaired;
				}
			} catch {}
		} catch {}
		return null;
	}
}

function _redactDeep(obj, { maxDepth = 6, maxKeys = 200 } = {}, _depth = 0, _seen = new WeakSet()) {
	try {
		if (_depth > maxDepth) return "[truncated]";
		if (obj == null) return obj;
		if (typeof obj === "string") {
			// avoid leaking secrets in raw strings
			if (/sk-|secret|private|seed|keypair|secretKey|autoWalletSecret|rpcHeaders|authorization|bearer/i.test(obj)) return "[redacted]";
			return obj.length > 2000 ? obj.slice(0, 2000) + "…" : obj;
		}
		if (typeof obj === "number" || typeof obj === "boolean") return obj;
		if (typeof obj === "bigint") return String(obj);
		if (typeof obj === "function") return `[fn ${obj.name || "anonymous"}]`;
		if (typeof obj !== "object") return String(obj);
		if (_seen.has(obj)) return "[cycle]";
		_seen.add(obj);

		if (Array.isArray(obj)) {
			return obj.slice(0, 50).map((v) => _redactDeep(v, { maxDepth, maxKeys }, _depth + 1, _seen));
		}

		const out = {};
		let nKeys = 0;
		for (const k of Object.keys(obj)) {
			nKeys++;
			if (nKeys > maxKeys) {
				out.__truncated__ = true;
				break;
			}
			const key = String(k || "");
			if (/secret|private|seed|keypair|secretKey|autoWalletSecret|rpcHeaders|authorization|bearer/i.test(key)) {
				out[key] = "[redacted]";
				continue;
			}
			out[key] = _redactDeep(obj[key], { maxDepth, maxKeys }, _depth + 1, _seen);
		}
		return out;
	} catch {
		return "[unserializable]";
	}
}

import { getGarySystemPrompt } from "./personas/agent.gary.prompts.js";

function _validateTune(tune) {
	try {
		if (!tune || typeof tune !== "object") return null;
		const out = {};
		const set = (k, v, min, max, round = null) => {
			const n = _safeNum(v, NaN);
			if (!Number.isFinite(n)) return;
			let clamped = _clampNum(n, min, max);
			if (round === "int") clamped = Math.floor(clamped);
			else if (typeof round === "number") clamped = Math.round(clamped / round) * round;
			out[k] = clamped;
		};

		// Risk / exit tuning
		set("takeProfitPct", tune.takeProfitPct, 0, 250, 0.25);
		set("stopLossPct", tune.stopLossPct, 0, 99, 0.25);
		set("trailPct", tune.trailPct, 0, 99, 0.25);
		set("minProfitToTrailPct", tune.minProfitToTrailPct, 0, 200, 0.25);

		// Hold tuning
		set("minHoldSecs", tune.minHoldSecs, 0, 20_000, "int");
		set("maxHoldSecs", tune.maxHoldSecs, 10, 20_000, "int");

		// Buy sizing / gating
		set("buyPct", tune.buyPct, 0.01, 0.5, 0.005);

		// Entry simulation tuning
		set("entrySimMinWinProb", tune.entrySimMinWinProb, 0, 1, 0.01);
		set("entrySimHorizonSecs", tune.entrySimHorizonSecs, 30, 600, "int");

		return Object.keys(out).length ? out : null;
	} catch {
		return null;
	}
}

function _validateForecast(forecast) {
	try {
		if (!forecast || typeof forecast !== "object") return null;
		const out = {};

		const horizonSecs = Math.floor(_safeNum(forecast.horizonSecs, NaN));
		if (Number.isFinite(horizonSecs)) out.horizonSecs = _clampNum(horizonSecs, 30, 24 * 60 * 60);

		const upProb = _safeNum(forecast.upProb, NaN);
		const downProb = _safeNum(forecast.downProb, NaN);
		if (Number.isFinite(upProb)) out.upProb = _clampNum(upProb, 0, 1);
		if (Number.isFinite(downProb)) out.downProb = _clampNum(downProb, 0, 1);

		const expectedMovePct = _safeNum(forecast.expectedMovePct, NaN);
		if (Number.isFinite(expectedMovePct)) out.expectedMovePct = _clampNum(expectedMovePct, -250, 250);

		const regime = String(forecast.regime || "").trim();
		if (regime) out.regime = regime.slice(0, 40);

		const note = String(forecast.note || "").trim();
		if (note) out.note = note.slice(0, 160);

		// If only one probability is present, allow it; consumers may infer the other.
		return Object.keys(out).length ? out : null;
	} catch {
		return null;
	}
}

function _validateBuyDecision(obj) {
	if (!obj || typeof obj !== "object") return null;
	const action = String(obj.action || "").toLowerCase();
	if (action !== "buy" && action !== "skip") return null;
	const confidence = _clampNum(obj.confidence, 0, 1);
	const reason = String(obj.reason || "").slice(0, 220);
	const out = { kind: "buy", action, confidence, reason };
	if (obj.buy && typeof obj.buy === "object") {
		const solUi = _safeNum(obj.buy.solUi, NaN);
		const slippageBps = _safeNum(obj.buy.slippageBps, NaN);
		out.buy = {};
		if (Number.isFinite(solUi) && solUi > 0) out.buy.solUi = solUi;
		if (Number.isFinite(slippageBps) && slippageBps > 0) out.buy.slippageBps = Math.floor(slippageBps);
	}
	const tune = _validateTune(obj.tune);
	if (tune) out.tune = tune;
	const forecast = _validateForecast(obj.forecast);
	if (forecast) out.forecast = forecast;
	// Optional evolve feedback (ignored by bot execution, used for long-term improvement).
	try {
		if (obj.evolve && typeof obj.evolve === "object") {
			const outcomeTs = _safeNum(obj.evolve.outcomeTs, 0);
			const selfCritique = String(obj.evolve.selfCritique || "").slice(0, 220);
			const lesson = String(obj.evolve.lesson || "").slice(0, 220);
			if (Number.isFinite(outcomeTs) && outcomeTs > 0 && (selfCritique || lesson)) {
				out.evolve = { outcomeTs };
				if (selfCritique) out.evolve.selfCritique = selfCritique;
				if (lesson) out.evolve.lesson = lesson;
			}
		}
	} catch {}
	return out;
}

function _validateSellDecision(obj) {
	if (!obj || typeof obj !== "object") return null;
	const action = String(obj.action || "").toLowerCase();
	if (action !== "sell_all" && action !== "sell_partial" && action !== "hold" && action !== "long_hold") return null;
	const confidence = _clampNum(obj.confidence, 0, 1);
	const reason = String(obj.reason || "").slice(0, 220);
	const out = { kind: "sell", action, confidence, reason };
	if (action === "long_hold") {
		const raw = Number(obj.holdSeconds);
		const hs = Number.isFinite(raw) ? _clampNum(raw, 5, 120) : 30;
		out.holdSeconds = Math.floor(hs);
	}
	if (action === "sell_partial") {
		const pct = _clampNum(obj?.sell?.pct, 1, 100);
		out.sell = { pct: Math.floor(pct) };
	}
	const tune = _validateTune(obj.tune);
	if (tune) out.tune = tune;
	const forecast = _validateForecast(obj.forecast);
	if (forecast) out.forecast = forecast;
	// Optional evolve feedback (ignored by bot execution, used for long-term improvement).
	try {
		if (obj.evolve && typeof obj.evolve === "object") {
			const outcomeTs = _safeNum(obj.evolve.outcomeTs, 0);
			const selfCritique = String(obj.evolve.selfCritique || "").slice(0, 220);
			const lesson = String(obj.evolve.lesson || "").slice(0, 220);
			if (Number.isFinite(outcomeTs) && outcomeTs > 0 && (selfCritique || lesson)) {
				out.evolve = { outcomeTs };
				if (selfCritique) out.evolve.selfCritique = selfCritique;
				if (lesson) out.evolve.lesson = lesson;
			}
		}
	} catch {}
	return out;
}

function _validateConfigScanDecision(obj, allowedKeys = null) {
	try {
		if (!obj || typeof obj !== "object") return null;
		const action = String(obj.action || "").toLowerCase();
		if (action !== "apply" && action !== "skip") return null;
		const confidence = _clampNum(obj.confidence, 0, 1);
		const reason = String(obj.reason || "").slice(0, 220);
		const out = { kind: "config_scan", action, confidence, reason };
		const allow = (() => {
			try {
				if (!Array.isArray(allowedKeys) || !allowedKeys.length) return null;
				return new Set(allowedKeys.map((k) => String(k || "").trim()).filter(Boolean).slice(0, 200));
			} catch {
				return null;
			}
		})();

		const _shouldAllowKey = (k) => {
			try {
				if (!allow) return true;
				return allow.has(String(k || "").trim());
			} catch {
				return false;
			}
		};

		const _applyKv = (cfg, keyRaw, v) => {
			try {
				const key = String(keyRaw || "").slice(0, 80);
				if (!key) return;
				if (!_shouldAllowKey(key)) return;
				// Structured Outputs schemas may return explicit nulls for "no-op" keys; ignore those.
				if (v == null) return;
				const t = typeof v;
				if (t === "number" || t === "boolean" || t === "string") cfg[key] = v;
			} catch {}
		};

		// Preferred compact form (Structured Outputs): patches[]
		if (Array.isArray(obj.patches)) {
			const cfg = {};
			let n = 0;
			for (const p of obj.patches) {
				n++;
				if (n > 24) break;
				if (!p || typeof p !== "object") continue;
				_applyKv(cfg, p.key, p.value);
			}
			if (Object.keys(cfg).length) out.config = cfg;
			return out;
		}

		// Back-compat: config object
		if (obj.config && typeof obj.config === "object") {
			const cfg = {};
			let n = 0;
			for (const [k, v] of Object.entries(obj.config)) {
				n++;
				if (n > 120) break;
				_applyKv(cfg, k, v);
			}
			if (Object.keys(cfg).length) out.config = cfg;
		}
		return out;
	} catch {
		return null;
	}
}

function _coerceWrongKindDecision(kind, parsed) {
	try {
		const k = String(kind || "").trim().toLowerCase();
		const obj = (parsed && typeof parsed === "object") ? parsed : null;
		if (!obj) return parsed;
		const action = String(obj.action || "").trim().toLowerCase();
		if (!action) return parsed;
		// Safety: if the model returns a sell-ish action while we asked for a buy,
		// treat it as a skip rather than hard-failing JSON validation.
		if (k === "buy" && (action === "sell" || action === "sell_all" || action === "sell_partial" || action === "hold" || action === "long_hold")) {
			return {
				kind: "buy",
				action: "skip",
				confidence: 0,
				reason: "model_returned_sell_action_for_buy_kind",
			};
		}
		// Safety: if the model returns a buy-ish action while we asked for a sell,
		// treat it as hold.
		if (k === "sell" && (action === "buy" || action === "skip")) {
			return {
				kind: "sell",
				action: "hold",
				confidence: 0,
				reason: "model_returned_buy_action_for_sell_kind",
			};
		}
		return parsed;
	} catch {
		return parsed;
	}
}

function _buildDecisionSchema(kind, allowedConfigKeys = []) {
	try {
		const k = String(kind || "").trim().toLowerCase();
		const tune = {
			type: "object",
			additionalProperties: false,
			properties: {
				takeProfitPct: { type: ["number", "null"] },
				stopLossPct: { type: ["number", "null"] },
				trailPct: { type: ["number", "null"] },
				minProfitToTrailPct: { type: ["number", "null"] },
				minHoldSecs: { type: ["integer", "null"] },
				maxHoldSecs: { type: ["integer", "null"] },
				buyPct: { type: ["number", "null"] },
				entrySimMinWinProb: { type: ["number", "null"] },
				entrySimHorizonSecs: { type: ["integer", "null"] },
			},
			required: [
				"takeProfitPct",
				"stopLossPct",
				"trailPct",
				"minProfitToTrailPct",
				"minHoldSecs",
				"maxHoldSecs",
				"buyPct",
				"entrySimMinWinProb",
				"entrySimHorizonSecs",
			],
		};
		const forecast = {
			type: "object",
			additionalProperties: false,
			properties: {
				horizonSecs: { type: ["integer", "null"] },
				upProb: { type: ["number", "null"] },
				downProb: { type: ["number", "null"] },
				expectedMovePct: { type: ["number", "null"] },
				regime: { type: ["string", "null"] },
				note: { type: ["string", "null"] },
			},
			required: ["horizonSecs", "upProb", "downProb", "expectedMovePct", "regime", "note"],
		};
		const evolve = {
			type: "object",
			additionalProperties: false,
			properties: {
				outcomeTs: { type: ["integer", "null"] },
				selfCritique: { type: ["string", "null"] },
				lesson: { type: ["string", "null"] },
			},
			required: ["outcomeTs", "selfCritique", "lesson"],
		};

		if (k === "buy") {
			return {
				name: "fdv_buy_decision_v1",
				strict: true,
				schema: {
					type: "object",
					additionalProperties: false,
					properties: {
						kind: { type: "string", enum: ["buy"] },
						action: { type: "string", enum: ["buy", "skip"] },
						confidence: { type: "number" },
						reason: { type: "string" },
						buy: {
							anyOf: [
								{
									type: "object",
									additionalProperties: false,
									properties: {
										solUi: { type: ["number", "null"] },
										slippageBps: { type: ["integer", "null"] },
									},
									required: ["solUi", "slippageBps"],
								},
								{ type: "null" },
							],
						},
						tune: { anyOf: [tune, { type: "null" }] },
						forecast: { anyOf: [forecast, { type: "null" }] },
						evolve: { anyOf: [evolve, { type: "null" }] },
					},
					required: ["kind", "action", "confidence", "reason", "buy", "tune", "forecast", "evolve"],
				},
			};
		}

		if (k === "sell") {
			return {
				name: "fdv_sell_decision_v1",
				strict: true,
				schema: {
					type: "object",
					additionalProperties: false,
					properties: {
						kind: { type: "string", enum: ["sell"] },
						action: { type: "string", enum: ["sell_all", "sell_partial", "hold", "long_hold"] },
						confidence: { type: "number" },
						reason: { type: "string" },
						holdSeconds: { type: ["integer", "null"] },
						sell: {
							anyOf: [
								{
									type: "object",
									additionalProperties: false,
									properties: {
										pct: { type: ["integer", "null"] },
									},
									required: ["pct"],
								},
								{ type: "null" },
							],
						},
						tune: { anyOf: [tune, { type: "null" }] },
						forecast: { anyOf: [forecast, { type: "null" }] },
						evolve: { anyOf: [evolve, { type: "null" }] },
					},
					required: ["kind", "action", "confidence", "reason", "holdSeconds", "sell", "tune", "forecast", "evolve"],
				},
			};
		}

		if (k === "config_scan") {
			const keys = Array.isArray(allowedConfigKeys) ? allowedConfigKeys.map((x) => String(x || "").trim()).filter(Boolean).slice(0, 80) : [];
			const patchKey = (keys && keys.length)
				? { type: "string", enum: keys }
				: { type: "string" };
			const patchItem = {
				type: "object",
				additionalProperties: false,
				properties: {
					key: patchKey,
					value: { type: ["number", "boolean", "string", "null"] },
				},
				required: ["key", "value"],
			};
			const patches = {
				type: "array",
				items: patchItem,
				maxItems: 12,
			};
			return {
				name: "fdv_config_scan_v1",
				strict: true,
				schema: {
					type: "object",
					additionalProperties: false,
					properties: {
						kind: { type: "string", enum: ["config_scan"] },
						action: { type: "string", enum: ["apply", "skip"] },
						confidence: { type: "number" },
						reason: { type: "string" },
						patches: { anyOf: [patches, { type: "null" }] },
					},
					required: ["kind", "action", "confidence", "reason", "patches"],
				},
			};
		}

		return null;
	} catch {
		return null;
	}
}

function _buildAgenticNegotiationSchema(kind) {
	try {
		const k = String(kind || "").trim().toLowerCase();
		// A compact, strict schema for a pre-decision negotiation pass.
		// All fields are required but allow nulls to reduce truncation failures.
		return {
			name: "fdv_agentic_negotiation_v1",
			strict: true,
			schema: {
				type: "object",
				additionalProperties: false,
				properties: {
					mode: { type: ["string", "null"], enum: ["agentic_prepass", null] },
					role: { type: ["string", "null"] },
					kind: { type: ["string", "null"] },
					actionPreference: { type: ["string", "null"] },
					confidence: { type: ["number", "null"] },
					intent: { type: ["string", "null"] },
					keyDrivers: { anyOf: [{ type: "array", items: { type: "string" }, maxItems: 10 }, { type: "null" }] },
					guardrails: { anyOf: [{ type: "array", items: { type: "string" }, maxItems: 10 }, { type: "null" }] },
					proposed: {
						anyOf: [
							{
								type: "object",
								additionalProperties: false,
								properties: {
									buy: {
										anyOf: [
											{
												type: "object",
												additionalProperties: false,
												properties: {
													solUi: { type: ["number", "null"] },
													slippageBps: { type: ["integer", "null"] },
												},
												required: ["solUi", "slippageBps"],
											},
											{ type: "null" },
										],
									},
									sell: {
										anyOf: [
											{
												type: "object",
												additionalProperties: false,
												properties: {
													pct: { type: ["integer", "null"] },
													holdSeconds: { type: ["integer", "null"] },
												},
												required: ["pct", "holdSeconds"],
											},
											{ type: "null" },
										],
									},
									tune: { type: ["object", "null"] },
									forecast: { type: ["object", "null"] },
								},
								required: ["buy", "sell", "tune", "forecast"],
							},
							{ type: "null" },
						],
					},
					note: { type: ["string", "null"] },
				},
				required: ["mode", "role", "kind", "actionPreference", "confidence", "intent", "keyDrivers", "guardrails", "proposed", "note"],
			},
		};
	} catch {
		return null;
	}
}

function _agenticNegotiationEnabled({ provider, kind } = {}) {
	try {
		const p = String(provider || "").trim().toLowerCase();
		const k = String(kind || "").trim().toLowerCase();
		if (p !== "openai") return false;
		if (k !== "buy" && k !== "sell") return false;
		try {
			if (globalThis && globalThis.__fdvAgenticNegotiation === false) return false;
			if (globalThis && globalThis.__fdvAgenticNegotiation === true) return true;
		} catch {}
		// Default ON for OpenAI: creates a lightweight "negotiate -> decide" loop.
		return _readBoolLs("fdv_agent_agentic_negotiation", true);
	} catch {
		return false;
	}
}

function _buildAgenticNegotiationSystemPrompt(systemPromptFinal) {
	const base = String(systemPromptFinal || "").trim();
	return (
		base +
		"\n\n" +
		[
			"AGENTIC NEGOTIATION PRE-PASS (do NOT output the final decision object):",
			"- Goal: negotiate tradeoffs (risk vs reward, route/liq vs momentum, size vs slippage) using ONLY provided inputs.",
			"- Identify hard blockers (no-route/quote failures, extreme rug signals, illiquidity) vs soft concerns.",
			"- Produce a compact plan + guardrails the final decision should obey.",
			"- Output ONLY valid JSON matching the provided schema.",
			"- Ignore any earlier output-format rules for the final decision; this is a pre-pass.",
			"- Keep strings short; no markdown; no extra keys.",
		].join("\n")
	);
}

function _buildSwarmMemberSystemPrompt(systemPromptFinal, role, kind) {
	const base = _buildAgenticNegotiationSystemPrompt(systemPromptFinal);
	const r = String(role || "").trim().toLowerCase();
	const k = String(kind || "").trim().toLowerCase();
	const allowedPref = (k === "buy")
		? "buy | skip"
		: (k === "sell")
			? "sell_all | sell_partial | hold | long_hold"
			: "(unset)";
	const focus = (r === "leader")
		? [
			"ROLE: TEAM_LEADER",
			"- Synthesize overall plan and the single best actionPreference.",
			"- Emphasize tradeoffs and decisive guardrails.",
		]
		: (r === "meme_flow")
			? [
				"ROLE: MEME_FLOW_ANALYST",
				"- Specialize in momentum/flow/leader-series/tape and entry timing.",
				"- If candlesTail exists, use it lightly; do not overfit.",
			]
			: [
				"ROLE: RISK_GUARD_ANALYST",
				"- Specialize in route viability, liquidity, quote failures, and rug/honeypot risk.",
				"- Prefer SKIP/HOLD when hard safety blockers appear.",
			];
	return (
		base +
		"\n\n" +
		focus.join("\n") +
		"\n" +
		"- REQUIRED: set JSON keys mode='agentic_prepass' and kind='" + String(k || "") + "'." +
		"\n" +
		"- REQUIRED: actionPreference MUST be one of: " + allowedPref + "." +
		"\n" +
		"- Include top-level JSON key role with this role name."
	);
}

function _swarmEnabled({ provider, kind } = {}) {
	try {
		const p = String(provider || "").trim().toLowerCase();
		const k = String(kind || "").trim().toLowerCase();
		if (k !== "buy" && k !== "sell") return false;
		// Do not swarm local Gary model; keep it lean.
		if (p === "gary") return false;
		try {
			if (globalThis && globalThis.__fdvAgentSwarm === false) return false;
			if (globalThis && globalThis.__fdvAgentSwarm === true) return true;
		} catch {}
		// Default ON for non-Gary providers.
		return _readBoolLs("fdv_agent_swarm", true);
	} catch {
		return false;
	}
}

function _validateAgenticNegotiation(obj, expectedKind = "") {
	try {
		if (!obj || typeof obj !== "object") return null;
		const mode = String(obj.mode || "").trim();
		if (mode !== "agentic_prepass") return null;
		const role = String(obj.role || "").trim().slice(0, 40);
		const kind = String(obj.kind || expectedKind || "").trim().toLowerCase();
		const actionPreference = String(obj.actionPreference || "").trim().toLowerCase();
		if (kind === "buy") {
			if (actionPreference !== "buy" && actionPreference !== "skip") return null;
		}
		if (kind === "sell") {
			if (actionPreference !== "sell_all" && actionPreference !== "sell_partial" && actionPreference !== "hold" && actionPreference !== "long_hold") return null;
		}
		const confidence = _clampNum(obj.confidence, 0, 1);
		const intent = String(obj.intent || "").trim().slice(0, 220);
		const note = String(obj.note || "").trim().slice(0, 220);
		const keyDrivers = Array.isArray(obj.keyDrivers)
			? obj.keyDrivers.map((x) => String(x || "").trim()).filter(Boolean).slice(0, 8)
			: [];
		const guardrails = Array.isArray(obj.guardrails)
			? obj.guardrails.map((x) => String(x || "").trim()).filter(Boolean).slice(0, 8)
			: [];

		let proposed = null;
		if (obj.proposed && typeof obj.proposed === "object") {
			const out = { buy: null, sell: null };
			try {
				if (obj.proposed.buy && typeof obj.proposed.buy === "object") {
					const solUi = _safeNum(obj.proposed.buy.solUi, NaN);
					const slippageBps = _safeNum(obj.proposed.buy.slippageBps, NaN);
					out.buy = {
						solUi: Number.isFinite(solUi) ? Math.max(0, solUi) : null,
						slippageBps: Number.isFinite(slippageBps) ? Math.max(0, Math.floor(slippageBps)) : null,
					};
				}
			} catch {}
			try {
				if (obj.proposed.sell && typeof obj.proposed.sell === "object") {
					const pct = _safeNum(obj.proposed.sell.pct, NaN);
					const holdSeconds = _safeNum(obj.proposed.sell.holdSeconds, NaN);
					out.sell = {
						pct: Number.isFinite(pct) ? Math.max(0, Math.min(100, Math.floor(pct))) : null,
						holdSeconds: Number.isFinite(holdSeconds) ? Math.max(0, Math.floor(holdSeconds)) : null,
					};
				}
			} catch {}
			try {
				const tune = _validateTune(obj.proposed.tune);
				if (tune) out.tune = tune;
			} catch {}
			try {
				const forecast = _validateForecast(obj.proposed.forecast);
				if (forecast) out.forecast = forecast;
			} catch {}
			proposed = out;
		}

		return {
			mode: "agentic_prepass",
			role: role || null,
			kind: kind || null,
			actionPreference: actionPreference || null,
			confidence,
			intent: intent || null,
			keyDrivers,
			guardrails,
			proposed,
			note: note || null,
		};
	} catch {
		return null;
	}
}

	function _summarizeSwarm(members = []) {
		try {
			const ms = Array.isArray(members) ? members : [];
			const clean = ms.filter((m) => m && typeof m === "object");
			if (!clean.length) return null;

			const actionScores = new Map();
			const byRole = {};
			for (const m of clean) {
				const ap = String(m.actionPreference || "").trim().toLowerCase();
				const conf = _clampNum(m.confidence, 0, 1);
				if (ap) actionScores.set(ap, (actionScores.get(ap) || 0) + (Number.isFinite(conf) ? conf : 0));
				const r = String(m.role || "").trim().slice(0, 40);
				if (r) {
					byRole[r] = {
						actionPreference: ap || null,
						confidence: Number.isFinite(conf) ? conf : null,
						keyDrivers: Array.isArray(m.keyDrivers) ? m.keyDrivers.slice(0, 3) : [],
						guardrails: Array.isArray(m.guardrails) ? m.guardrails.slice(0, 3) : [],
					};
				}
			}

			const consensus = Array.from(actionScores.entries())
				.sort((a, b) => (b[1] - a[1]))
				.map(([actionPreference, score]) => ({ actionPreference, score }))
				.slice(0, 3);

			const top = consensus[0] || null;
			const runnerUp = consensus[1] || null;
			const margin = (top && runnerUp) ? (top.score - runnerUp.score) : null;

			return {
				v: 1,
				consensus: top ? { actionPreference: top.actionPreference, score: top.score, margin } : null,
				rank: consensus,
				byRole,
			};
		} catch {
			return null;
		}
	}

function _compactUserMsgForGary(userMsg) {
	try {
		if (!userMsg || typeof userMsg !== "object") return userMsg;
		const kind = String(userMsg.kind || "").trim().toLowerCase();
		const src = String(userMsg.source || "").slice(0, 80);
		const out = { source: src || "fdv_auto_trader", kind };

		// Compact payload/signals aggressively.
		const p = (userMsg.payload && typeof userMsg.payload === "object") ? userMsg.payload : {};
		const payload = {};
		if (typeof p.mint === "string") payload.mint = p.mint;
		if (p.proposed && typeof p.proposed === "object") payload.proposed = p.proposed;
		try {
			if (p.evolve && typeof p.evolve === "object") payload.evolve = _compactEvolveAnyForPrompt(p.evolve) || _redactDeep(p.evolve, { maxDepth: 5, maxKeys: 60 });
		} catch {}
		// pos/ctx are extremely large; keep only decision-critical fields.
		if (p.pos && typeof p.pos === "object") {
			const pos = p.pos;
			const keepPos = {};
			for (const k of [
				"sizeUi",
				"decimals",
				"costSol",
				"hwmSol",
				"acquiredAt",
				"lastBuyAt",
				"lastSellAt",
				"allowRebuy",
				"awaitingSizeSync",
				"warmingHold",
				"sellGuardUntil",
				"warmingMinProfitPct",
				"tpPct",
				"slPct",
				"trailPct",
				"minProfitToTrailPct",
				"entryEdgeExclPct",
				"entryEdgeCostPct",
				"entryTpBumpPct",
				"entryPreMin",
			]) {
				if (k in pos) keepPos[k] = pos[k];
			}
			// Minimal tick snapshot.
			try {
				const t = pos.tickNow;
				if (t && typeof t === "object") {
					keepPos.tickNow = {
						ts: t.ts ?? null,
						priceUsd: t.priceUsd ?? null,
						liqUsd: t.liqUsd ?? null,
						change5m: t.change5m ?? null,
						change1h: t.change1h ?? null,
						v1hUsd: t.v1hUsd ?? null,
					};
				}
			} catch {}
			if (Object.keys(keepPos).length) payload.pos = keepPos;
		}
		if (p.ctx && typeof p.ctx === "object") {
			const c = p.ctx;
			const keepCtx = {};
			for (const k of [
				"agentRisk",
				"nowTs",
				"curSol",
				"curSolNet",
				"pnlPct",
				"pnlNetPct",
				"minNotionalSol",
				"inMinHold",
				"inSellGuard",
				"hasPending",
				"isFastExit",
				"rugSev",
				"forceRug",
				"forcePumpDrop",
				"forceObserverDrop",
				"forceMomentum",
				"forceExpire",
			]) {
				if (k in c) keepCtx[k] = c[k];
			}
			try {
				const fg = c.finalGate;
				if (fg && typeof fg === "object") keepCtx.finalGate = { intensity: fg.intensity ?? null, tier: fg.tier ?? null, chgSlope: fg.chgSlope ?? null, scSlope: fg.scSlope ?? null };
			} catch {}
			try {
				const cfg = c.cfg;
				if (cfg && typeof cfg === "object") keepCtx.cfg = {
					minHoldSecs: cfg.minHoldSecs ?? null,
					maxHoldSecs: cfg.maxHoldSecs ?? null,
					takeProfitPct: cfg.takeProfitPct ?? null,
					stopLossPct: cfg.stopLossPct ?? null,
					trailPct: cfg.trailPct ?? null,
					minProfitToTrailPct: cfg.minProfitToTrailPct ?? null,
					minNetEdgePct: cfg.minNetEdgePct ?? null,
					edgeSafetyBufferPct: cfg.edgeSafetyBufferPct ?? null,
				};
			} catch {}
			try {
				const an = c.agentSignals;
				if (an && typeof an === "object") {
					const outc = (an.outcomes && typeof an.outcomes === "object") ? an.outcomes : null;
					const recent = outc && Array.isArray(outc.recent) ? outc.recent.slice(Math.max(0, outc.recent.length - 2)) : [];
					keepCtx.agentSignals = {
						fullAiControl: (typeof an.fullAiControl === "boolean") ? an.fullAiControl : undefined,
						outcomes: recent.length ? {
							sessionPnlSol: outc ? (outc.sessionPnlSol ?? null) : null,
							recent: recent.map((r) => ({
								pnlSol: r?.pnlSol ?? null,
								kind: r?.kind ? String(r.kind).slice(0, 24) : undefined,
								decisionAction: r?.decisionAction ? String(r.decisionAction).slice(0, 20) : undefined,
							})),
						} : undefined,
					};
				}
			} catch {}
			if (Object.keys(keepCtx).length) payload.ctx = keepCtx;
		}

		// Provide a tiny decision-critical summary for sell prompts.
		try {
			if (kind === "sell") {
				const c = payload.ctx && typeof payload.ctx === "object" ? payload.ctx : null;
				const pos = payload.pos && typeof payload.pos === "object" ? payload.pos : null;
				const cfg = c && c.cfg && typeof c.cfg === "object" ? c.cfg : null;
				const t = pos && pos.tickNow && typeof pos.tickNow === "object" ? pos.tickNow : null;
				const nowTs = c ? _safeNum(c.nowTs, null) : null;
				const acquiredAt = pos ? _safeNum(pos.acquiredAt, null) : null;
				payload.summary = {
					agentRisk: c?.agentRisk ?? null,
					pnlNetPct: c?.pnlNetPct ?? null,
					inMinHold: c?.inMinHold ?? null,
					inSellGuard: c?.inSellGuard ?? null,
					hasPending: c?.hasPending ?? null,
					rugSev: c?.rugSev ?? null,
					heldSecs: (nowTs != null && acquiredAt != null) ? Math.max(0, Math.floor((nowTs - acquiredAt) / 1000)) : null,
					cfgTpPct: cfg?.takeProfitPct ?? null,
					cfgSlPct: cfg?.stopLossPct ?? null,
					posTpPct: pos?.tpPct ?? null,
					posSlPct: pos?.slPct ?? null,
					posTrailPct: pos?.trailPct ?? null,
					px: t ? { priceUsd: t.priceUsd ?? null, liqUsd: t.liqUsd ?? null, change5m: t.change5m ?? null, change1h: t.change1h ?? null } : undefined,
				};
			}
		} catch {}
		if (p.allowedKeys && Array.isArray(p.allowedKeys)) payload.allowedKeys = p.allowedKeys.slice(0, 60);
		if (p.note) payload.note = String(p.note || "").slice(0, 260);
		if (Object.keys(payload).length) out.payload = payload;

		const s = (p.signals && typeof p.signals === "object") ? p.signals : {};
		const signals = {};
		if (s.agentRisk) signals.agentRisk = String(s.agentRisk || "").slice(0, 16);
		if (typeof s.fullAiControl === "boolean") signals.fullAiControl = s.fullAiControl;

		// Gates: keep only the numeric facts and ok flags.
		try {
			const g = (s.gates && typeof s.gates === "object") ? s.gates : {};
			const gates = {};
			if (g.finalGateReady != null) gates.finalGateReady = !!g.finalGateReady;
			if (g.cooldown && typeof g.cooldown === "object") gates.cooldown = { ok: !!g.cooldown.ok, recentAgeMs: g.cooldown.recentAgeMs ?? null, minRebuyMs: g.cooldown.minRebuyMs ?? null };
			if (g.buyWarmup && typeof g.buyWarmup === "object") gates.buyWarmup = { ready: !!g.buyWarmup.ready, ageMs: g.buyWarmup.ageMs ?? null, minMs: g.buyWarmup.minMs ?? null, seen: g.buyWarmup.seen ?? null, minSeen: g.buyWarmup.minSeen ?? null, seriesN: g.buyWarmup.seriesN ?? null, minSeries: g.buyWarmup.minSeries ?? null };
			if (g.manualEdge && typeof g.manualEdge === "object") gates.manualEdge = { ok: !!g.manualEdge.ok, edgeExclPct: g.manualEdge.edgeExclPct ?? null, minNetEdgePct: g.manualEdge.minNetEdgePct ?? null };
			if (g.entryCost && typeof g.entryCost === "object") gates.entryCost = { on: !!g.entryCost.on, ok: ("ok" in g.entryCost) ? !!g.entryCost.ok : undefined, risk: g.entryCost.risk ?? null, edgeCostPct: g.entryCost.edgeCostPct ?? null, maxEntryCostPct: g.entryCost.maxEntryCostPct ?? null };
			if (g.sim && typeof g.sim === "object") gates.sim = { ready: !!g.sim.ready, mode: g.sim.mode ?? null, horizonSecs: g.sim.horizonSecs ?? null, pHit: g.sim.pHit ?? null, pTerminal: g.sim.pTerminal ?? null, minWinProb: g.sim.minWinProb ?? null, minTerminalProb: g.sim.minTerminalProb ?? null };
			if (g.honeypotOnchain && typeof g.honeypotOnchain === "object") {
				// Avoid biasing the model by calling this a "honeypot" gate. Treat as neutral on-chain labels.
				const hp = g.honeypotOnchain;
				const labels = [];
				try {
					const rs = Array.isArray(hp.reasons) ? hp.reasons : [];
					for (const r of rs) {
						const s = String(r || "").trim();
						if (!s) continue;
						if (s === "token-2022") labels.push("token-2022");
						else if (/^freezeAuthority=/i.test(s)) labels.push("freeze-authority");
						else if (/^mintAuthority=/i.test(s)) labels.push("mint-authority");
						else labels.push(s.slice(0, 40));
					}
				} catch {}
				gates.onchainLabels = {
					mode: hp.mode ?? null,
					ok: ("ok" in hp) ? !!hp.ok : undefined,
					program: hp.program ?? null,
					hasFreezeAuthority: ("hasFreezeAuthority" in hp) ? !!hp.hasFreezeAuthority : undefined,
					hasMintAuthority: ("hasMintAuthority" in hp) ? !!hp.hasMintAuthority : undefined,
					labels: labels.length ? labels.slice(0, 4) : undefined,
					nudge: labels.length ? "soft_sell_risk" : undefined,
				};
			}
			if (Object.keys(gates).length) signals.gates = gates;
		} catch {}

		// Targets and outcomes: keep tiny summaries only.
		try {
			const t = (s.targets && typeof s.targets === "object") ? s.targets : {};
			const targets = {};
			for (const k of ["sessionPnlSol", "minNetEdgePct", "edgeExclPct", "edgeSafetyBufferPct", "baseGoalPct", "requiredGrossTpPct", "takeProfitPct"]) {
				if (k in t) targets[k] = t[k];
			}
			if (Object.keys(targets).length) signals.targets = targets;
		} catch {}
		try {
			const o = (s.outcomes && typeof s.outcomes === "object") ? s.outcomes : {};
			const recent = Array.isArray(o.recent) ? o.recent.slice(Math.max(0, o.recent.length - 6)) : [];
			const last = recent.reduce((best, r) => {
				const ts = _safeNum(r?.ts, 0);
				if (!best) return r;
				return ts > _safeNum(best?.ts, 0) ? r : best;
			}, null);
			if (last && ("pnlSol" in last || "ts" in last || "kind" in last)) {
				const pnl = (typeof last?.pnlSol === "number") ? last.pnlSol : null;
				signals.outcomes = {
					sessionPnlSol: o.sessionPnlSol ?? null,
					lastTrade: {
						ts: last?.ts ?? null,
						kind: last?.kind ? String(last.kind).slice(0, 24) : undefined,
						decisionAction: last?.decisionAction ? String(last.decisionAction).slice(0, 20) : undefined,
						pnlSol: pnl,
						upDown: (typeof pnl === "number") ? (pnl > 0 ? "up" : pnl < 0 ? "down" : "flat") : undefined,
					},
				};
			}
		} catch {}

		if (Object.keys(signals).length) {
			if (!out.payload) out.payload = {};
			out.payload.signals = signals;
		}

		if (kind === "config_scan") {
			try {
				const pp = out.payload && typeof out.payload === "object" ? out.payload : {};
				const keep = {};
				if (pp.market && typeof pp.market === "object") keep.market = pp.market;
				if (pp.allowedKeys && Array.isArray(pp.allowedKeys)) keep.allowedKeys = pp.allowedKeys;
				if (pp.note) keep.note = pp.note;
				if (pp.evolve && typeof pp.evolve === "object") keep.evolve = _compactEvolveAnyForPrompt(pp.evolve) || _redactDeep(pp.evolve, { maxDepth: 5, maxKeys: 60 });
				out.payload = keep;
				try {
					const st = userMsg.state && typeof userMsg.state === "object" ? userMsg.state : null;
					if (st && Object.keys(st).length) out.state = st;
				} catch {}
			} catch {}
		}

		return out;
	} catch {
		return userMsg;
	}
}

function _compactUserMsgForLlm(userMsg) {
	try {
		if (!userMsg || typeof userMsg !== "object") return userMsg;
		const kind = String(userMsg.kind || "").trim().toLowerCase();
		const src = String(userMsg.source || "").slice(0, 80);
		const out = { source: src || "fdv_auto_trader", kind };

		const p = (userMsg.payload && typeof userMsg.payload === "object") ? userMsg.payload : {};
		const payload = {};
		if (typeof p.mint === "string") payload.mint = p.mint;
		if (p.proposed && typeof p.proposed === "object") payload.proposed = p.proposed;
		try {
			if (p.evolve && typeof p.evolve === "object") payload.evolve = _compactEvolveAnyForPrompt(p.evolve) || _redactDeep(p.evolve, { maxDepth: 5, maxKeys: 60 });
		} catch {}

		// For config_scan, keep extra minimal but include stateOverride so the model can size to balance.
		if (kind === "config_scan") {
			try {
				if (p.market && typeof p.market === "object") payload.market = p.market;
				if (p.allowedKeys && Array.isArray(p.allowedKeys)) payload.allowedKeys = p.allowedKeys.slice(0, 80);
				if (p.note) payload.note = String(p.note || "").slice(0, 500);
				if (p.evolve && typeof p.evolve === "object") payload.evolve = _compactEvolveAnyForPrompt(p.evolve) || _redactDeep(p.evolve, { maxDepth: 5, maxKeys: 60 });
				try {
					const st = userMsg.state && typeof userMsg.state === "object" ? userMsg.state : null;
					if (st && Object.keys(st).length) out.state = st;
				} catch {}
				if (Object.keys(payload).length) out.payload = payload;
				return out;
			} catch {
				if (Object.keys(payload).length) out.payload = payload;
				return out;
			}
		}

		// For sell, keep compact position/context (LLM needs exit context).
		if (kind === "sell") {
			try {
				if (p.pos && typeof p.pos === "object") {
					const pos = p.pos;
					const keepPos = {};
					for (const k of [
						"sizeUi",
						"decimals",
						"costSol",
						"hwmSol",
						"acquiredAt",
						"lastBuyAt",
						"lastSellAt",
						"allowRebuy",
						"awaitingSizeSync",
						"warmingHold",
						"sellGuardUntil",
						"warmingMinProfitPct",
						"tpPct",
						"slPct",
						"trailPct",
						"minProfitToTrailPct",
						"entryEdgeExclPct",
						"entryEdgeCostPct",
						"entryTpBumpPct",
						"entryPreMin",
					]) {
						if (k in pos) keepPos[k] = pos[k];
					}
					try {
						const t = pos.tickNow;
						if (t && typeof t === "object") {
							keepPos.tickNow = {
								ts: t.ts ?? null,
								priceUsd: t.priceUsd ?? null,
								liqUsd: t.liqUsd ?? null,
								change5m: t.change5m ?? null,
								change1h: t.change1h ?? null,
								v1hUsd: t.v1hUsd ?? null,
							};
						}
					} catch {}
					if (Object.keys(keepPos).length) payload.pos = keepPos;
				}
			} catch {}

			try {
				if (p.ctx && typeof p.ctx === "object") {
					const c = p.ctx;
					const keepCtx = {};
					for (const k of [
						"agentRisk",
						"nowTs",
						"curSol",
						"curSolNet",
						"pnlPct",
						"pnlNetPct",
						"minNotionalSol",
						"inMinHold",
						"inSellGuard",
						"hasPending",
						"isFastExit",
						"rugSev",
						"forceRug",
						"forcePumpDrop",
						"forceObserverDrop",
						"forceMomentum",
						"forceExpire",
					]) {
						if (k in c) keepCtx[k] = c[k];
					}
					try {
						const fg = c.finalGate;
						if (fg && typeof fg === "object") keepCtx.finalGate = { intensity: fg.intensity ?? null, tier: fg.tier ?? null, chgSlope: fg.chgSlope ?? null, scSlope: fg.scSlope ?? null };
					} catch {}
					try {
						const cfg = c.cfg;
						if (cfg && typeof cfg === "object") keepCtx.cfg = {
							minHoldSecs: cfg.minHoldSecs ?? null,
							maxHoldSecs: cfg.maxHoldSecs ?? null,
							takeProfitPct: cfg.takeProfitPct ?? null,
							stopLossPct: cfg.stopLossPct ?? null,
							trailPct: cfg.trailPct ?? null,
							minProfitToTrailPct: cfg.minProfitToTrailPct ?? null,
							minNetEdgePct: cfg.minNetEdgePct ?? null,
							edgeSafetyBufferPct: cfg.edgeSafetyBufferPct ?? null,
						};
					} catch {}
					try {
						const an = c.agentSignals;
						if (an && typeof an === "object") {
							const outc = (an.outcomes && typeof an.outcomes === "object") ? an.outcomes : null;
							const recent = outc && Array.isArray(outc.recent) ? outc.recent.slice(Math.max(0, outc.recent.length - 2)) : [];
							keepCtx.agentSignals = {
								fullAiControl: (typeof an.fullAiControl === "boolean") ? an.fullAiControl : undefined,
								outcomes: recent.length ? {
									sessionPnlSol: outc ? (outc.sessionPnlSol ?? null) : null,
									recent: recent.map((r) => ({
										pnlSol: r?.pnlSol ?? null,
										kind: r?.kind ? String(r.kind).slice(0, 24) : undefined,
										decisionAction: r?.decisionAction ? String(r.decisionAction).slice(0, 20) : undefined,
									})),
								} : undefined,
							};
						}
					} catch {}
					if (Object.keys(keepCtx).length) payload.ctx = keepCtx;
				}
			} catch {}

			// Provide a tiny decision-critical summary for sell prompts.
			try {
				const c = payload.ctx && typeof payload.ctx === "object" ? payload.ctx : null;
				const pos = payload.pos && typeof payload.pos === "object" ? payload.pos : null;
				const cfg = c && c.cfg && typeof c.cfg === "object" ? c.cfg : null;
				const t = pos && pos.tickNow && typeof pos.tickNow === "object" ? pos.tickNow : null;
				const nowTs = c ? _safeNum(c.nowTs, null) : null;
				const acquiredAt = pos ? _safeNum(pos.acquiredAt, null) : null;
				payload.summary = {
					agentRisk: c?.agentRisk ?? null,
					pnlNetPct: c?.pnlNetPct ?? null,
					inMinHold: c?.inMinHold ?? null,
					inSellGuard: c?.inSellGuard ?? null,
					hasPending: c?.hasPending ?? null,
					rugSev: c?.rugSev ?? null,
					heldSecs: (nowTs != null && acquiredAt != null) ? Math.max(0, Math.floor((nowTs - acquiredAt) / 1000)) : null,
					cfgTpPct: cfg?.takeProfitPct ?? null,
					cfgSlPct: cfg?.stopLossPct ?? null,
					posTpPct: pos?.tpPct ?? null,
					posSlPct: pos?.slPct ?? null,
					posTrailPct: pos?.trailPct ?? null,
					px: t ? { priceUsd: t.priceUsd ?? null, liqUsd: t.liqUsd ?? null, change5m: t.change5m ?? null, change1h: t.change1h ?? null } : undefined,
				};
			} catch {}
		}

		// Compact signals: keep decision-critical summaries.
		const s = (p.signals && typeof p.signals === "object") ? p.signals : {};
		const signals = {};
		if (s.agentRisk) signals.agentRisk = String(s.agentRisk || "").slice(0, 16);
		if (typeof s.fullAiControl === "boolean") signals.fullAiControl = s.fullAiControl;

		try {
			const g = (s.gates && typeof s.gates === "object") ? s.gates : {};
			const gates = {};
			if (g.finalGateReady != null) gates.finalGateReady = !!g.finalGateReady;
			if (g.cooldown && typeof g.cooldown === "object") gates.cooldown = { ok: !!g.cooldown.ok, recentAgeMs: g.cooldown.recentAgeMs ?? null, minRebuyMs: g.cooldown.minRebuyMs ?? null };
			if (g.honeypotOnchain && typeof g.honeypotOnchain === "object") {
				// Avoid biasing the model by calling this a "honeypot" gate. Treat as neutral on-chain labels.
				const hp = g.honeypotOnchain;
				const labels = [];
				try {
					const rs = Array.isArray(hp.reasons) ? hp.reasons : [];
					for (const r of rs) {
						const s = String(r || "").trim();
						if (!s) continue;
						if (s === "token-2022") labels.push("token-2022");
						else if (/^freezeAuthority=/i.test(s)) labels.push("freeze-authority");
						else if (/^mintAuthority=/i.test(s)) labels.push("mint-authority");
						else labels.push(s.slice(0, 40));
					}
				} catch {}
				gates.onchainLabels = {
					mode: hp.mode ?? null,
					ok: ("ok" in hp) ? !!hp.ok : undefined,
					program: hp.program ?? null,
					hasFreezeAuthority: ("hasFreezeAuthority" in hp) ? !!hp.hasFreezeAuthority : undefined,
					hasMintAuthority: ("hasMintAuthority" in hp) ? !!hp.hasMintAuthority : undefined,
					labels: labels.length ? labels.slice(0, 4) : undefined,
					nudge: labels.length ? "soft_sell_risk" : undefined,
				};
			}
			if (g.manualEdge && typeof g.manualEdge === "object") gates.manualEdge = { ok: !!g.manualEdge.ok, edgeExclPct: g.manualEdge.edgeExclPct ?? null, minNetEdgePct: g.manualEdge.minNetEdgePct ?? null };
			if (g.entryCost && typeof g.entryCost === "object") gates.entryCost = { on: !!g.entryCost.on, enforceForRisk: ("enforceForRisk" in g.entryCost) ? !!g.entryCost.enforceForRisk : undefined, risk: g.entryCost.risk ?? null, edgeCostPct: g.entryCost.edgeCostPct ?? null, maxEntryCostPct: g.entryCost.maxEntryCostPct ?? null };
			if (g.sim && typeof g.sim === "object") gates.sim = { ready: !!g.sim.ready, mode: g.sim.mode ?? null, horizonSecs: g.sim.horizonSecs ?? null, pHit: g.sim.pHit ?? null, pTerminal: g.sim.pTerminal ?? null, minWinProb: g.sim.minWinProb ?? null, minTerminalProb: g.sim.minTerminalProb ?? null };
			if (Object.keys(gates).length) signals.gates = gates;
		} catch {}

		// Targets are mostly redundant with other fields; omit to keep prompts small.

		try {
			const kb = (s.kpiBundle && typeof s.kpiBundle === "object") ? s.kpiBundle : null;
			const snap = kb && kb.snapshot && typeof kb.snapshot === "object" ? kb.snapshot : null;
			const snap2 = (!snap && s.kpi && typeof s.kpi === "object") ? s.kpi : null;
			const k = snap || snap2;
			if (k) {
				signals.kpi = {
					symbol: k.symbol ?? null,
					priceUsd: k.priceUsd ?? null,
					chg24: k.chg24 ?? null,
					vol24: k.vol24 ?? null,
					liqUsd: k.liqUsd ?? null,
					tx24: k.tx24 ?? null,
					mcap: k.mcap ?? null,
				};
			}
		} catch {}

		// Edge fields are noisy/redundant vs sim + gate warnings; omit for compact prompts.

		try {
			const sim = (s.entrySim && typeof s.entrySim === "object") ? s.entrySim : null;
			if (sim) {
				signals.entrySim = {
					horizonSecs: sim.horizonSecs ?? null,
					requiredGrossPct: sim.requiredGrossPct ?? null,
					pHit: sim.pHit ?? null,
					pTerminal: sim.pTerminal ?? null,
					muPct: sim.muPct ?? null,
					sigmaPct: sim.sigmaPct ?? null,
				};
			}
		} catch {}

		try {
			const ln = (s.leaderNow && typeof s.leaderNow === "object") ? s.leaderNow : null;
			if (ln) signals.leaderNow = { pumpScore: ln.pumpScore ?? null, v1h: ln.v1h ?? null, chg5m: ln.chg5m ?? null, chg1h: ln.chg1h ?? null };
		} catch {}

		try {
			const tn = (s.tickNow && typeof s.tickNow === "object") ? s.tickNow : null;
			if (tn) signals.tickNow = { ts: tn.ts ?? null, priceUsd: tn.priceUsd ?? null, liqUsd: tn.liqUsd ?? null, change5m: tn.change5m ?? null, change1h: tn.change1h ?? null, v5mUsd: tn.v5mUsd ?? null, v1hUsd: tn.v1hUsd ?? null };
		} catch {}

		try {
			const past = (s.past && typeof s.past === "object") ? s.past : null;
			if (past) {
				const candles = Array.isArray(past.candles) ? past.candles : null;
				const format = Array.isArray(past.format) ? past.format : null;
				const last = Array.isArray(candles) && candles.length ? candles[candles.length - 1] : (Array.isArray(past.lastCandle) ? past.lastCandle : null);
				let candlesTail = null;
				try {
					if (Array.isArray(candles) && candles.length) {
						const tailN = 12;
						const tail = candles.slice(Math.max(0, candles.length - tailN));
						const idxTs = Array.isArray(format) ? Math.max(0, format.indexOf("ts")) : 0;
						const idxO = Array.isArray(format) ? Math.max(0, format.indexOf("oUsd")) : 1;
						const idxC = Array.isArray(format) ? Math.max(0, format.indexOf("cUsd")) : 4;
						candlesTail = tail
							.map((row) => {
								if (!Array.isArray(row)) return null;
								return {
									ts: row[idxTs] ?? null,
									o: row[idxO] ?? null,
									c: row[idxC] ?? null,
								};
							})
							.filter(Boolean);
					}
				} catch {}
				signals.past = {
					source: past.source ?? null,
					timeframe: past.timeframe ?? null,
					tsUnit: past.tsUnit ?? null,
					stats: past.stats ?? null,
					quality: past.quality ?? null,
					lastCandle: last ?? null,
					candlesTail: candlesTail,
				};
			}
		} catch {}

		// Omit wallet/budget (bot already enforces it) and other noisy/redundant scalars.

		try {
			const o = (s.outcomes && typeof s.outcomes === "object") ? s.outcomes : {};
			const recent = Array.isArray(o.recent) ? o.recent.slice(Math.max(0, o.recent.length - 6)) : [];
			const last = recent.reduce((best, r) => {
				const ts = _safeNum(r?.ts, 0);
				if (!best) return r;
				return ts > _safeNum(best?.ts, 0) ? r : best;
			}, null);
			if (last && ("pnlSol" in last || "ts" in last || "kind" in last)) {
				const pnl = (typeof last?.pnlSol === "number") ? last.pnlSol : null;
				signals.outcomes = {
					sessionPnlSol: o.sessionPnlSol ?? null,
					lastTrade: {
						ts: last?.ts ?? null,
						kind: last?.kind ? String(last.kind).slice(0, 24) : undefined,
						decisionAction: last?.decisionAction ? String(last.decisionAction).slice(0, 20) : undefined,
						pnlSol: pnl,
						upDown: (typeof pnl === "number") ? (pnl > 0 ? "up" : pnl < 0 ? "down" : "flat") : undefined,
					},
				};
			}
		} catch {}

		if (Object.keys(signals).length) payload.signals = signals;
		if (Object.keys(payload).length) out.payload = payload;
		return out;
	} catch {
		return userMsg;
	}
}

function _readLs(key, fallback = "") {
	try {
		if (typeof localStorage === "undefined") return fallback;
		return String(localStorage.getItem(String(key || "")) || fallback);
	} catch {
		return fallback;
	}
}

function _readBoolLs(key, fallback = false) {
	try {
		const v = _readLs(key, "").trim().toLowerCase();
		if (!v) return fallback;
		if (v === "1" || v === "true" || v === "yes" || v === "on") return true;
		if (v === "0" || v === "false" || v === "no" || v === "off") return false;
		return fallback;
	} catch {
		return fallback;
	}
}

function _readLsJson(key, fallback = null) {
	try {
		const raw = _readLs(key, "");
		if (!raw) return fallback;
		const json = _safeJsonParse(raw);
		return json ?? fallback;
	} catch {
		return fallback;
	}
}

export function createAutoTraderAgentDriver({
	log,
	getState,
	getConfig,
} = {}) {
	const _rawLog = typeof log === "function" ? log : () => {};
	const _log = (msg, type) => {
		try {
			_rawLog(`[AGENT GARY] ${String(msg ?? "")}`, type);
		} catch {
			try { _rawLog(String(msg ?? ""), type); } catch {}
		}
	};
	const _getState = typeof getState === "function" ? getState : () => ({});
	const _getConfig = typeof getConfig === "function" ? getConfig : () => ({ });

	const cache = new Map();
	const CACHE_TTL_MS = 2500;
	const swarmCache = new Map();
	let _lastSwarmPruneAt = 0;

	const decisionMemory = createDecisionMemory({
		storageKey: "fdv_agent_decision_memory_v1",
		persist: true,
	});

	let _reasoningSessionKey = "";
	let _reasoningSessionModel = "";

	function _pruneSwarmCache(nowTs, ttlMs) {
		try {
			const n = Number.isFinite(Number(nowTs)) ? Number(nowTs) : now();
			const ttl = Math.max(500, Math.min(120000, Math.floor(Number(ttlMs) || 0)));
			// Throttle: avoid O(N) scans too frequently.
			if (n - _lastSwarmPruneAt < 1000) return;
			_lastSwarmPruneAt = n;
			for (const [k, rec] of swarmCache.entries()) {
				try {
					if (!rec || typeof rec !== "object") {
						swarmCache.delete(k);
						continue;
					}
					const at = _safeNum(rec.at, 0);
					const age = at > 0 ? Math.max(0, n - at) : Number.POSITIVE_INFINITY;
					// Delete stale completed entries once they exceed TTL.
					if (!rec.inFlight && age > ttl) {
						swarmCache.delete(k);
						continue;
					}
					// Safety valve: if an in-flight entry is *very* old, drop it too.
					if (rec.inFlight && age > Math.max(ttl * 3, 60000)) {
						swarmCache.delete(k);
						continue;
					}
				} catch {}
			}
		} catch {}
	}

	// Decision memory is implemented in memory.js (ring-buffered + prompt-safe snapshot).

	function _decisionMemoryEnabled() {
		try {
			if (globalThis && globalThis.__fdvAgentDecisionMemory === false) return false;
			if (globalThis && globalThis.__fdvAgentDecisionMemory === true) return true;
		} catch {}
		try {
			const ls = globalThis && globalThis.localStorage;
			if (!ls || typeof ls.getItem !== "function") return true;
			const vRaw = ls.getItem("fdv_agent_decision_memory");
			const v = String(vRaw || "").trim().toLowerCase();
			// Default ON if unset/empty.
			if (!v) return true;
			if (v === "0" || v === "false" || v === "no" || v === "off") return false;
			return (v === "1" || v === "true" || v === "yes" || v === "on");
		} catch {
			return true;
		}
	}

	function _evolvePromptEnabled() {
		try {
			if (globalThis && globalThis.__fdvAgentEvolvePrompt === false) return false;
			if (globalThis && globalThis.__fdvAgentEvolvePrompt === true) return true;
		} catch {}
		try {
			const ls = globalThis && globalThis.localStorage;
			if (!ls || typeof ls.getItem !== "function") return true;
			const v = String(ls.getItem("fdv_agent_evolve_prompt") || "").trim().toLowerCase();
			if (!v) return true;
			if (v === "0" || v === "false" || v === "no" || v === "off") return false;
			return (v === "1" || v === "true" || v === "yes" || v === "on");
		} catch {
			return true;
		}
	}

	function _compactEvolveForPrompt(summary) {
		try {
			const s = (summary && typeof summary === "object") ? summary : null;
			if (!s) return null;
			const p = (s.payload && typeof s.payload === "object") ? s.payload : null;

			const stats0 = (p && p.stats && typeof p.stats === "object") ? p.stats : null;
			const todo0 = (p && p.todo && typeof p.todo === "object") ? p.todo : null;
			const rules0 = (p && Array.isArray(p.rules)) ? p.rules : null;

			const out = { v: 1 };
			if (stats0) {
				out.stats = {
					n: (() => { const n = _safeNum(stats0.n, NaN); return Number.isFinite(n) ? Math.max(0, Math.min(999, Math.floor(n))) : null; })(),
					winRate: (() => { const wr = _safeNum(stats0.winRate, NaN); return Number.isFinite(wr) ? _clampNum(wr, 0, 1) : null; })(),
					avgPnlSol: (() => { const v = _safeNum(stats0.avgPnlSol, NaN); return Number.isFinite(v) ? v : null; })(),
					best: (() => { const v = _safeNum(stats0.best, NaN); return Number.isFinite(v) ? v : null; })(),
					worst: (() => { const v = _safeNum(stats0.worst, NaN); return Number.isFinite(v) ? v : null; })(),
					pendingCritiques: (() => { const v = _safeNum(stats0.pendingCritiques, NaN); return Number.isFinite(v) ? Math.max(0, Math.min(999, Math.floor(v))) : null; })(),
				};
			}
			if (todo0) {
				out.todo = {
					outcomeTs: _safeNum(todo0.outcomeTs, 0) || null,
					mint8: String(todo0.mint8 || String(todo0.mint || "").slice(0, 8) || "").slice(0, 8) || null,
					kind: String(todo0.kind || "").slice(0, 24) || null,
					pnlSol: (() => { const v = _safeNum(todo0.pnlSol, NaN); return Number.isFinite(v) ? v : null; })(),
					action: String(todo0.decisionAction || todo0.action || "").slice(0, 24) || null,
				};
			}
			if (rules0 && rules0.length) {
				out.rules = rules0.slice(0, 3).map((r) => ({
					t: String(r?.text || r?.t || "").slice(0, 140),
					h: Math.max(0, Math.min(99999, Math.floor(_safeNum(r?.hits ?? r?.h ?? r?.hitCount, 0)))),
				})).filter((r) => r.t);
			}

			// Legacy fallback: parse stats/todo/rules out of old multiline EVOLVE text.
			if (!out.stats && (typeof s.text === "string" || typeof s.prompt === "string")) {
				const raw = String(s.prompt || s.text || "");
				const txt = raw.replace(/\r\n/g, "\n");
				const mStats = txt.match(/winRate=(\d+)%\s+avgPnlSol=([-0-9.]+)/i);
				const mBest = txt.match(/best=([-0-9.]+)/i);
				const mWorst = txt.match(/worst=([-0-9.]+)/i);
				const mPending = txt.match(/pendingCritiques=(\d+)/i);
				const mN = txt.match(/EVOLVE:\s*last\s+(\d+)\s+outcomes/i);
				out.stats = {
					n: mN ? Math.max(0, Math.min(999, parseInt(mN[1], 10))) : null,
					winRate: mStats ? _clampNum(parseInt(mStats[1], 10) / 100, 0, 1) : null,
					avgPnlSol: mStats ? _safeNum(mStats[2], null) : null,
					best: mBest ? _safeNum(mBest[1], null) : null,
					worst: mWorst ? _safeNum(mWorst[1], null) : null,
					pendingCritiques: mPending ? Math.max(0, Math.min(999, parseInt(mPending[1], 10))) : null,
				};
				const mTodo = txt.match(/EVOLVE TODO:\s*outcomeTs=(\d+)\s+mint=([^\s…]+).*?kind=([^\s]+)\s+pnlSol=([-0-9.]+).*?action=([^\s]+)?/i);
				if (mTodo) {
					out.todo = {
						outcomeTs: _safeNum(mTodo[1], 0) || null,
						mint8: String(mTodo[2] || "").slice(0, 8) || null,
						kind: String(mTodo[3] || "").slice(0, 24) || null,
						pnlSol: _safeNum(mTodo[4], null),
						action: String(mTodo[5] || "").slice(0, 24) || null,
					};
				}
				try {
					const rulesSection = txt.split(/EVOLVE RULES[^\n]*:\s*/i)[1] || "";
					if (rulesSection) {
						const lines = rulesSection.split("\n").map((l) => l.trim()).filter((l) => l.startsWith("- "));
						const rules = [];
						for (const l of lines) {
							if (rules.length >= 3) break;
							const hits = (() => { const m = l.match(/\(hits=(\d+)\)/i); return m ? parseInt(m[1], 10) : 0; })();
							rules.push({ t: l.replace(/^[-\s]+/, "").replace(/\s*\(hits=.*?\)\s*$/i, "").slice(0, 140), h: Math.max(0, Math.min(99999, hits)) });
						}
						if (rules.length) out.rules = rules;
					}
				} catch {}
			}

			// Drop null-heavy objects.
			try {
				if (out.stats && Object.values(out.stats).every((v) => v == null)) delete out.stats;
				if (out.todo && Object.values(out.todo).every((v) => v == null)) delete out.todo;
				if (Array.isArray(out.rules) && !out.rules.length) delete out.rules;
			} catch {}

			return (out.stats || out.todo || out.rules) ? out : null;
		} catch {
			return null;
		}
	}

	// function _compactEvolveAnyForPrompt(e) {
	// 	try {
	// 		const obj = (e && typeof e === "object") ? e : null;
	// 		if (!obj) return null;
	// 		// If this is a stored summary shape, use the existing compactor.
	// 		if (obj.payload && typeof obj.payload === "object") return _compactEvolveForPrompt(obj);
	// 		// If this already looks like the compact evolve payload shape, normalize it.
	// 		if (obj.stats || obj.todo || obj.rules || obj.text || obj.prompt) {
	// 			return _compactEvolveForPrompt({ payload: obj, text: obj.text, prompt: obj.prompt });
	// 		}
	// 		return null;
	// 	} catch {
	// 		return null;
	// 	}
	// }

	function _updateDecisionMemoryFromPayload(payload) {
		try { decisionMemory.updateFromPayload(payload); } catch {}
	}

	function _updateDecisionMemoryAfterDecision({ kind, payload, decision, ok }) {
		try { decisionMemory.updateAfterDecision({ kind, payload, decision, ok }); } catch {}
	}

	function _decisionMemorySnapshot() {
		try { return decisionMemory.snapshotForPrompt(); } catch { return { v: 2, startedAt: now() }; }
	}
	function _ensureReasoningSessionKey() {
		try {
			if (_reasoningSessionKey) return _reasoningSessionKey;
			// Short, process-local session id; persisted chaining is not required.
			const rand = Math.random().toString(36).slice(2);
			_reasoningSessionKey = `fdv_auto_trader:${now()}:${rand}`;
			return _reasoningSessionKey;
		} catch {
			_reasoningSessionKey = "fdv_auto_trader";
			return _reasoningSessionKey;
		}
	}

	function _isReasoningModel(modelName) {
		try {
			const s = String(modelName || "").trim().toLowerCase();
			// Reasoning-mode models for the OpenAI Responses API.
			return /(?:^|\/)gpt-5\b/.test(s) || /(?:^|\/)o\d+\b/.test(s);
		} catch {
			return false;
		}
	}

	function _shouldLogPrompts(cfgN = null) {
		try {
			const cfgRaw = _getConfig() || {};
			if (cfgRaw && cfgRaw.logPrompts === true) return true;
		} catch {}
		try {
			if (cfgN && cfgN.logPrompts === true) return true;
		} catch {}
		try {
			if (globalThis && globalThis.__fdvLogAgentPrompts === true) return true;
		} catch {}
		try {
			const ls = globalThis && globalThis.localStorage;
			if (!ls || typeof ls.getItem !== "function") return false;
			const v = String(ls.getItem("fdv_agent_log_prompts") || "").trim().toLowerCase();
			return (v === "1" || v === "true" || v === "yes" || v === "on");
		} catch {
			return false;
		}
	}

	function _ensurePromptLogGlobals() {
		try {
			const g = (typeof window !== "undefined") ? window : globalThis;
			if (!g) return;
			if (!g.__fdvAgentPromptLog || !Array.isArray(g.__fdvAgentPromptLog)) g.__fdvAgentPromptLog = [];
			if (!g.__fdvEnableAgentPromptLogs) {
				g.__fdvEnableAgentPromptLogs = (on = true) => {
					const enable = !!on;
					try { g.__fdvLogAgentPrompts = enable; } catch {}
					try { if (g.localStorage) g.localStorage.setItem("fdv_agent_log_prompts", enable ? "1" : "0"); } catch {}
					return enable;
				};
			}
		} catch {}
	}

	function _pushPromptLog(entry) {
		try {
			const g = (typeof window !== "undefined") ? window : globalThis;
			if (!g) return;
			if (!g.__fdvAgentPromptLog || !Array.isArray(g.__fdvAgentPromptLog)) g.__fdvAgentPromptLog = [];
			g.__fdvAgentPromptLog.unshift(entry);
			if (g.__fdvAgentPromptLog.length > 25) g.__fdvAgentPromptLog.length = 25;
		} catch {}
	}

	// Debug helpers (browser): export/clear captures.
	try {
		const g = (typeof window !== "undefined") ? window : globalThis;
		if (g && !g.__fdvTraining) {
			g.__fdvTraining = {
				enabled: () => isTrainingCaptureEnabled(),
				get: () => getTrainingCaptures(),
				clear: () => clearTrainingCaptures(),
				downloadJsonl: () => downloadTrainingCapturesJsonl({ filenamePrefix: "fdv-gary-captures" }),
				cfg: () => {
					try { return TRAINING_CAPTURE || {}; } catch { return {}; }
				},
			};
		}
	} catch {}
	try { _ensurePromptLogGlobals(); } catch {}

	function _enabled() {
		try {
			const cfg = _getConfig() || {};
			if (cfg.enabled === false) return false;
			// Enable if any supported key is present (OpenAI or Gemini via normalized config).
			const c = normalizeLlmConfig(cfg);
			const k = String(c.apiKey || cfg.llmApiKey || cfg.apiKey || cfg.openaiApiKey || "").trim();
			return !!k;
		} catch {
			return false;
		}
	}

	function _fmtShortJson(obj, maxLen = 2200) {
		try {
			const s = JSON.stringify(obj);
			if (typeof s !== "string") return "";
			return s.length > maxLen ? s.slice(0, maxLen) + "…" : s;
		} catch {
			return "";
		}
	}

	function _getClient() {
		try {
			const cfg = _getConfig() || {};
			const cfgN = normalizeLlmConfig(cfg);
			const cacheKey = (() => {
				try {
					return JSON.stringify({
						provider: String(cfgN?.provider || ""),
						baseUrl: String(cfgN?.baseUrl || ""),
						model: String(cfgN?.model || ""),
						timeoutMs: Number(cfgN?.timeoutMs || 0),
						maxTokens: Number(cfgN?.maxTokens || 0),
						hmacSecret: String(cfgN?.hmacSecret || ""),
						apiKey: String(cfgN?.apiKey || ""),
					});
				} catch {
					return "";
				}
			})();
			if (!_getClient._cached) {
				_getClient._cached = { key: "", client: null };
			}
			const prev = _getClient._cached;
			if (prev && prev.client && prev.key && prev.key === cacheKey) return prev.client;
			const client = createChatClientFromConfig(cfg);
			_getClient._cached = { key: cacheKey, client };
			return client;
		} catch {
			try {
				const cfg = _getConfig() || {};
				return createChatClientFromConfig(cfg);
			} catch {
				return null;
			}
		}
	}

	async function _run(kind, payload, opts = null) {
		if (!_enabled()) return { ok: false, disabled: true, err: "disabled" };

		const client = _getClient();
		if (!client) return { ok: false, disabled: true, err: "disabled" };
		const cfgN = (() => {
			try { return normalizeLlmConfig(_getConfig() || {}); } catch { return null; }
		})();
		try { _ensurePromptLogGlobals(); } catch {}
		try {
			if (_decisionMemoryEnabled()) _updateDecisionMemoryFromPayload(payload);
		} catch {}
		const body = _redactDeep(payload);
		const options = (opts && typeof opts === "object") ? opts : {};
		const promptLogOn = _shouldLogPrompts(cfgN);

		const { logKey, cacheKey, cacheEnabled } = (() => {
			try {
				const mint = String(payload?.mint || payload?.targetMint || "").trim();
				const rawCk = String(payload?.cacheKey || options?.cacheKey || "").trim();
				// Cache is opt-in via explicit cacheKey. Never cache sell decisions; they must reflect the latest market state.
				const enabled = !!rawCk && String(kind || "") !== "sell";
				return {
					logKey: `${String(kind || "")}:${mint || rawCk || "global"}`,
					cacheKey: rawCk ? `${String(kind || "")}:${rawCk}` : "",
					cacheEnabled: enabled,
				};
			} catch {
				return { logKey: `${String(kind || "")}:unknown`, cacheKey: "", cacheEnabled: false };
			}
		})();
		const prev = (cacheEnabled && cacheKey) ? cache.get(cacheKey) : null;
		if (prev && (now() - prev.at) < CACHE_TTL_MS) {
			try {
				const cfg = normalizeLlmConfig(_getConfig() || {});
				const model = String(cfg.model || "gpt-4o-mini").trim() || "gpt-4o-mini";
				const mint = String(payload?.mint || payload?.targetMint || "").slice(0, 8);
				_log(`call kind=${String(kind)} mint=${mint} model=${model} (cache-hit)`, "info");
				const js = _fmtShortJson(body);
				if (js) _log(`payload ${js}`, "info");
				if (prev?.res?.ok) _log(`decision ${_fmtShortJson(prev.res.decision || {}, 1200)}`, "info");
			} catch {}
			return prev.res;
		}

		try {
			const cfg = normalizeLlmConfig(_getConfig() || {});
			const model = String(cfg.model || "gpt-4o-mini").trim() || "gpt-4o-mini";
			const mint = String(payload?.mint || payload?.targetMint || "").slice(0, 8);
			_log(`call kind=${String(kind)} mint=${mint} model=${model}`, "info");
			const js = _fmtShortJson(body);
			if (js) _log(`payload ${js}`, "info");
		} catch {}

		const state = options.omitState
			? _redactDeep(("stateOverride" in options) ? options.stateOverride : {},
				(String(cfgN?.provider || "").toLowerCase() === "gary")
					? { maxDepth: 4, maxKeys: 90 }
					: undefined
			)
			: _redactDeep(("stateOverride" in options) ? options.stateOverride : _getState(),
				(String(cfgN?.provider || "").toLowerCase() === "gary")
					? { maxDepth: 4, maxKeys: 90 }
					: undefined
			);
		let userMsg = {
			source: "fdv_auto_trader",
			kind,
			state,
			payload: body,
		};
		// Gary local models are small; keep prompts compact and avoid noisy context.
		try {
			if (String(cfgN?.provider || "").toLowerCase() === "gary") {
				userMsg = _compactUserMsgForGary(userMsg);
			} else {
				// Default ON: full state + full signals is huge and expensive.
				const compactOn = (() => {
					try {
						if (globalThis && globalThis.__fdvCompactAgentPrompts === true) return true;
					} catch {}
					try {
						return _readBoolLs("fdv_agent_compact_prompts", true);
					} catch {
						return true;
					}
				})();
				if (compactOn && (kind === "buy" || kind === "sell" || kind === "config_scan")) {
					userMsg = _compactUserMsgForLlm(userMsg);
				}
			}
		} catch {}
		try {
			if (_decisionMemoryEnabled()) userMsg.decisionMemory = _decisionMemorySnapshot();
		} catch {}

		const evolveSummary = (() => {
			try {
				if (!_evolvePromptEnabled()) return null;
				const s = _readLsJson("fdv_agent_evolve_summary_v1", null);
				return _compactEvolveForPrompt(s);
			} catch {
				return null;
			}
		})();
		const systemPrompt = getGarySystemPrompt(kind, { evolveSummary: "" });
		try {
			if (evolveSummary) {
				if (!userMsg.payload || typeof userMsg.payload !== "object") userMsg.payload = {};
				userMsg.payload.evolve = evolveSummary;
			}
		} catch {}
		const systemPromptFinal = (() => {
			try {
				if (String(cfgN?.provider || "").toLowerCase() !== "gary") return systemPrompt;
				return String(systemPrompt || "").slice(0, 3500);
			} catch {
				return systemPrompt;
			}
		})();

		try {
			if (promptLogOn) {
				const model = String(cfgN?.model || "gpt-4o-mini").trim() || "gpt-4o-mini";
				const mintFull = String(payload?.mint || payload?.targetMint || "");
				const entry = {
					at: now(),
					source: "fdv_auto_trader",
					agent: "gary",
					kind: String(kind || ""),
					mint: mintFull || undefined,
					model,
					provider: String(cfgN?.provider || ""),
					cacheKey: cacheEnabled ? String(cacheKey || "") : undefined,
					request: {
						system: String(systemPromptFinal || "").slice(0, 8000),
						user: _redactDeep(userMsg, { maxDepth: 6, maxKeys: 220 }),
					},
				};
				_pushPromptLog(entry);
				try {
					if (globalThis && globalThis.console && typeof globalThis.console.log === "function") {
						globalThis.console.log("[AGENT GARY] prompt", entry);
					}
				} catch {}
				try {
					const sysLen = String(systemPromptFinal || "").length;
					const userLen = (() => { try { return JSON.stringify(userMsg).length; } catch { return -1; } })();
					_log(`promptLog ON (systemChars=${sysLen}, userChars=${userLen})`, "info");
				} catch {}
			}
		} catch {}

		let text = "";
		let meta = null;
		let agenticMeta = null;
		let agenticText = "";
		let agenticParsed = null;
		let agenticValidated = null;
		try {
			const cfgModel = (() => {
				try { return String(cfgN?.model || "").trim(); } catch { return ""; }
			})();
			const wantsReasoning = _isReasoningModel(cfgModel);
			const normModel = (() => { try { return String(cfgModel || "").trim().toLowerCase(); } catch { return ""; } })();
			const reasoningReset = wantsReasoning && _reasoningSessionModel && _reasoningSessionModel !== normModel;
			if (wantsReasoning) _reasoningSessionModel = normModel;
			else _reasoningSessionModel = "";
			const provider = String(cfgN?.provider || "").trim().toLowerCase();
			const swarmOn = _swarmEnabled({ provider, kind });
			const agenticOn = !swarmOn && _agenticNegotiationEnabled({ provider, kind });

			const baseTemperature = Number.isFinite(Number(options.temperature)) ? Number(options.temperature) : 0.15;
			const baseMaxTokens = Math.max(
				120,
				Number.isFinite(Number(options.maxTokens))
					? Number(options.maxTokens)
					: Number((_getConfig() || {}).maxTokens || 350)
			);

			const reasoningSessionKey = wantsReasoning ? _ensureReasoningSessionKey() : "";
			const reasoningArgsBase = wantsReasoning
				? { reasoningSessionKey, reasoningIncludeEncrypted: true }
				: {};
			const reasoningArgsForFirstCall = wantsReasoning
				? { ...reasoningArgsBase, reasoningReset: !!reasoningReset }
				: {};
			const reasoningArgsForFollowupCall = wantsReasoning
				? { ...reasoningArgsBase, reasoningReset: false }
				: {};

			let didAwaitedReasoningPrepass = false;

			const reqFinal = {
				system: systemPromptFinal,
				user: JSON.stringify(userMsg),
				temperature: baseTemperature,
				maxTokens: baseMaxTokens,
				...(provider === "openai" ? { verbosity: "medium" } : {}),
			};
			try {
				const allowed = (kind === "config_scan" && Array.isArray(payload?.allowedKeys))
					? payload.allowedKeys
					: [];
				reqFinal.responseSchema = _buildDecisionSchema(kind, allowed);
			} catch {}

			if (swarmOn && client && typeof client.chatJsonWithMeta === "function") {
				try {
					_log(`swarm prepass(SWR) kind=${String(kind)} model=${String(cfgModel || "") || provider}`, "info");
				} catch {}
				const roles = [
					{ role: "leader", tempAdd: 0.02 },
					{ role: "meme_flow", tempAdd: 0.05 },
					{ role: "risk_guard", tempAdd: -0.02 },
				];
				const mintFull = String(payload?.mint || payload?.targetMint || "").slice(0, 64);
				const swarmKey = `${provider}:${String(cfgModel || "").trim().toLowerCase()}:${String(kind || "").trim().toLowerCase()}:${mintFull}`;
				const nowTs = now();
				const swarmTtlMs = (() => {
					try {
						const raw = _safeNum(_readLs("fdv_agent_swarm_cache_ttl_ms", "12000"), 12000);
						return Math.max(1500, Math.min(120000, Math.floor(raw)));
					} catch {
						return 12000;
					}
				})();
				_pruneSwarmCache(nowTs, swarmTtlMs);
				const swarmRevalMs = (() => {
					try {
						const raw = _safeNum(_readLs("fdv_agent_swarm_reval_ms", "4500"), 4500);
						return Math.max(500, Math.min(60000, Math.floor(raw)));
					} catch {
						return 4500;
					}
				})();

				const prevSwarmRec = (() => {
					try {
						const r = swarmCache.get(swarmKey);
						return (r && typeof r === "object") ? r : null;
					} catch {
						return null;
					}
				})();
				const prevAge = prevSwarmRec ? Math.max(0, nowTs - _safeNum(prevSwarmRec.at, 0)) : Number.POSITIVE_INFINITY;
				const hasPrev = !!(prevSwarmRec && prevSwarmRec.swarm && typeof prevSwarmRec.swarm === "object");
				const prevFresh = hasPrev && prevAge <= swarmTtlMs;

				// Immediate: attach cached swarm (stale or fresh) so the final decision can use it.
				if (hasPrev) {
					try {
						userMsg.swarm = prevSwarmRec.swarm;
						userMsg.swarmCache = { ageMs: prevAge, fresh: !!prevFresh };
					} catch {}
					try { reqFinal.user = JSON.stringify(userMsg); } catch {}
				}

				const shouldRevalidate = (!hasPrev) || (prevAge >= swarmRevalMs);
				const inFlight = !!(prevSwarmRec && prevSwarmRec.inFlight);
				if (shouldRevalidate && !inFlight) {
					const mkReq = (role, tempAdd = 0) => {
						const sys = _buildSwarmMemberSystemPrompt(systemPromptFinal, role, kind);
						const rKey = (wantsReasoning && reasoningSessionKey)
							? `${String(reasoningSessionKey)}:swarm:${String(role)}`
							: "";
						return {
							system: sys,
							user: JSON.stringify(userMsg),
							temperature: Math.max(0, Math.min(0.45, baseTemperature + tempAdd)),
							maxTokens: Math.max(220, Math.min(900, Math.floor(baseMaxTokens + 220))),
							verbosity: "medium",
							...(wantsReasoning && rKey
								? { reasoningSessionKey: rKey, reasoningReset: !!reasoningReset, reasoningIncludeEncrypted: true }
								: {}),
						};
					};

					const promise = (async () => {
						const settled = await Promise.allSettled(
							roles.map((rr) => client.chatJsonWithMeta(mkReq(rr.role, rr.tempAdd)))
						);
						const members = [];
						for (let i = 0; i < settled.length; i++) {
							const rr = roles[i];
							const s = settled[i];
							if (!s || s.status !== "fulfilled") continue;
							const mm = s.value;
							const t = String(mm?.text || "");
							const p = _safeJsonParse(t);
							const v = _validateAgenticNegotiation(p, kind);
							if (v) {
								v.role = v.role || String(rr.role);
								members.push(v);
							}
						}
						if (!members.length) return null;
						const swarmSummary = _summarizeSwarm(members);
						return {
							v: 1,
							createdAt: now(),
							summary: swarmSummary,
							members: members.map((m) => ({
								role: m.role || null,
								actionPreference: m.actionPreference || null,
								confidence: Number.isFinite(Number(m.confidence)) ? _clampNum(m.confidence, 0, 1) : null,
								keyDrivers: Array.isArray(m.keyDrivers) ? m.keyDrivers.slice(0, 6) : [],
								guardrails: Array.isArray(m.guardrails) ? m.guardrails.slice(0, 6) : [],
								proposed: m.proposed || null,
							})),
						};
					})();

					try { swarmCache.set(swarmKey, { at: nowTs, swarm: prevSwarmRec?.swarm || null, inFlight: promise }); } catch {}

					promise
						.then((swarmObj) => {
							try {
								if (!swarmObj) return;
								swarmCache.set(swarmKey, { at: now(), swarm: swarmObj, inFlight: null });
							} catch {}
							try {
								if (_decisionMemoryEnabled()) {
										decisionMemory.recordSwarm({ kind: String(kind || ""), mint: mintFull || null, members: swarmObj?.members || [] });
								}
							} catch {}
						})
						.catch(() => {
							try {
								const cur = swarmCache.get(swarmKey);
								if (cur && typeof cur === "object") swarmCache.set(swarmKey, { at: cur.at || 0, swarm: cur.swarm || null, inFlight: null });
							} catch {}
						});
				}
			}
			// Fallback: single agentic pre-pass (legacy), only when swarm is disabled.
			else if (agenticOn && client && typeof client.chatJsonWithMeta === "function") {
				try {
					_log(`agentic prepass kind=${String(kind)} model=${String(cfgModel || "") || provider}`, "info");
				} catch {}
				const sysAgentic = _buildAgenticNegotiationSystemPrompt(systemPromptFinal);
				const reqAgentic = {
					system: sysAgentic,
					user: JSON.stringify(userMsg),
					temperature: Math.max(0, Math.min(0.35, baseTemperature + 0.05)),
					maxTokens: Math.max(220, Math.min(900, Math.floor(baseMaxTokens + 220))),
					verbosity: "medium",
					...reasoningArgsForFirstCall,
				};
				agenticMeta = await client.chatJsonWithMeta(reqAgentic);
				if (wantsReasoning) didAwaitedReasoningPrepass = true;
				agenticText = String(agenticMeta?.text || "");
				agenticParsed = _safeJsonParse(agenticText);
				agenticValidated = _validateAgenticNegotiation(agenticParsed, kind);
				if (agenticValidated) {
					try {
						userMsg.agentic = {
							v: 1,
							negotiatedAt: now(),
							prepass: agenticValidated,
						};
					} catch {}
					try { reqFinal.user = JSON.stringify(userMsg); } catch {}
				}
			}


			if (wantsReasoning) {
				Object.assign(
					reqFinal,
					didAwaitedReasoningPrepass ? reasoningArgsForFollowupCall : reasoningArgsForFirstCall
				);
			}

			if (client && typeof client.chatJsonWithMeta === "function") {
				meta = await client.chatJsonWithMeta(reqFinal);
				// For Gary, prefer the server-extracted parsed JSON when available.
				try {
					if (String(cfgN?.provider || "").toLowerCase() === "gary") {
						const p = meta && Object.prototype.hasOwnProperty.call(meta, "parsed") ? meta.parsed : null;
						if (p && (typeof p === "object" || Array.isArray(p))) {
							text = JSON.stringify(p);
						} else {
							text = String(meta?.text || "");
						}
					} else {
						text = String(meta?.text || "");
					}
				} catch {
					text = String(meta?.text || "");
				}
			} else {
				text = await client.chatJson(reqFinal);
			}
		} catch (e) {
			try { _log(`request failed: ${String(e?.message || e || "")}` , "warn"); } catch {}
			const res = { ok: false, err: String(e?.message || e || "") };
			try {
				let uploadToGary = null;
				try {
					// Auto-enable upload-to-gary when Gary config is populated, regardless of the active LLM provider.
					const g = (typeof window !== "undefined") ? window : globalThis;
					const o = g && g.__fdvAgentOverrides && typeof g.__fdvAgentOverrides === "object" ? g.__fdvAgentOverrides : null;
					let baseUrl = String((o && (o.garyBaseUrl || o.garyUrl)) ? (o.garyBaseUrl || o.garyUrl) : _readLs("fdv_gary_base_url", "")).trim();
					const apiKey = String((o && (o.garyApiKey || o.garyKey)) ? (o.garyApiKey || o.garyKey) : _readLs("fdv_gary_key", "")).trim();
					const hmacSecret = String((o && (o.garyHmacSecret || o.hmacSecret)) ? (o.garyHmacSecret || o.hmacSecret) : _readLs("fdv_gary_hmac_secret", "")).trim();
					if (!baseUrl && apiKey) baseUrl = "http://127.0.0.1:8088";
					if (baseUrl && apiKey) uploadToGary = { provider: "gary", baseUrl, apiKey, hmacSecret };
				} catch {}

				if (TRAINING_CAPTURE?.enabled || uploadToGary) {
					appendTrainingCapture({
						mode: "inference",
						source: "fdv_auto_trader",
						kind: String(kind || ""),
						ok: false,
						err: String(res.err || ""),
						userMsg,
						system: String(systemPromptFinal || "").slice(0, 8000),
						text: "",
						meta: _redactDeep(meta),
					}, { storageKey: TRAINING_CAPTURE?.storageKey, maxEntries: TRAINING_CAPTURE?.maxEntries, uploadToGary }).catch(() => {});
				}
			} catch {}
			if (cacheEnabled && cacheKey) cache.set(cacheKey, { at: now(), res });
			return res;
		}

		try {
			if (meta && typeof meta === "object") {
				const est = Number(meta.estPromptTokens || 0);
				const u = meta.usage || null;
				const pt = u && Number.isFinite(Number(u.promptTokens)) ? Number(u.promptTokens) : null;
				const ct = u && Number.isFinite(Number(u.completionTokens)) ? Number(u.completionTokens) : null;
				const tt = u && Number.isFinite(Number(u.totalTokens)) ? Number(u.totalTokens) : null;
				const parts = [];
				if (est > 0) parts.push(`estPrompt≈${est}`);
				if (pt !== null) parts.push(`prompt=${pt}`);
				if (ct !== null) parts.push(`completion=${ct}`);
				if (tt !== null) parts.push(`total=${tt}`);
				if (parts.length) _log(`tokens ${parts.join(" ")}`, "info");
			}
		} catch {}

		let parsed = _safeJsonParse(text);
		parsed = _coerceWrongKindDecision(kind, parsed);
		const validated = (kind === "buy")
			? _validateBuyDecision(parsed)
			: (kind === "sell")
				? _validateSellDecision(parsed)
				: (kind === "config_scan")
					? _validateConfigScanDecision(parsed, payload?.allowedKeys)
					: null;
		const res = validated
			? { ok: true, decision: validated }
			: { ok: false, err: "invalid_json" };
		try {
			if (_decisionMemoryEnabled()) _updateDecisionMemoryAfterDecision({ kind, payload, decision: validated, ok: res.ok });
		} catch {}

		try {
			let uploadToGary = null;
			try {
				// Auto-enable upload-to-gary when Gary config is populated, regardless of the active LLM provider.
				const g = (typeof window !== "undefined") ? window : globalThis;
				const o = g && g.__fdvAgentOverrides && typeof g.__fdvAgentOverrides === "object" ? g.__fdvAgentOverrides : null;
				let baseUrl = String((o && (o.garyBaseUrl || o.garyUrl)) ? (o.garyBaseUrl || o.garyUrl) : _readLs("fdv_gary_base_url", "")).trim();
				const apiKey = String((o && (o.garyApiKey || o.garyKey)) ? (o.garyApiKey || o.garyKey) : _readLs("fdv_gary_key", "")).trim();
				const hmacSecret = String((o && (o.garyHmacSecret || o.hmacSecret)) ? (o.garyHmacSecret || o.hmacSecret) : _readLs("fdv_gary_hmac_secret", "")).trim();
				if (!baseUrl && apiKey) baseUrl = "http://127.0.0.1:8088";
				if (baseUrl && apiKey) uploadToGary = { provider: "gary", baseUrl, apiKey, hmacSecret };
			} catch {}

			const wantLocal = !!TRAINING_CAPTURE?.enabled && (res.ok || !!TRAINING_CAPTURE?.includeBad);
			const wantRemote = !!uploadToGary;
			if (wantLocal || wantRemote) {
				let captureText = String(text || "");
				try {
					// Some providers return parsed JSON but no raw `text`. Ensure we still store the response.
					if (!captureText && validated && typeof validated === "object") captureText = JSON.stringify(validated);
				} catch {}
				appendTrainingCapture({
					mode: "inference",
					source: "fdv_auto_trader",
					kind: String(kind || ""),
					ok: !!res.ok,
					err: res.ok ? "" : String(res.err || ""),
					userMsg,
					system: String(systemPromptFinal || "").slice(0, 8000),
					text: String(captureText || "").slice(0, 20000),
					parsed: _redactDeep(parsed),
					decision: _redactDeep(validated),
					meta: _redactDeep(meta),
				}, { storageKey: TRAINING_CAPTURE?.storageKey, maxEntries: TRAINING_CAPTURE?.maxEntries, uploadToGary }).catch(() => {});
			}
		} catch {}
		try {
			if (res.ok) {
				const d = res.decision || {};
				_log(`decision ${_fmtShortJson(d, 1200)}`, "info");
				try {
					if (promptLogOn) {
						const entry = { at: now(), agent: "gary", kind: String(kind || ""), response: _redactDeep(d) };
						_pushPromptLog(entry);
						try { if (globalThis?.console?.log) globalThis.console.log("[AGENT GARY] response", entry); } catch {}
					}
				} catch {}
			} else {
				const snippet = String(text || "").slice(0, 600);
				_log(`bad response err=${String(res.err || "unknown")} raw=${_fmtShortJson(_redactDeep(snippet), 800)}`, "warn");
				try {
					if (promptLogOn) {
						const entry = { at: now(), agent: "gary", kind: String(kind || ""), error: String(res.err || ""), raw: String(snippet || "") };
						_pushPromptLog(entry);
						try { if (globalThis?.console?.warn) globalThis.console.warn("[AGENT GARY] response (invalid)", entry); } catch {}
					}
				} catch {}
			}
		} catch {}
		if (cacheEnabled && cacheKey) cache.set(cacheKey, { at: now(), res });
		return res;
	}

	return {
		getConfigFromRuntime() {
			try {
				// Priority: explicit overrides on window -> localStorage.
				const g = (typeof window !== "undefined") ? window : globalThis;
				const o = g && g.__fdvAgentOverrides && typeof g.__fdvAgentOverrides === "object" ? g.__fdvAgentOverrides : null;
				const lsEnabled = _readBoolLs("fdv_agent_enabled", true);
				const riskRaw = String((o && o.riskLevel) ? o.riskLevel : _readLs("fdv_agent_risk", "safe")).trim().toLowerCase();
				const riskLevel = (riskRaw === "safe" || riskRaw === "medium" || riskRaw === "degen") ? riskRaw : "safe";

				const _inferProviderForModel = (modelName) => {
					try {
						const s = String(modelName || "").trim().toLowerCase();
						if (!s) return "openai";
						if (s === "gary-predictions-v1" || s.startsWith("gary-")) return "gary";
						if (s.startsWith("gemini-")) return "gemini";
						if (s === "deepseek-chat" || s === "deepseek-reasoner" || s.startsWith("deepseek-")) return "deepseek";
						if (s.startsWith("grok-")) return "grok";
						return "openai";
					} catch {
						return "openai";
					}
				};

				const llmProvider = String(
					(o && (o.llmProvider || o.provider)) ? (o.llmProvider || o.provider) : _readLs("fdv_llm_provider", "")
				).trim().toLowerCase();

				const llmModel = String(
					(o && (o.llmModel || o.model || o.openaiModel))
						? (o.llmModel || o.model || o.openaiModel)
						: _readLs("fdv_llm_model", _readLs("fdv_openai_model", "gpt-4o-mini"))
				).trim() || "gpt-4o-mini";

				const provider = (llmProvider === "gemini" || llmProvider === "grok" || llmProvider === "deepseek" || llmProvider === "openai" || llmProvider === "gary")
					? llmProvider
					: _inferProviderForModel(llmModel);

				const openaiKey = (o && (o.openaiApiKey || o.apiKey || o.llmApiKey) && provider === "openai")
					? String(o.openaiApiKey || o.apiKey || o.llmApiKey)
					: _readLs("fdv_openai_key", "");

				const geminiKey = (o && (o.geminiApiKey || o.geminiKey || (provider === "gemini" ? (o.apiKey || o.llmApiKey) : "")))
					? String(o.geminiApiKey || o.geminiKey || o.apiKey || o.llmApiKey)
					: _readLs("fdv_gemini_key", "");

				const grokKey = (o && (o.grokApiKey || o.grokKey || (provider === "grok" ? (o.apiKey || o.llmApiKey) : "")))
					? String(o.grokApiKey || o.grokKey || o.apiKey || o.llmApiKey)
					: _readLs("fdv_grok_key", "");

				const deepseekKey = (o && (o.deepseekApiKey || o.deepseekKey || (provider === "deepseek" ? (o.apiKey || o.llmApiKey) : "")))
					? String(o.deepseekApiKey || o.deepseekKey || o.apiKey || o.llmApiKey)
					: _readLs("fdv_deepseek_key", "");

				const garyKey = (o && (o.garyApiKey || o.garyKey || (provider === "gary" ? (o.apiKey || o.llmApiKey) : "")))
					? String(o.garyApiKey || o.garyKey || o.apiKey || o.llmApiKey)
					: _readLs("fdv_gary_key", "");

				const llmApiKey = String(
					(o && (o.llmApiKey || o.apiKey))
						? (o.llmApiKey || o.apiKey)
						: (provider === "gary")
							? garyKey
						: (provider === "gemini")
							? geminiKey
							: (provider === "grok")
								? grokKey
								: (provider === "deepseek")
									? deepseekKey
								: openaiKey
				).trim();

				const openaiBaseUrl = String((o && o.openaiBaseUrl) ? o.openaiBaseUrl : _readLs("fdv_openai_base_url", "https://api.openai.com/v1")).trim() || "https://api.openai.com/v1";
				const geminiBaseUrl = String((o && (o.geminiBaseUrl || o.llmBaseUrl || o.baseUrl))
					? (o.geminiBaseUrl || o.llmBaseUrl || o.baseUrl)
					: _readLs("fdv_gemini_base_url", "https://generativelanguage.googleapis.com/v1beta")
				).trim() || "https://generativelanguage.googleapis.com/v1beta";
				const grokBaseUrl = String((o && (o.grokBaseUrl || o.llmBaseUrl || o.baseUrl))
					? (o.grokBaseUrl || o.llmBaseUrl || o.baseUrl)
					: _readLs("fdv_grok_base_url", "https://api.x.ai/v1")
				).trim() || "https://api.x.ai/v1";
				const deepseekBaseUrl = String((o && (o.deepseekBaseUrl || o.llmBaseUrl || o.baseUrl))
					? (o.deepseekBaseUrl || o.llmBaseUrl || o.baseUrl)
					: _readLs("fdv_deepseek_base_url", "https://api.deepseek.com")
				).trim() || "https://api.deepseek.com";
				const garyBaseUrl = String((o && (o.garyBaseUrl || o.llmBaseUrl || o.baseUrl))
					? (o.garyBaseUrl || o.llmBaseUrl || o.baseUrl)
					: _readLs("fdv_gary_base_url", "http://127.0.0.1:8088")
				).trim() || "http://127.0.0.1:8088";

				const llmBaseUrl = String(
					(o && (o.llmBaseUrl || o.baseUrl))
						? (o.llmBaseUrl || o.baseUrl)
						: (provider === "gary")
							? garyBaseUrl
						: (provider === "gemini")
							? geminiBaseUrl
							: (provider === "grok")
								? grokBaseUrl
								: (provider === "deepseek")
									? deepseekBaseUrl
								: openaiBaseUrl
				).trim();

				return {
					enabled: o && ("enabled" in o) ? !!o.enabled : lsEnabled,
					riskLevel,
					// Provider-agnostic keys used by the framework factory.
					llmProvider: provider,
					llmApiKey,
					llmModel,
					llmBaseUrl,
					llmTimeoutMs: (() => {
						const fallback = (provider === "gary")
							? _readLs("fdv_gary_timeout_ms", "45000")
							: _readLs("fdv_openai_timeout_ms", "12000");
						return _safeNum((o && o.llmTimeoutMs) ? o.llmTimeoutMs : _readLs("fdv_llm_timeout_ms", fallback), (provider === "gary") ? 45000 : 12000);
					})(),

					// Back-compat: older fields expected by legacy paths/logging.
					openaiApiKey: provider === "openai" ? openaiKey : "",
					openaiModel: provider === "openai" ? llmModel : "",
					openaiBaseUrl: provider === "openai" ? llmBaseUrl : openaiBaseUrl,

					timeoutMs: _safeNum((o && o.timeoutMs) ? o.timeoutMs : _readLs("fdv_openai_timeout_ms", "12000"), 12000),
					maxTokens: _safeNum((o && o.maxTokens) ? o.maxTokens : _readLs("fdv_openai_max_tokens", "350"), 350),
				};
			} catch {
				return { enabled: false, openaiApiKey: "" };
			}
		},

		async decideBuy({ mint, proposedBuySolUi, proposedSlippageBps, signals } = {}) {
			const payload = {
				mint: String(mint || "").trim(),
				proposed: {
					buySolUi: _safeNum(proposedBuySolUi, 0),
					slippageBps: Math.floor(_safeNum(proposedSlippageBps, 0)),
				},
				signals: signals && typeof signals === "object" ? signals : {},
			};
			return await _run("buy", payload);
		},

		async decideSell({ mint, pos, ctx } = {}) {
			const payload = {
				mint: String(mint || "").trim(),
				pos: pos && typeof pos === "object" ? pos : {},
				ctx: ctx && typeof ctx === "object" ? ctx : {},
			};
			return await _run("sell", payload);
		},

		async scanConfig({ market, allowedKeys, keyHints, note, stateSummary } = {}) {
			const cfgN = (() => {
				try { return normalizeLlmConfig(_getConfig() || {}); } catch { return null; }
			})();
			const payload = {
				cacheKey: "startup",
				market: market && typeof market === "object" ? market : {},
				allowedKeys: Array.isArray(allowedKeys) ? allowedKeys.slice(0, 60).map(String) : [],
				// Key hints are huge; tiny local models do better without them.
				keyHints: (String(cfgN?.provider || "").toLowerCase() === "gary")
					? undefined
					: ((keyHints && typeof keyHints === "object" && Object.keys(keyHints).length) ? keyHints : undefined),
				note: String(note || "").slice(0, 500),
			};
			const first = await _run("config_scan", payload, {
				cacheKey: "startup",
				omitState: true,
				temperature: 0.08,
				maxTokens: 700,
				stateOverride: stateSummary && typeof stateSummary === "object" ? stateSummary : {},
			});

			let res = first;

			// Retry if the model produced truncated/invalid JSON.
			if (res && res.ok === false && String(res.err || "") === "invalid_json") {
				const payload2 = {
					cacheKey: "startup_retry",
					market: market && typeof market === "object" ? market : {},
					allowedKeys: Array.isArray(allowedKeys) ? allowedKeys.slice(0, 80).map(String) : [],
					note: (String(note || "").slice(0, 340) + "\nRetry: return ONLY valid JSON. Keep config <= 12 keys, only changed keys. Avoid trailing commas. Omit reason if possible.").slice(0, 500),
				};
				res = await _run("config_scan", payload2, {
					cacheKey: "startup_retry",
					omitState: true,
					temperature: 0.03,
					maxTokens: 900,
					stateOverride: stateSummary && typeof stateSummary === "object" ? stateSummary : {},
				});
			}

			// Last resort: ultra-minimal schema (reduces completion size and truncation risk).
			if (res && res.ok === false && String(res.err || "") === "invalid_json") {
				const payload3 = {
					cacheKey: "startup_retry_min",
					market: market && typeof market === "object" ? market : {},
					allowedKeys: Array.isArray(allowedKeys) ? allowedKeys.slice(0, 60).map(String) : [],
					note: "Return ONLY JSON: {action:'apply'|'skip', confidence:0..1, config?:{...}}. No reason field. config must have <= 10 keys from allowedKeys. No trailing commas.",
				};
				res = await _run("config_scan", payload3, {
					cacheKey: "startup_retry_min",
					omitState: true,
					temperature: 0.02,
					maxTokens: 650,
					stateOverride: stateSummary && typeof stateSummary === "object" ? stateSummary : {},
				});
			}

			return res;
		},
	};
}

export function createAgentJsonRunner({
	log,
	getConfig,
	fetchFn,
	prefix = "AGENT",
	cacheTtlMs = 2500,
} = {}) {
	const _rawLog = typeof log === "function" ? log : () => {};
	const _log = (msg, type) => {
		try {
			const p = String(prefix || "").trim();
			_rawLog(p ? `[${p}] ${String(msg ?? "")}` : String(msg ?? ""), type);
		} catch {
			try { _rawLog(String(msg ?? ""), type); } catch {}
		}
	};
	const _getConfig = typeof getConfig === "function" ? getConfig : () => ({});

	const cache = new Map();

	function _shouldLogPrompts(cfg, { logRequest = false } = {}) {
		try {
			if (logRequest) return true;
			if (cfg && cfg.logPrompts === true) return true;
		} catch {}
		try {
			if (globalThis && globalThis.__fdvLogAgentPrompts === true) return true;
		} catch {}
		try {
			const ls = globalThis && globalThis.localStorage;
			if (!ls || typeof ls.getItem !== "function") return false;
			const v = String(ls.getItem("fdv_agent_log_prompts") || "").trim().toLowerCase();
			return (v === "1" || v === "true" || v === "yes" || v === "on");
		} catch {
			return false;
		}
	}

	function _dbgStore(entry) {
		try {
			if (!globalThis) return;
			if (!globalThis.__fdvAgentPromptLog || !Array.isArray(globalThis.__fdvAgentPromptLog)) {
				globalThis.__fdvAgentPromptLog = [];
			}
			globalThis.__fdvAgentPromptLog.unshift(entry);
			if (globalThis.__fdvAgentPromptLog.length > 25) globalThis.__fdvAgentPromptLog.length = 25;
		} catch {}
	}

	function _getCfgSafe() {
		try {
			return normalizeLlmConfig(_getConfig() || {});
		} catch {
			return { enabled: false, apiKey: "" };
		}
	}

	function _enabled(cfg) {
		try {
			if (!cfg || cfg.enabled === false) return false;
			return !!String(cfg.apiKey || "").trim();
		} catch {
			return false;
		}
	}

	function _getClient(cfg) {
		try {
			const c = cfg && typeof cfg === "object" ? cfg : {};
			return createChatClientFromConfig(c, { fetchFn });
		} catch {
			return null;
		}
	}

	function _cacheGet(key) {
		try {
			const rec = cache.get(key);
			if (!rec) return null;
			if ((now() - rec.at) > cacheTtlMs) { cache.delete(key); return null; }
			return rec.res;
		} catch {
			return null;
		}
	}

	function _cacheSet(key, res) {
		try { cache.set(key, { at: now(), res }); } catch {}
	}

	async function chatJsonWithMeta({
		system,
		user,
		temperature = 0.1,
		maxTokens = null,
		cacheKey = "",
		logRequest = false,
	} = {}) {
		const cfg = _getCfgSafe();
		if (!_enabled(cfg)) return { ok: false, disabled: true };
		const client = _getClient(cfg);
		if (!client) return { ok: false, disabled: true };

		const ck = String(cacheKey || "");
		if (ck) {
			const prev = _cacheGet(ck);
			if (prev) return prev;
		}

		try {
			const model = String(cfg.model || "");
			if (logRequest) _log(`call model=${model}`, "info");

			const logPrompts = _shouldLogPrompts(cfg, { logRequest });
			if (logPrompts) {
				const safeCfg = { provider: String(cfg.provider || ""), model: String(cfg.model || "") };
				const safeReq = _redactDeep({
					cacheKey: String(cacheKey || ""),
					temperature: Number.isFinite(Number(temperature)) ? Number(temperature) : 0.1,
					maxTokens: Math.max(120, Number.isFinite(Number(maxTokens)) ? Number(maxTokens) : Number(cfg.maxTokens || 350)),
					system: String(system || ""),
					user: String(user || ""),
				});

				_dbgStore({ at: now(), prefix: String(prefix || "AGENT"), cfg: safeCfg, req: safeReq });
				try {
					if (globalThis && globalThis.console && typeof globalThis.console.log === "function") {
						globalThis.console.log(`[${String(prefix || "AGENT")}] prompt`, { cfg: safeCfg, req: safeReq });
					}
				} catch {}
			}
		} catch {}

		let meta = null;
		let text = "";
		try {
			const req = {
				system: String(system || ""),
				user: String(user || ""),
				temperature: Number.isFinite(Number(temperature)) ? Number(temperature) : 0.1,
				maxTokens: Math.max(120, Number.isFinite(Number(maxTokens)) ? Number(maxTokens) : Number(cfg.maxTokens || 350)),
			};
			meta = await client.chatJsonWithMeta(req);
			text = String(meta?.text || "");
		} catch (e) {
			try { _log(`request failed: ${String(e?.message || e || "")}`, "warn"); } catch {}
			const res = { ok: false, err: String(e?.message || e || "") };
			try {
				appendTrainingCapture({
					mode: "runner",
					source: String(prefix || "AGENT"),
					ok: false,
					err: String(res.err || ""),
					system: String(system || "").slice(0, 8000),
					user: String(user || "").slice(0, 20000),
					text: "",
					meta: null,
				}, { storageKey: TRAINING_CAPTURE?.storageKey, maxEntries: TRAINING_CAPTURE?.maxEntries }).catch(() => {});
			} catch {}
			if (ck) _cacheSet(ck, res);
			return res;
		}

		try {
			if (meta && typeof meta === "object") {
				const est = Number(meta.estPromptTokens || 0);
				const u = meta.usage || null;
				const pt = u && Number.isFinite(Number(u.promptTokens)) ? Number(u.promptTokens) : null;
				const ct = u && Number.isFinite(Number(u.completionTokens)) ? Number(u.completionTokens) : null;
				const tt = u && Number.isFinite(Number(u.totalTokens)) ? Number(u.totalTokens) : null;
				const parts = [];
				if (est > 0) parts.push(`estPrompt≈${est}`);
				if (pt !== null) parts.push(`prompt=${pt}`);
				if (ct !== null) parts.push(`completion=${ct}`);
				if (tt !== null) parts.push(`total=${tt}`);
				if (parts.length) _log(`tokens ${parts.join(" ")}`, "info");
			}
		} catch {}

		const parsed = _safeJsonParse(text);
		const res = { ok: true, text, parsed, meta };

		try {
			appendTrainingCapture({
				mode: "runner",
				source: String(prefix || "AGENT"),
				ok: true,
				err: "",
				system: String(system || "").slice(0, 8000),
				user: String(user || "").slice(0, 20000),
				text: String(text || "").slice(0, 20000),
				parsed: _redactDeep(parsed),
				meta: _redactDeep(meta),
			}, { storageKey: TRAINING_CAPTURE?.storageKey, maxEntries: TRAINING_CAPTURE?.maxEntries }).catch(() => {});
		} catch {}

		try {
			const logPrompts = _shouldLogPrompts(cfg, { logRequest });
			if (logPrompts) {
				const safeParsed = _redactDeep(parsed);
				_dbgStore({ at: now(), prefix: String(prefix || "AGENT"), res: safeParsed });
				try {
					if (globalThis && globalThis.console && typeof globalThis.console.log === "function") {
						globalThis.console.log(`[${String(prefix || "AGENT")}] response`, safeParsed);
					}
				} catch {}
			}
		} catch {}

		if (ck) _cacheSet(ck, res);
		return res;
	}

	return { chatJsonWithMeta };
}
