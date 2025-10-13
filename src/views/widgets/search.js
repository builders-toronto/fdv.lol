import { searchTokensGlobal } from "../../data/dexscreener.js";

let abortCtl = null;
let cache = new Map();          // query -> results[]
let current = [];
let activeIndex = -1;
let qEl, wrapEl, listEl, openBtn, closeBtn;

const DEBOUNCE_MS = 140;
let debounceTimer = 0;

let isOpen = false;
let idleTimer = 0;
const IDLE_RELEASE_MS = 1500;

(function injectSearchStyles(){
  if (document.getElementById("fdv-search-css")) return;
  const css = `
  .fdv-search-wrap{position:fixed;inset:0;display:none;z-index:9999;background: rgba(0, 0, 0, 1);}
  .fdv-search-wrap.open{display:block}
  .fdv-search-panel{position:absolute;left:50%;top:10%;transform:translateX(-50%);
    width:min(920px,96vw);background:#0b0e12;border:1px solid #1b2026;border-radius:14px;
    box-shadow:0 10px 30px rgba(0,0,0,.4);padding:14px}
  .fdv-search-head{display:flex;align-items:center;gap:10px}
  .fdv-search-input{flex:1;background:#0f141a;border:1px solid #2a2f36;color:#e6ecf0;
    border-radius:10px;padding:10px 12px;font-size:15px}
  .fdv-search-close{flex:0 0 auto;background:#1b2026;border:1px solid #2a2f36;color:#9aa7b2;
    border-radius:8px;padding:8px 10px;cursor:pointer}
  .fdv-search-results{margin-top:10px;max-height:min(54vh,500px);overflow:auto;border:1px solid #1b2026;
    border-radius:10px;background:#0f141a}
  .fdv-search-results .row{display:flex;gap:10px;padding:10px 12px;color:#cfd9e3;text-decoration:none;border-bottom:1px solid #151b22}
  .fdv-search-results .row:last-child{border-bottom:none}
  .fdv-search-results .row.is-active{background:#17202a}
  .fdv-search-results .empty{padding:12px;color:#8b98a5}
  `;
  const s = document.createElement("style");
  s.id = "fdv-search-css";
  s.textContent = css;
  document.head.appendChild(s);
})();

export function initSearch() {
  openBtn  = document.querySelector("[data-search-open]") || document.getElementById("searchBtn") || document.getElementById("searchIcon");
  if (openBtn) openBtn.addEventListener("click", openSearchPanel);

  ensurePanelDom();
  if (!wrapEl || !qEl || !listEl) return;

  listEl.setAttribute("role", "listbox");
  listEl.setAttribute("aria-label", "Token search suggestions");

  qEl.setAttribute("autocomplete","off");
  qEl.setAttribute("role","combobox");
  qEl.setAttribute("aria-autocomplete","list");
  qEl.setAttribute("aria-expanded","false");
  qEl.setAttribute("aria-haspopup","listbox");

  qEl.addEventListener("input", () => {
     scheduleFetch();
     bumpIdleTimer();
  });
  qEl.addEventListener("focus", () => {
    if (qEl.value.trim()) {
      scheduleFetch(true);
      showList();
    }
  });
  qEl.addEventListener("keydown", onKeyNav);

  wrapEl.addEventListener("click", (e) => {
    if (e.target === wrapEl) closeSearchPanel();
  });
  document.addEventListener("keydown", (e) => {
    if (isOpen && e.key === "Escape") {
      e.preventDefault();
      closeSearchPanel();
    }
  });
  document.addEventListener("click", (e) => {
    if (!wrapEl.contains(e.target)) return;
    const panel = wrapEl.querySelector(".fdv-search-panel");
    if (panel && !panel.contains(e.target)) hideList();
  });

  wrapEl.style.display = "";

  // Auto-open when URL hash is #search
  if (typeof location !== "undefined") {
    const maybeOpen = () => {
      if (location.hash === "#search") requestAnimationFrame(() => openSearchPanel());
    };
    maybeOpen();
    window.addEventListener("hashchange", maybeOpen);
  }
}

