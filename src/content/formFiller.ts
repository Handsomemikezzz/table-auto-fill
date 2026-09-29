import { resolveLearnedValue } from '../shared/learnedFields.ts';
import { parseFlexibleDate } from '../utils/dateValue.ts';
import { fillControl, verifyControl, type FillContext } from './fillEngine.ts';
import { getControlValue, getOptions, getControlLabel, isOptionSelected, observeControl } from './controlObservation.ts';
import { bindFieldRecords, recordSection, dateRangePart } from './fieldBinding.ts';
import type { FillOutcome } from '../shared/fillModel.ts';
import type { DetectedField, FillPreviewItem, LearnedFieldValue, UserProfile } from '../shared/types';
import { FieldType } from '../shared/types';
import { GENDER_OPTIONS } from '../shared/constants';
import { FieldMatcher } from '../utils/fieldMatcher';
import { getChineseFieldLabel } from '../shared/fieldLabels.ts';
import { getChoiceQuestion, getControlOptions, isChoiceControl } from './controlSemantics';

export type FillSection = 'all' | 'personal' | 'education' | 'experience' | 'projects';

export interface FillFailure {
  element: HTMLElement;
  signature: string;
  fieldType: string;
  label: string;
  attemptedValue: string;
  outcome?: FillOutcome;
}

export class FormFiller {
  private previousValues = new Map<
    HTMLElement,
    { value: string; choices?: Array<{ element: HTMLElement; checked: boolean }>; selection?: Array<{ value: string; label: string }> }
  >();
  private failures = new Map<Element, FillFailure>();
  private outcomes = new Map<HTMLElement, FillOutcome>();
  private intents = new Map<HTMLElement, { value: string; context: FillContext }>();

  beginFillSession(): void {
    this.previousValues.clear();
    this.failures.clear();
    this.outcomes.clear();
    this.intents.clear();
  }

  getLastFailures(): FillFailure[] {
    return Array.from(this.failures.values());
  }

  markUnresolvedField(
    element: HTMLElement,
    label = '',
  ): void {
    if (this.failures.has(element)) return;
    this.outcomes.set(element, { status: 'needs-mapping', reason: '尚未确定此字段对应的资料，可选择答案或在网页中处理' });
    this.recordFailure(element, '', 'unknown', label);
  }

  getFieldSignature(element: HTMLElement): string {
    const container = element.closest<HTMLElement>(
      '[data-form-field-id], [data-form-field-name], [data-form-field-i18n-name], [class*=formItem], [class*=applyFormItem]'
    );
    const identifiers = FieldMatcher.extractIdentifiers(element);
    const source = (isChoiceControl(element) ? [
      element.type,
      element.getAttribute('name') || '',
      getChoiceQuestion(element),
      getControlOptions(element).join('|'),
      identifiers.contextText,
    ] : [
      element.getAttribute('name') || '',
      dateRangePart(element) || '',
      element.id,
      element.getAttribute('data-form-field-name') || '',
      element.getAttribute('data-form-field-id') || '',
      container?.getAttribute('data-form-field-name') || '',
      container?.getAttribute('data-form-field-id') || '',
      element.getAttribute('aria-label') || '',
      element.getAttribute('placeholder') || '',
      identifiers.labelText,
      identifiers.contextText,
      getOptions(element).map(option => [option.label, option.rawValue, option.parentId, option.disabled].join(':')).join('|'),
      element.getAttribute('type') || element.getAttribute('role') || element.tagName,
    ]).map(value => value.trim().toLowerCase()).filter(Boolean).join('\u001f');
    let hash = 0x811c9dc5;
    for (let index = 0; index < source.length; index++) {
      hash ^= source.charCodeAt(index);
      hash = Math.imul(hash, 0x01000193);
    }
    return `field-v3-${(hash >>> 0).toString(16).padStart(8, '0')}`;
  }

  getCorrectionOptions(element: HTMLElement): string[] {
    return getControlOptions(element);
  }

  getCorrectionCandidates(element: HTMLElement) {
    return getOptions(element).filter(option => !option.disabled);
  }

  getLearnedValue(entry: LearnedFieldValue | undefined, profile: UserProfile): string {
    return resolveLearnedValue(entry, profile);
  }

