import { MEME_KEYWORDS } from '../config/env.js'
import { getJSON } from '../utils/tools.js';
import { swrFetch } from '../engine/fetcher.js';

// TODO: be nicer to dexscreener

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function jitter(ms) { return Math.floor(ms * (0.5 + Math.random())); }

const MAX_CONCURRENT   = 4;
const START_SPACING_MS = 200;
const REQUEST_TIMEOUT  = 10_000;
const MAX_RETRIES      = 4;
const BASE_BACKOFF_MS  = 600;

const FETCH_TTL_MS_SEARCH = 2 * 60_000;  
const FETCH_TTL_MS_TOKEN  = 10 * 60_000;  

const CACHE_VERSION = 'v1';

class RateLimiter {
  constructor({ rps = 0.8, burst = 3, minRps = 0.2, maxRps = 1.5 } = {}) {
    this.capacity = burst;
    this.tokens = burst;
    this.rps = rps;
    this.minRps = minRps;
    this.maxRps = maxRps;
    this.lastRefill = Date.now();
    this.cooldownUntil = 0;
  }
  _refill() {
    const now = Date.now();
    const elapsed = (now - this.lastRefill) / 1000;
    this.lastRefill = now;
    this.tokens = Math.min(this.capacity, this.tokens + elapsed * this.rps);
  }
  async removeToken() {
    while (true) {
      this._refill();
      const now = Date.now();
      if (now < this.cooldownUntil) {
        await sleep(this.cooldownUntil - now);
        continue;
      }
      if (this.tokens >= 1) {
        this.tokens -= 1;
        return;
      }
      const waitMs = Math.max(5, (1 - this.tokens) / this.rps * 1000);
      await sleep(waitMs);
    }
  }
  on429(retryAfterMs = 0) {
    this.rps = Math.max(this.minRps, this.rps * 0.65);
    this.cooldownUntil = Math.max(this.cooldownUntil, Date.now() + Math.max(800, retryAfterMs));
  }
  onSuccess() {
    this.rps = Math.min(this.maxRps, this.rps * 1.05);
  }
}

const limiter = new RateLimiter({
  rps: 0.8,
  burst: 3,
  minRps: 0.25,
  maxRps: 1.2,
});

async function fetchWithRetries(url, { signal } = {}) {
  let attempt = 0;

  while (true) {
    attempt++;

    await limiter.removeToken();

    const ac = new AbortController();
    const to = setTimeout(() => ac.abort(new Error('timeout')), REQUEST_TIMEOUT);

    const linkAbort = () => ac.abort(signal.reason);
    if (signal) {
      if (signal.aborted) ac.abort(signal.reason);
      else signal.addEventListener('abort', linkAbort, { once: true });
    }

    try {
      const data = await getJSON(url, { signal: ac.signal, headers: { accept: 'application/json' } });
      clearTimeout(to);
      limiter.onSuccess();
      return data;
    } catch (err) {
      clearTimeout(to);

      const isAbort = err?.name === 'AbortError' || /timeout/i.test(String(err?.message || ''));
      const status = err?.status ?? (/\b(\d{3})\b/.exec(String(err?.message))?.[1] | 0);
      const retryable = isAbort || status === 429 || (status >= 500 && status < 600);

      if (!retryable || attempt > MAX_RETRIES) {
        throw err;
      }

      let raMs = 0;
      const retryAfter = err?.headers?.get?.('Retry-After');
      if (retryAfter) {
        const n = Number(retryAfter);
        raMs = Number.isFinite(n) ? n * 1000 : 0;
      }
      limiter.on429(raMs);

      const backoff = raMs || jitter(BASE_BACKOFF_MS * Math.pow(2, attempt - 1));
      await sleep(backoff);
    }
  }
}

async function fetchDS(url, { signal, ttl, priority = false } = {}) {
  const key = `${CACHE_VERSION}|dex:${url}`;
  const fetcher = priority
    ? () => getJSON(url, { signal, headers: { accept: 'application/json' } }) 
    : () => fetchWithRetries(url, { signal });
  return swrFetch(key, fetcher, { ttl });
}

