#!/usr/bin/env bash
# GCP VM runner: solve + gold-eval a SWE-bench split with the Darwin interactive solver.
# Designed to run as a GCE startup-script OR by hand after `gcloud compute ssh`.
#
# Inputs via env (or instance metadata):
#   BENCH      = verified | lite            (default verified)
#   MODE       = single | bo3              (default single)  -- bo3 = Best-of-3 + judge
#   ORKEY      = OpenRouter API key         (required; pass via metadata orkey)
#   BRANCH     = git branch                 (default claude/darwin-mode-evolve-polyglot)
#   CONCURRENCY= solver concurrency         (default 3)
#
# Result artifacts land in /opt/darwin/out/ for retrieval via `gcloud compute scp`.
set -euo pipefail
BENCH="${BENCH:-verified}"; MODE="${MODE:-single}"; CONC="${CONCURRENCY:-3}"
MODEL="${MODEL:-deepseek/deepseek-v4-flash}"; SLUG="$(echo "$MODEL" | tr '/:.' '-' )"
ESCALATE="${ESCALATE:-}"          # tier-2 model for MODE=cascade
SAMPLE="${SAMPLE:-}"              # if set, run only the first N instances (early proving)
XMODELS="${XMODELS:-}"           # MODE=xbo: comma-separated DIFFERENT models for cross-model Best-of-N (union-raiser)
BRANCH="${BRANCH:-claude/darwin-mode-evolve-polyglot}"
ORKEY="${ORKEY:-$(curl -s -H 'Metadata-Flavor: Google' 'http://metadata/computeMetadata/v1/instance/attributes/orkey' 2>/dev/null || true)}"
[ -n "$ORKEY" ] || { echo "FATAL: ORKEY not set"; exit 1; }
case "$BENCH" in
  verified) DS=princeton-nlp/SWE-bench_Verified; MANIFEST=verified-500.json ;;
  lite)     DS=princeton-nlp/SWE-bench_Lite;     MANIFEST=full-300.json ;;
  *) echo "unknown BENCH=$BENCH"; exit 1 ;;
esac

echo "=== [1/5] system deps ==="
export DEBIAN_FRONTEND=noninteractive
if ! command -v docker >/dev/null; then
  curl -fsSL https://get.docker.com | sh
fi
if ! command -v node >/dev/null || [ "$(node -v | cut -dv -f2 | cut -d. -f1)" -lt 20 ]; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash - && apt-get install -y nodejs
fi
apt-get update -y >/dev/null 2>&1 || true
apt-get install -y python3 python3-venv python3-pip git >/dev/null 2>&1 || true   # python3-venv MUST be explicit (Ubuntu ships python3 without ensurepip)

echo "=== [2/5] repo + solver ==="
mkdir -p /opt/darwin && cd /opt/darwin
[ -d agent-harness-generator ] || git clone --depth 1 -b "$BRANCH" https://github.com/ruvnet/agent-harness-generator.git
cd agent-harness-generator/packages/darwin-mode/bench/swebench
echo "$ORKEY" > /tmp/.orkey

echo "=== [3/5] swebench harness venv ==="
python3 -m venv /opt/sweb-venv
/opt/sweb-venv/bin/pip install -q --upgrade pip
/opt/sweb-venv/bin/pip install -q swebench datasets

echo "=== [4/5] SOLVE ($BENCH, $MODE, sample=${SAMPLE:-full}) — interactive ReAct, conformant ==="
OUT=/opt/darwin/out; mkdir -p "$OUT"
# Generate the manifest from the HF dataset if it isn't committed (robust for any board — fixes verified-500 ENOENT).
if [ ! -f "$MANIFEST" ]; then
  echo "manifest $MANIFEST missing — generating from $DS"
  /opt/sweb-venv/bin/python -c "
import json
from datasets import load_dataset
d=load_dataset('$DS', split='test')
inst=[{'instance_id':r['instance_id'],'repo':r['repo'],'base_commit':r['base_commit'],'problem_statement':r['problem_statement']} for r in d]
json.dump({'instances':inst}, open('$MANIFEST','w')); print('generated', len(inst), 'instances')
"
fi
# Early proving: slice the manifest to the first SAMPLE instances for a fast architecture pilot.
if [ -n "$SAMPLE" ]; then
  node -e "const m=JSON.parse(require('fs').readFileSync('$MANIFEST','utf8'));require('fs').writeFileSync('/tmp/sample.json',JSON.stringify({instances:m.instances.slice(0,$SAMPLE)}))"
  MANIFEST=/tmp/sample.json; echo "sampled first $SAMPLE instances"
