function nzNum(v, d = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
}

export function scoreSnapshot(items) {
  const unpack = (it) => ({
    it,
    vol: nzNum(it?.volume?.h24, null),
    liq: nzNum(it?.liquidityUsd, null),
    tx: nzNum(it?.txns?.h24, null),
    chg: Number.isFinite(Number(it?.change?.h24)) ? Number(it.change.h24) : 0,
    price: nzNum(it?.priceUsd, null),
  });

  const rows = (Array.isArray(items) ? items : []).map(unpack);
  const sample = rows.filter(r =>
    Number.isFinite(r.vol) || Number.isFinite(r.liq) ||
    Number.isFinite(r.tx) || Number.isFinite(r.price)
  );
  if (!sample.length) return [];

  const pos = (v) => (Number.isFinite(v) && v > 0 ? v : 0);
  const maxVol = Math.max(...sample.map(r => pos(r.vol)), 1);
  const maxLiq = Math.max(...sample.map(r => pos(r.liq)), 1);
  const maxTx = Math.max(...sample.map(r => pos(r.tx)), 1);

  const norm = (v, m) => {
    const x = pos(v);
    return m > 0 ? Math.min(1, Math.log10(1 + x) / Math.log10(1 + m)) : 0;
  };
  const clamp01 = (n) => Math.max(0, Math.min(1, n));

  return sample
    .map(({ it, vol, liq, tx, chg, price }) => {
      const nVol = norm(vol, maxVol);
      const nLiq = norm(liq, maxLiq);
      const nTx = norm(tx, maxTx);
      const nChg = Number.isFinite(chg)
        ? (chg >= 0 ? clamp01(chg / 100) : -clamp01(Math.abs(chg) / 100))
        : 0;

      const score01 = 0.35 * nVol + 0.25 * nTx + 0.20 * nLiq + 0.20 * (0.5 + nChg / 2);
      const score = Math.round(score01 * 100);

      return {
        mint: it.mint || it.id,
        symbol: it.symbol || '',
        name: it.name || '',
        imageUrl: it.imageUrl || it.logoURI || '',
        pairUrl: it.pairUrl || '',
        priceUsd: Number.isFinite(price) ? price : 0,
        chg24: Number.isFinite(chg) ? chg : 0,
        liqUsd: Number.isFinite(liq) ? liq : 0,
        vol24: Number.isFinite(vol) ? vol : 0,
        score,
      };
    })
    .filter(r => !!r.mint)
    .sort((a, b) => b.score - a.score);
}

export function mapAggToRegistryRows(agg) {
  return (Array.isArray(agg) ? agg : []).map(it => ({
    mint: it.mint,
    symbol: it.kp?.symbol || '',
    name: it.kp?.name || '',
    imageUrl: it.kp?.imageUrl || '',
    priceUsd: it.kp?.priceUsd ?? 0,
    chg24: it.kp?.chg24 ?? 0,
    liqUsd: it.kp?.liqUsd ?? 0,
    vol24: it.kp?.vol24 ?? 0,
    pairUrl: it.kp?.pairUrl || '',
    metric: it.avgScore,
  }));
}
