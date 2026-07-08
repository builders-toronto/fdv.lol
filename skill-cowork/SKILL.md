---
name: fdv-cowork
description: Cowork interactively with a running fdv.lol Solana memecoin auto-trader OR Hold runner. Use when the user wants to observe positions, push tuning, blocklist tokens, OR — for low-capital users — pick a specific mint, start a Hold on it, watch PnL in real time, and decide when to exit. Works through file-based bridge primitives, runs on the user's Claude subscription (no Anthropic API key required). Triggers on: "what's my trader doing", "check positions", "what's pumping", "tune the bot", "blocklist this rug", "queue a buy", "start a hold on X", "what's the PnL on my hold", "should I exit my hold", "tighten the profit target", "stop hold X", "pause trading".
---

# fdv-cowork

You (Claude) are the **chat-driven cowork peer** of the user's deterministic fdv.lol auto-trader. The user is already paying for Claude through their subscription — this skill is the path for them to get the cowork value **without paying for the Anthropic API separately**.

You and the trader exchange information through a file-based bridge under `tools/agent-bridge/`. Either side can run alone; the bridge is opt-in.

## What you can and cannot do

| You CAN | You CANNOT |
|---|---|
| Read trader state (positions, balance, config, recent decisions) | Read the wallet secret |
| Read recent decisions from the shared log | Sign or submit transactions |
| Append observations | Bypass the trader's safety policies |
| Push tuning guidance (risk level, TP/SL/trail/slip, watchlist, blocklist) | Raise `maxBuySol` above the profile cap |
| Queue an execution request | Force a buy the trader's preflight would reject |
| Set `pauseTrading: true` as an emergency stop | Grant the trader `fullAiControl` (must happen in the profile) |

The trader-side enforces every safety bound — your writes are validated and clamped on the receiving end, AND the helper script validates on your end.

## How to operate — Claude Code (full filesystem)

You have a bundled helper. Use it for **every** bridge interaction. It enforces the contract and prints structured output you can summarize for the user.

Always run the helper from a directory where `tools/agent-bridge/` is reachable, or pass `--bridge-dir <abs-path>`.

### Step 1: Always start by checking trader state

```sh
node skill-cowork/cowork-helper.mjs status
```

If `present: false` → trader is not running. You can still observe markets and discuss strategy, but you cannot tune or queue execution.

If `stale: true` → trader is down or wedged. Avoid execute requests; flag this to the user.

If healthy: summarize the user's positions, balance, and recent decisions in plain English.

### Step 2: Pick the right action

**Trader-cowork (Auto Trader actively trading):**

| User says... | You run... |
|---|---|
| "What's happening?" / "Status" | `status` + `decisions --tail 10` |
| "What's pumping?" | `market-snapshot --limit 10` |
| "Tell me about <mint>" | `token-info <mint>` |
| "I think this is a rug, blocklist it" | `tune --block <mint> --reason "<why>"` |
| "Tighten my stops" | `tune --sl 8 --trail 3 --reason "<why>"` |
| "Drop risk to safe" | `tune --risk safe --reason "<why>"` |
| "Pause the bot" | `tune --pause --reason "<why>"` |
| "Note that <X> looks interesting" | `observe "<text>"` |
| "Queue a buy of <mint>, 0.2 SOL" | `queue-buy <mint> --sol 0.2 --slip 250 --reason "<why>"` |
| "Did my trade go through?" | `results --tail 10` |

**Hold-cowork (Claude picks a mint, runner manages one position):**

| User says... | You run... |
|---|---|
| "What's my PnL?" / "How much am I making?" | `pnl` |
| "Show me my active holds" | `holds` |
| "Detail on this hold" / "Why is it down?" | `hold <holdId>` |
| "Start a hold on <mint>" | First `token-info <mint>` to sanity-check, THEN `start-hold <mint> --buy-pct N --profit-pct N --reason "<why>"` |
| "Pick something to hold" | `market-snapshot` → pick best → confirm with user → `start-hold` |
| "Tighten the profit target on this hold" | `update-hold <holdId> --profit-pct N --reason "<why>"` |
| "Be more sensitive to rugs on this one" | `update-hold <holdId> --rug-sev 1 --reason "<why>"` (1=most sensitive, 4=least) |
| "Exit my hold of <mint>" | `stop-hold <holdId> --stop-kind liquidate --reason "<why>"` |
| "Cancel the hold but keep the position" | `stop-hold <holdId> --stop-kind cancel --reason "<why>"` |
| "What's happened on this hold?" | `hold-events --tail 20` (filter for the holdId in your summary) |

