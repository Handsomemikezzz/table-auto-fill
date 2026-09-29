import type { DetectedField, UserProfile } from '../shared/types.ts';

export type RecordSection = 'education' | 'experience' | 'projects';

const SECTION_FIELDS: Record<RecordSection, Set<string>> = {
  education: new Set(['school', 'college', 'educationType', 'major', 'majorCategory', 'degree', 'academicDegree', 'gpa', 'educationStartDate', 'graduationDate']),
  experience: new Set(['company', 'position', 'startDate', 'endDate', 'description']),
  projects: new Set(['projectName', 'projectRole', 'projectStartDate', 'projectEndDate', 'projectDescription', 'projectAchievements', 'projectTechnologies']),
};

export function recordSection(fieldType: string): RecordSection | undefined {
  return (Object.keys(SECTION_FIELDS) as RecordSection[]).find(section => SECTION_FIELDS[section].has(fieldType));
}

function directHeading(element: HTMLElement): string {
  return [element.getAttribute('aria-label'),
    ...Array.from(element.children)
      .filter(child => /^(LEGEND|H[1-6])$/.test(child.tagName) || child.getAttribute('role') === 'heading')
      .map(child => child.textContent),
  ].filter(Boolean).join(' ').trim();
}

function hasRepeatedFields(members: DetectedField[]): boolean {
  return new Set(members.map(member => member.fieldType)).size !== members.length;
}

function explicitRecordContainer(element: HTMLElement): boolean {
  if (element.hasAttribute('data-record-id') || element.hasAttribute('data-entry-id')) return true;
  const classes = element.getAttribute('class') || '';
  if (/(?:^|\s)(?:record|entry)(?:[-_](?:item|row|card))?(?:\s|$)|(?:education|experience|project|work)[-_](?:item|row|entry|record)(?:\s|$)/i.test(classes)) return true;
  return element.matches('fieldset, [role="group"]')
    && /教育经历|工作经历|实习经历|项目经历|本科|硕士|博士|专科|高中|education|employment|experience|project|bachelor|master|doctorate|phd/i.test(directHeading(element));
}

/** Structural record boundaries outrank nested fieldsets used for date/other subgroups. */
export function findRecordContainer(field: DetectedField, fields: DetectedField[]): HTMLElement {
  const section = recordSection(field.fieldType);
  const peers = fields.filter(candidate => recordSection(candidate.fieldType) === section);
  let best = field.element.parentElement || field.element;
  let explicit: HTMLElement | undefined;
  const body = field.element.ownerDocument?.body;
  for (let parent = field.element.parentElement; parent && parent !== body; parent = parent.parentElement) {
    const members = peers.filter(candidate => parent.contains(candidate.element));
    if (hasRepeatedFields(members)) break;
    const siblingFieldsets = parent.tagName === 'FIELDSET' && !/起止|日期|时间|date|period/i.test(directHeading(parent))
      ? Array.from(parent.parentElement?.children || []).filter(sibling => sibling.tagName === 'FIELDSET'
        && !/起止|日期|时间|date|period/i.test(directHeading(sibling as HTMLElement))
        && peers.some(peer => sibling.contains(peer.element))) : [];
    if (explicitRecordContainer(parent) || siblingFieldsets.length > 1) {
      // Preserve the enclosing record when an inner fieldset is only a subgroup.
      explicit ||= parent;
      if (parent.hasAttribute('data-record-id') || parent.hasAttribute('data-entry-id')) return parent;
    }
    if (parent.tagName !== 'FORM') best = parent;
    if (parent.tagName === 'FORM') break;
  }
  return explicit || best;
}

export function educationLevel(text: string): string | undefined {
  const levels = [
    ['phd', /博士|ph\.?d|doctorate/i],
    ['master', /硕士|master/i],
    ['bachelor', /本科|bachelor|undergraduate/i],
    ['associate', /专科|大专|associate/i],
    ['highschool', /高中|high\s*school/i],
  ].filter(([, pattern]) => (pattern as RegExp).test(text));
  return levels.length === 1 ? levels[0][0] as string : undefined;
}

export interface RecordBinding { section: RecordSection; index: number; recordId: string; container: HTMLElement }

function comparable(value: string): string {
  return value.normalize('NFKC').trim().toLowerCase().replace(/\s+/g, ' ');
}

function existingFieldValue(field: DetectedField): string {
  const element = field.element;
  if (element.tagName === 'SELECT') {
    const select = element as HTMLSelectElement;
    if (!select.value) return '';
    return select.options[select.selectedIndex]?.text.trim() || '';
  }
  if (element.tagName === 'INPUT' || element.tagName === 'TEXTAREA') return (element as HTMLInputElement).value?.trim() || '';
  return element.getAttribute('aria-valuetext')?.trim() || '';
}

function labelText(label: Element): string {
  if (!label.childNodes) return label.textContent || '';
  return Array.from(label.childNodes).map(node => {
    if (node.nodeType === 3) return node.textContent || '';
    if (node.nodeType !== 1) return '';
    const child = node as Element;
    return child.matches('input, select, textarea, [role="combobox"], [role="listbox"]') ? '' : labelText(child);
  }).join(' ').trim();
}

