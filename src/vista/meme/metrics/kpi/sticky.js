import { addKpiAddon } from '../ingest.js';

export const STICK_STORAGE_KEY    = 'meme_stickiness_index_v1';
export const STICK_WINDOW_DAYS    = 3;
export const STICK_SNAPSHOT_LIMIT = 800;
export const STICK_PER_MINT_CAP   = 80;

function loadStickHistory() {
  try {
    const raw = localStorage.getItem(STICK_STORAGE_KEY);
    return raw ? JSON.parse(raw) : { byMint: {}, total: 0 };
  } catch {
    return { byMint: {}, total: 0 };
  }
}

function saveStickHistory(h) {
  try {
    localStorage.setItem(STICK_STORAGE_KEY, JSON.stringify(h));
  } catch {}
}

function pruneStickHistory(h) {
  const cutoff = Date.now() - STICK_WINDOW_DAYS * 24 * 3600 * 1000;
  let total = 0;

  for (const mint of Object.keys(h.byMint)) {
    let arr = Array.isArray(h.byMint[mint]) ? h.byMint[mint] : [];
    arr = arr.filter(e => +e.ts >= cutoff).slice(-STICK_PER_MINT_CAP);
    if (arr.length) {
      h.byMint[mint] = arr;
      total += arr.length;
    } else {
      delete h.byMint[mint];
    }
  }

  if (total > STICK_SNAPSHOT_LIMIT) {
    const all = [];
    for (const [mint, arr] of Object.entries(h.byMint)) {
      for (const e of arr) all.push({ mint, ...e });
    }
    all.sort((a, b) => a.ts - b.ts);
    const keep = all.slice(-STICK_SNAPSHOT_LIMIT);
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

function clamp01(x) {
  return Math.max(0, Math.min(1, x));
}

function computeStickiness(prices) {
  if (!Array.isArray(prices) || prices.length < 3) return 0;

  let peak = -Infinity;
  let peakIdx = -1;
  prices.forEach((p, i) => {
    if (Number.isFinite(p) && p > peak) {
      peak = p;
      peakIdx = i;
    }
  });
  if (!Number.isFinite(peak) || peak <= 0 || peakIdx < 0 || peakIdx >= prices.length - 2) {
    return 0;
  }

  let trough = Infinity;
  for (let i = peakIdx + 1; i < prices.length; i++) {
    const p = prices[i];
    if (Number.isFinite(p) && p < trough) trough = p;
  }
  if (!Number.isFinite(trough) || trough <= 0 || trough >= peak) {
    return 0.5;
  }

  const latest = prices[prices.length - 1];
  if (!Number.isFinite(latest) || latest <= 0) return 0;

  const drop = peak - trough;
  const recovered = latest - trough;
  if (drop <= 0) return 0;

  const stickiness = recovered / drop; // 0..1+
  return clamp01(stickiness);
}

function computeStickinessInstant(snapshot, limit = 3) {
  const list = Array.isArray(snapshot) ? snapshot : [];
  const out = [];

  for (const it of list) {
    const mint = it.mint || it.id;
    if (!mint) continue;
    const chg24 = nzNum(it?.change?.h24, 0);
    const s01 = clamp01((chg24 + 100) / 200);
    out.push({
      mint,
      s01,
      kp: {
        symbol: it.symbol || '',
        name: it.name || '',
        imageUrl: it.logoURI || it.imageUrl || '',
        liqUsd: nzNum(it.liquidityUsd, 0),
        vol24: nzNum(it?.volume?.h24, 0),
        chg24,
        pairUrl: it.pairUrl || '',
      },
    });
  }

  out.sort((a, b) => b.s01 - a.s01);
  return out.slice(0, limit);
}

export function updateStickHistory(items) {
  const h = loadStickHistory();
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
    if (h.byMint[mint].length > STICK_PER_MINT_CAP) {
      h.byMint[mint] = h.byMint[mint].slice(-STICK_PER_MINT_CAP);
    }
  }

  h.total = Object.values(h.byMint).reduce((a, arr) => a + arr.length, 0);
  saveStickHistory(pruneStickHistory(h));
}

export function computeStickinessIndexFromHistory() {
  const h = pruneStickHistory(loadStickHistory());
  const agg = [];

  for (const [mint, arrRaw] of Object.entries(h.byMint)) {
    const arr = Array.isArray(arrRaw)
      ? [...arrRaw].sort((a, b) => a.ts - b.ts)
      : [];
    if (arr.length < 3) continue;

    const prices = arr.map(e => nzNum(e.priceUsd, null)).filter(Number.isFinite);
    if (prices.length < 3) continue;

    const s01 = computeStickiness(prices); // 0..1
    agg.push({
      mint,
      s01,
      kp: arr[arr.length - 1].kp || {},
    });
  }

  agg.sort((a, b) => b.s01 - a.s01);
  return agg;
}

export function mapStickinessIndexToRegistryRows(agg, limit = 3) {
  return agg.slice(0, limit).map(it => ({
    mint: it.mint,
    symbol: it.kp?.symbol || '',
    name: it.kp?.name || '',
    imageUrl: it.kp?.imageUrl || '',
    chg24: it.kp?.chg24 ?? 0,
    liqUsd: it.kp?.liqUsd ?? 0,
    vol24: it.kp?.vol24 ?? 0,
    pairUrl: it.kp?.pairUrl || '',
    metric: (it.s01 ?? 0) * 100, // 0–100 stickiness
  }));
}

addKpiAddon(
  {
    id: 'stickinessIndex',
    updateMode: 'throttled',
    order: 42,
    label: 'Sticky',
    title: 'Stickiness index',
    metricLabel: 'Recovery (0–100)',
    limit: 3,
  },
  {
    computePayload(snapshot) {
      const agg = computeStickinessIndexFromHistory();
      const use = (agg && agg.length) ? agg : computeStickinessInstant(snapshot, 3);
      return {
        title: 'Stickiness index',
        metricLabel: 'Recovery (0–100)',
        items: mapStickinessIndexToRegistryRows(use, 3),
      };
    },
    ingestSnapshot(items) {
      updateStickHistory(items);
    },
  }
);
