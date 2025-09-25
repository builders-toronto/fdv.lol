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

  function isValidSolAddr(s) {
    return SOL_ADDR_RE.test(ownerIdOf(s));
  }

  function updateLimitUI() {
    const owner = ownerIdOf(handleIn.value);
    const valid = isValidSolAddr(owner);

    // HTML5 validity + inline note
    handleIn.setCustomValidity(valid ? "" : "Invalid Solana address");
    limitNote.textContent = valid
      ? ""
      : "";

    // Respect creation limits only when valid
    let remaining = 0;
    if (valid) {
      ({ remaining } = canCreateShillLink({ owner }));
    }
    btnGen.disabled = !valid || remaining <= 0;

    if (valid) {
      limitNote.textContent = remaining > 0
        ? `You can create ${remaining} more link${remaining === 1 ? "" : "s"}.`
        : "Link limit reached (3 per user).";
    }
  }

  // Async render to await server summaries
  const renderList = async () => {
    const owner = ownerIdOf(handleIn.value);
    const valid = isValidSolAddr(owner);
    if (listWrap) listWrap.hidden = true; // hide while loading / when empty
    if (links) links.innerHTML = "";
    try {
      const rows = await listShillLinks({ mint, owner: valid ? owner : "" });
      if (Array.isArray(rows) && rows.length > 0) {
        const html = rows.map((r) => `
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
        if (links) links.innerHTML = html;
        if (listWrap) listWrap.hidden = false;
      } else {
        if (links) links.innerHTML = "";
        if (listWrap) listWrap.hidden = true;
      }
    } catch {
      if (links) links.innerHTML = "";
      if (listWrap) listWrap.hidden = true;
    }
  };

  btnGen.addEventListener("click", async () => {
    try {
      const owner = ownerIdOf(handleIn.value);
      if (!isValidSolAddr(owner)) { handleIn.reportValidity(); handleIn.focus(); return; }
      const { url } = await makeShillShortlink({ mint, wallet_id: owner }); // awaits register + token
      out.hidden = false;
      linkIn.value = url;
      await renderList();
      updateLimitUI();
    } catch (e) {
      if (e?.code === "LIMIT") { updateLimitUI(); } else { console.error(e); alert("Failed to create link. Please try again."); }
    }
  });

  handleIn.addEventListener("input", async () => { updateLimitUI(); await renderList(); });

  document.getElementById("btnCopy").addEventListener("click", async () => {
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

  // Delete handler
  links.addEventListener("click", async (e) => {
    const btn = e.target.closest?.("[data-del-shill]");
    if (!btn) return;
    const slug = btn.getAttribute("data-slug");
    const ownerId = btn.getAttribute("data-owner-id") || null;
    const owner = ownerIdOf(handleIn.value);
    if (!slug) return;

    const ok = confirm("Delete this shill link? This cannot be undone.");
    if (!ok) return;

    const { deleteShillLink } = await import("../../analytics/shill.js");
    const removed = deleteShillLink({ slug, owner, ownerId });
    await renderList(); // will hide the section if now empty
    updateLimitUI();
  });

  // Initial render
  await renderList();
  updateLimitUI();
}

function ensureShillStyles() {
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
    link.id = id;
    link.rel = "stylesheet";
    link.href = href;
    link.media = "all";
    document.head.appendChild(link);
  } else {
    link.disabled = false;
    if (link.rel !== "stylesheet") link.rel = "stylesheet";
  }

  if (link.sheet && link.sheet.cssRules != null) return Promise.resolve();

  return new Promise((resolve) => {
    let done = false;
    const finish = () => { if (!done) { done = true; resolve(); } };
    link.addEventListener("load", finish, { once: true });
    link.addEventListener("error", finish, { once: true });
    setTimeout(finish, 150);
  });
}