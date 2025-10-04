import { searchTokensGlobal } from "../../data/dexscreener.js";

let abortCtl = null;
let cache = new Map();          // query -> results[]
let current = [];
let activeIndex = -1;
let qEl, wrapEl, listEl;

const DEBOUNCE_MS = 140;
let debounceTimer = 0;

export function initSearchWidget() {
  wrapEl = document.getElementById("searchWrap");
  qEl    = document.getElementById("q");
  listEl = document.getElementById("qResults");
  if (!wrapEl || !qEl || !listEl) return;

  // ARIA roles
  listEl.setAttribute("role", "listbox");
  listEl.setAttribute("aria-label", "Token search suggestions");

  qEl.setAttribute("autocomplete","off");
  qEl.setAttribute("role","combobox");
  qEl.setAttribute("aria-autocomplete","list");
  qEl.setAttribute("aria-expanded","false");
  qEl.setAttribute("aria-haspopup","listbox");

  qEl.addEventListener("input", () => {
    scheduleFetch();
  });
  qEl.addEventListener("focus", () => {
    if (qEl.value.trim()) {
      scheduleFetch(true);
      showList();
    }
  });
  qEl.addEventListener("keydown", onKeyNav);
  document.addEventListener("click", (e) => {
    if (!wrapEl.contains(e.target)) hideList();
  });

  // Show container (was display:none)
  wrapEl.style.display = "";
}

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

  let head = [];
  if (looksLikeMint(q)) {
    head.push({ _direct: true, mint: q, symbol: "", name: "Go to token" });
  }

  let results = [];
  try {
    results = await searchTokensGlobal(q, { signal, limit: 12 }) || [];
  } catch {
    // ignore
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

  // Optional: highlight exact symbol match
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

export function focusSearch() {
  if (qEl) qEl.focus();
}

export function prefillAndSearch(text) {
  if (!qEl) return;
  qEl.value = text;
  scheduleFetch(true);
}

// Expose minimal API globally (optional)
if (typeof window !== "undefined") {
  window.fdvSearch = {
    init: initSearchWidget,
    focus: focusSearch,
    search: prefillAndSearch
  };
}