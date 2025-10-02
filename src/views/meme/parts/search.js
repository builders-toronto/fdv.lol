import { searchTokensGlobal } from '../../../data/dexscreener.js';

let _cache = new Map();
let _ctl = null;
let _current = [];
let _activeIndex = -1;

export function looksLikeMint(s) {
  if (!s) return false;
  const x = s.trim();
  if (x.length < 30 || x.length > 48) return false;
  return /^[1-9A-HJ-NP-Za-km-z]+$/.test(x);
}

export function tokenHref(mint) {
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

function renderSuggestionsList(list, wrap) {
  _current = list || [];
  wrap.innerHTML = '';
  if (!_current.length) {
    wrap.innerHTML = `<div class="empty">No matches. Try a full mint address.</div>`;
    wrap.hidden = false;
    _activeIndex = -1;
    return;
  }
  _current.forEach((tok, i) => {
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
    wrap.appendChild(row);
  });
  wrap.hidden = false;
}

export function getQueryValue(inputEl) {
  return (inputEl?.value || '').trim();
}

function fromCache(query, wrap) {
  const key = (query || '').trim().toLowerCase();
  if (!key) {
    wrap.innerHTML = '';
    wrap.hidden = true;
    _activeIndex = -1;
    return;
  }
  const cached = _cache.get(key);
  if (cached) renderSuggestionsList(cached, wrap);
}

async function fetchGlobal(q) {
  if (_ctl) _ctl.abort();
  _ctl = new AbortController();
  const { signal } = _ctl;
  try {
    const results = await searchTokensGlobal(q, { signal, limit: 12 });
    if (signal.aborted) return [];
    return results || [];
  } catch {
    return [];
  }
}

export async function updateSuggestions(raw, wrapRef) {
  const wrap = wrapRef || document.getElementById('qResults');
  if (!wrap) return;
  const s = (raw || '').trim();
  const key = s.toLowerCase();

  if (!s) {
    wrap.innerHTML = '';
    wrap.hidden = true;
    _activeIndex = -1;
    return;
  }

  const headRows = looksLikeMint(s) ? [{ _direct: true, mint: s, symbol: '', name: 'Go to token' }] : [];
  const global = await fetchGlobal(s);
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
  _cache.set(key, merged);
  renderSuggestionsList(merged, wrap);
}

export function syncSuggestionsAfterPaint(inputEl, wrap) {
  if (inputEl && inputEl.value && inputEl.value.trim()) {
    fromCache(inputEl.value, wrap);
  } else if (wrap) {
    wrap.hidden = true;
    _activeIndex = -1;
  }
}

export function initSearch(inputEl, resultsEl, wrapEl) {
  if (!inputEl || !resultsEl) return;

  inputEl.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp' || e.key === 'Enter' || e.key === 'Escape') {
      // basic navigation omitted for brevity (can re‑add)
    }
  });

  wrapEl?.addEventListener('mouseenter', () => {
    if (inputEl && inputEl.value && inputEl.value.trim()) resultsEl.hidden = false;
  });
}