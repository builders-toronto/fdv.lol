import { fetchTokenInfo } from "../../data/dexscreener.js";

const LS_KEY = "fdv_library_v1";
const EVT = { CHANGE: "library:change" };
const pendingFav = new Map(); // mint -> true while in-flight

let CFG = {
  metricsBase: "https://fdv-lol-metrics.fdvlol.workers.dev/api/shill",
};

function load() {
  try {
    const j = JSON.parse(localStorage.getItem(LS_KEY) || "{}");
    const items = j.items || {};
    const order = Array.isArray(j.order) ? j.order : Object.keys(items);
    return { items, order };
  } catch {
    return { items: {}, order: [] };
  }
}
function save(state) {
  try { localStorage.setItem(LS_KEY, JSON.stringify(state)); } catch {}
}
function emitChange() {
  try { document.dispatchEvent(new CustomEvent(EVT.CHANGE)); } catch {}
}

function ensureStyles() {
  if (document.getElementById("fdvLibraryCss")) return;
  const css = `
    .fdv-lib-btn {
      display: inline-flex; align-items: center; gap: 8px;
      height: 36px; padding: 0 10px; border-radius: 10px;
      background: transparent; border: none; font-weight: 700;
      cursor: pointer; transition: filter .15s ease, border-color .15s ease, background .15s ease;
    }
    .fdv-lib-btn:hover { filter: brightness(1.06); }
    .fdv-lib-heart { display:inline-block; font-size:16px; line-height:1; }
    .fdv-lib-count {
      min-width:20px; height:20px; padding:0 6px; display:inline-flex; align-items:center; justify-content:center;
      border-radius:999px; font-size:12px; font-weight:800; background: rgba(26,255,213,.10);
      border:1px solid rgba(26,255,213,.20); color: var(--text);
    }
    /* Modal */
    .fdv-lib-backdrop { position: fixed; inset: 0; z-index: 9998; display:none; background: rgba(0,0,0,.45); backdrop-filter: blur(2px); -webkit-backdrop-filter: blur(2px); }
    .fdv-lib-backdrop.show { display:block; }
    .fdv-lib-modal { position: fixed; z-index: 9999; inset: 8% 50% auto 50%; transform: translate(-50%, 0); width: min(960px, 94vw);
      max-height: 80vh; overflow: hidden; border-radius: 14px; background: linear-gradient(180deg, rgba(15,22,37,.96), rgba(15,22,37,.90));
      border: 1px solid rgba(122,222,255,.16); box-shadow: 0 24px 64px rgba(0,0,0,.55), inset 0 0 0 1px rgba(26,255,213,.05);
      color: var(--text); display: grid; grid-template-rows: auto 1fr auto; }
    .fdv-lib-header { display:flex; align-items:center; justify-content:space-between; gap:10px; padding:12px; border-bottom:1px solid rgba(122,222,255,.10); }
    .fdv-lib-title { font-size:16px; font-weight:800; }
    .fdv-lib-close { background:none; border:none; color:var(--text); font-size:22px; line-height:1; cursor:pointer; }
    .fdv-lib-tabs { display:flex; gap:6px; padding:10px 12px; }
    .fdv-lib-tab { padding:8px 12px; border-radius:10px; cursor:pointer; border:1px solid rgba(122,222,255,.12); background: rgba(255,255,255,.05); font-weight:700; }
    .fdv-lib-tab[aria-selected="true"] { border-color: rgba(26,255,213,.40); box-shadow: inset 0 0 0 1px rgba(26,255,213,.16); }
    .fdv-lib-body { padding:10px 12px 14px; overflow:auto; }
    .fdv-lib-footer { display:flex; justify-content:flex-end; gap:8px; padding:10px 12px; border-top:1px solid rgba(122,222,255,.10); background: linear-gradient(180deg, rgba(0,0,0,.00), rgba(0,0,0,.10)); }
    /* Grid */
    .fdv-lib-grid { display:grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap:10px; }
    @media (max-width: 900px){ .fdv-lib-grid { grid-template-columns: repeat(2, 1fr); } }
    @media (max-width: 560px){ .fdv-lib-grid { grid-template-columns: 1fr; } }
    .fdv-lib-card { display:flex; gap:10px; align-items:flex-start; padding:10px; border-radius:12px; background: linear-gradient(180deg, rgba(14,16,27,.95), rgba(0,0,0,.80)); border:1px solid rgba(122,222,255,.12); }
    .fdv-lib-logo { width:36px; height:36px; border-radius:10px; object-fit:cover; background:#0b111d; border:1px solid rgba(122,222,255,.20); }
    .fdv-lib-main { min-width:0; flex:1; display:flex; flex-direction:column; gap:6px; }
    .fdv-lib-line1 { display:flex; align-items:center; gap:8px; min-width:0; }
    .fdv-lib-sym { font-weight:800; }
    .fdv-lib-name { color:var(--muted); font-size:12px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
    .fdv-lib-actions { display:flex; align-items:center; gap:8px; flex-wrap:wrap; }
    .fdv-pill { display:inline-flex; align-items:center; gap:6px; padding:3px 8px; border-radius:999px; background: rgba(148,163,184,.10); border:1px solid rgba(122,222,255,.14); font-size:12px; }
    .fdv-pill.link { cursor:pointer; background: rgba(123,241,255,.06); border-color: rgba(122,222,255,.22); color: var(--muted); }
    .fdv-lib-table { width:100%; border-collapse:collapse; }
    .fdv-lib-table th, .fdv-lib-table td { padding:8px; text-align:left; border-bottom:1px solid rgba(122,222,255,.10); }
    .fdv-up { color:#19c37d; } .fdv-down { color:#ff6f6f; }
  `;
  const st = document.createElement("style");
  st.id = "fdvLibraryCss";
  st.textContent = css;
  document.head.appendChild(st);
}

