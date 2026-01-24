import { isNodeLike as _isNodeLike } from "../lib/runtime.js";
import { createSolanaDepsLoader } from "../lib/solana/deps.js";
import { createConnectionGetter } from "../lib/solana/connection.js";
import { createConfirmSig } from "../lib/solana/confirm.js";
import { FDV_PLATFORM_FEE_BPS, FDV_LEDGER_URL } from "../../../../config/env.js";
import { registerFdvWallet, reportFdvStats } from "../lib/telemetry/ledger.js";

import { computePumpingLeaders, getRugSignalForMint, getPumpHistoryForMint, focusMint } from "../../../meme/metrics/kpi/pumping.js";
import { getLatestSnapshot } from "../../../meme/metrics/ingest.js";
import { buildKpiScoreContext, scoreKpiItem, selectTradeCandidatesFromKpis } from "../lib/kpi/kpiSelection.js";
import { getMint as kpiGetMint, getLiqUsd as kpiGetLiqUsd, getVol24 as kpiGetVol24 } from "../lib/kpi/kpiExtract.js";

import {
  SOL_MINT,
  MIN_JUP_SOL_IN,
  MIN_SELL_SOL_OUT,
  FEE_RESERVE_MIN,
  FEE_RESERVE_PCT,
  MIN_SELL_CHUNK_SOL,
  SMALL_SELL_FEE_FLOOR,
  AVOID_NEW_ATA_SOL_FLOOR,
  TX_FEE_BUFFER_LAMPORTS,
  SELL_TX_FEE_BUFFER_LAMPORTS,
  EXTRA_TX_BUFFER_LAMPORTS,
  EDGE_TX_FEE_ESTIMATE_LAMPORTS,
  MIN_QUOTE_RAW_AMOUNT,
  ELEVATED_MIN_BUY_SOL,
  MAX_CONSEC_SWAP_400,
  MIN_OPERATING_SOL,
  ROUTER_COOLDOWN_MS,
  MINT_RUG_BLACKLIST_MS,
  MINT_BLACKLIST_STAGES_MS,
  URGENT_SELL_COOLDOWN_MS,
  URGENT_SELL_MIN_AGE_MS,
  MAX_RECURRING_COST_FRAC,
  MAX_ONETIME_COST_FRAC,
  ONE_TIME_COST_AMORTIZE,
  FAST_OBS_INTERVAL_MS,
  SPLIT_FRACTIONS,
  MINT_OP_LOCK_MS,
  BUY_SEED_TTL_MS,
  BUY_LOCK_MS,
  FAST_OBS_LOG_INTERVAL_MS,
  LEADER_SAMPLE_MIN_MS,
  RUG_FORCE_SELL_SEVERITY,
  RUG_QUOTE_SHOCK_FRAC,
  RUG_QUOTE_SHOCK_WINDOW_MS,
  EARLY_URGENT_WINDOW_MS,
  MAX_DOM_LOG_LINES,
  MAX_LOG_MEM_LINES,
  MOMENTUM_FORCED_EXIT_CONSEC,
  POSCACHE_KEY_PREFIX,
  DUSTCACHE_KEY_PREFIX,
  FEE_ATAS,
  AUTO_CFG,
  UI_LIMITS,
  DYN_HS,
} from "../lib/constants.js";
import { createDex } from "../lib/dex.js";
import { getAutoHelpModalHtml, wireAutoHelpModal } from "../docs/helpModal.js";

import { createPreflightSellPolicy } from "../lib/sell/policies/preflight.js";
import { createLeaderModePolicy } from "../lib/sell/policies/leaderMode.js";
import { createUrgentSellPolicy } from "../lib/sell/policies/urgent.js";
import { createRugPumpDropPolicy } from "../lib/sell/policies/rugPumpDrop.js";
import { createEarlyFadePolicy } from "../lib/sell/policies/earlyFade.js";
import { createObserverPolicy } from "../lib/sell/policies/observer.js";
import { createObserverThreePolicy } from "../lib/sell/policies/observerThree.js";
import { createWarmingPolicyHook } from "../lib/sell/policies/warmingHook.js";
import { createUrgentSellStore } from "../lib/stores/urgentSellStore.js";
import { clamp as _clamp, fmtUsd, safeNum, normalizePercent } from "../lib/util.js";
import { createMintLockStore } from "../lib/stores/mintLockStore.js";

import { createVolatilityGuardPolicy } from "../lib/sell/policies/volatilityGuard.js";
import { createQuoteAndEdgePolicy } from "../lib/sell/policies/quoteAndEdge.js";
import { createFastExitPolicy } from "../lib/sell/policies/fastExit.js";
import { createProfitLockPolicy } from "../lib/sell/policies/profitLock.js";
import { createFallbackSellPolicy } from "../lib/sell/policies/fallbackSell.js";
import { createForceFlagDecisionPolicy } from "../lib/sell/policies/forceFlagDecision.js";
import { createReboundGatePolicy } from "../lib/sell/policies/reboundGate.js";
import { createExecuteSellDecisionPolicy } from "../lib/sell/policies/executeSellDecision.js";
import { createStealthTools } from "../lib/stealth.js";
import { loadSplToken } from "../../../../core/solana/splToken.js";

import { createAgentDecisionPolicy } from "../lib/sell/policies/agentDecision.js";
import { createAutoTraderAgentDriver } from "../../../../agents/driver.js";

import { createRoundtripEdgeEstimator } from "../lib/honeypot.js";

import { createDustCacheStore } from "../lib/stores/dustCacheStore.js";
import { createPosCacheStore } from "../lib/stores/posCacheStore.js";
import { createBuySeedStore } from "../lib/stores/buySeedStore.js";
import { createAgentOutcomesStore } from "../lib/evolve/agentOutcomes.js";

function now() {
  try {
    const o = globalThis && globalThis.__fdvAutoBotOverrides;
    const fn = o && typeof o === "object" ? o.now : null;
    if (typeof fn === "function") return fn();
  } catch {}
  try {
    if (performance && performance.now) return performance.now();
  } catch {}
  return Date.now();
}

let log = (msg, type) => {
  try {
    const g = (typeof window !== "undefined") ? window : globalThis;
    if (!g._fdvLogBuffer) g._fdvLogBuffer = [];
    const line = `[${new Date().toLocaleTimeString()}] ${String(msg ?? "")}`;
    const buf = g._fdvLogBuffer;
    buf.push(line);
    if (Number.isFinite(MAX_LOG_MEM_LINES) && buf.length > MAX_LOG_MEM_LINES) {
      buf.splice(0, buf.length - Math.floor(MAX_LOG_MEM_LINES * 0.9));
    }
    
    try {
      const mirror = !!g._fdvLogToConsole || !!g._fdvDebugSellEval;
      if (mirror && typeof console !== "undefined") {
        if (type === "err" && console.error) console.error(line);
        else if ((type === "warn" || type === "warning") && console.warn) console.warn(line);
        else if (console.log) console.log(line);
      }
    } catch {}
  } catch {}
};

let logObj = (label, obj) => {
  try { log(`${label}: ${JSON.stringify(obj)}`); } catch {}
};

const agentOutcomes = createAgentOutcomesStore({
  storageKey: "fdv_agent_outcomes_v1",
  maxEntries: 120,
  cacheMs: 5000,
  nowFn: () => Date.now(),
  getSessionPnlSol: () => {
    try { return getSessionPnlSol(); } catch { return null; }
  },
  getAgentRisk: () => {
    try {
      const agent = getAutoTraderAgent();
      const cfg = agent?.getConfigFromRuntime ? agent.getConfigFromRuntime() : null;
      return String(cfg?.riskLevel || "safe");
    } catch { return "safe"; }
  },
});

let _autoTraderAgent;
function getAutoTraderAgent() {
	if (_autoTraderAgent) return _autoTraderAgent;
	_autoTraderAgent = createAutoTraderAgentDriver({
		log,
		getState: () => state,
		getConfig: () => {
			try {
				// Let the driver read runtime config from overrides/localStorage.
				if (_autoTraderAgent && typeof _autoTraderAgent.getConfigFromRuntime === "function") {
					return _autoTraderAgent.getConfigFromRuntime();
				}
			} catch {}
			return { enabled: false, openaiApiKey: "" };
		},
	});
	return _autoTraderAgent;
}

function _getAgentRuntimeCfgSafe() {
	try {
		const agent = getAutoTraderAgent();
		const cfg = agent && typeof agent.getConfigFromRuntime === "function" ? agent.getConfigFromRuntime() : null;
		return (cfg && typeof cfg === "object") ? cfg : {};
	} catch {
		return {};
	}
}

function _isAgentGaryEffective() {
	try {
		const cfg = _getAgentRuntimeCfgSafe();
		const enabledFlag = cfg && (cfg.enabled !== false);
		const keyPresent = !!String(cfg?.openaiApiKey || "").trim();
		return !!(enabledFlag && keyPresent);
	} catch {
		return false;
	}
}

let _flamebarMissLastMint = "";
let _flamebarMissLastAt = 0;
function _isProbablySolanaMintStr(m) {
  try {
    const s = String(m || "").trim();
    if (!s) return false;
    if (s.length < 28 || s.length > 60) return false;
    if (/\s/.test(s)) return false;
    return true;
  } catch {
    return false;
  }
}

function _getFlamebarLeaderPick() {
  try {
    const g = (typeof window !== "undefined") ? window : globalThis;
    const fb = g?.__fdvFlamebar;
    const mint = String(fb?.getLeaderMint?.() || "").trim();
    const mode = String(fb?.getLeaderMode?.() || "").trim();
    const pumping = (() => {
      try {
        if (typeof fb?.isPumping === "function") return !!fb.isPumping();
      } catch {}
      return mode === "pump";
    })();
    if (!_isProbablySolanaMintStr(mint)) return null;
    return { mint, mode, pumping };
  } catch {
    return null;
  }
}

function _getBuyAnalysisStore() {
  try {
    const g = (typeof window !== "undefined") ? window : globalThis;
    if (!g._fdvBuyAnalysis) g._fdvBuyAnalysis = new Map(); // mint -> { firstAt, seen, lastAt, lastLogAt }
    return g._fdvBuyAnalysis;
  } catch {
    return new Map();
  }
}

function _noteBuyCandidateAndCheckReady(mint, opts = {}) {
  try {
    const m = String(mint || "").trim();
    if (!m) return { ready: false, reason: "missing" };
    const store = _getBuyAnalysisStore();
    const t = now();
    const rec = store.get(m) || { firstAt: t, seen: 0, lastAt: 0, lastLogAt: 0 };
    rec.seen = Number(rec.seen || 0) + 1;
    rec.lastAt = t;
    store.set(m, rec);

    // Defaults: require a little time + multiple observations + a few leader-series points.
    const minMs = Math.max(0, Number(opts.minMs ?? state.buyAnalysisMinMs ?? 8000));
    const minSeen = Math.max(1, Number(opts.minSeen ?? state.buyAnalysisMinTicks ?? 3));
    const minSeries = Math.max(1, Number(opts.minSeries ?? state.buyAnalysisMinLeaderSeries ?? 5));

    let seriesN = 0;
    try { seriesN = (getLeaderSeries(m, Math.max(3, minSeries)) || []).length; } catch { seriesN = 0; }

    const ageMs = t - Number(rec.firstAt || t);
    const ready = (ageMs >= minMs) && (rec.seen >= minSeen) && (seriesN >= minSeries);
    return { ready, ageMs, seen: rec.seen, seriesN, minMs, minSeen, minSeries, rec };
  } catch {
    return { ready: false, reason: "err" };
  }
}

function _dbgSellEnabled() {
  try {
    const g = (typeof window !== "undefined") ? window : globalThis;
    if (!!g._fdvDebugSellEval) return true;
    // If the widget runs inside an iframe, the toggle may be set on parent/top.
    try { if (g.parent && g.parent !== g && !!g.parent._fdvDebugSellEval) return true; } catch {}
    try { if (g.top && g.top !== g && !!g.top._fdvDebugSellEval) return true; } catch {}
    return false;
  } catch { return false; }
}

function _safeDbgJson(v, maxLen = 2000) {
  try {
    const s = JSON.stringify(v, (k, val) => {
      const key = String(k || "");
      if (/secret|private|seed|keypair|secretKey|autoWalletSecret|rpcHeaders/i.test(key)) return "[redacted]";
      if (key === "kp") return "[redacted:kp]";
      if (typeof val === "bigint") return String(val);
      if (typeof val === "function") return `[fn ${val.name || "anonymous"}]`;
      return val;
    });
    if (typeof s === "string" && s.length > maxLen) return s.slice(0, maxLen) + "…";
    return s;
  } catch {
    try { return String(v); } catch { return "<unprintable>"; }
  }
}

function _dbgSell(msg, data) {
  if (!_dbgSellEnabled()) return;
  try {
    const suffix = (typeof data === "undefined") ? "" : ` :: ${_safeDbgJson(data)}`;
    log(`SELLDBG ${String(msg || "")} ${suffix}`.trim(), "info");
  } catch {}
}

function _dbgSellNextId() {
  try {
    const g = (typeof window !== "undefined") ? window : globalThis;
    if (!Number.isFinite(g._fdvSellEvalSeq)) g._fdvSellEvalSeq = 0;
    g._fdvSellEvalSeq++;
    return g._fdvSellEvalSeq;
  } catch { return 0; }
}

function _getAutoBotOverride(name) {
  try {
    const o = globalThis && globalThis.__fdvAutoBotOverrides;
    if (!o || typeof o !== "object") return null;
    const v = o[name];
    return v ?? null;
  } catch {
    return null;
  }
}

function _summarizeLeaderSeries(mint, n = 6) {
  try {
    const s = getLeaderSeries(mint, 3) || [];
    const tail = s.slice(Math.max(0, s.length - Math.max(1, Math.min(12, n | 0))));
    return tail.map((x) => ({
      pumpScore: Number(x?.pumpScore ?? x?.score ?? 0),
      liqUsd: Number(x?.liqUsd ?? 0),
      v1h: Number(x?.v1h ?? x?.v1hTotal ?? 0),
      chg5m: Number(x?.chg5m ?? x?.change5m ?? 0),
      chg1h: Number(x?.chg1h ?? x?.change1h ?? 0),
    }));
  } catch {
    return null;
  }
}

function _summarizeKpiPickRow(row) {
  try {
    if (!row || typeof row !== "object") return null;
    const kp = row.kp && typeof row.kp === "object" ? row.kp : {};
    return {
      score01: Number(row.score01 ?? 0),
      quality01: Number(row.quality01 ?? 0),
      alpha01: Number(row.alpha01 ?? 0),
      risk01: Number(row.risk01 ?? 0),
      kp: {
        symbol: String(kp.symbol || ""),
        name: String(kp.name || ""),
        pairUrl: String(kp.pairUrl || ""),
        priceUsd: Number(kp.priceUsd ?? 0),
        chg24: Number(kp.chg24 ?? 0),
        liqUsd: Number(kp.liqUsd ?? 0),
        vol24: Number(kp.vol24 ?? 0),
        tx24: Number(kp.tx24 ?? 0),
        imbalance01: Number(kp.imbalance01 ?? 0),
        mcap: Number(kp.mcap ?? 0),
      },
    };
  } catch {
    return null;
  }
}

function _summarizePumpTickNowForMint(mint) {
  try {
    const ticks = getPumpHistoryForMint(mint, { limit: 1 }) || [];
    const t = ticks[ticks.length - 1] || null;
    if (!t) return null;
    return {
      ts: Number(t.ts || 0),
      priceUsd: Number(t.priceUsd ?? 0),
      liqUsd: Number(t.liqUsd ?? 0),
      change5m: Number(t.change5m ?? 0),
      change1h: Number(t.change1h ?? 0),
      change24h: Number(t.change24h ?? 0),
      v5mUsd: Number(t.v5mUsd ?? 0),
      v1hUsd: Number(t.v1hUsd ?? 0),
      v24hUsd: Number(t.v24hUsd ?? 0),
    };
  } catch {
    return null;
  }
}

// function _shouldRunGaryBuyProspect({ mint, kpiPick, entrySim, finalGate, minWinProb = 0.55, riskLevel = "safe" }) {
//   try {
//     const score01 = Number(kpiPick?.score01 ?? NaN);
//     const alpha01 = Number(kpiPick?.alpha01 ?? NaN);
//     const quality01 = Number(kpiPick?.quality01 ?? NaN);
//     const pHit = Number(entrySim?.pHit ?? NaN);
//     const intensity = Number(finalGate?.intensity ?? NaN);

//     const riskRaw = String(riskLevel || "safe").trim().toLowerCase();
//     const risk = (riskRaw === "safe" || riskRaw === "medium" || riskRaw === "degen") ? riskRaw : "safe";

//     const kpiStrongThr = risk === "degen" ? 0.52 : (risk === "medium" ? 0.58 : 0.62);
//     const alphaThr = risk === "degen" ? 0.58 : (risk === "medium" ? 0.60 : 0.62);
//     const qualityThr = risk === "degen" ? 0.35 : (risk === "medium" ? 0.40 : 0.45);
//     const gateThr = risk === "degen" ? 0.85 : (risk === "medium" ? 0.95 : 1.00);

//     // Cheap “prospect” heuristics (math gates):
//     // - strong KPI pick (pipeline snapshot)
//     // - strong final-pump-gate momentum
//     // - strong sim probability
//     const strongKpi = (Number.isFinite(score01) && score01 >= kpiStrongThr) ||
//       ((Number.isFinite(alpha01) && alpha01 >= alphaThr) && (Number.isFinite(quality01) && quality01 >= qualityThr));
//     const strongGate = Number.isFinite(intensity) && intensity >= gateThr;
//     const minP = Math.max(0, Math.min(1, Number(minWinProb || 0.55)));
//     const bump = risk === "degen" ? 0.00 : (risk === "medium" ? 0.02 : 0.03);
//     const strongSim = Number.isFinite(pHit) && pHit >= Math.min(0.95, minP + bump);

//     if (strongKpi) return { ok: true, why: "kpi" };
//     if (strongGate) return { ok: true, why: "finalGate" };
//     if (strongSim) return { ok: true, why: "sim" };
//     return { ok: false, why: "no-prospect" };
//   } catch {
//     return { ok: true, why: "fallback" };
//   }
// }

function _summarizeEdge(edge) {
  try {
    if (!edge || typeof edge !== "object") return null;
    const fwd = edge.forward || null;
    const back = edge.backward || null;
    const fwdLen = Number(fwd?.routePlan?.length || fwd?.routePlanLen || 0);
    const backLen = Number(back?.routePlan?.length || back?.routePlanLen || 0);
    return {
      pctInclOnetime: Number.isFinite(Number(edge.pct)) ? Number(edge.pct) : null,
      pctNoOnetime: Number.isFinite(Number(edge.pctNoOnetime)) ? Number(edge.pctNoOnetime) : null,
      ataRentLamports: Number(edge.ataRentLamports || 0),
      recurringLamports: Number(edge.recurringLamports || 0),
      feesLamports: Number(edge.feesLamports || 0),
      platformBpsApplied: Number(edge.platformBpsApplied || 0),
      forward: {
        inAmount: Number(fwd?.inAmount || 0),
        outAmount: Number(fwd?.outAmount || 0),
        routePlanLen: fwdLen,
      },
      backward: {
        inAmount: Number(back?.inAmount || 0),
        outAmount: Number(back?.outAmount || 0),
        routePlanLen: backLen,
      },
    };
  } catch {
    return null;
  }
}

function _summarizeRugSignal(rs) {
  try {
    if (!rs || typeof rs !== "object") return null;
    return {
      badge: rs.badge ?? null,
      sev: Number(rs.sev ?? rs.severity ?? rs.score ?? 0),
      reason: rs.reason ?? rs.why ?? rs.label ?? null,
      at: Number(rs.at ?? rs.ts ?? rs.updatedAt ?? 0) || null,
    };
  } catch {
    return null;
  }
}

function _applyAgentTune(tune, { source = "", mint = "", confidence = 0, reason = "" } = {}) {
  try {
    if (!tune || typeof tune !== "object") return false;
    const conf = Number(confidence || 0);
    if (!(conf >= 0.6)) return false;

    const g = (typeof window !== "undefined") ? window : globalThis;
    const nowTs = now();
    const cooldownMs = 25_000;
    const lastAt = Number(g._fdvAgentTuneLastAt || 0);
    if (nowTs - lastAt < cooldownMs) return false;

    let changed = false;
    const changedKeys = [];
    const setNum = (k, v, min, max, roundStep = null) => {
      if (!Number.isFinite(Number(v))) return;
      let next = Number(v);
      next = Math.max(min, Math.min(max, next));
      if (roundStep === "int") next = Math.floor(next);
      else if (Number.isFinite(Number(roundStep)) && Number(roundStep) > 0) next = Math.round(next / roundStep) * roundStep;
      const prev = Number(state?.[k]);
      if (!Number.isFinite(prev) || Math.abs(prev - next) > 1e-9) {
        state[k] = next;
        changed = true;
        changedKeys.push(k);
      }
    };

    // Risk / exit
    setNum("takeProfitPct", tune.takeProfitPct, 0, 250, 0.25);
    setNum("stopLossPct", tune.stopLossPct, 0, 99, 0.25);
    setNum("trailPct", tune.trailPct, 0, 99, 0.25);
    setNum("minProfitToTrailPct", tune.minProfitToTrailPct, 0, 200, 0.25);

    // Holds
    setNum("minHoldSecs", tune.minHoldSecs, 0, 20_000, "int");
    if (Number.isFinite(Number(tune.maxHoldSecs))) {
      const _clamped = clampHoldSecs(Number(tune.maxHoldSecs));
      if (Number(state.maxHoldSecs) !== _clamped) {
        state.maxHoldSecs = _clamped;
        changed = true;
        changedKeys.push("maxHoldSecs");
      }
    }

    // Buy sizing / gating
    setNum("buyPct", tune.buyPct, 0.01, 0.5, 0.005);
    // Entry simulation
    setNum("entrySimMinWinProb", tune.entrySimMinWinProb, 0, 1, 0.01);
    setNum("entrySimHorizonSecs", tune.entrySimHorizonSecs, 30, 600, "int");

    if (changed) {
      g._fdvAgentTuneLastAt = nowTs;
      try { save(); } catch {}
      try {
        const mintShort = String(mint || "").slice(0, 4);
        log(`[AGENT GARY] tune(${source}) keys=[${changedKeys.join(", ")}] mint=${mintShort}… conf=${conf.toFixed(2)} ${String(reason || "").slice(0, 120)}`);
      } catch {}
    }
    return changed;
  } catch {
    return false;
  }
}

// Lightweight RPC pacing and backoff helpers used across the widget and passed to dex
const _rpcKindLast = new Map();
function rpcBackoffLeft() {
  try { return Math.max(0, Number(window._fdvRpcBackoffUntil || 0) - now()); } catch { return 0; }
}
function _markRpcStress(err, backoffMs = 1500) {
  try {
    const msg = String(err?.message || err || "");
    const code = String(err?.code || "");
    const isRate = /429|rate|Too\s*Many/i.test(msg);
    const is403  = /403/.test(msg);
    const isPlan = /-32602|plan|upgrade|limit/i.test(msg);
    if (isRate || is403 || isPlan) {
      const until = now() + Math.max(300, backoffMs | 0);
      const prev = Number(window._fdvRpcBackoffUntil || 0);
      window._fdvRpcBackoffUntil = Math.max(prev, until);
      try { log(`RPC backoff armed ~${Math.ceil((window._fdvRpcBackoffUntil - now())/1000)}s (${msg.slice(0,80)})`, 'warn'); } catch {}
    }
  } catch {}
}
async function rpcWait(kind = "any", gapMs = 300) {
  const left = rpcBackoffLeft();
  if (left > 0) await new Promise(r => setTimeout(r, left));
  const k = String(kind || "any");
  const last = Number(_rpcKindLast.get(k) || 0);
  const nowTs = now();
  const need = Math.max(0, Number(gapMs || 0));
  const delta = nowTs - last;
  if (need > 0 && delta < need) await new Promise(r => setTimeout(r, need - delta));
  _rpcKindLast.set(k, now());
}

let _dex;
function _getDex() {
  if (_dex) return _dex;
  _dex = createDex({
    SOL_MINT,
    MIN_QUOTE_RAW_AMOUNT,
    MIN_SELL_CHUNK_SOL,
    MAX_CONSEC_SWAP_400,
    ROUTER_COOLDOWN_MS,
    TX_FEE_BUFFER_LAMPORTS,
    EDGE_TX_FEE_ESTIMATE_LAMPORTS,
    SMALL_SELL_FEE_FLOOR,
    SPLIT_FRACTIONS,
    MINT_RUG_BLACKLIST_MS,
    FEE_ATAS,

    now,
    log,
    logObj,
    getState: () => state,

    getConn,
    loadWeb3,
    loadSplToken,
    loadDeps,
    rpcWait,
    rpcBackoffLeft,
    markRpcStress: _markRpcStress,

    getCfg,
    isValidPubkeyStr,

    tokenAccountRentLamports,
    requiredAtaLamportsForSwap,
    requiredOutAtaRentIfMissing,
    shouldAttachFeeForSell,
    minSellNotionalSol,
    safeGetDecimalsFast,

    _getMultipleAccountsInfoBatched,
    _readSplAmountFromRaw,

    putBuySeed,
    getBuySeed,
    clearBuySeed,
    updatePosCache,
    removeFromPosCache,
    addToDustCache,
    removeFromDustCache,
    dustCacheToList,
    cacheToList,
    clearPendingCredit,
    processPendingCredits,
    syncPositionsFromChain,
    save,

    setRouterHold,
    setMintBlacklist,

    confirmSig,
    unwrapWsolIfAny,

    getComputeBudgetConfig,
    buildComputeBudgetIxs,
    hasComputeBudgetIx,
    dedupeComputeBudgetIxs,

    quoteOutSol,
  });
  return _dex;
}

export const dex = new Proxy(
  {},
  {
    get(_t, prop) {
      const d = _getDex();
      const v = d[prop];
      return typeof v === "function" ? v.bind(d) : v;
    },
    set(_t, prop, value) {
      const d = _getDex();
      d[prop] = value;
      return true;
    },
    has(_t, prop) {
      const d = _getDex();
      return prop in d;
    },
  },
);

const {
  addToDustCache,
  removeFromDustCache,
  dustCacheToList,
  // expose helpers if needed later
  loadDustCache: _loadDustCache,
  saveDustCache: _saveDustCache,
  isMintInDustCache: _isMintInDustCache,
} = createDustCacheStore({ keyPrefix: "fdv_dust_", log });

// Position cache store (active positions by owner)
const {
  updatePosCache,
  removeFromPosCache,
  cacheToList,
  // helpers (unused here): loadPosCache, savePosCache
} = createPosCacheStore({ keyPrefix: "fdv_pos_", log });

// Buy-seed store (temporary record of expected credits after a buy)
const {
  putBuySeed,
  getBuySeed,
  clearBuySeed,
} = createBuySeedStore({ now, ttlMs: 120_000 });

// Sell pipeline policies (extracted)
const preflightSellPolicy = createPreflightSellPolicy({
  now,
  log,
  getState: () => state,
  shouldForceMomentumExit,
  verifyRealTokenBalance: async (...args) => {
    const fn = _getAutoBotOverride("verifyRealTokenBalance");
    if (typeof fn === "function") return await fn(...args);
    return await verifyRealTokenBalance(...args);
  },
  hasPendingCredit: (...args) => {
    const fn = _getAutoBotOverride("hasPendingCredit");
    if (typeof fn === "function") return !!fn(...args);
    return hasPendingCredit(...args);
  },
  peekUrgentSell: (mint) => {
    try { return peekUrgentSell?.(mint) || null; } catch { return null; }
  },
});

const leaderModePolicy = createLeaderModePolicy({ log, getRugSignalForMint });

const { lockMint, unlockMint, isMintLocked } = createMintLockStore({
  now,
  defaultMs: MINT_OP_LOCK_MS,
});

// Urgent-sell shared store
const { flagUrgentSell, peekUrgentSell, clearUrgentSell } = createUrgentSellStore({
  now,
  getState: () => state,
  log,
  wakeSellEval,
  getRugSignalForMint,
  setMintBlacklist,
  urgentSellCooldownMs: URGENT_SELL_COOLDOWN_MS,
  urgentSellMinAgeMs: URGENT_SELL_MIN_AGE_MS,
  rugForceSellSeverity: RUG_FORCE_SELL_SEVERITY,
  mintRugBlacklistMs: MINT_RUG_BLACKLIST_MS,
});

const urgentSellPolicy = createUrgentSellPolicy({
  log,
  peekUrgentSell,
  clearUrgentSell,
  urgentSellMinAgeMs: URGENT_SELL_MIN_AGE_MS,
});

// Final extraction batch - remaining sell policies wired as DI factories
const rugPumpDropPolicy = createRugPumpDropPolicy({
  log,
  getRugSignalForMint,
  recordBadgeTransition,
  normBadge,
  isPumpDropBanned,
  setMintBlacklist,
  RUG_FORCE_SELL_SEVERITY,
  MINT_RUG_BLACKLIST_MS,
});

const earlyFadePolicy = createEarlyFadePolicy({
  log,
  clamp: _clamp,
  getState: () => state,
  getLeaderSeries,
  slope3pm,
});

const observerPolicy = createObserverPolicy({
  log,
  getState: () => state,
  observeMintOnce,
  recordObserverPasses,
  normBadge,
  getRugSignalForMint,
  getDropGuardStore: _getDropGuardStore,
  setMintBlacklist,
  noteObserverConsider,
});

const observerThreePolicy = createObserverThreePolicy({
  log,
  shouldForceSellAtThree,
  setMintBlacklist,
  MINT_RUG_BLACKLIST_MS,
  noteObserverConsider,
});

const warmingPolicyHook = createWarmingPolicyHook({ applyWarmingPolicy, log });

// Remaining (simpler) sell policies extracted as DI factories
const volatilityGuardPolicy = createVolatilityGuardPolicy({
  log,
  getState: () => state,
});

const quoteAndEdgePolicy = createQuoteAndEdgePolicy({
  log,
  getState: () => state,
  quoteOutSol: async (...args) => {
    const fn = _getAutoBotOverride("quoteOutSol");
    if (typeof fn === "function") return await fn(...args);
    return await quoteOutSol(...args);
  },
  flagUrgentSell,
  RUG_QUOTE_SHOCK_WINDOW_MS,
  RUG_QUOTE_SHOCK_FRAC,
  estimateNetExitSolFromQuote,
});

const fastExitPolicy = createFastExitPolicy({
  log,
  checkFastExitTriggers,
});

const profitLockPolicy = createProfitLockPolicy({
  log,
  save,
});

const fallbackSellPolicy = createFallbackSellPolicy({
  log,
  getState: () => state,
  minSellNotionalSol,
  shouldSell,
  MIN_SELL_SOL_OUT,
});

const forceFlagDecisionPolicy = createForceFlagDecisionPolicy({
  log,
  getState: () => state,
});

const agentDecisionPolicy = createAgentDecisionPolicy({
  log,
  getState: () => state,
  getAgent: () => getAutoTraderAgent(),
});

const reboundGatePolicy = createReboundGatePolicy({
  log,
  getState: () => state,
  shouldDeferSellForRebound,
  wakeSellEval,
  save,
});

const { maybeStealthRotate } = createStealthTools({
  now,
  log,
  save,
  getState: () => state,
  getAutoKeypair,
  rotateWallet: async (tag = "stealth") => {
    const res = await rotateAutoWalletLikeGenerate({
      tag: `stealth:${String(tag || "rotate")}`,
      allowWhileEnabled: true,
      requireStopped: false,
    });
    return !!res?.ok;
  },
  loadDeps,
  getConn,
  unwrapWsolIfAny,
  confirmSig,
  SOL_MINT,
  TX_FEE_BUFFER_LAMPORTS,
});

async function rotateAutoWalletLikeGenerate({ tag = "rotate", requireStopped = true, allowWhileEnabled = false } = {}) {
  try {
    if (requireStopped && state.enabled) {
      log("Stop the bot before generating/rotating the auto wallet.", "warn");
      return { ok: false, reason: "bot_running" };
    }

    if (!allowWhileEnabled && state.enabled) {
      log("Wallet rotation blocked while running (safety). Stop the bot first.", "warn");
      return { ok: false, reason: "bot_running" };
    }

    const g = (typeof window !== "undefined") ? window : globalThis;
    if (!g._fdvAutoWalletRotateInflight) g._fdvAutoWalletRotateInflight = false;
    if (g._fdvAutoWalletRotateInflight) {
      log("Wallet rotation already in progress…", "warn");
      return { ok: false, reason: "inflight" };
    }
    g._fdvAutoWalletRotateInflight = true;

    const hadWallet = !!(state.autoWalletPub && state.autoWalletSecret);
    if (!hadWallet) {
      await ensureAutoWallet();
      try { if (depAddrEl) depAddrEl.value = state.autoWalletPub; } catch {}
      log("New auto wallet generated. Send SOL to begin: " + state.autoWalletPub);
      try { logObj("Auto wallet", { publicKey: state.autoWalletPub, secretKey: state.autoWalletSecret }); } catch {}
      save();
      return { ok: true, generated: true, publicKey: state.autoWalletPub };
    }

    const oldPub = state.autoWalletPub;
    const oldSecret = state.autoWalletSecret;
    const oldKp = await getAutoKeypair();
    if (!oldKp) {
      log("Current auto wallet secret key is invalid; cannot rotate.", "err");
      return { ok: false, reason: "invalid_secret" };
    }

    const gen = await _generateAutoWalletKeypair();
    log(`Rotating auto wallet (${String(tag || "rotate")})…`);
    log(`From: ${oldPub}`);
    log(`To:   ${gen.publicKey}`);

    const res = await _migrateWalletFunds({ fromSigner: oldKp, toSigner: gen.kp });
    if (!res?.ok) {
      log("Wallet rotate failed; keeping existing wallet.", "err");
      return { ok: false, reason: "migrate_failed" };
    }

    // Migrate caches so sync logic doesn't prune positions on the next tick.
    _migrateOwnerCaches(oldPub, gen.publicKey);

    // Archive the old wallet in state.
    try {
      if (!Array.isArray(state.oldWallets)) state.oldWallets = [];
      state.oldWallets.unshift({ publicKey: oldPub, secretKey: oldSecret, rotatedAt: Date.now(), tag: String(tag || "rotate") });
      if (state.oldWallets.length > 25) state.oldWallets.length = 25;
    } catch {}

    state.autoWalletPub = gen.publicKey;
    state.autoWalletSecret = gen.secretKey;
    save();

    // Best-effort: publish this new wallet to the public FDV ledger.
    try {
      const { bs58 } = await loadDeps();
      await registerFdvWallet({ pubkey: state.autoWalletPub, keypair: gen.kp, bs58 });
    } catch {}

    try { if (depAddrEl) depAddrEl.value = state.autoWalletPub; } catch {}
    log("Wallet rotation complete. New auto wallet is ready.");
    try { logObj("Auto wallet (NEW)", { publicKey: state.autoWalletPub, secretKey: state.autoWalletSecret }); } catch {}

    return { ok: true, rotated: true, publicKey: state.autoWalletPub };
  } catch (e) {
    log(`Wallet rotate failed: ${e?.message || e}`, "err");
    return { ok: false, reason: "exception", error: String(e?.message || e || "") };
  } finally {
    try {
      const g = (typeof window !== "undefined") ? window : globalThis;
      g._fdvAutoWalletRotateInflight = false;
    } catch {}
  }
}

const executeSellDecisionPolicy = createExecuteSellDecisionPolicy({
  log,
  now,
  getState: () => state,
  save,
  setInFlight: (v) => { _inFlight = !!v; },
  lockMint,
  unlockMint,
  SOL_MINT,
  MINT_OP_LOCK_MS,
  ROUTER_COOLDOWN_MS,
  MIN_SELL_SOL_OUT,
  addToDustCache,
  removeFromPosCache,
  updatePosCache,
  clearPendingCredit,
  setRouterHold,
  closeEmptyTokenAtas,
  quoteOutSol,
  getAtaBalanceUi,
  minSellNotionalSol,
  executeSwapWithConfirm,
  waitForTokenDebit,
  addRealizedPnl: _addRealizedPnl,
  onRealizedPnl: (evt) => { try { agentOutcomes.record(evt); } catch {} },
  maybeStealthRotate,
  clearRouteDustFails,
});

// async function _logMoneyMade() {
//   try {
//     const totalSol = Number(state.moneyMadeSol || 0);
//     const baseSol = Number(state.pnlBaselineSol || 0);
//     const sessSol = totalSol - baseSol;
//     const px = await getSolUsd();
//     const usdStr = px > 0 ? ` (${fmtUsd(sessSol * px)})` : "";
//     log(`Money made: ${sessSol.toFixed(6)} SOL${usdStr}`);
//     try { updateStatsHeader(); } catch {}
//   } catch {
//     const totalSol = Number(state.moneyMadeSol || 0);
//     const baseSol = Number(state.pnlBaselineSol || 0);
//     const sessSol = totalSol - baseSol;
//     log(`Money made: ${sessSol.toFixed(6)} SOL`);
//     try { updateStatsHeader(); } catch {}
//   }
// }

function getSessionPnlSol() {
  return Number(state.moneyMadeSol || 0) - Number(state.pnlBaselineSol || 0);
}

let _ledgerReportTimer = null;
let _lastLedgerReportAt = 0;

function _shortTxErr(v, maxLen = 220) {
  try {
    let s = String(v?.message || v || "");
    s = s.replace(/\s+/g, " ").trim();
    if (s.length > maxLen) s = s.slice(0, maxLen) + "…";
    return s;
  } catch {
    return "";
  }
}

function _mkTxMeta({ kind, mint, res, extra } = {}) {
  try {
    const ok = !!res?.ok;
    const sig = String(res?.sig || "");
    const msg = _shortTxErr(res?.msg || res?.err || res?.error || res?.reason || "");
    const out = {
      kind: String(kind || "tx"),
      mint: String(mint || ""),
      ok,
      sig,
      msg,
    };
    if (extra && typeof extra === "object") {
      if (Number.isFinite(Number(extra?.solUi))) out.solUi = Number(extra.solUi);
      if (Number.isFinite(Number(extra?.amountUi))) out.amountUi = Number(extra.amountUi);
      if (Number.isFinite(Number(extra?.slippageBps))) out.slippageBps = Math.floor(Number(extra.slippageBps));
    }
    return out;
  } catch {
    return null;
  }
}

async function _pushLedgerReport(reason = "tick", { force = false, tx = null } = {}) {
  try {
    if (!state?.autoWalletPub) return;
    if (!state?.autoWalletSecret) return;

    // Avoid spamming.
    const t = Date.now();
    const minGap = force ? 0 : 45_000;
    if (t - _lastLedgerReportAt < minGap) return;
    _lastLedgerReportAt = t;

    const { bs58 } = await loadDeps();
    const kp = await getAutoKeypair().catch(() => null);
    if (!kp) return;

    const solBal = Number.isFinite(Number(window._fdvLastSolBal)) ? Number(window._fdvLastSolBal) : undefined;

    let moneyMadeSol = Number(state.moneyMadeSol || 0);
    let pnlBaselineSol = Number(state.pnlBaselineSol || 0);
    let sessionPnlSol = getSessionPnlSol();

    let haveCostBasis = false;
    try {
      haveCostBasis = (Math.abs(moneyMadeSol) > 1e-12) || (Math.abs(pnlBaselineSol) > 1e-12);
      if (!haveCostBasis) {
        const pos = state.positions && typeof state.positions === "object" ? state.positions : {};
        for (const p of Object.values(pos)) {
          if (Number(p?.costSol || 0) > 0) { haveCostBasis = true; break; }
        }
      }
    } catch {}

    if (!haveCostBasis && Number.isFinite(solBal)) {
      try {
        const solLamports = Math.floor(Math.max(0, solBal) * 1e9);
        const startL = Number(state.solSessionStartLamports || 0);
        if (!(startL > 0) && solLamports > 0) {
          state.solSessionStartLamports = solLamports;
          save();
        }
        const startLamports = Number(state.solSessionStartLamports || 0);
        if (startLamports > 0) {
          const deltaSol = (solLamports - startLamports) / 1e9;
          moneyMadeSol = deltaSol;
          pnlBaselineSol = 0;
          sessionPnlSol = deltaSol;
        }
      } catch {}
    }

    const metrics = {
      kind: String(state.ledgerKind || "trader").slice(0, 32),
      reason: String(reason || "tick"),
      at: t,
      solBalance: solBal,
      moneyMadeSol,
      pnlBaselineSol,
      sessionPnlSol,
      enabled: !!state.enabled,
    };

    if (tx) metrics.lastTx = tx;

    await reportFdvStats({ pubkey: state.autoWalletPub, keypair: kp, bs58, metrics, kind: state.ledgerKind || "trader" }).catch(() => null);
  } catch {}
}

function _noteDexTx(kind, mint, res, extra = null) {
  try {
    const tx = _mkTxMeta({ kind, mint, res, extra });
    try { window._fdvLastDexTx = tx; } catch {}

    // If the DEX layer is already emitting ledger reports, don't double-report here.
    const dexReports = (() => {
      try { return !!window.__fdvDexReportsLedger; } catch { return false; }
    })();
    if (!dexReports) {
      _pushLedgerReport(`dex:${String(kind || "tx")}`, { force: true, tx });
    }
  } catch {}
}

function _startLedgerReporting() {
  try {
    if (_ledgerReportTimer) return;
    _ledgerReportTimer = setInterval(() => {
      _pushLedgerReport("interval");
    }, 75_000);
    try { _pushLedgerReport("start"); } catch {}
  } catch {}
}

async function _addRealizedPnl(solProceeds, costSold, label = "PnL") {
  const proceeds = Number(solProceeds || 0);
  const cost = Number(costSold || 0);
  const costKnown = Number.isFinite(cost) && cost > 0;

  const pnl = costKnown ? (proceeds - cost) : 0;
  if (costKnown) {
    state.moneyMadeSol = Number(state.moneyMadeSol || 0) + pnl;
  }
  save();

  // Emit a post-accounting ledger report so leaderboard reflects updated PnL.
  try {
    const tx = (() => {
      try { return window._fdvLastDexTx || null; } catch { return null; }
    })();
    const lbl = String(label || "PnL").slice(0, 40);
    _pushLedgerReport(`pnl:update:${lbl}`, { force: true, tx });
  } catch {}
  try {
    const px = await getSolUsd();
    const totalSol = Number(state.moneyMadeSol || 0);
    const totalUsd = px > 0 ? ` (${fmtUsd(totalSol * px)})` : "";
    if (costKnown) {
      const sign = pnl >= 0 ? "+" : "";
      log(`${label}: ${sign}${pnl.toFixed(6)} SOL | Money made: ${totalSol.toFixed(6)} SOL${totalUsd}`);
    } else {
      // your cost is unknown?
      log(`${label}: proceeds ${proceeds.toFixed(6)} SOL (cost unknown) | Money made: ${totalSol.toFixed(6)} SOL${totalUsd}`);
    }
    try { updateStatsHeader(); } catch {}
  } catch {
    const totalSol = Number(state.moneyMadeSol || 0);
    if (costKnown) {
      const sign = (Number(solProceeds || 0) - Number(costSold || 0)) >= 0 ? "+" : "";
      log(`${label}: ${sign}${(Number(solProceeds||0)-Number(costSold||0)).toFixed(6)} SOL | Money made: ${totalSol.toFixed(6)} SOL`);
    } else {
      log(`${label}: proceeds ${Number(solProceeds||0).toFixed(6)} SOL (cost unknown) | Money made: ${totalSol.toFixed(6)} SOL`);
    }
    try { updateStatsHeader(); } catch {}
  }
}

function redactHeaders(hdrs) {
  const keys = Object.keys(hdrs || {});
  return keys.length ? `{headers: ${keys.join(", ")}}` : "{}";
}

const LS_KEY = "fdv_auto_bot_v1";

// Hold time bounds (seconds). Raised to support longer holds.
const HOLD_MIN_SECS = 30;
const HOLD_MAX_SECS = 6700;

function clampHoldSecs(v) {
  const n = Number(v);
  const x = Number.isFinite(n) ? n : HOLD_MIN_SECS;
  return Math.min(HOLD_MAX_SECS, Math.max(HOLD_MIN_SECS, x));
}

function recommendDynamicHoldSecs(passes) {
  const p = Number(passes || 0);
  const hold =
    p >= 5 ? HOLD_MAX_SECS :
    p === 4 ? Math.round(HOLD_MAX_SECS * 0.60) :
    Math.round(HOLD_MAX_SECS * 0.36);
  return clampHoldSecs(hold);
}

let state = {
  // Ledger/telemetry label (stored in FDV public ledger as metrics.kind)
  ledgerKind: "trader",

  enabled: false,
  stealthMode: false,
  loadDefaultState: true,
  mint: "",
  tickMs: 10,
  budgetUi: 0.5,  
  maxTrades: 6,  // legacy
  minSecsBetween: 90,
  buyScore: 1.2,
  takeProfitPct: 12,
  stopLossPct: 4,
  slippageBps: 250,
  holdingsUi: 0,
  avgEntryUsd: 0,
  lastTradeTs: 0,
  trailPct: 6,                 
  minProfitToTrailPct: 2,     
  coolDownSecsAfterBuy: 3,    
  minHoldSecs: 60,
  maxHoldSecs: HOLD_MAX_SECS,
  partialTpPct: 50,            
  minQuoteIntervalMs: 10000, 
  sellCooldownMs: 30000,  
  staleMinsToDeRisk: 4, 
  singlePositionMode: true,
  minNetEdgePct: -5, 
  edgeSafetyBufferPct: 0.1,
  sustainTicksMin: 2,
  sustainChgSlopeMin: 12,
  sustainScSlopeMin: 8,
  fricSnapEpsSol: 0.0020,

  // Auto wallet mode
  autoWalletPub: "",        
  autoWalletSecret: "",      
  recipientPub: "",          
  lifetimeMins: 60,         
  endAt: 0,                 
  buyPct: 0.2,              
  minBuySol: 0.12,
  maxBuySol: 0.24,       
  rpcUrl: "",    
  oldWallets: [],         

  // Per-mint positions:
  positions: {},
  rpcHeaders: {},          
  currentLeaderMint: "", 
  carrySol: 0,         
  ownerScanDisabled: false,
  ownerScanDisabledReason: "",

  // Multi buys
  allowMultiBuy: false,  
  multiBuyTopN: 1,  
  multiBuyBatchMs: 6000,
  dustExitEnabled: false,
  dustMinSolOut: 0.004,

  // Safeties
  seedBuyCache: true,
  USDCfallbackEnabled: true,
  observerDropSellAt: 4,
  observerGraceSecs: 25,
  // Observer hysteresis settings
  observerDropMinAgeSecs: 12,   
  observerDropConsec: 3,     
  observerDropTrailPct: 2.5,    

  // Cache
  pendingGraceMs: 60000,

  // collapse state for <details>
  collapsed: true,
  // hold until new leader detected
  holdUntilLeaderSwitch: false,
  // dynamic observer hold time
  dynamicHoldEnabled: true,
  // Badge status selection
  rideWarming: true,
  warmingMinProfitPct: 2,
  warmingDecayPctPerMin: 0.45,      
  warmingDecayDelaySecs: 20,         
  warmingMinProfitFloorPct: 1.0,
  warmingProfitFloorLossBypassPct: -60,
  warmingAutoReleaseSecs: 45,
  warmingUptickMinAccel: 1.001,        
  warmingUptickMinPre: 0.35,         
  warmingUptickMinDeltaChg5m: 0.012,   
  warmingUptickMinDeltaScore: 0.006,   
  warmingMinLiqUsd: 4000,             
  warmingMinV1h: 800,
  warmingPrimedConsec: 2, 
  warmingMaxLossPct: 8,           // early stop if PnL <= -10% within window
  warmingMaxLossWindowSecs: 30,    // window after buy for the max-loss guard
  warmingEdgeMinExclPct: null,  
  warmingExtendOnRise: true,
  warmingExtendStepMs: 4000,  
  warmingNoHardStopSecs: 35,
 
  reboundGateEnabled: true,         
  reboundLookbackSecs: 35,       
  reboundMaxDeferSecs: 12,         
  reboundHoldMs: 6000,             
  reboundMinScore: 0.45,            
  reboundMinChgSlope: 10,           
  reboundMinScSlope: 7,             
  reboundMinPnLPct: -2,          

  fastExitEnabled: true,
  fastExitSlipBps: 400,          
  fastExitConfirmMs: 9000,      
  fastHardStopPct: 2.5,          
  fastTrailPct: 8,               
  fastTrailArmPct: 5,            
  fastNoHighTimeoutSec: 90,      
  fastTp1Pct: 10,                
  fastTp1SellPct: 30,
  fastTp2Pct: 20,                
  fastTp2SellPct: 30,
  fastAlphaChgSlope: -8,         
  fastAlphaScSlope: -25,         
  fastAccelDropFrac: 0.5,        
  fastAlphaZV1Floor: 0.3,        

  // Early fade & late-entry filters
  earlyExitChgDropFrac: 0.55,    
  earlyExitScSlopeNeg: -40,      
  earlyExitConsec: 4,            
  lateEntryDomShare: 0.65,       
  lateEntryMinPreMargin: 0.02,   

  // Final pump gate
  finalPumpGateEnabled: true,
  finalPumpGateMinStart: 2,
  finalPumpGateDelta: 3,
  finalPumpGateWindowMs: 10000,

  // money made tracker
  moneyMadeSol: 0,
  pnlBaselineSol: 0,
  hideMoneyMade: false,           
  logNetBalance: true,          
  solSessionStartLamports: 0,

  // Entry simulation / profit-goal settings 
  entrySimMode: "enforce",
  entrySimHorizonSecs: 120,
  entrySimMinWinProb: 0.55,
  entrySimMinTerminalProb: 0.60,
  entrySimSigmaFloorPct: 0.75,
  entrySimMuLevelWeight: 0.35,

  // Light-entry settings
  lightEntryEnabled: true,
  lightEntryFraction: 1 / 3,
  lightTopUpArmMs: 7000,
  lightTopUpMinChg5m: 0.8,
  lightTopUpMinChgSlope: 6,
  lightTopUpMinScSlope: 3,

  // Entry friction cap (primarily for Agent Gary medium/safe gating)
  maxEntryCostPct: 1.5,
};

export function getAutoTraderState() {
  return state;
}

export function saveAutoTraderState() {
  save();
}
// init global user interface
let timer = null;
let ledEl;
let logEl, toggleEl, startBtn, stopBtn, mintEl;
let depAddrEl, depBalEl, lifeEl, recvEl, buyPctEl, minBuyEl, maxBuyEl, minEdgeEl, multiEl, warmDecayEl;
let tpEl, slEl, trailEl, slipEl, fricSnapEl;
let advBoxEl, warmMinPEl, warmFloorEl, warmDelayEl, warmReleaseEl, warmMaxLossEl, warmMaxWindowEl, warmConsecEl, warmEdgeEl;
let reboundScoreEl, reboundLookbackEl;
let finalGateEnabledEl, finalGateMinStartEl, finalGateDeltaEl, finalGateWindowEl;
let entrySimModeEl, entrySimHorizonEl, entrySimMinProbEl, entrySimSigmaFloorEl, entrySimMuLevelWeightEl;
let maxEntryCostEl, entrySimMinTermEl;

let grossBaseGoalEl, edgeBufEl;
let lightEnabledEl, lightFracEl, lightArmEl, lightMinChgEl, lightMinChgSlopeEl, lightMinScSlopeEl;

let _logQueue = [];
let _logRaf = 0;

function _trimLogDom() {
  try {
    if (!logEl) return;
    const expandBtn = logEl.querySelector("[data-auto-log-expand]");
    const statsHdr  = logEl.querySelector("[data-auto-stats-header]");
    const stickyCount = (expandBtn ? 1 : 0) + (statsHdr ? 1 : 0);
    const max = Math.max(100, Number(MAX_DOM_LOG_LINES || 600));
    const isSticky = (node) =>
      !!node && (node.hasAttribute("data-auto-log-expand") || node.hasAttribute("data-auto-stats-header"));

    while ((logEl.children.length - stickyCount) > max) {
      let target = logEl.firstElementChild;
      while (target && isSticky(target)) target = target.nextElementSibling;
      if (!target) break;
      logEl.removeChild(target);
    }
  } catch {}
}

function _flushLogSync(maxLines = 200) {
  try {
    if (!logEl) return;
    const pinned = (logEl.scrollTop + logEl.clientHeight) >= (logEl.scrollHeight - 4);
    if (!_logQueue.length) return;

    const frag = document.createDocumentFragment();
    const n = Math.max(1, Math.min(maxLines | 0, _logQueue.length));
    for (let i = 0; i < n; i++) {
      const entry = _logQueue.shift();
      const line = typeof entry === "string" ? entry : String(entry?.text ?? "");
      const type = typeof entry === "object" ? String(entry.type || "ok") : "ok";
      const d = document.createElement("div");
      d.className = `log-row ${type}`;
      d.textContent = line;
      frag.appendChild(d);
      requestAnimationFrame(() => d.classList.add("in"));
    }
    logEl.appendChild(frag);
    _trimLogDom();
    if (pinned) logEl.scrollTop = logEl.scrollHeight;
  } catch {}
}

function _flushLogFrame() {
  if (!logEl) { _logRaf = 0; return; }
  const pinned = (logEl.scrollTop + logEl.clientHeight) >= (logEl.scrollHeight - 4);
  if (_logQueue.length) {
    const backlog = _logQueue.length;
    const maxPerFrame = backlog > 800 ? 80 : backlog > 200 ? 40 : backlog > 50 ? 15 : 6;

    const frag = document.createDocumentFragment();
    const n = Math.max(1, Math.min(maxPerFrame, _logQueue.length));
    for (let i = 0; i < n; i++) {
      const entry = _logQueue.shift();
      const line = typeof entry === "string" ? entry : String(entry?.text ?? "");
      const type = typeof entry === "object" ? String(entry.type || "ok") : "ok";
      const d = document.createElement("div");
      d.className = `log-row ${type}`;
      d.textContent = line;
      frag.appendChild(d);
      requestAnimationFrame(() => d.classList.add("in"));
    }
    logEl.appendChild(frag);
    _trimLogDom();
    if (pinned) logEl.scrollTop = logEl.scrollHeight;
  }

  if (_logQueue.length) {
    _logRaf = requestAnimationFrame(_flushLogFrame);
  } else {
    _logRaf = 0;
  }
}

function _kickLogFlush() {
  try {
    if (!_logQueue.length) return;
    // Fast catch-up on resume (timers/rAF can be heavily throttled while hidden).
    _flushLogSync(200);
    if (_logQueue.length) {
      try { if (_logRaf) cancelAnimationFrame(_logRaf); } catch {}
      _logRaf = requestAnimationFrame(_flushLogFrame);
    }
  } catch {}
}

// Upgrade early buffered logger to UI logger once DOM is available.
log = function log(msg, type) {
  const t = String(type || "ok").toLowerCase();
  const map = t.startsWith("err") ? "err" : t.startsWith("war") ? "warn" : t.startsWith("info") ? "info" : t.startsWith("help") ? "help" : "ok";

  const g = (typeof window !== "undefined") ? window : globalThis;
  if (!g._fdvLogBuffer) g._fdvLogBuffer = [];
  const line = `[${new Date().toLocaleTimeString()}] ${msg}`;
  const buf = g._fdvLogBuffer;
  buf.push(line);
  if (buf.length > MAX_LOG_MEM_LINES) {
    buf.splice(0, buf.length - Math.floor(MAX_LOG_MEM_LINES * 0.9));
  }

  // Optional console mirroring (off by default).
  // Enable at runtime: window._fdvLogToConsole = true (or window._fdvDebugSellEval = true)
  try {
    const mirror = !!g._fdvLogToConsole || !!g._fdvDebugSellEval;
    if (mirror && typeof console !== "undefined") {
      if (map === "err" && console.error) console.error(line);
      else if (map === "warn" && console.warn) console.warn(line);
      else if (console.log) console.log(line);
    }
  } catch {}

  if (!logEl) return;
  _logQueue.push({ text: line, type: map });
  if (!_logRaf) _logRaf = requestAnimationFrame(_flushLogFrame);
};

try {
  const g = (typeof window !== "undefined") ? window : globalThis;
  if (!g._fdvAutoTraderLogResumeHookInstalled && typeof document !== "undefined") {
    g._fdvAutoTraderLogResumeHookInstalled = true;
    document.addEventListener("visibilitychange", () => {
      try { if (!document.hidden) _kickLogFlush(); } catch {}
    });
    window.addEventListener("focus", () => { try { _kickLogFlush(); } catch {} });
    window.addEventListener("pageshow", () => { try { _kickLogFlush(); } catch {} });
  }
} catch {}

logObj = function logObj(label, obj) {
  try { log(`${label}: ${JSON.stringify(obj)}`); } catch {}
};

function traceOnce(key, msg, everyMs = 8000, type = "info") {
  try {
    const g = (typeof window !== "undefined") ? window : globalThis;
    if (!g._fdvTraceOnce) g._fdvTraceOnce = new Map();
    const ts = now();
    const last = Number(g._fdvTraceOnce.get(key) || 0);
    if (last && (ts - last) < everyMs) return false;
    g._fdvTraceOnce.set(key, ts);
    log(`TRACE ${String(msg || "")}`.trim(), type);
    return true;
  } catch {
    return false;
  }
}

let _starting = false;

let _agentConfigScanDone = false;

const AGENT_CONFIG_SCAN_KEYS = [
  // sizing / friction
  "buyPct",
  "minBuySol",
  "maxBuySol",
  "slippageBps",
  "minSecsBetween",

  // entry edge / profit-goal components
  "minNetEdgePct",
  "edgeSafetyBufferPct",
  "minProfitToTrailPct",
  "maxEntryCostPct",

  // entry simulation knobs
  "entrySimMode",
  "entrySimHorizonSecs",
  "entrySimMinWinProb",
  "entrySimMinTerminalProb",
  "entrySimSigmaFloorPct",
  "entrySimMuLevelWeight",

  // warming / rebound / filters
  "rideWarming",
  "warmingMinProfitPct",
  "warmingMinProfitFloorPct",
  "warmingDecayPctPerMin",
  "warmingDecayDelaySecs",
  "warmingAutoReleaseSecs",
  "warmingMaxLossPct",
  "warmingMaxLossWindowSecs",
  "warmingPrimedConsec",
  "reboundGateEnabled",
  "reboundLookbackSecs",
  "reboundMinScore",
  "reboundMinChgSlope",
  "reboundMinScSlope",

  // light-entry knobs
  "lightEntryEnabled",
  "lightEntryFraction",
  "lightTopUpArmMs",
  "lightTopUpMinChg5m",
  "lightTopUpMinChgSlope",
  "lightTopUpMinScSlope",
];

function _agentConfigScanKeyHints(keys = AGENT_CONFIG_SCAN_KEYS) {
  try {
    const out = {};
    for (const k of keys) {
      const s = CONFIG_SCHEMA?.[k];
      if (!s) continue;
      out[k] = {
        type: String(s.type || ""),
        def: s.def,
        min: ("min" in s) ? s.min : undefined,
        max: ("max" in s) ? s.max : undefined,
      };
    }
    return out;
  } catch {
    return {};
  }
}

function _agentConfigScanStateSummary(keys = AGENT_CONFIG_SCAN_KEYS) {
  try {
    const s = {};
    for (const k of keys) s[k] = state?.[k];
    s.enabled = !!state?.enabled;
    s.tickMs = Number(state?.tickMs || 0);
    s.allowMultiBuy = !!state?.allowMultiBuy;
    s.holdUntilLeaderSwitch = !!state?.holdUntilLeaderSwitch;
    return s;
  } catch {
    return {};
  }
}

function _agentConfigScanMarketSummary() {
  try {
    const leaders = (computePumpingLeaders(4) || []).slice(0, 4);
    const list = leaders.map((it) => {
      const kp = it?.kp || {};
      return {
        mint: String(it?.mint || "").slice(0, 44),
        badge: String(getRugSignalForMint(it?.mint || "")?.badge || it?.badge || ""),
        pumpScore: Number(it?.pumpScore || 0),
        liqUsd: Number(kp?.liqUsd || 0),
        v1hUsd: Number(kp?.v1hTotal || kp?.v1h || 0),
        chg5m: Number(kp?.change5m || kp?.chg5m || 0),
        chg1h: Number(kp?.change1h || kp?.chg1h || 0),
      };
    });

    const seriesWarm = (() => {
      try {
        const store = window?._fdvLeaderSeries;
        if (!store || typeof store.size !== "number") return 0;
        return Math.min(1000, store.size | 0);
      } catch { return 0; }
    })();

    return {
      ts: Date.now(),
      topLeaders: list,
      leaderSeriesTracked: seriesWarm,
    };
  } catch {
    return { ts: Date.now(), topLeaders: [] };
  }
}

function _refreshUiFromStateSafe() {
  try {
    if (lifeEl) lifeEl.value = String(state.lifetimeMins);
    if (buyPctEl) buyPctEl.value = (Number(state.buyPct || 0) * 100).toFixed(2);
    if (minBuyEl) minBuyEl.value = String(state.minBuySol);
    if (maxBuyEl) {
      maxBuyEl.min = String(state.minBuySol);
      maxBuyEl.value = String(state.maxBuySol);
    }
    if (minEdgeEl) minEdgeEl.value = String(Number.isFinite(state.minNetEdgePct) ? state.minNetEdgePct : -4);
    if (warmDecayEl) warmDecayEl.value = String(Number.isFinite(state.warmingDecayPctPerMin) ? state.warmingDecayPctPerMin : 0.45);
    if (tpEl) tpEl.value = String(state.takeProfitPct);
    if (slEl) slEl.value = String(state.stopLossPct);
    if (trailEl) trailEl.value = String(state.trailPct);
    if (slipEl) slipEl.value = String(state.slippageBps);

    if (grossBaseGoalEl) grossBaseGoalEl.value = String(Number.isFinite(Number(state.minProfitToTrailPct)) ? Number(state.minProfitToTrailPct) : 2);
    if (edgeBufEl) edgeBufEl.value = String(Number.isFinite(Number(state.edgeSafetyBufferPct)) ? Number(state.edgeSafetyBufferPct) : 0.1);
    if (lightEnabledEl) lightEnabledEl.value = (state.lightEntryEnabled === false) ? "no" : "yes";
    if (lightFracEl) lightFracEl.value = String(Number.isFinite(Number(state.lightEntryFraction)) ? Number(state.lightEntryFraction) : (1/3));
    if (lightArmEl) lightArmEl.value = String(Number.isFinite(Number(state.lightTopUpArmMs)) ? Number(state.lightTopUpArmMs) : 7000);
    if (lightMinChgEl) lightMinChgEl.value = String(Number.isFinite(Number(state.lightTopUpMinChg5m)) ? Number(state.lightTopUpMinChg5m) : 0.8);
    if (lightMinChgSlopeEl) lightMinChgSlopeEl.value = String(Number.isFinite(Number(state.lightTopUpMinChgSlope)) ? Number(state.lightTopUpMinChgSlope) : 6);
    if (lightMinScSlopeEl) lightMinScSlopeEl.value = String(Number.isFinite(Number(state.lightTopUpMinScSlope)) ? Number(state.lightTopUpMinScSlope) : 3);

    if (warmMinPEl) warmMinPEl.value = String(Number.isFinite(state.warmingMinProfitPct) ? state.warmingMinProfitPct : 2);
    if (warmFloorEl) warmFloorEl.value = String(Number.isFinite(state.warmingMinProfitFloorPct) ? state.warmingMinProfitFloorPct : 1.0);
    if (warmDelayEl) warmDelayEl.value = String(Number.isFinite(state.warmingDecayDelaySecs) ? state.warmingDecayDelaySecs : 20);
    if (warmReleaseEl) warmReleaseEl.value = String(Number.isFinite(state.warmingAutoReleaseSecs) ? state.warmingAutoReleaseSecs : 45);
    if (warmMaxLossEl) warmMaxLossEl.value = String(Number.isFinite(state.warmingMaxLossPct) ? state.warmingMaxLossPct : 2.5);
    if (warmMaxWindowEl) warmMaxWindowEl.value = String(Number.isFinite(state.warmingMaxLossWindowSecs) ? state.warmingMaxLossWindowSecs : 60);
    if (warmConsecEl) warmConsecEl.value = String(Number.isFinite(state.warmingPrimedConsec) ? state.warmingPrimedConsec : 1);

    if (reboundScoreEl) reboundScoreEl.value = String(Number.isFinite(state.reboundMinScore) ? state.reboundMinScore : 0.45);
    if (reboundLookbackEl) reboundLookbackEl.value = String(Number.isFinite(state.reboundLookbackSecs) ? state.reboundLookbackSecs : 35);

    if (entrySimModeEl) entrySimModeEl.value = String(state.entrySimMode || "enforce");
    if (maxEntryCostEl) maxEntryCostEl.value = String(Number.isFinite(Number(state.maxEntryCostPct)) ? Number(state.maxEntryCostPct) : 1.5);
    if (entrySimHorizonEl) entrySimHorizonEl.value = String(Number.isFinite(Number(state.entrySimHorizonSecs)) ? Number(state.entrySimHorizonSecs) : 120);
    if (entrySimMinProbEl) entrySimMinProbEl.value = String(Number.isFinite(Number(state.entrySimMinWinProb)) ? Number(state.entrySimMinWinProb) : 0.55);
    if (entrySimMinTermEl) entrySimMinTermEl.value = String(Number.isFinite(Number(state.entrySimMinTerminalProb)) ? Number(state.entrySimMinTerminalProb) : 0.60);
    if (entrySimSigmaFloorEl) entrySimSigmaFloorEl.value = String(Number.isFinite(Number(state.entrySimSigmaFloorPct)) ? Number(state.entrySimSigmaFloorPct) : 0.75);
    if (entrySimMuLevelWeightEl) entrySimMuLevelWeightEl.value = String(Number.isFinite(Number(state.entrySimMuLevelWeight)) ? Number(state.entrySimMuLevelWeight) : 0.35);
  } catch {}
}

function _applyAgentConfigPatch(patch = {}, { source = "agent" } = {}) {
  try {
    if (!patch || typeof patch !== "object") return { applied: false, keys: [] };
    const allow = new Set(AGENT_CONFIG_SCAN_KEYS);
    const picked = {};
    const keys = [];
    for (const [k, v] of Object.entries(patch)) {
      if (!allow.has(k)) continue;
      picked[k] = v;
      keys.push(k);
    }
    if (!keys.length) return { applied: false, keys: [] };

    state = normalizeState({ ...state, ...picked });
    save();
    _refreshUiFromStateSafe();
    try { updateStatsHeader(); } catch {}
    log(`[AGENT GARY] config applied (${source}) keys=[${keys.join(", ")}]`);
    return { applied: true, keys };
  } catch {
    return { applied: false, keys: [] };
  }
}

async function _maybeRunAgentConfigScanAtStart() {
  try {
    if (_agentConfigScanDone) return { ok: true, skipped: true, why: "already_done" };
    if (!_isAgentGaryEffective()) return { ok: true, skipped: true, why: "agent_not_effective" };

    const agent = getAutoTraderAgent();
    if (!agent || typeof agent.scanConfig !== "function") return { ok: true, skipped: true, why: "no_agent" };

    log("[AGENT GARY] market scan: requesting best config…", "info");

    const allowedKeys = AGENT_CONFIG_SCAN_KEYS.slice();
    const keyHints = _agentConfigScanKeyHints(allowedKeys);
    const market = _agentConfigScanMarketSummary();
    const stateSummary = _agentConfigScanStateSummary(allowedKeys);

    const res = await agent.scanConfig({
      market,
      allowedKeys,
      keyHints,
      note: "Startup scan: propose a conservative, working config for the current memecoin market microstructure.",
      stateSummary,
    });

    if (!res || !res.ok) {
      log("[AGENT GARY] market scan failed; continuing with current config.", "warn");
      _agentConfigScanDone = true;
      return { ok: false, skipped: false, why: "request_failed" };
    }

    const d = res.decision || {};
    const action = String(d.action || "").toLowerCase();
    const conf = Number(d.confidence || 0);
    const reason = String(d.reason || "").slice(0, 180);

    if (action !== "apply" || !d.config) {
      log(`[AGENT GARY] market scan: no apply (action=${action || "?"} conf=${conf.toFixed(2)}) ${reason}`);
      _agentConfigScanDone = true;
      return { ok: true, skipped: true, why: "agent_skip" };
    }

    const applied = _applyAgentConfigPatch(d.config, { source: "market-scan" });
    log(`[AGENT GARY] market scan: ${applied.applied ? "APPLIED" : "NOOP"} conf=${conf.toFixed(2)} ${reason}`);
    _agentConfigScanDone = true;
    return { ok: true, skipped: false, appliedKeys: applied.keys || [] };
  } catch (e) {
    try { log(`[AGENT GARY] market scan error: ${e?.message || e}`, "warn"); } catch {}
    _agentConfigScanDone = true;
    return { ok: false, skipped: false, why: "exception" };
  }
}

let _switchingLeader = false;

let _inFlight = false;

let _buyInFlight = false;

let _sellEvalRunning = false;
let _sellEvalWakePending = false;
let _sellEvalWakeTimer = 0;
let _sellEvalWakeBlockedAt = 0;
let _sellEvalWakeLastLogAt = 0;

let _buyBatchUntil = 0;

const _pkValidCache = new Map();

let _lastOwnerReconTs = 0;

let _solPxCache = { ts: 0, usd: 0 };

let _getConnImpl = null;
let _lastConnLogKey = "";

let _lastDepFetchTs = 0;

let _kpiPumpCompareMissLastMint = "";
let _kpiPumpCompareMissLastAt = 0;

const CONFIG_VERSION = 1;

const CONFIG_SCHEMA = {
  enabled:                  { type: "boolean", def: false },
  stealthMode:              { type: "boolean", def: false },
  mint:                     { type: "string",  def: "" },
  tickMs:                   { type: "number",  def: 10, min: 5, max: 5000 },
  budgetUi:                 { type: "number",  def: 0.5,  min: 0, max: 1 },
  minSecsBetween:           { type: "number",  def: 90,   min: 0, max: 3600 },
  buyPct:                   { type: "number",  def: 0.2,  min: 0.01, max: 0.5 },
  minBuySol:                { type: "number",  def: 0.12, min: 0.01, max: 1 },
  maxBuySol:                { type: "number",  def: 0.24, min: 0.06, max: 5 },
  slippageBps:              { type: "number",  def: 200,  min: 50, max: 2000 },
  coolDownSecsAfterBuy:     { type: "number",  def: 3,    min: 0, max: 120 },
  pendingGraceMs:           { type: "number",  def: 120_000, min: 10_000, max: 600_000 },
  fricSnapEpsSol:           { type: "number",  def: 0.0020, min: 0, max: 0.05 },
  allowMultiBuy:            { type: "boolean", def: false },
  rideWarming:              { type: "boolean", def: true },
  warmingMinProfitPct:      { type: "number",  def: 2,    min: 0,  max: 50 },
  warmingDecayPctPerMin:    { type: "number",  def: 0.45, min: 0, max: 5 },
  warmingDecayDelaySecs:    { type: "number",  def: 20,   min: 0, max: 600 },
  warmingMinProfitFloorPct: { type: "number",  def: 1.0,  min: 0,  max: 50 },
  warmingProfitFloorLossBypassPct: { type: "number", def: -60, min: -99, max: 0 },
  warmingAutoReleaseSecs:   { type: "number",  def: 45,   min: 0, max: 600 },
  warmingUptickMinAccel:    { type: "number",  def: 1.001 },
  warmingUptickMinPre:      { type: "number",  def: 0.35 },
  warmingUptickMinDeltaChg5m:{ type: "number", def: 0.012 },
  warmingUptickMinDeltaScore:{ type: "number", def: 0.006 },
  warmingMinLiqUsd:         { type: "number",  def: 4000 },
  warmingMinV1h:            { type: "number",  def: 800 },
  warmingPrimedConsec:      { type: "number",  def: 1, min: 1, max: 3 },
  warmingMaxLossPct:        { type: "number",  def: 2.5, min: 1, max: 50 },
  warmingMaxLossWindowSecs: { type: "number",  def: 60, min: 5, max: 180 },
  warmingNoHardStopSecs:    { type: "number",  def: 35,  min: 5, max: 180 },
  minNetEdgePct:            { type: "number",  def: -4, min: -10, max: 10 },
  edgeSafetyBufferPct:      { type: "number",  def: 0.1, min: 0, max: 2 },
  minProfitToTrailPct:      { type: "number",  def: 2, min: 0.5, max: 200 },

  // Light-entry settings
  lightEntryEnabled:        { type: "boolean", def: true },
  lightEntryFraction:       { type: "number",  def: 1 / 3, min: 0.1, max: 0.9 },
  lightTopUpArmMs:          { type: "number",  def: 7000, min: 1000, max: 60000 },
  lightTopUpMinChg5m:       { type: "number",  def: 0.8, min: 0, max: 50 },
  lightTopUpMinChgSlope:    { type: "number",  def: 6, min: 0, max: 50 },
  lightTopUpMinScSlope:     { type: "number",  def: 3, min: 0, max: 50 },
  reboundGateEnabled:       { type: "boolean", def: true },
  reboundLookbackSecs:      { type: "number",  def: 35,  min: 5, max: 180 },
  reboundMaxDeferSecs:      { type: "number",  def: 12,  min: 4, max: 120 },
  reboundHoldMs:            { type: "number",  def: 6000, min: 500, max: 15000 },
  reboundMinScore:          { type: "number",  def: 0.45 },
  reboundMinChgSlope:       { type: "number",  def: 10 },
  reboundMinScSlope:        { type: "number",  def: 7 },
  reboundMinPnLPct:         { type: "number",  def: -2, min: -90, max: 90 },
  fastExitEnabled:          { type: "boolean", def: true },
  fastExitSlipBps:          { type: "number",  def: 400 },
  fastExitConfirmMs:        { type: "number",  def: 9000 },
  fastHardStopPct:          { type: "number",  def: 2.5 },
  fastTrailPct:             { type: "number",  def: 8 },
  fastTrailArmPct:          { type: "number",  def: 4 },
  fastNoHighTimeoutSec:     { type: "number",  def: 90 },
  fastTp1Pct:               { type: "number",  def: 12 },
  fastTp1SellPct:           { type: "number",  def: 30 },
  fastTp2Pct:               { type: "number",  def: 20 },
  fastTp2SellPct:           { type: "number",  def: 30 },
  fastAlphaChgSlope:        { type: "number",  def: -3 },
  fastAlphaScSlope:         { type: "number",  def: -10 },
  fastAccelDropFrac:        { type: "number",  def: 0.5 },
  fastAlphaZV1Floor:        { type: "number",  def: 0.3 },
  priorityMicroLamports:    { type: "number", def: 10_000 },
  computeUnitLimit:         { type: "number", def: 1_400_000 },
  strictBuyFilter:          { type: "boolean", def: true },
  dustExitEnabled:          { type: "boolean", def: false },
  dustMinSolOut:            { type: "number",  def: 0.004 },
  sustainTicksMin:          { type: "number",  def: 2, min: 1, max: 4 },
  sustainChgSlopeMin:       { type: "number",  def: 12 },
  sustainScSlopeMin:        { type: "number",  def: 8 },
  finalPumpGateEnabled:     { type: "boolean", def: true },
  finalPumpGateMinStart:    { type: "number",  def: 2 },  
  finalPumpGateDelta:       { type: "number",  def: 3 },   
  finalPumpGateWindowMs:    { type: "number",  def: 10000, min: 1000, max: 30_000 },

  // Entry simulation / profit-goal settings
  entrySimMode:             { type: "string",  def: "enforce" }, // off | warn | enforce
  entrySimHorizonSecs:      { type: "number",  def: 120, min: 30, max: 600 },
  entrySimMinWinProb:       { type: "number",  def: 0.55, min: 0, max: 1 },
  entrySimMinTerminalProb:  { type: "number",  def: 0.60, min: 0, max: 1 },
  entrySimSigmaFloorPct:    { type: "number",  def: 0.75, min: 0, max: 10 },
  entrySimMuLevelWeight:    { type: "number",  def: 0.35, min: 0, max: 1 },

  // Entry friction cap
  maxEntryCostPct:          { type: "number",  def: 1.5, min: 0, max: 10 },
};

function coerceNumber(v, def, opts = {}) {
  const n = Number(v);
  const x = Number.isFinite(n) ? n : def;
  if (Number.isFinite(opts.min) && x < opts.min) return opts.min;
  if (Number.isFinite(opts.max) && x > opts.max) return opts.max;
  return x;
}
function coerceBoolean(v, def = false) { return typeof v === "boolean" ? v : (!!v ?? def); }
function coerceString(v, def = "") { return typeof v === "string" ? v : String(v ?? def); }
function coerceByType(v, s) {
  switch (s.type) {
    case "number":  return coerceNumber(v, s.def, s);
    case "boolean": return coerceBoolean(v, s.def);
    case "string":  return coerceString(v, s.def);
    default:        return v ?? s.def;
  }
}
function normalizeState(raw = {}) {
  const out = { ...raw, _cfgVersion: CONFIG_VERSION };
  for (const [k, s] of Object.entries(CONFIG_SCHEMA)) {
    out[k] = coerceByType(raw[k], s);
  }

  // Migration: if the user never changed legacy defaults, promote them to safer defaults.
  try {
    const legacyCfg = !Number.isFinite(Number(raw?._cfgVersion));
    if (legacyCfg) {
      const rawMinBuy = Number(raw?.minBuySol);
      const rawMaxBuy = Number(raw?.maxBuySol);
      if (rawMinBuy === 0.06) out.minBuySol = 0.12;
      if (rawMaxBuy === 0.12) out.maxBuySol = 0.24;

      const rawFloor = Number(raw?.warmingMinProfitFloorPct);
      if (rawFloor === 0) out.warmingMinProfitFloorPct = 1.0;
    }
  } catch {}



  out.tickMs = Math.max(1200, Math.min(5000, coerceNumber(out.tickMs, 2000)));
  out.slippageBps = Math.min(250, Math.max(150, coerceNumber(out.slippageBps, 200)));
  out.minBuySol = Math.max(UI_LIMITS.MIN_BUY_SOL_MIN, coerceNumber(out.minBuySol, 0.12));
  out.maxBuySol = Math.max(out.minBuySol, coerceNumber(out.maxBuySol, 0.24));
  out.coolDownSecsAfterBuy = Math.max(0, Math.min(12, coerceNumber(out.coolDownSecsAfterBuy, 5)));
  out.pendingGraceMs = Math.max(120_000, coerceNumber(out.pendingGraceMs, 120_000));
  out.fricSnapEpsSol = coerceNumber(out.fricSnapEpsSol, 0.0020, { min: 0, max: 0.05 });

  // Holds (seconds)
  out.minHoldSecs = coerceNumber(out.minHoldSecs, 5, { min: 0, max: HOLD_MAX_SECS });
  // Migration: older configs were capped at 500s (and defaulted to 300s). Promote those legacy values to the new default.
  const rawMaxHold = Number(raw?.maxHoldSecs);
  const isLegacyMaxHold = !Number.isFinite(rawMaxHold) || rawMaxHold === 300 || rawMaxHold === 500;
  out.maxHoldSecs = coerceNumber(out.maxHoldSecs, isLegacyMaxHold ? HOLD_MAX_SECS : 50, { min: 0, max: HOLD_MAX_SECS });
  if (out.maxHoldSecs > 0 && out.minHoldSecs > out.maxHoldSecs) out.minHoldSecs = out.maxHoldSecs;

  out.finalPumpGateEnabled  = !!out.finalPumpGateEnabled;
  out.finalPumpGateMinStart = coerceNumber(out.finalPumpGateMinStart, 2,  { min: 0, max: 50 });
  out.finalPumpGateDelta    = coerceNumber(out.finalPumpGateDelta, 3,     { min: 0, max: 50 });
  out.finalPumpGateWindowMs = coerceNumber(out.finalPumpGateWindowMs, 10000, { min: 1000, max: 30_000 });

  out.reboundLookbackSecs = coerceNumber(out.reboundLookbackSecs, 35, { min: 5, max: 180 });
  out.reboundMaxDeferSecs = coerceNumber(out.reboundMaxDeferSecs, 12, { min: 4, max: 120 });
  out.reboundHoldMs       = coerceNumber(out.reboundHoldMs, 6000, { min: 500, max: 15000 });
  out.reboundMinScore     = coerceNumber(out.reboundMinScore, 0.45);
  out.reboundMinChgSlope  = coerceNumber(out.reboundMinChgSlope, 10);
  out.reboundMinScSlope   = coerceNumber(out.reboundMinScSlope, 7);
  out.reboundMinPnLPct    = coerceNumber(out.reboundMinPnLPct, -2, { min: -90, max: 90 });

  // Entry sim mode normalization
  try {
    const m = String(out.entrySimMode || "enforce").toLowerCase();
    out.entrySimMode = (m === "off" || m === "warn" || m === "enforce") ? m : "enforce";
  } catch {
    out.entrySimMode = "enforce";
  }

  if (typeof out.warmingEdgeMinExclPct !== "number" || !Number.isFinite(out.warmingEdgeMinExclPct)) {
    delete out.warmingEdgeMinExclPct;
  }

  out.oldWallets = Array.isArray(out.oldWallets) ? out.oldWallets.slice(0, 10) : [];
  if (!out.positions || typeof out.positions !== "object") out.positions = {};
  if (!out.rpcHeaders || typeof out.rpcHeaders !== "object") out.rpcHeaders = {};

  return out;
}

function _pcKey(owner, mint) { return `${owner}:${mint}`; }

// Pending-credit queue (buy reconciliation)
// Tracks pending token credits after a buy when the on-chain ATA balance hasn't reflected yet.
// Provides lightweight reconciliation via ATA balance checks and optional tx meta parsing.
function _getPendingStore() {
  if (!window._fdvPendingCredits) window._fdvPendingCredits = new Map(); // key=owner:mint -> rec
  return window._fdvPendingCredits;
}

function pendingCreditsSize() {
  try { return _getPendingStore().size | 0; } catch { return 0; }
}

function hasPendingCredit(owner, mint) {
  try { return _getPendingStore().has(_pcKey(String(owner||""), String(mint||""))); } catch { return false; }
}

function clearPendingCredit(owner, mint) {
  try { _getPendingStore().delete(_pcKey(String(owner||""), String(mint||""))); } catch {}
}

function enqueuePendingCredit({ owner, mint, addCostSol = 0, decimalsHint, basePos, sig = "" } = {}) {
  try {
    if (!owner || !mint) return false;
    const key = _pcKey(owner, mint);
    const rec = {
      owner: String(owner),
      mint: String(mint),
      addCostSol: Number(addCostSol || 0),
      decimalsHint: Number.isFinite(decimalsHint) ? decimalsHint : undefined,
      basePos: basePos && typeof basePos === "object" ? { ...basePos } : null,
      sig: String(sig || ""),
      enqueuedAt: now(),
      attempts: 0,
    };
    _getPendingStore().set(key, rec);
    try { startPendingCreditWatchdog(); } catch {}
    return true;
  } catch { return false; }
}

async function reconcileBuyFromTx(sig, owner, mint) {
  // Best-effort: parse tx meta token balance delta for the mint
  try {
    if (!sig) return null;
    const conn = await getConn();
    const tx = await conn.getTransaction(sig, { maxSupportedTransactionVersion: 0, commitment: "confirmed" });
    const meta = tx?.meta;
    if (!meta) return null;
    const pre = Array.isArray(meta.preTokenBalances) ? meta.preTokenBalances : [];
    const post = Array.isArray(meta.postTokenBalances) ? meta.postTokenBalances : [];
    const findByMint = (arr) => arr.find(x => String(x?.mint || "") === String(mint || ""));
    const p0 = findByMint(pre);
    const p1 = findByMint(post);
    if (!p1) return null;
    const dec = Number.isFinite(p1.uiTokenAmount?.decimals) ? p1.uiTokenAmount.decimals : Number(p1.decimals);
    const uiPost = Number(p1.uiTokenAmount?.uiAmount || 0);
    const uiPre  = Number(p0?.uiTokenAmount?.uiAmount || 0);
    const delta  = uiPost - uiPre;
    if (Number.isFinite(delta) && delta > 0) {
      return { mint: String(mint), sizeUi: delta, decimals: Number.isFinite(dec) ? dec : undefined };
    }
    if (uiPost > 0) {
      return { mint: String(mint), sizeUi: uiPost, decimals: Number.isFinite(dec) ? dec : undefined };
    }
  } catch {}
  return null;
}

async function processPendingCredits() {
  try {
    const store = _getPendingStore();
    if (store.size === 0) return 0;
    let reconciled = 0;
    for (const [key, rec] of Array.from(store.entries())) {
      try {
        const owner = rec.owner, mint = rec.mint;
        const hintDec = Number.isFinite(rec.decimalsHint) ? rec.decimalsHint : undefined;
        let b = await getAtaBalanceUi(owner, mint, hintDec, "confirmed").catch(()=>({ sizeUi:0, decimals: hintDec }));
        let size = Number(b.sizeUi || 0);
        let dec  = Number.isFinite(b.decimals) ? b.decimals : (hintDec ?? 6);

        if (size <= 0 && rec.sig) {
          const metaHit = await reconcileBuyFromTx(rec.sig, owner, mint).catch(()=>null);
          if (metaHit && metaHit.mint === mint && Number(metaHit.sizeUi||0) > 0) {
            size = Number(metaHit.sizeUi || 0);
            if (Number.isFinite(metaHit.decimals)) dec = metaHit.decimals;
            log(`Pending-credit via tx meta for ${mint.slice(0,4)}… size≈${size.toFixed(6)}`);
          }
        }

        if (size > 0) {
          const prev = state.positions[mint] || (rec.basePos || { costSol: 0, hwmSol: 0, acquiredAt: now() });
          const pos = {
            ...prev,
            sizeUi: size,
            decimals: Number.isFinite(dec) ? dec : (prev.decimals ?? 6),
            awaitingSizeSync: false,
            lastSeenAt: now(),
          };
          if (Number(rec.addCostSol || 0) > 0) {
            pos.costSol = Number(pos.costSol || 0) + Number(rec.addCostSol || 0);
            pos.hwmSol  = Math.max(Number(pos.hwmSol || 0), Number(rec.addCostSol || 0));
            pos.lastBuyAt = now();
          }
          state.positions[mint] = pos;
          updatePosCache(owner, mint, pos.sizeUi, pos.decimals);
          clearPendingCredit(owner, mint);
          save();
          reconciled++;
          log(`Reconciled pending credit for ${mint.slice(0,4)}… -> ${pos.sizeUi.toFixed(6)} (dec=${pos.decimals}).`);
        } else {
          // Keep retrying for a grace window, then leave for sweep logic to prune
          rec.attempts = (rec.attempts|0) + 1;
          store.set(key, rec);
        }
      } catch {}
    }
    return reconciled;
  } catch { return 0; }
}

async function reconcileFromOwnerScan(ownerPubkeyStr) {
  try {
    const store = _getPendingStore();
    if (store.size === 0) return 0;
    let hits = 0;
    for (const [key, rec] of Array.from(store.entries())) {
      if (rec.owner !== ownerPubkeyStr) continue;
      try {
        const b = await getAtaBalanceUi(rec.owner, rec.mint, rec.decimalsHint, "confirmed");
        const size = Number(b.sizeUi || 0);
        const dec  = Number.isFinite(b.decimals) ? b.decimals : (rec.decimalsHint ?? 6);
        if (size > 0) {
          const prev = state.positions[rec.mint] || (rec.basePos || { costSol: 0, hwmSol: 0, acquiredAt: now() });
          const pos = {
            ...prev,
            sizeUi: size,
            decimals: dec,
            awaitingSizeSync: false,
            lastSeenAt: now(),
          };
          state.positions[rec.mint] = pos;
          updatePosCache(rec.owner, rec.mint, pos.sizeUi, pos.decimals);
          clearPendingCredit(rec.owner, rec.mint);
          save();
          hits++;
          log(`Owner-scan reconciled ${rec.mint.slice(0,4)}… -> ${size.toFixed(6)}.`);
        }
      } catch {}
    }
    return hits;
  } catch { return 0; }
}

function startPendingCreditWatchdog() {
  try {
    if (window._fdvPendingWatchTimer) return;
    window._fdvPendingWatchTimer = setInterval(() => {
      Promise.resolve()
        .then(() => processPendingCredits())
        .catch(()=>{});
    }, Math.max(2_000, Number(state.tickMs || 2_000)));
    log("Pending-credit watchdog started.");
  } catch {}
}

function wakeSellEval(delayMs = 0) {
  try {
    traceOnce(
      "sellEval:wake",
      `wakeSellEval queued (running=${_sellEvalRunning ? 1 : 0} inFlight=${_inFlight ? 1 : 0})`,
      8000
    );
    _sellEvalWakePending = true;

    if (_sellEvalWakeTimer) return;

    const initialDelayMs = Math.max(0, Number(delayMs || 0) | 0);
    _sellEvalWakeTimer = setTimeout(() => {
      _sellEvalWakeTimer = 0;
      if (!_sellEvalWakePending) return;

      if (_sellEvalRunning || _inFlight) {
        const nowTs = now();
        if (!_sellEvalWakeBlockedAt) _sellEvalWakeBlockedAt = nowTs;
        const blockedMs = nowTs - _sellEvalWakeBlockedAt;
        if (blockedMs >= 3000) {
          if (!_sellEvalWakeLastLogAt || (nowTs - _sellEvalWakeLastLogAt) >= 5000) {
            _sellEvalWakeLastLogAt = nowTs;
            log(`Sell-eval wake blocked (${Math.floor(blockedMs / 1000)}s) ${_sellEvalRunning ? "_sellEvalRunning" : "_inFlight"}; will retry …`);
          }
        }

        // Preserve functionality (keep retrying), but avoid a 0ms tight-loop that spams logs.
        // Backoff ramps up to 1s while blocked; once unblocked we run immediately.
        const backoffMs = Math.min(1000, 50 + Math.floor(blockedMs / 10));
        wakeSellEval(backoffMs);
        return;
      }

      _sellEvalWakePending = false;
      _sellEvalWakeBlockedAt = 0;
      _sellEvalWakeLastLogAt = 0;
      evalAndMaybeSellPositions().catch(()=>{});
    }, initialDelayMs);
  } catch {}
}

function _getFastObsLogStore() {
  if (!window._fdvFastObsLog) window._fdvFastObsLog = new Map(); // mint -> { lastAt, lastBadge, lastMsg }
  return window._fdvFastObsLog;
}
function _getMomentumDropStore() {
  if (!window._fdvMomDrop) window._fdvMomDrop = new Map(); // mint -> { count, lastAt }
  return window._fdvMomDrop;
}
function _getMomExitStore() {
  if (!window._fdvMomExit) window._fdvMomExit = new Map(); // mint -> untilTs
  return window._fdvMomExit;
}
function noteMomentumExit(mint, ttlMs = 30_000) {
  if (!mint) return;
  const until = now() + Math.max(5_000, ttlMs | 0);
  _getMomExitStore().set(mint, until);
}
function shouldForceMomentumExit(mint) {
	// Momentum drop is used for risk/rug context only; it must NOT force sells.
	return false;
}


function _fmtDelta(a, b, digits = 2) {
  if (!Number.isFinite(a) || !Number.isFinite(b)) return "—";
  const d = b - a;
  const sign = d > 0 ? "+" : d < 0 ? "-" : "±";
  return `${b.toFixed(digits)} (${sign}${Math.abs(d).toFixed(digits)})`;
}
function _normNum(n) { return Number.isFinite(n) ? n : null; }


function logFastObserverSample(mint, pos) {
  try {
    const store = _getFastObsLogStore();
    const rec = store.get(mint) || { lastAt: 0, lastBadge: "", lastMsg: "" };
    const nowTs = now();
    if (nowTs - rec.lastAt < FAST_OBS_LOG_INTERVAL_MS) return;

    const sig = getRugSignalForMint(mint) || {};
    const rawBadge = String(sig.badge || "");
    const badge = normBadge(rawBadge);

    const series = getLeaderSeries(mint, 3) || [];
    const a = series[0] || {};
    const c = series[series.length - 1] || {};
    const aChg = _normNum(a.chg5m), cChg = _normNum(c.chg5m);
    const aSc  = _normNum(a.pumpScore), cSc  = _normNum(c.pumpScore);

    const sz = Number(pos.sizeUi || 0);
    const curSol = Number(pos.lastQuotedSol || 0);
    let ddStr = "dd: —";
    if (sz > 0 && curSol > 0 && Number(pos.hwmPx || 0) > 0) {
      const pxNow = curSol / sz;
      const ddPct = ((pos.hwmPx - pxNow) / Math.max(1e-12, pos.hwmPx)) * 100;
      ddStr = `dd: ${ddPct.toFixed(2)}%`;
    }

    const chgStr = (aChg !== null && cChg !== null) ? `chg5m: ${_fmtDelta(aChg, cChg, 2)}` : `chg5m: ${Number.isFinite(cChg) ? cChg.toFixed(2) : "—"}`;
    const scStr  = (aSc !== null  && cSc !== null)  ? `score: ${_fmtDelta(aSc, cSc, 2)}`  : `score: ${Number.isFinite(cSc) ? cSc.toFixed(2) : "—"}`;

    const msg = `FastObs ${mint.slice(0,4)}… [${badge}] ${chgStr} ${scStr} ${ddStr}`;
    // Only log if new interval or badge changed or content differs
    if (badge !== rec.lastBadge || msg !== rec.lastMsg) {
      if (rawBadge && rawBadge !== rec.lastRawBadge) {
        // surface raw badge transition (e.g., "🔥 Pumping" -> "Calm")
        log(`FastObs badge ${mint.slice(0,4)}…: ${rec.lastRawBadge || "(none)"} -> ${rawBadge}`);
      }
      log(msg);
      store.set(mint, { lastAt: nowTs, lastBadge: badge, lastMsg: msg, lastRawBadge: rawBadge });
    } else {
      // update timestamp to pace logs even if unchanged
      store.set(mint, { ...rec, lastAt: nowTs });
    }
  } catch {}
}


function tryAcquireBuyLock(ms = BUY_LOCK_MS) {
  const t = now();
  const until = Number(window._fdvBuyLockUntil || 0);
  if (t < until) return false;
  window._fdvBuyLockUntil = t + Math.max(1_000, ms|0);
  return true;
}

function releaseBuyLock() {
  try { window._fdvBuyLockUntil = 0; } catch {}
}

function optimisticSeedBuy(ownerStr, mint, estUi, decimals, buySol, sig = "") {
  try {
    if (!ownerStr || !mint || !Number.isFinite(estUi) || estUi <= 0) return;
    const nowTs = now();
    const prev = state.positions[mint] || { sizeUi: 0, costSol: 0, hwmSol: 0, acquiredAt: nowTs };
    const pos = {
      ...prev,
      sizeUi: Number(prev.sizeUi || 0) + Number(estUi || 0),   // accumulate
      decimals: Number.isFinite(decimals) ? decimals : (prev.decimals ?? 6),
      costSol: Number(prev.costSol || 0) + Number(buySol || 0),
      hwmSol: Math.max(Number(prev.hwmSol || 0), Number(buySol || 0)),
      lastBuyAt: nowTs,
      lastSeenAt: nowTs,
      awaitingSizeSync: true,
      allowRebuy: false,
      lastSplitSellAt: undefined,
    };
    state.positions[mint] = pos;
    updatePosCache(ownerStr, mint, pos.sizeUi, pos.decimals);
    save();
    enqueuePendingCredit({
      owner: ownerStr,
      mint,
      // Cost already applied optimistically; pending credit should only reconcile size.
      addCostSol: 0,
      decimalsHint: pos.decimals,
      basePos: pos,
      sig: sig || ""
    });
    log(`Optimistic seed: ${mint.slice(0,4)}… (~${Number(estUi).toFixed(6)}) — awaiting credit`);
  } catch {}
}


function minSellNotionalSol() {
  return Math.max(
    MIN_SELL_SOL_OUT,
    MIN_JUP_SOL_IN * 1.05,
    Number(state.dustMinSolOut || 0),
    MIN_SELL_CHUNK_SOL
  );
}

async function sanitizeDustCache(ownerPubkeyStr) {
  try {
    const cache = loadDustCache(ownerPubkeyStr);
    let pruned = 0;
    for (const mint of Object.keys(cache)) {
      let ok = false;
      try { ok = await isValidPubkeyStr(mint); } catch {}
      if (!ok) {
        delete cache[mint];
        pruned++;
      }
    }
    if (pruned > 0) {
      saveDustCache(ownerPubkeyStr, cache);
      log(`Pruned ${pruned} invalid dust entries.`);
    }
  } catch {}
}

function moveRemainderToDust(ownerPubkeyStr, mint, sizeUi, decimals) {
  try { addToDustCache(ownerPubkeyStr, mint, sizeUi, decimals); } catch {}
  try { removeFromPosCache(ownerPubkeyStr, mint); } catch {}
  if (state.positions && state.positions[mint]) { delete state.positions[mint]; save(); }
  log(`Remainder classified as dust for ${mint.slice(0,4)}… removed from positions.`, 'warn');
}

function clearRouteDustFails(mint) {
  try { window._fdvRouteDustFails.delete(mint); } catch {}
}

async function safeGetDecimalsFast(mintStr) {
  try { return await getMintDecimals(mintStr); } catch { return 6; }
}

function downloadTextFile(filename, text) {
  const blob = new Blob([text], { type: "application/json;charset=utf-8" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => {
    URL.revokeObjectURL(a.href);
    a.remove();
  }, 0);
}

async function getCfg() {
  return AUTO_CFG;
}

export async function getJupBase() {
  return _getDex().getJupBase();
}

// async function getFeeReceiver() {
//   const cfg = await getCfg();
//   const fromEnv = String(FDV_FEE_RECEIVER || "").trim();
//   if (fromEnv) return fromEnv;
//   const fromCfg =
//     String(
//       cfg.platformFeeReceiver ||
//       cfg.feeReceiver ||
//       cfg.FDV_FEE_RECEIVER ||
//       ""
//     ).trim();
//   return fromCfg;
// }
async function tokenAccountRentLamports() {
  if (window._fdvAtaRentLamports) return window._fdvAtaRentLamports;
  try {
    const conn = await getConn();
    window._fdvAtaRentLamports = await conn.getMinimumBalanceForRentExemption(165);
  } catch {
    window._fdvAtaRentLamports = 2_039_280;
  }
  return window._fdvAtaRentLamports;
}

async function requiredOutAtaRentIfMissing(ownerPubkeyStr, outputMint) {
  const outMint = String(outputMint || "").trim();
  if (!outMint || outMint === SOL_MINT) return 0;
  const rent = await tokenAccountRentLamports();
  const hasOut = await ataExists(ownerPubkeyStr, outMint);
  return hasOut ? 0 : rent;
}

async function requiredAtaLamportsForSwap(ownerPubkeyStr, inputMint, outputMint) {
  let need = 0;
  const rent = await tokenAccountRentLamports();

  if (inputMint === SOL_MINT) {
    const hasWsol = await ataExists(ownerPubkeyStr, SOL_MINT);
    if (!hasWsol) need += rent;
  } else {
    const hasIn = await ataExists(ownerPubkeyStr, inputMint);
    if (!hasIn) need += rent;
  }

  if (outputMint !== SOL_MINT) {
    const hasOut = await ataExists(ownerPubkeyStr, outputMint);
    if (!hasOut) need += rent;
  }
  return need;
}

async function unwrapWsolIfAny(signerOrOwner) {
  const SOL_MINT = "So11111111111111111111111111111111111111112";
  try {
    const { PublicKey, Transaction, TransactionInstruction } = await loadWeb3();
    const conn = await getConn();

    let ownerPk = null;
    let signer = null;
    try {
      if (signerOrOwner?.publicKey) {
        ownerPk = signerOrOwner.publicKey instanceof PublicKey
          ? signerOrOwner.publicKey
          : new PublicKey(
              signerOrOwner.publicKey.toBase58
                ? signerOrOwner.publicKey.toBase58()
                : signerOrOwner.publicKey
            );
        signer = signerOrOwner;
      } else if (typeof signerOrOwner === "string" && await isValidPubkeyStr(signerOrOwner)) {
        ownerPk = new PublicKey(signerOrOwner);
      } else if (signerOrOwner && typeof signerOrOwner.toBase58 === "function") {
        ownerPk = new PublicKey(signerOrOwner.toBase58());
        signer = signerOrOwner;
      }
    } catch {}
    if (!ownerPk) return false;

    const canSign = !!(signer && (typeof signer.sign === "function" || (signer.secretKey && signer.secretKey.length > 0)));
    if (!canSign) return false;

    if (!window._fdvUnwrapInflight) window._fdvUnwrapInflight = new Map();
    const ownerStr = ownerPk.toBase58();
    if (window._fdvUnwrapInflight.get(ownerStr)) return false;
    window._fdvUnwrapInflight.set(ownerStr, true);

    try {
      const { TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, createCloseAccountInstruction, getAssociatedTokenAddress } = await loadSplToken();
      const progs = [TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID].filter(Boolean);

      const atapks = [];
      for (const pid of progs) {
        try {
          const mint = new PublicKey(SOL_MINT);
          const ataAny = await getAssociatedTokenAddress(mint, ownerPk, true, pid);
          const ata = typeof ataAny === "string" ? new PublicKey(ataAny) : ataAny;
          if (ata) atapks.push({ pid, ata });
        } catch {}
      }

      const ixs = [];
      for (const { pid, ata } of atapks) {
        try {
          const ai = await conn.getAccountInfo(ata, "processed").catch(e => { _markRpcStress(e, 1500); return null; });
          if (!ai) continue;
          if (typeof createCloseAccountInstruction === "function") {
            ixs.push(createCloseAccountInstruction(ata, ownerPk, ownerPk, [], pid));
          } else {
            ixs.push(new TransactionInstruction({
              programId: pid,
              keys: [
                { pubkey: ata,     isSigner: false, isWritable: true },
                { pubkey: ownerPk, isSigner: false, isWritable: true },
                { pubkey: ownerPk, isSigner: true,  isWritable: false },
              ],
              data: Uint8Array.of(9),
            }));
          }
        } catch (e) { _markRpcStress(e, 1500); }
      }

      if (!ixs.length) return false;

      const tx = new Transaction();
      for (const ix of ixs) tx.add(ix);
      tx.feePayer = ownerPk;
      tx.recentBlockhash = (await conn.getLatestBlockhash("processed")).blockhash;
      tx.sign(signer);
      const sig = await conn.sendRawTransaction(tx.serialize(), { preflightCommitment: "processed", maxRetries: 2 });
      log(`WSOL unwrap sent: ${sig}`);
      return true;
    } finally {
      window._fdvUnwrapInflight.delete(ownerStr);
    }
  } catch (e) {
    if (!/Invalid public key input/i.test(String(e?.message || e))) {
      log(`WSOL unwrap failed: ${String(e?.message || e)}`);
    }
    return false;
  }
}

export async function confirmSig(sig, { commitment = "confirmed", timeoutMs = 12000, pollMs = 700, requireFinalized = false } = {}) {
  return _confirmSigImpl(sig, {
    commitment,
    timeoutMs,
    pollMs,
    requireFinalized,
    searchTransactionHistory: true,
  });
}

const _confirmSigImpl = createConfirmSig({
  getConn,
  markRpcStress: _markRpcStress,
  defaultCommitment: "confirmed",
  defaultTimeoutMs: 12_000,
  throwOnTimeout: false,
});

async function waitForTokenDebit(ownerPubkeyStr, mintStr, prevSizeUi, { timeoutMs = 20000, pollMs = 350 } = {}) {
	return await _getDex().waitForTokenDebit(ownerPubkeyStr, mintStr, prevSizeUi, { timeoutMs, pollMs });
}

async function waitForTokenCredit(ownerPubkeyStr, mintStr, { timeoutMs = 8000, pollMs = 300 } = {}) {
	return await _getDex().waitForTokenCredit(ownerPubkeyStr, mintStr, { timeoutMs, pollMs });
}

// async function getFeeAta(mintStr) {
//   const feeRecv = await getFeeReceiver();
//   if (!feeRecv) return null;
//   const { PublicKey } = await loadWeb3();
//   const { getAssociatedTokenAddress } = await loadSplToken();
//   try {
//     const mint = new PublicKey(mintStr);
//     const owner = new PublicKey(feeRecv);
//     return await getAssociatedTokenAddress(mint, owner, true);
//   } catch { return null; }
// }

// async function resolveExistingFeeAta(mintStr) {
//   const ata = await getFeeAta(mintStr);
//   if (!ata) return null;
//   try {
//     const conn = await getConn();
//     const ai = await conn.getAccountInfo(ata, "processed");
//     return ai ? ata.toBase58() : null;
//   } catch { return null; }
// }

export async function getMintDecimals(mintStr) {
  return _getDex().getMintDecimals(mintStr);
}

export function currentRpcUrl() {
  return String(state.rpcUrl || localStorage.getItem("fdv_rpc_url") || "").trim();
}

export function currentRpcHeaders() {
  try {
    const fromState = state.rpcHeaders && typeof state.rpcHeaders === "object" ? state.rpcHeaders : null;
    if (fromState) return fromState;
    const raw = localStorage.getItem("fdv_rpc_headers") || "{}";
    const obj = JSON.parse(raw);
    return obj && typeof obj === "object" ? obj : {};
  } catch { return {}; }
}

function setRpcUrl(url) {
  state.rpcUrl = String(url || "").trim();
  try { localStorage.setItem("fdv_rpc_url", state.rpcUrl); } catch {}
  _resetConn();
  save();
  log(`RPC URL set to: ${state.rpcUrl || "(empty)"}`);
}

function setRpcHeaders(jsonStr) {
  try {
    const obj = JSON.parse(String(jsonStr || "{}"));
    if (obj && typeof obj === "object") {
      state.rpcHeaders = obj;
      localStorage.setItem("fdv_rpc_headers", JSON.stringify(obj));
      _resetConn();
      save();
      log(`RPC headers saved: ${redactHeaders(obj)}`);
      return true;
    }
  } catch {}
  log("Invalid RPC headers JSON.");
  return false;
}

const { loadWeb3: _loadWeb3Browser, loadBs58: _loadBs58Browser } = createSolanaDepsLoader({
  cacheKeyPrefix: "fdv:trader",
  web3Version: "1.95.1",
  bs58Version: "5.0.0",
  prefer: "esm",
});

let _web3NodePromise;
let _bs58NodePromise;

function _resetConn() {
  _getConnImpl = null;
  _lastConnLogKey = "";
}

export async function loadWeb3() {
  if (_isNodeLike()) {
    if (_web3NodePromise) return _web3NodePromise;
    _web3NodePromise = (async () => {
      const { loadSolanaWeb3FromWeb } = await import("./cli/helpers/web3.node.js");
      return await loadSolanaWeb3FromWeb();
    })();
    const web3 = await _web3NodePromise;
    try {
      const g = (typeof window !== "undefined") ? window : globalThis;
      g.solanaWeb3 = web3;
    } catch {}
    return web3;
  }

  return await _loadWeb3Browser();
}

export async function loadBs58() {
  if (_isNodeLike()) {
    if (_bs58NodePromise) return _bs58NodePromise;
    _bs58NodePromise = (async () => {
      const mod = await import("./cli/helpers/bs58.node.js");
      return mod?.default || mod?.bs58 || mod;
    })();
    const bs58 = await _bs58NodePromise;
    try {
      const g = (typeof window !== "undefined") ? window : globalThis;
      g.bs58 = bs58;
    } catch {}
    return bs58;
  }

  return await _loadBs58Browser();
}

async function loadDeps() {
  const web3 = await loadWeb3();
  const bs58 = await loadBs58();
  return { ...web3, bs58: { default: bs58 } };
}

export async function getConn() {
  if (!_getConnImpl) {
    _getConnImpl = createConnectionGetter({
      loadWeb3,
      getRpcUrl: () => currentRpcUrl().replace(/\/+$/g, ""),
      getRpcHeaders: currentRpcHeaders,
      commitment: "confirmed",
    });
  }
  const url = currentRpcUrl().replace(/\/+$/g, "");
  const headers = currentRpcHeaders();
  const hdrKey = JSON.stringify(headers || {});
  const key = `${url}|${hdrKey}`;
  const conn = await _getConnImpl();
  if (key && key !== _lastConnLogKey) {
    _lastConnLogKey = key;
    log(`RPC connection ready -> ${url} ${redactHeaders(headers)}`, 'info');
  }
  return conn;
}

async function _getMultipleAccountsInfoBatched(conn, pubkeys, { commitment = "processed", batchSize = 95, kind = "gmai" } = {}) {
  const out = [];
  for (let i = 0; i < pubkeys.length; i += batchSize) {
    const slice = pubkeys.slice(i, i + batchSize);
    try {
      await rpcWait?.(kind, 350);
      const arr = await conn.getMultipleAccountsInfo(slice, commitment).catch(e => { _markRpcStress?.(e, 2000); return new Array(slice.length).fill(null); });
      out.push(...(arr || new Array(slice.length).fill(null)));
    } catch (e) {
      _markRpcStress?.(e, 2000);
      out.push(...new Array(slice.length).fill(null));
    }
  }
  return out;
}

function _readSplAmountFromRaw(rawU8) {
  if (!rawU8 || rawU8.length < 72) return null;
  try {
    const view = new DataView(rawU8.buffer, rawU8.byteOffset, rawU8.byteLength);
    return view.getBigUint64(64, true); // le u64 at offset 64
  } catch {
    let x = 0n;
    for (let i = 0; i < 8; i++) x |= BigInt(rawU8[64 + i] || 0) << (8n * BigInt(i));
    return x;
  }
}

export async function fetchSolBalance(pubkeyStr) {
  if (!pubkeyStr) return 0;
  const { PublicKey } = await loadWeb3();
  const url = currentRpcUrl();
  if (!url) return 0;
  let lamports = 0;
  try {
    await rpcWait("sol-balance", 400);
    log(`Fetching SOL balance for ${pubkeyStr.slice(0,4)}…`);
    const conn = await getConn();
    lamports = await conn.getBalance(new PublicKey(pubkeyStr));
  } catch (e) {
    _markRpcStress(e, 2000);
    log(`Balance fetch failed: ${e.message || e}`);
    lamports = 0;
  }
  const sol = lamports / 1e9;
  log(`Balance: ${sol.toFixed(6)} SOL`, 'info');
  try {
    window._fdvLastSolBal = sol;
    window._fdvLastSolBalPub = String(pubkeyStr || "");
    window._fdvLastSolBalAt = Date.now();
    window._fdvFetchSolBalance = fetchSolBalance;
    updateStatsHeader();
  } catch {}
  return sol;
}

function setRouterHold(mint, ms = ROUTER_COOLDOWN_MS) {
  if (!mint) return;
  if (!window._fdvRouterHold) window._fdvRouterHold = new Map();
  const until = now() + Math.max(5_000, ms|0);
  window._fdvRouterHold.set(mint, until);
  try { log(`Router cooldown set for ${mint.slice(0,4)}… until ${new Date(until).toLocaleTimeString()}`); } catch {}
}

async function getSolUsd() {
  const t = Date.now();
  if (_solPxCache.usd > 0 && (t - _solPxCache.ts) < 60_000) return _solPxCache.usd;
  try {
    const res = await fetch("https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd", { headers: { accept: "application/json" }});
    const j = await res.json();
    const px = Number(j?.solana?.usd || 0); // does it right here.
    if (Number.isFinite(px) && px > 0) {
      _solPxCache = { ts: t, usd: px };
      return px;
    }
  } catch {}
  return _solPxCache.usd || 0;
}

async function getComputeBudgetConfig() {
  try {
    const cuLimit = Number(state.computeUnitLimit || 1_400_000);
    const cuPriceMicroLamports = Number(state.priorityMicroLamports || 10_000); // ~0.01 lamports/CU
    return {
      cuLimit: Number.isFinite(cuLimit) ? cuLimit : 1_400_000,
      cuPriceMicroLamports: Number.isFinite(cuPriceMicroLamports) ? cuPriceMicroLamports : 10_000,
    };
  } catch {
    return { cuLimit: 1_400_000, cuPriceMicroLamports: 10_000 };
  }
}

async function buildComputeBudgetIxs() {
  try {
    const { ComputeBudgetProgram } = await loadWeb3();
    const { cuLimit, cuPriceMicroLamports } = await getComputeBudgetConfig();
    const ixs = [];
    if (cuLimit > 0) ixs.push(ComputeBudgetProgram.setComputeUnitLimit({ units: cuLimit }));
    if (cuPriceMicroLamports > 0) ixs.push(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: cuPriceMicroLamports }));
    return ixs;
  } catch { return []; }
}

function hasComputeBudgetIx(ixs) {
  try {
    const pidStr = "ComputeBudget111111111111111111111111111111";
    return (ixs || []).some(ix => {
      const p = ix?.programId;
      const s = typeof p?.toBase58 === "function" ? p.toBase58() : (p?.toString?.() || String(p || ""));
      return s === pidStr;
    });
  } catch { return false; }
}

function dedupeComputeBudgetIxs(ixs = []) {
  try {
    const pidStr = "ComputeBudget111111111111111111111111111111";
    const seen = new Set(); // 'cb:2' / 'cb:3'
    const out = [];
    // Walk from end to keep the last one
    for (let i = ixs.length - 1; i >= 0; i--) {
      const ix = ixs[i];
      const p = ix?.programId;
      const s = typeof p?.toBase58 === "function" ? p.toBase58() : (p?.toString?.() || String(p || ""));
      if (s !== pidStr) { out.push(ix); continue; }
      // ComputeBudget: first byte of data is the tag
      const data = ix?.data instanceof Uint8Array ? ix.data : new Uint8Array();
      const tag = data.length > 0 ? data[0] : -1;
      if (tag === 2 || tag === 3) {
        const key = `cb:${tag}`;
        if (seen.has(key)) {
          continue;
        }
        seen.add(key);
        out.push(ix);
      } else {
        // keep other CB instructions (e.g., heap frame) as-is
        out.push(ix);
      }
    }
    // We traversed backwards; restore original order
    out.reverse();
    return out;
  } catch {
    return Array.isArray(ixs) ? ixs : [];
  }
}

async function computeSpendCeiling(ownerPubkeyStr, { solBalHint } = {}) {
  const solBal = Number.isFinite(solBalHint) ? solBalHint : await fetchSolBalance(ownerPubkeyStr);
  const solLamports = Math.floor(solBal * 1e9);

  const baseReserveLamports = Math.max(
    Math.floor(FEE_RESERVE_MIN * 1e9),
    Math.floor(solLamports * FEE_RESERVE_PCT)
  );

  const posCount = Object.entries(state.positions || {})
    .filter(([m, p]) => m !== SOL_MINT && Number(p?.sizeUi || 0) > 0).length;

  const sellResLamports = posCount * (SELL_TX_FEE_BUFFER_LAMPORTS + EXTRA_TX_BUFFER_LAMPORTS);

  const minRunwayLamports = Math.floor(MIN_OPERATING_SOL * 1e9);

  const totalResLamports = Math.max(minRunwayLamports, baseReserveLamports + sellResLamports);

  const spendableLamports = Math.max(0, solLamports - totalResLamports);

  const spendableSol = spendableLamports / 1e9;

  return {
    spendableSol,
    reserves: {
      solBal,
      baseReserveLamports,
      sellResLamports,
      minRunwayLamports,
      totalResLamports,
      posCount,
    }
  };
}

function updateFastExitState(pos, pxNow, alpha, nowTs) {
  try {
    if (!Number.isFinite(pos.fastPeakPx) || pxNow > pos.fastPeakPx) {
      pos.fastPeakPx = pxNow;
      pos.fastPeakAt = nowTs;
    }
    if (!Number.isFinite(pos.fastAccelPeak) || alpha.accelRatio > pos.fastAccelPeak) {
      pos.fastAccelPeak = alpha.accelRatio;
    }
    // Set backside once momentum AND score slope turn negative together
    if (!pos.fastBackside && alpha.chgSlope < 0 && alpha.scSlope < 0) {
      pos.fastBackside = true;
      pos.fastBacksideAt = nowTs;
    }
  } catch {}
}

function computeFastHardStopThreshold(mint, pos, { nowTs } = {}) {
  try {

    const { intensity, tier, chgSlope, scSlope } = computeFinalGateIntensity(mint);

    let thr = 2.6;

    if (tier === "explosive") thr = 2.2;

    else if (tier === "weak") thr = 3.0;

    if (chgSlope < 0 || scSlope < 0 || pos.fastBackside) thr -= 0.2;

    if (intensity >= 1.8) thr += 0.1;

    return Math.max(2.0, Math.min(3.2, thr));

  } catch {
    return 2.6; // Best default teste
  }
}

function checkFastExitTriggers(mint, pos, { pnlPct, pxNow, nowTs }) {
  try {
    if (!state.fastExitEnabled) return { action: "none" };

    const alpha = computeFastAlphaMetrics(mint);
    updateFastExitState(pos, pxNow, alpha, nowTs);

    const armed = Number.isFinite(pnlPct) && pnlPct >= Math.max(0, state.fastTrailArmPct);
    if (armed && Number.isFinite(pos.fastPeakPx) && pos.fastPeakPx > 0) {
      const dropPct = pos.fastPeakPx > 0 ? ((pos.fastPeakPx - pxNow) / pos.fastPeakPx) * 100 : 0;
      if (dropPct >= Math.max(1, state.fastTrailPct)) {
        return { action: "sell_all", reason: `FAST_TRAIL -${dropPct.toFixed(2)}%` };
      }
    }

    const stage = Number(pos.fastTpStage || 0);
    if (Number.isFinite(pnlPct)) {
      if (stage < 1 && pnlPct >= state.fastTp1Pct) {
        pos.fastTpStage = 1;
        return { action: "sell_partial", pct: Math.min(100, Math.max(1, state.fastTp1SellPct)), reason: `FAST_TP1 ${pnlPct.toFixed(2)}%` };
      }
      if (stage < 2 && pnlPct >= state.fastTp2Pct) {
        pos.fastTpStage = 2;
        return { action: "sell_partial", pct: Math.min(100, Math.max(1, state.fastTp2SellPct)), reason: `FAST_TP2 ${pnlPct.toFixed(2)}%` };
      }
    }

    const peakAgeMs = nowTs - Number(pos.fastPeakAt || pos.lastBuyAt || pos.acquiredAt || 0);
    const noHighTimeoutMs = Math.max(20_000, Number(state.fastNoHighTimeoutSec || 90) * 1000);
    if (peakAgeMs >= noHighTimeoutMs && Number.isFinite(pnlPct) && pnlPct > 0) {
      return { action: "sell_partial", pct: 50, reason: "FAST_TIME_STOP" };
    }

    if (alpha.chgSlope <= Math.min(-0.5, state.fastAlphaChgSlope) &&
        alpha.scSlope  <= Math.min(-1, state.fastAlphaScSlope)) {
      return { action: "sell_all", reason: `FAST_ALPHA_DECAY dP=${alpha.chgSlope.toFixed(2)}/m dS=${alpha.scSlope.toFixed(2)}/m` };
    }

    if (!alpha.risingNow && !alpha.trendUp) {
      return { action: "sell_all", reason: "FAST_TREND_FLIP" };
    }

    const accelPeak = Number(pos.fastAccelPeak || 0);
    if (accelPeak > 0 && alpha.accelRatio / accelPeak <= Math.max(0.1, state.fastAccelDropFrac) && alpha.zV1 <= Math.max(0, state.fastAlphaZV1Floor)) {
      return { action: "sell_partial", pct: 50, reason: "FAST_ACCEL_DROP" };
    }

    return { action: "none" };
  } catch {
    return { action: "none" };
  }
}

function computeDynamicHardStopPct(mint, pos, nowTs = now(), ctx = {}) {
  try {
    const base = DYN_HS.base;
    const lo = Math.max(1, DYN_HS.min);
    const hi = Math.max(lo, DYN_HS.max);

    const series = getLeaderSeries(mint, 3) || [];
    const last = series.length ? series[series.length - 1] : {};
    const liq = Number(last.liqUsd || 0);
    const v1h = Number(last.v1h || 0);
    const chgSlope = _clamp(slope3pm(series, "chg5m"), -60, 60);
    const scSlope  = _clamp(slope3pm(series, "pumpScore"), -20, 20);

    let thr = base;
    if (liq >= 30000) thr += 1.0;
    else if (liq >= 15000) thr += 0.5;
    else if (liq < 2500) thr -= 1.0;
    else if (liq < 5000) thr -= 0.5;

    if (v1h >= 3000) thr += 0.5;
    else if (v1h < 600) thr -= 0.25;

    const rising = chgSlope > 0 && scSlope > 0;
    const backside = chgSlope < 0 && scSlope < 0;
    if (rising) thr += 0.5;
    if (backside) thr -= 0.5;

    const ageSec = (nowTs - Number(pos.lastBuyAt || pos.acquiredAt || 0)) / 1000;
    const remorseSecs = Math.max(5, DYN_HS.remorseSecs);
    if (ageSec <= remorseSecs) thr -= 0.5;

    const pnlNetPct = Number(ctx.pnlNetPct);
    const ddPct     = Math.max(0, Number(ctx.drawdownPct || 0));
    const intensity = Number.isFinite(ctx.intensity) ? ctx.intensity : computeFinalGateIntensity(mint).intensity;

    const ds = pos._dynStop || {};
    if (Number.isFinite(pnlNetPct)) {
      ds.peakPnl  = Number.isFinite(ds.peakPnl)  ? Math.max(ds.peakPnl,  pnlNetPct) : pnlNetPct;
      ds.worstPnl = Number.isFinite(ds.worstPnl) ? Math.min(ds.worstPnl, pnlNetPct) : pnlNetPct;
    }

    let widen = 0;
    if (Number.isFinite(ds.peakPnl) && ds.peakPnl > 0) {
      widen += Math.min(1.5, 0.2 + Math.log1p(ds.peakPnl / 10) * 0.6);
    }
    if (intensity > 1.4) widen += 0.6;
    else if (intensity < 0.9) widen -= 0.4;

    let tighten = 0;
    if (ddPct > 0) tighten += Math.min(2.0, ddPct * 0.35);
    if (Number.isFinite(pnlNetPct) && pnlNetPct < 0) {
      tighten += Math.min(1.0, (-pnlNetPct) * 0.08);
    }

    let dyn = thr + widen - tighten;
    dyn = Math.min(hi, Math.max(lo, dyn));

    const prev = Number(ds.current);
    const alpha = 0.35;
    const current = Number.isFinite(prev) ? (prev + alpha * (dyn - prev)) : dyn;

    pos._dynStop = { current, lastAt: nowTs, peakPnl: ds.peakPnl, worstPnl: ds.worstPnl };
    return current;
  } catch {
    return Math.min(DYN_HS.max, Math.max(DYN_HS.min, DYN_HS.base));
  }
}

async function isValidPubkeyStr(s) {
  const key = String(s || "").trim();
  if (!key) return false;
  if (_pkValidCache.has(key)) return _pkValidCache.get(key);
  let ok = false;
  try {
    const { PublicKey } = await loadWeb3();
    new PublicKey(key);
    ok = true;
  } catch {}
  _pkValidCache.set(key, ok);
  return ok;
}

export async function getAutoKeypair() {
  const { Keypair, bs58 } = await loadDeps();
  if (!state.autoWalletSecret) return null;
  try {
    const sk = bs58.default.decode(state.autoWalletSecret);
    return Keypair.fromSecretKey(Uint8Array.from(sk));
  } catch { return null; }
}

async function _generateAutoWalletKeypair() {
  const { Keypair, bs58 } = await loadDeps();
  const kp = Keypair.generate();
  return {
    kp,
    publicKey: kp.publicKey.toBase58(),
    secretKey: bs58.default.encode(kp.secretKey),
  };
}

function _migrateOwnerCaches(oldOwner, newOwner) {
  try {
    if (!oldOwner || !newOwner || oldOwner === newOwner) return;
    const oldPos = cacheToList(oldOwner) || [];
    for (const it of oldPos) {
      try {
        updatePosCache(newOwner, it.mint, it.sizeUi, it.decimals);
      } catch {}
    }
    for (const it of oldPos) {
      try { removeFromPosCache(oldOwner, it.mint); } catch {}
    }

    const oldDust = dustCacheToList(oldOwner) || [];
    for (const it of oldDust) {
      try {
        addToDustCache(newOwner, it.mint, it.sizeUi, it.decimals);
      } catch {}
    }
    for (const it of oldDust) {
      try { removeFromDustCache(oldOwner, it.mint); } catch {}
    }
  } catch {}
}

async function _sendSignedTx(conn, tx, signers, { commitment = "processed", confirmCommitment = "confirmed", confirmTimeoutMs = 25_000 } = {}) {
  tx.recentBlockhash = (await conn.getLatestBlockhash(commitment)).blockhash;
  tx.sign(...(signers || []));
  const sig = await conn.sendRawTransaction(tx.serialize(), { preflightCommitment: commitment, maxRetries: 2 });
  try { await confirmSig(sig, { commitment: confirmCommitment, timeoutMs: confirmTimeoutMs }); } catch {}
  return sig;
}

async function _migrateWalletFunds({ fromSigner, toSigner }) {
  const { PublicKey, SystemProgram, Transaction } = await loadWeb3();
  const { TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, getAssociatedTokenAddress, createAssociatedTokenAccountInstruction, createTransferCheckedInstruction } = await loadSplToken();
  const conn = await getConn();

  const fromPk = fromSigner.publicKey instanceof PublicKey ? fromSigner.publicKey : new PublicKey(fromSigner.publicKey.toBase58());
  const toPk = toSigner.publicKey instanceof PublicKey ? toSigner.publicKey : new PublicKey(toSigner.publicKey.toBase58());
  const fromOwner = fromPk.toBase58();
  const toOwner = toPk.toBase58();

  // Unwrap any WSOL first so SOL can be moved cleanly.
  try { await unwrapWsolIfAny(fromSigner); } catch {}

  // Seed the destination so it can be the fee payer for follow-on txs.
  try {
    const fromLamports = await conn.getBalance(fromPk, "processed").catch(() => 0);
    const seed = Math.min(
      Number(fromLamports || 0),
      Math.max(
        0,
        (EDGE_TX_FEE_ESTIMATE_LAMPORTS * 6) + (TX_FEE_BUFFER_LAMPORTS * 2)
      )
    );
    if (seed > 0 && (fromLamports - seed) > EDGE_TX_FEE_ESTIMATE_LAMPORTS) {
      const tx = new Transaction().add(SystemProgram.transfer({ fromPubkey: fromPk, toPubkey: toPk, lamports: Math.floor(seed) }));
      tx.feePayer = fromPk;
      const sig = await _sendSignedTx(conn, tx, [fromSigner], { confirmTimeoutMs: 20_000 });
      log(`Wallet rotate: fee seed sent (${(seed / 1e9).toFixed(6)} SOL) :: ${sig}`);
    }
  } catch (e) {
    log(`Wallet rotate: fee seed skipped (${e?.message || e})`, "warn");
  }

  let toLamportsNow = 0;
  try { toLamportsNow = await conn.getBalance(toPk, "processed").catch(() => 0); } catch {}
  const toCanPayFees = () => Number(toLamportsNow || 0) > Math.max(EDGE_TX_FEE_ESTIMATE_LAMPORTS * 3, TX_FEE_BUFFER_LAMPORTS);

  async function listTokenAccounts(programId) {
    try {
      const res = await conn.getParsedTokenAccountsByOwner(fromPk, { programId }, "confirmed");
      const items = res?.value || [];
      return items.map((v) => {
        try {
          const pkStr = v?.pubkey?.toBase58 ? v.pubkey.toBase58() : String(v?.pubkey || "");
          const info = v?.account?.data?.parsed?.info || {};
          const mint = String(info?.mint || "");
          const t = info?.tokenAmount || {};
          const amountRaw = BigInt(String(t?.amount || "0"));
          const decimals = Number(t?.decimals ?? 0);
          const hasDelegate = !!info?.delegate;
          const delegatedRaw = BigInt(String(info?.delegatedAmount?.amount || "0"));
          return {
            pubkeyStr: pkStr,
            mint,
            amountRaw,
            decimals,
            programId,
            hasDelegate,
            delegatedRaw,
          };
        } catch {
          return null;
        }
      }).filter(Boolean);
    } catch (e) {
      _markRpcStress(e, 1500);
      return [];
    }
  }

  const progs = [TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID].filter(Boolean);
  const tokenAccts = [];
  for (const pid of progs) {
    const list = await listTokenAccounts(pid);
    for (const it of list) {
      if (!it?.mint) continue;
      if (it.amountRaw <= 0n) continue;
      tokenAccts.push(it);
    }
  }

  // Transfer all SPL balances into destination ATAs.
  for (const it of tokenAccts) {
    const mintStr = it.mint;
    try {
      const mintPk = new PublicKey(mintStr);
      const srcPk = new PublicKey(it.pubkeyStr);
      const dstAtaAny = await getAssociatedTokenAddress(mintPk, toPk, true, it.programId);
      const dstAta = typeof dstAtaAny === "string" ? new PublicKey(dstAtaAny) : dstAtaAny;

      const useToAsFeePayer = toCanPayFees();
      const feePayerPk = useToAsFeePayer ? toPk : fromPk;

      const ixs = [];
      // Create destination ATA if missing.
      try {
        const ai = await conn.getAccountInfo(dstAta, "processed").catch(() => null);
        if (!ai) {
          if (typeof createAssociatedTokenAccountInstruction === "function") {
            ixs.push(createAssociatedTokenAccountInstruction(feePayerPk, dstAta, toPk, mintPk, it.programId));
          }
        }
      } catch {}

      // Safety: if there's an active delegate, transfer can still work, but closing later could be messy.
      if (it.hasDelegate && it.delegatedRaw > 0n) {
        log(`Wallet rotate: delegated token account detected; transferring anyway (${mintStr.slice(0, 4)}…)`, "warn");
      }

      if (typeof createTransferCheckedInstruction !== "function") {
        throw new Error("spl-token transfer helper missing");
      }
      ixs.push(createTransferCheckedInstruction(srcPk, mintPk, dstAta, fromPk, it.amountRaw, it.decimals, [], it.programId));

      const tx = new Transaction();
      for (const ix of ixs) tx.add(ix);

      tx.feePayer = feePayerPk;
      const sig = await _sendSignedTx(
        conn,
        tx,
        useToAsFeePayer ? [toSigner, fromSigner] : [fromSigner],
        { confirmTimeoutMs: 30_000 }
      );
      log(`Wallet rotate: moved ${mintStr.slice(0, 4)}… (${it.amountRaw.toString()} raw) :: ${sig}`);

      // Refresh cached destination balance after each mint so we can switch fee payer once it’s funded.
      if (!useToAsFeePayer) {
        try { toLamportsNow = await conn.getBalance(toPk, "processed").catch(() => toLamportsNow); } catch {}
      }
    } catch (e) {
      log(`Wallet rotate: token move failed (${String(mintStr || "").slice(0, 6)}…): ${e?.message || e}`, "warn");
    }
  }

  // Drain remaining SOL (fee paid by destination wallet).
  try {
    await rpcWait("wallet-rotate-sol", 250);
    const fromLamportsNow = await conn.getBalance(fromPk, "processed").catch(() => 0);
    const total = Math.max(0, Math.floor(Number(fromLamportsNow || 0)));
    if (total > 0) {
      const canTo = toCanPayFees();
      const keep = Math.max(EDGE_TX_FEE_ESTIMATE_LAMPORTS * 2, TX_FEE_BUFFER_LAMPORTS);
      const lamportsToSend = canTo ? total : Math.max(0, total - keep);
      if (lamportsToSend > 0) {
        const tx = new Transaction().add(SystemProgram.transfer({ fromPubkey: fromPk, toPubkey: toPk, lamports: lamportsToSend }));
        tx.feePayer = canTo ? toPk : fromPk;
        const sig = await _sendSignedTx(conn, tx, canTo ? [toSigner, fromSigner] : [fromSigner], { confirmTimeoutMs: 25_000 });
        log(`Wallet rotate: drained SOL ${(lamportsToSend / 1e9).toFixed(6)} :: ${sig}`);
      }
    }
  } catch (e) {
    log(`Wallet rotate: SOL drain failed: ${e?.message || e}`, "warn");
  }

  // Best-effort: keep derived caches consistent for future sync.
  try {
    // If any positions are tracked in state, keep the cache aligned for the new owner.
    for (const mint of Object.keys(state.positions || {})) {
      if (!mint || mint === SOL_MINT) continue;
      const pos = state.positions[mint];
      const sz = Number(pos?.sizeUi || 0);
      const dec = Number.isFinite(pos?.decimals) ? pos.decimals : 6;
      if (sz > 0) updatePosCache(toOwner, mint, sz, dec);
    }
  } catch {}

  return { ok: true, fromOwner, toOwner };
}

async function ensureAutoWallet() {
  if (state.autoWalletPub && state.autoWalletSecret) {
    try { _startLedgerReporting(); } catch {}
    return state.autoWalletPub;
  }
  const gen = await _generateAutoWalletKeypair();
  state.autoWalletPub = gen.publicKey;
  state.autoWalletSecret = gen.secretKey;
  save();

  // Best-effort: publish this wallet to the public FDV ledger.
  try {
    const { bs58 } = await loadDeps();
    await registerFdvWallet({ pubkey: state.autoWalletPub, keypair: gen.kp, bs58 });
  } catch {}
  try { _startLedgerReporting(); } catch {}
  return state.autoWalletPub;
}

function estimateProportionalCostSolForSell(mint, amountUi) {
  try {
    const pos = state.positions?.[mint];
    const sz = Number(pos?.sizeUi || 0);
    const cost = Number(pos?.costSol || 0);
    if (sz > 0 && amountUi > 0) return (cost * (amountUi / sz));
  } catch {}
  return null; // unknown cost => no fee
}

export async function jupFetch(path, opts) {
  return _getDex().jupFetch(path, opts);
}

export async function quoteGeneric(inputMint, outputMint, amountRaw, slippageBps) {
  return _getDex().quoteGeneric(inputMint, outputMint, amountRaw, slippageBps);
}

async function quoteOutSol(inputMint, amountUi, inDecimals) {
  if (!Number.isFinite(amountUi) || amountUi <= 0) {
    log("Valuation skip: zero size.");
    return 0;
  }
  try {
    const ok = await isValidPubkeyStr(inputMint);
    if (!ok) {
      log("Valuation skip: invalid mint.");
      return 0;
    }
  } catch {
    return 0;
  }

  const dec = Number.isFinite(inDecimals) ? inDecimals : await getMintDecimals(inputMint);
  const raw = Math.max(1, Math.floor(amountUi * Math.pow(10, dec)));
  if (raw < MIN_QUOTE_RAW_AMOUNT) {
    log(`Valuation skip: amount below minimum quote size (${MIN_QUOTE_RAW_AMOUNT} raw).`);
    return 0;
  }
  const slip = Math.max(150, Number(state.slippageBps || 150) | 0);
  const base = await getJupBase();
  const isLite = /lite-api\.jup\.ag/i.test(base);

  async function tryQuote(restrictIntermediates) {
    const q = new URL("/swap/v1/quote", "https://fdv.lol");
    q.searchParams.set("inputMint", inputMint);
    q.searchParams.set("outputMint", SOL_MINT);
    q.searchParams.set("amount", String(raw));
    q.searchParams.set("slippageBps", String(slip));
    q.searchParams.set("restrictIntermediateTokens", String(isLite ? true : restrictIntermediates));
    logObj("Valuation quote params", { inputMint, amountUi, dec, slippageBps: slip });
    const res = await jupFetch(q.pathname + q.search);
    if (res.ok) {
      const data = await res.json();
      const outRaw = Number(data?.outAmount || 0);
      log(`Valuation: ~${(outRaw/1e9).toFixed(6)} SOL`);
      return outRaw > 0 ? outRaw / 1e9 : 0;
    } else {
      const errTxt = await res.text().catch(() => "");
      log(`Quote 400 body: ${errTxt || "(empty)"}`);
      throw new Error(`quote ${res.status}`);
    }
  }

  try {
    return await tryQuote(true);
  } catch {
      if (!isLite) {
        try { return await tryQuote(false); } catch {}
      }
      return 0;
  }
}

const estimateRoundtripEdgePct = createRoundtripEdgeEstimator({
  solMint: SOL_MINT,
  quoteGeneric: async (...args) => await quoteGeneric(...args),
  requiredAtaLamportsForSwap: async (...args) => await requiredAtaLamportsForSwap(...args),
  platformFeeBps: Number(FDV_PLATFORM_FEE_BPS || 0),
  txFeeEstimateLamports: EDGE_TX_FEE_ESTIMATE_LAMPORTS,
  smallSellFeeFloorSol: SMALL_SELL_FEE_FLOOR,
  log: (...args) => log(...args),
  logObj: (...args) => logObj(...args),
});

async function executeSwapWithConfirm(opts, { retries = 2, confirmMs = 15000 } = {}) {
  try {
    const isBuy = opts && opts.inputMint === SOL_MINT && opts.outputMint && opts.outputMint !== SOL_MINT;
    const minConfirmMs = isBuy ? 32000 : 15000; // buys often need longer to reach confirmed
    const effConfirmMs = Math.max(Number(confirmMs || 0), minConfirmMs);
    return _getDex().executeSwapWithConfirm(opts, { retries, confirmMs: effConfirmMs });
  } catch {
    return _getDex().executeSwapWithConfirm(opts, { retries, confirmMs });
  }
}

async function sweepAllToSolAndReturn() {
  const { PublicKey, SystemProgram, Transaction } = await loadWeb3();
  const signer = await getAutoKeypair();
  if (!signer) throw new Error("auto wallet not ready");
  if (!state.recipientPub) throw new Error("recipient missing");
  log("Unwind: selling SPL positions and returning SOL…");

  const conn = await getConn();
  const owner = signer.publicKey.toBase58();

  const queue = [];
  const seen = new Set();

  if (state.dustExitEnabled) {
    try {
      const dust = dustCacheToList(owner) || [];
      for (const it of dust) {
        if (it?.mint && it.mint !== SOL_MINT && !seen.has(it.mint)) {
          queue.push({ ...it, from: "dust" });
          seen.add(it.mint);
        }
      }
    } catch {}
  }

  try {
    const cached = cacheToList(owner) || [];
    for (const it of cached) {
      if (it?.mint && it.mint !== SOL_MINT && !seen.has(it.mint)) {
        queue.push({ ...it, from: "cache" });
        seen.add(it.mint);
      }
    }
  } catch {}

  for (const m of Object.keys(state.positions || {})) {
    if (m && m !== SOL_MINT && !seen.has(m)) {
      queue.push({
        mint: m,
        sizeUi: Number(state.positions[m]?.sizeUi || 0),
        decimals: Number.isFinite(state.positions[m]?.decimals) ? state.positions[m].decimals : 6,
        from: "state",
      });
      seen.add(m);
    }
  }

  for (const item of queue) {
    const mint = item.mint;
    try {
      const b = await getAtaBalanceUi(owner, mint, item.decimals);
      const uiAmt = Number(b.sizeUi || 0);
      const dec = Number.isFinite(b.decimals) ? b.decimals : (item.decimals ?? state.positions[mint]?.decimals ?? 6);

      if (uiAmt <= 0) {
        // Cleanup zero balances from caches
        removeFromPosCache(owner, mint);
        if (item.from === "dust") removeFromDustCache(owner, mint);
        if (state.positions[mint]) { delete state.positions[mint]; save(); }
        continue;
      }

      let estSol = 0;
      try { estSol = await quoteOutSol(mint, uiAmt, dec); } catch {}

      const res = await _getDex().sellWithConfirm(
        { signer, mint, amountUi: uiAmt, slippageBps: state.slippageBps },
        { retries: 2, confirmMs: 15000, closeWsolAta: false },
      );

      try { _noteDexTx("sell", mint, res, { amountUi: uiAmt, slippageBps: state.slippageBps }); } catch {}

      if (!res.ok) {
        log(`Sell fail ${mint.slice(0,4)}…: route execution failed`);
        continue;
      }

      // Wait for debit to handle partials
      let remainUi = 0;
      try {
        const debit = await waitForTokenDebit(owner, mint, uiAmt);
        remainUi = Number(debit.remainUi || 0);
      } catch {
        // If debit watcher not available, best-effort balance fetch
        try {
          const bb = await getAtaBalanceUi(owner, mint, dec);
          remainUi = Number(bb.sizeUi || 0);
        } catch {}
      }

      if (remainUi > 1e-9) {
        log(`Unwind sold partially; remain ${remainUi.toFixed(6)} ${mint.slice(0,4)}…`);
        // Update state and cache for remainder
        if (state.positions[mint]) {
          const frac = Math.min(1, Math.max(0, remainUi / Math.max(1e-9, uiAmt)));
          state.positions[mint].sizeUi = remainUi;
          state.positions[mint].costSol = Number(state.positions[mint].costSol || 0) * frac;
          state.positions[mint].hwmSol  = Number(state.positions[mint].hwmSol  || 0) * frac;
          save();
        }
        updatePosCache(owner, mint, remainUi, dec);
        // Keep dust entry if it came from dust cache; otherwise it remains in positions/cache
        continue;
      }
      // Full exit: try closing now-empty token ATA(s) to reclaim rent.
      try { await closeEmptyTokenAtas(signer, mint); } catch {}

      log(`Sold ${uiAmt.toFixed(6)} ${mint.slice(0,4)}… -> ~${estSol.toFixed(6)} SOL`);
      const costSold = Number(state.positions[mint]?.costSol || 0);
      await _addRealizedPnl(estSol, costSold, "Unwind PnL");
      if (state.positions[mint]) { delete state.positions[mint]; save(); }
      removeFromPosCache(owner, mint);
      if (item.from === "dust") removeFromDustCache(owner, mint);
    } catch (e) {
      log(`Sell fail ${mint.slice(0,4)}…: ${e.message||e}`);
    }
  }

  // Return SOL to recipient
  try { await unwrapWsolIfAny(signer); } catch {}
  try { await closeAllEmptyAtas(signer); } catch {}
  const bal = await conn.getBalance(signer.publicKey).catch(()=>0);
  const rent = 0.001 * 1e9;
  const sendLamports = Math.max(0, bal - Math.ceil(rent));
  if (sendLamports > 0) {
    const tx = new Transaction().add(
      SystemProgram.transfer({
        fromPubkey: signer.publicKey,
        toPubkey: new PublicKey(state.recipientPub),
        lamports: sendLamports,
      })
    );
    tx.feePayer = signer.publicKey;
    tx.recentBlockhash = (await conn.getLatestBlockhash()).blockhash;
    tx.sign(signer);
    const sig = await conn.sendRawTransaction(tx.serialize(), { preflightCommitment: "processed" });
    log(`Returned SOL: ${sig}`);
  }
  log("Unwind complete.");
  onToggle(false);
  state.holdingsUi = 0;
  state.avgEntryUsd = 0;
  state.lastTradeTs = 0;
  state.endAt = 0;
  save();
}

function scorePumpCandidate(it) {
  const kp = it?.kp || {};
  const chg5m = safeNum(it?.change5m ?? kp.change5m, 0);
  const chg1h = safeNum(it?.change1h ?? kp.change1h, 0);
  const liq   = safeNum(it?.liqUsd   ?? kp.liqUsd,   0);
  const v1h   = safeNum(it?.v1hTotal ?? kp.v1hTotal, 0);
  const pScore= safeNum(it?.pumpScore ?? kp.pumpScore, 0);

  const accel5to1 = safeNum(it?.meta?.accel5to1, 1);
  const risingNow = !!it?.meta?.risingNow;
  const trendUp   = !!it?.meta?.trendUp;

  const c5 = Math.max(0, chg5m);
  const c1 = Math.log1p(Math.max(0, chg1h)); 
  const exp5m = Math.max(0, chg1h) / 12;
  const accelRatio = exp5m > 0 ? (c5 / exp5m) : (c5 > 0 ? 1.2 : 0);
  const lLiq = Math.log1p(liq / 5000);
  const lVol = Math.log1p(v1h / 1000);

  // // Weighted score
  // const w = {
  //   c5: 0.32 * c5,
  //   c1: 0.16 * c1,
  //   lVol: 0.18 * lVol,
  //   lLiq: 0.10 * lLiq,
  //   accelRatio: 0.10 * Math.max(0, accelRatio - 0.8),
  //   accel5to1: 0.10 * Math.max(0, accel5to1 - 1),
  //   flags: (risingNow && trendUp ? 0.02 : 0),
  //   pScore: 0.02 * pScore,
  // };
  // const score =
  //   w.c5 + w.c1 + w.lVol + w.lLiq + w.accelRatio + w.accel5to1 + w.flags + w.pScore;

  const mintStr = String(it?.mint || it?.kp?.mint || "");
  const tag = mintStr ? `${mintStr.slice(0,4)}…` : "(unknown)";
  const series = getLeaderSeries(mintStr, 3) || [];
  const scSlopeMin = slope3pm(series, "pumpScore");
  const chgSlopeMin = slope3pm(series, "chg5m");
  const accSc = slopeAccel3pm(series, "pumpScore");
  const accChg = slopeAccel3pm(series, "chg5m");

  const w = {
    c5: 0.28 * Math.max(0, Math.max(0, safeNum(kp.change5m, 0))),
    c1: 0.14 * Math.log1p(Math.max(0, safeNum(kp.change1h, 0))),
    lVol: 0.16 * Math.log1p(safeNum(kp.v1hTotal, 0) / 1000),
    lLiq: 0.09 * Math.log1p(safeNum(kp.liqUsd, 0) / 5000),
    accelRatio: 0.08 * Math.max(0, safeNum(it?.meta?.accel5to1, 1) - 1),
    accel2: 0.15 * Math.min(1, Math.max(0, ((accSc / 6) + (accChg / 18)) / 2)), // scale to ~[0..1]
    slopeMix: 0.08 * Math.min(1, Math.max(0, ((scSlopeMin / 12) + (chgSlopeMin / 36)) / 2)),
    flags: (it?.meta?.risingNow && it?.meta?.trendUp ? 0.01 : 0),
    pScore: 0.01 * safeNum(it?.pumpScore, 0),
  };
  const score = w.c5 + w.c1 + w.lVol + w.lLiq + w.accelRatio + w.accel2 + w.slopeMix + w.flags + w.pScore;

  log(`Pump score ${tag}: accSc=${accSc.toFixed(3)} accChg=${accChg.toFixed(3)} scSlope=${scSlopeMin.toFixed(2)} chgSlope=${chgSlopeMin.toFixed(2)} -> ${score.toFixed(2)}`);
  return score;
}
  
function countConsecUp(series = [], key) {
  if (!Array.isArray(series) || series.length < 2) return 0;
  let cnt = 0;
  for (let i = series.length - 1; i >= 1; i--) {
    const prev = Number(series[i - 1]?.[key] ?? 0);
    const cur  = Number(series[i]?.[key] ?? 0);
    if (cur > prev) cnt++;
    else break;
  }
  return cnt;
}

function setMintBlacklist(mint, ms = MINT_RUG_BLACKLIST_MS) {
  if (!mint) return;
  if (!window._fdvMintBlacklist) window._fdvMintBlacklist = new Map();

  const nowTs = now();
  const prev = window._fdvMintBlacklist.get(mint);
  const prevCount = typeof prev === "object" && prev ? Number(prev.count || 0) : 0;
  const lastAt = typeof prev === "object" && prev ? Number(prev.lastAt || 0) : 0;

  // Increase coalescing window to reduce rapid stage bumps from noisy/duplicate signals
  const COALESCE_WINDOW_MS = 60_000; // was 10_000
  const canBump = !lastAt || (nowTs - lastAt) > COALESCE_WINDOW_MS;

  const nextCount = Math.min(3, canBump ? (prevCount + 1) : prevCount || 1);

  const stageMs = MINT_BLACKLIST_STAGES_MS[nextCount - 1] || MINT_RUG_BLACKLIST_MS;
  const capMs = Number.isFinite(ms) ? Math.max(60_000, ms | 0) : Infinity;
  const dur = Math.min(stageMs, capMs);

  // If already blacklisted and we're within the window without a bump, quietly extend once
  if (prev && !canBump) {
    const newUntil = Math.max(Number(prev.until || 0), nowTs + dur);
    // Only mutate if the extension actually increases remaining time by a meaningful margin
    const meaningfullyExtended = (newUntil - Number(prev.until || 0)) > 15_000;
    window._fdvMintBlacklist.set(mint, { ...prev, until: newUntil, lastAt: nowTs });
    if (!meaningfullyExtended) return; // suppress duplicate logs
  } else {
    const until = Math.max(Number(prev?.until || 0), nowTs + dur);
    window._fdvMintBlacklist.set(mint, { until, count: nextCount, lastAt: nowTs });
  }

  try {
    const rec = window._fdvMintBlacklist.get(mint);
    const mins = Math.round((Number(rec.until) - nowTs) / 60000);
    log(`Blacklist set (stage ${nextCount}/3, ${mins}m) for ${mint.slice(0,4)}… until ${new Date(rec.until).toLocaleTimeString()}`);
  } catch {}
}

function isMintBlacklisted(mint) {
  if (!mint || !window._fdvMintBlacklist) return false;
  const rec = window._fdvMintBlacklist.get(mint);
  if (!rec) return false;
  const until = typeof rec === "number" ? rec : Number(rec.until || 0);
  if (!Number.isFinite(until) || until <= 0) return false;

  if (now() > until) { window._fdvMintBlacklist.delete(mint); return false; }
  return true;
}

function normBadge(b) {
  const s = String(b || "").toLowerCase();
  if (s.includes("pumping")) return "pumping"; //// "🔥 Pumping" | "Warming" | "Calm"
  if (s.includes("warming")) {
    return "warming";
  }
  return "calm";
}

function markPumpDropBan(mint, ms = PUMP_TO_CALM_BAN_MS) {
  if (!mint) return;
  if (!window._fdvPumpDropBan) window._fdvPumpDropBan = new Map();
  const until = now() + Math.max(60_000, ms|0);
  window._fdvPumpDropBan.set(mint, until);
  try { log(`Pump->Calm ban set for ${mint.slice(0,4)}… until ${new Date(until).toLocaleTimeString()}`); } catch {}
}

function isPumpDropBanned(mint) {
  if (!mint || !window._fdvPumpDropBan) return false;
  const until = window._fdvPumpDropBan.get(mint);
  if (!until) return false;
  if (now() > until) { window._fdvPumpDropBan.delete(mint); return false; }
  return true;
}

function recordBadgeTransition(mint, badge) {
  if (!mint) return;
  if (!window._fdvMintBadgeAt) window._fdvMintBadgeAt = new Map();
  const nowTs = now();
  const prev = window._fdvMintBadgeAt.get(mint) || { badge: "calm", ts: nowTs };
  const prevNorm = normBadge(prev.badge);
  const curNorm  = normBadge(badge);
  window._fdvMintBadgeAt.set(mint, { badge, ts: nowTs });
  if (prevNorm !== curNorm) {            
    try { log(`Badge for ${mint.slice(0,4)}…: ${prevNorm} -> ${curNorm}`); } catch {}
  }
  if (prevNorm === "pumping" && curNorm === "calm") {
    markPumpDropBan(mint, PUMP_TO_CALM_BAN_MS);
  }
} 
  
function _getSeriesStore() {
   if (!window._fdvLeaderSeries) window._fdvLeaderSeries = new Map(); // mint -> [{ts, pumpScore, liqUsd, v1h, chg5m, chg1h}]
   return window._fdvLeaderSeries;
}

// function slope3(series, key) {  // Legacy
//   if (!Array.isArray(series) || series.length < 3) return 0;
//   const a = Number(series[0]?.[key] ?? 0);
//   const b = Number(series[1]?.[key] ?? a);
//   const c = Number(series[2]?.[key] ?? b);
//   return (c - a) / 2;
// }

function slopeAccel3pm(series, key) {
  if (!Array.isArray(series) || series.length < 3) return 0;
  const a = series[0], b = series[1], c = series[2];
  const tAB = Math.max(0.06, (Number(b?.ts || 0) - Number(a?.ts || 0)) / 60000);
  const tBC = Math.max(0.06, (Number(c?.ts || 0) - Number(b?.ts || 0)) / 60000);
  const sAB = (Number(b?.[key] ?? 0) - Number(a?.[key] ?? 0)) / tAB;
  const sBC = (Number(c?.[key] ?? 0) - Number(b?.[key] ?? 0)) / tBC;
  return sBC - sAB; 
}

function delta3(series, key) {
  if (!Array.isArray(series) || series.length < 3) return 0;
  const a = Number(series[0]?.[key] ?? 0);
  const c = Number(series[2]?.[key] ?? a);
  return c - a;
}

function slope3pm(series, key) {
  if (!Array.isArray(series) || series.length < 3) return 0;
  const a = series[0]; const c = series[2];
  const dv = Number(c?.[key] ?? 0) - Number(a?.[key] ?? 0);
  const dtm = Math.max(
    0.06, // floor to ~3.6s to damp per-minute slope explosions on short windows
    (Number(c?.ts || 0) - Number(a?.ts || 0)) / 60000
  );
  return dv / dtm;
}

function _stddev(values) {
  if (!Array.isArray(values) || values.length < 2) return 0;
  let sum = 0;
  let n = 0;
  for (const v of values) {
    const x = Number(v);
    if (!Number.isFinite(x)) continue;
    sum += x;
    n++;
  }
  if (n < 2) return 0;
  const mean = sum / n;
  let sse = 0;
  for (const v of values) {
    const x = Number(v);
    if (!Number.isFinite(x)) continue;
    const d = x - mean;
    sse += d * d;
  }
  return Math.sqrt(sse / Math.max(1, n - 1));
}

function _erfApprox(x) {
  // Abramowitz & Stegun 7.1.26
  const sign = x < 0 ? -1 : 1;
  const ax = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * ax);
  const a1 = 0.254829592;
  const a2 = -0.284496736;
  const a3 = 1.421413741;
  const a4 = -1.453152027;
  const a5 = 1.061405429;
  const y = 1 - (((((a5 * t + a4) * t + a3) * t + a2) * t + a1) * t) * Math.exp(-ax * ax);
  return sign * y;
}

function _normCdf(z) {
  if (!Number.isFinite(z)) return z < 0 ? 0 : 1;
  return 0.5 * (1 + _erfApprox(z / Math.SQRT2));
}

function simulateEntryChanceFromLeaderSeries(mint, { horizonSecs = 120, requiredGrossPct = 0, sigmaFloorPct = 0.75, muLevelWeight = 0.35 } = {}) {
  try {
    const series3 = getLeaderSeries(mint, 3);
    const series5 = getLeaderSeries(mint, 5);
    if (!Array.isArray(series3) || series3.length < 3) return null;

    const horizonMin = Math.max(0.25, Math.min(10, Number(horizonSecs || 0) / 60));
    const thr = Number(requiredGrossPct || 0);

    const last3 = series3[series3.length - 1] || {};
    const chg5mNow = Number(last3?.chg5m ?? 0);

    const chgSlopeMin = slope3pm(series3, "chg5m");
    const scSlopeMin  = slope3pm(series3, "pumpScore");

    const scale5m = horizonMin / 5;
    // Be conservative: recent 5m % change is a noisy momentum proxy and often mean-reverts.
    // Also, pumpScore is unitless (not %), so keep its contribution small and bounded.
    const wLevel = (() => {
      const w = Number(muLevelWeight);
      return Number.isFinite(w) ? Math.max(0, Math.min(1, w)) : 0.35;
    })();
    const muFromLevel = wLevel * chg5mNow * scale5m;
    const muFromSlope = 0.25 * (Number(chgSlopeMin) || 0) * horizonMin;
    const muFromScoreRaw = 0.02 * (Number(scSlopeMin) || 0) * horizonMin;
    const muFromScore = Math.max(-2, Math.min(2, muFromScoreRaw));

    const muRaw = muFromLevel + muFromSlope + muFromScore;
    const mu = Math.max(-100, Math.min(500, muRaw));

    const rates = [];
    if (Array.isArray(series5) && series5.length >= 3) {
      for (let i = 1; i < series5.length; i++) {
        const a = series5[i - 1];
        const b = series5[i];
        const dtm = Math.max(0.06, (Number(b?.ts || 0) - Number(a?.ts || 0)) / 60000);
        const dv = Number(b?.chg5m ?? 0) - Number(a?.chg5m ?? 0);
        rates.push(dv / dtm);
      }
    }

    const sigmaPerMin = _stddev(rates);
    const sigmaRate = Math.max(0, sigmaPerMin * Math.sqrt(horizonMin));

    // Also consider variation of the `chg5m` level itself (some feeds quantize dv/dt to ~0).
    const levelValues = Array.isArray(series5) ? series5.map(r => Number(r?.chg5m ?? 0)) : [];
    const sigmaLevel = Math.max(0, _stddev(levelValues) * scale5m);

    // Prevent degenerate low-variance outputs from producing overconfident pHit.
    const sigmaFloor = (() => {
      const x = Number(sigmaFloorPct);
      return Number.isFinite(x) ? Math.max(0, Math.min(10, x)) : 0.75;
    })();
    const sigma = Math.max(sigmaFloor, sigmaRate, sigmaLevel);

    let pHit = 0;
    let pTerminal = 0;
    if (sigma <= 1e-9) {
      pHit = mu >= thr ? 1 : 0;
      pTerminal = pHit;
    } else {
      // Terminal exceedance probability (X_T >= a)
      const z = (thr - mu) / sigma;
      pTerminal = 1 - _normCdf(z);

      const a = thr;
      const mT = mu;
      const sig = sigma;
      const z1 = (mT - a) / sig;
      const z2 = -(mT + a) / sig;
      const expArg = (2 * mT * a) / (sig * sig);
      const expTerm = Math.exp(Math.max(-50, Math.min(50, expArg)));
      const pHitMax = _normCdf(z1) + expTerm * _normCdf(z2);

      pHit = Math.max(0, Math.min(1, pHitMax));
    }

    return {
      muPct: mu,
      sigmaPct: sigma,
      pHit,
      pTerminal,
      chgSlopeMin,
      scSlopeMin,
      horizonSecs: Math.round(horizonMin * 60),
      requiredGrossPct: thr,
    };
  } catch {
    return null;
  }
}

function recordLeaderSample(mint, sample) {
  if (!mint) return;
  const s = _getSeriesStore();
  const list = s.get(mint) || [];
  const nowTs = now();

  const row = {
    ts: nowTs,
    pumpScore: safeNum(sample.pumpScore, 0),
    liqUsd:    safeNum(sample.liqUsd, 0),
    v1h:       safeNum(sample.v1h, 0),
    chg5m:     safeNum(sample.chg5m, 0),
    chg1h:     safeNum(sample.chg1h, 0),
  };

  const last = list[list.length - 1];
  if (last && (nowTs - Number(last.ts || 0)) < LEADER_SAMPLE_MIN_MS) {
    // Replace the last sample with the latest values instead of pushing a new entry
    list[list.length - 1] = row;
  } else {
    list.push(row);
    while (list.length > 5) list.shift();
  }

  s.set(mint, list);
}

function getLeaderSeries(mint, n = 3) {
  const s = _getSeriesStore();
  const list = s.get(mint) || [];
  if (!n || n >= list.length) return list.slice();
  return list.slice(list.length - n);
}

function computeWarmingRequirement(pos, nowTs = now()) {
  const base = Number.isFinite(pos?.warmingMinProfitPct)
    ? Number(pos.warmingMinProfitPct)
    : Number.isFinite(state.warmingMinProfitPct) ? Number(state.warmingMinProfitPct) : 2;

  const delayMs = Math.max(0, Number(state.warmingDecayDelaySecs || 0) * 1000);
  const perMin = Math.max(0, Number(state.warmingDecayPctPerMin || 0));
  const floor  = Number(state.warmingMinProfitFloorPct);
  const holdAt = Number(pos?.warmingHoldAt || pos?.lastBuyAt || pos?.acquiredAt || nowTs);

  const elapsedTotalMs = Math.max(0, nowTs - holdAt);
  const elapsedMs = Math.max(0, elapsedTotalMs - delayMs);
  const elapsedMin = elapsedMs > 0 ? (elapsedMs / 60000) : 0;

  const decayed = base - (perMin * elapsedMin);
  const req = Number.isFinite(floor) ? Math.max(floor, decayed) : decayed;

  const autoSecs = Math.max(0, Number(state.warmingAutoReleaseSecs || 0));
  const shouldAutoRelease = autoSecs > 0 && (elapsedTotalMs >= autoSecs * 1000);

  return { req, base, elapsedMin, perMin, floor, shouldAutoRelease, elapsedTotalSec: Math.floor(elapsedTotalMs/1000) };
}

function computePrePumpScore({ kp = {}, meta = {} }) {
  const chg5m = safeNum(kp.change5m, 0);
  const chg1h = safeNum(kp.change1h, 0);
  const buy   = safeNum(meta.buy, 0);

  const a51raw = safeNum(meta.accel5to1, 1);
  let a51   = a51raw > 0 ? a51raw : 1;
  const zv1   = Math.max(0, safeNum(meta.zV1, 0));
  const risingNow = !!meta.risingNow;
  const trendUp   = !!meta.trendUp;

  // Treat missing accel as slight accel when flow is strong
  const hasFlow = (zv1 >= 0.8 || buy >= 0.60);
  if (a51 <= 1 && hasFlow) a51 = 1.01;

  const f5m = (chg5m > 0 && chg5m < 0.9) ? Math.min(1, chg5m / 0.9) : (chg5m >= 0.9 ? 0.4 : 0);

  // Volume acceleration (5m vs 1h) and decayed zV1
  const fA  = Math.max(0, Math.min(1, (a51 - 1) / 0.05)); // was 0.08 -> more sensitive
  const fZ  = Math.max(0, Math.min(1, zv1 / 1.5));

  // Buy skew helps (slightly wider band)
  const fB  = Math.max(0, Math.min(1, (buy - 0.58) / 0.10));

  log(`Pre-pump factors: f5m=${f5m.toFixed(3)} fA=${fA.toFixed(3)} fZ=${fZ.toFixed(3)} fB=${fB.toFixed(3)}`);

  const series = getLeaderSeries(kp.mint || "", 3);
  let fT = 0;
  if (series && series.length >= 3) {
    const a = series[0], c = series[series.length - 1];
    const upChg  = Number(c.chg5m || 0) >= Number(a.chg5m || 0);
    const upSc   = Number(c.pumpScore || 0) >= Number(a.pumpScore || 0);
    fT = (upChg ? 0.5 : 0) + (upSc ? 0.5 : 0);
  } else if (risingNow && trendUp) {
    fT = 0.6;
  }

  const exp5m = Math.max(0, chg1h) / 12;
  const accelRatio = exp5m > 0 ? (Math.max(0, chg5m) / exp5m) : 0;
  const notBackside = accelRatio >= 0.4;

  const score = (
    0.30 * fA +
    0.25 * fZ +
    0.18 * fT +
    0.17 * f5m +
    0.10 * fB
  ) * notBackside;

  return score; // 0..1
}

function shouldAttachFeeForSell({ mint, amountRaw, inDecimals, quoteOutLamports }) {
  try {
    const dec = Number.isFinite(inDecimals) ? inDecimals : 6;
    const amountUi = Number(amountRaw || 0) / Math.pow(10, dec);
    if (!(amountUi > 0)) return false;

    const estOutSol = Number(quoteOutLamports || 0) / 1e9;
    if (!(estOutSol > 0)) return false;

    const estCostSold = estimateProportionalCostSolForSell(mint, amountUi);
    if (estCostSold === null) {
      return false;
    }

    const estPnl = estOutSol - estCostSold;
    return estPnl > 0; // attach fee only when profitable
  } catch {
    return false;
  }
}

function estimateNetExitSolFromQuote({ mint, amountUi, inDecimals, quoteOutLamports }) {
  try {
    const amountRaw = Math.max(1, Math.floor(Number(amountUi || 0) * Math.pow(10, Number(inDecimals || 6))));
    const attachFee = shouldAttachFeeForSell({
      mint,
      amountRaw,
      inDecimals: Number(inDecimals || 6),
      quoteOutLamports: Number(quoteOutLamports || 0),
    });

    const feeBps = Number(FDV_PLATFORM_FEE_BPS || 0);
    const platformL = attachFee ? Math.floor(Number(quoteOutLamports || 0) * (feeBps / 10_000)) : 0;
    const txL = EDGE_TX_FEE_ESTIMATE_LAMPORTS; // conservative recurring estimate
    const netL = Math.max(0, Number(quoteOutLamports || 0) - platformL - txL);
    return {
      netSol: netL / 1e9,
      feeApplied: attachFee,
      platformLamports: platformL,
      txLamports: txL,
    };
  } catch {
    return { netSol: Math.max(0, Number(quoteOutLamports || 0) - EDGE_TX_FEE_ESTIMATE_LAMPORTS) / 1e9, feeApplied: false, platformLamports: 0, txLamports: EDGE_TX_FEE_ESTIMATE_LAMPORTS };
  }
}
  

function computeReboundSignal(mint) {
  try {
    const series = getLeaderSeries(mint, 3);
    if (!Array.isArray(series) || series.length < 3) return { ok: false, why: "no-series" };

    const last = series[series.length - 1] || {};
    const kp = {
      mint,
      change5m: safeNum(last.chg5m, 0),
      change1h: safeNum(last.chg1h, 0),
      liqUsd:   safeNum(last.liqUsd, 0),
      v1h:      safeNum(last.v1h, 0),
    };

    // Build a minimal meta based on slopes to keep detector meaningful
    const c5 = Math.max(0, kp.change5m);
    const c1 = Math.max(0, kp.change1h);
    const exp5m = c1 / 12;
    const accel5to1 = exp5m > 1e-9 ? Math.max(1, c5 / exp5m) : (c5 > 0 ? 1.02 : 1);
    const zV1 = Math.max(0, kp.v1h) / 1000; // rough z-score proxy (scaled)
    // Clamp slopes to sensible bands to avoid near-zero-dt spikes
    const chgSlopeMin = _clamp(slope3pm(series, "chg5m"),   -60, 60);
    const scSlopeMin  = _clamp(slope3pm(series, "pumpScore"), -20, 20);
    const risingNow   = chgSlopeMin > 0 || (delta3(series, "chg5m") > 0);
    const trendUp     = scSlopeMin > 0 && (delta3(series, "pumpScore") > 0);

    const meta = { accel5to1, zV1, buy: 0.58, risingNow, trendUp };

    const res = detectWarmingUptick({ kp, meta }, state);
    const score = Number(res?.score || 0);
    const chgS  = Number(res?.chgSlope || chgSlopeMin || 0);
    const scS   = Number(res?.scSlope || scSlopeMin || 0);

    const okSlope = (chgS >= Math.max(6, Number(state.reboundMinChgSlope || 12))) &&
                    (scS  >= Math.max(4, Number(state.reboundMinScSlope  || 8)));

    const ok = !!res?.ok || okSlope || score >= Math.max(0.25, Number(state.reboundMinScore || 0.34));
    const why = res?.ok ? "warming-ok" : (okSlope ? "slope-ok" : (score >= (state.reboundMinScore||0.34) ? "score-ok" : "weak"));
    return { ok, why, score, chgSlope: chgS, scSlope: scS };
  } catch {
    return { ok: false, why: "error" };
  }
}

function shouldDeferSellForRebound(mint, pos, pnlPct, nowTs, reason = "") {
  try {
    if (!state.reboundGateEnabled) return false;
    if (!mint || !pos) return false;




    if (/max[-\s]*loss|warming[-\s]*max[-\s]*loss/i.test(String(reason || ""))) return false;
    if (/rug/i.test(reason || "")) return false;
    if (/TP|take\s*profit/i.test(reason || "")) return false;

    const minPnl = Number(state.reboundMinPnLPct || -15);

    if (Number.isFinite(pnlPct) && pnlPct <= minPnl) return false;

    const anchorTs = Number(pos.fastPeakAt || pos.lastBuyAt || pos.acquiredAt || 0);
    const ageMs = nowTs - anchorTs;
    const lookbackMs = Math.max(5_000, Number(state.reboundLookbackSecs || 45) * 1000);
    const allowObserverRelax = /observer/i.test(reason || "");
    const withinWindow = ageMs <= lookbackMs || (allowObserverRelax && ageMs <= lookbackMs * 2);
    if (!withinWindow) return false;

    const startedAt = Number(pos.reboundDeferStartedAt || 0);
    const maxDefMs = Math.max(4_000, Number(state.reboundMaxDeferSecs || 20) * 1000);
    if (startedAt && (nowTs - startedAt) > maxDefMs) return false;

    const sig = computeReboundSignal(mint);
    if (!sig.ok) return false;
    if (!pos.reboundDeferStartedAt) pos.reboundDeferStartedAt = nowTs;
    pos.reboundDeferUntil = nowTs + Math.max(1000, Number(state.reboundHoldMs || 4000));
    pos.reboundDeferCount = Number(pos.reboundDeferCount || 0) + 1;
    save();

    log(`Rebound gate: holding ${mint.slice(0,4)}… (${sig.why}; score=${sig.score.toFixed(3)} chgSlope=${sig.chgSlope.toFixed(2)}/m scSlope=${sig.scSlope.toFixed(2)}/m)`);
    return true;
  } catch {
    return false;
  }
}

function detectWarmingUptick({ kp = {}, meta = {} }, cfg = state) {
  const relax = cfg.warmingRelaxEnabled !== false;

  const series = getLeaderSeries(kp.mint || "", 3) || [];
  const chgDelta    = delta3(series, "chg5m");
  const chgSlopeMin = _clamp(slope3pm(series, "chg5m"),   -60, 60);
  const scSlopeMin  = _clamp(slope3pm(series, "pumpScore"), -20, 20);
  const scDelta     = delta3(series, "pumpScore");
  const accChgMin   = slopeAccel3pm(series, "chg5m");
  const accScMin    = slopeAccel3pm(series, "pumpScore");

  const chg5m = safeNum(kp.change5m, 0);
  const chg1h = safeNum(kp.change1h, 0);
  const liq   = safeNum(kp.liqUsd, 0);
  const v1h   = safeNum(kp.v1hTotal, 0);

  let a51   = Math.max(1, safeNum(meta.accel5to1, 1));
  let zV1   = Math.max(0, safeNum(meta.zV1, 0));
  const buy = Math.max(0, safeNum(meta.buy, 0));
  let rising= !!meta.risingNow;
  let trendUp = !!meta.trendUp;

  // infer rising when score slope positive & chg slope non-negative.
  if (relax && !rising && scSlopeMin > 0 && chgSlopeMin >= 0) rising = true;
  if (relax && !trendUp && scDelta > 0) trendUp = true;

  const exp5m = Math.max(0, chg1h) / 12;
  const accelRatio = exp5m > 0 ? (Math.max(0, chg5m) / exp5m) : 0;
  let notBackside = accelRatio >= (chg1h > 0.6 ? 0.30 : 0.25);
  if (!notBackside && relax && scSlopeMin > 4) notBackside = true;

  const liqOk = liq >= Math.max(2500, Number(cfg.warmingMinLiqUsd || 4000));
  const volOk = v1h >= Math.max(500,  Number(cfg.warmingMinV1h || 800));
  const hasFlow = (zV1 >= (cfg.warmingFlowMin ?? 0.35)) || (buy >= (cfg.warmingBuyMin ?? 0.55));
  if (a51 <= 1.0 && (hasFlow || (relax && chg5m > 2))) a51 = 1.01;

  // bootstrap zV1 if zero but strong price impulse.
  if (relax && zV1 === 0 && chg5m > 2.0) zV1 = 0.40;

  const warmPreRaw = computePrePumpScore({ kp, meta: { accel5to1: a51, zV1, buy, risingNow: rising, trendUp } });
  let pre = warmPreRaw;

  let preMin = Number(cfg.warmingUptickMinPre ?? 0.35);
  preMin = Math.max(0.30, preMin);
  if (!liqOk || !volOk) preMin += 0.03;
  if (a51 >= 1.02) preMin -= 0.05;
  if (zV1 >= 1.0)  preMin -= 0.03;
  if (chgSlopeMin >= 25) preMin -= 0.06;
  if (scSlopeMin  >= 10) preMin -= 0.04;

  // : allow lower preMin when strong slopes but low base
  if (relax && pre < preMin && (scSlopeMin > 6 || chgSlopeMin > 20)) {
    preMin = Math.max(0.22, preMin * 0.70);
  }
  if (relax && pre < preMin && chg5m > 2.2) {
    preMin = Math.max(0.20, preMin * 0.75);
  }

  try {
    const mintId = String(kp.mint || "");
    if (mintId) {
      if (!window._fdvPrevPre) window._fdvPrevPre = new Map();
      const lastPre = Number(window._fdvPrevPre.get(mintId) || NaN);
      if (Number.isFinite(lastPre)) {
        preMin = Math.max(preMin, lastPre * 0.80);
      }
      window._fdvPrevPre.set(mintId, pre);
    }
  } catch {}
  preMin = Math.max(0.28, preMin);

  const needDeltaChg = Number(cfg.warmingUptickMinDeltaChg5m ?? 0.012);
  const needDeltaSc  = Number(cfg.warmingUptickMinDeltaScore ?? 0.006);

  const accel2Ok =
    (accChgMin > 0 && accScMin > 0) ||
    (accChgMin >= needDeltaChg * 1.2) ||
    (accScMin  >= needDeltaSc  * 1.8);

  const slopeOk = (chgDelta >= needDeltaChg) || (chgSlopeMin >= needDeltaChg * 3.0);
  let accelOk   = a51 >= (hasFlow ? (Number(cfg.warmingUptickMinAccel ?? 1.001) - 0.005) : Number(cfg.warmingUptickMinAccel ?? 1.001));
  if (scSlopeMin >= needDeltaSc * 2.5 || chgSlopeMin >= needDeltaChg * 2.0) accelOk = true;
  const strongFlow = (zV1 >= Math.max(0.7, (cfg.warmingFlowStrong ?? 0.7))) || (buy >= Math.max(0.58, (cfg.warmingBuyStrong ?? 0.58)));
  const scoreSlopeOk =
    (scDelta >= needDeltaSc) ||
    (scSlopeMin >= needDeltaSc * 2.0) ||
    (strongFlow && (chgSlopeMin >= needDeltaChg * 2.0 || a51 >= ((cfg.warmingUptickMinAccel ?? 1.001) + 0.004)));

  const trendGate =
    (rising && trendUp) ||
    slopeOk ||
    (scDelta >= needDeltaSc) ||
    (scSlopeMin >= needDeltaSc * 2.0);

  const flowGate = hasFlow || (scSlopeMin >= needDeltaSc * 2.5);

  // Relax final acceptance: permit strong slopes with lower pre
  const prePass = pre >= preMin || (relax && pre >= preMin * 0.6 && (scSlopeMin > 6 || chgSlopeMin > 18));

  const ok =
    trendGate &&
    notBackside &&
    accelOk &&
    accel2Ok &&
    scoreSlopeOk &&
    prePass &&
    flowGate;

  if (relax && !ok) {
    // Secondary fallback: strong immediate impulse
    if (chg5m > 2.2 && scSlopeMin > 5 && a51 >= 1.005) {
      preMin = Math.min(preMin, 0.40);
      if (pre >= preMin * 0.55) {
        // mark as tentative ok
        prePass && flowGate && (meta._tentativeWarm = true);
      }
    }
  }

  const score = Math.max(0, Math.min(1,
    0.35 * Math.min(1, (a51 - 1) / 0.06) +
    0.25 * Math.min(1, (chgDelta) / (needDeltaChg * 2.5)) +
    0.20 * Math.min(1, (scDelta)  / (needDeltaSc  * 3.0)) +
    0.20 * Math.min(1, Math.max(0, pre - preMin + 0.05) / 0.30) +
    0.15 * Math.min(1, Math.max(0, ((accChgMin / (needDeltaChg * 2)) + (accScMin / (needDeltaSc * 2))) / 2))
  ));

  if (!window._fdvWarmDbgLite || now() - window._fdvWarmDbgLite > 900) {
    window._fdvWarmDbgLite = now();
    log(`WarmDet ${String((kp.mint||"").slice(0,4))}… ok=${ok} pre=${pre.toFixed(3)}>=${preMin.toFixed(3)} scSlope=${scSlopeMin.toFixed(2)} chgSlope=${chgSlopeMin.toFixed(2)} a51=${a51.toFixed(3)} zV1=${zV1.toFixed(2)} relax=${relax}`);
  }

  return { ok, score, chgSlope: chgSlopeMin, scSlope: scSlopeMin, pre, preMin, a51, liq, v1h, notBackside };
}

function isWarmingHoldActive(mint, pos, warmReq, nowTs) {
  try {
    const warmingHold = !!(state.rideWarming && pos?.warmingHold === true);
    if (!warmingHold) return { active: false };
    // If base window not elapsed, hold is active
    if (!warmReq?.shouldAutoRelease) return { active: true, reason: "timer" };

    // After base window: optionally extend hold while rising
    if (state.warmingExtendOnRise !== false) {
      const until = Number(pos.warmingExtendUntil || 0);
      if (until && nowTs < until) return { active: true, reason: "extend-window" };

      const sig = computeReboundSignal(mint);
      if (sig.ok) {
        const step = Math.max(1000, Number(state.warmingExtendStepMs || state.reboundHoldMs || 4000));
        pos.warmingExtendUntil = nowTs + step;
        save();
        log(`Warming extend: ${mint.slice(0,4)}… (${sig.why}; score=${sig.score.toFixed(3)} chgSlope=${sig.chgSlope.toFixed(2)}/m scSlope=${sig.scSlope.toFixed(2)}/m)`);
        return { active: true, reason: "extend-signal" };
      }
    }
  } catch {}
  return { active: false };
}

function _getWarmPrimeStore() {
  if (!window._fdvWarmPrime) window._fdvWarmPrime = new Map(); // mint -> { count, lastAt }
  return window._fdvWarmPrime;
}

function pickPumpCandidates(take = 1, poolN = 3) {
  try {
    const wantN = state.rideWarming ? Math.max(poolN, 6) : poolN; // widen pool for warming
    const leaders = computePumpingLeaders(wantN) || [];
    log(`Picking pump candidates from ${leaders.length} leaders…`);
    const pool = [];
    for (const it of leaders) {
      const mint = it?.mint;
      if (!mint) continue;

      const meta = it?.meta || {};
      const kp = { ...(it?.kp||{}), mint };
      const badge = String(getRugSignalForMint(mint)?.badge || it?.badge || "");
      log(`Evaluating leader ${mint.slice(0,4)}… badge="${badge}"`);

      const chg5m = safeNum(kp.change5m, 0);
      const chg1h = safeNum(kp.change1h, 0);
      // Record series EARLY so detector sees 3-tick trend
      recordLeaderSample(mint, {
        pumpScore: Number(it?.pumpScore || 0),
        liqUsd:    safeNum(kp.liqUsd, 0),
        v1h:       safeNum(kp.v1hTotal, 0),
        chg5m,
        chg1h,
      });

      const allowWarming = state.rideWarming;
      const badgeNorm = normBadge(badge);
      const isPumping = badgeNorm === "pumping";
      const isWarming = badgeNorm === "warming";
      if (!(isPumping || (allowWarming && isWarming))) continue;

      // Strict pump gate
      const minChg5  = isPumping ? 0.8 : 0.4;
      const minAccel = isPumping ? 1.00 : 0.98;

      // Backside guard
      const exp5m = Math.max(0, chg1h) / 12;
      const accelRatio = exp5m > 0 ? (Math.max(0, chg5m) / exp5m) : 0;
      const notBackside = accelRatio >= 0.4;

      // Primary microUp gate for pumping
      const microUp =
        isPumping &&
        chg5m >= minChg5 &&
        meta.risingNow === true &&
        meta.trendUp === true &&
        Math.max(1, safeNum(meta.accel5to1, 1)) >= minAccel;

      let primed = false;
      let pre = 0;
      let chgSlope = 0;
      let scSlope  = 0;

      if (!microUp && isWarming && allowWarming && notBackside) {
        const res = detectWarmingUptick({ kp, meta });
        pre = res.pre;
        chgSlope = Number(res.chgSlope || 0);
        scSlope  = Number(res.scSlope  || 0);
        if (res.ok) {
          const store = _getWarmPrimeStore();
          const prev = store.get(mint) || { count: 0, lastAt: 0 };
          const ttlMs = 15_000;
          const within = now() - prev.lastAt < ttlMs;
          const nextCount = within ? (prev.count + 1) : 1;
          store.set(mint, { count: nextCount, lastAt: now() });
          const need = Math.max(1, Number(state.warmingPrimedConsec || 2));
          primed = (nextCount >= need);
        } else {
          try { _getWarmPrimeStore().delete(mint); } catch {}
        }
      } else {
        try { _getWarmPrimeStore().delete(mint); } catch {}
      }

      if (!(microUp && notBackside) && !primed) {
        const series = getLeaderSeries(mint, 5);
        const scSlopeMin = slope3pm(series || [], "pumpScore");
        const chgSlopeMin = slope3pm(series || [], "chg5m");
        const needTicks = Math.max(1, Number(state.sustainTicksMin || 2));
        const needChg = Math.max(0, Number(state.sustainChgSlopeMin || 6));
        const needSc  = Math.max(0, Number(state.sustainScSlopeMin  || 3));
        const okTicks = countConsecUp(series, "pumpScore") >= needTicks && countConsecUp(series, "chg5m") >= needTicks;
        const okSlopes = (scSlopeMin >= needSc) && (chgSlopeMin >= needChg);
        if (!(okTicks && okSlopes)) continue;
      }

      const series3 = getLeaderSeries(mint, 3) || [];
      const accChg = slopeAccel3pm(series3, "chg5m");
      const accSc  = slopeAccel3pm(series3, "pumpScore");

      const baseScore = scorePumpCandidate({ mint, kp, pumpScore: it?.pumpScore, meta });
      const finalScore = primed ? baseScore * 0.92 : baseScore;

      pool.push({
        mint,
        badge: it.badge,
        pumpScore: Number(it?.pumpScore || 0),
        liqUsd: safeNum(kp.liqUsd, 0),
        v1h:    safeNum(kp.v1hTotal, 0),
        chg5m,
        chg1h,
        meta,
        primed,
        nb: notBackside,
        pre,
        chgSlope,
        scSlope,
        accChg,
        accSc,
        score: finalScore,
      });
    }
    if (!pool.length) {
      try {
        const leadersRaw = computePumpingLeaders(Math.max(poolN, 6)) || [];
        const firstPump = leadersRaw.find(x => normBadge(x.badge) === "pumping");
        if (firstPump?.mint) {
          const mint = firstPump.mint;
          const kp = { ...(firstPump.kp || {}), mint };
          const meta = firstPump.meta || {};
          const det = detectWarmingUptick({ kp, meta }, state);
          const s = getLeaderSeries(mint, 3);
          const scSlopeMin = slope3pm(s || [], "pumpScore");
          const chgSlopeMin = slope3pm(s || [], "chg5m");
          const risingNow = !!meta.risingNow;
          if (det?.ok && ((scSlopeMin > 0 && chgSlopeMin > 0) || risingNow)) {
            log(`Fallback pick (WarmDet ok, slopes healthy): ${mint.slice(0,4)}…`);
            return [mint];
          }
          log(`Fallback pick rejected by WarmDet/slopes: ${mint.slice(0,4)}…`);
        }
      } catch {}
      return [];
    }

    pool.sort((a,b) => b.score - a.score);
    const top = pool[0]?.score ?? -Infinity;

    const strong = pool.filter(x => {
      const b = normBadge(x.badge);
      const isPump = (b === "pumping");
      const minC5  = isPump ? 0.8 : 0.4;
      const minA   = isPump ? 1.00 : 0.98;
      const aEff   = Math.max(1, safeNum(x.meta?.accel5to1, 1));
      const accel2Ok = (Number(x.accChg || 0) > 0) || (Number(x.accSc || 0) > 0);

      if (x.primed) {
        const flowOk = safeNum(x.meta?.zV1, 0) >= 0.50 || safeNum(x.meta?.buy, 0) >= 0.60;
        const slopeGate = (Number(x.chgSlope || 0) >= 15) || (Number(x.scSlope || 0) >= 8);
        return (
          x.score >= top * 0.80 &&
          x.nb === true &&
          ((x.meta?.risingNow === true && x.meta?.trendUp === true) || slopeGate) &&
          (x.chg5m > 0 || aEff >= 0.98) &&
          flowOk &&
          accel2Ok
        );
      }
      return (
        x.score >= top * 0.85 &&
        x.chg5m >= minC5 &&
        aEff >= minA &&
        x.meta?.risingNow === true &&
        x.meta?.trendUp === true &&
        x.nb === true &&
        accel2Ok
      );
    });

    const base = strong.length ? strong : pool;
    const chosen = base.slice(0, Math.max(1, take)).map(x => x.mint);
    logObj("Pump picks", base.slice(0, poolN));
    return chosen;
  } catch {
    return [];
  }
}
function _getDropGuardStore() {
  if (!window._fdvDropGuard) window._fdvDropGuard = new Map(); // mint -> { consec3, lastPasses, lastAt }
  return window._fdvDropGuard;
}

function recordObserverPasses(mint, passes) {
  if (!mint) return;
  const m = _getDropGuardStore();
  const r = m.get(mint) || { consec3: 0, lastPasses: 0, lastAt: 0, consecLow: 0 };
  if (passes === 3) {
    r.consec3 = (r.lastPasses === 3) ? (r.consec3 + 1) : 1;
  } else {
    r.consec3 = 0;
  }
    
  if (passes <= 2) {
    r.consecLow = (r.lastPasses <= 2) ? (Number(r.consecLow || 0) + 1) : 1;
  } else {
    r.consecLow = 0;
  }
  r.lastPasses = passes;
  r.lastAt = now();
  m.set(mint, r);
}

function shouldForceSellAtThree(mint, pos, curSol, nowTs) {
  try {
    const sizeUi = Number(pos.sizeUi || 0);
    if (sizeUi <= 0) return false;

    // Age guard
    const minAgeMs = Math.max(0, Number(state.observerDropMinAgeSecs || 0) * 1000);
    const ageMs = nowTs - Number(pos.lastBuyAt || pos.acquiredAt || 0);
    if (ageMs < minAgeMs) return false;

    const rec = _getDropGuardStore().get(mint) || { consec3: 0 };
    const needConsec = Math.max(1, Number(state.observerDropConsec || 2));

    // Price drawdown from HWM
    const pxNow = curSol / sizeUi; // SOL per unit
    const hwmPx = Number(pos.hwmPx || 0) || pxNow;
    const ddPct = (hwmPx > 0 && pxNow > 0) ? ((hwmPx - pxNow) / hwmPx) * 100 : 0;
    const trailThr = Math.max(0, Number(state.observerDropTrailPct || 0));

    // Require negative slope confirmation too
    const series = getLeaderSeries(mint, 3);
    const scSlopeMin = _clamp(slope3pm(series || [], "pumpScore"), -20, 20);
    const chgSlopeMin= _clamp(slope3pm(series || [], "chg5m"), -60, 60);

    const consecOk    = (rec.consec3 + 1) >= needConsec;
    const drawdownOk  = ddPct >= (trailThr + 1.0); // need a bit more than trail
    const slopeBad    = (scSlopeMin < 0 || chgSlopeMin < 0);

    return consecOk && drawdownOk && slopeBad;
  } catch { return false; }
}

function _getObserverWatch() {
  if (!window._fdvObserverWatch) window._fdvObserverWatch = new Map();
  return window._fdvObserverWatch;
}

function noteObserverConsider(mint, ms = 30_000) {
  if (!mint) return;
  const m = _getObserverWatch();
  const nowTs = now();
  const rec = m.get(mint) || { firstAt: nowTs, lastPasses: 3, until: nowTs + ms };
  rec.lastAt = nowTs;
  rec.lastPasses = 3;
  rec.until = Math.max(rec.until || 0, nowTs + ms);
  m.set(mint, rec);
  try { log(`Observer: consider ${mint.slice(0,4)}… (3/5). Watching for uptick…`); } catch {}
}

// function isObserverConsiderActive(mint) {
//   const m = _getObserverWatch();
//   const rec = m.get(mint);
//   if (!rec) return false;
//   if (now() > rec.until) { m.delete(mint); return false; }
//   return true;
// }

function clearObserverConsider(mint) {
  try { _getObserverWatch().delete(mint); } catch {}
}

async function pickTopPumper() {
  const picks = pickPumpCandidates(1, 3);
  const mint = picks[0] || "";
  if (!mint) return "";

  if (isMintBlacklisted(mint) || isPumpDropBanned(mint)) return "";

  // Current badge for extra context
  const sig = getRugSignalForMint(mint) || {};
  const badgeNorm = normBadge(sig.badge);

  async function snapshot(m) {
    try {
      const leaders = computePumpingLeaders(3) || [];
      const it = leaders.find(x => x?.mint === m);
      if (!it) return null;
      const kp = it.kp || {};
      return {
        pumpScore: safeNum(it.pumpScore, 0),
        liqUsd: safeNum(kp.liqUsd, 0),
        v1h: safeNum(kp.v1hTotal, 0),
        chg5m: safeNum(kp.change5m, 0),
        chg1h: safeNum(kp.change1h, 0),
      };
    } catch {
      return null;
    }
  }

  const s0 = await snapshot(mint);
  if (!s0) {
    setMintBlacklist(mint, MINT_RUG_BLACKLIST_MS);
    log(`Observer: ${mint.slice(0,4)}… vanished from leaders;.`);
    return "";
  }

  // Shorter pre-buy watch to reduce missed rotations. 
  const start = now();
  let sN = s0;
  const watchMs = Math.max(1200, Math.floor((state.tickMs || 2000) * 0.9));
  const stepMs  = Math.max(400, Math.floor(watchMs / 3));
  while (now() - start < watchMs) {
    await new Promise(r => setTimeout(r, stepMs));
    const s1 = await snapshot(mint);
    if (!s1) { sN = null; break; }
    sN = s1;
  }

  if (!sN) {
    setMintBlacklist(mint, MINT_RUG_BLACKLIST_MS);
    log(`Observer: ${mint.slice(0,4)}… dropped during pre-buy watch; skipping (no blacklist).`); 
    return "";
  }

  const passChg  = sN.chg5m > 0;
  const passVol  = sN.v1h >= s0.v1h;
  const passLiq  = sN.liqUsd >= s0.liqUsd * 0.98;
  const passScore= sN.pumpScore >= s0.pumpScore * 0.98;

  let passes = 0;
  if (passChg) passes++;
  if (passVol) passes++;
  if (passLiq) passes++;
  if (passScore) passes++;
  if (sN.pumpScore > s0.pumpScore && sN.chg5m > s0.chg5m) passes++;

  if (passes < 3) {
    setMintBlacklist(mint, MINT_RUG_BLACKLIST_MS);
    log(`Observer: reject ${mint.slice(0,4)}… (score ${passes}/5); blacklisted 30m.`);
    return "";
  }

  if (state.strictBuyFilter && !state.rideWarming) {
    if (badgeNorm !== "pumping") {
      noteObserverConsider(mint, 30_000);
      return "";
    }
    if (passes < 4) {
      noteObserverConsider(mint, 30_000);
      return "";
    }
  }

  if (passes === 3 && badgeNorm === "pumping") {
    log(`Observer: approve ${mint.slice(0,4)}… (score 3/5) [badge=pumping]`);
    clearObserverConsider(mint);
    return mint;
  }

  if (passes === 3) {
    noteObserverConsider(mint, 30_000);
    return "";
  }

  const holdClamped = recommendDynamicHoldSecs(passes);
  if (state.dynamicHoldEnabled) {
    if (state.maxHoldSecs !== holdClamped) {
      state.maxHoldSecs = holdClamped;
      save();
      log(`Observer: approve ${mint.slice(0,4)}… (score ${passes}/5); hold=${holdClamped}s`);
    } else {
      log(`Observer: approve ${mint.slice(0,4)}… (score ${passes}/5)`);
    }
  } else {
    log(`Observer: approve ${mint.slice(0,4)}… (score ${passes}/5)`);
  }

  clearObserverConsider(mint);
  return mint;
}

function _getFinalPumpGateStore() {
  if (!window._fdvFinalPumpGate)
    window._fdvFinalPumpGate = new Map(); // mint -> { startScore, at, ready }
  return window._fdvFinalPumpGate;
}

function isFinalPumpGateReady(mint) {
  const cfg = state;
  if (!cfg.finalPumpGateEnabled) return true;
  if (!mint) return true;
  const store = _getFinalPumpGateStore();
  const rec = store.get(mint);
  return !!(rec && rec.ready === true);
}

function computeFinalGateIntensity(mint) {
  try {
    const cfg = state;
    const store = _getFinalPumpGateStore();
    const rec = store.get(mint);
    const series = getLeaderSeries(mint, 3) || [];
    const chgSlope = _clamp(slope3pm(series, "chg5m"), -60, 60);
    const scSlope  = _clamp(slope3pm(series, "pumpScore"), -20, 20);

    let base = 1.0;
    if (rec && rec.ready) {
      const delta   = Math.max(0, Number(rec.passDelta || 0));
      const need    = Math.max(0.001, Number(cfg.finalPumpGateDelta || 3));
      const elapsed = Math.max(500, Number(rec.elapsedMs || (now() - Number(rec.at || 0)) || 1000));
      const win     = Math.max(500, Number(cfg.finalPumpGateWindowMs || 10000));
      const start   = Math.max(0, Number(rec.startScore || 0));
      // Δscore speed and start strength
      base = (delta / need) * (win / elapsed) * (1 + Math.min(0.5, start / 8));
    } else {
      // fallback to momentum if no pass record
      base = 0.9 + Math.max(0, chgSlope / 30) + Math.max(0, scSlope / 12);
    }
    const intensity = Math.max(0.4, Math.min(2.5, base));
    let tier = "moderate";
    if (intensity >= 1.6) tier = "explosive";
    else if (intensity < 0.9) tier = "weak";
    return { intensity, tier, chgSlope, scSlope };
  } catch {
    return { intensity: 1.0, tier: "moderate", chgSlope: 0, scSlope: 0 };
  }
}

function computeDynamicTpSlForMint(mint) {
  const { intensity, tier, chgSlope, scSlope } = computeFinalGateIntensity(mint);
  let tp = Math.max(5, Number(state.takeProfitPct || 12));
  let sl = Math.max(5, Number(state.stopLossPct || 5.5));
  let trailPct = Math.max(0, Number(state.trailPct || 6));
  let arm = Math.max(0, Number(state.minProfitToTrailPct || 3));

  if (tier === "explosive") {
    tp = Math.min(25, Math.max(tp, 18));
    sl = Math.max(5, Math.min(6, sl));
    trailPct = Math.max(6, Math.min(10, trailPct));
    arm = Math.max(4, arm);
  } else if (tier === "moderate") {
    tp = Math.min(18, Math.max(tp, 12));
    sl = Math.max(5, Math.min(6, sl));
    trailPct = Math.max(6, Math.min(12, trailPct));
    arm = Math.max(3, arm);
  } else { // weak
    tp = Math.min(14, Math.max(8, tp - 2));
    sl = Math.max(6, Math.min(7, sl + 0));
    trailPct = Math.max(8, Math.min(14, trailPct + 2));
    arm = Math.max(2, arm);
  }
  if (chgSlope < 6 || scSlope < 3) sl = Math.max(sl, 6);

  return { tp, sl, trailPct, arm, tier, intensity };
}

function pickTpSlForMint(mint) {
  // Help user if TP/SL is wacked.
  const dyn = computeDynamicTpSlForMint(mint);
  const user = {
    tp: Math.max(1, Number(state.takeProfitPct || 0)),
    sl: Math.max(0.1, Number(state.stopLossPct || 0)),
    trailPct: Math.max(0, Number(state.trailPct || 0)),
    arm: Math.max(0, Number(state.minProfitToTrailPct || 0)),
  };

  const hardWacked =
    user.tp < 3 || user.tp > 100 ||
    user.sl < 0.25 || user.sl > 25 ||
    user.trailPct > 50 || user.arm > 30 ||
    (user.tp <= user.sl); // tp should generally be > sl

  const tpDiff    = Math.abs(user.tp - dyn.tp) / Math.max(5, dyn.tp);
  const slDiff    = Math.abs(user.sl - dyn.sl) / Math.max(1, dyn.sl);
  const trlDiff   = Math.abs(user.trailPct - dyn.trailPct) / Math.max(2, dyn.trailPct || 1);
  const armDiff   = Math.abs(user.arm - dyn.arm) / Math.max(1, dyn.arm || 1);
  const totalDiff = tpDiff + slDiff + trlDiff + armDiff;

  const goodFit = !hardWacked && totalDiff <= 0.60;

  if (goodFit) {
    log(`TP/SL check ${mint.slice(0,4)}… looks solid — keeping your config (TP=${user.tp}% SL=${user.sl}% Trail=${user.trailPct}% Arm=${user.arm}%).`);
    return { ...user, used: "user" };
  }

  log(`TP/SL check ${mint.slice(0,4)}… your settings look off — applying dynamic: TP=${dyn.tp}% SL=${dyn.sl}% Trail=${dyn.trailPct}% Arm=${dyn.arm}% (${dyn.tier} I=${dyn.intensity.toFixed(2)})`);
  return { ...dyn, used: "dynamic" };
}

function retunePositionFromFinalGate(mint) {
  try {
    if (!mint || !state.positions || !state.positions[mint]) return;
    const pos = state.positions[mint];
    const sel = pickTpSlForMint(mint);
    pos.tpPct = sel.tp;
    pos.slPct = sel.sl;
    pos.trailPct = sel.trailPct;
    pos.minProfitToTrailPct = sel.arm;
    save();
  } catch {}
}

function runFinalPumpGateBackground() {
  const cfg = state;
  if (!cfg.finalPumpGateEnabled) return;

  const store = _getFinalPumpGateStore();
  const nowTs = now();

  let leaders;
  try {
    leaders = computePumpingLeaders(5) || [];
  } catch {
    leaders = [];
  }

  const byMint = new Map();
  for (const it of leaders) {
    if (!it?.mint) continue;
    const sc = Number(it.pumpScore);
    if (!Number.isFinite(sc)) continue;
    byMint.set(it.mint, sc);
  }

  for (const [mint, scoreNow] of byMint.entries()) {
    const rec = store.get(mint);
    if (!rec) {
      if (scoreNow < cfg.finalPumpGateMinStart) {
        log(
          `Final gate: ${mint.slice(0,4)}… rejected, pumpScore ${scoreNow.toFixed(3)} < minStart ${cfg.finalPumpGateMinStart}.`,
          'err'
        );
        continue;
      }
      store.set(mint, { startScore: scoreNow, at: nowTs, ready: false });
      log(
        `Final gate: tracking ${mint.slice(0,4)}… startScore=${scoreNow.toFixed(3)} for Δ≥${cfg.finalPumpGateDelta}.`,
        'info'
      );
      continue;
    }

    if (rec.ready) {
      if (nowTs - rec.at > cfg.finalPumpGateWindowMs * 3) {
        store.delete(mint);
      }
      continue;
    }

    const elapsed = nowTs - rec.at;
    const delta = scoreNow - rec.startScore;

    if (elapsed > cfg.finalPumpGateWindowMs) {
      log(
        `Final gate: ${mint.slice(0,4)}… FAILED, Δscore=${delta.toFixed(3)} within ${(elapsed/1000).toFixed(1)}s (need ≥${cfg.finalPumpGateDelta}).`,
        'warn'
      );
      store.delete(mint);
      continue;
    }

    if (delta >= cfg.finalPumpGateDelta) {
      log(
        `Final gate: ${mint.slice(0,4)}… PASSED, Δscore=${delta.toFixed(3)} in ${(elapsed/1000).toFixed(1)}s. Ready to buy.`,
        'info'
      );
      store.set(mint, { ...rec, ready: true, at: nowTs, passDelta: delta, elapsedMs: elapsed });
      try { retunePositionFromFinalGate(mint); } catch {}
      continue;
    }

    logFastObserverSample(mint, {
      pumpGateStart: rec.startScore,
      pumpGateScoreNow: scoreNow,
      pumpGateDelta: delta,
      pumpGateElapsedMs: elapsed,
    });
  }

  for (const [mint, rec] of store.entries()) {
    if (!byMint.has(mint) && nowTs - rec.at > cfg.finalPumpGateWindowMs) {
      store.delete(mint);
    }
  }
}

function ensureFinalPumpGateTracking(mint, nowTs = now()) {
  try {
    const cfg = state;
    if (!cfg.finalPumpGateEnabled || !mint) return false;
    const store = _getFinalPumpGateStore();
    if (store.has(mint)) return true;

    let it = null;
    try {
      const leaders = computePumpingLeaders(10) || [];
      it = leaders.find(x => x?.mint === mint) || null;
    } catch {}

    const sc = Number(it?.pumpScore);
    if (Number.isFinite(sc) && sc >= cfg.finalPumpGateMinStart) {
      store.set(mint, { startScore: sc, at: nowTs, ready: false });
      log(`Final gate: tracking ${mint.slice(0,4)}… startScore=${sc.toFixed(3)} for Δ≥${cfg.finalPumpGateDelta}.`, 'warn');
      return true;
    }
  } catch {}
  return false;
}

// function finalPumpGatePasses(mint, { it = null } = {}, nowTs = now()) {
//   return isFinalPumpGateReady(mint);
// }

async function focusMintAndRecord(mint, { refresh = true, ttlMs = 2000, signal } = {}) {
  try {
    if (!mint) return null;
    if (!window._fdvFocusLast) window._fdvFocusLast = new Map();
    const nowTs = now();
    const last = Number(window._fdvFocusLast.get(mint) || 0);
    // throttle per-mint focus calls
    if (nowTs - last < Math.max(1200, Number(state.tickMs || 2000))) return null;

    const res = await focusMint(mint, { refresh, ttlMs, signal });
    window._fdvFocusLast.set(mint, nowTs);

    if (res?.ok && res.row) {
      const r = res.row;
      recordLeaderSample(mint, {
        pumpScore: Number(res.pumpScore ?? r.metric ?? 0),
        liqUsd:    Number(r.liqUsd ?? 0),
        v1h:       Number(r.v1hTotal ?? r.v1h ?? 0),
        chg5m:     Number(r.chg5m ?? 0),
        chg1h:     Number(r.chg1h ?? 0),
      });
    }
    return res;
  } catch {
    return null;
  }
}

async function observeMintOnce(mint, opts = {}) {
  if (!mint) return { ok: false, passes: 0 };

  const windowMs = Number.isFinite(opts.windowMs) ? opts.windowMs : Math.max(1800, Math.floor((state.tickMs || 2000) * 1.1));
  const sampleMs = Number.isFinite(opts.sampleMs) ? opts.sampleMs : Math.max(500, Math.floor(windowMs / 3.2));
  const minPasses = Number.isFinite(opts.minPasses) ? opts.minPasses : 3;
  const adjustHold = !!opts.adjustHold;

  const findLeader = () => {
    try { return (computePumpingLeaders(3) || []).find(x => x?.mint === mint) || null; } catch { return null; }
  };

  let it0 = findLeader();
  if (!it0) {
    try {
      const foc = await focusMint(mint, { refresh: true, ttlMs: 2000 });
      if (foc?.ok && foc.row) {
        it0 = {
          pumpScore: Number(foc.pumpScore || 0),
          kp: {
            liqUsd: Number(foc.row.liqUsd || 0),
            v1hTotal: Number(foc.row.v1hTotal || 0),
            change5m: Number(foc.row.chg5m || 0),
            change1h: Number(foc.row.chg1h || 0),
          },
        };
      }
    } catch {}
  }
  if (!it0) {
    noteObserverConsider(mint, 30_000);
    log(`Observer: ${mint.slice(0,4)}… not in leaders; using focus failed; skip.`);
    return { ok: false, passes: 0, unavailable: true, reason: "focus_unavailable" };
  }

  const kp0 = it0.kp || {};
  const s0 = {
    pumpScore: safeNum(it0.pumpScore, 0),
    liqUsd:    safeNum(kp0.liqUsd, 0),
    v1h:       safeNum(kp0.v1hTotal, 0),
    chg5m:     safeNum(kp0.change5m, 0),
    chg1h:     safeNum(kp0.change1h, 0),
  };

  const start = now();
  let sN = s0;
  while (now() - start < windowMs) {
    await new Promise(r => setTimeout(r, sampleMs));
    let itN = findLeader();
    if (!itN) {
      try {
        const foc = await focusMint(mint, { refresh: true, ttlMs: 2000 });
        if (foc?.ok && foc.row) {
          itN = {
            pumpScore: Number(foc.pumpScore || 0),
            kp: {
              liqUsd: Number(foc.row.liqUsd || 0),
              v1hTotal: Number(foc.row.v1hTotal || 0),
              change5m: Number(foc.row.chg5m || 0),
              change1h: Number(foc.row.chg1h || 0),
            },
          };
        }
      } catch {}
    }
    if (!itN) {
      log(`Observer: ${mint.slice(0,4)}… dropped; focus unavailable; skip.`);
      return { ok: false, passes: 0, unavailable: true, reason: "focus_unavailable" };
    }

    const kpN = itN.kp || {};
    sN = {
      pumpScore: safeNum(itN.pumpScore, 0),
      liqUsd:    safeNum(kpN.liqUsd, 0),
      v1h:       safeNum(kpN.v1hTotal, 0),
      chg5m:     safeNum(kpN.change5m, 0),
      chg1h:     safeNum(kpN.change1h, 0),
    };
  }

  const series = getLeaderSeries(mint, 3);
  let base = s0, last = sN, usingTrend = false;
  if (series && series.length >= 3) {
    base = series[0];
    last = series[series.length - 1];
    usingTrend = true;
  }
  const passChg   = last.chg5m > base.chg5m;               // momentum up
  const passVol   = last.v1h   >= base.v1h;                 // volume non-decreasing
  const passLiq   = last.liqUsd>= base.liqUsd * 0.98;       // liquidity stable
  const passScore = last.pumpScore >= base.pumpScore * 0.98;// composite score stable/up


  let passes = 0;
  if (passChg) passes++;
  if (passVol) passes++;
  if (passLiq) passes++;
  if (passScore) passes++;
  // if (sN.pumpScore > s0.pumpScore && sN.chg5m > s0.chg5m) passes++;
  if (last.pumpScore > base.pumpScore && last.chg5m > base.chg5m) passes++;

  if (passes < 3) {
    setMintBlacklist(mint); // staged reverse log spam and broken holds (2m/15m/30m)
    log(`Observer: reject ${mint.slice(0,4)}… (score ${passes}/5); staged blacklist.`);
    return { ok: false, passes };
  }

  const holdSecs = recommendDynamicHoldSecs(passes);
  if (passes >= minPasses) {
    if (adjustHold) {
      const _clamped = clampHoldSecs(holdSecs);
      if (state.maxHoldSecs !== _clamped) { state.maxHoldSecs = _clamped; save(); }
    }
    //log(`Observer: approve ${mint.slice(0,4)}… (score ${passes}/5)`);
    log(`Observer: approve ${mint.slice(0,4)}… (score ${passes}/5)${usingTrend ? " [3-tick trend]" : ""}`);

    return { ok: true, passes, holdSecs };
  }

  // log(`Observer: consider ${mint.slice(0,4)}… (score ${passes}/5)`);
  log(`Observer: consider ${mint.slice(0,4)}… (score ${passes}/5)${usingTrend ? " [3-tick trend]" : ""}`);
  return { ok: false, passes, holdSecs };
}

async function ataExists(ownerPubkeyStr, mintStr) {
  try {
    const ata = await getOwnerAta(ownerPubkeyStr, mintStr);
    if (!ata) return false;
    const conn = await getConn();
    const ai = await conn.getAccountInfo(ata, "processed");
    return !!ai;
  } catch {
    return false;
  }
}

async function getOwnerAta(ownerPubkeyStr, mintStr, programIdOverride) {
  const { PublicKey } = await loadWeb3();
  const { getAssociatedTokenAddress, TOKEN_PROGRAM_ID } = await loadSplToken();
  try {
    const owner = new PublicKey(ownerPubkeyStr);
    const mint = new PublicKey(mintStr);
    const pid = programIdOverride || TOKEN_PROGRAM_ID;
    const ataAny = await getAssociatedTokenAddress(mint, owner, true, pid);
    const ataStr = typeof ataAny === "string"
      ? ataAny
      : (ataAny?.toBase58 ? ataAny.toBase58() : (ataAny?.toString ? ataAny.toString() : ""));
    if (!ataStr) return null;
    return new PublicKey(ataStr);
  } catch {
    return null;
  }
}

async function getOwnerAtas(ownerPubkeyStr, mintStr) {
  const { TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID } = await loadSplToken();
  const out = [];
  try {
    const ata1 = await getOwnerAta(ownerPubkeyStr, mintStr, TOKEN_PROGRAM_ID);
    if (ata1) out.push({ programId: TOKEN_PROGRAM_ID, ata: ata1 });
  } catch {}
  try {
    if (TOKEN_2022_PROGRAM_ID) {
      const ata2 = await getOwnerAta(ownerPubkeyStr, mintStr, TOKEN_2022_PROGRAM_ID);
      if (ata2) out.push({ programId: TOKEN_2022_PROGRAM_ID, ata: ata2 });
    }
  } catch {}
  return out;
}

async function getAtaBalanceUi(ownerPubkeyStr, mintStr, decimalsHint, commitment = "confirmed") {
	return await _getDex().getAtaBalanceUi(ownerPubkeyStr, mintStr, decimalsHint, commitment);
}

export async function closeEmptyTokenAtas(signer, mint) {
  return _getDex().closeEmptyTokenAtas(signer, mint);
}

export async function closeAllEmptyAtas(signer) {
  return _getDex().closeAllEmptyAtas(signer);
}

async function syncPositionsFromChain(ownerPubkeyStr) {
  try {
    log("Syncing positions from cache …");
    const nowTs = now();

    const cachedListRaw = cacheToList(ownerPubkeyStr);
    const cachedList = [];
    for (const it of cachedListRaw) {
      const ok = await isValidPubkeyStr(it.mint).catch(()=>false);
      if (ok) cachedList.push(it);
      else {
        log(`Cache mint invalid, pruning: ${String(it.mint).slice(0,6)}…`);
        removeFromPosCache(ownerPubkeyStr, it.mint);
      }
    }
    const cachedSet = new Set(cachedList.map(x => x.mint));

    for (const { mint, sizeUi, decimals } of cachedList) {
      const prev = state.positions[mint] || { costSol: 0, hwmSol: 0, acquiredAt: nowTs };
      const next = {
        ...prev,
        sizeUi: Number(sizeUi || 0),
        decimals: Number.isFinite(decimals) ? decimals : (prev.decimals ?? 6),
        lastSeenAt: nowTs,
      };
      if (next.awaitingSizeSync && Number(next.sizeUi || 0) > 0) next.awaitingSizeSync = false;
      state.positions[mint] = next;
    }

    for (const mint of Object.keys(state.positions || {})) {
      if (mint === SOL_MINT) continue;
      if (!cachedSet.has(mint)) {
        const pos = state.positions[mint];
        const ageMs = nowTs - Number(pos?.lastBuyAt || pos?.acquiredAt || 0);
        const withinGrace = !!pos?.awaitingSizeSync && ageMs < Math.max(5000, Number(state.pendingGraceMs || 20000));
        const hasPending = hasPendingCredit(ownerPubkeyStr, mint);
        if (withinGrace || hasPending) {
          // Keep awaiting positions for a short grace window. Very important to avoid
          // premature deletions while on-chain finality is pending.
          continue;
        }
        delete state.positions[mint];
      }
    }

    save();
  } catch (e) {
    log(`Sync failed: ${e.message || e}`);
  }
}

async function pruneZeroBalancePositions(ownerPubkeyStr, opts = {}) {
  const limit = Number.isFinite(opts?.limit) ? Math.max(0, opts.limit) : 8;
  if (!limit) return;

  const nowTs = now();
  const candidates = [];

  try {
    for (const mint of Object.keys(state.positions || {})) {
      if (!mint || mint === SOL_MINT) continue;
      candidates.push(mint);
    }
  } catch {}

  try {
    const cached = cacheToList(ownerPubkeyStr) || [];
    for (const it of cached) {
      const mint = String(it?.mint || "");
      if (!mint || mint === SOL_MINT) continue;
      candidates.push(mint);
    }
  } catch {}

  const seen = new Set();
  const unique = [];
  for (const mint of candidates) {
    if (!mint || seen.has(mint)) continue;
    seen.add(mint);
    unique.push(mint);
    if (unique.length >= limit) break;
  }

  if (!unique.length) return;

  let changed = false;
  for (const mint of unique) {
    try {
      const pos = state.positions?.[mint];
      const ageMs = nowTs - Number(pos?.lastBuyAt || pos?.acquiredAt || 0);
      const withinGrace = !!pos?.awaitingSizeSync && ageMs < Math.max(5000, Number(state.pendingGraceMs || 20000));
      const hasPending = (() => { try { return hasPendingCredit(ownerPubkeyStr, mint); } catch { return false; } })();
      if (withinGrace || hasPending) continue;

      const b = await getAtaBalanceUi(ownerPubkeyStr, mint, pos?.decimals);
      const uiAmt = Number(b?.sizeUi || 0);
      if (uiAmt > 0) continue;

      try { removeFromPosCache(ownerPubkeyStr, mint); } catch {}
      try { removeFromDustCache(ownerPubkeyStr, mint); } catch {}
      try { clearPendingCredit(ownerPubkeyStr, mint); } catch {}

      if (state.positions?.[mint]) {
        delete state.positions[mint];
        changed = true;
      }
    } catch {
      // best-effort pruning only
    }
  }

  if (changed) save();
}

async function sweepNonSolToSolAtStart() {
  const kp = await getAutoKeypair();
  if (!kp) { log("Auto wallet not ready; skipping startup sweep."); return; }
  log("Startup sweep: checking cached SPL balances …");

  const owner = kp.publicKey.toBase58();
  const cached = cacheToList(owner);
  if (!cached.length) { log("Startup sweep: no SPL balances in cache."); return; }

  const items = [];
  for (const it of cached) {
    const ok = await isValidPubkeyStr(it.mint).catch(()=>false);
    if (ok) items.push(it);
    else {
      log(`Cache mint invalid, pruning: ${String(it.mint).slice(0,6)}…`);
      removeFromPosCache(owner, it.mint);
    }
  }

  if (!items.length) { log("Startup sweep: no valid cached SPL balances."); return; }

  let sold = 0, unsellable = 0;
  for (const { mint, sizeUi, decimals } of items) {
    try {
    // Always trust real on-chain balance over cache to avoid selling ghosts.
    const b = await getAtaBalanceUi(owner, mint, decimals).catch(() => null);
    const realUi = Number(b?.sizeUi || 0);
    const realDec = Number.isFinite(Number(b?.decimals)) ? Number(b.decimals) : Number(decimals || 0);
    if (!Number.isFinite(realUi) || realUi <= 0) {
    try { removeFromPosCache(owner, mint); } catch {}
    try { removeFromDustCache(owner, mint); } catch {}
    try { clearPendingCredit(owner, mint); } catch {}
    if (state.positions?.[mint]) { delete state.positions[mint]; save(); }
    continue;
    }

    const estSol = await quoteOutSol(mint, realUi, realDec).catch(() => 0);
      const minNotional = minSellNotionalSol();
      if (estSol < minNotional) {
    moveRemainderToDust(owner, mint, realUi, realDec);
        unsellable++;
        continue;
      }

      const res = await _getDex().sellWithConfirm(
    { signer: kp, mint, amountUi: realUi, slippageBps: state.slippageBps },
        { retries: 1, confirmMs: 15000, closeWsolAta: false },
      );

    try { _noteDexTx("sell", mint, res, { amountUi: realUi, slippageBps: state.slippageBps }); } catch {}

    if (!res?.ok) {
    // No-balance: stale cache/position entry; prune silently.
    if (res?.noBalance) {
      try { removeFromPosCache(owner, mint); } catch {}
      try { removeFromDustCache(owner, mint); } catch {}
      try { clearPendingCredit(owner, mint); } catch {}
      if (state.positions?.[mint]) { delete state.positions[mint]; save(); }
      continue;
    }
    // No-route/dust: keep it out of positions to avoid endless retry spam.
    if (res?.noRoute || /ROUTER_DUST|NO_ROUTE/i.test(String(res?.msg || ""))) {
      moveRemainderToDust(owner, mint, realUi, realDec);
      unsellable++;
      continue;
    }
    throw new Error(String(res?.msg || "route execution failed"));
    }

    log(`Startup sweep sold ${realUi.toFixed(6)} ${mint.slice(0,4)}… -> ~${estSol.toFixed(6)} SOL`);
      try { setTimeout(() => { closeEmptyTokenAtas(kp, mint).catch(() => {}); }, 1600); } catch {}
      const costSold = Number(state.positions[mint]?.costSol || 0);
      await _addRealizedPnl(estSol, costSold, "Startup sweep PnL");
      if (state.positions[mint]) { delete state.positions[mint]; save(); }
      removeFromPosCache(owner, mint);
      try { clearPendingCredit(owner, mint); } catch {}
      sold++;
      await new Promise(r => setTimeout(r, 250));
    } catch (e) {
      log(`Startup sweep sell failed ${mint.slice(0,4)}…: ${e.message || e}`);
    }
  }

  log(`Startup sweep complete. Sold ${sold} token${sold===1?"":"s"}. ${unsellable} dust/unsellable skipped.`);
  if (sold > 0) { state.lastTradeTs = now(); save(); }
}

async function sweepDustToSolAtStart() {
  if (!state.dustExitEnabled) return;
  const kp = await getAutoKeypair();
  if (!kp) { log("Auto wallet not ready; skipping dust sweep."); return; }

  const owner = kp.publicKey.toBase58();
  log("Startup dust sweep: checking dust cache …");


  await sanitizeDustCache(owner);




  const dust = dustCacheToList(owner) || [];
  if (!dust.length) {
    log("Startup dust sweep: no entries.");
    return;
  }

  let sold = 0, kept = 0, pruned = 0;
  for (const it of dust) {
    const mint = it.mint;
    const validMint = await isValidPubkeyStr(mint).catch(() => false);
    if (!validMint) {
      removeFromDustCache(owner, mint);
      removeFromPosCache(owner, mint);
      pruned++;
      continue;
    }

    try {
      const b = await getAtaBalanceUi(owner, mint, it.decimals);
      const uiAmt = Number(b.sizeUi || 0);
      const dec = Number.isFinite(b.decimals) ? b.decimals : (it.decimals ?? 6);

      if (uiAmt <= 0) {
        removeFromDustCache(owner, mint);
        removeFromPosCache(owner, mint); // ensure no stale pos cache
        pruned++;
        continue;
      }

      let estSol = 0;
      try { estSol = await quoteOutSol(mint, uiAmt, dec); } catch {}
      const minNotional = minSellNotionalSol();
      if (estSol < minNotional) {
        kept++;
        continue;
      }

      const res = await _getDex().sellWithConfirm(
        { signer: kp, mint, amountUi: uiAmt, slippageBps: state.slippageBps },
        { retries: 2, confirmMs: 15000, closeWsolAta: false },
      );

      try { _noteDexTx("sell", mint, res, { amountUi: uiAmt, slippageBps: state.slippageBps }); } catch {}

      if (!res.ok) {
        if (res.noRoute) setRouterHold(mint, ROUTER_COOLDOWN_MS);
        log(`Dust sweep sell not confirmed for ${mint.slice(0,4)}… keeping in dust.`);
        kept++;
        continue;
      }

      // Handle partial debit remainder
      let remainUi = 0, remDec = dec;
      try {
        const debit = await waitForTokenDebit(owner, mint, uiAmt, { timeoutMs: 20000, pollMs: 350 });
        remainUi = Number(debit.remainUi || 0);
        if (Number.isFinite(debit.decimals)) remDec = debit.decimals;
      } catch {
        try {
          const bb = await getAtaBalanceUi(owner, mint, dec);
          remainUi = Number(bb.sizeUi || 0);
          if (Number.isFinite(bb.decimals)) remDec = bb.decimals;
        } catch {}
      }

      if (remainUi > 1e-9) {
        const estRemainSol = await quoteOutSol(mint, remainUi, remDec).catch(() => 0);
        const minN = minSellNotionalSol();
        if (estRemainSol >= minN) {
          updatePosCache(owner, mint, remainUi, remDec);
          removeFromDustCache(owner, mint);
          const prev = state.positions[mint] || { costSol: 0, hwmSol: 0, acquiredAt: now() };
          state.positions[mint] = { ...prev, sizeUi: remainUi, decimals: remDec, lastSeenAt: now() };
          save();
          setRouterHold(mint, ROUTER_COOLDOWN_MS);
          log(`Dust sweep partial: remain ${remainUi.toFixed(6)} ${mint.slice(0,4)}… promoted from dust.`);
        } else {
          addToDustCache(owner, mint, remainUi, remDec);
          log(`Dust sweep partial: remain ${remainUi.toFixed(6)} ${mint.slice(0,4)}… stays in dust.`);
        }
      } else {
        removeFromDustCache(owner, mint);
        removeFromPosCache(owner, mint);
        try { clearPendingCredit(owner, mint); } catch {}
        if (state.positions[mint]) { delete state.positions[mint]; save(); }
        log(`Dust sweep sold ${uiAmt.toFixed(6)} ${mint.slice(0,4)}… -> ~${estSol.toFixed(6)} SOL`);
        // Full exit: try closing now-empty token ATA(s) to reclaim rent.
        try { await closeEmptyTokenAtas(kp, mint); } catch {}
        sold++;
      }
      await new Promise(r => setTimeout(r, 200));
    } catch (e) {
      log(`Dust sweep sell failed ${mint.slice(0,4)}…: ${e.message || e}`);
      kept++;
    }
  }

  log(`Startup dust sweep complete. Sold ${sold}, kept ${kept}, pruned ${pruned}.`);
}

function shouldSell(pos, curSol, nowTs) {
  const sz = Number(pos.sizeUi || 0);
  const cost = Number(pos.costSol || 0);
  if (!Number.isFinite(curSol) || curSol <= 0) return { action: "none" };
  if (cost <= 0 || sz <= 0) return { action: "none" };

  if (pos.awaitingSizeSync) return { action: "none", reason: "awaiting-size-sync" };

  const maxHold = Math.max(0, Number(state.maxHoldSecs || 0));
  if (maxHold > 0) {
    const ageMs = nowTs - Number(pos.acquiredAt || pos.lastBuyAt || 0);
    if (ageMs >= maxHold * 1000) {
      return { action: "sell_all", reason: `max-hold>${maxHold}s` };
    }
  }

  const lastBuyAt = Number(pos.lastBuyAt || pos.acquiredAt || 0);
  if (lastBuyAt && nowTs - lastBuyAt < (state.coolDownSecsAfterBuy|0) * 1000) {
    return { action: "none", reason: "cooldown" };
  }

  const sellCd = Math.max(5_000, Number(state.sellCooldownMs || 20_000));
  if (pos.lastSellAt && nowTs - pos.lastSellAt < sellCd) {
    return { action: "none", reason: "sell-cooldown" };
  }

  if (state.minHoldSecs > 0 && pos.acquiredAt && (nowTs - pos.acquiredAt) < state.minHoldSecs * 1000) {
    return { action: "none", reason: "min-hold" };
  }

  const pxNow = curSol / sz;
  const pxCost = cost / sz;
  pos.hwmPx = Math.max(Number(pos.hwmPx || 0) || pxNow, pxNow);

  const pnlPct   = ((pxNow - pxCost) / Math.max(1e-12, pxCost)) * 100;
  const tp       = Math.max(0, Number(pos.tpPct ?? state.takeProfitPct ?? 0));
  const sl       = Math.max(0, Number(pos.slPct ?? state.stopLossPct ?? 0));
  const trail    = Math.max(0, Number(pos.trailPct ?? state.trailPct ?? 0));
  const armTrail = Math.max(0, Number(pos.minProfitToTrailPct ?? state.minProfitToTrailPct ?? 0));
  const partialPct = Math.min(100, Math.max(0, Number(state.partialTpPct || 0)));

  if (sl > 0 && pnlPct <= -sl) return { action: "sell_all", reason: `SL ${pnlPct.toFixed(2)}%` };

  if (tp > 0 && pnlPct >= tp) {
    if (partialPct > 0 && partialPct < 100) {
      return { action: "sell_partial", pct: partialPct, reason: `TP ${pnlPct.toFixed(2)}% (${partialPct}%)` };
    }
    return { action: "sell_all", reason: `TP ${pnlPct.toFixed(2)}%` };
  }

  if (trail > 0 && pnlPct >= armTrail && pos.hwmPx > 0) {
    const drawdownPct = ((pos.hwmPx - pxNow) / pos.hwmPx) * 100;
    if (drawdownPct >= trail) {
      return { action: "sell_all", reason: `Trail -${drawdownPct.toFixed(2)}%` };
    }
  }

  return { action: "none" };
}

function fastDropCheck(mint, pos) {
  try {
    const sig = getRugSignalForMint(mint);

    const sev = Number(sig?.sev ?? 0);
    if (sig?.rugged && sev >= RUG_FORCE_SELL_SEVERITY) {
      return { trigger: true, reason: `rug sev=${sev.toFixed(2)}`, sev };
    }

    const badge = String(sig?.badge || "").toLowerCase();
    if (badge.includes("calm")) {
      const sz = Number(pos.sizeUi || 0);
      const curSol = Number(pos.lastQuotedSol || 0);
      if (sz > 0 && curSol > 0 && Number(pos.hwmPx || 0) > 0) {
        const pxNow = curSol / sz;
        const ddPct = ((pos.hwmPx - pxNow) / Math.max(1e-12, pos.hwmPx)) * 100;
        if (ddPct >= Math.max(1.5, Number(state.observerDropTrailPct || 2.5))) {
          return { trigger: true, reason: "pump->calm drawdown", sev: 1 };
        }
      }
    }

    const series = getLeaderSeries(mint, 3);
    if (series && series.length >= 3) {
      const a = series[0], c = series[series.length - 1];
      const scSlopeMin = _clamp(slope3pm(series, "pumpScore"), -20, 20);
      const chgSlopeMin= _clamp(slope3pm(series, "chg5m"),    -60, 60);
      const passChg    = c.chg5m <= a.chg5m;
      const passScore  = c.pumpScore <= a.pumpScore * 0.97;
      if (passChg && passScore && (scSlopeMin < 0 || chgSlopeMin < 0)) {
			// Momentum drops are informational only (used for risk/rug context), not exit triggers.
			return { trigger: false, reason: "momentum drop (3/5)", sev: 0.55, momentum: true };
      }
    }
  } catch {}
  return { trigger: false };
}

function startFastObserver() {
  if (window._fdvFastObsTimer) return;
  window._fdvFastObsTimer = setInterval(() => {
    try {
      const entries = Object.entries(state.positions || {});
      if (!entries.length) return;

      for (const [mint, pos] of entries) {
        if (!mint || mint === SOL_MINT) continue;
        if (Number(pos.sizeUi || 0) <= 0) continue;

        logFastObserverSample(mint, pos);

        const ageMs = now() - Number(pos.lastBuyAt || pos.acquiredAt || 0);
        const postBuyCooldownMs = Math.max(8_000, Number(state.coolDownSecsAfterBuy || 0) * 1000);
        const inWarmingHold = !!(state.rideWarming && pos.warmingHold === true);

        const minHoldMs = Math.max(0, Number(state.minHoldSecs || 0) * 1000);
        const inMinHold = minHoldMs > 0 && ageMs < minHoldMs;

        const r = fastDropCheck(mint, pos);

        try {
          const momStore = _getMomentumDropStore();
          const rec = momStore.get(mint) || { count: 0, lastAt: 0, lastCountAt: 0 };
          const isMom = r.trigger && /momentum\s*drop/i.test(String(r.reason || ""));
          const nowTs = now();
          const minCountGapMs = Math.max(150, Number(LEADER_SAMPLE_MIN_MS || 0) || 0);

          if (isMom && !inMinHold) {
            // With a fast observer cadence (e.g. 5ms), require spacing between increments
            if ((nowTs - Number(rec.lastCountAt || 0)) >= minCountGapMs) {
              rec.count = (rec.count | 0) + 1;
              rec.lastCountAt = nowTs;
            }

            // Only arm if outside immediate post-buy guard
            if (rec.count >= MOMENTUM_FORCED_EXIT_CONSEC && ageMs >= postBuyCooldownMs) {
              rec.count = 0;
            }
          } else {
            // Reset during min-hold or when momentum signal is absent.
            rec.count = 0;
            rec.lastCountAt = nowTs;
          }

          rec.lastAt = nowTs;
          momStore.set(mint, rec);
        } catch {}

        if (r.trigger && ageMs < EARLY_URGENT_WINDOW_MS && Number(r.sev || 0) >= 0.6) {
          flagUrgentSell(mint, r.reason, r.sev);
          continue;
        }

        // Suppress general urgency while unsynced/warming or during post-buy cooldown
        if (pos.awaitingSizeSync === true) continue;
        if (!inWarmingHold && ageMs < Math.max(URGENT_SELL_MIN_AGE_MS, postBuyCooldownMs)) continue;

        if (r.trigger) flagUrgentSell(mint, r.reason, r.sev);
      }
    } catch {}
  }, FAST_OBS_INTERVAL_MS);
  log(`Fast observer started @ ${FAST_OBS_INTERVAL_MS}ms cadence.`);
}

function stopFastObserver() {
  try { if (window._fdvFastObsTimer) clearInterval(window._fdvFastObsTimer); } catch {}
  window._fdvFastObsTimer = null;
  log("Fast observer stopped.");
}

async function verifyRealTokenBalance(ownerPub, mint, pos) {
  // Kill wallet Phantom balances
  try {
    if (!ownerPub || !mint || !pos) return { ok: false, reason: "bad_args" };
    if (mint === SOL_MINT) return { ok: true, sizeUi: 0 };

    const bal = await getAtaBalanceUi(ownerPub, mint, pos.decimals, "confirmed");
    const chainUi = Number(bal.sizeUi || 0);
    const exists = !!bal.exists;

    const ageMs = now() - Number(pos.lastBuyAt || pos.acquiredAt || 0);
    const graceMs = Math.max(10_000, Number(state.pendingGraceMs || 20_000));
    const pending = hasPendingCredit(ownerPub, mint);

    if ((!exists || chainUi <= 1e-9) && Number(pos.sizeUi || 0) > 0 && !pending && ageMs > graceMs) {
      try { removeFromPosCache(ownerPub, mint); } catch {}
      try { removeFromDustCache(ownerPub, mint); } catch {}
      try { clearPendingCredit(ownerPub, mint); } catch {}
      delete state.positions[mint];
      save();
      log(`Phantom position removed: ${mint.slice(0,4)}… (no on-chain balance).`);
      return { ok: false, purged: true, reason: "phantom" };
    }
    const cachedUi = Number(pos.sizeUi || 0);
    if (chainUi > 0 && Math.abs(chainUi - cachedUi) / Math.max(chainUi, 1e-9) > 0.05) {
      pos.sizeUi = chainUi;
      pos.awaitingSizeSync = false;
      updatePosCache(ownerPub, mint, chainUi, bal.decimals);
      save();
      log(`Position size reconciled from chain: ${mint.slice(0,4)}… -> ${chainUi.toFixed(6)}.`);
    }

    return { ok: true, sizeUi: chainUi };
  } catch (e) {
    log(`verifyRealTokenBalance error ${mint.slice(0,4)}…: ${e.message||e}`, 'err');
    return { ok: false, reason: "error" };
  }
}

function shouldApplyWarmingHold(mint, pos, nowTs) {
  try {
    if (isPumpDropBanned(mint) || isMintBlacklisted(mint)) return false;
    // Profit-decay hold is a global mechanic (applies to all buys) when enabled.
    return true;
  } catch { return false; }
}

function applyWarmingPolicy({ mint, pos, nowTs, pnlNetPct, pnlPct, curSol, decision, forceRug, forcePumpDrop, forceObserverDrop, forceEarlyFade }) {
  const result = { decision, forceObserverDrop, forcePumpDrop, warmingActive: false, warmingHoldActive: false, warmingMaxLossTriggered: false };
  try {
    const warmingActive = !!(state.rideWarming && pos.warmingHold === true);
    result.warmingActive = warmingActive;
    if (!warmingActive) return result;

    const pnl = Number.isFinite(pnlNetPct) ? pnlNetPct : pnlPct;

    if (!shouldApplyWarmingHold(mint, pos, nowTs)) {
      pos.warmingHold = false;
      pos.warmingClearedAt = now();
      delete pos.warmingExtendUntil;
      save();
      log(`Warming disabled for ${mint.slice(0,4)}… (regime not favorable).`);
      return result;
    }

    const warmAgeMs = nowTs - Number(pos.warmingHoldAt || pos.lastBuyAt || pos.acquiredAt || 0);
    const maxLossPctCfg = Math.max(1, Number(state.warmingMaxLossPct || 6));
    const maxLossWindowMs = Math.max(5_000, Number(state.warmingMaxLossWindowSecs || 60) * 1000);
    if (warmAgeMs <= maxLossWindowMs) {
      if (Number.isFinite(pnl) && pnl <= -maxLossPctCfg) {
        const msg = `WARMING MAX LOSS ${pnl.toFixed(2)}% <= -${maxLossPctCfg}%`;
        log(`Warming max-loss hit for ${mint.slice(0,4)}… (${msg}). Selling now.`);
        pos.warmingHold = false;
        pos.warmingClearedAt = now();
        delete pos.warmingExtendUntil;
        save();
        result.decision = { action: "sell_all", reason: msg };
        result.warmingMaxLossTriggered = true;
        return result;
      }
    }

    const warmReq = computeWarmingRequirement(pos, nowTs);
    const ext = isWarmingHoldActive(mint, pos, warmReq, nowTs);
    result.warmingHoldActive = !!ext.active;

    if (Number.isFinite(pnl) && pnl >= warmReq.req) {
      pos.warmingHold = false;
      pos.warmingClearedAt = now();
      delete pos.warmingExtendUntil;
      save();
      const msg = `WARMING_TARGET ${pnl.toFixed(2)}% ≥ ${warmReq.req.toFixed(2)}%`;
      result.decision = { action: "sell_all", reason: msg };
      log(`Warming target met for ${mint.slice(0,4)}… selling now (${msg}).`);
      return result;
    }

    if (warmReq.shouldAutoRelease && !result.warmingHoldActive && pos.warmingHold === true) {
      pos.warmingHold = false;
      pos.warmingClearedAt = now();
      delete pos.warmingExtendUntil;
      save();
      log(`Warming auto-release: ${mint.slice(0,4)}… (elapsed ${warmReq.elapsedTotalSec}s)`);
      return result; 
    }

    if (!result.warmingMaxLossTriggered &&
        result.warmingHoldActive &&
        pnl < warmReq.req &&
        !forceRug &&
        !forceEarlyFade) {
      if (result.forceObserverDrop || result.forcePumpDrop) {
        log(`Warming hold: suppressing volatility sell for ${mint.slice(0,4)}… (PnL ${pnl.toFixed(2)}% < ${warmReq.req.toFixed(2)}%).`);
      }
      result.forceObserverDrop = false;
      result.forcePumpDrop = false;

      const rsn = String(result.decision?.reason || "");
      const isHardOrFast = /rug|warming\s*max\s*loss|warming_target|FAST_/i.test(rsn);
      if (result.decision && result.decision.action !== "none" && !isHardOrFast) {
        log(`Warming hold: skipping sell (${result.decision.reason||"—"}) for ${mint.slice(0,4)}… (PnL ${pnl.toFixed(2)}% < ${warmReq.req.toFixed(2)}%).`);
        result.decision = { action: "none", reason: "warming-hold-until-profit" };
      }
    }

    if (warmReq.shouldAutoRelease && !result.warmingHoldActive && pos.warmingHold === true) {
      pos.warmingHold = false;
      pos.warmingClearedAt = now();
      delete pos.warmingExtendUntil;
      // start a grace window so TP/SL/trailing can take over before timers
      const graceMs = Math.max(10_000, Number(state.warmingPostReleaseGraceSecs || 60) * 1000);
      pos.postWarmGraceUntil = now() + graceMs;
      result.postReleaseGraceUntil = pos.postWarmGraceUntil;
      try { const sel = pickTpSlForMint(mint); pos.tpPct=sel.tp; pos.slPct=sel.sl; pos.trailPct=sel.trailPct; pos.minProfitToTrailPct=sel.arm; save(); } catch {}
      log(`Warming auto-release: ${mint.slice(0,4)}… (+${Math.floor(graceMs/1000)}s TP/SL grace)`);
      return result;
    }
  } catch {}
  return result;
}

function _mkSellCtx({ kp, mint, pos, nowTs }) {
  const ctx = {
    kp, mint, pos, nowTs,
    ownerStr: kp?.publicKey?.toBase58?.() || "",
    leaderMode: !!state.holdUntilLeaderSwitch,
    ageMs: 0,
    maxHold: 0,
    forceExpire: false,
    inSellGuard: false,
    forceMomentum: false,
    verified: false,
    hasPending: false,
    creditGraceMs: 0,
    sizeOk: false,
    forceRug: false,
    rugSev: 0,
    forcePumpDrop: false,
    forceObserverDrop: false,
    earlyReason: "",
    obsPasses: null,
    curSol: 0,
    curSolNet: 0,
    outLamports: 0,
    netEstimate: null,
    pxNow: 0,
    pxCost: 0,
    pnlPct: 0,
    pxNowNet: 0,
    pnlNetPct: 0,
    ageSec: 0,
    remorseSecs: 0,
    creditsPending: false,
    canHardStop: false,
    dynStopPct: null,
    decision: null,
    isFastExit: false,
    warmingHoldActive: false,
    fastResult: null,
    obsThreeShouldForce: false,
    minNotional: 0,
    skipSoftGates: false,
    postGrace: 0,
    postWarmGraceActive: false,
    inWarmingHold: false,

    // Extra signals for agent consumption (populated by Trader when possible)
    agentSignals: null,
	agentTune: null,
	agentTuneMeta: null,
  };
  return ctx;
}

function momentumForcePolicy(ctx) {
	// Momentum drop should never force an exit.
	return;
}

function profitFloorGatePolicy(ctx) {
  try {
    const d = ctx?.decision;
    if (!d || d.action === "none") return;

    if (ctx.forceRug) return;
    if (ctx.forceExpire) return;
    if (ctx.forcePumpDrop) return;
    if (ctx.forceObserverDrop) return;
    if (ctx.isFastExit) return;

  	const reason = String(d.reason || "");
  	if (/\b(URGENT|FAST_FADE)\b/i.test(reason)) return;
    if (/\bSL\b/i.test(reason)) return;
    if (/\bmax-hold\b/i.test(reason)) return;

    const floor = Math.max(0, Number(state.warmingMinProfitFloorPct ?? 0));
    const lossBypass = Math.min(0, Number(state.warmingProfitFloorLossBypassPct ?? -60));
    const pnl = Number.isFinite(ctx.pnlNetPct) ? Number(ctx.pnlNetPct) : Number(ctx.pnlPct);
    if (!Number.isFinite(pnl)) return;

    // Allow severe losses to exit (avoid getting trapped) even if profit-floor is enabled.
    if (pnl <= lossBypass) return;

    if (pnl < floor) {
      log(
        `Profit floor: suppressing sell for ${ctx.mint.slice(0,4)}… netPnL=${pnl.toFixed(2)}% < ${floor.toFixed(2)}% (${String(d.reason || "").slice(0, 60)})`
      );
      ctx.decision = { action: "none", reason: "profit-floor" };
      ctx.isFastExit = false;
      ctx.stop = true;
    }
  } catch {}
}

async function runPipeline(ctx, steps = []) {
  let lastDecisionSig = "";
  for (const step of steps) {
    const fn = (typeof step === "function")
      ? step
      : (typeof step?.fn === "function" ? step.fn : (typeof step?.run === "function" ? step.run : null));
    if (typeof fn !== "function") continue;

    const name = (typeof step === "function")
      ? (step._fdvName || step.name || "(anonymous)")
      : (step?.name || step?.id || fn._fdvName || fn.name || "(anonymous)");

    const prev = ctx?.decision;
    const prevSig = prev ? `${String(prev.action || "")}::${String(prev.reason || "")}` : "";

    let out;
    const dbgOn = _dbgSellEnabled();
    if (dbgOn) {
      _dbgSell(`pipeline:step:begin:${name}`, {
        mint: ctx?.mint,
        decision: ctx?.decision || null,
        pnlPct: Number(ctx?.pnlPct ?? 0),
        pnlNetPct: Number(ctx?.pnlNetPct ?? 0),
        curSol: Number(ctx?.curSol ?? 0),
        curSolNet: Number(ctx?.curSolNet ?? 0),
        hasPending: !!ctx?.hasPending,
        creditsPending: !!ctx?.creditsPending,
        warmingHoldActive: !!ctx?.warmingHoldActive,
        inWarmingHold: !!ctx?.inWarmingHold,
        skipSoftGates: !!ctx?.skipSoftGates,
        obsPasses: ctx?.obsPasses ?? null,
        isFastExit: !!ctx?.isFastExit,
      });
    }

    try {
      out = await fn(ctx);
      if (dbgOn) _dbgSell(`pipeline:step:return:${name}`, out);
      if (out && typeof out === "object") {
        // allow policies to optionally return partial updates
        Object.assign(ctx, out);
      }
    } catch (e) {
      if (dbgOn) {
        _dbgSell(`pipeline:step:error:${name}`, {
          err: String(e?.message || e || ""),
          stack: String(e?.stack || "").slice(0, 800),
        });
      }
      try { log(`Pipeline step failed (${name}): ${e.message || e}`, "err"); } catch {}
    }

    if (ctx?.stop || ctx?.done) {
      if (dbgOn) _dbgSell(`pipeline:halt:${name}`, { stop: !!ctx?.stop, done: !!ctx?.done, decision: ctx?.decision || null });
      break;
    }

    if (dbgOn) {
      _dbgSell(`pipeline:step:end:${name}`, {
        decision: ctx?.decision || null,
        done: !!ctx?.done,
        inFlight: !!_inFlight,
      });
    }

    const cur = ctx?.decision;
    const curSig = cur ? `${String(cur.action || "")}::${String(cur.reason || "")}` : "";
    if (curSig && curSig !== prevSig && curSig !== lastDecisionSig) {
      lastDecisionSig = curSig;
      try {
        log(`Pipeline decision (${name}) ${ctx.mint?.slice?.(0,4) || "????"}…: ${String(cur.action || "")} ${cur.reason ? `(${String(cur.reason)})` : ""}`);
      } catch {}
    }
  }
  return ctx;
}

async function runSellPipelineForPosition(ctx) {
  const skipPolicies = (() => {
    const v = _getAutoBotOverride("skipPolicies");
    if (!v) return new Set();
    if (Array.isArray(v)) return new Set(v.map((s) => String(s || "")));
    if (typeof v === "string") return new Set(v.split(",").map((s) => String(s || "").trim()).filter(Boolean));
    return new Set();
  })();

  const steps = [
    { name: "preflight", fn: (c) => preflightSellPolicy(c) },
    { name: "leaderMode", fn: (c) => leaderModePolicy(c) },
    { name: "urgent", fn: (c) => urgentSellPolicy(c) },
    { name: "rugPumpDrop", fn: (c) => rugPumpDropPolicy(c) },
    { name: "earlyFade", fn: (c) => earlyFadePolicy(c) },
    { name: "observer", fn: (c) => observerPolicy(c) },
    { name: "volatilityGuard", fn: (c) => volatilityGuardPolicy(c) },
    { name: "quoteAndEdge", fn: (c) => quoteAndEdgePolicy(c) },
    { name: "fastExit", fn: (c) => fastExitPolicy(c) },
    { name: "warmingHook", fn: (c) => warmingPolicyHook(c) },
    { name: "profitLock", fn: (c) => profitLockPolicy(c) },
    { name: "observerThree", fn: (c) => observerThreePolicy(c) },
    { name: "fallback", fn: (c) => fallbackSellPolicy(c) },
    { name: "forceFlagDecision", fn: (c) => forceFlagDecisionPolicy(c) },
    { name: "reboundGate", fn: (c) => reboundGatePolicy(c) },
    { name: "momentumForce", fn: (c) => momentumForcePolicy(c) },
    { name: "profitFloor", fn: (c) => profitFloorGatePolicy(c) },
    { name: "agentDecision", fn: (c) => agentDecisionPolicy(c) },
    ...(() => {
      const skip = _getAutoBotOverride("skipExecute");
      if (skip) return [];
      return [{ name: "execute", fn: (c) => executeSellDecisionPolicy(c) }];
    })(),
  ].filter((s) => !skipPolicies.has(String(s?.name || "")));

  await runPipeline(ctx, steps);

  try {
    if (ctx?.decision) {
      const d = ctx.decision;
      log(`Pipeline final ${ctx.mint?.slice?.(0,4) || "????"}…: ${String(d.action || "")} ${d.reason ? `(${String(d.reason)})` : ""}`);
    }
  } catch {}
}

async function evalAndMaybeSellPositions() {
  const evalId = _dbgSellNextId();
  const t0 = now();

  traceOnce(
    "sellEval:enter",
    `sell-eval enter id=${evalId} enabled=${state?.enabled ? 1 : 0} positions=${Object.keys(state.positions || {}).length} running=${_sellEvalRunning ? 1 : 0} inFlight=${_inFlight ? 1 : 0}`,
    8000
  );

  if (_sellEvalRunning) {
    _sellEvalWakePending = true;
    _dbgSell(`eval:${evalId}:skip:_sellEvalRunning`, { _sellEvalRunning: true, _inFlight: !!_inFlight });
    traceOnce("sellEval:skipRunning", `sell-eval skip id=${evalId} (already running)`, 8000, "warn");
    return;
  }
  if (_inFlight) {
    _sellEvalWakePending = true;
    _dbgSell(`eval:${evalId}:skip:_inFlight`, { _sellEvalRunning: !!_sellEvalRunning, _inFlight: true });
    traceOnce("sellEval:skipInFlight", `sell-eval skip id=${evalId} (_inFlight true)`, 8000, "warn");
    wakeSellEval();
    return;
  }

  _sellEvalRunning = true;
  _dbgSell(`eval:${evalId}:start`, {
    enabled: !!state.enabled,
    positionsKeys: Object.keys(state.positions || {}).length,
    lastTradeAgoSec: state.lastTradeTs ? Math.floor((now() - state.lastTradeTs) / 1000) : null,
    rpcBackoffLeftMs: (() => { try { return rpcBackoffLeft(); } catch { return null; } })(),
  });
  try {
    try {
      const kpFn = _getAutoBotOverride("getAutoKeypair");
      const kp = (typeof kpFn === "function") ? await kpFn() : await getAutoKeypair();
    if (!kp) {
      _dbgSell(`eval:${evalId}:no_keypair`);
      traceOnce("sellEval:noKeypair", `sell-eval return id=${evalId} (no keypair)`, 12000, "warn");
      return;
    }

    try {
      _dbgSell(`eval:${evalId}:owner`, { owner: kp.publicKey?.toBase58?.() || "" });
    } catch {}

    const ownerStr = kp.publicKey.toBase58();

    const syncOverride = _getAutoBotOverride("syncPositionsFromChain");
    _dbgSell(`eval:${evalId}:syncPositionsFromChain:begin`);
    try {
      if (typeof syncOverride === "function") await syncOverride(ownerStr);
      else await syncPositionsFromChain(ownerStr);
      _dbgSell(`eval:${evalId}:syncPositionsFromChain:done`, { ms: now() - t0 });
    } catch (e) {
      log(`Sell-eval syncPositionsFromChain failed (continuing): ${e?.message || e}`);
      _dbgSell(`eval:${evalId}:syncPositionsFromChain:error`, {
        err: String(e?.message || e || ""),
        stack: String(e?.stack || "").slice(0, 800),
      });
    }

    _dbgSell(`eval:${evalId}:pruneZeroBalancePositions:begin`, { limit: 8 });
    try {
      const pruneOverride = _getAutoBotOverride("pruneZeroBalancePositions");
      const pruneFn =
        (typeof pruneOverride === "function" && pruneOverride) ||
        (typeof pruneZeroBalancePositions === "function" ? pruneZeroBalancePositions : null);
      if (!pruneFn) throw new Error("pruneZeroBalancePositions missing");
      await pruneFn(ownerStr, { limit: 8 });
      _dbgSell(`eval:${evalId}:pruneZeroBalancePositions:done`, { ms: now() - t0 });
    } catch (e) {
      log(`Sell-eval pruneZeroBalancePositions failed (continuing): ${e?.message || e}`);
      _dbgSell(`eval:${evalId}:pruneZeroBalancePositions:error`, {
        err: String(e?.message || e || ""),
        stack: String(e?.stack || "").slice(0, 800),
      });
    }

    const rawEntries = Object.entries(state.positions || {});
    const nonSolEntries = rawEntries.filter(([mint]) => mint && mint !== SOL_MINT);
    const withPosEntries = nonSolEntries.filter(([_, pos]) => !!pos);
    const nonEmptyEntries = withPosEntries.filter(([_, pos]) => (Number(pos?.sizeUi || 0) > 0) || (Number(pos?.costSol || 0) > 0));

    try {
      const droppedAsEmpty = withPosEntries
        .filter(([_, pos]) => !((Number(pos?.sizeUi || 0) > 0) || (Number(pos?.costSol || 0) > 0)))
        .slice(0, 8)
        .map(([mint, pos]) => ({
          mint: String(mint || ""),
          sizeUi: Number(pos?.sizeUi || 0),
          costSol: Number(pos?.costSol || 0),
        }));
      _dbgSell(`eval:${evalId}:entries:breakdown`, {
        raw: rawEntries.length,
        nonSol: nonSolEntries.length,
        withPos: withPosEntries.length,
        nonEmpty: nonEmptyEntries.length,
        sampleMints: nonEmptyEntries.slice(0, 16).map(([m]) => String(m || "").slice(0, 6)),
        droppedAsEmpty,
      });
    } catch {}

    const entries = nonEmptyEntries;
    _dbgSell(`eval:${evalId}:entries`, {
      count: entries.length,
      mints: entries.slice(0, 32).map(([m]) => String(m || "").slice(0, 6)),
    });
    traceOnce(
      "sellEval:entries",
      `sell-eval entries=${entries.length} owner=${String(ownerStr || "").slice(0, 6)}…`,
      8000
    );
    if (!entries.length) {
      _dbgSell(`eval:${evalId}:return:no_entries`, { ms: now() - t0 });
      traceOnce("sellEval:noEntries", `sell-eval return id=${evalId} (no entries)`, 12000);
      return;
    }

    const nowTs = now();
    for (const [mint, pos] of entries) {
      try {
        _dbgSell(`eval:${evalId}:mint:begin`, {
          mint,
          sizeUi: Number(pos?.sizeUi || 0),
          costSol: Number(pos?.costSol || 0),
          decimals: Number(pos?.decimals || 0),
          acquiredAt: Number(pos?.acquiredAt || 0),
          lastBuyAt: Number(pos?.lastBuyAt || 0),
          lastSellAt: Number(pos?.lastSellAt || 0),
          warmingHold: !!pos?.warmingHold,
          postWarmGraceUntil: Number(pos?.postWarmGraceUntil || 0),
        });

        try {
          const u = peekUrgentSell?.(mint);
          if (u) {
            log(`Sell-eval: urgent pending for ${mint.slice(0,4)}… (${String(u.reason||"?")}, sev=${Number(u.sev||0).toFixed(2)})`);
            _dbgSell(`eval:${evalId}:urgent`, { mint, reason: String(u.reason || ""), sev: Number(u.sev || 0) });
          }
        } catch {}
        const ctx = _mkSellCtx({ kp, mint, pos, nowTs });

        try {
          const rug = (() => { try { return _summarizeRugSignal(getRugSignalForMint(mint)) || null; } catch { return null; } })();
          const badge = normBadge(rug?.badge);
          const series = _summarizeLeaderSeries(mint, 6);
          // Do not share object references between `leaderNow` and `leaderSeries`.
          const leaderNow = (series && series.length) ? { ...(series[series.length - 1] || {}) } : null;
          ctx.agentSignals = {
            outcomes: {
              sessionPnlSol: getSessionPnlSol(),
              recent: (() => { try { return agentOutcomes.summarize(8); } catch { return []; } })(),
              lastForMint: (() => { try { return agentOutcomes.lastForMint(mint); } catch { return null; } })(),
            },
            finalGate: (() => { try { return computeFinalGateIntensity(mint); } catch { return null; } })(),
            tickNow: _summarizePumpTickNowForMint(mint),
            badge,
            rugSignal: rug,
            leaderNow,
            leaderSeries: series,
            past: _summarizePastCandlesForMint(mint, 24),
            pos: {
              sizeUi: Number(pos?.sizeUi || 0),
              costSol: Number(pos?.costSol || 0),
              hwmSol: Number(pos?.hwmSol || 0),
              acquiredAt: Number(pos?.acquiredAt || 0),
              lastBuyAt: Number(pos?.lastBuyAt || 0),
              lastSellAt: Number(pos?.lastSellAt || 0),
              warmingHold: !!pos?.warmingHold,
              postWarmGraceUntil: Number(pos?.postWarmGraceUntil || 0),
            },
            cfg: {
              minHoldSecs: Number(state?.minHoldSecs ?? 0),
              maxHoldSecs: Number(state?.maxHoldSecs ?? 0),
              takeProfitPct: Number(state?.takeProfitPct ?? 0),
              stopLossPct: Number(state?.stopLossPct ?? 0),
              trailPct: Number(state?.trailPct ?? 0),
              minProfitToTrailPct: Number(state?.minProfitToTrailPct ?? 0),
              minNetEdgePct: Number(state?.minNetEdgePct ?? 0),
              edgeSafetyBufferPct: Number(state?.edgeSafetyBufferPct ?? 0),
            },
          };
        } catch {}

        _dbgSell(`eval:${evalId}:ctx:init`, {
          mint,
          leaderMode: !!ctx.leaderMode,
          ageMs: Number(ctx.ageMs || 0),
          inSellGuard: !!ctx.inSellGuard,
          forceMomentum: !!ctx.forceMomentum,
          verified: !!ctx.verified,
          hasPending: !!ctx.hasPending,
          sizeOk: !!ctx.sizeOk,
          forceRug: !!ctx.forceRug,
          rugSev: Number(ctx.rugSev || 0),
          forcePumpDrop: !!ctx.forcePumpDrop,
          forceObserverDrop: !!ctx.forceObserverDrop,
        });

        log(`Running pipeline for: ${mint.slice(0,4)}… (size ${Number(pos.sizeUi||0).toFixed(6)})`);
        log(`CTX:init: ${JSON.stringify({
          leaderMode: ctx.leaderMode,
          ageMs: ctx.ageMs,
          inSellGuard: ctx.inSellGuard,
          forceMomentum: ctx.forceMomentum,
          verified: ctx.verified,
          hasPending: ctx.hasPending,
          sizeOk: ctx.sizeOk,
          forceRug: ctx.forceRug,
          rugSev: ctx.rugSev,
          forcePumpDrop: ctx.forcePumpDrop,
          forceObserverDrop: ctx.forceObserverDrop,
          earlyReason: ctx.earlyReason,} )}`);

        _dbgSell(`eval:${evalId}:pipeline:begin`, { mint });
        await runSellPipelineForPosition(ctx);

        try {
          if (ctx.agentTune) {
            _applyAgentTune(ctx.agentTune, {
              source: "sell",
              mint,
              confidence: Number(ctx?.agentTuneMeta?.confidence || 0),
              reason: String(ctx?.agentTuneMeta?.reason || ""),
            });
          }
        } catch {}

        try { _recordSellSnapshot(ctx, { stage: "post_pipeline", evalId }); } catch {}

        _dbgSell(`eval:${evalId}:pipeline:done`, {
          mint,
          decision: ctx?.decision || null,
          done: !!ctx?.done,
          curSol: Number(ctx?.curSol ?? 0),
          curSolNet: Number(ctx?.curSolNet ?? 0),
          minNotional: Number(ctx?.minNotional ?? 0),
          pnlPct: Number(ctx?.pnlPct ?? 0),
          pnlNetPct: Number(ctx?.pnlNetPct ?? 0),
          creditsPending: !!ctx?.creditsPending,
          hasPending: !!ctx?.hasPending,
        });

        if (ctx?.done) return; // one action per tick (sell / moved-to-dust / handled)
      } catch (e) {
        log(`Sell check failed for ${mint.slice(0,4)}…: ${e.message||e}`);
        _dbgSell(`eval:${evalId}:mint:error`, { mint, err: String(e?.message || e || ""), stack: String(e?.stack || "").slice(0, 800) });
      } finally {
        _inFlight = false;
        _dbgSell(`eval:${evalId}:mint:finally`, { mint, _inFlight: false });
      }
    }
    } catch (e) {
      log(`Sell-eval fatal error: ${e?.message || e}`);
      try {
        if (__fdvCli_isHeadless() && e?.stack) {
          const head = String(e.stack).split("\n").slice(0, 6).join(" | ");
          log(`Sell-eval fatal stack: ${head}`);
        }
      } catch {}
      _dbgSell(`eval:${evalId}:fatal`, { err: String(e?.message || e || ""), stack: String(e?.stack || "").slice(0, 1200) });
    }
  } finally {
    _sellEvalRunning = false;
    _dbgSell(`eval:${evalId}:done`, { ms: now() - t0, wakePending: !!_sellEvalWakePending });
    if (_sellEvalWakePending) wakeSellEval();
  }
}

async function switchToLeader(newMint) {
  const prev = state.currentLeaderMint || "";
  if (!newMint || newMint === prev) return false;

  if (!(await isValidPubkeyStr(newMint))) {
    log(`Leader mint invalid, ignoring: ${String(newMint).slice(0,6)}…`);
    return false;
  }

  if (_switchingLeader) return false;
  const kp = await getAutoKeypair();
  if (!kp) return false;
  _switchingLeader = true;
  try {
    log(`Leader changed: ${prev ? prev.slice(0,4) + "…" : "(none)"} -> ${newMint.slice(0,4)}…`);
    await syncPositionsFromChain(kp.publicKey.toBase58());

    const allMints = Object.keys(state.positions || {}).filter(m => m !== SOL_MINT && m !== newMint);
    const mints = [];
    for (const m of allMints) {
      if (await isValidPubkeyStr(m)) {
        mints.push(m);
      } else {
        log(`Pruning invalid mint from positions: ${String(m).slice(0,6)}…`);
        delete state.positions[m];
        removeFromPosCache(kp.publicKey.toBase58(), m);
      }
    }

    const owner = kp.publicKey.toBase58();
    let rotated = 0;
    for (const mint of mints) {
      try {
        if (window._fdvRouterHold && window._fdvRouterHold.get(mint) > now()) {
          const until = window._fdvRouterHold.get(mint);
          log(`Router cooldown (rotate) for ${mint.slice(0,4)}… until ${new Date(until).toLocaleTimeString()}`);
          continue;
        }

        const b = await getAtaBalanceUi(owner, mint, state.positions[mint]?.decimals);
        const uiAmt = Number(b.sizeUi || 0);
        const dec = Number.isFinite(b.decimals)
          ? b.decimals
          : (Number.isFinite(state.positions[mint]?.decimals) ? state.positions[mint].decimals : 6);

        if (uiAmt <= 0) {
          log(`No balance to rotate for ${mint.slice(0,4)}…`);
          delete state.positions[mint];
          removeFromPosCache(owner, mint);
          continue;
        }

        // Pre-quote notional. If below minimum, move to dust cache and skip.
        let estSol = 0;
        try { estSol = await quoteOutSol(mint, uiAmt, dec); } catch {}
        const minNotional = minSellNotionalSol();
        if (estSol < minNotional) {
          try { addToDustCache(owner, mint, uiAmt, dec); } catch {}
          try { removeFromPosCache(owner, mint); } catch {}
          delete state.positions[mint];
          save();
          log(`Rotate: below notional for ${mint.slice(0,4)}… moved to dust cache.`);
          continue;
        }

        // Full sell
        const res = await _getDex().sellWithConfirm(
          { signer: kp, mint, amountUi: uiAmt, slippageBps: state.slippageBps },
          { retries: 2, confirmMs: 15000, closeWsolAta: false },
        );

        try { _noteDexTx("sell", mint, res, { amountUi: uiAmt, slippageBps: state.slippageBps }); } catch {}

        if (!res.ok) {
          if (res.noRoute) setRouterHold(mint, ROUTER_COOLDOWN_MS);
          log(`Rotate sell not confirmed ${mint.slice(0,4)}… keeping position.`);
          continue;
        }

        // Handle partial debit remainder
        const debit = await waitForTokenDebit(owner, mint, uiAmt);
        const remain = Number(debit.remainUi || 0);
        if (remain > 1e-9) {
          const estRemainSol = await quoteOutSol(mint, remain, dec).catch(() => 0);
          const minN = minSellNotionalSol();
          if (estRemainSol >= minN) {
            log(`Rotate out partial: remain ${remain.toFixed(6)} ${mint.slice(0,4)}…`);
            const prevSize = Number(state.positions[mint]?.sizeUi || uiAmt);
            const frac = Math.min(1, Math.max(0, remain / Math.max(1e-9, prevSize)));
            const pos = state.positions[mint] || { costSol: 0, hwmSol: 0 };
            pos.sizeUi = remain;
            pos.decimals = Number.isFinite(debit.decimals) ? debit.decimals : dec;
            pos.costSol = Number(pos.costSol || 0) * frac;
            pos.hwmSol  = Number(pos.hwmSol  || 0) * frac;
            pos.lastSellAt = now();
            state.positions[mint] = pos;
            updatePosCache(owner, mint, pos.sizeUi, pos.decimals);
            save();
            setRouterHold(mint, ROUTER_COOLDOWN_MS);
            continue;
          } else {
            try { addToDustCache(owner, mint, remain, dec); } catch {}
            try { removeFromPosCache(owner, mint); } catch {}
            delete state.positions[mint];
            save();
            log(`Rotate: leftover below notional for ${mint.slice(0,4)}… moved to dust cache.`);
            continue;
          }
        }

        // Fully rotated out
    // Full exit: try closing now-empty token ATA(s) to reclaim rent.
    try { await closeEmptyTokenAtas(kp, mint); } catch {}
        log(`Rotated out: ${uiAmt.toFixed(6)} ${mint.slice(0,4)}… -> ~${estSol.toFixed(6)} SOL`);
        const costSold = Number(state.positions[mint]?.costSol || 0);
        await _addRealizedPnl(estSol, costSold, "Rotation PnL");
        delete state.positions[mint];
        removeFromPosCache(owner, mint);
        save();
        rotated++;
      } catch (e) {
        log(`Rotate sell failed ${mint.slice(0,4)}…: ${e.message || e}`);
        const msg = String(e?.message || e || "");
        if (/invalid public key/i.test(msg) || /INVALID_MINT/i.test(msg)) {
          try { removeFromPosCache(kp.publicKey.toBase58(), mint); } catch {}
          try { if (state.positions[mint]) { delete state.positions[mint]; save(); } } catch {}
          log(`Pruned invalid mint during rotation: ${mint.slice(0,4)}…`);
        }
      }
    }
    log(`Rotation complete. Sold ${rotated} token${rotated===1?"":"s"}.`);
    state.currentLeaderMint = newMint;
    save();
    if (rotated > 0) {
      state.lastTradeTs = now();

      try { await maybeStealthRotate("rotate"); } catch {}
      save();
      return true;
    }
    return false;
  } finally {
    _switchingLeader = false;
  }
}

async function tick() {
  // const endIn = state.endAt ? ((state.endAt - now())/1000).toFixed(0) : "0";
  if (!state.enabled) return;

  traceOnce(
    "tick:alive",
    `tick alive (enabled=1, inFlight=${_inFlight ? 1 : 0}, sellEvalRunning=${_sellEvalRunning ? 1 : 0})`,
    15000
  );

  if (rpcBackoffLeft() > 0) {
    log("RPC backoff active; skipping tick.");
    return;
  }

  try {
    const leaders = computePumpingLeaders(3) || [];
    for (const it of leaders) {
      const kp = it?.kp || {};
      if (it?.mint) {
        recordLeaderSample(it.mint, {
          pumpScore: Number(it?.pumpScore || 0),
          liqUsd:    safeNum(kp.liqUsd, 0),
          v1h:       safeNum(kp.v1hTotal, 0),
          chg5m:     safeNum(kp.change5m, 0),
          chg1h:     safeNum(kp.change1h, 0),
        });
      }
    }
  } catch {}
  try { await runFinalPumpGateBackground(); } catch {}
  try {
    const held = Object.keys(state.positions || {}).filter(m => m && m !== SOL_MINT);
    for (const m of held) {
      await focusMintAndRecord(m, { refresh: true, ttlMs: 2000 }).catch(()=>{});
    }
  } catch {}
  if (state.endAt && now() >= state.endAt) {
    log("Lifetime ended. Unwinding…");
    try { await sweepAllToSolAndReturn(); } catch(e){ log(`Unwind failed: ${e.message||e}`); }
    return;
  } else {
    const endInSec = Math.max(0, Math.floor((state.endAt - now()) / 1000));
    const remMins = Math.max(0, Math.floor(endInSec / 60));
    log(`Bot active. Time until end: ${endInSec}s :: hit "refresh" to reset all stats.`);
    if (lifeEl) lifeEl.value = String(remMins);
  }
  if (depBalEl && state.autoWalletPub) {
    if (!_lastDepFetchTs || (now() - _lastDepFetchTs) > 5000) {
      _lastDepFetchTs = now();
      fetchSolBalance(state.autoWalletPub).then(b => { depBalEl.value = `${b.toFixed(4)} SOL`; }).catch(()=>{});
    }
  }

  try { await processPendingCredits(); } catch {}

  try {
    const kpTmp = await getAutoKeypair();
    if (kpTmp && (pendingCreditsSize() > 0)) {
      await reconcileFromOwnerScan(kpTmp.publicKey.toBase58());
    }
  } catch {}

  try { await evalAndMaybeSellPositions(); } catch {}

  // Light-entry top-up: if a light position starts trending up, add the remaining buy amount.
  try {
    if (_hasPendingLightTopUps()) {
      const kpTmp2 = await getAutoKeypair();
      const didTopUp = kpTmp2 ? await _tryLightTopUp(kpTmp2) : false;
      if (didTopUp) return;
    }
  } catch {}

  try { updateStatsHeader(); } catch {}

  log("Follow us on twitter: https://twitter.com/fdvlol for updates and announcements!", "info");

  if (_buyInFlight || _inFlight || _switchingLeader) return;

  const _epochNow = Date.now();
  if (window._fdvJupStressUntil && _epochNow < window._fdvJupStressUntil) {
    const left = Math.ceil((window._fdvJupStressUntil - _epochNow) / 1000);
    log(`Backoff active (${left}s); pausing new buys.`);
    return;
  }

  const leaderMode = !!state.holdUntilLeaderSwitch;
  const desiredBuyCount = leaderMode
    ? 1
    : (state.allowMultiBuy ? Math.max(1, state.multiBuyTopN | 0) : 1);
  let picks = [];

  const flamebarEnabled = state.flamebarBuyEnabled !== false;
  const flamebarPreferPick = state.flamebarPreferPick !== false; // default true
  const flamebarRequirePump = state.flamebarRequirePump === true; // default false
  const flamePick = flamebarEnabled ? _getFlamebarLeaderPick() : null;
  const flameMint = String(flamePick?.mint || "").trim();
  const flameMode = String(flamePick?.mode || "").trim();
  const flamePumping = !!flamePick?.pumping;

  // Higher-level selection: use the full KPI snapshot to rank trade candidates.
  // Falls back to legacy pumping selection when snapshot is unavailable.
  const kpiSnapshot = (() => {
    try { return getLatestSnapshot() || []; } catch { return []; }
  })();
  const kpiSelectEnabled = state.kpiSelectEnabled !== false;

  // Keep lightweight per-mint info about why a mint was picked from KPI snapshot.
  // (Used later to enrich Agent Gary signals.)
  const _kpiPickByMint = new Map();

  if (kpiSelectEnabled && Array.isArray(kpiSnapshot) && kpiSnapshot.length) {
    // When multi-buy is enabled, request a larger pool than the final buy count.
    // This allows us to still place N buys after eligibility/locks/blacklists.
    const poolN = leaderMode
      ? 1
      : (state.allowMultiBuy ? Math.max(desiredBuyCount, Math.min(24, desiredBuyCount * 4 + 2)) : 1);

    const _agentRisk = (() => {
      try {
        const agent = getAutoTraderAgent();
        const cfg = agent?.getConfigFromRuntime ? agent.getConfigFromRuntime() : null;
        const enabledFlag = cfg && (cfg.enabled !== false);
        const keyPresent = !!String(cfg?.openaiApiKey || "").trim();
        if (!(enabledFlag && keyPresent)) return null;

        const raw = String(cfg?.riskLevel || "safe").trim().toLowerCase();
        return (raw === "safe" || raw === "medium" || raw === "degen") ? raw : "safe";
      } catch { return null; }
    })();

    const _riskDefaults = (() => {
      // IMPORTANT: only apply risk defaults when Agent Gary is active.
      // Otherwise, keep existing selection behavior.
      if (!_agentRisk) return { minLiqUsd: 2500, minVol24: 250, rugSevSkip: 2 };
      if (_agentRisk === "degen") return { minLiqUsd: 4_000, minVol24: 15_000, rugSevSkip: 4 };
      if (_agentRisk === "medium") return { minLiqUsd: 10_000, minVol24: 30_000, rugSevSkip: 3 };
      return { minLiqUsd: 20_000, minVol24: 50_000, rugSevSkip: 2 }; // safe
    })();

    const _stateMinLiqUsd = Number(state.kpiSelectMinLiqUsd);
    const _stateMinVol24 = Number(state.kpiSelectMinVol24);
    const minLiqUsd = (Number.isFinite(_stateMinLiqUsd) && _stateMinLiqUsd > 0) ? _stateMinLiqUsd : _riskDefaults.minLiqUsd;
    const minVol24 = (Number.isFinite(_stateMinVol24) && _stateMinVol24 > 0) ? _stateMinVol24 : _riskDefaults.minVol24;
    const rugSevSkip = _riskDefaults.rugSevSkip;

    const pumpLeaders = computePumpingLeaders(Math.max(12, Number(state.kpiSelectPumpTopN || 30))) || [];
    const rows = selectTradeCandidatesFromKpis({
      snapshot: kpiSnapshot,
      pumpLeaders,
      topN: poolN,
      rugFn: getRugSignalForMint,
      rugSevSkip,
      minLiqUsd,
      minVol24,
    });

    let merged = Array.isArray(rows) ? rows.slice() : [];
    try {
      const normMint = (m) => {
        const s = String(m || "").trim();
        return s;
      };

      const snap = Array.isArray(kpiSnapshot) ? kpiSnapshot : [];
      const snapshotMintSet = new Set(snap.map(it => normMint(kpiGetMint(it))).filter(Boolean));

      const pumpTopMint = normMint(
        (pumpLeaders || []).find(l => snapshotMintSet.has(normMint(l?.mint)))?.mint
          || (pumpLeaders || [])[0]?.mint
          || ""
      );

      if (pumpTopMint && snapshotMintSet.has(pumpTopMint)) {
        const pumpItem = snap.find(it => normMint(kpiGetMint(it)) === pumpTopMint) || null;
        if (pumpItem) {
          const liq = Number(kpiGetLiqUsd(pumpItem) || 0);
          const vol = Number(kpiGetVol24(pumpItem) || 0);

          const sig = (() => { try { return getRugSignalForMint(pumpTopMint); } catch { return null; } })();
          const sev = Number(sig?.severity ?? sig?.sev ?? 0);

          if (Number.isFinite(sev) && sev >= rugSevSkip) {
            log(`Pump pick ${pumpTopMint.slice(0,4)}… rejected by rug filter (sev=${sev.toFixed(2)}).`);
          } else if (!Number.isFinite(liq) || liq < minLiqUsd) {
            log(`Pump pick ${pumpTopMint.slice(0,4)}… rejected by KPI liq gate (${fmtUsd(liq)} < ${fmtUsd(minLiqUsd)}).`);
          } else if (!Number.isFinite(vol) || vol < minVol24) {
            log(`Pump pick ${pumpTopMint.slice(0,4)}… rejected by KPI vol gate (${fmtUsd(vol)} < ${fmtUsd(minVol24)}).`);
          } else {
            const ctx = buildKpiScoreContext(kpiSnapshot);
            const pumpRow = scoreKpiItem(pumpItem, ctx);
            if (pumpRow?.mint && !merged.some(r => r?.mint === pumpRow.mint)) {
              pumpRow.pumpChoice = true;
              merged.push(pumpRow);
            }
          }
        } else {
          // Defensive: should be rare since we already checked membership via `snapshotMintSet`.
          const ts = now();
          if (_kpiPumpCompareMissLastMint !== pumpTopMint || (ts - _kpiPumpCompareMissLastAt) > 15000) {
            _kpiPumpCompareMissLastMint = pumpTopMint;
            _kpiPumpCompareMissLastAt = ts;
            log(`Pump leader ${pumpTopMint.slice(0, 4)}… missing from KPI snapshot; skipping compare.`, "warn");
          }
        }
      } else if (pumpTopMint) {
        // Leader not present in the current snapshot; don't spam logs.
        const ts = now();
        if (_kpiPumpCompareMissLastMint !== pumpTopMint || (ts - _kpiPumpCompareMissLastAt) > 15000) {
          _kpiPumpCompareMissLastMint = pumpTopMint;
          _kpiPumpCompareMissLastAt = ts;
          log(`Pump leader ${pumpTopMint.slice(0, 4)}… not in current KPI snapshot; comparing snapshot-only candidates.`, "info");
        }
      }

      // Flamebar: inject the current leader mint as an eligible KPI candidate 
      const flame = normMint(flameMint);
      if (flame) {
        if (snapshotMintSet.has(flame)) {
          const flameItem = snap.find(it => normMint(kpiGetMint(it)) === flame) || null;
          if (flameItem) {
            const liq = Number(kpiGetLiqUsd(flameItem) || 0);
            const vol = Number(kpiGetVol24(flameItem) || 0);

            const sig = (() => { try { return getRugSignalForMint(flame); } catch { return null; } })();
            const sev = Number(sig?.severity ?? sig?.sev ?? 0);

            if (Number.isFinite(sev) && sev >= rugSevSkip) {
              log(`Flamebar pick ${flame.slice(0,4)}… rejected by rug filter (sev=${sev.toFixed(2)}; mode=${flameMode||"?"}).`);
            } else if (!Number.isFinite(liq) || liq < minLiqUsd) {
              log(`Flamebar pick ${flame.slice(0,4)}… rejected by KPI liq gate (${fmtUsd(liq)} < ${fmtUsd(minLiqUsd)}; mode=${flameMode||"?"}).`);
            } else if (!Number.isFinite(vol) || vol < minVol24) {
              log(`Flamebar pick ${flame.slice(0,4)}… rejected by KPI vol gate (${fmtUsd(vol)} < ${fmtUsd(minVol24)}; mode=${flameMode||"?"}).`);
            } else {
              const ctx = buildKpiScoreContext(kpiSnapshot);
              const flameRow = scoreKpiItem(flameItem, ctx);
              if (flameRow?.mint && !merged.some(r => r?.mint === flameRow.mint)) {
                flameRow.flamebarChoice = true;
                merged.push(flameRow);
              }
            }
          }
        } else {
          const ts = now();
          if (_flamebarMissLastMint !== flame || (ts - _flamebarMissLastAt) > 15000) {
            _flamebarMissLastMint = flame;
            _flamebarMissLastAt = ts;
            log(`Flamebar leader ${flame.slice(0, 4)}… not in current KPI snapshot (mode=${flameMode||"?"}); skipping KPI compare.`, "info");
          }
        }
      }
    } catch {}

    merged.sort((a, b) => (Number(b?.score01 || 0) - Number(a?.score01 || 0)));
    try {
      for (const r of merged) {
        const m = String(r?.mint || "").trim();
        if (!m) continue;
        const s = _summarizeKpiPickRow(r);
        if (s) _kpiPickByMint.set(m, s);
      }
    } catch {}
    picks = merged.slice(0, poolN).map(r => r?.mint).filter(Boolean);

    // If Flamebar leader is eligible, optionally prefer it (still must pass later buy gates).
    try {
      const flame = String(flameMint || "").trim();
      if (flame && merged.some(r => String(r?.mint || "") === flame)) {
        const okMode = !flamebarRequirePump || flamePumping;
        if (okMode && flamebarPreferPick) {
          picks = [flame, ...picks.filter(m => m !== flame)];
        } else if (okMode && !picks.includes(flame)) {
          picks = [...picks, flame];
        }
        picks = picks.slice(0, poolN);
      }
    } catch {}

    // Apply existing blacklist / pump-drop bans.
    picks = picks.filter(m => m && !isMintBlacklisted(m) && !isPumpDropBanned(m));
  }

  // Legacy selection fallback.
  if (!picks.length) {
    // Flamebar fallback: if Flamebar is actively pumping, try it as a candidate before legacy pump picks.
    if (flamebarEnabled && flamebarPreferPick && flameMint && (!flamebarRequirePump || flamePumping)) {
      if (!isMintBlacklisted(flameMint) && !isPumpDropBanned(flameMint)) {
        picks = [flameMint];
      }
    }

    if (leaderMode) {
      // Simple mode: always take the top KPI leader
      const leadersTop = computePumpingLeaders(1) || [];
      const top = leadersTop[0]?.mint || "";
      if (top && !isMintBlacklisted(top) && !isPumpDropBanned(top)) picks = [top];
    } else if (state.allowMultiBuy) {
      const primary = await pickTopPumper(); // requires >=4/5 internally
      const rest = pickPumpCandidates(Math.max(1, state.multiBuyTopN|0), 3)
        .filter(m => m && m !== primary);
      picks = [primary, ...rest].filter(Boolean);
    } else {
      const p = await pickTopPumper();
      if (p) picks = [p];
    }
  }
  if (!picks.length) return;

  // If Flamebar is enabled, ensure it is at least considered when we have other picks.
  try {
    if (flamebarEnabled && flameMint && (!flamebarRequirePump || flamePumping)) {
      if (!picks.includes(flameMint) && !isMintBlacklisted(flameMint) && !isPumpDropBanned(flameMint)) {
        picks = [flameMint, ...picks].filter(Boolean);
        // Keep picks list reasonably sized.
        const lim = leaderMode ? 1 : Math.max(1, Math.min(24, desiredBuyCount * 6));
        picks = picks.slice(0, lim);
      }
    }
  } catch {}

  let ignoreCooldownForLeaderBuy = false;
  if (leaderMode && picks[0]) {
    const didRotate = await switchToLeader(picks[0]);
    if (didRotate) ignoreCooldownForLeaderBuy = true;
  }

  const withinBatch = state.allowMultiBuy && now() <= _buyBatchUntil;
  if (state.lastTradeTs && (now() - state.lastTradeTs)/1000 < state.minSecsBetween && !withinBatch && !ignoreCooldownForLeaderBuy) return;


  const agentBypassNonEdgeGates = _isAgentGaryEffective();
  let haveBuyLock = false;
  if (agentBypassNonEdgeGates) {
    haveBuyLock = tryAcquireBuyLock(BUY_LOCK_MS);
    if (!haveBuyLock) {
      try {
        const t = now();
        const until = Number(window._fdvBuyLockUntil || 0);
        const remMs = Math.max(0, until - t);
        log(`Buy lock held (AI bypass); continuing buy evaluation (rem ${(remMs / 1000).toFixed(2)}s).`);
      } catch {
        log("Buy lock held (AI bypass); continuing buy evaluation.");
      }
      // Safety: if something is already in-flight, do not overlap buys.
      if (_buyInFlight || _inFlight || _switchingLeader) return;
    }
  } else {
    if (!tryAcquireBuyLock(BUY_LOCK_MS)) {
      try {
        const t = now();
        const until = Number(window._fdvBuyLockUntil || 0);
        const remMs = Math.max(0, until - t);
        log(`Buy lock held; skipping buys this tick (rem ${(remMs / 1000).toFixed(2)}s).`);
      } catch {
        log("Buy lock held; skipping buys this tick.");
      }
      return;
    }
    haveBuyLock = true;
  }

  try {
    const kp = await getAutoKeypair();
    if (!kp) return;

    await syncPositionsFromChain(kp.publicKey.toBase58());

    if (!state.allowMultiBuy) {
      const activeMints = Object.entries(state.positions || {})
        .filter(([m, p]) => {
          if (!m || m === SOL_MINT) return false;
          const sizeUi = Number(p?.sizeUi || 0);
          const costSol = Number(p?.costSol || 0);
          return (sizeUi > 1e-9) || (costSol > 0) || (p?.awaitingSizeSync === true);
        })
        .map(([m]) => m);

      if (activeMints.length > 1) {
        log(`Multi-buy OFF: ${activeMints.length} positions already open; skipping new buys.`);
        return;
      }
      if (activeMints.length === 1 && activeMints[0] !== picks[0]) {
        log(`Multi-buy OFF: holding ${activeMints[0].slice(0,4)}…; skipping new buy ${picks[0].slice(0,4)}…`);
        return;
      }
    }

    const cur = state.positions[picks[0]];
    const alreadyHoldingLeader = Number(cur?.sizeUi || 0) > 0 || Number(cur?.costSol || 0) > 0;
    if (leaderMode && alreadyHoldingLeader) {
      log("Holding current leader. No additional buys.");
      return;
    }

    const solBal = await fetchSolBalance(kp.publicKey.toBase58());
    if (solBal < 0.05) {
      log(`SOL low (${solBal.toFixed(4)}); skipping new buys to avoid router dust.`);
      return;
    }
    const ceiling = await computeSpendCeiling(kp.publicKey.toBase58(), { solBalHint: solBal });

    const desired      = Math.min(state.maxBuySol, Math.max(state.minBuySol, solBal * state.buyPct));
    const minThreshold = Math.max(state.minBuySol, MIN_SELL_SOL_OUT);
    let plannedTotal   = Math.min(ceiling.spendableSol, Math.min(state.maxBuySol, desired));


    logObj("Buy sizing (pre-split)", {
      solBal: Number(solBal).toFixed(6),
      spendable: Number(ceiling.spendableSol).toFixed(6),
      posCount: ceiling.reserves.posCount,
      reservesSol: (ceiling.reserves.totalResLamports/1e9).toFixed(6),
      minThreshold
    });


    let buyCandidates = picks.filter(m => {
      const pos = state.positions[m];
      const allowRebuy = !!pos?.allowRebuy;
      const eligibleSize = allowRebuy || Number(pos?.sizeUi || 0) <= 0;
      const notPending = !pos?.awaitingSizeSync;
      const notLocked  = !isMintLocked(m);
      return eligibleSize && notPending && notLocked;
    });

    if (!state.allowMultiBuy && buyCandidates.length > 1) {
      buyCandidates = buyCandidates.slice(0, 1);
    }

    if (state.allowMultiBuy && buyCandidates.length > desiredBuyCount) {
      buyCandidates = buyCandidates.slice(0, desiredBuyCount);
    }



    if (!buyCandidates.length) { log("All picks already held or pending. Skipping buys."); return; }

    if (plannedTotal < minThreshold) {
      // state.carrySol += desired;
      const carryPrev = Math.max(0, Number(state.carrySol || 0));
      state.carrySol = Math.min(Number(state.maxBuySol || 0.05), carryPrev + Number(desired || 0));
      save();
      log(`Accumulating. Carry=${state.carrySol.toFixed(6)} SOL (< ${minThreshold} min or spend ceiling). You do not have enough SOL to run the auto bot. Trying using Hold mode to generate more SOL.`);
      return;
    }

    _buyInFlight = true;

    let remainingLamports = Math.floor(ceiling.spendableSol * 1e9);
    let remaining = remainingLamports / 1e9;
    let spent = 0;
    let buysDone = 0;

    let loopN = leaderMode ? 1 : (state.allowMultiBuy ? buyCandidates.length : 1);

    try {
      if (!leaderMode && loopN > 1) {
        const rentL = await tokenAccountRentLamports();
        const perOrderMinL = Math.floor(Math.max(MIN_JUP_SOL_IN, minThreshold) * 1e9);
        const neededTwo = perOrderMinL * 2 + rentL * 2 + TX_FEE_BUFFER_LAMPORTS;
        if (remainingLamports < neededTwo) {
          loopN = 1;
          log(`Small balance; forcing single-buy mode this tick (need ${(neededTwo/1e9).toFixed(6)} SOL for 2 buys).`);
        }
      }
    } catch {}
    for (let i = 0; i < loopN; i++) {
      const mint = buyCandidates[i];
      {
        const existing = state.positions[mint];
        if (existing && existing.awaitingSizeSync) {
          log(`Skip buy: awaiting size sync for ${mint.slice(0,4)}…`);
          continue;
        }
        const recentAgeMs = existing ? (now() - Number(existing.lastBuyAt || existing.acquiredAt || 0)) : Infinity;
        const minRebuyMs = Math.max(8_000, Number(state.coolDownSecsAfterBuy || 8) * 1000);
        if (recentAgeMs < minRebuyMs) {
          log(`Skip buy: cooldown (${(recentAgeMs/1000).toFixed(1)}s < ${(minRebuyMs/1000)|0}s) for ${mint.slice(0,4)}…`);
          continue;
        }
      }
      // Final unconditional check?
      try { ensureFinalPumpGateTracking(mint); } catch {}
      if (!agentBypassNonEdgeGates && !isFinalPumpGateReady(mint)) {
        log(`Final gate: not ready to buy ${mint.slice(0,4)}… waiting for pump score up Δ.`, 'warn');
        continue;
      }

      try {
        if (!agentBypassNonEdgeGates && state.buyAnalysisEnabled !== false) {
          const st = _noteBuyCandidateAndCheckReady(mint);
          if (!st?.ready) {
            // Avoid log spam: at most once per ~2s per mint.
            const t = now();
            const lastLogAt = Number(st?.rec?.lastLogAt || 0);
            if (!lastLogAt || (t - lastLogAt) > 2000) {
              try {
                st.rec.lastLogAt = t;
                _getBuyAnalysisStore().set(String(mint || "").trim(), st.rec);
              } catch {}
              log(
                `Buy warmup: skip ${mint.slice(0,4)}… ` +
                `(age ${(Math.max(0, st.ageMs)/1000).toFixed(1)}s/${(st.minMs/1000).toFixed(0)}s, ` +
                `seen ${st.seen}/${st.minSeen}, series ${st.seriesN}/${st.minSeries})`
              );
            }
            continue;
          }
        }
      } catch {}

      if (state.allowMultiBuy && mint !== picks[0]) {
        try {
          const wMs = Math.max(1800, Math.floor((state.tickMs || 2000) * 0.9));
          const sMs = Math.max(450, Math.floor((state.tickMs || 2000) / 3.5));
          const obs = await observeMintOnce(mint, {
            windowMs: wMs,
            sampleMs: sMs,
            minPasses: 4,
            adjustHold: !!state.dynamicHoldEnabled
          });
          if (!obs.canBuy) {
            log(`Observer gate: ${obs.reason || "conditions not met"} for ${mint.slice(0,4)}… Skipping buy.`);
            continue;
          }
        } catch {
          log(`Observer gate failed for ${mint.slice(0,4)}… Skipping buy.`);
          continue;
        }
      }

      // const left = Math.max(1, loopN - i);
      const target = Math.min(plannedTotal, remaining);

      if (!agentBypassNonEdgeGates) {
        try {
          const leadersNow = computePumpingLeaders(3) || [];
          const itNow = leadersNow.find(x => x?.mint === mint);
          if (itNow) {
          const kpNow = itNow.kp || {};
          const metaNow = itNow.meta || {};
          const warm = detectWarmingUptick({ kp: { ...kpNow, mint }, meta: metaNow }, state);
          const series = getLeaderSeries(mint, 3);
          const scSlopeMin = slope3pm(series || [], "pumpScore");
          const chgSlopeMin = slope3pm(series || [], "chg5m");
          // const chgSlopeMin = slope3pm(series || [], "change5m");

          // Reproduce score weights to measure c5 dominance
          const chg5m = safeNum(kpNow.change5m, 0);
          const chg1h = safeNum(kpNow.change1h, 0);
          const liq   = safeNum(kpNow.liqUsd,   0);
          const v1h   = safeNum(kpNow.v1hTotal, 0);
          const accel5to1 = safeNum(metaNow.accel5to1, 1);
          const risingNow = !!metaNow.risingNow;
          const trendUp   = !!metaNow.trendUp;

          const c5 = Math.max(0, chg5m);
          const c1 = Math.log1p(Math.max(0, chg1h));
          const exp5m = Math.max(0, chg1h) / 12;
          const accelRatio = exp5m > 0 ? (c5 / exp5m) : (c5 > 0 ? 1.2 : 0);
          const lLiq = Math.log1p(liq / 5000);
          const lVol = Math.log1p(v1h / 1000);
          const w = {
            c5: 0.32 * c5,
            c1: 0.16 * c1,
            lVol: 0.18 * lVol,
            lLiq: 0.10 * lLiq,
            accelRatio: 0.10 * Math.max(0, accelRatio - 0.8),
            accel5to1: 0.10 * Math.max(0, accel5to1 - 1),
            flags: (risingNow && trendUp ? 0.02 : 0),
            pScore: 0.02 * safeNum(itNow.pumpScore, 0),
          };
          const sumW = w.c5 + w.c1 + w.lVol + w.lLiq + w.accelRatio + w.accel5to1 + w.flags + w.pScore;
          const c5Share = sumW > 0 ? (w.c5 / sumW) : 0;
          const barelyPasses = Number(warm.pre || 0) < (Number(warm.preMin || 0) + Math.max(0.005, Number(state.lateEntryMinPreMargin || 0.02)));

          // if (c5Share >= Math.max(0.5, Number(state.lateEntryDomShare || 0.6)) && barelyPasses && !(scSlopeMin > 0)) {
          //   log(`Exhaust spike filter: skip ${mint.slice(0,4)}… (c5 ${Math.round(c5Share*100)}% of score, pre ${warm.pre.toFixed(3)} ~ min ${warm.preMin.toFixed(3)}, scSlope=${scSlopeMin.toFixed(2)}/m ≤ 0)`);
          //   continue;
          // }

          // if (!((scSlopeMin > 0 && chgSlopeMin > 0) || metaNow.risingNow === true)) {
          //   log(`Entry slopes not healthy; skip ${mint.slice(0,4)}… (scSlope=${scSlopeMin.toFixed(2)}/m, chgSlope=${chgSlopeMin.toFixed(2)}/m, risingNow=${!!metaNow.risingNow})`);
          //   continue;
          // }

          // TODO: price impact proxy?
          // try {
          //   const solPx = await getSolUsd();
          //   const liq = Number(kpNow.liqUsd || 0);
          //   if (solPx > 0 && liq > 0) {
          //     const buyUsd = buySol * solPx;
          //     const imp = buyUsd / liq; // ≈ price impact proxy
          //     if (imp > 0.008) {
          //       log(`Impact gate: skip ${mint.slice(0,4)}… est impact ${(imp*100).toFixed(2)}% > 0.80% (buy≈${fmtUsd(buyUsd)}, liq≈${fmtUsd(liq)})`);
          //       continue;
          //     }
          //   }
          // } catch {}

          const needTicks = Math.max(1, Number(state.sustainTicksMin || 2));
          const needChg = Math.max(0, Number(state.sustainChgSlopeMin || 6));
          const needSc  = Math.max(0, Number(state.sustainScSlopeMin  || 3));
          const series5 = getLeaderSeries(mint, 5);
          const okTicks = countConsecUp(series5, "pumpScore") >= needTicks && countConsecUp(series5, "chg5m") >= needTicks;
          const okSlopes = (scSlopeMin >= needSc) && (chgSlopeMin >= needChg);
          const c5DomThr = Math.max(0.6, Number(state.lateEntryDomShare || 0.65));

          if (c5Share >= c5DomThr && barelyPasses && !(scSlopeMin > -1 || okTicks)) {
            log(`Exhaust spike filter: skip ${mint.slice(0,4)}… (c5 ${Math.round(c5Share*100)}% of score, pre ${warm.pre.toFixed(3)} ~ min ${warm.preMin.toFixed(3)}, scSlope=${scSlopeMin.toFixed(2)}/m ≤ 0)`);
            continue;
          }
          const needBoth = (!risingNow && !trendUp);
          if (needBoth && !(okTicks && okSlopes)) {
            log(`Sustain gate (strict): skip ${mint.slice(0,4)}… (ticks=${okTicks} slopes=${okSlopes})`);
            continue;
          }
          if (!needBoth && (!risingNow || !trendUp) && !(okTicks || okSlopes)) {
            log(`Sustain gate (lenient): skip ${mint.slice(0,4)}… (need ticks OR slopes; rNow=${risingNow} tUp=${trendUp})`);
            continue;
          }


          }
        } catch {}
      }

      const reqRent = await requiredAtaLamportsForSwap(kp.publicKey.toBase58(), SOL_MINT, mint);
      if (reqRent > 0 && solBal < AVOID_NEW_ATA_SOL_FLOOR) {
        log(`Skipping ${mint.slice(0,4)}… (SOL ${solBal.toFixed(4)} < ${AVOID_NEW_ATA_SOL_FLOOR}, would open new ATA). Try adding more SOL`);
        continue;
      }
      const candidateBudgetLamports = Math.max(0, remainingLamports - reqRent - TX_FEE_BUFFER_LAMPORTS);
      const targetLamports = Math.floor(target * 1e9);
      let buyLamports = Math.min(targetLamports, Math.floor(remaining * 1e9), candidateBudgetLamports);

      const minInLamports = Math.floor(MIN_JUP_SOL_IN * 1e9);

      // const rentMinBuyLamports = reqRent > 0 ? Math.ceil(reqRent / 0.01) : 0;

      //const minPerOrderLamports = Math.max(minInLamports, Math.floor(minThreshold * 1e9));
      let minPerOrderLamports = Math.max(minInLamports, Math.floor(minThreshold * 1e9));
      try {
        const recurringL   = EDGE_TX_FEE_ESTIMATE_LAMPORTS;
        const oneTimeL     = Math.max(0, reqRent);
        const needByRecurr = Math.ceil(recurringL / Math.max(1e-12, MAX_RECURRING_COST_FRAC));
        const needByOne    = Math.ceil(
          oneTimeL / Math.max(1e-12, MAX_ONETIME_COST_FRAC * Math.max(1, ONE_TIME_COST_AMORTIZE))
        );
        const needByFrictionSplit = Math.max(needByRecurr, needByOne);
        minPerOrderLamports = Math.max(minPerOrderLamports, needByFrictionSplit);
      } catch {}
      if (reqRent > 0) {
        const elevatedL = Math.floor(ELEVATED_MIN_BUY_SOL * 1e9);
        minPerOrderLamports = Math.max(minPerOrderLamports, elevatedL);
      }

      if (buyLamports < minPerOrderLamports) {
        const fricMinSol = minPerOrderLamports / 1e9;
        const orderSol   = buyLamports / 1e9;
        const gap        = fricMinSol - orderSol;
        const eps        = 1e-6;
        const snapNear   = orderSol >= (fricMinSol - (state.fricSnapEpsSol + eps));
        const snapBand   = gap <= (Math.max(0.003, 0.06 * fricMinSol) + eps);
        const canCover   = candidateBudgetLamports >= minPerOrderLamports;

        if ((snapNear || snapBand) && canCover) {
          buyLamports = minPerOrderLamports;
          log(`Snap-to-min: bump ${orderSol.toFixed(6)} -> ${fricMinSol.toFixed(6)} SOL to clear friction min.`);
        } else {
          if (reqRent > 0) {
            log(
              `Skip ${mint.slice(0,4)}… (order ${orderSol.toFixed(6)} SOL < friction-aware min ${fricMinSol.toFixed(6)}; ` +
              `split guard rec=${(EDGE_TX_FEE_ESTIMATE_LAMPORTS/1e9).toFixed(6)} oneTime≈${(reqRent/1e9).toFixed(6)} amortN=${ONE_TIME_COST_AMORTIZE}).`
            );
          } else {
            log(`Skip ${mint.slice(0,4)}… (order ${orderSol.toFixed(6)} SOL < friction-aware min ${fricMinSol.toFixed(6)}; recurring-only guard).`);
          }
          continue;
        }
      }

      const prevPos = state.positions[mint];

      let lightPlan = null;
      try {
        const prevSz = Number(prevPos?.sizeUi || 0);
        const prevCost = Number(prevPos?.costSol || 0);
        const isFreshEntry = !(prevSz > 0 || prevCost > 0);
        if (isFreshEntry) {
          const lightEnabled = (state.lightEntryEnabled !== false);
          const lightFrac = (() => {
            const x = Number(state.lightEntryFraction);
            if (Number.isFinite(x) && x > 0 && x < 1) return Math.max(0.1, Math.min(0.9, x));
            return LIGHT_ENTRY_FRACTION;
          })();
          if (!lightEnabled) throw new Error("light-off");

          const fullL = Math.floor(buyLamports);
          const lightL = Math.floor(fullL * lightFrac);
          const remL = Math.max(0, fullL - lightL);
          if (lightL >= minPerOrderLamports && remL >= minPerOrderLamports) {
            buyLamports = lightL;
            lightPlan = { fullLamports: fullL, remainingLamports: remL };
            log(
              `Light entry ${mint.slice(0,4)}…: now ${(lightL/1e9).toFixed(6)} SOL, later ${(remL/1e9).toFixed(6)} SOL on trend-up.`
            );
          } else {
            log(
              `Light entry skipped ${mint.slice(0,4)}…: buy ${(fullL/1e9).toFixed(6)} SOL cannot split into two legs >= ${(minPerOrderLamports/1e9).toFixed(6)} SOL (continuing with full-size entry eval).`
            );
          }
        }
      } catch {}

      // True-ish net accounting: include one-time ATA rent (wSOL + out ATA if needed)
      // and a conservative buy-side tx fee estimate into cost basis.
      let buySol = buyLamports / 1e9;
      let buyCostSol = buySol + (Math.max(0, reqRent) + Math.max(0, EDGE_TX_FEE_ESTIMATE_LAMPORTS)) / 1e9;

      let entryEdgeExclPct = NaN;
      let entryEdgeCostPct = 0;
      let entryTpBumpPct = 0;
      let entryBaseGoalPct = NaN;
      let entryRequiredGrossTpPct = NaN;
      let entrySim = null;
      let entryBadge = "";
      let entryEdge = null;
      let entryEdgeSummary = null;
      let entryRugSignal = null;
      let entryLeaderSeries = null;
      let entryLeaderNow = null;
      let entryKpiPick = null;
      let entryFinalGate = null;

      try {
        let agentActiveForBuy = false;
        let agentRiskForBuy = null;
        try {
          const agent = getAutoTraderAgent();
          const cfg = agent?.getConfigFromRuntime ? agent.getConfigFromRuntime() : null;
          agentActiveForBuy = !!(cfg && cfg.enabled !== false && String(cfg.openaiApiKey || "").trim());

          if (cfg) {
            const raw = String(cfg?.riskLevel || "safe").trim().toLowerCase();
            agentRiskForBuy = (raw === "safe" || raw === "medium" || raw === "degen") ? raw : "safe";
          }
        } catch {}

        const simMode = String(state.entrySimMode || "enforce").toLowerCase();
        let simEnabled = simMode !== "off";
        const horizonSecsBase = Math.max(30, Math.min(600, Number(state.entrySimHorizonSecs || 120)));
        const horizonCapHold = Math.max(30, Math.min(600, Number(state.maxHoldSecs || HOLD_MAX_SECS)));
        const minWinProb = Math.max(0, Math.min(1, Number(state.entrySimMinWinProb || 0.55)));
        const minTerminalProb = Math.max(0, Math.min(1, Number(state.entrySimMinTerminalProb ?? 0.60)));

        entryRugSignal = (() => {
          try { return _summarizeRugSignal(getRugSignalForMint(mint)) || null; } catch { return null; }
        })();

        const edge = await estimateRoundtripEdgePct(
          kp.publicKey.toBase58(),
          mint,
          buySol,
          { slippageBps: state.slippageBps, dynamicFee: true, ataRentLamports: reqRent }
        );
        entryEdge = edge;
        entryEdgeSummary = _summarizeEdge(edge);
        // let needPct = Number.isFinite(Number(state.minNetEdgePct)) ? Number(state.minNetEdgePct) : -8;
        // try {
        //   const badgeNow = normBadge(getRugSignalForMint(mint)?.badge);
        //   if (badgeNow === "pumping") needPct = needPct - 2.0; // allow a bit more friction on live pumps
        //   if (badgeNow === "warming") {
        //     const minEx = Math.max(0, Number(state.warmingEdgeMinExclPct ?? 0));
        //     if (!edge) { log(`Skip ${mint.slice(0,4)}… (no round-trip quote)`); continue; }
        //     if (Number(edge.pctNoOnetime) < minEx) {
        //       log(`Skip ${mint.slice(0,4)}… warming edge excl-ATA ${Number(edge.pctNoOnetime).toFixed(2)}% < ${minEx}%`);
        //       continue;
        //     }
        //   }
        // } catch {}
            const badgeNow = normBadge(entryRugSignal?.badge);
            entryBadge = badgeNow;
        if (!edge) { log(`Skip ${mint.slice(0,4)}… (no round-trip quote)`); continue; }

        // const hasOnetime = Number(edge.ataRentLamports || 0) > 0;
        // const incl = Number(edge.pct);          // includes one-time ATA rent
        const excl = Number(edge.pctNoOnetime); // excludes one-time ATA rent

        entryEdgeExclPct = excl;

          // Manual edge gating (before Agent Gary sees the coin).
          // Edge is a first-pass gate: if it fails, we do not proceed further.
          const manualMinEdgePct = Number.isFinite(Number(state.minNetEdgePct)) ? Number(state.minNetEdgePct) : null;
          if (Number.isFinite(manualMinEdgePct) && Number.isFinite(excl) && excl < manualMinEdgePct) {
            log(
              `Skip ${mint.slice(0,4)}… (manual edge gate: edgeExcl=${excl.toFixed(2)}% < minNetEdgePct=${manualMinEdgePct.toFixed(2)}%)`
            );
            continue;
          }

        entryEdgeCostPct = Math.max(0, -excl);

        // Entry-cost hard gate for Agent Gary safe/medium risk: avoid deeply negative entries.
        // (In degen risk, allow higher friction by design.)
        try {
          if (agentActiveForBuy && !agentBypassNonEdgeGates) {
            const risk = agentRiskForBuy || "safe";
            const maxCost = Number(state.maxEntryCostPct ?? 1.5);
            const gateOn = Number.isFinite(maxCost) && maxCost > 0;
            const enforceForRisk = (risk === "safe" || risk === "medium");
            if (gateOn && enforceForRisk && Number.isFinite(entryEdgeCostPct) && entryEdgeCostPct > maxCost) {
              log(
                `Skip ${mint.slice(0,4)}… (entry cost gate: edgeCost=${entryEdgeCostPct.toFixed(2)}% > maxEntryCostPct=${maxCost.toFixed(2)}% for risk=${risk})`
              );
              continue;
            }
          }
        } catch {}
        const buffer   = Math.max(0, Number(state.edgeSafetyBufferPct || 0.1));
        entryTpBumpPct = entryEdgeCostPct + buffer;

        const baseGoal = Math.max(0.5, Number(state.minProfitToTrailPct || 2));
        const requiredGrossTp = baseGoal + entryTpBumpPct;
        entryBaseGoalPct = baseGoal;
        entryRequiredGrossTpPct = requiredGrossTp;

        let horizonSecs = horizonSecsBase;
        if (simEnabled) {
          // Ensure we have enough series before sim-gating.
          let _seriesN = 0;
          try { _seriesN = (getLeaderSeries(mint, 3) || []).length; } catch {}
          if (_seriesN < 3) {
            try { await focusMintAndRecord(mint, { refresh: true, ttlMs: 2000 }); } catch {}
            try { _seriesN = (getLeaderSeries(mint, 3) || []).length; } catch {}
            if (_seriesN < 3) {
              // Hard requirement: do not buy without enough samples.
              const msg = `Skip ${mint.slice(0,4)}… (need leader series >=3; have ${_seriesN}/3)`;
              log(msg);
              if (!agentBypassNonEdgeGates) continue;
              simEnabled = false;
            }
          }

          try {
            const s3 = getLeaderSeries(mint, 3) || [];
            const last3 = s3[s3.length - 1] || {};
            const chg5mNow = Number(last3?.chg5m ?? NaN);
            if (Number.isFinite(chg5mNow) && chg5mNow > 0.5 && requiredGrossTp > 0) {
              const impliedPerSec = chg5mNow / 300;
              const secsToMean = requiredGrossTp / impliedPerSec;
              const want = Math.ceil(secsToMean * 1.12); // nudge so mean is slightly above the goal
              horizonSecs = Math.max(horizonSecs, Math.min(horizonCapHold, want));
            }
          } catch {}
        }

        try {
          const fwdLen = Number(edge?.forward?.routePlan?.length || edge?.forward?.routePlanLen || 0);
          const backLen= Number(edge?.backward?.routePlan?.length || edge?.backward?.routePlanLen || 0);
          const feeBps = Number(edge?.platformBpsApplied || 0);
          const fricSolRec = Number(edge.recurringLamports || 0) / 1e9; // recurring only
          const fricPct = buySol > 0 ? (fricSolRec / buySol) * 100 : 0;
          const ataSol = Number(edge.ataRentLamports || 0) / 1e9;
          const mode    = "excl-ATA";
          log(
            `Edge model ${mint.slice(0,4)}… mode=${mode}; ` +
            `edgeExcl=${excl.toFixed(2)}% => edgeCost=${entryEdgeCostPct.toFixed(2)}% + buf=${buffer.toFixed(2)}% => tpBump=${entryTpBumpPct.toFixed(2)}%; ` +
            `fee=${feeBps}bps, routes fwd=${fwdLen} back=${backLen}, ` +
            `friction≈${fricSolRec.toFixed(6)} SOL (${fricPct.toFixed(2)}% of buy ${buySol.toFixed(6)} SOL), ataRent≈${ataSol.toFixed(6)} SOL, ` +
            `grossTPGoal≈${requiredGrossTp.toFixed(2)}% (baseGoal≈${baseGoal.toFixed(2)}% + tpBump≈${entryTpBumpPct.toFixed(2)}%)`
          );
        } catch {}

        if (simEnabled) {
          const sim = simulateEntryChanceFromLeaderSeries(mint, {
            horizonSecs,
            requiredGrossPct: requiredGrossTp,
            sigmaFloorPct: state.entrySimSigmaFloorPct,
            muLevelWeight: state.entrySimMuLevelWeight,
          });
              entrySim = sim;

          if (!sim) {
            // Hard requirement: do not buy without a sim model (insufficient leader series).
            // Agent Gary can tune sizing/slippage and veto, but cannot override missing data.
            const msg = `Skip ${mint.slice(0,4)}… (sim: insufficient leader series)`;
            log(msg);
            if (!agentBypassNonEdgeGates) continue;
          } else {
            log(
              `Sim gate ${mint.slice(0,4)}… horizon=${sim.horizonSecs}s ` +
              `mu≈${Number(sim.muPct).toFixed(2)}% σ≈${Number(sim.sigmaPct).toFixed(2)}% ` +
              `P(hit≥${requiredGrossTp.toFixed(2)}%)≈${(Number(sim.pHit) * 100).toFixed(1)}% ` +
              `P(term≥${requiredGrossTp.toFixed(2)}%)≈${(Number(sim.pTerminal) * 100).toFixed(1)}% ` +
              `(minHit ${(minWinProb * 100).toFixed(0)}%, minTerm ${(minTerminalProb * 100).toFixed(0)}%)`
            );

            if (!(Number(sim.pHit) >= minWinProb)) {
              const msg =
                `Skip ${mint.slice(0,4)}… sim P(hit goal) ${(Number(sim.pHit) * 100).toFixed(1)}% < ${(minWinProb * 100).toFixed(0)}% ` +
                `(goal≈${requiredGrossTp.toFixed(2)}% = baseGoal + edgeCost + buf)`;
              // Enforce means enforce (do not allow agent overrides here).
              if (simMode === "enforce" && !agentBypassNonEdgeGates) { log(msg); continue; }
              log(msg.replace(/^Skip /, agentBypassNonEdgeGates ? "Sim bypass " : "Sim warn "));
            }

            if (Number.isFinite(minTerminalProb) && minTerminalProb > 0 && !(Number(sim.pTerminal) >= minTerminalProb)) {
              const msg =
                `Skip ${mint.slice(0,4)}… sim P(terminal goal) ${(Number(sim.pTerminal) * 100).toFixed(1)}% < ${(minTerminalProb * 100).toFixed(0)}% ` +
                `(goal≈${requiredGrossTp.toFixed(2)}%)`;
              if (simMode === "enforce" && !agentBypassNonEdgeGates) { log(msg); continue; }
              log(msg.replace(/^Skip /, agentBypassNonEdgeGates ? "Sim bypass " : "Sim warn "));
            }
          }
        }
      } catch {
        log(`Skip ${mint.slice(0,4)}… (edge calc failed)`);
        continue;
      }

      const ownerStr = kp.publicKey.toBase58();
      const basePos  = prevPos || { costSol: 0, hwmSol: 0, acquiredAt: now() };

        let dynSlip = Math.max(150, Number(state.slippageBps || 150));
        let liqUsdHint = NaN;
        let solUsdHint = NaN;
        let priceImpactProxy = NaN;
      try {
        const leadersNow = computePumpingLeaders(3) || [];
        const itNow = leadersNow.find(x => x?.mint === mint);
        const kpNow = itNow?.kp || {};
          const solPx = await getSolUsd();
          const liq = Number(kpNow.liqUsd || 0);
          solUsdHint = solPx;
          liqUsdHint = liq;
        if (solPx > 0 && liq > 0) {
            const imp = Math.max(0, Math.min(0.01, (buySol * solPx) / liq)); // cap at 1%
            priceImpactProxy = imp;
          dynSlip = Math.min(600, Math.max(150, Math.floor(10000 * imp * 1.2)));
        }
      } catch {}

      try {
        entryLeaderSeries = _summarizeLeaderSeries(mint, 6);
        if (entryLeaderSeries && entryLeaderSeries.length) {
          // Do not share object references between `leaderNow` and `leaderSeries`.
          entryLeaderNow = { ...(entryLeaderSeries[entryLeaderSeries.length - 1] || {}) };
        }
      } catch {}

        // Agent gate (required when enabled): when Agent Gary is ON, do not buy unless he explicitly says "buy".
        {
          let agent = null;
          let cfg = null;
          let enabledFlag = false;
          let keyPresent = false;

          try {
            agent = getAutoTraderAgent();
            cfg = agent?.getConfigFromRuntime ? agent.getConfigFromRuntime() : null;
            enabledFlag = !!(cfg && cfg.enabled !== false);
            keyPresent = !!String(cfg?.openaiApiKey || "").trim();
          } catch {}

          const requireApproval = enabledFlag;

          if (requireApproval && !keyPresent) {
            log(`[AGENT GARY] buy blocked ${mint.slice(0,4)}… (agent enabled but missing key)`);
            continue;
          }

          if (enabledFlag && keyPresent && agent && typeof agent.decideBuy === "function") {
            const _riskRaw = String(cfg?.riskLevel || "safe").trim().toLowerCase();
            const _riskLevel = (_riskRaw === "safe" || _riskRaw === "medium" || _riskRaw === "degen") ? _riskRaw : "safe";

            try { entryKpiPick = _kpiPickByMint.get(mint) || null; } catch { entryKpiPick = null; }
            try { entryFinalGate = computeFinalGateIntensity(mint); } catch { entryFinalGate = null; }

            const posCount = (() => {
              try { return Object.keys(state.positions || {}).filter((m) => m && m !== SOL_MINT).length; } catch { return 0; }
            })();

            const prevPosSnap = (() => {
              try {
                const p = prevPos || null;
                if (!p) return null;
                return {
                  sizeUi: Number(p?.sizeUi || 0),
                  costSol: Number(p?.costSol || 0),
                  acquiredAt: Number(p?.acquiredAt || 0),
                  lastBuyAt: Number(p?.lastBuyAt || 0),
                  lastSellAt: Number(p?.lastSellAt || 0),
                };
              } catch { return null; }
            })();

            let adec;
            try {
              adec = await agent.decideBuy({
                mint,
                proposedBuySolUi: buySol,
                proposedSlippageBps: dynSlip,
                signals: {
                  agentRisk: _riskLevel,
                  targets: {
                    sessionPnlSol: getSessionPnlSol(),
                    minNetEdgePct: Number(state.minNetEdgePct),
                    edgeExclPct: Number.isFinite(entryEdgeExclPct) ? entryEdgeExclPct : null,
                    edgeSafetyBufferPct: Number(state.edgeSafetyBufferPct),
                    baseGoalPct: Number.isFinite(entryBaseGoalPct) ? Number(entryBaseGoalPct) : null,
                    requiredGrossTpPct: Number.isFinite(entryRequiredGrossTpPct) ? Number(entryRequiredGrossTpPct) : null,
                    takeProfitPct: Number(state.takeProfitPct),
                  },
                  outcomes: {
                    sessionPnlSol: getSessionPnlSol(),
                    recent: (() => { try { return agentOutcomes.summarize(8); } catch { return []; } })(),
                    lastForMint: (() => { try { return agentOutcomes.lastForMint(mint); } catch { return null; } })(),
                  },
                  kpiPick: entryKpiPick,
                  finalGate: entryFinalGate,
                  tickNow: _summarizePumpTickNowForMint(mint),
                  badge: entryBadge,
                  rugSignal: entryRugSignal,
                  leaderNow: entryLeaderNow,
                  leaderSeries: entryLeaderSeries,
                  past: _summarizePastCandlesForMint(mint, 24),
                  entryEdgeExclPct: Number.isFinite(entryEdgeExclPct) ? entryEdgeExclPct : null,
                  entryTpBumpPct: Number.isFinite(entryTpBumpPct) ? entryTpBumpPct : null,
                  entrySim,
                  edge: entryEdgeSummary,
                  liqUsd: Number.isFinite(liqUsdHint) ? liqUsdHint : null,
                  solUsd: Number.isFinite(solUsdHint) ? solUsdHint : null,
                  priceImpactProxy,
                  buySolUi: buySol,
                  buyCostSolUi: buyCostSol,
                  reqRentLamports: reqRent,
                  minPerOrderLamports,
                  wallet: {
                    holdingsUi: Number(state.holdingsUi || 0),
                    budgetUi: Number(state.budgetUi || 0),
                    buyPct: Number(state.buyPct || 0),
                    minBuySol: Number(state.minBuySol || 0),
                    maxBuySol: Number(state.maxBuySol || 0),
                    maxTrades: Number(state.maxTrades || 0),
                    posCount,
                  },
                  prevPos: prevPosSnap,
                  stateKnobs: {
                    minNetEdgePct: state.minNetEdgePct,
                    edgesafetyBufferPct: state.edgeSafetyBufferPct,
                    slippageBps: state.slippageBps,
                    buyPct: state.buyPct,
                    minProfitToTrailPct: state.minProfitToTrailPct,
                    minHoldSecs: state.minHoldSecs,
                    maxHoldSecs: state.maxHoldSecs,
                    takeProfitPct: state.takeProfitPct,
                    stopLossPct: state.stopLossPct,
                    trailPct: state.trailPct,
                    maxEntryCostPct: state.maxEntryCostPct,
                    entrySimMode: state.entrySimMode,
                    entrySimHorizonSecs: state.entrySimHorizonSecs,
                    entrySimMinWinProb: state.entrySimMinWinProb,
                    entrySimMinTerminalProb: state.entrySimMinTerminalProb,
                  },
                },
              });
            } catch (e) {
              if (requireApproval) {
                log(`[AGENT GARY] buy blocked ${mint.slice(0,4)}… (request failed)`);
                continue;
              }
              adec = null;
            }

            if (!(adec?.ok && adec.decision)) {
              if (requireApproval) {
                const err = String(adec?.err || "no decision");
                log(`[AGENT GARY] buy blocked ${mint.slice(0,4)}… (${err.slice(0, 120)})`);
                continue;
              }
            } else {
              const d = adec.decision;

              try { if (d && d.evolve) agentOutcomes.applyEvolve(d.evolve); } catch {}
              try { if (d.tune) _applyAgentTune(d.tune, { source: "buy", mint, confidence: d.confidence, reason: d.reason }); } catch {}

              if (String(d.action || "").toLowerCase() !== "buy") {
                log(`[AGENT GARY] veto ${mint.slice(0,4)}… (${String(d.reason || "not approved")})`);
                continue;
              }

              let tuneBits = [];
              if (d.buy && Number.isFinite(Number(d.buy.slippageBps))) {
                const s = Math.max(50, Math.min(2500, Math.floor(Number(d.buy.slippageBps))));
                if (s !== dynSlip) tuneBits.push(`slip ${dynSlip}→${s}`);
                dynSlip = s;
              }
              if (d.buy && Number.isFinite(Number(d.buy.solUi))) {
                const wantLamports = Math.floor(Math.max(0, Number(d.buy.solUi)) * 1e9);
                const capLamports = Math.floor(Math.max(0, buySol) * 1e9);
                const nextLamports = Math.min(capLamports, wantLamports);
                if (nextLamports >= Math.max(minPerOrderLamports, Math.floor(MIN_JUP_SOL_IN * 1e9))) {
                  if (nextLamports !== buyLamports) tuneBits.push(`sol ${(buyLamports/1e9).toFixed(4)}→${(nextLamports/1e9).toFixed(4)}`);
                  buyLamports = nextLamports;
                  buySol = buyLamports / 1e9;
                  buyCostSol = buySol + (Math.max(0, reqRent) + Math.max(0, EDGE_TX_FEE_ESTIMATE_LAMPORTS)) / 1e9;
                }
              }
              try {
                const t = tuneBits.length ? ` tune=[${tuneBits.join(", ")}]` : "";
                log(`[AGENT GARY] BUY ok ${mint.slice(0,4)}… conf=${Number(d.confidence||0).toFixed(2)} ${String(d.reason||"")}${t}`);
              } catch {}
            }
          }
        }

      const res = await _getDex().buyWithConfirm(
        { signer: kp, mint, solUi: buySol, slippageBps: dynSlip },
        { retries: 2, confirmMs: 32000 },
      );

      try { _noteDexTx("buy", mint, res, { solUi: buySol, slippageBps: dynSlip }); } catch {}

      if (!res.ok) {
        try {
          const seed = getBuySeed(ownerStr, mint);
          if (seed && Number(seed.sizeUi || 0) > 0) {
            optimisticSeedBuy(ownerStr, mint, Number(seed.sizeUi), Number(seed.decimals), buyCostSol, res.sig || "");
            clearBuySeed(ownerStr, mint);
            log(`Buy unconfirmed for ${mint.slice(0,4)}… seeded pending credit watch.`);
            } else {

            if (res.sig) {
              enqueuePendingCredit({
                owner: ownerStr,
                mint,
                addCostSol: buyCostSol,
                decimalsHint: basePos.decimals,
                basePos: { ...basePos, awaitingSizeSync: true },
                sig: res.sig
              });
              log(`Buy not confirmed for ${mint.slice(0,4)}… enqueued tx-meta reconciliation.`);
            } else {
              log(`Buy not confirmed for ${mint.slice(0,4)}… skipping accounting.`);
            }
          }
        } catch {
          log(`Buy not confirmed for ${mint.slice(0,4)}… skipping accounting.`);
        }
        continue;
      }
      try {
        const seed = getBuySeed(ownerStr, mint);
        if (seed && Number(seed.sizeUi || 0) > 0) {
          optimisticSeedBuy(ownerStr, mint, Number(seed.sizeUi), Number(seed.decimals), buyCostSol, res.sig || "");
          clearBuySeed(ownerStr, mint);
        }
      } catch {}



      remainingLamports = Math.max(0, remainingLamports - buyLamports - reqRent);
      remaining = remainingLamports / 1e9;

      // let credited = false;
      let got = { sizeUi: 0, decimals: Number.isFinite(basePos.decimals) ? basePos.decimals : 6 };
      try {
        got = await waitForTokenCredit(kp.publicKey.toBase58(), mint, { timeoutMs: 8000, pollMs: 300 });
      } catch (e) { log(`Token credit wait failed: ${e.message || e}`); }

      if (!Number(got.sizeUi || 0) && res.sig) {
        try {
          const metaHit = await reconcileBuyFromTx(res.sig, kp.publicKey.toBase58(), mint);
          if (metaHit && metaHit.mint === mint && Number(metaHit.sizeUi || 0) > 0) {
            got = { sizeUi: Number(metaHit.sizeUi), decimals: Number.isFinite(metaHit.decimals) ? metaHit.decimals : got.decimals };
            log(`Buy registered via tx meta for ${mint.slice(0,4)}… (${got.sizeUi.toFixed(6)})`);
          }
        } catch {}
      }

      if (Number(got.sizeUi || 0) === 0) {
        const prevPos = state.positions[mint];
        if (prevPos) prevPos._pendingCostAug = true;
      } else {
        const prevPos = state.positions[mint];
        if (prevPos && prevPos._pendingCostAug) delete prevPos._pendingCostAug;
      }

      if (Number(got.sizeUi || 0) > 0) {
        const badgeNow = normBadge(getRugSignalForMint(mint)?.badge);
        const warmingHold = !!state.rideWarming;
        const guardMs = Math.max(10_000, Number(state.observerGraceSecs || 0) * 1000);
        let entryChg5m = 0, entryPre = NaN, entryPreMin = NaN, entryScSlope = NaN;
        try {
          const leadersNow = computePumpingLeaders(3) || [];
          const itNow = leadersNow.find(x => x?.mint === mint);
          const kpNow = itNow?.kp || {};
          const metaNow = itNow?.meta || {};
          const warm = detectWarmingUptick({ kp: { ...kpNow, mint }, meta: metaNow }, state);
          const series = getLeaderSeries(mint, 3);
          entryChg5m = Number(series?.[series.length - 1]?.chg5m || kpNow.change5m || 0);
          entryPre = Number(warm?.pre || NaN);
          entryPreMin = Number(warm?.preMin || NaN);
          entryScSlope = Number(slope3pm(series || [], "pumpScore") || NaN);
        } catch {}

        const pos = {
          ...basePos,
          sizeUi: got.sizeUi,
          decimals: got.decimals,
          costSol: Number(basePos.costSol || 0) + buyCostSol,
          hwmSol: Math.max(Number(basePos.hwmSol || 0), buyCostSol),
          lastBuyAt: now(),
          lastSeenAt: now(),
          awaitingSizeSync: false,
          allowRebuy: false,
          lastSplitSellAt: undefined,
          warmingHold: warmingHold,
          warmingHoldAt: warmingHold ? now() : undefined,
          warmingMinProfitPct: Number.isFinite(Number(state.warmingMinProfitPct)) ? Number(state.warmingMinProfitPct) : 2,
          sellGuardUntil: now() + guardMs,
          entryChg5m,
          entryPre,
          entryPreMin,
          entryScSlope,
          entryEdgeExclPct: Number.isFinite(entryEdgeExclPct) ? entryEdgeExclPct : undefined,
          entryEdgeCostPct: Number.isFinite(entryEdgeCostPct) ? entryEdgeCostPct : undefined,
          entryTpBumpPct: Number.isFinite(entryTpBumpPct) ? entryTpBumpPct : undefined,
          earlyNegScCount: 0,

          // Light-entry bookkeeping
          lightEntry: !!lightPlan,
          lightPlannedSol: lightPlan ? (Number(lightPlan.fullLamports || 0) / 1e9) : undefined,
          lightRemainingSol: lightPlan ? (Number(lightPlan.remainingLamports || 0) / 1e9) : 0,
          lightTopUpArmedAt: lightPlan ? (now() + Math.max(1000, Number(state.lightTopUpArmMs || LIGHT_TOPUP_ARM_MS))) : undefined,
          lightTopUpTries: lightPlan ? 0 : undefined,
        };
        try {
          const dyn = pickTpSlForMint(mint);
          pos.tpPct = Math.min(500, Number(dyn.tp) + (Number.isFinite(entryTpBumpPct) ? entryTpBumpPct : 0));
          pos.slPct = dyn.sl;
          pos.trailPct = dyn.trailPct;
          pos.minProfitToTrailPct = dyn.arm;
          log(`Dynamic TP/SL ${mint.slice(0,4)}…: TP=${pos.tpPct}% (base ${dyn.tp}% + bump ${Number(entryTpBumpPct||0).toFixed(2)}%) SL=${dyn.sl}% Trail=${dyn.trailPct}% Arm=${dyn.arm}% (${dyn.tier} I=${dyn.intensity.toFixed(2)})`);
        } catch {}
        state.positions[mint] = pos;
        updatePosCache(kp.publicKey.toBase58(), mint, pos.sizeUi, pos.decimals);
        save();
        try { clearPendingCredit(kp.publicKey.toBase58(), mint); } catch {}
        log(`Bought ~${buySol.toFixed(4)} SOL -> ${mint.slice(0,4)}…`);
        clearObserverConsider(mint);
        try { await focusMintAndRecord(mint, { refresh: true, ttlMs: 88 }); } catch {}
        try { updateStatsHeader(); } catch {}
      } else {
        log(`Buy confirmed for ${mint.slice(0,4)}… but no token credit yet; will sync later.`);
        const badgeNow = normBadge(getRugSignalForMint(mint)?.badge);
        const warmingHold = !!state.rideWarming;
        const guardMs = Math.max(10_000, Number(state.observerGraceSecs || 0) * 1000);
        let entryChg5m = 0, entryPre = NaN, entryPreMin = NaN, entryScSlope = NaN;
        try {
          const leadersNow = computePumpingLeaders(3) || [];
          const itNow = leadersNow.find(x => x?.mint === mint);
          const kpNow = itNow?.kp || {};
          const metaNow = itNow?.meta || {};
          const warm = detectWarmingUptick({ kp: { ...kpNow, mint }, meta: metaNow }, state);
          const series = getLeaderSeries(mint, 3);
          entryChg5m = Number(series?.[series.length - 1]?.chg5m || kpNow.change5m || 0);
          entryPre = Number(warm?.pre || NaN);
          entryPreMin = Number(warm?.preMin || NaN);
          entryScSlope = Number(slope3pm(series || [], "pumpScore") || NaN);
        } catch {}

        const pos = {
          ...basePos,
          // Defer cost augmentation until the token credit reconciles (avoid double-counting).
          costSol: Number(basePos.costSol || 0),
          hwmSol: Number(basePos.hwmSol || 0),
          lastBuyAt: now(),
          awaitingSizeSync: true,
          allowRebuy: false,
          lastSplitSellAt: undefined,
          warmingHold: warmingHold,
          warmingHoldAt: warmingHold ? now() : undefined,
          warmingMinProfitPct: Number.isFinite(Number(state.warmingMinProfitPct)) ? Number(state.warmingMinProfitPct) : 2,
          sellGuardUntil: now() + guardMs,
          entryChg5m,
          entryPre,
          entryPreMin,
          entryScSlope,
          entryEdgeExclPct: Number.isFinite(entryEdgeExclPct) ? entryEdgeExclPct : undefined,
          entryEdgeCostPct: Number.isFinite(entryEdgeCostPct) ? entryEdgeCostPct : undefined,
          entryTpBumpPct: Number.isFinite(entryTpBumpPct) ? entryTpBumpPct : undefined,
          earlyNegScCount: 0,
        };
        try {
          const dyn = pickTpSlForMint(mint);
          pos.tpPct = Math.min(500, Number(dyn.tp) + (Number.isFinite(entryTpBumpPct) ? entryTpBumpPct : 0));
          pos.slPct = dyn.sl;
          pos.trailPct = dyn.trailPct;
          pos.minProfitToTrailPct = dyn.arm;
          log(`Dynamic TP/SL ${mint.slice(0,4)}…: TP=${pos.tpPct}% (base ${dyn.tp}% + bump ${Number(entryTpBumpPct||0).toFixed(2)}%) SL=${dyn.sl}% Trail=${dyn.trailPct}% Arm=${dyn.arm}% (${dyn.tier} I=${dyn.intensity.toFixed(2)})`);
        } catch {}
        state.positions[mint] = pos;
        save();
        enqueuePendingCredit({
          owner: kp.publicKey.toBase58(),
          mint,
          addCostSol: buyCostSol,
          decimalsHint: basePos.decimals,
          basePos: pos,
          sig: res.sig
        });
        try { await processPendingCredits(); } catch {}
        try { await focusMintAndRecord(mint, { refresh: true, ttlMs: 88 }); } catch {}
        try { updateStatsHeader(); } catch {}
      }

      spent += buySol;
      plannedTotal = Math.max(0, plannedTotal - buySol);
      buysDone++;
      _buyBatchUntil = now() + (state.multiBuyBatchMs|0);

      if (leaderMode) break;

      // no double buys
      if (!state.allowMultiBuy) break;

      await new Promise(r => setTimeout(r, 150));
      if (remaining < minThreshold) break;
    }

    state.carrySol = 0; // disable carry accumulation after buy attempts
    if (buysDone > 0) {
      state.lastTradeTs = now();
      save();
    }
  } catch (e) {
    log(`Buy failed: ${e.message||e}`);
  } finally {
    _buyInFlight = false;
    if (haveBuyLock) releaseBuyLock();
  }
}

async function startAutoAsync() {
  if (_starting) return;
  _starting = true;
  try {

    if (!Number.isFinite(state.pnlBaselineSol)) {
      state.pnlBaselineSol = Number(state.moneyMadeSol || 0);
      save();
    }

    try { updateStatsHeader(); } catch {}

    if (!state.endAt && state.lifetimeMins > 0) {
      state.endAt = now() + state.lifetimeMins*60_000;
      save();
    }

    try {
      const conn = await getConn();
      await conn.getLatestBlockhash("processed");
      log("RPC preflight OK.");
    } catch (e) {
      log(`RPC preflight failed: ${e.message || e}`);
      state.enabled = false;
      if (toggleEl) toggleEl.value = "no";
      try { if (startBtn) startBtn.disabled = false; } catch {}
      try { if (stopBtn) stopBtn.disabled = true; } catch {}
      save();
      try { renderStatusLed(); } catch {}
      return;
    }


    // Always enable stealth while Agent Gary mode is effective.
    // If stealth was off, rotate once at start (same behavior as Generate/Rotate) before trading begins.
    const agentEff = _isAgentGaryEffective();
    if (agentEff) {
      const wasOff = !state.stealthMode;
      if (wasOff) {
        state.stealthMode = true;
        save();
        try { if (stealthEl) stealthEl.value = "yes"; } catch {}
        log("Stealth forced ON (Agent Gary mode).", "help");
      }
      if (wasOff) {
        try { await rotateAutoWalletLikeGenerate({ tag: "agent-start", requireStopped: false, allowWhileEnabled: true }); } catch {}
      }
    }

    log("Join us on telegram: https://t.me/fdvlolgroup for community discussions!"); 

    // Agent Gary startup: scan market and apply best config once per page load.
    // Must happen before the trading timer starts so gates use the new settings.
    try {
      if (_isAgentGaryEffective()) {
        await _maybeRunAgentConfigScanAtStart();
      }
    } catch {}

    const kp = await getAutoKeypair();
    if (kp) await syncPositionsFromChain(kp.publicKey.toBase58());
    await sweepNonSolToSolAtStart();
    if (state.dustExitEnabled) {
      try { await sweepDustToSolAtStart(); } catch {}
    }
    if (!timer && state.enabled) {
      timer = setInterval(tick, Math.max(1200, Number(state.tickMs || 1000)));
      log("Auto trading started");

      try {
        const agent = getAutoTraderAgent();
        const cfg = agent && typeof agent.getConfigFromRuntime === "function" ? agent.getConfigFromRuntime() : {};
        const enabledFlag = cfg && (cfg.enabled !== false);
        const keyPresent = !!String(cfg?.openaiApiKey || "").trim();
        const eff = enabledFlag && keyPresent;
        const model = String(cfg?.openaiModel || "gpt-4o-mini").trim() || "gpt-4o-mini";
        log(`Agent Gary Mode: ${eff ? "ACTIVE" : (enabledFlag ? "INACTIVE (missing key)" : "OFF")} (model=${model})`);
      } catch {}
    }
    startFastObserver();
  } finally {
    _starting = false;
  }
}

function __fdvCli_isHeadless() {
  try {
    const o = globalThis && globalThis.__fdvAutoBotOverrides;
    return !!(o && typeof o === "object" && o.headless);
  } catch {
    return false;
  }
}

let _cliKpiFeederStop = null;

async function __fdvCli_startKpiFeeder() {
  try {
    if (!_isNodeLike() || !__fdvCli_isHeadless()) return false;
    if (typeof _cliKpiFeederStop === "function") return true;

    const intervalMs = Math.max(2000, Number(state.kpiFeedIntervalMs || 10_000));
    const topN = Math.max(12, Number(state.kpiFeedTopN || 60));

    const { startKpiFeeder } = await import("./cli/helpers/kpiFeeder.node.js");
    _cliKpiFeederStop = startKpiFeeder({ log, intervalMs, topN });
    return true;
  } catch (e) {
    try { log(`KPI feeder failed to start: ${e?.message || e}`, "warn"); } catch {}
    _cliKpiFeederStop = null;
    return false;
  }
}

function __fdvCli_stopKpiFeeder() {
  try {
    if (typeof _cliKpiFeederStop === "function") _cliKpiFeederStop();
  } catch {}
  _cliKpiFeederStop = null;
}

export function __fdvCli_applyProfile(profile = {}) {
  if (!profile || typeof profile !== "object") throw new Error("profile must be an object");

  // Do not load browser-local defaults under Node.
  state.loadDefaultState = false;

  // Apply plain state keys.
  for (const [k, v] of Object.entries(profile)) {
    if (!k) continue;
    if (k === "rpcUrl" || k === "rpcHeaders") continue; // handled below
    state[k] = v;
  }

  // Apply RPC values using internal setters (resets cached conn).
  if ("rpcUrl" in profile) {
    try { setRpcUrl(String(profile.rpcUrl || "")); } catch {}
  }
  if ("rpcHeaders" in profile) {
    try {
      const v = profile.rpcHeaders;
      if (typeof v === "string") setRpcHeaders(v);
      else setRpcHeaders(JSON.stringify(v || {}));
    } catch {}
  }

  save();
  return true;
}

export async function __fdvCli_start({ enable = true } = {}) {
  // Mark headless so internal code can avoid UI assumptions if needed later.
  try {
    if (!globalThis.__fdvAutoBotOverrides || typeof globalThis.__fdvAutoBotOverrides !== "object") {
      globalThis.__fdvAutoBotOverrides = {};
    }
    globalThis.__fdvAutoBotOverrides.headless = true;
  } catch {}

  if (enable) state.enabled = true;
  try { (await import('../lib/led.js')).setBotRunning?.('trader', !!state.enabled); } catch {}

  // Basic safety check.
  if (!currentRpcUrl()) throw new Error("Missing rpcUrl (set state.rpcUrl or provide profile.rpcUrl)");

  // Avoid startAutoAsync()'s UI coupling by doing a minimal headless start.
  if (_starting) return true;
  _starting = true;
  try {
    if (!Number.isFinite(state.pnlBaselineSol)) {
      state.pnlBaselineSol = Number(state.moneyMadeSol || 0);
      save();
    }

    if (!state.endAt && state.lifetimeMins > 0) {
      state.endAt = now() + state.lifetimeMins * 60_000;
      save();
    }

    // RPC preflight
    try {
      const conn = await getConn();
      await conn.getLatestBlockhash("processed");
      log("RPC preflight OK.");
    } catch (e) {
      log(`RPC preflight failed: ${e?.message || e}`);
      state.enabled = false;
      save();
      return false;
    }

    try {
      const kpFn = _getAutoBotOverride("getAutoKeypair");
      const kp = (typeof kpFn === "function") ? await kpFn() : await getAutoKeypair();
      if (kp) await syncPositionsFromChain(kp.publicKey.toBase58());
    } catch {}

    try { await sweepNonSolToSolAtStart(); } catch {}
    if (state.dustExitEnabled) {
      try { await sweepDustToSolAtStart(); } catch {}
    }

    if (!timer && state.enabled) {
      timer = setInterval(tick, Math.max(1200, Number(state.tickMs || 1000)));
      log("Auto trading started (headless)");
    }
    try { startFastObserver(); } catch {}

    // Headless KPI stream: keep the pumping/leader KPIs fed under Node.
    // (Browser UI ingests snapshots via the home pipeline.)
    try { await __fdvCli_startKpiFeeder(); } catch {}

    save();
    return true;
  } finally {
    _starting = false;
  }
}

export async function __fdvCli_stop({ runFinalSellEval = true } = {}) {
  try {
    state.enabled = false;
    try { (await import('../lib/led.js')).setBotRunning?.('trader', false); } catch {}
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
    try { stopFastObserver(); } catch {}
    try { __fdvCli_stopKpiFeeder(); } catch {}
    if (runFinalSellEval) {
      try {
        const hasOpen = Object.entries(state.positions || {}).some(([m, p]) => m !== SOL_MINT && Number(p?.sizeUi || 0) > 0);
        if (hasOpen) setTimeout(() => { evalAndMaybeSellPositions().catch(() => {}); }, 0);
      } catch {}
    }
    save();
    log("Auto trading stopped (headless)");
    return true;
  } catch {
    return false;
  }
}

function renderStatusLed() {
  // LED is global/aggregated (trader should only report its running state)
  try { import('../lib/led.js').then((m) => m?.setBotRunning?.('trader', !!state.enabled)).catch(() => {}); } catch {}
}

function onToggle(on) {
   state.enabled = !!on;
  try { import('../lib/led.js').then((m) => m?.setBotRunning?.('trader', !!state.enabled)).catch(() => {}); } catch {}
   if (toggleEl) toggleEl.value = state.enabled ? "yes" : "no";
   startBtn.disabled = state.enabled;
   stopBtn.disabled = !state.enabled;
   if (state.enabled && !currentRpcUrl()) {
     log("Configure a CORS-enabled Solana RPC URL before starting.");
     state.enabled = false;
     if (toggleEl) toggleEl.value = "no";
     startBtn.disabled = false;
     stopBtn.disabled = true;
     try { renderStatusLed(); } catch {}
     save();
     try { updateStatsHeader(); } catch {}
     return;
   }
   if (state.enabled && !timer) {
     startAutoAsync();
   } else if (!state.enabled && timer) {
     clearInterval(timer);
     timer = null;
     stopFastObserver();
     try {
       const hasOpen = Object.entries(state.positions||{}).some(([m,p]) => m!==SOL_MINT && Number(p?.sizeUi||0) > 0);
       if (hasOpen) setTimeout(() => { evalAndMaybeSellPositions().catch(()=>{}); }, 0);
     } catch {}
     try { if (pendingCreditsSize() > 0) startPendingCreditWatchdog(); } catch {}
     setTimeout(() => {
       Promise.resolve().then(async () => {
         const kp = await getAutoKeypair().catch(()=>null);
         if (kp) await closeAllEmptyAtas(kp);
       }).catch(()=>{});
     }, 0);
     log("Auto trading stopped");
   }
   try { renderStatusLed(); } catch {}
   save();
}

// config schema version 1
function load() {
  if (!state.loadDefaultState) return;
  let persisted = {};
  try { persisted = JSON.parse(localStorage.getItem(LS_KEY) || "{}") || {}; } catch {}
  state = normalizeState({ ...state, ...persisted });
  save();
}

function save() {
  try { localStorage.setItem(LS_KEY, JSON.stringify(state)); } catch {}
}

function copyLog() {
  try {
    const buf = Array.isArray(window._fdvLogBuffer) ? window._fdvLogBuffer : null;
    const text = (buf && buf.length) 
      ? buf.join("\n")
      : Array.from(logEl?.children || []).filter(n => n?.tagName === "DIV").map(n => n.textContent || "").join("\n");
    if (!text) { log("Log is empty."); return false; }
    navigator.clipboard.writeText(text)
      .then(() => log("Log copied to clipboard"))
      .catch(() => {
        try {
          const ta = document.createElement("textarea");
          ta.value = text;
          ta.style.position = "fixed";
          ta.style.left = "-9999px";
          document.body.appendChild(ta);
          ta.select();
          document.execCommand("copy");
          ta.remove();
          log("Log copied to clipboard");
        } catch {
          log("Copy failed");
        }
      });
    return true;
  } catch {
    log("Copy failed");
    return false;
  }
}

function _snapshotSafeClone(v, maxLen = 250_000) {
  try {
    const s = JSON.stringify(v, (k, val) => {
      const key = String(k || "");
      if (/secret|private|seed|keypair|secretKey|autoWalletSecret|rpcHeaders|authorization/i.test(key)) return "[redacted]";
      if (key === "kp") return "[redacted:kp]";
      if (typeof val === "bigint") return String(val);
      if (typeof val === "function") return `[fn ${val.name || "anonymous"}]`;
      return val;
    });
    if (typeof s === "string" && s.length > maxLen) {
      return JSON.parse(s.slice(0, maxLen));
    }
    return JSON.parse(s);
  } catch {
    return null;
  }
}

function _getSafeStateForSnapshot() {
  try {
    return {
      enabled: !!state.enabled,
      holdUntilLeaderSwitch: !!state.holdUntilLeaderSwitch,
      rideWarming: !!state.rideWarming,
      warmingNoHardStopSecs: Number(state.warmingNoHardStopSecs || 0),
      reboundGateEnabled: !!state.reboundGateEnabled,
      reboundHoldMs: Number(state.reboundHoldMs || 0),

      takeProfitPct: Number(state.takeProfitPct || 0),
      stopLossPct: Number(state.stopLossPct || 0),
      trailPct: Number(state.trailPct || 0),
      minProfitToTrailPct: Number(state.minProfitToTrailPct || 0),
      partialTpPct: Number(state.partialTpPct || 0),

      coolDownSecsAfterBuy: Number(state.coolDownSecsAfterBuy || 0),
      minHoldSecs: Number(state.minHoldSecs || 0),
      maxHoldSecs: Number(state.maxHoldSecs || 0),
      sellCooldownMs: Number(state.sellCooldownMs || 0),
      pendingGraceMs: Number(state.pendingGraceMs || 0),
      minQuoteIntervalMs: Number(state.minQuoteIntervalMs || 0),
    };
  } catch {
    return {};
  }
}

function _recordSellSnapshot(ctx, { stage = "post_pipeline", evalId = null } = {}) {
  try {
    const mint = String(ctx?.mint || "");
    if (!mint) return;

    const urgent = (() => {
      try {
        const u = typeof peekUrgentSell === "function" ? peekUrgentSell(mint) : null;
        return u ? { reason: String(u.reason || ""), sev: Number(u.sev || 0) } : null;
      } catch { return null; }
    })();

    const routerHoldUntil = (() => {
      try { return Number(window._fdvRouterHold?.get?.(mint) || 0); } catch { return 0; }
    })();

    const snap = {
      ts: now(),
      stage,
      evalId,
      mint,
      ownerStr: String(ctx?.ownerStr || ""),
      state: _getSafeStateForSnapshot(),
      pos: _snapshotSafeClone(ctx?.pos || null),
      ctx: _snapshotSafeClone({
        nowTs: Number(ctx?.nowTs || 0),
        ageMs: Number(ctx?.ageMs || 0),
        leaderMode: !!ctx?.leaderMode,
        inSellGuard: !!ctx?.inSellGuard,
        hasPending: !!ctx?.hasPending,
        creditsPending: !!ctx?.creditsPending,
        sizeOk: !!ctx?.sizeOk,

        forceRug: !!ctx?.forceRug,
        rugSev: Number(ctx?.rugSev || 0),
        forcePumpDrop: !!ctx?.forcePumpDrop,
        forceObserverDrop: !!ctx?.forceObserverDrop,
        forceMomentum: !!ctx?.forceMomentum,
        forceExpire: !!ctx?.forceExpire,

        curSol: Number(ctx?.curSol ?? 0),
        curSolNet: Number(ctx?.curSolNet ?? 0),
        pnlPct: Number(ctx?.pnlPct ?? 0),
        pnlNetPct: Number(ctx?.pnlNetPct ?? 0),
        pxNow: Number(ctx?.pxNow ?? 0),
        pxCost: Number(ctx?.pxCost ?? 0),
        dynStopPct: (ctx?.dynStopPct ?? null),
        minNotional: Number(ctx?.minNotional ?? 0),
        decision: ctx?.decision || null,
        isFastExit: !!ctx?.isFastExit,
        warmingHoldActive: !!ctx?.warmingHoldActive,
        inWarmingHold: !!ctx?.inWarmingHold,
        skipSoftGates: !!ctx?.skipSoftGates,
      }),
      urgent,
      routerHoldUntil,
    };

    if (!window._fdvSellSnapshots) window._fdvSellSnapshots = new Map();
    try { window._fdvSellSnapshots.set(mint, snap); } catch {}
    window._fdvLastSellSnapshot = snap;
  } catch {}
}

function _getLatestSellSnapshot() {
  try { return window._fdvLastSellSnapshot || null; } catch { return null; }
}

function _createManualSellSnapshot({ mint: preferredMint = null, stage = "manual_click" } = {}) {
  try {
    const nowTs = now();

    const pickMint = () => {
      const m0 = String(preferredMint || "");
      if (m0 && m0 !== SOL_MINT) return m0;

      const leader = String(state?.currentLeaderMint || "");
      if (leader && leader !== SOL_MINT && state?.positions?.[leader]) return leader;

      const entries = Object.entries(state?.positions || {})
        .filter(([m]) => m && m !== SOL_MINT)
        .filter(([_, pos]) => !!pos)
        .filter(([_, pos]) => (Number(pos?.sizeUi || 0) > 0) || (Number(pos?.costSol || 0) > 0));

      if (!entries.length) return "";

      entries.sort((a, b) => {
        const pa = a[1] || {};
        const pb = b[1] || {};
        const ta = Number(pa.lastBuyAt || pa.acquiredAt || 0);
        const tb = Number(pb.lastBuyAt || pb.acquiredAt || 0);
        return tb - ta;
      });
      return String(entries[0][0] || "");
    };

    const mint = pickMint();
    if (!mint) return null;

    const pos = state?.positions?.[mint] || null;
    const costSol = Number(pos?.costSol || 0);
    const curSol = Number(pos?.lastQuotedSol || 0);
    const pnlPct = costSol > 0 ? ((curSol / costSol) - 1) * 100 : 0;

    const urgent = (() => {
      try {
        const u = typeof peekUrgentSell === "function" ? peekUrgentSell(mint) : null;
        return u ? { reason: String(u.reason || ""), sev: Number(u.sev || 0) } : null;
      } catch { return null; }
    })();

    const routerHoldUntil = (() => {
      try { return Number(window._fdvRouterHold?.get?.(mint) || 0); } catch { return 0; }
    })();

    const snap = {
      ts: nowTs,
      stage,
      evalId: null,
      mint,
      ownerStr: String(state?.autoWalletPub || ""),
      state: _getSafeStateForSnapshot(),
      pos: _snapshotSafeClone(pos),
      ctx: _snapshotSafeClone({
        nowTs,
        ageMs: Number(pos?.lastBuyAt || pos?.acquiredAt || 0) ? (nowTs - Number(pos?.lastBuyAt || pos?.acquiredAt || 0)) : 0,
        hasPending: false,
        creditsPending: false,
        sizeOk: Number(pos?.sizeUi || 0) > 0,
        curSol,
        curSolNet: null,
        pnlPct,
        pnlNetPct: null,
        pxNow: Number(pos?.lastQuotedPx || 0),
        pxCost: Number(pos?.costPx || 0),
        decision: null,
        isFastExit: false,
        warmingHoldActive: !!pos?.warmingHold,
        inWarmingHold: !!pos?.warmingHold,
        skipSoftGates: false,
      }),
      urgent,
      routerHoldUntil,
      meta: _snapshotSafeClone({
        note: "manual snapshot (no sell-eval snapshot available yet)",
        enabled: !!state?.enabled,
        currentLeaderMint: String(state?.currentLeaderMint || ""),
        openMints: Object.entries(state?.positions || {})
          .filter(([m, p]) => m && m !== SOL_MINT && Number(p?.sizeUi || 0) > 0)
          .slice(0, 24)
          .map(([m, p]) => ({ mint: String(m), sizeUi: Number(p?.sizeUi || 0) })),
      }),
    };

    if (!window._fdvSellSnapshots) window._fdvSellSnapshots = new Map();
    try { window._fdvSellSnapshots.set(mint, snap); } catch {}
    window._fdvLastSellSnapshot = snap;
    return snap;
  } catch {
    return null;
  }
}

function _ensureStatsHeader() {
  try {
    if (!logEl) return null;
    let hdr = logEl.querySelector("[data-auto-stats-header]");
    if (!hdr) {
      // Insert after the Expand button if present
      const expandBtn = logEl.querySelector("[data-auto-log-expand]");
      hdr = document.createElement("div");
      hdr.setAttribute("data-auto-stats-header", "true");
      hdr.style.position = "sticky";
      hdr.style.top = "0";
      hdr.style.zIndex = "5";
      hdr.style.background = "rgba(0,0,0,0.80)";
      hdr.style.backdropFilter = "blur(2px)";
      hdr.style.WebkitBackdropFilter = "blur(2px)";
      hdr.style.padding = "6px 8px";
      hdr.style.borderBottom = "1px solid var(--fdv-border,#333)";
      hdr.style.fontSize = "12px";
      hdr.style.lineHeight = "1.35";
      hdr.style.display = "grid";
      hdr.style.gridTemplateColumns = "1fr 1fr";
      hdr.style.gap = "6px 10px";
      const target = expandBtn ? expandBtn.nextElementSibling : logEl.firstChild;
      if (expandBtn && target) {
        logEl.insertBefore(hdr, target);
      } else if (expandBtn) {
        logEl.appendChild(hdr);
      } else {
        logEl.insertBefore(hdr, logEl.firstChild);
      }
    }


    // Build the header contents once (do NOT overwrite on each update).
    try {
      if (!hdr.dataset.fdvBuilt) {
        hdr.dataset.fdvBuilt = "1";
        hdr.innerHTML = `
          <div><strong>Money made</strong>: <span data-auto-stat-pnl-sol>—</span> <span data-auto-stat-pnl-usd></span></div>
          <div><strong>Status</strong>: <span data-auto-stat-status>—</span></div>
          <div><strong>SOL</strong>: <span data-auto-stat-solbal>—</span></div>
          <div><strong>Open</strong>: <span data-auto-stat-open>—</span></div>
          <div><strong>Time left</strong>: <span data-auto-stat-left>—</span></div>
          <div><strong>Last trade</strong>: <span data-auto-stat-lasttrade>—</span></div>
        `;
      }

      if (!hdr.dataset.fdvAgentWired) {
        hdr.dataset.fdvAgentWired = "1";
        const root = hdr.closest?.(".fdv-auto-body") || document;
        const enabledEl = root.querySelector("[data-auto-agent-enabled]");
        const riskEl = root.querySelector("[data-auto-agent-risk]");
        const keyEl = root.querySelector("[data-auto-openai-key]");
        const modelEl = root.querySelector("[data-auto-openai-model]");
        const stateEl = root.querySelector("[data-auto-agent-state]");

        if (!enabledEl && !riskEl && !keyEl && !modelEl && !stateEl) {
          // noop
        } else {

        const _readAgentEnabled = () => {
          try {
            if (!enabledEl) return true;
            const tag = String(enabledEl.tagName || "").toLowerCase();
            if (tag === "select") return String(enabledEl.value || "yes") !== "no";
            return !!enabledEl.checked;
          } catch {
            return true;
          }
        };

        const _writeAgentEnabledUi = (on) => {
          try {
            if (!enabledEl) return;
            const tag = String(enabledEl.tagName || "").toLowerCase();
            if (tag === "select") { enabledEl.value = on ? "yes" : "no"; return; }
            enabledEl.checked = !!on;
          } catch {}
        };

        const updateAgentUi = () => {
          try {
            const enabledFlag = _readAgentEnabled();
            const keyPresent = !!String(keyEl && keyEl.value || "").trim();
            const eff = enabledFlag && keyPresent;

			// When Agent Gary is effectively active, always keep stealth enabled.
			// (Stealth rotation behaves like Generate/Rotate and is also invoked on start.)
			try {
				if (eff && !state.stealthMode) {
					state.stealthMode = true;
					save();
					try { if (stealthEl) stealthEl.value = "yes"; } catch {}
					log("Stealth forced ON (Agent Gary mode).", "help");
				}
			} catch {}

            if (stateEl) {
              if (eff) {
                stateEl.textContent = "(active)";
                stateEl.style.color = "#7ee787";
              } else if (enabledFlag && !keyPresent) {
                stateEl.textContent = "(missing key)";
                stateEl.style.color = "#ffb86c";
              } else {
                stateEl.textContent = "(off)";
                stateEl.style.color = "#9da7b3";
              }
            }
          } catch {}
        };

        // Load existing values
        try {
          const enRaw = typeof localStorage !== "undefined" ? String(localStorage.getItem("fdv_agent_enabled") || "") : "";
          const en = enRaw ? /^(1|true|yes|on)$/i.test(enRaw) : true;
          _writeAgentEnabledUi(!!en);
        } catch {}
        try {
          const raw = typeof localStorage !== "undefined" ? String(localStorage.getItem("fdv_agent_risk") || "") : "";
          const v = String(raw || "safe").trim().toLowerCase();
          const risk = (v === "safe" || v === "medium" || v === "degen") ? v : "safe";
          if (riskEl) riskEl.value = risk;
        } catch {}
        try {
          const k = typeof localStorage !== "undefined" ? String(localStorage.getItem("fdv_openai_key") || "") : "";
          if (keyEl) keyEl.value = k;
        } catch {}
        try {
          const m = typeof localStorage !== "undefined" ? String(localStorage.getItem("fdv_openai_model") || "") : "";
          if (modelEl && m) modelEl.value = m;
        } catch {}

        try { updateAgentUi(); } catch {}

        // Persist changes
        if (enabledEl) {
          enabledEl.addEventListener("change", () => {
            try {
              if (typeof localStorage === "undefined") return;
              const on = _readAgentEnabled();
              localStorage.setItem("fdv_agent_enabled", on ? "true" : "false");
              try { updateAgentUi(); } catch {}
              try {
                const keyPresent = !!String(keyEl && keyEl.value || "").trim();
                if (on && !keyPresent) log("Agent enabled, but inactive until OpenAI key is set.", "warn");
                else log(`Agent ${on ? "enabled" : "disabled"}.`, "help");
              } catch {}
            } catch {}
          });
        }
        if (riskEl) {
          riskEl.addEventListener("change", () => {
            try {
              if (typeof localStorage === "undefined") return;
              const v = String(riskEl.value || "safe").trim().toLowerCase();
              const risk = (v === "safe" || v === "medium" || v === "degen") ? v : "safe";
              localStorage.setItem("fdv_agent_risk", risk);
              try { updateAgentUi(); } catch {}
              try { log(`Agent risk set to ${risk.toUpperCase()}.`, "help"); } catch {}
            } catch {}
          });
        }
        if (keyEl) {
          const saveKey = () => {
            try {
              if (typeof localStorage === "undefined") return;
              localStorage.setItem("fdv_openai_key", String(keyEl.value || "").trim());
              try { updateAgentUi(); } catch {}
              try {
                const enabledFlag = _readAgentEnabled();
                const keyPresent = !!String(keyEl.value || "").trim();
                if (enabledFlag && keyPresent) log("Agent key set; AI mode can run on buy/sell decisions.", "help");
              } catch {}
            } catch {}
          };
          keyEl.addEventListener("change", saveKey);
          keyEl.addEventListener("blur", saveKey);
        }
        if (modelEl) {
          modelEl.addEventListener("change", () => {
            try {
              if (typeof localStorage === "undefined") return;
              localStorage.setItem("fdv_openai_model", String(modelEl.value || "gpt-4o-mini"));
              try { updateAgentUi(); } catch {}
              try { log(`Agent model set to ${String(modelEl.value || "").trim()}.`, "help"); } catch {}
            } catch {}
          });
        }

        }
      }
    } catch {}

    return hdr;
  } catch { return null; }
}

let _hdrRaf = 0;
function updateStatsHeader() {
  if (_hdrRaf) return; // throttle to next frame
  _hdrRaf = requestAnimationFrame(() => {
    _hdrRaf = 0;
    try {
      const hdr = _ensureStatsHeader();
      if (!hdr) return;
      const pnlSol = getSessionPnlSol();
      const px = Number((_solPxCache && _solPxCache.usd) || 0);
      const pnlUsd = px > 0 ? pnlSol * px : null;

      const solBal = Number(window._fdvLastSolBal || 0);
      const open = Object.entries(state.positions || {}).filter(([m, p]) => m !== SOL_MINT && Number(p?.sizeUi || 0) > 0).length;

      const running = !!state.enabled;
      const status = running ? "RUNNING" : "STOPPED";

      let left = "—";
      if (state.endAt && now() < state.endAt) {
        const sec = Math.max(0, Math.floor((state.endAt - now()) / 1000));
        const mm = Math.floor(sec / 60);
        const ss = sec % 60;
        left = `${mm}:${String(ss).padStart(2,"0")}`;
      }

      const lastTradeAgo = Number(state.lastTradeTs || 0) ? Math.max(0, Math.floor((now() - state.lastTradeTs) / 1000)) : null;
      const lastTradeStr = lastTradeAgo === null ? "—" : `${lastTradeAgo}s`;

      const pnlSolEl = hdr.querySelector("[data-auto-stat-pnl-sol]");
      const pnlUsdEl = hdr.querySelector("[data-auto-stat-pnl-usd]");
      const statusEl = hdr.querySelector("[data-auto-stat-status]");
      const solEl = hdr.querySelector("[data-auto-stat-solbal]");
      const openEl = hdr.querySelector("[data-auto-stat-open]");
      const leftEl = hdr.querySelector("[data-auto-stat-left]");
      const lastEl = hdr.querySelector("[data-auto-stat-lasttrade]");

      if (pnlSolEl) pnlSolEl.textContent = `${pnlSol.toFixed(6)} SOL`;
      if (pnlUsdEl) pnlUsdEl.textContent = pnlUsd !== null ? ` (${fmtUsd(pnlUsd)})` : "";
      if (statusEl) statusEl.textContent = status;
      if (solEl) solEl.textContent = solBal ? solBal.toFixed(6) : "—";
      if (openEl) openEl.textContent = String(open);
      if (leftEl) leftEl.textContent = left;
      if (lastEl) lastEl.textContent = lastTradeStr;
    } catch {}
  });
}

export function initTraderWidget(container = document.body) {
  load();

  if (!state.positions || typeof state.positions !== "object") state.positions = {};

  const wrap = container;
  while (wrap.firstChild) wrap.removeChild(wrap.firstChild);

  const body = document.createElement("div");
  body.className = "fdv-auto-body";
  body.innerHTML = `
    <div class="fdv-auto-head"></div>
    <div data-main-tab-panel="auto" class="tab-panel active">
    <div class="fdv-grid">
      <label><a href="https://quicknode.com/signup?via=lf" target="_blank">RPC (CORS)</a> <input data-auto-rpc placeholder="https://your-provider.example/solana?api-key=..."/></label>
      <label>RPC Headers (JSON) <input data-auto-rpch placeholder='{"Authorization":"Bearer ..."}'/></label>
      <label>Auto Wallet <input data-auto-dep readonly placeholder="Generate to get address"/></label>
      <label>Deposit Balance <input data-auto-bal readonly/></label>
      <label>Recipient (SOL) <input data-auto-recv placeholder="Your wallet address"/></label>
      <label>Lifetime (mins) <input data-auto-life type="number" step="1" min="${UI_LIMITS.LIFE_MINS_MIN}" max="${UI_LIMITS.LIFE_MINS_MAX}"/></label>
      <label>Buy % of SOL <input data-auto-buyp type="number" step="0.1" min="${UI_LIMITS.BUY_PCT_MIN*100}" max="${UI_LIMITS.BUY_PCT_MAX*100}"/></label>
      <label>Min Buy (SOL) <input data-auto-minbuy type="number" step="0.0001" min="${UI_LIMITS.MIN_BUY_SOL_MIN}" max="${UI_LIMITS.MIN_BUY_SOL_MAX}"/></label>
      <label>Max Buy (SOL) <input data-auto-maxbuy type="number" step="0.0001" min="${UI_LIMITS.MAX_BUY_SOL_MIN}" max="${UI_LIMITS.MAX_BUY_SOL_MAX}"/></label>
      <label>Min Edge (%) <input data-auto-minedge type="number" step="0.1" placeholder="-5 = allow -5%"/></label>
      <label>Warming decay (%/min) <input data-auto-warmdecay type="number" step="0.01" min="0" max="5" placeholder="0.25"/></label>
      <label>TP (%) <input data-auto-tp type="number" step="0.1" min="1" max="500" placeholder="12"/></label>
      <label>SL (%) <input data-auto-sl type="number" step="0.1" min="0.1" max="90" placeholder="4"/></label>
      <label>Trail (%) <input data-auto-trail type="number" step="0.1" min="0" max="90" placeholder="6"/></label>
      <label>Slippage (bps) <input data-auto-slip type="number" step="1" min="50" max="2000" placeholder="250"/></label>
 

      <label>Multi-buy
        <select data-auto-multi>
          <option value="no">No</option>
          <option value="yes" selected>Yes</option>
        </select>
      </label>
     <label>Leader
        <select data-auto-hold>
          <option value="no">No</option>
          <option value="yes">Yes</option>
        </select>
      </label>
      <label>Dust
        <select data-auto-dust>
          <option value="no" selected>No</option>
          <option value="yes">Yes</option>
        </select>
      </label>
      <label>Warming
        <select data-auto-warming>
          <option value="no">No</option>
          <option value="yes">Yes</option>
        </select>
      </label>
      <label>Stealth
        <select data-auto-stealth>
          <option value="no">No</option>
          <option value="yes">Yes</option>
        </select>
      </label>
    </div>
    <details class="fdv-advanced" data-auto-adv>
      <summary class="fdv-advanced-summary">Advanced</summary>
      <div class="fdv-grid fdv-advanced-grid">
        <label>Gross TP base goal (%)
          <input data-auto-gross-basegoal type="number" step="0.1" min="0.5" max="200" placeholder="2"/>
        </label>
        <label>Edge buffer (%)
          <input data-auto-edge-buf type="number" step="0.05" min="0" max="2" placeholder="0.10"/>
        </label>

        <label>Light entry
          <select data-auto-light-enabled>
            <option value="yes">On</option>
            <option value="no">Off</option>
          </select>
        </label>
        <label>Light fraction (0-1)
          <input data-auto-light-frac type="number" step="0.05" min="0.1" max="0.9" placeholder="0.33"/>
        </label>
        <label>Light top-up arm (ms)
          <input data-auto-light-arm type="number" step="100" min="1000" max="60000" placeholder="7000"/>
        </label>
        <label>Light top-up min chg5m (%)
          <input data-auto-light-minchg type="number" step="0.1" min="0" max="50" placeholder="0.8"/>
        </label>
        <label>Light top-up min chg slope (/m)
          <input data-auto-light-minchgslope type="number" step="0.5" min="0" max="50" placeholder="6"/>
        </label>
        <label>Light top-up min slope (/m)
          <input data-auto-light-minscslope type="number" step="0.5" min="0" max="50" placeholder="3"/>
        </label>

        <label>Warming min profit (%) <input data-auto-warm-minp type="number" step="0.1" min="-50" max="50" placeholder="2"/></label>
        <label>Warming floor (%) <input data-auto-warm-floor type="number" step="0.1" min="-50" max="50" placeholder="-2"/></label>
        <label>Decay delay (s) <input data-auto-warm-delay type="number" step="1" min="0" max="600" placeholder="15"/></label>
        <label>Auto release (s) <input data-auto-warm-release type="number" step="1" min="0" max="600" placeholder="45"/></label>
        <label>Max loss (%) <input data-auto-warm-maxloss type="number" step="0.1" min="1" max="50" placeholder="6"/></label>
        <label>Max loss window (s) <input data-auto-warm-window type="number" step="1" min="5" max="180" placeholder="30"/></label>
        <label>Primed consec <input data-auto-warm-consec type="number" step="1" min="1" max="3" placeholder="1"/></label>
        <label>Edge min excl (%) <input data-auto-warm-edge type="number" step="0.1" min="-10" max="10" placeholder="(optional)"/></label>
        <label>Rebound min score <input data-auto-rebound-score type="number" step="0.01" min="0" max="5" placeholder="0.34"/></label>
        <label>Rebound lookback (s) <input data-auto-rebound-lookback type="number" step="1" min="5" max="180" placeholder="45"/></label>
        <label>Friction snap (SOL)
          <input data-auto-fric-snap type="number" step="0.0001" min="0" max="0.05" placeholder="0.0020"/>
        </label>
        <label>Final gate
          <select data-auto-final-gate-enabled>
            <option value="yes">On</option>
            <option value="no">Off</option>
          </select>
        </label>
        <label>Final gate min start
          <input data-auto-final-gate-minstart type="number" step="0.1" min="0" max="50" placeholder="2"/>
        </label>
        <label>Final gate Δscore
          <input data-auto-final-gate-delta type="number" step="0.1" min="0" max="50" placeholder="3"/>
        </label>
        <label>Final gate window (ms)
          <input data-auto-final-gate-window type="number" step="100" min="1000" max="30000" placeholder="10000"/>
        </label>

        <label>Simulation mode
          <select data-auto-entry-sim-mode>
            <option value="off">Off</option>
            <option value="warn">Warn</option>
            <option value="enforce">Enforce</option>
          </select>
        </label>
        <label>Max entry cost (%) (med/safe)
          <input data-auto-max-entry-cost type="number" step="0.1" min="0" max="10" placeholder="1.5"/>
        </label>
        <label>Sim horizon (s)
          <input data-auto-entry-sim-horizon type="number" step="1" min="30" max="600" placeholder="120"/>
        </label>
        <label>Sim min win P (0-1)
          <input data-auto-entry-sim-minprob type="number" step="0.01" min="0" max="1" placeholder="0.55"/>
        </label>
        <label>Sim min terminal P (0-1)
          <input data-auto-entry-sim-minterm type="number" step="0.01" min="0" max="1" placeholder="0.60"/>
        </label>
        <label>Sigma floor (%)
          <input data-auto-entry-sim-sigmafloor type="number" step="0.05" min="0" max="10" placeholder="0.75"/>
        </label>
        <label>Sigma μ level weight (0-1)
          <input data-auto-entry-sim-mulevelw type="number" step="0.05" min="0" max="1" placeholder="0.35"/>
        </label>
      </div>
      <div class="fdv-hold-time-slider"></div>

      <div class="fdv-agent-bar" data-auto-agent-bar>
        <label class="fdv-agent-item fdv-agent-toggle">
          Agent Gary <span data-auto-agent-state class="fdv-agent-state fdv-hidden"></span>
          <select data-auto-agent-enabled>
            <option value="yes">On</option>
            <option value="no">Off</option>
          </select>
        </label>
        <label class="fdv-agent-item fdv-agent-risk">
          Risk
          <select data-auto-agent-risk>
            <option value="safe">Safe</option>
            <option value="medium">Medium</option>
            <option value="degen">Degen</option>
          </select>
        </label>
        <label class="fdv-agent-item fdv-agent-key">
          OpenAI key
          <input type="password" data-auto-openai-key placeholder="sk-…" autocomplete="off" spellcheck="false" />
        </label>
        <label class="fdv-agent-item fdv-agent-model">
          Model
          <select data-auto-openai-model>
            <option value="gpt-4o-mini">gpt-4o-mini</option>
            <option value="gpt-4.1-mini">gpt-4.1-mini</option>
            <option value="gpt-4o">gpt-4o</option>
            <option value="gpt-5-nano" disabled>gpt-5-nano(coming soon)</option>
            <option value="grok-elon" disabled>grok(coming soon)</option>
          </select>
        </label>
      </div>
    </details>
    <div class="fdv-tool-row">
      <button class="btn tool-btn" data-auto-gen>Generate</button>
      <button class="btn tool-btn" data-auto-ledger title="Open in Ledger Explorer">Ledger</button>
      <button class="btn tool-btn fdv-hidden" data-auto-copy>Replace me with AI feature</button>
      <button class="btn tool-btn" data-auto-snapshot title="Download latest sell snapshot">Snapshot</button>
      <button class="btn tool-btn" data-auto-unwind>Return</button>
      <div data-auto-unwind-menu class="fdv-modal-backdrop">
        <div class="fdv-modal fdv-unwind-modal" data-auto-unwind-modal role="dialog" aria-modal="true" aria-label="Confirm Return">
          <div class="fdv-modal-header">
            <strong>Confirm Return</strong>
            <button class="fdv-close" data-auto-unwind-close aria-label="Close">×</button>
          </div>
          <div class="fdv-modal-body fdv-unwind-modal-body">
            <div data-auto-unwind-summary style="opacity:.9; font-size:12px; line-height:1.35;">
              This sells all SPL tokens in the Auto Wallet and sends SOL to your Recipient address.
            </div>
            <div data-auto-unwind-warnings style="margin-top:10px; font-size:12px;"></div>
            <div style="display:flex; justify-content:flex-end; gap:8px; margin-top:14px;">
              <button class="btn tool-btn" data-auto-unwind-cancel>Cancel</button>
              <button class="btn tool-btn" data-auto-unwind-confirm>Return</button>
            </div>
          </div>
        </div>
      </div>
      <button class="btn tool-btn" data-auto-wallet>Wallet</button>
      <div data-auto-wallet-menu class="fdv-modal-backdrop">
        <div class="fdv-modal fdv-wallet-modal" data-auto-wallet-modal role="dialog" aria-modal="true" aria-label="Auto Wallet">
          <div class="fdv-modal-header">
            <strong>Wallet Holdings</strong>
            <button class="fdv-close" data-auto-wallet-close aria-label="Close">×</button>
          </div>
          <div class="fdv-modal-body fdv-wallet-modal-body">
            <div data-auto-wallet-sol class="fdv-wallet-sol">SOL: …</div>
            <div data-auto-wallet-list class="fdv-wallet-list">
              <div class="fdv-mutedline">Loading…</div>
            </div>
            <div data-auto-wallet-totals class="fdv-wallet-totals">Total: …</div>
          </div>
        </div>
      </div>
    </div>
    <div class="fdv-log" data-auto-log>
    <button class="btn fdv-hidden" data-auto-log-expand title="Expand log">Expand</button>
    </div>
    <div class="fdv-actions">
    <div class="fdv-actions-left">
        <button class="btn" data-auto-help title="How the bot works">Help</button>
        <button class="btn" data-auto-log-copy title="Copy log">Log</button>
        <!-- TODO: fix help modal positioning -->
        ${ getAutoHelpModalHtml() }
    </div>
    <div class="fdv-actions-right">
      <button data-auto-start>Start</button>
      <button data-auto-stop>Stop</button>
      <button class="btn" data-auto-reset>Refresh</button>
    </div>
    </div>
    </div>
    </div>
    <div class="fdv-bot-footer" style="display:flex;justify-content:space-between;margin-top:12px; font-size:12px; text-align:right; opacity:0.6;">
      <a href="https://t.me/fdvlolgroup" target="_blank" data-auto-help-tg>t.me/fdvlolgroup</a>
      <span>Version: 0.0.6.5</span>
    </div>
  `;

  wrap.appendChild(body);

  // Strip the old multi-tab wrapper markup if present and keep only the Auto panel content.
  try {
    const autoPanel = body.querySelector('[data-main-tab-panel="auto"]');
    if (autoPanel) {
      autoPanel.classList.remove('tab-panel', 'active');
      autoPanel.removeAttribute('data-main-tab-panel');
      wrap.appendChild(autoPanel);
      body.remove();
    }
    const tabs = wrap.querySelector('.fdv-tabs');
    if (tabs) tabs.remove();
    const volPanel = wrap.querySelector('[data-main-tab-panel="volume"]');
    if (volPanel) volPanel.remove();
    const footer = wrap.querySelector('.fdv-bot-footer');
    if (footer) footer.remove();
  } catch {}

  const openPumpKpi = () => {
    let opened = false;
    const pumpBtn = document.getElementById("pumpingToggle") || document.querySelector('button[title="PUMP"]');
    if (!pumpBtn) return opened;

    const isExpanded = String(pumpBtn.getAttribute("aria-expanded") || "false") === "true";
    if (isExpanded) return true;

    try { pumpBtn.click(); opened = true; } catch {}

    const panelId = pumpBtn.getAttribute("aria-controls") || "pumpingPanel";
    const panel = document.getElementById(panelId) || document.querySelector("#pumpingPanel");
    if (panel) {
      panel.removeAttribute("hidden");
      panel.style.display = "";
      panel.classList.add("open");
    }
    return opened;
  };

  logEl     = wrap.querySelector("[data-auto-log]");
  toggleEl  = wrap.querySelector("[data-auto-toggle]");
  try {
    const outer = wrap.closest?.('.fdv-auto-wrap') || document;
    ledEl = outer.querySelector?.('[data-auto-led]') || null;
  } catch { ledEl = null; }
  try { _ensureStatsHeader(); updateStatsHeader(); } catch {}
  tpEl      = wrap.querySelector("[data-auto-tp]");
  slEl      = wrap.querySelector("[data-auto-sl]");
  trailEl   = wrap.querySelector("[data-auto-trail]");
  slipEl    = wrap.querySelector("[data-auto-slip]");
  const holdEl  = wrap.querySelector("[data-auto-hold]");
  const dustEl  = wrap.querySelector("[data-auto-dust]");
  const warmingEl = wrap.querySelector("[data-auto-warming]");
  const stealthEl = wrap.querySelector("[data-auto-stealth]");
  const expandBtn = wrap.querySelector("[data-auto-log-expand]");

  wireAutoHelpModal({ wrap, openPumpKpi });
  startBtn  = wrap.querySelector("[data-auto-start]");
  stopBtn   = wrap.querySelector("[data-auto-stop]");
  mintEl    = { value: "" }; // not used in auto-wallet mode

  depAddrEl = wrap.querySelector("[data-auto-dep]");
  depBalEl  = wrap.querySelector("[data-auto-bal]");
  recvEl    = wrap.querySelector("[data-auto-recv]");
  lifeEl    = wrap.querySelector("[data-auto-life]");
  buyPctEl  = wrap.querySelector("[data-auto-buyp]");
  minBuyEl  = wrap.querySelector("[data-auto-minbuy]");
  maxBuyEl  = wrap.querySelector("[data-auto-maxbuy]");
  minEdgeEl = wrap.querySelector("[data-auto-minedge]");
  multiEl   = wrap.querySelector("[data-auto-multi]");
  warmDecayEl = wrap.querySelector("[data-auto-warmdecay]");

  //advancced
  advBoxEl        = wrap.querySelector("[data-auto-adv]");
  grossBaseGoalEl = wrap.querySelector("[data-auto-gross-basegoal]");
  edgeBufEl       = wrap.querySelector("[data-auto-edge-buf]");
  lightEnabledEl  = wrap.querySelector("[data-auto-light-enabled]");
  lightFracEl     = wrap.querySelector("[data-auto-light-frac]");
  lightArmEl      = wrap.querySelector("[data-auto-light-arm]");
  lightMinChgEl   = wrap.querySelector("[data-auto-light-minchg]");
  lightMinChgSlopeEl = wrap.querySelector("[data-auto-light-minchgslope]");
  lightMinScSlopeEl  = wrap.querySelector("[data-auto-light-minscslope]");
  warmMinPEl      = wrap.querySelector("[data-auto-warm-minp]");
  warmFloorEl     = wrap.querySelector("[data-auto-warm-floor]");
  warmDelayEl     = wrap.querySelector("[data-auto-warm-delay]");
  warmReleaseEl   = wrap.querySelector("[data-auto-warm-release]");
  warmMaxLossEl   = wrap.querySelector("[data-auto-warm-maxloss]");
  warmMaxWindowEl = wrap.querySelector("[data-auto-warm-window]");
  warmConsecEl    = wrap.querySelector("[data-auto-warm-consec]");
  warmEdgeEl      = wrap.querySelector("[data-auto-warm-edge]");
  reboundScoreEl = wrap.querySelector("[data-auto-rebound-score]");
  reboundLookbackEl = wrap.querySelector("[data-auto-rebound-lookback]");
  fricSnapEl       = wrap.querySelector("[data-auto-fric-snap]");
  finalGateEnabledEl   = wrap.querySelector("[data-auto-final-gate-enabled]");
  finalGateMinStartEl  = wrap.querySelector("[data-auto-final-gate-minstart]");
  finalGateDeltaEl     = wrap.querySelector("[data-auto-final-gate-delta]");
  finalGateWindowEl    = wrap.querySelector("[data-auto-final-gate-window]");

  entrySimModeEl     = wrap.querySelector("[data-auto-entry-sim-mode]");
  maxEntryCostEl     = wrap.querySelector("[data-auto-max-entry-cost]");
  entrySimHorizonEl  = wrap.querySelector("[data-auto-entry-sim-horizon]");
  entrySimMinProbEl  = wrap.querySelector("[data-auto-entry-sim-minprob]");
  entrySimMinTermEl  = wrap.querySelector("[data-auto-entry-sim-minterm]");
  entrySimSigmaFloorEl    = wrap.querySelector("[data-auto-entry-sim-sigmafloor]");
  entrySimMuLevelWeightEl = wrap.querySelector("[data-auto-entry-sim-mulevelw]");

  setTimeout(() => {
    try {
      logObj("Warming thresholds", {
        minPre: state.warmingUptickMinPre,
        minAccel: state.warmingUptickMinAccel,
        dChg: state.warmingUptickMinDeltaChg5m,
        dScore: state.warmingUptickMinDeltaScore,
        primeConsec: state.warmingPrimedConsec
      });
      logObj("Rebound thresholds", {
        minScore: state.reboundMinScore,
        lookbackSecs: state.reboundLookbackSecs,
        chgSlopeMin: state.reboundMinChgSlope,
        scSlopeMin: state.reboundMinScSlope
      });
    } catch {}
  }, 0);  

  const secExportBtn = wrap.querySelector("[data-auto-sec-export]");
  const rpcEl = wrap.querySelector("[data-auto-rpc]");
  const rpchEl = wrap.querySelector("[data-auto-rpch]");
  const copyLogBtn = wrap.querySelector("[data-auto-log-copy]");
  const snapshotBtn = wrap.querySelector("[data-auto-snapshot]");

  const walletBtn      = wrap.querySelector("[data-auto-wallet]");
  const walletMenuEl   = wrap.querySelector("[data-auto-wallet-menu]");
  const walletModalEl  = walletMenuEl?.querySelector?.("[data-auto-wallet-modal]") || null;
  const walletListEl   = wrap.querySelector("[data-auto-wallet-list]");
  const walletTotalsEl = wrap.querySelector("[data-auto-wallet-totals]");
  const walletSolEl    = wrap.querySelector("[data-auto-wallet-sol]");

  const unwindBtn = wrap.querySelector("[data-auto-unwind]");
  const unwindMenuEl = wrap.querySelector("[data-auto-unwind-menu]");
  const unwindModalEl = unwindMenuEl?.querySelector?.("[data-auto-unwind-modal]") || null;
  const unwindSummaryEl = unwindMenuEl?.querySelector?.("[data-auto-unwind-summary]") || null;
  const unwindWarningsEl = unwindMenuEl?.querySelector?.("[data-auto-unwind-warnings]") || null;
  const unwindCancelBtn = unwindMenuEl?.querySelector?.("[data-auto-unwind-cancel]") || null;
  const unwindConfirmBtn = unwindMenuEl?.querySelector?.("[data-auto-unwind-confirm]") || null;
  // const dumpBtn        = wrap.querySelector("[data-auto-dump]");
            //   <div class="fdv-wallet-actions">
            //   <button class="fdv-wallet-dump" data-auto-dump>Dump Wallet</button>
            // </div>

  rpcEl.value   = currentRpcUrl();
  try { rpchEl.value = JSON.stringify(currentRpcHeaders() || {}); } catch { rpchEl.value = "{}"; }
  depAddrEl.value = state.autoWalletPub || "";

  // Best-effort: publish any existing auto wallet to the public FDV ledger.
  try {
    if (state.autoWalletPub && state.autoWalletSecret) {
      try { _startLedgerReporting(); } catch {}
      if (!window._fdvLedgerRegistered) window._fdvLedgerRegistered = new Set();
      const k = String(state.autoWalletPub || "").trim();
      if (k && !window._fdvLedgerRegistered.has(k)) {
        window._fdvLedgerRegistered.add(k);
        setTimeout(() => {
          void (async () => {
            try {
              const kp = await getAutoKeypair();
              const { bs58 } = await loadDeps();
              if (kp) await registerFdvWallet({ pubkey: k, keypair: kp, bs58 });
            } catch {}
          })();
        }, 250);
      }
    }
  } catch {}

  recvEl.value    = state.recipientPub || "";
  lifeEl.value    = state.lifetimeMins;
  buyPctEl.value  = (state.buyPct * 100).toFixed(2);
  minBuyEl.value  = state.minBuySol;
  maxBuyEl.value  = state.maxBuySol;
  minEdgeEl.value = Number.isFinite(state.minNetEdgePct) ? String(state.minNetEdgePct) : "-5";
  multiEl.value   = state.allowMultiBuy ? "yes" : "no";
  warmDecayEl.value = String(Number.isFinite(state.warmingDecayPctPerMin) ? state.warmingDecayPctPerMin : 0.25);
  tpEl.value    = String(state.takeProfitPct);
  slEl.value    = String(state.stopLossPct);
  trailEl.value = String(state.trailPct);
  slipEl.value  = String(state.slippageBps);

  if (grossBaseGoalEl) grossBaseGoalEl.value = String(Number.isFinite(Number(state.minProfitToTrailPct)) ? Number(state.minProfitToTrailPct) : 2);
  if (edgeBufEl)       edgeBufEl.value       = String(Number.isFinite(Number(state.edgeSafetyBufferPct)) ? Number(state.edgeSafetyBufferPct) : 0.1);
  if (lightEnabledEl)  lightEnabledEl.value  = (state.lightEntryEnabled === false) ? "no" : "yes";
  if (lightFracEl)     lightFracEl.value     = String(Number.isFinite(Number(state.lightEntryFraction)) ? Number(state.lightEntryFraction) : (1/3));
  if (lightArmEl)      lightArmEl.value      = String(Number.isFinite(Number(state.lightTopUpArmMs)) ? Number(state.lightTopUpArmMs) : 7000);
  if (lightMinChgEl)   lightMinChgEl.value   = String(Number.isFinite(Number(state.lightTopUpMinChg5m)) ? Number(state.lightTopUpMinChg5m) : 0.8);
  if (lightMinChgSlopeEl) lightMinChgSlopeEl.value = String(Number.isFinite(Number(state.lightTopUpMinChgSlope)) ? Number(state.lightTopUpMinChgSlope) : 6);
  if (lightMinScSlopeEl)  lightMinScSlopeEl.value  = String(Number.isFinite(Number(state.lightTopUpMinScSlope)) ? Number(state.lightTopUpMinScSlope) : 3);

  if (warmMinPEl)      warmMinPEl.value      = String(Number.isFinite(state.warmingMinProfitPct) ? state.warmingMinProfitPct : 2);
  if (warmFloorEl)     warmFloorEl.value     = String(Number.isFinite(state.warmingMinProfitFloorPct) ? state.warmingMinProfitFloorPct : 0);
  if (warmDelayEl)     warmDelayEl.value     = String(Number.isFinite(state.warmingDecayDelaySecs) ? state.warmingDecayDelaySecs : 15);
  if (warmReleaseEl)   warmReleaseEl.value   = String(Number.isFinite(state.warmingAutoReleaseSecs) ? state.warmingAutoReleaseSecs : 45);
  if (warmMaxLossEl)   warmMaxLossEl.value   = String(Number.isFinite(state.warmingMaxLossPct) ? state.warmingMaxLossPct : 6);
  if (warmMaxWindowEl) warmMaxWindowEl.value = String(Number.isFinite(state.warmingMaxLossWindowSecs) ? state.warmingMaxLossWindowSecs : 60);
  if (warmConsecEl)    warmConsecEl.value    = String(Number.isFinite(state.warmingPrimedConsec) ? state.warmingPrimedConsec : 1);
  if (warmEdgeEl) {
    warmEdgeEl.value = (typeof state.warmingEdgeMinExclPct === "number" && Number.isFinite(state.warmingEdgeMinExclPct))
      ? String(state.warmingEdgeMinExclPct)
      : "";
  }
  if (reboundScoreEl) reboundScoreEl.value = String(Number.isFinite(state.reboundMinScore) ? state.reboundMinScore : 0.34);
  if (reboundLookbackEl) reboundLookbackEl.value = String(Number.isFinite(state.reboundLookbackSecs) ? state.reboundLookbackSecs : 45);
  if (fricSnapEl)       fricSnapEl.value       = String(Number.isFinite(state.fricSnapEpsSol) ? state.fricSnapEpsSol : 0.0020);
  if (finalGateEnabledEl)   finalGateEnabledEl.value  = state.finalPumpGateEnabled ? "yes" : "no";
  if (finalGateMinStartEl)  finalGateMinStartEl.value = String(Number.isFinite(state.finalPumpGateMinStart) ? state.finalPumpGateMinStart : 2);
  if (finalGateDeltaEl)     finalGateDeltaEl.value    = String(Number.isFinite(state.finalPumpGateDelta) ? state.finalPumpGateDelta : 3);
  if (finalGateWindowEl)    finalGateWindowEl.value   = String(Number.isFinite(state.finalPumpGateWindowMs) ? state.finalPumpGateWindowMs : 10000);

  if (entrySimModeEl)    entrySimModeEl.value    = String(state.entrySimMode || "enforce");
  if (maxEntryCostEl)    maxEntryCostEl.value    = String(Number.isFinite(Number(state.maxEntryCostPct)) ? Number(state.maxEntryCostPct) : 1.5);
  if (entrySimHorizonEl) entrySimHorizonEl.value = String(Number.isFinite(Number(state.entrySimHorizonSecs)) ? Number(state.entrySimHorizonSecs) : 120);
  if (entrySimMinProbEl) entrySimMinProbEl.value = String(Number.isFinite(Number(state.entrySimMinWinProb)) ? Number(state.entrySimMinWinProb) : 0.55);
  if (entrySimMinTermEl) entrySimMinTermEl.value = String(Number.isFinite(Number(state.entrySimMinTerminalProb)) ? Number(state.entrySimMinTerminalProb) : 0.60);
  if (entrySimSigmaFloorEl) entrySimSigmaFloorEl.value = String(Number.isFinite(Number(state.entrySimSigmaFloorPct)) ? Number(state.entrySimSigmaFloorPct) : 0.75);
  if (entrySimMuLevelWeightEl) entrySimMuLevelWeightEl.value = String(Number.isFinite(Number(state.entrySimMuLevelWeight)) ? Number(state.entrySimMuLevelWeight) : 0.35);

  if (expandBtn && logEl) {
    log("Log panel: click 'Expand' or press Alt+6 to enlarge. Press Esc to close.", "help");
    log("Focus mode: press Alt+7 to hide other page elements, Alt+8 to restore.", "help");
    
    function setHeaderFullHeight(enable) {
      try {
        const hdr = document.querySelector('header');
        if (!hdr) return;
        if (enable) {
          if (!hdr.dataset.fdvPrevHeight) hdr.dataset.fdvPrevHeight = hdr.style.height || "";
          hdr.style.height = "100vh";
        } else {
          const prev = hdr.dataset.fdvPrevHeight;
          hdr.style.height = prev || "";
          if (prev !== undefined) delete hdr.dataset.fdvPrevHeight;
        }
      } catch {}
    }
    
    const setExpanded = (on) => {
      logEl.classList.toggle("fdv-log-full", !!on);
      expandBtn.textContent = on ? "Close" : "Expand";
      expandBtn.setAttribute("aria-label", on ? "Close log" : "Expand log");
      setHeaderFullHeight(!!on);
      if (on) logEl.scrollTop = logEl.scrollHeight;
    };

    function setAutoFocus(on) {
      const body = document.body;
      if (on) {
        if (window._fdvFocusHidden) return; // already focused
        let keep = (function findTop(el) {
          let n = el;
          while (n && n.parentElement && n.parentElement !== body) n = n.parentElement;
          return n || el;
        })(wrap);

        const hidden = [];
        Array.from(body.children).forEach(ch => {
          if (ch === keep) return;
          const tag = (ch.tagName || "").toUpperCase();
          if (tag === "SCRIPT" || tag === "STYLE" || tag === "LINK") return;
          ch.dataset.fdvPrevDisplay = ch.style.display || "";
          ch.style.display = "none";
          hidden.push(ch);
        });

        const hiddenWithin = [];
        try {
          const path = [];
          let n = wrap;
          while (n && n !== keep) { path.push(n); n = n.parentElement; }
          path.push(keep);
          for (let i = path.length - 1; i > 0; i--) {
            const parent = path[i];
            const childOnPath = path[i - 1];
            Array.from(parent.children || []).forEach(ch => {
              if (ch === childOnPath) return;
              const tag = (ch.tagName || "").toUpperCase();
              if (tag === "SCRIPT" || tag === "STYLE" || tag === "LINK") return;
              ch.dataset.fdvPrevDisplay = ch.style.display || "";
              ch.style.display = "none";
              hiddenWithin.push(ch);
            });
          }
        } catch {}

        window._fdvFocusHidden = hidden;
        window._fdvFocusHiddenWithin = hiddenWithin;

        try { keep.scrollIntoView({ block: "start", behavior: "smooth" }); } catch {}
        try { log("Focus mode: Auto-only (Alt+8 to restore).", "info"); } catch {}
      } else {
        const hidden = window._fdvFocusHidden || [];
        hidden.forEach(ch => {
          ch.style.display = ch.dataset.fdvPrevDisplay || "";
          try { delete ch.dataset.fdvPrevDisplay; } catch {}
        });
        window._fdvFocusHidden = null;
        const hiddenWithin = window._fdvFocusHiddenWithin || [];
        hiddenWithin.forEach(ch => {
          ch.style.display = ch.dataset.fdvPrevDisplay || "";
          try { delete ch.dataset.fdvPrevDisplay; } catch {}
        });
        window._fdvFocusHiddenWithin = null;

        try { log("Focus mode: restored.", "info"); } catch {}
      }
    }

    expandBtn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      setExpanded(!logEl.classList.contains("fdv-log-full"));
    });

    document.addEventListener("keydown", (e) => {
      const t = e.target;
      const tag = (t && t.tagName) ? t.tagName.toLowerCase() : "";
      const typing = tag === "input" || tag === "textarea" || tag === "select" || (t && t.isContentEditable);
      if (typing) return;

      if (e.key === "Escape" && logEl.classList.contains("fdv-log-full")) {
        setExpanded(false);
      } else if (e.altKey && (e.code === "Digit6" || e.key === "6")) {
        setExpanded(true);
        e.preventDefault();
      } else if (e.altKey && (e.code === "Digit7" || e.key === "7")) {
        setAutoFocus(true);
        e.preventDefault();
      } else if (e.altKey && (e.code === "Digit8" || e.key === "8")) {
        setAutoFocus(false);
        e.preventDefault();
      }
    });
  }

  if (copyLogBtn) {
    copyLogBtn.addEventListener("click", (e) => { e.preventDefault(); e.stopPropagation(); copyLog(); });
  }

  if (snapshotBtn) {
    snapshotBtn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();

      let snap = _getLatestSellSnapshot();
      if (!snap) snap = _createManualSellSnapshot();
      if (!snap) {
        log("No snapshot available yet (no positions found).");
        return;
      }

      const mint = String(snap.mint || "");
      const ts = Number(snap.ts || Date.now());
      const short = mint ? mint.slice(0, 6) : "unknown";
      const filename = `fdv-sell-snapshot-${short}-${ts}.json`;

      try {
        downloadTextFile(filename, JSON.stringify(snap, null, 2));
        log(`Snapshot downloaded (${short}…).`);
      } catch (err) {
        log(`Snapshot download failed: ${err?.message || err}`);
      }
    });
  }

  async function renderWalletMenu() {
    try {
      const kp = await getAutoKeypair();
      if (!kp) {
        walletListEl.innerHTML = `<div style="opacity:.7">Generate your auto wallet to view holdings.</div>`;
        walletSolEl.textContent = `SOL: …`;
        walletTotalsEl.textContent = `Total: $0.00`;
        return;
      }

      const owner = kp.publicKey.toBase58();

      const solBal = await fetchSolBalance(owner).catch(()=>0);
      const solUsdPx = await getSolUsd();
      walletSolEl.textContent = `SOL: ${Number(solBal).toFixed(6)} (${solUsdPx>0?fmtUsd(solBal*solUsdPx):"—"})`;

      const cachedEntries = cacheToList(owner); // active positions cache

      const rawDust = dustCacheToList(owner) || [];
      const dustEntries = [];
      for (const it of rawDust) {
        const ok = await isValidPubkeyStr(it.mint).catch(() => false);
        if (ok) dustEntries.push(it);
        else removeFromDustCache(owner, it.mint);
      }

      const entries = cachedEntries.filter(it => it.mint !== SOL_MINT && Number(it.sizeUi||0) > 0);

      if (!entries.length && !dustEntries.length) {
        walletListEl.innerHTML = `<div style="opacity:.7">No coins held.</div>`;
        walletTotalsEl.textContent = `Total: ${fmtUsd(solBal * solUsdPx)} (${solBal.toFixed(6)} SOL)`;
        return;
      }

      walletListEl.innerHTML = `
        <div style="opacity:.9; font-weight:600; margin:6px 0;">Sellable</div>
        <div data-sellable></div>
        <div style="opacity:.9; font-weight:600; margin:10px 0 6px;">Dust / Unsellable</div>
        <div data-dust></div>
      `;
      const sellWrap = walletListEl.querySelector("[data-sellable]");
      const dustWrap = walletListEl.querySelector("[data-dust]");

      let totalUsd = solBal * solUsdPx;
      let totalSol = solBal;

      if (!window._fdvWalletQuoteCache) window._fdvWalletQuoteCache = new Map();
      const qCache = window._fdvWalletQuoteCache;
      const minGap = Math.max(5_000, Number(state.minQuoteIntervalMs || 10_000));
      const baseMinNotional = minSellNotionalSol();

      async function renderRow({ mint, sizeUi, decimals }, forceDust = false) {
        const row = document.createElement("div");
        row.style.display = "grid";
        row.style.gridTemplateColumns = "1fr auto auto auto";
        row.style.gap = "8px";
        row.style.alignItems = "center";
        row.style.fontSize = "12px";
        row.innerHTML = `
          <div><code>${mint.slice(0,4)}…${mint.slice(-4)}</code></div>
          <div title="Token amount">Amt: ${Number(sizeUi||0).toFixed(6)}</div>
          <div data-sol>~SOL: …</div>
          <div data-usd>USD: …</div>
        `;

        const cacheKey = `${owner}:${mint}:${Number(sizeUi).toFixed(9)}`;
        let estSol = 0;
        try {
          const hit = qCache.get(cacheKey);
          if (hit && (now() - hit.ts) < minGap) {
            estSol = Number(hit.sol || 0) || 0;
          } else {
            estSol = await quoteOutSol(mint, Number(sizeUi||0), decimals).catch(()=>0);
            qCache.set(cacheKey, { ts: now(), sol: estSol });
          }
        } catch { estSol = 0; }

        const solCell = row.querySelector("[data-sol]");
        const usdCell = row.querySelector("[data-usd]");
        solCell.textContent = `~SOL: ${estSol.toFixed(6)}`;
        const usd = estSol * solUsdPx;
        usdCell.textContent = `USD: ${solUsdPx>0?fmtUsd(usd):"—"}`;

        totalSol += estSol;
        totalUsd += usd;

        const sellable = !forceDust && estSol > 0 && estSol >= baseMinNotional;
        (sellable ? sellWrap : dustWrap).appendChild(row);
      }

      // Active positions
      for (const it of entries) {
        await renderRow(it, false);
      }
      // Dust / unsellable
      const posMints = new Set(entries.map(x => x.mint));
      for (const it of dustEntries) {
        if (posMints.has(it.mint)) continue;
        await renderRow(it, true);
      }

      walletTotalsEl.textContent = `Total: ${fmtUsd(totalUsd)} (${totalSol.toFixed(6)} SOL)`;
      walletTotalsEl.innerHTML += ` <button data-auto-sec-export style="font-size:12px; padding:2px 6px;">Export</button>`;
    } catch (e) {
      walletListEl.innerHTML = `<div style="color:#f66;">${e.message || e}</div>`;
    }
  }

  let walletOpen = false;
  function closeWalletMenu() {
    walletOpen = false;
    try { walletMenuEl.classList.remove("show"); } catch {}
    try { if (walletModalEl) walletModalEl.style.display = "none"; } catch {}
  }
  walletBtn.addEventListener("click", async (e) => {
    e.preventDefault(); e.stopPropagation();
    walletOpen = !walletOpen;
    if (walletOpen) {
      await renderWalletMenu();
      try { walletMenuEl.classList.add("show"); } catch {}
      try { if (walletModalEl) walletModalEl.style.display = "flex"; } catch {}
    } else {
      closeWalletMenu();
    }
  });

  // Close modal when clicking the backdrop or the close button
  walletMenuEl.addEventListener("click", (e) => {
    if (!walletOpen) return;
    const t = e.target;
    if (t === walletMenuEl || (t && t.closest && t.closest("[data-auto-wallet-close]"))) {
      e.preventDefault();
      e.stopPropagation();
      closeWalletMenu();
    }
  });

  let unwindOpen = false;
  let unwindBusy = false;

  function closeUnwindMenu() {
    unwindOpen = false;
    try { unwindMenuEl?.classList?.remove?.("show"); } catch {}
    try { if (unwindModalEl) unwindModalEl.style.display = "none"; } catch {}
  }

  // Ensure it starts hidden even if CSS changes.
  closeUnwindMenu();

  async function renderUnwindMenu() {
    const issues = [];
    const notes = [];

    try {
      if (state.enabled) issues.push("Bot is running. Stop it before returning.");

      const rpc = currentRpcUrl();
      if (!rpc) issues.push("No RPC connected. Set an RPC URL first.");

      const recipient = String(state.recipientPub || "").trim();
      if (!recipient) issues.push("Recipient is missing. Set Recipient first.");
      else {
        const ok = await isValidPubkeyStr(recipient).catch(() => false);
        if (!ok) issues.push("Recipient address looks invalid.");
      }

      const kp = await getAutoKeypair().catch(() => null);
      if (!kp) issues.push("Auto wallet not ready. Click Generate first.");

      const owner = kp ? kp.publicKey.toBase58() : String(state.autoWalletPub || "").trim();

      let solBal = 0;
      if (owner && rpc) solBal = await fetchSolBalance(owner).catch(() => NaN);
      if (!Number.isFinite(solBal)) {
        issues.push("Unable to fetch SOL balance (RPC/CORS issue?).");
        solBal = 0;
      }

      const rentReserveSol = 0.001;
      const returnableSolNow = Math.max(0, solBal - rentReserveSol);

      let hasCoins = false;
      try {
        const set = new Set();
        for (const m of Object.keys(state.positions || {})) if (m && m !== SOL_MINT) set.add(m);
        if (owner) {
          try {
            const cached = cacheToList(owner) || [];
            for (const it of cached) if (it?.mint && it.mint !== SOL_MINT && Number(it.sizeUi || 0) > 0) set.add(it.mint);
          } catch {}
          try {
            const dust = dustCacheToList(owner) || [];
            for (const it of dust) if (it?.mint && it.mint !== SOL_MINT && Number(it.sizeUi || 0) > 0) set.add(it.mint);
          } catch {}
        }
        hasCoins = set.size > 0;
      } catch {}

      const minFeeSol = Math.max(0.002, Number(FEE_RESERVE_MIN || 0), Number(MIN_OPERATING_SOL || 0));
      if (hasCoins && solBal < minFeeSol) {
        issues.push(`Insufficient SOL for unwind fees (have ${solBal.toFixed(4)} SOL; need ~${minFeeSol.toFixed(4)} SOL).`);
      }

      if (!hasCoins && returnableSolNow <= 0) {
        issues.push("No SOL to return (balance is empty after rent reserve).");
      }

      notes.push(`Auto wallet: ${owner ? owner.slice(0, 4) + "…" + owner.slice(-4) : "(missing)"}`);
      notes.push(`Recipient: ${recipient ? recipient.slice(0, 4) + "…" + recipient.slice(-4) : "(missing)"}`);
      notes.push(`SOL balance: ${solBal.toFixed(6)} (returnable now ~${returnableSolNow.toFixed(6)} SOL)`);
      if (hasCoins) notes.push("Also returns value from selling all held SPL tokens.");
      notes.push("This action cannot be undone.");
    } catch (e) {
      issues.push(`Unable to prepare Return prompt: ${e?.message || e}`);
    }

    try {
      if (unwindSummaryEl) {
        unwindSummaryEl.innerHTML = `
          <div style="font-weight:600; margin-bottom:6px;">What happens</div>
          <div style="opacity:.9;">Sells all SPL tokens in the Auto Wallet and transfers SOL to your Recipient.</div>
          <div style="opacity:.85; margin-top:10px;">${notes.map(x => `<div>${x}</div>`).join("")}</div>
        `;
      }
    } catch {}

    const canConfirm = issues.length === 0 && !unwindBusy;

    try {
      if (unwindWarningsEl) {
        if (issues.length) {
          unwindWarningsEl.innerHTML = `
            <div style="color:#f66; font-weight:600; margin-bottom:6px;">Blocked</div>
            ${issues.map(x => `<div style=\"color:#f66;\">• ${x}</div>`).join("")}
          `;
        } else {
          unwindWarningsEl.innerHTML = `<div style="opacity:.85;">You’re good to go.</div>`;
        }
      }
    } catch {}

    try {
      if (unwindConfirmBtn) {
        unwindConfirmBtn.disabled = !canConfirm;
        unwindConfirmBtn.textContent = unwindBusy ? "Returning…" : "Return";
      }
      if (unwindCancelBtn) unwindCancelBtn.disabled = !!unwindBusy;
    } catch {}
  }

  if (unwindBtn && unwindMenuEl) {
    unwindBtn.addEventListener("click", async (e) => {
      e.preventDefault();
      e.stopPropagation();
      unwindOpen = !unwindOpen;
      if (unwindOpen) {
        await renderUnwindMenu();
        try { unwindMenuEl.classList.add("show"); } catch {}
        try { if (unwindModalEl) unwindModalEl.style.display = "flex"; } catch {}
      } else {
        closeUnwindMenu();
      }
    });

    unwindMenuEl.addEventListener("click", (e) => {
      if (!unwindOpen || unwindBusy) return;
      const t = e.target;
      if (t === unwindMenuEl || (t && t.closest && t.closest("[data-auto-unwind-close],[data-auto-unwind-cancel]"))) {
        e.preventDefault();
        e.stopPropagation();
        closeUnwindMenu();
      }
    });

    unwindConfirmBtn?.addEventListener?.("click", async (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (unwindBusy) return;
      unwindBusy = true;
      await renderUnwindMenu();

      try {
        await sweepAllToSolAndReturn();
        save();
        closeUnwindMenu();
      } catch (err) {
        log(`Unwind failed: ${err?.message || err}`, "err");
        unwindBusy = false;
        await renderUnwindMenu();
        return;
      }

      unwindBusy = false;
    });
  }

  // dumpBtn.addEventListener("click", async (e) => {
  //   e.preventDefault(); e.stopPropagation();
  //   if (!state.recipientPub) {
  //     log("Set Recipient before dumping wallet.");
  //     return;
  //   }
  //   try {
  //     await sweepAllToSolAndReturn();
  //     closeWalletMenu();
  //   } catch (err) {
  //     log(`Dump failed: ${err.message || err}`);
  //   }
  // });

  const holdTimeWrap = wrap.querySelector(".fdv-hold-time-slider");
  if (holdTimeWrap) {
    const MIN_HOLD = HOLD_MIN_SECS, MAX_HOLD = HOLD_MAX_SECS;
    let cur = Number(state.maxHoldSecs || HOLD_MAX_SECS);
    cur = Math.min(MAX_HOLD, Math.max(MIN_HOLD, cur));
    if (cur !== state.maxHoldSecs) { state.maxHoldSecs = cur; save(); }

    holdTimeWrap.innerHTML = `
      <div class="fdv-holdtime-row">
        <label class="fdv-holdtime-label">Hold</label>
        <input class="fdv-holdtime-range fdv-range" type="range" data-auto-holdtime min="${MIN_HOLD}" max="${MAX_HOLD}" step="1" value="${cur}" />
        <div class="fdv-holdtime-val" data-auto-holdtime-val>${cur}s</div>
        <label class="fdv-holdtime-dyn">
          <input type="checkbox" data-auto-dynhold />
          <span class="fdv-holdtime-infty">∞</span>
        </label>
      </div>
    `;

    const rangeEl = holdTimeWrap.querySelector('[data-auto-holdtime]');
    const valEl   = holdTimeWrap.querySelector('[data-auto-holdtime-val]');
    const dynEl = holdTimeWrap.querySelector('[data-auto-dynhold]');
    const render  = () => { valEl.textContent = `${Number(rangeEl.value||cur)}s`; };

    rangeEl.addEventListener("input", render);
    rangeEl.addEventListener("change", () => {
      const v = Math.max(MIN_HOLD, Math.min(MAX_HOLD, Number(rangeEl.value || cur)));
      state.maxHoldSecs = v;
      save();
      render();
      log(`Hold time set: ${v}s`);
    });
    render();

    dynEl.checked = state.dynamicHoldEnabled !== false;
    rangeEl.disabled = !!dynEl.checked;
    dynEl.addEventListener("change", () => {
      state.dynamicHoldEnabled = dynEl.checked;
      save();
      rangeEl.disabled = !!dynEl.checked;
      log(`Dynamic hold: ${state.dynamicHoldEnabled ? "ON" : "OFF"}`);
    });

    try {
      if (window._fdvDynHoldUiTimer) clearInterval(window._fdvDynHoldUiTimer);
    } catch {}
    window._fdvDynHoldUiTimer = setInterval(() => {
      try {
        if (!rangeEl.isConnected || !dynEl.isConnected || !valEl.isConnected) {
          try { clearInterval(window._fdvDynHoldUiTimer); } catch {}
          window._fdvDynHoldUiTimer = 0;
          return;
        }
        if (!dynEl.checked) return;
        const v = Math.max(MIN_HOLD, Math.min(MAX_HOLD, Number(state.maxHoldSecs || cur)));
        if (Number(rangeEl.value || 0) !== v) {
          rangeEl.value = String(v);
          cur = v;
          render();
        }
      } catch {}
    }, 750);
  }

  secExportBtn.addEventListener("click", () => {
    const payload = JSON.stringify({
      publicKey: state.autoWalletPub || "",
      secretKey: state.autoWalletSecret || "",
      oldWallets: Array.isArray(state.oldWallets) ? state.oldWallets : []
    }, null, 2);
    downloadTextFile(`fdv-auto-wallet-${(state.autoWalletPub||"").slice(0,6)}.json`, payload);
    log("Exported wallet JSON (includes old wallets archive)");
  });

  rpcEl.addEventListener("change", () => {
    setRpcUrl(rpcEl.value);
    if (currentRpcUrl()) log("RPC URL saved.");
    else log("RPC URL cleared. Auto Trader requires a CORS-enabled RPC.");
  });
  rpchEl.addEventListener("change", () => setRpcHeaders(rpchEl.value));

  wrap.querySelector("[data-auto-gen]").addEventListener("click", async () => {
    try {
      await rotateAutoWalletLikeGenerate({ tag: "manual", requireStopped: true, allowWhileEnabled: false });
    } catch (e) {
      log(`Generate/rotate failed: ${e?.message || e}`, "err");
    }
  });
  wrap.querySelector("[data-auto-ledger]").addEventListener("click", async () => {
    try {
      window.open(FDV_LEDGER_URL, "_blank");
    } catch (e) {
      log(`Failed to open ledger: ${e.message || e}`, "err");
    }
  });
  wrap.querySelector("[data-auto-copy]").addEventListener("click", async () => {
    if (!state.autoWalletPub) await ensureAutoWallet();
    navigator.clipboard.writeText(state.autoWalletPub).catch(()=>{});
    log("Address copied");
  });

  // NOTE: Return/Unwind is handled by the confirmation modal wired above.

  if (toggleEl) toggleEl.addEventListener("change", () => onToggle(toggleEl.value === "yes"));
  holdEl.addEventListener("change", () => {
    state.holdUntilLeaderSwitch = (holdEl.value === "yes");
    save();
    log(`Hold-until-leader: ${state.holdUntilLeaderSwitch ? "ON" : "OFF"}`);
  });
  dustEl.addEventListener("change", () => {
    state.dustExitEnabled = (dustEl.value === "yes");
    save();
    log(`Dust sells: ${state.dustExitEnabled ? "ON" : "OFF"}`);
  });
  warmingEl.addEventListener("change", () => {
    state.rideWarming = (warmingEl.value === "yes");
    save();
    log(`Ride Warming: ${state.rideWarming ? "ON" : "OFF"}`);
  });
  multiEl.addEventListener("change", () => {
    state.allowMultiBuy = (multiEl.value === "yes");
    save();
    log(`Multi-buy: ${state.allowMultiBuy ? "ON" : "OFF"}`);
  });
  stealthEl.addEventListener("change", () => {
    (async () => {
      try {
    const requestedOn = (stealthEl.value === "yes");
    // Never allow stealth OFF while Agent Gary mode is effective.
    if (!requestedOn && _isAgentGaryEffective()) {
      state.stealthMode = true;
      save();
      try { stealthEl.value = "yes"; } catch {}
      log("Stealth must remain ON while Agent Gary mode is active.", "warn");
      return;
    }

    const on = requestedOn;
        state.stealthMode = on;
        save();
        log(`Stealth mode: ${state.stealthMode ? "ON" : "OFF"}`);

        // Behave like Generate/Rotate when stealth is activated.
        if (on) {
          // For safety, require bot stopped when toggled from UI.
          await rotateAutoWalletLikeGenerate({ tag: "stealth-on", requireStopped: true, allowWhileEnabled: false });
        }
      } catch (e) {
        log(`Stealth toggle failed: ${e?.message || e}`, "err");
      }
    })();
  });
  startBtn.addEventListener("click", () => onToggle(true));
  stopBtn.addEventListener("click", () => onToggle(false));
  wrap.querySelector("[data-auto-reset]").addEventListener("click", () => {
    let feeBps = Number(FDV_PLATFORM_FEE_BPS || 0);
    log(`Platform fee base: ${feeBps}bps (actual sell fee can be lower via dynamic fee logic)`);
    state.holdingsUi = 0;
    state.avgEntryUsd = 0;
    state.lastTradeTs = 0;
    state.endAt = 0;
    state.moneyMadeSol = 0;
    state.solSessionStartLamports = 0;
    state.pnlBaselineSol = 0; // reset session baseline
    fetchSolBalance(state.autoWalletPub).then(b => { depBalEl.value = `${b.toFixed(4)} SOL`; }).catch(()=>{});
    save();
    try { updateStatsHeader(); } catch {}
    log("Session stats refreshed");
  });

  const saveField = () => {
    const life = _clamp(parseInt(lifeEl.value || "0", 10), UI_LIMITS.LIFE_MINS_MIN, UI_LIMITS.LIFE_MINS_MAX);
    state.lifetimeMins = life;
    lifeEl.value = String(life);

    const rawPct = normalizePercent(buyPctEl.value);
    const pct = _clamp(rawPct, UI_LIMITS.BUY_PCT_MIN, UI_LIMITS.BUY_PCT_MAX);
    state.buyPct = pct;
    buyPctEl.value = (pct * 100).toFixed(2);

    let minBuy = _clamp(Number(minBuyEl.value || 0), UI_LIMITS.MIN_BUY_SOL_MIN, UI_LIMITS.MIN_BUY_SOL_MAX);
    let maxBuy = _clamp(Number(maxBuyEl.value || 0), UI_LIMITS.MAX_BUY_SOL_MIN, UI_LIMITS.MAX_BUY_SOL_MAX);

    if (maxBuy < minBuy) maxBuy = minBuy;

    state.minBuySol = minBuy;
    state.maxBuySol = maxBuy;

    const edge = Number(minEdgeEl.value);
    const edgeClamped = Math.min(10, Math.max(-10, Number.isFinite(edge) ? edge : state.minNetEdgePct ?? -5));
    state.minNetEdgePct = edgeClamped;
    minEdgeEl.value = String(edgeClamped);

    const wd = Number(warmDecayEl.value);
    const wdClamped = Math.min(5, Math.max(0, Number.isFinite(wd) ? wd : (state.warmingDecayPctPerMin ?? 0.25)));
    state.warmingDecayPctPerMin = wdClamped;
    warmDecayEl.value = String(wdClamped);

    minBuyEl.value = String(minBuy);
    maxBuyEl.min = String(minBuy);
    maxBuyEl.value = String(maxBuy);

    if (recvEl) {
      const recvVal = String(recvEl.value || "").trim();
      state.recipientPub = recvVal;
    }

    if (tpEl) {
      const v = Number(tpEl.value);
      state.takeProfitPct = Number.isFinite(v) ? Math.min(500, Math.max(1, v)) : state.takeProfitPct;
      tpEl.value = String(state.takeProfitPct);
    }

    if (slEl) {
      const v = Number(slEl.value);
      state.stopLossPct = Number.isFinite(v) ? Math.min(90, Math.max(0.1, v)) : state.stopLossPct;
      slEl.value = String(state.stopLossPct);
    }

    if (trailEl) {
      const v = Number(trailEl.value);
      state.trailPct = Number.isFinite(v) ? Math.min(90, Math.max(0, v)) : state.trailPct;
      trailEl.value = String(state.trailPct);
    }

    if (slipEl) {
      const v = Number(slipEl.value);
      state.slippageBps = Number.isFinite(v) ? Math.min(2000, Math.max(50, v)) : state.slippageBps;
      slipEl.value = String(state.slippageBps);
    }
    

    save();
  };
  [recvEl, lifeEl, buyPctEl, minBuyEl, maxBuyEl, minEdgeEl, warmDecayEl, tpEl, slEl, trailEl, slipEl].forEach(el => {
    el.addEventListener("input", saveField);
    el.addEventListener("change", saveField);
  });

  function saveAdvanced() {
    const n = (v) => Number(v);
    const clamp = (v, lo, hi, def) => {
      const x = Number(v);
      return Number.isFinite(x) ? Math.min(hi, Math.max(lo, x)) : def;
    };

    state.warmingMinProfitPct       = clamp(n(warmMinPEl?.value),      0, 50, 2);
    state.warmingMinProfitFloorPct  = clamp(n(warmFloorEl?.value),     0, 50, 1.0);
    state.warmingDecayDelaySecs     = clamp(n(warmDelayEl?.value),       0, 600, 15);
    state.warmingAutoReleaseSecs    = clamp(n(warmReleaseEl?.value),     0, 600, 45);
    state.warmingMaxLossPct         = clamp(n(warmMaxLossEl?.value),     1,  50, 6);
    state.warmingMaxLossWindowSecs  = clamp(n(warmMaxWindowEl?.value),   5, 180, 30);
    state.warmingPrimedConsec       = clamp(n(warmConsecEl?.value),      1,   3, 1);
    state.reboundMinScore       = clamp(n(reboundScoreEl?.value),     0, 5, 0.34);
    state.reboundLookbackSecs   = clamp(n(reboundLookbackEl?.value),  5, 180, 45);
    if (fricSnapEl) {
      state.fricSnapEpsSol = clamp(
        n(fricSnapEl.value),
        0,
        0.05,
        0.0020
      );
    }
    if (finalGateEnabledEl) {
      state.finalPumpGateEnabled = finalGateEnabledEl.value === "yes";
    }
    if (finalGateMinStartEl) {
      state.finalPumpGateMinStart = clamp(
        n(finalGateMinStartEl.value),
        0,
        50,
        2
      );
    }
    if (finalGateDeltaEl) {
      state.finalPumpGateDelta = clamp(
        n(finalGateDeltaEl.value),
        0,
        50,
        3
      );
    }
    if (finalGateWindowEl) {
      state.finalPumpGateWindowMs = clamp(
        n(finalGateWindowEl.value),
        1000,
        30000,
        10000
      );
    }

    if (entrySimModeEl) {
      const m = String(entrySimModeEl.value || "enforce").toLowerCase();
      state.entrySimMode = (m === "off" || m === "warn" || m === "enforce") ? m : "enforce";
    }
    if (maxEntryCostEl) {
      state.maxEntryCostPct = clamp(n(maxEntryCostEl.value), 0, 10, 1.5);
    }
    if (entrySimHorizonEl) {
      state.entrySimHorizonSecs = clamp(n(entrySimHorizonEl.value), 30, 600, 120);
    }
    if (entrySimMinProbEl) {
      state.entrySimMinWinProb = clamp(n(entrySimMinProbEl.value), 0, 1, 0.55);
    }
    if (entrySimMinTermEl) {
      state.entrySimMinTerminalProb = clamp(n(entrySimMinTermEl.value), 0, 1, 0.60);
    }
    if (entrySimSigmaFloorEl) {
      state.entrySimSigmaFloorPct = clamp(n(entrySimSigmaFloorEl.value), 0, 10, 0.75);
    }
    if (entrySimMuLevelWeightEl) {
      state.entrySimMuLevelWeight = clamp(n(entrySimMuLevelWeightEl.value), 0, 1, 0.35);
    }

    if (grossBaseGoalEl) {
      state.minProfitToTrailPct = clamp(n(grossBaseGoalEl.value), 0.5, 200, 2);
    }
    if (edgeBufEl) {
      state.edgeSafetyBufferPct = clamp(n(edgeBufEl.value), 0, 2, 0.1);
    }

    if (lightEnabledEl) state.lightEntryEnabled = lightEnabledEl.value === "yes";
    if (lightFracEl) state.lightEntryFraction = clamp(n(lightFracEl.value), 0.1, 0.9, 1/3);
    if (lightArmEl) state.lightTopUpArmMs = clamp(n(lightArmEl.value), 1000, 60000, 7000);
    if (lightMinChgEl) state.lightTopUpMinChg5m = clamp(n(lightMinChgEl.value), 0, 50, 0.8);
    if (lightMinChgSlopeEl) state.lightTopUpMinChgSlope = clamp(n(lightMinChgSlopeEl.value), 0, 50, 6);
    if (lightMinScSlopeEl) state.lightTopUpMinScSlope = clamp(n(lightMinScSlopeEl.value), 0, 50, 3);

    const rawEdgeStr = (warmEdgeEl?.value ?? "").toString().trim();
    if (rawEdgeStr.length > 0) {
      const edgeVal = Number(rawEdgeStr);
      if (Number.isFinite(edgeVal)) {
        state.warmingEdgeMinExclPct = Math.min(10, Math.max(-10, edgeVal));
      } else {
        delete state.warmingEdgeMinExclPct;
      }
    } else {
      delete state.warmingEdgeMinExclPct;
    }

    if (warmMinPEl)      warmMinPEl.value      = String(state.warmingMinProfitPct);
    if (warmFloorEl)     warmFloorEl.value     = String(state.warmingMinProfitFloorPct);
    if (warmDelayEl)     warmDelayEl.value     = String(state.warmingDecayDelaySecs);
    if (warmReleaseEl)   warmReleaseEl.value   = String(state.warmingAutoReleaseSecs);
    if (warmMaxLossEl)   warmMaxLossEl.value   = String(state.warmingMaxLossPct);
    if (warmMaxWindowEl) warmMaxWindowEl.value = String(state.warmingMaxLossWindowSecs);
    if (warmConsecEl)    warmConsecEl.value    = String(state.warmingPrimedConsec);
    if (warmEdgeEl)      warmEdgeEl.value      = (typeof state.warmingEdgeMinExclPct === "number")
      ? String(state.warmingEdgeMinExclPct) : "";
    if (reboundScoreEl)    reboundScoreEl.value    = String(state.reboundMinScore);
    if (reboundLookbackEl) reboundLookbackEl.value = String(state.reboundLookbackSecs);
    if (fricSnapEl)       fricSnapEl.value       = String(state.fricSnapEpsSol);
    if (finalGateEnabledEl)   finalGateEnabledEl.value  = state.finalPumpGateEnabled ? "yes" : "no";
    if (finalGateMinStartEl)  finalGateMinStartEl.value = String(state.finalPumpGateMinStart);
    if (finalGateDeltaEl)     finalGateDeltaEl.value    = String(state.finalPumpGateDelta);
    if (finalGateWindowEl)    finalGateWindowEl.value   = String(state.finalPumpGateWindowMs);

    if (entrySimModeEl)    entrySimModeEl.value    = String(state.entrySimMode || "enforce");
    if (maxEntryCostEl)    maxEntryCostEl.value    = String(state.maxEntryCostPct);
    if (entrySimHorizonEl) entrySimHorizonEl.value = String(state.entrySimHorizonSecs);
    if (entrySimMinProbEl) entrySimMinProbEl.value = String(state.entrySimMinWinProb);
    if (entrySimMinTermEl) entrySimMinTermEl.value = String(state.entrySimMinTerminalProb);
    if (entrySimSigmaFloorEl) entrySimSigmaFloorEl.value = String(state.entrySimSigmaFloorPct);
    if (entrySimMuLevelWeightEl) entrySimMuLevelWeightEl.value = String(state.entrySimMuLevelWeight);

    if (grossBaseGoalEl) grossBaseGoalEl.value = String(state.minProfitToTrailPct);
    if (edgeBufEl) edgeBufEl.value = String(state.edgeSafetyBufferPct);
    if (lightEnabledEl) lightEnabledEl.value = state.lightEntryEnabled ? "yes" : "no";
    if (lightFracEl) lightFracEl.value = String(state.lightEntryFraction);
    if (lightArmEl) lightArmEl.value = String(state.lightTopUpArmMs);
    if (lightMinChgEl) lightMinChgEl.value = String(state.lightTopUpMinChg5m);
    if (lightMinChgSlopeEl) lightMinChgSlopeEl.value = String(state.lightTopUpMinChgSlope);
    if (lightMinScSlopeEl) lightMinScSlopeEl.value = String(state.lightTopUpMinScSlope);

    save();
  }

  [grossBaseGoalEl, edgeBufEl, lightEnabledEl, lightFracEl, lightArmEl, lightMinChgEl, lightMinChgSlopeEl, lightMinScSlopeEl,
   warmMinPEl, warmFloorEl, warmDelayEl, warmReleaseEl, warmMaxLossEl, warmMaxWindowEl, warmConsecEl, warmEdgeEl,
   reboundScoreEl, reboundLookbackEl, fricSnapEl, finalGateEnabledEl, finalGateMinStartEl, finalGateDeltaEl, finalGateWindowEl,
   entrySimModeEl, maxEntryCostEl, entrySimHorizonEl, entrySimMinProbEl, entrySimMinTermEl, entrySimSigmaFloorEl, entrySimMuLevelWeightEl]
    .filter(Boolean)
    .forEach(el => {
      el.addEventListener("input", saveAdvanced);
      el.addEventListener("change", saveAdvanced);
    });

  if (toggleEl) toggleEl.value = state.enabled ? "yes" : "no";
  holdEl.value = state.holdUntilLeaderSwitch ? "yes" : "no";
  dustEl.value = state.dustExitEnabled ? "yes" : "no";
  warmingEl.value = state.rideWarming ? "yes" : "no";
  startBtn.disabled = !!state.enabled;
  stopBtn.disabled = !state.enabled;
  if (state.enabled && !timer) timer = setInterval(tick, Math.max(1200, Number(state.tickMs || 1000)));

  if (state.autoWalletPub) {
    fetchSolBalance(state.autoWalletPub).then(b => { depBalEl.value = `${b.toFixed(4)} SOL`; }).catch(()=>{});
  }
  if (!currentRpcUrl()) {
    log("RPC not configured. Set a CORS-enabled RPC URL to enable trading.");
  }
  log("Auto widget ready.");
}

function disableOwnerScans(reason) {
  if (state.ownerScanDisabled) return;
  state.ownerScanDisabled = true;
  state.ownerScanDisabledReason = String(reason || "RPC forbids owner scans");
  save();
  log("Owner scans disabled. RPC blocks account-owner queries. Update RPC URL or upgrade your plan.");
}

// Node/CLI debug helpers (no-ops unless explicitly imported and called)
export async function __fdvDebug_evalAndMaybeSellPositions() {
  return await evalAndMaybeSellPositions();
}

export function __fdvDebug_flagUrgentSell(mint, reason = "", sev = 0) {
  return flagUrgentSell(mint, reason, sev);
}

export function __fdvDebug_peekUrgentSell(mint) {
  return peekUrgentSell(mint);
}

export function __fdvDebug_setOverrides(overrides = null) {
  try {
    globalThis.__fdvAutoBotOverrides = overrides && typeof overrides === "object" ? overrides : {};
    return true;
  } catch {
    return false;
  }
}

async function waitForTokenIncrease(ownerPubkeyStr, mintStr, prevSizeUi, { timeoutMs = 12000, pollMs = 350 } = {}) {
  const start = now();
  const prev = Number(prevSizeUi || 0);
  while (now() - start < timeoutMs) {
    try {
      const b = await getAtaBalanceUi(ownerPubkeyStr, mintStr, undefined);
      const cur = Number(b.sizeUi || 0);
      if (cur > prev + Math.max(1e-9, prev * 0.0005)) {
        return { increased: true, sizeUi: cur, decimals: Number.isFinite(b.decimals) ? b.decimals : undefined };
      }
    } catch {}
    await new Promise(r => setTimeout(r, pollMs));
  }
  try {
    await reconcileFromOwnerScan(ownerPubkeyStr);
  } catch {}
  try {
    const b = await getAtaBalanceUi(ownerPubkeyStr, mintStr, undefined);
    const cur = Number(b.sizeUi || 0);
    return { increased: cur > prev + Math.max(1e-9, prev * 0.0005), sizeUi: cur, decimals: Number.isFinite(b.decimals) ? b.decimals : undefined };
  } catch {
    return { increased: false, sizeUi: prev, decimals: undefined };
  }
}

// Light-entry mechanism: buy 1/3 now, add remaining 2/3 on trend-up.
const LIGHT_ENTRY_FRACTION = 1 / 3;
const LIGHT_TOPUP_ARM_MS = 7000;
const LIGHT_TOPUP_MIN_CHG5M = 0.8;
const LIGHT_TOPUP_MIN_CHG_SLOPE = 6;
const LIGHT_TOPUP_MIN_SC_SLOPE = 3;

function _hasPendingLightTopUps() {
  try {
    for (const [mint, pos] of Object.entries(state.positions || {})) {
      if (!mint || mint === SOL_MINT) continue;
      if (!pos) continue;
      if (Number(pos.lightRemainingSol || 0) > 0) return true;
    }
    return false;
  } catch {
    return false;
  }
}

function _shouldLightTopUpMint(mint, pos, nowTs = now()) {
  try {
    if (!mint || !pos) return false;
    if (!(Number(pos.lightRemainingSol || 0) > 0)) return false;
    if (pos.awaitingSizeSync) return false;
    if (isMintLocked(mint)) return false;
    if (isMintBlacklisted(mint) || isPumpDropBanned(mint)) return false;
    if (Number(pos.sizeUi || 0) <= 0) return false;
    const armAt = Number(pos.lightTopUpArmedAt || 0);
    if (armAt && nowTs < armAt) return false;

    const series3 = getLeaderSeries(mint, 3) || [];
    const last = series3?.[series3.length - 1] || {};
    const chg5m = Number(last?.chg5m ?? 0);
    const chgSlope = slope3pm(series3, "chg5m");
    const scSlope = slope3pm(series3, "pumpScore");

    const minChg = (() => {
      const x = Number(state.lightTopUpMinChg5m);
      return Number.isFinite(x) ? Math.max(0, Math.min(50, x)) : LIGHT_TOPUP_MIN_CHG5M;
    })();
    const minChgSlope = (() => {
      const x = Number(state.lightTopUpMinChgSlope);
      return Number.isFinite(x) ? Math.max(0, Math.min(50, x)) : LIGHT_TOPUP_MIN_CHG_SLOPE;
    })();
    const minScSlope = (() => {
      const x = Number(state.lightTopUpMinScSlope);
      return Number.isFinite(x) ? Math.max(0, Math.min(50, x)) : LIGHT_TOPUP_MIN_SC_SLOPE;
    })();

    // Simple "starts to go up" trigger (either level or slope-based).
    const ok =
      (Number.isFinite(chg5m) && chg5m >= minChg) ||
      (Number.isFinite(chgSlope) && chgSlope >= minChgSlope) ||
      (Number.isFinite(scSlope) && scSlope >= minScSlope);
    return !!ok;
  } catch {
    return false;
  }
}

async function _tryLightTopUp(kp) {
  try {
    if (!kp) return false;
    if (_buyInFlight || _inFlight || _switchingLeader) return false;
    const nowTs = now();
    const ownerStr = kp.publicKey?.toBase58?.() || "";
    if (!ownerStr) return false;

    const entries = Object.entries(state.positions || {})
      .filter(([m, p]) => m && m !== SOL_MINT && p && Number(p.lightRemainingSol || 0) > 0);
    if (!entries.length) return false;

    const candidate = entries.find(([m, p]) => _shouldLightTopUpMint(m, p, nowTs));
    if (!candidate) return false;

    const [mint, pos] = candidate;

    if (!tryAcquireBuyLock(BUY_LOCK_MS)) return false;

    // One mint op at a time.
    lockMint(mint);
    _buyInFlight = true;
    try {
      const remainingTargetSol = Math.max(0, Number(pos.lightRemainingSol || 0));
      if (!(remainingTargetSol > 0)) return false;

      const solBal = await fetchSolBalance(ownerStr);
      const ceiling = await computeSpendCeiling(ownerStr, { solBalHint: solBal });
      const minThreshold = Math.max(state.minBuySol, MIN_SELL_SOL_OUT);

      const reqRent = await requiredAtaLamportsForSwap(ownerStr, SOL_MINT, mint);
      const spendableLamports = Math.floor(Math.max(0, Number(ceiling.spendableSol || 0)) * 1e9);
      const candidateBudgetLamports = Math.max(0, spendableLamports - reqRent - TX_FEE_BUFFER_LAMPORTS);

      const targetLamports = Math.floor(remainingTargetSol * 1e9);
      let buyLamports = Math.min(targetLamports, candidateBudgetLamports);

      const minInLamports = Math.floor(MIN_JUP_SOL_IN * 1e9);
      let minPerOrderLamports = Math.max(minInLamports, Math.floor(minThreshold * 1e9));
      try {
        const recurringL   = EDGE_TX_FEE_ESTIMATE_LAMPORTS;
        const oneTimeL     = Math.max(0, reqRent);
        const needByRecurr = Math.ceil(recurringL / Math.max(1e-12, MAX_RECURRING_COST_FRAC));
        const needByOne    = Math.ceil(
          oneTimeL / Math.max(1e-12, MAX_ONETIME_COST_FRAC * Math.max(1, ONE_TIME_COST_AMORTIZE))
        );
        const needByFrictionSplit = Math.max(needByRecurr, needByOne);
        minPerOrderLamports = Math.max(minPerOrderLamports, needByFrictionSplit);
      } catch {}
      if (reqRent > 0) {
        const elevatedL = Math.floor(ELEVATED_MIN_BUY_SOL * 1e9);
        minPerOrderLamports = Math.max(minPerOrderLamports, elevatedL);
      }

      if (buyLamports < minPerOrderLamports) {
        const canCover = candidateBudgetLamports >= minPerOrderLamports;
        if (canCover) {
          buyLamports = minPerOrderLamports;
        } else {
          // Not enough spendable right now; try again later.
          const armMs = Math.max(1000, Number(state.lightTopUpArmMs || LIGHT_TOPUP_ARM_MS));
          pos.lightTopUpArmedAt = nowTs + Math.max(2500, armMs);
          save();
          return false;
        }
      }

      const buySol = buyLamports / 1e9;
      const prevSize = Number(pos.sizeUi || 0);

      log(
        `Light top-up ${mint.slice(0,4)}… +${buySol.toFixed(6)} SOL (remaining≈${remainingTargetSol.toFixed(6)} SOL)`
      );

      let dynSlip = Math.max(150, Number(state.slippageBps || 150));
      try {
        const leadersNow = computePumpingLeaders(3) || [];
        const itNow = leadersNow.find(x => x?.mint === mint);
        const kpNow = itNow?.kp || {};
        const solPx = await getSolUsd();
        const liq = Number(kpNow.liqUsd || 0);
        if (solPx > 0 && liq > 0) {
          const imp = Math.max(0, Math.min(0.01, (buySol * solPx) / liq));
          dynSlip = Math.min(600, Math.max(150, Math.floor(10000 * imp * 1.2)));
        }
      } catch {}

      const res = await _getDex().buyWithConfirm(
        { signer: kp, mint, solUi: buySol, slippageBps: dynSlip },
        { retries: 2, confirmMs: 32000 },
      );

      try { _noteDexTx("buy", mint, res, { solUi: buySol, slippageBps: dynSlip }); } catch {}
      if (!res.ok) {
        log(`Light top-up not confirmed for ${mint.slice(0,4)}… will retry later.`, "warn");
        {
          const armMs = Math.max(1000, Number(state.lightTopUpArmMs || LIGHT_TOPUP_ARM_MS));
          pos.lightTopUpArmedAt = nowTs + Math.max(2500, armMs);
        }
        save();
        return false;
      }

      let got = { increased: false, sizeUi: prevSize, decimals: Number.isFinite(pos.decimals) ? pos.decimals : 6 };
      try {
        got = await waitForTokenIncrease(ownerStr, mint, prevSize, { timeoutMs: 12000, pollMs: 350 });
      } catch {}

      pos.costSol = Number(pos.costSol || 0) + buySol;
      pos.lastBuyAt = now();
      pos.lastSeenAt = now();
      pos.awaitingSizeSync = !got.increased;
      if (Number(got.sizeUi || 0) > 0) pos.sizeUi = Number(got.sizeUi || 0);
      if (Number.isFinite(got.decimals)) pos.decimals = got.decimals;

      pos.lightRemainingSol = Math.max(0, Number(pos.lightRemainingSol || 0) - buySol);
      pos.lightTopUpTries = Number(pos.lightTopUpTries || 0) + 1;
      if (!(Number(pos.lightRemainingSol || 0) > 0)) {
        pos.lightRemainingSol = 0;
        pos.lightEntry = false;
      } else {
        const armMs = Math.max(1000, Number(state.lightTopUpArmMs || LIGHT_TOPUP_ARM_MS));
        pos.lightTopUpArmedAt = now() + Math.max(2500, armMs);
      }
      save();
      return true;
    } finally {
      _buyInFlight = false;
      unlockMint(mint);
    }
  } catch {
    return false;
  }
}

function _summarizePastCandlesForMint(mint, maxCandles = 24) {
  try {
    const now = Date.now();
    const cache = _summarizePastCandlesForMint._cache || (_summarizePastCandlesForMint._cache = new Map());
    const key = `${String(mint || "").trim()}|${Number(maxCandles || 24) | 0}`;
    const hit = cache.get(key);
    if (hit && (now - (hit.ts || 0)) < 15000) return hit.value;

    const BUCKET_MS = 5 * 60 * 1000;

    const sig = (x) => {
      const n = Number(x || 0);
      if (!Number.isFinite(n) || n === 0) return 0;





      // Compact for token/cost without losing sign.
      return Number(n.toPrecision(6));
    };

    const ticks = getPumpHistoryForMint(mint, { limit: Math.max(12, Math.min(240, Number(maxCandles || 24) * 6)) }) || [];
    if (!Array.isArray(ticks) || !ticks.length) return null;







    // gary reads better candlesticks from here
    // Bucketize: bucketStartMs -> { tsMs, close, v5mUsd }
    const buckets = new Map();
    for (const t of ticks) {
      const tsMs = Number(t?.ts || 0);
      const close = Number(t?.priceUsd || 0);
      if (!(tsMs > 0) || !(close > 0) || !Number.isFinite(close)) continue;
      const bucketStartMs = Math.floor(tsMs / BUCKET_MS) * BUCKET_MS;
      if (!(bucketStartMs > 0)) continue;
      const v = Math.max(0, Number(t?.v5mUsd || 0));
      const prev = buckets.get(bucketStartMs);
      if (!prev || tsMs >= prev.tsMs) {
        buckets.set(bucketStartMs, {
          tsMs,
          close,
          // v5m is a rolling 5m stat from the source; keep the last observed value in bucket.
          v5mUsd: Number.isFinite(v) ? v : 0,
        });
      }
    }

    if (!buckets.size) return null;

    const want = Math.max(6, Math.min(48, Number(maxCandles || 24) | 0));
    const ordered = Array.from(buckets.entries())
      .sort((a, b) => a[0] - b[0])
      .slice(Math.max(0, buckets.size - want));

    const out = [];
    let prevClose = null;
    for (const [bucketStartMs, rec] of ordered) {
      const c = Number(rec?.close || 0);
      if (!(c > 0) || !Number.isFinite(c)) continue;
      const o = (Number.isFinite(prevClose) && prevClose > 0) ? Number(prevClose) : c;
      const h = Math.max(o, c);
      const l = Math.min(o, c);
      const v = Math.max(0, Number(rec?.v5mUsd || 0));

      // Use seconds to reduce payload size; use bucket start time for consistent spacing.
      out.push([
        Math.floor(bucketStartMs / 1000),
        sig(o),
        sig(h),
        sig(l),
        sig(c),
        sig(v),
      ]);
      prevClose = c;
    }

    if (!out.length) return null;

    const stats = (() => {
      try {
        const n = out.length;
        const firstTs = Number(out?.[0]?.[0] ?? 0);
        const lastTs = Number(out?.[n - 1]?.[0] ?? 0);
        const spanMins = (firstTs > 0 && lastTs > firstTs) ? ((lastTs - firstTs) / 60) : 0;
        const expectedStepS = 300;
        let gapCount = 0;
        for (let i = 1; i < n; i++) {
          const prev = Number(out?.[i - 1]?.[0] ?? 0);
          const cur = Number(out?.[i]?.[0] ?? 0);
          const d = cur - prev;
          if (Number.isFinite(d) && d > expectedStepS * 1.75) gapCount++;
        }
        const firstOpen = Number(out?.[0]?.[1] ?? 0);
        const lastClose = Number(out?.[n - 1]?.[4] ?? 0);
        const chgPct = (firstOpen > 0 && lastClose > 0) ? ((lastClose / firstOpen) - 1) * 100 : 0;
        return {
          n,
          firstTs,
          lastTs,
          spanMins: Number(spanMins.toFixed(1)),
          gapCount,
          chgPct: Number(chgPct.toFixed(2)),
        };
      } catch {
        return null;
      }
    })();

    const features = (() => {
      try {
        const n = out.length;
        if (n < 3) return null;

        const closes = out.map((r) => Number(r?.[4] ?? 0));
        const vols = out.map((r) => Number(r?.[5] ?? 0));
        if (!closes.every((x) => Number.isFinite(x) && x > 0)) return null;

        const returnsPct = [];
        for (let i = 1; i < closes.length; i++) {
          const prev = closes[i - 1];
          const cur = closes[i];
          const r = (prev > 0) ? ((cur / prev) - 1) * 100 : 0;
          returnsPct.push(Number.isFinite(r) ? r : 0);
        }

        const last3RetPct = returnsPct.slice(-3).map((x) => Number(x.toFixed(2)));

        // Average % change per 5m candle (simple slope proxy).
        const firstClose = closes[0];
        const lastClose = closes[closes.length - 1];
        const slopePctPer5m = (firstClose > 0 && lastClose > 0)
          ? (((lastClose / firstClose) - 1) * 100) / Math.max(1, closes.length - 1)
          : 0;

        // Volatility proxy: stdev of 5m returns over last ~1h (12 candles => 11 returns).
        const volWindow = Math.max(3, Math.min(11, returnsPct.length));
        const volTail = returnsPct.slice(-volWindow);
        const mean = volTail.reduce((a, b) => a + b, 0) / Math.max(1, volTail.length);
        const variance = volTail.reduce((a, b) => a + (b - mean) * (b - mean), 0) / Math.max(1, volTail.length);
        const volStdPct1h = Math.sqrt(Math.max(0, variance));

        // Max drawdown % from closes.
        let peak = closes[0];
        let maxDd = 0;
        for (const c of closes) {
          if (c > peak) peak = c;
          const dd = (peak > 0) ? ((c / peak) - 1) * 100 : 0;
          if (dd < maxDd) maxDd = dd;
        }

        // Volume trend: last 3 avg vs previous 3 avg.
        const vN = vols.filter((x) => Number.isFinite(x) && x >= 0);
        let volTrendPct = 0;
        if (vN.length >= 6) {
          const a = vN.slice(-3);
          const b = vN.slice(-6, -3);
          const ma = a.reduce((s, x) => s + x, 0) / 3;
          const mb = b.reduce((s, x) => s + x, 0) / 3;
          volTrendPct = (mb > 0) ? ((ma / mb) - 1) * 100 : 0;
        }

        // 1h change (12 candles => 60m)
        let chg1hPct = 0;
        if (closes.length >= 12) {
          const base = closes[closes.length - 12];
          chg1hPct = (base > 0) ? ((lastClose / base) - 1) * 100 : 0;
        }

        return {
          slopePctPer5m: Number(slopePctPer5m.toFixed(3)),
          volStdPct1h: Number(volStdPct1h.toFixed(2)),
          maxDrawdownPct: Number(maxDd.toFixed(2)),
          chg1hPct: Number(chg1hPct.toFixed(2)),
          last3RetPct,
          volTrendPct: Number(volTrendPct.toFixed(2)),
        };
      } catch {
        return null;
      }
    })();

    const quality = (() => {
      try {
        if (!stats) return null;
        const n = Number(stats.n || 0);
        const gapCount = Number(stats.gapCount || 0);
        const hasGaps = gapCount > 0;
        const sparse = n < 12;
        const ok = (n >= 6) && !hasGaps;
        return { ok, n, gapCount, hasGaps, sparse };
      } catch {
        return null;
      }
    })();

    const regime = (() => {
      try {
        if (!features || !stats) return null;
        const n = Number(stats.n || 0);
        if (n < 6) return "unknown";
        if (Number(stats.gapCount || 0) > 0) return "gappy";

        const slope = Number(features.slopePctPer5m || 0);
        const vol = Number(features.volStdPct1h || 0);
        const dd = Number(features.maxDrawdownPct || 0); // negative when drawdown exists

        const absSlope = Math.abs(slope);
        const isVolatile = (vol >= 3.0) || (dd <= -12);
        if (isVolatile) {
          if (slope > 0.12) return "volatile_up";
          if (slope < -0.12) return "volatile_down";
          return "volatile";
        }
        if (slope >= 0.15) return "trend_up";
        if (slope <= -0.15) return "trend_down";
        if (absSlope <= 0.05 && vol <= 0.8) return "flat";
        return "choppy";
      } catch {
        return null;
      }
    })();

    try {
      const g = (typeof window !== "undefined") ? window : globalThis;
      if (g && g._fdvDebugPastCandles && stats) {
        const m = String(mint || "").slice(0, 4);
        traceOnce(
          `pastCandles:${String(mint || "")}`,
          `[PAST] ${m}… n=${stats.n} span=${stats.spanMins}m gaps=${stats.gapCount} chg=${stats.chgPct}%` +
            (features ? ` slope5m=${features.slopePctPer5m}% vol1h=${features.volStdPct1h}% dd=${features.maxDrawdownPct}%` : "") +
            (regime ? ` regime=${regime}` : "") +
            ` ts=[${stats.firstTs}..${stats.lastTs}]`,
          15000,
          "info"
        );
        // Useful for quick inspection from the console without parsing log history.
        try { g._fdvLastPastCandles = { mint: String(mint || ""), stats, features, quality, regime, at: Date.now() }; } catch {}
      }
    } catch {}

    const value = {
      source: "pump_history_v1",
      timeframe: "5m",
      tsUnit: "s",
      format: ["ts", "oUsd", "hUsd", "lUsd", "cUsd", "v5mUsd"],
      candles: out,
      stats,
      features,
      quality,
      regime,
      note: "bucketed 5m; o=prev close; h/l=max/min(o,c)",
    };
    cache.set(key, { ts: now, value });
    return value;
  } catch {
    return null;
  }
}