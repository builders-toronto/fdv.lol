export function createDextoolsCandlestickHover({
	anchorEl,
	getMint,
	chainId = "solana",
	cacheTtlMs = 5 * 60 * 1000,
	loadTimeoutMs = 12 * 1000,
	maxLoadRetries = 1,
	retryDelayMs = 650,
	now = () => Date.now(),
	tooltipTitle = "DEXTools Candles",
	clearAnchorTitle = true,
} = {}) {
	let _tipEl = null;
	let _hideTimer = null;
	let _tipMint = "";
	let _tipPair = "";
	let _tipUrl = "";
	let _loadSeq = 0;
	let _loadTimer = null;
	let _loadRetryCount = 0;
	let _iframeLoadAt = 0;

	const _pairCache = new Map(); // mint -> { pair, at, pendingPromise }

	let _onAnchorEnter = null;
	let _onAnchorLeave = null;
	let _onAnchorFocus = null;
	let _onAnchorBlur = null;
	let _onWindowScroll = null;
	let _onWindowResize = null;

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
					// DEXTools widget expects a pool/pair address, not the token mint.
					// We resolve the most liquid pair via Dexscreener.
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

	function _ensureTipEl() {
		try {
			if (_tipEl) return _tipEl;
			if (typeof document === "undefined") return null;

			const el = document.createElement("div");
			el.className = "fdv-chart-tooltip";
			el.dataset.open = "0";
			el.innerHTML = `
				<div class="fdv-chart-tooltip__header">
					<div class="fdv-chart-tooltip__title">${String(tooltipTitle || "DEXTools Candles")}</div>
					<div class="fdv-chart-tooltip__mint" data-hold-chart-mint></div>
					<a class="fdv-chart-tooltip__open" href="#" target="_blank" rel="noopener noreferrer" data-hold-chart-open>Open</a>
					<button class="fdv-chart-tooltip__reload" type="button" data-hold-chart-reload title="Reload">⟳</button>
					<button class="fdv-chart-tooltip__close" type="button" aria-label="Close">×</button>
				</div>
				<iframe
					class="fdv-chart-tooltip__frame"
					data-hold-chart-iframe
					title="DEXTools Trading Chart"
					loading="lazy"
					allow="fullscreen; clipboard-read; clipboard-write"
					referrerpolicy="no-referrer"
				></iframe>
				<div class="fdv-chart-tooltip__hint" data-hold-chart-hint>Hover Chart to load candles.</div>
			`;

			try {
				el.addEventListener("mouseenter", () => {
					try {
						if (_hideTimer) clearTimeout(_hideTimer);
					} catch {}
				});
				el.addEventListener("mouseleave", () => {
					_scheduleHide(160);
				});
				el.querySelector(".fdv-chart-tooltip__close")?.addEventListener("click", () => {
					hide();
				});
				el.querySelector("[data-hold-chart-reload]")?.addEventListener("click", () => {
					try {
						_reloadIframe({ forceBust: true });
					} catch {}
				});
				el.querySelector("[data-hold-chart-open]")?.addEventListener("click", (e) => {
					try {
						e?.preventDefault?.();
						_openExternal();
					} catch {}
				});

				const iframe = el.querySelector("[data-hold-chart-iframe]");
				if (iframe) {
					iframe.addEventListener("load", () => {
						try {
							_iframeLoadAt = now();
							if (_loadTimer) clearTimeout(_loadTimer);
							_loadTimer = null;
							const hint = _tipEl?.querySelector?.("[data-hold-chart-hint]");
							if (hint && _tipEl?.dataset?.open === "1") {
								const p = _tipPair ? `<code>${String(_tipPair).slice(0, 10)}…</code>` : "";
								hint.innerHTML = `${p ? `Pool: ${p} · ` : ""}If blank, DEXTools may be blocking iframes/CF challenge; use Open or Reload.`;
							}
						} catch {}
					});
					iframe.addEventListener("error", () => {
						try {
							if (_loadTimer) clearTimeout(_loadTimer);
							_loadTimer = null;
							const hint = _tipEl?.querySelector?.("[data-hold-chart-hint]");
							if (hint) hint.innerHTML = `DEXTools iframe failed to load. Try Open (new tab) or Reload.`;
						} catch {}
					});
				}
			} catch {}

			document.body.appendChild(el);
			_tipEl = el;
			return el;
		} catch {
			return null;
		}
	}

	function _isLocalhost() {
		try {
			const h = String(globalThis?.location?.hostname || "").toLowerCase();
			if (!h) return false;
			if (h === "localhost" || h === "127.0.0.1" || h === "::1") return true;
			if (h.endsWith(".local") || h.endsWith(".localhost")) return true;
			return false;
		} catch {
			return false;
		}
	}

	function _setOpenLink(url) {
		try {
			const a = _tipEl?.querySelector?.("[data-hold-chart-open]");
			if (!a) return;
			const u = String(url || "").trim();
			if (!u) {
				a.setAttribute("href", "#");
				a.setAttribute("aria-disabled", "true");
				return;
			}
			a.setAttribute("href", u);
			a.removeAttribute("aria-disabled");
		} catch {}
	}

	function _openExternal() {
		try {
			const u = String(_tipUrl || "").trim();
			if (!u) return;
			window.open(u, "_blank", "noopener,noreferrer");
		} catch {}
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

	function _reloadIframe({ forceBust = false } = {}) {
		try {
			if (!_tipEl || _tipEl?.dataset?.open !== "1") return;
			const iframe = _tipEl?.querySelector?.("[data-hold-chart-iframe]");
			if (!iframe) return;
			const baseUrl = String(_tipUrl || "").trim();
			if (!baseUrl) return;
			const nextUrl = forceBust ? _urlWithBust(baseUrl) : baseUrl;
			try {
				iframe.src = "about:blank";
			} catch {}
			setTimeout(() => {
				try {
					if (_tipEl?.dataset?.open !== "1") return;
					iframe.src = nextUrl;
				} catch {}
			}, 40);
		} catch {}
	}

	function _scheduleLoadTimeout(seq, url) {
		try {
			if (_loadTimer) clearTimeout(_loadTimer);
			_loadTimer = setTimeout(() => {
				try {
					if (!_tipEl || _tipEl?.dataset?.open !== "1") return;
					if (seq !== _loadSeq) return;
					const hint = _tipEl?.querySelector?.("[data-hold-chart-hint]");
					if (hint) {
						hint.innerHTML = `DEXTools is taking a while (often Cloudflare / iframe blocking). Use Open (new tab) or Reload.`;
					}

					if (_loadRetryCount < Math.max(0, Number(maxLoadRetries || 0))) {
						_loadRetryCount++;
						setTimeout(() => {
							try {
								if (!_tipEl || _tipEl?.dataset?.open !== "1") return;
								if (seq !== _loadSeq) return;
								_reloadIframe({ forceBust: true });
							} catch {}
						}, Math.max(0, Number(retryDelayMs || 0)));
					}
				} catch {}
			}, Math.max(1500, Number(loadTimeoutMs || 0)));
		} catch {}
	}

	function _positionTip() {
		try {
			if (!_tipEl || !_tipEl.dataset) return;
			const a = anchorEl?.getBoundingClientRect?.();
			if (!a) return;
			const vw = Math.max(320, window.innerWidth || 0);
			const vh = Math.max(240, window.innerHeight || 0);

			const r = _tipEl.getBoundingClientRect();
			const w = Math.max(260, r.width || 740);
			const h = Math.max(220, r.height || 520);

			const margin = 10;
			const preferBelow = (a.bottom + margin + h) <= vh;
			let top = preferBelow ? (a.bottom + margin) : (a.top - margin - h);
			let left = a.left + (a.width / 2) - (w / 2);

			top = Math.max(margin, Math.min(vh - h - margin, top));
			left = Math.max(margin, Math.min(vw - w - margin, left));

			_tipEl.style.top = `${Math.round(top)}px`;
			_tipEl.style.left = `${Math.round(left)}px`;
		} catch {}
	}

	function show(mintOverride) {
		try {
			const m = String(mintOverride || (typeof getMint === "function" ? getMint() : "") || "").trim();
			if (!m) return;
			const el = _ensureTipEl();
			if (!el) return;
			_loadSeq++;
			_loadRetryCount = 0;
			try {
				if (_hideTimer) clearTimeout(_hideTimer);
			} catch {}
			_hideTimer = null;
			_tipMint = m;
			_tipPair = "";
			_tipUrl = "";
			_setOpenLink("");

			try {
				const mintLabelEl = el.querySelector("[data-hold-chart-mint]");
				if (mintLabelEl) mintLabelEl.textContent = m;
			} catch {}
			try {
				const hint = el.querySelector("[data-hold-chart-hint]");
				if (hint) {
					hint.innerHTML = _isLocalhost()
						? `Loading DEXTools candles… <span style="opacity:.75">(DEXTools often blocks localhost; Open in new tab may work)</span>`
						: `Loading DEXTools candles…`;
				}
			} catch {}
			try {
				const iframe = el.querySelector("[data-hold-chart-iframe]");
				if (iframe) iframe.src = "about:blank";
			} catch {}

			el.dataset.open = "1";
			_positionTip();

			const seq = _loadSeq;
			void (async () => {
				const r = await _resolvePairForMint(m);
				try {
					if (!_tipEl || _tipEl.dataset.open !== "1") return;
					if (_tipMint !== m) return;
					if (seq !== _loadSeq) return;
				} catch {}

				if (!r?.ok || !r.pair) {
					try {
						const hint = _tipEl?.querySelector?.("[data-hold-chart-hint]");
						if (hint) {
							hint.innerHTML = `No DEXTools pool found for this mint (${String(r?.reason || "no-pair")}). `
								+ `Try opening Dexscreener (click Chart) or test on a real domain (DEXTools blocks localhost).`;
						}
					} catch {}
					return;
				}

				_tipPair = String(r.pair || "").trim();
				const url = _widgetUrlForPair(_tipPair);
				_tipUrl = url;
				_setOpenLink(url);
				try {
					const iframe = _tipEl?.querySelector?.("[data-hold-chart-iframe]");
					if (iframe && url) {
						_iframeLoadAt = 0;
						iframe.src = url;
					}
				} catch {}
				try {
					const hint = _tipEl?.querySelector?.("[data-hold-chart-hint]");
					if (hint) {
						hint.innerHTML = `Pool: <code>${String(_tipPair).slice(0, 10)}…</code> via Dexscreener · Loading… If blank, use Open/Reload. (CSP needs <code>frame-src https://www.dextools.io</code>)`;
					}
				} catch {}
				_scheduleLoadTimeout(seq, url);
			})();
		} catch {}
	}

	function hide() {
		try {
			if (_hideTimer) clearTimeout(_hideTimer);
		} catch {}
		_hideTimer = null;
		try {
			if (_loadTimer) clearTimeout(_loadTimer);
		} catch {}
		_loadTimer = null;
		try {
			if (_tipEl) _tipEl.dataset.open = "0";
		} catch {}
	}

	function _scheduleHide(ms = 120) {
		try {
			if (_hideTimer) clearTimeout(_hideTimer);
			_hideTimer = setTimeout(() => {
				_hideTimer = null;
				hide();
			}, Math.max(0, Number(ms || 0)));
		} catch {
			hide();
		}
	}

	function mount() {
		try {
			if (!anchorEl) return;
			if (clearAnchorTitle) {
				try {
					anchorEl.title = "";
				} catch {}
			}

			_onAnchorEnter = () => {
				show();
			};
			_onAnchorLeave = () => {
				_scheduleHide(140);
			};
			_onAnchorFocus = () => {
				show();
			};
			_onAnchorBlur = () => {
				_scheduleHide(0);
			};

			anchorEl.addEventListener("mouseenter", _onAnchorEnter);
			anchorEl.addEventListener("mouseleave", _onAnchorLeave);
			anchorEl.addEventListener("focus", _onAnchorFocus);
			anchorEl.addEventListener("blur", _onAnchorBlur);

			_onWindowScroll = () => {
				try {
					if (_tipEl?.dataset?.open === "1") _positionTip();
				} catch {}
			};
			_onWindowResize = () => {
				try {
					if (_tipEl?.dataset?.open === "1") _positionTip();
				} catch {}
			};

			window.addEventListener("scroll", _onWindowScroll, { passive: true });
			window.addEventListener("resize", _onWindowResize);
		} catch {}
	}

	function unmount({ removeEl = false } = {}) {
		try {
			if (anchorEl && _onAnchorEnter) anchorEl.removeEventListener("mouseenter", _onAnchorEnter);
			if (anchorEl && _onAnchorLeave) anchorEl.removeEventListener("mouseleave", _onAnchorLeave);
			if (anchorEl && _onAnchorFocus) anchorEl.removeEventListener("focus", _onAnchorFocus);
			if (anchorEl && _onAnchorBlur) anchorEl.removeEventListener("blur", _onAnchorBlur);
		} catch {}
		try {
			if (_onWindowScroll) window.removeEventListener("scroll", _onWindowScroll);
			if (_onWindowResize) window.removeEventListener("resize", _onWindowResize);
		} catch {}

		_onAnchorEnter = null;
		_onAnchorLeave = null;
		_onAnchorFocus = null;
		_onAnchorBlur = null;
		_onWindowScroll = null;
		_onWindowResize = null;

		hide();

		if (removeEl) {
			try {
				_tipEl?.remove?.();
			} catch {}
			_tipEl = null;
		}
	}

	return {
		mount,
		unmount,
		show,
		hide,
	};
}
