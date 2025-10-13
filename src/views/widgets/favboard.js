import { FDV_FAV_ENDPOINT } from "../../config/env.js";
import { fetchTokenInfo } from "../../data/dexscreener.js";

const CACHE_KEY = "favboard_cache_v1";
const CACHE_TTL_MS = 5 * 60_000;
const PANEL_ID = "favboardPanel";

let rootEl, tableBodyEl, refreshBtn, statusEl;
let isLoading = false;
let panelEl = null;
let panelInner = null;
let toggleBtnRef = null;
let escHandlerBound = false;

const tokenMetaCache = new Map();

(function injectFavStyles() {
  if (document.getElementById("favboard-css")) return;
  const css = `
    .favboard-wrap{background:var(--fdv-surface,#090d12);border:1px solid var(--fdv-border,#141b24);border-radius:16px;padding:18px;margin:0 auto;box-shadow:var(--shadow-2,0 12px 32px rgba(0,0,0,.35));}
    .favboard-head{display:flex;flex-wrap:wrap;gap:var(--gap-2,12px);align-items:center;justify-content:space-between;margin-bottom:16px;}
    .favboard-title{font-size:var(--step-1,1.25rem);font-weight:600;color:var(--text,#e8f2ff);}
    .favboard-refresh{background:var(--fdv-bg,#0f1621);border:1px solid color-mix(in srgb,var(--accent2,#7bf1ff) 15%,transparent);color:var(--fdv-muted,#9ab7d2);padding:8px 14px;border-radius:10px;cursor:pointer;transition:.2s;}
    .favboard-refresh:hover{border-color:var(--accent2,#7bf1ff);color:var(--text,#d8ecff);}
    .favboard-status{font-size:.85rem;color:var(--fdv-muted,#6f859c);}
    .favboard-table{width:100%;border-collapse:collapse;margin-top:6px;min-width:640px;}
    .favboard-table thead{background:linear-gradient(90deg,color-mix(in srgb,var(--accent2,#7bf1ff) 20%,transparent),color-mix(in srgb,var(--accent,#1affd5) 14%,transparent));}
    .favboard-table th{font-weight:600;text-align:left;font-size:.78rem;color:var(--fdv-muted,#a7c5e2);padding:10px 12px;border-bottom:1px solid var(--fdv-border,#172231);text-transform:uppercase;letter-spacing:.05em;}
    .favboard-table td{padding:11px 12px;border-bottom:1px solid color-mix(in srgb,var(--fdv-border,#0f1721) 90%,transparent);font-size:.88rem;color:var(--text,#d8e7fb);vertical-align:middle;}
    .favboard-table tr:last-child td{border-bottom:none;}
    .favboard-rank{font-weight:600;color:var(--accent2,#8fd0ff);}
    .favboard-logo{width:36px;height:36px;border-radius:11px;object-fit:cover;border:1px solid color-mix(in srgb,var(--accent2,#1a2838) 35%,transparent);background:var(--fdv-bg,#0e1620);margin-right:10px;vertical-align:middle;}
    .favboard-name{display:flex;align-items:center;}
    .favboard-name strong{color:var(--text,#edf5ff);font-size:.92rem;}
    .favboard-symbol{color:var(--fdv-muted,#7fa0c2);font-size:.78rem;margin-left:8px;text-transform:uppercase;letter-spacing:.03em;}
    .favboard-mint{font-family:var(--mono-font,"JetBrains Mono",monospace);font-size:.75rem;color:color-mix(in srgb,var(--fdv-muted,#7a92ac) 85%,transparent);word-break:break-all;}
    .favboard-pill{padding:4px 8px;border-radius:999px;background:color-mix(in srgb,var(--accent2,#101b28) 12%,transparent);border:1px solid color-mix(in srgb,var(--accent2,#1f2d3f) 25%,transparent);font-size:.78rem;color:var(--accent2,#9ed9ff);display:inline-block;}
    .favboard-pill.positive{background:color-mix(in srgb,var(--ok,#1aff7a) 12%,transparent);border-color:color-mix(in srgb,var(--ok,#1aff7a) 32%,transparent);color:var(--ok,#95f5b7);}
    .favboard-pill.negative{background:color-mix(in srgb,var(--danger,#ff4d6d) 12%,transparent);border-color:color-mix(in srgb,var(--danger,#ff4d6d) 32%,transparent);color:var(--danger,#ffb8a6);}
    .favboard-link{color:var(--accent2,#8fd0ff);text-decoration:none;}
    .favboard-link:hover{text-decoration:underline;}
    .favboard-empty{padding:24px;text-align:center;color:var(--fdv-muted,#6f859c);font-size:.9rem;}
    .favboard-panel{position:relative;display:none; width:100%;}
    .favboard-panel[data-open="1"]{display:block;}
    .favboard-panel .favboard-panel-box{background:var(--fdv-bg,#070c11);border:1px solid var(--fdv-border,#162231);border-radius:18px;padding:18px;margin-top:14px;width:100%;box-shadow:var(--shadow-3,0 12px 32px rgba(0,0,0,.6));}
    .favboard-panel-header{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:12px;}
    .favboard-panel-header h3{margin:0;font-size:1.1rem;color:var(--text,#e8f2ff);}
    .favboard-close{background:var(--fdv-bg,#0f1621);border:1px solid color-mix(in srgb,var(--accent2,#1e2a3a) 25%,transparent);color:var(--fdv-muted,#9ab7d2);padding:6px 10px;border-radius:10px;cursor:pointer;transition:.2s;}
    .favboard-close:hover{border-color:var(--accent2,#2ac3ff);color:var(--text,#d8ecff);}
    .favboard-scroll{overflow-x:auto;}
    @media (max-width:720px){
      .favboard-wrap{padding:14px;}
      .favboard-head{flex-direction:column;align-items:flex-start;}
      .favboard-scroll{overflow:visible;}
      .favboard-table{border-collapse:separate;border-spacing:0 10px;min-width:0;}
      .favboard-table thead{display:none;}
      .favboard-table tbody{display:block;}
      .favboard-table tr{display:block;background:color-mix(in srgb,var(--fdv-bg,#0b1119) 92%,transparent);border:1px solid color-mix(in srgb,var(--fdv-border,#162231) 75%,transparent);border-radius:14px;padding:12px 12px 6px;margin-bottom:25px;box-shadow:var(--shadow-1,0 8px 18px rgba(0,0,0,.28));}
      .favboard-table td{display:flex;justify-content:space-between;align-items:center;border-bottom:none;padding:6px 0;font-size:.82rem;}
      .favboard-table td::before{content:attr(data-label);flex:0 0 42%;max-width:48%;color:var(--fdv-muted,#6f859c);text-transform:uppercase;letter-spacing:.06em;font-size:.72rem;}
      .favboard-name{flex-direction:row;align-items:center;}
      .favboard-table td[data-label="Token"]{padding-top:0;}
      .favboard-table td[data-label="Link"]{justify-content:space-between;padding-bottom:2px;}
      .favboard-table td + td{border-top:1px solid rgba(255,255,255,.04);}
    }
  `;
  const style = document.createElement("style");
  style.id = "favboard-css";
  style.textContent = css;
  document.head.appendChild(style);
})();

