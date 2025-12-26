export function sparklineSVG(changes, { w = 120, h = 52 } = {}) {
  const vals = (changes || []).map(v => (Number.isFinite(v) ? v : 0));
  const n = vals.length || 1;

  let min = 0, max = 0;
  for (let i = 0; i < n; i++) {
    const v = vals[i];
    if (v < min) min = v;
    if (v > max) max = v;
  }
  const span = (max - min) || 1;
  const xStep = n > 1 ? (w / (n - 1)) : 0;
  const scale = h / span;

  const y = (v) => h - ((v - min) * scale);

  const segs = new Array(n);
  for (let i = 0; i < n; i++) {
    const X = (i * xStep);
    const Y = y(vals[i]);
    segs[i] = (i === 0 ? `M${X},${Y}` : `L${X},${Y}`);
  }
  const d = segs.join('');

  const goodTrend = vals[n - 1] > vals[0];
  const strokeColor = goodTrend ? "var(--buy,#1aff7a)" : "var(--fdv-primary,#00c2a8)";
  const midY = y(0);

  return `
<svg class="spark" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" preserveAspectRatio="none" aria-hidden="true">
  <path d="M0 ${midY} H ${w}" stroke="rgba(123,215,255,.25)" stroke-width="1" fill="none"/>
  <path d="${d}" stroke="${strokeColor}" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"/>
</svg>`;
}

function _computePathData(vals, w, h) {
  const n = vals.length || 1;
  let min = 0, max = 0;
  for (let i = 0; i < n; i++) {
    const v = vals[i];
    if (v < min) min = v;
    if (v > max) max = v;
  }
  const span = (max - min) || 1;
  const xStep = n > 1 ? (w / (n - 1)) : 0;
  const scale = h / span;
  const y = (v) => h - ((v - min) * scale);

  const segs = new Array(n);
  for (let i = 0; i < n; i++) {
    const X = (i * xStep);
    const Y = y(vals[i]);
    segs[i] = (i === 0 ? `M${X},${Y}` : `L${X},${Y}`);
  }
  const d = segs.join('');
  const midY = y(0);
  const strokeColor = vals[n - 1] > vals[0] ? "var(--buy,#1aff7a)" : "var(--fdv-primary,#00c2a8)";
  return { d, midY, strokeColor };
}

function _elNS(tag) { return document.createElementNS('http://www.w3.org/2000/svg', tag); }

// TODO: add reusable sparkline FIFO component + save store
export function mountSparkline(container, { w = 120, h = 32 } = {}) {
  const svg = _elNS('svg');
  svg.classList.add('spark');
  svg.setAttribute('viewBox', `0 0 ${w} ${h}`);
  svg.setAttribute('width', String(w));
  svg.setAttribute('height', String(h));
  svg.setAttribute('preserveAspectRatio', 'none');

  const scroller = _elNS('g');
  scroller.setAttribute('data-w', String(w));
  svg.appendChild(scroller);

  container.textContent = '';
  container.appendChild(svg);

  return function update(changes = []) {
    const vals = (changes || []).map(v => (Number.isFinite(v) ? v : 0));
    const { d, midY, strokeColor } = _computePathData(vals, w, h);

    const frame = _elNS('g');
    frame.setAttribute('transform', `translate(${w},0)`); // start off-screen right

    const base = _elNS('path');
    base.setAttribute('d', `M0 ${midY} H ${w}`);
    base.setAttribute('stroke', 'rgba(123,215,255,.25)');
    base.setAttribute('stroke-width', '1');
    base.setAttribute('fill', 'none');

    const path = _elNS('path');
    path.setAttribute('d', d);
    path.setAttribute('stroke', strokeColor);
    path.setAttribute('stroke-width', '2');
    path.setAttribute('fill', 'none');
    path.setAttribute('stroke-linecap', 'round');
    path.setAttribute('stroke-linejoin', 'round');

    frame.appendChild(base);
    frame.appendChild(path);
    scroller.appendChild(frame);

    const prev = scroller.children[0];
    const anim = scroller.animate(
      [{ transform: 'translateX(0px)' }, { transform: `translateX(-${w}px)` }],
      { duration: 280, easing: 'linear' }
    );
    anim.onfinish = () => {
      scroller.getAnimations().forEach(a => a.cancel());
      scroller.style.transform = ''; // reset
      if (prev && prev.parentNode === scroller) scroller.removeChild(prev);
      frame.setAttribute('transform', 'translate(0,0)');
    };
  };
}
