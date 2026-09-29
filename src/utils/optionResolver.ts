import type { ControlOption, OptionSnapshot } from '../shared/fillModel.ts';
import { areEquivalentDates } from './dateValue.ts';

type OptionMatch = 'exact' | 'alias' | 'date';

export type OptionResolution =
  | { status: 'matched'; option: ControlOption; match: OptionMatch }
  | { status: 'ambiguous'; candidates: ControlOption[] }
  | { status: 'needs-options' }
  | { status: 'not-found' };

const ALIASES: Record<string, readonly (readonly string[])[]> = {
  boolean: [
    ['是', 'yes', 'true', '同意', '接受'],
    ['否', 'no', 'false', '不同意', '不接受'],
  ],
  gender: [
    ['男', '男性', 'male', 'm'],
    ['女', '女性', 'female', 'f'],
  ],
  educationLevel: [
    ['高中', 'high school', 'highschool'],
    ['中专', '中等专业学校'],
    ['专科', '大专', '大学专科', 'associate'],
    ['本科', '大学本科', 'bachelor'],
    ['硕士', '硕士研究生', 'master'],
    ['博士', '博士研究生', 'phd', 'doctorate'],
  ],
  academicDegree: [
    ['学士', 'bachelor'],
    ['硕士', 'master'],
    ['博士', 'phd', 'doctorate'],
  ],
  politicalStatus: [
    ['中共党员', '中国共产党党员', '正式党员', '党员'],
    ['中共预备党员', '中国共产党预备党员', '预备党员'],
    ['共青团员', '团员'],
    ['民主党派', '民主党派成员'],
    ['群众', '普通群众'],
    ['无党派', '无党派人士'],
  ],
  date: [['至今', '现在', '目前', 'present', 'current']],
};

/** Preserve meaningful punctuation, units and qualifiers in option labels. */
export function normalizeOptionLabel(value: string): string {
  return value.normalize('NFKC').trim().toLowerCase().replace(/\s+/g, ' ');
}

function semanticKey(semantic?: string): string | undefined {
  if (semantic === 'degree' || semantic === '学历') return 'educationLevel';
  if (semantic === '学位') return 'academicDegree';
  if (semantic === '性别') return 'gender';
  if (semantic === '政治面貌') return 'politicalStatus';
  if (semantic && /date$/i.test(semantic)) return 'date';
  return semantic;
}

function isPlaceholder(value: string): boolean {
  return /^(?:请选择|选择|please\s*choose|please\s*select|select|choose)$/i.test(value);
}

/** Returns equivalence only; substring similarity must never choose an option. */
export function matchOptionLabel(
  desiredValue: string,
  optionLabel: string,
  semantic?: string,
): OptionMatch | null {
  const desired = normalizeOptionLabel(desiredValue);
  const label = normalizeOptionLabel(optionLabel);
  if (!desired || !label || isPlaceholder(label)) return null;
  const key = semanticKey(semantic);
  // Numeric backend encodings have no portable boolean or gender meaning.
  if ((key === 'boolean' || key === 'gender') && /^[-+]?\d+(?:\.\d+)?$/.test(desired)) return null;
  if (desired === label) return 'exact';
  if ((!key || key === 'date') && areEquivalentDates(desiredValue, optionLabel)) return 'date';
  const groups = key ? (ALIASES[key] || []) : Object.values(ALIASES).flat();
  for (const group of groups) {
    const normalized = group.map(normalizeOptionLabel);
    if (normalized.includes(desired) && normalized.includes(label)) return 'alias';
  }
  return null;
}

export function resolveOption(input: {
  desired: string;
  options: readonly ControlOption[];
  semantic?: string;
  parentId?: string;
  completeness?: OptionSnapshot['completeness'];
}): OptionResolution {
  if (input.completeness === 'unread') return { status: 'needs-options' };
  const matches = input.options.flatMap(option => {
    if (option.disabled || (input.parentId !== undefined && option.parentId !== input.parentId)) return [];
    const match = matchOptionLabel(input.desired, option.label, input.semantic);
    return match ? [{ option, match }] : [];
  });
  // Even identical labels and aliases can represent different IDs or paths.
  // Do not break these ties with array order or backend codes.
  if (matches.length > 1) return { status: 'ambiguous', candidates: matches.map(item => item.option) };
  if (matches.length === 1) return { status: 'matched', ...matches[0] };
  return { status: input.completeness === 'partial' ? 'needs-options' : 'not-found' };
}
