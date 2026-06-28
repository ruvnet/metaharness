#!/usr/bin/env bash
# GCP VM runner: GAIA-class everyday-agentic benchmark (FRAMES) for the
# cheap-vs-older-frontier research thesis. One VM per model; runs the keyless
# Wikipedia agentic loop (solve-gaia.mjs), scores (score-gaia.mjs), and
# self-reports the Pareto point (acc_em + $/task) to Firestore `frames_runs`.
#
# No Docker, no GPU — pure network I/O (OpenRouter + Wikipedia). A small VM
# (e2-small) is plenty. Inputs via instance metadata (or env):
#   MODEL      = OpenRouter model id        (required; metadata model)
#   ORKEY      = OpenRouter API key         (required; metadata orkey)
#   SAMPLE     = # FRAMES questions         (default 50)
#   SEED       = subset seed                (default 42 — same questions per model)
#   MAXSTEPS   = ReAct step budget          (default 12)
#   CONC       = solver concurrency         (default 4)
#   MAXCOST    = in-solver USD budget gate  (default 20)
#   BRANCH     = git branch                 (default claude/cheap-vs-frontier-empirical)
#   AUTOSTOP   = 1 → halt VM when done      (default 1; controller reaps TERMINATED)
set -uo pipefail
md() { curl -s -H 'Metadata-Flavor: Google' "http://metadata/computeMetadata/v1/instance/attributes/$1" 2>/dev/null || true; }
MODEL="${MODEL:-$(md model)}"
ORKEY="${ORKEY:-$(md orkey)}"
SAMPLE="${SAMPLE:-$(md sample)}"; SAMPLE="${SAMPLE:-50}"
SEED="${SEED:-$(md seed)}"; SEED="${SEED:-42}"
MAXSTEPS="${MAXSTEPS:-$(md maxsteps)}"; MAXSTEPS="${MAXSTEPS:-12}"
CONC="${CONC:-$(md conc)}"; CONC="${CONC:-4}"
MAXCOST="${MAXCOST:-$(md maxcost)}"; MAXCOST="${MAXCOST:-20}"
BRANCH="${BRANCH:-$(md branch)}"; BRANCH="${BRANCH:-claude/cheap-vs-frontier-empirical}"
AUTOSTOP="${AUTOSTOP:-1}"
SLUG="$(echo "$MODEL" | tr '/:.' '---')"
[ -n "$MODEL" ] || { echo "FATAL: MODEL not set"; exit 1; }
[ -n "$ORKEY" ] || { echo "FATAL: ORKEY not set"; exit 1; }
echo "=== FRAMES runner: model=$MODEL sample=$SAMPLE seed=$SEED steps=$MAXSTEPS conc=$CONC maxcost=$MAXCOST ==="

echo "=== [1/4] node ==="
export DEBIAN_FRONTEND=noninteractive
if ! command -v node >/dev/null || [ "$(node -v 2>/dev/null | cut -dv -f2 | cut -d. -f1)" -lt 20 ]; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash - >/dev/null 2>&1 && apt-get install -y nodejs >/dev/null 2>&1
fi
apt-get install -y git >/dev/null 2>&1 || true

echo "=== [2/4] repo ==="
mkdir -p /opt/darwin && cd /opt/darwin
[ -d agent-harness-generator ] || git clone --depth 1 -b "$BRANCH" https://github.com/ruvnet/agent-harness-generator.git
cd agent-harness-generator/packages/darwin-mode/bench/gaia
export OPENROUTER_API_KEY="$ORKEY"
OUT=/opt/darwin/out; mkdir -p "$OUT"

echo "=== [3/4] load → solve → score ==="
node --experimental-strip-types --no-warnings frames-loader.mjs --sample "$SAMPLE" --seed "$SEED" --out "$OUT/manifest.json" 2>&1 | tail -2
node --experimental-strip-types --no-warnings solve-gaia.mjs \
  --manifest "$OUT/manifest.json" --model "$MODEL" --max-steps "$MAXSTEPS" \
  --concurrency "$CONC" --max-cost "$MAXCOST" \
  --out "$OUT/preds-$SLUG.jsonl" --report "$OUT/report-$SLUG.json" 2>&1 | tail -6
node --experimental-strip-types --no-warnings score-gaia.mjs \
  --manifest "$OUT/manifest.json" --predictions "$OUT/preds-$SLUG.jsonl" \
  --model "$MODEL" --out "$OUT/results-$SLUG.json" 2>&1 | grep -v '^{' | tail -3

