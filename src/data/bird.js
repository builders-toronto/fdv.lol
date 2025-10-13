export async function provBirdeyeSearch(query, { signal, limit = 12 } = {}) {
  const name = 'birdeye';
  if (!BIRDEYE_API_KEY) return [];
  const key = `v1|be:search:${query}`;
  try {
    const res = await swrFetch(key, async () => {
      const url = `https://public-api.birdeye.so/defi/v3/search?keyword=${encodeURIComponent(query)}&chain=solana`;
      let json;
      try {
        json = await withTimeout(sig => getJSON(url, {
          signal: sig, headers: { accept: 'application/json', 'X-API-KEY': BIRDEYE_API_KEY }
        }), 8_000, signal);
      } catch { return []; }
      const arr = json?.data?.items || json?.data || [];
      const out = [];
      for (const t of arr) {
        const mint = t?.address || t?.mint || t?.tokenAddress;
        if (!mint) continue;
        out.push({
          mint,
          symbol: t?.symbol || '',
          name: t?.name || '',
          priceUsd: asNum(t?.price || t?.usd_price),
          bestLiq: asNum(t?.liquidity || t?.liquidity_usd),
          dexId: 'birdeye',
          url: '',
          imageUrl: t?.logoURI || t?.logo || '',
          sources: ['birdeye'],
        });
        if (out.length >= limit) break;
      }
      return out;
    }, { ttl: 2 * 60_000 });
    health.onSuccess(name);
    return res;
  } catch {
    health.onFailure(name);
    return [];
  }
}
