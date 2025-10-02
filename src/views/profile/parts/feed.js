import { fmtMoney, fmtNum, pill } from "../formatters.js";
import { setStatPrice } from "../render/statsGrid.js";
import { renderPairsTable } from "../render/pairsTable.js";
import { updateRecommendationPanel } from "../render/recommendation.js";
import { updateLivePriceLine, updateLivePriceAnchors } from "../render/liveLine.js";

const FEED = (window.__fdvProfileFeed = window.__fdvProfileFeed || { ac:null, mint:null, timer:null });

function isStreamOnDom() {
  const btn = document.getElementById('stream');
  if (!btn) return true;
  const ap = btn.getAttribute('aria-pressed');
  if (ap != null) return ap === 'true' || ap === '1';
  return /on/i.test(btn.textContent || '');
}

function stopProfileFeed() {
  if (FEED.timer) { clearTimeout(FEED.timer); FEED.timer = null; }
  if (FEED.ac) { try { FEED.ac.abort(); } catch {} FEED.ac = null; }
}

export function startProfileFeed({ mint, initial, fetchTokenInfoLive, scoreAndRecommendOne, statsCtx }) {
  stopProfileFeed();
  FEED.mint = mint;
  FEED.ac = new AbortController();
  let prev = initial || null;

  const tick = async () => {
    if (!isStreamOnDom()) { FEED.timer = setTimeout(tick, 1400); return; }
    const ac = FEED.ac;
    if (ac?.signal.aborted) return;
    try {
      const live = await fetchTokenInfoLive(mint, { signal: ac.signal, ttlMs: 2000 });
      if (ac?.signal.aborted || !live) return;
      const cur = live; // already sanitized upstream in caller

      updateStatsGridLive(cur, prev, statsCtx);
      updatePairsTableLive(cur);

      try {
        const scored = scoreAndRecommendOne(cur);
        updateRecommendationPanel({ scored });
      } catch {}

      prev = cur;
    } catch {} finally {
      if (!FEED.ac?.signal.aborted) {
        FEED.timer = setTimeout(tick, 2000 + Math.floor(Math.random()*400));
      }
    }
  };
  const startDelay = 600; // ms
  setTimeout(tick, startDelay);

  if (!FEED._wiredStreamEvt) {
    FEED._wiredStreamEvt = true;
    document.addEventListener('stream-state', () => {
      if (isStreamOnDom() && FEED.mint && !FEED.timer) {
        FEED.timer = setTimeout(() => startProfileFeed({ mint: FEED.mint, initial: prev, fetchTokenInfoLive, scoreAndRecommendOne, statsCtx }), 50);
      }
    });
  }
}

function pairsSignature(pairs) {
  if (!Array.isArray(pairs) || !pairs.length) return "";
  return pairs
    .slice(0, 30)
    .map(p => `${p.dexId || ""}:${p.pairAddress || p.address || p.mint || ""}`)
    .join("|") + `|len=${pairs.length}`;
}

function updatePairsTableLive(t) {
  const body = document.getElementById("pairsBody");
  if (!body) return;

  const newSig = pairsSignature(t.pairs);
  const prevSig = body.dataset.pairsSig || "";
  const firstAt = Number(body.dataset.pairsRenderedAt || 0);
  const now = Date.now();
  const EARLY_WINDOW_MS = 2500;

  // Identity unchanged & still in early window: do a lightweight numeric refresh only
  if (newSig === prevSig && now - firstAt < EARLY_WINDOW_MS) {
    try { patchPairNumbers(body, t.pairs); } catch {}
    return;
  }

  if (newSig === prevSig) return; // no identity change after early window -> skip

  renderPairsTable(body, t.pairs);
  body.dataset.pairsSig = newSig;
  if (!firstAt) body.dataset.pairsRenderedAt = String(now);
}

// Lightweight numeric in-place update (no full repaint)
function patchPairNumbers(body, pairs) {
  if (!Array.isArray(pairs) || !pairs.length) return;
  // Build quick lookup by (dexId + key)
  const idx = new Map();
  for (const p of pairs) {
    const key = (p.dexId || "") + "|" + (p.pairAddress || p.address || p.mint || "");
    idx.set(key, p);
  }
  const rows = body.querySelectorAll("tr");
  rows.forEach(tr => {
    const dex = tr.children[0]?.textContent?.trim() || "";
    const tradeLink = tr.querySelector("a.buy-btn");
    const href = tradeLink?.getAttribute("href") || "";
    // Approximate key match
    let match = null;
    for (const [k, v] of idx) {
      if (k.startsWith(dex + "|") && href.includes(v.pairAddress || v.address || v.mint || "")) {
        match = v;
        break;
      }
    }
    if (!match) return;
    // Cells: 0 dex | 1 price | 2 liq | 3 v24 | 4 ch1h | 5 ch24 | 6 trade
    safeSet(tr.children[1], fmtMoney(match.priceUsd));
    safeSet(tr.children[2], fmtMoney(match.liquidityUsd));
    safeSet(tr.children[3], fmtMoney(match.v24h));
    safeSet(tr.children[4], fmtPct(match.change1h ?? null));
    safeSet(tr.children[5], fmtPct(match.change24h ?? null));
  });
}

