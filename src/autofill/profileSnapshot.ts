import { getPersonalAdditionalFields, getPersonalFieldValue, normalizePersonalFieldLabel, matchSupplementDefinition } from '../shared/personalFields.ts';
import type { UserProfile } from '../shared/types.ts';
import { getResumeLibrary } from '../shared/resumes.ts';
import { parseFlexibleDate } from '../utils/dateValue.ts';
import { createFieldRegistry } from './fieldRegistry.ts';
import { versionOf, type FieldDefinition, type ProfileSnapshot, type ProfileFact } from './contracts.ts';

export function createProfileSnapshot(profile: UserProfile, sourceId = 'default', registry = createFieldRegistry(getPersonalAdditionalFields(profile))): ProfileSnapshot {
  const variant = sourceId === 'default' ? undefined : getResumeLibrary(profile).find(item => item.id === sourceId);
  if (sourceId !== 'default' && !variant?.parsedProfile) throw new Error('所选资料已不存在，请重新选择');
  // One selected source; records from different resumes are never joined by index or school name.
  const source = variant?.parsedProfile || profile;
  const facts: ProfileFact[] = [];
  const sourceLabel = variant ? `${variant.category}｜${variant.fileName}` : '通用资料';
  const add = (def: FieldDefinition, value: unknown, recordId?: string, conflict?: string) => {
    if (typeof value !== 'string' || !value.trim()) return;
    const parsed = def.valueType === 'date' ? parseFlexibleDate(value) : null;
    facts.push({ id: `${sourceId}:${def.id}:${recordId || 'self'}`, meaningId: def.id, subject: def.subject, recordId, value: value.trim(), source: sourceLabel, ...(parsed ? { precision: parsed.day ? 'day' : parsed.month ? 'month' : 'year' } : {}), ...(conflict ? { conflict } : {}) });
  };
  for (const def of registry) {
    if (def.sourceCollection === 'personal') {
      // Confirmed shared identity takes precedence over a file's parsed identity.
      const key = def.key as keyof UserProfile['personal'];
      const sharedValue = key !== 'selfEvaluation' && getPersonalFieldValue(profile, def);
      const before = facts.length;
      add(def, sharedValue || source.personal?.[key]);
      if (variant && sharedValue && facts.length > before) facts.at(-1)!.source = '通用资料（优先使用已保存值）';
    } else if (def.sourceCollection === 'skills') add(def, source.skills.join('、'));
    else if (def.sourceCollection !== 'additionalFacts') {
      const rows = (source as unknown as Record<string, unknown>)[def.sourceCollection];
      if (!Array.isArray(rows)) continue;
      rows.forEach((record: Record<string, string>) => {
        const id = record.id || `${def.sourceCollection}-${versionOf(record)}`;
        const start = parseFlexibleDate(record.startDate || '');
        const end = parseFlexibleDate(record.endDate || '');
        const comparable = (date: NonNullable<typeof start>, end = false) => date.year * 10000 + (date.month || (end ? 12 : 1)) * 100 + (date.day || (end ? 31 : 1));
        const conflict = rows.filter(row => (row.id || `${def.sourceCollection}-${versionOf(row)}`) === id).length > 1 ? '经历 ID 重复，请核对资料'
          : start && end && comparable(start) > comparable(end, true) ? '经历的开始时间晚于结束时间，请核对来源' : undefined;
        add(def, record[def.key], id, conflict);
      });
    }
  }
  for (const fact of getPersonalAdditionalFields(profile)) {
    const canonical = registry.find(def => def.sourceCollection === 'personal' && def.subject === fact.subject && [def.label, ...def.aliases].some(alias => normalizePersonalFieldLabel(alias) === normalizePersonalFieldLabel(fact.label)));
    if (canonical && (typeof profile.personal[canonical.key as keyof UserProfile['personal']] === 'string' || getPersonalFieldValue(profile, canonical))) continue;
    const def = registry.find(def => def.id === fact.meaningId && def.subject === fact.subject);
    if (def) {
      const before = facts.length;
      add(def, fact.value, fact.recordId, fact.expiresAt && fact.expiresAt < new Date().toISOString().slice(0, 10) ? '这条时效性资料已过期，请重新确认' : undefined);
      if (facts.length > before) { facts.at(-1)!.id = `personal-extra:${fact.id}`; facts.at(-1)!.source = `个人资料 · ${fact.updatedAt}`; }
    }
  }
  for (const info of profile.customInformation || []) {
    if (!info.content.trim()) continue;
    const canonical = registry.find(def => def.sourceCollection === 'personal' && [def.label, ...def.aliases].some(alias => normalizePersonalFieldLabel(alias) === normalizePersonalFieldLabel(info.name)));
    if (canonical && (typeof profile.personal[canonical.key as keyof UserProfile['personal']] === 'string' || getPersonalFieldValue(profile, canonical))) continue;
    facts.push({ id: `saved:${info.id}`, meaningId: `saved.${info.id}`, subject: 'self', value: info.content, source: `已保存答案：${info.name}` });
  }
  return { version: versionOf({ sourceId, facts }), sourceId, sourceLabel, facts };
}

