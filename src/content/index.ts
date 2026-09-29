import { findFormSectionHeading } from '../utils/formContext.ts';
import type { GroundedMapping } from '../services/llm/fieldMapping.ts';
import { discoverControls, observeControl, getControlLabel, getOptions } from './controlObservation.ts';
import { dateRangePart, findRecordContainer, recordSection, bindFieldRecords } from './fieldBinding.ts';
import { FormDetector, type UnmatchedField } from './formDetector';
import { FormFiller, type FillFailure, type FillSection } from './formFiller';
import { OpenQuestionDetector } from './openQuestionDetector';
import type { PageScanField, PageScanSection } from './pageScan';
import { FieldMatcher } from '../utils/fieldMatcher';
import {
  getChoiceQuestion,
  getControlOptions,
  getLogicalControlValue,
  isChoiceControl,
} from './controlSemantics';
import { extractApplicationPageMetadata } from './applicationRecordMetadata.ts';
import { createVisualRegionFillController } from './visualRegionFill.ts';
import { createInfoOverlayController } from './infoOverlay.ts';
import { findCustomInformationValue } from '../shared/learnedFields.ts';
import { getChineseFieldLabel } from '../shared/fieldLabels.ts';
import { buildProfileForResume, resolveResumeSelection } from '../shared/resumes.ts';
import type {
  DetectedField,
  FocusedFieldWriteResult,
  LearnedFieldValue,
  Message,
  MessageResponse,
  UserProfile,
} from '../shared/types';

async function sendRuntimeMessage<T = any>(message: Message): Promise<MessageResponse<T>> {
  try {
    return await chrome.runtime.sendMessage(message) as MessageResponse<T>;
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  }
}

console.log('Content script loaded');

// 初始化
const formDetector = new FormDetector();
const formFiller = new FormFiller();
const visualRegionFillController = createVisualRegionFillController({
  sendRuntimeMessage,
  fillElementValues: (values, shouldContinue) => formFiller.fillElementValues(
    values as Parameters<FormFiller['fillElementValues']>[0],
    shouldContinue,
  ),
  onFillComplete: () => showFailureReview(formFiller.getLastFailures()),
  verifyFilled: () => formFiller.revalidate(),
  onSessionStateChange: active => {
    visualFillRunning = active;
    if (active) formFiller.beginFillSession();
  },
  describeFields: elements => {
    const fields = formDetector.detectFields();
    const meanings = new Map(fields.map(field => [field.element, field]));
    const identities = new Map(elements.map(element => [element, FieldMatcher.extractIdentifiers(element).labelText]));
    const groups = new Map<HTMLElement, string>();
    return new Map(elements.map(element => {
      const field = meanings.get(element);
      const group = field && recordSection(field.fieldType) ? findRecordContainer(field, fields) : findLogicalFormBlock(element, elements, identities);
      if (!groups.has(group)) groups.set(group, `visual-block-${groups.size}`);
      return [element, { semantic: field?.fieldType, blockId: groups.get(group) }];
    }));
  },
});
let detectedFields: DetectedField[] = [];
let fillPreviewSnapshot: { fields: DetectedField[]; createdAt: number } | null = null;
let aiPageFillRunning = false;
let localFillRunning = false;
let visualFillRunning = false;
let lastFocusedControl: HTMLElement | null = null;

const infoOverlayController = createInfoOverlayController({
  getProfile: async resumeId => {
    const response = await sendRuntimeMessage<UserProfile>({ type: 'GET_USER_PROFILE' });
    return response.success && response.data
      ? buildProfileForResume(response.data, resumeId)
      : null;
  },
  writeValue: async value => {
    const response = await sendRuntimeMessage<FocusedFieldWriteResult>({
      type: 'WRITE_FOCUSED_FIELD_FROM_PAGE',
      payload: { value },
    });
    return response.success && response.data
      ? response.data
      : { written: false, reason: response.error || 'VALUE_REJECTED' };
  },
  openSettings: () => chrome.runtime.openOptionsPage(),
});

async function getLearnedFieldValues(): Promise<Record<string, LearnedFieldValue>> {
  const response = await sendRuntimeMessage<Record<string, LearnedFieldValue>>({
    type: 'GET_LEARNED_FIELD_VALUES',
    payload: { domain: window.location.hostname },
  });
  return response.success && response.data ? response.data : {};
}

document.addEventListener('focusin', (event) => {
  const target = event.target;
  if (isWritableControl(target)) {
    lastFocusedControl = target;
  }
}, true);

function isWritableControl(target: EventTarget | null): target is HTMLElement {
  if (!(target instanceof HTMLElement)) return false;
  const observed = observeControl(target);
  return !observed.disabled && observed.kind !== 'unsupported'
    && (!observed.readOnly || observed.kind === 'combobox' || Boolean(target.closest('.ant-picker, .el-date-editor, [data-picker]')));
}

async function applyValueToFocusedControl(value: string): Promise<FocusedFieldWriteResult> {
  if (aiPageFillRunning || localFillRunning || visualFillRunning) return { written: false, reason: 'FILL_IN_PROGRESS' };
  // 主页面当前聚焦的是 iframe 时，不使用主页面残留的旧字段，让后台继续到子 frame 查找。
  if (document.activeElement instanceof HTMLIFrameElement) {
    return { written: false, reason: 'NO_FOCUSED_FIELD' };
  }
  if (!lastFocusedControl && isWritableControl(document.activeElement)) {
    lastFocusedControl = document.activeElement;
  }
  if (!lastFocusedControl) {
    return { written: false, reason: 'NO_FOCUSED_FIELD' };
  }
  if (!lastFocusedControl.isConnected) {
    lastFocusedControl = null;
    return { written: false, reason: 'FIELD_DETACHED' };
  }
  if (!isWritableControl(lastFocusedControl)) {
    return { written: false, reason: 'FIELD_NOT_WRITABLE' };
  }

  const written = await formFiller.fillFocusedControl(lastFocusedControl, value);
  return written
    ? { written: true }
    : { written: false, reason: 'VALUE_REJECTED' };
}

// 页面加载完成后检测表单
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initializeDetection);
} else {
  initializeDetection();
}

