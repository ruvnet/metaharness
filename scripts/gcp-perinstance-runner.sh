#!/usr/bin/env bash
# gcp-perinstance-runner.sh — PER-INSTANCE k-sample DIAGNOSIS runner for the SWE-bench HARD tail.
#
# ⚠️ CONFORMANCE FIREWALL (the central design constraint — read this before touching anything):
#   This script exists ONLY to DIAGNOSE which GENERAL harness capability cracks ONE hard instance.
#   It k-sample-solves a SINGLE instance under a capability config (genome) and gold-scores each
#   sample. The gold tests are used ONLY to SCORE the finished patches — they are NEVER seen by the
#   solver (solve-agentic.mjs runs with --no-test-oracle; the in-loop signal is the repo's own
#   pre-existing tests). The resulting k-sample resolve rate is a DIAGNOSIS, NOT a claimable result:
#   a config evolved per-instance against the gold pass is, by construction, OVERFIT to that instance
#   (tuning-on-the-test, HV-1). The deliverable is the COVERAGE MAP + the GENERALIZABLE capability
#   set, which must be validated as ONE conformant harness on held-out n=300 with zero per-instance
#   gold tuning. NEVER make a leaderboard/SOTA claim from a darwin_inst_runs document.
#
# Inputs via instance metadata (set by evolve-perinstance.mjs → gcp dispatch):
#   orkey      = OpenRouter API key (required)
#   instance   = the single SWE-bench Lite instance_id to diagnose (required)
#   gkey       = the genome identity key (for Firestore readback; e.g. xbo|opus+glm|s15)
#   mode       = single | cascade | bo3 | xbo            (capability lever)
#   model      = base model slug (single/cascade/bo3)    OR unused for xbo
#   escalate   = tier-2 model slug (cascade)
#   xmodels    = comma-list of distinct models (xbo)
#   ksamp      = number of independent samples (default 2; >=2 beats binary noise)
#   maxsteps   = solver step budget (default 15)
#   temp       = base temperature (default 0; samples jitter around it for diversity)
#   branch     = git branch (default claude/darwin-mode-evolve-polyglot)
#
# Self-reports ONE doc to Firestore collection `darwin_inst_runs`:
#   { instance_id, gkey, mode, model, ksamp, resolved_k, resolved_pct, conformant:true,
#     diagnosis:true, capability, source:"gcp-perinst", ts }
set -uo pipefail   # NOT -e: a single failed sample must not abort the whole k-loop
M(){ curl -sf -H 'Metadata-Flavor: Google' "http://metadata/computeMetadata/v1/instance/attributes/$1" 2>/dev/null || true; }
ORKEY="${ORKEY:-$(M orkey)}"; INSTANCE="${INSTANCE:-$(M instance)}"; GKEY="${GKEY:-$(M gkey)}"
MODE="${MODE:-$(M mode)}"; MODEL="${MODEL:-$(M model)}"; ESCALATE="${ESCALATE:-$(M escalate)}"
XMODELS="${XMODELS:-$(M xmodels)}"; KSAMP="${KSAMP:-$(M ksamp)}"; MAXSTEPS="${MAXSTEPS:-$(M maxsteps)}"
TEMP="${TEMP:-$(M temp)}"; BRANCH="${BRANCH:-$(M branch)}"
MODE="${MODE:-single}"; KSAMP="${KSAMP:-2}"; MAXSTEPS="${MAXSTEPS:-15}"; TEMP="${TEMP:-0}"
BRANCH="${BRANCH:-claude/darwin-mode-evolve-polyglot}"
DS=princeton-nlp/SWE-bench_Lite
[ -n "$ORKEY" ] || { echo "FATAL: ORKEY not set"; exit 1; }
[ -n "$INSTANCE" ] || { echo "FATAL: instance not set"; exit 1; }

echo "=== [1/5] system deps ==="
export DEBIAN_FRONTEND=noninteractive
if ! command -v docker >/dev/null; then curl -fsSL https://get.docker.com | sh; fi
if ! command -v node >/dev/null || [ "$(node -v | cut -dv -f2 | cut -d. -f1)" -lt 20 ]; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash - && apt-get install -y nodejs
fi
apt-get update -y >/dev/null 2>&1 || true
apt-get install -y python3 python3-venv python3-pip git >/dev/null 2>&1 || true

echo "=== [2/5] repo + solver ==="
mkdir -p /opt/darwin && cd /opt/darwin
[ -d agent-harness-generator ] || git clone --depth 1 -b "$BRANCH" https://github.com/ruvnet/agent-harness-generator.git
cd agent-harness-generator/packages/darwin-mode/bench/swebench
echo "$ORKEY" > /tmp/.orkey
export OPENROUTER_API_KEY="$ORKEY"

echo "=== [3/5] swebench harness venv ==="
python3 -m venv /tmp/swebench-venv
/tmp/swebench-venv/bin/pip install -q --upgrade pip
/tmp/swebench-venv/bin/pip install -q swebench datasets

