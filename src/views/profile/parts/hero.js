import { createSendFavoriteButton, createOpenLibraryButton } from "../../widgets/library.js";
import { wireNavigation, wireCopy } from "../render/interactions.js";
import { FALLBACK_LOGO } from "../../../config/env.js";
import { createSwapButton } from "../../widgets/swap.js";

export function initHero({ token, scored, mint, onBack }) {
  const elApp = document.getElementById("app");
  if (!elApp) return;

  // Logo & title
  const logo = token.imageUrl || FALLBACK_LOGO(token.symbol);
  const media = elApp.querySelector(".profile__hero .media");
  if (media) media.innerHTML = `<img class="logo" src="${logo}" alt="">`;
  const title = elApp.querySelector(".profile__hero .title");
  if (title) title.textContent = token.symbol || "Token";

  // Back navigation 
  wireNavigation({ onBack });
  wireCopy(mint);

  // Open Library button
  try {
    const backBox = elApp.querySelector(".profile__hero .backBox");
    if (backBox) {
      let openBtn = document.getElementById("btnOpenLibrary") || backBox.querySelector('[data-open-library]');
      if (!openBtn) {
        openBtn = createOpenLibraryButton({ label: "📚", className: "btn btn-ghost" });
        openBtn.id = "btnOpenLibrary";
      }
      if (openBtn.parentElement !== backBox) backBox.prepend(openBtn);
      openBtn.className = "btn btn-ghost";
      openBtn.style.border = "none";
      openBtn.style.fontSize = "1.4em";
      openBtn.style.marginBottom = "15px";
    }
  } catch {}

  // Favorite
  try {
    const extra = elApp.querySelector(".profile__hero .extraFeat");
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

  // Swap button
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
    let swapBtn = document.getElementById("btnSwapAction");
    if (!swapBtn) {
      swapBtn = createSwapButton({ mint, label: "Swap", className: "btn btn--primary btn-ghost" });
      swapBtn.id = "btnSwapAction";
      swapBtn.setAttribute("data-open-swap", "");
      const actions = elApp.querySelector(".profile__navigation .actions");
      if (actions) actions.prepend(swapBtn);
    } else {
      swapBtn.setAttribute("data-open-swap", "");
    }
    swapBtn.dataset.tokenHydrate = JSON.stringify(hydrate);
    if (token.headlineUrl) swapBtn.dataset.pairUrl = token.headlineUrl; else swapBtn.removeAttribute("data-pair-url");
  } catch {}

  // Shill promote button
  try {
    const actions = elApp.querySelector(".extraFeat");
    if (actions && !document.getElementById("btnShill")) {
      const a = document.createElement("a");
      a.id = "btnShill";
      a.className = "btn btn-ghost";
      a.setAttribute("data-link", "");
      a.href = `/shill?mint=${encodeURIComponent(mint)}`;
      a.textContent = "Promote";
      actions.appendChild(a);
    }
  } catch {}
}