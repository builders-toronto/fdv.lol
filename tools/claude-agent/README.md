# fdv-claude-agent

Standalone Node runtime where **Claude cowork with the fdv.lol auto-trader**. This is the strategic-overlay Claude — the one that watches markets every ~30s and pushes guidance to the deterministic trader through a file-based bridge.

**Architecture: two Claudes, three planes:**

```
                    DEV plane   .claude/skills/fdv-trader   (Claude Code; helps you edit the trader)
                    SETUP plane skill/                       (Claude Code; helps users bootstrap)
                    RUNTIME plane:
                       ┌─────────────────────┐    bridge   ┌─────────────────────┐
                       │ deterministic       │ ◄─────────► │ Claude Agent        │ ← YOU
                       │ trader (cli.mjs)    │  files in   │ runtime             │
                       │ + in-trader Claude  │ tools/      │ (this directory)    │
                       │ (Agent Gary classic)│ agent-      │                     │
                       │ — fast clock        │ bridge/     │ — slow clock        │
                       │ — owns wallet keys  │             │ — never signs       │
                       └─────────────────────┘             └─────────────────────┘
```

The two Claudes communicate **only** through five files in [`tools/agent-bridge/`](../agent-bridge/README.md) — atomic JSON writes for state and tuning, append-only JSONL for the shared decision log and execution queue/results. Either side can run alone; the bridge is opt-in on the trader side.

**Safety**: the agent never signs transactions, never holds wallet keys, never bypasses the trader's safety policies. Even `request_execute` (queue a buy/sell for the trader to consider) is gated: the trader only processes the queue when started with `--accept-claude-execution`, and re-validates every request through preflight / slippage / urgent-sell / rebound-gate policies before any swap.

---

## What it does each cycle

1. Builds a **fresh conversation** (per-cycle reset) seeded with a tiny state summary.
2. Claude calls tools in parallel — typically `get_wallet_state` + `get_market_snapshot` together.
3. Claude may follow up with `get_token_info` on the most promising mints.
4. Claude decides to: do nothing, `log_observation`, or `propose_buy` / `propose_sell`.
5. Final 1–3-sentence summary is appended to the decision log.
6. Sleep `--cycle-ms` (default 30s) and repeat.

The system prompt + tool definitions are **cached** (Anthropic prompt caching) so per-cycle cost is dominated by the small per-turn user message plus the model's tool calls and final text.

---

## Install

From this directory:

```sh
npm install
```

Only one dependency: `@anthropic-ai/sdk`.

---

## Run

```sh
node run.mjs --profile ../profiles/dev.json --log-to-console
```

Requires:

- A profile JSON with `rpc.url`, `wallet.secret` (used only to derive the pubkey for balance queries — never to sign), and one of: `ANTHROPIC_API_KEY` in env, or `agentGaryFullAi.apiKey` in the profile.

Useful flags:

| Flag | Default | Description |
|---|---|---|
| `--profile <path>` | `../profiles/dev.json` | Profile JSON to load. |
| `--model <id>` | `claude-haiku-4-5` | Also supports `claude-sonnet-4-6` and `claude-opus-4-7`. |
| `--cycle-ms <n>` | `30000` | Milliseconds between cycles (min 5000). |
| `--max-cycles <n>` | `0` (unbounded) | Stop after N cycles. Useful for smoke tests. |
| `--log-file <path>` | (none) | Append JSONL trace events to this file. |
| `--log-to-console` | off | Also print structured events to stdout. |
| `--enable-trading` | — | **Reserved.** Live trading not implemented; flag is rejected. |

### Smoke test (3 cycles, console logs)

```sh
node run.mjs --profile ../profiles/dev.json --max-cycles 3 --log-to-console
```

### Override the model

```sh
node run.mjs --profile ../profiles/dev.json --model claude-sonnet-4-6 --log-to-console
```

### Use env-var auth

```sh
ANTHROPIC_API_KEY=sk-ant-... node run.mjs --profile ../profiles/dev.json
```

---

## Tools exposed to Claude

### Market / wallet (read-only)
| Tool | Side effects | Per-cycle limit |
|---|---|---|
| `get_wallet_state` | Reads RPC for SOL balance + SPL positions | unlimited |
| `get_market_snapshot` | DexScreener top SOL-paired tokens by 5m momentum | **1** |
| `get_token_info(mint)` | DexScreener canonical pair for one mint | **3** |

### Cowork bridge (read trader state, write guidance)
| Tool | Side effects | Per-cycle limit |
|---|---|---|
| `get_trader_state` | Reads `trader-state.json` written by the running trader | unlimited |
| `publish_tuning(reason, ...)` | Writes `tuning.json` (the trader merges the safe subset on its next tick) | **1** |
| `request_execute(action, mint, ...)` | Appends to `execution-queue.jsonl` (trader processes only with `--accept-claude-execution`) | **3** |
| `get_recent_decisions` | Reads `decisions.jsonl` (both agent's and trader's decisions) | unlimited |
| `get_recent_execution_results` | Reads `execution-results.jsonl` to learn outcome of prior requests | unlimited |

