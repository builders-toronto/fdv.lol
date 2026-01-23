# Auto Trading Widget (Solana) — Technical Overview

A high-level, structured reference for the automated “pump leader” trading widget. This document organizes the system into clear sections with consistent terminology.

## Table of Contents
1. Purpose & Overall Flow  
2. Core State  
3. Time & Scheduling  
4. Candidate Discovery  
5. Observer System (Buy + Hold Filtering)  
6. Warming Subsystem  
7. Fast Exit Engine  
8. Rebound Gate  
9. Standard Sell Logic  
10. Rug Detection & Blacklisting  
11. Edge Gating (Round-Trip Profitability)  
12. Quoting & Swap Pipeline  
13. Pending Credit & Size Reconciliation  
14. Dust Management  
15. Rotation (Leader Mode)  
16. Fast Observer Loop  
17. Rebound & Drawdown Tracking  
18. Profit & Accounting  
19. Caches & Local Persistence  
20. RPC & Rate Limiting  
21. Safety / Guards  
22. Position Data Fields (Selected)  
23. Valuation & Net Edge Computation  
24. Fee Logic  
25. Fallback & Split-Sell Strategy  
26. Pending Sell Debits  
27. Wallet / Unwind  
28. UI & Initialization  
29. Logging & Diagnostics  
30. Error & Stress Handling  
31. Blacklist & Ban Utilities  
32. Data Normalization Helpers  
33. WSOL / ATA Maintenance  
34. Security / Export  
35. Extensibility Notes  
36. Key Invariants / Design Choices  
37. Potential Pitfalls (Operational)  
38. Minimal Lifecycle Summary

---

## 1. Purpose & Overall Flow
Automates SOL↔token trading around short-lived “pump” leaders:
- Monitors leaders and rug signals.
- Scores candidates via observer and warming heuristics.
- Applies edge and risk gates.
- Executes buys with optimistic seeding then reconciles on-chain.
- Manages exits: rug/observer deterioration, warming profit gate, fast-exit momentum decay, TP/SL/trailing, max-hold, rotation.
- Handles dust, partial fills, ATAs/rent, router cooldowns.
- Tracks realized PnL, persists state, and exposes UI controls.

## 2. Core State
Key groups in `state`:
- Session: `enabled`, `tickMs`, `endAt`, `lastTradeTs`.
- Sizing: `buyPct`, `minBuySol`, `maxBuySol`, `carrySol`.
- Risk/exit: `takeProfitPct`, `stopLossPct`, `trailPct`, `minProfitToTrailPct`, `maxHoldSecs`, `minHoldSecs`, `coolDownSecsAfterBuy`.
- Execution: `slippageBps`, `singlePositionMode`, `allowMultiBuy`, `multiBuyTopN`.
- Edge: `minNetEdgePct`, `edgeSafetyBufferPct`, `warmingEdgeMinExclPct`.
- Warming: decay, floors, priming, `warming*` thresholds and timers.
- Rebound: `reboundGateEnabled`, slopes, score, lookback, defer caps.
- Fast exit: hard stop, trail arm/drop, staged TPs, alpha slopes.
- Observer: passes, grace, drop conditions, `observer*`.
- Pending credit: `pendingGraceMs`, `seedBuyCache`, `awaitingSizeSync`.
- Positions: `positions[mint]` with size/cost/HWM/warming/fast-exit fields.
- Toggles: `dustExitEnabled`, `rideWarming`, `holdUntilLeaderSwitch`, `ownerScanDisabled`.
- Wallet: `autoWalletPub/Secret`, `recipientPub`.
- Accounting: `moneyMadeSol`, `solSessionStartLamports`, `hideMoneyMade`.
- RPC/UI: `rpcUrl`, `rpcHeaders`, collapsed panels, advanced values.

## 3. Time & Scheduling
- Main loop `tick()` every `tickMs` (≥1200ms).
- Fast observer: 40ms for early rug/pump→calm detection.
- Pending credit watchdog: ~2.2s cadence.
- Router per-mint cooldowns.
- Rebound deferrals and warming extensions add micro-delays before sells.

