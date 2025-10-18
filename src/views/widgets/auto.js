import { FDV_FEE_RECEIVER } from "../../config/env.js";
import { computePumpingLeaders } from "../meme/addons/pumping.js";



const SOL_MINT = "So11111111111111111111111111111111111111112";
// Minimum SOL-in to avoid Jupiter 400s on tiny swaps 
const MIN_JUP_SOL_IN = 0.00005;

// Dynamic fee reserve for small balances
const FEE_RESERVE_MIN = 0.0002;   // rent
const FEE_RESERVE_PCT = 0.10;     // or 10% of balance


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
  slippageBps: 50,
  holdingsUi: 0,
  avgEntryUsd: 0,
  lastTradeTs: 0,

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
  // collapse state for <details>
  collapsed: true,
  // hold until new leader detected
  holdUntilLeaderSwitch: true,
};
let timer = null;
let logEl, toggleEl, startBtn, stopBtn, mintEl;
let depAddrEl, depBalEl, lifeEl, recvEl, buyPctEl, minBuyEl, maxBuyEl;


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
async function loadSplToken() {
  if (window.splToken) return window.splToken;
  try {
    const m = await import("https://esm.sh/@solana/spl-token@0.4.6?bundle");
    window.splToken = m;
    return m;
  } catch {
    // minimal fallback constants for ATA derivation (stable program IDs)
    const { PublicKey } = await loadWeb3();
    const TOKEN_PROGRAM_ID = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
    const ASSOCIATED_TOKEN_PROGRAM_ID = new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
    async function getAssociatedTokenAddress(mint, owner, allowOwnerOffCurve = false, programId = TOKEN_PROGRAM_ID, associatedTokenProgramId = ASSOCIATED_TOKEN_PROGRAM_ID) {
      const seeds = [
        owner.toBuffer(),
        programId.toBuffer(),
        mint.toBuffer(),
      ];
      const [addr] = await (await loadWeb3()).PublicKey.findProgramAddress(seeds, associatedTokenProgramId);
      return addr;
    }
    const m = { TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID, getAssociatedTokenAddress };
    window.splToken = m;
    return m;
  }
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
  _conn = new Connection(url, { commitment: "processed", httpHeaders: headers });
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

function now() { return Date.now(); }

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
  log(`JUP fetch: ${opts?.method || "GET"} ${url}`);
  const res = await fetch(url, {
    headers: { accept: "application/json", ...(opts?.headers||{}) },
    ...opts,
  });
  log(`JUP resp: ${res.status} ${url}`);
  return res;
}

async function quoteOutSol(inputMint, amountUi, inDecimals) {
  // NaN issue patch bug fix
  if (!Number.isFinite(amountUi) || amountUi <= 0) {
    log("Valuation skip: zero size.");
    return 0;
  }
  const dec = Number.isFinite(inDecimals) ? inDecimals : await getMintDecimals(inputMint);
  const raw = Math.max(1, Math.floor(amountUi * Math.pow(10, dec)));
  const q = new URL("/swap/v1/quote", "https://fdv.lol");
  q.searchParams.set("inputMint", inputMint);
  q.searchParams.set("outputMint", "So11111111111111111111111111111111111111112");
  q.searchParams.set("amount", String(raw));
  q.searchParams.set("slippageBps", String(state.slippageBps));
  q.searchParams.set("restrictIntermediateTokens", "true");
  logObj("Valuation quote params", { inputMint, amountUi, dec });
  const res = await jupFetch(q.pathname + q.search);
  if (!res.ok) throw new Error(`quote ${res.status}`);
  const data = await res.json();
  const outRaw = Number(data?.outAmount || 0);
  log(`Valuation: ~${(outRaw/1e9).toFixed(6)} SOL`);
  return outRaw > 0 ? outRaw / 1e9 : 0;
}