/** Only an explicit user save can change a known fact; registry keys constrain the mutation. */
export function saveConfirmedFact(profile: UserProfile, fact: import('./contracts.ts').AdditionalFact): UserProfile {
  const definition = createFieldRegistry(getPersonalAdditionalFields(profile)).find(def => def.id === fact.meaningId && def.subject === fact.subject && def.scope === 'builtin');
  if (!definition) return { ...profile, personal: { ...profile.personal, additionalFields: [...getPersonalAdditionalFields(profile).filter(item => item.id !== fact.id), fact] } };
  if (definition.sourceCollection === 'personal') return { ...profile, personal: { ...profile.personal, [definition.key]: fact.value } };
  const collection = (profile as unknown as Record<string, unknown>)[definition.sourceCollection];
  if (!Array.isArray(collection) || !fact.recordId || !collection.some(record => (record.id || `${definition.sourceCollection}-${versionOf(record)}`) === fact.recordId)) throw new Error('请先确认这条事实所属的经历');
  return { ...profile, [definition.sourceCollection]: collection.map(record => (record.id || `${definition.sourceCollection}-${versionOf(record)}`) === fact.recordId ? { ...record, id: record.id || fact.recordId, [definition.key]: fact.value } : record) };
}


/** Save an explicitly supplied personal answer globally; no domain or form identity is accepted. */
export function savePersonalField(profile: UserProfile, input: { label: string; value: string; valueType?: 'text' | 'date'; expectedValue?: string }): UserProfile {
  const label = input.label.trim().replace(/[＊*：:\s]+$/g, '');
  const value = input.value.trim();
  if (!label || !value) throw new Error('请填写信息名称和内容');
  const registry = createFieldRegistry(getPersonalAdditionalFields(profile));
  const definition = matchSupplementDefinition(label, registry)
    || registry.find(def => def.sourceCollection === 'personal' && [def.label, ...def.aliases].some(alias => normalizePersonalFieldLabel(alias) === normalizePersonalFieldLabel(label)));
  if (definition?.sourceCollection === 'personal') {
    const previous = getPersonalFieldValue(profile, definition);
    if (input.expectedValue !== undefined && String(previous || '') !== input.expectedValue) throw new Error('这项个人资料已更新，请核对后再保存');
    return { ...profile, personal: { ...profile.personal, [definition.key]: value } };
  }
  const fields = getPersonalAdditionalFields(profile);
  const previous = fields.find(field => field.subject === 'self' && normalizePersonalFieldLabel(field.label) === normalizePersonalFieldLabel(label));
  if (input.expectedValue !== undefined && (previous?.value || '') !== input.expectedValue) throw new Error('这项个人资料已更新，请核对后再保存');
  const id = previous?.id || crypto.randomUUID();
  const field = { id, meaningId: previous?.meaningId || `personal.extra.${id}`, label, subject: 'self', value, valueType: input.valueType || previous?.valueType || 'text' as const, updatedAt: new Date().toISOString() };
  return { ...profile, personal: { ...profile.personal, additionalFields: [...fields.filter(item => item.id !== id), field] } };
}
