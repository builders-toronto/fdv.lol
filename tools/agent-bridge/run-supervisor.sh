#!/usr/bin/env bash
# fdv.lol Hold runner supervisor.
#
# Keeps the headless Hold runner (`node cli.mjs --run-profile ...`) alive.
# When the runner exits — crash, OS sleep, terminal hangup, OOM, anything —
# the supervisor restarts it. This eliminates the "stale runner blocks the
# next entry-scan tick" failure mode that required hand-restarts every
# 20-30 min.
#
# Pairs with the in-process crash guardrails (uncaughtException /
# unhandledRejection handlers added to src/vista/addons/auto/cli/app.js):
#   - those handlers catch stray async rejections WITHOUT dying
#   - this supervisor catches everything else (hard crashes, signals, sleep)
#
# USAGE — launch once, detached so it survives terminal close:
#   nohup setsid bash "/mnt/c/Users/garys/OneDrive/Desktop/Stuff/Daniel/L.F Builders/fdv.lol/tools/agent-bridge/run-supervisor.sh" </dev/null >/dev/null 2>&1 &
#
# STOP the supervisor + runner:
#   touch /tmp/fdv-supervisor.stop      # graceful — supervisor exits after current runner dies
#   pkill -f run-supervisor.sh ; pkill -f 'node cli.mjs'   # hard
#
# STATUS:
#   tail -f /tmp/fdv-supervisor.log     # restart history
#   tail -f /tmp/fdv-runner.log        # runner stdout/stderr

set -u

REPO="/mnt/c/Users/garys/OneDrive/Desktop/Stuff/Daniel/L.F Builders/fdv.lol"
PROFILE="tools/profiles/dev.json"
RUNNER_LOG="/tmp/fdv-runner.log"
SUPERVISOR_LOG="/tmp/fdv-supervisor.log"
STOP_FILE="/tmp/fdv-supervisor.stop"
PIDFILE="/tmp/fdv-supervisor.pid"

NORMAL_DELAY=5        # restart delay after a healthy-ish run
BACKOFF_DELAY=60      # restart delay once fast-fails pile up
FAST_FAIL_SECS=15     # a run shorter than this counts as a "fast fail"
FAST_FAIL_LIMIT=5     # this many consecutive fast fails → switch to BACKOFF_DELAY

log() { echo "[$(date -u +%FT%TZ)] $*" >> "$SUPERVISOR_LOG"; }

# ── Single-instance guard ────────────────────────────────────────────────
if [ -f "$PIDFILE" ]; then
	old_pid="$(cat "$PIDFILE" 2>/dev/null || echo '')"
	if [ -n "$old_pid" ] && kill -0 "$old_pid" 2>/dev/null; then
		log "another supervisor already running (pid=$old_pid); exiting"
		exit 0
	fi
fi
echo "$$" > "$PIDFILE"

# ── nvm / node on PATH ───────────────────────────────────────────────────
if ! command -v node >/dev/null 2>&1; then
	# shellcheck disable=SC1090
	[ -s "$HOME/.nvm/nvm.sh" ] && \. "$HOME/.nvm/nvm.sh" >/dev/null 2>&1 || true
fi
if ! command -v node >/dev/null 2>&1; then
	log "FATAL: node not found on PATH even after sourcing nvm; cannot supervise"
	rm -f "$PIDFILE"
	exit 1
fi

cd "$REPO" || { log "FATAL: cannot cd to repo $REPO"; rm -f "$PIDFILE"; exit 1; }

rm -f "$STOP_FILE"
log "supervisor started (pid=$$, node=$(command -v node), repo=$REPO)"

fast_fails=0

while true; do
	if [ -f "$STOP_FILE" ]; then
		log "stop file present; supervisor exiting cleanly"
		rm -f "$STOP_FILE" "$PIDFILE"
		exit 0
	fi

	started=$(date +%s)
	log "launching runner"
	node cli.mjs --run-profile --profile-url "$PROFILE" --log-to-console >> "$RUNNER_LOG" 2>&1
	code=$?
	ended=$(date +%s)
	ran_for=$(( ended - started ))

	log "runner exited (code=$code) after ${ran_for}s"

	# Graceful stop requested while runner was alive?
	if [ -f "$STOP_FILE" ]; then
		log "stop file present after runner exit; supervisor exiting cleanly"
		rm -f "$STOP_FILE" "$PIDFILE"
		exit 0
	fi

	if [ "$ran_for" -lt "$FAST_FAIL_SECS" ]; then
		fast_fails=$(( fast_fails + 1 ))
		log "fast-fail #$fast_fails (ran only ${ran_for}s)"
	else
		fast_fails=0
	fi

	if [ "$fast_fails" -ge "$FAST_FAIL_LIMIT" ]; then
		log "  $fast_fails consecutive fast-fails — backing off ${BACKOFF_DELAY}s (check $RUNNER_LOG for the cause)"
		sleep "$BACKOFF_DELAY"
	else
		sleep "$NORMAL_DELAY"
	fi
done
