
# Auto Trader Guide (Agent Gary edition)

If you only read one thing, read this: the Auto Trader is not "a buy button." It is a little engine that repeatedly watches a live stream of Pumping Radar leaders, filters them through a chain of safety gates, decides whether a trade is worth attempting, executes the trade through routing, and then manages the position with multiple overlapping exit systems. When you enable Agent Gary, that engine becomes fully "approval-based": the bot will still do all the measuring, quoting, and safety checks, but it will not buy unless Gary explicitly approves the buy.

This guide is written for people who want the highest-leverage setup: Agent Gary + automation, end-to-end. Manual tuning still exists (and it’s powerful), but the recommended path is to let the bot do the boring parts automatically and let the agent act as a decision layer that can veto bad entries, tune sizing and slippage, and gradually evolve its behavior from outcomes.

You’ll see a lot of controls in the UI. Don’t treat them like a cockpit where you must touch every dial before takeoff. Think of them as guardrails and "personality." The bot’s core loop is always the same; what changes is how strict it is at the gates, how it sizes trades, and how it exits.

## The mental model: what the bot is doing while it runs

When you press Start, the bot begins ticking at a configured rhythm. Each tick, it pulls (or consumes) leader data, updates any internal caches, evaluates existing positions, and decides whether it should attempt new entries. That sounds simple, but what matters is the ordering and the philosophy.

The philosophy is to avoid traps first, then optimize profit second. That’s why you’ll see gates like "no round-trip quote," "insufficient leader series," "manual edge gate," and "entry simulation gate." Those gates exist because on Solana memecoins the most common failure modes are not "I was wrong about direction," but "the route was fragile," "the token was effectively unsellable," "the liquidity was too thin for the planned order," or "fees and friction made the round-trip negative even if price moves a bit."

So the bot begins by trying to measure whether the trade is even mechanically valid, and only then does it start arguing about whether it is a good idea.

Agent Gary lives at the boundary between "mechanically valid" and "good idea." Even when Gary is enabled, the bot still refuses trades that fail hard requirements (for example, it will not proceed if it cannot compute the necessary simulation inputs). Gary is not allowed to magically buy something the bot can’t quote, or buy something with missing core data. That separation is deliberate: it keeps the agent from rationalizing trades that are impossible to execute safely.

## What Agent Gary actually is (and what he is not)

Agent Gary is an OpenAI-powered decision agent used by the Auto Trader. He does not get your private keys and cannot sign transactions. He receives a compact, precomputed "signals" object the bot produces for a candidate mint or for an active position. He responds with one thing only: a JSON decision.

For buys, Gary must return a decision whose action is either buy or skip, along with a reason and a confidence from 0 to 1. When enabled, the engine treats Gary’s response as an approval requirement: if his action is not exactly buy, the bot will not buy.

For sells, Gary can advise hold, sell_all, or sell_partial. Sells are still guarded by other safety rules (like minimum hold windows and forced safety exits). The agent is designed to reduce churn and avoid "clever" partial sells that become dust or fail minimum-notional constraints.

Gary also has a special capability that matters for automation: he may suggest small, stable adjustments to certain runtime knobs over time. These are "tune" suggestions, not a rewrite of your configuration. The bot validates and clamps these values into safe ranges, and it ignores tuning attempts that are malformed or outside allowed keys.

There is also an "evolution" feedback loop. The system can feed Gary recent realized outcomes and (optionally) allow him to attach a small self-critique/lesson object to improve future decisions. The bot stores these outcomes and uses them as context in later decisions. This is one of the reasons Agent Gary is the recommended mode: it turns your trading session into a learning loop rather than a static ruleset.

## Before you do anything: understand the two-wallet pattern

The UI shows an "Auto Wallet" and a "Recipient." This distinction is the safest way to operate.

The Auto Wallet is the dedicated trading wallet. It is the wallet that actually holds SOL while trading, signs swaps, pays ATA rent, and accumulates tokens between buys and sells. It is meant to be a burner. It should not be your vault.

