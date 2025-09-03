export function setStatStatusByKey(root, key, { ok = null, reason = '' } = {}) {
  const el = root?.querySelector(`.stat[data-stat="${key}"] .status`);
  if (!el) return;

  el.classList.remove('ok', 'warn');
  el.removeAttribute('title');
  el.textContent = '';

  if (ok === null) return;

  if (ok) {
    el.classList.add('ok');
    el.textContent = '✅';
    if (reason) el.title = reason;
    el.setAttribute('role', 'img');
    el.setAttribute('aria-label', 'Approved');
  } else {
    el.classList.add('warn');
    el.textContent = '⚠️';
    if (reason) el.title = reason;
    el.setAttribute('role', 'img');
    el.setAttribute('aria-label', 'Warning');
  }
}
