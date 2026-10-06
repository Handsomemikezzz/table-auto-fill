import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { recoverResumePublications } from '../parsers/researchPublications.ts';
import { createPrefilledReview, mergeReviewedProfile, getReviewWarnings } from './resumeReview.ts';
import { normalizeParsedResume } from '../parsers/resumeStructure.ts';
import { needsPageOCR } from '../parsers/resumeExtraction.ts';
import type { ParsedResumeData, UserProfile } from '../shared/types.ts';
import { SUPPLEMENTAL_COLLECTIONS } from '../shared/profileCollections.ts';
import { createResumeProfileSnapshot, buildProfileForResume } from '../shared/resumes.ts';
import { createProfileSnapshot } from './profileSnapshot.ts';
import { createBackupDocument, serializeBackup, parseAndValidateBackup } from '../shared/backup.ts';
import { parseResumeJSON } from '../parsers/jsonParser.ts';
import { NLPHelper } from '../utils/nlpHelper.ts';
const empty: UserProfile = { personal: { name: '', gender: '', birthDate: '', phone: '', email: '' }, education: [], experience: [], projects: [], skills: [], certifications: [], customInformation: [] };
test('prefills empty facts without replacing confirmed identity or inferring missing facts', () => {
  const base = { ...empty, personal: { ...empty.personal, name: '已确认姓名' } };
  const result = createPrefilledReview(base, { personal: { name: '识别姓名', phone: '00138' }, education: [{ school: '测试大学', degree: '本科', startDate: '2018-09', endDate: '2022-06' }], rawText: '' });
  assert.equal(result.personal.name, base.personal.name); assert.equal(result.personal.phone, '00138');
  assert.equal(result.education[0].academicDegree, ''); assert.equal(base.education.length, 0);
});
test('imports matching records by identity, fills gaps and preserves conflicting existing fields', () => {
  const base = { ...empty, education: [{ id: 'stable', school: '甲大学', degree: '本科', major: '已确认专业', startDate: '2018-09', endDate: '' }] };
  const result = createPrefilledReview(base, { education: [{ school: '甲大学', degree: '本科', major: '识别专业', startDate: '2018-09', endDate: '2022-06' }, { school: '乙大学', degree: '硕士', startDate: '2022-09' }], rawText: '' });
  assert.equal(result.education.length, 2); assert.equal(result.education[0].id, 'stable'); assert.equal(result.education[0].major, '已确认专业');
  assert.equal(result.education[0].endDate, '2022-06'); assert.notEqual(result.education[1].id, 'stable');
});
test('review save preserves uploaded files and unrelated concurrent facts, rejects overlapping changes', () => {
  const draft = createPrefilledReview(empty, { personal: { phone: '13800138000' }, rawText: '' });
  const latest = { ...empty, personal: { ...empty.personal, email: 'new@example.com' }, resumes: [{ id: 'file', category: '', fileName: 'r.pdf', fileData: 'data:', fileType: 'pdf', uploadDate: '2026-10-01' }] };
  const result = mergeReviewedProfile(empty, draft, latest);
  assert.equal(result.personal.email, latest.personal.email); assert.equal(result.resumes?.length, 1);
  assert.throws(() => mergeReviewedProfile(empty, draft, { ...latest, personal: { ...latest.personal, phone: 'another' } }), /其他页面更新/);
});
test('structured input is constrained to editable text fields and cannot supply record IDs', () => {
  const result = normalizeParsedResume({ personal: { name: ' 示例 ', phone: { malicious: true }, age: '23', portfolioUrl: 'https://example.com', admin: 'ignore' }, education: [{ id: 'existing-user-id', school: '甲大学', degree: '本科' }], skills: ['React', 123] }, '原文');
  assert.equal(result.personal?.name, '示例'); assert.equal(result.personal?.phone, undefined);
  assert.equal((result.personal as Record<string, unknown>).admin, undefined); assert.notEqual(result.education?.[0].id, 'existing-user-id');
  assert.deepEqual(result.skills, ['React']);
});
test('image-only or partial text pages use OCR, native text stays on the fast path', () => {
  assert(needsPageOCR('')); assert(needsPageOCR('简历 姓名 电话', true));
  assert(!needsPageOCR('完整文字简历姓名联系方式教育学校专业工作项目技能'.repeat(12)));
  assert(needsPageOCR('�'.repeat(8) + '完整文字'.repeat(50)));
});
test('OCR-like contact mistakes request review without manufacturing replacements', () => {
  assert.equal(getReviewWarnings({ ...empty, personal: { ...empty.personal, phone: '138O0138OOO', email: 'example@invalid' } }).length, 2);
});

