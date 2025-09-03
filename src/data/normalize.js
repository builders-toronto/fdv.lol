import { getJSON } from '../utils/tools.js';

export function normalizeWebsite(u){
  if(!u) return null;
  u = String(u).trim();
  if(!/^https?:\/\//i.test(u)) u = 'https://' + u; 
  try { return new URL(u).href; } catch { return null; }
}

export async function enrichMissingInfo(items) {
  const lacking = items.filter(it => !it.logoURI && !it.website).map(it => it.mint);
  if (!lacking.length) return items;

  const batch = lacking.slice(0, 30).join(',');
  try {
    const url = `https://api.dexscreener.com/tokens/v1/solana/${batch}`;
    const resp = await getJSON(url, {timeout: 10000});
    const arr = Array.isArray(resp) ? resp : (Array.isArray(resp?.pairs) ? resp.pairs : []);

    const byMint = new Map();
    for (const entry of arr) {
      const base = entry.baseToken || {};
      const info = entry.info || {};
      if (!base.address) continue;
      const website = Array.isArray(info.websites) && info.websites.length ? info.websites[0].url : null;
      const socials = Array.isArray(info.socials) ? info.socials : [];
      const logoURI = info.imageUrl || null;
      if (logoURI || website || socials.length) {
        byMint.set(base.address, {logoURI, website, socials});
      }
    }

    for (const it of items) {
      const add = byMint.get(it.mint);
      if (add) {
        it.logoURI ||= add.logoURI;
        it.website ||= add.website;
        if ((!it.socials || !it.socials.length) && add.socials?.length) it.socials = add.socials;
      }
    }
  } catch {}
  return items;
}
