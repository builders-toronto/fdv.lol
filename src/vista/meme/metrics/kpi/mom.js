import { addKpiAddon } from '../ingest.js';

export const MOM_STORAGE_KEY    = 'meme_mcap_momentum_v1';
export const MOM_WINDOW_HOURS   = 24;   // 1-day window
export const MOM_SNAPSHOT_LIMIT = 800;
export const MOM_PER_MINT_CAP   = 80;

function loadMomHistory() {
  try {
    const raw = localStorage.getItem(MOM_STORAGE_KEY);
    return raw ? JSON.parse(raw) : { byMint: {}, total: 0 };
  } catch {
    return { byMint: {}, total: 0 };
  }
}

function saveMomHistory(h) {
  try {
    localStorage.setItem(MOM_STORAGE_KEY, JSON.stringify(h));
  } catch {}
}

function pruneMomHistory(h) {
  const cutoff = Date.now() - MOM_WINDOW_HOURS * 3600 * 1000;
  let total = 0;

  for (const mint of Object.keys(h.byMint)) {
    let arr = Array.isArray(h.byMint[mint]) ? h.byMint[mint] : [];
    arr = arr.filter(e => +e.ts >= cutoff).slice(-MOM_PER_MINT_CAP);
    if (arr.length) {
      h.byMint[mint] = arr;
      total += arr.length;
    } else {
      delete h.byMint[mint];
    }
  }

  if (total > MOM_SNAPSHOT_LIMIT) {
    const all = [];
    for (const [mint, arr] of Object.entries(h.byMint)) {
      for (const e of arr) all.push({ mint, ...e });
    }
    all.sort((a, b) => a.ts - b.ts);
    const keep = all.slice(-MOM_SNAPSHOT_LIMIT);
    const next = { byMint: {}, total: keep.length };
    for (const e of keep) {
      (next.byMint[e.mint] ||= []).push({
        ts: e.ts,
        mcap: e.mcap,
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

export function updateMomHistory(items) {
  const h = loadMomHistory();
  const ts = Date.now();
  const list = Array.isArray(items) ? items : [];

  for (const it of list) {
    const mint = it.mint || it.id;
    if (!mint) continue;

    const fdv = nzNum(it.fdv, null) ?? nzNum(it.marketCap, null);
    if (!Number.isFinite(fdv) || fdv <= 0) continue;

    const entry = {
      ts,
      mcap: fdv,
      kp: {
        symbol: it.symbol || '',
        name: it.name || '',
        imageUrl: it.logoURI || it.imageUrl || '',
        priceUsd: nzNum(it.priceUsd, 0),
        liqUsd: nzNum(it.liquidityUsd, 0),
        vol24: nzNum(it?.volume?.h24, 0),
        chg24: nzNum(it?.change?.h24, 0),
        pairUrl: it.pairUrl || '',
      },
    };

    (h.byMint[mint] ||= []).push(entry);
    if (h.byMint[mint].length > MOM_PER_MINT_CAP) {
      h.byMint[mint] = h.byMint[mint].slice(-MOM_PER_MINT_CAP);
    }
  }

  h.total = Object.values(h.byMint).reduce((a, arr) => a + arr.length, 0);
  saveMomHistory(pruneMomHistory(h));
}

export function computeMcapMomentumFromHistory() {
  const h = pruneMomHistory(loadMomHistory());
  const agg = [];

  for (const [mint, arrRaw] of Object.entries(h.byMint)) {
    const arr = Array.isArray(arrRaw)
      ? [...arrRaw].sort((a, b) => a.ts - b.ts)
      : [];
    if (arr.length < 2) continue;

    const first = arr[0];
    const last = arr[arr.length - 1];

    const mStart = nzNum(first.mcap, null);
    const mEnd   = nzNum(last.mcap, null);
    if (!Number.isFinite(mStart) || !Number.isFinite(mEnd)) continue;

    const dtHours = Math.max((last.ts - first.ts) / (3600 * 1000), 0.1);
    const velocity = (mEnd - mStart) / dtHours; // USD per hour

    if (!Number.isFinite(velocity)) continue;

    agg.push({
      mint,
      velocity,
      mcapStart: mStart,
      mcapEnd: mEnd,
      dtHours,
      kp: last.kp || {},
    });
  }

  agg.sort((a, b) => b.velocity - a.velocity);
  return agg;
}

export function mapMcapMomentumToRegistryRows(agg, limit = 3) {
  return agg.slice(0, limit).map(it => ({
    mint: it.mint,
    symbol: it.kp?.symbol || '',
    name: it.kp?.name || '',
    imageUrl: it.kp?.imageUrl || '',
    priceUsd: it.kp?.priceUsd ?? 0,
    chg24: it.kp?.chg24 ?? 0,
    liqUsd: it.kp?.liqUsd ?? 0,
    vol24: it.kp?.vol24 ?? 0,
    pairUrl: it.kp?.pairUrl || '',
    mcapStart: it.mcapStart ?? 0,
    mcapEnd: it.mcapEnd ?? 0,
    metric: it.velocity ?? 0, 
  }));
}

addKpiAddon(
  {
    id: 'mcapMomentum',
    updateMode: 'throttled',
    order: 40,
    label: 'MOM',
    title: 'MCap momentum',
    metricLabel: '$/h',
    limit: 3,
  },
  {
    computePayload(snapshot) {
      let agg = computeMcapMomentumFromHistory();

      // Instant fallback: approximate $/h from (fdv * chg24)/24.
      if ((!agg || !agg.length) && Array.isArray(snapshot) && snapshot.length) {
        const out = [];
        for (const it of snapshot) {
          const mint = it.mint || it.id;
          if (!mint) continue;
          const mcapEnd = nzNum(it.fdv, null) ?? nzNum(it.marketCap, null);
          if (!Number.isFinite(mcapEnd) || mcapEnd <= 0) continue;
          const chg24 = nzNum(it?.change?.h24, 0);
          const denom = 1 + chg24 / 100;
          const mcapStart = denom > 0.01 ? (mcapEnd / denom) : mcapEnd;
          const velocity = (mcapEnd - mcapStart) / 24;
          if (!Number.isFinite(velocity) || velocity <= 0) continue;

          out.push({
            mint,
            velocity,
            mcapStart,
            mcapEnd,
            dtHours: 24,
            kp: {
              symbol: it.symbol || '',
              name: it.name || '',
              imageUrl: it.logoURI || it.imageUrl || '',
              priceUsd: nzNum(it.priceUsd, 0),
              liqUsd: nzNum(it.liquidityUsd, 0),
              vol24: nzNum(it?.volume?.h24, 0),
              chg24,
              pairUrl: it.pairUrl || '',
            },
          });
        }
        out.sort((a, b) => b.velocity - a.velocity);
        agg = out;
      }

      return {
        title: 'MCap momentum',
        metricLabel: '$/h',
        items: mapMcapMomentumToRegistryRows(agg, 3),
      };
    },
    ingestSnapshot(items) {
      updateMomHistory(items);
    },
  }
);
