import { withTimeout } from "../lib/async.js";
import { isNodeLike } from "../lib/runtime.js";
import { createSolanaDepsLoader } from "../lib/solana/deps.js";
import { createConnectionGetter } from "../lib/solana/connection.js";
import { createConfirmSig } from "../lib/solana/confirm.js";

import { focusMint, getRugSignalForMint } from "../../../meme/metrics/kpi/pumping.js";

import {
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
	MINT_BLACKLIST_STAGES_MS,
	URGENT_SELL_COOLDOWN_MS,
	URGENT_SELL_MIN_AGE_MS,
	MINT_OP_LOCK_MS,
	BUY_SEED_TTL_MS,
	BUY_LOCK_MS,
	RUG_FORCE_SELL_SEVERITY,
	RUG_QUOTE_SHOCK_FRAC,
	RUG_QUOTE_SHOCK_WINDOW_MS,
	MIN_JUP_SOL_IN,
	MIN_SELL_SOL_OUT,
	FEE_ATAS,
	DYN_HS,
} from "../lib/constants.js";

import { clamp, fmtUsd, safeNum } from "../lib/util.js";

import { createDex } from "../lib/dex.js";
import { setBotRunning } from "../lib/led.js";
import { preflightBuyLiquidity, DEFAULT_BUY_EXIT_CHECK_FRACTION, DEFAULT_BUY_MAX_PRICE_IMPACT_PCT } from "../lib/liquidity.js";
import { createPendingCreditManager } from "../lib/pendingCredits.js";
import { FDV_PLATFORM_FEE_BPS } from "../../../../config/env.js";
import { rpcWait, rpcBackoffLeft, markRpcStress } from "../lib/rpcThrottle.js";

import { createDustCacheStore } from "../lib/stores/dustCacheStore.js";
import { createPosCacheStore } from "../lib/stores/posCacheStore.js";
import { createBuySeedStore } from "../lib/stores/buySeedStore.js";
import { createMintLockStore } from "../lib/stores/mintLockStore.js";
import { createUrgentSellStore } from "../lib/stores/urgentSellStore.js";
import { createRoundtripEdgeEstimator } from "../lib/honeypot.js";

import { createPreflightSellPolicy } from "../lib/sell/policies/preflight.js";
import { createLeaderModePolicy } from "../lib/sell/policies/leaderMode.js";
import { createUrgentSellPolicy } from "../lib/sell/policies/urgent.js";
import { createRugPumpDropPolicy } from "../lib/sell/policies/rugPumpDrop.js";
import { createEarlyFadePolicy } from "../lib/sell/policies/earlyFade.js";
import { createObserverPolicy } from "../lib/sell/policies/observer.js";
import { createObserverThreePolicy } from "../lib/sell/policies/observerThree.js";
import { createWarmingPolicyHook } from "../lib/sell/policies/warmingHook.js";
import { createVolatilityGuardPolicy } from "../lib/sell/policies/volatilityGuard.js";
import { createQuoteAndEdgePolicy } from "../lib/sell/policies/quoteAndEdge.js";
import { createFastExitPolicy } from "../lib/sell/policies/fastExit.js";
import { createDynamicHardStopPolicy } from "../lib/sell/policies/dynamicHardStop.js";
import { createProfitLockPolicy } from "../lib/sell/policies/profitLock.js";
import { createFallbackSellPolicy } from "../lib/sell/policies/fallbackSell.js";
import { createForceFlagDecisionPolicy } from "../lib/sell/policies/forceFlagDecision.js";
import { createReboundGatePolicy } from "../lib/sell/policies/reboundGate.js";
import { createExecuteSellDecisionPolicy } from "../lib/sell/policies/executeSellDecision.js";

import {
	PNL_TARGET_DEFAULT_UNDERPERF_MULT,
	PNL_TARGET_DEFAULT_UNDERPERF_PNL_PCT,
	coercePnlTargetUnderperformTuning,
	createProfitTargetGetter,
} from "../lib/pnl/profitTarget.js";

import {
	PNL_FADE_DEFAULTS,
	coercePnlFadeState,
	createPnlFadeExitPolicy,
	pushPnlFadeSample,
} from "../lib/sell/policies/pnlFadeExit.js";

import { loadSplToken } from "../../../../core/solana/splToken.js";

const SNIPER_LS_KEY = "fdv_sniper_bot_v1";
const AUTO_LS_KEY = "fdv_auto_bot_v1"; 

const MAX_LOG_ENTRIES = 120;

const MIN_PROFIT_FOR_PLATFORM_FEE_PCT = 1;

// Mirror Hold's default: use the same rug severity threshold as force-sell.
// If a mint is flagged rugged at/above this threshold, Sniper will not submit buys.
const SNIPER_RUG_BUY_BLOCK_SEV_THRESHOLD = clamp(safeNum(RUG_FORCE_SELL_SEVERITY, 1), 1, 4);

const MOMENTUM_GUARD_SECS = 45;
const MOMENTUM_PLUMMET_CONSEC = 2;
const MOMENTUM_PLUMMET_CHG5M_PCT = -35;
const MOMENTUM_PLUMMET_SC_SLOPE = -6; // /min
const MOMENTUM_PLUMMET_CHG_SLOPE = -20; // /min

const SENTRY_TOP_N = 5;
const SENTRY_SWITCH_COOLDOWN_MS = 6500;
const SENTRY_PREFETCH_MAX_AGE_MS = 1400;
const SENTRY_LOG_EVERY_MS = 2200;
const SENTRY_LOG_PREFETCH_EVERY_MS = 1600;

const FLAME_SWITCH_COOLDOWN_MS = 6500;

// When holding a position in Flame mode, keep watching the Flamebar leader.
// Rotate to the leader by default (after stability/viability checks),
// unless the currently held mint is healthy + profitable.
const FLAME_ROTATE_COOLDOWN_MS = 25_000;
const FLAME_SWITCH_MIN_CONSEC_TICKS = 3;
const FLAME_SWITCH_SCORE_MARGIN = 1.25;
const FLAME_SWITCH_EXTRA_SC_SLOPE = 0.25;
const FLAME_SWITCH_QUEUE_TTL_MS = 30_000;
const FLAME_SWITCH_SAMPLE_MIN_MS = 1600;

const FLAME_HOLD_MIN_PROFIT_PCT = 2.5;
const FLAME_HOLD_MAX_PNL_AGE_MS = 22_000;
const FLAME_HOLD_MIN_SC_SLOPE = 0.1;

function _isNodeLike() {
	return isNodeLike();
}

function now() {
	return Date.now();
}

// withTimeout imported from ../lib/async.js

let logEl;
let statusEl;
let startBtn;
let stopBtn;
let mintEl;
let sentryEl;
let flameEl;
let pollEl;
let buyPctEl;
let triggerEl;
let maxProfitEl;

let _timer = null;
let _tickInFlight = false;
let _inFlight = false;
let _runNonce = 0;
let _acceptLogs = true;

let _sentryStickyUntil = 0;
let _sentryTargetMint = "";
let _sentryLastPick = null;
let _sentryLastScanAt = 0;
let _sentryScanInFlight = false;

let _flameStickyUntil = 0;
let _flameTargetMint = "";

let _flameLeaderLast = "";
let _flameLeaderConsec = 0;
let _flameWatchSampleAt = 0;
let _flameRotateCooldownUntil = 0;
let _flameSwitchCheck = null; // { mint, startedAt, promise }
let _flameQueuedMint = "";
let _flameQueuedUntil = 0;

let _sentryPrefetchTimer = null;
let _sentryPrefetchInFlight = false;
let _sentryPrefetchAt = 0;
let _sentryPrefetchRanked = null;

function log(msg, type = "info", force = false) {
	try {
		if (!_acceptLogs && !force) return;
		const line = `[${new Date().toLocaleTimeString()}] ${String(msg ?? "")}`;
		try {
			const wantConsole = !!(typeof window !== "undefined" && window._fdvLogToConsole);
			const nodeLike = typeof process !== "undefined" && !!process?.stdout;
			if ((wantConsole || (nodeLike && !logEl)) && line) {
				if (String(type || "").toLowerCase().startsWith("err")) console.error(line);
				else if (String(type || "").toLowerCase().startsWith("war")) console.warn(line);
				else console.log(line);
			}
		} catch {}
		if (logEl) {
			const div = document.createElement("div");
			div.textContent = line;
			div.className = `fdv-log-line ${type}`;
			logEl.appendChild(div);
			while (logEl.children.length > MAX_LOG_ENTRIES) logEl.removeChild(logEl.firstChild);
			logEl.scrollTop = logEl.scrollHeight;
		}
	} catch {}
}

function logObj(label, obj) {
	try {
		log(`${label}: ${JSON.stringify(obj)}`);
	} catch {
		log(`${label}: (unserializable)`);
	}
}

const estimateRoundtripEdgePct = createRoundtripEdgeEstimator({
	solMint: SOL_MINT,
	quoteGeneric: (...args) => _getDex().quoteGeneric(...args),
	requiredAtaLamportsForSwap,
	platformFeeBps: Number(FDV_PLATFORM_FEE_BPS || 0),
	txFeeEstimateLamports: EDGE_TX_FEE_ESTIMATE_LAMPORTS,
	smallSellFeeFloorSol: SMALL_SELL_FEE_FLOOR,
	log,
	logObj,
});

function sentryVerbose() {
	try {
		return !!(typeof window !== "undefined" && window._fdvSniperSentryVerbose);
	} catch {
		return false;
	}
}

function _shortMint(m) {
	try {
		const s = String(m || "");
		return s ? `${s.slice(0, 4)}…` : "";
	} catch {
		return "";
	}
}

function sentryLog(key, msg, type = "help", everyMs = SENTRY_LOG_EVERY_MS) {
	try {
		if (sentryVerbose()) {
			log(msg, type);
			return;
		}
		traceOnce(`sentry:${key}`, msg, everyMs, type);
	} catch {}
}

function sentryLogCandidates(key, title, list, everyMs = SENTRY_LOG_EVERY_MS) {
	try {
		if (!Array.isArray(list) || !list.length) {
			sentryLog(key, `${title}: (no candidates)`, "help", everyMs);
			return;
		}
		const rows = list
			.slice(0, SENTRY_TOP_N)
			.map((c, i) => {
				const mint = _shortMint(c?.mint);
				const rec = String(c?.rec || "");
				const score = Number(c?.score || 0).toFixed(0);
				const ready = c?.readyFrac != null ? `${Math.round(Number(c.readyFrac) * 100)}%` : "-";
				const trig = c?.trig ? "Y" : "N";
				const sc = Number.isFinite(Number(c?.scSlope)) ? Number(c.scSlope).toFixed(2) : "-";
				const chg = Number.isFinite(Number(c?.chgSlope)) ? Number(c.chgSlope).toFixed(2) : "-";
				return `#${i + 1} ${mint} rec=${rec} score=${score} ready=${ready} trig=${trig} sc=${sc}/m chg=${chg}/m`;
			})
			.join(" | ");
		sentryLog(key, `${title}: ${rows}`, "help", everyMs);
	} catch {}
}

const PNL_TARGET_DEFAULT_START_PCT = 7;
const PNL_TARGET_DEFAULT_FLOOR_PCT = 2;
const PNL_TARGET_DEFAULT_DECAY_PCT = 1;
const PNL_TARGET_DEFAULT_DECAY_WINDOW_MIN = 3;
let state = {
	ledgerKind: "sniper",
	enabled: false,
	mint: "",
	sentryEnabled: false,
	flameEnabled: false,
	pollMs: 1200,
	buyPct: 25,
	slippageBps: 250, // internal (dynamic); not user-controlled
	triggerScoreSlopeMin: 0.6, // per-minute pumpScore slope proxy (from focusMint series)

	// Sniper behavior: hold until profit target; only cut losses early if entry slips.
	slipExitEnabled: true,
	slipExitWindowSecs: MOMENTUM_GUARD_SECS,
	slipExitMinLossPct: 0.75,
	slipExitConsec: MOMENTUM_PLUMMET_CONSEC,
	slipExitChg5mPct: -12,
	slipExitScSlope: -4,
	slipExitChgSlope: -12,

	minHoldSecs: 5,
	observeWindowMs: 8000,
	observeMinSamples: 6,
	observeMinPasses: 4,

	maxHoldSecs: 70,
	coolDownSecsAfterBuy: 3,
	pendingGraceMs: 60_000,
	sellCooldownMs: 30_000,
	dustExitEnabled: false,
	dustMinSolOut: 0.004,
	minNetEdgePct: -5,
	edgeSafetyBufferPct: 0.1,

	observerDropSellAt: 4,
	observerDropMinAgeSecs: 12,
	observerDropConsec: 3,
	observerDropTrailPct: 2.5,
	dynamicHoldEnabled: true,

	rideWarming: true,
	warmingMinProfitPct: 2,
	warmingDecayPctPerMin: 0.45,
	warmingDecayDelaySecs: 20,

	// Profit-target decay: accelerate decay when the current position is underperforming.
	pnlDecayUnderperformMult: PNL_TARGET_DEFAULT_UNDERPERF_MULT,
	pnlDecayUnderperformPnlPct: PNL_TARGET_DEFAULT_UNDERPERF_PNL_PCT,

	// Fade-exit (profit protection): sell if green -> fades down.
	pnlFadeExitEnabled: PNL_FADE_DEFAULTS.enabled,
	pnlFadeMinAgeMs: PNL_FADE_DEFAULTS.minAgeMs,
	pnlFadeMinPeakPct: PNL_FADE_DEFAULTS.minPeakPct,
	pnlFadeMinPositiveNowPct: PNL_FADE_DEFAULTS.minPositiveNowPct,
	pnlFadeMinSamples: PNL_FADE_DEFAULTS.minSamples,
	pnlFadeDowntrendPoints: PNL_FADE_DEFAULTS.downtrendPoints,
	pnlFadeEpsPct: PNL_FADE_DEFAULTS.epsPct,
	pnlFadeDropFromPeakPct: PNL_FADE_DEFAULTS.dropFromPeakPct,
	warmingMinProfitFloorPct: 0.0,
	warmingAutoReleaseSecs: 45,
	warmingMaxLossPct: 8,
	warmingMaxLossWindowSecs: 30,
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

	// PnL target: required profit % to exit, decays over time since entry.
	pnlTargetStartPct: PNL_TARGET_DEFAULT_START_PCT,
	pnlTargetFloorPct: PNL_TARGET_DEFAULT_FLOOR_PCT,
	pnlTargetDecayPct: PNL_TARGET_DEFAULT_DECAY_PCT,
	pnlTargetDecayWindowMin: PNL_TARGET_DEFAULT_DECAY_WINDOW_MIN,
	stopLossPct: 4,
	trailPct: 6,
	minProfitToTrailPct: 2,
	partialTpPct: 50,

	positions: {},
};

function hasAnyActivePosition() {
	try {
		const ps = state.positions && typeof state.positions === "object" ? state.positions : {};
		for (const [mint, pos] of Object.entries(ps)) {
			if (!mint || !pos) continue;
			if (Number(pos.sizeUi || 0) > 0 || pos.awaitingSizeSync === true) return { ok: true, mint };
		}
		return { ok: false, mint: "" };
	} catch {
		return { ok: false, mint: "" };
	}
}

function _isMaybeMintStr(s) {
	try {
		const v = String(s || "").trim();
		return /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(v);
	} catch {
		return false;
	}
}

function _recWeight(rec) {
	const r = String(rec || "").trim().toUpperCase();
	if (r === "GOOD") return 5;
	if (r === "WATCH") return 4;
	if (r === "CONSIDER") return 3;
	if (r === "NEUTRAL") return 2;
	if (r === "AVOID") return 1;
	return 0;
}

function _parseScoreFromCard(cardEl) {
	try {
		const el = cardEl?.querySelector?.(".v-score");
		const t = String(el?.textContent || "").trim();
		const m = t.match(/([0-9]+(?:\.[0-9]+)?)/);
		return m ? clamp(Number(m[1]), 0, 100) : 0;
	} catch {
		return 0;
	}
}

function _parseRecFromCard(cardEl) {
	try {
		const el = cardEl?.querySelector?.(".rec");
		const t = String(el?.textContent || "").trim();
		return t || "";
	} catch {
		return "";
	}
}

function _parseHydrateFromCard(cardEl) {
	try {
		const raw = cardEl?.getAttribute?.("data-token-hydrate") || cardEl?.dataset?.tokenHydrate;
		if (!raw) return null;
		const obj = JSON.parse(raw);
		return obj && typeof obj === "object" ? obj : null;
	} catch {
		return null;
	}
}

function _scanTopCardCandidates(n = SENTRY_TOP_N) {
	try {
		if (typeof document === "undefined") return [];
		let nodes = Array.from(document.querySelectorAll("article.card[data-mint]"));
		if (!nodes.length) nodes = Array.from(document.querySelectorAll(".card[data-mint]"));
		const out = [];
		for (const el of nodes) {
			if (out.length >= n) break;
			const mint = String(el?.getAttribute?.("data-mint") || el?.dataset?.mint || "").trim();
			if (!_isMaybeMintStr(mint)) continue;
			if (isMintBlacklisted(mint) || isPumpDropBanned(mint)) continue;
			const score = _parseScoreFromCard(el);
			const rec = _parseRecFromCard(el);
			const hydrate = _parseHydrateFromCard(el);
			const liqUsd = safeNum(hydrate?.liquidityUsd, 0);
			const v24h = safeNum(hydrate?.v24hTotal, 0);
			const rw = _recWeight(rec);
			const liqScore = Math.log10(Math.max(1, liqUsd + 1));
			const vScore = Math.log10(Math.max(1, v24h + 1));
			const rank = rw * 1e9 + score * 1e6 + liqScore * 1e4 + vScore * 1e3;
			out.push({ mint, rec, score, liqUsd, v24h, rank });
		}
		return out;
	} catch {
		return [];
	}
}