function ensurePanelDom() {
  wrapEl = document.getElementById("searchWrap");
  qEl    = document.getElementById("q");
  listEl = document.getElementById("qResults");

  if (!wrapEl) {
    wrapEl = document.createElement("div");
    wrapEl.id = "searchWrap";
    wrapEl.className = "fdv-search-wrap";
    document.body.appendChild(wrapEl);
  }
  let panel = wrapEl.querySelector(".fdv-search-panel");
  if (!panel) {
    panel = document.createElement("div");
    panel.className = "fdv-search-panel";
    panel.innerHTML = `
      <div class="fdv-search-head">
        <input id="q" class="fdv-search-input" type="text" placeholder="Search tokens, symbols or mint address…" />
        <button type="button" class="fdv-search-close" data-search-close>Close</button>
      </div>
      <div id="qResults" class="fdv-search-results" hidden></div>
    `;
    wrapEl.appendChild(panel);
  }
  qEl    = panel.querySelector("#q");
  listEl = panel.querySelector("#qResults");
  closeBtn = panel.querySelector("[data-search-close]");
  if (closeBtn) closeBtn.addEventListener("click", closeSearchPanel);
}

function openSearchPanel() {
  if (!wrapEl) ensurePanelDom();
  wrapEl.classList.add("open");
  isOpen = true;
  if (qEl) {
    qEl.focus();
    qEl.select?.();
  }
}

function closeSearchPanel() {
  isOpen = false;
  wrapEl?.classList.remove("open");
  hideList();
  clearIdleTimer();
}

function bumpIdleTimer() {
  clearIdleTimer();
  idleTimer = setTimeout(() => {
    if (!isOpen) clearIdleTimer();
  }, IDLE_RELEASE_MS);
}
function clearIdleTimer(){ if (idleTimer) { clearTimeout(idleTimer); idleTimer = 0; } }


function scheduleFetch(immediate = false) {
  if (debounceTimer) clearTimeout(debounceTimer);
  if (immediate) {
    runQuery(qEl.value);
    return;
  }
  debounceTimer = setTimeout(() => runQuery(qEl.value), DEBOUNCE_MS);
}

function looksLikeMint(s) {
  if (!s) return false;
  const x = s.trim();
  if (x.length < 30 || x.length > 48) return false;
  return /^[1-9A-HJ-NP-Za-km-z]+$/.test(x);
}

function tokenHref(mint) {
  return `/token/${encodeURIComponent(mint)}`;
}

async function runQuery(raw) {
  const q = (raw || "").trim();
  if (!q) {
    clearList();
    return;
  }

  const key = q.toLowerCase();
  if (cache.has(key)) {
    render(cache.get(key), q);
    return;
  }

  if (abortCtl) abortCtl.abort();
  abortCtl = new AbortController();
  const { signal } = abortCtl;

  listEl.hidden = false;
  listEl.innerHTML = `<div class="empty">Searching…</div>`;
  qEl.setAttribute("aria-expanded","true");

  let head = [];
  if (looksLikeMint(q)) {
    head.push({ _direct: true, mint: q, symbol: "", name: "Go to token" });
  }

  let results = [];
  try {
    results = await searchTokensGlobal(q, { signal, limit: 12 }) || [];
  } catch {
  }
  if (signal.aborted) return;

  const merged = [
    ...head,
    ...results.map(r => ({
      mint: r.mint,
      symbol: r.symbol,
      name: r.name,
      dexId: r.dexId,
      priceUsd: r.priceUsd,
      liquidityUsd: r.bestLiq,
      imageUrl: r.imageUrl
    }))
  ];
  cache.set(key, merged);
  render(merged, q);
}

function clearList() {
  current = [];
  activeIndex = -1;
  if (listEl) {
    listEl.innerHTML = "";
    listEl.hidden = true;
  }
  if (qEl) qEl.setAttribute("aria-expanded","false");
}

function showList() {
  if (!listEl) return;
  listEl.hidden = false;
  if (qEl) qEl.setAttribute("aria-expanded","true");
}

function hideList() {
  clearList();
}

