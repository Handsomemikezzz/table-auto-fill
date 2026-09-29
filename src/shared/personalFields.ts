import type { UserProfile } from './types.ts';
import type { AdditionalFact, FieldDefinition } from '../autofill/contracts.ts';

export const PERSONAL_EXTRA_FIELDS = [
  { key: 'age', label: '年龄', aliases: ['年龄', '年龄（周岁）', '周岁', 'age'] },
  { key: 'portfolioUrl', label: '作品链接', aliases: ['作品链接', '作品集链接', '个人作品链接', '作品集', '个人主页', 'portfolio', 'portfolio url', 'portfolioUrl', 'website'] },
  { key: 'preferredCities', label: '期望城市', aliases: ['期望城市', '期望工作城市', '期望工作地点', '意向城市', '意向工作城市', '求职意向城市', 'preferred cities', 'preferred city', 'preferredCities', 'desired location'] },
  { key: 'languageSkills', label: '语言能力', aliases: ['语言能力', '外语能力', '外语水平', '语言水平', 'language skills', 'languageSkills', 'language proficiency', 'languages'] },
] as const;

export function normalizePersonalFieldLabel(label: string): string {
  return label.normalize('NFKC').toLowerCase().replace(/\((?:选填|必填|可多选|多选|单选|岁|周岁)\)/g, '').replace(/^[\s*＊]+|[\s*＊:：]+$/g, '').replace(/\s+/g, '');
}
/** New personal fields are authoritative; older backups keep working without site-rule migration. */
export function getPersonalAdditionalFields(profile: Pick<UserProfile, 'personal' | 'additionalFacts'>): AdditionalFact[] {
  return profile.personal?.additionalFields ?? profile.additionalFacts ?? [];
}
export function matchSupplementDefinition(label: string, registry: FieldDefinition[]): FieldDefinition | undefined {
  const normalized = normalizePersonalFieldLabel(label);
  if (!normalized) return undefined;
  const matches = registry.filter(def => (
    PERSONAL_EXTRA_FIELDS.some(field => def.id === `personal.${field.key}`)
    || def.scope === 'user'
  ) && [def.label, ...def.aliases].some(alias => normalizePersonalFieldLabel(alias) === normalized));
  const builtin = matches.filter(def => def.scope === 'builtin');
  return builtin.length === 1 ? builtin[0] : matches.length === 1 ? matches[0] : undefined;
}

/** Read existing global answers as well as first-class personal properties. */
export function getPersonalFieldValue(profile: UserProfile, definition: FieldDefinition): string {
  const direct = profile.personal[definition.key as keyof UserProfile['personal']];
  if (typeof direct === 'string') return direct.trim();
  const aliases = new Set([definition.label, ...definition.aliases].map(normalizePersonalFieldLabel));
  const matches = [
    ...getPersonalAdditionalFields(profile).filter(field => field.subject === 'self' && !field.recordId && aliases.has(normalizePersonalFieldLabel(field.label)) && (!field.expiresAt || field.expiresAt >= new Date().toISOString().slice(0, 10))).map(field => field.value.trim()),
    ...(profile.customInformation || []).filter(field => aliases.has(normalizePersonalFieldLabel(field.name))).map(field => field.content.trim()),
  ].filter(Boolean);
  const values = [...new Set(matches)];
  return values.length === 1 ? values[0] : '';
}
