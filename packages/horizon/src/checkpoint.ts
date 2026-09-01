// SPDX-License-Identifier: Apache-2.0

import { createHash } from 'node:crypto';
import type { HaltState } from './halt.js';
import type { HorizonEvent } from './driver.js';

export interface HorizonContinuity {
  workspaceCommit: string | null;
  evaluationHistory: unknown[];
  budget: Record<string, number>;
  pendingApprovals: string[];
  archiveBranch: string | null;
  memoryCursor: string | null;
}

export interface HorizonCheckpoint extends HorizonContinuity {
  schema: 1;
  transcript: HorizonEvent[];
  halt: HaltState;
  actionCount: number;
  stateHash: string;
}

function canonical(value: unknown): string {
  if (value === undefined) return 'null';
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object)
    .filter((key) => object[key] !== undefined)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonical(object[key])}`)
    .join(',')}}`;
}

export function hashCheckpoint(checkpoint: Omit<HorizonCheckpoint, 'stateHash'>): string {
  return `sha256:${createHash('sha256').update(canonical(checkpoint)).digest('hex')}`;
}

export function verifyCheckpoint(checkpoint: HorizonCheckpoint): boolean {
  const { stateHash: _ignored, ...body } = checkpoint;
  return hashCheckpoint(body) === checkpoint.stateHash;
}