echo "=== [4/5] single-instance manifest ($INSTANCE) ==="
# Build a manifest containing ONLY this instance from full-300.json (committed).
node -e '
const fs=require("fs");
const m=JSON.parse(fs.readFileSync("full-300.json","utf8"));
const inst=m.instances.filter(i=>i.instance_id===process.argv[1]);
if(!inst.length){console.error("FATAL: instance not in full-300.json: "+process.argv[1]);process.exit(2);}
fs.writeFileSync("/tmp/one.json",JSON.stringify({instances:inst}));
console.error("manifest: 1 instance — "+inst[0].instance_id+" ("+inst[0].repo+")");
' "$INSTANCE"
OUT=/opt/darwin/out; mkdir -p "$OUT"

# CAPABILITY -> solver invocation. The genome encodes GENERAL capabilities (firewall):
#   single  : one cold solve at temp t (the baseline capability)
#   cascade : cheap base, then COLD escalate to $ESCALATE on a repo-gate miss (turn-budget+model lever)
#   bo3     : 3 independent trajectories on the SAME model, judge-pick (Best-of-N width capability)
#   xbo     : 1 trajectory per DISTINCT model, judge-pick (cross-model Best-of-N capability)
# Each capability invocation is run as ONE "sample"; we repeat the whole thing KSAMP times for k-sample
# resolve. The judge / cascade NEVER see gold — they pick among patches; gold scores the chosen patch.
ACTIVATE=". /tmp/swebench-venv/bin/activate"

# gold-score one predictions file for $INSTANCE; echoes 1 (resolved) or 0.
gold_score() { # predsfile runid
  local PREDS="$1" RID="$2"
  ( eval "$ACTIVATE" && cd /tmp && python -m swebench.harness.run_evaluation \
      --dataset_name "$DS" --predictions_path "$PREDS" --instance_ids "$INSTANCE" \
      --run_id "$RID" --max_workers 1 --cache_level instance --timeout 1200 ) >/dev/null 2>&1 || true
  node -e '
    const fs=require("fs");
    try{const rep=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));
      process.stdout.write((rep.resolved_ids||[]).includes(process.argv[2])?"1":"0");}
    catch{process.stdout.write("0");}
  ' "/tmp/darwin-pi.${RID}.json" "$INSTANCE" 2>/dev/null || echo -n 0
}

# produce ONE candidate patch for $INSTANCE under the genome's capability; writes preds to $1.
solve_one() { # outpreds tempval tag
  local PREDS="$1" T="$2" TAG="$3"
  case "$MODE" in
    xbo)
      # cross-model Best-of-N: one trajectory per distinct model, judge-pick (conformant, no gold).
      IFS=',' read -ra MS <<< "$XMODELS"; local PLIST="" i=0
      for m in "${MS[@]}"; do
        node --experimental-strip-types --no-warnings solve-agentic.mjs \
          --manifest /tmp/one.json --instance "$INSTANCE" --no-test-oracle --model "$m" \
          --temperature "$T" --max-steps "$MAXSTEPS" --concurrency 1 --max-cost 30 \
          --out "$OUT/pi-$TAG-x$i.jsonl" --report "$OUT/pi-$TAG-x$i-rep.json" >/dev/null 2>&1 || true
        PLIST="$PLIST,$OUT/pi-$TAG-x$i.jsonl"; i=$((i+1))
      done
      PLIST="${PLIST#,}"
      node --experimental-strip-types --no-warnings discriminator.mjs \
        --manifest /tmp/one.json --preds "$PLIST" --judge-model deepseek/deepseek-v4-flash \
        --no-env-filter --out "$PREDS" --report "$OUT/pi-$TAG-disc.json" >/dev/null 2>&1 || true
      ;;
    bo3)
      # Best-of-N width on ONE model: 3 trajectories at jittered temps, judge-pick.
      node --experimental-strip-types --no-warnings solve-agentic.mjs --manifest /tmp/one.json --instance "$INSTANCE" --no-test-oracle --model "$MODEL" --temperature 0   --max-steps "$MAXSTEPS" --concurrency 1 --max-cost 30 --out "$OUT/pi-$TAG-a.jsonl" --report "$OUT/pi-$TAG-a-rep.json" >/dev/null 2>&1 || true
      node --experimental-strip-types --no-warnings solve-agentic.mjs --manifest /tmp/one.json --instance "$INSTANCE" --no-test-oracle --model "$MODEL" --temperature 0.3 --max-steps "$MAXSTEPS" --concurrency 1 --max-cost 30 --out "$OUT/pi-$TAG-b.jsonl" --report "$OUT/pi-$TAG-b-rep.json" >/dev/null 2>&1 || true
      node --experimental-strip-types --no-warnings solve-agentic.mjs --manifest /tmp/one.json --instance "$INSTANCE" --no-test-oracle --model "$MODEL" --temperature 0.5 --max-steps "$MAXSTEPS" --concurrency 1 --max-cost 30 --out "$OUT/pi-$TAG-c.jsonl" --report "$OUT/pi-$TAG-c-rep.json" >/dev/null 2>&1 || true
      node --experimental-strip-types --no-warnings discriminator.mjs \
        --manifest /tmp/one.json --preds "$OUT/pi-$TAG-a.jsonl,$OUT/pi-$TAG-b.jsonl,$OUT/pi-$TAG-c.jsonl" \
        --judge-model deepseek/deepseek-v4-flash --no-env-filter --out "$PREDS" --report "$OUT/pi-$TAG-disc.json" >/dev/null 2>&1 || true
      ;;
    cascade)
      # cheap base, then COLD escalate to $ESCALATE if the base patch misses the repo's own tests.
      local CASC=""; [ -n "$ESCALATE" ] && CASC="--cascade $ESCALATE"
      node --experimental-strip-types --no-warnings solve-agentic.mjs \
        --manifest /tmp/one.json --instance "$INSTANCE" --no-test-oracle --model "$MODEL" $CASC \
        --temperature "$T" --max-steps "$MAXSTEPS" --concurrency 1 --max-cost 60 \
        --out "$PREDS" --report "$OUT/pi-$TAG-rep.json" >/dev/null 2>&1 || true
      ;;
    *)
      # single: one cold trajectory.
      node --experimental-strip-types --no-warnings solve-agentic.mjs \
        --manifest /tmp/one.json --instance "$INSTANCE" --no-test-oracle --model "$MODEL" \
        --temperature "$T" --max-steps "$MAXSTEPS" --concurrency 1 --max-cost 40 \
        --out "$PREDS" --report "$OUT/pi-$TAG-rep.json" >/dev/null 2>&1 || true
      ;;
  esac
}

