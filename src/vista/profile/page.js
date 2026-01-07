import { BUY_RULES, FDV_LIQ_PENALTY } from "../../config/env.js";
import { fetchTokenInfo, fetchTokenInfoLive } from "../../data/dexscreener.js";
import { scoreAndRecommendOne } from "../../core/calculate.js";
import sanitizeToken from "./sanitizeToken.js";
import renderShell from "./render/shell.js";
import { loadAds, pickAd, adCard, initAdBanners } from "../../ads/load.js";

import { widgets, registerCoreWidgets, prewarmDefaults } from "../widgets/loader.js";

import { initHero } from "./parts/hero.js";
import { initStatsAndCharts } from "./parts/stats.js";
import { startProfileFeed } from "./parts/feed.js";
import { autoStartProfileMetrics } from "../../analytics/shill.js";

try { registerCoreWidgets(); } catch {}
try { prewarmDefaults(); } catch {}
try {
  widgets.register('swap', {
    importer: () => import('../widgets/swap/index.js'),
    init: ({ mod }) => {
      if (typeof mod.initSwap === 'function') mod.initSwap();
      if (typeof mod.bindSwapButtons === 'function') mod.bindSwapButtons(document);
    },
    eager: true,
    once: true,
  });
} catch {}
try {
  widgets.register('favorites-bind', {
    importer: () => import('../widgets/library/index.js'),
    init: ({ mod }) => {
      if (typeof mod.bindFavoriteButtons === 'function') mod.bindFavoriteButtons(document);
    },
    once: true,
  });
} catch {}

function errorNotice(mount, msg) {
  mount.innerHTML = `<div class="wrap"><div class="small">Error: ${msg} <a data-link href="/">Home</a></div></div>`;
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

export async function renderProfileView(input, { onBack } = {}) {
  const elApp = document.getElementById("app");
  if (!elApp) return;
  const elHeader = document.querySelector(".header");
  if (elHeader) elHeader.style.display = "none";

  if (!document.querySelector('link[href="/src/styles/profile.css"]')) {
    const style = document.createElement("link");
    style.rel = "stylesheet";
    style.href = "/src/assets/styles/profile/profile.css";
    document.head.appendChild(style);
  }

  if (!document.querySelector('link[href="/src/assets/styles/shill.css"]')) {
    const style = document.createElement("link");
    style.rel = "stylesheet";
    style.href = "/src/assets/styles/shill/shill.css";
    document.head.appendChild(style);
  }

  const mint = typeof input === "string" ? input : input?.mint;
  if (!mint) return errorNotice(elApp, "Token not found.");

  const isSame = lastRenderedMint === mint;
  lastRenderedMint = mint;

  try {
    await widgets.mount('swap');
  } catch {}

  const adsPromise = (async () => {
    try {
      const ads = await loadAds();
      const picked = pickAd(ads);
      return picked ? adCard(picked) : "";
    } catch {
      return "";
    }
  })();

  renderShell({ mount: elApp, mint, adHtml: await adsPromise });

  let raw;
  try {
    if (tokenCache.has(mint)) {
      raw = tokenCache.get(mint);
    } else {
      raw = await fetchTokenInfo(mint);
      if (raw && !raw.error) tokenCache.set(mint, raw);
    }
    if (raw?.error) return errorNotice(elApp, raw.error);
  } catch {
    window.location.href = "https://jup.ag/tokens/" + encodeURIComponent(mint);
    return;
  }

  const token = sanitizeToken(raw);
  const scored = scoreAndRecommendOne(token);

  initHero({ token, scored, mint, onBack });

  const statsCtx = initStatsAndCharts({ token, scored, BUY_RULES, FDV_LIQ_PENALTY });

  adsPromise.then((adHtml) => {
    if (!adHtml) return;
    const adSlot = document.querySelector("[data-ad-slot], .ad-slot, #ad-slot");
    if (adSlot && !adSlot.__filled) {
      adSlot.innerHTML = adHtml;
      adSlot.__filled = true;
      try { initAdBanners(adSlot); } catch {}
    }
  }).catch(() => {});

  runIdle(() => {
    try { widgets.mount('favorites-bind'); } catch {}

    (async () => {
      try {
        const { mountGiscus } = await import("../widgets/chat/chat.js");
        mountGiscus({ mint });
      } catch {}
    })();
    try { autoStartProfileMetrics({ mint }); } catch {}
  });

  setTimeout(() => {
    try {
      startProfileFeed({ mint, initial: token, fetchTokenInfoLive, scoreAndRecommendOne, statsCtx });
    } catch {}
  }, isSame ? 50 : 0); 
}