function lockScroll(on) {
  try {
    const b = document.body;
    if (on) {
      if (b.dataset.scrollLocked) return;
      b.dataset.scrollLocked = "1";
      b.style.overflow = "hidden";
      b.style.paddingRight = `${window.innerWidth - document.documentElement.clientWidth}px`;
    } else {
      delete b.dataset.scrollLocked;
      b.style.overflow = "";
      b.style.paddingRight = "";
    }
  } catch {}
}

function setFavCount(mint, count) {
  document.querySelectorAll(`[data-fav-send][data-mint="${CSS.escape(mint)}"] .fdv-lib-count`)
    .forEach(el => { el.textContent = String(count); });
  // legacy buttons, if any
  document.querySelectorAll(`[data-fav-btn][data-mint="${CSS.escape(mint)}"] .fdv-lib-count`)
    .forEach(el => { el.textContent = String(count); });
}

function btnSvgHeart() {
  const i = document.createElement("span");
  i.className = "fdv-lib-heart";
  i.textContent = "❤️";
  return i;
}

function ensureModal() {
  // Allow reopening after close: if a backdrop exists without a modal, remove it and recreate.
  let backdrop = document.querySelector("[data-lib-backdrop]");
  const existingModal = document.getElementById("fdvLibModal");
  if (backdrop && existingModal) {
    // Already open; just ensure visible & scroll locked
    backdrop.classList.add("show");
    lockScroll(true);
    return;
  }
  if (backdrop && !existingModal) {
    // Stale backdrop from a previous session; remove so we can recreate cleanly
    backdrop.remove();
    backdrop = null;
  }

  backdrop = document.createElement("div");
  backdrop.className = "fdv-lib-backdrop";
  backdrop.setAttribute("data-lib-backdrop", "");

  const modal = document.createElement("div");
  modal.id = "fdvLibModal";
  modal.className = "fdv-lib-modal";
  modal.setAttribute("role", "dialog");
  modal.setAttribute("aria-modal", "true");
  modal.innerHTML = `
    <div class="fdv-lib-header">
      <div class="fdv-lib-title">Your Library</div>
      <button class="fdv-lib-close" data-lib-close aria-label="Close">&times;</button>
    </div>
    <div class="fdv-lib-tabs" role="tablist">
      <button class="fdv-lib-tab" role="tab" data-lib-tab="fav" aria-selected="true">Favorites</button>
      <button class="fdv-lib-tab" role="tab" data-lib-tab="cmp" aria-selected="false">Compare</button>
    </div>
    <div class="fdv-lib-body">
      <div data-lib-panel="fav"></div>
      <div data-lib-panel="cmp" hidden></div>
    </div>
    <div class="fdv-lib-footer">
      <button class="fdv-lib-tab" data-lib-refresh>Refresh</button>
      <button class="fdv-lib-tab" data-lib-close>Close</button>
    </div>
  `;

  document.body.appendChild(backdrop);
  document.body.appendChild(modal);

  const closeAll = () => {
    try { modal.remove(); } catch {}
    try { backdrop.remove(); } catch {}
    lockScroll(false);
  };

  backdrop.addEventListener("click", (e) => { if (e.target === backdrop) closeAll(); });
  modal.querySelectorAll("[data-lib-close]").forEach(b => b.addEventListener("click", closeAll));
  document.addEventListener("keydown", function escOnce(ev) {
    if (ev.key === "Escape") { closeAll(); document.removeEventListener("keydown", escOnce); }
  });

  modal.querySelectorAll("[data-lib-tab]").forEach(tab => {
    tab.addEventListener("click", () => {
      modal.querySelectorAll(".fdv-lib-tab").forEach(t => t.setAttribute("aria-selected", t === tab ? "true" : "false"));
      const sel = tab.getAttribute("data-lib-tab");
      modal.querySelectorAll("[data-lib-panel]").forEach(p => {
        p.hidden = p.getAttribute("data-lib-panel") !== sel;
      });
    });
  });

  modal.querySelector("[data-lib-refresh]")?.addEventListener("click", () => renderModalPanels(modal));

  backdrop.classList.add("show");
  lockScroll(true);
  renderModalPanels(modal);
}

