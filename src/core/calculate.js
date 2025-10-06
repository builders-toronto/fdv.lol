import {
  RANK_WEIGHTS,
  FDV_LIQ_PENALTY,
  BUY_RULES,
  normLog,
  nz,
  clamp,
} from '../config/env.js';
import { isMemecoin } from '../core/tools.js';


export function bestPerToken(pairs, {relax=false}={}) {
  const bucket = new Map();
  for (const p of pairs) {
    const base = p.baseToken||{};
    const mint = base.address;
    if (!mint) continue;

    const name   = base.name||'';
    const symbol = base.symbol||'';
    if (!isMemecoin(name, symbol, relax)) continue;

    const info = p.info || {};
    const website = Array.isArray(info.websites) && info.websites.length ? info.websites[0].url : null;
    const socials = Array.isArray(info.socials) ? info.socials : [];
    const logoURI = info.imageUrl || null;

    const vol24 = nz(p.volume?.h24 ?? p.volume24h);
    const liq   = nz(p.liquidity?.usd ?? p.liquidityUsd);

    const cand = {
      mint,
      name: name || symbol || mint,
      symbol,
      logoURI,                
      website,                
      socials,                
      priceUsd: nz(p.priceUsd ?? p.price?.usd),
      change: {
        m5:  nz(p.priceChange?.m5  ?? p.priceChange5m),
        h1:  nz(p.priceChange?.h1  ?? p.priceChange1h),
        h6:  nz(p.priceChange?.h6  ?? p.priceChange6h),
        h24: nz(p.priceChange?.h24 ?? p.priceChange24h),
      },
      volume: { h24: vol24 },
      txns: { h24: nz((p.txns?.h24?.buys||0) + (p.txns?.h24?.sells||0)) },
      fdv: nz(p.fdv),
      liquidityUsd: liq,
      dex: p.dexId || '',
      pairUrl: p.url || '',
      pairAddress: p.pairAddress || ''
    };

    const prev = bucket.get(mint);
    if (!prev) { bucket.set(mint, cand); continue; }
    if (vol24 > prev.volume.h24 || (vol24 === prev.volume.h24 && liq > prev.liquidityUsd)) {
      bucket.set(mint, cand);
    }
  }
  return [...bucket.values()];
}

export function scoreAndRecommendOne(r) {
  const N = (x, d = 0) => Number.isFinite(+x) ? +x : d;
  const pick = (...cands) => cands.find(v => Number.isFinite(+v));

  // Volume 24h
  const vol24 = N(pick(
    r?.volume?.h24,           // list shape
    r?.v24hTotal,             // profile shape
    r?.v24h,                  // pairs row fallback
    r?.v24hUSD
  ), 0);

  // Liquidity USD
  const liq = N(pick(
    r?.liquidityUsd,          // both shapes use this often
    r?.liquidity?.usd
  ), 0);

  // FDV (fallback market cap)
  const fdv = N(pick(
    r?.fdv,
    r?.marketCap
  ), 0);

  // Txns 24h (buys + sells)
  const tx = N(pick(
    r?.txns?.h24,                                     // list shape
    (r?.tx24h?.buys ?? NaN) + (r?.tx24h?.sells ?? NaN) // profile shape
  ), 0);

  // Momentum deltas (percent points)
  const ch5  = N(pick(r?.change?.m5,  r?.change5m),   0);
  const ch1  = N(pick(r?.change?.h1,  r?.change1h),   0);
  const ch6  = N(pick(r?.change?.h6,  r?.change6h),   0);
  const ch24 = N(pick(r?.change?.h24, r?.change24h),  0);

  // Optional helpers available in both worlds
  const liqToFdvPct = N(pick(r?.liqToFdvPct), NaN);
  const volToLiq24h = N(pick(r?.volToLiq24h, vol24 / Math.max(liq, 1)), 0);

  // Keep a copy of original for return; don’t mutate caller input
  const out = {
    ...r,
    volume: { ...(r?.volume||{}), h24: vol24 },
    txns:   { ...(r?.txns||{}),   h24: tx },
    change: { ...(r?.change||{}), m5: ch5, h1: ch1, h6: ch6, h24: ch24 },
    fdv, liquidityUsd: liq,
  };
  // Volume: turnover-based (friendlier across caps)
  const turnover = volToLiq24h;                // e.g., 0.57×
  const nVol = clamp((turnover - 0.2) / (1.5 - 0.2), 0, 1);

  // Liquidity (log scale)
  const nLiq = normLog(liq, 6);

  // Momentum: blend 1h/6h/24h, penalize negatives, then map to 0..1
  const momRaw = clamp((ch1 + ch6 + ch24) / 100, -1, 1);
  const momSigned = momRaw > 0 ? momRaw : momRaw * 0.5; // negatives discounted
  const nMom = clamp((momSigned + 1) / 2, 0, 1);        // -1..1 → 0..1

  // Activity: tx per $1M FDV with anchors 30..200 → 0..1
  const fdvM   = Math.max(1, fdv / 1e6);
  const txPerM = tx / fdvM;
  const A_LOW = 30, A_HIGH = 200;
  const nAct = clamp((txPerM - A_LOW) / (A_HIGH - A_LOW), 0, 1);

  let score =
      RANK_WEIGHTS.volume    * nVol +
      RANK_WEIGHTS.liquidity * nLiq +
      RANK_WEIGHTS.momentum  * nMom +
      RANK_WEIGHTS.activity  * nAct;

  let penaltyApplied = false;
  if (liq > 0 && fdv / Math.max(liq, 1) > FDV_LIQ_PENALTY.ratio) {
    score -= (FDV_LIQ_PENALTY.penalty ?? 0.10);
    penaltyApplied = true;
  }
  score = clamp(score, 0, 1);

  const BUY_SCORE = Number.isFinite(BUY_RULES?.score) ? BUY_RULES.score : null;

  let rec = 'SHILL';
  let why = ['Weak composite score'];
  why.push('Try shilling it!');

  if (
    (BUY_SCORE == null || score >= BUY_SCORE) &&
    liq   >= BUY_RULES.liq   &&
    vol24 >= BUY_RULES.vol24 &&
    ch1   >  BUY_RULES.change1h
  ) {
    rec = 'GOOD';
    why = ['Strong composite score'];
    if (ch1   > 0) why.push('Positive 1h momentum');
    if (ch24  > 0) why.push('Up over 24h');
    if (liq   > 0) why.push('Healthy liquidity');
    if (vol24 > 0) why.push('Active trading volume');
  } else if (score >= 0.40) {
    rec = 'WATCH';
    why = ['Decent composite score'];
    if (ch1 < 0)        why.push('Short-term dip (entry risk)');
    if (penaltyApplied) why.push('FDV/liquidity imbalance');
  } else {
    if (ch24 < 0)           why.push('Down over 24h');
    if (liq  < 25_000)      why.push('Thin liquidity');

    // Use tx + turnover here; don’t conflate with “volume”
    if (tx < 500 && turnover < 0.25) {
      why.push('Low trading activity');
    } else if (tx < 1500) {
      why.push('Subpar trading activity');
    }
  }

  out.score = score;
  out.recommendation = rec;
  out.why = why;
  out._norm = { nVol, nLiq, nMom, nAct };
  out._chg  = [ch5, ch1, ch6, ch24];

  return out;
}


export function scoreAndRecommend(rows){
  const scored = rows.map(row => scoreAndRecommendOne(row));
  return scored.sort((a, b) => b.score - a.score || b.volume.h24 - a.volume.h24);
}
