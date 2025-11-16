import { addKpiAddon } from './ingest.js';

export const DD_STORAGE_KEY    = 'meme_drawdown_resistance_v1';
export const DD_WINDOW_DAYS    = 3;
export const DD_SNAPSHOT_LIMIT = 800;
export const DD_PER_MINT_CAP   = 80;

function loadDdHistory() {
  try {
    const raw = localStorage.getItem(DD_STORAGE_KEY);
    return raw ? JSON.parse(raw) : { byMint: {}, total: 0 };
  } catch {
    return { byMint: {}, total: 0 };
  }
}

function saveDdHistory(h) {
  try {
    localStorage.setItem(DD_STORAGE_KEY, JSON.stringify(h));
  } catch {}
}

function pruneDdHistory(h) {
  const cutoff = Date.now() - DD_WINDOW_DAYS * 24 * 3600 * 1000;
  let total = 0;

  for (const mint of Object.keys(h.byMint)) {
    let arr = Array.isArray(h.byMint[mint]) ? h.byMint[mint] : [];
    arr = arr.filter(e => +e.ts >= cutoff).slice(-DD_PER_MINT_CAP);
    if (arr.length) {
      h.byMint[mint] = arr;
      total += arr.length;
    } else {
      delete h.byMint[mint];
    }
  }

  if (total > DD_SNAPSHOT_LIMIT) {
    const all = [];
    for (const [mint, arr] of Object.entries(h.byMint)) {
      for (const e of arr) all.push({ mint, ...e });
    }
    all.sort((a, b) => a.ts - b.ts);
    const keep = all.slice(-DD_SNAPSHOT_LIMIT);
    const next = { byMint: {}, total: keep.length };
    for (const e of keep) {
      (next.byMint[e.mint] ||= []).push({
        ts: e.ts,
        priceUsd: e.priceUsd,
        kp: e.kp,
      });
    }
    return next;
  }

  h.total = total;
  return h;
}

function nzNum(v, d = null) {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
}

function computeMaxDrawdownPct(prices) {
  if (!Array.isArray(prices) || prices.length < 2) return 0;
  let peak = prices[0];
  let maxDd = 0; // as positive percentage

  for (const p of prices) {
    if (!Number.isFinite(p) || p <= 0) continue;
    if (p > peak) peak = p;
    const dd = (peak - p) / peak; // 0..1
    if (dd > maxDd) maxDd = dd;
  }
  return maxDd * 100; // %
}
export function updateDdHistory(items) {
  const h = loadDdHistory();
  const ts = Date.now();
  const list = Array.isArray(items) ? items : [];

  for (const it of list) {
    const mint = it.mint || it.id;
    if (!mint) continue;

    const priceUsd = nzNum(it.priceUsd, null);
    if (!Number.isFinite(priceUsd) || priceUsd <= 0) continue;

    const entry = {
      ts,
      priceUsd,
      kp: {
        symbol: it.symbol || '',
        name: it.name || '',
        imageUrl: it.logoURI || it.imageUrl || '',
        liqUsd: nzNum(it.liquidityUsd, 0),
        vol24: nzNum(it?.volume?.h24, 0),
        chg24: nzNum(it?.change?.h24, 0),
        pairUrl: it.pairUrl || '',
      },
    };

    (h.byMint[mint] ||= []).push(entry);
    if (h.byMint[mint].length > DD_PER_MINT_CAP) {
      h.byMint[mint] = h.byMint[mint].slice(-DD_PER_MINT_CAP);
    }
  }

  h.total = Object.values(h.byMint).reduce((a, arr) => a + arr.length, 0);
  saveDdHistory(pruneDdHistory(h));
}

export function computeDrawdownResistanceFromHistory() {
  const h = pruneDdHistory(loadDdHistory());
  const agg = [];

  for (const [mint, arrRaw] of Object.entries(h.byMint)) {
    const arr = Array.isArray(arrRaw)
      ? [...arrRaw].sort((a, b) => a.ts - b.ts)
      : [];
    if (arr.length < 2) continue;

    const prices = arr.map(e => nzNum(e.priceUsd, null)).filter(Number.isFinite);
    if (prices.length < 2) continue;

    const maxDdPct = computeMaxDrawdownPct(prices); // 0..100
    const resistance = 100 - maxDdPct; // higher = more resistant

    agg.push({
      mint,
      resistance,
      maxDdPct,
      kp: arr[arr.length - 1].kp || {},
    });
  }

  agg.sort((a, b) => b.resistance - a.resistance);
  return agg;
}

export function mapDrawdownResistanceToRegistryRows(agg, limit = 3) {
  return agg.slice(0, limit).map(it => ({
    mint: it.mint,
    symbol: it.kp?.symbol || '',
    name: it.kp?.name || '',
    imageUrl: it.kp?.imageUrl || '',
    chg24: it.kp?.chg24 ?? 0,
    liqUsd: it.kp?.liqUsd ?? 0,
    vol24: it.kp?.vol24 ?? 0,
    pairUrl: it.kp?.pairUrl || '',
    maxDrawdownPct: it.maxDdPct ?? 0,
    metric: it.resistance ?? 0, // 100 - max drawdown (%)
  }));
}

addKpiAddon(
  {
    id: 'drawdownResistance',
    order: 41,
    label: 'Draw',
    title: 'Drawdown resistance',
    metricLabel: 'Resistance (0–100)',
    limit: 3,
  },
  {
    computePayload() {
      const agg = computeDrawdownResistanceFromHistory();
      return {
        title: 'Drawdown resistance',
        metricLabel: 'Resistance (0–100)',
        items: mapDrawdownResistanceToRegistryRows(agg, 3),
      };
    },
    ingestSnapshot(items) {
      updateDdHistory(items);
    },
  }
);
