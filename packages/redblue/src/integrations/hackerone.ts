// SPDX-License-Identifier: MIT
//
// Read-only HackerOne API client (GraphQL).
//
// SAFETY / SECRETS (strict):
//   - Auth is a single API token sent as `X-Auth-Token: <HACKERONE_API_KEY>`
//     against the GraphQL endpoint (https://hackerone.com/graphql). The token is
//     read at RUNTIME from the process environment (or a local .env loaded at
//     runtime — never imported into source, never written to any file).
//   - The token is NEVER logged, printed, echoed, or returned.
//   - The API is used READ-ONLY here: it fetches the weakness taxonomy (CWE).
//     This client has no write/submit method at all. (Report "export" produces a
//     draft only; see reports/hackerone.ts. A live submit, if ever built, is
//     hard-gated in the CLI and default-off — it is not in this module.)
//   - With no token present, every method falls back to a built-in static CWE
//     map so offline/CI works deterministically at $0.
//
// NOTE on auth: HackerOne's v1 REST API uses HTTP Basic (username:api_token),
// but a personal API token issued without an identifier authenticates instead
// via the GraphQL endpoint with the X-Auth-Token header (no username). This
// client uses the GraphQL path, which is what the configured token requires.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { AttackFamily } from '../types.js';
import { FAMILY_TAXONOMY } from './cwe-cvss.js';

const HACKERONE_GRAPHQL_ENDPOINT = 'https://hackerone.com/graphql';

/** A weakness entry from the HackerOne taxonomy (CWE-bearing). */
export interface HackerOneWeakness {
  /** HackerOne weakness name. */
  name: string;
  /**
   * External taxonomy id as returned by HackerOne, e.g. "cwe-79" / "capec-597".
   * Normalized to upper-case CWE form ("CWE-79") when it is a CWE; left as-is
   * otherwise. Undefined when HackerOne has no external id for the weakness.
   */
  externalId?: string;
  /** Stable id used for the static fallback (the CWE id). */
  id: string;
}

export interface HackerOneCredentials {
  /** The single API token (sent as X-Auth-Token). */
  apiKey: string;
}

/**
 * Minimal, dependency-free .env reader (KEY=VALUE lines). Used ONLY at runtime
 * to populate the token when it is not already in process.env. It never persists
 * anything and only reads the single HackerOne key it needs.
 *
 * Lines: `KEY=VALUE`, `#` comments and blank lines ignored, optional surrounding
 * quotes stripped, no interpolation. Deliberately tiny + auditable.
 */
function readEnvFile(path: string): Record<string, string> {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    return {};
  }
  const out: Record<string, string> = {};
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

/**
 * Resolve the HackerOne API token at RUNTIME.
 *
 * Order: process.env first, then a local .env (the provided path or ./.env) —
 * loaded only here, only when needed, never imported into source. Returns null
 * when no token is available (the no-key path), which keeps the static fallback
 * active. The returned value is for in-process use only; never logged or stored.
 */
export function resolveCredentials(opts?: {
  envFilePath?: string;
  env?: NodeJS.ProcessEnv;
}): HackerOneCredentials | null {
  const env = opts?.env ?? process.env;
  let apiKey = (env.HACKERONE_API_KEY || '').trim();

  if (!apiKey) {
    // Runtime-only .env fallback (gitignored). Read just the single key.
    const envPath = resolve(opts?.envFilePath ?? '.env');
    const fileEnv = readEnvFile(envPath);
    apiKey = (fileEnv.HACKERONE_API_KEY || '').trim();
  }

  if (!apiKey) return null;
  return { apiKey };
}

/** True if a live HackerOne call can be made (token present at runtime). */
export function hasHackerOneKey(opts?: {
  envFilePath?: string;
  env?: NodeJS.ProcessEnv;
}): boolean {
  return resolveCredentials(opts) !== null;
}

/** Normalize a HackerOne external id ("cwe-79") to canonical CWE form. */
function normalizeExternalId(raw: unknown): string | undefined {
  if (typeof raw !== 'string' || raw.length === 0) return undefined;
  const m = /^cwe-(\d+)$/i.exec(raw.trim());
  if (m) return `CWE-${m[1]}`;
  return raw.trim();
}

/**
 * Build the static CWE taxonomy fallback from the family mapping. This is what
 * `weaknesses()` returns when no token is present — every CWE referenced by the
 * redblue families, de-duplicated. Deterministic, $0, offline-safe.
 */
export function staticWeaknessFallback(): HackerOneWeakness[] {
  const seen = new Map<string, HackerOneWeakness>();
  for (const family of Object.keys(FAMILY_TAXONOMY) as AttackFamily[]) {
    for (const cwe of FAMILY_TAXONOMY[family].cwe) {
      if (!seen.has(cwe.id)) {
        seen.set(cwe.id, { id: cwe.id, name: cwe.name, externalId: cwe.id });
      }
    }
  }
  return [...seen.values()].sort((a, b) => a.id.localeCompare(b.id));
}

