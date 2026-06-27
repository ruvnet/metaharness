// SPDX-License-Identifier: MIT
//
// Human-gated HackerOne submission tests (ADR-197) — all $0 / offline.
//
// ABSOLUTE SAFETY: NO test in this file performs a real network submission. The
// HackerOne client is fully mocked; submitReport is a spy that records calls but
// never touches the network. The happy path reaches the MOCKED submit only when
// all four gates pass. Every gate's REJECTION is asserted independently.

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// TEST HYGIENE: redirect the taxonomy cache to an OS-temp path so any CLI
// dispatch that resolves a dev .env writes there, never the user's real cache.
let _tmpDir: string;
beforeAll(() => {
  _tmpDir = mkdtempSync(join(tmpdir(), 'h1-submit-'));
  process.env.REDBLUE_H1_CACHE = join(_tmpDir, 'h1-weaknesses.json');
});
afterAll(() => {
  delete process.env.REDBLUE_H1_CACHE;
  if (_tmpDir) rmSync(_tmpDir, { recursive: true, force: true });
});

import {
  gatedSubmit,
  isNonInteractive,
  matchAssetInScope,
  type GatedSubmitInput,
} from '../src/integrations/h1-submit.js';
import { toHackerOneReport } from '../src/reports/hackerone.js';
import type {
  ProgramScopeResult,
  ScopeAsset,
  WriteScopeProbe,
  SubmitResult,
} from '../src/integrations/hackerone.js';
import { dispatch } from '../src/cli/index.js';
import type { TestResult } from '../src/types.js';

// ---- Fixtures --------------------------------------------------------------

const mkResult = (over: Partial<TestResult> = {}): TestResult => ({
  testId: 't-1',
  family: 'data_exfiltration_attempt',
  passed: false,
  compromised: true,
  evidence: ['observed disclosure of synthetic secret'],
  severity: 'High',
  severityScore: 0.72,
  toolAbuse: false,
  dataLeakage: true,
  policyViolation: true,
  costUsd: 0,
  latencyMs: 1,
  ...over,
});

/** A draft against an in-scope asset, with a confirmed repro (passes 2 gates). */
const goodDraft = () =>
  toHackerOneReport(mkResult(), {
    asset: 'app.example.com',
    reproConfirmed: true,
    reproMethod: 'redblue run',
  });

const IN_SCOPE_ASSETS: ScopeAsset[] = [
  { identifier: 'app.example.com', assetType: 'URL', eligibleForSubmission: true },
  { identifier: 'https://legacy.example.com', assetType: 'URL', eligibleForSubmission: true },
  { identifier: 'internal.example.com', assetType: 'URL', eligibleForSubmission: false },
];

/** Build a mock client. submitReport is a spy that NEVER hits the network. */
function mockClient(opts: {
  live?: boolean;
  scope?: ProgramScopeResult;
  writeScope?: WriteScopeProbe;
  submit?: SubmitResult;
}) {
  const submitSpy = vi.fn(async (): Promise<SubmitResult> =>
    opts.submit ?? { ok: true, reportId: 'REPORT-123', status: 200 },
  );
  return {
    isLive: () => opts.live ?? true,
    programScope: vi.fn(
      async (): Promise<ProgramScopeResult> =>
        opts.scope ?? { handle: 'acme', readable: true, assets: IN_SCOPE_ASSETS },
    ),
    probeWriteScope: vi.fn(
      async (): Promise<WriteScopeProbe> => opts.writeScope ?? { status: 'present' },
    ),
    submitReport: submitSpy,
    _submitSpy: submitSpy,
  };
}

/** All-gates-pass input (dry-run flag controlled by caller). */
function passingInput(over: Partial<GatedSubmitInput> = {}): GatedSubmitInput {
  const client = mockClient({});
  return {
    draft: goodDraft(),
    program: 'acme',
    client,
    flags: { dryRun: true, confirm: true, iAmSubmitter: true },
    reportCount: 1,
    env: {}, // no CI markers
    isTty: true, // interactive
    ...over,
  };
}

/** Pull a named gate verdict out of a result (throws if missing). */
function verdict(r: { verdicts: Array<{ gate: string; passed: boolean; reason: string }> }, gate: string) {
  const v = r.verdicts.find((x) => x.gate === gate);
  if (!v) throw new Error(`no verdict for gate ${gate}`);
  return v;
}
function scopeVerdict(r: { verdicts: Array<{ gate: string; passed: boolean; reason: string }> }) {
  return verdict(r, 'scope');
}

