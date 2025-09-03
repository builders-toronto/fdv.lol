export function sparklineSVG(changes, {w=120, h=32}={}){
  const vals = (changes||[]).map(v => Number.isFinite(v)? v : 0);
  const n = vals.length || 1;
  const min = Math.min(0, ...vals), max = Math.max(0, ...vals);
  const span = (max - min) || 1;
  const xStep = w / (n - 1 || 1);
  const y = v => h - ((v - min) / span) * h;

  let d = '';
  for (let i=0;i<n;i++){
    const X = i * xStep;
    const Y = y(vals[i]);
    d += (i===0?`M${X},${Y}`:` L${X},${Y}`);
  }

  const goodTrend = vals[vals.length-1] > vals[0];
  const strokeColor = goodTrend ? "var(--buy,#1aff7a)" : "var(--avoid,#ff4d6d)";

  const midY = y(0);
  return `
<svg class="spark" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" aria-hidden="true">
  <path d="M0 ${midY} H ${w}" stroke="rgba(123,215,255,.25)" stroke-width="1" fill="none"/>
  <path d="${d}" stroke="${strokeColor}" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"/>
</svg>`;
}
