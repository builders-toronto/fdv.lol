import { FDV_FEE_RECEIVER, FDV_TURNSTILE_BASE } from "../../config/env.js";
import { fetchTokenInfo } from "../../data/dexscreener.js";
import { throttleGlobalStream, releaseGlobalStreamThrottle, isGlobalStreamThrottled } from "../../engine/pipeline.js";

const SOL_MINT = "So11111111111111111111111111111111111111112";

const DEFAULTS = {
  jupiterBase: "https://lite-api.jup.ag",

  rpcUrl: FDV_TURNSTILE_BASE,
  authPath: "/auth",

  turnstileSiteKey: "0x4AAAAAAB1-OXJYaV8q4rdX",

  platformFeeBps: 5,
  defaultSlippageBps: 50,
  feeReceiverWallet: "",
  feeAtas: {},
  tokenDecimals: {},

  buildDexUrl({ outputMint, pairUrl }) {
    if (pairUrl) return pairUrl;
    return `https://dexscreener.com/solana/${encodeURIComponent(outputMint || "")}`;
  },
  buildJupUrl({ inputMint, outputMint, amountUi, slippageBps, platform }) {
    const u = new URL("https://jup.ag/tokens/" + outputMint);
    // if (inputMint) u.searchParams.set("inputMint", inputMint);
    // if (slippageBps != null) u.searchParams.set("slippageBps", String(slippageBps));
    // if (amountUi != null) u.searchParams.set("amount", String(amountUi));
    // if (platform) u.searchParams.set("platform", platform); // "mobile" | "web"
    return u.toString();
  },

  // Hooks
  onConnect(pubkeyBase58) {},
  onQuote(quoteJson) {},
  onSwapSent(signature) {},
  onSwapConfirmed(signature) {},
  onError(stage, error) { console.error(stage, error); },
};

let CFG = { ...DEFAULTS };
let _state = {
  wallet: null,
  pubkey: null,
  inputMint: SOL_MINT,
  outputMint: null,
  token: null,
  preQuote: null,
};

let web3;


let _rpcSession = { token: null, exp: 0 };  // epoch ms
let _challengeOk = false;                   // UI state
let _sessionInFlight = null;                // dedupe concurrent solves

// Verify animation state
let _verifyAnimTimer = null;
let _verifyAnimStep = 0;



function _startVerifyAnim() {
  const chip = _el("[data-captcha-state]");
  if (!chip) return;
  if (_verifyAnimTimer) return; // already animating
  chip.dataset.verifying = "1";
  _verifyAnimStep = 0;
  _verifyAnimTimer = setInterval(() => {
    const dots = ".".repeat((_verifyAnimStep++ % 3) + 1);
    chip.textContent = `Verifying${dots}`;
  }, 400);
  chip.classList.remove("ok");
}
function _stopVerifyAnim() {
  const chip = _el("[data-captcha-state]");
  if (_verifyAnimTimer) {
    clearInterval(_verifyAnimTimer);
    _verifyAnimTimer = null;
  }
  if (chip) delete chip.dataset.verifying;
  _refreshChallengeChrome(); // restore final state
}

export function initSwap(userConfig = {}) {
  CFG = { ...DEFAULTS, ...userConfig };
  _ensureModalMounted();
}

export function createSwapButton({ mint, label = "Swap", className = "btn swapCoin" } = {}) {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = className;
  btn.dataset.mint = mint;
  btn.textContent = label;
  btn.addEventListener("click", (e) => _handleSwapClickFromEl(e.currentTarget));
  return btn;
}

export function swapButtonHTML(mint, label = "Swap", className = "btn swapCoin") {
  return `<button type="button" class="${className}" data-mint="${mint}" data-swap-btn>${label}</button>`;
}

export function bindSwapButtons(root = document) {
  root.addEventListener("click", (e) => {
    const el = e.target.closest("[data-swap-btn], .swapCoin");
    if (!el) return;
    _handleSwapClickFromEl(el);
  });
}

export function openSwapModal({
  inputMint = _state.inputMint,
  outputMint,
  amountUi,
  slippageBps,
  tokenHydrate,
  pairUrl,
  priority,
  relay,
  timeoutMs,
  noFetch,
} = {}) {
  _state.inputMint = inputMint;
  _state.outputMint = outputMint;
  _setModalFields({ inputMint, outputMint, amountUi, slippageBps });

  _openModal();

  if (tokenHydrate && tokenHydrate.mint) {
    _applyTokenHydrate(tokenHydrate);
  }
  if (outputMint) {
    _loadTokenProfile(outputMint, { tokenHydrate, pairUrl, priority, relay, timeoutMs, noFetch });
  }
  _kickPreQuote();
}

function isLikelyMobile() {
  const coarse = typeof window !== "undefined" &&
    window.matchMedia && window.matchMedia("(pointer: coarse)").matches;
  const ua = (typeof navigator !== "undefined" && navigator.userAgent) ? navigator.userAgent : "";
  const uaMobile = /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(ua);
  const inApp = /\bFBAN|FBAV|Instagram|Line\/|Twitter/i.test(ua);
  return coarse || uaMobile || inApp;
}
function hasPhantomInstalled() {
  try { return !!(window?.solana && window.solana.isPhantom); }
  catch { return false; }
}

function _parseJsonAttr(str) {
  if (!str) return null;
  try { return JSON.parse(str); } catch { return null; }
}

