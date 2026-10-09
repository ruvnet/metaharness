#!/usr/bin/env node
// Flywheel submission gate for Darwin-evolved OpenEnv Arena environment knobs.
//
// A candidate environment config is shown for submission ONLY if, on FRESH-SEED confirmation measurements (never the
// search scorecards Darwin selected on), it beats the previous version on the same fitness measure under the frozen
// Flywheel rule AND anytime-valid paired evidence, and the decision is signed and re-verified.
//
//   node --experimental-strip-types gate.mjs --run <work-root>/reports/darwin-run.json --out receipt.json \
//        [--baseline B.json --candidate C.json --paired P.json] [--alpha 0.05] [--lambda 0.5] \
//        [--candidate-budget N (default: the run's evaluated count)] [--key-dir DIR | env DARWIN_GATE_KEY_DIR]
//   node --experimental-strip-types gate.mjs --verify receipt.json (--expect-public-key B64 | --key-dir DIR | env DARWIN_GATE_KEY_DIR)
//
// Exit codes: 0 = promote AND receipt verifies; 1 = refused (receipt still written); 2 = bad input/error/unpinned verify.
// Decision JSON goes to stdout; logs go to stderr. No key material is ever printed.
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign as edSign } from 'node:crypto';
import { existsSync, linkSync, mkdirSync, readFileSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { gateFingerprint, meetsPromotionRule } from '../../packages/flywheel/src/gate.ts';
import { sequentialEvidence, withSequentialEvidence } from '../../packages/flywheel/src/sequential.ts';
import { canon, makeSigner, verifyReceipt } from '../../packages/flywheel/src/receipts.ts';
import { pairedOutcomes } from './lib/confirm.mjs';

export const GATE_KIND = 'openenv_arena_darwin_submission_gate';
export const GATE_VERSION = 2;
const SELF = fileURLToPath(import.meta.url);
const REPO_ROOT = resolve(dirname(SELF), '../..');
const KEY_FILE = 'gate-ed25519.pem';
const CONFIRM_SRC = fileURLToPath(new URL('./lib/confirm.mjs', import.meta.url));
const FITNESS_SRC = fileURLToPath(new URL('./lib/fitness.mjs', import.meta.url));
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
export const digestOf = value => sha256(canon(value));
const finite = v => typeof v === 'number' && Number.isFinite(v);
const absent = v => v === undefined || v === null;
const isCount = v => Number.isSafeInteger(v) && v >= 0;

/** Strict boundary check of one NumericScoreCard. Returns explicit reasons; [] means usable evidence.
 *  Note: the ShellEvaluator's error card uses +/-Infinity, which JSON turns into `null` on disk. */
export function validateScorecard(card, side) {
  const tag = `invalid_${side}_scorecard`;
  if (!card || typeof card !== 'object' || Array.isArray(card)) return [`${tag}:not_object`];
  const reasons = [];
  if (!absent(card.evaluatorError) || !absent(card.raw?.evaluatorError)) reasons.push(`${side}_evaluator_error`);
  if (!finite(card.primary)) reasons.push(`${tag}:primary`);
  if (!finite(card.noopRate) || card.noopRate < 0 || card.noopRate > 1) reasons.push(`${tag}:noopRate`);
  if (!finite(card.costPerWin) || card.costPerWin < 0) reasons.push(`${tag}:costPerWin`);
  if (typeof card.regressed !== 'boolean') reasons.push(`${tag}:regressed`);
  if (!absent(card.variantId) && typeof card.variantId !== 'string') reasons.push(`${tag}:variantId`);
  return reasons;
}

/** Validate PairedOutcome[] (array, or {pairedOutcomes: [...]}). Throws on bad input. */
export function validatePaired(input) {
  const pairs = Array.isArray(input) ? input : input?.pairedOutcomes;
  if (!Array.isArray(pairs) || pairs.length > 100000) throw new Error('invalid_paired_outcomes');
  const seen = new Set();
  for (const p of pairs) {
    const ok = p && typeof p === 'object' && !Array.isArray(p) &&
      Object.keys(p).every(k => ['itemId', 'candidateWon', 'baselineWon'].includes(k)) &&
      typeof p.itemId === 'string' && p.itemId.length > 0 && p.itemId.length <= 256 &&
      typeof p.candidateWon === 'boolean' && typeof p.baselineWon === 'boolean';
    if (!ok) throw new Error('invalid_paired_outcome');
    if (seen.has(p.itemId)) throw new Error(`duplicate_paired_item:${p.itemId}`);
    seen.add(p.itemId);
  }
  return pairs.map(({ itemId, candidateWon, baselineWon }) => ({ itemId, candidateWon, baselineWon }));
}

const scoreOf = c => ({ primary: c.primary, noopRate: c.noopRate, costPerWin: c.costPerWin, regressed: c.regressed });

/**
 * Pure gate decision (unsigned). Clauses, ALL required:
 *   - selection context (the Darwin run: search seed base/attempts, number of candidates evaluated);
 *   - both scorecards finite, in-domain, evaluator-error-free; the BASELINE is not regressed (a broken baseline
 *     makes any candidate look better);
 *   - both carry the SAME raw.provenance, and its seed range is disjoint from the search seeds (fresh confirmation,
 *     not the data the winner was selected on);
 *   - paired evidence re-derived from the scorecards' episodes (a supplied --paired file must match it exactly),
 *     non-empty, able to reach 1/alpha at all, and significant under withSequentialEvidence at
 *     alpha / candidateBudget (default candidateBudget = selection.evaluated);
 *   - candidate primary STRICTLY greater than baseline primary;
 *   - the frozen Flywheel rule meetsPromotionRule. Note: noopRate = 1 - primary/cells, so its clause is implied by
 *     the primary clause; the independent axes are primary, costPerWin (tokens per unit signal), regressed, evidence.
 */
export function decide({ baseline, candidate, paired, selection, alpha = 0.05, lambda = 0.5, candidateBudget, now = new Date() }) {
  if (!(finite(alpha) && alpha > 0 && alpha < 1)) throw new RangeError('alpha must be in (0, 1)');
  if (!(finite(lambda) && lambda > 0 && lambda < 1)) throw new RangeError('lambda must be in (0, 1)');
  const sel = selection && isCount(selection.seedBase) && isCount(selection.attempts) && Number.isSafeInteger(selection.evaluated)
    && selection.evaluated >= 1 && selection.mock !== true ? { seedBase: selection.seedBase, attempts: selection.attempts, evaluated: selection.evaluated } : null;
  const budget = candidateBudget ?? sel?.evaluated ?? 1;
  if (!(Number.isSafeInteger(budget) && budget >= 1)) throw new RangeError('candidateBudget must be an integer >= 1');
  const supplied = paired === undefined ? undefined : validatePaired(paired);
  const effectiveAlpha = alpha / budget;
  const cfg = { alpha: effectiveAlpha, lambda };
  const reasons = [...validateScorecard(baseline, 'baseline'), ...validateScorecard(candidate, 'candidate')];
  if (!sel) reasons.push('no_selection_context');
  if (baseline && typeof baseline === 'object' && baseline.regressed !== false) reasons.push('baseline_regressed');
  const provB = baseline?.raw?.provenance, provC = candidate?.raw?.provenance;
  if (absent(provB) || absent(provC)) reasons.push('provenance_missing');
  else if (canon(provB) !== canon(provC)) reasons.push('provenance_mismatch');
  else if (!isCount(provB.seedBase) || !isCount(provB.attempts)) reasons.push('provenance_missing_seed_plan');
  else if (sel && provB.seedBase < sel.seedBase + sel.attempts && sel.seedBase < provB.seedBase + provB.attempts) {
    reasons.push('selection_seed_reused');
  }
  let pairs = null;
  try {
    pairs = pairedOutcomes(baseline, candidate);
  } catch (error) {
    reasons.push(`pairing_failed:${error.message}`);
  }
  if (pairs && supplied && canon(supplied) !== canon(pairs)) reasons.push('paired_evidence_mismatch');
  if (pairs && pairs.length === 0) reasons.push('missing_paired_evidence');
  const blocksNeeded = Math.ceil(Math.log(1 / effectiveAlpha) / Math.log(1 + lambda) - 1e-12);
  if (pairs && pairs.length > 0 && pairs.length < blocksNeeded) {
    reasons.push(`confirmation_underpowered(need>=${blocksNeeded} paired blocks at candidateBudget ${budget}, have ${pairs.length})`);
  }
  const valid = reasons.length === 0;
  let ruleDecision = { promote: false, reasons: [] };
  if (valid) {
    if (!(candidate.primary > baseline.primary)) reasons.push('primary_not_improved');
    ruleDecision = withSequentialEvidence(meetsPromotionRule, cfg)({ baseline: scoreOf(baseline), candidate: scoreOf(candidate), pairedOutcomes: pairs });
    reasons.push(...ruleDecision.reasons);
  }
  const sequential = pairs && pairs.length > 0 ? sequentialEvidence(pairs, cfg) : null;
  if (sequential && !finite(sequential.eValue)) reasons.push('invalid_sequential_evalue');
  const promote = valid && ruleDecision.promote === true && reasons.length === 0;
  const config = { alpha, effectiveAlpha, lambda, candidateBudget: budget,
    candidateBudgetSource: candidateBudget === undefined ? 'selection.evaluated' : 'explicit',
    rule: 'primary_strictly_greater AND withSequentialEvidence(meetsPromotionRule)' };
  const fingerprints = {
    upstreamGateFingerprint: gateFingerprint(meetsPromotionRule),
    pairedEvidenceFingerprint: sha256(gateFingerprint(withSequentialEvidence) + gateFingerprint(sequentialEvidence)),
    // The decision also depends on the pairing/block-win rule and on what 'eligible' means: pin all three sources.
    localGateFingerprint: sha256(Buffer.concat([SELF, CONFIRM_SRC, FITNESS_SRC].map(p => readFileSync(p)))),
  };
  const ok = reasons.filter(r => r.startsWith('invalid_')).length === 0;
  return {
    kind: GATE_KIND, version: GATE_VERSION, promote, reasons,
    gateFingerprint: digestOf({ ...fingerprints, config }), ...fingerprints, config,
    selection: sel, confirmation: provB && isCount(provB.seedBase) ? { seedBase: provB.seedBase, attempts: provB.attempts } : null,
    baseline: { variantId: baseline?.variantId ?? null, score: ok && baseline ? scoreOf(baseline) : null, digest: digestOf(baseline ?? null) },
    candidate: { variantId: candidate?.variantId ?? null, score: ok && candidate ? scoreOf(candidate) : null, digest: digestOf(candidate ?? null) },
    deltas: ok && baseline && candidate ? { primary: candidate.primary - baseline.primary, noopRate: candidate.noopRate - baseline.noopRate,
      costPerWin: candidate.costPerWin - baseline.costPerWin } : null,
    provenanceDigest: absent(provB) ? null : digestOf(provB),
    pairedDigest: pairs ? digestOf(pairs) : null,
    sequential,
    scope: 'local_submission_candidate_selection_only', officialScore: null,
    claim: 'Environment-knob selection on local fresh-seed confirmation evidence; not an Arena score and not a submission.',
    createdAt: now.toISOString(),
  };
}

/** Refuse any key directory inside this repository or inside ANY git work tree (keys must never be committed). */
export function assertOutsideRepo(dir) {
  const inside = p => { const rel = relative(REPO_ROOT, p); return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel)); };
  const abs = resolve(dir);
  if (inside(abs) || (existsSync(abs) && inside(realpathSync(abs)))) throw new Error('signing_key_dir_inside_repo');
  let probe = abs;
  while (!existsSync(probe) && dirname(probe) !== probe) probe = dirname(probe);
  for (let p = realpathSync(probe); ; p = dirname(p)) {
    if (existsSync(join(p, '.git'))) throw new Error(`signing_key_dir_inside_git_worktree:${p}`);
    if (dirname(p) === p) break;
  }
  return abs;
}