function initializeDetection() {
  // 延迟检测，等待动态内容加载
  setTimeout(() => {
    detectedFields = formDetector.detectFields();
    injectAIButtons();
  }, 1000);

  // 开始监听 DOM 变化
  formDetector.startObserving((fields) => {
    detectedFields = fields;
    if (fields.length > 0) {
      console.log(`Re-detected ${fields.length} fields`);
      injectAIButtons();
    }
  });
}

// 处理填充按钮点击
async function handleFillButtonClick(reusePreview = false, resumeId?: string | null) {
  await fillSection('all', { reusePreview, resumeId });
}

async function handleAIPageFill(resumeId?: string | null) {
  if (aiPageFillRunning || localFillRunning || visualFillRunning) {
    showAIRegionStatus('AI 渐进补填已经在运行中').update('AI 渐进补填已经在运行中', 'warning');
    return;
  }
  aiPageFillRunning = true;
  const status = showAIRegionStatus('正在扫描整页表单...');
  const requestId = crypto.randomUUID();
  let cancelled = false;
  let filledCount = 0;
  let uploadedResumeCount = 0;

  status.setCancelHandler(async () => {
    if (cancelled) return;
    cancelled = true;
    status.update('正在终止 AI 扫描填充...');
    await sendRuntimeMessage({
      type: 'CANCEL_AI_FILL',
      payload: { requestId },
    });
    status.update('AI 扫描填充已终止', 'warning');
  });

  try {
    const response = await sendRuntimeMessage<UserProfile>({
      type: 'GET_USER_PROFILE',
    });
    if (!response.success || !response.data) {
      throw new Error('请先在插件选项页面中设置个人信息');
    }
    const fillProfile = buildProfileForResume(response.data, resumeId);

    if (cancelled) return;
    await formFiller.prepareDynamicSections(fillProfile, 'all', () => !cancelled);
    if (cancelled) return;
    formFiller.beginFillSession();
    detectedFields = formDetector.detectFields();
    const learnedValues = await getLearnedFieldValues();
    if (cancelled) return;

    // AI 只处理本地规则无法确定的字段。姓名、邮箱、学历、经历等已识别
    // 字段先直接填写，避免把整份资料反复发送给模型。
    status.update('正在用本地资料快速填写已识别字段...');
    const locallyMatchedFields = detectedFields.filter(field => (
      isLikelyApplicationControl(field.element)
    ));
    await formFiller.fillForm(locallyMatchedFields, fillProfile, learnedValues, () => !cancelled);
    if (cancelled) return;
    let scannedFields = collectPageScanFields();
    filledCount = formFiller.getVerifiedCount();

    const learnedFillItems = scannedFields.flatMap(field => {
      const learned = learnedValues[formFiller.getFieldSignature(field.element)];
      const value = formFiller.getLearnedValue(learned, fillProfile)
        || findCustomInformationValue(fillProfile.customInformation, field.label);
      return value ? [{ element: field.element, value }] : [];
    });
    if (learnedFillItems.length > 0) {
      filledCount += await formFiller.fillElementValues(learnedFillItems, () => !cancelled);
      scannedFields = collectPageScanFields();
    }
    if (cancelled) return;
    const selectedResume = resolveResumeSelection(response.data, resumeId);
    const fileInputs = formDetector.findFileInputs();
    if (selectedResume) {
      for (const fileInput of fileInputs) {
        if (cancelled) return;
        await formFiller.uploadResume(fileInput, selectedResume.fileData, selectedResume.fileName);
        uploadedResumeCount++;
      }
    }
    if (cancelled) return;
    if (scannedFields.length === 0) {
      filledCount = await formFiller.revalidate();
      if (cancelled) return;
      status.update(
        filledCount > 0 || uploadedResumeCount > 0
          ? `已填 ${filledCount} 项${uploadedResumeCount > 0 ? `，上传简历 ${uploadedResumeCount} 处` : ''}`
          : '未检测到可扫描的空白表单字段',
        filledCount > 0 || uploadedResumeCount > 0 ? 'success' : 'warning',
      );
      showFailureReview(formFiller.getLastFailures());
      return;
    }

    const aiFieldCount = scannedFields.length;
    status.update(`AI 将按字段组补填 ${aiFieldCount} 个剩余字段，已完成 ${filledCount} 项...`);
    filledCount += await fillPageScanProgressively(
      'other',
      scannedFields,
      requestId,
      resumeId,
      () => !cancelled,
      ({ processedCount, filledCount: aiFilledCount, label }) => {
        status.update(
          `AI 补填 ${processedCount}/${aiFieldCount}：${label || '未命名字段'}；累计已填 ${filledCount + aiFilledCount} 项`,
        );
      },
      fillProfile,
    );

    if (cancelled) return;

    // 只复盘真正的正式必填项；组件内部辅助输入框和无标题控件不打扰用户。
    const remainingFields = collectPageScanFields();
    for (const candidate of collectUnresolvedReviewCandidates(
      remainingFields.map(field => ({ element: field.element, preferredLabel: field.label })),
    )) {
      formFiller.markUnresolvedField(candidate.element, candidate.label);
    }

    filledCount = await formFiller.revalidate();
    if (cancelled) return;
    status.update(
      `AI 扫描填充完成：已填 ${filledCount} 项${uploadedResumeCount > 0 ? `，上传简历 ${uploadedResumeCount} 处` : ''}`,
      'success',
    );
    showFailureReview(formFiller.getLastFailures());
  } catch (error) {
    if (cancelled) return;
    console.error('AI page scan fill failed:', error);
    for (const candidate of collectUnresolvedReviewCandidates(
      collectPageScanFields().map(field => ({
        element: field.element,
        preferredLabel: field.label,
      })),
    )) {
      formFiller.markUnresolvedField(candidate.element, candidate.label);
    }
    status.update(
      `AI 扫描已停止：${error instanceof Error ? error.message : '未知错误'}；已填写的 ${filledCount} 项会保留`,
      filledCount > 0 || uploadedResumeCount > 0 ? 'warning' : 'error',
    );
    showFailureReview(formFiller.getLastFailures());
  } finally {
    aiPageFillRunning = false;
  }
}

