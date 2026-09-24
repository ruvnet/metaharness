import { createHash } from 'node:crypto';

import { canon } from './receipts.js';

export const REVIEW_CONTEXT_POLICY = 'independent-review-v1' as const;
export const REVIEW_CONTEXT_AUTHORITY = 'none' as const;

export const REVIEW_EVIDENCE_KINDS = [
  'artifact',
  'specification',
  'test_result',
  'benchmark_result',
  'security_scan',
  'reproduction_receipt',
  'source_reference',
  'policy_reference',
] as const;

export type ReviewEvidenceKind = (typeof REVIEW_EVIDENCE_KINDS)[number];

export type ReviewRole =
  | 'research'
  | 'review'
  | 'security'
  | 'testing'
  | 'reproducibility'
  | 'release';

export interface ReviewEvidenceRef {
  id: string;
  kind: ReviewEvidenceKind | string;
  digest: string;
  sourceDigest: string;
  bytes: number;
}

export interface IndependentReviewInput {
  reviewId: string;
  runId: string;
  tenantDigest: string;
  candidateDigest: string;
  taskDigest: string;
  policyDigest: string;
  evaluatorDigest: string;
  role: ReviewRole;
  createdAt: string;
  expiresAt: string;
  maxEvidenceBytes: number;
  evidence: readonly ReviewEvidenceRef[];
}

export interface IndependentReviewPacket extends IndependentReviewInput {
  contextPolicy: typeof REVIEW_CONTEXT_POLICY;
  authority: typeof REVIEW_CONTEXT_AUTHORITY;
  packetDigest: string;
  evidence: ReviewEvidenceRef[];
}

export interface ReviewPacketExpectation {
  tenantDigest: string;
  candidateDigest: string;
  taskDigest: string;
  policyDigest: string;
  evaluatorDigest: string;
  role: ReviewRole;
}

export interface ReviewPacketVerdict {
  ok: boolean;
  reason: string;
}

const INPUT_KEYS = new Set([
  'reviewId',
  'runId',
  'tenantDigest',
  'candidateDigest',
  'taskDigest',
  'policyDigest',
  'evaluatorDigest',
  'role',
  'createdAt',
  'expiresAt',
  'maxEvidenceBytes',
  'evidence',
]);

const EVIDENCE_KEYS = new Set(['id', 'kind', 'digest', 'sourceDigest', 'bytes']);
const PACKET_KEYS = new Set([...INPUT_KEYS, 'contextPolicy', 'authority', 'packetDigest']);
const ALLOWED_KINDS = new Set<string>(REVIEW_EVIDENCE_KINDS);
const ALLOWED_ROLES = new Set<ReviewRole>([
  'research',
  'review',
  'security',
  'testing',
  'reproducibility',
  'release',
]);
const MAX_EVIDENCE_ITEMS = 256;
const MAX_TOTAL_EVIDENCE_BYTES = 16 * 1024 * 1024;
const TOKEN_RE = /^[A-Za-z0-9][A-Za-z0-9._:/]{0,127}$/;
const DIGEST_RE = /^(?:sha256:)?[a-fA-F0-9]{64}$/;

function fail(message: string): never {
  throw new Error(`independent review context: ${message}`);
}

function assertRecord(value: unknown, label: string): asserts value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) fail(`${label} must be an object`);
}

function assertOnlyKeys(value: Record<string, unknown>, allowed: Set<string>, label: string): void {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) fail(`${label} contains forbidden or unknown field ${key}`);
  }
}

function requireToken(value: unknown, label: string): string {
  if (typeof value !== 'string' || !TOKEN_RE.test(value)) fail(`${label} is not a bounded identifier`);
  return value;
}

function requireDigest(value: unknown, label: string): string {
  if (typeof value !== 'string' || !DIGEST_RE.test(value)) fail(`${label} is not a sha256 digest`);
  const raw = value.toLowerCase();
  return raw.startsWith('sha256:') ? raw : `sha256:${raw}`;
}

function requireTimestamp(value: unknown, label: string): string {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) fail(`${label} is not an ISO timestamp`);
  return new Date(value).toISOString();
}

function requireInteger(value: unknown, label: string, min: number, max: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < min || (value as number) > max) {
    fail(`${label} must be an integer in [${min}, ${max}]`);
  }
  return value as number;
}

function normalizeEvidence(value: unknown, maxEvidenceBytes: number): ReviewEvidenceRef[] {
  if (!Array.isArray(value)) fail('evidence must be an array');
  if (value.length > MAX_EVIDENCE_ITEMS) fail(`evidence exceeds ${MAX_EVIDENCE_ITEMS} items`);

  const seenIds = new Set<string>();
  let totalBytes = 0;
  const out: ReviewEvidenceRef[] = value.map((raw, index) => {
    assertRecord(raw, `evidence[${index}]`);
    assertOnlyKeys(raw, EVIDENCE_KEYS, `evidence[${index}]`);

    const id = requireToken(raw.id, `evidence[${index}].id`);
    if (seenIds.has(id)) fail(`duplicate evidence id ${id}`);
    seenIds.add(id);

    if (typeof raw.kind !== 'string' || !ALLOWED_KINDS.has(raw.kind)) {
      fail(`evidence[${index}].kind is forbidden or unknown`);
    }
    const bytes = requireInteger(raw.bytes, `evidence[${index}].bytes`, 0, MAX_TOTAL_EVIDENCE_BYTES);
    totalBytes += bytes;
    if (totalBytes > maxEvidenceBytes) fail('evidence exceeds maxEvidenceBytes');

    return {
      id,
      kind: raw.kind as ReviewEvidenceKind,
      digest: requireDigest(raw.digest, `evidence[${index}].digest`),
      sourceDigest: requireDigest(raw.sourceDigest, `evidence[${index}].sourceDigest`),
      bytes,
    };
  });

  return out.sort((a, b) =>
    a.kind.localeCompare(b.kind) ||
    a.id.localeCompare(b.id) ||
    a.digest.localeCompare(b.digest) ||
    a.sourceDigest.localeCompare(b.sourceDigest),
  );
}

