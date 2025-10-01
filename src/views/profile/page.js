import { FALLBACK_LOGO, BUY_RULES, FDV_LIQ_PENALTY } from "../../config/env.js";
import { fetchTokenInfo, fetchTokenInfoLive } from "../../data/dexscreener.js";

import { scoreAndRecommendOne } from "../../core/calculate.js";
import { mountGiscus } from "./chat.js";

import sanitizeToken from "./sanitizeToken.js";
import renderShell from "./render/shell.js";
import { buildStatsGrid, setStat, setStatHtml, setStatPrice } from "./render/statsGrid.js";
import { setStatStatusByKey } from "./render/statuses.js";
import { renderBarChart } from "./render/charts.js";
import { mountLivePriceLine, updateLivePriceLine, updateLivePriceAnchors } from "./render/liveLine.js"; 
import renderLinks from "./render/links.js";
import mountRecommendationPanel, { updateRecommendationPanel } from "./render/recommendation.js";
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
import { initSwap, createSwapButton, bindSwapButtons } from "../../widgets/swap.js";
import { startProfileMetrics } from "../../analytics/shill.js"; 
import { createSendFavoriteButton, createOpenLibraryButton, bindFavoriteButtons } from "../../widgets/library.js";

const SWAP_BRIDGE = (window.__fdvSwapBridge = window.__fdvSwapBridge || { inited:false, wired:false });

// Wire Safari-safe toggle for extra metrics (once)
if (!window.__fdvProfileExtraMetricsWired) {
  window.__fdvProfileExtraMetricsWired = true;
  document.addEventListener('click', (e) => {
    const btn = e.target.closest('.extra-metrics-toggle');
    if (!btn) return;
    const wrap = btn.closest('.profile__card__extra_metrics');
    if (!wrap) return;
    const on = btn.getAttribute('aria-expanded') === 'true';
    btn.setAttribute('aria-expanded', on ? 'false' : 'true');
    wrap.classList.toggle('is-open', !on);
  });
}

// Profile live feed sentinel
const PROFILE_FEED = (window.__fdvProfileFeed = window.__fdvProfileFeed || { ac:null, mint:null, timer:null });

function errorNotice(mount, msg) {
  mount.innerHTML = `<div class="wrap"><div class="small">Error: ${msg} <a data-link href="/">Home</a></div></div>`;
}

// Read stream state from the button (no import cycle)
function isStreamOnDom() {
  const btn = document.getElementById('stream');
  if (!btn) return true;
  const ap = btn.getAttribute('aria-pressed');
  if (ap != null) return ap === 'true' || ap === '1';
  return /on/i.test(btn.textContent || '');
}

function stopProfileFeed() {
  if (PROFILE_FEED.timer) { clearTimeout(PROFILE_FEED.timer); PROFILE_FEED.timer = null; }
  if (PROFILE_FEED.ac) { try { PROFILE_FEED.ac.abort(); } catch {} PROFILE_FEED.ac = null; }
}

function startProfileFeed(mint, initialModel) {
  stopProfileFeed();
  PROFILE_FEED.mint = mint;
  PROFILE_FEED.ac = new AbortController();
  let prev = initialModel || null;

  const tick = async () => {
    if (!isStreamOnDom()) { PROFILE_FEED.timer = setTimeout(tick, 1200); return; }
    const ac = PROFILE_FEED.ac;
    if (ac?.signal.aborted) return;

    try {
      const live = await fetchTokenInfoLive(mint, { signal: ac.signal, ttlMs: 2000 });
      if (ac?.signal.aborted || !live) return;

      const cur = sanitizeToken(live);

      // Update stats grid + pairs
      updateStatsGridLive(cur, prev);
      updatePairsTableLive(cur);

      // Re-score → animate KPI bars
      try {
        const scored = scoreAndRecommendOne(cur);
        updateRecommendationPanel({ scored });
      } catch {}

      prev = cur;
    } catch {} finally {
      if (!PROFILE_FEED.ac?.signal.aborted) {
        PROFILE_FEED.timer = setTimeout(tick, 2000 + Math.floor(Math.random()*400));
      }
    }
  };
  tick();

  if (!PROFILE_FEED._wiredStreamEvt) {
    PROFILE_FEED._wiredStreamEvt = true;
    document.addEventListener('stream-state', () => {
      if (isStreamOnDom() && PROFILE_FEED.mint && !PROFILE_FEED.timer) {
        PROFILE_FEED.timer = setTimeout(() => startProfileFeed(PROFILE_FEED.mint, prev), 50);
      }
    });
  }
}