### Local logging (this agent only)
| Tool | Side effects | Per-cycle limit |
|---|---|---|
| `log_observation(text)` | Appends to in-memory + agent JSONL log | unlimited |
| `propose_buy / propose_sell` | Logs intent locally. **Does NOT reach the trader.** | unlimited |

**Difference between `propose_buy` and `request_execute`:**
- `propose_buy` → recorded locally only. Useful for backtesting Claude's own judgment without touching the trader.
- `request_execute` → queued in the bridge. Trader sees it. May actually swap (gated).

Tool call budgets are enforced per cycle and reset every wake-up.

## Safety boundaries (what the agent can / cannot do)

| The agent CAN | The agent CANNOT |
|---|---|
| Read trader state | Read the wallet secret |
| Lower `riskLevel` to safe | Raise `maxBuySol` above what the trader's profile allows |
| Tighten TP/SL/trail within bounds | Grant itself `fullAiControl` |
| Add mints to `blocklist` (only restrictive) | Remove mints the trader's own policies blocked |
| Queue an execution request | Sign or submit a transaction |
| Set `pauseTrading: true` (emergency stop) | Force a buy if the trader's preflight rejects it |

Tuning knob clamps and field-level safety come from [`tools/agent-bridge/contract.mjs`](../agent-bridge/contract.mjs) — single source of truth for both sides.

---

## Architecture notes

- **Manual agentic loop** (not the beta tool runner) for control over per-cycle reset, parallel execution, and trace logging.
- **Per-cycle conversation reset** — each cycle is a discrete decision seeded with a state summary (recent proposals + recent cycle notes). Context never grows unboundedly across hours.
- **Prompt caching** — system text gets `cache_control: {type: "ephemeral"}` on its last block. Tools render before system, so the cached prefix covers both. The cache hit shows up as `cache_read_input_tokens > 0` in the per-cycle usage report.
- **Parallel tool execution** — when Claude emits multiple `tool_use` blocks in one turn, they run via `Promise.all` and all `tool_result` blocks come back in a single follow-up user message (Anthropic convention).
- **Typed errors** — uses `Anthropic.RateLimitError` / `Anthropic.InternalServerError` to drive longer back-offs on 429/5xx (instead of string-matching error messages).
- **Hard ceiling** — `MAX_TURNS_PER_CYCLE = 10` so a runaway model can't burn tokens within a single cycle.

---

## Cost shape (rough)

Per cycle on `claude-haiku-4-5`:

- System + tools (cached after first cycle): ~1500–2500 tokens at `~0.1×` read price
- Per-cycle user message: ~200–600 tokens
- Tool results: ~500–2000 tokens (depends on candidate count)
- Final assistant text + thinking: ~200–800 tokens output

Ballpark: **$0.001–0.005 per cycle** at 30s cadence — so a continuous day is ~$3–15. Switch to `--model claude-sonnet-4-6` and multiply by ~3×; `--model claude-opus-4-7` by ~5×.

If `cache_read_input_tokens` is 0 across cycles, prompt caching isn't hitting — verify the system prompt is byte-stable (no timestamps interpolated) and that tools + system render to ≥ 4096 tokens (haiku's minimum cacheable prefix).

---

## What's intentionally NOT in this iteration

- **Trader-side pickup of `execution-queue.jsonl`** — the contract is defined and the agent can queue requests, but the deterministic trader doesn't consume the queue yet. Wiring it requires careful integration with the existing safety policy chain ([src/vista/addons/auto/lib/pipeline.js](../../src/vista/addons/auto/lib/pipeline.js)) and is intentionally not rushed. See [tools/agent-bridge/README.md](../agent-bridge/README.md) → "Execution queue" for the consumer contract.
- **Trader-side state writer wired into `cli/app.js`** — the writer module ([tools/agent-bridge/cli-writer.mjs](../agent-bridge/cli-writer.mjs)) is ready; the two-line wire-in to the CLI is documented but not committed. Light-touch by design — the trader keeps working untouched if not wired.
- **No subagents, no streaming, no persistence across restarts beyond JSONL logs.** Single Claude instance per cycle is enough scope.

When you wire the trader side:
1. Add `startBridgeWriter({...})` to the CLI startup (see [agent-bridge/README.md](../agent-bridge/README.md) for the snippet).
2. Add `applyTuningIfPresent({ apply: ... })` to the trader's loop tick.
3. When you're ready for live execution, write the execution-queue consumer per the contract and gate it behind `--accept-claude-execution`.
