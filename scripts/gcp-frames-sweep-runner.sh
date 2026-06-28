#!/usr/bin/env bash
# GCP VM runner: TURN-BUDGET CLIFF sweep on FRAMES for one model. Loops a list of
# step-budgets, running the FRAMES agentic loop at each, and self-reports one
# Firestore `frames_cliff` doc per cell (acc + Wilson CI + $/task + avg steps-used).
#
# Budget safety: a per-VM ENVELOPE cap (USD). Cells run sequentially; cumulative
# spend is tracked and each cell's --max-cost = min(CELLCAP, ENVELOPE-cumulative).
# If the remaining envelope is below MINCELL, the cell is SKIPPED and logged
# (honest skip, never a silent truncation). Disjoint per-model envelopes summing
# under the account headroom guarantee the global cap holds even with concurrent VMs.
#
# Metadata/env: MODEL, ORKEY (required); BUDGETS (csv, e.g. "6,12,18,30");
#   SAMPLE (40); SEED (42); CONC (4); ENVELOPE (USD per-VM total); CELLCAP (USD per cell);
#   MINCELL (0.5); BRANCH; AUTOSTOP (1)
set -uo pipefail
md() { curl -s -H 'Metadata-Flavor: Google' "http://metadata/computeMetadata/v1/instance/attributes/$1" 2>/dev/null || true; }
MODEL="${MODEL:-$(md model)}"; ORKEY="${ORKEY:-$(md orkey)}"
BUDGETS="${BUDGETS:-$(md budgets)}"; BUDGETS="${BUDGETS:-6,12,18,30}"
SAMPLE="${SAMPLE:-$(md sample)}"; SAMPLE="${SAMPLE:-40}"
SEED="${SEED:-$(md seed)}"; SEED="${SEED:-42}"
CONC="${CONC:-$(md conc)}"; CONC="${CONC:-4}"
ENVELOPE="${ENVELOPE:-$(md envelope)}"; ENVELOPE="${ENVELOPE:-20}"
CELLCAP="${CELLCAP:-$(md cellcap)}"; CELLCAP="${CELLCAP:-8}"
MINCELL="${MINCELL:-0.5}"
BRANCH="${BRANCH:-$(md branch)}"; BRANCH="${BRANCH:-claude/cheap-vs-frontier-empirical}"
AUTOSTOP="${AUTOSTOP:-1}"
SLUG="$(echo "$MODEL" | tr '/:.' '---')"
[ -n "$MODEL" ] || { echo "FATAL: MODEL not set"; exit 1; }
[ -n "$ORKEY" ] || { echo "FATAL: ORKEY not set"; exit 1; }
echo "=== CLIFF sweep: model=$MODEL budgets=$BUDGETS n=$SAMPLE envelope=\$$ENVELOPE cellcap=\$$CELLCAP ==="

export DEBIAN_FRONTEND=noninteractive
if ! command -v node >/dev/null || [ "$(node -v 2>/dev/null | cut -dv -f2 | cut -d. -f1)" -lt 20 ]; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash - >/dev/null 2>&1 && apt-get install -y nodejs >/dev/null 2>&1
fi
apt-get install -y git >/dev/null 2>&1 || true
mkdir -p /opt/darwin && cd /opt/darwin
[ -d agent-harness-generator ] || git clone --depth 1 -b "$BRANCH" https://github.com/ruvnet/agent-harness-generator.git
cd agent-harness-generator/packages/darwin-mode/bench/gaia
export OPENROUTER_API_KEY="$ORKEY"
OUT=/opt/darwin/out; mkdir -p "$OUT"
TOKEN=$(curl -s -H 'Metadata-Flavor: Google' 'http://metadata/computeMetadata/v1/instance/service-accounts/default/token' | node -pe 'JSON.parse(require("fs").readFileSync(0)).access_token' 2>/dev/null)
PROJECT_ID=$(curl -s -H 'Metadata-Flavor: Google' 'http://metadata/computeMetadata/v1/project/project-id')

node --experimental-strip-types --no-warnings frames-loader.mjs --sample "$SAMPLE" --seed "$SEED" --out "$OUT/manifest.json" 2>&1 | tail -1