async function jupSwapWithKeypair({ signer, inputMint, outputMint, amountUi, slippageBps }) {
  const { PublicKey, VersionedTransaction } = await loadWeb3();
  const conn = await getConn();

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
  const amountRaw = Math.max(1, Math.floor(amountUi * Math.pow(10, inDecimals)));
  const q = new URL("/swap/v1/quote", "https://fdv.lol");
  q.searchParams.set("inputMint", inputMint);
  q.searchParams.set("outputMint", outputMint);
  q.searchParams.set("amount", String(amountRaw));
  q.searchParams.set("slippageBps", String(slippageBps));
  q.searchParams.set("restrictIntermediateTokens", "true");
  if (feeAccount && feeBps > 0) q.searchParams.set("platformFeeBps", String(feeBps)); // align with swap.js

  logObj("Quote params", {
    inputMint, outputMint, amountUi, inDecimals, slippageBps,
    feeBps: feeAccount ? feeBps : 0
  });

  const qRes = await jupFetch(q.pathname + q.search);
  if (!qRes.ok) throw new Error(`quote ${qRes.status}`);
  const quote = await qRes.json();
  logObj("Quote", { inAmount: quote?.inAmount, outAmount: quote?.outAmount, routePlanLen: quote?.routePlan?.length });

  async function buildAndSend(useSharedAccounts = true) {
    const body = {
      quoteResponse: quote,
      userPublicKey: new PublicKey(signer.publicKey).toBase58(),
      wrapAndUnwrapSol: true,
      dynamicComputeUnitLimit: true,
      useSharedAccounts: !!useSharedAccounts,
      asLegacyTransaction: false,
      ...(feeAccount ? { feeAccount } : {}),
      ...(slippageBps != null ? { dynamicSlippage: { maxBps: slippageBps } } : {}),
    };
    logObj("Swap body", { hasFee: !!feeAccount, feeBps: feeAccount ? feeBps : 0, useSharedAccounts: !!useSharedAccounts });

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
      } catch {}
      return { ok: false, code: "SEND_FAIL", msg: e.message || String(e) };
    }
  }
  const first = await buildAndSend(true);
  if (first.ok) return first.sig;
  if (first.code === "NOT_SUPPORTED") {
    log("Retrying without shared accounts …");
    const second = await buildAndSend(false);
    if (second.ok) return second.sig;
    throw new Error(second.msg || "swap failed");
  }
  throw new Error(first.msg || "swap failed");
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
  state.endAt = 0;
  save();
}

function pickTopPumper() {
  try {
    const top = computePumpingLeaders(1);
    const mint = top?.[0]?.mint;
    return mint || "";
  } catch { return ""; }
}

async function getOwnerAta(ownerPubkeyStr, mintStr) {
  const { PublicKey } = await loadWeb3();
  const { getAssociatedTokenAddress } = await loadSplToken();
  const owner = new PublicKey(ownerPubkeyStr);
  const mint = new PublicKey(mintStr);
  return await getAssociatedTokenAddress(mint, owner, true);
}

async function getAtaBalanceUi(ownerPubkeyStr, mintStr, decimalsHint) {
  const conn = await getConn();
  const ata = await getOwnerAta(ownerPubkeyStr, mintStr);
  // Try lightweight balance RPC; if account missing, it's zero
  const res = await conn.getTokenAccountBalance(ata).catch(() => null);
  if (res?.value) {
    return {
      sizeUi: Number(res.value.uiAmount || 0),
      decimals: Number.isFinite(res.value.decimals) ? res.value.decimals : (await getMintDecimals(mintStr)),
      exists: true,
    };
  }
  const ai = await conn.getAccountInfo(ata, "processed").catch(() => null);
  if (!ai) {
    return {
      sizeUi: 0,
      decimals: Number.isFinite(decimalsHint) ? decimalsHint : (await getMintDecimals(mintStr)),
      exists: false,
    };
  }
  return {
    sizeUi: 0,
    decimals: Number.isFinite(decimalsHint) ? decimalsHint : (await getMintDecimals(mintStr)),
    exists: true,
  };
}

