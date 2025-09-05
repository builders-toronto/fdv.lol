import { ts, MEME_KEYWORDS } from '../config/env.js';
import {
  streamFeeds,           
  fetchTokenInfoMulti,    
} from '../data/feeds.js';
import { fetchTrending } from '../data/solana.js';
import { scoreAndRecommend } from '../core/calculate.js';
import { elRelax, elMeta, elMetaBase, elTimeDerived } from '../views/meme/page.js';
import { readCache, writeCache } from '../utils/tools.js';
import { enrichMissingInfo } from '../data/normalize.js';
import { loadAds, pickAd } from '../ads/load.js';

//TODO: it takes a minute to load because I dont have the time to fix this right meow

const num = (x, d = 0) => {
  const n = Number(x);
  return Number.isFinite(n) ? n : d;
};
const clamp0 = (x) => (Number.isFinite(x) && x > 0 ? x : 0);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

let _rafPending = false;
function rafFlush(fn) {
  if (_rafPending) return;
  _rafPending = true;
  requestAnimationFrame(() => { _rafPending = false; fn(); });
}

// Always push a **sorted** array to the DOM.
function sortedGrid({ useScore = false, store }) {
  const arr = store.toArray();
  const byScore = (a, b) => (b.score || 0) - (a.score || 0);
  const byFast  = (a, b) => fastScore(b) - fastScore(a);
  const byArr   = (a, b) => (b._arrivedAt || 0) - (a._arrivedAt || 0);
  const byMint  = (a, b) => String(a.mint).localeCompare(String(b.mint));
  arr.sort((a, b) => (useScore ? byScore(a, b) : byFast(a, b)) || byArr(a, b) || byMint(a, b));
  return arr;
}

class MarqueeStore {
  constructor({ maxPerBucket = 64 } = {}) {
    this.trending = [];
    this.new = [];
    this._seen = new Set(); // mint set across both buckets
    this.max = maxPerBucket;
  }
  _push(bucket, item) {
    if (!item?.mint) return false;
    if (this._seen.has(item.mint)) return false;
    const arr = bucket === 'trending' ? this.trending : this.new;
    arr.unshift(item); 
    this._seen.add(item.mint);
    if (arr.length > this.max) {
      const removed = arr.splice(this.max);
      for (const r of removed) this._seen.delete(r.mint);
    }
    return true;
  }
  addTrendingFromGrid(rows = []) {
    let changed = false;
    for (const r of rows) {
      changed = this._push('trending', {
        mint: String(r.mint),
        symbol: String(r.symbol || ''),
        name: String(r.name || ''),
        logoURI: String(r.logoURI || r.imageUrl || ''),
        priceUsd: r.priceUsd == null ? null : num(r.priceUsd, null),
        tag: 'Trending',
      }) || changed;
    }
    return changed;
  }
  // TODO: adjust by timestamp
  addNewFromGrid(rows = []) {
    let changed = false;
    for (const r of rows) {
      changed = this._push('new', {
        mint: String(r.mint),
        symbol: String(r.symbol || ''),
        name: String(r.name || ''),
        logoURI: String(r.logoURI || r.imageUrl || ''),
        priceUsd: r.priceUsd == null ? null : num(r.priceUsd, null),
        tag: 'New',
      }) || changed;
    }
    return changed;
  }
  payload() {
    return {
      trending: this.trending.slice(0, this.max),
      new: this.new.slice(0, this.max),
    };
  }
}

class TokenStore {
  constructor() {
    this.byMint = new Map();          
    this.sources = new Map();        
  }
  size() { return this.byMint.size; }

