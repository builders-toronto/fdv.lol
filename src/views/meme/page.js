import { MAX_CARDS } from '../../config/env.js';
import { coinCard } from './cards.js';
import { adCard } from '../../ads/load.js';
import { sparklineSVG } from './render/sparkline.js';
import { pctChipsHTML } from './render/chips.js';
import { searchTokensGlobal } from '../../data/dexscreener.js';

export const elCards    = document.getElementById('cards');
export const elMeta     = document.getElementById('meta');
export const elMetaBase = document.getElementById('metaBaseSpan');
export const elQ        = document.getElementById('q');
export const elSort     = document.getElementById('sort');
export const elRefresh  = document.getElementById('refresh');
export const elRelax    = document.getElementById('relax');
export const elStream   = document.getElementById('stream');
export const elTimeDerived = document.getElementById('stimeDerived');

const elSearchWrap = document.getElementById('searchWrap');
const elQResults   = document.getElementById('qResults');

const pageSpinnerEl = document.querySelector('.spinner') && document.querySelector('.loader');

// Status helper: update meta text and spinner labels
export function setLoadingStatus(msg = '') {
  try {
    if (elMetaBase && typeof msg === 'string') elMetaBase.textContent = msg;
    if (pageSpinnerEl) {
      pageSpinnerEl.setAttribute('aria-label', msg || 'Loading…');
      pageSpinnerEl.setAttribute('title', msg || 'Loading…');
    }
  } catch {}
}

// Spinner should hide only when we have actual results
function syncPageSpinner() {
  if (!elCards || !pageSpinnerEl) return;
  const hasResults = elCards.getAttribute('data-has-results') === '1';
  pageSpinnerEl.hidden = !!hasResults;
  pageSpinnerEl.setAttribute('aria-hidden', hasResults ? 'true' : 'false');
}

function updateResultsState(hasResults) {
  if (!elCards) return;
  elCards.setAttribute('data-has-results', hasResults ? '1' : '0');
  syncPageSpinner();
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => {
    // initial state: no results yet
    updateResultsState(false);
    setLoadingStatus('Collecting instant Solana pairs…');
  }, { once: true });
} else {
  updateResultsState(false);
  setLoadingStatus('Collecting instant Solana pairs…');
}

// Observe #cards for children changes (optional), still call sync to be safe
const mo = new MutationObserver(syncPageSpinner);
if (elCards) mo.observe(elCards, { childList: true });

const debounce = (fn, ms = 120) => {
  let t; return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
};

function looksLikeMint(s) {
  if (!s) return false;
  const x = s.trim();
  if (x.length < 30 || x.length > 48) return false; // Solana ~32–44
  return /^[1-9A-HJ-NP-Za-km-z]+$/.test(x); // base58 (no 0,O,I,l)
}

function tokenHref(mint) {
  return `/token/${encodeURIComponent(mint)}`;
}

function suggestionRow(it, isActive = false, badgeText = '') {
  const a = document.createElement('a');
  a.className = 'row' + (isActive ? ' is-active' : '');
  a.href = tokenHref(it.mint);
  a.setAttribute('data-mint', it.mint);
  a.innerHTML = `
    <div class="sym">${it.symbol || '—'}</div>
    <div class="name">${it.name || ''}<div class="mint">${it.mint}</div></div>
    <div class="badge">${badgeText || 'View'}</div>
  `;
  return a;
}

let _searchCtl = null;
let _currentSuggestions = [];
let _activeIndex = -1;

let _qEpoch = 0;
let _appliedEpoch = 0;
let _currentQuery = '';
const _cacheByQuery = new Map();