/** Labels are semantic evidence; input names alone often contain framework IDs. */
function associatedFieldLabels(element: HTMLElement): string[] {
  const root = (element.getRootNode?.() || element.ownerDocument) as Document | ShadowRoot | undefined;
  const labels = Array.from((element as HTMLInputElement).labels || []);
  const id = element.getAttribute('id');
  if (id && root?.querySelectorAll) labels.push(...Array.from(root.querySelectorAll<HTMLLabelElement>('label[for]'))
    .filter(label => label.getAttribute('for') === id));
  const wrapped = element.closest?.('label');
  if (wrapped) labels.push(wrapped);
  const texts = labels.map(labelText);
  for (const labelId of element.getAttribute('aria-labelledby')?.split(/\s+/).filter(Boolean) || []) {
    const label = root?.getElementById?.(labelId)
      || Array.from(root?.querySelectorAll?.<HTMLElement>('[id]') || []).find(candidate => candidate.getAttribute('id') === labelId);
    if (label) texts.push(labelText(label));
  }
  return [...new Set(texts.filter(Boolean))];
}

interface RecordGroup {
  section: RecordSection;
  container: HTMLElement;
  members: DetectedField[];
  candidates: number[];
  constrained: boolean;
  summary: boolean;
}

function isStandaloneEducationSummary(group: RecordGroup, groups: RecordGroup[]): boolean {
  if (group.section !== 'education' || group.members.length !== 1
    || !['degree', 'academicDegree'].includes(group.members[0].fieldType)) return false;
  if (explicitRecordContainer(group.container)) return false;
  const repeatedSingles = groups.filter(candidate => candidate.section === 'education'
    && candidate.members.length === 1 && candidate.members[0].fieldType === group.members[0].fieldType
    && candidate.container.parentElement === group.container.parentElement
    && candidate.container.matches('fieldset, [role="group"]'));
  // Two explicit record-shaped siblings remain two records even when each has only a degree field.
  return !group.container.matches('fieldset, [role="group"]') || repeatedSingles.length <= 1;
}

function groupCandidates(group: RecordGroup, profile: UserProfile, groups: RecordGroup[]): void {
  const records = profile[group.section];
  for (let parent: HTMLElement | null = group.container; parent; parent = parent.parentElement) {
    const heading = directHeading(parent);
    const sections = (Object.entries({
      education: /教育经历|教育背景|学历|education/i,
      experience: /工作经历|实习经历|employment|work\s*experience/i,
      projects: /项目经历|项目经验|project(?:s|\s*experience)?/i,
    }) as Array<[RecordSection, RegExp]>).filter(([, pattern]) => pattern.test(heading));
    if (sections.length !== 1) continue;
    if (sections[0][0] !== group.section) {
      group.candidates = []; group.constrained = true; return;
    }
    break;
  }
  const explicitId = group.container.getAttribute('data-record-id') || group.container.getAttribute('data-entry-id');
  const byId = explicitId ? records.findIndex(record => record.id === explicitId) : -1;
  group.candidates = records.map((_, index) => index);
  if (byId >= 0) { group.candidates = [byId]; group.constrained = true; }
  const label = [directHeading(group.container),
    ...group.members.flatMap(field => [field.label, field.element.getAttribute('name'), field.element.getAttribute('aria-label'), ...associatedFieldLabels(field.element)]),
  ].filter(Boolean).join(' ');
  if (group.section === 'education') {
    const level = educationLevel(label);
    if (level) {
      group.constrained = true;
      group.candidates = group.candidates.filter(index => educationLevel(profile.education[index].degree) === level);
    }
    if (/最高学历|最高教育经历|highest\s+(?:education|degree|qualification)/i.test(label)) {
      group.constrained = true;
      group.summary = true;
      const order = ['highschool', 'associate', 'bachelor', 'master', 'phd'];
      const highest = Math.max(...group.candidates.map(index => order.indexOf(educationLevel(profile.education[index].degree) || '')));
      group.candidates = highest < 0 ? [] : group.candidates.filter(index => order.indexOf(educationLevel(profile.education[index].degree) || '') === highest);
    }
    if (isStandaloneEducationSummary(group, groups)) {
      group.summary = true;
      group.constrained = true;
    }
    if (group.summary && group.members.length === 1 && ['degree', 'academicDegree'].includes(group.members[0].fieldType)) {
      const key = group.members[0].fieldType as 'degree' | 'academicDegree';
      group.candidates = group.candidates.filter(index => Boolean(profile.education[index][key]?.trim()));
      const values = new Set(group.candidates.map(index => {
        const value = profile.education[index][key]!;
        return key === 'degree' ? educationLevel(value) || comparable(value) : comparable(value);
      }));
      // Reusing an answer is safe only when every applicable source agrees on this field's value.
      if (values.size !== 1) group.candidates = [];
    }
  }
  // A preserved company/school/project name is stronger evidence than page order.
  const anchor = group.section === 'education' ? 'school' : group.section === 'experience' ? 'company' : 'projectName';
  const anchorFields = group.members.filter(field => field.fieldType === anchor && existingFieldValue(field));
  for (const field of anchorFields) {
    const actual = comparable(existingFieldValue(field));
    group.constrained = true;
    group.candidates = group.candidates.filter(index => {
      const record = records[index] as unknown as Record<string, string>;
      return comparable(record[group.section === 'projects' ? 'name' : anchor] || '') === actual;
    });
  }
}

