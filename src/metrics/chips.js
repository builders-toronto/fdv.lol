import { pct } from '../config/env.js';

export function pctChipsHTML(changes){
  const labels = ['5m','1h','6h'];
  const arr = Array.isArray(changes) ? changes : [];
  const spans = labels.map((lab, i) => {
    const v = +arr[i];
    if (!Number.isFinite(v)) {
      return `<span class="pct flat" title="${lab} change unavailable">—</span>`;
    }
    const cls = v > 0 ? 'up' : v < 0 ? 'down' : 'flat';
    return `<span class="pct ${cls}" title="${lab} change">${pct(v)}</span>`;
  });
  return `<div class="pctrow">${spans.join('')}</div>`;
}
