import { addKpiAddon } from './ingest.js';

export const TOP3_STORAGE_KEY = 'meme_top3_history_v1';
export const TOP3_WINDOW_DAYS = 3;          // lookback window for "long-term"
export const TOP3_SNAPSHOT_LIMIT = 400;     // global history cap
export const TOP3_PER_MINT_CAP = 80;        // per-mint history cap

function loadTop3History() {
  try {
    const raw = localStorage.getItem(TOP3_STORAGE_KEY);
    return raw ? JSON.parse(raw) : { byMint: {}, total: 0 };
  } catch { return { byMint: {}, total: 0 }; }
}
function saveTop3History(h) {
  try { localStorage.setItem(TOP3_STORAGE_KEY, JSON.stringify(h)); } catch {}
}
function pruneTop3History(h) {
  const cutoff = Date.now() - TOP3_WINDOW_DAYS*24*3600*1000;
  let total = 0;
  for (const mint of Object.keys(h.byMint)) {
    let arr = Array.isArray(h.byMint[mint]) ? h.byMint[mint] : [];
    arr = arr.filter(e => +e.ts >= cutoff).slice(-TOP3_PER_MINT_CAP);
    if (arr.length) { h.byMint[mint] = arr; total += arr.length; }
    else delete h.byMint[mint];
  }
  if (total > TOP3_SNAPSHOT_LIMIT) {
    const all = [];
    for (const [mint, arr] of Object.entries(h.byMint)) {
      for (const e of arr) all.push({ mint, ...e });
    }
    all.sort((a,b)=>a.ts-b.ts);
    const keep = all.slice(-TOP3_SNAPSHOT_LIMIT);
    const next = { byMint: {}, total: keep.length };
    for (const e of keep) {
      (next.byMint[e.mint] ||= []).push({ ts: e.ts, score: e.score, kp: e.kp });
    }
    return next;
  }
  h.total = total;
  return h;
}

function scoreSnapshot(items) {
  const nz = (v, d = 0) => {
    const n = Number(v);
    return Number.isFinite(n) ? n : d;
  };
  const unpack = (it) => ({
    it,
    vol: nz(it?.volume?.h24, null),
    liq: nz(it?.liquidityUsd, null),
    tx:  nz(it?.txns?.h24, null),
    chg: Number.isFinite(Number(it?.change?.h24)) ? Number(it.change.h24) : 0,
    price: nz(it?.priceUsd, null),
  });

  const rows = (Array.isArray(items) ? items : []).map(unpack);
  const sample = rows.filter(r =>
    Number.isFinite(r.vol) || Number.isFinite(r.liq) ||
    Number.isFinite(r.tx)  || Number.isFinite(r.price)
  );
  if (!sample.length) return [];

  const pos = (v) => (Number.isFinite(v) && v > 0 ? v : 0);
  const maxVol = Math.max(...sample.map(r => pos(r.vol)), 1);
  const maxLiq = Math.max(...sample.map (r => pos(r.liq)), 1);
  const maxTx  = Math.max(...sample.map(r => pos(r.tx)),  1);

  const norm = (v, m) => {
    const x = pos(v);
    return m > 0 ? Math.min(1, Math.log10(1 + x) / Math.log10(1 + m)) : 0;
  };
  const clamp01 = (n) => Math.max(0, Math.min(1, n));

  return sample.map(({ it, vol, liq, tx, chg, price }) => {
    const nVol = norm(vol, maxVol);
    const nLiq = norm(liq, maxLiq);
    const nTx  = norm(tx,  maxTx);
    const nChg = Number.isFinite(chg) ? (chg >= 0 ? clamp01(chg / 100) : -clamp01(Math.abs(chg) / 100)) : 0;

    const score01 = 0.35*nVol + 0.25*nTx + 0.20*nLiq + 0.20*(0.5 + nChg/2);
    const score = Math.round(score01 * 100);

    return {
      mint: it.mint || it.id,
      symbol: it.symbol || '',
      name: it.name || '',
      imageUrl: it.imageUrl || it.logoURI || '',
      pairUrl: it.pairUrl || '',
      priceUsd: Number.isFinite(price) ? price : 0,
      chg24: Number.isFinite(chg) ? chg : 0,
      liqUsd: Number.isFinite(liq) ? liq : 0,
      vol24: Number.isFinite(vol) ? vol : 0,
      score
    };
  }).sort((a,b)=>b.score-a.score);
}

export function updateTop3History(items) {
  const h = loadTop3History();
  const ts = Date.now();
  const scored = scoreSnapshot(items).slice(0, 25);
  if (!scored.length) return;
  for (const it of scored) {
    const entry = { ts, score: it.score, kp: { chg24: it.chg24, liqUsd: it.liqUsd, vol24: it.vol24, priceUsd: it.priceUsd, symbol: it.symbol, name: it.name, imageUrl: it.imageUrl, pairUrl: it.pairUrl } };
    (h.byMint[it.mint] ||= []).push(entry);
    if (h.byMint[it.mint].length > TOP3_PER_MINT_CAP) h.byMint[it.mint] = h.byMint[it.mint].slice(-TOP3_PER_MINT_CAP);
  }
  h.total = Object.values(h.byMint).reduce((a,arr)=>a+arr.length,0);
  saveTop3History(pruneTop3History(h));
}

export function computeTop3FromHistory() {
  const h = pruneTop3History(loadTop3History());
  const cutoff = Date.now() - TOP3_WINDOW_DAYS*24*3600*1000;
  const agg = [];
  for (const [mint, arr] of Object.entries(h.byMint)) {
    const recent = arr.filter(e => +e.ts >= cutoff);
    if (!recent.length) continue;
    const best = recent.map(e => e.score).sort((a,b)=>b-a).slice(0,5);
    const avg = best.reduce((a,b)=>a+b,0) / best.length;
    const latest = recent[recent.length-1]?.kp || {};
    agg.push({ mint, avgScore: Math.round(avg), kp: latest });
  }
  agg.sort((a,b)=>b.avgScore - a.avgScore);
  return agg.slice(0,3);
}

export function mapAggToRegistryRows(agg) {
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
    metric: it.avgScore
  }));
}

addKpiAddon(
  {
    id: 'top3',
    order: 10,
    label: 'Top',
    title: `Top performers`,
    metricLabel: 'Score',
    limit: 3,
  },
  {
    computePayload() {
      const agg = computeTop3FromHistory();
      return {
        title: `Top performers`,
        metricLabel: 'Score',
        items: mapAggToRegistryRows(agg),
      };
    },
    ingestSnapshot(items) {
      updateTop3History(items);
    }
  }
);