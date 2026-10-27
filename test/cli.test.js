import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, cp, symlink, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const source = fileURLToPath(new URL('..', import.meta.url));
const preload = String.raw`
import { existsSync, readFileSync, writeFileSync, appendFileSync } from 'node:fs';
const store = process.env.PROBE_STORE;
const questions = existsSync(store) ? JSON.parse(readFileSync(store, 'utf8')) : [];
const save = () => writeFileSync(store, JSON.stringify(questions));
globalThis.fetch = async (raw, init) => {
  if (process.env.PROBE_OFFLINE === 'yes') throw new Error('Unexpected network operation');
  const url = new URL(raw), path = url.pathname;
  if (url.origin !== 'https://api.pingroom.io') throw new Error('Unexpected mock origin');
  appendFileSync(process.env.PROBE_LOG, JSON.stringify({method:init.method,path}) + '\n');
  const participant = '11111111-1111-4111-8111-111111111111';
  if (init.method === 'GET' && path === '/api/agent/rooms') return Response.json([
    {invite_code:'DEMO12345678',type:'standard',is_public:false,members:[{user_id:participant}]}
  ]);
  if (init.method === 'POST' && path === '/api/agent/rooms/DEMO12345678/questions') {
    const body = JSON.parse(init.body), now = new Date().toISOString();
    const question = {id:'01990000-0000-7000-8000-' + String(questions.length+1).padStart(12,'0'),
      kind:'question',is_handoff:false,prompt:body.prompt,context:body.context,
      options:body.options.map(({value,label})=>({value,label,primary:false,destructive:false})),
      text_input:null,responder_scope:'direct',target_user_id:participant,resolution_policy:'first',
      state:'pending',results:null,answer:null,expires_at:new Date(Date.parse(now)+900000).toISOString(),
      resolved_at:null,correlation_id:body.correlation_id,reply_to:null,data:body.data,created_at:now,
      room_code:'DEMO12345678',room:{code:'DEMO12345678'},asker:{type:'agent',id:'33333333-3333-4333-8333-333333333333'}};
    questions.push(question); save();
    if(process.env.PROBE_LOST === 'yes') throw new Error('Lost response after POST');
    return Response.json(question,{status:201});
  }
  if (init.method === 'GET' && path === '/api/agent/questions') return Response.json({questions});
  const q = questions.find(q=>path === '/api/agent/questions/' + q.id);
  if (init.method === 'GET' && q) {
    const value = process.env.PROBE_ANSWER;
    if (value && q.state === 'pending') {
      q.state='answered';q.resolved_at=new Date().toISOString();
      q.answer={value,label:q.options.find(o=>o.value===value).label,text:null,responder:{id:participant},answered_at:q.resolved_at};save();
    }
    return Response.json(q);
  }
  throw new Error('Unexpected mock request');
};
`;

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(),'repro-cli-'));
  t.after(()=>rm(directory,{recursive:true,force:true}));
  await cp(join(source,'src'),join(directory,'src'),{recursive:true});
  await cp(join(source,'package.json'),join(directory,'package.json'));
  await cp(join(source,'config.example.json'),join(directory,'config.json'));
  const input=JSON.parse(await readFile(join(source,'examples/case.json'),'utf8'));
  input.components=[{id:'cache',label:'Preview cache'}];
  await writeFile(join(directory,'case.json'),JSON.stringify(input));
  await symlink(join(source,'node_modules'),join(directory,'node_modules'));
  await writeFile(join(directory,'preload.mjs'),preload);
  return directory;
}
function cli(directory,command='run',{answer='',lost=false,offline=false,argument}={}) {
  const env={...process.env,PINGROOM_TOKEN:'offline-fixture-token',PINGROOM_ROOM:'DEMO12345678',
    PROBE_STORE:join(directory,'questions.json'),PROBE_LOG:join(directory,'requests.jsonl'),
    PROBE_ANSWER:answer,PROBE_LOST:lost?'yes':'no',PROBE_OFFLINE:offline?'yes':'no'};
  delete env.NODE_OPTIONS;
  return new Promise((resolve,reject)=>{
    const child=spawn(process.execPath,['--import',join(directory,'preload.mjs'),join(directory,'src/cli.js'),command,...(argument?[argument]:[])],{cwd:directory,env,stdio:['ignore','pipe','pipe']});
    let stdout='',stderr='';
    child.stdout.on('data',x=>{stdout+=x;});child.stderr.on('data',x=>{stderr+=x;});
    const timer=setTimeout(()=>child.kill('SIGKILL'),8000);
    child.once('error',error=>{clearTimeout(timer);reject(error);});
    child.once('close',(code,signal)=>{clearTimeout(timer);resolve({code,signal,stdout,stderr,json:stdout.trim().startsWith('{')?JSON.parse(stdout):null});});
  });
}
const requests=async directory=>(await readFile(join(directory,'requests.jsonl'),'utf8')).trim().split('\n').map(JSON.parse);
const posts=async directory=>(await requests(directory)).filter(c=>c.method==='POST').length;