// ---- helpers (asset matching + env detection) ------------------------------

describe('matchAssetInScope', () => {
  it('matches an eligible asset (scheme-insensitive, case-insensitive)', () => {
    expect(matchAssetInScope('app.example.com', IN_SCOPE_ASSETS)?.identifier).toBe('app.example.com');
    expect(matchAssetInScope('https://APP.example.com/', IN_SCOPE_ASSETS)?.identifier).toBe('app.example.com');
    expect(matchAssetInScope('legacy.example.com', IN_SCOPE_ASSETS)?.identifier).toBe('https://legacy.example.com');
  });
  it('refuses an INELIGIBLE asset even if the identifier matches (fail closed)', () => {
    expect(matchAssetInScope('internal.example.com', IN_SCOPE_ASSETS)).toBeNull();
  });
  it('refuses an out-of-scope asset and a missing asset', () => {
    expect(matchAssetInScope('evil.example.org', IN_SCOPE_ASSETS)).toBeNull();
    expect(matchAssetInScope(undefined, IN_SCOPE_ASSETS)).toBeNull();
  });
});

describe('isNonInteractive', () => {
  it('treats non-TTY as non-interactive', () => {
    expect(isNonInteractive({}, false)).toBe(true);
  });
  it('treats common CI markers as non-interactive even with a TTY', () => {
    expect(isNonInteractive({ CI: 'true' }, true)).toBe(true);
    expect(isNonInteractive({ GITHUB_ACTIONS: '1' }, true)).toBe(true);
    expect(isNonInteractive({ CI: 'false' }, true)).toBe(false);
  });
  it('treats an interactive TTY with no CI markers as interactive', () => {
    expect(isNonInteractive({}, true)).toBe(false);
  });
});

// ---- DRY-RUN default (submits nothing) -------------------------------------

describe('gatedSubmit: dry-run is the default and submits nothing', () => {
  it('all gates pass in dry-run, but submitReport is NEVER called', async () => {
    const input = passingInput(); // dryRun: true
    const r = await gatedSubmit(input);
    expect(r.dryRun).toBe(true);
    expect(r.allGatesPassed).toBe(true);
    expect((input.client as any)._submitSpy).not.toHaveBeenCalled();
    const text = r.lines.join('\n');
    expect(text).toContain('DRY-RUN');
    expect(text).toContain('What WOULD be submitted');
    // shows the program + matched in-scope asset + redacted body, submits nothing
    expect(text).toContain('acme');
    expect(text).toContain('app.example.com');
  });

  it('dry-run prints per-gate verdicts even when a gate fails', async () => {
    const input = passingInput({ flags: { dryRun: true, confirm: false, iAmSubmitter: false } });
    const r = await gatedSubmit(input);
    expect(r.dryRun).toBe(true);
    expect(r.allGatesPassed).toBe(false);
    expect((input.client as any)._submitSpy).not.toHaveBeenCalled();
    expect(r.lines.join('\n')).toMatch(/FAIL.*confirm/);
  });
});

// ---- GATE 1: SCOPE (fail closed) -------------------------------------------

