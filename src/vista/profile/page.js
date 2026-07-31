import { BUY_RULES, FDV_LIQ_PENALTY, GISCUS } from "../../config/env.js";
import { appPath } from "../../config/base.js";
import { fetchTokenInfo, fetchTokenInfoLive } from "../../data/dexscreener.js";
import { scoreAndRecommendOne } from "../../core/calculate.js";
import sanitizeToken from "./sanitizeToken.js";
import renderShell, { sanitizeAdHtml } from "./render/shell.js";
import { loadAds, pickAd, adCard, initAdBanners } from "../../ads/load.js";

import { widgets, registerCoreWidgets, prewarmDefaults } from "../addons/loader.js";

import { initHero } from "./parts/hero.js";
import { initStatsAndCharts } from "./parts/stats.js";
import { startProfileFeed, stopProfileFeed } from "./parts/feed.js";
import { mountProfileKpiMetrics } from "./render/kpiMetrics.js";
import { mountGiscusDirect, unmountGiscusDirect } from "../addons/chat/chat.js";

try { registerCoreWidgets(); } catch {}
try { prewarmDefaults(); } catch {}
try {
  widgets.register('swap', {
    importer: () => import('../addons/auto/swap/index.js'),
    init: ({ mod }) => {
      if (window.__fdvSwapSystemInited) return;
      window.__fdvSwapSystemInited = 1;
      if (typeof mod.initSwapSystem === 'function') mod.initSwapSystem();
      else if (typeof mod.initSwap === 'function') mod.initSwap();
    },
    mount: ({ mod, props }) => {
      const root = props?.root || document;
      if (typeof mod.bindSwapButtons === 'function') mod.bindSwapButtons(root);
    },
    once: false,
  });
} catch {}
try {
  widgets.register('favorites-bind', {
    importer: () => import('../addons/library/index.js'),
    init: () => {},
    mount: ({ mod, props }) => {
      const root = props?.root || document;
      if (typeof mod.bindFavoriteButtons === 'function') mod.bindFavoriteButtons(root);
    },
    once: false,
  });
} catch {}

function errorNotice(mount, msg) {
  setProfileOverlayZIndex(9999);

  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (ch) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  }[ch] || ch));

  const safeMsg = esc(msg || 'Unknown error');

  mount.innerHTML = `
    <div id="fdvProfileErrorBackdrop" style="position:fixed;inset:0;z-index:9200;display:grid;place-items:center;padding:18px;background:color-mix(in srgb, var(--bg, #050607) 92%, transparent);backdrop-filter: blur(2px);-webkit-backdrop-filter: blur(2px);">
      <div role="alert" aria-live="assertive" style="width:min(92vw,560px);border:1px solid var(--border, rgba(128,255,205,.22));border-radius:16px;background:linear-gradient(180deg,color-mix(in srgb, var(--panel, #0a0e0c) 92%, transparent),color-mix(in srgb, var(--panel2, #0a1410) 98%, transparent));box-shadow:var(--shadow-2, 0 18px 55px rgba(0,0,0,.55));padding:16px 16px 14px;">
        <div style="font-weight:900;letter-spacing:.2px;margin:0 0 8px 0;">Token data unavailable</div>
        <div class="small" style="opacity:.92;line-height:1.5;">${safeMsg}</div>
        <div class="small" style="opacity:.72;margin-top:10px;">Tip: Sometimes this data is temporarily unavailable. Try again in a few moments.</div>
        <div style="display:flex;gap:10px;flex-wrap:wrap;align-items:center;justify-content:flex-end;margin-top:14px;">
          <button id="fdvProfileErrorBackBtn" class="btn" type="button">Back</button>
        </div>
      </div>
    </div>
  `;
}

const tokenCache = window.__tokenCache || (window.__tokenCache = new Map());

const runIdle = (fn) => {
  if (typeof requestIdleCallback === "function") {
    requestIdleCallback(() => { try { fn(); } catch {} }, { timeout: 100 });
  } else {
    setTimeout(() => { try { fn(); } catch {} }, 0);
  }
};

let lastRenderedMint = null;

