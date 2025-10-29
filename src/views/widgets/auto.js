// import { FDV_FEE_RECEIVER } from "../../config/env.js";
import { computePumpingLeaders, getRugSignalForMint } from "../meme/addons/pumping.js";

// Dust orders and minimums are blocked due to Jupiter route failures and 400 errors.
// please export wallet.json to recover any dust funds.

const SOL_MINT = "So11111111111111111111111111111111111111112";

const MIN_JUP_SOL_IN = 0.001;
const MIN_SELL_SOL_OUT = 0.004;
const FEE_RESERVE_MIN = 0.0002;   // rent
const FEE_RESERVE_PCT = 0.15;     // 15% of balance, more runway
const TX_FEE_BUFFER_LAMPORTS  = 500_000;
const SELL_TX_FEE_BUFFER_LAMPORTS = 500_000; 
const EXTRA_TX_BUFFER_LAMPORTS     = 250_000;  
const MIN_OPERATING_SOL            = 0.010;    
const ROUTER_COOLDOWN_MS           = 60_000;
const MINT_RUG_BLACKLIST_MS = 30 * 60 * 1000;
const MINT_BLACKLIST_STAGES_MS =  [2 * 60 * 1000, 15 * 60 * 1000, MINT_RUG_BLACKLIST_MS];
const URGENT_SELL_COOLDOWN_MS= 8_000; 
const URGENT_SELL_MIN_AGE_MS = 12_000;
const FAST_OBS_INTERVAL_MS   = 40;    
const SPLIT_FRACTIONS = [0.99, 0.95, 0.90, 0.85, 0.80, 0.75, 0.70, 0.50, 0.33, 0.25, 0.20];
const MINT_OP_LOCK_MS = 30_000;
const BUY_SEED_TTL_MS = 60_000;
const BUY_LOCK_MS = 5_000;
const FAST_OBS_LOG_INTERVAL_MS = 200; 


const POSCACHE_KEY_PREFIX = "fdv_poscache_v1:";

const DUSTCACHE_KEY_PREFIX = "fdv_dustcache_v1:";


const FEE_ATAS = {
  [SOL_MINT]: "4FSwzXe544mW2BLYqAAjcyBmFFHYgMbnA1XUdtGUeST8",  // Buy me a coffee
  "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v": "BKWwTmwc7FDSRb82n5o76bycH3rKZ4Xqt87EjZ2rnUXB", 
};

const UI_LIMITS = {
  BUY_PCT_MIN: 0.01,  // 1%
  BUY_PCT_MAX: 0.50,  // 50%
  MIN_BUY_SOL_MIN: Math.max(MIN_SELL_SOL_OUT, MIN_JUP_SOL_IN), // ≥ router-safe sell floor
  MIN_BUY_SOL_MAX: 1,    // cap min order size at 1 SOL
  MAX_BUY_SOL_MIN: Math.max(MIN_SELL_SOL_OUT, MIN_JUP_SOL_IN),
  MAX_BUY_SOL_MAX: 5,    // cap max order size at 5 SOL
  LIFE_MINS_MIN: 0,
  LIFE_MINS_MAX: 10080,  // 7 days
};

function clamp(n, lo, hi) { const x = Number(n); return Number.isFinite(x) ? Math.min(hi, Math.max(lo, x)) : lo; }

function now() { return Date.now(); }

function fmtUsd(n) {
  const x = Number(n || 0);
  if (!Number.isFinite(x)) return "$0.00";
  return "$" + x.toFixed(x >= 100 ? 0 : x >= 10 ? 2 : 3);
}

function safeNum(v, def=0){ const n = Number(v); return Number.isFinite(n) ? n : def; }

function isPlanUpgradeError(e) {
  const s = String(e?.message || e || "");
  return /403/.test(s) || /-32602/.test(s) || /plan upgrade/i.test(s);
}

function log(msg) {
  if (!logEl) return;
  const d = document.createElement("div");
  d.textContent = `[${new Date().toLocaleTimeString()}] ${msg}`;
  logEl.appendChild(d);
  logEl.scrollTop = logEl.scrollHeight;
}

function logObj(label, obj) {
  try { log(`${label}: ${JSON.stringify(obj)}`); } catch {}
}

async function logMoneyMade() {
  try {
    const totalSol = Number(state.moneyMadeSol || 0);
    const px = await getSolUsd();
    const usdStr = px > 0 ? ` (${fmtUsd(totalSol * px)})` : "";
    log(`Money made: ${totalSol.toFixed(6)} SOL${usdStr}`);
  } catch {
    const totalSol = Number(state.moneyMadeSol || 0);
    log(`Money made: ${totalSol.toFixed(6)} SOL`);
  }
}

async function addRealizedPnl(solProceeds, costSold, label = "PnL") {
  const pnl = Number(solProceeds || 0) - Number(costSold || 0);
  state.moneyMadeSol = Number(state.moneyMadeSol || 0) + pnl;
  save();
  try {
    const px = await getSolUsd();
    const totalSol = Number(state.moneyMadeSol || 0);
    const totalUsd = px > 0 ? ` (${fmtUsd(totalSol * px)})` : "";
    const sign = pnl >= 0 ? "+" : "";
    log(`${label}: ${sign}${pnl.toFixed(6)} SOL | Money made: ${totalSol.toFixed(6)} SOL${totalUsd}`);
  } catch {
    const totalSol = Number(state.moneyMadeSol || 0);
    const sign = (Number(solProceeds || 0) - Number(costSold || 0)) >= 0 ? "+" : "";
    log(`${label}: ${sign}${(Number(solProceeds||0)-Number(costSold||0)).toFixed(6)} SOL | Money made: ${totalSol.toFixed(6)} SOL`);
  }
}

function redactHeaders(hdrs) {
  const keys = Object.keys(hdrs || {});
  return keys.length ? `{headers: ${keys.join(", ")}}` : "{}";
}

const LS_KEY = "fdv_auto_bot_v1";

let state = {
  enabled: false,
  mint: "",
  budgetUi: 0.5,  
  maxTrades: 6,  // legacy
  minSecsBetween: 90,
  buyScore: 1.2,
  takeProfitPct: 12,
  stopLossPct: 8,
  slippageBps: 250,
  holdingsUi: 0,
  avgEntryUsd: 0,
  lastTradeTs: 0,
  trailPct: 6,                 
  minProfitToTrailPct: 3,     
  coolDownSecsAfterBuy: 60,    
  minHoldSecs: 0,  
  maxHoldSecs: 50,           
  partialTpPct: 50,            
  minQuoteIntervalMs: 10000, 
  sellCooldownMs: 20000,  
  staleMinsToDeRisk: 4, 

  // Auto wallet mode
  autoWalletPub: "",        
  autoWalletSecret: "",      
  recipientPub: "",          
  lifetimeMins: 60,         
  endAt: 0,                 
  buyPct: 0.2,              
  minBuySol: 0.002,         
  maxBuySol: 0.05,          
  rpcUrl: "",             

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
  observerDropSellAt: 3,
  // Observer hysteresis settings
  observerDropMinAgeSecs: 5,   
  observerDropConsec: 2,     
  observerDropTrailPct: 2.5,    

  // Cache
  pendingGraceMs: 60000,

  // collapse state for <details>
  collapsed: true,
  // hold until new leader detected
  holdUntilLeaderSwitch: false,
  // dynamic observer hold time
  dynamicHoldEnabled: true,

  // money made tracker
  moneyMadeSol: 0,
};
// init global user interface
let timer = null;
let logEl, toggleEl, startBtn, stopBtn, mintEl;
let depAddrEl, depBalEl, lifeEl, recvEl, buyPctEl, minBuyEl, maxBuyEl;

let _starting = false;

let _switchingLeader = false;

let _inFlight = false;

let _buyInFlight = false;

let _sellEvalRunning = false;

let _buyBatchUntil = 0;

const _pkValidCache = new Map();

let _pendingCredits = new Map(); 

let _lastOwnerReconTs = 0;

let _solPxCache = { ts: 0, usd: 0 };

let _conn = null, _connUrl = "";

let _connHdrKey = "";

function _pcKey(owner, mint) { return `${owner}:${mint}`; }

function _getUrgentSellStore() {
  if (!window._fdvUrgentSell) window._fdvUrgentSell = new Map();
  return window._fdvUrgentSell;
}

function flagUrgentSell(mint, reason = "observer", sev = 1) {
  if (!mint) return;
  const m = _getUrgentSellStore();
  const prev = m.get(mint) || { until: 0 };
  const nowTs = now();
  if (prev.until && nowTs < prev.until) return; // cooldown
  m.set(mint, { reason, sev, until: nowTs + URGENT_SELL_COOLDOWN_MS });
  setMintBlacklist(mint, MINT_RUG_BLACKLIST_MS);
  log(`URGENT: ${reason} for ${mint.slice(0,4)}… flagged for immediate sell.`);
  wakeSellEval();
}

function takeUrgentSell(mint) {
  const m = _getUrgentSellStore();
  const rec = m.get(mint);
  if (!rec) return null;
  if (now() > rec.until) { m.delete(mint); return null; }
  m.delete(mint);
  return rec;
}

function wakeSellEval() {
  try {
    if (!_sellEvalRunning) setTimeout(() => { evalAndMaybeSellPositions().catch(()=>{}); }, 0);
  } catch {}
}

function _getFastObsLogStore() {
  if (!window._fdvFastObsLog) window._fdvFastObsLog = new Map(); // mint -> { lastAt, lastBadge, lastMsg }
  return window._fdvFastObsLog;
}
function _fmtDelta(a, b, digits = 2) {
  if (!Number.isFinite(a) || !Number.isFinite(b)) return "—";
  const d = b - a;
  const sign = d > 0 ? "+" : d < 0 ? "−" : "±";
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

function clearPendingCredit(owner, mint) {
  try { if (_pendingCredits) _pendingCredits.delete(_pcKey(owner, mint)); } catch {}
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

function _getMintLocks() {
  if (!window._fdvMintLocks) window._fdvMintLocks = new Map(); // mint -> { mode: 'buy'|'sell', until: ts }
  return window._fdvMintLocks;
}

function lockMint(mint, mode = "sell", ms = MINT_OP_LOCK_MS) {
  if (!mint) return;
  const m = _getMintLocks();
  const until = now() + Math.max(5_000, ms|0);
  m.set(mint, { mode, until });
}

function unlockMint(mint) {
  try { _getMintLocks().delete(mint); } catch {}
}

function isMintLocked(mint) {
  const rec = _getMintLocks().get(mint);
  if (!rec) return false;
  if (now() > rec.until) { _getMintLocks().delete(mint); return false; }
  return true;
}

function _getBuySeedStore() {
  if (!window._fdvBuySeeds) window._fdvBuySeeds = new Map();
  return window._fdvBuySeeds;
}

function _seedKey(owner, mint) { return `${owner}:${mint}`; }

function putBuySeed(owner, mint, seed) {
  if (!owner || !mint || !seed) return;
  const s = _getBuySeedStore();
  const k = _seedKey(owner, mint);
  const prev = s.get(k);
  const next = prev
    ? {
        ...prev,
        sizeUi: Number(prev.sizeUi || 0) + Number(seed.sizeUi || 0),
        costSol: Number(prev.costSol || 0) + Number(seed.costSol || 0),
        decimals: Number.isFinite(seed.decimals) ? seed.decimals : (prev.decimals ?? 6),
        at: now(),
      }
    : { ...seed, owner, mint, at: now() };
  s.set(k, next);
}

function getBuySeed(owner, mint) {
  try {
    const s = _getBuySeedStore();
    const k = _seedKey(owner, mint);
    const rec = s.get(k);
    if (!rec) return null;
    if ((now() - Number(rec.at || 0)) > BUY_SEED_TTL_MS) { s.delete(k); return null; }
    return rec;
  } catch { return null; }
}

function clearBuySeed(owner, mint) {
  try { _getBuySeedStore().delete(_seedKey(owner, mint)); } catch {}
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
      addCostSol: Number(buySol || 0),
      decimalsHint: pos.decimals,
      basePos: pos,
      sig: sig || ""
    });
    log(`Optimistic seed: ${mint.slice(0,4)}… (~${Number(estUi).toFixed(6)}) — awaiting credit`);
  } catch {}
}

async function getTxWithMeta(sig) {
  try {
    const conn = await getConn();
    // finalized preferred; falls back to confirmed if not found yet
    let tx = await conn.getTransaction(sig, { maxSupportedTransactionVersion: 0, commitment: "finalized" });
    if (!tx) tx = await conn.getTransaction(sig, { maxSupportedTransactionVersion: 0, commitment: "confirmed" });
    return tx || null;
  } catch { return null; }
}

async function reconcileBuyFromTx(sig, ownerPub, expectedMint) {
  const tx = await getTxWithMeta(sig);
  if (!tx?.meta) return null;

  const keys = tx.transaction?.message?.accountKeys || [];
  const post = tx.meta.postTokenBalances || [];
  // Try expected mint first, then any positive balance owned by us
  const pick = (arr, mint) => arr.find(b => (!mint || b.mint === mint));
  let rec = pick(post, expectedMint);
  if (!rec) rec = post.find(b => b?.owner === ownerPub) || post[0];

  if (!rec?.mint) return null;
  const mint = rec.mint;
  const dec = Number(rec.uiTokenAmount?.decimals ?? 6);
  const ui  = Number(rec.uiTokenAmount?.uiAmount ?? 0);
  if (ui > 0) return { mint, sizeUi: ui, decimals: dec };

  // As a fallback, resolve by accountIndex -> account owner lookup if needed
  try {
    const ai = Number(rec.accountIndex);
    const pk = keys?.[ai]?.pubkey?.toBase58?.() || keys?.[ai]?.toBase58?.() || String(keys?.[ai] || "");
    if (pk) {
      const b = await getAtaBalanceUi(ownerPub, mint, dec);
      if (Number(b.sizeUi || 0) > 0) return { mint, sizeUi: Number(b.sizeUi), decimals: Number.isFinite(b.decimals) ? b.decimals : dec };
    }
  } catch {}
  return null;
}

function enqueuePendingCredit({ owner, mint, addCostSol = 0, decimalsHint = 6, basePos = {}, sig }) {
  if (!owner || !mint) return;
  const nowTs = now();
  const until = nowTs + Math.max(5000, Number(state.pendingGraceMs || 20000));
  const key = _pcKey(owner, mint);
  const prev = _pendingCredits.get(key);
  const add = Number(addCostSol || 0);
  _pendingCredits.set(key, {
    owner, mint,
    sig: sig || prev?.sig || "",
    expectedMint: mint,
    addCostSol: (Number(prev?.addCostSol || 0) + add),
    decimalsHint: Number.isFinite(decimalsHint) ? decimalsHint : (prev?.decimalsHint ?? 6),
    basePos: Object.assign({}, basePos || {}, { awaitingSizeSync: true }),
    startedAt: prev?.startedAt || nowTs,
    until,
    lastTriedAt: 0,
  });
  log(`Queued pending credit watch for ${mint.slice(0,4)}… for up to ${(state.pendingGraceMs/1000|0)}s.`);
}

async function processPendingCredits() {
  if (!_pendingCredits || _pendingCredits.size === 0) return;
  const nowTs = now();
  for (const [key, entry] of Array.from(_pendingCredits.entries())) {
    if (!entry?.owner || !entry?.mint) { _pendingCredits.delete(key); continue; }
    if (!entry || nowTs > entry.until) { _pendingCredits.delete(key); continue; }
    if (entry.lastTriedAt && (nowTs - entry.lastTriedAt) < 300) continue;
    try {
      entry.lastTriedAt = nowTs;

      const bal = await getAtaBalanceUi(entry.owner, entry.mint, entry.decimalsHint);
      let sizeUi = Number(bal.sizeUi || 0);
      let dec = Number.isFinite(bal.decimals) ? bal.decimals : (entry.decimalsHint ?? 6);

      if (sizeUi <= 0 && entry.sig) {
        const metaHit = await reconcileBuyFromTx(entry.sig, entry.owner, entry.expectedMint).catch(()=>null);
        if (metaHit && metaHit.mint === entry.mint) {
          sizeUi = Number(metaHit.sizeUi || 0);
          if (Number.isFinite(metaHit.decimals)) dec = metaHit.decimals;
          if (sizeUi > 0) log(`Buy reconciled via tx meta for ${entry.mint.slice(0,4)}… size=${sizeUi.toFixed(6)}`);
        }
      }

      if (sizeUi <= 0) {
        try {
          const list = await listOwnerSplPositions(entry.owner);
          const found = list.find(x => x.mint === entry.mint);
          if (found && Number(found.sizeUi || 0) > 0) {
            sizeUi = Number(found.sizeUi);
            dec = Number.isFinite(found.decimals) ? found.decimals : dec;
          }
        } catch {}
      }

      if (sizeUi > 0) {
        const prevPos = state.positions[entry.mint] || entry.basePos || { costSol: 0, hwmSol: 0, acquiredAt: now() };
        const pos = {
          ...prevPos,
          sizeUi,
          decimals: dec,
          costSol: Number(prevPos.costSol || 0) + Number(entry.addCostSol || 0),
          hwmSol: Math.max(Number(prevPos.hwmSol || 0), Number(entry.addCostSol || 0)),
          lastBuyAt: now(),
          lastSeenAt: now(),
          awaitingSizeSync: false,
        };
        state.positions[entry.mint] = pos;
        updatePosCache(entry.owner, entry.mint, sizeUi, dec);
        save();
        log(`Credit detected for ${entry.mint.slice(0,4)}… synced to cache.`);
        _pendingCredits.delete(key);
      }
    } catch {}
  }
}


function loadPosCache(ownerPubkeyStr) {
  if (localStorage.getItem(POSCACHE_KEY_PREFIX + ownerPubkeyStr) === null) {
    localStorage.setItem(POSCACHE_KEY_PREFIX + ownerPubkeyStr, JSON.stringify({}));
  }
  try {
    let posCache = JSON.parse(localStorage.getItem(POSCACHE_KEY_PREFIX + ownerPubkeyStr) || "{}") || {}
    log(`Loaded position cache for ${ownerPubkeyStr.slice(0,4)}… with ${Object.keys(posCache).length} entries.`);
    return posCache;
  } catch {
    return {};
  }
}

