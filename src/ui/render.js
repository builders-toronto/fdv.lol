import { MAX_CARDS } from '../config/env.js';
import { coinCard } from './cards.js';
import { adCard } from '../ads/load.js';

export const elCards = document.getElementById('cards');
export const elMeta  = document.getElementById('meta');
export const elMetaBase = document.getElementById('metaBase');
export const elQ     = document.getElementById('q');
export const elSort  = document.getElementById('sort');
export const elRefresh = document.getElementById('refresh');
export const elRelax = document.getElementById('relax');

let _latestItems = [];
let _latestAd = null;

function sortItems(items, sortKey) {
  const arr = [...items];
  arr.sort((a, b) => {
    if (sortKey === 'volume')    return (b.volume?.h24 || 0)     - (a.volume?.h24 || 0);
    if (sortKey === 'liquidity') return (b.liquidityUsd || 0)    - (a.liquidityUsd || 0);
    if (sortKey === 'change24')  return (b.change?.h24 || 0)     - (a.change?.h24 || 0);
    return (b.score || 0)        - (a.score || 0); 
  });
  return arr;
}

function doRender() {
  const sort = elSort?.value || 'score';
  let items = sortItems(_latestItems, sort).slice(0, MAX_CARDS);

  if (!items.length) {
    elCards.innerHTML = `<div class="small">No matches. Try “relax filter”, different sort, or refresh.</div>`;
    return;
  }

  const adHtml = _latestAd ? adCard(_latestAd) : '';
  const cardsHtml = items.map(coinCard).join('');
  elCards.innerHTML = adHtml + cardsHtml;
}

export function render(items, adPick) {
  _latestItems = Array.isArray(items) ? items : [];
  _latestAd = adPick || null;
  doRender();
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

elSort?.addEventListener('change', doRender);