async function listOwnerSplPositions(ownerPubkeyStr) {
  if (state.ownerScanDisabled) return [];
  const { PublicKey } = await loadWeb3();
  const { TOKEN_PROGRAM_ID } = await loadSplToken();
  const conn = await getConn();
  const b64ToBytes = (b64) => {
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  };
  const readU64LE = (bytes, offset) => {
    let x = 0n;
    for (let i = 0; i < 8; i++) x |= BigInt(bytes[offset + i]) << (8n * BigInt(i));
    return x;
  };
  const parseTokenAccount = (u8) => {
    const mintBytes = u8.slice(0, 32);
    const amount = readU64LE(u8, 64);
    return { mintBytes, amount };
  };
  const bytesToBase58 = async (u8) => {
    const { bs58 } = await loadDeps();
    return bs58.default.encode(u8);
  };

  const out = [];

  try {
    const resp = await conn.getParsedTokenAccountsByOwner(
      new PublicKey(ownerPubkeyStr),
      { programId: TOKEN_PROGRAM_ID },
      "processed"
    );
    for (const it of resp?.value || []) {
      try {
        const info = it?.account?.data?.parsed?.info;
        const mint = String(info?.mint || "");
        if (!mint || mint === SOL_MINT) continue;
        const ta = info?.tokenAmount;
        const ui = Number(ta?.uiAmount || 0);
        const dec = Number(ta?.decimals);
        if (ui > 0) out.push({ mint, sizeUi: ui, decimals: Number.isFinite(dec) ? dec : 6 });
      } catch {}
    }
    return out;
  } catch (e) {
    if (isPlanUpgradeError(e)) { disableOwnerScans(e.message || e); return []; }
    // Fall through to base64 path only for non-plan-limit errors
    log(`Parsed owner scan error, trying raw decode: ${e.message || e}`);
  }
  try {
    const resp = await conn.getTokenAccountsByOwner(
      new PublicKey(ownerPubkeyStr),
      { programId: TOKEN_PROGRAM_ID },
      "processed"
    );
    const decCache = new Map();
    for (const it of resp?.value || []) {
      try {
        const data = it?.account?.data?.[0]; // base64
        if (!data) continue;
        const u8 = b64ToBytes(data);
        const { mintBytes, amount } = parseTokenAccount(u8);
        const mint = await bytesToBase58(mintBytes);
        if (!mint || mint === SOL_MINT) continue;
        if (amount === 0n) continue;
        let dec = decCache.get(mint);
        if (!Number.isFinite(dec)) {
          dec = await getMintDecimals(mint);
          decCache.set(mint, dec);
        }
        const ui = Number(amount) / Math.pow(10, dec);
        if (ui > 0) out.push({ mint, sizeUi: ui, decimals: dec });
      } catch {}
    }
  } catch (e) {
    if (isPlanUpgradeError(e)) { disableOwnerScans(e.message || e); return []; }
    log(`Fallback owner scan error: ${e.message || e}`);
  }
  return out;
}

