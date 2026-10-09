#!/usr/bin/env bash
# Installs the arena-flywheel systemd USER timer on this host. Idempotent. It never starts a tick.
#
#   install.sh              verify units; seed ~/.config/arena-flywheel/config.json (mode "dry-run") if absent;
#                           link the units into ~/.config/systemd/user/; daemon-reload; enable --now the two TIMERS
#                           (the daily tick and the hourly GPU recovery sweep, which never rents or submits); print status
#   install.sh --uninstall  disable and stop the timer, remove our unit links; config and state are kept
#   install.sh --verify     only run `systemd-analyze --user verify` on the units and check the calendar spec
#
# The units hard-code %h/metaharness/integrations/openenv-arena-darwin, so this refuses to install from any
# other checkout. The timer owns the schedule; config.json's `schedule` is informational (warned if it differs).
# Test seams (never needed on the host): SYSTEMCTL, SYSTEMD_ANALYZE, LOGINCTL, NODE.
set -euo pipefail
umask 077

SELF_DIR=$(cd "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")" && pwd)
UNIT_SRC=$SELF_DIR/systemd
SERVICE=arena-flywheel.service
TIMER=arena-flywheel.timer
RSERVICE=arena-flywheel-recover.service
RTIMER=arena-flywheel-recover.timer
SYSTEMCTL=${SYSTEMCTL:-systemctl}
SYSTEMD_ANALYZE=${SYSTEMD_ANALYZE:-systemd-analyze}
LOGINCTL=${LOGINCTL:-loginctl}
NODE=${NODE:-node}
CONFIG_HOME=${XDG_CONFIG_HOME:-$HOME/.config}
STATE_HOME=${XDG_STATE_HOME:-$HOME/.local/state}
UNIT_DIR=$CONFIG_HOME/systemd/user
CONF_DIR=$CONFIG_HOME/arena-flywheel
CONF=$CONF_DIR/config.json
STATE_DIR=$STATE_HOME/arena-flywheel
EXPECTED_DIR=$HOME/metaharness/integrations/openenv-arena-darwin/flywheel
ENTRY=$SELF_DIR/flywheel.mjs

say() { printf 'install: %s\n' "$*"; }
warn() { printf 'install: WARNING: %s\n' "$*" >&2; }
die() { printf 'install: ERROR: %s\n' "$*" >&2; exit 1; }

usage() { sed -n '2,13p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; }

ACTION=install
case "${1:-}" in
  '') ;;
  --uninstall) ACTION=uninstall ;;
  --verify) ACTION=verify ;;
  -h|--help) usage; exit 0 ;;
  *) usage >&2; die "unknown argument: $1" ;;