The Recipient is where SOL should go when you "Return." Return is the unwind action: it’s the "get me out and send funds back" button. When you’re done with a session, you want your profits (and remaining SOL) out of the burner and into your main wallet. That main wallet should be the Recipient.

If you use Agent Gary mode, the bot may also force stealth behavior and rotate the auto wallet under certain conditions. This is not cosmetic; it’s part of minimizing linkability and keeping your operational footprint cleaner.

## The recommended automated setup, end-to-end

You can think of setup as establishing three things: infrastructure (RPC), money flow (wallet and recipient), and decision layer (Agent Gary).

Start with RPC. The bot needs a CORS-enabled Solana RPC endpoint because it runs in a browser context (unless you’re using the headless CLI pathway). If your RPC blocks certain methods or cross-origin calls, you’ll see failures during preflight or you’ll see the bot logging warnings and disabling features. The point is not "get the fastest RPC in the world," it’s "get one that reliably answers the specific calls the bot uses." A stable endpoint beats a fast-but-flaky endpoint.

If your provider requires authentication, use the RPC Headers field. This value is expected to be JSON. The bot will treat it as HTTP headers on requests to your RPC. Keep it minimal and correct; a single Authorization header is typical. Be aware that the project intentionally redacts sensitive strings in agent payloads and logs. Your RPC headers are not supposed to leak into Gary context.

Once RPC is set, create the Auto Wallet. Press Generate. Generate creates a keypair and shows you the public address in the Auto Wallet field. The bot may also publish the public auto wallet address to a public FDV ledger for telemetry purposes, but it does not publish secrets. The purpose is observability (and, depending on your build, community/leaderboard features). If you don’t want the wallet published, that’s a product-level decision, but the code is built to avoid secret leakage.

Now fund the Auto Wallet. This is intentionally manual: you send SOL to the Auto Wallet address from your main wallet or an exchange withdrawal. Give yourself enough runway not only for buys but for fees, account rent, and multiple sells. Solana memecoin trading fails in practice when people fund only the exact amount they want to "buy with," and then they cannot sell because they don’t have fees left.

Set the Recipient to your main wallet address. This is where Return sends SOL.

Set Lifetime if you want the bot to end automatically. Lifetime is essentially a session timer. A lifetime of zero means "run until I stop you." A nonzero lifetime means the bot will set an end time and will aim to stop and return when that timer expires. This matters for automation because it helps avoid forgetting a session running overnight.

Now enable Agent Gary. In the agent bar, set Agent Gary to On. Then set your risk level. Risk is not a vibe selector; it changes which gates are enforced and how strict they are. Safe and Medium enforce an entry-cost cap, which is a deliberate friction avoidance rule. Degen relaxes that particular constraint because degen mode is allowed to accept higher friction if momentum is strong, but it still cannot override hard failures like missing quotes.

Paste your OpenAI key. If Agent Gary is enabled but the key is missing, the bot will block buys. This is not a gentle warning; it is a hard refusal to trade because the bot is in "approval required" mode. People sometimes toggle Agent Gary on, forget the key, then wonder why it never buys. The bot logs that situation explicitly.

Pick your model. The model selection affects speed, cost, and decision quality. The bot will call the OpenAI chat API using the base URL you configured (defaulting to the standard endpoint), with a timeout and a small cache window. In practice, you want a model that responds quickly and consistently without timing out, because the bot’s tick loop runs frequently. If the agent call fails and approval is required, the bot will block the buy rather than guessing.

At this point, you have done the "big three": infrastructure, money flow, decision layer. Everything else is tuning. For most people, the best move is to leave advanced knobs at sane defaults, keep simulation mode on enforce, and let Gary tune slowly over time.

## A walkthrough that actually feels like using it (your first clean session)