## 4. Candidate Discovery
- `computePumpingLeaders(n)` → sorted leaders with KPIs.
- `recordLeaderSample(mint, sample)` → rolling 3-sample window.
- `pickPumpCandidates`:
  - Badge normalization (pumping/warming/calm).
  - Gates: strict pumping microUp OR warming primed uptick (`detectWarmingUptick`).
  - Composite scoring: momentum, volume/liquidity, acceleration, trend flags.
  - Backside guard (accel ratio).
  - Warming adaptation with stricter primed slopes.
- `pickTopPumper`: short pre-buy watch window; multi-sample thresholds.
- Leader mode: choose top mint and rotate out others.

## 5. Observer System (Buy + Hold Filtering)
- Pre-buy watch compares baseline vs end (chg5m, v1h, liq, pumpScore).
- Pass scoring:
  - 4–5: approve (dynamic hold).
  - 3: consider (debounced promotion).
  - <3: reject + staged blacklist.
- While holding:
  - Re-evaluate deterioration (`observeMintOnce`), force sell on consecutive/severe drops (unless guarded by warming).
  - Track consecutive negative passes for drop guard exits.

## 6. Warming Subsystem
- Goal: allow transitions from warming→pumping without premature sells.
- `detectWarmingUptick`: deltas, per-minute slopes, acceleration, volume z-score, buy skew, backside guard → pass/score.
- Priming: `warmingPrimedConsec` consecutive passes.
- `computeWarmingRequirement`: decaying profit threshold + floor; auto-release after `warmingAutoReleaseSecs`; extend on rebound-like signal.
- Max-loss guard inside `warmingMaxLossWindowSecs`.

## 7. Fast Exit Engine
`checkFastExitTriggers(mint, pos, { pnlPct, pxNow })`:
- Hard stop (drawdown).
- Trail armed above `fastTrailArmPct`, stops at `fastTrailPct`.
- Staged partial TPs (TP1/TP2).
- Momentum decay: negative slopes, accel collapse, no-new-high timeout.
- Overrides standard observer/warming gating; trades faster with wider slippage and shorter confirms.

## 8. Rebound Gate
- For early positions with potential rebound:
  - Conditions: age < lookback, PnL > floor, not rug/TP.
  - Short deferrals (`reboundHoldMs`) until `reboundMaxDeferSecs`.
  - Tracks `reboundDefer*` timestamps per position.

## 9. Standard Sell Logic
- Inputs: `costSol`, `sizeUi`, `pxNow`, `hwmPx`, timers.
- Checks (if not leader-hold):
  - Cooldown after buy, min/max hold, sell cooldown.
  - SL/TP, partial TP, trailing armed above threshold.
- Produces: none | sell_all | sell_partial + reason.
- Overrides: rug, pump→calm ban, observer forced drop, early fade, fast exit, rebound deferral, warming suppression.

## 10. Rug Detection & Blacklisting
- External `getRugSignalForMint` (rugged, sev, badge).
- High severity ≥ threshold (higher if warming): immediate sell + long blacklist.
- Low severity: staged blacklist; may not force sell if warming protects.
- Pump→calm transitions: “pump drop ban” to avoid immediate re-entry.

## 11. Edge Gating (Round-Trip)
`estimateRoundtripEdgePct(owner, mint, buySol)`:
- Implemented in `../lib/honeypot.js` and used by trader/hold/follow/sniper buy gating.
- Quote forward and backward.
- Separate recurring costs (fees/tx) vs one-time (ATA rent).
- Compute `pct` and `pctNoOnetime`.
- Gate compares excluding ATA (rent reclaimed).
- Threshold: base `minNetEdgePct` ± adjustments + `edgeSafetyBufferPct`. Optional `warmingEdgeMinExclPct` override.
- If edge below threshold → skip.
- Small sells only fee if profitable; otherwise no fee.

## 12. Quoting & Swap Pipeline
- `quoteGeneric`, `quoteOutSol`: Jupiter (lite/standard) with rate-limit backoff; fallback toggles `restrictIntermediateTokens`.
- `jupSwapWithKeypair`:
  - Primary `/swap` (with/without fee).
  - Re-quote tweaking flags.
  - Manual build via `/swap-instructions` to VTX.
  - Escalations: increase slippage (≤2000 bps), remove fee, USDC bridge, split-sells (`SPLIT_FRACTIONS`).
