import { createSendFavoriteButton, createOpenLibraryButton } from "../../addons/library/index.js";
import { wireNavigation, wireCopy } from "../render/interactions.js";
import { FALLBACK_LOGO } from "../../../config/env.js";
import { appPath } from "../../../config/base.js";
import { buildSocialLinksHtml } from "../../../lib/socialBuilder.js";
import { getTokenLogoPlaceholder, queueTokenLogoLoad } from "../../../core/ipfs.js";

export function initHero({ token, scored, mint, onBack }) {
  const root =
    document.getElementById('fdvProfileOverlayMount') ||
    document.getElementById('fdvProfileOverlay') ||
    document.getElementById('app') ||
    document;

  // Logo & title
  const rawLogo = token.imageUrl || "";
  const sym = token.symbol || token.name || "";
  const logo = getTokenLogoPlaceholder(rawLogo, sym) || FALLBACK_LOGO(token.symbol);
  const media = root.querySelector(".profile__hero .media");
  if (media) {
    media.innerHTML = `<img class="logo" src="${logo}" data-logo-raw="${rawLogo}" data-sym="${sym}" alt="">`;
    try {
      const img = media.querySelector("img.logo");
      if (img) queueTokenLogoLoad(img, rawLogo, sym);
    } catch {}
  }
  const title = root.querySelector(".profile__hero .title");
  if (title) title.textContent = token.symbol || "Token";

  // Back navigation 
  wireNavigation({ onBack });
  wireCopy(mint);

  try {
    const actions = root.querySelector(".profile__navigation .actions");
    if (actions) {
      let openBtn = document.getElementById("btnOpenLibrary") || actions.querySelector('[data-open-library]');
      if (!openBtn) {
        openBtn = createOpenLibraryButton({ label: "Library", className: "btn btn-ghost" });
        openBtn.id = "btnOpenLibrary";
      }
      const shareBtn = actions.querySelector("#btnCopyMint");
      if (openBtn.parentElement !== actions) {
        if (shareBtn && shareBtn.nextSibling) actions.insertBefore(openBtn, shareBtn.nextSibling);
        else if (shareBtn) actions.appendChild(openBtn);
        else actions.prepend(openBtn);
      }
      openBtn.textContent = "Library";
      openBtn.setAttribute("aria-label", "Open library");
      openBtn.className = "btn btn-ghost";
      openBtn.style.marginBottom = "";
    }
  } catch {}

  // Favorite
  try {
    const extra = root.querySelector(".profile__hero .extraFeat");
    if (extra && !extra.querySelector(`[data-fav-send][data-mint="${mint}"]`)) {
      const favBtn = createSendFavoriteButton({
        mint,
        symbol: token.symbol || "",
        name: token.name || "",
        imageUrl: logo || "",
        className: "fdv-lib-btn"
      });
      extra.prepend(favBtn);
    }
  } catch {}

  // Social icons (idempotent; rebuild only if mint changed)
  try {
    const socials = root.querySelector(".profile__links");
    socials.innerHTML = buildSocialLinksHtml(token, mint);
    socials.dataset.mint = mint;
  } catch {}

  // Headline trade button
  const tradeTop = document.getElementById("btnTradeTop");
  if (tradeTop) {
    if (token.headlineUrl) {
      tradeTop.href = token.headlineUrl;
      tradeTop.classList.remove("disabled");
    } else {
      tradeTop.remove();
    }
  }

  // Hold button (replaces Swap): jumps back home and opens Hold bot prefilled
  try {
    const hydrate = {
      mint,
      symbol: token.symbol,
      name: token.name,
      imageUrl: token.imageUrl,
      headerUrl: token.headerUrl,
      priceUsd: token.priceUsd,
      v24hTotal: token.v24hTotal,
      liquidityUsd: token.liquidityUsd,
      fdv: token.fdv ?? token.marketCap,
      marketCap: token.marketCap ?? token.fdv,
      headlineUrl: token.headlineUrl,
      headlineDex: token.headlineDex,
    };

  // Remove any old swap button if present.
  try {
    const old = document.getElementById("btnSwapAction");
    old?.remove?.();
  } catch {}

  let holdBtn = document.getElementById("btnHoldAction");
  if (!holdBtn) {
    holdBtn = document.createElement("button");
    holdBtn.type = "button";
    holdBtn.id = "btnHoldAction";
    holdBtn.className = "btn btn--primary btn-ghost";
    holdBtn.textContent = "Hold";
    const actions = root.querySelector(".profile__navigation .actions");
    if (actions) actions.prepend(holdBtn);
  }

  // Store open request for the home page to consume.
  holdBtn.dataset.mint = mint;
  holdBtn.dataset.tokenHydrate = JSON.stringify(hydrate);

  holdBtn.onclick = (e) => {
    e?.preventDefault?.();
    try {
      localStorage.setItem(
        "fdv_hold_open_request_v1",
        JSON.stringify({ mint, tokenHydrate: hydrate, start: false }),
      );
    } catch {}
    try {
      // Ensure Auto panel is visible after navigation.
      location.href = `${appPath('')}?automate=1`;
    } catch {}
  };
  } catch {}

  // Shill promote button
  // try {
  //   const actions = root.querySelector(".extraFeat");
  //   if (actions && !document.getElementById("btnShill")) {
  //     const a = document.createElement("a");
  //     a.id = "btnShill";
  //     a.className = "btn btn-ghost";
  //     a.setAttribute("data-link", "");
  //     a.href = `/shill?mint=${encodeURIComponent(mint)}`;
  //     a.textContent = "Metrics";
  //     a.disabled = true;
  //     actions.appendChild(a);
  //   }
  // } catch {}
}