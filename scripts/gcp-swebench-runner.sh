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

echo "=== [4/5] SOLVE ($BENCH, $MODE) — interactive ReAct, conformant ==="
OUT=/opt/darwin/out; mkdir -p "$OUT"
solve() { # temp out
  OPENROUTER_API_KEY="$ORKEY" node --experimental-strip-types --no-warnings solve-agentic.mjs \
    --manifest "$MANIFEST" --no-test-oracle --model "$MODEL" \
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
else
  solve 0 "preds-single.jsonl"; PREDS="$OUT/preds-single.jsonl"
fi

echo "=== [5/5] GOLD EVAL (official harness) ==="
cd /tmp
/opt/sweb-venv/bin/python -m swebench.harness.run_evaluation \
  --dataset_name "$DS" --predictions_path "$PREDS" \
  --run_id "darwin-$BENCH-$SLUG-$MODE" --max_workers "$CONC" --cache_level instance --timeout 1200 || true
cp -f /tmp/*darwin-$BENCH-$SLUG-$MODE*.json "$OUT/" 2>/dev/null || true
echo "=== DONE — results in $OUT ; retrieve with: gcloud compute scp --recurse VM:$OUT ./ ==="
