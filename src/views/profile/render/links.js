import { normalizeSocial, iconFor } from "../../../data/socials.js";

export default function renderLinks(targetEl, socials) {
  if (!targetEl) return;
  let links = (Array.isArray(socials) ? socials : [])
    .map(normalizeSocial)
    .filter(Boolean)
    .reduce((acc, s) => { if(!acc.some(x=>x.href===s.href)) acc.push(s); return acc; }, [])
    .slice(0, 6);
  if (!links.length) return;

  targetEl.innerHTML = links.map(s =>
    `<a class="iconbtn" href="${s.href}" target="_blank" rel="noopener nofollow"
        aria-label="${s.platform}" data-tooltip="${s.platform}">
        ${iconFor(s.platform)}
     </a>`
  ).join('');
}
