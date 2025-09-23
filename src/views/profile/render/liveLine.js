export function mountLivePriceLine(container, { windowMs = 10 * 60 * 1000, height = 140, pad = 8, seed } = {}) {
  if (!container) return null;
  container.classList.add("livePrice");
  container.innerHTML = `
    <div class="livePrice__head">
      <div class="ttl">Live Price</div>
      <div class="val" id="livePriceNow">—</div>
    </div>
    <svg class="livePrice__svg" preserveAspectRatio="none"></svg>
  `;
  const svg = container.querySelector("svg");
  const line = document.createElementNS("http://www.w3.org/2000/svg", "path");
  const area = document.createElementNS("http://www.w3.org/2000/svg", "path");
  line.setAttribute("class", "livePrice__line");
  area.setAttribute("class", "livePrice__area");
  svg.appendChild(area);
  svg.appendChild(line);

  const PERIODS = { "5m": 5 * 60 * 1000, "1h": 60 * 60 * 1000, "6h": 6 * 60 * 60 * 1000, "24h": 24 * 60 * 60 * 1000 };

  const state = {
    svg, line, area,
    points: [],          // [ [ts, price], ... ], sorted asc
    windowMs, height, pad, width: container.clientWidth || 600,
    timeFrom: null,      // earliest ts shown (left edge)
    timeTo: null,        // latest ts shown (right edge)
    lastPrice: NaN
  };

  const ro = ("ResizeObserver" in window) ? new ResizeObserver(() => {
    state.width = container.clientWidth || state.width;
    render();
  }) : null;
  if (ro) ro.observe(container);

  function computeAnchors(nowPrice, changes, nowTs = Date.now()) {
    if (!Number.isFinite(nowPrice) || !changes) return [];
    const anchors = [];
    // Rank by recency: 5m, 1h, 6h, 24h if available
    const order = ["24h","6h","1h","5m"]; // compute oldest first, will sort later
    for (const k of order) {
      const pct = Number(changes?.[k] ?? changes?.[k.replace("h","h")] ?? NaN);
      const period = PERIODS[k];
      if (!Number.isFinite(pct) || !period) continue;
      // pricePast * (1 + pct/100) = nowPrice  => pricePast = nowPrice / (1 + pct/100)
      const denom = 1 + (pct / 100);
      if (denom === 0) continue;
      const past = nowPrice / denom;
      const ts = nowTs - period;
      if (Number.isFinite(past) && past >= 0) anchors.push([ts, past]);
    }
    anchors.sort((a,b) => a[0] - b[0]); // oldest -> newest
    // ensure unique timestamps
    const uniq = [];
    let lastTs = -Infinity;
    for (const a of anchors) {
      if (a[0] !== lastTs) { uniq.push(a); lastTs = a[0]; }
    }
    return uniq;
  }

  function sampleAnchors(anchors, nowPoint, samplesPerSeg = 24) {
    const out = [];
    if (!anchors.length && nowPoint) return [nowPoint];
    const pts = [...anchors, nowPoint].filter(Boolean);
    for (let i = 0; i < pts.length; i++) {
      const cur = pts[i];
      if (i === 0) { out.push(cur); continue; }
      const prev = pts[i - 1];
      const dt = cur[0] - prev[0];
      const dv = cur[1] - prev[1];
      const steps = Math.max(2, Math.min(samplesPerSeg, Math.floor(dt / 1000))); // ~1s granularity
      for (let s = 1; s < steps; s++) {
        const f = s / steps;
        out.push([prev[0] + f * dt, prev[1] + f * dv]);
      }
      out.push(cur);
    }
    return out;
  }

  function animateDraw() {
    try {
      const len = state.line.getTotalLength();
      state.line.style.transition = "none";
      state.line.style.strokeDasharray = `${Math.max(1, len)} ${Math.max(1, len)}`;
      state.line.style.strokeDashoffset = `${Math.max(1, len)}`;
      // force reflow
      // eslint-disable-next-line no-unused-expressions
      state.line.getBoundingClientRect();
      state.line.style.transition = "stroke-dashoffset .6s ease";
      state.line.style.strokeDashoffset = "0";
      // clear dash after animation ends for crispness
      setTimeout(() => {
        state.line.style.transition = "";
        state.line.style.strokeDasharray = "";
        state.line.style.strokeDashoffset = "";
      }, 700);
    } catch {}
  }

  function render() {
    if (!state.points.length) {
      state.line.setAttribute("d", "");
      state.area.setAttribute("d", "");
      return;
    }

    // Horizontal domain: from earliest point to latest point (starts at left, moves right)
    const minTs = state.points[0][0];
    const maxTs = state.points[state.points.length - 1][0];
    state.timeFrom = minTs;
    state.timeTo = maxTs;

    const w = state.width;
    const h = state.height;
    state.svg.setAttribute("viewBox", `0 0 ${w} ${h}`);

    let minY = Infinity, maxY = -Infinity;
    for (const [, v] of state.points) {
      if (v < minY) minY = v;
      if (v > maxY) maxY = v;
    }
    if (!Number.isFinite(minY) || !Number.isFinite(maxY)) return;

    // Avoid flat-line collapse
    if (minY === maxY) {
      const bump = minY === 0 ? 1 : Math.abs(minY) * 0.01;
      minY -= bump;
      maxY += bump;
    }

    const px = (t) => {
      const span = (state.timeTo - state.timeFrom) || 1;
      let x = ((t - state.timeFrom) / span) * w;
      if (!Number.isFinite(x)) x = 0;
      return Math.max(0, Math.min(w, x));
    };
    const py = (v) => {
      const y = (v - minY) / (maxY - minY);
      return h - (y * (h - state.pad * 2) + state.pad);
    };

    let d = "";
    for (let i = 0; i < state.points.length; i++) {
      const [t, v] = state.points[i];
      const x = px(t), y = py(v);
      d += (i === 0 ? `M ${x} ${y}` : ` L ${x} ${y}`);
    }
    state.line.setAttribute("d", d);

    // Area under curve
    const first = state.points[0];
    const last = state.points[state.points.length - 1];
    const baseY = py(minY);
    const dArea = `${d} L ${px(last[0])} ${baseY} L ${px(first[0])} ${baseY} Z`;
    state.area.setAttribute("d", dArea);
  }

  function push(price, ts = Date.now()) {
    if (!Number.isFinite(price)) return;
    state.lastPrice = price;
    // Append new point and keep in ascending order
    state.points.push([ts, price]);
    // Small tail trim to keep performance (keep last 2000 points)
    if (state.points.length > 2000) state.points.splice(0, state.points.length - 2000);

    const lbl = container.querySelector("#livePriceNow");
    if (lbl) {
      const s = String(price);
      let out = s;
      if (!s.includes(".")) out = s + ".0";
      lbl.textContent = `$${out}`;
    }
    render();
  }

  function seedFromPercent({ priceNow, changes, nowTs = Date.now() }) {
    if (!Number.isFinite(priceNow)) return;
    state.lastPrice = priceNow;
    const anchors = computeAnchors(priceNow, changes, nowTs);
    const sampled = sampleAnchors(anchors, [nowTs, priceNow], 24);
    state.points = sampled;
    render();
    animateDraw();
  }

  container.__livePrice = {
    push,
    render,
    destroy: () => ro?.disconnect(),
    seedFromPercent
  };

  // Optional initial seeding from percent changes
  try {
    if (seed?.priceNow != null && seed?.changes) {
      container.__livePrice.seedFromPercent({ priceNow: +seed.priceNow, changes: seed.changes, nowTs: Date.now() });
    }
  } catch {}

  return container.__livePrice;
}

export function updateLivePriceLine(container, price, ts = Date.now()) {
  const inst = container?.__livePrice;
  if (inst) inst.push(price, ts);
}

export function updateLivePriceAnchors(container, changes, priceNow) {
  const inst = container?.__livePrice;
  if (!inst) return;
  const p = Number.isFinite(+priceNow) ? +priceNow : inst.lastPrice;
  if (!Number.isFinite(p)) return;
  try {
    inst.seedFromPercent({ priceNow: p, changes, nowTs: Date.now() });
  } catch {}
}