import { getTokenLogoPlaceholder, queueTokenLogoLoad } from '../../../../core/ipfs.js';

const DEFAULTS = {
  windowMs: 15 * 60 * 1000,
  maxPoints: 90,
  tickMs: 1250,
  switchMarginPct: 0.25,
  pumpLookbackMs: 60 * 1000,
  minRecentPnlPct: 0.05,
  nearHighWithinPct: 0.02,
  recentWeight: 2.0,
  hotPnlPct: 30,
  title: 'Prospect',
  subtitle: 'Top PnL (15m)',
};

const _num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};
const _clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const _fmtPct = (v) => {
  const n = _num(v);
  if (n === null) return '—';
  const sign = n > 0 ? '+' : '';
  const abs = Math.abs(n);
  const dp = abs >= 10 ? 1 : 2;
  return `${sign}${n.toFixed(dp)}%`;
};
const _fmtUsd = (v) => {
  const n = _num(v);
  if (n === null) return '—';
  if (n >= 1000) return `$${n.toFixed(0)}`;
  if (n >= 1) return `$${n.toFixed(4).replace(/0+$/, '').replace(/\.$/, '')}`;
  return `$${n.toPrecision(3)}`;
};
const _shortMint = (m) => {
  const s = String(m || '');
  if (s.length <= 12) return s;
  return `${s.slice(0, 4)}…${s.slice(-4)}`;
};

function extractMint(item) {
  return String(item?.mint || item?.tokenMint || item?.token?.mint || '').trim() || null;
}
function extractPriceUsd(item) {
  return _num(item?.priceUsd ?? item?.price ?? item?.usdPrice);
}
function extractImage(item) {
  return String(
    item?.image ??
    item?.imageUrl ??
    item?.logoURI ??
    item?.logoUrl ??
    item?.logo ??
    item?.icon ??
    item?.token?.image ??
    item?.token?.imageUrl ??
    item?.token?.logoURI ??
    item?.token?.logoUrl ??
    item?.token?.logo ??
    item?.token?.icon ??
    ''
  ).trim() || '';
}
function extractSymbol(item) {
  return String(
    item?.symbol ??
    item?.sym ??
    item?.ticker ??
    item?.token?.symbol ??
    item?.token?.sym ??
    ''
  ).trim() || '';
}
function extractName(item) {
  return String(
    item?.name ??
    item?.tokenName ??
    item?.token?.name ??
    ''
  ).trim() || '';
}

function computeWindowPnlPct(rec) {
  const s = rec?.series;
  if (!s || s.length < 2) return null;
  const first = _num(s[0]?.p);
  const last = _num(s[s.length - 1]?.p);
  if (!first || !last) return null;
  if (first <= 0) return null;
  return ((last - first) / first) * 100;
}

function computeRecentPnlPct(rec, nowTs, lookbackMs) {
  const s = rec?.series;
  if (!s || s.length < 2) return null;
  const last = _num(s[s.length - 1]?.p);
  if (!last || last <= 0) return null;

  const cutoff = (Number.isFinite(nowTs) ? nowTs : Date.now()) - (Number.isFinite(lookbackMs) ? lookbackMs : 0);
  let base = null;

  // Find a base point at/just after cutoff (older point).
  for (let i = s.length - 1; i >= 0; i--) {
    if (s[i].t <= cutoff) {
      base = _num(s[i]?.p);
      break;
    }
  }
  if (!base) base = _num(s[0]?.p);
  if (!base || base <= 0) return null;
  return ((last - base) / base) * 100;
}

function computeWindowStats(rec) {
  const s = rec?.series;
  if (!s || s.length < 2) return null;
  let lo = Infinity;
  let hi = -Infinity;
  for (const pt of s) {
    const p = _num(pt?.p);
    if (p === null) continue;
    if (p < lo) lo = p;
    if (p > hi) hi = p;
  }
  const first = _num(s[0]?.p);
  const last = _num(s[s.length - 1]?.p);
  if (!Number.isFinite(lo) || !Number.isFinite(hi) || first === null || last === null) return null;
  return { lo, hi, first, last };
}

