const TOP3_STORAGE_KEY = 'meme_top3_history_v1';
const TOP3_WINDOW_DAYS = 3;      
const TOP3_SNAPSHOT_LIMIT = 400;  
const TOP3_PER_MINT_CAP = 80;     

function ensureTop3Styles() {
  if (document.getElementById('top3Styles')) return;
  const css = `
    /* Top 3 tool inline in header strip */
    .top3-wrap { display:inline-flex; align-items:center; position:relative; }
    .top3-btn { display:inline-flex; align-items:center; gap:8px; cursor:pointer; height:36px; padding:0 12px; border-radius:10px; border:1px solid var(--accent); background:rgba(255,255,255,.05); color:inherit; font-weight:600; }
    .top3-btn:hover { border-color: rgba(255,255,255,.2); background: rgba(255,255,255,.08); }

    .top3-panel { position: static; display:none; width:100%; background: rgba(16,16,22,.96); color:inherit; border:1px solid rgba(255,255,255,.10); border-radius:12px; box-shadow:0 8px 24px rgba(0,0,0,.25); padding:8px; max-height:320px; overflow:auto; }
    .top3-panel.show { display:block; }

    .top3-head { display:flex; align-items:center; justify-content:space-between; gap:8px; padding:4px 6px 8px; }
    .top3-list { display:grid; gap:4px; margin:0; padding:0; list-style:none; }
    .top3-item { display:flex; align-items:flex-start; gap:10px; padding:8px; border-radius:10px; }
    .top3-item:hover { background: rgba(255,255,255,.06); }

    /* Avatar + overlaid rank badge */
    .top3-avatar { position: relative; width: 32px; height: 32px; flex: 0 0 auto; }
    .top3-logo { width:32px; height:32px; border-radius:50%; object-fit:cover; background: rgba(255,255,255,.1); display:block; }
    .top3-rank { width:20px; height:20px; border-radius:6px; display:flex; align-items:center; justify-content:center; font-size:11px; font-weight:700; color:#0b0b0c; }
    .top3-avatar .top3-rank { position:absolute; top:-6px; left:-6px; z-index:1; }

    .top3-rank.r1 { background: linear-gradient(135deg,#ffd776,#ffc24a); }
    .top3-rank.r2 { background: linear-gradient(135deg,#d9e3ff,#a9c4ff); }
    .top3-rank.r3 { background: linear-gradient(135deg,#ffd9c1,#ffb08c); }

    .top3-name { opacity:.9; font-size:12px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; max-width:36vw; }

    @media (max-width: 560px){
      .top3-item { gap:8px; padding:6px; }
      .top3-avatar { width:28px; height:28px; }
      .top3-logo { width:28px; height:28px; }
      .top3-avatar .top3-rank { width:16px; height:16px; font-size:10px; top:-5px; left:-5px; }
      .top3-panel { max-height: 60vh; }
    }
  `;
  const st = document.createElement('style');
  st.id = 'top3Styles';
  st.textContent = css;
  document.head.appendChild(st);
}

function getHeaderToolsStrip() {
  return document.getElementById('hdrTools') || null;
}

