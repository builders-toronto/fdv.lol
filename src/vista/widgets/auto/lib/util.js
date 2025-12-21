export function clamp(n, lo, hi) {
  const x = Number(n);
  return Number.isFinite(x) ? Math.min(hi, Math.max(lo, x)) : lo;
}

export function now() {
  return Date.now();
}

export function fmtUsd(n) {
  const x = Number(n || 0);
  if (!Number.isFinite(x)) return "$0.00";
  return "$" + x.toFixed(x >= 100 ? 0 : x >= 10 ? 2 : 3);
}

export function safeNum(v, def = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : def;
}

export function normalizePercent(v) {
  const x = Number(v);
  if (!Number.isFinite(x) || x <= 0) return 0;
  return x > 1 ? x / 100 : x;
}
