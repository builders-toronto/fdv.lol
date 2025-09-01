export function xSearchUrl(symbol, name, mint){
  const sym = (symbol || '').toUpperCase().replace(/[^A-Z0-9]/g,'');
  const parts = [];

  if (sym) {
    parts.push(`$${sym}`, `#${sym}`, `${sym} solana`);
  }
  if (name && name.toLowerCase() !== sym.toLowerCase()) {
    parts.push(`"${name}" solana`);
  }

  if (mint) parts.push(`"${mint}"`);

  const q = parts.join(' OR ');
  return `https://x.com/search?q=${encodeURIComponent(q)}&f=live&src=typed_query`;
}

function platformFromUrl(u){
  try{
    const h = new URL(u).hostname.replace(/^www\./,'').toLowerCase();
    if (/(^|\.)(x\.com|twitter\.com)$/.test(h)) return 'x';
    if (/(^|\.)t\.me$/.test(h)) return 'telegram';
    if (/(^|\.)(discord\.gg|discord\.com)$/.test(h)) return 'discord';
    if (/(^|\.)(github\.com)$/.test(h)) return 'github';
    if (/(^|\.)(medium\.com)$/.test(h)) return 'medium';
    if (/(^|\.)(youtube\.com|youtu\.be)$/.test(h)) return 'youtube';
    if (/(^|\.)(instagram\.com)$/.test(h)) return 'instagram';
    if (/(^|\.)(reddit\.com)$/.test(h)) return 'reddit';
    if (/(^|\.)(coingecko\.com)$/.test(h)) return 'coingecko';
    if (/(^|\.)(linktr\.ee)$/.test(h)) return 'linktree';
    if (/(^|\.)(docs\.|gitbook\.io)$/.test(h)) return 'docs';
    return 'website';
  }catch{return 'website'}
}

export function normalizeSocial(s){
  const p = (s.platform || s.type || '').toLowerCase().trim();
  const url = (s.url || '').trim();
  const handle = (s.handle || s.username || '').replace(/^@/,'').trim();

  let platform = p;
  let href = url || null;

  if (!href && handle){
    switch(p){
      case 'twitter': case 'x': href = `https://twitter.com/${handle}`; platform='x'; break;
      case 'telegram': href = `https://t.me/${handle}`; break;
      case 'discord':  href = `https://discord.gg/${handle}`; break;
      case 'github':   href = `https://github.com/${handle}`; break;
      default: href = /^https?:\/\//i.test(handle) ? handle : `https://${handle}`;
    }
  }

  if (!platform && href) platform = platformFromUrl(href);
  if (!href) return null;
  return { platform, href };
}

export function iconFor(platform){
  const svg = (d)=>`<svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true">${d}</svg>`;
  const stroke = `stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"`;

  switch((platform||'').toLowerCase()){
    case 'x': case 'twitter':
      return svg(`<path fill="currentColor" d="M18.146 2H21L13.5 10.33 22 22h-6.146l-5.218-6.86L4.6 22H2l8.053-9.443L2 2h6.3l4.728 6.203L18.146 2Zm-2.154 18h1.658L7.983 4H6.249l9.743 16Z"/>`);
    case 'telegram':
      return svg(`<path ${stroke} d="M21 3 3 11l6 2 9-7-7 9-2 6 3-4 4 3L21 3z"/>`);
    case 'discord':
      return svg(`<path fill="currentColor" d="M20 5.6a16 16 0 0 0-4-1.4l-.3.7a12.5 12.5 0 0 0-7.4 0l-.3-.7A16 16 0 0 0 4 5.6C2.6 9 2.4 12.4 2.7 16a16 16 0 0 0 5 2.6l.7-1.1a10.7 10.7 0 0 1-1.7-.8l.4-.3c3.3 1.6 6.8 1.6 10 0l.5.3-1.7.8.7 1.1A16 16 0 0 0 21.3 16c.3-3.6.1-7-1.3-10.4ZM9.7 13.6c-.8 0-1.5-.8-1.5-1.7s.7-1.7 1.5-1.7c.9 0 1.5.8 1.5 1.7s-.6 1.7-1.5 1.7Zm4.6 0c-.9 0-1.5-.8-1.5-1.7s.6-1.7 1.5-1.7 1.5.8 1.5 1.7-.7 1.7-1.5 1.7Z"/>`);
    case 'github':
      return svg(`<path ${stroke} d="M9 19c-5 1.5-5-2.5-7-3m14 6v-4a4 4 0 0 0-1-2.6c3 0 6-1.5 6-6a4.7 4.7 0 0 0-1.3-3.3 5 5 0 0 0-.1-3.1S17.4.9 14.9 2.7a12 12 0 0 0-6 0C6.4.9 5.3 1.3 5.3 1.3a5 5 0 0 0-.1 3.1A4.7 4.7 0 0 0 3.9 7c0 4.5 3 6 6 6-.5.5-.8 1.3-.8 2.4V22"/>`);
    case 'medium':
      return svg(`<path fill="currentColor" d="M2 7l4 1 5 9 5-9 4-1-4 2v7l4 2H3l4-2V9L2 7z"/>`);
    case 'youtube':
      return svg(`<path fill="currentColor" d="M23 12s0-4-1-5c-1-2-3-2-7-2H9C5 5 3 5 2 7c-1 1-1 5-1 5s0 4 1 5c1 2 3 2 7 2h6c4 0 6 0 7-2 1-1 1-5 1-5Zm-13 4V8l6 4-6 4Z"/>`);
    case 'instagram':
      return svg(`<rect ${stroke} x="3" y="3" width="18" height="18" rx="5"/><path ${stroke} d="M16 11.37A4 4 0 1 1 12.63 8 4 4 0 0 1 16 11.37Z"/><path fill="currentColor" d="M17.5 6.5a1 1 0 1 0 0 2 1 1 0 0 0 0-2Z"/>`);
    case 'reddit':
      return svg(`<path ${stroke} d="M22 12a10 10 0 1 1-9.4-10M14 2l2 4M8.5 13.5h.01M15.5 13.5h.01M8 16c1.5 1 6.5 1 8 0"/>`);
    case 'coingecko':
      return svg(`<path ${stroke} d="M21 12a9 9 0 1 1-9-9"/><circle cx="15" cy="9" r="1.5" fill="currentColor"/>`);
    case 'linktree':
      return svg(`<path ${stroke} d="M12 2v20M7 7l5 4 5-4M7 12h10M8 17h8"/>`);
    case 'docs':
      return svg(`<path ${stroke} d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12V8l-4-6z"/><path ${stroke} d="M14 2v6h6"/>`);
    case 'website':
      return svg(`<circle ${stroke} cx="12" cy="12" r="10"/><path ${stroke} d="M2 12h20M12 2a15 15 0 0 1 0 20M12 2a15 15 0 0 0 0 20"/>`);
    default:
      return svg(`<path ${stroke} d="M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z"/><path ${stroke} d="M3.6 9h16.8M3.6 15h16.8M12 3a15 15 0 0 1 0 18M12 3a15 15 0 0 0 0 18"/>`);
  }
}