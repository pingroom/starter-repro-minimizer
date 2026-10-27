import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile, stat, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { step, localReport } from '../src/engine.js';
import { readJson, atomicJson, acquireLock } from '../src/storage.js';
import { validateInput, validateState, reconstruct, maxQuestions, requestFor, validateConfig, hash, iso } from '../src/model.js';
import { loadConnection, loadEnvironment } from '../src/config.js';
import { makeClient } from '../src/client.js';
import { mockApi, CONFIG, ROOM_CODE, OTHER, ASKER, id } from '../src/mock.js';

const example = await readJson(new URL('../examples/case.json', import.meta.url), 16384);
const simple = () => ({ ...structuredClone(example), components: [structuredClone(example.components[0])] });
const twoItems = () => ({ ...structuredClone(example), components: structuredClone(example.components.slice(0,2)) });
async function setup(t, input = simple()) {
  const directory = await mkdtemp(join(tmpdir(), 'pingroom-repro-minimizer-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const clock = { value: '2026-01-01T09:00:00.000Z' }, now = () => clock.value;
  const api = mockApi(now);
  const options = { client: api.client, directory, input, config: structuredClone(CONFIG), token: 'offline-fixture-token', room: ROOM_CODE, now };
  return { directory, clock, api, options, run: (extra = {}) => step({ ...options, ...extra }), saved: () => readJson(join(directory, 'state.json')) };
}
const sends = (api) => api.calls.filter((call) => call.method === 'POST').length;
async function decide(s, decisions) {
  let result;
  for (const value of decisions) {
    result = await s.run();
    const pending = result.tests.find(item => item.status === 'pending');
    s.api.answer(pending.questionId, value); result = await s.run();
  }
  return result;
}

test('lost response blocks later tests; exact-ID recovery reads the original request without resend', async (t) => {
  const s = await setup(t, twoItems()); s.api.controls.loseNext = true;
  assert.equal((await s.run()).status, 'create_unknown'); assert.equal((await s.run()).status, 'create_unknown');
  assert.deepEqual((await s.run({ command: 'find' })).candidates, [{ id: id(1), state: 'pending' }]);
  s.api.answer(id(1), 'present'); assert.equal((await s.run({ command: 'recover', attachId: id(1) })).status, 'ready');
  assert.equal(sends(s.api), 1);
});

test('malformed create response and empty search never authorize a new POST', async (t) => {
  const s = await setup(t); s.api.controls.malformedNext = true; await assert.rejects(s.run());
  assert.equal((await s.saved()).attempts[0].status, 'creating'); s.api.questions.clear();
  assert.deepEqual((await s.run({ command: 'find' })).candidates, []);
  assert.equal((await s.run()).status, 'create_unknown'); assert.equal(sends(s.api), 1);
});

test('recovery validates exact target, room, request, options, data and non-handoff provenance', async (t) => {
  for (const mutate of [
    (q) => { q.target_user_id = OTHER; }, (q) => { q.room.code = 'WRONG1234567'; }, (q) => { q.prompt = 'Other prompt'; },
    (q) => { q.options[0].primary = true; }, (q) => { q.options[0].destructive = true; }, (q) => { q.options.reverse(); },
    (q) => { q.data.candidate.componentIds = ['other']; }, (q) => { q.data.input_hash = 'changed'; }, (q) => { delete q.is_handoff; },
    (q) => { q.is_handoff = true; }, (q) => { q.asker.type = 'user'; }, (q) => { q.resolution_policy = 'all'; },
  ]) {
    const s = await setup(t); s.api.controls.loseNext = true; await s.run(); mutate(s.api.questions.get(id(1)));
    await assert.rejects(s.run({ command: 'recover', attachId: id(1) })); assert.equal((await s.saved()).attempts[0].status, 'creating');
    assert.equal(sends(s.api), 1);
  }
});

test('wrong, missing, typed or unsupported answers never resolve an test', async (t) => {
  for (const mutate of [
    (q) => { q.answer.responder.id = OTHER; }, (q) => { q.answer.responder = null; },
    (q) => { q.answer.text = 'present'; }, (q) => { q.answer.value = 'unsupported'; }, (q) => { q.answer.label = 'Wrong'; },
  ]) {
    const s = await setup(t); await s.run(); s.api.answer(id(1), 'present'); mutate(s.api.questions.get(id(1)));
    const result = await s.run(); assert.equal(result.observedStatus, 'invalid_answer'); assert.equal(result.result, null);
    await s.run(); assert.equal(sends(s.api), 1);
  }
});

test('original asker, lifetime and intent remain bound across reads and across tests', async (t) => {
  for (const mutate of [
    (q) => { q.asker.id = OTHER; },
    (q) => { q.created_at = '2026-01-01T09:00:01.000Z'; q.expires_at = '2026-01-01T09:15:01.000Z'; },
  ]) {
    const s = await setup(t); await s.run(); mutate(s.api.questions.get(id(1))); await assert.rejects(s.run(), /identity or lifetime/);
  }
  const s = await setup(t, twoItems()); await s.run(); s.api.answer(id(1), 'present'); await s.run();
  s.api.controls.loseNext = true; await s.run(); s.api.questions.get(id(2)).asker.id = OTHER;
  await assert.rejects(s.run({ command: 'recover', attachId: id(2) }), /different asking registrations/);
  const other = await setup(t); other.api.controls.loseNext = true; await other.run();
  const q = other.api.questions.get(id(1)); q.created_at = '2026-01-01T08:58:59.000Z'; q.expires_at = '2026-01-01T09:13:59.000Z';
  await assert.rejects(other.run({ command: 'recover', attachId: id(1) }), /predates/);
});

test('expiry accepts delayed processing but rejects premature and implausibly future resolution on replay', async (t) => {
  const s = await setup(t); await s.run(); s.clock.value = '2026-01-01T09:16:00.000Z';
  s.api.terminal(id(1), 'expired'); s.api.questions.get(id(1)).resolved_at = '2026-01-01T09:15:30.000Z';
  assert.equal((await s.run()).status, 'inconclusive'); assert.equal((await localReport(s.directory, s.options.input)).result, null);
  const original = await s.saved();
  for (const timestamp of ['2026-01-01T09:14:59.999Z', '2026-01-01T09:17:00.001Z']) {
    const saved = structuredClone(original); saved.attempts[0].observation.resolvedAt = timestamp;
    await atomicJson(s.directory, 'state.json', saved); const calls = s.api.calls.length;
    await assert.rejects(s.run(), /resolution time/); assert.equal(s.api.calls.length, calls);
    const live = await setup(t); await live.run(); live.clock.value = s.clock.value; live.api.terminal(id(1), 'expired');
    live.api.questions.get(id(1)).resolved_at = timestamp; await assert.rejects(live.run(), /resolution time/);
  }
});

test('answer and resolution times must agree and answer/cancellation cannot occur after expiry', async (t) => {
  const s = await setup(t); await s.run(); s.api.answer(id(1), 'present');
  s.api.questions.get(id(1)).answer.answered_at = '2026-01-01T09:00:01.000Z';
  assert.equal((await s.run()).observedStatus, 'invalid_answer');
  for (const terminal of ['answered', 'cancelled']) {
    const other = await setup(t); await other.run(); other.clock.value = '2026-01-01T09:16:00.000Z';
    if (terminal === 'answered') other.api.answer(id(1), 'present'); else other.api.terminal(id(1), terminal);
    await assert.rejects(other.run(), /resolution time/);
  }
});

test('checked time follows response; future creation, wrong TTL and answer on pending fail', async (t) => {
  const s = await setup(t); await s.run(); const get = s.api.client.questions.get.bind(s.api.client.questions);
  s.api.client.questions.get = async (...args) => { s.clock.value = '2026-01-01T09:02:00.000Z'; s.api.answer(id(1), 'present'); return get(...args); };
  await s.run(); assert.equal((await s.saved()).attempts[0].observation.checkedAt, s.clock.value);
  for (const mutate of [
    (q) => { q.created_at = '2027-01-01T09:00:00.000Z'; q.expires_at = '2027-01-01T09:15:00.000Z'; },
    (q) => { q.expires_at = '2026-01-01T10:00:00.000Z'; }, (q) => { q.answer = {}; },
  ]) { const other = await setup(t); await other.run(); mutate(other.api.questions.get(id(1))); await assert.rejects(other.run()); }
  assert.equal(iso('2026-01-01T09:00:00+00:00'), '2026-01-01T09:00:00.000Z'); assert.throws(() => iso('2026-02-30T09:00:00Z'));
});

test('room preflight refuses public/unsupported rooms and missing tester before a POST', async (t) => {
  for (const mutate of [(rooms) => { rooms[0].is_public = true; }, (rooms) => { rooms[0].type = 'dm'; }, (rooms) => { rooms[0].members = [{ user_id: OTHER }]; }]) {
    const s = await setup(t); mutate(s.api.rooms); await assert.rejects(s.run()); assert.equal(sends(s.api), 0);
  }
});

test('reservation write failure sends nothing; answer save failure resumes the original question', async (t) => {
  const s = await setup(t); let writes = 0;
  await assert.rejects(s.run({ write: async (...args) => { if (++writes === 2) throw new Error('disk full'); await atomicJson(...args); } }), /disk full/);
  assert.equal(sends(s.api), 0); await s.run(); s.api.answer(id(1), 'present');
  await assert.rejects(s.run({ write: async () => { throw new Error('disk full'); } }), /disk full/);
  assert.equal((await s.saved()).attempts[0].status, 'pending'); assert.equal((await s.run()).status, 'ready'); assert.equal(sends(s.api), 1);
});

test('post-create save failure leaves uncertain intent for verified recovery without another POST', async (t) => {
  const s = await setup(t); let writes = 0;
  await assert.rejects(s.run({ write: async (...args) => { if (++writes === 3) throw new Error('disk full'); await atomicJson(...args); } }), /disk full/);
  assert.equal((await s.run()).status, 'create_unknown');
  assert.equal((await s.run({ command: 'recover', attachId: id(1) })).status, 'pending'); assert.equal(sends(s.api), 1);
});

test('failed reads preserve evidence and corrupted request/provenance fail before network', async (t) => {
  const s = await setup(t); await s.run(); const before = await readFile(join(s.directory, 'state.json'), 'utf8');
  s.api.controls.readError = true; await assert.rejects(s.run()); assert.equal(await readFile(join(s.directory, 'state.json'), 'utf8'), before);
  s.api.controls.readError = false; s.api.answer(id(1), 'present'); await s.run(); const original = await s.saved();
  for (const mutate of [
    (saved) => { saved.attempts[0].request.ttl = 60; }, (saved) => { saved.attempts.push(saved.attempts[0]); },
    (saved) => { saved.attempts[0].pair = 'other::pair'; }, (saved) => { saved.attempts[0].observation.answer.responderId = OTHER; },
  ]) {
    const saved = structuredClone(original); mutate(saved); assert.throws(() => validateState(saved, s.options.input));
    await atomicJson(s.directory, 'state.json', saved); const calls = s.api.calls.length;
    await assert.rejects(s.run()); assert.equal(s.api.calls.length, calls);
  }
});

test('bounded file reads reject malformed, oversized, invalid UTF-8 and symlink data without revealing contents', async (t) => {
  const s = await setup(t), path = join(s.directory, 'bad.json');
  await writeFile(path, '{"secret":"PRIVATE_TOKEN",bad');
  await assert.rejects(readJson(path), (error) => !error.message.includes('PRIVATE_TOKEN') && error.message.includes('malformed'));
  await writeFile(path, Buffer.from([0xff])); await assert.rejects(readJson(path), /UTF-8/);
  await writeFile(path, 'x'.repeat(100)); await assert.rejects(readJson(path, 50), /size limit/);
  await symlink(path, join(s.directory, 'linked')); await assert.rejects(readJson(join(s.directory, 'linked')));
});

test('private lock excludes other commands; report is offline and private', async (t) => {
  const s = await setup(t); await s.run(); const release = await acquireLock(s.directory);
  await assert.rejects(s.run(), /lock exists/); await assert.rejects(localReport(s.directory, s.options.input), /lock exists/);
  await release(); const before = s.api.calls.length;
  assert.equal((await localReport(s.directory, s.options.input, { save: true })).result, null); assert.equal(s.api.calls.length, before);
  assert.equal((await stat(join(s.directory, 'report.json'))).mode & 0o777, 0o600);
});

test('partial or blank environment overrides never combine with saved credentials', async (t) => {
  const s = await setup(t); await atomicJson(s.directory, 'credentials.json', { token: 'saved', room: ROOM_CODE });
  await assert.rejects(loadConnection(s.directory, { PINGROOM_TOKEN: '' })); await assert.rejects(loadConnection(s.directory, { PINGROOM_ROOM: ROOM_CODE }));
  assert.equal((await loadConnection(s.directory, { PINGROOM_TOKEN: 'explicit', PINGROOM_ROOM: ROOM_CODE.toLowerCase() })).token, 'explicit');
});

test('transport rejects unrelated writes, redirects and oversized responses', async () => {
  let count = 0; const client = makeClient({ token: 'fixture', fetchImpl: async () => { count++; return new Response(null, { status: 302 }); } });
  await assert.rejects(client.questions.get(id(1))); assert.equal(count, 1); await assert.rejects(client.questions.cancel(id(1))); assert.equal(count, 1);
  const large = makeClient({ token: 'fixture', fetchImpl: async () => new Response('x'.repeat(512 * 1024 + 1)) }); await assert.rejects(large.questions.get(id(1)));
});

test('transport deadlines bound stalled fetch/body and allow abort through infinite ready empty chunks', async () => {
  const stalled = makeClient({ token: 'fixture', deadlineMs: 20, fetchImpl: () => new Promise(() => {}) }); await assert.rejects(stalled.questions.get(id(1)));
  const body = makeClient({ token: 'fixture', deadlineMs: 20, fetchImpl: async () => new Response(new ReadableStream({ pull: () => new Promise(() => {}) })) }); await assert.rejects(body.questions.get(id(1)));
  const controller = new AbortController();
  const empty = makeClient({ token: 'fixture', signal: controller.signal, fetchImpl: async () => new Response(new ReadableStream({ pull: (out) => out.enqueue(new Uint8Array()) })) });
  const timer = setTimeout(() => controller.abort(), 20); try { await assert.rejects(empty.questions.get(id(1))); } finally { clearTimeout(timer); }
});

test('abort before reservation sends nothing; after reservation it preserves unresolved intent', async (t) => {
  const s = await setup(t), stopped = new AbortController(); stopped.abort(); await assert.rejects(s.run({ signal: stopped.signal })); assert.equal(sends(s.api), 0);
  const controller = new AbortController(); let writes = 0;
  await assert.rejects(s.run({ signal: controller.signal, write: async (...args) => { await atomicJson(...args); if (++writes === 2) controller.abort(); } }));
  assert.equal(sends(s.api), 0); assert.equal((await s.run()).status, 'create_unknown');
});


test('partial external credentials cannot borrow the room from dotenv', async (t) => {
  const s = await setup(t), path = join(s.directory, '.env');
  await writeFile(path, 'PINGROOM_TOKEN=file-token\nPINGROOM_ROOM=DEMO12345678\n');
  const partial = { PINGROOM_TOKEN: 'shell-token' }; await loadEnvironment(partial, path);
  assert.equal(partial.PINGROOM_ROOM, undefined); await assert.rejects(loadConnection(s.directory, partial));
  const env = {}; await loadEnvironment(env, path); assert.deepEqual(await loadConnection(s.directory, env), { token: 'file-token', room: ROOM_CODE });
});

const problem = n => ({caseId:'fixed-repro',title:'Fixed symptom',buildRef:'immutable-build-v1',baseline:'Fresh fixture with all listed components disabled.',instructions:'Enable the exact subset, open Preview, and check the heading.',symptom:'Heading is missing.',components:Array.from({length:n},(_,i)=>({id:String.fromCharCode(97+i),label:`Component ${i}`}))});
function reduce(input,oracle) {
  const history=[];
  for(let i=0;i<maxQuestions(input)+1;i++) {
    const state=reconstruct(input,history);
    if(state.status!=='ready')return {state,history};
    history.push({candidate:state.nextTest,outcome:oracle(state.nextTest.componentIds)?'present':'absent'});
  }
  throw new Error('Exceeded bounded search');
}

test('every Boolean oracle up to three components returns a one-minimal reproducer or observes no full reproducer',()=>{
  let cases=0;
  for(let n=1;n<=3;n++) {
    const input=problem(n),labels=input.components.map(c=>c.id),subsets=1<<n;
    for(let truth=0;truth<(1<<subsets);truth++) {
      const oracle=ids=>Boolean(truth & (1<<ids.reduce((mask,id)=>mask|(1<<labels.indexOf(id)),0)));
      const {state,history}=reduce(input,oracle);cases++;
      assert.ok(history.length<=maxQuestions(input));
      if(!oracle(labels)){assert.equal(state.status,'not_reproduced');assert.equal(history.length,1);assert.equal(state.result,null);continue;}
      assert.equal(state.status,'complete');const answer=state.result.componentIds;assert.ok(oracle(answer));
      for(const id of answer)assert.equal(oracle(answer.filter(other=>other!==id)),false);
      assert.equal(state.result.globallyMinimum,false);
    }
  }
  assert.equal(cases,276);
});

test('one-minimal does not claim that every smaller proper subset is non-reproducing',()=>{
  const input=problem(3),oracle=ids=>ids.length===3||ids.length===0;
  const {state}=reduce(input,oracle);assert.deepEqual(state.result.componentIds,['a','b','c']);
  assert.equal(state.result.oneMinimal,true);assert.equal(state.result.globallyMinimum,false);assert.equal(oracle([]),true);
});

test('accepted removals restart at the first canonical component and preserve interactions',()=>{
  const input=problem(3);input.components.reverse();
  const {state,history}=reduce(input,ids=>ids.includes('a')&&ids.includes('b'));
  assert.deepEqual(history.map(h=>h.candidate.componentIds),[['a','b','c'],['b','c'],['a','c'],['a','b'],['b'],['a']]);
  assert.deepEqual(state.result.componentIds,['a','b']);
  assert.deepEqual(validateInput(input),validateInput({...input,components:[...input.components].reverse()}));
});

test('empty reproducer is reported as baseline-context reproduction',()=>{
  const {state,history}=reduce(problem(3),()=>true);
  assert.deepEqual(state.result,{componentIds:[],oneMinimal:true,globallyMinimum:false,baselineContextReproduces:true});
  assert.deepEqual(history.at(-1).candidate.componentIds,[]);
});

test('history rejects skipped, reordered, forged and extra candidates',()=>{
  const input=problem(3),{history}=reduce(input,ids=>ids.includes('a')&&ids.includes('b'));
  for(const mutate of [h=>h.reverse(),h=>h.splice(1,1),h=>h.push(h.at(-1)),h=>{h[1].candidate.componentIds=['a'];},h=>{h[1].candidate.removedId='b';},h=>{h[1].outcome='unsupported';}]) {
    const changed=structuredClone(history);mutate(changed);assert.throws(()=>reconstruct(input,changed));
  }
  for(const outcome of ['unknown','expired','cancelled','invalid_answer','pending','creating']) {
    const prefix=[{candidate:history[0].candidate,outcome}];assert.throws(()=>reconstruct(input,[...prefix,history[1]]));
  }
});

test('invalid manifests fail before any request and field changes cannot reuse decisions',async t=>{
  for(const mutate of [p=>{p.components=[];},p=>{p.components=problem(7).components;},p=>{p.components[1].id=p.components[0].id;},
    p=>{p.components[0].id='constructor';},p=>{p.components[0].id='x'.repeat(13);},p=>{p.components[0].label='x'.repeat(41);},
    p=>{p.instructions='x'.repeat(71);},p=>{p.symptom='two\nlines';},p=>{p.command='rm anything';},p=>{p.buildRef=null;}]) {
    const input=problem(2);mutate(input);const s=await setup(t,input);await assert.rejects(s.run());assert.equal(s.api.calls.length,0);
  }
  const s=await setup(t,problem(2));await s.run();
  for(const field of ['title','buildRef','baseline','instructions','symptom']) {
    const input=structuredClone(s.options.input);input[field]='Changed';await assert.rejects(s.run({input}),/changed reproduction/);
  }
  await assert.rejects(s.run({config:{participant:{id:OTHER,label:'Other'}}}),/another connection/);
  await assert.rejects(s.run({token:'other'}),/another connection/);
  const input=structuredClone(s.options.input);input.components.reverse();assert.equal((await s.run({input})).status,'pending');assert.equal(sends(s.api),1);
});

test('Unknown stops reduction while retaining only the best observed reproducer',async t=>{
  const s=await setup(t,problem(3));let result=await decide(s,['present','unknown']);
  assert.equal(result.status,'inconclusive');assert.equal(result.reason,'unknown');assert.equal(result.result,null);
  assert.deepEqual(result.bestKnownReproducer,['a','b','c']);assert.equal(result.nextTest,null);
  const calls=s.api.calls.length;result=await s.run();assert.equal(s.api.calls.length,calls);assert.equal(sends(s.api),2);
});

test('full configuration absent stops after one observation without manufacturing a reproducer',async t=>{
  const s=await setup(t,problem(3)),result=await decide(s,['absent']);
  assert.equal(result.status,'not_reproduced');assert.equal(result.result,null);assert.equal(result.bestKnownReproducer,null);assert.equal(result.nextTest,null);
  const calls=s.api.calls.length;await s.run();assert.equal(s.api.calls.length,calls);
});

test('complete reduction exports attributed evidence and remains offline on replay',async t=>{
  const s=await setup(t,problem(3));let result;
  while(true) {
    const pending=await s.run();const candidate=pending.tests.at(-1);
    s.api.answer(candidate.questionId,candidate.candidate.componentIds.includes('a')&&candidate.candidate.componentIds.includes('b')?'present':'absent');
    result=await s.run();if(result.status!=='ready')break;
  }
  assert.equal(result.status,'complete');assert.deepEqual(result.result.componentIds,['a','b']);assert.equal(sends(s.api),6);
  assert.ok(result.tests.every(item=>item.responderId===CONFIG.participant.id&&item.askerId===ASKER));
  const calls=s.api.calls.length;assert.deepEqual((await s.run()).result,result.result);assert.equal(s.api.calls.length,calls);
  await localReport(s.directory,s.options.input,{save:true});assert.deepEqual((await readJson(join(s.directory,'report.json'))).result,result.result);
});

test('maximum six-component search needs at most 22 Questions and all valid prompts fit',async t=>{
  const input=problem(6);input.caseId='c'.repeat(40);input.title='t'.repeat(40);input.buildRef='b'.repeat(40);
  input.baseline='s'.repeat(60);input.instructions='i'.repeat(70);input.symptom='y'.repeat(70);
  input.components=input.components.map(c=>({id:c.id+'x'.repeat(11),label:'l'.repeat(40)}));
  const all=input.components.map(c=>c.id),s=await setup(t,input);let result;
  for(let i=0;i<22;i++) {
    const pending=await s.run(),candidate=pending.tests.at(-1);
    const subset=candidate.candidate.componentIds,expected=all.slice(0,subset.length);
    s.api.answer(candidate.questionId,JSON.stringify(subset)===JSON.stringify(expected)?'present':'absent');
    result=await s.run();if(result.status!=='ready')break;
  }
  assert.equal(result.status,'complete');assert.equal(sends(s.api),22);assert.equal(result.result.baselineContextReproduces,true);
  for(const q of s.api.questions.values()) {
    assert.ok(q.prompt.length<=500);assert.ok(q.context.length<=40);
    assert.equal(q.context,`To ${CONFIG.participant.id}`);
  }
  assert.ok(Buffer.byteLength(JSON.stringify(await s.saved(),null,2))+4096<1024*1024);
  await localReport(s.directory,input,{save:true});assert.ok((await stat(join(s.directory,'report.json'))).size<1024*1024);
});

test('saved path rejects appended work after Unknown, swapped tests, or changed subset evidence',async t=>{
  const s=await setup(t,problem(3));await decide(s,['present','unknown']);const original=await s.saved();
  for(const mutate of [state=>state.attempts.reverse(),state=>{state.attempts[1].candidate.componentIds=['a'];},
    state=>state.attempts.push({...state.attempts[1],id:id(99)}),state=>{state.attempts[1].observation.askerId=OTHER;}]) {
    const state=structuredClone(original);mutate(state);assert.throws(()=>validateState(state,s.options.input));
    await atomicJson(s.directory,'state.json',state);const calls=s.api.calls.length;await assert.rejects(s.run());assert.equal(s.api.calls.length,calls);
  }
});

test('saved and later observations cannot predate intent or regress across Questions',async t=>{
  const s=await setup(t,problem(2));await s.run();s.clock.value='2026-01-01T09:02:00.000Z';await s.run();
  const before=await s.saved();s.clock.value='2026-01-01T09:01:00.000Z';await assert.rejects(s.run(),/regressed/);assert.deepEqual(await s.saved(),before);
  const corrupt=structuredClone(before);corrupt.attempts[0].observation.checkedAt='2026-01-01T08:59:59.000Z';assert.throws(()=>validateState(corrupt,s.options.input),/predates/);
  s.clock.value='2026-01-01T09:03:00.000Z';s.api.answer(id(1),'present');await s.run();
  s.clock.value='2026-01-01T09:02:30.000Z';await assert.rejects(s.run(),/saved candidate/);assert.equal(sends(s.api),1);
});

test('plan before starting exposes the exact full configuration without network or state',async t=>{
  const s=await setup(t,problem(2)),plan=await localReport(s.directory,s.options.input);
  assert.equal(plan.status,'not_started');assert.deepEqual(plan.nextTest.componentIds,['a','b']);assert.equal(plan.instructions,s.options.input.instructions);
  assert.equal(await s.saved(),null);assert.equal(s.api.calls.length,0);
});
