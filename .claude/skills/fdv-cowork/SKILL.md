---
name: fdv-cowork
description: Use when the user wants to interactively cowork with a running fdv.lol auto-trader from inside Claude Code — observe positions, push tuning, queue execution, look at the live market — using their Claude subscription rather than the standalone Anthropic-API-driven agent runtime. Triggers on: "what's my trader doing", "check positions", "should I exit X", "what's pumping", "tune the bot", "pause trading", "queue a buy of X", "blocklist this rug", "review recent decisions".
---

# fdv-cowork (in-repo)

This skill activates when working in the fdv.lol repo. It's the **chat-driven cowork** mode — Claude reads/writes the bridge files directly, no Anthropic API key needed (you're already on a Claude subscription).

For the full skill body, see [skill-cowork/SKILL.md](../../../skill-cowork/SKILL.md) — it's the same skill, just packaged for distribution. The instructions below are the in-repo specifics.

## Where the bridge lives

In this repo, the bridge files are at:
- `tools/agent-bridge/trader-state.json` — written by the running trader
- `tools/agent-bridge/tuning.json` — written by you (or the autonomous agent)
- `tools/agent-bridge/decisions.jsonl` — append-only, both sides write
- `tools/agent-bridge/execution-queue.jsonl` — you append, trader consumes (gated)
- `tools/agent-bridge/execution-results.jsonl` — trader appends, you read

Always check existence + freshness first with the helper before acting:

```sh
node skill-cowork/cowork-helper.mjs status
```

If the helper reports `present: false`, the user's trader isn't running. Tell them they need to start it (`node cli.mjs --run-profile tools/profiles/dev.json` from the repo root). You can still observe markets (`node skill-cowork/cowork-helper.mjs market-snapshot`) without the trader running.

## The autonomous agent companion

This repo also contains [tools/claude-agent/](../../../tools/claude-agent/) — the autonomous Claude-API-driven agent. It writes to the **same bridge files** as you. If both you (chat) and the agent (API) are running, you'll see each other's decisions in the decisions log (`source: "agent-runtime"` for both — chat-Claude and API-Claude are indistinguishable in the log because they're functionally the same peer).

## Common-tasks quick reference

```sh
# Read (trader cowork)
node skill-cowork/cowork-helper.mjs status
node skill-cowork/cowork-helper.mjs decisions --tail 20
node skill-cowork/cowork-helper.mjs results --tail 10
node skill-cowork/cowork-helper.mjs market-snapshot --limit 10
node skill-cowork/cowork-helper.mjs token-info <mint>

# Read (Hold + PnL)
node skill-cowork/cowork-helper.mjs pnl
node skill-cowork/cowork-helper.mjs holds
node skill-cowork/cowork-helper.mjs hold <holdId>
node skill-cowork/cowork-helper.mjs hold-events --tail 30

# Write — trader (always include a --reason)
node skill-cowork/cowork-helper.mjs observe "<text>"
node skill-cowork/cowork-helper.mjs tune --risk medium --sl 8 --reason "Vol up 3x"
node skill-cowork/cowork-helper.mjs tune --block <mint> --reason "Honeypot pattern"
node skill-cowork/cowork-helper.mjs tune --pause --reason "Wide market crash"
node skill-cowork/cowork-helper.mjs queue-buy <mint> --sol 0.2 --slip 250 --reason "<why>"
node skill-cowork/cowork-helper.mjs queue-sell <mint> --frac 0.5 --slip 250 --reason "<why>"

# Write — Hold (always include a --reason; always confirm with user first)
node skill-cowork/cowork-helper.mjs start-hold <mint> --buy-pct 25 --profit-pct 5 --rug-sev 3 --reason "<why>"
node skill-cowork/cowork-helper.mjs update-hold <holdId> --profit-pct 8 --reason "<why>"
node skill-cowork/cowork-helper.mjs stop-hold <holdId> --stop-kind liquidate --reason "<why>"
```

## Hold runner status in this repo

Two runners exist:

1. **Mock Hold runner** (`tools/agent-bridge/mock-hold-runner.mjs`) — simulates the full Hold lifecycle without touching Jupiter or real funds. Use for testing the chat-driven flow safely.
2. **Real Hold runner** — TODO. The contract is in place; the implementation wires `createHoldBotInstance` from `src/vista/addons/auto/hold/index.js` to the bridge. Until shipped, all real-money Hold cowork goes through the existing CLI (`node cli.mjs --run-profile ...` + UI).

For tuning bounds, safety semantics, full Hold workflow, and the user-facing operating model, follow [skill-cowork/SKILL.md](../../../skill-cowork/SKILL.md).
