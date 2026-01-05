import { ts, MEME_KEYWORDS } from '../config/env.js';
import {
  streamFeeds,
  fetchTokenInfoMulti,
  collectInstantSolana,          
  collectNewLaunchSolana,
} from '../data/feeds.js';
import { scoreAndRecommend } from '../core/calculate.js';
import { elMetaBase, elTimeDerived } from '../vista/meme/page.js'; 
import { readCache } from '../core/tools.js';
import { enrichMissingInfo } from '../data/dexscreener.js';
import { loadAds, pickAd } from '../ads/load.js';

let _globalStreamThrottle = { active: false, reason: '', until: 0, created: 0 };
let _globalThrottleTimer = null;

function _isThrottleActive() {
  if (!_globalStreamThrottle.active) return false;
  if (_globalStreamThrottle.until && Date.now() > _globalStreamThrottle.until) {
    _clearThrottleInternal();
    return false;
  }
  return true;
}
function _emitThrottleEvent() {
  try {
    if (typeof window !== 'undefined' && window.dispatchEvent) {
      window.dispatchEvent(new CustomEvent('fdv:stream-throttle', {
        detail: { ..._globalStreamThrottle }
      }));
    }
  } catch {}
}
function _clearThrottleInternal() {
  _globalStreamThrottle = { active: false, reason: '', until: 0, created: 0 };
  if (_globalThrottleTimer) {
    clearTimeout(_globalThrottleTimer);
    _globalThrottleTimer = null;
  }
  _emitThrottleEvent();
}

export function throttleGlobalStream(reason = 'manual', ms = 0) {
  _globalStreamThrottle = {
    active: true,
    reason: String(reason || 'manual'),
    until: ms > 0 ? Date.now() + ms : 0,
    created: Date.now()
  };
  if (_globalThrottleTimer) clearTimeout(_globalThrottleTimer);
  if (ms > 0) {
    _globalThrottleTimer = setTimeout(() => {
      _clearThrottleInternal();
    }, ms + 25);
  }
  try { stopPipelineStream(); } catch {}
  _emitThrottleEvent();
}
export function releaseGlobalStreamThrottle() {
  _clearThrottleInternal();
}
export function getGlobalStreamThrottle() {
  _isThrottleActive(); 
  return { ..._globalStreamThrottle, active: _isThrottleActive() };
}
export function isGlobalStreamThrottled() {
  return _isThrottleActive();
}

export const pauseAllStreams = throttleGlobalStream;
export const resumeAllStreams = releaseGlobalStreamThrottle;

const num = (x, d = 0) => {
  const n = Number(x);
  return Number.isFinite(n) ? n : d;
};
const clamp0 = (x) => (Number.isFinite(x) && x > 0 ? x : 0);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const raf = typeof requestAnimationFrame === 'function' ? requestAnimationFrame : (fn) => setTimeout(fn, 16);
const safeText = (el, s) => { try { if (el) el.textContent = s; } catch {} };

let _rafPending = false;
function rafFlush(fn) {
  if (_rafPending) return;
  _rafPending = true;
  raf(() => { _rafPending = false; fn(); });
}

