import { ensureTop3UI, renderTop3Dropdown, updateTop3History } from './three.js';
import { ensureEngagementUI, renderEngagementDropdown, updateEngagementHistory } from './engagement.js';


const REGISTRY = [];


export function registerAddon(addon) {
  if (!addon || !addon.id) return;
  if (REGISTRY.find(a => a.id === addon.id)) return;
  REGISTRY.push(addon);
  REGISTRY.sort((a,b)=> (a.order||0) - (b.order||0));
}

export function ensureAddonsUI() {
  for (const a of REGISTRY) {
    try { a.ensureUI?.(); } catch {}
  }
}

export function runAddonsTick({ items = [], marquee = null } = {}) {
  for (const a of REGISTRY) {
    try { a.updateHistory?.(items); } catch {}
    try { a.renderDropdown?.({ fallbackItems: items, marquee }); } catch {}
  }
}

registerAddon({
  id: 'top3',
  order: 10,
  ensureUI: () => ensureTop3UI(),
  updateHistory: (items) => updateTop3History(items),
  renderDropdown: (ctx) => renderTop3Dropdown(ctx),
});

registerAddon({
  id: 'engagement',
  order: 20,
  ensureUI: () => ensureEngagementUI(),
  updateHistory: (items) => updateEngagementHistory(items),
  renderDropdown: (ctx) => renderEngagementDropdown(ctx),
});

window.__memeAddons = REGISTRY;

