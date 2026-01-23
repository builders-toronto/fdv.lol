import { setBotRunning } from "../lib/led.js";
import { createSolanaDepsLoader } from "../lib/solana/deps.js";
import { createConnectionGetter } from "../lib/solana/connection.js";
import { createConfirmSig } from "../lib/solana/confirm.js";
import { clamp, safeNum } from "../lib/util.js";
import { computeEdgeCaseCostLamports, recommendTargetProfitPct, lamportsToSol } from "../lib/edgeCase.js";
import {
	EDGE_TX_FEE_ESTIMATE_LAMPORTS,
	FEE_RESERVE_MIN,
	FEE_RESERVE_PCT,
	MAX_CONSEC_SWAP_400,
	MIN_QUOTE_RAW_AMOUNT,
	MIN_SELL_CHUNK_SOL,
	MIN_JUP_SOL_IN,
	MINT_RUG_BLACKLIST_MS,
	ROUTER_COOLDOWN_MS,
	RUG_FORCE_SELL_SEVERITY,
	SMALL_SELL_FEE_FLOOR,
	SOL_MINT,
	SPLIT_FRACTIONS,
	TX_FEE_BUFFER_LAMPORTS,
	FEE_ATAS,
	AUTO_CFG,
} from "../lib/constants.js";
import { createDex } from "../lib/dex.js";
import { getAutoTraderState } from "../trader/index.js";
import { getRugSignalForMint } from "../../../meme/metrics/kpi/pumping.js";
import { createPnlFadeExitPolicy, pushPnlFadeSample } from "../lib/sell/policies/pnlFadeExit.js";
import { preflightBuyLiquidity, DEFAULT_BUY_EXIT_CHECK_FRACTION, DEFAULT_BUY_MAX_PRICE_IMPACT_PCT } from "../lib/liquidity.js";
import { withTimeout } from "../lib/async.js";
import { mountGiscus, unmountGiscus } from "../../chat/chat.js";
import { loadSplToken } from "../../../../core/solana/splToken.js";
import { createDextoolsCandlestickEmbed } from "../lib/tools/dextoolsCandlestickEmbed.js";
import { FDV_PLATFORM_FEE_BPS } from "../../../../config/env.js";
import { createRoundtripEdgeEstimator } from "../lib/honeypot.js";

const HOLD_SINGLE_LS_KEY = "fdv_hold_bot_v1";
const HOLD_TABS_LS_KEY = "fdv_hold_tabs_v1";

const HOLD_MAX_TABS = 3;

const MAX_LOG_ENTRIES = 120;

const HOLD_RUG_DEFAULT_SEV_THRESHOLD = clamp(safeNum(RUG_FORCE_SELL_SEVERITY, 1), 1, 4);

const DEFAULTS = Object.freeze({
	ledgerKind: "hold",
	enabled: false,
	mint: "",
	pollMs: 1500,
	buyPct: 25,
	profitPct: 5,
	rugSevThreshold: HOLD_RUG_DEFAULT_SEV_THRESHOLD,
	repeatBuy: false,
	uptickEnabled: true,
	dextoolsOpen: false,
});

const UPTICK_PROBE_SOL = 0.01; // fixed probe amount for "price" signal
const UPTICK_MIN_DROP_PCT = 0.25; // fewer tokens for same SOL => price uptick

const UPTICK_PROBE_MIN_INTERVAL_MS = 2500;
const HOLD_EXIT_QUOTE_MIN_INTERVAL_MS = 6000;

const HOLD_SELL_CONFIRM_MS = 6000;
const HOLD_EXIT_DEBIT_TIMEOUT_MS = 12_000;
const HOLD_EXIT_DEBIT_POLL_MS = 300;

const HOLD_FADE_EXIT_ENABLED = true;
const HOLD_FADE_MIN_AGE_MS = 18_000; // wait a bit after entry
const HOLD_FADE_MIN_PEAK_PCT = 0.75; // must have seen meaningful green
const HOLD_FADE_MIN_POSITIVE_NOW_PCT = 0.10; // still basically green
const HOLD_FADE_MIN_SAMPLES = 5;
const HOLD_FADE_DOWNTREND_POINTS = 3;
const HOLD_FADE_EPS_PCT = 0.05;

// Trade execution should match Sniper: long-timeout swaps, liquidity preflight,
// and dynamic slippage that responds to RPC backoff.
const DYN_SLIP_MIN_BPS = 50;
const DYN_SLIP_MAX_BPS = 2500;

const { loadWeb3, loadBs58 } = createSolanaDepsLoader({
	cacheKeyPrefix: "fdv:hold",
	web3Version: "1.95.4",
	bs58Version: "6.0.0",
});

async function isValidPubkeyStr(s) {
	try {
		const { PublicKey } = await loadWeb3();
		// eslint-disable-next-line no-new
		new PublicKey(String(s || "").trim());
		return true;
	} catch {
		return false;
	}
}

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
	throwOnTimeout: true,
});

function rpcBackoffLeft() {
	try {
		return Math.max(0, Number(window._fdvRpcBackoffUntil || 0) - now());
	} catch {
		return 0;
	}
}

function markRpcStress(err, backoffMs = 1500) {
	try {
		const msg = String(err?.message || err || "");
		const code = String(err?.code || "");
		const isRate = /429|rate|Too\s*Many/i.test(msg);
		const is403 = /403/.test(msg);
		const isPlan = /-32602|plan|upgrade|limit/i.test(msg) || /plan|upgrade|limit/i.test(code);
		if (isRate || is403 || isPlan) {
			const until = now() + Math.max(300, backoffMs | 0);
			const prev = Number(window._fdvRpcBackoffUntil || 0);
			window._fdvRpcBackoffUntil = Math.max(prev, until);
		}
	} catch {}
}

function getDynamicSlippageBps(kind = "buy") {
	try {
		const base = kind === "sell" ? 300 : 250;
		let slip = base;
		try {
			const backoffMs = Number(rpcBackoffLeft() || 0);
			if (backoffMs > 0) slip += Math.min(800, Math.floor(backoffMs / 2000) * 100);
		} catch {}
		return Math.floor(clamp(slip, DYN_SLIP_MIN_BPS, DYN_SLIP_MAX_BPS));
	} catch {
		return 250;
	}
}

// === ATA-rent-aware sizing (copied from Sniper’s swap sizing helpers) ===
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

async function safeGetDecimalsFast(mint) {
	if (!mint) return 6;
	if (mint === SOL_MINT) return 9;
	try {
		const cfg = AUTO_CFG || {};
		const cached = Number(cfg?.tokenDecimals?.[mint]);
		if (Number.isFinite(cached)) return cached;
	} catch {}
	try {
		const conn = await getConn();
		const { PublicKey } = await loadWeb3();
		const info = await withTimeout(conn.getParsedAccountInfo(new PublicKey(mint), "processed"), 10_000, {
			label: "getParsedAccountInfo",
		});
		const d = Number(info?.value?.data?.parsed?.info?.decimals);
		if (Number.isFinite(d)) return d;
	} catch {}
	return 6;
}

let _dex;
function getDex() {
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

		now: () => Date.now(),
		log: () => {},
		logObj: () => {},
		getState: () => {
			const st = getAutoTraderState?.() || {};
			return { ...st, ledgerKind: "hold" };
		},

		getConn,
		loadWeb3,
		loadSplToken,
		loadDeps: async () => {
			const bs58 = await loadBs58();
			return { bs58 };
		},
		rpcBackoffLeft,
		markRpcStress,

		getCfg: () => AUTO_CFG,
		isValidPubkeyStr,
		tokenAccountRentLamports,
		requiredAtaLamportsForSwap,
		requiredOutAtaRentIfMissing: async () => 0,
		minSellNotionalSol: () => 0,
		safeGetDecimalsFast,
		confirmSig,
	});
	return _dex;
}

function now() {
	return Date.now();
}

function _isNodeLike() {
	try {
		return typeof process !== "undefined" && !!process.versions?.node;
	} catch {
		return false;
	}
}

function _safeJsonParse(raw) {
	try {
		return JSON.parse(String(raw));
	} catch {
		return null;
	}
}

