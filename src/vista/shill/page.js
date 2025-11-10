import { fetchProfileMetrics } from "../../analytics/shill.js";

async function renderProfileMetrics(mint) {
  console.log("renderProfileMetrics called");
  try {
    console.log("renderProfileMetrics", { mint });
    if (!mint) return;
    const wrap = document.getElementById("profileMetrics");
    if (!wrap) return;
    const totalEl = document.getElementById("pmTotal");
    const todayEl = document.getElementById("pmToday");
    const last7El = document.getElementById("pm7d");
    const infoEl = document.getElementById("pmInfo");

    const m = await fetchProfileMetrics({ mint, sinceDays: 14, timeoutMs: 6000 });
    console.log("profile metrics", m);
    if (!m) { wrap.hidden = true; return; }

    totalEl.textContent = String(m.total || 0);
    todayEl.textContent = String(m.today || 0);
    last7El.textContent = String(m.last7 || 0);
    infoEl.textContent = `Since ${m.since}${m.lastTs ? ` • last: ${new Date(m.lastTs).toLocaleString()}` : ""}`;
    wrap.hidden = false;
  } catch (e) {
    const wrap = document.getElementById("profileMetrics");
    if (wrap) wrap.hidden = true;
    console.log("error rendering profile metrics", e);
  }
}