function _collectHardDataFromEl(el) {
  const card = el.closest(".card");
  const dBtn = el?.dataset || {};
  const dCard = card?.dataset || {};

  const mint = dBtn.mint || dCard.mint || null;
  const pairUrl = dBtn.pairUrl || dCard.pairUrl || null;

  const optsBtn = _parseJsonAttr(dBtn.swapOpts);
  const optsCard = _parseJsonAttr(dCard.swapOpts);
  const opts = { ...(optsCard || {}), ...(optsBtn || {}) };

  const hydrateBtn = _parseJsonAttr(dBtn.tokenHydrate);
  const hydrateCard = _parseJsonAttr(dCard.tokenHydrate);
  const tokenHydrate = { ...(hydrateCard || {}), ...(hydrateBtn || {}) };

  const priority = opts.priority ?? (dBtn.priority === "1" || dCard.priority === "1");
  const relay = opts.relay ?? dBtn.relay ?? dCard.relay;
  const timeoutMs = opts.timeoutMs ?? Number(dBtn.timeoutMs || dCard.timeoutMs);

  return { mint, pairUrl, tokenHydrate, priority, relay, timeoutMs };
}

// TODO: wait for phantom. phantom isPhantom elPhantasmo.
function _openPhantomDeepLink({ outputMint, pairUrl }) {
  const appUrl = location.origin;
  const ref = `https://phantom.app/ul/v1/connect?app_url=${encodeURIComponent(appUrl)}`;
  const dex = CFG.buildDexUrl({ outputMint, pairUrl });
  try {
    window.open(ref, "_blank", "noopener,noreferrer");
  } catch {}
  setTimeout(() => window.open(dex, "_blank", "noopener,noreferrer"), 300);
}

function _lockPageScroll(lock) {
  try {
    const b = document.body;
    if (lock) {
      if (b.dataset.scrollLocked) return;
      b.dataset.scrollLocked = "1";
      b.style.overflow = "hidden";
      b.style.paddingRight = `${window.innerWidth - document.documentElement.clientWidth}px`;
    } else {
      delete b.dataset.scrollLocked;
      b.style.overflow = "";
      b.style.paddingRight = "";
    }
  } catch {}
}

function _watchKeyboardViewport(on) {
  try {
    if (!window.visualViewport) return;
    const setVar = () => {
      const kb = Math.max(0, window.innerHeight - window.visualViewport.height);
      document.documentElement.style.setProperty("--kb-safe", `${kb}px`);
    };
    if (on) {
      if (!window.__fdvVVWired) {
        window.__fdvVVWired = true;
        window.visualViewport.addEventListener("resize", setVar);
        window.visualViewport.addEventListener("scroll", setVar);
      }
      setVar();
    } else {
      if (window.__fdvVVWired) {
        window.visualViewport.removeEventListener("resize", setVar);
        window.visualViewport.removeEventListener("scroll", setVar);
        window.__fdvVVWired = false;
      }
      document.documentElement.style.removeProperty("--kb-safe");
    }
  } catch {}
}

function _handleSwapClickFromEl(el) {
  const { mint, pairUrl, tokenHydrate, priority, relay, timeoutMs } = _collectHardDataFromEl(el);
  if (!mint) return;

  const mobile = isLikelyMobile();
  const phantom = hasPhantomInstalled();

  if (mobile) {
    const url = CFG.buildJupUrl({
      inputMint: SOL_MINT,
      outputMint: mint,
      amountUi: 0.1,
      slippageBps: CFG.defaultSlippageBps,
      platform: "mobile",
    });
    try { _log("Opening Jupiter…"); } catch {}
    window.location.href = url; 
    return;
  }
  if (!phantom) {
    const url = CFG.buildDexUrl({ outputMint: mint, pairUrl: tokenHydrate?.headlineUrl || pairUrl });
    window.open(url, "_blank", "noopener");
    return;
  }
  openSwapModal({
    inputMint: SOL_MINT,
    outputMint: mint,
    tokenHydrate,
    pairUrl,
    priority,
    relay,
    timeoutMs,
  });
}

function _decimalsFor(mint) {
  if (mint === SOL_MINT) return 9;
  return CFG.tokenDecimals[mint] ?? 6;
}
function _uiToRaw(amountUi, mint) {
  const dec = _decimalsFor(mint);
  return Math.floor(Number(amountUi) * 10 ** dec);
}

async function _loadWeb3() {
  if (web3) return web3;
  web3 = await import("https://esm.sh/@solana/web3.js@1.95.3");
  return web3;
}

function _now() { return Date.now(); }
function _hasLiveSession(skewMs = 1500) { return !!(_rpcSession.token && _rpcSession.exp - skewMs > _now()); }

async function _sha256(buf){ return new Uint8Array(await crypto.subtle.digest("SHA-256", buf)); }
function _b64uToBytes(b64u){ const b64=b64u.replace(/-/g,'+').replace(/_/g,'/'); const pad='='.repeat((4-(b64.length%4))%4); const bin=atob(b64+pad); return Uint8Array.from(bin, c=>c.charCodeAt(0)); }
function _hexToBytes(hex){ const a=new Uint8Array(Math.ceil(hex.length/2)); for(let i=0;i<a.length;i++) a[i]=parseInt(hex.substr(i*2,2),16); return a; }
function _leadingZeroBits(bytes){ let bits=0; for(const b of bytes){ if(b===0){bits+=8; continue;} for(let i=7;i>=0;i--){ if((b>>i)&1) return bits+(7-i); } } return bits; }

async function _solvePow(chalB64, bits = 18) {
  const payload = _b64uToBytes(chalB64);
  const delim = new TextEncoder().encode(":");
  const t0 = performance.now();
  const BUDGET_MS = 20000;
  for (let nonce = 0; nonce < 0x7fffffff; nonce++) {
    if ((nonce & 0x3fff) === 0) {
      if (performance.now() - t0 > BUDGET_MS) break;
      await Promise.resolve();
    }
    const nhex = nonce.toString(16).padStart(8, "0");
    const nbytes = _hexToBytes(nhex);
    const buf = new Uint8Array(payload.length + 1 + nbytes.length);
    buf.set(payload, 0); buf.set(delim, payload.length); buf.set(nbytes, payload.length + 1);
    const h = await _sha256(buf);
    if (_leadingZeroBits(h) >= bits) return nhex;
  }
  throw new Error("pow_failed");
}


