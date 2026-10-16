import { createHash } from 'node:crypto';
import { digestDocument, finite, id, keys, moneyUnits, record, snapshot, validateDocument } from './validation.js';
export * from './confirmation-types.js';
const MAX_CASES = 4096;
function boundedInteger(value, minimum, label) {
    if (!Number.isInteger(value) || value < minimum || value > MAX_CASES)
        throw new Error('Invalid ' + label);
}
function digest(value) {
    return createHash('sha256').update(JSON.stringify(snapshot(value))).digest('hex');
}
function validatePolicy(policy) {
    record(policy);
    keys(policy, ['minCases', 'minWins', 'maxRegressions', 'minGain', 'alpha']);
    boundedInteger(policy.minCases, 1, 'minimum cases');
    boundedInteger(policy.minWins, 1, 'minimum wins');
    boundedInteger(policy.maxRegressions, 0, 'regression allowance');
    finite(policy.minGain, 'minimum gain');
    if (policy.minGain > 1)
        throw new Error('Invalid minimum gain');
    if (typeof policy.alpha !== 'number' || !Number.isFinite(policy.alpha) || policy.alpha <= 0 || policy.alpha > 0.5)
        throw new Error('Invalid alpha');
}
function taskSet(value, allowEmpty) {
    if (!Array.isArray(value) || value.length > MAX_CASES || (!allowEmpty && !value.length))
        throw new Error('Invalid task set');
    value.forEach(id);
    const set = new Set(value);
    if (set.size !== value.length)
        throw new Error('Duplicate task IDs');
    return set;
}
/**
 * Exact one-sided sign/McNemar binomial tail. BigInt summation avoids
 * cancellation; the final double is conservatively rounded upward.
 * Extremely small probabilities return Number.MIN_VALUE, never false zero.
 */
export function pairedSignPValue(wins, losses) {
    boundedInteger(wins, 0, 'wins');
    boundedInteger(losses, 0, 'losses');
    const n = wins + losses;
    if (n > MAX_CASES)
        throw new Error('Too many discordant cases');
    if (!wins)
        return 1;
    let coefficient = 1n;
    let numerator = 0n;
    for (let k = 0; k <= n; k++) {
        if (k >= wins)
            numerator += coefficient;
        if (k < n)
            coefficient = coefficient * BigInt(n - k) / BigInt(k + 1);
    }
    const bits = numerator.toString(2).length;
    const exponent = bits - 1 - n;
    const ceilShift = (value, shift) => shift > 0 ? (value + (1n << BigInt(shift)) - 1n) >> BigInt(shift) : value << BigInt(-shift);
    if (exponent < -1022) {
        return Number(ceilShift(numerator, n - 1074)) * Number.MIN_VALUE;
    }
    const shift = Math.max(0, bits - 53);
    const significant = Number(ceilShift(numerator, shift));
    return Math.min(1, significant / 2 ** (bits - 1 - shift) * 2 ** exponent);
}
class Interrupted extends Error {
    status;
    constructor(status) {
        super(status);
        this.status = status;
    }
}
/**
 * Independent fixed-set confirmation, never production promotion.
 * Adapters must execute BOTH documents under equal declared conditions and
 * enforce ceilingUsd/cancellation at the actual effect boundary. Digests are
 * trusted adapter attestations, not cryptographic proof of execution.
 * Task IDs cannot prove underlying dataset isolation or prevent repeated tests.
 */
