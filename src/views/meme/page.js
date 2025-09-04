import { MAX_CARDS } from '../../config/env.js';
import { coinCard } from './cards.js';
import { adCard } from '../../ads/load.js';
import { sparklineSVG } from './render/sparkline.js';
import { pctChipsHTML } from './render/chips.js';

export const elCards    = document.getElementById('cards');
export const elMeta     = document.getElementById('meta');
export const elMetaBase = document.getElementById('metaBase');
export const elQ        = document.getElementById('q');
export const elSort     = document.getElementById('sort');
export const elRefresh  = document.getElementById('refresh');
export const elRelax    = document.getElementById('relax');
export const elStream   = document.getElementById('stream');

let _latestItems = [];
let _latestAd = null;

let elAdTop = null;
let _adRenderedKey = null;

function ensureAdSlot() {
  if (elAdTop) return elAdTop;
  if (elCards && elCards.parentElement) {
    elAdTop = document.getElementById('adTop') || document.createElement('div');
    elAdTop.id = 'adTop';
    elAdTop.style.marginBottom = '16px';
    if (!elAdTop.parentElement) {
      elCards.parentElement.insertBefore(elAdTop, elCards);
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

  if (_adRenderedKey === key) return; // no churn if unchanged

  elAdTop.innerHTML = adCard(_latestAd);
  _adRenderedKey = key;
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

const HYSTERESIS_MS = 9000;
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

  // keep current leader in slot 1 temporarily
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
    recEl.classList.remove('GOOD','WATCH','AVOID');
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

export function render(items, adPick) {
  _latestItems = Array.isArray(items) ? items : [];
  _latestAd = adPick || null;

  renderAdTop();

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
  patchKeyedGridAnimated(elCards, ranked, x => x.mint || x.id);
}

export function renderSkeleton(n = 0) {
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
  if (!_settleTimer) render(_latestItems, _latestAd);
});
elQ?.addEventListener('input', () => {
  _needsPaint = true;
  if (!_settleTimer) render(_latestItems, _latestAd);
});
