#!/usr/bin/env node
// Pure-function tests for evolve-config.mjs (genome operators, fitness keying, dispatch mapping).
// No GCP / no spend. Run: node evolve-config.test.mjs
import assert from 'node:assert';
import {
  mkRng, randomGenome, mutate, crossover, gkey, readbackKey, fsModelString,
  canonModelString, buildHardLookup, fitnessOf, seedPopulation, costPrior,
  CHEAP_MODELS, FRONTIER_MODELS, ESCALATE_MODELS, MODES,
} from './evolve-config.mjs';

let pass = 0; const t = (name, fn) => { try { fn(); pass++; console.log(`  ok  ${name}`); } catch (e) { console.error(`  FAIL ${name}: ${e.message}`); process.exitCode = 1; } };

console.log('evolve-config.mjs unit tests:');

t('random genomes are always valid (2000 samples)', () => {
  const rng = mkRng(11);
  for (let i = 0; i < 2000; i++) {
    const g = randomGenome(rng);
    assert(MODES.includes(g.mode));
    if (g.mode === 'xbo' || g.mode === 'xcascade') { assert(g.xmodels.length >= 2, 'xbo needs ≥2 models'); assert(new Set(g.xmodels).size === g.xmodels.length, 'xmodels distinct'); }
    else assert(g.baseModel, 'non-x mode needs baseModel');
    if (['cascade', 'ecascade', 'xcascade'].includes(g.mode)) assert(g.escalateModel, 'cascade-family needs escalate');
    else assert(g.escalateModel == null, 'non-cascade has no escalate');
  }
});

t('no degenerate cascade-family genomes (frontier base / base==escalate)', () => {
  const rng = mkRng(3);
  for (let i = 0; i < 3000; i++) {
    const a = randomGenome(rng), b = randomGenome(rng);
    for (const g of [a, mutate(rng, a), crossover(rng, a, b)]) {
      if (g.mode === 'cascade' || g.mode === 'ecascade') assert(!FRONTIER_MODELS.includes(g.baseModel), `cascade base must be cheap: ${gkey(g)}`);
      if (g.escalateModel && g.baseModel) assert(g.baseModel !== g.escalateModel, `base != escalate: ${gkey(g)}`);
      if (g.xmodels && g.escalateModel) assert(!g.xmodels.includes(g.escalateModel), `escalate not in xmodels: ${gkey(g)}`);
    }
  }
});

t('fsModelString matches runner self-report format', () => {
  assert.equal(fsModelString({ mode: 'ecascade', baseModel: 'z-ai/glm-5.2', escalateModel: 'anthropic/claude-opus-4.8' }), 'ecascade:z-ai/glm-5.2>anthropic/claude-opus-4.8');
  assert.equal(fsModelString({ mode: 'xbo', xmodels: ['anthropic/claude-opus-4.8', 'z-ai/glm-5.2'] }), 'xbo:anthropic/claude-opus-4.8,z-ai/glm-5.2');
  assert.equal(fsModelString({ mode: 'xcascade', xmodels: ['deepseek/deepseek-v3.2', 'z-ai/glm-5.2'], escalateModel: 'anthropic/claude-opus-4.8' }), 'xcascade:deepseek/deepseek-v3.2,z-ai/glm-5.2>anthropic/claude-opus-4.8');
  assert.equal(fsModelString({ mode: 'single', baseModel: 'z-ai/glm-5.2' }), 'z-ai/glm-5.2');
});

t('readbackKey is set-order independent and matches canonModelString', () => {
  // a genome's readbackKey must equal the canon key of its own fsModelString
  const gs = [
    { mode: 'ecascade', baseModel: 'z-ai/glm-5.2', escalateModel: 'anthropic/claude-opus-4.8' },
    { mode: 'xbo', xmodels: ['z-ai/glm-5.2', 'anthropic/claude-opus-4.8'] },          // reversed order
    { mode: 'xcascade', xmodels: ['z-ai/glm-5.2', 'deepseek/deepseek-v3.2'], escalateModel: 'anthropic/claude-opus-4.8' },
    { mode: 'single', baseModel: 'z-ai/glm-5.2' },
    { mode: 'bo3', baseModel: 'deepseek/deepseek-v4-flash' },
    { mode: 'cascade', baseModel: 'deepseek/deepseek-v4-flash', escalateModel: 'anthropic/claude-opus-4.8' },
  ];
  for (const g of gs) assert.equal(readbackKey(g), canonModelString(fsModelString(g), g.mode), `roundtrip ${gkey(g)}`);
});

t('buildHardLookup reads the real corpus shape (total==25 only, MAX over repeats)', () => {
  const fakeRuns = [
    { model: 'ecascade:z-ai/glm-5.2>anthropic/claude-opus-4.8', mode: 'ecascade', resolved: 16, total: 25 },
    { model: 'ecascade:z-ai/glm-5.2>anthropic/claude-opus-4.8', mode: 'ecascade', resolved: 1, total: 25 },  // degenerate — must be dominated
    { model: 'xbo:anthropic/claude-opus-4.8,z-ai/glm-5.2', mode: 'xbo', resolved: 18, total: 25 },
    { model: 'z-ai/glm-5.2', mode: 'single', resolved: 111, total: 300 },                                    // n=300 — must be IGNORED
  ];
  const L = buildHardLookup(fakeRuns);
  assert.equal(L['ecascade|glm-5.2>claude-opus-4.8'], 16, 'MAX over repeats');
  assert.equal(L['xbo|claude-opus-4.8+glm-5.2'], 18);
  assert.equal(L['single|glm-5.2'], undefined, 'n=300 doc excluded from hard-25 lookup');
});

t('fitnessOf returns resolved/25 for a measured genome, null otherwise', () => {
  const L = { 'xbo|claude-opus-4.8+glm-5.2': 18 };
  assert.equal(fitnessOf({ mode: 'xbo', xmodels: ['anthropic/claude-opus-4.8', 'z-ai/glm-5.2'] }, L), 18 / 25);
  assert.equal(fitnessOf({ mode: 'xbo', xmodels: ['z-ai/glm-5.2', 'anthropic/claude-opus-4.8'] }, L), 18 / 25, 'order independent');
  assert.equal(fitnessOf({ mode: 'single', baseModel: 'z-ai/glm-5.2' }, L), null);
});

t('seed population includes the known anchors', () => {
  const labels = seedPopulation().map(gkey);
  assert(labels.some((l) => l.startsWith('ecascade|glm-5.2>claude-opus-4.8')), 'GLM→Opus ecascade');
  assert(labels.some((l) => l.startsWith('xbo|claude-opus-4.8+glm-5.2')), 'opus+glm xbo');
  assert(labels.some((l) => l.startsWith('single|claude-opus-4.8')), 'full Opus');
});

t('costPrior orders cheap < frontier', () => {
  const cheap = costPrior({ mode: 'single', baseModel: 'z-ai/glm-5.2', maxSteps: 15 });
  const front = costPrior({ mode: 'xbo', xmodels: ['anthropic/claude-opus-4.8', 'openai/gpt-5.5'], maxSteps: 15 });
  assert(cheap < front, `cheap ${cheap} < frontier ${front}`);
});

console.log(`\n${pass} tests passed.`);