function _sentryRankWithLiveSignal(mint, base = null) {
	try {
		const obs = getObservationStatus(mint);
		const trig = shouldTriggerBuy(mint);
		const series3 = getLeaderSeries(mint, 3);
		const last = series3?.[series3.length - 1] || {};
		const chgSlope = clamp(slope3pm(series3 || [], "chg5m"), -60, 60);
		const scSlope = clamp(slope3pm(series3 || [], "pumpScore"), -20, 20);
		const rw = _recWeight(base?.rec);
		const uiScore = clamp(Number(base?.score || 0), 0, 100);
		const liqScore = Math.log10(Math.max(1, Number(base?.liqUsd || 0) + 1));
		const vScore = Math.log10(Math.max(1, Number(base?.v24h || 0) + 1));
		const baseRank = rw * 1e9 + uiScore * 1e6 + liqScore * 1e4 + vScore * 1e3;
		const readyFrac = obs?.ok ? 1 : clamp((Number(obs?.haveN || 0) / Math.max(1, Number(obs?.needN || 1))) * 0.7 + (Number(obs?.spanMs || 0) / Math.max(1, Number(obs?.needMs || 1))) * 0.3, 0, 1);
		const lastBonus = clamp(Number(last?.pumpScore || 0), 0, 10) * 1e2 + clamp(Number(last?.chg5m || 0), -60, 60) * 2;
		const slopeBonus = (scSlope * 180 + chgSlope * 8);
		const triggerBoost = trig ? 2e12 : 0;
		const readyBoost = readyFrac * 5e11;
		return {
			mint,
			rec: String(base?.rec || ""),
			score: Number(base?.score || 0),
			liqUsd: Number(base?.liqUsd || 0),
			v24h: Number(base?.v24h || 0),
			readyFrac,
			trig,
			chgSlope,
			scSlope,
			rank: triggerBoost + readyBoost + baseRank + lastBonus * 1e6 + slopeBonus * 1e7,
		};
	} catch {
		return { mint, rank: Number(base?.rank || 0), ...base };
	}
}

async function pickSentryMintAsync() {
	try {
		const t = now();
		if (_sentryTargetMint && t < _sentryStickyUntil) return _sentryTargetMint;

		// prevent overlapping scans if tick is aggressive
		if (_sentryScanInFlight) return _sentryTargetMint || "";
		_sentryScanInFlight = true;
		try {
			// light throttle to avoid network spam; still parallel within each scan
			if (t - _sentryLastScanAt < Math.max(350, Math.min(1200, Number(state.pollMs || 1200)))) {
				return _sentryTargetMint || "";
			}
			_sentryLastScanAt = t;

			const cands = _scanTopCardCandidates(SENTRY_TOP_N);
			if (!cands.length) return "";
			sentryLogCandidates("scan", "Sentry scan (async) candidates", cands, 1200);

			// Refresh focus/signal for all candidates concurrently
			const started = now();
			const settled = await Promise.allSettled(
				cands.map(async (c) => ({ mint: c.mint, ok: !!(await snapshotFocus(c.mint)) })),
			);
			const dt = now() - started;
			try {
				const okN = settled.filter((r) => r.status === "fulfilled" && r.value?.ok).length;
				sentryLog("scan:focus", `Sentry scan (async) focus refresh: ok=${okN}/${cands.length} dt=${dt}ms`, "help", 1200);
			} catch {}

			const ranked = cands.map((c) => _sentryRankWithLiveSignal(c.mint, c));
			ranked.sort((a, b) => (b.rank || 0) - (a.rank || 0));
			const best = ranked[0];
			sentryLogCandidates("scan:rank", "Sentry scan (async) ranked", ranked, 1200);
			if (!best?.mint) return "";
			_sentryTargetMint = best.mint;
			_sentryStickyUntil = t + SENTRY_SWITCH_COOLDOWN_MS;
			_sentryLastPick = best;
			return best.mint;
		} finally {
			_sentryScanInFlight = false;
		}
	} catch {
		_sentryScanInFlight = false;
		return "";
	}
}

function _sentryPrefetchIntervalMs() {
	try {
		const p = Number(state.pollMs || 1200);
		return Math.floor(clamp(p * 0.5, 300, 1100));
	} catch {
		return 650;
	}
}

function _canRunSentryPrefetch() {
	try {
		if (typeof document === "undefined") return false;
		if (!state?.enabled || !state?.sentryEnabled) return false;
		if (_inFlight) return false;
		const active = hasAnyActivePosition();
		if (active.ok) return false;
		return true;
	} catch {
		return false;
	}
}

async function _sentryPrefetchOnce() {
	if (!_canRunSentryPrefetch()) return;
	if (_sentryPrefetchInFlight) return;
	_sentryPrefetchInFlight = true;
	try {
		const cands = _scanTopCardCandidates(SENTRY_TOP_N);
		if (!cands.length) {
			sentryLog("prefetch:none", "Sentry prefetch: no candidates", "help", SENTRY_LOG_PREFETCH_EVERY_MS);
			return;
		}
		sentryLogCandidates("prefetch:cands", "Sentry prefetch candidates", cands, SENTRY_LOG_PREFETCH_EVERY_MS);
		const started = now();
		const settled = await Promise.allSettled(
			cands.map(async (c) => ({ mint: c.mint, ok: !!(await snapshotFocus(c.mint)) })),
		);
		const dt = now() - started;
		try {
			const okN = settled.filter((r) => r.status === "fulfilled" && r.value?.ok).length;
			sentryLog("prefetch:focus", `Sentry prefetch focus refresh: ok=${okN}/${cands.length} dt=${dt}ms`, "help", SENTRY_LOG_PREFETCH_EVERY_MS);
		} catch {}
		const ranked = cands.map((c) => _sentryRankWithLiveSignal(c.mint, c));
		ranked.sort((a, b) => (b.rank || 0) - (a.rank || 0));
		_sentryPrefetchRanked = ranked;
		_sentryPrefetchAt = now();
		sentryLogCandidates("prefetch:rank", "Sentry prefetch ranked", ranked, SENTRY_LOG_PREFETCH_EVERY_MS);
	} catch {
	} finally {
		_sentryPrefetchInFlight = false;
	}
}

function startSentryPrefetch() {
	try {
		if (_sentryPrefetchTimer) return;
		if (typeof document === "undefined") return;
		const ms = _sentryPrefetchIntervalMs();
		_sentryPrefetchTimer = setInterval(() => void _sentryPrefetchOnce(), ms);
		sentryLog("prefetch:start", `Sentry prefetch started (interval=${ms}ms)`, "ok", 2500);
		void _sentryPrefetchOnce();
	} catch {}
}

function stopSentryPrefetch() {
	try {
		if (_sentryPrefetchTimer) clearInterval(_sentryPrefetchTimer);
	} catch {}
	_sentryPrefetchTimer = null;
	_sentryPrefetchInFlight = false;
	sentryLog("prefetch:stop", "Sentry prefetch stopped", "warn", 2500);
}

function pickSentryMintFast() {
	try {
		const t = now();
		if (_sentryTargetMint && t < _sentryStickyUntil) return _sentryTargetMint;
		if (_sentryPrefetchRanked && t - Number(_sentryPrefetchAt || 0) <= SENTRY_PREFETCH_MAX_AGE_MS) {
			const best = _sentryPrefetchRanked[0];
			if (best?.mint) {
				sentryLog(
					"pick:cache",
					`Sentry pick (cache): best=${_shortMint(best.mint)} age=${Math.max(0, t - Number(_sentryPrefetchAt || 0))}ms trig=${best?.trig ? "Y" : "N"} ready=${Math.round(Number(best?.readyFrac || 0) * 100)}%`,
					"help",
					900,
				);
				_sentryTargetMint = best.mint;
				_sentryStickyUntil = t + SENTRY_SWITCH_COOLDOWN_MS;
				_sentryLastPick = best;
				return best.mint;
			}
		}
		sentryLog(
			"pick:miss",
			`Sentry pick: cache miss/stale (age=${Math.max(0, t - Number(_sentryPrefetchAt || 0))}ms)` ,
			"help",
			1400,
		);
		return "";
	} catch {
		return "";
	}
}

function pickFlameMintFast() {
	try {
		const t = now();
		if (_flameTargetMint && t < _flameStickyUntil) return _flameTargetMint;

		if (!isFlamebarPumpingNow()) return "";

		let m = "";
		try {
			m = String(window?.__fdvFlamebar?.getLeaderMint?.() || "").trim();
		} catch {
			m = "";
		}

		if (!_isMaybeMintStr(m)) return "";
		_flameTargetMint = m;
		// Follow Flamebar leader reasonably quickly when idle (but avoid thrash).
		const stickMs = (() => {
			try {
				const p = Number(state?.pollMs || 1200);
				return Math.floor(clamp(p * 1.2, 900, FLAME_SWITCH_COOLDOWN_MS));
			} catch {
				return FLAME_SWITCH_COOLDOWN_MS;
			}
		})();
		_flameStickyUntil = t + stickMs;
		return m;
	} catch {
		return "";
	}
}

function isFlamebarPumpingNow() {
	try {
		const fb = window?.__fdvFlamebar;
		if (fb && typeof fb.isPumping === "function") return !!fb.isPumping();
		if (fb && typeof fb.getLeaderMode === "function") return String(fb.getLeaderMode() || "") === "pump";
		// DOM fallback: flamebar sets `.fdv-flamebar-card.is-pumping` when 🔥 is shown.
		const el = typeof document !== "undefined" ? document.querySelector(".fdv-flamebar-card") : null;
		return !!el?.classList?.contains?.("is-pumping");
	} catch {
		return false;
	}
}

function getFlameLeaderMintNow() {
	try {
		if (!isFlamebarPumpingNow()) return "";
		const m = String(window?.__fdvFlamebar?.getLeaderMint?.() || "").trim();
		return _isMaybeMintStr(m) ? m : "";
	} catch {
		return "";
	}
}

function _queueFlameMint(mint, ttlMs = FLAME_SWITCH_QUEUE_TTL_MS) {
	try {
		const m = String(mint || "").trim();
		if (!_isMaybeMintStr(m)) return;
		_flameQueuedMint = m;
		_flameQueuedUntil = now() + Math.max(2500, Number(ttlMs || 0));
	} catch {}
}

function _takeQueuedFlameMint() {
	try {
		if (!_flameQueuedMint) return "";
		if (now() > Number(_flameQueuedUntil || 0)) {
			_flameQueuedMint = "";
			_flameQueuedUntil = 0;
			return "";
		}
		const m = _flameQueuedMint;
		_flameQueuedMint = "";
		_flameQueuedUntil = 0;
		return m;
	} catch {
		return "";
	}
}

function _getLiveSignalForMint(mint) {
	try {
		const m = String(mint || "").trim();
		const obs = getObservationStatus(m);
		const series3 = getLeaderSeries(m, 3) || [];
		const last = series3?.[series3.length - 1] || {};
		const chgSlope = clamp(slope3pm(series3, "chg5m"), -60, 60);
		const scSlope = clamp(slope3pm(series3, "pumpScore"), -20, 20);
		const badgeNorm = normBadge(getRugSignalForMint(m)?.badge);
		const trig = shouldTriggerBuy(m);
		const liqUsd = safeNum(last?.liqUsd, 0);
		const v1h = safeNum(last?.v1h, 0);
		const chg5m = safeNum(last?.chg5m, 0);
		const pumpScore = safeNum(last?.pumpScore, 0);
		// A lightweight combined score; tuned for relative comparisons only.
		const score =
			clamp(pumpScore, 0, 10) * 1.0 +
			clamp(scSlope, -20, 20) * 2.2 +
			clamp(chgSlope, -60, 60) * 0.35 +
			clamp(chg5m, -99, 99) * 0.08 +
			Math.log10(Math.max(1, v1h + 1)) * 0.55 +
			Math.log10(Math.max(1, liqUsd + 1)) * 0.25;

		return {
			ok: true,
			mint: m,
			obsOk: !!obs?.ok,
			badgeNorm,
			trig,
			chgSlope,
			scSlope,
			last: { liqUsd, v1h, chg5m, pumpScore },
			score,
		};
	} catch {
		return { ok: false, mint: String(mint || "").trim(), score: 0 };
	}
}

function _isTrulyPerformingForSwitch(sig) {
	try {
		if (!sig?.ok) return false;
		if (!sig.obsOk) return false;
		if (!sig.trig) return false;
		// Extra strictness vs initial buy trigger.
		const thr = Math.max(0, Number(state.triggerScoreSlopeMin || 0.6));
		if (!(Number(sig.scSlope || 0) >= (thr + FLAME_SWITCH_EXTRA_SC_SLOPE))) return false;
		if (!(Number(sig.last?.chg5m || 0) > 0)) return false;
		if (!(Number(sig.last?.liqUsd || 0) >= 6000)) return false;
		if (!(Number(sig.last?.v1h || 0) >= 1500)) return false;
		// Badge should be in a hot state.
		if (!(sig.badgeNorm === "pumping" || (state.rideWarming && sig.badgeNorm === "warming"))) return false;
		return true;
	} catch {
		return false;
	}
}

function _shouldRotateToBetterMint({ heldSig, leaderSig } = {}) {
	try {
		if (!heldSig?.ok || !leaderSig?.ok) return false;
		const margin = Number.isFinite(Number(state.flameSwitchScoreMargin))
			? Number(state.flameSwitchScoreMargin)
			: FLAME_SWITCH_SCORE_MARGIN;

		// Require a real gap, not a tiny oscillation.
		return Number(leaderSig.score || 0) >= Number(heldSig.score || 0) + margin;
	} catch {
		return false;
	}
}

function _isHeldHealthyAndProfitable({ pos, heldSig, nowTs } = {}) {
	try {
		if (!pos || !heldSig?.ok) return false;
		const t = Number(nowTs || now());
		const pnl = Number(pos._lastPnlNetPct);
		const pnlAt = Number(pos._lastPnlAt || 0);
		if (!Number.isFinite(pnl) || pnlAt <= 0) return false;
		if (t - pnlAt > FLAME_HOLD_MAX_PNL_AGE_MS) return false;
		if (!(pnl >= FLAME_HOLD_MIN_PROFIT_PCT)) return false;

		if (!heldSig.obsOk) return false;
		if (!(Number(heldSig.last?.chg5m || 0) > 0)) return false;
		if (!(Number(heldSig.scSlope || 0) >= FLAME_HOLD_MIN_SC_SLOPE)) return false;
		if (!(heldSig.badgeNorm === "pumping" || (state.rideWarming && heldSig.badgeNorm === "warming"))) return false;

		const rug = getRugSignalForMint(String(heldSig.mint || "").trim());
		const sev = Number(rug?.sev || 0);
		if (Number.isFinite(sev) && sev >= Number(RUG_FORCE_SELL_SEVERITY || 0.7)) return false;
		if (rug?.rugged) return false;

		return true;
	} catch {
		return false;
	}
}

function loadState() {
	try {
		if (typeof localStorage === "undefined") return;
		const raw = localStorage.getItem(SNIPER_LS_KEY);
		if (!raw) return;
		const obj = JSON.parse(raw);
		if (obj && typeof obj === "object") {
			state = { ...state, ...obj };
			if (state.sentryEnabled && state.flameEnabled) state.flameEnabled = false;
			if (!state.positions || typeof state.positions !== "object") state.positions = {};
			state.slippageBps = 250;

			if (!Number.isFinite(Number(state.pnlTargetStartPct))) {
				const legacy = Number(state.takeProfitPct ?? state.maxProfitPct);
				state.pnlTargetStartPct = Number.isFinite(legacy) ? legacy : PNL_TARGET_DEFAULT_START_PCT;
			}
			state.pnlTargetFloorPct = clamp(Number(state.pnlTargetFloorPct ?? PNL_TARGET_DEFAULT_FLOOR_PCT), 0, 50);
			state.pnlTargetStartPct = clamp(
				Number(state.pnlTargetStartPct ?? PNL_TARGET_DEFAULT_START_PCT),
				Number(state.pnlTargetFloorPct ?? PNL_TARGET_DEFAULT_FLOOR_PCT),
				50,
			);
			state.pnlTargetDecayPct = clamp(Number(state.pnlTargetDecayPct ?? PNL_TARGET_DEFAULT_DECAY_PCT), 0, 50);
			state.pnlTargetDecayWindowMin = clamp(Number(state.pnlTargetDecayWindowMin ?? PNL_TARGET_DEFAULT_DECAY_WINDOW_MIN), 1, 240);

			coercePnlTargetUnderperformTuning(state, clamp);
			coercePnlFadeState(state, clamp);

			state.warmingMinProfitPct = clamp(Number(state.warmingMinProfitPct ?? 2), 0, 50);
			state.warmingMinProfitFloorPct = clamp(Number(state.warmingMinProfitFloorPct ?? 0), 0, 50);
		}
	} catch {}
}

const DYN_SLIP_MIN_BPS = 50;
const DYN_SLIP_MAX_BPS = 2500;

function getDynamicSlippageBps(kind = "buy") {
	try {
		const base = kind === "sell" ? 300 : 250;
		let slip = base;

		try {
			const backoffMs = Number(rpcBackoffLeft?.() || 0);
			if (backoffMs > 0) slip += Math.min(800, Math.floor(backoffMs / 2000) * 100);
		} catch {}

		return Math.floor(clamp(slip, DYN_SLIP_MIN_BPS, DYN_SLIP_MAX_BPS));
	} catch {
		return 250;
	}
}