Here is what "setting it up and executing flawlessly" looks like in real life. You are not trying to predict the market with perfect accuracy; you are trying to eliminate preventable operational mistakes so the bot can do its job without you fighting it.

You start by treating RPC like oxygen. Before you even think about strategies, you paste your RPC URL, you optionally add headers if your provider needs them, and you verify that the bot can pass the preflight check. The simplest way to do that is to press Start once with the bot otherwise idle and watch for "RPC preflight OK." If you don’t get that line, nothing else matters yet. Fix RPC first. If you get rate limited or blocked, you’ll often see the bot slow down or complain about stress; that’s a sign your endpoint is not a good fit for sustained ticks.

Once preflight is clean, you generate the Auto Wallet and immediately do one boring, high-value action: you copy the address somewhere safe so you can fund it without re-checking later. Then you fund it with enough SOL that you can survive both the buys and the sells. A "flawless" session is one where you never hit the hidden failure mode of running out of fee runway, because fee starvation makes everything look broken even when it’s not.

Next you set the Recipient. The best habit is to set Recipient before you start trading, even if you think you won’t use Return today. When something goes sideways, Return is your clean exit. Having the address pre-set is the difference between a calm unwind and a frantic copy/paste.

Then you decide what kind of automation you want and you encode that into the agent settings. If you enable Agent Gary, you paste the OpenAI key and you pick a model before you ever press Start for real. In this mode, the bot will refuse to buy without Gary’s explicit approval, and if the key is missing the bot will simply block buys. People interpret "it didn’t buy" as a strategy issue, when it’s often an "approval layer is not actually active" issue.

At this point you do a short "sanity run" where you let it tick for a minute without expecting profits. You’re watching for a few very specific signs: you want to see "Agent Gary Mode: ACTIVE" in the log; you want to see that stealth is on (and if it was off, you want to see the bot forcing it on); and you want to see the bot describing why it is skipping candidates rather than silently doing nothing. Skips are good during a sanity run because they prove the bot is receiving leader data, evaluating candidates, and applying gates.

Once you see those signs, you can treat the system as operational. Now, and only now, you start caring about the strategy knobs.

## A second walkthrough: running it hands-off without babysitting

The difference between "I started it" and "it ran smoothly while I did other things" is that hands-off mode requires you to constrain the session in time and behavior.

You begin by setting Lifetime to a value that matches your attention span. If you know you’re going to leave the screen for an hour, set lifetime to an hour. That way the session naturally ends instead of drifting into an accidental overnight run.

You keep simulation mode on enforce unless you have a very specific reason not to. Enforce mode is what keeps the bot from taking entries with insufficient samples or poor odds of reaching the gross goal. If you weaken that gate, you’re asking the bot (and Gary) to do more guesswork under low information.

You keep your manual Min Edge gate at a level that reflects your willingness to pay friction. This is subtle: it’s not "profit target," it’s "how much pain am I willing to start with." In Agent Gary safe/medium risk, there is an additional entry cost gate that will block deeply negative entries anyway; the clean way to operate is to let those gates keep you away from the worst friction.

You let the bot manage slippage dynamically. The engine will compute a slippage suggestion based on a price impact proxy, and Gary can adjust it. If you find yourself repeatedly overriding slippage manually, that’s a sign you’re fighting the automation instead of shaping it.

Finally, you get comfortable using Stop and Return as separate concepts. Stop is "pause new actions." Return is "end the session and send SOL back to Recipient." A flawless hands-off run is one where you can stop the bot, verify positions, and then unwind cleanly without guessing which button does what.

## What happens when you press Start in Agent Gary mode

Start begins with a sanity check. The bot does an RPC preflight by fetching a recent blockhash. If that fails, it disables itself and stops. This is not just politeness; it prevents you from running a hot loop against a dead or blocked endpoint.

