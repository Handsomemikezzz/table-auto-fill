import type { UserProfile } from '../shared/types.ts';
import { getResumeLibrary } from '../shared/resumes.ts';
import { parseFlexibleDate } from '../utils/dateValue.ts';
import { createFieldRegistry } from './fieldRegistry.ts';
import { versionOf, type FieldDefinition, type ProfileSnapshot, type ProfileFact } from './contracts.ts';

export function createProfileSnapshot(profile: UserProfile, sourceId = 'default', registry = createFieldRegistry(profile.additionalFacts)): ProfileSnapshot {
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
      const sharedValue = key !== 'selfEvaluation' && profile.personal?.[key];
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
  for (const fact of profile.additionalFacts || []) {
    const def = registry.find(def => def.id === fact.meaningId && def.subject === fact.subject);
    if (def) {
      const before = facts.length;
      add(def, fact.value, fact.id, fact.expiresAt && fact.expiresAt < new Date().toISOString().slice(0, 10) ? '这条时效性资料已过期，请重新确认' : undefined);
      if (facts.length > before) facts.at(-1)!.source = `用户补充 · ${fact.updatedAt}`;
    }
  }
  for (const info of profile.customInformation || []) {
    if (!info.content.trim()) continue;
    facts.push({ id: `saved:${info.id}`, meaningId: `saved.${info.id}`, subject: 'self', value: info.content, source: `已保存答案：${info.name}` });
  }
  return { version: versionOf({ sourceId, facts }), sourceId, sourceLabel, facts };
}

/** Only an explicit user save can change a known fact; registry keys constrain the mutation. */
export function saveConfirmedFact(profile: UserProfile, fact: import('./contracts.ts').AdditionalFact): UserProfile {
  const definition = createFieldRegistry(profile.additionalFacts).find(def => def.id === fact.meaningId && def.subject === fact.subject && def.scope === 'builtin');
  if (!definition) return { ...profile, additionalFacts: [...(profile.additionalFacts || []).filter(item => item.id !== fact.id), fact] };
  if (definition.sourceCollection === 'personal') return { ...profile, personal: { ...profile.personal, [definition.key]: fact.value } };
  const collection = (profile as unknown as Record<string, unknown>)[definition.sourceCollection];
  if (!Array.isArray(collection) || !fact.recordId || !collection.some(record => (record.id || `${definition.sourceCollection}-${versionOf(record)}`) === fact.recordId)) throw new Error('请先确认这条事实所属的经历');
  return { ...profile, [definition.sourceCollection]: collection.map(record => (record.id || `${definition.sourceCollection}-${versionOf(record)}`) === fact.recordId ? { ...record, id: record.id || fact.recordId, [definition.key]: fact.value } : record) };
}
