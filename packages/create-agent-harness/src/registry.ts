// SPDX-License-Identifier: MIT
//
// IPFS marketplace registry entry generator.
//
// Per ADR-005, a published harness gets a marketplace-registry entry that
// the ruflo plugin marketplace can discover by CID. The entry shape mirrors
// ruflo's existing plugin registry (see v3/@claude-flow/cli/src/plugins/
// store/discovery.ts) so the same browsing UI can list harnesses without
// modification.

import type { HarnessManifest } from './manifest.js';

export interface RegistryEntry {
  id: string;
  name: string;
  displayName: string;
  description: string;
  version: string;
  size: number;
  checksum: string;
  author: {
    id: string;
    displayName: string;
    verified: boolean;
  };
  license: string;
  categories: string[];
  tags: string[];
  downloads: number;
  rating: number;
  lastUpdated: string;
  type: 'harness';
  template: string;
  hosts: string[];
  permissions: string[];
  exports: string[];
  verified: boolean;
  trustLevel: 'official' | 'community' | 'unverified';
  ipfs: {
    manifestCid: string;
    tarballCid?: string;
  };
  witness: {
    publicKey: string;
    signedAt: string;
  };
}

export interface RegistryEntryInput {
  manifest: HarnessManifest;
  description: string;
  author: {
    id: string;
    displayName: string;
    verified?: boolean;
  };
  manifestCid: string;
  tarballCid?: string;
  size: number;
  checksum: string;
  witnessPublicKey: string;
  witnessSignedAt: string;
  trustLevel?: 'official' | 'community' | 'unverified';
  categories?: string[];
  tags?: string[];
}

/**
 * Build a marketplace-registry entry for a published harness.
 * Mirrors the ruflo plugin registry shape so the same UI can browse it.
 */
export function buildRegistryEntry(input: RegistryEntryInput): RegistryEntry {
  const name = (input.manifest.vars.name as string | undefined) ?? 'unnamed-harness';
  const template = input.manifest.template;
  const hosts = input.manifest.hosts;

  // Default categories derive from template id.
  const templateCategory = template.startsWith('vertical:')
    ? template.split(':')[1]!
    : 'general';
  const categories = input.categories ?? ['harness', templateCategory];

  // Default tags pulled from template + hosts + a few defaults.
  const tags = input.tags ?? Array.from(new Set([
    'agent-harness',
    'openharness',
    templateCategory,
    ...hosts.map(h => `host:${h}`),
    'mcp',
  ]));

  return {
    id: `harness/${name}`,
    name,
    displayName: name,
    description: input.description,
    version: '0.1.0',
    size: input.size,
    checksum: input.checksum,
    author: {
      id: input.author.id,
      displayName: input.author.displayName,
      verified: input.author.verified ?? false,
    },
    license: 'MIT',
    categories,
    tags,
    downloads: 0,
    rating: 5,
    lastUpdated: new Date().toISOString(),
    type: 'harness',
    template,
    hosts,
    permissions: ['memory', 'filesystem'],
    exports: ['init', 'mcp'],
    verified: input.author.verified ?? false,
    trustLevel: input.trustLevel ?? 'community',
    ipfs: {
      manifestCid: input.manifestCid,
      tarballCid: input.tarballCid,
    },
    witness: {
      publicKey: input.witnessPublicKey,
      signedAt: input.witnessSignedAt,
    },
  };
}
