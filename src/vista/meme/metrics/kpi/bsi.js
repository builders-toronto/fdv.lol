import { addKpiAddon } from '../ingest.js';

export const IMB_STORAGE_KEY = 'meme_flow_imbalance_v1';

function loadImbalanceSnapshot() {
  try {
    const raw = localStorage.getItem(IMB_STORAGE_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

function saveImbalanceSnapshot(rows) {
  try {
    localStorage.setItem(IMB_STORAGE_KEY, JSON.stringify(rows));
  } catch {}
}

function nzNum(v, d = null) {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
}

function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n));
}

function extractImbalance01(it) {
  const buys =
    nzNum(it?.buys24, null) ??
    nzNum(it?.buys, null);
  const sells =
    nzNum(it?.sells24, null) ??
    nzNum(it?.sells, null);

  if (
    Number.isFinite(buys) &&
    Number.isFinite(sells) &&
    buys >= 0 &&
    sells >= 0
  ) {
    const denom = Math.max(buys + sells, 1);
    const raw = (buys - sells) / denom; // -1 .. +1
    return clamp(raw, -1, 1);
  }
  const chg24 = nzNum(it?.change?.h24, 0); // percentage
  return clamp(chg24 / 100, -1, 1); // -100%..+100% => -1..+1
}

export function updateImbalanceSnapshot(items) {
  const list = Array.isArray(items) ? items : [];
  const rows = [];

  for (const it of list) {
    const mint = it.mint || it.id;
    if (!mint) continue;

    const imb01 = extractImbalance01(it); // -1 .. +1
    if (!Number.isFinite(imb01)) continue;

    const imbPct = imb01 * 100; // -100 .. +100

    rows.push({
      mint,
      symbol: it.symbol || '',
      name: it.name || '',
      imageUrl: it.logoURI || it.imageUrl || '',
      priceUsd: nzNum(it.priceUsd, 0),
      chg24: nzNum(it?.change?.h24, 0),
      liqUsd: nzNum(it.liquidityUsd, 0),
      vol24: nzNum(it?.volume?.h24, 0),
      pairUrl: it.pairUrl || '',
      imbalance01: imb01,   // -1..+1
      metric: imbPct,       // -100..+100 for UI
    });
  }
  rows.sort((a, b) => b.metric - a.metric);
  saveImbalanceSnapshot(rows);
}

export function computeImbalanceFromSnapshot() {
  return loadImbalanceSnapshot();
}

export function mapImbalanceToRegistryRows(rows, limit = 3) {
  return (Array.isArray(rows) ? rows : [])
    .slice(0, limit)
    .map(it => ({
      mint: it.mint,
      symbol: it.symbol || '',
      name: it.name || '',
      imageUrl: it.imageUrl || '',
      priceUsd: it.priceUsd ?? 0,
      chg24: it.chg24 ?? 0,
      liqUsd: it.liqUsd ?? 0,
      vol24: it.vol24 ?? 0,
      pairUrl: it.pairUrl || '',
      imbalance01: it.imbalance01 ?? 0, // -1..+1
      metric: it.metric ?? 0,          
    }));
}

addKpiAddon(
  {
    id: 'flowImbalance',
    updateMode: 'throttled',
    order: 6,
    label: 'Flow',
    title: 'Buy/Sell imbalance',
    metricLabel: 'Imbalance (%)',
    limit: 3,
  },
  {
    computePayload() {
      const rows = computeImbalanceFromSnapshot();
      return {
        title: 'Buy/Sell imbalance',
        metricLabel: 'Imbalance (%)',
        items: mapImbalanceToRegistryRows(rows, 3),
      };
    },
    ingestSnapshot(items) {
      updateImbalanceSnapshot(items);
    },
  }
);
