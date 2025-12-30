import { addKpiAddon } from '../ingest.js';

export const HGV_STORAGE_KEY     = 'meme_holder_velocity_v1';
export const HGV_WINDOW_DAYS     = 3;      // lookback window for velocity calc
export const HGV_SNAPSHOT_LIMIT  = 800;    // global history cap
export const HGV_PER_MINT_CAP    = 80;     // per-mint history cap
export const HGV_MIN_OBS         = 2;      // min snapshots per mint
export const HGV_MIN_DT_DAYS     = 0.05;   // avoid div-by-zero (~1.2h)


function loadHgvHistory() {
  try {
    const raw = localStorage.getItem(HGV_STORAGE_KEY);
    return raw ? JSON.parse(raw) : { byMint: {}, total: 0 };
  } catch {
    return { byMint: {}, total: 0 };
  }
}

function saveHgvHistory(h) {
  try {
    localStorage.setItem(HGV_STORAGE_KEY, JSON.stringify(h));
  } catch {}
}

function pruneHgvHistory(h) {
  const cutoff = Date.now() - HGV_WINDOW_DAYS * 24 * 3600 * 1000;
  let total = 0;

  for (const mint of Object.keys(h.byMint)) {
    let arr = Array.isArray(h.byMint[mint]) ? h.byMint[mint] : [];
    arr = arr.filter(e => +e.ts >= cutoff).slice(-HGV_PER_MINT_CAP);
    if (arr.length) {
      h.byMint[mint] = arr;
      total += arr.length;
    } else {
      delete h.byMint[mint];
    }
  }

  if (total > HGV_SNAPSHOT_LIMIT) {
    const all = [];
    for (const [mint, arr] of Object.entries(h.byMint)) {
      for (const e of arr) all.push({ mint, ...e });
    }
    all.sort((a, b) => a.ts - b.ts);
    const keep = all.slice(-HGV_SNAPSHOT_LIMIT);
    const next = { byMint: {}, total: keep.length };
    for (const e of keep) {
      (next.byMint[e.mint] ||= []).push({
        ts: e.ts,
        activity24: e.activity24,
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

function extractActivity24(it) {
  const n = nzNum(it?.txns?.h24, null);
  return Number.isFinite(n) && n >= 0 ? n : null;
}


export function updateHgvHistory(items) {
  const h = loadHgvHistory();
  const ts = Date.now();
  const list = Array.isArray(items) ? items : [];

  for (const it of list) {
    const mint = it.mint || it.id;
    if (!mint) continue;

    const activity24 = extractActivity24(it);
    if (!Number.isFinite(activity24)) continue;

    const entry = {
      ts,
      activity24,
      kp: {
        symbol: it.symbol || '',
        name: it.name || '',
        imageUrl: it.logoURI || it.imageUrl || '',
        priceUsd: nzNum(it.priceUsd, 0),
        liqUsd: nzNum(it.liquidityUsd, 0),
        vol24: nzNum(it?.volume?.h24, 0),
        chg24: nzNum(it?.change?.h24, 0),
        pairUrl: it.pairUrl || '',
        activity24,
      },
    };

    (h.byMint[mint] ||= []).push(entry);
    if (h.byMint[mint].length > HGV_PER_MINT_CAP) {
      h.byMint[mint] = h.byMint[mint].slice(-HGV_PER_MINT_CAP);
    }
  }

  h.total = Object.values(h.byMint).reduce((a, arr) => a + arr.length, 0);
  saveHgvHistory(pruneHgvHistory(h));
}


export function computeHolderVelocityFromHistory() {
  const h = pruneHgvHistory(loadHgvHistory());
  const agg = [];

  for (const [mint, arrRaw] of Object.entries(h.byMint)) {
    const arr = Array.isArray(arrRaw)
      ? [...arrRaw].sort((a, b) => a.ts - b.ts)
      : [];
    if (arr.length < HGV_MIN_OBS) continue;

    const first = arr[0];
    const last = arr[arr.length - 1];

    const aStart = nzNum(first.activity24, null);
    const aEnd   = nzNum(last.activity24, null);
    if (!Number.isFinite(aStart) || !Number.isFinite(aEnd)) continue;

    const dtMs   = last.ts - first.ts;
    const dtDays = Math.max(dtMs / (24 * 3600 * 1000), HGV_MIN_DT_DAYS);

    const velocity = (aEnd - aStart) / dtDays;
    if (!Number.isFinite(velocity)) continue;

    if (velocity <= 0) continue;

    agg.push({
      mint,
      velocity,
      activityStart: aStart,
      activityEnd: aEnd,
      dtDays,
      kp: last.kp || {},
    });
  }

  agg.sort((a, b) => b.velocity - a.velocity);
  return agg;
}

export function mapHolderVelocityToRegistryRows(agg, limit = 10) {
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
    activity24: it.kp?.activity24 ?? it.activityEnd ?? 0,
    metric: it.velocity, 
  }));
}

addKpiAddon(
  {
    id: 'holderVelocity',
    updateMode: 'throttled',
    order: 20,  // after 'top3' (10) so it appears below
    label: 'Holders',
    title: 'Holder growth velocity',
    metricLabel: 'Tx/day Δ ',
    limit: 3,
  },
  {
    computePayload(snapshot) {
      let agg = computeHolderVelocityFromHistory();

      // Instant fallback: "delta" vs snapshot median activity.
      if ((!agg || !agg.length) && Array.isArray(snapshot) && snapshot.length) {
        const rows = [];
        const vals = [];

        for (const it of snapshot) {
          const mint = it.mint || it.id;
          if (!mint) continue;
          const activity24 = extractActivity24(it);
          if (!Number.isFinite(activity24)) continue;
          vals.push(activity24);
          rows.push({ mint, it, activity24 });
        }

        vals.sort((a, b) => a - b);
        const med = vals.length ? vals[Math.floor(vals.length / 2)] : 0;

        const out = [];
        for (const r of rows) {
          const velocity = (r.activity24 - med);
          if (!Number.isFinite(velocity) || velocity <= 0) continue;
          out.push({
            mint: r.mint,
            velocity,
            activityStart: med,
            activityEnd: r.activity24,
            dtDays: 1,
            kp: {
              symbol: r.it.symbol || '',
              name: r.it.name || '',
              imageUrl: r.it.logoURI || r.it.imageUrl || '',
              priceUsd: nzNum(r.it.priceUsd, 0),
              liqUsd: nzNum(r.it.liquidityUsd, 0),
              vol24: nzNum(r.it?.volume?.h24, 0),
              chg24: nzNum(r.it?.change?.h24, 0),
              pairUrl: r.it.pairUrl || '',
              activity24: r.activity24,
            },
          });
        }

        out.sort((a, b) => b.velocity - a.velocity);
        agg = out;
      }

      return {
        title: 'Holder growth velocity',
        metricLabel: 'Tx/day Δ ',
        items: mapHolderVelocityToRegistryRows(agg, 3),
      };
    },
    ingestSnapshot(items) {
      updateHgvHistory(items);
    },
  }
);