function render(list, q) {
  current = list;
  activeIndex = -1;
  listEl.innerHTML = "";
  if (!list.length) {
    listEl.innerHTML = `<div class="empty">No matches. Try a full mint address.</div>`;
    showList();
    return;
  }

  const frag = document.createDocumentFragment();
  list.forEach((it, i) => {
    const a = document.createElement("a");
    a.className = "row";
    a.href = tokenHref(it.mint);
    a.setAttribute("data-mint", it.mint);
    a.setAttribute("role","option");
    a.id = `sr-${i}`;
    a.innerHTML = `
      <div class="sym">${escapeHtml(it.symbol || "—")}</div>
      <div class="name">
        ${escapeHtml(it.name || "")}
        <div class="mint">${escapeHtml(it.mint)}</div>
      </div>
      <div class="badge">${it._direct ? "Open" : (it.dexId || "View")}</div>
    `;
    a.addEventListener("mousedown", (ev) => {
      ev.preventDefault();
      window.location.href = a.href;
    });
    frag.appendChild(a);
  });
  listEl.appendChild(frag);
  showList();
  qEl.setAttribute("aria-activedescendant","");

  if (q.length && /[a-z0-9]/i.test(q)) {
    const exactIdx = current.findIndex(r => (r.symbol || "").toLowerCase() === q.toLowerCase());
    if (exactIdx >= 0) setActive(exactIdx);
  }
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => (
    { "&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#39;" }[c]
  ));
}

function onKeyNav(e) {
  if (!current.length) {
    if (e.key === "ArrowDown") {
      scheduleFetch(true);
      e.preventDefault();
    } else if (e.key === "Escape") {
      closeSearchPanel();
    }
    return;
  }
  if (e.key === "ArrowDown") {
    e.preventDefault();
    setActive((activeIndex + 1) % current.length);
  } else if (e.key === "ArrowUp") {
    e.preventDefault();
    setActive((activeIndex - 1 + current.length) % current.length);
  } else if (e.key === "Enter") {
    if (activeIndex >= 0 && current[activeIndex]) {
      e.preventDefault();
      window.location.href = tokenHref(current[activeIndex].mint);
    }
  } else if (e.key === "Escape") {
    hideList();
    closeSearchPanel();
  }
}

function setActive(idx) {
  const rows = [...listEl.querySelectorAll(".row")];
  rows.forEach(r => r.classList.remove("is-active"));
  activeIndex = idx;
  const el = rows[idx];
  if (el) {
    el.classList.add("is-active");
    qEl.setAttribute("aria-activedescendant", el.id);
    // Ensure visible
    const rTop = el.offsetTop;
    const rBottom = rTop + el.offsetHeight;
    if (rTop < listEl.scrollTop) listEl.scrollTop = rTop;
    else if (rBottom > listEl.scrollTop + listEl.clientHeight) {
      listEl.scrollTop = rBottom - listEl.clientHeight;
    }
  }
}

(function wireGlobalOpenSearchButtons(){
  if (window.__fdvSearchBtnWired) return;
  window.__fdvSearchBtnWired = true;
  document.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-search-open],[data-open-search]");
    if (!btn) return;
    e.preventDefault();
    openSearchPanel();
  });
})();

export function createOpenSearchButton({ label = "Search", className = "fdv-lib-btn" } = {}) {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = className;
  btn.setAttribute("data-search-open", "");
  btn.textContent = label;
  btn.addEventListener("click", (e) => { e.stopPropagation(); openSearchPanel(); });
  return btn;
}

export function ensureOpenSearchButton(container, { label = "Search", className = "fdv-lib-btn" } = {}) {
  const sel = "[data-search-open],[data-open-search]";
  const existing = container?.querySelector(sel);
  if (existing) {
    existing.setAttribute("data-search-open", "");
    existing.classList.add(className);
    if (!existing.dataset.fdvsWired) {
      existing.addEventListener("click", (e) => { e.stopPropagation(); openSearchPanel(); });
      existing.dataset.fdvsWired = "1";
    }
    if (!existing.textContent.trim()) existing.textContent = label;
    return existing;
  }
  const btn = createOpenSearchButton({ label, className });
  if (container) container.appendChild(btn);
  return btn;
}

export function bindOpenSearchButtons(root = document) {
  root.querySelectorAll("[data-search-open],[data-open-search]").forEach((btn) => {
    if (btn.dataset.fdvsWired === "1") return;
    btn.dataset.fdvsWired = "1";
    btn.addEventListener("click", (e) => { e.stopPropagation(); openSearchPanel(); });
  });
}

if (typeof window !== "undefined") {
  window.fdvSearch = Object.assign(window.fdvSearch || {}, {
    createButton: createOpenSearchButton,
    ensureButton: ensureOpenSearchButton,
    bindButtons: bindOpenSearchButtons,
  });
}