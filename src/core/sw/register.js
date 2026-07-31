// Resolved from this module's own URL rather than the page's, so it lands on
// the same sw.js whether it's imported by main.js at the root or by a page a
// directory down (onboard/*.html). Registering at "/" would grab the whole
// github.io origin on a project site, so the scope is the mount point.
const SW_URL = new URL('../../../sw.js', import.meta.url);
const SW_SCOPE = new URL('./', SW_URL);

export function registerServiceWorker() {
	try {

		if (typeof window === 'undefined') return;

		if (!('serviceWorker' in navigator)) return;

		if (!window.location || window.location.protocol !== 'https:' && window.location.hostname !== 'localhost') return;

		navigator.serviceWorker.register(SW_URL.href, { scope: SW_SCOPE.href }).catch(() => {});

	} catch {}
}

registerServiceWorker();
