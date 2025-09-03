import { fmtMoney, fmtPct, escAttr, esc } from "../formatters.js";

export function renderPairsTable(body, pairs) {
  if (!body) return;
  if (!pairs?.length) {
    body.innerHTML = `<tr><td colspan="7" class="muted small">No pairs found.</td></tr>`;
    return;
  }
  body.innerHTML = pairs
    .slice()
    .sort((a,b)=> (b.liquidityUsd||0)-(a.liquidityUsd||0))
    .map(p => `
      <tr>
        <td>${esc(p.dexId)}</td>
        <td>${fmtMoney(p.priceUsd)}</td>
        <td>${fmtMoney(p.liquidityUsd)}</td>
        <td>${fmtMoney(p.v24h)}</td>
        <td>${fmtPct(p.change1h ?? null)}</td>
        <td>${fmtPct(p.change24h ?? null)}</td>
        <td><a class="btn buy-btn" href="${escAttr(p.url)}" target="_blank" rel="noopener">Trade</a></td>
      </tr>
    `).join("");
}