let __fdvProfileOverlay = null;
let __fdvProfilePrevHtmlOverflow = null;
let __fdvProfilePrevHeaderDisplay = null;
let __fdvProfileChatMounted = false;
const PROFILE_CHAT_MOUNT_ID = "fdvProfileChatMount";

function emitProfileOverlayState(open) {
  try {
    const detail = { open: !!open };
    if (typeof window !== "undefined" && typeof window.dispatchEvent === "function") {
      try {
        window.dispatchEvent(new CustomEvent("fdv:profile-overlay-state", { detail }));
        return;
      } catch {}
      try {
        const ev = new Event("fdv:profile-overlay-state");
        try { ev.detail = detail; } catch {}
        window.dispatchEvent(ev);
      } catch {}
    }
  } catch {}
}

function mountProfileChat(overlayMount, mint) {
  try {
    const root = overlayMount || __fdvProfileOverlay || document;
    const m = String(mint || "").trim();
    if (!m) return;
    const chatEl = root?.querySelector?.("#chatMount") || root?.querySelector?.(`#${PROFILE_CHAT_MOUNT_ID}`) || document.getElementById("chatMount");
    if (!chatEl) return;

    try {
      if (chatEl.id !== PROFILE_CHAT_MOUNT_ID) chatEl.id = PROFILE_CHAT_MOUNT_ID;
    } catch {}

    try { unmountGiscusDirect({ containerId: PROFILE_CHAT_MOUNT_ID }); } catch {}

    mountGiscusDirect({
      mint: m,
      containerId: PROFILE_CHAT_MOUNT_ID,
      theme: "dark",
      mapping: "specific",
      loading: "eager",
      force: true,
      showMissingHint: true,
    });
    __fdvProfileChatMounted = true;
  } catch {}
}

function setProfileOverlayZIndex(z) {
  try {
    const el = __fdvProfileOverlay || document.getElementById('fdvProfileOverlay');
    if (el) el.style.zIndex = String(z);
  } catch {}
}

function ensureProfileOverlay() {
  if (__fdvProfileOverlay && __fdvProfileOverlay.isConnected) return __fdvProfileOverlay;

  const el = document.createElement('div');
  el.id = 'fdvProfileOverlay';
  el.className = 'fdv-profile-overlay';
  el.setAttribute('role', 'dialog');
  el.setAttribute('aria-modal', 'true');
  el.innerHTML = `<div class="fdv-profile-overlay__inner container grid" id="fdvProfileOverlayMount"></div>`;
  document.body.appendChild(el);

  // Critical fallback
  try {
    el.style.position = 'fixed';
    el.style.inset = '0';
    el.style.zIndex = '9000';
    el.style.overflow = 'auto';
    el.style.background = 'var(--bg)';
  } catch {}

  __fdvProfileOverlay = el;
  return el;
}

export function closeProfileOverlay() {
  const el = __fdvProfileOverlay;
  if (!el) return;

  try { stopProfileFeed(); } catch {}
  try {
    if (__fdvProfileChatMounted || document.getElementById(PROFILE_CHAT_MOUNT_ID)) {
      unmountGiscusDirect({ containerId: PROFILE_CHAT_MOUNT_ID });
    }
  } catch {}
  __fdvProfileChatMounted = false;
  try { setProfileOverlayZIndex(9000); } catch {}

  try { el.remove(); } catch {}
  __fdvProfileOverlay = null;
  try { emitProfileOverlayState(false); } catch {}

  try {
    if (__fdvProfilePrevHtmlOverflow != null) document.documentElement.style.overflow = __fdvProfilePrevHtmlOverflow;
    __fdvProfilePrevHtmlOverflow = null;
  } catch {}

  try {
    const header = document.querySelector('.header');
    if (header) header.style.display = (__fdvProfilePrevHeaderDisplay ?? '');
    __fdvProfilePrevHeaderDisplay = null;
  } catch {}
}

