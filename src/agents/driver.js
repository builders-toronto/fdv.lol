import { createChatClientFromConfig, normalizeLlmConfig } from "./frameworks/index.js";
import { TRAINING_CAPTURE } from "../config/env.js";
import { appendTrainingCapture, clearTrainingCaptures, downloadTrainingCapturesJsonl, getTrainingCaptures, isTrainingCaptureEnabled } from "./training.js";

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
		// Heuristic recovery: strip code fences / surrounding prose and parse the first JSON object/array.
		try {
			let t = String(s || "");
			// ```json ... ``` or ``` ... ```
			t = t.replace(/^\s*```(?:json)?\s*/i, "").replace(/\s*```\s*$/i, "");
			const firstObj = t.indexOf("{");
			const lastObj = t.lastIndexOf("}");
			if (firstObj >= 0 && lastObj > firstObj) {
				return JSON.parse(t.slice(firstObj, lastObj + 1));
			}
			const firstArr = t.indexOf("[");
			const lastArr = t.lastIndexOf("]");
			if (firstArr >= 0 && lastArr > firstArr) {
				return JSON.parse(t.slice(firstArr, lastArr + 1));
			}
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

function _validateConfigScanDecision(obj) {
	try {
		if (!obj || typeof obj !== "object") return null;
		const action = String(obj.action || "").toLowerCase();
		if (action !== "apply" && action !== "skip") return null;
		const confidence = _clampNum(obj.confidence, 0, 1);
		const reason = String(obj.reason || "").slice(0, 220);
		const out = { kind: "config_scan", action, confidence, reason };
		if (obj.config && typeof obj.config === "object") {
			const cfg = {};
			let n = 0;
			for (const [k, v] of Object.entries(obj.config)) {
				n++;
				if (n > 120) break;
				const key = String(k || "").slice(0, 80);
				if (!key) continue;
				const t = typeof v;
				if (t === "number" || t === "boolean" || t === "string") cfg[key] = v;
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
						agentRisk: an.agentRisk ? String(an.agentRisk).slice(0, 16) : undefined,
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

		// For config_scan, keep extra minimal: only market/allowedKeys/note.
		if (kind === "config_scan") {
			try {
				const pp = out.payload && typeof out.payload === "object" ? out.payload : {};
				const keep = {};
				if (pp.market && typeof pp.market === "object") keep.market = pp.market;
				if (pp.allowedKeys && Array.isArray(pp.allowedKeys)) keep.allowedKeys = pp.allowedKeys;
				if (pp.note) keep.note = pp.note;
				out.payload = keep;
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

		// For config_scan, keep extra minimal: only market/allowedKeys/note.
		if (kind === "config_scan") {
			try {
				if (p.market && typeof p.market === "object") payload.market = p.market;
				if (p.allowedKeys && Array.isArray(p.allowedKeys)) payload.allowedKeys = p.allowedKeys.slice(0, 80);
				if (p.note) payload.note = String(p.note || "").slice(0, 500);
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
								agentRisk: an.agentRisk ? String(an.agentRisk).slice(0, 16) : undefined,
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
				const last = Array.isArray(past.candles) && past.candles.length ? past.candles[past.candles.length - 1] : (Array.isArray(past.lastCandle) ? past.lastCandle : null);
				signals.past = {
					source: past.source ?? null,
					timeframe: past.timeframe ?? null,
					stats: past.stats ?? null,
					quality: past.quality ?? null,
					lastCandle: last ?? null,
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
		const cfg = _getConfig() || {};
		return createChatClientFromConfig(cfg);
	}

	async function _run(kind, payload, opts = null) {
		if (!_enabled()) return { ok: false, disabled: true, err: "disabled" };

		const client = _getClient();
		if (!client) return { ok: false, disabled: true, err: "disabled" };
		const cfgN = (() => {
			try { return normalizeLlmConfig(_getConfig() || {}); } catch { return null; }
		})();
		try { _ensurePromptLogGlobals(); } catch {}
		const body = _redactDeep(payload);
		const options = (opts && typeof opts === "object") ? opts : {};
		const promptLogOn = _shouldLogPrompts(cfgN);

		const key = (() => {
			try {
				const mint = String(payload?.mint || payload?.targetMint || "");
				const ck = String(payload?.cacheKey || options?.cacheKey || "");
				return `${kind}:${mint || ck || "global"}`;
			} catch {
				return `${kind}:unknown`;
			}
		})();
		const prev = cache.get(key);
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
			? {}
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

		const evolveSummary = (() => {
			try {
				const s = _readLsJson("fdv_agent_evolve_summary_v1", null);
				const txt = String(s?.text || "").trim();
				return txt ? txt.slice(0, 1400) : "";
			} catch {
				return "";
			}
		})();
		const systemPrompt = getGarySystemPrompt(kind, { evolveSummary });
		const systemPromptFinal = (() => {
			try {
				if (String(cfgN?.provider || "").toLowerCase() !== "gary") return systemPrompt;
				// Keep system prompts short for tiny local models; the kind is also present in USER payload.
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
					cacheKey: String(key || ""),
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
		try {
			const req = {
				system: systemPromptFinal,
				user: JSON.stringify(userMsg),
				temperature: Number.isFinite(Number(options.temperature)) ? Number(options.temperature) : 0.15,
				maxTokens: Math.max(
					120,
					Number.isFinite(Number(options.maxTokens))
						? Number(options.maxTokens)
						: Number((_getConfig() || {}).maxTokens || 350)
				),
			};
			if (client && typeof client.chatJsonWithMeta === "function") {
				meta = await client.chatJsonWithMeta(req);
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
				text = await client.chatJson(req);
			}
		} catch (e) {
			try { _log(`request failed: ${String(e?.message || e || "")}` , "warn"); } catch {}
			const res = { ok: false, err: String(e?.message || e || "") };
			try {
				if (TRAINING_CAPTURE?.enabled) {
					let uploadToGary = null;
					try {
						const cfgN = normalizeLlmConfig(_getConfig() || {});
						if (String(cfgN.provider || "").toLowerCase() === "gary" && String(cfgN.apiKey || "").trim()) {
							uploadToGary = {
								provider: "gary",
								baseUrl: String(cfgN.baseUrl || "").trim(),
								apiKey: String(cfgN.apiKey || "").trim(),
								hmacSecret: String(cfgN.hmacSecret || "").trim(),
							};
						}
					} catch {}
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
					}, { storageKey: TRAINING_CAPTURE.storageKey, maxEntries: TRAINING_CAPTURE.maxEntries, uploadToGary }).catch(() => {});
				}
			} catch {}
			cache.set(key, { at: now(), res });
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
					? _validateConfigScanDecision(parsed)
					: null;
		const res = validated
			? { ok: true, decision: validated }
			: { ok: false, err: "invalid_json" };

		try {
			const shouldCapture = !!TRAINING_CAPTURE?.enabled && (res.ok || !!TRAINING_CAPTURE?.includeBad);
			if (shouldCapture) {
				let uploadToGary = null;
				try {
					const cfgN = normalizeLlmConfig(_getConfig() || {});
					if (String(cfgN.provider || "").toLowerCase() === "gary" && String(cfgN.apiKey || "").trim()) {
						uploadToGary = {
							provider: "gary",
							baseUrl: String(cfgN.baseUrl || "").trim(),
							apiKey: String(cfgN.apiKey || "").trim(),
							hmacSecret: String(cfgN.hmacSecret || "").trim(),
						};
					}
				} catch {}
				appendTrainingCapture({
					mode: "inference",
					source: "fdv_auto_trader",
					kind: String(kind || ""),
					ok: !!res.ok,
					err: res.ok ? "" : String(res.err || ""),
					userMsg,
					system: String(systemPromptFinal || "").slice(0, 8000),
					text: String(text || "").slice(0, 20000),
					parsed: _redactDeep(parsed),
					decision: _redactDeep(validated),
					meta: _redactDeep(meta),
				}, { storageKey: TRAINING_CAPTURE.storageKey, maxEntries: TRAINING_CAPTURE.maxEntries, uploadToGary }).catch(() => {});
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
		cache.set(key, { at: now(), res });
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
				temperature: 0.1,
				maxTokens: 260,
				stateOverride: stateSummary && typeof stateSummary === "object" ? stateSummary : {},
			});

			// Retry once if the model produced truncated/invalid JSON.
			if (first && first.ok === false && String(first.err || "") === "invalid_json") {
				const payload2 = {
					cacheKey: "startup_retry",
					market: market && typeof market === "object" ? market : {},
					allowedKeys: Array.isArray(allowedKeys) ? allowedKeys.slice(0, 80).map(String) : [],
					note: (String(note || "").slice(0, 380) + "\nRetry: return minimal JSON, only keys you would change. No prose.").slice(0, 500),
				};
				return await _run("config_scan", payload2, {
					cacheKey: "startup_retry",
					omitState: true,
					temperature: 0.05,
					maxTokens: 320,
					stateOverride: stateSummary && typeof stateSummary === "object" ? stateSummary : {},
				});
			}
			return first;
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