const getProfitTargetPct = createProfitTargetGetter({
	getState: () => state,
	clamp,
	defaults: {
		startPct: PNL_TARGET_DEFAULT_START_PCT,
		floorPct: PNL_TARGET_DEFAULT_FLOOR_PCT,
		decayPct: PNL_TARGET_DEFAULT_DECAY_PCT,
		decayWindowMin: PNL_TARGET_DEFAULT_DECAY_WINDOW_MIN,
	},
});

function _isHardExitDecision(decision, ctx = null) {
	try {
		if (!decision || typeof decision !== "object") return false;
		if (decision.hardStop) return true;
		if (ctx?.forceRug) return true;
		const reason = String(decision.reason || "");
		return /\brug\b|HARD_STOP|FAST_HARD_STOP|\bSL\b|urgent|max-hold/i.test(reason);
	} catch {
		return false;
	}
}

function _isAlwaysAllowSellDecision(decision, ctx = null) {
	try {
		if (!decision || typeof decision !== "object") return false;
		if (ctx?.forceRug) return true;
		const reason = String(decision.reason || "");
		return /\brug\b|urgent|max-hold/i.test(reason);
	} catch {
		return false;
	}
}

function getMomentumPlummetSignal(mint, pos, nowTs) {
	try {
		const needConsec = Math.max(1, Number(state.slipExitConsec ?? MOMENTUM_PLUMMET_CONSEC));
		const thrChg5m = Number(state.slipExitChg5mPct ?? MOMENTUM_PLUMMET_CHG5M_PCT);
		const thrScSlope = Number(state.slipExitScSlope ?? MOMENTUM_PLUMMET_SC_SLOPE);
		const thrChgSlope = Number(state.slipExitChgSlope ?? MOMENTUM_PLUMMET_CHG_SLOPE);

		const series3 = getLeaderSeries(mint, 3);
		const last = series3?.[series3.length - 1] || {};
		const chg5m = clamp(Number(last?.chg5m || 0), -99, 99);
		const chgSlope = clamp(slope3pm(series3 || [], "chg5m"), -60, 60);
		const scSlope = clamp(slope3pm(series3 || [], "pumpScore"), -20, 20);
		const badgeNorm = normBadge(getRugSignalForMint(mint)?.badge);

		const rawPlummet =
			(chg5m <= thrChg5m) ||
			(scSlope <= thrScSlope) ||
			(chgSlope <= thrChgSlope) ||
			(badgeNorm === "calm" && chgSlope < -10 && scSlope < -2);

		const prev = Number(pos?._momPlummetConsec || 0);
		const consec = rawPlummet ? Math.min(10, prev + 1) : 0;
		pos._momPlummetConsec = consec;

		return {
			ok: consec >= needConsec,
			rawPlummet,
			consec,
			chg5m,
			chgSlope,
			scSlope,
			badgeNorm,
			reason: `SLIP_EXIT c=${consec}/${needConsec} chg5m=${chg5m.toFixed(1)}% chgSlope=${chgSlope.toFixed(1)}/m scSlope=${scSlope.toFixed(1)}/m badge=${badgeNorm}`,
		};
	} catch {
		return { ok: false, rawPlummet: false, consec: 0, reason: "MOMENTUM_PLUMMET (err)" };
	}
}

function momentumLossGuardPolicy(ctx) {
	try {
		if (!ctx || typeof ctx !== "object") return;
		const pos = ctx.pos;
		if (!pos) return;
		if (String(pos.entryMode || "") !== "momentum") return;
		if (!state.slipExitEnabled) return;
		if (ctx.forceRug) return;

		const nowTs = Number(ctx.nowTs || now());
		const ageSec = (nowTs - Number(pos.lastBuyAt || pos.acquiredAt || 0)) / 1000;
		const guardSecs = Math.max(0, Number(state.slipExitWindowSecs ?? MOMENTUM_GUARD_SECS));
		if (!(ageSec >= 0 && ageSec <= guardSecs)) return;

		const pnl = Number.isFinite(Number(ctx.pnlNetPct)) ? Number(ctx.pnlNetPct) : Number(ctx.pnlPct);
		// Only guard loss-side sells; allow normal profit-taking.
		if (!(Number.isFinite(pnl) && pnl < 0)) return;

		const minLoss = Math.max(0, Number(state.slipExitMinLossPct ?? 0));
		if (minLoss > 0 && pnl > -minLoss) return;

		const decision = ctx.decision;
		if (!decision) {
			const sig0 = getMomentumPlummetSignal(ctx.mint, pos, nowTs);
			if (sig0.ok) ctx.decision = { action: "sell_all", reason: sig0.reason, hardStop: true };
			return;
		}
		const action = String(decision.action || "");
		if (!/sell/i.test(action)) return;
		if (_isAlwaysAllowSellDecision(decision, ctx)) return;

		const sig = getMomentumPlummetSignal(ctx.mint, pos, nowTs);
		if (!sig.ok) {
			traceOnce(
				`sniper:mom:veto:${ctx.mint}`,
				`Slip-exit guard: holding ${ctx.mint.slice(0, 4)}… pnl=${Number(pnl).toFixed(2)}% age=${ageSec.toFixed(1)}s decision=${String(decision.reason || action)} (waiting for slip confirm)`,
				2200,
				"help",
			);
			ctx.decision = null;
			ctx.stop = false;
		}
	} catch {}
}

function profitFloorGatePolicy(ctx) {
	try {
		if (!ctx || typeof ctx !== "object") return;
		const decision = ctx.decision;
		if (!decision || typeof decision !== "object") return;
		const action = String(decision.action || "");
		if (!/sell/i.test(action)) return;
		if (ctx.forceRug) return;
		if (_isHardExitDecision(decision, ctx)) return;
		if (_isAlwaysAllowSellDecision(decision, ctx)) return;
		const reason = String(decision.reason || "");
		if (/\bmax-hold\b/i.test(reason)) return;

		const floor = Math.max(0, Number(state.warmingMinProfitFloorPct ?? 0));
		if (!(floor > 0)) {
			// Default behavior: hold until at least break-even.
			const pnl0 = Number.isFinite(Number(ctx.pnlNetPct)) ? Number(ctx.pnlNetPct) : Number(ctx.pnlPct);
			if (Number.isFinite(pnl0) && pnl0 < 0) {
				ctx.decision = { action: "none", reason: "profit-floor" };
				ctx.stop = false;
			}
			return;
		}

		const pnl = Number.isFinite(Number(ctx.pnlNetPct)) ? Number(ctx.pnlNetPct) : Number(ctx.pnlPct);
		if (Number.isFinite(pnl) && pnl < floor) {
			ctx.decision = { action: "none", reason: "profit-floor" };
			ctx.stop = false;
		}
	} catch {}
}

function saveState() {
	try {
		if (typeof localStorage === "undefined") return;
		localStorage.setItem(
			SNIPER_LS_KEY,
			JSON.stringify({
				enabled: !!state.enabled,
				mint: String(state.mint || "").trim(),
				sentryEnabled: !!state.sentryEnabled,
				flameEnabled: !!state.flameEnabled,
				pollMs: Number(state.pollMs || 1200),
				buyPct: Number(state.buyPct || 25),
				triggerScoreSlopeMin: Number(state.triggerScoreSlopeMin || 0.6),
				slipExitEnabled: !!state.slipExitEnabled,
				slipExitWindowSecs: Number(state.slipExitWindowSecs ?? MOMENTUM_GUARD_SECS),
				slipExitMinLossPct: Number(state.slipExitMinLossPct ?? 0.75),
				slipExitConsec: Number(state.slipExitConsec ?? MOMENTUM_PLUMMET_CONSEC),
				slipExitChg5mPct: Number(state.slipExitChg5mPct ?? -12),
				slipExitScSlope: Number(state.slipExitScSlope ?? -4),
				slipExitChgSlope: Number(state.slipExitChgSlope ?? -12),
				minHoldSecs: Number(state.minHoldSecs ?? 5),
				observeWindowMs: Number(state.observeWindowMs ?? 8000),
				observeMinSamples: Number(state.observeMinSamples ?? 6),
				observeMinPasses: Number(state.observeMinPasses ?? 4),
				maxHoldSecs: Number(state.maxHoldSecs || 0),
				coolDownSecsAfterBuy: Number(state.coolDownSecsAfterBuy || 0),
				pendingGraceMs: Number(state.pendingGraceMs || 0),
				sellCooldownMs: Number(state.sellCooldownMs || 0),
				dustExitEnabled: !!state.dustExitEnabled,
				dustMinSolOut: Number(state.dustMinSolOut || 0),
				minNetEdgePct: Number(state.minNetEdgePct ?? -5),
				edgeSafetyBufferPct: Number(state.edgeSafetyBufferPct ?? 0.1),
				observerDropSellAt: Number(state.observerDropSellAt ?? 4),
				observerDropMinAgeSecs: Number(state.observerDropMinAgeSecs ?? 12),
				observerDropConsec: Number(state.observerDropConsec ?? 3),
				observerDropTrailPct: Number(state.observerDropTrailPct ?? 2.5),
				dynamicHoldEnabled: !!state.dynamicHoldEnabled,
				rideWarming: !!state.rideWarming,
				warmingMinProfitPct: Number(state.warmingMinProfitPct ?? 2),
				warmingDecayPctPerMin: Number(state.warmingDecayPctPerMin ?? 0.45),
				warmingDecayDelaySecs: Number(state.warmingDecayDelaySecs ?? 20),
				warmingMinProfitFloorPct: Number(state.warmingMinProfitFloorPct ?? 0),
				warmingAutoReleaseSecs: Number(state.warmingAutoReleaseSecs ?? 45),
				warmingMaxLossPct: Number(state.warmingMaxLossPct ?? 8),
				warmingMaxLossWindowSecs: Number(state.warmingMaxLossWindowSecs ?? 30),
				warmingNoHardStopSecs: Number(state.warmingNoHardStopSecs ?? 35),
				reboundGateEnabled: !!state.reboundGateEnabled,
				reboundLookbackSecs: Number(state.reboundLookbackSecs ?? 35),
				reboundMaxDeferSecs: Number(state.reboundMaxDeferSecs ?? 12),
				reboundHoldMs: Number(state.reboundHoldMs ?? 6000),
				reboundMinScore: Number(state.reboundMinScore ?? 0.45),
				reboundMinChgSlope: Number(state.reboundMinChgSlope ?? 10),
				reboundMinScSlope: Number(state.reboundMinScSlope ?? 7),
				reboundMinPnLPct: Number(state.reboundMinPnLPct ?? -2),
				fastExitEnabled: !!state.fastExitEnabled,
				fastExitSlipBps: Number(state.fastExitSlipBps ?? 400),
				fastExitConfirmMs: Number(state.fastExitConfirmMs ?? 9000),
				fastHardStopPct: Number(state.fastHardStopPct ?? 2.5),
				fastTrailPct: Number(state.fastTrailPct ?? 8),
				fastTrailArmPct: Number(state.fastTrailArmPct ?? 5),
				fastNoHighTimeoutSec: Number(state.fastNoHighTimeoutSec ?? 90),
				fastTp1Pct: Number(state.fastTp1Pct ?? 10),
				fastTp1SellPct: Number(state.fastTp1SellPct ?? 30),
				fastTp2Pct: Number(state.fastTp2Pct ?? 20),
				fastTp2SellPct: Number(state.fastTp2SellPct ?? 30),
				pnlTargetStartPct: Number(state.pnlTargetStartPct ?? PNL_TARGET_DEFAULT_START_PCT),
				pnlTargetFloorPct: Number(state.pnlTargetFloorPct ?? PNL_TARGET_DEFAULT_FLOOR_PCT),
				pnlTargetDecayPct: Number(state.pnlTargetDecayPct ?? PNL_TARGET_DEFAULT_DECAY_PCT),
				pnlTargetDecayWindowMin: Number(state.pnlTargetDecayWindowMin ?? PNL_TARGET_DEFAULT_DECAY_WINDOW_MIN),
				stopLossPct: Number(state.stopLossPct ?? 4),
				trailPct: Number(state.trailPct ?? 6),
				minProfitToTrailPct: Number(state.minProfitToTrailPct ?? 2),
				partialTpPct: Number(state.partialTpPct ?? 50),
				positions: state.positions && typeof state.positions === "object" ? state.positions : {},
			}),
		);
	} catch {}
}

const { loadWeb3, loadBs58 } = createSolanaDepsLoader({
	cacheKeyPrefix: "fdv:sniper",
	web3Version: "1.95.4",
	bs58Version: "6.0.0",
});

function currentRpcUrl() {
	try {
		const fromLs = typeof localStorage !== "undefined" ? String(localStorage.getItem("fdv_rpc_url") || "") : "";
		return (fromLs || "https://api.mainnet-beta.solana.com").trim();
	} catch {
		return "https://api.mainnet-beta.solana.com";
	}
}

function currentRpcHeaders() {
	try {
		const raw = typeof localStorage !== "undefined" ? String(localStorage.getItem("fdv_rpc_headers") || "") : "";
		if (!raw) return undefined;
		const obj = JSON.parse(raw);
		if (!obj || typeof obj !== "object") return undefined;
		return obj;
	} catch {
		return undefined;
	}
}

const getConn = createConnectionGetter({
	loadWeb3,
	getRpcUrl: currentRpcUrl,
	getRpcHeaders: currentRpcHeaders,
	commitment: "confirmed",
});

const confirmSig = createConfirmSig({
	getConn,
	markRpcStress,
	defaultCommitment: "confirmed",
	defaultTimeoutMs: 20_000,
	throwOnTimeout: false,
});

async function tokenAccountRentLamports(len = 165) {
	try {
		const conn = await getConn();
		return await conn.getMinimumBalanceForRentExemption(Number(len || 165));
	} catch {
		return 0;
	}
}

async function _detectTokenProgramIdForMint(mintStr) {
	try {
		const { PublicKey } = await loadWeb3();
		const { TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID } = await loadSplToken();
		const conn = await getConn();
		const mintPk = new PublicKey(mintStr);
		const info = await withTimeout(conn.getAccountInfo(mintPk, "processed"), 10_000, { label: "getAccountInfo" }).catch((e) => {
			markRpcStress?.(e, 1500);
			return null;
		});
		const owner = info?.owner;
		if (owner && TOKEN_2022_PROGRAM_ID && owner.equals && owner.equals(TOKEN_2022_PROGRAM_ID)) return TOKEN_2022_PROGRAM_ID;
		if (owner && TOKEN_PROGRAM_ID && owner.equals && owner.equals(TOKEN_PROGRAM_ID)) return TOKEN_PROGRAM_ID;
		return TOKEN_PROGRAM_ID;
	} catch {
		const { TOKEN_PROGRAM_ID } = await loadSplToken();
		return TOKEN_PROGRAM_ID;
	}
}

async function _tokenAccountRentLamportsForMint(mintStr) {
	try {
		const { TOKEN_2022_PROGRAM_ID } = await loadSplToken();
		const pid = await _detectTokenProgramIdForMint(mintStr);
		// Token-2022 accounts can include extensions; over-reserve.
		const bytes = (pid && TOKEN_2022_PROGRAM_ID && pid.equals && pid.equals(TOKEN_2022_PROGRAM_ID)) ? 250 : 165;
		return await tokenAccountRentLamports(bytes);
	} catch {
		return await tokenAccountRentLamports(200);
	}
}

async function requiredAtaLamportsForSwap(ownerStr, _inMint, outMint) {
	try {
		if (!ownerStr || !outMint || outMint === SOL_MINT) return 0;
		const { PublicKey } = await loadWeb3();
		const { getAssociatedTokenAddress } = await loadSplToken();
		const conn = await getConn();
		const owner = new PublicKey(ownerStr);
		const mint = new PublicKey(outMint);
		const pid = await _detectTokenProgramIdForMint(outMint);
		const ata = await getAssociatedTokenAddress(mint, owner, true, pid);
		const info = await withTimeout(conn.getAccountInfo(ata, "processed"), 10_000, { label: "getAccountInfo" }).catch((e) => {
			markRpcStress?.(e, 1500);
			return null;
		});
		if (info) return 0;
		return await _tokenAccountRentLamportsForMint(outMint);
	} catch {
		return 0;
	}
}

async function getTokenBalanceUiByMint(ownerPkOrStr, mintStr) {
	try {
		if (!ownerPkOrStr || !mintStr || mintStr === SOL_MINT) return { sizeUi: 0, decimals: 9 };
		const { PublicKey } = await loadWeb3();
		const { TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID } = await loadSplToken();
		const conn = await getConn();
		const owner = typeof ownerPkOrStr === "string" ? new PublicKey(ownerPkOrStr) : ownerPkOrStr;
		const mintPk = new PublicKey(mintStr);

		const scan = async (programId) => {
			const res = await withTimeout(
				conn.getParsedTokenAccountsByOwner(owner, { programId }, "confirmed"),
				12_000,
				{ label: "balScan" },
			).catch((e) => {
				markRpcStress?.(e, 1500);
				return { value: [] };
			});
			const list = Array.isArray(res?.value) ? res.value : [];
			let sum = 0;
			let decimals = 6;
			for (const it of list) {
				const info = it?.account?.data?.parsed?.info;
				if (!info) continue;
				if (String(info.mint || "") !== mintPk.toBase58()) continue;
				const ui = Number(info.tokenAmount?.uiAmount ?? 0);
				sum += Number.isFinite(ui) ? ui : 0;
				const dec = Number(info.tokenAmount?.decimals);
				if (Number.isFinite(dec)) decimals = dec;
			}
			return { sizeUi: sum, decimals };
		};

		let a = { sizeUi: 0, decimals: 6 };
		if (TOKEN_PROGRAM_ID) {
			try { a = await scan(TOKEN_PROGRAM_ID); } catch {}
		}
		if (a.sizeUi > 0) return a;
		if (TOKEN_2022_PROGRAM_ID) {
			try { return await scan(TOKEN_2022_PROGRAM_ID); } catch {}
		}
		return a;
	} catch {
		return { sizeUi: 0, decimals: 6 };
	}
}