Then the bot prepares the trading wallet context. It loads or creates the auto keypair, syncs positions from chain, and does a sweep pass that tries to clean up the wallet. The sweep steps exist because memecoin wallets accumulate odd tokens and dust. Dust can create constraints later (for example, position limits or runtime friction), so cleaning early reduces chaos.

If you have Dust enabled, the bot may run an additional dust sweep at startup.

Now the Agent Gary-specific behavior kicks in. When Agent Gary is effectively active (meaning the agent toggle is on and a key is present), the bot forces stealth mode on. If stealth was previously off, it turns it on, persists it, updates the UI, and logs that stealth is forced. It may also rotate the auto wallet once at start if stealth was off, mirroring the behavior you get when you Generate/Rotate. This matters because the most consistent automation is the one that doesn’t rely on you remembering to flip stealth.

After that, the main timer starts and the bot begins its tick loop.

You’ll also see a log line that clearly reports Agent Gary Mode as ACTIVE, INACTIVE (missing key), or OFF, along with the selected model. That line is your reality check. If it doesn’t say ACTIVE when you think you enabled Gary, you’re not in the intended mode.

## How the bot chooses what to buy (the actual pipeline, in plain English)

The bot begins with a candidate list. It pulls pumping leaders and scores, then selects trade candidates from those KPIs. The details of that selection can evolve over builds, but the intent is stable: prefer leaders that look strong in the metric stream and that are not screaming "rug."

For each candidate mint, the bot tries to decide a planned buy size based on your available SOL and your "Buy % of SOL" setting, while also respecting Min Buy and Max Buy. But it doesn’t naively spend that amount. Before finalizing the order size, it reserves SOL for fees, for account rent, and for the fact that selling also costs fees. It also tries to keep a minimum operating runway so the bot does not strand itself.

Once it has a planned order size, it runs a friction-aware minimum check. This is crucial for automation. On Solana, if your order is too small, the combination of transaction fees, swap friction, and ATA rent can dominate the trade. The bot computes a minimum per-order lamport threshold and, if your order is below that minimum, it will either "snap to min" (bump the order up) or skip, depending on how close you were and whether you can cover the bump from remaining budget. This is why you might see logs that explain a snap-to-min bump or a skip due to friction-aware minimum.

Then the bot estimates round-trip edge. This is one of the most important pieces of the entire system. It tries to approximate the net edge of going SOL to token and back to SOL, including platform fees and estimated transaction fees, and it separates out one-time ATA rent so it can reason about recurring vs one-time costs. If it cannot get a round-trip quote, it skips. That is a major honeypot avoidance measure: "no route" and "quote failure" are treated as high risk.

If an edge estimate exists, the bot applies the manual edge gate. This is your Min Edge (%) control. This gate happens before the agent sees the coin. If edgeExcl is below your minNetEdgePct threshold, the bot refuses the candidate outright. This is deliberate because edge is a first-pass sanity check; if you set it, you’re saying "don’t even waste time on entries worse than this."

If the edge passes, the bot computes an entry "cost" derived from negative edge and adds a safety buffer. That feeds into a gross TP goal. The bot’s exit logic can be dynamic, but it still needs a sense of how much the trade must move to overcome friction.

Next comes simulation gating. Simulation mode is there to prevent the bot from taking "looks good now" trades that are statistically unlikely to hit the required goal within the time horizon. The simulation depends on having enough leader series points. If the bot has fewer than three series points, it will attempt to focus and record more samples; if it still can’t reach the minimum, it skips. In enforce mode, failing the simulation is a hard skip. In warn mode, it logs the warning but may continue.

At this point, you have a candidate that is mechanically plausible: it has sufficient data, it passes edge gates, and it passes simulation requirements (or at least doesn’t violate enforce mode). Now the bot computes a dynamic slippage suggestion, based on a proxy for price impact that uses your buy size, SOL price, and estimated liquidity. This is still "pre-agent" work; it’s the bot doing math.

Only now does Agent Gary enter the picture.