  _ensure(mint) {
    let t = this.byMint.get(mint);
    if (!t) {
      t = {
        // identity
        mint, symbol: '', name: '', logoURI: '',
        // price/liquidity/cap
        priceUsd: null, priceNative: null,
        liquidityUsd: null, liquidityBase: null, liquidityQuote: null,
        fdv: null, marketCap: null,
        // change / volume / txns (UI shapes)
        change: { m5: 0, h1: 0, h6: 0, h24: 0 },
        volume: { h24: 0 },
        txns:   { m5: 0, h1: 0, h6: 0, h24: 0 },
        // routing
        dex: '', pairUrl: '',
        website: null, socials: [],
        // extras
        boostsActive: 0,
        ageMs: null,
        pairs: [],
        decimals: null, supply: null,
        // derived
        liqToFdvPct: null, volToLiq24h: null, buySell24h: null,
        // ui helpers
        _chg: [0,0,0,0],
        _norm: { nAct: 0, nLiq: 0, nMom: 0, nVol: 0 },
        // ranking
        score: 0, recommendation: 'MEASURING', why: [],
        // arrival
        _arrivedAt: Date.now(),
      };
      this.byMint.set(mint, t);
      this.sources.set(mint, new Set());
    }
    return t;
  }

  has(mint) { return this.byMint.has(mint); }

  // Merge from search hit
  mergeSearchHit(hit) {
    if (!hit?.mint) return false;
    const t = this._ensure(hit.mint);
    const srcs = this.sources.get(hit.mint);

    // identity
    if (hit.symbol && !t.symbol) t.symbol = hit.symbol;
    if (hit.name && !t.name) t.name = hit.name;
    if (hit.imageUrl && !t.logoURI) t.logoURI = hit.imageUrl;

    // quick numerics (only if missing to avoid flapping)
    if (hit.priceUsd != null && t.priceUsd == null) t.priceUsd = num(hit.priceUsd, null);
    if (hit.bestLiq  != null && t.liquidityUsd == null) t.liquidityUsd = num(hit.bestLiq, null);

    // routing hint
    if (hit.dexId && !t.dex) t.dex = String(hit.dexId || '');
    if (hit.url   && !t.pairUrl) t.pairUrl = String(hit.url || '');

    // provenance
    for (const s of (hit.sources || [])) srcs.add(s);

    // helpers
    t._chg = [
      num(t.change.m5, 0),
      num(t.change.h1, 0),
      num(t.change.h6, 0),
      num(t.change.h24,0),
    ];
    return true;
  }

  // Merge from deep DS-shape
  mergeDeepInfo(info) {
    if (!info?.mint) return false;
    const t = this._ensure(info.mint);
    const srcs = this.sources.get(info.mint);

    // identity
    if (info.symbol) t.symbol = info.symbol;
    if (info.name) t.name = info.name;
    if (info.imageUrl) t.logoURI = info.imageUrl;

    // price / liquidity / caps
    if (info.priceUsd    != null) t.priceUsd    = num(info.priceUsd, null);
    if (info.priceNative != null) t.priceNative = num(info.priceNative, null);

    if (info.liquidityUsd   != null) t.liquidityUsd   = num(info.liquidityUsd, null);
    if (info.liquidityBase  != null) t.liquidityBase  = num(info.liquidityBase, null);
    if (info.liquidityQuote != null) t.liquidityQuote = num(info.liquidityQuote, null);

    if (info.fdv       != null) t.fdv = num(info.fdv, null);
    if (info.marketCap != null) t.marketCap = num(info.marketCap, null);

    // change buckets
    const c5  = info.change5m, c1 = info.change1h, c6 = info.change6h, c24 = info.change24h;
    t.change = { m5: num(c5,0), h1: num(c1,0), h6: num(c6,0), h24: num(c24,0) };
    t._chg = [t.change.m5, t.change.h1, t.change.h6, t.change.h24];

    // volumes (UI shape)
    const v24 = num(info.v24hTotal, null);
    if (v24 != null) t.volume.h24 = v24;

    // txns (sum to counts)
    const tx24 = info.tx24h || { buys: 0, sells: 0 };
    const tx6  = info.tx6h  || { buys: 0, sells: 0 };
    const tx1  = info.tx1h  || { buys: 0, sells: 0 };
    const tx5  = info.tx5m  || { buys: 0, sells: 0 };
    t.txns = {
      m5:  (tx5.buys  + tx5.sells)  | 0,
      h1:  (tx1.buys  + tx1.sells)  | 0,
      h6:  (tx6.buys  + tx6.sells)  | 0,
      h24: (tx24.buys + tx24.sells) | 0,
    };

    // routing headline
    if (info.headlineDex) t.dex = info.headlineDex;
    if (info.headlineUrl) t.pairUrl = info.headlineUrl;

    // meta
    if (Array.isArray(info.websites)) t.website = info.websites[0]?.url || info.websites[0] || t.website || null;
    if (Array.isArray(info.socials))  t.socials = info.socials;
    if (Array.isArray(info.pairs))    t.pairs = info.pairs;

    if (info.ageMs          != null) t.ageMs = num(info.ageMs, null);
    if (info.boostsActive   != null) t.boostsActive = num(info.boostsActive, 0);

    // derived
    if (info.liqToFdvPct    != null) t.liqToFdvPct = num(info.liqToFdvPct, null);
    if (info.volToLiq24h    != null) t.volToLiq24h = num(info.volToLiq24h, null);
    if (info.buySell24h     != null) t.buySell24h  = num(info.buySell24h,  null);

    // rpc extras
    if (info.decimals != null) t.decimals = num(info.decimals, null);
    if (info.supply   != null) t.supply   = num(info.supply,   null);

    // provenance
    if (info._source) srcs.add(info._source);

    return true;
  }