  getVerifiedCount(): number {
    return [...this.outcomes.values()].filter(outcome => outcome.status === 'verified').length;
  }

  async revalidate(): Promise<number> {
    for (const [element, intent] of this.intents) {
      if (this.outcomes.get(element)?.status !== 'verified') continue;
      const outcome = await verifyControl(element, intent.value, { ...intent.context, settleMs: 60 });
      this.outcomes.set(element, outcome);
      if (outcome.status !== 'verified') this.recordFailure(element, intent.value, intent.context.semantic || 'unknown');
    }
    return this.getVerifiedCount();
  }

  async undoLastFill(): Promise<number> {
    let restored = 0;
    for (const [element, snapshot] of [...this.previousValues.entries()].reverse()) {
      if (!element.isConnected) continue;
      const intent = this.intents.get(element);
      // A user edit after filling belongs to the user and must survive Undo.
      if (!intent || (await verifyControl(element, intent.value, { ...intent.context, shouldContinue: undefined, settleMs: 0 })).status !== 'verified') continue;
      if (element instanceof HTMLSelectElement && snapshot.selection) {
        const targets = snapshot.selection.map(selected => Array.from(element.options)
          .filter(option => option.value === selected.value && option.text.trim() === selected.label));
        if (targets.some(matches => matches.length !== 1)) continue;
        const selectedOptions = new Set(targets.flat());
        Array.from(element.options).forEach(option => { option.selected = selectedOptions.has(option); });
        if (selectedOptions.size === 0) element.selectedIndex = -1;
        this.triggerEvents(element);
      } else if (snapshot.choices) {
        const kind = observeControl(element).kind;
        const originalSelection = snapshot.choices.filter(choice => choice.checked);
        // Radio has no standard operation for returning to an unselected state.
        // Do not fake a React state reset by assigning checked=false.
        if (kind === 'radio' && originalSelection.length === 0) continue;
        if (snapshot.choices.some(choice => !choice.element.isConnected)) continue;
        if (kind === 'radio') originalSelection[0].element.click();
        else for (const choice of snapshot.choices) {
          if (isOptionSelected(choice.element) !== choice.checked) choice.element.click();
        }
      } else if (observeControl(element).kind === 'text' && (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement)) {
        const prototype = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
        Object.getOwnPropertyDescriptor(prototype, 'value')?.set?.call(element, snapshot.value);
        this.triggerEvents(element);
      } else if (snapshot.value) {
        await fillControl(element, snapshot.value, { overwrite: true });
      } else continue;
      await this.wait(450);
      if (getControlValue(element) === snapshot.value) restored++;
    }
    this.previousValues.clear();
    this.intents.clear();
    this.outcomes.clear();
    return restored;
  }
  // 字节等网申页面常见模式：经历条目需要先点击“添加”才会出现空白行
  async prepareDynamicSections(profile: UserProfile, section: FillSection = 'all', shouldContinue: () => boolean = () => true): Promise<boolean> {
    let changed = false;
    if (shouldContinue() && (section === 'all' || section === 'education')) {
      changed = await this.ensureEducationRows(profile.education.length, shouldContinue) || changed;
    }
    if (shouldContinue() && (section === 'all' || section === 'experience')) {
      changed = await this.ensureExperienceRows(profile.experience.length, shouldContinue) || changed;
    }
    if (shouldContinue() && (section === 'all' || section === 'projects')) {
      changed = await this.ensureProjectRows(profile.projects.length, shouldContinue) || changed;
    }
    return changed;
  }

  async fillElementValues(
    values: Array<{
      element: HTMLElement;
      value: string;
      semantic?: string;
      optionRef?: string;
      overwrite?: boolean;
    }>,
    shouldContinue: () => boolean = () => true
  ): Promise<number> {
    let filledCount = 0;

    for (const item of values) {
      if (!shouldContinue()) break;
      if (!item.value) continue;
      if (await this.fillField(item.element, item.value, { semantic: item.semantic, optionRef: item.optionRef, overwrite: item.overwrite, shouldContinue })) {
        this.failures.delete(item.element);
        filledCount++;
      } else if (!['unchanged', 'cancelled', 'user-edited'].includes(this.outcomes.get(item.element)?.status || '')) {
        this.recordFailure(item.element, item.value, item.semantic || 'aiMatched');
      }
    }

    return filledCount;
  }