function ensurePanel() {
  if (panelEl) return panelEl;
  const host = document.getElementById("hdrToolsPanels") || document.body;
  panelEl = document.createElement("div");
  panelEl.id = PANEL_ID;
  panelEl.className = "favboard-panel";
  panelEl.setAttribute("data-open", "0");
  panelEl.innerHTML = `
    <div class="favboard-panel-box">
      <div class="favboard-panel-header">
        <h3>Fan Favorites</h3>
        <button type="button" class="favboard-close" data-favboard-close aria-label="Close favorites">Close</button>
      </div>
      <div class="favboard-panel-body"></div>
    </div>
  `;
  panelInner = panelEl.querySelector(".favboard-panel-body");
  host.appendChild(panelEl);
  panelEl.querySelector("[data-favboard-close]")?.addEventListener("click", () => closeFavboard());
  if (!escHandlerBound) {
    escHandlerBound = true;
    document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeFavboard(); });
  }
  return panelEl;
}

export function createOpenFavboardButton({ label = "❤️ Favorites", className = "fdv-lib-btn" } = {}) {
  ensurePanel();
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = className;
  btn.id = "btnOpenFavboard";
  btn.textContent = label;
  btn.setAttribute("data-fav-open", "");
  btn.setAttribute("aria-haspopup", "true");
  btn.setAttribute("aria-expanded", "false");
  btn.addEventListener("click", () => toggleFavboard(btn));
  return btn;
}

