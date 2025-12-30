function nz(v, d = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
}

export function getMint(it) {
  const m = it?.mint ?? it?.id ?? null;
  return m ? String(m) : '';
}

export function getSymbol(it) {
  return String(it?.symbol || '');
}

export function getName(it) {
  return String(it?.name || '');
}

export function getImageUrl(it) {
  return String(it?.logoURI || it?.imageUrl || '');
}

export function getPairUrl(it) {
  return String(it?.pairUrl || '');
}

export function getPriceUsd(it) {
  return nz(it?.priceUsd, 0);
}

export function getChg24(it) {
  return nz(it?.chg24, null)
    ?? nz(it?.change24h, null)
    ?? nz(it?.change?.h24, 0);
}

export function getVol24(it) {
  return nz(it?.vol24, null)
    ?? nz(it?.vol24hUsd, null)
    ?? nz(it?.volume?.h24, 0);
}

export function getLiqUsd(it) {
  return nz(it?.liqUsd, null) ?? nz(it?.liquidityUsd, 0);
}

export function getTx24(it) {
  const buys = nz(it?.txns?.h24?.buys, null);
  const sells = nz(it?.txns?.h24?.sells, null);
  if (Number.isFinite(buys) || Number.isFinite(sells)) {
    return nz(buys, 0) + nz(sells, 0);
  }
  return nz(it?.txns?.h24, null) ?? nz(it?.tx24, 0);
}

export function getBuySellImbalance01(it) {
  const buys = nz(it?.buys24, null) ?? nz(it?.buys, null);
  const sells = nz(it?.sells24, null) ?? nz(it?.sells, null);
  if (Number.isFinite(buys) && Number.isFinite(sells) && buys >= 0 && sells >= 0) {
    const denom = Math.max(1, buys + sells);
    return Math.max(-1, Math.min(1, (buys - sells) / denom));
  }

  const bs = nz(it?.buySell24h, null);
  if (Number.isFinite(bs) && bs !== 0) {
    const scaled = Math.abs(bs) > 1.5 ? (bs / 100) : bs;
    return Math.max(-1, Math.min(1, scaled));
  }

  const chg24 = getChg24(it);
  return Math.max(-1, Math.min(1, chg24 / 100));
}

export function getMcap(it) {
  return nz(it?.fdv, null) ?? nz(it?.marketCap, 0);
}