async function getSolBalanceUi(ownerPkOrStr) {
	try {
		const { PublicKey } = await loadWeb3();
		const conn = await getConn();
		const pk = typeof ownerPkOrStr === "string" ? new PublicKey(ownerPkOrStr) : ownerPkOrStr;
		const lamports = await withTimeout(conn.getBalance(pk, "confirmed"), 10_000, { label: "getBalance" }).catch((e) => {
			markRpcStress?.(e, 1500);
			return 0;
		});
		return Number(lamports || 0) / 1e9;
	} catch {
		return 0;
	}
}

async function unwrapWsolIfAny(signerOrOwner) {
	try {
		const { PublicKey } = await loadWeb3();
		const { getAssociatedTokenAddress, createCloseAccountInstruction, TOKEN_PROGRAM_ID } = await loadSplToken();
		const conn = await getConn();

		const isSigner = !!(signerOrOwner && signerOrOwner.publicKey);
		const ownerPk = isSigner ? signerOrOwner.publicKey : (typeof signerOrOwner === "string" ? new PublicKey(signerOrOwner) : signerOrOwner);
		if (!ownerPk) return false;
		const mint = new PublicKey(SOL_MINT);
		const ata = await getAssociatedTokenAddress(mint, ownerPk, true, TOKEN_PROGRAM_ID);
		const info = await withTimeout(conn.getAccountInfo(ata, "processed"), 10_000, { label: "getAccountInfo" }).catch((e) => {
			markRpcStress?.(e, 1500);
			return null;
		});
		if (!info) return false;

		if (!isSigner) return false;
		const { Transaction } = await loadWeb3();
		const tx = new Transaction();
		tx.add(createCloseAccountInstruction(ata, ownerPk, ownerPk, [], TOKEN_PROGRAM_ID));
		tx.feePayer = ownerPk;
		const bh = await withTimeout(conn.getLatestBlockhash("processed"), 10_000, { label: "getBlockhash" }).catch((e) => {
			markRpcStress?.(e, 1500);
			return null;
		});
		if (!bh?.blockhash) return false;
		tx.recentBlockhash = bh.blockhash;
		tx.sign(signerOrOwner);
		await rpcWait("tx-close-wsol", 350);
		const sig = await withTimeout(
			conn.sendRawTransaction(tx.serialize(), { preflightCommitment: "processed", maxRetries: 2 }),
			15_000,
			{ label: "sendTx" },
		);
		log(`Unwrapped WSOL: ${sig}`);
		return true;
	} catch {
		return false;
	}
}

async function waitForTokenDebit(ownerPubkeyStr, mintStr, prevSizeUi, { timeoutMs = 20_000, pollMs = 350 } = {}) {
	const start = now();
	const prev = Number(prevSizeUi || 0);
	let decimals = 6;
	while (now() - start < timeoutMs) {
		const b = await getTokenBalanceUiByMint(ownerPubkeyStr, mintStr);
		const sizeUi = Number(b.sizeUi || 0);
		if (Number.isFinite(b.decimals)) decimals = b.decimals;
		if (sizeUi + 1e-9 < prev) return { ok: true, remainUi: sizeUi, decimals };
		await new Promise((r) => setTimeout(r, pollMs));
	}
	const b = await getTokenBalanceUiByMint(ownerPubkeyStr, mintStr);
	return { ok: false, remainUi: Number(b.sizeUi || 0), decimals: Number(b.decimals || decimals) };
}

async function safeGetDecimalsFast(mint) {
	try {
		if (!mint) return 6;
		if (mint === SOL_MINT) return 9;
		const dex = _getDex();
		if (dex && typeof dex.getMintDecimals === "function") return await dex.getMintDecimals(mint);
		return 6;
	} catch {
		return 6;
	}
}

function shouldAttachFeeForSellSniper({ mint, amountRaw, inDecimals, quoteOutLamports } = {}) {
	try {
		const m = String(mint || "").trim();
		if (!m || m === SOL_MINT) return false;
		const pos = state.positions?.[m];
		const costSolTotal = Number(pos?.costSol || 0);
		if (!Number.isFinite(costSolTotal) || costSolTotal <= 0) return false;

		const outSol = Number(quoteOutLamports || 0) / 1e9;
		if (!Number.isFinite(outSol) || outSol <= 0) return false;

		let frac = 1;
		try {
			const dec = Number.isFinite(Number(inDecimals)) ? Number(inDecimals) : Number(pos?.decimals || 6);
			const amtRaw = Number.isFinite(Number(amountRaw)) ? Number(amountRaw) : Number(amountRaw || 0);
			const posUi = Number(pos?.sizeUi || 0);
			const posRaw = posUi > 0 ? posUi * Math.pow(10, dec) : 0;
			if (amtRaw > 0 && posRaw > 0) frac = clamp(amtRaw / Math.max(1, posRaw), 0, 1);
		} catch {
			frac = 1;
		}

		const costSold = costSolTotal * frac;
		if (!Number.isFinite(costSold) || costSold <= 0) return false;
		const pnlPct = ((outSol - costSold) / costSold) * 100;
		return Number.isFinite(pnlPct) && pnlPct >= MIN_PROFIT_FOR_PLATFORM_FEE_PCT;
	} catch {
		return false;
	}
}

function setRouterHold(mint, ms = ROUTER_COOLDOWN_MS) {
	try {
		if (!window._fdvRouterHold) window._fdvRouterHold = new Map();
		window._fdvRouterHold.set(mint, now() + Math.max(2000, ms | 0));
	} catch {}
}

function setMintBlacklist(mint, ms = MINT_RUG_BLACKLIST_MS) {
	try {
		if (!window._fdvMintBlacklist) window._fdvMintBlacklist = new Map();
		const until = now() + Math.max(60_000, ms | 0);
		const prev = window._fdvMintBlacklist.get(mint);
		const prevUntil = typeof prev === "number" ? prev : Number(prev?.until || 0);
		window._fdvMintBlacklist.set(mint, Math.max(until, prevUntil || 0));
	} catch {}
}

function isMintBlacklisted(mint) {
	try {
		if (!mint || !window._fdvMintBlacklist) return false;
		const rec = window._fdvMintBlacklist.get(mint);
		const until = typeof rec === "number" ? rec : Number(rec?.until || 0);
		if (!until) return false;
		if (now() > until) {
			window._fdvMintBlacklist.delete(mint);
			return false;
		}
		return true;
	} catch {
		return false;
	}
}

function normBadge(b) {
	const s = String(b || "").toLowerCase();
	if (s.includes("pumping")) return "pumping";
	if (s.includes("warming")) return "warming";
	return "calm";
}

function recordBadgeTransition(mint, badge) {
	try {
		if (!mint) return;
		if (!window._fdvMintBadgeAt) window._fdvMintBadgeAt = new Map();
		const prev = window._fdvMintBadgeAt.get(mint) || { badge: "calm", ts: now() };
		window._fdvMintBadgeAt.set(mint, { badge, ts: now() });
		const prevNorm = normBadge(prev.badge);
		const curNorm = normBadge(badge);
		if (prevNorm === "pumping" && curNorm === "calm") {
			if (!window._fdvPumpDropBan) window._fdvPumpDropBan = new Map();
			window._fdvPumpDropBan.set(mint, now() + 30 * 60 * 1000);
		}
	} catch {}
}

function isPumpDropBanned(mint) {
	try {
		if (!mint || !window._fdvPumpDropBan) return false;
		const until = Number(window._fdvPumpDropBan.get(mint) || 0);
		if (!until) return false;
		if (now() > until) {
			window._fdvPumpDropBan.delete(mint);
			return false;
		}
		return true;
	} catch {
		return false;
	}
}

function _getSeriesStore() {
	if (!window._fdvSniperSeries) window._fdvSniperSeries = new Map();
	return window._fdvSniperSeries;
}

function _maxLeaderSeriesSamples() {
	try {
		const needMs = Math.max(1500, Number(state.observeWindowMs || 8000) | 0);
		const needN = Math.max(3, Number(state.observeMinSamples || 6) | 0);
		const pollMs = Math.max(250, Number(state.pollMs || 1200) | 0);
		// snapshotFocus samples roughly once per pollMs; observeMintOnce can sample ~650ms.
		const assumedIntervalMs = Math.max(200, Math.min(pollMs, 650));
		const needForWindow = Math.ceil(needMs / assumedIntervalMs) + 4;
		const floorN = needN + 6;
		return clamp(Math.max(12, needForWindow, floorN), 12, 120);
	} catch {
		return 32;
	}
}

function recordLeaderSample(mint, sample) {
	if (!mint) return;
	const store = _getSeriesStore();
	const list = store.get(mint) || [];
	const row = {
		ts: now(),
		pumpScore: safeNum(sample.pumpScore, 0),
		liqUsd: safeNum(sample.liqUsd, 0),
		v1h: safeNum(sample.v1h, 0),
		chg5m: safeNum(sample.chg5m, 0),
		chg1h: safeNum(sample.chg1h, 0),
	};
	list.push(row);
	const maxN = _maxLeaderSeriesSamples();
	while (list.length > maxN) list.shift();
	store.set(mint, list);
}

function getLeaderSeries(mint, n = 3) {
	const store = _getSeriesStore();
	const list = store.get(mint) || [];
	if (!n || n >= list.length) return list.slice();
	return list.slice(list.length - n);
}

function slope3pm(series, key) {
	if (!Array.isArray(series) || series.length < 3) return 0;
	const a = series[0];
	const c = series[series.length - 1];
	const dv = Number(c?.[key] ?? 0) - Number(a?.[key] ?? 0);
	const dtm = Math.max(0.06, (Number(c?.ts || 0) - Number(a?.ts || 0)) / 60000);
	return dv / dtm;
}

const _traceLast = new Map();
function traceOnce(key, msg, everyMs = 6000, type = "info") {
	try {
		const k = String(key || "");
		const last = Number(_traceLast.get(k) || 0);
		if (now() - last < everyMs) return;
		_traceLast.set(k, now());
		log(msg, type);
	} catch {
		log(msg, type);
	}
}

function getObservationStatus(mint) {
	try {
		const needN = Math.max(3, Number(state.observeMinSamples || 6) | 0);
		const needMs = Math.max(1500, Number(state.observeWindowMs || 8000) | 0);
		const series = getLeaderSeries(mint, 0);
		const haveN = series?.length || 0;
		const spanMs = haveN >= 2
			? Math.max(0, Number(series[haveN - 1]?.ts || 0) - Number(series[0]?.ts || 0))
			: 0;
		if (haveN < needN) {
			return { ok: false, haveN, needN, spanMs, needMs };
		}
		if (spanMs < needMs) return { ok: false, haveN, needN, spanMs, needMs };
		return { ok: true, haveN, needN, spanMs, needMs };
	} catch {
		return { ok: false, haveN: 0, needN: 0, spanMs: 0, needMs: 0 };
	}
}

function _getDropGuardStore() {
	if (!window._fdvSniperDropGuard) window._fdvSniperDropGuard = new Map();
	return window._fdvSniperDropGuard;
}

function recordObserverPasses(mint, passes) {
	if (!mint) return;
	const m = _getDropGuardStore();
	const r = m.get(mint) || { consec3: 0, lastPasses: 0, lastAt: 0, consecLow: 0 };
	if (passes === 3) r.consec3 = r.lastPasses === 3 ? r.consec3 + 1 : 1;
	else r.consec3 = 0;
	if (passes <= 2) r.consecLow = r.lastPasses <= 2 ? Number(r.consecLow || 0) + 1 : 1;
	else r.consecLow = 0;
	r.lastPasses = passes;
	r.lastAt = now();
	m.set(mint, r);
}

function shouldForceSellAtThree(mint, pos, curSol, nowTs) {
	try {
		const sizeUi = Number(pos.sizeUi || 0);
		if (sizeUi <= 0) return false;
		const minAgeMs = Math.max(0, Number(state.observerDropMinAgeSecs || 0) * 1000);
		const ageMs = nowTs - Number(pos.lastBuyAt || pos.acquiredAt || 0);
		if (ageMs < minAgeMs) return false;

		const rec = _getDropGuardStore().get(mint) || { consec3: 0 };
		const needConsec = Math.max(1, Number(state.observerDropConsec || 2));
		const pxNow = curSol / sizeUi;
		const hwmPx = Number(pos.hwmPx || 0) || pxNow;
		const ddPct = hwmPx > 0 && pxNow > 0 ? ((hwmPx - pxNow) / hwmPx) * 100 : 0;
		const trailThr = Math.max(0, Number(state.observerDropTrailPct || 0));
		const series = getLeaderSeries(mint, 3);
		const scSlopeMin = clamp(slope3pm(series || [], "pumpScore"), -20, 20);
		const chgSlopeMin = clamp(slope3pm(series || [], "chg5m"), -60, 60);
		const slopeBad = scSlopeMin < 0 || chgSlopeMin < 0;
		return (rec.consec3 + 1) >= needConsec && ddPct >= (trailThr + 1.0) && slopeBad;
	} catch {
		return false;
	}
}

function noteObserverConsider(_mint, _ms = 30_000) {
	// Lightweight; just a log hook for parity with trader.
}

async function observeMintOnce(mint, opts = {}) {
	try {
		if (!mint) return { ok: false, passes: 0 };
		const windowMs = Number.isFinite(opts.windowMs) ? opts.windowMs : 2000;
		const sampleMs = Number.isFinite(opts.sampleMs) ? opts.sampleMs : 650;
		const start = now();
		let s0 = null;
		let sN = null;
		while (now() - start < windowMs) {
			const foc = await focusMint(mint, { refresh: true, ttlMs: 2500 }).catch(() => null);
			if (foc?.ok && foc?.row) {
				const r = foc.row;
				const snap = {
					pumpScore: safeNum(foc.pumpScore ?? r.metric ?? 0, 0),
					liqUsd: safeNum(r.liqUsd, 0),
					v1h: safeNum(r.v1hTotal ?? r.v1h, 0),
					chg5m: safeNum(r.chg5m, 0),
					chg1h: safeNum(r.chg1h, 0),
				};
				if (!s0) s0 = snap;
				sN = snap;
				recordLeaderSample(mint, snap);
			}
			await new Promise((r) => setTimeout(r, sampleMs));
		}
		if (!s0 || !sN) return { ok: false, passes: 0 };
		let passes = 0;
		if (sN.chg5m > 0) passes++;
		if (sN.pumpScore >= s0.pumpScore * 0.98) passes++;
		if (sN.v1h >= s0.v1h * 0.95) passes++;
		if (sN.liqUsd >= s0.liqUsd * 0.98) passes++;
		if (sN.pumpScore > s0.pumpScore && sN.chg5m > s0.chg5m) passes++;
		const minPasses = Number.isFinite(opts.minPasses) ? opts.minPasses : 4;
		return { ok: passes >= minPasses, passes };
	} catch {
		return { ok: false, passes: 0 };
	}
}

async function getAutoKeypair() {
	try {
		if (typeof localStorage === "undefined") return null;
		const raw = localStorage.getItem(AUTO_LS_KEY);
		if (!raw) return null;
		const st = JSON.parse(raw);
		const secret = String(st?.autoWalletSecret || "").trim();
		if (!secret) return null;
		const bs58 = await loadBs58();
		const { Keypair } = await loadWeb3();
		const bytes = bs58.decode(secret);
		return Keypair.fromSecretKey(bytes);
	} catch {
		return null;
	}
}

const dustStore = createDustCacheStore({ keyPrefix: "fdv_dust_", log });
const posStore = createPosCacheStore({ keyPrefix: "fdv_pos_", log });
const buySeedStore = createBuySeedStore({ now, ttlMs: BUY_SEED_TTL_MS });

const { lockMint, unlockMint } = createMintLockStore({ now, defaultMs: MINT_OP_LOCK_MS });

const { flagUrgentSell, peekUrgentSell, clearUrgentSell } = createUrgentSellStore({
	now,
	getState: () => state,
	log,
	wakeSellEval: () => {},
	getRugSignalForMint,
	setMintBlacklist,
	urgentSellCooldownMs: URGENT_SELL_COOLDOWN_MS,
	urgentSellMinAgeMs: URGENT_SELL_MIN_AGE_MS,
	rugForceSellSeverity: RUG_FORCE_SELL_SEVERITY,
	mintRugBlacklistMs: MINT_RUG_BLACKLIST_MS,
});

