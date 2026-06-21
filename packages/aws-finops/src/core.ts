// SPDX-License-Identifier: MIT
//
// Tiny shared primitives. Kept local so the package is dependency-free (no
// cross-package import); mirrors @metaharness/projects' core.round6.

/** Round to 6 decimal places to keep dollar/ratio figures stable and comparable. */
export function round6(n: number): number {
  return Math.round((n + Number.EPSILON) * 1e6) / 1e6;
}

/** Round to cents (2 dp) for human-facing dollar figures. */
export function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}
