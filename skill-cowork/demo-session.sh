#!/usr/bin/env bash
# Demo: walk through a realistic Claude cowork session against a running mock trader.
# Each phase shows: user question → command run → JSON output → Claude's English summary.
set -e
cd "$(dirname "$0")/.."

# Clean slate
rm -f tools/agent-bridge/*.json tools/agent-bridge/*.jsonl

# Start mock trader in the same shell session
node tools/agent-bridge/mock-trader.mjs 90 > /tmp/mock-demo.log 2>&1 &
MOCK_PID=$!
sleep 2

show_user()    { echo ""; echo "─────────────────────────────────────────────────────────"; echo "USER: $1"; echo "─────────────────────────────────────────────────────────"; }
show_cmd()     { echo ""; echo "▶ $1"; }
show_claude()  { echo ""; echo "CLAUDE: $1"; }

# ════════════════════════════════════════════════════════════════════════
show_user "What's my trader doing right now?"
show_cmd "node skill-cowork/cowork-helper.mjs status"
STATUS=$(node skill-cowork/cowork-helper.mjs status)
echo "$STATUS" | head -30
SUMMARY=$(echo "$STATUS" | python3 -c "
import sys, json
d = json.load(sys.stdin)
if not d['present']: print('Trader not running.'); sys.exit()
s = d['state']
positions_str = ', '.join(f\"{p['symbol']} ({p['currentPnlPct']:+.1f}%, {p['ageSecs']}s old)\" for p in s['positions'])
print(f\"Trader is up. Wallet: {s['solBalance']} SOL. \"
      f\"Holding {len(s['positions'])} positions: {positions_str}. \"
      f\"Risk={s['config']['riskLevel']}, TP={s['config']['takeProfitPct']}%, SL={s['config']['stopLossPct']}%. \"
      f\"State age {d['ageMs']}ms ({'stale!' if d['stale'] else 'fresh'}).\")
")
show_claude "$SUMMARY"

# ════════════════════════════════════════════════════════════════════════
show_user "What's pumping right now? Anything interesting?"
show_cmd "node skill-cowork/cowork-helper.mjs market-snapshot --limit 5"
MARKET=$(node skill-cowork/cowork-helper.mjs market-snapshot --limit 5)
echo "$MARKET" | head -40
SUMMARY=$(echo "$MARKET" | python3 -c "
import sys, json
d = json.load(sys.stdin)
cands = d.get('candidates') or []
if not cands: print('Nothing meets my filter right now.'); sys.exit()
top = cands[0]
others = ', '.join(f\"{c['symbol']} ({c['priceChange5m']:+.1f}%)\" for c in cands[1:3])
print(f\"Top candidate: {top['symbol']} — \"
      f\"5m {top['priceChange5m']:+.1f}%, liq \${int(top['liquidityUsd'])}, vol1h \${int(top['volumeUsd1h'])}, \"
      f\"buys/sells {top['buys5m']}/{top['sells5m']}. \"
      f\"Other movers: {others}. \"
      f\"Mint: {top['mint']}\")
")
show_claude "$SUMMARY"

# Capture top mint for the next phase
TOP_MINT=$(echo "$MARKET" | python3 -c "import sys, json; d=json.load(sys.stdin); print((d.get('candidates') or [{}])[0].get('mint',''))")

# ════════════════════════════════════════════════════════════════════════
if [ -n "$TOP_MINT" ]; then
show_user "Drill into that top one — is it for real or is this fake volume?"
show_cmd "node skill-cowork/cowork-helper.mjs token-info $TOP_MINT"
INFO=$(node skill-cowork/cowork-helper.mjs token-info "$TOP_MINT")
echo "$INFO" | head -25
SUMMARY=$(echo "$INFO" | python3 -c "
import sys, json
d = json.load(sys.stdin)
if not d.get('found'): print('Not found on DexScreener Solana pairs.'); sys.exit()
ratio = (d['buys5m'] / d['sells5m']) if d['sells5m'] else float('inf')
verdict = 'looks real' if ratio > 1.2 and d['liquidityUsd'] > 20000 else 'caution — weak signals'
print(f\"{d['symbol']} ({verdict}): price \${d['priceUsd']:.6f}, liq \${int(d['liquidityUsd'])}, FDV \${int(d.get('fdvUsd') or 0)}, \"
      f\"5m {d['priceChange5m']:+.1f}%, 1h {d['priceChange1h']:+.1f}%, 24h {d['priceChange24h']:+.1f}%. \"
      f\"24h volume \${int(d['volumeUsd24h'])}. Buys/sells 5m: {d['buys5m']}/{d['sells5m']} (ratio {ratio:.2f}).\")
")
show_claude "$SUMMARY"
fi

# ════════════════════════════════════════════════════════════════════════
show_user "Vol's been crazy today. Tighten my stops and trail more aggressively."
show_cmd 'node skill-cowork/cowork-helper.mjs tune --sl 8 --trail 3 --reason "Vol elevated, tightening defensive stops"'
TUNE=$(node skill-cowork/cowork-helper.mjs tune --sl 8 --trail 3 --reason "Vol elevated, tightening defensive stops")
echo "$TUNE" | head -20
SUMMARY=$(echo "$TUNE" | python3 -c "
import sys, json
d = json.load(sys.stdin)
t = d['tuning']
print(f\"Published tuning v{t['version']}: SL {t['knobs'].get('stopLossPct')}%, trail {t['knobs'].get('trailPct')}%. \"
      f\"The trader will pick this up on its next loop tick (~1-3s).\")
")
show_claude "$SUMMARY"

# Wait for trader to apply
sleep 3

# ════════════════════════════════════════════════════════════════════════
show_user "Did the trader actually pick that up?"
show_cmd "node skill-cowork/cowork-helper.mjs status"
STATUS2=$(node skill-cowork/cowork-helper.mjs status)
CFG=$(echo "$STATUS2" | python3 -c "import sys, json; c=json.load(sys.stdin)['state']['config']; print(json.dumps({'stopLossPct':c['stopLossPct'],'trailPct':c['trailPct']}))")
echo "Config now: $CFG"
SUMMARY=$(echo "$STATUS2" | python3 -c "
import sys, json
c = json.load(sys.stdin)['state']['config']
applied = c['stopLossPct'] == 8 and c['trailPct'] == 3
print(f\"{'Yes — trader applied it.' if applied else 'Not yet, give it another moment.'} \"
      f\"Current: SL {c['stopLossPct']}%, trail {c['trailPct']}%, TP {c['takeProfitPct']}% (unchanged), risk {c['riskLevel']} (unchanged).\")
")
show_claude "$SUMMARY"

# ════════════════════════════════════════════════════════════════════════
if [ -n "$TOP_MINT" ]; then
show_user "Queue a small buy of that top one — 0.1 SOL. Just to test the queue path."
show_cmd "node skill-cowork/cowork-helper.mjs queue-buy $TOP_MINT --sol 0.1 --slip 250 --reason \"Test queue — small position on top boosted candidate\""
QUEUE=$(node skill-cowork/cowork-helper.mjs queue-buy "$TOP_MINT" --sol 0.1 --slip 250 --reason "Test queue — small position on top boosted candidate")
echo "$QUEUE" | head -20
SUMMARY=$(echo "$QUEUE" | python3 -c "
import sys, json
d = json.load(sys.stdin)
q = d['queued']
print(f\"Queued request {q['id']}. Action: buy {q['sizeSol']} SOL of {q['mint'][:8]}…, slip {q['slippageBps']}bps, TTL {q['ttlSecs']}s. \"
      f\"\\nIMPORTANT: this is in the queue file. The deterministic trader will only execute it if (a) it was started with --accept-claude-execution, and (b) its preflight + slippage + urgent-sell policies all approve. \"
      f\"In our current setup, the trader-side queue consumer isn't wired yet, so this request will just expire after {q['ttlSecs']}s. Check `results --tail` once that's wired.\")
")
show_claude "$SUMMARY"
fi

# ════════════════════════════════════════════════════════════════════════
show_user "Show me everything that happened this session."
show_cmd "node skill-cowork/cowork-helper.mjs decisions --tail 20"
DECISIONS=$(node skill-cowork/cowork-helper.mjs decisions --tail 20)
echo "$DECISIONS" | head -50
SUMMARY=$(echo "$DECISIONS" | python3 -c "
import sys, json
d = json.load(sys.stdin)
counts = {}
for e in d['entries']:
    k = f\"{e['source']}/{e['kind']}\"
    counts[k] = counts.get(k, 0) + 1
print(f\"{d['count']} entries total in the shared log:\")
for k in sorted(counts): print(f\"  {counts[k]:>2}× {k}\")
print(f\"\\nBoth sides — agent-runtime (me, the chat) and trader-gary (the deterministic bot) — show up in the same log. That's the cowork audit trail.\")
")
show_claude "$SUMMARY"

# ════════════════════════════════════════════════════════════════════════
# Cleanup
wait $MOCK_PID 2>/dev/null || true
rm -f tools/agent-bridge/*.json tools/agent-bridge/*.jsonl
echo ""
echo "═════════════════════════════════════════════════════════"
echo "Demo complete. Mock trader stopped, bridge files cleaned."