function formatMoney(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return "—";
  if (v < 1000) return "$" + v.toFixed(2);
  return "$" + Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 2 }).format(v);
}
function formatPrice(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return "—";
  return v >= 1 ? `$${v.toLocaleString(undefined,{maximumFractionDigits:2})}` : `$${v.toFixed(8).replace(/0+$/,"").replace(/\.$/,"")}`;
}
function pctTxt(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return { t: "—", cls: "" };
  return { t: `${n>=0?"+":""}${n.toFixed(2)}%`, cls: n>=0 ? "fdv-up" : "fdv-down" };
}

async function renderModalPanels(modal) {
  const state = load();
  const list = state.order.map(m => state.items[m]).filter(Boolean);

  // Favorites panel
  const favEl = modal.querySelector('[data-lib-panel="fav"]');
  if (list.length === 0) {
    favEl.innerHTML = `<div style="opacity:.8;padding:10px;">No favorites yet. Tap the heart on a token card to add it.</div>`;
  } else {
    favEl.innerHTML = `
      <div class="fdv-lib-grid">
        ${list.map(it => `
          <div class="fdv-lib-card" data-mint="${it.mint}">
            <img class="fdv-lib-logo" src="${it.imageUrl || CFG.fallbackLogo || ""}" alt="" onerror="this.style.visibility='hidden'">
            <div class="fdv-lib-main">
              <div class="fdv-lib-line1">
                <div class="fdv-lib-sym">${it.symbol || "—"}</div>
                <div class="fdv-lib-name">${it.name || ""}</div>
              </div>
              <div class="fdv-lib-actions">
                <a class="fdv-pill link" href="/token/${encodeURIComponent(it.mint)}">Open</a>
                <button class="fdv-pill" data-lib-remove="${it.mint}">Remove</button>
              </div>
            </div>
          </div>
        `).join("")}
      </div>
    `;
    favEl.querySelectorAll("[data-lib-remove]").forEach(btn => {
      btn.addEventListener("click", () => toggleFavorite(btn.getAttribute("data-lib-remove"), { force: false }));
    });
  }

  const cmpEl = modal.querySelector('[data-lib-panel="cmp"]');
  if (list.length === 0) {
    cmpEl.innerHTML = `<div style="opacity:.8;padding:10px;">Add favorites to compare performance.</div>`;
  } else {
    cmpEl.innerHTML = `<div style="opacity:.8;padding:10px;">Loading comparison…</div>`;
    const rows = [];
    for (const it of list) {
      try {
        const t = await fetchTokenInfo(it.mint, { priority: true });
        const ch = (t.change24h ?? t.change1h ?? t.change5m ?? null);
        rows.push({
          mint: it.mint,
          symbol: it.symbol || t.symbol || "",
          name: it.name || t.name || "",
          imageUrl: it.imageUrl || t.imageUrl || "",
          price: t.priceUsd,
          chg: ch,
          liq: t.liquidityUsd,
          vol24: t.v24hTotal,
          fdv: (t.fdv ?? t.marketCap),
        });
      } catch {
        rows.push({
          mint: it.mint, symbol: it.symbol || "", name: it.name || "",
          imageUrl: it.imageUrl || "", price: null, chg: null, liq: null, vol24: null, fdv: null
        });
      }
    }
    rows.sort((a,b) => (Number(b.chg)||-1e9) - (Number(a.chg)||-1e9));

    cmpEl.innerHTML = `
      <table class="fdv-lib-table" role="table">
        <thead>
          <tr><th>Token</th><th>Price</th><th>24h</th><th>Liq</th><th>Vol 24h</th><th>FDV</th></tr>
        </thead>
        <tbody>
          ${rows.map(r => {
            const p = pctTxt(r.chg);
            return `
              <tr>
                <td>
                  <div style="display:flex;align-items:center;gap:8px;">
                    <img src="${r.imageUrl||""}" alt="" width="20" height="20" style="border-radius:6px;object-fit:cover;background:#0b111d" onerror="this.style.visibility='hidden'">
                    <a href="/token/${encodeURIComponent(r.mint)}">${r.symbol || "—"}</a>
                  </div>
                </td>
                <td>${formatPrice(r.price)}</td>
                <td class="${p.cls}">${p.t}</td>
                <td>${formatMoney(r.liq)}</td>
                <td>${formatMoney(r.vol24)}</td>
                <td>${formatMoney(r.fdv)}</td>
              </tr>
            `;
          }).join("")}
        </tbody>
      </table>
    `;
  }
}