function renderSuggestionsList(list) {
  _currentSuggestions = list || [];
  elQResults.innerHTML = '';
  if (!_currentSuggestions.length) {
    elQResults.innerHTML = `<div class="empty">No matches. Try a full mint address.</div>`;
    elQResults.hidden = false;
    _activeIndex = -1;
    return;
  }
  _currentSuggestions.forEach((tok, i) => {
    const badge = tok._direct ? 'Open' : (tok.dexId ? tok.dexId : 'View');
    const row = suggestionRow(
      { mint: tok.mint, symbol: tok.symbol, name: tok.name },
      i === _activeIndex,
      badge
    );
    row.addEventListener('mousedown', (ev) => {
      ev.preventDefault();
      window.location.href = row.href;
    });
    elQResults.appendChild(row);
  });
  elQResults.hidden = false;
}
function renderFromCache(query) {
  const key = (query || '').trim().toLowerCase();
  if (!key) {
    elQResults.innerHTML = '';
    elQResults.hidden = true;
    _activeIndex = -1;
    return;
  }
  const cached = _cacheByQuery.get(key);
  if (cached) {
    renderSuggestionsList(cached);
  } else {
    // no-op
  }
}

async function fetchGlobalSuggestions(q) {
  if (_searchCtl) _searchCtl.abort();
  _searchCtl = new AbortController();
  const { signal } = _searchCtl;

  try {
    const results = await searchTokensGlobal(q, { signal, limit: 12 });
    if (signal.aborted) return [];
    return results || [];
  } catch (e) {
    if (e?.name === 'AbortError') return [];
    return [];
  }
}

async function updateSuggestions(q, epoch) {
  if (!elQResults) return;

  const raw = (q || '');
  const s = raw.trim();
  const key = s.toLowerCase();

  if (!s) {
    if (epoch === _qEpoch) {
      _currentQuery = '';
      _appliedEpoch = epoch;
      elQResults.innerHTML = '';
      elQResults.hidden = true;
      _activeIndex = -1;
    }
    return;
  }

  const headRows = looksLikeMint(s) ? [{ _direct: true, mint: s, symbol: '', name: 'Go to token' }] : [];
  const global = await fetchGlobalSuggestions(s);

  if (epoch !== _qEpoch) return;

  const merged = [
    ...headRows,
    ...global.map(t => ({
      mint: t.mint,
      symbol: t.symbol,
      name: t.name,
      dexId: t.dexId,
      priceUsd: t.priceUsd,
      liquidityUsd: t.bestLiq,
      imageUrl: t.imageUrl,
    })),
  ];

  _cacheByQuery.set(key, merged);

  _currentQuery = key;
  _appliedEpoch = epoch;
  renderSuggestionsList(merged);
}

// Keyboard nav
function moveActive(delta) {
  if (!elQResults || elQResults.hidden) return;
  const n = _currentSuggestions.length;
  if (!n) return;
  _activeIndex = (_activeIndex + delta + n) % n;

  const rows = Array.from(elQResults.querySelectorAll('.row'));
  rows.forEach((r, i) => r.classList.toggle('is-active', i === _activeIndex));
  rows[_activeIndex]?.scrollIntoView({ block: 'nearest' });
}

function activateSelection() {
  if (!elQResults || elQResults.hidden) return;
  const rows = Array.from(elQResults.querySelectorAll('.row'));
  const elActive = (_activeIndex >= 0 && rows[_activeIndex]) ? rows[_activeIndex] : rows[0];
  if (elActive) window.location.href = elActive.href;
}

function syncSuggestionsAfterPaint() {
  if (elQ && elQ.value && elQ.value.trim()) {
    renderFromCache(elQ.value);
  } else if (elQResults) {
    elQResults.hidden = true;
    _activeIndex = -1;
  }
}

let _latestItems = [];
let _latestAd = null;
let _latestMarquee = null;

let elAdTop = null;
let _adRenderedKey = null;

function ensureAdSlot() {
  if (elAdTop) return elAdTop;
  if (elSearchWrap && elSearchWrap.parentElement) {
    elAdTop = document.getElementById('adTop') || document.createElement('div');
    elAdTop.id = 'adTop';
    elAdTop.style.marginBottom = '16px';
    if (!elAdTop.parentElement) {
      elSearchWrap.parentElement.insertBefore(elAdTop, elSearchWrap);
    }
  }
  return elAdTop;
}

