import {
  MEME_KEYWORDS         
} from '../config/env.js';
import { getJSON, fetchJsonNoThrow } from '../core/tools.js';
import {
  searchTokensGlobal as dsSearch,
  fetchTokenInfo as dsFetchTokenInfo,
} from './dexscreener.js';

import { geckoSeedTokens } from './gecko.js';

const MINT_SOL  = 'So11111111111111111111111111111111111111112';
const MINT_USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const REQUEST_TIMEOUT = 10_000;

function asNum(x) {
  const n = Number(x);
  return Number.isFinite(n) ? n : null;
}

async function withTimeout(fn, ms = REQUEST_TIMEOUT, linkSignal) {
  const ac = new AbortController();
  const tid = setTimeout(() => ac.abort('timeout'), ms);
  let unlink;
  if (linkSignal) {
    if (linkSignal.aborted) ac.abort('linked-abort');
    else {
      unlink = () => ac.abort('linked-abort');
      linkSignal.addEventListener('abort', unlink, { once: true });
    }
  }
  try {
    return await fn(ac.signal);
  } finally {
    clearTimeout(tid);
    if (unlink) linkSignal.removeEventListener('abort', unlink);
  }
}

function scoreBasic({ symbol, name, mint, bestLiq, priceUsd }, q) {
  const s = (q || '').toLowerCase();
  const sym = (symbol || '').toLowerCase();
  const nam = (name || '').toLowerCase();
  const mnt = (mint || '').toLowerCase();
  let score = 0;
  if (!s) score += 1;
  if (sym === s) score += 100;
  if (nam === s) score += 90;
  if (mnt === s) score += 95;
  if (sym.startsWith(s)) score += 70;
  if (nam.startsWith(s)) score += 60;
  if (sym.includes(s)) score += 30;
  if (nam.includes(s)) score += 25;
  if (mnt.includes(s)) score += 20;
  if (bestLiq) score += Math.min(12, Math.log10(bestLiq + 10) * 4);
  if (asNum(priceUsd)) score += 2;
  return score;
}

function dedupeMerge(existing, incoming) {
  return {
    mint: existing.mint || incoming.mint,
    symbol: existing.symbol || incoming.symbol,
    name: existing.name || incoming.name,
    imageUrl: existing.imageUrl || incoming.imageUrl,

    priceUsd: asNum(existing.priceUsd) ?? asNum(incoming.priceUsd),
    bestLiq:  asNum(existing.bestLiq)  ?? asNum(incoming.bestLiq),
    change24h: asNum(existing.change24h) ?? asNum(incoming.change24h),

    dexId: existing.dexId || incoming.dexId,
    url: existing.url || incoming.url,

    // union of sources
    sources: Array.from(new Set([...(existing.sources || []), ...(incoming.sources || [])])),
  };
}

class HealthMonitor {
  constructor({
    degradeAfter = 3,     
    coolOffMs = 90_000,   
    maxBackoffMs = 2_000, 
    decayMs = 120_000,    
  } = {}) {
    this.state = new Map(); 
    this.degradeAfter = degradeAfter;
    this.coolOffMs = coolOffMs;
    this.maxBackoffMs = maxBackoffMs;
    this.decayMs = decayMs;
  }
  _now() { return Date.now(); }
  _get(name) {
    let s = this.state.get(name);
    if (!s) {
      s = { okCount: 0, failCount: 0, degradedUntil: 0, lastChange: 0 };
      this.state.set(name, s);
    }
    return s;
  }
  _decay(s) {
    if (this.decayMs && this._now() - s.lastChange > this.decayMs) {
      s.failCount = Math.max(0, Math.floor(s.failCount / 2));
      s.okCount = Math.max(0, Math.floor(s.okCount / 2));
      s.lastChange = this._now();
    }
  }
  onSuccess(name) {
    const s = this._get(name);
    this._decay(s);
    s.okCount += 1;
    s.failCount = Math.max(0, s.failCount - 1);
    s.lastChange = this._now();
    if (s.okCount >= 2) s.degradedUntil = 0; 
  }
  onFailure(name) {
    const s = this._get(name);
    this._decay(s);
    s.failCount += 1;
    s.okCount = Math.max(0, s.okCount - 1);
    s.lastChange = this._now();
    if (s.failCount >= this.degradeAfter) {
      s.degradedUntil = this._now() + this.coolOffMs;
    }
  }
  isDegraded(name) {
    const s = this._get(name);
    return this._now() < s.degradedUntil;
  }
  extraDelay(name) {
    const s = this._get(name);
    if (!this.isDegraded(name)) return 0;
    const over = Math.max(0, s.failCount - this.degradeAfter + 1);
    const step = Math.min(this.maxBackoffMs, 300 * over);
    return step;
  }
}

