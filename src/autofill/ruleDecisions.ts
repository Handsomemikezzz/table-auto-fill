import type { FieldDecision, FieldObservation, FillContextData, MeaningCorrection, ProfileSnapshot } from './contracts.ts';
import type { UserProfile } from '../shared/types.ts';

const renamedFields: Record<string, string> = {
  educationStartDate: 'education.startDate', graduationDate: 'education.endDate',
  startDate: 'experience.startDate', endDate: 'experience.endDate', description: 'experience.description',
  projectName: 'projects.name', projectRole: 'projects.role', projectStartDate: 'projects.startDate',
  projectEndDate: 'projects.endDate', projectDescription: 'projects.description',
  projectAchievements: 'projects.achievements', projectTechnologies: 'projects.technologies',
  resumeFile: 'attachment.resumeFile',
};
export function meaningForRule(fieldType: string, context: Pick<FillContextData, 'registry'>): string | undefined {
  if (renamedFields[fieldType]) return renamedFields[fieldType];
  const definitions = context.registry.filter(def => def.scope === 'builtin' && def.key === fieldType);
  if (fieldType === 'name') return 'personal.name';
  return definitions.length === 1 ? definitions[0].id : undefined;
}
/** Reuse the existing whole-record binder with facts from the selected snapshot only. */
export function profileForRuleBinding(snapshot: ProfileSnapshot): UserProfile {
  const profile = { personal: {}, education: [], experience: [], projects: [], certifications: [], skills: [], customInformation: [] } as unknown as UserProfile;
  const collections = new Map<string, Map<string, Record<string, string>>>();
  for (const fact of snapshot.facts) {
    if (fact.subject !== 'self') continue;
    const [collection, key] = fact.meaningId.split('.');
    if (collection === 'personal') Object.assign(profile.personal, { [key]: fact.value });
    else if (fact.recordId && ['education', 'experience', 'projects'].includes(collection)) {
      if (!collections.has(collection)) collections.set(collection, new Map());
      const records = collections.get(collection)!;
      const record = records.get(fact.recordId) || { id: fact.recordId };
      record[key] = fact.value; records.set(fact.recordId, record);
    }
  }
  for (const [collection, records] of collections) Object.assign(profile, { [collection]: [...records.values()] });
  return profile;
}
export function buildRuleDecisions(fields: FieldObservation[], context: FillContextData, corrections: MeaningCorrection[] = []): FieldDecision[] {
  return fields.flatMap((field): FieldDecision[] => {
    if (field.disabled || field.kind === 'unsupported') return [];
    const correction = corrections.filter(item => item.enabled && item.confirmedAt && item.signature === field.signature
      && (!field.origin || item.origin === field.origin) && item.profileVersion === context.profile.version
      && item.registryVersion === context.registryVersion).at(-1);
    const binding = correction || field.resolvedBinding || (field.ruleBinding && field.ruleBinding.confidence >= 0.9 ? field.ruleBinding : undefined);
    if (!binding) return [];
    const { meaningId, recordId } = binding;
    const facts = context.profile.facts.filter(fact => fact.meaningId === meaningId && fact.recordId === recordId && fact.subject === (context.registry.find(def => def.id === meaningId)?.subject || 'self'));
    if (facts.length === 0) return [{ decisionId: crypto.randomUUID(), fieldId: field.fieldId, snapshotVersion: field.snapshotVersion,
      meaningId, recordId, nextAction: 'requestFact' as const,
      registryVersion: context.registryVersion, profileVersion: context.profile.version }];
    if (facts.length !== 1) return [];
    const fact = facts[0];
    return [{ decisionId: crypto.randomUUID(), fieldId: field.fieldId, snapshotVersion: field.snapshotVersion,
      meaningId, subject: fact.subject, recordId, factId: fact.id, nextAction: 'write',
      registryVersion: context.registryVersion, profileVersion: context.profile.version }];
  });
}
