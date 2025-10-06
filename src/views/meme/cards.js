import { sparklineSVG } from './render/sparkline.js';
import { pctChipsHTML } from './render/chips.js';
import { EXPLORER, FALLBACK_LOGO, JUP_SWAP, shortAddr } from '../../config/env.js';
import { normalizeSocial, iconFor, xSearchUrl } from '../../data/socials.js';
import { fmtUsd, normalizeWebsite } from '../../core/tools.js';
import { formatPriceParts } from '../../lib/formatPrice.js'; 

function escAttr(v) {
  const s = String(v ?? '');
  return s
    .replaceAll('&', '&amp;')
    .replaceAll('"', '&quot;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}

// Normalize to plain decimal (handles 1e-9)
function toDecimalString(v) {
  if (v == null) return "0.0";
  let s = String(v).trim();
  if (/^[+-]?\d+(\.\d+)?$/.test(s)) return s.includes(".") ? s : s + ".0";
  const n = Number(v);
  if (!Number.isFinite(n)) return "0.0";
  if (Math.abs(n) >= 1) return n.toString().includes(".") ? n.toString() : n.toString() + ".0";
  const m = n.toExponential().match(/^([+-]?\d(?:\.\d+)?)[eE]([+-]\d+)$/);
  if (!m) return "0.0";
  const coef = m[1].replace(".", "").replace(/^-/, "");
  const exp = parseInt(m[2], 10);
  if (exp >= 0) {
    const pad = exp - (m[1].split(".")[1]?.length || 0);
    return coef + (pad > 0 ? "0".repeat(pad) : "");
  } else {
    const k = -exp - 1;
    return "0." + "0".repeat(k) + coef;
  }
}

// Price HTML with tiny counter for sub-unit values
export function priceHTML(value) {
  if (value == null || !Number.isFinite(+value)) return '—';
  const dec = toDecimalString(value);
  const [rawInt = "0", rawFrac = "0"] = dec.replace(/^[+-]?/, "").split(".");
  const sign = String(value).trim().startsWith("-") ? "-" : "";
  const title = `${sign}${rawInt}.${rawFrac}`;

  // >= 1: standard formatted price with clamped fraction
  if (rawInt !== "0") {
    const p = formatPriceParts(dec, { maxFrac: 6, minFrac: 1 });
    return `
      <span class="currency">$</span>
      <span class="price" title="${escAttr(p.text)}">
        ${p.sign ? `<span class="sign">${p.sign}</span>` : ""}
        <span class="int">${p.int}</span><span class="dot">.</span><span class="frac">${p.frac}</span>
      </span>
    `;
  }

  // < 1: tiny price with leading-zero counter and significant digits
  const fracRaw = (rawFrac || "0").replace(/[^0-9]/g, "");
  const leadZeros = (fracRaw.match(/^0+/) || [""])[0].length;
  const sig = fracRaw.slice(leadZeros, leadZeros + 3) || "0"; // first few significant digits

  return `
    <span class="currency">$</span>
    <span class="priceTiny" title="${escAttr(title)}" aria-label="${escAttr(`0.0 - ${leadZeros} DECIMAL - ${sig}`)}">
      <span class="base">0.0</span>
      <span class="count">${leadZeros}</span>
      <span class="sig">${escAttr(sig)}</span>
    </span>
  `;
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
    </div>
    <div class="rec ${escAttr(it.recommendation || '')}" data-rec-text>${escAttr(it.recommendation || '')}</div>
  </div>
  <div class="addr"><a class="t-explorer" href="${escAttr(EXPLORER(it.mint))}" target="_blank" rel="noopener">Mint: ${escAttr(shortAddr(it.mint))}</a></div>

  <div class="metrics">
    <div class="kv"><div class="k">Price</div><div class="v v-price">${it.priceUsd != null ? priceHTML(+it.priceUsd) : '—'}</div></div>
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