async function fillSection(
  section: FillSection,
  options: { reusePreview?: boolean; resumeId?: string | null } = {},
) {
  if (localFillRunning || aiPageFillRunning || visualFillRunning) return;
  localFillRunning = true;
  try {
    // 获取用户资料
    const response = await sendRuntimeMessage<UserProfile>({
      type: 'GET_USER_PROFILE'
    });

    if (!response.success || !response.data) {
      alert('请先在插件选项页面中设置个人信息！');
      return;
    }
    const fillProfile = buildProfileForResume(response.data, options.resumeId);

    // 预览刚刚完成且页面结构没有变化时，直接复用预览字段，避免再次扫描整页。
    const dynamicSectionsChanged = await formFiller.prepareDynamicSections(fillProfile, section);
    const reusablePreview = options.reusePreview
      && !dynamicSectionsChanged
      && fillPreviewSnapshot
      && Date.now() - fillPreviewSnapshot.createdAt < 30_000
      && fillPreviewSnapshot.fields.every(field => field.element.isConnected);
    detectedFields = reusablePreview
      ? fillPreviewSnapshot!.fields
      : formDetector.detectFields();
    fillPreviewSnapshot = null;

    // 网站字段学习结果不依赖本次识别是否成功：即使规则和 AI 都不认识该字段，
    // 只要它与用户上次纠正的控件签名一致，就直接优先尝试填写。
    formFiller.beginFillSession();
    const learnedValues = await getLearnedFieldValues();
    const learnedUnmatchedItems = formDetector.getUnmatchedFields()
      .filter(({ element }) => section === 'all' || getElementSection(element) === section)
      .filter(({ element }) => !getControlValue(element) && isLikelyApplicationControl(element))
      .flatMap((unmatched) => {
        const { element } = unmatched;
        const learned = learnedValues[formFiller.getFieldSignature(element)];
        const value = formFiller.getLearnedValue(learned, fillProfile)
          || findCustomInformationValue(
            fillProfile.customInformation,
            getUnmatchedFieldLabel(unmatched),
          );
        return value ? [{ element, value }] : [];
      });
    const learnedUnmatchedCount = await formFiller.fillElementValues(learnedUnmatchedItems);

    const fieldsToFill = filterFieldsBySection(detectedFields, section)
      .filter(field => isLikelyApplicationControl(field.element));
    const selectedResume = resolveResumeSelection(response.data, options.resumeId);
    const fileInputs = formDetector.findFileInputs();

    if (
      fieldsToFill.length === 0
      && learnedUnmatchedCount === 0
      && formFiller.getLastFailures().length === 0
      && !(selectedResume && fileInputs.length > 0)
    ) {
      alert('未检测到可填充的表单字段');
      return;
    }

    // 填充表单
    await formFiller.fillForm(fieldsToFill, fillProfile, learnedValues);

    // 处理简历文件上传
    if (fileInputs.length > 0 && selectedResume) {
      for (const fileInput of fileInputs) {
        try {
          await formFiller.uploadResume(
            fileInput,
            selectedResume.fileData,
            selectedResume.fileName
          );
        } catch (error) {
          console.error('Failed to upload resume to input:', error);
        }
      }
    }

    // 显示成功消息
    showSuccessMessage();
    for (const candidate of collectUnresolvedReviewCandidates(
      formDetector.getUnmatchedFields().map(unmatched => ({
        element: unmatched.element,
        preferredLabel: getUnmatchedFieldLabel(unmatched),
      })),
    )) {
      formFiller.markUnresolvedField(candidate.element, candidate.label);
    }
    showFailureReview(formFiller.getLastFailures());

  } catch (error) {
    console.error('Fill form error:', error);
    alert('填充表单时出错，请查看控制台了解详情');
  } finally {
    localFillRunning = false;
  }
}

function filterFieldsBySection(fields: DetectedField[], section: FillSection): DetectedField[] {
  if (section === 'all') return fields;

  return fields.filter(field => getElementSection(field.element) === section);
}

function getElementSection(element: Element): FillSection | null {
  const text = findFormSectionHeading(element);
  if (/基本信息|个人信息|personal information|contact information/i.test(text)) return 'personal';
  if (/教育经历|教育背景|本科|硕士|博士|education/i.test(text)) return 'education';
  if (/实习经历|工作经历|work experience|employment/i.test(text)) return 'experience';
  if (/项目经历|project experience|projects/i.test(text)) return 'projects';
  return null;
}

function startAIRegionSelection() {
  if (aiPageFillRunning || localFillRunning || visualFillRunning) return;
  visualRegionFillController.beginVisualRegionFill();
}

type ScannedPageField = PageScanField & {
  element: HTMLElement;
};