export async function renderShillContestView(input) {
  const elHeader = document.querySelector(".header");
  if (elHeader) elHeader.style.display = "none";
  const root = document.getElementById("app");
  if (!root) return;

  await ensureShillStyles();

  const mint = new URLSearchParams(location.search).get("mint")
    || (typeof input === "string" ? input : input?.mint);

  // Solana base58 pubkey: 32–44 chars, no 0,O,I,l
  const SOL_ADDR_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

  root.innerHTML = `
    <section class="shill__wrap">
      ${mint ? `
      <div class="shill__metrics" id="profileMetrics" hidden>
        <h3>Profile page metrics</h3>
        <div class="rows" style="display:flex;gap:16px;flex-wrap:wrap">
          <div class="metric"><span class="lbl">Total visits</span> <span class="val" id="pmTotal">—</span></div>
          <div class="metric"><span class="lbl">Today</span> <span class="val" id="pmToday">—</span></div>
          <div class="metric"><span class="lbl">Last 7d</span> <span class="val" id="pm7d">—</span></div>
        </div>
        <div class="mini" id="pmInfo" style="opacity:.75;margin-top:6px"></div>
      </div>` : ""}
      <header class="shill__header">
        <div class="lhs">
          <h1>Shill</h1>
          <p class="sub">Generate your personal link.</p>
        </div>
        <div class="rhs">
          ${mint ? `<a class="btn btn-ghost" data-link href="/token/${mint}">Back</a>` : ""}
        </div>
      </header>

      <div class="shill__card">
        <div class="form">
          <label class="lbl">Wallet Address</label>
          <input class="in" type="text" id="shillHandle" placeholder="@wallet_address" />
          <button class="btn btn--primary" id="btnGen">Generate my link</button>
        </div>

        <div class="note small" id="limitNote"></div>

        <div class="out" id="out" hidden>
          <label class="lbl">Your link</label>
          <div class="linkrow">
            <input class="in" type="text" id="shillLink" readonly />
            <button class="btn" id="btnCopy">Copy</button>
          </div>
          <p class="hint">Share this link anywhere. Max 3 links per wallet.</p>
        </div>
      </div>

      <div class="shill__list" id="shillList" hidden>
        <h3>Your links for this token</h3>
        <div id="links"></div>
      </div>

      <div class="shill__tools">
        ${mint ? `<button class="btn btn--primary" id="btnExportCsvEnc">Export CSV</button>` : ""}
        ${mint ? `<a class="btn" data-link href="/leaderboard/${mint}">Leaderboard</a>` : ""}
      </div>
    </section>
  `;

  // renderProfileMetrics(mint);

  const mod = await import("../../analytics/shill.js");
  const {
    makeShillShortlink,
    listShillLinks,
    canCreateShillLink,
  } = mod;

  const handleIn = document.getElementById("shillHandle");
  const out = document.getElementById("out");
  const linkIn = document.getElementById("shillLink");
  const links = document.getElementById("links");
  const btnGen = document.getElementById("btnGen");
  const limitNote = document.getElementById("limitNote");
  const listWrap = document.getElementById("shillList");

  const ownerIdOf = (h) => (h || "").trim();

  function isValidSolAddr(s) { return SOL_ADDR_RE.test(ownerIdOf(s)); }

  function updateLimitUI() {
    const owner = ownerIdOf(handleIn.value);
    const valid = isValidSolAddr(owner);
    handleIn.setCustomValidity(valid ? "" : "Invalid Solana address");
    limitNote.textContent = valid ? "" : "";
    let remaining = 0;
    if (valid) ({ remaining } = canCreateShillLink({ owner }));
    btnGen.disabled = !valid || remaining <= 0;
    if (valid) {
      limitNote.textContent = remaining > 0
        ? `You can create ${remaining} more link${remaining === 1 ? "" : "s"}.`
        : "Link limit reached (3 per user).";
    }
  }

  const renderList = async () => {
    const owner = ownerIdOf(handleIn.value);
    const valid = isValidSolAddr(owner);
    if (listWrap) listWrap.hidden = true;
    if (links) links.innerHTML = "";
    try {
      const rows = await listShillLinks({ mint, owner: valid ? owner : "" });
      if (Array.isArray(rows) && rows.length > 0) {
        const html = rows.map(r => `
          <div class="shill__row" data-slug="${r.slug}">
            <div class="url"><a href="${r.url}" target="_blank" rel="noopener">${r.url}</a></div>
            <code class="slug">${r.slug}</code>
            <div class="stats">
              <span title="Views">👁️ ${r.stats.views}</span>
              <span title="Trade clicks">🛒 ${r.stats.tradeClicks}</span>
              <span title="Swap starts">🔁 ${r.stats.swapStarts}</span>
              <span title="Wallet connects">💼 ${r.stats.walletConnects}</span>
            </div>
            <div class="shill__tab_actions">
              <button class="btn btn-ghost btn--danger" data-del-shill data-slug="${r.slug}" data-owner-id="${r.ownerId || ""}" title="Delete link">🗑️ Delete</button>
            </div>  
            <code class="wallet slug url">${r.wallet_id || "—"}</code>    
          </div>
        `).join("");
        links.innerHTML = html;
        listWrap.hidden = false;
      } else {
        links.innerHTML = "";
        listWrap.hidden = true;
      }
    } catch {
      links.innerHTML = "";
      listWrap.hidden = true;
    }
  };

  btnGen.addEventListener("click", async () => {
    try {
      const owner = ownerIdOf(handleIn.value);
      if (!isValidSolAddr(owner)) { handleIn.reportValidity(); handleIn.focus(); return; }
      const { url } = await makeShillShortlink({ mint, wallet_id: owner });
      out.hidden = false;
      linkIn.value = url;
      await renderList();
      updateLimitUI();
    } catch (e) {
      let noteMessage = document.querySelector(".shill__card .note");
      if (e?.code === "LIMIT") {
        updateLimitUI();
        noteMessage.textContent = "...";
      } else {
        console.error(e);
        noteMessage.textContent = "Service is temporarily unavailable.";
        noteMessage.style.color = "#d3414d";
      }
    }
  });

  handleIn.addEventListener("input", async () => { updateLimitUI(); await renderList(); });

  document.getElementById("btnCopy")?.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(linkIn.value);
      const b = document.getElementById("btnCopy");
      const txt = b.textContent;
      b.textContent = "Copied!";
      setTimeout(()=> b.textContent = txt, 900);
    } catch {}
  });

  async function exportEncryptedCsv() {
    if (!mint) return;
    const owner = ownerIdOf(handleIn.value);
    if (!isValidSolAddr(owner)) {
      handleIn.reportValidity();
      handleIn.focus();
      return;
    }
    const rows = await listShillLinks({ mint, owner });
    if (!rows.length) {
      alert("No links to export.");
      return;
    }
    const esc = (v) => {
      const s = v == null ? "" : String(v);
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const header = ["slug","owner","createdAt","url","views","tradeClicks","swapStarts","walletConnects","timeMs"];
    const lines = [header.join(",")];
    for (const r of rows) {
      lines.push([
        esc(r.slug),
        esc(r.owner || ""),
        esc(new Date(r.createdAt).toISOString()),
        esc(r.url),
        String(r.stats.views || 0),
        String(r.stats.tradeClicks || 0),
        String(r.stats.swapStarts || 0),
        String(r.stats.walletConnects || 0),
        String(r.stats.timeMs || 0),
      ].join(","));
    }
    const csv = lines.join("\n") + "\n";

    const { encryptStringWithMint, wrapFdvEncText } = await import("../../utils/crypto.js");
    const encObj = await encryptStringWithMint(mint, csv);
    const payload = wrapFdvEncText(encObj);

    const fname = `shill-${mint.slice(0,6)}-${new Date().toISOString().slice(0,10)}.csv.enc`;
    const blob = new Blob([payload], { type: "text/plain;charset=utf-8" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = fname;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => {
      URL.revokeObjectURL(a.href);
      a.remove();
    }, 0);
  }

  const btnExport = document.getElementById("btnExportCsvEnc");
  if (btnExport) btnExport.addEventListener("click", exportEncryptedCsv);

  links.addEventListener("click", async (e) => {
    const btn = e.target.closest?.("[data-del-shill]");
    if (!btn) return;
    const slug = btn.getAttribute("data-slug");
    const ownerId = btn.getAttribute("data-owner-id") || null;
    const owner = ownerIdOf(handleIn.value);
    if (!slug) return;
    if (!confirm("Delete this shill link? This cannot be undone.")) return;
    const { deleteShillLink } = await import("../../analytics/shill.js");
    deleteShillLink({ slug, owner, ownerId });
    await renderList();
    updateLimitUI();
  });

  await renderList();
  updateLimitUI();
  console.log("Rendering profile metrics...");
}

function ensureShillStyles() {
  if (!document.querySelector('link[href="/src/styles/shill.css"]')) {
    const style = document.createElement("link");
    style.rel = "stylesheet";
    style.href = "/src/assets/styles/shill.css";
    document.head.appendChild(style);
  }
}