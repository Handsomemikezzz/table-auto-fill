/** Serializable evidence and outcomes shared by every form-filling entry point. */
export type FieldSemantic =
  | 'gender' | 'boolean' | 'educationLevel' | 'academicDegree'
  | 'politicalStatus' | 'date' | 'text';

export type DatePrecision = 'year' | 'month' | 'day';

export type CanonicalValue =
  | { kind: 'text'; value: string }
  | { kind: 'number'; value: number; unit?: string }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'enum'; semantic: string; value: string }
  | { kind: 'date'; year: number; month?: number; day?: number; precision: DatePrecision }
  | { kind: 'present' }
  | { kind: 'set'; values: string[] }
  | { kind: 'path'; values: string[] };

export interface ControlOption {
  /** Identity within the current control/options snapshot, never a global enum. */
  id: string;
  label: string;
  rawValue?: string | number | boolean;
  disabled?: boolean;
  parentId?: string;
  path?: string[];
}

export interface OptionSnapshot {
  options: ControlOption[];
  /** Empty unread/partial snapshots cannot establish that an option is absent. */
  completeness: 'unread' | 'partial' | 'complete';
  revision?: string;
}

export interface FactBinding {
  profilePath: string;
  /** Stable identity from a profile record, not a per-field occurrence index. */
  recordId?: string;
  value: CanonicalValue;
  source: 'profile' | 'user';
}

export interface FillIntent {
  fieldId: string;
  binding?: FactBinding;
  semantic?: string;
  value: CanonicalValue;
  optionIds?: string[];
  groupId?: string;
  dependsOn?: string[];
  optionsRevision?: string;
}

export type FillStatus =
  | 'verified' | 'unchanged' | 'needs-data' | 'needs-mapping'
  | 'unsupported' | 'rejected' | 'unverified' | 'failed'
  | 'stale' | 'cancelled' | 'user-edited' | 'skipped-existing';

export interface FillOutcome {
  status: FillStatus;
  reason: string;
  fieldId?: string;
  adapterId?: string;
  expectedValue?: string;
  observedValue?: string;
  attempts?: number;
}
