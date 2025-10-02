import { createSendFavoriteButton } from '../../widgets/library.js';
import { sparklineSVG } from '../render/sparkline.js';
import { pctChipsHTML } from '../render/chips.js';
import { EXPLORER, FALLBACK_LOGO, JUP_SWAP, shortAddr } from '../../../config/env.js';
import { normalizeSocial, iconFor, xSearchUrl } from '../../../data/socials.js';
import { normalizeWebsite } from '../../../data/normalize.js';
import { fmtUsd } from '../../../utils/tools.js';
import { formatPriceParts } from '../../../lib/formatPrice.js'; 

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

// ---- Filters / Helpers ----
export function isDisplayReady(t) {
  return t &&
    Number.isFinite(Number(t.priceUsd)) &&
    Number.isFinite(Number(t.liquidityUsd)) &&
    Number.isFinite(Number(t.volume?.h24)) &&
    Number.isFinite(Number(t.txns?.h24)) &&
    Number.isFinite(t.score) &&
    t.recommendation && t.recommendation !== 'MEASURING';
}

export function sortItems(items, sortKey) {
  const arr = [...items];
  arr.sort((a, b) => {
    if (sortKey === 'volume')    return (b.volume?.h24 || 0)  - (a.volume?.h24 || 0);
    if (sortKey === 'liquidity') return (b.liquidityUsd || 0) - (a.liquidityUsd || 0);
    if (sortKey === 'change24')  return (b.change?.h24 || 0)  - (a.change?.h24 || 0);
    return (b.score || 0)        - (a.score || 0);
  });
  return arr;
}

export function filterByQuery(items, q) {
  const s = (q || '').trim().toLowerCase();
  if (!s) return items;
  return items.filter(it =>
    (it.symbol || '').toLowerCase().includes(s) ||
    (it.name   || '').toLowerCase().includes(s) ||
    (it.mint   || '').toLowerCase().includes(s)
  );
}

// ---- Leader Hysteresis ----
const HYSTERESIS_MS = 2000;
let currentLeaderId = null;
let challengerId = null;
let challengerSince = 0;

export function applyLeaderHysteresis(ranked) {
  if (!ranked.length) return ranked;
  const top = ranked[0];
  const now = Date.now();

  if (!currentLeaderId) {
    currentLeaderId = top.mint || top.id;
    return ranked;
  }
  const leaderIdx = ranked.findIndex(x => (x.mint || x.id) === currentLeaderId);
  if (leaderIdx === -1) {
    currentLeaderId = ranked[0].mint || ranked[0].id;
    challengerId = null;
    challengerSince = 0;
    return ranked;
  }
  if ((top.mint || top.id) === currentLeaderId) {
    challengerId = null;
    challengerSince = 0;
    return ranked;
  }
  const newTopId = top.mint || top.id;
  if (challengerId !== newTopId) {
    challengerId = newTopId;
    challengerSince = now;
  }
  const held = now - challengerSince;
  if (held >= HYSTERESIS_MS) {
    currentLeaderId = newTopId;
    challengerId = null;
    challengerSince = 0;
    return ranked;
  }
  const forced = ranked.slice();
  const [leader] = forced.splice(leaderIdx, 1);
  forced.unshift(leader);
  return forced;
}

// ---- Card DOM Update ----
export function updateCardDOM(el, it) {
  const symEl = el.querySelector('.t-symbol');
  if (symEl && symEl.textContent !== (it.symbol || '')) symEl.textContent = it.symbol || '';

  const dexEl = el.querySelector('[data-dex]');
  if (dexEl) {
    const text = (it.dex || '').toUpperCase();
    if (dexEl.textContent !== text) dexEl.textContent = text;
    const colorMap = { raydium:'green', pumpswap:'cyan', orca:'blue', jupiter:'yellow', serum:'orange' };
    const col = colorMap[(it.dex||'').toLowerCase()] || 'white';
    if (dexEl.style.color !== col) dexEl.style.color = col;
  }

  const logo = el.querySelector('[data-logo]');
  if (logo) {
    const nextSrc = it.logoURI;
    if (nextSrc && logo.getAttribute('src') !== nextSrc) logo.setAttribute('src', nextSrc);
  }

  const recEl = el.querySelector('[data-rec-text]');
  if (recEl) {
    const next = it.recommendation || '';
    if (recEl.textContent !== next) recEl.textContent = next;
    recEl.classList.remove('GOOD','WATCH','AVOID','NEUTRAL','CONSIDER');
    if (next) recEl.classList.add(next);
  }

  const priceEl = el.querySelector('.v-price');
  if (priceEl) {
    const nextHtml = (it.priceUsd != null && Number.isFinite(+it.priceUsd))
      ? priceHTML(+it.priceUsd)
      : '—';
    if (priceEl.innerHTML !== nextHtml) priceEl.innerHTML = nextHtml;
  }

  const scoreEl = el.querySelector('.v-score');
  if (scoreEl) {
    const txt = `${Math.round((it.score || 0) * 100)} / 100`;
    if (scoreEl.textContent !== txt) scoreEl.textContent = txt;
  }

  const volEl = el.querySelector('.v-vol24');
  if (volEl) {
    const n = Number(it.volume?.h24 ?? 0);
    const txt = n >= 1000 ? '$' + Intl.NumberFormat(undefined,{notation:'compact'}).format(n) : (n>0? ('$'+n.toFixed(2)):'$0');
    if (volEl.textContent !== txt) volEl.textContent = txt;
  }

  const liqEl = el.querySelector('.v-liq');
  if (liqEl) {
    const n = Number(it.liquidityUsd ?? 0);
    const txt = n >= 1000 ? '$' + Intl.NumberFormat(undefined,{notation:'compact'}).format(n) : (n>0? ('$'+n.toFixed(2)):'$0');
    if (liqEl.textContent !== txt) liqEl.textContent = txt;
  }

  const fdvEl = el.querySelector('.v-fdv');
  if (fdvEl) {
    const n = Number(it.fdv);
    const txt = Number.isFinite(n) ? (n >= 1000 ? '$' + Intl.NumberFormat(undefined,{notation:'compact'}).format(n) : '$'+n.toFixed(2)) : '—';
    if (fdvEl.textContent !== txt) fdvEl.textContent = txt;
  }

  const pairWrap = el.querySelector('.v-pair');
  if (pairWrap) {
    const link = pairWrap.querySelector('.t-pair');
    if (it.pairUrl) {
      if (!link) {
        pairWrap.innerHTML = `<a class="t-pair" href="${it.pairUrl}" target="_blank" rel="noopener">DexScreener</a>`;
      } else if (link.getAttribute('href') !== it.pairUrl) {
        link.setAttribute('href', it.pairUrl);
      }
    } else if (link) {
      pairWrap.textContent = '—';
    }
  }

  const micro = el.querySelector('[data-micro]');
  if (micro) {
    const chg = Array.isArray(it._chg) ? it._chg : [];
    const chips = typeof pctChipsHTML === 'function' ? pctChipsHTML(chg) : '';
    const spark = typeof sparklineSVG === 'function' ? sparklineSVG(chg) : '';
    const html = `${chips}${spark}`;
    if (micro.innerHTML !== html) micro.innerHTML = html;
  }
}

