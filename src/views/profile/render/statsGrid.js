import { esc } from "../formatters.js";
import { formatPriceParts } from "../../../lib/formatPrice.js";

function computePumpKpi5Min(token) {
  const c5 = Number.isFinite(token.change5m) ? token.change5m : 0;
  const c1 = Number.isFinite(token.change1h) ? token.change1h : 0;
  const vr5 = Number.isFinite(token.v5mTotal) ? token.v5mTotal : 0;
  const vr1h = Number.isFinite(token.v1hTotal) && token.v1hTotal > 0 ? token.v1hTotal : 0;
  const buyRatio = Number.isFinite(token.buySell24h) ? token.buySell24h : 0;

  // Volume acceleration (project 5m to 1h vs actual 1h)
  const accel = vr1h > 0 ? Math.min(3, (vr5 * 12) / vr1h) : (vr5 > 0 ? 1 : 0);

  // Score components (tunable weights)
  const score =
    (c5 / 6) +          // ~1 when 5m change ~6%
    (c1 / 25) +         // ~1 when 1h change ~25%
    (accel - 1) +       // 0 when neutral, up to 2 when 3x
    Math.max(0, (buyRatio - 0.55) * 2); // boosts if >55% buys

  const isPumping =
    c5 > 3 &&           // basic short-term move
    c1 > 8 &&           // sustained
    accel > 1.15 &&     // real acceleration
    score >= 1.4;

  let tag = "Calm";
  let cls = "pill--neutral";
  if (isPumping) {
    tag = "🔥 Pumping";
    cls = "pill--warn";
  } else if (score >= 1) {
    tag = "Warming";
    cls = "pill--info";
  }

  const html = `<span class="pill ${cls}" title="Score ${score.toFixed(2)} | accel ${(accel).toFixed(2)} | buys ${(buyRatio*100).toFixed(1)}%">${tag}</span>`;
  return { isPumping, score, html };
}

function computePumpKpi1Hour(token) {
  const c1  = Number.isFinite(token.change1h) ? token.change1h : 0;
  const c6  = Number.isFinite(token.change6h) ? token.change6h : 0;
  const v1  = Number.isFinite(token.v1hTotal) ? token.v1hTotal : 0;
  const v6  = Number.isFinite(token.v6hTotal) && token.v6hTotal > 0 ? token.v6hTotal : 0;
  const buyRatio = Number.isFinite(token.buySell24h) ? token.buySell24h : 0;

  // Volume acceleration: project 1h over 6h vs actual 6h (normalized)
  const accel = v6 > 0 ? Math.min(3, (v1 * 6) / v6) : (v1 > 0 ? 1 : 0);

  // Score: emphasize sustained move + acceleration
  const score =
    (c1 / 20) +             // ~1 at +20% 1h
    (c6 / 60) +             // ~1 at +60% 6h
    (accel - 1) +           // 0 baseline, up to +2
    Math.max(0, (buyRatio - 0.55) * 1.5); // lighter buy ratio weight we need this for 1h

  // Pumping if strong 1h move, sustained, accelerating, decent buy ratio

  const isPumping =
    c1 > 10 &&              // strong last hour
    accel > 1.1 &&          // accelerating
    score >= 1.5;

  let tag = "Calm";
  let cls = "pill--neutral";
  if (isPumping) {
    tag = "🔥 Pumping";
    cls = "pill--warn";
  } else if (score >= 1) {
    tag = "Warming";
    cls = "pill--info";
  }

  const html = `<span class="pill ${cls}" title="1h Score ${score.toFixed(2)} | accel ${accel.toFixed(2)} | buys ${(buyRatio*100).toFixed(1)}%">${tag}</span>`;
  return { isPumping, score, html };
}

export function updatePumpKpis(container, token) {
  if (!container) return;
  const defs = [...container.querySelectorAll(".stat")];
  const idx5m = defs.findIndex(el => el.getAttribute("data-stat") === "pump5m");
  const idx1h = defs.findIndex(el => el.getAttribute("data-stat") === "pump1h");
  const p5 = computePumpKpi5Min(token);
  const p1 = computePumpKpi1Hour(token);
  if (idx5m >= 0) setStatHtml(container, idx5m, p5.html);
  if (idx1h >= 0) setStatHtml(container, idx1h, p1.html);
  return { pump5m: p5, pump1h: p1 };
}


