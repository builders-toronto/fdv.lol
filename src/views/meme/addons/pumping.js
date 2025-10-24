import { addKpiAddon, getLatestSnapshot } from './ingest.js';

export const PUMP_STORAGE_KEY     = 'pump_history_v1';
export const PUMP_WINDOW_DAYS     = 1.5;       // short lookback favors immediacy
export const PUMP_SNAPSHOT_LIMIT  = 600;       // global cap
export const PUMP_PER_MINT_CAP    = 96;        // ~8h @ 5min CADENCE
export const PUMP_HALFLIFE_DAYS   = 0.6;       // fast decay (~14.4h half-life)
export const PUMP_MIN_LIQ_USD     = 6000;      // hard floor to avoid illiquid spikes
export const PUMP_MIN_VOL_1H_USD  = 1500;      // minimum 1h volume gate
export const PUMP_MIN_PRICE_USD   = 0;         // keep 0 to allow low-priced tokens; raise if needed
export const PUMP_BADGE_SCORE        = 1.45;   // threshold score for "🔥 Pumping" badge
export const PUMP_BADGE_CHANGE1H_PCT = 8;      // threshold 1h% change for "🔥 Pumping" badge
export const PUMP_BADGE_ACCEL5TO1    = 1.06;   // threshold 5m->1h acceleration for "🔥 Pumping" badge
export const RUG_5M_DROP_PCT  = 10;            // 5m% drop to consider for rug severity
export const RUG_MAX_PENALTY  = 0.9;           // max score penalty from rugging
export const RUG_WINDOW_MIN   = 20;            // lookback window for rug detection (minutes)
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
export function ingestPumpingSnapshot(items) {
  // console.log("ingesting pumping snapshot", items);
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

export function computePumpingScoreForMint(records, nowTs) {
  if (!Array.isArray(records) || !records.length) return { score: 0, badge: 'Calm' };

  const cutoff = nowTs - PUMP_WINDOW_DAYS*24*3600*1000;
  const recent = records.filter(e => +e.ts >= cutoff);
  if (!recent.length) return { score: 0, badge: 'Calm' };

  const latest = recent[recent.length - 1].kp || {};
  const {
    change5m=0, change1h=0, change6h=0,
    v5mTotal=0, v1hTotal=0, v6hTotal=0,
    buySell24h=0, liqUsd=0, priceUsd=0
  } = latest;

  // Hard gates
  if (liqUsd < PUMP_MIN_LIQ_USD) return { score: 0, badge: 'Calm' };
  if (v1hTotal < PUMP_MIN_VOL_1H_USD) return { score: 0, badge: 'Calm' };
  if (!Number.isFinite(priceUsd) || priceUsd <= PUMP_MIN_PRICE_USD) return { score: 0, badge: 'Calm' };

  // Decayed stats for normalization
  const dw   = decayWeights(recent, nowTs);
  const pVal = dw.map(x => Number(x.e.kp?.priceUsd) || 0);
  const pWts = dw.map(x => x.w);
  const { mean: pMean } = decayedMeanStd(pVal, pWts);

  const v1Vals = dw.map(x => Number(x.e.kp?.v1hTotal) || 0);
  const v1Wts  = dw.map(x => x.w);
  const { mean: v1Mean, std: v1Std } = decayedMeanStd(v1Vals, v1Wts);

  // Acceleration signals
  const accel5to1 = (v1hTotal > 0) ? Math.min(3, (v5mTotal * 12) / v1hTotal) : (v5mTotal > 0 ? 1 : 0);
  const accel1to6 = (v6hTotal > 0) ? Math.min(3, (v1hTotal * 6) / v6hTotal) : (v1hTotal > 0 ? 1 : 0);

  // Micro-breakout vs recent lows (last ~25% of window)
  const tail = Math.max(3, Math.floor(recent.length * 0.25));
  const lastPrices = recent.slice(-tail).map(e => e.kp?.priceUsd || 0).filter(Boolean);
  const minTail = lastPrices.length ? Math.min(...lastPrices) : priceUsd;
  const offBottom = minTail > 0 ? (priceUsd - minTail)/minTail : 0;
  const breakout  = clamp(offBottom / 0.08, 0, 1.4); // stronger than DBS, 8% rebound ~1.0

  const liqScale  = Math.log10(1 + liqUsd) / 5; // ~0..1.2 across 10^0..10^6+

  const zV1     = Math.max(0, safeZ(v1hTotal, v1Mean, v1Std)); // only reward upside

  const buyBoost = Math.max(0, (buySell24h - 0.56) * 2.0); // kick after ~56% buys

  const core =
      (change5m / 6.5)
    + (change1h / 22)
    + (change6h / 65)
    + (accel5to1 - 1) * 0.9
    + (accel1to6 - 1) * 0.7
    + buyBoost * 0.9
    + breakout * 0.8
    + Math.min(2.0, 0.6 * zV1);

  let score = Math.max(0, core) * (0.65 + 0.35 * liqScale);

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

  let badge = 'Calm';
  const strongScore = score >= 2.0;
  if (sev >= 1) {
    badge = 'Cooling';
  } else if (
    strongScore ||
    (score >= PUMP_BADGE_SCORE &&
     change1h >= PUMP_BADGE_CHANGE1H_PCT &&
     accel5to1 >= PUMP_BADGE_ACCEL5TO1)
  ) {
    badge = '🔥 Pumping';
  } else if (score >= 1.0) {
    badge = 'Warming';
  }

  return { score, badge, meta: { accel5to1, accel1to6, buy: buySell24h, zV1, liqScale, pMean, rug: { worst5m, sev, rugFactor } } };
}

export function getRugSignalForMint(mint, nowTs = Date.now()) {
  try {
    const h = prunePumpHistory(loadPumpHistory());
    const recs = (h?.byMint && h.byMint[mint]) ? h.byMint[mint] : [];
    const res = computePumpingScoreForMint(recs, nowTs) || {};
    const sev = Number(res?.meta?.rug?.sev || 0);
    const score = Number(res?.score || 0);
    const badge = res?.badge || 'Calm';
    const rugFactor = Number(res?.meta?.rug?.rugFactor || 1);
    const rugged = sev >= 1 || score <= 0;
    return { rugged, sev, rugFactor, score, badge };
  } catch {
    return { rugged: false, sev: 0, rugFactor: 1, score: 0, badge: 'Calm' };
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
const currentLeaderMints = new Set();

addKpiAddon(
  {
    id: 'pumping',
    order: 22,
    label: 'PUMP',
    title: 'Pumping Radar',
    metricLabel: 'PUMP',
    limit: 5,
  },
  {
    computePayload() {
      const snapshot = getLatestSnapshot();
      if (snapshot && snapshot.length && snapshot !== lastSnapshotRef) {
        ingestPumpingSnapshot(snapshot);
        lastSnapshotRef = snapshot;
      }
      const leaders = computePumpingLeaders(3);
      const mints = leaders.map(l => l.mint);
      const newEntries = mints.filter(m => !currentLeaderMints.has(m));
      currentLeaderMints.clear();
      mints.forEach(m => currentLeaderMints.add(m));
      return {
        title: 'Pumping Radar',
        metricLabel: 'PUMP',
        items: mapPumpingRows(leaders),
        notify: newEntries.length ? { type: 'pumping', mints: newEntries } : null,
        notifyToken: newEntries.length ? Date.now() : null,
      };
    }
  }
);
