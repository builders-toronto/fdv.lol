import { addKpiAddon, getLatestSnapshot } from '../ingest.js';
import { fetchTokenInfoLive } from '../../../../data/dexscreener.js';

const CRYPTO_FACTS = [
  'Bitcoins genesis block was mined in Jan 2009.',
  'Bitcoin halves block rewards roughly every 4 years.',
  'Ethereum introduced general-purpose smart contracts (2015).',
  '"Not your keys, not your coins" -> self-custody matters.',
  'Stablecoins aim to track the value of fiat or other assets.',
  'Gas/fees rise with network congestion and demand.',
  'Hardware wallets are a common form of cold storage.',
  'Proof of Stake and Proof of Work secure networks differently.',
  'Most chains use elliptic curve cryptography (e.g., ECDSA/EdDSA).',
  'On-chain liquidity can impact price stability and slippage.'
];

let nextFactIdx = 0;

function makeFactRow(text) {
  return {
    mint: `fact:${Date.now()}:${Math.random().toString(36).slice(2)}`,
    symbol: 'FACT',
    name: text,
    imageUrl: '',
    priceUsd: 0,
    liqUsd: 0,
    pairUrl: 'https://en.wikipedia.org/wiki/Cryptocurrency',
    chg5m: 0,
    chg1h: 0,
    chg6h: 0,
    v1hTotal: 0,
    chg24: 0,
    vol24: '💡 Random Crypto Fact',
    metric: 1337,
    placeholder: 'fact'
  };
}

function makeFallbackRows(count) {
  const rows = [];
  if (count <= 0) return rows;
  while (rows.length < count) {
    const fact = CRYPTO_FACTS[nextFactIdx++ % CRYPTO_FACTS.length];
    rows.push(makeFactRow(fact));
  }
  return rows.slice(0, count);
}


export const FOCUS_STORAGE_KEY   = 'pump_focus_top_v1';
export const FOCUS_TOP_LIMIT     = 3;
export const FOCUS_REFRESH_MS    = 6000;    // refresh the focused mints at most every 6s
export const FOCUS_MIN_SCORE     = 0.6;     // ignore very weak candidates
export const FOCUS_TICK_MS       = 1; 

export const PUMP_STORAGE_KEY     = 'pump_history_v1';
export const PUMP_WINDOW_DAYS     = 1.5;       // short lookback favors immediacy
export const PUMP_SNAPSHOT_LIMIT  = 600;       // global cap
export const PUMP_PER_MINT_CAP    = 96;        // ~8h @ 5min CADENCE
export const PUMP_HALFLIFE_DAYS   = 0.6;       // fast decay (~14.4h half-life)
export const PUMP_MIN_LIQ_USD     = 6000;      // hard floor to avoid illiquid spikes
export const PUMP_MIN_VOL_1H_USD  = 1500;      // minimum 1h volume gate
export const PUMP_MIN_PRICE_USD   = 0;         // keep 0 to allow low-priced tokens; raise if needed
export const PUMP_BADGE_SCORE        = 1.20;   // was 1.45
export const PUMP_BADGE_CHANGE1H_PCT = 5;      // was 8
export const PUMP_BADGE_ACCEL5TO1    = 1.03;   // was 1.06
export const RUG_5M_DROP_PCT  = 10;            // 5m% drop to consider for rug severity
export const RUG_MAX_PENALTY  = 0.9;           // max score penalty from rugging
export const RUG_WINDOW_MIN   = 20;            // lookback window for rug detection (minutes)
export const PUMP_MIN_DPS     = 0.0017;        // was 0.00333; allow steadier climbs to qualify
export const PUMP_TREND_WINDOW_MIN   = 60;     // look back 60 minutes for steady trend credit
export const PUMP_TREND_DECAY        = 0.92;   // EMA decay per step in window
export const PUMP_TREND_GAIN         = 0.8;    // scale of trend credit contribution
export const PUMP_MAX_DRAWDOWN_STEP  = 0.25;   // limit per-tick score drop to 25% of prev
const LN2 = Math.log(2);

