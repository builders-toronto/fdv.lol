import { registerAddon, setAddonData } from './register.js';

export const ENG_STORAGE_KEY = 'meme_engagement_history_v1';
export const ENG_WINDOW_DAYS = 3;
export const ENG_SNAPSHOT_LIMIT = 400;
export const ENG_PER_MINT_CAP = 80;

function loadEngHistory() {
  try {
    const raw = localStorage.getItem(ENG_STORAGE_KEY);
    return raw ? JSON.parse(raw) : { byMint: {}, total: 0 };
  } catch { return { byMint: {}, total: 0 }; }
}
function saveEngHistory(h) {
  try { localStorage.setItem(ENG_STORAGE_KEY, JSON.stringify(h)); } catch {}
}
function pruneEngHistory(h) {
  const cutoff = Date.now() - ENG_WINDOW_DAYS*24*3600*1000;
  let total = 0;
  for (const mint of Object.keys(h.byMint)) {
    let arr = Array.isArray(h.byMint[mint]) ? h.byMint[mint] : [];
    arr = arr.filter(e => +e.ts >= cutoff).slice(-ENG_PER_MINT_CAP);
    if (arr.length) { h.byMint[mint] = arr; total += arr.length; }
    else delete h.byMint[mint];
  }
  if (total > ENG_SNAPSHOT_LIMIT) {
    const all = [];
    for (const [mint, arr] of Object.entries(h.byMint)) for (const e of arr) all.push({ mint, ...e });
    all.sort((a,b)=>a.ts-b.ts);
    const keep = all.slice(-ENG_SNAPSHOT_LIMIT);
    const next = { byMint: {}, total: keep.length };
    for (const e of keep) (next.byMint[e.mint] ||= []).push({ ts: e.ts, score: e.score, kp: e.kp });
    return next;
  }
  h.total = total;
  return h;
}

function scoreEngagementSnapshot(items) {
  const nz = (v, d = 0) => {
    const n = Number(v);
    return Number.isFinite(n) ? n : d;
  };
  const unpack = (it) => {
    const buys = nz(it?.txns?.h24?.buys, null);
    const sells = nz(it?.txns?.h24?.sells, null);
    const tx = Number.isFinite(buys) || Number.isFinite(sells)
      ? nz(buys, 0) + nz(sells, 0)
      : nz(it?.txns?.h24, null);
    const vol = nz(it?.volume?.h24, null);
    const liq = nz(it?.liquidityUsd, null);
    const vOverL = Number.isFinite(vol) && Number.isFinite(liq) && liq > 0 ? vol / liq : null;
    let unique = nz(it?.unique?.h24 ?? it?.unique24, null);
    if (!Number.isFinite(unique) && Number.isFinite(tx)) {
      unique = Math.round(Math.max(1, Math.sqrt(Math.max(0, tx))));
    }
    const chg = Number.isFinite(Number(it?.change?.h24)) ? Number(it.change.h24) : 0;
    const volat = nz(it?.volatility?.h24 ?? it?.spreadPct, null);
    return {
      it, tx, unique, vOverL, chg, volat,
      price: nz(it?.priceUsd, null),
      liq, vol
    };
  };

  const rows = (Array.isArray(items) ? items : []).map(unpack)
    .filter(r => Number.isFinite(r.tx) || Number.isFinite(r.vOverL) || Number.isFinite(r.unique));
  if (!rows.length) return [];

  const pos = (v) => (Number.isFinite(v) && v > 0 ? v : 0);
  const maxTx   = Math.max(...rows.map(r => pos(r.tx)), 1);
  const maxUni  = Math.max(...rows.map(r => pos(r.unique)), 1);
  const maxVoL  = Math.max(...rows.map(r => pos(r.vOverL)), 1);

  const normLog = (v, m) => {
    const x = pos(v);
    return m > 0 ? Math.min(1, Math.log10(1 + x) / Math.log10(1 + m)) : 0;
  };
  const clamp01 = (n) => Math.max(0, Math.min(1, n));
  const mom01 = (chg) => {
    const c = Math.max(-50, Math.min(50, Number.isFinite(chg) ? chg : 0));
    return (c + 50) / 100;
  };
  const volPenalty01 = (v) => {
    if (!Number.isFinite(v) || v <= 0) return 0;
    const p = Math.min(1, v / 50);
    return p;
  };

  return rows.map(({ it, tx, unique, vOverL, chg, volat }) => {
    const nTx   = normLog(tx, maxTx);
    const nUni  = normLog(unique, maxUni);
    const nVoL  = normLog(vOverL, maxVoL);
    const nMom  = mom01(chg);
    const pen   = volPenalty01(volat);

    const base = 0.40*nTx + 0.25*nVoL + 0.20*nUni + 0.10*nMom;
    const score01 = clamp01(base) * (1 - 0.05*pen) + 0.05*(1 - pen);
    const score = Math.round(score01 * 100);

    return {
      mint: it.mint || it.id,
      symbol: it.symbol || '',
      name: it.name || '',
      imageUrl: it.imageUrl || it.logoURI || '',
      pairUrl: it.pairUrl || '',
      priceUsd: nz(it.priceUsd, null),
      chg24: Number.isFinite(chg) ? chg : 0,
      liqUsd: nz(it.liquidityUsd, 0),
      vol24: nz(it.volume?.h24, 0),
      tx24: nz(it.txns?.h24?.buys, 0) + nz(it.txns?.h24?.sells, 0) || nz(it.txns?.h24, 0),
      unique24: Number.isFinite(unique) ? unique : 0,
      vOverL: Number.isFinite(vOverL) ? vOverL : 0,
      score
    };
  }).sort((a,b)=>b.score - a.score);
}