async function ensureRpcSession(force = false) {
  if (!force && _hasLiveSession()) return _rpcSession.token;
  if (_sessionInFlight && !force) return _sessionInFlight;

  const base = CFG.rpcUrl.replace(/\/+$/,"");

  const run = (async () => {
    try {
      let r = await fetch(`${base}/session`, { method: "POST" });
      if (r.status === 401) {
        const chalHdr = r.headers.get("x-pow-chal");
        const bits = +(r.headers.get("x-pow-bits") || 18);
        if (chalHdr?.startsWith("v1:")) {
          const chal = chalHdr.slice(3);
          _log("Verifying…");
          const nonceHex = await _solvePow(chal, bits);
          _log("POW solved, acquiring session…");
          r = await fetch(`${base}/session`, { method: "POST", headers: { "x-pow": `v1:${chal}:${nonceHex}` } });
        }
      }
      if (r.ok) {
        const j = await r.json().catch(()=>null);
        if (j?.session) {
          _rpcSession = { token: j.session, exp: Number(j.exp) || (_now() + 120_000) };
          _challengeOk = true;
          _refreshChallengeChrome();
          return _rpcSession.token;
        }
      }
    } catch (e) {
      _log(`Session verify error: ${e.message || e}`, "err");
    }

    try {
      const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getHealth", params: [] });
      let res = await fetch(base, { method: "POST", headers: { "Content-Type": "application/json" }, body });
      if (res.status === 401) {
        const chalHdr = res.headers.get("x-pow-chal");
        const bits = +(res.headers.get("x-pow-bits") || 18);
        if (chalHdr?.startsWith("v1:")) {
          const chal = chalHdr.slice(3);
          _log("PoW acquiring session…");
          _log("Verifying…");
          const nonceHex = await _solvePow(chal, bits);
          res = await fetch(base, {
            method: "POST",
            headers: { "Content-Type": "application/json", "x-pow": `v1:${chal}:${nonceHex}` },
            body
          });
          console.log("session resp", res);
        }
      }
      const newSess = res.headers.get("x-new-session");
      const exp = Number(res.headers.get("x-session-exp") || 0);
      if (newSess) {
        _rpcSession = { token: newSess, exp: exp || (_now() + 120_000) };
        _challengeOk = true;
        _refreshChallengeChrome();
        _log("Verification complete ✓", "ok");
        return _rpcSession.token;
      }
    } catch (e) {
      _log(`Verification error: ${e.message || e}`, "err");
    }

    _challengeOk = false;
    _refreshChallengeChrome();
    return null;
  })();

  _sessionInFlight = run.finally(() => { _sessionInFlight = null; });
  return _sessionInFlight;
}

// Reflect session state in UI
function _refreshChallengeChrome() {
  const ok = _hasLiveSession();
  const chip = _el("[data-captcha-state]");
  if (chip) {
    const anim = chip.dataset.verifying === "1";
    if (!anim) {
      chip.textContent = ok ? "Verified" : "Unverified";
    }
    chip.classList.toggle("ok", ok && !anim);
  }
  const go = _el("[data-swap-go]");
  if (go) {
    const pk = _state?.pubkey?.toBase58?.();
    const blocked = !pk || !ok;
    go.disabled = blocked;
    go.dataset.blocked = blocked ? "1" : "";
    go.setAttribute("aria-disabled", blocked ? "true" : "false");
    go.classList.toggle("disabled", blocked);
  }
}

async function _connectPhantom() {
  try {
    const provider = window?.solana;
    if (!provider?.isPhantom) {
      window.open("https://phantom.app", "_blank");
      throw new Error("Phantom not found. Please install Phantom.");
    }
    const resp = await provider.connect();
    const { PublicKey } = await _loadWeb3();
    _state.wallet = provider;
    _state.pubkey = new PublicKey(resp.publicKey.toString());
    _log(`Connected: ${_state.pubkey.toBase58()}`, "ok");

    try {
      provider.removeAllListeners?.("disconnect");
      provider.on?.("disconnect", () => {
        _state.wallet = null;
        _state.pubkey = null;
        _log("Wallet disconnected", "warn");
        _refreshModalChrome();
      });
    } catch {}

    CFG.onConnect?.(_state.pubkey.toBase58());
    _refreshModalChrome(); 
    try {
      document.dispatchEvent(new CustomEvent("swap:wallet-connect", {
        detail: { pubkey: _state.pubkey.toBase58(), wallet: "phantom" }
      }));
    } catch {}
  } catch (e) {
    _log(`Connect error: ${e.message || e}`, "err");
    CFG.onError?.("connect", e);
  }
}


// UI-aware verification used on modal open and on swap click
async function _verifySessionWithUi(force = false) {
  if (!force && _hasLiveSession()) {
    _refreshChallengeChrome();
    return _rpcSession.token;
  }
  try { document.dispatchEvent(new CustomEvent("swap:verify:start")); } catch {}
  _startVerifyAnim();
  try {
    const tok = await ensureRpcSession(force);
    if (tok) { try { document.dispatchEvent(new CustomEvent("swap:verify:ok")); } catch {} }
    else { try { document.dispatchEvent(new CustomEvent("swap:verify:fail")); } catch {} }
    return tok;
  } finally {
    _stopVerifyAnim();
  }
}

let _preQuoteCtl = null;
const _debounce = (fn, ms = 180) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };

