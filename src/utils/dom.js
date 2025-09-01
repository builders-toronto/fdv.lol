import { adCard } from '../ads/load.js';
import { sparklineSVG } from '../metrics/sparkline.js';
import { pctChipsHTML } from '../metrics/chips.js';
import { MAX_CARDS, EXPLORER, FALLBACK_LOGO, JUP_SWAP, shortAddr, nz } from '../config/env.js';
import { normalizeSocial, iconFor, xSearchUrl } from '../servicecs/socials.js';
import { normalizeWebsite } from '../utils/normalize.js';

export const elCards = document.getElementById('cards');
export const elMeta  = document.getElementById('meta');
export const elQ     = document.getElementById('q');
export const elSort  = document.getElementById('sort');
export const elRefresh = document.getElementById('refresh');
export const elRelax = document.getElementById('relax');

export function render(items, CURRENT_AD){
  const sort = elSort.value;
  items = [...items];
  items.sort((a,b)=>{
    if (sort==='volume') return b.volume.h24 - a.volume.h24;
    if (sort==='liquidity') return b.liquidityUsd - a.liquidityUsd;
    if (sort==='change24') return b.change.h24 - a.change.h24;
    return b.score - a.score;
  });

  items = items.slice(0, MAX_CARDS);

  if (!items.length){
    elCards.innerHTML = `<div class="small">No matches. Try “relax filter”, different sort, or refresh.</div>`;
    return;
  }
  elCards.innerHTML = items.map(coinCard).join('');

  const adHtml = CURRENT_AD ? adCard(CURRENT_AD) : '';
  elCards.innerHTML = adHtml + items.map(coinCard).join('');
}

function fmtUsd(x){
  const v = nz(x);
  if (v>=1e9) return '$'+(v/1e9).toFixed(2)+'B';
  if (v>=1e6) return '$'+(v/1e6).toFixed(2)+'M';
  if (v>=1e3) return '$'+(v/1e3).toFixed(2)+'k';
  return '$'+v.toFixed(2);
}

export function renderSkeleton(n=8){
  elCards.innerHTML = '';
  for (let i=0;i<n;i++){
    const d=document.createElement('div');
    d.className='card';
    d.innerHTML=`
      <div class="top">
        <div class="logo skel"></div>
        <div style="flex:1">
          <div class="sym skel" style="height:14px;width:120px;border-radius:6px"></div>
          <div class="addr skel" style="height:10px;width:160px;margin-top:6px;border-radius:6px"></div>
        </div>
        <div class="rec skel" style="width:60px;height:22px"></div>
      </div>
      <div class="metrics" style="margin-top:10px">
        ${Array.from({length:6}).map(()=>`<div class="kv"><div class="k skel" style="height:10px;border-radius:5px"></div><div class="v skel" style="height:14px;margin-top:6px;border-radius:6px"></div></div>`).join('')}
      </div>`;
    elCards.appendChild(d);
  }
}

export function coinCard(it){
  const logo = it.logoURI || FALLBACK_LOGO(it.symbol);
  const website = normalizeWebsite(it.website) || EXPLORER(it.mint);
  const buyUrl = JUP_SWAP(it.mint);

  const links = (Array.isArray(it.socials) ? it.socials : [])
    .map(normalizeSocial)
    .filter(Boolean)
    .reduce((acc, s) => { if(!acc.some(x=>x.href===s.href)) acc.push(s); return acc; }, [])
    .slice(0, 6);

  let socialsHtml = links.map(s =>
    `<a class="iconbtn" href="${s.href}" target="_blank" rel="noopener nofollow"
        aria-label="${s.platform}" data-tooltip="${s.platform}">
        ${iconFor(s.platform)}
     </a>`
  ).join('');

  if (!links.length) {
    const xUrl = xSearchUrl(it.symbol, it.name, it.mint);
    socialsHtml =
      `<a class="iconbtn" href="${xUrl}" target="_blank" rel="noopener nofollow"
          aria-label="Search on X" data-tooltip="Search ${it.symbol ? '$'+it.symbol.toUpperCase() : 'on X'}">
          ${iconFor('x')}
       </a>`;
  }

  const micro = `
    <div class="micro">
      ${pctChipsHTML(it._chg)}
      ${sparklineSVG(it._chg)}
    </div>`;

  return `
<article class="card" data-hay="${(it.symbol||'')+' '+(it.name||'')+' '+it.mint}">
  <div class="top">
    <div class="logo"><img src="${logo}" alt=""></div>
    <div style="flex:1">
      <div class="sym">${it.symbol || ''} <span class="badge">${(it.dex||'').toUpperCase()}</span></div>
      <div class="addr"><a href="${EXPLORER(it.mint)}" target="_blank" rel="noopener">Mint: ${shortAddr(it.mint)}</a></div>
    </div>
    <div class="rec ${it.recommendation}">${it.recommendation}</div>
  </div>
  <div class="metrics">
    <div class="kv"><div class="k">Price</div><div class="v">${it.priceUsd? ('$'+Number(it.priceUsd).toLocaleString(undefined,{maximumFractionDigits:6})) : '—'}</div></div>
    <div class="kv"><div class="k">Trending Score</div><div class="v">${Math.round(it.score*100)} / 100</div></div>
    <div class="kv"><div class="k">24h Volume</div><div class="v">${fmtUsd(it.volume.h24)}</div></div>
    <div class="kv"><div class="k">Liquidity</div><div class="v">${fmtUsd(it.liquidityUsd)}</div></div>
    <div class="kv"><div class="k">FDV</div><div class="v">${it.fdv? fmtUsd(it.fdv) : '—'}</div></div>
    <div class="kv"><div class="k">Pair</div><div class="v">${it.pairUrl? `<a href="${it.pairUrl}" target="_blank" rel="noopener">DexScreener</a>`:'—'}</div></div>
  </div>
  ${micro}
  <div class="actions actionButtons">
    ${socialsHtml ? `<div class="actions">${socialsHtml}</div>` : ''}
    <div class="btnWrapper">
      <a class="btn swapCoin" href="${buyUrl}" target="_blank" rel="noopener">Swap</a>
      <a class="btn" href="${website}" target="_blank" rel="noopener">Website</a>
    </div>
  </div>

</article>`;
}