async function syncPositionsFromChain(ownerPubkeyStr) {
  try {
    log("Syncing positions from chain (ATAs) …");
    const nowTs = now();
    if (!state.ownerScanDisabled) {
      const scanned = await listOwnerSplPositions(ownerPubkeyStr);
      const seen = new Set(scanned.map(x => x.mint));
      // up-sert balances from scan
      for (const { mint, sizeUi, decimals } of scanned) {
        const prev = state.positions[mint] || { costSol: 0, hwmSol: 0, acquiredAt: nowTs };
        state.positions[mint] = {
          ...prev,
          sizeUi: Number(sizeUi || 0),
          decimals: Number.isFinite(decimals) ? decimals : prev.decimals ?? 6,
          lastSeenAt: nowTs,
        };
      }
      for (const mint of Object.keys(state.positions || {})) {
        if (mint === SOL_MINT) continue;
        if (seen.has(mint)) continue;
        try {
          const b = await getAtaBalanceUi(ownerPubkeyStr, mint, state.positions[mint]?.decimals);
          const amt = Number(b.sizeUi || 0);
          if (amt <= 0) {
            delete state.positions[mint];
          } else {
            state.positions[mint] = {
              ...state.positions[mint],
              sizeUi: amt,
              decimals: b.decimals,
              lastSeenAt: nowTs,
            };
          }
        } catch {}
      }
    } else {
      for (const mint of Object.keys(state.positions || {})) {
        if (mint === SOL_MINT) continue;
        try {
          const b = await getAtaBalanceUi(ownerPubkeyStr, mint, state.positions[mint]?.decimals);
          const amt = Number(b.sizeUi || 0);
          if (amt <= 0) {
            delete state.positions[mint];
          } else {
            state.positions[mint] = {
              ...state.positions[mint],
              sizeUi: amt,
              decimals: b.decimals,
              lastSeenAt: nowTs,
            };
          }
        } catch {}
      }
    }
    save();
  } catch (e) {
    log(`Sync failed: ${e.message || e}`);
  }
}
async function sweepNonSolToSolAtStart() {
  const kp = await getAutoKeypair();
  if (!kp) {
    log("Auto wallet not ready; skipping startup sweep.");
    return;
  }
  log("Startup sweep: checking for non-SOL balances …");
  const tracked = Object.entries(state.positions || {})
    .filter(([m, p]) => m !== SOL_MINT && Number(p?.sizeUi || 0) > 0)
    .map(([mint, p]) => ({ mint, sizeUi: Number(p.sizeUi), decimals: Number(p.decimals || 6) }));
  const scanned = state.ownerScanDisabled ? [] : await listOwnerSplPositions(kp.publicKey.toBase58()).catch(()=>[]);
  const byMint = new Map();
  for (const p of tracked) byMint.set(p.mint, p);
  for (const p of scanned) byMint.set(p.mint, p);
  const items = Array.from(byMint.values());
  if (!items.length) {
    log("Startup sweep: no SPL balances to sell.");
    return;
  }
  let sold = 0;
  for (const { mint, sizeUi, decimals } of items) {
    try {
      // try to skip dust that wont hitr the route....
      const estSol = await quoteOutSol(mint, sizeUi, decimals).catch(() => 0);
      if (estSol < MIN_JUP_SOL_IN) {
        log(`Skip ${mint.slice(0,4)}… (est ${estSol.toFixed(6)} SOL < ${MIN_JUP_SOL_IN}).`);
        continue;
      }
      await jupSwapWithKeypair({
        signer: kp,
        inputMint: mint,
        outputMint: SOL_MINT,
        amountUi: sizeUi,
        slippageBps: state.slippageBps,
      });
      log(`Startup sweep sold ${sizeUi.toFixed(6)} ${mint.slice(0,4)}… -> ~${estSol.toFixed(6)} SOL`);
      if (state.positions[mint]) {
        delete state.positions[mint];
        save();
      }
      sold++;
      await new Promise(r => setTimeout(r, 250));
    } catch (e) {
      log(`Startup sweep sell failed ${mint.slice(0,4)}…: ${e.message || e}`);
    }
  }
  log(`Startup sweep complete. Sold ${sold} token${sold===1?"":"s"}.`);
  if (sold > 0) {
    state.lastTradeTs = now();
    save();
  }
}




// TODO: refine sell logic with more parameters and further include KPI addons.

