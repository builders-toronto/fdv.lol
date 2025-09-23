export function formatPriceParts(input, { maxFrac = 6, minFrac = 1 } = {}) {
  if (input == null) return { sign: "", int: "0", frac: "0", text: "0.0" };

  let s = String(input).trim();
  if (!/^\-?\d*\.?\d*$/.test(s)) {
    const n = Number(input);
    if (!Number.isFinite(n)) return { sign: "", int: "0", frac: "0", text: "0.0" };
    s = String(n);
  }

  let sign = "";
  if (s[0] === "-") { sign = "-"; s = s.slice(1); }
  let [int = "", frac = ""] = s.split(".");
  int = int.replace(/^0+(?=\d)/, "");
  frac = (frac || "").replace(/[^0-9]/g, "");
  if (!int) int = "0";

  if (frac.length > maxFrac) {
    const cut = frac.slice(0, maxFrac);
    const next = frac.charCodeAt(maxFrac) - 48;
    if (next >= 5) {
      let carry = 1;
      let out = cut.split("").map(c => c.charCodeAt(0) - 48);
      for (let i = out.length - 1; i >= 0; i--) {
        const v = out[i] + carry;
        if (v >= 10) { out[i] = 0; carry = 1; }
        else { out[i] = v; carry = 0; break; }
      }
      if (carry) {
        frac = out.map(n => String.fromCharCode(48 + n)).join("");
        let ci = int.split("").map(c => c.charCodeAt(0) - 48);
        carry = 1;
        for (let i = ci.length - 1; i >= 0; i--) {
          const v = ci[i] + carry;
          if (v >= 10) { ci[i] = 0; carry = 1; }
          else { ci[i] = v; carry = 0; break; }
        }
        if (carry) ci.unshift(1);
        int = ci.map(n => String.fromCharCode(48 + n)).join("");
      } else {
        frac = out.map(n => String.fromCharCode(48 + n)).join("");
      }
    } else {
      frac = cut;
    }
  }

  frac = frac.replace(/0+$/, "");
  if (frac.length < minFrac) frac = frac.padEnd(minFrac, "0");

  const text = `${sign}${int}.${frac}`;
  return { sign, int, frac, text };
}