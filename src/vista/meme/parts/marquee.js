import { formatPriceParts, toDecimalString } from "../../../lib/formatPrice.js";

function mqItemHTML(t, tokenHref) {
  const mint = t.mint || '';
  const sym  = t.symbol || '';
  const name = t.name || '';
  const logo = t.imageUrl || t.logoURI || '';
  const p    = t.priceUsd;
  const priceTxt = (p == null) ? '' :
    (p >= 1 ? `$${p.toLocaleString(undefined, { maximumFractionDigits: 2 })}`
            : `$${p.toFixed(6)}`);
  const dec = toDecimalString(p);
  const price = formatPriceParts(dec, { maxFrac: 6, minFrac: 2 }).text;
  return `
    <a class="mq-item" href="${tokenHref(mint)}" title="${name}">
      <img class="mq-logo" src="${logo}" alt="" />
      <span class="mq-sym">${sym || '—'}</span>
      <span class="mq-name">${name || ''}</span>
      ${priceTxt ? `<span class="mq-price">${price}</span>` : ''}
    </a>
  `;
}

function marqueeRowHTML(list, label, tokenHref) {
  if (!Array.isArray(list) || list.length === 0) return '';
  const inner = list.map(x => mqItemHTML(x, tokenHref)).join('<span class="mq-gap"></span>');
  return `
    <div class="mq-row" data-label="${label}">
      <div class="mq-label">${label}</div>
      <div class="mq-strip">
        <div class="mq-strip-inner">${inner}</div>
        <div class="mq-strip-inner">${inner}</div>
      </div>
    </div>
  `;
}

function startAutoScroll(container) {
  const strips = Array.from(container.querySelectorAll('.mq-strip'));
  for (const strip of strips) {
    if (strip._af) continue;
    let paused = false;
    const speed = 0.4;
    const step = () => {
      if (!paused) {
        strip.scrollLeft += speed;
        if (strip.scrollLeft >= strip.scrollWidth / 2) strip.scrollLeft = 0;
      }
      strip._af = requestAnimationFrame(step);
    };
    strip.addEventListener('mouseenter', () => { paused = true; });
    strip.addEventListener('mouseleave', () => { paused = false; });
    strip._af = requestAnimationFrame(step);
  }
}

let elMarqueeWrap = null;
let _marqueeRenderedKey = null;

const MQ_MIN_UPDATE_MS = 8000;
let _marqueeLastUpdate = 0;
let _mqUpdateTimer = 0;
let _mqPending = null;

function buildInner(list, tokenHref) {
  if (!Array.isArray(list) || list.length === 0) return '';
  return list.map(x => mqItemHTML(x, tokenHref)).join('<span class="mq-gap"></span>');
}

function setStripContentPreserveScroll(rowEl, innerHTML) {
  if (!rowEl) return;
  let strip = rowEl.querySelector('.mq-strip');
  if (!strip) {
    rowEl.innerHTML = `
      <div class="mq-label">${rowEl.dataset.label || ''}</div>
      <div class="mq-strip">
        <div class="mq-strip-inner">${innerHTML}</div>
        <div class="mq-strip-inner">${innerHTML}</div>
      </div>
    `;
    return;
  }
  const prevHalf = Math.max(1, strip.scrollWidth / 2);
  const ratio = strip.scrollLeft / prevHalf;

  strip.innerHTML = `
    <div class="mq-strip-inner">${innerHTML}</div>
    <div class="mq-strip-inner">${innerHTML}</div>
  `;

  const newHalf = Math.max(1, strip.scrollWidth / 2);
  strip.scrollLeft = Math.floor(ratio * newHalf);
}

export function ensureMarqueeSlot(cardsEl) {
  if (elMarqueeWrap) return elMarqueeWrap;
  const parent = cardsEl?.parentElement;
  if (!parent) return null;
  elMarqueeWrap = document.getElementById('marqueeWrap') || document.createElement('div');
  elMarqueeWrap.id = 'marqueeWrap';
  elMarqueeWrap.className = 'marquee-wrap';
  elMarqueeWrap.style.margin = '8px 0 16px 0';
  if (!elMarqueeWrap.parentElement) parent.insertBefore(elMarqueeWrap, cardsEl);
  return elMarqueeWrap;
}

export function renderMarquee(marquee) {
  if (!elMarqueeWrap) return;
  if (!marquee) {
    elMarqueeWrap.innerHTML = '';
    _marqueeRenderedKey = null;
    _marqueeLastUpdate = 0;
    clearTimeout(_mqUpdateTimer); _mqUpdateTimer = 0; _mqPending = null;
    return;
  }

  const key = JSON.stringify({
    t: (marquee.trending || []).map(x => x.mint).slice(0, 40),
    n: (marquee.new || []).map(x => x.mint).slice(0, 40),
  });

  if (_marqueeRenderedKey == null) {
    const tokenHref = mint => `/token/${encodeURIComponent(mint)}`;
    const tRow = marqueeRowHTML(marquee.trending || [], 'Trending', tokenHref);
    const nRow = marqueeRowHTML(marquee.new || [], 'New', tokenHref);
    elMarqueeWrap.innerHTML = `${tRow}${nRow}`;
    startAutoScroll(elMarqueeWrap);
    _marqueeRenderedKey = key;
    _marqueeLastUpdate = Date.now();
    return;
  }

  if (_marqueeRenderedKey === key) return;

  const now = Date.now();
  const remain = _marqueeLastUpdate + MQ_MIN_UPDATE_MS - now;
  if (remain > 0) {
    _mqPending = marquee;
    clearTimeout(_mqUpdateTimer);
    _mqUpdateTimer = setTimeout(() => {
      const m = _mqPending;
      _mqPending = null;
      renderMarquee(m);
    }, remain);
    return;
  }

  const tokenHref = mint => `/token/${encodeURIComponent(mint)}`;
  const tRowEl = elMarqueeWrap.querySelector('.mq-row[data-label="Trending"]');
  const nRowEl = elMarqueeWrap.querySelector('.mq-row[data-label="New"]');

  if (!tRowEl || !nRowEl) {
    const tRow = marqueeRowHTML(marquee.trending || [], 'Trending', tokenHref);
    const nRow = marqueeRowHTML(marquee.new || [], 'New', tokenHref);
    elMarqueeWrap.innerHTML = `${tRow}${nRow}`;
    startAutoScroll(elMarqueeWrap);
  } else {
    const tInner = buildInner(marquee.trending || [], tokenHref);
    const nInner = buildInner(marquee.new || [], tokenHref);

    if (!tInner) tRowEl.style.display = 'none';
    else {
      tRowEl.style.display = '';
      setStripContentPreserveScroll(tRowEl, tInner);
    }
    if (!nInner) nRowEl.style.display = 'none';
    else {
      nRowEl.style.display = '';
      setStripContentPreserveScroll(nRowEl, nInner);
    }
  }

  _marqueeRenderedKey = key;
  _marqueeLastUpdate = now;
}