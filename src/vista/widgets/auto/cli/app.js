import { readFile, writeFile, mkdir, rename } from "node:fs/promises";
import { openSync, closeSync, readSync, constants as fsConstants } from "node:fs";
import { createInterface } from "node:readline";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import tty from "node:tty";
import process from "node:process";

import { loadSolanaWeb3FromWeb } from "./helpers/web3.node.js";

import { SOLANA_RPC_URL as DEFAULT_SOLANA_RPC_URL } from "../../../../config/env.js";

import { runPipeline } from "../lib/pipeline.js";

import { createPosCacheStore } from "../lib/stores/posCacheStore.js";

import { createPreflightSellPolicy } from "../lib/sell/policies/preflight.js";
import { createUrgentSellPolicy } from "../lib/sell/policies/urgent.js";
import { createQuoteAndEdgePolicy } from "../lib/sell/policies/quoteAndEdge.js";
import { createFastExitPolicy } from "../lib/sell/policies/fastExit.js";
import { createDynamicHardStopPolicy } from "../lib/sell/policies/dynamicHardStop.js";
import { createProfitLockPolicy } from "../lib/sell/policies/profitLock.js";
import { createForceFlagDecisionPolicy } from "../lib/sell/policies/forceFlagDecision.js";
import { createReboundGatePolicy } from "../lib/sell/policies/reboundGate.js";
import { createFallbackSellPolicy } from "../lib/sell/policies/fallbackSell.js";

import { createExecuteSellDecisionPolicy } from "../lib/sell/policies/executeSellDecision.js";

const AUTO_LS_KEY = "fdv_auto_bot_v1";

const CLI_RECON_LS_KEY = "fdv_cli_recon_v1";
let _cliMintReconStop = null;
let _cliLastWalletSnap = null;
let _cliLastWalletSnapAt = 0;
let _cliWalletSnapInFlight = null;

function ensureWindowShim() {
  if (typeof globalThis.window === "undefined") globalThis.window = globalThis;
  if (!globalThis.window._fdvRouterHold) globalThis.window._fdvRouterHold = new Map();
}

function parseArgs(argv) {
  const args = Array.isArray(argv) ? argv.slice() : [];
  const flags = new Set(args.filter((a) => String(a).startsWith("--")));
  const getValue = (name) => {
    const idx = args.findIndex((a) => a === name);
    if (idx < 0) return null;
    const v = args[idx + 1];
    if (!v || String(v).startsWith("--")) return null;
    return String(v);
  };
  return { args, flags, getValue };
}

function usage() {
  return [
    "fdv-trader (CLI)",
    "", 
    "Usage:",
    "  node tools/trader.mjs --validate-sell-bypass",
    "  node tools/trader.mjs --dry-run-sell --snapshot tools/snapshots/sample-sell.json",
    "  node tools/trader.mjs --sim-index",
    "  node tools/trader.mjs --quick-start",
    "  node tools/trader.mjs --flame",
    "  node tools/trader.mjs --run-profile --profile <name> [--profiles <pathOrUrl>]",
    "  node tools/trader.mjs --help",
    "", 
    "Options:",
    "  --validate-sell-bypass   Runs a local self-test that urgent/hard-exit sells bypass router cooldown gates.",
    "  --dry-run-sell           Runs sell evaluation (no swaps) using a JSON snapshot.",
    "  --snapshot <path>        Snapshot JSON file used by --dry-run-sell.",
    "  --sim-index              Runs a deterministic simulation against the real auto-bot module (index.js) with RPC/wallet/quotes stubbed.",
    "    --steps <n>             Number of sim steps (default 40).",
    "    --dt-ms <n>             Milliseconds per sim step (default 1000).",
    "    --throw-prune           Forces pruneZeroBalancePositions to throw (to reproduce the historical abort).",
    "    --debug-sell            Enables window._fdvDebugSellEval during the sim.",
    "  --quick-start            Interactive setup: generates a new wallet, waits for funding, then starts a bot with defaults.",
    "    --rpc-url <url>         RPC URL to use (or set FDV_RPC_URL). Defaults to SOLANA_RPC_URL/mainnet.",
    "    --rpc-headers <json>    Optional JSON headers for RPC (or set FDV_RPC_HEADERS).",
    "    --bot <name>            Which bot to start (auto|follow|hold|volume|sniper|flame).",
    "  --flame                  Starts Sniper in Flame mode (auto-picks mint from pumping leaders).",
    "    --rpc-url <url>         RPC URL to use (or set FDV_RPC_URL). Defaults to SOLANA_RPC_URL/mainnet.",
    "    --rpc-headers <json>    Optional JSON headers for RPC (or set FDV_RPC_HEADERS).",
    "    --wallet-secret <val>   Wallet secret (base58 64-byte secretKey, or json array string). (or set FDV_WALLET_SECRET).",
    "  --run-profile            Runs bots headlessly (no UI) using a named profile (auto/follow/sniper/hold/volume).",
    "    --profiles <pathOrUrl>  Profiles JSON file path or https URL.",
    "    --profile <name>        Profile name to select from the profiles file.",
    "    --log-to-console        Mirrors widget logs to stdout.",
    "  --no-splash              Disables the startup splash banner.",
    "  --help                   Shows this help.",
    "",
  ].join("\n");
}

async function maybePrintSplash(flags) {
  try {
    const noSplash = flags?.has?.("--no-splash") || String(process?.env?.FDV_NO_SPLASH || "").trim() === "1";
    if (noSplash) return;

    const splashUrl = new URL("./splash.gary", import.meta.url);
    let text = await readFile(splashUrl, "utf8");
    const motd = String(process?.env?.FDV_MOTD || "Stay safe. Verify mints. NFA.").trim();
    text = String(text || "").replaceAll("{{MOTD}}", motd);

    const out = String(text || "").trimEnd();
    if (!out) return;
    console.log(out + "\n");
  } catch (e) {
    if (String(process?.env?.FDV_SPLASH_DEBUG || "").trim() === "1") {
      try { console.error(`(splash) failed: ${e?.message || e}`); } catch {}
    }
  }
}

function _isNodeLike() {
  return typeof process !== "undefined" && !!process.versions?.node;
}

function _sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function _envFlag(name, defaultValue = false) {
  const raw = String(process?.env?.[name] ?? "").trim();
  if (!raw) return !!defaultValue;
  if (/^(1|true|yes|y|on)$/i.test(raw)) return true;
  if (/^(0|false|no|n|off)$/i.test(raw)) return false;
  return !!defaultValue;
}

async function _cliGetWalletSnap({ rpcUrl, rpcHeaders, autoWalletSecret, maxAgeMs = 3500, forceFresh = false } = {}) {
  const now = Date.now();
  if (!forceFresh && _cliLastWalletSnap && (now - Number(_cliLastWalletSnapAt || 0)) <= Math.max(250, Number(maxAgeMs || 0))) {
    return _cliLastWalletSnap;
  }

  if (_cliWalletSnapInFlight) {
    try { return await _cliWalletSnapInFlight; } catch { return null; }
  }

  _cliWalletSnapInFlight = (async () => {
    const snap = await __fdvCli_nodeWalletStatusSnapshot({ rpcUrl, rpcHeaders, autoWalletSecret });
    _cliLastWalletSnap = snap;
    _cliLastWalletSnapAt = Date.now();
    return snap;
  })();

  try {
    return await _cliWalletSnapInFlight;
  } catch {
    return null;
  } finally {
    _cliWalletSnapInFlight = null;
  }
}

function _installHeadlessAutoOverridesForCliRecon({ autoMod, rpcUrl, rpcHeaders, autoWalletSecret } = {}) {
  try {
    const prev = (globalThis.__fdvAutoBotOverrides && typeof globalThis.__fdvAutoBotOverrides === "object")
      ? globalThis.__fdvAutoBotOverrides
      : {};
    const next = { ...prev, headless: true };

    // In headless CLI, we do our own on-chain reconciliation (including Token-2022).
    // The browser module's prune can mistakenly delete real positions when it can't
    // resolve the right token program (or when scans intermittently fail).
    const allowPrune = _envFlag("FDV_CLI_ALLOW_PRUNE", false);
    if (!allowPrune) {
      next.pruneZeroBalancePositions = async () => {};
    }

    // Avoid purge-on-verify in headless mode, but still provide sizeUi so sell preflight
    // doesn't stall at "no on-chain size".
    const keepVerify = _envFlag("FDV_CLI_KEEP_VERIFY", false);
    if (!keepVerify) {
      next.verifyRealTokenBalance = async (ownerStr, mint, pos) => {
        const mintStr = String(mint || "").trim();
        const fallbackPosSize = Number(pos?.sizeUi || 0);

        const debugVerify = _envFlag("FDV_CLI_VERIFY_DEBUG", false);
        const _dbg = (msg) => {
          if (!debugVerify) return;
          try { console.log(`[CLI verify] ${msg}`); } catch {}
        };

        // Try a couple times; RPC scans can be intermittently incomplete.
        // We only fall back to the cached position size when the scan isn't known-good.
        const attempts = fallbackPosSize > 0 ? 3 : 1;

        try {
          let lastReason = "";
          for (let i = 0; i < attempts; i++) {
            const forceFresh = i > 0;
            const snap = await _cliGetWalletSnap({ rpcUrl, rpcHeaders, autoWalletSecret, maxAgeMs: forceFresh ? 0 : 900, forceFresh }).catch(() => null);

            const owner = String(snap?.owner || "").trim();
            const scanOk = !!snap?.tokenScanOk;
            const snapAge = snap ? (Date.now() - Number(_cliLastWalletSnapAt || 0)) : -1;

            if (snap && owner && ownerStr && String(ownerStr) !== owner) {
              lastReason = "owner_mismatch";
              _dbg(`mint=${mintStr.slice(0, 4)}… owner mismatch (snap=${owner.slice(0, 4)}… wanted=${String(ownerStr).slice(0, 4)}…)`);
              return { ok: true, sizeUi: fallbackPosSize, purged: false, unverified: true, reason: lastReason };
            }

            const balances = Array.isArray(snap?.balances) ? snap.balances : [];
            const hit = balances.find((b) => String(b?.mint || "").trim() === mintStr);
            const chainSizeUi = Number(hit?.uiAmt || 0);

            if (Number.isFinite(chainSizeUi) && chainSizeUi > 1e-9) {
              _dbg(`mint=${mintStr.slice(0, 4)}… chain size=${chainSizeUi} (scanOk=${scanOk ? 1 : 0} age=${snapAge}ms)`);
              return { ok: true, sizeUi: chainSizeUi, purged: false, unverified: !scanOk, program: hit?.program };
            }

            if (scanOk) {
              // scanOk=true and still not found/zero: treat as true zero; let preflight skip.
              lastReason = hit ? "scan_ok_zero" : "scan_ok_miss";
              _dbg(`mint=${mintStr.slice(0, 4)}… chain size=0 (scanOk=1 age=${snapAge}ms reason=${lastReason})`);
              return { ok: true, sizeUi: 0, purged: false, unverified: false, reason: lastReason };
            }

            // scanOk=false: retry a couple times before falling back.
            lastReason = hit ? "scan_incomplete_hit_zero" : "scan_incomplete_miss";
            if (i < attempts - 1) {
              _dbg(`mint=${mintStr.slice(0, 4)}… retrying (scanOk=0 age=${snapAge}ms reason=${lastReason})`);
              await _sleep(200 + 300 * i);
              continue;
            }

            if (fallbackPosSize > 1e-9) {
              _dbg(`mint=${mintStr.slice(0, 4)}… fallback size=${fallbackPosSize} (scanOk=0 age=${snapAge}ms reason=${lastReason})`);
              return { ok: true, sizeUi: fallbackPosSize, purged: false, unverified: true, reason: lastReason };
            }
          }

          return { ok: true, sizeUi: fallbackPosSize, purged: false, unverified: true, reason: lastReason || "retries_exhausted" };
        } catch {
          return { ok: true, sizeUi: fallbackPosSize, purged: false, unverified: true, reason: "snap_failed" };
        }
      };
    }

    autoMod.__fdvDebug_setOverrides?.(next);
  } catch {}
}

function _stopCliMintReconciler() {
  try { if (typeof _cliMintReconStop === "function") _cliMintReconStop(); } catch {}
  _cliMintReconStop = null;
}

function _startCliMintReconciler({ rpcUrl, rpcHeaders, autoWalletSecret, intervalMs = 2000, debug = false } = {}) {
  _stopCliMintReconciler();

  const reconEnabled = _envFlag("FDV_CLI_RECON", true);
  if (!reconEnabled) return;

  const { updatePosCache, cacheToList, removeFromPosCache } = createPosCacheStore({
    keyPrefix: "fdv_pos_",
    log: debug ? (m) => { try { console.log(`[CLI recon] ${m}`); } catch {} } : () => {},
  });

  // Conservative "confirmed zero" cleanup (non-destructive):
  // only remove a cached mint after several consecutive *scanOk* snapshots show it at zero.
  const zeroConfirmNeeded = Math.max(2, Number(process?.env?.FDV_CLI_RECON_ZERO_CONFIRM || 3));
  const zeroStreak = new Map();

  let stopped = false;
  let running = false;

  const runOnce = async () => {
    if (stopped || running) return;
    running = true;
    try {
      const snap = await __fdvCli_nodeWalletStatusSnapshot({ rpcUrl, rpcHeaders, autoWalletSecret });

      // Make latest snapshot available to the headless verify override.
      _cliLastWalletSnap = snap;
      _cliLastWalletSnapAt = Date.now();

      const owner = String(snap?.owner || "").trim();
      const balances = Array.isArray(snap?.balances) ? snap.balances : [];
      const scanOk = !!snap?.tokenScanOk;

      const onChainNonZero = new Set(
        balances
          .filter((x) => Number(x?.uiAmt || 0) > 0)
          .map((x) => String(x?.mint || "").trim())
          .filter(Boolean)
      );

      // Update-only: never delete here (deletes are what burned us).
      if (owner) {
        for (const b of balances) {
          const mint = String(b?.mint || "").trim();
          if (!mint || mint === SOL_MINT) continue;
          const uiAmt = Number(b?.uiAmt || 0);
          if (!Number.isFinite(uiAmt) || uiAmt <= 0) continue;
          updatePosCache(owner, mint, uiAmt, Number(b?.decimals || 0));
        }

        // Confirmed-zero cleanup: only when scanOk=true.
        if (scanOk) {
          const cachedList = cacheToList(owner);
          const cached = Array.isArray(cachedList) ? cachedList : [];
          for (const p of cached) {
            const mint = String(p?.mint || "").trim();
            if (!mint || mint === SOL_MINT) continue;

            if (onChainNonZero.has(mint)) {
              zeroStreak.delete(mint);
              continue;
            }

            const nextCount = Number(zeroStreak.get(mint) || 0) + 1;
            zeroStreak.set(mint, nextCount);

            if (nextCount >= zeroConfirmNeeded) {
              try {
                removeFromPosCache(owner, mint);
              } catch {}
              zeroStreak.delete(mint);
              if (debug) {
                try { console.log(`[CLI recon] Confirmed-zero purge mint=${mint.slice(0, 4)}… after ${zeroConfirmNeeded} scans`); } catch {}
              }
            }
          }
        }
      }

      try {
        localStorage.setItem(
          CLI_RECON_LS_KEY,
          JSON.stringify({
            at: Date.now(),
            owner,
            ok: !!snap?.tokenScanOk,
            mints: balances.filter((x) => Number(x?.uiAmt || 0) > 0).map((x) => String(x?.mint || "")),
          })
        );
      } catch {}
    } catch (e) {
      if (debug) {
        try { console.error(`[CLI recon] scan failed: ${e?.message || e}`); } catch {}
      }
    } finally {
      running = false;
    }
  };

  // Kick once immediately to populate cache before first sell-eval.
  runOnce().catch(() => {});
  const timer = setInterval(() => { runOnce().catch(() => {}); }, Math.max(500, Number(intervalMs || 0) || 2000));

  _cliMintReconStop = () => {
    stopped = true;
    try { clearInterval(timer); } catch {}
  };
}

const SOL_MINT = "So11111111111111111111111111111111111111112";
const TOKEN_PROGRAM_ID_STR = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const TOKEN_2022_PROGRAM_ID_STR = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
const ATA_PROGRAM_ID_STR = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL";
const SYSVAR_RENT_STR = "SysvarRent111111111111111111111111111111111";

let _nodeWeb3Promise = null;
let _nodeBs58Promise = null;

async function ensureNodeWeb3() {
  if (_nodeWeb3Promise) return _nodeWeb3Promise;
  _nodeWeb3Promise = (async () => {
    // Prefer the locally bundled web3 (no extra network), fall back to CDN loader.
    try {
      await ensureSolanaWeb3Shim();
      const local = globalThis?.window?.solanaWeb3 || globalThis?.solanaWeb3;
      if (local?.Connection && local?.PublicKey && local?.Transaction) return local;
    } catch {}

    const web3 = await loadSolanaWeb3FromWeb();
    if (!web3?.Connection || !web3?.PublicKey || !web3?.Transaction) throw new Error("Node web3 not available");
    return web3;
  })();
  return _nodeWeb3Promise;
}

async function ensureNodeBs58() {
  if (_nodeBs58Promise) return _nodeBs58Promise;
  _nodeBs58Promise = (async () => {
    const mod = await import("./helpers/bs58.node.js");
    const bs58 = mod?.default || mod?.bs58 || mod;
    if (!bs58?.decode || !bs58?.encode) throw new Error("Node bs58 not available");
    return bs58;
  })();
  return _nodeBs58Promise;
}

async function __fdvCli_nodeWalletStatusSnapshot({ rpcUrl, rpcHeaders, autoWalletSecret } = {}) {
  const signerKp = await _nodeKeypairFromSecret(autoWalletSecret);
  const conn = await _nodeConnection({ rpcUrl, rpcHeaders });
  const ownerPk = signerKp.publicKey;
  const owner = ownerPk.toBase58();

  const solLamports = await conn.getBalance(ownerPk, "confirmed").catch(() => 0);
  const scan = await _scanTokenAccounts(conn, ownerPk);
  const balances = [];
  for (const a of scan.accounts || []) {
    const mint = String(a.mint || "").trim();
    if (!mint || mint === SOL_MINT) continue;
    const raw = String(a.amountRaw || "0");
    if (!/^\d+$/.test(raw) || raw === "0") continue;
    const dec = Number(a.decimals || 0) || 0;
    const uiAmt = Number(raw) / Math.pow(10, Math.max(0, dec));
    balances.push({ mint, uiAmt, amountRaw: raw, decimals: dec, program: a.programId });
  }
  return { owner, solLamports: Number(solLamports || 0), balances, tokenScanOk: !!scan.ok, tokenScanErrors: scan.errs || [] };
}

async function _nodeKeypairFromSecret(autoWalletSecret) {
  const web3 = await ensureNodeWeb3();
  const bs58 = await ensureNodeBs58();
  const secret = String(autoWalletSecret || "").trim();
  if (!secret) throw new Error("Missing wallet secret");

  let secretBytes = null;
  if (secret.startsWith("[") && secret.endsWith("]")) {
    try {
      const arr = JSON.parse(secret);
      if (Array.isArray(arr)) secretBytes = Uint8Array.from(arr);
    } catch {}
  }
  if (!secretBytes) secretBytes = bs58.decode(secret);
  return web3.Keypair.fromSecretKey(Uint8Array.from(secretBytes));
}

async function _nodeConnection({ rpcUrl, rpcHeaders } = {}) {
  const web3 = await ensureNodeWeb3();
  const url = String(rpcUrl || "").trim() || String(DEFAULT_SOLANA_RPC_URL || "https://api.mainnet-beta.solana.com").trim();
  return new web3.Connection(url, {
    commitment: "confirmed",
    confirmTransactionInitialTimeout: 60_000,
    disableRetryOnRateLimit: true,
    httpHeaders: rpcHeaders && typeof rpcHeaders === "object" ? rpcHeaders : undefined,
  });
}

