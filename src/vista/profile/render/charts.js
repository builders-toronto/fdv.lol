import { esc, debounce } from "../formatters.js";

export function renderBarChart(mount, vals = [], { height = 72, pad = 4, max = null, labels = [] } = {}) {
  if (!mount) return;
  const draw = () => {
    const w = Math.max(220, Math.floor(mount.clientWidth || mount.parentElement?.clientWidth || 320));
    const h = height;
    const v = vals.map(x => Math.max(0, Number(x) || 0));
    const M = (typeof max === "number" && max > 0) ? max : Math.max(1, ...v);
    const bw = (w - pad * 2) / (v.length || 1);

    const bars = v.map((x, i) => {
      const bh = (x / M) * (h - pad * 2);
      const x0 = pad + i * bw, y0 = h - pad - bh;
      return `<rect x="${x0.toFixed(2)}" y="${y0.toFixed(2)}" width="${Math.max(1, bw - 3).toFixed(2)}" height="${Math.max(1, bh).toFixed(2)}" rx="2" ry="2"/>`;
    }).join("");
    const axis = labels.length
      ? `<div class="axis" style="--n:${labels.length};--pad:${pad}px;">${
          labels.map(l => `<div class="axis__tick">${esc(l)}</div>`).join("")
        }</div>`
      : "";

    mount.innerHTML = `<svg class="bars" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" aria-hidden="true">${bars}</svg>${axis}`;
  };

  draw();
  if (!mount.__ro) {
    const ro = new ResizeObserver(debounce(draw, 80));
    ro.observe(mount);
    mount.__ro = ro;
  }
}
