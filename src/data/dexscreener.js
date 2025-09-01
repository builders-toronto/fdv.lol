import { getJSON } from '../utils/tools.js';

function asNum(x) {
  const n = Number(x);
  return Number.isFinite(n) ? n : null;
}

export async function fetchDexscreener() {
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

export async function fetchTokenInfo(mint) {
  const url = `https://api.dexscreener.com/latest/dex/tokens/${encodeURIComponent(mint)}`;
  const res = await fetch(url, { headers: { accept: "application/json" } });
  if (res.status === 429) return { error: 'Rate limited.' };
  if (!res.ok) throw new Error(`dexscreener ${res.status}`);
  const json = await res.json();

  const pairs = Array.isArray(json?.pairs) ? json.pairs.filter(p => p?.baseToken?.address === mint) : [];
  const list = pairs.length ? pairs : (Array.isArray(json?.pairs) ? json.pairs : []);
  if (!list.length) throw new Error("No pairs");

  const best = list.slice().sort((a,b)=> (b?.liquidity?.usd||0)-(a?.liquidity?.usd||0))[0];

  const v = (k) => list.reduce((acc, p) => acc + (p?.volume?.[k] || 0), 0);
  const tx = (k) => ({
    buys: list.reduce((a,p)=> a + (p?.txns?.[k]?.buys || 0), 0),
    sells: list.reduce((a,p)=> a + (p?.txns?.[k]?.sells || 0), 0),
  });

  const earliest = list.reduce((min, p) => {
    const t = p?.pairCreatedAt; return (typeof t === "number" && t > 0) ? Math.min(min, t) : min;
  }, Number.POSITIVE_INFINITY);

  const base = best?.baseToken || {};
  const info = best?.info || {};

  const model = {
    mint: base.address || mint,
    symbol: base.symbol || "",
    name: base.name || "",
    imageUrl: info.imageUrl,
    headerUrl: info.header,

    priceUsd: asNum(best?.priceUsd),
    priceNative: asNum(best?.priceNative),
    change5m: asNum(best?.priceChange?.m5),
    change1h: asNum(best?.priceChange?.h1),
    change6h: asNum(best?.priceChange?.h6),
    change24h: asNum(best?.priceChange?.h24),
    liquidityUsd: asNum(best?.liquidity?.usd),
    liquidityBase: asNum(best?.liquidity?.base),
    liquidityQuote: asNum(best?.liquidity?.quote),
    fdv: asNum(best?.fdv ?? best?.marketCap),
    marketCap: asNum(best?.marketCap ?? best?.fdv),
    boostsActive: best?.boosts?.active ?? 0,

    v5mTotal: v("m5"),
    v1hTotal: v("h1"),
    v6hTotal: v("h6"),
    v24hTotal: v("h24"),
    tx5m: tx("m5"),
    tx1h: tx("h1"),
    tx6h: tx("h6"),
    tx24h: tx("h24"),
    ageMs: Number.isFinite(earliest) ? (Date.now() - earliest) : null,

    headlineDex: best?.dexId,
    headlineUrl: best?.url,

    websites: info.websites || [],
    socials: info.socials || [],

    pairs: list.map(p => ({
      dexId: p.dexId,
      url: p.url,
      priceUsd: asNum(p.priceUsd),
      priceNative: asNum(p.priceNative),
      change5m: asNum(p?.priceChange?.m5),
      change1h: asNum(p?.priceChange?.h1),
      change6h: asNum(p?.priceChange?.h6),
      change24h: asNum(p?.priceChange?.h24),
      v24h: asNum(p?.volume?.h24),
      liquidityUsd: asNum(p?.liquidity?.usd),
      pairCreatedAt: p?.pairCreatedAt,
    })),
  };

  model.liqToFdvPct = (Number.isFinite(model.liquidityUsd) && Number.isFinite(model.fdv) && model.fdv > 0)
    ? (model.liquidityUsd / model.fdv) * 100 : null;

  model.volToLiq24h = (Number.isFinite(model.v24hTotal) && Number.isFinite(model.liquidityUsd) && model.liquidityUsd > 0)
    ? (model.v24hTotal / model.liquidityUsd) : null;

  model.buySell24h = (model.tx24h.buys + model.tx24h.sells) > 0
    ? model.tx24h.buys / (model.tx24h.buys + model.tx24h.sells) : null;

  return model;
}