const health = new HealthMonitor({
  degradeAfter: 2,
  coolOffMs: 120_000,
  maxBackoffMs: 2_400,
  decayMs: 180_000,
});


// Dexscreener search 
async function provDexscreenerSearch(query, { signal, limit = 12 } = {}) {
  const name = 'dexscreener';
  try {
    const out = await withTimeout(sig => dsSearch(query, { signal: sig, limit }), 8_000, signal);
    health.onSuccess(name);
    return out;
  } catch {
    health.onFailure(name);
    return [];
  }
}

let _geckoFailUntil = 0;

const GECKO_COOLDOWN_MS = 5 * 60_000;


function geckoInCooldown() {
  return Date.now() < _geckoFailUntil || health.isDegraded('geckoterminal');
}
function geckoMarkFail() {
  _geckoFailUntil = Date.now() + GECKO_COOLDOWN_MS;
}


function providerEntry(name, fn, baseDelay) {
  return {
    name,
    delayMs: baseDelay + health.extraDelay(name), // health-aware stagger
    fn: async (query, { signal, limit }) => fn(query, { signal, limit }),
  };
}

function buildSearchProviders(stagger = []) {
  const list = [];
  // if (BIRDEYE_API_KEY) list.push(providerEntry('birdeye', provBirdeyeSearch, stagger[1] ?? 150));
  list.push(providerEntry('dexscreener', provDexscreenerSearch, stagger[0] ?? 0));
  //list.push(providerEntry('jupiter',     provJupiterListSearch, stagger[2] ?? 280));
  // list.push(providerEntry('solana-rpc',  provSolanaRPCSearch,   stagger[3] ?? 0));
  return list;
}

async function collectProviders({ providers, query, limit = 12, deadlineMs = 800, signal }) {
  const start = Date.now();
  const seen = new Map();

  const add = (arr, src) => {
    for (const r of arr || []) {
      if (!r?.mint) continue;
      if (seen.size >= limit && seen.has(r.mint) === false) continue;
      const base = {
        mint: r.mint,
        symbol: r.symbol || '',
        name: r.name || '',
        imageUrl: r.imageUrl || '',
        priceUsd: asNum(r.priceUsd),
        bestLiq: asNum(r.bestLiq),
        dexId: r.dexId || '',
        url: r.url || '',
        sources: Array.from(new Set(['multi', ...(r.sources || []), src])),
      };
      const prev = seen.get(r.mint);
      seen.set(r.mint, prev ? dedupeMerge(prev, base) : base);
    }
  };

  const inFlight = new Set();
  for (const p of providers) {
    const task = (async () => {
      if (p.delayMs) await sleep(p.delayMs);
      if (signal?.aborted) return null;
      const out = await p.fn(query, { signal, limit }).catch(() => []);
      add(out, p.name);
      return p.name;
    })().finally(() => inFlight.delete(task));
    inFlight.add(task);
  }

  while (Date.now() - start < deadlineMs && seen.size < limit && inFlight.size) {
    await Promise.race(inFlight);
  }

  for (const pending of inFlight) pending.catch(() => null); // drain quietly

  const results = [...seen.values()];
  results.forEach(r => r._score = scoreBasic(r, query));
  results.sort((a, b) => b._score - a._score);
  return results.slice(0, limit);
}


function makeDexInfoSkeleton(mint) {
  return {
    mint,
    symbol: "",
    name: "",
    imageUrl: undefined,
    headerUrl: undefined,

    priceUsd: null,
    priceNative: null,

    change5m: null,
    change1h: null,
    change6h: null,
    change24h: null,

    liquidityUsd: null,
    liquidityBase: null,
    liquidityQuote: null,

    fdv: null,
    marketCap: null,
    boostsActive: 0,

    v5mTotal: null,
    v1hTotal: null,
    v6hTotal: null,
    v24hTotal: null,

    tx5m: { buys: 0, sells: 0 },
    tx1h: { buys: 0, sells: 0 },
    tx6h: { buys: 0, sells: 0 },
    tx24h: { buys: 0, sells: 0 },

    ageMs: null,

    headlineDex: "",
    headlineUrl: "",

    websites: [],
    socials: [],

    pairs: [],

    liqToFdvPct: null,
    volToLiq24h: null,
    buySell24h: null,
  };
}

