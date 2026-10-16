// SPDX-License-Identifier: MIT
import { createHash } from 'node:crypto';
import { digestDocument, keys, snapshot, validateDocument } from './validation.js';
function text(value, name, max = 512) {
    if (typeof value !== 'string' || !value.trim() || value.length > max || /[\u0000-\u0008]/.test(value)) {
        throw new Error(`invalid experience ${name}`);
    }
}
function scoped(library, context) {
    const clean = snapshot(library);
    for (const key of ['tenantId', 'projectId', 'environmentKey'])
        text(context[key], key);
    if (clean.tenantId !== context.tenantId || clean.projectId !== context.projectId) {
        throw new Error('experience scope mismatch');
    }
    if (!Array.isArray(clean.entries) || clean.entries.length > 32)
        throw new Error('experience capacity exceeded');
    return clean;
}
/** Build a portable experiment record. This never persists or promotes production state.
 * Result/receipt objects are trusted caller data, not cryptographic attestations.
 * Score values are deliberately omitted from the library visible to editors.
 */
export function rememberContrastiveExperience(library, input) {
    const clean = scoped(library, input);
    text(input.sourceTaskId, 'sourceTaskId');
    text(input.cue, 'cue', 2048);
    text(input.lesson, 'lesson', 4096);
    const result = snapshot(input.result);
    validateDocument(result.candidate);
    const digest = digestDocument(result.candidate);
    if (result.outcome !== 'candidate' || result.promotion !== 'not-authorized' ||
        digest !== result.candidateDigest || digest === result.baselineDigest ||
        typeof result.baselineScore !== 'number' || typeof result.selectedScore !== 'number' ||
        !Number.isFinite(result.baselineScore) || !Number.isFinite(result.selectedScore) ||
        result.baselineScore < 0 || result.selectedScore > 1 ||
        result.selectedScore <= result.baselineScore)
        throw new Error('experience requires an improved executed candidate');
    const probes = result.receipts.filter(r => r.status === 'success' && r.kind.startsWith('probe:') && r.candidateDigest === digest);
    if (!probes.length)
        throw new Error('experience lacks matching execution receipt');
    const id = createHash('sha256').update(JSON.stringify([
        input.tenantId, input.projectId, input.environmentKey, input.sourceTaskId, result.baselineDigest, digest,
    ])).digest('hex');
    const entry = {
        schema: 'metaharness.contrastive.experience.v1', id,
        tenantId: input.tenantId, projectId: input.projectId,
        environmentKey: input.environmentKey, sourceTaskId: input.sourceTaskId,
        cue: input.cue, lesson: input.lesson,
        baselineDigest: result.baselineDigest, candidateDigest: digest,
        harness: result.candidate,
        evidence: probes.map(r => ({ sequence: r.sequence, kind: r.kind, candidateDigest: digest })),
        status: 'experimental', promotion: 'not-authorized',
    };
    // FIFO cap is explicit. A deployment may archive evicted entries separately.
    const entries = clean.entries.filter(e => !(e && typeof e === 'object' && !Array.isArray(e) && e.id === id));
    return snapshot({ tenantId: clean.tenantId, projectId: clean.projectId, entries: [...entries, entry].slice(-32) });
}
/** Conservative lexical retrieval, not an embedding model or proof of transfer.
 * A deployment may replace ranking with RuVector after this scope filter.
 */
export function retrieveContrastiveExperiences(library, input) {
    const clean = scoped(library, input);
    text(input.query, 'query', 2048);
    const limit = input.limit ?? 4;
    if (!Number.isInteger(limit) || limit < 1 || limit > 8)
        throw new Error('invalid retrieval limit');
    const words = new Set(input.query.toLowerCase().match(/[a-z0-9]{3,}/g) ?? []);
    const ranked = [];
    for (const entry of clean.entries) {
        if (!entry || typeof entry !== 'object' || Array.isArray(entry))
            continue;
        if (entry.schema !== 'metaharness.contrastive.experience.v1' || entry.tenantId !== input.tenantId ||
            entry.projectId !== input.projectId || entry.environmentKey !== input.environmentKey)
            continue;
        if (typeof entry.id !== 'string' || typeof entry.cue !== 'string' || typeof entry.lesson !== 'string')
            continue;
        try {
            keys(entry, ['schema', 'id', 'tenantId', 'projectId', 'environmentKey', 'sourceTaskId', 'cue', 'lesson',
                'baselineDigest', 'candidateDigest', 'harness', 'evidence', 'status', 'promotion']);
            if (entry.status !== 'experimental' || entry.promotion !== 'not-authorized')
                continue;
            if (!/^[a-f0-9]{64}$/.test(entry.id) || typeof entry.baselineDigest !== 'string' ||
                !/^[a-f0-9]{64}$/.test(entry.baselineDigest))
                continue;
            text(entry.sourceTaskId, 'sourceTaskId');
            text(entry.cue, 'cue', 2048);
            text(entry.lesson, 'lesson', 4096);
            if (!Array.isArray(entry.evidence) || entry.evidence.length < 1 || entry.evidence.length > 7)
                continue;
            for (const evidence of entry.evidence) {
                if (!evidence || typeof evidence !== 'object' || Array.isArray(evidence))
                    throw new Error('invalid evidence');
                keys(evidence, ['sequence', 'kind', 'candidateDigest']);
                if (!Number.isInteger(evidence.sequence) || Number(evidence.sequence) < 1 ||
                    !['probe:invariant', 'probe:domain', 'probe:composition'].includes(String(evidence.kind)) ||
                    evidence.candidateDigest !== entry.candidateDigest)
                    throw new Error('invalid evidence');
            }
            validateDocument(entry.harness);
            if (digestDocument(entry.harness) !== entry.candidateDigest)
                continue;
        }
        catch {
            continue;
        }
        const tokens = new Set(`${entry.cue} ${entry.lesson}`.toLowerCase().match(/[a-z0-9]{3,}/g) ?? []);
        const score = [...words].filter(w => tokens.has(w)).length;
        if (score)
            ranked.push({ entry, score, id: entry.id });
    }
    ranked.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
    return snapshot({ tenantId: clean.tenantId, projectId: clean.projectId, entries: ranked.slice(0, limit).map(r => r.entry) });
}
//# sourceMappingURL=memory.js.map