function renderAdTop() {
  if (!_latestAd) {
    if (elAdTop) elAdTop.innerHTML = '';
    return;
  }
  ensureAdSlot();
  if (!elAdTop) return;

  const key =
    _latestAd?.mint ||
    _latestAd?.id ||
    (_latestAd?.title ? String(_latestAd.title) : null) ||
    JSON.stringify(_latestAd);

  if (_adRenderedKey === key) return; // prevent churn
  elAdTop.innerHTML = adCard(_latestAd);
  _adRenderedKey = key;
}

let elMarqueeWrap = null;
let _marqueeRenderedKey = null;

function ensureMarqueeSlot() {
  if (elMarqueeWrap) return elMarqueeWrap;
  const parent = elCards?.parentElement;
  if (!parent) return null;

  elMarqueeWrap = document.getElementById('marqueeWrap') || document.createElement('div');
  elMarqueeWrap.id = 'marqueeWrap';
  elMarqueeWrap.className = 'marquee-wrap';
  elMarqueeWrap.style.margin = '8px 0 16px 0';

  if (!elMarqueeWrap.parentElement) parent.insertBefore(elMarqueeWrap, elCards);
  if (!document.getElementById('marqueeInlineStyles')) {
    const css = document.createElement('style');
    css.id = 'marqueeInlineStyles';
    css.textContent = `
      .marquee-wrap { overflow: hidden; }
      .mq-row { display:flex; align-items:center; gap:10px; margin:6px 0; }
      .mq-label { flex:0 0 auto; font-size:12px; font-weight:700; padding:4px 8px; border-radius:999px; background:#111; color:#fff; letter-spacing:.4px; text-transform:uppercase; }
      .mq-strip { display:flex; gap:14px; overflow:hidden; mask-image: linear-gradient(to right, transparent 0, #000 40px, #000 calc(100% - 40px), transparent 100%); }
      .mq-item { display:flex; align-items:center; gap:8px; padding:6px 10px; border-radius:999px; background:rgba(255,255,255,.06); color:inherit; text-decoration:none; white-space:nowrap; }
      .mq-item:hover { background:rgba(255,255,255,.12); }
      .mq-logo { width:18px; height:18px; border-radius:50%; object-fit:cover; background:#222; }
      .mq-sym { font-weight:700; font-size:12px; }
      .mq-name { opacity:.8; font-size:12px; }
      .mq-price { opacity:.8; font-size:12px; }
      .mq-gap { width:24px; flex:0 0 auto; }
      .mq-strip-inner { display:flex; gap:14px; }
    `;
    document.head.appendChild(css);
  }
  return elMarqueeWrap;
}

function mqItemHTML(t) {
  const mint = t.mint || '';
  const sym  = t.symbol || '';
  const name = t.name || '';
  const logo = t.imageUrl || t.logoURI || '';
  const p    = t.priceUsd;
  const priceTxt = (p == null) ? '' :
    (p >= 1 ? `$${p.toLocaleString(undefined, { maximumFractionDigits: 2 })}`
            : `$${p.toFixed(6)}`);
  return `
    <a class="mq-item" href="${tokenHref(mint)}" title="${name}">
      <img class="mq-logo" src="${logo}" alt="" />
      <span class="mq-sym">${sym || '—'}</span>
      <span class="mq-name">${name || ''}</span>
      ${priceTxt ? `<span class="mq-price">${priceTxt}</span>` : ''}
    </a>
  `;
}

function marqueeRowHTML(list, label) {
  if (!Array.isArray(list) || list.length === 0) return '';
  const inner = list.map(mqItemHTML).join('<span class="mq-gap"></span>');
  // duplicate for seamless loop
  return `
    <div class="mq-row" data-label="${label}">
      <div class="mq-label">${label}</div>
      <div class="mq-strip">
        <div class="mq-strip-inner">${inner}</div>
        <div class="mq-strip-inner">${inner}</div>
      </div>
    </div>
  `;
}

