import { PERSONAL_EXTRA_FIELDS } from './personalFields.ts';
import type { PersonalInfo } from './types.ts';

export type BasicInfoField = {
  key: keyof PersonalInfo;
  label: string;
};

export const BASIC_INFO_FIELDS: BasicInfoField[] = [
  { key: 'name', label: '姓名' },
  { key: 'gender', label: '性别' },
  { key: 'birthDate', label: '出生日期' },
  { key: 'politicalStatus', label: '政治面貌' },
  { key: 'ethnicity', label: '民族' },
  { key: 'phone', label: '手机号' },
  { key: 'email', label: '邮箱' },
  { key: 'wechat', label: '微信号' },
  { key: 'hometown', label: '籍贯' },
  { key: 'currentAddress', label: '现居地' },
  { key: 'idCard', label: '身份证号' },
  { key: 'selfEvaluation', label: '自我评价' },
];

export const SELF_EVALUATION_PREVIEW_MAX_CHARS = 18;

export function toSingleLinePreview(
  value: string,
  maxChars = SELF_EVALUATION_PREVIEW_MAX_CHARS
): string {
  const normalized = value.replace(/\s+/g, ' ').trim();
  if (normalized.length <= maxChars) return normalized;
  return `${normalized.slice(0, maxChars)}......`;
}

export function buildBasicInfoItems(personal: PersonalInfo) {
  const items = BASIC_INFO_FIELDS.map(field => {
    const raw = String(personal[field.key] ?? '').trim();
    const displayValue = field.key === 'selfEvaluation'
      ? toSingleLinePreview(raw)
      : raw;

    return {
      key: field.key,
      label: field.label,
      value: raw,
      displayValue,
      empty: raw === '',
    };
  });
  return [...items, ...PERSONAL_EXTRA_FIELDS.filter(field => personal[field.key]?.trim()).map(field => ({ key: field.key as string, label: field.label, value: personal[field.key]!, displayValue: personal[field.key]!, empty: false })), ...(personal.additionalFields || []).filter(field => field.value.trim()).map(field => ({ key: `extra-${field.id}`, label: field.label, value: field.value, displayValue: field.value, empty: false }))];
}