function toDecimalString(v) {
  if (v == null) return "0.0";
  let s = String(v).trim();
  if (/^[+-]?\d+(\.\d+)?$/.test(s)) return s.includes(".") ? s : s + ".0";
  const n = Number(v);
  if (!Number.isFinite(n)) return "0.0";
  if (Math.abs(n) >= 1) return n.toString().includes(".") ? n.toString() : n.toString() + ".0";
  const m = n.toExponential().match(/^([+-]?\d(?:\.\d+)?)[eE]([+-]\d+)$/);
  if (!m) return "0.0";
  const coef = m[1].replace(".", "");
  const exp = parseInt(m[2], 10);
  if (exp >= 0) {
    const pad = exp - (m[1].split(".")[1]?.length || 0);
    return coef + (pad > 0 ? "0".repeat(pad) : "");
  } else {
    const k = -exp - 1;
    return "0." + "0".repeat(k) + coef.replace(/^-/, "");
  }
}

export function setPumpStatus(container, { pump5m, pump1h }) {
  const setStatus = (key, ok) => {
    const el = container.querySelector(`.stat[data-stat="${key}"] .status`);
    if (!el) return;
    el.classList.remove("ok","bad");
    if (ok === true) el.classList.add("ok");
    else if (ok === false) el.classList.add("bad");
  };
  setStatus("pump5m", pump5m?.isPumping);
  setStatus("pump1h", pump1h?.isPumping);
}


const STAT_DEF = [
  { key: "price",    label: "Price (USD)", short: "Price" },
  { key: "liq",      label: "Liquidity",   short: "Liq" },
  { key: "fdv",      label: "FDV",         short: "FDV" },
  { key: "liqfdv",   label: "Liq / FDV",   short: "L/F" },
  { key: "v24",      label: "24h Volume",  short: "Vol24" },
  { key: "vliqr",    label: "Vol/Liq 24h", short: "V/L 24h" },
  { key: "d5m",      label: "Δ 5m",        short: "Δ5m" },
  { key: "d1h",      label: "Δ 1h",        short: "Δ1h" },
  { key: "d6h",      label: "Δ 6h",        short: "Δ6h" },
  { key: "d24h",     label: "Δ 24h",       short: "Δ24h" },
  { key: "age",      label: "Age",         short: "Age" },
  { key: "bs24",     label: "24h Buys/Sells", short: "B/S 24" },
  { key: "buyratio", label: "Buy Ratio 24h",  short: "Buy%" },
  { key: "pump5m",   label: "Pump (5m)",      short: "P5m" },
  { key: "pump1h",   label: "Pump (1h)",      short: "P1h" }
];

const PRICE_IDX = STAT_DEF.findIndex(d => d.key === "price");

export function buildStatsGrid(container) {
  if (!container) return;
  const frag = document.createDocumentFragment();
  for (const s of STAT_DEF) {
    const card = document.createElement('div');
    card.className = 'stat';
    card.setAttribute('data-stat', s.key);
    card.setAttribute('data-short', s.short || s.label);
    card.innerHTML = `
      <div class="k">
        <span class="k__text">${esc(s.label)}</span>
        <span class="status" aria-hidden="true"></span>
      </div>
      <div class="v sk" aria-live="polite" aria-atomic="true">—</div>
    `;
    frag.appendChild(card);
  }
  container.replaceChildren(frag);
}
export function setStat(container, idx, text) {
  const el = container?.querySelectorAll(".stat .v")[idx];
  if (el) { el.classList.remove("sk"); el.textContent = text; }
}

export function setStatHtml(container, idx, html) {
  const el = container?.querySelectorAll(".stat .v")[idx];
  if (el) { el.classList.remove("sk"); el.innerHTML = html; }
}

export function setStatPrice(container, value, { maxFrac = 6, minFrac = 1, maxSig = 3 } = {}) {
  const idx = PRICE_IDX;
  const dec = toDecimalString(value);
  const isNeg = String(value).trim().startsWith("-");
  const [rawInt = "0", rawFrac = "0"] = dec.replace(/^[+-]?/, "").split(".");

  if (rawInt !== "0") {
    const p = formatPriceParts(dec, { maxFrac, minFrac });
    const html = `
      <span class="price" title="${esc(p.text)}">
        ${p.sign ? `<span class="sign">${p.sign}</span>` : ""}
        <span class="int">${p.int}</span><span class="dot">.</span><span class="frac">${p.frac}</span>
      </span>
    `;
    return setStatHtml(container, idx, html);
  }
  const fracRaw = (rawFrac || "0").replace(/[^0-9]/g, "");
  const leadZeros = (fracRaw.match(/^0+/) || [""])[0].length;
  const sig = fracRaw.slice(leadZeros, leadZeros + Math.max(1, maxSig)) || "0";

  const title = `${isNeg ? "-" : ""}0.${fracRaw || "0"}`;
  const html = `
    <span class="priceTiny" title="${esc(title)}" aria-label="${esc(`0.0 - ${leadZeros} decimal - ${sig}`)}">
      <span class="base">0.0</span>
      <span class="count">${leadZeros}</span>
      <span class="sig">${esc(sig)}</span>
    </span>
  `;
  setStatHtml(container, idx, html);
}