function _u64le(nBig) {
  const b = Buffer.alloc(8);
  let x = BigInt(nBig);
  for (let i = 0; i < 8; i++) {
    b[i] = Number(x & 0xffn);
    x >>= 8n;
  }
  return new Uint8Array(b);
}

async function _ataAddress(ownerPk, mintPk, tokenProgramIdPk) {
  const web3 = await ensureNodeWeb3();
  const ATA_PROGRAM_ID = new web3.PublicKey(ATA_PROGRAM_ID_STR);
  const [ata] = web3.PublicKey.findProgramAddressSync(
    [ownerPk.toBuffer(), tokenProgramIdPk.toBuffer(), mintPk.toBuffer()],
    ATA_PROGRAM_ID,
  );
  return ata;
}

async function _ixCreateAta({ payerPk, ataPk, ownerPk, mintPk, tokenProgramIdPk } = {}) {
  const web3 = await ensureNodeWeb3();
  const ATA_PROGRAM_ID = new web3.PublicKey(ATA_PROGRAM_ID_STR);
  const SYSVAR_RENT = new web3.PublicKey(SYSVAR_RENT_STR);
  return new web3.TransactionInstruction({
    programId: ATA_PROGRAM_ID,
    keys: [
      { pubkey: payerPk, isSigner: true, isWritable: true },
      { pubkey: ataPk, isSigner: false, isWritable: true },
      { pubkey: ownerPk, isSigner: false, isWritable: false },
      { pubkey: mintPk, isSigner: false, isWritable: false },
      { pubkey: web3.SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: tokenProgramIdPk, isSigner: false, isWritable: false },
      { pubkey: SYSVAR_RENT, isSigner: false, isWritable: false },
    ],
    data: new Uint8Array(),
  });
}

async function _ixTokenTransfer({ sourcePk, destPk, ownerPk, amountRaw, tokenProgramIdPk } = {}) {
  const web3 = await ensureNodeWeb3();
  const amt = BigInt(String(amountRaw || "0").trim() || "0");
  const data = new Uint8Array([3, ..._u64le(amt)]); // Transfer = 3
  return new web3.TransactionInstruction({
    programId: tokenProgramIdPk,
    keys: [
      { pubkey: sourcePk, isSigner: false, isWritable: true },
      { pubkey: destPk, isSigner: false, isWritable: true },
      { pubkey: ownerPk, isSigner: true, isWritable: false },
    ],
    data,
  });
}

async function _ixTokenClose({ accountPk, destPk, ownerPk, tokenProgramIdPk } = {}) {
  const web3 = await ensureNodeWeb3();
  const data = new Uint8Array([9]); // CloseAccount = 9
  return new web3.TransactionInstruction({
    programId: tokenProgramIdPk,
    keys: [
      { pubkey: accountPk, isSigner: false, isWritable: true },
      { pubkey: destPk, isSigner: false, isWritable: true },
      { pubkey: ownerPk, isSigner: true, isWritable: false },
    ],
    data,
  });
}

async function _sendTx(conn, signerKp, ixs, { commitment = "confirmed", maxRetries = 2 } = {}) {
  const web3 = await ensureNodeWeb3();
  if (!ixs?.length) return { ok: true, sig: "" };
  const tx = new web3.Transaction();
  for (const ix of ixs) tx.add(ix);
  tx.feePayer = signerKp.publicKey;
  tx.recentBlockhash = (await conn.getLatestBlockhash("processed")).blockhash;
  tx.sign(signerKp);
  const sig = await conn.sendRawTransaction(tx.serialize(), { preflightCommitment: "processed", maxRetries });
  try { await conn.confirmTransaction(sig, commitment); } catch {}
  return { ok: true, sig };
}

async function _scanTokenAccounts(conn, ownerPk) {
  const web3 = await ensureNodeWeb3();
  const programs = [TOKEN_PROGRAM_ID_STR, TOKEN_2022_PROGRAM_ID_STR];
  const accounts = [];
  const errs = [];
  let okAny = false;
  for (const pid of programs) {
    try {
      const resp = await conn.getParsedTokenAccountsByOwner(ownerPk, { programId: new web3.PublicKey(pid) }, "confirmed");
      okAny = true;
      for (const it of resp?.value || []) {
        const info = it?.account?.data?.parsed?.info;
        const mint = String(info?.mint || "").trim();
        const ta = info?.tokenAmount || {};
        const amountRaw = String(ta?.amount ?? "0");
        const decimals = Number(ta?.decimals ?? 0);
        const pubkey = String(it?.pubkey?.toBase58?.() || "");
        if (!mint || !pubkey) continue;
        accounts.push({ pubkey, mint, programId: pid, amountRaw, decimals });
      }
    } catch (e) {
      errs.push(`${pid}: ${e?.message || e}`);
    }
  }
  return { ok: okAny, errs, accounts };
}

async function _ensureAta(conn, signerKp, mintStr, tokenProgramIdStr) {
  const web3 = await ensureNodeWeb3();
  const mintPk = new web3.PublicKey(String(mintStr || "").trim());
  const tokenPid = new web3.PublicKey(String(tokenProgramIdStr || TOKEN_PROGRAM_ID_STR).trim());
  const ataPk = await _ataAddress(signerKp.publicKey, mintPk, tokenPid);
  const ai = await conn.getAccountInfo(ataPk, "processed").catch(() => null);
  if (ai) return { ataPk, created: false };
  const ix = await _ixCreateAta({ payerPk: signerKp.publicKey, ataPk, ownerPk: signerKp.publicKey, mintPk, tokenProgramIdPk: tokenPid });
  await _sendTx(conn, signerKp, [ix], { commitment: "confirmed", maxRetries: 2 });
  return { ataPk, created: true };
}

async function _consolidateMintAccountsToAta(conn, signerKp, mintStr, tokenProgramIdStr, tokenAccounts) {
  const web3 = await ensureNodeWeb3();
  const tokenPid = new web3.PublicKey(String(tokenProgramIdStr || "").trim());
  const { ataPk } = await _ensureAta(conn, signerKp, mintStr, tokenProgramIdStr);
  const ataStr = ataPk.toBase58();

  const outs = (tokenAccounts || []).filter((a) => a.mint === mintStr && a.programId === tokenProgramIdStr && a.pubkey !== ataStr && String(a.amountRaw || "0") !== "0");
  if (!outs.length) return { moved: false };

  // Transfer in batches to avoid TX size issues.
  const movedSigs = [];
  const BATCH = 6;
  for (let i = 0; i < outs.length; i += BATCH) {
    const slice = outs.slice(i, i + BATCH);
    const ixs = [];
    for (const a of slice) {
      ixs.push(await _ixTokenTransfer({
        sourcePk: new web3.PublicKey(a.pubkey),
        destPk: ataPk,
        ownerPk: signerKp.publicKey,
        amountRaw: a.amountRaw,
        tokenProgramIdPk: tokenPid,
      }));
    }
    const res = await _sendTx(conn, signerKp, ixs, { commitment: "confirmed", maxRetries: 2 });
    if (res?.sig) movedSigs.push(res.sig);
    await _sleep(120);
  }

  // Best-effort close emptied non-ATA accounts.
  try {
    const closeIxs = [];
    for (const a of outs) {
      closeIxs.push(await _ixTokenClose({
        accountPk: new web3.PublicKey(a.pubkey),
        destPk: signerKp.publicKey,
        ownerPk: signerKp.publicKey,
        tokenProgramIdPk: tokenPid,
      }));
    }
    const CLOSE_BATCH = 8;
    for (let i = 0; i < closeIxs.length; i += CLOSE_BATCH) {
      await _sendTx(conn, signerKp, closeIxs.slice(i, i + CLOSE_BATCH), { commitment: "confirmed", maxRetries: 2 });
      await _sleep(120);
    }
  } catch {}

  return { moved: true, movedSigs };
}

async function _fetchJsonWith429(url, { method = "GET", headers = {}, body = null, retries = 5 } = {}) {
  const u = String(url || "").trim();
  if (!u) throw new Error("fetch: missing url");

  const dohResolveIp = async (hostname) => {
    const name = String(hostname || "").trim();
    if (!name) throw new Error("doh: missing hostname");

    const https = await import("node:https");

    const cloudflareQuery = async (qname, qtype) => {
      const dohIp = String(process?.env?.FDV_DOH_IP || "1.1.1.1").trim() || "1.1.1.1";
      const dohHost = String(process?.env?.FDV_DOH_HOST || "cloudflare-dns.com").trim() || "cloudflare-dns.com";
      const dohPath = `/dns-query?name=${encodeURIComponent(qname)}&type=${encodeURIComponent(String(qtype || "A"))}`;
      const timeoutMs = 12_000;
      const raw = await new Promise((resolve, reject) => {
        const req = https.request(
          {
            host: dohIp,
            servername: dohHost,
            method: "GET",
            path: dohPath,
            headers: {
              host: dohHost,
              accept: "application/dns-json",
              "user-agent": "fdv.lol",
            },
            timeout: timeoutMs,
          },
          (res) => {
            const chunks = [];
            res.on("data", (c) => chunks.push(c));
            res.on("end", () => {
              const txt = Buffer.concat(chunks).toString("utf8");
              if ((res.statusCode || 0) < 200 || (res.statusCode || 0) >= 300) {
                return reject(new Error(`DoH failed ${res.statusCode || 0} ${res.statusMessage || ""}: ${txt}`.trim()));
              }
              resolve(txt);
            });
          }
        );
        req.on("timeout", () => {
          try { req.destroy(new Error(`DoH timeout after ${timeoutMs}ms`)); } catch {}
        });
        req.on("error", reject);
        req.end();
      });
      return JSON.parse(raw || "{}");
    };

    const googleQuery = async (qname, qtype) => {
      // Google DoH JSON API; uses normal DNS to resolve dns.google, but many networks allow it.
      const url = `https://dns.google/resolve?name=${encodeURIComponent(qname)}&type=${encodeURIComponent(String(qtype || "A"))}`;
      const timeoutMs = 12_000;
      const raw = await new Promise((resolve, reject) => {
        const req = https.request(
          url,
          {
            method: "GET",
            headers: { accept: "application/json", "user-agent": "fdv.lol" },
            timeout: timeoutMs,
          },
          (res) => {
            const chunks = [];
            res.on("data", (c) => chunks.push(c));
            res.on("end", () => {
              const txt = Buffer.concat(chunks).toString("utf8");
              if ((res.statusCode || 0) < 200 || (res.statusCode || 0) >= 300) {
                return reject(new Error(`DoH failed ${res.statusCode || 0} ${res.statusMessage || ""}: ${txt}`.trim()));
              }
              resolve(txt);
            });
          }
        );
        req.on("timeout", () => {
          try { req.destroy(new Error(`DoH timeout after ${timeoutMs}ms`)); } catch {}
        });
        req.on("error", reject);
        req.end();
      });
      return JSON.parse(raw || "{}");
    };

    const parseIps = (j) => {
      const answers = Array.isArray(j?.Answer) ? j.Answer : [];
      const ips4 = answers
        .filter((a) => Number(a?.type) === 1)
        .map((a) => String(a?.data || "").trim())
        .filter((ip) => /^\d+\.\d+\.\d+\.\d+$/.test(ip));
      const ips6 = answers
        .filter((a) => Number(a?.type) === 28)
        .map((a) => String(a?.data || "").trim())
        .filter((ip) => ip.includes(":"));
      const cnames = answers
        .filter((a) => Number(a?.type) === 5)
        .map((a) => String(a?.data || "").trim().replace(/\.$/, ""))
        .filter(Boolean);
      return { ips4, ips6, cnames };
    };

    // Default to Cloudflare, with optional Google fallback.
    const preferred = String(process?.env?.FDV_DOH_PROVIDER || "cloudflare").trim().toLowerCase();
    const allowGoogleFallback = String(process?.env?.FDV_DOH_ALLOW_GOOGLE || "1").trim() !== "0";
    const providers = [];
    if (preferred === "google") providers.push("google");
    else providers.push("cloudflare");
    if (allowGoogleFallback) {
      if (!providers.includes("cloudflare")) providers.push("cloudflare");
      if (!providers.includes("google")) providers.push("google");
    }

    const errsByProvider = {};
    for (const provider of providers) {
      try {
        const query = provider === "google" ? googleQuery : cloudflareQuery;
        let current = name;
        for (let depth = 0; depth < 6; depth++) {
          const jA = await query(current, "A");
          const statusA = Number(jA?.Status);
          const { ips4, cnames } = parseIps(jA);
          if (ips4.length) return { ip: ips4[0], family: 4 };
          if (cnames.length) {
            current = cnames[0];
            continue;
          }
          // If no A records, try AAAA once before giving up.
          const jAAAA = await query(current, "AAAA");
          const statusAAAA = Number(jAAAA?.Status);
          const { ips6, cnames: cnames6 } = parseIps(jAAAA);
          if (ips6.length) return { ip: ips6[0], family: 6 };
          if (cnames6.length) {
            current = cnames6[0];
            continue;
          }

          const st = Number.isFinite(statusA) ? statusA : Number.isFinite(statusAAAA) ? statusAAAA : -1;
          // Status=0 means NOERROR, but can still come back with no answers due to filtering/blocking.
          if (st === 0) {
            const c = String(jA?.Comment || jAAAA?.Comment || "").trim();
            throw new Error(`DoH ${provider}: NO_ANSWER${c ? ` (${c})` : ""}`);
          }
          const hint = st === 3 ? "NXDOMAIN" : st === 2 ? "SERVFAIL" : st === 5 ? "REFUSED" : `Status=${st}`;
          throw new Error(`DoH ${provider}: ${hint}`);
        }
        throw new Error(`DoH ${provider}: CNAME chain too deep`);
      } catch (e) {
        errsByProvider[provider] = String(e?.message || e || "unknown");
      }
    }

    const parts = Object.entries(errsByProvider)
      .map(([p, m]) => `${p}: ${m}`)
      .filter(Boolean);
    throw new Error(`DoH failed${parts.length ? ` (${parts.join("; ")})` : ""}`);
  };

  const nodeFetchText = async () => {
    const parsed = new URL(u);
    const isHttps = parsed.protocol === "https:";
    const mod = await import(isHttps ? "node:https" : "node:http");
    const timeoutMs = 20_000;

    const doRequest = async ({ lookupIp = "", family = 4 } = {}) => {
      return await new Promise((resolve, reject) => {
        const req = mod.request(
          {
            method,
            protocol: parsed.protocol,
            hostname: parsed.hostname,
            port: parsed.port,
            path: `${parsed.pathname}${parsed.search}`,
            headers: {
              accept: "application/json",
              "content-type": "application/json",
              "user-agent": "fdv.lol",
              ...headers,
            },
            timeout: timeoutMs,
            ...(lookupIp
              ? {
                  lookup: (_host, _opts, cb) => cb(null, lookupIp, Number(family) === 6 ? 6 : 4),
                  servername: parsed.hostname,
                }
              : null),
          },
          (res) => {
            const chunks = [];
            res.on("data", (c) => chunks.push(c));
            res.on("end", () => {
              const txt = Buffer.concat(chunks).toString("utf8");
              resolve({ status: res.statusCode || 0, statusText: res.statusMessage || "", text: txt });
            });
          }
        );
        req.on("timeout", () => {
          try { req.destroy(new Error(`timeout after ${timeoutMs}ms`)); } catch {}
        });
        req.on("error", reject);
        if (body != null) req.write(JSON.stringify(body));
        req.end();
      });
    };

    try {
      return await doRequest({ lookupIp: "" });
    } catch (e) {
      const code = String(e?.code || "").toUpperCase();
      if (code !== "ENOTFOUND" && code !== "EAI_AGAIN") throw e;
      // DNS failure: try DoH resolution and retry with a fixed lookup IP.
      const r = await dohResolveIp(parsed.hostname);
      return await doRequest({ lookupIp: r?.ip || "", family: r?.family || 4 });
    }
  };

  let waitMs = 500;
  let lastErr = null;
  for (let i = 0; i <= retries; i++) {
    try {
      // Prefer global fetch, but fall back to node:http(s) when fetch fails.
      if (typeof fetch === "function") {
        try {
          const resp = await fetch(u, {
            method,
            headers: {
              accept: "application/json",
              "content-type": "application/json",
              ...headers,
            },
            body: body != null ? JSON.stringify(body) : undefined,
          });
          const txt = await resp.text().catch(() => "");
          if (resp.status === 429) {
            console.error(`Server responded with 429 Too Many Requests. Retrying after ${waitMs}ms delay...`);
            try { globalThis._fdvRpcBackoffUntil = Date.now() + waitMs; } catch {}
            await _sleep(waitMs);
            waitMs = Math.min(12_000, waitMs * 2);
            lastErr = new Error(`429 ${txt}`);
            continue;
          }
          if (!resp.ok) throw new Error(`${resp.status} ${resp.statusText}: ${txt}`);
          return txt ? JSON.parse(txt) : null;
        } catch (e) {
          // Some environments (WSL/corp networks) fail via undici fetch but succeed via node:https.
          lastErr = e;
        }
      }

      const res = await nodeFetchText();
      if (res.status === 429) {
        console.error(`Server responded with 429 Too Many Requests. Retrying after ${waitMs}ms delay...`);
        try { globalThis._fdvRpcBackoffUntil = Date.now() + waitMs; } catch {}
        await _sleep(waitMs);
        waitMs = Math.min(12_000, waitMs * 2);
        lastErr = new Error(`429 ${res.text || ""}`);
        continue;
      }
      if (res.status < 200 || res.status >= 300) throw new Error(`${res.status} ${res.statusText}: ${String(res.text || "").slice(0, 500)}`);
      return res.text ? JSON.parse(res.text) : null;
    } catch (e) {
      lastErr = e;
      await _sleep(Math.min(2000, 250 + i * 250));
    }
  }
  const msg = String(lastErr?.message || lastErr || "fetch failed");
  throw new Error(`fetch failed for ${u}: ${msg}`);
}

async function _jupSwapSellToSol({ conn, signerKp, mintStr, amountRawStr, slippageBps = 3500 } = {}) {
  const web3 = await ensureNodeWeb3();
  const inputMint = String(mintStr || "").trim();
  const outputMint = SOL_MINT;
  const amount = String(amountRawStr || "").trim();
  if (!inputMint || !amount || amount === "0") return { ok: false, code: "NO_AMOUNT", msg: "missing amount" };

  const base = String(process?.env?.FDV_JUP_BASE_URL || "https://api.jup.ag").trim() || "https://api.jup.ag";
  const apiKey = String(process?.env?.FDV_JUP_API_KEY || process?.env?.JUP_API_KEY || "").trim();
  if (!apiKey) throw new Error("Missing Jupiter API key. Set FDV_JUP_API_KEY (get one at https://portal.jup.ag/)");
  const q = new URL(`${base.replace(/\/+$/, "")}/swap/v1/quote`);
  q.searchParams.set("inputMint", inputMint);
  q.searchParams.set("outputMint", outputMint);
  q.searchParams.set("amount", amount);
  q.searchParams.set("slippageBps", String(Math.max(1, slippageBps | 0)));
  q.searchParams.set("restrictIntermediateTokens", "true");

  const quote = await _fetchJsonWith429(q.toString(), { method: "GET", headers: { "x-api-key": apiKey } });
  if (!quote) return { ok: false, code: "NO_QUOTE", msg: "empty quote" };

  const swap = await _fetchJsonWith429(`${base.replace(/\/+$/, "")}/swap/v1/swap`, {
    method: "POST",
    headers: { "x-api-key": apiKey },
    body: {
      quoteResponse: quote,
      userPublicKey: signerKp.publicKey.toBase58(),
      dynamicComputeUnitLimit: true,
    },
  });

  const b64 = String(swap?.swapTransaction || "").trim();
  if (!b64) return { ok: false, code: "NO_TX", msg: "swapTransaction missing" };

  const raw = Buffer.from(b64, "base64");
  let sig = "";
  try {
    if (web3.VersionedTransaction?.deserialize) {
      const vtx = web3.VersionedTransaction.deserialize(raw);
      vtx.sign([signerKp]);
      sig = await conn.sendRawTransaction(vtx.serialize(), { skipPreflight: false, maxRetries: 3 });
    } else {
      const tx = web3.Transaction.from(raw);
      tx.sign(signerKp);
      sig = await conn.sendRawTransaction(tx.serialize(), { skipPreflight: false, maxRetries: 3 });
    }
  } catch (e) {
    return { ok: false, code: "SEND_FAIL", msg: String(e?.message || e || "") };
  }

  try { await conn.confirmTransaction(sig, "confirmed"); } catch {}
  return { ok: true, sig };
}

