Gross TP base goal (%) (data-auto-gross-basegoal → state.minProfitToTrailPct): Profit threshold (percent) that acts like a "base goal" before more aggressive profit-management kicks in (commonly: before trailing becomes active or before it tightens). Higher = waits longer to start "protecting" profit; lower = starts protecting earlier.

Edge buffer (%) (data-auto-edge-buf → state.edgeSafetyBufferPct): Extra margin added to edge checks so the bot demands a slightly better quote/edge before entering or adding. Higher = fewer trades / more conservative fills; lower = more trades / accepts thinner edge.

Light entry (On/Off) (data-auto-light-enabled → state.lightEntryEnabled): Enables an entry style where the bot starts with a smaller initial buy and only "tops up" if conditions remain favorable. Helps avoid full-size entries into immediate reversals.

Light fraction (0–1) (data-auto-light-frac → state.lightEntryFraction): What fraction of the normal buy size is used for the initial "light" entry. Example: 0.33 ≈ one‑third size initial entry.

Light top-up arm (ms) (data-auto-light-arm → state.lightTopUpArmMs): Delay after the initial entry before the bot is allowed to perform a "top-up" (add to the position). Higher = slower to add; lower = adds sooner.

Light top-up min chg5m (%) (data-auto-light-minchg → state.lightTopUpMinChg5m): Minimum 5‑minute price change required before topping up. Higher = only add when momentum is strong; lower = add more readily.

Light top-up min GS (data-auto-light-minchgslope → state.lightTopUpMinChgSlope): Minimum "growth slope" style threshold (momentum/acceleration signal) required to top up. Higher = stricter momentum requirement.

Light top-up min CS (data-auto-light-minscslope → state.lightTopUpMinScSlope): Minimum "conviction/score slope" threshold required to top up. Higher = demands stronger score trend before adding.

Warming min profit (%) (data-auto-warm-minp → state.warmingMinProfitPct): In warming mode, the minimum profit level the bot aims to reach/maintain before considering "release" or other warming-related transitions. Higher = tries to only ride when already up more; lower = can ride earlier.

Warming floor (%) (data-auto-warm-floor → state.warmingMinProfitFloorPct): The "don’t let it go below this" floor used in warming logic. A more negative floor tolerates more drawdown while riding; a higher floor exits earlier.

Decay delay (s) (data-auto-warm-delay → state.warmingDecayDelaySecs): How long to wait before letting warming benefits/score "decay" after conditions weaken. Higher = stickier warming; lower = warming disengages sooner.

Auto release (s) (data-auto-warm-release → state.warmingAutoReleaseSecs): Auto-release timer for warming mode (how long it can stay in a warmed/primed state before the bot forces a transition). Higher = ride longer; lower = release sooner.

Max loss (%) (data-auto-warm-maxloss → state.warmingMaxLossPct): Loss cap used by warming risk logic. Higher = tolerate more downside while in warming; lower = cut sooner.

Max loss window (s) (data-auto-warm-window → state.warmingMaxLossWindowSecs): Time window for evaluating the max-loss condition. Shorter window = reacts faster to sharp drops; longer = more forgiving of brief dips.

Primed consec (data-auto-warm-consec → state.warmingPrimedConsec): How many consecutive "good" ticks/signals are required to consider warming "primed." Higher = needs sustained confirmation; lower = primes faster.

Edge min excl (%) (data-auto-warm-edge → state.warmingEdgeMinExclPct): Optional minimum edge requirement specifically for warming decisions (often used to exclude low-quality warm signals). Higher = fewer warming triggers.

Rebound min score (data-auto-rebound-score → state.reboundMinScore): Threshold score needed to qualify a rebound event (used for bounce/reversal logic). Higher = only strong rebounds count.

Rebound lookback (s) (data-auto-rebound-lookback → state.reboundLookbackSecs): Time window for detecting a rebound. Shorter = focuses on fast bounces; longer = allows slower recoveries.

Friction snap (SOL) (data-auto-fric-snap → state.fricSnapEpsSol): A small SOL epsilon used to "snap" tiny differences to zero / reduce micro-churn (prevents the bot from overreacting to dust-level SOL deltas). Higher = more smoothing; lower = more sensitive.

Final gate (On/Off) (data-auto-final-gate-enabled → state.finalPumpGateEnabled): Enables a last "go/no-go" filter before entering (think: final sanity gate to avoid bad entries).

Final gate min start (data-auto-final-gate-minstart → state.finalPumpGateMinStart): Minimum starting score/condition needed for the final gate to pass.

Final gate Δscore (data-auto-final-gate-delta → state.finalPumpGateDelta): Required improvement (delta) in score over the window to pass the final gate. Higher = must be accelerating/improving more.

Final gate window (ms) (data-auto-final-gate-window → state.finalPumpGateWindowMs): Lookback window used to measure the Δscore. Shorter = needs fast improvement; longer = accepts slower improvement.

Simulation mode (data-auto-entry-sim-mode → state.entrySimMode):

off: don’t simulate entry quality.
warn: simulate and warn if it looks bad (but still allow).
enforce: block entries that fail the simulation thresholds.
Max entry cost (%) (data-auto-max-entry-cost → state.maxEntryCostPct): In sim mode, the maximum acceptable "cost" of entering (slippage/impact/edge loss). Lower = stricter, blocks more.

Sim horizon (s) (data-auto-entry-sim-horizon → state.entrySimHorizonSecs): How far forward the sim evaluates risk/outcomes. Short = very near-term; long = more conservative modeling.

Sim min win P (0–1) (data-auto-entry-sim-minprob → state.entrySimMinWinProb): Minimum probability of a "win" required. Higher = only take trades with higher estimated win rate.

Sim min terminal P (data-auto-entry-sim-minterm → state.entrySimMinTerminalProb): Minimum probability of a good terminal outcome (end-of-horizon) required. Higher = more selective.

Sigma floor (%) (data-auto-entry-sim-sigmafloor → state.entrySimSigmaFloorPct): Minimum volatility (sigma) assumed/used by the sim. Higher = assumes more variance/risk; lower = assumes calmer behavior.

Sigma μ level weight (data-auto-entry-sim-mulevelw → state.entrySimMuLevelWeight): Weighting factor for mean-return vs "level" effects in the sim. Higher usually makes the sim care more about the mean/level component when scoring entries.