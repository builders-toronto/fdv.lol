export function wireNavigation({ onBack }) {
  document.getElementById("btnBack")?.addEventListener("click", () => {
    window.location.href="/"; 
  });
}

export function wireCopy(mint) {
  document.getElementById("btnCopyMint")?.addEventListener("click", () =>
    navigator.clipboard.writeText("https://fdv.lol/token/" + mint).catch(()=>{})
    .then(() => {
      const btn = document.getElementById("btnCopyMint");
      if (!btn) return;
      const orig = btn.textContent;
      btn.textContent = "Copied!";
      setTimeout(() => { btn.textContent = orig; }, 1500);
    })
  );
}

export function wireStatsResizeAutoShortLabels(root) {
  if (!root) return;
  const cards = root.querySelectorAll('.stat');
  if (!cards.length) return;
  const ro = new ResizeObserver(entries => {
    for (const { target, contentRect } of entries) {
      const short = target.getAttribute('data-short') || '';
      const textEl = target.querySelector('.k__text');
      if (!textEl) continue;
      const long = textEl.dataset.long || textEl.textContent;
      if (!textEl.dataset.long) textEl.dataset.long = long;
      textEl.textContent = (contentRect.width < 180 && short) ? short : long;
    }
  });
  cards.forEach(c => ro.observe(c));
}

export function setupStatsCollapse(grid) {
  if (!grid) return;
  const stats = grid.querySelectorAll('.stat');
  if (stats.length <= 4) return;
  grid.classList.add('is-collapsed');

  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'btn profile__stats-toggle';
  btn.setAttribute('aria-expanded', 'false');
  if (!grid.id) grid.id = 'profile-stats';
  btn.setAttribute('aria-controls', grid.id);
  btn.innerHTML = 'Show all stats <i aria-hidden="true" class="caret"></i>';
  const toggle = () => {
    const collapsed = grid.classList.toggle('is-collapsed');
    const expanded = !collapsed;
    btn.setAttribute('aria-expanded', String(expanded));
    btn.innerHTML = (expanded ? 'Hide extra stats' : 'Show all stats') + ' <i aria-hidden="true" class="caret"></i>';
  };
  btn.addEventListener('click', toggle);
  btn.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); } });
  grid.after(btn);
}

export function setupExtraMetricsToggle(card) {
  if (!card) return;
  const label = card.querySelector('.label') || (() => {
    const l = document.createElement('div');
    l.className = 'label';
    l.textContent = 'Pairs';
    card.prepend(l);
    return l;
  })();
  const content = card.querySelector('.table-scroll');
  if (!content) return;

  let expanded = false;
  content.style.display = 'none';

  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'btn btn-ghost extra-metrics-toggle';
  btn.setAttribute('aria-expanded', 'false');
  btn.setAttribute('aria-controls', 'pairsBody');
  btn.innerHTML = 'Show pairs';

  const header = document.createElement('div');
  header.style.display = 'flex';
  header.style.justifyContent = 'space-between';
  header.style.alignItems = 'center';
  header.append(label);
  header.append(btn);
  card.prepend(header);

  const toggle = () => {
    expanded = !expanded;
    content.style.display = expanded ? '' : 'none';
    btn.setAttribute('aria-expanded', String(expanded));
    btn.innerHTML = (expanded ? 'Hide pairs' : 'Show pairs');
  };

  btn.addEventListener('click', toggle);
  btn.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); } });
}