  // stable array for scoring/rendering (no NaNs)
  toArray() {
    return [...this.byMint.values()].map(t => ({
      ...t,
      priceUsd:      t.priceUsd == null ? null : num(t.priceUsd, null),
      liquidityUsd:  t.liquidityUsd == null ? null : num(t.liquidityUsd, null),
      fdv:           t.fdv == null ? null : num(t.fdv, null),
      change: {
        m5:  num(t.change.m5,  0),
        h1:  num(t.change.h1,  0),
        h6:  num(t.change.h6,  0),
        h24: num(t.change.h24, 0),
      },
      volume: { h24: num(t.volume.h24, 0) },
      txns:   {
        m5:  clamp0(t.txns.m5),
        h1:  clamp0(t.txns.h1),
        h6:  clamp0(t.txns.h6),
        h24: clamp0(t.txns.h24),
      },
      _chg: [ num(t._chg[0],0), num(t._chg[1],0), num(t._chg[2],0), num(t._chg[3],0) ],
      _norm: t._norm || { nAct: 0, nLiq: 0, nMom: 0, nVol: 0 },
    }));
  }
}

function fastScore(t) {
  let s = 0;
  if (t.liquidityUsd) s += Math.log10(t.liquidityUsd + 10) * 2;
  if (t.volume?.h24)  s += Math.log10(t.volume.h24 + 10);
  s += (t.change?.h1 || 0)  * 0.02;
  s += (t.change?.h24 || 0) * 0.01;
  s += (t.txns?.h24 || 0)   * 0.001;
  return s;
}

let CURRENT_AD = null;
let CURRENT_RUN = null;

