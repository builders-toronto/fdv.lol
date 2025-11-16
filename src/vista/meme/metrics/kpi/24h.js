import { addKpiAddon } from '../ingest.js';

export const TX24_STORAGE_KEY = 'meme_tx24_counts_v1';

function loadTx24Snapshot() {
  try {
    const raw = localStorage.getItem(TX24_STORAGE_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

function saveTx24Snapshot(rows) {
  try {
    localStorage.setItem(TX24_STORAGE_KEY, JSON.stringify(rows));
  } catch {}
}

function nzNum(v, d = null) {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
}

export function updateTx24Snapshot(items) {
  const list = Array.isArray(items) ? items : [];
  const rows = [];

  for (const it of list) {
    const mint = it.mint || it.id;
    if (!mint) continue;

    const tx24 = nzNum(it?.txns?.h24, null);
    if (!Number.isFinite(tx24) || tx24 < 0) continue;

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
      tx24,
      metric: tx24,  
    });
  }

  rows.sort((a, b) => b.metric - a.metric);
  saveTx24Snapshot(rows);
}

export function computeTx24FromSnapshot() {
  return loadTx24Snapshot();
}


export function mapTx24ToRegistryRows(rows, limit = 3) {
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
      tx24: it.tx24 ?? 0,
      metric: it.metric ?? 0, // Tx / 24h
    }));
}

addKpiAddon(
  {
    id: 'tx24',
    order: 5,
    label: '24h',
    title: '24h transaction count',
    metricLabel: 'Tx / 24h',
    limit: 3,
  },
  {
    computePayload() {
      const rows = computeTx24FromSnapshot();
      return {
        title: '24h transaction count',
        metricLabel: 'Tx / 24h',
        items: mapTx24ToRegistryRows(rows, 3),
      };
    },
    ingestSnapshot(items) {
      updateTx24Snapshot(items);
    },
  }
);