export function initFavboard() {
  ensurePanel();
  ensureFavLeaderboard(panelInner);
}

function toggleFavboard(btn) {
  const panel = ensurePanel();
  const isOpen = panel.getAttribute("data-open") === "1";
  if (isOpen) closeFavboard(); else openFavboard(btn);
}

export function openFavboard(triggerBtn) {
  const panel = ensurePanel();
  ensureFavLeaderboard(panelInner);
  panel.setAttribute("data-open", "1");
  panel.style.display = "block";
  loadFavs();
  toggleBtnRef = triggerBtn || toggleBtnRef;
  if (toggleBtnRef) {
    toggleBtnRef.setAttribute("aria-expanded", "true");
    toggleBtnRef.setAttribute("aria-pressed", "true");
  }
}

export function closeFavboard() {
  if (!panelEl) return;
  panelEl.setAttribute("data-open", "0");
  panelEl.style.display = "none";
  if (toggleBtnRef) {
    toggleBtnRef.setAttribute("aria-expanded", "false");
    toggleBtnRef.setAttribute("aria-pressed", "false");
  }
}

export function ensureFavLeaderboard(container = document.body) {
  ensurePanel();
  const mount = container || panelInner || document.body;
  if (rootEl) {
    if (rootEl.parentElement !== mount) mount.appendChild(rootEl);
    return rootEl;
  }
  rootEl = document.createElement("section");
  rootEl.className = "favboard-wrap";
  rootEl.innerHTML = `
    <div class="favboard-head">
      <h2 class="favboard-title">❤️ Fan Favorites</h2>
      <div class="favboard-status">Open the board to load favorites.</div>
      <button type="button" class="favboard-refresh">Refresh</button>
    </div>
    <div class="favboard-scroll">
      <table class="favboard-table">
        <thead>
          <tr>
            <th>#</th>
            <th>Token</th>
            <th>Favorites</th>
            <th>Price</th>
            <th>Liq</th>
            <th>FDV</th>
            <th>5m</th>
            <th>1h</th>
            <th>Updated</th>
            <th>Link</th>
          </tr>
        </thead>
        <tbody id="favboardTbody">
          <tr><td colspan="10" class="favboard-empty"></td></tr>
        </tbody>
      </table>
    </div>
  `;
  tableBodyEl = rootEl.querySelector("#favboardTbody");
  refreshBtn = rootEl.querySelector(".favboard-refresh");
  statusEl = rootEl.querySelector(".favboard-status");
  refreshBtn.addEventListener("click", () => loadFavs(true));
  container.appendChild(rootEl);
  return rootEl;
}

async function loadFavs(force = false) {
  if (isLoading) return;
  isLoading = true;
  setStatus("Loading…");

  let payload = null;
  if (!force) payload = readCache();

  try {
    if (!payload) {
      payload = await fetchRemote();
      if (payload) writeCache(payload);
    } else if (force) {
      const fresh = await fetchRemote();
      if (fresh) {
        payload = fresh;
        writeCache(payload);
      }
    }
  } catch (err) {
    setStatus(`Fetch failed: ${err?.message || err}`);
  } finally {
    isLoading = false;
  }

  await render(payload);
}

