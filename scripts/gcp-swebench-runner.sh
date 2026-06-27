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
  pro)      DS=ScaleAI/SWE-bench_Pro;            MANIFEST=pro-25.json ;;   # SWE-bench Pro: committed pro-25 manifest + standalone Docker eval (NOT princeton's run_evaluation)
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
# HARD set: filter the manifest to the curated hard-<board> instance IDs (the cascade's known failures).
# Fetches hard-<BENCH>-ids.json from main; overrides SAMPLE slicing. Used for SOTA-break scouting on the hard tail.
if [ "${HARD:-}" = "1" ]; then
  curl -fsSL "https://raw.githubusercontent.com/ruvnet/agent-harness-generator/main/packages/darwin-mode/bench/swebench/hard-${BENCH}-ids.json" -o /tmp/hard-ids.json 2>/dev/null || echo "WARN: hard-ids fetch failed"
  node -e "const fs=require('fs');const m=JSON.parse(fs.readFileSync('$MANIFEST','utf8'));const ids=new Set(JSON.parse(fs.readFileSync('/tmp/hard-ids.json','utf8')));const inst=m.instances.filter(i=>ids.has(i.instance_id));fs.writeFileSync('/tmp/hard.json',JSON.stringify({instances:inst}));console.error('HARD set: '+inst.length+'/'+ids.size+' instances matched')"
  MANIFEST=/tmp/hard.json; echo "using HARD set (hard-${BENCH}-ids.json)"
elif [ -n "$SAMPLE" ]; then
  node -e "const m=JSON.parse(require('fs').readFileSync('$MANIFEST','utf8'));require('fs').writeFileSync('/tmp/sample.json',JSON.stringify({instances:m.instances.slice(0,$SAMPLE)}))"
  MANIFEST=/tmp/sample.json; echo "sampled first $SAMPLE instances"
