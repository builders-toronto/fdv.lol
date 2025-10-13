import { getJSON } from '../core/tools.js';

export async function fetchJupiterTokens() {
  try {
    const arr = await getJSON('https://tokens.jup.ag/tokens', {timeout: 10000});
    const map = {};
    for (const t of (arr||[])) {
      if (!t?.address) continue;
      map[t.address] = {
        name: t.name, symbol: t.symbol, logoURI: t.logoURI,
        website: t.extensions?.website || null
      };
    }
    return map;
  } catch { return {}; }
}


async function provJupiterListSearch(query, { signal, limit = 12 } = {}) {
  const name = 'jupiter';
  const q = (query || '').trim().toLowerCase();
  if (!q) return [];
  try {
    const list = await loadJupList({ signal });
    const results = [];
    for (const t of list) {
      const sym = (t.symbol || '').toLowerCase();
      const nam = (t.name || '').toLowerCase();
      const mnt = (t.mint || '').toLowerCase();
      let hit = false;
      if (sym === q || nam === q || mnt === q) hit = true;
      else if (sym.startsWith(q) || nam.startsWith(q)) hit = true;
      else if (sym.includes(q) || nam.includes(q) || mnt.includes(q)) hit = true;
      if (hit) {
        results.push({
          mint: t.mint, symbol: t.symbol, name: t.name,
          imageUrl: t.imageUrl, priceUsd: null, bestLiq: null,
          dexId: 'jup', url: '',
          sources: ['jupiter'],
        });
        if (results.length >= limit) break;
      }
    }
    health.onSuccess(name);
    return results;
  } catch {
    health.onFailure(name);
    return [];
  }
}

// Jupiter token list
const JUP_LIST_URL = 'https://token.jup.ag/all';
async function loadJupList({ signal } = {}) {
  return swrFetch('v1|jup:list', async () => {
    const data = await withTimeout(sig => getJSON(JUP_LIST_URL, { signal: sig }), 15_000, signal);
    const arr = Array.isArray(data) ? data : Object.values(data || {});
    return arr.map(t => ({
      mint: t?.address || t?.mint || t?.id,
      symbol: t?.symbol || '',
      name: t?.name || '',
      imageUrl: t?.logoURI || t?.logo || '',
    })).filter(t => t.mint);
  }, { ttl: JUP_LIST_TTL_MS });
}