// Always push a SORTED array to the DOM.
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
    this._rev = 0;
    this._arrayCache = null;
    this._arrayCacheRev = -1;
  }
  size() { return this.byMint.size; }

  _touch() {
    this._rev++;
    this._arrayCacheRev = -1;
  }

  _ensure(mint) {
    let t = this.byMint.get(mint);
    if (!t) {
      t = {
        mint, symbol: '', name: '', logoURI: '',
        priceUsd: null, liquidityUsd: null, fdv: null, marketCap: null,
        pairCreatedAt: null,
        ageMs: null,
        change: { m5: null, h1: null, h6: null, h24: null }, // keep null until known
        volume: { h24: null },
        txns:   { m5: null, h1: null, h6: null, h24: null },
        dex: '', pairUrl: '',
        website: null, socials: [],
        _chg: [0,0,0,0],
        _norm: { nAct: 0, nLiq: 0, nMom: 0, nVol: 0 },
        score: 0, recommendation: 'MEASURING', why: [],
        _arrivedAt: Date.now(),
        _hydrated: false,
      };
      this.byMint.set(mint, t);
      this.sources.set(mint, new Set());
    }
    return t;
  }
  has(mint) { return this.byMint.has(mint); }

  // Merge from search hit
  mergeSearchHit(h) {
    if (!h?.mint) return false;
    const existed = this.byMint.has(h.mint);
    const t = this._ensure(h.mint);
    let changed = false;

    if (!existed) changed = true;

    if (h.symbol && h.symbol !== t.symbol) { t.symbol = h.symbol; changed = true; }
    if (h.name && h.name !== t.name) { t.name = h.name; changed = true; }
    if (h.imageUrl && h.imageUrl !== t.logoURI) {
      t.logoURI = h.imageUrl
      changed = true;
    }

    if (Number.isFinite(+h.priceUsd) && +h.priceUsd !== t.priceUsd) { t.priceUsd = +h.priceUsd; changed = true; }
    if (Number.isFinite(+h.bestLiq) && +h.bestLiq !== t.liquidityUsd) { t.liquidityUsd = +h.bestLiq; changed = true; }
    if (Number.isFinite(+h.fdv) && +h.fdv !== t.fdv) { t.fdv = +h.fdv; changed = true; }

    // Core stats
    if (Number.isFinite(+h.volume24) && +h.volume24 !== t.volume?.h24) { t.volume.h24 = +h.volume24; changed = true; }
    if (Number.isFinite(+h.txns24) && +h.txns24 !== t.txns?.h24) { t.txns.h24 = +h.txns24; changed = true; }

    // DEX + pair URL
    if (h.dexId && h.dexId !== t.dex) { t.dex = h.dexId; changed = true; }
    if (h.url && h.url !== t.pairUrl) { t.pairUrl = h.url; changed = true; }

    // Launch age (from pairs): keep the freshest observed pairCreatedAt
    const createdAt = Number(h?.pairCreatedAt);
    if (Number.isFinite(createdAt) && createdAt > 0) {
      if (!Number.isFinite(Number(t.pairCreatedAt)) || createdAt > Number(t.pairCreatedAt)) {
        t.pairCreatedAt = createdAt;
        changed = true;
      }
      const derivedAgeMs = Math.max(0, Date.now() - createdAt);
      if (!Number.isFinite(Number(t.ageMs)) || derivedAgeMs < Number(t.ageMs)) {
        t.ageMs = derivedAgeMs;
        changed = true;
      }
    }

    // Price changes → both object and chips
    const m5  = Number.isFinite(+h.change5m)  ? +h.change5m  : null;
    const h1  = Number.isFinite(+h.change1h)  ? +h.change1h  : null;
    const h6  = Number.isFinite(+h.change6h)  ? +h.change6h  : null;
    const h24 = Number.isFinite(+h.change24h) ? +h.change24h : null;
    if (m5 != null || h1 != null || h6 != null || h24 != null) {
      t.change = {
        m5:  m5  != null ? m5  : t.change.m5,
        h1:  h1  != null ? h1  : t.change.h1,
        h6:  h6  != null ? h6  : t.change.h6,
        h24: h24 != null ? h24 : t.change.h24,
      };
      t._chg = [
        t.change.m5  ?? 0,
        t.change.h1  ?? 0,
        t.change.h6  ?? 0,
        t.change.h24 ?? 0,
      ];
      changed = true;
    }

    // Hydrated when all required stats exist
    if (Number(t.priceUsd) > 0 && Number(t.liquidityUsd) > 0 && Number(t.volume?.h24) > 0 && Number(t.txns?.h24) > 0) {
      t._hydrated = true;
    }

    if (changed) this._touch();
    return changed;
  }

  // Merge from deep DS-shape
  mergeDeepInfo(info) {
    if (!info?.mint) return false;
    const existed = this.byMint.has(info.mint);
    const t = this._ensure(info.mint);
    const srcs = this.sources.get(info.mint);

    let changed = !existed;

    // identity
    if (info.symbol && info.symbol !== t.symbol) { t.symbol = info.symbol; changed = true; }
    if (info.name && info.name !== t.name) { t.name = info.name; changed = true; }
    if (info.imageUrl && info.imageUrl !== t.logoURI) { t.logoURI = info.imageUrl; changed = true; }

    // price / liquidity / caps
    if (info.priceUsd != null) {
      const v = num(info.priceUsd, null);
      if (v !== t.priceUsd) { t.priceUsd = v; changed = true; }
    }
    if (info.priceNative != null) {
      const v = num(info.priceNative, null);
      if (v !== t.priceNative) { t.priceNative = v; changed = true; }
    }

    if (info.liquidityUsd != null) {
      const v = num(info.liquidityUsd, null);
      if (v !== t.liquidityUsd) { t.liquidityUsd = v; changed = true; }
    }
    if (info.liquidityBase != null) {
      const v = num(info.liquidityBase, null);
      if (v !== t.liquidityBase) { t.liquidityBase = v; changed = true; }
    }
    if (info.liquidityQuote != null) {
      const v = num(info.liquidityQuote, null);
      if (v !== t.liquidityQuote) { t.liquidityQuote = v; changed = true; }
    }

    if (info.fdv != null) {
      const v = num(info.fdv, null);
      if (v !== t.fdv) { t.fdv = v; changed = true; }
    }
    if (info.marketCap != null) {
      const v = num(info.marketCap, null);
      if (v !== t.marketCap) { t.marketCap = v; changed = true; }
    }

    // change buckets
    const c5  = info.change5m, c1 = info.change1h, c6 = info.change6h, c24 = info.change24h;
    {
      const next = { m5: num(c5,0), h1: num(c1,0), h6: num(c6,0), h24: num(c24,0) };
      if (
        next.m5 !== t.change?.m5 ||
        next.h1 !== t.change?.h1 ||
        next.h6 !== t.change?.h6 ||
        next.h24 !== t.change?.h24
      ) {
        t.change = next;
        t._chg = [t.change.m5, t.change.h1, t.change.h6, t.change.h24];
        changed = true;
      }
    }

    // volumes (UI shape)
    const v24 = num(info.v24hTotal, null);
    if (v24 != null && v24 !== t.volume?.h24) { t.volume.h24 = v24; changed = true; }

    // txns (sum to counts)
    const tx24 = info.tx24h || { buys: null, sells: null };
    const tx6  = info.tx6h  || { buys: null, sells: null };
    const tx1  = info.tx1h  || { buys: null, sells: null };
    const tx5  = info.tx5m  || { buys: null, sells: null };
    const nextTxns = {
      m5:  tx5.buys  == null || tx5.sells  == null ? null : (tx5.buys  + tx5.sells)  | 0,
      h1:  tx1.buys  == null || tx1.sells  == null ? null : (tx1.buys  + tx1.sells)  | 0,
      h6:  tx6.buys  == null || tx6.sells  == null ? null : (tx6.buys  + tx6.sells)  | 0,
      h24: tx24.buys == null || tx24.sells == null ? null : (tx24.buys + tx24.sells) | 0,
    };
    if (
      nextTxns.m5 !== t.txns?.m5 ||
      nextTxns.h1 !== t.txns?.h1 ||
      nextTxns.h6 !== t.txns?.h6 ||
      nextTxns.h24 !== t.txns?.h24
    ) {
      t.txns = nextTxns;
      changed = true;
    }

    // routing headline
    if (info.headlineDex && info.headlineDex !== t.dex) { t.dex = info.headlineDex; changed = true; }
    if (info.headlineUrl && info.headlineUrl !== t.pairUrl) { t.pairUrl = info.headlineUrl; changed = true; }

    // meta
    if (Array.isArray(info.websites)) {
      const v = info.websites[0]?.url || info.websites[0] || t.website || null;
      if (v !== t.website) { t.website = v; changed = true; }
    }
    if (Array.isArray(info.socials)) {
      const next = info.socials;
      const prev = t.socials;
      if (prev !== next && JSON.stringify(prev || []) !== JSON.stringify(next || [])) {
        t.socials = next;
        changed = true;
      }
    }
    if (Array.isArray(info.pairs) && t.pairs !== info.pairs) { t.pairs = info.pairs; changed = true; }

    if (info.pairCreatedAt != null) {
      const v = num(info.pairCreatedAt, null);
      if (v !== t.pairCreatedAt) { t.pairCreatedAt = v; changed = true; }
    }
    if (info.ageMs != null) {
      const v = num(info.ageMs, null);
      if (v !== t.ageMs) { t.ageMs = v; changed = true; }
    }
    if (info.boostsActive != null) {
      const v = num(info.boostsActive, 0);
      if (v !== t.boostsActive) { t.boostsActive = v; changed = true; }
    }

    // derived
    if (info.liqToFdvPct != null) {
      const v = num(info.liqToFdvPct, null);
      if (v !== t.liqToFdvPct) { t.liqToFdvPct = v; changed = true; }
    }
    if (info.volToLiq24h != null) {
      const v = num(info.volToLiq24h, null);
      if (v !== t.volToLiq24h) { t.volToLiq24h = v; changed = true; }
    }
    if (info.buySell24h != null) {
      const v = num(info.buySell24h, null);
      if (v !== t.buySell24h) { t.buySell24h = v; changed = true; }
    }

    // rpc extras
    if (info.decimals != null) {
      const v = num(info.decimals, null);
      if (v !== t.decimals) { t.decimals = v; changed = true; }
    }
    if (info.supply != null) {
      const v = num(info.supply, null);
      if (v !== t.supply) { t.supply = v; changed = true; }
    }

    // provenance
    if (info._source) srcs.add(info._source);

    const coreReady =
      Number.isFinite(num(t.priceUsd, NaN)) &&
      Number.isFinite(num(t.liquidityUsd, NaN)) &&
      Number.isFinite(num(t.volume.h24, NaN)) &&
      Number.isFinite(num(t.txns.h24, NaN));
    if (coreReady) t._hydrated = true;

    if (changed) this._touch();

    return true;
  }


  toArray() {
    if (this._arrayCache && this._arrayCacheRev === this._rev) return this._arrayCache;
    const arr = [...this.byMint.values()].map(t => ({
      ...t,
      priceUsd:      t.priceUsd == null ? null : num(t.priceUsd, null),
      liquidityUsd:  t.liquidityUsd == null ? null : num(t.liquidityUsd, null),
      fdv:           t.fdv == null ? null : num(t.fdv, null),
      change: {
        m5:  t.change.m5  == null ? null : num(t.change.m5,  null),
        h1:  t.change.h1  == null ? null : num(t.change.h1,  null),
        h6:  t.change.h6  == null ? null : num(t.change.h6,  null),
        h24: t.change.h24 == null ? null : num(t.change.h24, null),
      },
      volume: { h24: t.volume.h24 == null ? null : num(t.volume.h24, null) },
      txns:   {
        m5:  t.txns.m5  == null ? null : clamp0(t.txns.m5),
        h1:  t.txns.h1  == null ? null : clamp0(t.txns.h1),
        h6:  t.txns.h6  == null ? null : clamp0(t.txns.h6),
        h24: t.txns.h24 == null ? null : clamp0(t.txns.h24),
      },
      _chg: [ num(t._chg[0],0), num(t._chg[1],0), num(t._chg[2],0), num(t._chg[3],0) ],
      _norm: t._norm || { nAct: 0, nLiq: 0, nMom: 0, nVol: 0 },
    }));
    this._arrayCache = arr;
    this._arrayCacheRev = this._rev;
    return arr;
  }


  prune({ max = 1800, keep = 1200, maxAgeMs = 6 * 60 * 60 * 1000 } = {}) {
    try {
      const nowTs = Date.now();
      const size = this.byMint.size;
      if (size <= max) return false;

      const rows = [...this.byMint.values()].map(t => {
        const arrived = Number(t._arrivedAt || nowTs);
        const ageMs = nowTs - arrived;
        return { t, mint: t.mint, ageMs, arrived };
      });

      rows.sort((a, b) => {
        const fsDiff = fastScore(b.t) - fastScore(a.t);
        if (fsDiff !== 0) return fsDiff;
        return (b.arrived || 0) - (a.arrived || 0);
      });

      const keepSet = new Set(rows.slice(0, keep).map(r => r.mint));

      let pruned = 0;
      for (const r of rows.slice(keep)) {
        const tooOld = r.ageMs > maxAgeMs;
        if (!keepSet.has(r.mint) || tooOld) {
          this.byMint.delete(r.mint);
          this.sources.delete(r.mint);
          pruned++;
        }
      }
      if (pruned > 0) {
        this._touch();
        try { safeText(elMetaBase, `Pruned ${pruned} tokens • store=${this.byMint.size}`); } catch {}
      }
      return pruned > 0;
    } catch {
      return false;
    }
  }
}