export async function renderProfileView(input, { onBack } = {}) {
  const elApp = document.getElementById("app");
  const elHeader = document.querySelector(".header");
  if (elHeader) elHeader.style.display = "none";
  if (!elApp) return;

  const style = document.createElement("link");
  style.rel = "stylesheet";
  style.href = "/src/styles/profile.css";
  document.head.appendChild(style);

  const mint = typeof input === "string" ? input : input?.mint;
  if (!mint) {
    errorNotice(elApp, "Token not found.");
    return;
  }

  try {
    if (!SWAP_BRIDGE.inited) {
      initSwap();
      bindSwapButtons(document);
      SWAP_BRIDGE.inited = true;
    }
  } catch {}

  let CURRENT_AD = null;
  try { CURRENT_AD = pickAd(await loadAds()); } catch { CURRENT_AD = null; }
  const adHtml = CURRENT_AD ? adCard(CURRENT_AD) : "";

  renderShell({ mount: elApp, mint, adHtml });

  try {
    bindFavoriteButtons(document);
  } catch {}


  // Ensure Share button is tagged for metrics (copy_mint)
  try {
    const copyBtn = document.getElementById("btnCopyMint");
    if (copyBtn) copyBtn.setAttribute("data-copy-mint", "");
  } catch {}

  const gridEl = document.getElementById("statsGrid");
  buildStatsGrid(gridEl);
  wireStatsResizeAutoShortLabels(gridEl);
  setupStatsCollapse(gridEl);
  const statsCollapseBtn = document.querySelector(".profile__stats-toggle");
  setupExtraMetricsToggle(document.querySelector(".profile__card__extra_metrics"));

  // Sync initial open state with aria-expanded (if preset)
  try {
    const btn = document.querySelector('.extra-metrics-toggle');
    const wrap = document.querySelector('.profile__card__extra_metrics');
    if (btn && wrap) {
      const on = btn.getAttribute('aria-expanded') === 'true';
      wrap.classList.toggle('is-open', on);
    }
  } catch {}

  wireNavigation({ onBack });
  wireCopy(mint);

  // Initial data
  let raw;
  try {
    raw = await fetchTokenInfo(mint);
    if (raw.error) return errorNotice(elApp, raw.error);
  } catch (e) {
    console.warn("fetchTokenInfo failed:", e);
    window.location.href = "https://jup.ag/tokens/" + encodeURIComponent(mint);
    return;
  }
  const t = sanitizeToken(raw);
  const scored = scoreAndRecommendOne(t);


  // Hero & actions
  const logo = t.imageUrl || FALLBACK_LOGO(t.symbol);
  const media = elApp.querySelector(".profile__hero .media");
  if (media) media.innerHTML = `<img class="logo" src="${logo}" alt="">`;
  const title = elApp.querySelector(".profile__hero .title");
  if (title) title.textContent = t.symbol || "Token";
  try {
    const backBox = elApp.querySelector(".profile__hero .backBox");
    if (backBox) {
      let openBtn = document.getElementById("btnOpenLibrary") || backBox.querySelector('[data-open-library]');
      if (!openBtn) {
        openBtn = createOpenLibraryButton({ label: "📖", className: "btn btn-ghost" });
        openBtn.id = "btnOpenLibrary";
      } else {
        if (!openBtn.id) openBtn.id = "btnOpenLibrary";
      }
      if (openBtn.parentElement !== backBox) backBox.prepend(openBtn);
      openBtn.style.border = "none";
      openBtn.style.fontSize = "1.4em";
    }
  } catch {}
  try {
    const extra = elApp.querySelector(".profile__hero .extraFeat");
    if (extra && !extra.querySelector(`[data-fav-btn][data-mint="${mint}"]`)) {
      const favBtn = createSendFavoriteButton({
        mint,
        symbol: t.symbol || "",
        name: t.name || "",
        imageUrl: logo || "",
        className: "fdv-lib-btn"
      });
      extra.prepend(favBtn);
    }
  } catch {}
  const tradeTop = document.getElementById("btnTradeTop");
  if (tradeTop) {
    if (t.headlineUrl) { tradeTop.href = t.headlineUrl; tradeTop.classList.remove("disabled"); }
    else tradeTop.remove();
  }

  // Swap button in actions
  try {
    const hydrate = {
      mint, symbol: t.symbol, name: t.name, imageUrl: t.imageUrl, headerUrl: t.headerUrl,
      priceUsd: t.priceUsd, v24hTotal: t.v24hTotal, liquidityUsd: t.liquidityUsd,
      fdv: t.fdv ?? t.marketCap, marketCap: t.marketCap ?? t.fdv, headlineUrl: t.headlineUrl, headlineDex: t.headlineDex,
    };
    let swapBtn = document.getElementById("btnSwapAction");
    if (!swapBtn) {
      swapBtn = createSwapButton({ mint, label: "Swap", className: "btn btn--primary btn-ghost" });
      swapBtn.id = "btnSwapAction";
      // tag for metrics: open_swap_modal
      swapBtn.setAttribute("data-open-swap", "");
      const actions = elApp.querySelector(".profile__navigation .actions");
      if (actions) actions.prepend(swapBtn);
    } else {
      // ensure tag present if button already exists
      swapBtn.setAttribute("data-open-swap", "");
    }
    swapBtn.dataset.tokenHydrate = JSON.stringify(hydrate);
    if (t.headlineUrl) swapBtn.dataset.pairUrl = t.headlineUrl; else swapBtn.removeAttribute("data-pair-url");
  } catch {}

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

  // Stats values (initial)
  setStatPrice(gridEl, t.priceUsd, { maxFrac: 9, minFrac: 1 });

  setStat(gridEl, 1, fmtMoney(t.liquidityUsd));
  setStat(gridEl, 2, fmtMoney(t.fdv ?? t.marketCap));
  setStat(gridEl, 3, Number.isFinite(t.liqToFdvPct) ? `${t.liqToFdvPct.toFixed(2)}%` : "—");
  setStat(gridEl, 4, fmtMoney(t.v24hTotal));
  setStat(gridEl, 5, Number.isFinite(t.volToLiq24h) ? `${t.volToLiq24h.toFixed(2)}×` : "—");
  setStatHtml(gridEl, 6, pill(t.change5m));
  setStatHtml(gridEl, 7, pill(t.change1h));
  setStatHtml(gridEl, 8, pill(t.change6h));
  setStatHtml(gridEl, 9, pill(t.change24h));
  setStat(gridEl, 10, (() => {
    const ms = t.ageMs;
    if (!Number.isFinite(ms) || ms < 1000) return "—";
    const s = Math.floor(ms / 1000);
    const u = [["y",31536000],["mo",2592000],["d",86400],["h",3600],["m",60],["s",1]];
    for (const [label, div] of u) if (s >= div) return `${Math.floor(s / div)}${label}`;
    return "0s";
  })());
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

  setStatStatusByKey(gridEl, "liq", { ok: LIQ_OK, reason: LIQ_OK ? "Meets liquidity rule" : `Needs ≥ ${Intl.NumberFormat().format(BUY_RULES.liq)} liquidity` });
  setStatStatusByKey(gridEl, "fdv", { ok: null });
  setStatStatusByKey(gridEl, "liqfdv", { ok: LIQFDV_OK, reason: LIQFDV_OK === null ? "" : LIQFDV_OK ? "FDV/Liq is balanced" : "FDV/Liq imbalance detected" });
  setStatStatusByKey(gridEl, "v24", { ok: VOL_OK, reason: VOL_OK ? "Meets 24h volume rule" : `Needs ≥ ${Intl.NumberFormat().format(BUY_RULES.vol24)} 24h volume` });
  setStatStatusByKey(gridEl, "vliqr", { ok: VLIQR_OK, reason: VLIQR_OK === null ? "" : VLIQR_OK ? "Healthy 24h turnover vs liquidity" : "Low turnover vs liquidity" });
  setStatStatusByKey(gridEl, "d1h", { ok: CH1H_OK, reason: CH1H_OK ? "Positive 1h momentum" : `Needs > ${BUY_RULES.change1h.toFixed(2)}% 1h change` });
  setStatStatusByKey(gridEl, "d6h", { ok: CH6H_OK, reason: CH6H_OK ? "Up over 6h" : "Down over 6h" });
  setStatStatusByKey(gridEl, "d24h", { ok: CH24H_OK, reason: CH24H_OK ? "Up over 24h" : "Down over 24h" });
  setStatStatusByKey(gridEl, "price", { ok: null });
  setStatStatusByKey(gridEl, "d5m", { ok: null });
  setStatStatusByKey(gridEl, "age", { ok: null });
  const txKnown = Number.isFinite(t?.tx24h?.buys) && Number.isFinite(t?.tx24h?.sells);
  const TX_OK = txKnown ? t.tx24h.buys + t.tx24h.sells > 0 : null;
  setStatStatusByKey(gridEl, "bs24", { ok: TX_OK, reason: TX_OK === null ? "" : TX_OK ? "24h trading present" : "No 24h trades" });
  setStatStatusByKey(gridEl, "buyratio", { ok: BUYR_OK, reason: BUYR_OK === null ? "" : BUYR_OK ? "Buy pressure ≥ 50%" : "Sell pressure ≥ 50%" });

  // Badge in hero
  const badgeWrap = elApp.querySelector(".profile__hero .row");
  if (badgeWrap) {
    badgeWrap.innerHTML = `<span class="badge ${cssReco(scored.recommendation)}">${scored.recommendation}</span>`;
  }

  // Recommendation panel 
  mountRecommendationPanel(statsCollapseBtn, { scored, token: t, checks: { LIQFDV_OK, VLIQR_OK, BUYR_OK } });

  // Charts
  const mom = [t.change5m, t.change1h, t.change6h, t.change24h].map((x) => (Number.isFinite(x) ? Math.max(0, x) : 0));
  renderBarChart(document.getElementById("momBars"), mom, { height: 72, max: Math.max(5, ...mom), labels: ["5m", "1h", "6h", "24h"] });
  const vols = [t.v5mTotal, t.v1hTotal, t.v6hTotal, t.v24hTotal].map((x) => (Number.isFinite(x) ? x : 0));
  renderBarChart(document.getElementById("volBars"), vols, { height: 72, labels: ["5m", "1h", "6h", "24h"] });

  renderPairsTable(document.getElementById("pairsBody"), t.pairs);

  // Live price line
  let liveWrap = document.getElementById("livePriceWrap");
  if (!liveWrap) {
    liveWrap = document.createElement("div");
    liveWrap.id = "livePriceWrap";
  }
  const pairsBody = document.querySelector(".profile__card__extra_metrics");
  const anchor = pairsBody;
  anchor.parentElement.insertBefore(liveWrap, anchor);

  if (!liveWrap.__livePrice) {
    // Seed graph from percent changes so it starts from left with history anchors
    mountLivePriceLine(liveWrap, {
      windowMs: 10 * 60 * 1000,
      height: 140,
      seed: {
        priceNow: t.priceUsd,
        changes: { "5m": t.change5m, "1h": t.change1h, "6h": t.change6h, "24h": t.change24h }
      }
    });
  } else {
    // If already mounted, refresh the anchors
    updateLivePriceAnchors(liveWrap, { "5m": t.change5m, "1h": t.change1h, "6h": t.change6h, "24h": t.change24h }, t.priceUsd);
  }

  if (Number.isFinite(t.priceUsd)) {
    updateLivePriceLine(liveWrap, +t.priceUsd, Date.now());
  }

  // Chat
  mountGiscus({ mint });

  // Socials
  const linksMount = document.getElementById("profileLinks");
  if (linksMount) {
    renderLinks(linksMount, t.socials);
    if (!linksMount.innerHTML.trim()) linksMount.style.display = "none";
  }

  // Live updates
  try { startProfileFeed(t.mint || mint, t); } catch {}

  // Start rich shill metrics (includes base attribution)
  try { startProfileMetrics({ mint }); } catch {}
}