function shouldSell(pos, curSol) {
  const cost = Number(pos.costSol || 0);
  if (!Number.isFinite(curSol) || curSol <= 0) return { sell: false };
  // Initialize HWM
  const hwm = pos.hwmSol = Math.max(Number(pos.hwmSol || 0), curSol);
  if (cost <= 0) return { sell: false }; // unknown basis; wait for a buy to set it
  const pnlPct = ((curSol - cost) / Math.max(1e-9, cost)) * 100;
  const tp = Number(state.takeProfitPct || 0);
  const sl = Number(state.stopLossPct || 0);
  // Hard stop-loss
  if (pnlPct <= -sl) return { sell: true, reason: `Stop ${pnlPct.toFixed(2)}%` };
  // Hard take-profit
  if (pnlPct >= tp) return { sell: true, reason: `TP ${pnlPct.toFixed(2)}%` };
  // Trailing stop after any profit: drawdown from high >= sl
  if (hwm > cost) {
    const drawdownPct = ((hwm - curSol) / hwm) * 100;
    if (drawdownPct >= sl) return { sell: true, reason: `Trail -${drawdownPct.toFixed(2)}% from high` };
  }
  return { sell: false };
}




let _inFlight = false;
async function evalAndMaybeSellPositions() {
  if (stat.holdUntilLeaderSwitch) return;
  if (_inFlight) return;
  const kp = await getAutoKeypair();
  if (!kp) return;
  await syncPositionsFromChain(kp.publicKey.toBase58());
  const entries = Object.entries(state.positions || {});
  if (!entries.length) return;
  for (const [mint, pos] of entries) {
    try {
      const sz = Number(pos.sizeUi || 0);
      if (sz <= 0) {
        log(`Skip sell eval for ${mint.slice(0,4)}… (no size)`);
        continue;
      }
      log(`Evaluating sell for ${mint.slice(0,4)}… size ${sz.toFixed(6)}`);
      const curSol = await quoteOutSol(mint, sz, pos.decimals);
      pos.hwmSol = Math.max(Number(pos.hwmSol || 0), curSol);
      const d = shouldSell(pos, curSol);
      log(`Sell decision: ${d.sell ? "YES" : "NO"} (${d.reason || "criteria not met"})`);
      if (!d.sell) continue;
      _inFlight = true;
      await jupSwapWithKeypair({
        signer: kp,
        inputMint: mint,
        outputMint: "So11111111111111111111111111111111111111112",
        amountUi: pos.sizeUi,
        slippageBps: state.slippageBps,
      });
      log(`Sold ${pos.sizeUi.toFixed(6)} ${mint.slice(0,4)}… -> ${curSol.toFixed(4)} SOL (${d.reason})`);
      delete state.positions[mint];
      save();
      _inFlight = false;
      state.lastTradeTs = now();
      return;
    } catch (e) {
      log(`Sell check failed for ${mint.slice(0,4)}…: ${e.message||e}`);
    } finally {
      _inFlight = false;
    }
  }
}