async function sendFavorite(mint, action) {
  try {
    const r = await fetch(CFG.metricsBase + "/favorite", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        mint, action,
        path: location.pathname, href: location.href, referrer: document.referrer,
      }),
    });
    const j = await r.json().catch(() => ({}));
    if (typeof j?.favorites === "number") return j.favorites;
  } catch {}
  return null;
}
async function fetchFavCount(mint) {
  try {
    const u = new URL(CFG.metricsBase + "/favcount");
    u.searchParams.set("mint", mint);
    const r = await fetch(u.toString(), { method: "GET" });
    if (!r.ok) return 0;
    const j = await r.json().catch(() => null);
    return Number(j?.favorites || 0);
  } catch { return 0; }
}

export function initLibrary() {
  ensureStyles();
  if (!window.__fdvLibWired) {
    window.__fdvLibWired = true;
    document.addEventListener(EVT.CHANGE, () => {
      document.querySelectorAll("[data-fav-send],[data-fav-btn]").forEach(async (btn) => {
        const mint = btn.getAttribute("data-mint");
        syncButtonState(btn, mint);
        const c = await fetchFavCount(mint);
        const countEl = btn.querySelector(".fdv-lib-count");
        if (countEl) countEl.textContent = String(c);
      });
    });
  }
}

export function isFavorite(mint) {
  const s = load();
  return !!s.items[mint];
}