function updateStatsGridLive(t, prev) {
  const qv = (key) => document.querySelector(`.stat[data-stat="${key}"] .v`);
  const flashV = (el, diff) => {
    if (!el || !Number.isFinite(diff)) return;
    el.classList.remove('tick-up','tick-down'); void el.offsetWidth;
    if (diff > 0) el.classList.add('tick-up');
    else if (diff < 0) el.classList.add('tick-down');
  };
  const num = (x) => (Number.isFinite(x) ? +x : NaN);

  // price
  {
    const el = qv("price");
    const d = num(t.priceUsd) - num(prev?.priceUsd);
    if (el) {
      const grid = document.getElementById("statsGrid");
      if (grid) setStatPrice(grid, t.priceUsd, { maxFrac: 6, minFrac: 1 });
      flashV(el, d);
    }
    // push to live line if changed
    if (Number.isFinite(t.priceUsd) && t.priceUsd !== prev?.priceUsd) {
      const wrap = document.getElementById("livePriceWrap");
      if (wrap) updateLivePriceLine(wrap, +t.priceUsd, Date.now());
    }
    // re-seed anchors if any window change changed
    const changed =
      (t.change5m !== prev?.change5m) ||
      (t.change1h !== prev?.change1h) ||
      (t.change6h !== prev?.change6h) ||
      (t.change24h !== prev?.change24h);
    if (changed) {
      const wrap = document.getElementById("livePriceWrap");
      if (wrap) {
        updateLivePriceAnchors(
          wrap,
          { "5m": t.change5m, "1h": t.change1h, "6h": t.change6h, "24h": t.change24h },
          t.priceUsd
        );
      }
    }
  }
  // liquidity
  {
    const el = qv("liq");
    const d = num(t.liquidityUsd) - num(prev?.liquidityUsd);
    if (el) { el.textContent = fmtMoney(t.liquidityUsd); flashV(el, d); }
  }
  // fdv
  {
    const cur = Number.isFinite(t.fdv) ? t.fdv : t.marketCap;
    const prv = Number.isFinite(prev?.fdv) ? prev.fdv : prev?.marketCap;
    const el = qv("fdv");
    const d = num(cur) - num(prv);
    if (el) { el.textContent = fmtMoney(cur); flashV(el, d); }
  }
  // liq/fdv %
  {
    const el = qv("liqfdv");
    const cur = Number.isFinite(t.liqToFdvPct) ? `${t.liqToFdvPct.toFixed(2)}%` : "—";
    if (el) el.textContent = cur;
  }
  // 24h volume
  {
    const el = qv("v24");
    const d = num(t.v24hTotal) - num(prev?.v24hTotal);
    if (el) { el.textContent = fmtMoney(t.v24hTotal); flashV(el, d); }
  }
  // turnover 24h
  {
    const el = qv("vliqr");
    const d = num(t.volToLiq24h) - num(prev?.volToLiq24h);
    if (el) { el.textContent = Number.isFinite(t.volToLiq24h) ? `${t.volToLiq24h.toFixed(2)}×` : "—"; flashV(el, d); }
  }
  // deltas
  {
    const setDelta = (key, val, prevVal) => {
      const el = qv(key);
      if (!el) return;
      el.innerHTML = pill(val);
      flashV(el, num(val) - num(prevVal));
    };
    setDelta("d5m",  t.change5m,  prev?.change5m);
    setDelta("d1h",  t.change1h,  prev?.change1h);
    setDelta("d6h",  t.change6h,  prev?.change6h);
    setDelta("d24h", t.change24h, prev?.change24h);
  }
  // buys/sells 24h
  {
    const el = qv("bs24");
    const b = num(t?.tx24h?.buys), s = num(t?.tx24h?.sells);
    if (el) el.textContent = (Number.isFinite(b) && Number.isFinite(s)) ? `${fmtNum(b)} / ${fmtNum(s)}` : "—";
  }
  // buy ratio
  {
    const el = qv("buyratio");
    if (el) el.textContent = Number.isFinite(t.buySell24h) ? `${(t.buySell24h * 100).toFixed(1)}% buys` : "—";
  }
}

function updatePairsTableLive(t) {
  const body = document.getElementById("pairsBody");
  if (!body) return;
  try { renderPairsTable(body, t.pairs); } catch {}
}