async function mapWithLimit(items, limit, fn, { spacingMs = 0 } = {}) {
  const results = new Array(items.length);
  let i = 0;
  let active = 0;
  let resolveAll;
  const done = new Promise(r => (resolveAll = r));

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

export async function* streamDexscreener({
  keywords = MEME_KEYWORDS,
  prefix = 'solana ',
  maxConcurrent = 2,
  spacingMs = 150,
  windowSize = 40,
  windowOffset = 0,
  requestBudget = 60,
  signal,
  mapResult,
} = {}) {
  const raw = keywords.map(k => `${prefix}${k}`);
  const start = windowOffset % raw.length;
  const terms = raw.slice(start, start + windowSize);
  if (terms.length < windowSize) terms.push(...raw.slice(0, windowSize - terms.length));

  const seen = new Set();
  let budgetLeft = Math.max(1, requestBudget);

  let cursor = 0;
  const running = new Set();

  const step = async () => {
    const myIdx = cursor++;
    if (myIdx >= terms.length) return null;
    if (budgetLeft <= 0) return null;

    if (spacingMs && myIdx > 0) await sleep(spacingMs);

    const term = terms[myIdx];
    const url = `https://api.dexscreener.com/latest/dex/search?q=${encodeURIComponent(term)}`;
    budgetLeft -= 1;

    try {
      const json = await fetchDS(url, { signal, ttl: FETCH_TTL_MS_SEARCH });
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
    } catch {
      return { term, pairs: [], newPairs: [] };
    }
  };

  while ((cursor < terms.length || running.size) && budgetLeft > 0) {
    while (running.size < Math.min(maxConcurrent, terms.length - cursor) && budgetLeft > 0) {
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

export async function fetchDexscreener() {
  const terms = MEME_KEYWORDS
    .map(k => `solana ${k}`)
    .sort(() => Math.random() - 0.5);

  const urls = terms.map(
    t => `https://api.dexscreener.com/latest/dex/search?q=${encodeURIComponent(t)}`
  );

  const results = await mapWithLimit(
    urls,
    MAX_CONCURRENT,
    async (u) => {
      try {
        const json = await fetchDS(u, { ttl: FETCH_TTL_MS_SEARCH });
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

export async function fetchTokenInfo(mint, { priority = false, signal, ttlMs } = {}) {
  const url = `https://api.dexscreener.com/latest/dex/tokens/${encodeURIComponent(mint)}`;
  let json;
  try {
    json = await fetchDS(url, { ttl: (ttlMs ?? FETCH_TTL_MS_TOKEN), priority, signal });
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

// Low-latency fetch for streaming profile updates
export function fetchTokenInfoLive(mint, { signal, ttlMs = 2000 } = {}) {
  return fetchTokenInfo(mint, { priority: true, signal, ttlMs });
}

export async function searchTokensGlobal(query, { signal, limit = 12 } = {}) {
  const q = String(query || '').trim();
  if (!q) return [];

  const url = `https://api.dexscreener.com/latest/dex/search?q=${encodeURIComponent(q)}`;

  let json;
  try {
    json = await fetchDS(url, { signal, ttl: FETCH_TTL_MS_SEARCH });
  } catch (e) {
    if (e?.name === 'AbortError') return [];
    return [];
  }

  const pairs = Array.isArray(json?.pairs) ? json.pairs : [];
  if (!pairs.length) return [];

  const byMint = new Map();
  for (const p of pairs) {
    if (p?.chainId !== 'solana') continue;
    const base = p?.baseToken || {};
    const mint = base.address;
    if (!mint) continue;

    const liq = Number(p?.liquidity?.usd || 0);
    const prev = byMint.get(mint);
    if (!prev || liq > prev.bestLiq) {
      byMint.set(mint, {
        mint,
        symbol: base.symbol || '',
        name: base.name || '',
        bestLiq: liq,
        priceUsd: Number.isFinite(Number(p?.priceUsd)) ? Number(p.priceUsd) : null,
        change24h: Number.isFinite(Number(p?.priceChange?.h24)) ? Number(p.priceChange.h24) : null,
        dexId: p?.dexId || '',
        url: p?.url || '',
        imageUrl: p?.info?.imageUrl,  
      });
    }
  }

  const s = q.toLowerCase();
  const scored = [...byMint.values()].map(t => {
    let score = t.bestLiq ? Math.log10(t.bestLiq + 10) : 0;
    const sym = (t.symbol || '').toLowerCase();
    const nam = (t.name || '').toLowerCase();
    const mnt = (t.mint || '').toLowerCase();

    if (sym === s) score += 20;
    if (nam === s) score += 18;
    if (mnt === s) score += 22;

    if (sym.startsWith(s)) score += 12;
    if (nam.startsWith(s)) score += 10;

    if (sym.includes(s)) score += 6;
    if (nam.includes(s)) score += 4;
    if (mnt.includes(s)) score += 3;

    return { ...t, _score: score };
  });

  scored.sort((a,b) => b._score - a._score);
  return scored.slice(0, limit);
}
