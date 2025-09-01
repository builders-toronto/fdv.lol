import { ts } from '../config/env.js';
import { fetchDexscreener } from '../data/dexscreener.js'; 
import { fetchTrending } from '../data/solana.js';
import { bestPerToken, scoreAndRecommend } from '../core/calculate.js';
import { renderSkeleton, elRelax, elMeta, elCards  } from '../ui/render.js';
import { showLoading, hideLoading, readCache, writeCache } from '../utils/tools.js';
import { enrichMissingInfo } from '../utils/normalize.js';
import { loadAds, pickAd } from '../ads/load.js';

let CURRENT_AD = null;

export async function pipeline({force=false}={}) {
  const relax = elRelax.checked;
  const cached = !force && readCache();
  if (cached) {
    elMeta.textContent = `Generated: ${cached.generatedAt}`;
    return cached.items;
  }

  showLoading();
  renderSkeleton(8);
  elMeta.textContent = `Fetching…`;

  try {
    const adsPromise = loadAds();

    const [trend, searches] = await Promise.all([
      fetchDexscreener(),
      fetchTrending()
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
    return {items: scored, ad: CURRENT_AD};
  } catch (err) {
    console.error('pipeline failed', err);
    elCards.innerHTML = `<div class="small">Couldn't load data. Check your connection or try Refresh.</div>`;
    elMeta.textContent = '';
    throw err;
  } finally {
    hideLoading();
  }
}