function finalizeDexInfo(model) {
  const m = { ...model };

  // liqToFdvPct
  if (Number.isFinite(m.liquidityUsd) && Number.isFinite(m.fdv) && m.fdv > 0) {
    m.liqToFdvPct = (m.liquidityUsd / m.fdv) * 100;
  } else {
    m.liqToFdvPct = null;
  }

  if (Number.isFinite(m.v24hTotal) && Number.isFinite(m.liquidityUsd) && m.liquidityUsd > 0) {
    m.volToLiq24h = m.v24hTotal / m.liquidityUsd;
  } else {
    m.volToLiq24h = null;
  }

  const buys = m?.tx24h?.buys ?? 0;
  const sells = m?.tx24h?.sells ?? 0;
  const tot = buys + sells;
  m.buySell24h = tot > 0 ? (buys / tot) : null;

  return m;
}


export async function searchTokensGlobalMulti(query, {
  signal,
  limit = 12,
  deadlineMs = 850,           
  stagger = [0, 150, 280, 0],  
} = {}) {
  const providers = buildSearchProviders(stagger);
  return await collectProviders({ providers, query, limit, deadlineMs, signal });
}

export async function fetchTokenInfoMulti(mint, { signal } = {}) {
  try {
    const ds = await withTimeout(sig => dsFetchTokenInfo(mint, { signal: sig }), 9_000, signal);
    if (ds && ds.mint) { health.onSuccess('dexscreener'); return { ...ds, _source: 'dexscreener' }; }
  } catch { health.onFailure('dexscreener'); }


    if (!geckoInCooldown()) {
      try {
        const url = `https://api.geckoterminal.com/api/v2/networks/solana/tokens/${encodeURIComponent(mint)}`;
        const json = await withTimeout(sig => getJSON(url, {
          signal: sig, timeout: 9000, ttl: 45_000, tag: 'gecko'
        }), 10_000, signal);
        const a = json?.data?.attributes || {};
        // ...existing mapping...
        const base = makeDexInfoSkeleton(mint);
        base.symbol = a?.symbol || "";
        base.name   = a?.name   || "";
        base.imageUrl = a?.image_url || undefined;
        base.priceUsd   = asNum(a?.price_usd);
        base.fdv        = asNum(a?.fdv_usd);
        base.headlineDex = 'gecko';
        const model = finalizeDexInfo(base);
        health.onSuccess('geckoterminal');
        return { ...model, _source: 'geckoterminal' };
      } catch {
        geckoMarkFail();
        health.onFailure('geckoterminal');
      }
    }

  throw new Error('No token info available from any provider');
}

export function getFeedHealth() {
  const snap = {};
  for (const [name, s] of health.state.entries()) {
    snap[name] = {
      ok: s.okCount, fail: s.failCount,
      degraded: health.isDegraded(name),
      degradedUntil: s.degradedUntil,
      extraDelayMs: health.extraDelay(name),
      lastChange: s.lastChange,
    };
  }
  return snap;
}

function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = (Math.random() * (i + 1)) | 0;
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

export async function fetchFeeds({
  keywords = MEME_KEYWORDS,
  prefix = 'solana ',
  budget = 120,          
  limitPerQuery = 8,     
  deadlineMs = 850,      
  signal,
  stagger = [0, 150, 280, 0], 
  includeGeckoSeeds = false,   
} = {}) {
  const bag = new Map(); 

  if (includeGeckoSeeds) {
    try {
      const seeds = await geckoSeedTokens({ signal, limitTokens: 120 });
      console.log("geck seeds", seeds);
      for (const r of seeds) {
        const prev = bag.get(r.mint);
        bag.set(r.mint, prev ? dedupeMerge(prev, r) : r);
      }
    } catch {}
  }

  const terms = shuffle(keywords.map(k => `${prefix}${k}`));
  const providers = buildSearchProviders(stagger);

  let spent = 0;
  for (const term of terms) {
    if (signal?.aborted) break;
    if (spent >= budget) break;
    spent += 1;

    try {
      const out = await collectProviders({
        providers, query: term, limit: limitPerQuery, deadlineMs, signal,
      });
      for (const r of out) {
        const prev = bag.get(r.mint);
        bag.set(r.mint, prev ? dedupeMerge(prev, r) : r);
      }
    } catch {
      // ignore per-term errors
    }
  }

  const results = [...bag.values()];
  results.forEach(r => r._score = scoreBasic(r, ''));
  results.sort((a, b) => b._score - a._score);
  return results;
}

