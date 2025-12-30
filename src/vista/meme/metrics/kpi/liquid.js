import { addKpiAddon } from '../ingest.js';
import { scoreSnapshot, mapAggToRegistryRows } from './shared.js';

export const EFF_STORAGE_KEY    = 'meme_liq_eff_history_v1';
export const EFF_WINDOW_DAYS    = 3;
export const EFF_SNAPSHOT_LIMIT = 400;
export const EFF_PER_MINT_CAP   = 40;

function loadEfficiencyHistory() {
  try {
    const raw = localStorage.getItem(EFF_STORAGE_KEY);
    return raw ? JSON.parse(raw) : { byMint: {}, total: 0 };
  } catch { return { byMint: {}, total: 0 }; }
}
function saveEfficiencyHistory(h) {
  try { localStorage.setItem(EFF_STORAGE_KEY, JSON.stringify(h)); } catch {}
}
function pruneEfficiencyHistory(h) {
  const cutoff = Date.now() - EFF_WINDOW_DAYS*24*3600*1000;
  let total = 0;
  for (const mint of Object.keys(h.byMint)) {
    let arr = Array.isArray(h.byMint[mint]) ? h.byMint[mint] : [];
    arr = arr.filter(e => +e.ts >= cutoff).slice(-EFF_PER_MINT_CAP);
    if (arr.length) { h.byMint[mint] = arr; total += arr.length; }
    else delete h.byMint[mint];
  }
  if (total > EFF_SNAPSHOT_LIMIT) {
    const all = [];
    for (const [mint, arr] of Object.entries(h.byMint)) {
      for (const e of arr) all.push({ mint, ...e });
    }
    all.sort((a,b)=>a.ts-b.ts);
    const keep = all.slice(-EFF_SNAPSHOT_LIMIT);
    const next = { byMint: {}, total: keep.length };
    for (const e of keep) {
      (next.byMint[e.mint] ||= []).push({ ts: e.ts, score: e.score, kp: e.kp });
    }
    return next;
  }
  h.total = total;
  return h;
}

export function updateEfficiencyHistory(items) {
  const h = loadEfficiencyHistory();
  const ts = Date.now();
  const scored = scoreSnapshot(items); // full list, already sorted by score
  if (!scored.length) return;

  for (const it of scored) {
    const liq = it.liqUsd;
    const vol = it.vol24;
    if (!Number.isFinite(liq) || liq <= 0) continue;
    if (!Number.isFinite(vol) || vol <= 0) continue;

    const effBase = vol / (liq + 1);      // volume per $ of liq
    const score01 = it.score / 100;       // 0–1
    const scoreClamped = Math.max(0, Math.min(1, score01));
    const effMetric = effBase * (0.5 + scoreClamped / 2);

    const entry = {
      ts,
      score: effMetric,
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
    if (h.byMint[it.mint].length > EFF_PER_MINT_CAP) {
      h.byMint[it.mint] = h.byMint[it.mint].slice(-EFF_PER_MINT_CAP);
    }
  }

  h.total = Object.values(h.byMint).reduce((a,arr)=>a+arr.length,0);
  saveEfficiencyHistory(pruneEfficiencyHistory(h));
}

export function computeEfficiencyFromHistory() {
  const h = pruneEfficiencyHistory(loadEfficiencyHistory());
  const cutoff = Date.now() - EFF_WINDOW_DAYS*24*3600*1000;
  const agg = [];

  for (const [mint, arr] of Object.entries(h.byMint)) {
    const recent = arr.filter(e => +e.ts >= cutoff);
    if (!recent.length) continue;

    const latest = recent[recent.length - 1];
    const effMetric = latest.score;
    if (!Number.isFinite(effMetric) || effMetric <= 0) continue;

    agg.push({
      mint,
      avgScore: Math.round(effMetric * 100), // scale to nicer integers
      kp: latest.kp
    });
  }

  agg.sort((a,b)=>b.avgScore - a.avgScore);
  return agg.slice(0,3);
}

addKpiAddon(
  {
    id: 'liq_efficiency',
    updateMode: 'throttled',
    order: 13,
    label: 'Liq',
    title: 'Liquidity efficiency',
    metricLabel: 'Eff. score',
    limit: 3,
  },
  {
    computePayload() {
      const agg = computeEfficiencyFromHistory();
      return {
        title: 'Liquidity efficiency',
        metricLabel: 'Eff. score',
        items: mapAggToRegistryRows(agg),
      };
    },
    ingestSnapshot(items) {
      updateEfficiencyHistory(items);
    }
  }
);
