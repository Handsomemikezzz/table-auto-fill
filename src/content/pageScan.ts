import type { ControlOption } from '../shared/fillModel.ts';
export type PageScanSection = 'personal' | 'education' | 'experience' | 'projects' | 'other';

export interface PageScanField {
  index: number;
  rowIndex: number;
  section: PageScanSection;
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

export interface PageScanFieldGroup {
  section: PageScanSection;
  fields: PageScanField[];
}

const SECTION_ORDER: PageScanSection[] = [
  'personal',
  'education',
  'experience',
  'projects',
  'other',
];

export function groupPageScanFields(fields: PageScanField[]): PageScanFieldGroup[] {
  const groups = new Map<PageScanSection, PageScanField[]>();

  for (const field of fields) {
    const current = groups.get(field.section) || [];
    current.push(field);
    groups.set(field.section, current);
  }

  return SECTION_ORDER
    .filter(section => groups.has(section))
    .map(section => ({
      section,
      fields: groups.get(section) || [],
    }));
}