  async fillFocusedControl(element: HTMLElement, value: string): Promise<boolean> {
    return this.fillField(element, value, { overwrite: true });
  }

  // 填充所有检测到的字段
  async fillForm(
    fields: DetectedField[],
    profile: UserProfile,
    learnedValues: Record<string, LearnedFieldValue> = {},
    shouldContinue: () => boolean = () => true,
  ): Promise<void> {
    const bindings = bindFieldRecords(fields, profile);
    const orderedFields = [...fields].sort((a, b) => {
      const aBinding = bindings.get(a.element);
      const bBinding = bindings.get(b.element);
      if (aBinding?.container === bBinding?.container) {
        const end = (field: DetectedField) => /endDate|graduationDate|projectEndDate/.test(field.fieldType);
        return Number(end(b)) - Number(end(a));
      }
      return 0;
    });
    for (const field of orderedFields) {
      if (!shouldContinue()) break;
      if (getControlValue(field.element)) continue;
      const binding = bindings.get(field.element);
      const section = recordSection(field.fieldType);
      if (section && !binding) {
        this.outcomes.set(field.element, { status: 'needs-mapping', reason: '无法将这一组字段绑定到对应经历' });
        this.recordFailure(field.element, '', field.fieldType);
        continue;
      }
      const signature = this.getFieldSignature(field.element);
      const value = this.getLearnedValue(learnedValues[signature], profile)
        || this.getValueForField(field.fieldType as FieldType, profile,
          binding?.section === 'education' ? binding.index : undefined,
          binding?.section === 'experience' ? binding.index : undefined,
          binding?.section === 'projects' ? binding.index : undefined);
      if (value === null || value === undefined || value === '') {
        this.outcomes.set(field.element, { status: 'needs-data', reason: '资料中缺少此字段的答案' });
        this.recordFailure(field.element, '', field.fieldType);
        continue;
      }
      if (await this.fillField(field.element, value, { semantic: field.fieldType, shouldContinue })) this.failures.delete(field.element);
      else this.recordFailure(field.element, value, field.fieldType);
    }
    if (shouldContinue()) await this.revalidate();
  }

  buildFillPreview(fields: DetectedField[], profile: UserProfile): FillPreviewItem[] {
    const bindings = bindFieldRecords(fields, profile);
    return fields.flatMap(field => {
      const binding = bindings.get(field.element);
      if (recordSection(field.fieldType) && !binding) return [];
      const value = this.getValueForField(field.fieldType as FieldType, profile,
        binding?.section === 'education' ? binding.index : undefined,
        binding?.section === 'experience' ? binding.index : undefined,
        binding?.section === 'projects' ? binding.index : undefined);
      return value ? [{ fieldType: field.fieldType, label: getControlLabel(field.element) || field.fieldType, value }] : [];
    });
  }

  private recordFailure(
    element: HTMLElement,
    attemptedValue: string,
    fieldType: string,
    labelOverride = '',
  ): void {
    const root = element.getRootNode() as Document | ShadowRoot;
    const label = labelOverride
      || (isChoiceControl(element) ? getChoiceQuestion(element) : '')
      || element.getAttribute('aria-label')
      || (element.id ? root.querySelector(`label[for="${CSS.escape(element.id)}"]`)?.textContent : '')
      || element.closest('label')?.textContent
      || element.getAttribute('placeholder')
      || element.getAttribute('name')
      || fieldType;
    this.failures.set(element, {
      element,
      signature: this.getFieldSignature(element),
      fieldType,
      label: getChineseFieldLabel(label || fieldType, fieldType),
      attemptedValue,
      outcome: this.outcomes.get(element),
    });
  }

  private getSectionForElement(element: Element): FillSection | null {
    let current: Element | null = element;

    while (current && current !== document.body) {
      const text = (current.textContent || '').replace(/\s+/g, ' ');
      if (/教育经历|学历类型|学校名称|学院|导师|education|university|degree/i.test(text)) return 'education';
      if (/实习经历|没有实习经历|公司名称|职位名称|work experience|employment|employer/i.test(text)) return 'experience';
      if (/项目经历|项目名称|项目角色|project experience|projects/i.test(text)) return 'projects';
      if (/基本信息|手机号码|个人证件|personal information|contact information/i.test(text)) return 'personal';
      current = current.parentElement;
    }

    return null;
  }

