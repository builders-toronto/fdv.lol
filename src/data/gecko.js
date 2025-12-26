let _geckoFailUntil = 0;
let _geckoSeedStale = { ts: 0, data: [] };
const GECKO_COOLDOWN_MS = 5 * 60_000;
const GECKO_SEED_STALE_MAX_MS = 10 * 60_000; // 10m
const GECKO_MAX_CONCURRENT = 1;
let _geckoInFlight = 0;

function geckoInCooldown() {
  return Date.now() < _geckoFailUntil || health.isDegraded('geckoterminal');
}
function geckoMarkFail() {
  _geckoFailUntil = Date.now() + GECKO_COOLDOWN_MS;
}

export async function geckoSeedTokens({ signal, limitTokens = 120 } = {}) {
  const name = 'gecko-seed';
  if (geckoInCooldown()) {
    if (_geckoSeedStale.data.length && (Date.now() - _geckoSeedStale.ts) < GECKO_SEED_STALE_MAX_MS) {
      return _geckoSeedStale.data;
    }
    return [];
  }

  while (_geckoInFlight >= GECKO_MAX_CONCURRENT) {
    if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
    await sleep(40);
  }

  _geckoInFlight += 1;
  try {
    const headers = { accept: 'application/json;version=20230302' };
    const tUrl = 'https://api.geckoterminal.com/api/v2/networks/solana/trending_pools';
    const nUrl = 'https://api.geckoterminal.com/api/v2/networks/solana/new_pools';

    const [tr, nw] = await Promise.all([
      withTimeout(sig => fetchJsonNoThrow(tUrl, { signal: sig, headers }), 8_000, signal),
      withTimeout(sig => fetchJsonNoThrow(nUrl, { signal: sig, headers }), 8_000, signal),
    ]);

    if ((tr?.status === 429) || (nw?.status === 429)) {
      geckoMarkFail();
      health.onFailure(name);
      if (_geckoSeedStale.data.length) return _geckoSeedStale.data;
      return [];
    }

    const trendingPools = Array.isArray(tr?.json?.data) ? tr.json.data : [];
    const newPools      = Array.isArray(nw?.json?.data) ? nw.json.data : [];
    if (!trendingPools.length && !newPools.length) {
      geckoMarkFail();
      health.onFailure(name);
      if (_geckoSeedStale.data.length) return _geckoSeedStale.data;
      return [];
    }

    const tagByMint = new Map();
    const mints = [];
    const seen  = new Set();

    const takePool = (p, tag) => {
      const a = p?.attributes || {};
      const mint = a?.base_token_address || a?.base_token?.address || a?.token0_address;
      if (!mint || seen.has(mint)) return;
      seen.add(mint);
      tagByMint.set(mint, tag);
      mints.push(mint);
    };

    for (const p of trendingPools) takePool(p, 'gecko-trending');
    for (const p of newPools)      takePool(p, 'gecko-new');

    if (!mints.length) {
      geckoMarkFail();
      health.onFailure(name);
      if (_geckoSeedStale.data.length) return _geckoSeedStale.data;
      return [];
    }

    const batch = mints.slice(0, Math.min(100, limitTokens)).join(',');
    const tokUrl = `https://api.geckoterminal.com/api/v2/networks/solana/tokens/multi/${encodeURIComponent(batch)}`;
    const tokResp = await withTimeout(sig => fetchJsonNoThrow(tokUrl, { signal: sig, headers }), 8_000, signal);

    if (tokResp?.status === 429) {
      geckoMarkFail();
      health.onFailure(name);
      if (_geckoSeedStale.data.length) return _geckoSeedStale.data;
      return [];
    }

    const tokenRows = Array.isArray(tokResp?.json?.data) ? tokResp.json.data : [];
    if (!tokenRows.length) {
      geckoMarkFail();
      health.onFailure(name);
      if (_geckoSeedStale.data.length) return _geckoSeedStale.data;
      return [];
    }

    const out = [];
    for (const t of tokenRows) {
      const a = t?.attributes || {};
      const addr = a?.address;
      if (!addr) continue;
      const tag = tagByMint.get(addr) || 'gecko-trending';
      out.push({
        mint: addr,
        symbol: a?.symbol || '',
        name: a?.name || '',
        imageUrl: a?.image_url || '',
        priceUsd: asNum(a?.price_usd),
        bestLiq: null,
        dexId: 'gecko',
        url: '',
        sources: [tag],
      });
    }

    _geckoSeedStale = { ts: Date.now(), data: out.slice() };
    health.onSuccess(name);
    return out;
  } catch {
    geckoMarkFail();
    health.onFailure(name);
    if (_geckoSeedStale.data.length) return _geckoSeedStale.data;
    return [];
  } finally {
    _geckoInFlight = Math.max(0, _geckoInFlight - 1);
  }
}

export async function getGeckoSeeds(opts = {}) {
  return geckoSeedTokens(opts);
}