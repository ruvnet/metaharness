#!/usr/bin/env bash
# ExecStart of arena-flywheel.service: one daily tick of the OpenEnv Arena submission flywheel.
#
# It owns only the shell side: timestamps from the shell, fail-closed preconditions, network wait and a
# per-tick flock. Then it execs the orchestrator, which makes every decision (decide.mjs, no LLM).
#
# Orchestrator contract (the exec at the bottom):
#   node --experimental-strip-types <entry> --config <config.json> --state-dir <dir> --now <ISO-8601 UTC> --date <YYYY-MM-DD>
#   with the same values exported as ARENA_FLYWHEEL_CONFIG, ARENA_FLYWHEEL_STATE_DIR, ARENA_FLYWHEEL_STARTED_AT
#   and ARENA_FLYWHEEL_RUN_DATE. --date is the America/Toronto calendar date, the per-day idempotency key.
#   <entry> defaults to ../flywheel.mjs and can be overridden with ARENA_FLYWHEEL_ENTRY (systemctl --user edit).
#
# Exit: whatever the orchestrator returns; 1 when a precondition fails (nothing was started).
# This script never reads the HF token. It only checks that the token file exists and is not empty.
set -euo pipefail
umask 077

HERE=$(cd "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")" && pwd)
FLYWHEEL_DIR=$(dirname "$HERE")
NODE=${NODE:-/usr/bin/node}
NM_ONLINE=${NM_ONLINE:-nm-online}
ENTRY=${ARENA_FLYWHEEL_ENTRY:-$FLYWHEEL_DIR/flywheel.mjs}
# systemd exports these from ConfigurationDirectory=/StateDirectory=; the fallbacks are the same paths.
CONF_DIR=${CONFIGURATION_DIRECTORY:-${XDG_CONFIG_HOME:-$HOME/.config}/arena-flywheel}
STATE_DIR=${STATE_DIRECTORY:-${XDG_STATE_HOME:-$HOME/.local/state}/arena-flywheel}
CONFIG=${ARENA_FLYWHEEL_CONFIG:-$CONF_DIR/config.json}
TOKEN_FILE=${HF_TOKEN_PATH:-${HF_HOME:-$HOME/.cache/huggingface}/token}

STARTED_AT=$(date -u +%Y-%m-%dT%H:%M:%SZ)
RUN_DATE=$(TZ=America/Toronto date +%F)

say() { printf 'arena-flywheel: %s\n' "$*" >&2; }
fail() { say "FAIL-CLOSED: $*"; exit 1; }

say "tick date=$RUN_DATE started_at=$STARTED_AT invocation=${INVOCATION_ID:-manual}"
[[ -x $NODE ]] || fail "node not executable at $NODE"
[[ -f $ENTRY ]] || fail "orchestrator entry missing: $ENTRY"
[[ -f $CONFIG ]] || fail "config missing: $CONFIG (run flywheel/install.sh)"
[[ -f $TOKEN_FILE && -s $TOKEN_FILE ]] || fail "HF token file missing or empty at $TOKEN_FILE"
mkdir -p "$STATE_DIR"   # umask 077: any directory created here is 0700

# journal.mjs owns flywheel.lock (pid-based); this flock is a separate file so the two never collide. The hourly
# recovery sweep (arena-flywheel-recover.service) takes it for a few seconds to minutes: wait for it, not for a tick.
FLOCK_WAIT_S=${ARENA_FLYWHEEL_FLOCK_WAIT_S:-900}
[[ $FLOCK_WAIT_S =~ ^[0-9]{1,5}$ ]] || fail "ARENA_FLYWHEEL_FLOCK_WAIT_S must be whole seconds"
exec 9>>"$STATE_DIR/tick.flock"
flock -w "$FLOCK_WAIT_S" 9 || fail "another tick (or a recovery sweep) holds $STATE_DIR/tick.flock"

if command -v "$NM_ONLINE" >/dev/null 2>&1; then
  "$NM_ONLINE" -q -t 120 || fail "network not online after 120 s"
fi

export ARENA_FLYWHEEL_CONFIG=$CONFIG ARENA_FLYWHEEL_STATE_DIR=$STATE_DIR
export ARENA_FLYWHEEL_STARTED_AT=$STARTED_AT ARENA_FLYWHEEL_RUN_DATE=$RUN_DATE VASTAI_NO_UPDATE_CHECK=1
exec "$NODE" --experimental-strip-types "$ENTRY" --config "$CONFIG" --state-dir "$STATE_DIR" \
  --now "$STARTED_AT" --date "$RUN_DATE"