function collectPageScanFields(): ScannedPageField[] {
  const elements = discoverControls(document).filter(element => {
    const root = element.getRootNode();
    if (element.closest('[data-job-applymate-ui], [data-job-applymate-overlay]') || (root instanceof ShadowRoot && root.host.matches('[data-job-applymate-ui], [data-job-applymate-overlay]'))) return false;
    const observed = observeControl(element);
    return !observed.disabled && !getControlValue(element) && isLikelyApplicationControl(element);
  });
  const blockIds = new WeakMap<HTMLElement, string>();
  const blockRows = new Map<PageScanSection, Map<HTMLElement, number>>();
  const fieldIdentities = new Map(elements.map(element => {
    const identifiers = FieldMatcher.extractIdentifiers(element);
    const identity = (identifiers.labelText || identifiers.name || identifiers.placeholder)
      .replace(/\d+/g, '#')
      .replace(/\s+/g, '')
      .toLowerCase();
    return [element, identity] as const;
  }));
  let nextBlockId = 1;

  return elements.map((element, index) => {
    const container = element.closest<HTMLElement>(
      '[data-form-field-id], [data-form-field-name], [data-form-field-i18n-name]',
    );
    const name = (
      element.getAttribute('data-form-field-name') ||
      container?.getAttribute('data-form-field-name') ||
      element.getAttribute('data-form-field-id') ||
      container?.getAttribute('data-form-field-id') ||
      (element as HTMLInputElement).name ||
      ''
    ).trim();
    const identifiers = FieldMatcher.extractIdentifiers(element);
    const baseLabel = (
      (isChoiceControl(element) ? getChoiceQuestion(element) : '') ||
      element.getAttribute('data-form-field-i18n-name') ||
      container?.getAttribute('data-form-field-i18n-name') ||
      identifiers.labelText ||
      getControlLabel(element) ||
      identifiers.placeholder ||
      ''
    ).trim();
    const rangePart = dateRangePart(element);
    const label = baseLabel + (rangePart === 'start' ? ' 开始时间' : rangePart === 'end' ? ' 结束时间' : '');
    const section = toPageScanSection(getElementSection(element));
    const block = findLogicalFormBlock(element, elements, fieldIdentities);
    let blockId = blockIds.get(block);
    if (!blockId) {
      blockId = `block-${nextBlockId++}`;
      blockIds.set(block, blockId);
    }
    const rows = blockRows.get(section) || new Map<HTMLElement, number>();
    if (!blockRows.has(section)) blockRows.set(section, rows);
    if (!rows.has(block)) rows.set(block, rows.size);
    const isDateRange = Boolean(rangePart);
    const context = `${getPageSectionName(section)}；${(container?.textContent || element.parentElement?.textContent || '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 300)}`;

    return {
      element,
      index,
      rowIndex: rows.get(block) || 0,
      section,
      name,
      label,
      optionCandidates: getOptions(element).map(({ element: _element, ...option }) => option),
      optionsComplete: observeControl(element).optionsComplete,
      type: isDateRange
        ? (rangePart === 'end' ? 'date-end' : 'date-start')
        : isChoiceControl(element)
          ? element.type
          : (element.getAttribute('role') === 'combobox' ? 'combobox' : element.tagName.toLowerCase()),
      options: getKnownOptions(element, label, name),
      semantic: FieldMatcher.matchFieldType(identifiers.name, identifiers.id, identifiers.placeholder, label, identifiers.type, identifiers.autocomplete, identifiers.contextText).fieldType,
      context,
      blockId,
      blockContext: `${getPageSectionName(section)}；${(block.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 500)}`,
    };
  });
}

function isLikelyApplicationControl(
  element: HTMLElement,
): boolean {
  const identifiers = FieldMatcher.extractIdentifiers(element);
  const semanticText = `${identifiers.name} ${identifiers.labelText} ${identifiers.placeholder} ${identifiers.contextText}`
    .replace(/\s+/g, ' ')
    .toLowerCase();
  const applicationWords = /申请|应聘|求职|简历|个人信息|联系方式|教育|学历|学校|专业|实习|工作经历|项目经历|技能|证件|application|candidate|resume|education|employment|experience|project|skills?/i;
  const utilityWords = /搜索|查询|验证码|订阅|登录|注册|search|captcha|newsletter|sign\s*in|log\s*in/i;
  if (utilityWords.test(semanticText) && !applicationWords.test(semanticText)) return false;
  if (getElementSection(element)) return true;
  const meaning = FieldMatcher.matchFieldType(identifiers.name, identifiers.id, identifiers.placeholder,
    identifiers.labelText || getControlLabel(element), identifiers.type, identifiers.autocomplete, identifiers.contextText);
  if (meaning.fieldType !== 'unknown' && meaning.confidence >= 0.8 && element.closest('form')) return true;
  if (element.hasAttribute('required') || element.getAttribute('aria-required') === 'true') return true;
  if (element.closest(
    '[data-form-field-id], [data-form-field-name], [data-form-field-i18n-name], [class*=applyForm], [class*=formItem], [class*=form-item]'
  )) return true;
  const form = element.closest('form');
  if (!form) return false;
  const formText = (form.textContent || '').replace(/\s+/g, ' ').slice(0, 3000);
  const controlCount = form.querySelectorAll('input:not([type="hidden"]), textarea, select, [role=combobox], [role=radio], [role=checkbox], [contenteditable=true]').length;
  return controlCount >= 2 && applicationWords.test(`${formText} ${semanticText}`);
}

function getUnmatchedFieldLabel(unmatched: UnmatchedField): string {
  return unmatched.identifiers.labelText || unmatched.identifiers.placeholder;
}

function collectUnresolvedReviewCandidates(
  items: Array<{
    element: HTMLElement;
    preferredLabel?: string;
  }>,
): Array<{
  element: HTMLElement;
  label: string;
}> {
  const seenContainers = new Set<Element>();
  const candidates: Array<{
    element: HTMLElement;
    label: string;
  }> = [];

  for (const item of items) {
    const { element } = item;
    if (!element.isConnected || observeControl(element).disabled || getControlValue(element)) continue;
    // 失败复盘关注所有有明确问题名称的网申字段，不再只依赖 required 标记。
    // 很多招聘系统会在提交时才校验必填，DOM 中并没有 required 属性。
    if (!isLikelyApplicationControl(element)) continue;

    const label = getMeaningfulReviewLabel(element, item.preferredLabel);
    if (!label) continue;

    const container = getReviewControlContainer(element);
    if (seenContainers.has(container)) continue;
    seenContainers.add(container);
    candidates.push({ element, label });
  }

  return candidates;
}

function getReviewControlContainer(
  element: HTMLElement,
): Element {
  if (isChoiceControl(element)) {
    return element.closest('[role="radiogroup"], [role="group"], fieldset')
      || element.closest('label')
      || element.parentElement
      || element;
  }
  return element.closest(
    '[data-form-field-id], [data-form-field-name], [data-form-field-i18n-name], [class*=applyFormItem], [class*=formItem], [class*=form-item]'
  ) || element;
}

function getMeaningfulReviewLabel(
  element: HTMLElement,
  preferredLabel = '',
): string {
  const identifiers = FieldMatcher.extractIdentifiers(element);
  const container = getReviewControlContainer(element);
  const rawLabels = [
    (isChoiceControl(element) ? getChoiceQuestion(element) : ''),
    element.getAttribute('data-form-field-i18n-name') || '',
    container.getAttribute('data-form-field-i18n-name') || '',
    preferredLabel,
    identifiers.labelText,
    element.getAttribute('aria-label') || '',
    identifiers.placeholder,
  ];

  for (const raw of rawLabels) {
    const label = raw
      .replace(/^[\s*＊]+|[\s*＊：:]+$/g, '')
      .replace(/\s+/g, ' ')
      .replace(/^(?:请输入|请填写|请选择|请选取)\s*/i, '')
      .replace(/\s*[（(]?(?:必填|required)[）)]?\s*$/i, '')
      .trim();
    if (!label || label.length > 100) continue;
    if (/^(?:unknown|未知|未识别字段|请输入|请填写|请选择|输入|选择|search|搜索|please\s+(?:enter|input|select|choose))$/i.test(label)) {
      continue;
    }
    const matchedType = FieldMatcher.matchFieldType(
      identifiers.name,
      identifiers.id,
      identifiers.placeholder,
      identifiers.labelText,
      identifiers.type,
      identifiers.autocomplete,
      identifiers.contextText,
    ).fieldType;
    return getChineseFieldLabel(label, matchedType);
  }
  return '';
}

