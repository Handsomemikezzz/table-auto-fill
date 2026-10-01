import type { ParsedResumeData } from '../shared/types.ts';
import { PERSONAL_EXTRA_FIELDS } from '../shared/personalFields.ts';
import { PROFILE_RECORD_SECTIONS, PROFILE_RECORD_COLLECTIONS } from '../shared/profileCollections.ts';
const personalKeys = ['name', 'gender', 'birthDate', 'phone', 'email', 'wechat', 'idCard', 'politicalStatus', 'ethnicity', 'hometown', 'currentAddress', 'selfEvaluation', ...PERSONAL_EXTRA_FIELDS.map(field => field.key)];
const recordKeys = Object.fromEntries(PROFILE_RECORD_COLLECTIONS.map(collection => [collection, Object.keys(PROFILE_RECORD_SECTIONS[collection].fields)]));
const object = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
function strings(value: unknown, keys: string[]) {
  const source = object(value);
  return Object.fromEntries(keys.flatMap(key => typeof source[key] === 'string' ? [[key, (source[key] as string).trim().slice(0, 12_000)]] : []));
}
/** Constrain model output to the editable resume schema; model-supplied IDs are ignored. */
export function normalizeParsedResume(value: unknown, rawText: string): ParsedResumeData {
  const source = object(value);
  if (!source.personal && !PROFILE_RECORD_COLLECTIONS.some(collection => Array.isArray(source[collection]))) throw new Error('AI 返回的内容不是简历资料，请重试');
  const result = { personal: strings(source.personal, personalKeys), rawText, skills: Array.isArray(source.skills) ? source.skills.filter((skill): skill is string => typeof skill === 'string' && Boolean(skill.trim())).slice(0, 100).map(skill => skill.trim()) : [] } as ParsedResumeData;
  for (const [collection, keys] of Object.entries(recordKeys)) {
    const records = Array.isArray(source[collection]) ? source[collection] as unknown[] : [];
    Object.assign(result, { [collection]: records.slice(0, 50).map(value => ({ ...strings(value, keys), id: `${collection}-${crypto.randomUUID()}` })).filter(record => Object.keys(record).length > 1) });
  }
  return result;
}
