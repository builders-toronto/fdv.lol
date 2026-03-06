
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

function _safeJsonParse(s, fallback = null) {
	try {
		return JSON.parse(String(s || ""));
	} catch {
		return fallback;
	}
}

function _lsGet(key, fallback = "") {
	try {
		if (typeof localStorage === "undefined") return fallback;
		return String(localStorage.getItem(String(key || "")) || fallback);
	} catch {
		return fallback;
	}
}

function _lsSet(key, val) {
	try {
		if (typeof localStorage === "undefined") return false;
		localStorage.setItem(String(key || ""), String(val ?? ""));
		return true;
	} catch {
		return false;
	}
}

function _pushRing(arr, item, maxN) {
	try {
		if (!Array.isArray(arr)) return;
		arr.unshift(item);
		if (arr.length > maxN) arr.length = maxN;
	} catch {}
}

function _jsonLen(v) {
	try {
		return JSON.stringify(v).length;
	} catch {
		return 0;
	}
}

function _shortStr(s, maxN) {
	try {
		return String(s ?? "").slice(0, Math.max(0, maxN | 0));
	} catch {
		return "";
	}
}

function _cleanTags(arr, maxN = 6) {
	try {
		if (!Array.isArray(arr)) return [];
		const out = [];
		const seen = new Set();
		for (const it of arr) {
			const tag = _shortStr(String(it || "").trim().toLowerCase(), 32);
			if (!tag || seen.has(tag)) continue;
			seen.add(tag);
			out.push(tag);
			if (out.length >= maxN) break;
		}
		return out;
	} catch {
		return [];
	}
}

function _topCounts(items, maxN = 4) {
	try {
		const counts = new Map();
		for (const raw of Array.isArray(items) ? items : []) {
			const key = _shortStr(String(raw || "").trim().toLowerCase(), 32);
			if (!key) continue;
			counts.set(key, (counts.get(key) || 0) + 1);
		}
		return Array.from(counts.entries())
			.sort((a, b) => (b[1] - a[1]) || a[0].localeCompare(b[0]))
			.slice(0, Math.max(1, maxN | 0))
			.map(([tag, count]) => ({ tag, count }));
	} catch {
		return [];
	}
}

function _deriveDecisionTags(kind, payload, decision) {
	try {
		const tags = [];
		const k = _shortStr(String(kind || "").trim().toLowerCase(), 16);
		const action = _shortStr(String(decision?.action || "").trim().toLowerCase(), 20);
		if (k) tags.push(`kind:${k}`);
		if (action) tags.push(`action:${action}`);

		const ctx = (payload?.ctx && typeof payload.ctx === "object") ? payload.ctx : null;
		const sig = (payload?.signals && typeof payload.signals === "object") ? payload.signals : null;
		const summary = (payload?.summary && typeof payload.summary === "object") ? payload.summary : null;
		const quoteTrust = Number(summary?.quoteTrust ?? ctx?.quoteTrust);
		if (Number.isFinite(quoteTrust) && quoteTrust < 0.5) tags.push("low-quote-trust");
		const quoteTrustFlags = _cleanTags(summary?.quoteTrustFlags ?? ctx?.quoteTrustFlags, 4);
		for (const f of quoteTrustFlags) tags.push(f);

		const urgent = (ctx?.urgent && typeof ctx.urgent === "object") ? ctx.urgent : (ctx?.agentSignals?.urgent && typeof ctx.agentSignals.urgent === "object") ? ctx.agentSignals.urgent : null;
		const urgentKind = _shortStr(String(summary?.urgentKind || urgent?.kind || "").trim().toLowerCase(), 24);
		if (urgentKind) tags.push(`urgent:${urgentKind}`);
		if (summary?.urgentHard === true || urgent?.hard === true) tags.push("urgent-hard");
		if (summary?.inMinHold === true || ctx?.inMinHold === true) tags.push("min-hold");
		if (summary?.inSellGuard === true || ctx?.inSellGuard === true) tags.push("sell-guard");
		if (ctx?.isFastExit === true) tags.push("fast-exit");

		const regime = _shortStr(String(summary?.regime || ctx?.regime || "").trim().toLowerCase(), 24);
		if (regime) tags.push(`regime:${regime}`);
		const badge = _shortStr(String(summary?.badge || ctx?.badge || "").trim().toLowerCase(), 24);
		if (badge) tags.push(`badge:${badge}`);

		if (sig?.gates?.cooldown?.ok === false) tags.push("cooldown");
		if (sig?.gates?.buyWarmup?.ready === false) tags.push("warmup");
		if (sig?.gates?.manualEdge?.ok === false) tags.push("manual-edge-block");
		if (sig?.gates?.entryCost?.ok === false) tags.push("entry-cost-block");
		if (sig?.gates?.sim?.ready === false) tags.push("entry-sim-block");

		return _cleanTags(tags, 8);
	} catch {
		return [];
	}
}