fi
CASCADE_FLAG=""; [ "$MODE" = cascade ] && [ -n "$ESCALATE" ] && CASCADE_FLAG="--cascade $ESCALATE"
solve() { # temp out
  OPENROUTER_API_KEY="$ORKEY" node --experimental-strip-types --no-warnings solve-agentic.mjs \
    --manifest "$MANIFEST" --no-test-oracle --model "$MODEL" $CASCADE_FLAG \
    --temperature "$1" --max-steps 15 --concurrency "$CONC" --max-cost 20 \
    --out "$OUT/$2" --report "$OUT/${2%.jsonl}-report.json"
}
if [ "$MODE" = bo3 ]; then
  solve 0   "preds-A.jsonl"; solve 0.3 "preds-B.jsonl"; solve 0.5 "preds-C.jsonl"
  OPENROUTER_API_KEY="$ORKEY" node --experimental-strip-types --no-warnings discriminator.mjs \
    --manifest "$MANIFEST" --preds "$OUT/preds-A.jsonl,$OUT/preds-B.jsonl,$OUT/preds-C.jsonl" \
    --judge-model deepseek/deepseek-v4-flash --no-env-filter \
    --out "$OUT/preds-judged.jsonl" --report "$OUT/disc-report.json"
  PREDS="$OUT/preds-judged.jsonl"
elif [ "$MODE" = xbo ]; then
  # cross-model Best-of-N: solve once with each DIFFERENT model (orthogonal failure modes → higher union), then judge.
  IFS=',' read -ra MS <<< "$XMODELS"; PLIST=""; i=0
  for m in "${MS[@]}"; do MODEL="$m" solve 0 "preds-x$i.jsonl"; PLIST="$PLIST,$OUT/preds-x$i.jsonl"; i=$((i+1)); done
  PLIST="${PLIST#,}"
  OPENROUTER_API_KEY="$ORKEY" node --experimental-strip-types --no-warnings discriminator.mjs \
    --manifest "$MANIFEST" --preds "$PLIST" --judge-model deepseek/deepseek-v4-flash --no-env-filter \
    --out "$OUT/preds-judged.jsonl" --report "$OUT/disc-report.json"
  PREDS="$OUT/preds-judged.jsonl"; MODEL="xbo:$XMODELS"   # label for self-report
else
  solve 0 "preds-single.jsonl"; PREDS="$OUT/preds-single.jsonl"   # MODE=single or cascade
fi

echo "=== [5/5] GOLD EVAL (official harness) ==="
cd /tmp
/opt/sweb-venv/bin/python -m swebench.harness.run_evaluation \
  --dataset_name "$DS" --predictions_path "$PREDS" \
  --run_id "darwin-$BENCH-$SLUG-$MODE" --max_workers "$CONC" --cache_level instance --timeout 1200 || true
cp -f /tmp/*darwin-$BENCH-$SLUG-$MODE*.json "$OUT/" 2>/dev/null || true

echo "=== [6/6] self-report to Firestore (via VM service-account token) ==="
REPORT=$(ls "$OUT"/*darwin-$BENCH-$SLUG-$MODE*.json 2>/dev/null | head -1)
if [ -n "$REPORT" ]; then
  TOKEN=$(curl -s -H 'Metadata-Flavor: Google' 'http://metadata/computeMetadata/v1/instance/service-accounts/default/token' | node -pe 'JSON.parse(require("fs").readFileSync(0)).access_token' 2>/dev/null)
  PROJECT_ID=$(curl -s -H 'Metadata-Flavor: Google' 'http://metadata/computeMetadata/v1/project/project-id')
  RESOLVED=$(node -pe "(JSON.parse(require('fs').readFileSync('$REPORT')).resolved_ids||[]).length" 2>/dev/null || echo 0)
  if [ -n "$SAMPLE" ]; then TOTAL=$SAMPLE; else case "$BENCH" in verified) TOTAL=500;; multilingual) TOTAL=300;; *) TOTAL=300;; esac; fi  # denom = actual instances run (SAMPLE-aware)
  PCT=$(node -pe "($RESOLVED/$TOTAL*100).toFixed(1)")
  curl -s -X POST "https://firestore.googleapis.com/v1/projects/$PROJECT_ID/databases/(default)/documents/darwin_runs" \
    -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
    -d "{\"fields\":{\"benchmark\":{\"stringValue\":\"$BENCH\"},\"model\":{\"stringValue\":\"$MODEL\"},\"mode\":{\"stringValue\":\"$MODE\"},\"resolved\":{\"integerValue\":\"$RESOLVED\"},\"total\":{\"integerValue\":\"$TOTAL\"},\"resolve_pct\":{\"doubleValue\":$PCT},\"conformant\":{\"booleanValue\":true},\"source\":{\"stringValue\":\"gcp-fleet\"},\"ts\":{\"stringValue\":\"$(date -I)\"}}}" >/dev/null \
    && echo "self-reported $RESOLVED/$TOTAL = $PCT% to Firestore darwin_runs" || echo "Firestore self-report failed (results still in $OUT)"
fi
echo "=== DONE — results in $OUT ==="
# Cost-saver: halt the VM after a short grace (results already self-reported to Firestore). AUTOSTOP=0 to keep alive for debugging.
if [ "${AUTOSTOP:-1}" = "1" ]; then echo "AUTOSTOP: halting VM in 2 min (compute billing stops; controller deletes terminated VMs)"; (sleep 120; shutdown -h now) & fi
