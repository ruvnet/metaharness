import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { run } from '../examples/hf_e2e.mjs';

test('full local evaluation follows a validated proposal and repeat spends no calls',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'hf-e2e-'));
  let calls=0;
  const fetchImpl=async(url,options)=>{
    calls++;
    const body=JSON.parse(options.body);
    assert(!options.body.includes('10007'));
    assert(!options.body.includes('confirmation'));
    assert.equal(body.model,'openai/gpt-oss-120b:groq');
    assert.match(body.messages[0].content,/JSON/);
    return {ok:true,text:async()=>JSON.stringify({usage:{prompt_tokens:100,completion_tokens:20,total_tokens:120},
      choices:[{finish_reason:'stop',message:{content:'{"parameter":"cost_width","value":3}'}}]})};
  };
  const first=await run(directory,{token:'fixture-only',fetchImpl});
  assert.equal(first.status,'E2E_COMPLETE');
  assert.equal(first.evaluation.trajectoryCount,12000);
  assert.equal(first.networkRequestsThisInvocation,1);
  const second=await run(directory,{token:'fixture-only',fetchImpl});
  assert.equal(second.networkRequestsThisInvocation,0);
  assert.equal(second.evaluation.reused,true);
  assert.equal(calls,1);
  assert.equal(second.promote,false);
  assert(!(await readFile(join(directory,'frozen.json'),'utf8')).includes('fixture-only'));
});

test('HTTP status is retained without retaining response text',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'hf-e2e-error-'));
  let calls=0;
  const r=await run(directory,{token:'fixture-only',fetchImpl:async()=>{
    calls++; return {ok:false,status:400,text:async()=>{throw Error('must_not_read_body');}};
  }});
  assert.equal(calls,1);
  assert.equal(r.proposal.reason,'provider_http_400');
  assert.equal(r.evaluation,null);
  assert.equal(r.receiptReuseVerified,true);
});