function startAutoScroll(container) {
  const strips = Array.from(container.querySelectorAll('.mq-strip'));
  for (const strip of strips) {
    if (strip._af) continue;
    let paused = false;
    const speed = 0.4; // px per frame
    const step = () => {
      if (!paused) {
        strip.scrollLeft += speed;
        // loop
        if (strip.scrollLeft >= strip.scrollWidth / 2) {
          strip.scrollLeft = 0;
        }
      }
      strip._af = requestAnimationFrame(step);
    };
    strip.addEventListener('mouseenter', () => { paused = true; });
    strip.addEventListener('mouseleave', () => { paused = false; });
    strip._af = requestAnimationFrame(step);
  }
}

function renderMarquee(marquee) {
  if (!marquee) {
    if (elMarqueeWrap) elMarqueeWrap.innerHTML = '';
    return;
  }
  ensureMarqueeSlot();
  if (!elMarqueeWrap) return;

  const key = JSON.stringify({
    t: (marquee.trending || []).map(x => x.mint).slice(0, 40),
    n: (marquee.new || []).map(x => x.mint).slice(0, 40),
  });

  if (_marqueeRenderedKey === key) return;

  const tRow = marqueeRowHTML(marquee.trending || [], 'Trending');
  const nRow = marqueeRowHTML(marquee.new || [], 'New');
  const html = `${tRow}${nRow}`;
  elMarqueeWrap.innerHTML = html;

  startAutoScroll(elMarqueeWrap);
  _marqueeRenderedKey = key;
}

const SETTLE_MS = 7500;
let _settleTimer = null;
let _needsPaint  = false;

function sortItems(items, sortKey) {
  const arr = [...items];
  arr.sort((a, b) => {
    if (sortKey === 'volume')    return (b.volume?.h24 || 0)  - (a.volume?.h24 || 0);
    if (sortKey === 'liquidity') return (b.liquidityUsd || 0) - (a.liquidityUsd || 0);
    if (sortKey === 'change24')  return (b.change?.h24 || 0)  - (a.change?.h24 || 0);
    return (b.score || 0)        - (a.score || 0);
  });
  return arr;
}

function filterByQuery(items, q) {
  const s = (q || '').trim().toLowerCase();
  if (!s) return items;
  return items.filter(it =>
    (it.symbol || '').toLowerCase().includes(s) ||
    (it.name   || '').toLowerCase().includes(s) ||
    (it.mint   || '').toLowerCase().includes(s)
  );
}

const HYSTERESIS_MS = 2000;
let currentLeaderId = null;
let challengerId = null;
let challengerSince = 0;

function applyLeaderHysteresis(ranked) {
  if (!ranked.length) return ranked;

  const top = ranked[0];
  const now = Date.now();

  if (!currentLeaderId) {
    currentLeaderId = top.mint || top.id;
    return ranked;
  }

  const leaderIdx = ranked.findIndex(x => (x.mint || x.id) === currentLeaderId);

  if (leaderIdx === -1) {
    currentLeaderId = ranked[0].mint || ranked[0].id;
    challengerId = null;
    challengerSince = 0;
    return ranked;
  }

  if ((top.mint || top.id) === currentLeaderId) {
    challengerId = null;
    challengerSince = 0;
    return ranked;
  }

  const newTopId = top.mint || top.id;
  if (challengerId !== newTopId) {
    challengerId = newTopId;
    challengerSince = now;
  }
  const held = now - challengerSince;

  if (held >= HYSTERESIS_MS) {
    currentLeaderId = newTopId;
    challengerId = null;
    challengerSince = 0;
    return ranked;
  }

  const forced = ranked.slice();
  const [leader] = forced.splice(leaderIdx, 1);
  forced.unshift(leader);
  return forced;
}

