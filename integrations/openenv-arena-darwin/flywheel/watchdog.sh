#!/usr/bin/env bash
# Independent hard-deadline destroyer for ONE Vast rental of the arena flywheel (gpu.mjs).
#
#   watchdog.sh <instance_id|-> <deadline_epoch_s> <label>
#
# `-` = LABEL mode (how gpu.mjs arms it, BEFORE create): at the deadline it lists the instances carrying the unique
# label, destroys each BY ID and is done only when a successful lookup shows none left, so a crash before the
# orchestrator ever learned the instance id is still covered. With an id it destroys that instance and confirms with
# `show instance` -> {"instances": null}, refusing an instance labelled otherwise. It never trusts a CLI exit code alone.
# The Vast key is fetched from Secret Manager at fire time, never earlier. gpu.mjs starts it as a transient systemd
# user unit (own cgroup, Restart=on-failure), so it outlives the flywheel service even when that is stopped or killed.
#
# After the deadline nothing here can stop it early except success: logging is best effort (a full disk cannot kill
# it), every network call has a timeout, and it retries until WATCHDOG_GIVE_UP_AT (default deadline + 25 min) or
# WATCHDOG_ATTEMPTS. A TERM after firing is recorded as a failure, never as a clean stop.
# Exit: 0 destroyed/confirmed gone (or stopped by a signal BEFORE the deadline), 1 could not confirm (LEAK, recorded
# in watchdog-failed.jsonl; systemd restarts it), 2 bad arguments/environment (nothing called), 3 label mismatch.
# The key lives only in a shell variable and the env of each vastai child. Never add `set -x` here.
set -euo pipefail
umask 077
# Byte semantics for every [[ =~ ]] below. The transient unit inherits the user manager's LANG (en_US.UTF-8 here),
# where the range [!-~] collates differently and the key-shape check NEVER matched: the watchdog could not fetch its key.
export LC_ALL=C
unset VAST_API_KEY
export VASTAI_NO_UPDATE_CHECK=1

