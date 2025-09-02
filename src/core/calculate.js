import {
  RANK_WEIGHTS,
  FDV_LIQ_PENALTY,
  BUY_RULES,
  normLog,
  nz,
  clamp,
} from '../config/env.js';
import { isMemecoin } from '../utils/tools.js';


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

export function scoreAndRecommend(rows){
  for (const r of rows){
    const vol24 = nz(r.volume.h24), liq = nz(r.liquidityUsd), fdv = nz(r.fdv);
    const ch1 = nz(r.change.h1), ch6 = nz(r.change.h6), ch24 = nz(r.change.h24), ch5 = nz(r.change.m5);
    const tx = nz(r.txns.h24);

    const nVol = normLog(vol24,6);
    const nLiq = normLog(liq,6);
    const momRaw  = clamp((ch1+ch6+ch24)/100, -1, 1);
    const nMom  = momRaw>0 ? momRaw : momRaw*0.5; 
    const nAct = normLog(tx,4);

    let score = RANK_WEIGHTS.volume*nVol + RANK_WEIGHTS.liquidity*nLiq
              + RANK_WEIGHTS.momentum*nMom + RANK_WEIGHTS.activity*nAct;

    let penaltyApplied = false;
    if (liq>0 && fdv/Math.max(liq,1) > FDV_LIQ_PENALTY.ratio) { score -= FDV_LIQ_PENALTY.penalty; penaltyApplied=true; }
    score = clamp(score,0,1);

    let rec='AVOID', why=['Weak composite score'];
    if (score>=BUY_RULES.score && liq>=BUY_RULES.liq && vol24>=BUY_RULES.vol24 && ch1>BUY_RULES.change1h) {
      rec='GOOD'; why=['Strong composite score'];
      if (ch1>0) why.push('Positive 1h momentum');
      if (ch24>0) why.push('Up over 24h');
      if (liq>0) why.push('Healthy liquidity');
      if (vol24>0) why.push('Active trading volume');
    } else if (score>=0.40) {
      rec='WATCH'; why=['Decent composite score'];
      if (ch1<0) why.push('Short-term dip (entry risk)');
      if (penaltyApplied) why.push('FDV/liquidity imbalance');
    } else {
      if (ch24<0) why.push('Down over 24h');
      if (liq<25_000) why.push('Thin liquidity');
      if (vol24<50_000) why.push('Low trading activity');
    }

    r.score=score; r.recommendation=rec; r.why=why;
    r._norm = { nVol, nLiq, nMom: clamp((nMom+1)/2,0,1), nAct }; // normalize mom to 0..1 for bars
    r._chg  = [ch5, ch1, ch6, ch24]; // for sparkline
  }
  return rows.sort((a,b)=> b.score-a.score || b.volume.h24-a.volume.h24);
}