function findLogicalFormBlock(
  element: HTMLElement,
  allElements: Array<HTMLElement>,
  fieldIdentities: Map<HTMLElement, string>,
): HTMLElement {
  let current: HTMLElement | null = element.parentElement;
  let best = element.parentElement || document.body;
  for (let depth = 0; current && current !== document.body && depth < 8; depth++, current = current.parentElement) {
    const members = allElements.filter(candidate => current?.contains(candidate));
    const memberCount = members.length;
    if (memberCount > 14) break;
    const textLength = (current.textContent || '').replace(/\s+/g, '').length;
    const identities = members.map(candidate => fieldIdentities.get(candidate) || '').filter(Boolean);
    const crossesRepeatedRows = memberCount >= 4 && new Set(identities).size < identities.length;
    if (crossesRepeatedRows && best !== element.parentElement) break;
    if (memberCount >= 2 && textLength <= 600) best = current;
    if (current.matches('fieldset, [role="group"], [role="radiogroup"], [class*=row], [class*=entry], [class*=record]') && memberCount >= 2) {
      best = current;
    }
  }
  return best;
}

function getControlValue(element: HTMLElement): string {
  return getLogicalControlValue(element);
}

function toPageScanSection(section: FillSection | null): PageScanSection {
  return section && section !== 'all' ? section : 'other';
}

function getPageSectionName(section: PageScanSection): string {
  return {
    personal: '基本信息',
    education: '教育经历',
    experience: '实习经历',
    projects: '项目经历',
    other: '其它表单',
  }[section];
}

async function fillPageScanProgressively(
  section: PageScanSection,
  fields: ScannedPageField[],
  requestId: string,
  resumeId: string | null | undefined,
  shouldContinue: () => boolean,
  onProgress: (progress: { processedCount: number; filledCount: number; label: string }) => void,
  profile: UserProfile,
): Promise<number> {
  const blocks = new Map<string, ScannedPageField[]>();
  const bindings = bindFieldRecords(formDetector.detectFields(), profile);
  for (const field of fields) {
    const binding = bindings.get(field.element) || [...bindings.values()]
      .filter(candidate => candidate.container.contains(field.element))
      .sort((left, right) => left.container.contains(right.container) ? 1 : -1)[0];
    if (binding) {
      field.recordId = binding.recordId;
      field.recordCollection = binding.section;
      field.blockId = `${binding.section}:${binding.recordId}`;
    }
    const key = field.blockId || `field-${field.index}`;
    blocks.set(key, [...(blocks.get(key) || []), field]);
  }
  let processedCount = 0;
  let filledCount = 0;
  for (const block of blocks.values()) {
    if (!shouldContinue()) break;
    const active = block.filter(field => field.element.isConnected && !getControlValue(field.element));
    if (!active.length) continue;
    const response = await sendRuntimeMessage<Record<string, GroundedMapping>>({
      type: 'AI_FILL_SECTION',
      payload: {
        requestId, resumeId, section: active[0].section || section, domain: window.location.hostname,
        fields: active.map(({ element: _element, section: _section, ...field }) => field),
      },
    });
    if (!shouldContinue()) break;
    const ordered = [...active].sort((a, b) => getDateRangeFillPriority(a.element) - getDateRangeFillPriority(b.element));
    for (const field of ordered) {
      if (!shouldContinue()) break;
      const mapping = response.success ? response.data?.[String(field.index)] : undefined;
      if (mapping && field.element.isConnected && !getControlValue(field.element)) {
        filledCount += await formFiller.fillElementValues([{
          element: field.element, value: mapping.value, optionRef: mapping.optionId, semantic: field.semantic,
        }], shouldContinue);
      } else if (!getControlValue(field.element)) {
        for (const candidate of collectUnresolvedReviewCandidates([{ element: field.element, preferredLabel: field.label }])) {
          formFiller.markUnresolvedField(candidate.element, candidate.label);
        }
      }
      processedCount++;
      onProgress({ processedCount, filledCount, label: field.label });
    }
  }
  return filledCount;
}

function showAIRegionStatus(initialText: string) {
  const element = document.createElement('div');
  const textElement = document.createElement('span');
  const cancelButton = document.createElement('button');
  element.style.cssText = 'position:fixed;right:20px;bottom:20px;z-index:1000005;max-width:440px;padding:12px 14px;border-radius:8px;background:#24262d;color:#fff;box-shadow:0 6px 24px rgba(0,0,0,.28);font:500 13px -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;display:flex;align-items:center;gap:12px;';
  textElement.textContent = initialText;
  cancelButton.type = 'button';
  cancelButton.textContent = '终止';
  cancelButton.style.cssText = 'flex:none;padding:5px 10px;border:1px solid rgba(255,255,255,.65);border-radius:5px;background:transparent;color:#fff;cursor:pointer;font:500 12px inherit;';
  element.append(textElement, cancelButton);
  document.body.appendChild(element);

  return {
    setCancelHandler(handler: () => void | Promise<void>) {
      cancelButton.onclick = () => {
        cancelButton.disabled = true;
        cancelButton.textContent = '终止中';
        void handler();
      };
    },
    update(text: string, type: 'normal' | 'success' | 'warning' | 'error' = 'normal') {
      textElement.textContent = text;
      element.style.background = type === 'success'
        ? '#15803d'
        : type === 'warning'
          ? '#a16207'
          : type === 'error'
            ? '#b91c1c'
            : '#24262d';
      if (type !== 'normal') {
        cancelButton.remove();
        setTimeout(() => element.remove(), 5000);
      }
    },
  };
}

