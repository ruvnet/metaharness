// SPDX-License-Identifier: MIT
//
// Numeric-genome archive (ADR-272) — mirrors `archive.ts`'s API and semantics
// (population TREE, non-promoted variants retained not deleted, deterministic
// insertion-order tie-breaks, tolerant load) but typed for `NumericVariant` /
// `NumericScoreCard` instead of the prompt kind's `HarnessVariant` / `ScoreCard`.
// Kept as a separate small class rather than generifying `Archive` in place, so
// the existing prompt-kind archive and its tests are untouched.
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
export class NumericArchive {
    file;
    records = new Map();
    constructor(file) {
        this.file = file;
    }
    async load() {
        this.records.clear();
        let raw;
        try {
            raw = await readFile(this.file, 'utf8');
        }
        catch {
            return;
        }
        let parsed;
        try {
            parsed = JSON.parse(raw);
        }
        catch {
            return;
        }
        if (!Array.isArray(parsed))
            return;
        for (const entry of parsed) {
            if (!isNumericArchiveRecord(entry))
                continue;
            this.records.set(entry.variant.id, entry);
        }
    }
    addVariant(variant) {
        if (this.records.has(variant.id))
            return;
        this.records.set(variant.id, { variant, score: null, children: [] });
        const parentId = variant.parentId;
        if (parentId !== null) {
            const parent = this.records.get(parentId);
            if (parent && !parent.children.includes(variant.id))
                parent.children.push(variant.id);
        }
    }
    setScore(variantId, score) {
        const record = this.records.get(variantId);
        if (!record) {
            throw new Error(`NumericArchive.setScore: unknown variant "${variantId}" (add it before scoring)`);
        }
        record.score = score;
    }
    get(variantId) {
        return this.records.get(variantId);
    }
    all() {
        return [...this.records.values()];
    }
    /** The scored record with the highest `score.primary`, ties → earliest insertion. */
    best() {
        let winner = null;
        for (const record of this.records.values()) {
            if (record.score === null)
                continue;
            if (winner === null || record.score.primary > winner.score.primary)
                winner = record;
        }
        return winner;
    }
    /** Top-`limit` scored variants by `primary`, whole-archive (ADR-073 stall fallback). */
    selectParents(limit) {
        if (limit <= 0)
            return [];
        const scored = [];
        let index = 0;
        for (const record of this.records.values()) {
            if (record.score !== null && !record.score.regressed)
                scored.push({ record, index });
            index += 1;
        }
        scored.sort((a, b) => {
            const delta = b.record.score.primary - a.record.score.primary;
            if (delta !== 0)
                return delta;
            return a.index - b.index;
        });
        return scored.slice(0, limit).map((s) => s.record.variant);
    }
    lineageOf(variantId) {
        if (!this.records.has(variantId))
            return [];
        const path = [];
        const seen = new Set();
        let currentId = variantId;
        while (currentId !== null && !seen.has(currentId)) {
            const record = this.records.get(currentId);
            if (!record)
                break;
            seen.add(currentId);
            path.push(currentId);
            currentId = record.variant.parentId;
        }
        return path.reverse();
    }
    async save() {
        await mkdir(dirname(this.file), { recursive: true });
        const json = JSON.stringify(this.all(), null, 2);
        await writeFile(this.file, `${json}\n`, 'utf8');
    }
}
function isNumericArchiveRecord(value) {
    if (value === null || typeof value !== 'object')
        return false;
    const obj = value;
    const variant = obj.variant;
    if (variant === null || typeof variant !== 'object')
        return false;
    if (typeof variant.id !== 'string')
        return false;
    if (!Array.isArray(obj.children))
        return false;
    return true;
}
//# sourceMappingURL=numeric-archive.js.map