function normalizeInput(raw: unknown): IndependentReviewInput {
  assertRecord(raw, 'input');
  assertOnlyKeys(raw, INPUT_KEYS, 'input');

  const maxEvidenceBytes = requireInteger(
    raw.maxEvidenceBytes,
    'maxEvidenceBytes',
    0,
    MAX_TOTAL_EVIDENCE_BYTES,
  );
  if (typeof raw.role !== 'string' || !ALLOWED_ROLES.has(raw.role as ReviewRole)) fail('role is unknown');

  const createdAt = requireTimestamp(raw.createdAt, 'createdAt');
  const expiresAt = requireTimestamp(raw.expiresAt, 'expiresAt');
  if (Date.parse(expiresAt) <= Date.parse(createdAt)) fail('expiresAt must be later than createdAt');

  return {
    reviewId: requireToken(raw.reviewId, 'reviewId'),
    runId: requireToken(raw.runId, 'runId'),
    tenantDigest: requireDigest(raw.tenantDigest, 'tenantDigest'),
    candidateDigest: requireDigest(raw.candidateDigest, 'candidateDigest'),
    taskDigest: requireDigest(raw.taskDigest, 'taskDigest'),
    policyDigest: requireDigest(raw.policyDigest, 'policyDigest'),
    evaluatorDigest: requireDigest(raw.evaluatorDigest, 'evaluatorDigest'),
    role: raw.role as ReviewRole,
    createdAt,
    expiresAt,
    maxEvidenceBytes,
    evidence: normalizeEvidence(raw.evidence, maxEvidenceBytes),
  };
}

function unsignedPacket(input: IndependentReviewInput): Omit<IndependentReviewPacket, 'packetDigest'> {
  return {
    ...input,
    contextPolicy: REVIEW_CONTEXT_POLICY,
    authority: REVIEW_CONTEXT_AUTHORITY,
    evidence: [...input.evidence],
  };
}

function digestPacket(packet: Omit<IndependentReviewPacket, 'packetDigest'>): string {
  return `sha256:${createHash('sha256').update(canon(packet)).digest('hex')}`;
}

/**
 * Build a deterministic evidence-only packet for an independent reviewer.
 *
 * The input schema intentionally has no fields for worker reasoning, peer messages,
 * prior verdicts, reward history, shared scratchpads, or reviewer identity. Unknown
 * fields fail closed. Evidence is content addressed and the packet carries no authority.
 */
export function prepareIndependentReviewPacket(raw: unknown): IndependentReviewPacket {
  const input = normalizeInput(raw);
  const unsigned = unsignedPacket(input);
  return { ...unsigned, packetDigest: digestPacket(unsigned) };
}

/** Verify structural integrity, freshness, and expected review bindings. */
export function verifyIndependentReviewPacket(
  raw: unknown,
  expected: ReviewPacketExpectation,
  now: string | Date = new Date(),
): ReviewPacketVerdict {
  try {
    assertRecord(raw, 'packet');
    assertOnlyKeys(raw, PACKET_KEYS, 'packet');
    if (raw.contextPolicy !== REVIEW_CONTEXT_POLICY) return { ok: false, reason: 'context policy mismatch' };
    if (raw.authority !== REVIEW_CONTEXT_AUTHORITY) return { ok: false, reason: 'authority must be none' };
    if (typeof raw.packetDigest !== 'string') return { ok: false, reason: 'packet digest missing' };

    const input: Record<string, unknown> = {};
    for (const key of INPUT_KEYS) input[key] = raw[key];
    const normalized = normalizeInput(input);
    const unsigned = unsignedPacket(normalized);
    if (requireDigest(raw.packetDigest, 'packetDigest') !== digestPacket(unsigned)) {
      return { ok: false, reason: 'packet digest mismatch' };
    }

    const nowMs = now instanceof Date ? now.getTime() : Date.parse(now);
    if (!Number.isFinite(nowMs)) return { ok: false, reason: 'invalid verification time' };
    if (nowMs < Date.parse(normalized.createdAt)) return { ok: false, reason: 'packet not yet valid' };
    if (nowMs >= Date.parse(normalized.expiresAt)) return { ok: false, reason: 'packet expired' };

    const checks: Array<[keyof ReviewPacketExpectation, string]> = [
      ['tenantDigest', normalized.tenantDigest],
      ['candidateDigest', normalized.candidateDigest],
      ['taskDigest', normalized.taskDigest],
      ['policyDigest', normalized.policyDigest],
      ['evaluatorDigest', normalized.evaluatorDigest],
      ['role', normalized.role],
    ];
    for (const [key, actual] of checks) {
      const want = key === 'role' ? expected[key] : requireDigest(expected[key], `expected.${key}`);
      if (actual !== want) return { ok: false, reason: `${key} mismatch` };
    }

    return { ok: true, reason: 'ok' };
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : 'invalid packet' };
  }
}
