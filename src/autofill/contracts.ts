import type { ControlOption, FillOutcome } from '../shared/fillModel.ts';

export interface FieldDefinition {
  id: string;
  label: string;
  subject: string;
  valueType: 'text' | 'date';
  sourceCollection: string;
  key: string;
  aliases: string[];
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
  ruleBinding?: { meaningId: string; recordId?: string; confidence: number };
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
  nextAction: 'write' | 'requestFact';
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
  establishedBindings?: { groupId: string; meaningId: string; recordId?: string; factId: string }[];
}
export interface FillContextData {
  sessionId: string;
  saveProfileVersion?: string;
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
export type SessionPhase = 'understanding' | 'rules' | 'writing' | 'complete' | 'stopped';
/** Read-only diagnostics. Never include profile values or webpage answers. */
export interface FillSessionResult {
  schemaVersion: 1;
  sessionId: string;
  phase: SessionPhase;
  busy: boolean;
  settled: boolean;
  counts: { verified: number; assisted: number; skipped: number; existing: number; missing: number; todo: number };
  fields: { fieldId: string; status: SessionItem['status']; outcome?: FillOutcome['status']; meaningId?: string; recordId?: string }[];
}
export function versionOf(value: unknown): string {
  const text = JSON.stringify(value);
  let hash = 2166136261;
  for (let i = 0; i < text.length; i++) hash = Math.imul(hash ^ text.charCodeAt(i), 16777619);
  return (hash >>> 0).toString(16);
}
