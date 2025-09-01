import { FALLBACK_LOGO } from "../config/env.js";
import { fetchTokenInfo } from "../data/dexscreener.js";
import { normalizeSocial, iconFor } from "../data/socials.js";
import { mountGiscus } from "./chat.js";
import { loadAds, pickAd, adCard } from "../ads/load.js";

const elApp = document.getElementById("app");
const elHeader = document.querySelector(".header");

const nfCompact = new Intl.NumberFormat(undefined, { notation: "compact" });
const nfInt = new Intl.NumberFormat(undefined);

const fmtMoney = (x) => (Number.isFinite(x) ? "$" + (x >= 1000 ? nfCompact.format(x) : x.toFixed(4)) : "—");
const fmtNum   = (x) => (Number.isFinite(x) ? nfInt.format(x) : "—");
const fmtPct   = (x) => (Number.isFinite(x) ? (x > 0 ? `+${x.toFixed(2)}%` : `${x.toFixed(2)}%`) : "—");
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const escAttr = (s) => esc(s).replace(/"/g, "&quot;");

const style = document.createElement('link');
style.rel = 'stylesheet';
style.href = '/src/styles/profile.css';
document.head.appendChild(style);

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

const STAT_DEF = [
  { key: "price",    label: "Price (USD)",      short: "Price",   fmt: (t) => Number.isFinite(t.priceUsd) ? `$${t.priceUsd.toFixed(6)}` : "—" },
  { key: "liq",      label: "Liquidity",        short: "Liq",     fmt: (t) => fmtMoney(t.liquidityUsd) },
  { key: "fdv",      label: "FDV",              short: "FDV",     fmt: (t) => fmtMoney(t.fdv ?? t.marketCap) },
  { key: "liqfdv",   label: "Liq / FDV",        short: "L/F",     fmt: (t) => Number.isFinite(t.liqToFdvPct) ? `${t.liqToFdvPct.toFixed(2)}%` : "—" },
  { key: "v24",      label: "24h Volume",       short: "Vol24",   fmt: (t) => fmtMoney(t.v24hTotal) },
  { key: "vliqr",    label: "Vol/Liq 24h",      short: "V/L 24h", fmt: (t) => Number.isFinite(t.volToLiq24h) ? `${t.volToLiq24h.toFixed(2)}×` : "—" },
  { key: "d5m",      label: "Δ 5m",             short: "Δ5m",     html: (t) => pill(t.change5m) },
  { key: "d1h",      label: "Δ 1h",             short: "Δ1h",     html: (t) => pill(t.change1h) },
  { key: "d6h",      label: "Δ 6h",             short: "Δ6h",     html: (t) => pill(t.change6h) },
  { key: "d24h",     label: "Δ 24h",            short: "Δ24h",    html: (t) => pill(t.change24h) },
  { key: "age",      label: "Age",              short: "Age",     fmt: (t) => relTime(t.ageMs) },
  { key: "bs24",     label: "24h Buys/Sells",   short: "B/S 24",  fmt: (t) => `${fmtNum(t.tx24h?.buys)} / ${fmtNum(t.tx24h?.sells)}` },
  { key: "buyratio", label: "Buy Ratio 24h",    short: "Buy%",    fmt: (t) => Number.isFinite(t.buySell24h) ? `${(t.buySell24h * 100).toFixed(1)}% buys` : "—" },
];

function buildStatsGrid(container) {
  if (!container) return;
  const frag = document.createDocumentFragment();
  for (const s of STAT_DEF) {
    const card = document.createElement('div');
    card.className = 'stat';
    card.setAttribute('data-stat', s.key);
    card.setAttribute('data-short', s.short || s.label);
    card.innerHTML = `
      <div class="k">${esc(s.label)}</div>
      <div class="v sk" aria-live="polite" aria-atomic="true">—</div>
    `;
    frag.appendChild(card);
  }
  container.replaceChildren(frag);
}

function setupStatsCollapse(gridEl) {
  const grid = gridEl || document.querySelector('.profile__stats');
  if (!grid) return;

  const stats = grid.querySelectorAll('.stat');
  if (stats.length <= 4) return; 

  grid.classList.add('is-collapsed');

  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'btn profile__stats-toggle';
  btn.setAttribute('aria-expanded', 'false');
  if (!grid.id) grid.id = 'profile-stats';
  btn.setAttribute('aria-controls', grid.id);
  btn.innerHTML = 'Show all stats <i aria-hidden="true" class="caret"></i>';
  const toggle = () => {
    const collapsed = grid.classList.toggle('is-collapsed');
    const expanded = !collapsed;
    btn.setAttribute('aria-expanded', String(expanded));
    btn.innerHTML = (expanded ? 'Hide extra stats' : 'Show all stats') + ' <i aria-hidden="true" class="caret"></i>';
  };
  btn.addEventListener('click', toggle);
  btn.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); } });
  grid.after(btn);
}

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
      <div class="small">Error: ${esc(msg)} <a data-link href="/">Home</a></div>
    </div>
  `;
}

let CURRENT_AD = null;

export async function renderProfileView(input, { onBack } = {}) {
  const adsPromise = loadAds();
  try {
    const ads = await adsPromise;
    CURRENT_AD = pickAd(ads);
  } catch {
    CURRENT_AD = null;
  }
  const adHtml = CURRENT_AD ? adCard(CURRENT_AD) : '';
  if (elHeader) elHeader.style.display = "none";
  if (!elApp) return;
  const mint = typeof input === "string" ? input : input?.mint;
  if (!mint) {
    elApp.innerHTML = `<div class="wrap"><div class="small">Token not found. <a data-link href="/">Home</a></div></div>`;
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
      <div class="divider"></div>
      <div class="profile__navigation">
        <a class="btn buy-btn disabled" id="btnTradeTop" target="_blank" rel="noopener">Dexscreener</a>
        <div class="actions">
          <button class="btn btn-ghost" id="btnCopyMint" title="Copy mint">Copy</button>
          <button class="btn" id="btnBack">Back</button>
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
      ${adHtml}
      <div id="chatMount" class="chatbox"></div>
    </div>
  `;

  buildStatsGrid(document.getElementById('statsGrid'));
  setupStatsCollapse(document.getElementById('statsGrid'));

  document.getElementById("btnBack")?.addEventListener("click", () => {
    if (onBack) onBack(); else if (history.length > 1) history.back(); else window.location.href="/";
  });
  document.getElementById("btnCopyMint")?.addEventListener("click", () =>
    navigator.clipboard.writeText("https://fdv.lol/token/" + mint).catch(()=>{})
    . then(() => {
      const btn = document.getElementById("btnCopyMint");
      if (!btn) return;
      const orig = btn.textContent;
      btn.textContent = "Copied!";
      setTimeout(() => { btn.textContent = orig; }, 1500);
    })
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

  const PRICE_USD = Number.isFinite(t.priceUsd) ? `$${t.priceUsd.toFixed(6)}` : "—";

  setStat(0, PRICE_USD);
  setStat(1, fmtMoney(t.liquidityUsd));
  setStat(2, fmtMoney(t.fdv ?? t.marketCap));
  setStat(3, Number.isFinite(t.liqToFdvPct) ? `${t.liqToFdvPct.toFixed(2)}%` : "—");
  setStat(4, fmtMoney(t.v24hTotal));
  setStat(5, Number.isFinite(t.volToLiq24h) ? `${t.volToLiq24h.toFixed(2)}×` : "—");
  setStatHtml(6, pill(t.change5m));
  setStatHtml(7, pill(t.change1h));
  setStatHtml(8, pill(t.change6h));
  setStatHtml(9, pill(t.change24h));
  setStat(10, relTime(t.ageMs));
  setStat(11, `${fmtNum(t.tx24h.buys)} / ${fmtNum(t.tx24h.sells)}`);
  setStat(12, Number.isFinite(t.buySell24h) ? `${(t.buySell24h*100).toFixed(1)}% buys` : "—");

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
  mountGiscus({ mint });
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