echo "=== [5/5] k-sample DIAGNOSIS: instance=$INSTANCE mode=$MODE k=$KSAMP (gold scores only, never seen by solver) ==="
RESOLVED_K=0
for s in $(seq 1 "$KSAMP"); do
  # jitter temp per sample so independent samples explore differently (binary-noise mitigation).
  ST=$(node -pe "Math.min(0.8,(${TEMP}||0)+0.2*(${s}-1)).toFixed(2)")
  PREDS="$OUT/pi-sample-$s.jsonl"
  echo "--- sample $s/$KSAMP (temp=$ST) ---"
  solve_one "$PREDS" "$ST" "s$s"
  RID="pi_${INSTANCE//[^a-zA-Z0-9_]/_}_$s"
  R=$(gold_score "$PREDS" "$RID")
  echo "sample $s gold-resolved: $R"
  RESOLVED_K=$((RESOLVED_K + R))
done
PCT=$(node -pe "($RESOLVED_K/$KSAMP*100).toFixed(1)")
CAP="$MODE"
echo "DIAGNOSIS RESULT: $INSTANCE under [$GKEY] -> $RESOLVED_K/$KSAMP resolved ($PCT%)  capability=$CAP"

echo "=== self-report to Firestore darwin_inst_runs (DIAGNOSIS, not claimable) ==="
TOKEN=$(curl -s -H 'Metadata-Flavor: Google' 'http://metadata/computeMetadata/v1/instance/service-accounts/default/token' | node -pe 'JSON.parse(require("fs").readFileSync(0)).access_token' 2>/dev/null)
PROJECT_ID=$(curl -s -H 'Metadata-Flavor: Google' 'http://metadata/computeMetadata/v1/project/project-id')
MSTR="$MODEL"; [ "$MODE" = xbo ] && MSTR="xbo:$XMODELS"; [ "$MODE" = cascade ] && MSTR="cascade:$MODEL>$ESCALATE"
curl -s -X POST "https://firestore.googleapis.com/v1/projects/$PROJECT_ID/databases/(default)/documents/darwin_inst_runs" \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d "{\"fields\":{\"instance_id\":{\"stringValue\":\"$INSTANCE\"},\"gkey\":{\"stringValue\":\"$GKEY\"},\"mode\":{\"stringValue\":\"$MODE\"},\"model\":{\"stringValue\":\"$MSTR\"},\"ksamp\":{\"integerValue\":\"$KSAMP\"},\"resolved_k\":{\"integerValue\":\"$RESOLVED_K\"},\"resolved_pct\":{\"doubleValue\":$PCT},\"capability\":{\"stringValue\":\"$CAP\"},\"conformant\":{\"booleanValue\":true},\"diagnosis\":{\"booleanValue\":true},\"source\":{\"stringValue\":\"gcp-perinst\"},\"ts\":{\"stringValue\":\"$(date -I)\"}}}" >/dev/null \
  && echo "self-reported $RESOLVED_K/$KSAMP to darwin_inst_runs ($INSTANCE / $GKEY)" || echo "Firestore self-report failed (results in $OUT)"

echo "=== DONE ($INSTANCE / $GKEY) — results in $OUT ==="
if [ "${AUTOSTOP:-1}" = "1" ]; then echo "AUTOSTOP: halting VM in 2 min"; (sleep 120; shutdown -h now) & fi