die2() { echo "watchdog: $*" >&2; exit 2; }
[[ $# -eq 3 ]] || die2 "usage: watchdog.sh <instance_id|-> <deadline_epoch_s> <label>"
ID=$1 DEADLINE=$2 LABEL=$3
[[ $ID == - || $ID =~ ^[1-9][0-9]{0,11}$ ]] || die2 "instance id must be a positive integer or - (label mode)"
[[ $DEADLINE =~ ^[1-9][0-9]{9}$ ]] || die2 "deadline must be a 10-digit epoch in seconds"
[[ $LABEL =~ ^arena-flywheel-[A-Za-z0-9-]{1,48}$ ]] || die2 "label must match arena-flywheel-<runId>"
NOW=$(date +%s)
(( DEADLINE <= NOW + 86400 )) || die2 "deadline more than 24h ahead"
(( DEADLINE >= NOW - 86400 )) || die2 "deadline more than 24h in the past"
ATTEMPTS=${WATCHDOG_ATTEMPTS:-999} RETRY_S=${WATCHDOG_RETRY_S:-30} POLL_S=${WATCHDOG_POLL_S:-30}
GIVE_UP_AT=${WATCHDOG_GIVE_UP_AT:-$(( DEADLINE + 1500 ))}
KEY_TIMEOUT_S=${WATCHDOG_KEY_TIMEOUT_S:-60} CALL_TIMEOUT_S=${WATCHDOG_CALL_TIMEOUT_S:-120}
[[ $ATTEMPTS =~ ^[1-9][0-9]{0,2}$ ]] || die2 "WATCHDOG_ATTEMPTS invalid"
[[ $RETRY_S =~ ^[0-9]{1,4}$ ]] || die2 "WATCHDOG_RETRY_S invalid"
[[ $POLL_S =~ ^[1-9][0-9]{0,3}$ ]] || die2 "WATCHDOG_POLL_S invalid"
[[ $KEY_TIMEOUT_S =~ ^[1-9][0-9]{0,3}$ && $CALL_TIMEOUT_S =~ ^[1-9][0-9]{0,3}$ ]] || die2 "WATCHDOG_KEY_TIMEOUT_S / WATCHDOG_CALL_TIMEOUT_S invalid"
[[ $GIVE_UP_AT =~ ^[1-9][0-9]{9}$ ]] || die2 "WATCHDOG_GIVE_UP_AT invalid"
STATE_DIR=${ARENA_FLYWHEEL_STATE_DIR:-${HOME:-}/.local/state/arena-flywheel}
[[ $STATE_DIR =~ ^/[A-Za-z0-9._/-]+$ && $STATE_DIR != *..* ]] || die2 "state dir must be a plain absolute path"
for bin in vastai gcloud jq timeout; do command -v "$bin" >/dev/null 2>&1 || die2 "$bin not on PATH"; done
mkdir -p "$STATE_DIR" 2>/dev/null || true
LOG="$STATE_DIR/watchdog.jsonl"
IDJSON=$([[ $ID == - ]] && echo null || echo "$ID")

log() { # <phase> [msg]   best effort: a failing log sink (disk full) must never stop the destroy loop
  jq -nc --arg phase "$1" --arg msg "${2:-}" --argjson id "$IDJSON" --arg label "$LABEL" --argjson deadline "$DEADLINE" \
    --argjson at "$(date +%s)" '{at:$at, phase:$phase, instanceId:$id, label:$label, deadlineEpoch:$deadline, msg:$msg}' >>"$LOG" 2>/dev/null || true
  echo "watchdog[$ID $LABEL]: $1${2:+ $2}" 2>/dev/null || true
}
record_failure() {
  jq -nc --arg reason "$1" --argjson id "$IDJSON" --arg label "$LABEL" --argjson at "$(date +%s)" \
    '{at:$at, instanceId:$id, label:$label, reason:$reason}' >>"$STATE_DIR/watchdog-failed.jsonl" 2>/dev/null || true
}
FIRED=0
on_signal() {
  if (( FIRED )); then log stopped_after_fire "signal after the deadline, destroy not confirmed"; record_failure terminated_after_fire; exit 1; fi
  log stopped "signal before the deadline"; exit 0
}
nap() { sleep "$1" & wait $! || true; } # interruptible by the trap
trap on_signal TERM INT

log armed "fires at $DEADLINE ($([[ $ID == - ]] && echo "by label" || echo "id $ID"))"
set +e # armed: from here on no single failing command may end the script; every outcome is handled explicitly
while :; do
  NOW=$(date +%s)
  (( NOW >= DEADLINE )) && break
  REM=$(( DEADLINE - NOW ))
  nap $(( REM < POLL_S ? REM : POLL_S )) # short chunks of wall clock: correct after suspend/resume
done
FIRED=1
log fired

KEY=""
fetch_key() {
  local k
  k=$(timeout "$KEY_TIMEOUT_S" gcloud secrets versions access latest --secret=VAST_API_KEY --project=cognitum-20260110 2>/dev/null) || return 1
  k=${k//[$'\r\n\t ']/}
  [[ $k =~ ^[!-~]{16,512}$ ]] || return 1
  KEY=$k
}
vast() { VAST_API_KEY="$KEY" timeout "$CALL_TIMEOUT_S" vastai "$@" --raw; } # key in this child's env only

# id mode -> gone | present | foreign | error. In --raw mode an HTTP error prints nothing on stdout.
show_state() {
  local out rid rlabel
  out=$(vast show instance "$ID" 2>/dev/null) || { echo error; return; }
  if jq -e 'type == "object" and has("instances") and .instances == null' <<<"$out" >/dev/null 2>&1; then echo gone; return; fi
  rid=$(jq -r '(.instances // .) | .id // empty' <<<"$out" 2>/dev/null) || { echo error; return; }
  [[ $rid == "$ID" ]] || { echo error; return; }
  rlabel=$(jq -r '(.instances // .) | .label // ""' <<<"$out" 2>/dev/null) || { echo error; return; }
  if [[ -n $rlabel && $rlabel != "$LABEL" ]]; then echo foreign; else echo present; fi
}
# label mode -> the ids carrying LABEL (space separated, possibly empty), or "error"
label_ids() {
  local out ids
  out=$(vast show instances --label "$LABEL" 2>/dev/null) || { echo error; return; }
  [[ -n ${out//[$'\r\n\t ']/} ]] || { echo error; return; } # --raw HTTP error: exit 0, EMPTY stdout. Never "none left".
  ids=$(jq -r --arg l "$LABEL" 'if type == "array" then [.[] | select(type == "object" and .label == $l) | .id] | map(tostring) | join(" ") else error("shape") end' <<<"$out" 2>/dev/null) \
    || { echo error; return; }
  for x in $ids; do [[ $x =~ ^[1-9][0-9]{0,11}$ ]] || { echo error; return; }; done
  echo "$ids"
}

for (( i = 1; ; i++ )); do
  if [[ -z $KEY ]] && ! fetch_key; then log key_fetch_failed "attempt $i"
  elif [[ $ID == - ]]; then
    ids=$(label_ids)
    if [[ $ids == error ]]; then log lookup_failed "attempt $i"
    elif [[ -z $ids ]]; then log destroyed_confirmed "attempt $i: no instance labelled $LABEL"; exit 0
    else
      for x in $ids; do vast destroy instance "$x" -y >/dev/null 2>&1; done
      log destroy_sent "attempt $i ids=$ids"
    fi
  else
    st=$(show_state)
    case $st in
      gone) log destroyed_confirmed "attempt $i"; exit 0 ;;
      foreign) log refused_label_mismatch "instance $ID is not labelled $LABEL"; record_failure label_mismatch; exit 3 ;;
      *) vast destroy instance "$ID" -y >/dev/null 2>&1; log destroy_sent "attempt $i state=$st" ;;
    esac
  fi
  (( i >= ATTEMPTS || $(date +%s) >= GIVE_UP_AT )) && break
  nap "$RETRY_S"
done
if [[ -n $KEY ]]; then
  if [[ $ID == - ]]; then [[ $(label_ids) == "" ]] && { log destroyed_confirmed final; exit 0; }
  else [[ $(show_state) == gone ]] && { log destroyed_confirmed final; exit 0; }
  fi
fi
log LEAK "could not confirm the destroy of $([[ $ID == - ]] && echo "label $LABEL" || echo "instance $ID") after $i attempts"
record_failure unconfirmed
exit 1