function loadPumpHistory() {
  try {
    const raw = localStorage.getItem(PUMP_STORAGE_KEY);
    return raw ? JSON.parse(raw) : { byMint: {}, total: 0 };
  } catch {
    return { byMint: {}, total: 0 };
  }
}
function savePumpHistory(h) {
  try { localStorage.setItem(PUMP_STORAGE_KEY, JSON.stringify(h)); } catch {}
}
function prunePumpHistory(h) {
  const cutoff = Date.now() - PUMP_WINDOW_DAYS*24*3600*1000;
  let total = 0;
  for (const mint of Object.keys(h.byMint)) {
    let arr = Array.isArray(h.byMint[mint]) ? h.byMint[mint] : [];
    arr = arr.filter(e => +e.ts >= cutoff).slice(-PUMP_PER_MINT_CAP);
    if (arr.length) { h.byMint[mint] = arr; total += arr.length; }
    else delete h.byMint[mint];
  }
  if (total > PUMP_SNAPSHOT_LIMIT) {
    const all = [];
    for (const [mint, arr] of Object.entries(h.byMint)) {
      for (const e of arr) all.push({ mint, ...e });
    }
    all.sort((a,b)=>a.ts-b.ts);
    const keep = all.slice(-PUMP_SNAPSHOT_LIMIT);
    const next = { byMint: {}, total: keep.length };
    for (const e of keep) {
      (next.byMint[e.mint] ||= []).push({ ts: e.ts, kp: e.kp });
    }
    return next;
  }
  h.total = total;
  return h;
}

function norm(n) { return Number.isFinite(n) ? Number(n) : 0; }


let counter = 1

export function ingestPumpingSnapshot(items) {
  const h = loadPumpHistory();
  const ts = Date.now();
  const arr = (Array.isArray(items) ? items : []).map(t => {
    const change = t.change ?? {};
    const chgArr = Array.isArray(t._chg) ? t._chg : [];

    const rawV5m = norm(t.v5mTotal ?? t.vol5mUsd ?? t.vol5mUSD ?? t?.volume?.m5);
    const rawV1h = norm(t.v1hTotal ?? t.vol1hUsd ?? t.vol1hUSD ?? t?.volume?.h1);
    const rawV6h = norm(t.v6hTotal ?? t.vol6hUsd ?? t.vol6hUSD ?? t?.volume?.h6);
    const vol24h = norm(t.vol24hUsd ?? t.vol24hUSD ?? t?.volume?.h24);
    const fallbackV1h = rawV1h > 0 ? rawV1h : (vol24h > 0 ? vol24h / 24 : 0);
    const fallbackV6h = rawV6h > 0 ? rawV6h : (vol24h > 0 ? vol24h / 4 : (fallbackV1h > 0 ? fallbackV1h * 6 : 0));

    const kp = {
      mint     : t.mint || t.id,
      symbol   : t.symbol || '',
      name     : t.name || '',
      imageUrl : t.imageUrl || t.logoURI || '',
      pairUrl  : t.pairUrl || '',

      // prices & liquidity
      priceUsd : norm(t.priceUsd ?? t.priceUSD ?? t.price),
      liqUsd   : norm(t.liqUsd   ?? t.liquidityUsd ?? t.liquidityUSD ?? t.liquidity),

      // % changes
      change5m : norm(t.change5m ?? t.chg5m ?? change.m5 ?? chgArr[0]),
      change1h : norm(t.change1h ?? t.chg1h ?? change.h1 ?? chgArr[1]),
      change6h : norm(t.change6h ?? t.chg6h ?? change.h6 ?? chgArr[2]),
      change24h: norm(t.change24h ?? t.chg24 ?? change.h24 ?? chgArr[3]),

      // short-horizon volumes (USD)
      v5mTotal : rawV5m > 0 ? rawV5m : 0,
      v1hTotal : fallbackV1h,
      v6hTotal : fallbackV6h,

      // buy:sell ratio over 24h (0..1)
      buySell24h: (() => {
        const v = t.buySell24h ?? t.buyRatio24h ?? t.bs24;
        return Number.isFinite(v) ? v : 0;
      })(),
    };
    return kp;
  }).filter(kp => kp?.mint);

  for (const kp of arr) {
    (h.byMint[kp.mint] ||= []).push({ ts, kp });
    if (h.byMint[kp.mint].length > PUMP_PER_MINT_CAP) {
      h.byMint[kp.mint] = h.byMint[kp.mint].slice(-PUMP_PER_MINT_CAP);
    }
  }
  h.total = Object.values(h.byMint).reduce((a,arr)=>a+arr.length,0);
  savePumpHistory(prunePumpHistory(h));
}

function decayWeights(records, nowTs, halflifeDays = PUMP_HALFLIFE_DAYS) {
  const lambda = LN2 / Math.max(1e-6, halflifeDays);
  return records.map(e => {
    const ageDays = (nowTs - (+e.ts)) / (24*3600*1000);
    const w = ageDays >= 0 ? Math.exp(-lambda * ageDays) : 0;
    return { e, w };
  }).filter(x => x.w > 0);
}