export async function* streamFeeds({
  keywords = MEME_KEYWORDS,
  prefix = 'solana ',
  windowSize = 40,
  windowOffset = 0,
  requestBudget = 60,   
  spacingMs = 150,       
  maxConcurrent = 2,      
  limitPerQuery = 8,
  deadlineMs = 850,
  signal,
  stagger = [0, 150, 280, 0],
  includeGeckoSeeds = true,
} = {}) {
  const seen = new Set();


  if (includeGeckoSeeds) {
    try {
      const seeds = await geckoSeedTokens({ signal, limitTokens: 120 });
      const fresh = [];
      for (const r of seeds) {
        if (!r?.mint || seen.has(r.mint)) continue;
        seen.add(r.mint);
        fresh.push(r);
      }
      yield { source: 'gecko-seed', term: '(seed)', newItems: fresh };
    } catch {
      yield { source: 'gecko-seed', term: '(seed)', newItems: [] };
    }
  }
  const raw = keywords.map(k => `${prefix}${k}`);
  const start = windowOffset % raw.length;
  const terms = raw.slice(start, start + windowSize);
  if (terms.length < windowSize) terms.push(...raw.slice(0, windowSize - terms.length));

  const providers = buildSearchProviders(stagger);
  let cursor = 0;
  let budgetLeft = Math.max(1, requestBudget);
  const running = new Set();

  const kick = async (termIdx) => {
    if (termIdx >= terms.length) return null;
    if (budgetLeft <= 0) return null;
    const term = terms[termIdx];
    if (spacingMs && termIdx > 0) await sleep(spacingMs);
    budgetLeft -= 1;

    try {
      const out = await collectProviders({
        providers, query: term, limit: limitPerQuery, deadlineMs, signal,
      });
      const fresh = [];
      for (const r of out) {
        if (!r?.mint || seen.has(r.mint)) continue;
        seen.add(r.mint);
        fresh.push(r);
      }
      return { source: 'multi', term, newItems: fresh };
    } catch {
      return { source: 'multi', term, newItems: [] };
    }
  };

  while ((cursor < terms.length || running.size) && budgetLeft > 0 && !signal?.aborted) {
    while (running.size < Math.min(maxConcurrent, terms.length - cursor) && budgetLeft > 0) {
      const idx = cursor++;
      const p = kick(idx);
      if (!p) break;
      const task = p.then(res => ({ res }))
                   .catch(() => ({ res: null }))
                   .finally(() => running.delete(task));
      running.add(task);
    }

    if (!running.size) break;

    const { res } = await Promise.race([...running]);
    if (!res) continue;
    yield res; 
  }
}

const SOL_CHAIN = 'solana';


async function dsPairsByToken(tokenAddress, { signal } = {}) {
  const url = `https://api.dexscreener.com/token-pairs/v1/${SOL_CHAIN}/${encodeURIComponent(tokenAddress)}`;
  const resp = await withTimeout(sig => fetchJsonNoThrow(url, { signal: sig }), 8_000, signal);
  return Array.isArray(resp?.json) ? resp.json : [];
}

async function dsPairsByTokensBatch(tokenAddressesCsv, { signal } = {}) {
  const url = `https://api.dexscreener.com/tokens/v1/${SOL_CHAIN}/${encodeURIComponent(tokenAddressesCsv)}`;
  const resp = await withTimeout(sig => fetchJsonNoThrow(url, { signal: sig }), 8_000, signal);
  return Array.isArray(resp?.json) ? resp.json : [];
}

