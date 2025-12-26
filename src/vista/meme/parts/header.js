export function initHeader(createOpenLibraryButton, createOpenSearchButton, createOpenFavboardButton) {
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
  // ensureFavboardHeaderBtn(createOpenFavboardButton);
  ensureSearchHeaderBtn(createOpenSearchButton); 
}

export function ensureOpenLibraryHeaderBtn(createOpenLibraryButton) {
  const header = document.querySelector('.header .container .superFeat');
  if (!header) return;
  if (!document.getElementById('btnOpenLibrary')) {
    const btn = createOpenLibraryButton({ label: '📚 Library', className: 'fdv-lib-btn' });
    btn.id = 'btnOpenLibrary';
    btn.style.marginBottom = "15px";
    header.appendChild(btn);
  }
}

export function ensureSearchHeaderBtn(createOpenSearchButton) {
  const header = document.querySelector('.header .container .superFeat');
  if (!header) return;
  if (!document.getElementById('btnOpenSearch')) {
    const factory = typeof createOpenSearchButton === "function"
      ? createOpenSearchButton
      : ({ label = '🔎 Search', className = 'fdv-search-btn' } = {}) => {
          const b = document.createElement("button");
          b.type = "button";
          b.className = className;
          b.id = "btnOpenSearch";
          b.textContent = label;
          b.setAttribute('data-search-open', '');
          return b;
        };

    const btn = factory({ label: 'Search 🔎', className: 'fdv-lib-btn fdv-search-btn' });
    btn.id = 'btnOpenSearch';
    btn.style.marginLeft = "8px";
    btn.style.marginBottom = "15px";
    btn.setAttribute('data-search-open', '');
    btn.setAttribute('aria-label', 'Open search');
    header.appendChild(btn);
  }
}

export function ensureFavboardHeaderBtn(createOpenFavboardButton) {
  const header = document.querySelector('.header .container .superFeat');
  if (!header) return;
  if (document.getElementById('btnOpenFavboard')) return;

  const factory = typeof createOpenFavboardButton === 'function'
    ? createOpenFavboardButton
    : ({ label = '❤️ Favorites', className = 'fdv-lib-btn' } = {}) => {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = className;
        b.id = 'btnOpenFavboard';
        b.textContent = label;
        b.setAttribute('data-fav-open', '');
        return b;
      };

  const btn = factory({ label: '❤️ Favorites', className: 'fdv-lib-btn fdv-fav-btn' });
  btn.id = 'btnOpenFavboard';
  btn.style.marginLeft = "8px";
  btn.style.marginBottom = "15px";
  btn.setAttribute('data-fav-open', '');
  btn.setAttribute('aria-label', 'Open favorites leaderboard');

  const searchBtn = document.getElementById('btnOpenSearch');
  if (searchBtn?.parentElement === header) {
    header.insertBefore(btn, searchBtn);
  } else {
    header.appendChild(btn);
  }
}