async function _preQuote() {
  const inputMint  = _el("[data-swap-input-mint]")?.value?.trim();
  const outputMint = _el("[data-swap-output-mint]")?.value?.trim();
  const amountUi   = _el("[data-swap-amount]")?.value;
  const slippageBps = parseInt(_el("[data-swap-slip]")?.value || CFG.defaultSlippageBps, 10);

  if (!inputMint || !outputMint || !Number(amountUi)) {
    _renderPreQuote(null);
    return;
  }

  const amount = _uiToRaw(amountUi, inputMint);

  try {
    if (_preQuoteCtl) _preQuoteCtl.abort();
    _preQuoteCtl = new AbortController();
    const signal = _preQuoteCtl.signal;

    const url = new URL(`${CFG.jupiterBase}/swap/v1/quote`);
    url.searchParams.set("inputMint", inputMint);
    url.searchParams.set("outputMint", outputMint);
    url.searchParams.set("amount", String(amount));
    url.searchParams.set("slippageBps", String(slippageBps));
    url.searchParams.set("restrictIntermediateTokens", "true");

    const res = await fetch(url.toString(), { signal });
    if (!res.ok) throw new Error(`quote ${res.status}`);
    const quote = await res.json();
    _state.preQuote = quote;
    CFG.onQuote?.(quote);
    _renderPreQuote(quote);
  } catch {
    _renderPreQuote(null);
  }
}
const _kickPreQuote = _debounce(_preQuote, 200);

// In _quoteAndSwap(), emit swap lifecycle events
async function _quoteAndSwap() {
  if (window.__fdvSwapBusy) return;
  window.__fdvSwapBusy = true;
  try {
    if (!_state.wallet || !_state.pubkey) {
      _log("Please connect your wallet.", "warn");
      return;
    }
    if (!_hasLiveSession()) await _verifySessionWithUi(true);
    if (!_hasLiveSession()) { _log("Verification failed. Please try again.", "err"); return; }

    const inputMint  = _el("[data-swap-input-mint]").value.trim();
    const outputMint = _el("[data-swap-output-mint]").value.trim();
    const amountUi   = _el("[data-swap-amount]").value;
    const slippageBps = parseInt(_el("[data-swap-slip]").value || CFG.defaultSlippageBps, 10);
    const amount = _uiToRaw(amountUi, inputMint);
    const feeAccount = CFG.feeAtas[inputMint] || null;
    const platformFeeBps = feeAccount ? CFG.platformFeeBps : 0;

    const { Connection, VersionedTransaction, PublicKey } = await _loadWeb3();

    const endpoint = CFG.rpcUrl.replace(/\/+$/,"");
    const conn = new Connection(endpoint, {
      commitment: "processed",
      fetchMiddleware: (url, options, fetch) => {
        const h = { ...(options.headers || {}), "content-type": "application/json" };
        if (_rpcSession.token) h["x-session"] = _rpcSession.token; 
        options.headers = h;
        return fetch(url, options);
      },
    });

    _log("Fetching quote…");
    const q = new URL(`${CFG.jupiterBase}/swap/v1/quote`);
    q.searchParams.set("inputMint", inputMint);
    q.searchParams.set("outputMint", outputMint);
    q.searchParams.set("amount", String(amount));
    q.searchParams.set("slippageBps", String(slippageBps));
    q.searchParams.set("restrictIntermediateTokens", "true");
    if (platformFeeBps > 0) q.searchParams.set("platformFeeBps", String(platformFeeBps));

    const qRes = await fetch(q.toString());
    if (!qRes.ok) throw new Error(`Quote failed: ${qRes.status} ${await qRes.text()}`);
    const quote = await qRes.json();
    try { document.dispatchEvent(new CustomEvent("swap:quote", { detail: { quote } })); } catch {}
    _log(`Best out (raw): ${quote.outAmount || "n/a"}`);
    CFG.onQuote?.(quote);

    if (platformFeeBps > 0) {
      _log("Checking fee account…");
      const info = await conn.getParsedAccountInfo(new PublicKey(feeAccount)).catch(() => null);
      if (!info?.value) throw new Error("Cannot read feeAccount from RPC (auth/session?).");
      const parsed = info.value.data?.parsed;
      const mint = parsed?.info?.mint;
      const owner = parsed?.info?.owner;
      if (mint !== inputMint) throw new Error(`feeAccount mint mismatch. Expected ${inputMint}, got ${mint}.`);
      if (owner !== CFG.feeReceiverWallet) throw new Error(`feeAccount owner mismatch. Expected ${CFG.feeReceiverWallet}, got ${owner}.`);
    }

    _log("Building swap transaction (with fee)…");
    const sRes = await fetch(`${CFG.jupiterBase}/swap/v1/swap`, {
      method: "POST",
      headers: {"Content-Type":"application/json"},
      body: JSON.stringify({
        quoteResponse: quote,
        userPublicKey: _state.pubkey.toBase58(),
        feeAccount: feeAccount || undefined,
        dynamicComputeUnitLimit: true,
        dynamicSlippage: { maxBps: slippageBps },
      })
    });
    if (!sRes.ok) throw new Error(`Swap build failed: ${sRes.status} ${await sRes.text()}`);
    const { swapTransaction } = await sRes.json();
    if (!swapTransaction) throw new Error("No swapTransaction in response");

    const raw = atob(swapTransaction);
    const rawBytes = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i++) rawBytes[i] = raw.charCodeAt(i);
    const vtx = VersionedTransaction.deserialize(rawBytes);

    const sendViaWallet = false;
    let signature;

    if (sendViaWallet) {
      _log("Requesting signature from wallet…");
      const sigRes = await _state.wallet.signAndSendTransaction(vtx);
      signature = typeof sigRes === "string" ? sigRes : sigRes?.signature;
    } else {
      _log("Requesting signature…");
      const signed = await _state.wallet.signTransaction(vtx);
      _log("Submitting via proxy…");
      const h = _rpcSession.token ? { "x-session": _rpcSession.token } : {};
      signature = await conn.sendRawTransaction(signed.serialize(), {
        preflightCommitment: "processed",
        skipPreflight: false,
        minContextSlot: undefined,
      });
    }

    if (!signature) throw new Error("No signature returned");
    try { document.dispatchEvent(new CustomEvent("swap:sent", { detail: { signature } })); } catch {}

    _log("Confirming (polling)…");
    const ok = await _confirmWithPolling(conn, signature, { timeoutMs: 90_000, intervalMs: 1_500 });
    if (ok) {
      _log("Confirmed ✅", "ok");
      CFG.onSwapConfirmed?.(signature);
      document.dispatchEvent(new CustomEvent("swap:confirmed", { detail: { signature, inputMint, outputMint, amountUi } }));
    } else {
      _log("Not confirmed within 90s. It may still land. Check your explorer.", "warn");
    }
  } catch (e) {
    if (String(e).includes("custom program error: 6025")) {
      _log("Swap failed: feeAccount must be ATA for the input mint (ExactIn). Token-2022 not supported for fees.", "err");
    }
    _log(String(e.message || e), "err");
    CFG.onError?.("swap", e);
  } finally {
    window.__fdvSwapBusy = false;
  }
}