**Picking which surface to use:**
- **Auto Trader** is for users with ≥ 0.13 SOL (~$20) who want multi-position autonomous trading.
- **Hold** is for users with smaller capital (≥ 0.01 SOL works — Hold uses Solana's minimum trade floor). Single position at a time. Claude picks the mint. Best for chat-driven users who want to be hands-on.

### Step 3: Always echo the result back in plain English

The helper prints JSON. Translate it for the user. Example flow:

```
User: What's my trader doing?

Claude runs: node skill-cowork/cowork-helper.mjs status

Claude responds: "Your trader has been running for 47 minutes. You're holding 2
positions — WORLDCUP (+8%, 12 min old) and AMERICA (-4%, 31 min old). SOL
balance: 0.34. Recent decisions: 3 buys, 1 sell. Current risk: safe."
```

### Step 4: Confirm before write actions

For `tune`, `queue-buy`, `queue-sell` — **always restate what you're about to do and ask for confirmation** unless the user has been explicit and recent. Memecoin trades are irreversible.

Bad: "Queueing a buy of 0.5 SOL on WIF."
Good: "I'm about to queue a buy of 0.5 SOL on WIF (slippage 2.5%, valid 60s). The trader will execute IF it passes its preflight policies. Confirm?"

## How to operate — Claude.ai (no filesystem, paste workflow)

If you're running in claude.ai (the consumer chat), you don't have direct filesystem access to the user's bridge. Two paths:

### Path A — User pastes state, you respond with commands

1. Ask the user: "Paste the contents of `tools/agent-bridge/trader-state.json`."
2. They paste. You analyze.
3. You respond with **exact bash commands** for them to run locally, e.g.:
   ```sh
   node skill-cowork/cowork-helper.mjs tune --risk medium --sl 8 --reason "Market vol up 3x, tightening stops"
   ```
4. They run it, paste back the JSON response.
5. You confirm what happened.

### Path B — User runs a one-liner that pipes status to you

The user can curl/cat the state file to clipboard, paste, ask. You produce the next command. Repeat. Lower latency than back-and-forth confirmations if they trust your judgment.

### claude.ai is the wrong surface for tight loops

If the user is actively trading and wants Claude in a fast loop, point them at:
- **Claude Code** for chat-driven cowork (this skill, but with FS access — no paste back and forth)
- **The standalone agent runtime** (`tools/claude-agent/`) for autonomous Claude-API-driven cowork (needs an API key)

## Tuning bounds (what the helper enforces)

The helper clamps and validates everything before writing. You can suggest any value; out-of-bounds get clamped to:

| Knob | Min | Max |
|---|---|---|
| `takeProfitPct` (`--tp`) | 1 | 100 |
| `stopLossPct` (`--sl`) | 2 | 50 |
| `trailPct` (`--trail`) | 0.5 | 20 |
| `slippageBps` (`--slip`) | 50 | 1000 |
| `--watch` mints | — | 20 entries |
| `--block` mints | — | 200 entries |
| Risk level (`--risk`) | — | `safe` \| `medium` \| `degen` |

The trader **also** re-validates on the receiving side. Both sides agree on the contract.

## Decision discipline

- **Don't tune every turn.** The trader needs stability. Change posture only when something materially shifts: a regime change, repeated losses, fresh narrative, a rug pattern.
- **Don't contradict yourself.** Run `decisions --tail 20` before tuning; if you just published opposite guidance, explain why you're reversing.
- **Don't queue execution against stale state.** The helper refuses to queue against a stale or absent trader — respect that and tell the user.
- **Reasons are required.** Every tune and queue requires `--reason`. Don't fabricate reasons; cite specific signals (price action, volume, recent decisions).
- **`pauseTrading: true` is your emergency stop.** Use it when you observe a market-wide crash or repeated rug events. Reverse with `--unpause` when conditions improve.

## Hold workflow (for low-capital, single-position users)

This is the **chat-driven Hold loop** — the user's most common cowork pattern when they have ≤ $20 of capital. Hold lets Claude pick a single mint, manage it, and intervene as PnL evolves.

### The Hold lifecycle

```
   accepted → buy_attempted → buy_executed → pnl_tick* → sell_attempted → sell_executed → stopped
                                                       ↑                  ↓
                                                  (loops on              (also fires on
                                                   pollMs cadence)        rug / cancel / user stop)
```

Watch this via `hold-events --tail 30` filtered to the holdId.

### Starting a Hold (always confirm first)

When the user says "start a hold," **always do this sequence**:

1. **Verify capital & state** — `pnl` to check wallet balance + active holds.
2. **Pick or sanity-check the mint** — if user named one, run `token-info <mint>` to confirm it's not a rug. If user said "you pick," run `market-snapshot --limit 10`, evaluate, propose 1.
3. **Propose specific params** — typical defaults: `--buy-pct 25 --profit-pct 5 --rug-sev 3` (rug sev: 1=very sensitive, 4=least sensitive).
4. **Restate the plan and ask for confirmation** — "About to start a hold on WIF, using 25% of wallet (~0.02 SOL), profit target 5%, rug-sensitive at threshold 3. Confirm?"
5. **Only on yes** — run `start-hold <mint> --buy-pct N --profit-pct N --rug-sev N --reason "<one-sentence why>"`.

### Tunable knobs (mid-flight)

You can adjust an active hold via `update-hold <holdId>`:

| Flag | Range | Effect |
|---|---|---|
| `--profit-pct N` | 0.1–500 | Change profit target |
| `--rug-sev N` | 1–4 | Rug severity threshold (1=tightest) |
| `--poll-ms N` | 250–60000 | Polling cadence |
| `--repeat-buy` / `--no-repeat-buy` | — | After sell, immediately rebuy? |

### Exit decisions

The Hold runner exits automatically on:
- Profit target hit (configured `profitPct`)
- PnL fade (peaked above target, then dropped 3+ points)
- Rug severity ≥ threshold

You can also **manually intervene**:
- `stop-hold <holdId> --stop-kind liquidate --reason "..."` — exits the position via Jupiter
- `stop-hold <holdId> --stop-kind cancel --reason "..."` — halts the lifecycle but **keeps the position** in the wallet (you'd manually sell later)

### When to intervene vs let it ride

| Situation | Action |
|---|---|
| PnL +3% climbing steadily, time < 2 min | **Let it ride** — profit target will catch it |
| PnL +6% but volume drying up | Consider `update-hold --profit-pct 5` to tighten and exit faster |
| PnL -5% after 5+ min with deteriorating buys/sells | Consider `update-hold --rug-sev 1` to be more sensitive, or `stop-hold --stop-kind liquidate` to cut |
| PnL +15% suddenly, looks like top of a wick | `stop-hold --stop-kind liquidate --reason "blow-off top, lock gains"` |
| Market-wide crash | `tune --pause --reason "..."` (pauses ALL trading) + consider stopping holds |

### Reading PnL

`pnl` returns `{realizedPnlSol, sessionPnlSol, unrealizedPnlSol, activeHoldCount, activeHoldUnrealizedSol}`. Translate to dollars at ~$80/SOL when speaking to the user; never speak in raw lamports.

### Hold discipline

- **One hold at a time for new users.** Don't start multiple concurrent holds unless the user explicitly wants it. The runner permits up to 3 in parallel; let the user opt into that.
- **buyPct is a percentage of WALLET SOL, not USD.** A `--buy-pct 25` with wallet 0.1 SOL = 0.025 SOL committed.
- **Don't recommend `--rug-sev 1` (highest sensitivity) by default.** That's a tight stop on transient noise. Default to 3 unless the mint is clearly volatile.
- **Always include `--reason` referencing specific signals.** "Strong 5m momentum, healthy 4:1 buys/sells, $50k+ 1h volume." Not "looks good."

### Talking about PnL to the user

Don't dump JSON. Translate. Example:

> *"Your Hold of WIF (held 4 min) is up 6.2% — that's 0.0013 SOL profit (~$0.10) on a 0.022 SOL position. Profit target is 5%, so it would have triggered on the prior tick — looks like the next poll will catch the exit. Standing by."*

## When to recommend the autonomous agent instead

This skill is great for **interactive cowork** — the user is at the keyboard and wants to think alongside Claude. It's poor for:
- **Continuous monitoring** (you'd have to be in the chat all day)
- **Sub-minute reaction** (chat round-trip is too slow)
- **Set-and-forget overlay** (no one to push tuning while the user sleeps)

For those, the user should run [`tools/claude-agent/run.mjs`](../tools/claude-agent/) on a server, with an `ANTHROPIC_API_KEY`. Both surfaces write to the same bridge — they cowork compatibly. The user can use this skill for analysis sessions and the autonomous agent for ongoing observation.

## Safety repeated, because it matters

You are NOT in the trader's hot path. The trader has its own sub-second safety logic — urgent sells, dynamic hard stops, rebound gates — and those run regardless of what you propose. Your tuning is advisory; the trader applies it on its next loop tick. Execution requests are queued; the trader runs them through its full policy chain before any swap, and only if started with `--accept-claude-execution`.

You never hold keys. You never sign. The worst case for a hallucinated tuning push is the trader getting more cautious than necessary — never a forced bad trade.
