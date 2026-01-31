import { MAX_CARDS } from '../../config/env.js';

import { loadAds, pickAd, adCard, initAdBanners } from "../../ads/load.js";

import { showHome } from '../../router/main/home.js';

import { ensureAddonsUI } from './metrics/register.js';
import { ingestSnapshot } from './metrics/ingest.js';

// Addons (KPI)
import './metrics/kpi/pumping.js';
// import './metrics/kpi/honey.js';
import './metrics/kpi/three.js';
import './metrics/kpi/performers.js';
import './metrics/kpi/liquid.js';
import './metrics/kpi/smq.js';
import './metrics/kpi/degen.js';
import './metrics/kpi/comeback.js';
import './metrics/kpi/engagement.js';
import './metrics/kpi/das.js';
import './metrics/kpi/holders.js';
import './metrics/kpi/24h.js';
import './metrics/kpi/bsi.js';
import './metrics/kpi/mom.js';
import './metrics/kpi/draw.js';
import './metrics/kpi/sticky.js';

// Swap direct init() calls for the widget loader VM
import { widgets, registerCoreWidgets, prewarmDefaults } from '../widgets/loader.js';

// Keep button factories for header
import { createOpenLibraryButton } from '../widgets/library/index.js';
import { initSearch, createOpenSearchButton } from '../widgets/search/index.js';
// import { createOpenFavboardButton } from '../widgets/favboard/index.js';

import {
  initHeader,
  ensureOpenLibraryHeaderBtn,
  // ensureFavboardHeaderBtn
} from './parts/header.js';

// import {
//   ensureMarqueeSlot,
//   renderMarquee
// } from './parts/marquee.js';

import {
  patchKeyedGridAnimated,
  buildOrUpdateCard,
  applyLeaderHysteresis,
  sortItems,
  filterByQuery,
  isDisplayReady
} from './parts/cards.js';

const raf = typeof requestAnimationFrame === 'function' ? requestAnimationFrame : (fn)=>setTimeout(fn,16);
const ric = typeof requestIdleCallback === 'function'
  ? requestIdleCallback
  : (fn)=>setTimeout(()=>fn({ didTimeout:false, timeRemaining:()=>8 }), 48);

export const elCards    = document.getElementById('cards');
export const elMetaBase = document.getElementById('metaBaseSpan');
export const elQ        = document.getElementById('q');
export const elSort     = document.getElementById('sort');

function getQueryValue() {
  return (document.getElementById('q')?.value || '').trim();
}

export const elTimeDerived = document.getElementById('stimeDerived');
export const elRefresh = document.getElementById('refresh');
export const elRelax = document.getElementById('relax');

const   elSearchWrap    = document.getElementById('searchWrap');
const   elQResults      = document.getElementById('qResults');
const   pageSpinnerEl   = document.querySelector('.spinner') && document.querySelector('.loader');
const   elStream        = document.getElementById('stream');

let _latestItems = [];
let _latestAd = null;
let _latestMarquee = null;

let _lastPaintSig = '';
let _paintQueued = false;

let _elCardAdSlot = null;
let _elMarqueeAdSlot = null;

const STATE = {
  settleTimer: null,
  needsPaint: false
};

elSort.addEventListener('change', () => showHome()); // hmmm. good placement?
elRefresh.addEventListener('click', () => showHome({ force: true }));
elRelax.addEventListener('change', () => showHome({ force: true }));


function ensureAdSlots() {
  const cardsEl = elCards || document.querySelector('.cards');
  const host = cardsEl?.parentElement || document.body;

  if (!_elCardAdSlot) {
    _elCardAdSlot = document.createElement('div');
    _elCardAdSlot.id = 'cardAdSlot';
    _elCardAdSlot.className = 'ad-slot ad-slot-cards';
  }

  // Always render after the cards grid (bottom of container)
  if (cardsEl && cardsEl.parentElement) {
    const parent = cardsEl.parentElement;
    const desiredNext = cardsEl.nextSibling;
    if (_elCardAdSlot.parentElement !== parent || desiredNext !== _elCardAdSlot) {
      parent.insertBefore(_elCardAdSlot, desiredNext);
    }
  } else if (host && _elCardAdSlot.parentElement !== host) {
    host.appendChild(_elCardAdSlot);
  }

  // if (!_elMarqueeAdSlot) {
  //   const host = elCards?.parentElement || document.body;
  //   const marqueeHost =
  //     document.querySelector('[data-marquee-slot]') ||
  //     document.getElementById('marqueeSlot') ||
  //     document.querySelector('.marquee, .marquee-slot') ||
  //     null;

  //   _elMarqueeAdSlot = document.createElement('div');
  //   _elMarqueeAdSlot.id = 'marqueeAdSlot';
  //   _elMarqueeAdSlot.className = 'ad-slot ad-slot-marquee';

  //   if (marqueeHost && marqueeHost.parentElement) {
  //     marqueeHost.parentElement.insertBefore(_elMarqueeAdSlot, marqueeHost.nextSibling);
  //   } else {
  //     (host).insertBefore(_elMarqueeAdSlot, elCards || host.firstChild);
  //   }
  // }
}

