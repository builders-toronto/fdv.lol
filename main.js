import { router } from './src/router/switch.js';

import { captureReferralFromUrl } from './src/vista/widgets/auto/lib/referral.js';

import './src/vista/security/legal.js';
import './src/core/solana/splToken.js';

try {
	const p = new URLSearchParams(location.search);
	const v = String(p.get('train_capture') || '').trim().toLowerCase();
	const on = !!v && (v === '1' || v === 'true' || v === 'yes' || v === 'on');
	if (on) {
		import('./src/agents/training.js')
			.then((m) => {
				try { m.installTrainingDebugGlobal?.(); } catch {}
			})
			.catch(() => {});
	}
} catch {}

try { captureReferralFromUrl?.({ stripParam: true }); } catch {}

router.dispatch();