/** Persistent Ed25519 signer with the receipts.ts Signer shape, so `verifyReceipt` works unchanged. The PKCS8 key is
 *  created once (0600, dir 0700; an existing dir must already be 0700) and reused, giving a pinnable public key. */
export function fileSigner(keyDir, { create = true } = {}) {
  const dir = assertOutsideRepo(keyDir);
  if (create) mkdirSync(dir, { recursive: true, mode: 0o700 });
  assertOutsideRepo(dir);
  if (!existsSync(dir)) throw new Error('signing_key_dir_missing');
  if (statSync(dir).mode & 0o077) throw new Error('signing_key_dir_permissions_too_open (chmod 700)');
  const keyPath = join(dir, KEY_FILE);
  if (!existsSync(keyPath)) {
    if (!create) throw new Error('signing_key_missing');
    const pem = generateKeyPairSync('ed25519').privateKey.export({ type: 'pkcs8', format: 'pem' });
    const tmp = `${keyPath}.${process.pid}.tmp`;
    writeFileSync(tmp, pem, { mode: 0o600, flag: 'wx' });
    try { linkSync(tmp, keyPath); } catch (e) { if (e.code !== 'EEXIST') throw e; } finally { unlinkSync(tmp); }
  }
  if (statSync(keyPath).mode & 0o077) throw new Error('signing_key_permissions_too_open');
  const priv = createPrivateKey(readFileSync(keyPath));
  if (priv.asymmetricKeyType !== 'ed25519') throw new Error('signing_key_not_ed25519');
  const pub = createPublicKey(priv).export({ type: 'spki', format: 'der' }).toString('base64');
  return {
    publicKey: () => pub,
    sign: payload => ({ payload, signature: edSign(null, Buffer.from(canon(payload)), priv).toString('base64'), publicKey: pub, alg: 'ed25519' }),
  };
}

