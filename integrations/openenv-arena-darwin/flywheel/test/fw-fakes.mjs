// Fakes for flywheel.mjs tests: no GPU, no network, no docker, no token. Each fake mirrors the real module's
// contract (darwin-steps.mjs, gpu.mjs provisionGpu/teardown, render-and-check.mjs report + its REAL
// toDecisionFacts, arena-api.mjs receipt/summary) and records every call so tests can assert on them.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { baselineGenome, FAMILIES, genomeToCells } from '../../lib/cells.mjs';
import { toDecisionFacts } from '../render-and-check.mjs';
import { canonicalDigest } from '../canonical-json.mjs';
import { defaultConfig, validateConfig } from '../flywheel-config.mjs';

const canon = v => (v === null || typeof v !== 'object' ? JSON.stringify(v) : Array.isArray(v) ? `[${v.map(canon).join(',')}]`
  : `{${Object.keys(v).sort().map(k => `${JSON.stringify(k)}:${canon(v[k])}`).join(',')}}`);
export const digestOf = v => createHash('sha256').update(canon(v)).digest('hex');
const readJson = p => JSON.parse(readFileSync(p, 'utf8'));
const writeJson = (p, v) => { mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, JSON.stringify(v)); return p; };
export const PUBKEY = 'MCowBQYDK2VwAyEA' + 'A'.repeat(44);
export const START = '2026-10-09T14:17:00.000Z'; // 10:17 America/Toronto on 2026-10-09
export const ENV_COMMIT = '0af81c55269be029dd64ccdc79e23654aa9dcaa4'; // checks.expectEnvCommit in setup(); the fake checks report it
/** A start instant on `date` (10:17 Toronto), so a run's --date is the Toronto date of its --now. */
export const startOf = date => `${date}T14:17:00.000Z`;

export function candidateOf(genome) {
  return { ...genome, 'software_change.difficulty': genome['software_change.difficulty'] === 3 ? 1 : 3 };
}

/** A NumericScoreCard over genomeToCells(genome); `informative` families get mixed reasoning groups. Cell keys are
 *  content addresses of (cell, provenance) like lib/cells.mjs cellKey, so Darwin's pairing sees which cells changed. */
export function fakeCard(genome, { variantId, seedBase, attempts, provenance, informative = [], dryRun = false }) {
  const cells = genomeToCells(genome).map(c => {
    const mixed = informative.includes(c.family);
    const episodes = Array.from({ length: attempts }, (_, a) => ({ seed: seedBase + a, attempt: a % 4,
      reward: mixed && a % 2 ? 0 : 1, cls: mixed && a % 2 ? 'reasoning' : 'solved', reason: 'fake' }));
    const key = digestOf({ cell: { family: c.family, difficulty: c.difficulty, budget: c.budget, knobs: c.knobs ?? {} }, provenance: provenance ?? null });
    return { ...c, key, cached: false, n: attempts, solved: episodes.filter(e => e.reward === 1).length,
      signal: mixed ? 1 : 0, dead: !mixed, episodes };
  });
  const primary = cells.reduce((a, c) => a + c.signal, 0);
  return { variantId, primary, noopRate: cells.filter(c => c.dead).length / cells.length, costPerWin: 100 - primary, regressed: false,
    raw: { cells, provenance, dryRun } };
}

