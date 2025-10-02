import { esc } from "../formatters.js";
import { formatPriceParts } from "../../../lib/formatPrice.js";

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
];

const PRICE_IDX = STAT_DEF.findIndex(d => d.key === "price");

export function buildStatsGrid(container) {
  if (!container) return;
  // check if already built
  if (container.querySelector(".recoPanel")) return;
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