export async function pipeline({ force = false, stream = true, timeboxMs = 8_000, onUpdate } = {}) {
  onUpdate = typeof onUpdate === 'function' ? onUpdate : () => {};
  if (CURRENT_RUN?.abort) { try { CURRENT_RUN.abort(); } catch {} }
  const ac = new AbortController();
  CURRENT_RUN = ac;

  const relax = !!elRelax?.checked;

  // Non-stream 
  const cached = !force && readCache();
  if (!stream && cached?.items?.length) {
    elTimeDerived.textContent = `Generated: ${cached.generatedAt}`;
    const byScore = [...cached.items].sort((a,b) => (b.score || 0) - (a.score || 0));
    const marqueeFromCache = {
      trending: byScore.slice(0, 40).map(t => ({
        mint: t.mint, symbol: t.symbol, name: t.name, logoURI: t.logoURI, priceUsd: t.priceUsd, tag: 'Trending'
      })),
      new: [],
    };
    return { items: cached.items, ad: CURRENT_AD, marquee: marqueeFromCache };
  }
  elMetaBase.textContent = `Loading…`;

  // ads 
  const adsPromise = loadAds().catch(() => null).then(ads => {
    if (CURRENT_AD === null) CURRENT_AD = ads ? pickAd(ads) : null;
    return ads;
  });

  // Stores
  const store = new TokenStore();          
  const marquee = new MarqueeStore({ maxPerBucket: 64 }); 

  const FIRST_TARGET = 36;
  const FIRST_TIMEOUT_MS = 260;
  let firstResolved = false;
  let resolveFirst;
  const firstReturn = new Promise(r => (resolveFirst = r));





  let lastScored = null;

  function pushUpdate(items) {
    onUpdate({ items, marquee: marquee.payload(), ad: CURRENT_AD });
  }

  function feedMarqueeFromGrid({ useScore = false, feedNew = true } = {}) {
    const arr = store.toArray();
    const ranked = useScore
      ? [...arr].sort((a,b) => (b.score || 0) - (a.score || 0))
      : [...arr].sort((a,b) => fastScore(b) - fastScore(a));
    const topTrending = ranked.slice(0, 40);
    marquee.addTrendingFromGrid(topTrending);

    if (feedNew) {
      const newest = [...arr]
        .sort((a,b) => (b._arrivedAt || 0) - (a._arrivedAt || 0))
        .slice(0, 40);
      marquee.addNewFromGrid(newest);
    }
  }

  function renderNow() {
    if (firstResolved) return;
    const items = sortedGrid({ useScore: false, store });
    feedMarqueeFromGrid({ useScore: false, feedNew: true });
    pushUpdate(items);
    elMetaBase.textContent = `Scanning… ${store.size()} tokens • Marquee: ${marquee.trending.length + marquee.new.length}`;
  }
  const scheduleRender = () => rafFlush(renderNow);

  let _postFirstPending = false;
  function schedulePostFirstRecompute(run) {
    if (_postFirstPending) return;
    _postFirstPending = true;
    requestAnimationFrame(async () => {
      _postFirstPending = false;
      await run();
    });
  }

  async function resolveFirstNow() {
    if (firstResolved) return;

    let items = sortedGrid({ useScore: false, store });
    const pick = items.slice(0, Math.min(28, items.length));

    try {
      await Promise.all(pick.map(t =>
        fetchTokenInfoMulti(t.mint, { signal: ac.signal })
          .then(info => store.mergeDeepInfo(info))
          .catch(() => {})
      ));
    } catch {}

    items = store.toArray();
    items = await enrichMissingInfo(items);
    let scored = scoreAndRecommend(items);

    scored.sort((a,b) => (b.score || 0) - (a.score || 0) ||
                         (b._arrivedAt || 0) - (a._arrivedAt || 0) ||
                         String(a.mint).localeCompare(String(b.mint)));

    lastScored = scored;
    feedMarqueeFromGrid({ useScore: true, feedNew: true });
    pushUpdate(lastScored);
    elTimeDerived.textContent = `Generated: ${ts()}`;

    firstResolved = true;
    resolveFirst({ items: lastScored, marquee: marquee.payload(), ad: CURRENT_AD });
  }

  setTimeout(() => { if (!firstResolved) resolveFirstNow(); }, FIRST_TIMEOUT_MS);

  fetchTrending().catch(()=>[]).then(list => {
    if (ac.signal.aborted || !list?.length) return;

    let changedGrid = false;
    for (const r of list) changedGrid = store.mergeSearchHit(r) || changedGrid;

    if (!firstResolved) {
      if (changedGrid) {
        scheduleRender();
        feedMarqueeFromGrid({ useScore: false, feedNew: true });
        pushUpdate(sortedGrid({ useScore: false, store }));
      }
      if (store.size() >= FIRST_TARGET) resolveFirstNow();
    } else if (changedGrid) {
      feedMarqueeFromGrid({ useScore: !!lastScored, feedNew: true });
      pushUpdate(lastScored ?? sortedGrid({ useScore: false, store }));
    }
  });

  (async () => {
    let windowOffset = (pipeline._offset || 0) % MEME_KEYWORDS.length;
    pipeline._offset = windowOffset + 40;

    for await (const evt of streamFeeds({
      signal: ac.signal,
      keywords: MEME_KEYWORDS,
      windowSize: 40,
      windowOffset,
      requestBudget: 60,
      maxConcurrent: 2,
      spacingMs: 120,
      limitPerQuery: 8,
      deadlineMs: 850,
      includeGeckoSeeds: false, 
    })) {
      const batch = evt?.newItems || [];
      let changedGrid = false;

      for (const r of batch) changedGrid = store.mergeSearchHit(r) || changedGrid;

      if (!firstResolved) {
        if (changedGrid) {
          scheduleRender();
          feedMarqueeFromGrid({ useScore: false, feedNew: true });
          pushUpdate(sortedGrid({ useScore: false, store }));
        }
        if (store.size() >= FIRST_TARGET) resolveFirstNow();
      } else {
        // small hydration for newcomers; then scored recompute
        schedulePostFirstRecompute(async () => {
          const newcomers = batch.slice(0, 6);
          await Promise.all(newcomers.map(r =>
            fetchTokenInfoMulti(r.mint, { signal: ac.signal })
              .then(info => store.mergeDeepInfo(info))
              .catch(() => {})
          ));

          let items = store.toArray();
          items = await enrichMissingInfo(items);
          let scored = scoreAndRecommend(items);
          scored.sort((a,b) => (b.score || 0) - (a.score || 0) ||
                               (b._arrivedAt || 0) - (a._arrivedAt || 0) ||
                               String(a.mint).localeCompare(String(b.mint)));

          lastScored = scored;
          feedMarqueeFromGrid({ useScore: true, feedNew: true });
          pushUpdate(lastScored);
          elMetaBase.textContent = `Updated: ${store.size()} tokens • Marquee: ${marquee.trending.length + marquee.new.length}`;
        });
      }

      elTimeDerived.textContent =
        `Searching… grid:${store.size()} • marquee:${marquee.trending.length + marquee.new.length} • ${evt.source}${evt.term ? ` • term: ${evt.term}` : ''}`;

      if (ac.signal.aborted) break;
    }
  })();

  let _busy = false;
  const ticker = setInterval(async () => {
    if (_busy || ac.signal.aborted) return;
    _busy = true;
    try {
      let items = store.toArray();
      items.sort((a,b) =>
        (b.liquidityUsd||0) - (a.liquidityUsd||0) ||
        fastScore(b) - fastScore(a)
      );
      const top = items.slice(0, Math.min(32, items.length));
      await Promise.all(top.map(t =>
        fetchTokenInfoMulti(t.mint, { signal: ac.signal })
          .then(info => store.mergeDeepInfo(info))
          .catch(() => {})
      ));

      items = store.toArray();
      items = await enrichMissingInfo(items);
      let scored = scoreAndRecommend(items);
      scored.sort((a,b) => (b.score || 0) - (a.score || 0) ||
                           (b._arrivedAt || 0) - (a._arrivedAt || 0) ||
                           String(a.mint).localeCompare(String(b.mint)));

      lastScored = scored;
      feedMarqueeFromGrid({ useScore: true, feedNew: true });

      const payload = { generatedAt: ts(), items: scored, _ts: Date.now() };
      writeCache(payload);

      pushUpdate(lastScored);
      elMetaBase.textContent = `Generated: ${payload.generatedAt}`;
    } catch {
      // ignore; retry next tick
    } finally {
      _busy = false;
    }
  }, 2000);

  let timebox;
  if (stream && timeboxMs > 0) {
    timebox = sleep(timeboxMs).then(() => ac.abort('timebox'));
  }

  if (CURRENT_AD === null) {
    try { const ads = await adsPromise; CURRENT_AD = ads ? pickAd(ads) : null; } catch {}
  }

  const first = await firstReturn;

  if (timebox) { timebox.catch(()=>{}); }
  ac.signal.addEventListener('abort', () => clearInterval(ticker), { once: true });

  return first;
}

window.addEventListener('unhandledrejection', (e) => {
  console.warn('unhandled rejection in pipeline', e?.reason || e);
});