function updateCardDOM(el, it) {
  // symbol & DEX badge
  const symEl = el.querySelector('.t-symbol');
  if (symEl && symEl.textContent !== (it.symbol || '')) symEl.textContent = it.symbol || '';

  const dexEl = el.querySelector('[data-dex]');
  if (dexEl) {
    const text = (it.dex || '').toUpperCase();
    if (dexEl.textContent !== text) dexEl.textContent = text;
    const colorMap = { raydium:'green', pumpswap:'cyan', orca:'blue', jupiter:'yellow', serum:'orange' };
    const col = colorMap[(it.dex||'').toLowerCase()] || 'white';
    if (dexEl.style.color !== col) dexEl.style.color = col;
  }

  // logo
  const logo = el.querySelector('[data-logo]');
  if (logo) {
    const nextSrc = it.logoURI;
    if (nextSrc && logo.getAttribute('src') !== nextSrc) logo.setAttribute('src', nextSrc);
  }

  // recommendation (class + text)
  const recEl = el.querySelector('[data-rec-text]');
  if (recEl) {
    const next = it.recommendation || '';
    if (recEl.textContent !== next) recEl.textContent = next;
    recEl.classList.remove('GOOD','WATCH','AVOID','NEUTRAL','CONSIDER');
    if (next) recEl.classList.add(next);
  }

  // price
  const priceEl = el.querySelector('.v-price');
  if (priceEl) {
    const txt = it.priceUsd ? ('$'+Number(it.priceUsd).toLocaleString(undefined,{maximumFractionDigits:6})) : '—';
    if (priceEl.textContent !== txt) priceEl.textContent = txt;
  }

  // score
  const scoreEl = el.querySelector('.v-score');
  if (scoreEl) {
    const txt = `${Math.round((it.score || 0) * 100)} / 100`;
    if (scoreEl.textContent !== txt) scoreEl.textContent = txt;
  }

  // 24h volume
  const volEl = el.querySelector('.v-vol24');
  if (volEl) {
    const n = Number(it.volume?.h24 ?? 0);
    const txt = n >= 1000 ? '$' + Intl.NumberFormat(undefined,{notation:'compact'}).format(n) : (n>0? ('$'+n.toFixed(2)):'$0');
    if (volEl.textContent !== txt) volEl.textContent = txt;
  }

  // liquidity
  const liqEl = el.querySelector('.v-liq');
  if (liqEl) {
    const n = Number(it.liquidityUsd ?? 0);
    const txt = n >= 1000 ? '$' + Intl.NumberFormat(undefined,{notation:'compact'}).format(n) : (n>0? ('$'+n.toFixed(2)):'$0');
    if (liqEl.textContent !== txt) liqEl.textContent = txt;
  }

  // FDV
  const fdvEl = el.querySelector('.v-fdv');
  if (fdvEl) {
    const n = Number(it.fdv);
    const txt = Number.isFinite(n) ? (n >= 1000 ? '$' + Intl.NumberFormat(undefined,{notation:'compact'}).format(n) : '$'+n.toFixed(2)) : '—';
    if (fdvEl.textContent !== txt) fdvEl.textContent = txt;
  }

  // pair link
  const pairWrap = el.querySelector('.v-pair');
  if (pairWrap) {
    const link = pairWrap.querySelector('.t-pair');
    if (it.pairUrl) {
      if (!link) {
        pairWrap.innerHTML = `<a class="t-pair" href="${it.pairUrl}" target="_blank" rel="noopener">DexScreener</a>`;
      } else if (link.getAttribute('href') !== it.pairUrl) {
        link.setAttribute('href', it.pairUrl);
      }
    } else if (link) {
      pairWrap.textContent = '—';
    }
  }

  const micro = el.querySelector('[data-micro]');
  if (micro) {
    const chg = Array.isArray(it._chg) ? it._chg : [];
    const chips = typeof pctChipsHTML === 'function' ? pctChipsHTML(chg) : '';
    const spark = typeof sparklineSVG === 'function' ? sparklineSVG(chg) : '';
    const html = `${chips}${spark}`;
    if (micro.innerHTML !== html) micro.innerHTML = html;
  }
}