// ---- Card Creation / Integration ----
export function buildOrUpdateCard(existing, token) {
  if (!existing) {
    const el = document.createElement('div');
    el.className = 'card';
    el.dataset.key = token.mint || token.id;
    el.innerHTML = coinCard(token);
    attachFavorite(el, token);
    el.classList.add('is-entering');
    el.style.opacity = '0';
    el.style.transform = 'translateY(10px) scale(.98)';
    el.style.willChange = 'transform,opacity';
    return el;
  }
  updateCardDOM(existing, token);
  attachFavorite(existing, token);
  existing.style.willChange = 'transform,opacity';
  existing.classList.remove('is-exiting');
  return existing;
}

function attachFavorite(root, token) {
  try {
    const top = root.querySelector('.top') || root;
    if (!top.querySelector(`[data-fav-send][data-mint="${token.mint}"]`)) {
      const favBtn = createSendFavoriteButton({
        mint: token.mint,
        symbol: token.symbol || '',
        name: token.name || '',
        imageUrl: token.logoURI || token.imageUrl || ''
      });
      favBtn.style.marginLeft = 'auto';
      top.appendChild(favBtn);
    }
  } catch {}
}

// ---- Animated Grid Patch ----
export function patchKeyedGridAnimated(container, nextItems, keyFn, buildFn) {
  if (!container) return;
  const prevY = window.scrollY;

  const oldNodes = Array.from(container.children);
  const firstRects = new Map(oldNodes.map(el => [el.dataset.key, el.getBoundingClientRect()]));
  const oldByKey = new Map(oldNodes.map(el => [el.dataset.key, el]));

  const frag = document.createDocumentFragment();
  const alive = new Set();

  for (let i = 0; i < nextItems.length; i++) {
    const it = nextItems[i];
    const k = keyFn(it);
    alive.add(k);

    let el = oldByKey.get(k);
    el = buildFn(el, it);

    if (i === 0) el.classList.add('is-leader'); else el.classList.remove('is-leader');
    el.style.setProperty('--rank', i);

    frag.appendChild(el);
  }

  for (const [k, el] of oldByKey) {
    if (!alive.has(k)) {
      el.classList.add('is-exiting');
      el.style.transition = 'opacity 260ms ease-out, transform 200ms ease-out';
      el.style.opacity = '0';
      el.style.transform = 'translateY(8px)';
      el.addEventListener('transitionend', () => el.remove(), { once: true });
    }
  }

  container.appendChild(frag);

  const newNodes = Array.from(container.children);
  requestAnimationFrame(() => {
    for (const el of newNodes) {
      const k = el.dataset.key;
      const last = el.getBoundingClientRect();
      const first = firstRects.get(k);

      if (!first) {
        el.style.transition = 'transform 480ms cubic-bezier(.22,1,.36,1), opacity 320ms ease-out';
        el.style.opacity = '1';
        el.style.transform = 'translateY(0) scale(1)';
        el.addEventListener('transitionend', () => {
          el.classList.remove('is-entering');
          el.style.willChange = '';
        }, { once: true });
        continue;
      }

      const dx = first.left - last.left;
      const dy = first.top - last.top;
      if (dx || dy) {
        el.classList.add('is-moving');
        el.style.transform = `translate(${dx}px, ${dy}px)`;
        el.style.transition = 'transform 0s';
        requestAnimationFrame(() => {
          el.style.transition = 'transform 580ms cubic-bezier(.22,1,.36,1)';
          el.style.transform = 'translate(0,0)';
        });
        el.addEventListener('transitionend', () => {
          el.classList.remove('is-moving');
          el.style.willChange = '';
        }, { once: true });
      }
    }
    if (Math.abs(window.scrollY - prevY) > 2) window.scrollTo({ top: prevY });
  });
}