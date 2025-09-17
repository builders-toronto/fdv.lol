import { FALLBACK_LOGO, BUY_RULES, FDV_LIQ_PENALTY } from "../../config/env.js";
import { fetchTokenInfo } from "../../data/dexscreener.js";
import { scoreAndRecommendOne } from "../../core/calculate.js";
import { mountGiscus } from "../meme/chat.js";

import sanitizeToken from "./sanitizeToken.js";
import renderShell from "./render/shell.js";
import { buildStatsGrid, setStat, setStatHtml } from "./render/statsGrid.js";
import { setStatStatusByKey } from "./render/statuses.js";
import { renderBarChart } from "./render/charts.js";
import renderLinks from "./render/links.js";
import mountRecommendationPanel from "./render/recommendation.js";
import { fmtMoney, fmtNum, pill, cssReco } from "./formatters.js";
import { renderPairsTable } from "./render/pairsTable.js";
import {
  wireNavigation,
  wireCopy,
  wireStatsResizeAutoShortLabels,
  setupStatsCollapse,
  setupExtraMetricsToggle,
} from "./render/interactions.js";
import { loadAds, pickAd, adCard } from "../../ads/load.js";

function errorNotice(mount, msg) {
  mount.innerHTML = `<div class="wrap"><div class="small">Error: ${msg} <a data-link href="/">Home</a></div></div>`;
}

// TODO: scale gecko implementation
function ensureGeckoStyles() {
  if (document.getElementById("gecko-embed-styles")) return;
  const s = document.createElement("style");
  s.id = "gecko-embed-styles";
  s.textContent = `
    .profile__gecko { margin: 12px 0 8px; background: transparent; border: none; padding: 0; }
    .profile__gecko .profile__module__header {
      display:flex; justify-content:space-between; align-items:center; gap:8px; margin-bottom:6px;
    }
    .profile__gecko .profile__module__title { font-size: 14px; line-height: 1.2; margin:0; }
    .profile__gecko .small.muted { opacity: 0.7; font-size: 12px; }
    .gecko__framewrap { width: 100%; position: relative; }
    /* Smaller default aspect; looks good in tight spaces */
    .gecko__framewrap { aspect-ratio: 16 / 10; min-height: 220px; max-height: 420px; }
    .gecko__framewrap > iframe { position: absolute; inset: 0; width: 100%; height: 100%; border: 0; }
    /* Compact on narrow screens */
    @media (max-width: 900px) {
      .gecko__framewrap { aspect-ratio: 16 / 11; min-height: 200px; max-height: 360px; }
      .profile__gecko .profile__module__title { font-size: 13px; }
    }
    @media (max-width: 600px) {
      .gecko__framewrap { aspect-ratio: 16 / 12; min-height: 480px; max-height: 500px; }
    }
  `;
  document.head.appendChild(s);
}

function buildGeckoUrl({
  chain = "solana",
  kind = "tokens", 
  id, // mint or pool
  embed = 1,
  info = 0,
  swaps = 0,
  light_chart = 0,
  chart_type = "market_cap",
  resolution = "1m",
  bg_color = "000000",
} = {}) {
  if (!id) return null;
  const base = `https://www.geckoterminal.com/${chain}/${kind}/${encodeURIComponent(id)}`;
  const qs = new URLSearchParams({
    embed: String(embed),
    info: String(info),
    swaps: String(swaps),
    light_chart: String(light_chart),
    chart_type,
    resolution,
    bg_color,
  });
  return `${base}?${qs.toString()}`;
}

function mountOrUpdateGecko({ root, mint, pool = null, options = {} } = {}) {
  if (!root || (!mint && !pool)) return;

  ensureGeckoStyles();

  const id = pool || mint;
  const kind = pool ? "pools" : "tokens";
  const src = buildGeckoUrl({ id, kind, ...options });
  if (!src) return;

  // If already present, update src and bail (prevents "mounted twice")
  const existing = document.getElementById("geckoterminal-embed");
  if (existing) {
    if (existing.getAttribute("src") !== src) existing.setAttribute("src", src);
    return;
  }

  // Remove any stray previous containers if present
  document.querySelectorAll(".profile__gecko").forEach((n, i) => {
    if (i === 0) return;
    n.remove();
  });

  // Build section
  const section = document.createElement("section");
  section.className = "profile__module profile__gecko";
  section.innerHTML = `
    <div class="profile__module__header">
      <h3 class="profile__module__title">Market Chart</h3>
      <div class="small muted">${kind === "pools" ? "Pool view" : "Token view"} · GeckoTerminal</div>
    </div>
    <div class="gecko__framewrap">
      <iframe
        id="geckoterminal-embed"
        title="GeckoTerminal Embed"
        src="${src}"
        allow="clipboard-write"
        allowfullscreen
      ></iframe>
    </div>
  `;

  // Preferred placement: directly above the ad block if we can find it.
  const adMount = document.querySelector(".adcard") || null;
  if (adMount && adMount.parentElement) {
    adMount.parentElement.insertBefore(section, adMount);
  } else {
    const firstModule = root.querySelector(".profile__module");
    if (firstModule) {
      firstModule.parentElement.insertBefore(section, firstModule);
    } else {
      root.appendChild(section);
    }
  }
}