function patchKeyedGridAnimated(container, nextItems, keyFn = x => x.mint || x.id) {
  if (!container) return;

  const prevY = window.scrollY;

  // measure old
  const oldNodes = Array.from(container.children);
  const firstRects = new Map(oldNodes.map(el => [el.dataset.key, el.getBoundingClientRect()]));
  const oldByKey = new Map(oldNodes.map(el => [el.dataset.key, el]));

  const frag = document.createDocumentFragment();
  const alive = new Set();

  for (let i = 0; i < nextItems.length; i++) {
    const it = nextItems[i];
    const k = keyFn(it);
    alive.add(k);

    let el = oldByKey.get(k);
    if (!el) {
      el = document.createElement('div');
      el.className = 'card';
      el.dataset.key = k;
      el.innerHTML = coinCard(it);
      el.classList.add('is-entering');
      el.style.opacity = '0';
      el.style.transform = 'translateY(10px) scale(.98)';
      el.style.willChange = 'transform,opacity';
    } else {
      updateCardDOM(el, it);
      el.style.willChange = 'transform,opacity';
      el.classList.remove('is-exiting');
    }

    if (i === 0) el.classList.add('is-leader'); else el.classList.remove('is-leader');
    el.style.setProperty('--rank', i);

    frag.appendChild(el);
  }

  // fade/slide removals
  for (const [k, el] of oldByKey) {
    if (!alive.has(k)) {
      el.classList.add('is-exiting');
      el.style.transition = 'opacity 260ms ease-out, transform 200ms ease-out';
      el.style.opacity = '0';
      el.style.transform = 'translateY(8px)';
      el.addEventListener('transitionend', () => el.remove(), { once: true });
    }
  }

  container.appendChild(frag);

  const newNodes = Array.from(container.children);
  requestAnimationFrame(() => {
    for (const el of newNodes) {
      const k = el.dataset.key;
      const last = el.getBoundingClientRect();
      const first = firstRects.get(k);

      if (!first) {
        el.style.transition = 'transform 480ms cubic-bezier(.22,1,.36,1), opacity 320ms ease-out';
        el.style.opacity = '1';
        el.style.transform = 'translateY(0) scale(1)';
        el.addEventListener('transitionend', () => {
          el.classList.remove('is-entering');
          el.style.willChange = '';
        }, { once: true });
        continue;
      }

      const dx = first.left - last.left;
      const dy = first.top - last.top;
      if (dx || dy) {
        el.classList.add('is-moving');
        el.style.transform = `translate(${dx}px, ${dy}px)`;
        el.style.transition = 'transform 0s';
        requestAnimationFrame(() => {
          el.style.transition = 'transform 580ms cubic-bezier(.22,1,.36,1)';
          el.style.transform = 'translate(0,0)';
        });
        el.addEventListener('transitionend', () => {
          el.classList.remove('is-moving');
          el.style.willChange = '';
        }, { once: true });
      }
    }

    if (Math.abs(window.scrollY - prevY) > 2) window.scrollTo({ top: prevY });
  });
}
export function render(items, adPick, marquee) {
  _latestItems = Array.isArray(items) ? items : [];
  _latestAd = adPick || null;
  _latestMarquee = marquee || null;

  renderAdTop();
  renderMarquee(_latestMarquee);

  _needsPaint = true;
  if (_settleTimer) return;

  paintNow();
  _settleTimer = setTimeout(() => {
    _settleTimer = null;
    if (_needsPaint) {
      paintNow();
      _needsPaint = false;
    }
  }, SETTLE_MS);
}

