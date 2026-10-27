import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readJson } from './storage.js';
import { step } from './engine.js';
import { CONFIG, ROOM_CODE, mockApi } from './mock.js';

const input=await readJson(new URL('../examples/case.json',import.meta.url));
const scenarios=[
  {name:'interaction-dependent symptom',oracle:ids=>ids.includes('cache')&&ids.includes('compact')?'present':'absent',status:'complete'},
  {name:'untestable candidate',oracle:()=> 'unknown',status:'inconclusive'},
  {name:'full configuration does not reproduce',oracle:()=> 'absent',status:'not_reproduced'},
];
for(const scenario of scenarios) {
  const directory=await mkdtemp(join(tmpdir(),'pingroom-repro-demo-'));
  try {
    const now=()=> '2026-01-01T09:00:00.000Z',api=mockApi(now);
    const options={client:api.client,directory,input,config:CONFIG,token:'offline-fixture-token',room:ROOM_CODE,now};
    let result;
    for(let i=0;i<22;i++) {
      const pending=await step(options);assert.equal(pending.status,'pending');
      const candidate=pending.tests.at(-1);api.answer(candidate.questionId,scenario.oracle(candidate.candidate.componentIds));
      result=await step(options);if(result.status!=='ready')break;
    }
    assert.equal(result.status,scenario.status);
    if(result.status==='complete')assert.deepEqual(result.result.componentIds,['cache','compact']);
    const calls=api.calls.length;await step(options);assert.equal(api.calls.length,calls);
    console.log(JSON.stringify({scenario:scenario.name,...result},null,2));
  } finally {await rm(directory,{recursive:true,force:true});}
}