function savePosCache(ownerPubkeyStr, data) {
  try {
    localStorage.setItem(POSCACHE_KEY_PREFIX + ownerPubkeyStr, JSON.stringify(data || {}));
    log(`Saved position cache for ${ownerPubkeyStr.slice(0,4)}… with ${Object.keys(data||{}).length} entries.`);
  } catch {
    log(`Failed to save position cache for ${ownerPubkeyStr.slice(0,4)}…`);
  }
}

function updatePosCache(ownerPubkeyStr, mint, sizeUi, decimals) {
  if (localStorage.getItem(POSCACHE_KEY_PREFIX + ownerPubkeyStr) === null) {
    localStorage.setItem(POSCACHE_KEY_PREFIX + ownerPubkeyStr, JSON.stringify({}));
  }
  if (!ownerPubkeyStr || !mint) return;
  const cache = loadPosCache(ownerPubkeyStr);
  if (Number(sizeUi) > 0) {
    cache[mint] = { sizeUi: Number(sizeUi), decimals: Number.isFinite(decimals) ? decimals : 6 };
    savePosCache(ownerPubkeyStr, cache);
    log(`Updated position cache for ${ownerPubkeyStr.slice(0,4)}… mint ${mint.slice(0,4)}… size ${sizeUi}`);
  }
}

function removeFromPosCache(ownerPubkeyStr, mint) {
  if (!ownerPubkeyStr || !mint) return;
  const cache = loadPosCache(ownerPubkeyStr);
  if (cache[mint]) { delete cache[mint]; savePosCache(ownerPubkeyStr, cache); }
  log(`Removed from position cache for ${ownerPubkeyStr.slice(0,4)}… mint ${mint.slice(0,4)}…`);
}

function cacheToList(ownerPubkeyStr) {
  const cache = loadPosCache(ownerPubkeyStr);
  const objOfCache = Object.entries(cache).map(([mint, v]) => ({
    mint,
    sizeUi: Number(v?.sizeUi || 0),
    decimals: Number.isFinite(v?.decimals) ? v.decimals : 6
  })).filter(x => x.mint && x.sizeUi > 0);
  log(`Position cache to list for ${ownerPubkeyStr.slice(0,4)}… ${objOfCache.length} entries.`);
  return objOfCache;
}

function loadDustCache(ownerPubkeyStr) {
  if (localStorage.getItem(DUSTCACHE_KEY_PREFIX + ownerPubkeyStr) === null) {
    localStorage.setItem(DUSTCACHE_KEY_PREFIX + ownerPubkeyStr, JSON.stringify({}));
  }
  try {
    const raw = localStorage.getItem(DUSTCACHE_KEY_PREFIX + ownerPubkeyStr) || "{}";
    const obj = JSON.parse(raw) || {};
    log(`Loaded dust cache for ${ownerPubkeyStr.slice(0,4)}… with ${Object.keys(obj).length} entries.`);
    return obj;
  } catch {
    return {};
  }
}
function saveDustCache(ownerPubkeyStr, data) {
  try {
    localStorage.setItem(DUSTCACHE_KEY_PREFIX + ownerPubkeyStr, JSON.stringify(data || {}));
    log(`Saved dust cache for ${ownerPubkeyStr.slice(0,4)}… with ${Object.keys(data||{}).length} entries.`);
  } catch {
    log(`Failed to save dust cache for ${ownerPubkeyStr.slice(0,4)}…`);
  }
}
function addToDustCache(ownerPubkeyStr, mint, sizeUi, decimals) {
  if (!ownerPubkeyStr || !mint) return;
  const cache = loadDustCache(ownerPubkeyStr);
  cache[mint] = { sizeUi: Number(sizeUi || 0), decimals: Number.isFinite(decimals) ? decimals : 6 };
  saveDustCache(ownerPubkeyStr, cache);
  log(`Moved to dust cache: ${mint.slice(0,4)}… amt=${Number(sizeUi||0).toFixed(6)}`);
}
function removeFromDustCache(ownerPubkeyStr, mint) {
  if (!ownerPubkeyStr || !mint) return;
  const cache = loadDustCache(ownerPubkeyStr);
  if (cache[mint]) { delete cache[mint]; saveDustCache(ownerPubkeyStr, cache); }
}

function dustCacheToList(ownerPubkeyStr) {
  const cache = loadDustCache(ownerPubkeyStr);
  return Object.entries(cache).map(([mint, v]) => ({
    mint,
    sizeUi: Number(v?.sizeUi || 0),
    decimals: Number.isFinite(v?.decimals) ? v.decimals : 6,
  })).filter(x => x.mint && x.sizeUi > 0);
}
function isMintInDustCache(ownerPubkeyStr, mint) {
  const cache = loadDustCache(ownerPubkeyStr);
  return !!cache[mint];
}
function minSellNotionalSol() {
  return Math.max(MIN_SELL_SOL_OUT, MIN_JUP_SOL_IN * 1.05, Number(state.dustMinSolOut || 0));
}

// async function isDustAmount(mint, sizeUi, decimals) {
//   const estSol = await quoteOutSol(mint, Number(sizeUi || 0), decimals).catch(()=>0);
//   return { isDust: estSol > 0 && estSol < minSellNotionalSol(), estSol };
// }
// function moveRemainderToDust(ownerPubkeyStr, mint, sizeUi, decimals) {
//   try { addToDustCache(ownerPubkeyStr, mint, sizeUi, decimals); } catch {}
//   try { removeFromPosCache(ownerPubkeyStr, mint); } catch {}
//   if (state.positions && state.positions[mint]) { delete state.positions[mint]; save(); }
//   log(`Remainder classified as dust for ${mint.slice(0,4)}… removed from positions.`);
// }

// function markRouteDustFail(mint) {
//   const nowTs = now();
//   const prev = window._fdvRouteDustFails.get(mint) || { firstAt: nowTs, count: 0 };
//   // reset window if expired
//   const base = (nowTs - prev.firstAt > ROUTER_DUST_FAIL_WINDOW_MS) ? { firstAt: nowTs, count: 0 } : prev;
//   const next = { firstAt: base.firstAt, count: base.count + 1 };
//   window._fdvRouteDustFails.set(mint, next);
//   return next;
// }

// function shouldAutoDustForMint(mint) {
//   const rec = window._fdvRouteDustFails.get(mint);
//   if (!rec) return false;
//   if ((now() - rec.firstAt) > ROUTER_DUST_FAIL_WINDOW_MS) return false;
//   return rec.count >= ROUTER_DUST_FAIL_THRESHOLD;
// }

// function clearRouteDustFails(mint) {
//   try { window._fdvRouteDustFails.delete(mint); } catch {}
// }

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

function normalizePercent(v) {
  const x = Number(v);
  if (!Number.isFinite(x) || x <= 0) return 0;
  return x > 1 ? x / 100 : x;
}

async function getCfg() {
  try { return (await import("./swap.js"))?.CFG || {}; } catch { return {}; }
}