## The Agent Gary buy gate: what he sees and what he can change

When Agent Gary is enabled, the bot treats his approval as required. The buy gate works like this: if the toggle is on but the key is missing, buys are blocked. If the toggle and key are present, the bot constructs a payload that includes the mint, the proposed buy size and slippage, and a rich "signals" object.

That signals object contains the risk level you selected (safe, medium, degen), the bot’s target thresholds, recent outcome summaries, KPI pick context, a "final gate" intensity signal if available, rug-signal summaries, the current leader snapshot and a compact leader series, a compact past candle series derived from pump history, edge summaries, simulation results, liquidity and SOL-USD hints, a price impact proxy, wallet budget context, and a small snapshot of any previous position in that mint.

This matters because Gary is not guessing from vibes. He is being handed the same computed facts the bot is using internally. He is told explicitly, in his system prompt, not to invent on-chain facts, to treat missing quotes and route failures as high risk, to respect minimum-hold constraints, and to avoid churn.

Gary responds with JSON. If his action is not buy, the bot vetoes the entry and logs the veto reason. If he approves, he can optionally tune the buy by reducing the SOL size (never increasing above the proposed cap) and by adjusting slippage bps. The bot clamps these and then proceeds.

Gary can also include a tune object that adjusts certain knobs like takeProfitPct, stopLossPct, trailPct, minProfitToTrailPct, minHoldSecs, maxHoldSecs, buyPct, and simulation thresholds. The driver validates those values, clamps them to safe bounds, and the bot applies them carefully to avoid flapping.

The effect, when it’s working well, is that you get a hybrid: the bot’s deterministic gates protect you from mechanical failures, and Gary’s probabilistic judgment protects you from "technically passes but probably bad" entries.

## Agent Gary on sells: what he can influence, and what he cannot override

Most people first think of Gary as a buy filter, because that’s where his behavior is the most visible: a single "buy" or "skip" is the difference between taking an entry or not. But Gary also has a sell-side role, and if you understand it you’ll get much more predictable automation.

The bot’s sell system is not a single rule; it’s a layered pipeline. There are safety exits (rug signals, pump-drop bans, urgent flags), there are profit exits (TP, trailing, partial TP logic), there are trend-protection systems (warming, rebound deferrals), and there are "don’t get trapped" mechanics (quote shock detection, edge collapse, fallback route attempts). Gary sits inside that pipeline as a decision policy that can influence the final mapping when the bot is already evaluating a sell.

In practice, that means Gary can say "hold" even when the system is leaning toward a profit-taking exit, or he can say "sell" when the system is uncertain, or he can choose between a full and partial exit. But he is not a free pass to do anything. If the bot is in a minimum-hold window, Gary is expected to hold unless the system is raising explicit safety flags. If a token is in a state that looks like a trap and the routing/quote layer is collapsing, Gary is not meant to talk you into staying; those are exactly the moments the safety policies are built for.

There are also deliberate constraints that make the automation feel less chaotic. Gary is discouraged from recommending tiny partial sells, because tiny partials often turn into dust, and dust is how automation slowly bleeds value through friction. Similarly, partial sells are generally ignored when net PnL is not positive, because that’s churn disguised as "risk management."

The key mindset is that Gary is allowed to add judgment where it matters, but the system will not let him bypass the guardrails that prevent common memecoin failure modes.

## What Gary tuning and "evolve" really mean during a session

The tune feature is intentionally narrow. Gary can suggest small changes to a limited set of knobs, and the bot will clamp them into safe ranges. If you ever feel like the bot is "changing strategies on you," that’s usually not what’s happening. What’s actually happening is that the agent is nudging one or two parameters in a conservative way based on observed outcomes, and the bot is applying those nudges in a validated, bounded form.

The evolve feature is even more conservative: it’s not a live control surface. It’s a feedback annotation that can be stored alongside outcomes so that future decisions have a memory of "what worked" and "what failed." The payoff is long-term: after enough trades, Gary has context that goes beyond the last candle and beyond your mood.

