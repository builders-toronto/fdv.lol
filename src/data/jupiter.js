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