function wireSwipeBack(overlayEl, { onBack } = {}) {
  if (!overlayEl || overlayEl.__fdvSwipeWired) {
    try { overlayEl.__fdvOnBack = onBack; } catch {}
    return;
  }

  overlayEl.__fdvSwipeWired = true;
  overlayEl.__fdvOnBack = onBack;
  overlayEl.__fdvSwipe = { active: false, startX: 0, startY: 0, pointerId: null, dx: 0, dy: 0 };

  overlayEl.addEventListener('pointerdown', (e) => {
    try {
      if (!e || e.button != null && e.button !== 0) return;
      if (e.pointerType && e.pointerType !== 'touch') return;

      // Only treat as a swipe-back if it starts near the left edge.
      if (e.clientX > 28) return;

      // Don't hijack interactions.
      const t = e.target;
      if (t && t.closest?.('a,button,input,textarea,select,label,[data-swipe-ignore]')) return;

      const st = overlayEl.__fdvSwipe;
      st.active = true;
      st.startX = e.clientX;
      st.startY = e.clientY;
      st.pointerId = e.pointerId;
      st.dx = 0;
      st.dy = 0;

      try { overlayEl.setPointerCapture?.(e.pointerId); } catch {}
    } catch {}
  }, { passive: true });

  overlayEl.addEventListener('pointermove', (e) => {
    const st = overlayEl.__fdvSwipe;
    if (!st?.active) return;
    st.dx = e.clientX - st.startX;
    st.dy = e.clientY - st.startY;
  }, { passive: true });

  const end = () => {
    const st = overlayEl.__fdvSwipe;
    if (!st?.active) return;
    st.active = false;

    const dx = st.dx;
    const dy = st.dy;
    st.dx = 0;
    st.dy = 0;

    // Swipe right: go back.
    if (dx > 90 && Math.abs(dy) < 60) {
      const fn = overlayEl.__fdvOnBack;
      if (typeof fn === 'function') {
        try { fn(); } catch {}
      } else {
        try { if (history.length > 1) history.back(); else window.location.href = appPath(''); } catch {}
      }
    }
  };

  overlayEl.addEventListener('pointerup', end, { passive: true });
  overlayEl.addEventListener('pointercancel', end, { passive: true });
}

