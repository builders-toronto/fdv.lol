import { buildStatsGrid, setStat, setStatHtml, setStatPrice } from "../render/statsGrid.js";
import { setStatStatusByKey } from "../render/statuses.js";
import { renderBarChart } from "../render/charts.js";
import mountRecommendationPanel from "../render/recommendation.js";
import { fmtMoney, fmtNum, pill, cssReco } from "../formatters.js";
import { renderPairsTable } from "../render/pairsTable.js";
import { setupStatsCollapse, setupExtraMetricsToggle, wireStatsResizeAutoShortLabels } from "../render/interactions.js";
import { mountLivePriceLine, updateLivePriceLine, updateLivePriceAnchors } from "../render/liveLine.js";



const PAIRS_SIG_MAX = 30;

function pairsSignature(pairs) {
  if (!Array.isArray(pairs) || !pairs.length) return "";
  return pairs
    .slice(0, PAIRS_SIG_MAX)
    .map(p => `${p.dexId || ""}:${p.pairAddress || p.address || p.mint || ""}`)
    .join("|") + `|len=${pairs.length}`;
}

export function initStatsAndCharts({ token, scored, BUY_RULES, FDV_LIQ_PENALTY }) {
  const gridEl = document.getElementById("statsGrid");
  buildStatsGrid(gridEl);
  wireStatsResizeAutoShortLabels(gridEl);
  setupStatsCollapse(gridEl);
  let buttonExisty = document.querySelector(".extra-metrics-toggle");
  if (!buttonExisty) {
    setupExtraMetricsToggle(document.querySelector(".profile__card__extra_metrics"));
  }
  // Hero badge
  const badgeWrap = document.querySelector(".profile__hero .row");
  if (badgeWrap) {
    badgeWrap.innerHTML = `<span class="badge ${cssReco(scored.recommendation)}">${scored.recommendation}</span>`;
  }

  // Stats initial
  setStatPrice(gridEl, token.priceUsd, { maxFrac: 9, minFrac: 1 });
  setStat(gridEl, 1, fmtMoney(token.liquidityUsd));
  setStat(gridEl, 2, fmtMoney(token.fdv ?? token.marketCap));
  setStat(gridEl, 3, Number.isFinite(token.liqToFdvPct) ? `${token.liqToFdvPct.toFixed(2)}%` : "—");
  setStat(gridEl, 4, fmtMoney(token.v24hTotal));
  setStat(gridEl, 5, Number.isFinite(token.volToLiq24h) ? `${token.volToLiq24h.toFixed(2)}×` : "—");
  setStatHtml(gridEl, 6, pill(token.change5m));
  setStatHtml(gridEl, 7, pill(token.change1h));
  setStatHtml(gridEl, 8, pill(token.change6h));
  setStatHtml(gridEl, 9, pill(token.change24h));
  setStat(gridEl, 10, ageFmt(token.ageMs));
  setStat(gridEl, 11, `${fmtNum(token.tx24h.buys)} / ${fmtNum(token.tx24h.sells)}`);
  setStat(gridEl, 12, Number.isFinite(token.buySell24h) ? `${(token.buySell24h * 100).toFixed(1)}% buys` : "—");

  // Status flags
  const LIQ_OK = Number.isFinite(token.liquidityUsd) && token.liquidityUsd >= BUY_RULES.liq;
  const VOL_OK = Number.isFinite(token.v24hTotal) && token.v24hTotal >= BUY_RULES.vol24;
  const CH1H_OK = Number.isFinite(token.change1h) && token.change1h > BUY_RULES.change1h;
  const liqToFdvPct = Number.isFinite(token.liqToFdvPct) ? token.liqToFdvPct : null;
  const minLiqPct = 100 / Math.max(FDV_LIQ_PENALTY.ratio, 1);
  const LIQFDV_OK = liqToFdvPct !== null ? liqToFdvPct >= minLiqPct : null;
  const CH6H_OK = Number.isFinite(token.change6h) ? token.change6h > 0 : null;
  const CH24H_OK = Number.isFinite(token.change24h) ? token.change24h > 0 : null;
  const VLIQR_OK = Number.isFinite(token.volToLiq24h) ? token.volToLiq24h >= 0.5 : null;
  const BUYR_OK = Number.isFinite(token.buySell24h) ? token.buySell24h >= 0.5 : null;
  const txKnown = Number.isFinite(token?.tx24h?.buys) && Number.isFinite(token?.tx24h?.sells);
  const TX_OK = txKnown ? token.tx24h.buys + token.tx24h.sells > 0 : null;

  setStatStatusByKey(gridEl, "liq", { ok: LIQ_OK });
  setStatStatusByKey(gridEl, "fdv", { ok: null });
  setStatStatusByKey(gridEl, "liqfdv", { ok: LIQFDV_OK });
  setStatStatusByKey(gridEl, "v24", { ok: VOL_OK });
  setStatStatusByKey(gridEl, "vliqr", { ok: VLIQR_OK });
  setStatStatusByKey(gridEl, "d1h", { ok: CH1H_OK });
  setStatStatusByKey(gridEl, "d6h", { ok: CH6H_OK });
  setStatStatusByKey(gridEl, "d24h", { ok: CH24H_OK });
  setStatStatusByKey(gridEl, "price", { ok: null });
  setStatStatusByKey(gridEl, "d5m", { ok: null });
  setStatStatusByKey(gridEl, "age", { ok: null });
  setStatStatusByKey(gridEl, "bs24", { ok: TX_OK });
  setStatStatusByKey(gridEl, "buyratio", { ok: BUYR_OK });

  // Recommendation panel
  const statsCollapseBtn = document.querySelector(".profile__stats-toggle");
  mountRecommendationPanel(statsCollapseBtn, { scored, token, checks: { LIQFDV_OK, VLIQR_OK, BUYR_OK } });

  // Charts
  const mom = [token.change5m, token.change1h, token.change6h, token.change24h].map(x => (Number.isFinite(x) ? Math.max(0, x) : 0));
  renderBarChart(document.getElementById("momBars"), mom, { height: 72, max: Math.max(5, ...mom), labels: ["5m","1h","6h","24h"] });
  const vols = [token.v5mTotal, token.v1hTotal, token.v6hTotal, token.v24hTotal].map(x => (Number.isFinite(x) ? x : 0));
  renderBarChart(document.getElementById("volBars"), vols, { height: 72, labels: ["5m","1h","6h","24h"] });

  if (pairsBody) {
    pairsBody.dataset.pairsSig = pairsSignature(token.pairs);
    pairsBody.dataset.pairsRenderedAt = String(Date.now());
  }
  renderPairsTable(pairsBody, token.pairs);
  
  // Live price line seed
  let liveWrap = document.getElementById("livePriceWrap");
  if (!liveWrap) {
    liveWrap = document.createElement("div");
    liveWrap.id = "livePriceWrap";
    const anchor = document.querySelector(".profile__card__extra_metrics");
    if (anchor?.parentElement) anchor.parentElement.insertBefore(liveWrap, anchor);
  }
  if (!liveWrap.__livePrice) {
    mountLivePriceLine(liveWrap, {
      windowMs: 10 * 60 * 1000,
      height: 140,
      seed: {
        priceNow: token.priceUsd,
        changes: { "5m": token.change5m, "1h": token.change1h, "6h": token.change6h, "24h": token.change24h }
      }
    });
  } else {
    updateLivePriceAnchors(
      liveWrap,
      { "5m": token.change5m, "1h": token.change1h, "6h": token.change6h, "24h": token.change24h },
      token.priceUsd
    );
  }
  if (Number.isFinite(token.priceUsd)) {
    updateLivePriceLine(liveWrap, +token.priceUsd, Date.now());
  }

  return { gridEl, liveWrap };
}

function ageFmt(ms) {
  if (!Number.isFinite(ms) || ms < 1000) return "—";
  const s = Math.floor(ms / 1000);
  const units = [["y",31536000],["mo",2592000],["d",86400],["h",3600],["m",60],["s",1]];
  for (const [label, div] of units) if (s >= div) return `${Math.floor(s / div)}${label}`;
  return "0s";
}