function _deriveSkipCodeFromPayload(p) {
	try {
		const g = p && p.signals && p.signals.gates && typeof p.signals.gates === "object" ? p.signals.gates : null;
		if (!g) return "unknown";
		if (g.cooldown && g.cooldown.ok === false) return "cooldown";
		if (g.buyWarmup && g.buyWarmup.ready === false) return "warmup";
		if (g.manualEdge && g.manualEdge.ok === false) return "manual_edge";
		if (g.entryCost && g.entryCost.ok === false) return "entry_cost";
		if (g.sim && g.sim.ready === false) return "entry_sim";
		if (g.finalGateReady === false) return "final_gate";
		if (g.onchainLabels && Array.isArray(g.onchainLabels.labels) && g.onchainLabels.labels.length) return "onchain_label_risk";
		return "unknown";
	} catch {
		return "unknown";
	}
}

function _defaultState() {
	return {
		v: 4,
		startedAt: now(),
		riskPosture: { agentRisk: "safe", fullAiControl: false, updatedAt: 0 },
		// Stored history (can be larger than what we inject into prompts)
		recentOutcomes: [],
		recentDecisions: [],
		recentBuySkips: [],
		recentSwarm: [],
		recentEpisodes: [],
	};
}

function _sanitizeLoadedState(obj) {
	try {
		const o = obj && typeof obj === "object" ? obj : null;
		if (!o) return _defaultState();
		const st = _defaultState();
		st.startedAt = _safeNum(o.startedAt, st.startedAt) || st.startedAt;
		const rp = (o.riskPosture && typeof o.riskPosture === "object") ? o.riskPosture : {};
		st.riskPosture = {
			agentRisk: String(rp.agentRisk || st.riskPosture.agentRisk).slice(0, 16) || "safe",
			fullAiControl: !!rp.fullAiControl,
			updatedAt: _safeNum(rp.updatedAt, 0) || 0,
		};
		st.recentOutcomes = Array.isArray(o.recentOutcomes) ? o.recentOutcomes.slice(0, 50) : [];
		st.recentDecisions = Array.isArray(o.recentDecisions) ? o.recentDecisions.slice(0, 200) : [];
		st.recentBuySkips = Array.isArray(o.recentBuySkips) ? o.recentBuySkips.slice(0, 200) : [];
		st.recentSwarm = Array.isArray(o.recentSwarm) ? o.recentSwarm.slice(0, 80) : [];
		st.recentEpisodes = Array.isArray(o.recentEpisodes) ? o.recentEpisodes.slice(0, 200) : [];
		return st;
	} catch {
		return _defaultState();
	}
}