export async function renderProfileView(input, { onBack } = {}) {
  const elApp = document.getElementById("app");
  const elHeader = document.querySelector(".header");
  if (!elApp) return;

  // styles (defer/inline)
  const style = document.createElement("link");
  style.rel = "stylesheet";
  style.href = "/src/styles/profile.css";
  document.head.appendChild(style);

  const mint = typeof input === "string" ? input : input?.mint;
  if (!mint) {
    errorNotice(elApp, "Token not found.");
    return;
  }

  // Ads
  let CURRENT_AD = null;
  try {
    CURRENT_AD = pickAd(await loadAds());
  } catch {
    CURRENT_AD = null;
  }
  const adHtml = CURRENT_AD ? adCard(CURRENT_AD) : "";

  // Shell
  renderShell({ mount: elApp, mint, adHtml });

  const gridEl = document.getElementById("statsGrid");
  buildStatsGrid(gridEl);
  wireStatsResizeAutoShortLabels(gridEl);
  setupStatsCollapse(gridEl);
  const statsCollapseBtn = document.querySelector(".profile__stats-toggle");
  setupExtraMetricsToggle(document.querySelector(".profile__card__extra_metrics"));

  wireNavigation({ onBack });
  wireCopy(mint);

  // Data
  let raw;
  try {
    raw = await fetchTokenInfo(mint);
    if (raw.error) return errorNotice(elApp, raw.error);
  } catch (e) {
    console.warn("fetchTokenInfo failed:", e);
    window.location.href = "/";
    return;
  }
  const t = sanitizeToken(raw);
  const scored = scoreAndRecommendOne(t);

  if (elHeader) elHeader.style.display = "none";

  // Hero
  const logo = t.imageUrl || FALLBACK_LOGO(t.symbol);
  const media = elApp.querySelector(".profile__hero .media");
  if (media) media.innerHTML = `<img class="logo" src="${logo}" alt="">`;
  const title = elApp.querySelector(".profile__hero .title");
  if (title) title.textContent = t.symbol || "Token";
  const tradeTop = document.getElementById("btnTradeTop");
  if (tradeTop) {
    if (t.headlineUrl) {
      tradeTop.href = t.headlineUrl;
      tradeTop.classList.remove("disabled");
    } else {
      tradeTop.remove();
    }
  }

  // Stats values
  const PRICE_USD = Number.isFinite(t.priceUsd) ? `$${t.priceUsd.toFixed(6)}` : "—";
  setStat(gridEl, 0, PRICE_USD);
  setStat(gridEl, 1, fmtMoney(t.liquidityUsd));
  setStat(gridEl, 2, fmtMoney(t.fdv ?? t.marketCap));
  setStat(gridEl, 3, Number.isFinite(t.liqToFdvPct) ? `${t.liqToFdvPct.toFixed(2)}%` : "—");
  setStat(gridEl, 4, fmtMoney(t.v24hTotal));
  setStat(gridEl, 5, Number.isFinite(t.volToLiq24h) ? `${t.volToLiq24h.toFixed(2)}×` : "—");
  setStatHtml(gridEl, 6, pill(t.change5m));
  setStatHtml(gridEl, 7, pill(t.change1h));
  setStatHtml(gridEl, 8, pill(t.change6h));
  setStatHtml(gridEl, 9, pill(t.change24h));
  setStat(
    gridEl,
    10,
    (() => {
      const ms = t.ageMs;
      if (!Number.isFinite(ms) || ms < 1000) return "—";
      const s = Math.floor(ms / 1000);
      const u = [
        ["y", 31536000],
        ["mo", 2592000],
        ["d", 86400],
        ["h", 3600],
        ["m", 60],
        ["s", 1],
      ];
      for (const [label, div] of u) if (s >= div) return `${Math.floor(s / div)}${label}`;
      return "0s";
    })()
  );
  setStat(gridEl, 11, `${fmtNum(t.tx24h.buys)} / ${fmtNum(t.tx24h.sells)}`);
  setStat(gridEl, 12, Number.isFinite(t.buySell24h) ? `${(t.buySell24h * 100).toFixed(1)}% buys` : "—");

  // Status badges
  const LIQ_OK = Number.isFinite(t.liquidityUsd) && t.liquidityUsd >= BUY_RULES.liq;
  const VOL_OK = Number.isFinite(t.v24hTotal) && t.v24hTotal >= BUY_RULES.vol24;
  const CH1H_OK = Number.isFinite(t.change1h) && t.change1h > BUY_RULES.change1h;
  const liqToFdvPct = Number.isFinite(t.liqToFdvPct) ? t.liqToFdvPct : null;
  const minLiqPct = 100 / Math.max(FDV_LIQ_PENALTY.ratio, 1);
  const LIQFDV_OK = Number.isFinite(liqToFdvPct) ? liqToFdvPct >= minLiqPct : null;
  const CH6H_OK = Number.isFinite(t.change6h) ? t.change6h > 0 : null;
  const CH24H_OK = Number.isFinite(t.change24h) ? t.change24h > 0 : null;
  const VLIQR_OK = Number.isFinite(t.volToLiq24h) ? t.volToLiq24h >= 0.5 : null;
  const BUYR_OK = Number.isFinite(t.buySell24h) ? t.buySell24h >= 0.5 : null;

  setStatStatusByKey(gridEl, "liq", {
    ok: LIQ_OK,
    reason: LIQ_OK ? "Meets liquidity rule" : `Needs ≥ ${Intl.NumberFormat().format(BUY_RULES.liq)} liquidity`,
  });
  setStatStatusByKey(gridEl, "fdv", { ok: null });
  setStatStatusByKey(gridEl, "liqfdv", {
    ok: LIQFDV_OK,
    reason: LIQFDV_OK === null ? "" : LIQFDV_OK ? "FDV/Liq is balanced" : "FDV/Liq imbalance detected",
  });
  setStatStatusByKey(gridEl, "v24", {
    ok: VOL_OK,
    reason: VOL_OK ? "Meets 24h volume rule" : `Needs ≥ ${Intl.NumberFormat().format(BUY_RULES.vol24)} 24h volume`,
  });
  setStatStatusByKey(gridEl, "vliqr", {
    ok: VLIQR_OK,
    reason: VLIQR_OK === null ? "" : VLIQR_OK ? "Healthy 24h turnover vs liquidity" : "Low turnover vs liquidity",
  });
  setStatStatusByKey(gridEl, "d1h", {
    ok: CH1H_OK,
    reason: CH1H_OK ? "Positive 1h momentum" : `Needs > ${BUY_RULES.change1h.toFixed(2)}% 1h change`,
  });
  setStatStatusByKey(gridEl, "d6h", { ok: CH6H_OK, reason: CH6H_OK ? "Up over 6h" : "Down over 6h" });
  setStatStatusByKey(gridEl, "d24h", { ok: CH24H_OK, reason: CH24H_OK ? "Up over 24h" : "Down over 24h" });
  setStatStatusByKey(gridEl, "price", { ok: null });
  setStatStatusByKey(gridEl, "d5m", { ok: null });
  setStatStatusByKey(gridEl, "age", { ok: null });
  const txKnown = Number.isFinite(t?.tx24h?.buys) && Number.isFinite(t?.tx24h?.sells);
  const TX_OK = txKnown ? t.tx24h.buys + t.tx24h.sells > 0 : null;
  setStatStatusByKey(gridEl, "bs24", { ok: TX_OK, reason: TX_OK === null ? "" : TX_OK ? "24h trading present" : "No 24h trades" });
  setStatStatusByKey(gridEl, "buyratio", {
    ok: BUYR_OK,
    reason: BUYR_OK === null ? "" : BUYR_OK ? "Buy pressure ≥ 50%" : "Sell pressure ≥ 50%",
  });

  // Badge in hero
  const badgeWrap = elApp.querySelector(".profile__hero .row");
  if (badgeWrap) {
    badgeWrap.innerHTML = `<span class="badge ${cssReco(scored.recommendation)}">${scored.recommendation}</span>`;
  }

  // Recommendation panel
  mountRecommendationPanel(statsCollapseBtn, {
    scored,
    token: t,
    checks: { LIQFDV_OK, VLIQR_OK, BUYR_OK },
  });

  // Charts
  const mom = [t.change5m, t.change1h, t.change6h, t.change24h].map((x) => (Number.isFinite(x) ? Math.max(0, x) : 0));
  renderBarChart(document.getElementById("momBars"), mom, {
    height: 72,
    max: Math.max(5, ...mom),
    labels: ["5m", "1h", "6h", "24h"],
  });

  const vols = [t.v5mTotal, t.v1hTotal, t.v6hTotal, t.v24hTotal].map((x) => (Number.isFinite(x) ? x : 0));
  renderBarChart(document.getElementById("volBars"), vols, { height: 72, labels: ["5m", "1h", "6h", "24h"] });

  let primaryPool = null;
  try {
    primaryPool = t?.pairs?.[0]?.poolAddress || null;
  } catch {
    primaryPool = null;
  }
  // We love Gecko
  mountOrUpdateGecko({
    root: elApp,
    mint,
    pool: primaryPool,
    options: {
      info: 0,
      swaps: 0,
      light_chart: 0,
      chart_type: "market_cap", 
      resolution: "1m",         
      bg_color: "000000",
    },
  });

  renderPairsTable(document.getElementById("pairsBody"), t.pairs);

  // Chat
  mountGiscus({ mint });

  // Socials
  const linksMount = document.getElementById("profileLinks");
  if (linksMount) {
    renderLinks(linksMount, t.socials);
    if (!linksMount.innerHTML.trim()) linksMount.style.display = "none";
  }
}