export function makeFakes(o = {}) {
  const calls = { ready: 0, search: [], evaluate: [], gate: [], verify: [], up: [], down: [], destroy: [], precheck: 0, recover: 0,
    render: [], slot: 0, status: 0, standing: [], getSubmission: [], submit: [], sleep: [], notify: [] };
  let tick = 0;
  const t0 = Date.parse(o.start ?? START); // o.start: the fake clock follows a later run date (default: START)
  const throwAt = (point) => { if (o.throwAt === point) throw new Error(o.throwMessage ?? `injected failure at ${point}`); };
  const prov = ({ seedBase, attempts }) => ({ envSourceSha: 'a'.repeat(64), runnerSha: 'b'.repeat(64), serverSha: 'c'.repeat(64), runnerArgsSha: 'd'.repeat(64), model: 'qwen38',
    modelRevision: 'r1', contextTokens: 16384, seedBase, attempts });
  const statusSeq = [...(o.statusSeq ?? ['validated'])];
  const slotSeq = [...(o.slotSeq ?? [])];
  const verifySeq = [...(o.verifySeq ?? [])]; // per verify() call (gate time, then decision time); then verifyOk
  const darwin = {
    cells: { FAMILIES, baselineGenome, genomeToCells },
    digestOf,
    ready() { calls.ready++; throwAt('ready'); return prov({ seedBase: 700000, attempts: 4 }); },
    expectedProvenance(a) { throwAt('expectedProvenance'); return prov(a); },
    async search({ workRoot, incumbentGenome, baseUrl, seed, timeoutMs }) {
      calls.search.push({ workRoot, incumbentGenome, baseUrl, seed, timeoutMs });
      throwAt('search');
      const winner = o.noCandidate ? 'baseline' : 'g1-c0';
      const genome = o.noCandidate ? incumbentGenome : candidateOf(incumbentGenome);
      return { kind: 'openenv_arena_darwin_run', version: 2, evidence: o.evidence ?? 'evaluator_scorecards',
        selection: { seedBase: 700000, attempts: 4, evaluated: o.evaluated ?? 7, mock: false },
        oneParamInvariant: { ok: true, violations: [] }, baseline: { variantId: 'baseline', genome: incumbentGenome, score: { primary: 1 } },
        winner: { variantId: winner, genome, score: { primary: 2 }, lineage: ['baseline', winner], improvedOverBaseline: !o.noCandidate },
        budget: { reservedNewCells: 9 } };
    },
    async evaluate({ genome, variantId, seedBase, attempts, maxNewCells, baseUrl }) {
      calls.evaluate.push({ genome, variantId, seedBase, attempts, maxNewCells, baseUrl, journalAtCall: o.journalPath ? readFileSync(o.journalPath(), 'utf8') : null });
      throwAt(`evaluate:${variantId}`);
      const p = prov({ seedBase, attempts });
      if (o.cardProvenanceTweak && variantId === 'candidate') p.modelRevision = 'other';
      const g = o.cardWrongCells && variantId === 'candidate' ? baselineGenome() : genome;
      return fakeCard(g, { variantId, seedBase, attempts, provenance: p, dryRun: o.cardsDryRun === true,
        informative: variantId === 'candidate' ? ['software_change'] : [] });
    },
    async gate({ runPath, baselinePath, candidatePath, pairedPath, outPath, candidateBudget, alpha, lambda, requestSha256 }) {
      calls.gate.push({ runPath, baselinePath, candidatePath, pairedPath, outPath, candidateBudget, alpha, lambda, requestSha256 });
      throwAt('gate');
      const promote = o.gatePromote ?? true;
      const payload = { kind: 'openenv_arena_darwin_submission_gate', version: 2, promote, reasons: promote ? [] : ['noop_rate_not_improved'],
        config: { rule: pairedPath ? 'primary_strictly_greater AND withSequentialEvidence(meetsPromotionRule)' : 'meetsPromotionRule',
          candidateBudget: o.receiptBudget ?? candidateBudget, alpha: o.receiptAlpha ?? alpha, lambda: o.receiptLambda ?? lambda },
        candidate: { digest: o.receiptCandidateDigest ?? digestOf(readJson(candidatePath)) },
        baseline: { digest: o.receiptBaselineDigest ?? digestOf(readJson(baselinePath)) },
        pairedDigest: pairedPath ? (o.pairedDigestWrong ? 'f'.repeat(64) : digestOf(readJson(pairedPath))) : null,
        sequential: { eValue: 25, threshold: 20, informativePairs: 8, totalPairs: 16 },
        ...(o.binding === false ? {} : { binding: { requestSha256: o.bindWrong ? 'e'.repeat(64) : requestSha256 } }) };
      writeJson(outPath, { payload, signature: 'sig', publicKey: PUBKEY, alg: 'ed25519' });
      return { promote, verified: true, reasons: payload.reasons, receiptPath: outPath, exitCode: promote ? 0 : 1, bindingSupported: o.binding !== false };
    },
    async verify({ receiptPath }) {
      calls.verify.push(receiptPath);
      throwAt('verify');
      const r = readJson(receiptPath);
      // like darwin-steps verify(): pinned = the receipt's key IS the pin in force at call time (o.pinNow rotates it)
      return { verified: verifySeq.length ? verifySeq.shift() : (o.verifyOk ?? true), promote: r.payload.promote, exitCode: 0, publicKey: r.publicKey, payload: r.payload,
        publicKeyPinned: (o.pinned ?? true) && r.publicKey === (o.pinNow?.() ?? PUBKEY) };
    },
  };
  const gpu = {
    precheck() { calls.precheck++; if (o.precheckRefuses) { const e = new Error('spend refused: daily cap already reached'); e.name = 'SpendRefused'; throw e; } },
    async recover() { calls.recover++; if (o.recoverThrows) throw new Error('vast lookup failed'); return o.recovered ?? []; },
    async up({ runId, journal }) {
      calls.up.push(runId);
      journal({ phase: 'gpu.spend_ok', plannedUsd: 11.38 });
      if (o.upRefuses) { const e = new Error('spend refused: no offer'); e.name = 'SpendRefused'; throw e; }
      throwAt('up');
      return { instanceId: 4242 + calls.up.length, baseUrl: 'http://127.0.0.1:9/v1', deadlineEpoch: t0 / 1000 + 3 * 3600,
        plannedUsd: 11.38, teardown: () => { throw new Error('flywheel must call deps.gpu.down, not teardown directly'); } };
    },
    async down(h) { calls.down.push(h.instanceId); if (o.downThrows) throw new Error('vast destroy failed'); return { confirmed: true }; },
    async destroy(id) { calls.destroy.push(id); return { confirmed: true }; },
  };
  const renderCheck = {
    async run(opts) {
      calls.render.push(opts);
      throwAt('render');
      const tasks = o.mutateTasks ? opts.tasks.map((t, i) => (i ? t : { ...t, completion_tokens: t.completion_tokens + 1 })) : opts.tasks;
      const request = { submission_id: opts.submissionId, name: opts.name, image: o.renderImage ?? opts.image, dataset: opts.dataset,
        schema: { action: {}, observation: {} }, tasks, example_actions: [{ op: 'read', path: '*' }, { op: 'submit', answer: {} }] };
      const sha = canonicalDigest(request);
      const requestPath = writeJson(join(opts.outDir, 'request.json'), request);
      const ids = tasks.map(t => t.task_id).slice(o.replayDropTask ? 1 : 0);
      const ok = k => ({ ok: o.failCheck !== k });
      const checks = { inputs: { ok: true, envCommit: o.envCommit ?? ENV_COMMIT, envDirty: o.envDirty ?? false, expectEnvCommit: opts.expectEnvCommit ?? null },
        sweep: { ok: true }, pull: ok('pull'), inspect: { ok: true }, run: { ok: true }, health: { ok: true },
        // like the real image-source.mjs: the env source hash copied out of the image (fake prov envSourceSha = 'a' x 64)
        env_source: { ok: true, envSourceSha: o.imageEnvSourceSha ?? 'a'.repeat(64) },
        render: { ok: true }, limits: ok('limits'), actions: { ok: true }, openenv_validate: ok('openenv_validate'), schema: ok('schema'),
        replay: { ...ok('replay'), taskIds: ids } };
      const allOk = !o.failCheck;
      const report = { kind: 'arena_flywheel_presubmit_check', ok: allOk, reasons: allOk ? [] : [`${o.failCheck}_failed`], image: request.image,
        checked_at: o.checkedAt ?? opts.checkedAt ?? null, submission_id: opts.submissionId, request_sha256: sha, request_path: requestPath, checks };
      const reportPath = writeJson(join(opts.outDir, 'presubmit-check.json'), report); // the decision re-reads it from disk
      return { ...report, report_path: reportPath };
    },
    toDecisionFacts: r => (o.checksImage ? { ...toDecisionFacts(r), image: o.checksImage } : toDecisionFacts(r)),
  };
  const arena = {
    async status() { calls.status++; if (o.statusThrows) throw new Error('arena down'); return { connected: true }; },
    // Like the real board: a user appears once one of their submissions was validated (here: incumbent.json exists).
    async standing(user) {
      calls.standing.push(user);
      if (o.boardHasIncumbent === 'throw') throw new Error('leaderboard unreachable');
      const has = o.boardHasIncumbent ?? (o.stateDirFn ? existsSync(join(o.stateDirFn(), 'incumbent.json')) : false);
      return { user, hasIncumbent: has, rank: has ? 3 : null, runs: has ? [{ user }] : [], truncated: false };
    },
    async slot() {
      calls.slot++;
      const s = slotSeq.length ? slotSeq.shift() : (o.slotFree ?? true);
      if (s === 'throw') throw new Error('arena unreachable');
      // own GET /submissions: the latest validated one is the incumbent the flywheel recorded (o.latestValidatedId overrides)
      const inc = o.stateDirFn && existsSync(join(o.stateDirFn(), 'incumbent.json')) ? readJson(join(o.stateDirFn(), 'incumbent.json')).submissionId : null;
      const latestValidatedId = o.ownListUnknown ? undefined : o.latestValidatedId !== undefined ? o.latestValidatedId : inc;
      return s === true ? { free: true, reasons: [], freeAtMs: null, latestValidatedId }
        : { free: false, reasons: ['slot_in_use'], freeAtMs: o.freeAtMs ?? t0 + 20 * 3600e3, latestValidatedId };
    },
    async getSubmission(id) {
      calls.getSubmission.push(id);
      const state = statusSeq.length > 1 ? statusSeq.shift() : statusSeq[0];
      return state === null ? null : { submission_id: id, state, slot_state: state === 'validated' ? 'used' : 'held',
        ...(o.errorOrigin !== undefined && state === 'rejected' ? { error_origin: o.errorOrigin } : {}) }; // 'author' | 'platform'
    },
    async submit({ request, approvedSha256, receiptPath }) {
      calls.submit.push({ request, approvedSha256, receiptPath });
      throwAt('submit');
      return o.submitResult ?? { state: 'recorded', post_attempted: true, submission_id: request.submission_id, arena: { state: 'validating' } };
    },
  };
  const deps = {
    pid: o.pid ?? process.pid, isPidAlive: o.isPidAlive ?? (pid => pid === process.pid),
    clock: () => new Date(t0 + 1000 * tick++).toISOString(), nowMs: () => t0 + 1000 * tick,
    sleep: async ms => { calls.sleep.push(ms); },
    notify: async s => { calls.notify.push(s); throwAt('notify'); },
    darwin, gpu, renderCheck, arena,
  };
  return { deps, calls };
}

/** Fresh state dir + a valid config (dry-run unless overridden) with the gate key and the env lane commit pinned. */
export function setup(over = {}) {
  const home = mkdtempSync(join(tmpdir(), 'arena-flywheel-test-'));
  const base = defaultConfig(home);
  base.gate.expectPublicKey = PUBKEY;
  base.checks = { expectEnvCommit: ENV_COMMIT };
  base.poll.attempts = 2;
  const config = validateConfig({ ...base, ...over, confirmation: { ...base.confirmation, ...(over.confirmation ?? {}) },
    poll: { ...base.poll, ...(over.poll ?? {}) } }, home);
  return { home, config, stateDir: join(home, 'state') };
}
