const ENG_STORAGE_KEY = 'meme_engagement_history_v1';
const ENG_WINDOW_DAYS = 3;
const ENG_SNAPSHOT_LIMIT = 400;
const ENG_PER_MINT_CAP = 80;

function getHeaderToolsStrip() {
  return document.getElementById('hdrTools') || null;
}

function ensureEngagementStyles() {
  if (document.getElementById('engStyles')) return;
  const css = `
    /* Engagement tool UI */
    .eng-wrap { display:inline-flex; align-items:center; position:relative; }
    .eng-btn {
      display:inline-flex; align-items:center; gap:8px; cursor:pointer;
      height:36px; padding:0 12px; border-radius:10px;
      border:1px solid var(--accent); background:rgba(255,255,255,.05); color:inherit;
      font-weight:600;
    }
    .eng-btn:hover { border-color: rgba(255,255,255,.2); background: rgba(255,255,255,.08); }

    .eng-panel {
      position: static; display: none; width: 100%;
      background: rgba(16,16,22,.96); color: inherit;
      border: 1px solid rgba(255,255,255,.10);
      border-radius: 12px; box-shadow: 0 8px 24px rgba(0,0,0,.25);
      padding: 8px; max-height: 320px; overflow: auto;
    }
    .eng-panel.show { display: block; }

    .eng-head { display:flex; align-items:center; justify-content:space-between; gap:8px; padding:4px 6px 8px; }
    .eng-head .title { font-size:13px; opacity:.9; }

    .eng-list { list-style:none; margin:0; padding:0; display:grid; gap:4px; }
    .eng-item { display:flex; align-items:flex-start; gap:10px; padding:8px; border-radius:10px; }
    .eng-item:hover { background: rgba(255,255,255,.06); }

    /* Avatar + overlaid rank badge */
    .eng-avatar { position: relative; width: 32px; height: 32px; flex: 0 0 auto; }
    .eng-logo { width:32px; height:32px; border-radius: 50%; object-fit:cover; background: rgba(255,255,255,.1); display:block; }
    .eng-rank { width:20px; height:20px; border-radius:6px; display:flex; align-items:center; justify-content:center; font-size:11px; font-weight:700; color:#0b0b0c; }
    .eng-avatar .eng-rank { position:absolute; top:-6px; left:-6px; z-index:1; }

    .eng-rank.r1 { background: linear-gradient(135deg,#9ef0c2,#39d98a); }
    .eng-rank.r2 { background: linear-gradient(135deg,#d9e3ff,#a9c4ff); }
    .eng-rank.r3 { background: linear-gradient(135deg,#ffd9c1,#ffb08c); }

    .eng-main { display:flex; flex-direction:column; gap:2px; min-width:0; }
    .eng-line1 { display:flex; align-items:center; gap:8px; min-width:0; }
    .eng-sym { font-weight:700; }
    .eng-name { opacity:.9; font-size:12px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; max-width:36vw; }
    .eng-line2 { display:flex; align-items:center; gap:10px; font-size:12px; opacity:.95; flex-wrap:wrap; }
    .pill { display:inline-flex; align-items:center; gap:6px; padding:2px 8px; border-radius:99px; background:rgba(255,255,255,.06); border:1px solid rgba(255,255,255,.08); }
    .pill .k { opacity:.75; }
    .ch-pos { color:#2ad38a; }
    .ch-neg { color:#ff6f6f; }

    @media (max-width: 560px){
      .eng-item { gap:8px; padding:6px; }
      .eng-avatar { width:28px; height:28px; }
      .eng-logo { width:28px; height:28px; }
      .eng-avatar .eng-rank { width:16px; height:16px; font-size:10px; top:-5px; left:-5px; }
      .eng-name { max-width: 42vw; }
      .eng-line2 { gap:8px; }
      .pill { padding:2px 7px; }
      .eng-panel { max-height: 60vh; }
    }
  `;
  const st = document.createElement('style');
  st.id = 'engStyles';
  st.textContent = css;
  document.head.appendChild(st);
}

