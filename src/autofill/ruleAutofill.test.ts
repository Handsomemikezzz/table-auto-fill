import { getPersonalAdditionalFields, matchSupplementDefinition } from '../shared/personalFields.ts';
import { createBackupDocument, parseAndValidateBackup, serializeBackup } from '../shared/backup.ts';
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { createProfileSnapshot, savePersonalField } from './profileSnapshot.ts';
import { createFieldRegistry, registryVersion } from './fieldRegistry.ts';
import { validateDecision, validateModule } from './decisionValidation.ts';
import { buildRuleDecisions, profileForRuleBinding } from './ruleDecisions.ts';
import { FillSessionController } from './fillSessionController.ts';
import { createPrefilledReview, mergeReviewedProfile } from './resumeReview.ts';
import { normalizeUserProfile } from '../shared/storage.ts';
import type { UserProfile } from '../shared/types.ts';
import type { FieldObservation, FieldDecision, DecisionRequest, FillContextData } from './contracts.ts';

const profile: UserProfile = { personal: { name: '小王', gender: '', birthDate: '', phone: '00138', email: '' }, education: [{ id: 'edu1', school: '安徽大学', degree: '本科', major: '', startDate: '2018-09', endDate: '2022-06' }, { id: 'edu2', school: '乙大学', degree: '硕士', major: '', startDate: '2022-09', endDate: '2025-06' }], experience: [], projects: [], certifications: [], skills: [], customInformation: [] };
const registry = createFieldRegistry();
const snapshot = createProfileSnapshot(profile);
const context: FillContextData = { sessionId: 'session1', profile: snapshot, registry, registryVersion: registryVersion(registry) };
function field(id = 'name', overrides: Partial<FieldObservation> = {}): FieldObservation { return { fieldId: id, snapshotVersion: 'v1', frameId: '0', groupId: 'g1', groupLabel: '基本资料', signature: id, label: '姓名', context: '', kind: 'text', required: false, currentValue: '', disabled: false, options: [], optionsState: 'complete', ruleBinding: { meaningId: 'personal.name', confidence: 1 }, ...overrides }; }
function decision(target = field(), meaning = 'personal.name', recordId?: string, overrides: Partial<FieldDecision> = {}): FieldDecision {
  const fact = snapshot.facts.find(fact => fact.meaningId === meaning && fact.recordId === recordId)!;
  return { fieldId: target.fieldId, snapshotVersion: target.snapshotVersion, decisionId: 'd1', meaningId: meaning, subject: fact.subject, recordId, factId: fact.id, nextAction: 'write', profileVersion: snapshot.version, registryVersion: context.registryVersion, ...overrides };
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
  const variant = { id: 'r1', category: '岗位', fileName: 'r.pdf', fileHash: 'mock-hash', fileType: 'pdf', uploadDate: 'now', parsedProfile: { personal: {}, education: [{ ...profile.education[0], school: '其他学校', id: 'other', college: '' }], experience: [], projects: [], skills: [] } };
  const selected = createProfileSnapshot({ ...profile, education: [{ ...profile.education[0], college: '已确认学院' }], resumes: [variant] }, 'r1');
  assert(!selected.facts.some(fact => fact.value === '已确认学院'));
  assert.equal(selected.facts.find(fact => fact.meaningId === 'personal.name')?.value, '小王');
});
test('conflicting record blocks only its own facts', () => {
  const conflict = createProfileSnapshot({ ...profile, education: [{ ...profile.education[0], startDate: '2024-01' }, profile.education[1]] });
  assert(conflict.facts.filter(fact => fact.recordId === 'edu1').every(fact => fact.conflict));
  assert(conflict.facts.filter(fact => fact.recordId === 'edu2').every(fact => !fact.conflict));
});
test('new additional fact extends registry without enums or switches', () => {
  const additional = { id: 'available', meaningId: 'availability.earliestStartDate', label: '最早到岗日期', subject: 'self', value: '2026-10-12', valueType: 'date' as const, updatedAt: '2026-09-29' };
  const expanded = createFieldRegistry([additional]);
  assert(expanded.some(def => def.id === additional.meaningId));
  assert.equal(createProfileSnapshot({ ...profile, additionalFacts: [additional] }, 'default', expanded).facts.find(fact => fact.meaningId === additional.meaningId)?.value, additional.value);
  assert(registry.find(def => def.id === 'personal.name')?.aliases.includes('姓名'));
});
test('validator rejects invented facts, subjects, records and stale versions', () => {
  for (const patch of [{ factId: 'invented' }, { subject: 'emergencyContact' }, { recordId: 'edu1' }, { profileVersion: 'old' }, { snapshotVersion: 'old' }, { registryVersion: 'old' }]) assert(validateDecision(decision(field(), 'personal.name', undefined, patch), field(), request()).error);
});
test('provider selects real option identities even for expressions absent from string aliases', () => {
  const target = field('degree', { kind: 'select', options: [{ id: 'option8', label: '大学本科毕业', rawValue: 987 }] });
  const choice = decision(target, 'education.degree', 'edu1', { targetOptionIds: ['option8'] });
  assert(!validateDecision(choice, target, request([target])).error);
  assert(validateDecision({ ...choice, targetOptionIds: ['not-real'] }, target, request([target])).error);
});
test('mixed records invalidate the entire module before any writes', () => {
  const fields = [field('school'), field('degree')];
  const errors = validateModule([decision(fields[0], 'education.school', 'edu1'), decision(fields[1], 'education.degree', 'edu2')], request(fields));
  assert.equal(errors.size, 2);
});
test('duplicate decisions cannot execute', () => {
  assert(validateModule([decision(), decision()], request()).has('name'));
});
function harness(fields: FieldObservation[] = [field()]) {
  const writes: string[] = [];
  let observations = fields;
  const ports = {
    observe: () => observations,
    execute: async (target: FieldObservation, _decision: FieldDecision, value: string) => {
      if (target.currentValue) return { status: 'skipped-existing' as const, reason: 'preserved' };
      writes.push(target.fieldId + ':' + value); return { status: 'verified' as const, reason: 'ok' };
    },
    verify: async () => ({ status: 'verified' as const, reason: 'ok' }),
    cancel: () => {}, update: () => {},
  };
  const controller = new FillSessionController(structuredClone(context), ports);
  return { controller, ports, writes, observe: (fields: FieldObservation[]) => { observations = fields; } };
}
test('manual completion, skips and existing inputs are never automatic completions', async () => {
  const h = harness(); await h.controller.run(); await h.controller.manual(h.controller.items[0], '用户值');
  assert.equal(h.controller.counts.verified, 0); assert.equal(h.controller.counts.assisted, 1);
  h.controller.skip(h.controller.items[0]); assert.equal(h.controller.counts.skipped, 1);
});
test('resume import requires explicit choices and preserves confirmed facts by default', () => {
  const draft = createPrefilledReview(profile, { personal: { name: '解析姓名', email: 'new@example.test' }, rawText: '' });
  assert.equal(draft.personal.name, profile.personal.name); assert.equal(draft.personal.email, 'new@example.test');
  draft.personal.name = '解析姓名';
  assert.throws(() => mergeReviewedProfile(profile, draft, { ...profile, personal: { ...profile.personal, name: 'new edit' } }), /已在其他页面更新/);

});
test('entry points share the controller and do not inject generated answers', () => {
  const entry = readFileSync(new URL('../content/index.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(entry, /\.fillForm\(|prepareDynamicSections\(|injectAIButtons\(|GENERATE_ANSWER|AI_FILL_SECTION/);
  assert.match(entry, /FillSessionController/);
});

test('date option cannot add invented day precision', () => {
  const target = field('graduation', { kind: 'select', options: [{ id: 'day', label: '2022-06-01' }] });
  const choice = decision(target, 'education.endDate', 'edu1', { targetOptionIds: ['day'] });
  assert.match(validateDecision(choice, target, request([target])).error || '', /日期精度/);
});
test('disabled and unsupported fields are counted as incomplete', async () => {
  const h = harness([field('unavailable', { kind: 'unsupported', disabled: true })]);
  await h.controller.run(); assert.equal(h.writes.length, 0); assert.equal(h.controller.counts.todo, 1);
});
test('user-confirmed meaning remains a constraint on rule writes', () => {
  const req = request();
  req.corrections.push({ id: 'correction', origin: 'https://example.test', signature: 'name', profileVersion: snapshot.version, registryVersion: context.registryVersion, meaningId: 'personal.phone', confirmedAt: 'now', enabled: true });
  assert.match(validateDecision(decision(), field(), req).error || '', /用户确认/);
  req.corrections[0].profileVersion = 'old';
  assert(!validateDecision(decision(), field(), req).error);
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
test('rules do not invent facts, use low-confidence matches, or ignore corrections', () => {
  const target = field('name', { ruleBinding: { meaningId: 'personal.name', confidence: 0.6 } });
  assert.equal(buildRuleDecisions([target], context).length, 0);
  target.ruleBinding!.confidence = 0.98;
  const correction = { id: 'c', origin: 'https://site.test', signature: target.signature, meaningId: 'personal.phone', enabled: true, confirmedAt: 'now', profileVersion: context.profile.version, registryVersion: context.registryVersion };
  assert.equal(buildRuleDecisions([target], context, [correction])[0]?.meaningId, 'personal.phone');
  assert.equal(profileForRuleBinding(snapshot).education[1].school, '乙大学');
});
test('resolved option matching cannot switch facts or records', () => {
  const target = field('school', { kind: 'select', options: [{ id: 'school-option', label: '安徽大学' }],
    resolvedBinding: { meaningId: 'education.school', subject: 'self', recordId: 'edu1', factId: snapshot.facts.find(fact => fact.meaningId === 'education.school' && fact.recordId === 'edu1')!.id } });
  assert(validateDecision(decision(target, 'education.school', 'edu2', { targetOptionIds: ['school-option'] }), target, request([target])).error);
});
test('fixed reference dates make expired-fact evaluation reproducible', () => {
  const timed = { ...profile, personal: { ...profile.personal, additionalFields: [{ id: 'availability', meaningId: 'personal.extra.availability', subject: 'self', label: '到岗日期', value: '2026-10-12', valueType: 'date' as const, updatedAt: '2026-09-01', expiresAt: '2026-10-01' }] } };
  assert(!createProfileSnapshot(timed, 'default', undefined, '2026-09-30').facts.find(fact => fact.id === 'personal-extra:availability')?.conflict);
  assert(createProfileSnapshot(timed, 'default', undefined, '2026-10-02').facts.find(fact => fact.id === 'personal-extra:availability')?.conflict);
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
  const document = createBackupDocument({ userProfile: updated, settings: null }, '1.3.1');
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


test('unknown fields stay manual while known fields fill without external decisions', async () => {
  const h = harness([field('known'), field('unknown', { ruleBinding: undefined })]);
  await h.controller.run();
  assert.deepEqual(h.writes, ['known:小王']);
  assert.equal(h.controller.counts.verified, 1); assert.equal(h.controller.counts.todo, 1);
  assert.match(h.controller.items[1].reason, /规则无法确定/);
});

test('known missing facts remain blank and separate from unresolved meanings', async () => {
  const h = harness([field('email', { ruleBinding: { meaningId: 'personal.email', confidence: 1 } })]);
  await h.controller.run(); assert.equal(h.writes.length, 0);
  assert.equal(h.controller.counts.missing, 1); assert.equal(h.controller.counts.todo, 0);
});

test('explicit confirmation resolves an unknown meaning locally', async () => {
  const h = harness([field('answer', { ruleBinding: undefined })]);
  await h.controller.run(); assert.equal(h.controller.counts.todo, 1);
  await h.controller.confirmMeaning(h.controller.items[0], { id: 'c1', origin: '', signature: 'answer',
    profileVersion: snapshot.version, registryVersion: context.registryVersion, meaningId: 'personal.phone', confirmedAt: 'now', enabled: true });
  assert.deepEqual(h.writes, ['answer:00138']); assert.equal(h.controller.counts.verified, 1);
});

test('rule failure in one module does not stop another module', async () => {
  const h = harness([field('failed', { groupId: 'g1' }), field('works', { groupId: 'g2' })]);
  const execute = h.ports.execute;
  h.ports.execute = async (...args) => { if (args[0].fieldId === 'failed') throw new Error('unsupported site control'); return execute(...args); };
  await h.controller.run(); assert.deepEqual(h.writes, ['works:小王']);
  assert.equal(h.controller.counts.todo, 1); assert.equal(h.controller.counts.verified, 1);
});

test('new DOM fields revealed by a write are filled by rules', async () => {
  const h = harness(); const execute = h.ports.execute;
  h.ports.execute = async (...args) => { const result = await execute(...args); h.observe([field(), field('new')]); return result; };
  await h.controller.run(); assert.deepEqual(h.writes, ['name:小王', 'new:小王']);
});

test('unchanged control failures are attempted once and remain actionable', async () => {
  const h = harness(); let attempts = 0;
  h.ports.execute = async () => { attempts++; return { status: 'needs-mapping', reason: '请选择真实选项' } as any; };
  await h.controller.run(); assert.equal(attempts, 1); assert.equal(h.controller.counts.todo, 1);
});

test('stale DOM fields are reobserved before a bounded rule retry', async () => {
  const h = harness(); let attempts = 0;
  const execute = h.ports.execute;
  h.ports.execute = async (...args) => { attempts++; if (attempts === 1) { h.observe([field('name', { snapshotVersion: 'v2' })]); return { status: 'stale', reason: 'replaced' } as any; } return execute(...args); };
  await h.controller.run(); assert.equal(attempts, 2); assert.equal(h.controller.counts.verified, 1);
});

test('stop during DOM execution prevents later fields from being written', async () => {
  const h = harness([field('first'), field('second')]);
  const execute = h.ports.execute;
  h.ports.execute = async (...args) => { const result = await execute(...args); h.controller.stop(); return result; };
  await h.controller.run(); assert.deepEqual(h.writes, ['first:小王']); assert.equal(h.controller.phase, 'stopped');
});
