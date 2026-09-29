import { areEquivalentDates } from './dateValue.ts';
import { matchOptionLabel, resolveOption } from './optionResolver.ts';

export function normalizeDropdownText(value: string): string {
  return String(value || '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/\s+/g, '')
    .replace(/[：:、，,。.;；()（）[\]【】×✕]/g, '');
}

/**
 * Legacy numeric score API. Only exact or established semantic equivalence
 * receives a score; similar text is insufficient evidence for an automatic fill.
 */
export function scoreDropdownOption(desiredValue: string, optionText: string, semantic?: string): number {
  const match = matchOptionLabel(desiredValue, optionText, semantic);
  return match === 'exact' ? 1000 : match === 'date' ? 980 : match === 'alias' ? 950 : -1;
}

export function findBestDropdownOptionIndex(desiredValue: string, options: string[], semantic?: string): number {
  const result = resolveOption({
    desired: desiredValue,
    options: options.map((label, index) => ({ id: String(index), label })),
    semantic,
  });
  return result.status === 'matched' ? Number(result.option.id) : -1;
}

export function dropdownValueMatches(actualValue: string, desiredValue: string, semantic?: string): boolean {
  if (!actualValue.trim() || !desiredValue.trim()) return false;
  return matchOptionLabel(desiredValue, actualValue, semantic) !== null;
}

export function splitMultiDropdownValue(value: string): string[] {
  const parts = value.split(/[，,、;；|\n]+/).map(part => part.trim()).filter(Boolean);
  return parts.length > 1 ? parts : [value.trim()];
}

export function splitCascaderValue(value: string): string[] {
  if (areEquivalentDates(value, value)) return [value.trim()];
  const parts = value.split(/(?:\s*[>＞]\s*|[／/])/).map(part => part.trim()).filter(Boolean);
  return parts.length > 1 ? parts : [value.trim()];
}