export function getFavorites() {
  const s = load();
  return s.order.map(m => s.items[m]).filter(Boolean);
}

export function openLibraryModal() {
  ensureStyles();
  ensureModal();
}

export function favoriteButtonHTML({ mint, symbol = "", name = "", imageUrl = "", className = "fdv-lib-btn" }) {
  // Back-compat alias to the new send-favorite button
  return sendFavoriteButtonHTML({ mint, symbol, name, imageUrl, className });
}

export function sendFavoriteButtonHTML({ mint, symbol = "", name = "", imageUrl = "", className = "fdv-lib-btn" }) {
  return `<button type="button" class="${className}" data-fav-send data-mint="${mint}" data-token-symbol="${symbol}" data-token-name="${name}" data-token-image="${imageUrl}">
    <span class="fdv-lib-heart" aria-hidden="true">❤️</span>
    <span class="fdv-lib-count">0</span>
  </button>`;
}

export function createSendFavoriteButton({ mint, symbol = "", name = "", imageUrl = "", className = "fdv-lib-btn" } = {}) {
  ensureStyles();
  const sel = `[data-fav-send][data-mint="${CSS.escape(mint)}"],[data-fav-btn][data-mint="${CSS.escape(mint)}"]`;
  const existing = document.querySelector(sel);
  if (existing) {
    existing.classList.add(className);
    existing.setAttribute("data-fav-send", "");
    existing.removeAttribute("data-fav-btn");
    if (symbol) existing.dataset.tokenSymbol = symbol;
    if (name) existing.dataset.tokenName = name;
    if (imageUrl) existing.dataset.tokenImage = imageUrl;
    wireSendFavoriteButton(existing);
    return existing;
  }

  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = className;
  btn.setAttribute("data-fav-send", "");
  btn.dataset.mint = mint;
  if (symbol) btn.dataset.tokenSymbol = symbol;
  if (name) btn.dataset.tokenName = name;
  if (imageUrl) btn.dataset.tokenImage = imageUrl;

  wireSendFavoriteButton(btn);
  return btn;
}

// Ensure a single wiring per element; upgrade legacy buttons in place
function wireSendFavoriteButton(btn) {
  if (btn.dataset.fdvlWired === "1") return;
  btn.dataset.fdvlWired = "1";
  if (!btn.querySelector(".fdv-lib-heart")) {
    btn.prepend(btnSvgHeart());
  }
  let count = btn.querySelector(".fdv-lib-count");
  if (!count) {
    count = document.createElement("span");
    count.className = "fdv-lib-count";
    count.textContent = "0";
    btn.appendChild(count);
  }
  const mint = btn.dataset.mint;
  syncButtonState(btn, mint);
  fetchFavCount(mint).then(c => { count.textContent = String(c); }).catch(()=>{});
  btn.addEventListener("click", async (e) => {
    e.stopPropagation();
    if (!mint || pendingFav.get(mint)) return;
    pendingFav.set(mint, true);
    btn.disabled = true;
    // ensure token saved locally
    if (!isFavorite(mint)) {
      const symbol = btn.dataset.tokenSymbol || "";
      const name = btn.dataset.tokenName || "";
      const imageUrl = btn.dataset.tokenImage || "";
      const s = load();
      s.items[mint] = { mint, symbol, name, imageUrl, addedAt: Date.now() };
      if (!s.order.includes(mint)) s.order.unshift(mint);
      save(s);
      emitChange();
      syncButtonState(btn, mint);
    }
    const favs = await sendFavorite(mint, "add");
    if (favs != null) setFavCount(mint, favs);
    else setFavCount(mint, await fetchFavCount(mint));
    pendingFav.delete(mint);
    btn.disabled = false;
  }, { once: false });
}

