import { ts } from './src/config/env.js';
import { fetchTrending, fetchSearches } from './src/servicecs/solana.js';
import { bestPerToken, scoreAndRecommend } from './src/metrics/calculate.js';
import { renderSkeleton, render, elSort, elRefresh, elRelax, elMeta, elCards  } from './src/utils/dom.js';
import { showLoading, hideLoading, readCache, writeCache } from './src/utils/tools.js';
import { enrichMissingInfo } from './src/utils/normalize.js';
import { loadAds, pickAd } from './src/ads/load.js';

let CURRENT_AD = null;

async function pipeline({force=false}={}) {
  const relax = elRelax.checked;
  const cached = !force && readCache();
  if (cached) {
    elMeta.textContent = `Generated: ${cached.generatedAt}`;
    render(cached.items, CURRENT_AD);
    return;
  }

  showLoading();
  renderSkeleton(8);
  elMeta.textContent = `Fetching…`;

  try {
    const adsPromise = loadAds();

    const [trend, searches] = await Promise.all([
      fetchTrending(),
      fetchSearches()
    ]);

    const merged = [...trend, ...searches];
    let tokens = bestPerToken(merged, {relax});
    tokens = await enrichMissingInfo(tokens);
    const scored = scoreAndRecommend(tokens);

    try {
      const ads = await adsPromise;
      CURRENT_AD = pickAd(ads);
    } catch {
      CURRENT_AD = null;
    }

    const payload = {
      generatedAt: ts(),
      items: scored,
      _ts: Date.now()
    };
    writeCache(payload);

    elMeta.textContent = `Generated: ${payload.generatedAt}`;
    render(scored, CURRENT_AD);
  } catch (err) {
    console.error('pipeline failed', err);
    elCards.innerHTML = `<div class="small">Couldn't load data. Check your connection or try Refresh.</div>`;
    elMeta.textContent = '';
  } finally {
    hideLoading();
  }
}

elSort.addEventListener('change', ()=>render(readCache()?.items||[]));
elRefresh.addEventListener('click', ()=>pipeline({force:true}));
elRelax.addEventListener('change', ()=>pipeline({force:true}));

pipeline();