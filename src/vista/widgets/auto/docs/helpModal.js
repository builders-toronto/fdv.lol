export function getAutoHelpModalHtml() {
  return `
        <div class="fdv-modal" data-auto-modal
             style="display:none; position:fixed; width: 100%; inset:0; z-index:9999; background:rgba(0, 0, 0, 1); align-items:center; justify-content:center;justify-content: flex-start;">
          <div class="fdv-modal-card"
               style="background:#000; color:var(--fdv-fg,#fff);overflow:auto; border-radius:12px; box-shadow:0 10px 30px rgba(0,0,0,.5); padding:16px 20px;">
            <div style="display:flex; align-items:center; justify-content:space-between; gap:12px; margin-bottom:6px;">
              <h3 style="margin:0; font-size:16px;">Auto Pump Bot</h3>
            </div>
            <div class="fdv-tabs" data-auto-tabs style="display:flex; gap:8px; margin:6px 0 10px;">
              <button data-auto-tab="guide" class="active" style="padding:4px 8px;border:1px solid var(--fdv-border,#333);border-radius:6px;background:#222;color:#fff;">Guide</button>
              <button data-auto-tab="release" style="padding:4px 8px;border:1px solid var(--fdv-border,#333);border-radius:6px;background:#111;color:#aaa;">Release</button>
            </div>
            <div class="fdv-modal-body-tooltip" style="font-size:13px; line-height:1.5; gap:10px;">
             <div class="fdv-guide" data-auto-tab-panel="guide">
                <div>
                 <strong>How the Auto Pump Bot works</strong>
                 <p style="margin:6px 0 0 0;">
                   The bot tracks Pumping Radar leaders, buys the strongest candidates, manages risk with warming / rebound /
                   fast-exit logic, and optionally rotates into the current leader. This panel explains every knob in plain
                   language and gives ready-made strategy presets.
                 </p>
               </div>

               <div>
                 <strong>1. Core runtime & wallet</strong>
                 <ul style="margin:6px 0 0 18px;">
                   <li><b>Start / Stop</b><br/>
                     Start runs the engine (ticks) at your configured speed; Stop pauses all new buys/sells
                     (positions are left as-is). The bot does <b>not</b> auto-unwind on Stop - use <b>Return</b> for that.
                   </li>
                   <li><b>Tick speed</b> (<code>tickMs</code>)<br/>
                     How often the bot re-evaluates leaders and positions.
                     <ul style="margin:4px 0 0 18px;">
                       <li>~1200-1500 ms → more reactive, more RPC/Jupiter load.</li>
                       <li>~2500-3000 ms → gentler on infra, slower reactions.</li>
                     </ul>
                   </li>
                   <li><b>Auto Wallet & Recipient</b><br/>
                     <ul style="margin:4px 0 0 18px;">
                       <li><b>Auto Wallet</b> - the dedicated trading wallet (Generate creates it).</li>
                       <li><b>Recipient</b> - where SOL is sent when you press <b>Return</b>.</li>
                       <li>Recommended: use a fresh burner for Auto Wallet and your main/vault wallet as Recipient.</li>
                     </ul>
                   </li>
                   <li><b>Lifetime (mins)</b><br/>
                     Sets a session timer:
                     <ul style="margin:4px 0 0 18px;">
                       <li><code>0</code> → run until you manually Stop.</li>
                       <li><code>60</code> → roughly 1 hour, then auto “End &amp; Return”.</li>
                     </ul>
                   </li>
                 </ul>
               </div>

               <div>
                 <strong>2. RPC & infrastructure</strong>
                 <ul style="margin:6px 0 0 18px;">
                   <li><b>RPC (CORS)</b><br/>
                     CORS-enabled Solana RPC URL used for all chain calls. If you see “owner scans disabled” logs,
                     your provider likely blocks account-owner queries.
                   </li>
                   <li><b>RPC Headers (JSON)</b><br/>
                     Optional HTTP headers, e.g. auth tokens:
                     <pre style="margin:4px 0 0 0;white-space:pre-wrap;">{"Authorization": "Bearer &lt;your-key&gt;"}</pre>
                   </li>
                   <li><b>Backoff & stress handling</b><br/>
                     The bot automatically slows down when it detects 429 / 403 or plan-upgrade errors to avoid bans.
                   </li>
                 </ul>
               </div>

               <div>
                 <strong>3. Buy sizing & friction</strong>
                 <ul style="margin:6px 0 0 18px;">
                   <li><b>Buy % of SOL</b> (<code>buyPct</code>)<br/>
                     How much of your <b>available</b> SOL to spend per buy (after reserves).
                     <ul style="margin:4px 0 0 18px;">
                       <li>Conservative: ~10% (0.10).</li>
                       <li>Aggressive: 25-40% (0.25-0.40).</li>
                     </ul>
                   </li>
                   <li><b>Min / Max Buy (SOL)</b><br/>
                     Floors and caps per-order size. The bot also enforces a friction-aware minimum so that fees + ATA rent
                     do not eat the entire order.
                   </li>
                   <li><b>Reserves & runway</b><br/>
                     The bot keeps aside:
                     <ul style="margin:4px 0 0 18px;">
                       <li>A base fee/rent reserve.</li>
                       <li>Per-position reserves for future sells.</li>
                       <li>A small SOL “runway” (minimum operating SOL).</li>
                     </ul>
                     Only the remaining balance is eligible for buys.
                   </li>
                   <li><b>Friction snap (SOL)</b> (<code>fricSnapEpsSol</code>)<br/>
                     When your planned order is just below the friction minimum, this controls whether the bot bumps it
                     up to the minimum or skips:
                     <ul style="margin:4px 0 0 18px;">
                       <li>Higher (e.g. 0.002) → more likely to “snap up” and buy.</li>
                       <li>Lower (e.g. 0.0005) → more likely to skip and carry until larger.</li>
                     </ul>
                   </li>
                 </ul>
               </div>

               <div>
                 <strong>4. Edge (profitability) gating</strong>
                 <p style="margin:6px 0 0 0;">
                   Before buying, the bot approximates <b>round-trip PnL</b> (SOL → token → SOL) including platform fee and
                   tx fees.
                 </p>
                 <ul style="margin:6px 0 0 18px;">
                   <li><b>Min Edge (%)</b> (<code>minNetEdgePct</code>)<br/>
                     Baseline net edge requirement (excluding one-time ATA rent).
                   </li>
                   <li><b>Edge safety buffer (%)</b> (<code>edgeSafetyBufferPct</code>)<br/>
                     Extra margin added on top, to avoid borderline trades.
                     <br/>Example: <code>minNetEdgePct = -4, buffer = 0.2</code> → need ≥ -3.8% edge.
                   </li>
                   <li><b>Edge min excl (%) - Warming override</b> (<code>warmingEdgeMinExclPct</code>)<br/>
                     Optional stricter edge just for warming entries. If set, warming buys must meet this edge
                     (excl ATA), even if the base Min Edge is looser.
                   </li>
                 </ul>
               </div>

               <div>
                 <strong>5. Take-profit / Stop-loss / Trailing</strong>
                 <ul style="margin:6px 0 0 18px;">
                   <li><b>TP (%)</b> (<code>takeProfitPct</code>)<br/>
                     Net PnL threshold where the bot takes profit:
                     <ul style="margin:4px 0 0 18px;">
                       <li>If <code>partialTpPct</code> between 1-99 → partial TP.</li>
                       <li>Else → full exit.</li>
                     </ul>
                   </li>
                   <li><b>SL (%)</b> (<code>stopLossPct</code>)<br/>
                     Net loss threshold where the bot cuts the position.
                   </li>
                   <li><b>Trail (%)</b> and <b>Min profit to trail (%)</b><br/>
                     Trailing stop arms once PnL ≥ min profit, then sells if drawdown from the high-water mark exceeds
                     the trail percentage.
                   </li>
                   <li><b>Sell cooldown</b> (<code>sellCooldownMs</code>)<br/>
                     Time window after a sell during which the bot will not sell the same position again.
                   </li>
                   <li><b>Min / Max hold (s)</b><br/>
                     <ul style="margin:4px 0 0 18px;">
                       <li><b>Min hold</b> - earliest the bot is allowed to sell.</li>
                       <li><b>Max hold</b> - hard time-based exit (force-sell) unless higher-priority gates say otherwise.</li>
                     </ul>
                   </li>
                   <li><b>Dynamic hold (∞ checkbox)</b><br/>
                     Lets the observer system auto-tune maxHoldSecs based on how strong the entry looked (3/5 vs 5/5).
                   </li>
                 </ul>
                 <p style="margin:6px 0 0 18px;">
                   <b>Examples:</b><br/>
                   Quick scalper: TP 10-15%, SL 3-5%, Trail 6-8%, max hold ~45-60s.<br/>
                   Slower rotator: TP 30-40%, SL 10-15%, Trail 15-20%, max hold a few minutes.
                 </p>
               </div>

               <div>
                 <strong>6. Fast Exit system</strong>
                 <p style="margin:6px 0 0 0;">
                   Fast Exit sits on top of TP/SL/trailing and can override them when price action flips quickly.
                 </p>
                 <ul style="margin:6px 0 0 18px;">
                   <li><b>Hard stop</b> - if loss ≥ <code>fastHardStopPct</code>, force-sell.</li>
                   <li><b>Fast trailing</b> - if PnL ≥ <code>fastTrailArmPct</code> then drawdown ≥ <code>fastTrailPct</code>, sell all.</li>
                   <li><b>Fast TP1 / TP2</b> - staged partial TPs at two profit levels.</li>
                   <li><b>Timeout</b> - if we never get a strong high within <code>fastNoHighTimeoutSec</code> but PnL > 0, take a
                     50% “time stop” partial.</li>
                   <li><b>Alpha decay / trend flip / accel drop</b> - use slopes & acceleration of leaders to exit when momentum
                     clearly dies.</li>
                 </ul>
                 <p style="margin:6px 0 0 18px;">
                   <b>Use when</b> you want the bot to cut losers quickly and monetize spikes aggressively.
                 </p>
               </div>

               <div>
                 <strong>7. Dynamic Hard Stop</strong>
                 <p style="margin:6px 0 0 0;">
                   Instead of a fixed stop-loss, the bot can compute a smart hard stop per position based on liquidity,
                   volume and slopes.
                 </p>
                 <ul style="margin:6px 0 0 18px;">
                   <li><b>Base</b> around 4% loss, then:
                     <ul style="margin:4px 0 0 18px;">
                       <li>High liq/volume or strong slopes → more forgiving (stop farther).</li>
                       <li>Low liq/volume or backside slopes → tighter (stop closer).</li>
                     </ul>
                   </li>
                   <li>Clamped between <code>dynamicHardStopMinPct</code> and <code>dynamicHardStopMaxPct</code>.</li>
                   <li>Only active after the initial “buyer's remorse” window to avoid killing entries too early.</li>
                 </ul>
               </div>

               <div>
                 <strong>8. Warming engine & dynamic hold</strong>
                 <p style="margin:6px 0 0 0;">
                   Warming aims to enter early in trends and then hold those winners long enough to matter.
                 </p>
                 <ul style="margin:6px 0 0 18px;">
                   <li><b>Warming toggle</b> (<b>Warming</b> select)<br/>
                     <ul style="margin:4px 0 0 18px;">
                       <li>Off → classic momentum bot (TP/SL/trail only).</li>
                       <li>On → uses warming uptick detection & warming hold.</li>
                     </ul>
                   </li>
                   <li><b>Warming uptick (entry filter)</b><br/>
                     Uses 3-tick slopes, accel ratio, zV1, buy skew, liq and volume to decide which “warming” leaders are
                     actually worth entering. Priming requires consecutive uptick confirmations to avoid one-off wiggles.
                   </li>
                   <li><b>Warming hold</b> (post-buy)<br/>
                     <ul style="margin:4px 0 0 18px;">
                       <li><b>Warming min profit (%)</b> - base profit target (e.g. 80-120%).</li>
                       <li><b>Decay (%/min)</b> & <b>Delay (s)</b> - the profit requirement decays over time after a delay.</li>
                       <li><b>Floor (%)</b> - requirement never decays below this floor.</li>
                       <li><b>Auto release (s)</b> - after this many seconds, the bot can release warming hold if profit
                         meets the decayed threshold.</li>
                       <li><b>Max loss (%) in window</b> - early protection: if PnL falls below this within the configured
                         window, it forces a sell despite warming.</li>
                       <li><b>Extend on rise</b> - if rebound signal is strong, warming hold can extend a bit longer.</li>
                     </ul>
                   </li>
                 </ul>
               </div>

               <div>
                 <strong>9. Rebound gate</strong>
                 <p style="margin:6px 0 0 0;">
                   When the bot is about to sell, it can temporarily defer the sell if the recent slope of leaders suggests
                   a rebound is forming.
                 </p>
                 <ul style="margin:6px 0 0 18px;">
                   <li><b>Lookback (s)</b> - window used to compute per-minute slopes.</li>
                   <li><b>Max defer (s)</b> - cap on total extra hold time.</li>
                   <li><b>Hold (ms)</b> - length of each deferral.</li>
                   <li><b>Min PnL (%)</b> - deep losers do not get rebound defers.</li>
                 </ul>
               </div>

               <div>
                 <strong>10. Observer system & Leader mode</strong>
                 <ul style="margin:6px 0 0 18px;">
                   <li><b>Observer pre-buy / post-buy logic</b><br/>
                     The observer compares several snapshots of a leader over a short window (change, volume, liquidity,
                     pump score). Scores are 0-5:
                     <ul style="margin:4px 0 0 18px;">
                       <li>&lt; 3/5 → reject and staged blacklist.</li>
                       <li>≥ min threshold → allow, possibly with a recommended hold window.</li>
                     </ul>
                   </li>
                   <li><b>Leader mode (Hold Leader)</b><br/>
                     When ON, the bot:
                     <ul style="margin:4px 0 0 18px;">
                       <li>Always tries to hold a single leader.</li>
                       <li>On leader change, sells non-leaders and rotates into the new leader.</li>
                       <li>Suppresses some TP/SL/observer exits unless there is a rug/strong event.</li>
                     </ul>
                   </li>
                 </ul>
               </div>

               <div>
                 <strong>11. Final Pump Gate</strong>
                 <p style="margin:6px 0 0 0;">
                   Final Pump Gate is a last filter before buying, based on how quickly pump score improves.
                 </p>
                 <ul style="margin:6px 0 0 18px;">
                   <li><b>Min start</b> - minimum pump score where tracking begins.</li>
                   <li><b>Δscore</b> - how much pump score must increase within the gate window.</li>
                   <li><b>Window (ms)</b> - time allowed for that Δscore.</li>
                 </ul>
                 <p style="margin:6px 0 0 18px;">
                   Example: min start 2, Δscore 3, window 10-20s → only entries where score really explodes are allowed.
                 </p>
               </div>

               <div>
                 <strong>12. Dust, friction and router cooldowns</strong>
                 <ul style="margin:6px 0 0 18px;">
                   <li><b>Dust sells</b> (<b>Dust</b> select + <code>dustExitEnabled</code>)<br/>
                     If enabled, the bot:
                     <ul style="margin:4px 0 0 18px;">
                       <li>Sweeps dust at startup when it crosses a minimum notional.</li>
                       <li>Tries to sell dust on “Return”.</li>
                     </ul>
                   </li>
                   <li><b>dustMinSolOut</b><br/>
                     Minimum estimated SOL for a dust sell to be worth it.
                   </li>
                   <li><b>Router cooldown</b><br/>
                     Tokens that repeatedly fail routes (NO_ROUTE / dust errors) are put on a per-mint cooldown to avoid
                     spamming JUP.
                   </li>
                 </ul>
               </div>

               <div>
                 <strong>13. Rugs, blacklists & fast observer</strong>
                 <ul style="margin:6px 0 0 18px;">
                   <li><b>Rug detection</b><br/>
                     Severe rug signals (severity ≥ threshold) trigger immediate forced exits and a long blacklist.
                   </li>
                   <li><b>Blacklists & pump→calm bans</b><br/>
                     Problematic mints are blacklisted in stages (2 min / 15 min / 30 min). Pump→calm transitions can
                     trigger temporary bans to avoid getting trapped on the backside.
                   </li>
                   <li><b>Fast Observer (40 ms loop)</b><br/>
                     High-frequency badge and momentum sampling. Escalates to urgent sells for early severe rugs or
                     nasty pump→calm drawdowns.
                   </li>
                 </ul>
               </div>

               <div>
                 <strong>14. Stealth & sweeps</strong>
                 <ul style="margin:6px 0 0 18px;">
                   <li><b>Stealth mode</b><br/>
                     When enabled, after all positions are closed the bot can rotate SOL to a fresh auto wallet, archiving
                     the old one. This improves privacy and makes it harder to trace your session.
                   </li>
                   <li><b>Startup sweep</b><br/>
                     On start, the bot can:
                     <ul style="margin:4px 0 0 18px;">
                       <li>Sweep non-SOL positions into SOL (for sufficiently large balances).</li>
                       <li>Classify tiny leftovers as dust.</li>
                     </ul>
                   </li>
                   <li><b>End &amp; Return</b><br/>
                     Attempts to sell all tokens and dust into SOL, then sends SOL to your Recipient wallet (minus a small
                     rent buffer). Resets session stats afterward.
                   </li>
                 </ul>
               </div>

               <div>
                 <strong>15. Strategy presets (examples)</strong>
                 <p style="margin:6px 0 0 0;">
                   These are not financial advice - just starting points. Always adjust for your own risk tolerance.
                 </p>
                 <ul style="margin:6px 0 0 18px;">
                   <li><b>A. Conservative swing / warming rider</b><br/>
                     <ul style="margin:4px 0 0 18px;">
                       <li>Buy: <code>buyPct ≈ 0.15</code>, <code>minBuySol = 0.06</code>, <code>maxBuySol = 0.3-0.5</code>.</li>
                       <li>Edge: <code>minNetEdgePct ≈ -3</code>, <code>edgeSafetyBufferPct ≈ 0.25</code>,
                         <code>warmingEdgeMinExclPct ≈ -1.5</code>.</li>
                       <li>Warming: <code>rideWarming = true</code>, <code>warmingMinProfitPct ≈ 100</code>,
                         <code>decay ≈ 0.25</code>, <code>floor ≈ -2</code>, <code>autoRelease ≈ 90s</code>.</li>
                       <li>Dynamic hard stop: ON (~3-5%). Fast exit: ON (defaults).</li>
                       <li>Hold: <code>maxHoldSecs ≈ 70-90</code>, dynamic hold ON.</li>
                       <li>Final Pump Gate: enabled, minStart ≈ 2, Δscore ≈ 3, window ≈ 10-15s.</li>
                     </ul>
                   </li>
                   <li><b>B. High-frequency scalper with fast exits</b><br/>
                     <ul style="margin:4px 0 0 18px;">
                       <li>Buy: <code>buyPct ≈ 0.25-0.30</code>, <code>maxBuySol = 0.1-0.2</code>.</li>
                       <li>Edge: <code>minNetEdgePct ≈ -5</code>, <code>edgeSafetyBufferPct ≈ 0.10</code>.</li>
                       <li>Warming (optional): <code>warmingMinProfitPct ≈ 40-60</code>, higher decay (≈0.4), autoRelease ≈ 60s.</li>
                       <li>Fast Exit: tighter (hard stop 2-3%, trail arm 4-5%, trail 8-10%, TP1≈10%, TP2≈20%).</li>
                       <li>Hold: <code>maxHoldSecs ≈ 45-60</code>, dynamic hold ON.</li>
                     </ul>
                   </li>
                   <li><b>C. Leader rotation (“follow the top horse”)</b><br/>
                     <ul style="margin:4px 0 0 18px;">
                       <li><code>holdUntilLeaderSwitch = true</code>, <code>allowMultiBuy = false</code>.</li>
                       <li>Edge: <code>minNetEdgePct ≈ -2</code>, <code>edgeSafetyBufferPct ≈ 0.15</code>,
                         <code>warmingEdgeMinExclPct ≈ -0.5</code>.</li>
                       <li>Warming: more permissive (profit ≈100-150%, decay ≈0.2, autoRelease ≈120s).</li>
                       <li>Dynamic hard stop + Fast Exit both ON to protect rotations.</li>
                       <li>Final Pump Gate: moderate (minStart 1.5-2, Δscore 2-3, window 12-18s).</li>
                     </ul>
                   </li>
                   <li><b>D. Dust grinder (cleanup mode)</b><br/>
                     <ul style="margin:4px 0 0 18px;">
                       <li><code>dustExitEnabled = true</code>, <code>dustMinSolOut ≈ 0.004-0.006</code>.</li>
                       <li>Edge: allow low/negative edges for sells (e.g. <code>minNetEdgePct ≈ -6</code> or lower).</li>
                       <li>Use mainly to gradually exit many small bags and keep the wallet clean.</li>
                     </ul>
                   </li>
                 </ul>
               </div>

               <div>
                 <strong>Support, updates & community</strong>
                 <p style="margin:6px 0 0 0;">
                   • Code & issues: <a href="https://github.com/builders-toronto/fdv.lol" target="_blank">github.com/builders-toronto/fdv.lol</a><br/>
                   • Telegram (questions / help / feedback): <a href="https://t.me/fdvlolgroup" target="_blank">t.me/fdvlolgroup</a><br/>
                   • X / Twitter (updates & strategy notes): <a href="https://twitter.com/fdvlol" target="_blank">@fdvlol</a>
                 </p>
                 <p style="margin:6px 0 0 0;">
                   Following on X and joining the Telegram group is the best way to see new features, bugfixes, and suggested
                   parameter tweaks for different market conditions.
                 </p>
               </div>

               <div>
                 <strong>Disclaimer</strong>
                 <p style="margin:6px 0 0 0;">
                   This bot is provided "as is" without warranties of any kind. Trading cryptocurrencies involves substantial
                   risk, including the complete loss of your capital. Nothing here is financial advice.
                 </p>
                 <p><strong>Always size small, test first, and only trade what you can afford to lose.</strong></p>
               </div> 
             </div>
              <div data-auto-tab-panel="release" style="display:none;">
               <div>
                   <strong>Release v0.0.4.0: Edge-Aware Sizing, Warming Hold & Safety Pass</strong>
                   <ul style="margin:6px 0 0 18px;">
                     <li><b>Guide & strategy panel</b>: In-app “Guide” tab now documents all core vars (runtime, RPC, sizing, edge, TP/SL/trail, fast exit, dynamic hard stop, warming, rebound, leader mode, dust, stealth) with human-readable presets and examples.</li>
                     <li><b>Tick & backoff</b>: Tick loop hard-clamped to 1200-5000&nbsp;ms; RPC/Jupiter backoff wiring improved to slow ticks under 429/403 or stress markers while keeping UI responsive.</li>
                     <li><b>Spend ceiling & reserves</b>: Unified <code>computeSpendCeiling</code> with explicit fee reserve, per-position sell buffers, and SOL “runway”; buys never consume the last operating SOL or sell-fee buffer.</li>
                     <li><b>Friction-aware min size</b>: Buy sizing now enforces a friction-aware floor using router min, estimated tx fees, and ATA rent, with an elevated min for new ATAs; orders below this are skipped or “snapped” up based on <code>fricSnapEpsSol</code>.</li>
                     <li><b>Round-trip edge gating v2</b>: <code>estimateRoundtripEdgePct</code> computes SOL→token→SOL including platform fee, tx fee, and ATA rent, then gates on <code>pctNoOnetime</code> (excl. ATA) with <code>minNetEdgePct</code> + <code>edgeSafetyBufferPct</code>. When set, <code>warmingEdgeMinExclPct</code> overrides the base threshold for warming entries only.</li>
                     <li><b>Dynamic platform fee</b>: Sell-side fee now applies only when trades are estimated profitable and above a small-notional floor; edge logs and net exit estimators report fee and friction breakdown explicitly.</li>
                     <li><b>Min-notional & dust handling</b>: Unified <code>minSellNotionalSol()</code> for router-floor and dust decisions; remainder logic can promote partials back to positions or re-classify them as dust; router cooldowns tagged on repeated NO_ROUTE/dust failures.</li>
                     <li><b>Observer upgrades</b>: 3/5 pre-buy/post-buy logic uses short multi-sample windows, 3-tick trend series, staged blacklists, and a separate “consider” path; dynamic hold tuning adjusts <code>maxHoldSecs</code> based on observer score; 3/5 exits are debounced and combined with drawdown rules.</li>
                     <li><b>Fast Observer & rugs</b>: 40&nbsp;ms loop adds badge-transition logging, momentum drop checks, early severe-rug detection with staged blacklists, and urgent sells that respect post-buy cooldowns and warming hold where appropriate.</li>
                     <li><b>Early-fade / backside guards</b>: New early-exit layer monitors change/score slopes, chg5m regression from entry, direction changes (jiggle detection), and 5-sample downside trends to cut obvious backside legs while avoiding noisy chop.</li>
                     <li><b>Dynamic hard stop v2</b>: Per-position hard stop is computed from liquidity, v1h volume, and slopes; tuned differently for high-liq vs low-liq names; only activates after a buyer’s remorse window and bypasses warming when hit.</li>
                     <li><b>Warming engine refinements</b>: Warming uptick detector now uses 3-tick series, accel ratio vs implied 1h, zV1, buy skew and liq/volume with relaxed heuristics for strong moves; priming is tracked per-mint; “pre-pump score” normalization and prior-pre memory reduce flip-flop entries.</li>
                     <li><b>Warming hold & max-loss</b>: Warming hold computes a decaying profit requirement with floor and release window; while active, many sells are suppressed until profit meets the decayed target, but a dedicated warming max-loss guard and dynamic hard stop can still force exits.</li>
                     <li><b>Rebound gate v2</b>: Sell deferral checks per-minute slopes and a lightweight warming-style signal; maintains per-position defer windows, caps max deferral time, and logs why a defer occurred; rugs, TP, and deep losses bypass rebound.</li>
                     <li><b>Fast Exit integration</b>: Fast hard stop, fast trailing, staged TP1/TP2, timeout TP, alpha decay, trend flip and accel-drop actions are evaluated ahead of slow logic and can override normal TP/SL/trailing, with dedicated fast-exit slippage and confirm timers.</li>
                     <li><b>Leader rotation safety</b>: <code>switchToLeader</code> now validates mints, prunes invalid ones, respects router cooldowns, sells to SOL with partial remainder logic, and updates realized PnL + caches; optional stealth rotation can move SOL into a fresh auto wallet after rotations.</li>
                     <li><b>Pending-credit watchdog</b>: Buys seed optimistic positions, then reconcile via ATA balances, tx meta, and fallback owner scans; a timed watchdog retries and reconciles positions, with phantom-position pruning after grace windows.</li>
                     <li><b>Owner scan fallback & disable flag</b>: On plan-upgrade / 403/-32602 errors, owner scans are disabled and the bot falls back to local caches plus targeted ATA lookups; a user-visible reason is saved in <code>ownerScanDisabledReason</code>.</li>
                     <li><b>Startup sweeps & unwind</b>: Startup “sweep non-SOL to SOL” and “dust sweep” paths share dust/notional rules, partial-debit handling, router cooldowns, and realized-PnL accounting; “End &amp; Return” uses the same logic before sending SOL to the configured recipient.</li>
                     <li><b>Stealth wallet rotation</b>: When <code>stealthMode</code> is ON and all positions are closed, the bot can rotate SOL into a fresh auto wallet, archive the old wallet (pub/secret/tag/txSig) in <code>oldWallets</code>, and log explicit recovery info.</li>
                     <li><b>Wallet holdings UI</b>: New wallet menu shows sellable balances vs dust per mint, with live SOL and USD estimates using a short-lived quote cache; includes per-owner position/dust cache syncing and a one-click “Dump Wallet” (unwind) action.</li>
                     <li><b>Hold-time slider & dynamic hold</b>: Inline slider for <code>maxHoldSecs</code> (30-120&nbsp;s) plus ∞ checkbox to let the observer auto-tune holds based on pre-buy scores; values are persisted and logged.</li>
                     <li><b>Config schema & normalization</b>: Central <code>CONFIG_SCHEMA</code> plus <code>normalizeState</code> with min/max clamps for all user-facing fields (tick, buy %, min/max buy, edge, warming, rebound, fast exit, dynamic hard stop, final pump gate, dust, etc.), ensuring safe defaults and upgrade paths.</li>
                     <li><b>Logging & UX polish</b>: Structured logs for edge thresholds, warming decisions, rebound defers, router cooldowns, blacklist stages, stealth rotation, and money-made tracking; log panel gains an “Expand” toggle and copy utility, footer bumped to <b>Version: 0.0.4.0</b>.</li>
                     <li><b>Community & updates</b>: The in-app Guide now links directly to the codebase and support channels:<br/>
                       • GitHub: <a href="https://github.com/builders-toronto/fdv.lol" target="_blank">github.com/builders-toronto/fdv.lol</a><br/>
                       • Telegram group (help / questions): <a href="https://t.me/fdvlolgroup" target="_blank">t.me/fdvlolgroup</a><br/>
                       • X / Twitter (updates & strategy notes): <a href="https://twitter.com/fdvlol" target="_blank">@fdvlol</a>
                     </li>
                   </ul>
                 <div style="margin-top:10px;">
                   <strong>Key Advanced Concepts</strong>
                   <ul style="margin:6px 0 0 18px;">
                     <li><b>Warming decay</b>: req = max(floor, base - (decayPctPerMin * elapsedMinutes after delay)). Sell logic suppressed until req met or release window expires.</li>
                     <li><b>Rebound defer</b>: If early sell trigger and slopes / score meet gates, positions get short timed extensions; repeated defers capped by maxDeferSecs.</li>
                     <li><b>Priming</b>: Consecutive successful warming upticks counted; once count ≥ primedConsec the pump score is slightly attenuated (stability bias) but entry allowed.</li>
                     <li><b>Backside guard</b>: Accel ratio vs implied hourly extrapolation filters late flattening; prevents false warming on decay legs.</li>
                     <li><b>Edge threshold</b>: need = (badge-adjusted base or override) + safety buffer; override ignored when input blank.</li>
                   </ul>
                 </div>
                 <div style="margin-top:10px;">
                   <strong>Stability & Fixes Since 0.0.2.6</strong>
                   <ul style="margin:6px 0 0 18px;">
                     <li>Accurate edge log formatting (no negative clamp confusion; override only when provided).</li>
                     <li>Buy credit race reductions via seeded + tx meta reconciliation path.</li>
                     <li>Improved warming extension messaging and release clarity.</li>
                     <li>Refined rebound signal slope normalization (per-minute). </li>
                     <li>Safer owner scan disable detection for restricted RPC plans.</li>
                     <li>Follow us on Github for all updates and changes: <a href="https://github.com/builders-toronto/fdv.lol" target="_blank">github.com/builders-toronto/fdv.lol</a></li>
                   </ul>
                 </div>
                 <div style="margin-top:10px;">
                   <strong>Upgrade Guidance</strong>
                   <ul style="margin:6px 0 0 18px;">
                     <li>Leave warmingEdgeMinExclPct blank unless intentionally tightening friction.</li>
                     <li>Raise reboundMinScore / slopes to reduce hold churn in volatile chop.</li>
                     <li>Lower warmingDecayDelaySecs to accelerate profit requirement decay for shorter rotations.</li>
                     <li>Increase edgeSafetyBufferPct for illiquid environments to avoid borderline negative net entries.</li>
                   </ul>
                 </div>
               </div>
             </div>
            </div>
            <div style="display:flex; justify-content:space-between; gap:8px; margin-top:22px; flex-wrap:wrap;">
              <div style="display:flex; gap:8px; flex-wrap:wrap;">
                <button data-auto-sec-export>Export Wallet.json</button>
              </div>
              <button data-auto-modal-close>Close</button>
            </div>
          </div>
        </div>
  `;
}

