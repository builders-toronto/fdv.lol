# skill-cowork

**Chat-driven cowork with the fdv.lol auto-trader, using your Claude subscription.** No Anthropic API key required.

This is the second of the two distributable skills for fdv.lol:

| Skill | Purpose | API key? |
|---|---|---|
| [`skill/`](../skill/) | One-time setup: generate a burner wallet, build profile.json, start the CLI | No |
| [`skill-cowork/`](.) (this skill) | **Ongoing interactive cowork**: ask Claude to check positions, push tuning, queue trades | **No** |
| [`tools/claude-agent/`](../tools/claude-agent/) | Autonomous overlay running 24/7 alongside the trader | Yes (Anthropic API) |

The chat-driven cowork (this skill) and the autonomous agent runtime write to the **same bridge files**. You can use both simultaneously — chat for sit-down strategy sessions, autonomous for set-and-forget monitoring.

## What's in the bundle

```
skill-cowork/
├── SKILL.md            # The skill prompt — what Claude reads when this skill loads
├── cowork-helper.mjs   # Self-contained Node CLI — Claude invokes it via Bash
└── README.md           # This file
```

## How to install (Claude Code)

The skill is auto-discovered when placed in one of Claude Code's skill directories:

```sh
# Personal (all your sessions):
mkdir -p ~/.claude/skills/fdv-cowork
cp SKILL.md cowork-helper.mjs ~/.claude/skills/fdv-cowork/

# Project (this repo only):
mkdir -p .claude/skills/fdv-cowork
cp SKILL.md cowork-helper.mjs .claude/skills/fdv-cowork/
```

Then in any Claude Code session running in your fdv.lol working tree, just ask: *"What's my trader doing?"* — Claude will load the skill and run `cowork-helper.mjs status`.

## How to install (claude.ai)

claude.ai doesn't have local filesystem access, so the skill is paste-driven there:
- Install the skill via your claude.ai settings (or simply paste `SKILL.md` content as a system message)
- Ask Claude what to do
- Claude tells you the exact `node cowork-helper.mjs ...` command to run locally
- You run it, paste the JSON output back
- Claude responds

This is workable for occasional check-ins but slow for active trading — use Claude Code instead if you have it.

## How it works

The trader (`node cli.mjs --run-profile ...`) writes its current state to `tools/agent-bridge/trader-state.json` every ~3 seconds. Claude reads it, summarizes it for you, and helps you decide.

When you ask Claude to push guidance, it writes `tools/agent-bridge/tuning.json` (with all values clamped to safe bounds). The trader picks it up on its next loop tick.

When you ask Claude to queue a trade, it appends to `tools/agent-bridge/execution-queue.jsonl`. The trader processes it **only** if started with `--accept-claude-execution`, and re-validates the request through its full safety policy chain before any swap.

## Safety boundaries

| Claude (this skill) CAN | Claude CANNOT |
|---|---|
| Read trader state, decisions, results | Read the wallet secret |
| Append observations | Sign or submit transactions |
| Push tuning (risk level, TP/SL/trail/slip, watch/blocklist) within bounds | Raise `maxBuySol` above the profile cap |
| Queue execution requests | Force a buy the trader's preflight rejects |
| Set `pauseTrading: true` (emergency stop) | Grant the trader `fullAiControl` |

The helper enforces validation on the write side. The trader re-validates on the read side. Both agree on the contract defined in [`tools/agent-bridge/contract.mjs`](../tools/agent-bridge/contract.mjs).

## Helper reference

The helper is the only API surface Claude uses. All commands print structured JSON for Claude to parse.

| Command | Purpose |
|---|---|
| `status` | Current trader state + freshness check |
| `decisions [--tail N]` | Recent decisions from shared log |
| `results [--tail N]` | Recent execution outcomes |
| `market-snapshot [--limit N]` | Top trending Solana tokens (DexScreener) |
| `token-info <mint>` | Drill-down on a specific token |
| `observe "<text>"` | Append observation to decision log |
| `tune --reason "<text>" [opts]` | Push tuning (see flags below) |
| `queue-buy <mint> --sol N --slip N --reason "..."` | Queue a buy |
| `queue-sell <mint> --frac N --slip N --reason "..."` | Queue a sell |

### Tune flags

- `--risk safe|medium|degen`
- `--tp <pct>` — takeProfitPct (1–100)
- `--sl <pct>` — stopLossPct (2–50)
- `--trail <pct>` — trailPct (0.5–20)
- `--slip <bps>` — slippageBps (50–1000)
- `--watch <mint>` (repeatable, max 20)
- `--block <mint>` (repeatable, max 200)
- `--pause` / `--unpause`
- `--reason "<text>"` (required)

### Common one-liners

```sh
# What's happening?
node cowork-helper.mjs status

# Tighten stops because vol just spiked
node cowork-helper.mjs tune --sl 8 --trail 3 --reason "1h vol up 4x, tightening stops"

# Blocklist a suspected honeypot
node cowork-helper.mjs tune --block <mint> --reason "Liquidity pulled twice in 5m, classic honeypot pattern"

# Emergency pause
node cowork-helper.mjs tune --pause --reason "Solana RPC instability cascading"

# Queue a buy with strong conviction
node cowork-helper.mjs queue-buy <mint> --sol 0.3 --slip 250 --reason "30% breakout on 4x volume, healthy buys/sells ratio"

# Did my queued trade go through?
node cowork-helper.mjs results --tail 5
```

## Requirements

- **Node.js ≥ 18** (uses `fetch`)
- **A running trader** (most commands) — start with `node cli.mjs --run-profile tools/profiles/dev.json`
- **Network access** to DexScreener (for `market-snapshot` and `token-info`)

The helper has **zero npm dependencies**. It's a single self-contained file.