  private async ensureEducationRows(targetCount: number, shouldContinue: () => boolean): Promise<boolean> {
    if (targetCount <= 1) return false;

    return this.ensureRows({
      moduleKeyword: '教育经历',
      rowFieldName: ['school', 'school_name', 'university'],
      targetCount,
      shouldContinue,
    });
  }

  private async ensureExperienceRows(targetCount: number, shouldContinue: () => boolean): Promise<boolean> {
    if (targetCount === 0) return false;
    let changed = false;

    const internshipModule = this.findModule('实习经历');
    const noExperienceCheckbox = internshipModule
      ?.querySelector<HTMLInputElement>('input[type="checkbox"]');
    const noExperienceSelected = noExperienceCheckbox?.checked
      || noExperienceCheckbox?.getAttribute('aria-checked') === 'true';

    if (shouldContinue() && noExperienceCheckbox && noExperienceSelected) {
      noExperienceCheckbox.click();
      changed = true;
      await this.waitFor(
        () => !noExperienceCheckbox.checked && noExperienceCheckbox.getAttribute('aria-checked') !== 'true',
        600,
      );
    }

    return await this.ensureRows({
      moduleKeyword: '实习经历',
      rowFieldName: ['company', 'company_name', 'employer'],
      targetCount,
      shouldContinue,
    }) || changed;
  }

  private async ensureProjectRows(targetCount: number, shouldContinue: () => boolean): Promise<boolean> {
    if (targetCount <= 1) return false;
    return this.ensureRows({
      moduleKeyword: '项目经历',
      rowFieldName: ['name', 'project_name', 'projectName'],
      targetCount,
      shouldContinue,
    });
  }

  private async ensureRows(options: {
    moduleKeyword: string;
    rowFieldName: string | string[];
    targetCount: number;
    shouldContinue: () => boolean;
  }): Promise<boolean> {
    let changed = false;
    for (let attempts = 0; attempts < options.targetCount + 3 && options.shouldContinue(); attempts++) {
      const currentCount = this.countFieldsInModule(options.moduleKeyword, options.rowFieldName);
      if (currentCount >= options.targetCount) return changed;

      const addButton = this.findAddButton(options.moduleKeyword);
      if (!addButton) return changed;

      addButton.click();
      changed = true;
      const added = await this.waitFor(
        () => this.countFieldsInModule(options.moduleKeyword, options.rowFieldName) > currentCount,
        1200,
      );
      if (!added) break;
    }
    return changed;
  }

  private findModule(keyword: string): HTMLElement | null {
    const aliases: Record<string, string[]> = {
      教育经历: ['教育经历', '教育背景', 'Education'],
      实习经历: ['实习经历', '工作经历', 'Work Experience', 'Employment', 'Experience'],
      项目经历: ['项目经历', 'Projects', 'Project Experience'],
    };
    const terms = aliases[keyword] || [keyword];
    const modules = Array.from(document.querySelectorAll<HTMLElement>(
      '[class*=applyFormModuleWrapper], section, fieldset, [role="group"]'
    ));

    return modules
      .filter(module => terms.some(term => (module.textContent || '').toLowerCase().includes(term.toLowerCase())))
      .sort((a, b) => b.querySelectorAll('input, textarea, select, button').length - a.querySelectorAll('input, textarea, select, button').length)[0] || null;
  }

  private countFieldsInModule(moduleKeyword: string, fieldName: string | string[]): number {
    const module = this.findModule(moduleKeyword);
    if (!module) return 0;
    const fieldNames = new Set(Array.isArray(fieldName) ? fieldName : [fieldName]);

    return Array.from(module.querySelectorAll<HTMLElement>(
      'input:not([type="hidden"]), textarea, select'
    )).filter(element => {
      const container = element.closest<HTMLElement>(
        '[data-form-field-id], [data-form-field-name], [data-form-field-i18n-name]'
      );
      return (
        fieldNames.has(element.getAttribute('data-form-field-name') || '') ||
        fieldNames.has(element.getAttribute('data-form-field-id') || '') ||
        fieldNames.has(element.getAttribute('name') || '') ||
        fieldNames.has(container?.getAttribute('data-form-field-name') || '') ||
        fieldNames.has(container?.getAttribute('data-form-field-id') || '')
      );
    }).length;
  }