fi
CASCADE_FLAG=""; [ "$MODE" = cascade ] && [ -n "$ESCALATE" ] && CASCADE_FLAG="--cascade $ESCALATE"
# ADR-196 execution-trace localization (default OFF, backward-compatible). TRACE=1 metadata/env forwards
# --trace-localize to the ESCALATION tier of (e|x)cascade — i.e. Opus on the empty-patch give-ups, the exact
# hard-tail surface §56 showed it cracks (pylint-7228). It is deliberately NOT applied to the cheap GLM base
# (that would change the §28/§47 control behavior and burn budget on already-solved bulk). For single/cascade
# (single-tier modes) it applies to the only solve. ESC_TRACE_FLAG = the escalation-tier toggle.
TRACE_ENABLED=""; [ "${TRACE:-}" = "1" ] && TRACE_ENABLED=1
ESC_TRACE_FLAG=""; [ -n "$TRACE_ENABLED" ] && ESC_TRACE_FLAG="--trace-localize"
# single-tier modes (single/cascade/bo3/xbo base): trace applies to the base solve; cascade-base (ecascade/
# xcascade) deliberately does NOT — handled at the escalation step below.
SOLVE_TRACE_FLAG=""; case "$MODE" in ecascade|xcascade) SOLVE_TRACE_FLAG="";; *) SOLVE_TRACE_FLAG="$ESC_TRACE_FLAG";; esac
solve() { # temp out
  OPENROUTER_API_KEY="$ORKEY" node --experimental-strip-types --no-warnings solve-agentic.mjs \
    --manifest "$MANIFEST" --no-test-oracle --model "$MODEL" $CASCADE_FLAG $SOLVE_TRACE_FLAG \
    --temperature "$1" --max-steps "${MAXSTEPS:-15}" --concurrency "$CONC" --max-cost "${MAXCOST:-20}" \
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
elif [ "$MODE" = ecascade ]; then
  # Empty-patch escalation (§25): cheap model on all, then escalate ONLY the empty-patch give-ups (deterministic
  # 100%-precision gate — empty = guaranteed 0%) to $ESCALATE, merge, eval. Breaks the cheap-union ceiling.
  export OUT MANIFEST ESCALATE
  solve 0 "preds-cheap.jsonl"   # Tier 1 = $MODEL (cheap) on the full manifest
  node -e 'const fs=require("fs");const P=fs.readFileSync(process.env.OUT+"/preds-cheap.jsonl","utf8").split("\n").filter(Boolean).map(l=>JSON.parse(l));const E=new Set(P.filter(p=>!(p.model_patch||"").trim()).map(p=>p.instance_id));const m=JSON.parse(fs.readFileSync(process.env.MANIFEST,"utf8"));fs.writeFileSync("/tmp/esc-manifest.json",JSON.stringify({instances:m.instances.filter(i=>E.has(i.instance_id))}));console.error("ecascade: escalating "+E.size+" empty-patch give-ups to "+process.env.ESCALATE);'
  OPENROUTER_API_KEY="$ORKEY" node --experimental-strip-types --no-warnings solve-agentic.mjs \
    --manifest /tmp/esc-manifest.json --no-test-oracle --model "$ESCALATE" $ESC_TRACE_FLAG \
    --temperature 0 --max-steps 18 --concurrency 2 --max-cost "${ESCCOST:-120}" \
    --out "$OUT/preds-esc.jsonl" --report "$OUT/esc-report.json" || true
  node -e 'const fs=require("fs");const O=process.env.OUT;const cheap=fs.readFileSync(O+"/preds-cheap.jsonl","utf8").split("\n").filter(Boolean).map(l=>JSON.parse(l));const esc=fs.existsSync(O+"/preds-esc.jsonl")?fs.readFileSync(O+"/preds-esc.jsonl","utf8").split("\n").filter(Boolean).map(l=>JSON.parse(l)):[];const byId=Object.fromEntries(esc.map(p=>[p.instance_id,p]));const merged=cheap.map(p=>(!(p.model_patch||"").trim()&&byId[p.instance_id])?byId[p.instance_id]:p);fs.writeFileSync(O+"/preds-merged.jsonl",merged.map(p=>JSON.stringify(p)).join("\n"));console.error("ecascade: merged "+merged.length+" preds ("+esc.length+" escalated)");'
  PREDS="$OUT/preds-merged.jsonl"; MODEL="ecascade:$MODEL>$ESCALATE"
elif [ "$MODE" = xcascade ]; then
  # FUGU structure: cross-model Best-of-N (diversity) as Tier-1, then escalate the few patches where ALL base
  # models gave up to $ESCALATE (frontier). Composes the two best-measured levers (§23 xbo + §25 empty-patch).
  export OUT MANIFEST ESCALATE
  IFS=',' read -ra MS <<< "$XMODELS"; PLIST=""; i=0
  for m in "${MS[@]}"; do MODEL="$m" solve 0 "preds-x$i.jsonl"; PLIST="$PLIST,$OUT/preds-x$i.jsonl"; i=$((i+1)); done
  PLIST="${PLIST#,}"
  OPENROUTER_API_KEY="$ORKEY" node --experimental-strip-types --no-warnings discriminator.mjs \
    --manifest "$MANIFEST" --preds "$PLIST" --judge-model deepseek/deepseek-v4-flash --no-env-filter \
    --out "$OUT/preds-judged.jsonl" --report "$OUT/disc-report.json" || true
  node -e 'const fs=require("fs");const P=fs.readFileSync(process.env.OUT+"/preds-judged.jsonl","utf8").split("\n").filter(Boolean).map(l=>JSON.parse(l));const E=new Set(P.filter(p=>!(p.model_patch||"").trim()).map(p=>p.instance_id));const m=JSON.parse(fs.readFileSync(process.env.MANIFEST,"utf8"));fs.writeFileSync("/tmp/esc-manifest.json",JSON.stringify({instances:m.instances.filter(i=>E.has(i.instance_id))}));console.error("xcascade: "+E.size+" empties after cross-model base → escalate to "+process.env.ESCALATE);'
  OPENROUTER_API_KEY="$ORKEY" node --experimental-strip-types --no-warnings solve-agentic.mjs \
    --manifest /tmp/esc-manifest.json --no-test-oracle --model "$ESCALATE" $ESC_TRACE_FLAG \
    --temperature 0 --max-steps 18 --concurrency 2 --max-cost "${ESCCOST:-120}" \
    --out "$OUT/preds-esc.jsonl" --report "$OUT/esc-report.json" || true
  node -e 'const fs=require("fs");const O=process.env.OUT;const base=fs.readFileSync(O+"/preds-judged.jsonl","utf8").split("\n").filter(Boolean).map(l=>JSON.parse(l));const esc=fs.existsSync(O+"/preds-esc.jsonl")?fs.readFileSync(O+"/preds-esc.jsonl","utf8").split("\n").filter(Boolean).map(l=>JSON.parse(l)):[];const byId=Object.fromEntries(esc.map(p=>[p.instance_id,p]));const merged=base.map(p=>(!(p.model_patch||"").trim()&&byId[p.instance_id])?byId[p.instance_id]:p);fs.writeFileSync(O+"/preds-merged.jsonl",merged.map(p=>JSON.stringify(p)).join("\n"));console.error("xcascade: merged "+merged.length+" ("+esc.length+" escalated)");'
  PREDS="$OUT/preds-merged.jsonl"; MODEL="xcascade:$XMODELS>$ESCALATE"
else
  solve 0 "preds-single.jsonl"; PREDS="$OUT/preds-single.jsonl"   # MODE=single or cascade
fi

if [ "$BENCH" = pro ]; then
  echo "=== [5/5] GOLD EVAL (SWE-bench Pro standalone Docker harness) ==="
  # Pro is NOT scored by princeton's run_evaluation. Its eval is a separate vendored harness
  # (scaleapi/SWE-bench_Pro-os, root script swe_bench_pro_eval.py) that pulls the image
  # jefzda/sweap-images:<repo_base.repo_name-hash> per instance (tag is DERIVED from instance_id+repo
  # by helper_code/image_uri.get_dockerhub_image_uri — there is NO dockerhub_tag arg/column) and runs
  # fail_to_pass/pass_to_pass inside. We remap our predictions.jsonl ({instance_id, model_patch}) →
  # patches.json (a JSON ARRAY of {instance_id, patch, prefix}; model_patch→patch rename + non-empty
  # prefix used for per-instance output filenames). Upstream's helper_code/gather_patches.py instead
  # globs a --directory of pred files by --prefix, so we do the remap inline (our predictions are a
  # single jsonl, not a dir). Requires: Docker Hub egress + ~GB/image disk + the repo's run_scripts/
  # (passed via --scripts_dir, REQUIRED) + a raw-sample CSV (--raw_sample_path) with the columns the
  # script reads: instance_id, repo, base_commit, fail_to_pass, pass_to_pass, before_repo_set_cmd,
  # selected_test_files_to_run. fail_to_pass/pass_to_pass are eval'd as Python sets from the CSV cell.
  # Image caching is env-level: pulled jefzda/sweap-images layers stay in the local Docker store and
  # are reused across instances (the run container uses --rm, the images don't) — equivalent to the
  # princeton path's cache_level=env. A missing image does NOT wedge the run: eval_with_docker pulls,
  # falls back to a locally-present image, and on neither returns None → that instance scores False and
  # the harness proceeds (per-future exceptions are also caught). We `docker logout` first so the
  # public images pull anonymously even if a stale/private login is cached on the VM.
  cd /tmp
  [ -d SWE-bench_Pro-os ] || git clone --depth 1 https://github.com/scaleapi/SWE-bench_Pro-os.git || true
  if [ -d SWE-bench_Pro-os ]; then
    /opt/sweb-venv/bin/pip install -q pandas docker 2>/dev/null || true
    # export the raw Pro sample columns the eval reads, from the HF dataset, to the CSV the harness wants.
    # Also emit /tmp/pro-image-uris.txt: the DERIVED jefzda/sweap-images URI per instance (same derivation
    # the eval uses, via helper_code/image_uri.get_dockerhub_image_uri) so we can PRE-PULL them sequentially.
    /opt/sweb-venv/bin/python -c "
import json, sys, pandas as pd
sys.path.insert(0, '/tmp/SWE-bench_Pro-os')
from helper_code.image_uri import get_dockerhub_image_uri
from datasets import load_dataset
d=load_dataset('$DS', split='test')
ids=set(i['instance_id'] for i in json.load(open('/opt/darwin/agent-harness-generator/packages/darwin-mode/bench/swebench/pro-25.json'))['instances'])
cols=('instance_id','repo','base_commit','fail_to_pass','pass_to_pass','before_repo_set_cmd','selected_test_files_to_run')
rows=[{k:r[k] for k in cols} for r in d if r['instance_id'] in ids]
pd.DataFrame(rows).to_csv('/tmp/pro-sample.csv', index=False)
uris=[get_dockerhub_image_uri(r['instance_id'],'jefzda',r['repo']) for r in rows]
open('/tmp/pro-image-uris.txt','w').write('\n'.join(uris)+'\n')
print('pro sample rows:', len(rows), '/ image uris:', len(uris))
" || true
    cd SWE-bench_Pro-os
    # remap predictions jsonl → Pro patch-array format (array of {instance_id, patch, prefix})
    node -e 'const fs=require("fs");const P=fs.readFileSync(process.argv[1],"utf8").split("\n").filter(Boolean).map(l=>JSON.parse(l));const out=P.map(p=>({instance_id:p.instance_id,patch:p.model_patch||"",prefix:"darwin"}));fs.writeFileSync("/tmp/patches.json",JSON.stringify(out));console.error("gather: "+out.length+" patches")' "$PREDS"
    # === RELIABILITY FIX (§41): PRE-PULL all images SEQUENTIALLY before scoring ===
    # The eval pulls one multi-GB jefzda/sweap-images per instance inside each worker thread; N concurrent
    # ANONYMOUS pulls trip Docker Hub's rate limit, the pull returns None, and main() silently scores that
    # instance False — the artifactual ~4% floor. We pre-pull every image ONCE, SEQUENTIALLY, with
    # retry+backoff (and an optional free Docker Hub login via DOCKERHUB_USER/DOCKERHUB_TOKEN to raise the
    # anon limit). Validated 2026-06-25: gold patches → 5/5 once images are present.
    PREPULL_SH=/opt/darwin/agent-harness-generator/scripts/pro-prepull-images.sh
    PREPULL_OK=1
    if [ -f "$PREPULL_SH" ] && [ -f /tmp/pro-image-uris.txt ]; then
      bash "$PREPULL_SH" /tmp/pro-image-uris.txt || PREPULL_OK=0
    else
      echo "WARN: prepull script or uri list missing — eval will pull in-worker (rate-limit risk)"
    fi
    # HARD-ERROR on un-pullable images: a missing image MUST NOT silently become a False.
    # Verify every required image is present locally before scoring; abort the Pro eval if any is missing
    # (the predictions remain in $PREDS for an offline re-score once the image situation is resolved).
    MISSING=$(while IFS= read -r u; do u=$(echo "$u"|tr -d '[:space:]'); [ -z "$u" ] && continue; docker image inspect "$u" >/dev/null 2>&1 || echo "$u"; done < /tmp/pro-image-uris.txt)
    if [ -n "$MISSING" ]; then
      echo "FATAL: Pro eval images NOT present after pre-pull (would score these False silently):"
      echo "$MISSING" | sed 's/^/  /'
      echo "These are either Docker Hub rate-limit casualties (retry / add DOCKERHUB_USER+DOCKERHUB_TOKEN)"
      echo "or genuinely absent from the registry (a dataset/registry issue, not the runner's)."
      echo "Refusing to emit a misleading score. Predictions are in $PREDS for offline re-scoring."
    else
      echo "prepull: all Pro images present locally — eval pulls become no-op cache hits, no rate-limit exposure."
    fi
    # run the Pro Docker eval (public images already cached locally; --dockerhub_username=jefzda);
    # --scripts_dir is REQUIRED; parallelism flag is --num_workers (NOT --max_workers); --use_local_docker
    # runs on the VM's Docker (not Modal); writes $OUT/eval_results.json {id: bool}. Because every image is
    # pre-pulled, the in-worker pull is a cache hit, so --num_workers can parallelize the CONTAINER RUNS
    # safely without re-triggering the anon rate limit.
    [ -z "$MISSING" ] && [ -f swe_bench_pro_eval.py ] && /opt/sweb-venv/bin/python swe_bench_pro_eval.py \
      --patch_path /tmp/patches.json --raw_sample_path /tmp/pro-sample.csv \
      --scripts_dir run_scripts --dockerhub_username jefzda --use_local_docker \
      --output_dir "$OUT" --num_workers "$CONC" 2>&1 || echo "Pro eval not run (missing images) / failed — predictions are in $PREDS (re-score offline with scaleapi/SWE-bench_Pro-os)"
    # normalize Pro's flat {instance_id: bool} eval_results.json into a {resolved_ids:[...]} report
    # so the [6/6] Firestore self-report (which reads .resolved_ids) works for Pro too.
    [ -f "$OUT/eval_results.json" ] && node -e 'const fs=require("fs");const m=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));const resolved_ids=Object.keys(m).filter(k=>m[k]===true);fs.writeFileSync(process.argv[2],JSON.stringify({resolved_ids,total_instances:Object.keys(m).length}));console.error("pro report: "+resolved_ids.length+"/"+Object.keys(m).length+" resolved")' "$OUT/eval_results.json" "$OUT/darwin-$BENCH-$SLUG-$MODE.report.json"
  else
    echo "Pro eval repo unavailable — predictions in $PREDS; score offline with scaleapi/SWE-bench_Pro-os"
  fi
else
  echo "=== [5/5] GOLD EVAL (official harness) ==="
  cd /tmp
  /opt/sweb-venv/bin/python -m swebench.harness.run_evaluation \
    --dataset_name "$DS" --predictions_path "$PREDS" \
    --run_id "darwin-$BENCH-$SLUG-$MODE" --max_workers "$CONC" --cache_level env --timeout 1200 || true
    # cache_level=env (NOT instance): keeps shared base/env images, removes the 300 per-instance images after each —
    # `instance` filled the 200GB disk on full-300 (300×~1GB) → most instances failed to build → artifactual ~14%.
  cp -f /tmp/*darwin-$BENCH-$SLUG-$MODE*.json "$OUT/" 2>/dev/null || true
fi

echo "=== [6/6] self-report to Firestore (via VM service-account token) ==="
REPORT=$(ls "$OUT"/*darwin-$BENCH-$SLUG-$MODE*.json 2>/dev/null | head -1)
if [ -n "$REPORT" ]; then
  TOKEN=$(curl -s -H 'Metadata-Flavor: Google' 'http://metadata/computeMetadata/v1/instance/service-accounts/default/token' | node -pe 'JSON.parse(require("fs").readFileSync(0)).access_token' 2>/dev/null)
  PROJECT_ID=$(curl -s -H 'Metadata-Flavor: Google' 'http://metadata/computeMetadata/v1/project/project-id')
  RESOLVED=$(node -pe "(JSON.parse(require('fs').readFileSync('$REPORT')).resolved_ids||[]).length" 2>/dev/null || echo 0)
  if [ -n "$SAMPLE" ]; then TOTAL=$SAMPLE; else case "$BENCH" in verified) TOTAL=500;; multilingual) TOTAL=300;; pro) TOTAL=25;; *) TOTAL=300;; esac; fi  # denom = actual instances run (SAMPLE-aware)
  PCT=$(node -pe "($RESOLVED/$TOTAL*100).toFixed(1)")
  curl -s -X POST "https://firestore.googleapis.com/v1/projects/$PROJECT_ID/databases/(default)/documents/darwin_runs" \
    -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
    -d "{\"fields\":{\"benchmark\":{\"stringValue\":\"$BENCH\"},\"model\":{\"stringValue\":\"$MODEL\"},\"mode\":{\"stringValue\":\"$MODE\"},\"resolved\":{\"integerValue\":\"$RESOLVED\"},\"total\":{\"integerValue\":\"$TOTAL\"},\"resolve_pct\":{\"doubleValue\":$PCT},\"conformant\":{\"booleanValue\":true},\"source\":{\"stringValue\":\"gcp-fleet\"},\"ts\":{\"stringValue\":\"$(date -I)\"}}}" >/dev/null \
    && echo "self-reported $RESOLVED/$TOTAL = $PCT% to Firestore darwin_runs" || echo "Firestore self-report failed (results still in $OUT)"
fi
echo "=== DONE — results in $OUT ==="
# Cost-saver: halt the VM after a short grace (results already self-reported to Firestore). AUTOSTOP=0 to keep alive for debugging.
if [ "${AUTOSTOP:-1}" = "1" ]; then echo "AUTOSTOP: halting VM in 2 min (compute billing stops; controller deletes terminated VMs)"; (sleep 120; shutdown -h now) & fi