function decayedMeanStd(vals, wts) {
  const w = wts.reduce((a,b)=>a+b,0);
  if (w <= 0) return { mean: 0, std: 0 };
  const mean = vals.reduce((a,v,i)=>a+v*wts[i],0) / w;
  const varNum = vals.reduce((a,v,i)=>a + wts[i]*(v-mean)*(v-mean), 0);
  const std = Math.sqrt(Math.max(0, varNum / Math.max(1e-9, w)));
  return { mean, std };
}
const clamp  = (x, lo, hi) => Math.min(hi, Math.max(lo, x));
const safeZ  = (x, m, s) => s > 0 ? (x - m) / s : 0;

// Compute the core pump score for a given context
function _computeCoreScore(recent, nowTs) {
  if (!Array.isArray(recent) || recent.length === 0) {
    return { score: 0, meta: { rug: { sev: 0, rugFactor: 1, worst5m: 0 } }, latest: {} };
  }

  const latest = recent[recent.length - 1].kp || {};
  const {
    change5m=0, change1h=0, change6h=0,
    v5mTotal=0, v1hTotal=0, v6hTotal=0,
    buySell24h=0, liqUsd=0, priceUsd=0
  } = latest;

  // Hard gates
  if (liqUsd < PUMP_MIN_LIQ_USD || v1hTotal < PUMP_MIN_VOL_1H_USD || !Number.isFinite(priceUsd) || priceUsd <= PUMP_MIN_PRICE_USD) {
    return { score: 0, meta: { rug: { sev: 0, rugFactor: 1, worst5m: 0 } }, latest };
  }

  const dw   = decayWeights(recent, nowTs);
  const pVal = dw.map(x => Number(x.e.kp?.priceUsd) || 0);
  const pWts = dw.map(x => x.w);
  const { mean: pMean } = decayedMeanStd(pVal, pWts);

  const v1Vals = dw.map(x => Number(x.e.kp?.v1hTotal) || 0);
  const v1Wts  = dw.map(x => x.w);
  const { mean: v1Mean, std: v1Std } = decayedMeanStd(v1Vals, v1Wts);

  const accel5to1 = (v1hTotal > 0) ? Math.min(3, (v5mTotal * 12) / v1hTotal) : (v5mTotal > 0 ? 1 : 0);
  const accel1to6 = (v6hTotal > 0) ? Math.min(3, (v1hTotal * 6) / v6hTotal) : (v1hTotal > 0 ? 1 : 0);

  const tail = Math.max(3, Math.floor(recent.length * 0.25));
  const lastPrices = recent.slice(-tail).map(e => e.kp?.priceUsd || 0).filter(Boolean);
  const minTail = lastPrices.length ? Math.min(...lastPrices) : priceUsd;
  const offBottom = minTail > 0 ? (priceUsd - minTail)/minTail : 0;
  const breakout  = clamp(offBottom / 0.08, 0, 1.4);

  const liqScale  = Math.log10(1 + liqUsd) / 5;
  const zV1       = Math.max(0, safeZ(v1hTotal, v1Mean, v1Std));
  const buyBoost  = Math.max(0, (buySell24h - 0.56) * 2.0);

  const core =
      (change5m / 6.5)
    + (change1h / 22)
    + (change6h / 65)
    + (accel5to1 - 1) * 0.9
    + (accel1to6 - 1) * 0.7
    + buyBoost * 0.9
    + breakout * 0.8
    + Math.min(2.0, 0.6 * zV1);

  const trendMs = PUMP_TREND_WINDOW_MIN * 60 * 1000;
  let trendCredit = 0;
  for (let i = recent.length - 1; i >= 0; i--) {
    const e = recent[i];
    if (nowTs - (+e.ts) > trendMs) break;
    const r5  = Number(e.kp?.change5m ?? 0);
    const r1h = Number(e.kp?.change1h ?? 0);
    const pos = Math.max(0, r5) / 8 + Math.max(0, r1h) / 24; // normalized contribution
    const neg = Math.max(0, -r5) / 15;                       // mild penalty for red 5m
    trendCredit = trendCredit * PUMP_TREND_DECAY + pos - neg;
  }
  trendCredit = clamp(trendCredit * PUMP_TREND_GAIN, 0, 1.6);

  let score = Math.max(0, core + trendCredit) * (0.65 + 0.35 * liqScale);

  // Rug penalty window anchored to nowTs
  const windowCut = nowTs - (RUG_WINDOW_MIN * 60 * 1000);
  const windowRecs = recent.filter(e => (+e.ts) >= windowCut);
  const worst5m = windowRecs.length
    ? Math.min(...windowRecs.map(e => Number(e.kp?.change5m ?? 0)))
    : change5m;

  const sevNow    = change5m < 0 ? clamp((-change5m) / Math.max(1, RUG_5M_DROP_PCT), 0, 4) : 0;
  const sevWindow = worst5m   < 0 ? clamp((-worst5m) / Math.max(1, RUG_5M_DROP_PCT), 0, 4) : 0;
  const sev = Math.max(sevNow, sevWindow);
  const rawFactor = 1 / (1 + 3 * sev);
  const rugFactor = 1 - Math.min(RUG_MAX_PENALTY, 1 - rawFactor);
  score *= rugFactor;

  const risingNow = (change1h > 0) && (change5m >= 0 || accel5to1 > 1);
  const trendUp = (() => {
    const len = lastPrices.length;
    if (len >= 3) {
      const xMean = (len - 1) / 2;
      const yMean = lastPrices.reduce((a, v) => a + v, 0) / len;
      let num = 0, den = 0;
      for (let i = 0; i < len; i++) {
        const dx = i - xMean;
        num += dx * (lastPrices[i] - yMean);
        den += dx * dx;
      }
      const slope = den > 0 ? num / den : 0;
      return slope > 0;
    }
    return change1h > 0;
  })();

  return {
    score,
    meta: { accel5to1, accel1to6, buy: buySell24h, zV1, liqScale, pMean, rug: { worst5m, sev, rugFactor }, risingNow, trendUp },
    latest
  };
}