export async function renderProfileView(input, { onBack } = {}) {
  const elApp = document.getElementById("app");
  if (!elApp) return;
  const elHeader = document.querySelector(".header");
  if (elHeader) {
    try { __fdvProfilePrevHeaderDisplay = elHeader.style.display; } catch {}
    elHeader.style.display = "none";
  }

  const overlay = ensureProfileOverlay();
  setProfileOverlayZIndex(9000);
  try { emitProfileOverlayState(true); } catch {}
  const overlayMount = overlay.querySelector('#fdvProfileOverlayMount') || overlay;

  try {
    __fdvProfilePrevHtmlOverflow = document.documentElement.style.overflow;
    document.documentElement.style.overflow = 'hidden';
  } catch {}

  // Ensure back/swipe use SPA when possible.
  const backFn = typeof onBack === 'function'
    ? onBack
    : () => {
        try { closeProfileOverlay(); } catch {}
        try {
          history.replaceState({}, '', appPath(''));
          try { window.dispatchEvent(new PopStateEvent('popstate')); }
          catch { try { window.dispatchEvent(new Event('popstate')); } catch {} }
        } catch {
          try { window.location.href = appPath(''); } catch {}
        }
      };
  wireSwipeBack(overlay, { onBack: backFn });

  // (styles are mounted above; no-op here)

  const mint = typeof input === "string" ? input : input?.mint;
  if (!mint) {
    errorNotice(overlayMount, "Token not found.");
    try {
      const btn = overlayMount.querySelector('#fdvProfileErrorBackBtn');
      if (btn) btn.addEventListener('click', () => { try { backFn(); } catch {} }, { once: true });
      const a = overlayMount.querySelector('#fdvProfileErrorBackLink');
      if (a) a.addEventListener('click', (e) => { try { e.preventDefault(); } catch {} try { backFn(); } catch {} }, { once: true });
      const bd = overlayMount.querySelector('#fdvProfileErrorBackdrop');
      if (bd) bd.addEventListener('click', (e) => { try { if (e && e.target === bd) backFn(); } catch {} }, { passive: true });
    } catch {}
    return;
  }

  const isSame = lastRenderedMint === mint;
  lastRenderedMint = mint;

  const adsPromise = (async () => {
    try {
      const ads = await loadAds();
      const picked = pickAd(ads);
      return picked ? adCard(picked) : "";
    } catch {
      return "";
    }
  })();

  renderShell({ mount: overlayMount, mint, adHtml: "" });
  try { mountProfileChat(overlayMount, mint); } catch {}

  // Render KPI table immediately (best-effort from localStorage),
  // so the user doesn't land on a persistent "Loading…" row.
  try { mountProfileKpiMetrics({ mint }); } catch {}

  // Bind feature widgets to the freshly-rendered overlay DOM.
  try { widgets.mount('favorites-bind', { root: overlayMount }).catch(() => {}); } catch {}
  try { widgets.mount('swap', { root: overlayMount }).catch(() => {}); } catch {}

  // Fill optional ad HTML after shell render (sanitized).
  adsPromise.then((adHtml) => {
    if (!adHtml) return;
    const adSlot = overlayMount.querySelector('#adMount') || overlayMount.querySelector('[data-ad-slot], .ad-slot, #ad-slot');
    if (adSlot && !adSlot.__filled) {
      try { adSlot.innerHTML = sanitizeAdHtml(adHtml); } catch {}
      adSlot.__filled = true;
      try { initAdBanners(adSlot); } catch {}
    }
  }).catch(() => {});

  runIdle(() => {
    try {
      widgets.prewarm('swap', { idle: false }).catch(() => {});
    } catch {}
  });

  let raw;
  try {
    if (tokenCache.has(mint)) {
      raw = tokenCache.get(mint);
    } else {
      raw = await fetchTokenInfo(mint);
      if (raw && !raw.error) tokenCache.set(mint, raw);
    }
    if (raw?.error) {
      errorNotice(overlayMount, raw.error);
      try {
        const btn = overlayMount.querySelector('#fdvProfileErrorBackBtn');
        if (btn) btn.addEventListener('click', () => { try { backFn(); } catch {} }, { once: true });
        const a = overlayMount.querySelector('#fdvProfileErrorBackLink');
        if (a) a.addEventListener('click', (e) => { try { e.preventDefault(); } catch {} try { backFn(); } catch {} }, { once: true });
        const bd = overlayMount.querySelector('#fdvProfileErrorBackdrop');
        if (bd) bd.addEventListener('click', (e) => { try { if (e && e.target === bd) backFn(); } catch {} }, { passive: true });
      } catch {}
      return;
    }
  } catch {
    try {
      await widgets.mount('swap');
      const mod = await import('../addons/auto/swap/index.js');
      if (typeof mod.initSwapSystem === 'function') mod.initSwapSystem();
      if (typeof mod.openSwapModal === 'function') {
        await mod.openSwapModal({ outputMint: mint, noFetch: true });
      }
    } catch {}
    // TODO: center error notices in the middle of the screen instead of inside the profile shell, since if we got here it likely means the shell failed to load/render properly. For now just link to Home as a fallback.
    errorNotice(overlayMount, "Token data unavailable. You can still swap by mint.");
    try {
      const btn = overlayMount.querySelector('#fdvProfileErrorBackBtn');
      if (btn) btn.addEventListener('click', () => { try { backFn(); } catch {} }, { once: true });
      const a = overlayMount.querySelector('#fdvProfileErrorBackLink');
      if (a) a.addEventListener('click', (e) => { try { e.preventDefault(); } catch {} try { backFn(); } catch {} }, { once: true });
      const bd = overlayMount.querySelector('#fdvProfileErrorBackdrop');
      if (bd) bd.addEventListener('click', (e) => { try { if (e && e.target === bd) backFn(); } catch {} }, { passive: true });
    } catch {}
    return;
  }

  const token = sanitizeToken(raw);
  const scored = scoreAndRecommendOne(token);

  initHero({ token, scored, mint, onBack: backFn });

  const statsCtx = initStatsAndCharts({ token, scored, BUY_RULES, FDV_LIQ_PENALTY, mint });

  // (adsPromise is handled above to avoid blocking initial shell)

  runIdle(() => {
    try { widgets.mount('favorites-bind', { root: overlayMount }).catch(() => {}); } catch {}
  });

  setTimeout(() => {
    try {
      startProfileFeed({ mint, initial: token, fetchTokenInfoLive, scoreAndRecommendOne, statsCtx });
    } catch {}
  }, isSame ? 50 : 0); 
}