async function __fdvCli_nodeSellAllToSolReport({ rpcUrl, rpcHeaders, autoWalletSecret, slippageBps = 3500 } = {}) {
  const web3 = await ensureNodeWeb3();
  const signerKp = await _nodeKeypairFromSecret(autoWalletSecret);
  const conn = await _nodeConnection({ rpcUrl, rpcHeaders });
  const ownerPk = signerKp.publicKey;

  const scan = await _scanTokenAccounts(conn, ownerPk);
  const accounts = scan.accounts || [];
  const byMint = new Map();

  for (const a of accounts) {
    const mint = a.mint;
    if (!mint || mint === SOL_MINT) continue;
    const raw = String(a.amountRaw || "0");
    if (!/^\d+$/.test(raw) || raw === "0") continue;
    if (!byMint.has(mint)) byMint.set(mint, { tokenProgramIds: new Set(), totalRawByPid: new Map() });
    const rec = byMint.get(mint);
    rec.tokenProgramIds.add(a.programId);
    const prev = BigInt(rec.totalRawByPid.get(a.programId) || "0");
    rec.totalRawByPid.set(a.programId, (prev + BigInt(raw)).toString());
  }

  const sold = [];
  const failed = [];

  for (const [mint, rec] of byMint.entries()) {
    for (const pid of Array.from(rec.tokenProgramIds)) {
      const totalRaw = String(rec.totalRawByPid.get(pid) || "0");
      if (!/^\d+$/.test(totalRaw) || totalRaw === "0") continue;
      try {
        await _consolidateMintAccountsToAta(conn, signerKp, mint, pid, accounts);
      } catch {}
      const res = await _jupSwapSellToSol({ conn, signerKp, mintStr: mint, amountRawStr: totalRaw, slippageBps });
      if (res?.ok) sold.push({ mint, programId: pid, amountRaw: totalRaw, sig: res.sig });
      else failed.push({ mint, programId: pid, amountRaw: totalRaw, code: res?.code || "FAIL", msg: res?.msg || "" });
      await _sleep(250);
    }
  }

  try {
    const closeIxs = [];
    for (const pid of [TOKEN_PROGRAM_ID_STR, TOKEN_2022_PROGRAM_ID_STR]) {
      const tokenPid = new web3.PublicKey(pid);
      const wsolAta = await _ataAddress(ownerPk, new web3.PublicKey(SOL_MINT), tokenPid);
      const ai = await conn.getAccountInfo(wsolAta, "processed").catch(() => null);
      if (!ai) continue;
      closeIxs.push(await _ixTokenClose({ accountPk: wsolAta, destPk: ownerPk, ownerPk, tokenProgramIdPk: tokenPid }));
    }
    if (closeIxs.length) await _sendTx(conn, signerKp, closeIxs, { commitment: "confirmed", maxRetries: 2 });
  } catch {}

  try {
    const closeIxs = [];
    for (const a of accounts) {
      if (String(a.amountRaw || "0") !== "0") continue;
      const pid = a.programId;
      if (pid !== TOKEN_PROGRAM_ID_STR && pid !== TOKEN_2022_PROGRAM_ID_STR) continue;
      closeIxs.push(await _ixTokenClose({
        accountPk: new web3.PublicKey(a.pubkey),
        destPk: ownerPk,
        ownerPk,
        tokenProgramIdPk: new web3.PublicKey(pid),
      }));
    }
    const BATCH = 8;
    for (let i = 0; i < closeIxs.length; i += BATCH) {
      await _sendTx(conn, signerKp, closeIxs.slice(i, i + BATCH), { commitment: "confirmed", maxRetries: 2 });
      await _sleep(120);
    }
  } catch {}

  return { sold, failed, tokenScanOk: scan.ok, tokenScanErrors: scan.errs };
}

async function __fdvCli_nodeReturnAllSolToRecipient({ rpcUrl, rpcHeaders, autoWalletSecret, recipientPub, keepLamports = 1_000_000 } = {}) {
  const web3 = await ensureNodeWeb3();
  const signerKp = await _nodeKeypairFromSecret(autoWalletSecret);
  const conn = await _nodeConnection({ rpcUrl, rpcHeaders });

  const dest = String(recipientPub || "").trim();
  if (!dest) throw new Error("recipient missing");

  const bal = await conn.getBalance(signerKp.publicKey, "confirmed").catch(() => 0);
  const sendLamports = Math.max(0, Number(bal || 0) - Math.max(0, Number(keepLamports || 0)));
  if (sendLamports <= 0) return { ok: false, sentLamports: 0 };

  const tx = new web3.Transaction().add(
    web3.SystemProgram.transfer({
      fromPubkey: signerKp.publicKey,
      toPubkey: new web3.PublicKey(dest),
      lamports: sendLamports,
    })
  );
  tx.feePayer = signerKp.publicKey;
  tx.recentBlockhash = (await conn.getLatestBlockhash("processed")).blockhash;
  tx.sign(signerKp);
  const sig = await conn.sendRawTransaction(tx.serialize(), { preflightCommitment: "processed", maxRetries: 2 });
  try { await conn.confirmTransaction(sig, "confirmed"); } catch {}
  return { ok: true, sig, sentLamports: sendLamports };
}

function _fmtSol(sol) {
  const n = Number(sol);
  if (!Number.isFinite(n)) return "0";
  if (n === 0) return "0";
  if (n >= 1) return n.toFixed(4).replace(/0+$/, "").replace(/\.$/, "");
  return n.toFixed(6).replace(/0+$/, "").replace(/\.$/, "");
}

