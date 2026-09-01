// SPDX-License-Identifier: MIT
//
// Darwin Shield — REAL Semgrep oracle (ADR-155 Addendum A, Phase 2). The first
// real analyzer behind the `DetectorOracle`-shaped contract: a generated rule is
// run by actual `semgrep --json` against a real, labeled target, and its findings
// are scored against ground-truth labels. This is the step from seeded mock
// validation to a real tool — but it stays OPTIONAL: when semgrep is not on PATH
// the oracle reports `available: false` and callers skip, so the deterministic
// suite is green everywhere (semgrep present or not).
//
// Safety: semgrep is a read-only static analyzer; we invoke it via `execFileSync`
// with a bare argv (never a shell — no injection surface), exactly like
// `sandbox.ts`. The generated rule is the only thing that varies, and it is
// written to a temp file, never interpolated into a command line.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, isAbsolute } from 'node:path';
const round6 = (v) => +(Math.round(v * 1e6) / 1e6).toFixed(6);
/** Resolve the semgrep binary: explicit arg → `SEMGREP_BIN` env → PATH. */
function resolveBinary(binary) {
    return binary || process.env.SEMGREP_BIN || 'semgrep';
}
/** Probe whether semgrep is runnable; never throws. */
export function semgrepAvailability(binary) {
    const bin = resolveBinary(binary);
    try {
        const out = execFileSync(bin, ['--version'], { encoding: 'utf8', timeout: 20_000, stdio: ['ignore', 'pipe', 'ignore'] });
        return { available: true, version: out.trim().split('\n')[0], binary: bin };
    }
    catch (e) {
        return { available: false, version: '', binary: bin, reason: e instanceof Error ? e.message : String(e) };
    }
}
/** The real Semgrep detection oracle (Phase 2). Optional — skips when absent. */
export class SemgrepDetectorOracle {
    name = 'semgrep';
    binary;
    timeoutMs;
    constructor(opts = {}) {
        this.binary = resolveBinary(opts.binary);
        this.timeoutMs = opts.timeoutMs ?? 120_000;
    }
    availability() {
        return semgrepAvailability(this.binary);
    }
    isAvailable() {
        return this.availability().available;
    }
    /**
     * Run a generated rule (YAML) through real semgrep against a directory.
     * Returns normalized, sorted findings. Throws only if semgrep is present but
     * the invocation itself fails unexpectedly; callers should gate on isAvailable.
     */
    run(ruleYaml, targetDir) {
        const work = mkdtempSync(join(tmpdir(), 'darwin-shield-semgrep-'));
        const ruleFile = join(work, 'rule.yaml');
        writeFileSync(ruleFile, ruleYaml);
        try {
            // `--error` is NOT set: semgrep exits non-zero on findings, which we want as data.
            let stdout = '';
            try {
                stdout = execFileSync(this.binary, ['--quiet', '--json', '--disable-version-check', '--config', ruleFile, targetDir], { encoding: 'utf8', timeout: this.timeoutMs, maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
            }
            catch (e) {
                // Distinguish semgrep's exit codes: status===1 means "findings present"
                // and stdout still holds the JSON (the happy path). status>=2 (or empty/
                // missing stdout) is a REAL failure — bad rule, internal error — so throw
                // a descriptive error rather than letting JSON.parse('') throw a confusing one.
                const err = e;
                const status = typeof err.status === 'number' ? err.status : undefined;
                const captured = err.stdout ? err.stdout.toString() : '';
                if (status === 1 && captured) {
                    stdout = captured;
                }
                else {
                    const stderr = err.stderr ? err.stderr.toString().trim() : '';
                    throw new Error(`semgrep failed (exit ${status ?? 'unknown'})${stderr ? `: ${stderr}` : captured ? `: ${captured.slice(0, 500)}` : ''}`);
                }
            }
            if (!stdout.trim())
                throw new Error('semgrep produced no output');
            const parsed = JSON.parse(stdout);
            const findings = (parsed.results ?? []).map((r) => ({
                path: isAbsolute(r.path) ? relative(targetDir, r.path) : r.path,
                line: r.start?.line ?? 0,
                // Normalize: semgrep namespaces an ad-hoc rule by its (temp) file path —
                // keep only the final rule-id segment so receipts are deterministic.
                ruleId: (r.check_id ?? 'unknown').split('.').pop() ?? 'unknown',
            }));
            findings.sort((a, b) => a.path.localeCompare(b.path) || a.line - b.line || a.ruleId.localeCompare(b.ruleId));
            return findings;
        }
        finally {
            rmSync(work, { recursive: true, force: true });
        }
    }
    /**
     * Run the rule and SCORE it against the target's labels (file-level matching,
     * robust to line drift). Gracefully returns `available: false` when semgrep is
     * absent — the caller (test/bench) then skips rather than failing.
     */
    evaluate(ruleYaml, target) {
        const avail = this.availability();
        if (!avail.available) {
            return { available: false, version: '', findings: [], truePositives: 0, falsePositives: 0, falseNegatives: 0, precision: 0, recall: 0, reason: avail.reason };
        }
        const findings = this.run(ruleYaml, target.dir);
        const detected = new Set(findings.map((f) => f.path));
        const vulnerable = new Set(target.labels.filter((l) => l.vulnerable).map((l) => l.file));
        const decoys = new Set(target.labels.filter((l) => !l.vulnerable).map((l) => l.file));
        let tp = 0;
        let fp = 0;
        for (const d of detected) {
            if (vulnerable.has(d))
                tp += 1;
            else if (decoys.has(d))
                fp += 1;
            else
                fp += 1; // a finding on an unlabeled (clean) file is a false positive
        }
        let fn = 0;
        for (const v of vulnerable)
            if (!detected.has(v))
                fn += 1;
        const precision = tp + fp > 0 ? round6(tp / (tp + fp)) : 1;
        const recall = vulnerable.size > 0 ? round6(tp / vulnerable.size) : 1;
        return { available: true, version: avail.version, findings, truePositives: tp, falsePositives: fp, falseNegatives: fn, precision, recall };
    }
}
//# sourceMappingURL=semgrep-oracle.js.map