function _newBotId() {
	try {
		return `hb_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
	} catch {
		return `hb_${Date.now()}`;
	}
}

function _coerceState(obj) {
	const parsed = obj && typeof obj === "object" ? obj : {};
	return {
		...DEFAULTS,
		...parsed,
		pollMs: clamp(safeNum(parsed.pollMs, DEFAULTS.pollMs), 250, 60_000),
		buyPct: clamp(safeNum(parsed.buyPct, DEFAULTS.buyPct), 10, 70),
		profitPct: clamp(safeNum(parsed.profitPct, DEFAULTS.profitPct), 0.1, 500),
		rugSevThreshold: clamp(safeNum(parsed.rugSevThreshold, DEFAULTS.rugSevThreshold), 1, 4),
		repeatBuy: !!parsed.repeatBuy,
		uptickEnabled: !!parsed.uptickEnabled,
		dextoolsOpen: parsed.dextoolsOpen === undefined ? DEFAULTS.dextoolsOpen : !!parsed.dextoolsOpen,
		mint: String(parsed.mint || "").trim(),
		enabled: !!parsed.enabled,
	};
}

function loadHoldTabsState() {
	try {
		if (typeof localStorage === "undefined") {
			const id = _newBotId();
			return {
				activeId: id,
				bots: [{ id, state: _coerceState(DEFAULTS) }],
			};
		}

		const rawTabs = localStorage.getItem(HOLD_TABS_LS_KEY);
		if (rawTabs) {
			const parsed = _safeJsonParse(rawTabs);
			const botsRaw = Array.isArray(parsed?.bots) ? parsed.bots : [];
			let bots = botsRaw
				.map((b) => ({ id: String(b?.id || "").trim(), state: _coerceState(b?.state || b) }))
				.filter((b) => !!b.id);
			if (bots.length > HOLD_MAX_TABS) bots = bots.slice(0, HOLD_MAX_TABS);
			if (bots.length) {
				const activeId = String(parsed?.activeId || bots[0].id);
				const cleaned = { activeId: bots.some((b) => b.id === activeId) ? activeId : bots[0].id, bots };
				try { localStorage.setItem(HOLD_TABS_LS_KEY, JSON.stringify(cleaned)); } catch {}
				return cleaned;
			}
		}

		// Migration from the old single-bot key.
		const rawSingle = localStorage.getItem(HOLD_SINGLE_LS_KEY);
		if (rawSingle) {
			const parsedSingle = _safeJsonParse(rawSingle);
			const id = _newBotId();
			const migrated = { activeId: id, bots: [{ id, state: _coerceState(parsedSingle || {}) }] };
			try {
				localStorage.setItem(HOLD_TABS_LS_KEY, JSON.stringify(migrated));
				localStorage.removeItem(HOLD_SINGLE_LS_KEY);
			} catch {}
			return migrated;
		}

		const id = _newBotId();
		return { activeId: id, bots: [{ id, state: _coerceState(DEFAULTS) }] };
	} catch {
		const id = _newBotId();
		return { activeId: id, bots: [{ id, state: _coerceState(DEFAULTS) }] };
	}
}

function saveHoldTabsState(tabsState) {
	try {
		if (typeof localStorage === "undefined") return;
		const activeId = String(tabsState?.activeId || "").trim();
		const bots = Array.isArray(tabsState?.bots) ? tabsState.bots : [];
		const cleaned = bots
			.map((b) => ({ id: String(b?.id || "").trim(), state: _coerceState(b?.state || b) }))
			.filter((b) => !!b.id);
		const payload = {
			activeId: cleaned.some((b) => b.id === activeId) ? activeId : (cleaned[0]?.id || ""),
			bots: cleaned,
		};
		localStorage.setItem(HOLD_TABS_LS_KEY, JSON.stringify(payload));
	} catch {}
}

function _shortMint(m) {
	const s = String(m || "");
	return s.length > 8 ? `${s.slice(0, 4)}…${s.slice(-4)}` : s;
}

async function getAutoKeypair() {
	const st = getAutoTraderState();
	const sec = String(st?.autoWalletSecret || "").trim();
	if (!sec) throw new Error("Auto wallet secret missing (configure in Auto tab)");
	const { Keypair } = await loadWeb3();
	const bs58 = await loadBs58();
	const dec = (bs58?.decode ? bs58 : bs58?.default)?.decode;
	if (typeof dec !== "function") throw new Error("bs58 decode unavailable");
	const sk = dec(sec);
	return Keypair.fromSecretKey(sk);
}

function _getPosForMint(mint) {
	try {
		const st = getAutoTraderState();
		const p = st?.positions?.[mint];
		if (!p || typeof p !== "object") return null;
		const sizeUi = Number(p.sizeUi || 0);
		if (!(sizeUi > 0)) return null;
		return p;
	} catch {
		return null;
	}
}

function _toRawBig(amountUi, decimals = 6) {
	const d = Math.max(0, Math.min(12, Number(decimals || 0) | 0));
	const scale = Math.pow(10, d);
	const n = Number(amountUi || 0);
	if (!Number.isFinite(n) || n <= 0) return 0n;
	const raw = Math.floor(n * scale + 1e-9);
	try {
		return BigInt(raw);
	} catch {
		return 0n;
	}
}

async function _probeOutRaw(mint) {
	const inLamports = Math.floor(UPTICK_PROBE_SOL * 1e9);
	const q = await getDex().quoteGeneric(SOL_MINT, mint, String(inLamports), 250);
	const out = q?.outAmount;
	if (!out) return null;
	try {
		return BigInt(out);
	} catch {
		return null;
	}
}

async function _shouldBuyOnUptick(mint, prevProbe) {
	try {
		if (prevProbe?.at && (now() - Number(prevProbe.at || 0) < UPTICK_PROBE_MIN_INTERVAL_MS)) {
			return { ok: false, reason: "COOLDOWN", nextProbe: prevProbe };
		}
	} catch {}
	const cur = await _probeOutRaw(mint);
	if (cur === null) return { ok: false, reason: "NO_QUOTE", nextProbe: { outRawBig: null, at: now() } };
	const nextProbe = { outRawBig: cur, at: now() };
	if (!prevProbe || prevProbe.outRawBig === null) return { ok: false, reason: "NEED_BASELINE", nextProbe };
	if (!(prevProbe.outRawBig > 0n)) return { ok: false, reason: "BAD_BASELINE", nextProbe };

	const drop = Number((prevProbe.outRawBig - cur) * 10000n / prevProbe.outRawBig) / 100;
	return { ok: drop >= UPTICK_MIN_DROP_PCT, dropPct: drop, prevOutRaw: prevProbe.outRawBig, curOutRaw: cur, nextProbe };
}

async function _estimateExitSolForPosition(mint, pos) {
	try {
		const decimals = Number.isFinite(pos?.decimals) ? Number(pos.decimals) : 6;
		const raw = _toRawBig(Number(pos.sizeUi || 0), decimals);
		if (!(raw > 0n)) return 0;
		const st = getAutoTraderState();
		const slip = Math.max(50, Math.min(2000, Number(st?.slippageBps || 250) | 0));
		const q = await getDex().quoteGeneric(mint, SOL_MINT, raw.toString(), slip);
		const out = q?.outAmount;
		if (!out) return 0;
		const lamports = BigInt(out);
		return Number(lamports) / 1e9;
	} catch {
		return 0;
	}
}

async function _estimateExitSolFromUiAmount(mint, sizeUi, decimals = 6) {
	try {
		const raw = _toRawBig(Number(sizeUi || 0), Number.isFinite(decimals) ? Number(decimals) : 6);
		if (!(raw > 0n)) return 0;
		const st = getAutoTraderState();
		const slip = Math.max(50, Math.min(2000, Number(st?.slippageBps || 250) | 0));
		const q = await getDex().quoteGeneric(mint, SOL_MINT, raw.toString(), slip);
		const out = q?.outAmount;
		if (!out) return 0;
		return Number(BigInt(out)) / 1e9;
	} catch {
		return 0;
	}
}

async function _getOwnerSolBalanceUi(ownerPubkey) {
	try {
		const conn = await getConn();
		const lamports = await conn.getBalance(ownerPubkey, "confirmed");
		return Math.max(0, Number(lamports || 0) / 1e9);
	} catch {
		return 0;
	}
}

function _getAutoUiCachedSolBalanceUi(ownerPubkeyStr) {
	try {
		const want = String(ownerPubkeyStr || "").trim();
		if (!want) return null;

		const g = typeof window !== "undefined" ? window : globalThis;
		const v = Number(g?._fdvLastSolBal);
		if (!Number.isFinite(v) || v < 0) return null;

		// Prefer explicit pubkey tagging (newer Auto UI).
		const pub = String(g?._fdvLastSolBalPub || "").trim();
		const at = Number(g?._fdvLastSolBalAt || 0);
		if (!pub || pub !== want) return null;
		if (!(at > 0) || (Date.now() - at) > 60_000) return null;

		return v;
	} catch {
		return null;
	}
}

async function _getOwnerSolBalanceUiPreferCache(ownerPubkeyStr, ownerPubkey) {
	const cached = _getAutoUiCachedSolBalanceUi(ownerPubkeyStr);
	if (Number.isFinite(cached)) return { solBal: cached, fromCache: true };
	const sol = await _getOwnerSolBalanceUi(ownerPubkey);
	return { solBal: sol, fromCache: false };
}

function _reserveSol(balanceSol) {
	const bal = Math.max(0, Number(balanceSol || 0));
	const pct = Math.max(0, Math.min(0.5, Number(FEE_RESERVE_PCT || 0)));
	const min = Math.max(0, Number(FEE_RESERVE_MIN || 0));
	return Math.max(min, bal * pct);
}

function _upsertAutoPosFromCredit({ mint, sizeUi, decimals, addCostSol = 0 } = {}) {
	try {
		const m = String(mint || "").trim();
		const s = Number(sizeUi || 0);
		if (!m || !(s > 0)) return false;
		const dRaw = Number(decimals);
		const d = Number.isFinite(dRaw) ? dRaw : 6;
		const st = getAutoTraderState();
		st.positions = st.positions && typeof st.positions === "object" ? st.positions : {};
		const prev = st.positions[m] || { costSol: 0, hwmSol: 0, acquiredAt: now() };
		const add = Math.max(0, Number(addCostSol || 0));
		const pos = {
			...prev,
			sizeUi: s,
			decimals: d,
			awaitingSizeSync: false,
			lastSeenAt: now(),
		};
		if (add > 0) {
			pos.costSol = Number(pos.costSol || 0) + add;
			pos.hwmSol = Math.max(Number(pos.hwmSol || 0), add);
			pos.lastBuyAt = now();
			if (!Number(pos.acquiredAt || 0)) pos.acquiredAt = now();
		}
		st.positions[m] = pos;
		return true;
	} catch {
		return false;
	}
}

function _setAutoPosCostIfMissing(mint, costSol) {
	try {
		const m = String(mint || "").trim();
		const c = Math.max(0, Number(costSol || 0));
		if (!m || !(c > 0)) return false;
		const st = getAutoTraderState();
		if (!st?.positions || typeof st.positions !== "object") return false;
		const p = st.positions[m];
		if (!p || typeof p !== "object") return false;
		const prevCost = Number(p.costSol || 0);
		if (prevCost > 0) return false;
		p.costSol = c;
		p.hwmSol = Math.max(Number(p.hwmSol || 0), c);
		if (!Number(p.lastBuyAt || 0)) p.lastBuyAt = now();
		if (!Number(p.acquiredAt || 0)) p.acquiredAt = now();
		return true;
	} catch {
		return false;
	}
}

function _clearAutoPosForMint(mint) {
	try {
		const m = String(mint || "").trim();
		if (!m) return;
		const st = getAutoTraderState();
		if (!st?.positions || typeof st.positions !== "object") return;
		delete st.positions[m];
	} catch {}
}
function createHoldBotInstance({ id, initialState, onPersist, onAnyRunningChanged, onLabelChanged } = {}) {
	const botId = String(id || "").trim() || _newBotId();
	let state = _coerceState(initialState || {});

	let logEl;
	let startBtn;
	let stopBtn;
	let chartBtn;
	let mintEl;
	let pollEl;
	let buyPctEl;
	let profitEl;
	let edgeCostEl;
	let edgeRecEl;
	let edgeRecHintEl;
	let edgeBadgeEl;
	let repeatEl;
	let uptickEl;
	let rugSevEl;
	let rugSevLabelEl;
	let _persistDebounceTimer = null;
	let _edgeUiTimer = 0;
	let _edgeUiNonce = 0;
	let _edgeUiCache = { at: 0, mint: "", ownerStr: "", edgeCostLamports: 0, buySol: 0, recPct: null, solBal: 0, buyPct: 0 };

	function _fallbackBasisSol() {
		try {
			const st = getAutoTraderState?.() || {};
			const minB = Number(st?.minBuySol);
			const maxB = Number(st?.maxBuySol);
			if (Number.isFinite(minB) && Number.isFinite(maxB) && minB > 0 && maxB > 0) {
				return Math.max(minB, Math.min(maxB, (minB + maxB) / 2));
			}
			if (Number.isFinite(minB) && minB > 0) return minB;
			if (Number.isFinite(maxB) && maxB > 0) return maxB;
		} catch {}
		return 0.05; // safe-ish fallback basis when balance is unavailable
	}

	let _timer = null;
	let _tickInFlight = false;
	let _runNonce = 0;
	let _acceptLogs = true;
	let _lastProbe = null; // { outRawBig, at }
	let _lastExitQuote = null; // { mint, sizeUi, decimals, solUi, at }
	let _rugStopPending = false;
	let _pendingEntry = null; // { mint, sig, at, until, ownerStr, addCostSol, lastReconAt, lastCreditProbeAt }
	let _pendingExit = null; // { mint, sig, at, ownerStr, prevSizeUi }
	let _cycle = null; // { mint, ownerStr, costSol, sizeUi, decimals, enteredAt, lastSeenAt }
	let _fadePos = null; // { mint, _pnlFade: { ... } }
	let _lastPnlPct = NaN;
	let _lastPnlAt = 0;
	let _lastPnlCostSol = 0;
	let _lastPnlEstOutSol = 0;
	let _dextoolsChart = null;
	let _dextoolsJiggleTimer = null;
	let _startJiggleTimer = null;
	let _dextoolsDetailsEl = null;
	let _dextoolsSummaryRowEl = null;
	let _chatMountId = "";
	let _chatLastMint = "";
	let _chatRefreshBtn = null;
	let _isActive = false;

	const _traceLast = new Map();

	function _persist() {
		try {
			if (typeof onPersist === "function") onPersist(botId, { ...state });
		} catch {}
	}

	function _emitAnyRunning() {
		try {
			if (typeof onAnyRunningChanged === "function") onAnyRunningChanged();
		} catch {}
	}

	function _emitLabelChanged() {
		try {
			if (typeof onLabelChanged === "function") onLabelChanged(botId);
		} catch {}
	}

	function log(msg, type = "info", force = false) {
		try {
			if (!_acceptLogs && !force) return;
			const line = `[${new Date().toLocaleTimeString()}] ${String(msg ?? "")}`;
			try {
				const wantConsole = !!(typeof window !== "undefined" && window._fdvLogToConsole);
				const nodeLike = typeof process !== "undefined" && !!process?.stdout;
				if ((wantConsole || (nodeLike && !logEl)) && line) {
					const t = String(type || "").toLowerCase();
					if (t.startsWith("err")) console.error(line);
					else if (t.startsWith("war")) console.warn(line);
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

	const estimateRoundtripEdgePct = createRoundtripEdgeEstimator({
		solMint: SOL_MINT,
		quoteGeneric: (...args) => getDex().quoteGeneric(...args),
		requiredAtaLamportsForSwap,
		platformFeeBps: Number(FDV_PLATFORM_FEE_BPS || 0),
		txFeeEstimateLamports: EDGE_TX_FEE_ESTIMATE_LAMPORTS,
		smallSellFeeFloorSol: SMALL_SELL_FEE_FLOOR,
		log,
	});

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

	function _hasActiveCycleForMint(mint) {
		try {
			const m = String(mint || "").trim();
			if (!m) return false;
			return !!(_cycle && _cycle.mint === m && Number(_cycle.costSol || 0) > 0);
		} catch {
			return false;
		}
	}

	function _setCycleFromCredit({ mint, ownerStr, costSol, sizeUi, decimals } = {}) {
		try {
			const m = String(mint || "").trim();
			const o = String(ownerStr || "").trim();
			const c = Math.max(0, Number(costSol || 0));
			const s = Math.max(0, Number(sizeUi || 0));
			const d = Number.isFinite(Number(decimals)) ? Number(decimals) : 6;
			if (!m || !(c > 0) || !(s > 0)) return false;
			_cycle = { mint: m, ownerStr: o, costSol: c, sizeUi: s, decimals: d, enteredAt: now(), lastSeenAt: now() };
			_fadePos = { mint: m };
			return true;
		} catch {
			return false;
		}
	}

	function _clearCycle(reason = "") {
		try {
			_cycle = null;
			_fadePos = null;
			if (reason) log(String(reason), "help");
		} catch {}
	}

	const pnlFadeExitPolicy = createPnlFadeExitPolicy({
		clamp,
		getState: () => ({
			pnlFadeExitEnabled: HOLD_FADE_EXIT_ENABLED,
			pnlFadeMinAgeMs: HOLD_FADE_MIN_AGE_MS,
			pnlFadeMinPeakPct: HOLD_FADE_MIN_PEAK_PCT,
			pnlFadeMinPositiveNowPct: HOLD_FADE_MIN_POSITIVE_NOW_PCT,
			pnlFadeMinSamples: HOLD_FADE_MIN_SAMPLES,
			pnlFadeDowntrendPoints: HOLD_FADE_DOWNTREND_POINTS,
			pnlFadeEpsPct: HOLD_FADE_EPS_PCT,
			// Match Hold's old behavior: compute required drop from target (t*0.25 clamped)
			// and allow exits even if we cross back to red.
			pnlFadeDropFromPeakPct: null,
			pnlFadeAllowCrossDown: true,
		}),
	});

	async function _tryReconcilePendingEntry(p) {
		try {
			if (!p || typeof p !== "object") return;
			const ownerStr = String(p.ownerStr || "").trim();
			const mint = String(p.mint || "").trim();
			if (!ownerStr || !mint) return;
			const t = now();
			const lastRecon = Number(p.lastReconAt || 0);
			if (t - lastRecon < 2500) return;
			p.lastReconAt = t;

			const lastProbe = Number(p.lastCreditProbeAt || 0);
			if (t - lastProbe >= 5500) {
				p.lastCreditProbeAt = t;
				const got = await getDex().waitForTokenCredit(ownerStr, mint, { timeoutMs: 1800, pollMs: 250 });
				if (Number(got?.sizeUi || 0) > 0) {
					const pos = _getPosForMint(mint);
					const posCost = Number(pos?.costSol || 0);
					const wantCost = Math.max(0, Number(p.addCostSol || 0));

					// IMPORTANT: a balance may appear in Auto positions with costSol=0 (e.g. size sync)
					// before Hold's short credit-wait sees it. Preserve pending cost and apply it once.
					let addCostSol = 0;
					if (!p.costApplied && wantCost > 0) {
						if (posCost <= 0) {
							const setOk = _setAutoPosCostIfMissing(mint, wantCost);
							// If we couldn't directly set (missing pos object), fall back to additive upsert.
							if (!setOk) addCostSol = wantCost;
						}
						p.costApplied = true;
					}

					_setCycleFromCredit({ mint, ownerStr, costSol: wantCost || posCost || 0, sizeUi: got.sizeUi, decimals: got.decimals });
					_upsertAutoPosFromCredit({ mint, sizeUi: got.sizeUi, decimals: got.decimals, addCostSol });
				}
			}
		} catch {}
	}

	function _readUiToState() {
		state.mint = String(mintEl?.value || state.mint || "").trim();
		state.pollMs = clamp(safeNum(pollEl?.value, state.pollMs), 250, 60_000);
		state.buyPct = clamp(safeNum(buyPctEl?.value, state.buyPct), 10, 70);
		state.profitPct = clamp(safeNum(profitEl?.value, state.profitPct), 0.1, 500);
		state.rugSevThreshold = clamp(safeNum(rugSevEl?.value, state.rugSevThreshold), 1, 4);
		state.repeatBuy = !!repeatEl?.checked;
		state.uptickEnabled = !!uptickEl?.checked;
		_emitLabelChanged();
		_persist();
		if (_isActive) _debouncedEdgeUiUpdate(250);
	}

	function _rugTier(sev) {
		const v = clamp(safeNum(sev, HOLD_RUG_DEFAULT_SEV_THRESHOLD), 1, 4);
		if (v < 1.5) return { label: "Low", colorVar: "--good" };
		if (v < 2.5) return { label: "Medium", colorVar: "--watch" };
		if (v < 3.5) return { label: "High", colorVar: "--fdv-warn" };
		return { label: "Extreme", colorVar: "--avoid" };
	}

	function _updateRugUi() {
		try {
			if (!rugSevEl) return;
			const sev = clamp(safeNum(rugSevEl.value, state.rugSevThreshold), 1, 4);
			const tier = _rugTier(sev);
			if (rugSevLabelEl) {
				rugSevLabelEl.textContent = `sev ≥ ${sev.toFixed(2)} (${tier.label})`;
				try {
					rugSevLabelEl.classList.remove(
						"fdv-hold-rug-tier-low",
						"fdv-hold-rug-tier-medium",
						"fdv-hold-rug-tier-high",
						"fdv-hold-rug-tier-extreme",
					);
					const k = String(tier.label || "").toLowerCase();
					if (k === "low") rugSevLabelEl.classList.add("fdv-hold-rug-tier-low");
					else if (k === "medium") rugSevLabelEl.classList.add("fdv-hold-rug-tier-medium");
					else if (k === "high") rugSevLabelEl.classList.add("fdv-hold-rug-tier-high");
					else rugSevLabelEl.classList.add("fdv-hold-rug-tier-extreme");
				} catch {}
			}
		} catch {}
	}

	function _debouncedPersist(ms = 200) {
		try {
			if (_persistDebounceTimer) clearTimeout(_persistDebounceTimer);
			_persistDebounceTimer = setTimeout(() => {
				_persistDebounceTimer = null;
				_persist();
			}, Math.max(0, Number(ms || 0)));
		} catch {
			_persist();
		}
	}

	function updateUI() {
		try {
			if (mintEl) mintEl.value = String(state.mint || "");
			if (pollEl) pollEl.value = String(state.pollMs || DEFAULTS.pollMs);
			if (buyPctEl) buyPctEl.value = String(state.buyPct || DEFAULTS.buyPct);
			if (profitEl) profitEl.value = String(state.profitPct || DEFAULTS.profitPct);
			if (rugSevEl) rugSevEl.value = String(clamp(safeNum(state.rugSevThreshold, DEFAULTS.rugSevThreshold), 1, 4));
			if (repeatEl) repeatEl.checked = !!state.repeatBuy;
			if (uptickEl) uptickEl.checked = !!state.uptickEnabled;
			if (startBtn) startBtn.disabled = !!state.enabled;
			if (stopBtn) stopBtn.disabled = !state.enabled;
			if (chartBtn) chartBtn.disabled = !String(state.mint || "").trim();
			_updateRugUi();
		} catch {}
	}

	function _dexscreenerUrlForMint(mint) {
		const m = String(mint || "").trim();
		if (!m) return "";
		return `https://dexscreener.com/solana/${encodeURIComponent(m)}`;
	}

	function _safeDomId(s) {
		try {
			return String(s || "")
				.replace(/[^a-zA-Z0-9_-]+/g, "_")
				.slice(0, 64);
		} catch {
			return "fdv_hold_chat";
		}
	}

	function _currentChatMint() {
		try {
			return String(_cycle?.mint || mintEl?.value || state.mint || "").trim();
		} catch {
			return String(state.mint || "").trim();
		}
	}

	function _unmountChat() {
		try {
			if (!_chatMountId) return;
			unmountGiscus({ containerId: _chatMountId });
		} catch {}
		_chatLastMint = "";
	}

	function _syncChat(opts = null) {
		try {
			if (!_chatMountId) return;
			const force = !!opts?.force;
			const m = _currentChatMint();
			if (!m) {
				_chatLastMint = "";
				try {
					const el = typeof document !== "undefined" ? document.getElementById(_chatMountId) : null;
					if (el) el.innerHTML = "";
				} catch {}
				return;
			}
			if (!force && _chatLastMint === m) return;
			_chatLastMint = m;
			mountGiscus({ mint: m, containerId: _chatMountId, theme: "dark", force });
		} catch {}
	}

	function _pulseJiggle(el) {
		try {
			if (!el) return;
			el.classList.remove("fdv-jiggle-hint");
			// Force a reflow so the animation reliably restarts.
			void el.offsetWidth;
			el.classList.add("fdv-jiggle-hint");
			setTimeout(() => {
				try {
					el.classList.remove("fdv-jiggle-hint");
				} catch {}
			}, 650);
		} catch {}
	}

	function onActiveChanged(isActive) {
		_isActive = !!isActive;
		try {
			_dextoolsChart?.setActive?.(_isActive);
		} catch {}
		try {
			if (_isActive) {
				if (!state.enabled) _pulseJiggle(startBtn);
				if (!(_dextoolsDetailsEl?.open) && _dextoolsSummaryRowEl) _pulseJiggle(_dextoolsSummaryRowEl);
			}
		} catch {}
		if (_isActive) _syncChat({ force: true });
		else _unmountChat();
		if (_isActive) _debouncedEdgeUiUpdate(50);
	}

	function _setEdgeUi({ edgeCostLamports = 0, recPct = null, basisSol = 0, solBal = null, buyPct = null, reason = "" } = {}) {
		try {
			if (edgeCostEl) edgeCostEl.textContent = edgeCostLamports > 0 ? `${lamportsToSol(edgeCostLamports).toFixed(6)} SOL` : "-";
			if (edgeRecEl) edgeRecEl.textContent = Number.isFinite(recPct) ? `${Number(recPct).toFixed(2)}%` : "-";
			if (edgeBadgeEl) {
				edgeBadgeEl.classList.remove("warn", "ok", "idle");
				const userTarget = Number(state.profitPct || DEFAULTS.profitPct);
				const warn = Number.isFinite(recPct) && Number.isFinite(userTarget) && (userTarget + 1e-9 < recPct);
				if (warn) {
					edgeBadgeEl.textContent = "EDGE HIGH";
					edgeBadgeEl.classList.add("warn");
				} else if (Number.isFinite(recPct)) {
					edgeBadgeEl.textContent = "EDGE OK";
					edgeBadgeEl.classList.add("ok");
				} else {
					edgeBadgeEl.textContent = "EDGE";
					edgeBadgeEl.classList.add("idle");
				}
			}
			if (edgeRecHintEl) {
				const userTarget = Number(state.profitPct || DEFAULTS.profitPct);
				if (Number.isFinite(recPct) && Number.isFinite(userTarget)) {
					const warn = userTarget + 1e-9 < recPct;
					const basisTxt = `${Math.max(0, Number(basisSol || 0)).toFixed(3)} SOL`;
					const balTxt = Number.isFinite(Number(solBal)) ? `${Math.max(0, Number(solBal)).toFixed(4)} SOL` : "?";
					const pctTxt = Number.isFinite(Number(buyPct)) ? `${Math.max(0, Number(buyPct)).toFixed(0)}%` : "";
					const suffix = (Number.isFinite(Number(solBal)) && Number(solBal) > 0)
						? ` (buy~${basisTxt}${pctTxt ? ` @${pctTxt}` : ""} of bal~${balTxt})`
						: ` (buy~${basisTxt})`;
					edgeRecHintEl.textContent = warn
						? `Target ${userTarget.toFixed(2)}% < breakeven ~${Number(recPct).toFixed(2)}%${suffix}.`
						: `Breakeven looks covered by your target.`;
					try {
						edgeRecHintEl.classList.toggle("fdv-hold-edge-hint-warn", warn);
						edgeRecHintEl.classList.toggle("fdv-hold-edge-hint-ok", !warn);
					} catch {}
					try {
						if (edgeRecEl) {
							edgeRecEl.classList.toggle("fdv-hold-edge-rec-warn", warn);
							edgeRecEl.classList.toggle("fdv-hold-edge-rec-ok", !warn);
							edgeRecEl.classList.remove("fdv-hold-edge-rec-muted");
						}
					} catch {}
				} else {
					const r = String(reason || "");
					if (r === "missing-mint") edgeRecHintEl.textContent = "Set a mint to estimate breakeven.";
					else if (r === "missing-wallet") edgeRecHintEl.textContent = "Set Auto wallet in Auto tab to estimate breakeven.";
					else if (r === "no-buy-room") edgeRecHintEl.textContent = "No buy room after reserving fees (lower Buy % or fund the wallet).";
					else if (r === "balance-unavailable") edgeRecHintEl.textContent = "Could not read SOL balance; rec target uses a typical buy size.";
					else if (r === "balance-zero") edgeRecHintEl.textContent = "Wallet balance is 0; rec target uses a typical buy size.";
					else edgeRecHintEl.textContent = "";
					try {
						edgeRecHintEl.classList.remove("fdv-hold-edge-hint-warn", "fdv-hold-edge-hint-ok");
					} catch {}
					try {
						if (edgeRecEl) {
							edgeRecEl.classList.remove("fdv-hold-edge-rec-warn", "fdv-hold-edge-rec-ok");
							edgeRecEl.classList.add("fdv-hold-edge-rec-muted");
						}
					} catch {}
				}
			}
		} catch {}
	}

	function _debouncedEdgeUiUpdate(ms = 250) {
		try {
			if (_edgeUiTimer) clearTimeout(_edgeUiTimer);
			_edgeUiTimer = setTimeout(() => {
				_edgeUiTimer = 0;
				void _updateEdgeUi();
			}, Math.max(0, Number(ms || 0)));
		} catch {
			void _updateEdgeUi();
		}
	}

	async function _updateEdgeUi() {
		const nonce = ++_edgeUiNonce;
		try {
			if (!edgeCostEl || !edgeRecEl) return;
			const mint = String(mintEl?.value || state.mint || "").trim();
			if (!mint) {
				_setEdgeUi({ edgeCostLamports: 0, recPct: null, basisSol: 0, reason: "missing-mint" });
				return;
			}

			let kp;
			try {
				kp = await getAutoKeypair();
			} catch {
				if (nonce !== _edgeUiNonce) return;
				_setEdgeUi({ edgeCostLamports: 0, recPct: null, basisSol: 0, reason: "missing-wallet" });
				return;
			}
			const ownerStr = (() => {
				try { return kp.publicKey.toBase58(); } catch { return ""; }
			})();
			if (!ownerStr) {
				_setEdgeUi({ edgeCostLamports: 0, recPct: null, basisSol: 0, reason: "missing-wallet" });
				return;
			}

			// Light cache to avoid spamming RPC while typing.
			try {
				const wantBuyPct = clamp(safeNum(state.buyPct, DEFAULTS.buyPct), 10, 70);
				const c = _edgeUiCache;
				if (
					now() - Number(c.at || 0) < 12_000 &&
					c.mint === mint &&
					c.ownerStr === ownerStr &&
					Math.abs(Number(c.buyPct || 0) - wantBuyPct) < 1e-9 &&
					Number.isFinite(c.recPct) &&
					Number.isFinite(c.buySol) &&
					c.buySol > 0
				) {
					_setEdgeUi({ edgeCostLamports: c.edgeCostLamports, recPct: c.recPct, basisSol: c.buySol, solBal: c.solBal, buyPct: c.buyPct, reason: "" });
					return;
				}
			} catch {}

			const { solBal: solBalRaw, fromCache } = await _getOwnerSolBalanceUiPreferCache(ownerStr, kp.publicKey);
			let solBal = solBalRaw;
			let solBalKnown = Number.isFinite(solBal) && (fromCache || solBal > 0);
			if (!solBalKnown) {
				// If balance read failed, prefer a recent cached non-zero balance for this wallet.
				try {
					const c = _edgeUiCache;
					if (c.ownerStr === ownerStr && now() - Number(c.at || 0) < 60_000 && Number(c.solBal || 0) > 0) {
						solBal = Number(c.solBal);
						solBalKnown = true;
					}
				} catch {}
			}
			const ataRentLamports = await requiredAtaLamportsForSwap(ownerStr, SOL_MINT, mint);

			const reserve = computeEdgeCaseCostLamports({
				ataRentLamports,
				txFeeEstimateLamports: EDGE_TX_FEE_ESTIMATE_LAMPORTS,
				txFeeBufferLamports: TX_FEE_BUFFER_LAMPORTS,
				includeBuffer: true,
			});
			const maxSpendSol = solBalKnown ? Math.max(0, solBal - reserve.totalLamports / 1e9) : 0;
			const buyPct = clamp(safeNum(state.buyPct, DEFAULTS.buyPct), 10, 70) / 100;
			const desired = solBalKnown ? Math.max(0, solBal * buyPct) : 0;
			const plannedBuySol = solBalKnown ? Math.min(desired, maxSpendSol) : 0;
			let basisSol = 0;
			let basisReason = "";
			if (solBalKnown && plannedBuySol > 0) {
				basisSol = plannedBuySol;
			} else if (solBalKnown && desired > 0 && maxSpendSol <= 0) {
				// Can't buy after reserving fees; don't show an absurd %.
				basisSol = 0;
				basisReason = "no-buy-room";
			} else if (solBalKnown && desired > 0) {
				// Should be rare, but keep a stable basis.
				basisSol = desired;
			} else if (solBalKnown && solBal === 0) {
				basisSol = Math.max(Number(MIN_JUP_SOL_IN || 0), _fallbackBasisSol());
				basisReason = "balance-zero";
			} else {
				basisSol = Math.max(Number(MIN_JUP_SOL_IN || 0), _fallbackBasisSol());
				basisReason = "balance-unavailable";
			}

			const edgeCost = computeEdgeCaseCostLamports({
				ataRentLamports,
				txFeeEstimateLamports: EDGE_TX_FEE_ESTIMATE_LAMPORTS,
				txFeeBufferLamports: 0,
				includeBuffer: false,
			});
			const recPct = basisSol > 0
				? recommendTargetProfitPct({ buySol: basisSol, edgeCostLamports: edgeCost.totalLamports, safetyBufferPct: 0.1, minPct: 0.1 })
				: null;

			if (nonce !== _edgeUiNonce) return;
			_edgeUiCache = { at: now(), mint, ownerStr, edgeCostLamports: edgeCost.totalLamports, buySol: basisSol, recPct, solBal: solBalKnown ? solBal : 0, buyPct: buyPct * 100 };
			_setEdgeUi({
				edgeCostLamports: edgeCost.totalLamports,
				recPct,
				basisSol,
				solBal: solBalKnown ? solBal : null,
				buyPct: buyPct * 100,
				reason: basisReason || (solBalKnown ? "" : "balance-unavailable"),
			});
		} catch {
			// Keep UI stable; avoid throwing from background refresh.
		}
	}

	async function tickOnce(runId) {
		if (!state.enabled) return;
		if (_tickInFlight) return;
		_tickInFlight = true;
		try {
			if (runId !== _runNonce) return;
			const mint = String(state.mint || "").trim();
			if (!mint) {
				log("Missing mint.", "warn");
				return;
			}

			// If a sell was already sent (fast mode), do not re-submit; wait for debit.
			try {
				const pe = _pendingExit;
				if (pe && pe.mint === mint) {
					const age = now() - Number(pe.at || 0);
					const left = Math.max(0, HOLD_EXIT_DEBIT_TIMEOUT_MS - age);
					traceOnce(
						`hold:${botId}:awaitDebit:${mint}`,
						`Sell sent; awaiting debit for ${_shortMint(mint)}… (${Math.ceil(left / 1000)}s window)`,
						2500,
						"help",
					);
					return;
				}
			} catch {}

			// EXTREME rug detection: block buys and force liquidation if already holding.
			let rugSig = null;
			let rugSev = 0;
			try {
				rugSig = getRugSignalForMint(mint);
				rugSev = Number(rugSig?.sev ?? rugSig?.severity ?? 0);
			} catch {
				rugSig = null;
				rugSev = 0;
			}

			const pos = _getPosForMint(mint);
			const rugThr = clamp(safeNum(state.rugSevThreshold, HOLD_RUG_DEFAULT_SEV_THRESHOLD), 1, 4);
			if (rugSig?.rugged && rugSev >= rugThr) {
				if (pos || _hasActiveCycleForMint(mint)) {
					traceOnce(
						`hold:${botId}:rug:liquidate:${mint}`,
						`EXTREME rug signal for ${_shortMint(mint)} sev=${rugSev.toFixed(2)} (thr=${rugThr.toFixed(2)}). Emergency liquidate…`,
						8000,
						"warn",
					);
					if (!_rugStopPending) {
						_rugStopPending = true;
						setTimeout(() => {
							try { _rugStopPending = false; } catch {}
							void stop({ liquidate: true });
						}, 0);
					}
					return;
				}
				traceOnce(
					`hold:${botId}:rug:blockBuy:${mint}`,
					`EXTREME rug signal for ${_shortMint(mint)} sev=${rugSev.toFixed(2)} (thr=${rugThr.toFixed(2)}). Blocking buys.`,
					9000,
					"warn",
				);
				return;
			}
			try {
				if (pos && _pendingEntry && _pendingEntry.mint === mint) {
					// Don't discard pending entry just because size synced: we may still need
					// to apply the buy cost to the Auto position.
					const posCost = Number(pos?.costSol || 0);
					const pendingCost = Math.max(0, Number(_pendingEntry.addCostSol || 0));
					if (posCost <= 0 && pendingCost > 0 && !_pendingEntry.costApplied) {
						try {
							_setAutoPosCostIfMissing(mint, pendingCost);
							_setCycleFromCredit({ mint, ownerStr: String(_pendingEntry.ownerStr || ""), costSol: pendingCost, sizeUi: Number(pos?.sizeUi || 0), decimals: Number(pos?.decimals || 6) });
							_pendingEntry.costApplied = true;
						} catch {}
					}
					if (Number(_getPosForMint(mint)?.costSol || 0) > 0 || _hasActiveCycleForMint(mint)) {
						_pendingEntry = null;
					}
				}
				if (!pos && _pendingEntry && _pendingEntry.mint === mint) {
					try { await _tryReconcilePendingEntry(_pendingEntry); } catch {}
					const pos2 = _getPosForMint(mint);
					if (pos2 || _hasActiveCycleForMint(mint)) {
						_pendingEntry = null;
					}
					if (_pendingEntry === null) {
						// Position appeared after reconciliation.
						return;
					}
					const left = Math.max(0, Number(_pendingEntry.until || 0) - now());
					if (left > 0) {
						traceOnce(
							`hold:${botId}:awaitCredit:${mint}`,
							`Buy submitted; awaiting position sync for ${_shortMint(mint)}… (${Math.ceil(left / 1000)}s left)${_pendingEntry.sig ? ` sig=${String(_pendingEntry.sig).slice(0, 6)}…` : ""}`,
							Math.max(2000, Math.min(9000, Number(state.pollMs || 1500) * 2)),
							"help",
						);
						return;
					}
					// Timed out waiting; allow another attempt.
					_pendingEntry = null;
				}
			} catch {}

			// If we have an active hold cycle, never attempt a new buy.
			if (!pos && _hasActiveCycleForMint(mint)) {
				// Refresh size occasionally (and detect manual sell -> clear cycle).
				try {
					const c = _cycle;
					if (c && c.ownerStr) {
						const got = await getDex().waitForTokenCredit(c.ownerStr, mint, { timeoutMs: 900, pollMs: 250 });
						if (Number(got?.sizeUi || 0) > 0) {
							c.sizeUi = Number(got.sizeUi || c.sizeUi);
							if (Number.isFinite(got.decimals)) c.decimals = got.decimals;
							c.lastSeenAt = now();
						} else {
							// If we can't see a balance for a while, assume the position is gone.
							const age = now() - Number(c.lastSeenAt || c.enteredAt || 0);
							if (age > 20_000) {
								_clearCycle(`No token balance detected for ${_shortMint(mint)}; clearing cycle.`);
							}
						}
					}
				} catch {}
			}

			if (!pos && !_hasActiveCycleForMint(mint)) {
				// Not holding yet: optionally wait for an uptick.
				if (state.uptickEnabled) {
					const up = await _shouldBuyOnUptick(mint, _lastProbe);
					try {
						if (up && "nextProbe" in up) _lastProbe = up.nextProbe;
					} catch {}
					if (!up?.ok) {
						const drop = Number(up?.dropPct || 0);
						const reason = String(up?.reason || "");
						traceOnce(
							`hold:${botId}:waitUptick:${mint}`,
							`Waiting for uptick on ${_shortMint(mint)}… probe=${UPTICK_PROBE_SOL.toFixed(3)} SOL drop=${drop.toFixed(2)}% (min ${UPTICK_MIN_DROP_PCT.toFixed(2)}%)${reason ? ` (${reason})` : ""}`,
							Math.max(1500, Math.min(8000, Number(state.pollMs || 1500) * 2)),
							"help",
						);
						return;
					}
					log(
						`Uptick detected on ${_shortMint(mint)} (drop=${Number(up?.dropPct || 0).toFixed(2)}%); buying…`,
						"ok",
					);
				}

				const buyPct = clamp(safeNum(state.buyPct, DEFAULTS.buyPct), 10, 70) / 100;
				const slip = getDynamicSlippageBps("buy");
				let kp;
				try {
					kp = await getAutoKeypair();
				} catch (e) {
					log(String(e?.message || e || "Wallet error"), "error");
					return;
				}

				const ownerStr = (() => {
					try { return kp.publicKey.toBase58(); } catch { return ""; }
				})();
				const { solBal } = await _getOwnerSolBalanceUiPreferCache(ownerStr, kp.publicKey);
				const ataRentLamports = await requiredAtaLamportsForSwap(ownerStr, SOL_MINT, mint);
				const reserveLamports = computeEdgeCaseCostLamports({
					ataRentLamports,
					txFeeEstimateLamports: EDGE_TX_FEE_ESTIMATE_LAMPORTS,
					txFeeBufferLamports: TX_FEE_BUFFER_LAMPORTS,
					includeBuffer: true,
				}).totalLamports;
				const maxSpendSol = Math.max(0, solBal - reserveLamports / 1e9);
				const desired = Math.max(0, solBal * buyPct);
				const buySol = Math.min(desired, maxSpendSol);
				if (!(buySol >= Math.max(0.001, MIN_JUP_SOL_IN))) {
					log(`Not enough SOL to buy (bal=${solBal.toFixed(4)}).`, "warn");
					return;
				}

				const chk = await preflightBuyLiquidity({
					dex: getDex(),
					solMint: SOL_MINT,
					mint,
					inputSol: buySol,
					slippageBps: slip,
					maxPriceImpactPct: DEFAULT_BUY_MAX_PRICE_IMPACT_PCT,
					exitCheckFraction: DEFAULT_BUY_EXIT_CHECK_FRACTION,
				});
				if (!chk?.ok) {
					log(`Buy blocked (liquidity): ${chk?.reason || "no-route"}`, "warn");
					return;
				}

				// Honeypot/unsellable protection: ensure a viable SOL round-trip quote exists.
				const edge = await estimateRoundtripEdgePct(ownerStr, mint, buySol, {
					slippageBps: slip,
					dynamicFee: true,
					ataRentLamports,
				});
				if (!edge) {
					log(`Buy blocked (edge): no round-trip quote for ${mint.slice(0, 6)}…`, "warn");
					return;
				}

				log(
					`Hold BUY ${mint.slice(0, 6)}… ~${buySol.toFixed(4)} SOL (slip=${slip}bps)`,
					"ok",
				);
				let sig = "";
				try {
					sig = await withTimeout(
						getDex().jupSwapWithKeypair({
							signer: kp,
							inputMint: SOL_MINT,
							outputMint: mint,
							amountUi: buySol,
							slippageBps: slip,
						}),
						75_000,
						{ label: "hold_buy" },
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
					return;
				}

				const res = { ok: false, sig };
				try {
					if (res?.sig) {
						log(`Buy sent (${String(res.sig).slice(0, 8)}…); awaiting token credit…`, "help");
					}
				} catch {}
				try {
					if (res?.sig) {
						const autoSt = getAutoTraderState();
						const graceMs = Math.max(60_000, Number(autoSt?.pendingGraceMs || 120_000));
						_pendingEntry = {
							mint,
							sig: res.sig,
							at: now(),
							until: now() + graceMs,
							ownerStr,
							addCostSol: buySol,
							lastReconAt: 0,
							lastCreditProbeAt: 0,
						};
						traceOnce(
							`hold:${botId}:pendingEntry:${mint}`,
							`Buy placed for ${_shortMint(mint)}; waiting up to ${Math.ceil(graceMs / 1000)}s for position sync…`,
							3000,
							"help",
						);
						try { void _tryReconcilePendingEntry(_pendingEntry); } catch {}
					}
				} catch {}
				log(`BUY submitted (pending credit): ${String(res?.sig || "")}`, "warn");

				try {
					if (ownerStr) {
						traceOnce(
							`hold:${botId}:creditWait:${mint}`,
							`Checking token credit for ${_shortMint(mint)} (up to ~8s)…`,
							2500,
							"help",
						);
						const got = await getDex().waitForTokenCredit(ownerStr, mint, { timeoutMs: 1200, pollMs: 300 });
						if (Number(got?.sizeUi || 0) > 0) {
							_setCycleFromCredit({ mint, ownerStr, costSol: buySol, sizeUi: got.sizeUi, decimals: got.decimals });
							let addCostSol = buySol;
							try {
								if (_pendingEntry && _pendingEntry.mint === mint) {
									if (_pendingEntry.costApplied) addCostSol = 0;
									else _pendingEntry.costApplied = true;
								}
							} catch {}
							_upsertAutoPosFromCredit({ mint, sizeUi: got.sizeUi, decimals: got.decimals, addCostSol });
							log(
								`Buy credited for ${_shortMint(mint)}: size≈${Number(got.sizeUi).toFixed(6)} (dec=${Number(got.decimals || 0) || 6}).`,
								"ok",
							);
							_pendingEntry = null;
						} else {
							traceOnce(
								`hold:${botId}:creditMiss:${mint}`,
								`No on-chain credit detected yet for ${_shortMint(mint)}; will keep reconciling in background.`,
								4000,
								"warn",
							);
						}
					}
				} catch (e) {
					traceOnce(
						`hold:${botId}:creditErr:${mint}`,
						`Token credit check failed: ${String(e?.message || e || "credit error")}`,
						6000,
						"warn",
					);
				}
				return;
			}

			// Holding: wait indefinitely until profit threshold met.
			const active = pos || (_hasActiveCycleForMint(mint) ? _cycle : null);
			if (!active) return;
			let cost = Number(active.costSol || 0);
			if (!(cost > 0)) {
				try {
					if (_cycle && _cycle.mint === mint && Number(_cycle.costSol || 0) > 0) cost = Number(_cycle.costSol || 0);
					else if (_pendingEntry && _pendingEntry.mint === mint && Number(_pendingEntry.addCostSol || 0) > 0) cost = Number(_pendingEntry.addCostSol || 0);
					if (cost > 0) _setAutoPosCostIfMissing(mint, cost);
				} catch {}
			}
			if (!(cost > 0)) {
				traceOnce(
					`hold:${botId}:costUnknown:${mint}`,
					`Holding ${_shortMint(mint)}… (cost unknown)` ,
					Math.max(2000, Math.min(9000, Number(state.pollMs || 1500) * 3)),
					"help",
				);
				return;
			}
			const estOut = pos
				? await (async () => {
					try {
						const last = _lastExitQuote;
						const age = now() - Number(last?.at || 0);
						const wantMint = String(last?.mint || "") === mint;
						if (wantMint && age < HOLD_EXIT_QUOTE_MIN_INTERVAL_MS && Number.isFinite(last?.solUi) && last.solUi > 0) {
							return Number(last.solUi);
						}
					} catch {}
					const out = await _estimateExitSolForPosition(mint, pos);
					try {
						if (out > 0) {
							_lastExitQuote = {
								mint,
								sizeUi: Number(pos?.sizeUi || 0),
								decimals: Number(pos?.decimals || 6),
								solUi: out,
								at: now(),
							};
						}
					} catch {}
					return out;
				})()
				: await (async () => {
					try {
						const last = _lastExitQuote;
						const age = now() - Number(last?.at || 0);
						const wantMint = String(last?.mint || "") === mint;
						if (wantMint && age < HOLD_EXIT_QUOTE_MIN_INTERVAL_MS && Number.isFinite(last?.solUi) && last.solUi > 0) {
							return Number(last.solUi);
						}
					} catch {}
					const out = await _estimateExitSolFromUiAmount(mint, Number(active.sizeUi || 0), Number(active.decimals || 6));
					try {
						if (out > 0) {
							_lastExitQuote = {
								mint,
								sizeUi: Number(active?.sizeUi || 0),
								decimals: Number(active?.decimals || 6),
								solUi: out,
								at: now(),
							};
						}
					} catch {}
					return out;
				})();
			if (!(estOut > 0)) {
				log(`Holding ${_shortMint(mint)}… (quote unavailable)`, "help");
				return;
			}
			const pnlPct = ((estOut - cost) / cost) * 100;
			const targetPct = Number(state.profitPct || DEFAULTS.profitPct);
			try {
				_lastPnlPct = pnlPct;
				_lastPnlAt = now();
				_lastPnlCostSol = cost;
				_lastPnlEstOutSol = estOut;
			} catch {}
			try {
				const m = String(mint || "").trim();
				if (m) {
					if (!_fadePos || _fadePos.mint !== m) _fadePos = { mint: m };
					pushPnlFadeSample(_fadePos, m, pnlPct, now());
				}
			} catch {}
			if (Number.isFinite(pnlPct)) {
				traceOnce(
					`hold:${botId}:pnl:${mint}`,
					`Holding ${_shortMint(mint)}… cost=${cost.toFixed(4)} SOL estOut=${estOut.toFixed(4)} SOL pnl=${pnlPct.toFixed(2)}% target=${targetPct.toFixed(2)}%`,
					Math.max(2000, Math.min(8000, Number(state.pollMs || 1500) * 2)),
					"info",
				);
			}

			let fade = { ok: false, reason: "" };
			try {
				if (HOLD_FADE_EXIT_ENABLED) {
					const enteredAt = Number(active?.enteredAt || active?.lastBuyAt || active?.acquiredAt || 0) || now();
					const ctx = {
						mint,
						pos: _fadePos,
						pnlPct,
						pnlNetPct: pnlPct,
						pnlTargetPct: targetPct,
						ageMs: now() - enteredAt,
						forceRug: false,
						inMinHold: false,
						decision: null,
					};
					pnlFadeExitPolicy(ctx);
					if (ctx?.decision && ctx.decision.action && ctx.decision.action !== "none") {
						const peak = Number(_fadePos?._pnlFade?.peakPct);
						fade = {
							ok: true,
							reason: Number.isFinite(peak)
								? `PnL fading: peak=${peak.toFixed(2)}% now=${pnlPct.toFixed(2)}% (target=${targetPct.toFixed(2)}%). Selling…`
								: `PnL fading under target. Selling…`,
						};
					}
				}
			} catch {}
			const hitTarget = pnlPct >= targetPct;
			if (!hitTarget && !fade?.ok) return;

			let kp;
			try {
				kp = await getAutoKeypair();
			} catch (e) {
				log(String(e?.message || e || "Wallet error"), "error");
				return;
			}
			let slip = getDynamicSlippageBps("sell");
			try {
				// If this tick is rug-driven liquidation, mirror Sniper’s wider exit slip.
				const rs = getRugSignalForMint(mint);
				const sev = Number(rs?.sev ?? rs?.severity ?? 0);
				const thr = clamp(safeNum(state.rugSevThreshold, HOLD_RUG_DEFAULT_SEV_THRESHOLD), 1, 4);
				if (rs?.rugged && sev >= thr) slip = Math.max(slip, 1500);
			} catch {}
			if (hitTarget) {
				log(`Profit target hit (${pnlPct.toFixed(2)}% ≥ ${targetPct.toFixed(2)}%). Selling…`, "ok");
			} else {
				log(String(fade?.reason || "PnL fading under target. Selling…"), "help");
			}
			const ownerStr = (() => {
				try { return kp.publicKey.toBase58(); } catch { return ""; }
			})();
			const prevSizeUi = Number(pos?.sizeUi || active?.sizeUi || 0);
			let sellUi = Number(pos?.sizeUi || active?.sizeUi || 0);
			try {
				const b = await getDex().getAtaBalanceUi(ownerStr, mint, Number(pos?.decimals || active?.decimals || 6));
				if (Number(b?.sizeUi || 0) > 0) sellUi = Number(b.sizeUi);
			} catch {}
			if (!(sellUi > 0)) {
				log(`Sell skipped: no on-chain balance to sell for ${_shortMint(mint)}.`, "warn");
				_lastProbe = null;
				_lastExitQuote = null;
				_pendingEntry = null;
				_pendingExit = null;
				_clearAutoPosForMint(mint);
				_clearCycle();
				if (!state.repeatBuy) {
					await stop({ liquidate: false });
					return;
				}
				return;
			}

			const res = await getDex().executeSwapWithConfirm(
				{ signer: kp, inputMint: mint, outputMint: SOL_MINT, amountUi: sellUi, slippageBps: slip },
				{ retries: 1, confirmMs: Math.max(15_000, Number(HOLD_SELL_CONFIRM_MS || 0)) },
			);

			if (res?.ok) {
				log(`Sell confirmed (${res.sig || "no-sig"}).`, "ok");
				_lastProbe = null;
				_lastExitQuote = null;
				_pendingEntry = null;
				_pendingExit = null;
				_clearAutoPosForMint(mint);
				_clearCycle();
				if (!state.repeatBuy) {
					await stop({ liquidate: false });
					return;
				}
				log("Repeat enabled; waiting for next entry.", "help");
				return;
			}

			if (res?.sig) {
				log(`Sell sent (${String(res.sig).slice(0, 8)}…); awaiting debit…`, "help");
				_pendingExit = { mint, sig: res.sig, at: now(), ownerStr, prevSizeUi };
				void (async () => {
					try {
						if (!ownerStr) return;
						const deb = await getDex().waitForTokenDebit(ownerStr, mint, prevSizeUi, {
							timeoutMs: HOLD_EXIT_DEBIT_TIMEOUT_MS,
							pollMs: HOLD_EXIT_DEBIT_POLL_MS,
						});
						if (deb?.debited) {
							log(`Sell debited (remain≈${Number(deb.remainUi || 0).toFixed(6)}).`, "ok");
							_lastProbe = null;
							_lastExitQuote = null;
							_pendingEntry = null;
							_pendingExit = null;
							_clearAutoPosForMint(mint);
							_clearCycle();
							if (!state.repeatBuy) {
								await stop({ liquidate: false });
								return;
							}
							log("Repeat enabled; waiting for next entry.", "help");
							return;
						}
						// If we timed out without seeing debit, allow retries.
						try {
							if (_pendingExit && _pendingExit.sig === res.sig) {
								log(`Sell debit not detected yet for ${_shortMint(mint)}; will retry if still holding.`, "warn");
								_pendingExit = null;
							}
						} catch {}
					} catch (e) {
						traceOnce(
							`hold:${botId}:debitWatchErr:${mint}`,
							`Debit watch failed for ${_shortMint(mint)}; will retry if still holding. (${String(e?.message || e || "debit error")})`,
							6000,
							"warn",
						);
						try { _pendingExit = null; } catch {}
					}
				})();
				return;
			}

			log(`Sell not confirmed (${res?.sig || "no-sig"}); will keep watching.`, "warn");
		} catch (e) {
			log(String(e?.message || e || "Tick error"), "err");
		} finally {
			_tickInFlight = false;
		}
	}

	function startLoop() {
		const runId = ++_runNonce;
		try { if (_timer) clearInterval(_timer); } catch {}
		_timer = setInterval(() => {
			void tickOnce(runId);
		}, Math.max(250, Number(state.pollMs || DEFAULTS.pollMs)));
	}

	async function start({ resume = false } = {}) {
		if (state.enabled && !resume) return;
		_readUiToState();
		state.enabled = true;
		_acceptLogs = true;
		_lastProbe = null;
		_pendingExit = null;
		_persist();
		_emitAnyRunning();
		updateUI();
		log(
			`Hold started. mint=${state.mint ? state.mint.slice(0, 6) + "…" : ""} poll=${state.pollMs}ms buyPct=${Number(state.buyPct || DEFAULTS.buyPct).toFixed(0)}% profit=${Number(state.profitPct || DEFAULTS.profitPct).toFixed(2)}% rugSev≥${Number(state.rugSevThreshold || DEFAULTS.rugSevThreshold).toFixed(2)} uptick=${state.uptickEnabled ? "on" : "off"} repeat=${state.repeatBuy ? "on" : "off"}`,
			"ok",
			true,
		);
		startLoop();
		await tickOnce(_runNonce);
	}

	async function stop({ liquidate = true } = {}) {
		const mint = String((_cycle?.mint || state.mint || "")).trim();

		if (!state.enabled) {
			_emitAnyRunning();
			updateUI();
			return;
		}

		// Stop the loop immediately.
		state.enabled = false;
		_runNonce++;
		_persist();
		_emitAnyRunning();
		try { if (_timer) clearInterval(_timer); } catch {}
		_timer = null;
		updateUI();

		if (liquidate && mint) {
			try {
				_acceptLogs = true;
				log(`Stop requested; liquidating ${_shortMint(mint)}…`, "warn", true);

				// If a tick/swap is in progress, give it a moment to settle.
				try {
					const start = now();
					while (_tickInFlight && (now() - start < 10_000)) {
						await new Promise((r) => setTimeout(r, 250));
					}
				} catch {}

				try {
					const p = _pendingEntry;
					if (p && p.mint === mint && p.ownerStr) {
						void (async () => {
							try {
								const got = await getDex().waitForTokenCredit(p.ownerStr, mint, { timeoutMs: 20_000, pollMs: 300 });
								if (Number(got?.sizeUi || 0) > 0) {
									_setCycleFromCredit({ mint, ownerStr: p.ownerStr, costSol: Number(p.addCostSol || 0), sizeUi: got.sizeUi, decimals: got.decimals });
									_upsertAutoPosFromCredit({ mint, sizeUi: got.sizeUi, decimals: got.decimals, addCostSol: Number(p.addCostSol || 0) });
									log(`Stop-liquidation: position credited size≈${Number(got.sizeUi).toFixed(6)}; selling ASAP…`, "help", true);
								}
							} catch {}
						})();
					}
				} catch {}

				let kp;
				try {
					kp = await getAutoKeypair();
				} catch (e) {
					log(String(e?.message || e || "Wallet error"), "error", true);
					kp = null;
				}

				if (kp) {
					const baseSlip = Math.max(1500, getDynamicSlippageBps("sell"));

					const trySell = async (slippageBps) => {
						let sellUi = 0;
						try {
							const ownerStr = kp.publicKey.toBase58();
							const b = await getDex().getAtaBalanceUi(ownerStr, mint, 6);
							sellUi = Number(b?.sizeUi || 0);
						} catch {}
						if (!(sellUi > 0)) return { ok: false, noBalance: true, sig: "" };
						return await getDex().executeSwapWithConfirm(
							{ signer: kp, inputMint: mint, outputMint: SOL_MINT, amountUi: sellUi, slippageBps },
							{ retries: 2, confirmMs: 45_000 },
						);
					};

					let res = await trySell(baseSlip);
					if (!res?.ok && !res?.noBalance) {
						const code = String(res?.code || "");
						const msg = String(res?.msg || "");
						log(
							`Stop-liquidation attempt 1 failed: ${code || ""}${msg ? ` ${msg}` : ""}${res?.sig ? ` sig=${String(res.sig).slice(0, 8)}…` : ""}`.trim(),
							"warn",
							true,
						);
						// Common fast fix: bump slippage and retry once.
						const slip2 = Math.max(baseSlip, Math.min(3000, Math.floor(baseSlip * 1.6)));
						if (slip2 !== baseSlip) {
							await new Promise((r) => setTimeout(r, 400));
							res = await trySell(slip2);
						}
					}

					if (res?.ok) {
						log(`Stop-liquidation sell confirmed (${res.sig || "no-sig"}).`, "ok", true);
						// Only clear cycle/pending when we know the exit happened.
						_lastProbe = null;
						_lastExitQuote = null;
						_pendingEntry = null;
						_clearCycle();
					} else if (res?.noBalance) {
						log(`Stop-liquidation: no on-chain balance to sell for ${_shortMint(mint)}.`, "warn", true);
						// If we were waiting on a credit, don't discard that state.
						if (!_pendingEntry) {
							_lastProbe = null;
							_lastExitQuote = null;
							_clearCycle();
						}
					} else {
						const code = String(res?.code || "");
						const msg = String(res?.msg || "");
						log(
							`Stop-liquidation sell not confirmed (${res?.sig || "no-sig"})${code || msg ? ` code=${code || ""}${msg ? ` msg=${msg}` : ""}` : ""}; position may still be held.`,
							"warn",
							true,
						);
						// Intentionally keep _cycle/_pendingEntry so a later restart won't re-buy.
					}
				}
			} catch (e) {
				log(`Stop-liquidation error: ${String(e?.message || e || "sell error")}`, "warn", true);
			}
		}

		// If liquidation succeeded/no-balance, cycle may already be cleared above.
		log("Hold stopped.", "warn", true);
	}

	function mount(panelEl) {
		try { if (_dextoolsJiggleTimer) clearInterval(_dextoolsJiggleTimer); } catch {}
		_dextoolsJiggleTimer = null;
		try { if (_startJiggleTimer) clearInterval(_startJiggleTimer); } catch {}
		_startJiggleTimer = null;
		_dextoolsDetailsEl = null;
		_dextoolsSummaryRowEl = null;

		try {
			_dextoolsChart?.unmount?.({ removeEl: true });
		} catch {}
		_dextoolsChart = null;

		const root = panelEl;
		root.innerHTML = `
			<div class="fdv-tab-content active" data-tab-content="hold">
				<div class="fdv-grid">
					<label>Target Mint <input data-hold-mint type="text" placeholder="Mint address"></label>
					<label>Poll (ms) <input data-hold-poll type="number" min="250" max="60000" step="50"></label>
					<label>Buy % (10-70%) <input data-hold-buy-pct type="number" min="10" max="70" step="1"></label>
					<label>Profit % to sell <input data-hold-profit type="number" min="0.1" max="500" step="0.1"></label>
				</div>

				<div class="fdv-hold-rug">
					<div class="fdv-hold-rug-row">
						<div class="fdv-hold-rug-title">Rug severity</div>
						<div class="fdv-hold-rug-value" data-hold-rug-label></div>
					</div>
					<div class="fdv-hold-rug-slider">
						<div class="fdv-hold-rug-end fdv-hold-rug-end-good">Low</div>
						<input class="fdv-range fdv-range-rug" data-hold-rug-sev type="range" min="1" max="4" step="0.05" />
						<div class="fdv-hold-rug-end fdv-hold-rug-end-avoid">Extreme</div>
					</div>
				</div>

				<div class="fdv-log" data-hold-log></div>
				<div class="fdv-actions fdv-hold-actions">
					<div class="fdv-actions-left fdv-hold-actions-left">
						<label class="fdv-hold-toggle">Repeat<input data-hold-repeat type="checkbox"></label>
						<label class="fdv-hold-toggle">Uptick<input data-hold-uptick type="checkbox"></label>
					</div>
					<div class="fdv-actions-right">
						<button data-hold-start>Start</button>
						<button data-hold-stop>Stop</button>
						<button data-hold-chart title="Open Dexscreener chart">Chart</button>
					</div>
				</div>

				<div class="fdv-hold-edge">
					<span data-hold-edge-badge class="fdv-edge-badge idle">EDGE</span>
					<div class="fdv-hold-edge-item">Edge cost <span data-hold-edge-cost class="fdv-hold-edge-value">—</span></div>
					<div class="fdv-hold-edge-item">Rec target <span data-hold-edge-rec class="fdv-hold-edge-value fdv-hold-edge-value-muted">—</span></div>
					<div data-hold-edge-hint class="fdv-hold-edge-hint"></div>
				</div>

				<details data-hold-dextools-details ${state.dextoolsOpen ? "open" : ""} class="fdv-hold-dextools-details">
					<summary data-hold-dextools-summary-row class="fdv-hold-dextools-summary-row">
						<span class="fdv-hold-dextools-title">DEXTools</span>
						<span data-hold-dextools-summary class="fdv-hold-dextools-summary"></span>
					</summary>
					<div class="fdv-hold-dextools-body">
						<div data-hold-dextools></div>
					</div>
				</details>

				<div class="fdv-hold-chat">
					<div class="fdv-hold-chat-head">
						<div class="fdv-hold-chat-title">Chat</div>
						<div class="fdv-hold-chat-right">
							<button data-hold-chat-refresh title="Refresh chat" aria-label="Refresh chat" class="fdv-hold-chat-refresh">↻</button>
							<div class="fdv-hold-chat-meta">Giscus · mint thread</div>
						</div>
					</div>
					<div data-hold-chat></div>
				</div>
				
			</div>
		`;

		mintEl = root.querySelector("[data-hold-mint]");
		pollEl = root.querySelector("[data-hold-poll]");
		buyPctEl = root.querySelector("[data-hold-buy-pct]");
		profitEl = root.querySelector("[data-hold-profit]");
		edgeCostEl = root.querySelector("[data-hold-edge-cost]");
		edgeRecEl = root.querySelector("[data-hold-edge-rec]");
		edgeRecHintEl = root.querySelector("[data-hold-edge-hint]");
		edgeBadgeEl = root.querySelector("[data-hold-edge-badge]");
		repeatEl = root.querySelector("[data-hold-repeat]");
		uptickEl = root.querySelector("[data-hold-uptick]");
		rugSevEl = root.querySelector("[data-hold-rug-sev]");
		rugSevLabelEl = root.querySelector("[data-hold-rug-label]");
		_chatRefreshBtn = root.querySelector("[data-hold-chat-refresh]");
		logEl = root.querySelector("[data-hold-log]");
		startBtn = root.querySelector("[data-hold-start]");
		stopBtn = root.querySelector("[data-hold-stop]");
		chartBtn = root.querySelector("[data-hold-chart]");
		const dextoolsDetailsEl = root.querySelector("[data-hold-dextools-details]");
		const dextoolsSummaryEl = root.querySelector("[data-hold-dextools-summary]");
		const dextoolsSummaryRowEl = root.querySelector("[data-hold-dextools-summary-row]");
		const dextoolsWrapEl = root.querySelector("[data-hold-dextools]");
		const chatEl = root.querySelector("[data-hold-chat]");
		_dextoolsDetailsEl = dextoolsDetailsEl;
		_dextoolsSummaryRowEl = dextoolsSummaryRowEl;
		try {
			if (chatEl) {
				_chatMountId = _safeDomId(`fdv_hold_chat_${botId}`);
				chatEl.id = _chatMountId;
			}
		} catch {}

		try {
			if (_chatRefreshBtn) {
				_chatRefreshBtn.addEventListener("click", (e) => {
					try { e?.preventDefault?.(); e?.stopPropagation?.(); } catch {}
					try {
						if (!_isActive) return;
						// Force a fresh mount for the current mint.
						_unmountChat();
						_syncChat({ force: true });
					} catch {}
				});
			}
		} catch {}

		updateUI();
		_setEdgeUi({ edgeCostLamports: 0, recPct: null, basisSol: 0, reason: "missing-mint" });
		if (_isActive) _debouncedEdgeUiUpdate(100);
		// Chat is mounted on tab activation to avoid initializing giscus in hidden panels.

		const _setDextoolsSummary = (open) => {
			try {
				if (!dextoolsSummaryEl) return;
				dextoolsSummaryEl.textContent = open ? "Expanded · click to hide" : "Hidden · click to show";
			} catch {}
		};

		const _ensureDextoolsMounted = () => {
			try {
				if (!dextoolsWrapEl) return;
				if (_dextoolsChart) return;
				_dextoolsChart = createDextoolsCandlestickEmbed({
					containerEl: dextoolsWrapEl,
					chainId: "solana",
					title: "DEXTools Candles",
					getMint: () => String(mintEl?.value || state.mint || "").trim(),
				});
				_dextoolsChart.mount();
				_dextoolsChart.setActive(!!_isActive);
			} catch {}
		};

		const _disableDextools = () => {
			try {
				_dextoolsChart?.setActive?.(false);
				_dextoolsChart?.unmount?.({ removeEl: true });
			} catch {}
			_dextoolsChart = null;
		};

		_setDextoolsSummary(!!state.dextoolsOpen);

		// If the DEXTools panel starts collapsed, give a subtle nudge so users notice it.
		try {
			if (!state.dextoolsOpen && dextoolsSummaryRowEl) {
				setTimeout(() => {
					try {
						if (!_isActive) return;
						if (dextoolsDetailsEl?.open) return;
						_pulseJiggle(dextoolsSummaryRowEl);
					} catch {}
				}, 650);

				// Repeat the hint occasionally while the panel remains collapsed.
				try {
					_dextoolsJiggleTimer = setInterval(() => {
						try {
							if (!_isActive) return;
							if (!dextoolsSummaryRowEl) return;
							if (dextoolsDetailsEl?.open) return;
							_pulseJiggle(dextoolsSummaryRowEl);
						} catch {}
					}, 12_000);
				} catch {}
			}
		} catch {}

		// Small repeating hint on Start when bot isn't running.
		try {
			if (startBtn) {
				setTimeout(() => {
					try {
						if (!_isActive) return;
						if (state.enabled) return;
						_pulseJiggle(startBtn);
					} catch {}
				}, 900);

				_startJiggleTimer = setInterval(() => {
					try {
						if (!_isActive) return;
						if (state.enabled) return;
						_pulseJiggle(startBtn);
					} catch {}
				}, 15_000);
			}
		} catch {}

		try {
			if (dextoolsDetailsEl) {
				dextoolsDetailsEl.addEventListener("toggle", () => {
					try {
						state.dextoolsOpen = !!dextoolsDetailsEl.open;
						_persist();
						_setDextoolsSummary(!!state.dextoolsOpen);
						if (state.dextoolsOpen) _ensureDextoolsMounted();
						else _disableDextools();
					} catch {}
				});
			}
		} catch {}

		const onChange = (e) => {
			const prevChatMint = _currentChatMint();
			_readUiToState();
			updateUI();
			try {
				_dextoolsChart?.refresh?.();
			} catch {}
			// Avoid resetting giscus on unrelated setting tweaks.
			try {
				if (_isActive && e?.target === mintEl) {
					const nextChatMint = _currentChatMint();
					if (nextChatMint && nextChatMint !== prevChatMint) _syncChat({ force: true });
				}
			} catch {}
			if (state.enabled) startLoop();
		};

		// Number/text inputs only fire "change" on blur/enter; keep edge indicator responsive while typing.
		const onSoftInput = () => {
			try {
				state.mint = String(mintEl?.value || state.mint || "").trim();
				state.pollMs = clamp(safeNum(pollEl?.value, state.pollMs), 250, 60_000);
				state.buyPct = clamp(safeNum(buyPctEl?.value, state.buyPct), 10, 70);
				state.profitPct = clamp(safeNum(profitEl?.value, state.profitPct), 0.1, 500);
				try {
					_edgeUiNonce++;
					_edgeUiCache.at = 0;
				} catch {}
				_emitLabelChanged();
				_debouncedPersist(300);
			} catch {}
			if (_isActive) _debouncedEdgeUiUpdate(80);
		};

		mintEl?.addEventListener("change", onChange);
		pollEl?.addEventListener("change", onChange);
		buyPctEl?.addEventListener("change", onChange);
		profitEl?.addEventListener("change", onChange);
		mintEl?.addEventListener("input", onSoftInput);
		pollEl?.addEventListener("input", onSoftInput);
		buyPctEl?.addEventListener("input", onSoftInput);
		profitEl?.addEventListener("input", onSoftInput);
		repeatEl?.addEventListener("change", onChange);
		uptickEl?.addEventListener("change", onChange);
		rugSevEl?.addEventListener("change", onChange);
		rugSevEl?.addEventListener("input", () => {
			try {
				state.rugSevThreshold = clamp(safeNum(rugSevEl?.value, state.rugSevThreshold), 1, 4);
				_updateRugUi();
				_debouncedPersist(180);
				if (state.enabled) startLoop();
			} catch {}
		});

		startBtn?.addEventListener("click", async () => {
			await start();
		});
		stopBtn?.addEventListener("click", async () => {
			await stop();
		});
		chartBtn?.addEventListener("click", () => {
			try {
				const m = String(mintEl?.value || state.mint || "").trim();
				if (!m) return;
				const url = _dexscreenerUrlForMint(m);
				if (!url) return;
				window.open(url, "_blank", "noopener,noreferrer");
			} catch {}
		});

		try {
			if (state.dextoolsOpen) _ensureDextoolsMounted();
			else _disableDextools();
		} catch {}
	}

	return {
		id: botId,
		getState: () => ({ ...state }),
		getLastPnl: () => ({ pnlPct: _lastPnlPct, at: _lastPnlAt, costSol: _lastPnlCostSol, estOutSol: _lastPnlEstOutSol }),
		setState: (next) => {
			const prevChatMint = _currentChatMint();
			state = _coerceState(next || {});
			_updateLabelCache();
			_persist();
			updateUI();
			try {
				_edgeUiNonce++;
				_edgeUiCache = { at: 0, mint: "", ownerStr: "", edgeCostLamports: 0, buySol: 0, recPct: null, solBal: 0, buyPct: 0 };
			} catch {}
			if (_isActive) {
				_debouncedEdgeUiUpdate(50);
				try {
					const nextChatMint = _currentChatMint();
					if (nextChatMint && nextChatMint !== prevChatMint) _syncChat({ force: true });
				} catch {}
			}
		},
		mount,
		start,
		stop,
		log,
		isRunning: () => !!state.enabled,
		tabTitle: () => (state.mint ? _shortMint(state.mint) : "Hold"),
		onActiveChanged,
	};

	function _updateLabelCache() {
		_emitLabelChanged();
	}
}

// Legacy CLI hooks kept for compatibility (no localStorage in node-like runs).
let _cliState = { ...DEFAULTS };
async function __fdvCli_startHold(cfg = {}) {
	if (!_isNodeLike()) return 1;
	_cliState = { ..._cliState, ...cfg, enabled: true };
	return 0;
}

async function __fdvCli_stopHold() {
	if (!_isNodeLike()) return 1;
	_cliState.enabled = false;
	return 0;
}

export const __fdvCli_start = __fdvCli_startHold;
export const __fdvCli_stop = __fdvCli_stopHold;

export function initHoldWidget(container = document.body) {
	const wrap = container;
	while (wrap.firstChild) wrap.removeChild(wrap.firstChild);

	const tabsState = loadHoldTabsState();
	const outer = document.createElement("div");
	outer.className = "fdv-follow-wrap";
	outer.innerHTML = `
		<div class="fdv-tabs fdv-hold-tabs" data-hold-tabs>
			<!-- hold bot tabs inserted here -->
			<button class="fdv-tab-btn" data-hold-add title="Add hold bot">+</button>
		</div>
		<div data-hold-panels></div>
	`;
	wrap.appendChild(outer);

	const tabsEl = outer.querySelector("[data-hold-tabs]");
	const panelsEl = outer.querySelector("[data-hold-panels]");
	if (!tabsEl || !panelsEl) return;
	const addBtn = outer.querySelector("[data-hold-add]");

	const bots = new Map();
	const tabBtns = new Map();
	const tabPanels = new Map();
	let activeId = String(tabsState.activeId || "").trim();
	let seq = 0;
	const deleted = new Set();

	const persistAll = () => {
		try {
			const botsArr = Array.from(bots.values()).map((b) => ({ id: b.id, state: b.getState() }));
			saveHoldTabsState({ activeId, bots: botsArr });
		} catch {}
	};

	const refreshAddBtn = () => {
		try {
			if (!addBtn) return;
			const atMax = bots.size >= HOLD_MAX_TABS;
			addBtn.disabled = atMax;
			addBtn.title = atMax ? `Max ${HOLD_MAX_TABS} hold tabs` : "Add hold bot";
		} catch {}
	};

	const recomputeRunningLed = () => {
		try {
			const anyRunning = Array.from(bots.values()).some((b) => b.isRunning());
			setBotRunning("hold", anyRunning);
		} catch {}
	};

	const updateTabLabel = (botId) => {
		try {
			const b = bots.get(botId);
			const btn = tabBtns.get(botId);
			if (!b || !btn) return;
			const labelEl = btn.querySelector?.('[data-hold-tab-label]') || null;
			if (labelEl) labelEl.textContent = b.tabTitle();
			else btn.textContent = b.tabTitle();
		} catch {}
	};

	const removeBot = async (botId, opts = {}) => {
		const id = String(botId || "").trim();
		const bot = bots.get(id);
		if (!id || !bot) return;
		const force = !!opts?.force;
		const liquidate = ("liquidate" in (opts || {})) ? !!opts.liquidate : true;

		if (!force) {
			let proceed = true;
			try {
				if (bot.isRunning() && liquidate) {
					proceed = confirm("Delete this hold bot? It will stop and attempt to liquidate the position.");
				} else {
					proceed = confirm("Delete this hold bot?");
				}
			} catch {
				proceed = true;
			}
			if (!proceed) return;
		}

		deleted.add(id);
		try {
			if (bot.isRunning()) await bot.stop({ liquidate });
		} catch {}
		try { bot?.onActiveChanged?.(false); } catch {}

		try { tabBtns.get(id)?.remove(); } catch {}
		try { tabPanels.get(id)?.remove(); } catch {}
		bots.delete(id);
		tabBtns.delete(id);
		tabPanels.delete(id);

		if (activeId === id) {
			activeId = bots.size ? Array.from(bots.keys())[0] : "";
		}

		if (!bots.size) {
			// Keep at least one tab present.
			const nid = addBot({ state: DEFAULTS });
			activeId = nid;
		}

		setActive(activeId);
		recomputeRunningLed();
		persistAll();
		refreshAddBtn();
	};

	const _botMint = (b) => {
		try { return String(b?.getState?.()?.mint || "").trim(); } catch { return ""; }
	};

	const _botLabel = (b) => {
		try {
			const m = _botMint(b);
			return m ? _shortMint(m) : (typeof b?.tabTitle === "function" ? b.tabTitle() : "Hold");
		} catch {
			return "Hold";
		}
	};

	const _botLastPnlPct = (b) => {
		try {
			const p = b?.getLastPnl?.();
			const v = Number(p?.pnlPct);
			return Number.isFinite(v) ? v : NaN;
		} catch {
			return NaN;
		}
	};

	const _ensureSlotForMint = async (mintStr, { allowGreen = true } = {}) => {
		try {
			if (bots.size < HOLD_MAX_TABS) return true;
			const m = String(mintStr || "").trim();
			const all = Array.from(bots.values());
			if (!all.length) return true;

			const isActive = (b) => {
				try { return String(b?.id || "") === String(activeId || ""); } catch { return false; }
			};

			// 1) Prefer an idle (not running) tab.
			const idle = all
				.filter((b) => b && !b.isRunning())
				.sort((a, b) => {
					const aActive = isActive(a) ? 1 : 0;
					const bActive = isActive(b) ? 1 : 0;
					if (aActive !== bActive) return aActive - bActive;
					const aHasMint = _botMint(a) ? 1 : 0;
					const bHasMint = _botMint(b) ? 1 : 0;
					return aHasMint - bHasMint;
				});
			if (idle.length) {
				const cand = idle[0];
				try {
					const activeBot = bots.get(activeId) || all[0] || null;
					activeBot?.log?.(
						`Hold: evicting idle tab ${_botLabel(cand)} to open ${_shortMint(m)}.`,
						"help",
						true,
					);
				} catch {}
				await removeBot(cand.id, { force: true, liquidate: false });
				return true;
			}

			// 2) Otherwise, optionally offer to replace a green (pnl>=0) tab.
			if (allowGreen) {
				const green = all
					.map((b) => ({ b, pnl: _botLastPnlPct(b) }))
					.filter((x) => x.b && Number.isFinite(x.pnl) && x.pnl >= 0)
					.sort((a, b) => {
						const aActive = isActive(a.b) ? 1 : 0;
						const bActive = isActive(b.b) ? 1 : 0;
						if (aActive !== bActive) return aActive - bActive;
						// prefer more green (higher pnl) since we're "safe" to take profit
						return Number(b.pnl) - Number(a.pnl);
					});
				if (green.length) {
					const cand = green[0].b;
					const pnl = green[0].pnl;
					let proceed = true;
					try {
						proceed = confirm(
							`Hold is full (max ${HOLD_MAX_TABS}). Replace ${_botLabel(cand)} (green ${pnl.toFixed(2)}%) with ${_shortMint(m)}?\n\nThis will stop and attempt to liquidate ${_botLabel(cand)}.`
						);
					} catch {
						proceed = true;
					}
					if (!proceed) return false;
					try {
						const activeBot = bots.get(activeId) || all[0] || null;
						activeBot?.log?.(
							`Hold: replacing green tab ${_botLabel(cand)} (pnl=${pnl.toFixed(2)}%) to open ${_shortMint(m)}…`,
							"warn",
							true,
						);
					} catch {}
					await removeBot(cand.id, { force: true, liquidate: true });
					return true;
				}
			}

			return false;
		} catch {
			return false;
		}
	};

	const setActive = (botId) => {
		const id = String(botId || "").trim();
		if (!id || !bots.has(id)) return;
		activeId = id;
		for (const [bid, btn] of tabBtns.entries()) {
			if (!btn) continue;
			btn.classList.toggle("active", bid === activeId);
		}
		for (const [bid, panel] of tabPanels.entries()) {
			if (!panel) continue;
			const isActive = bid === activeId;
			panel.classList.toggle("active", isActive);
			try { bots.get(bid)?.onActiveChanged?.(isActive); } catch {}
		}
		persistAll();
	};

	const addBot = ({ state } = {}) => {
		if (bots.size >= HOLD_MAX_TABS) {
			try { alert(`Max ${HOLD_MAX_TABS} hold tabs.`); } catch {}
			return null;
		}
		const id = _newBotId();
		seq++;
		deleted.delete(id);

		const btn = document.createElement("button");
		btn.className = "fdv-tab-btn";
		btn.dataset.holdTab = id;
		btn.innerHTML = `
			<span data-hold-tab-label></span>
			<span data-hold-tab-del class="fdv-hold-tab-del" title="Delete" aria-label="Delete hold bot">×</span>
		`;
		const labelEl = btn.querySelector('[data-hold-tab-label]');
		if (labelEl) labelEl.textContent = state?.mint ? _shortMint(state.mint) : `Hold ${seq}`;
		btn.addEventListener("click", (e) => {
			try {
				const hitDel = e?.target?.closest?.('[data-hold-tab-del]');
				if (hitDel) {
					e?.preventDefault?.();
					e?.stopPropagation?.();
					void removeBot(id);
					return;
				}
			} catch {}
			setActive(id);
		});

		const plusBtn = tabsEl.querySelector("[data-hold-add]");
		if (plusBtn) tabsEl.insertBefore(btn, plusBtn);
		else tabsEl.appendChild(btn);

		const panel = document.createElement("div");
		panel.dataset.holdPanel = id;
		panel.className = "fdv-hold-panel";
		panelsEl.appendChild(panel);

		const bot = createHoldBotInstance({
			id,
			initialState: state || DEFAULTS,
			onPersist: (bid, nextState) => {
				try {
					if (deleted.has(bid)) return;
					const b = bots.get(bid);
					if (!b) return;
					persistAll();
					updateTabLabel(bid);
				} catch {}
			},
			onAnyRunningChanged: () => {
				recomputeRunningLed();
				persistAll();
				updateTabLabel(id);
			},
			onLabelChanged: (bid) => {
				updateTabLabel(bid);
				persistAll();
			},
		});
		bot.mount(panel);

		bots.set(id, bot);
		tabBtns.set(id, btn);
		tabPanels.set(id, panel);
		updateTabLabel(id);
		refreshAddBtn();
		return id;
	};

	// Initialize bots
	for (const entry of (tabsState.bots || []).slice(0, HOLD_MAX_TABS)) {
		const id = String(entry?.id || "").trim();
		const st = _coerceState(entry?.state || entry);
		seq++;
		deleted.delete(id);

		const btn = document.createElement("button");
		btn.className = "fdv-tab-btn";
		btn.dataset.holdTab = id;
		btn.innerHTML = `
			<span data-hold-tab-label></span>
			<span data-hold-tab-del class="fdv-hold-tab-del" title="Delete" aria-label="Delete hold bot">×</span>
		`;
		const labelEl = btn.querySelector('[data-hold-tab-label]');
		if (labelEl) labelEl.textContent = st.mint ? _shortMint(st.mint) : `Hold ${seq}`;
		btn.addEventListener("click", (e) => {
			try {
				const hitDel = e?.target?.closest?.('[data-hold-tab-del]');
				if (hitDel) {
					e?.preventDefault?.();
					e?.stopPropagation?.();
					void removeBot(id);
					return;
				}
			} catch {}
			setActive(id);
		});

		const plusBtn = tabsEl.querySelector("[data-hold-add]");
		if (plusBtn) tabsEl.insertBefore(btn, plusBtn);
		else tabsEl.appendChild(btn);

		const panel = document.createElement("div");
		panel.dataset.holdPanel = id;
		panel.className = "fdv-hold-panel";
		panelsEl.appendChild(panel);

		const bot = createHoldBotInstance({
			id,
			initialState: st,
			onPersist: () => {
				if (deleted.has(id)) return;
				persistAll();
				updateTabLabel(id);
			},
			onAnyRunningChanged: () => {
				recomputeRunningLed();
				persistAll();
				updateTabLabel(id);
			},
			onLabelChanged: () => {
				updateTabLabel(id);
				persistAll();
			},
		});
		bot.mount(panel);

		bots.set(id, bot);
		tabBtns.set(id, btn);
		tabPanels.set(id, panel);
		updateTabLabel(id);
	}

	if (!bots.size) {
		activeId = addBot({ state: DEFAULTS }) || "";
	} else if (!bots.has(activeId)) {
		activeId = Array.from(bots.keys())[0];
	}

	// Wire + button
	addBtn?.addEventListener("click", () => {
		const id = addBot({ state: DEFAULTS });
		if (!id) return;
		setActive(id);
		persistAll();
		refreshAddBtn();
	});

	setActive(activeId);
	recomputeRunningLed();
	persistAll();
	refreshAddBtn();

	// Resume bots that were enabled.
	for (const b of bots.values()) {
		try {
			if (b.isRunning()) {
				b.log("Hold was enabled from last session; resuming.", "help", true);
				void b.start({ resume: true });
			}
		} catch {}
	}

	async function openForMint({ mint, config, tokenHydrate, start, logLoaded, createNew } = {}) {
		const m = String(mint || tokenHydrate?.mint || "").trim();
		if (!m) return null;

		// Card Hold button behavior: always open a fresh instance.
		if (createNew) {
			try {
				if (bots.size >= HOLD_MAX_TABS) {
					const ok = await _ensureSlotForMint(m, { allowGreen: true });
					if (!ok) {
						const activeBot = bots.get(activeId) || Array.from(bots.values())[0] || null;
						try {
							activeBot?.log(
								`Hold: no instances available (max ${HOLD_MAX_TABS}). Stop/delete a tab to open ${_shortMint(m)}.`,
								"warn",
								true,
							);
						} catch {}
						return null;
					}
				}
			} catch {}

			const next = {
				...DEFAULTS,
				...(typeof config === "object" && config ? config : {}),
				mint: m,
				enabled: false,
			};

			const createdId = addBot({ state: next });
			if (!createdId) {
				const activeBot = bots.get(activeId) || Array.from(bots.values())[0] || null;
				try {
					activeBot?.log(
						`Hold: no instances available (max ${HOLD_MAX_TABS}). Stop/delete a tab to open ${_shortMint(m)}.`,
						"warn",
						true,
					);
				} catch {}
				return null;
			}

			const target = bots.get(createdId) || null;
			try {
				setActive(createdId);
				persistAll();
				refreshAddBtn();
				recomputeRunningLed();
			} catch {}

			try {
				if (logLoaded) target?.log(`Mint loaded: ${_shortMint(m)}`, "help", true);
			} catch {}

			if (start && target && !target.isRunning()) {
				try { void target.start({ resume: false }); } catch {}
			}
			return createdId;
		}

		// Prefer an existing tab already targeting this mint.
		let target = null;
		try {
			for (const b of bots.values()) {
				try {
					const st = b.getState();
					if (String(st?.mint || "").trim() === m) {
						target = b;
						break;
					}
				} catch {}
			}
		} catch {}

		// If we already have a tab for this mint, just activate it (and optionally apply config).
		if (target) {
			try {
				if (config && typeof config === "object") {
					const cur = target.getState();
					target.setState({ ...cur, ...config, mint: m });
				}
			} catch {}

			try {
				setActive(target.id);
				persistAll();
				refreshAddBtn();
				recomputeRunningLed();
			} catch {}

			try {
				if (logLoaded) target.log(`Mint loaded: ${_shortMint(m)}`, "help", true);
			} catch {}

			if (start && !target.isRunning()) {
				try { void target.start({ resume: false }); } catch {}
			}
			return target.id;
		}

		// No exact match: prefer reusing an idle tab.
		try {
			for (const b of bots.values()) {
				if (!b.isRunning()) {
					target = b;
					break;
				}
			}
		} catch {}

		// Otherwise create a new tab if possible.
		if (!target) {
			if (bots.size >= HOLD_MAX_TABS) {
				const ok = await _ensureSlotForMint(m, { allowGreen: true });
				if (!ok) {
					try { alert(`Hold: max ${HOLD_MAX_TABS} tabs. Stop/delete a tab to open a new mint.`); } catch {}
					return null;
				}
			}
			const createdId = addBot({ state: DEFAULTS });
			if (createdId) target = bots.get(createdId) || null;
		}

		if (!target) {
			try { alert(`Hold: no available tab (max ${HOLD_MAX_TABS}). Stop/delete a tab and try again.`); } catch {}
			return null;
		}

		// Safety: never overwrite a running bot with a different mint.
		if (target.isRunning()) {
			try { alert("Hold: stop this tab before reusing it for a new mint."); } catch {}
			return null;
		}

		const next = {
			...DEFAULTS,
			...(typeof config === "object" && config ? config : {}),
			mint: m,
			enabled: false,
		};

		try {
			target.setState(next);
		} catch {}

		try {
			setActive(target.id);
			persistAll();
			refreshAddBtn();
			recomputeRunningLed();
		} catch {}

		try {
			if (logLoaded) target.log(`Mint loaded: ${_shortMint(m)}`, "help", true);
		} catch {}

		if (start) {
			try { void target.start({ resume: false }); } catch {}
		}

		return target.id;
	}

	// Expose minimal integration API.
	const api = { openForMint };
	try { window.__fdvHoldOpenForMint = (mintArg, opts) => openForMint({ mint: mintArg, ...(opts || {}) }); } catch {}
	try { window._fdvHoldWidgetApi = api; } catch {}
	return api;
}