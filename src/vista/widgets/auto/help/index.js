import { getAutoTraderState } from '../trader/index.js';

const HELP_SHOWN_KEY = 'fdv-auto-trader-help-shown';

function _safeGetLs(key) {
	try {
		if (typeof localStorage === 'undefined') return null;
		return localStorage.getItem(key);
	} catch {
		return null;
	}
}

function _safeSetLs(key, val) {
	try {
		if (typeof localStorage === 'undefined') return false;
		localStorage.setItem(key, String(val));
		return true;
	} catch {
		return false;
	}
}

function _hasUsedAutoTrader() {
	try {
		const st = (typeof getAutoTraderState === 'function') ? (getAutoTraderState() || {}) : {};
		if (String(st.autoWalletPub || '').trim()) return true;
		if (String(st.autoWalletSecret || '').trim()) return true;
		if (String(st.recipientPub || '').trim()) return true;

		if (Number(st.lastTradeTs || 0) > 0) return true;
		if (Number(st.moneyMadeSol || 0) !== 0) return true;
		if (Number(st.pnlBaselineSol || 0) !== 0) return true;
		if (Number(st.endAt || 0) > 0) return true;

		const pos = st.positions && typeof st.positions === 'object' ? st.positions : null;
		if (pos && Object.keys(pos).some((k) => k && k !== 'So11111111111111111111111111111111111111112')) {
			return true;
		}
	} catch {}
	return false;
}

function _shouldShowFirstRunHelp() {
	try {
		if (typeof window === 'undefined' || typeof document === 'undefined') return false;
		if (_safeGetLs(HELP_SHOWN_KEY) === '1') return false;
		if (_hasUsedAutoTrader()) return false;

		if (window._fdvAutoFirstHelpShownOnce) return false;
		return true;
	} catch {
		return false;
	}
}

function _createEl(tag, attrs = {}, html = '') {
	const el = document.createElement(tag);
	for (const [k, v] of Object.entries(attrs || {})) {
		if (v === null || v === undefined) continue;
		if (k === 'class') el.className = String(v);
		else if (k === 'style') el.setAttribute('style', String(v));
		else if (k.startsWith('data-')) el.setAttribute(k, String(v));
		else el.setAttribute(k, String(v));
	}
	if (html) el.innerHTML = html;
	return el;
}

function _closeHelpInline(rootEl, { persistIfChecked = true } = {}) {
	try {
		const cb = rootEl?.querySelector?.('[data-fdv-auto-firsthelp-noshow]');
		const checked = !!cb?.checked;
		if (persistIfChecked && checked) {
			_safeSetLs(HELP_SHOWN_KEY, '1');
		}
	} catch {}

	try {
		if (rootEl && rootEl.parentNode) rootEl.parentNode.removeChild(rootEl);
	} catch {}

	try { window._fdvAutoFirstHelpOpen = false; } catch {}
}

