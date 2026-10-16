import { applyEdits, digestDocument, finite, id, keys, moneyUnits, record, snapshot, validateBudget, validateDocument, validateObservations } from './validation.js';
class Stop extends Error {
    status;
    constructor(status) {
        super(status);
        this.status = status;
    }
}
/**
 * One opt-in, development-only round. Adapters are trusted effect boundaries:
 * they must load the candidate, enforce ceilingUsd, and honor cancellation.
 * A digest echo is adapter attestation, not proof against a dishonest adapter.
 * No production promotion, code evaluation, network, or persistence occurs here.
 */
export async function runContrastive(options) {
    if (options.evaluator?.surfaceAware !== true || typeof options.evaluator.probe !== 'function' ||
        typeof options.proposer?.propose !== 'function' ||
        (options.composer && typeof options.composer.compose !== 'function'))
        throw new Error('Surface-aware adapters required');
    const probe = options.evaluator.probe.bind(options.evaluator);
    const propose = options.proposer.propose.bind(options.proposer);
    const compose = options.composer?.compose.bind(options.composer);
    const initial = snapshot({ baseline: options.baseline, budget: options.budget,
        tenantId: options.tenantId, projectId: options.projectId, task: options.task,
        environment: options.environment, library: options.library, envelope: options.envelope });
    const { baseline, budget, ...context } = initial;
    id(context.tenantId);
    id(context.projectId);
    validateBudget(budget);
    validateDocument(baseline);
    record(context.library);
    keys(context.library, ['tenantId', 'projectId', 'entries']);
    if (context.library.tenantId !== context.tenantId || context.library.projectId !== context.projectId ||
        !Array.isArray(context.library.entries) || context.library.entries.length > 32)
        throw new Error('Invalid scoped library');
    const baselineDigest = digestDocument(baseline);
    const receipts = [];
    const cache = new Map();
    let calls = 0, deduplicated = 0, reservedUsd = 0, reportedUsd = 0;
    let reservedUnits = 0;
    const maxUnits = moneyUnits(budget.maxUsd);
    let baselineScore = null;
    let selectedScore = null;
    let selected = baseline;
    let selectedDigest = baselineDigest;
    let reason = 'no-improvement';
    const receipt = (kind, status, cost, reported, started, candidateDigest) => {
        receipts.push(Object.freeze({ sequence: receipts.length + 1, kind, status,
            ...(candidateDigest ? { candidateDigest } : {}), reservedUsd: cost, reportedUsd: reported,
            cumulativeReservedUsd: reservedUsd, cumulativeReportedUsd: reportedUsd,
            durationMs: Math.max(0, performance.now() - started) }));
    };
    const invoke = async (kind, ceiling, callback, validate, candidateDigest) => {
        const started = performance.now();
        const units = moneyUnits(ceiling);
        if (calls >= budget.maxCalls || units > maxUnits - reservedUnits) {
            receipt(kind, 'budget', 0, 0, started, candidateDigest);
            throw new Stop('budget');
        }
        // Ceilings are permanently reserved before starting effects, even on failure.
        calls++;
        reservedUnits += units;
        reservedUsd = reservedUnits / 1e9;
        const controller = new AbortController();
        let timer;
        let actual = ceiling;
        try {
            const deadline = started + budget.timeoutMs;
            const timeout = new Promise((_, reject) => {
                timer = setTimeout(() => { controller.abort(); reject(new Stop('timeout')); }, budget.timeoutMs);
            });
            const operation = Promise.resolve().then(() => callback(Object.freeze({ ...context,
                signal: controller.signal, ceilingUsd: ceiling })));
            let raw;
            try {
                raw = await Promise.race([operation, timeout]);
            }
            catch (error) {
                throw error instanceof Stop ? error : new Stop('failure');
            }
            // Also rejects synchronous event-loop blocking completions after the deadline.
            if (controller.signal.aborted || performance.now() >= deadline)
                throw new Stop('timeout');
            let value;
            try {
                value = snapshot(raw);
                finite(value.costUsd, 'cost');
                actual = value.costUsd;
                if (actual > ceiling)
                    throw new Error('Cost exceeded admitted ceiling');
                validate(value);
            }
            catch {
                throw new Stop('invalid');
            }
            reportedUsd += actual;
            receipt(kind, 'success', ceiling, actual, started, candidateDigest);
            return value;
        }
        catch (error) {
            const status = error instanceof Stop ? error.status : 'failure';
            reportedUsd += actual;
            receipt(kind, status, ceiling, actual, started, candidateDigest);
            throw new Stop(status);
        }
        finally {
            if (timer)
                clearTimeout(timer);
            controller.abort();
        }
    };
    const execute = async (kind, candidate) => {
        const candidateDigest = digestDocument(candidate);
        const cached = cache.get(candidateDigest);
        if (cached) {
            deduplicated++;
            receipt(kind, 'deduplicated', 0, 0, performance.now(), candidateDigest);
            return cached;
        }
        const result = await invoke(kind, budget.probeUsd, call => probe(Object.freeze({ ...call, candidate, candidateDigest })), value => {
            record(value);
            keys(value, ['appliedDigest', 'score', 'observations', 'costUsd']);
            if (value.appliedDigest !== candidateDigest)
                throw new Error('Candidate not applied');
            finite(value.score, 'score');
            if (value.score > 1)
                throw new Error('Score out of range');
            validateObservations(value.observations, candidate);
        }, candidateDigest);
        cache.set(candidateDigest, result);
        return result;
    };
    const consider = (candidate, result) => {
        if (selectedScore === null || result.score > selectedScore) {
            selected = candidate;
            selectedDigest = digestDocument(candidate);
            selectedScore = result.score;
        }
        return baselineScore !== null && result.score > baselineScore;
    };
    try {
        const original = await execute('baseline', baseline);
        baselineScore = original.score;
        selectedScore = original.score;
        const supportedEdits = [];
        let improvedScopes = 0;
        for (const scope of ['invariant', 'domain']) {
            const observations = Object.freeze(original.observations.filter(observation => baseline.components.some(component => component.id === observation.componentId && component.scope === scope)));
            const proposal = await invoke(`propose:${scope}`, budget.proposeUsd, call => propose(Object.freeze({ ...call, baseline, candidateDigest: baselineDigest, scope, observations })), value => {
                record(value);
                keys(value, ['edits', 'costUsd']);
                applyEdits(baseline, value.edits, observations, scope);
            }, baselineDigest);
            const candidate = applyEdits(baseline, proposal.edits, observations, scope);
            const result = await execute(`probe:${scope}`, candidate);
            if (consider(candidate, result)) {
                supportedEdits.push(...proposal.edits);
                improvedScopes++;
            }
        }
        if (compose && improvedScopes === 2) {
            const allowed = new Set(supportedEdits.map(edit => JSON.stringify(snapshot(edit))));
            const composition = await invoke('compose', budget.composeUsd, call => compose(Object.freeze({ ...call, baseline, candidateDigest: baselineDigest,
                supportedEdits: Object.freeze(supportedEdits), observations: original.observations })), value => {
                record(value);
                keys(value, ['edits', 'costUsd']);
                applyEdits(baseline, value.edits, original.observations);
                if (value.edits.some(edit => !allowed.has(JSON.stringify(snapshot(edit)))))
                    throw new Error('Unsupported composition');
            }, baselineDigest);
            const candidate = applyEdits(baseline, composition.edits, original.observations);
            consider(candidate, await execute('probe:composition', candidate));
        }
        if (selectedDigest !== baselineDigest)
            reason = 'development-improvement';
    }
    catch (error) {
        // Any invalid effect or exceeded budget fails closed for the entire round.
        selected = baseline;
        selectedDigest = baselineDigest;
        selectedScore = baselineScore;
        reason = error instanceof Stop ? error.status : 'invalid';
    }
    return snapshot({ outcome: selectedDigest === baselineDigest ? 'baseline' : 'candidate', reason,
        candidate: selected, candidateDigest: selectedDigest, baselineDigest, baselineScore, selectedScore,
        receipts, calls, deduplicated, reservedUsd, reportedUsd, promotion: 'not-authorized' });
}
//# sourceMappingURL=engine.js.map