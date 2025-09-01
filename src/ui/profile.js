import { FALLBACK_LOGO } from "../config/env.js";
import { fetchTokenInfo } from "../data/dexscreener.js";
import { normalizeSocial, iconFor } from "../data/socials.js";

const elApp = document.getElementById("app");
const elHeader = document.querySelector(".header");

const nfCompact = new Intl.NumberFormat(undefined, { notation: "compact" });
const nfInt = new Intl.NumberFormat(undefined);

const fmtMoney = (x) => (Number.isFinite(x) ? "$" + (x >= 1000 ? nfCompact.format(x) : x.toFixed(4)) : "—");
const fmtNum   = (x) => (Number.isFinite(x) ? nfInt.format(x) : "—");
const fmtPct   = (x) => (Number.isFinite(x) ? (x > 0 ? `+${x.toFixed(2)}%` : `${x.toFixed(2)}%`) : "—");
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const escAttr = (s) => esc(s).replace(/"/g, "&quot;");

function debounce(fn, ms=120){
  let t; return (...args)=>{ clearTimeout(t); t=setTimeout(()=>fn(...args), ms); };
}

const relTime = (ms) => {
  if (!Number.isFinite(ms) || ms < 1000) return "—";
  const s = Math.floor(ms / 1000);
  const u = [["y",31536000],["mo",2592000],["d",86400],["h",3600],["m",60],["s",1]];
  for (const [label, div] of u) if (s >= div) return `${Math.floor(s/div)}${label}`;
  return "0s";
};

const pill = (x) => {
  if (!Number.isFinite(x)) return `<span class="pill neutral">—</span>`;
  const cls = x > 0 ? "up" : x < 0 ? "down" : "neutral";
  return `<span class="pill ${cls}">${fmtPct(x)}</span>`;
};

const cssReco = (reco) => {
  const r = (reco || "watch").toLowerCase();
  return r === "buy" ? "buy" : r === "avoid" ? "avoid" : "watch";
};

function renderBarChart(mount, vals=[], { height=72, pad=4, max=null, labels=[] } = {}) {
  if (!mount) return;
  const draw = () => {
    const w = Math.max(220, Math.floor(mount.clientWidth || mount.parentElement?.clientWidth || 320));
    const h = height;
    const v = vals.map(x => Math.max(0, Number(x)||0));
    const M = (typeof max === "number" && max>0) ? max : Math.max(1, ...v);
    const bw = (w - pad*2) / (v.length || 1);

    const bars = v.map((x,i) => {
      const bh = (x/M) * (h - pad*2);
      const x0 = pad + i*bw, y0 = h - pad - bh;
      return `<rect x="${x0.toFixed(2)}" y="${y0.toFixed(2)}" width="${Math.max(1,bw-3).toFixed(2)}" height="${Math.max(1,bh).toFixed(2)}" rx="2" ry="2"/>`;
    }).join("");

    const axis = labels.length
      ? `<div class="axis">${labels.map(esc).join(" &nbsp; ")}</div>`
      : "";

    mount.innerHTML = `
      <svg class="bars" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" aria-hidden="true"></svg>
      ${axis}
    `;
    const svg = mount.querySelector("svg");
    svg.innerHTML = bars;
  };

  draw();
  if (!mount.__ro) {
    const ro = new ResizeObserver(debounce(draw, 80));
    ro.observe(mount);
    mount.__ro = ro;
  }
}

function errorNotice(msg) {
  if (!elApp) return;
  elApp.innerHTML = `
    <div class="wrap">
      <div class="small">Error: ${esc(msg)} <a data-link href="/">Go home</a></div>
    </div>
  `;
}

export async function renderProfileView(input, { onBack } = {}) {
  if (elHeader) elHeader.style.display = "none";
  if (!elApp) return;
  const mint = typeof input === "string" ? input : input?.mint;
  if (!mint) {
    elApp.innerHTML = `<div class="wrap"><div class="small">Token not found. <a data-link href="/">Go home</a></div></div>`;
    return;
  }

  // Shell
  const shortMint = `${mint.slice(0,6)}…${mint.slice(-6)}`;
  elApp.innerHTML = `
    <div class="profile">
      <div class="profile__hero">
        <div class="media"><div class="logo sk"></div></div>
        <div class="meta">
          <div class="title">Token</div>
          <div class="titleMint"><span class="muted mono">${esc(shortMint)}</span></div>
          <div class="row">
            <span class="badge ${cssReco(input?.reco)}">${esc(input?.reco || "WATCH")}</span>
          </div>
        </div>
        <div class="profile__links" id="profileLinks"></div>
      </div>
      <hr />
      <div class="profile__navigation">
        <a class="btn buy-btn disabled" id="btnTradeTop" target="_blank" rel="noopener">Trade on Dexscreener</a>
        <div class="actions">
          <button class="btn btn-ghost" id="btnCopyMint" title="Copy mint">Copy</button>
          <button class="btn" id="btnBack">← Back</button>
        </div>
    </div>

      <div class="profile__stats">
        ${[
          "Price (USD)","Price (SOL)","Liquidity","FDV","Liq / FDV","24h Volume","Vol/Liq 24h",
          "Δ 5m","Δ 1h","Δ 6h","Δ 24h","Age","24h Buys/Sells","Buy Ratio 24h"
        ].map(k => `<div class="stat"><div class="k">${k}</div><div class="v sk">—</div></div>`).join("")}
      </div>

      <div class="profile__grid">
        <div class="profile__card">
          <div class="label">Momentum (Δ%)</div>
          <div id="momBars" class="chartbox"></div>
        </div>

        <div class="profile__card">
          <div class="label">Volume (m5 / h1 / h6 / h24)</div>
          <div id="volBars" class="chartbox"></div>
        </div>

        <div class="profile__card">
          <div class="label">Pairs</div>
          <div class="table-scroll">
            <table class="pairs">
                <thead><tr><th>DEX</th><th>Price</th><th>Liq</th><th>Vol 24h</th><th>Δ1h</th><th>Δ24h</th><th></th></tr></thead>
                <tbody id="pairsBody">
                <tr><td colspan="7" class="muted small">Loading…</td></tr>
                </tbody>
            </table>
           </div>
        </div>
      </div>
    </div>
  `;

  document.getElementById("btnBack")?.addEventListener("click", () => {
    if (onBack) onBack(); else if (history.length > 1) history.back(); else window.location.href="/";
  });
  document.getElementById("btnCopyMint")?.addEventListener("click", () =>
    navigator.clipboard.writeText(mint).catch(()=>{})
  );

  if (window.sparklineSVG && Array.isArray(input?.changes)) {
    const svg = window.sparklineSVG(input.changes, { w: 560, h: 96 });
    const mount = document.getElementById("sparkProfile");
    if (mount) mount.innerHTML = svg;
  }

  let t;
  try {
    t = await fetchTokenInfo(mint);
    if (t.error) return errorNotice(t.error);
  } catch (e) {
    console.warn("fetchTokenInfo failed:", e);
    const body = document.getElementById("pairsBody");
    if (body) body.innerHTML = `<tr><td colspan="7" class="muted small">Couldn't load pair data.</td></tr>`;
    return;
  }

  const logo = t.imageUrl || FALLBACK_LOGO(t.symbol);
  const media = elApp.querySelector(".profile__hero .media");
  if (media) media.innerHTML = `<img class="logo" src="${logo}" alt="">`;
  const title = elApp.querySelector(".profile__hero .title");
  if (title) title.innerHTML = `${esc(t.symbol || "Token")}`;

  const tradeTop = document.getElementById("btnTradeTop");
  if (tradeTop) {
    if (t.headlineUrl) {
      tradeTop.href = t.headlineUrl;
      tradeTop.classList.remove("disabled");
    } else {
      tradeTop.remove();
    }
  }

  setStat(0, fmtMoney(t.priceUsd));
  setStat(1, Number.isFinite(t.priceNative) ? `${t.priceNative} SOL` : "—");
  setStat(2, fmtMoney(t.liquidityUsd));
  setStat(3, fmtMoney(t.fdv ?? t.marketCap));
  setStat(4, Number.isFinite(t.liqToFdvPct) ? `${t.liqToFdvPct.toFixed(2)}%` : "—");
  setStat(5, fmtMoney(t.v24hTotal));
  setStat(6, Number.isFinite(t.volToLiq24h) ? `${t.volToLiq24h.toFixed(2)}×` : "—");
  setStatHtml(7, pill(t.change5m));
  setStatHtml(8, pill(t.change1h));
  setStatHtml(9, pill(t.change6h));
  setStatHtml(10, pill(t.change24h));
  setStat(11, relTime(t.ageMs));
  setStat(12, `${fmtNum(t.tx24h.buys)} / ${fmtNum(t.tx24h.sells)}`);
  setStat(13, Number.isFinite(t.buySell24h) ? `${(t.buySell24h*100).toFixed(1)}% buys` : "—");

  const mom = [t.change5m, t.change1h, t.change6h, t.change24h].map(x => Number.isFinite(x) ? Math.max(0, x) : 0);
  const momBox = document.getElementById("momBars");
  if (momBox) renderBarChart(momBox, mom, { height: 72, max: Math.max(5, ...mom), labels: ["5m","1h","6h","24h"] });

  const vols = [t.v5mTotal, t.v1hTotal, t.v6hTotal, t.v24hTotal].map(x => Number.isFinite(x) ? x : 0);
  const volBox = document.getElementById("volBars");
  if (volBox) renderBarChart(volBox, vols, { height: 72, labels: ["5m","1h","6h","24h"] });

  const body = document.getElementById("pairsBody");
  if (body) {
    if (!t.pairs?.length) {
      body.innerHTML = `<tr><td colspan="7" class="muted small">No pairs found.</td></tr>`;
    } else {
      const rows = t.pairs
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
      body.innerHTML = rows;
    }
  }

  renderLinks(t.socials);
}

function setStat(idx, text) {
  const el = elApp.querySelectorAll(".profile__stats .stat .v")[idx];
  if (el) { el.classList.remove("sk"); el.textContent = text; }
}

function setStatHtml(idx, html) {
  const el = elApp.querySelectorAll(".profile__stats .stat .v")[idx];
  if (el) { el.classList.remove("sk"); el.innerHTML = html; }
}

function renderLinks(t) {

  const wrap = document.getElementById("profileLinks");
    let links = (Array.isArray(t) ? t : [])
        .map(normalizeSocial)
        .filter(Boolean)
        .reduce((acc, s) => { if(!acc.some(x=>x.href===s.href)) acc.push(s); return acc; }, [])
        .slice(0, 6);
    if (!links.length) return;
    
    const html = links.map(s =>
        `<a class="iconbtn" href="${s.href}" target="_blank" rel="noopener nofollow"
            aria-label="${s.platform}" data-tooltip="${s.platform}">
            ${iconFor(s.platform)}
         </a>`
      ).join('');
    if (wrap) wrap.innerHTML = html;
  
}

export const profileCss = `
.profile { 
    padding: 16px;
    /* center in middle of screen if short */
    min-height: calc(100vh - 32px - 48px - 48px); 
    box-sizing: border-box;
    display: flex;
    flex-direction: column;
    max-width: 960px;
    margin: 0 auto;
}
.mono { font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace }

hr { border-top:1px solid rgba(7, 196, 7, 0.08); margin:12px 0 }

.chartbox { padding: 4px 0 }
.chartbox .bars { width: 100%; height: auto; display: block }

.table-scroll { 
  overflow: auto;
  -webkit-overflow-scrolling: touch;
  overscroll-behavior: contain;       
}
.table-scroll .pairs { 
  min-width: 560px;                    
  width: 100%;
  display: block;
  height: 130px;
  overflow: auto;
}

.table-scroll--xy { 
  max-height: 48vh;                   
  border-radius: 12px;
  box-shadow: inset 0 0 0 1px rgba(122,222,255,.08);
}

/* Sticky header inside the scroller */
.table-scroll thead th {
  position: sticky;
  top: 0;
  z-index: 2;
  background: var(--card);
  /* Optional: make it pop */
  backdrop-filter: saturate(120%) blur(6px);
  /* subtle divider below header */
  box-shadow: 0 1px 0 0 rgba(122,222,255,.12);
}

.pairs tbody tr:hover td { background: rgba(123,241,255,.04); }

@media (max-width: 720px) {
  .table-scroll--xy { max-height: 56vh; } /* a bit taller on phones */
  .pairs th, .pairs td { padding: 10px 8px; }
}

.table-scroll::-webkit-scrollbar { height: 8px; width: 10px; }
.table-scroll::-webkit-scrollbar-track { background: var(--panel); }
.table-scroll::-webkit-scrollbar-thumb { background: rgba(122,222,255,.18); border-radius: 4px; }
.table-scroll::-webkit-scrollbar-thumb:hover { background: rgba(122,222,255,.28); }

.profile__hero { display:grid; grid-template-columns: 92px 1fr auto; gap:12px; align-items:center; margin-bottom: 12px }
.profile__hero .media { width:92px; height:92px; border-radius:18px; background:linear-gradient(180deg, rgba(255,255,255,.04), rgba(255,255,255,.02)); overflow:hidden; display:flex; align-items:center; justify-content:center }
.profile__hero img.logo, .profile__hero .logo { width:84px; height:84px; border-radius:14px; background: rgba(255,255,255,.04) }
.profile__hero .title { font-weight:800; font-size:20px }
.profile__hero .row { display:flex; gap:8px; margin-top:6px }
.profile__hero .actions { display:flex; gap:8px; align-items:center }
.profile__navigation { display:flex;flex-direction: row;justify-content: space-between;align-items: flex-end;margin-bottom: 12px }
.buy-btn { background: var(--buy); color:#06140b; font-weight:800; border:1px solid rgba(0,0,0,.25) }
.buy-btn.disabled { opacity:.5; pointer-events:none }

.profile__stats { display:grid; grid-template-columns: repeat(auto-fit, minmax(160px,1fr)); gap:8px; margin: 8px 0 14px }
.stat { background: var(--card); border:1px solid rgba(122,222,255,.10); padding:10px; border-radius:12px }
.stat .k { font-size:12px; color: var(--muted); margin-bottom:4px }
.stat .v { font-size:16px; font-weight:700; min-height:1em }
.stat .v.sk { color: transparent; background: linear-gradient(90deg, rgba(255,255,255,.06), rgba(255,255,255,.14), rgba(255,255,255,.06)); background-size:200% 100%; animation: sh 1.2s linear infinite; border-radius:6px }

.profile__grid { display:grid; grid-template-columns: repeat(auto-fit, minmax(300px,1fr)); gap:12px }
.profile__card { background: var(--card); border:1px solid rgba(122,222,255,.10); padding:12px; border-radius:14px }
.chartbox { padding:4px 0 }
svg.bars rect { fill: rgba(123,241,255,.8) }

.label { font-size:12px; letter-spacing:.08em; text-transform:uppercase; color: var(--muted); margin-bottom:8px }
.reasons { margin:0; padding-left:18px; line-height:1.5 }
.reasons li { margin:4px 0 }

.pairs { width:100%; border-collapse: collapse; font-size:14px }
.pairs th, .pairs td { padding:8px 6px; border-bottom:1px dashed rgba(122,222,255,.08) }
.pairs th { text-align:left; color: var(--muted); font-weight:600 }
.pairs td:last-child { text-align:right }

.badge { display:inline-block; padding:5px 10px; border-radius:999px; font-weight:800; font-size:12px; color:#111 }
.badge.buy   { background: var(--buy) }
.badge.watch { background: var(--watch) }
.badge.avoid { background: var(--avoid) }

.pill { display:inline-block; font-weight:700; font-size:12px; padding:3px 8px; border-radius:999px; border:1px solid rgba(122,222,255,.18) }
.pill.up { background: rgba(26,255,122,.12) }
.pill.down { background: rgba(255,77,109,.12) }
.pill.neutral { background: rgba(123,241,255,.10) }

.link { color: var(--neon2); text-decoration:none; border-bottom:1px dotted rgba(123,241,255,.3); padding-bottom:1px }
.link:hover { border-bottom-style:solid }

.btn { background: var(--panel); border:1px solid rgba(122,222,255,.2); padding:6px 10px; border-radius:10px; color: var(--text); cursor:pointer }
.btn-ghost { background: transparent }

.axis { margin-top:4px; font-size:12px; color: var(--muted) }

@keyframes sh { 0%{background-position:200% 0} 100%{background-position:-200% 0} }
`;
