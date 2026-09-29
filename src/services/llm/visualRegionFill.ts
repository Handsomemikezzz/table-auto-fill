import { validateFieldMappings } from './fieldMapping.ts';
import type {
  UserProfile,
  VisualRegionFillMapping,
  VisualRegionFillMappingResult,
  VisualRegionFillPayload,
} from '../../shared/types.ts';


export function parseVisualRegionFillResponse(raw: string): VisualRegionFillMappingResult {
  const normalized = raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');

  let parsed: unknown;
  try {
    parsed = JSON.parse(normalized);
  } catch {
    throw new Error('视觉补填结果不是合法 JSON');
  }

  const mappings = Array.isArray((parsed as { mappings?: unknown })?.mappings)
    ? (parsed as { mappings: unknown[] }).mappings
        .filter(isVisualRegionFillMapping)
        .map(mapping => ({
          controlId: mapping.controlId.trim(),
          fieldMeaning: mapping.fieldMeaning.trim(),
          matchedProfilePath: mapping.matchedProfilePath.trim(),
          value: mapping.value.trim(),
          ...(mapping.optionId ? { optionId: mapping.optionId } : {}),
        }))
    : [];

  return { mappings };
}

export function validateVisualRegionMappings(
  mappings: VisualRegionFillMappingResult['mappings'],
  payload: VisualRegionFillPayload,
  profile: UserProfile,
): VisualRegionFillMappingResult['mappings'] {
  const fields = payload.controls.map((control, index) => ({ ...control, index }));
  const indexes = new Map(fields.map(field => [field.controlId, field.index]));
  const raw: Record<string, unknown> = {};
  const originals = new Map<number, VisualRegionFillMapping>();
  const duplicate = new Set<number>();
  for (const mapping of mappings) {
    const index = indexes.get(mapping.controlId);
    if (index === undefined || !mapping.value.trim()) continue;
    const candidate = { profilePath: mapping.matchedProfilePath, value: mapping.value, optionId: mapping.optionId };
    if (!validateFieldMappings({ [index]: candidate }, [fields[index]], profile)[String(index)]) continue;
    if (originals.has(index)) { duplicate.add(index); continue; }
    originals.set(index, mapping);
    raw[index] = candidate;
  }
  for (const index of duplicate) delete raw[index];
  const validated = validateFieldMappings(raw, fields, profile);
  return Object.entries(validated).map(([index, result]) => ({
    ...originals.get(Number(index))!, value: result.value,
    ...(result.optionId ? { optionId: result.optionId } : {}),
  }));
}

function isVisualRegionFillMapping(value: unknown): value is VisualRegionFillMapping {
  if (!value || typeof value !== 'object') return false;

  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.controlId === 'string'
    && typeof candidate.fieldMeaning === 'string'
    && typeof candidate.matchedProfilePath === 'string'
    && typeof candidate.value === 'string'
  );
}
