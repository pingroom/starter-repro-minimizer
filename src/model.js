import { createHash } from 'node:crypto';

export const TTL = 900;
export const CLOCK_SKEW_MS = 60000;
export const ROOM = /^[A-Z0-9]{12}$/;
export const isId = value => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value);
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const keys = (value, expected) => record(value) && Object.keys(value).sort().join(',') === [...expected].sort().join(',');
const word = value => typeof value === 'string' && /^[a-z][a-z0-9_-]{0,39}$/.test(value);
const line = (value, max) => typeof value === 'string' && value.length <= max && /^[\x20-\x7e]+$/.test(value) && value.trim() === value;
const canonical = value => Array.isArray(value) ? value.map(canonical) : record(value) ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
export const hash = value => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
const compare = (a,b) => a < b ? -1 : a > b ? 1 : 0;

export function iso(raw) {
  if (typeof raw !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|\+00:00)$/.test(raw)) throw new Error('Expected a UTC timestamp.');
  const time = Date.parse(raw);
  if (!Number.isFinite(time) || new Date(time).toISOString().slice(0,19) !== raw.slice(0,19)) throw new Error('Invalid UTC timestamp.');
  return new Date(time).toISOString();
}

export function validateInput(input) {
  if (!keys(input,['caseId','title','buildRef','baseline','instructions','symptom','components']) || !word(input.caseId)
    || !line(input.title,40) || !line(input.buildRef,40) || !line(input.baseline,60) || !line(input.instructions,70) || !line(input.symptom,70)
    || !Array.isArray(input.components) || input.components.length < 1 || input.components.length > 6) throw new Error('Provide a fixed case, build, baseline, test instructions, symptom, and one to six components.');
  const ids = new Set();
  for (const component of input.components) {
    if (!keys(component,['id','label']) || !word(component.id) || component.id.length > 12 || ids.has(component.id)
      || ['constructor','prototype','__proto__'].includes(component.id) || !line(component.label,40)) throw new Error('Components need unique IDs up to 12 characters and labels up to 40 printable ASCII characters.');
    ids.add(component.id);
  }
  return {...structuredClone(input),components:structuredClone(input.components).sort((a,b)=>compare(a.id,b.id))};
}
export function validateConfig(config) {
  if (!keys(config,['participant']) || !keys(config.participant,['id','label']) || !isId(config.participant.id) || !line(config.participant.label,60)) throw new Error('Config requires an exact tester UUID and label.');
  return structuredClone(config);
}
export const maxQuestions = input => {const n=validateInput(input).components.length;return 1+n*(n+1)/2;};
const full = input => ({kind:'full',componentIds:input.components.map(c=>c.id),removedId:null});
const removal = (current,index) => ({kind:'removal',componentIds:current.filter((_,i)=>i!==index),removedId:current[index]});

/** Reconstruct every branch from exact candidate outcomes; no mutable search pointer. */
export function reconstruct(rawInput, history) {
  const input=validateInput(rawInput);
  if (!Array.isArray(history) || history.length>maxQuestions(input)) throw new Error('Invalid test history.');
  let current=null,index=0,next=full(input),status='ready',reason=null,currentTest=null;
  const terminal=new Set(['expired','cancelled','invalid_answer']);
  for (const item of history) {
    if (status!=='ready' || !keys(item,['candidate','outcome']) || hash(item.candidate)!==hash(next)) throw new Error('History skipped, reordered, or appended a test after completion or uncertainty.');
    const candidate=next;next=null;
    if (item.outcome==='creating' || item.outcome==='pending') {status=item.outcome==='creating'?'create_unknown':'pending';currentTest=candidate;continue;}
    if (item.outcome==='unknown' || terminal.has(item.outcome)) {status='inconclusive';reason=item.outcome;currentTest=candidate;continue;}
    if (!['present','absent'].includes(item.outcome)) throw new Error('Unknown test outcome.');
    if (candidate.kind==='full') {
      if (item.outcome==='absent') {status='not_reproduced';reason='full_configuration_did_not_reproduce';continue;}
      current=[...candidate.componentIds];index=0;
    } else if (item.outcome==='present') {current=[...candidate.componentIds];index=0;}
    else index++;
    if (current.length===0 || index>=current.length) status='complete';
    else next=removal(current,index);
  }
  return {status,reason,bestKnownReproducer:current,nextTest:next,currentTest,
    result:status==='complete'?{componentIds:current,oneMinimal:true,globallyMinimum:false,baselineContextReproduces:current.length===0}:null};
}