function getKnownOptions(element: HTMLElement, _label: string, _name: string): string[] {
  return getControlOptions(element);
}

function getDateRangeFillPriority(element: Element): number {
  const part = dateRangePart(element as HTMLElement);
  return part === 'end' ? 0 : part === 'start' ? 1 : 2;
}

// 注入 AI 生成按钮到开放性问题旁
function injectAIButtons() {
  const detector = new OpenQuestionDetector();
  const openFields = detector.detect();

  for (const field of openFields) {
    if (field.element.parentElement?.querySelector('.ai-gen-btn')) continue;

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'ai-gen-btn';
    btn.textContent = 'AI 生成';
    btn.style.cssText = `
      margin-left: 8px; margin-top: 6px; padding: 4px 12px;
      background: linear-gradient(135deg, #667eea, #764ba2);
      color: white; border: none; border-radius: 4px;
      font-size: 12px; cursor: pointer; display: inline-block;
    `;

    btn.addEventListener('click', async (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (localFillRunning || aiPageFillRunning || visualFillRunning) return;
      const originalValue = field.element.value;
      btn.textContent = '生成中...';
      (btn as HTMLButtonElement).disabled = true;

      const response = await sendRuntimeMessage({
        type: 'GENERATE_ANSWER',
        payload: {
          questionText: field.questionText,
          context: field.context,
          fieldMaxLength: parseInt(field.element.getAttribute('maxlength') || '0') || undefined,
          language: /[一-鿿]/.test(field.questionText) ? 'zh' : 'en',
        },
      });

      if (response.success && response.data) {
        if (localFillRunning || aiPageFillRunning || visualFillRunning || field.element.value !== originalValue) {
          btn.textContent = '内容已变化，请重新生成';
        } else {
          const written = await formFiller.fillFocusedControl(field.element, response.data.answer);
          btn.textContent = written ? 'AI 生成 ✓' : '网页尚未接受，请重试';
          if (written) field.element.style.border = '2px solid #667eea';
        }
      } else {
        btn.textContent = '生成失败';
        console.error('Generation failed:', response.error);
      }

      setTimeout(() => {
        btn.textContent = 'AI 生成';
        (btn as HTMLButtonElement).disabled = false;
      }, 3000);
    });

    field.element.insertAdjacentElement('afterend', btn);
  }
}