function renderAdInto(slot, ad) {
  if (!slot) return;
  if (!ad) { slot.innerHTML = ''; return; }
  try {
    const node = adCard(ad);
    if (typeof node === 'string') {
      slot.innerHTML = node;
    } else if (node instanceof Node) {
      slot.innerHTML = '';
      slot.appendChild(node);
    } else {
      slot.innerHTML = '';
    }
  } catch {
    slot.innerHTML = '';
  }
}

function renderAdSlots() {
  if (!_latestAd) return;
  ensureAdSlots();
  renderAdInto(_elCardAdSlot, _latestAd);
  // renderAdInto(_elMarqueeAdSlot, _latestAd);
}

async function loadAndRenderAd() {
  try {
    if (_elCardAdSlot && _elCardAdSlot.childElementCount > 0) return;
    if (_elMarqueeAdSlot && _elMarqueeAdSlot.childElementCount > 0) return;
    const ads = await loadAds();
    const pick = pickAd(ads);
    if (pick) {
      _latestAd = pick;
      renderAdSlots();
    }
    await initAdBanners(document);
  } catch {}
}

export function setLoadingStatus(msg = '') {
  try {
    if (elMetaBase && typeof msg === 'string' && elMetaBase.textContent !== msg) {
      elMetaBase.textContent = msg;
    }
    if (pageSpinnerEl) {
      if (pageSpinnerEl.getAttribute('aria-label') !== (msg || 'Loading…'))
        pageSpinnerEl.setAttribute('aria-label', msg || 'Loading…');
      if (pageSpinnerEl.getAttribute('title') !== (msg || 'Loading…'))
        pageSpinnerEl.setAttribute('title', msg || 'Loading…');
    }
  } catch {}
}

function isStreamOnLocal() {
  const btn = elStream;
  if (!btn) return true;
  const ap = btn.getAttribute('aria-pressed');
  if (ap != null) return ap === 'true' || ap === '1';
  return /on/i.test(btn.textContent || '');
}

function setLoadingStatusAuto() {
  if (isStreamOnLocal()) {
    setLoadingStatus('Collecting instant Solana pairs…');
  } else {
    setLoadingStatus('Stream is Off — feed disabled');
  }
}

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

if (elCards) {
  new MutationObserver(syncPageSpinner).observe(elCards, { childList: true });
}

function computeRanked(items, sortKey, q) {
  const eligible = Array.isArray(items) ? items.filter(isDisplayReady) : [];
  if (!eligible.length) return [];
  const filtered = filterByQuery(eligible, q);
  if (!filtered.length) return [];
  const ranked0  = sortItems(filtered, sortKey).slice(0, MAX_CARDS);
  return applyLeaderHysteresis(ranked0);
}

function schedulePaint(immediate = false) {
  if (_paintQueued) return;
  _paintQueued = true;
  const doPaint = () => {
    _paintQueued = false;
    paintNow();
  };
  if (immediate) return raf(doPaint);
  // Let JS finish & allow browser a breath!!!!!
  ric(doPaint);
}

function paintNow() {
  const sortKey = elSort?.value || 'score';
  const q = getQueryValue(elQ);
  const ranked = computeRanked(_latestItems, sortKey, q);

  const sig = (() => {
    const ids = ranked.slice(0,5).map(x => x.mint || x.id).join(',');
    return `${ranked.length}|${ids}|${sortKey}|${q}`;
  })();
  if (sig === _lastPaintSig) return;
  _lastPaintSig = sig;

  const hasResults = ranked.length > 0;
  updateResultsState(hasResults);

  if (!hasResults) {
    if (!isStreamOnLocal()) {
      setLoadingStatus('Stream is Off — feed disabled');
    } else {
      const t = Date.now() % 9000;
      const hint = t < 3000 ? 'Collecting instant Solana pairs…'
        : t < 6000 ? 'Hydrating (volume & txns)…'
        : 'Scoring and ranking measured coins…';
      setLoadingStatus(hint);
    }
  } else {
    setLoadingStatus('');
  }

  patchKeyedGridAnimated(elCards, ranked, x => x.mint || x.id, buildOrUpdateCard);
  try { syncSuggestionsAfterPaint(elQ, elQResults); } catch {}
}