async function expect(directory,command,options,code,status) {
  const result=await cli(directory,command,options);
  assert.equal(result.code,code,result.stderr||result.stdout);assert.equal(result.json.status,status);return result.json;
}

test('CLI exposes the plan, creates only on explicit runs, and exports completed evidence offline',async t=>{
  const directory=await fixture(t);
  const plan=await expect(directory,'plan',{offline:true},0,'not_started');
  assert.equal(plan.nextTest.kind,'full');assert.ok(plan.instructions);
  await expect(directory,'run',{},3,'pending');
  const ready=await expect(directory,'run',{answer:'present'},3,'ready');
  assert.deepEqual(ready.nextTest.componentIds,[]);assert.equal(await posts(directory),1);
  await expect(directory,'run',{},3,'pending');
  const done=await expect(directory,'run',{answer:'absent'},0,'complete');
  assert.deepEqual(done.result.componentIds,['cache']);assert.equal(done.result.oneMinimal,true);
  assert.equal(done.result.globallyMinimum,false);assert.equal(await posts(directory),2);
  await expect(directory,'run',{offline:true},0,'complete');
  const saved=await expect(directory,'report',{offline:true},0,'complete');
  assert.deepEqual(JSON.parse(await readFile(join(directory,'.repro/report.json'),'utf8')),saved);
});

test('CLI stops on Unknown or an absent full configuration and cannot create replacement tests',async t=>{
  for(const [answer,status]of[['unknown','inconclusive'],['absent','not_reproduced']]){
    const directory=await fixture(t);await expect(directory,'run',{},3,'pending');
    const report=await expect(directory,'run',{answer},2,status);assert.equal(report.result,null);
    await expect(directory,'run',{offline:true},2,status);assert.equal(await posts(directory),1);
    await expect(directory,'status',{offline:true},0,status);
  }
});

test('CLI recovers an uncertain POST through the exact original Question without duplicate creation',async t=>{
  const directory=await fixture(t);
  await expect(directory,'run',{lost:true},4,'create_unknown');
  await expect(directory,'run',{offline:true},4,'create_unknown');assert.equal(await posts(directory),1);
  const found=await expect(directory,'find',{},4,'create_unknown');assert.equal(found.candidates.length,1);
  const qid=found.candidates[0].id;
  const recovered=await expect(directory,'recover',{argument:qid,answer:'present'},3,'ready');
  assert.equal(recovered.tests[0].questionId,qid);assert.equal(await posts(directory),1);
  await expect(directory,'run',{},3,'pending');
  await expect(directory,'run',{answer:'absent'},0,'complete');assert.equal(await posts(directory),2);
});

test('CLI rejects invalid arguments and changed input before any new request',async t=>{
  const directory=await fixture(t);
  assert.equal((await cli(directory,'recover',{argument:'not-a-uuid',offline:true})).code,1);
  assert.equal((await cli(directory,'run',{argument:'extra',offline:true})).code,1);
  await expect(directory,'run',{},3,'pending');
  const input=JSON.parse(await readFile(join(directory,'case.json'),'utf8'));input.buildRef='changed-build';
  await writeFile(join(directory,'case.json'),JSON.stringify(input));
  const before=(await requests(directory)).length;
  assert.equal((await cli(directory,'run',{})).code,1);assert.equal((await requests(directory)).length,before);
});
