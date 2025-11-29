import { addKpiAddon } from '../ingest.js';

export const CONSIST_STORAGE_KEY    = 'meme_consistency_history_v1';
export const CONSIST_WINDOW_DAYS    = 3;
export const CONSIST_SNAPSHOT_LIMIT = 400;
export const CONSIST_PER_MINT_CAP   = 80;

function loadConsistencyHistory() {
  try {
    const raw = localStorage.getItem(CONSIST_STORAGE_KEY);
    return raw ? JSON.parse(raw) : { byMint: {}, total: 0 };
  } catch { return { byMint: {}, total: 0 }; }
}

function saveConsistencyHistory(h) {
  try { localStorage.setItem(CONSIST_STORAGE_KEY, JSON.stringify(h)); } catch {}
}

function pruneConsistencyHistory(h) {
  const cutoff = Date.now() - CONSIST_WINDOW_DAYS*24*3600*1000;
  let total = 0;
  for (const mint of Object.keys(h.byMint)) {
    let arr = Array.isArray(h.byMint[mint]) ? h.byMint[mint] : [];
    arr = arr.filter(e => +e.ts >= cutoff).slice(-CONSIST_PER_MINT_CAP);
    if (arr.length) { h.byMint[mint] = arr; total += arr.length; }
    else delete h.byMint[mint];
  }
  if (total > CONSIST_SNAPSHOT_LIMIT) {
    const all = [];
    for (const [mint, arr] of Object.entries(h.byMint)) {
      for (const e of arr) all.push({ mint, ...e });
    }
    all.sort((a,b)=>a.ts-b.ts);
    const keep = all.slice(-CONSIST_SNAPSHOT_LIMIT);
    const next = { byMint: {}, total: keep.length };
    for (const e of keep) {
      (next.byMint[e.mint] ||= []).push({ ts: e.ts, score: e.score, kp: e.kp });
    }
    return next;
  }
  h.total = total;
  return h;
}

export function updateConsistencyHistory(items) {
  const h = loadConsistencyHistory();
  const ts = Date.now();
  const scored = scoreSnapshot(items).slice(0, 50);
  if (!scored.length) return;
  for (const it of scored) {
    const entry = {
      ts,
      score: it.score,
      kp: {
        chg24: it.chg24,
        liqUsd: it.liqUsd,
        vol24: it.vol24,
        priceUsd: it.priceUsd,
        symbol: it.symbol,
        name: it.name,
        imageUrl: it.imageUrl,
        pairUrl: it.pairUrl
      }
    };
    (h.byMint[it.mint] ||= []).push(entry);
    if (h.byMint[it.mint].length > CONSIST_PER_MINT_CAP) {
      h.byMint[it.mint] = h.byMint[it.mint].slice(-CONSIST_PER_MINT_CAP);
    }
  }
  h.total = Object.values(h.byMint).reduce((a,arr)=>a+arr.length,0);
  saveConsistencyHistory(pruneConsistencyHistory(h));
}

export function computeConsistencyFromHistory() {
  const h = pruneConsistencyHistory(loadConsistencyHistory());
  const cutoff = Date.now() - CONSIST_WINDOW_DAYS*24*3600*1000;
  const agg = [];

  const mean = (xs) => xs.reduce((a,b)=>a+b,0) / xs.length;
  const stddev = (xs) => {
    if (xs.length <= 1) return 0;
    const m = mean(xs);
    const v = xs.reduce((acc,x)=>acc + (x-m)*(x-m), 0) / xs.length;
    return Math.sqrt(v);
  };

  for (const [mint, arr] of Object.entries(h.byMint)) {
    const recent = arr.filter(e => +e.ts >= cutoff);
    if (recent.length < 3) continue;

    const scores = recent.map(e => e.score);
    const avgScore = mean(scores);
    const sdScore  = stddev(scores);

    const raw = avgScore / (1 + sdScore);
    const consistencyScore = Math.round(Math.max(0, raw));
    if (consistencyScore <= 0) continue;

    const latest = recent[recent.length - 1];
    agg.push({
      mint,
      avgScore: consistencyScore,
      kp: latest.kp
    });
  }

  agg.sort((a,b)=>b.avgScore - a.avgScore);
  return agg.slice(0,3);
}

addKpiAddon(
  {
    id: 'consistency3d',
    updateMode: 'throttled',
    order: 12,
    label: 'Consistent',
    title: 'Consistent performers',
    metricLabel: 'Consistency',
    limit: 3,
  },
  {
    computePayload() {
      const agg = computeConsistencyFromHistory();
      return {
        title: 'Consistent performers',
        metricLabel: 'Consistency',
        items: mapAggToRegistryRows(agg),
      };
    },
    ingestSnapshot(items) {
      updateConsistencyHistory(items);
    }
  }
);