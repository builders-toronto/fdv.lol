import { getJSON } from '../utils/tools.js';

export async function fetchTrending(){ return []; }

export async function fetchSearches() {
  const terms = [
    'solana pepe','solana dog','solana wif','solana bonk','solana cat',
    'solana frog','solana shib','solana meme','solana snek','solana bob',
    'solana new','solana trending','solana pump', 'solana dump', 'solana inu',
    'solana elon', 'solana floki', 'solana corgi', 'solana monke', 'solana ape',
    'solana dino', 'solana purr', 'solana purry', 'solana kitty', 'solana paws',
    'solana toad', 'solana hamster', 'solana doge', 'solana shiba', 'solana giga',
    'solana sigma', 'solana baby', 'solana wife', 'solana husband', 'solana reno'
  ];
  const urls = terms.map(t=>`https://api.dexscreener.com/latest/dex/search?q=${encodeURIComponent(t)}`);
  const results = await Promise.allSettled(urls.map(u => getJSON(u).then(x => x?.pairs || [])));
  const out=[]; const seen=new Set();
  for (const r of results) if (r.status==='fulfilled') for (const p of r.value) {
    if (p.chainId!=='solana') continue;
    const id = p.pairAddress || p.url || `${p.baseToken?.address}:${p.dexId}`;
    if (!seen.has(id)) { seen.add(id); out.push(p); }
  }
  return out;
}

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