async function dsBoostLists({ signal } = {}) {
  const [latest, top] = await Promise.allSettled([
    withTimeout(sig => fetchJsonNoThrow('https://api.dexscreener.com/token-boosts/latest/v1', { signal: sig }), 8_000, signal),
    withTimeout(sig => fetchJsonNoThrow('https://api.dexscreener.com/token-boosts/top/v1',    { signal: sig }), 8_000, signal),
  ]);
  const arr = []
    .concat(latest.status === 'fulfilled' ? (latest.value?.json || []) : [])
    .concat(top.status === 'fulfilled'    ? (top.value?.json    || []) : []);
  return arr.filter(x => (x?.chainId || '').toLowerCase() === SOL_CHAIN);
}

function normalizePairsToHits(pairs, { sourceTag = 'ds-quote', quoteMints = [MINT_USDC, MINT_SOL] } = {}) {
  const Q = new Set(quoteMints);
  const hits = [];

  for (const p of pairs || []) {
    const b = p?.baseToken || {};
    const q = p?.quoteToken || {};
    let mint = b.address, symbol = b.symbol || '', name = b.name || '';
    if (Q.has(b.address)) { mint = q.address; symbol = q.symbol || ''; name = q.name || ''; }
    else if (Q.has(q.address)) { mint = b.address; symbol = b.symbol || ''; name = b.name || ''; }
    if (!mint) continue;

    const v24 = asNum(p?.volume?.h24);
    const buys24 = Number(p?.txns?.h24?.buys);
    const sells24 = Number(p?.txns?.h24?.sells);
    const txns24 = Number.isFinite(buys24) && Number.isFinite(sells24) ? (buys24 + sells24) : null;

    const pc = p?.priceChange || {};
    const chg5  = asNum(pc?.m5);
    const chg1  = asNum(pc?.h1);
    const chg6  = asNum(pc?.h6);
    const chg24 = asNum(pc?.h24);

    hits.push({
      mint,
      symbol,
      name,
      imageUrl: p?.info?.imageUrl || '',
      priceUsd: asNum(p?.priceUsd),
      bestLiq: asNum(p?.liquidity?.usd),
      fdv: asNum(p?.fdv),
      volume24: v24,
      txns24,
      dexId: p?.dexId || '',
      url: p?.url || '',
      chainId: (p?.chainId || '').toLowerCase(),
      pairAddress: p?.pairAddress || '',
      change5m: chg5,
      change1h: chg1,
      change6h: chg6,
      change24h: chg24,
      sources: [sourceTag],
    });
  }
  return hits;
}

export async function collectInstantSolana({
  signal,
  quoteMints = [MINT_USDC, MINT_SOL],
  maxBoostedTokens = 60,
  limit = 220,
} = {}) {
  const bag = new Map();

  try {
    const results = await Promise.allSettled(
      quoteMints.map(q => dsPairsByToken(q, { signal }))
    );
    for (const r of results) {
      const pairs = r.status === 'fulfilled' ? (r.value || []) : [];
      const hits = normalizePairsToHits(pairs, { sourceTag: 'ds-quote', quoteMints });
      for (const h of hits) {
        const prev = bag.get(h.mint);
        bag.set(h.mint, prev ? dedupeMerge(prev, h) : h);
      }
    }
  } catch {
    // why do you love me so much?
  }

  try {
    const boosts = await dsBoostLists({ signal });
    const tokens = Array.from(new Set(boosts.map(b => b.tokenAddress))).slice(0, maxBoostedTokens);

    for (let i = 0; i < tokens.length; i += 30) {
      const chunk = tokens.slice(i, i + 30).join(',');
      try {
        const pairs = await dsPairsByTokensBatch(chunk, { signal });
        const hits = normalizePairsToHits(pairs, { sourceTag: 'ds-boosted', quoteMints });
        for (const h of hits) {
          const prev = bag.get(h.mint);
          bag.set(h.mint, prev ? dedupeMerge(prev, h) : h);
        }
      } catch {
        // continue next chunk
      }
    }
  } catch {
    // why do you love me so much?
  }

  const out = [...bag.values()];
  out.forEach(r => r._score = scoreBasic(r, ''));
  out.sort((a, b) =>
    (asNum(b.bestLiq) || 0) - (asNum(a.bestLiq) || 0) ||
    b._score - a._score ||
    String(a.mint).localeCompare(String(b.mint))
  );

  return out.slice(0, limit);
}

