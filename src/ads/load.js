import { ADS_CACHE_KEY, ADS_CACHE_MS, JUP_SWAP, EXPLORER, FALLBACK_LOGO, shortAddr } from "../config/env.js";
import { getJSON } from "../utils/tools.js";
import { normalizeSocial, iconFor } from "../lib/socialBuilder.js";
import { normalizeWebsite } from "../utils/tools.js";

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
  <section class="adcard" role="complementary" aria-label="Sponsored" data-compact="1">
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
        <div class="adtag" title="Sponsored">SPONSORED</div>
        
        <a class="adbtn primary" href="${buyUrl}" target="_blank" rel="noopener">${cta}</a>
        <a class="adbtn" href="https://fdv.lol/token/${ad.mint}" target="_blank" rel="noopener nofollow">Learn</a>
      </div>
    </div>
  </section>`;
}