function _isPumpingExpanded() {
  try {
    const pumpBtn = document.getElementById("pumpingToggle") || document.querySelector('button[title="PUMP"]');
    return !!pumpBtn && String(pumpBtn.getAttribute("aria-expanded") || "false") === "true";
  } catch {
    return false;
  }
}

export function wireAutoHelpModal({ wrap, openPumpKpi } = {}) {
  try {
    if (!wrap || typeof wrap.querySelector !== "function") return;
    const helpBtn = wrap.querySelector("[data-auto-help]");
    const modalEl = wrap.querySelector("[data-auto-modal]");
    if (!helpBtn || !modalEl) return;

    // Avoid double-wiring in case init runs multiple times on same DOM.
    if (modalEl.dataset.autoHelpWired === "1") return;
    modalEl.dataset.autoHelpWired = "1";

    const modalCloseEls = wrap.querySelectorAll("[data-auto-modal-close]");
    const tabBtns = modalEl.querySelectorAll("[data-auto-tab]");
    const tabPanels = modalEl.querySelectorAll("[data-auto-tab-panel]");

    function activateTab(name) {
      tabBtns.forEach((b) => {
        const on = b.getAttribute("data-auto-tab") === name;
        b.classList.toggle("active", on);
        b.style.background = on ? "#222" : "#111";
        b.style.color = on ? "#fff" : "#aaa";
      });
      tabPanels.forEach((p) => {
        p.style.display = p.getAttribute("data-auto-tab-panel") === name ? "block" : "none";
      });
    }

    tabBtns.forEach((b) =>
      b.addEventListener("click", (e) => {
        e.preventDefault();
        const name = b.getAttribute("data-auto-tab");
        activateTab(name);
      }),
    );

    activateTab("guide");

    function closeModal() {
      modalEl.style.display = "none";
      try {
        if (!_isPumpingExpanded() && typeof openPumpKpi === "function") openPumpKpi();
      } catch {}
    }

    helpBtn.addEventListener("click", () => {
      modalEl.style.display = "flex";
    });

    modalEl.addEventListener("click", (e) => {
      if (e.target === modalEl) closeModal();
    });

    modalCloseEls.forEach((btn) =>
      btn.addEventListener("click", () => {
        closeModal();
      }),
    );
  } catch {}
}
