import { appPath } from '../../../config/base.js';

export function initHeader(createOpenLibraryButton, createOpenSearchButton) {
  let strip = document.getElementById('hdrTools');
  if (!strip) {
    const header =
      document.querySelector('.header .container') ||
      document.querySelector('.header') ||
      document.getElementById('header') ||
      document.querySelector('header') ||
      document.body;

    strip = document.createElement('div');
    strip.id = 'hdrTools';
    strip.className = 'hdr-tools';
    strip.innerHTML = `
      <div class="tools-row" id="hdrToolsRow" role="toolbar" aria-label="Tools"></div>
      <div class="panel-row" id="hdrToolsPanels" aria-live="polite"></div>
    `;
    header.appendChild(strip);
  }

  ensureOpenLibraryHeaderBtn(createOpenLibraryButton);
  ensureCoachingHeaderLink();
  // ensureFavboardHeaderBtn(createOpenFavboardButton);
  ensureSearchHeaderBtn(createOpenSearchButton); 
}

export function ensureOpenLibraryHeaderBtn(createOpenLibraryButton) {
  const header = document.querySelector('.header .container .superFeat');
  if (!header) return;
  let btn = document.getElementById('btnOpenLibrary');
  if (!btn) {
    const factory = typeof createOpenLibraryButton === 'function'
      ? createOpenLibraryButton
      : ({ label = 'Library', className = 'fdv-lib-btn' } = {}) => {
          const b = document.createElement('button');
          b.type = 'button';
          b.className = className;
          b.textContent = label;
          // let the library module's delegated handler (if present) catch this
          b.setAttribute('data-open-library', '');
          return b;
        };

    btn = factory({ label: 'Library', className: 'fdv-lib-btn' });
    btn.id = 'btnOpenLibrary';
    header.appendChild(btn);
  }

  btn.textContent = 'Library';
  btn.setAttribute('aria-label', 'Open library');
}

export function ensureSearchHeaderBtn(createOpenSearchButton) {
  const header = document.querySelector('.header .container .superFeat');
  if (!header) return;
  if (!document.getElementById('btnOpenSearch')) {
    const factory = typeof createOpenSearchButton === "function"
      ? createOpenSearchButton
      : ({ label = 'Search', className = 'fdv-search-btn' } = {}) => {
          const b = document.createElement("button");
          b.type = "button";
          b.className = className;
          b.id = "btnOpenSearch";
          b.textContent = label;
          b.setAttribute('data-search-open', '');
          return b;
        };

    const btn = factory({ label: 'Search', className: 'fdv-lib-btn fdv-search-btn' });
    btn.id = 'btnOpenSearch';
    btn.setAttribute('data-search-open', '');
    btn.setAttribute('aria-label', 'Open search');
    header.appendChild(btn);
  }
}

export function ensureCoachingHeaderLink() {
  const header = document.querySelector('.header .container .superFeat');
  if (!header) return;
  if (document.getElementById('btnCoaching')) return;

  const a = document.createElement('a');
  a.id = 'btnCoaching';
  a.className = 'fdv-lib-btn fdv-coaching-btn';
  a.href = appPath('onboard/');
  a.textContent = 'Coaching';
  a.setAttribute('role', 'button');
  a.setAttribute('aria-label', 'Open 1:1 coaching');
  a.setAttribute('title', '1:1 coaching');
  a.style.color = '#fff';
  a.style.textDecoration = 'none';

  const searchBtn = document.getElementById('btnOpenSearch');
  if (searchBtn?.parentElement === header) {
    header.insertBefore(a, searchBtn);
  } else {
    header.appendChild(a);
  }
}

