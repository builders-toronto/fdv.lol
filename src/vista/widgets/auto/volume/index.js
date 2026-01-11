import { createDex } from '../lib/dex.js';
import { setBotRunning } from '../lib/autoLed.js';
import {
  SOL_MINT,
  FEE_RESERVE_MIN,
  TX_FEE_BUFFER_LAMPORTS,
  MIN_SELL_CHUNK_SOL,
  SMALL_SELL_FEE_FLOOR,
  EDGE_TX_FEE_ESTIMATE_LAMPORTS,
  MIN_QUOTE_RAW_AMOUNT,
  MAX_CONSEC_SWAP_400,
  ROUTER_COOLDOWN_MS,
  MINT_RUG_BLACKLIST_MS,
  SPLIT_FRACTIONS,
  FEE_ATAS,
  AUTO_CFG,
} from '../lib/constants.js';
import { rpcWait, rpcBackoffLeft, markRpcStress } from '../lib/rpcThrottle.js';
import { loadSplToken } from '../../../../core/solana/splToken.js';
import { createSolanaDepsLoader } from '../lib/solana/deps.js';
import { createConnectionGetter } from '../lib/solana/connection.js';
import { createConfirmSig } from '../lib/solana/confirm.js';
import { delay } from '../lib/async.js';
import { isNodeLike } from '../lib/runtime.js';

const { loadWeb3, loadBs58 } = createSolanaDepsLoader({
  cacheKeyPrefix: 'fdv:volume',
  web3Version: '1.95.4',
  bs58Version: '6.0.0',
});

export { loadWeb3 };

async function getBs58() {
  return await loadBs58();
}

function currentRpcUrl() {
  const fromState = (state && state.rpcUrl) ? String(state.rpcUrl) : '';
  const fromLs = (typeof localStorage !== 'undefined') ? String(localStorage.getItem('fdv_rpc_url') || '') : '';
  const url = (fromState || fromLs || 'https://api.mainnet-beta.solana.com').trim();
  return url;
}

