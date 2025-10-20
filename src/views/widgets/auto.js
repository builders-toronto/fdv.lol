import { FDV_FEE_RECEIVER } from "../../config/env.js";
import { computePumpingLeaders } from "../meme/addons/pumping.js";

// Dust orders and minimums are blocked due to Jupiter route failures and 400 errors.

const SOL_MINT = "So11111111111111111111111111111111111111112";
// Minimum SOL-in to avoid Jupiter 400s on tiny swaps 
const MIN_JUP_SOL_IN = 0.00005;
// Minimum SOL-out on sells to avoid dust/route failures
const MIN_SELL_SOL_OUT = 0.0007;

// Dynamic fee reserve for small balances
const FEE_RESERVE_MIN = 0.0002;   // rent
const FEE_RESERVE_PCT = 0.10;     // or 10% of balance

const TX_FEE_BUFFER_LAMPORTS = 250_000

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

// Read CFG from swap.js when available (jupiterBase, platformFeeBps, tokenDecimals)
async function getCfg() {
  try { return (await import("./swap.js"))?.CFG || {}; } catch { return {}; }
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
  partialTpPct: 50,            
  minQuoteIntervalMs: 10000, 
  sellCooldownMs: 20000,  

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
  dustMinSolOut: 0.0006,

  // Cache
  pendingGraceMs: 20000,

  // collapse state for <details>
  collapsed: true,
  // hold until new leader detected
  holdUntilLeaderSwitch: false,
};
let timer = null;
let logEl, toggleEl, startBtn, stopBtn, mintEl;
let depAddrEl, depBalEl, lifeEl, recvEl, buyPctEl, minBuyEl, maxBuyEl;


const POSCACHE_KEY_PREFIX = "fdv_poscache_v1:";