echo "=== [4/4] self-report to Firestore frames_runs ==="
RES="$OUT/results-$SLUG.json"
if [ -f "$RES" ]; then
  TOKEN=$(curl -s -H 'Metadata-Flavor: Google' 'http://metadata/computeMetadata/v1/instance/service-accounts/default/token' | node -pe 'JSON.parse(require("fs").readFileSync(0)).access_token' 2>/dev/null)
  PROJECT_ID=$(curl -s -H 'Metadata-Flavor: Google' 'http://metadata/computeMetadata/v1/project/project-id')
  # Build the Firestore document body from results.json (typed fields).
  BODY=$(node -e '
    const r=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));
    const f={
      benchmark:{stringValue:"frames"},
      model:{stringValue:r.model},
      n:{integerValue:String(r.n)},
      acc_em:{doubleValue:r.acc_em},
      correct_em:{integerValue:String(r.correct_em)},
      acc_em_ci_lo:{doubleValue:r.acc_em_wilson95[0]},
      acc_em_ci_hi:{doubleValue:r.acc_em_wilson95[1]},
      acc_relaxed:{doubleValue:r.acc_relaxed},
      total_cost_usd:{doubleValue:r.total_cost_usd},
      cost_per_task_usd:{doubleValue:r.cost_per_task_usd},
      cost_per_correct_usd:(r.cost_per_correct_usd==null?{nullValue:null}:{doubleValue:r.cost_per_correct_usd}),
      seed:{integerValue:String(r.seed)},
      scorer:{stringValue:r.scorer},
      source:{stringValue:"gcp-fleet"},
      ts:{stringValue:r.ts}
    };
    process.stdout.write(JSON.stringify({fields:f}));
  ' "$RES")
  curl -s -X POST "https://firestore.googleapis.com/v1/projects/$PROJECT_ID/databases/(default)/documents/frames_runs" \
    -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -d "$BODY" >/dev/null \
    && echo "self-reported to Firestore frames_runs" || echo "Firestore self-report FAILED (results in $OUT)"
else
  echo "WARN: no results file — nothing to report"
fi

# Per-task preds exfil. GCS is unavailable (the VM service account lacks
# storage.buckets.* perms), so we ship the full predictions array to a Firestore
# `frames_preds` collection (one doc per model, preds as a JSON string field).
# This survives AUTOSTOP+reap so post-mortem diagnosis (e.g. step-cap truncation)
# is possible without the ephemeral VM disk.
PREDS="$OUT/preds-$SLUG.jsonl"
if [ -f "$PREDS" ]; then
  TOKEN="${TOKEN:-$(curl -s -H 'Metadata-Flavor: Google' 'http://metadata/computeMetadata/v1/instance/service-accounts/default/token' | node -pe 'JSON.parse(require("fs").readFileSync(0)).access_token' 2>/dev/null)}"
  PROJECT_ID="${PROJECT_ID:-$(curl -s -H 'Metadata-Flavor: Google' 'http://metadata/computeMetadata/v1/project/project-id')}"
  PBODY=$(node -e '
    const fs=require("fs");
    const rows=fs.readFileSync(process.argv[1],"utf8").trim().split("\n").filter(Boolean).map(l=>{try{return JSON.parse(l)}catch{return null}}).filter(Boolean);
    const f={benchmark:{stringValue:"frames"},model:{stringValue:process.argv[2]},n:{integerValue:String(rows.length)},seed:{integerValue:String(process.argv[3])},maxsteps:{integerValue:String(process.argv[4])},ts:{stringValue:new Date().toISOString()},preds_json:{stringValue:JSON.stringify(rows)}};
    process.stdout.write(JSON.stringify({fields:f}));
  ' "$PREDS" "$MODEL" "$SEED" "$MAXSTEPS")
  curl -s -X POST "https://firestore.googleapis.com/v1/projects/$PROJECT_ID/databases/(default)/documents/frames_preds" \
    -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -d "$PBODY" >/dev/null \
    && echo "exfil $(wc -l <"$PREDS") preds to Firestore frames_preds" || echo "preds exfil FAILED (results in $OUT)"
fi

echo "=== DONE — results in $OUT ==="
if [ "$AUTOSTOP" = "1" ]; then echo "AUTOSTOP: halting in 90s"; (sleep 90; shutdown -h now) & fi