export async function confirmContrastive(options) {
    if (options.evaluator?.surfaceAware !== true || typeof options.evaluator.evaluatePair !== 'function')
        throw new Error('Surface-aware paired evaluator required');
    const evaluatePair = options.evaluator.evaluatePair.bind(options.evaluator);
    const frozen = snapshot({ tenantId: options.tenantId, projectId: options.projectId,
        environment: options.environment, envelope: options.envelope, baseline: options.baseline,
        candidate: options.candidate, developmentTaskIds: options.developmentTaskIds,
        confirmationTaskIds: options.confirmationTaskIds, policy: options.policy, budget: options.budget });
    const { tenantId, projectId, environment, envelope, baseline, candidate, policy, budget } = frozen;
    id(tenantId);
    id(projectId);
    validateDocument(baseline);
    validateDocument(candidate);
    validatePolicy(policy);
    const development = taskSet(frozen.developmentTaskIds, true);
    taskSet(frozen.confirmationTaskIds, false);
    if (frozen.confirmationTaskIds.some(taskId => development.has(taskId)))
        throw new Error('Overlapping development and confirmation IDs');
    record(budget);
    keys(budget, ['maxUsd', 'maxCalls', 'timeoutMs', 'pairUsd']);
    const maxUnits = moneyUnits(budget.maxUsd), pairUnits = moneyUnits(budget.pairUsd);
    boundedInteger(budget.maxCalls, 1, 'call limit');
    if (!Number.isInteger(budget.timeoutMs) || budget.timeoutMs < 1 || budget.timeoutMs > 300000)
        throw new Error('Invalid timeout');
    const roundDeadline = performance.now() + budget.timeoutMs;
    const baselineDigest = digestDocument(baseline), candidateDigest = digestDocument(candidate);
    const environmentDigest = digest(environment), envelopeDigest = digest(envelope), policyDigest = digest(policy);
    const confirmationSetDigest = digest([...frozen.confirmationTaskIds].sort());
    const developmentSetDigest = digest([...frozen.developmentTaskIds].sort());
    const receipts = [];
    let calls = 0, reservedUnits = 0, reportedUsd = 0;
    let cases = 0, wins = 0, losses = 0, ties = 0, baselinePassed = 0, candidatePassed = 0;
    const statistics = () => Object.freeze({
        cases, wins, losses, ties, baselinePassed, candidatePassed,
        gain: cases ? (wins - losses) / cases : 0, pValue: pairedSignPValue(wins, losses),
    });
    const finish = (verdict, reason) => Object.freeze({
        verdict, reason, tenantId, projectId, environmentDigest, envelopeDigest, policy, policyDigest,
        baselineDigest, candidateDigest, confirmationSetDigest, developmentSetDigest,
        stats: statistics(), receipts: Object.freeze(receipts), calls,
        reservedUsd: reservedUnits / 1e9, reportedUsd, promotion: 'not-authorized',
    });
    if (baselineDigest === candidateDigest)
        return finish('rejected', 'identical-candidate');
    const receipt = (taskId, status, reserved, reported, started, outcome) => {
        receipts.push(Object.freeze({ sequence: receipts.length + 1, taskId, status, reservedUsd: reserved,
            reportedUsd: reported, cumulativeReservedUsd: reservedUnits / 1e9, cumulativeReportedUsd: reportedUsd,
            durationMs: Math.max(0, performance.now() - started),
            ...(status === 'success' && outcome ? { baselinePassed: outcome.baselinePassed, candidatePassed: outcome.candidatePassed } : {}) }));
    };
    const execute = async (taskId) => {
        const started = performance.now();
        if (started >= roundDeadline) {
            receipt(taskId, 'timeout', 0, 0, started);
            throw new Interrupted('timeout');
        }
        if (calls >= budget.maxCalls || pairUnits > maxUnits - reservedUnits) {
            receipt(taskId, 'budget', 0, 0, started);
            throw new Interrupted('budget');
        }
        calls++;
        reservedUnits += pairUnits;
        const controller = new AbortController();
        let timer;
        let actual = budget.pairUsd;
        let dispatched = false;
        try {
            const timeout = new Promise((_, reject) => {
                timer = setTimeout(() => { controller.abort(); reject(new Interrupted('timeout')); }, Math.max(0, roundDeadline - performance.now()));
            });
            const operation = Promise.resolve().then(() => {
                if (controller.signal.aborted || performance.now() >= roundDeadline)
                    throw new Interrupted('timeout');
                dispatched = true;
                return evaluatePair(Object.freeze({
                    tenantId, projectId, environment, environmentDigest, envelope, envelopeDigest, taskId, baseline, candidate,
                    baselineDigest, candidateDigest, signal: controller.signal, ceilingUsd: budget.pairUsd,
                }));
            });
            let raw;
            try {
                raw = await Promise.race([operation, timeout]);
            }
            catch (error) {
                throw error instanceof Interrupted ? error : new Interrupted('failure');
            }
            if (controller.signal.aborted || performance.now() >= roundDeadline)
                throw new Interrupted('timeout');
            let value;
            try {
                value = snapshot(raw);
                finite(value.costUsd, 'pair cost');
                actual = value.costUsd;
                if (actual > budget.pairUsd)
                    throw new Error('Pair exceeded admitted ceiling');
                record(value);
                keys(value, ['tenantId', 'projectId', 'environmentDigest', 'envelopeDigest', 'taskId',
                    'appliedBaselineDigest', 'appliedCandidateDigest', 'baselinePassed', 'candidatePassed', 'costUsd']);
                if (value.tenantId !== tenantId || value.projectId !== projectId || value.environmentDigest !== environmentDigest ||
                    value.envelopeDigest !== envelopeDigest || value.taskId !== taskId || value.appliedBaselineDigest !== baselineDigest || value.appliedCandidateDigest !== candidateDigest)
                    throw new Error('Pair identity mismatch');
                if (typeof value.baselinePassed !== 'boolean' || typeof value.candidatePassed !== 'boolean')
                    throw new Error('Pair verdicts must be boolean');
            }
            catch {
                throw new Interrupted('invalid');
            }
            reportedUsd += actual;
            receipt(taskId, 'success', budget.pairUsd, actual, started, value);
            return value;
        }
        catch (error) {
            const status = error instanceof Interrupted ? error.status : 'failure';
            if (!dispatched)
                actual = 0;
            reportedUsd += actual;
            receipt(taskId, status, budget.pairUsd, actual, started);
            throw new Interrupted(status);
        }
        finally {
            if (timer)
                clearTimeout(timer);
            controller.abort();
        }
    };
    try {
        // Complete the entire prespecified set; no optional stopping on a small p.
        for (const taskId of frozen.confirmationTaskIds) {
            const value = await execute(taskId);
            cases++;
            baselinePassed += Number(value.baselinePassed);
            candidatePassed += Number(value.candidatePassed);
            if (!value.baselinePassed && value.candidatePassed)
                wins++;
            else if (value.baselinePassed && !value.candidatePassed)
                losses++;
            else
                ties++;
        }
    }
    catch (error) {
        return finish('inconclusive', error instanceof Interrupted ? error.status : 'invalid');
    }
    const stats = statistics();
    if (cases < policy.minCases)
        return finish('inconclusive', 'insufficient-cases');
    if (losses > policy.maxRegressions)
        return finish('rejected', 'regression-limit');
    if (wins < policy.minWins)
        return finish('rejected', 'insufficient-wins');
    if (stats.gain < policy.minGain)
        return finish('rejected', 'insufficient-gain');
    if (stats.pValue > policy.alpha)
        return finish('rejected', 'insufficient-evidence');
    return finish('confirmed', 'paired-confirmation-passed');
}
//# sourceMappingURL=confirmation.js.map