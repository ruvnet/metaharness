#!/usr/bin/env bash
# One checked path for an OpenEnv Arena submission, meant to be run by `codex exec` (or by hand).
#   codex-submit.sh REQUEST.json [--execute]
# Without --execute nothing is POSTed (env client dry run). With --execute the request is POSTed only if
#   (1) the slot is open (prior receipt accepted_at + 24h; override with SLOT_OPEN_ISO),
#   (2) every pre-submit check passes on the exact image digest (render-and-check.mjs verbatim mode), and
#   (3) the env client accepts the checked request's canonical sha256 as the approved digest.
# The HF token is read in-process by the env client from the user's existing HF login; this script never reads,
# prints, stores or passes it, and prints no environment.
set -euo pipefail
REQ=${1:?usage: codex-submit.sh REQUEST.json [--execute]}
MODE=${2:-}
[ -f "$REQ" ] || { echo "ABORT: request file not found"; exit 2; }
ENVDIR=${ARENA_ENV_DIR:-$HOME/projects/metaharness-arena-knobs/integrations/openenv-arena}
FW=$(cd "$(dirname "$0")" && pwd)
VENV=${ARENA_VENV:-/tmp/arena383venv}
D=$(cd "$(dirname "$REQ")" && pwd)
PRIOR=${PRIOR_RECEIPT:-$D/../submit1/receipt.json}
OUT="$D/precheck-$(date -u +%Y%m%dT%H%M%SZ)"

if [ "$MODE" = "--execute" ]; then
  OPEN=${SLOT_OPEN_ISO:-$(python3 - "$PRIOR" <<'E'
import json,sys,datetime as dt
t=json.load(open(sys.argv[1]))["accepted_at"]; t=dt.datetime.fromisoformat(t.replace("Z","+00:00"))
print((t+dt.timedelta(hours=24,seconds=2)).isoformat())
E
)}
  python3 - "$OPEN" <<'E' || { echo "ABORT: submission slot not open yet"; exit 3; }
import sys,datetime as dt
o=dt.datetime.fromisoformat(sys.argv[1]); n=dt.datetime.now(dt.timezone.utc)
print("slot opens", o.isoformat(), "| now", n.isoformat()); sys.exit(0 if n>=o else 1)
E
fi

echo "== pre-submit checks (exact image digest) =="
set +e
RES=$(node "$FW/render-and-check.mjs" --request-json "$REQ" --out-dir "$OUT" --env-dir "$ENVDIR" \
  --python "$VENV/bin/python" --openenv "$VENV/bin/openenv")
RC=$?
set -e
echo "$RES"
[ "$RC" = 0 ] || { echo "ABORT: pre-submit checks failed (exit $RC); nothing was sent"; exit 4; }
SHA=$(printf '%s' "$RES" | python3 -c 'import sys,json;d=json.loads(sys.stdin.read().strip().splitlines()[-1]);assert d["ok"] is True;print(d["request_sha256"])')
echo "checked request_sha256: $SHA"

echo "== env client submit ${MODE:-(dry run)} =="
RECEIPT="$D/receipt-$(basename "$REQ" .json).json"
cd "$ENVDIR"
set +e
if [ "$MODE" = "--execute" ]; then
  PYTHONPATH=. "$VENV/bin/python" submission.py submit --request "$REQ" --approve-sha256 "$SHA" --receipt "$RECEIPT" --execute
else
  PYTHONPATH=. "$VENV/bin/python" submission.py submit --request "$REQ" --approve-sha256 "$SHA" --receipt "$RECEIPT"
fi
SRC=$?
set -e
echo "submit exit: $SRC"
[ -f "$RECEIPT" ] && python3 -c 'import json,sys;r=json.load(open(sys.argv[1]));print({k:r.get(k) for k in ("submission_id","state","post_attempted","http_status","error_code","accepted_at")})' "$RECEIPT"
exit "$SRC"
