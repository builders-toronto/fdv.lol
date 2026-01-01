import {
  getMint,
  getSymbol,
  getName,
  getImageUrl,
  getPairUrl,
  getPriceUsd,
  getChg24,
  getVol24,
  getLiqUsd,
  getTx24,
  getBuySellImbalance01,
  getMcap,
} from './kpiExtract.js';

function clamp01(n) {
  return Math.max(0, Math.min(1, n));
}

function nz(v, d = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
}

function log01(v, maxV) {
  const x = Math.max(0, nz(v, 0));
  const m = Math.max(1e-9, nz(maxV, 1));
  return clamp01(Math.log10(1 + x) / Math.log10(1 + m));
}

function percentileRank(sortedVals, v) {
  if (!sortedVals.length) return 0;
  const x = nz(v, 0);
  // lower_bound
  let lo = 0;
  let hi = sortedVals.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (sortedVals[mid] < x) lo = mid + 1;
    else hi = mid;
  }
  return clamp01(lo / Math.max(1, sortedVals.length - 1));
}

function buildContext(list) {
  const vols = [];
  const liqs = [];
  const txs = [];
  const effs = [];

  for (const it of list) {
    const vol24 = getVol24(it);
    const liqUsd = getLiqUsd(it);
    const tx24 = getTx24(it);
    vols.push(Math.max(0, vol24));
    liqs.push(Math.max(0, liqUsd));
    txs.push(Math.max(0, tx24));
    effs.push(liqUsd > 0 ? (Math.max(0, vol24) / (liqUsd + 1)) : 0);
  }

  vols.sort((a, b) => a - b);
  liqs.sort((a, b) => a - b);
  txs.sort((a, b) => a - b);
  effs.sort((a, b) => a - b);

  return {
    maxVol: vols.length ? vols[vols.length - 1] : 1,
    maxLiq: liqs.length ? liqs[liqs.length - 1] : 1,
    maxTx: txs.length ? txs[txs.length - 1] : 1,
    vols,
    liqs,
    txs,
    effs,
  };
}

export function buildKpiScoreContext(snapshot) {
  const list = Array.isArray(snapshot) ? snapshot : [];
  return buildContext(list);
}

function scoreItem(it, ctx) {
  const mint = getMint(it);
  const chg24 = getChg24(it);
  const vol24 = getVol24(it);
  const liqUsd = getLiqUsd(it);
  const tx24 = getTx24(it);
  const imb01 = getBuySellImbalance01(it);
  const mcap = getMcap(it);

  const vol01 = log01(vol24, ctx.maxVol);
  const liq01 = log01(liqUsd, ctx.maxLiq);
  const tx01 = log01(tx24, ctx.maxTx);

  const eff = liqUsd > 0 ? (Math.max(0, vol24) / (liqUsd + 1)) : 0;
  const eff01 = percentileRank(ctx.effs, eff);

  // Momentum proxy: prefer green + size by mcap and activity.
  const chgClamped = Math.max(-80, Math.min(200, nz(chg24, 0)));
  const mom01 = clamp01((chgClamped + 30) / 130); // -30..+100 -> 0..1
  const mcap01 = clamp01(Math.log10(1 + Math.max(0, mcap)) / 10); // ~0..1

  const flow01 = clamp01((imb01 + 1) / 2);

  // Quality = can we trade it (liq + activity + efficiency + stability proxy)
  const quality01 = clamp01(
    0.30 * liq01 +
    0.25 * vol01 +
    0.15 * tx01 +
    0.20 * eff01 +
    0.10 * mcap01
  );

  // Risk penalty: big red + low liq tends to be trap/slippage.
  const red01 = clamp01((-chgClamped) / 60);
  const lowLiq01 = clamp01(1 - liq01);
  const riskPenalty01 = clamp01(0.60 * red01 + 0.40 * lowLiq01);

  // Final alpha-ish score: weight momentum and flow, gated by quality.
  const alpha01 = clamp01(0.55 * mom01 + 0.25 * flow01 + 0.20 * eff01);
  const final01 = clamp01((0.65 * alpha01 + 0.35 * quality01) * (1 - 0.65 * riskPenalty01));

  return {
    mint,
    score01: final01,
    quality01,
    alpha01,
    risk01: riskPenalty01,
    kp: {
      symbol: getSymbol(it),
      name: getName(it),
      imageUrl: getImageUrl(it),
      pairUrl: getPairUrl(it),
      priceUsd: getPriceUsd(it),
      chg24,
      liqUsd,
      vol24,
      tx24,
      imbalance01: imb01,
      mcap,
    },
  };
}

export function scoreKpiItem(it, ctx) {
  return scoreItem(it, ctx);
}

export function selectTradeCandidatesFromKpis({
  snapshot,
  pumpLeaders = null,
  topN = 1,
  minLiqUsd = 2500,
  minVol24 = 250,
  rugFn = null,
  pumpBoost = 0.08,
} = {}) {
  const list = Array.isArray(snapshot) ? snapshot : [];
  if (!list.length) return [];

  const ctx = buildContext(list);
  const pumpSet = new Set((Array.isArray(pumpLeaders) ? pumpLeaders : [])
    .map(r => String(r?.mint || ''))
    .filter(Boolean));

  const scored = [];
  for (const it of list) {
    const mint = getMint(it);
    if (!mint) continue;

    const liqUsd = getLiqUsd(it);
    const vol24 = getVol24(it);
    if (!Number.isFinite(liqUsd) || liqUsd < minLiqUsd) continue;
    if (!Number.isFinite(vol24) || vol24 < minVol24) continue;

    // Rug filter (if available): skip severe signals.
    if (typeof rugFn === 'function') {
      try {
        const sig = rugFn(mint);
        const sev = Number(sig?.severity || 0);
        if (Number.isFinite(sev) && sev >= 2) continue;
      } catch {}
    }

    const row = scoreItem(it, ctx);
    if (!row.mint) continue;

    // Favor things already showing up in pump leaders.
    if (pumpSet.has(row.mint)) {
      row.score01 = clamp01(row.score01 + pumpBoost);
      row.pumpLeader = true;
    }

    scored.push(row);
  }

  scored.sort((a, b) => b.score01 - a.score01);
  return scored.slice(0, Math.max(1, topN | 0));
}