- Defenses:
  - Router dust / NO_ROUTE → per-mint cooldown.
  - Optimistic seeding even before final confirmations.

## 13. Pending Credit & Size Reconciliation
- On buy: create seed (`awaitingSizeSync=true`).
- `_pendingCredits`: expected mint, added cost, grace TTL.
- Watchdog: ATA polling, tx metadata (`reconcileBuyFromTx`), fallback owner scans.
- Extends grace for partial credits; clears `awaitingSizeSync` on recognition; merges cost/HWM.

## 14. Dust Management
- Two caches in `localStorage`: positions (POSCACHE) and dust (DUSTCACHE).
- “Dust” ≈ est SOL < min sell notional.
- On sells/rotation/sweep:
  - Remainders below min → move to dust and purge from positions.
- Startup:
  - Attempt to liquidate non-SOL; keep dust if below threshold.
  - Optional dust sweep later.
- Sanitizes invalid pubkeys.

## 15. Rotation (Leader Mode)
- On new leader:
  - Aggressively sell others (full pipeline & fallbacks).
  - Reconcile partials/dust.
  - First leader buy may bypass cooldown; blacklists/bans still respected.

## 16. Fast Observer Loop
- 40ms sampling per held mint:
  - Throttled logs (badge/metric deltas).
  - `fastDropCheck` → `flagUrgentSell` on severe rug or pump→calm drawdown.
- Urgent sells bypass some protections after early cooldown.

## 17. Rebound & Drawdown Tracking
- Per-position:
  - `fastPeakPx`, `fastPeakAt`, `fastAccelPeak`, `fastBackside`.
  - `reboundDeferStartedAt`, `reboundDeferUntil`.

## 18. Profit & Accounting
- `_addRealizedPnl` updates `moneyMadeSol`:
  - Partial sells use proportional `costSold`.
  - USD logs from cached SOL/USD (60s).
- `_logMoneyMade` aggregates for session display.

## 19. Caches & Local Persistence
- `localStorage`:
  - `LS_KEY` main state.
  - `POSCACHE_KEY_PREFIX` owner→{mint:{sizeUi,decimals}}.
  - `DUSTCACHE_KEY_PREFIX` similar for dust.
- Every mutation → `save()`; robust `load()` clamps defaults and hardens schema.

## 20. RPC & Rate Limiting
- Custom RPC URL + headers.
- `rpcWait(kind,minMs)` + stress backoff on 429/403.
- Jupiter calls: spaced, jittered; inflight de-dupe with short memo windows.
- Owner-scan disabled on 403/-32602 (fallback to cache/targeted ATAs).

## 21. Safety / Guards
- Buy lock (`tryAcquireBuyLock`) avoids concurrent buys.
- Mint operation lock (buy/sell) with timeouts.
- Post-buy sell guard window to avoid noisy early exits.
- Pending credit grace avoids premature prune.
- Router cooldown on repeated route failures.
- Blacklist staging escalates: short → longer → longest.

## 22. Position Data Fields (Selected)
- Size/cost: `sizeUi`, `decimals`, `costSol`, `hwmSol`, `hwmPx`.
- Timing: `acquiredAt`, `lastBuyAt`, `lastSellAt`, `lastSeenAt`.
- Sync: `awaitingSizeSync`.
- Warming: `warmingHold`, `warmingHoldAt`, `warmingExtendUntil`.
- Rebound: `reboundDefer*`.
- Early-fade: `earlyNegScCount`, `entryChg5m`, `entryPre`, `entryPreMin`, `entryScSlope`.
- Fast-exit: `fast*` metrics.
- Flow: `allowRebuy`.

## 23. Valuation & Net Edge
- `quoteOutSol`: token→SOL with cautious slippage.
- Net exit estimate: platform fee (if profitable) + conservative tx fee + optional rent depending on comparison.

## 24. Fee Logic
- Platform fee bps is configured via `FDV_PLATFORM_FEE_BPS` in `src/config/env.js`.
- Sells attach fee only when:
  - Not small (`estOut ≥ SMALL_SELL_FLOOR`).
  - Proportional cost ⇒ positive PnL.
  - Re-quote confirms still profitable; otherwise suppress fee.
