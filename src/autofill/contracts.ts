import type { ControlOption, FillOutcome } from '../shared/fillModel.ts';

export interface FieldDefinition {
  id: string;
  label: string;
  subject: string;
  valueType: 'text' | 'date';
  sourceCollection: string;
  key: string;
  aliases: string[];
  allowedTransformations: string[];
  scope: 'builtin' | 'user';
  version: number;
  provenance: string;
}
export interface AdditionalFact {
  id: string;
  meaningId: string;
  label: string;
  subject: string;
  value: string;
  valueType: 'text' | 'date';
  updatedAt: string;
  expiresAt?: string;
  recordId?: string;
}
export interface ProfileFact {
  id: string;
  meaningId: string;
  subject: string;
  recordId?: string;
  value: string;
  source: string;
  precision?: 'year' | 'month' | 'day';
  conflict?: string;
}
export interface ProfileSnapshot {
  version: string;
  sourceId: string;
  sourceLabel: string;
  facts: ProfileFact[];
}
export interface FieldObservation {
  fieldId: string;
  snapshotVersion: string;
  meaningVersion?: string;
  resolvedBinding?: { meaningId: string; subject: string; recordId?: string; factId: string };
  frameId: string;
  origin?: string;
  groupId: string;
  groupLabel: string;
  dateGroupId?: string;
  signature: string;
  label: string;
  context: string;
  kind: string;
  required: boolean;
  currentValue: string;
  disabled: boolean;
  options: ControlOption[];
  optionsState: 'unread' | 'partial' | 'complete';
  candidates: string[];
  ruleBinding?: { meaningId: string; recordId?: string; confidence: number };
  evidence?: string[];
}
export interface FieldDecision {
  decisionId: string;
  fieldId: string;
  snapshotVersion: string;
  meaningId?: string;
  subject?: string;
  recordId?: string;
  factId?: string;
  targetOptionIds?: string[];
  dependencyIds: string[];
  expectedResult?: string;
  nextAction: 'write' | 'select' | 'readOptions' | 'requestFact' | 'requestMeaning' | 'manual';
  evidenceIds: string[];
  uncertaintyReason?: string;
  modelId: string;
  registryVersion: string;
  profileVersion: string;
}
export interface MeaningCorrection {
  id: string;
  origin: string;
  signature: string;
  profileVersion: string;
  registryVersion: string;
  meaningId: string;
  recordId?: string;
  confirmedAt: string;
  enabled: boolean;
}
export interface DecisionRequest {
  fields: FieldObservation[];
  profile: ProfileSnapshot;
  registry: FieldDefinition[];
  registryVersion: string;
  corrections: MeaningCorrection[];
  executionEvidence?: ControlExperience[];
  establishedBindings?: { groupId: string; meaningId: string; recordId?: string; factId: string }[];
}
export interface DecisionProvider {
  readonly id: string;
  decide(request: DecisionRequest, signal: AbortSignal): Promise<FieldDecision[]>;
}
export interface FillContextData {
  sessionId: string;
  saveProfileVersion?: string;
  modelAvailable?: boolean;
  corrections?: MeaningCorrection[];
  profile: ProfileSnapshot;
  registry: FieldDefinition[];
  registryVersion: string;
}
export interface SessionItem {
  observation: FieldObservation;
  decision?: FieldDecision;
  outcome?: FillOutcome;
  status: 'pending' | 'verified' | 'assisted' | 'skipped' | 'existing' | 'todo' | 'missing';
  reason: string;
  attemptedPlans: string[];
  decisionAttempts?: number;
  resolvedBinding?: FieldObservation['resolvedBinding'];
}
export type SessionPhase = 'understanding' | 'rules' | 'matching' | 'writing' | 'complete' | 'stopped';
/** Read-only diagnostics. Never include profile values or webpage answers. */
export interface FillSessionResult {
  schemaVersion: 1;
  sessionId: string;
  phase: SessionPhase;
  busy: boolean;
  settled: boolean;
  modelRequests: number;
  counts: { verified: number; assisted: number; skipped: number; existing: number; missing: number; todo: number };
  fields: { fieldId: string; status: SessionItem['status']; outcome?: FillOutcome['status']; meaningId?: string; recordId?: string }[];
}
export function versionOf(value: unknown): string {
  const text = JSON.stringify(value);
  let hash = 2166136261;
  for (let i = 0; i < text.length; i++) hash = Math.imul(hash ^ text.charCodeAt(i), 16777619);
  return (hash >>> 0).toString(16);
}

/** Execution evidence contains no answer, label, HTML or raw website encoding. */
export interface ControlExperience {
  id: string;
  origin: string;
  signature: string;
  registryVersion: string;
  profileVersion: string;
  adapterId: string;
  action: 'write' | 'select';
  modelId: string;
  verifiedAt: string;
  enabled: boolean;
}
