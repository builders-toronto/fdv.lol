import { sparklineSVG } from '../render/sparkline.js';
import { pctChipsHTML } from '../render/chips.js';
import { EXPLORER, FALLBACK_LOGO, JUP_SWAP, shortAddr } from '../../../config/env.js';
import { buildSocialLinksHtml, iconFor } from '../../../lib/socialBuilder.js';
import { fmtUsd, normalizeWebsite } from '../../../core/tools.js';
import { getTokenLogoPlaceholder, queueTokenLogoLoad } from '../../../core/ipfs.js';
import { formatPriceParts, toDecimalString } from '../../../lib/formatPrice.js'; 

const __FDV_FLOAT_INIT = '__fdvCardFloatInit';
const __FDV_FLOAT_STATE = '__fdvCardFloatState';
const __FDV_COPY_MINT_INIT = '__fdvCopyMintInit';
const __FDV_LIKE_INIT = '__fdvCardLikeInit';
const __FDV_LIKE_HYDRATE_INIT = '__fdvCardLikeHydrateInit';

function _runIdle(fn) {
  try {
    if (typeof requestIdleCallback === 'function') {
      requestIdleCallback(() => { try { fn(); } catch {} }, { timeout: 200 });
    } else {
      setTimeout(() => { try { fn(); } catch {} }, 0);
    }
  } catch {
    try { setTimeout(() => { try { fn(); } catch {} }, 0); } catch {}
  }
}

function _scheduleLikeHydrate(root = document) {
  try {
    if (typeof window === 'undefined') return;
    if (window.__fdvLikeHydratePending) return;
    window.__fdvLikeHydratePending = true;

    _runIdle(async () => {
      window.__fdvLikeHydratePending = false;
      try {
        const mod = await import('../../widgets/library/index.js');
        if (typeof mod?.bindFavoriteButtons === 'function') mod.bindFavoriteButtons(root);
      } catch {}
    });
  } catch {}
}

function _flashMintCopyLabel(mintEl) {
  if (!mintEl) return;

  const prev = mintEl.textContent;
  if (!prev) return;

  try {
    mintEl.dataset._fdvPrevText = prev;
  } catch {}

  mintEl.textContent = 'Copied!';

  window.setTimeout(() => {
    try {
      if (!mintEl.isConnected) return;

      const restore = mintEl.dataset?.mintShort || mintEl.dataset?._fdvPrevText || prev;
      if (mintEl.textContent === 'Copied!') mintEl.textContent = restore;
      try { delete mintEl.dataset._fdvPrevText; } catch {}
    } catch {}
  }, 750);
}

function _getFloatState() {
  try { return window[__FDV_FLOAT_STATE] || null; } catch { return null; }
}

function _setFloatState(st) {
  try { window[__FDV_FLOAT_STATE] = st || null; } catch {}
}

function _endFloatFreeze() {
  const st = _getFloatState();
  if (!st) return;

  try { st.card?.removeEventListener?.('pointerleave', st.onLeave); } catch {}
  try { st.card?.removeEventListener?.('pointerdown', st.onDown); } catch {}
  try { st.card?.removeEventListener?.('pointermove', st.onMove); } catch {}
  try { st.card?.removeEventListener?.('pointerup', st.onUp); } catch {}
  try { st.card?.removeEventListener?.('pointercancel', st.onUp); } catch {}
  try {
    if (st.pointerId != null && st.card?.releasePointerCapture) st.card.releasePointerCapture(st.pointerId);
  } catch {}

  try {
    if (st.placeholder && st.card) {
      st.placeholder.replaceWith(st.card);
    }
  } catch {}

  try {
    const el = st.card;
    if (el) {
      el.classList.remove('is-floating');
      el.style.position = '';
      el.style.left = '';
      el.style.top = '';
      el.style.width = '';
      el.style.height = '';
      el.style.zIndex = '';
      el.style.margin = '';
      el.style.transform = '';
      el.style.transition = '';
      el.style.willChange = '';
      el.style.pointerEvents = '';
      el.style.cursor = '';
    }
  } catch {}

  try { st.placeholder?.remove?.(); } catch {}
  _setFloatState(null);
}

