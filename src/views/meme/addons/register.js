const REGISTRY = [];
const STATE = new Map(); 

// side load css
function ensureAddonStyles() {
  if (document.getElementById('addonStyles')) return;
  const css = `
    /* Button in tools strip */
    .addon-wrap { display:inline-flex; align-items:center; position:relative; }
    .addon-btn {
      display:inline-flex; align-items:center; gap:8px;
      cursor:pointer; height:36px; padding:0 12px; border-radius:10px;
      border:1px solid var(--fdv-border, var(--border-2, rgba(255,255,255,.14)));
      background: linear-gradient(90deg, rgba(0,0,0,.15), rgba(11,156,173,.15));
      color: var(--text);
      font-weight:600;
      transition: border-color .15s ease, filter .15s ease, background .15s ease;
      -webkit-tap-highlight-color: transparent;
    }
    .addon-btn:hover {
      border-color: rgba(26,255,213,.45);
      filter: brightness(1.06);
    }

    /* Panel and list */
    .addon-panel {
      position: static;
      display:none;
      width:100%;
      background: linear-gradient(180deg, rgba(15,22,37,.96), rgba(15,22,37,.88));
      color:inherit;
      border:1px solid rgba(122,222,255,.12);
      border-radius:12px;
      box-shadow: 0 16px 40px rgba(0,0,0,.45), inset 0 0 0 1px rgba(26,255,213,.05);
      padding:8px;
      max-height: 60vh;
      overflow:auto;
      backdrop-filter: blur(6px);
      -webkit-backdrop-filter: blur(6px);
    }
    .addon-panel.show { display:block; }

    .addon-head {
      display:flex; align-items:center; justify-content:space-between; gap:8px;
      padding:4px 6px 8px;
    }
    .addon-head .title { font-weight:700; letter-spacing:.2px; }

    .addon-list { display:grid; gap:6px; margin:0; padding:0; list-style:none; }

    /* Item layout — anchor wraps content; make it a flex row */
    .addon-item { border-radius:12px; overflow:hidden; }
    .addon-item > a {
      display:flex; align-items:flex-start; gap:12px;
      width:100%;
      padding:10px;
      text-decoration:none;
      color: inherit;
      background: linear-gradient(180deg, rgba(14,16,27,.95), rgba(0,0,0,.80));
      border:1px solid rgba(122,222,255,.12);
      border-radius:12px;
      transition: transform .12s ease, filter .12s ease, border-color .12s ease, background .12s ease;
      -webkit-tap-highlight-color: transparent;
    }
    .addon-item > a:hover {
      filter: brightness(1.04);
      border-color: rgba(26,255,213,.28);
      background: linear-gradient(180deg, rgba(14,16,27,.98), rgba(0,0,0,.86));
    }
    .addon-item > a:focus-visible {
      outline: none;
      box-shadow:
        0 0 0 3px rgba(26,255,213,.14),
        inset 0 0 0 1px rgba(26,255,213,.24);
      border-color: rgba(26,255,213,.45);
    }

    /* Avatar + rank */
    .addon-avatar { position: relative; width: 36px; height: 36px; flex: 0 0 auto; }
    .addon-logo { width:36px; height:36px; border-radius:10px; object-fit:cover; background: #0b111d; display:block; border:1px solid rgba(122,222,255,.20); }
    .addon-rank {
      width:20px; height:20px; border-radius:6px;
      display:flex; align-items:center; justify-content:center;
      font-size:11px; font-weight:800; color:#0b0b0c; position:absolute; top:-6px; left:-6px; z-index:1;
      box-shadow: 0 6px 14px rgba(0,0,0,.35);
    }
    .addon-rank.r1 { background: linear-gradient(135deg,#ffd776,#ffc24a); }
    .addon-rank.r2 { background: linear-gradient(135deg,#d9e3ff,#a9c4ff); }
    .addon-rank.r3 { background: linear-gradient(135deg,#ffd9c1,#ffb08c); }

    /* Main text */
    .addon-main { min-width:0; display:flex; flex-direction:column; gap:6px; }
    .addon-line1 { display:flex; align-items:center; gap:8px; min-width:0; }
    .addon-sym { font-weight:800; font-size: .98rem; letter-spacing:.2px; }
    .addon-name { opacity:.9; font-size:12px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; color: var(--muted); }

    .addon-line2 {
      display:flex; align-items:center; gap:8px; flex-wrap:wrap;
      font-size:12px; opacity:.96;
    }

    /* Pills */
    .pill {
      display:inline-flex; align-items:center; gap:6px;
      padding:3px 8px; border-radius:999px;
      background: rgba(148,163,184,.10);
      border:1px solid rgba(122,222,255,.14);
      color: inherit;
      white-space: nowrap;
    }
    .pill .k{ opacity:.78; margin-right:2px; font-size:.88em; }
    .pill .highlight{ font-weight:800; letter-spacing:.2px; }
    .ch-pos { color:#19c37d; }
    .ch-neg { color:#ff6f6f; }

    /* Pair link pill inside row */
    .addon-line2 a.pill {
      text-decoration:none;
      border-color: rgba(122,222,255,.22);
      background: rgba(123,241,255,.06);
      color: var(--muted);
      transition: filter .12s ease, border-color .12s ease;
    }
    .addon-line2 a.pill:hover { filter: brightness(1.12); border-color: rgba(26,255,213,.35); }

    /* Responsive tweaks */
    @media (max-width: 720px){
      .addon-item > a { gap:10px; padding:9px; }
      .addon-avatar { width: 32px; height: 32px; }
      .addon-logo { width:32px; height:32px; border-radius:8px; }
      .addon-rank { width:16px; height:16px; font-size:10px; top:-5px; left:-5px; }
      .addon-sym { font-size: .95rem; }
      .addon-line2 { gap:6px; }
      .pill { padding:2px 7px; }
    }
    @media (max-width: 420px){
      .addon-item > a { padding:8px; }
      .addon-line2 { font-size:11px; }
      .pill { padding:2px 6px; }
      .addon-name { display:none; } /* keep it ultra-compact on tiny screens */
    }

    /* Respect iOS tap targets */
    @media (hover: none) and (pointer: coarse){
      .addon-item > a { min-height: 44px; }
    }
  `;
  const st = document.createElement('style');
  st.id = 'addonStyles';
  st.textContent = css;
  document.head.appendChild(st);
}

