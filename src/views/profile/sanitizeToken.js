const toNum = (x, d = null) => {
  if (x == null) return d;
  if (typeof x === 'string') x = x.replace(/[%_,\s]/g, '');
  const n = Number(x);
  return Number.isFinite(n) ? n : d;
};

export default function sanitizeToken(raw = {}) {
  const buys  = toNum(raw?.tx24h?.buys,  null);
  const sells = toNum(raw?.tx24h?.sells, null);
  let buySell = toNum(raw.buySell24h, null);
  if (buySell != null && buySell > 1.0001) buySell = buySell / 100;

  return {
    ...raw,
    priceUsd:     toNum(raw.priceUsd,     null),
    liquidityUsd: toNum(raw.liquidityUsd, null),
    fdv:          toNum(raw.fdv,          null),
    marketCap:    toNum(raw.marketCap,    null),
    liqToFdvPct:  toNum(raw.liqToFdvPct,  null),

    v5mTotal:     toNum(raw.v5mTotal,     0),
    v1hTotal:     toNum(raw.v1hTotal,     0),
    v6hTotal:     toNum(raw.v6hTotal,     0),
    v24hTotal:    toNum(raw.v24hTotal,    0),
    volToLiq24h:  toNum(raw.volToLiq24h,  null),

    change5m:     toNum(raw.change5m,     null),
    change1h:     toNum(raw.change1h,     null),
    change6h:     toNum(raw.change6h,     null),
    change24h:    toNum(raw.change24h,    null),

    ageMs:        toNum(raw.ageMs,        null),
    buySell24h:   buySell,

    tx24h: { buys, sells },

    pairs: Array.isArray(raw.pairs) ? raw.pairs.map(p => ({
      ...p,
      priceUsd:     toNum(p.priceUsd,     null),
      liquidityUsd: toNum(p.liquidityUsd, null),
      v24h:         toNum(p.v24h,         0),
      change1h:     toNum(p.change1h,     null),
      change24h:    toNum(p.change24h,    null),
    })) : [],
  };
}
