export function initPerfMode() {
  const root = document.documentElement;
  const reduceMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  const lowCPU = navigator.hardwareConcurrency && navigator.hardwareConcurrency <= 4;
  const lowMem = navigator.deviceMemory && navigator.deviceMemory <= 4;
  const smallScreen = window.innerWidth <= 640;

  if (reduceMotion) root.dataset.anim = 'off';
  if (lowCPU || lowMem || smallScreen) root.dataset.perf = 'low';
}

document.readyState === 'loading'
  ? document.addEventListener('DOMContentLoaded', initPerfMode, { once: true })
  : initPerfMode();