function _startFloatFreeze(cardEl) {
  if (!cardEl) return;

  const existing = _getFloatState();
  if (existing?.card === cardEl) return;
  if (existing) _endFloatFreeze();

  const rect = cardEl.getBoundingClientRect();
  if (!(rect.width > 0 && rect.height > 0)) return;

  const placeholder = cardEl.cloneNode(true);
  try {
    placeholder.setAttribute('aria-hidden', 'true');
    placeholder.dataset.fdvPlaceholder = '1';
    placeholder.style.visibility = 'hidden';
    placeholder.style.pointerEvents = 'none';
    placeholder.style.userSelect = 'none';
  } catch {}

  // Swap into the grid to preserve layout.
  try { cardEl.replaceWith(placeholder); } catch { return; }

  // Float the real card above the app.
  try {
    document.body.appendChild(cardEl);
    cardEl.classList.add('is-floating');
    cardEl.style.position = 'fixed';
    cardEl.style.left = `${rect.left}px`;
    cardEl.style.top = `${rect.top}px`;
    cardEl.style.width = `${rect.width}px`;
    cardEl.style.height = `${rect.height}px`;
    cardEl.style.zIndex = '9999';
    cardEl.style.margin = '0';
    cardEl.style.willChange = 'transform';
    cardEl.style.transition = 'transform 120ms ease-out';
    cardEl.style.transform = 'translateY(-2px) scale(1.03)';
    cardEl.style.pointerEvents = 'auto';
  } catch {
    try { placeholder.replaceWith(cardEl); } catch {}
    try { placeholder.remove(); } catch {}
    return;
  }

  const st = {
    card: cardEl,
    placeholder,
    onLeave: null,
    onDown: null,
    onMove: null,
    onUp: null,
    pointerId: null,
    dragging: false,
    dragStarted: false,
    startX: 0,
    startY: 0,
    startLeft: 0,
    startTop: 0,
    lastX: 0,
    lastY: 0,
    moved: 0,
    suppressClick: false,
  };

  // Allow click-and-hold drag while floating.
  st.onDown = (e) => {
    try {
      // Mouse only (matches hover intent) + left button.
      if (e && 'pointerType' in e && e.pointerType && e.pointerType !== 'mouse') return;
      if (e && 'button' in e && e.button !== 0) return;

      // Don't hijack interactions inside the card.
      const t = e?.target;
      if (t && t.closest?.('a,button,input,textarea,select,label')) return;

      const el = st.card;
      if (!el) return;

      st.pointerId = e.pointerId;
      st.dragging = true;
      st.dragStarted = false;
      st.moved = 0;
      st.suppressClick = false;

      const left = Number.parseFloat(el.style.left || '0') || 0;
      const top = Number.parseFloat(el.style.top || '0') || 0;
      st.startLeft = left;
      st.startTop = top;
      st.startX = Number(e.clientX || 0);
      st.startY = Number(e.clientY || 0);
      st.lastX = st.startX;
      st.lastY = st.startY;

      try { el.setPointerCapture?.(e.pointerId); } catch {}
      try { el.style.cursor = 'grabbing'; } catch {}

      // Prevent text selection while dragging.
      try { e.preventDefault?.(); } catch {}
    } catch {}
  };

  st.onMove = (e) => {
    try {
      if (!st.dragging) return;
      if (st.pointerId != null && e.pointerId !== st.pointerId) return;

      const el = st.card;
      if (!el) return;

      const x = Number(e.clientX || 0);
      const y = Number(e.clientY || 0);
      const dx = x - st.startX;
      const dy = y - st.startY;
      st.lastX = x;
      st.lastY = y;

      const dist = Math.hypot(dx, dy);
      st.moved = Math.max(st.moved || 0, dist);
      if (!st.dragStarted && dist >= 3) {
        st.dragStarted = true;
        st.suppressClick = true;
        try { el.style.transition = 'none'; } catch {}
        try { el.style.transform = 'none'; } catch {}
        try { el.style.willChange = 'left, top'; } catch {}
      }

      if (st.dragStarted) {
        el.style.left = `${st.startLeft + dx}px`;
        el.style.top = `${st.startTop + dy}px`;
      }
    } catch {}
  };

  st.onUp = (e) => {
    try {
      if (!st.dragging) return;
      if (st.pointerId != null && e && e.pointerId !== st.pointerId) return;

      const el = st.card;
      st.dragging = false;

      try {
        if (el?.releasePointerCapture && st.pointerId != null) el.releasePointerCapture(st.pointerId);
      } catch {}
      st.pointerId = null;

      try { if (el) el.style.cursor = 'grab'; } catch {}
    } catch {}
  };

  // If the user dragged, swallow the click that follows pointerup.
  const onClickCapture = (e) => {
    try {
      if (!st.suppressClick) return;
      st.suppressClick = false;
      e.preventDefault?.();
      e.stopPropagation?.();
    } catch {}
  };

  st.onLeave = () => {
    try {
      // Don't auto-close while actively dragging.
      if (st.dragging) return;
    } catch {}
    _endFloatFreeze();
  };

  try { cardEl.style.cursor = 'grab'; } catch {}
  try { cardEl.addEventListener('pointerleave', st.onLeave, { passive: true }); } catch {}
  try { cardEl.addEventListener('pointerdown', st.onDown); } catch {}
  try { cardEl.addEventListener('pointermove', st.onMove); } catch {}
  try { cardEl.addEventListener('pointerup', st.onUp); } catch {}
  try { cardEl.addEventListener('pointercancel', st.onUp); } catch {}
  try { cardEl.addEventListener('click', onClickCapture, true); } catch {}

  _setFloatState(st);
}