export function ensureSendFavoriteButton(container, opts) {
  const sel = `[data-fav-send][data-mint="${CSS.escape(opts.mint)}"],[data-fav-btn][data-mint="${CSS.escape(opts.mint)}"]`;
  const existing = container?.querySelector(sel);
  if (existing) {
    existing.setAttribute("data-fav-send", "");
    existing.removeAttribute("data-fav-btn");
    if (opts.symbol) existing.dataset.tokenSymbol = opts.symbol;
    if (opts.name) existing.dataset.tokenName = opts.name;
    if (opts.imageUrl) existing.dataset.tokenImage = opts.imageUrl;
    wireSendFavoriteButton(existing);
    return existing;
  }
  const btn = createSendFavoriteButton(opts);
  if (container) container.appendChild(btn);
  return btn;
}

export function createOpenLibraryButton({ label = "Favorites", className = "fdv-lib-btn" } = {}) {
  ensureStyles();
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = className;
  btn.setAttribute("data-open-library", "");
  btn.textContent = label;
  btn.addEventListener("click", (e) => { e.stopPropagation(); openLibraryModal(); });
  return btn;
}

export function bindFavoriteButtons(root = document) {
  ensureStyles();
  // de-dup count hydration per mint
  const mints = new Set();
  root.querySelectorAll("[data-fav-send],[data-fav-btn]").forEach((btn) => {
    const mint = btn.getAttribute("data-mint");
    syncButtonState(btn, mint);
    mints.add(mint);
    // ensure a count element exists
    let el = btn.querySelector(".fdv-lib-count");
    if (!el) {
      el = document.createElement("span");
      el.className = "fdv-lib-count";
      el.textContent = "0";
      btn.appendChild(el);
    }
  });
  // hydrate counts once per mint
  mints.forEach(async (mint) => {
    const c = await fetchFavCount(mint);
    document.querySelectorAll(`[data-fav-send][data-mint="${CSS.escape(mint)}"],[data-fav-btn][data-mint="${CSS.escape(mint)}"]`)
      .forEach((b) => { b.querySelector(".fdv-lib-count").textContent = String(c); });
  });

  root.addEventListener("click", (e) => {
    const el = e.target.closest("[data-fav-btn]");
    if (!el) return;
    const mint = el.getAttribute("data-mint");
    toggleFavorite(mint);
  });

  root.addEventListener("click", (e) => {
    const open = e.target.closest("[data-open-library]");
    if (!open) return;
    openLibraryModal();
  });
}

function syncButtonState(btn, mint) {
  const on = isFavorite(mint);
  btn.setAttribute("aria-pressed", on ? "true" : "false");
  btn.classList.toggle("on", on);
}

function toggleFavorite(mint, { force } = {}) {
  if (!mint) return;
  const s = load();
  const exists = !!s.items[mint];
  const nextOn = (force == null) ? !exists : !!force;

  if (nextOn && !exists) {
    const anyBtn = document.querySelector(`[data-fav-send][data-mint="${CSS.escape(mint)}"]`);
    const symbol = anyBtn?.dataset?.tokenSymbol || "";
    const name = anyBtn?.dataset?.tokenName || "";
    const imageUrl = anyBtn?.dataset?.tokenImage || "";

    s.items[mint] = { mint, symbol, name, imageUrl, addedAt: Date.now() };
    if (!s.order.includes(mint)) s.order.unshift(mint);
    save(s);
  } else if (!nextOn && exists) {
    delete s.items[mint];
    s.order = s.order.filter(m => m !== mint);
    save(s);
  }

  document.querySelectorAll(`[data-fav-send][data-mint="${CSS.escape(mint)}"],[data-fav-btn][data-mint="${CSS.escape(mint)}"]`).forEach((btn) => {
    syncButtonState(btn, mint);
  });
  (async () => {
    const action = nextOn ? "add" : "remove";
    const favs = await sendFavorite(mint, action);
    if (favs != null) {
      setFavCount(mint, favs);
    } else {
      setFavCount(mint, await fetchFavCount(mint));
    }
    emitChange();
  })();
}