async function _confirmWithPolling(connection, signature, { timeoutMs = 90_000, intervalMs = 1_500 } = {}) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const { value } = await connection.getSignatureStatuses([signature]);
      const st = value && value[0];
      if (st) {
        if (st.err) throw new Error(`Transaction error: ${JSON.stringify(st.err)}`);
        const conf = st.confirmationStatus ||
          (st.confirmations != null ? (st.confirmations > 0 ? "confirmed" : null) : null);
        if (conf === "confirmed" || "finalized" === conf) return true;
      }
    } catch {}
    await new Promise(r => setTimeout(r, intervalMs));
  }
  return false;
}

const MODAL_HTML = `
<div class="fdv-modal-backdrop" data-swap-backdrop>
  <div class="fdv-modal" role="dialog" aria-modal="true" aria-labelledby="fdv-swap-title">
    <div class="fdv-modal-header">
      <div class="fdv-title-wrap">
        <h3 id="fdv-swap-title" class="fdv-title">Swap</h3>
        <div class="fdv-header-controls">
          <div class="fdv-chips">
            <span class="fdv-chip" data-swap-network>Solana Mainnet</span>
            <span class="fdv-chip fdv-chip-fee" data-swap-fee>Fee: —</span>
            <span class="fdv-chip fdv-chip-wallet" data-swap-wallet>Wallet: Not connected</span>
            <span class="fdv-chip fdv-chip-captcha" data-captcha-state>Unverified</span>
          </div>
          <button class="btn fdv-btn-phantom" data-swap-connect>Connect Phantom</button>
        </div>
      </div>
      <button class="fdv-close" data-swap-close aria-label="Close">&times;</button>
    </div>

    <div class="fdv-modal-body">
      <section class="fdv-pane fdv-pane-form">
        <div class="fdv-token">
          <div class="fdv-token-media">
            <div class="fdv-token-header" data-token-header></div>
            <img class="fdv-token-logo" data-token-logo alt="">
          </div>
          <div class="fdv-token-main">
            <div class="fdv-token-title">
              <span class="fdv-token-symbol" data-token-symbol>—</span>
              <span class="fdv-token-name" data-token-name></span>
              <a class="fdv-token-external" target="_blank" rel="noopener" data-token-external>Dex</a>
            </div>
            <div class="fdv-token-price">
              <span data-token-price>—</span>
              <span class="fdv-chip" data-token-change>—</span>
            </div>
            <div class="fdv-token-grid">
              <div class="kv"><div class="k">Liquidity</div><div class="v" data-token-liq>—</div></div>
              <div class="kv"><div class="k">24h Volume</div><div class="v" data-token-vol24>—</div></div>
              <div class="kv"><div class="k">FDV</div><div class="v" data-token-fdv>—</div></div>
              <div class="kv"><div class="k">Age</div><div class="v" data-token-age>—</div></div>
            </div>
          </div>
        </div>

        <div class="fdv-field">
          <label class="fdv-label">Pay (input mint)</label>
          <div class="fdv-input">
            <input data-swap-input-mint inputmode="text" spellcheck="false" value="${SOL_MINT}" />
          </div>
          <div class="fdv-help">Fees are taken from the <b>input</b> mint (ExactIn).</div>
        </div>

        <div class="fdv-field">
          <label class="fdv-label">Receive (output mint)</label>
          <div class="fdv-input">
            <input data-swap-output-mint inputmode="text" spellcheck="false" />
          </div>
        </div>

        <div class="fdv-row">
          <div class="fdv-field">
            <label class="fdv-label">Amount (input)</label>
            <div class="fdv-input fdv-input-amount">
              <input data-swap-amount type="number" step="0.000000001" value="0.1" />
              <div class="fdv-quick">
                <button type="button" class="fdv-quickbtn" data-amt="0.05">0.05</button>
                <button type="button" class="fdv-quickbtn" data-amt="0.1">0.1</button>
                <button type="button" class="fdv-quickbtn" data-amt="0.25">0.25</button>
              </div>
            </div>
          </div>

          <div class="fdv-field">
            <label class="fdv-label">Slippage (bps)</label>
            <div class="fdv-input fdv-input-stepper">
              <button type="button" class="fdv-step" data-slip-delta="-10" aria-label="Decrease slippage">−</button>
              <input data-swap-slip type="number" />
              <button type="button" class="fdv-step" data-slip-delta="+10" aria-label="Increase slippage">+</button>
            </div>
            <div class="fdv-help">50 bps = 0.50%</div>
          </div>
        </div>

        <div class="fdv-prequote" data-prequote>
          <div class="row"><div>Est. Output:</div><div class="v" data-pre-out>—</div></div>
          <div class="row"><div>Min Received (slip):</div><div class="v" data-pre-min>—</div></div>
          <div class="row"><div>Route:</div><div class="v" data-pre-route>—</div></div>
        </div>

        <div class="fdv-note">
          <div class="fdv-note-title">Important Notes</div>
          <div class="fdv-note-body"><p>Prototype version: 0.0.1</p></div>
        </div>
      </section>

      <aside class="fdv-pane fdv-pane-aside">
        <div class="fdv-wallet"></div>
        <div class="fdv-status" aria-live="polite">
          <div class="fdv-log" data-swap-log></div>
        </div>
      </aside>
    </div>

    <div class="fdv-modal-footer">
      <button class="btn fdv-btn-secondary" data-swap-close>Cancel</button>
      <div class="fdv-modal-controls">
        <a class="btn fdv-btn-secondary" data-swap-learn href="#" rel="noopener">Learn more</a>
        <button class="btn fdv-btn-primary" data-swap-go>Quote & Swap</button>
      </div>
    </div>
  </div>
</div>
`;