export function updateEngagementHistory(items) {
  const h = loadEngHistory();
  const ts = Date.now();
  const scored = scoreEngagementSnapshot(items).slice(0, 25);
  if (!scored.length) return;
  for (const it of scored) {
    const entry = {
      ts,
      score: it.score,
      kp: {
        symbol: it.symbol, name: it.name, imageUrl: it.imageUrl, pairUrl: it.pairUrl,
        priceUsd: it.priceUsd, chg24: it.chg24, liqUsd: it.liqUsd, vol24: it.vol24,
        tx24: it.tx24, unique24: it.unique24, vOverL: it.vOverL
      }
    };
    (h.byMint[it.mint] ||= []).push(entry);
    if (h.byMint[it.mint].length > ENG_PER_MINT_CAP) h.byMint[it.mint] = h.byMint[it.mint].slice(-ENG_PER_MINT_CAP);
  }
  h.total = Object.values(h.byMint).reduce((a,arr)=>a+arr.length,0);
  saveEngHistory(pruneEngHistory(h));
}

export function computeEngagementTop3() {
  const h = pruneEngHistory(loadEngHistory());
  const cutoff = Date.now() - ENG_WINDOW_DAYS*24*3600*1000;
  const agg = [];
  for (const [mint, arr] of Object.entries(h.byMint)) {
    const recent = arr.filter(e => +e.ts >= cutoff);
    if (!recent.length) continue;
    const best = recent.map(e => e.score).sort((a,b)=>b-a).slice(0,5);
    const avg = best.reduce((a,b)=>a+b,0) / best.length;
    const latest = recent[recent.length - 1]?.kp || {};
    agg.push({ mint, avgScore: Math.round(avg), kp: latest });
  }
  agg.sort((a,b)=>b.avgScore - a.avgScore);
  return agg.slice(0,3);
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
    metric: it.avgScore
  }));
}

function pushEngagementToRegistry() {
  const agg = computeEngagementTop3();
  setAddonData('engagement', {
    title: `Most engaged tokens (last ${ENG_WINDOW_DAYS}d)`,
    metricLabel: 'Engagement',
    items: mapAggToRegistryRows(agg),
  });
}

export function engagementTick() {
  try { pushEngagementToRegistry(); } catch {}
}
export function engagementIngestSnapshot(items) {
  try {
    updateEngagementHistory(items);
  } finally {
    pushEngagementToRegistry();
  }
}

export function registerEngagementAddon(opts = {}) {
  const { order = 20, label = 'Engagement', limit = 3 } = opts;
  registerAddon({
    id: 'engagement',
    order,
    label,
    title: `Most engaged tokens (last ${ENG_WINDOW_DAYS}d)`,
    metricLabel: 'Engagement',
    limit
  });
  pushEngagementToRegistry();
}