import { MEME_KEYWORDS } from '../config/env.js'
import { getJSON } from '../utils/tools.js';

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function jitter(ms) { return Math.floor(ms * (0.5 + Math.random())); }

const _cache = new Map();

const MAX_CONCURRENT  = 4;          
const START_SPACING_MS = 200;       
const CACHE_TTL_MS     = 2 * 60_000;
const REQUEST_TIMEOUT  = 10_000;    
const MAX_RETRIES      = 4;        
const BASE_BACKOFF_MS  = 600;       

export async function* streamDexscreener({
  keywords = MEME_KEYWORDS,
  prefix = 'solana ',
  maxConcurrent = MAX_CONCURRENT,
  spacingMs = START_SPACING_MS,
  signal,
  mapResult,
} = {}) {
  const terms = keywords.map(k => `${prefix}${k}`).sort(() => Math.random() - 0.5);
  const seen = new Set(); 

  let cursor = 0;
  let active = 0;

  const step = async () => {
    const myIdx = cursor++;
    if (myIdx >= terms.length) return null; 

    if (spacingMs && myIdx > 0) await sleep(spacingMs);

    const term = terms[myIdx];
    const url = `https://api.dexscreener.com/latest/dex/search?q=${encodeURIComponent(term)}`;

    try {
      const json = await fetchDS(url, { signal });
      const pairs = Array.isArray(json?.pairs) ? json.pairs : [];
      const fresh = [];
      for (const p of pairs) {
        if (p?.chainId !== 'solana') continue;
        const id = p.pairAddress || p.url || `${p.baseToken?.address}:${p.dexId}`;
        if (!id || seen.has(id)) continue;
        seen.add(id);
        fresh.push(mapResult ? mapResult(p) : p);
      }
      return { term, pairs, newPairs: fresh };
    } catch (_) {
      return { term, pairs: [], newPairs: [] };
    }
  };

  const running = new Set();
  while (cursor < terms.length || running.size) {
    while (running.size < Math.min(maxConcurrent, terms.length - cursor)) {
      const p = step();
      if (!p) break;
      const task = p.then(res => ({ res })).catch(err => ({ err })).finally(() => running.delete(task));
      running.add(task);
    }

    if (running.size) {
      const settled = await Promise.race([...running]);
      const { res } = settled;
      if (res) yield res;
    }
  }
}

async function fetchDS(url) {
  const cached = _cache.get(url);
  if (cached && (Date.now() - cached.t) < CACHE_TTL_MS) {
    return cached.data;
  }

  let attempt = 0;
  while (true) {
    attempt++;

    const ac = new AbortController();
    const to = setTimeout(() => ac.abort(new Error('timeout')), REQUEST_TIMEOUT);

    try {
      const data = await getJSON(url, { signal: ac.signal, headers: { accept: 'application/json' } });
      clearTimeout(to);
      _cache.set(url, { t: Date.now(), data });
      return data;
    } catch (err) {
      clearTimeout(to);

      const isAbort = err?.name === 'AbortError' || /timeout/i.test(String(err?.message || ''));

      const status = err?.status ?? (/\b(\d{3})\b/.exec(String(err?.message))?.[1] | 0);

      const retryable = isAbort || status === 429 || (status >= 500 && status < 600);
      if (!retryable || attempt > MAX_RETRIES) {
        throw err;
      }

      let retryAfterMs = 0;
      const retryAfter = err?.headers?.get?.('Retry-After');
      if (retryAfter) {
        const n = Number(retryAfter);
        retryAfterMs = Number.isFinite(n) ? n * 1000 : 0;
      }

      const backoff = retryAfterMs || jitter(BASE_BACKOFF_MS * Math.pow(2, attempt - 1));
      await sleep(backoff);
    }
  }
}

async function mapWithLimit(items, limit, fn, { spacingMs = 0 } = {}) {
  const results = new Array(items.length);
  let i = 0;
  let active = 0;
  let resolveAll;
  const done = new Promise(r => resolveAll = r);

  const next = async () => {
    if (i >= items.length) {
      if (active === 0) resolveAll();
      return;
    }
    const idx = i++; active++;

    if (spacingMs && idx > 0) await sleep(spacingMs);
    try {
      results[idx] = await fn(items[idx], idx);
    } finally {
      active--;
      next();
    }
  };

  const starters = Math.min(limit, items.length);
  for (let k = 0; k < starters; k++) next();
  await done;
  return results;
}

function asNum(x) {
  const n = Number(x);
  return Number.isFinite(n) ? n : null;
}

export async function fetchDexscreener() {
  const terms = MEME_KEYWORDS.map(k => `solana ${k}`)
  .sort(() => Math.random() - 0.5);

  const urls = terms.map(
    t => `https://api.dexscreener.com/latest/dex/search?q=${encodeURIComponent(t)}`
  );

  const results = await mapWithLimit(
    urls,
    MAX_CONCURRENT,
    async (u) => {
      try {
        const json = await fetchDS(u);
        return Array.isArray(json?.pairs) ? json.pairs : [];
      } catch (e) {



        return [];
      }
    },
    { spacingMs: START_SPACING_MS }
  );
  const out = [];
  const seen = new Set();
  for (const arr of results) {
    for (const p of arr) {
      if (p?.chainId !== 'solana') continue;
      const id = p.pairAddress || p.url || `${p.baseToken?.address}:${p.dexId}`;
      if (!id || seen.has(id)) continue;
      seen.add(id);
      out.push(p);
    }
  }
  return out;
}

export async function fetchTokenInfo(mint) {
  const url = `https://api.dexscreener.com/latest/dex/tokens/${encodeURIComponent(mint)}`;

  // use the same robust fetch wrapper
  let json;
  try {
    json = await fetchDS(url);
  } catch (e) {
    if (e?.status === 429) return { error: 'Rate limited.' };
    throw new Error(`dexscreener ${e?.status || e?.message || 'error'}`);
  }

  const pairs = Array.isArray(json?.pairs) ? json.pairs.filter(p => p?.baseToken?.address === mint) : [];
  const list = pairs.length ? pairs : (Array.isArray(json?.pairs) ? json.pairs : []);
  if (!list.length) throw new Error("No pairs");

  const best = list.slice().sort((a,b)=> (a?.liquidity?.usd||0) - (b?.liquidity?.usd||0)).pop();

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