function _parseJsonArg(s) {
  try {
    if (s == null) return null;
    const raw = String(s || "").trim();
    if (!raw) return null;
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function _hash12(s) {
  try {
    return crypto.createHash("sha256").update(String(s || "")).digest("hex").slice(0, 12);
  } catch {
    return "000000000000";
  }
}

function _randHex(nBytes = 6) {
  try {
    return crypto.randomBytes(Math.max(1, Number(nBytes || 6) | 0)).toString("hex");
  } catch {
    return String(Math.random()).slice(2);
  }
}

function _nowStamp() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

function _safeName(s) {
  return String(s || "")
    .trim()
    .replace(/[^a-zA-Z0-9._-]+/g, "_")
    .slice(0, 64) || "default";
}

function getCliSessionKey() {
  const parts = [
    String(process?.env?.FDV_CLI_SESSION || "").trim(),
    String(process?.env?.FDV_BASE_URL || "").trim(),
    String(process?.cwd?.() || "").trim(),
    String(process?.env?.USER || process?.env?.USERNAME || "").trim(),
  ].filter(Boolean);
  return parts.join("|") || "fdv";
}

async function ensureDir(p) {
  await mkdir(p, { recursive: true });
}

async function readJsonFileOrNull(filePath) {
  try {
    const raw = await readFile(filePath, "utf8");
    const doc = JSON.parse(raw);
    return doc && typeof doc === "object" ? doc : null;
  } catch {
    return null;
  }
}

async function writeJsonAtomic(filePath, obj) {
  const dir = path.dirname(filePath);
  await ensureDir(dir);
  const tmpPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(tmpPath, JSON.stringify(obj, null, 2) + "\n", "utf8");
  await rename(tmpPath, filePath);
}

async function getTempProfileStorePaths() {
  const root = path.join(os.tmpdir(), "fdv-cli", _hash12(getCliSessionKey()));
  const profilesPath = path.join(root, "profiles.json");
  const historyDir = path.join(root, "history");
  await ensureDir(historyDir);
  return { root, profilesPath, historyDir };
}

async function loadTempProfilesDoc() {
  const { profilesPath } = await getTempProfileStorePaths();
  const doc = await readJsonFileOrNull(profilesPath);
  if (doc && typeof doc === "object") {
    if (!doc.profiles || typeof doc.profiles !== "object") doc.profiles = {};
    return doc;
  }
  return { profiles: {} };
}

async function saveTempProfilesDoc(doc, { reason = "save", profileName = "" } = {}) {
  const { profilesPath, historyDir } = await getTempProfileStorePaths();
  await writeJsonAtomic(profilesPath, doc);

  // Best-effort backups.
  try {
    const stamp = _nowStamp();
    const fname = `${stamp}_${_safeName(reason)}${profileName ? "_" + _safeName(profileName) : ""}.json`;
    const backupPath = path.join(historyDir, fname);
    await writeJsonAtomic(backupPath, doc);
  } catch {}

  return profilesPath;
}

function upsertProfile(doc, name, profile) {
  const n = String(name || "").trim();
  if (!n) throw new Error("missing profile name");
  if (!doc || typeof doc !== "object") throw new Error("invalid profiles doc");
  if (!doc.profiles || typeof doc.profiles !== "object") doc.profiles = {};
  doc.profiles[n] = profile && typeof profile === "object" ? profile : {};
  return doc.profiles[n];
}

async function promptNumber(question, { defaultValue = 0, min = -Infinity, max = Infinity, allowBlank = true } = {}) {
  while (true) {
    const s = await promptLine(question, { defaultValue: allowBlank ? String(defaultValue) : "" });
    const raw = String(s || "").trim();
    const n = Number(raw);
    if (!Number.isFinite(n)) {
      console.log("Please enter a number.");
      continue;
    }
    if (n < min || n > max) {
      console.log(`Out of range. Expected ${min}..${max}.`);
      continue;
    }
    return n;
  }
}

async function promptChoice(question, choices = [], { defaultIndex = 0, allowCancel = true } = {}) {
  const list = Array.isArray(choices) ? choices.filter(Boolean) : [];
  if (!list.length) throw new Error("promptChoice: missing choices");

  const norm = (v) => String(v || "").trim().toLowerCase();
  while (true) {
    console.log(String(question || "").trim());
    for (let i = 0; i < list.length; i++) {
      console.log(`  ${i + 1}) ${String(list[i])}`);
    }
    if (allowCancel) console.log("  q) cancel");

    const dv = (Number.isFinite(Number(defaultIndex)) && defaultIndex >= 0 && defaultIndex < list.length)
      ? String(defaultIndex + 1)
      : "";
    const raw = await promptLine("Select", { defaultValue: dv });
    const v = norm(raw);
    if (allowCancel && (v === "q" || v === "quit" || v === "cancel")) return null;

    const n = Number(v);
    if (Number.isFinite(n) && n >= 1 && n <= list.length) return list[n - 1];

    // Allow direct string match too.
    const hit = list.find((x) => norm(x) === v);
    if (hit) return hit;

    console.log("Invalid choice. Try again.");
  }
}

function _maskSecret(s) {
  try {
    const v = String(s || "").trim();
    if (!v) return "";
    if (v.length <= 8) return "***";
    return `${v.slice(0, 3)}…${v.slice(-4)}`;
  } catch {
    return "";
  }
}

function _getEnvKeyForProvider(provider) {
  try {
    const p = String(provider || "").trim().toLowerCase();
    const env = (typeof process !== "undefined" && process && process.env) ? process.env : {};
    const pick = (...names) => {
      for (const n of names) {
        const v = String(env?.[n] || "").trim();
        if (v) return v;
      }
      return "";
    };
    if (p === "gemini") return pick("GEMINI_API_KEY", "FDV_GEMINI_KEY");
    if (p === "grok") return pick("GROK_API_KEY", "XAI_API_KEY", "FDV_GROK_KEY");
    if (p === "deepseek") return pick("DEEPSEEK_API_KEY", "FDV_DEEPSEEK_KEY");
    return pick("OPENAI_API_KEY", "FDV_OPENAI_KEY");
  } catch {
    return "";
  }
}

function _lsKeyForProvider(provider) {
  const p = String(provider || "").trim().toLowerCase();
  if (p === "gemini") return "fdv_gemini_key";
  if (p === "grok") return "fdv_grok_key";
  if (p === "deepseek") return "fdv_deepseek_key";
  return "fdv_openai_key";
}

function applyAgentGaryFullAiToStorage({ provider, model, riskLevel, apiKey } = {}) {
  try {
    if (typeof localStorage === "undefined") return false;
    const p = String(provider || "").trim().toLowerCase() || "openai";
    const m = String(model || "").trim() || (p === "gemini" ? "gemini-1.5-flash" : (p === "deepseek" ? "deepseek-chat" : (p === "grok" ? "grok-beta" : "gpt-4o-mini")));
    const r = String(riskLevel || "safe").trim().toLowerCase();
    const rl = (r === "safe" || r === "medium" || r === "degen") ? r : "safe";
    const k = String(apiKey || "").trim();

    localStorage.setItem("fdv_agent_enabled", "true");
    localStorage.setItem("fdv_agent_risk", rl);
    localStorage.setItem("fdv_llm_provider", p);
    localStorage.setItem("fdv_llm_model", m);
    localStorage.setItem("fdv_agent_full_control", "true");
    if (k) localStorage.setItem(_lsKeyForProvider(p), k);
    return true;
  } catch {
    return false;
  }
}

function applyAgentGaryFullAiOverrides({ provider, model, riskLevel, apiKey } = {}) {
  try {
    const p = String(provider || "").trim().toLowerCase() || "openai";
    const m = String(model || "").trim();
    const r = String(riskLevel || "safe").trim().toLowerCase();
    const rl = (r === "safe" || r === "medium" || r === "degen") ? r : "safe";
    const k = String(apiKey || "").trim();

    if (!globalThis.__fdvAgentOverrides || typeof globalThis.__fdvAgentOverrides !== "object") {
      globalThis.__fdvAgentOverrides = {};
    }

    // Keep this provider-agnostic; the agent driver will normalize.
    globalThis.__fdvAgentOverrides = {
      ...(globalThis.__fdvAgentOverrides || {}),
      enabled: true,
      riskLevel: rl,
      llmProvider: p,
      llmModel: m,
      llmApiKey: k,
      apiKey: k,
      openaiApiKey: p === "openai" ? k : "",
    };
    return true;
  } catch {
    return false;
  }
}

function configureAutoProfileForRisk(riskLevel, existing = {}) {
  const out = existing && typeof existing === "object" ? { ...existing } : {};
  out.enabled = true;
  const r = String(riskLevel || "safe").trim().toLowerCase();
  const rl = (r === "safe" || r === "medium" || r === "degen") ? r : "safe";

  if (rl === "safe") {
    out.buyPct = 0.15;
    out.maxBuySol = 1;
    out.slippageBps = 220;
    out.takeProfitPct = 10;
    out.stopLossPct = 4;
    out.coolDownSecsAfterBuy = 5;
    out.minHoldSecs = 60;
    out.maxHoldSecs = 120;
  } else if (rl === "medium") {
    out.buyPct = 0.22;
    out.maxBuySol = 1.25;
    out.slippageBps = 300;
    out.takeProfitPct = 14;
    out.stopLossPct = 6;
    out.coolDownSecsAfterBuy = 3;
    out.minHoldSecs = 45;
    out.maxHoldSecs = 90;
  } else {
    out.buyPct = 0.32;
    out.maxBuySol = 2;
    out.slippageBps = 450;
    out.takeProfitPct = 22;
    out.stopLossPct = 12;
    out.coolDownSecsAfterBuy = 2;
    out.minHoldSecs = 30;
    out.maxHoldSecs = 75;
  }

  return out;
}

async function configureAgentGaryFullAiWizard(existing = {}) {
  const ex = existing && typeof existing === "object" ? existing : {};

  console.log("\nAuto mode: Agent Gary (full AI) setup (required)");
  console.log("You will pick: model, risk, and API key.\n");

  const supportedModels = [
    "gary-predictions-v1",
    "gpt-4o-mini",
    "gpt-4.1-mini",
    "gpt-4o",
    "gpt-5-nano",
    "gemini-2.5-flash-lite",
    "grok-3-mini",
    "deepseek-chat",
  ];

  const modelDefault = String(ex.llmModel || ex.model || ex.openaiModel || "gpt-4o-mini").trim();
  const defaultIndex = Math.max(0, supportedModels.indexOf(modelDefault));
  const modelPick = await promptChoice(
    "Select model:",
    supportedModels,
    { defaultIndex, allowCancel: true }
  );
  if (!modelPick) return { canceled: true };
  const model = String(modelPick).trim();

  const inferProvider = (m) => {
    const mm = String(m || "").trim().toLowerCase();
    if (mm === "gary-predictions-v1" || mm.startsWith("gary-")) return "gary";
    if (mm.startsWith("gemini-")) return "gemini";
    if (mm.startsWith("grok-")) return "grok";
    if (mm.startsWith("deepseek-")) return "deepseek";
    return "openai";
  };
  const provider = inferProvider(model);

  const riskDefault = String(ex.riskLevel || "safe").trim().toLowerCase();
  const riskPick = await promptChoice(
    "Select risk preset:",
    ["safe", "medium", "degen"],
    { defaultIndex: Math.max(0, ["safe", "medium", "degen"].indexOf(riskDefault)), allowCancel: true }
  );
  if (!riskPick) return { canceled: true };
  const riskLevel = String(riskPick).trim().toLowerCase();

  let apiKey = "";
  while (true) {
    const raw = await promptLine(`${provider} API key (paste; input hidden not supported)`, { defaultValue: "" });
    const v = String(raw || "").trim();
    if (!v) {
      console.log("API key is required to start auto mode. Paste it or type 'q' to cancel.");
      continue;
    }
    if (v.toLowerCase() === "q" || v.toLowerCase() === "quit" || v.toLowerCase() === "cancel") {
      return { canceled: true };
    }
    apiKey = v;
    break;
  }

  return {
    canceled: false,
    agent: { enabled: true, llmProvider: provider, llmModel: model, riskLevel },
    apiKey,
  };
}

async function configureAutoProfileInteractive(existing = {}) {
  // Auto bot is powerful; force an explicit config pass.
  const out = existing && typeof existing === "object" ? { ...existing } : {};
  out.enabled = true;

  console.log("\nAuto trader config (required):");
  console.log("Enter values or press Enter to accept defaults.");

  out.buyPct = await promptNumber("buyPct (fraction of wallet per buy, e.g. 0.2)", {
    defaultValue: Number.isFinite(Number(out.buyPct)) ? Number(out.buyPct) : 0.2,
    min: 0.01,
    max: 0.9,
  });

  out.maxBuySol = await promptNumber("maxBuySol (cap per buy in SOL)", {
    defaultValue: Number.isFinite(Number(out.maxBuySol)) ? Number(out.maxBuySol) : 1,
    min: 1,
    max: 50,
  });

  out.slippageBps = Math.floor(
    await promptNumber("slippageBps (e.g. 250 = 2.5%)", {
      defaultValue: Number.isFinite(Number(out.slippageBps)) ? Number(out.slippageBps) : 250,
      min: 50,
      max: 5000,
    })
  );

  out.takeProfitPct = await promptNumber("takeProfitPct (e.g. 12)", {
    defaultValue: Number.isFinite(Number(out.takeProfitPct)) ? Number(out.takeProfitPct) : 12,
    min: 0,
    max: 1000,
  });

  out.stopLossPct = await promptNumber("stopLossPct (e.g. 4)", {
    defaultValue: Number.isFinite(Number(out.stopLossPct)) ? Number(out.stopLossPct) : 4,
    min: 0,
    max: 1000,
  });

  out.coolDownSecsAfterBuy = await promptNumber("coolDownSecsAfterBuy", {
    defaultValue: Number.isFinite(Number(out.coolDownSecsAfterBuy)) ? Number(out.coolDownSecsAfterBuy) : 3,
    min: 0,
    max: 120,
  });

  out.minHoldSecs = await promptNumber("minHoldSecs", {
    defaultValue: Number.isFinite(Number(out.minHoldSecs)) ? Number(out.minHoldSecs) : 60,
    min: 0,
    max: 24 * 60 * 60,
  });

  out.maxHoldSecs = await promptNumber("maxHoldSecs (0 = no max)", {
    defaultValue: Number.isFinite(Number(out.maxHoldSecs)) ? Number(out.maxHoldSecs) : 50,
    min: 0,
    max: 24 * 60 * 60,
  });

  console.log("\nAuto config set.");
  return out;
}

async function promptBool(question, { defaultValue = false } = {}) {
  while (true) {
    const dv = defaultValue ? "y" : "n";
    const raw = await promptLine(`${String(question || "").trim()} (y/n)`, { defaultValue: dv });
    const v = String(raw || "").trim().toLowerCase();
    if (!v) return !!defaultValue;
    if (v === "y" || v === "yes" || v === "1" || v === "true") return true;
    if (v === "n" || v === "no" || v === "0" || v === "false") return false;
    console.log("Please enter y or n (or press Enter for default).");
  }
}

async function configureHoldProfileInteractive(existing = {}) {
  const out = existing && typeof existing === "object" ? { ...existing } : {};
  out.enabled = true;

  console.log("\nHold config:");
  console.log("Press Enter to accept defaults.");

  out.pollMs = Math.floor(await promptNumber("pollMs", {
    defaultValue: Number.isFinite(Number(out.pollMs)) ? Number(out.pollMs) : 1500,
    min: 250,
    max: 60000,
  }));

  out.buyPct = await promptNumber("buyPct (percent of wallet per buy)", {
    defaultValue: Number.isFinite(Number(out.buyPct)) ? Number(out.buyPct) : 25,
    min: 1,
    max: 90,
  });

  out.profitPct = await promptNumber("profitPct (take-profit percent)", {
    defaultValue: Number.isFinite(Number(out.profitPct)) ? Number(out.profitPct) : 5,
    min: 0,
    max: 1000,
  });

  out.rugSevThreshold = await promptNumber("rugSevThreshold (>= triggers sell/stop)", {
    defaultValue: Number.isFinite(Number(out.rugSevThreshold)) ? Number(out.rugSevThreshold) : 1.0,
    min: 0,
    max: 10,
  });

  out.uptickEnabled = await promptBool("uptickEnabled", { defaultValue: out.uptickEnabled != null ? !!out.uptickEnabled : true });
  out.repeatBuy = await promptBool("repeatBuy", { defaultValue: out.repeatBuy != null ? !!out.repeatBuy : false });

  console.log("Hold config set.");
  return out;
}

async function configureSniperProfileInteractive(existing = {}) {
  const out = existing && typeof existing === "object" ? { ...existing } : {};
  out.enabled = true;

  console.log("\nSentry/Sniper config:");
  console.log("Press Enter to accept defaults.");

  out.pollMs = Math.floor(await promptNumber("pollMs", {
    defaultValue: Number.isFinite(Number(out.pollMs)) ? Number(out.pollMs) : 1200,
    min: 250,
    max: 60000,
  }));

  out.buyPct = await promptNumber("buyPct (percent of wallet per buy)", {
    defaultValue: Number.isFinite(Number(out.buyPct)) ? Number(out.buyPct) : 25,
    min: 1,
    max: 90,
  });

  out.triggerScoreSlopeMin = await promptNumber("triggerScoreSlopeMin", {
    defaultValue: Number.isFinite(Number(out.triggerScoreSlopeMin)) ? Number(out.triggerScoreSlopeMin) : 0.6,
    min: 0,
    max: 20,
  });

  console.log("Sniper config set.");
  return out;
}

async function configureVolumeProfileInteractive(existing = {}) {
  const out = existing && typeof existing === "object" ? { ...existing } : {};
  out.enabled = true;

  console.log("\nVolume config:");
  console.log("Press Enter to accept defaults.");

  out.bots = Math.floor(await promptNumber("bots", {
    defaultValue: Number.isFinite(Number(out.bots)) ? Number(out.bots) : 1,
    min: 1,
    max: 25,
  }));

  out.minBuyAmountSol = await promptNumber("minBuyAmountSol", {
    defaultValue: Number.isFinite(Number(out.minBuyAmountSol)) ? Number(out.minBuyAmountSol) : 0.005,
    min: 0.0001,
    max: 50,
  });

  out.maxBuyAmountSol = await promptNumber("maxBuyAmountSol", {
    defaultValue: Number.isFinite(Number(out.maxBuyAmountSol)) ? Number(out.maxBuyAmountSol) : 0.02,
    min: 0.0001,
    max: 50,
  });

  out.maxSlippageBps = Math.floor(await promptNumber("maxSlippageBps", {
    defaultValue: Number.isFinite(Number(out.maxSlippageBps)) ? Number(out.maxSlippageBps) : 2000,
    min: 50,
    max: 10000,
  }));

  out.targetVolumeSol = await promptNumber("targetVolumeSol (0 = unlimited)", {
    defaultValue: Number.isFinite(Number(out.targetVolumeSol)) ? Number(out.targetVolumeSol) : 0,
    min: 0,
    max: 10_000,
  });

  console.log("Volume config set.");
  return out;
}

async function promptLine(question, { defaultValue = "" } = {}) {
  const q = String(question || "").trimEnd();
  const dv = String(defaultValue || "");
  const suffix = dv ? ` [default: ${dv}]` : "";

  // When running via `curl ... | node --input-type=module -`, stdin is a closed pipe (not a TTY),
  // so interactive prompts must read from the controlling terminal instead.
  const debug = String(process?.env?.FDV_PROMPT_DEBUG || "").trim() === "1";

  let cleanup = () => {};
  let input = process.stdin;
  let output = process.stdout;
  let terminal = !!process.stdin?.isTTY;
  let ttyFdIn = null;
  let ttyFdOut = null;

  // Prefer a real TTY for input if stdin isn't a TTY.
  if (!process.stdin?.isTTY) {
    const ttyInPath = process.platform === "win32" ? "CONIN$" : "/dev/tty";
    try {
      ttyFdIn = openSync(ttyInPath, "r");
      input = new tty.ReadStream(ttyFdIn);
      terminal = true;
      const prev = cleanup;
      cleanup = () => {
        try { input.destroy?.(); } catch {}
        try { if (ttyFdIn != null) closeSync(ttyFdIn); } catch {}
        try { prev(); } catch {}
      };
      if (debug) {
        try { console.error(`(prompt) using TTY input: ${ttyInPath}`); } catch {}
      }
    } catch (e) {
      if (debug) {
        try { console.error(`(prompt) failed to open TTY input: ${e?.message || e}`); } catch {}
      }
    }
  }

  // If stdout isn't a TTY, try to write prompts to a TTY.
  if (!process.stdout?.isTTY) {
    const ttyOutPath = process.platform === "win32" ? "CONOUT$" : "/dev/tty";
    try {
      ttyFdOut = openSync(ttyOutPath, "w");
      output = new tty.WriteStream(ttyFdOut);
      terminal = true;
      const prev = cleanup;
      cleanup = () => {
        try { output.end?.(); } catch {}
        try { if (ttyFdOut != null) closeSync(ttyFdOut); } catch {}
        try { prev(); } catch {}
      };
      if (debug) {
        try { console.error(`(prompt) using TTY output: ${ttyOutPath}`); } catch {}
      }
    } catch (e) {
      if (debug) {
        try { console.error(`(prompt) failed to open TTY output: ${e?.message || e}`); } catch {}
      }
    }
  }

  // Final fallback: if input isn't a TTY and stdin is not usable, fail loudly.
  if (!terminal && !process.stdin?.isTTY) {
    throw new Error("Interactive prompt unavailable (no TTY)");
  }

  const rl = createInterface({ input, output, terminal });
  try {
    const answer = await new Promise((resolve) => rl.question(`${q}${suffix}\n> `, resolve));
    const out = String(answer || "").trim();
    return out || dv;
  } finally {
    try { rl.close(); } catch {}
    try { cleanup(); } catch {}
  }
}

async function requireRpcFromArgs({ flags, getValue }) {
  const rpcUrl = String(
    getValue("--rpc-url") ||
    process?.env?.FDV_RPC_URL ||
    process?.env?.SOLANA_RPC_URL ||
    ""
  ).trim();

  let rpcHeaders = _parseJsonArg(getValue("--rpc-headers") || process?.env?.FDV_RPC_HEADERS || null);

  // If not provided, fall back to what the rest of the app uses (localStorage or config default).
  let finalUrl = rpcUrl;
  if (!finalUrl) {
    try { finalUrl = String(globalThis?.localStorage?.getItem?.("fdv_rpc_url") || "").trim(); } catch {}
  }
  if (!finalUrl) finalUrl = String(DEFAULT_SOLANA_RPC_URL || "").trim();
  if (!finalUrl) finalUrl = "https://api.mainnet-beta.solana.com";

  if (!(rpcHeaders && typeof rpcHeaders === "object")) {
    try {
      const raw = globalThis?.localStorage?.getItem?.("fdv_rpc_headers");
      const parsed = _parseJsonArg(raw);
      if (parsed && typeof parsed === "object") rpcHeaders = parsed;
    } catch {}
  }

  return { rpcUrl: finalUrl, rpcHeaders: rpcHeaders && typeof rpcHeaders === "object" ? rpcHeaders : null };
}

async function getSolBalanceUi({ rpcUrl, rpcHeaders, pubkey }) {
  await ensureSolanaWeb3Shim();
  const web3 = globalThis?.window?.solanaWeb3 || globalThis?.solanaWeb3;
  if (!web3?.Connection) throw new Error("Missing solanaWeb3.Connection");

  const conn = new web3.Connection(rpcUrl, {
    commitment: "confirmed",
    confirmTransactionInitialTimeout: 60_000,
    disableRetryOnRateLimit: true,
    httpHeaders: rpcHeaders && typeof rpcHeaders === "object" ? rpcHeaders : undefined,
  });

  const pk = typeof pubkey === "string" ? new web3.PublicKey(pubkey) : pubkey;
  const lamports = await conn.getBalance(pk, "confirmed");
  return Number(lamports || 0) / 1_000_000_000;
}

async function generateWalletSecretBase58() {
  await ensureSolanaWeb3Shim();
  await ensureBs58Shim();
  const web3 = globalThis?.window?.solanaWeb3 || globalThis?.solanaWeb3;
  const bs58 = globalThis?.window?._fdvBs58Module || globalThis?.window?.bs58 || null;
  if (!web3?.Keypair?.generate) throw new Error("Missing solanaWeb3.Keypair.generate");
  if (!bs58?.encode) throw new Error("Missing bs58.encode");

  const kp = web3.Keypair.generate();
  const secretBytes = kp.secretKey;
  const secretB58 = bs58.encode(secretBytes);
  return {
    pubkey: kp.publicKey.toBase58(),
    secretB58,
    secretJson: JSON.stringify(Array.from(secretBytes)),
  };
}

async function parseWalletSecretToKeypair(secret) {
  await ensureSolanaWeb3Shim();
  await ensureBs58Shim();
  const web3 = globalThis?.window?.solanaWeb3 || globalThis?.solanaWeb3;
  const bs58 = globalThis?.window?._fdvBs58Module || globalThis?.window?.bs58 || null;
  if (!web3?.Keypair) throw new Error("Missing solanaWeb3.Keypair");
  if (!bs58?.decode || !bs58?.encode) throw new Error("Missing bs58");

  const s = String(secret || "").trim();
  if (!s) throw new Error("Missing secret");

  let secretBytes = null;
  if (s.startsWith("[") && s.endsWith("]")) {
    try {
      const arr = JSON.parse(s);
      if (Array.isArray(arr)) secretBytes = Uint8Array.from(arr);
    } catch {}
  }
  if (!secretBytes) secretBytes = bs58.decode(s);

  let kp = null;
  try {
    if (secretBytes?.length === 64) kp = web3.Keypair.fromSecretKey(Uint8Array.from(secretBytes));
    else if (secretBytes?.length === 32) kp = web3.Keypair.fromSeed(Uint8Array.from(secretBytes));
  } catch {}
  if (!kp?.publicKey?.toBase58 || !kp?.secretKey) throw new Error("Invalid secret");

  return {
    kp,
    pubkey: kp.publicKey.toBase58(),
    secretB58: bs58.encode(kp.secretKey),
    secretJson: JSON.stringify(Array.from(kp.secretKey)),
  };
}

async function waitForFunding({ rpcUrl, rpcHeaders, pubkey }) {
  while (true) {
    const bal = await getSolBalanceUi({ rpcUrl, rpcHeaders, pubkey }).catch(() => 0);
    console.log(`Balance: ${_fmtSol(bal)} SOL`);
    if (bal > 0) return bal;

    const ans = await promptLine("Wallet has 0 SOL. Fund it, then press Enter to re-check (or type 'q' to quit)", { defaultValue: "" });
    if (String(ans || "").toLowerCase() === "q") throw new Error("quick-start aborted");
    await _sleep(250);
  }
}

async function startBotWithDefaults({ bot, rpcUrl, rpcHeaders, autoWalletSecret, logToConsole, profileSink }) {
  ensureNodeShims();
  const name = String(bot || "").trim().toLowerCase();
  if (!name) throw new Error("Missing bot name");

  // This profile object can be persisted (quick-start / wizard) and also applied to localStorage.
  const profile = { rpcUrl, rpcHeaders, autoWalletSecret };
  applyGlobalRpcToStorage(profile);
  await applyAutoWalletToStorage(profile);

  // Many bots pull wallet/rpc from the shared auto-trader state (not only localStorage).
  // Make sure it's always hydrated before starting any bot.
  try {
    ensureNodeShims();
    const traderMod = await import("../trader/index.js");
    traderMod.__fdvCli_applyProfile?.({ rpcUrl, rpcHeaders, autoWalletSecret });
  } catch {}

  if (logToConsole) {
    try { globalThis.window._fdvLogToConsole = true; } catch {}
  }

  if (name === "auto" || name === "trader") {
    const autoMod = await import("../trader/index.js");
    _installHeadlessAutoOverridesForCliRecon({ autoMod, rpcUrl, rpcHeaders, autoWalletSecret });

    try {
      const g = (typeof window !== "undefined") ? window : globalThis;
      if (g && !g._fdvLogToConsole) g._fdvLogToConsole = true;
    } catch {}

    // Auto mode: strictly Agent Gary full AI wizard (model + risk + API key), then apply risk preset.
    const existingAgent = (profileSink && typeof profileSink === "object" && profileSink.agent && typeof profileSink.agent === "object")
      ? profileSink.agent
      : (profile && typeof profile === "object" && profile.agent && typeof profile.agent === "object")
        ? profile.agent
        : {};
    const wiz = await configureAgentGaryFullAiWizard(existingAgent);
    if (wiz?.canceled) return { status: "menu" };

    // Persist non-secret selections in the temp profile (provider/model/risk). Do NOT persist API keys.
    try {
      if (profileSink && typeof profileSink === "object") {
        profileSink.agent = { ...(profileSink.agent && typeof profileSink.agent === "object" ? profileSink.agent : {}), ...(wiz.agent || {}) };
      }
    } catch {}

    // Apply to runtime (agent driver reads overrides/localStorage).
    applyAgentGaryFullAiOverrides({ ...(wiz.agent || {}), apiKey: wiz.apiKey });
    applyAgentGaryFullAiToStorage({ ...(wiz.agent || {}), apiKey: wiz.apiKey });

    const configured = configureAutoProfileForRisk(wiz?.agent?.riskLevel || "safe", { ...(profile.auto || {}), ...(profile.trader || {}) });
    profile.auto = configured;
    try {
      if (profileSink && typeof profileSink === "object") {
        profileSink.auto = { ...(profileSink.auto && typeof profileSink.auto === "object" ? profileSink.auto : {}), ...configured, enabled: true };
      }
    } catch {}

    // Headless trader requires wallet secret in state (getAutoKeypair() uses state.autoWalletSecret).
    autoMod.__fdvCli_applyProfile({ rpcUrl, rpcHeaders, autoWalletSecret, ...configured });

    // Keep position cache reconciled from chain under Node (Token-2022 included).
    _startCliMintReconciler({
      rpcUrl,
      rpcHeaders,
      autoWalletSecret,
      intervalMs: _envFlag("FDV_CLI_RECON_FAST", false) ? 1200 : 2000,
      debug: _envFlag("FDV_CLI_RECON_DEBUG", false),
    });

    const ok = await autoMod.__fdvCli_start({ enable: true });
    if (!ok) throw new Error("AUTO_START_FAILED");
    return {
      status: "running",
      stopFn: async () => {
        _stopCliMintReconciler();
        return autoMod.__fdvCli_stop?.({ runFinalSellEval: false });
      },
    };
  }

  if (name === "follow") {
    let targetWallet = "";
    while (true) {
      const raw = await promptLine("Follow target wallet (pubkey)");
      const v = String(raw || "").trim();
      if (!v || v.toLowerCase() === "q") return { status: "menu" };
      const ok = await isValidSolanaPubkeyStr(v);
      if (ok) { targetWallet = v; break; }
      console.log("Invalid pubkey. Paste the full Solana address and try again (or 'q' to cancel).");
    }
    const followMod = await import("../follow/index.js");
    const code = await followMod.__fdvCli_start({
      enabled: true,
      targetWallet,
      buyPct: 25,
      maxHoldMin: 5,
      pollMs: 1500,
      rpcUrl,
      rpcHeaders,
      logToConsole,
    });
    if (code) throw new Error(`FOLLOW_START_FAILED:${code}`);
    return { status: "running", stopFn: async () => followMod.__fdvCli_stop?.() };
  }

  if (name === "hold") {
    let mint = "";
    while (true) {
      const raw = await promptLine("Hold mint (token address)");
      const v = String(raw || "").trim();
      if (!v || v.toLowerCase() === "q") return { status: "menu" };
      const ok = await isValidSolanaPubkeyStr(v);
      if (ok) { mint = v; break; }
      console.log("Invalid mint address. Paste the full token address and try again (or 'q' to cancel).");
    }

    // Walk through config before executing (Enter accepts defaults).
    const holdCfg = await configureHoldProfileInteractive(profile.hold || {});
    profile.hold = holdCfg;
    try { if (profileSink && typeof profileSink === "object") profileSink.hold = { ...(holdCfg || {}), enabled: true }; } catch {}
    const holdMod = await import("../hold/index.js");
    const code = await holdMod.__fdvCli_start({
      enabled: true,
      mint,
      buyPct: Number(holdCfg.buyPct ?? 25),
      profitPct: Number(holdCfg.profitPct ?? 5),
      pollMs: Math.floor(Number(holdCfg.pollMs ?? 1500)),
      rugSevThreshold: Number(holdCfg.rugSevThreshold ?? 1.0),
      repeatBuy: !!holdCfg.repeatBuy,
      uptickEnabled: !!holdCfg.uptickEnabled,
      rpcUrl,
      rpcHeaders,
      logToConsole,
    });
    if (code) throw new Error(`HOLD_START_FAILED:${code}`);
    return { status: "running", stopFn: async () => holdMod.__fdvCli_stop?.() };
  }

  if (name === "volume") {
    let mint = "";
    while (true) {
      const raw = await promptLine("Volume mint (token address)");
      const v = String(raw || "").trim();
      if (!v || v.toLowerCase() === "q") return { status: "menu" };
      const ok = await isValidSolanaPubkeyStr(v);
      if (ok) { mint = v; break; }
      console.log("Invalid mint address. Paste the full token address and try again (or 'q' to cancel).");
    }

    const volumeCfg = await configureVolumeProfileInteractive(profile.volume || {});
    profile.volume = volumeCfg;
    try { if (profileSink && typeof profileSink === "object") profileSink.volume = { ...(volumeCfg || {}), enabled: true }; } catch {}
    const volumeMod = await import("../volume/index.js");
    const code = await volumeMod.__fdvCli_start({
      enabled: true,
      mint,
      bots: Math.floor(Number(volumeCfg.bots ?? 1)),
      minBuyAmountSol: Number(volumeCfg.minBuyAmountSol ?? 0.005),
      maxBuyAmountSol: Number(volumeCfg.maxBuyAmountSol ?? 0.02),
      maxSlippageBps: Math.floor(Number(volumeCfg.maxSlippageBps ?? 2000)),
      targetVolumeSol: Number(volumeCfg.targetVolumeSol ?? 0),
      rpcUrl,
      rpcHeaders,
      logToConsole,
    });
    if (code) throw new Error(`VOLUME_START_FAILED:${code}`);
    return { status: "running", stopFn: async () => volumeMod.__fdvCli_stop?.() };
  }

  if (name === "sniper") {
    let mint = "";
    while (true) {
      const raw = await promptLine("Sniper mint (token address)");
      const v = String(raw || "").trim();
      if (!v || v.toLowerCase() === "q") return { status: "menu" };
      const ok = await isValidSolanaPubkeyStr(v);
      if (ok) { mint = v; break; }
      console.log("Invalid mint address. Paste the full token address and try again (or 'q' to cancel).");
    }

    const sniperCfg = await configureSniperProfileInteractive(profile.sniper || {});
    profile.sniper = sniperCfg;
    try { if (profileSink && typeof profileSink === "object") profileSink.sniper = { ...(sniperCfg || {}), enabled: true }; } catch {}
    const sniperMod = await import("../sniper/index.js");
    const code = await sniperMod.__fdvCli_start({
      enabled: true,
      mint,
      pollMs: Math.floor(Number(sniperCfg.pollMs ?? 1200)),
      buyPct: Number(sniperCfg.buyPct ?? 25),
      triggerScoreSlopeMin: Number(sniperCfg.triggerScoreSlopeMin ?? 0.6),
      rpcUrl,
      rpcHeaders,
      logToConsole,
    });
    if (code) throw new Error(`SNIPER_START_FAILED:${code}`);
    return { status: "running", stopFn: async () => sniperMod.__fdvCli_stop?.() };
  }

  if (name === "flame" || name === "sentry-flame" || name === "sentryflame") {
    return await runFlameMode({ rpcUrl, rpcHeaders, autoWalletSecret, logToConsole });
  }

  throw new Error(`Unknown bot: ${name}`);
}

async function waitForQuitKey({ label = "Running", quitKeys = ["q"], showHint = true } = {}) {
  const keys = new Set((quitKeys || ["q"]).map((k) => String(k || "").toLowerCase()).filter(Boolean));
  if (showHint) console.log(`${label}. Press 'q' to stop and return to menu (Ctrl+C to exit).`);

  const ttyInPath = process.platform === "win32" ? "CONIN$" : "/dev/tty";
  let fd = null;
  try {
    fd = openSync(ttyInPath, fsConstants.O_RDONLY | fsConstants.O_NONBLOCK);
  } catch {
    fd = openSync(ttyInPath, "r");
  }

  // Flush buffered bytes so a previous 'q' doesn't instantly stop the bot.
  try {
    const buf = Buffer.alloc(1024);
    for (let i = 0; i < 8; i++) {
      const n = readSync(fd, buf, 0, buf.length, null);
      if (!n) break;
    }
  } catch {}

  const input = new tty.ReadStream(fd);
  const rl = await import("node:readline");
  rl.emitKeypressEvents(input);
  if (typeof input.setRawMode === "function") input.setRawMode(true);

  return await new Promise((resolve) => {
    const onKeypress = (_str, key) => {
      try {
        const name = String(key?.name || "").toLowerCase();
        const ch = String(_str || key?.sequence || "").toLowerCase();
        if (key?.ctrl && name === "c") {
          // In raw mode, Ctrl+C won't raise SIGINT automatically.
          try { cleanup(); } catch {}
          try { process.exit(130); } catch {}
          return;
        }
        if (keys.has(name) || keys.has(ch)) resolve(name || ch);
      } catch {}
    };
    const cleanup = () => {
      try { input.off("keypress", onKeypress); } catch {}
      try { if (typeof input.setRawMode === "function") input.setRawMode(false); } catch {}
      try { input.destroy?.(); } catch {}
      try { closeSync(fd); } catch {}
    };
    input.on("keypress", onKeypress);
    input.on("close", () => { cleanup(); resolve("close"); });
    input.on("end", () => { cleanup(); resolve("end"); });
    input.on("error", () => { cleanup(); resolve("error"); });
  });
}

function _normalizeBotChoice(s) {
  const v = String(s || "").trim().toLowerCase();
  if (!v) return "";
  if (v === "1") return "auto";
  if (v === "2") return "follow";
  if (v === "3") return "hold";
  if (v === "4") return "volume";
  if (v === "5") return "flame";
  if (v === "6") return "return";
  if (v === "7") return "status";
  if (v === "8") return "rpc";
  return v;
}

function _isProbablyHttpUrl(s) {
  try {
    const u = new URL(String(s || "").trim());
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

async function unwindAllHoldingsToSol({ rpcUrl, rpcHeaders, autoWalletSecret, reason = "bot_exit" } = {}) {
  const sec = String(autoWalletSecret || "").trim();
  if (!sec) {
    console.log("Unwind skipped: missing wallet secret.");
    return;
  }
  //TODO: hide private key with a million $FDV in it
  //46LduB6z6LZD6Dg5nskq5n9gtrFvFsUCdfvdwaU6EKVqme9oHAYQ2pdz97PbQFvW5s3yqKUS7w8UnNTcKvf3tbqX

  console.log("Unwinding: selling all token balances -> SOL…");
  try {
    ensureNodeShims();
    const slipEnv = Number(process?.env?.FDV_UNWIND_SLIPPAGE_BPS || 0);
    const confirmEnv = Number(process?.env?.FDV_UNWIND_CONFIRM_MS || 0);
    const retriesEnv = Number(process?.env?.FDV_UNWIND_RETRIES || 0);
    const opts = {
      slippageBps: Number.isFinite(slipEnv) && slipEnv > 0 ? slipEnv : 3500,
      confirmMs: Number.isFinite(confirmEnv) && confirmEnv > 0 ? confirmEnv : 45_000,
      retries: Number.isFinite(retriesEnv) && retriesEnv > 0 ? retriesEnv : 3,
    };

    // Pending credits can land well after stop (especially under RPC stress).
    // Keep resweeping until we observe no token balances, or we time out.
    const maxMs = Math.max(20_000, Number(process?.env?.FDV_UNWIND_MAX_MS || 0) || 90_000);
    const start = Date.now();
    let lastNonEmptyAt = 0;
    let pass = 0;
    while (Date.now() - start < maxMs) {
      pass++;

      // If the trader armed an RPC backoff window (429/403/etc), respect it here.
      try {
        const until = Number(globalThis?.window?._fdvRpcBackoffUntil || globalThis?._fdvRpcBackoffUntil || 0);
        const left = until - Date.now();
        if (Number.isFinite(left) && left > 0) {
          const ms = Math.min(12_000, Math.max(350, Math.floor(left)));
          console.log(`Unwind: RPC backoff ~${Math.ceil(ms / 1000)}s…`);
          await _sleep(ms);
        }
      } catch {}

      await __fdvCli_nodeSellAllToSolReport({ rpcUrl, rpcHeaders, autoWalletSecret, slippageBps: opts.slippageBps });

      // Verify via Node-only parsed token accounts (Token + Token-2022).
      const st = await __fdvCli_nodeWalletStatusSnapshot({ rpcUrl, rpcHeaders, autoWalletSecret }).catch(() => null);
      if (st && st.tokenScanOk) {
        const n = Array.isArray(st.balances) ? st.balances.length : 0;
        if (n <= 0) {
          console.log("Unwind complete.");
          return;
        }
        lastNonEmptyAt = Date.now();
        const sample = st.balances.slice(0, 3).map((b) => `${String(b?.mint || "").slice(0, 4)}…`).join(", ");
        console.log(`Unwind: ${n} token(s) still held after pass ${pass}${sample ? ` (${sample})` : ""}`);
      } else {
        // If we can't verify due to RPC errors, back off and retry.
        console.log("Unwind: unable to verify balances (RPC error); retrying…");
      }

      // Adaptive backoff: small pause early, longer later.
      const age = Date.now() - start;
      const gap = age < 15_000 ? 2500 : age < 45_000 ? 4500 : 6500;
      await _sleep(gap);

      // If we've seen balances non-empty recently, keep going.
      if (lastNonEmptyAt && (Date.now() - lastNonEmptyAt) > 30_000) {
        // Haven't seen any verified token balance in a while; one final verify.
        const st2 = await __fdvCli_nodeWalletStatusSnapshot({ rpcUrl, rpcHeaders, autoWalletSecret }).catch(() => null);
        if (st2 && st2.tokenScanOk && !(st2.balances?.length)) {
          console.log("Unwind complete.");
          return;
        }
      }
    }

    console.log("Unwind finished (timeout). Tokens may still be held; try 'return' or 'status' again.");
  } catch (e) {
    console.error(`Unwind failed (${reason}): ${e?.message || e}`);
  }
}

async function showWalletStatus({ rpcUrl, rpcHeaders, autoWalletSecret } = {}) {
  const st = await __fdvCli_nodeWalletStatusSnapshot({ rpcUrl, rpcHeaders, autoWalletSecret });
  console.log("\nWallet status:");
  console.log(`  Address: ${st.owner}`);
  console.log(`  SOL:     ${_fmtSol(Number(st.solLamports || 0) / 1_000_000_000)} SOL`);

  if (!st?.tokenScanOk) {
    console.log("  Tokens:  (unknown - RPC error)");
    const first = Array.isArray(st?.tokenScanErrors) ? st.tokenScanErrors[0] : null;
    if (first) console.log(`  Note:    ${String(first).slice(0, 180)}`);
    return;
  }

  const balances = Array.isArray(st?.balances) ? st.balances : [];
  if (!balances.length) {
    console.log("  Tokens:  (none)");
    return;
  }

  balances.sort((a, b) => (Number(b.uiAmt || 0) - Number(a.uiAmt || 0)));
  console.log(`  Tokens:  ${balances.length}`);
  for (const b of balances.slice(0, 40)) {
    const short = `${b.mint.slice(0, 4)}…${b.mint.slice(-4)}`;
    const amt = Number.isFinite(Number(b.uiAmt))
      ? Number(b.uiAmt).toFixed(Math.min(6, Math.max(0, Number(b.decimals || 0))))
      : String(b.amountRaw || "?");
    console.log(`    ${short}  ${amt}`);
  }
  if (balances.length > 40) console.log(`    …and ${balances.length - 40} more`);
}

async function getWalletStatusSnapshot({ rpcUrl, rpcHeaders, autoWalletSecret } = {}) {
  // Prefer Node-only implementation in the headless CLI.
  try {
    if (isNodeLike()) return await __fdvCli_nodeWalletStatusSnapshot({ rpcUrl, rpcHeaders, autoWalletSecret });
  } catch {}

  await ensureSolanaWeb3Shim();
  await ensureBs58Shim();
  const web3 = globalThis?.window?.solanaWeb3 || globalThis?.solanaWeb3;
  const bs58 = globalThis?.window?._fdvBs58Module || globalThis?.window?.bs58 || null;
  if (!web3?.Connection || !web3?.PublicKey) throw new Error("Missing solanaWeb3");
  if (!web3?.Keypair) throw new Error("Missing solanaWeb3.Keypair");

  const secret = String(autoWalletSecret || "").trim();
  if (!secret) throw new Error("Missing wallet secret");

  let secretBytes = null;
  if (secret.startsWith("[") && secret.endsWith("]")) {
    try {
      const arr = JSON.parse(secret);
      if (Array.isArray(arr)) secretBytes = Uint8Array.from(arr);
    } catch {}
  }
  if (!secretBytes) {
    if (!bs58?.decode) throw new Error("Missing bs58.decode");
    secretBytes = bs58.decode(secret);
  }

  const kp = web3.Keypair.fromSecretKey(Uint8Array.from(secretBytes));
  const ownerPk = kp.publicKey;
  const owner = ownerPk.toBase58();

  const conn = new web3.Connection(String(rpcUrl || "").trim(), {
    commitment: "confirmed",
    confirmTransactionInitialTimeout: 60_000,
    disableRetryOnRateLimit: true,
    httpHeaders: rpcHeaders && typeof rpcHeaders === "object" ? rpcHeaders : undefined,
  });

  const solLamports = await conn.getBalance(ownerPk, "confirmed").catch(() => 0);

  const programIds = [
    "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
    "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb",
  ];

  const balances = [];
  const tokenScanErrors = [];
  let tokenScanOk = false;
  for (const pid of programIds) {
    try {
      const resp = await conn.getParsedTokenAccountsByOwner(ownerPk, { programId: new web3.PublicKey(pid) });
      tokenScanOk = true;
      for (const it of resp?.value || []) {
        const info = it?.account?.data?.parsed?.info;
        const mint = String(info?.mint || "").trim();
        const ta = info?.tokenAmount || {};
        const amountRaw = String(ta?.amount ?? "0");
        const dec = Number(ta?.decimals ?? 0);
        let uiAmt = Number(ta?.uiAmount);
        if (!Number.isFinite(uiAmt) || uiAmt === 0) {
          const uiStr = ta?.uiAmountString;
          if (uiStr != null && String(uiStr).trim() !== "") uiAmt = Number(uiStr);
          else if (amountRaw && amountRaw !== "0") uiAmt = Number(amountRaw) / Math.pow(10, Math.max(0, dec));
        }
        if (!mint) continue;
        if (!amountRaw || amountRaw === "0") continue;
        balances.push({ mint, uiAmt, amountRaw, decimals: dec, program: pid });
      }
    } catch (e) {
      tokenScanErrors.push(`${pid}: ${e?.message || e}`);
    }
  }

  return { owner, solLamports: Number(solLamports || 0), balances, tokenScanOk, tokenScanErrors };
}
async function isValidSolanaPubkeyStr(s) {
  try {
    const v = String(s || "").trim();
    if (!v) return false;
    await ensureSolanaWeb3Shim();
    const web3 = globalThis?.window?.solanaWeb3 || globalThis?.solanaWeb3;
    if (!web3?.PublicKey) return false;
    new web3.PublicKey(v);
    return true;
  } catch {
    return false;
  }
}

async function quickStartMenuLoop({ rpcUrl, rpcHeaders, autoWalletSecret, logToConsole, profilesDoc, profileName, tmpProfile } = {}) {
  while (true) {
    try {
      console.log("\nMain menu:");
      console.log("  1) auto    - auto trader (Full AI mode)");
      console.log("  2) follow  - follow a wallet");
      console.log("  3) hold    - hold a mint");
      console.log("  4) volume  - volume bot");
      console.log("  5) flame   - sniper flame mode");
      console.log("  6) return  - sell all -> SOL, then transfer SOL to a wallet");
      console.log("  7) status  - show wallet SOL + token balances");
      console.log("  8) rpc     - set RPC endpoint");

      const raw = await promptLine("Select (1-8, name)", { defaultValue: "" });
      const rawLower = String(raw || "").trim().toLowerCase();
      if (rawLower === "q" || rawLower === "quit" || rawLower === "exit") {
        console.log("Use Ctrl+C to exit the app.");
        continue;
      }

      const choice = _normalizeBotChoice(raw);

      if (!choice) continue;

      if (choice === "rpc") {
        console.log("\nRPC settings:");
        console.log(`  Current: ${String(rpcUrl || "").trim() || "(none)"}`);
        console.log("  Tip: A private/paid RPC helps avoid 429 rate limits.");

        while (true) {
          const rawUrl = await promptLine("New RPC URL (http/https) (Enter = keep current; 'default' = reset)", { defaultValue: "" });
          const v = String(rawUrl || "").trim();
          if (!v) break;

          if (v.toLowerCase() === "default") {
            rpcUrl = String(DEFAULT_SOLANA_RPC_URL || "https://api.mainnet-beta.solana.com").trim();
            rpcHeaders = null;
            break;
          }

          if (!_isProbablyHttpUrl(v)) {
            console.log("Invalid URL. Example: https://api.mainnet-beta.solana.com");
            continue;
          }

          rpcUrl = v;
          break;
        }

        try { applyGlobalRpcToStorage({ rpcUrl, rpcHeaders }); } catch {}
        try {
          if (tmpProfile && typeof tmpProfile === "object") {
            tmpProfile.rpcUrl = rpcUrl;
            tmpProfile.rpcHeaders = rpcHeaders;
          }
          if (profilesDoc && profileName) {
            upsertProfile(profilesDoc, profileName, { rpcUrl, rpcHeaders });
            await saveTempProfilesDoc(profilesDoc, { reason: "rpc_set", profileName });
          }
        } catch {}

        console.log(`RPC updated: ${rpcUrl}`);
        continue;
      }

      if (choice === "status") {
        try {
          await showWalletStatus({ rpcUrl, rpcHeaders, autoWalletSecret });
        } catch (e) {
          console.error(`Status failed: ${e?.message || e}`);
        }
        continue;
      }

      // Persist selection.
      try {
        if (tmpProfile && typeof tmpProfile === "object") tmpProfile.lastBot = choice;
        if (profilesDoc && profileName) await saveTempProfilesDoc(profilesDoc, { reason: "menu_select", profileName });
      } catch {}

      if (choice === "return") {
        // Sell first, then ask where to send SOL.
        console.log("\nReturn flow: selling all SPL -> SOL (this can take a bit)…");
        ensureNodeShims();

        const slipEnv = Number(process?.env?.FDV_UNWIND_SLIPPAGE_BPS || 0);
        const confirmEnv = Number(process?.env?.FDV_UNWIND_CONFIRM_MS || 0);
        const retriesEnv = Number(process?.env?.FDV_UNWIND_RETRIES || 0);
        const opts = {
          slippageBps: Number.isFinite(slipEnv) && slipEnv > 0 ? slipEnv : 3500,
          confirmMs: Number.isFinite(confirmEnv) && confirmEnv > 0 ? confirmEnv : 45_000,
          retries: Number.isFinite(retriesEnv) && retriesEnv > 0 ? retriesEnv : 3,
        };

        const allowEnv = String(process?.env?.FDV_RETURN_ALLOW_TOKENS || "").trim() === "1";
        let proceedDespiteTokens = false;
        let cancelReturn = false;

        // Loop here so (r)etry actually re-runs sells without bouncing back to menu.
        while (true) {
          let lastReport = null;
          try {
            // Do a few passes in case credits land late.
            for (let pass = 0; pass < 3; pass++) {
              lastReport = await __fdvCli_nodeSellAllToSolReport({
                rpcUrl,
                rpcHeaders,
                autoWalletSecret,
                slippageBps: opts.slippageBps,
              });
              if (pass < 2) await _sleep(2500);
            }
          } catch (e) {
            console.error(`Return flow failed during sells: ${e?.message || e}`);
            cancelReturn = true;
            break;
          }

          // Safety: do not transfer SOL away if any tokens remain (unless user explicitly proceeds).
          let st = null;
          try {
            st = await __fdvCli_nodeWalletStatusSnapshot({ rpcUrl, rpcHeaders, autoWalletSecret });
          } catch {}

          if (!st?.tokenScanOk) {
            console.log("Return blocked: unable to verify token balances (RPC rate limited / error).");
            try {
              const first = Array.isArray(lastReport?.tokenScanErrors) ? lastReport.tokenScanErrors[0] : "";
              if (first) console.log(`  Note: ${String(first).slice(0, 180)}`);
            } catch {}
            const ans = await promptLine("(r)etry, or (c)ancel", { defaultValue: "r" });
            const a = String(ans || "").trim().toLowerCase();
            if (a === "c" || a === "cancel") {
              cancelReturn = true;
              break;
            }
            continue;
          }

          if (!st?.balances?.length) {
            // Clean: proceed to recipient prompt.
            break;
          }

          console.log(`Return: ${st.balances.length} token(s) still held after sell sweep.`);

          // Show a compact summary of what the sweep actually attempted.
          try {
            const sold = Array.isArray(lastReport?.sold) ? lastReport.sold : [];
            const failed = Array.isArray(lastReport?.failed) ? lastReport.failed : [];
            const lastSig = sold.length ? String(sold[sold.length - 1]?.sig || "").trim() : "";
            if (sold.length || failed.length) {
              console.log(`Sell sweep summary: sold=${sold.length}, failed=${failed.length}${lastSig ? ` (last sig ${lastSig})` : ""}`);
            } else {
              const scanOk = lastReport?.tokenScanOk;
              const firstErr = Array.isArray(lastReport?.tokenScanErrors) ? lastReport.tokenScanErrors[0] : "";
              if (scanOk === false) {
                console.log(`Sell sweep summary: token scan failed; no attempts recorded${firstErr ? ` (${String(firstErr).slice(0, 160)})` : ""}.`);
              } else {
                console.log("Sell sweep summary: no sell attempts recorded (likely RPC scan issue or unknown token-account layout).");
              }
            }
          } catch {}

          // Surface the most recent failures (if available).
          try {
            const failed = Array.isArray(lastReport?.failed) ? lastReport.failed : [];
            if (failed.length) {
              const top = failed.slice(0, 3);
              console.log("Last sell failures:");
              for (const f of top) {
                const tag = String(f?.mint || "");
                const short = tag ? `${tag.slice(0, 4)}…${tag.slice(-4)}` : "(mint)";
                const code = String(f?.code || "FAIL");
                const msg = String(f?.msg || "").slice(0, 140);
                console.log(`  ${short}  ${code}${msg ? ` - ${msg}` : ""}`);
              }
            }
          } catch {}

          const solUi = Number(st.solLamports || 0) / 1_000_000_000;
          if (solUi < 0.01) console.log("Tip: SOL is low; add a bit for fees then retry.");

          if (allowEnv) {
            console.log("FDV_RETURN_ALLOW_TOKENS=1 set; proceeding to return SOL despite remaining tokens.");
            proceedDespiteTokens = true;
            break;
          }

          const ans = await promptLine("Tokens remain. (r)etry sells, (p)roceed to return SOL anyway, (c)ancel", { defaultValue: "c" });
          const a = String(ans || "").trim().toLowerCase();
          if (a === "r" || a === "retry") {
            continue;
          }
          if (a === "p" || a === "proceed") {
            proceedDespiteTokens = true;
            break;
          }
          cancelReturn = true;
          break;
        }

        if (cancelReturn) {
          console.log("Canceled; leaving SOL in the current wallet.");
          continue;
        }

        void proceedDespiteTokens;

        let recipient = "";
        while (true) {
          const rawRecipient = await promptLine("Return SOL to wallet (pubkey) (or 'q' to cancel)");
          const r = String(rawRecipient || "").trim();
          if (!r || r.toLowerCase() === "q") {
            recipient = "";
            break;
          }
          const ok = await isValidSolanaPubkeyStr(r);
          if (ok) {
            recipient = r;
            break;
          }
          console.log("Invalid pubkey. Paste the full Solana address and try again.");
        }

        if (!recipient) {
          console.log("Canceled; leaving SOL in the current wallet.");
          continue;
        }

        try {
          ensureNodeShims();
          const keepEnv = Number(process?.env?.FDV_RETURN_KEEP_LAMPORTS || 0);
          const keepLamports = Number.isFinite(keepEnv) && keepEnv > 0 ? Math.floor(keepEnv) : 1_000_000;
          const res = await __fdvCli_nodeReturnAllSolToRecipient({
            rpcUrl,
            rpcHeaders,
            autoWalletSecret,
            recipientPub: recipient,
            keepLamports,
          });
          if (!res?.ok) {
            console.log("Return transfer skipped: not enough SOL after keeping fee buffer.");
          }
          console.log("Return complete.");
        } catch (e) {
          console.error(`Return flow failed during transfer: ${e?.message || e}`);
        }

        continue;
      }

      // Normal bot start. Any error should return to the menu.
      try {
        const res = await startBotWithDefaults({ bot: choice, rpcUrl, rpcHeaders, autoWalletSecret, logToConsole, profileSink: tmpProfile });

        // Best-effort persist any config that may have been set during startBotWithDefaults.
        // (startBotWithDefaults mutates only local state; temp profile persistence happens here.)
        try {
          if (tmpProfile && typeof tmpProfile === "object") {
            // Nothing guaranteed, but keep RPC/secret current.
            tmpProfile.rpcUrl = rpcUrl;
            tmpProfile.rpcHeaders = rpcHeaders;
            tmpProfile.autoWalletSecret = autoWalletSecret;
          }
          if (profilesDoc && profileName) await saveTempProfilesDoc(profilesDoc, { reason: "bot_start", profileName });
        } catch {}

        if (res?.status === "menu") {
          continue;
        }
        if (res?.status === "running") {
          await waitForQuitKey({ label: `${String(choice || "bot")}` });
          try { await res.stopFn?.(); } catch {}
          // Safety: on bot exit, always unwind any held mint(s) to SOL.
          await unwindAllHoldingsToSol({ rpcUrl, rpcHeaders, autoWalletSecret, reason: String(choice || "bot") });
          console.log("Stopped.");
          continue;
        }

        // Default: fall back to menu.
        continue;
      } catch (e) {
        console.error(`Start failed: ${e?.stack || e?.message || e}`);
        console.error("Returning to main menu…");
        await _sleep(250);
      }
    } catch (e) {
      // Never hard-exit; always come back to the menu.
      console.error(`Menu error: ${e?.stack || e?.message || e}`);
      await _sleep(250);
    }
  }
}

async function installCliFlamebar({ rpcUrl, rpcHeaders, tickMs = 1250, limit = 250 } = {}) {
  // Provides the minimal window.__fdvFlamebar API expected by sniper flame mode.
  const { collectInstantSolana } = await import("../../../../data/feeds.js");
  const { ingestPumpingSnapshot, computePumpingLeaders } = await import("../../../meme/metrics/kpi/pumping.js");

  const state = {
    leaderMint: "",
    leaderMode: "pump",
    pumpScore: 0,
    stopped: false,
    timer: null,
  };

  const tick = async () => {
    try {
      const hits = await collectInstantSolana({ limit, signal: undefined }).catch(() => []);
      // `ingestPumpingSnapshot()` expects KPI-ish keys like `liqUsd`, `v1hTotal`, `vol24hUsd`.
      // Feeds return `bestLiq` + `volume24`, so adapt here for headless flame mode.
      const adapted = (Array.isArray(hits) ? hits : []).map((h) => {
        const vol24 = Number(h?.vol24hUsd ?? h?.vol24hUSD ?? h?.volume24 ?? h?.vol24 ?? 0) || 0;
        const v1h = Number(h?.v1hTotal ?? h?.vol1hUsd ?? h?.vol1hUSD ?? 0) || (vol24 > 0 ? vol24 / 24 : 0);
        const v6h = Number(h?.v6hTotal ?? h?.vol6hUsd ?? h?.vol6hUSD ?? 0) || (vol24 > 0 ? vol24 / 4 : (v1h > 0 ? v1h * 6 : 0));
        const v5m = Number(h?.v5mTotal ?? h?.vol5mUsd ?? h?.vol5mUSD ?? 0) || (vol24 > 0 ? vol24 / 288 : 0);
        const liq = Number(h?.liqUsd ?? h?.liquidityUsd ?? h?.liquidityUSD ?? h?.bestLiq ?? 0) || 0;
        return {
          ...h,
          liqUsd: liq,
          liquidityUsd: liq,
          vol24hUsd: vol24,
          v1hTotal: v1h,
          v6hTotal: v6h,
          v5mTotal: v5m,
        };
      });

      if (String(process?.env?.FDV_FLAME_DEBUG || "").trim() === "1") {
        try {
          console.log(`(flame) tick hits=${adapted.length}`);
          if (adapted[0]) {
            console.log(`(flame) sample mint=${String(adapted[0]?.mint || "").slice(0, 6)}… liqUsd=${Number(adapted[0]?.liqUsd || 0).toFixed(0)} v1h=${Number(adapted[0]?.v1hTotal || 0).toFixed(0)}`);
          }
        } catch {}
      }

      ingestPumpingSnapshot(adapted);
      const leaders = computePumpingLeaders(1);
      const top = Array.isArray(leaders) ? leaders[0] : null;
      const mint = String(top?.mint || "").trim();
      if (mint) {
        state.leaderMint = mint;
        state.leaderMode = "pump";
        state.pumpScore = Number(top?.pumpScore || 0) || 0;
        return;
      }

      // Fallback: when pump-score leaders are empty (often due to strict KPI gates),
      // pick a reasonable candidate directly from the feed so flame mode can still run.
      const fallback = adapted
        .filter((h) => {
          const liq = Number(h?.liqUsd || 0) || 0;
          const vol24 = Number(h?.vol24hUsd || 0) || 0;
          const chg5 = Number(h?.change5m || h?.chg5m || 0) || 0;
          return liq >= 2500 && vol24 >= 8000 && chg5 > 0;
        })
        .sort((a, b) => {
          const aScore = (Number(a?.change5m || 0) || 0) * 1.3 + Math.log1p(Number(a?.vol24hUsd || 0) || 0) * 1.0 + Math.log1p(Number(a?.liqUsd || 0) || 0) * 0.9;
          const bScore = (Number(b?.change5m || 0) || 0) * 1.3 + Math.log1p(Number(b?.vol24hUsd || 0) || 0) * 1.0 + Math.log1p(Number(b?.liqUsd || 0) || 0) * 0.9;
          return bScore - aScore;
        })[0];

      const fm = String(fallback?.mint || "").trim();
      if (fm) {
        state.leaderMint = fm;
        state.leaderMode = "feed";
        state.pumpScore = Number(fallback?.change5m || 0) || 0;
        if (String(process?.env?.FDV_FLAME_DEBUG || "").trim() === "1") {
          try { console.log(`(flame) fallback leader mint=${fm} chg5m=${Number(fallback?.change5m || 0).toFixed(2)} liqUsd=${Number(fallback?.liqUsd || 0).toFixed(0)} vol24=${Number(fallback?.vol24hUsd || 0).toFixed(0)}`); } catch {}
        }
      }
    } catch {}
  };

  const start = () => {
    if (state.timer) return;
    state.timer = setInterval(() => void tick(), Math.max(500, Number(tickMs || 1250)));
    try { setTimeout(tick, 0); } catch {}
  };
  const stop = () => {
    if (!state.timer) return;
    try { clearInterval(state.timer); } catch {}
    state.timer = null;
    state.stopped = true;
  };

  try {
    if (!globalThis.window) globalThis.window = globalThis;
    if (!globalThis.window.__fdvFlamebar) globalThis.window.__fdvFlamebar = {};
    globalThis.window.__fdvFlamebar.instance = {
      start,
      stop,
      tick,
      getLeaderMint: () => state.leaderMint,
      getLeaderMode: () => state.leaderMode,
      isPumping: () => !!state.leaderMint && state.leaderMode === "pump",
    };
    globalThis.window.__fdvFlamebar.getLeaderMint = () => {
      try { return globalThis.window.__fdvFlamebar?.instance?.getLeaderMint?.() || null; } catch { return null; }
    };
    globalThis.window.__fdvFlamebar.getLeaderMode = () => {
      try { return globalThis.window.__fdvFlamebar?.instance?.getLeaderMode?.() || ""; } catch { return ""; }
    };
    globalThis.window.__fdvFlamebar.isPumping = () => {
      try { return !!globalThis.window.__fdvFlamebar?.instance?.isPumping?.(); } catch { return false; }
    };
  } catch {}

  // Capture RPC into storage so downstream fetchers use it.
  try {
    applyGlobalRpcToStorage({ rpcUrl, rpcHeaders });
  } catch {}

  start();
  return {
    stop,
    getLeader: () => ({ mint: state.leaderMint, pumpScore: state.pumpScore, mode: state.leaderMode }),
  };
}

async function runFlameMode({ rpcUrl, rpcHeaders, autoWalletSecret, logToConsole } = {}) {
  ensureNodeShims();
  await ensureSolanaWeb3Shim();
  await ensureBs58Shim();

  // Ensure storage has RPC + wallet.
  applyGlobalRpcToStorage({ rpcUrl, rpcHeaders });
  await applyAutoWalletToStorage({ autoWalletSecret });

  if (logToConsole) {
    try { globalThis.window._fdvLogToConsole = true; } catch {}
  }

  const flame = await installCliFlamebar({ rpcUrl, rpcHeaders });

  let cleanupKeywatch = () => {};
  let exitRequested = false;
  try {
    // Allow user to bail out even though this loop doesn't prompt.
    // Use non-blocking open + flush buffered bytes so we don't immediately consume stale keys.
    const ttyInPath = process.platform === "win32" ? "CONIN$" : "/dev/tty";
    let fd = null;
    try {
      fd = openSync(ttyInPath, fsConstants.O_RDONLY | fsConstants.O_NONBLOCK);
    } catch {
      fd = openSync(ttyInPath, "r");
    }

    try {
      const buf = Buffer.alloc(1024);
      for (let i = 0; i < 8; i++) {
        const n = readSync(fd, buf, 0, buf.length, null);
        if (!n) break;
      }
    } catch {}

    const input = new tty.ReadStream(fd);
    const rl = await import("node:readline");
    rl.emitKeypressEvents(input);
    if (typeof input.setRawMode === "function") input.setRawMode(true);

    const armedAt = Date.now();
    const onKeypress = (_str, key) => {
      try {
        // Ignore immediate buffered events right after arm.
        if (Date.now() - armedAt < 150) return;
        const name = String(key?.name || "").toLowerCase();
        const ch = String(_str || key?.sequence || "").toLowerCase();
        if (key?.ctrl && name === "c") {
          try { cleanupKeywatch(); } catch {}
          try { process.exit(130); } catch {}
          return;
        }
        if (name === "q" || ch === "q") exitRequested = true;
      } catch {}
    };

    input.on("keypress", onKeypress);
    cleanupKeywatch = () => {
      try { input.off("keypress", onKeypress); } catch {}
      try { if (typeof input.setRawMode === "function") input.setRawMode(false); } catch {}
      try { input.destroy?.(); } catch {}
      try { if (fd != null) closeSync(fd); } catch {}
    };
  } catch {
    cleanupKeywatch = () => {};
  }

  console.log("Flame mode: waiting for a leader mint... (press 'q' to return to menu)");
  const startedAt = Date.now();
  let lastPromptAt = 0;
  while (true) {
    if (exitRequested) {
      try { flame.stop?.(); } catch {}
      try { cleanupKeywatch(); } catch {}
      console.log("Exited flame mode.");
      return { status: "menu" };
    }

    const { mint, pumpScore } = flame.getLeader();
    if (mint) {
      try { cleanupKeywatch(); } catch {}
      console.log(`Flame leader: ${mint} (pumpScore=${pumpScore || 0})`);
      const sniperMod = await import("../sniper/index.js");
      const code = await sniperMod.__fdvCli_start({
        enabled: true,
        mint,
        flameEnabled: true,
        sentryEnabled: false,
        pollMs: 1200,
        buyPct: 25,
        triggerScoreSlopeMin: 0.6,
        rpcUrl,
        rpcHeaders,
        logToConsole,
      });
      if (code) throw new Error(`FLAME_SNIPER_START_FAILED:${code}`);
      return { status: "running", stopFn: async () => sniperMod.__fdvCli_stop?.() };
    }

    if (Date.now() - startedAt > 30_000) {
      console.log("Still no leader mint. Retrying... (check your connectivity / feed availability)");
    }

    // After a while, offer a manual mint fallback (safe escape hatch).
    if (Date.now() - startedAt > 60_000 && Date.now() - lastPromptAt > 30_000) {
      lastPromptAt = Date.now();
      const manual = await promptLine("No leader yet. Enter a mint to snipe, or press Enter to keep waiting (q = exit)", { defaultValue: "" });
      const v = String(manual || "").trim();
      if (v.toLowerCase() === "q") {
        exitRequested = true;
        continue;
      }
      if (v) {
        try { cleanupKeywatch(); } catch {}
        const sniperMod = await import("../sniper/index.js");
        const code = await sniperMod.__fdvCli_start({
          enabled: true,
          mint: v,
          flameEnabled: true,
          sentryEnabled: false,
          pollMs: 1200,
          buyPct: 25,
          triggerScoreSlopeMin: 0.6,
          rpcUrl,
          rpcHeaders,
          logToConsole,
        });
        if (code) throw new Error(`FLAME_SNIPER_START_FAILED:${code}`);
        return { status: "running", stopFn: async () => sniperMod.__fdvCli_stop?.() };
      }
    }

    await _sleep(1250);
  }
}

async function quickStart(argv = []) {
  if (!_isNodeLike()) return 1;

  ensureNodeShims();
  await ensureSolanaWeb3Shim();
  await ensureBs58Shim();

  const { flags, getValue } = parseArgs(argv);
  const logToConsole = flags.has("--log-to-console");
  const bot = String(getValue("--bot") || "auto").trim().toLowerCase();
  const profileNameArg = String(getValue("--profile-name") || "").trim();

  let { rpcUrl, rpcHeaders } = await requireRpcFromArgs({ flags, getValue });

  // Quick-start RPC: prompt early so funding/balance checks use the right endpoint.
  // Allow default/public RPC, but show a strong warning about rate limits.
  try {
    const explicitRpc = String(
      getValue("--rpc-url") ||
      process?.env?.FDV_RPC_URL ||
      process?.env?.SOLANA_RPC_URL ||
      ""
    ).trim();

    if (!explicitRpc) {
      console.log("\nRPC setup (recommended):");
      console.log(`  Current/default: ${String(rpcUrl || "").trim() || "(none)"}`);
      console.log("\nWARNING: The default/public Solana RPC is heavily rate-limited.");
      console.log("If you see 429 Too Many Requests, timeouts, or failed swaps, this is why.");
      console.log("Get a private RPC from Chainstack or QuickNode and paste it here.");

      while (true) {
        const rawUrl = await promptLine("Custom RPC URL (http/https) (Enter = keep default)", { defaultValue: "" });
        const v = String(rawUrl || "").trim();
        if (!v) {
          console.log("\nUsing default/public RPC. Expect rate-limit failures under load.");
          console.log("Tip: Chainstack/QuickNode private RPC fixes most 429 issues.\n");
          break;
        }
        if (!_isProbablyHttpUrl(v)) {
          console.log("Invalid URL. Example: https://api.mainnet-beta.solana.com");
          continue;
        }
        rpcUrl = v;
        break;
      }

      try { applyGlobalRpcToStorage({ rpcUrl, rpcHeaders }); } catch {}
    }
  } catch {}

  // If the user didn't provide an RPC explicitly, call out the default being used.
  try {
    const rawRpc = String(
      getValue("--rpc-url") ||
      process?.env?.FDV_RPC_URL ||
      process?.env?.SOLANA_RPC_URL ||
      ""
    ).trim();
    if (!rawRpc) {
      console.log(`\nRPC endpoint: ${rpcUrl}`);
      console.log("(Using default because no --rpc-url / FDV_RPC_URL was provided. You can change it in the menu via 'rpc'.)\n");
    }
  } catch {}

  const profilesDoc = await loadTempProfilesDoc();

  let w = await generateWalletSecretBase58();
  let bal = 0;

  const defaultProfileName = `fdv.lol${_randHex(6)}`;
  const profileName = profileNameArg || defaultProfileName;
  const tmpProfile = upsertProfile(profilesDoc, profileName, {
    rpcUrl,
    rpcHeaders,
    autoWalletSecret: w.secretB58,
    autoWalletPub: w.pubkey,
  });
  await saveTempProfilesDoc(profilesDoc, { reason: "quick-start_wallet", profileName });

  console.log("\nQuick start wallet generated:");
  console.log(`  Address: ${w.pubkey}`);
  console.log("  Secret (base58):");
  console.log(`  ${w.secretB58}`);
  console.log("  Secret (json array):");
  console.log(`  ${w.secretJson}`);
  console.log("\nIMPORTANT: Save the secret now. Anyone with it can drain funds.");

  const next = await promptLine(
    "Once saved, fund the wallet with SOL and press Enter to continue (or type 'import' to use an existing wallet)",
    { defaultValue: "" },
  );

  if (String(next || "").trim().toLowerCase() === "import") {
    while (true) {
      const rawSecret = await promptLine("Import wallet secret (base58 secretKey, or JSON array) (or 'q' to cancel)", { defaultValue: "" });
      const s = String(rawSecret || "").trim();
      if (!s || s.toLowerCase() === "q") break;
      try {
        const imported = await parseWalletSecretToKeypair(s);
        w = imported;

        // Update temp profile to the imported wallet.
        try {
          const prof = upsertProfile(profilesDoc, profileName, {
            rpcUrl,
            rpcHeaders,
            autoWalletSecret: w.secretB58,
            autoWalletPub: w.pubkey,
          });
          await saveTempProfilesDoc(profilesDoc, { reason: "quick-start_import", profileName });
          void prof;
        } catch {}

        bal = await getSolBalanceUi({ rpcUrl, rpcHeaders, pubkey: w.pubkey }).catch(() => 0);
        if (!(bal > 0)) bal = await waitForFunding({ rpcUrl, rpcHeaders, pubkey: w.pubkey });
        console.log("\nImported wallet:");
        console.log(`  Address: ${w.pubkey}`);
        console.log(`  SOL:     ${_fmtSol(bal)} SOL`);
        break;
      } catch (e) {
        console.log(`Invalid secret: ${e?.message || e}. Try again (or 'q' to cancel).`);
      }
    }

    // If import was cancelled (or never succeeded), fall back to funding the current wallet.
    if (!(bal > 0)) {
      bal = await waitForFunding({ rpcUrl, rpcHeaders, pubkey: w.pubkey });
      console.log(`Funded. Balance now: ${_fmtSol(bal)} SOL`);
    }
  } else {
    bal = await waitForFunding({ rpcUrl, rpcHeaders, pubkey: w.pubkey });
    console.log(`Funded. Balance now: ${_fmtSol(bal)} SOL`);
  }

  try {
    tmpProfile.lastFundedAt = Date.now();
    tmpProfile.lastFundedSol = bal;
    await saveTempProfilesDoc(profilesDoc, { reason: "quick-start_funded", profileName });
  } catch {}

  console.log("\nBots you can start:");
  console.log("  auto    - auto trader (Full AI mode)");
  console.log("  follow  - follow a wallet (prompts for target)");
  console.log("  hold    - hold a mint (prompts for mint)");
  console.log("  volume  - volume bot (prompts for mint)");
  console.log("  flame   - sniper flame mode (auto-picks leader)\n");

  // Enter resilient main loop (never hard-exit on errors).
  const chosen = _normalizeBotChoice(bot) || "auto";
  try { tmpProfile.lastBot = chosen; } catch {}
  try { await saveTempProfilesDoc(profilesDoc, { reason: "quick-start_menu", profileName }); } catch {}

  try {
    const { profilesPath } = await getTempProfileStorePaths();
    console.log("\nTemp profile saved:");
    console.log(`  profiles: ${profilesPath}`);
    console.log(`  profile:  ${profileName}`);
  } catch {}

  return await quickStartMenuLoop({
    rpcUrl,
    rpcHeaders,
    autoWalletSecret: w.secretB58,
    logToConsole,
    profilesDoc,
    profileName,
    tmpProfile,
  });
}

function parseJsonMaybe(s) {
	try {
		if (s == null) return null;
		const raw = String(s || "").trim();
		if (!raw) return null;
		return JSON.parse(raw);
	} catch {
		return null;
	}
}

async function readTextFromPathOrUrl(pathOrUrl) {
  const s = String(pathOrUrl || "").trim();
  if (!s) throw new Error("missing path/url");
  if (/^https?:\/\//i.test(s)) {
    if (typeof fetch !== "function") {
      const { request } = await import("node:https");
      return await new Promise((resolve, reject) => {
        const req = request(s, (res) => {
          const chunks = [];
          res.on("data", (c) => chunks.push(c));
          res.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
        });
        req.on("error", reject);
        req.end();
      });
    }
    const resp = await fetch(s);
    if (!resp.ok) throw new Error(`fetch failed ${resp.status} ${resp.statusText}`);
    return await resp.text();
  }

  const { readFile } = await import("node:fs/promises");
  return await readFile(s, "utf8");
}

function pickProfile(doc, name) {
  const n = String(name || "").trim();
  if (!n) throw new Error("--profile <name> is required");
  if (!doc || typeof doc !== "object") throw new Error("profiles JSON must be an object");
  const profiles = doc.profiles && typeof doc.profiles === "object" ? doc.profiles : doc;
  const p = profiles[n];
  if (!p || typeof p !== "object") throw new Error(`profile not found: ${n}`);
  return p;
}

function applyGlobalRpcToStorage(profile = {}) {
  try {
    const rpcUrl = profile?.rpcUrl != null ? String(profile.rpcUrl || "").trim() : "";
    if (rpcUrl) {
      try { localStorage.setItem("fdv_rpc_url", rpcUrl); } catch {}
    }
    const headers = profile?.rpcHeaders && typeof profile.rpcHeaders === "object" ? profile.rpcHeaders : null;
    if (headers) {
      try { localStorage.setItem("fdv_rpc_headers", JSON.stringify(headers)); } catch {}
    }
  } catch {}
}

async function applyAutoWalletToStorage(profile = {}) {
  try {
    if (typeof localStorage === "undefined") return;
    const s = profile?.autoWalletSecret != null ? String(profile.autoWalletSecret || "").trim() : "";
    if (!s) return;

    let cur = {};
    try {
      const raw = localStorage.getItem(AUTO_LS_KEY);
      cur = raw ? JSON.parse(raw) || {} : {};
    } catch {
      cur = {};
    }

    // If we already have a valid cached secretKeyBytes, don't clobber it.
    const existing = cur?.secretKeyBytes || cur?.secretKeyArray;
    if (Array.isArray(existing) && existing.length === 64) {
      cur = { ...(cur || {}), autoWalletSecret: s };
      try { localStorage.setItem(AUTO_LS_KEY, JSON.stringify(cur)); } catch {}
      return;
    }

    await ensureSolanaWeb3Shim();
    await ensureBs58Shim();

    const bs58 = globalThis?.window?._fdvBs58Module || globalThis?.window?.bs58 || null;
    const web3 = globalThis?.window?.solanaWeb3 || globalThis?.solanaWeb3 || null;
    const Keypair = web3?.Keypair;
    if (!bs58 || typeof bs58.decode !== "function" || !Keypair) {
      cur = { ...(cur || {}), autoWalletSecret: s };
      try { localStorage.setItem(AUTO_LS_KEY, JSON.stringify(cur)); } catch {}
      return;
    }

    let secretBytes = null;
    if (s.startsWith("[") && s.endsWith("]")) {
      try {
        const arr = JSON.parse(s);
        if (Array.isArray(arr)) secretBytes = Uint8Array.from(arr);
      } catch {}
    }
    if (!secretBytes) {
      try { secretBytes = bs58.decode(s); } catch {}
    }

    let kp = null;
    try {
      if (secretBytes && secretBytes.length === 64) kp = Keypair.fromSecretKey(secretBytes);
      else if (secretBytes && secretBytes.length === 32) kp = Keypair.fromSeed(secretBytes);
    } catch {}

    if (kp?.secretKey && kp?.publicKey?.toBase58) {
      cur = {
        ...(cur || {}),
        autoWalletSecret: s,
        secretKeyBytes: Array.from(kp.secretKey),
        autoWalletPub: kp.publicKey.toBase58(),
      };
    } else {
      cur = { ...(cur || {}), autoWalletSecret: s };
    }

    try { localStorage.setItem(AUTO_LS_KEY, JSON.stringify(cur)); } catch {}
  } catch {}
}

function normalizeProfile(profile = {}) {
  try {
    const p = profile && typeof profile === "object" ? { ...profile } : {};

    // Newer layout: { rpc: { url, headers } }
    const rpc = p?.rpc && typeof p.rpc === "object" ? p.rpc : null;
    if (!p.rpcUrl && rpc?.url != null) p.rpcUrl = String(rpc.url || "").trim();
    if ((!p.rpcHeaders || typeof p.rpcHeaders !== "object") && rpc?.headers && typeof rpc.headers === "object") {
      p.rpcHeaders = rpc.headers;
    }

    // Wallet secret aliases
    if (!p.autoWalletSecret) {
      const cand =
        p?.walletSecret ??
        p?.auto?.walletSecret ??
        p?.trader?.walletSecret ??
        p?.trader?.autoWalletSecret ??
        p?.auto?.autoWalletSecret;
      if (cand != null) p.autoWalletSecret = String(cand || "").trim();
    }

    return p;
  } catch {
    return profile;
  }
}

async function ensureCryptoShim() {
  try {
    if (globalThis.crypto && typeof globalThis.crypto.getRandomValues === "function") return;
    const mod = await import("node:crypto");
    if (mod?.webcrypto) globalThis.crypto = mod.webcrypto;
  } catch {}
}

async function ensureSolanaWeb3Shim() {
  try {
    if (globalThis?.window?.solanaWeb3) return;
    if (globalThis?.solanaWeb3) {
      try { globalThis.window.solanaWeb3 = globalThis.solanaWeb3; } catch {}
      return;
    }

    await ensureCryptoShim();

    const url = new URL("../../../../vendor/solana-web3/index.iife.min.js", import.meta.url);
    const js = await readFile(url, "utf8");
    const vm = await import("node:vm");
    vm.runInThisContext(js, { filename: "solana-web3.iife.min.js" });

    if (!globalThis?.solanaWeb3 && !globalThis?.window?.solanaWeb3) return;
    if (!globalThis.window.solanaWeb3) globalThis.window.solanaWeb3 = globalThis.solanaWeb3;
  } catch {}
}

async function ensureBs58Shim() {
  try {
    if (globalThis?.window?._fdvBs58Module) return;
    if (globalThis?.window?.bs58 && typeof globalThis.window.bs58.decode === "function") return;
    const mod = await import("./helpers/bs58.node.js");
    const bs58 = mod?.default || mod?.bs58 || mod;
    if (bs58 && typeof bs58.decode === "function" && typeof bs58.encode === "function") {
      globalThis.window._fdvBs58Module = bs58;
      if (!globalThis.window.bs58) globalThis.window.bs58 = bs58;
    }
  } catch {}
}

function pickAutoProfile(profile = {}) {
  // Back-compat: older profiles put auto keys at the top-level.
  const auto = profile?.auto && typeof profile.auto === "object" ? profile.auto : null;
  if (auto) return auto;
  const trader = profile?.trader && typeof profile.trader === "object" ? profile.trader : null;
  if (trader) return trader;
  // Single-profile layout: keep follow/volume settings alongside auto keys,
  // but don't pass them into the auto profile to avoid name collisions.
  try {
    const out = { ...(profile || {}) };
    delete out.follow;
    delete out.hold;
    delete out.volume;
    delete out.sniper;
    delete out.rpcUrl;
    delete out.rpcHeaders;
    delete out.rpc;
    delete out.autoWalletSecret;
    delete out.walletSecret;
    return out;
  } catch {
    return profile;
  }
}

function shouldEnableSection(sectionVal) {
  if (!sectionVal) return false;
  if (sectionVal === true) return true;
  if (typeof sectionVal !== "object") return false;
  if (sectionVal.enabled === false) return false;
  // If config exists and doesn't explicitly disable, treat as enabled.
  return true;
}

async function runProfile(argv) {
  ensureNodeShims();
  await ensureSolanaWeb3Shim();
  await ensureBs58Shim();
  const { flags, getValue } = parseArgs(argv);
  const profileName = getValue("--profile");
  const profilesPathOrUrl = getValue("--profiles") || process.env.FDV_PROFILES || "./fdv.profiles.json";
  const logToConsole = flags.has("--log-to-console");

  const raw = await readTextFromPathOrUrl(profilesPathOrUrl);
  const doc = JSON.parse(raw);
  const profile = normalizeProfile(pickProfile(doc, profileName));

  // Shared config across bots.
  applyGlobalRpcToStorage(profile);
  await applyAutoWalletToStorage(profile);

  if (logToConsole) {
    try { globalThis.window._fdvLogToConsole = true; } catch {}
  }

  const followSection = profile?.follow;
  const holdSection = profile?.hold;
  const volumeSection = profile?.volume;
  const sniperSection = profile?.sniper;

  const followCfg = followSection === true ? {} : (followSection && typeof followSection === "object" ? followSection : null);
  const holdCfg = holdSection === true ? {} : (holdSection && typeof holdSection === "object" ? holdSection : null);
  const volumeCfg = volumeSection === true ? {} : (volumeSection && typeof volumeSection === "object" ? volumeSection : null);
  const sniperCfg = sniperSection === true ? {} : (sniperSection && typeof sniperSection === "object" ? sniperSection : null);

  const enableFollow = shouldEnableSection(followSection);
  const enableHold = shouldEnableSection(holdSection);
  const enableVolume = shouldEnableSection(volumeSection);
  const enableSniper = shouldEnableSection(sniperSection);
  // Auto is enabled by default unless explicitly disabled.
  const autoSection = profile?.auto;
  const enableAuto = autoSection === false ? false : autoSection && typeof autoSection === "object" ? shouldEnableSection(autoSection) : true;

  if (!enableAuto && !enableFollow && !enableHold && !enableVolume && !enableSniper) {
    console.error("Profile enables no bots (auto/follow/sniper/hold/volume). Add { auto: {enabled:true} } / { follow: {enabled:true} } / { sniper: {enabled:true} } / { hold: {enabled:true} } / { volume: {enabled:true} }.");
    return 2;
  }

  console.log(`Running profile '${String(profileName)}' from ${profilesPathOrUrl}`);
  console.log("Press Ctrl+C to stop.");

  let autoMod = null;
  let followMod = null;
  let holdMod = null;
  let volumeMod = null;
  let sniperMod = null;

  if (enableAuto) {
    autoMod = await import("../trader/index.js");
    _installHeadlessAutoOverridesForCliRecon({
      autoMod,
      rpcUrl: profile?.rpcUrl,
      rpcHeaders: profile?.rpcHeaders,
      autoWalletSecret: profile?.autoWalletSecret,
    });
    autoMod.__fdvCli_applyProfile(pickAutoProfile(profile));

    _startCliMintReconciler({
      rpcUrl: profile?.rpcUrl,
      rpcHeaders: profile?.rpcHeaders,
      autoWalletSecret: profile?.autoWalletSecret,
      intervalMs: _envFlag("FDV_CLI_RECON_FAST", false) ? 1200 : 2000,
      debug: _envFlag("FDV_CLI_RECON_DEBUG", false),
    });

    const ok = await autoMod.__fdvCli_start({ enable: true });
    if (!ok) {
      console.error("Headless start failed (auto bot). See logs above.");
      _stopCliMintReconciler();
      return 3;
    }
  }

  if (enableFollow) {
    followMod = await import("../follow/index.js");
    const code = await followMod.__fdvCli_start({
      ...(followCfg || {}),
      rpcUrl: profile?.rpcUrl,
      rpcHeaders: profile?.rpcHeaders,
      logToConsole,
    });
    if (code) {
      try { if (autoMod) await autoMod.__fdvCli_stop({ runFinalSellEval: true }); } catch {}
      return code;
    }
  }

  if (enableSniper) {
    sniperMod = await import("../sniper/index.js");
    const code = await sniperMod.__fdvCli_start({
      ...(sniperCfg || {}),
      rpcUrl: profile?.rpcUrl,
      rpcHeaders: profile?.rpcHeaders,
      logToConsole,
    });
    if (code) {
      try { if (followMod) await followMod.__fdvCli_stop(); } catch {}
      try { if (autoMod) await autoMod.__fdvCli_stop({ runFinalSellEval: true }); } catch {}
      return code;
    }
  }

  if (enableHold) {
    holdMod = await import("../hold/index.js");
    const code = await holdMod.__fdvCli_start({
      ...(holdCfg || {}),
      rpcUrl: profile?.rpcUrl,
      rpcHeaders: profile?.rpcHeaders,
      logToConsole,
    });
    if (code) {
      try { if (sniperMod) await sniperMod.__fdvCli_stop(); } catch {}
      try { if (followMod) await followMod.__fdvCli_stop(); } catch {}
      try { if (autoMod) await autoMod.__fdvCli_stop({ runFinalSellEval: true }); } catch {}
      return code;
    }
  }

  if (enableVolume) {
    volumeMod = await import("../volume/index.js");
    const code = await volumeMod.__fdvCli_start({
      ...(volumeCfg || {}),
      rpcUrl: profile?.rpcUrl,
      rpcHeaders: profile?.rpcHeaders,
      logToConsole,
    });
    if (code) {
      try { if (holdMod) await holdMod.__fdvCli_stop(); } catch {}
      try { if (sniperMod) await sniperMod.__fdvCli_stop(); } catch {}
      try { if (followMod) await followMod.__fdvCli_stop(); } catch {}
      try { if (autoMod) await autoMod.__fdvCli_stop({ runFinalSellEval: true }); } catch {}
      return code;
    }
  }

  const stop = async () => {
    try {
      console.log("\nStopping…");
      try { if (volumeMod) await volumeMod.__fdvCli_stop(); } catch {}
      try { if (holdMod) await holdMod.__fdvCli_stop(); } catch {}
      try { if (sniperMod) await sniperMod.__fdvCli_stop(); } catch {}
      try { if (followMod) await followMod.__fdvCli_stop(); } catch {}
      try { if (autoMod) await autoMod.__fdvCli_stop({ runFinalSellEval: true }); } catch {}
      _stopCliMintReconciler();
    } finally {
      process.exit(0);
    }
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);

  // Keep process alive.
  await new Promise(() => {});
}

function ensureNodeShims() {
  if (typeof globalThis.window === "undefined") globalThis.window = globalThis;
  if (!globalThis.window._fdvRouterHold) globalThis.window._fdvRouterHold = new Map();

  // Minimal DOM shims for Node (import-time safety only).
  if (typeof globalThis.document === "undefined") {
    const mkEl = (tag = "div") => ({
      tagName: String(tag || "div").toUpperCase(),
      style: {},
      children: [],
      dataset: {},
      setAttribute: () => {},
      getAttribute: () => null,
      appendChild: function (c) { try { this.children.push(c); } catch {} return c; },
      removeChild: () => {},
      insertBefore: () => {},
      remove: () => {},
      querySelector: () => null,
      querySelectorAll: () => [],
      closest: () => null,
      matches: () => false,
      addEventListener: () => {},
      removeEventListener: () => {},
      firstChild: null,
      nextElementSibling: null,
      innerHTML: "",
      textContent: "",
    });

    const body = mkEl("body");
    const documentElement = mkEl("html");
    globalThis.document = {
      readyState: "complete",
      body,
      documentElement,
      createElement: (t) => mkEl(t),
      getElementById: () => null,
      querySelector: () => null,
      querySelectorAll: () => [],
      addEventListener: () => {},
      removeEventListener: () => {},
      execCommand: () => false,
    };
  }

  if (typeof globalThis.navigator === "undefined") {
    globalThis.navigator = { clipboard: { writeText: async () => {} } };
  }

  if (typeof globalThis.IntersectionObserver === "undefined") {
    globalThis.IntersectionObserver = class {
      constructor() {}
      observe() {}
      unobserve() {}
      disconnect() {}
    };
  }

  if (typeof globalThis.MutationObserver === "undefined") {
    globalThis.MutationObserver = class {
      constructor() {}
      observe() {}
      disconnect() {}
      takeRecords() { return []; }
    };
  }

  if (typeof globalThis.localStorage === "undefined") {
    const store = new Map();
    globalThis.localStorage = {
      getItem: (k) => (store.has(String(k)) ? String(store.get(String(k))) : null),
      setItem: (k, v) => { store.set(String(k), String(v)); },
      removeItem: (k) => { store.delete(String(k)); },
      clear: () => { store.clear(); },
    };
  }

  if (typeof globalThis.requestAnimationFrame === "undefined") {
    globalThis.requestAnimationFrame = (cb) => setTimeout(() => cb(Date.now()), 0);
  }
  if (typeof globalThis.cancelAnimationFrame === "undefined") {
    globalThis.cancelAnimationFrame = (id) => clearTimeout(id);
  }
}

async function simIndex(argv) {
  ensureNodeShims();
  await ensureSolanaWeb3Shim();
  await ensureBs58Shim();

  const { flags, getValue } = parseArgs(argv);
  const steps = Math.max(1, Number(getValue("--steps") || 40));
  const dtMs = Math.max(50, Number(getValue("--dt-ms") || 1000));
  const throwPrune = flags.has("--throw-prune");
  const debugSell = flags.has("--debug-sell");

  // Load the real browser module under Node, then override wallet/RPC/quotes.
  const mod = await import("../trader/index.js");

  if (debugSell) {
    try { globalThis.window._fdvDebugSellEval = true; } catch {}
  }

  const mint = "11111111111111111111111111111111"; // valid base58 pubkey
  const ownerStr = "11111111111111111111111111111111";
  const startTs = Date.now();
  let simNow = startTs;

  let simPxSol = 0.00008; // SOL per token
  const amountUi = 2000;
  const buySol = 0.12;

  // Stubs: no RPC, deterministic quote, skip execute.
  mod.__fdvDebug_setOverrides({
    now: () => simNow,
    skipExecute: true,
    // Skip everything that could preempt urgent (profit lock / fallback exits / etc).
    skipPolicies: [
      "leaderMode",
      "rugPumpDrop",
      "earlyFade",
      "observer",
      "volatilityGuard",
      "quoteAndEdge",
      "fastExit",
      "dynamicHardStop",
      "warmingHook",
      "profitLock",
      "observerThree",
      "fallback",
      "forceFlagDecision",
      "reboundGate",
      "momentumForce",
    ],
    getAutoKeypair: async () => ({
      publicKey: {
        toBase58: () => ownerStr,
      },
    }),
    syncPositionsFromChain: async () => {},
    pruneZeroBalancePositions: async () => {
      if (throwPrune) throw new Error("simulated prune throw");
    },
    verifyRealTokenBalance: async () => ({ ok: true, sizeUi: amountUi, purged: false }),
    hasPendingCredit: () => false,
    quoteOutSol: async (_mint, amtUi) => {
      return Math.max(0, Number(simPxSol || 0) * Number(amtUi || 0));
    },
  });

  const state = mod.getAutoTraderState();
  state.enabled = true;
  state.minQuoteIntervalMs = 0;
  state.pendingGraceMs = 0;
  state.sellCooldownMs = 0;
  state.minHoldSecs = 0;
  state.coolDownSecsAfterBuy = 0;
  state.maxHoldSecs = 0;
  state.holdUntilLeaderSwitch = false;
  state.dynamicHoldEnabled = false;

  // Disable baseline exit logic so we can isolate urgent behavior.
  state.takeProfitPct = 9999;
  state.stopLossPct = 9999;
  state.trailPct = 0;
  state.partialTpPct = 0;
  state.minProfitToTrailPct = 9999;

  state.positions = {};

  // “Bot catches coin and buys”: we inject a position as if the buy succeeded.
  const buyAtStep = 5;
  const urgentAtStep = 22;
  const dropAtStep = 20;

  console.log(`sim-index: steps=${steps} dtMs=${dtMs} throwPrune=${throwPrune ? 1 : 0}`);
  console.log(`mint=${mint} owner=${ownerStr}`);

  for (let i = 0; i < steps; i++) {
    const nowTs = startTs + i * dtMs;
    simNow = nowTs;

    // Price curve: rise -> sharp drop -> flat.
    if (i < dropAtStep) {
      // ramp from 0.00008 -> 0.00014
      simPxSol = 0.00008 + (0.00006 * (i / Math.max(1, dropAtStep)));
    } else {
      // drop to 0.00003
      simPxSol = 0.00003;
    }

    if (i === buyAtStep) {
      state.positions[mint] = {
        mint,
        sizeUi: amountUi,
        decimals: 6,
        costSol: buySol,
        acquiredAt: nowTs,
        lastBuyAt: nowTs,
        lastSellAt: 0,
        warmingHold: false,
      };
      state.lastTradeTs = nowTs;
      console.log(`t+${i}s BUY injected sizeUi=${amountUi} costSol=${buySol}`);
    }

    if (i === urgentAtStep) {
      mod.__fdvDebug_flagUrgentSell(mint, "momentum_drop_x28", 0.9);
      console.log(`t+${i}s URGENT injected (momentum_drop_x28)`);
    }

    // Run the real sell-eval path.
    await mod.__fdvDebug_evalAndMaybeSellPositions();

    const snap = globalThis.window._fdvLastSellSnapshot;
    const d = snap?.ctx?.decision || snap?.decision || null;
    const act = d?.action || "none";
    const rsn = d?.reason ? String(d.reason) : "";
    const curSol = Number(snap?.ctx?.curSol ?? 0);
    console.log(`t+${i}s px=${simPxSol.toFixed(8)} curSol=${curSol.toFixed(6)} decision=${act}${rsn ? " :: " + rsn : ""}`);
  }

  return 0;
}

async function loadSnapshot(path) {
  const raw = await readFile(path, "utf8");
  const snap = JSON.parse(raw);
  if (!snap || typeof snap !== "object") throw new Error("invalid snapshot JSON");
  return snap;
}

function shouldSellFromState(state, pos, curSol, nowTs) {
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
  if (lastBuyAt && nowTs - lastBuyAt < (state.coolDownSecsAfterBuy | 0) * 1000) {
    return { action: "none", reason: "cooldown" };
  }

  const sellCd = Math.max(5_000, Number(state.sellCooldownMs || 20_000));
  if (pos.lastSellAt && nowTs - pos.lastSellAt < sellCd) {
    return { action: "none", reason: "sell-cooldown" };
  }

  if (state.minHoldSecs > 0 && pos.acquiredAt && nowTs - pos.acquiredAt < state.minHoldSecs * 1000) {
    return { action: "none", reason: "min-hold" };
  }

  const pxNow = curSol / sz;
  const pxCost = cost / sz;
  pos.hwmPx = Math.max(Number(pos.hwmPx || 0) || pxNow, pxNow);

  const pnlPct = ((pxNow - pxCost) / Math.max(1e-12, pxCost)) * 100;
  const tp = Math.max(0, Number(pos.tpPct ?? state.takeProfitPct ?? 0));
  const sl = Math.max(0, Number(pos.slPct ?? state.stopLossPct ?? 0));
  const trail = Math.max(0, Number(pos.trailPct ?? state.trailPct ?? 0));
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

async function dryRunSell(snapshotPath) {
  ensureWindowShim();
  const snap = await loadSnapshot(snapshotPath);

  const state = { ...(snap.state || {}) };
  const mint = String(snap.mint || "");
  if (!mint) throw new Error("snapshot.mint is required");
  const ownerStr = String(snap.ownerStr || "Owner111111111111111111111111111111111");

  const nowTs = Number.isFinite(snap.nowTs) ? Number(snap.nowTs) : Date.now();
  const pos = { ...(snap.pos || {}) };
  if (!Number.isFinite(pos.sizeUi)) throw new Error("snapshot.pos.sizeUi is required");
  if (!Number.isFinite(pos.costSol)) throw new Error("snapshot.pos.costSol is required");
  if (!Number.isFinite(pos.decimals)) pos.decimals = 6;
  if (!pos.acquiredAt && !pos.lastBuyAt) pos.acquiredAt = nowTs - 30_000;

  // Optional: simulate router hold in snapshot
  if (Number.isFinite(snap.routerHoldUntil) && snap.routerHoldUntil > 0) {
    window._fdvRouterHold.set(mint, Number(snap.routerHoldUntil));
  }

  const logs = [];
  const log = (m) => {
    const s = String(m ?? "");
    logs.push(s);
    console.log(s);
  };

  const now = () => Date.now();

  // Minimal quote/net estimation for dry run.
  const quoteOutSol = async (_mint, amountUi) => {
    if (Number.isFinite(snap.curSol)) return Number(snap.curSol);
    if (Number.isFinite(snap.pxNow)) return Number(snap.pxNow) * Number(amountUi);
    if (Number.isFinite(pos.lastQuotedSol)) return Number(pos.lastQuotedSol);
    return 0;
  };
  const estimateNetExitSolFromQuote = ({ quoteOutLamports }) => {
    const grossSol = Math.max(0, Number(quoteOutLamports || 0) / 1e9);
    const netSol = Number.isFinite(snap.curSolNet) ? Number(snap.curSolNet) : grossSol;
    return { netSol, feeApplied: netSol !== grossSol };
  };

  const urgentRec = snap.urgent ? { ...snap.urgent } : null;
  const peekUrgentSell = () => urgentRec;
  const clearUrgentSell = () => {};

  const preflight = createPreflightSellPolicy({
    now,
    log,
    getState: () => state,
    shouldForceMomentumExit: () => !!snap.forceMomentum,
    verifyRealTokenBalance: async () => ({ ok: true, sizeUi: Number(pos.sizeUi || 0), purged: false }),
    hasPendingCredit: () => false,
    peekUrgentSell,
  });

  const urgentPolicy = createUrgentSellPolicy({
    log,
    peekUrgentSell,
    clearUrgentSell,
    urgentSellMinAgeMs: Number.isFinite(state.urgentSellMinAgeMs) ? state.urgentSellMinAgeMs : 7000,
  });

  const quoteAndEdge = createQuoteAndEdgePolicy({
    log,
    getState: () => ({ ...state, minQuoteIntervalMs: 0 }),
    quoteOutSol,
    flagUrgentSell: () => {},
    RUG_QUOTE_SHOCK_WINDOW_MS: 10_000,
    RUG_QUOTE_SHOCK_FRAC: 0.25,
    estimateNetExitSolFromQuote,
  });

  const fastExit = createFastExitPolicy({
    log,
    checkFastExitTriggers: () => ({ action: "none" }),
  });

  const dynamicHardStop = createDynamicHardStopPolicy({
    log,
    getState: () => state,
    DYN_HS: snap.DYN_HS || {},
    computeFinalGateIntensity: () => ({ intensity: 1 }),
    computeDynamicHardStopPct: () => Number.isFinite(snap.dynStopPct) ? Number(snap.dynStopPct) : 8,
  });

  const profitLock = createProfitLockPolicy({ log, save: () => {} });
  const forceFlagDecision = createForceFlagDecisionPolicy({ log, getState: () => state });

  const reboundGate = createReboundGatePolicy({
    log,
    getState: () => state,
    shouldDeferSellForRebound: () => false,
    wakeSellEval: () => {},
    save: () => {},
  });

  const fallback = createFallbackSellPolicy({
    log,
    getState: () => state,
    minSellNotionalSol: () => Number.isFinite(snap.minNotional) ? Number(snap.minNotional) : 0,
    shouldSell: (p, sol, ts) => shouldSellFromState(state, p, sol, ts),
    MIN_SELL_SOL_OUT: 0,
  });

  const ctx = {
    mint,
    ownerStr,
    nowTs,
    pos,
    decision: { action: "none" },

    forceRug: !!snap.forceRug,
    forcePumpDrop: !!snap.forcePumpDrop,
    forceObserverDrop: !!snap.forceObserverDrop,
    forceMomentum: !!snap.forceMomentum,
  };

  const steps = [
    preflight,
    urgentPolicy,
    quoteAndEdge,
    fastExit,
    dynamicHardStop,
    profitLock,
    forceFlagDecision,
    reboundGate,
    fallback,
  ];

  await runPipeline(ctx, steps);

  console.log("\nFinal decision:");
  console.log(JSON.stringify(ctx.decision || { action: "none" }, null, 2));
  return 0;
}

async function validateSellBypass() {
  ensureWindowShim();

  const logs = [];
  const log = (m) => {
    const s = String(m ?? "");
    logs.push(s);
    console.log(s);
  };

  const now = () => Date.now();

  const mint = "Mint1111111111111111111111111111111111";
  const ownerStr = "Owner111111111111111111111111111111111";

  window._fdvRouterHold.set(mint, now() + 60_000);

  const preflight = createPreflightSellPolicy({
    now,
    log,
    getState: () => ({ maxHoldSecs: 0, pendingGraceMs: 20_000 }),
    shouldForceMomentumExit: () => false,
    hasPendingCredit: () => false,
    peekUrgentSell: () => ({ reason: "momentum_drop_x28", sev: 1 }),
    verifyRealTokenBalance: async () => ({ ok: true, sizeUi: 123, purged: false }),
  });

  const ctxA = {
    mint,
    ownerStr,
    nowTs: now(),
    pos: { acquiredAt: now() - 30_000, lastBuyAt: now() - 30_000 },
  };

  const resA = await preflight(ctxA);
  if (resA?.stop) throw new Error("preflight should NOT stop when urgent-hard is present");
  if (!logs.some((l) => /Router cooldown bypass/i.test(l))) {
    throw new Error("expected preflight to log router cooldown bypass");
  }

  logs.length = 0;
  window._fdvRouterHold.set(mint, now() + 60_000);

  const preflight2 = createPreflightSellPolicy({
    now,
    log,
    getState: () => ({ maxHoldSecs: 0, pendingGraceMs: 20_000 }),
    shouldForceMomentumExit: () => false,
    hasPendingCredit: () => false,
    peekUrgentSell: () => ({ reason: "observer", sev: 0.5 }),
    verifyRealTokenBalance: async () => ({ ok: true, sizeUi: 123, purged: false }),
  });

  const ctxB = {
    mint,
    ownerStr,
    nowTs: now(),
    pos: { acquiredAt: now() - 30_000, lastBuyAt: now() - 30_000 },
  };

  const resB = await preflight2(ctxB);
  if (!resB?.stop) throw new Error("preflight SHOULD stop when router hold active and no hard-exit is present");
  if (!logs.some((l) => /Router cooldown for/i.test(l))) {
    throw new Error("expected preflight to log router cooldown active");
  }

  logs.length = 0;
  window._fdvRouterHold.set(mint, now() + 60_000);

  const state = { positions: { [mint]: { sizeUi: 100, decimals: 6, costSol: 0.1 } }, sellCooldownMs: 20_000, slippageBps: 250, fastExitSlipBps: 400, fastExitConfirmMs: 9000 };

  const execPolicy = createExecuteSellDecisionPolicy({
    log,
    now,
    getState: () => state,
    save: () => {},
    setInFlight: () => {},
    lockMint: () => {},
    unlockMint: () => {},
    SOL_MINT: "So11111111111111111111111111111111111111112",
    MINT_OP_LOCK_MS: 20_000,
    ROUTER_COOLDOWN_MS: 30_000,
    MIN_SELL_SOL_OUT: 0,
    addToDustCache: () => {},
    removeFromPosCache: () => {},
    updatePosCache: () => {},
    clearPendingCredit: () => {},
    setRouterHold: () => {},
    closeEmptyTokenAtas: async () => {},
    quoteOutSol: async () => 0,
    getAtaBalanceUi: async () => ({ sizeUi: 100, decimals: 6 }),
    minSellNotionalSol: () => 0.00001,
    executeSwapWithConfirm: async () => ({ ok: false, noRoute: true }),
    waitForTokenDebit: async () => ({ remainUi: 0, decimals: 6 }),
    addRealizedPnl: async () => {},
    maybeStealthRotate: async () => {},
    clearRouteDustFails: () => {},
  });

  const ctxC = {
    kp: { publicKey: { toBase58: () => ownerStr } },
    mint,
    ownerStr,
    nowTs: now(),
    decision: { action: "sell_all", reason: "URGENT: momentum_drop_x28", hardStop: true },
    pos: { sizeUi: 100, decimals: 6, costSol: 0.1 },
    curSol: 1,
    minNotional: 0.00001,
    isFastExit: true,
    forceExpire: false,
    forceRug: false,
    forcePumpDrop: false,
    forceObserverDrop: false,
    forceMomentum: true,
  };

  const resC = await execPolicy(ctxC);
  if (!logs.some((l) => /Router cooldown bypass/i.test(l))) {
    throw new Error("expected execute-sell to log router cooldown bypass");
  }
  if (!resC?.returned) throw new Error("expected execute-sell to return (handled) after swap failure");

  console.log("\nOK: validate-sell-bypass passed.");
  return 0;
}

export async function runAutoTraderCli(argv = []) {
  const { flags, getValue } = parseArgs(argv);

  await maybePrintSplash(flags);

  if (flags.has("--quick-start")) {
    return await quickStart(argv);
  }

  if (flags.has("--flame")) {
    ensureNodeShims();
    await ensureSolanaWeb3Shim();
    await ensureBs58Shim();
    const { rpcUrl, rpcHeaders } = await requireRpcFromArgs({ flags, getValue });
    const secret = String(getValue("--wallet-secret") || process?.env?.FDV_WALLET_SECRET || "").trim();
    if (!secret) {
      console.error("Missing wallet secret for --flame. Use --wallet-secret or run --quick-start.");
      return 2;
    }
    const logToConsole = flags.has("--log-to-console");
    await runFlameMode({ rpcUrl, rpcHeaders, autoWalletSecret: secret, logToConsole });
    return 0;
  }

  if (flags.has("--help") || flags.has("-h")) {
    console.log(usage());
    return 0;
  }

  if (flags.has("--validate-sell-bypass")) {
    return await validateSellBypass();
  }

  if (flags.has("--dry-run-sell")) {
    const snapshotPath = getValue("--snapshot");
    if (!snapshotPath) {
      console.error("Missing required --snapshot <path>");
      return 2;
    }
    return await dryRunSell(snapshotPath);
  }

  if (flags.has("--sim-index")) {
    return await simIndex(argv);
  }

  if (flags.has("--run-profile")) {
    await runProfile(argv);
    return 0;
  }

  console.log(usage());
  return 2;
}
