import { addKpiAddon } from './ingest.js';

export const DAS_STORAGE_KEY = 'meme_das_history_v1';
export const DAS_WINDOW_DAYS = 3;           // lookback window
export const DAS_SNAPSHOT_LIMIT = 400;      // global cap
export const DAS_PER_MINT_CAP = 80;         // per-mint cap
export const DAS_HALFLIFE_DAYS = 1.5;       // half-life for exponential decay
const LN2 = Math.log(2);

function loadDasHistory() {
  try {
    const raw = localStorage.getItem(DAS_STORAGE_KEY);
    return raw ? JSON.parse(raw) : { byMint: {}, total: 0 };
  } catch { return { byMint: {}, total: 0 }; }
}
function saveDasHistory(h) {
  try { localStorage.setItem(DAS_STORAGE_KEY, JSON.stringify(h)); } catch {}
}
function pruneDasHistory(h) {
  const cutoff = Date.now() - DAS_WINDOW_DAYS*24*3600*1000;
  let total = 0;
  for (const mint of Object.keys(h.byMint)) {
    let arr = Array.isArray(h.byMint[mint]) ? h.byMint[mint] : [];
    arr = arr.filter(e => +e.ts >= cutoff).slice(-DAS_PER_MINT_CAP);
    if (arr.length) { h.byMint[mint] = arr; total += arr.length; }
    else delete h.byMint[mint];
  }
  if (total > DAS_SNAPSHOT_LIMIT) {
    const all = [];
    for (const [mint, arr] of Object.entries(h.byMint)) {
      for (const e of arr) all.push({ mint, ...e });
    }
    all.sort((a,b)=>a.ts-b.ts);
    const keep = all.slice(-DAS_SNAPSHOT_LIMIT);
    const next = { byMint: {}, total: keep.length };
    for (const e of keep) {
      (next.byMint[e.mint] ||= []).push({ ts: e.ts, score: e.score, kp: e.kp });
    }
    return next;
  }
  h.total = total;
  return h;
}

export function updateDasHistory(items) {
  const h = loadDasHistory();
  const ts = Date.now();
  const scored = (Array.isArray(items) ? items : []).map(it => ({
    mint: it.mint || it.id,
    symbol: it.symbol || '',
    name: it.name || '',
    imageUrl: it.imageUrl || it.logoURI || '',
    pairUrl: it.pairUrl || '',
    priceUsd: Number(it?.priceUsd) || 0,
    chg24: Number(it?.change?.h24) || 0,
    liqUsd: Number(it?.liquidityUsd) || 0,
    vol24: Number(it?.volume?.h24) || 0,
    score: Number(it?.score) || 0
  }));
  for (const it of scored) {
    const entry = { ts, score: it.score, kp: it };
    (h.byMint[it.mint] ||= []).push(entry);
    if (h.byMint[it.mint].length > DAS_PER_MINT_CAP) {
      h.byMint[it.mint] = h.byMint[it.mint].slice(-DAS_PER_MINT_CAP);
    }
  }
  h.total = Object.values(h.byMint).reduce((a,arr)=>a+arr.length,0);
  saveDasHistory(pruneDasHistory(h));
}

function computeDASForMint(arr, nowTs, halflifeDays = DAS_HALFLIFE_DAYS) {
  if (!Array.isArray(arr) || !arr.length) return 0;
  const lambda = LN2 / Math.max(1e-6, halflifeDays);
  let wsum = 0, vsum = 0;

  for (const e of arr) {
    const ageDays = (nowTs - (+e.ts)) / (24*3600*1000);
    if (ageDays < 0) continue;
    const w = Math.exp(-lambda * ageDays);
    if (!Number.isFinite(e.score)) continue;
    wsum += w;
    vsum += w * e.score;
  }
  if (wsum <= 0) return 0;
  return Math.round(vsum / wsum);
}

export function computeDasLeaders(limit = 3) {
  const h = pruneDasHistory(loadDasHistory());
  const cutoff = Date.now() - DAS_WINDOW_DAYS*24*3600*1000;
  const now = Date.now();
  const agg = [];

  for (const [mint, arr] of Object.entries(h.byMint)) {
    const recent = (arr || []).filter(e => +e.ts >= cutoff);
    if (!recent.length) continue;
    const das = computeDASForMint(recent, now, DAS_HALFLIFE_DAYS);
    const latest = recent[recent.length-1]?.kp || {};
    agg.push({ mint, dasScore: das, kp: latest });
  }

  agg.sort((a,b)=> b.dasScore - a.dasScore);
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
    metric: it.dasScore
  }));
}
addKpiAddon(
  {
    id: 'das',
    order: 25,
    label: 'DAS',
    title: `Decay-Adjusted Leaders`,
    metricLabel: 'DAS',
    limit: 3,
  },
  {
    computePayload() {
      const agg = computeDasLeaders(3);
      return {
        title: `Decay-Adjusted Leaders`,
        metricLabel: 'DAS',
        items: mapAggToRegistryRows(agg),
      };
    },
    ingestSnapshot(items) {
      updateDasHistory(items);
    }
  }
);
