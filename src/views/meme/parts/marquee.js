function mqItemHTML(t, tokenHref) {
  const mint = t.mint || '';
  const sym  = t.symbol || '';
  const name = t.name || '';
  const logo = t.imageUrl || t.logoURI || '';
  const p    = t.priceUsd;
  const priceTxt = (p == null) ? '' :
    (p >= 1 ? `$${p.toLocaleString(undefined, { maximumFractionDigits: 2 })}`
            : `$${p.toFixed(6)}`);
  return `
    <a class="mq-item" href="${tokenHref(mint)}" title="${name}">
      <img class="mq-logo" src="${logo}" alt="" />
      <span class="mq-sym">${sym || '—'}</span>
      <span class="mq-name">${name || ''}</span>
      ${priceTxt ? `<span class="mq-price">${priceTxt}</span>` : ''}
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
    return;
  }
  const key = JSON.stringify({
    t: (marquee.trending || []).map(x => x.mint).slice(0, 40),
    n: (marquee.new || []).map(x => x.mint).slice(0, 40),
  });
  if (_marqueeRenderedKey === key) return;

  const tokenHref = mint => `/token/${encodeURIComponent(mint)}`;
  const tRow = marqueeRowHTML(marquee.trending || [], 'Trending', tokenHref);
  const nRow = marqueeRowHTML(marquee.new || [], 'New', tokenHref);
  elMarqueeWrap.innerHTML = `${tRow}${nRow}`;

  startAutoScroll(elMarqueeWrap);
  _marqueeRenderedKey = key;
}