esac
[[ $# -le 1 ]] || die "takes at most one argument"

timer_calendar() { sed -n 's/^OnCalendar=//p' "$UNIT_SRC/$TIMER" | head -n1; }

verify_units() {
  local out
  for u in "$SERVICE" "$TIMER" "$RSERVICE" "$RTIMER" run-tick.sh; do [[ -f $UNIT_SRC/$u ]] || die "missing $UNIT_SRC/$u"; done
  [[ -x $UNIT_SRC/run-tick.sh ]] || die "$UNIT_SRC/run-tick.sh is not executable"
  # All files in one call, so each timer's Unit= resolves. Any output is treated as a failure.
  if ! out=$("$SYSTEMD_ANALYZE" --user verify "$UNIT_SRC/$SERVICE" "$UNIT_SRC/$TIMER" "$UNIT_SRC/$RSERVICE" "$UNIT_SRC/$RTIMER" 2>&1) || [[ -n $out ]]; then
    printf '%s\n' "$out" >&2
    die "systemd-analyze --user verify reported problems"
  fi
  "$SYSTEMD_ANALYZE" calendar "$(timer_calendar)" >/dev/null || die "timer OnCalendar does not parse"
  say "units verified: $SERVICE $TIMER $RSERVICE $RTIMER (OnCalendar=$(timer_calendar))"
}

# Prints "<mode>\t<schedule.onCalendar or ->" for a config file, or fails if it is not a usable JSON object.
read_config() {
  "$NODE" -e '
    const fs = require("fs");
    let c; try { c = JSON.parse(fs.readFileSync(process.argv[1], "utf8")); } catch (e) { console.error("not valid JSON"); process.exit(2); }
    if (!c || typeof c !== "object" || Array.isArray(c)) { console.error("not a JSON object"); process.exit(2); }
    const mode = c.mode === undefined ? "dry-run" : c.mode;
    if (mode !== "dry-run" && mode !== "auto") { console.error("mode must be dry-run or auto"); process.exit(2); }
    const cal = c.schedule && typeof c.schedule.onCalendar === "string" ? c.schedule.onCalendar : "-";
    process.stdout.write(mode + "\t" + cal.replace(/[\t\n\r]/g, " ") + "\n");
  ' "$1"
}

seed_config() {
  mkdir -p "$CONF_DIR" "$STATE_DIR"
  chmod 0700 "$CONF_DIR" "$STATE_DIR"
  if [[ -e $CONF || -L $CONF ]]; then
    say "config exists, left unchanged: $CONF"
    return
  fi
  local tmp
  tmp=$(mktemp "$CONF_DIR/.config.json.XXXXXX")
  # Minimal on purpose: flywheel-config.mjs deep-merges this over its defaults and owns validation.
  cat >"$tmp" <<EOF
{
  "mode": "dry-run",
  "schedule": { "onCalendar": "$(timer_calendar)", "randomizedDelaySec": 600 },
  "darwin": { "generations": 2, "children": 3 },
  "confirmation": { "attempts": 8 },
  "caps": { "dailyUsd": 12, "totalUsd": 200 },
  "notify": { "postEnabled": false, "slackChannel": "" }
}
EOF
  chmod 0600 "$tmp"
  # -n: never clobber a config that appeared meanwhile.
  mv -n "$tmp" "$CONF"
  [[ -e $tmp ]] && { rm -f "$tmp"; say "config appeared concurrently, left unchanged: $CONF"; return; }
  say "seeded config (mode dry-run): $CONF"
}

link_unit() { # <unit>
  local src=$UNIT_SRC/$1 dst=$UNIT_DIR/$1
  if [[ -L $dst ]]; then
    ln -sfn "$src" "$dst"
  elif [[ -e $dst ]]; then
    die "refusing to replace $dst: it is a regular file, not our link"
  else
    ln -s "$src" "$dst"
  fi
  say "linked $dst -> $src"
}

ours() { [[ -L $1 && $(readlink -f "$1") == "$(readlink -f "$UNIT_SRC/$(basename "$1")")" ]]; }

do_install() {
  command -v "$NODE" >/dev/null 2>&1 || die "node not found"
  command -v "$SYSTEMCTL" >/dev/null 2>&1 || die "$SYSTEMCTL not found"
  [[ $(readlink -f "$SELF_DIR") == "$(readlink -f "$EXPECTED_DIR" 2>/dev/null || true)" ]] \
    || die "the units hard-code $EXPECTED_DIR but this checkout is $SELF_DIR"
  [[ -f $ENTRY ]] || die "orchestrator entry $ENTRY does not exist yet; the timer would fail every day"
  verify_units
  seed_config
  local cfg mode cal
  cfg=$(read_config "$CONF") || die "config $CONF is unusable; fix it first"
  mode=${cfg%%$'\t'*} cal=${cfg#*$'\t'}
  [[ $cal == - || $cal == "$(timer_calendar)" ]] \
    || warn "config schedule.onCalendar ($cal) differs from the timer ($(timer_calendar)); the timer wins"
  mkdir -p "$UNIT_DIR"
  link_unit "$SERVICE"
  link_unit "$TIMER"
  link_unit "$RSERVICE"
  link_unit "$RTIMER"
  "$SYSTEMCTL" --user daemon-reload
  # The TIMERS only. Persistent=true has no stamp yet, so enabling does not fire a catch-up tick; the recovery timer
  # first fires OnUnitActiveSec after enabling (OnBootSec is past), and it can only destroy, never rent or submit.
  "$SYSTEMCTL" --user enable --now "$TIMER"
  "$SYSTEMCTL" --user enable --now "$RTIMER"
  local linger
  linger=$("$LOGINCTL" show-user "$(id -un)" -p Linger --value 2>/dev/null || true)
  [[ $linger == yes ]] || warn "Linger is '${linger:-unknown}': the timer only fires while you are logged in (loginctl enable-linger)"
  if [[ $mode == auto ]]; then
    warn "config mode is AUTO: a tick may POST a submission when every condition in decide.mjs holds"
  else
    say "mode: dry-run (renders, checks and reports; never POSTs). Set \"mode\": \"auto\" in $CONF to allow submits."
  fi
  "$SYSTEMCTL" --user list-timers "$TIMER" --all --no-pager || true
  "$SYSTEMCTL" --user status "$TIMER" --no-pager || true
  say "state: $STATE_DIR   logs: journalctl --user -u $SERVICE   report: node $SELF_DIR/report.mjs"
  say "one manual tick: systemctl --user start $SERVICE (not started by this installer)"
}

do_uninstall() {
  command -v "$SYSTEMCTL" >/dev/null 2>&1 || die "$SYSTEMCTL not found"
  "$SYSTEMCTL" --user disable --now "$TIMER" 2>/dev/null || warn "could not disable $TIMER (not installed?)"
  "$SYSTEMCTL" --user disable --now "$RTIMER" 2>/dev/null || warn "could not disable $RTIMER (not installed?)"
  if "$SYSTEMCTL" --user is-active --quiet "$SERVICE" 2>/dev/null; then
    warn "a tick is running and was left alone. 'systemctl --user stop $SERVICE' stops it (its trap destroys any Vast instance)"
  fi
  local u
  for u in "$SERVICE" "$TIMER" "$RSERVICE" "$RTIMER"; do
    if ours "$UNIT_DIR/$u"; then rm -f "$UNIT_DIR/$u"; say "removed $UNIT_DIR/$u"
    elif [[ -e $UNIT_DIR/$u || -L $UNIT_DIR/$u ]]; then warn "left $UNIT_DIR/$u: it is not our link"
    fi
  done
  "$SYSTEMCTL" --user daemon-reload
  "$SYSTEMCTL" --user reset-failed "$SERVICE" 2>/dev/null || true
  say "kept config $CONF and state $STATE_DIR (journal, spend ledger, receipts)"
}

case $ACTION in
  verify) verify_units ;;
  install) do_install ;;
  uninstall) do_uninstall ;;
esac