async function fetchRemote() {
  try {
    const res = await fetch(`${FDV_FAV_ENDPOINT}`, {
      headers: { "Origin": "https://fdv.lol" },
      cache: "no-store",
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json();
    json.fetchedAt = Date.now();
    return json;
  } catch (err) {
    setStatus(`Fetch failed: ${err.message || err}`);
    return null;
  }
}

async function render(data) {
  if (!data || !Array.isArray(data.items) || !data.items.length) {
    tableBodyEl.innerHTML = `<tr><td colspan="10" class="favboard-empty">Processing data...</td></tr>`;
    setStatus("Updated just now.");
    return;
  }

  const enriched = await Promise.all(data.items.map(async (item) => {
    const base = { ...item };
    const mint = base.mint;
    if (!mint) return base;
    if (tokenMetaCache.has(mint)) return { ...base, ...tokenMetaCache.get(mint) };
    try {
      const meta = await fetchTokenInfo(mint, { priority: true });
      const normalized = normalizeTokenMeta(meta, mint);
      tokenMetaCache.set(mint, normalized);
      return { ...base, ...normalized };
    } catch (err) {
      console.warn("favboard meta fetch failed", mint, err?.message || err);
      const fallback = normalizeTokenMeta(null, mint);
      tokenMetaCache.set(mint, fallback);
      return { ...base, ...fallback };
    }
  }));

  const rows = enriched.map((item, idx) => favRow(item, idx + 1)).join("");
  tableBodyEl.innerHTML = rows || `<tr><td colspan="10" class="favboard-empty">No rows to display.</td></tr>`;
  setStatus(`Updated ${timeAgo(data.fetchedAt || Date.now())}`);
}

function favRow(item, rank) {
  const mint = item.mint || "unknown";
  const fav = Number(item.favorites) || 0;
  const updated = item.updatedAt ? timeAgo(item.updatedAt) : "unknown";
  const logo = item.logoURI || "";
  const name = item.name || shortMint(mint);
  const symbol = (item.symbol || "").toUpperCase();
  const price = Number.isFinite(item.priceUsd) ? formatPrice(item.priceUsd) : "-";
  const liq = Number.isFinite(item.liquidityUsd) ? formatMoney(item.liquidityUsd) : "-";
  const fdvUsd = Number.isFinite(item.fdvUsd) ? formatMoney(item.fdvUsd) : "-";
  const change5m = Number.isFinite(item.change5m) ? item.change5m : null;
  const change1h = Number.isFinite(item.change1h) ? item.change1h : null;
  const fdvUrl = `/token/${encodeURIComponent(mint)}`;

  return `
    <tr>
      <td class="favboard-rank" data-label="#">${rank}</td>
      <td data-label="Token">
        <div class="favboard-name">
          ${logo ? `<img class="favboard-logo" src="${logo}" alt="${symbol || name} logo" loading="lazy" />` : ""}
          <div>
            <strong>${escapeHtml(name)}</strong>
            ${symbol ? `<span class="favboard-symbol">${escapeHtml(symbol)}</span>` : ""}
          </div>
        </div>
      </td>
      <td data-label="Favorites"><span class="favboard-pill">${fav}</span></td>
      <td data-label="Price">${price}</td>
      <td data-label="Liq">${liq}</td>
      <td data-label="FDV">${fdvUsd}</td>
      <td data-label="5m">${change5m !== null ? `<span class="favboard-pill ${change5m >= 0 ? "positive" : "negative"}">${formatPct(change5m)}</span>` : "-"}</td>
      <td data-label="1h">${change1h !== null ? `<span class="favboard-pill ${change1h >= 0 ? "positive" : "negative"}">${formatPct(change1h)}</span>` : "-"}</td>
      <td data-label="Updated">${updated}</td>
      <td data-label="Link"><a class="favboard-link" href="${fdvUrl}">View</a></td>
    </tr>
  `;
}

function setStatus(txt) {
  if (!statusEl) return;
  if (!txt) statusEl.hidden = true;
  else {
    statusEl.textContent = txt;
    statusEl.hidden = false;
  }
}

function readCache() {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if (!raw) return null;
    const { ts, data } = JSON.parse(raw);
    if (!ts || Date.now() - ts > CACHE_TTL_MS) return null;
    return data;
  } catch {
    return null;
  }
}

function writeCache(data) {
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify({ ts: Date.now(), data }));
  } catch {}
}