let _pendingMgr;
function _getPendingMgr() {
	if (_pendingMgr) return _pendingMgr;
	_pendingMgr = createPendingCreditManager({
		now,
		log,
		getState: () => state,
		rpcBackoffLeft,
		rpcWait,
		markRpcStress,
		getConn,
		getAtaBalanceUi: async (owner, mint, _dec) => getTokenBalanceUiByMint(owner, mint),
		listOwnerSplPositions: async (owner) => {
			// Minimal: just query the selected mint.
			const m = String(state.mint || "").trim();
			if (!m) return [];
			const b = await getTokenBalanceUiByMint(owner, m);
			return Number(b.sizeUi || 0) > 0 ? [{ mint: m, sizeUi: Number(b.sizeUi), decimals: Number(b.decimals || 6) }] : [];
		},
		reconcileFromOwnerScan: async (_owner) => {},
		updatePosCache: posStore.updatePosCache,
		save: saveState,
		getAutoKeypair,
	});
	return _pendingMgr;
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
		rpcWait,
		rpcBackoffLeft,
		markRpcStress,

		getCfg: () => ({}),
		isValidPubkeyStr: async (s) => {
			try {
				const { PublicKey } = await loadWeb3();
				new PublicKey(String(s || "").trim());
				return true;
			} catch {
				return false;
			}
		},

		tokenAccountRentLamports,
		requiredAtaLamportsForSwap,
		requiredOutAtaRentIfMissing: async () => 0,
		shouldAttachFeeForSell: (args) => shouldAttachFeeForSellSniper(args),
		minSellNotionalSol,
		safeGetDecimalsFast,

		confirmSig,
		unwrapWsolIfAny,

		putBuySeed: buySeedStore.putBuySeed,
		getBuySeed: buySeedStore.getBuySeed,
		clearBuySeed: buySeedStore.clearBuySeed,

		updatePosCache: posStore.updatePosCache,
		removeFromPosCache: posStore.removeFromPosCache,
		addToDustCache: dustStore.addToDustCache,
		removeFromDustCache: dustStore.removeFromDustCache,
		dustCacheToList: dustStore.dustCacheToList,
		cacheToList: posStore.cacheToList,
		clearPendingCredit: _getPendingMgr().clearPendingCredit,
		processPendingCredits: _getPendingMgr().processPendingCredits,
		syncPositionsFromChain: async () => {},
		save: saveState,

		setRouterHold,
		setMintBlacklist,
	});
	return _dex;
}

function minSellNotionalSol() {
	return Math.max(MIN_SELL_SOL_OUT, MIN_JUP_SOL_IN * 1.05, Number(state.dustMinSolOut || 0), MIN_SELL_CHUNK_SOL);
}

function minRawForJupQuote(decimals = 6) {
	try {
		const dec = Number.isFinite(Number(decimals)) ? Number(decimals) : 6;
		// Heuristic: avoid Jupiter quotes for ultra-dust sizes.
		// For typical SPL (dec>=3), require at least 0.001 token.
		// For low-dec tokens, keep a small floor to avoid amount=1 spam.
		if (dec <= 0) return 1;
		if (dec < 3) return 2;
		return Math.max(2, Math.floor(Math.pow(10, dec - 3)));
	} catch {
		return 2;
	}
}

async function quoteOutSol(mint, amountUi, decimals = 6) {
	try {
		if (!mint || mint === SOL_MINT) return 0;
		const dec = Number.isFinite(Number(decimals)) ? Number(decimals) : 6;
		const rawNum = Math.floor(Number(amountUi || 0) * Math.pow(10, dec));
		if (!(rawNum > 0)) return 0;
		const minRaw = minRawForJupQuote(dec);
		if (rawNum < minRaw) return 0;
		const raw = BigInt(rawNum);
		const q = await _getDex().quoteGeneric(mint, SOL_MINT, raw.toString(), getDynamicSlippageBps("sell"));
		const outLamports = Number(q?.outAmount || 0);
		return outLamports > 0 ? outLamports / 1e9 : 0;
	} catch {
		return 0;
	}
}

function estimateNetExitSolFromQuote({ mint, amountUi, inDecimals, quoteOutLamports }) {
	try {
		const feeEligible = shouldAttachFeeForSellSniper({
			mint,
			amountRaw: Math.floor(Number(amountUi || 0) * Math.pow(10, Number(inDecimals || 6))),
			inDecimals,
			quoteOutLamports,
		});
		const feeBps = feeEligible ? Number(FDV_PLATFORM_FEE_BPS || 0) : 0;
		const platformL = Math.floor(Number(quoteOutLamports || 0) * (feeBps / 10_000));
		const txL = Number(EDGE_TX_FEE_ESTIMATE_LAMPORTS || 0);
		const netL = Math.max(0, Number(quoteOutLamports || 0) - platformL - txL);
		return { netSol: netL / 1e9, feeApplied: feeBps > 0, platformLamports: platformL, txLamports: txL };
	} catch {
		return { netSol: Math.max(0, Number(quoteOutLamports || 0) - Number(EDGE_TX_FEE_ESTIMATE_LAMPORTS || 0)) / 1e9, feeApplied: false, platformLamports: 0, txLamports: Number(EDGE_TX_FEE_ESTIMATE_LAMPORTS || 0) };
	}
}

function computeFinalGateIntensity(_mint) {
	return { intensity: 1.0, tier: "moderate" };
}

function computeDynamicHardStopPct(_mint, _pos, _nowTs, { intensity = 1 } = {}) {
	const base = Math.max(DYN_HS?.min ?? 3.2, Math.min(DYN_HS?.max ?? 6.0, DYN_HS?.base ?? 3.8));
	const mult = clamp(Number(intensity || 1), 0.5, 2.5);
	return clamp(base * (2.0 - Math.min(1.6, mult)), DYN_HS?.min ?? 3.2, DYN_HS?.max ?? 6.0);
}

function checkFastExitTriggers(mint, pos, { pnlPct = 0, nowTs } = {}) {
	try {
		if (!state.fastExitEnabled) return { action: "none", reason: "fast-exit-disabled" };
		void mint;
		const ageSec = (nowTs - Number(pos.lastBuyAt || pos.acquiredAt || 0)) / 1000;
		const hs = Math.max(0.5, Number(state.fastHardStopPct || 2.5));
		if (Number.isFinite(pnlPct) && pnlPct <= -hs && ageSec > 5) {
			return { action: "sell_all", reason: `FAST_HARD_STOP ${pnlPct.toFixed(2)}%<=-${hs.toFixed(2)}%`, hardStop: true };
		}
		const tp1 = Math.max(1, Number(state.fastTp1Pct || 10));
		const tp1Sell = clamp(Number(state.fastTp1SellPct || 30), 1, 99);
		if (!pos._fastTp1Done && Number.isFinite(pnlPct) && pnlPct >= tp1) {
			pos._fastTp1Done = true;
			saveState();
			return { action: "sell_partial", pct: tp1Sell, reason: `FAST_TP1 ${pnlPct.toFixed(2)}%>=${tp1}%` };
		}
		const tp2 = Math.max(tp1 + 1, Number(state.fastTp2Pct || 20));
		const tp2Sell = clamp(Number(state.fastTp2SellPct || 30), 1, 99);
		if (!pos._fastTp2Done && Number.isFinite(pnlPct) && pnlPct >= tp2) {
			pos._fastTp2Done = true;
			saveState();
			return { action: "sell_partial", pct: tp2Sell, reason: `FAST_TP2 ${pnlPct.toFixed(2)}%>=${tp2}%` };
		}
		return { action: "none", reason: "fast-none" };
	} catch {
		return { action: "none", reason: "fast-error" };
	}
}

function shouldDeferSellForRebound(mint, pos, pnlPct, nowTs, reason = "") {
	try {
		if (!state.reboundGateEnabled) return false;
		if (/rug/i.test(reason || "")) return false;
		if (/HARD_STOP|FAST_/i.test(reason || "")) return false;
		if (Number.isFinite(pnlPct) && pnlPct <= Number(state.reboundMinPnLPct || -2)) return false;
		const anchorTs = Number(pos.fastPeakAt || pos.lastBuyAt || pos.acquiredAt || 0);
		const ageMs = nowTs - anchorTs;
		const lookbackMs = Math.max(5_000, Number(state.reboundLookbackSecs || 35) * 1000);
		if (ageMs > lookbackMs) return false;
		const series = getLeaderSeries(mint, 3);
		const chgSlope = clamp(slope3pm(series, "chg5m"), -60, 60);
		const scSlope = clamp(slope3pm(series, "pumpScore"), -20, 20);
		const score = clamp((Math.max(0, chgSlope) / 30) * 0.6 + (Math.max(0, scSlope) / 12) * 0.4, 0, 1);
		const ok = score >= Math.max(0.1, Number(state.reboundMinScore || 0.45) * 0.7);
		if (!ok) return false;
		if (!pos.reboundDeferStartedAt) pos.reboundDeferStartedAt = nowTs;
		pos.reboundDeferUntil = nowTs + Math.max(800, Number(state.reboundHoldMs || 6000));
		pos.reboundDeferCount = Number(pos.reboundDeferCount || 0) + 1;
		saveState();
		log(`Rebound gate hold ${mint.slice(0, 4)}… score=${score.toFixed(3)} slopes: chg=${chgSlope.toFixed(2)}/m sc=${scSlope.toFixed(2)}/m`);
		return true;
	} catch {
		return false;
	}
}

function computeWarmingRequirement(pos, nowTs = now()) {
	const base = Number.isFinite(pos?.warmingMinProfitPct) ? Number(pos.warmingMinProfitPct) : Number(state.warmingMinProfitPct || 2);
	const delayMs = Math.max(0, Number(state.warmingDecayDelaySecs || 0) * 1000);
	const perMin = Math.max(0, Number(state.warmingDecayPctPerMin || 0));
	const floorRaw = Number(state.warmingMinProfitFloorPct);
	const floor = Number.isFinite(floorRaw) ? Math.max(0, floorRaw) : 0;
	const holdAt = Number(pos?.warmingHoldAt || pos?.lastBuyAt || pos?.acquiredAt || nowTs);
	const elapsedTotalMs = Math.max(0, nowTs - holdAt);
	const elapsedMs = Math.max(0, elapsedTotalMs - delayMs);
	const elapsedMin = elapsedMs > 0 ? elapsedMs / 60000 : 0;
	const decayed = base - perMin * elapsedMin;
	const req = Math.max(floor, decayed);
	const autoSecs = Math.max(0, Number(state.warmingAutoReleaseSecs || 0));
	const shouldAutoRelease = autoSecs > 0 && elapsedTotalMs >= autoSecs * 1000;
	return { req, base, elapsedMin, perMin, floor, shouldAutoRelease };
}

function applyWarmingPolicy({ mint, pos, nowTs, pnlPct, pnlNetPct, decision, forceRug, forcePumpDrop, forceObserverDrop, forceEarlyFade }) {
	const out = {
		decision,
		forceObserverDrop: !!forceObserverDrop,
		forcePumpDrop: !!forcePumpDrop,
		warmingHoldActive: false,
	};
	try {
		if (!state.rideWarming) return out;
		if (pos.warmingHold !== true) return out;
		const pnl = Number.isFinite(Number(pnlNetPct)) ? Number(pnlNetPct) : Number(pnlPct);
		const warmReq = computeWarmingRequirement(pos, nowTs);
		out.warmingHoldActive = true;

		const maxLoss = Math.max(0, Number(state.warmingMaxLossPct || 0));
		const maxLossWin = Math.max(5, Number(state.warmingMaxLossWindowSecs || 30)) * 1000;
		if (maxLoss > 0) {
			const anchor = Number(pos.warmingHoldAt || pos.lastBuyAt || pos.acquiredAt || nowTs);
			const within = nowTs - anchor <= maxLossWin;
			if (within && Number.isFinite(pnl) && pnl <= -Math.abs(maxLoss) && !forceRug) {
				out.decision = { action: "sell_all", reason: `warming-max-loss ${pnl.toFixed(2)}%<=-${Math.abs(maxLoss).toFixed(2)}%`, hardStop: true };
				return out;
			}
		}

		if (Number.isFinite(pnl) && pnl >= warmReq.req) {
			pos.warmingHold = false;
			pos.warmingClearedAt = nowTs;
			saveState();
			out.warmingHoldActive = false;
			out.decision = { action: "sell_all", reason: `WARMING_TARGET ${pnl.toFixed(2)}%>=${warmReq.req.toFixed(2)}%`, hardStop: true };
			return out;
		}

		if (warmReq.shouldAutoRelease) {
			pos.warmingHold = false;
			pos.warmingClearedAt = nowTs;
			saveState();
			out.warmingHoldActive = false;
			return out;
		}

		// suppress soft sells while warming hold is active
		if (!forceRug && !forcePumpDrop && !forceObserverDrop && !forceEarlyFade) {
			const rsn = String(out.decision?.reason || "");
			const isHardOrFast = !!out.decision?.hardStop || /rug|HARD_STOP|FAST_/i.test(rsn);
			if (out.decision && out.decision.action !== "none" && !isHardOrFast) {
				out.decision = { action: "none", reason: "warming-hold-until-profit" };
			}
		}
	} catch {}
	return out;
}

function shouldSell(pos, curSol, nowTs) {
	try {
		const sizeUi = Number(pos.sizeUi || 0);
		const costSol = Number(pos.costSol || 0);
		if (!(sizeUi > 0) || !(costSol > 0)) return { action: "none", reason: "no-size" };
		const pnlPct = ((Number(curSol || 0) - costSol) / Math.max(1e-9, costSol)) * 100;

		// PnL target (decays over time since entry)
		const tp = getProfitTargetPct(pos, nowTs, { pnlPct });
		if (Number.isFinite(pnlPct) && pnlPct >= tp) {
			return { action: "sell_all", reason: `PNL_TARGET ${pnlPct.toFixed(2)}%>=${tp.toFixed(2)}%` };
		}

		// Trailing after arm
		const arm = Math.max(0, Number(pos.minProfitToTrailPct ?? state.minProfitToTrailPct ?? 2));
		const trailPct = Math.max(0, Number(pos.trailPct ?? state.trailPct ?? 6));
		if (Number(curSol || 0) > Number(pos.hwmSol || 0)) {
			pos.hwmSol = Number(curSol || 0);
			pos.fastPeakAt = nowTs;
			saveState();
		}
		if (Number.isFinite(pnlPct) && pnlPct >= arm && trailPct > 0 && Number(pos.hwmSol || 0) > 0) {
			const stop = Number(pos.hwmSol || 0) * (1 - trailPct / 100);
			if (Number(curSol || 0) <= stop) {
				return { action: "sell_all", reason: `TRAIL ${pnlPct.toFixed(2)}% stop=${stop.toFixed(4)} SOL` };
			}
		}

		// SL
		const sl = Math.max(0.1, Number(pos.slPct ?? state.stopLossPct ?? 4));
		if (Number.isFinite(pnlPct) && pnlPct <= -sl) {
			return { action: "sell_all", reason: `SL ${pnlPct.toFixed(2)}%<=-${sl}%`, hardStop: true };
		}

		// Max hold (fallback)
		const maxHold = Math.max(0, Number(state.maxHoldSecs || 0));
		if (maxHold > 0) {
			const ageMs = nowTs - Number(pos.lastBuyAt || pos.acquiredAt || 0);
			if (ageMs >= maxHold * 1000) return { action: "sell_all", reason: `max-hold>${maxHold}s`, hardStop: true };
		}

		return { action: "none", reason: "hold" };
	} catch {
		return { action: "none", reason: "err" };
	}
}

function profitTargetHoldPolicy(ctx) {
	try {
		const target = getProfitTargetPct(ctx?.pos, Number(ctx?.nowTs || now()), ctx);
		const decision = ctx?.decision;
		if (!decision || decision.action === "none") return;
		// Allow explicit strategy exits (e.g. flame leader rotation) to bypass hold logic.
		if (/\bSWITCH\b/i.test(String(decision?.reason || ""))) return;
		const pnl = Number.isFinite(ctx?.pnlNetPct) ? Number(ctx.pnlNetPct) : Number(ctx?.pnlPct);
		if (!Number.isFinite(pnl)) return;
		if (pnl >= target) return;
		if (ctx?.forceRug) return;
		if (/\brug\b/i.test(String(decision?.reason || ""))) return;
		ctx.decision = { action: "none", reason: `pnl-hold ${pnl.toFixed(2)}%<${target.toFixed(2)}%` };
	} catch {}
}

function flameLeaderSwitchExitPolicy(ctx) {
	try {
		const pos = ctx?.pos;
		if (!pos) return;
		const req = pos._flameSwitch;
		if (!req || typeof req !== "object") return;
		const toMint = String(req.toMint || "").trim();
		const until = Number(req.until || 0);
		if (!_isMaybeMintStr(toMint) || (until > 0 && now() > until)) {
			try { delete pos._flameSwitch; } catch {}
			try { saveState(); } catch {}
			return;
		}

		// Do not rotate during min-hold or router guard.
		if (ctx.inMinHold || ctx.inSellGuard) return;

		// If another hard exit already exists, keep it.
		if (ctx.decision && ctx.decision.action && ctx.decision.action !== "none") {
			if (_isHardExitDecision(ctx.decision, ctx)) return;
		}

		ctx.isFastExit = true;
		ctx.decision = {
			action: "sell_all",
			reason: `SWITCH:flame_leader:${ctx.mint.slice(0, 4)}…→${toMint.slice(0, 4)}…`,
			hardStop: true,
		};
	} catch {}
}

function profitTargetTakePolicy(ctx) {
	try {
		const target = getProfitTargetPct(ctx?.pos, Number(ctx?.nowTs || now()), ctx);
		const pnl = Number.isFinite(ctx?.pnlNetPct) ? Number(ctx.pnlNetPct) : Number(ctx?.pnlPct);
		if (!Number.isFinite(pnl)) return;
		if (pnl < target) return;
		const decision = ctx?.decision;
		if (decision && decision.action && decision.action !== "none") {
			if (_isHardExitDecision(decision, ctx)) return;
			// Upgrade partial exits to full exit once target is hit.
			if (decision.action === "sell_partial") {
				ctx.decision = { action: "sell_all", reason: `PNL_TARGET ${pnl.toFixed(2)}%>=${target.toFixed(2)}%` };
			}
			return;
		}
		ctx.decision = { action: "sell_all", reason: `PNL_TARGET ${pnl.toFixed(2)}%>=${target.toFixed(2)}%` };
	} catch {}
}

