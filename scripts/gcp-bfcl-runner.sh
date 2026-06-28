#!/usr/bin/env bash
# GCP VM runner: BFCL function-calling (tool-use) benchmark for the
# cheap-vs-older-frontier thesis. One VM per model; single-turn native
# tool-calling, AST-graded. Self-reports to Firestore `bfcl_runs` (+ `bfcl_preds`).
# No Docker/GPU — pure network I/O; e2-small is plenty. Inputs via metadata/env:
#   MODEL, ORKEY (required); PERCAT (default 50 → n=150 over simple/multiple/parallel);
#   SEED (42); CONC (4); MAXCOST (10); BRANCH (claude/cheap-vs-frontier-empirical); AUTOSTOP (1)
set -uo pipefail
md() { curl -s -H 'Metadata-Flavor: Google' "http://metadata/computeMetadata/v1/instance/attributes/$1" 2>/dev/null || true; }
MODEL="${MODEL:-$(md model)}"; ORKEY="${ORKEY:-$(md orkey)}"
PERCAT="${PERCAT:-$(md percat)}"; PERCAT="${PERCAT:-50}"
SEED="${SEED:-$(md seed)}"; SEED="${SEED:-42}"
CONC="${CONC:-$(md conc)}"; CONC="${CONC:-4}"
MAXCOST="${MAXCOST:-$(md maxcost)}"; MAXCOST="${MAXCOST:-10}"
BRANCH="${BRANCH:-$(md branch)}"; BRANCH="${BRANCH:-claude/cheap-vs-frontier-empirical}"
AUTOSTOP="${AUTOSTOP:-1}"
SLUG="$(echo "$MODEL" | tr '/:.' '---')"
[ -n "$MODEL" ] || { echo "FATAL: MODEL not set"; exit 1; }
[ -n "$ORKEY" ] || { echo "FATAL: ORKEY not set"; exit 1; }
echo "=== BFCL runner: model=$MODEL percat=$PERCAT seed=$SEED conc=$CONC maxcost=$MAXCOST ==="

export DEBIAN_FRONTEND=noninteractive
if ! command -v node >/dev/null || [ "$(node -v 2>/dev/null | cut -dv -f2 | cut -d. -f1)" -lt 20 ]; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash - >/dev/null 2>&1 && apt-get install -y nodejs >/dev/null 2>&1
fi
apt-get install -y git >/dev/null 2>&1 || true

mkdir -p /opt/darwin && cd /opt/darwin
[ -d agent-harness-generator ] || git clone --depth 1 -b "$BRANCH" https://github.com/ruvnet/agent-harness-generator.git
cd agent-harness-generator/packages/darwin-mode/bench/bfcl
export OPENROUTER_API_KEY="$ORKEY"
OUT=/opt/darwin/out; mkdir -p "$OUT"

echo "=== load → solve → score ==="
node --experimental-strip-types --no-warnings bfcl-loader.mjs --per-cat "$PERCAT" --seed "$SEED" --out "$OUT/manifest.json" 2>&1 | tail -4
node --experimental-strip-types --no-warnings solve-bfcl.mjs \
  --manifest "$OUT/manifest.json" --model "$MODEL" --concurrency "$CONC" --max-cost "$MAXCOST" \
  --out "$OUT/preds-$SLUG.jsonl" --report "$OUT/report-$SLUG.json" 2>&1 | tail -4
node --experimental-strip-types --no-warnings score-bfcl.mjs \
  --manifest "$OUT/manifest.json" --predictions "$OUT/preds-$SLUG.jsonl" \
  --model "$MODEL" --out "$OUT/results-$SLUG.json" 2>&1 | grep -v '^{' | grep -v '^ ' | tail -2

echo "=== self-report to Firestore bfcl_runs (+ bfcl_preds) ==="
RES="$OUT/results-$SLUG.json"
TOKEN=$(curl -s -H 'Metadata-Flavor: Google' 'http://metadata/computeMetadata/v1/instance/service-accounts/default/token' | node -pe 'JSON.parse(require("fs").readFileSync(0)).access_token' 2>/dev/null)
PROJECT_ID=$(curl -s -H 'Metadata-Flavor: Google' 'http://metadata/computeMetadata/v1/project/project-id')
if [ -f "$RES" ]; then
  BODY=$(node -e '
    const r=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));
    const f={benchmark:{stringValue:"bfcl"},model:{stringValue:r.model},task_family:{stringValue:r.task_family},
      n:{integerValue:String(r.n)},acc:{doubleValue:r.acc},correct:{integerValue:String(r.correct)},
      acc_ci_lo:{doubleValue:r.acc_wilson95[0]},acc_ci_hi:{doubleValue:r.acc_wilson95[1]},
      total_cost_usd:{doubleValue:r.total_cost_usd},cost_per_task_usd:{doubleValue:r.cost_per_task_usd},
      cost_per_correct_usd:(r.cost_per_correct_usd==null?{nullValue:null}:{doubleValue:r.cost_per_correct_usd}),
      by_category:{stringValue:JSON.stringify(r.by_category)},seed:{integerValue:String(r.seed)},
      scorer:{stringValue:r.scorer},source:{stringValue:"gcp-fleet"},ts:{stringValue:r.ts}};
    process.stdout.write(JSON.stringify({fields:f}));' "$RES")
  curl -s -X POST "https://firestore.googleapis.com/v1/projects/$PROJECT_ID/databases/(default)/documents/bfcl_runs" \
    -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -d "$BODY" >/dev/null \
    && echo "self-reported to bfcl_runs" || echo "bfcl_runs self-report FAILED (results in $OUT)"
fi
PREDS="$OUT/preds-$SLUG.jsonl"
if [ -f "$PREDS" ]; then
  PBODY=$(node -e '
    const fs=require("fs");const rows=fs.readFileSync(process.argv[1],"utf8").trim().split("\n").filter(Boolean).map(l=>{try{return JSON.parse(l)}catch{return null}}).filter(Boolean);
    const f={benchmark:{stringValue:"bfcl"},model:{stringValue:process.argv[2]},n:{integerValue:String(rows.length)},seed:{integerValue:String(process.argv[3])},ts:{stringValue:new Date().toISOString()},preds_json:{stringValue:JSON.stringify(rows)}};
    process.stdout.write(JSON.stringify({fields:f}));' "$PREDS" "$MODEL" "$SEED")
  curl -s -X POST "https://firestore.googleapis.com/v1/projects/$PROJECT_ID/databases/(default)/documents/bfcl_preds" \
    -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -d "$PBODY" >/dev/null \
    && echo "exfil $(wc -l <"$PREDS") preds to bfcl_preds" || echo "preds exfil FAILED"
fi

echo "=== DONE — results in $OUT ==="
if [ "$AUTOSTOP" = "1" ]; then echo "AUTOSTOP: halting in 90s"; (sleep 90; shutdown -h now) & fi
