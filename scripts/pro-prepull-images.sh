#!/usr/bin/env bash
# Pre-pull the jefzda/sweap-images required by a SWE-bench Pro eval BEFORE scoring.
#
# WHY THIS EXISTS (the §41 blocker fix):
#   The Pro eval (scaleapi/SWE-bench_Pro-os swe_bench_pro_eval.py) pulls one large
#   jefzda/sweap-images:<dockerhub_tag> per instance INSIDE each worker thread. With
#   --num_workers>1 that fires N concurrent ANONYMOUS Docker Hub pulls of multi-GB
#   images, which trips Docker Hub's anonymous rate limit. On a pull failure
#   eval_with_docker returns None → main() scores that instance False — SILENTLY.
#   Net effect: most instances score False on image-pull, producing an artifactual
#   ~4% floor that looks like a solver failure but is pure eval-infra failure.
#
#   Validated 2026-06-25: gold patches on the first 5 Pro instances score 5/5 (100%)
#   once the 5 images are present locally. Sequential anon pulls of those 5 (1.6-3.2GB
#   each) completed with ZERO rate-limit hits. So: pull every needed image ONCE,
#   SEQUENTIALLY, with retry+backoff, BEFORE the eval, and treat a genuinely
#   un-pullable image as a HARD ERROR (not a silent False).
#
# Inputs:
#   $1 = file with one image URI per line (jefzda/sweap-images:<tag>)
# Env:
#   PREPULL_RETRIES   per-image attempts (default 6)
#   DOCKERHUB_USER    optional Docker Hub username for `docker login` (raises anon
#                     rate limit ~6x); pair with DOCKERHUB_TOKEN. If unset, anon pulls.
#   DOCKERHUB_TOKEN   Docker Hub PAT/password for the login above.
#
# Exit code = number of images that could NOT be pulled (0 == all present).
set -u
URIS_FILE="${1:?usage: pro-prepull-images.sh <uris-file>}"
RETRIES="${PREPULL_RETRIES:-6}"

# Optional auth: a free Docker Hub login raises the anon rate limit substantially.
# If creds aren't provided we pull anonymously (validated to work sequentially).
if [ -n "${DOCKERHUB_USER:-}" ] && [ -n "${DOCKERHUB_TOKEN:-}" ]; then
  echo "$DOCKERHUB_TOKEN" | docker login -u "$DOCKERHUB_USER" --password-stdin >/dev/null 2>&1 \
    && echo "prepull: logged in to Docker Hub as $DOCKERHUB_USER (higher rate limit)" \
    || echo "prepull: docker login FAILED — falling back to anonymous sequential pulls"
else
  # Ensure no stale/private login forces a private namespace lookup on public images.
  docker logout >/dev/null 2>&1 || true
  echo "prepull: pulling anonymously (sequential + backoff to dodge the anon rate limit)"
fi

ok=0; fail=0; FAILED=""
while IFS= read -r uri; do
  uri="$(echo "$uri" | tr -d '[:space:]')"
  [ -z "$uri" ] && continue
  if docker image inspect "$uri" >/dev/null 2>&1; then
    echo "CACHED   $uri"; ok=$((ok+1)); continue
  fi
  attempt=0; pulled=0
  while [ "$attempt" -lt "$RETRIES" ]; do
    attempt=$((attempt+1))
    t0=$(date +%s)
    if docker pull "$uri" >/tmp/prepull-pull.log 2>&1; then
      t1=$(date +%s); echo "PULLED   $uri  (attempt $attempt, $((t1-t0))s)"; pulled=1; ok=$((ok+1)); break
    fi
    if grep -qiE "toomanyrequests|rate limit|429|too many requests" /tmp/prepull-pull.log; then
      bo=$((attempt*45)); echo "RATELIMIT $uri (attempt $attempt) — backoff ${bo}s"; sleep "$bo"
    elif grep -qiE "manifest unknown|not found|repository does not exist|no such manifest" /tmp/prepull-pull.log; then
      # Genuine not-found → don't waste retries; report as a dataset/registry issue.
      echo "NOTFOUND $uri (image absent from registry — dataset/registry issue)"; break
    else
      tail -2 /tmp/prepull-pull.log; bo=$((attempt*15)); echo "RETRY    $uri (attempt $attempt) — backoff ${bo}s"; sleep "$bo"
    fi
  done
  if [ "$pulled" -eq 0 ]; then echo "FAILED   $uri"; fail=$((fail+1)); FAILED="$FAILED $uri"; fi
done < "$URIS_FILE"

echo "=== PREPULL SUMMARY: ok=$ok fail=$fail ==="
if [ -n "$FAILED" ]; then
  echo "UN-PULLABLE IMAGES (eval would silently score these False — treating as HARD ERROR):"
  for f in $FAILED; do echo "  $f"; done
fi
exit "$fail"
