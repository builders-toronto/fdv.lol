import { addKpiAddon } from './ingest.js';

export const DBS_STORAGE_KEY = 'meme_dbs_history_v1';
export const DBS_WINDOW_DAYS = 3;            // trailing lookback
export const DBS_SNAPSHOT_LIMIT = 400;       // global cap
export const DBS_PER_MINT_CAP = 80;          // per-mint cap
export const DBS_HALFLIFE_DAYS = 1.25;       // decay half-life (favors recency)
export const DBS_MIN_LIQ_USD = 5000;         // liquidity gate
export const DBS_MIN_VOL_USD = 1000;         // volume gate
const LN2 = Math.log(2);

function loadDbsHistory() {
  try {
    const raw = localStorage.getItem(DBS_STORAGE_KEY);
    return raw ? JSON.parse(raw) : { byMint: {}, total: 0 };
  } catch {
    return { byMint: {}, total: 0 };
  }
}
function saveDbsHistory(h) {
  try { localStorage.setItem(DBS_STORAGE_KEY, JSON.stringify(h)); } catch {}
}
function pruneDbsHistory(h) {
  const cutoff = Date.now() - DBS_WINDOW_DAYS*24*3600*1000;
  let total = 0;
  for (const mint of Object.keys(h.byMint)) {
    let arr = Array.isArray(h.byMint[mint]) ? h.byMint[mint] : [];
    arr = arr.filter(e => +e.ts >= cutoff).slice(-DBS_PER_MINT_CAP);
    if (arr.length) { h.byMint[mint] = arr; total += arr.length; }
    else delete h.byMint[mint];
  }
  if (total > DBS_SNAPSHOT_LIMIT) {
    const all = [];
    for (const [mint, arr] of Object.entries(h.byMint)) {
      for (const e of arr) all.push({ mint, ...e });
    }
    all.sort((a,b)=>a.ts-b.ts);
    const keep = all.slice(-DBS_SNAPSHOT_LIMIT);
    const next = { byMint: {}, total: keep.length };
    for (const e of keep) {
      (next.byMint[e.mint] ||= []).push({ ts: e.ts, kp: e.kp });
    }
    return next;
  }
  h.total = total;
  return h;
}

export function updateDbsHistory(items) {
  const h = loadDbsHistory();
  const ts = Date.now();
  const scored = (Array.isArray(items) ? items : []).map(it => ({
    mint: it.mint || it.id,
    symbol: it.symbol || '',
    name: it.name || '',
    imageUrl: it.imageUrl || it.logoURI || '',
    pairUrl: it.pairUrl || '',
    priceUsd: Number(it?.priceUsd) || 0,
    chg24: Number(it?.chg24 ?? it?.change?.h24) || 0,
    liqUsd: Number(it?.liqUsd ?? it?.liquidityUsd) || 0,
    vol24: Number(it?.vol24 ?? it?.volume?.h24) || 0
  }));
  for (const it of scored) {
    const entry = { ts, kp: it };
    (h.byMint[it.mint] ||= []).push(entry);
    if (h.byMint[it.mint].length > DBS_PER_MINT_CAP) {
      h.byMint[it.mint] = h.byMint[it.mint].slice(-DBS_PER_MINT_CAP);
    }
  }
  h.total = Object.values(h.byMint).reduce((a,arr)=>a+arr.length,0);
  saveDbsHistory(pruneDbsHistory(h));
}

function decayWeights(arr, nowTs, halflifeDays = DBS_HALFLIFE_DAYS) {
  const lambda = LN2 / Math.max(1e-6, halflifeDays);
  return arr.map(e => {
    const ageDays = (nowTs - (+e.ts)) / (24*3600*1000);
    const w = ageDays >= 0 ? Math.exp(-lambda * ageDays) : 0;
    return { e, w };
  }).filter(x => x.w > 0);
}
function decayedMeanStd(vals, weights) {
  const wsum = weights.reduce((a,b)=>a+b,0);
  if (wsum <= 0) return { mean: 0, std: 0 };
  const mean = vals.reduce((a,v,i)=>a+v*weights[i],0) / wsum;
  const varNum = vals.reduce((a,v,i)=>a+weights[i]*(v-mean)*(v-mean),0);
  const varDen = wsum; // population-style with weights
  const std = Math.sqrt(Math.max(0, varNum / Math.max(1e-9, varDen)));
  return { mean, std };
}
function clamp(x, lo, hi){ return Math.min(hi, Math.max(lo, x)); }
function safeZ(x, mean, std){ return std > 0 ? (x - mean)/std : 0; }

