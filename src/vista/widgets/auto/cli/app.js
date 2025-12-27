import { readFile } from "node:fs/promises";

import { runPipeline } from "../lib/pipeline.js";

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
    "  --run-profile            Runs bots headlessly (no UI) using a named profile (auto/follow/volume/sniper).",
    "    --profiles <pathOrUrl>  Profiles JSON file path or https URL.",
    "    --profile <name>        Profile name to select from the profiles file.",
    "    --log-to-console        Mirrors widget logs to stdout.",
    "  --help                   Shows this help.",
    "",
    "Profile shape (example):",
    "  {",
    "    \"profiles\": {",
    "      \"myProfile\": {",
    "        \"rpcUrl\": \"https://...\",",
    "        \"rpcHeaders\": { \"Authorization\": \"Bearer ...\" },",
    "        \"autoWalletSecret\": \"...\",",
    "        \"auto\": false, // or { enabled: true, ...auto keys... } (auto runs by default)",
    "        \"auto\": { /* existing auto-bot profile keys */ },",
    "        \"follow\": { \"enabled\": true, \"targetWallet\": \"...\", \"buyPct\": 25, \"maxHoldMin\": 5, \"pollMs\": 1500 },",
    "        \"volume\": { \"enabled\": true, \"mint\": \"...\", \"bots\": 1, \"minBuyAmountSol\": 0.005, \"maxBuyAmountSol\": 0.02, \"maxSlippageBps\": 2000, \"targetVolumeSol\": 0 }",
    "        \"sniper\": { \"enabled\": true, \"mint\": \"...\", \"buyPct\": 25, \"pollMs\": 1200, \"slippageBps\": 250, \"triggerScoreSlopeMin\": 0.6 }",
    "      }",
    "    }",
    "  }",
  ].join("\n");
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
    delete out.volume;
    delete out.rpcUrl;
    delete out.rpcHeaders;
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
  const profile = pickProfile(doc, profileName);

  // Shared config across bots.
  applyGlobalRpcToStorage(profile);
  await applyAutoWalletToStorage(profile);

  if (logToConsole) {
    try { globalThis.window._fdvLogToConsole = true; } catch {}
  }

  const followCfg = profile?.follow && typeof profile.follow === "object" ? profile.follow : null;
  const volumeCfg = profile?.volume && typeof profile.volume === "object" ? profile.volume : null;
  const sniperCfg = profile?.sniper && typeof profile.sniper === "object" ? profile.sniper : null;

  const enableFollow = shouldEnableSection(followCfg);
  const enableVolume = shouldEnableSection(volumeCfg);
  const enableSniper = shouldEnableSection(sniperCfg);
  // Auto is enabled by default unless explicitly disabled.
  const autoSection = profile?.auto;
  const enableAuto = autoSection === false ? false : autoSection && typeof autoSection === "object" ? shouldEnableSection(autoSection) : true;

  if (!enableAuto && !enableFollow && !enableVolume && !enableSniper) {
    console.error("Profile enables no bots (auto/follow/volume/sniper). Add { auto: {enabled:true} } / { follow: {enabled:true} } / { volume: {enabled:true} } / { sniper: {enabled:true} }.");
    return 2;
  }

  console.log(`Running profile '${String(profileName)}' from ${profilesPathOrUrl}`);
  console.log("Press Ctrl+C to stop.");

  let autoMod = null;
  let followMod = null;
  let volumeMod = null;
  let sniperMod = null;

  if (enableAuto) {
    autoMod = await import("../index.js");
    autoMod.__fdvDebug_setOverrides({ ...(globalThis.__fdvAutoBotOverrides || {}), headless: true });
    autoMod.__fdvCli_applyProfile(pickAutoProfile(profile));
    const ok = await autoMod.__fdvCli_start({ enable: true });
    if (!ok) {
      console.error("Headless start failed (auto bot). See logs above.");
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

  if (enableVolume) {
    volumeMod = await import("../volume/index.js");
    const code = await volumeMod.__fdvCli_start({
      ...(volumeCfg || {}),
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

  const stop = async () => {
    try {
      console.log("\nStopping…");
      try { if (volumeMod) await volumeMod.__fdvCli_stop(); } catch {}
      try { if (sniperMod) await sniperMod.__fdvCli_stop(); } catch {}
      try { if (followMod) await followMod.__fdvCli_stop(); } catch {}
      try { if (autoMod) await autoMod.__fdvCli_stop({ runFinalSellEval: true }); } catch {}
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
  const mod = await import("../index.js");

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
