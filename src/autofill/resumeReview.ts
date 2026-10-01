import { PERSONAL_EXTRA_FIELDS } from '../shared/personalFields.ts';
import { getProfileRecords, PROFILE_RECORD_COLLECTIONS, PROFILE_RECORD_SECTIONS } from '../shared/profileCollections.ts';
import type { ParsedResumeData, UserProfile, PersonalInfo } from '../shared/types.ts';
import { createResumeProfileSnapshot } from '../shared/resumes.ts';
import { versionOf } from './contracts.ts';

export const REVIEW_PERSONAL_FIELDS: { key: keyof PersonalInfo; label: string; type?: string }[] = [
  { key: 'name', label: '姓名', type: 'text' }, { key: 'phone', label: '手机号码', type: 'tel' },
  { key: 'email', label: '邮箱', type: 'email' }, { key: 'gender', label: '性别' },
  { key: 'birthDate', label: '出生日期' }, { key: 'wechat', label: '微信号' },
  { key: 'currentAddress', label: '现居地' },
  ...PERSONAL_EXTRA_FIELDS.map(({ key, label }) => ({ key, label, ...(key.endsWith('Url') ? { type: 'url' } : {}) })),
  { key: 'politicalStatus', label: '政治面貌' }, { key: 'ethnicity', label: '民族' },
  { key: 'hometown', label: '籍贯' }, { key: 'idCard', label: '身份证号' },
  { key: 'selfEvaluation', label: '自我评价' },
];
const clean = (value: unknown) => typeof value === 'string' ? value.trim() : '';
export function createPrefilledReview(base: UserProfile, parsed: ParsedResumeData): UserProfile {
  const source = createResumeProfileSnapshot(parsed);
  const result = structuredClone(base);
  for (const { key } of REVIEW_PERSONAL_FIELDS) {
    const incoming = clean(source.personal[key]);
    if (incoming && !clean(result.personal[key])) Object.assign(result.personal, { [key]: incoming });
  }
  for (const collection of PROFILE_RECORD_COLLECTIONS) {
    const rows = getProfileRecords(result, collection);
    if (!getProfileRecords(source, collection).length) continue;
    Object.assign(result, { [collection]: rows });
    for (const incoming of getProfileRecords(source, collection)) {
      const keys = PROFILE_RECORD_SECTIONS[collection].identity;
      const hasIdentity = keys.every(key => clean(incoming[key]));
      const exact = rows.filter(row => Object.keys(PROFILE_RECORD_SECTIONS[collection].fields).every(key => clean(row[key]) === clean(incoming[key])));
      const matches = exact.length ? exact : hasIdentity ? rows.filter(row => keys.every(key => clean(row[key]) === clean(incoming[key]))) : [];
      if (matches.length === 1) {
        for (const [key, value] of Object.entries(incoming)) if (key !== 'id' && clean(value) && !clean(matches[0][key])) matches[0][key] = value;
      } else if (Object.entries(incoming).some(([key, value]) => key !== 'id' && clean(value))) {
        rows.push({ ...incoming, id: `import-${collection}-${crypto.randomUUID()}` });
      }
    }
  }
  result.skills = [...new Set([...base.skills, ...source.skills].filter(Boolean))];
  return result;
}
/** Save only reviewed changes; preserve new attachments and unrelated concurrent edits. */
export function mergeReviewedProfile(base: UserProfile, draft: UserProfile, latest: UserProfile): UserProfile {
  const result = structuredClone(latest);
  for (const { key, label } of REVIEW_PERSONAL_FIELDS) {
    if (versionOf(base.personal[key] || '') === versionOf(draft.personal[key] || '')) continue;
    if (versionOf(base.personal[key] || '') !== versionOf(latest.personal[key] || '')) throw new Error(`${label}已在其他页面更新，请重新核对后保存。`);
    Object.assign(result.personal, { [key]: draft.personal[key] || '' });
  }
  for (const collection of [...PROFILE_RECORD_COLLECTIONS, 'skills'] as const) {
    if (versionOf(base[collection] || []) === versionOf(draft[collection] || [])) continue;
    if (versionOf(base[collection] || []) !== versionOf(latest[collection] || [])) throw new Error('此类资料已在其他页面更新，请重新核对后保存。');
    Object.assign(result, { [collection]: structuredClone(draft[collection]) });
  }
  return result;
}
export function getReviewWarnings(draft: UserProfile): string[] {
  const warnings: string[] = [];
  if (draft.personal.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(draft.personal.email)) warnings.push('邮箱格式可能识别有误，请核对。');
  if (draft.personal.phone && !/^\+?[\d\s()-]{6,25}$/.test(draft.personal.phone)) warnings.push('手机号码包含不常见字符，请核对。');
  return warnings;
}