/** Bind once per logical record. A missing field never advances another field's record. */
export function bindFieldRecords(fields: DetectedField[], profile: UserProfile): Map<HTMLElement, RecordBinding> {
  const result = new Map<HTMLElement, RecordBinding>();
  const groups: RecordGroup[] = [];
  for (const field of fields) {
    const section = recordSection(field.fieldType);
    if (!section) continue;
    const container = findRecordContainer(field, fields);
    let group = groups.find(candidate => candidate.container === container && candidate.section === section);
    if (!group) { group = { section, container, members: [], candidates: [], constrained: false, summary: false }; groups.push(group); }
    group.members.push(field);
  }
  const used: Record<RecordSection, Set<number>> = { education: new Set(), experience: new Set(), projects: new Set() };
  const ordered = groups.sort((left, right) => {
    if (left.container === right.container) return 0;
    const position = left.container.compareDocumentPosition(right.container);
    // Disconnected shadow roots have no reliable document order; retain scan order.
    return position & 1 ? 0 : position & 4 ? -1 : 1;
  });
  ordered.forEach(group => groupCandidates(group, profile, ordered));
  // Reserve constrained records before ordinal groups, independent of page order.
  const assignments = [...ordered.filter(group => group.constrained).sort((a, b) => a.candidates.length - b.candidates.length), ...ordered.filter(group => !group.constrained)];
  for (const group of assignments) {
    const { section, container, members } = group;
    const index = group.candidates.find(index => group.summary || !used[section].has(index)) ?? -1;
    if (index < 0) continue;
    if (!group.summary) used[section].add(index);
    const binding = { section, index, recordId: profile[section][index].id, container };
    for (const field of members) result.set(field.element, binding);
  }
  return result;
}

export function dateRangePart(element: HTMLElement): 'start' | 'end' | undefined {
  // Component wrappers may put eight or more nodes between an editor and its
  // shared field label. Stop at a multi-control boundary, not a shallow depth.
  for (let parent = element.parentElement, depth = 0; parent && depth < 20; parent = parent.parentElement, depth++) {
    if (parent.tagName === 'FORM' || parent.tagName === 'BODY') return undefined;
    const inputs = [...parent.querySelectorAll<HTMLElement>('input:not([type="hidden"]), select, [role="combobox"]')]
      .filter(input => !input.querySelector('input, select, [role="combobox"]'));
    if (inputs.length > 2) return undefined;
    if (inputs.length !== 2) continue;
    const question = [parent.getAttribute('data-form-field-name'), directHeading(parent),
      ...Array.from(parent.children).filter(child => !child.querySelector('input, select, [role="combobox"]')
        && !child.matches('input, select, [role="combobox"]') && (child.textContent || '').length <= 100)
        .map(child => child.textContent),
    ].filter(Boolean).join(' ');
    const explicitRange = /起止(?:时间|日期|年月)|时间范围|日期范围|date\s*range|start[_ -]?end(?:[_ -]?(?:time|date))?/i.test(question)
      || parent.matches('.ant-picker-range, [data-picker="range"], [data-date-range]');
    if (!explicitRange) continue;
    const hints = inputs.map(input => [input.getAttribute('name'), input.getAttribute('id'), input.getAttribute('aria-label'), input.getAttribute('placeholder')].filter(Boolean).join(' '));
    if (inputs.some(input => !['', 'text', 'date', 'month', 'number'].includes((input.getAttribute('type') || '').toLowerCase()))) return undefined;
    if (hints.some(hint => /birth|出生|公司|姓名|company|school|phone|email/i.test(hint))) return undefined;
    const endpoints = hints.map(hint => {
      const start = /start|begin|(?:^|\W)from(?:\W|$)|开始|入学|入职/i.test(hint);
      const end = /end|finish|graduation|(?:^|\W)to(?:\W|$)|结束|毕业|离职|截止/i.test(hint);
      return start === end ? undefined : start ? 'start' as const : 'end' as const;
    });
    if (endpoints[0] && endpoints[0] === endpoints[1]) return undefined;
    const index = inputs.findIndex(input => input === element || input.contains(element) || element.contains(input));
    if (index >= 0) return endpoints[index] || (endpoints[1 - index] === 'start' ? 'end' : endpoints[1 - index] === 'end' ? 'start' : index === 0 ? 'start' : 'end');
  }
  return undefined;
}
