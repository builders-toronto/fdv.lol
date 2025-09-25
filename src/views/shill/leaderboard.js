export async function renderShillLeaderboardView({ mint } = {}) {
  const root = document.getElementById("app");
  const header = document.querySelector('.header');
  if (header) header.style.display = 'none';
  if (!root) return;

  await ensureShillStyles();

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

      <div class="shill__card">

      </div>

      <div class="shill__list">
        <h3>Top shills</h3>
        <p class="muted small"><b>${mint}</b> | <span class="note small" id="statusNote"></span></p>
        <div id="tableWrap" class="tableWrap">
          <div class="empty">Loading…</div>
        </div>
        <div class="form" style="display:flex; gap:8px; align-items:center; justify-content: space-between; flex-wrap:wrap; margin-block-start: 25px;">
        <div class="sill__table_actions">
          <button class="btn" id="btnRefresh">Refresh</button>
        </div>
        <div class="shill__livecontrol" style="display:flex; align-items:center; gap:4px;">
          <label for="autoRefresh" class="lbl small" style="margin-left:8px;">Auto-refresh</label>
          <input type="checkbox" id="autoRefresh" checked />
        </div>
        </div>
      </div>
    </section>
  `;

  const btnRefresh = document.getElementById("btnRefresh");
  const autoCb = document.getElementById("autoRefresh");
  const statusNote = document.getElementById("statusNote");
  const tableWrap = document.getElementById("tableWrap");

  const METRICS_BASE = String(window.__metricsBase || "https://fdv-lol-metrics.fdvlol.workers.dev").replace(/\/+$/,"");
  // Aggregates and dedupe state
  const agg = new Map();          // slug -> { views, ... }
  const seen = new Set();         // dedupe keys
  const MAX_SEEN = 200000;
  const SOL_ADDR_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

  // Sort state
  const SORTABLE = ["views","tradeClicks","swapStarts","walletConnects"];
  let sort = { key: "views", dir: "desc" };

  function sortList(list) {
    const k = sort.key;
    const dir = sort.dir === "asc" ? 1 : -1;
    return list.sort((a, b) => {
      const av = +a[k] || 0, bv = +b[k] || 0;
      if (av !== bv) return (av < bv ? -1 : 1) * dir;
      // tiebreakers
      if ((a.timeMs||0) !== (b.timeMs||0)) return ((a.timeMs||0) < (b.timeMs||0) ? -1 : 1) * -1; // favor higher dwell
      if (a.slug !== b.slug) return a.slug < b.slug ? -1 : 1;
      return 0;
    });
  }

  // Cache across refreshes within this view
  let lastEtag = "";
  let cacheAgg = new Map(); // slug -> {slug, owner, views, tradeClicks, swapStarts, walletConnects, timeMs}

  // Live tail control
  let tailAbort = null;
  let tailActive = false;

  // Throttled UI updates
  let updateRaf = 0;
  const scheduleUpdate = () => {
    if (updateRaf) return;
    updateRaf = requestAnimationFrame(() => {
      updateRaf = 0;
      const list = sortList([...agg.values()]).slice(0, 200);
      tableWrap.innerHTML = renderTable(list, mint, sort);
      statusNote.textContent = `${tailActive ? "Live" : "Updated"} ${new Date().toLocaleTimeString()}`;
    });
  };

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
    console.log(items);
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

  // Sort handlers (click + keyboard)
  tableWrap.addEventListener("click", (e) => {
    const th = e.target.closest?.('th[data-sort]');
    if (!th) return;
    const key = th.getAttribute('data-sort');
    if (!SORTABLE.includes(key)) return;
    sort = {
      key,
      dir: (sort.key === key && sort.dir === "desc") ? "asc" : "desc",
    };
    scheduleUpdate();
  });
  tableWrap.addEventListener("keydown", (e) => {
    const th = e.target.closest?.('th[data-sort]');
    if (!th) return;
    if (e.key !== "Enter" && e.key !== " ") return;
    e.preventDefault();
    const key = th.getAttribute('data-sort');
    if (!SORTABLE.includes(key)) return;
    sort = {
      key,
      dir: (sort.key === key && sort.dir === "desc") ? "asc" : "desc",
    };
    scheduleUpdate();
  });

  window.addEventListener("beforeunload", stopTail);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") stopTail();
    else if (autoCb.checked) startTail();
  });

  await refresh();
}

function renderTable(list, mint, sort) {
  const short = (w) => w ? `${w.slice(0,4)}…${w.slice(-4)}` : "—";
  const solscan = (w) => `https://solscan.io/account/${encodeURIComponent(w)}`;
  const t = (ms)=> {
    const s = Math.round((ms||0)/1000);
    const h = Math.floor(s/3600), m = Math.floor((s%3600)/60);
    return `${h}h ${m}m`;
  };
  const arrow = (k) => sort?.key === k ? (sort.dir === "desc" ? "▼" : "▲") : "";
  if (!list.length) return `<div class="empty">No data yet.</div>`;
  const rows = list.map((r) => `
    <tr>
      <td>${r.owner ? `<a href="${solscan(r.owner)}" target="_blank" rel="noopener" title="${r.owner}">${short(r.owner)}</a>` : "—"}</td>
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
      <table class="shill__table">
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
    </div>
  `;
}

function detectMintFromPath() {
  try {
    // support /leaderboard/<mint> and /shill/<mint>/leaderboard
    const p = location.pathname;
    let m = p.match(/^\/leaderboard\/([^/]+)/i);
    if (m) return decodeURIComponent(m[1]);
    m = p.match(/\/shill\/([^/]+)\/leaderboard/i);
    return m ? decodeURIComponent(m[1]) : "";
  } catch { return ""; }
}
async function ensureShillStyles() {
  const href = "/src/styles/shill.css";
  const id = "style-shill";
  let link = document.getElementById(id);
  if (!link) {
    link = [...document.querySelectorAll('link[rel="stylesheet"]')].find(l => {
      try { return (new URL(l.href, location.href)).pathname.endsWith("/src/styles/shill.css"); } catch { return false; }
    });
  }
  if (!link) {
    link = document.createElement("link");
    link.id = id; link.rel = "stylesheet"; link.href = href; link.media = "all";
    document.head.appendChild(link);
  } else {
    link.disabled = false;
    if (link.rel !== "stylesheet") link.rel = "stylesheet";
  }
  if (link.sheet && link.sheet.cssRules != null) return;
  await new Promise((resolve) => {
    let done = false;
    const finish = () => { if (!done) { done = true; resolve(); } };
    link.addEventListener("load", finish, { once: true });
    link.addEventListener("error", finish, { once: true });
    setTimeout(finish, 150);
  });
}