export function ensureTop3UI() {
  ensureTop3Styles();

  const strip = getHeaderToolsStrip();
  if (!strip) return null; // wait for initializer to create

  const host = document.getElementById('top3Wrap');
  if (host) return host;

  const toolsRow = strip.querySelector('#hdrToolsRow');
  const panelsRow = strip.querySelector('#hdrToolsPanels');

  const wrap = document.createElement('div');
  wrap.id = 'top3Wrap';
  wrap.className = 'top3-wrap';
  wrap.innerHTML = `<button class="top3-btn" id="top3Toggle" aria-expanded="false" aria-controls="top3Panel" title="Long-term Top 3">Top 3 (LT)</button>`;
  toolsRow.appendChild(wrap);

  const panel = document.createElement('div');
  panel.id = 'top3Panel';
  panel.className = 'top3-panel';
  panel.setAttribute('role', 'region');
  panel.setAttribute('aria-labelledby', 'top3Label');
  panel.innerHTML = `
    <div class="top3-head">
      <div class="title" id="top3Label">Top performers (last ${TOP3_WINDOW_DAYS}d)</div>
      <button class="top3-btn" id="top3Close" style="height:28px;padding:0 10px;border:none;">Close</button>
    </div>
    <ul class="top3-list" id="top3List"></ul>
  `;
  panelsRow.appendChild(panel);

  const toggle = wrap.querySelector('#top3Toggle');
  const close = panel.querySelector('#top3Close');

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

function loadTop3History() {
  try {
    const raw = localStorage.getItem(TOP3_STORAGE_KEY);
    return raw ? JSON.parse(raw) : { byMint: {}, total: 0 };
  } catch { return { byMint: {}, total: 0 }; }
}
function saveTop3History(h) {
  try { localStorage.setItem(TOP3_STORAGE_KEY, JSON.stringify(h)); } catch {}
}
function pruneTop3History(h) {
  // prune by time window and caps
  const cutoff = Date.now() - TOP3_WINDOW_DAYS*24*3600*1000;
  let total = 0;
  for (const mint of Object.keys(h.byMint)) {
    let arr = Array.isArray(h.byMint[mint]) ? h.byMint[mint] : [];
    arr = arr.filter(e => +e.ts >= cutoff).slice(-TOP3_PER_MINT_CAP);
    if (arr.length) { h.byMint[mint] = arr; total += arr.length; }
    else delete h.byMint[mint];
  }
  // global cap
  if (total > TOP3_SNAPSHOT_LIMIT) {
    // drop oldest across all
    const all = [];
    for (const [mint, arr] of Object.entries(h.byMint)) {
      for (const e of arr) all.push({ mint, ...e });
    }
    all.sort((a,b)=>a.ts-b.ts);
    const keep = all.slice(-TOP3_SNAPSHOT_LIMIT);
    const next = { byMint: {}, total: keep.length };
    for (const e of keep) {
      (next.byMint[e.mint] ||= []).push({ ts: e.ts, score: e.score, kp: e.kp });
    }
    return next;
  }
  h.total = total;
  return h;
}
function scoreSnapshot(items) {
  const nz = (v, d = 0) => {
    const n = Number(v);
    return Number.isFinite(n) ? n : d;
  };
  const unpack = (it) => ({
    it,
    vol: nz(it?.volume?.h24, null),
    liq: nz(it?.liquidityUsd, null),
    tx:  nz(it?.txns?.h24, null),
    chg: Number.isFinite(Number(it?.change?.h24)) ? Number(it.change.h24) : 0,
    price: nz(it?.priceUsd, null),
  });

  const rows = (Array.isArray(items) ? items : []).map(unpack);
  // Keep rows that have at least one meaningful KPI
  const sample = rows.filter(r =>
    Number.isFinite(r.vol) || Number.isFinite(r.liq) ||
    Number.isFinite(r.tx)  || Number.isFinite(r.price)
  );
  if (!sample.length) return [];

  const pos = (v) => (Number.isFinite(v) && v > 0 ? v : 0);
  const maxVol = Math.max(...sample.map(r => pos(r.vol)), 1);
  const maxLiq = Math.max(...sample.map(r => pos(r.liq)), 1);
  const maxTx  = Math.max(...sample.map(r => pos(r.tx)),  1);

  const norm = (v, m) => {
    const x = pos(v);
    return m > 0 ? Math.min(1, Math.log10(1 + x) / Math.log10(1 + m)) : 0;
  };
  const clamp01 = (n) => Math.max(0, Math.min(1, n));

  return sample.map(({ it, vol, liq, tx, chg, price }) => {
    const nVol = norm(vol, maxVol);
    const nLiq = norm(liq, maxLiq);
    const nTx  = norm(tx,  maxTx);
    const nChg = Number.isFinite(chg) ? (chg >= 0 ? clamp01(chg / 100) : -clamp01(Math.abs(chg) / 100)) : 0;

    // Provisional composite weights (same shape as before; tolerates missing metrics)
    const score01 = 0.35*nVol + 0.25*nTx + 0.20*nLiq + 0.20*(0.5 + nChg/2);
    const score = Math.round(score01 * 100);

    return {
      mint: it.mint || it.id,
      symbol: it.symbol || '',
      name: it.name || '',
      imageUrl: it.imageUrl || it.logoURI || '',
      pairUrl: it.pairUrl || '',
      priceUsd: price,
      chg24: Number.isFinite(chg) ? chg : 0,
      liqUsd: Number.isFinite(liq) ? liq : 0,
      vol24: Number.isFinite(vol) ? vol : 0,
      score
    };
  }).sort((a,b)=>b.score-a.score);
}
export function updateTop3History(items) {
  const h = loadTop3History();
  const ts = Date.now();
  const scored = scoreSnapshot(items).slice(0, 25);
  if (!scored.length) return;
  for (const it of scored) {
    const entry = { ts, score: it.score, kp: { chg24: it.chg24, liqUsd: it.liqUsd, vol24: it.vol24, priceUsd: it.priceUsd, symbol: it.symbol, name: it.name, imageUrl: it.imageUrl, pairUrl: it.pairUrl } };
    (h.byMint[it.mint] ||= []).push(entry);
    if (h.byMint[it.mint].length > TOP3_PER_MINT_CAP) h.byMint[it.mint] = h.byMint[it.mint].slice(-TOP3_PER_MINT_CAP);
  }
  h.total = Object.values(h.byMint).reduce((a,arr)=>a+arr.length,0);
  saveTop3History(pruneTop3History(h));
}
function computeTop3FromHistory() {
  const h = pruneTop3History(loadTop3History());
  const cutoff = Date.now() - TOP3_WINDOW_DAYS*24*3600*1000;
  const agg = [];
  for (const [mint, arr] of Object.entries(h.byMint)) {
    const recent = arr.filter(e => +e.ts >= cutoff);
    if (!recent.length) continue;
    // Take average of top 5 recent scores to favor consistency
    const best = recent.map(e => e.score).sort((a,b)=>b-a).slice(0,5);
    const avg = best.reduce((a,b)=>a+b,0) / best.length;
    // Use latest snapshot kp for display
    const latest = recent[recent.length-1]?.kp || {};
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
function compactPrice(p) {
  if (!Number.isFinite(+p)) return '—';
  const v = +p;
  return v >= 1 ? `$${v.toLocaleString(undefined,{maximumFractionDigits:2})}` : `$${v.toFixed(6)}`;
}
export function renderTop3Dropdown({ fallbackItems = null, marquee = null } = {}) {
  const host = ensureTop3UI();
  const listEl = document.getElementById('top3List');
  const top3 = computeTop3FromHistory();

  if (!listEl) return host;

  if (top3.length) {
    listEl.innerHTML = top3.map((it, i) => {
      const logo = it.kp?.imageUrl || '';
      const sym = it.kp?.symbol || '';
      const name = it.kp?.name || '';
      const price = compactPrice(it.kp?.priceUsd);
      const ch = Number(it.kp?.chg24 ?? 0);
      const chTxt = `${ch >= 0 ? '+' : ''}${ch.toFixed(2)}%`;
      const chCls = ch >= 0 ? 'ch-pos' : 'ch-neg';
      const liq = compactMoney(it.kp?.liqUsd);
      const vol = compactMoney(it.kp?.vol24);
      const pairUrl = it.kp?.pairUrl || '';
      return `
        <li class="top3-item">
          <a href="https://fdv.lol/token/${it.mint}" target="_blank" rel="noopener">
            <div class="top3-avatar">
              <div class="top3-rank r${i+1}">${i+1}</div>
              <img class="top3-logo" src="${logo}" alt="" onerror="this.style.visibility='hidden'">
            </div>
            <div class="top3-main" style="min-width:0;">
              <div class="top3-line1">
                <div class="top3-sym">${sym || '—'}</div>
                <div class="top3-name">${name || ''}</div>
              </div>
              <div class="top3-line2">
                <span class="pill"><span class="k">Price</span><b>${price}</b></span>
                <span class="pill"><span class="k">24h</span><b class="${chCls}">${chTxt}</b></span>
                <span class="pill"><span class="k">Liq</span><b>${liq}</b></span>
                <span class="pill"><span class="k">Vol</span><b>${vol}</b></span>
                <span class="pill"><span class="k">Score</span><b>${it.avgScore}</b></span>
                ${pairUrl ? `<a class="pill" href="${pairUrl}" target="_blank" rel="noopener">Pair</a>` : ``}
              </div>
            </div>
          </a>
        </li>
      `;
    }).join('');
    return host;
  }

  let seeds = Array.isArray(fallbackItems) && fallbackItems.length ? fallbackItems : [];
  if (!seeds.length && marquee) {
    const t = Array.isArray(marquee?.trending) ? marquee.trending : [];
    const n = Array.isArray(marquee?.new) ? marquee.new : [];
    seeds = [...t, ...n];
  }
  const provisional = scoreSnapshot(seeds).slice(0, 3);

  if (provisional.length) {
    listEl.innerHTML = provisional.map((it, i) => {
      const logo = it.imageUrl || '';
      const sym = it.symbol || '';
      const name = it.name || '';
      const price = compactPrice(it.priceUsd);
      const ch = Number(it.chg24 ?? 0);
      const chTxt = `${ch >= 0 ? '+' : ''}${ch.toFixed(2)}%`;
      const chCls = ch >= 0 ? 'ch-pos' : 'ch-neg';
      const liq = compactMoney(it.liqUsd);
      const vol = compactMoney(it.vol24);
      const pairUrl = it.pairUrl || '';
      return `
        <li class="top3-item">
          <a href="https://fdv.lol/token/${it.mint}" target="_blank" rel="noopener">
            <div class="top3-avatar">
              <div class="top3-rank r${i+1}">${i+1}</div>
              <img class="top3-logo" src="${logo}" alt="" onerror="this.style.visibility='hidden'">
            </div>
            <div class="top3-main" style="min-width:0;">
              <div class="top3-line1">
                <div class="top3-sym">${sym || '—'}</div>
                <div class="top3-name">${name || ''}</div>
              </div>
              <div class="top3-line2">
                <span class="pill"><span class="k">Price</span><b>${price}</b></span>
                <span class="pill"><span class="k">24h</span><b class="${chCls}">${chTxt}</b></span>
                <span class="pill"><span class="k">Liq</span><b>${liq}</b></span>
                <span class="pill"><span class="k">Vol</span><b>${vol}</b></span>
                <span class="pill"><span class="k">Score</span><b>${it.score}</b></span>
                ${pairUrl ? `<a class="pill" href="${pairUrl}" target="_blank" rel="noopener">Pair</a>` : ``}
              </div>
            </div>
          </a>
        </li>
      `;
    }).join('');
  } else {
    listEl.innerHTML = `<li class="top3-item" style="opacity:.8;">No data yet. Keep the stream on for trends.</li>`;
  }
  return host;
}