function safeSet(td, val) {
  if (!td) return;
  if (td.textContent !== val) td.textContent = val;
}

function updateStatsGridLive(t, prev, ctx) {
  const qv = (key) => document.querySelector(`.stat[data-stat="${key}"] .v`);
  const flashV = (el, diff) => {
    if (!el || !Number.isFinite(diff)) return;
    el.classList.remove('tick-up','tick-down'); void el.offsetWidth;
    if (diff > 0) el.classList.add('tick-up');
    else if (diff < 0) el.classList.add('tick-down');
  };
  const num = (x) => (Number.isFinite(x) ? +x : NaN);

  // price
  {
    const el = qv("price");
    const d = num(t.priceUsd) - num(prev?.priceUsd);
    if (el && ctx?.gridEl) {
      setStatPrice(ctx.gridEl, t.priceUsd, { maxFrac: 6, minFrac: 1 });
      flashV(el, d);
    }
    if (Number.isFinite(t.priceUsd) && t.priceUsd !== prev?.priceUsd && ctx?.liveWrap) {
      updateLivePriceLine(ctx.liveWrap, +t.priceUsd, Date.now());
    }
    const changed =
      (t.change5m !== prev?.change5m) ||
      (t.change1h !== prev?.change1h) ||
      (t.change6h !== prev?.change6h) ||
      (t.change24h !== prev?.change24h);
    if (changed && ctx?.liveWrap) {
      updateLivePriceAnchors(
        ctx.liveWrap,
        { "5m": t.change5m, "1h": t.change1h, "6h": t.change6h, "24h": t.change24h },
        t.priceUsd
      );
    }
  }
  // liquidity
  {
    const el = qv("liq");
    const d = num(t.liquidityUsd) - num(prev?.liquidityUsd);
    if (el) { el.textContent = fmtMoney(t.liquidityUsd); flashV(el, d); }
  }
  // fdv
  {
    const cur = Number.isFinite(t.fdv) ? t.fdv : t.marketCap;
    const prv = Number.isFinite(prev?.fdv) ? prev.fdv : prev?.marketCap;
    const el = qv("fdv");
    const d = num(cur) - num(prv);
    if (el) { el.textContent = fmtMoney(cur); flashV(el, d); }
  }
  // liq/fdv %
  {
    const el = qv("liqfdv");
    const curTxt = Number.isFinite(t.liqToFdvPct) ? `${t.liqToFdvPct.toFixed(2)}%` : "—";
    if (el) el.textContent = curTxt;
  }
  // 24h volume
  {
    const el = qv("v24");
    const d = num(t.v24hTotal) - num(prev?.v24hTotal);
    if (el) { el.textContent = fmtMoney(t.v24hTotal); flashV(el, d); }
  }
  // turnover 24h
  {
    const el = qv("vliqr");
    const d = num(t.volToLiq24h) - num(prev?.volToLiq24h);
    if (el) { el.textContent = Number.isFinite(t.volToLiq24h) ? `${t.volToLiq24h.toFixed(2)}×` : "—"; flashV(el, d); }
  }
  // deltas
  {
    const setDelta = (key, val, prevVal) => {
      const el = qv(key);
      if (!el) return;
      el.innerHTML = pill(val);
      flashV(el, num(val) - num(prevVal));
    };
    setDelta("d5m",  t.change5m,  prev?.change5m);
    setDelta("d1h",  t.change1h,  prev?.change1h);
    setDelta("d6h",  t.change6h,  prev?.change6h);
    setDelta("d24h", t.change24h, prev?.change24h);
  }
  // buys/sells 24h
  {
    const el = qv("bs24");
    const b = num(t?.tx24h?.buys), s = num(t?.tx24h?.sells);
    if (el) el.textContent = (Number.isFinite(b) && Number.isFinite(s)) ? `${fmtNum(b)} / ${fmtNum(s)}` : "—";
  }
  // buy ratio
  {
    const el = qv("buyratio");
    if (el) el.textContent = Number.isFinite(t.buySell24h) ? `${(t.buySell24h * 100).toFixed(1)}% buys` : "—";
  }
}