export function requestFor(rawInput,config,candidate,attemptId) {
  const input=validateInput(rawInput);
  if (!isId(attemptId) || !keys(candidate,['kind','componentIds','removedId']) || !['full','removal'].includes(candidate.kind)
    || !Array.isArray(candidate.componentIds) || candidate.componentIds.length>input.components.length
    || new Set(candidate.componentIds).size!==candidate.componentIds.length
    || candidate.componentIds.some(id=>!input.components.some(c=>c.id===id))
    || hash(candidate.componentIds)!==hash([...candidate.componentIds].sort(compare))
    || (candidate.kind==='full' ? hash(candidate)!==hash(full(input)) : !input.components.some(c=>c.id===candidate.removedId) || candidate.componentIds.includes(candidate.removedId))) throw new Error('Invalid candidate configuration or attempt.');
  const key=`repro-${attemptId}`;
  const prompt=`${input.title}\nBuild: ${input.buildRef}\nBaseline: ${input.baseline}\nCheck: ${input.instructions}\nSymptom: ${input.symptom}\nEnable exactly: ${candidate.componentIds.join(', ') || '(none)'}\nDisable all other listed components. Is the symptom present?`;
  if(prompt.length>500)throw new Error('Candidate prompt exceeds 500 characters.');
  return {prompt,context:`To ${config.participant.id}`,
    options:[['present','Symptom present'],['absent','Symptom absent'],['unknown','Unknown / untestable']].map(([value,label])=>({value,label,style:'default'})),
    responder_scope:'direct',target_user_id:config.participant.id,ttl:TTL,correlation_id:key,
    data:{input_hash:hash(input),candidate,attempt_id:attemptId},idempotencyKey:key};
}

export function validateState(state,rawInput) {
  const input=validateInput(rawInput);
  if (!keys(state,['version','inputHash','config','room','credentialHash','startedAt','attempts']) || state.version!==1
    || state.inputHash!==hash(input) || typeof state.room!=='string' || !ROOM.test(state.room)
    || typeof state.credentialHash!=='string' || !/^[0-9a-f]{64}$/.test(state.credentialHash)
    || !Array.isArray(state.attempts) || state.attempts.length>maxQuestions(input) || iso(state.startedAt)!==state.startedAt) throw new Error('Invalid state or changed reproduction case. Restore the original inputs.');
  validateConfig(state.config);
  const history=[],ids=new Set(),questionIds=new Set();let previous=state.startedAt,askerId;
  for(const attempt of state.attempts) {
    const expected=reconstruct(input,history);
    if (expected.status!=='ready' || !keys(attempt,['id','candidate','createdAt','request','questionId','status','observation'])
      || !isId(attempt.id) || ids.has(attempt.id) || hash(attempt.candidate)!==hash(expected.nextTest)
      || iso(attempt.createdAt)!==attempt.createdAt || attempt.createdAt<previous
      || hash(attempt.request)!==hash(requestFor(input,state.config,expected.nextTest,attempt.id))
      || !['creating','pending','answered','expired','cancelled','invalid_answer'].includes(attempt.status)) throw new Error('Invalid saved candidate test or history order.');
    ids.add(attempt.id);previous=attempt.createdAt;
    if(attempt.status==='creating') {
      if(attempt.questionId!==null || attempt.observation!==null)throw new Error('Invalid uncertain creation state.');
    } else {
      if(!isId(attempt.questionId)||questionIds.has(attempt.questionId))throw new Error('Invalid or repeated Question ID.');
      questionIds.add(attempt.questionId);validateObservation(attempt.observation,attempt.status,attempt.request);
      if(Date.parse(attempt.observation.createdAt)<Date.parse(attempt.createdAt)-CLOCK_SKEW_MS || attempt.observation.checkedAt<attempt.createdAt)throw new Error('Observation predates its saved creation intent.');
      previous=attempt.observation.checkedAt;
      if(askerId!==undefined && attempt.observation.askerId!==askerId)throw new Error('Questions belong to different asking registrations.');
      askerId=attempt.observation.askerId;
    }
    history.push({candidate:attempt.candidate,outcome:attempt.status==='answered'?attempt.observation.answer.value:attempt.status});
  }
  reconstruct(input,history);
  return state;
}

export function report(state,rawInput) {
  const input=validateInput(rawInput);validateState(state,input);
  const tests=state.attempts.map(a=>({candidate:a.candidate,status:a.status==='creating'?'create_unknown':a.status,choice:a.observation?.answer?.value??null,
    questionId:a.questionId,attemptId:a.id,responderId:a.observation?.answer?.responderId??null,answeredAt:a.observation?.answer?.answeredAt??null,
    askerId:a.observation?.askerId??null,observedAt:a.observation?.checkedAt??null}));
  const search=reconstruct(input,state.attempts.map(a=>({candidate:a.candidate,outcome:a.status==='answered'?a.observation.answer.value:a.status})));
  return {...search,caseId:input.caseId,title:input.title,inputHash:hash(input),buildRef:input.buildRef,baseline:input.baseline,instructions:input.instructions,symptom:input.symptom,
    components:input.components,participant:state.config.participant,tests,questionLimit:maxQuestions(input),actionsExecuted:false,
    assumptions:['The same fixed build, baseline and procedure are used for every test.','The symptom is stable and repeatable for each exact subset.','The tester applies exactly the listed configuration and reports accurately.']};
}

