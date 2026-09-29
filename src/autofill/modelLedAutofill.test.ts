import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { createProfileSnapshot } from './profileSnapshot.ts';
import { createFieldRegistry, registryVersion, meaningCandidates } from './fieldRegistry.ts';
import { validateDecision, validateModule } from './decisionValidation.ts';
import { FillSessionController } from './fillSessionController.ts';
import { LLMDecisionProvider } from './decisionProvider.ts';
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
test('every known and unknown field reaches the model before executing', async () => {
  const h = harness([field('known'), field('unknown', { candidates: ['unknown'] })]);
  await h.controller.run(); assert.deepEqual(h.calls, [['known', 'unknown']]); assert.equal(h.writes.length, 2); assert.equal(h.controller.counts.verified, 2);
});
test('model outage produces todos, never rule or cache writes', async () => {
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
test('production entry points have no rule filling or generated answer injections', () => {
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
  await h.controller.run(); assert.equal(h.controller.counts.verified, 0); assert.equal(h.controller.counts.todo, 2);
});
test('preserved conflicting upstream values do not satisfy a planned dependency', async () => {
  const h = harness([field('upstream', { currentValue: '用户值' }), field('child')]);
  h.ports.decide = async fields => fields.map(target => decision(target, 'personal.name', undefined, { dependencyIds: target.fieldId === 'child' ? ['upstream'] : [] }));
  h.ports.execute = async target => { h.writes.push(target.fieldId); return { status: 'skipped-existing', reason: '保留' } as any; };
  await h.controller.run(); assert.deepEqual(h.writes, ['upstream']); assert.equal(h.controller.counts.existing, 1); assert.equal(h.controller.counts.todo, 1);
});