If you want flawless automation, the best way to use tune and evolve is to let them operate slowly. The bot is designed to prefer stability over flapping. Your job is not to accept every change blindly; your job is to watch the logs for a few sessions and confirm that the changes match your intent.

## Why stealth is forced on in Agent Gary mode

Stealth is not a marketing word here; it’s an operational mode. When Gary is effectively active, stealth is forced on and the UI may prevent turning it off while Gary mode is active. The system does this because the "most recommended" experience is the one where you can let the bot run without micromanaging operational hygiene. If stealth is part of the safety posture you want with an automated agent, it shouldn’t be something you can accidentally disable mid-session.

If stealth was off when you start, the bot will flip it on and may rotate the wallet once. That rotation behavior is meant to align the session with stealth assumptions before trading begins, instead of halfway through.

## How positions are managed after a buy

When a buy is executed, the bot attempts to confirm the swap and then waits for token credit to appear. If confirmation is flaky, it has a reconciliation pathway that can pull transaction metadata and reconcile the buy into accounting. This is important for automation because chain state is not always immediately consistent, especially with congested RPC providers.

Once the position is established, the bot stores a position object that includes the size, decimals, cost basis in SOL (including conservative fee and rent components), and a set of per-position fields used by exit policies. The bot also records entry context like edge metrics, warming-related metrics, and other signals.

The bot then manages the position with a layered system. Some of these layers are classic: take profit, stop loss, trailing. Others are specialized for the Pumping Radar environment: fast-exit heuristics, observer scoring, warming hold logic, rebound gating, rug/pump-drop policies, and urgent exit behavior.

It’s important to understand that these systems are not mutually exclusive; they’re competing safety and opportunity rules. In a given tick, several policies may say "sell." The bot resolves those into an actionable decision, applies cooldowns, respects minimum holds unless a forced safety trigger is present, and then executes the sell.

If you’ve enabled Leader mode, the bot behaves more like a rotator: it tries to keep you in the current leader and may sell and re-enter based on leader changes. If you allow Multi-buy, the bot may take multiple entries in a batch window, but it still obeys budgets and per-order minima.

## What "flawless execution" means (and what it doesn’t)

Flawless execution does not mean every trade wins. It means you don’t lose money to avoidable mechanics. In this bot, the avoidable mechanics are predictable: bad RPC, missing approvals, insufficient fee runway, trying to trade without enough samples, or letting an automation session run longer than your risk budget.

When the bot skips, don’t treat it like a failure. Treat it like the system doing its job. The easiest way to lose with automation is to interpret safety behavior as "it’s broken" and then relax gates until it stops being safe.

## Troubleshooting the most common "it’s not working" moments

If you press Start and it immediately stops, assume RPC is the reason until proven otherwise. The bot runs a preflight and disables itself on failure. Fix the endpoint, confirm the preflight log line, then try again.

If the bot runs but never buys in Agent Gary mode, check the log for the exact mode line. If it says INACTIVE (missing key), you are in approval-required mode without a key, and buys will be blocked. If it says OFF, the agent toggle is not enabled. If it says ACTIVE, then the system is working and you’re looking at gate behavior.

If you see repeated "no round-trip quote," that is usually routing or liquidity reality, not a cosmetic bug. It can mean the token is effectively untradable via the available routes or your slippage and sizing are incompatible with current liquidity. In those situations, the safest behavior is to skip, and the bot does.

If you see "need leader series >=3" or "sim: insufficient leader series," it means the bot is refusing to trade under low information. That can happen right after startup or when leader data is sparse. Let it run a bit longer, or ensure the environment is feeding KPIs properly.

If you see manual edge gate skips constantly, it means your Min Edge is stricter than the market can satisfy under your current order size and fee environment. The correct response is not always "lower Min Edge." Sometimes the correct response is to reduce buy size, because friction is a percentage of size and small orders get hit hardest.

