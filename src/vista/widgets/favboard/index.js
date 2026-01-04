import { FDV_FAV_ENDPOINT } from "../../../config/env.js";
import { fetchTokenInfo } from "../../../data/dexscreener.js";

const CACHE_KEY = "favboard_cache_v1";
const META_STORE_PREFIX = "favboard_meta_v1:";
const CACHE_TTL_MS = 5 * 60_000;
const PANEL_ID = "favboardPanel";

let rootEl, tableBodyEl, refreshBtn, statusEl;
let isLoading = false;
let panelEl = null;
let panelInner = null;
let toggleBtnRef = null;
let escHandlerBound = false;
let _favRunId = 0;

const tokenMetaCache = new Map();

const META_TTL_MS = 10 * 60_000;  
const MAX_ROWS    = 100;          

function readMetaCache(mint) {
  try {
    const raw = localStorage.getItem(`${META_STORE_PREFIX}${mint}`);
    if (!raw) return null;
    const { ts, data } = JSON.parse(raw);
    if (!ts || Date.now() - ts > META_TTL_MS) return null;
    return data;
  } catch { return null; }
}

function writeMetaCache(mint, data) {
  try { localStorage.setItem(`${META_STORE_PREFIX}${mint}`, JSON.stringify({ ts: Date.now(), data })); } catch {}
}

function getMetaFromCaches(mint) {
  if (tokenMetaCache.has(mint)) return tokenMetaCache.get(mint);
  const ls = readMetaCache(mint);
  if (ls) {
    tokenMetaCache.set(mint, ls);
    return ls;
  }
  return null;
}

function withTimeout(promise, ms, label = "timeout") {
  let t;
  const timeout = new Promise((_, rej) => { t = setTimeout(() => rej(new Error(label)), ms); });
  return Promise.race([promise.finally(() => clearTimeout(t)), timeout]);
}

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
  loadFavs({ priority: true });
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
    refreshBtn.addEventListener("click", () => loadFavs({ force: true, priority: true }));

  container.appendChild(rootEl);
  return rootEl;
}

async function loadFavs(opts = {}) {
  // opts can be boolean (legacy) or object
  const { force = (typeof opts === "boolean" ? opts : false), priority = false } =
    typeof opts === "object" ? opts : { force: !!opts, priority: false };

  // Allow priority runs to preempt non-priority ones
  if (isLoading && !priority) return;

  const myRun = ++_favRunId; // invalidate older runs
  isLoading = true;
  setStatus(priority ? "Loading…" : "Loading…");

  let payload = null;
  if (!force) payload = readCache();

  try {
    if (!payload) {
      const fresh = await fetchRemote({ priority, runId: myRun });
      if (fresh) {
        payload = fresh;
        writeCache(payload);
      }
    } else if (force) {
      const fresh = await fetchRemote({ priority, runId: myRun });
      if (fresh) {
        payload = fresh;
        writeCache(payload);
      }
    }
  } catch (err) {
    setStatus(`Fetch failed: ${err?.message || err}`);
  } finally {
    // only the latest run can clear loading; older runs were preempted
    if (_favRunId === myRun) isLoading = false;
  }

  if (_favRunId !== myRun) return;

  await render(payload, { priority, runId: myRun });
}

async function fetchRemote({ priority = false } = {}) {
  // Slightly longer budget for user-initiated loads; still bounded
  const timeoutMs = priority ? 12000 : 7000;
  const ac = new AbortController();
  const to = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(`${FDV_FAV_ENDPOINT}`, {
      method: "GET",
      cache: "no-store",
      credentials: "omit",
      mode: "cors",
      signal: ac.signal,
      headers: { "Accept": "application/json", "Origin": "fdv.lol" },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json();
    json.fetchedAt = Date.now();
    return json;
  } catch (err) {
    setStatus(`Fetch failed: ${err.message || err}`);
    return null;
  } finally {
    clearTimeout(to);
  }
}

async function render(data, { priority = false, runId } = {}) {
  if (!data || !Array.isArray(data.items) || !data.items.length) {
    tableBodyEl.innerHTML = `<tr><td colspan="10" class="favboard-empty">Processing data...</td></tr>`;
    setStatus("Updated just now.");
    return;
  }

  const items = data.items.slice(0, MAX_ROWS);

  // Immediate paint with cached/placeholder meta
  const baseRows = items.map((item, idx) => {
    const mint = item.mint;
    const cached = mint ? getMetaFromCaches(mint) : null;
    const meta = cached || normalizeTokenMeta(null, mint);
    return favRow({ ...item, ...meta }, idx + 1);
  }).join("");
  tableBodyEl.innerHTML = baseRows || `<tr><td colspan="10" class="favboard-empty">No rows to display.</td></tr>`;
  setStatus(`Hydrating ${items.length} tokens…`);

  const enriched = await hydrateMeta(items, { limit: priority ? 10 : 4, runId });
  // If a newer run started during hydration, skip updating DOM
  if (runId != null && runId !== _favRunId) return;

  const finalRows = enriched.map((item, idx) => favRow(item, idx + 1)).join("");
  tableBodyEl.innerHTML = finalRows || `<tr><td colspan="10" class="favboard-empty">No rows to display.</td></tr>`;
  setStatus(`Updated ${timeAgo(data.fetchedAt || Date.now())}`);
}
async function hydrateMeta(items, { limit = 4, runId } = {}) {
  const out = new Array(items.length);
  let i = 0;

  async function worker() {
    while (true) {
      // Stop early if preempted by a newer run
      if (runId != null && runId !== _favRunId) return;

      const idx = i++;
      if (idx >= items.length) break;
      const base = items[idx];
      const mint = base.mint;
      let normalized;

      const cached = mint ? getMetaFromCaches(mint) : null;
      if (cached) {
        normalized = cached;
      } else {
        try {
          const meta = await withTimeout(fetchTokenInfo(mint, { priority: true }), 6000, "meta_timeout");
          normalized = normalizeTokenMeta(meta, mint);
          tokenMetaCache.set(mint, normalized);
          writeMetaCache(mint, normalized);
        } catch {
          normalized = normalizeTokenMeta(null, mint);
          tokenMetaCache.set(mint, normalized);
          writeMetaCache(mint, normalized);
        }
      }
      out[idx] = { ...base, ...normalized };
    }
  }

  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
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