/** Injectable fetch (defaults to global fetch) — lets tests mock the network. */
export type FetchLike = (
  input: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string },
) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

export interface HackerOneClientOptions {
  /** Override credential resolution (tests pass explicit creds or null). */
  credentials?: HackerOneCredentials | null;
  /** Injectable fetch for tests. */
  fetchImpl?: FetchLike;
  /** Path to a runtime .env fallback (defaults to ./.env). */
  envFilePath?: string;
  /** Environment to read (defaults to process.env). */
  env?: NodeJS.ProcessEnv;
}

/**
 * Read-only HackerOne GraphQL client. The ONLY network methods are
 * `weaknesses()` (query weaknesses) and an auth smoke (`authSmoke()` →
 * query me). There is intentionally NO submit/create mutation on this client.
 */
export class HackerOneClient {
  private readonly creds: HackerOneCredentials | null;
  private readonly fetchImpl: FetchLike;

  constructor(options: HackerOneClientOptions = {}) {
    this.creds =
      options.credentials !== undefined
        ? options.credentials
        : resolveCredentials({ envFilePath: options.envFilePath, env: options.env });
    this.fetchImpl = options.fetchImpl ?? (globalThis.fetch as unknown as FetchLike);
  }

  /** True when live credentials are available. */
  isLive(): boolean {
    return this.creds !== null;
  }

  /** POST a GraphQL query with the X-Auth-Token header. Token NEVER logged. */
  private async graphql(
    query: string,
  ): Promise<{ ok: boolean; status: number; body: { data?: unknown; errors?: unknown } }> {
    if (!this.creds) throw new Error('HackerOneClient: no credentials');
    const res = await this.fetchImpl(HACKERONE_GRAPHQL_ENDPOINT, {
      method: 'POST',
      headers: {
        'X-Auth-Token': this.creds.apiKey,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({ query }),
    });
    let body: { data?: unknown; errors?: unknown } = {};
    try {
      body = ((await res.json()) as { data?: unknown; errors?: unknown }) ?? {};
    } catch {
      body = {};
    }
    return { ok: res.ok, status: res.status, body };
  }

  /**
   * Fetch the weakness taxonomy (CWE). Read-only.
   *
   * No token → returns the static fallback (offline/CI safe). With a token,
   * runs `query{weaknesses(first:N){edges{node{name external_id}}}}` and
   * normalizes the payload into HackerOneWeakness[]. Any network/parse/GraphQL
   * error degrades gracefully to the static fallback so a flaky API never breaks
   * a report export.
   */
  async weaknesses(first = 100): Promise<HackerOneWeakness[]> {
    if (!this.creds) return staticWeaknessFallback();
    try {
      const n = Math.max(1, Math.min(500, Math.trunc(first)));
      const query = `query{weaknesses(first:${n}){edges{node{name external_id}}}}`;
      const { ok, body } = await this.graphql(query);
      if (!ok || body.errors) return staticWeaknessFallback();
      const edges = (body.data as { weaknesses?: { edges?: unknown } } | undefined)?.weaknesses
        ?.edges;
      const list = Array.isArray(edges) ? edges : [];
      const parsed = list
        .map((edge) => normalizeWeakness(edge))
        .filter((w): w is HackerOneWeakness => w !== null);
      return parsed.length > 0 ? parsed : staticWeaknessFallback();
    } catch {
      return staticWeaknessFallback();
    }
  }

  /**
   * Read-only auth smoke. Confirms the token authenticates without returning any
   * account contents to the caller. Runs `query{me{username}}` and returns only
   * a boolean + HTTP status — NEVER the response body (which could contain
   * account data).
   *
   * No token → { ok: false, status: 0, live: false }. (Not an error; just no
   * live path.)
   */
  async authSmoke(): Promise<{ ok: boolean; status: number; live: boolean }> {
    if (!this.creds) return { ok: false, status: 0, live: false };
    try {
      const { ok, status, body } = await this.graphql('query{me{username}}');
      // Auth succeeded iff HTTP 200 AND no GraphQL errors. Never surface body.
      const authed = status === 200 && ok && !body.errors;
      return { ok: authed, status, live: true };
    } catch {
      return { ok: false, status: 0, live: true };
    }
  }
}

/** Normalize a GraphQL weakness edge into our shape. */
function normalizeWeakness(edge: unknown): HackerOneWeakness | null {
  if (typeof edge !== 'object' || edge === null) return null;
  const node = (edge as { node?: unknown }).node;
  if (typeof node !== 'object' || node === null) return null;
  const obj = node as { name?: unknown; external_id?: unknown };
  const name = typeof obj.name === 'string' ? obj.name : undefined;
  if (!name) return null;
  const externalId = normalizeExternalId(obj.external_id);
  return { name, externalId, id: externalId ?? name };
}