describe('gatedSubmit: scope gate', () => {
  it('REFUSES (fail closed) when scope cannot be read', async () => {
    const client = mockClient({
      scope: { handle: 'acme', readable: false, assets: [], note: 'team not readable' },
    });
    const r = await gatedSubmit(
      passingInput({ client, flags: { dryRun: false, confirm: true, iAmSubmitter: true } }),
    );
    expect(r.allGatesPassed).toBe(false);
    expect(scopeVerdict(r).passed).toBe(false);
    expect(scopeVerdict(r).reason).toContain('FAIL CLOSED');
    expect((client as any)._submitSpy).not.toHaveBeenCalled();
  });

  it('REFUSES when the asset is not an in-scope eligible asset', async () => {
    const draft = toHackerOneReport(mkResult(), { asset: 'evil.example.org', reproConfirmed: true });
    const client = mockClient({});
    const r = await gatedSubmit(
      passingInput({ draft, client, flags: { dryRun: false, confirm: true, iAmSubmitter: true } }),
    );
    expect(scopeVerdict(r).passed).toBe(false);
    expect((client as any)._submitSpy).not.toHaveBeenCalled();
  });

  it('REFUSES when the matching asset is ineligible for submission', async () => {
    const draft = toHackerOneReport(mkResult(), { asset: 'internal.example.com', reproConfirmed: true });
    const client = mockClient({});
    const r = await gatedSubmit(
      passingInput({ draft, client, flags: { dryRun: false, confirm: true, iAmSubmitter: true } }),
    );
    expect(scopeVerdict(r).passed).toBe(false);
    expect((client as any)._submitSpy).not.toHaveBeenCalled();
  });

  it('REFUSES (fail closed) when no token / not live', async () => {
    const client = mockClient({ live: false });
    const r = await gatedSubmit(
      passingInput({ client, flags: { dryRun: false, confirm: true, iAmSubmitter: true } }),
    );
    expect(scopeVerdict(r).passed).toBe(false);
    expect((client as any)._submitSpy).not.toHaveBeenCalled();
  });
});

// ---- GATE 2: VERIFICATION (AI-slop guard) ----------------------------------

describe('gatedSubmit: verification gate', () => {
  it('REFUSES an unverified draft (repro.confirmed !== true)', async () => {
    const draft = toHackerOneReport(mkResult(), { asset: 'app.example.com' /* reproConfirmed omitted */ });
    expect(draft.repro.confirmed).toBe(false);
    const client = mockClient({});
    const r = await gatedSubmit(
      passingInput({ draft, client, flags: { dryRun: false, confirm: true, iAmSubmitter: true } }),
    );
    expect(verdict(r, 'verification').passed).toBe(false);
    expect(r.allGatesPassed).toBe(false);
    expect((client as any)._submitSpy).not.toHaveBeenCalled();
  });
});

// ---- GATE 3: per-report confirm --------------------------------------------

describe('gatedSubmit: confirm gate', () => {
  it('REFUSES without --confirm', async () => {
    const client = mockClient({});
    const r = await gatedSubmit(
      passingInput({ client, flags: { dryRun: false, confirm: false, iAmSubmitter: true } }),
    );
    expect(verdict(r, 'confirm').passed).toBe(false);
    expect((client as any)._submitSpy).not.toHaveBeenCalled();
  });
  it('REFUSES without --i-am-submitter', async () => {
    const client = mockClient({});
    const r = await gatedSubmit(
      passingInput({ client, flags: { dryRun: false, confirm: true, iAmSubmitter: false } }),
    );
    expect(verdict(r, 'confirm').passed).toBe(false);
    expect((client as any)._submitSpy).not.toHaveBeenCalled();
  });
});

// ---- GATE 4: no batch / no autonomous --------------------------------------

describe('gatedSubmit: no-batch / no-autonomous gate', () => {
  it('REFUSES more than one report', async () => {
    const client = mockClient({});
    const r = await gatedSubmit(
      passingInput({ client, reportCount: 2, flags: { dryRun: false, confirm: true, iAmSubmitter: true } }),
    );
    expect(verdict(r, 'no-batch').passed).toBe(false);
    expect((client as any)._submitSpy).not.toHaveBeenCalled();
  });

  it('REFUSES zero reports', async () => {
    const client = mockClient({});
    const r = await gatedSubmit(
      passingInput({ client, reportCount: 0, flags: { dryRun: false, confirm: true, iAmSubmitter: true } }),
    );
    expect(verdict(r, 'no-batch').passed).toBe(false);
    expect((client as any)._submitSpy).not.toHaveBeenCalled();
  });

  it('REFUSES the real path in a CI / non-interactive env', async () => {
    const client = mockClient({});
    const r = await gatedSubmit(
      passingInput({
        client,
        env: { CI: 'true' },
        isTty: false,
        flags: { dryRun: false, confirm: true, iAmSubmitter: true },
      }),
    );
    expect(verdict(r, 'no-batch').passed).toBe(false);
    expect((client as any)._submitSpy).not.toHaveBeenCalled();
  });

  it('ALLOWS a dry-run in CI (dry-run never submits regardless of env)', async () => {
    const client = mockClient({});
    const r = await gatedSubmit(
      passingInput({ client, env: { CI: 'true' }, isTty: false, flags: { dryRun: true, confirm: true, iAmSubmitter: true } }),
    );
    // no-batch passes for a single-report dry-run; nothing is submitted anyway.
    expect(verdict(r, 'no-batch').passed).toBe(true);
    expect((client as any)._submitSpy).not.toHaveBeenCalled();
  });
});