export function computePumpingScoreForMint(records, nowTs) {
  if (!Array.isArray(records) || !records.length) return { score: 0, badge: '📉 Calm' };

  const cutoff = nowTs - PUMP_WINDOW_DAYS*24*3600*1000;
  const recent = records.filter(e => +e.ts >= cutoff);
  if (!recent.length) return { score: 0, badge: '📉 Calm' };
  // Compute previous snapshot context (for inertia and slope)
  let prevScore = 0, prevTs = 0, curTs = 0;
  if (recent.length >= 2) {
    prevTs = +recent[recent.length - 2].ts;
    curTs  = +recent[recent.length - 1].ts;
    const prev = _computeCoreScore(recent.slice(0, -1), prevTs);
    prevScore = prev.score || 0;
  }

  // Compute current score context
  const cur = _computeCoreScore(recent, nowTs);
  let { score } = cur;

  if (recent.length >= 2 && score < prevScore && prevScore > 0) {
    const maxDrop = prevScore * PUMP_MAX_DRAWDOWN_STEP;
    score = Math.max(score, prevScore - maxDrop);
  }

  // Compute slope (points per second) using adjusted score
  let dps = 0;
  if (recent.length >= 2) {
    const dtSec = Math.max(1, (curTs - prevTs) / 1000);
    dps = (score - prevScore) / dtSec;
  }

  const latest = recent[recent.length - 1].kp || {};
  const {
    change5m=0, change1h=0, change6h=0
  } = latest;

  let badge = '📉 Calm';
  const strongScore = score >= 1.6; // was 2.0 (looser)

  // Maintain Cooling precedence on rug severity
  if ((cur.meta?.rug?.sev || 0) >= 1) {
    badge = '🥶 Cooling';
  } else {
    const risingNow = !!cur.meta?.risingNow;
    const trendUp   = !!cur.meta?.trendUp;
    const pumpingCandidate =
      (strongScore && (risingNow || trendUp)) ||
      (score >= PUMP_BADGE_SCORE &&
       (change1h >= PUMP_BADGE_CHANGE1H_PCT || (cur.meta?.accel5to1 || 0) >= PUMP_BADGE_ACCEL5TO1) &&
       (risingNow || trendUp));

    const warmingCandidate = score >= 0.6 && (change1h > 0 || change6h > 0 || change5m >= 0);

    // Gate "Pumping" on a positive score slope (points per second)
    if (pumpingCandidate && dps > PUMP_MIN_DPS) {
      badge = '🔥 Pumping';
    } else if (warmingCandidate) {
      badge = '🌡 Warming';
    }
  }

  return {
    score,
    badge,
    meta: { ...(cur.meta || {}), slopeDps: dps, prevScore }
  };
}