function createFlamebarDom({ title, subtitle }) {
  const frame = document.createElement('div');
  frame.className = 'fdv-flamebar-frame';

  const card = document.createElement('div');
  card.className = 'card fdv-flamebar-card';
  card.dataset.mint = '';

  card.innerHTML = `
    <div class="fdv-flamebar-inner">
      <div class="fdv-flamebar-top">
        <div class="fdv-flamebar-title">
          <span class="fdv-flamebar-badge">${String(title || 'Prospect')}</span>
          <span class="fdv-flamebar-sub">${String(subtitle || 'Top PnL (15m)')}</span>
        </div>
        <div class="fdv-flamebar-kpi">
          <span class="fdv-flamebar-pnl" data-flamebar-pnl>—</span>
          <span class="fdv-flamebar-meta" data-flamebar-meta>Waiting for snapshot…</span>
        </div>
      </div>

      <div class="fdv-flamebar-coin" data-flamebar-coin hidden>
        <div class="fdv-flamebar-logo" aria-hidden="true"><img data-flamebar-img alt="" /></div>
        <div class="fdv-flamebar-cointext">
          <div class="fdv-flamebar-sym" data-flamebar-sym></div>
          <div class="fdv-flamebar-name" data-flamebar-name></div>
          <a class="fdv-flamebar-mint" data-flamebar-mint data-link href="#" title="Open chart"></a>
        </div>
        <button class="btn holdCoin fdv-flamebar-hodl" data-hold-btn data-mint="" type="button">HODL</button>
      </div>

      <div class="fdv-flamebar-bar" aria-hidden="true">
        <div class="fdv-flamebar-fill" data-flamebar-fill></div>
      </div>
    </div>
  `;

  frame.appendChild(card);

  const els = {
    pnl: card.querySelector('[data-flamebar-pnl]'),
    meta: card.querySelector('[data-flamebar-meta]'),
    coin: card.querySelector('[data-flamebar-coin]'),
    img: card.querySelector('[data-flamebar-img]'),
    sym: card.querySelector('[data-flamebar-sym]'),
    name: card.querySelector('[data-flamebar-name]'),
    mint: card.querySelector('[data-flamebar-mint]'),
    hodlBtn: card.querySelector('[data-hold-btn]'),
    fill: card.querySelector('[data-flamebar-fill]'),
  };

  return { frame, card, els };
}

