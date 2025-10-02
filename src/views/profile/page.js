import { BUY_RULES, FDV_LIQ_PENALTY } from "../../config/env.js";
import { fetchTokenInfo, fetchTokenInfoLive } from "../../data/dexscreener.js";
import { scoreAndRecommendOne } from "../../core/calculate.js";
import sanitizeToken from "./sanitizeToken.js";
import renderShell from "./render/shell.js";
import { loadAds, pickAd, adCard } from "../../ads/load.js";
import { initSwap, bindSwapButtons } from "../widgets/swap.js";
import { bindFavoriteButtons } from "../widgets/library.js";

// Parts Refactor 2025
import { initHero } from "./parts/hero.js";
import { initStatsAndCharts } from "./parts/stats.js";
import { startProfileFeed } from "./parts/feed.js";
import { startProfileMetrics } from "../../analytics/shill.js";

function errorNotice(mount, msg) {
  mount.innerHTML = `<div class="wrap"><div class="small">Error: ${msg} <a data-link href="/">Home</a></div></div>`;
}

const tokenCache = window.__tokenCache || (window.__tokenCache = new Map());

const runIdle = (fn) => {
  if (typeof requestIdleCallback === "function") {
    requestIdleCallback(() => { try { fn(); } catch {} }, { timeout: 1500 });
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
    style.href = "/src/styles/profile.css";
    document.head.appendChild(style);
  }

  const mint = typeof input === "string" ? input : input?.mint;
  if (!mint) return errorNotice(elApp, "Token not found.");

  const isSame = lastRenderedMint === mint;
  lastRenderedMint = mint;

  try {
    if (!window.__fdvSwapBridge) window.__fdvSwapBridge = { inited: false };
    if (!window.__fdvSwapBridge.inited) {
      initSwap();
      bindSwapButtons(document);
      window.__fdvSwapBridge.inited = true;
    }
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

  renderShell({ mount: elApp, mint, adHtml: "" });

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
    }
  }).catch(() => {});

  runIdle(() => {
    try { bindFavoriteButtons(document); } catch {}


    (async () => {
      try {
        const { mountGiscus } = await import("./chat.js");
        mountGiscus({ mint });
      } catch {}
    })();

    try { startProfileMetrics({ mint }); } catch {}
  });

  setTimeout(() => {
    try {
      startProfileFeed({ mint, initial: token, fetchTokenInfoLive, scoreAndRecommendOne, statsCtx });
    } catch {}
  }, isSame ? 50 : 0); 
}
