import { esc, escAttr } from "../formatters.js";

const SOL_ADDR_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

function sanitizeAdHtml(html) {
  try {
    const div = document.createElement("div");
    div.innerHTML = String(html || "");

    const disallowed = new Set(["script","style","iframe","object","embed","link","meta","form","input","button","textarea","select"]);
    const walker = document.createTreeWalker(div, NodeFilter.SHOW_ELEMENT, null);
    const toRemove = [];

    while (walker.nextNode()) {
      const el = walker.currentNode;
      if (disallowed.has(el.tagName.toLowerCase())) {
        toRemove.push(el);
        continue;
      }
      // strip event handlers and dangerous URLs
      for (const attr of [...el.attributes]) {
        const name = attr.name.toLowerCase();
        const val = attr.value || "";
        if (name.startsWith("on")) {
          el.removeAttribute(attr.name);
          continue;
        }
        if ((name === "href" || name === "src") && val.trim()) {
          const v = val.trim();
          const lower = v.toLowerCase();
          if (lower.startsWith("javascript:") || lower.startsWith("data:") || lower.startsWith("vbscript:")) {
            el.removeAttribute(attr.name);
          } else if (!/^https?:\/\//i.test(v)) {
            el.setAttribute(attr.name, "#");
          }
        }
        if (name === "target" && attr.value === "_blank") {
          const rel = (el.getAttribute("rel") || "").toLowerCase();
          if (!/\bnoopener\b/.test(rel) || !/\bnoreferrer\b/.test(rel)) {
            el.setAttribute("rel", "noopener noreferrer");
          }
        }
      }
    }
    for (const n of toRemove) n.remove();
    return div.innerHTML;
  } catch {
    return "";
  }
}

export default function renderShell({ mount, mint, adHtml = "" }) {
  const safeMint = SOL_ADDR_RE.test(String(mint || "")) ? String(mint) : "";
  const shortMint = safeMint ? `${safeMint.slice(0,6)}…${safeMint.slice(-6)}` : "—";
  const solscanHref = safeMint ? `https://solscan.io/account/${escAttr(safeMint)}` : "#";

  mount.innerHTML = `
    <div class="profile">
      <div class="profile__hero">
        <div class="media"><div class="logo sk"></div></div>
        <div class="meta">
          <div class="title">Token</div>
          <div class="row"><span class="badge WATCH">WATCH</span></div>
          <div class="titleMint"><a href="${solscanHref}" target="_blank" rel="noopener noreferrer nofollow">${esc(shortMint)}</a></div>
        </div>
        <div class="profile__links" id="profileLinks"></div>
        <div class="backBox"><button class="btn btn-ghost" id="btnBack">Home</button></div>
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

      <div id="adMount"></div>
      <div id="chatMount" class="chatbox"></div>
    </div>
  `;

  // Safely inject optional ad HTML after sanitization
  if (adHtml) {
    const el = mount.querySelector("#adMount");
    if (el) el.innerHTML = sanitizeAdHtml(adHtml);
  }
}