function currentRpcHeaders() {
  const h = (state && state.rpcHeaders) ? state.rpcHeaders : null;
  if (h && typeof h === 'object') return h;
  try {
    const raw = (typeof localStorage !== 'undefined') ? localStorage.getItem('fdv_rpc_headers') : null;
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

const getConn = createConnectionGetter({
  loadWeb3,
  getRpcUrl: currentRpcUrl,
  getRpcHeaders: currentRpcHeaders,
  commitment: 'confirmed',
});

const confirmSig = createConfirmSig({
  getConn,
  markRpcStress,
  defaultCommitment: 'confirmed',
  defaultTimeoutMs: 20_000,
  throwOnTimeout: true,
});

async function fetchSolBalance(pubkeyOrStr) {
  const { PublicKey } = await loadWeb3();
  const conn = await getConn();
  const pk = typeof pubkeyOrStr === 'string' ? new PublicKey(pubkeyOrStr) : pubkeyOrStr;
  const lam = await conn.getBalance(pk, 'processed');
  return lam / 1e9;
}

const AUTO_LS_KEY = 'fdv_auto_bot_v1';

function _readAutoStateRaw() {
  try {
    return (typeof localStorage !== 'undefined') ? localStorage.getItem(AUTO_LS_KEY) : null;
  } catch {
    return null;
  }
}

function _writeAutoStateRaw(obj) {
  try {
    if (typeof localStorage === 'undefined') return false;
    localStorage.setItem(AUTO_LS_KEY, JSON.stringify(obj || {}));
    return true;
  } catch {
    return false;
  }
}

function getExistingAutoWalletMeta() {
  try {
    const raw = _readAutoStateRaw();
    const parsed = raw ? (JSON.parse(raw) || {}) : {};
    const keys = Object.keys(parsed || {});
    const importantKeys = ['autoWalletPub', 'autoWalletSecret', 'secretKeyB58', 'secretKey', 'sk', 'secretKeyBytes', 'secretKeyArray'];
    const hasImportant = new Set(importantKeys.filter((k) => k in (parsed || {})));
    return {
      hasSecret:
        !!String(parsed?.autoWalletSecret || parsed?.secretKeyB58 || parsed?.secretKey || parsed?.sk || '').trim() ||
        Array.isArray(parsed?.secretKeyBytes) ||
        Array.isArray(parsed?.secretKeyArray),
      autoWalletPub: String(parsed?.autoWalletPub || '').trim(),
      keys: [...Array.from(hasImportant), ...keys.filter((k) => !hasImportant.has(k)).slice(0, 40)],
      rawLen: typeof raw === 'string' ? raw.length : 0,
    };
  } catch {
    return { hasSecret: false, autoWalletPub: '', keys: [] };
  }
}

async function debugAutoWalletLoad() {
  try {
    const meta = getExistingAutoWalletMeta();
    log(`Auto wallet cache: rawLen=${meta.rawLen || 0} hasSecret=${!!meta.hasSecret} pub=${meta.autoWalletPub ? meta.autoWalletPub.slice(0, 6) + '…' : '(none)'}`, 'help');
    const raw = _readAutoStateRaw();
    if (!raw) {
      log('Auto wallet cache read: localStorage missing/blocked or key not set.', 'warn');
      return;
    }
    const parsed = JSON.parse(raw) || {};
    const skStr = String(parsed?.autoWalletSecret || parsed?.secretKeyB58 || parsed?.secretKey || parsed?.sk || '').trim();
    if (skStr) {
      log(`Auto wallet secret string present (len=${skStr.length}).`, 'help');
    } else if (Array.isArray(parsed?.secretKeyBytes) || Array.isArray(parsed?.secretKeyArray)) {
      const arr = Array.isArray(parsed?.secretKeyBytes) ? parsed.secretKeyBytes : parsed.secretKeyArray;
      log(`Auto wallet secret array present (len=${Array.isArray(arr) ? arr.length : 0}).`, 'help');
    } else {
      log('Auto wallet secret missing in cache (no autoWalletSecret/secretKeyB58/secretKey/sk).', 'warn');
      return;
    }

    let bs58;
    try {
      bs58 = await getBs58();
    } catch (e) {
      log(`bs58 import failed: ${String(e?.message || e || '')}`, 'error');
      if (e?.stack) log(String(e.stack).split('\n').slice(0, 2).join(' | '), 'help');
      return;
    }

    let Keypair;
    try {
      ({ Keypair } = await loadWeb3());
    } catch (e) {
      log(`@solana/web3.js import failed: ${String(e?.message || e || '')}`, 'error');
      if (e?.stack) log(String(e.stack).split('\n').slice(0, 2).join(' | '), 'help');
      return;
    }

    let secretBytes;
    try {
      if (Array.isArray(parsed?.secretKeyBytes)) secretBytes = Uint8Array.from(parsed.secretKeyBytes);
      else if (Array.isArray(parsed?.secretKeyArray)) secretBytes = Uint8Array.from(parsed.secretKeyArray);
      else secretBytes = bs58.decode(skStr);
    } catch (e) {
      log(`Secret decode failed: ${String(e?.message || e || '')}`, 'error');
      if (e?.stack) log(String(e.stack).split('\n').slice(0, 2).join(' | '), 'help');
      return;
    }

    log(`Decoded secret bytes length=${secretBytes?.length || 0}`, 'help');
    let kp;
    try {
      kp = Keypair.fromSecretKey(secretBytes);
    } catch (e) {
      log(`Keypair.fromSecretKey failed: ${String(e?.message || e || '')}`, 'error');
      if (e?.stack) log(String(e.stack).split('\n').slice(0, 2).join(' | '), 'help');
      return;
    }
    const derivedPub = kp.publicKey.toBase58();
    if (meta.autoWalletPub && derivedPub !== meta.autoWalletPub) {
      log(`Auto wallet pub mismatch: cache pub=${meta.autoWalletPub.slice(0,6)}… derived pub=${derivedPub.slice(0,6)}…`, 'warn');
    } else {
      log(`Auto wallet loaded OK: ${derivedPub.slice(0, 6)}…`, 'ok');
    }
  } catch (e) {
    log(`Auto wallet load debug failed: ${String(e?.message || e || '')}`, 'error');
  }
}

async function getAutoKeypair() {
  try {
    const raw = _readAutoStateRaw();
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    // Support current + legacy shapes.
    let skB58 =
      parsed?.autoWalletSecret ||
      parsed?.secretKeyB58 ||
      parsed?.secretKey ||
      parsed?.sk;

    const bs58 = await getBs58();
    const { Keypair } = await loadWeb3();

    if (Array.isArray(parsed?.secretKeyBytes)) {
      return Keypair.fromSecretKey(Uint8Array.from(parsed.secretKeyBytes));
    }
    if (Array.isArray(parsed?.secretKeyArray)) {
      return Keypair.fromSecretKey(Uint8Array.from(parsed.secretKeyArray));
    }

    if (typeof skB58 === 'string') {
      const s = skB58.trim();
      if (!s) return null;
      if (s.startsWith('[') && s.endsWith(']')) {
        try {
          const arr = JSON.parse(s);
          if (Array.isArray(arr)) return Keypair.fromSecretKey(Uint8Array.from(arr));
        } catch {}
      }
      const secretKey = bs58.decode(s);
      return Keypair.fromSecretKey(secretKey);
    }
    return null;
  } catch {
    return null;
  }
}

async function isValidPubkeyStr(s) {
  try {
    const { PublicKey } = await loadWeb3();
    new PublicKey(String(s));
    return true;
  } catch {
    return false;
  }
}

async function tokenAccountRentLamports() {
  try {
    const conn = await getConn();
    return await conn.getMinimumBalanceForRentExemption(165);
  } catch {
    return 0;
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
    const ata = await getAssociatedTokenAddress(mint, owner, false);
    const ai = await conn.getAccountInfo(ata, 'processed');
    if (ai) return 0;
    return await tokenAccountRentLamports();
  } catch {
    return 0;
  }
}

function getPlatformFeeBps() {
  return 1;
}

function _toBigIntSafe(v) {
  try {
    if (typeof v === 'bigint') return v;
    if (typeof v === 'number' && Number.isFinite(v)) return BigInt(Math.trunc(v));
    const s = String(v ?? '').trim();
    if (!s) return 0n;
    if (/^-?\d+$/.test(s)) return BigInt(s);
    const n = Number(s);
    return Number.isFinite(n) ? BigInt(Math.trunc(n)) : 0n;
  } catch {
    return 0n;
  }
}

async function recordVolumeBuyBasis({ mint, solUi, tokenUi } = {}) {
  try {
    const m = String(mint || '').trim();
    if (!m) return;
    const sol = Number(solUi || 0);
    const tok = Number(tokenUi || 0);
    if (!(sol > 0) || !(tok > 0)) return;

    const dec = await getDex().getMintDecimals(m).catch(() => safeGetDecimalsFast(m));
    const d = Math.max(0, Math.min(12, Number(dec || 0)));
    const scale = Math.pow(10, d);

    const gotRaw = _toBigIntSafe(Math.round(tok * scale));
    const spentLamports = _toBigIntSafe(Math.round(sol * 1e9));
    if (gotRaw <= 0n || spentLamports <= 0n) return;

    state._volumeLastBuyBasis = {
      mint: m,
      spentLamports,
      gotRaw,
      ts: Date.now(),
    };
  } catch {}
}

function shouldAttachFeeForSellVolume({ mint, amountRaw, quoteOutLamports } = {}) {
  try {
    const basis = state?._volumeLastBuyBasis;
    const m = String(mint || '').trim();
    if (!basis || !m || basis.mint !== m) return false;

    const gotRaw = _toBigIntSafe(basis.gotRaw);
    const spentLamports = _toBigIntSafe(basis.spentLamports);
    const amtRaw = _toBigIntSafe(amountRaw);
    const outLamports = _toBigIntSafe(quoteOutLamports);
    if (gotRaw <= 0n || spentLamports <= 0n || amtRaw <= 0n || outLamports <= 0n) return false;

    // Attach fee only when per-token value increased vs the last buy basis.
    // (outLamports / amtRaw) > (spentLamports / gotRaw) * (1 + marginBps/10000)
    const marginBps = 1n; // 0.01% guard against rounding noise
    const lhs = outLamports * gotRaw * 10000n;
    const rhs = spentLamports * amtRaw * (10000n + marginBps);
    return lhs > rhs;
  } catch {
    return false;
  }
}

async function safeGetDecimalsFast(mint) {
  if (!mint) return 6;
  if (mint === SOL_MINT) return 9;
  try {
    const { PublicKey } = await loadWeb3();
    const conn = await getConn();
    const info = await conn.getParsedAccountInfo(new PublicKey(mint), 'processed');
    const d = Number(info?.value?.data?.parsed?.info?.decimals);
    return Number.isFinite(d) ? d : 6;
  } catch {
    return 6;
  }
}

function getCfg() {
  return AUTO_CFG;
}

// Leave a little dust
const RETURN_SOL_MIN_LEFTOVER_LAMPORTS = 100_000; // 0.0001 SOL

async function getTokenBalanceUiByMint(ownerPkOrStr, mintStr) {
  try {
    if (!mintStr || mintStr === SOL_MINT) return 0;
    const ownerStr = typeof ownerPkOrStr === 'string' ? ownerPkOrStr : ownerPkOrStr?.toBase58?.();
    if (!ownerStr) return 0;
    const b = await getDex().getAtaBalanceUi(ownerStr, mintStr, undefined, 'confirmed');
    const ui = Number(b?.sizeUi || 0);
    return Number.isFinite(ui) ? ui : 0;
  } catch {
    return 0;
  }
}

async function feePayerRentMinLamports(pubkey) {
  try {
    const conn = await getConn();
    const ai = await conn.getAccountInfo(pubkey, 'confirmed');
    const dataLen = ai?.data?.length || 0;
    const n = await conn.getMinimumBalanceForRentExemption(dataLen);
    return Number.isFinite(Number(n)) ? Number(n) : 0;
  } catch {
    return 0;
  }
}

async function closeAllEmptyTokenAccountsForOwner(signer) {
  try {
    if (!signer?.publicKey) return false;
    const conn = await getConn();
    const { Transaction } = await loadWeb3();
    const {
      createCloseAccountInstruction,
      TOKEN_PROGRAM_ID,
      TOKEN_2022_PROGRAM_ID,
    } = await loadSplToken();

    const ownerPk = signer.publicKey;
    const programIds = [TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID].filter(Boolean);

    const closeIxs = [];
    for (const programId of programIds) {
      let res;
      try {
        res = await conn.getParsedTokenAccountsByOwner(ownerPk, { programId }, 'processed');
      } catch {
        continue;
      }
      for (const v of res?.value || []) {
        const ata = v?.pubkey;
        const amtStr = String(v?.account?.data?.parsed?.info?.tokenAmount?.amount || '');
        if (!ata) continue;
        if (amtStr !== '0') continue;
        try {
          closeIxs.push(createCloseAccountInstruction(ata, ownerPk, ownerPk, [], programId));
        } catch {}
      }
    }

    if (!closeIxs.length) return false;

    const BATCH = 8;
    const sigs = [];
    for (let i = 0; i < closeIxs.length; i += BATCH) {
      const slice = closeIxs.slice(i, i + BATCH);
      try {
        await rpcWait?.('tx-close', 250);
        const tx = new Transaction();
        for (const ix of slice) tx.add(ix);
        tx.feePayer = ownerPk;
        tx.recentBlockhash = (await conn.getLatestBlockhash('processed')).blockhash;
        tx.sign(signer);
        const sig = await conn.sendRawTransaction(tx.serialize(), { preflightCommitment: 'processed', maxRetries: 2 });
        sigs.push(sig);
        await new Promise((r) => setTimeout(r, 120));
      } catch (e) {
        markRpcStress?.(e, 2000);
        log(`Close-ATAs batch failed: ${String(e?.message || e || '')}`, 'warn');
      }
    }

    if (sigs.length) {
      log(`Closed ${closeIxs.length} empty token account(s) in ${sigs.length} tx(s)`, 'ok');
      return true;
    }
    return false;
  } catch (e) {
    log(`Close-empty-ATAs failed: ${String(e?.message || e || '')}`, 'warn');
    return false;
  }
}

async function sendSol(fromKp, toPubkey, amountSol) {
  const conn = await getConn();
  const { Transaction, SystemProgram, PublicKey } = await loadWeb3();
  const amountLamports = Math.floor(amountSol * 1e9);
  const toPk = typeof toPubkey === 'string' ? new PublicKey(toPubkey) : toPubkey;

  const tx = new Transaction().add(
    SystemProgram.transfer({
      fromPubkey: fromKp.publicKey,
      toPubkey: toPk,
      lamports: amountLamports,
    }),
  );

  const sig = await conn.sendTransaction(tx, [fromKp]);
  await confirmSig(sig);
  return sig;
}

async function sendAllSolBack(fromKp, toPubkey) {
  const conn = await getConn();
  const { Transaction, SystemProgram, PublicKey } = await loadWeb3();
  const toPk = typeof toPubkey === 'string' ? new PublicKey(toPubkey) : toPubkey;

  const balLam = await conn.getBalance(fromKp.publicKey);
  if (!balLam || balLam <= 0) return { sentLamports: 0, sig: null };

  const tx = new Transaction().add(
    SystemProgram.transfer({
      fromPubkey: fromKp.publicKey,
      toPubkey: toPk,
      lamports: 1, // placeholder; set later
    }),
  );

  tx.feePayer = fromKp.publicKey;
  const { blockhash } = await conn.getLatestBlockhash('confirmed');
  tx.recentBlockhash = blockhash;

  let feeLamports = 0;
  try {
    const msg = tx.compileMessage();
    const fee = await conn.getFeeForMessage(msg, 'confirmed');
    feeLamports = Number(fee?.value || 0);
  } catch {
    feeLamports = 0;
  }

  const rentMin = await feePayerRentMinLamports(fromKp.publicKey);
  const bufferLamports = Math.max(Number(TX_FEE_BUFFER_LAMPORTS || 0), 500_000);
  const feeSafety = Math.max(bufferLamports, feeLamports * 2, RETURN_SOL_MIN_LEFTOVER_LAMPORTS);
  const leaveLamports = Math.max(feeSafety, rentMin + feeSafety);

  const sendLam = balLam - leaveLamports;
  if (sendLam <= 0) return { sentLamports: 0, sig: null };

  tx.instructions[0].data = SystemProgram.transfer({
    fromPubkey: fromKp.publicKey,
    toPubkey: toPk,
    lamports: sendLam,
  }).data;

  const sig = await conn.sendTransaction(tx, [fromKp]);
  await confirmSig(sig);
  return { sentLamports: sendLam, sig };
}

async function drainSolBack(fromKp, toPubkey, opts = {}) {
  const conn = await getConn();
  const { Transaction, SystemProgram, PublicKey } = await loadWeb3();
  const toPk = typeof toPubkey === 'string' ? new PublicKey(toPubkey) : toPubkey;

  const baseLeftoverLamports = Math.max(0, Number(opts.minLeftoverLamports ?? 10_000));
  const maxRounds = Math.max(1, Number(opts.maxRounds ?? 3));

  let lastSig = null;
  for (let round = 0; round < maxRounds; round += 1) {
    const balLam = await conn.getBalance(fromKp.publicKey);
    if (!balLam || balLam <= 0) return { sentLamports: 0, sig: lastSig };

    const tx = new Transaction().add(
      SystemProgram.transfer({
        fromPubkey: fromKp.publicKey,
        toPubkey: toPk,
        lamports: 1,
      }),
    );

    tx.feePayer = fromKp.publicKey;
    tx.recentBlockhash = (await conn.getLatestBlockhash('confirmed')).blockhash;

    let feeLamports = 0;
    try {
      const msg = tx.compileMessage();
      const fee = await conn.getFeeForMessage(msg, 'confirmed');
      feeLamports = Number(fee?.value || 0);
    } catch {
      feeLamports = 0;
    }

    const rentMin = await feePayerRentMinLamports(fromKp.publicKey);
    const safetyFeeLamports = Math.max(5_000, Math.floor(feeLamports * 2));
    const feeSafety = Math.max(baseLeftoverLamports, safetyFeeLamports);
    const leaveLamports = Math.max(feeSafety, rentMin + feeSafety);
    const sendLam = balLam - leaveLamports;
    if (sendLam <= 0) return { sentLamports: 0, sig: lastSig };

    tx.instructions[0].data = SystemProgram.transfer({
      fromPubkey: fromKp.publicKey,
      toPubkey: toPk,
      lamports: sendLam,
    }).data;

    lastSig = await conn.sendTransaction(tx, [fromKp]);

    await confirmSig(lastSig);

    const afterLam = await conn.getBalance(fromKp.publicKey);
    if (afterLam <= leaveLamports + 20_000) break;
  }

  return { sentLamports: 0, sig: lastSig };
}

async function drainAllSpendableSolBack(fromKp, toPubkey, opts = {}) {
  const conn = await getConn();

  const { Transaction, SystemProgram, PublicKey } = await loadWeb3();

  const toPk = typeof toPubkey === 'string' ? new PublicKey(toPubkey) : toPubkey;

  const maxAttempts = Math.max(3, Number(opts.maxAttempts ?? 18));

  let minLeftoverLamports = Math.max(2_000, Number(opts.minLeftoverLamports ?? 5_000));

  let lastSig = null;

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {

    const balLam = await conn.getBalance(fromKp.publicKey);

    if (!balLam || balLam <= 0) return { finalLamports: 0, sig: lastSig };

    const rentMin = await feePayerRentMinLamports(fromKp.publicKey);

    let feeLamports = 0;

    try {
      const tx0 = new Transaction().add(
        SystemProgram.transfer({
          fromPubkey: fromKp.publicKey,
          toPubkey: toPk,
          lamports: 1,
        }),
      );
      tx0.feePayer = fromKp.publicKey;

      tx0.recentBlockhash = (await conn.getLatestBlockhash('confirmed')).blockhash;

      const fee = await conn.getFeeForMessage(tx0.compileMessage(), 'confirmed');

      feeLamports = Number(fee?.value || 0);
    } catch {
      feeLamports = 0;
    }

    const feeSafety = Math.max(minLeftoverLamports, Math.floor(feeLamports * 2) + 5_000);

    const leaveLamports = Math.max(rentMin + feeSafety, feeSafety);

    const sendLam = balLam - leaveLamports;

    if (sendLam <= 0) return { finalLamports: balLam, sig: lastSig };

    try {
      const tx = new Transaction().add(
        SystemProgram.transfer({
          fromPubkey: fromKp.publicKey,
          toPubkey: toPk,
          lamports: sendLam,
        }),
      );
      tx.feePayer = fromKp.publicKey;

      tx.recentBlockhash = (await conn.getLatestBlockhash('confirmed')).blockhash;

      lastSig = await conn.sendTransaction(tx, [fromKp]);

      await confirmSig(lastSig, { timeoutMs: 40_000 });

    } catch (e) {

      const msg = String(e?.message || e || '');

      if (/insufficient funds for rent/i.test(msg)) {
        minLeftoverLamports = Math.min(2_000_000, minLeftoverLamports + 100_000);
      } else {
        markRpcStress?.(e, 1500);
      }

      await delay(backoffMs(attempt + 1, 400, 6_000));

      continue;
    }

    const afterLam = await conn.getBalance(fromKp.publicKey);

    if (afterLam <= leaveLamports + 15_000) return { finalLamports: afterLam, sig: lastSig };

    await delay(150);
  }

  const finalLamports = await conn.getBalance(fromKp.publicKey);
  return { finalLamports, sig: lastSig };
}

// Constants
const FEE_RESERVE_SOL = Math.max(0.002, Number(FEE_RESERVE_MIN || 0));
const MAX_LOG_ENTRIES = 100;
const SLIPPAGE_TIERS_BPS = [50, 100, 200, 500, 1000, 2000];

// State
let state = {
  enabled: false,
  mint: "",
  minBuyAmountSol: 0.005,
  maxBuyAmountSol: 0.02,
  sellAmountPct: 100,
  holdTokens: 0,
  // Timing
  holdDelayMs: 2500,
  cycleDelayMs: 3000,

  // Safety
  targetVolumeSol: 0,
  maxSlippageBps: 2000,

  slippageBps: 250,
  rpcUrl: "",
  rpcHeaders: {},
  volumeCreated: 0,
  fundSol: 0.2,

  // Soft-stop once target is reached (lets in-flight cycles finish)
  softStopRequested: false,

  // Multi-bot
  multiBotCount: 1,
  bots: [],

  // Ephemeral: captured only for this page session
  generatedWallets: [], // [{ ts, pubkey, secretKeyB58 }]
};

// Expose generated wallets
function getGeneratedWallets() {
  return Array.isArray(state.generatedWallets) ? state.generatedWallets.slice() : [];
}

function clearGeneratedWallets() {
  state.generatedWallets = [];
}

let logEl, startBtn, stopBtn, mintEl, minBuyEl, maxBuyEl, sellAmountEl, holdEl, intervalEl, botsEl;
let statusEl, rpcEl;
let targetVolEl, maxSlipEl, holdDelayEl;

function clampInt(n, min, max, fallback = min) {
  const v = Math.floor(Number(n));
  if (!Number.isFinite(v)) return fallback;
  return Math.max(min, Math.min(max, v));
}

function haltVolumeBot(msg) {
  try {
    state.enabled = false;
    try { setBotRunning('volume', false); } catch {}
    for (const b of state.bots || []) {
      try {
        b.enabled = false;
        if (b.timer) {
          clearTimeout(b.timer);
          b.timer = null;
        }
      } catch {}
    }
    if (msg) log(msg, 'error');
  } catch {}
  try { updateUI(); } catch {}
}

function log(msg, type = 'info') {
  try {
    const line = `[${new Date().toLocaleTimeString()}] ${String(msg ?? '')}`;
    try {
      const wantConsole = !!(typeof window !== 'undefined' && window._fdvLogToConsole);
      const nodeLike = typeof process !== 'undefined' && !!process?.stdout;
      if ((wantConsole || (nodeLike && !logEl)) && line) {
        const t = String(type || '').toLowerCase();
        if (t.startsWith('err')) console.error(line);
        else if (t.startsWith('war')) console.warn(line);
        else console.log(line);
      }
    } catch {}
  } catch {}
  if (logEl) {
    const div = document.createElement('div');
    const t = String(type || 'info').toLowerCase();
    const cls = t.startsWith('err') ? 'err' : t.startsWith('war') ? 'warn' : t.startsWith('help') ? 'help' : t.startsWith('ok') ? 'ok' : t.startsWith('succ') ? 'ok' : t.startsWith('info') ? 'info' : 'ok';
    div.className = cls;
    div.textContent = `[${new Date().toLocaleTimeString()}] ${msg}`;
    logEl.appendChild(div);
    logEl.scrollTop = logEl.scrollHeight;
    if (logEl.children.length > MAX_LOG_ENTRIES) logEl.removeChild(logEl.firstChild);
  }
  // const consoleMethod = type === 'error' ? console.error : type === 'warn' ? console.warn : console.log;
  // consoleMethod(`[VolumeBot] ${msg}`);
}

function _isNodeLike() {
  return isNodeLike();
}

function _applyRpcOptsToStateAndStorage({ rpcUrl, rpcHeaders } = {}) {
  try {
    if (rpcUrl != null) {
      const u = String(rpcUrl || '').trim();
      state.rpcUrl = u;
      try {
        if (typeof localStorage !== 'undefined') localStorage.setItem('fdv_rpc_url', u);
      } catch {}
    }
    if (rpcHeaders != null) {
      const h = rpcHeaders && typeof rpcHeaders === 'object' ? rpcHeaders : {};
      state.rpcHeaders = h;
      try {
        if (typeof localStorage !== 'undefined') localStorage.setItem('fdv_rpc_headers', JSON.stringify(h));
      } catch {}
    }
  } catch {}
}

export function __fdvCli_applyConfig(cfg = {}) {
  try {
    if (cfg?.mint != null) state.mint = String(cfg.mint || '').trim();
    if (cfg?.bots != null) state.multiBotCount = clampInt(cfg.bots, 1, 10, state.multiBotCount || 1);
    if (cfg?.targetVolumeSol != null) state.targetVolumeSol = Math.max(0, Number(cfg.targetVolumeSol || 0) || 0);
    if (cfg?.maxSlippageBps != null) state.maxSlippageBps = clampInt(cfg.maxSlippageBps, 10, 20_000, state.maxSlippageBps || 2000);
    if (cfg?.minBuyAmountSol != null) state.minBuyAmountSol = Math.max(0, Number(cfg.minBuyAmountSol || 0) || 0);
    if (cfg?.maxBuyAmountSol != null) state.maxBuyAmountSol = Math.max(0, Number(cfg.maxBuyAmountSol || 0) || 0);
    if (cfg?.sellAmountPct != null) state.sellAmountPct = Math.max(1, Math.min(100, Number(cfg.sellAmountPct || 100) || 100));
    if (cfg?.holdTokens != null) state.holdTokens = Math.max(0, Number(cfg.holdTokens || 0) || 0);
    if (cfg?.holdDelayMs != null) state.holdDelayMs = clampInt(cfg.holdDelayMs, 0, 3_600_000, state.holdDelayMs || 2500);
    if (cfg?.cycleDelayMs != null) state.cycleDelayMs = clampInt(cfg.cycleDelayMs, 0, 3_600_000, state.cycleDelayMs || 3000);
    _applyRpcOptsToStateAndStorage({ rpcUrl: cfg?.rpcUrl, rpcHeaders: cfg?.rpcHeaders });
    return true;
  } catch {
    return false;
  }
}

export async function __fdvCli_start(cfg = {}) {
  if (!_isNodeLike()) {
    // Intended for CLI, but can still be used in browser for debugging.
  }

  try {
    if (cfg?.logToConsole) {
      try { window._fdvLogToConsole = true; } catch {}
    }
  } catch {}

  __fdvCli_applyConfig(cfg);

  state.enabled = false;
  state.softStopRequested = false;
  state.volumeCreated = 0;

  if (!state.mint) {
    log('Mint is required', 'error');
    return 2;
  }

  // Check auto wallet and RPC quickly
  let autoKp;
  try {
    autoKp = await getAutoKeypair();
    if (!autoKp) {
      log('No auto wallet configured. Set/import it in the Auto tab first.', 'error');
      await debugAutoWalletLoad();
      return 3;
    }
    await getConn();
  } catch (e) {
    const msg = String(e?.message || e || '');
    if (/403/.test(msg)) {
      log('RPC 403 Forbidden: configure RPC URL and headers in Auto settings.', 'error');
      log(`RPC URL: ${currentRpcUrl()}`, 'help');
    } else {
      log(`RPC error: ${msg}`, 'error');
    }
    return 3;
  }

  // Sanity
  if (!Number.isFinite(state.minBuyAmountSol) || state.minBuyAmountSol <= 0) state.minBuyAmountSol = 0.004;
  if (!Number.isFinite(state.maxBuyAmountSol) || state.maxBuyAmountSol <= 0 || state.maxBuyAmountSol < state.minBuyAmountSol) {
    state.maxBuyAmountSol = Math.max(state.minBuyAmountSol + 0.001, state.minBuyAmountSol * 1.5);
  }
  state.multiBotCount = clampInt(state.multiBotCount, 1, 10, 1);
  state.maxSlippageBps = clampInt(state.maxSlippageBps, 10, 20_000, 2000);

  // Dynamically size initial funding from auto wallet
  try {
    const { spendable, total } = await getAutoSpendable();
    const botCount = clampInt(state.multiBotCount, 1, 10, 1);
    const minFund = Math.max(0.01, (state.minBuyAmountSol || 0.004) + 0.004);
    if (spendable < botCount * minFund) {
      log(`Insufficient auto funds for ${botCount} bot(s). Need ~${(botCount * minFund).toFixed(4)} SOL spendable; have ${spendable.toFixed(4)} SOL (total ${total.toFixed(4)} SOL)`, 'error');
      return 3;
    }
    const decided = decideFundPerWallet(spendable, botCount);
    state.fundSol = decided;
    log(`Seeding each bot wallet with ${decided.toFixed(4)} SOL (bots=${botCount}, auto spendable ${spendable.toFixed(4)} SOL)`);
  } catch (e) {
    log(`Auto fund sizing failed: ${e?.message || e}`, 'error');
    return 3;
  }

  log(`Volume started (headless). Mint=${state.mint.slice(0, 8)}… Auto=${autoKp.publicKey.toBase58().slice(0, 8)}…`, 'ok');
  await startVolumeBot();
  return 0;
}

export async function __fdvCli_stop() {
  try {
    await stopVolumeBot();
    log('Volume stopped (headless).', 'warn');
    return 0;
  } catch (e) {
    log(`Stop error: ${String(e?.message || e || '')}`, 'error');
    return 3;
  }
}

function logObj(label, obj) {
  try {
    log(`${label}: ${JSON.stringify(obj)}`);
  } catch {
    log(String(label || 'logObj'));
  }
}

const COMPUTE_BUDGET_PROGRAM_ID_STR = 'ComputeBudget111111111111111111111111111111';

function hasComputeBudgetIx(ixs) {
  try {
    return Array.isArray(ixs) && ixs.some((ix) => String(ix?.programId?.toBase58?.() || '') === COMPUTE_BUDGET_PROGRAM_ID_STR);
  } catch {
    return false;
  }
}

function dedupeComputeBudgetIxs(ixs) {
  if (!Array.isArray(ixs)) return ixs;
  const out = [];
  const seen = new Set();
  for (const ix of ixs) {
    const isCb = String(ix?.programId?.toBase58?.() || '') === COMPUTE_BUDGET_PROGRAM_ID_STR;
    if (!isCb) {
      out.push(ix);
      continue;
    }
    const data = ix?.data instanceof Uint8Array ? ix.data : new Uint8Array();
    const key = `${COMPUTE_BUDGET_PROGRAM_ID_STR}:${Array.from(data).join(',')}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(ix);
  }
  return out;
}

async function getComputeBudgetConfig() {
  // Keep minimal; Jupiter swap endpoint already uses dynamic CU limit.
  return { cuLimit: 0, cuPriceMicroLamports: 0 };
}

async function buildComputeBudgetIxs() {
  const cfg = await getComputeBudgetConfig();
  const { ComputeBudgetProgram } = await loadWeb3();
  const ixs = [];
  if (Number(cfg?.cuLimit) > 0) ixs.push(ComputeBudgetProgram.setComputeUnitLimit({ units: Math.floor(Number(cfg.cuLimit)) }));
  if (Number(cfg?.cuPriceMicroLamports) > 0) ixs.push(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: Math.floor(Number(cfg.cuPriceMicroLamports)) }));
  return ixs;
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
    log,
    logObj,
    getState: () => state,

    getConn,
    loadWeb3,
    loadSplToken,
    rpcWait,
    rpcBackoffLeft,
    markRpcStress,

    getCfg,
    isValidPubkeyStr,

    getPlatformFeeBps,
    tokenAccountRentLamports,
    requiredAtaLamportsForSwap,
    requiredOutAtaRentIfMissing: async () => 0,
    shouldAttachFeeForSell: (args) => shouldAttachFeeForSellVolume(args),
    minSellNotionalSol: () => 0,
    safeGetDecimalsFast,

    // Volume bot doesn't maintain position/dust caches; leave as no-ops.
    confirmSig,

    getComputeBudgetConfig,
    buildComputeBudgetIxs,
    hasComputeBudgetIx,
    dedupeComputeBudgetIxs,
  });
  return _dex;
}

// delay imported from ../lib/async.js

function isStopRequested() {
  return !state?.enabled;
}

function allBotsIdle() {
  try {
    const bots = state.bots || [];
    if (!bots.length) return true;
    return bots.every((b) => !b?.inFlight && !b?.currentWallet);
  } catch {
    return false;
  }
}

function requestSoftStop(reason) {
  if (state.softStopRequested) return;
  state.softStopRequested = true;
  try {
    for (const b of state.bots || []) {
      b.enabled = false;
      if (b.timer) {
        clearTimeout(b.timer);
        b.timer = null;
      }
    }
  } catch {}
  if (reason) log(reason, 'ok');
  try { updateUI(); } catch {}
}

function maybeFinalizeSoftStop() {
  try {
    if (!state.softStopRequested) return;
    if (!allBotsIdle()) return;
    state.enabled = false;
    state.bots = [];
    log('Target reached: all bots idle; stopped.', 'ok');
    updateUI();
  } catch {}
}

function maybeSoftStopAtTargetVolume() {
  const target = Number(state.targetVolumeSol || 0);
  if (!(target > 0)) return;
  if (state.volumeCreated + 1e-12 < target) return;
  requestSoftStop(
    `Stop At Volume reached (${state.volumeCreated.toFixed(4)} / ${target.toFixed(4)} SOL). Stopping after in-flight cycles finish.`,
  );
}

function backoffMs(attempt, base = 500, max = 15_000) {
  const a = Math.max(0, Number(attempt) || 0);
  const exp = Math.min(max, Math.floor(base * Math.pow(1.7, a)));
  const jitter = Math.floor(exp * (0.15 + Math.random() * 0.25));
  return Math.min(max, exp + jitter);
}

async function retryUntil(label, fn, opts = {}) {
  const base = Number(opts.baseDelayMs || 500);
  const max = Number(opts.maxDelayMs || 15_000);
  const logEvery = Math.max(1, Number(opts.logEvery || 3));
  let attempt = 0;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    if (isStopRequested()) throw new Error('STOP_REQUESTED');
    try {
      // eslint-disable-next-line no-await-in-loop
      return await fn({ attempt });
    } catch (e) {
      attempt += 1;
      const msg = String(e?.message || e || '');
      if (attempt === 1 || attempt % logEvery === 0) {
        log(`${label} failed (attempt ${attempt}): ${msg}`, 'warn');
      }
      markRpcStress?.(e, 1500);
      // eslint-disable-next-line no-await-in-loop
      await delay(backoffMs(attempt, base, max));
    }
  }
}

const CYCLE_STAGE = Object.freeze({
  IDLE: 'idle',
  FUNDED: 'funded',
  BOUGHT: 'bought',
  WAITED: 'waited',
  SOLD: 'sold',
  RETURNED: 'returned',
});

function makeBot(id) {
  return {
    id,
    enabled: false,
    timer: null,
    inFlight: false,

    currentWallet: null,
    cycleStage: CYCLE_STAGE.IDLE,
    cycleId: 0,
    cycleBuyAmountSol: 0,
    cycleFundSol: 0,
    cycleVolumeCounted: false,
    cycleBuyBasisRecorded: false,
    cycleBuySig: null,
    cycleSellSig: null,
  };
}

// Determine auto wallet spendable SOL after keeping a small reserve
async function getAutoSpendable() {
  const autoKp = await getAutoKeypair();
  if (!autoKp) return { spendable: 0, total: 0 };
  const conn = await getConn();
  const balLam = await conn.getBalance(autoKp.publicKey);
  const total = balLam / 1e9;
  const reserve = Math.max(0.002, Math.min(0.02, total * 0.06));
  const spendable = Math.max(0, total - reserve);
  return { spendable, total };
}

// Decide initial seed amount for the active wallet
function decideFundPerWallet(spendable, botCount = 1) {
  const n = clampInt(botCount, 1, 10, 1);
  const minFund = Math.max(0.01, (state.minBuyAmountSol || 0.004) + 0.004);
  const perBotShare = spendable / n;
  // Keep headroom for fees/top-ups; do not exhaust the share.
  const target = Math.max(minFund, perBotShare * 0.85);
  const decided = Math.min(target, perBotShare);
  return Number(Math.max(minFund, decided).toFixed(4));
}
// Find a working slippage and get quote
async function getQuoteAndSlippage(inputMint, outputMint, amountUi) {
  const inDec = await getDex().getMintDecimals(inputMint);
  const amountRaw = Math.max(1, Math.floor(amountUi * Math.pow(10, inDec)));

  const maxSlip = clampInt(state.maxSlippageBps, 10, 20_000, 2000);
  const tiers = SLIPPAGE_TIERS_BPS.filter((bps) => bps <= maxSlip);
  if (!tiers.length) throw new Error('SLIPPAGE_LIMIT_TOO_LOW');

  for (const bps of tiers) {
    const q = await getDex().quoteGeneric(inputMint, outputMint, amountRaw, bps);
    if (q && q.outAmount) {
      return { bps, outAmount: Number(q.outAmount) };
    }
    await delay(100);
  }
  throw new Error('NO_QUOTE_UNDER_MAX_SLIPPAGE');
}

async function _kpSecretB58(kp) {
  const bs58 = await getBs58();
  return bs58.encode(kp.secretKey);
}

async function downloadGeneratedWallets() {
  // User-initiated export only
  const payload = {
    createdAt: new Date().toISOString(),
    wallets: state.generatedWallets,
  };
  const json = JSON.stringify(payload, null, 2);
  const blob = new Blob([json], { type: 'application/json' });
  const url = URL.createObjectURL(blob);

  const a = document.createElement('a');
  a.href = url;
  a.download = `fdv-volume-generated-wallets-${Date.now()}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();

  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

async function createAndFundCycleWallet(autoKp, fundSol) {
  const { Keypair } = await loadWeb3();
  const kp = Keypair.generate();

  try {
    const secretKeyB58 = await _kpSecretB58(kp);
    state.generatedWallets.push({
      ts: Date.now(),
      pubkey: kp.publicKey.toBase58(),
      secretKeyB58,
    });
  } catch {}

  log(`Cycle wallet created: ${kp.publicKey.toBase58()}`);
  log(`Wallet captured (session). Use "Export" or window.fdvVolume.getGeneratedWallets()`, 'help');

  await sendSol(autoKp, kp.publicKey, fundSol);
  await delay(400);
  return kp;
}

function pickBuyAmountSol() {
  let buyAmount = state.minBuyAmountSol + Math.random() * Math.max(0, state.maxBuyAmountSol - state.minBuyAmountSol);
  if (!Number.isFinite(buyAmount) || buyAmount <= 0) buyAmount = Math.max(0.004, state.minBuyAmountSol || 0.004);
  return buyAmount;
}

async function ensureCycleWalletAndFunded(autoKp) {
  if (isStopRequested()) throw new Error('STOP_REQUESTED');

  throw new Error('BOT_REQUIRED');
}

async function ensureCycleWalletAndFundedForBot(bot, autoKp) {
  if (isStopRequested()) throw new Error('STOP_REQUESTED');
  if (!bot) throw new Error('BOT_REQUIRED');

  if (!bot.currentWallet) {
    bot.cycleId = Date.now();
    bot.cycleStage = CYCLE_STAGE.IDLE;
    bot.cycleBuyAmountSol = pickBuyAmountSol();
    bot.cycleFundSol = Math.max(Number(state.fundSol || 0), bot.cycleBuyAmountSol + 0.01);
    bot.cycleVolumeCounted = false;
    bot.cycleBuySig = null;
    bot.cycleSellSig = null;
    updateUI();

    bot.currentWallet = await createAndFundCycleWallet(autoKp, bot.cycleFundSol);
  }

  const wallet = bot.currentWallet;

  await retryUntil('Ensure cycle wallet funded', async () => {
    const bal = await fetchSolBalance(wallet.publicKey);
    const need = Math.max(0.01, (bot.cycleBuyAmountSol || 0.004) + 0.004);
    if (bal >= need) {
      bot.cycleStage = CYCLE_STAGE.FUNDED;
      updateUI();
      return true;
    }
    const topUp = Math.max(0.005, Math.min(bot.cycleFundSol || 0.02, (need - bal) + 0.006));
    log(`Cycle wallet underfunded (${bal.toFixed(4)} SOL). Topping up ${topUp.toFixed(4)} SOL`, 'warn');
    await sendSol(autoKp, wallet.publicKey, topUp);
    await delay(350);
    return true;
  });

  return wallet;
}

async function ensureBought(bot, wallet) {
  await retryUntil('Buy stage', async () => {
    const already = await getTokenBalanceUiByMint(wallet.publicKey, state.mint);
    if (already > 0) {
      bot.cycleStage = CYCLE_STAGE.BOUGHT;

      if (!bot.cycleBuyBasisRecorded) {
        bot.cycleBuyBasisRecorded = true;
        await recordVolumeBuyBasis({ mint: state.mint, solUi: bot.cycleBuyAmountSol, tokenUi: already });
      }

      if (!bot.cycleVolumeCounted) {
        state.volumeCreated += Number(bot.cycleBuyAmountSol || 0);
        bot.cycleVolumeCounted = true;
        maybeSoftStopAtTargetVolume();
      }
      updateUI();
      return true;
    }

    // If we already sent a buy tx, wait for it to settle instead of re-buying.
    if (bot.cycleBuySig) {
      await confirmSig(bot.cycleBuySig, { timeoutMs: 40_000 });
      const start = Date.now();
      while (Date.now() - start < 45_000) {
        // eslint-disable-next-line no-await-in-loop
        const b = await getTokenBalanceUiByMint(wallet.publicKey, state.mint);
        if (b > 0) {
          bot.cycleStage = CYCLE_STAGE.BOUGHT;

          if (!bot.cycleBuyBasisRecorded) {
            bot.cycleBuyBasisRecorded = true;
            await recordVolumeBuyBasis({ mint: state.mint, solUi: bot.cycleBuyAmountSol, tokenUi: b });
          }

          if (!bot.cycleVolumeCounted) {
            state.volumeCreated += Number(bot.cycleBuyAmountSol || 0);
            bot.cycleVolumeCounted = true;
            maybeSoftStopAtTargetVolume();
          }
          updateUI();
          return true;
        }
        // eslint-disable-next-line no-await-in-loop
        await delay(900);
      }
      throw new Error('BUY_BALANCE_DELAY');
    }

    const { bps } = await getQuoteAndSlippage(SOL_MINT, state.mint, bot.cycleBuyAmountSol);
    state.slippageBps = bps;
    log(`[B${bot.id}] Buying ${Number(bot.cycleBuyAmountSol || 0).toFixed(4)} SOL of ${state.mint} (slip ${bps}bps) with ${wallet.publicKey.toBase58().slice(0, 8)}`);
    const res = await getDex().buyWithConfirm(
      { signer: wallet, mint: state.mint, solUi: bot.cycleBuyAmountSol, slippageBps: bps },
      { retries: 1, confirmMs: 45_000 },
    );

    bot.cycleBuySig = res?.sig || null;

    if (bot.cycleBuySig) {
      await confirmSig(bot.cycleBuySig, { timeoutMs: 40_000 });
    }

    const start = Date.now();
    while (Date.now() - start < 45_000) {
      // eslint-disable-next-line no-await-in-loop
      const after = await getTokenBalanceUiByMint(wallet.publicKey, state.mint);
      if (after > 0) {
        bot.cycleStage = CYCLE_STAGE.BOUGHT;

        if (!bot.cycleBuyBasisRecorded) {
          bot.cycleBuyBasisRecorded = true;
          await recordVolumeBuyBasis({ mint: state.mint, solUi: bot.cycleBuyAmountSol, tokenUi: after });
        }

        if (!bot.cycleVolumeCounted) {
          state.volumeCreated += Number(bot.cycleBuyAmountSol || 0);
          bot.cycleVolumeCounted = true;
          maybeSoftStopAtTargetVolume();
        }
        updateUI();
        return true;
      }
      // eslint-disable-next-line no-await-in-loop
      await delay(900);
    }

    throw new Error('BUY_NOT_CONFIRMED');
  });
}

async function ensureWaited(bot) {
  if (bot.cycleStage === CYCLE_STAGE.WAITED || bot.cycleStage === CYCLE_STAGE.SOLD || bot.cycleStage === CYCLE_STAGE.RETURNED) return;
  await delay(Math.max(0, Number(state.holdDelayMs || 0)));
  bot.cycleStage = CYCLE_STAGE.WAITED;
  updateUI();
}

async function ensureSold(bot, wallet) {
  await retryUntil('Sell stage', async () => {
    const balanceUi = await getTokenBalanceUiByMint(wallet.publicKey, state.mint);
    const holdUi = Math.max(0, Number(state.holdTokens || 0));
    const holdTol = Math.max(1e-9, holdUi * 0.001);

    if (!balanceUi || balanceUi <= (holdUi + holdTol)) {
      bot.cycleStage = CYCLE_STAGE.SOLD;
      updateUI();
      return true;
    }

    const sellPct = Number(state.sellAmountPct || 100);
    const byPctUi = Math.max(0, balanceUi) * (sellPct / 100);
    const maxSellToKeepHoldUi = Math.max(0, balanceUi - holdUi);
    const sellUi = Math.min(byPctUi, maxSellToKeepHoldUi);
    if (!sellUi || sellUi <= 0) {
      bot.cycleStage = CYCLE_STAGE.SOLD;
      updateUI();
      return true;
    }

    let sellBps = 500;
    try {
      const res = await getQuoteAndSlippage(state.mint, SOL_MINT, sellUi);
      sellBps = res.bps;
    } catch {
      sellBps = 500;
    }
    state.slippageBps = sellBps;
    if (holdUi > 0) log(`[B${bot.id}] Selling ${sellUi.toFixed(6)} ${state.mint} (slip ${sellBps}bps; hold ${holdUi.toFixed(6)})`);
    else log(`[B${bot.id}] Selling ${sellUi.toFixed(6)} ${state.mint} (slip ${sellBps}bps)`);
    const res = await getDex().sellWithConfirm(
      { signer: wallet, mint: state.mint, amountUi: sellUi, slippageBps: sellBps },
      { retries: 1, confirmMs: 50_000 },
    );

    if (res?.noRoute) {
      log('Sell reported NO_ROUTE/ROUTER_DUST; proceeding to return SOL (token dust may remain).', 'warn');
      bot.cycleStage = CYCLE_STAGE.SOLD;
      updateUI();
      return true;
    }

    bot.cycleSellSig = res?.sig || null;
    if (bot.cycleSellSig) {
      await confirmSig(bot.cycleSellSig, { timeoutMs: 50_000 });
    }

    const start = Date.now();
    let afterUi = balanceUi;
    while (Date.now() - start < 45_000) {
      afterUi = await getTokenBalanceUiByMint(wallet.publicKey, state.mint);
      if (afterUi < balanceUi) break;
      await delay(900);
    }

    if (afterUi <= (holdUi + holdTol)) {
      bot.cycleStage = CYCLE_STAGE.SOLD;
      updateUI();
      return true;
    }

    if (sellPct >= 99.9 && holdUi <= 0) {
      if (afterUi <= 0 || afterUi <= Math.max(0, balanceUi * 0.001)) {
        bot.cycleStage = CYCLE_STAGE.SOLD;
        updateUI();
        return true;
      }

      try {
        const res = await getQuoteAndSlippage(state.mint, SOL_MINT, afterUi);
        const bps = res.bps;
        log(`Final sweep sell: ${afterUi.toFixed(6)} ${state.mint} (slip ${bps}bps)`, 'help');
        await getDex().sellWithConfirm(
          { signer: wallet, mint: state.mint, amountUi: afterUi, slippageBps: bps },
          { retries: 1, confirmMs: 50_000 },
        );
        await delay(250);
      } catch {}
      const finalUi = await getTokenBalanceUiByMint(wallet.publicKey, state.mint);
      if (finalUi <= 0 || finalUi <= Math.max(0, balanceUi * 0.001)) {
        bot.cycleStage = CYCLE_STAGE.SOLD;
        updateUI();
        return true;
      }

      log('Sell-all left token dust that could not be cleared; proceeding.', 'warn');
      bot.cycleStage = CYCLE_STAGE.SOLD;
      updateUI();
      return true;
    }

    if (holdUi > 0 && afterUi > (holdUi + holdTol)) {
      const trimUi = Math.max(0, afterUi - holdUi);
      if (trimUi > 0) {
        try {
          const res = await getQuoteAndSlippage(state.mint, SOL_MINT, trimUi);
          const bps = res.bps;
          log(`Final trim sell: ${trimUi.toFixed(6)} ${state.mint} (slip ${bps}bps; hold ${holdUi.toFixed(6)})`, 'help');
          await getDex().sellWithConfirm(
            { signer: wallet, mint: state.mint, amountUi: trimUi, slippageBps: bps },
            { retries: 1, confirmMs: 50_000 },
          );
          await delay(250);
        } catch {}
      }

      const finalUi = await getTokenBalanceUiByMint(wallet.publicKey, state.mint);
      if (finalUi <= (holdUi + holdTol)) {
        bot.cycleStage = CYCLE_STAGE.SOLD;
        updateUI();
        return true;
      }
    }

    if (afterUi < balanceUi) {
      bot.cycleStage = CYCLE_STAGE.SOLD;
      updateUI();
      return true;
    }
    throw new Error('SELL_NOT_CONFIRMED');
  });
}

async function ensureReturned(bot, wallet, autoKp) {
  await retryUntil('Return SOL stage', async () => {
    try {
      await getDex().closeAllEmptyAtas(wallet);
    } catch {}

    const conn = await getConn();
    const balLam = await conn.getBalance(wallet.publicKey);
    if (!balLam || balLam <= 0) {
      bot.cycleStage = CYCLE_STAGE.RETURNED;
      updateUI();
      return true;
    }

    const rentMin = await feePayerRentMinLamports(wallet.publicKey);
    const feeBufferLamports = Math.max(Number(TX_FEE_BUFFER_LAMPORTS || 0), 500_000);
    const allowedLeftoverLamports = rentMin + Math.max(RETURN_SOL_MIN_LEFTOVER_LAMPORTS, 25_000, feeBufferLamports);

    await drainSolBack(wallet, autoKp.publicKey, { minLeftoverLamports: 10_000, maxRounds: 3 });
    await delay(250);

    const afterLam = await conn.getBalance(wallet.publicKey);
    if (afterLam <= allowedLeftoverLamports + 20_000) {
      bot.cycleStage = CYCLE_STAGE.RETURNED;
      updateUI();
      return true;
    }

    // Conservative fallback
    await sendAllSolBack(wallet, autoKp.publicKey);
    await delay(250);
    const after2 = await conn.getBalance(wallet.publicKey);
    if (after2 <= allowedLeftoverLamports + 20_000) {
      bot.cycleStage = CYCLE_STAGE.RETURNED;
      updateUI();
      return true;
    }

    throw new Error('RETURN_NOT_CONFIRMED');
  });
}

async function performVolumeTrade(bot) {
  if (!state.enabled || !state.mint) return;
  if (!bot) return;
  if (bot.inFlight) return;
  bot.inFlight = true;

  try {
    const autoKp = await getAutoKeypair();
    if (!autoKp) {
      const meta = getExistingAutoWalletMeta();
      haltVolumeBot('No auto wallet configured. Open Auto tab and set/import the auto wallet, then retry.');
      await debugAutoWalletLoad();
      if (meta?.autoWalletPub && !meta?.hasSecret) {
        log(`Found autoWalletPub=${meta.autoWalletPub} but no secret in cache. Keys present: ${meta.keys.join(', ')}`, 'warn');
      } else {
        log(`Auto wallet cache keys: ${meta.keys.join(', ') || '(none)'}`, 'help');
      }
      return;
    }

    // Resumable staged cycle: do not start a new wallet until return is confirmed.
    const wallet = await ensureCycleWalletAndFundedForBot(bot, autoKp);
    await ensureBought(bot, wallet);
    await ensureWaited(bot);
    await ensureSold(bot, wallet);
    await ensureReturned(bot, wallet, autoKp);

    // Cycle complete
    bot.currentWallet = null;
    bot.cycleStage = CYCLE_STAGE.IDLE;
    bot.cycleId = 0;
    bot.cycleBuyAmountSol = 0;
    bot.cycleFundSol = 0;
    bot.cycleVolumeCounted = false;
    bot.cycleBuySig = null;
    bot.cycleSellSig = null;
    updateUI();

  } catch (e) {
    const msg = String(e?.message || e || '');
    if (msg === 'STOP_REQUESTED') {
      log(`[B${bot?.id ?? '?'}] Stop requested; halting cycle retries.`, 'warn');
    } else {
      log(`[B${bot?.id ?? '?'}] Trade error: ${msg}`, 'error');
    }
    if (/Auto swap API not available/i.test(msg)) {
      try { await stopVolumeBot(); } catch {}
    }
  } finally {
    bot.inFlight = false;
    maybeFinalizeSoftStop();
  }
}

async function scheduleNextTrade(bot) {
  if (!state.enabled || !bot?.enabled) return;
  if (state.softStopRequested) return;
  const baseDelay = Math.max(0, Number(state.cycleDelayMs || 0));
  const jitter = Math.floor(baseDelay * (0.1 + Math.random() * 0.3));
  const wait = Math.max(250, baseDelay + jitter);
  bot.timer = setTimeout(async () => {
    await performVolumeTrade(bot);
    scheduleNextTrade(bot);
  }, wait);
}

async function startVolumeBot() {
  if (state.enabled) return;
  state.softStopRequested = false;
  state.enabled = true;
  try { setBotRunning('volume', true); } catch {}
  const botCount = clampInt(state.multiBotCount, 1, 10, 1);
  state.bots = Array.from({ length: botCount }, (_, i) => makeBot(i + 1));
  for (const b of state.bots) b.enabled = true;
  log(`Starting volume bots: ${botCount}`);
  // Run first trade immediately, then schedule subsequent ones (staggered)
  for (const b of state.bots) {
    // eslint-disable-next-line no-await-in-loop
    await delay(60 + Math.floor(Math.random() * 120));
    // eslint-disable-next-line no-await-in-loop
    await performVolumeTrade(b);
    scheduleNextTrade(b);
  }
}

async function stopVolumeBot() {
  state.softStopRequested = false;
  state.enabled = false;
  try { setBotRunning('volume', false); } catch {}
  for (const b of state.bots || []) {
    try {
      b.enabled = false;
      if (b.timer) {
        clearTimeout(b.timer);
        b.timer = null;
      }
    } catch {}
  }
  log('Stopped volume bot(s)');

  // Send back SOL
  const autoKp = await getAutoKeypair();
  if (!autoKp) {
    log('No auto wallet to send back', 'error');
    return;
  }

  // Attempt to return funds from any active bot wallet(s).
  for (const b of state.bots || []) {
    if (!b?.currentWallet) continue;
    try {
      await closeAllEmptyTokenAccountsForOwner(b.currentWallet);
      const beforeLam = await (await getConn()).getBalance(b.currentWallet.publicKey);
      try {
        await drainAllSpendableSolBack(b.currentWallet, autoKp.publicKey, { minLeftoverLamports: 5_000, maxAttempts: 18 });
      } catch {}
      await closeAllEmptyTokenAccountsForOwner(b.currentWallet);
      try {
        await drainAllSpendableSolBack(b.currentWallet, autoKp.publicKey, { minLeftoverLamports: 5_000, maxAttempts: 10 });
      } catch {}
      const afterLam = await (await getConn()).getBalance(b.currentWallet.publicKey);
      const returnedLam = Math.max(0, beforeLam - afterLam);
      if (returnedLam > 0) {
        log(`[B${b.id}] Sent back ${(returnedLam / 1e9).toFixed(6)} SOL from ${b.currentWallet.publicKey.toBase58().slice(0, 8)}`, 'ok');
      }
    } catch (e) {
      log(`[B${b.id}] Failed to send back from wallet: ${e?.message || e}`, 'error');
    } finally {
      b.currentWallet = null;
    }
  }

  state.bots = [];
  updateUI();
}

function updateUI() {
  if (mintEl) mintEl.value = state.mint;
  if (minBuyEl) minBuyEl.value = state.minBuyAmountSol;
  if (maxBuyEl) maxBuyEl.value = state.maxBuyAmountSol;
  if (sellAmountEl) sellAmountEl.value = state.sellAmountPct;
  if (holdEl) holdEl.value = state.holdTokens;
  if (holdDelayEl) holdDelayEl.value = state.holdDelayMs;
  if (intervalEl) intervalEl.value = state.cycleDelayMs;
  if (botsEl) botsEl.value = state.multiBotCount;
  if (targetVolEl) targetVolEl.value = state.targetVolumeSol;
  if (maxSlipEl) maxSlipEl.value = state.maxSlippageBps;
  if (statusEl) statusEl.textContent = state.softStopRequested ? 'Stopping' : state.enabled ? 'Running' : 'Stopped';
  if (rpcEl) {
      if (currentRpcUrl()) {
          rpcEl.textContent = `RPC online.`;
      } else {
          rpcEl.textContent = `Please Set RPC in Auto Tab`;
      }
      if (state.enabled) {
          rpcEl.style.color = 'var(--fdv-muted)';
      } else {
          rpcEl.style.color = 'var(--fdv-info)';
      } 
  }
}

export function initVolumeWidget(container = document.body) {
  const wrap = document.createElement('div');
  wrap.className = 'fdv-volume-wrap';
  wrap.innerHTML = `
    <div class="fdv-tab-content active" data-tab-content="volume">
      <div class="fdv-grid">
        <label>Mint <input id="volume-mint" type="text" placeholder="Token Mint"></label>
        <label>Bots (1-10) <input id="volume-bots" type="number" min="1" max="10" step="1" value="1"></label>
        <label>Stop At Volume (SOL) <input id="volume-target" type="number" min="0" step="0.1" placeholder="0"></label>
        <label>Max Slippage (bps) <input id="volume-max-slip" type="number" min="10" max="20000" step="10" value="2000"></label>
        <label>Min Buy Amount (SOL) <input id="volume-min-buy" type="number" step="0.001"></label>
        <label>Max Buy Amount (SOL) <input id="volume-max-buy" type="number" step="0.001"></label>
        <label>Sell % <input id="volume-sell" type="number" min="1" max="100"></label>
        <label>Hold Amount <input id="volume-hold" type="number" min="0" step="0.000001" placeholder="0"></label>
        <label>Hold Delay (ms) <input id="volume-hold-delay" type="number" min="0" step="50"></label>
        <label>Cycle Delay (ms) <input id="volume-interval" type="number" min="0" step="50"></label>
      </div>
      <div class="fdv-log" id="volume-log"></div>
      <div class="fdv-actions">
        <div class="fdv-actions-left">
          <div class="fdv-rpc-text" id="volume-rpc"></div>
        </div>
        <div class="fdv-actions-right">
          <button id="fdv-volume-export">Export</button>
          <button id="fdv-volume-start">Start</button>
          <button id="fdv-volume-stop">Stop</button>
        </div>
      </div>
    </div>
  `;
  container.appendChild(wrap);

  const tabs = wrap.querySelectorAll('.fdv-tab');
  const contents = wrap.querySelectorAll('.fdv-tab-content');
  tabs.forEach(tab => {
    tab.addEventListener('click', () => {
      if (tab.dataset.tab === 'hide') {
        wrap.style.display = 'none';
        return;
      }
      tabs.forEach(t => t.classList.remove('active'));
      contents.forEach(c => {
        c.classList.remove('active');
        c.style.display = 'none';
      });
      tab.classList.add('active');
      const content = wrap.querySelector(`[data-tab-content="${tab.dataset.tab}"]`);
      if (content) {
        content.classList.add('active');
        content.style.display = 'block';
      }
    });
  });

  mintEl = document.getElementById('volume-mint');
  botsEl = document.getElementById('volume-bots');
  targetVolEl = document.getElementById('volume-target');
  maxSlipEl = document.getElementById('volume-max-slip');
  minBuyEl = document.getElementById('volume-min-buy');
  maxBuyEl = document.getElementById('volume-max-buy');
  sellAmountEl = document.getElementById('volume-sell');
  holdEl = document.getElementById('volume-hold');
  holdDelayEl = document.getElementById('volume-hold-delay');
  intervalEl = document.getElementById('volume-interval');
  startBtn = document.getElementById('fdv-volume-start');
  stopBtn = document.getElementById('fdv-volume-stop');
  logEl = document.getElementById('volume-log');
  // ledEl = 
  statusEl = document.getElementById('volume-status-text');
  rpcEl = document.getElementById('volume-rpc');

  updateUI();

  startBtn.addEventListener('click', async () => {
    if (state.enabled) {
      log('Volume bot is already running. Press Stop first.', 'warn');
      return;
    }
    state.mint = mintEl.value.trim();
    state.multiBotCount = clampInt(botsEl?.value, 1, 10, 1);
    state.targetVolumeSol = Math.max(0, Number(targetVolEl?.value || 0) || 0);
    state.maxSlippageBps = clampInt(maxSlipEl?.value, 10, 20_000, 2000);
    state.minBuyAmountSol = parseFloat(minBuyEl.value);
    state.maxBuyAmountSol = parseFloat(maxBuyEl.value);
    state.sellAmountPct = parseFloat(sellAmountEl.value) || 100;
    state.holdTokens = Math.max(0, parseFloat(holdEl?.value || '0') || 0);
    state.holdDelayMs = clampInt(holdDelayEl?.value, 0, 3_600_000, 2500);
    state.cycleDelayMs = clampInt(intervalEl.value, 0, 3_600_000, 3000);
    state.slippageBps = 80; // initial placeholder; computed per swap
    state.volumeCreated = 0;
    state.softStopRequested = false;

    if (!state.mint) {
      log('Mint is required', 'error');
      return;
    }

    // Check auto wallet and RPC quickly
    let autoKp, conn;
    try {
      autoKp = await getAutoKeypair();
      if (!autoKp) {
        const meta = getExistingAutoWalletMeta();
        log('No auto wallet configured. Set/import it in the Auto tab first.', 'error');
        await debugAutoWalletLoad();
        if (meta?.autoWalletPub && !meta?.hasSecret) {
          log(`Found autoWalletPub=${meta.autoWalletPub} but secret missing. Keys present: ${meta.keys.join(', ')}`, 'warn');
        } else {
          log(`Auto wallet cache keys: ${meta.keys.join(', ') || '(none)'}`, 'help');
        }
        return;
      }
      conn = await getConn();
    } catch (e) {
      const msg = String(e?.message || e || '');
      if (/403/.test(msg)) {
        log('RPC 403 Forbidden: Your RPC requires auth. Configure RPC URL and headers in Auto settings.', 'error');
        const hdrs = currentRpcHeaders();
        const hdrKeys = Object.keys(hdrs || {});
        log(`RPC URL: ${currentRpcUrl()}`);
        log('Tip: Add Authorization or x-api-key in Auto -> RPC Headers (JSON).', 'help');
      } else {
        log(`RPC error: ${msg}`, 'error');
      }
      return;
    }
    // Sanity for mins/max
    if (!Number.isFinite(state.minBuyAmountSol) || state.minBuyAmountSol <= 0) state.minBuyAmountSol = 0.004;
    if (!Number.isFinite(state.maxBuyAmountSol) || state.maxBuyAmountSol <= 0 || state.maxBuyAmountSol < state.minBuyAmountSol) {
      state.maxBuyAmountSol = Math.max(state.minBuyAmountSol + 0.001, state.minBuyAmountSol * 1.5);
    }
    if (!Number.isFinite(state.holdDelayMs) || state.holdDelayMs < 0) state.holdDelayMs = 2500;
    if (!Number.isFinite(state.cycleDelayMs) || state.cycleDelayMs < 0) state.cycleDelayMs = 3000;

    // Sanity for bot count
    state.multiBotCount = clampInt(state.multiBotCount, 1, 10, 1);
    state.maxSlippageBps = clampInt(state.maxSlippageBps, 10, 20_000, 2000);

    // Dynamically size initial funding from auto wallet
    try {
      const { spendable, total } = await getAutoSpendable();
      const botCount = clampInt(state.multiBotCount, 1, 10, 1);
      const minFund = Math.max(0.01, (state.minBuyAmountSol || 0.004) + 0.004);
      if (spendable < botCount * minFund) {
        log(`Insufficient auto funds for ${botCount} bot(s). Need ~${(botCount * minFund).toFixed(4)} SOL spendable; have ${spendable.toFixed(4)} SOL (total ${total.toFixed(4)} SOL)`, 'error');
        return;
      }
      const decided = decideFundPerWallet(spendable, botCount);
      state.fundSol = decided;
      log(`Seeding each bot wallet with ${decided.toFixed(4)} SOL (bots=${botCount}, auto spendable ${spendable.toFixed(4)} SOL)`);
    } catch (e) {
      log(`Auto fund sizing failed: ${e?.message || e}`, 'error');
      return;
    }

    state.bots = [];
    updateUI();
    startVolumeBot();
  });

  stopBtn.addEventListener('click', async () => {
    await stopVolumeBot();
  });

  const exportBtn = document.getElementById('fdv-volume-export');
  exportBtn.addEventListener('click', async () => {
    if (!state.generatedWallets.length) {
      log('No generated wallets captured in this session.', 'warn');
      return;
    }
    await downloadGeneratedWallets();
    log(`Exported ${state.generatedWallets.length} generated wallet(s)`, 'ok');
  });

  if (typeof window !== 'undefined') {
    window.fdvVolume = window.fdvVolume || {};
    window.fdvVolume.getGeneratedWallets = getGeneratedWallets; // returns [{ts,pubkey,secretKeyB58}]
    window.fdvVolume.clearGeneratedWallets = clearGeneratedWallets;
  }
}