async function getJupBase() {
  const cfg = await getCfg();
  return String(cfg.jupiterBase || "https://lite-api.jup.ag").replace(/\/+$/,"");
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
 
function getPlatformFeeBps() {
  return 1; // 0.05%
}

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

async function loadSplToken() {
  if (window.splToken) return window.splToken;
  try {
    const m = await import("https://esm.sh/@solana/spl-token@0.4.6?bundle");
    window.splToken = m;
    return m;
  } catch {
    const { PublicKey } = await loadWeb3();
    const TOKEN_PROGRAM_ID = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
    const TOKEN_2022_PROGRAM_ID = new PublicKey("TokenzQdBNb1KzYrNU3G1bqbp1VZr1z7jWmzuXyaS6uJ");
    const ASSOCIATED_TOKEN_PROGRAM_ID = new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
    async function getAssociatedTokenAddress(mint, owner, allowOwnerOffCurve = true, programId = TOKEN_PROGRAM_ID, associatedTokenProgramId = ASSOCIATED_TOKEN_PROGRAM_ID) {
      const seeds = [ owner.toBuffer(), programId.toBuffer(), mint.toBuffer() ];
      const [addr] = await (await loadWeb3()).PublicKey.findProgramAddress(seeds, associatedTokenProgramId);
      return addr;
    }
    const m = { TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID, getAssociatedTokenAddress };
    window.splToken = m;
    return m;
  }
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
      const { TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, createCloseAccountInstruction } = await loadSplToken();

      const ixs = [];
      const programs = [TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID].filter(Boolean);

      const addCloseIx = (ataPk, progId) => {
        try {
          if (typeof createCloseAccountInstruction === "function") {
            return createCloseAccountInstruction(ataPk, ownerPk, ownerPk, [], progId);
          }
        } catch {}
        return new TransactionInstruction({
          programId: progId,
          keys: [
            { pubkey: ataPk,   isSigner: false, isWritable: true }, // account
            { pubkey: ownerPk, isSigner: false, isWritable: true }, // destination
            { pubkey: ownerPk, isSigner: true,  isWritable: false },// owner
          ],
          data: Uint8Array.of(9),
        });
      };

      for (const pid of programs) {
        try {
          const resp = await conn.getParsedTokenAccountsByOwner(ownerPk, { programId: pid }, "processed");
          for (const it of resp?.value || []) {
            try {
              const info = it?.account?.data?.parsed?.info;
              if (!info || String(info.mint || "") !== SOL_MINT) continue;

              const ataPk = it?.pubkey?.toBase58 ? it.pubkey : new PublicKey(String(it?.pubkey || ""));
              const ai = await conn.getAccountInfo(ataPk, "processed").catch(() => null);
              if (!ai) continue; // nothing to close

              ixs.push(addCloseIx(ataPk, pid));
            } catch {}
          }
        } catch {}
      }

      if (!ixs.length) return false;

      // Send in small chunks
      const sendBatch = async (chunk) => {
        const tx = new Transaction();
        for (const ix of chunk) tx.add(ix);
        tx.feePayer = ownerPk;
        tx.recentBlockhash = (await conn.getLatestBlockhash("processed")).blockhash;
        tx.sign(signer);
        const sig = await conn.sendRawTransaction(tx.serialize(), { preflightCommitment: "processed", maxRetries: 2 });
        log(`WSOL unwrap sent: ${sig}`);
        return sig;
      };

      if (ixs.length <= 2) {
        await sendBatch(ixs);
      } else {
        for (const ix of ixs) { try { await sendBatch([ix]); } catch {} }
      }
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

async function confirmSig(sig, { commitment = "confirmed", timeoutMs = 12000, pollMs = 300, requireFinalized = false } = {}) {
  const conn = await getConn();
  const start = now();
  while (now() - start < timeoutMs) {
    try {
      const st = await conn.getSignatureStatuses([sig], { searchTransactionHistory: true });
      const v = st?.value?.[0];
      if (v) {
        const cs = v.confirmationStatus;
        const ok = (!v.err) && (requireFinalized ? cs === "finalized" : (cs === "confirmed" || cs === "finalized"));
        if (ok) return true;
        if (v.err) return false;
      }
    } catch {}
    await new Promise(r => setTimeout(r, pollMs));
  }
  return false;
}

async function waitForTokenDebit(ownerPubkeyStr, mintStr, prevSizeUi, { timeoutMs = 20000, pollMs = 350 } = {}) {
  const start = now();
  const prev = Number(prevSizeUi || 0);
  while (now() - start < timeoutMs) {
    try {
      const b = await getAtaBalanceUi(ownerPubkeyStr, mintStr, undefined);
      const cur = Number(b.sizeUi || 0);
      if (cur <= 1e-9 || cur < prev * 0.90) {
        return { debited: true, remainUi: cur, decimals: Number.isFinite(b.decimals) ? b.decimals : undefined };
      }
      if (cur < prev - 1e-9) { // any reduction
        return { debited: true, remainUi: cur, decimals: Number.isFinite(b.decimals) ? b.decimals : undefined };
      }
    } catch {}
    await new Promise(r => setTimeout(r, pollMs));
  }
  try {
    await reconcileFromOwnerScan(ownerPubkeyStr);
  } catch {}
  try {
    const b = await getAtaBalanceUi(ownerPubkeyStr, mintStr, undefined);
    return { debited: Number(b.sizeUi || 0) <= 1e-9, remainUi: Number(b.sizeUi || 0), decimals: Number.isFinite(b.decimals) ? b.decimals : undefined };
  } catch {
    return { debited: true, remainUi: 0, decimals: undefined };
  }
}

async function waitForTokenCredit(ownerPubkeyStr, mintStr, { timeoutMs = 8000, pollMs = 300 } = {}) {
  const conn = await getConn();
  const start = now();

  let decimals = 6;
  try { decimals = await getMintDecimals(mintStr); } catch {}

  let atas = [];
  try { atas = await getOwnerAtas(ownerPubkeyStr, mintStr); } catch {}
  while (now() - start < timeoutMs) {
    if (Array.isArray(atas) && atas.length) {
      for (const { ata } of atas) {
        try {
          const res = await conn.getTokenAccountBalance(ata, "processed");
          if (res?.value) {
            const ui = Number(res.value.uiAmount || 0);
            const dec = Number.isFinite(res.value.decimals) ? res.value.decimals : undefined;
            if (ui > 0) return { sizeUi: ui, decimals: Number.isFinite(dec) ? dec : decimals };
          }
        } catch {}
      }
    }
    try {
      const { PublicKey } = await loadWeb3();
      const { TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID } = await loadSplToken();
      const ownerPk = new PublicKey(ownerPubkeyStr);
      const tryScan = async (pid) => {
        if (!pid) return null;
        const resp = await conn.getParsedTokenAccountsByOwner(ownerPk, { programId: pid }, "processed");
        for (const it of resp?.value || []) {
          const info = it?.account?.data?.parsed?.info;
          if (String(info?.mint || "") !== mintStr) continue;
          const ta = info?.tokenAmount;
          const ui = Number(ta?.uiAmount || 0);
          const dec = Number(ta?.decimals);
          if (ui > 0) return { sizeUi: ui, decimals: Number.isFinite(dec) ? dec : decimals };
        }
        return null;
      };
      const hit1 = await tryScan(TOKEN_PROGRAM_ID);
      const hit2 = hit1 || await tryScan(TOKEN_2022_PROGRAM_ID);
      if (hit2 && Number(hit2.sizeUi || 0) > 0) return hit2;
    } catch {}
    await new Promise(r => setTimeout(r, pollMs));
    // Refresh ATAs once mid-loop
    try { if (!atas || !atas.length) atas = await getOwnerAtas(ownerPubkeyStr, mintStr); } catch {}
  }
  return { sizeUi: 0, decimals };
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

async function getMintDecimals(mintStr) {
  const SOL_MINT = "So11111111111111111111111111111111111111112";
  if (mintStr === SOL_MINT) return 9;
  try {
    const cfg = await getCfg();
    const cached = Number(cfg.tokenDecimals?.[mintStr]);
    if (Number.isFinite(cached)) return cached;
  } catch {}
  try {
    const { PublicKey } = await loadWeb3();
    const conn = await getConn();
    const info = await conn.getParsedAccountInfo(new PublicKey(mintStr), "processed");
    const d = Number(info?.value?.data?.parsed?.info?.decimals);
    return Number.isFinite(d) ? d : 6;
  } catch { return 6; }
}

function currentRpcUrl() {
  return String(state.rpcUrl || localStorage.getItem("fdv_rpc_url") || "").trim();
}

function currentRpcHeaders() {
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
  _conn = null; _connUrl = ""; _connHdrKey = "";
  save();
  log(`RPC URL set to: ${state.rpcUrl || "(empty)"}`);
}

function setRpcHeaders(jsonStr) {
  try {
    const obj = JSON.parse(String(jsonStr || "{}"));
    if (obj && typeof obj === "object") {
      state.rpcHeaders = obj;
      localStorage.setItem("fdv_rpc_headers", JSON.stringify(obj));
      _conn = null; _connUrl = ""; _connHdrKey = "";
      save();
      log(`RPC headers saved: ${redactHeaders(obj)}`);
      return true;
    }
  } catch {}
  log("Invalid RPC headers JSON.");
  return false;
}

async function loadWeb3() {
  if (window.solanaWeb3) return window.solanaWeb3;
  try {
    return await import('https://esm.sh/@solana/web3.js@1.95.1?bundle');
  } catch (_) {
    return await import('https://cdn.jsdelivr.net/npm/@solana/web3.js@1.95.1/lib/index.browser.esm.js');
  }
}

async function loadBs58() {
  if (window.bs58) return window.bs58;
  return (await import('https://esm.sh/bs58@5.0.0')).default;
}

async function loadDeps() {
  const web3 = await loadWeb3();
  const bs58 = await loadBs58();
  return { ...web3, bs58: { default: bs58 } };
}

async function getConn() {
  const url = currentRpcUrl().replace(/\/+$/,"");
  if (!url) throw new Error("RPC URL not configured");
  const headers = currentRpcHeaders();
  const hdrKey = JSON.stringify(headers);
  if (_conn && _connUrl === url && _connHdrKey === hdrKey) return _conn;
  const { Connection } = await loadWeb3();
  _conn = new Connection(url, { commitment: "confirmed", httpHeaders: headers });
  _connUrl = url; _connHdrKey = hdrKey;
  log(`RPC connection ready -> ${url} ${redactHeaders(headers)}`);
  return _conn;
}

async function fetchSolBalance(pubkeyStr) {
  if (!pubkeyStr) return 0;
  const { PublicKey } = await loadWeb3();
  const url = currentRpcUrl();
  if (!url) return 0;
  let lamports = 0;
  try {
    log(`Fetching SOL balance for ${pubkeyStr.slice(0,4)}…`);
    const conn = await getConn();
    lamports = await conn.getBalance(new PublicKey(pubkeyStr));
  } catch (e) {
    log(`Balance fetch failed: ${e.message || e}`);
    lamports = 0;
  }
  log(`Balance: ${(lamports/1e9).toFixed(6)} SOL`);
  return lamports / 1e9;
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

async function getAutoKeypair() {
  const { Keypair, bs58 } = await loadDeps();
  if (!state.autoWalletSecret) return null;
  try {
    const sk = bs58.default.decode(state.autoWalletSecret);
    return Keypair.fromSecretKey(Uint8Array.from(sk));
  } catch { return null; }
}

async function ensureAutoWallet() {
  if (state.autoWalletPub && state.autoWalletSecret) return state.autoWalletPub;
  const { Keypair, bs58 } = await loadDeps();
  const kp = Keypair.generate();
  state.autoWalletPub = kp.publicKey.toBase58();
  state.autoWalletSecret = bs58.default.encode(kp.secretKey);
  save();
  return state.autoWalletPub;
}

async function jupFetch(path, opts) {
  const base = await getJupBase();
  const url = `${base}${path}`;
  const isGet = !opts || String(opts.method || "GET").toUpperCase() === "GET";
  const isQuote = isGet && /\/quote(\?|$)/.test(path);

  const nowTs = Date.now();
  // Be gentler on /quote and add stress-aware spacing
  const minGapMs = isQuote ? 450 : 150;
  if (!window._fdvJupLastCall) window._fdvJupLastCall = 0;
  const stressLeft = Math.max(0, (window._fdvJupStressUntil || 0) - nowTs);
  const waitMs = Math.max(0, window._fdvJupLastCall + minGapMs - nowTs)
               + (isQuote ? Math.floor(Math.random()*200) : 0)
               + Math.min(2000, stressLeft);
  if (waitMs > 0) await new Promise(r => setTimeout(r, waitMs));
  window._fdvJupLastCall = Date.now();

  if (isGet) {
    if (!window._fdvJupInflight) window._fdvJupInflight = new Map();
    const inflight = window._fdvJupInflight;
    if (inflight.has(url)) return inflight.get(url);
  }

  if (isQuote) {
    if (!window._fdvJupQuoteCache) window._fdvJupQuoteCache = new Map();
    const cache = window._fdvJupQuoteCache;
    const hit = cache.get(url);
    if (hit && (Date.now() - hit.ts) < 1500) {
      log(`JUP cache hit: ${url}`);
      return new Response(JSON.stringify(hit.json), { status: 200, headers: { "content-type":"application/json" }});
    }
  }

  log(`JUP fetch: ${opts?.method || "GET"} ${url}`);

  async function doFetchWithRetry() {
    let lastRes = null, lastBody = "";
    for (let attempt = 0; attempt < 3; attempt++) {
      const res = await fetch(url, {
        headers: { accept: "application/json", ...(opts?.headers||{}) },
        ...opts,
      });
      lastRes = res;

      // Save successful quotes into memo
      if (res.ok && isQuote) {
        try {
          const json = await res.clone().json();
          if (!window._fdvJupQuoteCache) window._fdvJupQuoteCache = new Map();
          window._fdvJupQuoteCache.set(url, { ts: Date.now(), json });
        } catch {}
      }

      if (res.status !== 429) {
        if (!res.ok && isQuote && res.status === 400) {
          try { lastBody = await res.clone().text(); } catch {}
          if (/rate limit exceeded/i.test(lastBody)) {
            const backoff = 600 * Math.pow(2, attempt) + Math.floor(Math.random()*200);
            log(`JUP 400(rate-limit): backing off ${backoff}ms`);
            window._fdvJupStressUntil = Date.now() + 20_000;
            await new Promise(r => setTimeout(r, backoff));
            continue;
          }
        }
        return res;
      }
      // 429 backoff
      const backoff = 600 * Math.pow(2, attempt) + Math.floor(Math.random()*250);
      log(`JUP 429: backing off ${backoff}ms`);
      window._fdvJupStressUntil = Date.now() + 20_000;
      await new Promise(r => setTimeout(r, backoff));
    }
    return lastRes;
  }

  let p = doFetchWithRetry();
  if (isGet) {
    window._fdvJupInflight.set(url, p);
    try {
      const res = await p;
      log(`JUP resp: ${res.status} ${url}`);
      return res.clone(); 
    } finally {
      window._fdvJupInflight.delete(url);
    }
  } else {
    const res = await p;
    log(`JUP resp: ${res.status} ${url}`);
    return res;
  }
}

async function quoteOutSol(inputMint, amountUi, inDecimals) {
  if (!Number.isFinite(amountUi) || amountUi <= 0) {
    log("Valuation skip: zero size.");
    return 0;
  }
  const dec = Number.isFinite(inDecimals) ? inDecimals : await getMintDecimals(inputMint);
  const raw = Math.max(1, Math.floor(amountUi * Math.pow(10, dec)));
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

async function executeSwapWithConfirm(opts, { retries = 2, confirmMs = 15000 } = {}) {
  let slip = Math.max(150, Number(opts.slippageBps ?? state.slippageBps ?? 150) | 0);
  const prevDefer = !!window._fdvDeferSeed;
  window._fdvDeferSeed = true;
  let lastSig = null;
  try {
    const isBuy = (opts?.inputMint === SOL_MINT && opts?.outputMint && opts.outputMint !== SOL_MINT);
    const needFinal = isBuy;
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        const sig = await jupSwapWithKeypair({ ...opts, slippageBps: slip });
        lastSig = sig;

        if (isBuy) {
          try {
            const ownerStr = opts?.signer?.publicKey?.toBase58?.();
            if (ownerStr) {
              const s = getBuySeed(ownerStr, opts.outputMint);
              if (s && Number(s.sizeUi || 0) > 0) {
                optimisticSeedBuy(ownerStr, opts.outputMint, Number(s.sizeUi), Number(s.decimals), Number(opts.amountUi || 0), sig);
                clearBuySeed(ownerStr, opts.outputMint);
              }
            }
          } catch {}
        }

        const ok = await confirmSig(sig, {
          commitment: "confirmed",
          timeoutMs: confirmMs,
          requireFinalized: needFinal
        }).catch(() => false);
        if (ok) return { ok: true, sig, slip };

        // Avoid duplicate buys: do not retry a buy after first send
        if (isBuy) {
          log("Buy sent; skipping retries and relying on pending credit.");
          return { ok: false, sig, slip };
        }
      } catch (e) {
        const msg = String(e?.message || e || "");
        log(`Swap attempt ${attempt+1} failed: ${msg}`);
        if (/INSUFFICIENT_LAMPORTS/i.test(msg)) {
          return { ok: false, insufficient: true, msg, sig: lastSig };
        }
        if (/ROUTER_DUST|COULD_NOT_FIND_ANY_ROUTE|NO_ROUTE|BELOW_MIN_NOTIONAL|0x1788/i.test(msg)) {
          if (opts?.inputMint && opts?.outputMint === SOL_MINT && opts.inputMint !== SOL_MINT) {
            setRouterHold(opts.inputMint, ROUTER_COOLDOWN_MS);
          }
          return { ok: false, noRoute: true, msg, sig: lastSig };
        }
      }
      slip = Math.min(2000, Math.floor(slip * 1.6));
      log(`Swap not confirmed; retrying with slippage=${slip} bps…`);
    }
    return { ok: false, sig: lastSig };
  } finally {
    window._fdvDeferSeed = prevDefer;
  }
}

async function jupSwapWithKeypair({ signer, inputMint, outputMint, amountUi, slippageBps }) {
    const { PublicKey, VersionedTransaction } = await loadWeb3();
    const conn = await getConn();
    const userPub = signer.publicKey.toBase58();
    const feeBps = Number(getPlatformFeeBps() || 0);
    let feeAccount = null;
    let lastErrCode = "";

    if (feeBps > 0) {
      feeAccount = FEE_ATAS[inputMint] || null;
      if (feeAccount) {
        log(`Fee enabled: ATA ${feeAccount.slice(0,4)}… @ ${feeBps} bps`);
      } else {
        log("No hardcoded fee ATA for input mint; fees not collected this swap.");
      }
    }

    const inDecimals = await getMintDecimals(inputMint);
    const baseSlip = Math.max(150, Number(slippageBps ?? state.slippageBps ?? 150) | 0);
    const amountRaw = Math.max(1, Math.floor(amountUi * Math.pow(10, inDecimals)));

    let _preBuyRent = 0;
    if (inputMint === SOL_MINT && outputMint !== SOL_MINT) {
      try { _preBuyRent = await requiredAtaLamportsForSwap(userPub, inputMint, outputMint); } catch { _preBuyRent = 0; }
    }

    const baseUrl = await getJupBase();
    const isLite = /lite-api\.jup\.ag/i.test(baseUrl);
    const restrictAllowed = !isLite;

    const isSell = (inputMint !== SOL_MINT) && (outputMint === SOL_MINT);
    let restrictIntermediates = isSell ? "false" : "true";

    // Track pre-split balance and a reconciler only for split-sell fallbacks
    let _preSplitUi = 0;
    let _decHint = await getMintDecimals(inputMint).catch(() => 6);
    if (isSell) {
      try {
        const b0 = await getAtaBalanceUi(userPub, inputMint, _decHint);
        _preSplitUi = Number(b0.sizeUi || 0);
        if (Number.isFinite(b0.decimals)) _decHint = b0.decimals;
      } catch {}
    }

    async function notePendingBuySeed() {
      try {
        if (!(inputMint === SOL_MINT && outputMint !== SOL_MINT)) return;
        const outRaw = Number(quote?.outAmount || 0);
        if (!Number.isFinite(outRaw) || outRaw <= 0) return;
        const dec = await safeGetDecimalsFast(outputMint);
        const ui = outRaw / Math.pow(10, dec);
        if (ui > 0) {
          putBuySeed(userPub, outputMint, {
            sizeUi: ui,
            decimals: dec,
            costSol: Number(amountUi || 0),
          });
        }
      } catch {}
    }

    async function _reconcileSplitSellRemainder(sig) {
      try {
        await confirmSig(sig, { commitment: "confirmed", timeoutMs: 15000 }).catch(()=>{});
        let remainUi = 0, d = _decHint;
        try {
          const b1 = await getAtaBalanceUi(userPub, inputMint, d);
          remainUi = Number(b1.sizeUi || 0);
          if (Number.isFinite(b1.decimals)) d = b1.decimals;
        } catch {}
        if (remainUi <= 1e-9) {
          try { removeFromPosCache(userPub, inputMint); } catch {}
          try { clearPendingCredit(userPub, inputMint); } catch {}
          if (state.positions && state.positions[inputMint]) { delete state.positions[inputMint]; save(); }
          return;
        }
        const estRemainSol = await quoteOutSol(inputMint, remainUi, d).catch(() => 0);
        const minN = minSellNotionalSol();
        if (estRemainSol >= minN) {
          const prevSize = _preSplitUi > 0 ? _preSplitUi : (state.positions?.[inputMint]?.sizeUi || 0);
          const frac = prevSize > 0 ? Math.min(1, Math.max(0, remainUi / Math.max(1e-9, prevSize))) : 1;
          const pos = state.positions[inputMint];
          if (pos) {
            pos.sizeUi = remainUi;
            pos.decimals = d;
            pos.costSol = Number(pos.costSol || 0) * frac;
            pos.hwmSol  = Number(pos.hwmSol  || 0) * frac;
            pos.lastSellAt = now();
            save();
          }
          updatePosCache(userPub, inputMint, remainUi, d);
        } else {
          try { addToDustCache(userPub, inputMint, remainUi, d); } catch {}
          try { removeFromPosCache(userPub, inputMint); } catch {}
          if (state.positions && state.positions[inputMint]) { delete state.positions[inputMint]; save(); }
          log(`Split-sell remainder below notional for ${inputMint.slice(0,4)}… moved to dust cache.`);
        }
      } catch {}
    }
    
    function buildQuoteUrl({ outMint, slipBps, restrict, asLegacy = false, amountOverrideRaw }) {
      const u = new URL("/swap/v1/quote", "https://fdv.lol");
      const amt = Number.isFinite(amountOverrideRaw) ? amountOverrideRaw : amountRaw;
      u.searchParams.set("inputMint", inputMint);
      u.searchParams.set("outputMint", outMint);
      u.searchParams.set("amount", String(amt));
      u.searchParams.set("slippageBps", String(slipBps));
      u.searchParams.set("restrictIntermediateTokens", String(isLite ? true : (restrict === "false" ? false : true)));
      if (feeAccount && feeBps > 0) u.searchParams.set("platformFeeBps", String(feeBps));
      if (asLegacy) u.searchParams.set("asLegacyTransaction", "true");
      return u;
    }

    const q = buildQuoteUrl({ outMint: outputMint, slipBps: baseSlip, restrict: restrictIntermediates });
    logObj("Quote params", {
      inputMint, outputMint, amountUi, inDecimals, slippageBps: baseSlip,
      restrictIntermediateTokens: restrictIntermediates, feeBps: feeAccount ? feeBps : 0
    });

    let quote;
    let haveQuote = false;

    {
    try {
      const qRes = await jupFetch(q.pathname + q.search);
      if (!qRes.ok) {
        if (isSell) {
          const altRestrict = (restrictIntermediates === "false" ? "true" : (restrictAllowed ? "false" : "true"));
          const alt = buildQuoteUrl({ outMint: outputMint, slipBps: baseSlip, restrict: altRestrict });
          log(`Primary sell quote failed (${qRes.status}). Retrying with restrictIntermediateTokens=${alt.searchParams.get("restrictIntermediateTokens")} …`);
          const qRes2 = await jupFetch(alt.pathname + alt.search);
          if (qRes2.ok) {
            quote = await qRes2.json();
            haveQuote = true;
          } else {
            const body = await qRes2.text().catch(()=> "");
            log(`Sell quote retry failed: ${body || qRes2.status}`);
            haveQuote = false; // defer to split fallbacks
          }
        } else {
          throw new Error(`quote ${qRes.status}`);
        }
      } else {
        quote = await qRes.json();
        haveQuote = true;
      }
      if (haveQuote) {
        logObj("Quote", { inAmount: quote?.inAmount, outAmount: quote?.outAmount, routePlanLen: quote?.routePlan?.length });
      }
    } catch (e) {
      if (!isSell) throw e;
      haveQuote = false;
      log(`Sell quote error; will try split fallbacks: ${e.message || e}`);
    }
  }

  if (haveQuote) {
    // Skip tiny sells outright (no retries/fallbacks)
    if (isSell) {
      const outRaw = Number(quote?.outAmount || 0); // lamports
      const minOutLamports = Math.floor(Math.max(MIN_SELL_SOL_OUT, Number(state.dustMinSolOut || 0)) * 1e9);
      if (!Number.isFinite(outRaw) || outRaw <= 0 || outRaw < minOutLamports) {
        log(`Sell below minimum; skipping (${(outRaw/1e9).toFixed(6)} SOL < ${(minOutLamports/1e9).toFixed(6)})`);
        log('Consider exporting your wallet and selling DUST manually.');
        throw new Error("BELOW_MIN_NOTIONAL");
      }
    }

    const isRouteErr = (codeOrMsg) => /ROUTER_DUST|COULD_NOT_FIND_ANY_ROUTE|NO_ROUTE|0x1788/i.test(String(codeOrMsg||""));
    // let sawRouteDust = false;

    const first = await buildAndSend(false);
    if (first.ok) { await notePendingBuySeed(); await seedCacheIfBuy(); return first.sig; }
    if (!first.ok) lastErrCode = first.code || lastErrCode;
    if (first.code === "NOT_SUPPORTED") {
      log("Retrying with shared accounts …");
      const second = await buildAndSend(true);
      if (second.ok) { await notePendingBuySeed(); await seedCacheIfBuy(); return second.sig; }
      if (!second.ok) lastErrCode = second.code || lastErrCode;
    } else {
      log("Primary swap failed. Fallback: shared accounts …");
      const fallback = await buildAndSend(true);
      if (fallback.ok) { await notePendingBuySeed(); await seedCacheIfBuy(); return fallback.sig; }
      if (!fallback.ok) lastErrCode = fallback.code || lastErrCode;
    }

    {
      const manualSeq = [
        () => manualBuildAndSend(false),
        () => manualBuildAndSend(true),
      ];
      for (const t of manualSeq) {
        try {
          const r = await t();
          if (r?.ok) { await notePendingBuySeed(); await seedCacheIfBuy(); return r.sig; }
          if (r && !r.ok) lastErrCode = r.code || lastErrCode;
        } catch {}
      }
    }

   
    async function seedCacheIfBuy() {
      if (window._fdvDeferSeed) return;
      if (inputMint === SOL_MINT && outputMint !== SOL_MINT) {
        const estRaw = Number(quote?.outAmount || 0);
        if (estRaw > 0) {
          const dec = await safeGetDecimalsFast(outputMint);
          const ui = estRaw / Math.pow(10, dec);
          try {
            updatePosCache(userPub, outputMint, ui, dec);
            log(`Seeded cache for ${outputMint.slice(0,4)}… (~${ui.toFixed(6)})`);
          } catch {}
          setTimeout(() => {
            Promise.resolve()
              .then(() => syncPositionsFromChain(userPub).catch(()=>{}))
              .then(() => processPendingCredits().catch(()=>{}));
          }, 0);
        }
      }
    }

    async function buildAndSend(useSharedAccounts = true, asLegacy = false) {
      if (inputMint === SOL_MINT && outputMint !== SOL_MINT) {
        try {
          const balL = await conn.getBalance(signer.publicKey, "processed");
          const needL = amountRaw + Math.ceil(_preBuyRent) + TX_FEE_BUFFER_LAMPORTS;
          if (balL < needL) {
            log(`Buy preflight: insufficient SOL ${(balL/1e9).toFixed(6)} < ${(needL/1e9).toFixed(6)} (amount+rent+fees).`);
            throw new Error("INSUFFICIENT_LAMPORTS");
          }
        } catch (e) {
          if (String(e?.message||"").includes("INSUFFICIENT_LAMPORTS")) throw e;
        }
      }
      if (asLegacy) {
        try {
          const qLegacy = buildQuoteUrl({
            outMint: outputMint,
            slipBps: baseSlip,
            restrict: restrictIntermediates, // keep same, forced true on lite
            asLegacy: true
          });
          const qResL = await jupFetch(qLegacy.pathname + qLegacy.search);
          if (!qResL.ok) {
            const body = await qResL.text().catch(()=> "");
            log(`Legacy quote failed (${qResL.status}): ${body || "(empty)"}`);
          } else {
            quote = await qResL.json();
            log("Re-quoted for legacy transaction.");
          }
        } catch (e) {
          log(`Legacy re-quote error: ${e.message || e}`);
        }
      }

      const body = {
        quoteResponse: quote,
        userPublicKey: signer.publicKey.toBase58(),
        wrapAndUnwrapSol: true,
        dynamicComputeUnitLimit: true,
        useSharedAccounts: !!useSharedAccounts,
        asLegacyTransaction: !!asLegacy,
        ...(feeAccount && feeBps > 0 ? { feeAccount, platformFeeBps: feeBps } : {}),
      };
      logObj("Swap body", { hasFee: !!feeAccount, feeBps: feeAccount ? feeBps : 0, useSharedAccounts: !!useSharedAccounts, asLegacy: !!asLegacy });

      const sRes = await jupFetch(`/swap/v1/swap`, {
        method: "POST",
        headers: { "Content-Type":"application/json", accept: "application/json" },
        body: JSON.stringify(body),
      });
      if (!sRes.ok) {
        const errTxt = await sRes.text().catch(()=> "");
        log(`Swap error body: ${errTxt || "(empty)"}`);
        try {
          const j = JSON.parse(errTxt || "{}");
          return { ok: false, code: j?.errorCode || "", msg: j?.error || `swap ${sRes.status}` };
        } catch {
          return { ok: false, code: "", msg: `swap ${sRes.status}` };
        }
      }
      const { swapTransaction } = await sRes.json();
      if (!swapTransaction) throw new Error("no swapTransaction");
      const raw = atob(swapTransaction);
      const rawBytes = new Uint8Array(raw.length);
      for (let i=0; i<raw.length; i++) rawBytes[i] = raw.charCodeAt(i);
      const vtx = VersionedTransaction.deserialize(rawBytes);
      vtx.sign([signer]);
      try {
        const sig = await conn.sendRawTransaction(vtx.serialize(), { preflightCommitment: "processed", maxRetries: 3 });
        log(`Swap sent: ${sig}`);
        try { if (isSell) setTimeout(() => _reconcileSplitSellRemainder(sig), 0); } catch {}
        try {
          if (inputMint === SOL_MINT || outputMint === SOL_MINT) {
            setTimeout(() => { unwrapWsolIfAny(signer).catch(()=>{}); }, 0);
            setTimeout(() => { unwrapWsolIfAny(signer).catch(()=>{}); }, 1500);
          }
        } catch {}
        return { ok: true, sig };
      } catch (e) {
        log(`Swap send failed. NO_ROUTES/ROUTER_DUST. export help/wallet.json to recover dust funds. Simulating…`);
        try {
          const sim = await conn.simulateTransaction(vtx, { sigVerify: false, replaceRecentBlockhash: true });
          const logs = sim?.value?.logs || e?.logs || [];
          // log(`Simulation logs:\n${(logs||[]).join("\n")}`);
          const hasDustErr = (logs || []).some(l => /0x1788|0x1789/i.test(String(l)));
          // Surface router dust immediately
          return { ok: false, code: hasDustErr ? "ROUTER_DUST" : "SEND_FAIL", msg: e.message || String(e) };
        } catch {
          return { ok: false, code: "SEND_FAIL", msg: e.message || String(e) };
        }
      }
    }

    async function manualBuildAndSend(useSharedAccounts = true) {
      const { PublicKey, TransactionInstruction, TransactionMessage, VersionedTransaction } = await loadWeb3();
      try {
        const body = {
          quoteResponse: quote,
          userPublicKey: signer.publicKey.toBase58(),
          wrapAndUnwrapSol: true,
          dynamicComputeUnitLimit: true,
          useSharedAccounts: !!useSharedAccounts,
          asLegacyTransaction: false, // always v0
          ...(feeAccount && feeBps > 0 ? { feeAccount, platformFeeBps: feeBps } : {}),
        };
        logObj("Swap-instructions body (manual send)", {
          hasFee: !!feeAccount,
          feeBps: feeAccount ? feeBps : 0,
          useSharedAccounts: !!useSharedAccounts
        });

        const iRes = await jupFetch(`/swap/v1/swap-instructions`, {
          method: "POST",
          headers: { "Content-Type":"application/json", accept: "application/json" },
          body: JSON.stringify(body),
        });
        if (!iRes.ok) {
          const errTxt = await iRes.text().catch(()=> "");
          log(`Swap-instructions error: ${errTxt || iRes.status}`);
          const isNoRoute = /NO_ROUTE|COULD_NOT_FIND_ANY_ROUTE/i.test(errTxt);
          return { ok: false, code: isNoRoute ? "NO_ROUTE" : "JUP_DOWN", msg: `swap-instructions ${iRes.status}` };
        }

        const {
          computeBudgetInstructions = [],
          setupInstructions = [],
          swapInstruction,
          cleanupInstructions = [],
          addressLookupTableAddresses = [],
        } = await iRes.json();

        if (!swapInstruction) {
          return { ok: false, code: "NO_ROUTE", msg: "no swapInstruction" };
        }

        function decodeData(d) {
          if (!d) return new Uint8Array();
          if (d instanceof Uint8Array) return d;
          if (Array.isArray(d)) return new Uint8Array(d);
          if (typeof d === "string") {
            const raw = atob(d);
            const b = new Uint8Array(raw.length);
            for (let i=0;i<raw.length;i++) b[i] = raw.charCodeAt(i);
            return b;
          }
          return new Uint8Array();
        }
        function toIx(ix) {
          if (!ix) return null;
          const pid = new PublicKey(ix.programId);
          const keys = (ix.accounts || []).map(a => {
            if (typeof a === "string") return { pubkey: new PublicKey(a), isSigner: false, isWritable: false };
            const pk = a.pubkey || a.pubKey || a.address || a;
            return { pubkey: new PublicKey(pk), isSigner: !!a.isSigner, isWritable: !!a.isWritable };
          });
          const data = decodeData(ix.data);
          return new TransactionInstruction({ programId: pid, keys, data });
        }

        const ixs = [
          ...computeBudgetInstructions.map(toIx).filter(Boolean),
          ...setupInstructions.map(toIx).filter(Boolean),
          toIx(swapInstruction),
          ...cleanupInstructions.map(toIx).filter(Boolean),
        ].filter(Boolean);

        const lookups = [];
        for (const addr of addressLookupTableAddresses || []) {
          try {
            const lut = await conn.getAddressLookupTable(new PublicKey(addr));
            if (lut?.value) lookups.push(lut.value);
          } catch {}
        }

        const { blockhash } = await conn.getLatestBlockhash("confirmed");
        const msg = new TransactionMessage({
          payerKey: signer.publicKey,
          recentBlockhash: blockhash,
          instructions: ixs,
        }).compileToV0Message(lookups);

        const vtx = new VersionedTransaction(msg);
        vtx.sign([signer]);

        try {
          const sig = await conn.sendRawTransaction(vtx.serialize(), {
            preflightCommitment: "confirmed",
            maxRetries: 3,
          });
          const ok = await confirmSig(sig, { commitment: "confirmed", timeoutMs: 15000 });
          if (!ok) {
            const st = await conn.getSignatureStatuses([sig]).catch(()=>null);
            const status = st?.value?.[0]?.err ? "TX_ERR" : "NO_CONFIRM";
            return { ok: false, code: status, msg: "not confirmed" };
          }
          log(`Swap (manual send v0) sent: ${sig}`);
          try { if (isSell) setTimeout(() => _reconcileSplitSellRemainder(sig), 0); } catch {}
          try {
            if (inputMint === SOL_MINT || outputMint === SOL_MINT) {
              setTimeout(() => { unwrapWsolIfAny(signer).catch(()=>{}); }, 0);
              setTimeout(() => { unwrapWsolIfAny(signer).catch(()=>{}); }, 1500); 
            }
          } catch {}
          return { ok: true, sig };
        } catch (e) {
          log(`Manual send failed: ${e.message || e}. Simulating…`);
          try {
            const sim = await conn.simulateTransaction(vtx, { sigVerify: false, replaceRecentBlockhash: true });
            const logs = sim?.value?.logs || e?.logs || [];
            const hasDustErr = (logs || []).some(l => /0x1788|0x1789/i.test(String(l)));
            return { ok: false, code: hasDustErr ? "ROUTER_DUST" : "SEND_FAIL", msg: e.message || String(e) };
          } catch {
            return { ok: false, code: "SEND_FAIL", msg: e.message || String(e) };
          }
        }
      } catch (e) {
        return { ok: false, code: "", msg: e.message || String(e) };
      }
    }

    {
      log("Swap API failed - trying manual build/sign …");
      const tries = [
        () => manualBuildAndSend(false),
        () => manualBuildAndSend(true),
      ];
      for (const t of tries) {
        try {
          const r = await t();
          if (r?.ok) { 
            await notePendingBuySeed(); 
            await seedCacheIfBuy(); 
            return r.sig; 
          }
          if (r && !r.ok) lastErrCode = r.code || lastErrCode;
        } catch {}
      }
    }

    if (isSell) {
      try {
        const slip2 = 2000;
        const rFlag = restrictAllowed ? "false" : "true";
        const q2 = buildQuoteUrl({ outMint: outputMint, slipBps: slip2, restrict: rFlag });
        log(`Tiny-notional fallback: relax route, slip=${slip2} bps …`);
        const r2 = await jupFetch(q2.pathname + q2.search);
        if (r2.ok) {
          quote = await r2.json();
          const a = await buildAndSend(false, true);
          if (a.ok) { await seedCacheIfBuy(); return a.sig; }
          if (!a.ok) lastErrCode = a.code || lastErrCode;
          const b = await buildAndSend(true, true);
          if (b.ok) { await seedCacheIfBuy(); return b.sig; }
          if (!b.ok) lastErrCode = b.code || lastErrCode;
        }
      } catch {}

      try {
        const a = await buildAndSend(false, true);
        if (a.ok) { await seedCacheIfBuy(); return a.sig; }
        const b = await buildAndSend(true);
        if (b.ok) { await seedCacheIfBuy(); return b.sig; }
      } catch {}

      try {
        const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
        const slip3 = 2000;
        const rFlag = restrictAllowed ? "false" : "true";
        const q3 = buildQuoteUrl({ outMint: USDC, slipBps: slip3, restrict: rFlag });
        log("Strict fallback: route to USDC, then dump USDC->SOL …");
        const r3 = await jupFetch(q3.pathname + q3.search);
        if (r3.ok) {
          quote = await r3.json();
          const sendFns = [() => buildAndSend(false), () => buildAndSend(true), () => manualBuildAndSend(false), () => manualBuildAndSend(true)];
          for (const send of sendFns) {
            try {
              const r = await send();
              if (r?.ok) {
                const sig1 = r.sig;
                try { await confirmSig(sig1, { commitment: "confirmed", timeoutMs: 12000 }); } catch {}
                // Wait for USDC credit then swap USDC -> SOL
                try { await waitForTokenCredit(userPub, USDC, { timeoutMs: 12000, pollMs: 300 }); } catch {}
                let usdcUi = 0;
                try { const b = await getAtaBalanceUi(userPub, USDC, 6); usdcUi = Number(b.sizeUi || 0); } catch {}
                if (usdcUi > 0) {
                  const back = await executeSwapWithConfirm({
                    signer, inputMint: USDC, outputMint: SOL_MINT, amountUi: usdcUi, slippageBps: state.slippageBps,
                  }, { retries: 1, confirmMs: 15000 });
                  if (back.ok) return back.sig;
                  log("USDC->SOL dump failed after fallback; keeping USDC.");
                }
                return sig1;
              } else if (r && !r.ok) {
               lastErrCode = r.code || lastErrCode;
              }
            } catch {}
          }
        }
      } catch {}

      try {
        const slipSplit = 2000;
        for (const f of SPLIT_FRACTIONS) {
          const partRaw = Math.max(1, Math.floor(amountRaw * f));
          if (partRaw <= 0) continue;

          const restrictOptions = restrictAllowed ? ["false", "true"] : ["true"];
          for (const restrict of restrictOptions) {
            const qP = buildQuoteUrl({ outMint: outputMint, slipBps: slipSplit, restrict, amountOverrideRaw: partRaw });
            log(`Split-sell quote f=${f} restrict=${restrict} slip=${slipSplit}…`);
            const rP = await jupFetch(qP.pathname + qP.search);
            if (!rP.ok) continue;

            quote = await rP.json();
            const tries = [
              () => buildAndSend(false, false),
              () => buildAndSend(true, false),
              () => buildAndSend(false, true),
              () => buildAndSend(true, true),
            ];
            for (const t of tries) {
              try {
                const res = await t();
                if (res?.ok) {
                  log(`Split-sell succeeded at ${Math.round(f*100)}% of position.`);
                  try { setMintBlacklist(inputMint, MINT_RUG_BLACKLIST_MS); log(`Split-sell: blacklisted ${inputMint.slice(0,4)}… for 30m.`); } catch {}
                  try {
                    if (isSell) {
                      const dec = Number.isFinite(_decHint) ? _decHint : (Number.isFinite(inDecimals) ? inDecimals : 6);
                      const prevSize =
                        (_preSplitUi > 0 ? _preSplitUi : (state.positions?.[inputMint]?.sizeUi || 0));
                      const soldUi = partRaw / Math.pow(10, dec);
                      let remainUi = Math.max(0, prevSize - soldUi);

                      // Clamp to [0, prevSize] to guard rounding
                      if (!Number.isFinite(remainUi) || remainUi < 1e-12) remainUi = 0;
                      if (remainUi <= 1e-9) {
                        try { removeFromPosCache(userPub, inputMint); } catch {}
                        if (state.positions && state.positions[inputMint]) { delete state.positions[inputMint]; save(); }
                        log(`Split-sell cleared position for ${inputMint.slice(0,4)}… locally.`);
                      } else {
                        const estRemainSol = await quoteOutSol(inputMint, remainUi, dec).catch(() => 0);
                        const minN = minSellNotionalSol();
                        if (estRemainSol >= minN) {
                          const basePrev = prevSize > 0 ? prevSize : (state.positions?.[inputMint]?.sizeUi || remainUi);
                          const frac = basePrev > 0 ? Math.min(1, Math.max(0, remainUi / Math.max(1e-9, basePrev))) : 1;
                          const pos = state.positions[inputMint] || { costSol: 0, hwmSol: 0, acquiredAt: now() };
                          pos.sizeUi = remainUi;
                          pos.decimals = dec;
                          pos.costSol = Number(pos.costSol || 0) * frac;
                          pos.hwmSol  = Number(pos.hwmSol  || 0) * frac;
                          pos.lastSellAt = now();
                          state.positions[inputMint] = pos;
                          updatePosCache(userPub, inputMint, remainUi, dec);
                          save();
                          log(`Split-sell remainder kept: ${remainUi.toFixed(6)} ${inputMint.slice(0,4)}…`);
                        } else {
                          try { addToDustCache(userPub, inputMint, remainUi, dec); } catch {}
                          try { removeFromPosCache(userPub, inputMint); } catch {}
                          if (state.positions && state.positions[inputMint]) { delete state.positions[inputMint]; save(); }
                          log(`Split-sell remainder below notional; moved to dust cache (${remainUi.toFixed(6)}).`);
                        }
                      }
                    }
                  } catch {}

                  return res.sig;
                }
              } catch {}
            }
          }
        }
      } catch (e) {
        log(`Split-sell fallback error: ${e.message || e}`);
      }
    }
    throw new Error(lastErrCode || "swap failed");
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

      const res = await executeSwapWithConfirm({
        signer,
        inputMint: mint,
        outputMint: SOL_MINT,
        amountUi: uiAmt,
        slippageBps: state.slippageBps,
      }, { retries: 2, confirmMs: 15000 });

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

      log(`Sold ${uiAmt.toFixed(6)} ${mint.slice(0,4)}… -> ~${estSol.toFixed(6)} SOL`);
      const costSold = Number(state.positions[mint]?.costSol || 0);
      await addRealizedPnl(estSol, costSold, "Unwind PnL");

      if (state.positions[mint]) { delete state.positions[mint]; save(); }
      removeFromPosCache(owner, mint);
      if (item.from === "dust") removeFromDustCache(owner, mint);
    } catch (e) {
      log(`Sell fail ${mint.slice(0,4)}…: ${e.message||e}`);
    }
  }

  // Return SOL to recipient
  try { await unwrapWsolIfAny(signer); } catch {}
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
  // Robust field access
  const kp = it?.kp || {};
  const chg5m = safeNum(it?.change5m ?? kp.change5m, 0);
  const chg1h = safeNum(it?.change1h ?? kp.change1h, 0);
  const liq   = safeNum(it?.liqUsd   ?? kp.liqUsd,   0);
  const v1h   = safeNum(it?.v1hTotal ?? kp.v1hTotal, 0);
  const pScore= safeNum(it?.pumpScore ?? kp.pumpScore, 0);

  // Logarithmic scaling for liquidity/volume to avoid domination by whales
  const lLiq = Math.log1p(liq / 5000);     // ~soft-threshold near 5k
  const lVol = Math.log1p(v1h / 1000);     // ~soft-threshold near 1k
  const accel = chg1h > 0 ? (chg5m / chg1h) : (chg5m > 0 ? 2 : 0);

  // Composite score (tuned weights)
  const score =
    0.35 * chg5m +
    0.20 * chg1h +
    0.20 * lVol +
    0.10 * lLiq +
    0.10 * accel +
    0.05 * pScore;

  return score;
}

function setMintBlacklist(mint, ms = MINT_RUG_BLACKLIST_MS) {
  if (!mint) return;
  if (!window._fdvMintBlacklist) window._fdvMintBlacklist = new Map();

  // Backward-compat: stored value may be a number (until) or an object { until, count, lastAt }
  const nowTs = now();
  const prev = window._fdvMintBlacklist.get(mint);
  const prevCount = typeof prev === "object" && prev ? Number(prev.count || 0) : 0;
  const lastAt = typeof prev === "object" && prev ? Number(prev.lastAt || 0) : 0;

  // Coalesce bursts: only allow one stage bump per 10s window
  const COALESCE_WINDOW_MS = 10_000;
  const canBump = !lastAt || (nowTs - lastAt) > COALESCE_WINDOW_MS;

  const nextCount = Math.min(3, canBump ? (prevCount + 1) : prevCount || 1);

  // Choose stage duration, optionally capped by provided ms
  const stageMs = MINT_BLACKLIST_STAGES_MS[nextCount - 1] || MINT_RUG_BLACKLIST_MS;
  const capMs = Number.isFinite(ms) ? Math.max(60_000, ms | 0) : Infinity;
  const dur = Math.min(stageMs, capMs);

  // Extend, don't shorten
  const until = Math.max(Number(prev?.until || 0), nowTs + dur);
  window._fdvMintBlacklist.set(mint, { until, count: nextCount, lastAt: nowTs });
  try {
    const mins = Math.round((until - nowTs) / 60000);
    log(`Blacklist set (stage ${nextCount}/3, ${mins}m) for ${mint.slice(0,4)}… until ${new Date(until).toLocaleTimeString()}`);
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
  if (s.includes("warming")) return "warming";
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
  // Detect Pumping -> Calm transition and set a buy-ban window
  if (prevNorm === "pumping" && curNorm === "calm") {
    markPumpDropBan(mint, PUMP_TO_CALM_BAN_MS);
  }
} 
  
function _getSeriesStore() {
   if (!window._fdvLeaderSeries) window._fdvLeaderSeries = new Map(); // mint -> [{ts, pumpScore, liqUsd, v1h, chg5m, chg1h}]
   return window._fdvLeaderSeries;
}

function recordLeaderSample(mint, sample) {
  if (!mint) return;
  const s = _getSeriesStore();
  const list = s.get(mint) || [];
  const row = {
    ts: now(),
    pumpScore: safeNum(sample.pumpScore, 0),
    liqUsd:    safeNum(sample.liqUsd, 0),
    v1h:       safeNum(sample.v1h, 0),
    chg5m:     safeNum(sample.chg5m, 0),
    chg1h:     safeNum(sample.chg1h, 0),
  };
  list.push(row);
  // Keep last 3 samples only (previous 3 ticks)
  while (list.length > 3) list.shift();
  s.set(mint, list);
}

function getLeaderSeries(mint, n = 3) {
  const s = _getSeriesStore();
  const list = s.get(mint) || [];
  if (!n || n >= list.length) return list.slice();
  return list.slice(list.length - n);
}

function pickPumpCandidates(take = 1, poolN = 3) {
  try {
    const leaders = computePumpingLeaders(poolN) || [];
    const pool = [];
    for (const it of leaders) {
      const mint = it?.mint;
      if (!mint) continue;
      const sig = getRugSignalForMint(mint);
      recordBadgeTransition(mint, sig.badge);
      const b = normBadge(sig.badge);
      if (b !== "pumping") continue;
      if (isPumpDropBanned(mint) || isMintBlacklisted(mint)) continue;

      const kp = it?.kp || {};


      recordLeaderSample(mint, {
        pumpScore: Number(it?.pumpScore || 0),
        liqUsd:    safeNum(kp.liqUsd, 0),
        v1h:       safeNum(kp.v1hTotal, 0),
        chg5m:     safeNum(kp.change5m, 0),
        chg1h:     safeNum(kp.change1h, 0),
      });



      pool.push({
        mint,
        badge: sig.badge,
        pumpScore: Number(it?.pumpScore || 0),
        liqUsd: safeNum(kp.liqUsd, 0),
        v1h: safeNum(kp.v1hTotal, 0),
        chg5m: safeNum(kp.change5m, 0),
        chg1h: safeNum(kp.change1h, 0),
        score: scorePumpCandidate({ kp, pumpScore: it?.pumpScore }), // reuse local scorer
      });
    }

    if (!pool.length) return [];
    pool.sort((a,b) => b.score - a.score);
    const top = pool[0]?.score ?? -Infinity;
    const strong = pool.filter(x => x.score >= top * 0.85 && x.chg5m > 0);

    const chosen = (strong.length ? strong : pool).slice(0, Math.max(1, take)).map(x => x.mint);
    logObj("Pump picks", pool.slice(0, poolN));
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
  const r = m.get(mint) || { consec3: 0, lastPasses: 0, lastAt: 0 };
  if (passes === 3) {
    r.consec3 = (r.lastPasses === 3) ? (r.consec3 + 1) : 1;
  } else {
    r.consec3 = 0;
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

    const consecOk = (rec.consec3 + 1) >= needConsec;
    const drawdownOk = trailThr > 0 && ddPct >= trailThr;
    return consecOk || drawdownOk;
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
    log(`Observer: ${mint.slice(0,4)}… vanished from leaders; blacklisted 30m.`);
    return "";
  }

  // Observe for ~5s
  const start = now();
  let sN = s0;
  while (now() - start < 5000) {
    await new Promise(r => setTimeout(r, 1000));
    const s1 = await snapshot(mint);
    if (!s1) { sN = null; break; }
    sN = s1;
  }

  if (!sN) {
    setMintBlacklist(mint, MINT_RUG_BLACKLIST_MS);
    log(`Observer: ${mint.slice(0,4)}… dropped during watch; blacklisted 30m.`);
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

  if (passes === 3) {
    noteObserverConsider(mint, 30_000);
    return "";
  }

  const hold =
    passes >= 5 ? 120 :
    passes === 4 ? 95 : 70;
  const holdClamped = Math.min(120, Math.max(30, hold));
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

async function observeMintOnce(mint, { windowMs = 3000, sampleMs = 800, minPasses = 3, adjustHold = false } = {}) {
  if (!mint) return { ok: false, passes: 0 };

  const findLeader = () => {
    try { return (computePumpingLeaders(3) || []).find(x => x?.mint === mint) || null; } catch { return null; }
  };

  const it0 = findLeader();
  if (!it0) { setMintBlacklist(mint, MINT_RUG_BLACKLIST_MS); log(`Observer: ${mint.slice(0,4)}… not in leaders; blacklisted 30m.`); return { ok: false, passes: 0 }; }
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
    const itN = findLeader();
    if (!itN) { setMintBlacklist(mint, MINT_RUG_BLACKLIST_MS); log(`Observer: ${mint.slice(0,4)}… dropped; blacklisted 30m.`); return { ok: false, passes: 0 }; }
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
    setMintBlacklist(mint, MINT_RUG_BLACKLIST_MS);
    log(`Observer: reject ${mint.slice(0,4)}… (score ${passes}/5); blacklisted 30m.`);
    return { ok: false, passes };
  }

  const holdSecs = passes >= 5 ? 120 : passes === 4 ? 95 : 70;
  if (passes >= minPasses) {
    if (adjustHold) {
      const clamped = Math.min(120, Math.max(30, holdSecs));
      if (state.maxHoldSecs !== clamped) { state.maxHoldSecs = clamped; save(); }
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

async function getAtaBalanceUi(ownerPubkeyStr, mintStr, decimalsHint) {
  const conn = await getConn();
  const atas = await getOwnerAtas(ownerPubkeyStr, mintStr);
  let best = null;
  for (const { ata } of atas) {
    const res = await conn.getTokenAccountBalance(ata, "processed").catch(() => null);
    if (res?.value) {
      const sizeUi = Number(res.value.uiAmount || 0);
      const decimals = Number.isFinite(res.value.decimals) ? res.value.decimals : (await getMintDecimals(mintStr));
      if (sizeUi > 0) {
        updatePosCache(ownerPubkeyStr, mintStr, sizeUi, decimals);
        return { sizeUi, decimals, exists: true };
      }
      best = { sizeUi: 0, decimals: Number.isFinite(res.value.decimals) ? res.value.decimals : (await getMintDecimals(mintStr)), exists: true };
    }
  }
  let existsAny = false;
  for (const { ata } of atas) {
    const ai = await conn.getAccountInfo(ata, "processed").catch(() => null);
    existsAny = existsAny || !!ai;
  }
  const decimals = Number.isFinite(decimalsHint) ? decimalsHint : (await getMintDecimals(mintStr));
  if (best) return best;
  return { sizeUi: 0, decimals, exists: existsAny };
}

async function pruneZeroBalancePositions(ownerPubkeyStr, { limit = 8 } = {}) {
  try {
    const mints = Object.keys(state.positions || {}).filter(m => m && m !== SOL_MINT);
    if (!mints.length) return;
    let checked = 0;
    for (const mint of mints) {
      if (checked >= limit) break;
      try {
        const b = await getAtaBalanceUi(ownerPubkeyStr, mint, state.positions[mint]?.decimals);
        const ui = Number(b.sizeUi || 0);
        if (ui <= 1e-9) {
          removeFromPosCache(ownerPubkeyStr, mint);
          removeFromDustCache(ownerPubkeyStr, mint);
          clearPendingCredit(ownerPubkeyStr, mint);
          delete state.positions[mint];
          save();
          log(`Pruned zero-balance position ${mint.slice(0,4)}… from state/cache.`);
        }
        checked++;
      } catch {}
    }
  } catch {}
}

async function reconcileFromOwnerScan(ownerPubkeyStr) {
  try {
    const nowTs = now();
    if (nowTs - _lastOwnerReconTs < 5000) return;
    _lastOwnerReconTs = nowTs;

    const list = await listOwnerSplPositions(ownerPubkeyStr); // also updates cache
    if (!Array.isArray(list) || !list.length) return;
    for (const { mint, sizeUi, decimals } of list) {
      if (!mint || Number(sizeUi || 0) <= 0) continue;
      const prev = state.positions[mint] || { costSol: 0, hwmSol: 0, acquiredAt: nowTs };
      state.positions[mint] = {
        ...prev,
        sizeUi: Number(sizeUi),
        decimals: Number.isFinite(decimals) ? decimals : (prev.decimals ?? 6),
        lastSeenAt: nowTs,
        awaitingSizeSync: false,
      };
    }
    save();
  } catch {}
}

async function listOwnerSplPositions(ownerPubkeyStr) {
  if (state.ownerScanDisabled) {
    return cacheToList(ownerPubkeyStr);
  }
  const { PublicKey } = await loadWeb3();
  const { TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID } = await loadSplToken();
  const conn = await getConn();

  const out = [];
  const seen = new Set();
  async function scan(programId) {
    try {
      const resp = await conn.getParsedTokenAccountsByOwner(new PublicKey(ownerPubkeyStr), { programId }, "processed");
      for (const it of resp?.value || []) {
        const info = it?.account?.data?.parsed?.info;
        const mint = String(info?.mint || "");
        if (!mint || mint === SOL_MINT) continue;
        if (isMintInDustCache(ownerPubkeyStr, mint)) continue;
        const ta = info?.tokenAmount; const ui = Number(ta?.uiAmount || 0); const dec = Number(ta?.decimals);
        if (ui > 0 && !seen.has(mint)) {
          out.push({ mint, sizeUi: ui, decimals: Number.isFinite(dec) ? dec : 6 });
          seen.add(mint);
        }
      }
      return true;
    } catch (e) {
      if (isPlanUpgradeError(e)) { disableOwnerScans(e.message || e); return false; }
      log(`Parsed owner scan error (${programId.toBase58?.() || "unknown"}): ${e.message || e}`);
      return false;
    }
  }

  let any = false;
  if (TOKEN_PROGRAM_ID) any = (await scan(TOKEN_PROGRAM_ID)) || any;
  if (TOKEN_2022_PROGRAM_ID) any = (await scan(TOKEN_2022_PROGRAM_ID)) || any;

  if (!out.length) {
    const cached = cacheToList(ownerPubkeyStr);
    const verified = [];
    for (const it of cached) {
      try {
        const b = await getAtaBalanceUi(ownerPubkeyStr, it.mint, it.decimals);
        const ui = Number(b.sizeUi || 0);
        const dec = Number.isFinite(b.decimals) ? b.decimals : it.decimals;
        if (ui > 0) {
          updatePosCache(ownerPubkeyStr, it.mint, ui, dec);
          verified.push({ mint: it.mint, sizeUi: ui, decimals: dec });
        } else {
          removeFromPosCache(ownerPubkeyStr, it.mint);
        }
      } catch {}
    }
    if (!verified.length) log("Owner scan empty; cache fallback had no live balances.");
    return verified;
  }
  for (const r of out) updatePosCache(ownerPubkeyStr, r.mint, r.sizeUi, r.decimals);
  return out;
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
        const pendKey = _pcKey(ownerPubkeyStr, mint);
        const hasPending = _pendingCredits?.has?.(pendKey);
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
      const estSol = await quoteOutSol(mint, sizeUi, decimals).catch(() => 0);
      const minNotional = minSellNotionalSol();
      if (estSol < minNotional) {
        moveRemainderToDust(owner, mint, sizeUi, decimals);
        unsellable++;
        continue;
      }

      const res = await executeSwapWithConfirm({
        signer: kp, inputMint: mint, outputMint: SOL_MINT, amountUi: sizeUi, slippageBps: state.slippageBps,
      }, { retries: 1, confirmMs: 15000 });

      if (!res.ok) throw new Error("route execution failed");

      log(`Startup sweep sold ${sizeUi.toFixed(6)} ${mint.slice(0,4)}… -> ~${estSol.toFixed(6)} SOL`);
      const costSold = Number(state.positions[mint]?.costSol || 0);
      await addRealizedPnl(estSol, costSold, "Startup sweep PnL");
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

  const dust = dustCacheToList(owner) || [];
  if (!dust.length) {
    log("Startup dust sweep: no entries.");
    return;
  }

  let sold = 0, kept = 0, pruned = 0;
  for (const it of dust) {
    const mint = it.mint;
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

      const res = await executeSwapWithConfirm({
        signer: kp,
        inputMint: mint,
        outputMint: SOL_MINT,
        amountUi: uiAmt,
        slippageBps: state.slippageBps,
      }, { retries: 2, confirmMs: 15000 });

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
  const tp       = Math.max(0, Number(state.takeProfitPct || 0));
  const sl       = Math.max(0, Number(state.stopLossPct || 0));
  const trail    = Math.max(0, Number(state.trailPct || 0));
  const armTrail = Math.max(0, Number(state.minProfitToTrailPct || 0));
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
    // 1) Explicit rug signal wins
    const sig = getRugSignalForMint(mint);
    if (sig?.rugged) return { trigger: true, reason: `rug sev=${Number(sig.sev||0).toFixed(2)}`, sev: Number(sig.sev||1) };

    // 2) Pump->Calm transition with recent buys and drawdown
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

    // 3) Short-term trend deteriorating (3-sample series)
    const series = getLeaderSeries(mint, 3);
    if (series && series.length >= 3) {
      const a = series[0], c = series[series.length - 1];
      const passChg = c.chg5m <= a.chg5m;
      const passScore = c.pumpScore <= a.pumpScore * 0.97;
      if (passChg && passScore) return { trigger: true, reason: "momentum drop (3/5)", sev: 0.6 };
    }
  } catch {}
  return { trigger: false };
}

function startFastObserver() {
  if (window._fdvFastObsTimer) return;
  window._fdvFastObsTimer = setInterval(() => {
    try {
      // Only examine held positions; do not call Jupiter or heavy RPC here.
      const entries = Object.entries(state.positions || {});
      if (!entries.length) return;
      for (const [mint, pos] of entries) {
        if (!mint || mint === SOL_MINT) continue;
        if (Number(pos.sizeUi || 0) <= 0) continue;
        logFastObserverSample(mint, pos);
        const r = fastDropCheck(mint, pos);
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

async function evalAndMaybeSellPositions() {
  if (state.holdUntilLeaderSwitch) return;
  if (_inFlight) return;
  if (_sellEvalRunning) return; 
  _sellEvalRunning = true;
  try {
    const kp = await getAutoKeypair();
    if (!kp) return;

    await syncPositionsFromChain(kp.publicKey.toBase58());
    await pruneZeroBalancePositions(kp.publicKey.toBase58(), { limit: 8 });
    const entries = Object.entries(state.positions || {});
    if (!entries.length) return;

    const nowTs = now();
    for (const [mint, pos] of entries) {
      try {
        const ageMs = nowTs - Number(pos.lastBuyAt || pos.acquiredAt || 0);
        const maxHold = Math.max(0, Number(state.maxHoldSecs || 0));
        const forceExpire = maxHold > 0 && ageMs >= maxHold * 1000;


        if (!forceExpire && window._fdvRouterHold && window._fdvRouterHold.get(mint) > now()) {
          const until = window._fdvRouterHold.get(mint);
          log(`Router cooldown for ${mint.slice(0,4)}… until ${new Date(until).toLocaleTimeString()}`);
          continue;
        }

        const sz = Number(pos.sizeUi || 0);
        if (sz <= 0) {
          log(`Skip sell eval for ${mint.slice(0,4)}… (no size)`);
          continue;
        }

        const ownerStr = kp.publicKey.toBase58();
        const pendKey = _pcKey(ownerStr, mint);
        const hasPending = !!(_pendingCredits?.has?.(pendKey));
        const creditGraceMs = Math.max(8_000, Number(state.pendingGraceMs || 20_000));

        if ((pos.awaitingSizeSync || hasPending) && ageMs < creditGraceMs) {
          log(`Sell skip ${mint.slice(0,4)}… awaiting credit/size sync (${Math.round(ageMs/1000)}s).`);
          continue;
        }

        let forceRug = false;
        let rugSev = 0;
        let forcePumpDrop = false;
        let forceObserverDrop = false;
        let obsPasses = null; 
        const urgent = takeUrgentSell(mint);
        if (urgent) {
          if (ageMs < URGENT_SELL_MIN_AGE_MS) {
            log(`Urgent sell suppressed (warmup ${Math.round(ageMs/1000)}s) for ${mint.slice(0,4)}…`);
          } else {
            forceObserverDrop = true;
            rugSev = Number(urgent.sev || 1);
            log(`Urgent sell for ${mint.slice(0,4)}… (${urgent.reason}); bypassing notional/cooldowns.`);
          }
        }
        try {
          const sig = getRugSignalForMint(mint);
          recordBadgeTransition(mint, sig.badge);
          if (sig?.rugged) {
            forceRug = true;
            rugSev = Number(sig.sev || 0);
            setMintBlacklist(mint, MINT_RUG_BLACKLIST_MS);
            log(`Rug detected for ${mint.slice(0,4)}… sev=${rugSev.toFixed(2)}. Forcing sell and blacklisting 30m.`);
          } else {
            const curNorm = normBadge(sig.badge);
            if (curNorm === "calm" && isPumpDropBanned(mint)) {
              forcePumpDrop = true;
              log(`Pump->Calm drop for ${mint.slice(0,4)}… forcing sell and banning re-buys for 30m.`);
            }
          }
        } catch {}

        if (!forceRug && !forcePumpDrop) {
          try {
            const obs = await observeMintOnce(mint, { windowMs: 2000, sampleMs: 600, minPasses: 4, adjustHold: !!state.dynamicHoldEnabled });
            if (!obs.ok) {
              const p = Number(obs.passes || 0);
              recordObserverPasses(mint, p);
              const thr = Math.max(0, Number(state.observerDropSellAt ?? 3));
              if (p <= 2) {
                forceObserverDrop = true;
                setMintBlacklist(mint, MINT_RUG_BLACKLIST_MS);
                log(`Observer drop for ${mint.slice(0,4)}… (${p}/5 <= 2) forcing sell and blacklisting 30m.`);
              } else if (p === 3 && thr >= 3) {
                // Soft-watch; hysteresis to avoid flip-flopping
                obsPasses = 3;
              }
            } else {
              recordObserverPasses(mint, Number(obs.passes || 5));
            }
          } catch {}
        }

        let curSol = Number(pos.lastQuotedSol || 0);
        const lastQ = Number(pos.lastQuotedAt || 0);
        if (!lastQ || (nowTs - lastQ) > (state.minQuoteIntervalMs|0)) {
          log(`Evaluating sell for ${mint.slice(0,4)}… size ${sz.toFixed(6)}`);
          curSol = await quoteOutSol(mint, sz, pos.decimals).catch(() => 0);
          pos.lastQuotedSol = curSol;
          pos.lastQuotedAt = nowTs;
        }

        if (!forceRug && !forcePumpDrop && !forceObserverDrop && obsPasses === 3) {
          const should = shouldForceSellAtThree(mint, pos, curSol, nowTs);
          if (should) {
            forceObserverDrop = true;
            setMintBlacklist(mint, MINT_RUG_BLACKLIST_MS);
            log(`Observer 3/5 debounced -> forcing sell (${mint.slice(0,4)}…) and blacklisting 30m.`);
          } else {
            log(`Observer 3/5 for ${mint.slice(0,4)}… soft-watch; debounce active (no sell).`);
            noteObserverConsider(mint, 30_000);
          }
        }

        const baseMinNotional = Math.max(MIN_SELL_SOL_OUT, MIN_JUP_SOL_IN * 1.05);
        const minNotional = baseMinNotional;
        let d = null;


        if (curSol < minNotional && !forceExpire && !forceRug && !forcePumpDrop && !forceObserverDrop) {
          d = shouldSell(pos, curSol, nowTs);
          const dustMin = Math.max(MIN_SELL_SOL_OUT, Number(state.dustMinSolOut || 0));
          if (!(state.dustExitEnabled && d.action === "sell_all" && curSol >= dustMin)) {
            log(`Skip sell eval ${mint.slice(0,4)}… (notional ${curSol.toFixed(6)} SOL < ${minNotional})`);
            continue;
          } else {
            log(`Dust exit enabled for ${mint.slice(0,4)}… (est ${curSol.toFixed(6)} SOL >= ${dustMin})`);
          }
        } else if (curSol < minNotional && !forceExpire && (forceRug || forcePumpDrop || forceObserverDrop)) {
          const why = forceRug ? "Rug" : (forcePumpDrop ? "Pump->Calm" : "Observer");
          log(`${why} exit for ${mint.slice(0,4)}… ignoring min-notional (${curSol.toFixed(6)} SOL < ${minNotional}).`);
        }

        let decision = d || shouldSell(pos, curSol, nowTs);
        if (forceRug) {
          decision = { action: "sell_all", reason: `rug sev=${rugSev.toFixed(2)}` };
        } else if (forcePumpDrop) {
          decision = { action: "sell_all", reason: "pump->calm" };
        } else if (forceObserverDrop) {
          decision = { action: "sell_all", reason: "observer detection system" };
        } else if (forceExpire && (!decision || decision.action === "none")) {
          decision = { action: "sell_all", reason: `max-hold>${maxHold}s` };
          log(`Max-hold reached for ${mint.slice(0,4)}… forcing sell.`);
        }

        if (!decision) {
          const staleMins = Math.max(0, Number(state.staleMinsToDeRisk || 0));
          const isStale = staleMins > 0 && pos.acquiredAt && (nowTs - pos.acquiredAt) > staleMins * 60_000;
          if (isStale && curSol >= minNotional) {
            decision = { action: "sell_all", reason: `stale>${staleMins}m` };
          } else {
            decision = shouldSell(pos, curSol, nowTs);
          }
        }
        log(`Sell decision: ${decision.action !== "none" ? decision.action : "NO"} (${decision.reason || "criteria not met"})`);
        if (decision.action === "none") continue;

        // Jupiter 0x1788 = cooldown
        if (!forceExpire && window._fdvRouterHold && window._fdvRouterHold.get(mint) > now()) {
          const until = window._fdvRouterHold.get(mint);
          log(`Router cooldown for ${mint.slice(0,4)}… until ${new Date(until).toLocaleTimeString()}`);
          continue;
        }

        _inFlight = true;
        lockMint(mint, "sell", Math.max(MINT_OP_LOCK_MS, Number(state.sellCooldownMs||20000)));

        if (decision.action === "sell_partial") {
          const pct = Math.min(100, Math.max(1, Number(decision.pct || 50)));
          let sellUi = pos.sizeUi * (pct / 100);

          try {
            const b = await getAtaBalanceUi(kp.publicKey.toBase58(), mint, pos.decimals);
            if (Number(b.sizeUi || 0) > 0) sellUi = Math.min(sellUi, Number(b.sizeUi));
          } catch {}

          const estSol = await quoteOutSol(mint, sellUi, pos.decimals).catch(() => 0);
          if (estSol < minNotional) {
            if (curSol >= minNotional) {
              log(`Partial ${pct}% ${mint.slice(0,4)}… below min (${estSol.toFixed(6)} SOL < ${minNotional}). Escalating to full sell …`);
              let sellUi2 = pos.sizeUi;
              try {
                const b = await getAtaBalanceUi(kp.publicKey.toBase58(), mint, pos.decimals);
                if (Number(b.sizeUi || 0) > 0) sellUi2 = Number(b.sizeUi);
              } catch {}

              const res2 = await executeSwapWithConfirm({
                signer: kp, inputMint: mint, outputMint: SOL_MINT, amountUi: sellUi2, slippageBps: state.slippageBps,
              }, { retries: 1, confirmMs: 15000 });

              if (!res2.ok) {
                if (res2.noRoute) setRouterHold(mint, ROUTER_COOLDOWN_MS);
                log(`Sell not confirmed for ${mint.slice(0,4)}… Keeping position.`);
                _inFlight = false;
                unlockMint(mint);
                continue;
              }

              const prevSize2 = Number(pos.sizeUi || sellUi2);
              const debit = await waitForTokenDebit(kp.publicKey.toBase58(), mint, prevSize2, { timeoutMs: 25000, pollMs: 400 });
              const remainUi2 = Number(debit.remainUi || 0); 

              if (remainUi2 > 1e-9) {
                let chkUi = remainUi2, chkDec = pos.decimals;
                try {
                  const chk = await getAtaBalanceUi(kp.publicKey.toBase58(), mint, pos.decimals);
                  chkUi = Number(chk.sizeUi || 0);
                  if (Number.isFinite(chk.decimals)) chkDec = chk.decimals;
                } catch {}
                if (chkUi <= 1e-9) {
                  delete state.positions[mint];
                  removeFromPosCache(kp.publicKey.toBase58(), mint);
                  try { clearPendingCredit(kp.publicKey.toBase58(), mint); } catch {}
                } else {
                  const estRemainSol = await quoteOutSol(mint, chkUi, chkDec).catch(() => 0);
                  const minN = minSellNotionalSol();
                  if (estRemainSol >= minN) {
                    pos.sizeUi = chkUi;
                    if (Number.isFinite(chkDec)) pos.decimals = chkDec;
                    updatePosCache(kp.publicKey.toBase58(), mint, pos.sizeUi, pos.decimals);
                  } else {
                    try { addToDustCache(kp.publicKey.toBase58(), mint, chkUi, chkDec ?? 6); } catch {}
                    try { removeFromPosCache(kp.publicKey.toBase58(), mint); } catch {}
                    delete state.positions[mint];
                    save();
                    log(`Leftover below notional for ${mint.slice(0,4)}… moved to dust cache.`);
                  }
                }
              } else {
                const reason = (decision && decision.reason) ? decision.reason : "done";
                const estFullSol = curSol > 0 ? curSol : await quoteOutSol(mint, sellUi2, pos.decimals).catch(()=>0);
                log(`Sold ${sellUi2.toFixed(6)} ${mint.slice(0,4)}… -> ~${estFullSol.toFixed(6)} SOL (${reason})`);
                const costSold = Number(pos.costSol || 0);
                await addRealizedPnl(estFullSol, costSold, "Full sell PnL");
                delete state.positions[mint];
                removeFromPosCache(kp.publicKey.toBase58(), mint);
                try { clearPendingCredit(kp.publicKey.toBase58(), mint); } catch {}
                save();
              }
              state.lastTradeTs = now();
              _inFlight = false;
              unlockMint(mint);
              save();
              return; // one sell per tick
            } else {
              log(`Skip partial ${pct}% ${mint.slice(0,4)}… (est ${estSol.toFixed(6)} SOL < ${minNotional})`);
              _inFlight = false;
              continue;
            }
          }

          const res = await executeSwapWithConfirm({
            signer: kp, inputMint: mint, outputMint: SOL_MINT, amountUi: sellUi, slippageBps: state.slippageBps,
          }, { retries: 1, confirmMs: 15000 });

          if (!res.ok) {
            if (res.noRoute) setRouterHold(mint, ROUTER_COOLDOWN_MS);
            log(`Sell not confirmed for ${mint.slice(0,4)}… (partial). Keeping position.`);
            _inFlight = false;
            unlockMint(mint);
            continue;
          }

          log(`Sold ${sellUi.toFixed(6)} ${mint.slice(0,4)}… -> ~${estSol.toFixed(6)} SOL (${(decision && decision.reason) ? decision.reason : "done"})`);

          // Proportional cost basis for partial exits
          const prevCostSol = Number(pos.costSol || 0);
          const costSold = prevCostSol * (pct / 100);
          const remainPct = 1 - (pct / 100);
          pos.sizeUi = Math.max(0, pos.sizeUi - sellUi);
          pos.costSol = Number(pos.costSol || 0) * remainPct;
          pos.hwmSol = Number(pos.hwmSol || 0) * remainPct;
          pos.hwmPx = Number(pos.hwmPx || 0);
          pos.lastSellAt = now();
          pos.allowRebuy = true;
          pos.lastSplitSellAt = now();

          try {
            const debit = await waitForTokenDebit(kp.publicKey.toBase58(), mint, sellUi, { timeoutMs: 20000, pollMs: 350 });
            const remainUi = Number(debit.remainUi || pos.sizeUi || 0);
            if (remainUi > 1e-9) {
              const estRemainSol = await quoteOutSol(mint, remainUi, pos.decimals).catch(() => 0);
              const minN = minSellNotionalSol();
              if (estRemainSol >= minN) {
                pos.sizeUi = remainUi;
                if (Number.isFinite(debit.decimals)) pos.decimals = debit.decimals;
                updatePosCache(kp.publicKey.toBase64 ? kp.publicKey.toBase64() : kp.publicKey.toBase58(), mint, pos.sizeUi, pos.decimals);
                updatePosCache(kp.publicKey.toBase58(), mint, pos.sizeUi, pos.decimals);
              } else {
                try { addToDustCache(kp.publicKey.toBase58(), mint, remainUi, pos.decimals ?? 6); } catch {}
                try { removeFromPosCache(kp.publicKey.toBase58(), mint); } catch {}
                try { clearPendingCredit(kp.publicKey.toBase58(), mint); } catch {}
                delete state.positions[mint];
                save();
                log(`Leftover below notional for ${mint.slice(0,4)}… moved to dust cache.`);
              }
            } else {
              // fully gone
              delete state.positions[mint];
              removeFromPosCache(kp.publicKey.toBase58(), mint);
              try { clearPendingCredit(kp.publicKey.toBase58(), mint); } catch {}
            }
          } catch {
            updatePosCache(kp.publicKey.toBase58(), mint, pos.sizeUi, pos.decimals);
          }
          save();

          await addRealizedPnl(estSol, costSold, "Partial sell PnL");
        } else {
          let sellUi = pos.sizeUi;
          try {
            const b = await getAtaBalanceUi(kp.publicKey.toBase58(), mint, pos.decimals);
            if (Number(b.sizeUi || 0) > 0) sellUi = Number(b.sizeUi);
          } catch {}

          const res = await executeSwapWithConfirm({
            signer: kp, inputMint: mint, outputMint: SOL_MINT, amountUi: sellUi, slippageBps: state.slippageBps,
          }, { retries: 1, confirmMs: 15000 });

          if (!res.ok) {
            if (res.noRoute) setRouterHold(mint, ROUTER_COOLDOWN_MS);
            log(`Sell not confirmed for ${mint.slice(0,4)}… Keeping position.`);
            _inFlight = false;
            unlockMint(mint);
            continue;
          }

          // clearRouteDustFails(mint);

          const prevSize = Number(pos.sizeUi || sellUi);
          const debit = await waitForTokenDebit(kp.publicKey.toBase58(), mint, prevSize, { timeoutMs: 25000, pollMs: 400 });
          const remainUi = Number(debit.remainUi || 0);
          if (remainUi > 1e-9) {
            const estRemainSol = await quoteOutSol(mint, remainUi, pos.decimals).catch(() => 0);
            const minN = minSellNotionalSol();
            if (estRemainSol >= minN) {
              const frac = Math.min(1, Math.max(0, remainUi / Math.max(1e-9, prevSize)));
              pos.sizeUi = remainUi;
              pos.costSol = Number(pos.costSol || 0) * frac;
              pos.hwmSol  = Number(pos.hwmSol  || 0) * frac;
              pos.lastSellAt = now();
              updatePosCache(kp.publicKey.toBase58(), mint, pos.sizeUi, pos.decimals);
              save();
              setRouterHold(mint, ROUTER_COOLDOWN_MS);
              log(`Post-sell balance remains ${remainUi.toFixed(6)} ${mint.slice(0,4)}… (keeping position; router cooldown applied)`);
            } else {
              try { addToDustCache(kp.publicKey.toBase58(), mint, remainUi, pos.decimals ?? 6); } catch {}
              try { removeFromPosCache(kp.publicKey.toBase58(), mint); } catch {}
              delete state.positions[mint];
              save();
              log(`Leftover below notional for ${mint.slice(0,4)}… moved to dust cache.`);
            }
          } else {
            const reason = (decision && decision.reason) ? decision.reason : "done";
            const estFullSol = curSol > 0 ? curSol : await quoteOutSol(mint, sellUi, pos.decimals).catch(()=>0);
            log(`Sold ${sellUi.toFixed(6)} ${mint.slice(0,4)}… -> ~${estFullSol.toFixed(6)} SOL (${reason})`);
            const costSold = Number(pos.costSol || 0);
            await addRealizedPnl(estFullSol, costSold, "Full sell PnL");
            delete state.positions[mint];
            removeFromPosCache(kp.publicKey.toBase58(), mint);
            save();
          }
        }

        state.lastTradeTs = now();
        _inFlight = false;
        save();
        return; // one sell per tick
      } catch (e) {
        log(`Sell check failed for ${mint.slice(0,4)}…: ${e.message||e}`);
      } finally {
        _inFlight = false;
      }
    }
  } finally {
    _sellEvalRunning = false;
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
        const res = await executeSwapWithConfirm({
          signer: kp,
          inputMint: mint,
          outputMint: SOL_MINT,
          amountUi: uiAmt,
          slippageBps: state.slippageBps,
        }, { retries: 2, confirmMs: 15000 });

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
        log(`Rotated out: ${uiAmt.toFixed(6)} ${mint.slice(0,4)}… -> ~${estSol.toFixed(6)} SOL`);
        const costSold = Number(state.positions[mint]?.costSol || 0);
        await addRealizedPnl(estSol, costSold, "Rotation PnL");
        delete state.positions[mint];
        removeFromPosCache(owner, mint);
        save();
        rotated++;
      } catch (e) {
        log(`Rotate sell failed ${mint.slice(0,4)}…: ${e.message || e}`);
      }
    }
    log(`Rotation complete. Sold ${rotated} token${rotated===1?"":"s"}.`);
    state.currentLeaderMint = newMint;
    save();
    if (rotated > 0) {
      state.lastTradeTs = now();
      save();
      return true;
    }
    return false;
  } finally {
    _switchingLeader = false;
  }
}

async function tick() {
  const endIn = state.endAt ? ((state.endAt - now())/1000).toFixed(0) : "0";
  if (!state.enabled) return;
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
    fetchSolBalance(state.autoWalletPub).then(b => { depBalEl.value = `${b.toFixed(4)} SOL`; }).catch(()=>{});
  }

  try { await processPendingCredits(); } catch {}

  try {
    const kpTmp = await getAutoKeypair();
    if (kpTmp && (_pendingCredits?.size > 0)) {
      await reconcileFromOwnerScan(kpTmp.publicKey.toBase58());
    }
  } catch {}

  try { await evalAndMaybeSellPositions(); } catch {}

  log("Follow us on twitter: https://twitter.com/fdvlol for updates and announcements!");

  if (_buyInFlight || _inFlight || _switchingLeader) return;

  if (window._fdvJupStressUntil && now() < window._fdvJupStressUntil) {
    const left = Math.ceil((window._fdvJupStressUntil - now()) / 1000);
    log(`Backoff active (${left}s); pausing new buys.`);
    return;
  }

  const leaderMode = !!state.holdUntilLeaderSwitch;
  let picks = [];
  if (leaderMode) {
    const p = await pickTopPumper();
    if (p) picks = [p];
  } else if (state.allowMultiBuy) {
    const primary = await pickTopPumper(); // requires >=4/5 internally
    const rest = pickPumpCandidates(Math.max(1, state.multiBuyTopN|0), 3)
      .filter(m => m && m !== primary);
    picks = [primary, ...rest].filter(Boolean);
  } else {
    const p = await pickTopPumper();
    if (p) picks = [p];
  }
  if (!picks.length) return;

  let ignoreCooldownForLeaderBuy = false;
  if (leaderMode && picks[0]) {
    const didRotate = await switchToLeader(picks[0]);
    if (didRotate) ignoreCooldownForLeaderBuy = true;
  }

  const withinBatch = state.allowMultiBuy && now() <= _buyBatchUntil;
  if (state.lastTradeTs && (now() - state.lastTradeTs)/1000 < state.minSecsBetween && !withinBatch && !ignoreCooldownForLeaderBuy) return;


  if (!tryAcquireBuyLock(BUY_LOCK_MS)) {
    log("Buy lock held; skipping buys this tick.");
    return;
  }


  try {
    const kp = await getAutoKeypair();
    if (!kp) return;

    await syncPositionsFromChain(kp.publicKey.toBase58());

    const cur = state.positions[picks[0]];
    const alreadyHoldingLeader = Number(cur?.sizeUi || 0) > 0 || Number(cur?.costSol || 0) > 0;
    if (leaderMode && alreadyHoldingLeader) {
      log("Holding current leader. No additional buys.");
      return;
    }

    const solBal = await fetchSolBalance(kp.publicKey.toBase58());
    const ceiling = await computeSpendCeiling(kp.publicKey.toBase58(), { solBalHint: solBal });

    const desired      = Math.min(state.maxBuySol, Math.max(state.minBuySol, solBal * state.buyPct));
    const minThreshold = Math.max(state.minBuySol, MIN_SELL_SOL_OUT);
    let plannedTotal   = Math.min(ceiling.spendableSol, Math.min(state.maxBuySol, state.carrySol + desired));

    logObj("Buy sizing (pre-split)", {
      solBal: Number(solBal).toFixed(6),
      spendable: Number(ceiling.spendableSol).toFixed(6),
      posCount: ceiling.reserves.posCount,
      reservesSol: (ceiling.reserves.totalResLamports/1e9).toFixed(6),
      minThreshold
    });


    const buyCandidates = picks.filter(m => {
      const pos = state.positions[m];
      const allowRebuy = !!pos?.allowRebuy;
      const eligibleSize = allowRebuy || Number(pos?.sizeUi || 0) <= 0;
      const notPending = !pos?.awaitingSizeSync;
      const notLocked  = !isMintLocked(m);
      return eligibleSize && notPending && notLocked;
    });


    if (!buyCandidates.length) { log("All picks already held or pending. Skipping buys."); return; }

    if (plannedTotal < minThreshold) {
      state.carrySol += desired;
      save();
      log(`Accumulating. Carry=${state.carrySol.toFixed(6)} SOL (< ${minThreshold} min or spend ceiling).`);
      return;
    }

    _buyInFlight = true;

    let remainingLamports = Math.floor(ceiling.spendableSol * 1e9);
    let remaining = remainingLamports / 1e9;
    let spent = 0;
    let buysDone = 0;

    let loopN = leaderMode ? 1 : buyCandidates.length;
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
      if (state.allowMultiBuy && mint !== picks[0]) {
        try {
          const obs = await observeMintOnce(mint, { windowMs: 2500, sampleMs: 700, minPasses: 4, adjustHold: !!state.dynamicHoldEnabled });
          if (!obs.ok) {
            if (Number(obs.passes || 0) === 3) noteObserverConsider(mint, 30_000);
            log(`Observer gate: ${mint.slice(0,4)}… scored ${obs.passes||0}/5 (<4). Skipping buy.`);
            continue;
          }
        } catch {
          log(`Observer gate failed for ${mint.slice(0,4)}… Skipping buy.`);
          continue;
        }
      }
      const left = Math.max(1, loopN - i);
      const target = Math.max(minThreshold, remaining / left);

      const reqRent = await requiredAtaLamportsForSwap(kp.publicKey.toBase58(), SOL_MINT, mint);
      const candidateBudgetLamports = Math.max(0, remainingLamports - reqRent - TX_FEE_BUFFER_LAMPORTS);
      const targetLamports = Math.floor(target * 1e9);
      let buyLamports = Math.min(targetLamports, Math.floor(remaining * 1e9), candidateBudgetLamports);

      const minInLamports = Math.floor(MIN_JUP_SOL_IN * 1e9);
      const minPerOrderLamports = Math.max(minInLamports, Math.floor(minThreshold * 1e9));

      if (buyLamports < minPerOrderLamports) {
        // Not enough to place a router-safe and later sellable order; skip to avoid dust.
        const need = (minPerOrderLamports - buyLamports) / 1e9;
        if (reqRent > 0) {
          log(`Skip ${mint.slice(0,4)}… (order ${ (buyLamports/1e9).toFixed(6) } SOL < min ${ (minPerOrderLamports/1e9).toFixed(6) } incl. ATA). Need ~${need.toFixed(6)} SOL more.`);
        } else {
          log(`Skip ${mint.slice(0,4)}… (order ${ (buyLamports/1e9).toFixed(6) } SOL < min ${ (minPerOrderLamports/1e9).toFixed(6) }).`);
        }
        continue;
      }

      const buySol = buyLamports / 1e9;

      const ownerStr = kp.publicKey.toBase58();
      const prevPos  = state.positions[mint];
      const basePos  = prevPos || { costSol: 0, hwmSol: 0, acquiredAt: now() };

      const res = await executeSwapWithConfirm({
        signer: kp,
        inputMint: SOL_MINT,
        outputMint: mint,
        amountUi: buySol,
        slippageBps: state.slippageBps,
      }, { retries: 2, confirmMs: 15000 });

      if (!res.ok) {
        try {
          const seed = getBuySeed(ownerStr, mint);
          if (seed && Number(seed.sizeUi || 0) > 0) {
            optimisticSeedBuy(ownerStr, mint, Number(seed.sizeUi), Number(seed.decimals), buySol, res.sig || "");
            clearBuySeed(ownerStr, mint);
            log(`Buy unconfirmed for ${mint.slice(0,4)}… seeded pending credit watch.`);
          } else {
            log(`Buy not confirmed for ${mint.slice(0,4)}… skipping accounting.`);
          }
        } catch {
          log(`Buy not confirmed for ${mint.slice(0,4)}… skipping accounting.`);
        }
        continue;
      }
      try {
        const seed = getBuySeed(ownerStr, mint);
        if (seed && Number(seed.sizeUi || 0) > 0) {
          optimisticSeedBuy(ownerStr, mint, Number(seed.sizeUi), Number(seed.decimals), buySol, res.sig || "");
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

      if (Number(got.sizeUi || 0) > 0) {
        const pos = {
          ...basePos,
          sizeUi: got.sizeUi,
          decimals: got.decimals,
          costSol: Number(basePos.costSol || 0) + buySol,
          hwmSol: Math.max(Number(basePos.hwmSol || 0), buySol),
          lastBuyAt: now(),
          lastSeenAt: now(),
          awaitingSizeSync: false,
          allowRebuy: false,
          lastSplitSellAt: undefined,
        };
        state.positions[mint] = pos;
        updatePosCache(kp.publicKey.toBase58(), mint, pos.sizeUi, pos.decimals);
        save();
        log(`Bought ~${buySol.toFixed(4)} SOL -> ${mint.slice(0,4)}…`);
        clearObserverConsider(mint);
        await logMoneyMade();
      } else {
        log(`Buy confirmed for ${mint.slice(0,4)}… but no token credit yet; will sync later.`);
        const pos = {
          ...basePos,
          costSol: Number(basePos.costSol || 0) + buySol,
          hwmSol: Math.max(Number(basePos.hwmSol || 0), buySol),
          lastBuyAt: now(),
          awaitingSizeSync: true,
          allowRebuy: false,
          lastSplitSellAt: undefined,
        };
        state.positions[mint] = pos;
        save();
        enqueuePendingCredit({
          owner: kp.publicKey.toBase58(),
          mint,
          addCostSol: buySol,
          decimalsHint: basePos.decimals,
          basePos: pos,
          sig: res.sig
        });
        try { await processPendingCredits(); } catch {}
        await logMoneyMade();
      }

      spent += buySol;
      buysDone++;
      _buyBatchUntil = now() + (state.multiBuyBatchMs|0);

      if (leaderMode) break;

      await new Promise(r => setTimeout(r, 150));
      if (remaining < minThreshold) break;
    }

    state.carrySol = Math.max(0, state.carrySol + desired - spent);
    if (buysDone > 0) {
      state.lastTradeTs = now();
      save();
    }
  } catch (e) {
    log(`Buy failed: ${e.message||e}`);
  } finally {
    _buyInFlight = false;
    releaseBuyLock();
  }
}

async function startAutoAsync() {
  if (_starting) return;
  _starting = true;
  try {

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
      startBtn.disabled = false;
      stopBtn.disabled = true;
      save();
      return;
    }

    log("Join us on telegram: https://t.me/fdvlolgroup for community discussions!"); 

    const kp = await getAutoKeypair();
    if (kp) await syncPositionsFromChain(kp.publicKey.toBase58());
    await sweepNonSolToSolAtStart();
    if (state.dustExitEnabled) {
      try { await sweepDustToSolAtStart(); } catch {}
    }
    if (!timer && state.enabled) {
      timer = setInterval(tick, 3000);
      log("Auto trading started");
    }
    startFastObserver();
  } finally {
    _starting = false;
  }
}

function onToggle(on) {
   state.enabled = !!on;
   if (toggleEl) toggleEl.value = state.enabled ? "yes" : "no";
   startBtn.disabled = state.enabled;
   stopBtn.disabled = !state.enabled;
   if (state.enabled && !currentRpcUrl()) {
     log("Configure a CORS-enabled Solana RPC URL before starting.");
     state.enabled = false;
     if (toggleEl) toggleEl.value = "no";
     startBtn.disabled = false;
     stopBtn.disabled = true;
     save();
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
     log("Auto trading stopped");
   }
   save();
}

function load() {
  try { state = { ...state, ...(JSON.parse(localStorage.getItem(LS_KEY))||{}) }; } catch {}
  state.slippageBps = Math.max(150, Number(state.slippageBps || 150) | 0);
  state.minBuySol   = Math.max(MIN_JUP_SOL_IN, Number(state.minBuySol || MIN_JUP_SOL_IN));
  save();
}

function save() {
  try { localStorage.setItem(LS_KEY, JSON.stringify(state)); } catch {}
}

function copyLog() {
  if (!logEl) return false;
  try {
    const lines = Array.from(logEl.children)
      .filter(n => n && n.tagName === "DIV")
      .map(n => n.textContent || "");
    const text = lines.join("\n");
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

export function initAutoWidget(container = document.body) {
  load();

  if (!state.positions || typeof state.positions !== "object") state.positions = {};

  const wrap = document.createElement("details");
  wrap.className = "fdv-auto-wrap";

  wrap.open = !state.collapsed;

  const summary = document.createElement("summary");
  summary.innerHTML = `
    <span class="fdv-acc-title">
      <svg class="fdv-acc-caret" width="16" height="16" viewBox="0 0 24 24" aria-hidden="true">
        <path d="M8 10l4 4 4-4" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"></path>
      </svg>
      <span class="fdv-title">Auto Pump (v0.0.2.7)</span>
    </span>
  `;

  const body = document.createElement("div");
  body.className = "fdv-auto-body";
  body.innerHTML = `
    <div class="fdv-auto-head">
    </div>
    <div style="display:flex;align-items:center;gap:8px;border-bottom:1px solid var(--fdv-border);padding-bottom:8px;margin-bottom:8px; position:relative;">
      <button class="btn" data-auto-gen>Generate</button>
      <button class="btn" data-auto-copy>Address</button>
      <button class="btn" data-auto-unwind>Return</button>
      <button class="btn" data-auto-wallet>Wallet</button>
      <div data-auto-wallet-menu
           style="display:none; position:absolute; top:38px; left:0; z-index:999; min-width:520px; max-width:92vw;
                  background:var(--fdv-bg,#111); color:var(--fdv-fg,#fff); border:1px solid var(--fdv-border,#333);
                  border-radius:10px; box-shadow:0 10px 30px rgba(0,0,0,.5); padding:10px;">
        <div style="display:flex; align-items:center; justify-content:space-between; gap:8px; margin-bottom:8px;">
          <strong>Wallet Holdings</strong>
          <button data-auto-dump style="background:#7f1d1d;color:#fff;border:1px solid #a11;padding:6px 10px;border-radius:6px;">Dump Wallet</button>
        </div>
        <div data-auto-wallet-sol style="font-size:12px; opacity:0.9; margin-bottom:6px;">SOL: …</div>
        <div data-auto-wallet-list style="display:flex; flex-direction:column; gap:6px; max-height:40vh; overflow:auto;">
          <div style="opacity:0.7;">Loading…</div>
        </div>
        <div data-auto-wallet-totals style="display: flex;flex-direction: row;justify-content: space-between;margin-top:8px; font-weight:600;">Total: …</div>
      </div>
    </div>
    <div class="fdv-grid">
      <label><a href="https://chainstack.com/" target="_blank">RPC (CORS)</a> <input data-auto-rpc placeholder="https://your-provider.example/solana?api-key=..."/></label>
      <label>RPC Headers (JSON) <input data-auto-rpch placeholder='{"Authorization":"Bearer ..."}'/></label>
      <label>Auto Wallet <input data-auto-dep readonly placeholder="Generate to get address"/></label>
      <label>Deposit Balance <input data-auto-bal readonly/></label>
      <label>Recipient (SOL) <input data-auto-recv placeholder="Your wallet address"/></label>
      <label>Lifetime (mins) <input data-auto-life type="number" step="1" min="${UI_LIMITS.LIFE_MINS_MIN}" max="${UI_LIMITS.LIFE_MINS_MAX}"/></label>
      <label>Buy % of SOL <input data-auto-buyp type="number" step="0.1" min="${UI_LIMITS.BUY_PCT_MIN*100}" max="${UI_LIMITS.BUY_PCT_MAX*100}"/></label>
      <label>Min Buy (SOL) <input data-auto-minbuy type="number" step="0.0001" min="${UI_LIMITS.MIN_BUY_SOL_MIN}" max="${UI_LIMITS.MIN_BUY_SOL_MAX}"/></label>
      <label>Max Buy (SOL) <input data-auto-maxbuy type="number" step="0.0001" min="${UI_LIMITS.MAX_BUY_SOL_MIN}" max="${UI_LIMITS.MAX_BUY_SOL_MAX}"/></label>
      <label>Hold Leader
        <select data-auto-hold>
          <option value="no">No</option>
          <option value="yes">Yes</option>
        </select>
      </label>
      <label>Try to sell dust
        <select data-auto-dust>
          <option value="no" selected>No</option>
          <option value="yes">Yes</option>
        </select>
      </label>
      <label>Enabled
        <select data-auto-toggle disabled>
          <option value="no">No</option>
          <option value="yes">Yes</option>
        </select>
      </label>
    </div>
    <div class="fdv-hold-time-slider"></div>
    <div class="fdv-log" data-auto-log style="position:relative;">
    </div>
    <div class="fdv-actions">
    <div class="fdv-actions-left">
        <button class="btn" data-auto-help title="How the bot works">Help</button>
        <button class="btn" data-auto-log-copy title="Copy log">Log</button>
        <div class="fdv-modal" data-auto-modal
             style="display:none; position:fixed; width: 100%; inset:0; z-index:9999; background:rgba(0, 0, 0, 1); align-items:center; justify-content:center;">
          <div class="fdv-modal-card"
               style="background:var(--fdv-bg,#111); color:var(--fdv-fg,#fff); width:92%; max-width:720px; max-height:80vh; overflow:auto; border-radius:12px; box-shadow:0 10px 30px rgba(0,0,0,.5); padding:16px 20px;">
            <div style="display:flex; align-items:center; justify-content:space-between; gap:12px; margin-bottom:6px;">
              <h3 style="margin:0; font-size:16px;">Auto Pump Bot</h3>
            </div>
            <div class="fdv-tabs" data-auto-tabs style="display:flex; gap:8px; margin:6px 0 10px;">
              <button data-auto-tab="guide" class="active" style="padding:4px 8px;border:1px solid var(--fdv-border,#333);border-radius:6px;background:#222;color:#fff;">Guide</button>
              <button data-auto-tab="release" style="padding:4px 8px;border:1px solid var(--fdv-border,#333);border-radius:6px;background:#111;color:#aaa;">Release</button>
            </div>
            <div class="fdv-modal-body-tooltip" style="font-size:13px; line-height:1.5; gap:10px;">
             <div data-auto-tab-panel="guide">
               <div>
                 <strong>What it does</strong>
                 <ul style="margin:6px 0 0 18px;">
                   <li>Tracks Pumping Radar leaders and buys the top token.</li>
                   <li>With “Leader” on, buys once and holds until the leader changes.</li>
                   <li>On leader change, rotates non-leader tokens back to SOL, then buys the new leader next tick.</li>
                   <li>Seeds local cache immediately after each buy; background token sync reconciles on-chain credits.</li>
                   <li>Wallet > Holdings splits coins into Sellable vs Dust/Unsellable by Jupiter min-notional.</li>
                   <li>Applies router cooldown after route/dust errors to avoid repeated failures.</li>
                 </ul>
               </div>
               <div>
                 <strong>Quick start</strong>
                 <ol style="margin:6px 0 0 18px;">
                   <li>Set a CORS-enabled RPC URL (and headers if required).</li>
                   <li>Generate the auto wallet and fund it with SOL. Recommended minimum: <strong>$7</strong>.</li>
                   <li>Set a Recipient to receive funds on End & Return.</li>
                   <li>Tune Buy %, Min/Max Buy, Slippage.</li>
                   <li>Click Start. Bot ticks every 5s and respects cooldowns.</li>
                   <li>If you hit issues, reach out on Telegram: <a href="https://t.me/fdvlolgroup" target="_blank">fdvlolgroup</a>.</li>
                 </ol>
               </div>
               <div>
                 <strong>Guidelines</strong>
                 <ul style="margin:6px 0 0 18px;">
                   <li>Keep at least <strong>$7</strong> in SOL to cover router minimums, ATA rent, and fees.</li>
                   <li>Dust protection: very small orders are skipped; sells below min-notional are blocked unless dust-exit is enabled.</li>
                   <li>Use a CORS-enabled RPC; some plans may block owner scans (the bot adapts).</li>
                 </ul>
               </div>
              <div>
                <strong>Usage tips</strong>
                <ul style="margin:6px 0 0 18px;">
                  <li>If you see router cooldown logs, let it clear; retries auto-increase slippage within limits.</li>
                  <li>Set “Hold Leader” to reduce churn; the bot rotates non-leaders for you.</li>
                  <li>Enable “Try to sell dust” to exit small bags when they cross min-notional.</li>
                  <li>Under heavy API load, increase Min Quote Interval to reduce rate limits.</li>
                  <li>Use a fast CORS RPC and add auth headers if needed; verify with RPC preflight.</li>
                  <li>Export wallet.json periodically; use it to manually recover dust if needed.</li>
                  <li>Adjust slippage if swaps fail often; start at 150–300 bps, cap near 2000 bps.</li>
                  <li>Keep a small SOL runway for fees and ATAs; bot reserves are automatic.</li>
                </ul>
              </div>
               <div>
                 <strong>Sizing & reserves</strong>
                 <ul style="margin:6px 0 0 18px;">
                   <li>Buy size = min(affordable, carry + desired). A small fee reserve is kept.</li>
                   <li>If size is below router min, it carries over until large enough.</li>
                   <li>Router minimums enforced to avoid 400/dust errors (min buy and min sell notional enforced).</li>
                 </ul>
               </div>
               <div>
                 <strong>Safety</strong>
                 <ul style="margin:6px 0 0 18px;">
                   <li>Optional TP/SL selling is paused when “Leader” hold is on.</li>
                   <li>Owner scans may be disabled by your RPC plan; the bot adapts.</li>
                   <li>On dust/route errors, a per-mint router cooldown is applied automatically.</li>
                 </ul>
               </div>
               <div>
                 <strong>Unwind</strong>
                 <ul style="margin:6px 0 0 18px;">
                   <li>“End & Return” sells tokens to SOL and sends SOL to Recipient (minus rent/fees).</li>
                 </ul>
               </div>
               <div>
                 <strong>Disclaimer</strong>
                 <p style="margin:6px 0 0 0;">
                   This bot is provided "as is" without warranties of any kind. Trading cryptocurrencies involves significant risk,
                   including the potential loss of your investment. Past performance is not indicative of future results.
                   Always do your own research and consider your risk tolerance before using this bot.
                 </p>
                 <p><strong>By using this bot, you acknowledge and accept these risks.</strong></p>
               </div>
               <div>
                 <strong>Support & updates</strong>
                 <p style="margin:6px 0 0 0;">
                   Issues or questions? Telegram: <a href="https://t.me/fdvlolgroup" target="_blank">fdvlolgroup</a>
                 </p>
                 <ul style="margin:6px 0 0 18px;">
                   <li>twitter: <code><a href="https://twitter.com/fdvlol" target="_blank">@fdvlol</a></code></li>
                   <li>telegram: <code><a href="https://t.me/fdvlolgroup" target="_blank">fdvlolgroup</a></code></li>
                 </ul>
               </div>
             </div>
             <div data-auto-tab-panel="release" style="display:none;">
               <div>
                 <strong>Release v0.0.2.6: Highlights</strong>
                 <ul style="margin:6px 0 0 18px;">
                   <li>Observer system refinements: 3/5 soft-watch debounce, forced sells with hysteresis, dynamic hold tuning.</li>
                   <li>Leader mode rotation polished: full/partial rotation with remainder reconciliation and router cooldowns.</li>
                   <li>Optimistic buy seeding now accumulates multiple seeds; pending-credit reconciliation is more robust.</li>
                   <li>Wallet Holdings panel shows Sellable vs Dust with live SOL and USD totals; quick export button.</li>
                   <li>Stress-aware Jupiter client: inflight GET dedupe + safe Response clones; quote memoization with jittered pacing.</li>
                   <li>Split-sell fallback upgrades: accurate proportional cost/hwm, cache updates, and dust promotion/cleanup.</li>
                   <li>WSOL unwrap hardening: tolerant owner/ATA normalization and gated only for SOL-involved swaps.</li>
                   <li>Per-mint router cooldowns applied consistently after route/dust errors and partial remainders.</li>
                   <li>Startup sweeps for positions and dust with on-chain verification and safe cache pruning.</li>
                   <li>Compute/spend ceiling improvements: fee/rent/runway buffers and multi-buy single-tick gating.</li>
                 </ul>
                 <div style="margin-top:10px;">
                   <strong>Fixes & stability</strong>
                   <ul style="margin:6px 0 0 18px;">
                     <li>Eliminated duplicate buy sends: no retries after first buy submit; rely on pending-credit watcher.</li>
                     <li>Fixed “body stream already read” by returning cloned Responses from inflight GET cache.</li>
                     <li>Clears pending-credit watchers on full sells, rotations, dust sweeps, and remainders.</li>
                     <li>Preflight balance checks for buys include ATA rent and fee buffers to prevent lamport shortfalls.</li>
                     <li>Min-notional enforcement for sells and dust exits; safe classification to dust cache when needed.</li>
                     <li>Improved public key handling and validation to avoid “Invalid public key input” noise.</li>
                     <li>Safer owner scans with adaptive fallbacks and cache verification for restricted RPC plans.</li>
                   </ul>
                 </div>
               </div>
             </div>
            </div>
            <div style="display:flex; justify-content:space-between; gap:8px; margin-top:22px; flex-wrap:wrap;">
              <div style="display:flex; gap:8px; flex-wrap:wrap;">
                <button data-auto-sec-export>Export Wallet.json</button>
              </div>
              <button data-auto-modal-close>Close</button>
            </div>
          </div>
        </div>
    </div>
    <div class="fdv-actions-right">
      <button data-auto-start>Start</button>
      <button data-auto-stop>Stop</button>
      <button class="btn" data-auto-reset>Refresh</button>
    </div>
    </div>
  `;

  wrap.appendChild(summary);
  wrap.appendChild(body);
  container.appendChild(wrap);

  try {
    const hasAutomate =
      typeof location !== "undefined" &&
      (String(location.hash || "").toLowerCase().includes("automate") ||
      String(location.search || "").toLowerCase().includes("automate"));
    if (hasAutomate) {
      wrap.open = true;
      state.collapsed = false;
      save();
      const openPumpKpi = () => {
        let opened = false;
        const pumpBtn = document.getElementById("pumpingToggle") || document.querySelector('button[title="PUMP"]');
        if (pumpBtn) {
          const isExpanded = String(pumpBtn.getAttribute("aria-expanded") || "false") === "true";
          if (!isExpanded) {
            try { pumpBtn.click(); opened = true; } catch {}
          } else {
            opened = true;
          }
          const panelId = pumpBtn.getAttribute("aria-controls") || "pumpingPanel";
          const panel = document.getElementById(panelId) || document.querySelector("#pumpingPanel");
          if (panel) {
            panel.removeAttribute("hidden");
            panel.style.display = "";
            panel.classList.add("open");
          }
        }
        return opened;
      };
      openPumpKpi();
      setTimeout(openPumpKpi, 0);
      setTimeout(openPumpKpi, 250);
     }
  } catch {}

  wrap.addEventListener("toggle", () => {
    state.collapsed = !wrap.open;
    save(); // persist?
  });

  logEl     = wrap.querySelector("[data-auto-log]");
  toggleEl  = wrap.querySelector("[data-auto-toggle]");
  const holdEl  = wrap.querySelector("[data-auto-hold]");
  const dustEl  = wrap.querySelector("[data-auto-dust]");
  const helpBtn = wrap.querySelector("[data-auto-help]");
  const modalEl = wrap.querySelector("[data-auto-modal]");
  const modalCloseEls = wrap.querySelectorAll("[data-auto-modal-close]");
  const tabBtns = modalEl.querySelectorAll("[data-auto-tab]");
  const tabPanels = modalEl.querySelectorAll("[data-auto-tab-panel]");
  function activateTab(name) {
    tabBtns.forEach(b => {
      const on = b.getAttribute("data-auto-tab") === name;
      b.classList.toggle("active", on);
      b.style.background = on ? "#222" : "#111";
      b.style.color = on ? "#fff" : "#aaa";
    });
    tabPanels.forEach(p => {
      p.style.display = (p.getAttribute("data-auto-tab-panel") === name) ? "block" : "none";
    });
  }
  tabBtns.forEach(b => b.addEventListener("click", (e) => {
    e.preventDefault();
    const name = b.getAttribute("data-auto-tab");
    activateTab(name);
  }));
  activateTab("guide");
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

  const secExportBtn = wrap.querySelector("[data-auto-sec-export]");
  const rpcEl = wrap.querySelector("[data-auto-rpc]");
  const rpchEl = wrap.querySelector("[data-auto-rpch]");
  const copyLogBtn = wrap.querySelector("[data-auto-log-copy]");

  const walletBtn      = wrap.querySelector("[data-auto-wallet]");
  const walletMenuEl   = wrap.querySelector("[data-auto-wallet-menu]");
  const walletListEl   = wrap.querySelector("[data-auto-wallet-list]");
  const walletTotalsEl = wrap.querySelector("[data-auto-wallet-totals]");
  const walletSolEl    = wrap.querySelector("[data-auto-wallet-sol]");
  const dumpBtn        = wrap.querySelector("[data-auto-dump]");

  rpcEl.value   = currentRpcUrl();
  try { rpchEl.value = JSON.stringify(currentRpcHeaders() || {}); } catch { rpchEl.value = "{}"; }
  depAddrEl.value = state.autoWalletPub || "";
  recvEl.value    = state.recipientPub || "";
  lifeEl.value    = state.lifetimeMins;
  buyPctEl.value  = (state.buyPct * 100).toFixed(2);
  minBuyEl.value  = state.minBuySol;
  maxBuyEl.value  = state.maxBuySol;

  helpBtn.addEventListener("click", () => { modalEl.style.display = "flex"; });
  modalEl.addEventListener("click", (e) => { if (e.target === modalEl) modalEl.style.display = "none"; });
  modalCloseEls.forEach(btn => btn.addEventListener("click", () => { modalEl.style.display = "none"; }));
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && modalEl.style.display !== "none") modalEl.style.display = "none";
  });

  if (copyLogBtn) {
    copyLogBtn.addEventListener("click", (e) => { e.preventDefault(); e.stopPropagation(); copyLog(); });
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
      const dustEntries   = dustCacheToList(owner); // dust cache
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
      // Dust cache entries (always dust)
      // Avoid dupes: if a mint is still in positions (shouldn't), prefer dust classification
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
    walletMenuEl.style.display = "none";
  }
  walletBtn.addEventListener("click", async (e) => {
    e.preventDefault(); e.stopPropagation();
    walletOpen = !walletOpen;
    if (walletOpen) {
      await renderWalletMenu();
      walletMenuEl.style.display = "block";
    } else {
      closeWalletMenu();
    }
  });

  document.addEventListener("click", (e) => {
    if (!walletOpen) return;
    const t = e.target;
    if (t === walletBtn || walletMenuEl.contains(t)) return;
    closeWalletMenu();
  });

  dumpBtn.addEventListener("click", async (e) => {
    e.preventDefault(); e.stopPropagation();
    if (!state.recipientPub) {
      log("Set Recipient before dumping wallet.");
      return;
    }
    try {
      await sweepAllToSolAndReturn();
      closeWalletMenu();
    } catch (err) {
      log(`Dump failed: ${err.message || err}`);
    }
  });

  const holdTimeWrap = wrap.querySelector(".fdv-hold-time-slider");
  if (holdTimeWrap) {
    const MIN_HOLD = 30, MAX_HOLD = 120;
    let cur = Number(state.maxHoldSecs || 50);
    cur = Math.min(MAX_HOLD, Math.max(MIN_HOLD, cur));
    if (cur !== state.maxHoldSecs) { state.maxHoldSecs = cur; save(); }

    holdTimeWrap.innerHTML = `
      <div style="display:flex; align-items:center; gap:10px; padding:6px 0;">
        <label style="width:110px;">Hold</label>
        <input type="range" data-auto-holdtime min="${MIN_HOLD}" max="${MAX_HOLD}" step="1" value="${cur}" style="width: 100%;" />
        <div data-auto-holdtime-val style="width:56px; text-align:right;">${cur}s</div>
        <label style="display:flex; align-items:center; gap:6px; margin-left:8px; white-space:nowrap;">
          <input type="checkbox" data-auto-dynhold />
          <span style="opacity:.9;">∞</span>
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
    dynEl.addEventListener("change", () => {
      state.dynamicHoldEnabled = dynEl.checked;
      save();
      log(`Dynamic hold: ${state.dynamicHoldEnabled ? "ON" : "OFF"}`);
    });
  }

  secExportBtn.addEventListener("click", () => {
    const payload = JSON.stringify({
      publicKey: state.autoWalletPub || "",
      secretKey: state.autoWalletSecret || ""
    }, null, 2);
    downloadTextFile(`fdv-auto-wallet-${(state.autoWalletPub||"").slice(0,6)}.json`, payload);
    log("Exported wallet JSON");
  });

  rpcEl.addEventListener("change", () => {
    setRpcUrl(rpcEl.value);
    if (currentRpcUrl()) log("RPC URL saved.");
    else log("RPC URL cleared. Auto Trader requires a CORS-enabled RPC.");
  });
  rpchEl.addEventListener("change", () => setRpcHeaders(rpchEl.value));

  wrap.querySelector("[data-auto-gen]").addEventListener("click", async () => {
    await ensureAutoWallet();
    depAddrEl.value = state.autoWalletPub;
    log("New auto wallet generated. Send SOL to begin: " + state.autoWalletPub);
    save();
  });
  wrap.querySelector("[data-auto-copy]").addEventListener("click", async () => {
    if (!state.autoWalletPub) await ensureAutoWallet();
    navigator.clipboard.writeText(state.autoWalletPub).catch(()=>{});
    log("Address copied");
  });
  wrap.querySelector("[data-auto-unwind]").addEventListener("click", async () => {
    try { 
      await sweepAllToSolAndReturn();
      save();
    } catch(e){ log(`Unwind failed: ${e.message||e}`); }
  });

  toggleEl.addEventListener("change", () => onToggle(toggleEl.value === "yes"));
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
  startBtn.addEventListener("click", () => onToggle(true));
  stopBtn.addEventListener("click", () => onToggle(false));
  wrap.querySelector("[data-auto-reset]").addEventListener("click", () => {
    let feeBps = getPlatformFeeBps();
    log(`Estimated fee bps: ~${feeBps}bps`);
    state.holdingsUi = 0;
    state.avgEntryUsd = 0;
    state.lastTradeTs = 0;
    state.endAt = 0;
    fetchSolBalance(state.autoWalletPub).then(b => { depBalEl.value = `${b.toFixed(4)} SOL`; }).catch(()=>{});
    save();
    log("Session stats refreshed");
  });

  const saveField = () => {
    const life = clamp(parseInt(lifeEl.value || "0", 10), UI_LIMITS.LIFE_MINS_MIN, UI_LIMITS.LIFE_MINS_MAX);
    state.lifetimeMins = life;
    lifeEl.value = String(life);

    const rawPct = normalizePercent(buyPctEl.value);
    const pct = clamp(rawPct, UI_LIMITS.BUY_PCT_MIN, UI_LIMITS.BUY_PCT_MAX);
    state.buyPct = pct;
    buyPctEl.value = (pct * 100).toFixed(2);

    let minBuy = clamp(Number(minBuyEl.value || 0), UI_LIMITS.MIN_BUY_SOL_MIN, UI_LIMITS.MIN_BUY_SOL_MAX);
    let maxBuy = clamp(Number(maxBuyEl.value || 0), UI_LIMITS.MAX_BUY_SOL_MIN, UI_LIMITS.MAX_BUY_SOL_MAX);

    if (maxBuy < minBuy) maxBuy = minBuy;

    state.minBuySol = minBuy;
    state.maxBuySol = maxBuy;

    minBuyEl.value = String(minBuy);
    maxBuyEl.min = String(minBuy);
    maxBuyEl.value = String(maxBuy);

    save();
  };
  [recvEl, lifeEl, buyPctEl, minBuyEl, maxBuyEl].forEach(el => {
    el.addEventListener("input", saveField);
    el.addEventListener("change", saveField);
  });

  toggleEl.value = state.enabled ? "yes" : "no";
  holdEl.value = state.holdUntilLeaderSwitch ? "yes" : "no";
  dustEl.value = state.dustExitEnabled ? "yes" : "no";
  startBtn.disabled = !!state.enabled;
  stopBtn.disabled = !state.enabled;
  if (state.enabled && !timer) timer = setInterval(tick, 5000);

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