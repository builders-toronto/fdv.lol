import { router } from './src/router/switch.js';

import { captureReferralFromUrl } from './src/vista/widgets/auto/lib/referral.js';

import './src/vista/security/legal.js';
import './src/core/solana/splToken.js';

try { captureReferralFromUrl?.({ stripParam: true }); } catch {}

router.dispatch();