function showFailureReview(failures: FillFailure[]): void {
  document.getElementById('job-applymate-failure-review')?.remove();
  if (failures.length === 0) return;

  const host = document.createElement('div');
  host.id = 'job-applymate-failure-review';
  host.dataset.jobApplymateUi = 'failure-review';
  host.style.cssText = 'position:fixed;right:18px;bottom:18px;z-index:2147483647;width:min(460px,calc(100vw - 36px));max-height:min(680px,calc(100vh - 36px));margin:0;padding:0;border:0;background:transparent;color-scheme:light;font:13px/1.4 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;';
  const shadow = host.attachShadow({ mode: 'open' });
  const style = document.createElement('style');
  style.textContent = `
    :host {
      all: initial !important;
      position: fixed !important;
      right: 18px !important;
      bottom: 18px !important;
      z-index: 2147483647 !important;
      width: min(460px, calc(100vw - 36px)) !important;
      max-height: min(680px, calc(100vh - 36px)) !important;
      display: block !important;
      color-scheme: light !important;
      font: 13px/1.4 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif !important;
    }
    *, *::before, *::after { box-sizing: border-box !important; }
    section, div, strong, span, button, input, select, textarea {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif !important;
      text-transform: none !important;
      letter-spacing: normal !important;
    }
    button, input, select, textarea { font-size: 13px !important; line-height: 1.4 !important; }
  `;
  const panel = document.createElement('section');
  const header = document.createElement('div');
  const title = document.createElement('strong');
  const subtitle = document.createElement('span');
  const list = document.createElement('div');
  const skipAll = document.createElement('button');
  panel.style.cssText = 'width:100%;max-height:min(680px,calc(100vh - 36px));display:flex;flex-direction:column;overflow:hidden;border:1px solid #9fded0;border-radius:18px 18px 18px 6px;background:#f8fffd;color:#0b2630;box-shadow:0 24px 70px rgba(7,59,76,.28);font:13px/1.4 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;';
  header.style.cssText = 'padding:16px 18px 14px;background:linear-gradient(135deg,#073b4c,#0f766e);color:#fff;';
  title.style.cssText = 'display:block;font-size:16px;line-height:1.3;';
  subtitle.textContent = '补充缺失答案后会保存，下次优先填写；也可以纠正 AI 的字段理解。';
  subtitle.style.cssText = 'display:block;margin-top:5px;color:rgba(255,255,255,.72);font-size:12px;';
  list.style.cssText = 'display:grid;gap:10px;padding:12px;overflow:auto;';
  skipAll.type = 'button';
  skipAll.textContent = '本次全部不填';
  skipAll.style.cssText = 'margin:0 12px 12px;min-height:38px;border:1px solid #bfd9d3;border-radius:10px;background:#fff;color:#526b6e;font-weight:650;cursor:pointer;';

  let remaining = failures.length;
  const updateTitle = () => {
    title.textContent = `${remaining} 项未能自动填写`;
    if (remaining === 0) host.remove();
  };
  updateTitle();
  header.append(title, subtitle);

  for (const failure of failures) {
    const row = document.createElement('div');
    const label = document.createElement('div');
    const reason = document.createElement('div');
    const candidates = formFiller.getCorrectionCandidates(failure.element);
    const options = candidates.map(option => option.label);
    const input = options.length > 0
      ? document.createElement('select')
      : document.createElement('input');
    const actions = document.createElement('div');
    const remember = document.createElement('button');
    const skip = document.createElement('button');
    const ruleLabel = document.createElement('div');
    const ruleInput = document.createElement('textarea');
    const saveHint = document.createElement('button');
    const feedback = document.createElement('div');
    row.dataset.failureReviewItem = 'true';
    label.dataset.failureReviewLabel = 'true';
    row.style.cssText = 'padding:12px;border:1px solid #d5e6e1;border-radius:12px;background:#fff;';
    label.textContent = failure.label || failure.fieldType;
    label.style.cssText = 'margin-bottom:7px;font-weight:700;color:#163b43;';
    reason.textContent = failure.outcome?.reason || (failure.attemptedValue
      ? `已尝试“${failure.attemptedValue.slice(0, 80)}”，但网页没有接受。`
      : '未找到可靠的资料或字段对应关系，请补充或选择。');
    reason.style.cssText = 'margin:-2px 0 8px;color:#607477;font-size:12px;';
    if (input instanceof HTMLSelectElement) {
      const placeholder = document.createElement('option');
      placeholder.value = '';
      placeholder.textContent = '请选择网站中的选项';
      input.appendChild(placeholder);
      for (const candidate of candidates) {
        const option = document.createElement('option');
        option.value = candidate.id;
        option.textContent = candidate.label;
        input.appendChild(option);
      }
      const matching = candidates.filter(option => option.label === failure.attemptedValue);
      input.value = matching.length === 1 ? matching[0].id : '';
    } else {
      input.value = failure.attemptedValue;
      input.placeholder = `请输入“${failure.label || '该字段'}”的答案`;
      const sourceType = failure.element instanceof HTMLInputElement ? failure.element.type : '';
      input.type = sourceType === 'date' || sourceType === 'month' ? sourceType : 'text';
    }
    input.style.cssText = 'width:100%;min-height:38px;padding:8px 10px;box-sizing:border-box;border:1px solid #bfd9d3;border-radius:9px;background:#fff;color:#0b2630;outline:none;';
    actions.style.cssText = 'display:flex;gap:8px;margin-top:9px;';
    remember.type = 'button';
    remember.textContent = '填写并记住';
    remember.style.cssText = 'flex:1;min-height:34px;border:0;border-radius:9px;background:#0f766e;color:#fff;font-weight:700;cursor:pointer;';
    skip.type = 'button';
    skip.textContent = '本次不填';
    skip.style.cssText = 'min-height:34px;padding:0 12px;border:1px solid #d5e6e1;border-radius:9px;background:#f6faf9;color:#607477;font-weight:650;cursor:pointer;';
    feedback.style.cssText = 'min-height:0;margin-top:0;color:#c2410c;font-size:12px;';
    ruleLabel.textContent = 'AI 识别纠错（可选）';
    ruleLabel.style.cssText = 'margin-top:10px;color:#375a60;font-size:12px;font-weight:650;';
    ruleInput.rows = 2;
    ruleInput.placeholder = '例如：这是紧急联系人的电话，不是候选人本人的联系电话';
    ruleInput.style.cssText = 'width:100%;margin-top:5px;padding:7px 9px;box-sizing:border-box;border:1px solid #d5e6e1;border-radius:8px;background:#fbfefd;color:#0b2630;resize:vertical;outline:none;';
    saveHint.type = 'button';
    saveHint.textContent = '只保存识别纠错';
    saveHint.style.cssText = 'margin-top:6px;min-height:30px;padding:0 10px;border:1px solid #9fcfc5;border-radius:8px;background:#eefaf7;color:#0f766e;font-weight:650;cursor:pointer;';

    const removeRow = () => {
      row.remove();
      remaining--;
      updateTitle();
    };
    skip.onclick = removeRow;
    saveHint.onclick = async () => {
      const hint = ruleInput.value.trim();
      if (!hint) {
        feedback.textContent = '请先写下要告诉 AI 的识别规则';
        feedback.style.marginTop = '7px';
        return;
      }
      saveHint.disabled = true;
      saveHint.textContent = '正在保存...';
      const saved = await sendRuntimeMessage({
        type: 'SAVE_FIELD_RECOGNITION_HINT',
        payload: {
          domain: window.location.hostname,
          signature: failure.signature,
          label: failure.label,
          hint,
        },
      });
      feedback.style.marginTop = '7px';
      feedback.style.color = saved.success ? '#0f766e' : '#c2410c';
      feedback.textContent = saved.success
        ? '识别纠错已写入 AI 字段识别 Skill'
        : saved.error || '识别纠错保存失败';
      saveHint.disabled = false;
      saveHint.textContent = saved.success ? '识别纠错已保存' : '重新保存识别纠错';
    };
    remember.onclick = async () => {
      if (localFillRunning || aiPageFillRunning || visualFillRunning) {
        feedback.textContent = '正在填写，请完成或停止后再处理这一项';
        return;
      }
      const selected = input instanceof HTMLSelectElement ? candidates.find(option => option.id === input.value) : undefined;
      const value = selected?.label || input.value.trim();
      if (!value) {
        feedback.textContent = '请先输入准备填写的值';
        feedback.style.marginTop = '7px';
        return;
      }
      remember.disabled = true;
      remember.textContent = '正在填写...';
      const count = await formFiller.fillElementValues([{ element: failure.element, value, overwrite: true, semantic: failure.fieldType, optionRef: selected?.id }]);
      if (count === 0) {
        feedback.textContent = formFiller.getLastFailures().find(item => item.element === failure.element)?.outcome?.reason || '控件尚未接受此值，可在原网页手动选择后继续';
        feedback.style.marginTop = '7px';
        remember.disabled = false;
        remember.textContent = '再次尝试';
        return;
      }
      const saved = await sendRuntimeMessage({
        type: 'SAVE_LEARNED_FIELD_VALUE',
        payload: {
          domain: window.location.hostname,
          entry: {
            signature: failure.signature,
            label: failure.label,
            value,
            fieldType: failure.fieldType,
            updatedAt: new Date().toISOString(),
          },
          // attemptedValue 为空说明资料中原本没有答案；同时写回个人资料，
          // 让其它网站和后续 AI 请求也能复用，而不只绑定当前字段签名。
          saveAsProfileInformation: failure.outcome?.status === 'needs-data'
            || (!failure.attemptedValue && failure.fieldType === 'unknown'),
          recognitionHint: ruleInput.value.trim() || undefined,
        },
      });
      if (!saved.success) {
        feedback.textContent = saved.error || '已填写，但保存学习记录失败';
        feedback.style.marginTop = '7px';
        remember.disabled = false;
        remember.textContent = '重新保存';
        return;
      }
      removeRow();
    };
    const locate = document.createElement('button');
    locate.type = 'button';
    locate.textContent = '在网页中处理';
    locate.style.cssText = skip.style.cssText;
    locate.onclick = () => {
      failure.element.scrollIntoView({ block: 'center', behavior: 'smooth' });
      failure.element.focus();
      failure.element.animate([{ outline: '3px solid #0f766e' }, { outline: '3px solid transparent' }], { duration: 1800 });
    };
    actions.append(remember, locate, skip);
    row.append(label, reason, input, actions, ruleLabel, ruleInput, saveHint, feedback);
    list.append(row);
  }

  skipAll.onclick = () => host.remove();
  panel.append(header, list, skipAll);
  shadow.append(style, panel);
  document.documentElement.append(host);
}

