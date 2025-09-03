const nfCompact = new Intl.NumberFormat(undefined, { notation: "compact" });
const nfInt = new Intl.NumberFormat(undefined);

export const fmtMoney = (x) => (Number.isFinite(x) ? "$" + (x >= 1000 ? nfCompact.format(x) : x.toFixed(4)) : "—");
export const fmtNum   = (x) => (Number.isFinite(x) ? nfInt.format(x) : "—");
export const fmtPct   = (x) => (Number.isFinite(x) ? (x > 0 ? `+${x.toFixed(2)}%` : `${x.toFixed(2)}%`) : "—");

export const esc = (s) => String(s ?? "").replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
export const escAttr = (s) => esc(s).replace(/"/g, "&quot;");

export const relTime = (ms) => {
  if (!Number.isFinite(ms) || ms < 1000) return "—";
  const s = Math.floor(ms / 1000);
  const u = [["y",31536000],["mo",2592000],["d",86400],["h",3600],["m",60],["s",1]];
  for (const [label, div] of u) if (s >= div) return `${Math.floor(s/div)}${label}`;
  return "0s";
};
export const debounce = (fn, ms=120) => { let t; return (...a)=>{ clearTimeout(t); t=setTimeout(()=>fn(...a), ms); }; };

export const pill = (x) => {
  if (!Number.isFinite(x)) return `<span class="pill neutral">—</span>`;
  const cls = x > 0 ? "up" : x < 0 ? "down" : "neutral";
  return `<span class="pill ${cls}">${fmtPct(x)}</span>`;
};

export const cssReco = (reco="watch") => {
  const r = String(reco).toLowerCase();
  return r === "good" ? "good" : r === "avoid" ? "avoid" : "watch";
};