function _buildHelpInlineCard() {
	const root = _createEl('div', {
		'data-fdv-auto-firsthelp-root': '1',
		style: [
			'display:block',
			'margin:10px 0 12px 0',
			'border:1px solid var(--fdv-border)',
			'border-radius:14px',
			'padding:12px',
			'background:color-mix(in srgb, var(--fdv-surface) 88%, transparent)',
		].join('; '),
	});

	const header = _createEl('div', {
		style: 'display:flex; align-items:flex-start; justify-content:space-between; gap:12px; margin-bottom:10px;',
	});
	header.innerHTML = `
		<div style="display:flex; flex-direction:column; gap:4px; min-width:0;">
			<div style="display:flex; align-items:center; gap:8px; flex-wrap:wrap;">
				<strong style="font-size:14px; letter-spacing:.2px;">Auto Trader quick start</strong>
				<span style="font-size:12px; color:var(--fdv-muted);">(first time only)</span>
			</div>
			<div style="font-size:12px; color:var(--fdv-muted); line-height:1.35;">
				Set up a CORS RPC + wallet, then start safely.
			</div>
		</div>
		<button type="button" class="btn" data-fdv-auto-firsthelp-close style="padding:6px 10px;">Close</button>
	`;

	const body = _createEl('div', { style: 'display:block;' });
	body.innerHTML = `
		<div style="display:flex; flex-direction:column; gap:12px;">
			<div style="border:1px solid var(--fdv-border); border-radius:12px; padding:12px; background:color-mix(in srgb, var(--fdv-bg) 70%, transparent);">
				<div style="font-weight:700; margin-bottom:6px;">Step 1 - Get a CORS-enabled Solana RPC</div>
				<div style="color:var(--fdv-muted); font-size:13px; line-height:1.45;">
					The bot needs a Solana RPC endpoint that allows browser requests (CORS). We recommend QuickNode:
					<a href="https://quicknode.com/signup?via=lf" target="_blank" rel="noopener">quicknode.com (click here)</a>
				</div>
				<div class="fdv-rpc-text">
					Paste your RPC URL into <b>RPC (CORS)</b> in the Auto panel. If your provider requires auth headers, add them as JSON.
				</div>
				<div style="margin-top:8px;">
					<div style="font-size:12px; color:var(--fdv-muted); margin-bottom:6px;">Example headers:</div>
					<pre class="fdv-mono" style="margin:0; border:1px solid var(--fdv-border); background:var(--fdv-bg); padding:10px; border-radius:10px; font-size:12px; white-space:pre-wrap;">{"Authorization":"Bearer YOUR_KEY"}</pre>
				</div>
			</div>

			<div style="border:1px solid var(--fdv-border); border-radius:12px; padding:12px; background:color-mix(in srgb, var(--fdv-bg) 70%, transparent);">
				<div style="font-weight:700; margin-bottom:6px;">Step 2 - Generate the Auto Wallet</div>
				<div style="color:var(--fdv-muted); font-size:13px; line-height:1.45;">
					Click <b>Generate</b> to create a dedicated trading wallet. Then send a small amount of SOL to the displayed address.
				</div>
				<div style="color:var(--fdv-muted); font-size:13px; line-height:1.45; margin-top:6px;">
					Tip: Use a fresh “burner” wallet for trading, and set <b>Recipient (SOL)</b> to your main wallet for withdrawals.
				</div>
			</div>

			<div style="border:1px solid var(--fdv-border); border-radius:12px; padding:12px; background:color-mix(in srgb, var(--fdv-bg) 70%, transparent);">
				<div style="font-weight:700; margin-bottom:6px;">Step 3 - Start safely</div>
				<div style="color:var(--fdv-muted); font-size:13px; line-height:1.45;">
					Set conservative values (Buy %, Min/Max Buy, TP/SL), then click <b>Start</b>. You can click <b>Stop</b> anytime.
					To send funds back to your Recipient, use <b>Return</b>.
				</div>
			</div>

			<div style="border:1px solid var(--fdv-border); border-radius:12px; padding:12px; background:color-mix(in srgb, var(--fdv-bg) 70%, transparent);">
				<div style="font-weight:700; margin-bottom:6px;">Step 4 (optional) - Import Auto Wallet into Phantom</div>
				<div style="color:var(--fdv-muted); font-size:13px; line-height:1.45;">
					You can export your Auto Wallet secret/key and import it into Phantom. Keep the Phantom extension open beside the bot while operating.
					This gives full control over funds and transfers.
				</div>
				<div style="color:var(--fdv-muted); font-size:12px; line-height:1.35; margin-top:6px;">
					Security note: importing a private key gives Phantom full access to that wallet. Only do this if you understand the risk and trust your device/browser.
				</div>
			</div>

			<div style="font-size:12px; color:var(--fdv-muted); line-height:1.35;">
				Safety note: Never paste seed phrases. RPC headers may contain API keys-treat them like passwords.
			</div>
		</div>
	`;

	const footer = _createEl('div', {
		style: 'display:flex; align-items:center; justify-content:space-between; gap:10px; margin-top:10px; flex-wrap:wrap;',
	});
	footer.innerHTML = `
		<label style="display:flex; align-items:center; gap:8px; font-size:13px; color:var(--fdv-muted); user-select:none;">
			<input type="checkbox" data-fdv-auto-firsthelp-noshow />
			Don't show this again
		</label>
		<div style="display:flex; gap:8px;">
			<button type="button" class="btn" data-fdv-auto-firsthelp-skip>Skip</button>
			<button type="button" class="btn" data-fdv-auto-firsthelp-gotit>Got it</button>
		</div>
	`;

	root.appendChild(header);
	root.appendChild(body);
	root.appendChild(footer);
	return root;
}

export function maybeShowAutoTraderFirstRunHelp(mountEl) {
	try {
		if (!_shouldShowFirstRunHelp()) return false;
		if (window._fdvAutoFirstHelpOpen) return false;
		window._fdvAutoFirstHelpOpen = true;
		window._fdvAutoFirstHelpShownOnce = true;

		const host = mountEl && mountEl.appendChild ? mountEl : null;
		if (!host) {
			try { window._fdvAutoFirstHelpOpen = false; } catch {}
			return false;
		}

		if (host.querySelector?.('[data-fdv-auto-firsthelp-root]')) {
			try { window._fdvAutoFirstHelpOpen = false; } catch {}
			return false;
		}

		const root = _buildHelpInlineCard();
		host.appendChild(root);

		const close = () => {
			_closeHelpInline(root, { persistIfChecked: true });
		};

		root.querySelector('[data-fdv-auto-firsthelp-close]')?.addEventListener('click', close);
		root.querySelector('[data-fdv-auto-firsthelp-skip]')?.addEventListener('click', close);
		root.querySelector('[data-fdv-auto-firsthelp-gotit]')?.addEventListener('click', close);

		try { root.querySelector('[data-fdv-auto-firsthelp-gotit]')?.focus?.(); } catch {}
		return true;
	} catch {
		try { window._fdvAutoFirstHelpOpen = false; } catch {}
		return false;
	}
}