async function verifyRealTokenBalance(ownerStr, mint, pos) {
	try {
		const b = await getTokenBalanceUiByMint(ownerStr, mint);
		const sizeUi = Number(b.sizeUi || 0);
		const dec = Number.isFinite(b.decimals) ? b.decimals : Number(pos.decimals || 6);
		if (!(sizeUi > 0)) {
			// purge local pos
			try { delete state.positions[mint]; } catch {}
			try { posStore.removeFromPosCache(ownerStr, mint); } catch {}
			try { _getPendingMgr().clearPendingCredit(ownerStr, mint); } catch {}
			saveState();
			return { ok: false, purged: true, reason: "no-chain-balance" };
		}
		pos.sizeUi = sizeUi;
		pos.decimals = dec;
		pos.lastSeenAt = now();
		posStore.updatePosCache(ownerStr, mint, sizeUi, dec);
		saveState();
		return { ok: true, sizeUi, decimals: dec };
	} catch {
		return { ok: false, purged: false, reason: "balance-check-failed" };
	}
}

function shouldForceMomentumExit(_mint) {
	// TODO: implement momentum logic
	return false;
}

function _mkSellCtx({ kp, mint, pos, nowTs }) {
	return {
		kp,
		mint,
		pos,
		nowTs,
		ownerStr: kp?.publicKey?.toBase58?.() || "",
		leaderMode: false,
		ageMs: 0,
		maxHold: 0,
		forceExpire: true,
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
		pnlTargetPct: null,
		pnlAtDecisionPct: null,
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
	};
}

function annotateProfitTargetPolicy(ctx) {
	try {
		const target = getProfitTargetPct(ctx?.pos, Number(ctx?.nowTs || now()), ctx);
		if (Number.isFinite(target)) ctx.pnlTargetPct = target;
		const pnl = Number.isFinite(ctx?.pnlNetPct) ? Number(ctx.pnlNetPct) : Number(ctx?.pnlPct);
		if (Number.isFinite(pnl)) ctx.pnlAtDecisionPct = pnl;
	} catch {}
}

async function _enrichSellCtx(ctx) {
	try {
		// compute curSol (gross), px, pnl
		const dec = Number.isFinite(ctx.pos.decimals) ? ctx.pos.decimals : 6;
		const curSol = await quoteOutSol(ctx.mint, Number(ctx.pos.sizeUi || 0), dec);
		ctx.curSol = curSol;
		ctx.outLamports = Math.floor(curSol * 1e9);
		const net = estimateNetExitSolFromQuote({ mint: ctx.mint, amountUi: ctx.pos.sizeUi, inDecimals: dec, quoteOutLamports: ctx.outLamports });
		ctx.netEstimate = net;
		ctx.curSolNet = Number(net.netSol || 0);
		ctx.pxNow = Number(ctx.pos.sizeUi || 0) > 0 ? curSol / Number(ctx.pos.sizeUi || 0) : 0;
		ctx.pxNowNet = Number(ctx.pos.sizeUi || 0) > 0 ? ctx.curSolNet / Number(ctx.pos.sizeUi || 0) : 0;
		ctx.pxCost = Number(ctx.pos.costSol || 0) > 0 && Number(ctx.pos.sizeUi || 0) > 0 ? Number(ctx.pos.costSol || 0) / Number(ctx.pos.sizeUi || 0) : 0;
		ctx.pnlPct = ctx.pos.costSol > 0 ? ((curSol - Number(ctx.pos.costSol || 0)) / Math.max(1e-9, Number(ctx.pos.costSol || 0))) * 100 : 0;
		ctx.pnlNetPct = ctx.pos.costSol > 0 ? ((ctx.curSolNet - Number(ctx.pos.costSol || 0)) / Math.max(1e-9, Number(ctx.pos.costSol || 0))) * 100 : 0;
		try {
			const pnlTrack = Number.isFinite(Number(ctx.pnlNetPct)) ? Number(ctx.pnlNetPct) : Number(ctx.pnlPct);
			ctx.pos._lastPnlNetPct = pnlTrack;
			ctx.pos._lastPnlAt = Number(ctx.nowTs || now());
		} catch {}
		// Track a short PnL history for fade-exit decisions.
		try {
			const pnlTrack = Number.isFinite(Number(ctx.pnlNetPct)) ? Number(ctx.pnlNetPct) : Number(ctx.pnlPct);
			pushPnlFadeSample(ctx.pos, ctx.mint, pnlTrack, Number(ctx.nowTs || now()));
		} catch {}
		if (ctx.pxNow > 0) {
			ctx.pos.hwmPx = Math.max(Number(ctx.pos.hwmPx || 0), ctx.pxNow);
		}
		ctx.pos.hwmSol = Math.max(Number(ctx.pos.hwmSol || 0), curSol);
	} catch {}
}

function setInFlight(v) {
	_inFlight = !!v;
	updateUI();
}

async function addRealizedPnl(solProceeds, costSold, label = "PnL") {
	try {
		const pnlSol = Number(solProceeds || 0) - Number(costSold || 0);
		if (!Number.isFinite(pnlSol)) return;
		log(`${label}: ${pnlSol.toFixed(6)} SOL${pnlSol !== 0 ? "" : ""}`);
	} catch {}
}

const preflightSellPolicy = createPreflightSellPolicy({
	now,
	log,
	getState: () => state,
	shouldForceMomentumExit,
	verifyRealTokenBalance,
	hasPendingCredit: (owner, mint) => _getPendingMgr().hasPendingCredit(owner, mint),
	peekUrgentSell: (mint) => peekUrgentSell(mint),
});

const leaderModePolicy = createLeaderModePolicy({ log, getRugSignalForMint });

const urgentSellPolicy = createUrgentSellPolicy({
	log,
	peekUrgentSell,
	clearUrgentSell,
	urgentSellMinAgeMs: URGENT_SELL_MIN_AGE_MS,
});

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
	clamp,
	getState: () => state,
	getLeaderSeries,
	slope3pm,
});

const pnlFadeExitPolicy = createPnlFadeExitPolicy({
	log,
	clamp,
	getState: () => state,
});

