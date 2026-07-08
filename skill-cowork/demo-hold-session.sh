#!/usr/bin/env bash
# Demo: chat-driven Hold workflow against the mock Hold runner. Walks through
# a realistic Claude cowork session for someone with low capital who wants
# Claude to pick a mint, manage the position, and respond to PnL evolution.
set -e
cd "$(dirname "$0")/.."

rm -f tools/agent-bridge/*.json tools/agent-bridge/*.jsonl

# Spin up the mock Hold runner. 45s window covers the full demo.
node tools/agent-bridge/mock-hold-runner.mjs --duration-sec 45 > /tmp/mock-hold-runner.log 2>&1 &
RUNNER_PID=$!
sleep 2

show_user()    { echo ""; echo "─────────────────────────────────────────────────────────"; echo "USER: $1"; echo "─────────────────────────────────────────────────────────"; }
show_cmd()     { echo ""; echo "▶ $1"; }
show_claude()  { echo ""; echo "CLAUDE: $1"; }

# ════════════════════════════════════════════════════════════════════════
show_user "What's my PnL? Anything running?"
show_cmd "node skill-cowork/cowork-helper.mjs pnl"
PNL=$(node skill-cowork/cowork-helper.mjs pnl)
echo "$PNL" | head -15
SUMMARY=$(echo "$PNL" | python3 -c "
import sys, json
d = json.load(sys.stdin)
if not d.get('present'): print('No runner active.'); sys.exit()
print(f\"Hold runner is up. Wallet: {d['solBalance']:.4f} SOL. Realized PnL: {d['realizedPnlSol']:+.6f} SOL. Unrealized: {d['unrealizedPnlSol']:+.6f}. Active holds: {d['activeHoldCount']}.\")
")
show_claude "$SUMMARY"

# ════════════════════════════════════════════════════════════════════════
show_user "Start a hold for me. Pick something — small, ~25% of wallet, conservative 4% profit target."
show_cmd "node skill-cowork/cowork-helper.mjs start-hold 7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU --buy-pct 25 --profit-pct 4 --rug-sev 3 --reason \"Conservative test hold per user direction; small size, 4% target\""
START=$(node skill-cowork/cowork-helper.mjs start-hold 7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU --buy-pct 25 --profit-pct 4 --rug-sev 3 --reason "Conservative test hold per user direction; small size, 4% target")
echo "$START" | head -25
QID=$(echo "$START" | python3 -c "import sys, json; print(json.load(sys.stdin)['queued']['id'])")
show_claude "Queued hold request $QID. The runner will accept it within a poll cycle (~500ms), then start the buy phase. Watching for buy_executed..."

# Give the runner time to: pick up request, attempt buy, execute, start polling
sleep 4

# ════════════════════════════════════════════════════════════════════════
show_user "OK what's happening now?"
show_cmd "node skill-cowork/cowork-helper.mjs holds"
HOLDS=$(node skill-cowork/cowork-helper.mjs holds)
echo "$HOLDS" | head -30
HID=$(echo "$HOLDS" | python3 -c "import sys, json; d=json.load(sys.stdin); print((d.get('holds') or [{}])[0].get('holdId',''))")
SUMMARY=$(echo "$HOLDS" | python3 -c "
import sys, json
d = json.load(sys.stdin)
holds = d.get('holds') or []
if not holds: print('No active holds yet — buy may still be in flight.'); sys.exit()
h = holds[0]
print(f\"Hold {h['holdId'][:14]}…: status={h['status']}, cost={h['costSol']:.6f} SOL, current PnL={h['currentPnlPct']:+.2f}% ({h['currentPnlSol']:+.6f} SOL), age={h['ageSecs']}s, profit target={h['profitTargetPct']}%.\")
")
show_claude "$SUMMARY"

# Let PnL random-walk for a few ticks
sleep 6

# ════════════════════════════════════════════════════════════════════════
show_user "Show me the lifecycle events so far."
show_cmd "node skill-cowork/cowork-helper.mjs hold-events --tail 15"
EVENTS=$(node skill-cowork/cowork-helper.mjs hold-events --tail 15)
echo "$EVENTS" | python3 -c "
import sys, json
d = json.load(sys.stdin)
entries = d.get('entries') or []
print(f\"{d['count']} events:\")
for e in entries[-12:]:
    extra = ''
    if e['kind'] == 'pnl_tick':
        extra = f\" pnl={e.get('pnlPct',0):+.2f}% est={e.get('estOutSol',0):.6f}\"
    elif e['kind'] == 'buy_executed':
        extra = f\" cost={e.get('costSol',0):.6f} sizeUi={e.get('sizeUi',0)}\"
    elif e['kind'] == 'sell_executed':
        extra = f\" proceeds={e.get('proceedsSol',0):.6f} realized={e.get('realizedPnlSol',0):+.6f}\"
    print(f\"  {e['kind']:18}{extra}\")
"
show_claude "Lifecycle progressing normally — accepted → buy_attempted → buy_executed → repeated pnl_ticks as the runner polls."

# ════════════════════════════════════════════════════════════════════════
show_user "Tighten the profit target — exit at +2% instead of waiting for 4%."
show_cmd "node skill-cowork/cowork-helper.mjs update-hold $HID --profit-pct 2 --reason \"User wants faster exit; tighter target\""
UPDATE=$(node skill-cowork/cowork-helper.mjs update-hold "$HID" --profit-pct 2 --reason "User wants faster exit; tighter target")
echo "$UPDATE" | head -15
show_claude "Update queued. The runner will apply on its next poll. Target moves from 4% → 2%, so the next time PnL crosses +2% it'll exit."

# Let runner apply update + a few more ticks
sleep 8

# ════════════════════════════════════════════════════════════════════════
show_user "What's the status now?"
show_cmd "node skill-cowork/cowork-helper.mjs hold $HID"
HOLD2=$(node skill-cowork/cowork-helper.mjs hold "$HID")
echo "$HOLD2" | head -40
STATUS=$(echo "$HOLD2" | python3 -c "
import sys, json
d = json.load(sys.stdin)
h = d.get('hold') or {}
events = d.get('recentEvents') or []
print(f\"Status: {h.get('status')}, current PnL: {h.get('currentPnlPct',0):+.2f}%, peak PnL: {h.get('peakPnlPct',0):+.2f}%, profit target: {h.get('profitTargetPct')}%, age: {h.get('ageSecs')}s.\")
print(f\"Last {len(events)} events for this hold: {[e['kind'] for e in events]}\")
")
show_claude "$STATUS"

# ════════════════════════════════════════════════════════════════════════
show_user "If it hasn't exited yet, just liquidate it. I want to lock whatever we have."
show_cmd "node skill-cowork/cowork-helper.mjs stop-hold $HID --stop-kind liquidate --reason \"User locking gains regardless of target\""
STOP=$(node skill-cowork/cowork-helper.mjs stop-hold "$HID" --stop-kind liquidate --reason "User locking gains regardless of target")
echo "$STOP" | head -15
show_claude "Stop queued. Runner will sell at current quote on the next poll."

# Give time for sell_executed + stopped
sleep 4

# ════════════════════════════════════════════════════════════════════════
show_user "Final PnL?"
show_cmd "node skill-cowork/cowork-helper.mjs pnl"
FINAL_PNL=$(node skill-cowork/cowork-helper.mjs pnl)
echo "$FINAL_PNL" | head -15
SUMMARY=$(echo "$FINAL_PNL" | python3 -c "
import sys, json
d = json.load(sys.stdin)
print(f\"Realized PnL this session: {d['realizedPnlSol']:+.6f} SOL. Wallet now {d['solBalance']:.4f} SOL. Active holds: {d['activeHoldCount']}.\")
")
show_claude "$SUMMARY"

show_cmd "node skill-cowork/cowork-helper.mjs hold-events --tail 30 | (final lifecycle events)"
node skill-cowork/cowork-helper.mjs hold-events --tail 30 | python3 -c "
import sys, json
d = json.load(sys.stdin)
print(f\"All {d['count']} events:\")
for e in d['entries']:
    print(f\"  {e['kind']}\")
"

# ════════════════════════════════════════════════════════════════════════
# Cleanup
wait $RUNNER_PID 2>/dev/null || true
rm -f tools/agent-bridge/*.json tools/agent-bridge/*.jsonl

echo ""
echo "═════════════════════════════════════════════════════════"
echo "Demo complete."
