import { computePumpingLeaders, getRugSignalForMint, focusMint } from "../../meme/metrics/kpi/pumping.js";

const SOL_MINT = "So11111111111111111111111111111111111111112";
const MIN_JUP_SOL_IN = 0.001;
const MIN_SELL_SOL_OUT = 0.004;
const FEE_RESERVE_MIN = 0.0002;   // rent
const FEE_RESERVE_PCT = 0.08;     // 8% reserve (was 15%)
const MIN_SELL_CHUNK_SOL = 0.01;  // allow micro exits (was 0.02)
const SMALL_SELL_FEE_FLOOR = 0.0;      // disable fee below this est out
const AVOID_NEW_ATA_SOL_FLOOR = 0.04;   // don't open new ATAs if SOL below this
const TX_FEE_BUFFER_LAMPORTS  = 500_000;
const SELL_TX_FEE_BUFFER_LAMPORTS = 500_000; 
const EXTRA_TX_BUFFER_LAMPORTS     = 250_000;  
const EDGE_TX_FEE_ESTIMATE_LAMPORTS = 150_000;
const MIN_QUOTE_RAW_AMOUNT = 1_000;
const ELEVATED_MIN_BUY_SOL = 0.06;   
const MAX_CONSEC_SWAP_400 = 3;
const MIN_OPERATING_SOL = 0.007;  
const ROUTER_COOLDOWN_MS = 60_000;
const MINT_RUG_BLACKLIST_MS = 30 * 60 * 1000;
const MINT_BLACKLIST_STAGES_MS =  [2 * 60 * 1000, 15 * 60 * 1000, MINT_RUG_BLACKLIST_MS];
const URGENT_SELL_COOLDOWN_MS= 20_000; 
const URGENT_SELL_MIN_AGE_MS = 7_000;
const MAX_RECURRING_COST_FRAC = 0.0075; // tx + platform fees <= 0.75% of order
const MAX_ONETIME_COST_FRAC   = 0.02; 
const ONE_TIME_COST_AMORTIZE  = 5;
const FAST_OBS_INTERVAL_MS   = 5;    
const SPLIT_FRACTIONS = [0.99, 0.98, 0.97, 0.96, 0.95, 0.90, 0.85, 0.80, 0.75, 0.70, 0.50, 0.33, 0.25, 0.20];
const MINT_OP_LOCK_MS = 30_000;
const BUY_SEED_TTL_MS = 60_000;
const BUY_LOCK_MS = 5_000;
const FAST_OBS_LOG_INTERVAL_MS = 150; 
const LEADER_SAMPLE_MIN_MS = 900;
const RUG_FORCE_SELL_SEVERITY = 0.70;
const RUG_QUOTE_SHOCK_FRAC = 0.35;         
const RUG_QUOTE_SHOCK_WINDOW_MS = 6000;      
const EARLY_URGENT_WINDOW_MS = 15_000; // buyers remorse
const MAX_DOM_LOG_LINES = 100;      
const MAX_LOG_MEM_LINES = 10000; // memory log buffer low speed optimization
const MOMENTUM_FORCED_EXIT_CONSEC = 28;
const POSCACHE_KEY_PREFIX = "fdv_poscache_v1:";
const DUSTCACHE_KEY_PREFIX = "fdv_dustcache_v1:";

const FEE_ATAS = {
  [SOL_MINT]: "4FSwzXe544mW2BLYqAAjcyBmFFHYgMbnA1XUdtGUeST8",  
  "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v": "BKWwTmwc7FDSRb82n5o76bycH3rKZ4Xqt87EjZ2rnUXB", 
};

const UI_LIMITS = {
  BUY_PCT_MIN: 0.01,  // 1%
  BUY_PCT_MAX: 0.50,  // 50%
  MIN_BUY_SOL_MIN: 0.06, // ≥ ~0.01 SOL floor (was 0.03)
  MIN_BUY_SOL_MAX: 1,    // cap min order size at 1 SOL       
  MAX_BUY_SOL_MIN: Math.max(MIN_SELL_SOL_OUT, MIN_JUP_SOL_IN),
  MAX_BUY_SOL_MAX: 5,    // cap max order size at 5 SOL
  LIFE_MINS_MIN: 0,
  LIFE_MINS_MAX: 10080,  // 7 days
};

const DYN_HS = Object.freeze({
  base: 3.8,        
  min: 3.2,         
  max: 6.0,         
  remorseSecs: 22,  
});

function _clamp(n, lo, hi) { const x = Number(n); return Number.isFinite(x) ? Math.min(hi, Math.max(lo, x)) : lo; }

function now() { return Date.now(); }

function _markRpcStress(e, ms = 2000) {
  try {
    const s = String(e?.message || e || "");
    if (/429|Too Many Requests|403|Forbidden/i.test(s)) {
      const jitter = 500 + Math.floor(Math.random() * 2500);
      window._fdvRpcStressUntil = now() + Math.max(500, ms | 0, 2500 + jitter);
    }
  } catch {}
}

function rpcBackoffLeft() {
  const t = Number(window._fdvRpcStressUntil || 0);
  return Math.max(0, t - now());
}

async function rpcWait(kind = "misc", minMs = 250) {
  if (!window._fdvRpcLast) window._fdvRpcLast = new Map();
  const nowTs = now();
  const last = Number(window._fdvRpcLast.get(kind) || 0);
  const stress = rpcBackoffLeft();
  const jitter = Math.floor(Math.random() * 80);
  const wait = Math.max(0, last + minMs - nowTs) + Math.min(3000, stress) + jitter;
  if (wait > 0) await new Promise(r => setTimeout(r, wait));
  window._fdvRpcLast.set(kind, now());
}

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

let _logQueue = [];
let _logRaf = 0;
function _flushLogFrame() {
  if (!logEl) { _logRaf = 0; return; }
  const pinned = (logEl.scrollTop + logEl.clientHeight) >= (logEl.scrollHeight - 4);
  if (_logQueue.length) {
    for (let i = 0; i < 3 && _logQueue.length; i++) {
      const entry = _logQueue.shift();
      const line = typeof entry === "string" ? entry : String(entry?.text ?? "");
      const type = typeof entry === "object" ? String(entry.type || "ok") : "ok";
      const d = document.createElement("div");
      d.className = `log-row ${type}`;
      d.textContent = line;
      logEl.appendChild(d);

      const expandBtn = logEl.querySelector("[data-auto-log-expand]");
      const statsHdr  = logEl.querySelector("[data-auto-stats-header]");
      const stickyCount = (expandBtn ? 1 : 0) + (statsHdr ? 1 : 0);
      const max = Math.max(100, Number(MAX_DOM_LOG_LINES || 600));

      const isSticky = (node) =>
        !!node && (node.hasAttribute("data-auto-log-expand") || node.hasAttribute("data-auto-stats-header"));

      while ((logEl.children.length - stickyCount) > max) {
        let target = logEl.firstElementChild;
        while (target && isSticky(target)) target = target.nextElementSibling;
        if (!target) break; // nothing non-sticky to remove
        logEl.removeChild(target);
      }

      requestAnimationFrame(() => d.classList.add("in"));
      if (pinned) logEl.scrollTop = logEl.scrollHeight;
    }
  }

  if (_logQueue.length) {
    _logRaf = requestAnimationFrame(_flushLogFrame);
  } else {
    _logRaf = 0;
  }
}

function log(msg, type) {
  const t = String(type || "ok").toLowerCase();
  const map = t.startsWith("err") ? "err" : t.startsWith("war") ? "warn" : t.startsWith("info") ? "info" : t.startsWith("help") ? "help" : "ok";

  if (!window._fdvLogBuffer) window._fdvLogBuffer = [];
  const line = `[${new Date().toLocaleTimeString()}] ${msg}`;
  const buf = window._fdvLogBuffer;
  buf.push(line);
  if (buf.length > MAX_LOG_MEM_LINES) {
    buf.splice(0, buf.length - Math.floor(MAX_LOG_MEM_LINES * 0.9));
  }

  if (!logEl) return; // UI not mounted yet; buffer only
  _logQueue.push({ text: line, type: map });
  if (!_logRaf) _logRaf = requestAnimationFrame(_flushLogFrame);
}

function logObj(label, obj) {
  try { log(`${label}: ${JSON.stringify(obj)}`); } catch {}
}

async function _logMoneyMade() {
  try {
    const totalSol = Number(state.moneyMadeSol || 0);
    const baseSol = Number(state.pnlBaselineSol || 0);
    const sessSol = totalSol - baseSol;
    const px = await getSolUsd();
    const usdStr = px > 0 ? ` (${fmtUsd(sessSol * px)})` : "";
    log(`Money made: ${sessSol.toFixed(6)} SOL${usdStr}`);
    try { updateStatsHeader(); } catch {}
  } catch {
    const totalSol = Number(state.moneyMadeSol || 0);
    const baseSol = Number(state.pnlBaselineSol || 0);
    const sessSol = totalSol - baseSol;
    log(`Money made: ${sessSol.toFixed(6)} SOL`);
    try { updateStatsHeader(); } catch {}
  }
}

function getSessionPnlSol() {
  return Number(state.moneyMadeSol || 0) - Number(state.pnlBaselineSol || 0);
}

async function _addRealizedPnl(solProceeds, costSold, label = "PnL") {
  const proceeds = Number(solProceeds || 0);
  const cost = Number(costSold || 0);
  const costKnown = Number.isFinite(cost) && cost > 0;

  const pnl = costKnown ? (proceeds - cost) : 0;
  if (costKnown) {
    state.moneyMadeSol = Number(state.moneyMadeSol || 0) + pnl;
  }
  save();
  try {
    const px = await getSolUsd();
    const totalSol = Number(state.moneyMadeSol || 0);
    const totalUsd = px > 0 ? ` (${fmtUsd(totalSol * px)})` : "";
    if (costKnown) {
      const sign = pnl >= 0 ? "+" : "";
      log(`${label}: ${sign}${pnl.toFixed(6)} SOL | Money made: ${totalSol.toFixed(6)} SOL${totalUsd}`);
    } else {
      // your cost is unknown?
      log(`${label}: proceeds ${proceeds.toFixed(6)} SOL (cost unknown) | Money made: ${totalSol.toFixed(6)} SOL${totalUsd}`);
    }
    try { updateStatsHeader(); } catch {}
  } catch {
    const totalSol = Number(state.moneyMadeSol || 0);
    if (costKnown) {
      const sign = (Number(solProceeds || 0) - Number(costSold || 0)) >= 0 ? "+" : "";
      log(`${label}: ${sign}${(Number(solProceeds||0)-Number(costSold||0)).toFixed(6)} SOL | Money made: ${totalSol.toFixed(6)} SOL`);
    } else {
      log(`${label}: proceeds ${Number(solProceeds||0).toFixed(6)} SOL (cost unknown) | Money made: ${totalSol.toFixed(6)} SOL`);
    }
    try { updateStatsHeader(); } catch {}
  }
}

function redactHeaders(hdrs) {
  const keys = Object.keys(hdrs || {});
  return keys.length ? `{headers: ${keys.join(", ")}}` : "{}";
}

function addOldWalletRecord(rec = {}) {
  try {
    if (!Array.isArray(state.oldWallets)) state.oldWallets = [];
    const item = {
      pub: String(rec.pub || ""),
      secret: String(rec.secret || ""),
      tag: String(rec.tag || ""),
      movedLamports: Number(rec.movedLamports || 0) | 0,
      txSig: String(rec.txSig || ""),
      at: now(),
    };
    state.oldWallets.unshift(item);
    const CAP = 10;
    if (state.oldWallets.length > CAP) state.oldWallets.length = CAP;
    save();
    log(`Stealth archive: saved old wallet ${item.pub.slice(0,4)}… (tag="${item.tag || "rotate"}")`);
  } catch {}
}

const LS_KEY = "fdv_auto_bot_v1";

let state = {
  enabled: false,
  stealthMode: false,
  loadDefaultState: true,
  mint: "",
  tickMs: 10,
  budgetUi: 0.5,  
  maxTrades: 6,  // legacy
  minSecsBetween: 90,
  buyScore: 1.2,
  takeProfitPct: 12,
  stopLossPct: 4,
  slippageBps: 250,
  holdingsUi: 0,
  avgEntryUsd: 0,
  lastTradeTs: 0,
  trailPct: 6,                 
  minProfitToTrailPct: 2,     
  coolDownSecsAfterBuy: 3,    
  minHoldSecs: 5,  
  maxHoldSecs: 50,           
  partialTpPct: 50,            
  minQuoteIntervalMs: 10000, 
  sellCooldownMs: 30000,  
  staleMinsToDeRisk: 4, 
  singlePositionMode: true,
  minNetEdgePct: -5, 
  edgeSafetyBufferPct: 0.1,
  sustainTicksMin: 2,
  sustainChgSlopeMin: 12,
  sustainScSlopeMin: 8,
  fricSnapEpsSol: 0.0020,

  // Auto wallet mode
  autoWalletPub: "",        
  autoWalletSecret: "",      
  recipientPub: "",          
  lifetimeMins: 60,         
  endAt: 0,                 
  buyPct: 0.2,              
  minBuySol: 0.06,
  maxBuySol: 0.12,       
  rpcUrl: "",    
  oldWallets: [],         

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
  USDCfallbackEnabled: true,
  observerDropSellAt: 4,
  observerGraceSecs: 25,
  // Observer hysteresis settings
  observerDropMinAgeSecs: 12,   
  observerDropConsec: 3,     
  observerDropTrailPct: 2.5,    

  // Cache
  pendingGraceMs: 60000,

  // collapse state for <details>
  collapsed: true,
  // hold until new leader detected
  holdUntilLeaderSwitch: false,
  // dynamic observer hold time
  dynamicHoldEnabled: true,
  // Badge status selection
  rideWarming: true,
  warmingMinProfitPct: 100,
  warmingDecayPctPerMin: 0.45,      
  warmingDecayDelaySecs: 20,         
  warmingMinProfitFloorPct: -2.0,   
  warmingAutoReleaseSecs: 45,
  warmingUptickMinAccel: 1.001,        
  warmingUptickMinPre: 0.35,         
  warmingUptickMinDeltaChg5m: 0.012,   
  warmingUptickMinDeltaScore: 0.006,   
  warmingMinLiqUsd: 4000,             
  warmingMinV1h: 800,
  warmingPrimedConsec: 2, 
  warmingMaxLossPct: 8,           // early stop if PnL <= -10% within window
  warmingMaxLossWindowSecs: 30,    // window after buy for the max-loss guard
  warmingEdgeMinExclPct: null,  
  warmingExtendOnRise: true,
  warmingExtendStepMs: 4000,  
  warmingNoHardStopSecs: 35,
 
  reboundGateEnabled: true,         
  reboundLookbackSecs: 35,       
  reboundMaxDeferSecs: 12,         
  reboundHoldMs: 6000,             
  reboundMinScore: 0.45,            
  reboundMinChgSlope: 10,           
  reboundMinScSlope: 7,             
  reboundMinPnLPct: -2,          

  fastExitEnabled: true,
  fastExitSlipBps: 400,          
  fastExitConfirmMs: 9000,      
  fastHardStopPct: 2.5,          
  fastTrailPct: 8,               
  fastTrailArmPct: 5,            
  fastNoHighTimeoutSec: 90,      
  fastTp1Pct: 10,                
  fastTp1SellPct: 30,
  fastTp2Pct: 20,                
  fastTp2SellPct: 30,
  fastAlphaChgSlope: -8,         
  fastAlphaScSlope: -25,         
  fastAccelDropFrac: 0.5,        
  fastAlphaZV1Floor: 0.3,        

  // Early fade & late-entry filters
  earlyExitChgDropFrac: 0.55,    
  earlyExitScSlopeNeg: -40,      
  earlyExitConsec: 4,            
  lateEntryDomShare: 0.65,       
  lateEntryMinPreMargin: 0.02,   

  // Final pump gate
  finalPumpGateEnabled: true,
  finalPumpGateMinStart: 2,
  finalPumpGateDelta: 3,
  finalPumpGateWindowMs: 10000,

  // money made tracker
  moneyMadeSol: 0,
  pnlBaselineSol: 0,
  hideMoneyMade: false,           
  logNetBalance: true,          
  solSessionStartLamports: 0,
};
// init global user interface
let timer = null;
let ledEl;
let logEl, toggleEl, startBtn, stopBtn, mintEl;
let depAddrEl, depBalEl, lifeEl, recvEl, buyPctEl, minBuyEl, maxBuyEl, minEdgeEl, multiEl, warmDecayEl;
let tpEl, slEl, trailEl, slipEl, fricSnapEl;
let advBoxEl, warmMinPEl, warmFloorEl, warmDelayEl, warmReleaseEl, warmMaxLossEl, warmMaxWindowEl, warmConsecEl, warmEdgeEl;
let reboundScoreEl, reboundLookbackEl;
let finalGateEnabledEl, finalGateMinStartEl, finalGateDeltaEl, finalGateWindowEl;

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

let _lastDepFetchTs = 0;

const CONFIG_VERSION = 1;

const CONFIG_SCHEMA = {
  enabled:                  { type: "boolean", def: false },
  stealthMode:              { type: "boolean", def: false },
  mint:                     { type: "string",  def: "" },
  tickMs:                   { type: "number",  def: 10, min: 5, max: 5000 },
  budgetUi:                 { type: "number",  def: 0.5,  min: 0, max: 1 },
  minSecsBetween:           { type: "number",  def: 90,   min: 0, max: 3600 },
  buyPct:                   { type: "number",  def: 0.2,  min: 0.01, max: 0.5 },
  minBuySol:                { type: "number",  def: 0.06, min: 0.01, max: 1 },
  maxBuySol:                { type: "number",  def: 0.12, min: 0.06, max: 5 },
  slippageBps:              { type: "number",  def: 200,  min: 50, max: 2000 },
  coolDownSecsAfterBuy:     { type: "number",  def: 3,    min: 0, max: 120 },
  pendingGraceMs:           { type: "number",  def: 120_000, min: 10_000, max: 600_000 },
  fricSnapEpsSol:           { type: "number",  def: 0.0020, min: 0, max: 0.05 },
  allowMultiBuy:            { type: "boolean", def: false },
  rideWarming:              { type: "boolean", def: true },
  warmingMinProfitPct:      { type: "number",  def: 100,  min: -50, max: 500 },
  warmingDecayPctPerMin:    { type: "number",  def: 0.45, min: 0, max: 5 },
  warmingDecayDelaySecs:    { type: "number",  def: 45,   min: 0, max: 600 },
  warmingMinProfitFloorPct: { type: "number",  def: -2.0, min: -50, max: 50 },
  warmingAutoReleaseSecs:   { type: "number",  def: 90,   min: 0, max: 600 },
  warmingUptickMinAccel:    { type: "number",  def: 1.001 },
  warmingUptickMinPre:      { type: "number",  def: 0.35 },
  warmingUptickMinDeltaChg5m:{ type: "number", def: 0.012 },
  warmingUptickMinDeltaScore:{ type: "number", def: 0.006 },
  warmingMinLiqUsd:         { type: "number",  def: 4000 },
  warmingMinV1h:            { type: "number",  def: 800 },
  warmingPrimedConsec:      { type: "number",  def: 1, min: 1, max: 3 },
  warmingMaxLossPct:        { type: "number",  def: 2.5, min: 1, max: 50 },
  warmingMaxLossWindowSecs: { type: "number",  def: 60, min: 5, max: 180 },
  warmingNoHardStopSecs:    { type: "number",  def: 35,  min: 5, max: 180 },
  minNetEdgePct:            { type: "number",  def: -4, min: -10, max: 10 },
  edgeSafetyBufferPct:      { type: "number",  def: 0.1, min: 0, max: 2 },
  reboundGateEnabled:       { type: "boolean", def: true },
  reboundLookbackSecs:      { type: "number",  def: 35,  min: 5, max: 180 },
  reboundMaxDeferSecs:      { type: "number",  def: 12,  min: 4, max: 120 },
  reboundHoldMs:            { type: "number",  def: 6000, min: 500, max: 15000 },
  reboundMinScore:          { type: "number",  def: 0.45 },
  reboundMinChgSlope:       { type: "number",  def: 10 },
  reboundMinScSlope:        { type: "number",  def: 7 },
  reboundMinPnLPct:         { type: "number",  def: -2, min: -90, max: 90 },
  fastExitEnabled:          { type: "boolean", def: true },
  fastExitSlipBps:          { type: "number",  def: 400 },
  fastExitConfirmMs:        { type: "number",  def: 9000 },
  fastHardStopPct:          { type: "number",  def: 2.5 },
  fastTrailPct:             { type: "number",  def: 8 },
  fastTrailArmPct:          { type: "number",  def: 4 },
  fastNoHighTimeoutSec:     { type: "number",  def: 90 },
  fastTp1Pct:               { type: "number",  def: 12 },
  fastTp1SellPct:           { type: "number",  def: 30 },
  fastTp2Pct:               { type: "number",  def: 20 },
  fastTp2SellPct:           { type: "number",  def: 30 },
  fastAlphaChgSlope:        { type: "number",  def: -3 },
  fastAlphaScSlope:         { type: "number",  def: -10 },
  fastAccelDropFrac:        { type: "number",  def: 0.5 },
  fastAlphaZV1Floor:        { type: "number",  def: 0.3 },
  priorityMicroLamports:    { type: "number", def: 10_000 },
  computeUnitLimit:         { type: "number", def: 1_400_000 },
  strictBuyFilter:          { type: "boolean", def: true },
  dustExitEnabled:          { type: "boolean", def: false },
  dustMinSolOut:            { type: "number",  def: 0.004 },
  sustainTicksMin:          { type: "number",  def: 2, min: 1, max: 4 },
  sustainChgSlopeMin:       { type: "number",  def: 12 },
  sustainScSlopeMin:        { type: "number",  def: 8 },
  finalPumpGateEnabled:     { type: "boolean", def: true },
  finalPumpGateMinStart:    { type: "number",  def: 2 },  
  finalPumpGateDelta:       { type: "number",  def: 3 },   
  finalPumpGateWindowMs:    { type: "number",  def: 10000, min: 1000, max: 30_000 },
};

function coerceNumber(v, def, opts = {}) {
  const n = Number(v);
  const x = Number.isFinite(n) ? n : def;
  if (Number.isFinite(opts.min) && x < opts.min) return opts.min;
  if (Number.isFinite(opts.max) && x > opts.max) return opts.max;
  return x;
}
function coerceBoolean(v, def = false) { return typeof v === "boolean" ? v : (!!v ?? def); }
function coerceString(v, def = "") { return typeof v === "string" ? v : String(v ?? def); }
function coerceByType(v, s) {
  switch (s.type) {
    case "number":  return coerceNumber(v, s.def, s);
    case "boolean": return coerceBoolean(v, s.def);
    case "string":  return coerceString(v, s.def);
    default:        return v ?? s.def;
  }
}
function normalizeState(raw = {}) {
  const out = { ...raw, _cfgVersion: CONFIG_VERSION };
  for (const [k, s] of Object.entries(CONFIG_SCHEMA)) {
    out[k] = coerceByType(raw[k], s);
  }



  out.tickMs = Math.max(1200, Math.min(5000, coerceNumber(out.tickMs, 2000)));
  out.slippageBps = Math.min(250, Math.max(150, coerceNumber(out.slippageBps, 200)));
  out.minBuySol = Math.max(UI_LIMITS.MIN_BUY_SOL_MIN, coerceNumber(out.minBuySol, 0.06));
  out.coolDownSecsAfterBuy = Math.max(0, Math.min(12, coerceNumber(out.coolDownSecsAfterBuy, 5)));
  out.pendingGraceMs = Math.max(120_000, coerceNumber(out.pendingGraceMs, 120_000));
  out.fricSnapEpsSol = coerceNumber(out.fricSnapEpsSol, 0.0020, { min: 0, max: 0.05 });

  out.finalPumpGateEnabled  = !!out.finalPumpGateEnabled;
  out.finalPumpGateMinStart = coerceNumber(out.finalPumpGateMinStart, 2,  { min: 0, max: 50 });
  out.finalPumpGateDelta    = coerceNumber(out.finalPumpGateDelta, 3,     { min: 0, max: 50 });
  out.finalPumpGateWindowMs = coerceNumber(out.finalPumpGateWindowMs, 10000, { min: 1000, max: 30_000 });

  out.reboundLookbackSecs = coerceNumber(out.reboundLookbackSecs, 35, { min: 5, max: 180 });
  out.reboundMaxDeferSecs = coerceNumber(out.reboundMaxDeferSecs, 12, { min: 4, max: 120 });
  out.reboundHoldMs       = coerceNumber(out.reboundHoldMs, 6000, { min: 500, max: 15000 });
  out.reboundMinScore     = coerceNumber(out.reboundMinScore, 0.45);
  out.reboundMinChgSlope  = coerceNumber(out.reboundMinChgSlope, 10);
  out.reboundMinScSlope   = coerceNumber(out.reboundMinScSlope, 7);
  out.reboundMinPnLPct    = coerceNumber(out.reboundMinPnLPct, -2, { min: -90, max: 90 });

  if (typeof out.warmingEdgeMinExclPct !== "number" || !Number.isFinite(out.warmingEdgeMinExclPct)) {
    delete out.warmingEdgeMinExclPct;
  }

  out.oldWallets = Array.isArray(out.oldWallets) ? out.oldWallets.slice(0, 10) : [];
  if (!out.positions || typeof out.positions !== "object") out.positions = {};
  if (!out.rpcHeaders || typeof out.rpcHeaders !== "object") out.rpcHeaders = {};

  return out;
}

function _pcKey(owner, mint) { return `${owner}:${mint}`; }

function _getUrgentSellStore() {
  if (!window._fdvUrgentSell) window._fdvUrgentSell = new Map();
  return window._fdvUrgentSell;
}

function flagUrgentSell(mint, reason = "observer", sev = 1) {
  if (!mint) return;

  try {
    if (state.holdUntilLeaderSwitch) {
      const sig = getRugSignalForMint(mint);
      const isRug = !!sig?.rugged || /rug/i.test(String(reason || ""));
      if (!isRug) return;
    }
  } catch {}


  try {
    const pos = state.positions?.[mint];
    if (pos) {
      const ageMs = now() - Number(pos.lastBuyAt || pos.acquiredAt || 0);
      const postBuyCooldownMs = Math.max(8_000, Number(state.coolDownSecsAfterBuy || 0) * 1000);
      const isRug = /rug/i.test(String(reason||""));

      const highSev = Number(sev || 0) >= Math.max(0.60, Number(RUG_FORCE_SELL_SEVERITY || 0.60));

      if (pos.awaitingSizeSync === true && !isRug && !highSev) return;
      if ((state.rideWarming && pos.warmingHold === true) && !isRug && !highSev) return;
      if (ageMs < Math.max(URGENT_SELL_MIN_AGE_MS, postBuyCooldownMs) && !isRug && !highSev) return;
    }
  } catch {}

  const m = _getUrgentSellStore();
  const prev = m.get(mint) || { until: 0 };
  const nowTs = now();
  if (prev.until && nowTs < prev.until) return; // cooldown

  m.set(mint, { reason, sev, until: nowTs + URGENT_SELL_COOLDOWN_MS });
  const soft = Number(sev || 0) < 0.75;
  if (soft) setMintBlacklist(mint); else setMintBlacklist(mint, MINT_RUG_BLACKLIST_MS);
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
function _getMomentumDropStore() {
  if (!window._fdvMomDrop) window._fdvMomDrop = new Map(); // mint -> { count, lastAt }
  return window._fdvMomDrop;
}
function _getMomExitStore() {
  if (!window._fdvMomExit) window._fdvMomExit = new Map(); // mint -> untilTs
  return window._fdvMomExit;
}
function noteMomentumExit(mint, ttlMs = 30_000) {
  if (!mint) return;
  const until = now() + Math.max(5_000, ttlMs | 0);
  _getMomExitStore().set(mint, until);
}
function shouldForceMomentumExit(mint) {
  try {
    const m = _getMomExitStore();
    const until = Number(m.get(mint) || 0);
    if (!until) return false;
    const alive = now() < until;
    if (!alive) m.delete(mint);
    return alive;
  } catch { return false; }
}


function _fmtDelta(a, b, digits = 2) {
  if (!Number.isFinite(a) || !Number.isFinite(b)) return "—";
  const d = b - a;
  const sign = d > 0 ? "+" : d < 0 ? "-" : "±";
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
    await rpcWait("tx-meta", 800);
    const conn = await getConn();
    let tx = await conn.getTransaction(sig, { maxSupportedTransactionVersion: 0, commitment: "finalized" });
    if (!tx) tx = await conn.getTransaction(sig, { maxSupportedTransactionVersion: 0, commitment: "confirmed" });
    return tx || null;
  } catch (e) { _markRpcStress(e, 1500); return null; }
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
  startPendingCreditWatchdog();
}

async function processPendingCredits() {
  if (!_pendingCredits || _pendingCredits.size === 0) return;
  if (rpcBackoffLeft() > 0) return;
  const nowTs = now();
  for (const [key, entry] of Array.from(_pendingCredits.entries())) {
    if (!entry?.owner || !entry?.mint) { _pendingCredits.delete(key); continue; }
    if (!entry || nowTs > entry.until) { _pendingCredits.delete(key); continue; }
    if (entry.lastTriedAt && (now() - entry.lastTriedAt) < 300) continue;
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
        try {
          const seedUi = Number(entry.basePos?.sizeUi || 0);
          const ageMs  = now() - Number(entry.startedAt || now());
          const partial = seedUi > 0 && sizeUi < seedUi * 0.5;
          const withinWarmup = ageMs < Math.min(30_000, Math.max(10_000, Number(entry.until || now()) - Number(entry.startedAt || now())));
          if (partial && withinWarmup) {
            log(`Pending-credit: small credit ${sizeUi.toFixed(6)} < seed ${seedUi.toFixed(6)} — waiting to reconcile.`);
            entry.until = Math.max(entry.until, now() + 4000);
            continue;
          }
        } catch {}
        const prevPos = state.positions[entry.mint] || entry.basePos || { costSol: 0, hwmSol: 0, acquiredAt: now() };

        const alreadySynced = (prevPos.awaitingSizeSync === false) && Number(prevPos.sizeUi || 0) > 0;
        const nextCost = alreadySynced
          ? Number(prevPos.costSol || 0)
          : Number(prevPos.costSol || 0) + Number(entry.addCostSol || 0);

        const pos = {
          ...prevPos,
          sizeUi,
          decimals: dec,
          costSol: nextCost,
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
    } catch (e) {
      _markRpcStress(e, 3000);
      entry.until = Math.max(entry.until, now() + 4000);
    }
  }
}

function stopPendingCreditWatchdog() {
  try { if (window._fdvPendWatch) clearInterval(window._fdvPendWatch); } catch {}
  window._fdvPendWatch = null;
}

function startPendingCreditWatchdog() {
  if (window._fdvPendWatch) return;
  let startedAt = now();
  window._fdvPendWatch = setInterval(async () => {
    try {
      if (now() - startedAt > 180_000) { stopPendingCreditWatchdog(); return; }
      if (!_pendingCredits || _pendingCredits.size === 0) { stopPendingCreditWatchdog(); return; }
      if (rpcBackoffLeft() > 0) return;
      const kp = await getAutoKeypair().catch(()=>null);
      if (!kp) return;
      await processPendingCredits().catch(()=>{});
      await reconcileFromOwnerScan(kp.publicKey.toBase58()).catch(()=>{});
    } catch {}
  }, 2200);
  log("Pending-credit watchdog running.");
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
    log(`Failed to save position cache for ${ownerPubkeyStr.slice(0,4)}…`, 'err');
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
    log(`Failed to save dust cache for ${ownerPubkeyStr.slice(0,4)}…`, 'err');
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
  return Math.max(
    MIN_SELL_SOL_OUT,
    MIN_JUP_SOL_IN * 1.05,
    Number(state.dustMinSolOut || 0),
    MIN_SELL_CHUNK_SOL
  );
}

async function sanitizeDustCache(ownerPubkeyStr) {
  try {
    const cache = loadDustCache(ownerPubkeyStr);
    let pruned = 0;
    for (const mint of Object.keys(cache)) {
      let ok = false;
      try { ok = await isValidPubkeyStr(mint); } catch {}
      if (!ok) {
        delete cache[mint];
        pruned++;
      }
    }
    if (pruned > 0) {
      saveDustCache(ownerPubkeyStr, cache);
      log(`Pruned ${pruned} invalid dust entries.`);
    }
  } catch {}
}


// async function isDustAmount(mint, sizeUi, decimals) {
//   const estSol = await quoteOutSol(mint, Number(sizeUi || 0), decimals).catch(()=>0);
//   return { isDust: estSol > 0 && estSol < minSellNotionalSol(), estSol };
// }
function moveRemainderToDust(ownerPubkeyStr, mint, sizeUi, decimals) {
  try { addToDustCache(ownerPubkeyStr, mint, sizeUi, decimals); } catch {}
  try { removeFromPosCache(ownerPubkeyStr, mint); } catch {}
  if (state.positions && state.positions[mint]) { delete state.positions[mint]; save(); }
  log(`Remainder classified as dust for ${mint.slice(0,4)}… removed from positions.`, 'warn');
}

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

function clearRouteDustFails(mint) {
  try { window._fdvRouteDustFails.delete(mint); } catch {}
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
  try { return (await import("../swap/index.js"))?.CFG || {}; } catch { return {}; }
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
  const set = (m) => { window.splToken = m; return m; };
  try {
    const m = await import("https://cdn.jsdelivr.net/npm/@solana/spl-token@0.4.14/+esm");
    return set(m);
  } catch {}
  try {
    const m = await import("https://esm.sh/@solana/spl-token@0.4.14?bundle");
    return set(m);
  } catch {
  }
  try {
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
    return set(m);
  } catch {
    const m = {
      TOKEN_PROGRAM_ID: null,
      TOKEN_2022_PROGRAM_ID: null,
      ASSOCIATED_TOKEN_PROGRAM_ID: null,
      getAssociatedTokenAddress: async () => null
    };
    return set(m);
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
      const { TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, createCloseAccountInstruction, getAssociatedTokenAddress } = await loadSplToken();
      const progs = [TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID].filter(Boolean);

      const atapks = [];
      for (const pid of progs) {
        try {
          const mint = new PublicKey(SOL_MINT);
          const ataAny = await getAssociatedTokenAddress(mint, ownerPk, true, pid);
          const ata = typeof ataAny === "string" ? new PublicKey(ataAny) : ataAny;
          if (ata) atapks.push({ pid, ata });
        } catch {}
      }

      const ixs = [];
      for (const { pid, ata } of atapks) {
        try {
          const ai = await conn.getAccountInfo(ata, "processed").catch(e => { _markRpcStress(e, 1500); return null; });
          if (!ai) continue;
          if (typeof createCloseAccountInstruction === "function") {
            ixs.push(createCloseAccountInstruction(ata, ownerPk, ownerPk, [], pid));
          } else {
            ixs.push(new TransactionInstruction({
              programId: pid,
              keys: [
                { pubkey: ata,     isSigner: false, isWritable: true },
                { pubkey: ownerPk, isSigner: false, isWritable: true },
                { pubkey: ownerPk, isSigner: true,  isWritable: false },
              ],
              data: Uint8Array.of(9),
            }));
          }
        } catch (e) { _markRpcStress(e, 1500); }
      }

      if (!ixs.length) return false;

      const tx = new Transaction();
      for (const ix of ixs) tx.add(ix);
      tx.feePayer = ownerPk;
      tx.recentBlockhash = (await conn.getLatestBlockhash("processed")).blockhash;
      tx.sign(signer);
      const sig = await conn.sendRawTransaction(tx.serialize(), { preflightCommitment: "processed", maxRetries: 2 });
      log(`WSOL unwrap sent: ${sig}`);
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

async function confirmSig(sig, { commitment = "confirmed", timeoutMs = 12000, pollMs = 700, requireFinalized = false } = {}) {
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
    } catch (e) { _markRpcStress(e, 1500); }
    const left = rpcBackoffLeft();
    await new Promise(r => setTimeout(r, left > 0 ? left : pollMs));
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
          const res = await conn.getTokenAccountBalance(ata, "confirmed");
          if (res?.value) {
            const ui = Number(res.value.uiAmount || 0);
            const dec = Number.isFinite(res.value.decimals) ? res.value.decimals : undefined;
            if (ui > 0) return { sizeUi: ui, decimals: Number.isFinite(dec) ? dec : decimals };
          }
        } catch (e) { _markRpcStress(e, 1500); }
      }
    }
    // Fallback owner scans (confirmed) if plan allows
    try {
      const { PublicKey } = await loadWeb3();
      const { TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID } = await loadSplToken();
      const ownerPk = new PublicKey(ownerPubkeyStr);
      const tryScan = async (pid) => {
        if (!pid) return null;
        const resp = await conn.getParsedTokenAccountsByOwner(ownerPk, { programId: pid }, "confirmed");
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
    } catch (e) { _markRpcStress(e, 2000); }
    const left = rpcBackoffLeft();
    await new Promise(r => setTimeout(r, left > 0 ? left : pollMs));
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

async function loadWeb3() { // TODO: import locally
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
  log(`RPC connection ready -> ${url} ${redactHeaders(headers)}`, 'info');
  return _conn;
}

async function _getMultipleAccountsInfoBatched(conn, pubkeys, { commitment = "processed", batchSize = 95, kind = "gmai" } = {}) {
  const out = [];
  for (let i = 0; i < pubkeys.length; i += batchSize) {
    const slice = pubkeys.slice(i, i + batchSize);
    try {
      await rpcWait?.(kind, 350);
      const arr = await conn.getMultipleAccountsInfo(slice, commitment).catch(e => { _markRpcStress?.(e, 2000); return new Array(slice.length).fill(null); });
      out.push(...(arr || new Array(slice.length).fill(null)));
    } catch (e) {
      _markRpcStress?.(e, 2000);
      out.push(...new Array(slice.length).fill(null));
    }
  }
  return out;
}

function _readSplAmountFromRaw(rawU8) {
  if (!rawU8 || rawU8.length < 72) return null;
  try {
    const view = new DataView(rawU8.buffer, rawU8.byteOffset, rawU8.byteLength);
    return view.getBigUint64(64, true); // le u64 at offset 64
  } catch {
    let x = 0n;
    for (let i = 0; i < 8; i++) x |= BigInt(rawU8[64 + i] || 0) << (8n * BigInt(i));
    return x;
  }
}

async function fetchSolBalance(pubkeyStr) {
  if (!pubkeyStr) return 0;
  const { PublicKey } = await loadWeb3();
  const url = currentRpcUrl();
  if (!url) return 0;
  let lamports = 0;
  try {
    await rpcWait("sol-balance", 400);
    log(`Fetching SOL balance for ${pubkeyStr.slice(0,4)}…`);
    const conn = await getConn();
    lamports = await conn.getBalance(new PublicKey(pubkeyStr));
  } catch (e) {
    _markRpcStress(e, 2000);
    log(`Balance fetch failed: ${e.message || e}`);
    lamports = 0;
  }
  const sol = lamports / 1e9;
  log(`Balance: ${sol.toFixed(6)} SOL`, 'info');
  try { window._fdvLastSolBal = sol; updateStatsHeader(); } catch {}
  return sol;
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

async function getComputeBudgetConfig() {
  try {
    const cuLimit = Number(state.computeUnitLimit || 1_400_000);
    const cuPriceMicroLamports = Number(state.priorityMicroLamports || 10_000); // ~0.01 lamports/CU
    return {
      cuLimit: Number.isFinite(cuLimit) ? cuLimit : 1_400_000,
      cuPriceMicroLamports: Number.isFinite(cuPriceMicroLamports) ? cuPriceMicroLamports : 10_000,
    };
  } catch {
    return { cuLimit: 1_400_000, cuPriceMicroLamports: 10_000 };
  }
}

async function buildComputeBudgetIxs() {
  try {
    const { ComputeBudgetProgram } = await loadWeb3();
    const { cuLimit, cuPriceMicroLamports } = await getComputeBudgetConfig();
    const ixs = [];
    if (cuLimit > 0) ixs.push(ComputeBudgetProgram.setComputeUnitLimit({ units: cuLimit }));
    if (cuPriceMicroLamports > 0) ixs.push(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: cuPriceMicroLamports }));
    return ixs;
  } catch { return []; }
}

function hasComputeBudgetIx(ixs) {
  try {
    const pidStr = "ComputeBudget11111111111111111111111111";
    return (ixs || []).some(ix => {
      const p = ix?.programId;
      const s = typeof p?.toBase58 === "function" ? p.toBase58() : (p?.toString?.() || String(p || ""));
      return s === pidStr;
    });
  } catch { return false; }
}

function dedupeComputeBudgetIxs(ixs = []) {
  try {
    const pidStr = "ComputeBudget11111111111111111111111111";
    const seen = new Set(); // 'cb:2' / 'cb:3'
    const out = [];
    // Walk from end to keep the last one
    for (let i = ixs.length - 1; i >= 0; i--) {
      const ix = ixs[i];
      const p = ix?.programId;
      const s = typeof p?.toBase58 === "function" ? p.toBase58() : (p?.toString?.() || String(p || ""));
      if (s !== pidStr) { out.push(ix); continue; }
      // ComputeBudget: first byte of data is the tag
      const data = ix?.data instanceof Uint8Array ? ix.data : new Uint8Array();
      const tag = data.length > 0 ? data[0] : -1;
      if (tag === 2 || tag === 3) {
        const key = `cb:${tag}`;
        if (seen.has(key)) {
          continue;
        }
        seen.add(key);
        out.push(ix);
      } else {
        // keep other CB instructions (e.g., heap frame) as-is
        out.push(ix);
      }
    }
    // We traversed backwards; restore original order
    out.reverse();
    return out;
  } catch {
    return Array.isArray(ixs) ? ixs : [];
  }
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

function updateFastExitState(pos, pxNow, alpha, nowTs) {
  try {
    if (!Number.isFinite(pos.fastPeakPx) || pxNow > pos.fastPeakPx) {
      pos.fastPeakPx = pxNow;
      pos.fastPeakAt = nowTs;
    }
    if (!Number.isFinite(pos.fastAccelPeak) || alpha.accelRatio > pos.fastAccelPeak) {
      pos.fastAccelPeak = alpha.accelRatio;
    }
    // Set backside once momentum AND score slope turn negative together
    if (!pos.fastBackside && alpha.chgSlope < 0 && alpha.scSlope < 0) {
      pos.fastBackside = true;
      pos.fastBacksideAt = nowTs;
    }
  } catch {}
}

function computeFastHardStopThreshold(mint, pos, { nowTs } = {}) {
  try {

    const { intensity, tier, chgSlope, scSlope } = computeFinalGateIntensity(mint);

    let thr = 2.6;

    if (tier === "explosive") thr = 2.2;

    else if (tier === "weak") thr = 3.0;

    if (chgSlope < 0 || scSlope < 0 || pos.fastBackside) thr -= 0.2;

    if (intensity >= 1.8) thr += 0.1;

    return Math.max(2.0, Math.min(3.2, thr));

  } catch {
    return 2.6; // Best default teste
  }
}

function checkFastExitTriggers(mint, pos, { pnlPct, pxNow, nowTs }) {
  try {
    if (!state.fastExitEnabled) return { action: "none" };

    const alpha = computeFastAlphaMetrics(mint);
    updateFastExitState(pos, pxNow, alpha, nowTs);

    const fhs = computeFastHardStopThreshold(mint, pos, { nowTs });
    if (Number.isFinite(pnlPct) && pnlPct <= -Math.abs(fhs)) {
      return { action: "sell_all", reason: `FAST_HARD_STOP ${pnlPct.toFixed(2)}%<=-${fhs.toFixed(2)}%`, hardStop: true };
    }

    const armed = Number.isFinite(pnlPct) && pnlPct >= Math.max(0, state.fastTrailArmPct);
    if (armed && Number.isFinite(pos.fastPeakPx) && pos.fastPeakPx > 0) {
      const dropPct = pos.fastPeakPx > 0 ? ((pos.fastPeakPx - pxNow) / pos.fastPeakPx) * 100 : 0;
      if (dropPct >= Math.max(1, state.fastTrailPct)) {
        return { action: "sell_all", reason: `FAST_TRAIL -${dropPct.toFixed(2)}%` };
      }
    }

    const stage = Number(pos.fastTpStage || 0);
    if (Number.isFinite(pnlPct)) {
      if (stage < 1 && pnlPct >= state.fastTp1Pct) {
        pos.fastTpStage = 1;
        return { action: "sell_partial", pct: Math.min(100, Math.max(1, state.fastTp1SellPct)), reason: `FAST_TP1 ${pnlPct.toFixed(2)}%` };
      }
      if (stage < 2 && pnlPct >= state.fastTp2Pct) {
        pos.fastTpStage = 2;
        return { action: "sell_partial", pct: Math.min(100, Math.max(1, state.fastTp2SellPct)), reason: `FAST_TP2 ${pnlPct.toFixed(2)}%` };
      }
    }

    const peakAgeMs = nowTs - Number(pos.fastPeakAt || pos.lastBuyAt || pos.acquiredAt || 0);
    const noHighTimeoutMs = Math.max(20_000, Number(state.fastNoHighTimeoutSec || 90) * 1000);
    if (peakAgeMs >= noHighTimeoutMs && Number.isFinite(pnlPct) && pnlPct > 0) {
      return { action: "sell_partial", pct: 50, reason: "FAST_TIME_STOP" };
    }

    if (alpha.chgSlope <= Math.min(-0.5, state.fastAlphaChgSlope) &&
        alpha.scSlope  <= Math.min(-1, state.fastAlphaScSlope)) {
      return { action: "sell_all", reason: `FAST_ALPHA_DECAY dP=${alpha.chgSlope.toFixed(2)}/m dS=${alpha.scSlope.toFixed(2)}/m` };
    }

    if (!alpha.risingNow && !alpha.trendUp) {
      return { action: "sell_all", reason: "FAST_TREND_FLIP" };
    }

    const accelPeak = Number(pos.fastAccelPeak || 0);
    if (accelPeak > 0 && alpha.accelRatio / accelPeak <= Math.max(0.1, state.fastAccelDropFrac) && alpha.zV1 <= Math.max(0, state.fastAlphaZV1Floor)) {
      return { action: "sell_partial", pct: 50, reason: "FAST_ACCEL_DROP" };
    }

    return { action: "none" };
  } catch {
    return { action: "none" };
  }
}

function computeDynamicHardStopPct(mint, pos, nowTs = now(), ctx = {}) {
  try {
    const base = DYN_HS.base;
    const lo = Math.max(1, DYN_HS.min);
    const hi = Math.max(lo, DYN_HS.max);

    const series = getLeaderSeries(mint, 3) || [];
    const last = series.length ? series[series.length - 1] : {};
    const liq = Number(last.liqUsd || 0);
    const v1h = Number(last.v1h || 0);
    const chgSlope = _clamp(slope3pm(series, "chg5m"), -60, 60);
    const scSlope  = _clamp(slope3pm(series, "pumpScore"), -20, 20);

    let thr = base;
    if (liq >= 30000) thr += 1.0;
    else if (liq >= 15000) thr += 0.5;
    else if (liq < 2500) thr -= 1.0;
    else if (liq < 5000) thr -= 0.5;

    if (v1h >= 3000) thr += 0.5;
    else if (v1h < 600) thr -= 0.25;

    const rising = chgSlope > 0 && scSlope > 0;
    const backside = chgSlope < 0 && scSlope < 0;
    if (rising) thr += 0.5;
    if (backside) thr -= 0.5;

    const ageSec = (nowTs - Number(pos.lastBuyAt || pos.acquiredAt || 0)) / 1000;
    const remorseSecs = Math.max(5, DYN_HS.remorseSecs);
    if (ageSec <= remorseSecs) thr -= 0.5;

    const pnlNetPct = Number(ctx.pnlNetPct);
    const ddPct     = Math.max(0, Number(ctx.drawdownPct || 0));
    const intensity = Number.isFinite(ctx.intensity) ? ctx.intensity : computeFinalGateIntensity(mint).intensity;

    const ds = pos._dynStop || {};
    if (Number.isFinite(pnlNetPct)) {
      ds.peakPnl  = Number.isFinite(ds.peakPnl)  ? Math.max(ds.peakPnl,  pnlNetPct) : pnlNetPct;
      ds.worstPnl = Number.isFinite(ds.worstPnl) ? Math.min(ds.worstPnl, pnlNetPct) : pnlNetPct;
    }

    let widen = 0;
    if (Number.isFinite(ds.peakPnl) && ds.peakPnl > 0) {
      widen += Math.min(1.5, 0.2 + Math.log1p(ds.peakPnl / 10) * 0.6);
    }
    if (intensity > 1.4) widen += 0.6;
    else if (intensity < 0.9) widen -= 0.4;

    let tighten = 0;
    if (ddPct > 0) tighten += Math.min(2.0, ddPct * 0.35);
    if (Number.isFinite(pnlNetPct) && pnlNetPct < 0) {
      tighten += Math.min(1.0, (-pnlNetPct) * 0.08);
    }

    let dyn = thr + widen - tighten;
    dyn = Math.min(hi, Math.max(lo, dyn));

    const prev = Number(ds.current);
    const alpha = 0.35;
    const current = Number.isFinite(prev) ? (prev + alpha * (dyn - prev)) : dyn;

    pos._dynStop = { current, lastAt: nowTs, peakPnl: ds.peakPnl, worstPnl: ds.worstPnl };
    return current;
  } catch {
    return Math.min(DYN_HS.max, Math.max(DYN_HS.min, DYN_HS.base));
  }
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

function estimateProportionalCostSolForSell(mint, amountUi) {
  try {
    const pos = state.positions?.[mint];
    const sz = Number(pos?.sizeUi || 0);
    const cost = Number(pos?.costSol || 0);
    if (sz > 0 && amountUi > 0) return (cost * (amountUi / sz));
  } catch {}
  return null; // unknown cost => no fee
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

async function quoteGeneric(inputMint, outputMint, amountRaw, slippageBps) {
  try {
    const base = await getJupBase();
    const isLite = /lite-api\.jup\.ag/i.test(base);

    let amtStr = "1";
    try {
      if (typeof amountRaw === "string") {
        const bi = BigInt(amountRaw);
        amtStr = bi > 0n ? amountRaw : "1";
      } else {
        const n = Math.floor(Number(amountRaw || 0));
        amtStr = n > 0 ? String(n) : "1";
      }
    } catch { amtStr = "1"; }

    // primary 
    const u1 = new URL("/swap/v1/quote", "https://fdv.lol");
    u1.searchParams.set("inputMint", inputMint);
    u1.searchParams.set("outputMint", outputMint);
    u1.searchParams.set("amount", amtStr);
    u1.searchParams.set("slippageBps", String(Math.max(1, slippageBps | 0)));
    u1.searchParams.set("restrictIntermediateTokens", String(true));
    const r1 = await jupFetch(u1.pathname + u1.search);
    if (r1?.ok) return await r1.json();

    // fallback 
    if (!isLite) {
      const u2 = new URL("/swap/v1/quote", "https://fdv.lol");
      u2.searchParams.set("inputMint", inputMint);
      u2.searchParams.set("outputMint", outputMint);
      u2.searchParams.set("amount", amtStr);
      u2.searchParams.set("slippageBps", String(Math.max(1, slippageBps | 0)));
      u2.searchParams.set("restrictIntermediateTokens", String(false));
      const r2 = await jupFetch(u2.pathname + u2.search);
      if (r2?.ok) return await r2.json();
    }
    return null;
  } catch {
    return null;
  }
}

async function quoteOutSol(inputMint, amountUi, inDecimals) {
  if (!Number.isFinite(amountUi) || amountUi <= 0) {
    log("Valuation skip: zero size.");
    return 0;
  }
  try {
    const ok = await isValidPubkeyStr(inputMint);
    if (!ok) {
      log("Valuation skip: invalid mint.");
      return 0;
    }
  } catch {
    return 0;
  }

  const dec = Number.isFinite(inDecimals) ? inDecimals : await getMintDecimals(inputMint);
  const raw = Math.max(1, Math.floor(amountUi * Math.pow(10, dec)));
  if (raw < MIN_QUOTE_RAW_AMOUNT) {
    log(`Valuation skip: amount below minimum quote size (${MIN_QUOTE_RAW_AMOUNT} raw).`);
    return 0;
  }
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

async function requiredOutAtaRentIfMissing(ownerPubkeyStr, outMint) {
  try {
    if (!outMint || outMint === SOL_MINT) return 0;
    const hasOut = await ataExists(ownerPubkeyStr, outMint);
    if (hasOut) return 0;
    return await tokenAccountRentLamports();
  } catch { return 0; }
}

async function estimateRoundtripEdgePct(ownerPub, outMint, buySolUi, { slippageBps, dynamicFee = true } = {}) {
  try {
    const buyLamports = Math.floor(Number(buySolUi || 0) * 1e9);
    if (!Number.isFinite(buyLamports) || buyLamports <= 0) return null;

    const fwd = await quoteGeneric(SOL_MINT, outMint, buyLamports, slippageBps);
    const outRaw = Number(fwd?.outAmount || 0);
    if (!outRaw || outRaw <= 0) return null;

    const back = await quoteGeneric(outMint, SOL_MINT, outRaw, slippageBps);
    const backLamports = Number(back?.outAmount || 0);
    if (!backLamports || backLamports <= 0) return null;

    // Fees
    const feeBps = Number(getPlatformFeeBps() || 0);
    const txFeesL = EDGE_TX_FEE_ESTIMATE_LAMPORTS;
    const ataRentL = await requiredOutAtaRentIfMissing(ownerPub, outMint); // one-time

    const outSol = backLamports / 1e9;
    const buySol = buyLamports / 1e9;
    let appliedFeeBps = feeBps;

    if (dynamicFee) {
      if (!(outSol >= SMALL_SELL_FEE_FLOOR)) {
        appliedFeeBps = 0;
      } else {
        // fee's only on profitable buys
        const feeSol = outSol * (feeBps / 10_000);
        const pnlNoFee = outSol - buySol;
        const pnlWithFee = outSol - feeSol - buySol;
        if (!(pnlWithFee > 0) || !(pnlNoFee > 0)) {
          appliedFeeBps = 0;
        }
      }
    }

    const platformL = Math.floor(backLamports * (appliedFeeBps / 10_000));
    const recurringL = platformL + txFeesL;

    const edgeL_inclOnetime = backLamports - buyLamports - recurringL - Math.max(0, ataRentL);
    const edgeL_noOnetime   = backLamports - buyLamports - recurringL;

    const pct          = (edgeL_inclOnetime / Math.max(1, buyLamports)) * 100;
    const pctNoOnetime = (edgeL_noOnetime   / Math.max(1, buyLamports)) * 100;

    logObj("Roundtrip edge breakdown", {
      buySol: buyLamports/1e9,
      backSol: backLamports/1e9,
      platformBpsConfigured: feeBps,
      platformBpsApplied: appliedFeeBps,
      platformSol: platformL/1e9,
      txFeesSol: txFeesL/1e9,
      ataRentSol: ataRentL/1e9,
      netSolInclOnetime: edgeL_inclOnetime/1e9,
      netSolNoOnetime: edgeL_noOnetime/1e9,
      pctInclOnetime: Number(pct.toFixed(2)),
      pctNoOnetime: Number(pctNoOnetime.toFixed(2)),
    });

    return {
      pct,
      pctNoOnetime,
      sol: edgeL_inclOnetime / 1e9,
      feesLamports: recurringL + Math.max(0, ataRentL),
      ataRentLamports: Math.max(0, ataRentL),
      recurringLamports: recurringL,
      platformBpsApplied: appliedFeeBps,
      forward: fwd,
      backward: back
    };
  } catch {
    return null;
  }
}

async function executeSwapWithConfirm(opts, { retries = 2, confirmMs = 15000 } = {}) {
  let slip = Math.max(150, Number(opts.slippageBps ?? state.slippageBps ?? 150) | 0);
  const isBuy = (opts?.inputMint === SOL_MINT && opts?.outputMint && opts.outputMint !== SOL_MINT); 
  if (isBuy) slip = Math.min(300, Math.max(200, slip));

  const prevDefer = !!window._fdvDeferSeed;
  window._fdvDeferSeed = true;
  let lastSig = null;
  try {
    const isBuy = (opts?.inputMint === SOL_MINT && opts?.outputMint && opts.outputMint !== SOL_MINT);
    const needFinal = false;
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
          timeoutMs: Math.max(confirmMs, 22_000),
          requireFinalized: needFinal
        }).catch(() => false);
        if (ok) return { ok: true, sig, slip };

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

function _getSwap400Store() {
  if (!window._fdvSwap400) window._fdvSwap400 = new Map();
  return window._fdvSwap400;
}

function noteSwap400(inputMint, outputMint) {
  try {
     const k = `${inputMint}->${outputMint}`;
     const m = _getSwap400Store();
     const prev = m.get(k) || { count: 0 , lastAt: 0 };
     const within = now() - prev.lastAt < 60_000;
     const next = { count: (within ? prev.count : 0) + 1, lastAt: now() };
     m.set(k, next);
     log(`Noted swap 400 for ${k}: count=${next.count}`);
     return next.count;
  } catch { return 0;}
}

async function jupSwapWithKeypair({ signer, inputMint, outputMint, amountUi, slippageBps }) {
    const { PublicKey, VersionedTransaction } = await loadWeb3();
    const conn = await getConn();
    const userPub = signer.publicKey.toBase58();
    const feeBps = Number(getPlatformFeeBps() || 0);
    let feeAccount = null;
    let lastErrCode = "";

    try {
      const okIn  = await isValidPubkeyStr(inputMint);
      const okOut = await isValidPubkeyStr(outputMint);
      if (!okIn || !okOut) throw new Error("INVALID_MINT");
    } catch (e) {
      throw new Error("INVALID_MINT");
    }

    const inDecimals = await getMintDecimals(inputMint);
    let baseSlip = Math.max(150, Number(slippageBps ?? state.slippageBps ?? 150) | 0); 
    const isBuy = (inputMint === SOL_MINT && outputMint !== SOL_MINT); 
    if (isBuy) baseSlip = Math.min(300, Math.max(200, baseSlip));
    const amountRaw = Math.max(1, Math.floor(amountUi * Math.pow(10, inDecimals)));

    let _preBuyRent = 0;
    if (inputMint === SOL_MINT && outputMint !== SOL_MINT) {
      try { _preBuyRent = await requiredAtaLamportsForSwap(userPub, inputMint, outputMint); } catch { _preBuyRent = 0; }
    }

    const baseUrl = await getJupBase();
    const isLite = /lite-api\.jup\.ag/i.test(baseUrl);
    const restrictAllowed = !isLite;

    const isSell = (inputMint !== SOL_MINT) && (outputMint === SOL_MINT);
    // Sells: allow intermediates by default
    let restrictIntermediates = isSell ? "false" : "true";

    // Defer fee decision until after quoting (we will disable fee on small sells)
    let quoteIncludesFee = false;

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

    if (isBuy) {
      const rentSol = (_preBuyRent/1e9).toFixed(6);
      log(`Buy cost breakdown: input=${(amountRaw/1e9).toFixed(6)} SOL + ataRent≈${rentSol}`);
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
    
    function buildQuoteUrl({ outMint, slipBps, restrict, asLegacy = false, amountOverrideRaw, withFee = false }) {
      const u = new URL("/swap/v1/quote", "https://fdv.lol");
      const amt = Number.isFinite(amountOverrideRaw) ? amountOverrideRaw : amountRaw;
      u.searchParams.set("inputMint", inputMint);
      u.searchParams.set("outputMint", outMint);
      u.searchParams.set("amount", String(amt));
      u.searchParams.set("slippageBps", String(slipBps));
      u.searchParams.set("restrictIntermediateTokens", String(isLite ? true : (restrict === "false" ? false : true)));
      // Only include fee when explicitly allowed for this sell
      if (withFee && feeBps > 0 && feeAccount) u.searchParams.set("platformFeeBps", String(feeBps));
      if (asLegacy) u.searchParams.set("asLegacyTransaction", "true");
      return u;
    }

    // Decide fee receiver (sell-only) but don't include it until we know out amount
    let feeDestCandidate = null;
    if (feeBps > 0 && isSell) {
      const acct = FEE_ATAS[outputMint] || (outputMint === SOL_MINT ? FEE_ATAS[SOL_MINT] : null);
      feeDestCandidate = acct || null;
    }

    // async function ensureQuoteHasFee(quoteObj) {
    //   if (!feeDestCandidate) return { quote: quoteObj, useFee: false };
    //   if (feeBps <= 0) return { quote: quoteObj, useFee: false };
    //   const hasInQuote = Number(quoteObj?.platformFeeBps || quoteObj?.info?.platformFeeBps || 0) > 0;
    //   if (hasInQuote) return { quote: quoteObj, useFee: true };
    //   const qFee = buildQuoteUrl({
    //     outMint: outputMint,
    //     slipBps: baseSlip,
    //     restrict: restrictIntermediates,
    //     withFee: true
    //   });
    //   const qRes = await jupFetch(qFee.pathname + qFee.search);
    //   if (qRes.ok) {
    //     const qJson = await qRes.json();
    //     const ok = Number(qJson?.platformFeeBps || qJson?.info?.platformFeeBps || 0) > 0;
    //     return { quote: ok ? qJson : quoteObj, useFee: ok };
    //   }
    //   return { quote: quoteObj, useFee: false };
    // } 

    const q = buildQuoteUrl({ outMint: outputMint, slipBps: baseSlip, restrict: restrictIntermediates, withFee: false });
    logObj("Quote params", {
      inputMint, outputMint, amountUi, inDecimals, slippageBps: baseSlip,
      restrictIntermediateTokens: restrictIntermediates, feeBps: 0
    });

    let quote;
    let haveQuote = false;

    {
    try {
      const qRes = await jupFetch(q.pathname + q.search);
      if (!qRes.ok) {
        if (isSell) {
          const altRestrict = (restrictIntermediates === "false" ? "true" : (restrictAllowed ? "false" : "true"));
          const alt = buildQuoteUrl({ outMint: outputMint, slipBps: baseSlip, restrict: altRestrict, withFee: false });
          log(`Primary sell quote failed (${qRes.status}). Retrying with restrictIntermediateTokens=${alt.searchParams.get("restrictIntermediateTokens")} …`);
          const qRes2 = await jupFetch(alt.pathname + alt.search);
          if (qRes2.ok) {
            quote = await qRes2.json();
            haveQuote = true;
          } else {
            const body = await qRes2.text().catch(()=> "");
            log(`Sell quote retry failed: ${body || qRes2.status}`);
            haveQuote = false; // defer to fallbacks
          }
        } else {
          throw new Error(`quote ${qRes.status}`);
        }
      } else {
        quote = await qRes.json();
        haveQuote = true;
      }
      if (haveQuote) {
        if (isSell) {
          const outRaw = Number(quote?.outAmount || 0);
          const outSol = outRaw / 1e9;
          const eligible = feeBps > 0 && !!feeDestCandidate;
            if (eligible) {
              const qFee = buildQuoteUrl({ outMint: outputMint, slipBps: baseSlip, restrict: restrictIntermediates, withFee: true });
              const qFeeRes = await jupFetch(qFee.pathname + qFee.search);
              if (qFeeRes.ok) {
                quote = await qFeeRes.json();
                feeAccount = feeDestCandidate; // ensure swap body includes fee account
                quoteIncludesFee = true;
                log(`Sell fee enabled @ ${feeBps} bps (est out ${outSol.toFixed(6)} SOL)`);
              } else {
                log("Fee quote failed; proceeding without fee for this sell.");
                quoteIncludesFee = false;
              }
            } else {
            // Disable fee on small sells
            feeAccount = null;
            quoteIncludesFee = false;
            if (outSol > 0) log(`Small sell detected (${outSol.toFixed(6)} SOL). Fee disabled.`);
          }
        }
        logObj("Quote", { inAmount: quote?.inAmount, outAmount: quote?.outAmount, routePlanLen: quote?.routePlan?.length });
      }
    } catch (e) {
      if (!isSell) throw e;
      haveQuote = false;
      log(`Sell quote error; will try fallbacks: ${e.message || e}`, 'err');
    }
  }

  if (haveQuote) {
    // Skip tiny sells outright (no retries/fallbacks)
    if (isSell) {
      const outRaw = Number(quote?.outAmount || 0); // lamports
      const minOutLamports = Math.floor(minSellNotionalSol() * 1e9);
      if (!Number.isFinite(outRaw) || outRaw <= 0 || outRaw < minOutLamports) {
        log(`Sell below minimum; skipping (${(outRaw/1e9).toFixed(6)} SOL < ${(minOutLamports/1e9).toFixed(6)})`);
        log('Consider exporting your wallet and selling DUST manually.');
        throw new Error("BELOW_MIN_NOTIONAL");
      }
    }

      if (isSell && feeDestCandidate) {
        try {
          const outRawNoFee = Number(quote?.outAmount || 0);
          const profitableNoFee = shouldAttachFeeForSell({
            mint: inputMint,
            amountRaw: amountRaw,
            inDecimals: inDecimals,
            quoteOutLamports: outRawNoFee
          });

          if (profitableNoFee) {
            const qFee = buildQuoteUrl({
              outMint: outputMint,
              slipBps: baseSlip,
              restrict: restrictIntermediates,
              withFee: true
            });
            const qFeeRes = await jupFetch(qFee.pathname + qFee.search);
            if (qFeeRes.ok) {
              const quoteWithFee = await qFeeRes.json();
              const outRawWithFee = Number(quoteWithFee?.outAmount || 0);
              const stillProfitable = shouldAttachFeeForSell({
                mint: inputMint,
                amountRaw: amountRaw,
                inDecimals: inDecimals,
                quoteOutLamports: outRawWithFee
              });
              if (stillProfitable) {
                quote = quoteWithFee;
                feeAccount = feeDestCandidate;
                quoteIncludesFee = true;
                const outSol = outRawWithFee / 1e9;
                log(`Sell fee enabled @ ${feeBps} bps (est PnL>0, out ${outSol.toFixed(6)} SOL).`);
              } else {
                // Keep no-fee quote if fee would remove profit
                feeAccount = null;
                quoteIncludesFee = false;
                log("Fee suppressed: adding fee removes estimated profit (keeping no-fee sell).");
              }
            } else {
              feeAccount = null;
              quoteIncludesFee = false;
              log("Fee quote failed; proceeding without fee for this sell.");
            }
          } else {
            feeAccount = null;
            quoteIncludesFee = false;
            log("No estimated profit; fee disabled for this sell.");
          }
        } catch {
          feeAccount = null;
          quoteIncludesFee = false;
          log("Profit check failed; fee disabled for this sell.");
        }
      }

    // const isRouteErr = (codeOrMsg) => /ROUTER_DUST|COULD_NOT_FIND_ANY_ROUTE|NO_ROUTE|0x1788/i.test(String(codeOrMsg||""));
    // let sawRouteDust = false;

    const first = await buildAndSend(false);
    if (first.ok) { await notePendingBuySeed(); await seedCacheIfBuy(); return first.sig; }
    if (!first.ok) lastErrCode = first.code || lastErrCode;

    // Try shared accounts if needed
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

    // Escalate on NO_ROUTE/ROUTER_DUST: high slip + no fee + relaxed path, full-size only
    if (isSell && (/ROUTER_DUST|NO_ROUTE/i.test(String(lastErrCode || "")))) {
      try {
        const slip2 = 2000;
        const rFlag = restrictAllowed ? "false" : "true";
        // remove fee for retry
        quoteIncludesFee = false;
        feeAccount = null;
        const q2 = buildQuoteUrl({ outMint: outputMint, slipBps: slip2, restrict: rFlag, withFee: false });
        log(`Dust/route fallback: slip=${slip2} bps, no fee, relaxed route …`);
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
            asLegacy: true,
            withFee: !!(feeAccount && feeBps > 0)
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
          log(`Legacy re-quote error: ${e.message || e}`, 'err');
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
      try {
        const { cuPriceMicroLamports } = await getComputeBudgetConfig();
        if (Number(cuPriceMicroLamports) > 0) {
          body.computeUnitPriceMicroLamports = Math.floor(Number(cuPriceMicroLamports));
        }
      } catch {}
      logObj("Swap body", { hasFee: !!feeAccount, feeBps: feeAccount ? feeBps : 0, useSharedAccounts: !!useSharedAccounts, asLegacy: !!asLegacy });
 
      const sRes = await jupFetch(`/swap/v1/swap`, {
        method: "POST",
        headers: { "Content-Type":"application/json", accept: "application/json" },
        body: JSON.stringify(body),
      });

      if (!sRes.ok) {
        let errTxt = "";
        try { errTxt = await sRes.clone().text(); } catch {}
        if (sRes.status === 400) {
          const c = noteSwap400(inputMint, outputMint);
          if (c >= MAX_CONSEC_SWAP_400) {
            try { setRouterHold(inputMint, ROUTER_COOLDOWN_MS); } catch {}
            log(`Swap 400 threshold reached (${c}) for ${inputMint.slice(0,4)}… -> cooldown applied.`);
            return { ok: false, code: "NO_ROUTE", msg: "400 abort" };
          }
          return { ok: false, code: "NO_ROUTE", msg: `swap 400 ${errTxt.slice(0,120)}` };
        }
        try {
          const j = JSON.parse(errTxt || "{}");
          return { ok: false, code: j?.errorCode || "", msg: j?.error || `swap ${sRes.status}` };
        } catch {
          return { ok: false, code: "", msg: `swap ${sRes.status}` };
        }
      }

      const { swapTransaction } = await sRes.json();
      if (!swapTransaction) return { ok: false, code: "NO_SWAP_TX", msg: "no swapTransaction" };

      const raw = atob(swapTransaction);
      const rawBytes = new Uint8Array(raw.length);
      for (let i=0; i<raw.length; i++) rawBytes[i] = raw.charCodeAt(i);
      const vtx = VersionedTransaction.deserialize(rawBytes);
      vtx.sign([signer]);
      try {
        const sig = await conn.sendRawTransaction(vtx.serialize(), { preflightCommitment: "processed", maxRetries: 3 });
        log(`Swap sent: ${sig}`);
        try { log(`Explorer: https://solscan.io/tx/${sig}`); } catch {}
        try { if (isSell) setTimeout(() => _reconcileSplitSellRemainder(sig), 0); } catch {}
        try {
          if (inputMint === SOL_MINT || outputMint === SOL_MINT) {
            setTimeout(() => { unwrapWsolIfAny(signer).catch(()=>{}); }, 1200);
            setTimeout(() => { unwrapWsolIfAny(signer).catch(()=>{}); }, 1500);
          }
        } catch {}
        return { ok: true, sig };
      } catch (e) {
        log(`Swap send failed. NO_ROUTES/ROUTER_DUST. export help/wallet.json to recover dust funds. Simulating…`);
        try {
          const sim = await conn.simulateTransaction(vtx, { sigVerify: false, replaceRecentBlockhash: true });
          const logs = sim?.value?.logs || e?.logs || [];
          const txt = (logs || []).join(" ");
          const hasDustErr = /0x1788|0x1789/i.test(txt);
          const hasSlipErr = /0x1771/i.test(txt);
          return { ok: false, code: hasDustErr ? "ROUTER_DUST" : (hasSlipErr ? "SLIPPAGE" : "SEND_FAIL"), msg: e.message || String(e) };
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
        // logObj("Swap-instructions body (manual send)", {
        //   hasFee: !!feeAccount,
        //   feeBps: feeAccount ? feeBps : 0,
        //   useSharedAccounts: !!useSharedAccounts
        // });
        try {
          const { cuPriceMicroLamports } = await getComputeBudgetConfig();
          if (Number(cuPriceMicroLamports) > 0) {
            body.computeUnitPriceMicroLamports = Math.floor(Number(cuPriceMicroLamports));
          }
        } catch {}
        log(`Swap-instructions request (manual send) … hasFee=${!!feeAccount}, useSharedAccounts=${!!useSharedAccounts}`);

        const iRes = await jupFetch(`/swap/v1/swap-instructions`, {
          method: "POST",
          headers: { "Content-Type":"application/json", accept: "application/json" },
          body: JSON.stringify(body),
        });
        if (!iRes.ok) {
          let errTxt = "";
            try { errTxt = await iRes.clone().text(); } catch {}
            if (iRes.status === 400) {
              const c = noteSwap400(inputMint, outputMint);
              if (c >= MAX_CONSEC_SWAP_400) {
                try { setRouterHold(inputMint, ROUTER_COOLDOWN_MS); } catch {}
                log(`Swap-instructions 400 threshold reached (${c}) for ${inputMint.slice(0,4)}… -> cooldown applied.`);
                return { ok: false, code: "NO_ROUTE", msg: "400 abort" };
              }
              return { ok: false, code: "NO_ROUTE", msg: `swap-instr 400 ${errTxt.slice(0,120)}` };
            }
          const isNoRoute = /NO_ROUTE|COULD_NOT_FIND_ANY_ROUTE/i.test(errTxt);
          log(`Swap-instructions error: ${errTxt || iRes.status}`, 'err');
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


        // dupe swap bug
        ixs = dedupeComputeBudgetIxs(ixs);


        try {
          if (!hasComputeBudgetIx(ixs)) {
            const cb = await buildComputeBudgetIxs();
            if (cb.length) ixs.unshift(...cb);
          }
        } catch {}

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
          log(`Swap (manual send v1) sent: ${sig}`);
          try { log(`Explorer: https://solscan.io/tx/${sig}`); } catch {}
          try { if (isSell) setTimeout(() => _reconcileSplitSellRemainder(sig), 0); } catch {}
          try {
            if (inputMint === SOL_MINT || outputMint === SOL_MINT) {
              setTimeout(() => { unwrapWsolIfAny(signer).catch(()=>{}); }, 1200);
              setTimeout(() => { unwrapWsolIfAny(signer).catch(()=>{}); }, 1500); 
            }
          } catch {}
          return { ok: true, sig };
        } catch (e) {
          log(`Manual send failed: ${e.message || e}. Simulating…`);
          try {
            const sim = await conn.simulateTransaction(vtx, { sigVerify: false, replaceRecentBlockhash: true });
            const logs = sim?.value?.logs || e?.logs || [];
            const txt = (logs || []).join(" ");
            const hasDustErr = /0x1788|0x1789/i.test(txt);
            const hasSlipErr = /0x1771/i.test(txt);
            if (hasDustErr) return { ok: false, code: "ROUTER_DUST", msg: e.message || String(e) };
            if (hasSlipErr) return { ok: false, code: "SLIPPAGE", msg: e.message || String(e) };
            return { ok: false, code: "SEND_FAIL", msg: e.message || String(e) };
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
        const q2 = buildQuoteUrl({
          outMint: outputMint,
          slipBps: slip2,
          restrict: rFlag,
          withFee: !!(feeAccount && feeBps > 0)
        });
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
        if (!state.USDCfallbackEnabled) {
          log("USDC fallback disabled; aborting expensive fallback attempt.");
          return null;
        }
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
            const qP = buildQuoteUrl({ outMint: outputMint, slipBps: slipSplit, restrict, amountOverrideRaw: partRaw, withFee: false });
            log(`Split-sell quote f=${f} restrict=${restrict} slip=${slipSplit}…`);
            const rP = await jupFetch(qP.pathname + qP.search);
            if (!rP.ok) continue;

            const quotePart = await rP.json();
            const outPartRaw = Number(quotePart?.outAmount || 0);
            const outPartSol = outPartRaw / 1e9;
            // Skip splits that fall below chunk floor
            if (!Number.isFinite(outPartSol) || outPartSol < MIN_SELL_CHUNK_SOL) {
              log(`Split f=${f} est out ${outPartSol.toFixed(6)} SOL < ${MIN_SELL_CHUNK_SOL}; skipping this chunk.`);
              continue;
            }

            // Profit-first fee for this chunk
            let chunkFeeAccount = null;
            if (feeBps > 0 && feeDestCandidate) {
              try {
                const decIn = Number.isFinite(inDecimals) ? inDecimals : _decHint ?? 6;
                const profitableChunkNoFee = shouldAttachFeeForSell({
                  mint: inputMint,
                  amountRaw: partRaw,
                  inDecimals: decIn,
                  quoteOutLamports: outPartRaw
                });
                if (profitableChunkNoFee) {
                  const qPFee = buildQuoteUrl({ outMint: outputMint, slipBps: slipSplit, restrict, amountOverrideRaw: partRaw, withFee: true });
                  const rPFee = await jupFetch(qPFee.pathname + qPFee.search);
                  if (rPFee.ok) {
                    const quotePartWithFee = await rPFee.json();
                    const outPartRawWithFee = Number(quotePartWithFee?.outAmount || 0);
                    const stillProfChunk = shouldAttachFeeForSell({
                      mint: inputMint,
                      amountRaw: partRaw,
                      inDecimals: decIn,
                      quoteOutLamports: outPartRawWithFee
                    });
                    if (stillProfChunk) {
                      quote = quotePartWithFee;
                      chunkFeeAccount = feeDestCandidate;
                      log(`Split-sell fee enabled @ ${feeBps} bps for f=${f}.`);
                    } else {
                      quote = quotePart;
                      chunkFeeAccount = null;
                      log(`Split-sell fee suppressed (removes profit) for f=${f}.`);
                    }
                  } else {
                    quote = quotePart;
                    chunkFeeAccount = null;
                    log("Split-sell fee quote failed; proceeding without fee.");
                  }
                } else {
                  quote = quotePart;
                  chunkFeeAccount = null;
                  log("Split-sell no estimated profit; fee disabled for this chunk.");
                }
              } catch {
                quote = quotePart;
                chunkFeeAccount = null;
                log("Split-sell profit check failed; fee disabled for this chunk.");
              }
            } else {
              quote = quotePart;
            }

            // Temporarily apply per-chunk fee decision
            const prevFeeAccount = feeAccount;
            feeAccount = chunkFeeAccount;

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
            feeAccount = prevFeeAccount;
          }
        }
      } catch (e) {
        log(`Split-sell fallback error: ${e.message || e}`, 'err');
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
      await _addRealizedPnl(estSol, costSold, "Unwind PnL");
      try { await closeEmptyTokenAtas(signer, mint); } catch {}
      if (state.positions[mint]) { delete state.positions[mint]; save(); }
      removeFromPosCache(owner, mint);
      if (item.from === "dust") removeFromDustCache(owner, mint);
    } catch (e) {
      log(`Sell fail ${mint.slice(0,4)}…: ${e.message||e}`);
    }
  }

  // Return SOL to recipient
  try { await unwrapWsolIfAny(signer); } catch {}
  try { await closeAllEmptyAtas(signer); } catch {}
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
  const kp = it?.kp || {};
  const chg5m = safeNum(it?.change5m ?? kp.change5m, 0);
  const chg1h = safeNum(it?.change1h ?? kp.change1h, 0);
  const liq   = safeNum(it?.liqUsd   ?? kp.liqUsd,   0);
  const v1h   = safeNum(it?.v1hTotal ?? kp.v1hTotal, 0);
  const pScore= safeNum(it?.pumpScore ?? kp.pumpScore, 0);

  const accel5to1 = safeNum(it?.meta?.accel5to1, 1);
  const risingNow = !!it?.meta?.risingNow;
  const trendUp   = !!it?.meta?.trendUp;

  const c5 = Math.max(0, chg5m);
  const c1 = Math.log1p(Math.max(0, chg1h)); 
  const exp5m = Math.max(0, chg1h) / 12;
  const accelRatio = exp5m > 0 ? (c5 / exp5m) : (c5 > 0 ? 1.2 : 0);
  const lLiq = Math.log1p(liq / 5000);
  const lVol = Math.log1p(v1h / 1000);

  // // Weighted score
  // const w = {
  //   c5: 0.32 * c5,
  //   c1: 0.16 * c1,
  //   lVol: 0.18 * lVol,
  //   lLiq: 0.10 * lLiq,
  //   accelRatio: 0.10 * Math.max(0, accelRatio - 0.8),
  //   accel5to1: 0.10 * Math.max(0, accel5to1 - 1),
  //   flags: (risingNow && trendUp ? 0.02 : 0),
  //   pScore: 0.02 * pScore,
  // };
  // const score =
  //   w.c5 + w.c1 + w.lVol + w.lLiq + w.accelRatio + w.accel5to1 + w.flags + w.pScore;

  const mintStr = String(it?.mint || it?.kp?.mint || "");
  const tag = mintStr ? `${mintStr.slice(0,4)}…` : "(unknown)";
  const series = getLeaderSeries(mintStr, 3) || [];
  const scSlopeMin = slope3pm(series, "pumpScore");
  const chgSlopeMin = slope3pm(series, "chg5m");
  const accSc = slopeAccel3pm(series, "pumpScore");
  const accChg = slopeAccel3pm(series, "chg5m");

  const w = {
    c5: 0.28 * Math.max(0, Math.max(0, safeNum(kp.change5m, 0))),
    c1: 0.14 * Math.log1p(Math.max(0, safeNum(kp.change1h, 0))),
    lVol: 0.16 * Math.log1p(safeNum(kp.v1hTotal, 0) / 1000),
    lLiq: 0.09 * Math.log1p(safeNum(kp.liqUsd, 0) / 5000),
    accelRatio: 0.08 * Math.max(0, safeNum(it?.meta?.accel5to1, 1) - 1),
    accel2: 0.15 * Math.min(1, Math.max(0, ((accSc / 6) + (accChg / 18)) / 2)), // scale to ~[0..1]
    slopeMix: 0.08 * Math.min(1, Math.max(0, ((scSlopeMin / 12) + (chgSlopeMin / 36)) / 2)),
    flags: (it?.meta?.risingNow && it?.meta?.trendUp ? 0.01 : 0),
    pScore: 0.01 * safeNum(it?.pumpScore, 0),
  };
  const score = w.c5 + w.c1 + w.lVol + w.lLiq + w.accelRatio + w.accel2 + w.slopeMix + w.flags + w.pScore;

  log(`Pump score ${tag}: accSc=${accSc.toFixed(3)} accChg=${accChg.toFixed(3)} scSlope=${scSlopeMin.toFixed(2)} chgSlope=${chgSlopeMin.toFixed(2)} -> ${score.toFixed(2)}`);
  return score;
}
  
function countConsecUp(series = [], key) {
  if (!Array.isArray(series) || series.length < 2) return 0;
  let cnt = 0;
  for (let i = series.length - 1; i >= 1; i--) {
    const prev = Number(series[i - 1]?.[key] ?? 0);
    const cur  = Number(series[i]?.[key] ?? 0);
    if (cur > prev) cnt++;
    else break;
  }
  return cnt;
}

function setMintBlacklist(mint, ms = MINT_RUG_BLACKLIST_MS) {
  if (!mint) return;
  if (!window._fdvMintBlacklist) window._fdvMintBlacklist = new Map();

  const nowTs = now();
  const prev = window._fdvMintBlacklist.get(mint);
  const prevCount = typeof prev === "object" && prev ? Number(prev.count || 0) : 0;
  const lastAt = typeof prev === "object" && prev ? Number(prev.lastAt || 0) : 0;

  // Increase coalescing window to reduce rapid stage bumps from noisy/duplicate signals
  const COALESCE_WINDOW_MS = 60_000; // was 10_000
  const canBump = !lastAt || (nowTs - lastAt) > COALESCE_WINDOW_MS;

  const nextCount = Math.min(3, canBump ? (prevCount + 1) : prevCount || 1);

  const stageMs = MINT_BLACKLIST_STAGES_MS[nextCount - 1] || MINT_RUG_BLACKLIST_MS;
  const capMs = Number.isFinite(ms) ? Math.max(60_000, ms | 0) : Infinity;
  const dur = Math.min(stageMs, capMs);

  // If already blacklisted and we're within the window without a bump, quietly extend once
  if (prev && !canBump) {
    const newUntil = Math.max(Number(prev.until || 0), nowTs + dur);
    // Only mutate if the extension actually increases remaining time by a meaningful margin
    const meaningfullyExtended = (newUntil - Number(prev.until || 0)) > 15_000;
    window._fdvMintBlacklist.set(mint, { ...prev, until: newUntil, lastAt: nowTs });
    if (!meaningfullyExtended) return; // suppress duplicate logs
  } else {
    const until = Math.max(Number(prev?.until || 0), nowTs + dur);
    window._fdvMintBlacklist.set(mint, { until, count: nextCount, lastAt: nowTs });
  }

  try {
    const rec = window._fdvMintBlacklist.get(mint);
    const mins = Math.round((Number(rec.until) - nowTs) / 60000);
    log(`Blacklist set (stage ${nextCount}/3, ${mins}m) for ${mint.slice(0,4)}… until ${new Date(rec.until).toLocaleTimeString()}`);
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
  if (s.includes("warming")) {
    return "warming";
  }
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
  if (prevNorm !== curNorm) {            
    try { log(`Badge for ${mint.slice(0,4)}…: ${prevNorm} -> ${curNorm}`); } catch {}
  }
  if (prevNorm === "pumping" && curNorm === "calm") {
    markPumpDropBan(mint, PUMP_TO_CALM_BAN_MS);
  }
} 
  
function _getSeriesStore() {
   if (!window._fdvLeaderSeries) window._fdvLeaderSeries = new Map(); // mint -> [{ts, pumpScore, liqUsd, v1h, chg5m, chg1h}]
   return window._fdvLeaderSeries;
}

// function slope3(series, key) {  // Legacy
//   if (!Array.isArray(series) || series.length < 3) return 0;
//   const a = Number(series[0]?.[key] ?? 0);
//   const b = Number(series[1]?.[key] ?? a);
//   const c = Number(series[2]?.[key] ?? b);
//   return (c - a) / 2;
// }

function slopeAccel3pm(series, key) {
  if (!Array.isArray(series) || series.length < 3) return 0;
  const a = series[0], b = series[1], c = series[2];
  const tAB = Math.max(0.06, (Number(b?.ts || 0) - Number(a?.ts || 0)) / 60000);
  const tBC = Math.max(0.06, (Number(c?.ts || 0) - Number(b?.ts || 0)) / 60000);
  const sAB = (Number(b?.[key] ?? 0) - Number(a?.[key] ?? 0)) / tAB;
  const sBC = (Number(c?.[key] ?? 0) - Number(b?.[key] ?? 0)) / tBC;
  return sBC - sAB; 
}

function delta3(series, key) {
  if (!Array.isArray(series) || series.length < 3) return 0;
  const a = Number(series[0]?.[key] ?? 0);
  const c = Number(series[2]?.[key] ?? a);
  return c - a;
}

function slope3pm(series, key) {
  if (!Array.isArray(series) || series.length < 3) return 0;
  const a = series[0]; const c = series[2];
  const dv = Number(c?.[key] ?? 0) - Number(a?.[key] ?? 0);
  const dtm = Math.max(
    0.06, // floor to ~3.6s to damp per-minute slope explosions on short windows
    (Number(c?.ts || 0) - Number(a?.ts || 0)) / 60000
  );
  return dv / dtm;
}

function recordLeaderSample(mint, sample) {
  if (!mint) return;
  const s = _getSeriesStore();
  const list = s.get(mint) || [];
  const nowTs = now();

  const row = {
    ts: nowTs,
    pumpScore: safeNum(sample.pumpScore, 0),
    liqUsd:    safeNum(sample.liqUsd, 0),
    v1h:       safeNum(sample.v1h, 0),
    chg5m:     safeNum(sample.chg5m, 0),
    chg1h:     safeNum(sample.chg1h, 0),
  };

  // Coalesce samples that are too close in time (e.g., tick() + pickPumpCandidates() back-to-back)
  const last = list[list.length - 1];
  if (last && (nowTs - Number(last.ts || 0)) < LEADER_SAMPLE_MIN_MS) {
    // Replace the last sample with the latest values instead of pushing a new entry
    list[list.length - 1] = row;
  } else {
    list.push(row);
    while (list.length > 5) list.shift();
  }

  s.set(mint, list);
}

function getLeaderSeries(mint, n = 3) {
  const s = _getSeriesStore();
  const list = s.get(mint) || [];
  if (!n || n >= list.length) return list.slice();
  return list.slice(list.length - n);
}

function computeWarmingRequirement(pos, nowTs = now()) {
  const base = Number.isFinite(pos?.warmingMinProfitPct)
    ? Number(pos.warmingMinProfitPct)
    : Number.isFinite(state.warmingMinProfitPct) ? Number(state.warmingMinProfitPct) : 100;

  const delayMs = Math.max(0, Number(state.warmingDecayDelaySecs || 0) * 1000);
  const perMin = Math.max(0, Number(state.warmingDecayPctPerMin || 0));
  const floor  = Number(state.warmingMinProfitFloorPct);
  const holdAt = Number(pos?.warmingHoldAt || pos?.lastBuyAt || pos?.acquiredAt || nowTs);

  const elapsedTotalMs = Math.max(0, nowTs - holdAt);
  const elapsedMs = Math.max(0, elapsedTotalMs - delayMs);
  const elapsedMin = elapsedMs > 0 ? (elapsedMs / 60000) : 0;

  const decayed = base - (perMin * elapsedMin);
  const req = Number.isFinite(floor) ? Math.max(floor, decayed) : decayed;

  const autoSecs = Math.max(0, Number(state.warmingAutoReleaseSecs || 0));
  const shouldAutoRelease = autoSecs > 0 && (elapsedTotalMs >= autoSecs * 1000);

  return { req, base, elapsedMin, perMin, floor, shouldAutoRelease, elapsedTotalSec: Math.floor(elapsedTotalMs/1000) };
}

function computePrePumpScore({ kp = {}, meta = {} }) {
  const chg5m = safeNum(kp.change5m, 0);
  const chg1h = safeNum(kp.change1h, 0);
  const buy   = safeNum(meta.buy, 0);

  const a51raw = safeNum(meta.accel5to1, 1);
  let a51   = a51raw > 0 ? a51raw : 1;
  const zv1   = Math.max(0, safeNum(meta.zV1, 0));
  const risingNow = !!meta.risingNow;
  const trendUp   = !!meta.trendUp;

  // Treat missing accel as slight accel when flow is strong
  const hasFlow = (zv1 >= 0.8 || buy >= 0.60);
  if (a51 <= 1 && hasFlow) a51 = 1.01;

  const f5m = (chg5m > 0 && chg5m < 0.9) ? Math.min(1, chg5m / 0.9) : (chg5m >= 0.9 ? 0.4 : 0);

  // Volume acceleration (5m vs 1h) and decayed zV1
  const fA  = Math.max(0, Math.min(1, (a51 - 1) / 0.05)); // was 0.08 -> more sensitive
  const fZ  = Math.max(0, Math.min(1, zv1 / 1.5));

  // Buy skew helps (slightly wider band)
  const fB  = Math.max(0, Math.min(1, (buy - 0.58) / 0.10));

  log(`Pre-pump factors: f5m=${f5m.toFixed(3)} fA=${fA.toFixed(3)} fZ=${fZ.toFixed(3)} fB=${fB.toFixed(3)}`);

  const series = getLeaderSeries(kp.mint || "", 3);
  let fT = 0;
  if (series && series.length >= 3) {
    const a = series[0], c = series[series.length - 1];
    const upChg  = Number(c.chg5m || 0) >= Number(a.chg5m || 0);
    const upSc   = Number(c.pumpScore || 0) >= Number(a.pumpScore || 0);
    fT = (upChg ? 0.5 : 0) + (upSc ? 0.5 : 0);
  } else if (risingNow && trendUp) {
    fT = 0.6;
  }

  const exp5m = Math.max(0, chg1h) / 12;
  const accelRatio = exp5m > 0 ? (Math.max(0, chg5m) / exp5m) : 0;
  const notBackside = accelRatio >= 0.4;

  const score = (
    0.30 * fA +
    0.25 * fZ +
    0.18 * fT +
    0.17 * f5m +
    0.10 * fB
  ) * notBackside;

  return score; // 0..1
}

function shouldAttachFeeForSell({ mint, amountRaw, inDecimals, quoteOutLamports }) {
  try {
    const dec = Number.isFinite(inDecimals) ? inDecimals : 6;
    const amountUi = Number(amountRaw || 0) / Math.pow(10, dec);
    if (!(amountUi > 0)) return false;

    const estOutSol = Number(quoteOutLamports || 0) / 1e9;
    if (!(estOutSol > 0)) return false;

    const estCostSold = estimateProportionalCostSolForSell(mint, amountUi);
    if (estCostSold === null) {
      return false;
    }

    const estPnl = estOutSol - estCostSold;
    return estPnl > 0; // attach fee only when profitable
  } catch {
    return false;
  }
}

function estimateNetExitSolFromQuote({ mint, amountUi, inDecimals, quoteOutLamports }) {
  try {
    const amountRaw = Math.max(1, Math.floor(Number(amountUi || 0) * Math.pow(10, Number(inDecimals || 6))));
    const attachFee = shouldAttachFeeForSell({
      mint,
      amountRaw,
      inDecimals: Number(inDecimals || 6),
      quoteOutLamports: Number(quoteOutLamports || 0),
    });

    const feeBps = Number(getPlatformFeeBps() || 0);
    const platformL = attachFee ? Math.floor(Number(quoteOutLamports || 0) * (feeBps / 10_000)) : 0;
    const txL = EDGE_TX_FEE_ESTIMATE_LAMPORTS; // conservative recurring estimate
    const netL = Math.max(0, Number(quoteOutLamports || 0) - platformL - txL);
    return {
      netSol: netL / 1e9,
      feeApplied: attachFee,
      platformLamports: platformL,
      txLamports: txL,
    };
  } catch {
    return { netSol: Math.max(0, Number(quoteOutLamports || 0) - EDGE_TX_FEE_ESTIMATE_LAMPORTS) / 1e9, feeApplied: false, platformLamports: 0, txLamports: EDGE_TX_FEE_ESTIMATE_LAMPORTS };
  }
}
  

function computeReboundSignal(mint) {
  try {
    const series = getLeaderSeries(mint, 3);
    if (!Array.isArray(series) || series.length < 3) return { ok: false, why: "no-series" };

    const last = series[series.length - 1] || {};
    const kp = {
      mint,
      change5m: safeNum(last.chg5m, 0),
      change1h: safeNum(last.chg1h, 0),
      liqUsd:   safeNum(last.liqUsd, 0),
      v1h:      safeNum(last.v1h, 0),
    };

    // Build a minimal meta based on slopes to keep detector meaningful
    const c5 = Math.max(0, kp.change5m);
    const c1 = Math.max(0, kp.change1h);
    const exp5m = c1 / 12;
    const accel5to1 = exp5m > 1e-9 ? Math.max(1, c5 / exp5m) : (c5 > 0 ? 1.02 : 1);
    const zV1 = Math.max(0, kp.v1h) / 1000; // rough z-score proxy (scaled)
    // Clamp slopes to sensible bands to avoid near-zero-dt spikes
    const chgSlopeMin = _clamp(slope3pm(series, "chg5m"),   -60, 60);
    const scSlopeMin  = _clamp(slope3pm(series, "pumpScore"), -20, 20);
    const risingNow   = chgSlopeMin > 0 || (delta3(series, "chg5m") > 0);
    const trendUp     = scSlopeMin > 0 && (delta3(series, "pumpScore") > 0);

    const meta = { accel5to1, zV1, buy: 0.58, risingNow, trendUp };

    const res = detectWarmingUptick({ kp, meta }, state);
    const score = Number(res?.score || 0);
    const chgS  = Number(res?.chgSlope || chgSlopeMin || 0);
    const scS   = Number(res?.scSlope || scSlopeMin || 0);

    const okSlope = (chgS >= Math.max(6, Number(state.reboundMinChgSlope || 12))) &&
                    (scS  >= Math.max(4, Number(state.reboundMinScSlope  || 8)));

    const ok = !!res?.ok || okSlope || score >= Math.max(0.25, Number(state.reboundMinScore || 0.34));
    const why = res?.ok ? "warming-ok" : (okSlope ? "slope-ok" : (score >= (state.reboundMinScore||0.34) ? "score-ok" : "weak"));
    return { ok, why, score, chgSlope: chgS, scSlope: scS };
  } catch {
    return { ok: false, why: "error" };
  }
}

function shouldDeferSellForRebound(mint, pos, pnlPct, nowTs, reason = "") {
  try {
    if (!state.reboundGateEnabled) return false;
    if (!mint || !pos) return false;




    if (/max[-\s]*loss|warming[-\s]*max[-\s]*loss/i.test(String(reason || ""))) return false;
    if (/rug/i.test(reason || "")) return false;
    if (/TP|take\s*profit/i.test(reason || "")) return false;

    const minPnl = Number(state.reboundMinPnLPct || -15);

    if (Number.isFinite(pnlPct) && pnlPct <= minPnl) return false;

    const anchorTs = Number(pos.fastPeakAt || pos.lastBuyAt || pos.acquiredAt || 0);
    const ageMs = nowTs - anchorTs;
    const lookbackMs = Math.max(5_000, Number(state.reboundLookbackSecs || 45) * 1000);
    const allowObserverRelax = /observer/i.test(reason || "");
    const withinWindow = ageMs <= lookbackMs || (allowObserverRelax && ageMs <= lookbackMs * 2);
    if (!withinWindow) return false;

    const startedAt = Number(pos.reboundDeferStartedAt || 0);
    const maxDefMs = Math.max(4_000, Number(state.reboundMaxDeferSecs || 20) * 1000);
    if (startedAt && (nowTs - startedAt) > maxDefMs) return false;

    const sig = computeReboundSignal(mint);
    if (!sig.ok) return false;
    if (!pos.reboundDeferStartedAt) pos.reboundDeferStartedAt = nowTs;
    pos.reboundDeferUntil = nowTs + Math.max(1000, Number(state.reboundHoldMs || 4000));
    pos.reboundDeferCount = Number(pos.reboundDeferCount || 0) + 1;
    save();

    log(`Rebound gate: holding ${mint.slice(0,4)}… (${sig.why}; score=${sig.score.toFixed(3)} chgSlope=${sig.chgSlope.toFixed(2)}/m scSlope=${sig.scSlope.toFixed(2)}/m)`);
    return true;
  } catch {
    return false;
  }
}

function detectWarmingUptick({ kp = {}, meta = {} }, cfg = state) {
  const relax = cfg.warmingRelaxEnabled !== false;

  const series = getLeaderSeries(kp.mint || "", 3) || [];
  const chgDelta    = delta3(series, "chg5m");
  const chgSlopeMin = _clamp(slope3pm(series, "chg5m"),   -60, 60);
  const scSlopeMin  = _clamp(slope3pm(series, "pumpScore"), -20, 20);
  const scDelta     = delta3(series, "pumpScore");
  const accChgMin   = slopeAccel3pm(series, "chg5m");
  const accScMin    = slopeAccel3pm(series, "pumpScore");

  const chg5m = safeNum(kp.change5m, 0);
  const chg1h = safeNum(kp.change1h, 0);
  const liq   = safeNum(kp.liqUsd, 0);
  const v1h   = safeNum(kp.v1hTotal, 0);

  let a51   = Math.max(1, safeNum(meta.accel5to1, 1));
  let zV1   = Math.max(0, safeNum(meta.zV1, 0));
  const buy = Math.max(0, safeNum(meta.buy, 0));
  let rising= !!meta.risingNow;
  let trendUp = !!meta.trendUp;

  // infer rising when score slope positive & chg slope non-negative.
  if (relax && !rising && scSlopeMin > 0 && chgSlopeMin >= 0) rising = true;
  if (relax && !trendUp && scDelta > 0) trendUp = true;

  const exp5m = Math.max(0, chg1h) / 12;
  const accelRatio = exp5m > 0 ? (Math.max(0, chg5m) / exp5m) : 0;
  let notBackside = accelRatio >= (chg1h > 0.6 ? 0.30 : 0.25);
  if (!notBackside && relax && scSlopeMin > 4) notBackside = true;

  const liqOk = liq >= Math.max(2500, Number(cfg.warmingMinLiqUsd || 4000));
  const volOk = v1h >= Math.max(500,  Number(cfg.warmingMinV1h || 800));
  const hasFlow = (zV1 >= (cfg.warmingFlowMin ?? 0.35)) || (buy >= (cfg.warmingBuyMin ?? 0.55));
  if (a51 <= 1.0 && (hasFlow || (relax && chg5m > 2))) a51 = 1.01;

  // bootstrap zV1 if zero but strong price impulse.
  if (relax && zV1 === 0 && chg5m > 2.0) zV1 = 0.40;

  const warmPreRaw = computePrePumpScore({ kp, meta: { accel5to1: a51, zV1, buy, risingNow: rising, trendUp } });
  let pre = warmPreRaw;

  let preMin = Number(cfg.warmingUptickMinPre ?? 0.35);
  preMin = Math.max(0.30, preMin);
  if (!liqOk || !volOk) preMin += 0.03;
  if (a51 >= 1.02) preMin -= 0.05;
  if (zV1 >= 1.0)  preMin -= 0.03;
  if (chgSlopeMin >= 25) preMin -= 0.06;
  if (scSlopeMin  >= 10) preMin -= 0.04;

  // : allow lower preMin when strong slopes but low base
  if (relax && pre < preMin && (scSlopeMin > 6 || chgSlopeMin > 20)) {
    preMin = Math.max(0.22, preMin * 0.70);
  }
  if (relax && pre < preMin && chg5m > 2.2) {
    preMin = Math.max(0.20, preMin * 0.75);
  }

  try {
    const mintId = String(kp.mint || "");
    if (mintId) {
      if (!window._fdvPrevPre) window._fdvPrevPre = new Map();
      const lastPre = Number(window._fdvPrevPre.get(mintId) || NaN);
      if (Number.isFinite(lastPre)) {
        preMin = Math.max(preMin, lastPre * 0.80);
      }
      window._fdvPrevPre.set(mintId, pre);
    }
  } catch {}
  preMin = Math.max(0.28, preMin);

  const needDeltaChg = Number(cfg.warmingUptickMinDeltaChg5m ?? 0.012);
  const needDeltaSc  = Number(cfg.warmingUptickMinDeltaScore ?? 0.006);

  const accel2Ok =
    (accChgMin > 0 && accScMin > 0) ||
    (accChgMin >= needDeltaChg * 1.2) ||
    (accScMin  >= needDeltaSc  * 1.8);

  const slopeOk = (chgDelta >= needDeltaChg) || (chgSlopeMin >= needDeltaChg * 3.0);
  let accelOk   = a51 >= (hasFlow ? (Number(cfg.warmingUptickMinAccel ?? 1.001) - 0.005) : Number(cfg.warmingUptickMinAccel ?? 1.001));
  if (scSlopeMin >= needDeltaSc * 2.5 || chgSlopeMin >= needDeltaChg * 2.0) accelOk = true;
  const strongFlow = (zV1 >= Math.max(0.7, (cfg.warmingFlowStrong ?? 0.7))) || (buy >= Math.max(0.58, (cfg.warmingBuyStrong ?? 0.58)));
  const scoreSlopeOk =
    (scDelta >= needDeltaSc) ||
    (scSlopeMin >= needDeltaSc * 2.0) ||
    (strongFlow && (chgSlopeMin >= needDeltaChg * 2.0 || a51 >= ((cfg.warmingUptickMinAccel ?? 1.001) + 0.004)));

  const trendGate =
    (rising && trendUp) ||
    slopeOk ||
    (scDelta >= needDeltaSc) ||
    (scSlopeMin >= needDeltaSc * 2.0);

  const flowGate = hasFlow || (scSlopeMin >= needDeltaSc * 2.5);

  // Relax final acceptance: permit strong slopes with lower pre
  const prePass = pre >= preMin || (relax && pre >= preMin * 0.6 && (scSlopeMin > 6 || chgSlopeMin > 18));

  const ok =
    trendGate &&
    notBackside &&
    accelOk &&
    accel2Ok &&
    scoreSlopeOk &&
    prePass &&
    flowGate;

  if (relax && !ok) {
    // Secondary fallback: strong immediate impulse
    if (chg5m > 2.2 && scSlopeMin > 5 && a51 >= 1.005) {
      preMin = Math.min(preMin, 0.40);
      if (pre >= preMin * 0.55) {
        // mark as tentative ok
        prePass && flowGate && (meta._tentativeWarm = true);
      }
    }
  }

  const score = Math.max(0, Math.min(1,
    0.35 * Math.min(1, (a51 - 1) / 0.06) +
    0.25 * Math.min(1, (chgDelta) / (needDeltaChg * 2.5)) +
    0.20 * Math.min(1, (scDelta)  / (needDeltaSc  * 3.0)) +
    0.20 * Math.min(1, Math.max(0, pre - preMin + 0.05) / 0.30) +
    0.15 * Math.min(1, Math.max(0, ((accChgMin / (needDeltaChg * 2)) + (accScMin / (needDeltaSc * 2))) / 2))
  ));

  if (!window._fdvWarmDbgLite || now() - window._fdvWarmDbgLite > 900) {
    window._fdvWarmDbgLite = now();
    log(`WarmDet ${String((kp.mint||"").slice(0,4))}… ok=${ok} pre=${pre.toFixed(3)}>=${preMin.toFixed(3)} scSlope=${scSlopeMin.toFixed(2)} chgSlope=${chgSlopeMin.toFixed(2)} a51=${a51.toFixed(3)} zV1=${zV1.toFixed(2)} relax=${relax}`);
  }

  return { ok, score, chgSlope: chgSlopeMin, scSlope: scSlopeMin, pre, preMin, a51, liq, v1h, notBackside };
}

function isWarmingHoldActive(mint, pos, warmReq, nowTs) {
  try {
    const warmingHold = !!(state.rideWarming && pos?.warmingHold === true);
    if (!warmingHold) return { active: false };
    // If base window not elapsed, hold is active
    if (!warmReq?.shouldAutoRelease) return { active: true, reason: "timer" };

    // After base window: optionally extend hold while rising
    if (state.warmingExtendOnRise !== false) {
      const until = Number(pos.warmingExtendUntil || 0);
      if (until && nowTs < until) return { active: true, reason: "extend-window" };

      const sig = computeReboundSignal(mint);
      if (sig.ok) {
        const step = Math.max(1000, Number(state.warmingExtendStepMs || state.reboundHoldMs || 4000));
        pos.warmingExtendUntil = nowTs + step;
        save();
        log(`Warming extend: ${mint.slice(0,4)}… (${sig.why}; score=${sig.score.toFixed(3)} chgSlope=${sig.chgSlope.toFixed(2)}/m scSlope=${sig.scSlope.toFixed(2)}/m)`);
        return { active: true, reason: "extend-signal" };
      }
    }
  } catch {}
  return { active: false };
}

function _getWarmPrimeStore() {
  if (!window._fdvWarmPrime) window._fdvWarmPrime = new Map(); // mint -> { count, lastAt }
  return window._fdvWarmPrime;
}

function pickPumpCandidates(take = 1, poolN = 3) {
  try {
    const wantN = state.rideWarming ? Math.max(poolN, 6) : poolN; // widen pool for warming
    const leaders = computePumpingLeaders(wantN) || [];
    log(`Picking pump candidates from ${leaders.length} leaders…`);
    const pool = [];
    for (const it of leaders) {
      const mint = it?.mint;
      if (!mint) continue;

      const meta = it?.meta || {};
      const kp = { ...(it?.kp||{}), mint };
      const badge = String(getRugSignalForMint(mint)?.badge || it?.badge || "");
      log(`Evaluating leader ${mint.slice(0,4)}… badge="${badge}"`);

      const chg5m = safeNum(kp.change5m, 0);
      const chg1h = safeNum(kp.change1h, 0);
      // Record series EARLY so detector sees 3-tick trend
      recordLeaderSample(mint, {
        pumpScore: Number(it?.pumpScore || 0),
        liqUsd:    safeNum(kp.liqUsd, 0),
        v1h:       safeNum(kp.v1hTotal, 0),
        chg5m,
        chg1h,
      });

      const allowWarming = state.rideWarming;
      const badgeNorm = normBadge(badge);
      const isPumping = badgeNorm === "pumping";
      const isWarming = badgeNorm === "warming";
      if (!(isPumping || (allowWarming && isWarming))) continue;

      // Strict pump gate
      const minChg5  = isPumping ? 0.8 : 0.4;
      const minAccel = isPumping ? 1.00 : 0.98;

      // Backside guard
      const exp5m = Math.max(0, chg1h) / 12;
      const accelRatio = exp5m > 0 ? (Math.max(0, chg5m) / exp5m) : 0;
      const notBackside = accelRatio >= 0.4;

      // Primary microUp gate for pumping
      const microUp =
        isPumping &&
        chg5m >= minChg5 &&
        meta.risingNow === true &&
        meta.trendUp === true &&
        Math.max(1, safeNum(meta.accel5to1, 1)) >= minAccel;

      let primed = false;
      let pre = 0;
      let chgSlope = 0;
      let scSlope  = 0;

      if (!microUp && isWarming && allowWarming && notBackside) {
        const res = detectWarmingUptick({ kp, meta });
        pre = res.pre;
        chgSlope = Number(res.chgSlope || 0);
        scSlope  = Number(res.scSlope  || 0);
        if (res.ok) {
          const store = _getWarmPrimeStore();
          const prev = store.get(mint) || { count: 0, lastAt: 0 };
          const ttlMs = 15_000;
          const within = now() - prev.lastAt < ttlMs;
          const nextCount = within ? (prev.count + 1) : 1;
          store.set(mint, { count: nextCount, lastAt: now() });
          const need = Math.max(1, Number(state.warmingPrimedConsec || 2));
          primed = (nextCount >= need);
        } else {
          try { _getWarmPrimeStore().delete(mint); } catch {}
        }
      } else {
        try { _getWarmPrimeStore().delete(mint); } catch {}
      }

      if (!(microUp && notBackside) && !primed) {
        const series = getLeaderSeries(mint, 5);
        const scSlopeMin = slope3pm(series || [], "pumpScore");
        const chgSlopeMin = slope3pm(series || [], "chg5m");
        const needTicks = Math.max(1, Number(state.sustainTicksMin || 2));
        const needChg = Math.max(0, Number(state.sustainChgSlopeMin || 6));
        const needSc  = Math.max(0, Number(state.sustainScSlopeMin  || 3));
        const okTicks = countConsecUp(series, "pumpScore") >= needTicks && countConsecUp(series, "chg5m") >= needTicks;
        const okSlopes = (scSlopeMin >= needSc) && (chgSlopeMin >= needChg);
        if (!(okTicks && okSlopes)) continue;
      }

      const series3 = getLeaderSeries(mint, 3) || [];
      const accChg = slopeAccel3pm(series3, "chg5m");
      const accSc  = slopeAccel3pm(series3, "pumpScore");

      const baseScore = scorePumpCandidate({ mint, kp, pumpScore: it?.pumpScore, meta });
      const finalScore = primed ? baseScore * 0.92 : baseScore;

      pool.push({
        mint,
        badge: it.badge,
        pumpScore: Number(it?.pumpScore || 0),
        liqUsd: safeNum(kp.liqUsd, 0),
        v1h:    safeNum(kp.v1hTotal, 0),
        chg5m,
        chg1h,
        meta,
        primed,
        nb: notBackside,
        pre,
        chgSlope,
        scSlope,
        accChg,
        accSc,
        score: finalScore,
      });
    }
    if (!pool.length) {
      try {
        const leadersRaw = computePumpingLeaders(Math.max(poolN, 6)) || [];
        const firstPump = leadersRaw.find(x => normBadge(x.badge) === "pumping");
        if (firstPump?.mint) {
          const mint = firstPump.mint;
          const kp = { ...(firstPump.kp || {}), mint };
          const meta = firstPump.meta || {};
          const det = detectWarmingUptick({ kp, meta }, state);
          const s = getLeaderSeries(mint, 3);
          const scSlopeMin = slope3pm(s || [], "pumpScore");
          const chgSlopeMin = slope3pm(s || [], "chg5m");
          const risingNow = !!meta.risingNow;
          if (det?.ok && ((scSlopeMin > 0 && chgSlopeMin > 0) || risingNow)) {
            log(`Fallback pick (WarmDet ok, slopes healthy): ${mint.slice(0,4)}…`);
            return [mint];
          }
          log(`Fallback pick rejected by WarmDet/slopes: ${mint.slice(0,4)}…`);
        }
      } catch {}
      return [];
    }

    pool.sort((a,b) => b.score - a.score);
    const top = pool[0]?.score ?? -Infinity;

    const strong = pool.filter(x => {
      const b = normBadge(x.badge);
      const isPump = (b === "pumping");
      const minC5  = isPump ? 0.8 : 0.4;
      const minA   = isPump ? 1.00 : 0.98;
      const aEff   = Math.max(1, safeNum(x.meta?.accel5to1, 1));
      const accel2Ok = (Number(x.accChg || 0) > 0) || (Number(x.accSc || 0) > 0);

      if (x.primed) {
        const flowOk = safeNum(x.meta?.zV1, 0) >= 0.50 || safeNum(x.meta?.buy, 0) >= 0.60;
        const slopeGate = (Number(x.chgSlope || 0) >= 15) || (Number(x.scSlope || 0) >= 8);
        return (
          x.score >= top * 0.80 &&
          x.nb === true &&
          ((x.meta?.risingNow === true && x.meta?.trendUp === true) || slopeGate) &&
          (x.chg5m > 0 || aEff >= 0.98) &&
          flowOk &&
          accel2Ok
        );
      }
      return (
        x.score >= top * 0.85 &&
        x.chg5m >= minC5 &&
        aEff >= minA &&
        x.meta?.risingNow === true &&
        x.meta?.trendUp === true &&
        x.nb === true &&
        accel2Ok
      );
    });

    const base = strong.length ? strong : pool;
    const chosen = base.slice(0, Math.max(1, take)).map(x => x.mint);
    logObj("Pump picks", base.slice(0, poolN));
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
  const r = m.get(mint) || { consec3: 0, lastPasses: 0, lastAt: 0, consecLow: 0 };
  if (passes === 3) {
    r.consec3 = (r.lastPasses === 3) ? (r.consec3 + 1) : 1;
  } else {
    r.consec3 = 0;
  }
    
  if (passes <= 2) {
    r.consecLow = (r.lastPasses <= 2) ? (Number(r.consecLow || 0) + 1) : 1;
  } else {
    r.consecLow = 0;
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

    // Require negative slope confirmation too
    const series = getLeaderSeries(mint, 3);
    const scSlopeMin = _clamp(slope3pm(series || [], "pumpScore"), -20, 20);
    const chgSlopeMin= _clamp(slope3pm(series || [], "chg5m"), -60, 60);

    const consecOk    = (rec.consec3 + 1) >= needConsec;
    const drawdownOk  = ddPct >= (trailThr + 1.0); // need a bit more than trail
    const slopeBad    = (scSlopeMin < 0 || chgSlopeMin < 0);

    return consecOk && drawdownOk && slopeBad;
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

  // Current badge for extra context
  const sig = getRugSignalForMint(mint) || {};
  const badgeNorm = normBadge(sig.badge);

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
    log(`Observer: ${mint.slice(0,4)}… vanished from leaders;.`);
    return "";
  }

  // Shorter pre-buy watch to reduce missed rotations. 
  const start = now();
  let sN = s0;
  const watchMs = Math.max(1200, Math.floor((state.tickMs || 2000) * 0.9));
  const stepMs  = Math.max(400, Math.floor(watchMs / 3));
  while (now() - start < watchMs) {
    await new Promise(r => setTimeout(r, stepMs));
    const s1 = await snapshot(mint);
    if (!s1) { sN = null; break; }
    sN = s1;
  }

  if (!sN) {
    setMintBlacklist(mint, MINT_RUG_BLACKLIST_MS);
    log(`Observer: ${mint.slice(0,4)}… dropped during pre-buy watch; skipping (no blacklist).`); 
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

  if (state.strictBuyFilter && !state.rideWarming) {
    if (badgeNorm !== "pumping") {
      noteObserverConsider(mint, 30_000);
      return "";
    }
    if (passes < 4) {
      noteObserverConsider(mint, 30_000);
      return "";
    }
  }

  if (passes === 3 && badgeNorm === "pumping") {
    log(`Observer: approve ${mint.slice(0,4)}… (score 3/5) [badge=pumping]`);
    clearObserverConsider(mint);
    return mint;
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

function _getFinalPumpGateStore() {
  if (!window._fdvFinalPumpGate)
    window._fdvFinalPumpGate = new Map(); // mint -> { startScore, at, ready }
  return window._fdvFinalPumpGate;
}

function isFinalPumpGateReady(mint) {
  const cfg = state;
  if (!cfg.finalPumpGateEnabled) return true;
  if (!mint) return true;
  const store = _getFinalPumpGateStore();
  const rec = store.get(mint);
  return !!(rec && rec.ready === true);
}

function computeFinalGateIntensity(mint) {
  try {
    const cfg = state;
    const store = _getFinalPumpGateStore();
    const rec = store.get(mint);
    const series = getLeaderSeries(mint, 3) || [];
    const chgSlope = _clamp(slope3pm(series, "chg5m"), -60, 60);
    const scSlope  = _clamp(slope3pm(series, "pumpScore"), -20, 20);

    let base = 1.0;
    if (rec && rec.ready) {
      const delta   = Math.max(0, Number(rec.passDelta || 0));
      const need    = Math.max(0.001, Number(cfg.finalPumpGateDelta || 3));
      const elapsed = Math.max(500, Number(rec.elapsedMs || (now() - Number(rec.at || 0)) || 1000));
      const win     = Math.max(500, Number(cfg.finalPumpGateWindowMs || 10000));
      const start   = Math.max(0, Number(rec.startScore || 0));
      // Δscore speed and start strength
      base = (delta / need) * (win / elapsed) * (1 + Math.min(0.5, start / 8));
    } else {
      // fallback to momentum if no pass record
      base = 0.9 + Math.max(0, chgSlope / 30) + Math.max(0, scSlope / 12);
    }
    const intensity = Math.max(0.4, Math.min(2.5, base));
    let tier = "moderate";
    if (intensity >= 1.6) tier = "explosive";
    else if (intensity < 0.9) tier = "weak";
    return { intensity, tier, chgSlope, scSlope };
  } catch {
    return { intensity: 1.0, tier: "moderate", chgSlope: 0, scSlope: 0 };
  }
}

function computeDynamicTpSlForMint(mint) {
  const { intensity, tier, chgSlope, scSlope } = computeFinalGateIntensity(mint);
  let tp = Math.max(5, Number(state.takeProfitPct || 12));
  let sl = Math.max(5, Number(state.stopLossPct || 5.5));
  let trailPct = Math.max(0, Number(state.trailPct || 6));
  let arm = Math.max(0, Number(state.minProfitToTrailPct || 3));

  if (tier === "explosive") {
    tp = Math.min(25, Math.max(tp, 18));
    sl = Math.max(5, Math.min(6, sl));
    trailPct = Math.max(6, Math.min(10, trailPct));
    arm = Math.max(4, arm);
  } else if (tier === "moderate") {
    tp = Math.min(18, Math.max(tp, 12));
    sl = Math.max(5, Math.min(6, sl));
    trailPct = Math.max(6, Math.min(12, trailPct));
    arm = Math.max(3, arm);
  } else { // weak
    tp = Math.min(14, Math.max(8, tp - 2));
    sl = Math.max(6, Math.min(7, sl + 0));
    trailPct = Math.max(8, Math.min(14, trailPct + 2));
    arm = Math.max(2, arm);
  }
  if (chgSlope < 6 || scSlope < 3) sl = Math.max(sl, 6);

  return { tp, sl, trailPct, arm, tier, intensity };
}

function pickTpSlForMint(mint) {
  // Help user if TP/SL is wacked.
  const dyn = computeDynamicTpSlForMint(mint);
  const user = {
    tp: Math.max(1, Number(state.takeProfitPct || 0)),
    sl: Math.max(0.1, Number(state.stopLossPct || 0)),
    trailPct: Math.max(0, Number(state.trailPct || 0)),
    arm: Math.max(0, Number(state.minProfitToTrailPct || 0)),
  };

  const hardWacked =
    user.tp < 3 || user.tp > 100 ||
    user.sl < 0.25 || user.sl > 25 ||
    user.trailPct > 50 || user.arm > 30 ||
    (user.tp <= user.sl); // tp should generally be > sl

  const tpDiff    = Math.abs(user.tp - dyn.tp) / Math.max(5, dyn.tp);
  const slDiff    = Math.abs(user.sl - dyn.sl) / Math.max(1, dyn.sl);
  const trlDiff   = Math.abs(user.trailPct - dyn.trailPct) / Math.max(2, dyn.trailPct || 1);
  const armDiff   = Math.abs(user.arm - dyn.arm) / Math.max(1, dyn.arm || 1);
  const totalDiff = tpDiff + slDiff + trlDiff + armDiff;

  const goodFit = !hardWacked && totalDiff <= 0.60;

  if (goodFit) {
    log(`TP/SL check ${mint.slice(0,4)}… looks solid — keeping your config (TP=${user.tp}% SL=${user.sl}% Trail=${user.trailPct}% Arm=${user.arm}%).`);
    return { ...user, used: "user" };
  }

  log(`TP/SL check ${mint.slice(0,4)}… your settings look off — applying dynamic: TP=${dyn.tp}% SL=${dyn.sl}% Trail=${dyn.trailPct}% Arm=${dyn.arm}% (${dyn.tier} I=${dyn.intensity.toFixed(2)})`);
  return { ...dyn, used: "dynamic" };
}

function retunePositionFromFinalGate(mint) {
  try {
    if (!mint || !state.positions || !state.positions[mint]) return;
    const pos = state.positions[mint];
    const sel = pickTpSlForMint(mint);
    pos.tpPct = sel.tp;
    pos.slPct = sel.sl;
    pos.trailPct = sel.trailPct;
    pos.minProfitToTrailPct = sel.arm;
    save();
  } catch {}
}

function runFinalPumpGateBackground() {
  const cfg = state;
  if (!cfg.finalPumpGateEnabled) return;

  const store = _getFinalPumpGateStore();
  const nowTs = now();

  let leaders;
  try {
    leaders = computePumpingLeaders(5) || [];
  } catch {
    leaders = [];
  }

  const byMint = new Map();
  for (const it of leaders) {
    if (!it?.mint) continue;
    const sc = Number(it.pumpScore);
    if (!Number.isFinite(sc)) continue;
    byMint.set(it.mint, sc);
  }

  for (const [mint, scoreNow] of byMint.entries()) {
    const rec = store.get(mint);
    if (!rec) {
      if (scoreNow < cfg.finalPumpGateMinStart) {
        log(
          `Final gate: ${mint.slice(0,4)}… rejected, pumpScore ${scoreNow.toFixed(3)} < minStart ${cfg.finalPumpGateMinStart}.`,
          'err'
        );
        continue;
      }
      store.set(mint, { startScore: scoreNow, at: nowTs, ready: false });
      log(
        `Final gate: tracking ${mint.slice(0,4)}… startScore=${scoreNow.toFixed(3)} for Δ≥${cfg.finalPumpGateDelta}.`,
        'info'
      );
      continue;
    }

    if (rec.ready) {
      if (nowTs - rec.at > cfg.finalPumpGateWindowMs * 3) {
        store.delete(mint);
      }
      continue;
    }

    const elapsed = nowTs - rec.at;
    const delta = scoreNow - rec.startScore;

    if (elapsed > cfg.finalPumpGateWindowMs) {
      log(
        `Final gate: ${mint.slice(0,4)}… FAILED, Δscore=${delta.toFixed(3)} within ${(elapsed/1000).toFixed(1)}s (need ≥${cfg.finalPumpGateDelta}).`,
        'warn'
      );
      store.delete(mint);
      continue;
    }

    if (delta >= cfg.finalPumpGateDelta) {
      log(
        `Final gate: ${mint.slice(0,4)}… PASSED, Δscore=${delta.toFixed(3)} in ${(elapsed/1000).toFixed(1)}s. Ready to buy.`,
        'info'
      );
      store.set(mint, { ...rec, ready: true, at: nowTs, passDelta: delta, elapsedMs: elapsed });
      try { retunePositionFromFinalGate(mint); } catch {}
      continue;
    }

    logFastObserverSample(mint, {
      pumpGateStart: rec.startScore,
      pumpGateScoreNow: scoreNow,
      pumpGateDelta: delta,
      pumpGateElapsedMs: elapsed,
    });
  }

  for (const [mint, rec] of store.entries()) {
    if (!byMint.has(mint) && nowTs - rec.at > cfg.finalPumpGateWindowMs) {
      store.delete(mint);
    }
  }
}

function ensureFinalPumpGateTracking(mint, nowTs = now()) {
  try {
    const cfg = state;
    if (!cfg.finalPumpGateEnabled || !mint) return false;
    const store = _getFinalPumpGateStore();
    if (store.has(mint)) return true;

    let it = null;
    try {
      const leaders = computePumpingLeaders(10) || [];
      it = leaders.find(x => x?.mint === mint) || null;
    } catch {}

    const sc = Number(it?.pumpScore);
    if (Number.isFinite(sc) && sc >= cfg.finalPumpGateMinStart) {
      store.set(mint, { startScore: sc, at: nowTs, ready: false });
      log(`Final gate: tracking ${mint.slice(0,4)}… startScore=${sc.toFixed(3)} for Δ≥${cfg.finalPumpGateDelta}.`, 'warn');
      return true;
    }
  } catch {}
  return false;
}

// function finalPumpGatePasses(mint, { it = null } = {}, nowTs = now()) {
//   return isFinalPumpGateReady(mint);
// }

async function focusMintAndRecord(mint, { refresh = true, ttlMs = 2000, signal } = {}) {
  try {
    if (!mint) return null;
    if (!window._fdvFocusLast) window._fdvFocusLast = new Map();
    const nowTs = now();
    const last = Number(window._fdvFocusLast.get(mint) || 0);
    // throttle per-mint focus calls
    if (nowTs - last < Math.max(1200, Number(state.tickMs || 2000))) return null;

    const res = await focusMint(mint, { refresh, ttlMs, signal });
    window._fdvFocusLast.set(mint, nowTs);

    if (res?.ok && res.row) {
      const r = res.row;
      recordLeaderSample(mint, {
        pumpScore: Number(res.pumpScore ?? r.metric ?? 0),
        liqUsd:    Number(r.liqUsd ?? 0),
        v1h:       Number(r.v1hTotal ?? r.v1h ?? 0),
        chg5m:     Number(r.chg5m ?? 0),
        chg1h:     Number(r.chg1h ?? 0),
      });
    }
    return res;
  } catch {
    return null;
  }
}

async function observeMintOnce(mint, opts = {}) {
  if (!mint) return { ok: false, passes: 0 };

  const windowMs = Number.isFinite(opts.windowMs) ? opts.windowMs : Math.max(1800, Math.floor((state.tickMs || 2000) * 1.1));
  const sampleMs = Number.isFinite(opts.sampleMs) ? opts.sampleMs : Math.max(500, Math.floor(windowMs / 3.2));
  const minPasses = Number.isFinite(opts.minPasses) ? opts.minPasses : 3;
  const adjustHold = !!opts.adjustHold;

  const findLeader = () => {
    try { return (computePumpingLeaders(3) || []).find(x => x?.mint === mint) || null; } catch { return null; }
  };

  let it0 = findLeader();
  if (!it0) {
    try {
      const foc = await focusMint(mint, { refresh: true, ttlMs: 2000 });
      if (foc?.ok && foc.row) {
        it0 = {
          pumpScore: Number(foc.pumpScore || 0),
          kp: {
            liqUsd: Number(foc.row.liqUsd || 0),
            v1hTotal: Number(foc.row.v1hTotal || 0),
            change5m: Number(foc.row.chg5m || 0),
            change1h: Number(foc.row.chg1h || 0),
          },
        };
      }
    } catch {}
  }
  if (!it0) { noteObserverConsider(mint, 30_000); log(`Observer: ${mint.slice(0,4)}… not in leaders; using focus failed; skip.`); return { ok: false, passes: 0 }; }

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
    if (!itN) {
      try {
        const foc = await focusMint(mint, { refresh: true, ttlMs: 2000 });
        if (foc?.ok && foc.row) {
          itN = {
            pumpScore: Number(foc.pumpScore || 0),
            kp: {
              liqUsd: Number(foc.row.liqUsd || 0),
              v1hTotal: Number(foc.row.v1hTotal || 0),
              change5m: Number(foc.row.chg5m || 0),
              change1h: Number(foc.row.chg1h || 0),
            },
          };
        }
      } catch {}
    }
    if (!itN) { log(`Observer: ${mint.slice(0,4)}… dropped; focus unavailable; skip.`); return { ok: false, passes: 0 }; }

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
    setMintBlacklist(mint); // staged reverse log spam and broken holds (2m/15m/30m)
    log(`Observer: reject ${mint.slice(0,4)}… (score ${passes}/5); staged blacklist.`);
    return { ok: false, passes };
  }

  const holdSecs = passes >= 5 ? 120 : passes === 4 ? 95 : 70;
  if (passes >= minPasses) {
    if (adjustHold) {
      const _clamped = Math.min(120, Math.max(30, holdSecs));
      if (state.maxHoldSecs !== _clamped) { state.maxHoldSecs = _clamped; save(); }
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

async function getAtaBalanceUi(ownerPubkeyStr, mintStr, decimalsHint, commitment = "confirmed") {
  const conn = await getConn();
  await rpcWait("ata-balance", 450);
  const atas = await getOwnerAtas(ownerPubkeyStr, mintStr);
  let best = null;
  for (const { ata } of atas) {
    const res = await conn.getTokenAccountBalance(ata, commitment).catch(e => { _markRpcStress(e, 1500); return null; });
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
    const ai = await conn.getAccountInfo(ata, commitment).catch(e => { _markRpcStress(e, 1500); return null; });
    existsAny = existsAny || !!ai;
  }
  const decimals = Number.isFinite(decimalsHint) ? decimalsHint : (await getMintDecimals(mintStr));
  if (best) return best;
  return { sizeUi: 0, decimals, exists: existsAny };
}

async function closeEmptyTokenAtas(signer, mint) {
  try {
    const { PublicKey, Transaction, TransactionInstruction } = await loadWeb3();
    const conn = await getConn();
    const { createCloseAccountInstruction } = await loadSplToken();

    const ownerPk = signer.publicKey;
    const owner = ownerPk.toBase58();

    // Skip SOL
    if (!mint || mint === SOL_MINT) return false;

    if (rpcBackoffLeft() > 0) { log("Backoff active; deferring per-mint ATA close."); return false; }

    const atas = await getOwnerAtas(owner, mint);
    if (!atas?.length) return false;

    // Batch fetch account infos once
    const infos = await _getMultipleAccountsInfoBatched(conn, atas.map(a => a.ata), { commitment: "processed", batchSize: 95, kind: "gmai-close-one" });

    const ixs = [];
    for (let i = 0; i < atas.length; i++) {
      const { ata, programId } = atas[i];
      const ai = infos[i];
      if (!ai || !ai.data) continue;

      // Normalize raw bytes from AccountInfo
      const raw =
        ai.data instanceof Uint8Array
          ? ai.data
          : (Array.isArray(ai.data?.data) && typeof ai.data?.data[0] === "string")
              ? Uint8Array.from(atob(ai.data.data[0]), c => c.charCodeAt(0))
              : new Uint8Array();

      const amt = _readSplAmountFromRaw(raw);
      if (amt === null || amt > 0n) continue; // only close zero-balance

      if (typeof createCloseAccountInstruction === "function") {
        ixs.push(createCloseAccountInstruction(ata, ownerPk, ownerPk, [], programId));
      } else {
        ixs.push(new TransactionInstruction({
          programId,
          keys: [
            { pubkey: ata,     isSigner: false, isWritable: true },
            { pubkey: ownerPk, isSigner: false, isWritable: true },
            { pubkey: ownerPk, isSigner: true,  isWritable: false },
          ],
          data: Uint8Array.of(9),
        }));
      }
    }

    if (!ixs.length) return false;

    const tx = new Transaction();
    for (const ix of ixs) tx.add(ix);
    tx.feePayer = ownerPk;
    tx.recentBlockhash = (await conn.getLatestBlockhash("processed")).blockhash;
    tx.sign(signer);
    const sig = await conn.sendRawTransaction(tx.serialize(), { preflightCommitment: "processed", maxRetries: 2 });
    log(`Closed empty ATAs for ${mint.slice(0,4)}…: ${sig}`);
    return true;
  } catch {
    return false;
  }
}

async function closeAllEmptyAtas(signer) {
  try {
    if (!signer?.publicKey) return false;

    if (rpcBackoffLeft() > 0) { log("Backoff active; deferring global ATA close."); return false; }

    const { Transaction, TransactionInstruction } = await loadWeb3();
    const conn = await getConn();
    const { TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, createCloseAccountInstruction } = await loadSplToken();

    const ownerPk = signer.publicKey;
    const owner = ownerPk.toBase58();

    const mintSet = new Set();

    for (const m of Object.keys(state.positions || {})) {
      if (m && m !== SOL_MINT) mintSet.add(m);
    }

    try {
      const cached = cacheToList(owner) || [];
      for (const it of cached) { if (it?.mint && it.mint !== SOL_MINT) mintSet.add(it.mint); }
    } catch {}

    try {
      const dust = dustCacheToList(owner) || [];
      for (const it of dust) { if (it?.mint && it.mint !== SOL_MINT) mintSet.add(it.mint); }
    } catch {}

    mintSet.add(SOL_MINT);

    const atas = [];
    const seenAtas = new Set();
    for (const mint of mintSet) {
      try {
        const recs = await getOwnerAtas(owner, mint); // PDA-only, no RPC list calls
        for (const { ata, programId } of recs || []) {
          const k = `${programId?.toBase58?.() || String(programId)}:${ata.toBase58()}`;
          if (!seenAtas.has(k)) {
            seenAtas.add(k);
            atas.push({ ata, programId });
          }
        }
      } catch {}
    }
    if (!atas.length) return false;

    // Batch fetch all ATA infos once (chunked)
    const infos = await _getMultipleAccountsInfoBatched(conn, atas.map(a => a.ata), { commitment: "processed", batchSize: 95, kind: "gmai-close-all" });

    // Build close instructions only for zero-balance existent accounts
    const closeIxs = [];
    for (let i = 0; i < atas.length; i++) {
      const { ata, programId } = atas[i];
      const ai = infos[i];
      if (!ai || !ai.data) continue;

      const raw =
        ai.data instanceof Uint8Array
          ? ai.data
          : (Array.isArray(ai.data?.data) && typeof ai.data?.data[0] === "string")
              ? Uint8Array.from(atob(ai.data.data[0]), c => c.charCodeAt(0))
              : new Uint8Array();

      const amt = _readSplAmountFromRaw(raw);
      if (amt === null || amt > 0n) continue;

      if (typeof createCloseAccountInstruction === "function") {
        closeIxs.push(createCloseAccountInstruction(ata, ownerPk, ownerPk, [], programId));
      } else {
        closeIxs.push(new TransactionInstruction({
          programId,
          keys: [
            { pubkey: ata,     isSigner: false, isWritable: true },
            { pubkey: ownerPk, isSigner: false, isWritable: true },
            { pubkey: ownerPk, isSigner: true,  isWritable: false },
          ],
          data: Uint8Array.of(9),
        }));
      }
    }
    if (!closeIxs.length) return false;

    // Batch send to avoid oversized transactions
    const BATCH = 8;
    const sigs = [];
    for (let i = 0; i < closeIxs.length; i += BATCH) {
      const slice = closeIxs.slice(i, i + BATCH);
      try {
        await rpcWait?.("tx-close", 350);
        const tx = new Transaction();
        for (const ix of slice) tx.add(ix);
        tx.feePayer = ownerPk;
        tx.recentBlockhash = (await conn.getLatestBlockhash("processed")).blockhash;
        tx.sign(signer);
        const sig = await conn.sendRawTransaction(tx.serialize(), { preflightCommitment: "processed", maxRetries: 2 });
        sigs.push(sig);
        await new Promise(r => setTimeout(r, 120));
      } catch (e) {
        _markRpcStress?.(e, 2000);
        log(`Close-ATAs batch failed: ${e.message || e}`);
      }
    }

    if (sigs.length > 0) {
      log(`Closed ${closeIxs.length} empty ATAs (known set) in ${sigs.length} tx(s): ${sigs.join(", ")}`);
      return true;
    }
    return false;
  } catch (e) {
    log(`Close-empty-ATAs failed: ${e.message || e}`);
    return false;
  }
}

async function pruneZeroBalancePositions(ownerPubkeyStr, { limit = 8 } = {}) {
  try {
    const mints = Object.keys(state.positions || {}).filter(m => m && m !== SOL_MINT);
    if (!mints.length) return;
    let checked = 0;
    for (const mint of mints) {
      if (checked >= limit) break;

      // Skip pruning during credit/size-sync grace window
      const pos = state.positions[mint];
      const ageMs = now() - Number(pos?.lastBuyAt || pos?.acquiredAt || 0);
      const pendKey = _pcKey(ownerPubkeyStr, mint);
      const hasPending = !!(_pendingCredits?.has?.(pendKey));
      const grace = Math.max(8000, Number(state.pendingGraceMs || 20000));
      if (hasPending || pos?.awaitingSizeSync === true || ageMs < grace) { checked++; continue; }

      try {
        const b = await getAtaBalanceUi(ownerPubkeyStr, mint, state.positions[mint]?.decimals /* uses confirmed by default */);
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
      const resp = await conn.getParsedTokenAccountsByOwner(new PublicKey(ownerPubkeyStr), { programId }, "confirmed");
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
      log(`Parsed owner scan error (${programId.toBase58?.() || "unknown"}): ${e.message || e}`, 'err');
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
      await _addRealizedPnl(estSol, costSold, "Startup sweep PnL");
      try { await closeEmptyTokenAtas(kp, mint); } catch {}
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


  await sanitizeDustCache(owner);




  const dust = dustCacheToList(owner) || [];
  if (!dust.length) {
    log("Startup dust sweep: no entries.");
    return;
  }

  let sold = 0, kept = 0, pruned = 0;
  for (const it of dust) {
    const mint = it.mint;
    const validMint = await isValidPubkeyStr(mint).catch(() => false);
    if (!validMint) {
      removeFromDustCache(owner, mint);
      removeFromPosCache(owner, mint);
      pruned++;
      continue;
    }

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
        try { await closeEmptyTokenAtas(kp, mint); } catch {}
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
  const tp       = Math.max(0, Number(pos.tpPct ?? state.takeProfitPct ?? 0));
  const sl       = Math.max(0, Number(pos.slPct ?? state.stopLossPct ?? 0));
  const trail    = Math.max(0, Number(pos.trailPct ?? state.trailPct ?? 0));
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

function fastDropCheck(mint, pos) {
  try {
    const sig = getRugSignalForMint(mint);

    const sev = Number(sig?.sev ?? 0);
    if (sig?.rugged && sev >= RUG_FORCE_SELL_SEVERITY) {
      return { trigger: true, reason: `rug sev=${sev.toFixed(2)}`, sev };
    }

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

    const series = getLeaderSeries(mint, 3);
    if (series && series.length >= 3) {
      const a = series[0], c = series[series.length - 1];
      const scSlopeMin = _clamp(slope3pm(series, "pumpScore"), -20, 20);
      const chgSlopeMin= _clamp(slope3pm(series, "chg5m"),    -60, 60);
      const passChg    = c.chg5m <= a.chg5m;
      const passScore  = c.pumpScore <= a.pumpScore * 0.97;
      if (passChg && passScore && (scSlopeMin < 0 || chgSlopeMin < 0)) {
        return { trigger: true, reason: "momentum drop (3/5)", sev: 0.55 };
      }
    }
  } catch {}
  return { trigger: false };
}

function startFastObserver() {
  if (window._fdvFastObsTimer) return;
  window._fdvFastObsTimer = setInterval(() => {
    try {
      const entries = Object.entries(state.positions || {});
      if (!entries.length) return;

      for (const [mint, pos] of entries) {
        if (!mint || mint === SOL_MINT) continue;
        if (Number(pos.sizeUi || 0) <= 0) continue;

        logFastObserverSample(mint, pos);

        const ageMs = now() - Number(pos.lastBuyAt || pos.acquiredAt || 0);
        const postBuyCooldownMs = Math.max(8_000, Number(state.coolDownSecsAfterBuy || 0) * 1000);
        const inWarmingHold = !!(state.rideWarming && pos.warmingHold === true);

        const r = fastDropCheck(mint, pos);

        try {
          const momStore = _getMomentumDropStore();
          const rec = momStore.get(mint) || { count: 0, lastAt: 0 };
          const isMom = r.trigger && /momentum\s*drop/i.test(String(r.reason || ""));
          if (isMom) {
            rec.count = (rec.count | 0) + 1;
            rec.lastAt = now();

            // Only arm if outside immediate post-buy guard
            if (rec.count >= MOMENTUM_FORCED_EXIT_CONSEC && ageMs >= postBuyCooldownMs) {
              noteMomentumExit(mint, 30_000);
              flagUrgentSell(mint, "momentum_drop_x28", 0.90);
              log(`Momentum drop x${MOMENTUM_FORCED_EXIT_CONSEC} for ${mint.slice(0,4)}… forced exit armed.`);
              rec.count = 0; // reset after arming
            }
          } else {
            rec.count = 0;
            rec.lastAt = now();
          }
          momStore.set(mint, rec);
        } catch {}

        if (r.trigger && ageMs < EARLY_URGENT_WINDOW_MS && Number(r.sev || 0) >= 0.6) {
          flagUrgentSell(mint, r.reason, r.sev);
          continue;
        }

        // Suppress general urgency while unsynced/warming or during post-buy cooldown
        if (pos.awaitingSizeSync === true) continue;
        if (!inWarmingHold && ageMs < Math.max(URGENT_SELL_MIN_AGE_MS, postBuyCooldownMs)) continue;

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

async function verifyRealTokenBalance(ownerPub, mint, pos) {
  // Kill wallet Phantom balances
  try {
    if (!ownerPub || !mint || !pos) return { ok: false, reason: "bad_args" };
    if (mint === SOL_MINT) return { ok: true, sizeUi: 0 };

    const bal = await getAtaBalanceUi(ownerPub, mint, pos.decimals, "confirmed");
    const chainUi = Number(bal.sizeUi || 0);
    const exists = !!bal.exists;

    const ageMs = now() - Number(pos.lastBuyAt || pos.acquiredAt || 0);
    const graceMs = Math.max(10_000, Number(state.pendingGraceMs || 20_000));
    const pendingKey = _pcKey(ownerPub, mint);
    const pending = _pendingCredits?.has?.(pendingKey);

    if ((!exists || chainUi <= 1e-9) && Number(pos.sizeUi || 0) > 0 && !pending && ageMs > graceMs) {
      try { removeFromPosCache(ownerPub, mint); } catch {}
      try { removeFromDustCache(ownerPub, mint); } catch {}
      try { clearPendingCredit(ownerPub, mint); } catch {}
      delete state.positions[mint];
      save();
      log(`Phantom position removed: ${mint.slice(0,4)}… (no on-chain balance).`);
      return { ok: false, purged: true, reason: "phantom" };
    }
    const cachedUi = Number(pos.sizeUi || 0);
    if (chainUi > 0 && Math.abs(chainUi - cachedUi) / Math.max(chainUi, 1e-9) > 0.05) {
      pos.sizeUi = chainUi;
      pos.awaitingSizeSync = false;
      updatePosCache(ownerPub, mint, chainUi, bal.decimals);
      save();
      log(`Position size reconciled from chain: ${mint.slice(0,4)}… -> ${chainUi.toFixed(6)}.`);
    }

    return { ok: true, sizeUi: chainUi };
  } catch (e) {
    log(`verifyRealTokenBalance error ${mint.slice(0,4)}…: ${e.message||e}`, 'err');
    return { ok: false, reason: "error" };
  }
}

async function maybeStealthRotate(tag = "sell") {
  try {
    if (!state.stealthMode) return false;
    const kp = await getAutoKeypair();
    if (!kp) return false;

    const openPosCount = Object.entries(state.positions || {})
      .filter(([m, p]) => m !== SOL_MINT && Number(p?.sizeUi || 0) > 0).length;
    if (openPosCount > 0) {
      log(`Stealth: deferring wallet rotation (open positions=${openPosCount}).`);
      return false;
    }

    const { Keypair, bs58, SystemProgram, Transaction } = await loadDeps();
    const conn = await getConn();
    const oldSigner = kp;
    const oldPubStr = oldSigner.publicKey.toBase58();
    const oldSecretStr = String(state.autoWalletSecret || bs58.default.encode(oldSigner.secretKey));

    const newKp = Keypair.generate();
    const newPubStr = newKp.publicKey.toBase58();
    const newSecretStr = bs58.default.encode(newKp.secretKey);

    try { await unwrapWsolIfAny(oldSigner); } catch {}

    let balL = 0;
    try { balL = await conn.getBalance(oldSigner.publicKey, "processed"); } catch {}
    const bufL = Math.max(50_000, TX_FEE_BUFFER_LAMPORTS); // ~0.00005-0.0005 SOL buffer
    const sendLamports = Math.max(0, balL - bufL);
    let transferSig = "";

    if (sendLamports <= 0) {
      log(`Stealth: balance too low to transfer; rotating key only.`);
    } else {
      try {
        const tx = new Transaction().add(
          SystemProgram.transfer({
            fromPubkey: oldSigner.publicKey,
            toPubkey: newKp.publicKey,
            lamports: sendLamports,
          })
        );
        tx.feePayer = oldSigner.publicKey;
        tx.recentBlockhash = (await conn.getLatestBlockhash("processed")).blockhash;
        tx.sign(oldSigner);
        const sig = await conn.sendRawTransaction(tx.serialize(), { preflightCommitment: "processed", maxRetries: 2 });
        transferSig = sig;
        log(`Stealth: SOL moved to new wallet (${newPubStr.slice(0,4)}…) tx=${sig}`);
        try { await confirmSig(sig, { commitment: "confirmed", timeoutMs: 12000 }); } catch {}
      } catch (e) {
        // Archive even on failure so user can recover
        addOldWalletRecord({ pub: oldPubStr, secret: oldSecretStr, tag: `transfer-failed:${tag}`, movedLamports: sendLamports, txSig: "" });
        log(`Stealth: transfer failed: ${e.message || e}`);
        log(`WARNING: Stealth archive (old wallet): pub=${oldPubStr} secret=${oldSecretStr}`);
        console.log(`WARNING: Stealth new wallet: pub=${newPubStr} secret=${newSecretStr}`);
        return false;
      }
    }

    addOldWalletRecord({ pub: oldPubStr, secret: oldSecretStr, tag, movedLamports: sendLamports, txSig: transferSig });

    log(`WARNING: Stealth archive (old wallet): pub=${oldPubStr} secret=${oldSecretStr}`);
    log(`WARNING: Stealth new wallet: pub=${newPubStr} secret=${newSecretStr}`);
    console.log(`WARNING: Stealth archive (old wallet): pub=${oldPubStr} secret=${oldSecretStr}`);

    state.autoWalletPub = newPubStr;
    state.autoWalletSecret = newSecretStr;
    save();
    log(`Stealth: rotated wallet (${tag}). New wallet: ${newPubStr.slice(0,4)}…`);
    return true;
  } catch (e) {
    log(`Stealth: rotation error: ${e.message || e}`, 'err');
    return false;
  }
}

function shouldApplyWarmingHold(mint, pos, nowTs) {
  try {
    const badge = normBadge(getRugSignalForMint(mint)?.badge);
    if (badge === "calm") return false;
    if (isPumpDropBanned(mint) || isMintBlacklisted(mint)) return false;

    const series = getLeaderSeries(mint, 3) || [];
    const scSlopeMin  = _clamp(slope3pm(series, "pumpScore"), -20, 20);
    const chgSlopeMin = _clamp(slope3pm(series, "chg5m"),     -60, 60);

    // if both micro-slopes turned down or we already stacked consecutive negative score-slope, warming no longer applies
    if (scSlopeMin < 0 && chgSlopeMin < 0) return false;
    if (Number(pos.earlyNegScCount || 0) >= 2) return false;

    // age sanity: if we’re long past auto-release and still negative, don’t wait for warming target
    const ageSec = (nowTs - Number(pos.lastBuyAt || pos.acquiredAt || 0)) / 1000;
    const releaseSec = Math.max(0, Number(state.warmingAutoReleaseSecs || 0));
    if (ageSec > releaseSec * 1.5) return false;

    return (badge === "warming" || badge === "pumping");
  } catch { return false; }
}

function applyWarmingPolicy({ mint, pos, nowTs, pnlPct, curSol, decision, forceRug, forcePumpDrop, forceObserverDrop, forceEarlyFade }) {
  const result = { decision, forceObserverDrop, forcePumpDrop, warmingActive: false, warmingHoldActive: false, warmingMaxLossTriggered: false };
  try {
    const warmingActive = !!(state.rideWarming && pos.warmingHold === true);
    result.warmingActive = warmingActive;
    if (!warmingActive) return result;

    if (!shouldApplyWarmingHold(mint, pos, nowTs)) {
      pos.warmingHold = false;
      pos.warmingClearedAt = now();
      delete pos.warmingExtendUntil;
      save();
      log(`Warming disabled for ${mint.slice(0,4)}… (regime not favorable).`);
      return result;
    }

    const warmAgeMs = nowTs - Number(pos.warmingHoldAt || pos.lastBuyAt || pos.acquiredAt || 0);
    const maxLossPctCfg = Math.max(1, Number(state.warmingMaxLossPct || 6));
    const maxLossWindowMs = Math.max(5_000, Number(state.warmingMaxLossWindowSecs || 60) * 1000);
    if (warmAgeMs <= maxLossWindowMs) {
      if (Number.isFinite(pnlPct) && pnlPct <= -maxLossPctCfg) {
        const msg = `WARMING MAX LOSS ${pnlPct.toFixed(2)}% <= -${maxLossPctCfg}%`;
        log(`Warming max-loss hit for ${mint.slice(0,4)}… (${msg}). Selling now.`);
        pos.warmingHold = false;
        pos.warmingClearedAt = now();
        delete pos.warmingExtendUntil;
        save();
        result.decision = { action: "sell_all", reason: msg, hardStop: true };
        result.warmingMaxLossTriggered = true;
        return result;
      }
    }

    const warmReq = computeWarmingRequirement(pos, nowTs);
    const ext = isWarmingHoldActive(mint, pos, warmReq, nowTs);
    result.warmingHoldActive = !!ext.active;

    if (Number.isFinite(pnlPct) && pnlPct >= warmReq.req) {
      pos.warmingHold = false;
      pos.warmingClearedAt = now();
      delete pos.warmingExtendUntil;
      save();
      const msg = `WARMING_TARGET ${pnlPct.toFixed(2)}% ≥ ${warmReq.req.toFixed(2)}%`;
      result.decision = { action: "sell_all", reason: msg, hardStop: true };
      log(`Warming target met for ${mint.slice(0,4)}… selling now (${msg}).`);
      return result;
    }

    if (warmReq.shouldAutoRelease && !result.warmingHoldActive && pos.warmingHold === true) {
      pos.warmingHold = false;
      pos.warmingClearedAt = now();
      delete pos.warmingExtendUntil;
      save();
      log(`Warming auto-release: ${mint.slice(0,4)}… (elapsed ${warmReq.elapsedTotalSec}s)`);
      return result; 
    }

    if (!result.warmingMaxLossTriggered &&
        result.warmingHoldActive &&
        pnlPct < warmReq.req &&
        !forceRug &&
        !forceEarlyFade) {
      if (result.forceObserverDrop || result.forcePumpDrop) {
        log(`Warming hold: suppressing volatility sell for ${mint.slice(0,4)}… (PnL ${pnlPct.toFixed(2)}% < ${warmReq.req.toFixed(2)}%).`);
      }
      result.forceObserverDrop = false;
      result.forcePumpDrop = false;

      const rsn = String(result.decision?.reason || "");
      const isHardOrFast = !!result.decision?.hardStop || /rug|warming-max-loss|HARD_STOP|FAST_/i.test(rsn);
      if (result.decision && result.decision.action !== "none" && !isHardOrFast) {
        log(`Warming hold: skipping sell (${result.decision.reason||"—"}) for ${mint.slice(0,4)}… (PnL ${pnlPct.toFixed(2)}% < ${warmReq.req.toFixed(2)}%).`);
        result.decision = { action: "none", reason: "warming-hold-until-profit" };
      }
    }

    if (warmReq.shouldAutoRelease && !result.warmingHoldActive && pos.warmingHold === true) {
      pos.warmingHold = false;
      pos.warmingClearedAt = now();
      delete pos.warmingExtendUntil;
      // start a grace window so TP/SL/trailing can take over before timers
      const graceMs = Math.max(10_000, Number(state.warmingPostReleaseGraceSecs || 60) * 1000);
      pos.postWarmGraceUntil = now() + graceMs;
      result.postReleaseGraceUntil = pos.postWarmGraceUntil;
      try { const sel = pickTpSlForMint(mint); pos.tpPct=sel.tp; pos.slPct=sel.sl; pos.trailPct=sel.trailPct; pos.minProfitToTrailPct=sel.arm; save(); } catch {}
      log(`Warming auto-release: ${mint.slice(0,4)}… (+${Math.floor(graceMs/1000)}s TP/SL grace)`);
      return result;
    }
  } catch {}
  return result;
}

function warmingPolicyHook(ctx) {
  const res = applyWarmingPolicy({
    mint: ctx.mint,
    pos: ctx.pos,
    nowTs: ctx.nowTs,
    pnlPct: ctx.pnlPct,
    curSol: ctx.curSol,
    decision: ctx.decision,
    forceRug: ctx.forceRug,
    forcePumpDrop: ctx.forcePumpDrop,
    forceObserverDrop: ctx.forceObserverDrop,
    forceEarlyFade: !!ctx.earlyReason
  });
  ctx.decision = res.decision || ctx.decision;
  ctx.forceObserverDrop = res.forceObserverDrop;
  ctx.forcePumpDrop = res.forcePumpDrop;
  if (res.decision?.hardStop && /WARMING_TARGET|warming[-\s]*max[-\s]*loss/i.test(String(res.decision.reason || ""))) {
    ctx.isFastExit = true;
  }
  ctx.warmingHoldActive = !!res.warmingHoldActive;
}

function _mkSellCtx({ kp, mint, pos, nowTs }) {
  const ctx = {
    kp, mint, pos, nowTs,
    ownerStr: kp?.publicKey?.toBase58?.() || "",
    leaderMode: !!state.holdUntilLeaderSwitch,
    ageMs: 0,
    maxHold: 0,
    forceExpire: false,
    inSellGuard: false,
    forceMomentum: false,
    verified: false,
    hasPending: false,
    creditGraceMs: 0,
    sizeOk: false,
    forceRug: false,
    rugSev: 0,
    forcePumpDrop: false,
    forceObserverDrop: false,
    earlyReason: "",
    obsPasses: null,
    curSol: 0,
    curSolNet: 0,
    outLamports: 0,
    netEstimate: null,
    pxNow: 0,
    pxCost: 0,
    pnlPct: 0,
    pxNowNet: 0,
    pnlNetPct: 0,
    ageSec: 0,
    remorseSecs: 0,
    creditsPending: false,
    canHardStop: false,
    dynStopPct: null,
    decision: null,
    isFastExit: false,
    warmingHoldActive: false,
    fastResult: null,
    obsThreeShouldForce: false,
    minNotional: 0,
    skipSoftGates: false,
    postGrace: 0,
    postWarmGraceActive: false,
    inWarmingHold: false,
  };
  return ctx;
}

async function preflightSellPolicy(ctx) {
  const { mint, pos, nowTs } = ctx;
  ctx.ageMs = nowTs - Number(pos.lastBuyAt || pos.acquiredAt || 0);
  ctx.maxHold = Math.max(0, Number(state.maxHoldSecs || 0));
  ctx.forceExpire = ctx.maxHold > 0 && ctx.ageMs >= ctx.maxHold * 1000;

  // Router cooldown gate (unless we're at forceExpire)
  if (!ctx.forceExpire && window._fdvRouterHold && window._fdvRouterHold.get(mint) > now()) {
    const until = window._fdvRouterHold.get(mint);
    log(`Router cooldown for ${mint.slice(0,4)}… until ${new Date(until).toLocaleTimeString()}`);
    return { stop: true };
  }

  const sz = Number(pos.sizeUi || 0);
  if (sz <= 0) {
    log(`Skip sell eval for ${mint.slice(0,4)}… (no size)`);
    return { stop: true };
  }

  ctx.forceMomentum = shouldForceMomentumExit(mint);

  ctx.inSellGuard = Number(pos.sellGuardUntil || 0) > nowTs;

  // Verify chain balance to avoid phantom exits
  const vr = await verifyRealTokenBalance(ctx.ownerStr, mint, pos);
  if (!vr.ok && vr.purged) return { stop: true };
  if (!vr.ok) {
    log(`Sell skip (unverified balance) ${mint.slice(0,4)}…`);
    return { stop: true };
  }
  if (vr.sizeUi <= 1e-9) return { stop: true };

  // Pending credits grace
  const pendKey = _pcKey(ctx.ownerStr, mint);
  ctx.hasPending = !!(_pendingCredits?.has?.(pendKey));
  ctx.creditGraceMs = Math.max(8_000, Number(state.pendingGraceMs || 20_000));
  if ((pos.awaitingSizeSync || ctx.hasPending) && ctx.ageMs < ctx.creditGraceMs) {
    log(`Sell skip ${mint.slice(0,4)}… awaiting credit/size sync (${Math.round(ctx.ageMs/1000)}s).`);
    return { stop: true };
  }

  ctx.sizeOk = true;
  return { stop: false };
}

function leaderModePolicy(ctx) {
  if (!ctx.leaderMode) return { stop: false };
  const sig0 = getRugSignalForMint(ctx.mint);
  if (!(sig0?.rugged) && !ctx.forceMomentum) {
    log(`Leader-hold: holding ${ctx.mint.slice(0,4)}… (no rug).`);
    return { stop: true };
  }
  if (!sig0?.rugged && ctx.forceMomentum) {
    log(`Leader-hold override: momentum drop x18 for ${ctx.mint.slice(0,4)}… forcing sell.`);
  } else if (sig0?.rugged) {
    log(`Leader-hold: RUG detected for ${ctx.mint.slice(0,4)}… sev=${Number(sig0.sev||0).toFixed(2)}. Forcing sell.`);
  }
  return { stop: false };
}

function urgentSellPolicy(ctx) {
  const urgent = takeUrgentSell(ctx.mint);
  if (!urgent) return;
  if (ctx.ageMs < URGENT_SELL_MIN_AGE_MS) {
    log(`Urgent sell suppressed (warmup ${Math.round(ctx.ageMs/1000)}s) for ${ctx.mint.slice(0,4)}…`);
    return;
  }
  const isRugUrg = /rug/i.test(String(urgent.reason||""));
  const highSev = Number(urgent.sev || 0) >= 0.75;
  if (ctx.inSellGuard && !isRugUrg && !highSev) {
    log(`Sell guard active; deferring urgent sell for ${ctx.mint.slice(0,4)}…`);
    return;
  }
  ctx.forceObserverDrop = true;
  ctx.rugSev = Number(urgent.sev || 1);
  log(`Urgent sell for ${ctx.mint.slice(0,4)}… (${urgent.reason}); bypassing notional/cooldowns.`);
}

function rugPumpDropPolicy(ctx) {
  try {
    const sig = getRugSignalForMint(ctx.mint);
    recordBadgeTransition(ctx.mint, sig.badge);

    const badgeNorm = normBadge(sig.badge);
    const sev = Number(sig?.sev ?? 0);
    const sevThreshold = RUG_FORCE_SELL_SEVERITY;

    if (sig?.rugged && sev >= sevThreshold) {
      ctx.forceRug = true;
      ctx.rugSev = sev;
      setMintBlacklist(ctx.mint, MINT_RUG_BLACKLIST_MS);
      log(`Rug detected for ${ctx.mint.slice(0,4)}… sev=${ctx.rugSev.toFixed(2)} (thr=${sevThreshold.toFixed(2)}). Forcing sell and blacklisting 30m.`);
    } else if (sig?.rugged) {
      setMintBlacklist(ctx.mint);
      log(`Rug soft-flag for ${ctx.mint.slice(0,4)}… sev=${sev.toFixed(2)} < ${sevThreshold.toFixed(2)} — staged blacklist, no forced sell.`);
    } else if (!ctx.leaderMode) {
      const curNorm = badgeNorm;
      console.log(`Badge for ${ctx.mint.slice(0,4)}…: ${String(sig.badge||"").toLowerCase()} -> ${curNorm}`);
      if (curNorm === "calm" && isPumpDropBanned(ctx.mint)) {
        ctx.forcePumpDrop = true;
        log(`Pump->Calm drop for ${ctx.mint.slice(0,4)}… forcing sell and banning re-buys for 30m.`);
      }
    }
  } catch {}
}

function earlyFadePolicy(ctx) {
  try {
    const series = getLeaderSeries(ctx.mint, 3);
    const last = series && series.length ? series[series.length - 1] : null;
    const curChg5m = Number(last?.chg5m || 0);
    const scSlopeMin = _clamp(slope3pm(series || [], "pumpScore"), -20, 20);

    const scNeg = Number(scSlopeMin) <= Math.min(-1, Number(state.earlyExitScSlopeNeg || -10));
    ctx.pos.earlyNegScCount = scNeg ? (Number(ctx.pos.earlyNegScCount || 0) + 1) : 0;

    const entryChg = Number(ctx.pos.entryChg5m || NaN);
    if (Number.isFinite(entryChg) && entryChg > 0) {
      const dropFrac = (entryChg - curChg5m) / Math.max(1e-6, entryChg);
      if (dropFrac >= Math.max(0.30, Number(state.earlyExitChgDropFrac || 0.4))) {
        ctx.forceObserverDrop = true;
        ctx.earlyReason = `FAST_FADE chg5m -${(dropFrac*100).toFixed(1)}%`;
      }
    }

    if (!ctx.forceObserverDrop) {
      const needConsec = Math.max(1, Number(state.earlyExitConsec || 2));
      if (Number(ctx.pos.earlyNegScCount || 0) >= needConsec) {
        ctx.forceObserverDrop = true;
        ctx.earlyReason = `FAST_FADE scSlope ${scSlopeMin.toFixed(2)}/m x${ctx.pos.earlyNegScCount}`;
      }
    }

    const extended = getLeaderSeries(ctx.mint, 5);
    if (extended && extended.length >= 3) {
      let changes = 0;
      for (let i = 2; i < extended.length; i++) {
        const a = Number(extended[i-2].chg5m || 0);
        const b = Number(extended[i-1].chg5m || 0);
        const c = Number(extended[i].chg5m   || 0);
        const dir1 = Math.sign(b - a);
        const dir2 = Math.sign(c - b);
        if (dir1 && dir2 && dir1 !== dir2) changes++;
      }

      if (!ctx.forceObserverDrop && changes >= 2 && scSlopeMin > -2) {
        ctx.pos.earlyNegScCount = 0;
        ctx.earlyReason = "";
        log(`Jiggle hold: ${ctx.mint.slice(0,4)}… direction changes=${changes} scSlope=${scSlopeMin.toFixed(2)}/m`);
      }

      if (extended.length === 5) {
        let allDown = true;
        for (let i = 1; i < extended.length; i++) {
          if (!(Number(extended[i].chg5m || 0) < Number(extended[i-1].chg5m || 0))) {
            allDown = false; break;
          }
        }
        if (allDown && scSlopeMin < 0) {
          ctx.forceObserverDrop = true;
          ctx.earlyReason = `DOWN_SLOPE_5 scSlope ${scSlopeMin.toFixed(2)}/m`;
        }
      }
    }

    if (ctx.forceObserverDrop) {
      log(`Early-exit: ${ctx.mint.slice(0,4)}… ${ctx.earlyReason} — overriding warming sell guard.`);
    }
  } catch {}
}

async function observerPolicy(ctx) {
  if (ctx.leaderMode || ctx.forceRug || ctx.forcePumpDrop) return;
  try {
    const obs = await observeMintOnce(ctx.mint, { windowMs: 2000, sampleMs: 600, minPasses: 4, adjustHold: !!state.dynamicHoldEnabled });
    if (!obs.ok) {
      const p = Number(obs.passes || 0);
      recordObserverPasses(ctx.mint, p);
      const thr = Math.max(0, Number(state.observerDropSellAt ?? 4));

      const badgeNow = normBadge(getRugSignalForMint(ctx.mint)?.badge);
      const pumpingish = (badgeNow === "pumping" || badgeNow === "warming");

      const needLowConsec = pumpingish ? 2 : 1;
      const dg = _getDropGuardStore().get(ctx.mint) || {};
      const lowConsec = Number(dg.consecLow || 0);
      const bypassAt = Math.max(0, Number(1));
      const hardBypass = (p <= bypassAt);

      if (p <= 2) {
        if (hardBypass) {
          ctx.forceObserverDrop = true;
          setMintBlacklist(ctx.mint);
          log(`Observer hard drop for ${ctx.mint.slice(0,4)}… (${p}/5 <= ${bypassAt}) forcing sell (staged blacklist).`);
        } else if (ctx.inSellGuard) {
          log(`Sell guard active; suppressing observer drop (${p}/5) for ${ctx.mint.slice(0,4)}…`);
        } else if (lowConsec < needLowConsec) {
          log(`Observer low-pass ${p}/5 while ${badgeNow}; debounce ${lowConsec}/${needLowConsec}. Holding & watching.`);
          noteObserverConsider(ctx.mint, 30_000);
        } else {
          ctx.forceObserverDrop = true;
          setMintBlacklist(ctx.mint);
          log(`Observer drop for ${ctx.mint.slice(0,4)}… (${p}/5 <= 2) forcing sell (staged blacklist).`);
        }
      } else if (p === 3 && thr >= 3) {
        ctx.obsPasses = 3;
      }
    } else {
      recordObserverPasses(ctx.mint, Number(obs.passes || 5));
    }
  } catch {}
}

function volatilityGuardPolicy(ctx) {
  const postBuyCooldownMs = Math.max(8_000, Number(state.coolDownSecsAfterBuy || 0) * 1000);
  ctx.inWarmingHold = !!(state.rideWarming && ctx.pos.warmingHold === true);
  if (!ctx.leaderMode && (ctx.inSellGuard || ctx.ageMs < postBuyCooldownMs) &&
      (ctx.forceObserverDrop || ctx.forcePumpDrop) && !ctx.inWarmingHold && !ctx.forceRug && !ctx.earlyReason) {
    log(`Volatility sell guard active; suppressing observer/pump drop for ${ctx.mint.slice(0,4)}…`);
    ctx.forceObserverDrop = false;
    ctx.forcePumpDrop = false;
  }
}

async function quoteAndEdgePolicy(ctx) {
  const sz = Number(ctx.pos.sizeUi || 0);
  let curSol = Number(ctx.pos.lastQuotedSol || 0);
  const lastQ = Number(ctx.pos.lastQuotedAt || 0);
  if (!lastQ || (ctx.nowTs - lastQ) > (state.minQuoteIntervalMs|0)) {
    log(`Evaluating sell for ${ctx.mint.slice(0,4)}… size ${sz.toFixed(6)}`);
    curSol = await quoteOutSol(ctx.mint, sz, ctx.pos.decimals).catch(() => 0);
    ctx.pos.lastQuotedSol = curSol;
    ctx.pos.lastQuotedAt = ctx.nowTs;
  }
  // shock detector
  try {
    const prevSol = Number(ctx.pos._lastShockSol || 0);
    const prevAt  = Number(ctx.pos._lastShockAt  || 0);
    if (prevSol > 0 && curSol > 0 && (ctx.nowTs - prevAt) <= RUG_QUOTE_SHOCK_WINDOW_MS) {
      const dropFrac = (prevSol - curSol) / Math.max(prevSol, 1e-12);
      if (dropFrac >= RUG_QUOTE_SHOCK_FRAC) {
        log(`RUG quote-shock ${ctx.mint.slice(0,4)}… drop=${(dropFrac*100).toFixed(1)}% within ${(ctx.nowTs-prevAt)}ms`);
        flagUrgentSell(ctx.mint, "rug_quote_shock", 1.0);
      }
    }
    ctx.pos._lastShockSol = curSol;
    ctx.pos._lastShockAt  = ctx.nowTs;
  } catch {}

  ctx.curSol = curSol;

  ctx.outLamports = Math.floor(Math.max(0, ctx.curSol) * 1e9);
  ctx.decIn = Number.isFinite(ctx.pos.decimals) ? ctx.pos.decimals : 6;
  const net = estimateNetExitSolFromQuote({
    mint: ctx.mint,
    amountUi: sz,
    inDecimals: ctx.decIn,
    quoteOutLamports: ctx.outLamports
  });
  ctx.netEstimate = net;
  ctx.curSolNet = net.netSol;

  if (Number.isFinite(ctx.curSol) && Number.isFinite(ctx.curSolNet)) {
    log(`Edge-aware valuation ${ctx.mint.slice(0,4)}… raw≈${ctx.curSol.toFixed(6)} SOL, net≈${ctx.curSolNet.toFixed(6)} SOL${net.feeApplied ? " (fee)" : ""}`);
  }

  ctx.pxNow  = sz > 0 ? (ctx.curSol / sz) : 0;
  ctx.pxCost = sz > 0 ? (Number(ctx.pos.costSol || 0) / sz) : 0;
  ctx.pnlPct = (ctx.pxNow > 0 && ctx.pxCost > 0) ? ((ctx.pxNow - ctx.pxCost) / ctx.pxCost) * 100 : 0;

  ctx.pxNowNet  = sz > 0 ? (ctx.curSolNet / sz) : 0;
  ctx.pnlNetPct = (ctx.pxNowNet > 0 && ctx.pxCost > 0) ? ((ctx.pxNowNet - ctx.pxCost) / ctx.pxCost) * 100 : 0;
}

function fastExitPolicy(ctx) {
  const fast = checkFastExitTriggers(ctx.mint, ctx.pos, { pnlPct: ctx.pnlPct, pxNow: ctx.pxNow, nowTs: ctx.nowTs });
  ctx.fastResult = fast;
  if (fast && fast.action !== "none") {
    ctx.decision = { ...fast };
    ctx.isFastExit = true;
    log(`Fast-exit trigger for ${ctx.mint.slice(0,4)}… -> ${ctx.decision.action} (${ctx.decision.reason}${ctx.decision.pct ? ` ${ctx.decision.pct}%` : ""})`);
  }
}

function dynamicHardStopPolicy(ctx) {
  ctx.ageSec = (ctx.nowTs - Number(ctx.pos.lastBuyAt || ctx.pos.acquiredAt || 0)) / 1000;
  ctx.remorseSecs = Math.max(5, Number(DYN_HS?.remorseSecs ?? 6));
  ctx.creditsPending = ctx.pos.awaitingSizeSync === true || ctx.pos._pendingCostAug === true;
  ctx.canHardStop = ctx.ageSec >= ctx.remorseSecs && !ctx.creditsPending;

  if (state.rideWarming && ctx.pos.warmingHold === true) {
    const warmNoHs = Math.max(ctx.remorseSecs, Number(state.warmingNoHardStopSecs || 35));
    if (ctx.ageSec < warmNoHs) {
      ctx.canHardStop = false;
      log(`Hard stop suppressed by warming window (${ctx.ageSec.toFixed(1)}s < ${warmNoHs}s) for ${ctx.mint.slice(0,4)}…`);
    }
  }

  if (ctx.canHardStop) {
    const ddPct = (Number(ctx.pos.hwmPx || 0) > 0 && ctx.pxNow > 0)
      ? ((ctx.pos.hwmPx - ctx.pxNow) / ctx.pos.hwmPx) * 100
      : 0;
    const gate = computeFinalGateIntensity(ctx.mint);
    ctx.dynStopPct = computeDynamicHardStopPct(ctx.mint, ctx.pos, ctx.nowTs, {
      pnlNetPct: ctx.pnlNetPct,
      drawdownPct: ddPct,
      intensity: Number(gate?.intensity || 1)
    });
  }

  if (ctx.canHardStop &&
      Number.isFinite(ctx.pnlNetPct) && Number.isFinite(ctx.dynStopPct) &&
      ctx.pnlNetPct <= -Math.abs(ctx.dynStopPct)) {
    ctx.decision = { action: "sell_all", reason: `HARD_STOP ${ctx.pnlNetPct.toFixed(2)}%<=-${Math.abs(ctx.dynStopPct).toFixed(2)}%`, hardStop: true };
    ctx.isFastExit = true;
    log(`Dynamic hard stop for ${ctx.mint.slice(0,4)}… netPnL=${ctx.pnlNetPct.toFixed(2)}% thr=-${Math.abs(ctx.dynStopPct).toFixed(2)}% (age ${ctx.ageSec.toFixed(1)}s)`);
  } else if (!ctx.canHardStop) {
    log(`Hard stop suppressed (age ${ctx.ageSec.toFixed(1)}s${ctx.creditsPending ? ", pending credit" : ""}) for ${ctx.mint.slice(0,4)}… netPnL=${ctx.pnlNetPct.toFixed(2)}%`);
  }
}

function profitLockPolicy(ctx) {
  const armAt   = 10;   // % net
  const retain  = 0.55; // keep 55% of peak
  const bepCush = 0.6;  // % net floor above breakeven
  const harvest = 30;   // % to sell on arm

  if (Number.isFinite(ctx.pnlNetPct)) {
    ctx.pos._peakNetPct = Number.isFinite(ctx.pos._peakNetPct)
      ? Math.max(ctx.pos._peakNetPct, ctx.pnlNetPct)
      : ctx.pnlNetPct;
  }

  if (!ctx.pos._lockArmed && Number.isFinite(ctx.pnlNetPct) && ctx.pnlNetPct >= armAt) {
    ctx.pos._lockArmed = true;
    ctx.pos._lockArmedAt = ctx.nowTs;
    ctx.pos._lockFloorNetPct = Math.max(bepCush, (ctx.pos._peakNetPct || ctx.pnlNetPct) * retain);
    save();
    log(`Profit lock armed ${ctx.mint.slice(0,4)}… peak=${(ctx.pos._peakNetPct||ctx.pnlNetPct).toFixed(2)}% floor≈${ctx.pos._lockFloorNetPct.toFixed(2)}%`);

    if ((!ctx.decision || ctx.decision.action === "none") && harvest > 0) {
      ctx.decision = { action: "sell_partial", pct: harvest, reason: `TP PROFIT_LOCK_ARM ${ctx.pnlNetPct.toFixed(2)}%` };
    }
  }

  if (ctx.pos._lockArmed && Number.isFinite(ctx.pnlNetPct)) {
    const peak = Number(ctx.pos._peakNetPct || ctx.pnlNetPct);
    const floor = Math.max(Number(ctx.pos._lockFloorNetPct || 0), bepCush);
    if (peak > floor / Math.max(1e-9, retain)) {
      ctx.pos._lockFloorNetPct = Math.max(floor, peak * retain);
    }
    if ((!ctx.decision || ctx.decision.action === "none") && ctx.pnlNetPct <= Number(ctx.pos._lockFloorNetPct || floor)) {
      ctx.decision = { action: "sell_all", reason: `TP PROFIT_LOCK_STOP floor=${(ctx.pos._lockFloorNetPct||floor).toFixed(2)}%`, hardStop: false };
      log(`Profit lock stop ${ctx.mint.slice(0,4)}… cur=${ctx.pnlNetPct.toFixed(2)}% <= floor=${(ctx.pos._lockFloorNetPct||floor).toFixed(2)}%`);
    }
  }
}

function observerThreePolicy(ctx) {
  if (ctx.forceRug || ctx.forcePumpDrop || ctx.forceObserverDrop) return;
  if (ctx.obsPasses !== 3) return;
  const should = shouldForceSellAtThree(ctx.mint, ctx.pos, ctx.curSol, ctx.nowTs);
  if (should) {
    if (ctx.inSellGuard) {
      log(`Sell guard active; deferring 3/5 observer sell for ${ctx.mint.slice(0,4)}…`);
    } else {
      ctx.forceObserverDrop = true;
      setMintBlacklist(ctx.mint, MINT_RUG_BLACKLIST_MS);
      log(`Observer 3/5 debounced -> forcing sell (${ctx.mint.slice(0,4)}…) and blacklisting 30m.`);
    }
  } else {
    log(`Observer 3/5 for ${ctx.mint.slice(0,4)}… soft-watch; debounce active (no sell).`);
    noteObserverConsider(ctx.mint, 30_000);
  }
}

function fallbackSellPolicy(ctx) {
  ctx.minNotional = minSellNotionalSol();

  if (ctx.isFastExit) return; // skip fallback when fast exit already set

  const canRunFallback =
    !(ctx.warmingHoldActive && !ctx.forceRug && !ctx.forcePumpDrop && !ctx.forceObserverDrop && !ctx.forceExpire);

  if (!canRunFallback) {
    log(`Warming hold active; skipping fallback sell checks for ${ctx.mint.slice(0,4)}…`);
    return;
  }

  let d = null;
  if (ctx.curSol < ctx.minNotional && !ctx.forceExpire && !ctx.forceRug && !ctx.forcePumpDrop && !ctx.forceObserverDrop) {
    d = shouldSell(ctx.pos, ctx.curSolNet, ctx.nowTs);
    const dustMin = Math.max(MIN_SELL_SOL_OUT, Number(state.dustMinSolOut || 0));
    if (!(state.dustExitEnabled && d.action === "sell_all" && ctx.curSol >= dustMin)) {
      log(`Skip sell eval ${ctx.mint.slice(0,4)}… (notional ${ctx.curSol.toFixed(6)} SOL < ${ctx.minNotional})`);
      return { d };
    } else {
      log(`Dust exit enabled for ${ctx.mint.slice(0,4)}… (est ${ctx.curSol.toFixed(6)} SOL >= ${dustMin})`);
    }
  } else if (ctx.curSol < ctx.minNotional && !ctx.forceExpire && (ctx.forceRug || ctx.forcePumpDrop || ctx.forceObserverDrop)) {
    const why = ctx.forceRug ? "Rug" : (ctx.forcePumpDrop ? "Pump->Calm" : "Observer");
    log(`${why} exit for ${ctx.mint.slice(0,4)}… ignoring min-notional (${ctx.curSol.toFixed(6)} SOL < ${ctx.minNotional}).`);
  }
  if (!ctx.decision || ctx.decision.action === "none") {
    ctx.decision = d || shouldSell(ctx.pos, ctx.curSol, ctx.nowTs);
  }
}

function forceFlagDecisionPolicy(ctx) {
  if (ctx.forceRug) {
    ctx.decision = { action: "sell_all", reason: `rug sev=${ctx.rugSev.toFixed(2)}` };
  } else if (ctx.forcePumpDrop) {
    ctx.decision = { action: "sell_all", reason: "pump->calm" };
  } else if (ctx.forceObserverDrop) {
    ctx.decision = { action: "sell_all", reason: ctx.earlyReason || "observer detection system" };
  } else if (ctx.forceExpire && (!ctx.decision || ctx.decision.action === "none")) {
    const inPostWarmGrace = Number(ctx.pos.postWarmGraceUntil || 0) > ctx.nowTs;
    if (!inPostWarmGrace) {
      ctx.decision = { action: "sell_all", reason: `max-hold>${ctx.maxHold}s`, hardStop: true };
      log(`Max-hold reached for ${ctx.mint.slice(0,4)}… forcing sell.`);
    } else {
      log(`Max-hold paused by post-warming grace for ${ctx.mint.slice(0,4)}…).`);
    }
  }
}

function reboundGatePolicy(ctx) {
  ctx.skipSoftGates = !!(ctx.decision?.hardStop) || /HARD_STOP|FAST_/i.test(String(ctx.decision?.reason||""));
  if (!ctx.decision || ctx.decision.action === "none" || ctx.forceRug) return;

  if (ctx.skipSoftGates) return;
  const stillDeferred = Number(ctx.pos.reboundDeferUntil || 0) > ctx.nowTs;
  if (stillDeferred) {
    log(`Rebound gate: deferral active for ${ctx.mint.slice(0,4)}… skipping sell this tick.`);
    ctx.decision = { action: "none", reason: "rebound-deferral" };
    return;
  }

  const wantDefer = shouldDeferSellForRebound(ctx.mint, ctx.pos, ctx.pnlPct, ctx.nowTs, ctx.decision.reason || "");
  if (wantDefer) {
    ctx.decision = { action: "none", reason: "rebound-predict-hold" };
    const waitMs = Math.max(800, Number(state.reboundHoldMs || 4000));
    setTimeout(() => { try { wakeSellEval(); } catch {} }, waitMs);
  } else if (ctx.pos.reboundDeferUntil || ctx.pos.reboundDeferStartedAt) {
    delete ctx.pos.reboundDeferUntil;
    delete ctx.pos.reboundDeferStartedAt;
    delete ctx.pos.reboundDeferCount;
    save();
  }
}

function momentumForcePolicy(ctx) {
  if (!ctx.forceMomentum) return;
  ctx.decision = { action: "sell_all", reason: "MOMENTUM_DROP_X18", hardStop: true };
  log(`Forced sell (momentum x18) for ${ctx.mint.slice(0,4)}…`);
}

async function executeSellDecisionPolicy(ctx) {
  log(`Sell decision: ${ctx.decision && ctx.decision.action !== "none" ? ctx.decision.action : "NO"} (${ctx.decision?.reason || "criteria not met"})`);
  if (!ctx.decision || ctx.decision.action === "none") return { done: false, returned: false };

  const { kp, mint, pos } = ctx;
  const ownerStr = ctx.ownerStr;
  const isFastExit = !!ctx.isFastExit;

  if (ctx.decision.action === "sell_all" && ctx.curSol < ctx.minNotional && !isFastExit) {
    try { addToDustCache(ownerStr, mint, pos.sizeUi, pos.decimals ?? 6); } catch {}
    try { removeFromPosCache(ownerStr, mint); } catch {}
    delete state.positions[mint];
    save();
    log(`Below notional for ${mint.slice(0,4)}… moved to dust (skip sell).`);
    return { done: true, returned: true };
  }

  if (!ctx.forceExpire && window._fdvRouterHold && window._fdvRouterHold.get(mint) > now()) {
    const until = window._fdvRouterHold.get(mint);
    log(`Router cooldown for ${mint.slice(0,4)}… until ${new Date(until).toLocaleTimeString()}`);
    return { done: true, returned: true };
  }

  const postGrace = Number(pos.postWarmGraceUntil || 0);
  if (postGrace && ctx.nowTs < postGrace) {
    ctx.forceExpire = false;
  }

  _inFlight = true;
  lockMint(mint, "sell", Math.max(MINT_OP_LOCK_MS, Number(state.sellCooldownMs||20000)));

  let exitSlip = Math.max(Number(state.slippageBps || 250), Number(state.fastExitSlipBps || 400));
  if (ctx.decision?.hardStop || ctx.forceRug || ctx.forceObserverDrop || ctx.forcePumpDrop) {
    exitSlip = Math.max(exitSlip, 1500); // 15% slip for forced exits
  }
  const exitConfirmMs = isFastExit ? Math.max(6000, Number(state.fastExitConfirmMs || 9000)) : 15000;

  // PARTIAL
  if (ctx.decision.action === "sell_partial") {
    const pct = Math.min(100, Math.max(1, Number(ctx.decision.pct || 50)));
    let sellUi = pos.sizeUi * (pct / 100);
    try {
      const b = await getAtaBalanceUi(kp.publicKey.toBase58(), mint, pos.decimals);
      if (Number(b.sizeUi || 0) > 0) sellUi = Math.min(sellUi, Number(b.sizeUi));
    } catch {}

    const estSol = await quoteOutSol(mint, sellUi, pos.decimals).catch(() => 0);
    if (estSol < ctx.minNotional && !isFastExit) {
      if (ctx.curSol >= ctx.minNotional) {
        log(`Partial ${pct}% ${mint.slice(0,4)}… below min (${estSol.toFixed(6)} SOL < ${ctx.minNotional}). Escalating to full sell …`);
        // escalate to full sell (original code block)
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
          return { done: true, returned: true };
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
          const reason = (ctx.decision && ctx.decision.reason) ? ctx.decision.reason : "done";
          const estFullSol = ctx.curSol > 0 ? ctx.curSol : await quoteOutSol(mint, sellUi2, pos.decimals).catch(()=>0);
          log(`Sold ${sellUi2.toFixed(6)} ${mint.slice(0,4)}… -> ~${estFullSol.toFixed(6)} SOL (${reason})`);
          const costSold = Number(pos.costSol || 0);
          await _addRealizedPnl(estFullSol, costSold, "Full sell PnL");
          try { await closeEmptyTokenAtas(kp, mint); } catch {}
          delete state.positions[mint];
          removeFromPosCache(kp.publicKey.toBase58(), mint);
          try { clearPendingCredit(kp.publicKey.toBase58(), mint); } catch {}
          save();
        }
        state.lastTradeTs = now();
        try { await maybeStealthRotate("sell"); } catch {}
        _inFlight = false;
        unlockMint(mint);
        save();
        return { done: true, returned: true };
      } else {
        log(`Skip partial ${pct}% ${mint.slice(0,4)}… (est ${estSol.toFixed(6)} SOL < ${ctx.minNotional})`);
        _inFlight = false;
        return { done: true, returned: true };
      }
    }

    const res = await executeSwapWithConfirm({
      signer: kp, inputMint: mint, outputMint: SOL_MINT, amountUi: sellUi, slippageBps: exitSlip,
    }, { retries: isFastExit ? 0 : 1, confirmMs: exitConfirmMs });

    if (!res.ok) {
      if (res.noRoute) setRouterHold(mint, ROUTER_COOLDOWN_MS);
      log(`Sell not confirmed for ${mint.slice(0,4)}… (partial). Keeping position.`);
      _inFlight = false;
      unlockMint(mint);
      return { done: true, returned: true };
    }

    log(`Sold ${sellUi.toFixed(6)} ${mint.slice(0,4)}… (${ctx.decision.reason})`);

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

    await _addRealizedPnl(estSol, costSold, "Partial sell PnL");
  } else {
    // FULL SELL (original block)
    let sellUi = pos.sizeUi;
    try {
      const b = await getAtaBalanceUi(kp.publicKey.toBase58(), mint, pos.decimals);
      if (Number(b.sizeUi || 0) > 0) sellUi = Number(b.sizeUi);
    } catch {}

    const res = await executeSwapWithConfirm({
      signer: kp, inputMint: mint, outputMint: SOL_MINT, amountUi: sellUi, slippageBps: exitSlip,
    }, { retries: isFastExit ? 0 : 1, confirmMs: exitConfirmMs });

    if (!res.ok) {
      if (res.noRoute) setRouterHold(mint, ROUTER_COOLDOWN_MS);
      log(`Sell not confirmed for ${mint.slice(0,4)}… Keeping position.`);
      _inFlight = false;
      unlockMint(mint);
      return { done: true, returned: true };
    }

    clearRouteDustFails(mint);

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
      const reason = (ctx.decision && ctx.decision.reason) ? ctx.decision.reason : "done";
      const estFullSol = ctx.curSol > 0 ? ctx.curSol : await quoteOutSol(mint, sellUi, pos.decimals).catch(()=>0);
      log(`Sold ${sellUi.toFixed(6)} ${mint.slice(0,4)}… -> ~${estFullSol.toFixed(6)} SOL (${reason})`);
      const costSold = Number(pos.costSol || 0);
      await _addRealizedPnl(estFullSol, costSold, "Full sell PnL");
      try { await closeEmptyTokenAtas(kp, mint); } catch {}
      delete state.positions[mint];
      removeFromPosCache(kp.publicKey.toBase58(), mint);
      save();
    }
  }

  state.lastTradeTs = now();
  _inFlight = false;
  save();
  return { done: true, returned: true };
}

async function runSellPipelineForPosition(ctx) {
  const pf = await preflightSellPolicy(ctx);
  if (pf.stop) return;

  const lm = leaderModePolicy(ctx);
  if (lm.stop) return;

  urgentSellPolicy(ctx);

  rugPumpDropPolicy(ctx);

  earlyFadePolicy(ctx);

  await observerPolicy(ctx);

  volatilityGuardPolicy(ctx);

  await quoteAndEdgePolicy(ctx);

  fastExitPolicy(ctx);

  dynamicHardStopPolicy(ctx);

  warmingPolicyHook(ctx);

  profitLockPolicy(ctx);

  observerThreePolicy(ctx);

  fallbackSellPolicy(ctx);

  forceFlagDecisionPolicy(ctx);

  reboundGatePolicy(ctx);

  momentumForcePolicy(ctx);

  const exec = await executeSellDecisionPolicy(ctx);
  if (exec?.returned) return;
}

async function evalAndMaybeSellPositions() {
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
        const ctx = _mkSellCtx({ kp, mint, pos, nowTs });
        await runSellPipelineForPosition(ctx);
        return; // one sell per tick (preserve original behavior)
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

// async function evalAndMaybeSellPositions() {
//   if (_inFlight) return;
//   if (_sellEvalRunning) return; 
//   const leaderMode = !!state.holdUntilLeaderSwitch;
//   _sellEvalRunning = true;
//   try {
//     const kp = await getAutoKeypair();
//     if (!kp) return;

//     await syncPositionsFromChain(kp.publicKey.toBase58());
//     await pruneZeroBalancePositions(kp.publicKey.toBase58(), { limit: 8 });
//     const entries = Object.entries(state.positions || {});
//     if (!entries.length) return;

//     const nowTs = now();
//     for (const [mint, pos] of entries) {
//       try {
//         const ageMs = nowTs - Number(pos.lastBuyAt || pos.acquiredAt || 0);
//         const maxHold = Math.max(0, Number(state.maxHoldSecs || 0));
//         const forceExpire = maxHold > 0 && ageMs >= maxHold * 1000;

//         if (!forceExpire && window._fdvRouterHold && window._fdvRouterHold.get(mint) > now()) {
//           const until = window._fdvRouterHold.get(mint);
//           log(`Router cooldown for ${mint.slice(0,4)}… until ${new Date(until).toLocaleTimeString()}`);
//           continue;
//         }

//         const sz = Number(pos.sizeUi || 0);
//         if (sz <= 0) {
//           log(`Skip sell eval for ${mint.slice(0,4)}… (no size)`);
//           continue;
//         }
//         const forceMomentum = shouldForceMomentumExit(mint);

//         const inSellGuard = Number(pos.sellGuardUntil || 0) > nowTs;
//         const ownerStr = kp.publicKey.toBase58();
//         const vr = await verifyRealTokenBalance(ownerStr, mint, pos);
//         if (!vr.ok && vr.purged) {
//           // Phantom removed; skip this mint
//           continue;
//         }
//         // If verification failed (RPC issue), skip to avoid false sells
//         if (!vr.ok) {
//           log(`Sell skip (unverified balance) ${mint.slice(0,4)}…`);
//           continue;
//         }
//         // Replace local size with verified chain size for accurate quoting
//         if (vr.sizeUi <= 1e-9) {
//           // Nothing to sell
//           continue;
//         }
//         const pendKey = _pcKey(ownerStr, mint);
//         const hasPending = !!(_pendingCredits?.has?.(pendKey));
//         const creditGraceMs = Math.max(8_000, Number(state.pendingGraceMs || 20_000));

//         if ((pos.awaitingSizeSync || hasPending) && ageMs < creditGraceMs) {
//           log(`Sell skip ${mint.slice(0,4)}… awaiting credit/size sync (${Math.round(ageMs/1000)}s).`);
//           continue;
//         }
        
//         if (leaderMode) {
//           const sig0 = getRugSignalForMint(mint);
//           if (!(sig0?.rugged) && !forceMomentum) {
//             log(`Leader-hold: holding ${mint.slice(0,4)}… (no rug).`);
//             continue;
//           }
//           if (!sig0?.rugged && forceMomentum) {
//             log(`Leader-hold override: momentum drop x18 for ${mint.slice(0,4)}… forcing sell.`);
//           } else if (sig0?.rugged) {
//             log(`Leader-hold: RUG detected for ${mint.slice(0,4)}… sev=${Number(sig0.sev||0).toFixed(2)}. Forcing sell.`);
//           }
//         }
        
//         let forceRug = false;
//         let rugSev = 0;
//         let forcePumpDrop = false;
//         let forceObserverDrop = false;
//         let obsPasses = null; 
//         const urgent = takeUrgentSell(mint);
//         if (urgent) {
//           if (ageMs < URGENT_SELL_MIN_AGE_MS) {
//             log(`Urgent sell suppressed (warmup ${Math.round(ageMs/1000)}s) for ${mint.slice(0,4)}…`);
//           } else {
//             const isRugUrg = /rug/i.test(String(urgent.reason||""));
//             const highSev = Number(urgent.sev || 0) >= 0.75;
//             if (inSellGuard && !isRugUrg && !highSev) {
//               log(`Sell guard active; deferring urgent sell for ${mint.slice(0,4)}…`);
//             } else {
//               forceObserverDrop = true;
//               rugSev = Number(urgent.sev || 1);
//               log(`Urgent sell for ${mint.slice(0,4)}… (${urgent.reason}); bypassing notional/cooldowns.`);
//             }
//           }
//         }
//         try {
//           const sig = getRugSignalForMint(mint);
//           recordBadgeTransition(mint, sig.badge);

//           const badgeNorm = normBadge(sig.badge);
//           const sev = Number(sig?.sev ?? 0);
//           // const sevThreshold =
//           //   badgeNorm === "warming"
//           //     ? Math.max(0.9, RUG_FORCE_SELL_SEVERITY + 0.30) 
//           //     : RUG_FORCE_SELL_SEVERITY;
//           const sevThreshold = RUG_FORCE_SELL_SEVERITY;

//           if (sig?.rugged && sev >= sevThreshold) {
//             forceRug = true;
//             rugSev = sev;
//             setMintBlacklist(mint, MINT_RUG_BLACKLIST_MS);
//             log(`Rug detected for ${mint.slice(0,4)}… sev=${rugSev.toFixed(2)} (thr=${sevThreshold.toFixed(2)}). Forcing sell and blacklisting 30m.`);
//           } else if (sig?.rugged) {
//             setMintBlacklist(mint);
//             log(`Rug soft-flag for ${mint.slice(0,4)}… sev=${sev.toFixed(2)} < ${sevThreshold.toFixed(2)} — staged blacklist, no forced sell.`);
//           } else if (!leaderMode) {
//             const curNorm = badgeNorm;
//             console.log(`Badge for ${mint.slice(0,4)}…: ${String(sig.badge||"").toLowerCase()} -> ${curNorm}`);
//             if (curNorm === "calm" && isPumpDropBanned(mint)) {
//               forcePumpDrop = true;
//               log(`Pump->Calm drop for ${mint.slice(0,4)}… forcing sell and banning re-buys for 30m.`);
//             }
//           }
//         } catch {}

//         let forceEarlyFade = false;
//         let earlyReason = "";

//         try {
//           const series = getLeaderSeries(mint, 3);
//           const last = series && series.length ? series[series.length - 1] : null;
//           const curChg5m = Number(last?.chg5m || 0);
//           // Clamp score slope to avoid triggering early-exit on noisy near-term spikes
//           const scSlopeMin = _clamp(slope3pm(series || [], "pumpScore"), -20, 20);

//           // maintain consecutive negative score slope counter on position
//           const scNeg = Number(scSlopeMin) <= Math.min(-1, Number(state.earlyExitScSlopeNeg || -10));
//           pos.earlyNegScCount = scNeg ? (Number(pos.earlyNegScCount || 0) + 1) : 0;

//           // chg5m relative drop from entry snapshot
//             const entryChg = Number(pos.entryChg5m || NaN);
//             if (Number.isFinite(entryChg) && entryChg > 0) {
//               const dropFrac = (entryChg - curChg5m) / Math.max(1e-6, entryChg);
//               if (dropFrac >= Math.max(0.30, Number(state.earlyExitChgDropFrac || 0.4))) {
//                 forceEarlyFade = true;
//                 earlyReason = `FAST_FADE chg5m -${(dropFrac*100).toFixed(1)}%`;
//               }
//             }

//           if (!forceEarlyFade) {
//             const needConsec = Math.max(1, Number(state.earlyExitConsec || 2));
//             if (Number(pos.earlyNegScCount || 0) >= needConsec) {
//               forceEarlyFade = true;
//               earlyReason = `FAST_FADE scSlope ${scSlopeMin.toFixed(2)}/m x${pos.earlyNegScCount}`;
//             }
//           }

//           const extended = getLeaderSeries(mint, 5);
//           if (extended && extended.length >= 3) {
//             let changes = 0;
//             for (let i = 2; i < extended.length; i++) {
//               const a = Number(extended[i-2].chg5m || 0);
//               const b = Number(extended[i-1].chg5m || 0);
//               const c = Number(extended[i].chg5m   || 0);
//               const dir1 = Math.sign(b - a);
//               const dir2 = Math.sign(c - b);
//               if (dir1 && dir2 && dir1 !== dir2) changes++;
//             }

//             // Jiggler
//             if (!forceEarlyFade &&
//                 changes >= 2 &&
//                 scSlopeMin > -2) {
//               // Suppress early fade due to short-term alternating moves
//               pos.earlyNegScCount = 0;
//               earlyReason = "";
//               log(`Jiggle hold: ${mint.slice(0,4)}… direction changes=${changes} scSlope=${scSlopeMin.toFixed(2)}/m`);
//             }

//             if (extended.length === 5) {
//               let allDown = true;
//               for (let i = 1; i < extended.length; i++) {
//                 if (!(Number(extended[i].chg5m || 0) < Number(extended[i-1].chg5m || 0))) {
//                   allDown = false; break;
//                 }
//               }
//               if (allDown && scSlopeMin < 0) {
//                 forceEarlyFade = true;
//                 earlyReason = `DOWN_SLOPE_5 scSlope ${scSlopeMin.toFixed(2)}/m`;
//               }
//             }
//           }

//           if (forceEarlyFade) {
//             forceObserverDrop = true; // reuse observer forced-sell path
//             log(`Early-exit: ${mint.slice(0,4)}… ${earlyReason} — overriding warming sell guard.`);
//           }
//         } catch {}

//         if (!leaderMode && !forceRug && !forcePumpDrop) {
//           try {
//             const obs = await observeMintOnce(mint, { windowMs: 2000, sampleMs: 600, minPasses: 4, adjustHold: !!state.dynamicHoldEnabled });
//             if (!obs.ok) {
//               const p = Number(obs.passes || 0);
//               recordObserverPasses(mint, p);
//               const thr = Math.max(0, Number(state.observerDropSellAt ?? 4));

//               // Badge-aware debounce for low observer passes
//               const badgeNow = normBadge(getRugSignalForMint(mint)?.badge);
//               const pumpingish = (badgeNow === "pumping" || badgeNow === "warming");

//               // How many consecutive low passes required before forcing a sell while pumping/warming
//               const needLowConsec = pumpingish ? 2 : 1;
//               const dg = _getDropGuardStore().get(mint) || {};
//               const lowConsec = Number(dg.consecLow || 0);
//               const bypassAt = Math.max(0, Number(1));
//               const hardBypass = (p <= bypassAt);

//               if (p <= 2) {
//                 if (hardBypass) {
//                   forceObserverDrop = true;
//                   setMintBlacklist(mint); // staged and progressive ban
//                   log(`Observer hard drop for ${mint.slice(0,4)}… (${p}/5 <= ${bypassAt}) forcing sell (staged blacklist).`);
//                 }
//                 else if (inSellGuard) {
//                   log(`Sell guard active; suppressing observer drop (${p}/5) for ${mint.slice(0,4)}…`);
//                 } else if (lowConsec < needLowConsec) {
//                   // Debounce: treat as consider while pumping/warming
//                   log(`Observer low-pass ${p}/5 while ${badgeNow}; debounce ${lowConsec}/${needLowConsec}. Holding & watching.`);
//                   noteObserverConsider(mint, 30_000);
//                 } else {
//                   forceObserverDrop = true;
//                   setMintBlacklist(mint); // staged and progressive ban
//                   log(`Observer drop for ${mint.slice(0,4)}… (${p}/5 <= 2) forcing sell (staged blacklist).`);
//                 }
//               } else if (p === 3 && thr >= 3) {
//                 obsPasses = 3;
//               }
//             } else {
//               recordObserverPasses(mint, Number(obs.passes || 5));
//             }
//           } catch {}
//         }

//         {
//           const postBuyCooldownMs = Math.max(8_000, Number(state.coolDownSecsAfterBuy || 0) * 1000);
//           const inWarmingHold = !!(state.rideWarming && pos.warmingHold === true);
//           if (!leaderMode && (inSellGuard || ageMs < postBuyCooldownMs) && (forceObserverDrop || forcePumpDrop) && !inWarmingHold && !forceRug && !forceEarlyFade) {
//             log(`Volatility sell guard active; suppressing observer/pump drop for ${mint.slice(0,4)}…`);
//             forceObserverDrop = false;
//             forcePumpDrop = false;
//           }
//         }

//         let curSol = Number(pos.lastQuotedSol || 0);
//         const lastQ = Number(pos.lastQuotedAt || 0);
//         if (!lastQ || (nowTs - lastQ) > (state.minQuoteIntervalMs|0)) {
//           log(`Evaluating sell for ${mint.slice(0,4)}… size ${sz.toFixed(6)}`);
//           curSol = await quoteOutSol(mint, sz, pos.decimals).catch(() => 0);
//           pos.lastQuotedSol = curSol;
//           pos.lastQuotedAt = nowTs;
//         }

//         try {
//           const prevSol = Number(pos._lastShockSol || 0);
//           const prevAt  = Number(pos._lastShockAt  || 0);
//           if (prevSol > 0 && curSol > 0 && (nowTs - prevAt) <= RUG_QUOTE_SHOCK_WINDOW_MS) {
//             const dropFrac = (prevSol - curSol) / Math.max(prevSol, 1e-12);
//             if (dropFrac >= RUG_QUOTE_SHOCK_FRAC) {
//               log(`RUG quote-shock ${mint.slice(0,4)}… drop=${(dropFrac*100).toFixed(1)}% within ${(nowTs-prevAt)}ms`);
//               flagUrgentSell(mint, "rug_quote_shock", 1.0);
//             }
//           }

//           pos._lastShockSol = curSol;
//           pos._lastShockAt  = nowTs;
//         } catch {}    

//         const outLamports = Math.floor(Math.max(0, curSol) * 1e9);
//         const decIn = Number.isFinite(pos.decimals) ? pos.decimals : 6;
//         const net = estimateNetExitSolFromQuote({
//           mint,
//           amountUi: sz,
//           inDecimals: decIn,
//           quoteOutLamports: outLamports
//         });
//         const curSolNet = net.netSol;

//         if (Number.isFinite(curSol) && Number.isFinite(curSolNet)) {
//           log(`Edge-aware valuation ${mint.slice(0,4)}… raw≈${curSol.toFixed(6)} SOL, net≈${curSolNet.toFixed(6)} SOL${net.feeApplied ? " (fee)" : ""}`);
//         }

//         const pxNow  = sz > 0 ? (curSol / sz) : 0;
//         const pxCost = sz > 0 ? (Number(pos.costSol || 0) / sz) : 0;
//         const pnlPct = (pxNow > 0 && pxCost > 0) ? ((pxNow - pxCost) / pxCost) * 100 : 0;

//         let decision = null;
//         let isFastExit = false;
//         const fast = checkFastExitTriggers(mint, pos, { pnlPct, pxNow, nowTs });
//         if (fast && fast.action !== "none") {
//           decision = { ...fast };
//           isFastExit = true;
//           log(`Fast-exit trigger for ${mint.slice(0,4)}… -> ${decision.action} (${decision.reason}${decision.pct ? ` ${decision.pct}%` : ""})`);
//         }


//         const pxNowNet  = sz > 0 ? (curSolNet / sz) : 0;
//         const pnlNetPct = (pxNowNet > 0 && pxCost > 0) ? ((pxNowNet - pxCost) / pxCost) * 100 : 0;
//         const ageSec = (nowTs - Number(pos.lastBuyAt || pos.acquiredAt || 0)) / 1000;
//         const remorseSecs = Math.max(5, Number(DYN_HS?.remorseSecs ?? 6));
//         const creditsPending = pos.awaitingSizeSync === true || pos._pendingCostAug === true;
//         let canHardStop = ageSec >= remorseSecs && !creditsPending;

//         if (state.rideWarming && pos.warmingHold === true) {
//           const warmNoHs = Math.max(remorseSecs, Number(state.warmingNoHardStopSecs || 35));
//           if (ageSec < warmNoHs) {
//             canHardStop = false;
//             log(`Hard stop suppressed by warming window (${ageSec.toFixed(1)}s < ${warmNoHs}s) for ${mint.slice(0,4)}…`);
//           }
//         }

//         let dynStopPct = null;
//         if (canHardStop) {
//           const ddPct = (Number(pos.hwmPx || 0) > 0 && pxNow > 0)
//             ? ((pos.hwmPx - pxNow) / pos.hwmPx) * 100
//             : 0;
//           const gate = computeFinalGateIntensity(mint);
//           dynStopPct = computeDynamicHardStopPct(mint, pos, nowTs, {
//             pnlNetPct,
//             drawdownPct: ddPct,
//             intensity: Number(gate?.intensity || 1)
//           });
//         }

//         if (canHardStop &&
//             Number.isFinite(pnlNetPct) && Number.isFinite(dynStopPct) &&
//             pnlNetPct <= -Math.abs(dynStopPct)) {
//           decision = { action: "sell_all", reason: `HARD_STOP ${pnlNetPct.toFixed(2)}%<=-${Math.abs(dynStopPct).toFixed(2)}%`, hardStop: true };
//           isFastExit = true;
//           log(`Dynamic hard stop for ${mint.slice(0,4)}… netPnL=${pnlNetPct.toFixed(2)}% thr=-${Math.abs(dynStopPct).toFixed(2)}% (age ${ageSec.toFixed(1)}s)`);
//         } else if (!canHardStop) {
//           log(`Hard stop suppressed (age ${ageSec.toFixed(1)}s${creditsPending ? ", pending credit" : ""}) for ${mint.slice(0,4)}… netPnL=${pnlNetPct.toFixed(2)}%`);
//         }

//         {
//           const res = applyWarmingPolicy({
//             mint, pos, nowTs, pnlPct, curSol,
//             decision,
//             forceRug, forcePumpDrop, forceObserverDrop,
//             forceEarlyFade
//           });
//           decision = res.decision || decision;
//           forceObserverDrop = res.forceObserverDrop;
//           forcePumpDrop = res.forcePumpDrop;

//           if (res.decision?.hardStop && /WARMING_TARGET|warming[-\s]*max[-\s]*loss/i.test(String(res.decision.reason || ""))) {
//             isFastExit = true;
//           }

//           var warmingHoldActive = !!res.warmingHoldActive;
//         }

//         {
//           const armAt   = 10;     // % net
//           const retain  = 0.55;   // keep 55% of peak
//           const bepCush = 0.6;    // % net floor above breakeven
//           const harvest = 30;     // % to sell on arm

//           // update peak net PnL
//           if (Number.isFinite(pnlNetPct)) {
//             pos._peakNetPct = Number.isFinite(pos._peakNetPct)
//               ? Math.max(pos._peakNetPct, pnlNetPct)
//               : pnlNetPct;
//           }

//           // arm when threshold crossed
//           if (!pos._lockArmed && Number.isFinite(pnlNetPct) && pnlNetPct >= armAt) {
//             pos._lockArmed = true;
//             pos._lockArmedAt = nowTs;
//             pos._lockFloorNetPct = Math.max(bepCush, (pos._peakNetPct || pnlNetPct) * retain);
//             save();
//             log(`Profit lock armed ${mint.slice(0,4)}… peak=${(pos._peakNetPct||pnlNetPct).toFixed(2)}% floor≈${pos._lockFloorNetPct.toFixed(2)}%`);

//             // bank a partial on arm if no harder decision chosen yet
//             if ((!decision || decision.action === "none") && harvest > 0) {
//               decision = { action: "sell_partial", pct: harvest, reason: `TP PROFIT_LOCK_ARM ${pnlNetPct.toFixed(2)}%` };
//             }
//           }

//           // enforce floor (never give back more than configured)
//           if (pos._lockArmed && Number.isFinite(pnlNetPct)) {
//             const peak = Number(pos._peakNetPct || pnlNetPct);
//             const floor = Math.max(Number(pos._lockFloorNetPct || 0), bepCush);
//             // refresh floor as peak improves
//             if (peak > floor / Math.max(1e-9, retain)) {
//               pos._lockFloorNetPct = Math.max(floor, peak * retain);
//             }
//             if ((!decision || decision.action === "none") && pnlNetPct <= Number(pos._lockFloorNetPct || floor)) {
//               decision = { action: "sell_all", reason: `TP PROFIT_LOCK_STOP floor=${(pos._lockFloorNetPct||floor).toFixed(2)}%`, hardStop: false };
//               log(`Profit lock stop ${mint.slice(0,4)}… cur=${pnlNetPct.toFixed(2)}% <= floor=${(pos._lockFloorNetPct||floor).toFixed(2)}%`);
//             }
//           }
//         }

//         const skipSoftGates = !!(decision?.hardStop) || /HARD_STOP|FAST_/i.test(String(decision?.reason||""));

//         if (!forceRug && !forcePumpDrop && !forceObserverDrop && obsPasses === 3) {
//           const should = shouldForceSellAtThree(mint, pos, curSol, nowTs);
//           if (should) {
//             if (inSellGuard) {
//               log(`Sell guard active; deferring 3/5 observer sell for ${mint.slice(0,4)}…`);
//             } else {
//               forceObserverDrop = true;
//               setMintBlacklist(mint, MINT_RUG_BLACKLIST_MS);
//               log(`Observer 3/5 debounced -> forcing sell (${mint.slice(0,4)}…) and blacklisting 30m.`);
//             }
//           } else {
//             log(`Observer 3/5 for ${mint.slice(0,4)}… soft-watch; debounce active (no sell).`);
//             noteObserverConsider(mint, 30_000);
//           }
//         }

//         // const baseMinNotional = Math.max(MIN_SELL_SOL_OUT, MIN_JUP_SOL_IN * 1.05);
//         // const minNotional = baseMinNotional;
//         const minNotional = minSellNotionalSol();

//         if (!isFastExit) {
//           const canRunFallback =
//             !(warmingHoldActive && !forceRug && !forcePumpDrop && !forceObserverDrop && !forceExpire);

//           if (canRunFallback) {
//             let d = null;
//             if (curSol < minNotional && !forceExpire && !forceRug && !forcePumpDrop && !forceObserverDrop) {
//               d = shouldSell(pos, curSolNet, nowTs);
//               const dustMin = Math.max(MIN_SELL_SOL_OUT, Number(state.dustMinSolOut || 0));
//               if (!(state.dustExitEnabled && d.action === "sell_all" && curSol >= dustMin)) {
//                 log(`Skip sell eval ${mint.slice(0,4)}… (notional ${curSol.toFixed(6)} SOL < ${minNotional})`);
//                 continue;
//               } else {
//                 log(`Dust exit enabled for ${mint.slice(0,4)}… (est ${curSol.toFixed(6)} SOL >= ${dustMin})`);
//               }
//             } else if (curSol < minNotional && !forceExpire && (forceRug || forcePumpDrop || forceObserverDrop)) {
//               const why = forceRug ? "Rug" : (forcePumpDrop ? "Pump->Calm" : "Observer");
//               log(`${why} exit for ${mint.slice(0,4)}… ignoring min-notional (${curSol.toFixed(6)} SOL < ${minNotional}).`);
//             }
//             if (!decision || decision.action === "none") {
//               decision = d || shouldSell(pos, curSol, nowTs);
//             }
//           } else {
//             log(`Warming hold active; skipping fallback sell checks for ${mint.slice(0,4)}…`);
//           }
//         } else {
//           decision = decision; // already set
//         }



//         if (forceRug) {
//           decision = { action: "sell_all", reason: `rug sev=${rugSev.toFixed(2)}` };
//         } else if (forcePumpDrop) {
//           decision = { action: "sell_all", reason: "pump->calm" };
//         } else if (forceObserverDrop) {
//           decision = { action: "sell_all", reason: earlyReason || "observer detection system" };
//         } else if (forceExpire && (!decision || decision.action === "none")) {
//           const inPostWarmGrace = Number(pos.postWarmGraceUntil || 0) > nowTs;
//           if (!inPostWarmGrace) {
//             decision = { action: "sell_all", reason: `max-hold>${maxHold}s`, hardStop: true };
//             log(`Max-hold reached for ${mint.slice(0,4)}… forcing sell.`);
//           } else {
//             log(`Max-hold paused by post-warming grace for ${mint.slice(0,4)}…).`);
//           }
//         }

//         if (decision && decision.action !== "none" && !forceRug) {
//           if (skipSoftGates) {
//             // hard/fast exits bypass rebound defers
//           } else {
//             const stillDeferred = Number(pos.reboundDeferUntil || 0) > nowTs;
//             if (stillDeferred) {
//               log(`Rebound gate: deferral active for ${mint.slice(0,4)}… skipping sell this tick.`);
//               decision = { action: "none", reason: "rebound-deferral" };
//             } else {
//               const wantDefer = shouldDeferSellForRebound(mint, pos, pnlPct, nowTs, decision.reason || "");
//               if (wantDefer) {
//                 decision = { action: "none", reason: "rebound-predict-hold" };
//                 const waitMs = Math.max(800, Number(state.reboundHoldMs || 4000));
//                 setTimeout(() => { try { wakeSellEval(); } catch {} }, waitMs);
//               } else {
//                 if (pos.reboundDeferUntil || pos.reboundDeferStartedAt) {
//                   delete pos.reboundDeferUntil;
//                   delete pos.reboundDeferStartedAt;
//                   delete pos.reboundDeferCount;
//                   save();
//                 }
//               }
//             }
//           }
//         }

//         if (forceMomentum) {
//           decision = { action: "sell_all", reason: "MOMENTUM_DROP_X18", hardStop: true };
//           log(`Forced sell (momentum x18) for ${mint.slice(0,4)}…`);
//         }


//         log(`Sell decision: ${decision && decision.action !== "none" ? decision.action : "NO"} (${decision?.reason || "criteria not met"})`);
//         if (!decision || decision.action === "none") continue;

//         if (decision.action === "sell_all" && curSol < minNotional && !isFastExit) {
//           try { addToDustCache(ownerStr, mint, pos.sizeUi, pos.decimals ?? 6); } catch {}
//           try { removeFromPosCache(ownerStr, mint); } catch {}
//           delete state.positions[mint];
//           save();
//           log(`Below notional for ${mint.slice(0,4)}… moved to dust (skip sell).`);
//           continue;
//         }  

//         // Jito/router cooldown checks remain (but we already bypassed gating)
//         if (!forceExpire && window._fdvRouterHold && window._fdvRouterHold.get(mint) > now()) {
//           const until = window._fdvRouterHold.get(mint);
//           log(`Router cooldown for ${mint.slice(0,4)}… until ${new Date(until).toLocaleTimeString()}`);
//           continue;
//         }

//         const postGrace = Number(pos.postWarmGraceUntil || 0);
//         if (postGrace && nowTs < postGrace) {
//           forceExpire = false;
//         }

//         _inFlight = true;
//         lockMint(mint, "sell", Math.max(MINT_OP_LOCK_MS, Number(state.sellCooldownMs||20000)));

//         let exitSlip = Math.max(Number(state.slippageBps || 250), Number(state.fastExitSlipBps || 400));

//         if (decision?.hardStop || forceRug || forceObserverDrop || forcePumpDrop) {
//           exitSlip = Math.max(exitSlip, 1500); // 15% slip for forced exits
//         }

//         const exitConfirmMs = isFastExit ? Math.max(6000, Number(state.fastExitConfirmMs || 9000)) : 15000;

//         if (decision.action === "sell_partial") {
//           const pct = Math.min(100, Math.max(1, Number(decision.pct || 50)));
//           let sellUi = pos.sizeUi * (pct / 100);
//           try {
//             const b = await getAtaBalanceUi(kp.publicKey.toBase58(), mint, pos.decimals);
//             if (Number(b.sizeUi || 0) > 0) sellUi = Math.min(sellUi, Number(b.sizeUi));
//           } catch {}

//           const estSol = await quoteOutSol(mint, sellUi, pos.decimals).catch(() => 0);
//           if (estSol < minNotional && !isFastExit) {
//             if (curSol >= minNotional) {
//               log(`Partial ${pct}% ${mint.slice(0,4)}… below min (${estSol.toFixed(6)} SOL < ${minNotional}). Escalating to full sell …`);
//               let sellUi2 = pos.sizeUi;
//               try {
//                 const b = await getAtaBalanceUi(kp.publicKey.toBase58(), mint, pos.decimals);
//                 if (Number(b.sizeUi || 0) > 0) sellUi2 = Number(b.sizeUi);
//               } catch {}

//               const res2 = await executeSwapWithConfirm({
//                 signer: kp, inputMint: mint, outputMint: SOL_MINT, amountUi: sellUi2, slippageBps: state.slippageBps,
//               }, { retries: 1, confirmMs: 15000 });

//               if (!res2.ok) {
//                 if (res2.noRoute) setRouterHold(mint, ROUTER_COOLDOWN_MS);
//                 log(`Sell not confirmed for ${mint.slice(0,4)}… Keeping position.`);
//                 _inFlight = false;
//                 unlockMint(mint);
//                 continue;
//               }

//               const prevSize2 = Number(pos.sizeUi || sellUi2);
//               const debit = await waitForTokenDebit(kp.publicKey.toBase58(), mint, prevSize2, { timeoutMs: 25000, pollMs: 400 });
//               const remainUi2 = Number(debit.remainUi || 0); 

//               if (remainUi2 > 1e-9) {
//                 let chkUi = remainUi2, chkDec = pos.decimals;
//                 try {
//                   const chk = await getAtaBalanceUi(kp.publicKey.toBase58(), mint, pos.decimals);
//                   chkUi = Number(chk.sizeUi || 0);
//                   if (Number.isFinite(chk.decimals)) chkDec = chk.decimals;
//                 } catch {}
//                 if (chkUi <= 1e-9) {
//                   delete state.positions[mint];
//                   removeFromPosCache(kp.publicKey.toBase58(), mint);
//                   try { clearPendingCredit(kp.publicKey.toBase58(), mint); } catch {}
//                 } else {
//                   const estRemainSol = await quoteOutSol(mint, chkUi, chkDec).catch(() => 0);
//                   const minN = minSellNotionalSol();
//                   if (estRemainSol >= minN) {
//                     pos.sizeUi = chkUi;
//                     if (Number.isFinite(chkDec)) pos.decimals = chkDec;
//                     updatePosCache(kp.publicKey.toBase58(), mint, pos.sizeUi, pos.decimals);
//                   } else {
//                     try { addToDustCache(kp.publicKey.toBase58(), mint, chkUi, chkDec ?? 6); } catch {}
//                     try { removeFromPosCache(kp.publicKey.toBase58(), mint); } catch {}
//                     delete state.positions[mint];
//                     save();
//                     log(`Leftover below notional for ${mint.slice(0,4)}… moved to dust cache.`);
//                   }
//                 }
//               } else {
//                 const reason = (decision && decision.reason) ? decision.reason : "done";
//                 const estFullSol = curSol > 0 ? curSol : await quoteOutSol(mint, sellUi2, pos.decimals).catch(()=>0);
//                 log(`Sold ${sellUi2.toFixed(6)} ${mint.slice(0,4)}… -> ~${estFullSol.toFixed(6)} SOL (${reason})`);
//                 const costSold = Number(pos.costSol || 0);
//                 await _addRealizedPnl(estFullSol, costSold, "Full sell PnL");
//                 try { await closeEmptyTokenAtas(kp, mint); } catch {}
//                 delete state.positions[mint];
//                 removeFromPosCache(kp.publicKey.toBase58(), mint);
//                 try { clearPendingCredit(kp.publicKey.toBase58(), mint); } catch {}
//                 save();
//               }
//               state.lastTradeTs = now();
//               try { await maybeStealthRotate("sell"); } catch {}
//               _inFlight = false;
//               unlockMint(mint);
//               save();
//               return; // one sell per tick
//             } else {
//               log(`Skip partial ${pct}% ${mint.slice(0,4)}… (est ${estSol.toFixed(6)} SOL < ${minNotional})`);
//               _inFlight = false;
//               continue;
//             }
//           }

//           const res = await executeSwapWithConfirm({
//             signer: kp, inputMint: mint, outputMint: SOL_MINT, amountUi: sellUi, slippageBps: exitSlip,
//           }, { retries: isFastExit ? 0 : 1, confirmMs: exitConfirmMs });

//           if (!res.ok) {
//             if (res.noRoute) setRouterHold(mint, ROUTER_COOLDOWN_MS);
//             log(`Sell not confirmed for ${mint.slice(0,4)}… (partial). Keeping position.`);
//             _inFlight = false;
//             unlockMint(mint);
//             continue;
//           }

//           log(`Sold ${sellUi.toFixed(6)} ${mint.slice(0,4)}… (${decision.reason})`);
   
//           // Proportional cost basis for partial exits
//           const prevCostSol = Number(pos.costSol || 0);
//           const costSold = prevCostSol * (pct / 100);
//           const remainPct = 1 - (pct / 100);
//           pos.sizeUi = Math.max(0, pos.sizeUi - sellUi);
//           pos.costSol = Number(pos.costSol || 0) * remainPct;
//           pos.hwmSol = Number(pos.hwmSol || 0) * remainPct;
//           pos.hwmPx = Number(pos.hwmPx || 0);
//           pos.lastSellAt = now();
//           pos.allowRebuy = true;
//           pos.lastSplitSellAt = now();

//           try {
//             const debit = await waitForTokenDebit(kp.publicKey.toBase58(), mint, sellUi, { timeoutMs: 20000, pollMs: 350 });
//             const remainUi = Number(debit.remainUi || pos.sizeUi || 0);
//             if (remainUi > 1e-9) {
//               const estRemainSol = await quoteOutSol(mint, remainUi, pos.decimals).catch(() => 0);
//               const minN = minSellNotionalSol();
//               if (estRemainSol >= minN) {
//                 pos.sizeUi = remainUi;
//                 if (Number.isFinite(debit.decimals)) pos.decimals = debit.decimals;
//                 updatePosCache(kp.publicKey.toBase64 ? kp.publicKey.toBase64() : kp.publicKey.toBase58(), mint, pos.sizeUi, pos.decimals);
//                 updatePosCache(kp.publicKey.toBase58(), mint, pos.sizeUi, pos.decimals);
//               } else {
//                 try { addToDustCache(kp.publicKey.toBase58(), mint, remainUi, pos.decimals ?? 6); } catch {}
//                 try { removeFromPosCache(kp.publicKey.toBase58(), mint); } catch {}
//                 try { clearPendingCredit(kp.publicKey.toBase58(), mint); } catch {}
//                 delete state.positions[mint];
//                 save();
//                 log(`Leftover below notional for ${mint.slice(0,4)}… moved to dust cache.`);
//               }
//             } else {
//               // fully gone
//               delete state.positions[mint];
//               removeFromPosCache(kp.publicKey.toBase58(), mint);
//               try { clearPendingCredit(kp.publicKey.toBase58(), mint); } catch {}
//             }
//           } catch {
//             updatePosCache(kp.publicKey.toBase58(), mint, pos.sizeUi, pos.decimals);
//           }
//           save();

//           await _addRealizedPnl(estSol, costSold, "Partial sell PnL");
//         } else {
//           // Full sell
//           let sellUi = pos.sizeUi;
//           try {
//             const b = await getAtaBalanceUi(kp.publicKey.toBase58(), mint, pos.decimals);
//             if (Number(b.sizeUi || 0) > 0) sellUi = Number(b.sizeUi);
//           } catch {}

//           const res = await executeSwapWithConfirm({
//             signer: kp, inputMint: mint, outputMint: SOL_MINT, amountUi: sellUi, slippageBps: exitSlip,
//           }, { retries: isFastExit ? 0 : 1, confirmMs: exitConfirmMs });

//           if (!res.ok) {
//             if (res.noRoute) setRouterHold(mint, ROUTER_COOLDOWN_MS);
//             log(`Sell not confirmed for ${mint.slice(0,4)}… Keeping position.`);
//             _inFlight = false;
//             unlockMint(mint);
//             continue;
//           }

//           clearRouteDustFails(mint);

//           const prevSize = Number(pos.sizeUi || sellUi);
//           const debit = await waitForTokenDebit(kp.publicKey.toBase58(), mint, prevSize, { timeoutMs: 25000, pollMs: 400 });
//           const remainUi = Number(debit.remainUi || 0);
//           if (remainUi > 1e-9) {
//             const estRemainSol = await quoteOutSol(mint, remainUi, pos.decimals).catch(() => 0);
//             const minN = minSellNotionalSol();
//             if (estRemainSol >= minN) {
//               const frac = Math.min(1, Math.max(0, remainUi / Math.max(1e-9, prevSize)));
//               pos.sizeUi = remainUi;
//               pos.costSol = Number(pos.costSol || 0) * frac;
//               pos.hwmSol  = Number(pos.hwmSol  || 0) * frac;
//               pos.lastSellAt = now();
//               updatePosCache(kp.publicKey.toBase58(), mint, pos.sizeUi, pos.decimals);
//               save();
//               setRouterHold(mint, ROUTER_COOLDOWN_MS);
//               log(`Post-sell balance remains ${remainUi.toFixed(6)} ${mint.slice(0,4)}… (keeping position; router cooldown applied)`);
//             } else {
//               try { addToDustCache(kp.publicKey.toBase58(), mint, remainUi, pos.decimals ?? 6); } catch {}
//               try { removeFromPosCache(kp.publicKey.toBase58(), mint); } catch {}
//               delete state.positions[mint];
//               save();
//               log(`Leftover below notional for ${mint.slice(0,4)}… moved to dust cache.`);
//             }
//           } else {
//             const reason = (decision && decision.reason) ? decision.reason : "done";
//             const estFullSol = curSol > 0 ? curSol : await quoteOutSol(mint, sellUi, pos.decimals).catch(()=>0);
//             log(`Sold ${sellUi.toFixed(6)} ${mint.slice(0,4)}… -> ~${estFullSol.toFixed(6)} SOL (${reason})`);
//             const costSold = Number(pos.costSol || 0);
//             await _addRealizedPnl(estFullSol, costSold, "Full sell PnL");
//             try { await closeEmptyTokenAtas(kp, mint); } catch {}
//             delete state.positions[mint];
//             removeFromPosCache(kp.publicKey.toBase58(), mint);
//             save();
//           }
//         }

//         state.lastTradeTs = now();
//         _inFlight = false;
//         save();
//         return; // one sell per tick
//       } catch (e) {
//         log(`Sell check failed for ${mint.slice(0,4)}…: ${e.message||e}`);
//       } finally {
//         _inFlight = false;
//       }
//     }
//   } finally {
//     _sellEvalRunning = false;
//   }
// }

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
        await _addRealizedPnl(estSol, costSold, "Rotation PnL");
        try { await closeEmptyTokenAtas(kp, mint); } catch {}
        delete state.positions[mint];
        removeFromPosCache(owner, mint);
        save();
        rotated++;
      } catch (e) {
        log(`Rotate sell failed ${mint.slice(0,4)}…: ${e.message || e}`);
        const msg = String(e?.message || e || "");
        if (/invalid public key/i.test(msg) || /INVALID_MINT/i.test(msg)) {
          try { removeFromPosCache(kp.publicKey.toBase58(), mint); } catch {}
          try { if (state.positions[mint]) { delete state.positions[mint]; save(); } } catch {}
          log(`Pruned invalid mint during rotation: ${mint.slice(0,4)}…`);
        }
      }
    }
    log(`Rotation complete. Sold ${rotated} token${rotated===1?"":"s"}.`);
    state.currentLeaderMint = newMint;
    save();
    if (rotated > 0) {
      state.lastTradeTs = now();

      try { await maybeStealthRotate("rotate"); } catch {}
      save();
      return true;
    }
    return false;
  } finally {
    _switchingLeader = false;
  }
}

async function tick() {
  // const endIn = state.endAt ? ((state.endAt - now())/1000).toFixed(0) : "0";
  if (!state.enabled) return;

  if (rpcBackoffLeft() > 0) {
    log("RPC backoff active; skipping tick.");
    return;
  }

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
  try { await runFinalPumpGateBackground(); } catch {}
  try {
    const held = Object.keys(state.positions || {}).filter(m => m && m !== SOL_MINT);
    for (const m of held) {
      await focusMintAndRecord(m, { refresh: true, ttlMs: 2000 }).catch(()=>{});
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
    if (!_lastDepFetchTs || (now() - _lastDepFetchTs) > 5000) {
      _lastDepFetchTs = now();
      fetchSolBalance(state.autoWalletPub).then(b => { depBalEl.value = `${b.toFixed(4)} SOL`; }).catch(()=>{});
    }
  }

  try { await processPendingCredits(); } catch {}

  try {
    const kpTmp = await getAutoKeypair();
    if (kpTmp && (_pendingCredits?.size > 0)) {
      await reconcileFromOwnerScan(kpTmp.publicKey.toBase58());
    }
  } catch {}

  try { await evalAndMaybeSellPositions(); } catch {}

  try { updateStatsHeader(); } catch {}

  log("Follow us on twitter: https://twitter.com/fdvlol for updates and announcements!", "info");

  if (_buyInFlight || _inFlight || _switchingLeader) return;

  if (window._fdvJupStressUntil && now() < window._fdvJupStressUntil) {
    const left = Math.ceil((window._fdvJupStressUntil - now()) / 1000);
    log(`Backoff active (${left}s); pausing new buys.`);
    return;
  }

  const leaderMode = !!state.holdUntilLeaderSwitch;
  let picks = [];
  if (leaderMode) {
    // Simple mode: always take the top KPI leader
    const leadersTop = computePumpingLeaders(1) || [];
    const top = leadersTop[0]?.mint || "";
    if (top && !isMintBlacklisted(top) && !isPumpDropBanned(top)) picks = [top];
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
    if (solBal < 0.05) {
      log(`SOL low (${solBal.toFixed(4)}); skipping new buys to avoid router dust.`);
      return;
    }
    const ceiling = await computeSpendCeiling(kp.publicKey.toBase58(), { solBalHint: solBal });

    const desired      = Math.min(state.maxBuySol, Math.max(state.minBuySol, solBal * state.buyPct));
    const minThreshold = Math.max(state.minBuySol, MIN_SELL_SOL_OUT);
    let plannedTotal   = Math.min(ceiling.spendableSol, Math.min(state.maxBuySol, desired));


    logObj("Buy sizing (pre-split)", {
      solBal: Number(solBal).toFixed(6),
      spendable: Number(ceiling.spendableSol).toFixed(6),
      posCount: ceiling.reserves.posCount,
      reservesSol: (ceiling.reserves.totalResLamports/1e9).toFixed(6),
      minThreshold
    });


    let buyCandidates = picks.filter(m => {
      const pos = state.positions[m];
      const allowRebuy = !!pos?.allowRebuy;
      const eligibleSize = allowRebuy || Number(pos?.sizeUi || 0) <= 0;
      const notPending = !pos?.awaitingSizeSync;
      const notLocked  = !isMintLocked(m);
      return eligibleSize && notPending && notLocked;
    });

    if (!state.allowMultiBuy && buyCandidates.length > 1) {
      buyCandidates = buyCandidates.slice(0, 1);
    }



    if (!buyCandidates.length) { log("All picks already held or pending. Skipping buys."); return; }

    if (plannedTotal < minThreshold) {
      // state.carrySol += desired;
      const carryPrev = Math.max(0, Number(state.carrySol || 0));
      state.carrySol = Math.min(Number(state.maxBuySol || 0.05), carryPrev + Number(desired || 0));
      save();
      log(`Accumulating. Carry=${state.carrySol.toFixed(6)} SOL (< ${minThreshold} min or spend ceiling).`);
      return;
    }

    _buyInFlight = true;

    let remainingLamports = Math.floor(ceiling.spendableSol * 1e9);
    let remaining = remainingLamports / 1e9;
    let spent = 0;
    let buysDone = 0;

    let loopN = leaderMode ? 1 : (state.allowMultiBuy ? buyCandidates.length : 1);

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
      {
        const existing = state.positions[mint];
        if (existing && existing.awaitingSizeSync) {
          log(`Skip buy: awaiting size sync for ${mint.slice(0,4)}…`);
          continue;
        }
        const recentAgeMs = existing ? (now() - Number(existing.lastBuyAt || existing.acquiredAt || 0)) : Infinity;
        const minRebuyMs = Math.max(8_000, Number(state.coolDownSecsAfterBuy || 8) * 1000);
        if (recentAgeMs < minRebuyMs) {
          log(`Skip buy: cooldown (${(recentAgeMs/1000).toFixed(1)}s < ${(minRebuyMs/1000)|0}s) for ${mint.slice(0,4)}…`);
          continue;
        }
      }
      // Final uncoditional check?
      try { ensureFinalPumpGateTracking(mint); } catch {}
      if (!isFinalPumpGateReady(mint)) {
        log(`Final gate: not ready to buy ${mint.slice(0,4)}… waiting for pump score up Δ.`, 'warn');
        continue;
      }

      if (state.allowMultiBuy && mint !== picks[0]) {
        try {
          const wMs = Math.max(1800, Math.floor((state.tickMs || 2000) * 0.9));
          const sMs = Math.max(450, Math.floor((state.tickMs || 2000) / 3.5));
          const obs = await observeMintOnce(mint, {
            windowMs: wMs,
            sampleMs: sMs,
            minPasses: 4,
            adjustHold: !!state.dynamicHoldEnabled
          });
          if (!obs.canBuy) {
            log(`Observer gate: ${obs.reason || "conditions not met"} for ${mint.slice(0,4)}… Skipping buy.`);
            continue;
          }
        } catch {
          log(`Observer gate failed for ${mint.slice(0,4)}… Skipping buy.`);
          continue;
        }
      }

      // const left = Math.max(1, loopN - i);
      const target = Math.min(plannedTotal, remaining);

      try {
        const leadersNow = computePumpingLeaders(3) || [];
        const itNow = leadersNow.find(x => x?.mint === mint);
        if (itNow) {
          const kpNow = itNow.kp || {};
          const metaNow = itNow.meta || {};
          const warm = detectWarmingUptick({ kp: { ...kpNow, mint }, meta: metaNow }, state);
          const series = getLeaderSeries(mint, 3);
          const scSlopeMin = slope3pm(series || [], "pumpScore");
          const chgSlopeMin = slope3pm(series || [], "chg5m");
          // const chgSlopeMin = slope3pm(series || [], "change5m");

          // Reproduce score weights to measure c5 dominance
          const chg5m = safeNum(kpNow.change5m, 0);
          const chg1h = safeNum(kpNow.change1h, 0);
          const liq   = safeNum(kpNow.liqUsd,   0);
          const v1h   = safeNum(kpNow.v1hTotal, 0);
          const accel5to1 = safeNum(metaNow.accel5to1, 1);
          const risingNow = !!metaNow.risingNow;
          const trendUp   = !!metaNow.trendUp;

          const c5 = Math.max(0, chg5m);
          const c1 = Math.log1p(Math.max(0, chg1h));
          const exp5m = Math.max(0, chg1h) / 12;
          const accelRatio = exp5m > 0 ? (c5 / exp5m) : (c5 > 0 ? 1.2 : 0);
          const lLiq = Math.log1p(liq / 5000);
          const lVol = Math.log1p(v1h / 1000);
          const w = {
            c5: 0.32 * c5,
            c1: 0.16 * c1,
            lVol: 0.18 * lVol,
            lLiq: 0.10 * lLiq,
            accelRatio: 0.10 * Math.max(0, accelRatio - 0.8),
            accel5to1: 0.10 * Math.max(0, accel5to1 - 1),
            flags: (risingNow && trendUp ? 0.02 : 0),
            pScore: 0.02 * safeNum(itNow.pumpScore, 0),
          };
          const sumW = w.c5 + w.c1 + w.lVol + w.lLiq + w.accelRatio + w.accel5to1 + w.flags + w.pScore;
          const c5Share = sumW > 0 ? (w.c5 / sumW) : 0;
          const barelyPasses = Number(warm.pre || 0) < (Number(warm.preMin || 0) + Math.max(0.005, Number(state.lateEntryMinPreMargin || 0.02)));

          // if (c5Share >= Math.max(0.5, Number(state.lateEntryDomShare || 0.6)) && barelyPasses && !(scSlopeMin > 0)) {
          //   log(`Exhaust spike filter: skip ${mint.slice(0,4)}… (c5 ${Math.round(c5Share*100)}% of score, pre ${warm.pre.toFixed(3)} ~ min ${warm.preMin.toFixed(3)}, scSlope=${scSlopeMin.toFixed(2)}/m ≤ 0)`);
          //   continue;
          // }

          // if (!((scSlopeMin > 0 && chgSlopeMin > 0) || metaNow.risingNow === true)) {
          //   log(`Entry slopes not healthy; skip ${mint.slice(0,4)}… (scSlope=${scSlopeMin.toFixed(2)}/m, chgSlope=${chgSlopeMin.toFixed(2)}/m, risingNow=${!!metaNow.risingNow})`);
          //   continue;
          // }

          // TODO: price impact proxy?
          // try {
          //   const solPx = await getSolUsd();
          //   const liq = Number(kpNow.liqUsd || 0);
          //   if (solPx > 0 && liq > 0) {
          //     const buyUsd = buySol * solPx;
          //     const imp = buyUsd / liq; // ≈ price impact proxy
          //     if (imp > 0.008) {
          //       log(`Impact gate: skip ${mint.slice(0,4)}… est impact ${(imp*100).toFixed(2)}% > 0.80% (buy≈${fmtUsd(buyUsd)}, liq≈${fmtUsd(liq)})`);
          //       continue;
          //     }
          //   }
          // } catch {}

          const needTicks = Math.max(1, Number(state.sustainTicksMin || 2));
          const needChg = Math.max(0, Number(state.sustainChgSlopeMin || 6));
          const needSc  = Math.max(0, Number(state.sustainScSlopeMin  || 3));
          const series5 = getLeaderSeries(mint, 5);
          const okTicks = countConsecUp(series5, "pumpScore") >= needTicks && countConsecUp(series5, "chg5m") >= needTicks;
          const okSlopes = (scSlopeMin >= needSc) && (chgSlopeMin >= needChg);
          const c5DomThr = Math.max(0.6, Number(state.lateEntryDomShare || 0.65));

          if (c5Share >= c5DomThr && barelyPasses && !(scSlopeMin > -1 || okTicks)) {
            log(`Exhaust spike filter: skip ${mint.slice(0,4)}… (c5 ${Math.round(c5Share*100)}% of score, pre ${warm.pre.toFixed(3)} ~ min ${warm.preMin.toFixed(3)}, scSlope=${scSlopeMin.toFixed(2)}/m ≤ 0)`);
            continue;
          }
          const needBoth = (!risingNow && !trendUp);
          if (needBoth && !(okTicks && okSlopes)) {
            log(`Sustain gate (strict): skip ${mint.slice(0,4)}… (ticks=${okTicks} slopes=${okSlopes})`);
            continue;
          }
          if (!needBoth && (!risingNow || !trendUp) && !(okTicks || okSlopes)) {
            log(`Sustain gate (lenient): skip ${mint.slice(0,4)}… (need ticks OR slopes; rNow=${risingNow} tUp=${trendUp})`);
            continue;
          }


        }
      } catch {}

      const reqRent = await requiredAtaLamportsForSwap(kp.publicKey.toBase58(), SOL_MINT, mint);
      if (reqRent > 0 && solBal < AVOID_NEW_ATA_SOL_FLOOR) {
        log(`Skipping ${mint.slice(0,4)}… (SOL ${solBal.toFixed(4)} < ${AVOID_NEW_ATA_SOL_FLOOR}, would open new ATA). Try adding more SOL`);
        continue;
      }
      const candidateBudgetLamports = Math.max(0, remainingLamports - reqRent - TX_FEE_BUFFER_LAMPORTS);
      const targetLamports = Math.floor(target * 1e9);
      let buyLamports = Math.min(targetLamports, Math.floor(remaining * 1e9), candidateBudgetLamports);

      const minInLamports = Math.floor(MIN_JUP_SOL_IN * 1e9);

      // const rentMinBuyLamports = reqRent > 0 ? Math.ceil(reqRent / 0.01) : 0;

      //const minPerOrderLamports = Math.max(minInLamports, Math.floor(minThreshold * 1e9));
      let minPerOrderLamports = Math.max(minInLamports, Math.floor(minThreshold * 1e9));
      try {
        const recurringL   = EDGE_TX_FEE_ESTIMATE_LAMPORTS;
        const oneTimeL     = Math.max(0, reqRent);
        const needByRecurr = Math.ceil(recurringL / Math.max(1e-12, MAX_RECURRING_COST_FRAC));
        const needByOne    = Math.ceil(
          oneTimeL / Math.max(1e-12, MAX_ONETIME_COST_FRAC * Math.max(1, ONE_TIME_COST_AMORTIZE))
        );
        const needByFrictionSplit = Math.max(needByRecurr, needByOne);
        minPerOrderLamports = Math.max(minPerOrderLamports, needByFrictionSplit);
      } catch {}
      if (reqRent > 0) {
        const elevatedL = Math.floor(ELEVATED_MIN_BUY_SOL * 1e9);
        minPerOrderLamports = Math.max(minPerOrderLamports, elevatedL);
      }

      if (buyLamports < minPerOrderLamports) {
        const fricMinSol = minPerOrderLamports / 1e9;
        const orderSol   = buyLamports / 1e9;
        const gap        = fricMinSol - orderSol;
        const eps        = 1e-6;
        const snapNear   = orderSol >= (fricMinSol - (state.fricSnapEpsSol + eps));
        const snapBand   = gap <= (Math.max(0.003, 0.06 * fricMinSol) + eps);
        const canCover   = candidateBudgetLamports >= minPerOrderLamports;

        if ((snapNear || snapBand) && canCover) {
          buyLamports = minPerOrderLamports;
          log(`Snap-to-min: bump ${orderSol.toFixed(6)} -> ${fricMinSol.toFixed(6)} SOL to clear friction min.`);
        } else {
          if (reqRent > 0) {
            log(
              `Skip ${mint.slice(0,4)}… (order ${orderSol.toFixed(6)} SOL < friction-aware min ${fricMinSol.toFixed(6)}; ` +
              `split guard rec=${(EDGE_TX_FEE_ESTIMATE_LAMPORTS/1e9).toFixed(6)} oneTime≈${(reqRent/1e9).toFixed(6)} amortN=${ONE_TIME_COST_AMORTIZE}).`
            );
          } else {
            log(`Skip ${mint.slice(0,4)}… (order ${orderSol.toFixed(6)} SOL < friction-aware min ${fricMinSol.toFixed(6)}; recurring-only guard).`);
          }
          continue;
        }
      }

      const buySol = buyLamports / 1e9;

      try {
        const edge = await estimateRoundtripEdgePct(
          kp.publicKey.toBase58(),
          mint,
          buySol,
          { slippageBps: state.slippageBps, dynamicFee: true }
        );
        // let needPct = Number.isFinite(Number(state.minNetEdgePct)) ? Number(state.minNetEdgePct) : -8;
        // try {
        //   const badgeNow = normBadge(getRugSignalForMint(mint)?.badge);
        //   if (badgeNow === "pumping") needPct = needPct - 2.0; // allow a bit more friction on live pumps
        //   if (badgeNow === "warming") {
        //     const minEx = Math.max(0, Number(state.warmingEdgeMinExclPct ?? 0));
        //     if (!edge) { log(`Skip ${mint.slice(0,4)}… (no round-trip quote)`); continue; }
        //     if (Number(edge.pctNoOnetime) < minEx) {
        //       log(`Skip ${mint.slice(0,4)}… warming edge excl-ATA ${Number(edge.pctNoOnetime).toFixed(2)}% < ${minEx}%`);
        //       continue;
        //     }
        //   }
        // } catch {}
        const badgeNow = normBadge(getRugSignalForMint(mint)?.badge);
        if (!edge) { log(`Skip ${mint.slice(0,4)}… (no round-trip quote)`); continue; }

        // const hasOnetime = Number(edge.ataRentLamports || 0) > 0;
        // const incl = Number(edge.pct);          // includes one-time ATA rent
        const excl = Number(edge.pctNoOnetime); // excludes one-time ATA rent
        const pumping = (badgeNow === "pumping");

        const baseUser = Number.isFinite(state.minNetEdgePct) ? state.minNetEdgePct : -4;
        const warmOverride = state.warmingEdgeMinExclPct;
        const hasWarmOverride = typeof warmOverride === "number" && Number.isFinite(warmOverride);
        const warmUser = hasWarmOverride ? warmOverride : baseUser;
        const buffer   = Math.max(0, Number(state.edgeSafetyBufferPct || 0.1));

        const needExcl = pumping
          ? (baseUser - 2.0)
          : (badgeNow === "warming" ? warmUser : baseUser);

        const baseNeed = needExcl;
        const needWithBuf = baseNeed + buffer;

        const curEdge = excl;

        try {
          const fwdLen = Number(edge?.forward?.routePlan?.length || edge?.forward?.routePlanLen || 0);
          const backLen= Number(edge?.backward?.routePlan?.length || edge?.backward?.routePlanLen || 0);
          const feeBps = Number(edge?.platformBpsApplied || 0);
          const fricSolRec = Number(edge.recurringLamports || 0) / 1e9; // recurring only
          const fricPct = buySol > 0 ? (fricSolRec / buySol) * 100 : 0;
          const ataSol = Number(edge.ataRentLamports || 0) / 1e9;
          const mode    = "excl-ATA";
          log(
            `Edge gate ${mint.slice(0,4)}… mode=${mode} (ATA rent excluded; refundable); ` +
            `curEdge=${curEdge.toFixed(2)}% need=${baseNeed.toFixed(2)}% buf=${buffer.toFixed(2)}% thr=${needWithBuf.toFixed(2)}%; ` +
            `fee=${feeBps}bps, routes fwd=${fwdLen} back=${backLen}, ` +
            `friction≈${fricSolRec.toFixed(6)} SOL (${fricPct.toFixed(2)}% of buy ${buySol.toFixed(6)} SOL), ataRent≈${ataSol.toFixed(6)} SOL`
          );
        } catch {}

        const pass = Number.isFinite(curEdge) && (curEdge >= needWithBuf);

        if (!pass) {
          const srcStr  = (badgeNow === "warming" && hasWarmOverride) ? " (warming override)" : "";
          log(
            `Skip ${mint.slice(0,4)}… net edge ${curEdge.toFixed(2)}% < ${needWithBuf.toFixed(2)}% ` +
            `(need=${baseNeed.toFixed(2)}% + buffer=${buffer.toFixed(2)}% => thr=${needWithBuf.toFixed(2)}%; mode=excl-ATA)${srcStr}`
          );
          continue;
        }

        log(
          `Edge OK ${mint.slice(0,4)}… net≈${curEdge.toFixed(2)}% (thr ${needWithBuf.toFixed(2)}%,` +
          ` excl-ATA=${excl.toFixed(2)}%)`
        );
      } catch {
        log(`Skip ${mint.slice(0,4)}… (edge calc failed)`);
        continue;
      }

      const ownerStr = kp.publicKey.toBase58();
      const prevPos  = state.positions[mint];
      const basePos  = prevPos || { costSol: 0, hwmSol: 0, acquiredAt: now() };

      let dynSlip = Math.max(150, Number(state.slippageBps || 150));
      try {
        const leadersNow = computePumpingLeaders(3) || [];
        const itNow = leadersNow.find(x => x?.mint === mint);
        const kpNow = itNow?.kp || {};
        const solPx = await getSolUsd();
        const liq = Number(kpNow.liqUsd || 0);
        if (solPx > 0 && liq > 0) {
          const imp = Math.max(0, Math.min(0.01, (buySol * solPx) / liq)); // cap at 1%
          dynSlip = Math.min(600, Math.max(150, Math.floor(10000 * imp * 1.2)));
        }
      } catch {}

      const res = await executeSwapWithConfirm({
        signer: kp,
        inputMint: SOL_MINT,
        outputMint: mint,
        amountUi: buySol,
        slippageBps: dynSlip,
      }, { retries: 2, confirmMs: 15000 });

      if (!res.ok) {
        try {
          const seed = getBuySeed(ownerStr, mint);
          if (seed && Number(seed.sizeUi || 0) > 0) {
            optimisticSeedBuy(ownerStr, mint, Number(seed.sizeUi), Number(seed.decimals), buySol, res.sig || "");
            clearBuySeed(ownerStr, mint);
            log(`Buy unconfirmed for ${mint.slice(0,4)}… seeded pending credit watch.`);
            } else {

            if (res.sig) {
              enqueuePendingCredit({
                owner: ownerStr,
                mint,
                addCostSol: buySol,
                decimalsHint: basePos.decimals,
                basePos: { ...basePos, awaitingSizeSync: true },
                sig: res.sig
              });
              log(`Buy not confirmed for ${mint.slice(0,4)}… enqueued tx-meta reconciliation.`);
            } else {
              log(`Buy not confirmed for ${mint.slice(0,4)}… skipping accounting.`);
            }
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

      if (Number(got.sizeUi || 0) === 0) {
        const prevPos = state.positions[mint];
        if (prevPos) prevPos._pendingCostAug = true;
      } else {
        const prevPos = state.positions[mint];
        if (prevPos && prevPos._pendingCostAug) delete prevPos._pendingCostAug;
      }

      if (Number(got.sizeUi || 0) > 0) {
        const badgeNow = normBadge(getRugSignalForMint(mint)?.badge);
        const warmingHold = !!(state.rideWarming && (badgeNow === "warming" || badgeNow === "pumping"));
        const guardMs = Math.max(10_000, Number(state.observerGraceSecs || 0) * 1000);
        let entryChg5m = 0, entryPre = NaN, entryPreMin = NaN, entryScSlope = NaN;
        try {
          const leadersNow = computePumpingLeaders(3) || [];
          const itNow = leadersNow.find(x => x?.mint === mint);
          const kpNow = itNow?.kp || {};
          const metaNow = itNow?.meta || {};
          const warm = detectWarmingUptick({ kp: { ...kpNow, mint }, meta: metaNow }, state);
          const series = getLeaderSeries(mint, 3);
          entryChg5m = Number(series?.[series.length - 1]?.chg5m || kpNow.change5m || 0);
          entryPre = Number(warm?.pre || NaN);
          entryPreMin = Number(warm?.preMin || NaN);
          entryScSlope = Number(slope3pm(series || [], "pumpScore") || NaN);
        } catch {}

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
          warmingHold: warmingHold,
          warmingHoldAt: warmingHold ? now() : undefined,
          warmingMinProfitPct: Number(state.warmingMinProfitPct || 100),
          sellGuardUntil: now() + guardMs,
          entryChg5m,
          entryPre,
          entryPreMin,
          entryScSlope,
          earlyNegScCount: 0,
        };
        try {
          const dyn = pickTpSlForMint(mint);
          pos.tpPct = dyn.tp;
          pos.slPct = dyn.sl;
          pos.trailPct = dyn.trailPct;
          pos.minProfitToTrailPct = dyn.arm;
          log(`Dynamic TP/SL ${mint.slice(0,4)}…: TP=${dyn.tp}% SL=${dyn.sl}% Trail=${dyn.trailPct}% Arm=${dyn.arm}% (${dyn.tier} I=${dyn.intensity.toFixed(2)})`);
        } catch {}
        state.positions[mint] = pos;
        updatePosCache(kp.publicKey.toBase58(), mint, pos.sizeUi, pos.decimals);
        save();
        try { clearPendingCredit(kp.publicKey.toBase58(), mint); } catch {}
        log(`Bought ~${buySol.toFixed(4)} SOL -> ${mint.slice(0,4)}…`);
        clearObserverConsider(mint);
        try { await focusMintAndRecord(mint, { refresh: true, ttlMs: 88 }); } catch {}
        try { updateStatsHeader(); } catch {}
      } else {
        log(`Buy confirmed for ${mint.slice(0,4)}… but no token credit yet; will sync later.`);
        const badgeNow = normBadge(getRugSignalForMint(mint)?.badge);
        const warmingHold = !!(state.rideWarming && (badgeNow === "warming" || badgeNow === "pumping"));
        const guardMs = Math.max(10_000, Number(state.observerGraceSecs || 0) * 1000);
        let entryChg5m = 0, entryPre = NaN, entryPreMin = NaN, entryScSlope = NaN;
        try {
          const leadersNow = computePumpingLeaders(3) || [];
          const itNow = leadersNow.find(x => x?.mint === mint);
          const kpNow = itNow?.kp || {};
          const metaNow = itNow?.meta || {};
          const warm = detectWarmingUptick({ kp: { ...kpNow, mint }, meta: metaNow }, state);
          const series = getLeaderSeries(mint, 3);
          entryChg5m = Number(series?.[series.length - 1]?.chg5m || kpNow.change5m || 0);
          entryPre = Number(warm?.pre || NaN);
          entryPreMin = Number(warm?.preMin || NaN);
          entryScSlope = Number(slope3pm(series || [], "pumpScore") || NaN);
        } catch {}

        const pos = {
          ...basePos,
          costSol: Number(basePos.costSol || 0) + buySol,
          hwmSol: Math.max(Number(basePos.hwmSol || 0), buySol),
          lastBuyAt: now(),
          awaitingSizeSync: true,
          allowRebuy: false,
          lastSplitSellAt: undefined,
          warmingHold: warmingHold,
          warmingHoldAt: warmingHold ? now() : undefined,
          warmingMinProfitPct: Number(state.warmingMinProfitPct || 100),
          sellGuardUntil: now() + guardMs,
          entryChg5m,
          entryPre,
          entryPreMin,
          entryScSlope,
          earlyNegScCount: 0,
        };
        try {
          const dyn = pickTpSlForMint(mint);
          pos.tpPct = dyn.tp;
          pos.slPct = dyn.sl;
          pos.trailPct = dyn.trailPct;
          pos.minProfitToTrailPct = dyn.arm;
          log(`Dynamic TP/SL ${mint.slice(0,4)}…: TP=${dyn.tp}% SL=${dyn.sl}% Trail=${dyn.trailPct}% Arm=${dyn.arm}% (${dyn.tier} I=${dyn.intensity.toFixed(2)})`);
        } catch {}
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
        try { await focusMintAndRecord(mint, { refresh: true, ttlMs: 88 }); } catch {}
        try { updateStatsHeader(); } catch {}
      }

      spent += buySol;
      plannedTotal = Math.max(0, plannedTotal - buySol);
      buysDone++;
      _buyBatchUntil = now() + (state.multiBuyBatchMs|0);

      if (leaderMode) break;

      // no double buys
      if (!state.allowMultiBuy) break;

      await new Promise(r => setTimeout(r, 150));
      if (remaining < minThreshold) break;
    }

    state.carrySol = 0; // disable carry accumulation after buy attempts
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

    if (!Number.isFinite(state.pnlBaselineSol)) {
      state.pnlBaselineSol = Number(state.moneyMadeSol || 0);
      save();
    }

    try { updateStatsHeader(); } catch {}

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
      try { renderStatusLed(); } catch {}
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
      timer = setInterval(tick, Math.max(1200, Number(state.tickMs || 1000)));
      log("Auto trading started");
    }
    startFastObserver();
  } finally {
    _starting = false;
  }
}

function renderStatusLed() {
  if (!ledEl) return;
  const on = !!state.enabled;
  const bg = on ? "#16a34a" : "#b91c1c";
  const glow = on
    ? "0 0 0 2px rgba(22,163,74,.35), 0 0 8px rgba(22,163,74,.6)"
    : "0 0 0 2px rgba(185,28,28,.35), 0 0 8px rgba(185,28,28,.6)";
  ledEl.style.display = "inline-block"; 
  ledEl.style.background = bg;
  ledEl.style.backgroundColor = bg;
  ledEl.style.boxShadow = glow;
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
     try { renderStatusLed(); } catch {}
     save();
     try { updateStatsHeader(); } catch {}
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
     try { if (_pendingCredits && _pendingCredits.size > 0) startPendingCreditWatchdog(); } catch {}
     setTimeout(() => {
       Promise.resolve().then(async () => {
         const kp = await getAutoKeypair().catch(()=>null);
         if (kp) await closeAllEmptyAtas(kp);
       }).catch(()=>{});
     }, 0);
     log("Auto trading stopped");
   }
   try { renderStatusLed(); } catch {}
   save();
}

// config schema version 1
function load() {
  if (!state.loadDefaultState) return;
  let persisted = {};
  try { persisted = JSON.parse(localStorage.getItem(LS_KEY) || "{}") || {}; } catch {}
  state = normalizeState({ ...state, ...persisted });
  save();
}

function save() {
  try { localStorage.setItem(LS_KEY, JSON.stringify(state)); } catch {}
}

function copyLog() {
  try {
    const buf = Array.isArray(window._fdvLogBuffer) ? window._fdvLogBuffer : null;
    const text = (buf && buf.length) 
      ? buf.join("\n")
      : Array.from(logEl?.children || []).filter(n => n?.tagName === "DIV").map(n => n.textContent || "").join("\n");
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

function _ensureStatsHeader() {
  try {
    if (!logEl) return null;
    let hdr = logEl.querySelector("[data-auto-stats-header]");
    if (!hdr) {
      // Insert after the Expand button if present
      const expandBtn = logEl.querySelector("[data-auto-log-expand]");
      hdr = document.createElement("div");
      hdr.setAttribute("data-auto-stats-header", "true");
      hdr.style.position = "sticky";
      hdr.style.top = "0";
      hdr.style.zIndex = "5";
      hdr.style.background = "rgba(0,0,0,0.80)";
      hdr.style.backdropFilter = "blur(2px)";
      hdr.style.WebkitBackdropFilter = "blur(2px)";
      hdr.style.padding = "6px 8px";
      hdr.style.borderBottom = "1px solid var(--fdv-border,#333)";
      hdr.style.fontSize = "12px";
      hdr.style.lineHeight = "1.35";
      hdr.style.display = "grid";
      hdr.style.gridTemplateColumns = "1fr 1fr";
      hdr.style.gap = "6px 10px";
      const target = expandBtn ? expandBtn.nextElementSibling : logEl.firstChild;
      if (expandBtn && target) {
        logEl.insertBefore(hdr, target);
      } else if (expandBtn) {
        logEl.appendChild(hdr);
      } else {
        logEl.insertBefore(hdr, logEl.firstChild);
      }
    }
    return hdr;
  } catch { return null; }
}

let _hdrRaf = 0;
function updateStatsHeader() {
  if (_hdrRaf) return; // throttle to next frame
  _hdrRaf = requestAnimationFrame(() => {
    _hdrRaf = 0;
    try {
      const hdr = _ensureStatsHeader();
      if (!hdr) return;
      const pnlSol = getSessionPnlSol();
      const px = Number((_solPxCache && _solPxCache.usd) || 0);
      const pnlUsd = px > 0 ? pnlSol * px : null;

      const solBal = Number(window._fdvLastSolBal || 0);
      const open = Object.entries(state.positions || {}).filter(([m, p]) => m !== SOL_MINT && Number(p?.sizeUi || 0) > 0).length;

      const running = !!state.enabled;
      const status = running ? "RUNNING" : "STOPPED";

      let left = "—";
      if (state.endAt && now() < state.endAt) {
        const sec = Math.max(0, Math.floor((state.endAt - now()) / 1000));
        const mm = Math.floor(sec / 60);
        const ss = sec % 60;
        left = `${mm}:${String(ss).padStart(2,"0")}`;
      }

      const lastTradeAgo = Number(state.lastTradeTs || 0) ? Math.max(0, Math.floor((now() - state.lastTradeTs) / 1000)) : null;
      const lastTradeStr = lastTradeAgo === null ? "—" : `${lastTradeAgo}s`;

      hdr.innerHTML = `
        <div><strong>Money made</strong>: ${pnlSol.toFixed(6)} SOL${pnlUsd !== null ? ` (${fmtUsd(pnlUsd)})` : ""}</div>
        <div><strong>Status</strong>: ${status}</div>
        <div><strong>SOL</strong>: ${solBal ? solBal.toFixed(6) : "—"}</div>
        <div><strong>Open</strong>: ${open}</div>
        <div><strong>Time left</strong>: ${left}</div>
        <div><strong>Last trade</strong>: ${lastTradeStr}</div>
      `;
    } catch {}
  });
}

export function initAutoWidget(container = document.body) {
  load();

  if (!state.positions || typeof state.positions !== "object") state.positions = {};

  const wrap = document.createElement("details");
  wrap.className = "fdv-auto-wrap";

  wrap.open = !state.collapsed;

  const summary = document.createElement("summary");
  summary.innerHTML = `
    <span class="fdv-acc-title" style="position:relative; display:block;">
      <svg class="fdv-acc-caret" width="16" height="16" viewBox="0 0 24 24" aria-hidden="true">
        <path d="M8 10l4 4 4-4" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"></path>
      </svg>
      <span class="fdv-title">FDV Auto Pump</span>
    </span>
    <span data-auto-led title="Status"
            style="display:inline-block; width:10px; height:10px; border-radius:50%;
                   background:#b91c1c; box-shadow:0 0 0 2px rgba(185,28,28,.3), 0 0 8px rgba(185,28,28,.6);">
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
      <label>Min Edge (%) <input data-auto-minedge type="number" step="0.1" placeholder="-5 = allow -5%"/></label>
      <label>Warming decay (%/min) <input data-auto-warmdecay type="number" step="0.01" min="0" max="5" placeholder="0.25"/></label>
      <label>TP (%) <input data-auto-tp type="number" step="0.1" min="1" max="500" placeholder="12"/></label>
      <label>SL (%) <input data-auto-sl type="number" step="0.1" min="0.1" max="90" placeholder="4"/></label>
      <label>Trail (%) <input data-auto-trail type="number" step="0.1" min="0" max="90" placeholder="6"/></label>
      <label>Slippage (bps) <input data-auto-slip type="number" step="1" min="50" max="2000" placeholder="250"/></label>
 

      <label>Multi-buy
        <select data-auto-multi disabled>
          <option value="no">No</option>
          <option value="yes" selected>Yes</option>
        </select>
      </label>
     <label>Leader
        <select data-auto-hold>
          <option value="no">No</option>
          <option value="yes">Yes</option>
        </select>
      </label>
      <label>Dust
        <select data-auto-dust>
          <option value="no" selected>No</option>
          <option value="yes">Yes</option>
        </select>
      </label>
      <label>Warming
        <select data-auto-warming>
          <option value="no">No</option>
          <option value="yes">Yes</option>
        </select>
      </label>
      <label>Stealth
        <select data-auto-stealth>
          <option value="no">No</option>
          <option value="yes">Yes</option>
        </select>
      </label>
    </div>
    <details class="fdv-advanced" data-auto-adv style="margin:8px 0;">
      <summary style="cursor:pointer; user-select:none;">Advanced</summary>
      <div class="fdv-grid" style="margin-top:8px;">
        <label>Warming min profit (%) <input data-auto-warm-minp type="number" step="0.1" min="-50" max="50" placeholder="2"/></label>
        <label>Warming floor (%) <input data-auto-warm-floor type="number" step="0.1" min="-50" max="50" placeholder="-2"/></label>
        <label>Decay delay (s) <input data-auto-warm-delay type="number" step="1" min="0" max="600" placeholder="15"/></label>
        <label>Auto release (s) <input data-auto-warm-release type="number" step="1" min="0" max="600" placeholder="45"/></label>
        <label>Max loss (%) <input data-auto-warm-maxloss type="number" step="0.1" min="1" max="50" placeholder="6"/></label>
        <label>Max loss window (s) <input data-auto-warm-window type="number" step="1" min="5" max="180" placeholder="30"/></label>
        <label>Primed consec <input data-auto-warm-consec type="number" step="1" min="1" max="3" placeholder="1"/></label>
        <label>Edge min excl (%) <input data-auto-warm-edge type="number" step="0.1" min="-10" max="10" placeholder="(optional)"/></label>
        <label>Rebound min score <input data-auto-rebound-score type="number" step="0.01" min="0" max="5" placeholder="0.34"/></label>
        <label>Rebound lookback (s) <input data-auto-rebound-lookback type="number" step="1" min="5" max="180" placeholder="45"/></label>
        <label>Friction snap (SOL)
          <input data-auto-fric-snap type="number" step="0.0001" min="0" max="0.05" placeholder="0.0020"/>
        </label>
        <label>Final gate
          <select data-auto-final-gate-enabled>
            <option value="yes">On</option>
            <option value="no">Off</option>
          </select>
        </label>
        <label>Final gate min start
          <input data-auto-final-gate-minstart type="number" step="0.1" min="0" max="50" placeholder="2"/>
        </label>
        <label>Final gate Δscore
          <input data-auto-final-gate-delta type="number" step="0.1" min="0" max="50" placeholder="3"/>
        </label>
        <label>Final gate window (ms)
          <input data-auto-final-gate-window type="number" step="100" min="1000" max="30000" placeholder="10000"/>
        </label>
      </div>
    </details>
    <div class="fdv-hold-time-slider"></div>
    <div class="fdv-log" data-auto-log>
    <button class="btn" data-auto-log-expand title="Expand log" style="display: none;">Expand</button>
    </div>
    <div class="fdv-actions">
    <div class="fdv-actions-left">
        <button class="btn" data-auto-help title="How the bot works">Help</button>
        <button class="btn" data-auto-log-copy title="Copy log">Log</button>
        <div class="fdv-modal" data-auto-modal
             style="display:none; position:fixed; width: 100%; inset:0; z-index:9999; background:rgba(0, 0, 0, 1); align-items:center; justify-content:center;justify-content: flex-start;">
          <div class="fdv-modal-card"
               style="background:#000; color:var(--fdv-fg,#fff);overflow:auto; border-radius:12px; box-shadow:0 10px 30px rgba(0,0,0,.5); padding:16px 20px;">
            <div style="display:flex; align-items:center; justify-content:space-between; gap:12px; margin-bottom:6px;">
              <h3 style="margin:0; font-size:16px;">Auto Pump Bot</h3>
            </div>
            <div class="fdv-tabs" data-auto-tabs style="display:flex; gap:8px; margin:6px 0 10px;">
              <button data-auto-tab="guide" class="active" style="padding:4px 8px;border:1px solid var(--fdv-border,#333);border-radius:6px;background:#222;color:#fff;">Guide</button>
              <button data-auto-tab="release" style="padding:4px 8px;border:1px solid var(--fdv-border,#333);border-radius:6px;background:#111;color:#aaa;">Release</button>
            </div>
            <div class="fdv-modal-body-tooltip" style="font-size:13px; line-height:1.5; gap:10px;">
             <div class="fdv-guide" data-auto-tab-panel="guide">
                <div>
                 <strong>How the Auto Pump Bot works</strong>
                 <p style="margin:6px 0 0 0;">
                   The bot tracks Pumping Radar leaders, buys the strongest candidates, manages risk with warming / rebound /
                   fast-exit logic, and optionally rotates into the current leader. This panel explains every knob in plain
                   language and gives ready-made strategy presets.
                 </p>
               </div>

               <div>
                 <strong>1. Core runtime & wallet</strong>
                 <ul style="margin:6px 0 0 18px;">
                   <li><b>Start / Stop</b><br/>
                     Start runs the engine (ticks) at your configured speed; Stop pauses all new buys/sells
                     (positions are left as-is). The bot does <b>not</b> auto-unwind on Stop - use <b>Return</b> for that.
                   </li>
                   <li><b>Tick speed</b> (<code>tickMs</code>)<br/>
                     How often the bot re-evaluates leaders and positions.
                     <ul style="margin:4px 0 0 18px;">
                       <li>~1200-1500 ms → more reactive, more RPC/Jupiter load.</li>
                       <li>~2500-3000 ms → gentler on infra, slower reactions.</li>
                     </ul>
                   </li>
                   <li><b>Auto Wallet & Recipient</b><br/>
                     <ul style="margin:4px 0 0 18px;">
                       <li><b>Auto Wallet</b> - the dedicated trading wallet (Generate creates it).</li>
                       <li><b>Recipient</b> - where SOL is sent when you press <b>Return</b>.</li>
                       <li>Recommended: use a fresh burner for Auto Wallet and your main/vault wallet as Recipient.</li>
                     </ul>
                   </li>
                   <li><b>Lifetime (mins)</b><br/>
                     Sets a session timer:
                     <ul style="margin:4px 0 0 18px;">
                       <li><code>0</code> → run until you manually Stop.</li>
                       <li><code>60</code> → roughly 1 hour, then auto “End &amp; Return”.</li>
                     </ul>
                   </li>
                 </ul>
               </div>

               <div>
                 <strong>2. RPC & infrastructure</strong>
                 <ul style="margin:6px 0 0 18px;">
                   <li><b>RPC (CORS)</b><br/>
                     CORS-enabled Solana RPC URL used for all chain calls. If you see “owner scans disabled” logs,
                     your provider likely blocks account-owner queries.
                   </li>
                   <li><b>RPC Headers (JSON)</b><br/>
                     Optional HTTP headers, e.g. auth tokens:
                     <pre style="margin:4px 0 0 0;white-space:pre-wrap;">{"Authorization": "Bearer &lt;your-key&gt;"}</pre>
                   </li>
                   <li><b>Backoff & stress handling</b><br/>
                     The bot automatically slows down when it detects 429 / 403 or plan-upgrade errors to avoid bans.
                   </li>
                 </ul>
               </div>

               <div>
                 <strong>3. Buy sizing & friction</strong>
                 <ul style="margin:6px 0 0 18px;">
                   <li><b>Buy % of SOL</b> (<code>buyPct</code>)<br/>
                     How much of your <b>available</b> SOL to spend per buy (after reserves).
                     <ul style="margin:4px 0 0 18px;">
                       <li>Conservative: ~10% (0.10).</li>
                       <li>Aggressive: 25-40% (0.25-0.40).</li>
                     </ul>
                   </li>
                   <li><b>Min / Max Buy (SOL)</b><br/>
                     Floors and caps per-order size. The bot also enforces a friction-aware minimum so that fees + ATA rent
                     do not eat the entire order.
                   </li>
                   <li><b>Reserves & runway</b><br/>
                     The bot keeps aside:
                     <ul style="margin:4px 0 0 18px;">
                       <li>A base fee/rent reserve.</li>
                       <li>Per-position reserves for future sells.</li>
                       <li>A small SOL “runway” (minimum operating SOL).</li>
                     </ul>
                     Only the remaining balance is eligible for buys.
                   </li>
                   <li><b>Friction snap (SOL)</b> (<code>fricSnapEpsSol</code>)<br/>
                     When your planned order is just below the friction minimum, this controls whether the bot bumps it
                     up to the minimum or skips:
                     <ul style="margin:4px 0 0 18px;">
                       <li>Higher (e.g. 0.002) → more likely to “snap up” and buy.</li>
                       <li>Lower (e.g. 0.0005) → more likely to skip and carry until larger.</li>
                     </ul>
                   </li>
                 </ul>
               </div>

               <div>
                 <strong>4. Edge (profitability) gating</strong>
                 <p style="margin:6px 0 0 0;">
                   Before buying, the bot approximates <b>round-trip PnL</b> (SOL → token → SOL) including platform fee and
                   tx fees.
                 </p>
                 <ul style="margin:6px 0 0 18px;">
                   <li><b>Min Edge (%)</b> (<code>minNetEdgePct</code>)<br/>
                     Baseline net edge requirement (excluding one-time ATA rent).
                   </li>
                   <li><b>Edge safety buffer (%)</b> (<code>edgeSafetyBufferPct</code>)<br/>
                     Extra margin added on top, to avoid borderline trades.
                     <br/>Example: <code>minNetEdgePct = -4, buffer = 0.2</code> → need ≥ -3.8% edge.
                   </li>
                   <li><b>Edge min excl (%) - Warming override</b> (<code>warmingEdgeMinExclPct</code>)<br/>
                     Optional stricter edge just for warming entries. If set, warming buys must meet this edge
                     (excl ATA), even if the base Min Edge is looser.
                   </li>
                 </ul>
               </div>

               <div>
                 <strong>5. Take-profit / Stop-loss / Trailing</strong>
                 <ul style="margin:6px 0 0 18px;">
                   <li><b>TP (%)</b> (<code>takeProfitPct</code>)<br/>
                     Net PnL threshold where the bot takes profit:
                     <ul style="margin:4px 0 0 18px;">
                       <li>If <code>partialTpPct</code> between 1-99 → partial TP.</li>
                       <li>Else → full exit.</li>
                     </ul>
                   </li>
                   <li><b>SL (%)</b> (<code>stopLossPct</code>)<br/>
                     Net loss threshold where the bot cuts the position.
                   </li>
                   <li><b>Trail (%)</b> and <b>Min profit to trail (%)</b><br/>
                     Trailing stop arms once PnL ≥ min profit, then sells if drawdown from the high-water mark exceeds
                     the trail percentage.
                   </li>
                   <li><b>Sell cooldown</b> (<code>sellCooldownMs</code>)<br/>
                     Time window after a sell during which the bot will not sell the same position again.
                   </li>
                   <li><b>Min / Max hold (s)</b><br/>
                     <ul style="margin:4px 0 0 18px;">
                       <li><b>Min hold</b> - earliest the bot is allowed to sell.</li>
                       <li><b>Max hold</b> - hard time-based exit (force-sell) unless higher-priority gates say otherwise.</li>
                     </ul>
                   </li>
                   <li><b>Dynamic hold (∞ checkbox)</b><br/>
                     Lets the observer system auto-tune maxHoldSecs based on how strong the entry looked (3/5 vs 5/5).
                   </li>
                 </ul>
                 <p style="margin:6px 0 0 18px;">
                   <b>Examples:</b><br/>
                   Quick scalper: TP 10-15%, SL 3-5%, Trail 6-8%, max hold ~45-60s.<br/>
                   Slower rotator: TP 30-40%, SL 10-15%, Trail 15-20%, max hold a few minutes.
                 </p>
               </div>

               <div>
                 <strong>6. Fast Exit system</strong>
                 <p style="margin:6px 0 0 0;">
                   Fast Exit sits on top of TP/SL/trailing and can override them when price action flips quickly.
                 </p>
                 <ul style="margin:6px 0 0 18px;">
                   <li><b>Hard stop</b> - if loss ≥ <code>fastHardStopPct</code>, force-sell.</li>
                   <li><b>Fast trailing</b> - if PnL ≥ <code>fastTrailArmPct</code> then drawdown ≥ <code>fastTrailPct</code>, sell all.</li>
                   <li><b>Fast TP1 / TP2</b> - staged partial TPs at two profit levels.</li>
                   <li><b>Timeout</b> - if we never get a strong high within <code>fastNoHighTimeoutSec</code> but PnL > 0, take a
                     50% “time stop” partial.</li>
                   <li><b>Alpha decay / trend flip / accel drop</b> - use slopes & acceleration of leaders to exit when momentum
                     clearly dies.</li>
                 </ul>
                 <p style="margin:6px 0 0 18px;">
                   <b>Use when</b> you want the bot to cut losers quickly and monetize spikes aggressively.
                 </p>
               </div>

               <div>
                 <strong>7. Dynamic Hard Stop</strong>
                 <p style="margin:6px 0 0 0;">
                   Instead of a fixed stop-loss, the bot can compute a smart hard stop per position based on liquidity,
                   volume and slopes.
                 </p>
                 <ul style="margin:6px 0 0 18px;">
                   <li><b>Base</b> around 4% loss, then:
                     <ul style="margin:4px 0 0 18px;">
                       <li>High liq/volume or strong slopes → more forgiving (stop farther).</li>
                       <li>Low liq/volume or backside slopes → tighter (stop closer).</li>
                     </ul>
                   </li>
                   <li>Clamped between <code>dynamicHardStopMinPct</code> and <code>dynamicHardStopMaxPct</code>.</li>
                   <li>Only active after the initial “buyer's remorse” window to avoid killing entries too early.</li>
                 </ul>
               </div>

               <div>
                 <strong>8. Warming engine & dynamic hold</strong>
                 <p style="margin:6px 0 0 0;">
                   Warming aims to enter early in trends and then hold those winners long enough to matter.
                 </p>
                 <ul style="margin:6px 0 0 18px;">
                   <li><b>Warming toggle</b> (<b>Warming</b> select)<br/>
                     <ul style="margin:4px 0 0 18px;">
                       <li>Off → classic momentum bot (TP/SL/trail only).</li>
                       <li>On → uses warming uptick detection & warming hold.</li>
                     </ul>
                   </li>
                   <li><b>Warming uptick (entry filter)</b><br/>
                     Uses 3-tick slopes, accel ratio, zV1, buy skew, liq and volume to decide which “warming” leaders are
                     actually worth entering. Priming requires consecutive uptick confirmations to avoid one-off wiggles.
                   </li>
                   <li><b>Warming hold</b> (post-buy)<br/>
                     <ul style="margin:4px 0 0 18px;">
                       <li><b>Warming min profit (%)</b> - base profit target (e.g. 80-120%).</li>
                       <li><b>Decay (%/min)</b> & <b>Delay (s)</b> - the profit requirement decays over time after a delay.</li>
                       <li><b>Floor (%)</b> - requirement never decays below this floor.</li>
                       <li><b>Auto release (s)</b> - after this many seconds, the bot can release warming hold if profit
                         meets the decayed threshold.</li>
                       <li><b>Max loss (%) in window</b> - early protection: if PnL falls below this within the configured
                         window, it forces a sell despite warming.</li>
                       <li><b>Extend on rise</b> - if rebound signal is strong, warming hold can extend a bit longer.</li>
                     </ul>
                   </li>
                 </ul>
               </div>

               <div>
                 <strong>9. Rebound gate</strong>
                 <p style="margin:6px 0 0 0;">
                   When the bot is about to sell, it can temporarily defer the sell if the recent slope of leaders suggests
                   a rebound is forming.
                 </p>
                 <ul style="margin:6px 0 0 18px;">
                   <li><b>Lookback (s)</b> - window used to compute per-minute slopes.</li>
                   <li><b>Max defer (s)</b> - cap on total extra hold time.</li>
                   <li><b>Hold (ms)</b> - length of each deferral.</li>
                   <li><b>Min PnL (%)</b> - deep losers do not get rebound defers.</li>
                 </ul>
               </div>

               <div>
                 <strong>10. Observer system & Leader mode</strong>
                 <ul style="margin:6px 0 0 18px;">
                   <li><b>Observer pre-buy / post-buy logic</b><br/>
                     The observer compares several snapshots of a leader over a short window (change, volume, liquidity,
                     pump score). Scores are 0-5:
                     <ul style="margin:4px 0 0 18px;">
                       <li>&lt; 3/5 → reject and staged blacklist.</li>
                       <li>≥ min threshold → allow, possibly with a recommended hold window.</li>
                     </ul>
                   </li>
                   <li><b>Leader mode (Hold Leader)</b><br/>
                     When ON, the bot:
                     <ul style="margin:4px 0 0 18px;">
                       <li>Always tries to hold a single leader.</li>
                       <li>On leader change, sells non-leaders and rotates into the new leader.</li>
                       <li>Suppresses some TP/SL/observer exits unless there is a rug/strong event.</li>
                     </ul>
                   </li>
                 </ul>
               </div>

               <div>
                 <strong>11. Final Pump Gate</strong>
                 <p style="margin:6px 0 0 0;">
                   Final Pump Gate is a last filter before buying, based on how quickly pump score improves.
                 </p>
                 <ul style="margin:6px 0 0 18px;">
                   <li><b>Min start</b> - minimum pump score where tracking begins.</li>
                   <li><b>Δscore</b> - how much pump score must increase within the gate window.</li>
                   <li><b>Window (ms)</b> - time allowed for that Δscore.</li>
                 </ul>
                 <p style="margin:6px 0 0 18px;">
                   Example: min start 2, Δscore 3, window 10-20s → only entries where score really explodes are allowed.
                 </p>
               </div>

               <div>
                 <strong>12. Dust, friction and router cooldowns</strong>
                 <ul style="margin:6px 0 0 18px;">
                   <li><b>Dust sells</b> (<b>Dust</b> select + <code>dustExitEnabled</code>)<br/>
                     If enabled, the bot:
                     <ul style="margin:4px 0 0 18px;">
                       <li>Sweeps dust at startup when it crosses a minimum notional.</li>
                       <li>Tries to sell dust on “Return”.</li>
                     </ul>
                   </li>
                   <li><b>dustMinSolOut</b><br/>
                     Minimum estimated SOL for a dust sell to be worth it.
                   </li>
                   <li><b>Router cooldown</b><br/>
                     Tokens that repeatedly fail routes (NO_ROUTE / dust errors) are put on a per-mint cooldown to avoid
                     spamming JUP.
                   </li>
                 </ul>
               </div>

               <div>
                 <strong>13. Rugs, blacklists & fast observer</strong>
                 <ul style="margin:6px 0 0 18px;">
                   <li><b>Rug detection</b><br/>
                     Severe rug signals (severity ≥ threshold) trigger immediate forced exits and a long blacklist.
                   </li>
                   <li><b>Blacklists & pump→calm bans</b><br/>
                     Problematic mints are blacklisted in stages (2 min / 15 min / 30 min). Pump→calm transitions can
                     trigger temporary bans to avoid getting trapped on the backside.
                   </li>
                   <li><b>Fast Observer (40 ms loop)</b><br/>
                     High-frequency badge and momentum sampling. Escalates to urgent sells for early severe rugs or
                     nasty pump→calm drawdowns.
                   </li>
                 </ul>
               </div>

               <div>
                 <strong>14. Stealth & sweeps</strong>
                 <ul style="margin:6px 0 0 18px;">
                   <li><b>Stealth mode</b><br/>
                     When enabled, after all positions are closed the bot can rotate SOL to a fresh auto wallet, archiving
                     the old one. This improves privacy and makes it harder to trace your session.
                   </li>
                   <li><b>Startup sweep</b><br/>
                     On start, the bot can:
                     <ul style="margin:4px 0 0 18px;">
                       <li>Sweep non-SOL positions into SOL (for sufficiently large balances).</li>
                       <li>Classify tiny leftovers as dust.</li>
                     </ul>
                   </li>
                   <li><b>End &amp; Return</b><br/>
                     Attempts to sell all tokens and dust into SOL, then sends SOL to your Recipient wallet (minus a small
                     rent buffer). Resets session stats afterward.
                   </li>
                 </ul>
               </div>

               <div>
                 <strong>15. Strategy presets (examples)</strong>
                 <p style="margin:6px 0 0 0;">
                   These are not financial advice - just starting points. Always adjust for your own risk tolerance.
                 </p>
                 <ul style="margin:6px 0 0 18px;">
                   <li><b>A. Conservative swing / warming rider</b><br/>
                     <ul style="margin:4px 0 0 18px;">
                       <li>Buy: <code>buyPct ≈ 0.15</code>, <code>minBuySol = 0.06</code>, <code>maxBuySol = 0.3-0.5</code>.</li>
                       <li>Edge: <code>minNetEdgePct ≈ -3</code>, <code>edgeSafetyBufferPct ≈ 0.25</code>,
                         <code>warmingEdgeMinExclPct ≈ -1.5</code>.</li>
                       <li>Warming: <code>rideWarming = true</code>, <code>warmingMinProfitPct ≈ 100</code>,
                         <code>decay ≈ 0.25</code>, <code>floor ≈ -2</code>, <code>autoRelease ≈ 90s</code>.</li>
                       <li>Dynamic hard stop: ON (~3-5%). Fast exit: ON (defaults).</li>
                       <li>Hold: <code>maxHoldSecs ≈ 70-90</code>, dynamic hold ON.</li>
                       <li>Final Pump Gate: enabled, minStart ≈ 2, Δscore ≈ 3, window ≈ 10-15s.</li>
                     </ul>
                   </li>
                   <li><b>B. High-frequency scalper with fast exits</b><br/>
                     <ul style="margin:4px 0 0 18px;">
                       <li>Buy: <code>buyPct ≈ 0.25-0.30</code>, <code>maxBuySol = 0.1-0.2</code>.</li>
                       <li>Edge: <code>minNetEdgePct ≈ -5</code>, <code>edgeSafetyBufferPct ≈ 0.10</code>.</li>
                       <li>Warming (optional): <code>warmingMinProfitPct ≈ 40-60</code>, higher decay (≈0.4), autoRelease ≈ 60s.</li>
                       <li>Fast Exit: tighter (hard stop 2-3%, trail arm 4-5%, trail 8-10%, TP1≈10%, TP2≈20%).</li>
                       <li>Hold: <code>maxHoldSecs ≈ 45-60</code>, dynamic hold ON.</li>
                     </ul>
                   </li>
                   <li><b>C. Leader rotation (“follow the top horse”)</b><br/>
                     <ul style="margin:4px 0 0 18px;">
                       <li><code>holdUntilLeaderSwitch = true</code>, <code>allowMultiBuy = false</code>.</li>
                       <li>Edge: <code>minNetEdgePct ≈ -2</code>, <code>edgeSafetyBufferPct ≈ 0.15</code>,
                         <code>warmingEdgeMinExclPct ≈ -0.5</code>.</li>
                       <li>Warming: more permissive (profit ≈100-150%, decay ≈0.2, autoRelease ≈120s).</li>
                       <li>Dynamic hard stop + Fast Exit both ON to protect rotations.</li>
                       <li>Final Pump Gate: moderate (minStart 1.5-2, Δscore 2-3, window 12-18s).</li>
                     </ul>
                   </li>
                   <li><b>D. Dust grinder (cleanup mode)</b><br/>
                     <ul style="margin:4px 0 0 18px;">
                       <li><code>dustExitEnabled = true</code>, <code>dustMinSolOut ≈ 0.004-0.006</code>.</li>
                       <li>Edge: allow low/negative edges for sells (e.g. <code>minNetEdgePct ≈ -6</code> or lower).</li>
                       <li>Use mainly to gradually exit many small bags and keep the wallet clean.</li>
                     </ul>
                   </li>
                 </ul>
               </div>

               <div>
                 <strong>Support, updates & community</strong>
                 <p style="margin:6px 0 0 0;">
                   • Code & issues: <a href="https://github.com/builders-toronto/fdv.lol" target="_blank">github.com/builders-toronto/fdv.lol</a><br/>
                   • Telegram (questions / help / feedback): <a href="https://t.me/fdvlolgroup" target="_blank">t.me/fdvlolgroup</a><br/>
                   • X / Twitter (updates & strategy notes): <a href="https://twitter.com/fdvlol" target="_blank">@fdvlol</a>
                 </p>
                 <p style="margin:6px 0 0 0;">
                   Following on X and joining the Telegram group is the best way to see new features, bugfixes, and suggested
                   parameter tweaks for different market conditions.
                 </p>
               </div>

               <div>
                 <strong>Disclaimer</strong>
                 <p style="margin:6px 0 0 0;">
                   This bot is provided "as is" without warranties of any kind. Trading cryptocurrencies involves substantial
                   risk, including the complete loss of your capital. Nothing here is financial advice.
                 </p>
                 <p><strong>Always size small, test first, and only trade what you can afford to lose.</strong></p>
               </div> 
             </div>
              <div data-auto-tab-panel="release" style="display:none;">
               <div>
                   <strong>Release v0.0.4.0: Edge-Aware Sizing, Warming Hold & Safety Pass</strong>
                   <ul style="margin:6px 0 0 18px;">
                     <li><b>Guide & strategy panel</b>: In-app “Guide” tab now documents all core vars (runtime, RPC, sizing, edge, TP/SL/trail, fast exit, dynamic hard stop, warming, rebound, leader mode, dust, stealth) with human-readable presets and examples.</li>
                     <li><b>Tick & backoff</b>: Tick loop hard-clamped to 1200-5000&nbsp;ms; RPC/Jupiter backoff wiring improved to slow ticks under 429/403 or stress markers while keeping UI responsive.</li>
                     <li><b>Spend ceiling & reserves</b>: Unified <code>computeSpendCeiling</code> with explicit fee reserve, per-position sell buffers, and SOL “runway”; buys never consume the last operating SOL or sell-fee buffer.</li>
                     <li><b>Friction-aware min size</b>: Buy sizing now enforces a friction-aware floor using router min, estimated tx fees, and ATA rent, with an elevated min for new ATAs; orders below this are skipped or “snapped” up based on <code>fricSnapEpsSol</code>.</li>
                     <li><b>Round-trip edge gating v2</b>: <code>estimateRoundtripEdgePct</code> computes SOL→token→SOL including platform fee, tx fee, and ATA rent, then gates on <code>pctNoOnetime</code> (excl. ATA) with <code>minNetEdgePct</code> + <code>edgeSafetyBufferPct</code>. When set, <code>warmingEdgeMinExclPct</code> overrides the base threshold for warming entries only.</li>
                     <li><b>Dynamic platform fee</b>: Sell-side fee now applies only when trades are estimated profitable and above a small-notional floor; edge logs and net exit estimators report fee and friction breakdown explicitly.</li>
                     <li><b>Min-notional & dust handling</b>: Unified <code>minSellNotionalSol()</code> for router-floor and dust decisions; remainder logic can promote partials back to positions or re-classify them as dust; router cooldowns tagged on repeated NO_ROUTE/dust failures.</li>
                     <li><b>Observer upgrades</b>: 3/5 pre-buy/post-buy logic uses short multi-sample windows, 3-tick trend series, staged blacklists, and a separate “consider” path; dynamic hold tuning adjusts <code>maxHoldSecs</code> based on observer score; 3/5 exits are debounced and combined with drawdown rules.</li>
                     <li><b>Fast Observer & rugs</b>: 40&nbsp;ms loop adds badge-transition logging, momentum drop checks, early severe-rug detection with staged blacklists, and urgent sells that respect post-buy cooldowns and warming hold where appropriate.</li>
                     <li><b>Early-fade / backside guards</b>: New early-exit layer monitors change/score slopes, chg5m regression from entry, direction changes (jiggle detection), and 5-sample downside trends to cut obvious backside legs while avoiding noisy chop.</li>
                     <li><b>Dynamic hard stop v2</b>: Per-position hard stop is computed from liquidity, v1h volume, and slopes; tuned differently for high-liq vs low-liq names; only activates after a buyer’s remorse window and bypasses warming when hit.</li>
                     <li><b>Warming engine refinements</b>: Warming uptick detector now uses 3-tick series, accel ratio vs implied 1h, zV1, buy skew and liq/volume with relaxed heuristics for strong moves; priming is tracked per-mint; “pre-pump score” normalization and prior-pre memory reduce flip-flop entries.</li>
                     <li><b>Warming hold & max-loss</b>: Warming hold computes a decaying profit requirement with floor and release window; while active, many sells are suppressed until profit meets the decayed target, but a dedicated warming max-loss guard and dynamic hard stop can still force exits.</li>
                     <li><b>Rebound gate v2</b>: Sell deferral checks per-minute slopes and a lightweight warming-style signal; maintains per-position defer windows, caps max deferral time, and logs why a defer occurred; rugs, TP, and deep losses bypass rebound.</li>
                     <li><b>Fast Exit integration</b>: Fast hard stop, fast trailing, staged TP1/TP2, timeout TP, alpha decay, trend flip and accel-drop actions are evaluated ahead of slow logic and can override normal TP/SL/trailing, with dedicated fast-exit slippage and confirm timers.</li>
                     <li><b>Leader rotation safety</b>: <code>switchToLeader</code> now validates mints, prunes invalid ones, respects router cooldowns, sells to SOL with partial remainder logic, and updates realized PnL + caches; optional stealth rotation can move SOL into a fresh auto wallet after rotations.</li>
                     <li><b>Pending-credit watchdog</b>: Buys seed optimistic positions, then reconcile via ATA balances, tx meta, and fallback owner scans; a timed watchdog retries and reconciles positions, with phantom-position pruning after grace windows.</li>
                     <li><b>Owner scan fallback & disable flag</b>: On plan-upgrade / 403/-32602 errors, owner scans are disabled and the bot falls back to local caches plus targeted ATA lookups; a user-visible reason is saved in <code>ownerScanDisabledReason</code>.</li>
                     <li><b>Startup sweeps & unwind</b>: Startup “sweep non-SOL to SOL” and “dust sweep” paths share dust/notional rules, partial-debit handling, router cooldowns, and realized-PnL accounting; “End &amp; Return” uses the same logic before sending SOL to the configured recipient.</li>
                     <li><b>Stealth wallet rotation</b>: When <code>stealthMode</code> is ON and all positions are closed, the bot can rotate SOL into a fresh auto wallet, archive the old wallet (pub/secret/tag/txSig) in <code>oldWallets</code>, and log explicit recovery info.</li>
                     <li><b>Wallet holdings UI</b>: New wallet menu shows sellable balances vs dust per mint, with live SOL and USD estimates using a short-lived quote cache; includes per-owner position/dust cache syncing and a one-click “Dump Wallet” (unwind) action.</li>
                     <li><b>Hold-time slider & dynamic hold</b>: Inline slider for <code>maxHoldSecs</code> (30-120&nbsp;s) plus ∞ checkbox to let the observer auto-tune holds based on pre-buy scores; values are persisted and logged.</li>
                     <li><b>Config schema & normalization</b>: Central <code>CONFIG_SCHEMA</code> plus <code>normalizeState</code> with min/max clamps for all user-facing fields (tick, buy %, min/max buy, edge, warming, rebound, fast exit, dynamic hard stop, final pump gate, dust, etc.), ensuring safe defaults and upgrade paths.</li>
                     <li><b>Logging & UX polish</b>: Structured logs for edge thresholds, warming decisions, rebound defers, router cooldowns, blacklist stages, stealth rotation, and money-made tracking; log panel gains an “Expand” toggle and copy utility, footer bumped to <b>Version: 0.0.4.0</b>.</li>
                     <li><b>Community & updates</b>: The in-app Guide now links directly to the codebase and support channels:<br/>
                       • GitHub: <a href="https://github.com/builders-toronto/fdv.lol" target="_blank">github.com/builders-toronto/fdv.lol</a><br/>
                       • Telegram group (help / questions): <a href="https://t.me/fdvlolgroup" target="_blank">t.me/fdvlolgroup</a><br/>
                       • X / Twitter (updates & strategy notes): <a href="https://twitter.com/fdvlol" target="_blank">@fdvlol</a>
                     </li>
                   </ul>
                 <div style="margin-top:10px;">
                   <strong>Key Advanced Concepts</strong>
                   <ul style="margin:6px 0 0 18px;">
                     <li><b>Warming decay</b>: req = max(floor, base - (decayPctPerMin * elapsedMinutes after delay)). Sell logic suppressed until req met or release window expires.</li>
                     <li><b>Rebound defer</b>: If early sell trigger and slopes / score meet gates, positions get short timed extensions; repeated defers capped by maxDeferSecs.</li>
                     <li><b>Priming</b>: Consecutive successful warming upticks counted; once count ≥ primedConsec the pump score is slightly attenuated (stability bias) but entry allowed.</li>
                     <li><b>Backside guard</b>: Accel ratio vs implied hourly extrapolation filters late flattening; prevents false warming on decay legs.</li>
                     <li><b>Edge threshold</b>: need = (badge-adjusted base or override) + safety buffer; pumping lowers base need; override ignored when input blank.</li>
                   </ul>
                 </div>
                 <div style="margin-top:10px;">
                   <strong>Stability & Fixes Since 0.0.2.6</strong>
                   <ul style="margin:6px 0 0 18px;">
                     <li>Accurate edge log formatting (no negative clamp confusion; override only when provided).</li>
                     <li>Buy credit race reductions via seeded + tx meta reconciliation path.</li>
                     <li>Improved warming extension messaging and release clarity.</li>
                     <li>Refined rebound signal slope normalization (per-minute). </li>
                     <li>Safer owner scan disable detection for restricted RPC plans.</li>
                     <li>Follow us on Github for all updates and changes: <a href="https://github.com/builders-toronto/fdv.lol" target="_blank">github.com/builders-toronto/fdv.lol</a></li>
                   </ul>
                 </div>
                 <div style="margin-top:10px;">
                   <strong>Upgrade Guidance</strong>
                   <ul style="margin:6px 0 0 18px;">
                     <li>Leave warmingEdgeMinExclPct blank unless intentionally tightening friction.</li>
                     <li>Raise reboundMinScore / slopes to reduce hold churn in volatile chop.</li>
                     <li>Lower warmingDecayDelaySecs to accelerate profit requirement decay for shorter rotations.</li>
                     <li>Increase edgeSafetyBufferPct for illiquid environments to avoid borderline negative net entries.</li>
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
    <div class="fdv-bot-footer" style="display:flex;justify-content:space-between;margin-top:12px; font-size:12px; text-align:right; opacity:0.6;">
      <a href="https://t.me/fdvlolgroup" target="_blank" data-auto-help-tg>t.me/fdvlolgroup</a>
      <span>Version: 0.0.4.6</span>
    </div>
  `;

  wrap.appendChild(summary);
  wrap.appendChild(body);
  container.appendChild(wrap);

  const openPumpKpi = () => {
    let opened = false;
    const pumpBtn = document.getElementById("pumpingToggle") || document.querySelector('button[title="PUMP"]');
    if (!pumpBtn) return opened;

    const isExpanded = String(pumpBtn.getAttribute("aria-expanded") || "false") === "true";
    if (isExpanded) return true;

    try { pumpBtn.click(); opened = true; } catch {}

    const panelId = pumpBtn.getAttribute("aria-controls") || "pumpingPanel";
    const panel = document.getElementById(panelId) || document.querySelector("#pumpingPanel");
    if (panel) {
      panel.removeAttribute("hidden");
      panel.style.display = "";
      panel.classList.add("open");
    }
    return opened;
  };

  try {
    const hasAutomate =
      typeof location !== "undefined" &&
      (String(location.hash || "").toLowerCase().includes("automate") ||
      String(location.search || "").toLowerCase().includes("automate"));
    if (hasAutomate) {
      wrap.open = true;
      state.collapsed = false;
      save();
      openPumpKpi();
      setTimeout(openPumpKpi, 0);
      setTimeout(openPumpKpi, 250);
     }
  } catch {}

  wrap.addEventListener("toggle", () => {
    state.collapsed = !wrap.open;
    openPumpKpi();
    save(); // persist?
  });

  logEl     = wrap.querySelector("[data-auto-log]");
  toggleEl  = wrap.querySelector("[data-auto-toggle]");
  ledEl     = wrap.querySelector("[data-auto-led]");
  try { _ensureStatsHeader(); updateStatsHeader(); } catch {}
  tpEl      = wrap.querySelector("[data-auto-tp]");
  slEl      = wrap.querySelector("[data-auto-sl]");
  trailEl   = wrap.querySelector("[data-auto-trail]");
  slipEl    = wrap.querySelector("[data-auto-slip]");
  const holdEl  = wrap.querySelector("[data-auto-hold]");
  const dustEl  = wrap.querySelector("[data-auto-dust]");
  const warmingEl = wrap.querySelector("[data-auto-warming]");
  const stealthEl = wrap.querySelector("[data-auto-stealth]");

  const helpBtn = wrap.querySelector("[data-auto-help]");
  const expandBtn = wrap.querySelector("[data-auto-log-expand]");
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
  minEdgeEl = wrap.querySelector("[data-auto-minedge]");
  multiEl   = wrap.querySelector("[data-auto-multi]");
  warmDecayEl = wrap.querySelector("[data-auto-warmdecay]");

  //advancced
  advBoxEl        = wrap.querySelector("[data-auto-adv]");
  warmMinPEl      = wrap.querySelector("[data-auto-warm-minp]");
  warmFloorEl     = wrap.querySelector("[data-auto-warm-floor]");
  warmDelayEl     = wrap.querySelector("[data-auto-warm-delay]");
  warmReleaseEl   = wrap.querySelector("[data-auto-warm-release]");
  warmMaxLossEl   = wrap.querySelector("[data-auto-warm-maxloss]");
  warmMaxWindowEl = wrap.querySelector("[data-auto-warm-window]");
  warmConsecEl    = wrap.querySelector("[data-auto-warm-consec]");
  warmEdgeEl      = wrap.querySelector("[data-auto-warm-edge]");
  reboundScoreEl = wrap.querySelector("[data-auto-rebound-score]");
  reboundLookbackEl = wrap.querySelector("[data-auto-rebound-lookback]");
  fricSnapEl       = wrap.querySelector("[data-auto-fric-snap]");
  finalGateEnabledEl   = wrap.querySelector("[data-auto-final-gate-enabled]");
  finalGateMinStartEl  = wrap.querySelector("[data-auto-final-gate-minstart]");
  finalGateDeltaEl     = wrap.querySelector("[data-auto-final-gate-delta]");
  finalGateWindowEl    = wrap.querySelector("[data-auto-final-gate-window]");

  setTimeout(() => {
    try {
      logObj("Warming thresholds", {
        minPre: state.warmingUptickMinPre,
        minAccel: state.warmingUptickMinAccel,
        dChg: state.warmingUptickMinDeltaChg5m,
        dScore: state.warmingUptickMinDeltaScore,
        primeConsec: state.warmingPrimedConsec
      });
      logObj("Rebound thresholds", {
        minScore: state.reboundMinScore,
        lookbackSecs: state.reboundLookbackSecs,
        chgSlopeMin: state.reboundMinChgSlope,
        scSlopeMin: state.reboundMinScSlope
      });
    } catch {}
  }, 0);  

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
  minEdgeEl.value = Number.isFinite(state.minNetEdgePct) ? String(state.minNetEdgePct) : "-5";
  multiEl.value   = state.allowMultiBuy ? "yes" : "no";
  warmDecayEl.value = String(Number.isFinite(state.warmingDecayPctPerMin) ? state.warmingDecayPctPerMin : 0.25);
  tpEl.value    = String(state.takeProfitPct);
  slEl.value    = String(state.stopLossPct);
  trailEl.value = String(state.trailPct);
  slipEl.value  = String(state.slippageBps);

  if (warmMinPEl)      warmMinPEl.value      = String(Number.isFinite(state.warmingMinProfitPct) ? state.warmingMinProfitPct : 100);
  if (warmFloorEl)     warmFloorEl.value     = String(Number.isFinite(state.warmingMinProfitFloorPct) ? state.warmingMinProfitFloorPct : -2);
  if (warmDelayEl)     warmDelayEl.value     = String(Number.isFinite(state.warmingDecayDelaySecs) ? state.warmingDecayDelaySecs : 15);
  if (warmReleaseEl)   warmReleaseEl.value   = String(Number.isFinite(state.warmingAutoReleaseSecs) ? state.warmingAutoReleaseSecs : 45);
  if (warmMaxLossEl)   warmMaxLossEl.value   = String(Number.isFinite(state.warmingMaxLossPct) ? state.warmingMaxLossPct : 6);
  if (warmMaxWindowEl) warmMaxWindowEl.value = String(Number.isFinite(state.warmingMaxLossWindowSecs) ? state.warmingMaxLossWindowSecs : 60);
  if (warmConsecEl)    warmConsecEl.value    = String(Number.isFinite(state.warmingPrimedConsec) ? state.warmingPrimedConsec : 1);
  if (warmEdgeEl) {
    warmEdgeEl.value = (typeof state.warmingEdgeMinExclPct === "number" && Number.isFinite(state.warmingEdgeMinExclPct))
      ? String(state.warmingEdgeMinExclPct)
      : "";
  }
  if (reboundScoreEl) reboundScoreEl.value = String(Number.isFinite(state.reboundMinScore) ? state.reboundMinScore : 0.34);
  if (reboundLookbackEl) reboundLookbackEl.value = String(Number.isFinite(state.reboundLookbackSecs) ? state.reboundLookbackSecs : 45);
  if (fricSnapEl)       fricSnapEl.value       = String(Number.isFinite(state.fricSnapEpsSol) ? state.fricSnapEpsSol : 0.0020);
  if (finalGateEnabledEl)   finalGateEnabledEl.value  = state.finalPumpGateEnabled ? "yes" : "no";
  if (finalGateMinStartEl)  finalGateMinStartEl.value = String(Number.isFinite(state.finalPumpGateMinStart) ? state.finalPumpGateMinStart : 2);
  if (finalGateDeltaEl)     finalGateDeltaEl.value    = String(Number.isFinite(state.finalPumpGateDelta) ? state.finalPumpGateDelta : 3);
  if (finalGateWindowEl)    finalGateWindowEl.value   = String(Number.isFinite(state.finalPumpGateWindowMs) ? state.finalPumpGateWindowMs : 10000);

  helpBtn.addEventListener("click", () => { modalEl.style.display = "flex"; });

  if (expandBtn && logEl) {
    log("Log panel: click 'Expand' or press Alt+6 to enlarge. Press Esc to close.", "help");
    log("Focus mode: press Alt+7 to hide other page elements, Alt+8 to restore.", "help");
    
    function setHeaderFullHeight(enable) {
      try {
        const hdr = document.querySelector('header');
        if (!hdr) return;
        if (enable) {
          if (!hdr.dataset.fdvPrevHeight) hdr.dataset.fdvPrevHeight = hdr.style.height || "";
          hdr.style.height = "100vh";
        } else {
          const prev = hdr.dataset.fdvPrevHeight;
          hdr.style.height = prev || "";
          if (prev !== undefined) delete hdr.dataset.fdvPrevHeight;
        }
      } catch {}
    }
    
    const setExpanded = (on) => {
      logEl.classList.toggle("fdv-log-full", !!on);
      expandBtn.textContent = on ? "Close" : "Expand";
      expandBtn.setAttribute("aria-label", on ? "Close log" : "Expand log");
      // setHeaderFullHeight(!!on);
      if (on) logEl.scrollTop = logEl.scrollHeight;
    };

    function setAutoFocus(on) {
      const body = document.body;
      if (on) {
        if (window._fdvFocusHidden) return; // already focused
        let keep = (function findTop(el) {
          let n = el;
          while (n && n.parentElement && n.parentElement !== body) n = n.parentElement;
          return n || el;
        })(wrap);

        const hidden = [];
        Array.from(body.children).forEach(ch => {
          if (ch === keep) return;
          const tag = (ch.tagName || "").toUpperCase();
          if (tag === "SCRIPT" || tag === "STYLE" || tag === "LINK") return;
          ch.dataset.fdvPrevDisplay = ch.style.display || "";
          ch.style.display = "none";
          hidden.push(ch);
        });

        const hiddenWithin = [];
        try {
          const path = [];
          let n = wrap;
          while (n && n !== keep) { path.push(n); n = n.parentElement; }
          path.push(keep);
          for (let i = path.length - 1; i > 0; i--) {
            const parent = path[i];
            const childOnPath = path[i - 1];
            Array.from(parent.children || []).forEach(ch => {
              if (ch === childOnPath) return;
              const tag = (ch.tagName || "").toUpperCase();
              if (tag === "SCRIPT" || tag === "STYLE" || tag === "LINK") return;
              ch.dataset.fdvPrevDisplay = ch.style.display || "";
              ch.style.display = "none";
              hiddenWithin.push(ch);
            });
          }
        } catch {}

        window._fdvFocusHidden = hidden;
        window._fdvFocusHiddenWithin = hiddenWithin;

        try { keep.scrollIntoView({ block: "start", behavior: "smooth" }); } catch {}
        try { log("Focus mode: Auto-only (Alt+8 to restore).", "info"); } catch {}
      } else {
        const hidden = window._fdvFocusHidden || [];
        hidden.forEach(ch => {
          ch.style.display = ch.dataset.fdvPrevDisplay || "";
          try { delete ch.dataset.fdvPrevDisplay; } catch {}
        });
        window._fdvFocusHidden = null;
        const hiddenWithin = window._fdvFocusHiddenWithin || [];
        hiddenWithin.forEach(ch => {
          ch.style.display = ch.dataset.fdvPrevDisplay || "";
          try { delete ch.dataset.fdvPrevDisplay; } catch {}
        });
        window._fdvFocusHiddenWithin = null;

        try { log("Focus mode: restored.", "info"); } catch {}
      }
    }

    expandBtn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      setExpanded(!logEl.classList.contains("fdv-log-full"));
    });

    document.addEventListener("keydown", (e) => {
      const t = e.target;
      const tag = (t && t.tagName) ? t.tagName.toLowerCase() : "";
      const typing = tag === "input" || tag === "textarea" || tag === "select" || (t && t.isContentEditable);
      if (typing) return;

      if (e.key === "Escape" && logEl.classList.contains("fdv-log-full")) {
        setExpanded(false);
      } else if (e.altKey && (e.code === "Digit6" || e.key === "6")) {
        setExpanded(true);
        e.preventDefault();
      } else if (e.altKey && (e.code === "Digit7" || e.key === "7")) {
        setAutoFocus(true);
        e.preventDefault();
      } else if (e.altKey && (e.code === "Digit8" || e.key === "8")) {
        setAutoFocus(false);
        e.preventDefault();
      }
    });
  }
    
    
  modalEl.addEventListener("click", (e) => {
    if (e.target === modalEl) {
      modalEl.style.display = "none";

      try {
        const pumpBtn = document.getElementById("pumpingToggle") || document.querySelector('button[title="PUMP"]');
        const isExpanded = pumpBtn && String(pumpBtn.getAttribute("aria-expanded") || "false") === "true";
        if (!isExpanded) { openPumpKpi(); }
      } catch {}
    }
  });  
  
  modalCloseEls.forEach(btn => btn.addEventListener("click", () => {
    modalEl.style.display = "none";
    try {
      const pumpBtn = document.getElementById("pumpingToggle") || document.querySelector('button[title="PUMP"]');
      const isExpanded = pumpBtn && String(pumpBtn.getAttribute("aria-expanded") || "false") === "true";
      if (!isExpanded) { openPumpKpi(); }
    } catch {}
  }));

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

      const rawDust = dustCacheToList(owner) || [];
      const dustEntries = [];
      for (const it of rawDust) {
        const ok = await isValidPubkeyStr(it.mint).catch(() => false);
        if (ok) dustEntries.push(it);
        else removeFromDustCache(owner, it.mint);
      }

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
      // Dust / unsellable
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
      secretKey: state.autoWalletSecret || "",
      oldWallets: Array.isArray(state.oldWallets) ? state.oldWallets : []
    }, null, 2);
    downloadTextFile(`fdv-auto-wallet-${(state.autoWalletPub||"").slice(0,6)}.json`, payload);
    log("Exported wallet JSON (includes old wallets archive)");
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

  if (toggleEl) toggleEl.addEventListener("change", () => onToggle(toggleEl.value === "yes"));
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
  warmingEl.addEventListener("change", () => {
    state.rideWarming = (warmingEl.value === "yes");
    save();
    log(`Ride Warming: ${state.rideWarming ? "ON" : "OFF"}`);
  });
  multiEl.addEventListener("change", () => {
    state.allowMultiBuy = (multiEl.value === "yes");
    save();
    log(`Multi-buy: ${state.allowMultiBuy ? "ON" : "OFF"}`);
  });
  stealthEl.addEventListener("change", () => {
    state.stealthMode = (stealthEl.value === "yes");
    save();
    log(`Stealth mode: ${state.stealthMode ? "ON" : "OFF"}`);
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
    state.moneyMadeSol = 0;
    state.solSessionStartLamports = 0;
    state.pnlBaselineSol = 0; // reset session baseline
    fetchSolBalance(state.autoWalletPub).then(b => { depBalEl.value = `${b.toFixed(4)} SOL`; }).catch(()=>{});
    save();
    try { updateStatsHeader(); } catch {}
    log("Session stats refreshed");
  });

  const saveField = () => {
    const life = _clamp(parseInt(lifeEl.value || "0", 10), UI_LIMITS.LIFE_MINS_MIN, UI_LIMITS.LIFE_MINS_MAX);
    state.lifetimeMins = life;
    lifeEl.value = String(life);

    const rawPct = normalizePercent(buyPctEl.value);
    const pct = _clamp(rawPct, UI_LIMITS.BUY_PCT_MIN, UI_LIMITS.BUY_PCT_MAX);
    state.buyPct = pct;
    buyPctEl.value = (pct * 100).toFixed(2);

    let minBuy = _clamp(Number(minBuyEl.value || 0), UI_LIMITS.MIN_BUY_SOL_MIN, UI_LIMITS.MIN_BUY_SOL_MAX);
    let maxBuy = _clamp(Number(maxBuyEl.value || 0), UI_LIMITS.MAX_BUY_SOL_MIN, UI_LIMITS.MAX_BUY_SOL_MAX);

    if (maxBuy < minBuy) maxBuy = minBuy;

    state.minBuySol = minBuy;
    state.maxBuySol = maxBuy;

    const edge = Number(minEdgeEl.value);
    const edgeClamped = Math.min(10, Math.max(-10, Number.isFinite(edge) ? edge : state.minNetEdgePct ?? -5));
    state.minNetEdgePct = edgeClamped;
    minEdgeEl.value = String(edgeClamped);

    const wd = Number(warmDecayEl.value);
    const wdClamped = Math.min(5, Math.max(0, Number.isFinite(wd) ? wd : (state.warmingDecayPctPerMin ?? 0.25)));
    state.warmingDecayPctPerMin = wdClamped;
    warmDecayEl.value = String(wdClamped);

    minBuyEl.value = String(minBuy);
    maxBuyEl.min = String(minBuy);
    maxBuyEl.value = String(maxBuy);

    if (recvEl) {
      const recvVal = String(recvEl.value || "").trim();
      state.recipientPub = recvVal;
    }

    if (tpEl) {
      const v = Number(tpEl.value);
      state.takeProfitPct = Number.isFinite(v) ? Math.min(500, Math.max(1, v)) : state.takeProfitPct;
      tpEl.value = String(state.takeProfitPct);
    }

    if (slEl) {
      const v = Number(slEl.value);
      state.stopLossPct = Number.isFinite(v) ? Math.min(90, Math.max(0.1, v)) : state.stopLossPct;
      slEl.value = String(state.stopLossPct);
    }

    if (trailEl) {
      const v = Number(trailEl.value);
      state.trailPct = Number.isFinite(v) ? Math.min(90, Math.max(0, v)) : state.trailPct;
      trailEl.value = String(state.trailPct);
    }

    if (slipEl) {
      const v = Number(slipEl.value);
      state.slippageBps = Number.isFinite(v) ? Math.min(2000, Math.max(50, v)) : state.slippageBps;
      slipEl.value = String(state.slippageBps);
    }
    

    save();
  };
  [recvEl, lifeEl, buyPctEl, minBuyEl, maxBuyEl, minEdgeEl, warmDecayEl, tpEl, slEl, trailEl, slipEl].forEach(el => {
    el.addEventListener("input", saveField);
    el.addEventListener("change", saveField);
  });

  function saveAdvanced() {
    const n = (v) => Number(v);
    const clamp = (v, lo, hi, def) => {
      const x = Number(v);
      return Number.isFinite(x) ? Math.min(hi, Math.max(lo, x)) : def;
    };

    state.warmingMinProfitPct       = clamp(n(warmMinPEl?.value),      -50, 50, 2);
    state.warmingMinProfitFloorPct  = clamp(n(warmFloorEl?.value),     -50, 50, -2);
    state.warmingDecayDelaySecs     = clamp(n(warmDelayEl?.value),       0, 600, 15);
    state.warmingAutoReleaseSecs    = clamp(n(warmReleaseEl?.value),     0, 600, 45);
    state.warmingMaxLossPct         = clamp(n(warmMaxLossEl?.value),     1,  50, 6);
    state.warmingMaxLossWindowSecs  = clamp(n(warmMaxWindowEl?.value),   5, 180, 30);
    state.warmingPrimedConsec       = clamp(n(warmConsecEl?.value),      1,   3, 1);
    state.reboundMinScore       = clamp(n(reboundScoreEl?.value),     0, 5, 0.34);
    state.reboundLookbackSecs   = clamp(n(reboundLookbackEl?.value),  5, 180, 45);
    if (fricSnapEl) {
      state.fricSnapEpsSol = clamp(
        n(fricSnapEl.value),
        0,
        0.05,
        0.0020
      );
    }
    if (finalGateEnabledEl) {
      state.finalPumpGateEnabled = finalGateEnabledEl.value === "yes";
    }
    if (finalGateMinStartEl) {
      state.finalPumpGateMinStart = clamp(
        n(finalGateMinStartEl.value),
        0,
        50,
        2
      );
    }
    if (finalGateDeltaEl) {
      state.finalPumpGateDelta = clamp(
        n(finalGateDeltaEl.value),
        0,
        50,
        3
      );
    }
    if (finalGateWindowEl) {
      state.finalPumpGateWindowMs = clamp(
        n(finalGateWindowEl.value),
        1000,
        30000,
        10000
      );
    }

    const rawEdgeStr = (warmEdgeEl?.value ?? "").toString().trim();
    if (rawEdgeStr.length > 0) {
      const edgeVal = Number(rawEdgeStr);
      if (Number.isFinite(edgeVal)) {
        state.warmingEdgeMinExclPct = Math.min(10, Math.max(-10, edgeVal));
      } else {
        delete state.warmingEdgeMinExclPct;
      }
    } else {
      delete state.warmingEdgeMinExclPct;
    }

    if (warmMinPEl)      warmMinPEl.value      = String(state.warmingMinProfitPct);
    if (warmFloorEl)     warmFloorEl.value     = String(state.warmingMinProfitFloorPct);
    if (warmDelayEl)     warmDelayEl.value     = String(state.warmingDecayDelaySecs);
    if (warmReleaseEl)   warmReleaseEl.value   = String(state.warmingAutoReleaseSecs);
    if (warmMaxLossEl)   warmMaxLossEl.value   = String(state.warmingMaxLossPct);
    if (warmMaxWindowEl) warmMaxWindowEl.value = String(state.warmingMaxLossWindowSecs);
    if (warmConsecEl)    warmConsecEl.value    = String(state.warmingPrimedConsec);
    if (warmEdgeEl)      warmEdgeEl.value      = (typeof state.warmingEdgeMinExclPct === "number")
      ? String(state.warmingEdgeMinExclPct) : "";
    if (reboundScoreEl)    reboundScoreEl.value    = String(state.reboundMinScore);
    if (reboundLookbackEl) reboundLookbackEl.value = String(state.reboundLookbackSecs);
    if (fricSnapEl)       fricSnapEl.value       = String(state.fricSnapEpsSol);
    if (finalGateEnabledEl)   finalGateEnabledEl.value  = state.finalPumpGateEnabled ? "yes" : "no";
    if (finalGateMinStartEl)  finalGateMinStartEl.value = String(state.finalPumpGateMinStart);
    if (finalGateDeltaEl)     finalGateDeltaEl.value    = String(state.finalPumpGateDelta);
    if (finalGateWindowEl)    finalGateWindowEl.value   = String(state.finalPumpGateWindowMs);

    save();
  }

  [warmMinPEl, warmFloorEl, warmDelayEl, warmReleaseEl, warmMaxLossEl, warmMaxWindowEl, warmConsecEl, warmEdgeEl,
   reboundScoreEl, reboundLookbackEl, fricSnapEl, finalGateEnabledEl, finalGateMinStartEl, finalGateDeltaEl, finalGateWindowEl]
    .filter(Boolean)
    .forEach(el => {
      el.addEventListener("input", saveAdvanced);
      el.addEventListener("change", saveAdvanced);
    });

  if (toggleEl) toggleEl.value = state.enabled ? "yes" : "no";
  holdEl.value = state.holdUntilLeaderSwitch ? "yes" : "no";
  dustEl.value = state.dustExitEnabled ? "yes" : "no";
  warmingEl.value = state.rideWarming ? "yes" : "no";
  startBtn.disabled = !!state.enabled;
  stopBtn.disabled = !state.enabled;
  if (state.enabled && !timer) timer = setInterval(tick, Math.max(1200, Number(state.tickMs || 1000)));

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