export function getRugSignalForMint(mint, nowTs = Date.now()) {
  try {
    const h = prunePumpHistory(loadPumpHistory());
    const recs = (h?.byMint && h.byMint[mint]) ? h.byMint[mint] : [];
    const res = computePumpingScoreForMint(recs, nowTs) || {};
    const sev = Number(res?.meta?.rug?.sev || 0);
    const score = Number(res?.score || 0);
    const badge = res?.badge || '📉 Calm';
    const rugFactor = Number(res?.meta?.rug?.rugFactor || 1);
    const rugged = sev >= 1 || score <= 0;
    return { rugged, sev, rugFactor, score, badge };
  } catch {
    return { rugged: false, sev: 0, rugFactor: 1, score: 0, badge: '📉 Calm' };
  }
}

export async function focusMint(mint, { refresh = true, ttlMs = 2000, signal } = {}) {
  const id = String(mint || '').trim();
  if (!id) return { ok: false, error: 'Missing mint' };

  try {
    if (refresh) {
      try {
        const live = await fetchTokenInfoLive(id, { ttlMs, signal });
        if (live && !live.error) {
          const item = {
            mint: live.mint,
            symbol: live.symbol,
            name: live.name,
            imageUrl: live.imageUrl,
            pairUrl: live.headlineUrl,
            priceUsd: live.priceUsd,
            liquidityUsd: live.liquidityUsd,
            liqUsd: live.liquidityUsd, // ensure mapper sees it
            change5m: live.change5m,
            change1h: live.change1h,
            change6h: live.change6h,
            change24h: live.change24h,
            v5mTotal: live.v5mTotal,
            v1hTotal: live.v1hTotal,
            v6hTotal: live.v6hTotal,
            vol24hUsd: live.v24hTotal,
            buySell24h: live.buySell24h,
          };
          ingestPumpingSnapshot([item]);
        }
      } catch {
      }
    }

    const h = prunePumpHistory(loadPumpHistory());
    const recs = (h?.byMint && h.byMint[id]) ? h.byMint[id] : [];
    const now = Date.now();
    const { score, badge, meta } = computePumpingScoreForMint(recs, now);

    const latest = recs.length ? (recs[recs.length - 1].kp || {}) : {};
    const pumpScore = Number((score || 0).toFixed(2));
    const aggLike = [{ mint: id, kp: latest, pumpScore, badge }];
    const row = mapPumpingRows(aggLike)[0] || null;

    return {
      ok: true,
      mint: id,
      pumpScore,
      badge: badge || '📉 Calm',
      kp: latest,
      meta: meta || {},
      row, 
      payload: {
        title: 'Pumping Focus',
        metricLabel: 'PUMP',
        items: row ? [row] : [],
      },
    };
  } catch (e) {
    return { ok: false, error: e?.message || 'focusMint error' };
  }
}

export function computePumpingLeaders(limit = 5) {
  const h = prunePumpHistory(loadPumpHistory());
  const now = Date.now();
  const out = [];

  for (const [mint, arr] of Object.entries(h.byMint)) {
    const { score, badge, meta } = computePumpingScoreForMint(arr, now);
    if (score <= 0) continue;
    const latest = arr[arr.length - 1]?.kp || {};
    out.push({ mint, pumpScore: Number(score.toFixed(2)), badge, kp: latest, meta });
  }


  out.sort((a,b)=> b.pumpScore - a.pumpScore);
  return out.slice(0, limit);
}

// Inline sparkline config (match register.js SPARK_LENGTH=24)
const SPARK_INLINE_LENGTH = 24;
const SPARK_INLINE_LOOKBACK_MS = 60 * 60 * 1000;   // 1h
const SPARK_INLINE_MIN_POINTS = 3;

// Build a percent-change sparkline series from local pump history for a mint
function buildInlineChgFromHistory(mint, now = Date.now()) {
  try {
    const h = prunePumpHistory(loadPumpHistory());
    const recs = h?.byMint?.[mint] || [];
    if (!recs || recs.length < 2) return [];

    // limit to lookback and map valid price points
    const cutoff = now - SPARK_INLINE_LOOKBACK_MS;
    const pts = recs
      .filter(r => (Number(r.ts) || 0) >= cutoff && Number(r?.kp?.priceUsd) > 0)
      .map(r => ({ ts: Number(r.ts), p: Number(r.kp.priceUsd) }))
      .sort((a, b) => a.ts - b.ts);

    if (pts.length < SPARK_INLINE_MIN_POINTS) return [];

    // percent change relative to first valid price in window
    const base = pts[0].p;
    if (!Number.isFinite(base) || base <= 0) return [];

    const raw = pts.map(pt => ((pt.p / base) - 1) * 100);

    // downsample to SPARK_INLINE_LENGTH uniformly
    const n = raw.length;
    if (n <= SPARK_INLINE_LENGTH) return raw;
    const step = (n - 1) / (SPARK_INLINE_LENGTH - 1);
    const out = [];
    for (let i = 0; i < SPARK_INLINE_LENGTH; i++) {
      out.push(raw[Math.round(i * step)]);
    }
    return out;
  } catch {
    return [];
  }
}