function _ensureModalMounted() {
  if (document.querySelector("[data-swap-backdrop]")) return;
  document.body.insertAdjacentHTML("beforeend", MODAL_HTML);

  document.addEventListener("click", (e) => {
    if (e.target.matches("[data-swap-close]") || e.target.closest("[data-swap-close]")) _closeModal();
    if (e.target.matches("[data-swap-backdrop]")) _closeModal();
  });

  _el("[data-swap-connect]").addEventListener("click", _connectPhantom);
  _el("[data-swap-go]").addEventListener("click", _quoteAndSwap);
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") _closeModal(); });

  _el("[data-swap-slip]").value = CFG.defaultSlippageBps ?? 50;

  document.querySelectorAll(".fdv-quickbtn").forEach(btn => {
    btn.addEventListener("click", () => {
      const v = btn.getAttribute("data-amt");
      const input = _el("[data-swap-amount]");
      if (input && v) { input.value = v; input.dispatchEvent(new Event("input", { bubbles:true })); }
    });
  });

  document.querySelectorAll("[data-slip-delta]").forEach(btn => {
    btn.addEventListener("click", () => {
      const delta = parseInt(btn.getAttribute("data-slip-delta"), 10) || 0;
      const el = _el("[data-swap-slip]");
      if (!el) return;
      const cur = parseInt(el.value || CFG.defaultSlippageBps || 50, 10);
      const next = Math.max(0, cur + delta);
      el.value = String(next);
      _kickPreQuote();
    });
  });

  _el("[data-swap-amount]").addEventListener("input", _kickPreQuote);
  _el("[data-swap-slip]").addEventListener("input", _kickPreQuote);
  _el("[data-swap-input-mint]").addEventListener("input", () => { _refreshModalChrome(); _kickPreQuote(); });
  _el("[data-swap-output-mint]").addEventListener("input", _kickPreQuote);
}

function _applyTokenHydrate(h) {
  const t = {
    mint: h.mint,
    symbol: h.symbol || "",
    name: h.name || "",
    imageUrl: h.imageUrl,
    headerUrl: h.headerUrl,
    priceUsd: h.priceUsd,
    v24hTotal: h.v24hTotal,
    liquidityUsd: h.liquidityUsd,
    fdv: h.fdv ?? h.marketCap,
    marketCap: h.marketCap ?? h.fdv,
    headlineUrl: h.headlineUrl,
    headlineDex: h.headlineDex,
  };
  _state.token = { ...( _state.token || {} ), ...t };

  const m = {
    logo: _el("[data-token-logo]"),
    header: _el("[data-token-header]"),
    sym: _el("[data-token-symbol]"),
    name: _el("[data-token-name]"),
    price: _el("[data-token-price]"),
    change: _el("[data-token-change]"),
    liq: _el("[data-token-liq]"),
    vol24: _el("[data-token-vol24]"),
    fdv: _el("[data-token-fdv]"),
    age: _el("[data-token-age]"),
    ext: _el("[data-token-external]"),
  };

  if (m.logo) {
    if (t.imageUrl) m.logo.src = t.imageUrl;
    else { m.logo.removeAttribute("src"); m.logo.style.background = "#222"; }
  }
  if (m.header) {
    const bg = t.headerUrl || "";
    const esc = (window.CSS && CSS.escape) ? CSS.escape(bg) : bg;
    m.header.style.background = bg ? `center/cover no-repeat url(${esc})` : "#0a0f19";
  }

  if (m.sym) m.sym.textContent = t.symbol || "—";
  if (m.name) m.name.textContent = t.name || "";
  if (m.price && t.priceUsd != null) m.price.textContent = _fmtPrice(t.priceUsd);
  if (m.liq && t.liquidityUsd != null) m.liq.textContent = _fmtMoney(t.liquidityUsd);
  if (m.vol24 && t.v24hTotal != null) m.vol24.textContent = _fmtMoney(t.v24hTotal);
  if (m.fdv && (t.fdv != null || t.marketCap != null)) m.fdv.textContent = _fmtMoney(t.fdv ?? t.marketCap);
  if (m.ext && t.headlineUrl) { m.ext.href = t.headlineUrl; m.ext.textContent = t.headlineDex || "Dex"; }

  const outEl = _el("[data-swap-output-mint]");
  if (outEl && !outEl.value && t.mint) outEl.value = t.mint;
}

