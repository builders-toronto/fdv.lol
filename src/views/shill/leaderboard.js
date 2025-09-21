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
          <p class="sub">Live stats for this tokens shill links.</p>

        </div>
        <div class="rhs">
          <a class="btn btn-ghost" data-link href="/token/${mint}">Back</a>
        </div>
      </header>

      <div class="shill__card">
        <div class="form" style="display:flex; gap:8px; align-items:center; flex-wrap:wrap;">
          <button class="btn" id="btnRefresh">Refresh</button>
          <label class="lbl small" style="margin-left:8px;">Auto-refresh</label>
          <input type="checkbox" id="autoRefresh" checked />
          <span class="note small" id="statusNote"></span>
        </div>
        <p class="muted small" style="margin-left: 8px;"><b>MINT:</b> ${mint}</p>
      </div>

      <div class="shill__list">
        <h3>Top shills</h3>
        <div id="tableWrap" class="tableWrap">
          <div class="empty">Loading…</div>
        </div>
      </div>
    </section>
  `;

  const btnRefresh = document.getElementById("btnRefresh");
  const autoCb = document.getElementById("autoRefresh");
  const statusNote = document.getElementById("statusNote");
  const tableWrap = document.getElementById("tableWrap");

  const METRICS_BASE = String(window.__metricsBase || "https://fdv-lol-metrics.fdvlol.workers.dev").replace(/\/+$/,"");

  async function refresh() {
    try {
      statusNote.textContent = "Fetching…";
      const res = await fetch(`${METRICS_BASE}/api/shill/ndjson?mint=${encodeURIComponent(mint)}`, { cache: "no-store" });
      if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);

      const agg = new Map(); // slug -> stats
      const dec = new TextDecoder();
      const reader = res.body.getReader();
      let buf = "";

      const apply = (evt) => {
        if (!evt || !evt.slug || !evt.event) return;
        const a = agg.get(evt.slug) || { slug: evt.slug, views:0, tradeClicks:0, swapStarts:0, walletConnects:0, timeMs:0 };
        switch (evt.event) {
          case "view": a.views += 1; break;
          case "trade_click": a.tradeClicks += 1; break;
          case "swap_start": a.swapStarts += 1; break;
          case "wallet_connect": a.walletConnects += 1; break;
          case "time_ms": a.timeMs += Number.isFinite(+evt.value) ? +evt.value : 0; break;
        }
        agg.set(evt.slug, a);
      };

      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        // process complete lines
        let idx;
        while ((idx = buf.indexOf("\n")) !== -1) {
          const line = buf.slice(0, idx).trim();
          buf = buf.slice(idx + 1);
          if (!line) continue;
          try { apply(JSON.parse(line)); } catch {}
        }
      }
      // flush any trailing line
      const tail = buf.trim();
      if (tail) { try { apply(JSON.parse(tail)); } catch {} }

      const list = [...agg.values()]
        .sort((a,b) =>
          (b.views - a.views) ||
          (b.timeMs - a.timeMs) ||
          (b.tradeClicks - a.tradeClicks) ||
          (b.swapStarts - a.swapStarts))
        .slice(0, 200);

      tableWrap.innerHTML = renderTable(list, mint);
      statusNote.textContent = `Updated ${new Date().toLocaleTimeString()}`;
    } catch (e) {
      tableWrap.innerHTML = `<div class="empty">Failed to load leaderboard. ${e?.message || "error"}</div>`;
      statusNote.textContent = "";
    }
  }

  btnRefresh.addEventListener("click", refresh);
  setInterval(() => { if (autoCb.checked && document.visibilityState === "visible") refresh(); }, 5000);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && autoCb.checked) refresh();
  });

  await refresh();
}

function renderTable(list, mint) {
  const t = (ms)=> {
    const s = Math.round((ms||0)/1000);
    const h = Math.floor(s/3600), m = Math.floor((s%3600)/60);
    return `${h}h ${m}m`;
  };
  if (!list.length) return `<div class="empty">No data yet.</div>`;
  const rows = list.map((r, i) => `
    <tr>
      <td>${i+1}</td>
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
            <th>#</th>
            <th>Slug</th>
            <th>Views</th>
            <th>Trade clicks</th>
            <th>Swap starts</th>
            <th>Wallet connects</th>
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
    const m = location.pathname.match(/\/shill\/([^/]+)\/leaderboard/i);
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