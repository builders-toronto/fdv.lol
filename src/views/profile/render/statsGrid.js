import { esc } from "../formatters.js";

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