async function _loadTokenProfile(mint, opts = {}) {
  const {
    relay = "normal",
    priority = (relay === "priority"),
    timeoutMs = 8000,
    tokenHydrate,
    pairUrl,
    noFetch = false,
  } = opts;

  const mount = {
    logo: _el("[data-token-logo]"),
    header: _el("[data-token-header]"),
    sym: _el("[data-token-symbol]"),
    name: _el("[data-token-name]"),
    price: _el("[data-token-price]"),
    change: _el("[data-token-change]"),
    liq: _el("[data-token-liq]"),
    vol24: _el("[data-token-vol24]"),
    fdv: _el("[data-token-fdv]"),
    age: _el("[data-token-age]"),
    ext: _el("[data-token-external]"),
  };

  if (!tokenHydrate) {
    mount.sym.textContent = "…";
    mount.name.textContent = "";
    mount.price.textContent = "Loading…";
    mount.change.textContent = "—";
    mount.liq.textContent = "—";
    mount.vol24.textContent = "—";
    mount.fdv.textContent = "—";
    mount.age.textContent = "—";
    mount.ext.href = "#";
    mount.ext.textContent = "Dex";
  }

  if (tokenHydrate?.mint) _applyTokenHydrate(tokenHydrate);

  if (noFetch) { _refreshModalChrome(); return; }

  try {
    const ac = new AbortController();
    const to = setTimeout(() => ac.abort(new Error("timeout")), timeoutMs);
    const t = await fetchTokenInfo(mint, { priority, signal: ac.signal });
    clearTimeout(to);

    if (pairUrl && !t.headlineUrl) t.headlineUrl = pairUrl;

    _state.token = t;

    if (mount.logo) {
      if (t.imageUrl) mount.logo.src = t.imageUrl;
      else { mount.logo.removeAttribute("src"); mount.logo.style.background = "#222"; }
    }
    if (mount.header) {
      const bg = t.headerUrl || "";
      const esc = (window.CSS && CSS.escape) ? CSS.escape(bg) : bg;
      mount.header.style.background = bg ? `center/cover no-repeat url(${esc})` : "#0a0f19";
    }

    mount.sym.textContent = t.symbol || "—";
    mount.name.textContent = t.name || "";
    mount.price.textContent = _fmtPrice(t.priceUsd);

    const ch = (t.change24h ?? t.change1h ?? t.change5m);
    mount.change.textContent = (ch == null) ? "—" : `${(ch>=0?"+":"")}${ch.toFixed(2)}%`;
    mount.change.style.background = ch == null ? "" : (ch >= 0 ? "rgba(0,194,168,.12)" : "rgba(255,107,107,.12)");
    mount.change.style.borderColor = ch == null ? "var(--fdv-border)" : (ch >= 0 ? "#184f49" : "#522");

    mount.liq.textContent = _fmtMoney(t.liquidityUsd);
    mount.vol24.textContent = _fmtMoney(t.v24hTotal);
    mount.fdv.textContent = _fmtMoney(t.fdv ?? t.marketCap);
    mount.age.textContent = _fmtAge(t.ageMs);

    if (t.headlineUrl) {
      mount.ext.href = t.headlineUrl;
      mount.ext.textContent = (t.headlineDex || "Dex");
    } else if (pairUrl) {
      mount.ext.href = pairUrl;
      mount.ext.textContent = "Dex";
    } else {
      mount.ext.href = `https://dexscreener.com/token/${encodeURIComponent(t.mint)}`;
      mount.ext.textContent = "Dexscreener";
    }

    const outEl = _el("[data-swap-output-mint]");
    if (outEl && !outEl.value) outEl.value = t.mint;

    _refreshModalChrome();
    _kickPreQuote();
  } catch (e) {
    _state.token = _state.token || null;
    mount.price.textContent = "Failed to load token.";
    mount.change.textContent = "—";
    _refreshModalChrome();
  }
}

function _renderPreQuote(q) {
  const elOut = _el("[data-pre-out]");
  const elMin = _el("[data-pre-min]");
  const elRoute = _el("[data-pre-route]");
  if (!q) {
    if (elOut) elOut.textContent = "—";
    if (elMin) elMin.textContent = "—";
    if (elRoute) elRoute.textContent = "—";
    return;
  }
  const outRaw = Number(q.outAmount || 0);
  const outDec = _decimalsFor(_el("[data-swap-output-mint]")?.value?.trim() || "");
  const outUi = outRaw / 10 ** outDec;

  const slipBps = parseInt(_el("[data-swap-slip]")?.value || CFG.defaultSlippageBps, 10);
  const minUi = outUi * (1 - (slipBps / 10_000));

  if (elOut) elOut.textContent = _fmtNumber(outUi);
  if (elMin) elMin.textContent = _fmtNumber(minUi);

  const hops = Array.isArray(q.routePlan?.[0]?.swapPlan) ? q.routePlan[0].swapPlan : [];
  const legs = hops.map(h => h.swapInfo?.label || h.swapInfo?.amm || h.swapInfo?.programLabel).filter(Boolean);
  if (elRoute) elRoute.textContent = legs.length ? legs.join(" → ") : "Jupiter route";
}

function _short(pk = "") { return pk ? pk.slice(0,4) + "…" + pk.slice(-4) : "—"; }

function _refreshModalChrome(){
  const pk = _state?.pubkey?.toBase58?.() || null;
  const feeBps = CFG.platformFeeBps ?? 0;
  const inMint = _el("[data-swap-input-mint]")?.value?.trim();
  const outMint = _el("[data-swap-output-mint]")?.value?.trim() || _state?.outputMint || _state?.token?.mint || "";
  const feeDest = (inMint && CFG.feeAtas?.[inMint]) ? CFG.feeAtas[inMint] : null;

  const chipFee = _el("[data-swap-fee]");
  if (chipFee) chipFee.textContent = feeBps > 0 ? `Fee: ${feeBps} bps` : "Fee: 0";

  const chipW = _el("[data-swap-wallet]");
  if (chipW) chipW.textContent = pk ? `Wallet: ${_short(pk)}` : "Wallet: Not connected";

  const dest = _el("[data-fee-dest]");
  if (dest) dest.textContent = feeDest ? _short(feeDest) : "—";

  _refreshChallengeChrome();

  const btnConn = _el("[data-swap-connect]");
  if (btnConn) {
    const connected = !!pk;
    btnConn.textContent = connected ? "Wallet Connected" : "Connect Phantom";
    btnConn.setAttribute("aria-label", connected ? "Wallet Connected" : "Connect Phantom");
    btnConn.classList.toggle("connected", connected);
    btnConn.disabled = connected;
  }

  const btnLearn = _el("[data-swap-learn]");
  if (btnLearn) {
    const validMint = typeof outMint === "string" && outMint.length > 0;
    btnLearn.href = validMint ? `/token/${encodeURIComponent(outMint)}` : "#";
    btnLearn.setAttribute("aria-disabled", validMint ? "false" : "true");
    btnLearn.classList.toggle("disabled", !validMint);

    if (!btnLearn.dataset.wired) {
      btnLearn.dataset.wired = "1";
      btnLearn.addEventListener("click", (e) => {
        // If mint invalid, do nothing
        const href = btnLearn.getAttribute("href") || "#";
        if (href === "#") { e.preventDefault(); return; }
        // Close modal then navigate
        try { _el("[data-swap-close]")?.click(); } catch {}
        // Allow default navigation for normal link behavior
      });
    }
  }
}

