import { esc, escAttr } from "../formatters.js";

export default function renderShell({ mount, mint, adHtml = "" }) {
  const shortMint = `${mint.slice(0,6)}…${mint.slice(-6)}`;
  mount.innerHTML = `
    <div class="profile">
      <div class="profile__hero">
        <div class="media"><div class="logo sk"></div></div>
        <div class="meta">
          <div class="title">Token</div>
          <div class="row"><span class="badge WATCH">WATCH</span></div>
          <div class="titleMint"><span class="muted mono">${esc(shortMint)}</span></div>
        </div>
        <div class="profile__links" id="profileLinks"></div>
        <div class="backBox"><button class="btn" id="btnBack">Home</button></div>
        <div class="extraFeat"></div>
      </div>

      <div class="divider"></div>

      <div class="profile__navigation">
        <a class="btn buy-btn disabled" id="btnTradeTop" target="_blank" rel="noopener">Dexscreener</a>
        <div class="actions">
          <button class="btn btn-ghost" id="btnCopyMint" title="Copy mint">Share</button>
        </div>
      </div>

      <div class="profile__stats" id="statsGrid"></div>

      <div class="profile__grid">
        <div class="profile__card">
          <div class="label">Momentum (Δ%)</div>
          <div id="momBars" class="chartbox"></div>
        </div>

        <div class="profile__card">
          <div class="label">Volume (m5 / h1 / h6 / h24)</div>
          <div id="volBars" class="chartbox"></div>
        </div>
      </div>

      <div class="profile__card__extra_metrics">
        <div class="label"></div>
        <div class="table-scroll">
          <table class="pairs">
            <thead><tr><th>DEX</th><th>Price</th><th>Liq</th><th>Vol 24h</th><th>Δ1h</th><th>Δ24h</th><th></th></tr></thead>
            <tbody id="pairsBody">
              <tr><td colspan="7" class="muted small">Loading…</td></tr>
            </tbody>
          </table>
        </div>
      </div>

      ${adHtml}
      <div id="chatMount" class="chatbox"></div>
    </div>
  `;
}