const richResume: ParsedResumeData = {
  personal: { name: '张三', languageSkills: '英语 CET-6 580', desiredPosition: '研究工程师' }, rawText: '测试原文',
  awards: [{ name: '国家奖学金', date: '2023', issuer: '教育部', level: '国家级' }],
  publications: [{ title: '示例论文', authors: '李四、张三（第二作者）', venue: '示例会议', status: '已录用', date: '2024', doi: '10.1234/example' }],
  languages: [{ language: '英语', test: 'CET-6', score: '580', date: '2023-06' }, { language: '英语', test: 'IELTS', score: '7.5' }],
  certifications: [{ name: '教师资格证', issuer: '教育局', date: '2024', credentialId: '00123', expiryDate: '2029' }],
  patents: [{ name: '示例专利', inventors: '张三、李四', patentNumber: 'CN001', status: '申请中' }],
  activities: [{ organization: '志愿者协会', role: '志愿者', startDate: '2022', description: '社区服务' }],
  additionalInfo: [{ name: '驾照', content: 'C1' }],
};
test('rich facts survive parsing, review, backup and selected-resume fact snapshots', () => {
  const parsed = normalizeParsedResume(richResume, richResume.rawText);
  const reviewed = mergeReviewedProfile(empty, createPrefilledReview(empty, parsed), empty);
  const snapshot = createResumeProfileSnapshot({ ...reviewed, rawText: richResume.rawText });
  const profile = { ...reviewed, resumes: [{ id: 'rich', category: '研究岗位', fileName: 'rich.pdf', fileData: 'data:application/pdf;base64,QQ==', fileType: 'pdf', uploadDate: '2026-10-01', parsedProfile: snapshot }] };
  const backup = parseAndValidateBackup(serializeBackup(createBackupDocument({ userProfile: profile, settings: null }, 'test')));
  assert(backup.success);
  const restored = backup.document.data.userProfile!;
  for (const collection of SUPPLEMENTAL_COLLECTIONS) {
    assert.deepEqual(restored[collection], reviewed[collection]);
    assert.deepEqual(restored.resumes![0].parsedProfile![collection], reviewed[collection]);
  }
  const facts = createProfileSnapshot(restored, 'rich').facts;
  assert(facts.some(fact => fact.meaningId === 'languages.score' && fact.value === '580'));
  assert(facts.some(fact => fact.meaningId === 'publications.status' && fact.value === '已录用'));
  assert(facts.some(fact => fact.meaningId === 'certifications.credentialId' && fact.value === '00123'));
  assert(!facts.some(fact => fact.meaningId === 'languages.proficiency'));
  assert.equal(buildProfileForResume(restored, 'rich').patents![0].status, '申请中');
});
test('re-import deduplicates exact optional facts with missing dates and keeps distinct exams', () => {
  const first = createPrefilledReview(empty, richResume);
  const second = createPrefilledReview(first, richResume);
  for (const collection of SUPPLEMENTAL_COLLECTIONS) assert.deepEqual(second[collection], first[collection]);
  assert.equal(second.languages?.length, 2);
  const current = { ...first, awards: [{ ...first.awards![0], description: '已确认说明' }] };
  const result = createPrefilledReview(current, { awards: [{ ...richResume.awards![0], description: '识别说明', ranking: '一等奖' }], rawText: '' });
  assert.equal(result.awards?.length, 1); assert.equal(result.awards![0].description, '已确认说明'); assert.equal(result.awards![0].ranking, '一等奖');
});
test('optional-fact saves preserve unrelated concurrent edits and reject same-section conflicts', () => {
  const draft = createPrefilledReview(empty, richResume);
  const latest = { ...empty, activities: [{ id: 'new', organization: '新资料' }] };
  assert.throws(() => mergeReviewedProfile(empty, draft, latest), /其他页面更新/);
  const unrelated = { ...empty, projects: [{ id: 'p', name: '已在其他页面保存', role: '', startDate: '', endDate: '', description: '', achievements: '' }] };
  assert.equal(mergeReviewedProfile(empty, draft, unrelated).projects[0].id, 'p');
  assert.equal(mergeReviewedProfile(empty, draft, empty).publications![0].title, '示例论文');
});
test('backups reject malformed supplemental records in global and resume-specific facts', () => {
  const reviewed = createPrefilledReview(empty, richResume);
  const document = createBackupDocument({ userProfile: reviewed, settings: null }, 'test');
  for (const collection of SUPPLEMENTAL_COLLECTIONS) {
    const bad = structuredClone(document);
    Object.assign(bad.data.userProfile!, { [collection]: [{ id: 'bad', ...Object.fromEntries(Object.keys(reviewed[collection]![0]).filter(key => key !== 'id').map(key => [key, { invalid: true }])) }] });
    assert.equal(parseAndValidateBackup(JSON.stringify(bad)).success, false, collection);
  }
  const badSnapshot = structuredClone(document);
  badSnapshot.data.userProfile!.resumes = [{ id: 'bad', category: '', fileName: 'x', fileType: 'txt', fileData: '', uploadDate: '', parsedProfile: { ...createResumeProfileSnapshot(richResume), languages: [{ id: 'bad', language: 42 }] as never } }];
  assert.equal(parseAndValidateBackup(JSON.stringify(badSnapshot)).success, false);
});
test('canonical and editor JSON imports preserve supplemental and unfamiliar labelled facts', () => {
  assert.equal(parseResumeJSON(JSON.stringify(richResume)).languages![0].score, '580');
  const editor = parseResumeJSON(JSON.stringify({ basic: { name: '张三', customFields: [{ label: '驾照', value: 'C1' }, { label: '国籍', value: '中国' }] }, publications: richResume.publications }));
  assert.equal(editor.publications![0].doi, '10.1234/example');
  assert.equal(editor.personal?.nationality, '中国'); assert.equal(editor.additionalInfo![0].content, 'C1');
});
test('local parsing keeps non-core sections reviewable as verbatim supplemental facts', () => {
  const text = '# 获奖与荣誉\n2023 国家奖学金\n# 语言能力\n英语 CET-6 580\n# 论文与著作\n示例论文，第二作者，已录用\n# 专利\nCN001 申请中';
  const parsed = NLPHelper.parseResumeText(text);
  assert.equal(parsed.additionalInfo?.length, 4);
  assert.equal(parsed.additionalInfo![2].content, '示例论文，第二作者，已录用');
  assert.equal(parsed.publications, undefined);
});
const mixedResearch = readFileSync(new URL('../../tests/resume-fixtures/mixed-research.txt', import.meta.url), 'utf8');
test('mixed Project sections recover Paper/DOI entries and offer ambiguous conference entries for review', () => {
  const parsed = recoverResumePublications(normalizeParsedResume({ projects: [{ name: '所有研究被归为项目' }], publications: [] }, mixedResearch), mixedResearch);
  assert.equal(parsed.publications?.length, 3);
  assert.equal(parsed.publicationCandidates?.length, 3);
  assert.equal(parsed.projects?.[0].name, '所有研究被归为项目');
  assert.equal(parsed.publications![0].title, 'CosmoSonic: Resonating with the Void - A Multimodal Embodied Interaction System Based on Real-Time Cosmological Data Mapping');
  assert(parsed.publications![0].description?.includes('System 2026.09\nBased'));
  assert.equal(parsed.publications![1].title, 'DozeBuddy');
  assert.equal(parsed.publications![1].doi, '10.5555/3721488.3721821');
  assert.equal(parsed.publications![1].authors, '一作');
  assert.equal(parsed.publications![2].authors, '二作');
  for (const row of [...parsed.publications!, ...parsed.publicationCandidates!]) {
    assert.equal(row.date, ''); assert.equal(row.status, '');
    assert(!row.description?.includes('AIGC设计展览'));
  }
  assert(!createPrefilledReview(empty, parsed).publications?.some(row => row.title === 'COSMIC SONIC'));
  assert.equal(parsed.parsingWarnings?.length, 1);
});
test('coverage repair adds missing papers without duplicating existing papers or overriding facts', () => {
  const parsed = recoverResumePublications({ rawText: mixedResearch, publications: [{ id: 'model-id', title: 'CosmoSonic: Resonating with the Void - A Multimodal Embodied Interaction System\nBased on Real-Time Cosmological Data Mapping', authors: '原文已有署名', date: '2026', status: '' }] }, mixedResearch);
  assert.equal(parsed.publications?.length, 3); assert.equal(parsed.publications![0].id, 'model-id');
  assert.equal(parsed.publications![0].authors, '原文已有署名'); assert.equal(parsed.publications![0].date, '2026');
  const twice = recoverResumePublications(parsed, mixedResearch);
  assert.deepEqual(twice, parsed);
});
test('ordinary projects, exhibitions and unnamed nominations cannot silently become publications', () => {
  for (const rawText of [
    '项目研究 Project\n• 2026 ACM SIGGRAPH《作品展示》——AIGC设计展览 二作',
    '项目研究 Project\n• IEEE-HRI《机器人项目》最佳 SDC 提名——交互设计 一作',
    '项目经历\n• 《智能日程》——产品开发与测试 2024.06',
  ]) {
    const parsed = recoverResumePublications({ rawText }, rawText);
    assert.equal(parsed.publications, undefined);
    if (rawText.includes('展览')) assert.equal(parsed.publicationCandidates, undefined);
  }
});
test('only explicit publication dates/statuses are extracted; inline dates in titles are preserved', () => {
  const rawText = '论文与著作\n• 《Analysis of 2024.03 Observations》发表于：2025-06 已录用 二作\n• 项目《普通工具》开发完成';
  const parsed = recoverResumePublications({ rawText }, rawText);
  assert.equal(parsed.publications![0].title, 'Analysis of 2024.03 Observations');
  assert.equal(parsed.publications![0].date, '2025-06'); assert.equal(parsed.publications![0].status, '已录用');
  assert(!parsed.publications![0].description?.includes('普通工具'));
});
test('local parsing recovers academic clues and carries them into facts', () => {
  const parsed = recoverResumePublications(NLPHelper.parseResumeText(mixedResearch), mixedResearch);
  const profile = createPrefilledReview(empty, parsed);
  assert.equal(profile.publications?.length, 3);
  assert(createProfileSnapshot(profile).facts.some(fact => fact.meaningId === 'publications.doi' && fact.value === '10.5555/3721488.3721821'));
});
