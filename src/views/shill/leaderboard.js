export async function renderShillLeaderboardView({ mint } = {}) {
  const root = document.getElementById("app");
  const header = document.querySelector('.header');
  if (header) header.style.display = 'none';
  if (!root) return;

  mint = mint || detectMintFromPath() || new URLSearchParams(location.search).get("mint") || "";
  if (!mint) {
    root.innerHTML = `<section class="shill__wrap"><p class="empty">No token provided.</p></section>`;
    return;
  }

  root.innerHTML = `
    <section class="shill__wrap">
      <header class="shill__header">
        <div class="lhs">
          <h1>Leaderboard</h1>
          <p class="sub">Live stats for this tokens shill links (weekly).</p>
        </div>
        <div class="rhs">
          <a class="btn btn-ghost" data-link href="/token/${mint}">Back</a>
        </div>
      </header>

      <div class="shill__list">
        <h3>Top shills</h3>
        <p class="muted small"><b>${mint}</b> | <span class="note small" id="statusNote"></span></p>

        <!-- Search by wallet -->
        <div class="form" style="display:flex; gap:8px; align-items:center; flex-wrap:wrap; margin: 20px 0 20px;">
          <input id="lbSearch" type="text" inputmode="latin" autocomplete="off" spellcheck="false"
                 placeholder="Search by wallet (base58)…"
                 style="flex:1 1 260px; min-width:200px; padding:10px 12px; border-radius:8px; border:1px solid rgba(255,255,255,.12); background:rgba(255,255,255,.04); color:inherit;">
          <button class="btn" id="lbSearchBtn">Search</button>
        </div>

        <div id="tableWrap" class="tableWrap">
          <div class="empty">Loading…</div>
        </div>
        <div class="form" style="display:flex; gap:8px; align-items:center; justify-content: space-between; flex-wrap:wrap; margin-block-start: 25px;">
          <div class="sill__table_actions" style="display:flex; gap:8px; align-items:center;">
            <button class="btn" id="btnRefresh">Refresh</button>
            <button class="btn btn-ghost" id="btnClearFilter" style="display:none;">Clear</button>
            <button class="btn" id="btnExportCsv">Export CSV</button>
          </div>
          <div class="shill__livecontrol" style="display:flex; align-items:center; gap:4px;">
            <label for="autoRefresh" class="lbl small" style="margin-left:8px;">Auto-refresh</label>
            <input type="checkbox" id="autoRefresh" checked />
          </div>
        </div>
      </div>
    </section>
  `;

  ensureLeaderboardModalStyles();
  ensureLeaderboardModalRoot();

  const btnRefresh = document.getElementById("btnRefresh");
  const btnClearFilter = document.getElementById("btnClearFilter");
  const btnExportCsv = document.getElementById("btnExportCsv");
  const autoCb = document.getElementById("autoRefresh");
  const statusNote = document.getElementById("statusNote");
  const tableWrap = document.getElementById("tableWrap");
  const lbSearch = document.getElementById("lbSearch");
  const lbSearchBtn = document.getElementById("lbSearchBtn");

  const METRICS_BASE = String(window.__metricsBase || "https://fdv-lol-metrics.fdvlol.workers.dev").replace(/\/+$/,"");
  // Aggregates and dedupe state
  const agg = new Map();          // slug -> { views, ... }
  const seen = new Set();         // dedupe keys
  const MAX_SEEN = 200000;
  const SOL_ADDR_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

  // Sort & filter state
  const SORTABLE = ["views","tradeClicks","swapStarts","walletConnects"];
  let sort = { key: "views", dir: "desc" };
  let filterWallet = ""; 
  let page = 1;
  const PAGE_SZ = 5;

  function exportLeaderboardCsv() {
    const base = [...agg.values()];
    const filtered = filterWallet ? base.filter(r => (r.owner||"").toLowerCase().includes(filterWallet)) : base;
    const sorted = sortList(filtered);
    const rows = sorted.map(r => ({
      owner: r.owner || "",
      slug: r.slug,
      views: r.views || 0,
      trade_clicks: r.tradeClicks || 0,
      swap_starts: r.swapStarts || 0,
      wallet_connects: r.walletConnects || 0,
      time_ms: r.timeMs || 0,
    }));
    const head = ["owner","slug","views","trade_clicks","swap_starts","wallet_connects","time_ms"];
    const esc = (v) => {
      const s = String(v ?? "");
      return /[",\n]/.test(s) ? `"${s.replace(/"/g,'""')}"` : s;
    };
    const lines = [head.join(",")].concat(rows.map(r => head.map(k => esc(r[k])).join(",")));
    const csv = lines.join("\n");
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const ts = new Date();
    const pad = (n)=>String(n).padStart(2,"0");
    const fname = `leaderboard-${mint}-${ts.getFullYear()}${pad(ts.getMonth()+1)}${pad(ts.getDate())}-${pad(ts.getHours())}${pad(ts.getMinutes())}${pad(ts.getSeconds())}.csv`;
    const a = document.createElement("a");
    a.href = url; a.download = fname; document.body.appendChild(a); a.click(); a.remove();
    URL.revokeObjectURL(url);
  }

  function sortList(list) {
    const k = sort.key;
    const dir = sort.dir === "asc" ? 1 : -1;
    return list.sort((a, b) => {
      const av = +a[k] || 0, bv = +b[k] || 0;
      if (av !== bv) return (av < bv ? -1 : 1) * dir;
      if ((a.timeMs||0) !== (b.timeMs||0)) return ((a.timeMs||0) < (b.timeMs||0) ? -1 : 1) * -1;
      if (a.slug !== b.slug) return a.slug < b.slug ? -1 : 1;
      return 0;
    });
  }

  // Throttled UI updates
  let updateRaf = 0;
  const scheduleUpdate = () => {
    if (updateRaf) return;
    updateRaf = requestAnimationFrame(() => {
      updateRaf = 0;
      const base = [...agg.values()];
      const filtered = filterWallet ? base.filter(r => (r.owner||"").toLowerCase().includes(filterWallet)) : base;
      const total = filtered.length;
      const sorted = sortList(filtered);
      const totalPages = Math.max(1, Math.ceil(total / PAGE_SZ));
      if (page > totalPages) page = totalPages;
      if (page < 1) page = 1;
      const start = (page - 1) * PAGE_SZ;
      const visible = sorted.slice(start, start + PAGE_SZ);
      tableWrap.innerHTML = renderTable(visible, mint, sort, filterWallet, page, PAGE_SZ, total);
      statusNote.textContent =
        `${tailActive ? "Live" : "Updated"} ${new Date().toLocaleTimeString()}`
        + (filterWallet ? ` • filter: ${filterWallet}` : "")
        + ` • ${total} result${total===1?"":"s"} • page ${page}/${totalPages}`;
    });
  };

  function runSearch() {
    const q = (lbSearch.value || "").trim();
    filterWallet = q.toLowerCase();
    page = 1; // reset to first page on search
    scheduleUpdate();
    // Auto-open if unique match
    if (q) {
      if (SOL_ADDR_RE.test(q)) {
        const hit = [...agg.values()].find(r => r.owner === q);
        if (hit) openMetricsModal({ mint, slug: hit.slug, owner: hit.owner });
      } else {
        const matches = [...agg.values()].filter(r => (r.owner||"").toLowerCase().includes(filterWallet));
        if (matches.length === 1) openMetricsModal({ mint, slug: matches[0].slug, owner: matches[0].owner });
      }
    }
  }
  lbSearchBtn.addEventListener("click", runSearch);
  lbSearch.addEventListener("keydown", (e) => { if (e.key === "Enter") runSearch(); });
  btnClearFilter.addEventListener("click", () => {
    filterWallet = "";
    lbSearch.value = "";
    page = 1;
    scheduleUpdate();
  });
  btnExportCsv.addEventListener("click", () => {
    try { exportLeaderboardCsv(); } catch (e) { console.error("CSV export failed", e); }
  });

  // Pagination controls (Prev/Next)
  tableWrap.addEventListener("click", (e) => {
    const nav = e.target.closest?.("[data-nav]");
    if (!nav) return;
    const dir = nav.getAttribute("data-nav");
    if (dir === "prev") page = Math.max(1, page - 1);
    if (dir === "next") page = page + 1; // clamped in scheduleUpdate()
    scheduleUpdate();
  });
  tableWrap.addEventListener("keydown", (e) => {
    const nav = e.target.closest?.("[data-nav]");
    if (!nav) return;
    if (e.key !== "Enter" && e.key !== " ") return;
    e.preventDefault();
    const dir = nav.getAttribute("data-nav");
    if (dir === "prev") page = Math.max(1, page - 1);
    if (dir === "next") page = page + 1;
    scheduleUpdate();
  });

  // Cache across refreshes within this view
  let lastEtag = "";
  let cacheAgg = new Map(); // slug -> {slug, owner, views, tradeClicks, swapStarts, walletConnects, timeMs}

  // Live tail control
  let tailAbort = null;
  let tailActive = false;

  function sevenDaysAgo() {
    const d = new Date(Date.now() - 7*24*3600*1000);
    return d.toISOString().slice(0,10);
  }

  async function fetchAllSlugs() {
    const items = [];
    let cursor = "";
    const since = sevenDaysAgo(); 

    for (let i = 0; i < 10; i++) {
      const url = `${METRICS_BASE}/api/shill/slugs?mint=${encodeURIComponent(mint)}&limit=2000&cursor=${encodeURIComponent(cursor)}&active=1&since=${encodeURIComponent(since)}`;
      const res = await fetch(url, { cache: "no-store" });
      if (!res.ok) break;
      const j = await res.json();
      if (Array.isArray(j.items)) items.push(...j.items);
      cursor = j.cursor || "";
      if (!cursor) break;
    }
    return items;
  }

  const apply = (evt) => {
    if (!evt || !evt.slug || !evt.event) return;

    // Dedupe: prefer server nonce; fallback to 1s time bucket
    let sec = 0;
    if (evt.ts) {
      const t = Date.parse(evt.ts);
      if (Number.isFinite(t)) sec = Math.floor(t / 1000);
    }
    const bucket = (Number.isFinite(+evt.nonce) && +evt.nonce > 0) ? `n:${+evt.nonce}` : `s:${sec}`;
    const key = `${evt.slug}|${evt.event}|${evt.ipHash||""}|${evt.uaHash||""}|${evt.path||""}|${bucket}`;
    if (seen.has(key)) return;
    if (seen.size > MAX_SEEN) seen.clear();
    seen.add(key);

    const a = agg.get(evt.slug) || { slug: evt.slug, owner: "", views:0, tradeClicks:0, swapStarts:0, walletConnects:0, timeMs:0 };
    const wid = evt.wallet_id || evt.owner || "";
    if (!a.owner && wid && SOL_ADDR_RE.test(String(wid))) a.owner = String(wid);
    switch (evt.event) {
      case "view": a.views += 1; break;
      case "trade_click": a.tradeClicks += 1; break;
      case "swap_start": a.swapStarts += 1; break;
      case "wallet_connect": a.walletConnects += 1; break;
      case "time_ms": {
        const v = Number.isFinite(+evt.value) ? +evt.value : 0;
        a.timeMs += v > 0 ? v : 0;
        break;
      }
    }
    agg.set(evt.slug, a);
    scheduleUpdate();
  };

  async function readNdjsonStream(body) {
    const dec = new TextDecoder();
    const reader = body.getReader();
    let buf = "";
    let firstChunk = true;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      if (firstChunk) {
        firstChunk = false;
        if (buf.charCodeAt(0) === 0xFEFF) buf = buf.slice(1); // strip BOM
      }
      let idx;
      while ((idx = buf.indexOf("\n")) !== -1) {
        let line = buf.slice(0, idx);
        buf = buf.slice(idx + 1);
        line = line.replace(/\r$/, "").trim();
        if (!line) continue;
        try { apply(JSON.parse(line)); } catch {}
      }
    }
    const tail = buf.replace(/\r$/, "").trim();
    if (tail) { try { apply(JSON.parse(tail)); } catch {} }
  }

  function stopTail() {
    try { tailAbort?.abort(); } catch {}
    tailAbort = null;
    tailActive = false;
  }

  async function startTail() {
    stopTail();
    tailAbort = new AbortController();
    const since = sevenDaysAgo();
    const url = `${METRICS_BASE}/api/shill/ndjson?mint=${encodeURIComponent(mint)}&since=${encodeURIComponent(since)}&tail=1`;
    const headers = { "Accept": "application/x-ndjson,application/json;q=0.5,*/*;q=0.1" };
    try {
      const res = await fetch(url, { cache: "no-store", headers, signal: tailAbort.signal });
      if (!res.ok || !res.body) return;
      tailActive = true;
      statusNote.textContent = "Live…";
      (async () => {
        try { await readNdjsonStream(res.body); }
        catch {}
        finally {
          tailActive = false;
          if (autoCb.checked) {
            // reconnect after short delay
            setTimeout(() => { if (autoCb.checked) startTail(); }, 1500);
          }
        }
      })();
    } catch {
      tailActive = false;
    }
  }

  async function refresh() {
    try {
      statusNote.textContent = "Fetching…";
      stopTail();
      agg.clear(); seen.clear();

      const owners = await fetchAllSlugs();
      const base = new Map();
      for (const { slug, wallet_id } of owners) {
        base.set(slug, {
          slug,
          owner: (wallet_id && SOL_ADDR_RE.test(wallet_id)) ? wallet_id : "",
          views: 0, tradeClicks: 0, swapStarts: 0, walletConnects: 0, timeMs: 0
        });
      }
      for (const v of base.values()) agg.set(v.slug, v);

      const since = sevenDaysAgo();
      const headers = { "Accept": "application/x-ndjson,application/json;q=0.5,*/*;q=0.1" };
      const url = `${METRICS_BASE}/api/shill/ndjson?mint=${encodeURIComponent(mint)}&since=${encodeURIComponent(since)}`;
      const res = await fetch(url, { cache: "no-store", headers });
      if (res.ok && res.body) {
        await readNdjsonStream(res.body);
      }

      cacheAgg = new Map(agg);
      scheduleUpdate();

      if (autoCb.checked) startTail();
      else statusNote.textContent = `Updated ${new Date().toLocaleTimeString()}`;
    } catch (e) {
      tableWrap.innerHTML = `<div class="empty">Failed to load leaderboard. ${e?.message || "error"}</div>`;
      statusNote.textContent = "";
    }
  }

  btnRefresh.addEventListener("click", refresh);
  autoCb.addEventListener("change", () => {
    if (autoCb.checked) startTail(); else stopTail();
  });

  // Row click → metrics modal
  tableWrap.addEventListener("click", (e) => {
    const a = e.target.closest?.("a,button");
    if (a) return; // let normal buttons/links work
    const tr = e.target.closest?.('tr[data-slug]');
    if (!tr) return;
    const slug = tr.getAttribute('data-slug');
    if (!slug) return;
    //get the owner from the agg map
    const entry = agg.get(slug);
    const owner = entry?.owner || "";
    openMetricsModal({ mint, slug, owner });
  });
  tableWrap.addEventListener("keydown", (e) => {
    const tr = e.target.closest?.('tr[data-slug]');
    if (!tr) return;
    if (e.key !== "Enter" && e.key !== " ") return;
    e.preventDefault();
    const slug = tr.getAttribute('data-slug');
    if (!slug) return;
    openMetricsModal({ mint, slug });
  });

  // Sort handlers (click + keyboard)
  tableWrap.addEventListener("click", (e) => {
    const th = e.target.closest?.('th[data-sort]');
    if (!th) return;
    const key = th.getAttribute('data-sort');
    if (!SORTABLE.includes(key)) return;
    sort = { key, dir: (sort.key === key && sort.dir === "desc") ? "asc" : "desc" };
    page = 1; // reset to first page on sort
    scheduleUpdate();
  });
  tableWrap.addEventListener("keydown", (e) => {
    const th = e.target.closest?.('th[data-sort]');
    if (!th) return;
    if (e.key !== "Enter" && e.key !== " ") return;
    e.preventDefault();
    const key = th.getAttribute('data-sort');
    if (!SORTABLE.includes(key)) return;
    sort = { key, dir: (sort.key === key && sort.dir === "desc") ? "asc" : "desc" };
    page = 1; // reset to first page on sort
    scheduleUpdate();
  });

  window.addEventListener("beforeunload", stopTail);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") stopTail();
    else if (autoCb.checked) startTail();
  });

  await refresh();
}

function renderTable(list, mint, sort, filterWallet = "", page = 1, pageSize = 5, total = 0) {
  const short = (w) => w ? `${w.slice(0,4)}…${w.slice(-4)}` : "—";
  const solscan = (w) => `https://solscan.io/account/${encodeURIComponent(w)}`;
  const t = (ms)=> {
    const s = Math.round((ms||0)/1000);
    const h = Math.floor(s/3600), m = Math.floor((s%3600)/60);
    return `${h}h ${m}m`;
  };
  const arrow = (k) => sort?.key === k ? (sort.dir === "desc" ? "▼" : "▲") : "";
  const f = (filterWallet||"").toLowerCase();
  const mark = (w) => {
    if (!w || !f) return w;
    const i = w.toLowerCase().indexOf(f);
    if (i < 0) return w;
    return `${w.slice(0,i)}<mark>${w.slice(i,i+f.length)}</mark>${w.slice(i+f.length)}`;
  };
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const atStart = page <= 1;
  const atEnd = page >= totalPages;

  if (!list.length) return `<div class="empty">No data yet.</div>`;
  const rows = list.map((r) => `
    <tr data-slug="${r.slug}" role="button" tabindex="0" class="clickable">
      <td>${r.owner ? `<a href="${solscan(r.owner)}" target="_blank" rel="noopener" title="${r.owner}">${mark(short(r.owner))}</a>` : "—"}</td>
      <td><code>${r.slug}</code></td>
      <td>${r.views}</td>
      <td>${r.tradeClicks}</td>
      <td>${r.swapStarts}</td>
      <td>${r.walletConnects}</td>
      <td>${t(r.timeMs)}</td>
      <td><a class="btn btn-ghost" href="/token/${mint}?ref=${r.slug}" target="_blank" rel="noopener">Open</a></td>
    </tr>
  `).join("");

  return `
    <div class="table-scroller">
      <table class="shill__table shill__table--interactive">
        <thead>
          <tr>
            <th>Wallet</th>
            <th>Slug</th>
            <th data-sort="views" class="sortable" role="button" tabindex="0" title="Sort by views">Views ${arrow("views")}</th>
            <th data-sort="tradeClicks" class="sortable" role="button" tabindex="0" title="Sort by trade clicks">Trade clicks ${arrow("tradeClicks")}</th>
            <th data-sort="swapStarts" class="sortable" role="button" tabindex="0" title="Sort by swap starts">Swap starts ${arrow("swapStarts")}</th>
            <th data-sort="walletConnects" class="sortable" role="button" tabindex="0" title="Sort by wallet connects">Wallet connects ${arrow("walletConnects")}</th>
            <th>Dwell</th>
            <th></th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
      <div class="pager" style="display:flex; align-items:center; justify-content:center; gap:8px; margin-top:8px;">
        <button class="btn btn-ghost" data-nav="prev" ${atStart ? "disabled" : ""} aria-label="Previous page">Prev</button>
        <span class="muted small">Page ${page} / ${totalPages}</span>
        <button class="btn" data-nav="next" ${atEnd ? "disabled" : ""} aria-label="Next page">Next</button>
      </div>
      <p class="muted small tip" style="padding:7px;">Tip: click a row to view full metrics.</p>
    </div>
  `;
}

// NEW: lightweight modal root + styles
function ensureLeaderboardModalRoot() {
  if (document.getElementById("lb-metrics-modal")) return;
  const wrap = document.createElement("div");
  wrap.id = "lb-metrics-modal";
  wrap.className = "lbm-backdrop";
  wrap.innerHTML = `
    <div class="lbm-modal" role="dialog" aria-modal="true" aria-labelledby="lbm-title">
      <button class="lbm-close" aria-label="Close">Close</button>
      <div class="lbm-body">
        <div class="lbm-header">
          <h3 id="lbm-title">Metrics</h3>
          <div class="lbm-sub" id="lbm-sub"></div>
          <p class="muted small lbm-owner" id="lbm-owner"></p>
        </div>
        <div id="lbm-content" class="lbm-content">
          <div class="lbm-empty">Loading…</div>
        </div>
      </div>
      <div class="lbm-footer">
        <a class="btn" id="lbm-open-token" target="_blank" rel="noopener">Open token</a>
      </div>
    </div>
  `;
  document.body.appendChild(wrap);
  const close = () => wrap.classList.remove("show");
  wrap.addEventListener("click", (e) => { if (e.target === wrap) close(); });
  wrap.querySelector(".lbm-close").addEventListener("click", close);
  // wrap.querySelector("#lbm-close-btn").addEventListener("click", close);
  document.addEventListener("keydown", (e) => { if (wrap.classList.contains("show") && e.key === "Escape") close(); });
}

// tack on css to improve performance
function ensureLeaderboardModalStyles() {
  if (document.getElementById("style-lbm")) return;
  const css = `
    .shill__table--interactive tbody tr.clickable { cursor: pointer; }
    .lbm-backdrop { position: fixed; inset: 0; background: rgba(0,0,0,.45); display:none; z-index: 1000; }
    .lbm-backdrop.show { display:block; }
    .lbm-modal { position: absolute; max-width: 980px; margin: 0 auto; left: 0; right: 0;
      background: var(--bg, #0b0b0c); color: var(--fg, #eaeaea); border-radius: 10px; border: 1px solid rgba(255,255,255,.08);
      box-shadow: 0 10px 28px rgba(0,0,0,.4); padding: 14px; }
    @media (min-width: 760px){ .lbm-modal { inset: 60px auto auto auto; } }
    /* Center on desktops */
    @media (min-width: 1024px){
      .lbm-backdrop.show { display:block; }
      .lbm-modal {
        position: fixed; top: 50%; left: 50%; right: auto; bottom: auto;
        transform: translate(-50%, -50%);
        width: min(980px, calc(100vw - 48px));
        max-height: min(90vh, 820px);
        overflow: auto;
      }
    }
    .lbm-close { position:absolute; top: 10px; right: 12px; background: transparent; color: inherit; border: 0; font-size: 22px; cursor: pointer; }
    .lbm-header { display:flex; flex-direction: column; align-items: baseline; justify-content: space-between; gap: 10px; margin-bottom: 10px; }
    .lbm-sub { opacity: .8; font-size: 12px; }
    .lbm-content { display:grid; grid-template-columns: 1fr; gap: 12px; }
    @media (min-width: 740px){ .lbm-content { grid-template-columns: 1fr 1fr; } }
    .kpi { display:flex; align-items: center; justify-content: space-between; background: rgba(255,255,255,.04); border: 1px solid rgba(255,255,255,.08);
      padding: 10px 12px; border-radius: 8px; }
    .kpi h4 { margin: 0; font-size: 13px; opacity: .9; }
    .kpi .v { font-weight: 600; font-size: 16px; }
    .lbm-grid { display:grid; grid-template-columns: 1fr 1fr; gap: 8px; }
    .lbm-list { background: rgba(255,255,255,.03); border: 1px solid rgba(255,255,255,.06); border-radius: 8px; padding: 10px; }
    .lbm-list h5 { margin: 0 0 6px 0; font-size: 12px; opacity: .8; }
    .lbm-list ul { list-style: none; margin: 0; padding: 0; display:grid; gap: 6px; }
    .lbm-list li { display:flex; justify-content: space-between; gap: 8px; font-size: 13px; }
    .lbm-footer { display:flex; align-items:center; justify-content: flex-end; gap: 8px; margin-top: 8px; }
    .lbm-empty { opacity: .8; padding: 20px; text-align:center; }
  `;
  const st = document.createElement("style");
  st.id = "style-lbm";
  st.textContent = css;
  document.head.appendChild(st);
}

// Open modal and render metrics for a slug
async function openMetricsModal({ mint, slug, owner = "" }) {
  const el = document.getElementById("lb-metrics-modal");
  if (!el) return;
  el.classList.add("show");
  const title = el.querySelector("#lbm-title");
  const sub = el.querySelector("#lbm-sub");
  const content = el.querySelector("#lbm-content");
  const ownerEl = el.querySelector("#lbm-owner");
  if (owner && /^([1-9A-HJ-NP-Za-km-z]{32,44})$/.test(owner)) {
    const url = `https://solscan.io/account/${encodeURIComponent(owner)}`;
    ownerEl.innerHTML = `Owner: <a href="${url}" target="_blank" rel="noopener">${owner.slice(0,4)}…${owner.slice(-4)}</a>`;
    ownerEl.style.display = "block";
  } else {
    ownerEl.style.display = "none";
    ownerEl.textContent = "";
  }
  const openToken = el.querySelector("#lbm-open-token");
  title.textContent = `Metrics: ${slug}`;
  sub.textContent = `Token: ${mint}`;
  openToken.href = `/token/${mint}?ref=${slug}`;
  content.innerHTML = `<div class="lbm-empty">Loading…</div>`;

  try {
    const data = await fetchSummaryForSlug({ mint, slug });
    if (!data) {
      content.innerHTML = `<div class="lbm-empty">No data available.</div>`;
      return;
    }
    content.innerHTML = renderMetricsContent({ slug, mint, s: data });
  } catch (e) {
    content.innerHTML = `<div class="lbm-empty">Failed to load. ${e?.message || "error"}</div>`;
  }
}

// Pull summary from metrics worker
async function fetchSummaryForSlug({ mint, slug, timeoutMs = 3000 }) {
  const METRICS_BASE = String(window.__metricsBase || "https://fdv-lol-metrics.fdvlol.workers.dev").replace(/\/+$/,"");
  const u = `${METRICS_BASE}/api/shill/summary?mint=${encodeURIComponent(mint)}&slug=${encodeURIComponent(slug)}`;
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(u, { cache: "no-store", signal: ctl.signal });
    if (!res.ok) return null;
    const j = await res.json();
    return j?.stats || j || null;
  } finally {
    clearTimeout(t);
  }
}

function renderMetricsContent({ slug, mint, s }) {
  const N = (v) => Number(v || 0);
  const pct = (num, den) => {
    const n = N(num), d = N(den);
    if (!d) return "—";
    return `${Math.round((n/d)*1000)/10}%`;
  };
  const t = (ms)=> {
    const s = Math.round((ms||0)/1000);
    const h = Math.floor(s/3600), m = Math.floor((s%3600)/60);
    return `${h}h ${m}m`;
  };
  const safe = {
    views: N(s.views), tradeClicks: N(s.tradeClicks), swapStarts: N(s.swapStarts),
    walletConnects: N(s.walletConnects), timeMs: N(s.timeMs),
    swapQuotes: N(s.swapQuotes), swapsSent: N(s.swapsSent), swapsConfirmed: N(s.swapsConfirmed),
    verifyStart: N(s.verifyStart), verifyOk: N(s.verifyOk), verifyFail: N(s.verifyFail),
    openSwapModal: N(s.openSwapModal), copyClicks: N(s.copyClicks), shareClicks: N(s.shareClicks),
    externalClicks: N(s.externalClicks), buttonClicks: N(s.buttonClicks), refreshClicks: N(s.refreshClicks),
    streamToggles: N(s.streamToggles), sortChanges: N(s.sortChanges), searches: N(s.searches),
    suggestionClicks: N(s.suggestionClicks), scrollDepthMax: N(s.scrollDepthMax),
  };

  const avgDwell = safe.views ? Math.round(safe.timeMs / safe.views) : 0;
  const kpi = {
    viewToTradeCTR: pct(safe.tradeClicks, safe.views),
    viewToSwapStart: pct(safe.swapStarts, safe.views),
    viewToConnect: pct(safe.walletConnects, safe.views),
    quotePerView: pct(safe.swapQuotes, safe.views),
    sendPerStart: pct(safe.swapsSent, safe.swapStarts),
    confirmPerSend: pct(safe.swapsConfirmed, safe.swapsSent),
    verifySuccess: pct(safe.verifyOk, safe.verifyStart),
    overallConfirmRate: pct(safe.swapsConfirmed, safe.views),
    avgDwell: t(avgDwell),
  };

  return `
    <div class="lbm-grid" style="grid-template-columns: 1.2fr .8fr;">
      <div>
        <div class="kpi"><h4>Views → Trade CTR</h4><div class="v">${kpi.viewToTradeCTR}</div></div>
        <div class="kpi"><h4>Views → Swap starts</h4><div class="v">${kpi.viewToSwapStart}</div></div>
        <div class="kpi"><h4>Views → Wallet connects</h4><div class="v">${kpi.viewToConnect}</div></div>
        <div class="kpi"><h4>Quote per view</h4><div class="v">${kpi.quotePerView}</div></div>
        <div class="kpi"><h4>Send per start</h4><div class="v">${kpi.sendPerStart}</div></div>
        <div class="kpi"><h4>Confirm per send</h4><div class="v">${kpi.confirmPerSend}</div></div>
        <div class="kpi"><h4>Verify success</h4><div class="v">${kpi.verifySuccess}</div></div>
        <div class="kpi"><h4>Overall confirm rate</h4><div class="v">${kpi.overallConfirmRate}</div></div>
        <div class="kpi"><h4>Avg dwell per view</h4><div class="v">${kpi.avgDwell}</div></div>
      </div>
      <div class="lbm-list">
        <h5>Counts</h5>
        <ul>
          <li><span>Views</span><span>${safe.views}</span></li>
          <li><span>Trade clicks</span><span>${safe.tradeClicks}</span></li>
          <li><span>Swap starts</span><span>${safe.swapStarts}</span></li>
          <li><span>Wallet connects</span><span>${safe.walletConnects}</span></li>
          <li><span>Quotes</span><span>${safe.swapQuotes}</span></li>
          <li><span>Swaps sent</span><span>${safe.swapsSent}</span></li>
          <li><span>Swaps confirmed</span><span>${safe.swapsConfirmed}</span></li>
          <li><span>Verify start</span><span>${safe.verifyStart}</span></li>
          <li><span>Verify ok</span><span>${safe.verifyOk}</span></li>
          <li><span>Verify fail</span><span>${safe.verifyFail}</span></li>
          <li><span>Dwell (total)</span><span>${t(safe.timeMs)}</span></li>
        </ul>
      </div>
    </div>

    <div class="lbm-grid" style="margin-top:10px;">
      <div class="lbm-list">
        <h5>Engagement</h5>
        <ul>
          <li><span>Open swap modal</span><span>${safe.openSwapModal}</span></li>
          <li><span>Copy (mint/CA)</span><span>${safe.copyClicks}</span></li>
          <li><span>Share clicks</span><span>${safe.shareClicks}</span></li>
          <li><span>External clicks</span><span>${safe.externalClicks}</span></li>
          <li><span>Buttons clicked</span><span>${safe.buttonClicks}</span></li>
        </ul>
      </div>
      <div class="lbm-list">
        <h5>Page interactions</h5>
        <ul>
          <li><span>Refresh clicks</span><span>${safe.refreshClicks}</span></li>
          <li><span>Stream toggles</span><span>${safe.streamToggles}</span></li>
          <li><span>Sort changes</span><span>${safe.sortChanges}</span></li>
          <li><span>Searches</span><span>${safe.searches}</span></li>
          <li><span>Suggestion clicks</span><span>${safe.suggestionClicks}</span></li>
          <li><span>Max scroll depth</span><span>${safe.scrollDepthMax}%</span></li>
        </ul>
      </div>
    </div>
  `;
}