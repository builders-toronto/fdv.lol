import { sparklineSVG } from './render/sparkline.js';
import { pctChipsHTML } from './render/chips.js';
import { EXPLORER, FALLBACK_LOGO, JUP_SWAP, shortAddr } from '../../config/env.js';
import { normalizeSocial, iconFor, xSearchUrl } from '../../data/socials.js';
import { normalizeWebsite } from '../../data/normalize.js';
import { fmtUsd } from '../../utils/tools.js';

function escAttr(v) {
  const s = String(v ?? '');
  return s
    .replaceAll('&', '&amp;')
    .replaceAll('"', '&quot;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}

export function coinCard(it) {
  const logo = it.logoURI || FALLBACK_LOGO(it.symbol);
  const website = normalizeWebsite(it.website) || EXPLORER(it.mint);
  const buyUrl = JUP_SWAP(it.mint);

  const relay = it.relay || 'priority';             
  const priority = relay === 'priority' ? true : !!it.priority;
  const timeoutMs = Number.isFinite(it.timeoutMs) ? it.timeoutMs : 2500;

  const pairUrl = it.pairUrl || '';

  // Pre-hydration bits the modal/token-profile can grab instantly
  const tokenHydrate = {
    mint: it.mint,
    symbol: it.symbol || '',
    name: it.name || '',
    imageUrl: logo,
    headlineUrl: pairUrl || null,
    priceUsd: it.priceUsd ?? null,
    liquidityUsd: it.liquidityUsd ?? null,
    v24hTotal: it.volume?.h24 ?? null,
    fdv: it.fdv ?? null
  };

  const swapOpts = {
    relay,
    priority,
    timeoutMs,
    pairUrl,
    tokenHydrate
  };

  const badgeColour = () => {
    if (it.dex === 'raydium') return 'green';
    if (it.dex === 'pumpswap') return 'cyan';
    if (it.dex === 'orca') return 'blue';
    if (it.dex === 'jupiter') return 'yellow';
    if (it.dex === 'serum') return 'orange';
    return 'white';
  };

  const uniqPush = (arr, link) => {
    if (!link?.href) return;
    if (!arr.some(x => x.href === link.href)) arr.push(link);
  };

  const links = [];
  if (website) uniqPush(links, { platform: 'website', href: website });

  const normalizedSocials = (Array.isArray(it.socials) ? it.socials : [])
    .map(normalizeSocial)
    .filter(Boolean);

  for (const s of normalizedSocials) {
    if (links.length >= 3) break;
    uniqPush(links, s);
  }

  let socialsHtml = '';
  if (links.length) {
    socialsHtml = links.map(s =>
      `<a class="iconbtn" href="${s.href}" target="_blank" rel="noopener nofollow"
          aria-label="${s.platform}" data-tooltip="${s.platform}">
          ${iconFor(s.platform)}
       </a>`
    ).join('');
  } else {
    const xUrl = xSearchUrl(it.symbol, it.name, it.mint);
    socialsHtml =
      `<a class="iconbtn" href="${xUrl}" target="_blank" rel="noopener nofollow"
          aria-label="Search on X" data-tooltip="Search ${it.symbol ? '$'+it.symbol.toUpperCase() : 'on X'}">
          ${iconFor('x')}
       </a>`;
  }

  const micro = `
    <div class="micro" data-micro>
      ${pctChipsHTML(it._chg)}
      ${sparklineSVG(it._chg)}
    </div>`;

  // Inline Swap button to attach extra data-* without changing swapButtonHTML()
  const swapBtn = `
    <button
      type="button"
      class="btn swapCoin"
      data-swap-btn
      data-mint="${escAttr(it.mint)}"
      data-relay="${escAttr(relay)}"
      data-priority="${priority ? '1' : '0'}"
      data-timeout-ms="${escAttr(timeoutMs)}"
      data-pair-url="${escAttr(pairUrl)}"
      data-swap-opts='${escAttr(JSON.stringify(swapOpts))}'
    >Swap</button>`;

  return `
<article
  class="card"
  data-hay="${escAttr((it.symbol||'')+' '+(it.name||'')+' '+it.mint)}"
  data-mint="${escAttr(it.mint)}"
  data-relay="${escAttr(relay)}"
  data-priority="${priority ? '1' : '0'}"
  data-timeout-ms="${escAttr(timeoutMs)}"
  data-pair-url="${escAttr(pairUrl)}"
  data-token-hydrate='${escAttr(JSON.stringify(tokenHydrate))}'
  data-swap-opts='${escAttr(JSON.stringify(swapOpts))}'
>
  <div class="top">
    <div class="logo"><img data-logo src="${escAttr(logo)}" alt=""></div>
    <div style="flex:1">
      <div class="sym">
        <span class="t-symbol" data-symbol>${escAttr(it.symbol || '')}</span>
        <span class="badge" data-dex style="color:${escAttr(badgeColour())}">${escAttr((it.dex||'INIT').toUpperCase())}</span>
      </div>
      <div class="addr"><a class="t-explorer" href="${escAttr(EXPLORER(it.mint))}" target="_blank" rel="noopener">Mint: ${escAttr(shortAddr(it.mint))}</a></div>
    </div>
    <div class="rec ${escAttr(it.recommendation || '')}" data-rec-text>${escAttr(it.recommendation || '')}</div>
  </div>

  <div class="metrics">
    <div class="kv"><div class="k">Price</div><div class="v v-price">${it.priceUsd ? ('$'+Number(it.priceUsd).toLocaleString(undefined,{maximumFractionDigits:6})) : '—'}</div></div>
    <div class="kv"><div class="k">Trending Score</div><div class="v v-score">${Math.round((it.score||0)*100)} / 100</div></div>
    <div class="kv"><div class="k">24h Volume</div><div class="v v-vol24">${fmtUsd(it.volume?.h24)}</div></div>
    <div class="kv"><div class="k">Liquidity</div><div class="v v-liq">${fmtUsd(it.liquidityUsd)}</div></div>
    <div class="kv"><div class="k">FDV</div><div class="v v-fdv">${it.fdv ? fmtUsd(it.fdv) : '—'}</div></div>
    <div class="kv"><div class="k">Pair</div><div class="v v-pair">${it.pairUrl ? `<a class="t-pair" href="${escAttr(it.pairUrl)}" target="_blank" rel="noopener">DexScreener</a>` : '—'}</div></div>
  </div>

  ${micro}

  <div class="actions actionButtons">
    ${socialsHtml ? `<div class="actions" data-socials>${socialsHtml}</div>` : ''}
    <div class="btnWrapper">
      ${swapBtn}
      <a class="btn" href="/token/${escAttr(it.mint)}" target="_blank" rel="noopener">More</a>
    </div>
  </div>
</article>`;
}