export function renderHomeView(items, adPick, marquee) {
  _latestItems = Array.isArray(items) ? items : [];
  _latestAd = adPick || _latestAd;
  _latestMarquee = marquee || null;

  ensureOpenLibraryHeaderBtn();
  // ensureFavboardHeaderBtn();
  try { ingestSnapshot(_latestItems); } catch {}
  // renderMarquee(_latestMarquee);

  // if (_latestAd) renderAdSlots();

  STATE.needsPaint = true;

  if (STATE.settleTimer) {
    clearTimeout(STATE.settleTimer);
    STATE.settleTimer = null;
  }

  schedulePaint(true); // first paint ASAP

  STATE.settleTimer = setTimeout(() => {
    STATE.settleTimer = null;
    if (STATE.needsPaint) {
      schedulePaint(true);
      STATE.needsPaint = false;
    }
  }, 3000); // was 7500ms
}

export function renderSkeleton(n = 0) {
  updateResultsState(false);
  setLoadingStatus('Preparing view…');
  if (!n || !elCards) return;
  if (elCards.firstChild) elCards.innerHTML = '';
  const frag = document.createDocumentFragment();
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
    frag.appendChild(d);
  }
  elCards.appendChild(frag);
}

function wireSort() {
  elSort?.addEventListener('change', () => {
    STATE.needsPaint = true;
    schedulePaint();
  }, { passive: true });
}

let _searchDebounce = 0;
function wireSearch() {
  if (!elQ) return;
  elQ.addEventListener('input', (e) => {
    const raw = e.currentTarget.value || '';
    const wrap = document.getElementById('searchWrap');
    const has = raw ? '1' : '0';
    if (wrap && wrap.getAttribute('data-hastext') !== has) wrap.setAttribute('data-hastext', has);

    clearTimeout(_searchDebounce);
    _searchDebounce = setTimeout(() => {
      updateSuggestions(raw);
      STATE.needsPaint = true;
      schedulePaint();
    }, 120); // debounce
  }, { passive: true });

  document.getElementById('qClear')?.addEventListener('click', () => {
    if (!elQ) return;
    elQ.value = '';
    document.getElementById('searchWrap')?.setAttribute('data-hastext','0');
    const r = elQResults;
    if (r){ r.hidden = true; r.innerHTML = ''; }
    _lastPaintSig = ''; 
    STATE.needsPaint = true;
    schedulePaint();
    elQ.focus();
  }, { passive: true });
}

function initInitialLoading() {
  const apply = () => {
    updateResultsState(false);
    setLoadingStatusAuto();
    const sb = elStream;
    if (sb && !sb.dataset.loadingWired) {
      sb.dataset.loadingWired = '1';
      sb.addEventListener('click', () => {
        const hasResults = elCards?.getAttribute('data-has-results') === '1';
        if (!hasResults) setLoadingStatusAuto();
      }, { passive: true });
    }
  };
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', apply, { once: true });
  } else {
    apply();
  }
}

(function boot() {
  try { initHeader(createOpenLibraryButton, createOpenSearchButton); } catch {}
  try { ensureAddonsUI(); } catch {}

  try { registerCoreWidgets(); } catch {}
  try { prewarmDefaults(); } catch {}

  try { widgets.mount('auto'); } catch {}
  try {
    // Search needs inputs from this page
    widgets.mount('search', { elQ, elQResults, elSearchWrap });
  } catch {}



  // try { initLibrary(); } catch {}
  // try { initFavboard(); } catch {}
  // try {
  //   const host = document.getElementById('hdrToolsPanels') || document.body;
  //   initAutoWidget(host);
  // } catch {}

  initSearch(elQ, elQResults, elSearchWrap);

  loadAndRenderAd().catch(() => {});

  // ensureMarqueeSlot(elCards);

  wireSort();
  wireSearch();
  initInitialLoading();
})();
