(function () {
  const CSS = `
  /* ——— Modal shell ——— */
  .legal-modal__wrap{position:fixed;inset:0;display:grid;place-items:center;pointer-events:none;z-index:1001}
  .legal-modal{z-index:1002;width:min(960px,92vw);max-height:min(86vh,760px);background:var(--card,#0b1b22);border-radius:16px;box-shadow:0 10px 40px rgba(0,0,0,.45),inset 0 0 0 1px rgba(122,222,255,.08);transform:translateY(10px) scale(.98);opacity:0;transition:transform .18s ease,opacity .18s ease;display:flex;flex-direction:column;pointer-events:none;overflow:hidden}
  .legal-modal.is-open{transform:translateY(0) scale(1);opacity:1;pointer-events:auto}
  .legal-modal__backdrop{position:fixed;inset:0;background:rgba(0,0,0,.45);opacity:0;transition:opacity .18s ease;pointer-events:none;z-index:1000}
  .legal-modal.is-open + .legal-modal__backdrop{opacity:1;pointer-events:auto}

  .legal-modal__header{display:flex;align-items:center;justify-content:space-between;padding:14px 16px;border-bottom:1px solid rgba(122,222,255,.10);background:linear-gradient(to bottom, rgba(255,255,255,.02), rgba(255,255,255,0))}
  .legal-modal__title{font-weight:600;font-size:16px}
  .legal-modal__close{appearance:none;border:0;background:transparent;color:var(--muted,#a9e7f2);padding:6px 10px;border-radius:10px;cursor:pointer}
  .legal-modal__close:hover{background:rgba(255,255,255,.06)}
  .legal-modal__tabs{display:flex;gap:6px;padding:8px 10px;border-bottom:1px solid rgba(122,222,255,.08);overflow:auto}
  .legal-tab{appearance:none;border:0;background:transparent;color:#cfe8f1;padding:10px 12px;border-radius:12px;cursor:pointer;white-space:nowrap}
  .legal-tab[aria-selected="true"]{background:rgba(122,222,255,.10);box-shadow:inset 0 0 0 1px rgba(122,222,255,.18)}
  .legal-modal__body{overflow:auto;padding:18px 20px}
  .legal-panel{display:none;animation:fadeIn .15s ease}
  .legal-panel[aria-hidden="false"]{display:block}
  .legal-panel h2{margin:0 0 10px;font-size:18px}
  .legal-panel h3{margin:16px 0 8px;font-size:15px}
  .legal-panel p,.legal-panel li{color:#cfe8f1;line-height:1.55}
  .legal-panel ul{padding-left:18px}
  @keyframes fadeIn{from{opacity:.6;transform:translateY(2px)}to{opacity:1;transform:none}}

  /* Trigger button in footer */
  .legal-trigger{margin-left:12px; margin-bottom: 20px;}
  .legal-trigger .btn{opacity:.9}
  @media (max-width: 520px){
    .legal-modal__tabs{gap:4px}
    .legal-tab{padding:8px 10px}
    .legal-panel h2{font-size:16px}
  }
  `;

  const PRIVACY_HTML = `
    <h2>Privacy Policy</h2>
    <p>We do not run servers that store your browsing data. The app fetches public on-chain/market data directly in your browser. Basic, anonymized telemetry may be measured via static hosting (e.g., GitHub Pages/CDN logs). Do not share secrets.</p>
    <h3>Data Sources</h3>
    <ul>
      <li>Public market APIs (e.g., price/liquidity/volume)</li>
      <li>Static site hosting logs (aggregate)</li>
    </ul>
    <h3>Cookies/Storage</h3>
    <p>We may use localStorage/sessionStorage for caching UI preferences and response data to improve speed.</p>
  `;

  const TOS_HTML = `
    <h2>Terms of Service</h2>
    <p>FDV.lol is an informational tool. It is <strong>not financial advice</strong>. Use at your own risk.</p>
    <h3>Use</h3>
    <ul>
      <li>No scraping/abuse of rate-limited services.</li>
      <li>No attempts to compromise the app or users.</li>
      <li>Respect third-party API terms.</li>
    </ul>
    <h3>Warranty</h3>
    <p>Provided “as is” without warranty. We do not guarantee accuracy or uptime.</p>
  `;

  const AGREEMENT_HTML = `
    <h2>Service Agreement</h2>
    <p>By using FDV.lol you agree that the service may change or discontinue at any time without notice.</p>
    <h3>Availability</h3>
    <p>Service is best-effort. Maintenance, API rate limits, or upstream outages may impact functionality.</p>
    <h3>Limitations</h3>
    <p>We are not responsible for trading outcomes, lost funds, or third-party actions.</p>
  `;

  if (!document.getElementById('legal-modal-style')) {
    const style = document.createElement('style');
    style.id = 'legal-modal-style';
    style.textContent = CSS;
    document.head.appendChild(style);
  }

  if (document.querySelector('.legal-modal__wrap')) return;

  const wrap = document.createElement('div');
  wrap.className = 'legal-modal__wrap';
  wrap.innerHTML = `
    <div class="legal-modal" role="dialog" aria-modal="true" aria-labelledby="legalTitle" aria-hidden="true">
      <div class="legal-modal__header">
        <div id="legalTitle" class="legal-modal__title">Legal</div>
        <button class="legal-modal__close" type="button" aria-label="Close">✕</button>
      </div>
      <div class="legal-modal__tabs" role="tablist" aria-label="Legal documents">
        <button class="legal-tab" role="tab" aria-selected="true"  aria-controls="legal-privacy" id="tab-privacy">Privacy</button>
        <button class="legal-tab" role="tab" aria-selected="false" aria-controls="legal-tos"     id="tab-tos">Terms</button>
        <button class="legal-tab" role="tab" aria-selected="false" aria-controls="legal-agree"   id="tab-agreement">Service Agreement</button>
      </div>
      <div class="legal-modal__body">
        <section class="legal-panel" id="legal-privacy"   role="tabpanel" aria-labelledby="tab-privacy"   aria-hidden="false">${PRIVACY_HTML}</section>
        <section class="legal-panel" id="legal-tos"       role="tabpanel" aria-labelledby="tab-tos"       aria-hidden="true">${TOS_HTML}</section>
        <section class="legal-panel" id="legal-agree"     role="tabpanel" aria-labelledby="tab-agreement" aria-hidden="true">${AGREEMENT_HTML}</section>
      </div>
    </div>
    <div class="legal-modal__backdrop"></div>
  `;
  document.body.appendChild(wrap);

  const modal    = wrap.querySelector('.legal-modal');
  const backdrop = wrap.querySelector('.legal-modal__backdrop');
  const btnClose = wrap.querySelector('.legal-modal__close');
  const tabs     = Array.from(wrap.querySelectorAll('.legal-tab'));

  const panels = {
    privacy: wrap.querySelector('#legal-privacy'),
    tos:     wrap.querySelector('#legal-tos'),
    agree:   wrap.querySelector('#legal-agree'),
  };

  let lastFocused = null;

  function selectTab(btn) {
    tabs.forEach(t => t.setAttribute('aria-selected', String(t === btn)));
    const map = {
      'tab-privacy': panels.privacy,
      'tab-tos': panels.tos,
      'tab-agreement': panels.agree
    };
    Object.values(map).forEach(p => p && p.setAttribute('aria-hidden','true'));
    const panel = map[btn.id];
    if (panel) panel.setAttribute('aria-hidden','false');
  }

  function onKey(e) {
    if (e.key === 'Escape') { e.preventDefault(); closeModal(); }
    if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
      const idx = tabs.indexOf(document.activeElement);
      if (idx >= 0) {
        e.preventDefault();
        const dir = e.key === 'ArrowRight' ? 1 : -1;
        const next = tabs[(idx + dir + tabs.length) % tabs.length];
        next.focus();
        selectTab(next);
      }
    }
  }

  function openModal(defaultTabId = 'tab-privacy') {
    lastFocused = document.activeElement;
    modal.classList.add('is-open');
    modal.setAttribute('aria-hidden', 'false');
    const btn = wrap.querySelector('#' + defaultTabId) || tabs[0];
    selectTab(btn);
    btn && btn.focus({ preventScroll: true });
    document.addEventListener('keydown', onKey);
  }

  function closeModal() {
    modal.classList.remove('is-open');
    modal.setAttribute('aria-hidden', 'true');
    document.removeEventListener('keydown', onKey);
    if (lastFocused && lastFocused.focus) lastFocused.focus();
  }

  btnClose.addEventListener('click', closeModal);
  backdrop.addEventListener('click', closeModal);

  tabs.forEach(t => {
    t.addEventListener('click', () => selectTab(t));
    t.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); selectTab(t); }
    });
  });

  function addTrigger() {
    const footer = document.querySelector('footer');
    const container = footer || document.body;
    const span = document.createElement('span');
    span.className = 'legal-trigger';
    span.innerHTML = `<button class="btn btn-ghost" type="button">Legal</button>`;
    container.appendChild(span);
    span.querySelector('button').addEventListener('click', () => openModal());
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', addTrigger);
  } else {
    addTrigger();
  }

  window.fdvlol = window.fdvlol || {};
  window.fdvlol.openLegal = (tab='privacy') => {
    const id = tab === 'tos' ? 'tab-tos' : tab === 'agreement' ? 'tab-agreement' : 'tab-privacy';
    openModal(id);
  };
})();