export function initFlamebar(mountEl, opts = {}) {
  const options = { ...DEFAULTS, ...(opts || {}) };

  const store = new Map();
  let leaderMint = null;
  let timer = null;

  const getSnapshot = typeof options.getSnapshot === 'function' ? options.getSnapshot : () => null;
  const isActive = typeof options.isActive === 'function' ? options.isActive : () => true;

  const { frame, card, els } = createFlamebarDom({ title: options.title, subtitle: options.subtitle });

  try {
    if (mountEl) mountEl.appendChild(frame);
  } catch {}

  function pushPoint(mint, t, price, meta) {
    const prev = store.get(mint);
    const rec = prev || {
      mint,
      series: [],
      lastSeenAt: 0,
      lastPriceUsd: null,
      symbol: '',
      name: '',
      image: '',
    };

    rec.lastSeenAt = t;
    rec.lastPriceUsd = price;
    if (meta) {
      if (meta.symbol) rec.symbol = meta.symbol;
      if (meta.name) rec.name = meta.name;
      if (meta.image) rec.image = meta.image;
    }

    const s = rec.series;
    if (s.length > 0 && (t - s[s.length - 1].t) < 450) {
      s[s.length - 1] = { t, p: price };
    } else {
      s.push({ t, p: price });
    }

    const cutoff = t - options.windowMs;
    while (s.length && s[0].t < cutoff) s.shift();
    while (s.length > options.maxPoints) s.shift();

    store.set(mint, rec);
    return rec;
  }

  function pickLeader(nowTs, mode = 'pump') {
    const requirePump = mode !== 'pnl';
    let best = null;
    let bestPnl = -Infinity;
    let bestRecent = null;
    let bestScore = -Infinity;

    for (const rec of store.values()) {
      if (!rec) continue;
      if (nowTs - rec.lastSeenAt > (options.windowMs * 2)) continue;

      const pnl = computeWindowPnlPct(rec);
      if (pnl === null || pnl <= 0) continue;

      let recent = null;
      if (requirePump) {
        recent = computeRecentPnlPct(rec, nowTs, options.pumpLookbackMs);
        if (recent === null || recent <= 0) continue;
        if (Number.isFinite(options.minRecentPnlPct) && recent < options.minRecentPnlPct) continue;

        if (Number.isFinite(options.nearHighWithinPct)) {
          const st = computeWindowStats(rec);
          if (st?.hi && st.hi > 0 && st?.last !== null) {
            const gapPct = (st.hi - st.last) / st.hi;
            if (Number.isFinite(gapPct) && gapPct > options.nearHighWithinPct) continue;
          }
        }
      }

      const score = requirePump
        ? (pnl + ((recent || 0) * (Number.isFinite(options.recentWeight) ? options.recentWeight : 0)))
        : pnl;

      if (score > bestScore) {
        bestScore = score;
        bestPnl = pnl;
        bestRecent = recent;
        best = rec;
      }
    }

    return {
      best,
      bestPnl: Number.isFinite(bestPnl) ? bestPnl : null,
      bestRecentPnl: bestRecent,
    };
  }

  function render({ rec, pnlPct, recentPnlPct, sampleCount }) {
    const has = !!(rec && rec.mint);
    const mint = has ? rec.mint : '';

    card.dataset.mint = mint;
    if (els.hodlBtn) els.hodlBtn.dataset.mint = mint;

    try {
      const tokenHydrate = has
        ? {
            mint,
            symbol: rec.symbol || '',
            name: rec.name || '',
            image: rec.image || '',
            priceUsd: rec.lastPriceUsd,
          }
        : null;
      card.dataset.tokenHydrate = tokenHydrate ? JSON.stringify(tokenHydrate) : '';
    } catch {
      card.dataset.tokenHydrate = '';
    }

    if (els.coin) els.coin.hidden = !has;

    if (!has) {
      if (els.pnl) els.pnl.textContent = '—';
      try { if (els.pnl) els.pnl.classList.remove('is-hot'); } catch {}
      if (els.meta) els.meta.textContent = 'Waiting for snapshot…';
      if (els.fill) els.fill.style.width = '0%';
      frame.style.setProperty('--fdv-flame-alpha', '0.35');
      try { if (els.mint) els.mint.setAttribute('href', '#'); } catch {}
      return;
    }

    if (els.pnl) els.pnl.textContent = _fmtPct(pnlPct);
    try {
      const hot = (_num(pnlPct) !== null) && (_num(pnlPct) >= (Number.isFinite(options.hotPnlPct) ? options.hotPnlPct : 30));
      if (els.pnl) els.pnl.classList.toggle('is-hot', !!hot);
    } catch {}

    const priceText = _fmtUsd(rec.lastPriceUsd);
    const sampleText = sampleCount ? `${sampleCount} samples` : '—';
    const recentText = recentPnlPct !== null && recentPnlPct !== undefined ? ` • ${options.pumpLookbackMs >= 60 * 1000 ? '1m' : 'mom'} ${_fmtPct(recentPnlPct)}` : '';
    if (els.meta) els.meta.textContent = `${priceText} • ${sampleText}${recentText}`;

    const sym = rec.symbol || '—';
    if (els.sym) els.sym.textContent = sym;
    if (els.name) els.name.textContent = rec.name || '';
    if (els.mint) {
      els.mint.textContent = _shortMint(mint);
      try { els.mint.setAttribute('href', `/token/${encodeURIComponent(mint)}`); } catch {}
    }

    try {
      const rawLogo = rec.image || '';
      const img = els.img;
      if (img) {
        const logoKey = `${rawLogo}::${sym}`;
        const prevKey = img.getAttribute('data-fdv-logo-key') || '';
        const curSrc = img.getAttribute('src') || '';

        // Important: do NOT reset the src every tick, or we will continuously
        // overwrite the fetched IPFS blob URL with the placeholder.
        if (logoKey !== prevKey || !curSrc) {
          img.setAttribute('data-fdv-logo-key', logoKey);
          img.src = getTokenLogoPlaceholder(rawLogo, sym) || '';
          queueTokenLogoLoad(img, rawLogo, sym);
        }
      }
    } catch {}

    const fill = _clamp((_num(pnlPct) || 0) / 20, 0, 1) * 100;
    if (els.fill) els.fill.style.width = `${fill.toFixed(1)}%`;

    const alpha = _clamp(((_num(pnlPct) || 0) / 12) + 0.35, 0.25, 0.95);
    frame.style.setProperty('--fdv-flame-alpha', String(alpha));
    frame.style.setProperty('--fdv-flame-fill', `${fill.toFixed(1)}%`);
  }

  function tick() {
    const nowTs = Date.now();

    try {
      for (const [mint, rec] of store) {
        if (!rec || (nowTs - rec.lastSeenAt) > (options.windowMs * 3)) store.delete(mint);
      }
    } catch {}

    const snap = getSnapshot();
    const items = Array.isArray(snap) ? snap : (Array.isArray(snap?.items) ? snap.items : []);

    if (!items || items.length === 0) {
      render({ rec: null, pnlPct: null, recentPnlPct: null, sampleCount: 0 });
      return;
    }

    for (const item of items) {
      const mint = extractMint(item);
      if (!mint) continue;
      const price = extractPriceUsd(item);
      if (price === null || price <= 0) continue;
      pushPoint(mint, nowTs, price, {
        symbol: extractSymbol(item),
        name: extractName(item),
        image: extractImage(item),
      });
    }

    // Prefer pump candidates; if none qualify yet (e.g. startup / thin samples),
    // fall back to best positive window PnL so the widget isn't blank.
    let { best, bestPnl, bestRecentPnl } = pickLeader(nowTs, 'pump');
    if (!best) {
      ({ best, bestPnl, bestRecentPnl } = pickLeader(nowTs, 'pnl'));
    }
    if (!best) {
      render({ rec: null, pnlPct: null, recentPnlPct: null, sampleCount: 0 });
      return;
    }

    // Hysteresis to reduce leader flicker.
    try {
      if (leaderMint && leaderMint !== best.mint) {
        const cur = store.get(leaderMint);
        const curPnl = cur ? computeWindowPnlPct(cur) : null;
        const curRecent = cur ? computeRecentPnlPct(cur, nowTs, options.pumpLookbackMs) : null;
        if (curPnl !== null && bestPnl !== null && (bestPnl - curPnl) < options.switchMarginPct) {
          render({ rec: cur, pnlPct: curPnl, recentPnlPct: curRecent, sampleCount: cur?.series?.length || 0 });
          return;
        }
      }
    } catch {}

    leaderMint = best.mint;
    render({ rec: best, pnlPct: bestPnl, recentPnlPct: bestRecentPnl, sampleCount: best?.series?.length || 0 });
  }

  function start() {
    if (timer) return;
    timer = window.setInterval(() => {
      try {
        if (!frame.isConnected) return;
        if (!isActive()) return;
        tick();
      } catch {}
    }, options.tickMs);
  }

  function stop() {
    if (!timer) return;
    try { window.clearInterval(timer); } catch {}
    timer = null;
  }

  function destroy() {
    stop();
    try { frame.remove(); } catch {}
    store.clear();
    leaderMint = null;
  }

  function setActive(on) {
    if (on) {
      start();
      try { setTimeout(tick, 0); } catch {}
    } else {
      stop();
    }
  }

  try {
    if (typeof window !== 'undefined') {
      if (!window.__fdvFlamebar) window.__fdvFlamebar = {};
      window.__fdvFlamebar.init = initFlamebar;
      try {
        window.__fdvFlamebar.instance = {
          frame,
          card,
          tick,
          start,
          stop,
          destroy,
          setActive,
          getLeaderMint: () => leaderMint,
        };
        window.__fdvFlamebar.getLeaderMint = () => {
          try { return window.__fdvFlamebar?.instance?.getLeaderMint?.() || null; } catch { return null; }
        };
      } catch {}
    }
  } catch {}

  try { setActive(true); } catch {}

  return {
    frame,
    card,
    tick,
    start,
    stop,
    destroy,
    setActive,
    getLeaderMint: () => leaderMint,
  };
}
