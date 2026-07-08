# agent-bridge — Cowork contract between the trader and the Claude Agent

This directory is the **single shared surface** between two independent processes:

- The **deterministic trader** (`node cli.mjs --run-profile ...`) — executes swaps, manages positions, has the safety policies.
- The **standalone Claude Agent runtime** ([tools/claude-agent/run.mjs](../claude-agent/run.mjs)) — observes, tunes, proposes, requests.

Neither imports the other. They communicate **only through files in this directory**, all gitignored.

```
┌────────────────────────┐                  ┌─────────────────────────┐
│ Deterministic trader   │                  │ Claude Agent runtime    │
│ (node cli.mjs)         │                  │ (tools/claude-agent)    │
│                        │                  │                         │
│ writes ─►              │                  │           ◄─ reads      │
│   trader-state.json    │ ────────────────►│                         │
│                        │                  │                         │
│           ◄─ reads     │ ◄────────────────│              ─► writes  │
│   tuning.json          │                  │                         │
│                        │                  │                         │
│ both append ─►         │                  │              ─► both    │
│   decisions.jsonl      │ ◄───────────────►│              append     │
│                        │                  │                         │
│           ◄─ consumes  │ ◄────────────────│              ─► queues  │
│   execution-queue.jsonl│                  │                         │
│                        │                  │                         │
│ writes ─►              │                  │           ◄─ reads      │
│   execution-results.jsonl ──────────────► │                         │
└────────────────────────┘                  └─────────────────────────┘
```

## Files

| File | Direction | Format | Cadence |
|---|---|---|---|
| `trader-state.json` | trader → agent | JSON (overwritten atomically) | Trader writes every ~3s |
| `tuning.json` | agent → trader | JSON (overwritten atomically) | Agent writes when posture changes |
| `decisions.jsonl` | both → both | JSONL (append-only) | Both write per decision |
| `execution-queue.jsonl` | agent → trader | JSONL (append-only) | Agent appends per execute request |
| `execution-results.jsonl` | trader → agent | JSONL (append-only) | Trader appends per request processed |

All shapes, field names, paths, and safety bounds are defined in [contract.mjs](contract.mjs). **Change the contract in one place and both sides update.**

## Safety model

The contract is designed so that **the Claude Agent cannot make the trader do anything the trader's own safety policies would block.**

| What the agent can do | What the trader still controls |
|---|---|
| Lower `riskLevel` to `safe` | `maxBuySol` floor (always ≥ 1) |
| Tighten TP/SL/trail (within bounds in `TUNING_KNOB_BOUNDS`) | Whether to honor any tuning at all (off by default) |
| Add to `blocklist` (only restrictive) | Whether to take an execution request (only if `--accept-claude-execution`) |
| Queue a buy/sell `request_execute` | Whether to execute it (after preflight, slippage, urgent-sell, rebound-gate policies all pass) |
| Set `pauseTrading: true` | Wallet keys — the agent never holds them |

The agent **never** signs a transaction. The agent **never** submits to Solana. Every swap path stays inside the trader, with the trader's existing safety logic.

## How to wire the trader-side into your CLI

Two-line integration in the trader's CLI loop (see [tools/agent-bridge/cli-writer.mjs](cli-writer.mjs) for the API):

```js
import { startBridgeWriter, applyTuningIfPresent, appendTraderDecision } from "../../../tools/agent-bridge/cli-writer.mjs";

// 1. Periodic state publisher (call once at trader startup).
const stopBridge = startBridgeWriter({
    intervalMs: 3000,
    getState: () => ({
        pubkey: walletPubkey,
        solBalance: lamportsToSol(currentSolLamports),
        positions: enumeratePositions(),        // [{mint, symbol, sizeUi, costSol, openedAtMs, currentPnlPct, ageSecs}]
        config: { riskLevel, takeProfitPct, stopLossPct, trailPct, slippageBps, maxBuySol },
        recentDecisions: recentRingBuffer.slice(-20),
        pauseTrading: state.pauseTrading || false,
        errorRate1m: errorTracker.rate(),
        rpcBackoffMs: rpc.currentBackoff(),
    }),
});

// 2. On each trader loop tick, optionally pick up tuning.
await applyTuningIfPresent({
    apply: async (safeTuning) => {
        // safeTuning fields are pre-clamped: riskLevel ∈ {safe,medium,degen},
        // knobs within bounds, watchlist/blocklist length-limited, etc.
        if (safeTuning.riskLevel) state.riskLevel = safeTuning.riskLevel;
        if (safeTuning.knobs) Object.assign(state, safeTuning.knobs);
        if (safeTuning.blocklist) state.mintBlocklist = new Set(safeTuning.blocklist);
        if (safeTuning.watchlist) state.mintWatchlist = new Set(safeTuning.watchlist);
        if (safeTuning.pauseTrading != null) state.pauseTrading = safeTuning.pauseTrading;
        await appendTraderDecision({
            kind: "tuning_applied",
            payload: { version: safeTuning.version, fields: Object.keys(safeTuning) },
        });
    },
});

// 3. Optionally append the trader's own Agent Gary decisions for cross-process visibility.
await appendTraderDecision({
    kind: "buy_executed",
    payload: { mint, sizeSol, txSig, reason },
});

// 4. Clean shutdown.
process.on("SIGINT", () => { stopBridge(); /* ... */ });
```

This is intentionally a **light-touch integration** — the trader keeps working perfectly if these lines are not added. The bridge is opt-in.

## Execution queue (NOT yet wired)

The agent can call `request_execute` to queue a buy/sell. The trader-side consumer is **deliberately not implemented in this iteration** because routing requests through the existing trader's swap pipeline requires careful integration with its safety policies (preflight, slippage adjustment, rebound gate, etc.) — exactly the work that should never be done in a rush.

When you're ready to enable it, the trader-side consumer must:

1. Be gated behind an explicit `--accept-claude-execution` CLI flag (off by default).
2. Read `execution-queue.jsonl`, skip entries with `expiresAt < now()` or `contractVersion !== 1`.
3. For each unexpired entry, run it through the SAME policy chain as the trader's own buy/sell decisions ([src/vista/addons/auto/lib/pipeline.js](../../src/vista/addons/auto/lib/pipeline.js)). Use `buildExecutionResultLine` from contract.mjs to write outcomes.
4. Mark each entry as processed (e.g. by tracking processed IDs in an internal set, or by truncating the queue file periodically).
5. Append an entry to `execution-results.jsonl` for every request you saw, with one of these outcomes:
    - `executed` — swap succeeded, include `txSig`, `appliedBps`, `executedSol`
    - `rejected` — request failed validation (bad mint, position not held, etc.)
    - `expired` — TTL elapsed before processing
    - `policy_blocked` — safety policy rejected it (note which one in `notes`)

The agent reads `execution-results.jsonl` via `get_recent_execution_results` and learns whether its requests landed.

## What's gitignored

- `trader-state.json`, `tuning.json`, `*.jsonl` — runtime data, may contain position info
- Everything in this dir is gitignored EXCEPT: `README.md`, `contract.mjs`, `cli-writer.mjs`

See [.gitignore](../../.gitignore) for the explicit allowlist.