let _switchingLeader = false;
async function switchToLeader(newMint) {
   const prev = state.currentLeaderMint || "";
  if (!newMint || newMint === prev) return false;
  if (_switchingLeader) return false;
  const kp = await getAutoKeypair();
  if (!kp) return false;
  _switchingLeader = true;
  try {
    log(`Leader changed: ${prev ? prev.slice(0,4) + "…" : "(none)"} -> ${newMint.slice(0,4)}…`);
    await syncPositionsFromChain(kp.publicKey.toBase58());
    const mints = Object.keys(state.positions || {}).filter(m => m !== SOL_MINT && m !== newMint);
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
        await jupSwapWithKeypair({
          signer: kp,
          inputMint: mint,
          outputMint: SOL_MINT,
          amountUi: uiAmt,
          slippageBps: state.slippageBps,
        });
        log(`Rotated out: ${uiAmt.toFixed(6)} ${mint.slice(0,4)}… -> SOL`);
        delete state.positions[mint];
        save();
        rotated++;
      } catch (e) {
        log(`Rotate sell failed ${mint.slice(0,4)}…: ${e.message || e}`);
      }
    }
    log(`Rotation complete. Sold ${rotated} tokens.`);
    state.currentLeaderMint = newMint;
    save();
    if (rotated > 0) {
      // cooldown after rotation sells
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

  const leaderMint = pickTopPumper();

  if (!leaderMint) return;

  log(`Top pumper: ${leaderMint.slice(0,4)}…`);

  const didRotate = await switchToLeader(leaderMint);

  if (didRotate) return; // wait until next tick

  if (state.lastTradeTs && (now() - state.lastTradeTs)/1000 < state.minSecsBetween) return;

  try {
    const kp = await getAutoKeypair();
    if (!kp) return;

    await syncPositionsFromChain(kp.publicKey.toBase58());

    const cur = state.positions[leaderMint];
    const alreadyHoldingLeader =
      Number(cur?.sizeUi || 0) > 0 || Number(cur?.costSol || 0) > 0;

    if (state.holdUntilLeaderSwitch && alreadyHoldingLeader) {
      log("Holding current leader. No additional buys.");
      return;
    }

    const solBal = await fetchSolBalance(kp.publicKey.toBase58());
    const feeReserve = Math.max(FEE_RESERVE_MIN, solBal * FEE_RESERVE_PCT);
    const affordable = Math.max(0, solBal - feeReserve);
    const desired = Math.min(state.maxBuySol, Math.max(state.minBuySol, solBal * state.buyPct));
    const minThreshold = Math.max(state.minBuySol, MIN_JUP_SOL_IN);
    let planned = Math.min(affordable, state.carrySol + desired);
    logObj("Buy sizing", {
      solBal: Number(solBal).toFixed(6),
      feeReserve,
      affordable,
      desired,
      carry: state.carrySol,
      planned,
      minThreshold
    });
    if (planned < minThreshold) {
      state.carrySol += desired;
      save();
      log(`Accumulating. Carry=${state.carrySol.toFixed(6)} SOL (< ${minThreshold} min).`);
      return;
    }
    const buySol = planned;

    if (desired < minThreshold * 0.1) {
      log(`Buy % very small at ${(state.buyPct*100).toFixed(3)}%. Increase or lower Min Buy.`);
    }

    await jupSwapWithKeypair({
      signer: kp,
      inputMint: "So11111111111111111111111111111111111111112",
      outputMint: leaderMint,
      amountUi: buySol,
      slippageBps: state.slippageBps,
    });

    state.carrySol = Math.max(0, state.carrySol + desired - buySol);




    const pos = state.positions[leaderMint] || { costSol: 0, hwmSol: 0, acquiredAt: now() };
    pos.costSol = Number(pos.costSol || 0) + buySol;
    pos.hwmSol = Math.max(Number(pos.hwmSol || 0), buySol);
    try {
      const bal = await getAtaBalanceUi(kp.publicKey.toBase58(), leaderMint, pos.decimals);
      pos.sizeUi = Number(bal.sizeUi || 0);
      pos.decimals = Number.isFinite(bal.decimals) ? bal.decimals : (pos.decimals ?? await getMintDecimals(leaderMint));
      pos.lastSeenAt = now();
    } catch {
      log("Failed to refresh position size after buy.");
    }
    state.positions[leaderMint] = pos;
    save();

    log(`Bought ~${buySol.toFixed(4)} SOL -> ${leaderMint.slice(0,4)}…`);
    state.lastTradeTs = now();
    save();
  } catch (e) {
    log(`Buy failed: ${e.message||e}`);
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
      <span class="fdv-title">Auto Pump (v0.0.1)</span>
    </span>
  `;

  const body = document.createElement("div");
  body.className = "fdv-auto-body";
  body.innerHTML = `
    <div class="fdv-auto-head">
      <label class="fdv-switch">
        <input type="checkbox" data-auto-toggle />
        <span>Enabled</span>
      </label>
    </div>
    <div style="display:flex;align-items:center;gap:8px;border-bottom:1px solid var(--fdv-border);padding-bottom:8px;margin-bottom:8px;">
        <button data-auto-gen>Generate Wallet</button>
        <button data-auto-copy>Copy Address</button>
        <button data-auto-unwind>End & Return</button>
    </div>
    <div class="fdv-grid">
      <label><a href="https://chainstack.com/" target="_blank">RPC (CORS)</a> <input data-auto-rpc placeholder="https://your-provider.example/solana?api-key=..."/></label>
      <label>RPC Headers (JSON) <input data-auto-rpch placeholder='{"Authorization":"Bearer ..."}'/></label>
      <label>Auto Wallet <input data-auto-dep readonly placeholder="Generate to get address"/></label>
      <label>Deposit Balance <input data-auto-bal readonly/></label>
      <label>Recipient (SOL) <input data-auto-recv placeholder="Your wallet address"/></label>
      <label>Lifetime (mins) <input data-auto-life type="number" step="1"/></label>
      <label>Buy % of SOL <input data-auto-buyp type="number" step="0.1"/></label>
      <label>Min Buy (SOL) <input data-auto-minbuy type="number" step="0.0001"/></label>
      <label>Max Buy (SOL) <input data-auto-maxbuy type="number" step="0.0001"/></label>
    </div>
    <div class="fdv-log" data-auto-log></div>
    <div class="fdv-actions">
      <button data-auto-start>Start</button>
      <button data-auto-stop>Stop</button>
      <button data-auto-reset>Reset</button>
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
  startBtn  = wrap.querySelector("[data-auto-start]");
  stopBtn   = wrap.querySelector("[data-auto-stop]");
  mintEl    = { value: "" }; // not used in auto-wallet mode

  const rpcEl = wrap.querySelector("[data-auto-rpc]");
  const rpchEl = wrap.querySelector("[data-auto-rpch]");
  depAddrEl = wrap.querySelector("[data-auto-dep]");
  depBalEl  = wrap.querySelector("[data-auto-bal]");
  recvEl    = wrap.querySelector("[data-auto-recv]");
  lifeEl    = wrap.querySelector("[data-auto-life]");
  buyPctEl  = wrap.querySelector("[data-auto-buyp]");
  minBuyEl  = wrap.querySelector("[data-auto-minbuy]");
  maxBuyEl  = wrap.querySelector("[data-auto-maxbuy]");

  rpcEl.value   = currentRpcUrl();
  try { rpchEl.value = JSON.stringify(currentRpcHeaders() || {}); } catch { rpchEl.value = "{}"; }
  depAddrEl.value = state.autoWalletPub || "";
  recvEl.value    = state.recipientPub || "";
  lifeEl.value    = state.lifetimeMins;
  buyPctEl.value  = (state.buyPct * 100).toFixed(2);
  minBuyEl.value  = state.minBuySol;
  maxBuyEl.value  = state.maxBuySol;

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
    try { await sweepAllToSolAndReturn(); } catch(e){ log(`Unwind failed: ${e.message||e}`); }
  });

  toggleEl.addEventListener("change", () => onToggle(toggleEl.checked));
  startBtn.addEventListener("click", () => onToggle(true));
  stopBtn.addEventListener("click", () => onToggle(false));
  wrap.querySelector("[data-auto-reset]").addEventListener("click", () => {
    state.holdingsUi = 0;
    state.avgEntryUsd = 0;
    state.lastTradeTs = 0;
    state.endAt = 0;
    save();
    log("Session stats reset");
  });

  const saveField = () => {
    state.recipientPub  = recvEl.value.trim();
    state.lifetimeMins  = parseInt(lifeEl.value || "0", 10);
    state.buyPct        = Math.max(0, normalizePercent(buyPctEl.value));
    state.minBuySol     = Math.max(0, Number(minBuyEl.value));
    state.maxBuySol     = Math.max(0, Number(maxBuyEl.value));
    save();
  };
  [recvEl, lifeEl, buyPctEl, minBuyEl, maxBuyEl].forEach(el => {
    el.addEventListener("input", saveField);
    el.addEventListener("change", saveField);
  });

  toggleEl.checked = !!state.enabled;
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