const observerPolicy = createObserverPolicy({
	log,
	getState: () => state,
	observeMintOnce,
	recordObserverPasses,
	normBadge,
	getRugSignalForMint,
	getDropGuardStore: _getDropGuardStore,
	setMintBlacklist: (m) => setMintBlacklist(m, MINT_BLACKLIST_STAGES_MS?.[0] || MINT_RUG_BLACKLIST_MS),
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

const volatilityGuardPolicy = createVolatilityGuardPolicy({ log, getState: () => state });

const quoteAndEdgePolicy = createQuoteAndEdgePolicy({
	log,
	getState: () => state,
	quoteOutSol: async (mint, sizeUi, dec) => await quoteOutSol(mint, sizeUi, dec),
	flagUrgentSell,
	RUG_QUOTE_SHOCK_WINDOW_MS,
	RUG_QUOTE_SHOCK_FRAC,
	estimateNetExitSolFromQuote,
});

const fastExitPolicy = createFastExitPolicy({ log, checkFastExitTriggers });

const dynamicHardStopPolicy = createDynamicHardStopPolicy({
	log,
	getState: () => state,
	DYN_HS,
	computeFinalGateIntensity,
	computeDynamicHardStopPct,
});

const profitLockPolicy = createProfitLockPolicy({ log, save: saveState });

const fallbackSellPolicy = createFallbackSellPolicy({
	log,
	getState: () => state,
	minSellNotionalSol,
	shouldSell,
	MIN_SELL_SOL_OUT,
});

const forceFlagDecisionPolicy = createForceFlagDecisionPolicy({ log, getState: () => state });

const reboundGatePolicy = createReboundGatePolicy({
	log,
	getState: () => state,
	shouldDeferSellForRebound,
	wakeSellEval: () => {},
	save: saveState,
});

const executeSellDecisionPolicy = createExecuteSellDecisionPolicy({
	log,
	now,
	getState: () => state,
	save: saveState,
	setInFlight,
	lockMint,
	unlockMint,
	SOL_MINT,
	MINT_OP_LOCK_MS,
	ROUTER_COOLDOWN_MS,
	MIN_SELL_SOL_OUT,
	addToDustCache: dustStore.addToDustCache,
	removeFromPosCache: posStore.removeFromPosCache,
	updatePosCache: posStore.updatePosCache,
	clearPendingCredit: _getPendingMgr().clearPendingCredit,
	setRouterHold,
	closeEmptyTokenAtas: async (kp, mint) => {
		try { return await _getDex().closeEmptyTokenAtas(kp, mint); } catch { return false; }
	},
	quoteOutSol,
	getAtaBalanceUi: async (owner, mint, dec, commitment) => _getDex().getAtaBalanceUi(owner, mint, dec, commitment),
	minSellNotionalSol,
	executeSwapWithConfirm: async (...args) => _getDex().executeSwapWithConfirm(...args),
	waitForTokenDebit: async (owner, mint, prev, opts) => _getDex().waitForTokenDebit(owner, mint, prev, opts),
	addRealizedPnl,
	maybeStealthRotate: async () => {},
	clearRouteDustFails: () => {},
});

async function runSellPipelineForPosition(ctx) {
	const ifRug = (fn) => async (c) => {
		try {
			if (!c || typeof c !== "object") return;
			if (!c.forceRug) return;
			return await fn(c);
		} catch {}
	};
	const ifNotRug = (fn) => async (c) => {
		try {
			if (!c || typeof c !== "object") return;
			if (c.forceRug) return;
			return await fn(c);
		} catch {}
	};

	const steps = [
		(c) => preflightSellPolicy(c),
		(c) => leaderModePolicy(c),
		(c) => urgentSellPolicy(c),
		(c) => rugPumpDropPolicy(c),

		// Always compute valuation/PnL, because profit-target decisions depend on it.
		(c) => quoteAndEdgePolicy(c),

		// Annotate the current profit target for downstream logging/telemetry.
		(c) => annotateProfitTargetPolicy(c),

		// Default mode: ONLY sell on profit target. Do not run early-exit/risk policies unless rug.
		(c) => profitTargetHoldPolicy(c),
		(c) => profitTargetTakePolicy(c),
		(c) => flameLeaderSwitchExitPolicy(c),
		(c) => pnlFadeExitPolicy(c),

		// Rug mode: enable the protective stack.
		ifRug((c) => earlyFadePolicy(c)),
		ifRug((c) => observerPolicy(c)),
		ifRug((c) => volatilityGuardPolicy(c)),
		ifRug((c) => fastExitPolicy(c)),
		ifRug((c) => dynamicHardStopPolicy(c)),
		ifRug((c) => warmingPolicyHook(c)),
		ifRug((c) => profitLockPolicy(c)),
		ifRug((c) => observerThreePolicy(c)),
		ifRug((c) => fallbackSellPolicy(c)),
		ifRug((c) => forceFlagDecisionPolicy(c)),
		ifRug((c) => reboundGatePolicy(c)),
		ifRug((c) => momentumLossGuardPolicy(c)),
		ifRug((c) => profitFloorGatePolicy(c)),

		(c) => executeSellDecisionPolicy(c),
	];
	for (const fn of steps) {
		if (typeof fn !== "function") continue;
		await fn(ctx);
		if (ctx.stop || ctx.done) break;
	}
}

function updateUI() {
	try {
		// if (!statusEl) return;
		if (startBtn) startBtn.disabled = _inFlight;
		const curMint = String(state.mint || "").trim();
		const active = hasAnyActivePosition();
		const holding = !!active.ok;
		const sentry = !!state.sentryEnabled;
		const flame = !!state.flameEnabled && !sentry;
		const target = sentry ? (curMint ? `${curMint.slice(0, 4)}…` : "auto") : (curMint ? `${curMint.slice(0, 4)}…` : "-");
		// statusEl.textContent = `Target: ${target}`;
		if (mintEl) {
			mintEl.disabled = sentry || flame;
			mintEl.placeholder = sentry ? "Sentry Mode" : flame ? "Flame Mode" : "Mint address";
		}
	} catch {}
}

function tryAcquireBuyLock(ms = BUY_LOCK_MS) {
	const t = now();
	const until = Number(window._fdvSniperBuyLockUntil || 0);
	if (t < until) return false;
	window._fdvSniperBuyLockUntil = t + Math.max(1000, ms | 0);
	return true;
}

function releaseBuyLock() {
	try { window._fdvSniperBuyLockUntil = 0; } catch {}
}

async function snapshotFocus(mint) {
	try {
		const foc = await focusMint(mint, { refresh: true, ttlMs: 2500 }).catch(() => null);
		if (!foc?.ok || !foc?.row) return null;
		const r = foc.row;
		const snap = {
			pumpScore: safeNum(foc.pumpScore ?? r.metric ?? 0, 0),
			liqUsd: safeNum(r.liqUsd, 0),
			v1h: safeNum(r.v1hTotal ?? r.v1h, 0),
			chg5m: safeNum(r.chg5m, 0),
			chg1h: safeNum(r.chg1h, 0),
			badge: String(getRugSignalForMint(mint)?.badge || ""),
		};
		recordLeaderSample(mint, snap);
		return snap;
	} catch {
		return null;
	}
}

function shouldTriggerBuy(mint) {
	try {
		const obs = getObservationStatus(mint);
		if (!obs.ok) return false;
		const series = getLeaderSeries(mint, 3);
		if (!series || series.length < 3) return false;
		const last = series[series.length - 1] || {};
		const badgeNorm = normBadge(getRugSignalForMint(mint)?.badge);
		const chgSlope = clamp(slope3pm(series, "chg5m"), -60, 60);
		const scSlope = clamp(slope3pm(series, "pumpScore"), -20, 20);
		const thr = Math.max(0, Number(state.triggerScoreSlopeMin || 0.6));
		const rising = (safeNum(last.chg5m, 0) > 0) && (chgSlope > 0 || scSlope > thr);
		const pumpingish = badgeNorm === "pumping" || (state.rideWarming && badgeNorm === "warming");
		return rising && pumpingish && scSlope >= thr;
	} catch {
		return false;
	}
}

async function mirrorBuy(mint, opts = null) {
	let entryMode = "";
	try {
		if (opts && typeof opts === "object") entryMode = String(opts.entryMode || "");
	} catch {}

	try {
		let rugSig = null;
		let rugSev = 0;
		try {
			rugSig = getRugSignalForMint(mint);
			rugSev = Number(rugSig?.sev ?? rugSig?.severity ?? 0);
		} catch {
			rugSig = null;
			rugSev = 0;
		}
		const thr = SNIPER_RUG_BUY_BLOCK_SEV_THRESHOLD;
		if (rugSig?.rugged && rugSev >= thr) {
			traceOnce(
				`sniper:rug:blockBuy:${mint}`,
				`EXTREME rug signal for ${_shortMint(mint)} sev=${rugSev.toFixed(2)} (thr=${thr.toFixed(2)}). Blocking buy.`,
				9000,
				"warn",
			);
			try { setMintBlacklist(mint, MINT_RUG_BLACKLIST_MS); } catch {}
			return { ok: false, reason: "RUG_BLOCK" };
		}
	} catch {}

	if (isMintBlacklisted(mint) || isPumpDropBanned(mint)) {
		log(`Skipping buy: mint blacklisted/banned ${mint.slice(0, 4)}…`, "warn");
		return { ok: false };
	}
	if (!tryAcquireBuyLock()) return { ok: false };
	try {
		const kp = await getAutoKeypair();
		if (!kp) {
			log("Missing auto wallet. Use Trader tab to Generate wallet.", "err");
			return { ok: false };
		}
		const ownerStr = kp.publicKey.toBase58();
		const solBal = await getSolBalanceUi(kp.publicKey);
		const buyFrac = clamp(Number(state.buyPct || 25) / 100, 0.01, 0.7);
		const ataRentLamports = await requiredAtaLamportsForSwap(ownerStr, SOL_MINT, mint);
		const reserveLamports = Number(TX_FEE_BUFFER_LAMPORTS || 0) + Number(EDGE_TX_FEE_ESTIMATE_LAMPORTS || 0) + Number(ataRentLamports || 0);
		const maxSpendSol = Math.max(0, solBal - reserveLamports / 1e9);
		const desired = Math.max(0, solBal * buyFrac);
		const buySol = Math.min(desired, maxSpendSol);
		if (!(buySol >= Math.max(0.001, MIN_JUP_SOL_IN))) {
			log(`Not enough SOL to buy (bal=${solBal.toFixed(4)}).`, "warn");
			return { ok: false };
		}

		const slip = getDynamicSlippageBps("buy");
		const chk = await preflightBuyLiquidity({
			dex: _getDex(),
			solMint: SOL_MINT,
			mint,
			inputSol: buySol,
			slippageBps: slip,
			maxPriceImpactPct: DEFAULT_BUY_MAX_PRICE_IMPACT_PCT,
			exitCheckFraction: DEFAULT_BUY_EXIT_CHECK_FRACTION,
		});
		if (!chk?.ok) {
			log(`Buy blocked (liquidity): ${chk?.reason || "no-route"}`, "warn");
			setMintBlacklist(mint, MINT_BLACKLIST_STAGES_MS?.[0] || 2 * 60 * 1000);
			return { ok: false };
		}

		// Honeypot/unsellable protection: ensure a viable SOL round-trip quote exists.
		const edge = await estimateRoundtripEdgePct(ownerStr, mint, buySol, {
			slippageBps: slip,
			dynamicFee: true,
			ataRentLamports,
		});
		if (!edge) {
			log(`Buy blocked (edge): no round-trip quote for ${mint.slice(0, 6)}…`, "warn");
			setMintBlacklist(mint, MINT_BLACKLIST_STAGES_MS?.[0] || 2 * 60 * 1000);
			return { ok: false };
		}

		log(`Sniper BUY ${mint.slice(0, 6)}… ~${buySol.toFixed(4)} SOL`, "ok");
		setInFlight(true);
		lockMint(mint, "buy", MINT_OP_LOCK_MS);
		let sig = "";
		try {
			sig = await withTimeout(
				_getDex().jupSwapWithKeypair({
					signer: kp,
					inputMint: SOL_MINT,
					outputMint: mint,
					amountUi: buySol,
					slippageBps: slip,
				}),
				75_000,
				{ label: "sniper_buy" },
			);
		} catch (e) {
			const msg = String(e?.message || e || "");
			if (/COULD_NOT_FIND_ANY_ROUTE|NO_ROUTE|NO_ROUTES|BELOW_MIN_NOTIONAL|0x1788|0x1789/i.test(msg)) {
				log(`BUY failed (no route): ${msg}`, "warn");
			} else if (/INSUFFICIENT_LAMPORTS/i.test(msg)) {
				log(`BUY failed (insufficient SOL): ${msg}`, "warn");
			} else {
				log(`BUY error: ${msg}`, "warn");
			}
			setMintBlacklist(mint, MINT_BLACKLIST_STAGES_MS?.[0] || 2 * 60 * 1000);
			return { ok: false };
		}

		// optimistic seed (for sell pipeline to have a pos)
		const dec = await safeGetDecimalsFast(mint);
		const posPrev = state.positions[mint] || { sizeUi: 0, costSol: 0, hwmSol: 0, acquiredAt: now() };
		const pos = {
			...posPrev,
			decimals: Number.isFinite(dec) ? dec : 6,
			costSol: Number(posPrev.costSol || 0) + buySol,
			hwmSol: Math.max(Number(posPrev.hwmSol || 0), buySol),
			lastBuyAt: now(),
			acquiredAt: posPrev.acquiredAt || now(),
			awaitingSizeSync: true,
			warmingHold: !!state.rideWarming,
			warmingHoldAt: now(),
			entryMode: entryMode || String(posPrev.entryMode || ""),
			_momPlummetConsec: 0,
			entryChg5m: safeNum(getLeaderSeries(mint, 1)?.[0]?.chg5m, NaN),
			slPct: Number(state.stopLossPct || 4),
			trailPct: Number(state.trailPct || 6),
			minProfitToTrailPct: Number(state.minProfitToTrailPct || 2),
		};
		state.positions = {};
		state.positions[mint] = pos;
		posStore.updatePosCache(ownerStr, mint, Number(pos.sizeUi || 0), pos.decimals);
		_getPendingMgr().enqueuePendingCredit({
			owner: ownerStr,
			mint,
			addCostSol: 0,
			decimalsHint: pos.decimals,
			basePos: pos,
			sig: String(sig || ""),
		});
		saveState();
		log(`BUY submitted (pending credit): ${String(sig || "")}`, "warn");
		return { ok: false, sig: String(sig || "") };
	} finally {
		setInFlight(false);
		unlockMint(mint);
		releaseBuyLock();
	}
}

async function tickOnce() {
	if (!state.enabled) return;
	const run = _runNonce;
	if (_tickInFlight) return;
	_tickInFlight = true;
	try {
		if (!state.enabled || run !== _runNonce) return;

		try {
			if (state.sentryEnabled && typeof document !== "undefined") {
				const active = hasAnyActivePosition();
				if (!active.ok && !_inFlight) {
					let picked = pickSentryMintFast();
					if (!picked) picked = await pickSentryMintAsync();
					if (picked && picked !== String(state.mint || "").trim()) {
						state.mint = picked;
						if (mintEl) mintEl.value = picked;
						saveState();
						const p = _sentryLastPick;
						traceOnce(
							"sniper:sentry:pick",
							`Sentry target: ${picked.slice(0, 6)}… rec=${String(p?.rec || "")} score=${Number(p?.score || 0).toFixed(0)} ready=${Math.round(Number(p?.readyFrac || 0) * 100)}% trig=${p?.trig ? "Y" : "N"}`,
							3500,
							"help",
						);
					}
				}
			}
		} catch {}

		try {
			if (state.flameEnabled && !state.sentryEnabled && typeof document !== "undefined") {
				const active = hasAnyActivePosition();
				if (!active.ok && !_inFlight) {
					let picked = _takeQueuedFlameMint();
					if (!picked) picked = pickFlameMintFast();
					if (picked && picked !== String(state.mint || "").trim()) {
						state.mint = picked;
						if (mintEl) mintEl.value = picked;
						saveState();
						traceOnce(
							"sniper:flame:pick",
							`Flame target: ${picked.slice(0, 6)}… (from Flamebar leader)`,
							3500,
							"help",
						);
					}
				}
			}
		} catch {}

		const mint = String(state.mint || "").trim();
		if (!mint) {
			updateUI();
			return;
		}

		// keep sampling signal
		await snapshotFocus(mint);
		if (!state.enabled || run !== _runNonce) return;
		try {
			const last = getLeaderSeries(mint, 1)?.[0];
			const lastTs = Number(last?.ts || 0);
			if (lastTs > 0) {
				const ageMs = now() - lastTs;
				const maxAgeMs = Math.max(4000, Number(state.pollMs || 1200) * 4);
				if (ageMs > maxAgeMs) {
					traceOnce(
						`sniper:stale:${mint}`,
						`Sampling stale ${mint.slice(0, 4)}… last sample ${(ageMs / 1000).toFixed(1)}s ago (poll=${state.pollMs}ms)` ,
						8000,
						"warn",
					);
				}
			} else {
				traceOnce(
					`sniper:stale:${mint}`,
					`No samples yet for ${mint.slice(0, 4)}… (waiting for focus data)` ,
					6000,
					"help",
				);
			}
		} catch {}

		// pending credits
		try { await _getPendingMgr().processPendingCredits(); } catch {}
		if (!state.enabled || run !== _runNonce) return;

		const pos = state.positions?.[mint] || null;
		let holding = !!(pos && (Number(pos.sizeUi || 0) > 0 || pos.awaitingSizeSync === true));

		try {
			if (holding && pos && state.flameEnabled && !state.sentryEnabled && typeof document !== "undefined" && !_inFlight) {
				const t = now();
				if (t >= Number(_flameRotateCooldownUntil || 0)) {
					const leader = getFlameLeaderMintNow();
					if (_isMaybeMintStr(leader) && leader !== mint && !isMintBlacklisted(leader) && !isPumpDropBanned(leader)) {
						if (leader === _flameLeaderLast) _flameLeaderConsec = Math.min(25, Number(_flameLeaderConsec || 0) + 1);
						else {
							_flameLeaderLast = leader;
							_flameLeaderConsec = 1;
							_flameSwitchCheck = null;
							traceOnce(
								"sniper:flame:leader",
								`Flame leader seen: ${leader.slice(0, 6)}… (watching while holding ${mint.slice(0, 4)}…)`,
								3500,
								"help",
							);
						}

						// Sample the leader mint on a light throttle to build a signal series.
						if (t - Number(_flameWatchSampleAt || 0) >= Math.max(FLAME_SWITCH_SAMPLE_MIN_MS, Math.floor(Number(state.pollMs || 1200) * 0.9))) {
							_flameWatchSampleAt = t;
							void snapshotFocus(leader);
						}

						if (Number(_flameLeaderConsec || 0) >= FLAME_SWITCH_MIN_CONSEC_TICKS) {
							const heldSig = _getLiveSignalForMint(mint);
							const leaderSig = _getLiveSignalForMint(leader);
							const heldHealthy = _isHeldHealthyAndProfitable({ pos, heldSig, nowTs: t });
							const leaderViable = !!(
								leaderSig?.ok &&
								leaderSig.obsOk &&
								leaderSig.trig &&
								Number(leaderSig.last?.chg5m || 0) > 0
							);
							const existing = pos?._flameSwitch;
							const existingTo = String(existing?.toMint || "").trim();
							const existingOk = existingTo && existingTo === leader && (Number(existing?.until || 0) <= 0 || t <= Number(existing.until));

							if (!existingOk && heldHealthy) {
								traceOnce(
									`sniper:flame:hold:${mint}`,
									`Flame hold: keeping ${mint.slice(0, 4)}… (healthy + profitable) despite leader ${leader.slice(0, 4)}…` ,
									6500,
									"help",
								);
							} else if (!existingOk && leaderViable) {
								if (!_flameSwitchCheck || _flameSwitchCheck.mint !== leader) {
									const chk = { mint: leader, startedAt: t, done: false, result: null, promise: null };
									chk.promise = observeMintOnce(leader, { windowMs: 2600, sampleMs: 650, minPasses: 4 })
										.then((r) => {
											chk.done = true;
											chk.result = r;
											return r;
										})
										.catch(() => {
											chk.done = true;
											chk.result = { ok: false, passes: 0 };
											return chk.result;
										});
									_flameSwitchCheck = chk;
									traceOnce(
										`sniper:flame:switch:check:${leader}`,
										`Flame switch check: leader ${leader.slice(0, 6)}… selected by Flamebar; confirming viability…`,
										3500,
										"help",
									);
								}

								if (_flameSwitchCheck && _flameSwitchCheck.mint === leader && _flameSwitchCheck.done) {
									const okObs = !!_flameSwitchCheck.result?.ok;
									if (okObs) {
										pos._flameSwitch = {
											toMint: leader,
											at: t,
											until: t + FLAME_SWITCH_QUEUE_TTL_MS,
											heldScore: Number(heldSig?.score || 0),
											leaderScore: Number(leaderSig?.score || 0),
										};
										_queueFlameMint(leader);
										_flameRotateCooldownUntil = t + FLAME_ROTATE_COOLDOWN_MS;
										try { saveState(); } catch {}
										log(
											`Flame rotate queued: sell ${mint.slice(0, 4)}… → buy ${leader.slice(0, 4)}… (following Flamebar leader)` ,
											"warn",
										);
									} else {
										traceOnce(
											`sniper:flame:switch:reject:${leader}`,
											`Flame rotate rejected: leader ${leader.slice(0, 6)}… did not confirm performance`,
											6000,
											"help",
										);
									}
									_flameSwitchCheck = null;
								}
							}
						}
					}
				}
			}
		} catch {}
		try {
			if (holding && pos && Number(pos.sizeUi || 0) > 0 && pos.awaitingSizeSync !== true && !state.dustExitEnabled) {
				const dec = Number.isFinite(pos.decimals) ? pos.decimals : 6;
				const rawNum = Math.floor(Number(pos.sizeUi || 0) * Math.pow(10, Number(dec || 6)));
				const minRaw = minRawForJupQuote(dec);
				if (rawNum > 0 && rawNum < minRaw) {
					const kp = await getAutoKeypair();
					const ownerStr = kp?.publicKey?.toBase58?.() || "";
					if (ownerStr) {
						try { dustStore.addToDustCache(ownerStr, mint, Number(pos.sizeUi || 0), dec); } catch {}
						try { posStore.removeFromPosCache(ownerStr, mint); } catch {}
						try { _getPendingMgr().clearPendingCredit(ownerStr, mint); } catch {}
					}
					try { delete state.positions[mint]; } catch {}
					saveState();
					traceOnce(
						`sniper:dust-moved:${mint}`,
						`Dust position ${mint.slice(0, 4)}… size=${Number(pos.sizeUi || 0)} raw=${rawNum} (<${minRaw}); moved to dust cache; resuming observation` ,
						60_000,
						"help",
					);
					holding = false;
				}
			}
		} catch {}

		if (!holding) {
			if (isMintBlacklisted(mint) || isPumpDropBanned(mint)) {
				updateUI();
				return;
			}
			const obs = getObservationStatus(mint);
			if (!obs.ok) {
				const spanS = (obs.spanMs / 1000).toFixed(1);
				const needS = (obs.needMs / 1000).toFixed(0);
				const series3 = getLeaderSeries(mint, 3);
				const last = series3?.[series3.length - 1] || {};
				const chgSlope = clamp(slope3pm(series3 || [], "chg5m"), -60, 60);
				const scSlope = clamp(slope3pm(series3 || [], "pumpScore"), -20, 20);
				const badgeNorm = normBadge(getRugSignalForMint(mint)?.badge);
				const thr = Math.max(0, Number(state.triggerScoreSlopeMin || 0.6));
				traceOnce(
					`sniper:obs:${mint}`,
					`Observing ${mint.slice(0, 4)}… n=${obs.haveN}/${obs.needN} span=${spanS}s/${needS}s badge=${badgeNorm} last(chg5m=${safeNum(last.chg5m, 0).toFixed(2)} sc=${safeNum(last.pumpScore, 0).toFixed(2)}) slopes(chg=${chgSlope.toFixed(2)}/m sc=${scSlope.toFixed(2)}/m thr=${thr.toFixed(2)})`,
					3500,
					"help",
				);
				updateUI();
				return;
			}
			try {
				const k = `sniper:obs-ready:${mint}`;
				if (!window._fdvSniperObsReadyOnce) window._fdvSniperObsReadyOnce = new Set();
				if (!window._fdvSniperObsReadyOnce.has(k)) {
					window._fdvSniperObsReadyOnce.add(k);
					log(`Observation ready ${mint.slice(0, 4)}… n=${obs.haveN} span=${(obs.spanMs / 1000).toFixed(1)}s`, "ok");
				}
			} catch {}
			const trig = shouldTriggerBuy(mint);
			if (!trig) {
				try {
					const series3 = getLeaderSeries(mint, 3);
					const last = series3?.[series3.length - 1] || {};
					const chgSlope = clamp(slope3pm(series3 || [], "chg5m"), -60, 60);
					const scSlope = clamp(slope3pm(series3 || [], "pumpScore"), -20, 20);
					const thr = Math.max(0, Number(state.triggerScoreSlopeMin || 0.6));
					const badgeNorm = normBadge(getRugSignalForMint(mint)?.badge);
					const reasons = [];
					if (!(safeNum(last.chg5m, 0) > 0)) reasons.push(`chg5m<=0 (${safeNum(last.chg5m, 0).toFixed(2)})`);
					if (!(chgSlope > 0 || scSlope > thr)) reasons.push(`slopes weak (chg=${chgSlope.toFixed(2)}/m sc=${scSlope.toFixed(2)}/m)`);
					if (!(scSlope >= thr)) reasons.push(`scSlope<thr (${scSlope.toFixed(2)}<${thr.toFixed(2)})`);
					if (!(badgeNorm === "pumping" || (state.rideWarming && badgeNorm === "warming"))) reasons.push(`badge=${badgeNorm}`);
					traceOnce(
						`sniper:ready:${mint}`,
						`Ready ${mint.slice(0, 4)}… waiting trigger: ${reasons.join("; ") || "no-trigger"}`,
						6000,
						"help",
					);
				} catch {}
				updateUI();
				return;
			}
			if (trig) {
				if (state.flameEnabled && !state.sentryEnabled && typeof document !== "undefined" && !isFlamebarPumpingNow()) {
					traceOnce(
						"sniper:flame:gate",
						`Flame gate: skipping buy for ${mint.slice(0, 4)}… (waiting for Flamebar 🔥 pump)` ,
						4500,
						"help",
					);
					updateUI();
					return;
				}
				log(`Trigger: upward momentum for ${mint.slice(0, 4)}… buying.`, "info");
				await mirrorBuy(mint, { entryMode: "momentum" });
			}
			updateUI();
			return;
		}

		// holding: evaluate sell pipeline
		const kp = await getAutoKeypair();
		if (!state.enabled || run !== _runNonce) return;
		if (!kp) {
			log("Auto wallet missing; cannot manage position.", "err");
			updateUI();
			return;
		}

		// Hold gate: avoid immediate sell eval right after buy (unless urgent/rug).
		try {
			const ageMs = now() - Number(pos.lastBuyAt || pos.acquiredAt || 0);
			const minHoldMs = Math.max(0, Number(state.minHoldSecs || 0)) * 1000;
			const urgent = peekUrgentSell(mint);
			const urgentReason = String(urgent?.reason || "");
			const urgentSev = Number(urgent?.sev || 0);
			const urgentHard = !!urgent && (/rug/i.test(urgentReason) || urgentSev >= 0.75);
			if (minHoldMs > 0 && ageMs < minHoldMs && !urgentHard) {
				traceOnce(
					`sniper:minhold:${mint}`,
					`Hold gate ${mint.slice(0, 4)}… age ${(ageMs / 1000).toFixed(1)}s < ${(minHoldMs / 1000).toFixed(0)}s`,
					2500,
					"help",
				);
				updateUI();
				return;
			}
		} catch {}

		const ctx = _mkSellCtx({ kp, mint, pos, nowTs: now() });
		await _enrichSellCtx(ctx);
		if (!state.enabled || run !== _runNonce) return;
		// slippage is dynamic; set a per-tick baseline for sell execution policies
		state.slippageBps = getDynamicSlippageBps("sell");
		await runSellPipelineForPosition(ctx);
		if (!state.enabled || run !== _runNonce) return;
		try {
			const p2 = state.positions?.[mint];
			const localHolding = !!(p2 && (Number(p2.sizeUi || 0) > 0 || p2.awaitingSizeSync === true));
			if (!localHolding) {
				const ownerStr = kp.publicKey.toBase58();
				const b = await getTokenBalanceUiByMint(ownerStr, mint).catch(() => null);
				const sizeUi = Number(b?.sizeUi || 0);
				const dec = Number.isFinite(Number(b?.decimals)) ? Number(b.decimals) : 6;
				if (sizeUi > 0) {
					let isDust = false;
					try {
						const rawNum = Math.floor(sizeUi * Math.pow(10, Number(dec || 6)));
						const minRaw = minRawForJupQuote(dec);
						isDust = (rawNum > 0 && rawNum < minRaw);
					} catch {}
					if (!isDust) {
						state.positions = state.positions && typeof state.positions === "object" ? state.positions : {};
						state.positions[mint] = {
							...(pos && typeof pos === "object" ? pos : {}),
							sizeUi,
							decimals: dec,
							awaitingSizeSync: false,
							lastSeenAt: now(),
							acquiredAt: (pos && (pos.acquiredAt || pos.lastBuyAt)) ? (pos.acquiredAt || pos.lastBuyAt) : now(),
						};
						try { posStore.updatePosCache(ownerStr, mint, sizeUi, dec); } catch {}
						try { saveState(); } catch {}
						traceOnce(
							`sniper:recover:${mint}`,
							`Recovered local position for ${mint.slice(0, 4)}… chainBal=${sizeUi.toFixed(6)} (post-sell)` ,
							60_000,
							"warn",
						);
					}
				}
			}
		} catch {}
		try {
			// post-sell cleanup if empty
			const p2 = state.positions?.[mint];
			if (!p2) {
				try { clearUrgentSell(mint); } catch {}
				try { await unwrapWsolIfAny(kp); } catch {}
			}
		} catch {}
		updateUI();
	} catch (e) {
		log(`Tick error: ${e?.message || e}`, "warn");
	} finally {
		_tickInFlight = false;
	}
}

async function startSniper() {
	if (state.enabled) return;
	_acceptLogs = true;
	_runNonce++;
	state.sentryEnabled = !!(sentryEl?.checked || state.sentryEnabled);
	state.flameEnabled = !!(flameEl?.checked || state.flameEnabled);
	if (state.sentryEnabled && state.flameEnabled) state.flameEnabled = false;
	const mint = String(mintEl?.value || state.mint || "").trim();
	if (!mint && !state.sentryEnabled && !state.flameEnabled) {
		log("Missing mint.", "warn");
		return;
	}
	if (state.flameEnabled) {
		state.sentryEnabled = false;
		try { if (sentryEl) sentryEl.checked = false; } catch {}
		try { stopSentryPrefetch(); } catch {}
	}
	state.mint = mint;
	state.pollMs = Math.floor(clamp(Number(pollEl?.value || state.pollMs || 1200), 250, 60_000));
	state.buyPct = Math.floor(clamp(Number(buyPctEl?.value || state.buyPct || 25), 1, 70));
	state.triggerScoreSlopeMin = clamp(Number(triggerEl?.value || state.triggerScoreSlopeMin || 0.6), 0, 20);
	state.pnlTargetStartPct = clamp(Number(maxProfitEl?.value || state.pnlTargetStartPct || PNL_TARGET_DEFAULT_START_PCT), 0, 50);
	state.pnlTargetFloorPct = clamp(Number(state.pnlTargetFloorPct ?? PNL_TARGET_DEFAULT_FLOOR_PCT), 0, 50);
	state.pnlTargetStartPct = clamp(Number(state.pnlTargetStartPct ?? PNL_TARGET_DEFAULT_START_PCT), state.pnlTargetFloorPct, 50);
	state.pnlTargetDecayPct = clamp(Number(state.pnlTargetDecayPct ?? PNL_TARGET_DEFAULT_DECAY_PCT), 0, 50);
	state.pnlTargetDecayWindowMin = clamp(Number(state.pnlTargetDecayWindowMin ?? PNL_TARGET_DEFAULT_DECAY_WINDOW_MIN), 1, 240);
	state.slippageBps = getDynamicSlippageBps("buy");
	state.enabled = true;
	try { setBotRunning('sniper', true); } catch {}
	state.positions = state.positions && typeof state.positions === "object" ? state.positions : {};
	saveState();
	updateUI();
	if (state.sentryEnabled) startSentryPrefetch();
	log(
		`Sniper started. ${state.sentryEnabled ? "(sentry)" : state.flameEnabled ? "(flame)" : ""} mint=${mint ? mint.slice(0, 6) + "…" : (state.flameEnabled ? "flame" : "auto")} poll=${state.pollMs}ms buyPct=${state.buyPct}% pnlTarget=${Number(state.pnlTargetStartPct || PNL_TARGET_DEFAULT_START_PCT).toFixed(2)}%→${Number(state.pnlTargetFloorPct || PNL_TARGET_DEFAULT_FLOOR_PCT).toFixed(2)}% (-${Number(state.pnlTargetDecayPct || PNL_TARGET_DEFAULT_DECAY_PCT).toFixed(2)}%/${Number(state.pnlTargetDecayWindowMin || PNL_TARGET_DEFAULT_DECAY_WINDOW_MIN).toFixed(0)}m) obs=${state.observeMinSamples}/${Math.round(state.observeWindowMs / 1000)}s minHold=${state.minHoldSecs}s thr=${Number(state.triggerScoreSlopeMin || 0.6).toFixed(2)}`,
		"ok",
		true,
	);

	if (_timer) clearInterval(_timer);
	_timer = setInterval(() => {
		void tickOnce();
	}, state.pollMs);
	await tickOnce();
}

async function liquidateAllPositionsOnStop() {
	try {
		const kp = await getAutoKeypair();
		if (!kp) {
			log("Stop liquidation skipped: auto wallet missing.", "warn", true);
			return { ok: false, sold: 0, reason: "no-wallet" };
		}
		const ownerStr = kp.publicKey.toBase58();

		// Build a resilient candidate set: state.positions + pos cache + dust cache.
		const candidates = new Map();
		try {
			const ps = state.positions && typeof state.positions === "object" ? state.positions : {};
			for (const [mint, p] of Object.entries(ps)) {
				if (!_isMaybeMintStr(mint) || !p) continue;
				candidates.set(mint, p);
			}
		} catch {}
		try {
			const list = posStore?.cacheToList ? posStore.cacheToList(ownerStr) : [];
			for (const it of list || []) {
				const mint = String(it?.mint || "").trim();
				if (!_isMaybeMintStr(mint)) continue;
				if (!candidates.has(mint)) candidates.set(mint, null);
			}
		} catch {}
		try {
			const list = dustStore?.dustCacheToList ? dustStore.dustCacheToList(ownerStr) : [];
			for (const it of list || []) {
				const mint = String(it?.mint || "").trim();
				if (!_isMaybeMintStr(mint)) continue;
				if (!candidates.has(mint)) candidates.set(mint, null);
			}
		} catch {}

		if (!candidates.size) return { ok: true, sold: 0, reason: "no-positions" };

		log(`Stop liquidation: attempting to sell ${candidates.size} position(s)…`, "warn", true);
		let soldN = 0;
		for (const [mint, posMaybe] of candidates.entries()) {
			try {
				if (!_isMaybeMintStr(mint) || mint === SOL_MINT) continue;
				const pos = (posMaybe && typeof posMaybe === "object") ? posMaybe : (state.positions?.[mint] || { sizeUi: 0, costSol: 0, acquiredAt: now(), awaitingSizeSync: true });

				// Refresh size from chain (and restore local state if it was missing).
				let chain = null;
				try { chain = await getTokenBalanceUiByMint(ownerStr, mint); } catch {}
				const chainUi = Number(chain?.sizeUi || 0);
				const chainDec = Number.isFinite(Number(chain?.decimals)) ? Number(chain.decimals) : Number(pos.decimals || 6);
				if (!(chainUi > 0)) continue;

				// Restore local tracking so subsequent code paths don't "forget" holdings.
				try {
					state.positions = state.positions && typeof state.positions === "object" ? state.positions : {};
					if (!state.positions[mint]) state.positions[mint] = pos;
					state.positions[mint].sizeUi = chainUi;
					state.positions[mint].decimals = chainDec;
					state.positions[mint].awaitingSizeSync = false;
					state.positions[mint].lastSeenAt = now();
					posStore.updatePosCache(ownerStr, mint, chainUi, chainDec);
				} catch {}

				// Skip true dust positions that can't be sold.
				try {
					const rawNum = Math.floor(chainUi * Math.pow(10, Number(chainDec || 6)));
					const minRaw = minRawForJupQuote(chainDec);
					if (rawNum > 0 && rawNum < minRaw) continue;
				} catch {}

				const p2 = state.positions?.[mint];
				if (!p2 || !(Number(p2.sizeUi || 0) > 0)) continue;

				const ctx = _mkSellCtx({ kp, mint, pos: p2, nowTs: now() });
				ctx.minNotional = minSellNotionalSol();
				// Treat stop-liquidation like a fast exit: bypass router cooldown but avoid extreme slippage.
				ctx.isFastExit = true;
				ctx.forceMomentum = true;
				ctx.forceExpire = false;
				ctx.decision = { action: "sell_all", reason: "USER_STOP" };

				await _enrichSellCtx(ctx);
				await executeSellDecisionPolicy(ctx);
				soldN++;
				await new Promise((r) => setTimeout(r, 250));
			} catch (e) {
				log(`Stop liquidation error for ${String(mint || "").slice(0, 4)}… ${e?.message || e}`, "warn", true);
			}
		}

		try { await unwrapWsolIfAny(kp); } catch {}
		return { ok: true, sold: soldN };
	} catch (e) {
		log(`Stop liquidation error: ${e?.message || e}`, "warn", true);
		return { ok: false, sold: 0, reason: "exception" };
	}
}

async function stopSniper() {
	if (!state.enabled) return;
	_acceptLogs = true;
	log("Stop requested. Liquidating positions…", "warn", true);
	state.enabled = false;
	try { setBotRunning('sniper', false); } catch {}
	_runNonce++;
	saveState();
	try {
		if (_timer) clearInterval(_timer);
	} catch {}
	_timer = null;
	stopSentryPrefetch();

	// If a tick/swap is in progress, wait a moment for it to settle.
	try {
		const start = now();
		while ((_inFlight || _tickInFlight) && (now() - start < 10_000)) {
			await new Promise((r) => setTimeout(r, 200));
		}
	} catch {}

	try { await liquidateAllPositionsOnStop(); } catch {}
	updateUI();
	log("Sniper stopped.", "warn", true);
	_acceptLogs = false;
}

async function __fdvCli_applySniperConfig(cfg = {}) {
	try {
		if (!cfg || typeof cfg !== "object") return;
		if (cfg.mint) state.mint = String(cfg.mint).trim();
		if (cfg.sentryEnabled !== undefined) state.sentryEnabled = !!cfg.sentryEnabled;
		if (cfg.flameEnabled !== undefined) state.flameEnabled = !!cfg.flameEnabled;
		if (state.sentryEnabled && state.flameEnabled) state.flameEnabled = false;
		if (cfg.pollMs) state.pollMs = Math.floor(clamp(Number(cfg.pollMs), 250, 60_000));
		if (cfg.buyPct) state.buyPct = Math.floor(clamp(Number(cfg.buyPct), 1, 70));
		if (cfg.triggerScoreSlopeMin !== undefined) state.triggerScoreSlopeMin = clamp(Number(cfg.triggerScoreSlopeMin), 0, 20);
		// Back-compat: treat legacy takeProfitPct/maxProfitPct as pnlTargetStartPct.
		if (cfg.pnlTargetStartPct !== undefined) state.pnlTargetStartPct = clamp(Number(cfg.pnlTargetStartPct), 0, 50);
		if (cfg.takeProfitPct !== undefined) state.pnlTargetStartPct = clamp(Number(cfg.takeProfitPct), 0, 50);
		if (cfg.maxProfitPct !== undefined) state.pnlTargetStartPct = clamp(Number(cfg.maxProfitPct), 0, 50);
		if (cfg.pnlTargetFloorPct !== undefined) state.pnlTargetFloorPct = clamp(Number(cfg.pnlTargetFloorPct), 0, 50);
		if (cfg.pnlTargetDecayPct !== undefined) state.pnlTargetDecayPct = clamp(Number(cfg.pnlTargetDecayPct), 0, 50);
		if (cfg.pnlTargetDecayWindowMin !== undefined) state.pnlTargetDecayWindowMin = clamp(Number(cfg.pnlTargetDecayWindowMin), 1, 240);
		state.pnlTargetStartPct = clamp(Number(state.pnlTargetStartPct ?? PNL_TARGET_DEFAULT_START_PCT), Number(state.pnlTargetFloorPct ?? PNL_TARGET_DEFAULT_FLOOR_PCT), 50);
		saveState();
	} catch {}
}

async function __fdvCli_startSniper(cfg = {}) {
	if (!_isNodeLike()) return 1;
	_acceptLogs = true;
	_runNonce++;
	loadState();
	await __fdvCli_applySniperConfig(cfg);
	if (!state.mint) throw new Error("SNIPER_MISSING_MINT");
	state.enabled = true;
	try { setBotRunning('sniper', true); } catch {}
	saveState();
	log(`Sniper started (headless). Mint=${String(state.mint).slice(0, 6)}…`, "ok", true);
	if (_timer) clearInterval(_timer);
	_timer = setInterval(() => void tickOnce(), Math.max(250, Number(state.pollMs || 1200)));
	await tickOnce();
	return 0;
}

async function __fdvCli_stopSniper() {
	if (!_isNodeLike()) return 1;
	await stopSniper();
	return 0;
}

export const __fdvCli_applyConfig = __fdvCli_applySniperConfig;
export const __fdvCli_start = __fdvCli_startSniper;
export const __fdvCli_stop = __fdvCli_stopSniper;

export function initSniperWidget(container = document.body) {
	loadState();

	const wrap = container;
	while (wrap.firstChild) wrap.removeChild(wrap.firstChild);

	const outer = document.createElement("div");
	outer.className = "fdv-follow-wrap";
	outer.innerHTML = `
		<div class="fdv-tab-content active" data-tab-content="sniper">
			<div class="fdv-grid">
				<label>Target Mint <input id="sniper-mint" type="text" placeholder="Mint address"></label>
				<label>Poll (ms) <input id="sniper-poll" type="number" min="250" max="60000" step="50"></label>
				<label>Buy % (1-70%) <input id="sniper-buy-pct" type="number" min="1" max="70" step="1"></label>
				<label>Trigger score slope (/min) <input id="sniper-trigger" type="number" min="0" max="20" step="0.1"></label>
				<label>Target start %<input id="sniper-max-profit" type="number" min="2" max="50" step="0.25"></label>
			</div>

			<div class="fdv-log" id="sniper-log"></div>
			<div class="fdv-actions" style="margin-top:6px;">
				<div class="fdv-actions-left" style="display:flex; flex-direction:row; gap:4px;">
					<label style="display:flex;flex-direction:row;align-items:center;gap:4px;">Sentry<input id="sniper-sentry" type="checkbox"></label>
					<label style="display:flex;flex-direction:row;align-items:center;gap:4px;">Flame<input id="sniper-flame" type="checkbox"></label>
				</div>
				<div class="fdv-actions-right">
					<button id="fdv-sniper-start">Start</button>
					<button id="fdv-sniper-stop">Stop</button>
				</div>
			</div>
		</div>
	`;

	wrap.appendChild(outer);

	// Match Follow's lookup style.
	mintEl = document.getElementById("sniper-mint");
	sentryEl = document.getElementById("sniper-sentry");
	flameEl = document.getElementById("sniper-flame");
	pollEl = document.getElementById("sniper-poll");
	buyPctEl = document.getElementById("sniper-buy-pct");
	triggerEl = document.getElementById("sniper-trigger");
	maxProfitEl = document.getElementById("sniper-max-profit");
	logEl = document.getElementById("sniper-log");
	startBtn = document.getElementById("fdv-sniper-start");
	stopBtn = document.getElementById("fdv-sniper-stop");
	statusEl = document.getElementById("sniper-status");

	if (mintEl) mintEl.value = String(state.mint || "");
	if (sentryEl) sentryEl.checked = !!state.sentryEnabled;
	if (flameEl) flameEl.checked = !!state.flameEnabled && !state.sentryEnabled;
	if (pollEl) pollEl.value = String(state.pollMs || 1200);
	if (buyPctEl) buyPctEl.value = String(state.buyPct || 25);
	if (triggerEl) triggerEl.value = String(state.triggerScoreSlopeMin || 0.6);
	if (maxProfitEl) maxProfitEl.value = String(Number(state.pnlTargetStartPct ?? PNL_TARGET_DEFAULT_START_PCT));

	sentryEl?.addEventListener("change", () => {
		state.sentryEnabled = !!sentryEl.checked;
		if (state.sentryEnabled) {
			state.flameEnabled = false;
			try { if (flameEl) flameEl.checked = false; } catch {}
		}
		saveState();
		if (state.enabled && state.sentryEnabled) startSentryPrefetch();
		if (!state.sentryEnabled) stopSentryPrefetch();
		updateUI();
	});

	flameEl?.addEventListener("change", () => {
		state.flameEnabled = !!flameEl.checked;
		if (state.flameEnabled) {
			state.sentryEnabled = false;
			try { if (sentryEl) sentryEl.checked = false; } catch {}
			try { stopSentryPrefetch(); } catch {}
		}
		saveState();
		updateUI();
	});

	startBtn?.addEventListener("click", async () => {
		await startSniper();
	});
	stopBtn?.addEventListener("click", async () => {
		await stopSniper();
	});

	updateUI();
	if (state.enabled) {
		log("Sniper was enabled from last session; resuming.", "help");
		void startSniper();
	}
}

// rawr