try {
  if (typeof window !== 'undefined' && !window[__FDV_FLOAT_INIT]) {
    window[__FDV_FLOAT_INIT] = true;

    document.addEventListener('pointerover', (e) => {
      // Only do this for real mouse hover.
      if (e && 'pointerType' in e && e.pointerType && e.pointerType !== 'mouse') return;
      const card = e?.target?.closest?.('.card[data-key]');
      if (!card) return;
      _startFloatFreeze(card);
    }, { passive: true });

    // Safety: if focus is lost / user alt-tabs, restore.
    window.addEventListener('blur', () => _endFloatFreeze(), { passive: true });
  }
} catch {}

try {
  if (typeof window !== 'undefined' && !window[__FDV_COPY_MINT_INIT]) {
    window[__FDV_COPY_MINT_INIT] = true;

    document.addEventListener('click', (e) => {
      const t = e?.target;
      if (!t) return;

      // Don't hijack normal link/button clicks.
      if (t.closest?.('a,button,input,textarea,select,label')) return;

      const mintEl = t.closest?.('[data-copy-mint]');
      if (!mintEl) return;

      _flashMintCopyLabel(mintEl);
    });
  }
} catch {}

try {
  if (typeof window !== 'undefined' && !window[__FDV_LIKE_INIT]) {
    window[__FDV_LIKE_INIT] = true;

    document.addEventListener('click', async (e) => {
      const t = e?.target;
      if (!t) return;

      // Only intercept the first interaction for un-wired like buttons.
      const btn = t.closest?.('[data-fav-send][data-mint]');
      if (!btn) return;
      if (btn.dataset?.fdvlWired === '1') return;

      try { e.preventDefault?.(); } catch {}
      try { e.stopPropagation?.(); } catch {}

      try {
        const mint = btn.getAttribute('data-mint') || btn.dataset?.mint || '';
        const symbol = btn.getAttribute('data-token-symbol') || btn.dataset?.tokenSymbol || '';
        const name = btn.getAttribute('data-token-name') || btn.dataset?.tokenName || '';
        const imageUrl = btn.getAttribute('data-token-image') || btn.dataset?.tokenImage || '';

        const mod = await import('../../widgets/library/index.js');
        if (mod?.ensureSendFavoriteButton) {
          mod.ensureSendFavoriteButton(btn.parentElement || document.body, { mint, symbol, name, imageUrl, className: 'micro-fav' });
        } else if (mod?.createSendFavoriteButton) {
          mod.createSendFavoriteButton({ mint, symbol, name, imageUrl, className: 'micro-fav' });
        }

        // Re-dispatch click so the freshly wired handler can run.
        try { btn.click(); } catch {}
      } catch {}
    });
  }
} catch {}

