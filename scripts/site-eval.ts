import type { FieldObservation, FieldDecision, DecisionRequest } from '../src/autofill/contracts.ts';
import type { UserProfile } from '../src/shared/types.ts';
import { FieldMatcher } from '../src/utils/fieldMatcher.ts';
import { createFieldRegistry, registryVersion, meaningCandidates } from '../src/autofill/fieldRegistry.ts';
import { createProfileSnapshot } from '../src/autofill/profileSnapshot.ts';
import { getPersonalAdditionalFields, matchSupplementDefinition } from '../src/shared/personalFields.ts';
import { meaningForRule, buildRuleDecisions } from '../src/autofill/ruleDecisions.ts';
import { validateModule } from '../src/autofill/decisionValidation.ts';

export interface EvalField {
  id: string; label: string; groupLabel: string; kind: string; name: string; placeholder: string;
  options: string[]; optionsState: FieldObservation['optionsState']; currentValue: string;
  expected: Record<string, { policy: 'auto' | 'manual' | 'missing' | 'preserve'; meaningId?: string; recordId?: string }>;
}
export interface EvalCase { id: string; siteId: string; provenance: string; annotationStatus: string; fields: EvalField[] }
export function prepareCase(sample: EvalCase, profile: UserProfile, referenceDate?: string): DecisionRequest {
  const registry = createFieldRegistry(getPersonalAdditionalFields(profile));
  const snapshot = createProfileSnapshot(profile, 'default', registry, referenceDate);
  const fields = sample.fields.map((input): FieldObservation => {
    const match = FieldMatcher.matchFieldType(input.name, '', input.placeholder, input.label, input.kind === 'file' ? 'file' : 'text', '', input.groupLabel);
    const meaningId = matchSupplementDefinition(input.label, registry)?.id || meaningForRule(match.fieldType, { registry });
    const candidates = snapshot.facts.filter(fact => fact.meaningId === meaningId);
    // This descriptor-only layer cannot reconstruct DOM record grouping. Only a
    // unique existing fact can bind; ambiguous records remain for model/manual review.
    const binding = meaningId && match.confidence >= 0.9 && (candidates.length <= 1)
      ? { meaningId, recordId: candidates[0]?.recordId, confidence: match.confidence } : undefined;
    return { fieldId: input.id, snapshotVersion: sample.id, frameId: '0', groupId: input.groupLabel, groupLabel: input.groupLabel,
      signature: `${sample.id}:${input.id}`, label: input.label, context: input.groupLabel, kind: input.kind,
      required: false, currentValue: input.currentValue, disabled: false,
      options: input.options.map((label, index) => ({ id: `${input.id}:option:${index}`, label })), optionsState: input.optionsState,
      candidates: meaningCandidates(`${input.groupLabel} ${input.label}`, registry), ruleBinding: binding };
  });
  return { fields, profile: snapshot, registry, registryVersion: registryVersion(registry), corrections: [] };
}
export function rulePredictions(request: DecisionRequest): FieldDecision[] {
  return buildRuleDecisions(request.fields.filter(field => !field.currentValue), { sessionId: 'offline-eval', ...request });
}
export function scoreCase(sample: EvalCase, profileId: string, request: DecisionRequest, decisions: FieldDecision[]) {
  const errors = validateModule(decisions, request);
  const rows = sample.fields.map(input => {
    const expected = input.expected[profileId];
    if (!expected) throw new Error(`Missing annotation ${sample.id}/${input.id}/${profileId}`);
    const choices = decisions.filter(decision => decision.fieldId === input.id);
    const decision = choices.length === 1 ? choices[0] : undefined;
    const writing = decision && ['write', 'select'].includes(decision.nextAction);
    const fact = request.profile.facts.find(fact => fact.id === decision?.factId);
    const valid = decision && !errors.has(input.id);
    const observation = request.fields.find(field => field.fieldId === input.id);
    const attempted = choices.some(choice => ['write', 'select'].includes(choice.nextAction));
    const correctBinding = Boolean(writing && valid && fact && decision!.meaningId === expected.meaningId
      && fact.subject === 'self' && fact.recordId === (expected.recordId ?? undefined));
    const correct = expected.policy === 'preserve' ? Boolean(input.currentValue && !attempted)
      : expected.policy === 'auto' ? correctBinding
        : !attempted && (!decision || Boolean(valid));
    return { fieldId: input.id, policy: expected.policy, detected: Boolean(observation), attempted, correct,
      prepared: Boolean(writing && valid), meaningId: decision?.meaningId, recordId: decision?.recordId,
      reason: !choices.length ? 'unresolved' : errors.get(input.id) || decision?.nextAction };
  });
  return { sampleId: sample.id, siteId: sample.siteId, profileId, provenance: sample.provenance,
    total: rows.length, eligible: rows.filter(row => row.policy === 'auto').length,
    correctPrepared: rows.filter(row => row.policy === 'auto' && row.correct).length,
    attempted: rows.filter(row => row.attempted).length,
    incorrectAttempts: rows.filter(row => row.attempted && !row.correct).length,
    missed: rows.filter(row => !row.detected).length, unresolved: rows.filter(row => row.policy === 'auto' && !row.correct).length,
    rows };
}
export function assertManifest(manifest: { profiles: string[]; sites: { id: string; cases: string[] }[] }) {
  if (!manifest.profiles.length || new Set(manifest.profiles).size !== manifest.profiles.length) throw new Error('Invalid profiles');
  if (new Set(manifest.sites.map(site => site.id)).size !== manifest.sites.length) throw new Error('Duplicate sites');
  const paths = manifest.sites.flatMap(site => site.cases);
  if (new Set(paths).size !== paths.length) throw new Error('Duplicate cases');
}
