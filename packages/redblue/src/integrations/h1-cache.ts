// SPDX-License-Identifier: MIT
//
// Local taxonomy cache for the HackerOne weakness set.
//
// COMPLIANCE / OPTIMIZE: the full HackerOne weakness taxonomy is ~1631 entries
// (17 pages of 100). Re-fetching that on every run wastes the read rate budget
// (HackerOne documents 600 reads/min). This module persists one fetch to a local
// JSON file with a TTL so subsequent runs read from disk (≈0 requests) until the
// cache expires. Cache-first is therefore a *compliance feature*, not just speed.
//
// SAFETY/SECRETS: the cache stores ONLY the public weakness taxonomy (name +
// external_id). It NEVER stores the API token, account data, or any response
// metadata. The file lives under the user's home (~/.claude/redblue) by default.

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, resolve } from 'node:path';
import type { HackerOneWeakness } from './hackerone.js';

/** Default cache TTL: 7 days. The CWE taxonomy changes rarely. */
export const DEFAULT_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Default cache location: ~/.claude/redblue/h1-weaknesses.json
 *
 * Overridable via the `REDBLUE_H1_CACHE` env var (an absolute file path) so a
 * test/CI run, or a user with a custom layout, can redirect the cache and never
 * touch the real home-dir file. An empty/unset var uses the home-dir default.
 */
export function defaultCachePath(env: NodeJS.ProcessEnv = process.env): string {
  const override = (env.REDBLUE_H1_CACHE || '').trim();
  if (override) return resolve(override);
  return resolve(homedir(), '.claude', 'redblue', 'h1-weaknesses.json');
}

/** On-disk cache envelope. Versioned so a format change invalidates cleanly. */
export interface TaxonomyCache {
  /** Cache format version. Bump to invalidate old files. */
  version: 1;
  /** Epoch ms when this snapshot was written. */
  fetchedAt: number;
  /** total_count reported by the API at fetch time (sanity / completeness). */
  totalCount: number;
  /** The persisted weakness taxonomy. */
  weaknesses: HackerOneWeakness[];
}

const CACHE_VERSION = 1 as const;

/** A pluggable filesystem (lets tests avoid touching the real disk). */
export interface CacheFs {
  read(path: string): string;
  write(path: string, data: string): void;
}

const realFs: CacheFs = {
  read: (p) => readFileSync(p, 'utf8'),
  write: (p, d) => {
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, d);
  },
};

export interface CacheOptions {
  /** Cache file path (defaults to ~/.claude/redblue/h1-weaknesses.json). */
  path?: string;
  /** TTL in ms (defaults to 7 days). */
  ttlMs?: number;
  /** Injectable fs for tests. */
  fs?: CacheFs;
  /** Override "now" for deterministic TTL tests. */
  now?: () => number;
}

/**
 * Read the cache if present and fresh. Returns null on any of: missing file,
 * parse error, wrong version, or expired TTL. Never throws — a bad cache simply
 * means "cache miss" and the caller falls through to live → static.
 */
export function readCache(opts: CacheOptions = {}): TaxonomyCache | null {
  const path = opts.path ?? defaultCachePath();
  const ttl = opts.ttlMs ?? DEFAULT_CACHE_TTL_MS;
  const fs = opts.fs ?? realFs;
  const now = (opts.now ?? Date.now)();
  let raw: string;
  try {
    raw = fs.read(path);
  } catch {
    return null; // missing file → miss
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null; // corrupt → miss
  }
  if (!isTaxonomyCache(parsed)) return null;
  if (parsed.version !== CACHE_VERSION) return null;
  if (now - parsed.fetchedAt > ttl) return null; // expired → miss
  if (parsed.weaknesses.length === 0) return null; // empty snapshot → miss
  return parsed;
}

/**
 * Write a fresh snapshot to the cache. Never throws (a non-writable cache dir
 * must not break a report export); returns true on success, false otherwise.
 */
export function writeCache(
  weaknesses: HackerOneWeakness[],
  totalCount: number,
  opts: CacheOptions = {},
): boolean {
  const path = opts.path ?? defaultCachePath();
  const fs = opts.fs ?? realFs;
  const now = (opts.now ?? Date.now)();
  const envelope: TaxonomyCache = {
    version: CACHE_VERSION,
    fetchedAt: now,
    totalCount,
    weaknesses,
  };
  try {
    fs.write(path, JSON.stringify(envelope, null, 2));
    return true;
  } catch {
    return false;
  }
}

function isTaxonomyCache(v: unknown): v is TaxonomyCache {
  if (typeof v !== 'object' || v === null) return false;
  const o = v as Record<string, unknown>;
  return (
    typeof o.version === 'number' &&
    typeof o.fetchedAt === 'number' &&
    typeof o.totalCount === 'number' &&
    Array.isArray(o.weaknesses)
  );
}