  private findAddButton(moduleKeyword: string): HTMLButtonElement | null {
    const module = this.findModule(moduleKeyword);
    if (!module) return null;

    return Array.from(module.querySelectorAll<HTMLButtonElement>('button'))
      .find(button => /^(添加|新增|add|add another|new)$/i.test((button.textContent || '').trim()) && !button.disabled) || null;
  }

  private wait(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  private waitFor(predicate: () => boolean, timeoutMs: number): Promise<boolean> {
    if (predicate()) return Promise.resolve(true);
    return new Promise(resolve => {
      let settled = false;
      const finish = (result: boolean) => {
        if (settled) return;
        settled = true;
        observer.disconnect();
        window.clearTimeout(timer);
        resolve(result);
      };
      const observer = new MutationObserver(() => {
        if (predicate()) finish(true);
      });
      observer.observe(document.body, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ['class', 'aria-expanded', 'aria-selected', 'value'],
      });
      const timer = window.setTimeout(() => finish(predicate()), timeoutMs);
    });
  }

  // 根据字段类型获取对应的值
  private getValueForField(
    fieldType: FieldType,
    profile: UserProfile,
    educationIndex = 0,
    experienceIndex = 0,
    projectIndex = 0,
  ): string | null {
    const education = profile.education[educationIndex];
    const experience = profile.experience[experienceIndex];
    const project = profile.projects[projectIndex];
    const educationDates = this.getOrderedDateRange(education?.startDate, education?.endDate);
    const experienceDates = this.getOrderedDateRange(experience?.startDate, experience?.endDate);

    switch (fieldType) {
      case FieldType.NAME:
        return profile.personal.name || null;

      case FieldType.GENDER:
        return this.normalizeGender(profile.personal.gender);

      case FieldType.BIRTH_DATE:
        return profile.personal.birthDate || null;

      case FieldType.PHONE:
        return profile.personal.phone || null;

      case FieldType.EMAIL:
        return profile.personal.email || null;

      case FieldType.WECHAT:
        return profile.personal.wechat || null;

      case FieldType.ID_CARD:
        return profile.personal.idCard || null;

      case FieldType.POLITICAL_STATUS:
        return profile.personal.politicalStatus || null;

      case FieldType.ETHNICITY:
        return profile.personal.ethnicity || null;

      case FieldType.HOMETOWN:
        return profile.personal.hometown || null;

      case FieldType.CURRENT_ADDRESS:
        return profile.personal.currentAddress || null;

      case FieldType.SELF_EVALUATION:
        return profile.personal.selfEvaluation || null;

      case FieldType.SCHOOL:
        return education?.school || null;

      case FieldType.COLLEGE:
        return education?.college || null;

      case FieldType.EDUCATION_TYPE:
        return education?.educationType || null;

      case FieldType.MAJOR:
        return education?.major || null;

      case FieldType.MAJOR_CATEGORY:
        return education?.majorCategory || null;

      case FieldType.DEGREE:
        // 保留用户保存的“硕士研究生/本科”等完整层次；下拉框会再按网站选项匹配同义值。
        return education?.degree || null;

      case FieldType.ACADEMIC_DEGREE:
        return education?.academicDegree || null;

      case FieldType.GPA:
        return education?.gpa || null;

      case FieldType.EDUCATION_START_DATE:
        return educationDates.start || null;

      case FieldType.GRADUATION_DATE:
        return educationDates.end || null;

      case FieldType.COMPANY:
        return experience?.company || null;

      case FieldType.POSITION:
        return experience?.position || null;

      case FieldType.START_DATE:
        return experienceDates.start || null;

      case FieldType.END_DATE:
        return experienceDates.end || null;

      case FieldType.DESCRIPTION:
        return experience?.description || null;

      case FieldType.PROJECT_NAME:
        return project?.name || null;
      case FieldType.PROJECT_ROLE:
        return project?.role || null;
      case FieldType.PROJECT_START_DATE:
        return project?.startDate || null;
      case FieldType.PROJECT_END_DATE:
        return project?.endDate || null;
      case FieldType.PROJECT_DESCRIPTION:
        return project?.description || null;
      case FieldType.PROJECT_ACHIEVEMENTS:
        return project?.achievements || null;
      case FieldType.PROJECT_TECHNOLOGIES:
        return project?.technologies || null;

      case FieldType.SKILLS:
        return profile.skills.join(', ') || null;

      default:
        return null;
    }
  }

