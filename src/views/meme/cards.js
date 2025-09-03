import { sparklineSVG } from './render/sparkline.js';
import { pctChipsHTML } from './render/chips.js';
import { EXPLORER, FALLBACK_LOGO, JUP_SWAP, shortAddr } from '../../config/env.js';
import { normalizeSocial, iconFor, xSearchUrl } from '../../data/socials.js';
import { normalizeWebsite } from '../../data/normalize.js';
import { fmtUsd } from '../../utils/tools.js';

export function coinCard(it){
  const logo = it.logoURI || FALLBACK_LOGO(it.symbol);
  const website = normalizeWebsite(it.website) || EXPLORER(it.mint);
  const buyUrl = JUP_SWAP(it.mint);
  const badgeColour = () => {
    if (it.dex === 'raydium') return 'green';
    if (it.dex === 'pumpswap') return 'cyan';
    if (it.dex === 'orca') return 'blue';
    if (it.dex === 'jupiter') return 'yellow';
    if (it.dex === 'serum') return 'orange';
    return 'white';
  }
  
  let links = (Array.isArray(it.socials) ? it.socials : [])
    .map(normalizeSocial)
    .filter(Boolean)
    .reduce((acc, s) => { if(!acc.some(x=>x.href===s.href)) acc.push(s); return acc; }, [])
    .slice(0, 6);

  if (website) links.unshift({ platform: 'website', href: website });

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
      <div class="sym">${it.symbol || ''} <span class="badge" style="color:${badgeColour()}">${(it.dex||'').toUpperCase()}</span></div>
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
      <a class="btn" href="/token/${it.mint}" target="_blank" rel="noopener">More</a>
    </div>
  </div>

</article>`;
}