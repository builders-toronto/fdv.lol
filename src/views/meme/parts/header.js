export function initHeader(createOpenLibraryButton) {
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
}

export function ensureOpenLibraryHeaderBtn(createOpenLibraryButton) {
  const header = document.querySelector('.header .container .superFeat');
  if (!header) return;
  if (!document.getElementById('btnOpenLibrary')) {
    const btn = createOpenLibraryButton({ label: '📚 Library', className: 'fdv-lib-btn' });
    btn.id = 'btnOpenLibrary';
    header.appendChild(btn);
  }
}