  private getOrderedDateRange(
    startDate?: string,
    endDate?: string
  ): { start: string; end: string } {
    if (!startDate || !endDate) {
      return { start: startDate || '', end: endDate || '' };
    }

    const start = parseFlexibleDate(startDate);
    const end = parseFlexibleDate(endDate);
    if (start && end) {
      const startParts = [start.year, start.month, start.day];
      const endParts = [end.year, end.month, end.day];
      for (let part = 0; part < 3; part++) {
        if (startParts[part] === undefined || endParts[part] === undefined) break;
        if (startParts[part]! < endParts[part]!) break;
        if (startParts[part]! > endParts[part]!) return { start: '', end: '' };
      }
    }
    return { start: startDate, end: endDate };
  }

  // 标准化性别值
  private normalizeGender(gender: string): string | null {
    if (!gender) return null;

    const genderLower = gender.toLowerCase();

    // 检查男性
    if (GENDER_OPTIONS.male.some((opt) => opt.toLowerCase() === genderLower)) {
      return '男';
    }

    // 检查女性
    if (GENDER_OPTIONS.female.some((opt) => opt.toLowerCase() === genderLower)) {
      return '女';
    }

    return gender;
  }

  private async fillField(element: HTMLElement, value: string, context: FillContext = {}): Promise<boolean> {
    if (!this.previousValues.has(element)) {
      this.previousValues.set(element, {
        value: getControlValue(element),
        ...(['radio', 'checkbox'].includes(observeControl(element).kind)
          ? { choices: getOptions(element).map(option => ({ element: option.element, checked: isOptionSelected(option.element) })) } : {}),
        ...(element instanceof HTMLSelectElement
          ? { selection: Array.from(element.selectedOptions).map(option => ({ value: option.value, label: option.text.trim() })) } : {}),
      });
    }
    const outcome = await fillControl(element, value, context);
    this.outcomes.set(element, outcome);
    if (outcome.status === 'verified') this.intents.set(element, { value, context });
    return outcome.status === 'verified' || (context.overwrite === true && outcome.status === 'unchanged');
  }

  private triggerEvents(element: HTMLElement): void {
    element.dispatchEvent(new Event('input', { bubbles: true }));
    element.dispatchEvent(new Event('change', { bubbles: true }));
    element.dispatchEvent(new FocusEvent('blur'));
    element.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
  }

  // 上传简历文件
  async uploadResume(
    fileInput: HTMLInputElement,
    fileData: string,
    fileName: string
  ): Promise<void> {
    try {
      // 将 base64 转换为 Blob
      const blob = this.base64ToBlob(fileData);

      // 创建 File 对象
      const file = new File([blob], fileName, { type: blob.type });

      // 创建 DataTransfer 对象
      const dataTransfer = new DataTransfer();
      dataTransfer.items.add(file);

      // 设置文件
      fileInput.files = dataTransfer.files;

      // 触发 change 事件
      this.triggerEvents(fileInput);

      console.log(`Resume uploaded: ${fileName}`);
    } catch (error) {
      console.error('Failed to upload resume:', error);
      throw error;
    }
  }

  // 将 base64 转换为 Blob
  private base64ToBlob(base64Data: string): Blob {
    // 提取 MIME 类型和数据
    const parts = base64Data.split(',');
    const mimeMatch = parts[0].match(/:(.*?);/);
    const mime = mimeMatch ? mimeMatch[1] : 'application/octet-stream';
    const base64String = parts[1] || parts[0];

    // 解码 base64
    const binaryString = atob(base64String);
    const bytes = new Uint8Array(binaryString.length);

    for (let i = 0; i < binaryString.length; i++) {
      bytes[i] = binaryString.charCodeAt(i);
    }

    return new Blob([bytes], { type: mime });
  }
}