function hasRequiredStats(t) {
  return t?._hydrated === true &&
         Number(t.priceUsd) > 0 &&
         Number(t.liquidityUsd) > 0 &&
         Number(t.volume?.h24) > 0 &&
         Number(t.txns?.h24) > 0;
}

function isMeasured(t) {
  return hasRequiredStats(t) && Number.isFinite(t?.score);
}
function filterMeasured(arr = []) {
  if (!Array.isArray(arr)) return [];
  return arr.filter(isMeasured);
}

function pushUpdate(items) {
  const measured = filterMeasured(items);
  if (!measured.length) return;
  lastEmitted = measured; // remember last good payload
  try {
    onUpdate({ items: measured, ad: CURRENT_AD, marquee: marquee.payload() });
  } catch {}
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
let CURRENT_RUN = null; // track the active run

export async function pipeline({ force = false, stream = true, timeboxMs = 8_000, onUpdate } = {}) {
  onUpdate = typeof onUpdate === 'function' ? onUpdate : () => {};

  if (_isThrottleActive()) {
    stream = false;
  }

  if (CURRENT_RUN?.abort) { try { CURRENT_RUN.abort(); } catch {} }

  const ac = new AbortController();
  CURRENT_RUN = ac;

  // Utilities to auto-clean timers on abort
  const cleaners = new Set();
  const onAbort = (fn) => cleaners.add(fn);
  ac.signal.addEventListener('abort', () => {
    for (const fn of cleaners) { try { fn(); } catch {} }
    cleaners.clear();
  });

  // Activity watchdog
  const WATCHDOG_MS = 45_000;
  let lastActivityTs = Date.now();
  const touch = () => { lastActivityTs = Date.now(); };

  const watchdog = setInterval(() => {
    const idle = Date.now() - lastActivityTs;
    if (!ac.signal.aborted && idle > WATCHDOG_MS) {
      console.warn(`[fdv] pipeline watchdog: idle ${Math.round(idle/1000)}s — restarting stream`);
      try { restartStreamLoop(); } catch {}
      touch();
    }
  }, Math.floor(WATCHDOG_MS / 2));
  onAbort(() => clearInterval(watchdog));

  // ads
  const adsPromise = loadAds().catch(() => null).then(ads => {
    if (CURRENT_AD === null) CURRENT_AD = ads ? pickAd(ads) : null;
    return ads;
  });

  // Stores
  const store = new TokenStore();
  const marquee = new MarqueeStore({ maxPerBucket: 64 });

  // Throttle for "new launches" pulls (pairs-by-quote can be large; keep light)
  let _lastNewLaunchFetchTs = 0;
  const shouldFetchNewLaunches = (minEveryMs = 45_000) => {
    const nowTs = Date.now();
    if ((nowTs - _lastNewLaunchFetchTs) < minEveryMs) return false;
    _lastNewLaunchFetchTs = nowTs;
    return true;
  };

  // Periodic pruning
  const pruneTimer = setInterval(() => {
    try { store.prune({ max: 1800, keep: 1200, maxAgeMs: 6 * 60 * 60 * 1000 }); } catch {}
  }, 60_000);
  onAbort(() => clearInterval(pruneTimer));

  let lastEmitted = null;

  const pushUpdate = (items) => {
    if (ac.signal.aborted) return;
    const measured = filterMeasured(items);
    if (!measured.length) return;
    touch();
    try { onUpdate({ items: measured, ad: CURRENT_AD, marquee: marquee.payload() }); } catch {}
  };

  // Keep scoring/payload bounded for speed.
  const SCORE_POOL_MAX = 600;
  const ENRICH_TOP_N = 220;
  const MIN_RECOMPUTE_MS = 2500;
  let _lastRecomputeTs = 0;
  let _recomputeTimer = null;

  function pickScorePool(eligible = []) {
    if (eligible.length <= SCORE_POOL_MAX) return eligible;

    const byFast = eligible.slice().sort((a, b) => fastScore(b) - fastScore(a));
    const topFast = byFast.slice(0, Math.max(1, SCORE_POOL_MAX - 120));

    const byAge = eligible.slice().sort((a, b) => {
      const aa = a.ageMs ?? (Date.now() - (a._arrivedAt || 0));
      const bb = b.ageMs ?? (Date.now() - (b._arrivedAt || 0));
      return aa - bb;
    });
    const topNew = byAge.slice(0, 120);

    const out = new Map();
    for (const it of topFast) out.set(it.mint, it);
    for (const it of topNew) {
      if (out.size >= SCORE_POOL_MAX) break;
      out.set(it.mint, it);
    }
    return [...out.values()];
  }

  async function recomputeAndEmit() {
    if (ac.signal.aborted) return;

    const all = store.toArray();
    const eligible = all.filter(hasRequiredStats);
    if (!eligible.length) return;

    const pool = pickScorePool(eligible);
    let scored = scoreAndRecommend(pool);
    scored.sort((a,b) => (b.score || 0) - (a.score || 0) ||
                         (b._arrivedAt || 0) - (a._arrivedAt || 0) ||
                         String(a.mint).localeCompare(String(b.mint)));

    // Enrich only what might actually render.
    try { await enrichMissingInfo(scored.slice(0, ENRICH_TOP_N)); } catch {}

    const measured = filterMeasured(scored);
    if (!measured.length) return;

    lastScored = scored;
    feedMarqueeFromGrid({ useScore: true, feedNew: true });
    pushUpdate(measured);
    safeText(elMetaBase, `Updated`);
    touch();
  }

  function scheduleRecomputeSoon() {
    if (ac.signal.aborted) return;
    if (_recomputeTimer) return;

    const now = Date.now();
    const wait = Math.max(0, (_lastRecomputeTs + MIN_RECOMPUTE_MS) - now);
    const delay = Math.max(80, wait);
    _recomputeTimer = setTimeout(async () => {
      _recomputeTimer = null;
      _lastRecomputeTs = Date.now();
      await recomputeAndEmit();
    }, delay);
    onAbort(() => { try { clearTimeout(_recomputeTimer); } catch {} _recomputeTimer = null; });
  }

  function feedMarqueeFromGrid({ useScore = false, feedNew = false, trendingCount = 40, newCount = 24 } = {}) {
    const grid = sortedGrid({ useScore, store });
    const eligible = grid.filter(hasRequiredStats);
    if (eligible.length) marquee.addTrendingFromGrid(eligible.slice(0, trendingCount));
    if (feedNew) {
      const newest = eligible
        .slice()
        .sort((a, b) => {
          const aa = a.ageMs ?? (Date.now() - (a._arrivedAt || 0));
          const bb = b.ageMs ?? (Date.now() - (b._arrivedAt || 0));
          return aa - bb;
        })
        .slice(0, newCount);
      marquee.addNewFromGrid(newest);
    }
  }

  feedMarqueeFromGrid({ useScore: false, feedNew: true });

  const FIRST_TARGET = 36;
  const FIRST_TIMEOUT_MS = 260;
  let firstResolved = false;
  let resolveFirst;
  const firstReturn = new Promise(r => (resolveFirst = r));

  try {
    const cached = !force && readCache();
    if (cached?.items?.length) {
      const measuredCached = filterMeasured(cached.items);
      if (measuredCached.length) {
        lastEmitted = measuredCached;
        if (CURRENT_AD === null) {
          try { const ads = await loadAds(); CURRENT_AD = ads ? pickAd(ads) : null; } catch {}
        }
        safeText(elTimeDerived, `Generated: ${cached.generatedAt || ts()}`);
        const byScore = [...measuredCached].sort((a,b) => (b.score || 0) - (a.score || 0));
        const marqueeFromCache = {
          trending: byScore.slice(0, 40).map(t => ({
            mint: t.mint, symbol: t.symbol, name: t.name, logoURI: t.logoURI, priceUsd: t.priceUsd, tag: 'Trending'
          })),
          new: [],
        };
        onUpdate({ items: measuredCached, ad: CURRENT_AD, marquee: marqueeFromCache });
        touch();
        if (!firstResolved) {
          firstResolved = true;
          resolveFirst({ items: measuredCached, ad: CURRENT_AD, marquee: marqueeFromCache });
        }
      }
    }
  } catch {}

  (async function primeInstant() {
    try {
      if (ac.signal.aborted) return;

      const [instant, newPairs] = await Promise.all([
        collectInstantSolana({ signal: ac.signal, maxBoostedTokens: 40 }).catch(() => []),
        collectNewLaunchSolana({ signal: ac.signal, maxAgeMs: 2 * 60 * 60 * 1000, minLiqUsd: 800, limit: 120 }).catch(() => []),
      ]);

      const hits = []
        .concat(Array.isArray(instant) ? instant : [])
        .concat(Array.isArray(newPairs) ? newPairs : []);

      if (!hits?.length || ac.signal.aborted) return;

      let changed = false;
      for (const h of hits) changed = store.mergeSearchHit(h) || changed;

      let items = store.toArray().filter(hasRequiredStats);
      if (!items.length) return;

      const pool = pickScorePool(items);
      let scored = scoreAndRecommend(pool);
      scored.sort((a,b) => (b.score || 0) - (a.score || 0) ||
                           (b._arrivedAt || 0) - (a._arrivedAt || 0) ||
                           String(a.mint).localeCompare(String(b.mint)));
      lastScored = scored;

      const measured = filterMeasured(scored);
      if (!measured.length) return;

      marquee.addTrendingFromGrid(measured.slice(0, 40));
      pushUpdate(measured);
      safeText(elMetaBase, `Generating`);
      safeText(elTimeDerived, `Sorting Card Data...`);
      touch();

      if (!firstResolved) {
        firstResolved = true;
        resolveFirst({ items: measured, marquee: marquee.payload(), ad: CURRENT_AD });
      }
    } catch {}
  })();

  let lastScored = null;

  function renderNow() {
    if (firstResolved) return;
    const items = sortedGrid({ useScore: false, store });
    feedMarqueeFromGrid({ useScore: false, feedNew: true });
    safeText(elMetaBase, `Scanning… ${store.size()} tokens • Marquee: ${marquee.trending.length + marquee.new.length}`);
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

    const abortables = [];
    try {
      const p = Promise.all(pick.map(t =>
        fetchTokenInfoMulti(t.mint, { signal: ac.signal })
          .then(info => store.mergeDeepInfo(info))
          .catch(() => {})
      ));
      abortables.push(p);
      await p;
    } catch {}

    await recomputeAndEmit();

    const measured = filterMeasured(lastScored);
    if (measured.length) {
      safeText(elTimeDerived, `Generated`);
      firstResolved = true;
      resolveFirst({ items: measured, marquee: marquee.payload(), ad: CURRENT_AD });
    }
  }

  const tFirst1 = setTimeout(() => { if (!firstResolved) resolveFirstNow(); }, FIRST_TIMEOUT_MS);
  const tFirst2 = setTimeout(() => { if (!firstResolved) resolveFirstNow(); }, FIRST_TIMEOUT_MS * 2);
  const tFirst3 = setTimeout(() => {
    if (!firstResolved && Array.isArray(lastEmitted) && lastEmitted.length) {
      firstResolved = true;
      resolveFirst({ items: lastEmitted, ad: CURRENT_AD, marquee: marquee.payload() });
    }
  }, FIRST_TIMEOUT_MS * 3);
  onAbort(() => { clearTimeout(tFirst1); clearTimeout(tFirst2); clearTimeout(tFirst3); });

  const KW = Array.isArray(MEME_KEYWORDS) && MEME_KEYWORDS.length ? MEME_KEYWORDS : [];
  let windowOffset = 0;
  if (KW.length) {
    windowOffset = (pipeline._offset || 0) % KW.length;
    pipeline._offset = windowOffset + 40;
  }

  let _streamAC = null;
  async function runStreamLoop() {
    let backoff = 800;
    while (!ac.signal.aborted && stream && KW.length) {
      _streamAC = new AbortController();
      onAbort(() => { try { _streamAC.abort(); } catch {} });
      try {
        for await (const evt of streamFeeds({
          signal: _streamAC.signal,
          keywords: KW,
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
            }
            if (store.size() >= FIRST_TARGET) resolveFirstNow();
          } else {
            schedulePostFirstRecompute(async () => {
              const newcomers = batch.slice(0, 4);
              await Promise.all(newcomers.map(r =>
                fetchTokenInfoMulti(r.mint, { signal: ac.signal })
                  .then(info => store.mergeDeepInfo(info))
                  .catch(() => {})
              ));

              // Avoid full-store recompute per batch; debounce instead.
              scheduleRecomputeSoon();
              safeText(elMetaBase, `Queued update… ${store.size()} tokens`);
            });
          }

          safeText(
            elTimeDerived,
            `Searching… grid:${store.size()} • marquee:${marquee.trending.length + marquee.new.length} • ${evt.source}${evt.term ? ` • term: ${evt.term}` : ''}`
          );

          touch();
          if (ac.signal.aborted) break;
        }
        backoff = Math.min(10_000, Math.floor(backoff * 1.5));
      } catch (e) {
        console.warn('[fdv] stream loop error, will retry:', e?.message || e);
        backoff = Math.min(15_000, Math.floor(backoff * 1.7));
      }

      if (ac.signal.aborted) break;
      await sleep(backoff);
    }
  }

  function restartStreamLoop() {
    try { _streamAC?.abort(); } catch {}
    setTimeout(() => { if (!ac.signal.aborted) runStreamLoop(); }, 250);
  }

  if (stream && KW.length) {
    runStreamLoop();
  }

  let _busy = false;
  let ticker;
  if (stream) {
    ticker = setInterval(async () => {
      if (_busy || ac.signal.aborted) return;
      _busy = true;
      try {
        // Opportunistically pull very recent launches so the grid doesn't miss them.
        if (shouldFetchNewLaunches(45_000)) {
          try {
            const launches = await collectNewLaunchSolana({ signal: ac.signal, maxAgeMs: 90 * 60 * 1000, minLiqUsd: 1000, limit: 90 });
            let changed = false;
            for (const h of launches || []) changed = store.mergeSearchHit(h) || changed;
            if (changed) {
              const items = store.toArray();
              feedMarqueeFromGrid({ useScore: true, feedNew: true });
              pushUpdate(items);
              touch();
            }
          } catch {}
        }

        let items = store.toArray();
        items.sort((a,b) =>
          (b.liquidityUsd||0) - (a.liquidityUsd||0) ||
          fastScore(b) - fastScore(a)
        );
        const top = items.slice(0, Math.min(28, items.length));
        await Promise.all(top.map(t =>
           fetchTokenInfoMulti(t.mint, { signal: ac.signal })
             .then(info => store.mergeDeepInfo(info))
             .catch(() => {})
        ));

        await recomputeAndEmit();
      } catch {}
      _busy = false;
    }, 8_000);
    onAbort(() => clearInterval(ticker));
  }

  return firstReturn;
}

// BLOAT: add hooks and refactor to scale this properly
export function stopPipelineStream() {
  if (CURRENT_RUN?.abort) { try { CURRENT_RUN.abort(); } catch {} }
}
