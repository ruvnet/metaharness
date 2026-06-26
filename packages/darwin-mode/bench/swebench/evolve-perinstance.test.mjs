#!/usr/bin/env node
// Pure-function tests for evolve-perinstance.mjs (genome coercion, per-instance fitness keying,
// coverage-map construction, conformance-firewall labelling). No GCP / no spend.
// Run: node evolve-perinstance.test.mjs
import assert from 'node:assert';
import {
  PI_MODES, capabilityOf, pikey, seedGenomes, randomPIGenome, mutatePI, crossoverPI,
  buildInstLookup, fitnessOf, buildCoverage, heldOutPlan, vmName,
} from './evolve-perinstance.mjs';
import { mkRng, gkey, normalizeGenome } from './evolve-config.mjs';

let pass = 0; const t = (name, fn) => { try { fn(); pass++; console.log(`  ok  ${name}`); } catch (e) { console.error(`  FAIL ${name}: ${e.message}`); process.exitCode = 1; } };

console.log('evolve-perinstance.mjs unit tests:');

t('all evolved genomes stay within the per-instance capability mode set (3000 samples)', () => {
  const rng = mkRng(7);
  for (let i = 0; i < 3000; i++) {
    const a = randomPIGenome(rng), b = randomPIGenome(rng);
    for (const g of [a, b, mutatePI(rng, a), crossoverPI(rng, a, b)]) {
      assert(PI_MODES.includes(g.mode), `mode ${g.mode} must be a per-instance lever (got ${gkey(g)})`);
    }
  }
});

t('seed genomes cover the GENERAL capability levers (firewall: no instance-specific hacks)', () => {
  const caps = new Set(seedGenomes().map(capabilityOf));
  assert(caps.has('cheap-single'), 'cheap baseline');
  assert(caps.has('frontier-single'), 'frontier baseline');
  assert(caps.has('best-of-N-width'), 'BoN width');
  assert(caps.has('cheap→frontier-escalation'), 'escalation lever');
  assert(caps.has('cross-model-best-of-N'), 'cross-model BoN');
  // every seed genome must be expressible as a general capability (no per-instance identity)
  for (const g of seedGenomes()) assert(typeof capabilityOf(g) === 'string' && capabilityOf(g).length > 0);
});

t('pikey is instance-scoped and genome-stable', () => {
  const g = seedGenomes()[0];
  assert.equal(pikey('django__django-11564', g), `django__django-11564::${gkey(g)}`);
  assert.notEqual(pikey('django__django-11564', g), pikey('sympy__sympy-11870', g), 'different instances differ');
});

t('buildInstLookup reads darwin_inst_runs shape, MAX over repeats, fit = resolved_k/ksamp', () => {
  const runs = [
    { instance_id: 'a', gkey: 'xbo|opus+glm|s15', mode: 'xbo', resolved_k: 1, ksamp: 2, capability: 'cross-model-best-of-N' },
    { instance_id: 'a', gkey: 'xbo|opus+glm|s15', mode: 'xbo', resolved_k: 2, ksamp: 2, capability: 'cross-model-best-of-N' }, // better repeat dominates
    { instance_id: 'a', gkey: 'single|glm-5.2|s15', mode: 'single', resolved_k: 0, ksamp: 2, capability: 'cheap-single' },
    { instance_id: 'b', gkey: 'single|claude-opus-4.8|s15', mode: 'single', resolved_k: 0, ksamp: 3, capability: 'frontier-single' },
  ];
  const L = buildInstLookup(runs);
  assert.equal(L['a::xbo|opus+glm|s15'].fit, 1, 'MAX over repeats → 2/2');
  assert.equal(L['a::single|glm-5.2|s15'].fit, 0);
  assert.equal(L['b::single|claude-opus-4.8|s15'].resolved_k, 0);
});

t('fitnessOf returns resolved_k/ksamp for a measured (instance,genome), null otherwise', () => {
  const g = seedGenomes()[0]; // cheap single glm
  const L = buildInstLookup([{ instance_id: 'x', gkey: gkey(g), mode: g.mode, resolved_k: 1, ksamp: 2, capability: 'cheap-single' }]);
  assert.equal(fitnessOf('x', g, L), 0.5);
  assert.equal(fitnessOf('y', g, L), null, 'unmeasured instance → null (must dispatch real probe, never mock)');
});