If you see entry cost gate skips in safe/medium risk, that’s the bot protecting you from starting too far underwater on friction. If you truly want to accept that friction, that’s what degen risk is for, but use that consciously.

## Where the "Advanced" settings fit when you’re using Agent Gary

Advanced settings are not required to use Gary. They exist so that the deterministic safety rails match your intent, and so Gary’s decisions have a stable environment.

The warming settings control a specific style of trading: entering earlier and then allowing a hold rule that decays over time rather than immediately taking small profits. Warming min profit, floor, decay delay, and auto release shape how long the bot gives winners before it relaxes and allows exits. The max loss and window settings protect you from early violent reversals.

The rebound gate is a "don’t sell into the start of a rebound" mechanism. It can defer sells briefly if momentum is recovering. In memecoin trading, this prevents selling into the exact moment the leader re-accelerates.

The final gate settings are a last-moment filter that can be used to require certain score dynamics before entry.

Simulation mode and max entry cost are particularly important in Agent Gary mode because they define what the bot will even consider. Simulation enforce means the bot will not buy without adequate leader series and adequate probability of hitting the required goal within the horizon. Max entry cost defines a friction cap that is enforced for safe/medium risk when Gary is active, preventing entries that start too far in the hole.

In other words, Gary doesn’t replace these gates; he sits on top of them. If you set them too loose, you’re asking Gary to do more of the safety work. If you set them too strict, you may starve him of opportunities. The recommended posture is conservative mechanical gates with an agent that selectively approves.

## What you should look for in the log while running

The log is your window into why the bot did or didn’t trade. In Agent Gary mode, the most useful log patterns are the ones that explain skips and vetoes.

If you see "no round-trip quote," it means the routing/quote system could not produce a valid round trip. That is usually a hard skip for good reason.

If you see "need leader series >=3," the bot is telling you it refuses to trade without enough samples to run its simulation logic.

If you see "manual edge gate," it means your Min Edge threshold filtered the candidate before the agent was asked.

If you see "entry cost gate," it means safe/medium risk + max entry cost prevented a high-friction entry.

If you see "buy blocked (agent enabled but missing key)," you’re in approval-required mode without a key.

If you see "veto … (reason)," Gary saw the signals and decided to skip.

If you see "BUY ok … conf=…," Gary approved, potentially with a tune note showing how he adjusted slippage or size.

In other words, the log is less about "what happened" and more about "which gate did the work." Once you learn to read it, you can fix configuration problems quickly without guessing.

## Manual mode, briefly, for people who insist

If you turn Agent Gary off, the bot becomes rule-driven. It will still use edge gating, simulation gating (depending on mode), and all the exit policies, but buys will no longer require an agent approval. This can be useful if you want a purely deterministic strategy or if you cannot use an OpenAI key.

The tradeoff is that the bot will treat the thresholds as the whole truth. In memecoin markets, a small amount of "judgment" can matter: sometimes the metrics technically pass but the setup is clearly low quality when you consider the broader signal context. That’s exactly the gap Agent Gary is meant to fill.

## The point of the whole system

Automation is not about pushing more buttons faster. It’s about enforcing discipline at machine speed. The Auto Trader enforces mechanical discipline through edge checks, friction minima, simulation requirements, and careful wallet/runway accounting. Agent Gary enforces decision discipline through an explicit approval step with a reason and confidence, plus the ability to tune behavior slowly from outcomes.

If you run the bot in this recommended mode, the best workflow is simple: set infrastructure once, fund the burner, set recipient, enable Gary, pick your risk, keep simulation enforce, then let it run while you watch the log for a few minutes to confirm it’s behaving the way you expect. Once that’s stable, the highest-value "tuning" is usually not obsessing over one number, but deciding what style you want (safer and slower, or more aggressive) and expressing that through risk level and a few key gates.

