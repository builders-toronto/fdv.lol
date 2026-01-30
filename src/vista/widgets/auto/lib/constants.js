// Centralized constants for the Auto widget.
// Kept as a separate module so the main widget file can focus on orchestration/UI.

export const SOL_MINT = "So11111111111111111111111111111111111111112";

export const MIN_JUP_SOL_IN = 0.001;
export const MIN_SELL_SOL_OUT = 0.004;

export const FEE_RESERVE_MIN = 0.0002; // rent
export const FEE_RESERVE_PCT = 0.08; // 8% reserve (was 15%)

export const MIN_SELL_CHUNK_SOL = 0.01; // allow micro exits (was 0.02)
export const SMALL_SELL_FEE_FLOOR = 0.0; // disable fee below this est out
export const AVOID_NEW_ATA_SOL_FLOOR = 0.04; // don't open new ATAs if SOL below this

export const TX_FEE_BUFFER_LAMPORTS = 500_000;
export const SELL_TX_FEE_BUFFER_LAMPORTS = 500_000;
export const EXTRA_TX_BUFFER_LAMPORTS = 250_000;
export const EDGE_TX_FEE_ESTIMATE_LAMPORTS = 150_000;

export const MIN_QUOTE_RAW_AMOUNT = 1_000;
export const ELEVATED_MIN_BUY_SOL = 0.06;

export const MAX_CONSEC_SWAP_400 = 3;
export const MIN_OPERATING_SOL = 0.007;

export const ROUTER_COOLDOWN_MS = 60_000;

export const MINT_RUG_BLACKLIST_MS = 30 * 60 * 1000;
export const MINT_BLACKLIST_STAGES_MS = [2 * 60 * 1000, 15 * 60 * 1000, MINT_RUG_BLACKLIST_MS];

export const URGENT_SELL_COOLDOWN_MS = 20_000;
export const URGENT_SELL_MIN_AGE_MS = 7_000;

export const MAX_RECURRING_COST_FRAC = 0.0075; // tx + platform fees <= 0.75% of order
export const MAX_ONETIME_COST_FRAC = 0.02;
export const ONE_TIME_COST_AMORTIZE = 5;

export const FAST_OBS_INTERVAL_MS = 5;

export const SPLIT_FRACTIONS = [0.99, 0.98, 0.97, 0.96, 0.95, 0.9, 0.85, 0.8, 0.75, 0.7, 0.5, 0.33, 0.25, 0.2];

export const MINT_OP_LOCK_MS = 30_000;
export const BUY_SEED_TTL_MS = 60_000;
export const BUY_LOCK_MS = 5_000;

export const FAST_OBS_LOG_INTERVAL_MS = 150;
export const LEADER_SAMPLE_MIN_MS = 900;

export const RUG_FORCE_SELL_SEVERITY = 0.7;
export const RUG_QUOTE_SHOCK_FRAC = 0.35;
export const RUG_QUOTE_SHOCK_WINDOW_MS = 6000;

export const EARLY_URGENT_WINDOW_MS = 15_000; // buyers remorse

export const MAX_DOM_LOG_LINES = 100;
export const MAX_LOG_MEM_LINES = 10_000; // memory log buffer low speed optimization

export const MOMENTUM_FORCED_EXIT_CONSEC = 28;

export const POSCACHE_KEY_PREFIX = "fdv_poscache_v1:";
export const DUSTCACHE_KEY_PREFIX = "fdv_dustcache_v1:";

export const FEE_ATAS = Object.freeze({
  [SOL_MINT]: "4FSwzXe544mW2BLYqAAjcyBmFFHYgMbnA1XUdtGUeST8",
  EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v: "BKWwTmwc7FDSRb82n5o76bycH3rKZ4Xqt87EjZ2rnUXB",
});

export const UI_LIMITS = Object.freeze({
  BUY_PCT_MIN: 0.01, // 1%
  BUY_PCT_MAX: 0.5, // 50%
  MIN_BUY_SOL_MIN: 0.06,
  MIN_BUY_SOL_MAX: 1,
  MAX_BUY_SOL_MIN: Math.max(MIN_SELL_SOL_OUT, MIN_JUP_SOL_IN),
  MAX_BUY_SOL_MAX: 5,
  LIFE_MINS_MIN: 0,
  LIFE_MINS_MAX: 10080,
});

export const DYN_HS = Object.freeze({
  base: 3.8,
  min: 3.2,
  max: 6.0,
  remorseSecs: 22,
  earlySecs: 180,
  earlyMinStopPct: 12,
});

// Lightweight shared config for Auto's dex/Jupiter logic.
// Kept here so auto widgets can import it directly without cross-widget imports.
export const AUTO_CFG = Object.freeze({
  jupiterBase: "https://api.jup.ag",
  jupiterApiKey: "",
  tokenDecimals: Object.freeze({}),
});

const LOG_COLORS = {
  error: '#ff6b6b',
  success: '#51cf66',
  warn: '#fcc419',
  help: '#74c0fc',
  info: '#ffffff'
};
