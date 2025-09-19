import { esc } from "../formatters.js";
import { FDV_LIQ_PENALTY } from "../../../config/env.js";

function recoBar(label, key, value01, hint=''){
  const val = Number.isFinite(value01) ? Math.max(0, Math.min(1, value01)) : 0;
  const aria = Math.round(val*100);
  return `
    <div class="reco__row" data-key="${esc(key)}">
      <div class="reco__row__label" title="${esc(hint)}">${esc(label)}</div>
      <div class="reco__bar" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${aria}" title="${aria}%">
        <div class="reco__bar__fill" style="width:${(val*100).toFixed(0)}%"></div>
      </div>
      <div class="reco__row__val" data-val>${aria}%</div>
    </div>
  `;
}
function booleanChip(ok, { good='OK', bad='Issue', neutral='—' } = {}){
  if (ok === null) return `<span class="chip neutral">${esc(neutral)}</span>`;
  return ok ? `<span class="chip good">${esc(good)}</span>` : `<span class="chip bad">${esc(bad)}</span>`;
}
function kpi(label, html, tooltip=''){
  return `
    <div class="reco__kpi" title="${esc(tooltip)}">
      <div class="reco__kpi__k">${esc(label)}</div>
      <div class="reco__kpi__v">${html}</div>
    </div>
  `;
}

export default function mountRecommendationPanel(gridEl, { scored, token, checks = {} } = {}) {
  const { LIQFDV_OK = null, VLIQR_OK = null, BUYR_OK = null } = checks;
  const grid = gridEl;
  if (!grid) return;

  const wrap = document.createElement('div');
  wrap.className = 'reco';
  wrap.id = 'recoPanel';
  wrap.setAttribute('data-reco', String(scored?.recommendation || '').toLowerCase());

  const barsHtml = [
    recoBar('Composite Score', 'composite', scored?.score ?? 0, 'Weighted volume+liquidity+momentum+activity'),
    recoBar('Volume',   'volume',    scored?._norm?.nVol ?? 0, 'Normalized log volume'),
    recoBar('Liquidity','liquidity', scored?._norm?.nLiq ?? 0, 'Normalized log liquidity'),
    recoBar('Momentum', 'momentum',  scored?._norm?.nMom ?? 0, 'Blended 1h/6h/24h; negatives penalized'),
    recoBar('Activity', 'activity',  scored?._norm?.nAct ?? 0, 'Normalized txn count (24h)'),
  ].join('');

  const liqPctNeeded = (100 / Math.max(FDV_LIQ_PENALTY.ratio || 1, 1));
  const kpisHtml = [
    kpi('FDV/Liq balance', booleanChip(checks.LIQFDV_OK, { good: 'Balanced', bad: 'Imbalance' }), `Needs ≥ ${liqPctNeeded.toFixed(2)}% liquidity-to-FDV`),
    kpi('Turnover 24h', (Number.isFinite(token?.volToLiq24h) ? `${token.volToLiq24h.toFixed(2)}×` : '—') + ' ' + booleanChip(checks.VLIQR_OK, { good: 'Healthy', bad: 'Low', neutral: '' })),
    kpi('Buy Ratio 24h', (Number.isFinite(token?.buySell24h) ? `${(token.buySell24h*100).toFixed(1)}%` : '—') + ' ' + booleanChip(checks.BUYR_OK, { good: 'Buy ≥ 50%', bad: 'Sell ≥ 50%', neutral: '' })),
    kpi('Txns 24h', (Number.isFinite(token?.tx24h?.buys) && Number.isFinite(token?.tx24h?.sells)) ? `${(token.tx24h.buys + token.tx24h.sells).toLocaleString()}` : '—', 'Sum of buys + sells in 24h'),
    kpi('Pairs', (token?.pairs?.length ?? 0).toLocaleString()),
    kpi('Age', (()=>{
      const ms = token?.ageMs;
      if (!Number.isFinite(ms) || ms < 1000) return '—';
      const s = Math.floor(ms/1000);
      const units=[["y",31536000],["mo",2592000],["d",86400],["h",3600],["m",60],["s",1]];
      for (const [l,d] of units) if (s>=d) return `${Math.floor(s/d)}${l}`;
      return "0s";
    })()),
  ].join('');

  const why = Array.isArray(scored?.why) ? scored.why : [];
  const whyHtml = why.length
    ? `<ul class="reco__why">${why.map(w => `<li>${esc(w)}</li>`).join('')}</ul>`
    : `<div class="muted small">No additional notes.</div>`;

  wrap.innerHTML = `
    <div class="reco__header">
      <span class="badge ${String(scored?.recommendation || 'watch').toUpperCase()}" id="recoBadge">${esc(scored?.recommendation)}</span>
      <div class="reco__score">
        <span class="reco__score__label">Score</span>
        <span class="reco__score__val" id="recoScore">${Math.round(((scored?.score) || 0) * 100)}%</span>
      </div>
    </div>
    <div class="reco__bars">${barsHtml}</div>
    <div class="reco__kpis">${kpisHtml}</div>
    <div class="reco__whywrap">
      <div class="label">Why</div>
      ${whyHtml}
    </div>
  `;

  grid.after(wrap);
}

// Smoothly update reco bars and header with new scored values
export function updateRecommendationPanel({ scored } = {}) {
  const panel = document.getElementById('recoPanel');
  if (!panel || !scored) return;

  const apply = (key, val01) => {
    const row = panel.querySelector(`.reco__row[data-key="${key}"]`);
    if (!row) return;
    const fill = row.querySelector('.reco__bar__fill');
    const valEl = row.querySelector('[data-val]');
    const nextPct = Math.max(0, Math.min(100, Math.round((Number(val01) || 0) * 100)));

    const prevPct = Number(row.getAttribute('data-prev') || nextPct);
    row.setAttribute('data-prev', String(nextPct));

    if (fill) fill.style.width = `${nextPct}%`;
    if (valEl) valEl.textContent = `${nextPct}%`;

    // tiny “tick” flash
    row.classList.remove('tick-up','tick-down');
    // force reflow
    void row.offsetWidth;
    if (nextPct > prevPct) row.classList.add('tick-up');
    else if (nextPct < prevPct) row.classList.add('tick-down');
  };

  apply('composite', scored.score ?? 0);
  apply('volume',    scored._norm?.nVol ?? 0);
  apply('liquidity', scored._norm?.nLiq ?? 0);
  apply('momentum',  scored._norm?.nMom ?? 0);
  apply('activity',  scored._norm?.nAct ?? 0);

  // Header badge + score
  const scoreEl = panel.querySelector('#recoScore');
  if (scoreEl) {
    const pct = Math.round(((scored?.score) || 0) * 100);
    scoreEl.textContent = `${pct}%`;
  }
  const badge = panel.querySelector('#recoBadge');
  if (badge) {
    const txt = String(scored?.recommendation || 'watch');
    badge.textContent = txt;
    panel.setAttribute('data-reco', txt.toLowerCase());
  }
}
