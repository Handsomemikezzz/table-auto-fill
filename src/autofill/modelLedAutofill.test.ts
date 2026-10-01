import { getPersonalAdditionalFields, matchSupplementDefinition } from '../shared/personalFields.ts';
import { createBackupDocument, parseAndValidateBackup, serializeBackup } from '../shared/backup.ts';
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { createProfileSnapshot, savePersonalField } from './profileSnapshot.ts';
import { createFieldRegistry, registryVersion, meaningCandidates } from './fieldRegistry.ts';
import { validateDecision, validateModule } from './decisionValidation.ts';
import { buildRuleDecisions, profileForRuleBinding } from './ruleDecisions.ts';
import { FillSessionController } from './fillSessionController.ts';
import { LLMDecisionProvider } from './decisionProvider.ts';
import { prepareDecisionContext } from './decisionContext.ts';
import { createProfileImportDraft, applyProfileImportDraft } from './profileImport.ts';
import { normalizeUserProfile } from '../shared/storage.ts';
import type { UserProfile } from '../shared/types.ts';
import type { FieldObservation, FieldDecision, DecisionRequest, FillContextData } from './contracts.ts';

const profile: UserProfile = { personal: { name: '小王', gender: '', birthDate: '', phone: '00138', email: '' }, education: [{ id: 'edu1', school: '安徽大学', degree: '本科', major: '', startDate: '2018-09', endDate: '2022-06' }, { id: 'edu2', school: '乙大学', degree: '硕士', major: '', startDate: '2022-09', endDate: '2025-06' }], experience: [], projects: [], certifications: [], skills: [], customInformation: [] };
const registry = createFieldRegistry();
const snapshot = createProfileSnapshot(profile);
const context: FillContextData = { sessionId: 'session1', profile: snapshot, registry, registryVersion: registryVersion(registry) };
function field(id = 'name', overrides: Partial<FieldObservation> = {}): FieldObservation { return { fieldId: id, snapshotVersion: 'v1', frameId: '0', groupId: 'g1', groupLabel: '基本资料', signature: id, label: '姓名', context: '', kind: 'text', required: false, currentValue: '', disabled: false, options: [], optionsState: 'complete', candidates: ['personal.name', 'personal.phone', 'unknown'], ...overrides }; }
function decision(target = field(), meaning = 'personal.name', recordId?: string, overrides: Partial<FieldDecision> = {}): FieldDecision {
  const fact = snapshot.facts.find(fact => fact.meaningId === meaning && fact.recordId === recordId)!;
  return { fieldId: target.fieldId, snapshotVersion: target.snapshotVersion, decisionId: 'd1', meaningId: meaning, subject: fact.subject, recordId, factId: fact.id, nextAction: 'write', dependencyIds: [], evidenceIds: [], modelId: 'fixture', profileVersion: snapshot.version, registryVersion: context.registryVersion, ...overrides };
}
const request = (fields = [field()]): DecisionRequest => ({ fields, profile: snapshot, registry, registryVersion: context.registryVersion, corrections: [] });