export function ensureEngagementUI() {
  ensureEngagementStyles();
  const strip = getHeaderToolsStrip();
  if (!strip) return null; // wait for initializer

  const existing = document.getElementById('engWrap');
  if (existing) return existing;

  const toolsRow = strip.querySelector('#hdrToolsRow');
  const panelsRow = strip.querySelector('#hdrToolsPanels');

  const wrap = document.createElement('div');
  wrap.id = 'engWrap';
  wrap.className = 'eng-wrap';
  wrap.innerHTML = `<button class="eng-btn" id="engToggle" aria-expanded="false" aria-controls="engPanel" title="Engagement (attention + participation)">Engagement</button>`;
  toolsRow.appendChild(wrap);

  const panel = document.createElement('div');
  panel.id = 'engPanel';
  panel.className = 'eng-panel';
  panel.setAttribute('role', 'region');
  panel.setAttribute('aria-labelledby', 'engLabel');
  panel.innerHTML = `
    <div class="eng-head">
      <div class="title" id="engLabel">Most engaged tokens (last ${ENG_WINDOW_DAYS}d)</div>
      <button class="eng-btn" id="engClose" style="height:28px;padding:0 10px;border:none;">Close</button>
    </div>
    <ul class="eng-list" id="engList"></ul>
  `;
  panelsRow.appendChild(panel);

  const toggle = wrap.querySelector('#engToggle');
  const close = panel.querySelector('#engClose');
  const setOpen = (on) => {
    panel.classList.toggle('show', on);
    toggle.setAttribute('aria-expanded', on ? 'true' : 'false');
  };
  toggle.addEventListener('click', () => setOpen(!panel.classList.contains('show')));
  close.addEventListener('click', () => setOpen(false));
  document.addEventListener('click', (e) => { if (!strip.contains(e.target)) setOpen(false); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') setOpen(false); });

  return wrap;
}

// Storage
function loadEngHistory() {
  try {
    const raw = localStorage.getItem(ENG_STORAGE_KEY);
    return raw ? JSON.parse(raw) : { byMint: {}, total: 0 };
  } catch { return { byMint: {}, total: 0 }; }
}
function saveEngHistory(h) {
  try { localStorage.setItem(ENG_STORAGE_KEY, JSON.stringify(h)); } catch {}
}
function pruneEngHistory(h) {
  const cutoff = Date.now() - ENG_WINDOW_DAYS*24*3600*1000;
  let total = 0;
  for (const mint of Object.keys(h.byMint)) {
    let arr = Array.isArray(h.byMint[mint]) ? h.byMint[mint] : [];
    arr = arr.filter(e => +e.ts >= cutoff).slice(-ENG_PER_MINT_CAP);
    if (arr.length) { h.byMint[mint] = arr; total += arr.length; }
    else delete h.byMint[mint];
  }
  if (total > ENG_SNAPSHOT_LIMIT) {
    const all = [];
    for (const [mint, arr] of Object.entries(h.byMint)) for (const e of arr) all.push({ mint, ...e });
    all.sort((a,b)=>a.ts-b.ts);
    const keep = all.slice(-ENG_SNAPSHOT_LIMIT);
    const next = { byMint: {}, total: keep.length };
    for (const e of keep) (next.byMint[e.mint] ||= []).push({ ts: e.ts, score: e.score, kp: e.kp });
    return next;
  }
  h.total = total;
  return h;
}

// Scoring: engagement = attention + participation
function scoreEngagementSnapshot(items) {
  const nz = (v, d = 0) => {
    const n = Number(v);
    return Number.isFinite(n) ? n : d;
  };
  const unpack = (it) => {
    const buys = nz(it?.txns?.h24?.buys, null);
    const sells = nz(it?.txns?.h24?.sells, null);
    const tx = Number.isFinite(buys) || Number.isFinite(sells)
      ? nz(buys, 0) + nz(sells, 0)
      : nz(it?.txns?.h24, null);
    const vol = nz(it?.volume?.h24, null);
    const liq = nz(it?.liquidityUsd, null);
    const vOverL = Number.isFinite(vol) && Number.isFinite(liq) && liq > 0 ? vol / liq : null;
    let unique = nz(it?.unique?.h24 ?? it?.unique24, null);
    if (!Number.isFinite(unique) && Number.isFinite(tx)) {
      // pragmatic
      unique = Math.round(Math.max(1, Math.sqrt(Math.max(0, tx))));
    }
    const chg = Number.isFinite(Number(it?.change?.h24)) ? Number(it.change.h24) : 0;
    const volat = nz(it?.volatility?.h24 ?? it?.spreadPct, null); 
    return {
      it, tx, unique, vOverL, chg, volat,
      price: nz(it?.priceUsd, null),
      liq, vol
    };
  };

  const rows = (Array.isArray(items) ? items : []).map(unpack)
    .filter(r => Number.isFinite(r.tx) || Number.isFinite(r.vOverL) || Number.isFinite(r.unique));

  if (!rows.length) return [];

  const pos = (v) => (Number.isFinite(v) && v > 0 ? v : 0);
  const maxTx   = Math.max(...rows.map(r => pos(r.tx)), 1);
  const maxUni  = Math.max(...rows.map(r => pos(r.unique)), 1);
  const maxVoL  = Math.max(...rows.map(r => pos(r.vOverL)), 1);

  const normLog = (v, m) => {
    const x = pos(v);
    return m > 0 ? Math.min(1, Math.log10(1 + x) / Math.log10(1 + m)) : 0;
  };
  const clamp01 = (n) => Math.max(0, Math.min(1, n));
  const mom01 = (chg) => {
    const c = Math.max(-50, Math.min(50, Number.isFinite(chg) ? chg : 0));
    return (c + 50) / 100; // -50..+50 => 0..1
  };
  const volPenalty01 = (v) => {
    if (!Number.isFinite(v) || v <= 0) return 0; // no penalty if unknown
    // map modest volatility to small penalty; clamp heavy vol to 1
    const p = Math.min(1, v / 50);
    return p;
  };

  return rows.map(({ it, tx, unique, vOverL, chg, volat }) => {
    const nTx   = normLog(tx, maxTx);
    const nUni  = normLog(unique, maxUni);
    const nVoL  = normLog(vOverL, maxVoL);
    const nMom  = mom01(chg);
    const pen   = volPenalty01(volat);

    const base = 0.40*nTx + 0.25*nVoL + 0.20*nUni + 0.10*nMom;
    const score01 = clamp01(base) * (1 - 0.05*pen) + 0.05*(1 - pen); // keep small baseline if no vol data
    const score = Math.round(score01 * 100);

    return {
      mint: it.mint || it.id,
      symbol: it.symbol || '',
      name: it.name || '',
      imageUrl: it.imageUrl || it.logoURI || '',
      pairUrl: it.pairUrl || '',
      priceUsd: nz(it.priceUsd, null),
      chg24: Number.isFinite(chg) ? chg : 0,
      liqUsd: nz(it.liquidityUsd, 0),
      vol24: nz(it.volume?.h24, 0),
      tx24: nz(it.txns?.h24?.buys, 0) + nz(it.txns?.h24?.sells, 0) || nz(it.txns?.h24, 0),
      unique24: Number.isFinite(unique) ? unique : 0,
      vOverL: Number.isFinite(vOverL) ? vOverL : 0,
      score
    };
  }).sort((a,b)=>b.score - a.score);
}

export function updateEngagementHistory(items) {
  const h = loadEngHistory();
  const ts = Date.now();
  const scored = scoreEngagementSnapshot(items).slice(0, 25);
  if (!scored.length) return;
  for (const it of scored) {
    const entry = {
      ts,
      score: it.score,
      kp: {
        symbol: it.symbol, name: it.name, imageUrl: it.imageUrl, pairUrl: it.pairUrl,
        priceUsd: it.priceUsd, chg24: it.chg24, liqUsd: it.liqUsd, vol24: it.vol24,
        tx24: it.tx24, unique24: it.unique24, vOverL: it.vOverL
      }
    };
    (h.byMint[it.mint] ||= []).push(entry);
    if (h.byMint[it.mint].length > ENG_PER_MINT_CAP) h.byMint[it.mint] = h.byMint[it.mint].slice(-ENG_PER_MINT_CAP);
  }
  h.total = Object.values(h.byMint).reduce((a,arr)=>a+arr.length,0);
  saveEngHistory(pruneEngHistory(h));
}

function computeEngagementTop3() {
  const h = pruneEngHistory(loadEngHistory());
  const cutoff = Date.now() - ENG_WINDOW_DAYS*24*3600*1000;
  const agg = [];
  for (const [mint, arr] of Object.entries(h.byMint)) {
    const recent = arr.filter(e => +e.ts >= cutoff);
    if (!recent.length) continue;
    const best = recent.map(e => e.score).sort((a,b)=>b-a).slice(0,5);
    const avg = best.reduce((a,b)=>a+b,0) / best.length;
    const latest = recent[recent.length - 1]?.kp || {};
    agg.push({ mint, avgScore: Math.round(avg), kp: latest });
  }
  agg.sort((a,b)=>b.avgScore - a.avgScore);
  return agg.slice(0,3);
}

function compactMoney(n) {
  if (!Number.isFinite(+n)) return '—';
  const v = +n;
  if (v >= 1000) return '$' + Intl.NumberFormat(undefined, { notation: 'compact' }).format(v);
  if (v > 0) return '$' + v.toFixed(2);
  return '$0';
}
function compactNumber(n) {
  if (!Number.isFinite(+n)) return '—';
  return Intl.NumberFormat(undefined, { notation: 'compact' }).format(+n);
}
function compactPrice(p) {
  if (!Number.isFinite(+p)) return '—';
  const v = +p;
  return v >= 1 ? `$${v.toLocaleString(undefined,{maximumFractionDigits:2})}` : `$${v.toFixed(6)}`;
}

export function renderEngagementDropdown({ fallbackItems = null, marquee = null } = {}) {
  ensureEngagementUI();
  const listEl = document.getElementById('engList');
  if (!listEl) return;

  const top3 = computeEngagementTop3();
  const renderRows = (rows, useAvgScore = true) => {
    listEl.innerHTML = rows.map((it, i) => {
      const logo = (useAvgScore ? it.kp?.imageUrl : it.imageUrl) || '';
      const sym = (useAvgScore ? it.kp?.symbol : it.symbol) || '';
      const name = (useAvgScore ? it.kp?.name : it.name) || '';
      const price = compactPrice((useAvgScore ? it.kp?.priceUsd : it.priceUsd));
      const ch = Number((useAvgScore ? it.kp?.chg24 : it.chg24) ?? 0);
      const chTxt = `${ch >= 0 ? '+' : ''}${ch.toFixed(2)}%`;
      const chCls = ch >= 0 ? 'ch-pos' : 'ch-neg';
      const liq = compactMoney((useAvgScore ? it.kp?.liqUsd : it.liqUsd));
      const vol = compactMoney((useAvgScore ? it.kp?.vol24 : it.vol24));
      const tx = compactNumber((useAvgScore ? it.kp?.tx24 : it.tx24));
      const uniq = compactNumber((useAvgScore ? it.kp?.unique24 : it.unique24));
      const vOverL = Number(useAvgScore ? it.kp?.vOverL : it.vOverL) || 0;
      const vOverLTxt = vOverL ? vOverL.toFixed(2) : '—';
      const pairUrl = (useAvgScore ? it.kp?.pairUrl : it.pairUrl) || '';
      const scoreVal = useAvgScore ? it.avgScore : it.score;
      return `
        <li class="eng-item">
          <a href="https://fdv.lol/token/${it.mint}" target="_blank" rel="noopener">
            <div class="eng-avatar">
              <div class="eng-rank r${i+1}">${i+1}</div>
              <img class="eng-logo" src="${logo}" alt="" onerror="this.style.visibility='hidden'">
            </div>
            <div class="eng-main">
              <div class="eng-line1">
                <div class="eng-sym">${sym || '—'}</div>
                <div class="eng-name">${name || ''}</div>
              </div>
              <div class="eng-line2">
                <span class="pill"><span class="k">Price</span><b>${price}</b></span>
                <span class="pill"><span class="k">24h</span><b class="${chCls}">${chTxt}</b></span>
                <span class="pill"><span class="k">Tx</span><b>${tx}</b></span>
                <span class="pill"><span class="k">Unique</span><b>${uniq}</b></span>
                <span class="pill"><span class="k">V/L</span><b>${vOverLTxt}</b></span>
                <span class="pill"><span class="k">Score</span><b>${scoreVal}</b></span>
                ${pairUrl ? `<a class="pill" href="${pairUrl}" target="_blank" rel="noopener">Pair</a>` : ``}
              </div>
            </div>
          </a>
        </li>
      `;
    }).join('');
  };

  if (top3.length) {
    renderRows(top3, true);
    return;
  }
  let seeds = Array.isArray(fallbackItems) && fallbackItems.length ? fallbackItems : [];
  if (!seeds.length && marquee) {
    const t = Array.isArray(marquee?.trending) ? marquee.trending : [];
    const n = Array.isArray(marquee?.new) ? marquee.new : [];
    seeds = [...t, ...n];
  }
  const provisional = scoreEngagementSnapshot(seeds).slice(0, 3);
  if (provisional.length) renderRows(provisional, false);
  else listEl.innerHTML = `<li class="eng-item" style="opacity:.8;">No data yet. Keep the stream on for trends.</li>`;
}