function _openModal(){
  _el("[data-swap-backdrop]")?.classList.add("show");
  _clearLog();
  _refreshModalChrome();
  try { document.dispatchEvent(new CustomEvent("swap:open")); } catch {}
  // Pause pipeline (only mark if we caused it)
  try {
    if (!isGlobalStreamThrottled()) {
      throttleGlobalStream("swap_modal");
      _modalPausedPipeline = true;
    }
  } catch {}
  _verifySessionWithUi(false).catch(()=>{});
  _lockPageScroll(true);
  _watchKeyboardViewport(true);
  setTimeout(()=>{ _el("[data-swap-amount]")?.focus(); }, 30);
}

function _closeModal(){
  const bd=_el("[data-swap-backdrop]");
  if (bd) bd.classList.remove("show");
  _clearLog();
  // Resume pipeline only if we paused it
  try {
    if (_modalPausedPipeline) {
      releaseGlobalStreamThrottle();
      _modalPausedPipeline = false;
    }
  } catch {}
  _lockPageScroll(false);
  _watchKeyboardViewport(false);
}

function _setModalFields({ inputMint, outputMint, amountUi, slippageBps }) {
  if (inputMint)  _el("[data-swap-input-mint]").value = inputMint;
  if (outputMint) _el("[data-swap-output-mint]").value = outputMint;
  if (amountUi != null) _el("[data-swap-amount]").value = amountUi;
  _el("[data-swap-slip]").value = slippageBps ?? CFG.defaultSlippageBps ?? 50;
}

function _el(sel){ return document.querySelector(sel); }

// TODO: fix signature output
function _log(msg, cls = "", signature = "") {
  const logEl = _el("[data-swap-log]");
  if (!logEl) return;

  const d = document.createElement("div");
  if (cls) d.className = cls;
  d.textContent = msg;

  if (signature) {
    d.append(" ");
    const a = document.createElement("a");
    a.href = `https://solscan.io/tx/${encodeURIComponent(signature)}`;
    a.target = "_blank";
    a.rel = "noopener noreferrer";
    a.textContent = "TXN link";
    d.appendChild(a);
  }

  logEl.appendChild(d);
  logEl.scrollTop = logEl.scrollHeight;
}


function _clearLog(){ const logEl=_el("[data-swap-log]"); if (logEl) logEl.innerHTML=""; }

function _fmtNumber(x) {
  const n = Number(x);
  if (!Number.isFinite(n)) return "—";
  if (Math.abs(n) >= 1) return n.toLocaleString(undefined, { maximumFractionDigits: 4 });
  return n.toFixed(8).replace(/0+$/,"").replace(/\.$/,"");
}
function _fmtPrice(n) {
  const x = Number(n);
  if (!Number.isFinite(x)) return "—";
  if (x >= 1) return "$" + x.toLocaleString(undefined, { maximumFractionDigits: 4 });
  return "$" + x.toFixed(8).replace(/0+$/,"").replace(/\.$/,"");
}
function _fmtMoney(n) {
  const x = Number(n);
  if (!Number.isFinite(x)) return "—";
  if (x < 1000) return "$" + x.toFixed(2);
  return "$" + Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 2 }).format(x);
}
function _fmtAge(ms) {
  if (!Number.isFinite(ms)) return "—";
  const s = Math.floor(ms / 1000);
  const u = [
    ["y", 31536000], ["mo", 2592000], ["d", 86400],
    ["h", 3600], ["m", 60], ["s", 1],
  ];
  for (const [label, div] of u) if (s >= div) return `${Math.floor(s / div)}${label}`;
  return "0s";
}

(function bridgeSwapModalState() {
  let prev = null;
  const SEL = '.fdv-modal-backdrop';

  function emit(open) {
    try {
      document.dispatchEvent(new CustomEvent('swap:modal-state', { detail: { open: !!open } }));
    } catch {}
  }
  function check() {
    const open = !!document.querySelector(SEL);
    if (open !== prev) {
      prev = open;
      emit(open);
    }
  }

  const start = () => {
    try {
      check();
      const mo = new MutationObserver(check);
      mo.observe(document.body, { childList: true, subtree: true });
      window.addEventListener('beforeunload', () => mo.disconnect(), { once: true });
    } catch {}
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start, { once: true });
  } else {
    start();
  }
})();

export function initSwapSystem() {
  initSwap({
    feeReceiverWallet: FDV_FEE_RECEIVER,
    feeAtas: {
      "So11111111111111111111111111111111111111112": "4FSwzXe544mW2BLYqAAjcyBmFFHYgMbnA1XUdtGUeST8", //WRAPPED SOL
      "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v": "BKWwTmwc7FDSRb82n5o76bycH3rKZ4Xqt87EjZ2rnUXB", //USDC
    }, // always use wrapped SOL for fee

    jupiterBase: "https://lite-api.jup.ag",
    rpcUrl: FDV_TURNSTILE_BASE, 

    platformFeeBps: 5,         // 0.05% 
    defaultSlippageBps: 50,     

    tokenDecimals: {
      "So11111111111111111111111111111111111111112": 9, // SOL
      "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v": 6, // USDC
    },
  });

  bindSwapButtons(document);
}
