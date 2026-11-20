import { freezeSpec, validateProposal, digest } from './index.mjs';

// Uses the real MetaHarness numeric mutator; importing never starts an evaluator.
export async function proposeDarwin(input, seed=0, generation=1, runtime=null) {
  const {spec:s}=freezeSpec(input);
  if(!Number.isSafeInteger(seed) || !Number.isSafeInteger(generation) || generation<1 || generation>s.rounds) throw new Error('invalid_generation');
  const {mutateGenome}=runtime ?? await import('@metaharness/darwin');
  const k=s.knob;
  const space={[k.name]:{min:Math.max(k.min,s.incumbent-k.step),max:Math.min(k.max,s.incumbent+k.step),type:'float',scale:'linear',default:s.incumbent}};
  const raw=mutateGenome({[k.name]:s.incumbent},space,seed,generation,0,.5);
  const direction=Math.sign(raw.genome[k.name]-s.incumbent);
  if(!direction) return {status:'REJECTED',reason:'darwin_no_mutation'};
  const proposal=validateProposal(s,{parameter:k.name,value:s.incumbent+direction*k.step});
  return {status:'PROPOSED',engine:'@metaharness/darwin',rawGenomeHash:digest(raw),seed,generation,proposal,promote:false};
}