function shortMint(mint) {
  if (!mint || mint.length < 12) return mint;
  return `${mint.slice(0, 4)}…${mint.slice(-4)}`;
}

function timeAgo(ts) {
  const then = typeof ts === "string" ? Date.parse(ts) : Number(ts);
  if (!Number.isFinite(then)) return "unknown";
  const diff = Date.now() - then;
  if (diff < 60_000) return "just now";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return `${Math.floor(diff / 86_400_000)}d ago`;
}

function formatMoney(val) {
  const n = Number(val);
  if (!Number.isFinite(n) || n <= 0) return "-";
  if (n >= 1e9) return `$${(n / 1e9).toFixed(2)}B`;
  if (n >= 1e6) return `$${(n / 1e6).toFixed(2)}M`;
  if (n >= 1e3) return `$${(n / 1e3).toFixed(1)}K`;
  return `$${n.toFixed(0)}`;
}

function formatPrice(val) {
  const n = Number(val);
  if (!Number.isFinite(n) || n <= 0) return "-";
  if (n >= 1) return `$${n.toFixed(4)}`;
  if (n >= 0.01) return `$${n.toFixed(4)}`;
  return `$${n.toFixed(6)}`;
}

function formatPct(val) {
  const n = Number(val);
  if (!Number.isFinite(n)) return "-";
  const abs = Math.abs(n);
  const fixed = abs >= 100 ? abs.toFixed(0) : abs >= 10 ? abs.toFixed(1) : abs.toFixed(2);
  return `${n >= 0 ? "+" : "-"}${fixed}%`;
}

function escapeHtml(str) {
  return String(str ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function normalizeTokenMeta(raw, mint) {
  if (!raw || typeof raw !== "object") {
    return {
      mint,
      name: shortMint(mint),
      symbol: "",
      logoURI: "",
      priceUsd: NaN,
      liquidityUsd: NaN,
      fdvUsd: NaN,
      change5m: null,
      change1h: null,
    };
  }
  const primary = raw.primary || raw;
  const token = primary?.token || raw.token || raw;
  return {
    mint,
    name: token?.name || raw.name || shortMint(mint),
    symbol: (token?.symbol || raw.symbol || "").toUpperCase(),
    logoURI: token?.imageUrl || token?.logo || raw.logoURI || raw.logoUrl || "",
    priceUsd: Number(primary?.priceUsd ?? raw.priceUsd ?? raw.priceUSD ?? NaN),
    liquidityUsd: Number(primary?.liquidityUsd ?? raw.liquidityUsd ?? raw.liqUsd ?? NaN),
    fdvUsd: Number(primary?.fdvUsd ?? raw.fdvUsd ?? raw.fdvUSD ?? raw.fdv ?? NaN),
    change5m: Number.isFinite(primary?.change5m) ? primary.change5m : Number(raw.change5m),
    change1h: Number.isFinite(primary?.change1h) ? primary.change1h : Number(raw.change1h),
  };
}

if (typeof window !== "undefined") {
  window.fdvFavboard = { ensureFavLeaderboard, openFavboard, closeFavboard };
}

