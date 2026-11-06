import { createHash } from 'node:crypto';
import { mkdir, open, readFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';
export * from './providers.mjs';

export function canonical(x) {
  if (x === null || typeof x === 'boolean' || typeof x === 'string') return JSON.stringify(x);
  if (typeof x === 'number' && Number.isFinite(x)) return JSON.stringify(x);
  if (Array.isArray(x)) return `[${x.map(canonical).join(',')}]`;
  if (x && Object.getPrototypeOf(x) === Object.prototype)
    return `{${Object.keys(x).sort().map(k => `${JSON.stringify(k)}:${canonical(x[k])}`).join(',')}}`;
  throw new Error('non_json_value');
}
export const digest = x => createHash('sha256').update(canonical(x)).digest('hex');
const assert = (ok, message) => { if (!ok) throw new Error(message); };
const hex = x => typeof x === 'string' && /^[a-f0-9]{64}$/.test(x);
const id = x => typeof x === 'string' && /^[a-zA-Z0-9_./:-]{1,160}$/.test(x);
const positive = x => Number.isFinite(x) && x > 0;
const distinct = a => Array.isArray(a) && a.length > 0 && a.every(id) && new Set(a).size === a.length;

export function freezeSpec(input) {
  const s = JSON.parse(canonical(input));
  assert(s.version === 1 && id(s.id), 'invalid_spec');
  const allowed = ['version','id','sourceHash','verifierHash','trainerHash','settingsHash','model','modelRevision','dataScope','rounds','trainingFamilies','confirmationFamilies','discoverySeeds','confirmationSeeds','cells','attempts','budget','knob','incumbent','minimumTransferGain'];
  assert(Object.keys(s).every(k=>allowed.includes(k)), 'unknown_spec_field');
  for (const k of ['sourceHash', 'verifierHash', 'trainerHash', 'settingsHash']) assert(hex(s[k]), `invalid_${k}`);
  assert(id(s.model) && /^[a-f0-9]{40}$/.test(s.modelRevision), 'pin_model_revision');
  assert(['synthetic', 'public'].includes(s.dataScope), 'unsupported_data_scope');
  assert(Number.isInteger(s.rounds) && s.rounds >= 1 && s.rounds <= 3, 'invalid_rounds');
  assert(distinct(s.trainingFamilies) && distinct(s.confirmationFamilies), 'invalid_families');
  assert(!s.trainingFamilies.some(x => s.confirmationFamilies.includes(x)), 'family_overlap');
  assert(distinct(s.discoverySeeds) && distinct(s.confirmationSeeds), 'invalid_seeds');
  assert(!s.discoverySeeds.some(x => s.confirmationSeeds.includes(x)), 'seed_overlap');
  assert(distinct(s.cells), 'invalid_cells');
  assert(Number.isInteger(s.attempts) && s.attempts >= 4, 'invalid_attempts');
  assert(s.budget && Number.isInteger(s.budget.maxCalls) && s.budget.maxCalls > 0, 'invalid_calls');
  for (const k of ['maxTokens','maxSeconds']) assert(Number.isSafeInteger(s.budget[k]) && s.budget[k] > 0, `invalid_${k}`);
  assert(positive(s.budget.maxUsd), 'invalid_cost_ceiling');
  assert(s.knob && id(s.knob.name) && positive(s.knob.step) && Number.isFinite(s.knob.min) && Number.isFinite(s.knob.max) && s.knob.max > s.knob.min, 'invalid_knob');
  assert(Number.isFinite(s.incumbent) && s.incumbent >= s.knob.min && s.incumbent <= s.knob.max, 'invalid_incumbent');
  assert(Number.isFinite(s.minimumTransferGain) && s.minimumTransferGain > 0 && s.minimumTransferGain <= 1, 'invalid_transfer_gate');
  return { spec: s, specHash: digest(s) };
}

export function validateProposal(s, p) {
  assert(p && Object.keys(p).sort().join(',') === 'parameter,value', 'proposal_fields');
  assert(p.parameter === s.knob.name && Number.isFinite(p.value), 'proposal_parameter');
  assert(p.value >= s.knob.min && p.value <= s.knob.max && p.value !== s.incumbent, 'proposal_bounds');
  assert(Math.abs(Math.abs(p.value - s.incumbent) - s.knob.step) < 1e-9, 'proposal_one_step');
  return { parameter: p.parameter, value: p.value };
}

// This is a deterministic diagnostic, never promotion authority. The denominator is frozen.
export function mixedFitness(s, episodes) {
  const expected = new Set(s.cells.flatMap(cell => Array.from({length:s.attempts}, (_, attempt) => `${cell}:${attempt}`)));
  const seen = new Set(); const buckets = new Map(s.cells.map(c => [c, []]));
  for (const e of episodes) {
    const key = `${e.cell}:${e.attempt}`;
    assert(expected.has(key) && !seen.has(key), 'unexpected_or_duplicate_episode');
    seen.add(key); buckets.get(e.cell).push(e);
  }
  let mixed = 0; const excluded = [];
  for (const [cell, es] of buckets) {
    if (es.length !== s.attempts || es.some(e => e.status !== 'complete' || !hex(e.trajectoryHash) || typeof e.success !== 'boolean')) {
      excluded.push(cell); continue;
    }
    const count = es.filter(e => e.success).length;
    if (count > 0 && count < s.attempts) mixed++;
  }
  return {mixed, denominator:s.cells.length, fitness:mixed / s.cells.length, excluded};
}

export function reviewComparison(s, evidence) {
  const reasons = [];
  if (evidence.specHash !== digest(s)) reasons.push('spec_mismatch');
  if (evidence.sourceHash !== s.sourceHash || evidence.verifierHash !== s.verifierHash || evidence.trainerHash !== s.trainerHash || evidence.settingsHash !== s.settingsHash || evidence.modelRevision !== s.modelRevision) reasons.push('provenance_mismatch');
  if (evidence.effectiveSettingsVerified !== true) reasons.push('effective_settings_unknown');
  if (evidence.provenance !== 'real_model') reasons.push('not_real_model');
  if (!hex(evidence.baselineCheckpoint) || !hex(evidence.candidateCheckpoint) || evidence.baselineCheckpoint === evidence.candidateCheckpoint) reasons.push('checkpoint_evidence_missing');
  for (const phase of ['discovery','confirmation']) {
    try {
      const expectedSeeds=phase==='discovery' ? s.discoverySeeds : s.confirmationSeeds;
      assert(canonical(evidence[phase].seeds)===canonical(expectedSeeds), 'phase_seed_mismatch');
      const a=mixedFitness(s,evidence[phase].incumbent), b=mixedFitness(s,evidence[phase].candidate);
      if (b.mixed <= a.mixed) reasons.push(`${phase}_no_strict_gain`);
      if (a.excluded.length || b.excluded.length) reasons.push(`${phase}_incomplete`);
    } catch { reasons.push(`${phase}_invalid`); }
  }
  // Transfer rows are paired, one per frozen family/seed; no denominator shrinkage.
  const wanted = new Set(s.confirmationFamilies.flatMap(f => s.confirmationSeeds.map(seed => `${f}:${seed}`)));
  const seen = new Set(); let delta = 0;
  for (const r of evidence.transfer ?? []) {
    const key = `${r.family}:${r.seed}`;
    if (!wanted.has(key) || seen.has(key) || r.status !== 'complete' || typeof r.baseline !== 'boolean' || typeof r.candidate !== 'boolean' || !hex(r.baselineTrajectory) || !hex(r.candidateTrajectory)) reasons.push('invalid_transfer');
    else { seen.add(key); delta += Number(r.candidate) - Number(r.baseline); }
  }
  if (seen.size !== wanted.size) reasons.push('missing_transfer');
  if (delta / wanted.size < s.minimumTransferGain) reasons.push('insufficient_transfer_gain');
  for (const family of s.confirmationFamilies) {
    const rows=(evidence.transfer ?? []).filter(r=>r.family===family);
    if (rows.reduce((n,r)=>n+Number(r.candidate)-Number(r.baseline),0)<0) reasons.push('family_regression');
  }
  if (evidence.accountingVerified !== true || !Number.isFinite(evidence.actualUsd) || evidence.actualUsd < 0 || evidence.actualUsd > s.budget.maxUsd) reasons.push('cost_unverified_or_exceeded');
  if (evidence.independentReviewVerified !== true) reasons.push('independent_review_required');
  return {verdict: reasons.length ? 'HOLD' : 'READY_FOR_INDEPENDENT_REVIEW', reasons:[...new Set(reasons)], promote:false, signed:false};
}

async function writeExclusive(path, value) {
  const f = await open(path,'wx',0o600);
  try { await f.writeFile(canonical(value)+'\n'); await f.sync(); } finally { await f.close(); }
}

// Caller owns directory and adapters. Candidate-controlled code must never share this process.
// One call at most: crash/timeout leaves intent and requires explicit human reconciliation.
export async function once(directory, identity, operation) {
  await mkdir(directory,{recursive:true,mode:0o700});
  const key=digest(identity), receiptPath=join(directory,`${key}.json`), lockPath=join(directory,`${key}.lock`);
  // A completed immutable receipt is authoritative even after a process died
  // between committing it and removing its lock. Never re-execute to recover.
  try {
    const saved=JSON.parse(await readFile(receiptPath,'utf8'));
    assert(saved.key===key && saved.receiptHash===digest(saved.receipt), 'receipt_corrupt');
    return {...saved.receipt,reused:true};
  } catch(e) { if(e.code!=='ENOENT') throw e; }
  let lock;
  try { lock=await open(lockPath,'wx',0o600); } catch { throw new Error('operation_locked'); }
  try {
    try {
      const saved=JSON.parse(await readFile(receiptPath,'utf8'));
      assert(saved.key===key && saved.receiptHash===digest(saved.receipt), 'receipt_corrupt');
      return {...saved.receipt,reused:true};
    } catch(e) { if(e.code!=='ENOENT') throw e; }
    await writeExclusive(join(directory,`${key}.intent.json`),{key,identity,createdAt:new Date().toISOString()});
    let receipt;
    try { receipt=await operation(); }
    catch(e) { receipt={status:'INCONCLUSIVE',reason:/^provider_http_[1-5][0-9]{2}$/.test(e?.message) ? e.message : 'operation_failed_or_uncertain',retry:false}; }
    await writeExclusive(receiptPath,{key,receipt,receiptHash:digest(receipt)});
    return {...receipt,reused:false};
  } finally { await lock.close(); await unlink(lockPath); }
}

export function trainingManifest(input, proposal, maxSeconds) {
  const {spec:s}=freezeSpec(input);
  const p=validateProposal(s,proposal);
  assert(Number.isSafeInteger(maxSeconds) && maxSeconds>0 && maxSeconds<=s.budget.maxSeconds,'invalid_training_timeout');
  // Confirmation families/seeds and evaluator details are deliberately absent.
  const manifest={trainerHash:s.trainerHash,maxSeconds,trainingSpec:{
    specHash:digest(s),sourceHash:s.sourceHash,model:s.model,modelRevision:s.modelRevision,
    settingsHash:s.settingsHash,families:s.trainingFamilies,seeds:s.discoverySeeds,
    mutation:p,dataScope:s.dataScope
  }};
  const bytes=canonical(manifest);
  return {manifest,bytes,manifestHash:createHash('sha256').update(bytes).digest('hex')};
}
