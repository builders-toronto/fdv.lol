import { addKpiAddon } from '../ingest.js';
import { scoreSnapshot, mapAggToRegistryRows } from './shared.js';

function nzNum(v, d = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
}

function clamp(n, lo, hi) {
  return Math.min(hi, Math.max(lo, n));
}

function computeComebackInstant(snapshot, limit = 3) {
  const list = Array.isArray(snapshot) ? snapshot : [];
  const out = [];

  for (const it of list) {
    const mint = it.mint || it.id;
    if (!mint) continue;

    const chg24 = nzNum(it?.change?.h24, 0);
    const vol24 = nzNum(it?.volume?.h24, 0);
    const liqUsd = nzNum(it?.liquidityUsd, 0);
    const priceUsd = nzNum(it?.priceUsd, 0);
    if (!Number.isFinite(priceUsd) || priceUsd <= 0) continue;

    // Very rough "instant" proxy: reward being green today + having volume.
    const volBoost01 = clamp(Math.log10(1 + Math.max(0, vol24)) / 6, 0, 1);
    const liqBoost01 = clamp(Math.log10(1 + Math.max(0, liqUsd)) / 6, 0, 1);
    const green = Math.max(0, chg24);
    const score = Math.round(green * (0.8 + 0.2 * volBoost01) * (0.9 + 0.1 * liqBoost01));
    if (!Number.isFinite(score) || score <= 0) continue;

    out.push({
      mint,
      avgScore: score,
      kp: {
        chg24,
        liqUsd,
        vol24,
        priceUsd,
        symbol: it.symbol || '',
        name: it.name || '',
        imageUrl: it.imageUrl || it.logoURI || '',
        pairUrl: it.pairUrl || '',
      },
    });
  }

  out.sort((a, b) => b.avgScore - a.avgScore);
  return out.slice(0, limit);
}

export const COMEBACK_STORAGE_KEY    = 'meme_comeback_history_v1';
export const COMEBACK_WINDOW_DAYS    = 3;
export const COMEBACK_SNAPSHOT_LIMIT = 400;
export const COMEBACK_PER_MINT_CAP   = 80;

function loadComebackHistory() {
  try {
    const raw = localStorage.getItem(COMEBACK_STORAGE_KEY);
    return raw ? JSON.parse(raw) : { byMint: {}, total: 0 };
  } catch { return { byMint: {}, total: 0 }; }
}
function saveComebackHistory(h) {
  try { localStorage.setItem(COMEBACK_STORAGE_KEY, JSON.stringify(h)); } catch {}
}
function pruneComebackHistory(h) {
  const cutoff = Date.now() - COMEBACK_WINDOW_DAYS*24*3600*1000;
  let total = 0;
  for (const mint of Object.keys(h.byMint)) {
    let arr = Array.isArray(h.byMint[mint]) ? h.byMint[mint] : [];
    arr = arr.filter(e => +e.ts >= cutoff).slice(-COMEBACK_PER_MINT_CAP);
    if (arr.length) { h.byMint[mint] = arr; total += arr.length; }
    else delete h.byMint[mint];
  }
  if (total > COMEBACK_SNAPSHOT_LIMIT) {
    const all = [];
    for (const [mint, arr] of Object.entries(h.byMint)) {
      for (const e of arr) all.push({ mint, ...e });
    }
    all.sort((a,b)=>a.ts-b.ts);
    const keep = all.slice(-COMEBACK_SNAPSHOT_LIMIT);
    const next = { byMint: {}, total: keep.length };
    for (const e of keep) {
      (next.byMint[e.mint] ||= []).push({ ts: e.ts, score: e.score, kp: e.kp });
    }
    return next;
  }
  h.total = total;
  return h;
}

export function updateComebackHistory(items) {
  const h = loadComebackHistory();
  const ts = Date.now();
  const scored = scoreSnapshot(items).slice(0, 50);
  if (!scored.length) return;

  for (const it of scored) {
    const entry = {
      ts,
      // we keep base score here; comeback metric is computed from price history
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
    if (h.byMint[it.mint].length > COMEBACK_PER_MINT_CAP) {
      h.byMint[it.mint] = h.byMint[it.mint].slice(-COMEBACK_PER_MINT_CAP);
    }
  }

  h.total = Object.values(h.byMint).reduce((a,arr)=>a+arr.length,0);
  saveComebackHistory(pruneComebackHistory(h));
}

export function computeComebackFromHistory() {
  const h = pruneComebackHistory(loadComebackHistory());
  const cutoff = Date.now() - COMEBACK_WINDOW_DAYS*24*3600*1000;
  const agg = [];

  for (const [mint, arr] of Object.entries(h.byMint)) {
    const recent = arr.filter(e => +e.ts >= cutoff);
    if (recent.length < 2) continue;

    const latestEntry = recent[recent.length - 1];
    const latestKp = latestEntry.kp || {};
    const latestPrice = Number(latestKp.priceUsd) || 0;
    const latestVol = Number(latestKp.vol24) || 0;
    const latestChg = Number(latestKp.chg24) || 0;

    if (!Number.isFinite(latestPrice) || latestPrice <= 0) continue;

    // Find local "bottom" price within this window
    let minPrice = Infinity;
    for (const e of recent) {
      const p = Number(e.kp?.priceUsd) || 0;
      if (p > 0 && p < minPrice) minPrice = p;
    }
    if (!Number.isFinite(minPrice) || minPrice <= 0) continue;

    // Needs to have actually recovered off that bottom
    if (latestPrice <= minPrice) continue;

    const retrace = (latestPrice - minPrice) / minPrice; // e.g. 1.5 = +150% off bottom
    if (!Number.isFinite(retrace) || retrace <= 0) continue;

    // Volume boost (busier comebacks are more interesting)
    const volBoost = Math.log10(1 + Math.max(0, latestVol));
    const volBoost01 = Math.max(0, Math.min(1, volBoost / 6));

    // Prefer those currently green on the day
    const chgBoost = latestChg > 0
      ? Math.max(0, Math.min(1, latestChg / 100))
      : 0;

    const raw =
      retrace *                       // how far it climbed off bottom
      (0.7 + 0.3 * volBoost01) *      // rewarded for volume
      (0.5 + 0.5 * chgBoost);         // extra love if green now

    if (!Number.isFinite(raw) || raw <= 0) continue;

    const comebackScore = Math.round(raw * 100);

    agg.push({
      mint,
      avgScore: comebackScore,
      kp: latestKp
    });
  }

  agg.sort((a,b)=>b.avgScore - a.avgScore);
  return agg.slice(0,3);
}

addKpiAddon(
  {
    id: 'comeback_memes',
    updateMode: 'throttled',
    order: 15,
    label: 'Comebacks',
    title: 'Comeback memes',
    metricLabel: 'Comeback',
    limit: 3,
  },
  {
    computePayload(snapshot) {
      const agg = computeComebackFromHistory();
      const use = (agg && agg.length) ? agg : computeComebackInstant(snapshot, 3);
      return {
        title: 'Comeback memes',
        metricLabel: 'Comeback',
        items: mapAggToRegistryRows(use),
      };
    },
    ingestSnapshot(items) {
      updateComebackHistory(items);
    }
  }
);