function computeDBSForMint(arr, nowTs) {
  if (!Array.isArray(arr) || arr.length === 0) return 0;

  const cutoff = nowTs - DBS_WINDOW_DAYS*24*3600*1000;
  const recent = arr.filter(e => +e.ts >= cutoff);
  if (!recent.length) return 0;

  const latest = recent[recent.length - 1].kp || {};
  const { chg24 = 0, vol24 = 0, liqUsd = 0, priceUsd = 0 } = latest;

  if (liqUsd < DBS_MIN_LIQ_USD) return 0;
  if (vol24 < DBS_MIN_VOL_USD) return 0;
  if (!Number.isFinite(priceUsd) || priceUsd <= 0) return 0;
  const dw = decayWeights(recent, nowTs);
  const volVals = dw.map(x => Number(x.e.kp?.vol24) || 0);
  const volWts  = dw.map(x => x.w);
  const priceVals = dw.map(x => Number(x.e.kp?.priceUsd) || 0);
  const priceWts  = dw.map(x => x.w);
  const { mean: volMean, std: volStd } = decayedMeanStd(volVals, volWts);
  const { mean: priceMean }           = decayedMeanStd(priceVals, priceWts);
  const pain = clamp(-chg24, 0, 100);                 // 0..100
  const zVol = Math.max(0, safeZ(vol24, volMean, volStd));  // 0..∞, but typically 0..5
  const lastK = recent.slice(-5).map(e => e.kp?.priceUsd || 0);
  const minRecent = Math.min(...lastK, priceUsd);
  const offBottom = minRecent > 0 ? (priceUsd - minRecent) / minRecent : 0; // 0..+
  const bounce = clamp(offBottom / 0.10, 0, 1);
  const cheapness = priceMean > 0 ? clamp((priceMean - priceUsd) / priceMean, 0, 1) : 0;
  const base = Math.pow(pain, 0.70);                       // temper outlier dumps
  const conviction = (1 + 0.75*zVol) * (1 + 0.50*bounce) * (1 + 0.25*cheapness);
  const liqScale = Math.log10(1 + liqUsd) / 5;             // ~0..1.2 across 10^0..10^6+
  const score = Math.round(base * conviction * (0.6 + 0.4*liqScale));

  return score; // typical 0..200+ in spicy conditions
}

export function computeDbsLeaders(limit = 3) {
  const h = pruneDbsHistory(loadDbsHistory());
  const now = Date.now();
  const agg = [];

  for (const [mint, arr] of Object.entries(h.byMint)) {
    const score = computeDBSForMint(arr, now);
    if (score <= 0) continue;
    const latest = arr[arr.length - 1]?.kp || {};
    agg.push({ mint, dbsScore: score, kp: latest });
  }

  agg.sort((a,b)=> b.dbsScore - a.dbsScore);
  return agg.slice(0, limit);
}

function mapAggToRegistryRows(agg) {
  return agg.map(it => ({
    mint: it.mint,
    symbol: it.kp?.symbol || '',
    name: it.kp?.name || '',
    imageUrl: it.kp?.imageUrl || '',
    priceUsd: it.kp?.priceUsd ?? 0,
    chg24: it.kp?.chg24 ?? 0,
    liqUsd: it.kp?.liqUsd ?? 0,
    vol24: it.kp?.vol24 ?? 0,
    pairUrl: it.kp?.pairUrl || '',
    metric: it.dbsScore
  }));
}

addKpiAddon(
  {
    id: 'degen',
    order: 26,
    label: 'DEGEN',
    title: 'DEGEN Bottom Sniper',
    metricLabel: 'DEGEN',
    limit: 3,
  },
  {
    computePayload() {
      const agg = computeDbsLeaders(3);
      return {
        title: 'DEGEN Bottom Sniper',
        metricLabel: 'DEGEN',
        items: mapAggToRegistryRows(agg),
      };
    },
    ingestSnapshot(items) {
      updateDbsHistory(items);
    }
  }
);