export function createDecisionMemory({
	storageKey = "fdv_agent_decision_memory_v1",
	persist = true,
	maxOutcomes = 18,
	maxDecisions = 60,
	maxBuySkips = 60,
	maxSwarm = 24,
	maxEpisodes = 48,
	maxPersistChars = 40_000,
} = {}) {
	let state = _defaultState();
	let lastPersistAt = 0;
	let persistTimer = null;

	try {
		const raw = _lsGet(storageKey, "");
		if (raw) state = _sanitizeLoadedState(_safeJsonParse(raw, null));
	} catch {}

	function _trimForStorage() {
		try {
			state.recentOutcomes = Array.isArray(state.recentOutcomes) ? state.recentOutcomes.slice(0, maxOutcomes) : [];
			state.recentDecisions = Array.isArray(state.recentDecisions) ? state.recentDecisions.slice(0, maxDecisions) : [];
			state.recentBuySkips = Array.isArray(state.recentBuySkips) ? state.recentBuySkips.slice(0, maxBuySkips) : [];
			state.recentSwarm = Array.isArray(state.recentSwarm) ? state.recentSwarm.slice(0, maxSwarm) : [];
			state.recentEpisodes = Array.isArray(state.recentEpisodes) ? state.recentEpisodes.slice(0, maxEpisodes) : [];
		} catch {}
	}

	function _persistSoon() {
		try {
			if (!persist) return;
			const n = now();
			// Throttle and coalesce.
			if (n - lastPersistAt < 1500) {
				if (persistTimer) return;
				if (typeof setTimeout !== "function") return;
				persistTimer = setTimeout(() => {
					persistTimer = null;
					try { _persistNow(); } catch {}
				}, 1200);
				return;
			}
			_persistNow();
		} catch {}
	}

	function _persistNow() {
		try {
			if (!persist) return;
			_trimForStorage();
			const txt = JSON.stringify(state);
			if (txt && txt.length <= maxPersistChars) {
				if (_lsSet(storageKey, txt)) lastPersistAt = now();
			}
		} catch {}
	}

	function updateFromPayload(payload) {
		try {
			const p = payload && typeof payload === "object" ? payload : null;
			if (!p) return;
			const s = (p.signals && typeof p.signals === "object") ? p.signals : null;
			if (!s) return;

			if (s.agentRisk) state.riskPosture.agentRisk = String(s.agentRisk || "").slice(0, 16) || state.riskPosture.agentRisk;
			if (typeof s.fullAiControl === "boolean") state.riskPosture.fullAiControl = s.fullAiControl;
			state.riskPosture.updatedAt = now();

			const lt = (s.outcomes && typeof s.outcomes === "object" && s.outcomes.lastTrade && typeof s.outcomes.lastTrade === "object")
				? s.outcomes.lastTrade
				: null;
			if (lt) {
				const ts = _safeNum(lt.ts, 0);
				if (ts > 0) {
					_pushRing(state.recentOutcomes, {
						ts,
						kind: lt.kind ? String(lt.kind).slice(0, 24) : null,
						decisionAction: lt.decisionAction ? String(lt.decisionAction).slice(0, 20) : null,
						pnlSol: (typeof lt.pnlSol === "number") ? lt.pnlSol : null,
						upDown: lt.upDown ? String(lt.upDown).slice(0, 8) : null,
						regime: lt.regime ? String(lt.regime).slice(0, 24) : null,
						quoteTrust: (typeof lt.quoteTrust === "number") ? _clampNum(lt.quoteTrust, 0, 1) : null,
						urgentKind: lt.urgentKind ? String(lt.urgentKind).slice(0, 24) : null,
						tags: _cleanTags(lt.tags, 6),
					}, Math.max(3, maxOutcomes));
				}
			}
			_persistSoon();
		} catch {}
	}

	function updateAfterDecision({ kind, payload, decision, ok } = {}) {
		try {
			const k = String(kind || "").trim().toLowerCase();
			const d = (decision && typeof decision === "object") ? decision : null;
			const p = (payload && typeof payload === "object") ? payload : null;
			const mint = (() => {
				try {
					const m = String(p?.mint || p?.targetMint || p?.proposed?.mint || "").trim();
					return m ? m.slice(0, 44) : "";
				} catch {
					return "";
				}
			})();

			updateFromPayload(p);
			const tags = _deriveDecisionTags(k, p, d);
			const regime = (() => {
				try {
					return _shortStr(String(p?.summary?.regime || p?.ctx?.regime || "").trim().toLowerCase(), 24) || null;
				} catch {
					return null;
				}
			})();
			_pushRing(state.recentDecisions, {
				at: now(),
				ok: !!ok,
				kind: k,
				mint: mint || null,
				action: d?.action ? String(d.action).slice(0, 20) : null,
				confidence: (typeof d?.confidence === "number") ? _clampNum(d.confidence, 0, 1) : null,
				reason: d?.reason ? String(d.reason).slice(0, 160) : null,
				regime,
				tags,
			}, Math.max(10, maxDecisions));

			try {
				const action = d?.action ? String(d.action).slice(0, 20) : "";
				const conf = (typeof d?.confidence === "number") ? _clampNum(d.confidence, 0, 1) : null;
				const base = `${k || "event"}${action ? ":" + action : ""}${mint ? " " + String(mint).slice(0, 10) : ""}`.trim();
				const note = (() => {
					try {
						if (k === "buy" && String(action || "").toLowerCase() === "skip") {
							return `skip:${_deriveSkipCodeFromPayload(p)}`;
						}
						if (d?.reason) return _shortStr(d.reason, 96);
						return "";
					} catch {
						return "";
					}
				})();
				_pushRing(state.recentEpisodes, {
					at: now(),
					ok: !!ok,
					kind: k || null,
					mint: mint || null,
					title: _shortStr(base, 72) || null,
					confidence: (conf === null) ? null : conf,
					note: note || null,
					tags,
				}, Math.max(12, maxEpisodes));
			} catch {}

			if (k === "buy" && d && String(d.action || "").toLowerCase() === "skip") {
				const code = _deriveSkipCodeFromPayload(p);
				_pushRing(state.recentBuySkips, { at: now(), mint: mint || null, code }, Math.max(12, maxBuySkips));
			}
			_persistSoon();
		} catch {}
	}

	function recordEpisode(ep = {}) {
		try {
			const e = (ep && typeof ep === "object") ? ep : null;
			if (!e) return;
			_pushRing(state.recentEpisodes, {
				at: _safeNum(e.at, 0) || now(),
				ok: (typeof e.ok === "boolean") ? e.ok : null,
				kind: e.kind ? _shortStr(e.kind, 24) : null,
				mint: e.mint ? _shortStr(e.mint, 44) : null,
				title: e.title ? _shortStr(e.title, 72) : null,
				confidence: (typeof e.confidence === "number") ? _clampNum(e.confidence, 0, 1) : null,
				note: e.note ? _shortStr(e.note, 120) : null,
			}, Math.max(12, maxEpisodes));
			_persistSoon();
		} catch {}
	}

	function recordSwarm({ kind, mint, members } = {}) {
		try {
			_pushRing(state.recentSwarm, {
				at: now(),
				kind: String(kind || ""),
				mint: (mint ? String(mint).slice(0, 44) : null) || null,
				members: Array.isArray(members) ? members.slice(0, 5) : [],
			}, Math.max(6, maxSwarm));
			_persistSoon();
		} catch {}
	}

	function snapshotForPrompt(opts = {}) {
		try {
			const o = (opts && typeof opts === "object") ? opts : {};
			// Character budget (not tokens) to keep prompt context under control.
			// Default is conservative since this snapshot is often injected into prompts.
			const budgetChars = _clampNum(o.budgetChars ?? 3200, 600, 20_000);
			const includeEpisodes = (typeof o.includeEpisodes === "boolean") ? o.includeEpisodes : true;

			const recent = Array.isArray(state.recentBuySkips) ? state.recentBuySkips.slice(0, 10) : [];
			const counts = new Map();
			for (const r of recent) {
				const c = String(r?.code || "unknown");
				counts.set(c, (counts.get(c) || 0) + 1);
			}
			const skipReasons = Array.from(counts.entries())
				.sort((a, b) => (b[1] - a[1]))
				.slice(0, 4)
				.map(([code, count]) => ({ code, count }));

			const snap = {
				v: state.v,
				startedAt: state.startedAt,
				riskPosture: {
					agentRisk: String(state.riskPosture.agentRisk || "safe"),
					fullAiControl: !!state.riskPosture.fullAiControl,
					updatedAt: state.riskPosture.updatedAt || 0,
				},
				outcomes: (Array.isArray(state.recentOutcomes) ? state.recentOutcomes.slice(0, 3) : []),
				swarm: (Array.isArray(state.recentSwarm) ? state.recentSwarm.slice(0, 2) : []),
				skipBuysLately: {
					window: recent.length,
					reasons: skipReasons,
				},
				patterns: {
					outcomeTags: _topCounts((Array.isArray(state.recentOutcomes) ? state.recentOutcomes : []).flatMap((it) => Array.isArray(it?.tags) ? it.tags : []), 4),
					decisionTags: _topCounts((Array.isArray(state.recentDecisions) ? state.recentDecisions : []).flatMap((it) => Array.isArray(it?.tags) ? it.tags : []), 4),
					regimes: _topCounts([
						...(Array.isArray(state.recentOutcomes) ? state.recentOutcomes.map((it) => it?.regime) : []),
						...(Array.isArray(state.recentDecisions) ? state.recentDecisions.map((it) => it?.regime) : []),
					], 3),
				},
				recentDecisions: (Array.isArray(state.recentDecisions) ? state.recentDecisions.slice(0, 6) : []),
				episodes: includeEpisodes
					? (Array.isArray(state.recentEpisodes) ? state.recentEpisodes.slice(0, 3) : [])
					: [],
			};

			// Fit-to-context: progressively shrink until within budget.
			let level = 0;
			while (_jsonLen(snap) > budgetChars && level < 8) {
				level += 1;
				try {
					if (level === 1) {
						snap.recentDecisions = Array.isArray(snap.recentDecisions) ? snap.recentDecisions.slice(0, 4) : [];
						snap.episodes = Array.isArray(snap.episodes) ? snap.episodes.slice(0, 2) : [];
					} else if (level === 2) {
						snap.recentDecisions = Array.isArray(snap.recentDecisions) ? snap.recentDecisions.slice(0, 2) : [];
						snap.outcomes = Array.isArray(snap.outcomes) ? snap.outcomes.slice(0, 2) : [];
						snap.swarm = Array.isArray(snap.swarm) ? snap.swarm.slice(0, 1) : [];
					} else if (level === 3) {
						// Shorten decision reasons.
						if (Array.isArray(snap.recentDecisions)) {
							snap.recentDecisions = snap.recentDecisions.map((d) => {
								try {
									const dd = (d && typeof d === "object") ? d : {};
									return {
										at: dd.at || 0,
										ok: (typeof dd.ok === "boolean") ? dd.ok : null,
										kind: dd.kind || null,
										mint: dd.mint || null,
										action: dd.action || null,
										confidence: (typeof dd.confidence === "number") ? dd.confidence : null,
										reason: dd.reason ? _shortStr(dd.reason, 72) : null,
									};
								} catch {
									return d;
								}
							});
						}
					} else if (level === 4) {
						snap.skipBuysLately = {
							window: snap.skipBuysLately?.window || 0,
							reasons: Array.isArray(snap.skipBuysLately?.reasons) ? snap.skipBuysLately.reasons.slice(0, 2) : [],
						};
						snap.patterns = {
							outcomeTags: Array.isArray(snap.patterns?.outcomeTags) ? snap.patterns.outcomeTags.slice(0, 3) : [],
							decisionTags: Array.isArray(snap.patterns?.decisionTags) ? snap.patterns.decisionTags.slice(0, 3) : [],
							regimes: Array.isArray(snap.patterns?.regimes) ? snap.patterns.regimes.slice(0, 2) : [],
						};
					} else if (level === 5) {
						snap.episodes = Array.isArray(snap.episodes) ? snap.episodes.slice(0, 1) : [];
						snap.outcomes = Array.isArray(snap.outcomes) ? snap.outcomes.slice(0, 1) : [];
					} else if (level === 6) {
						snap.recentDecisions = Array.isArray(snap.recentDecisions) ? snap.recentDecisions.slice(0, 1) : [];
						snap.swarm = [];
					} else {
						snap.episodes = [];
						snap.recentDecisions = [];
						snap.outcomes = [];
						snap.patterns = { outcomeTags: [], decisionTags: [], regimes: [] };
					}
				} catch {}
			}

			return snap;
		} catch {
			return { v: 4, startedAt: now() };
		}
	}

	function clear() {
		try {
			state = _defaultState();
			try { if (persistTimer) clearTimeout(persistTimer); } catch {}
			persistTimer = null;
			lastPersistAt = 0;
			if (persist) _lsSet(storageKey, JSON.stringify(state));
		} catch {}
	}

	return {
		updateFromPayload,
		updateAfterDecision,
		recordSwarm,
		recordEpisode,
		snapshotForPrompt,
		clear,
		// For debugging only
		_getState: () => state,
	};
}

