const CACHE_VERSION = 'fdv-static-v1';
const RUNTIME_CACHE = `${CACHE_VERSION}:runtime`;

// Relative to this script, which sits at the mount point — so these resolve
// under /<repo>/ on GitHub Pages and under / on a custom domain.
const PRECACHE_URLS = [
	'./src/assets/styles/default/global.css',
	'./src/assets/styles/profile/profile.css',
	'./src/assets/styles/shill/shill.css',
	'./onboard/assets/styles/onboard.css',
	'./onboard/assets/styles/policy.css',
].map((p) => new URL(p, self.location).href);

self.addEventListener('install', (event) => {
	event.waitUntil(
		(async () => {
			const cache = await caches.open(RUNTIME_CACHE);
			await cache.addAll(PRECACHE_URLS);
			await self.skipWaiting();
		})().catch(() => {})
	);
});

self.addEventListener('activate', (event) => {
	event.waitUntil(
		(async () => {
			const keys = await caches.keys();
			await Promise.all(
				keys
					.filter((k) => k.startsWith('fdv-static-') && !k.startsWith(CACHE_VERSION))
					.map((k) => caches.delete(k))
			);
			await self.clients.claim();
		})().catch(() => {})
	);
});

function isSameOrigin(url) {
	try { return new URL(url).origin === self.location.origin; } catch { return false; }
}

function isNavigation(req) {
	return req.mode === 'navigate' || (req.destination === '' && req.method === 'GET');
}

function isCacheableAsset(url, req) {
	if (req.method !== 'GET') return false;
	if (!isSameOrigin(url)) return false;
	const p = new URL(url).pathname.toLowerCase();
	return (
		p.endsWith('.css') ||
		p.endsWith('.js') ||
		p.endsWith('.mjs') ||
		p.endsWith('.png') ||
		p.endsWith('.jpg') ||
		p.endsWith('.jpeg') ||
		p.endsWith('.webp') ||
		p.endsWith('.svg') ||
		p.endsWith('.ico')
	);
}

async function networkFirst(req) {
	const cache = await caches.open(RUNTIME_CACHE);
	try {
		const fresh = await fetch(req);
		// Cache successful same-origin GETs.
		try {
			if (fresh && fresh.ok && isSameOrigin(req.url)) cache.put(req, fresh.clone());
		} catch {}
		return fresh;
	} catch {
		const cached = await cache.match(req);
		if (cached) return cached;
		throw new Error('offline');
	}
}

async function staleWhileRevalidate(req) {
	const cache = await caches.open(RUNTIME_CACHE);
	const cached = await cache.match(req);
	const fetchPromise = (async () => {
		try {
			const fresh = await fetch(req);
			try {
				if (fresh && fresh.ok) await cache.put(req, fresh.clone());
			} catch {}
			return fresh;
		} catch {
			return null;
		}
	})();

	return cached || (await fetchPromise) || fetch(req);
}

self.addEventListener('fetch', (event) => {
	const req = event.request;
	if (!req) return;

	// Only handle GET.
	if (req.method !== 'GET') return;

	// HTML navigations: network-first.
	if (isNavigation(req)) {
		event.respondWith(networkFirst(req));
		return;
	}

	// Static assets: stale-while-revalidate.
	if (isCacheableAsset(req.url, req)) {
		event.respondWith(staleWhileRevalidate(req));
		return;
	}
});
