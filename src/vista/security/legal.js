import { PRIVACY, TOS, AGREEMENT } from "../../config/env.js";

(function () {
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
        <section class="legal-panel" id="legal-privacy"   role="tabpanel" aria-labelledby="tab-privacy"   aria-hidden="false">${PRIVACY}</section>
        <section class="legal-panel" id="legal-tos"       role="tabpanel" aria-labelledby="tab-tos"       aria-hidden="true">${TOS}</section>
        <section class="legal-panel" id="legal-agree"     role="tabpanel" aria-labelledby="tab-agreement" aria-hidden="true">${AGREEMENT}</section>
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
    const important = document.querySelector('.important');
    const span = document.createElement('span');
    span.className = 'legal-trigger';
    span.innerHTML = `<a class="legalBtn">Legal</a>`;
    important.appendChild(span);
    span.querySelector('a').addEventListener('click', () => openModal());
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