/** Signature check (embedded key) + optional pin to an expected public key + gate-kind check. */
export function verifyGateReceipt(receipt, { expectedPublicKey } = {}) {
  if (!receipt || typeof receipt !== 'object' || receipt.alg !== 'ed25519') return false;
  if (receipt.payload?.kind !== GATE_KIND) return false;
  if (expectedPublicKey && receipt.publicKey !== expectedPublicKey) return false;
  return verifyReceipt(receipt);
}

export function signDecision(decision, signer = makeSigner()) {
  const receipt = signer.sign(decision);
  return { receipt, verified: verifyGateReceipt(receipt, { expectedPublicKey: signer.publicKey() }) };
}

function writeAtomic(path, text) {
  const abs = resolve(path);
  mkdirSync(dirname(abs), { recursive: true });
  const tmp = `${abs}.${process.pid}.tmp`;
  writeFileSync(tmp, text);
  renameSync(tmp, abs);
  return abs;
}

function readJson(path, name) {
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { throw new Error(`unreadable_${name}:${path}`); }
}

const num = (v, name) => {
  if (v === undefined) return undefined;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`invalid_flag:${name}`);
  return n;
};

/** CLI entry. Returns the process exit code; never throws. */
export function main(argv = process.argv.slice(2), env = process.env) {
  try {
    const { values: o } = parseArgs({ args: argv, strict: true, options: {
      run: { type: 'string' }, baseline: { type: 'string' }, candidate: { type: 'string' }, paired: { type: 'string' },
      out: { type: 'string' }, 'key-dir': { type: 'string' }, alpha: { type: 'string' }, lambda: { type: 'string' },
      'candidate-budget': { type: 'string' }, verify: { type: 'string' }, 'expect-public-key': { type: 'string' },
      help: { type: 'boolean' } } });
    if (o.help) { process.stderr.write('usage: see header of gate.mjs\n'); return 0; }
    const keyDir = o['key-dir'] ?? (env.DARWIN_GATE_KEY_DIR || undefined);
    if (o.verify) {
      // Fail closed without a pin: the embedded key alone proves only that SOMEONE signed it.
      const pin = o['expect-public-key'] ?? (keyDir ? fileSigner(keyDir, { create: false }).publicKey() : null);
      if (!pin) throw new Error('verify_needs_pinned_key: pass --expect-public-key, --key-dir or DARWIN_GATE_KEY_DIR');
      const receipt = readJson(o.verify, 'receipt');
      const verified = verifyGateReceipt(receipt, { expectedPublicKey: pin });
      const promote = receipt?.payload?.promote === true;
      process.stdout.write(`${JSON.stringify({ verified, promote, reasons: receipt?.payload?.reasons ?? null })}\n`);
      return verified && promote ? 0 : verified ? 1 : 2;
    }
    if (!o.run || !o.out) throw new Error('missing_required_flags:--run,--out');
    const run = readJson(o.run, 'run');
    if (run?.kind !== 'openenv_arena_darwin_run') throw new Error('not_a_darwin_run_report');
    const files = run.files ?? {};
    const pairedPath = o.paired ?? (files.confirmPaired && existsSync(files.confirmPaired) ? files.confirmPaired : undefined);
    const decision = decide({
      baseline: readJson(o.baseline ?? files.confirmBaselineScorecard, 'baseline'),
      candidate: readJson(o.candidate ?? files.confirmWinnerScorecard, 'candidate'),
      paired: pairedPath ? readJson(pairedPath, 'paired') : undefined, selection: run.selection,
      alpha: num(o.alpha, 'alpha'), lambda: num(o.lambda, 'lambda'), candidateBudget: num(o['candidate-budget'], 'candidate-budget'),
    });
    const signer = keyDir ? fileSigner(keyDir) : makeSigner();
    if (!keyDir) process.stderr.write('[gate] no --key-dir/DARWIN_GATE_KEY_DIR: ephemeral signing key (receipt verifies, key not pinnable)\n');
    const { receipt } = signDecision(decision, signer);
    const outPath = writeAtomic(o.out, `${JSON.stringify(receipt, null, 2)}\n`);
    const reread = readJson(outPath, 'receipt');
    const verified = verifyGateReceipt(reread, { expectedPublicKey: signer.publicKey() }) && canon(reread.payload) === canon(decision);
    process.stdout.write(`${JSON.stringify({ promote: decision.promote, verified, reasons: decision.reasons,
      gateFingerprint: decision.gateFingerprint, sequential: decision.sequential, deltas: decision.deltas,
      receiptPath: outPath, publicKey: signer.publicKey() })}\n`);
    process.stderr.write(`[gate] ${decision.promote ? 'PROMOTE' : 'REFUSE'} verified=${verified} ${decision.reasons.join(',')}\n`);
    if (!verified) return 2;
    return decision.promote ? 0 : 1;
  } catch (err) {
    process.stderr.write(`[gate] error: ${err?.message ?? err}\n`);
    process.stdout.write(`${JSON.stringify({ promote: false, verified: false, error: String(err?.message ?? err) })}\n`);
    return 2;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) process.exitCode = main();