function loadPosCache(ownerPubkeyStr) {
  if (localStorage.getItem(POSCACHE_KEY_PREFIX + ownerPubkeyStr) === null) {
    localStorage.setItem(POSCACHE_KEY_PREFIX + ownerPubkeyStr, JSON.stringify({}));
  }
  try { return JSON.parse(localStorage.getItem(POSCACHE_KEY_PREFIX + ownerPubkeyStr) || "{}") || {}; }
  catch { return {}; }
}
function savePosCache(ownerPubkeyStr, data) {
  // console.log("saving to cache:", data);
  try { localStorage.setItem(POSCACHE_KEY_PREFIX + ownerPubkeyStr, JSON.stringify(data || {})); } catch {}
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
  }
}
function removeFromPosCache(ownerPubkeyStr, mint) {
  if (!ownerPubkeyStr || !mint) return;
  const cache = loadPosCache(ownerPubkeyStr);
  if (cache[mint]) { delete cache[mint]; savePosCache(ownerPubkeyStr, cache); }
}
function cacheToList(ownerPubkeyStr) {
  const cache = loadPosCache(ownerPubkeyStr);
  return Object.entries(cache).map(([mint, v]) => ({
    mint,
    sizeUi: Number(v?.sizeUi || 0),
    decimals: Number.isFinite(v?.decimals) ? v.decimals : 6
  })).filter(x => x.mint && x.sizeUi > 0);
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

async function getJupBase() {
  const cfg = await getCfg();
  return String(cfg.jupiterBase || "https://lite-api.jup.ag").replace(/\/+$/,"");
}
async function getFeeReceiver() {
  const cfg = await getCfg();
  return String(FDV_FEE_RECEIVER || "");
}
async function getPlatformFeeBps() {
  const cfg = await getCfg();
  const n = Number(cfg.platformFeeBps);
  return Number.isFinite(n) ? Math.max(0, n|0) : 0;
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
  if (!Array.isArray(atas) || atas.length === 0) {
    return { sizeUi: 0, decimals };
  }

  while (now() - start < timeoutMs) {
    for (const { ata } of atas) {
      try {
        const res = await conn.getTokenAccountBalance(ata);
        if (res?.value) {
          const ui = Number(res.value.uiAmount || 0);
          const dec = Number.isFinite(res.value.decimals) ? res.value.decimals : undefined;
          if (ui > 0) return { sizeUi: ui, decimals: Number.isFinite(dec) ? dec : decimals };
        }
      } catch {}
    }
    await new Promise(r => setTimeout(r, pollMs));
  }
  return { sizeUi: 0, decimals };
}
async function getFeeAta(mintStr) {
  const feeRecv = await getFeeReceiver();
  if (!feeRecv) return null;
  const { PublicKey } = await loadWeb3();
  const { getAssociatedTokenAddress } = await loadSplToken();
  try {
    const mint = new PublicKey(mintStr);
    const owner = new PublicKey(feeRecv);
    return await getAssociatedTokenAddress(mint, owner, true);
  } catch { return null; }
}

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

function load() {
  try { state = { ...state, ...(JSON.parse(localStorage.getItem(LS_KEY))||{}) }; } catch {}
  state.slippageBps = Math.max(150, Number(state.slippageBps || 150) | 0);
  state.minBuySol   = Math.max(MIN_JUP_SOL_IN, Number(state.minBuySol || MIN_JUP_SOL_IN));
  save();
}
function save() {
  try { localStorage.setItem(LS_KEY, JSON.stringify(state)); } catch {}
}
function log(msg) {
  if (!logEl) return;
  const d = document.createElement("div");
  d.textContent = `[${new Date().toLocaleTimeString()}] ${msg}`;
  logEl.appendChild(d);
  logEl.scrollTop = logEl.scrollHeight;
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

function now() { return Date.now(); }

const _pkValidCache = new Map();
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

function logObj(label, obj) {
  try { log(`${label}: ${JSON.stringify(obj)}`); } catch {}
}
function redactHeaders(hdrs) {
  const keys = Object.keys(hdrs || {});
  return keys.length ? `{headers: ${keys.join(", ")}}` : "{}";
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
      log(`Swap attempt ${attempt+1} failed: ${e.message || e}`);
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
  const feeBps = await getPlatformFeeBps();
  const feeRecv = await getFeeReceiver();
  let feeAccount = null;

  if (feeBps > 0 && feeRecv) {
    try {
      const ataPk = await getFeeAta(inputMint); 
      if (ataPk) {
        // Verify it exists and matches expected owner/mint
        const info = await conn.getParsedAccountInfo(new PublicKey(ataPk)).catch(() => null);
        const parsed = info?.value?.data?.parsed?.info;
        const ataOwner = parsed?.owner;
        const ataMint = parsed?.mint;
        if (info?.value && ataOwner === feeRecv && ataMint === inputMint) {
          feeAccount = ataPk.toBase58 ? ataPk.toBase58() : String(ataPk);
          log(`Fee enabled: ATA ${feeAccount} (mint=${inputMint.slice(0,4)}…) @ ${feeBps} bps`);
        } else {
          log("Fee ATA invalid or missing on-chain for input mint. Skipping fee for this swap.");
        }
      }
    } catch {
      log("Fee ATA lookup failed. Skipping fee for this swap.");
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
      ...(feeAccount ? { feeAccount } : {}),

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
      const sig = await conn.sendRawTransaction(vtx.serialize(), { preflightCommitment: "processed" });
      log(`Swap sent: ${sig}`);
      return { ok: true, sig };
    } catch (e) {
      log(`Swap send failed: ${e.message || e}. Simulating…`);
      try {
        const sim = await conn.simulateTransaction(vtx, { sigVerify: false, replaceRecentBlockhash: true });
        const logs = sim?.value?.logs || e?.logs || [];
        log(`Simulation logs:\n${(logs||[]).join("\n")}`);
        // detect dust/cooldown signatures, but do not set global holds
        const hasDustErr = (logs || []).some(l => /0x1788|0x1789/i.test(String(l)));
        return { ok: false, code: hasDustErr ? "ROUTER_DUST" : "SEND_FAIL", msg: e.message || String(e) };
      } catch {
        return { ok: false, code: "SEND_FAIL", msg: e.message || String(e) };
      }
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
      log("Tiny-notional fallback: route to USDC …");
      const r3 = await jupFetch(q3.pathname + q3.search);
      if (r3.ok) {
        quote = await r3.json();
        const a = await buildAndSend(false);
        if (a.ok) return a.sig;
        const b = await buildAndSend(true);
        if (b.ok) return b.sig;
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

let _buyBatchUntil = 0;


function safeNum(v, def=0){ const n = Number(v); return Number.isFinite(n) ? n : def; }
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
    const res = await conn.getTokenAccountBalance(ata).catch(() => null);
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
  // Check existence only to report exists, but never clear cache on misses
  let existsAny = false;
  for (const { ata } of atas) {
    const ai = await conn.getAccountInfo(ata, "processed").catch(() => null);
    existsAny = existsAny || !!ai;
  }
  const decimals = Number.isFinite(decimalsHint) ? decimalsHint : (await getMintDecimals(mintStr));
  if (best) return best;
  return { sizeUi: 0, decimals, exists: existsAny };
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

  if (!out.length) return cacheToList(ownerPubkeyStr);
  for (const r of out) updatePosCache(ownerPubkeyStr, r.mint, r.sizeUi, r.decimals);
  return out;
}

async function syncPositionsFromChain(ownerPubkeyStr) {
  try {
    log("Syncing positions from chain (ATAs) …");
    const nowTs = now();

    let scanned = [];
    let seen = new Set();
    if (!state.ownerScanDisabled) {
      scanned = await listOwnerSplPositions(ownerPubkeyStr);
      seen = new Set(scanned.map(x => x.mint));

      const cachedList = cacheToList(ownerPubkeyStr);
      for (const c of cachedList) {
        if (!seen.has(c.mint)) { scanned.push(c); seen.add(c.mint); }
      }

      for (const { mint, sizeUi, decimals } of scanned) {
        const prev = state.positions[mint] || { costSol: 0, hwmSol: 0, acquiredAt: nowTs };
        const next = {
          ...prev,
          sizeUi: Number(sizeUi || 0),
          decimals: Number.isFinite(decimals) ? decimals : prev.decimals ?? 6,
          lastSeenAt: nowTs,
        };
        if (next.awaitingSizeSync && Number(next.sizeUi || 0) > 0) next.awaitingSizeSync = false;
        state.positions[mint] = next;
      }
    } else {
      const cached = loadPosCache(ownerPubkeyStr);
      for (const [mint, pos] of Object.entries(state.positions || {})) {
        if (mint === SOL_MINT) continue;
        if (pos.awaitingSizeSync) {
          const c = cached[mint];
          if (c && Number(c.sizeUi || 0) > 0) {
            pos.sizeUi = Number(c.sizeUi);
            pos.decimals = Number.isFinite(c.decimals) ? c.decimals : (pos.decimals ?? 6);
            pos.lastSeenAt = nowTs;
            pos.awaitingSizeSync = false;
            state.positions[mint] = pos;
          }
        }
      }
    }

    for (const mint of Object.keys(state.positions || {})) {
      if (mint === SOL_MINT) continue;
      if (seen.has(mint)) continue;

      const pos = state.positions[mint] || {};
      let existsFlag = false;
      try {
        const b = await getAtaBalanceUi(ownerPubkeyStr, mint, pos.decimals);
        existsFlag = !!b.exists;
        const amt = Number(b.sizeUi || 0);
        if (amt > 0) {
          state.positions[mint] = {
            ...pos,
            sizeUi: amt,
            decimals: b.decimals,
            lastSeenAt: nowTs,
            awaitingSizeSync: false,
          };
          continue;
        }
      } catch {}

      const age = nowTs - Number(pos.lastBuyAt || pos.acquiredAt || 0);
      const grace = Math.max(5_000, Number(state.pendingGraceMs || 20_000));
      if (Number(pos.sizeUi || 0) <= 0 && age > grace) {
        pos.awaitingSizeSync = false; // clear pending so buyCandidates can include this mint
        state.positions[mint] = pos;
      }

      const pruneAfter = grace * 30; // ~10 minutes at default
      if (Number(pos.sizeUi || 0) <= 0 && !existsFlag && age > pruneAfter) {
        delete state.positions[mint];
        removeFromPosCache(ownerPubkeyStr, mint);
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
  log("Startup sweep: checking for non-SOL balances …");
  const tracked = Object.entries(state.positions || {})
    .filter(([m, p]) => m !== SOL_MINT && Number(p?.sizeUi || 0) > 0)
    .map(([mint, p]) => ({ mint, sizeUi: Number(p.sizeUi), decimals: Number(p.decimals || 6) }));
  // Prefer scan
  const scanned = state.ownerScanDisabled ? [] : await listOwnerSplPositions(kp.publicKey.toBase58()).catch(()=>[]);
  const cached = scanned.length ? [] : cacheToList(kp.publicKey.toBase58());
  const byMint = new Map();
  for (const p of tracked) byMint.set(p.mint, p);
  for (const p of scanned) byMint.set(p.mint, p);
  for (const p of cached) byMint.set(p.mint, p);
  const items = Array.from(byMint.values());
  if (!items.length) { log("Startup sweep: no SPL balances to sell."); return; }
 let sold = 0;
  for (const { mint, sizeUi, decimals } of items) {
    try {
      const estSol = await quoteOutSol(mint, sizeUi, decimals).catch(() => 0);
      const minNotional = Math.max(MIN_SELL_SOL_OUT, MIN_JUP_SOL_IN * 1.05);
      if (estSol < minNotional) {
        log(`Skip ${mint.slice(0,4)}… (est ${estSol.toFixed(6)} SOL < ${minNotional}).`);
        continue;
      }

      const res = await executeSwapWithConfirm({
        signer: kp, inputMint: mint, outputMint: SOL_MINT, amountUi: sizeUi, slippageBps: state.slippageBps,
      }, { retries: 2, confirmMs: 15000 });

      if (!res.ok) throw new Error("route execution failed");

      log(`Startup sweep sold ${sizeUi.toFixed(6)} ${mint.slice(0,4)}… -> ~${estSol.toFixed(6)} SOL`);
      if (state.positions[mint]) { delete state.positions[mint]; save(); }
      removeFromPosCache(kp.publicKey.toBase58(), mint);
      sold++;
      await new Promise(r => setTimeout(r, 250));
    } catch (e) {
      log(`Startup sweep sell failed ${mint.slice(0,4)}…: ${e.message || e}`);
    }
  }
  log(`Startup sweep complete. Sold ${sold} token${sold===1?"":"s"}.`);
  if (sold > 0) { state.lastTradeTs = now(); save(); }
}



// TODO: refine sell logic with more parameters and further include KPI addons.

let _buyInFlight = false;
let _sellEvalRunning = false;

function shouldSell(pos, curSol, nowTs) {
  const sz = Number(pos.sizeUi || 0);
  const cost = Number(pos.costSol || 0);
  if (!Number.isFinite(curSol) || curSol <= 0) return { action: "none" };
  if (cost <= 0 || sz <= 0) return { action: "none" };

  if (pos.awaitingSizeSync) return { action: "none", reason: "awaiting-size-sync" };

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



let _inFlight = false;


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

        if (curSol < minNotional) {
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

        const decision = d || shouldSell(pos, curSol, nowTs);
        log(`Sell decision: ${decision.action !== "none" ? decision.action : "NO"} (${decision.reason || "criteria not met"})`);
        if (decision.action === "none") continue;


        // Jupiter 0x1788 = cooldown
        if (window._fdvRouterHold && window._fdvRouterHold.get(mint) > now()) {
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
            log(`Sold ${sellUi.toFixed(6)} ${mint.slice(0,4)}… -> ${curSol.toFixed(6)} SOL (${d.reason})`);
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

let _switchingLeader = false;



async function switchToLeader(newMint) {
  const prev = state.currentLeaderMint || "";
  if (!newMint || newMint === prev) return false;

  // Guard leader mint
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

    // Filter out invalid/stale mints up-front
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
  if (!state.enabled) return;
  if (state.endAt && now() >= state.endAt) {
    log("Lifetime ended. Unwinding…");
    try { await sweepAllToSolAndReturn(); } catch(e){ log(`Unwind failed: ${e.message||e}`); }
    return;
  }
  if (depBalEl && state.autoWalletPub) {
    fetchSolBalance(state.autoWalletPub).then(b => { depBalEl.value = `${b.toFixed(4)} SOL`; }).catch(()=>{});
  }

  try { await evalAndMaybeSellPositions(); } catch {}

  log("Follow us on twitter: https://twitter.com/fdvlol for updates and announcements!");

  if (_buyInFlight || _inFlight || _switchingLeader) return;

  const picks = state.allowMultiBuy
    ? pickPumpCandidates(Math.max(1, state.multiBuyTopN|0), 3)
    : [pickTopPumper()].filter(Boolean);
  if (!picks.length) return;

  log(`Pump picks: ${picks.map(m=>m.slice(0,4)+"…").join(", ")}`);

  if (state.holdUntilLeaderSwitch) {
    const didRotate = await switchToLeader(picks[0]);
    if (didRotate) return;
  }

  const withinBatch = state.allowMultiBuy && now() <= _buyBatchUntil;
  if (state.lastTradeTs && (now() - state.lastTradeTs)/1000 < state.minSecsBetween && !withinBatch) return;

  try {
    const kp = await getAutoKeypair();
    if (!kp) return;

    await syncPositionsFromChain(kp.publicKey.toBase58());

    const cur = state.positions[picks[0]];
    const alreadyHoldingLeader = Number(cur?.sizeUi || 0) > 0 || Number(cur?.costSol || 0) > 0;
    if (state.holdUntilLeaderSwitch && alreadyHoldingLeader) {
      log("Holding current leader. No additional buys.");
      return;
    }

    const solBal = await fetchSolBalance(kp.publicKey.toBase58());
    const feeReserve   = Math.max(FEE_RESERVE_MIN, solBal * FEE_RESERVE_PCT);
    const affordable   = Math.max(0, solBal - feeReserve);
    const desired      = Math.min(state.maxBuySol, Math.max(state.minBuySol, solBal * state.buyPct));
    const minThreshold = Math.max(state.minBuySol, MIN_SELL_SOL_OUT);
    let plannedTotal   = Math.min(affordable, Math.min(state.maxBuySol, state.carrySol + desired));

    logObj("Buy sizing (pre-split)", { solBal: Number(solBal).toFixed(6), feeReserve, affordable, desired, carry: state.carrySol, plannedTotal, minThreshold });

    const buyCandidates = picks.filter(m => {
      const pos = state.positions[m];
      const sz0 = Number(pos?.sizeUi || 0) <= 0;
      const notPending = !pos?.awaitingSizeSync;
      return sz0 && notPending;
    });
    if (!buyCandidates.length) { log("All picks already held or pending. Skipping buys."); return; }

    if (plannedTotal < minThreshold) {
      state.carrySol += desired;
      save();
      log(`Accumulating. Carry=${state.carrySol.toFixed(6)} SOL (< ${minThreshold} min).`);
      return;
    }

    _buyInFlight = true;

    let solLamports = Math.floor(solBal * 1e9);
    const feeReserveLamports = Math.floor(feeReserve * 1e9);
    let remainingLamports = Math.max(0, solLamports - feeReserveLamports);
    let remaining = plannedTotal;
    let spent = 0;
    let buysDone = 0;

    for (let i = 0; i < buyCandidates.length; i++) {
      const mint = buyCandidates[i];
      const left = buyCandidates.length - i;
      const target = Math.max(minThreshold, remaining / left);

      const reqRent = await requiredAtaLamportsForSwap(kp.publicKey.toBase58(), SOL_MINT, mint);
      const candidateBudgetLamports = Math.max(0, remainingLamports - reqRent - TX_FEE_BUFFER_LAMPORTS);
      const targetLamports = Math.floor(target * 1e9);
      let buyLamports = Math.min(targetLamports, Math.floor(remaining * 1e9), candidateBudgetLamports);

      const minInLamports = Math.floor(MIN_JUP_SOL_IN * 1e9);
      if (buyLamports < minInLamports) {
        if (reqRent > 0) {
          const needSol = (reqRent + minInLamports + TX_FEE_BUFFER_LAMPORTS - remainingLamports) / 1e9;
          log(`Skip ${mint.slice(0,4)}… (insufficient to fund ATAs). Need ~${Math.max(0, needSol).toFixed(6)} SOL more.`);
        } else {
          log(`Skip ${mint.slice(0,4)}… (buy < router min ${MIN_JUP_SOL_IN}).`);
        }
        continue;
      }

      const buySol = buyLamports / 1e9;

      const sig = await jupSwapWithKeypair({
        signer: kp,
        inputMint: SOL_MINT,
        outputMint: mint,
        amountUi: buySol,
        slippageBps: state.slippageBps,
      });

      await confirmSig(sig, { commitment: "confirmed", timeoutMs: 12000 });

      remainingLamports = Math.max(0, remainingLamports - buyLamports - reqRent);
      remaining = remainingLamports / 1e9;

      const prevPos  = state.positions[mint];
      const prevSize = Number(prevPos?.sizeUi || 0);
      const pos = prevPos || { costSol: 0, hwmSol: 0, acquiredAt: now() };

      let credit = { sizeUi: 0, decimals: Number.isFinite(pos.decimals) ? pos.decimals : 6 };
      try {
        credit = await waitForTokenCredit(kp.publicKey.toBase58(), mint, { timeoutMs: 8000, pollMs: 300 });
      } catch (e) {
        log(`Token credit wait failed: ${e.message || e}`);
        try { credit.decimals = await getMintDecimals(mint); } catch {}
      }

      pos.costSol = Number(pos.costSol || 0) + buySol;
      pos.hwmSol = Math.max(Number(pos.hwmSol || 0), buySol);
      pos.lastBuyAt = now();
      pos.awaitingSizeSync = true;

      if (credit.sizeUi > 0) {
        pos.sizeUi = credit.sizeUi;
        pos.decimals = credit.decimals;
        pos.lastSeenAt = now();
        if (Number(pos.sizeUi || 0) !== prevSize) pos.awaitingSizeSync = false;
        updatePosCache(kp.publicKey.toBase58(), mint, pos.sizeUi, pos.decimals);
      } else {
        try {
          const bal = await getAtaBalanceUi(kp.publicKey.toBase58(), mint, pos.decimals);
          pos.sizeUi = Number(bal.sizeUi || 0);
          pos.decimals = Number.isFinite(bal.decimals) ? bal.decimals : (pos.decimals ?? await getMintDecimals(mint));
          pos.lastSeenAt = now();
          if (Number(pos.sizeUi || 0) > 0 && Number(pos.sizeUi || 0) !== prevSize) pos.awaitingSizeSync = false;
          updatePosCache(kp.publicKey.toBase58(), mint, pos.sizeUi, pos.decimals);
        } catch { log(`Failed to refresh size after buy for ${mint.slice(0,4)}…`); }
        if (!Number(pos.sizeUi || 0)) {
          const seeded = loadPosCache(kp.publicKey.toBase58())[mint];
          if (seeded && Number(seeded.sizeUi || 0) > 0) {
            pos.sizeUi = Number(seeded.sizeUi);
            pos.decimals = Number.isFinite(seeded.decimals) ? seeded.decimals : (pos.decimals ?? 6);
            pos.lastSeenAt = now();
          }
        }
      }

      state.positions[mint] = pos;
      save();

      spent += buySol;
      buysDone++;
      _buyBatchUntil = now() + (state.multiBuyBatchMs|0);

      log(`Bought ~${buySol.toFixed(4)} SOL -> ${mint.slice(0,4)}…`);
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
let _starting = false;
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
      toggleEl.checked = false;
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
   toggleEl.checked = state.enabled;
   startBtn.disabled = state.enabled;
   stopBtn.disabled = !state.enabled;
   if (state.enabled && !currentRpcUrl()) {
     log("Configure a CORS-enabled Solana RPC URL before starting.");
     state.enabled = false;
     toggleEl.checked = false;
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
      <span class="fdv-title">Auto Pump (v0.0.14)</span>
    </span>
  `;

  const body = document.createElement("div");
  body.className = "fdv-auto-body";
  body.innerHTML = `
    <div class="fdv-auto-head">
      <label class="fdv-switch fdv-hold-leader" style="margin-left:12px;">
        <input type="checkbox" data-auto-hold disabled/>
        <span>Leader</span>
      </label>
      <label class="fdv-switch">
        <input type="checkbox" data-auto-toggle />
        <span>Enabled</span>
      </label>
    </div>
    <div style="display:flex;align-items:center;gap:8px;border-bottom:1px solid var(--fdv-border);padding-bottom:8px;margin-bottom:8px;">
      <button data-auto-gen>Generate</button>
      <button data-auto-copy>Address</button>
      <button data-auto-unwind>Return</button>
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
    </div>
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
                </ul>
              </div>
              <div>
                <strong>Quick start</strong>
                <ol style="margin:6px 0 0 18px;">
                  <li>Set a CORS-enabled RPC URL (and headers if required).</li>
                  <li>Generate the auto wallet and fund it with SOL.</li>
                  <li>Set a Recipient to receive funds on End & Return.</li>
                  <li>Tune Buy %, Min/Max Buy, Slippage.</li>
                  <li>Click Start. Bot ticks every 5s and respects the cooldown.</li>
                </ol>
              </div>
              <div>
                <strong>Sizing & reserves</strong>
                <ul style="margin:6px 0 0 18px;">
                  <li>Buy size = min(affordable, carry + desired). A small fee reserve is kept.</li>
                  <li>If size is below router min, it carries over until large enough.</li>
                </ul>
              </div>
              <div>
                <strong>Safety</strong>
                <ul style="margin:6px 0 0 18px;">
                  <li>Optional TP/SL selling is paused when “Leader” hold is on.</li>
                  <li>Owner scans may be disabled by your RPC plan; the bot adapts.</li>
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
                <strong>Support development</strong>
                <p style="margin:6px 0 0 0;">
                  If you find this tool useful, consider supporting its development:
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

  // TODO: add more UI for advanced settings export/import
  // const secretBtn = wrap.querySelector("[data-auto-secret]");
  // const secretModalEl = wrap.querySelector("[data-auto-secret-modal]");
  // const secretCloseEls = wrap.querySelectorAll("[data-auto-secret-close]");
  // const secPubEl = wrap.querySelector("[data-auto-sec-pub]");
  // const secSkEl = wrap.querySelector("[data-auto-sec-skey]");
  // const secToggleEl = wrap.querySelector("[data-auto-sec-toggle]");
  // const secCopyPubBtn = wrap.querySelector("[data-auto-sec-copy-pub]");
  // const secCopySkBtn = wrap.querySelector("[data-auto-sec-copy-skey]");
  const secExportBtn = wrap.querySelector("[data-auto-sec-export]");
  const rpcEl = wrap.querySelector("[data-auto-rpc]");
  const rpchEl = wrap.querySelector("[data-auto-rpch]");
  const copyLogBtn = wrap.querySelector("[data-auto-log-copy]");

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

  // secretBtn.addEventListener("click", async () => {
  //   try {
  //     await ensureAutoWallet();
  //     depAddrEl.value = state.autoWalletPub || depAddrEl.value;
  //     secPubEl.value = state.autoWalletPub || "";
  //     secSkEl.type = "password";
  //     secSkEl.value = state.autoWalletSecret || "";
  //     secretModalEl.style.display = "flex";
  //   } catch (e) {
  //     log(`Cannot open secret modal: ${e.message || e}`);
  //   }
  // });
  // secretModalEl.addEventListener("click", (e) => { if (e.target === secretModalEl) secretModalEl.style.display = "none"; });
  // secretCloseEls.forEach(btn => btn.addEventListener("click", () => { secretModalEl.style.display = "none"; }));
  // document.addEventListener("keydown", (e) => {
  //   if (e.key === "Escape" && secretModalEl.style.display !== "none") secretModalEl.style.display = "none";
  // });
  // secToggleEl.addEventListener("click", () => {
  //   const showing = secSkEl.type === "text";
  //   secSkEl.type = showing ? "password" : "text";
  //   secToggleEl.textContent = showing ? "Show" : "Hide";
  // });
  // secCopyPubBtn.addEventListener("click", async () => {
  //   try { await navigator.clipboard.writeText(secPubEl.value || ""); log("Public key copied"); } catch {}
  // });
  // secCopySkBtn.addEventListener("click", async () => {
  //   try { await navigator.clipboard.writeText(secSkEl.value || ""); log("Secret key copied"); } catch {}
  // });
  if (copyLogBtn) {
    copyLogBtn.addEventListener("click", (e) => { e.preventDefault(); e.stopPropagation(); copyLog(); });
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

  toggleEl.addEventListener("change", () => onToggle(toggleEl.checked));
  holdEl.addEventListener("change", () => {
    state.holdUntilLeaderSwitch = !!holdEl.checked;
    save();
    log(`Hold-until-leader: ${state.holdUntilLeaderSwitch ? "ON" : "OFF"}`);
  });
  startBtn.addEventListener("click", () => onToggle(true));
  stopBtn.addEventListener("click", () => onToggle(false));
  wrap.querySelector("[data-auto-reset]").addEventListener("click", () => {
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

  toggleEl.checked = !!state.enabled;
  holdEl.checked = !!state.holdUntilLeaderSwitch;
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

function isPlanUpgradeError(e) {
  const s = String(e?.message || e || "");
  return /403/.test(s) || /-32602/.test(s) || /plan upgrade/i.test(s);
}
function disableOwnerScans(reason) {
  if (state.ownerScanDisabled) return;
  state.ownerScanDisabled = true;
  state.ownerScanDisabledReason = String(reason || "RPC forbids owner scans");
  save();
  log("Owner scans disabled. RPC blocks account-owner queries. Update RPC URL or upgrade your plan.");
}