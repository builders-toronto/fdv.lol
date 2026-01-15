import { getTokenLogoPlaceholder, queueTokenLogoLoad } from '../../../../core/ipfs.js';
import { getRugSignalForMint } from '../../../meme/metrics/kpi/pumping.js';
import { MINT_RUG_BLACKLIST_MS, RUG_FORCE_SELL_SEVERITY, RUG_QUOTE_SHOCK_FRAC } from './constants.js';

const DEFAULTS = {
  windowMs: 15 * 60 * 1000,
  maxPoints: 90,
  tickMs: 1250,
  switchMarginPct: 0.25,
  pumpLookbackMs: 60 * 1000,
  minRecentPnlPct: 0.05,
  minRecentPnlPnlModePct: -2.5,
  maxDrawdownFromHighPct: RUG_QUOTE_SHOCK_FRAC,
  respectMintBlacklist: true,
  rugSevThreshold: RUG_FORCE_SELL_SEVERITY,
  rugBlacklistMs: MINT_RUG_BLACKLIST_MS,
  nearHighWithinPct: 0.02,
  recentWeight: 2.0,
  hotPnlPct: 30,
  bootstrapScanLimit: 250,
  bootstrapMinPnlPct: 0.01,
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

function extractInstantPnlPct(item) {
  const change = item?.change || item?.changes || item?.priceChange || {};
  const chgArr = Array.isArray(item?._chg) ? item._chg : [];
  return _num(
    item?.pnl15m ??
    item?.pnlPct ??
    item?.pnl ??
    item?.change15m ??
    item?.chg15m ??
    change?.m15 ??
    item?.change5m ??
    item?.chg5m ??
    change?.m5 ??
    chgArr?.[0] ??
    item?.change1h ??
    item?.chg1h ??
    change?.h1 ??
    chgArr?.[1] ??
    change?.h24 ??
    chgArr?.[3]
  );
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

function _getMintBlacklistMap() {
  try {
    const map = window?._fdvMintBlacklist;
    return map && typeof map.get === 'function' ? map : null;
  } catch {
    return null;
  }
}

function isMintBlacklisted(mint) {
  try {
    const m = String(mint || '').trim();
    if (!m) return false;
    const map = _getMintBlacklistMap();
    if (!map) return false;

    const rec = map.get(m);
    if (!rec) return false;

    // Different modules use either a number(untilMs) or an object({until}).
    const until = typeof rec === 'number' ? rec : Number(rec?.until || 0);
    if (!(until > Date.now())) {
      try { map.delete(m); } catch {}
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

function setMintBlacklist(mint, ms) {
  try {
    const m = String(mint || '').trim();
    if (!m) return false;
    if (typeof window === 'undefined') return false;
    if (!window._fdvMintBlacklist) window._fdvMintBlacklist = new Map();
    const map = window._fdvMintBlacklist;
    const prev = map.get(m);
    const prevCount = typeof prev === 'object' && prev ? Number(prev.count || 0) : 0;
    const until = Date.now() + Math.max(5_000, Number(ms || 0));
    map.set(m, { until, count: prevCount + 1, lastAt: Date.now() });
    return true;
  } catch {
    return false;
  }
}

function getRugSig(mint) {
  try {
    return typeof getRugSignalForMint === 'function' ? (getRugSignalForMint(mint) || null) : null;
  } catch {
    return null;
  }
}

function drawdownFromHighFrac(rec) {
  const st = computeWindowStats(rec);
  if (!st || !Number.isFinite(st.hi) || !(st.hi > 0) || st.last === null) return null;
  const dd = (st.hi - st.last) / st.hi;
  return Number.isFinite(dd) ? dd : null;
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
        <div class="fdv-flamebar-logo" aria-hidden="true">
          <img data-flamebar-img alt="" />
          <div class="fdv-flamebar-logoSpin" data-flamebar-logo-spin aria-hidden="true"></div>
        </div>
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
    logoSpin: card.querySelector('[data-flamebar-logo-spin]'),
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
  let bootstrappedOnce = false;

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

  function seedFromInstantPnl(mint, nowTs, price, pnlPct, meta) {
    const p = _num(price);
    const pnl = _num(pnlPct);
    if (!mint || !Number.isFinite(nowTs) || p === null || p <= 0 || pnl === null) return null;

    const base = p / (1 + (pnl / 100));
    if (!Number.isFinite(base) || base <= 0) return null;

    const baseTs = nowTs - Math.max(1000, Math.min(options.windowMs - 1, options.pumpLookbackMs || 0));
    try { pushPoint(mint, baseTs, base, meta); } catch {}
    return pushPoint(mint, nowTs, p, meta);
  }

  function bootstrapLeaderFromSnapshot(items, nowTs) {
    if (bootstrappedOnce || leaderMint) return null;
    const list = Array.isArray(items) ? items : [];
    const lim = Number.isFinite(options.bootstrapScanLimit) && options.bootstrapScanLimit > 0
      ? Math.floor(options.bootstrapScanLimit)
      : list.length;
    const minPnl = Number.isFinite(options.bootstrapMinPnlPct) ? options.bootstrapMinPnlPct : 0;

    for (let i = 0; i < Math.min(list.length, lim); i++) {
      const item = list[i];
      const mint = extractMint(item);
      if (!mint) continue;
      const price = extractPriceUsd(item);
      if (price === null || price <= 0) continue;

      const instantPnl = extractInstantPnlPct(item);
      if (instantPnl === null || instantPnl <= 0 || instantPnl < minPnl) continue;

      const rec = seedFromInstantPnl(mint, nowTs, price, instantPnl, {
        symbol: extractSymbol(item),
        name: extractName(item),
        image: extractImage(item),
      });

      if (rec) {
        bootstrappedOnce = true;
        leaderMint = mint;
        return { rec, pnlPct: instantPnl };
      }
    }
    return null;
  }

  function isRejectedMint(mint, rec, nowTs) {
    try {
      const m = String(mint || '').trim();
      if (!m) return { reject: true, reason: 'missing' };

      if (options.respectMintBlacklist && isMintBlacklisted(m)) {
        return { reject: true, reason: 'blacklisted' };
      }

      const sig = getRugSig(m);
      const sev = Number(sig?.sev ?? 0);
      const sevThr = Number.isFinite(options.rugSevThreshold) ? options.rugSevThreshold : null;

      // Treat high severity as a reject even before it flips `rugged`.
      if ((sig?.rugged === true) || (sevThr !== null && Number.isFinite(sev) && sev >= sevThr)) {
        try { setMintBlacklist(m, options.rugBlacklistMs); } catch {}
        return { reject: true, reason: 'rug', sev };
      }

      if (rec) {
        const dd = drawdownFromHighFrac(rec);
        if (dd !== null && Number.isFinite(options.maxDrawdownFromHighPct) && dd >= options.maxDrawdownFromHighPct) {
          // Dumped too hard from its own recent high.
          try { setMintBlacklist(m, options.rugBlacklistMs); } catch {}
          return { reject: true, reason: 'drawdown', dd };
        }

        const recent = computeRecentPnlPct(rec, nowTs, options.pumpLookbackMs);
        if (
          recent !== null &&
          Number.isFinite(options.minRecentPnlPnlModePct) &&
          recent < options.minRecentPnlPnlModePct
        ) {
          // Fast downside momentum.
          try { setMintBlacklist(m, Math.min(5 * 60 * 1000, options.rugBlacklistMs)); } catch {}
          return { reject: true, reason: 'recent-drop', recent };
        }
      }

      return { reject: false, reason: '' };
    } catch {
      return { reject: false, reason: '' };
    }
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

      const rej = isRejectedMint(rec.mint, rec, nowTs);
      if (rej?.reject) continue;

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

      // Even in PnL-only fallback mode, don't promote actively dumping names.
      if (!requirePump) {
        const recentPnl = computeRecentPnlPct(rec, nowTs, options.pumpLookbackMs);
        if (recentPnl !== null && Number.isFinite(options.minRecentPnlPnlModePct) && recentPnl < options.minRecentPnlPnlModePct) {
          continue;
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

    // Show the coin row in "loading" state so we can display the logo spinner.
    if (els.coin) els.coin.hidden = false;
    try { card.classList.toggle('is-loading', !has); } catch {}
    try {
      if (els.logoSpin) els.logoSpin.hidden = !!has;
    } catch {}

    if (!has) {
      if (els.pnl) els.pnl.textContent = '—';
      try { if (els.pnl) els.pnl.classList.remove('is-hot'); } catch {}
      if (els.meta) els.meta.textContent = 'Waiting for snapshot…';
      if (els.fill) els.fill.style.width = '0%';
      frame.style.setProperty('--fdv-flame-alpha', '0.35');
      try {
        if (els.sym) els.sym.textContent = '—';
        if (els.name) els.name.textContent = '';
        if (els.mint) {
          els.mint.textContent = '';
          els.mint.setAttribute('href', '#');
        }
      } catch {}
      try {
        if (els.hodlBtn) {
          els.hodlBtn.dataset.mint = '';
          els.hodlBtn.disabled = true;
        }
      } catch {}
      return;
    }

    try { if (els.hodlBtn) els.hodlBtn.disabled = false; } catch {}

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

    if (!leaderMint) {
      const boot = bootstrapLeaderFromSnapshot(items, nowTs);
      if (boot?.rec) {
        // Do not bootstrap into a known-bad mint.
        const rej = isRejectedMint(boot.rec.mint, boot.rec, nowTs);
        if (rej?.reject) {
          leaderMint = null;
        } else {
        const recent = computeRecentPnlPct(boot.rec, nowTs, options.pumpLookbackMs);
        render({ rec: boot.rec, pnlPct: boot.pnlPct, recentPnlPct: recent, sampleCount: boot.rec?.series?.length || 0 });
        return;
        }
      }
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

    // If the current leader has become rugged/blacklisted/dumped, drop it immediately.
    try {
      if (leaderMint) {
        const cur = store.get(leaderMint);
        const rej = isRejectedMint(leaderMint, cur, nowTs);
        if (rej?.reject) {
          leaderMint = null;
        }
      }
    } catch {}

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
        const curRej = cur ? isRejectedMint(leaderMint, cur, nowTs) : null;
        if (curRej?.reject) {
          // Never hold onto a rejected mint.
        } else {
        const curPnl = cur ? computeWindowPnlPct(cur) : null;
        const curRecent = cur ? computeRecentPnlPct(cur, nowTs, options.pumpLookbackMs) : null;
        if (curPnl !== null && bestPnl !== null && (bestPnl - curPnl) < options.switchMarginPct) {
          render({ rec: cur, pnlPct: curPnl, recentPnlPct: curRecent, sampleCount: cur?.series?.length || 0 });
          return;
        }
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