// 显示成功消息
function showSuccessMessage() {
  const message = document.createElement('div');
  message.style.cssText = `
    position: fixed;
    top: 20px;
    right: 20px;
    z-index: 1000000;
    background: #10b981;
    color: white;
    padding: 16px 24px;
    border-radius: 12px;
    box-shadow: 0 4px 20px rgba(0,0,0,0.15);
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    font-size: 14px;
    font-weight: 500;
    display: flex;
    align-items: center;
    gap: 10px;
    animation: slideIn 0.3s ease;
  `;

  message.innerHTML = `
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
      <polyline points="20 6 9 17 4 12"></polyline>
    </svg>
    <span>已验证填写 ${formFiller.getVerifiedCount()} 项${formFiller.getLastFailures().length ? `，${formFiller.getLastFailures().length} 项需要处理` : ''}</span>
  `;

  document.body.appendChild(message);

  setTimeout(() => {
    message.style.animation = 'slideOut 0.3s ease';
    setTimeout(() => {
      document.body.removeChild(message);
    }, 300);
  }, 3000);
}

// 监听来自 popup 的消息
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'PING_CONTENT') {
    sendResponse({ success: true, data: { ready: true } });
    return true;
  }

  if (message.type === 'OPEN_INFO_OVERLAY') {
    infoOverlayController.open(message.payload?.resumeId).then(() => {
      sendResponse({ success: true, data: { opened: true } });
    }).catch(error => {
      sendResponse({ success: false, error: error instanceof Error ? error.message : '信息浮窗打开失败' });
    });
    return true;
  }

  if (message.type === 'SET_INFO_OVERLAY_RESUME') {
    infoOverlayController.setResume(message.payload.resumeId).then(() => {
      sendResponse({ success: true, data: { updated: true } });
    }).catch(error => {
      sendResponse({ success: false, error: error instanceof Error ? error.message : '切换悬浮窗简历失败' });
    });
    return true;
  }

  if (message.type === 'GET_APPLICATION_PAGE_METADATA') {
    sendResponse({
      success: true,
      data: extractApplicationPageMetadata(document, window.location.href),
    });
    return true;
  }

  if (message.type === 'DETECT_FIELDS') {
    detectedFields = formDetector.detectFields();
    sendResponse({
      success: true,
      data: {
        count: detectedFields.length,
        fields: detectedFields.map((f) => ({
          fieldType: f.fieldType,
          confidence: f.confidence
        }))
      }
    });
    return true;
  }

  if (message.type === 'FILL_FORM') {
    handleFillButtonClick(
      Boolean(message.payload?.reusePreview),
      message.payload?.resumeId,
    ).then(() => {
      sendResponse({ success: true, data: { verifiedCount: formFiller.getVerifiedCount(), failures: formFiller.getLastFailures().map(item => ({ label: item.label, status: item.outcome?.status || 'unresolved' })) } });
    }).catch((error) => {
      sendResponse({ success: false, error: error.message });
    });
    return true;
  }

  if (message.type === 'PREVIEW_FILL') {
    sendRuntimeMessage<UserProfile>({ type: 'GET_USER_PROFILE' }).then(response => {
      if (!response.success || !response.data) {
        sendResponse({ success: false, error: '请先保存个人资料' });
        return;
      }
      const previewProfile = buildProfileForResume(response.data, message.payload?.resumeId);
      detectedFields = formDetector.detectFields();
      fillPreviewSnapshot = {
        fields: [...detectedFields],
        createdAt: Date.now(),
      };
      sendResponse({
        success: true,
        data: {
          items: formFiller.buildFillPreview(detectedFields, previewProfile),
          detectedCount: detectedFields.length,
        },
      });
    }).catch(error => {
      sendResponse({ success: false, error: error instanceof Error ? error.message : '生成预览失败' });
    });
    return true;
  }

  if (message.type === 'UNDO_LAST_FILL') {
    if (localFillRunning || aiPageFillRunning || visualFillRunning) {
      sendResponse({ success: false, error: '正在填写，请完成或停止后再撤销' });
      return true;
    }
    formFiller.undoLastFill().then((count) => {
      sendResponse({ success: true, data: { count } });
    }).catch((error) => {
      sendResponse({ success: false, error: error instanceof Error ? error.message : '撤销失败' });
    });
    return true;
  }

  if (message.type === 'START_AI_PAGE_FILL') {
    void handleAIPageFill(message.payload?.resumeId);
    sendResponse({ success: true, data: { started: true } });
    return false;
  }

  if (message.type === 'START_AI_REGION_FILL') {
    startAIRegionSelection();
    sendResponse({ success: true });
    return true;
  }

  if (message.type === 'APPLY_FOCUSED_FIELD') {
    applyValueToFocusedControl(message.payload.value).then((result) => {
      sendResponse({ success: true, data: result });
    }).catch((error) => {
      sendResponse({
        success: false,
        error: error instanceof Error ? error.message : '写入目标字段失败',
      });
    });
    return true;
  }
});

// 添加 CSS 动画
const style = document.createElement('style');
style.textContent = `
  @keyframes slideIn {
    from {
      transform: translateX(400px);
      opacity: 0;
    }
    to {
      transform: translateX(0);
      opacity: 1;
    }
  }

  @keyframes slideOut {
    from {
      transform: translateX(0);
      opacity: 1;
    }
    to {
      transform: translateX(400px);
      opacity: 0;
    }
  }
`;
document.head.appendChild(style);
