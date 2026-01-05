import { scoreAndRecommend } from '../core/calculate.js';

self.onmessage = (evt) => {
  const msg = evt?.data;
  const id = msg?.id;
  const rows = msg?.rows;

  if (!Number.isFinite(id) || !Array.isArray(rows)) {
    try { self.postMessage({ id, scored: [], error: 'bad-request' }); } catch {}
    return;
  }

  try {
    const scored = scoreAndRecommend(rows);
    self.postMessage({ id, scored });
  } catch (e) {
    self.postMessage({ id, scored: [], error: String(e?.message || e || 'error') });
  }
};