report_cell() { # args: maxsteps n acc ci_lo ci_hi cpt total avg_steps subrate skipped reason
  local B="$1" N="$2" ACC="$3" LO="$4" HI="$5" CPT="$6" TOT="$7" AVG="$8" SUB="$9" SK="${10}" RS="${11}"
  local BODY="{\"fields\":{\"benchmark\":{\"stringValue\":\"frames_cliff\"},\"model\":{\"stringValue\":\"$MODEL\"},\"maxsteps\":{\"integerValue\":\"$B\"},\"n\":{\"integerValue\":\"$N\"},\"acc_em\":{\"doubleValue\":$ACC},\"acc_ci_lo\":{\"doubleValue\":$LO},\"acc_ci_hi\":{\"doubleValue\":$HI},\"cost_per_task_usd\":{\"doubleValue\":$CPT},\"total_cost_usd\":{\"doubleValue\":$TOT},\"avg_steps\":{\"doubleValue\":$AVG},\"submitted_rate\":{\"doubleValue\":$SUB},\"skipped\":{\"booleanValue\":$SK},\"reason\":{\"stringValue\":\"$RS\"},\"seed\":{\"integerValue\":\"$SEED\"},\"ts\":{\"stringValue\":\"$(date -u +%FT%TZ)\"}}}"
  curl -s -X POST "https://firestore.googleapis.com/v1/projects/$PROJECT_ID/databases/(default)/documents/frames_cliff" \
    -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -d "$BODY" >/dev/null && echo "  reported cell B=$B" || echo "  cell report FAILED B=$B"
}

CUM=0
IFS=',' read -ra BLIST <<< "$BUDGETS"
for B in "${BLIST[@]}"; do
  REMAIN=$(node -pe "Math.max(0, $ENVELOPE - $CUM)")
  FITS=$(node -pe "($ENVELOPE - $CUM) >= $MINCELL ? 1 : 0")
  if [ "$FITS" != "1" ]; then
    echo "=== SKIP B=$B (envelope exhausted: cum=\$$CUM / \$$ENVELOPE) ==="
    report_cell "$B" 0 0 0 0 0 0 0 0 true "skipped-budget-envelope-exhausted"
    continue
  fi
  CAP=$(node -pe "Math.min($CELLCAP, $ENVELOPE - $CUM).toFixed(4)")
  echo "=== CELL B=$B  cap=\$$CAP  (cum=\$$CUM / \$$ENVELOPE) ==="
  node --experimental-strip-types --no-warnings solve-gaia.mjs \
    --manifest "$OUT/manifest.json" --model "$MODEL" --max-steps "$B" --concurrency "$CONC" \
    --max-cost "$CAP" --out "$OUT/preds-$SLUG-b$B.jsonl" --report "$OUT/report-$SLUG-b$B.json" 2>&1 | tail -2
  node --experimental-strip-types --no-warnings score-gaia.mjs \
    --manifest "$OUT/manifest.json" --predictions "$OUT/preds-$SLUG-b$B.jsonl" \
    --model "$MODEL" --out "$OUT/results-$SLUG-b$B.json" 2>&1 | grep -v '^{' | grep -v '^ ' | tail -1
  # Extract metrics + avg steps-used + submitted-rate from preds + results.
  read -r N ACC LO HI CPT TOT AVG SUB <<< "$(node -e '
    const fs=require("fs");
    const r=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));
    const preds=fs.readFileSync(process.argv[2],"utf8").trim().split("\n").filter(Boolean).map(l=>JSON.parse(l));
    const steps=preds.map(p=>p.steps||0); const avg=steps.length?steps.reduce((a,b)=>a+b,0)/steps.length:0;
    const sub=preds.length?preds.filter(p=>(p.steps||0)<'"$B"').length/preds.length:0; // submitted before cap ⇒ steps<maxsteps
    process.stdout.write([r.n,r.acc_em,r.acc_em_wilson95[0],r.acc_em_wilson95[1],r.cost_per_task_usd,r.total_cost_usd,avg.toFixed(2),sub.toFixed(3)].join(" "));
  ' "$OUT/results-$SLUG-b$B.json" "$OUT/preds-$SLUG-b$B.jsonl" 2>/dev/null || echo "0 0 0 0 0 0 0 0")"
  CUM=$(node -pe "($CUM + ($TOT||0)).toFixed(4)")
  echo "  cell B=$B → acc=$ACC n=$N avg_steps=$AVG \$${TOT} (cum=\$$CUM)"
  report_cell "$B" "$N" "$ACC" "$LO" "$HI" "$CPT" "$TOT" "$AVG" "$SUB" false "ok"
done

echo "=== DONE sweep $MODEL — total \$$CUM / envelope \$$ENVELOPE ==="
if [ "$AUTOSTOP" = "1" ]; then echo "AUTOSTOP: halting in 90s"; (sleep 90; shutdown -h now) & fi