// ---- HAPPY PATH: reaches the MOCKED submit only when all gates pass ---------

describe('gatedSubmit: happy path reaches the MOCKED submit', () => {
  it('submits (mocked) when all four gates pass and --no-dry-run', async () => {
    const client = mockClient({ submit: { ok: true, reportId: 'REPORT-999', status: 200 } });
    const r = await gatedSubmit(
      passingInput({ client, flags: { dryRun: false, confirm: true, iAmSubmitter: true } }),
    );
    expect(r.allGatesPassed).toBe(true);
    expect(r.dryRun).toBe(false);
    expect((client as any)._submitSpy).toHaveBeenCalledTimes(1);
    // verifies the mocked POST carried the right program + title (no token).
    const callArg = (client as any)._submitSpy.mock.calls[0][0];
    expect(callArg.teamHandle).toBe('acme');
    expect(callArg.title).toBe(goodDraft().title);
    expect(r.submit?.ok).toBe(true);
    expect(r.submit?.reportId).toBe('REPORT-999');
    expect(r.lines.join('\n')).toContain('submitter of record');
  });

  it('REFUSES the real path (no POST) when write scope is known-absent', async () => {
    const client = mockClient({ writeScope: { status: 'absent', note: 'token lacks report-write permission' } });
    const r = await gatedSubmit(
      passingInput({ client, flags: { dryRun: false, confirm: true, iAmSubmitter: true } }),
    );
    expect(r.allGatesPassed).toBe(true); // core gates pass...
    expect((client as any)._submitSpy).not.toHaveBeenCalled(); // ...but write is absent → no POST
    expect(r.lines.join('\n')).toContain('lacks report-write scope');
  });

  it('reports a clean failure (no partial submit) when the mocked POST fails', async () => {
    const client = mockClient({ submit: { ok: false, status: 422, note: 'validation error' } });
    const r = await gatedSubmit(
      passingInput({ client, flags: { dryRun: false, confirm: true, iAmSubmitter: true } }),
    );
    expect((client as any)._submitSpy).toHaveBeenCalledTimes(1);
    expect(r.submit?.ok).toBe(false);
    expect(r.lines.join('\n')).toContain('No partial report was created');
  });
});

// ---- CLI integration: submit subcommand (dry-run default, no network) ------

describe('CLI: hackerone submit is dry-run by default and never submits', () => {
  let draftPath: string;
  let batchPath: string;
  beforeAll(() => {
    draftPath = join(_tmpDir, 'one.json');
    batchPath = join(_tmpDir, 'many.json');
    writeFileSync(draftPath, JSON.stringify({ reports: [goodDraft()] }, null, 2));
    writeFileSync(batchPath, JSON.stringify({ reports: [goodDraft(), goodDraft()] }, null, 2));
  });

  it('requires --report and --program', async () => {
    const a = await dispatch('hackerone', ['submit']);
    expect(a.code).toBe(2);
    const b = await dispatch('hackerone', ['submit', '--program', 'acme']);
    expect(b.code).toBe(2);
    expect(b.lines.join('\n')).toContain('--report');
  });

  it('defaults to dry-run (prints what WOULD be submitted, submits nothing)', async () => {
    // No key in test env → scope gate fails closed; but it is still a dry-run
    // that submits nothing and exits 0 (a dry-run that ran is success).
    const r = await dispatch('hackerone', ['submit', '--report', draftPath, '--program', 'acme']);
    expect(r.code).toBe(0);
    const text = r.lines.join('\n');
    expect(text).toContain('DRY-RUN');
    expect(text).toContain('What WOULD be submitted');
  });

  it('refuses a batch report file (more than one report) — no autonomous batch', async () => {
    const r = await dispatch('hackerone', [
      'submit',
      '--report',
      batchPath,
      '--program',
      'acme',
      '--no-dry-run',
      '--confirm',
      '--i-am-submitter',
    ]);
    expect(r.code).toBe(2);
    expect(r.lines.join('\n')).toContain('exactly one report');
  });
});