t('buildCoverage marks cracked/robust/uncracked + tallies generalizable capabilities', () => {
  const runs = [
    // instance A: cracked robustly by xbo (2/2)
    { instance_id: 'A', gkey: 'xbo|opus+glm|s15', mode: 'xbo', model: 'xbo:...', resolved_k: 2, ksamp: 2, capability: 'cross-model-best-of-N' },
    { instance_id: 'A', gkey: 'single|glm-5.2|s15', mode: 'single', model: 'glm', resolved_k: 0, ksamp: 2, capability: 'cheap-single' },
    // instance B: cracked weakly (1/2 — lucky, not robust) by bo3
    { instance_id: 'B', gkey: 'bo3|claude-opus-4.8|s15', mode: 'bo3', model: 'opus', resolved_k: 1, ksamp: 2, capability: 'best-of-N-width' },
    // instance C: probed, never cracked (genuine ceiling / underspecified)
    { instance_id: 'C', gkey: 'single|claude-opus-4.8|s15', mode: 'single', model: 'opus', resolved_k: 0, ksamp: 2, capability: 'frontier-single' },
  ];
  const cov = buildCoverage(runs, ['A', 'B', 'C', 'D']); // D never probed
  assert.equal(cov.total, 4);
  assert.equal(cov.probed, 3, 'D unprobed');
  assert.equal(cov.cracked, 2, 'A and B cracked (>=1 sample)');
  assert.equal(cov.robustCracked, 1, 'only A is robust (majority of samples)');
  assert.equal(cov.uncracked, 2, 'C and D uncracked');
  assert.deepEqual(cov.uncrackedInstances.sort(), ['C', 'D']);
  assert.equal(cov.capabilityTally['cross-model-best-of-N'], 1);
  assert.equal(cov.capabilityTally['best-of-N-width'], 1);
  const rowA = cov.rows.find((r) => r.instance_id === 'A');
  assert.equal(rowA.bestCapability, 'cross-model-best-of-N');
  assert.equal(rowA.bestRate, '2/2');
});

t('vmName is GCP-safe (<=62 chars, ends alphanumeric) and collision-free across distinct genomes', () => {
  const ids = ['django__django-11564', 'sympy__sympy-13915', 'sphinx-doc__sphinx-8474'];
  const gs = [
    normalizeGenome({ mode: 'single', baseModel: 'anthropic/claude-opus-4.8', maxSteps: 15 }),
    normalizeGenome({ mode: 'single', baseModel: 'anthropic/claude-opus-4.8', maxSteps: 20 }), // differs only in steps tail
    normalizeGenome({ mode: 'single', baseModel: 'z-ai/glm-5.2', maxSteps: 15 }),
    normalizeGenome({ mode: 'bo3', baseModel: 'anthropic/claude-opus-4.8', maxSteps: 15 }),
    normalizeGenome({ mode: 'xbo', xmodels: ['anthropic/claude-opus-4.8', 'z-ai/glm-5.2'], maxSteps: 15 }),
    normalizeGenome({ mode: 'cascade', baseModel: 'z-ai/glm-5.2', escalateModel: 'anthropic/claude-opus-4.8', maxSteps: 15 }),
  ];
  const names = new Set();
  for (const id of ids) for (const g of gs) {
    const n = vmName(id, g);
    assert(n.length <= 62, `name too long (${n.length}): ${n}`);
    assert(/[a-z0-9]$/.test(n), `name must end alphanumeric: ${n}`);
    assert(/^[a-z]/.test(n), `name must start with a letter: ${n}`);
    assert(!names.has(n), `COLLISION: ${n} (s15 vs s20 must NOT collide)`);
    names.add(n);
  }
  assert.equal(names.size, ids.length * gs.length, 'every distinct (instance,genome) → distinct VM name');
});

t('heldOutPlan asserts conformance + NO per-instance tuning (firewall)', () => {
  const plan = heldOutPlan({ capabilityTally: { 'cross-model-best-of-N': 5, 'best-of-N-width': 3 } });
  assert(/NON-gold|never a gold|NEVER a gold/i.test(plan.step1_assembleOneHarness), 'router must not use gold');
  assert(/no per-instance config|per-instance/i.test(plan.step2_runHeldOut.toLowerCase()) || /No per-instance/.test(plan.step2_runHeldOut));
  assert(/usedOracleDuringSolve/.test(plan.conformanceCheck), 'leakage guard referenced');
});

console.log(`\n${pass} tests passed.`);
