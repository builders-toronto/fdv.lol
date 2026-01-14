export function createDextoolsCandlestickEmbed({
	containerEl,
	getMint,
	chainId = "solana",
	cacheTtlMs = 5 * 60 * 1000,
	loadTimeoutMs = 12 * 1000,
	maxLoadRetries = 1,
	retryDelayMs = 650,
	now = () => Date.now(),
	title = "DEXTools Candles",
} = {}) {
	let _rootEl = null;
	let _iframeEl = null;
	let _hintEl = null;
	let _mintEl = null;
	let _openEl = null;
	let _reloadEl = null;

	let _active = true;
	let _mint = "";
	let _pair = "";
	let _url = "";
	let _loadSeq = 0;
	let _loadTimer = null;
	let _loadRetryCount = 0;

	const _pairCache = new Map(); // mint -> { pair, at, pendingPromise }

	function _widgetUrlForPair(pairAddress) {
		const chain = String(chainId || "").trim() || "solana";
		const pair = String(pairAddress || "").trim();
		if (!pair) return "";
		try {
			const params = new URLSearchParams({
				theme: "dark",
				chartType: "1", // Candle
				chartResolution: "15",
				drawingToolbars: "false",
			});
			return `https://www.dextools.io/widget-chart/en/${encodeURIComponent(chain)}/pe-light/${encodeURIComponent(pair)}?${params.toString()}`;
		} catch {
			return `https://www.dextools.io/widget-chart/en/${encodeURIComponent(chain)}/pe-light/${encodeURIComponent(pair)}?theme=dark&chartType=1&chartResolution=15&drawingToolbars=false`;
		}
	}

	function _urlWithBust(url) {
		try {
			const u = String(url || "").trim();
			if (!u) return "";
			const sep = u.includes("?") ? "&" : "?";
			return `${u}${sep}_ts=${encodeURIComponent(String(now()))}`;
		} catch {
			return String(url || "");
		}
	}

	function _setOpenLink(url) {
		try {
			if (!_openEl) return;
			const u = String(url || "").trim();
			if (!u) {
				_openEl.setAttribute("href", "#");
				_openEl.setAttribute("aria-disabled", "true");
				return;
			}
			_openEl.setAttribute("href", u);
			_openEl.removeAttribute("aria-disabled");
		} catch {}
	}

	function _openExternal() {
		try {
			const u = String(_url || "").trim();
			if (!u) return;
			window.open(u, "_blank", "noopener,noreferrer");
		} catch {}
	}

	async function _resolvePairForMint(mint) {
		try {
			const m = String(mint || "").trim();
			if (!m) return { ok: false, reason: "NO_MINT", pair: "" };

			const cached = _pairCache.get(m);
			const t = now();
			if (cached && typeof cached === "object") {
				const age = t - Number(cached.at || 0);
				if (cached.pair && age >= 0 && age <= cacheTtlMs) {
					return { ok: true, pair: String(cached.pair || "") };
				}
				if (cached.pendingPromise) {
					try {
						return await cached.pendingPromise;
					} catch {}
				}
			}

			const pendingPromise = (async () => {
				try {
					const url = `https://api.dexscreener.com/latest/dex/tokens/${encodeURIComponent(m)}`;
					const res = await fetch(url, { method: "GET" });
					if (!res.ok) return { ok: false, reason: `HTTP_${res.status}`, pair: "" };
					const json = await res.json().catch(() => null);
					const pairs = Array.isArray(json?.pairs) ? json.pairs : [];

					const onChainPairs = pairs
						.filter((p) => String(p?.chainId || "").toLowerCase() === String(chainId || "solana").toLowerCase())
						.filter((p) => {
							const base = String(p?.baseToken?.address || "");
							const quote = String(p?.quoteToken?.address || "");
							return base === m || quote === m;
						});
					if (!onChainPairs.length) return { ok: false, reason: "NO_PAIRS", pair: "" };

					let best = onChainPairs[0];
					let bestLiq = -1;
					for (const p of onChainPairs) {
						const liq = Number(p?.liquidity?.usd || 0);
						if (Number.isFinite(liq) && liq > bestLiq) {
							best = p;
							bestLiq = liq;
						}
					}

					const pair = String(best?.pairAddress || "").trim();
					if (!pair) return { ok: false, reason: "NO_PAIR_ADDRESS", pair: "" };
					return { ok: true, pair };
				} catch {
					return { ok: false, reason: "FETCH_FAIL", pair: "" };
				}
			})();

			_pairCache.set(m, { pair: "", at: t, pendingPromise });
			const r = await pendingPromise;
			_pairCache.set(m, { pair: String(r?.pair || ""), at: now(), pendingPromise: null });
			return r;
		} catch {
			return { ok: false, reason: "ERR", pair: "" };
		}
	}

	function _scheduleLoadTimeout(seq) {
		try {
			if (_loadTimer) clearTimeout(_loadTimer);
			_loadTimer = setTimeout(() => {
				try {
					if (!_rootEl || !_active) return;
					if (seq !== _loadSeq) return;

					if (_hintEl) _hintEl.innerHTML = `DEXTools is taking a while (often Cloudflare / iframe blocking). Use Open or Reload.`;

					if (_loadRetryCount < Math.max(0, Number(maxLoadRetries || 0))) {
						_loadRetryCount++;
						setTimeout(() => {
							try {
								if (seq !== _loadSeq) return;
								reload({ forceBust: true });
							} catch {}
						}, Math.max(0, Number(retryDelayMs || 0)));
					}
				} catch {}
			}, Math.max(1500, Number(loadTimeoutMs || 0)));
		} catch {}
	}

	function _renderBase() {
		if (_rootEl) return _rootEl;
		if (!containerEl) return null;
		if (typeof document === "undefined") return null;

		const wrap = document.createElement("div");
		wrap.className = "fdv-chart-embed";
		wrap.innerHTML = `
			<div class="fdv-chart-tooltip__header">
				<div class="fdv-chart-tooltip__title">${String(title || "DEXTools Candles")}</div>
				<div class="fdv-chart-tooltip__mint" data-hold-chart-mint></div>
				<a class="fdv-chart-tooltip__open" href="#" target="_blank" rel="noopener noreferrer" data-hold-chart-open>Open</a>
				<button class="fdv-chart-tooltip__reload" type="button" data-hold-chart-reload title="Reload">⟳</button>
			</div>
			<iframe
				class="fdv-chart-tooltip__frame"
				data-hold-chart-iframe
				title="DEXTools Trading Chart"
				loading="lazy"
				allow="fullscreen; clipboard-read; clipboard-write"
				referrerpolicy="no-referrer"
			></iframe>
			<div class="fdv-chart-tooltip__hint" data-hold-chart-hint>Enter a mint to load DEXTools candles.</div>
		`;

		_rootEl = wrap;
		_mintEl = wrap.querySelector("[data-hold-chart-mint]");
		_openEl = wrap.querySelector("[data-hold-chart-open]");
		_reloadEl = wrap.querySelector("[data-hold-chart-reload]");
		_iframeEl = wrap.querySelector("[data-hold-chart-iframe]");
		_hintEl = wrap.querySelector("[data-hold-chart-hint]");

		try {
			_reloadEl?.addEventListener("click", () => reload({ forceBust: true }));
			_openEl?.addEventListener("click", (e) => {
				try {
					e?.preventDefault?.();
					_openExternal();
				} catch {}
			});
			_iframeEl?.addEventListener?.("load", () => {
				try {
					if (_loadTimer) clearTimeout(_loadTimer);
					_loadTimer = null;
					if (_hintEl && _active) {
						const p = _pair ? `<code>${String(_pair).slice(0, 10)}…</code>` : "";
						_hintEl.innerHTML = (p ? `Pool: ${p} · ` : "") + "If blank, DEXTools may be blocking iframes/CF challenge; use Open or Reload.";
					}
				} catch {}
			});
			_iframeEl?.addEventListener?.("error", () => {
				try {
					if (_loadTimer) clearTimeout(_loadTimer);
					_loadTimer = null;
					if (_hintEl) _hintEl.innerHTML = `DEXTools iframe failed to load. Try Open (new tab) or Reload.`;
				} catch {}
			});
		} catch {}

		try {
			containerEl.appendChild(wrap);
		} catch {}

		return wrap;
	}

	async function refresh({ mintOverride = "", force = false } = {}) {
		try {
			_renderBase();
			if (!_rootEl) return;
			if (!_active) return;

			const m = String(mintOverride || (typeof getMint === "function" ? getMint() : "") || "").trim();
			if (!m) {
				_mint = "";
				_pair = "";
				_url = "";
				_setOpenLink("");
				if (_mintEl) _mintEl.textContent = "";
				if (_iframeEl) _iframeEl.src = "about:blank";
				if (_hintEl) _hintEl.innerHTML = `Enter a mint to load DEXTools candles.`;
				return;
			}

			if (!force && _mint === m && _url) return;

			_mint = m;
			_pair = "";
			_url = "";
			_loadSeq++;
			_loadRetryCount = 0;
			const seq = _loadSeq;

			if (_mintEl) _mintEl.textContent = m;
			if (_hintEl) _hintEl.innerHTML = `Resolving DEXTools pool…`;
			if (_iframeEl) _iframeEl.src = "about:blank";
			_setOpenLink("");

			const r = await _resolvePairForMint(m);
			if (seq !== _loadSeq) return;
			if (!_active) return;

			if (!r?.ok || !r.pair) {
				if (_hintEl) _hintEl.innerHTML = `No DEXTools pool found (${String(r?.reason || "no-pair")}). Use Chart 📊 for Dexscreener.`;
				return;
			}

			_pair = String(r.pair || "").trim();
			_url = _widgetUrlForPair(_pair);
			_setOpenLink(_url);

			if (_hintEl) _hintEl.innerHTML = `Pool: <code>${String(_pair).slice(0, 10)}…</code> via Dexscreener · Loading…`;
			if (_iframeEl && _url) _iframeEl.src = _url;

			_scheduleLoadTimeout(seq);
		} catch {
			try {
				if (_hintEl) _hintEl.innerHTML = `DEXTools chart failed to initialize. Try Reload or Open.`;
			} catch {}
		}
	}

	function reload({ forceBust = false } = {}) {
		try {
			if (!_active) return;
			if (!_iframeEl) return;
			const baseUrl = String(_url || "").trim();
			if (!baseUrl) return;
			const nextUrl = forceBust ? _urlWithBust(baseUrl) : baseUrl;
			try {
				_iframeEl.src = "about:blank";
			} catch {}
			setTimeout(() => {
				try {
					if (!_active) return;
					_iframeEl.src = nextUrl;
				} catch {}
			}, 40);
			_loadSeq++;
			_loadRetryCount = 0;
			_scheduleLoadTimeout(_loadSeq);
		} catch {}
	}

	function setActive(isActive) {
		_active = !!isActive;
		try {
			if (!_active) {
				if (_loadTimer) clearTimeout(_loadTimer);
				_loadTimer = null;
				if (_iframeEl) _iframeEl.src = "about:blank";
				if (_hintEl) _hintEl.innerHTML = `Chart paused (tab inactive).`;
				return;
			}
		} catch {}
		void refresh({ force: true });
	}

	function mount() {
		_renderBase();
		void refresh({ force: true });
	}

	function unmount({ removeEl = false } = {}) {
		try {
			if (_loadTimer) clearTimeout(_loadTimer);
		} catch {}
		_loadTimer = null;

		if (removeEl) {
			try {
				_rootEl?.remove?.();
			} catch {}
			_rootEl = null;
			_iframeEl = null;
			_hintEl = null;
			_mintEl = null;
			_openEl = null;
			_reloadEl = null;
		}
	}

	return {
		mount,
		unmount,
		refresh,
		reload,
		setActive,
	};
}