function getHeaderToolsStrip() {
  return document.getElementById('hdrTools') || null;
}

const DEFAULT_LIMIT = 3;
function fmtMoney(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return '—';
  if (v >= 1000) return '$' + Intl.NumberFormat(undefined, { notation: 'compact' }).format(v);
  if (v > 0) return '$' + v.toFixed(2);
  return '$0';
}
function fmtPrice(p) {
  const v = Number(p);
  if (!Number.isFinite(v)) return '—';
  return v >= 1 ? `$${v.toLocaleString(undefined,{maximumFractionDigits:2})}` : `$${v.toFixed(6)}`;
}
function pct(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return { txt: '—', cls: '' };
  const txt = `${n >= 0 ? '+' : ''}${n.toFixed(2)}%`;
  return { txt, cls: n >= 0 ? 'ch-pos' : 'ch-neg' };
}

// ---- UI for a single addon ----
function ensureAddonUI(addon) {
  ensureAddonStyles();
  const strip = getHeaderToolsStrip();
  if (!strip) return null;

  const toolsRow = strip.querySelector('#hdrToolsRow');
  const panelsRow = strip.querySelector('#hdrToolsPanels');
  if (!toolsRow || !panelsRow) return null;

  const wrapId = `${addon.id}Wrap`;
  const panelId = `${addon.id}Panel`;
  const toggleId = `${addon.id}Toggle`;
  const closeId = `${addon.id}Close`;
  const listId = `${addon.id}List`;
  const labelId = `${addon.id}Label`;

  let wrap = document.getElementById(wrapId);
  if (!wrap) {
    wrap = document.createElement('div');
    wrap.id = wrapId;
    wrap.className = 'addon-wrap';
    wrap.innerHTML = `<button class="addon-btn" id="${toggleId}" aria-expanded="false" aria-controls="${panelId}" title="${addon.tooltip || addon.label}">${addon.label}</button>`;
    toolsRow.appendChild(wrap);
  }

  let panel = document.getElementById(panelId);
  if (!panel) {
    panel = document.createElement('div');
    panel.id = panelId;
    panel.className = 'addon-panel';
    panel.setAttribute('role', 'region');
    panel.setAttribute('aria-labelledby', labelId);
    panel.innerHTML = `
      <div class="addon-head">
        <div class="title" id="${labelId}">${addon.title || addon.label}</div>
        <button class="addon-btn" id="${closeId}" style="height:28px;padding:0 10px;border:none;">Close</button>
      </div>
      <ul class="addon-list" id="${listId}"></ul>
    `;
    panelsRow.appendChild(panel);
  }

  const toggle = document.getElementById(toggleId);
  const close = document.getElementById(closeId);
  const setOpen = (on) => {
    panel.classList.toggle('show', on);
    toggle.setAttribute('aria-expanded', on ? 'true' : 'false');
  };
  toggle.onclick = () => setOpen(!panel.classList.contains('show'));
  close.onclick = () => setOpen(false);
  document.addEventListener('click', (e) => { if (!strip.contains(e.target)) setOpen(false); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') setOpen(false); });

  return { wrap, panel, listEl: document.getElementById(listId), labelEl: document.getElementById(labelId) };
}

function renderAddon(addon) {
  const ui = ensureAddonUI(addon);
  if (!ui) return;

  const st = STATE.get(addon.id) || {};
  const items = Array.isArray(st.items) ? st.items.slice(0, addon.limit || DEFAULT_LIMIT) : [];
  const metricLabel = st.metricLabel || addon.metricLabel || 'Score';

  if (ui.labelEl && (addon.title || st.title || addon.label)) {
    ui.labelEl.textContent = st.title || addon.title || addon.label;
  }
  if (!ui.listEl) return;

  if (!items.length) {
    ui.listEl.innerHTML = `<li class="addon-item" style="opacity:.8;">No data yet. Keep the stream running.</li>`;
    return;
  }

  ui.listEl.innerHTML = items.map((row, i) => {
    const logo = row.imageUrl || '';
    const sym = row.symbol || '';
    const name = row.name || '';
    const price = fmtPrice(row.priceUsd);
    const { txt: chTxt, cls: chCls } = pct(row.chg24);
    const liq = fmtMoney(row.liqUsd);
    const vol = fmtMoney(row.vol24);
    const pairUrl = row.pairUrl || '';
    const metricVal = Number.isFinite(Number(row.metric)) ? Number(row.metric) : (Number(row.score) || Number(row.smq) || null);
    const metricHtml = metricVal !== null ? `<span class="pill"><span class="k">${metricLabel}</span><b class="highlight">${metricVal}</b></span>` : '';

    return `
      <li class="addon-item">
        <a href="https://fdv.lol/token/${row.mint}" target="_blank" rel="noopener">
          <div class="addon-avatar">
            <div class="addon-rank r${i+1}">${i+1}</div>
            <img class="addon-logo" src="${logo}" alt="" onerror="this.style.visibility='hidden'">
          </div>
          <div class="addon-main" style="min-width:0;">
            <div class="addon-line1" style="display:flex;align-items:center;gap:8px;min-width:0;">
              <div class="addon-sym" style="font-weight:700;">${sym || '—'}</div>
              <div class="addon-name">${name || ''}</div>
            </div>
            <div class="addon-line2" style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;font-size:12px;opacity:.95;">
              <span class="pill"><span class="k">Price</span><b>${price}</b></span>
              <span class="pill"><span class="k">24h</span><b class="${chCls}">${chTxt}</b></span>
              <span class="pill"><span class="k">Liq</span><b>${liq}</b></span>
              <span class="pill"><span class="k">Vol</span><b>${vol}</b></span>
              ${metricHtml}
            </div>
          </div>
        </a>
      </li>
    `;
  }).join('');
}

export function registerAddon(addon) {
  if (!addon || !addon.id) return;
  if (REGISTRY.find(a => a.id === addon.id)) return;
  REGISTRY.push({ ...addon });
  REGISTRY.sort((a,b)=> (a.order||0) - (b.order||0));
}

export function ensureAddonsUI() {
  for (const a of REGISTRY) {
    try { ensureAddonUI(a); } catch {}
  }
}

export function runAddonsTick() {
  for (const a of REGISTRY) {
    try { renderAddon(a); } catch {}
  }
}

export function setAddonData(id, data) {
  if (!id || !data) return;
  const prev = STATE.get(id) || {};
  const next = {
    ...prev,
    items: Array.isArray(data.items) ? data.items : prev.items || [],
    title: data.title || prev.title,
    subtitle: data.subtitle || prev.subtitle,
    metricLabel: data.metricLabel || prev.metricLabel,
    ts: Date.now(),
  };
  STATE.set(id, next);

  const addon = REGISTRY.find(a => a.id === id);
  if (addon) {
    try { renderAddon(addon); } catch {}
  }
}

export function runTheAddonsTick() {
  runAddonsTick();
}