try {
  if (typeof window !== 'undefined' && !window[__FDV_LIKE_HYDRATE_INIT]) {
    window[__FDV_LIKE_HYDRATE_INIT] = true;
    _scheduleLikeHydrate(document);
  }
} catch {}

function escAttr(v) {
  const s = String(v ?? '');
  return s
    .replaceAll('&', '&amp;')
    .replaceAll('"', '&quot;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}

// Price HTML with tiny counter for sub-unit values
export function priceHTML(value) {
  if (value == null || !Number.isFinite(+value)) return '—';
  const dec = toDecimalString(value);
  const [rawInt = "0", rawFrac = "0"] = dec.replace(/^[+-]?/, "").split(".");
  const sign = String(value).trim().startsWith("-") ? "-" : "";
  const title = `${sign}${rawInt}.${rawFrac}`;

  // >= 1: standard formatted price with clamped fraction
  if (rawInt !== "0") {
    const p = formatPriceParts(dec, { maxFrac: 6, minFrac: 1 });
    return `
      <span class="currency">$</span>
      <span class="price" title="${escAttr(p.text)}">
        ${p.sign ? `<span class="sign">${p.sign}</span>` : ""}
        <span class="int">${p.int}</span><span class="dot">.</span><span class="frac">${p.frac}</span>
      </span>
    `;
  }

  // < 1: tiny price with leading-zero counter and significant digits
  const fracRaw = (rawFrac || "0").replace(/[^0-9]/g, "");
  const leadZeros = (fracRaw.match(/^0+/) || [""])[0].length;
  const sig = fracRaw.slice(leadZeros, leadZeros + 3) || "0"; // first few significant digits

  return `
    <span class="currency">$</span>
    <span class="priceTiny" title="${escAttr(title)}" aria-label="${escAttr(`0.0 - ${leadZeros} DECIMAL - ${sig}`)}">
      <span class="base">0.0</span>
      <span class="count">${leadZeros}</span>
      <span class="sig">${escAttr(sig)}</span>
    </span>
  `;
}

export function coinCard(it) {
  const sym = it.symbol || it.name || '';
  const rawlogo = String(it.logoURI || '');
  const logo = getTokenLogoPlaceholder(rawlogo, sym) || FALLBACK_LOGO(it.symbol);
  const website = normalizeWebsite(it.website) || EXPLORER(it.mint);
  const buyUrl = JUP_SWAP(it.mint);

  const relay = it.relay || 'priority';             
  const priority = relay === 'priority' ? true : !!it.priority;
  const timeoutMs = Number.isFinite(it.timeoutMs) ? it.timeoutMs : 2500;

  const pairUrl = it.pairUrl || '';

  // Pre-hydration bits the modal/token-profile can grab instantly
  const tokenHydrate = {
    mint: it.mint,
    symbol: it.symbol || '',
    name: it.name || '',
    // Keep raw here; UI elements will load via queueTokenLogoLoad to avoid request errors.
    imageUrl: rawlogo,
    headlineUrl: pairUrl || null,
    priceUsd: it.priceUsd ?? null,
    liquidityUsd: it.liquidityUsd ?? null,
    v24hTotal: it.volume?.h24 ?? null,
    fdv: it.fdv ?? null
  };

  const swapOpts = {
    relay,
    priority,
    timeoutMs,
    pairUrl,
    tokenHydrate
  };

  const badgeColour = () => {
    if (it.dex === 'raydium') return 'green';
    if (it.dex === 'pumpswap') return 'cyan';
    if (it.dex === 'orca') return 'blue';
    if (it.dex === 'jupiter') return 'yellow';
    if (it.dex === 'serum') return 'orange';
    return 'white';
  };

  const badgeEmoji = () => {
    if (it.dex === 'raydium') return '🟢';
    if (it.dex === 'pumpswap') return '🔵';
    if (it.dex === 'orca') return '🐳';
    if (it.dex === 'jupiter') return '🌕';
    if (it.dex === 'serum') return '🧪';
    return '⚪';
  };

  const uniqPush = (arr, link) => {
    if (!link?.href) return;
    if (!arr.some(x => x.href === link.href)) arr.push(link);
  };

  const links = [];
  if (website) uniqPush(links, { platform: 'website', href: website });

  let socialsHtml = buildSocialLinksHtml(it, it.mint);

  const micro = `
    <div class="micro" data-micro>
      <div class="micro-left" data-micro-chips>${pctChipsHTML(it._chg)}</div>
      <button
        type="button"
        class="iconbtn micro-fav"
        data-fav-send
        data-mint="${escAttr(it.mint)}"
        data-token-symbol="${escAttr(it.symbol || '')}"
        data-token-name="${escAttr(it.name || '')}"
        data-token-image="${escAttr(rawlogo)}"
        aria-label="Like"
        data-tooltip="Like"
      ><span class="fdv-lib-heart" aria-hidden="true">❤️</span><span class="fdv-lib-count">0</span></button>
    </div>`;

  const swapBtn = `
    <button
      type="button"
      class="btn"
      data-swap-btn
      data-mint="${escAttr(it.mint)}"
      data-relay="${escAttr(relay)}"
      data-priority="${priority ? '1' : '0'}"
      data-timeout-ms="${escAttr(timeoutMs)}"
      data-pair-url="${escAttr(pairUrl)}"
      data-swap-opts='${escAttr(JSON.stringify(swapOpts))}'
    >Chart 📊</button>`;

  const holdBtn = `
    <button
      type="button"
      class="btn holdCoin"
      data-hold-btn
      data-mint="${escAttr(it.mint)}"
      title="Open Hold bot for this mint"
    >HODL</button>`;

  return `
  <div class="card-rank" aria-hidden="true"></div>
  <article
    class="card"
    data-hay="${escAttr((it.symbol||'')+' '+(it.name||'')+' '+it.mint)}"
    data-mint="${escAttr(it.mint)}"
    data-relay="${escAttr(relay)}"
    data-priority="${priority ? '1' : '0'}"
    data-timeout-ms="${escAttr(timeoutMs)}"
    data-pair-url="${escAttr(pairUrl)}"
    data-token-hydrate='${escAttr(JSON.stringify(tokenHydrate))}'
    data-swap-opts='${escAttr(JSON.stringify(swapOpts))}'
  >

  <div class="top">
    <div class="logo"><img data-logo src="${escAttr(logo)}" data-logo-raw="${escAttr(rawlogo)}" data-sym="${escAttr(sym)}" alt=""></div>
    <div style="flex:1">
      <div class="sym">
        <span class="t-symbol" data-symbol>${escAttr(it.symbol || '')}</span>
        <span class="badge" data-dex style="color:${escAttr(badgeColour())}">${escAttr((it.dex||'INIT').toUpperCase())}</span>
      </div>
    </div>
    <div class="rec ${escAttr(it.recommendation || '')}" data-rec-text>${escAttr(it.recommendation || '')}</div>
  </div>
  <div class="addr" style="display:flex; justify-content:space-between; align-items:center; gap:10px;">
    <div style="display:flex; align-items:center; gap:10px; min-width:0;">
      <span
        class="t-mint t-explorer"
        data-copy-mint
        data-mint="${escAttr(it.mint)}"
        data-mint-short="${escAttr(shortAddr(it.mint))}"
        style="overflow:hidden; text-overflow:ellipsis; white-space:nowrap; cursor:pointer;"
        title="Click to copy mint"
      >${escAttr(shortAddr(it.mint))}</span>
    </div>
    <a class="t-profile" href="https://fdv.lol/token/${escAttr(it.mint)}" target="_blank" rel="noopener">Profile</a>
  </div>

  <div class="metrics">
    <div class="kv"><div class="k">Price</div><div class="v v-price">${it.priceUsd != null ? priceHTML(+it.priceUsd) : '—'}</div></div>
    <div class="kv"><div class="k">Trending Score</div><div class="v v-score">${Math.round((it.score||0)*100)} / 100</div></div>
    <div class="kv"><div class="k">24h Volume</div><div class="v v-vol24">${fmtUsd(it.volume?.h24)}</div></div>
    <div class="kv"><div class="k">Liquidity</div><div class="v v-liq">${fmtUsd(it.liquidityUsd)}</div></div>
    <div class="kv"><div class="k">FDV</div><div class="v v-fdv">${it.fdv ? fmtUsd(it.fdv) : '—'}</div></div>
    <div class="kv"><div class="k">Trend</div><div class="v v-spark" data-spark>${sparklineSVG(it._chg, { w: 160, h: 28 })}</div></div>
  </div>

  ${micro}

  <div class="actions actionButtons">
    ${socialsHtml ? `<div class="actions" data-socials>${socialsHtml}<a class="social-link iconbtn t-explorer" href="${escAttr(EXPLORER(it.mint))}" target="_blank" rel="noopener noreferrer" aria-label="Solscan" title="Solscan" data-tooltip="Solscan">${iconFor('solscan')}</a></div>` : ''}
    
    <div class="btnWrapper">
      ${swapBtn}
      ${holdBtn}
    </div>
  </div>
</article>`;
}

export function isDisplayReady(t) {
  return t &&
    Number.isFinite(Number(t.priceUsd)) &&
    Number.isFinite(Number(t.liquidityUsd)) &&
    Number.isFinite(Number(t.volume?.h24)) &&
    Number.isFinite(Number(t.txns?.h24)) &&
    Number.isFinite(t.score) &&
    t.recommendation && t.recommendation !== 'MEASURING';
}

export function sortItems(items, sortKey) {
  const arr = [...items];
  arr.sort((a, b) => {
    if (sortKey === 'launches') {
      const aa = Number.isFinite(Number(a?.ageMs)) ? Number(a.ageMs) : Number.POSITIVE_INFINITY;
      const bb = Number.isFinite(Number(b?.ageMs)) ? Number(b.ageMs) : Number.POSITIVE_INFINITY;
      return (aa - bb) || ((b.score || 0) - (a.score || 0));
    }
    if (sortKey === 'volume')    return (b.volume?.h24 || 0)  - (a.volume?.h24 || 0);
    if (sortKey === 'liquidity') return (b.liquidityUsd || 0) - (a.liquidityUsd || 0);
    if (sortKey === 'change24')  return (b.change?.h24 || 0)  - (a.change?.h24 || 0);
    return (b.score || 0)        - (a.score || 0);
  });
  return arr;
}

export function filterByQuery(items, q) {
  const s = (q || '').trim().toLowerCase();
  if (!s) return items;
  return items.filter(it =>
    (it.symbol || '').toLowerCase().includes(s) ||
    (it.name   || '').toLowerCase().includes(s) ||
    (it.mint   || '').toLowerCase().includes(s)
  );
}

// ---- Leader Hysteresis ----
const HYSTERESIS_MS = 2000;
let currentLeaderId = null;
let challengerId = null;
let challengerSince = 0;

export function applyLeaderHysteresis(ranked) {
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

// ---- Card DOM Update ----
export function updateCardDOM(el, it) {
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

  const logo = el.querySelector('[data-logo]');
  if (logo) {
    const raw = String(it.logoURI || '');
    const sym = String(it.symbol || it.name || '');
    try {
      if (sym && !logo.getAttribute('data-sym')) logo.setAttribute('data-sym', sym);
      if (raw) logo.setAttribute('data-logo-raw', raw);
    } catch {}
    queueTokenLogoLoad(logo, raw, sym);
  }
    
  const recEl = el.querySelector('[data-rec-text]');
  if (recEl) {
    const next = it.recommendation || '';
    if (recEl.textContent !== next) recEl.textContent = next;
    recEl.classList.remove('GOOD','WATCH','AVOID','NEUTRAL','CONSIDER');
    if (next) recEl.classList.add(next);
  }

  const priceEl = el.querySelector('.v-price');
  if (priceEl) {
    const nextHtml = (it.priceUsd != null && Number.isFinite(+it.priceUsd))
      ? priceHTML(+it.priceUsd)
      : '—';
    if (priceEl.innerHTML !== nextHtml) priceEl.innerHTML = nextHtml;
  }

  const scoreEl = el.querySelector('.v-score');
  if (scoreEl) {
    const txt = `${Math.round((it.score || 0) * 100)} / 100`;
    if (scoreEl.textContent !== txt) scoreEl.textContent = txt;
  }

  const volEl = el.querySelector('.v-vol24');
  if (volEl) {
    const n = Number(it.volume?.h24 ?? 0);
    const txt = n >= 1000 ? '$' + Intl.NumberFormat(undefined,{notation:'compact'}).format(n) : (n>0? ('$'+n.toFixed(2)):'$0');
    if (volEl.textContent !== txt) volEl.textContent = txt;
  }

  const liqEl = el.querySelector('.v-liq');
  if (liqEl) {
    const n = Number(it.liquidityUsd ?? 0);
    const txt = n >= 1000 ? '$' + Intl.NumberFormat(undefined,{notation:'compact'}).format(n) : (n>0? ('$'+n.toFixed(2)):'$0');
    if (liqEl.textContent !== txt) liqEl.textContent = txt;
  }

  const fdvEl = el.querySelector('.v-fdv');
  if (fdvEl) {
    const n = Number(it.fdv);
    const txt = Number.isFinite(n) ? (n >= 1000 ? '$' + Intl.NumberFormat(undefined,{notation:'compact'}).format(n) : '$'+n.toFixed(2)) : '—';
    if (fdvEl.textContent !== txt) fdvEl.textContent = txt;
  }

  const sparkWrap = el.querySelector('[data-spark]');
  if (sparkWrap) {
    const chg = Array.isArray(it._chg) ? it._chg : [];
    const spark = typeof sparklineSVG === 'function' ? sparklineSVG(chg, { w: 160, h: 28 }) : '';
    if (sparkWrap.innerHTML !== spark) sparkWrap.innerHTML = spark;
  }

  const micro = el.querySelector('[data-micro]');
  if (micro) {
    const chg = Array.isArray(it._chg) ? it._chg : [];
    const chips = typeof pctChipsHTML === 'function' ? pctChipsHTML(chg) : '';
    const chipsWrap = micro.querySelector('[data-micro-chips]');
    if (chipsWrap) {
      if (chipsWrap.innerHTML !== chips) chipsWrap.innerHTML = chips;
    } else {
      // Fallback for older markup
      if (micro.innerHTML !== chips) micro.innerHTML = chips;
    }
  }
}

export function buildOrUpdateCard(existing, token) {
  if (!existing) {
    const el = document.createElement('div');
    el.className = 'card';
    el.dataset.key = token.mint || token.id;
    el.innerHTML = coinCard(token);
    // attachFavorite(el, token);
    el.classList.add('is-entering');
    el.style.opacity = '0';
    el.style.transform = 'translateY(10px) scale(.98)';
    el.style.willChange = 'transform,opacity';
    return el;
  }
  updateCardDOM(existing, token);
  // attachFavorite(existing, token);
  existing.style.willChange = 'transform,opacity';
  existing.classList.remove('is-exiting');
  return existing;
}

export function patchKeyedGridAnimated(container, nextItems, keyFn, buildFn) {
  if (!container) return;
  const prevY = window.scrollY;

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
    el = buildFn(el, it);

    if (i === 0) el.classList.add('is-leader'); else el.classList.remove('is-leader');
    el.style.setProperty('--rank', i);

    frag.appendChild(el);
  }

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

  // New cards may have new mints; hydrate like counts lazily.
  _scheduleLikeHydrate(container);

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