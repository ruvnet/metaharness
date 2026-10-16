import assert from 'node:assert/strict';
import { confirmContrastive, pairedSignPValue } from '@metaharness/darwin/contrastive';
const baseline={components:[{id:'rules',scope:'invariant',content:{corrects:false}}]};
const candidate={components:[{id:'rules',scope:'invariant',content:{corrects:true}}]};
let calls=0;
const evaluatePair=async input=>{
 calls++;
 const i=Number(input.taskId.split(':')[1]);
 const passes=h=>i>=6||h.components[0].content.corrects;
 return {tenantId:input.tenantId,projectId:input.projectId,
 environmentDigest:input.environmentDigest,envelopeDigest:input.envelopeDigest,
 taskId:input.taskId,appliedBaselineDigest:input.baselineDigest,
 appliedCandidateDigest:input.candidateDigest,
 baselinePassed:passes(input.baseline),candidatePassed:passes(input.candidate),costUsd:0};
};
const options={tenantId:'release',projectId:'acceptance',environment:{version:1},
 envelope:{network:false,promotion:false},baseline,candidate,
 developmentTaskIds:['development:0'],confirmationTaskIds:Array.from({length:20},(_,i)=>'confirmation:'+i),
 policy:{minCases:20,minWins:5,maxRegressions:0,minGain:0.05,alpha:0.025},
 budget:{maxUsd:0,maxCalls:20,pairUsd:0,timeoutMs:1000},
 evaluator:{surfaceAware:true,evaluatePair}};
const result=await confirmContrastive(options);
assert.equal(calls,20);assert.equal(result.verdict,'confirmed');
assert.equal(result.stats.wins,6);assert.equal(result.stats.pValue,0.015625);
assert.equal(result.promotion,'not-authorized');
assert.equal(pairedSignPValue(5,0),0.03125);
const invalid=await confirmContrastive({...options,evaluator:{surfaceAware:true,
 evaluatePair:async input=>({...await evaluatePair(input),envelopeDigest:'wrong'})}});
assert.equal(invalid.verdict,'inconclusive');assert.equal(invalid.stats.cases,0);
console.log(JSON.stringify({installedApi:'passed',cases:20,pValue:result.stats.pValue,
 provenanceMismatch:'rejected',promotion:result.promotion}));
