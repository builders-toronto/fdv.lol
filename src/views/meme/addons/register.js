const REGISTRY = [];
const STATE = new Map(); 

// side load css
function ensureAddonStyles() {
  if (document.getElementById('addonStyles')) return;
  const css = `
    .addon-wrap { display:inline-flex; align-items:center; position:relative; }
    .addon-btn { display:inline-flex; align-items:center; gap:8px; cursor:pointer; height:36px; padding:0 12px; border-radius:10px; border:1px solid var(--border-2); background:rgba(255,255,255,.05); color:inherit; font-weight:600; }
    .addon-btn:hover { border-color: rgba(255,255,255,.2); background: rgba(255,255,255,.08); }

    .addon-panel { position: static; display:none; width:100%; background: rgba(16,16,22,.96); color:inherit; border:1px solid rgba(255,255,255,.10); border-radius:12px; box-shadow:0 8px 24px rgba(0,0,0,.25); padding:8px; max-height:320px; overflow:auto; }
    .addon-panel.show { display:block; }

    .addon-head { display:flex; align-items:center; justify-content:space-between; gap:8px; padding:4px 6px 8px; }
    .addon-list { display:grid; gap:4px; margin:0; padding:0; list-style:none; }
    .addon-item { display:flex; align-items:flex-start; gap:10px; padding:8px; border-radius:10px; }
    .addon-item:hover { background: rgba(255,255,255,.06); }

    .addon-avatar { position: relative; width: 32px; height: 32px; flex: 0 0 auto; }
    .addon-logo { width:32px; height:32px; border-radius:50%; object-fit:cover; background: rgba(255,255,255,.1); display:block; }
    .addon-rank { width:20px; height:20px; border-radius:6px; display:flex; align-items:center; justify-content:center; font-size:11px; font-weight:700; color:#0b0b0c; position:absolute; top:-6px; left:-6px; z-index:1; }

    .addon-rank.r1 { background: linear-gradient(135deg,#ffd776,#ffc24a); }
    .addon-rank.r2 { background: linear-gradient(135deg,#d9e3ff,#a9c4ff); }
    .addon-rank.r3 { background: linear-gradient(135deg,#ffd9c1,#ffb08c); }

    .addon-name { opacity:.9; font-size:12px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; max-width:36vw; }

    .pill { display:inline-flex; align-items:center; gap:6px; padding:2px 8px; border-radius:99px; background:rgba(255,255,255,.06); border:1px solid rgba(255,255,255,.08); }
    .pill .k{ opacity:.75; margin-right:6px; font-size:.9em; }
    .pill .highlight{ font-weight:800; }
    .ch-pos { color:#2ad38a; }
    .ch-neg { color:#ff6f6f; }

    @media (max-width: 560px){
      .addon-item { gap:8px; padding:6px; }
      .addon-avatar { width:28px; height:28px; }
      .addon-logo { width:28px; height:28px; }
      .addon-rank { width:16px; height:16px; font-size:10px; top:-5px; left:-5px; }
      .addon-panel { max-height: 60vh; }
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
              ${pairUrl ? `<a class="pill" href="${pairUrl}" target="_blank" rel="noopener">Pair</a>` : ``}
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

