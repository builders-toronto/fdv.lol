import { addKpiAddon } from './ingest.js';

export const SMQ_STORAGE_KEY = 'meme_top3_history_v1';
export const SMQ_WINDOW_DAYS = 3;

const DAY_MS = 24*3600*1000;
const clamp01 = (n) => Math.max(0, Math.min(1, n));
const nz = (n, d=0) => {
  const x = Number(n);
  return Number.isFinite(x) ? x : d;
};


function loadHistory() {
  try {
    const raw = localStorage.getItem(SMQ_STORAGE_KEY);
    return raw ? JSON.parse(raw) : { byMint: {}, total: 0 };
  } catch {
    return { byMint: {}, total: 0 };
  }
}
function pruneHistory(h, windowDays){
  const cutoff = Date.now() - windowDays*DAY_MS;
  const next = { byMint: {}, total: 0 };
  for (const [mint, arr0] of Object.entries(h.byMint || {})) {
    const arr = (Array.isArray(arr0)?arr0:[]).filter(e => +e.ts >= cutoff);
    if (arr.length) {
      next.byMint[mint] = arr;
      next.total += arr.length;
    }
  }
  return next;
}

function seriesFromHistory(h, mint, windowDays){
  const cutoff = Date.now() - windowDays*DAY_MS;
  const rows = (h.byMint?.[mint] || []).filter(e => +e.ts >= cutoff);
  if (!rows.length) return null;
  rows.sort((a,b)=>a.ts-b.ts);

  const ts = rows.map(e => +e.ts);
  const price = rows.map(e => nz(e.kp?.priceUsd, NaN)).filter(Number.isFinite);
  const liq   = rows.map(e => nz(e.kp?.liqUsd,   NaN)).filter(Number.isFinite);
  const vol   = rows.map(e => nz(e.kp?.vol24,    NaN)).filter(Number.isFinite);

  if (price.length < 5) return null;
  return { ts, price, liq, vol, latest: rows[rows.length-1]?.kp || {} };
}


function linregPctPerDay(tsArr, priceArr){
  const n = Math.min(tsArr.length, priceArr.length);
  if (n < 5) return { slopePctPerDay: 0, r2: 0 };

  const xs = tsArr.slice(-60).map(t => t / DAY_MS);
  const ys = priceArr.slice(-60).map(p => Math.log(Math.max(1e-12, p)));
  const m = xs.length; if (m < 5) return { slopePctPerDay: 0, r2: 0 };

  const meanX = xs.reduce((a,b)=>a+b,0)/m;
  const meanY = ys.reduce((a,b)=>a+b,0)/m;

  let sxx=0, sxy=0, syy=0;
  for (let i=0;i<m;i++){
    const dx = xs[i]-meanX, dy = ys[i]-meanY;
    sxx += dx*dx; sxy += dx*dy; syy += dy*dy;
  }
  if (sxx === 0 || syy === 0) return { slopePctPerDay: 0, r2: 0 };

  const slope = sxy / sxx;
  const r2 = clamp01((sxy*sxy)/(sxx*syy));
  const slopePctPerDay = (Math.exp(slope) - 1) * 100;
  return { slopePctPerDay, r2 };
}
function reversalRate(priceArr){
  if (!priceArr || priceArr.length < 6) return 0.5;
  let flips = 0, total = 0, prevSign = 0;
  for (let i=1; i<priceArr.length; i++){
    const r = priceArr[i]/Math.max(1e-12, priceArr[i-1]) - 1;
    const s = r>0 ? 1 : (r<0 ? -1 : 0);
    if (s!==0){
      if (prevSign !== 0 && s !== prevSign) flips++;
      prevSign = s;
      total++;
    }
  }
  return total ? flips/total : 0.5;
}


function computeSMQForMint(mint, windowDays = SMQ_WINDOW_DAYS){
  const hist = pruneHistory(loadHistory(), windowDays);
  const s = seriesFromHistory(hist, mint, windowDays);
  if (!s) return 0;

  const { ts, price, liq, vol, latest } = s;

  const { slopePctPerDay, r2 } = linregPctPerDay(ts, price);
  const trendPos = clamp01( (Math.tanh(slopePctPerDay/12) + 1)/2 );

  const reversals = reversalRate(price);
  const stability = clamp01( 0.7*r2 + 0.3*(1 - reversals) );

  const avgLiq = liq.length ? liq.reduce((a,b)=>a+b,0)/liq.length : 0;
  const avgVol = vol.length ? vol.reduce((a,b)=>a+b,0)/vol.length : 0;
  const pressure = clamp01( Math.log10(1 + (avgVol / Math.max(1, avgLiq))) / 2 );

  const liqW = clamp01( Math.log10(1 + (latest.liqUsd || avgLiq)) / 6 );

  const smq01 = clamp01( 0.45*trendPos + 0.30*stability + 0.15*pressure + 0.10*liqW );
  return Math.round(smq01 * 100);
}

export function computeSMQTable(windowDays = SMQ_WINDOW_DAYS){
  const hist = pruneHistory(loadHistory(), windowDays);
  const out = [];
  for (const mint of Object.keys(hist.byMint || {})) {
    const smq = computeSMQForMint(mint, windowDays);
    const arr = hist.byMint[mint];
    const latestKP = arr?.length ? arr[arr.length-1]?.kp || {} : {};
    out.push({ mint, smq, latestKP });
  }
  out.sort((a,b)=>b.smq - a.smq);
  return out;
}

function mapToRegistryRows(tbl){
  return tbl.map(({ mint, smq, latestKP: kp }) => ({
    mint,
    symbol: kp?.symbol || '',
    name: kp?.name || '',
    imageUrl: kp?.imageUrl || '',
    priceUsd: kp?.priceUsd ?? 0,
    chg24: kp?.chg24 ?? 0,
    liqUsd: kp?.liqUsd ?? 0,
    vol24: kp?.vol24 ?? 0,
    pairUrl: kp?.pairUrl || '',
    metric: smq
  }));
}




addKpiAddon(
  {
    id: 'smq',
    order: 15,
    label: 'SMQ',
    title: `SMQ leaders (last ${SMQ_WINDOW_DAYS}d)`,
    metricLabel: 'SMQ',
    limit: 3,
  },
  {
    computePayload() {
      const tbl = computeSMQTable(SMQ_WINDOW_DAYS).slice(0, 3);
      return {
        title: `SMQ leaders`,
        metricLabel: 'SMQ',
        items: mapToRegistryRows(tbl),
      };
    },
    ingestSnapshot() {}
  }
);

