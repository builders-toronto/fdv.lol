export function mountLivePriceLine(container, { windowMs = 10 * 60 * 1000, height = 140, pad = 8 } = {}) {
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

  const state = {
    svg, line, area,
    points: [], // [ [ts, price], ... ]
    windowMs, height, pad, width: container.clientWidth || 600,
  };

  const ro = ("ResizeObserver" in window) ? new ResizeObserver(() => {
    state.width = container.clientWidth || state.width;
    render();
  }) : null;
  if (ro) ro.observe(container);

  function render() {
    const now = Date.now();
    const from = now - state.windowMs;
    state.points = state.points.filter(p => p[0] >= from);
    if (!state.points.length) {
      state.line.setAttribute("d", "");
      state.area.setAttribute("d", "");
      return;
    }

    const w = state.width;
    const h = state.height;
    state.svg.setAttribute("viewBox", `0 0 ${w} ${h}`);
    const xs = state.points.map(p => p[0]);
    const ys = state.points.map(p => p[1]);
    const minX = Math.min(...xs), maxX = Math.max(...xs);
    let minY = Math.min(...ys), maxY = Math.max(...ys);
    if (!Number.isFinite(minY) || !Number.isFinite(maxY)) return;

    // Avoid flat-line collapse
    if (minY === maxY) {
      const bump = minY === 0 ? 1 : Math.abs(minY) * 0.01;
      minY -= bump;
      maxY += bump;
    }

    const px = (t) => {
      if (maxX === minX) return w;
      return ((t - from) / (state.windowMs)) * w;
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
    state.points.push([ts, price]);
    const lbl = container.querySelector("#livePriceNow");
    if (lbl) {
      // minimal inline formatting to avoid deps here; keep one decimal at least
      const s = String(price);
      let out = s;
      if (!s.includes(".")) out = s + ".0";
      lbl.textContent = `$${out}`;
    }
    render();
  }

  container.__livePrice = { push, render, destroy: () => ro?.disconnect() };
  return container.__livePrice;
}

export function updateLivePriceLine(container, price, ts = Date.now()) {
  const inst = container?.__livePrice;
  if (inst) inst.push(price, ts);
}