- Split chunks re-evaluate fee each time.

## 25. Fallback & Split-Sell Strategy
- If primary route fails:
  - Retry: shared accounts / legacy / relax intermediates / larger slippage.
  - USDC bridge, then SOL.
  - Split fractions (descending) to drain liquidity.
- Each partial updates proportional cost/HWM or becomes dust.
- Remainders reconciled by debit checks.

## 26. Pending Sell Debits
- `waitForTokenDebit`: ensure ATA reduction; accurate remainder scaling.
- Partials set router cooldown; potential leftover to dust.

## 27. Wallet / Unwind
- “Return” → `sweepAllToSolAndReturn`:
  - Iterate dust + positions; sell if ≥ min-notional.
  - Unwrap WSOL; transfer SOL to recipient minus rent buffer.
  - Reset session fields.
- Holdings panel summarizes sellable vs dust.

## 28. UI & Initialization
- `initAutoWidget(container)` builds control panel:
  - RPC + headers.
  - Wallet generate/export.
  - Buy sizing + advanced warming/rebound/edge controls.
  - Hold-time slider (+ dynamic).
  - Log view, guide, release notes.
- `#automate` auto-opens.
- Live field updates persist immediately.

## 29. Logging & Diagnostics
- `log()` maintains memory buffer and DOM-capped lines.
- `logObj` for structured dumps (edge, quotes, decisions).
- Fast observer compressed logs every 200ms on changes.

## 30. Error & Stress Handling
- 429: Jupiter stress window; RPC retries with backoff.
- 403/-32602: plan limits disable owner scans gracefully.
- Extensive try/catch prevents single failure from halting loop.

## 31. Blacklist & Ban Utilities
- Staged mint blacklist with duration escalation.
- Pump drop ban to cool re-entries.
- Urgent sell sets blacklist proportional to severity.

## 32. Data Normalization Helpers
- Numerics: `safeNum`, `_clamp`, `normalizePercent`.
- Series: `slope3`, `slope3pm`, `delta3`.
- Momentum/trailing: crest/drawdown; acceleration ratios (`accel5to1`, `accelRatio`).

## 33. WSOL / ATA Maintenance
- After SOL flows: schedule WSOL unwrap.
- Bulk close zero-balance ATAs (batched).
- Update caches on dust promotion/demotion; optionally close empty accounts.

## 34. Security / Export
- Wallet secret (base58) stored locally (intended local-only).
- Export JSON: `{ publicKey, secretKey }`.
- No remote transmission of secrets.

## 35. Extensibility Notes
- External feeds: `computePumpingLeaders`, `getRugSignalForMint`.
- Fee receiver mapping: `FEE_ATAS`.
- Platform fee logic centralized; edge gating modular (`estimateRoundtripEdgePct`).
- Heuristics (warming/observer) decoupled from swap executor.

## 36. Key Invariants / Design Choices
- Avoid buys below Jupiter min-in and internal dust thresholds.
- Sells always try full route; degrade gracefully to splits.
- Pre-buy seeding keeps UI responsive.
- Warming/rebound override generic exits to capture sustained trends.
- One-time rent excluded from net-edge gate.

## 37. Potential Pitfalls (Operational)
- Underfunded wallet: frequent skip logs (edge/min-notional).
- Harsh RPC limits: slow credit reconciliation.
- Extreme volatility: fast exit + blacklist may throttle re-entry.
- Many first-time ATAs on small SOL: rent pressure (skip logic mitigates).

## 38. Minimal Lifecycle Summary
1. `initAutoWidget` → load state → ensure wallet/RPC.  
2. `start` → `startAutoAsync` → preflight → sweep legacy → start tick + fast observer.  
3. Each tick:
   - Update leaders, timers.
   - Process pending credits.
   - Evaluate sells.
   - If idle and gates pass → pick candidates → edge gate → buy.
4. Urgent/fast observers may insert sells between ticks.  
5. Unwind/expiry → sweep to SOL + return; stop resets timers and may close empty ATAs.