test('snapshot preserves missing facts and date precision without inferred college, degree or study type', () => {
  const loaded = normalizeUserProfile(profile);
  assert.equal(loaded.education[0].educationType, '');
  assert.equal(loaded.education[0].academicDegree, '');
  assert.equal(loaded.education[0].college, '');
  assert.equal(snapshot.facts.find(fact => fact.meaningId === 'education.endDate')?.precision, 'month');
  assert(!snapshot.facts.some(fact => fact.meaningId === 'education.academicDegree'));
});
test('snapshots are isolated, stable and keep record IDs through reorder', () => {
  const copy = structuredClone(profile);
  const frozen = createProfileSnapshot(copy);
  copy.personal.name = 'changed';
  assert.equal(frozen.facts[0].value, '小王');
  const reversed = createProfileSnapshot({ ...profile, education: [...profile.education].reverse() });
  assert.deepEqual(new Set(reversed.facts.map(fact => fact.id)), new Set(snapshot.facts.map(fact => fact.id)));
  assert.notEqual(createProfileSnapshot(copy).version, frozen.version);
});
test('selected profile never silently inherits unrelated record facts by index', () => {
  const variant = { id: 'r1', category: '岗位', fileName: 'r.pdf', fileData: 'data:', fileType: 'pdf', uploadDate: 'now', parsedProfile: { personal: {}, education: [{ ...profile.education[0], school: '其他学校', id: 'other', college: '' }], experience: [], projects: [], skills: [] } };
  const selected = createProfileSnapshot({ ...profile, education: [{ ...profile.education[0], college: '已确认学院' }], resumes: [variant] }, 'r1');
  assert(!selected.facts.some(fact => fact.value === '已确认学院'));
  assert.equal(selected.facts.find(fact => fact.meaningId === 'personal.name')?.value, '小王');
});
test('conflicting record blocks only its own facts', () => {
  const conflict = createProfileSnapshot({ ...profile, education: [{ ...profile.education[0], startDate: '2024-01' }, profile.education[1]] });
  assert(conflict.facts.filter(fact => fact.recordId === 'edu1').every(fact => fact.conflict));
  assert(conflict.facts.filter(fact => fact.recordId === 'edu2').every(fact => !fact.conflict));
});
test('new additional fact extends registry without enums, prompts or switches', () => {
  const additional = { id: 'available', meaningId: 'availability.earliestStartDate', label: '最早到岗日期', subject: 'self', value: '2026-10-12', valueType: 'date' as const, updatedAt: '2026-09-29' };
  const expanded = createFieldRegistry([additional]);
  assert(expanded.some(def => def.id === additional.meaningId));
  assert.equal(createProfileSnapshot({ ...profile, additionalFacts: [additional] }, 'default', expanded).facts.find(fact => fact.meaningId === additional.meaningId)?.value, additional.value);
  assert(meaningCandidates('姓名', registry).length >= 3);
});
test('validator rejects invented facts, subjects, records and stale versions', () => {
  for (const patch of [{ factId: 'invented' }, { subject: 'emergencyContact' }, { recordId: 'edu1' }, { profileVersion: 'old' }, { snapshotVersion: 'old' }, { registryVersion: 'old' }]) assert(validateDecision(decision(field(), 'personal.name', undefined, patch), field(), request()).error);
});
test('provider selects real option identities even for expressions absent from string aliases', () => {
  const target = field('degree', { kind: 'select', options: [{ id: 'option8', label: '大学本科毕业', rawValue: 987 }] });
  const choice = decision(target, 'education.degree', 'edu1', { nextAction: 'select', targetOptionIds: ['option8'] });
  assert(!validateDecision(choice, target, request([target])).error);
  assert(validateDecision({ ...choice, targetOptionIds: ['not-real'] }, target, request([target])).error);
  assert(validateDecision({ ...choice, nextAction: 'write' }, target, request([target])).error);
});
test('mixed records invalidate the entire module before any writes', () => {
  const fields = [field('school'), field('degree')];
  const errors = validateModule([decision(fields[0], 'education.school', 'edu1'), decision(fields[1], 'education.degree', 'edu2')], request(fields));
  assert.equal(errors.size, 2);
});
test('duplicate decisions and cyclic dependencies cannot execute', () => {
  assert(validateModule([decision(), decision()], request()).has('name'));
  const fields = [field('a'), field('b')];
  const errors = validateModule([decision(fields[0], 'personal.name', undefined, { dependencyIds: ['b'] }), decision(fields[1], 'personal.phone', undefined, { dependencyIds: ['a'] })], request(fields));
  assert.equal(errors.size, 2);
});
function harness(fields: FieldObservation[] = [field()]) {
  const writes: string[] = [], calls: string[][] = [];
  let observations = fields;
  const ports = {
    observe: () => observations,
    decide: async (fields: FieldObservation[]) => { calls.push(fields.map(field => field.fieldId)); return fields.map(target => decision(target)); },
    execute: async (target: FieldObservation, _decision: FieldDecision, value: string) => { writes.push(target.fieldId + ':' + value); return { status: 'verified' as const, reason: 'ok' }; },
    verify: async () => ({ status: 'verified' as const, reason: 'ok' }),
    readOptions: async () => {}, cancel: () => {}, update: () => {},
  };
  const controller = new FillSessionController(context, ports);
  return { controller, ports, calls, writes, observe: (fields: FieldObservation[]) => { observations = fields; } };
}
test('session results distinguish automatic, assisted and preserved fields without exposing values', async () => {
  const h = harness([field('auto'), field('existing', { currentValue: 'private existing answer' }), field('manual')]);
  h.ports.decide = async fields => fields.map(target => decision(target, 'personal.name', undefined,
    target.fieldId === 'manual' ? { nextAction: 'manual' } : {}));
  assert.equal(h.controller.result.settled, false);
  await h.controller.run();
  assert.equal(h.controller.result.settled, true);
  assert.equal(h.controller.result.counts.verified, 1);
  assert.equal(h.controller.result.counts.existing, 1);
  await h.controller.manual(h.controller.items.find(item => item.observation.fieldId === 'manual')!, 'private manual answer');
  assert.equal(h.controller.result.counts.assisted, 1);
  assert.equal(h.controller.result.counts.verified, 1);
  assert.doesNotMatch(JSON.stringify(h.controller.result), /private|小王|00138|expectedValue|observedValue/);
});
test('stopped model requests are not settled until the pending operation returns', async () => {
  const h = harness();
  let release!: (value: FieldDecision[]) => void;
  let markStarted!: () => void;
  const started = new Promise<void>(resolve => { markStarted = resolve; });
  h.ports.decide = () => new Promise(resolve => { release = resolve; markStarted(); });
  const running = h.controller.run();
  await started;
  h.controller.stop();
  assert.equal(h.controller.result.phase, 'stopped');
  assert.equal(h.controller.result.settled, false);
  release([decision()]); await running;
  assert.equal(h.controller.result.settled, true);
  assert.equal(h.controller.result.modelRequests, 1);
  assert.equal(h.controller.result.counts.verified, 0);
});
test('fields without a confident rule still reach the model', async () => {
  const h = harness([field('known'), field('unknown', { candidates: ['unknown'] })]);
  await h.controller.run(); assert.deepEqual(h.calls, [['known', 'unknown']]); assert.equal(h.writes.length, 2); assert.equal(h.controller.counts.verified, 2);
});
test('model outage leaves unmatched fields as todos', async () => {
  const h = harness(); h.ports.decide = async () => { throw new Error('暂时无法连接填写服务'); };
  await h.controller.run(); assert.equal(h.writes.length, 0); assert.equal(h.controller.counts.todo, 1); assert.match(h.controller.error, /暂时无法连接/);
});
test('stop while awaiting model prevents subsequent execution', async () => {
  const h = harness(); h.ports.decide = async fields => { h.controller.stop(); return fields.map(target => decision(target)); };
  await h.controller.run(); assert.equal(h.writes.length, 0); assert.equal(h.controller.phase, 'stopped');
});
test('changed target is reobserved and reviewed by model before a write', async () => {
  const h = harness(); let calls = 0;
  h.ports.decide = async fields => { calls++; if (calls === 1) h.observe([field('name', { snapshotVersion: 'v2' })]); return fields.map(target => decision(target)); };
  const originalExecute = h.ports.execute;
  h.ports.execute = async (...args) => args[0].snapshotVersion === 'v1' ? { status: 'stale', reason: '目标版本已变化' } as any : originalExecute(...args);
  await h.controller.run(); assert.equal(calls, 2); assert.equal(h.writes.length, 1);
});
test('unchanged options do not cause repeated model calls or retries', async () => {
  const h = harness([field('name', { kind: 'combobox' })]); let calls = 0;
  h.ports.decide = async fields => { calls++; return fields.map(target => decision(target, 'personal.name', undefined, { nextAction: 'readOptions' })); };
  await h.controller.run(); assert(calls <= 2); assert.equal(h.writes.length, 0); assert.equal(h.controller.counts.todo, 1);
});
test('manual completion, skips and existing inputs are never automatic completions', async () => {
  const h = harness(); await h.controller.run(); await h.controller.manual(h.controller.items[0], '用户值');
  assert.equal(h.controller.counts.verified, 0); assert.equal(h.controller.counts.assisted, 1);
  h.controller.skip(h.controller.items[0]); assert.equal(h.controller.counts.skipped, 1);
});
test('resume import requires explicit choices and preserves confirmed facts by default', () => {
  const changes = createProfileImportDraft(profile, { personal: { name: '解析姓名', email: 'new@example.test' }, rawText: '' });
  assert.equal(changes.find(change => change.key === 'personal.name')?.selected, false);
  const updated = applyProfileImportDraft(profile, changes);
  assert.equal(updated.personal.name, profile.personal.name); assert.equal(updated.personal.email, 'new@example.test');
  const name = changes.find(change => change.key === 'personal.name')!; name.selected = true;
  assert.throws(() => applyProfileImportDraft({ ...profile, personal: { ...profile.personal, name: 'new edit' } }, changes), /资料已被修改/);
});
test('provider discards generated values and stamps trusted model and profile versions', async () => {
  const provider = new LLMDecisionProvider({ provider: 'custom', apiKey: '', baseUrl: 'http://localhost', model: 'local' }, { chat: async () => ({ content: JSON.stringify({ decisions: [{ ...decision(), value: '伪造值', modelId: 'fake', profileVersion: 'fake' }] }) }) });
  const [result] = await provider.decide(request(), new AbortController().signal);
  assert(!('value' in result)); assert.equal(result.modelId, 'custom:local'); assert.equal(result.profileVersion, snapshot.version);
});
test('entry points share the controller and do not inject generated answers', () => {
  const entry = readFileSync(new URL('../content/index.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(entry, /\.fillForm\(|prepareDynamicSections\(|injectAIButtons\(|GENERATE_ANSWER|AI_FILL_SECTION/);
  assert.match(entry, /FillSessionController/);
});

test('date option cannot add invented day precision', () => {
  const target = field('graduation', { kind: 'select', options: [{ id: 'day', label: '2022-06-01' }] });
  const choice = decision(target, 'education.endDate', 'edu1', { nextAction: 'select', targetOptionIds: ['day'] });
  assert.match(validateDecision(choice, target, request([target])).error || '', /日期精度/);
});
test('disabled and unsupported fields are counted as incomplete', async () => {
  const h = harness([field('unavailable', { kind: 'unsupported', disabled: true })]);
  await h.controller.run(); assert.equal(h.writes.length, 0); assert.equal(h.controller.counts.todo, 1);
});
test('user-confirmed meaning remains a constraint on model writes', () => {
  const req = request();
  req.corrections.push({ id: 'correction', origin: 'https://example.test', signature: 'name', profileVersion: snapshot.version, registryVersion: context.registryVersion, meaningId: 'personal.phone', confirmedAt: 'now', enabled: true });
  assert.match(validateDecision(decision(), field(), req).error || '', /用户确认/);
  req.corrections[0].profileVersion = 'old';
  assert(!validateDecision(decision(), field(), req).error);
});
test('new dependency fields discovered after writing still require model decisions', async () => {
  const h = harness(); const original = h.ports.execute;
  h.ports.execute = async (...args) => { const result = await original(...args); if (args[0].fieldId === 'name') h.observe([field(), field('revealed')]); return result; };
  await h.controller.run(); assert.deepEqual(h.calls, [['name'], ['revealed']]); assert.equal(h.writes.length, 2);
});
test('a failed date endpoint invalidates automatic completion for the whole range', async () => {
  const fields = [field('start'), field('end')]; const h = harness(fields);
  h.ports.decide = async fields => fields.map(target => decision(target, target.fieldId === 'start' ? 'education.startDate' : 'education.endDate', 'edu1'));
  h.ports.execute = async target => ({ status: target.fieldId === 'start' ? 'verified' : 'unverified', reason: '未保留' }) as any;
  await h.controller.run(); assert.equal(h.controller.counts.verified, 0); assert.equal(h.controller.counts.todo, 2);
});

test('explicit date correction updates only the chosen education record', async () => {
  const { saveConfirmedFact } = await import('./profileSnapshot.ts');
  const updated = saveConfirmedFact(profile, { id: 'correction', meaningId: 'education.endDate', recordId: 'edu1', label: '毕业时间', subject: 'self', value: '2022-06-18', valueType: 'date', updatedAt: 'now' });
  assert.equal(updated.education[0].endDate, '2022-06-18');
  assert.equal(updated.education[1].endDate, profile.education[1].endDate);
  assert.equal(profile.education[0].endDate, '2022-06');
  assert.throws(() => saveConfirmedFact(profile, { id: 'x', meaningId: 'education.endDate', label: '毕业时间', subject: 'self', value: '2022-06-18', valueType: 'date', updatedAt: 'now' }), /所属的经历/);
});
test('expired additional facts request confirmation instead of being used silently', () => {
  const stale = createProfileSnapshot({ ...profile, additionalFacts: [{ id: 'old', meaningId: 'availability', label: '到岗日期', subject: 'self', value: '2020-01-01', valueType: 'date', updatedAt: '2019-12-01', expiresAt: '2020-01-01' }] });
  assert.match(stale.facts.find(fact => fact.meaningId === 'availability')?.conflict || '', /过期/);
});
test('an unknown date endpoint prevents its partner from being counted as complete', async () => {
  const fields = [field('start', { dateGroupId: 'range' }), field('end', { dateGroupId: 'range' })]; const h = harness(fields);
  h.ports.decide = async fields => fields.map(target => target.fieldId === 'start' ? decision(target, 'education.startDate', 'edu1') : decision(target, 'personal.name', undefined, { nextAction: 'requestMeaning', meaningId: undefined, factId: undefined }));
  await h.controller.run(); assert.equal(h.controller.counts.verified, 0); assert.equal(h.controller.counts.todo, 2); assert.equal(h.controller.counts.missing, 0);
});
test('preserved conflicting upstream values do not satisfy a planned dependency', async () => {
  const h = harness([field('upstream'), field('child')]);
  h.ports.decide = async fields => fields.map(target => decision(target, 'personal.name', undefined, { dependencyIds: target.fieldId === 'child' ? ['upstream'] : [] }));
  h.ports.execute = async target => { h.writes.push(target.fieldId); return { status: 'skipped-existing', reason: '保留' } as any; };
  await h.controller.run(); assert.deepEqual(h.writes, ['upstream']); assert.equal(h.controller.counts.existing, 1); assert.equal(h.controller.counts.todo, 1);
});


test('confident rules fill all modules before any slow model request', async () => {
  const known = field('known', { groupId: 'last', ruleBinding: { meaningId: 'personal.name', confidence: 0.98 } });
  const h = harness([field('unknown', { groupId: 'first' }), known]);
  h.ports.decide = async fields => { assert.deepEqual(h.writes, ['known:小王']); h.calls.push(fields.map(field => field.fieldId)); return fields.map(target => decision(target)); };
  await h.controller.run(); assert.deepEqual(h.calls, [['unknown']]); assert.equal(h.controller.counts.verified, 2);
});
test('known fields require zero model requests, including when no model is configured', async () => {
  const h = harness([field('name', { ruleBinding: { meaningId: 'personal.name', confidence: 0.98 } })]);
  h.controller.context.modelAvailable = false;
  try { await h.controller.run(); assert.deepEqual(h.calls, []); assert.equal(h.controller.counts.verified, 1); }
  finally { delete h.controller.context.modelAvailable; }
});
test('model failure in one module does not prevent a later module from filling', async () => {
  const h = harness([field('first', { groupId: 'a' }), field('second', { groupId: 'b' })]);
  h.ports.decide = async fields => { h.calls.push(fields.map(field => field.fieldId)); if (fields[0].fieldId === 'first') throw new Error('请求超时'); return fields.map(target => decision(target)); };
  await h.controller.run(); assert.deepEqual(h.writes, ['second:小王']); assert.equal(h.controller.counts.todo, 1); assert.equal(h.controller.counts.verified, 1);
});
test('rule failures reach model fallback with the remaining fields only', async () => {
  const h = harness([field('known', { ruleBinding: { meaningId: 'personal.name', confidence: 0.98 } }), field('unknown')]);
  await h.controller.run(); assert.deepEqual(h.calls, [['unknown']]);
});
test('rules do not invent facts, use low-confidence matches, or ignore corrections', () => {
  const target = field('name', { ruleBinding: { meaningId: 'personal.name', confidence: 0.6 } });
  assert.equal(buildRuleDecisions([target], context).length, 0);
  target.ruleBinding!.confidence = 0.98;
  const correction = { id: 'c', origin: 'https://site.test', signature: target.signature, meaningId: 'personal.phone', enabled: true, confirmedAt: 'now', profileVersion: context.profile.version, registryVersion: context.registryVersion };
  assert.equal(buildRuleDecisions([target], context, [correction]).length, 0);
  assert.equal(profileForRuleBinding(snapshot).education[1].school, '乙大学');
});
test('failed rule operation reaches model and a different option plan can recover it', async () => {
  const target = field('choice', { kind: 'select', options: [{ id: 'option-name', label: '小王' }], ruleBinding: { meaningId: 'personal.name', confidence: 0.98 } });
  const h = harness([target]);
  h.ports.execute = async (field, plan, value) => {
    h.writes.push(field.fieldId + ':' + plan.nextAction);
    return plan.modelId === 'local-rules-v1' ? { status: 'needs-mapping', reason: '请确认网站选项' } as any : { status: 'verified', reason: value };
  };
  h.ports.decide = async fields => { assert.equal(fields[0].resolvedBinding?.factId, snapshot.facts[0].id); h.calls.push(fields.map(field => field.fieldId)); return fields.map(field => decision(field, 'personal.name', undefined, { nextAction: 'select', targetOptionIds: ['option-name'] })); };
  await h.controller.run(); assert.deepEqual(h.calls, [['choice']]); assert.deepEqual(h.writes, ['choice:write', 'choice:select']); assert.equal(h.controller.counts.verified, 1);
});
test('unsupported rule execution hands off without reinterpreting a known answer', async () => {
  const h = harness([field('school', { ruleBinding: { meaningId: 'personal.name', confidence: 1 } })]);
  h.ports.execute = async () => ({ status: 'unsupported', reason: '请在网页中选择' } as any);
  await h.controller.run();
  assert.equal(h.controller.counts.todo, 1); assert.equal(h.controller.modelRequests, 0);
  assert.equal(h.controller.items[0].decision?.meaningId, 'personal.name');
});
test('known date precision failures do not ask the model to invent a more precise answer', async () => {
  const h = harness([field('birthday', { kind: 'date', ruleBinding: { meaningId: 'personal.birthDate', confidence: 1 } })]);
  const dated = createProfileSnapshot({ ...profile, personal: { ...profile.personal, birthDate: '2000-06' } });
  const controller = new FillSessionController({ ...context, profile: dated }, h.ports);
  h.ports.execute = async () => ({ status: 'needs-mapping', reason: '网站要求具体日期，但资料精度不足' } as any);
  await controller.run(); assert.equal(controller.counts.todo, 1); assert.equal(controller.modelRequests, 0);
});
test('unchanged option reads require only one model call', async () => {
  const h = harness([field('choice', { kind: 'combobox' })]);
  h.ports.decide = async fields => { h.calls.push(['choice']); return fields.map(target => decision(target, 'personal.name', undefined, { nextAction: 'readOptions' })); };
  await h.controller.run(); assert.equal(h.calls.length, 1);
});
test('resolved option matching cannot switch facts or records', () => {
  const target = field('school', { kind: 'select', options: [{ id: 'school-option', label: '安徽大学' }],
    resolvedBinding: { meaningId: 'education.school', subject: 'self', recordId: 'edu1', factId: snapshot.facts.find(fact => fact.meaningId === 'education.school' && fact.recordId === 'edu1')!.id } });
  assert(validateDecision(decision(target, 'education.school', 'edu2', { nextAction: 'select', targetOptionIds: ['school-option'] }), target, request([target])).error);
});
test('option-only context keeps its fact; generic modules keep all facts and education keeps complete records', () => {
  const full = request([field('school', { groupLabel: '教育经历', candidates: ['education.school', 'unknown'] })]);
  full.profile = { ...snapshot, facts: [...snapshot.facts, { id: 'unrelated', meaningId: 'projects.name', subject: 'self', recordId: 'project1', value: 'unrelated project', source: 'test' }] };
  const reduced = prepareDecisionContext(full);
  assert.equal(reduced.registry, full.registry);
  assert.equal(reduced.profile.version, full.profile.version);
  assert.equal(reduced.profile.facts.filter(fact => fact.meaningId.startsWith('education.')).length, snapshot.facts.filter(fact => fact.meaningId.startsWith('education.')).length);
  assert(!reduced.profile.facts.some(fact => fact.id === 'unrelated'));
  const generic = { ...full, fields: [field()] };
  assert.equal(prepareDecisionContext(generic), generic);
  const bound = { ...field(), resolvedBinding: { meaningId: 'personal.name', subject: 'self', factId: snapshot.facts[0].id } };
  assert.deepEqual(prepareDecisionContext({ ...full, fields: [bound] }).profile.facts.map(fact => fact.id), [snapshot.facts[0].id]);
});
test('unknown meanings without AI stay manual rather than falsely reporting absent personal data', async () => {
  const h = harness(); h.controller.context.modelAvailable = false;
  try { await h.controller.run(); assert.equal(h.controller.counts.todo, 1); assert.equal(h.controller.counts.missing, 0); }
  finally { delete h.controller.context.modelAvailable; }
});
test('explicit meaning correction clears a retained binding before deciding again', async () => {
  const target = field('name', { origin: 'https://test.example', ruleBinding: { meaningId: 'personal.name', confidence: 1 } });
  const h = harness([target]);
  h.ports.execute = async (_target, plan) => plan.modelId === 'local-rules-v1' ? { status: 'needs-mapping', reason: '请核对' } as any : { status: 'verified', reason: 'ok' };
  h.ports.decide = async fields => fields.map(target => decision(target, 'personal.name', undefined, { nextAction: 'requestMeaning' }));
  await h.controller.run(); assert(h.controller.items[0].resolvedBinding);
  h.ports.decide = async fields => { assert.equal(fields[0].resolvedBinding, undefined); return fields.map(target => decision(target, 'personal.phone')); };
  await h.controller.confirmMeaning(h.controller.items[0], { id: 'correction', enabled: true, origin: 'https://test.example', signature: 'name', meaningId: 'personal.phone', profileVersion: snapshot.version, registryVersion: context.registryVersion, confirmedAt: '2026-09-30' });
  assert.equal(h.controller.counts.verified, 1); assert.equal(h.controller.items[0].decision?.meaningId, 'personal.phone');
});
test('fixed reference dates make expired-fact evaluation reproducible', () => {
  const timed = { ...profile, personal: { ...profile.personal, additionalFields: [{ id: 'availability', meaningId: 'personal.extra.availability', subject: 'self', label: '到岗日期', value: '2026-10-12', valueType: 'date' as const, updatedAt: '2026-09-01', expiresAt: '2026-10-01' }] } };
  assert(!createProfileSnapshot(timed, 'default', undefined, '2026-09-30').facts.find(fact => fact.id === 'personal-extra:availability')?.conflict);
  assert(createProfileSnapshot(timed, 'default', undefined, '2026-10-02').facts.find(fact => fact.id === 'personal-extra:availability')?.conflict);
});
test('provider rejects a guessed valid fact ID that was not sent in the reduced context', async () => {
  const bound = field('name', { resolvedBinding: { meaningId: 'personal.name', subject: 'self', factId: snapshot.facts[0].id } });
  const provider = new LLMDecisionProvider({ provider: 'custom', apiKey: '', baseUrl: 'http://local', model: 'fixture' }, {
    chat: async messages => {
      const input = JSON.parse(messages[1].content as string);
      assert.deepEqual(input.profile.facts.map(fact => fact.id), [snapshot.facts[0].id]);
      return { content: JSON.stringify({ decisions: [decision(bound, 'personal.phone')] }) } as any;
    },
  });
  const result = await provider.decide(request([bound]), new AbortController().signal);
  assert.equal(result[0].nextAction, 'requestMeaning');
});
test('a later field cannot change a previously established education record', () => {
  const target = field('major');
  const input = { ...request([target]), establishedBindings: [{ groupId: 'g1', meaningId: 'education.school', recordId: 'edu1', factId: snapshot.facts.find(fact => fact.meaningId === 'education.school' && fact.recordId === 'edu1')!.id }] };
  const wrong = decision(target, 'education.degree', 'edu2');
  assert(validateDecision(wrong, target, input).error);
  assert(!validateDecision(decision(target, 'education.degree', 'edu1'), target, input).error);
});


test('age, portfolio, preferred cities and languages save under personal and fill without a website key', async () => {
  let updated = profile;
  const values = [['年龄', '26', 'age'], ['作品集链接', 'https://portfolio.example/me', 'portfolioUrl'], ['意向城市', '上海', 'preferredCities'], ['外语能力', '英语 CET-6', 'languageSkills']];
  for (const [label, value] of values) updated = savePersonalField(updated, { label, value, expectedValue: '' });
  for (const [, value, key] of values) assert.equal((updated.personal as any)[key], value);
  assert(!JSON.stringify(updated.personal).includes('origin'));
  const expanded = createFieldRegistry(getPersonalAdditionalFields(updated));
  const facts = createProfileSnapshot(updated);
  const ctx = { ...context, registry: expanded, registryVersion: registryVersion(expanded), profile: facts };
  for (const origin of ['https://a.test', 'https://b.test']) {
    const fields = values.map(([label, , key]) => field(key, { label, origin, ruleBinding: { meaningId: matchSupplementDefinition(label, expanded)!.id, confidence: 1 } }));
    assert.equal(buildRuleDecisions(fields, ctx).length, 4);
  }
});
test('arbitrary personal answers are reusable globally and repeated saves update the same field', () => {
  const first = savePersonalField(profile, { label: '推荐方式*', value: '内推', expectedValue: '' });
  assert.equal(first.personal.additionalFields?.length, 1);
  assert.equal(first.personal.additionalFields?.[0].label, '推荐方式');
  const second = savePersonalField(first, { label: '推荐方式', value: '校友推荐', expectedValue: '内推' });
  assert.equal(second.personal.additionalFields?.length, 1);
  assert.equal(second.personal.additionalFields?.[0].id, first.personal.additionalFields?.[0].id);
  const registry = createFieldRegistry(getPersonalAdditionalFields(second));
  const match = matchSupplementDefinition('推荐方式：', registry)!;
  const facts = createProfileSnapshot(second);
  const plans = buildRuleDecisions([field('referral', { origin: 'https://another.test', ruleBinding: { meaningId: match.id, confidence: 1 } })], { ...context, registry, registryVersion: registryVersion(registry), profile: facts });
  assert.equal(plans.length, 1);
  assert.equal(facts.facts.find(fact => fact.id === plans[0].factId)?.value, '校友推荐');
});
test('missing known personal information stays blank without a model call or a blocking todo', async () => {
  const h = harness([field('age', { ruleBinding: { meaningId: 'personal.age', confidence: 1 } }), field('name', { ruleBinding: { meaningId: 'personal.name', confidence: 1 } })]);
  await h.controller.run(); assert.deepEqual(h.calls, []); assert.equal(h.controller.counts.verified, 1); assert.equal(h.controller.counts.todo, 0); assert.equal(h.controller.counts.missing, 1);
});
test('model request for an absent answer becomes optional personal supplementation', async () => {
  const h = harness(); h.ports.decide = async fields => fields.map(target => decision(target, 'personal.name', undefined, { nextAction: 'requestFact', factId: undefined, meaningId: undefined }));
  await h.controller.run(); assert.equal(h.writes.length, 0); assert.equal(h.controller.counts.todo, 0); assert.equal(h.controller.counts.missing, 1);
});
test('saving another personal field does not conflict, but concurrent edits to the same answer do', () => {
  const first = savePersonalField(profile, { label: '年龄', value: '26', expectedValue: '' });
  const second = savePersonalField(first, { label: '作品链接', value: 'https://example.test', expectedValue: '' });
  assert.equal(second.personal.age, '26');
  assert.throws(() => savePersonalField(second, { label: '年龄', value: '27', expectedValue: '' }), /已更新/);
});
test('old global additional and custom answers remain available to new personal definitions', () => {
  const old = { ...profile, additionalFacts: [{ id: 'city', meaningId: 'old-city', label: '期望城市', subject: 'self', value: '杭州', valueType: 'text' as const, updatedAt: 'now' }], customInformation: [{ id: 'lang', name: '语言能力', content: '英语' }] };
  const facts = createProfileSnapshot(old).facts;
  assert.equal(facts.find(fact => fact.meaningId === 'personal.preferredCities')?.value, '杭州');
  assert.equal(facts.find(fact => fact.meaningId === 'personal.languageSkills')?.value, '英语');
});
test('personal supplementation survives backup round trips and rejects invalid nested data', () => {
  const updated = savePersonalField(savePersonalField(profile, { label: '年龄', value: '26' }), { label: '其他作品', value: '地址' });
  const document = createBackupDocument({ userProfile: updated, settings: null, llmConfig: null }, '1.3.1');
  const restored = parseAndValidateBackup(serializeBackup(document));
  assert(restored.success);
  assert.equal(restored.document.data.userProfile?.personal.age, '26');
  assert.equal(restored.document.data.userProfile?.personal.additionalFields?.[0].value, '地址');
  (document.data.userProfile!.personal as any).additionalFields = [{ value: 123 }];
  assert.equal(parseAndValidateBackup(JSON.stringify(document)).success, false);
});
test('task panel has no persistent website meaning action and exposes personal saving', () => {
  const panel = readFileSync(new URL('../content/fillTaskPanel.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(panel, /记住本网站|SAVE_MEANING_CORRECTION/);
  assert.match(panel, /SAVE_PERSONAL_FIELD/);
  const entry = readFileSync(new URL('../content/index.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(entry, /SAVE_CONTROL_EXPERIENCES/);
});
test('updated or explicitly cleared personal values supersede legacy aliases', () => {
  const old = { ...profile, personal: { ...profile.personal, preferredCities: '上海' }, customInformation: [{ id: 'old', name: '期望城市', content: '杭州' }] };
  assert(!createProfileSnapshot(old).facts.some(fact => fact.value === '杭州'));
  const cleared = { ...old, personal: { ...old.personal, preferredCities: '' } };
  assert(!createProfileSnapshot(cleared).facts.some(fact => fact.meaningId === 'personal.preferredCities' || fact.value === '杭州'));
});
test('task panel implements refill experience design with two-section list, single editor, batch supplement and mini bar', () => {
  const panel = readFileSync(new URL('../content/fillTaskPanel.ts', import.meta.url), 'utf8');
  assert.match(panel, /网页待处理/);
  assert.match(panel, /可补充资料/);
  assert.match(panel, /一起补充/);
  assert.match(panel, /去处理/);
  assert.match(panel, /补全日期/);
  assert.match(panel, /两处都用/);
  assert.match(panel, /当前网页/);
  assert.match(panel, /个人资料/);
  assert.match(panel, /保存并填入/);
  assert.match(panel, /去网页选择/);
  assert.match(panel, /我已选好，检查/);
  assert.match(panel, /撤销这次资料更新/);
  assert.match(panel, /撤销本次填写/);
  assert.match(panel, /集中完善个人资料/);
  assert.match(panel, /SAVE_PERSONAL_FIELD/);
  assert.match(panel, /SAVE_ADDITIONAL_FACT/);
});
