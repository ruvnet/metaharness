#!/usr/bin/env node
import {readFile} from 'node:fs/promises';
import {freezeSpec, reviewComparison} from './index.mjs';
const [command,path,evidencePath]=process.argv.slice(2);
try {
  if(!['plan','review'].includes(command) || !path) throw new Error('usage');
  const frozen=freezeSpec(JSON.parse(await readFile(path,'utf8')));
  const result=command==='plan' ? {...frozen,execution:'NOT_STARTED',promote:false} : reviewComparison(frozen.spec,JSON.parse(await readFile(evidencePath,'utf8')));
  console.log(JSON.stringify(result,null,2));
} catch { console.error('Invalid input. Usage: metaharness-curriculum plan spec.json | review spec.json evidence.json'); process.exitCode=1; }
