#!/usr/bin/env node
// SPDX-License-Identifier: MIT
//
// scripts/generate-oasf-taxonomy.mjs — regenerate src/oasf/taxonomy.generated.json
// from a real local checkout of github.com/agntcy/oasf.
//
// Usage:
//   git clone --depth=1 https://github.com/agntcy/oasf.git /tmp/oasf
//   node scripts/generate-oasf-taxonomy.mjs /tmp/oasf > src/oasf/taxonomy.generated.json
//
// Why this exists (not hand-maintained data): the composite numeric skill id
// AGNTCY's OASF wire schema expects (category*10000 + subcategory*100 + leaf)
// is not documented anywhere in agntcy/oasf itself — it was reverse-engineered
// from agntcy/dir-sdk-javascript's own example.js and confirmed structurally
// against every category/subcategory/leaf JSON file's own `uid` field (see
// src/oasf/publish.ts's file header for the full derivation notes, including
// a real ambiguity this generator resolves correctly: the file that shares its
// own subcategory directory's name — e.g. `code_generation/code_generation.json`
// — is the SUBCATEGORY's own definition (`extends` points at the CATEGORY), not
// a leaf under itself, and is deliberately excluded from the leaf table below.
// Composite ids only ever reference genuine 3-tier leaves.
//
// This script walks the real schema/skills/** tree and computes every genuine
// leaf's composite id directly from that tree, rather than trusting any single
// hardcoded example — so the shipped taxonomy.generated.json is real, complete
// (all leaves as of the checkout's commit), and reproducible.

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const oasfRoot = process.argv[2];
if (!oasfRoot) {
  console.error('Usage: node generate-oasf-taxonomy.mjs <path-to-agntcy/oasf-checkout>');
  process.exit(1);
}

const skillsRoot = join(oasfRoot, 'schema', 'skills');

function loadJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function isDir(path) {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

// Pass 1: categories — every `<name>/<name>.json` with `extends: "base_skill"`.
const categoryUids = new Map();
for (const entry of readdirSync(skillsRoot).sort()) {
  const catDir = join(skillsRoot, entry);
  if (!isDir(catDir)) continue;
  const catFile = join(catDir, `${entry}.json`);
  try {
    const doc = loadJson(catFile);
    if (doc.extends === 'base_skill') categoryUids.set(entry, doc.uid);
  } catch {
    // no self-named category file — not a category directory
  }
}

// Pass 2: subcategories (`<cat>/<sub>/<sub>.json`, extends: `<cat>`) and their
// genuine leaves (`<cat>/<sub>/<leaf>.json`, extends: `<sub>`, name !== sub).
const leaves = [];
for (const [catName, catUid] of categoryUids) {
  const catDir = join(skillsRoot, catName);
  for (const sub of readdirSync(catDir).sort()) {
    const subDir = join(catDir, sub);
    if (!isDir(subDir)) continue;
    const subFile = join(subDir, `${sub}.json`);
    let subDoc;
    try {
      subDoc = loadJson(subFile);
    } catch {
      continue; // not a real subcategory directory
    }
    if (subDoc.extends !== catName) continue;
    const subUid = subDoc.uid;

    for (const file of readdirSync(subDir).sort()) {
      if (!file.endsWith('.json')) continue;
      const leafName = file.slice(0, -'.json'.length);
      if (leafName === sub) continue; // the subcategory's own definition, not a leaf
      const leafDoc = loadJson(join(subDir, file));
      if (leafDoc.extends !== sub) continue;
      leaves.push({
        id: catUid * 10000 + subUid * 100 + leafDoc.uid,
        path: `${catName}/${sub}/${leafName}`,
        caption: leafDoc.caption ?? '',
        description: leafDoc.description ?? '',
      });
    }
  }
}

leaves.sort((a, b) => a.id - b.id);
process.stdout.write(`${JSON.stringify(leaves, null, 2)}\n`);
process.stderr.write(`Generated ${leaves.length} real OASF skill leaves.\n`);
