import { ADS_CACHE_KEY, ADS_CACHE_MS, JUP_SWAP, EXPLORER, FALLBACK_LOGO, shortAddr } from "../config/env.js";
import { getJSON, normalizeWebsite } from "../core/tools.js";
import { normalizeSocial, iconFor } from "../lib/socialBuilder.js";

export function initAdBanners(root = document){
  const cards = [...root.querySelectorAll('.adcard[data-interactive]')];
  for (const card of cards) {
    card.addEventListener('click', (e) => {
      const close = e.target.closest('[data-ad-close]');
      if (!close) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      try { card.remove(); } catch { try { card.parentNode && card.parentNode.removeChild(card); } catch {} }
    }, true);

    card.addEventListener('pointermove', (e) => {
      const r = card.getBoundingClientRect();
      const x = ((e.clientX - r.left) / Math.max(r.width, 1)) * 100;
      const y = ((e.clientY - r.top) / Math.max(r.height,1)) * 100;
      card.style.setProperty('--mx', x + '%');
      card.style.setProperty('--my', y + '%');
    });

    card.addEventListener('click', (e) => {
      const t = e.target.closest('[data-ad-toggle], .adtoggle');
      if (!t) return;
      e.preventDefault();
      card.classList.toggle('is-open');
      const tag = card.querySelector('.adtag');
      if (tag) tag.dataset.open = card.classList.contains('is-open') ? '1' : '0';
    });

    const copyEl = card.querySelector('[data-copy]');
    if (copyEl) {
      copyEl.addEventListener('click', async (e) => {
        e.preventDefault();
        const val = copyEl.getAttribute('data-copy') || copyEl.textContent.trim();
        try {
          await navigator.clipboard.writeText(val);
          copyEl.setAttribute('data-copied', '1');
          copyEl.setAttribute('aria-live', 'polite');
          copyEl.title = 'Copied';
          setTimeout(() => {
            copyEl.removeAttribute('data-copied');
            copyEl.removeAttribute('aria-live');
            copyEl.title = '';
          }, 900);
        } catch {}
      });
    }

    card.addEventListener('click', (e) => {
      const btn = e.target.closest('.adbtn');
      if (!btn) return;
      const rect = btn.getBoundingClientRect();
      const ripple = document.createElement('i');
      ripple.className = 'ripple';
      ripple.style.left = ((e.clientX - rect.left) / rect.width * 100) + '%';
      ripple.style.top  = ((e.clientY - rect.top) / rect.height* 100) + '%';
      btn.appendChild(ripple);
      ripple.addEventListener('animationend', () => ripple.remove());
    });
  }
}

function readInlineAds(){
  try{
    const el = document.getElementById('ads-data');
    if (!el) return null;
    const arr = JSON.parse(el.textContent || '[]');
    return Array.isArray(arr) ? arr : null;
  }catch{ return null; }
}

export async function loadAds(){
  const now = Date.now();
  try{
    const raw = JSON.parse(localStorage.getItem(ADS_CACHE_KEY) || 'null');
    if (raw && (now - raw.ts < ADS_CACHE_MS)) return raw.data;
  }catch{}

  let ads = null;
  try{
    ads = await getJSON('/ads.json', {timeout: 6000});
  }catch{
    ads = readInlineAds();
  }
  if (!Array.isArray(ads)) ads = [];

  try{ localStorage.setItem(ADS_CACHE_KEY, JSON.stringify({ts:now, data:ads})) }catch{}
  return ads;
}

export function pickAd(ads){
  const last = (localStorage.getItem('fdv-ads-last')||'').trim();
  const pool = ads
    .filter(a => a && a.mint)
    .map(a => ({...a, weight: Math.max(1, +a.weight || 1)}));

  if (!pool.length) return null;

  const filtered = pool.length > 1 ? pool.filter(a => a.mint !== last) : pool;
  const total = filtered.reduce((s,a)=>s+a.weight, 0);
  let r = Math.random() * total;
  for (const a of filtered){
    if ((r -= a.weight) <= 0){
      try{ localStorage.setItem('fdv-ads-last', a.mint) }catch{}
      return a;
    }
  }
  return filtered[0];
}

export function renderAdIcons(socials){
  if (!Array.isArray(socials)) return '';
  const links = socials.map(normalizeSocial).filter(Boolean);
  if (!links.length) return '';
  return `<div class="adicons">
    ${links.map(s => `
      <a class="iconbtn" href="${s.href}" target="_blank" rel="noopener nofollow"
         aria-label="${s.platform}" data-tooltip="${s.platform}">
         ${iconFor(s.platform)}
      </a>`).join('')}
  </div>`;
}

export function AD_JUP_URL(mint){ return JUP_SWAP(mint); } 

export function adCard(ad){
  const logo = ad.logo || FALLBACK_LOGO(ad.symbol);
  const title = (ad.symbol || ad.name || 'Sponsored').toString();
  const website = normalizeWebsite(ad.website) || EXPLORER(ad.mint);
  const cta = ad.cta || 'Trade';
  const icons = renderAdIcons(ad.socials || []);

  const buyUrl = AD_JUP_URL(ad.mint);
  return `
  <section class="adcard" role="complementary" aria-label="Sponsored" data-compact="1" data-interactive="1">
    <button class="adclose" type="button" aria-label="Remove ad" title="Remove" data-ad-close>&times;</button>
    <div class="adrow">
      <div class="adlogo"><img src="${logo}" alt=""></div>

      <div class="admain">
        <div class="adtitle">
          <div class="sym">${title}</div>
          <div class="mint"><a href="${EXPLORER(ad.mint)}" target="_blank" rel="noopener">Mint: ${shortAddr(ad.mint)}</a></div>
          
        </div>
        ${ad.tagline ? `<div class="adtagline">${ad.tagline}</div>` : ''}
      </div>
      <div class="adactions">
        ${icons}
        <a class="adbtn primary" href="${buyUrl}" target="_blank" rel="noopener">${cta}</a>
        <a class="adbtn" href="https://fdv.lol/token/${ad.mint}" target="_blank" rel="noopener nofollow">Profile</a>
      </div>
    </div>
  </section>`;
}