function validateObservation(observation, status, request) {
  if (!keys(observation, ['createdAt', 'expiresAt', 'checkedAt', 'askerId', 'resolvedAt', 'answer']) || !isId(observation.askerId)) throw new Error('Invalid saved observation.');
  for (const key of ['createdAt', 'expiresAt', 'checkedAt']) if (iso(observation[key]) !== observation[key]) throw new Error('Invalid saved timestamp.');
  const duration = Date.parse(observation.expiresAt) - Date.parse(observation.createdAt);
  if (duration < TTL * 1000 - 1000 || duration > TTL * 1000 + 1000) throw new Error('Question lifetime differs from the saved request.');
  const latest = Date.parse(observation.checkedAt) + CLOCK_SKEW_MS;
  if (Date.parse(observation.createdAt) > latest) throw new Error('Question creation is implausibly in the future. Check the local clock.');
  if (status === 'pending') {
    if (observation.resolvedAt !== null) throw new Error('Pending Question has a resolution timestamp.');
  } else if (iso(observation.resolvedAt) !== observation.resolvedAt || observation.resolvedAt < observation.createdAt
    || Date.parse(observation.resolvedAt) > latest
    || (status === 'expired' ? observation.resolvedAt < observation.expiresAt : observation.resolvedAt > observation.expiresAt)) throw new Error('Invalid Question resolution time.');
  if (status === 'answered') {
    const answer = observation.answer;
    if (!keys(answer, ['value', 'label', 'responderId', 'answeredAt']) || answer.responderId !== request.target_user_id
      || !request.options.some((option) => option.value === answer.value && option.label === answer.label)
      || iso(answer.answeredAt) !== answer.answeredAt || answer.answeredAt !== observation.resolvedAt
      || answer.answeredAt < observation.createdAt || answer.answeredAt > observation.expiresAt) throw new Error('Invalid saved test evidence.');
  } else if (observation.answer !== null) throw new Error('Unanswered tests must not contain classification evidence.');
}

export function observeQuestion(q, request, questionId, room, checkedAt) {
  if (!isId(questionId) || q?.id !== questionId || q.kind !== 'question' || q.is_handoff !== false
    || q.asker?.type !== 'agent' || !isId(q.asker?.id) || q.prompt !== request.prompt || q.context !== request.context
    || q.responder_scope !== 'direct' || q.target_user_id !== request.target_user_id || q.resolution_policy !== 'first'
    || q.results !== null || q.text_input !== null || q.correlation_id !== request.correlation_id || q.reply_to !== null || hash(q.data) !== hash(request.data)
    || (q.room_code ?? q.room?.code) !== room || q.room_code !== undefined && q.room_code !== room
    || q.room !== undefined && q.room?.code !== room || !['pending', 'answered', 'expired', 'cancelled'].includes(q.state)
    || !Array.isArray(q.options) || q.options.length !== request.options.length
    || q.options.some((option, index) => option?.value !== request.options[index].value || option?.label !== request.options[index].label
      || option?.primary !== false || option?.destructive !== false)) throw new Error('Question does not match the saved candidate subset, room, or tester.');
  const observation = { createdAt: iso(q.created_at), expiresAt: iso(q.expires_at), checkedAt: iso(checkedAt), askerId: q.asker.id,
    resolvedAt: q.resolved_at === null ? null : iso(q.resolved_at), answer: null };
  let status = q.state === 'answered' ? 'invalid_answer' : q.state;
  if (q.state !== 'answered' && q.answer !== null) throw new Error('Unresolved Question includes an unexpected answer.');
  if (q.state === 'answered') {
    const answer = q.answer;
    try {
      if (!answer || answer.text !== null || answer.responder?.id !== request.target_user_id
        || !request.options.some((option) => option.value === answer.value && option.label === answer.label)) throw new Error('Invalid answer.');
      observation.answer = { value: answer.value, label: answer.label, responderId: answer.responder.id, answeredAt: iso(answer.answered_at) };
      validateObservation(observation, 'answered', request); status = 'answered';
    } catch { observation.answer = null; }
  }
  validateObservation(observation, status, request);
  return { status, observation };
}


export function assertParticipantRoom(rooms, room, participantId) {
  if (!Array.isArray(rooms) || rooms.length > 1000) throw new Error('Invalid room inventory.');
  const matches = rooms.filter((item) => item?.invite_code === room), selected = matches[0];
  if (matches.length !== 1 || selected.type !== 'standard' || selected.is_public !== false || !Array.isArray(selected.members)
    || selected.members.length > 1000 || !selected.members.some((member) => member?.user_id === participantId)) throw new Error('Use a granted standard private room containing the named participant.');
}
