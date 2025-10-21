import { FDV_FEE_RECEIVER } from "../../config/env.js";
import { computePumpingLeaders } from "../meme/addons/pumping.js";

// Dust orders and minimums are blocked due to Jupiter route failures and 400 errors.

const SOL_MINT = "So11111111111111111111111111111111111111112";
// Minimum SOL-in to avoid Jupiter 400s on tiny swaps 
const MIN_JUP_SOL_IN = 0.0005;
// Minimum SOL-out on sells to avoid dust/route failures
const MIN_SELL_SOL_OUT = 0.002;

// Dynamic fee reserve for small balances
const FEE_RESERVE_MIN = 0.0002;   // rent
const FEE_RESERVE_PCT = 0.10;     // or 10% of balance

const TX_FEE_BUFFER_LAMPORTS = 250_000

const SELL_TX_FEE_BUFFER_LAMPORTS = 400_000; 
const EXTRA_TX_BUFFER_LAMPORTS     = 150_000;  
const MIN_OPERATING_SOL            = 0.005;    
const ROUTER_COOLDOWN_MS           = 60_000;


const FEE_ATAS = {
  [SOL_MINT]: "4FSwzXe544mW2BLYqAAjcyBmFFHYgMbnA1XUdtGUeST8", 
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
  allowMultiBuy: true,  
  multiBuyTopN: 1,  
  multiBuyBatchMs: 6000,
  dustExitEnabled: true,
  dustMinSolOut: 0.004,

  // Safeties
  seedBuyCache: true,

  // Cache
  pendingGraceMs: 60000,

  // collapse state for <details>
  collapsed: true,
  // hold until new leader detected
  holdUntilLeaderSwitch: false,
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

function _pcKey(owner, mint) { return `${owner}:${mint}`; }

function enqueuePendingCredit({ owner, mint, addCostSol = 0, decimalsHint = 6, basePos = {} }) {
  if (!owner || !mint) return;
  const nowTs = now();
  const until = nowTs + Math.max(5000, Number(state.pendingGraceMs || 20000));
  const key = _pcKey(owner, mint);
  const prev = _pendingCredits.get(key);
  const add = Number(addCostSol || 0);
  _pendingCredits.set(key, {
    owner, mint,
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
    if (!entry || nowTs > entry.until) {
      _pendingCredits.delete(key);
      continue;
    }
    if (entry.lastTriedAt && (nowTs - entry.lastTriedAt) < 300) continue;
    try {
      entry.lastTriedAt = nowTs;
      const bal = await getAtaBalanceUi(entry.owner, entry.mint, entry.decimalsHint);
      let sizeUi = Number(bal.sizeUi || 0);
      let dec = Number.isFinite(bal.decimals) ? bal.decimals : (entry.decimalsHint ?? 6);

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

const POSCACHE_KEY_PREFIX = "fdv_poscache_v1:";

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

async function getFeeReceiver() {
  const cfg = await getCfg();
  const fromEnv = String(FDV_FEE_RECEIVER || "").trim();
  if (fromEnv) return fromEnv;
  const fromCfg =
    String(
      cfg.platformFeeReceiver ||
      cfg.feeReceiver ||
      cfg.FDV_FEE_RECEIVER ||
      ""
    ).trim();
  return fromCfg;
}
 
function getPlatformFeeBps() {
  return 5; // 0.05%
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

async function confirmSig(sig, { commitment = "confirmed", timeoutMs = 12000, pollMs = 300 } = {}) {
  const conn = await getConn();
  const start = now();
  while (now() - start < timeoutMs) {
    try {
      const st = await conn.getSignatureStatuses([sig]);
      const v = st?.value?.[0];
      if (v?.confirmationStatus === "confirmed" || v?.confirmationStatus === "finalized") return true;
    } catch {}
    await new Promise(r => setTimeout(r, pollMs));
  }
  return false;
}

async function waitForTokenCredit(ownerPubkeyStr, mintStr, { timeoutMs = 8000, pollMs = 300 } = {}) {
  const conn = await getConn();
  const start = now();

  let decimals = 6;
  try { decimals = await getMintDecimals(mintStr); } catch {}

  let atas = [];
  try { atas = await getOwnerAtas(ownerPubkeyStr, mintStr); } catch {}
  // If no ATAs yet, we'll still loop and fall back to owner scan
  while (now() - start < timeoutMs) {
    // Check known ATAs first
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

let _conn = null, _connUrl = "";
let _connHdrKey = "";
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

let _solPxCache = { ts: 0, usd: 0 };
async function getSolUsd() {
  const t = Date.now();
  if (_solPxCache.usd > 0 && (t - _solPxCache.ts) < 60_000) return _solPxCache.usd;
  try {
    const res = await fetch("https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd", { headers: { accept: "application/json" }});
    const j = await res.json();
    const px = Number(j?.solana?.usd || 0);
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
  const minGapMs = isQuote ? 250 : 120; // be gentler on /quote jupiter is sensitive. go smooth. ease your way in.
  if (!window._fdvJupLastCall) window._fdvJupLastCall = 0;
  const waitMs = Math.max(0, window._fdvJupLastCall + minGapMs - nowTs) + (isQuote ? Math.floor(Math.random()*80) : 0);
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
            const backoff = 300 * Math.pow(2, attempt) + Math.floor(Math.random()*120);
            log(`JUP 400(rate-limit): backing off ${backoff}ms`);
            await new Promise(r => setTimeout(r, backoff));
            continue;
          }
        }
        return res;
      }
      // 429 backoff
      const backoff = 350 * Math.pow(2, attempt) + Math.floor(Math.random()*150);
      log(`JUP 429: backing off ${backoff}ms`);
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
      return res;
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
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const sig = await jupSwapWithKeypair({ ...opts, slippageBps: slip });
      const ok = await confirmSig(sig, { commitment: "confirmed", timeoutMs: confirmMs }).catch(() => false);
      if (ok) return { ok: true, sig, slip };
    } catch (e) {
      const msg = String(e?.message || e || "");
      log(`Swap attempt ${attempt+1} failed: ${msg}`);
      if (/ROUTER_DUST|COULD_NOT_FIND_ANY_ROUTE|NO_ROUTE|BELOW_MIN_NOTIONAL|0x1788/i.test(msg)) {
        // On sell failures, set per-mint cooldown
        if (opts?.inputMint && opts?.outputMint === SOL_MINT && opts.inputMint !== SOL_MINT) {
          setRouterHold(opts.inputMint, ROUTER_COOLDOWN_MS);
        }
        return { ok: false, noRoute: true, msg };
      }
    }
    slip = Math.min(2000, Math.floor(slip * 1.6));
    log(`Swap not confirmed; retrying with slippage=${slip} bps…`);
  }
  return { ok: false };
}

async function jupSwapWithKeypair({ signer, inputMint, outputMint, amountUi, slippageBps }) {
  const { PublicKey, VersionedTransaction } = await loadWeb3();
  const conn = await getConn();
  const userPub = signer.publicKey.toBase58();
  const feeBps = Number(getPlatformFeeBps() || 0);
  let feeAccount = null;
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

  const baseUrl = await getJupBase();
  const isLite = /lite-api\.jup\.ag/i.test(baseUrl);
  const restrictAllowed = !isLite;


  const isSell = (inputMint !== SOL_MINT) && (outputMint === SOL_MINT);
  let restrictIntermediates = isSell ? "false" : "true";
  


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
        throw new Error("BELOW_MIN_NOTIONAL");
      }
    }

    const isRouteErr = (codeOrMsg) => /ROUTER_DUST|COULD_NOT_FIND_ANY_ROUTE|NO_ROUTE|0x1788/i.test(String(codeOrMsg||""));
    let sawRouteDust = false;

    const first = await buildAndSend(false);
    if (first.ok) { await seedCacheIfBuy(); return first.sig; }
    if (isRouteErr(first?.code || first?.msg)) sawRouteDust = true;

    const second = await buildAndSend(true);
    if (second.ok) { await seedCacheIfBuy(); return second.sig; }
    if (isRouteErr(second?.code || second?.msg)) sawRouteDust = true;

    const strictSeq = [
      () => manualBuildAndSend(false, false),
      () => manualBuildAndSend(true,  false),
      () => manualBuildAndSend(false, true),
      () => manualBuildAndSend(true,  true),
    ];
    for (const t of strictSeq) {
      try {
        const r = await t();
        if (r?.ok) { await seedCacheIfBuy(); return r.sig; }
        if (isRouteErr(r?.code || r?.msg)) sawRouteDust = true;
      } catch {}
    }

    try {
      const slipUp = Math.min(2000, Math.max(baseSlip, Math.floor(baseSlip * 3)));
      const alt = buildQuoteUrl({ outMint: outputMint, slipBps: slipUp, restrict: restrictIntermediates, asLegacy: false });
      const qAlt = await jupFetch(alt.pathname + alt.search);
      if (qAlt.ok) {
        quote = await qAlt.json();
        log(`Re-quoted with slip=${slipUp} bps.`);
        const seq2 = [
          () => buildAndSend(false, false),
          () => buildAndSend(true,  false),
          () => buildAndSend(false, true),
          () => buildAndSend(true,  true),
          () => manualBuildAndSend(false, false),
          () => manualBuildAndSend(true,  false),
          () => manualBuildAndSend(false, true),
          () => manualBuildAndSend(true,  true),
        ];
        for (const t of seq2) {
          try {
            const r = await t();
            if (r?.ok) { await seedCacheIfBuy(); return r.sig; }
            if (isRouteErr(r?.code || r?.msg)) sawRouteDust = true;
          } catch {}
        }
      }
    } catch {}

    // 4) SELL-specific alternates (USDC route and splits) before giving up
    if (isSell) {
      try {
        const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
        const slip3 = 2000;
        const rFlag = restrictAllowed ? "false" : "true";
        const q3 = buildQuoteUrl({ outMint: USDC, slipBps: slip3, restrict: rFlag });
        log("Strict fallback: route to USDC …");
        const r3 = await jupFetch(q3.pathname + q3.search);
        if (r3.ok) {
          quote = await r3.json();
          for (const t of [() => buildAndSend(false), () => buildAndSend(true), () => manualBuildAndSend(false), () => manualBuildAndSend(true)]) {
            try { const r = await t(); if (r?.ok) return r.sig; } catch {}
          }
        }
      } catch {}

      try {
        const fractions = [0.7, 0.5, 0.33, 0.25, 0.2];
        const slipSplit = 2000;
        for (const f of fractions) {
          const partRaw = Math.max(1, Math.floor(amountRaw * f));
          if (partRaw <= 0) continue;
          const restrictOptions = restrictAllowed ? ["false", "true"] : ["true"];
          for (const restrict of restrictOptions) {
            const qP = buildQuoteUrl({ outMint: outputMint, slipBps: slipSplit, restrict, amountOverrideRaw: partRaw });
            log(`Strict split-sell f=${f} restrict=${restrict} slip=${slipSplit} …`);
            const rP = await jupFetch(qP.pathname + qP.search);
            if (!rP.ok) continue;
            quote = await rP.json();
            const tries = [
              () => buildAndSend(false, false),
              () => buildAndSend(true,  false),
              () => manualBuildAndSend(false, false),
              () => manualBuildAndSend(true,  false),
              () => buildAndSend(false, true),
              () => buildAndSend(true,  true),
              () => manualBuildAndSend(false, true),
              () => manualBuildAndSend(true,  true),
            ];
            for (const t of tries) {
              try {
                const res = await t();
                if (res?.ok) { log(`Split-sell succeeded at ${Math.round(f*100)}% of position.`); return res.sig; }
                if (isRouteErr(res?.code || res?.msg)) sawRouteDust = true;
              } catch {}
            }
          }
        }
      } catch {}
    }

    // All fallbacks failed
    if (isSell && sawRouteDust) setRouterHold(inputMint, ROUTER_COOLDOWN_MS);
    throw new Error(sawRouteDust ? "ROUTER_DUST" : "swap failed");
  }

  async function seedCacheIfBuy() {
    if (inputMint === SOL_MINT && outputMint !== SOL_MINT) {
      const estRaw = Number(quote?.outAmount || 0);
      if (estRaw > 0) {
        const dec = await safeGetDecimalsFast(outputMint);
        const ui = estRaw / Math.pow(10, dec);
        try {
          updatePosCache(userPub, outputMint, ui, dec);
          log(`Seeded cache for ${outputMint.slice(0,4)}… (~${ui.toFixed(6)})`);
        } catch {}
        // Fire-and-forget: reconcile state and pick up on-chain credit as it lands
        setTimeout(() => {
          Promise.resolve()
            .then(() => syncPositionsFromChain(userPub).catch(()=>{}))
            .then(() => processPendingCredits().catch(()=>{}));
        }, 0);
      }
    }
  }

  async function buildAndSend(useSharedAccounts = true, asLegacy = false) {
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
      // add to cache
      // _pendingCredits?.set(sig, { type: "swap", vtx });
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

  async function manualBuildAndSend(useSharedAccounts = true, asLegacy = false) {
    const { PublicKey, Transaction, TransactionInstruction, TransactionMessage, VersionedTransaction } = await loadWeb3();

    async function reQuoteIfLegacy() {
      if (!asLegacy) return;
      try {
        const qLegacy = buildQuoteUrl({ outMint: outputMint, slipBps: baseSlip, restrict: restrictIntermediates, asLegacy: true });
        const qResL = await jupFetch(qLegacy.pathname + qLegacy.search);
        if (qResL.ok) {
          quote = await qResL.json();
          log("Re-quoted for legacy (manual).");
        } else {
          const body = await qResL.text().catch(()=> "");
          log(`Legacy quote (manual) failed (${qResL.status}): ${body || "(empty)"}`);
        }
      } catch (e) { log(`Legacy re-quote (manual) error: ${e.message || e}`); }
    }

    try {
      await reQuoteIfLegacy();

      const body = {
        quoteResponse: quote,
        userPublicKey: signer.publicKey.toBase58(),
        wrapAndUnwrapSol: true,
        dynamicComputeUnitLimit: true,
        useSharedAccounts: !!useSharedAccounts,
        asLegacyTransaction: !!asLegacy,
        ...(feeAccount && feeBps > 0 ? { feeAccount, platformFeeBps: feeBps } : {}),
      };
      logObj("Swap-instructions body", { hasFee: !!feeAccount, feeBps: feeAccount ? feeBps : 0, useSharedAccounts: !!useSharedAccounts, asLegacy: !!asLegacy });

      const iRes = await jupFetch(`/swap/v1/swap-instructions`, {
        method: "POST",
        headers: { "Content-Type":"application/json", accept: "application/json" },
        body: JSON.stringify(body),
      });
      if (!iRes.ok) {
        const errTxt = await iRes.text().catch(()=> "");
        log(`Swap-instructions error: ${errTxt || iRes.status}`);
        return { ok: false, code: "", msg: `swap-instructions ${iRes.status}` };
      }

      const {
        computeBudgetInstructions = [],
        setupInstructions = [],
        swapInstruction,
        cleanupInstructions = [],
        addressLookupTableAddresses = [],
      } = await iRes.json();

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

      if (asLegacy) {
        const tx = new Transaction();
        tx.feePayer = signer.publicKey;
        const { blockhash } = await conn.getLatestBlockhash("processed");
        tx.recentBlockhash = blockhash;
        for (const ix of ixs) tx.add(ix);
        tx.sign(signer);
        try {
          const sig = await conn.sendRawTransaction(tx.serialize(), { preflightCommitment: "processed", maxRetries: 3 });
          log(`Swap (manual legacy) sent: ${sig}`);
          return { ok: true, sig };
        } catch (e) {
          log(`Manual legacy send failed: ${e.message || e}. Simulating…`);
          try {
            const sim = await conn.simulateTransaction(tx, { sigVerify: false, replaceRecentBlockhash: true });
            const logs = sim?.value?.logs || e?.logs || [];
            log(`Simulation logs:\n${(logs||[]).join("\n")}`);
          } catch {}
          return { ok: false, code: "SEND_FAIL", msg: e.message || String(e) };
        }
      } else {
        const lookups = [];
        for (const addr of addressLookupTableAddresses || []) {
          try {
            const lut = await conn.getAddressLookupTable(new PublicKey(addr));
            if (lut?.value) lookups.push(lut.value);
          } catch {}
        }
        const { blockhash } = await conn.getLatestBlockhash("processed");
        const msg = new TransactionMessage({
          payerKey: signer.publicKey,
          recentBlockhash: blockhash,
          instructions: ixs,
        }).compileToV0Message(lookups);
        const vtx = new VersionedTransaction(msg);
        vtx.sign([signer]);
        try {
          const sig = await conn.sendRawTransaction(vtx.serialize(), { preflightCommitment: "processed", maxRetries: 3 });
          log(`Swap (manual v0) sent: ${sig}`);
          return { ok: true, sig };
        } catch (e) {
          log(`Manual v0 send failed: ${e.message || e}. Simulating…`);
          try {
            const sim = await conn.simulateTransaction(vtx, { sigVerify: false, replaceRecentBlockhash: true });
            const logs = sim?.value?.logs || e?.logs || [];
            log(`Simulation logs:\n${(logs||[]).join("\n")}`);
            const hasDustErr = (logs || []).some(l => /0x1788|0x1789/i.test(String(l)));
            return { ok: false, code: hasDustErr ? "ROUTER_DUST" : "SEND_FAIL", msg: e.message || String(e) };
          } catch {
            return { ok: false, code: "SEND_FAIL", msg: e.message || String(e) };
          }
        }
      }
    } catch (e) {
      return { ok: false, code: "", msg: e.message || String(e) };
    }
  }

  const first = await buildAndSend(false);
  if (first.ok) { await seedCacheIfBuy(); return first.sig; }
  if (first.code === "NOT_SUPPORTED") {
    log("Retrying with shared accounts …");
    const second = await buildAndSend(true);
    if (second.ok) { await seedCacheIfBuy(); return second.sig; }
  } else {
    log("Primary swap failed. Fallback: shared accounts …");
    const fallback = await buildAndSend(true);
    if (fallback.ok) { await seedCacheIfBuy(); return fallback.sig; }
  }

  {
    log("Swap API failed - trying manual build/sign …");
    const tries = [
      () => manualBuildAndSend(false, false),
      () => manualBuildAndSend(true, false),
      () => manualBuildAndSend(false, true),
      () => manualBuildAndSend(true, true),
    ];
    for (const t of tries) {
      try {
        const r = await t();
        if (r?.ok) { await seedCacheIfBuy(); return r.sig; }
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
        const b = await buildAndSend(true, true);
        if (b.ok) { await seedCacheIfBuy(); return b.sig; }
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
              }
            } catch {}
          }
        }
      } catch {}

    try {
      const fractions = [0.7, 0.5, 0.33, 0.25, 0.2];
      const slipSplit = 2000;
      for (const f of fractions) {
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

  throw new Error("swap failed");
}

async function sweepAllToSolAndReturn() {
  const { PublicKey, SystemProgram, Transaction } = await loadWeb3();
  const signer = await getAutoKeypair();
  if (!signer) throw new Error("auto wallet not ready");
  if (!state.recipientPub) throw new Error("recipient missing");
  log("Unwind: selling SPL positions and returning SOL…");

  const conn = await getConn();
  try {
    for (const mint of Object.keys(state.positions || {})) {
      if (mint === "So11111111111111111111111111111111111111112") continue;
      const b = await getAtaBalanceUi(signer.publicKey.toBase58(), mint, state.positions[mint]?.decimals);
      const uiAmt = Number(b.sizeUi || 0);
      if (uiAmt <= 0) continue;
      try {
        await jupSwapWithKeypair({
          signer,
          inputMint: mint,
          outputMint: "So11111111111111111111111111111111111111112",
          amountUi: uiAmt,
          slippageBps: state.slippageBps,
        });
        log(`Sold ${uiAmt.toFixed(6)} ${mint.slice(0,4)}… -> SOL`);
      } catch (e) {
        log(`Sell fail ${mint.slice(0,4)}…: ${e.message||e}`);
      }
    }
  } catch {}

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

function pickPumpCandidates(take = 1, poolN = 3) {
  try {
    const pool = (computePumpingLeaders(poolN) || []).map(it => ({
      mint: it?.mint,
      score: scorePumpCandidate(it),
      liqUsd: safeNum(it?.liqUsd ?? it?.kp?.liqUsd, 0),
      v1h: safeNum(it?.v1hTotal ?? it?.kp?.v1hTotal, 0),
      chg5m: safeNum(it?.change5m ?? it?.kp?.change5m, 0),
      chg1h: safeNum(it?.change1h ?? it?.kp?.change1h, 0),
    })).filter(x => x.mint);
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

function pickTopPumper() {
  const picks = pickPumpCandidates(1, 3);
  return picks[0] || "";
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
    return await getAssociatedTokenAddress(mint, owner, true, pid);
  } catch {
    // return a dummy impossible ATA to prevent throws upstream
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
      const minNotional = Math.max(MIN_SELL_SOL_OUT, MIN_JUP_SOL_IN * 1.05);
      if (estSol < minNotional) {
        log(`Skip ${mint.slice(0,4)}… (est ${estSol.toFixed(6)} SOL < ${minNotional}).`);
        unsellable++;
        continue;
      }

      const res = await executeSwapWithConfirm({
        signer: kp, inputMint: mint, outputMint: SOL_MINT, amountUi: sizeUi, slippageBps: state.slippageBps,
      }, { retries: 2, confirmMs: 15000 });

      if (!res.ok) throw new Error("route execution failed");

      log(`Startup sweep sold ${sizeUi.toFixed(6)} ${mint.slice(0,4)}… -> ~${estSol.toFixed(6)} SOL`);
      if (state.positions[mint]) { delete state.positions[mint]; save(); }
      removeFromPosCache(owner, mint);
      sold++;
      await new Promise(r => setTimeout(r, 250));
    } catch (e) {
      log(`Startup sweep sell failed ${mint.slice(0,4)}…: ${e.message || e}`);
    }
  }

  log(`Startup sweep complete. Sold ${sold} token${sold===1?"":"s"}. ${unsellable} dust/unsellable skipped.`);
  if (sold > 0) { state.lastTradeTs = now(); save(); }
}


// TODO: refine sell logic with more parameters and further include KPI addons.

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

async function evalAndMaybeSellPositions() {
  if (state.holdUntilLeaderSwitch) return;
  if (_inFlight) return;
  if (_sellEvalRunning) return;
  _sellEvalRunning = true;
  try {
    const kp = await getAutoKeypair();
    if (!kp) return;

    await syncPositionsFromChain(kp.publicKey.toBase58());
    const entries = Object.entries(state.positions || {});
    if (!entries.length) return;

    const nowTs = now();
    for (const [mint, pos] of entries) {
      try {

        const maxHold = Math.max(0, Number(state.maxHoldSecs || 0));
        const ageMs = nowTs - Number(pos.acquiredAt || pos.lastBuyAt || 0);
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

        let curSol = Number(pos.lastQuotedSol || 0);
        const lastQ = Number(pos.lastQuotedAt || 0);
        if (!lastQ || (nowTs - lastQ) > (state.minQuoteIntervalMs|0)) {
          log(`Evaluating sell for ${mint.slice(0,4)}… size ${sz.toFixed(6)}`);
          curSol = await quoteOutSol(mint, sz, pos.decimals).catch(() => 0);
          pos.lastQuotedSol = curSol;
          pos.lastQuotedAt = nowTs;
        }

        const baseMinNotional = Math.max(MIN_SELL_SOL_OUT, MIN_JUP_SOL_IN * 1.05);
        const minNotional = baseMinNotional; // keep router-safe default
        let d = null;

        if (curSol < minNotional && !forceExpire) {
          // selling dust works... but only if enabled
          d = shouldSell(pos, curSol, nowTs);
          const dustMin = Math.max(MIN_SELL_SOL_OUT, Number(state.dustMinSolOut || 0));
          if (!(state.dustExitEnabled && d.action === "sell_all" && curSol >= dustMin)) {
            log(`Skip sell eval ${mint.slice(0,4)}… (notional ${curSol.toFixed(6)} SOL < ${minNotional})`);
            continue;
          } else {
            log(`Dust exit enabled for ${mint.slice(0,4)}… (est ${curSol.toFixed(6)} SOL >= ${dustMin})`);
          }
        }

        let decision = d || shouldSell(pos, curSol, nowTs);
        if (forceExpire && (!decision || decision.action === "none")) {
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
                log(`Sell not confirmed for ${mint.slice(0,4)}… Keeping position.`);
                _inFlight = false;
                continue;
              }

              let remainUi2 = 0;
              try {
                const b2 = await getAtaBalanceUi(kp.publicKey.toBase58(), mint, pos.decimals);
                remainUi2 = Number(b2.sizeUi || 0);
              } catch {}
              if (remainUi2 > 1e-9) {
                pos.sizeUi = remainUi2;
                pos.lastSellAt = now();
                pos.allowRebuy = true;
                pos.lastSplitSellAt = now();
                updatePosCache(kp.publicKey.toBase58(), mint, pos.sizeUi, pos.decimals);
                save();
                log(`Post-sell balance remains ${remainUi2.toFixed(6)} ${mint.slice(0,4)}… (keeping position)`);
              } else {
                const reason = (decision && decision.reason) ? decision.reason : "done";
                log(`Sold ${sellUi.toFixed(6)} ${mint.slice(0,4)}… -> ${curSol.toFixed(6)} SOL (${reason})`);
                delete state.positions[mint];
                removeFromPosCache(kp.publicKey.toBase58(), mint);
                save();
              }
              state.lastTradeTs = now();
              _inFlight = false;
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
            log(`Sell not confirmed for ${mint.slice(0,4)}… (partial). Keeping position.`);
            _inFlight = false;
            continue;
          }

          log(`Sold ${sellUi.toFixed(6)} ${mint.slice(0,4)}… -> ${curSol.toFixed(6)} SOL (${(decision && decision.reason) ? decision.reason : "done"})`);
          const remainPct = 1 - (pct / 100);
          pos.sizeUi = Math.max(0, pos.sizeUi - sellUi);
          pos.costSol = Number(pos.costSol || 0) * remainPct;
          pos.hwmSol = Number(pos.hwmSol || 0) * remainPct;
          pos.hwmPx = Number(pos.hwmPx || 0);
          pos.lastSellAt = now();
          pos.allowRebuy = true;
          pos.lastSplitSellAt = now();

          try {
            const b2 = await getAtaBalanceUi(kp.publicKey.toBase58(), mint, pos.decimals);
            pos.sizeUi = Number(b2.sizeUi || pos.sizeUi || 0);
            pos.decimals = Number.isFinite(b2.decimals) ? b2.decimals : pos.decimals;
          } catch {}
          updatePosCache(kp.publicKey.toBase58(), mint, pos.sizeUi, pos.decimals);
          save();
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
              log(`Sell not confirmed for ${mint.slice(0,4)}… Keeping position.`);
              _inFlight = false;
              continue;
            }

            let remainUi = 0;
            try {
              const b2 = await getAtaBalanceUi(kp.publicKey.toBase58(), mint, pos.decimals);
              remainUi = Number(b2.sizeUi || 0);
            } catch {}
            if (remainUi > 1e-9) {
              pos.sizeUi = remainUi;
              pos.lastSellAt = now();
              updatePosCache(kp.publicKey.toBase58(), mint, pos.sizeUi, pos.decimals);
              save();
              log(`Post-sell balance remains ${remainUi.toFixed(6)} ${mint.slice(0,4)}… (keeping position)`);
            } else {
              const reason = (decision && decision.reason) ? decision.reason : "done";
              log(`Sold ${sellUi.toFixed(6)} ${mint.slice(0,4)}… -> ${curSol.toFixed(6)} SOL (${reason})`);
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

    let rotated = 0;
    for (const mint of mints) {
      try {
        if (window._fdvRouterHold && window._fdvRouterHold.get(mint) > now()) {
          const until = window._fdvRouterHold.get(mint);
          log(`Router cooldown (rotate) for ${mint.slice(0,4)}… until ${new Date(until).toLocaleTimeString()}`);
          continue;
        }
        const b = await getAtaBalanceUi(kp.publicKey.toBase58(), mint, state.positions[mint]?.decimals);
  
        const uiAmt = Number(b.sizeUi || 0);
        if (uiAmt <= 0) {
          log(`No balance to rotate for ${mint.slice(0,4)}…`);
          delete state.positions[mint];
          continue;
        }
        const estSol = await quoteOutSol(mint, uiAmt, state.positions[mint]?.decimals).catch(() => 0);
        const minNotional = Math.max(MIN_SELL_SOL_OUT, MIN_JUP_SOL_IN * 1.05);
        if (estSol < minNotional) {
          log(`Skip rotation for ${mint.slice(0,4)}… (est ${estSol.toFixed(6)} SOL < ${minNotional})`);
          continue;
        }
        await jupSwapWithKeypair({
          signer: kp,
          inputMint: mint,
          outputMint: SOL_MINT,
          amountUi: uiAmt,
          slippageBps: state.slippageBps,
        });
        log(`Rotated out: ${uiAmt.toFixed(6)} ${mint.slice(0,4)}… -> ~${estSol.toFixed(6)} SOL`);
        delete state.positions[mint];
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

  const leaderMode = !!state.holdUntilLeaderSwitch;
  const picks = leaderMode
    ? [pickTopPumper()].filter(Boolean)
    : (state.allowMultiBuy
        ? pickPumpCandidates(Math.max(1, state.multiBuyTopN|0), 3)
        : [pickTopPumper()].filter(Boolean));
  if (!picks.length) return;

  let ignoreCooldownForLeaderBuy = false;
  if (leaderMode && picks[0]) {
    const didRotate = await switchToLeader(picks[0]);
    if (didRotate) ignoreCooldownForLeaderBuy = true;
  }

  const withinBatch = state.allowMultiBuy && now() <= _buyBatchUntil;
  if (state.lastTradeTs && (now() - state.lastTradeTs)/1000 < state.minSecsBetween && !withinBatch && !ignoreCooldownForLeaderBuy) return;

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
      const allowRebuy = !!pos?.allowRebuy; // set when we split-sold and kept a remainder
      const eligibleSize = allowRebuy || Number(pos?.sizeUi || 0) <= 0;
      const notPending = !pos?.awaitingSizeSync;
      return eligibleSize && notPending;
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

      const res = await executeSwapWithConfirm({
        signer: kp,
        inputMint: SOL_MINT,
        outputMint: mint,
        amountUi: buySol,
        slippageBps: state.slippageBps,
      }, { retries: 2, confirmMs: 15000 });
      if (!res.ok) {
        log(`Buy not confirmed for ${mint.slice(0,4)}… skipping accounting.`);
        continue;
      }

      remainingLamports = Math.max(0, remainingLamports - buyLamports - reqRent);
      remaining = remainingLamports / 1e9;

      const prevPos  = state.positions[mint];
      const prevSize = Number(prevPos?.sizeUi || 0);
      const basePos  = prevPos || { costSol: 0, hwmSol: 0, acquiredAt: now() };

      // Verify on-chain credit before accounting
      let credited = false;
      let got = { sizeUi: 0, decimals: Number.isFinite(basePos.decimals) ? basePos.decimals : 6 };
      try {
        got = await waitForTokenCredit(kp.publicKey.toBase58(), mint, { timeoutMs: 8000, pollMs: 300 });
      } catch (e) { log(`Token credit wait failed: ${e.message || e}`); }
      if (!Number(got.sizeUi || 0)) {
        try {
          const bal = await getAtaBalanceUi(kp.publicKey.toBase58(), mint, basePos.decimals);
          got = { sizeUi: Number(bal.sizeUi || 0), decimals: Number.isFinite(bal.decimals) ? bal.decimals : got.decimals };
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
        });
        try { await processPendingCredits(); } catch {}
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
    if (!timer && state.enabled) {
      timer = setInterval(tick, 5000);
      log("Auto trading started");
    }
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
      <span class="fdv-title">Auto Pump (v0.0.2)</span>
    </span>
  `;

  const body = document.createElement("div");
  body.className = "fdv-auto-body";
  body.innerHTML = `
    <div class="fdv-auto-head">
    </div>
    <div style="display:flex;align-items:center;gap:8px;border-bottom:1px solid var(--fdv-border);padding-bottom:8px;margin-bottom:8px; position:relative;">
      <button data-auto-gen>Generate</button>
      <button data-auto-copy>Address</button>
      <button data-auto-unwind>Return</button>
      <button data-auto-wallet>Wallet</button>
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
        <div data-auto-wallet-totals style="margin-top:8px; font-weight:600;">Total: …</div>
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
      <label style="margin-left:12px;">Hold Leader
        <select data-auto-hold>
          <option value="no">No</option>
          <option value="yes">Yes</option>
        </select>
      </label>
      <label>Try to sell dust
        <select data-auto-dust>
          <option value="no">No</option>
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
        <button data-auto-help title="How the bot works">Help</button>
        <button data-auto-log-copy title="Copy log">Log</button>
        <div class="fdv-modal" data-auto-modal
             style="display:none; position:fixed; width: 100%; inset:0; z-index:9999; background:rgba(0, 0, 0, 1); align-items:center; justify-content:center;">
          <div class="fdv-modal-card"
               style="background:var(--fdv-bg,#111); color:var(--fdv-fg,#fff); width:92%; max-width:720px; max-height:80vh; overflow:auto; border-radius:12px; box-shadow:0 10px 30px rgba(0,0,0,.5); padding:16px 20px;">
            <div style="display:flex; align-items:center; justify-content:space-between; gap:12px; margin-bottom:6px;">
              <h3 style="margin:0; font-size:16px;">Auto Pump Bot Guide</h3>
            </div>
            <div class="fdv-modal-body-tooltip" style="font-size:13px; line-height:1.5; gap:10px;">
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
      <button data-auto-reset>Refresh</button>
    </div>
    </div>
  `;

  wrap.appendChild(summary);
  wrap.appendChild(body);
  container.appendChild(wrap);

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
        walletSolEl.textContent = `SOL: 0.0000 (—)`;
        walletTotalsEl.textContent = `Total: $0.00`;
        return;
      }

      const owner = kp.publicKey.toBase58();

      const solBal = await fetchSolBalance(owner).catch(()=>0);
      const solUsdPx = await getSolUsd();
      walletSolEl.textContent = `SOL: ${Number(solBal).toFixed(6)} (${solUsdPx>0?fmtUsd(solBal*solUsdPx):"—"})`;

      const cachedEntries = cacheToList(owner); // [{ mint, sizeUi, decimals }]
      const entries = cachedEntries.filter(it => it.mint !== SOL_MINT && Number(it.sizeUi||0) > 0);

      if (!entries.length) {
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
       const baseMinNotional = Math.max(MIN_SELL_SOL_OUT, MIN_JUP_SOL_IN * 1.05, Number(state.dustMinSolOut || 0));

       for (const { mint, sizeUi, decimals } of entries) {
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
 
         // Classify by Jupiter min-notional/routeability
         const sellable = estSol > 0 && estSol >= baseMinNotional;
         (sellable ? sellWrap : dustWrap).appendChild(row);
       }

      walletTotalsEl.textContent = `Total: ${fmtUsd(totalUsd)} (${totalSol.toFixed(6)} SOL)`;
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
        <label style="width:110px;">Hold Time</label>
        <input type="range" data-auto-holdtime min="${MIN_HOLD}" max="${MAX_HOLD}" step="1" value="${cur}" style="width: 100%;" />
        <div data-auto-holdtime-val style="width:56px; text-align:right;">${cur}s</div>
      </div>
    `;

    const rangeEl = holdTimeWrap.querySelector('[data-auto-holdtime]');
    const valEl   = holdTimeWrap.querySelector('[data-auto-holdtime-val]');
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