// Wrap mapPumpingRows to attach _chg series per row
function mapPumpingRowsWithChg(agg) {
  const rows = mapPumpingRows(agg);
  return rows.map(r => ({
    ...r,
    _chg: Array.isArray(r._chg) && r._chg.length > 1
      ? r._chg
      : buildInlineChgFromHistory(r.mint)
  }));
}

function mapPumpingRows(agg) {
  return agg.map(it => ({
    mint     : it.mint,
    symbol   : it.kp?.symbol || '',
    name     : it.kp?.name || '',
    imageUrl : it.kp?.imageUrl || '',
    priceUsd : it.kp?.priceUsd ?? 0,
    liqUsd   : it.kp?.liqUsd ?? 0,
    pairUrl  : it.kp?.pairUrl || '',
    chg5m    : it.kp?.change5m ?? 0,
    chg1h    : it.kp?.change1h ?? 0,
    chg6h    : it.kp?.change6h ?? 0,
    v1hTotal : it.kp?.v1hTotal ?? 0,
    chg24   : it.kp?.change24h ?? 0,
    vol24      : it.badge,            // "🔥 Pumping" | "Warming" | "Calm"
    metric   : it.pumpScore         
  }));
}

let lastSnapshotRef = null;
// const currentLeaderMints = new Set();

addKpiAddon(
  {
    id: 'pumping',
    updateMode: 'realtime',
    updateHz: 60,
    ingestLimit: 64,
    order: 3,
    label: 'PUMP',
    title: 'Pumping Radar',
    metricLabel: 'PUMP',
    limit: 9,
  },
  {
    computePayload() {
      const snapshot = getLatestSnapshot();
      if (snapshot && snapshot.length && snapshot !== lastSnapshotRef) {
        ingestPumpingSnapshot(snapshot);
        lastSnapshotRef = snapshot;

        // derive candidate mints from the just-ingested snapshot
        const snapshotMints = snapshot.map(t => t?.mint || t?.id).filter(Boolean);
        // kick async focus updater; do not await
        tickFocus({ snapshotMints }).catch(()=>{});
      } else {
        // still advance the focus refresh loop periodically
        tickFocus().catch(()=>{});
      }

      // Use the current focus cache as the Top-3 displayed list
      const top = rankFocusTop(focusStoreCache);
      let rows = buildFocusRows(top);

      // pad if warming up
      const need = Math.max(0, FOCUS_TOP_LIMIT - rows.length);
      if (need > 0) {
        rows = rows.concat(makeFallbackRows(need));
      }

      // notify entrants/drops for registration & downstream widgets
      const visibleMints = new Set(top.map(r => r.mint));
      const newEntrants = [...visibleMints].filter(m => !focusPrevVisibleSet.has(m));
      const dropped = [...focusPrevVisibleSet].filter(m => !visibleMints.has(m));
      focusPrevVisibleSet = visibleMints;

      return {
        title: 'Pumping Radar',
        metricLabel: 'PUMP',
        items: rows,
        notify: (newEntrants.length || dropped.length)
          ? { type: 'pumping-focus', mints: [...visibleMints], newEntrants, dropped }
          : null,
        notifyToken: (newEntrants.length || dropped.length) ? Date.now() : null,
      };
    }
  }
);

function loadFocusStore() {
  try {
    const raw = localStorage.getItem(FOCUS_STORAGE_KEY);
    return raw ? JSON.parse(raw) : { byMint: {} };
  } catch {
    return { byMint: {} };
  }
}
function saveFocusStore(s) {
  try { localStorage.setItem(FOCUS_STORAGE_KEY, JSON.stringify(s)); } catch {}
}
function pruneFocusStore(s, now = Date.now()) {
  // prune entries that have no score or have not been seen within pump window
  const cutoff = now - PUMP_WINDOW_DAYS * 24 * 3600 * 1000;
  for (const [mint, e] of Object.entries(s.byMint)) {
    const lastSeen = Number(e.lastSeenTs || 0);
    const lastScore = Number(e.lastScore || 0);
    if (!lastScore || !lastSeen || lastSeen < cutoff) delete s.byMint[mint];
  }
  return s;
}

