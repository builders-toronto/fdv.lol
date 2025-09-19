import { fetchTokenInfo } from "../data/dexscreener.js";

//TODO: add more web3 cloudflare++

const SOL_MINT = "So11111111111111111111111111111111111111112";

const DEFAULTS = {
  jupiterBase: "https://lite-api.jup.ag",

  rpcUrl: "https://solana-rpc-proxy.fdvlol.workers.dev",
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
  buildJupUrl({ inputMint, outputMint, amountUi, slippageBps }) {
    const u = new URL("https://jup.ag/swap");
    if (inputMint) u.searchParams.set("inputMint", inputMint);
    if (outputMint) u.searchParams.set("outputMint", outputMint);
    if (slippageBps != null) u.searchParams.set("slippageBps", String(slippageBps));
    if (amountUi != null) u.searchParams.set("amount", String(amountUi));
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
let _challengeOk = false;                   // UI state after successful /auth
let _turnstileWidgetId = null;              // turnstile widget id
let _turnstileScriptInjected = false;

let _turnstileToken = null;

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

function _handleSwapClickFromEl(el) {
  const { mint, pairUrl, tokenHydrate, priority, relay, timeoutMs } = _collectHardDataFromEl(el);
  if (!mint) return;

  if (isLikelyMobile() || !hasPhantomInstalled()) {
    const bestPair = pairUrl || tokenHydrate?.headlineUrl || null;
    if (bestPair) {
      const url = CFG.buildDexUrl({ outputMint: mint, pairUrl: bestPair });
      window.open(url, "_blank", "noopener");
      return;
    }
    (async () => {
      let url = CFG.buildDexUrl({ outputMint: mint });
      try {
        const ac = new AbortController();
        const to = setTimeout(() => ac.abort(new Error("timeout")), timeoutMs ?? 2000);
        const info = await fetchTokenInfo(mint, { priority: true, signal: ac.signal });
        clearTimeout(to);
        if (info?.headlineUrl) url = CFG.buildDexUrl({ outputMint: mint, pairUrl: info.headlineUrl });
      } catch {}
      window.open(url, "_blank", "noopener");
    })();
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

async function _authFromChallengeToken(token) {
  const res = await fetch(CFG.rpcUrl.replace(/\/+$/,"") + CFG.authPath, {
    method: "POST",
    headers: { "x-turnstile-token": token },
  });
  console.log(res);
  if (!res.ok) throw new Error(`Auth failed: ${res.status} ${await res.text()}`);
  const { session, exp } = await res.json();
  if (!session || !exp) throw new Error("Invalid auth response");
  _rpcSession = { token: session, exp: Number(exp) || (_now() + 90_000) };
  _challengeOk = true;
  _refreshChallengeChrome();
  return _rpcSession.token;
}

function _hasLiveSession(skewMs = 1500) {
  return !!(_rpcSession.token && _rpcSession.exp - skewMs > _now());
}

function _refreshChallengeChrome() {
  const badge = _el("[data-captcha-state]");
  if (badge) {
    const ok = _challengeOk && _hasLiveSession();
    badge.textContent = ok ? "Verified" : "Unverified";
    badge.classList.toggle("ok", ok);
  }
  const go = _el("[data-swap-go]");
  if (go) {
    const pk = _state?.pubkey?.toBase58?.();
    go.disabled = !pk || !_hasLiveSession();
  }
  // If session expired, reset the widget so user can solve again
  if (!_hasLiveSession() && typeof window !== "undefined" && window.turnstile && _turnstileWidgetId != null) {
    try { window.turnstile.reset(_turnstileWidgetId); } catch {}
  }
}

// Turnstile script loader
function _ensureTurnstileScript() {
  if (typeof window === "undefined") return;
  if (window.turnstile || _turnstileScriptInjected) return;
  const s = document.createElement("script");
  s.src = "https://challenges.cloudflare.com/turnstile/v0/api.js";
  s.async = true;
  s.defer = true;
  document.head.appendChild(s);
  _turnstileScriptInjected = true;
}

// Render the widget into the modal
function _renderTurnstileWhenReady() {
  const host = _el("[data-turnstile-slot]");
  if (!host) return;

  const tryRender = () => {
    if (!window.turnstile || !window.turnstile.render) {
      setTimeout(tryRender, 150);
      return;
    }
    // Reset if already present
    if (_turnstileWidgetId != null) {
      try { window.turnstile.reset(_turnstileWidgetId); } catch {}
      return;
    }
    _turnstileWidgetId = window.turnstile.render(host, {
      sitekey: CFG.turnstileSiteKey || DEFAULTS.turnstileSiteKey,
      theme: "auto",       // "light" | "dark" | "auto"
      size: "normal",      // "normal" | "flexible"
      callback: async (token) => {
        _turnstileToken = token;
        try {
          _log("Verifying challenge…");
          await _authFromChallengeToken(token);
          _log("Verification complete ✓", "ok");
        } catch (e) {
          _challengeOk = false;
          _log(`Verification error: ${e.message || e}`, "err");
        } finally {
          _refreshChallengeChrome();
        }
      },
      "error-callback": () => {
        _turnstileToken = null;
        _challengeOk = false;
        _refreshChallengeChrome();
        _log("Challenge error. Please retry.", "err");
      },
      "expired-callback": () => {
        _turnstileToken = null;
        _challengeOk = false;
        _refreshChallengeChrome();
        _log("Challenge expired. Please check the box again.", "warn");
      },
    });
  };
  tryRender();
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
    //change fdv-btn-phantom text to connected
    
    CFG.onConnect?.(_state.pubkey.toBase58());
    _refreshModalChrome();
  } catch (e) {
    _log(`Connect error: ${e.message || e}`, "err");
    CFG.onError?.("connect", e);
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

async function _quoteAndSwap() {
  try {
    if (!_state.wallet || !_state.pubkey) throw new Error("Connect Phantom first.");
    if (!_hasLiveSession()) throw new Error("Please solve the verification first.");

    const inputMint  = _el("[data-swap-input-mint]").value.trim();
    const outputMint = _el("[data-swap-output-mint]").value.trim();
    const amountUi   = _el("[data-swap-amount]").value;
    const slippageBps = parseInt(_el("[data-swap-slip]").value || CFG.defaultSlippageBps, 10);

    const amount = _uiToRaw(amountUi, inputMint);
    const feeAccount = CFG.feeAtas[inputMint] || null;
    const platformFeeBps = feeAccount ? CFG.platformFeeBps : 0;

    const { Connection, VersionedTransaction, PublicKey } = await _loadWeb3();

    // Build a Connection that **always** sends x-session
    const endpoint = CFG.rpcUrl.replace(/\/+$/,"");
    const sessionHdr = { "x-session": _rpcSession.token };
    const conn = new Connection(endpoint, {
      commitment: "processed",
      httpHeaders: sessionHdr, // some builds respect this
      fetchMiddleware: (url, options, fetch) => { // this guarantees it
        options.headers = {
          ...(options.headers || {}),
          ...sessionHdr,
          "content-type": "application/json",
        };
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

    _log("Requesting signature from wallet…");
    const sigRes = await _state.wallet.signAndSendTransaction(vtx);
    const signature = typeof sigRes === "string" ? sigRes : sigRes?.signature;
    if (!signature) throw new Error("No signature returned");

    _log(`Sent. Signature: <a href="https://solscan.io/tx/${signature}" target="_blank">TXN link</a>`, "ok");
    CFG.onSwapSent?.(signature);

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
      _log("Swap failed: feeAccount must be ATA for the **input** mint (ExactIn). Token-2022 not supported for fees.", "err");
    }
    _log(String(e.message || e), "err");
    CFG.onError?.("swap", e);
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

        <!-- Turnstile widget host -->
        <div data-turnstile-slot style="min-height:78px;display:flex;align-items:center"></div>
      </aside>
    </div>

    <div class="fdv-modal-footer">
      <button class="btn fdv-btn-secondary" data-swap-close>Cancel</button>
      <button class="btn fdv-btn-primary" data-swap-go disabled>Quote & Swap</button>
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

  _ensureTurnstileScript();
  _renderTurnstileWhenReady();
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
  const feeDest = (inMint && CFG.feeAtas?.[inMint]) ? CFG.feeAtas[inMint] : null;

  const chipFee = _el("[data-swap-fee]");
  if (chipFee) chipFee.textContent = feeBps > 0 ? `Fee: ${feeBps} bps` : "Fee: 0";

  const chipW = _el("[data-swap-wallet]");
  if (chipW) chipW.textContent = pk ? `Wallet: ${_short(pk)}` : "Wallet: Not connected";

  const dest = _el("[data-fee-dest]");
  if (dest) dest.textContent = feeDest ? _short(feeDest) : "—";

  _refreshChallengeChrome(); // updates the "Quote & Swap" disabled state
}

function _openModal(){
  _el("[data-swap-backdrop]")?.classList.add("show");
  _clearLog();
  _challengeOk = _hasLiveSession(); // keep previous session if still valid
  _refreshModalChrome();
  _ensureTurnstileScript();
  _renderTurnstileWhenReady();
  setTimeout(()=>{ _el("[data-swap-amount]")?.focus(); }, 30);
}
function _closeModal(){ const bd=_el("[data-swap-backdrop]"); if (bd) bd.classList.remove("show"); _clearLog(); }
function _setModalFields({ inputMint, outputMint, amountUi, slippageBps }) {
  if (inputMint)  _el("[data-swap-input-mint]").value = inputMint;
  if (outputMint) _el("[data-swap-output-mint]").value = outputMint;
  if (amountUi != null) _el("[data-swap-amount]").value = amountUi;
  _el("[data-swap-slip]").value = slippageBps ?? CFG.defaultSlippageBps ?? 50;
}

function _el(sel){ return document.querySelector(sel); }
function _log(msg, cls=""){ const logEl=_el("[data-swap-log]"); if(!logEl) return; const d=document.createElement("div"); if(cls) d.className=cls; d.textContent = msg; logEl.appendChild(d); logEl.scrollTop = logEl.scrollHeight; }
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
