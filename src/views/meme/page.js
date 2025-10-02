import { MAX_CARDS } from '../../config/env.js';

import { showHome } from '../../router/main/home.js';

import { ensureAddonsUI } from './addons/register.js';
import { ingestSnapshot } from './addons/ingest.js';

// Addons (KPI)
import './addons/three.js';
import './addons/smq.js';
import './addons/degen.js';
import './addons/engagement.js';
import './addons/das.js';

import { initLibrary, createOpenLibraryButton } from '../widgets/library.js';

import {
  initHeader,
  ensureOpenLibraryHeaderBtn
} from './parts/header.js';

import {
  initSearch,
  updateSuggestions,
  syncSuggestionsAfterPaint,
  getQueryValue
} from './parts/search.js';

import {
  ensureMarqueeSlot,
  renderMarquee
} from './parts/marquee.js';

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

const STATE = {
  settleTimer: null,
  needsPaint: false
};

elSort.addEventListener('change', () => showHome()); // hmmm. good placement?
elRefresh.addEventListener('click', () => showHome({ force: true }));
elRelax.addEventListener('change', () => showHome({ force: true }));

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

export function render(items, adPick, marquee) {
  _latestItems = Array.isArray(items) ? items : [];
  _latestAd = adPick || null;
  _latestMarquee = marquee || null;

  ensureOpenLibraryHeaderBtn();
  try { ingestSnapshot(_latestItems); } catch {}
  renderMarquee(_latestMarquee);

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
  try { initHeader(createOpenLibraryButton); } catch {}
  try { ensureAddonsUI(); } catch {}
  try { initLibrary(); } catch {}

  initSearch(elQ, elQResults, elSearchWrap);
  ensureMarqueeSlot(elCards);

  wireSort();
  wireSearch();
  initInitialLoading();
})();