function computeScoreForMintId(mint, now = Date.now()) {
  const h = prunePumpHistory(loadPumpHistory());
  const recs = (h?.byMint && h.byMint[mint]) ? h.byMint[mint] : [];
  const { score, badge } = computePumpingScoreForMint(recs, now);
  const latest = recs.length ? (recs[recs.length - 1].kp || {}) : {};
  const lastSeenTs = recs.length ? Number(recs[recs.length - 1].ts) : now;
  const pumpScore = Number((score || 0).toFixed(2));
  return { mint, pumpScore, badge: badge || '📉 Calm', kp: latest, lastSeenTs };
}

function rankFocusTop(store) {
  const arr = Object.values(store.byMint || {});
  arr.sort((a, b) => Number(b.lastScore || 0) - Number(a.lastScore || 0));
  return arr.slice(0, FOCUS_TOP_LIMIT);
}

function updateFocusFromCandidates(store, candidateMints, now = Date.now()) {
  const seen = new Set((candidateMints || []).filter(Boolean).map(String));
  if (!seen.size) return store;

  // current ranked focus list
  let focus = rankFocusTop(store);

  for (const mint of seen) {
    const res = computeScoreForMintId(mint, now);
    if (!res.mint) continue;
    if (res.pumpScore <= 0 || res.pumpScore < FOCUS_MIN_SCORE) continue;

    const prev = store.byMint[res.mint];
    if (prev) {
      // update existing focus entry
      store.byMint[res.mint] = {
        mint: res.mint,
        lastScore: res.pumpScore,
        lastBadge: res.badge,
        lastSeenTs: res.lastSeenTs,
        lastEvalTs: now,
        kp: {
          symbol: res.kp?.symbol || prev.kp?.symbol || '',
          name: res.kp?.name || prev.kp?.name || '',
          imageUrl: res.kp?.imageUrl || prev.kp?.imageUrl || '',
          priceUsd: Number(res.kp?.priceUsd ?? prev.kp?.priceUsd ?? 0),
          liqUsd: Number(res.kp?.liqUsd ?? prev.kp?.liqUsd ?? 0),
          pairUrl: res.kp?.pairUrl || prev.kp?.pairUrl || '',
          change5m: Number(res.kp?.change5m ?? prev.kp?.change5m ?? 0),
          change1h: Number(res.kp?.change1h ?? prev.kp?.change1h ?? 0),
          change6h: Number(res.kp?.change6h ?? prev.kp?.change6h ?? 0),
          change24h: Number(res.kp?.change24h ?? prev.kp?.change24h ?? 0),
          v1hTotal: Number(res.kp?.v1hTotal ?? prev.kp?.v1hTotal ?? 0),
        }
      };
    } else {
      // candidate not in focus; if focus not full, add, else compare to lowest
      focus = rankFocusTop(store); // refresh local snapshot
      if (focus.length < FOCUS_TOP_LIMIT) {
        store.byMint[res.mint] = {
          mint: res.mint,
          lastScore: res.pumpScore,
          lastBadge: res.badge,
          lastSeenTs: res.lastSeenTs,
          lastEvalTs: now,
          kp: {
            symbol: res.kp?.symbol || '',
            name: res.kp?.name || '',
            imageUrl: res.kp?.imageUrl || '',
            priceUsd: Number(res.kp?.priceUsd ?? 0),
            liqUsd: Number(res.kp?.liqUsd ?? 0),
            pairUrl: res.kp?.pairUrl || '',
            change5m: Number(res.kp?.change5m ?? 0),
            change1h: Number(res.kp?.change1h ?? 0),
            change6h: Number(res.kp?.change6h ?? 0),
            change24h: Number(res.kp?.change24h ?? 0),
            v1hTotal: Number(res.kp?.v1hTotal ?? 0),
          }
        };
      } else {
        const lowest = focus[focus.length - 1];
        if (!lowest || res.pumpScore > Number(lowest.lastScore || 0)) {
          delete store.byMint[lowest.mint];
          store.byMint[res.mint] = {
            mint: res.mint,
            lastScore: res.pumpScore,
            lastBadge: res.badge,
            lastSeenTs: res.lastSeenTs,
            lastEvalTs: now,
            kp: {
              symbol: res.kp?.symbol || '',
              name: res.kp?.name || '',
              imageUrl: res.kp?.imageUrl || '',
              priceUsd: Number(res.kp?.priceUsd ?? 0),
              liqUsd: Number(res.kp?.liqUsd ?? 0),
              pairUrl: res.kp?.pairUrl || '',
              change5m: Number(res.kp?.change5m ?? 0),
              change1h: Number(res.kp?.change1h ?? 0),
              change6h: Number(res.kp?.change6h ?? 0),
              change24h: Number(res.kp?.change24h ?? 0),
              v1hTotal: Number(res.kp?.v1hTotal ?? 0),
            }
          };
        }
      }
    }
  }
  return store;
}

