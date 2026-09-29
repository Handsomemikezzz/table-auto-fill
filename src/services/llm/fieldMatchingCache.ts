import type { ControlOption } from '../../shared/fillModel.ts';
export interface CacheableField {
  index: number;
  name: string;
  id: string;
  placeholder: string;
  labelText: string;
  type: string;
  contextText?: string;
}

export interface CacheableAIFillField {
  index: number;
  rowIndex: number;
  name: string;
  label: string;
  type: string;
  options: string[];
  optionCandidates?: ControlOption[];
  optionsComplete?: boolean;
  semantic?: string;
  recordId?: string;
  recordCollection?: 'education' | 'experience' | 'projects';
  context: string;
  blockId?: string;
  blockContext?: string;
}

export function buildFieldMatchingCacheKey(
  domain: string,
  fields: CacheableField[],
  recognitionRules = '',
): string {
  const fingerprint = `${fields
    .map(field => [field.index, field.name, field.id, field.placeholder, field.labelText, field.type, field.contextText || '']
      .map(value => String(value).trim().toLowerCase()).join('\u001f'))
    .join('\u001e')}\u001d${recognitionRules.trim()}`;
  let hash = 0x811c9dc5;
  for (let index = 0; index < fingerprint.length; index++) {
    hash ^= fingerprint.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return `fieldMatch_v4_${domain}_${(hash >>> 0).toString(16).padStart(8, '0')}`;
}

export function buildAIFillValueCacheKey(
  domain: string,
  field: CacheableAIFillField,
  profileFingerprint: string,
  recognitionRules = '',
): string {
  const source = JSON.stringify({
    domain: domain.trim().toLowerCase(),
    field: {
      rowIndex: field.rowIndex,
      name: field.name,
      label: field.label,
      type: field.type,
      options: field.options,
      optionCandidates: field.optionCandidates,
      optionsComplete: field.optionsComplete,
      semantic: field.semantic,
      recordId: field.recordId,
      recordCollection: field.recordCollection,
      context: field.context,
      blockId: field.blockId || '',
      blockContext: field.blockContext || '',
    },
    profileFingerprint,
    recognitionRules: recognitionRules.trim(),
  });
  let hash = 0x811c9dc5;
  for (let index = 0; index < source.length; index++) {
    hash ^= source.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return `aiPageFill_v3_${(hash >>> 0).toString(16).padStart(8, '0')}`;
}
