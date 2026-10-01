import { PROFILE_RECORD_COLLECTIONS } from '../../shared/profileCollections.ts';
import { PERSONAL_EXTRA_FIELDS } from '../../shared/personalFields.ts';
import type { UserProfile } from '../../shared/types.ts';
import type { ControlOption } from '../../shared/fillModel.ts';
import { resolveOption } from '../../utils/optionResolver.ts';
import { scoreDropdownOption } from '../../utils/dropdownOption.ts';

export interface GroundedField {
  index: number;
  label: string;
  name: string;
  options: string[];
  optionCandidates?: ControlOption[];
  optionsComplete?: boolean;
  blockId?: string;
  semantic?: string;
  recordId?: string;
  recordCollection?: 'education' | 'experience' | 'projects';
}
export interface GroundedMapping { value: string; profilePath: string; optionId?: string }

const PERSONAL_KEYS = new Set(['name', 'gender', 'birthDate', 'phone', 'email', 'wechat', 'idCard', 'politicalStatus', 'ethnicity', 'hometown', 'currentAddress', 'selfEvaluation', ...PERSONAL_EXTRA_FIELDS.map(field => field.key)]);
const RECORD_KEYS: Record<string, [string, string]> = {
  school: ['education', 'school'], college: ['education', 'college'], major: ['education', 'major'],
  majorCategory: ['education', 'majorCategory'], degree: ['education', 'degree'], academicDegree: ['education', 'academicDegree'],
  educationType: ['education', 'educationType'], gpa: ['education', 'gpa'],
  educationStartDate: ['education', 'startDate'], graduationDate: ['education', 'endDate'],
  company: ['experience', 'company'], position: ['experience', 'position'], description: ['experience', 'description'],
  startDate: ['experience', 'startDate'], endDate: ['experience', 'endDate'],
  projectName: ['projects', 'name'], projectRole: ['projects', 'role'], projectStartDate: ['projects', 'startDate'],
  projectEndDate: ['projects', 'endDate'], projectDescription: ['projects', 'description'],
  projectAchievements: ['projects', 'achievements'], projectTechnologies: ['projects', 'technologies'],
};

function matchesKnownSemantic(semantic: string | undefined, path: string): boolean {
  if (!semantic || semantic === 'unknown') return true;
  if (PERSONAL_KEYS.has(semantic)) return path === `personal.${semantic}`;
  const record = RECORD_KEYS[semantic];
  if (!record) return true;
  const parts = path.split('.');
  return parts.length === 3 && parts[0] === record[0] && /^\d+$/.test(parts[1]) && parts[2] === record[1];
}

export function readFact(profile: UserProfile, path: string): unknown {
  const normalized = path.replace(/\[(\d+)\]/g, '.$1');
  if (!new RegExp(`^(?:personal|skills|customInformation|${PROFILE_RECORD_COLLECTIONS.join('|')})\\.[\\w.]+$`).test(normalized)) return undefined;
  const parts = normalized.split('.');
  if (parts.some(part => ['__proto__', 'prototype', 'constructor', 'id', 'fileData'].includes(part))) return undefined;
  let current: unknown = profile;
  for (const part of parts) {
    if (!current || typeof current !== 'object' || !Object.hasOwn(current, part)) return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

/** Validate references and record consistency before any model result reaches DOM. */
export function validateFieldMappings(raw: unknown, fields: GroundedField[], profile: UserProfile): Record<string, GroundedMapping> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const result: Record<string, GroundedMapping> = {};
  const blockRecords = new Map<string, Set<string>>();
  for (const field of fields) {
    const candidate = (raw as Record<string, unknown>)[String(field.index)];
    if (!candidate || typeof candidate !== 'object') continue;
    const entry = candidate as Record<string, unknown>;
    if (typeof entry.profilePath !== 'string') continue;
    const profilePath = entry.profilePath.replace(/\[(\d+)\]/g, '.$1');
    if (!matchesKnownSemantic(field.semantic, profilePath)) continue;
    if (field.recordId && field.recordCollection) {
      const [collection, ordinal] = profilePath.split('.');
      if (collection !== field.recordCollection || !/^\d+$/.test(ordinal)
        || profile[field.recordCollection][Number(ordinal)]?.id !== field.recordId) continue;
    }
    const source = readFact(profile, profilePath);
    if (typeof source !== 'string' && typeof source !== 'number' && typeof source !== 'boolean') continue;
    const desired = String(source).trim();
    if (!desired) continue;
    if (/紧急|家属|监护|emergency|guardian/i.test(`${field.label} ${field.name}`) && profilePath.startsWith('personal.')) continue;
    const value = typeof entry.value === 'string' ? entry.value.trim() : desired;
    if (value !== desired && scoreDropdownOption(desired, value) < 900) continue;
    const options = field.optionCandidates || field.options.map((label, index) => ({ id: `legacy-${index}`, label }));
    let mapping: GroundedMapping = { value: desired, profilePath };
    if (options.length) {
      const resolved = resolveOption({ desired, options, semantic: field.semantic || profilePath.split('.').at(-1), completeness: field.optionsComplete === false ? 'partial' : 'complete' });
      if (resolved.status !== 'matched') continue;
      if (entry.optionId && entry.optionId !== resolved.option.id) continue;
      mapping = { value: resolved.option.label, profilePath, ...(field.optionCandidates ? { optionId: resolved.option.id } : {}) };
    } else if (entry.optionId) continue;
    const record = profilePath.match(new RegExp(`^(${PROFILE_RECORD_COLLECTIONS.join('|')})\\.\\d+`))?.[0];
    if (record && field.blockId) {
      const records = blockRecords.get(field.blockId) || new Set<string>();
      records.add(record);
      blockRecords.set(field.blockId, records);
    }
    result[String(field.index)] = mapping;
  }
  // A model cannot silently combine two records in one logical experience block.
  for (const field of fields) {
    if (field.blockId && (blockRecords.get(field.blockId)?.size || 0) > 1) delete result[String(field.index)];
  }
  return result;
}