async function refreshFocusTracked(store, now = Date.now(), { ttlMs = 2000, signal } = {}) {
  const focus = rankFocusTop(store);
  const promises = [];
  for (const e of focus) {
    const lastEval = Number(e.lastEvalTs || 0);
    if (now - lastEval < FOCUS_REFRESH_MS) continue;
    promises.push(
      focusMint(e.mint, { refresh: true, ttlMs, signal })
        .catch(() => ({ ok: false }))
        .then(() => {
          // after refresh, recompute locally from history
          const res = computeScoreForMintId(e.mint, Date.now());
          store.byMint[e.mint] = {
            mint: e.mint,
            lastScore: res.pumpScore,
            lastBadge: res.badge,
            lastSeenTs: res.lastSeenTs,
            lastEvalTs: Date.now(),
            kp: {
              symbol: res.kp?.symbol || e.kp?.symbol || '',
              name: res.kp?.name || e.kp?.name || '',
              imageUrl: res.kp?.imageUrl || e.kp?.imageUrl || '',
              priceUsd: Number(res.kp?.priceUsd ?? e.kp?.priceUsd ?? 0),
              liqUsd: Number(res.kp?.liqUsd ?? e.kp?.liqUsd ?? 0),
              pairUrl: res.kp?.pairUrl || e.kp?.pairUrl || '',
              change5m: Number(res.kp?.change5m ?? e.kp?.change5m ?? 0),
              change1h: Number(res.kp?.change1h ?? e.kp?.change1h ?? 0),
              change6h: Number(res.kp?.change6h ?? e.kp?.change6h ?? 0),
              change24h: Number(res.kp?.change24h ?? e.kp?.change24h ?? 0),
              v1hTotal: Number(res.kp?.v1hTotal ?? e.kp?.v1hTotal ?? 0),
            }
          };
        })
    );
  }
  if (promises.length) await Promise.all(promises);
  return store;
}

function buildFocusRows(topList) {
  const agg = topList.map(e => ({
    mint: e.mint,
    pumpScore: Number((e.lastScore || 0).toFixed(2)),
    badge: e.lastBadge || '📉 Calm',
    kp: e.kp || {}
  }));
  return mapPumpingRowsWithChg(agg);
}

let focusStoreCache = pruneFocusStore(loadFocusStore());
let focusTickInflight = false;
let focusPrevVisibleSet = new Set();
let focusSeeded = false;

async function tickFocus({ snapshotMints } = {}) {
  if (focusTickInflight) return;
  focusTickInflight = true;
  try {
    let now = Date.now();
    focusStoreCache = pruneFocusStore(focusStoreCache, now);

    // Seed once if empty and no candidates yet (one-off light scan)
    if (!focusSeeded && Object.keys(focusStoreCache.byMint).length === 0 && (!snapshotMints || snapshotMints.length === 0)) {
      try {
        const seed = computePumpingLeaders(FOCUS_TOP_LIMIT * 2);
        const seedMints = seed.map(s => s.mint);
        focusStoreCache = updateFocusFromCandidates(focusStoreCache, seedMints, now);
      } catch {}
      focusSeeded = true;
    }

    // Compare incoming candidates vs current focus set
    if (Array.isArray(snapshotMints) && snapshotMints.length) {
      focusStoreCache = updateFocusFromCandidates(focusStoreCache, snapshotMints, now);
    }

    // Refresh the tracked mints asynchronously
    now = Date.now();
    await refreshFocusTracked(focusStoreCache, now);

    // After refresh, re-check if any tracked mints fell below zero; keep only best 3
    const ranked = rankFocusTop(focusStoreCache);
    const keepSet = new Set(ranked.map(e => e.mint));
    for (const mint of Object.keys(focusStoreCache.byMint)) {
      if (!keepSet.has(mint)) delete focusStoreCache.byMint[mint];
    }

    saveFocusStore(focusStoreCache);
  } finally {
    focusTickInflight = false;
  }
}

// Start a hot loop that scans every 1 ms
let focusLoopStarted = false;
function startFocusLoop() {
  if (focusLoopStarted) return;
  focusLoopStarted = true;

  const run = () => tickFocus().catch(()=>{});
  // Kick immediately
  Promise.resolve().then(run);
  // Then loop at 1 ms
  setInterval(run, FOCUS_TICK_MS);
}
startFocusLoop();