function paintNow() {
  const sortKey = elSort?.value || 'score';
  const filtered = filterByQuery(_latestItems, elQ?.value || '');
  const ranked0  = sortItems(filtered, sortKey).slice(0, MAX_CARDS);
  const ranked   = applyLeaderHysteresis(ranked0);

  // Drive spinner by actual result presence
  const hasResults = ranked.length > 0;
  updateResultsState(hasResults);

  // Provide constructive updates while loading
  if (!hasResults) {
    // Hint rotates based on time so it doesn’t look stuck
    const t = Date.now() % 9000;
    const hint = t < 3000
      ? 'Collecting instant Solana pairs…'
      : t < 6000
      ? 'Hydrating top tokens (volume, txns)…'
      : 'Scoring and ranking measured coins…';
    setLoadingStatus(hint);
  } else {
    setLoadingStatus(''); // pipeline will keep meta updated
  }

  patchKeyedGridAnimated(elCards, ranked, x => x.mint || x.id);

  try { syncSuggestionsAfterPaint(); } catch {}
}

export function renderSkeleton(n = 0) {
  // Skeleton should not dismiss the spinner
  updateResultsState(false);
  setLoadingStatus('Preparing view…');

  if (!n) return;
  elCards.innerHTML = '';
  for (let i = 0; i < n; i++) {
    const d = document.createElement('div');
    d.className = 'card';
    d.innerHTML = `
      <div class="top">
        <div class="logo skel"></div>
        <div style="flex:1">
          <div class="sym skel" style="height:14px;width:120px;border-radius:6px"></div>
          <div class="addr skel" style="height:10px;width:160px;margin-top:6px;border-radius:6px"></div>
        </div>
        <div class="rec skel" style="width:60px;height:22px"></div>
      </div>
      <div class="metrics" style="margin-top:10px">
        ${Array.from({length:6}).map(()=>`<div class="kv"><div class="k skel" style="height:10px;border-radius:5px"></div><div class="v skel" style="height:14px;margin-top:6px;border-radius:6px"></div></div>`).join('')}
      </div>`;
    elCards.appendChild(d);
  }
}

elSort?.addEventListener('change', () => {
  _needsPaint = true;
  if (!_settleTimer) render(_latestItems, _latestAd, _latestMarquee);
});

const debouncedRun = debounce((value, epoch) => updateSuggestions(value, epoch), 120);
elQ?.addEventListener('input', (e) => {
  const raw = e.currentTarget.value || '';
  document.getElementById('searchWrap')?.setAttribute('data-hastext', raw ? '1' : '0');
  const trimmed = raw.trim();
  _qEpoch += 1;
  const myEpoch = _qEpoch;

  debouncedRun(trimmed, myEpoch);

  _needsPaint = true;
  if (!_settleTimer) render(_latestItems, _latestAd, _latestMarquee);
});

document.getElementById('searchWrap')?.setAttribute('data-loading','1');
document.getElementById('searchWrap')?.setAttribute('data-loading','0');

document.getElementById('qClear')?.addEventListener('click', () => {
  elQ.value = '';
  document.getElementById('searchWrap')?.setAttribute('data-hastext','0');
  const r = document.getElementById('qResults');
  if (r){ r.hidden = true; r.innerHTML = ''; }
  elQ.focus();
});

elQ?.addEventListener('keydown', (e) => {
  if (!elQResults) return;
  if (e.key === 'ArrowDown') { e.preventDefault(); moveActive(+1); }
  else if (e.key === 'ArrowUp') { e.preventDefault(); moveActive(-1); }
  else if (e.key === 'Enter') {
    const raw = (elQ.value || '').trim();
    if (elQResults.hidden && looksLikeMint(raw)) {
      window.location.href = tokenHref(raw);
      return;
    }
    if (!elQResults.hidden) { e.preventDefault(); activateSelection(); }
  } else if (e.key === 'Escape') {
    elQResults.hidden = true;
    _activeIndex = -1;
  }
});

elQ?.addEventListener('blur', () => {
  setTimeout(() => { if (elQResults) elQResults.hidden = true; }, 120);
});

elSearchWrap?.addEventListener('mouseenter', () => {
  if (elQ && elQ.value && elQ.value.trim()) elQResults.hidden = false;
});
