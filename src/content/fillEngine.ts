import { activateControl as activate, isAutomatedControlAction } from './controlActivation.ts';
export { isAutomatedControlAction } from './controlActivation.ts';
import type { FillOutcome, FillStatus } from '../shared/fillModel.ts';
import { resolveOption, normalizeOptionLabel } from '../utils/optionResolver.ts';
import { adaptDateValue, parseFlexibleDate, areEquivalentDates } from '../utils/dateValue.ts';
import { dateRangePart } from './fieldBinding.ts';
import { fillDatePicker, supportsDatePicker, verifyDatePicker } from './datePickerAdapter.ts';
import { fillCascader, supportsCascader, verifyCascader } from './cascaderAdapter.ts';
import { fillUdTreeSelect, supportsUdTreeSelect, verifyUdTreeSelect } from './udTreeSelectAdapter.ts';
import {
  getAssociatedPopups, getControlIdentity, getControlKind, getControlValue,
  getEditableElement, getOptions, isNativeInput, isNativeSelect,
  isNativeTextArea, isOptionSelected, isVisibleControl, observeControl,
  type ControlObservation, type ObservedOption,
  bindAssociatedPopup, associateNearbyPopup, isMultipleControl, KNOWN_COMBOBOX_SELECTOR, KNOWN_POPUP_SELECTOR,
} from './controlObservation.ts';

export interface FillContext {
  semantic?: string;
  shouldContinue?: () => boolean;
  /** Existing nonempty answers are preserved unless the caller explicitly opts in. */
  overwrite?: boolean;
  optionRef?: string;
  optionRefs?: string[];
  settleMs?: number;
  timeoutMs?: number;
}
interface ExpectedControl {
  value: string;
  options?: ObservedOption[];
  checked?: boolean;
  requireIdentity?: boolean;
  date?: boolean;
}
const verifiedExpectations = new WeakMap<HTMLElement, { requestedValue: string; optionRef?: string; optionRefs?: string[]; expected: ExpectedControl }>();
interface AttemptState {
  startedAt: number;
  deadline: number;
  attempts: number;
  userEdited: boolean;
  context: FillContext;
  element: HTMLElement;
  stop: () => void;
  searchWrite?: { editor: HTMLInputElement | HTMLTextAreaElement; previous: string; written: string };
  openedPopup?: boolean;
}

const pause = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
function outcome(state: AttemptState, status: FillStatus, reason: string, expectedValue: string): FillOutcome {
  return {
    status, reason, expectedValue, observedValue: getControlValue(state.element),
    attempts: state.attempts, fieldId: getControlIdentity(state.element), adapterId: `dom-${getControlKind(state.element)}`,
  };
}
function interrupted(state: AttemptState, value: string): FillOutcome | null {
  if (state.userEdited) return outcome(state, 'user-edited', '用户正在编辑该字段，已停止自动操作', value);
  if (state.context.shouldContinue && !state.context.shouldContinue()) return outcome(state, 'cancelled', '填写已取消', value);
  if (!state.element.isConnected) return outcome(state, 'stale', '字段已被页面替换，需要重新识别', value);
  if (Date.now() >= state.deadline) return outcome(state, 'failed', '当前字段的操作时间已用完', value);
  return null;
}
function beginAttempt(element: HTMLElement, context: FillContext): AttemptState {
  const startedAt = Date.now();
  const state: AttemptState = {
    element, context, startedAt, deadline: startedAt + (context.timeoutMs ?? 10000), attempts: 0, userEdited: false, stop: () => {},
  };
  const onUserEvent = (event: Event) => {
    if (!event.isTrusted || isAutomatedControlAction(element.ownerDocument) || !(event.target instanceof Node)) return;
    const target = event.target;
    const observation = observeControl(element);
    const wrapper = element.parentElement?.closest('.ant-select, .el-select, .MuiAutocomplete-root, .react-select__control, .semi-select, .arco-select, .ud__select');
    if (element === target || element.contains(target)
      || wrapper?.contains(target)
      || observation.group.some(control => control === target || control.contains(target)
        || (isNativeInput(control) && Array.from(control.labels || []).some(label => label.contains(target))))
      || getAssociatedPopups(element).some(popup => popup.contains(target))) state.userEdited = true;
  };
  const events = ['beforeinput', 'input', 'change', 'pointerdown', 'keydown'];
  const root = element.getRootNode();
  events.forEach(event => root.addEventListener(event, onUserEvent, true));
  state.stop = () => events.forEach(event => root.removeEventListener(event, onUserEvent, true));
  return state;
}

function requestedParts(value: string): string[] {
  return value.split(/[,，、;；\n]+/).map(part => part.trim()).filter(Boolean);
}
function booleanValue(value: string): boolean | undefined {
  if (/^(true|yes|是|同意|接受|已勾选)$/i.test(value.trim())) return true;
  if (/^(false|no|否|不同意|不接受|未勾选)$/i.test(value.trim())) return false;
  return undefined;
}
function expectedControl(observation: ControlObservation, value: string, context: FillContext): ExpectedControl | FillOutcome {
  const { element, kind, options } = observation;
  if (kind === 'checkbox' && options.length === 1) {
    const checked = booleanValue(value);
    if (checked !== undefined) return { value, checked };
  }
  if (['radio', 'checkbox', 'select', 'combobox'].includes(kind)) {
    const multiple = isMultipleControl(element);
    const selected: ObservedOption[] = [];
    for (const desired of multiple ? requestedParts(value) : [value]) {
      if (context.optionRef || context.optionRefs?.length) {
        const ids = context.optionRefs || [context.optionRef!];
        if (!multiple && ids.length !== 1) return { status: 'needs-mapping', reason: '单选控件只能选择一个选项' };
        const targets = ids.map(id => options.find(candidate => candidate.id === id && !candidate.disabled));
        if (targets.some(option => !option)) return { status: 'needs-mapping', reason: '指定选项已变化，请重新读取网站选项' };
        selected.push(...targets as ObservedOption[]);
        break;
      }
      const match = resolveOption({ desired, options, semantic: context.semantic, completeness: observation.optionsComplete ? 'complete' : 'partial' });
      if (match.status !== 'matched') return {
        status: 'needs-mapping', reason: match.status === 'ambiguous'
          ? '多个网站选项含义相同，需要确认具体选项'
          : observation.optionsComplete ? '网站中没有能确定匹配的选项' : '尚未读取到能确定匹配的选项',
      };
      selected.push(options.find(option => option.id === match.option.id)!);
    }
    if (!selected.length) return { status: 'needs-data', reason: '没有可填写的答案' };
    return { value, options: selected, requireIdentity: selected.some(target => options.filter(option => normalizeOptionLabel(option.label) === normalizeOptionLabel(target.label)).length > 1) };
  }
  if (kind === 'date' || (context.semantic && /date/i.test(context.semantic)) || dateRangePart(element)) {
    const input = getEditableElement(element);
    const parsed = parseFlexibleDate(value);
    if (isNativeInput(element) && element.type === 'date' && parsed && (!parsed.month || !parsed.day)) {
      return { status: 'needs-mapping', reason: '网站要求具体年月日，但资料日期精度不足' };
    }
    if (isNativeInput(element) && element.type === 'month' && parsed && !parsed.month) {
      return { status: 'needs-mapping', reason: '网站要求年月，但资料只有年份' };
    }
    const formatHint = `${input?.getAttribute('placeholder') || ''} ${input?.getAttribute('pattern') || ''}`.toLowerCase();
    if (parsed && !parsed.day && (/yyyy\s*[./年-]\s*mm\s*[./月-]\s*dd/.test(formatHint) || /年.*月.*日/.test(formatHint))) {
      return { status: 'needs-mapping', reason: '网站要求具体年月日，但资料日期精度不足' };
    }
    if (parsed && !parsed.month && (/yyyy\s*[./年-]\s*mm/.test(formatHint) || /年.*月/.test(formatHint))) {
      return { status: 'needs-mapping', reason: '网站要求年月，但资料只有年份' };
    }
    return { value: adaptDateValue(value, {
      inputType: isNativeInput(element) && element.type !== 'text' ? element.type : formatHint.trim() ? undefined : parsed?.day ? 'date' : parsed?.month ? 'month' : undefined,
      placeholder: input?.getAttribute('placeholder') || '', pattern: input?.getAttribute('pattern') || '',
    }), date: Boolean(parsed) };
  }
  return { value };
}
function isOutcome(value: ExpectedControl | FillOutcome): value is FillOutcome { return 'status' in value; }

function isValid(element: HTMLElement): boolean {
  const editor = getEditableElement(element);
  if (element.getAttribute('aria-invalid') === 'true' || editor?.getAttribute('aria-invalid') === 'true') return false;
  if (editor && ((editor.maxLength >= 0 && editor.value.length > editor.maxLength)
    || (editor.minLength > 0 && editor.value.length > 0 && editor.value.length < editor.minLength))) return false;
  if (element.getAttribute('aria-required') === 'true' && getControlKind(element) === 'checkbox' && !isOptionSelected(element)) return false;
  if (isNativeInput(element) || isNativeSelect(element) || isNativeTextArea(element)) return element.validity.valid;
  return !editor || editor.validity.valid;
}

/** Checks a committed state. Editable combobox query text is deliberately excluded. */
function satisfies(element: HTMLElement, expected: ExpectedControl, _context: FillContext): boolean {
  if (!isValid(element)) return false;
  const observation = observeControl(element);
  if (expected.checked !== undefined) return observation.group.length === 1 && isOptionSelected(observation.group[0]) === expected.checked;
  if (expected.options) {
    const selected = observation.options.filter(option => isOptionSelected(option.element));
    if (observation.kind === 'combobox') {
      // aria-selected may describe a highlighted suggestion while a search is
      // open. Require an independent committed display, never only that flag.
      if (!observation.value) return false;
      const displayed = expected.options.length > 1 ? requestedParts(observation.value) : [observation.value];
      if (displayed.length !== expected.options.length
        || !expected.options.every(option => displayed.some(label => normalizeOptionLabel(label) === normalizeOptionLabel(option.label)))) return false;
    }
    if (selected.length) {
      if (selected.length !== expected.options.length) return false;
      return expected.options.every(target => {
        if (selected.some(option => option.id === target.id)) return true;
        if (expected.requireIdentity) return false;
        // A framework may replace every option node after a commit. Re-resolve
        // the exact observed label within this control, rejecting duplicates.
        const resolved = resolveOption({ desired: target.label, options: observation.options, completeness: observation.optionsComplete ? 'complete' : 'partial' });
        return resolved.status === 'matched' && selected.some(option => option.id === resolved.option.id);
      });
    }
    if (observation.kind !== 'combobox' || !observation.value || expected.requireIdentity) return false;
    // Some popups unmount on commit. A separate committed display token is then required.
    const displayed = expected.options.length > 1 ? requestedParts(observation.value) : [observation.value];
    if (displayed.length !== expected.options.length) return false;
    return expected.options.every(option => displayed.some(label => normalizeOptionLabel(label) === normalizeOptionLabel(option.label)));
  }
  return expected.date
    ? areEquivalentDates(getControlValue(element), expected.value)
    : getControlValue(element) === expected.value;
}

async function stableVerification(state: AttemptState, expected: ExpectedControl, waitMs = 1800): Promise<FillOutcome> {
  const end = Math.min(state.deadline, Date.now() + waitMs);
  const settleMs = Math.max(0, state.context.settleMs ?? 450);
  let stableSince: number | null = null;
  while (Date.now() <= end) {
    const stopped = interrupted(state, expected.value);
    if (stopped) return stopped;
    if (satisfies(state.element, expected, state.context)) {
      stableSince ??= Date.now();
      if (Date.now() - stableSince >= settleMs) return outcome(state, 'verified', '页面已稳定接受目标值', expected.value);
    } else stableSince = null;
    await pause(Math.min(40, Math.max(1, end - Date.now())));
  }
  return outcome(state, isValid(state.element) ? 'unverified' : 'rejected',
    isValid(state.element) ? '未能验证组件已稳定接受目标值' : '页面校验未通过', expected.value);
}

function dispatchInput(element: HTMLElement): void {
  const view = element.ownerDocument.defaultView!;
  element.dispatchEvent(new view.Event('input', { bubbles: true, composed: true }));
  element.dispatchEvent(new view.Event('change', { bubbles: true, composed: true }));
}
function writeText(element: HTMLElement, value: string): void {
  const view = element.ownerDocument.defaultView!;
  if (isNativeInput(element) || isNativeTextArea(element)) {
    const prototype = isNativeInput(element) ? view.HTMLInputElement.prototype : view.HTMLTextAreaElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set;
    if (setter) setter.call(element, value);
    else element.value = value;
  } else element.textContent = value;
  dispatchInput(element);
}
async function waitForObservation(state: AttemptState, predicate: () => boolean, duration: number): Promise<boolean> {
  const end = Math.min(state.deadline, Date.now() + duration);
  do {
    if (interrupted(state, '')) return false;
    if (predicate()) return true;
    await pause(50);
  } while (Date.now() < end);
  return false;
}

async function resolveCombobox(state: AttemptState, value: string): Promise<ExpectedControl | FillOutcome> {
  const { element, context } = state;
  let observation = observeControl(element);
  let expected = expectedControl(observation, value, context);
  const visiblePopup = () => getAssociatedPopups(element).some(isVisibleControl);
  associateNearbyPopup(element);
  if (!visiblePopup()) {
    const root = element.getRootNode() as Document | ShadowRoot;
    const before = new Set(Array.from(root.querySelectorAll<HTMLElement>(KNOWN_POPUP_SELECTOR)).filter(isVisibleControl));
    const editor = getEditableElement(element);
    (editor || element).focus();
    const trigger = element.querySelector<HTMLElement>('.ant-select-selector, .ant-select-content, .el-select__wrapper, .ud__select__selector, .semi-select-selection, .arco-select-view') || editor || element;
    activate(trigger, Boolean(element.closest('.ant-select')));
    state.openedPopup = true;
    await waitForObservation(state, () => {
      if (visiblePopup() || associateNearbyPopup(element)) return true;
      if (!element.closest(KNOWN_COMBOBOX_SELECTOR)) return false;
      const anchor = element.closest(KNOWN_COMBOBOX_SELECTOR) || element;
      const anchorRect = anchor.getBoundingClientRect();
      const opened = Array.from(root.querySelectorAll<HTMLElement>(KNOWN_POPUP_SELECTOR))
        .filter(popup => !before.has(popup) && isVisibleControl(popup));
      // Nested listbox and its component popup are one candidate, not two.
      const outer = opened.filter(popup => !opened.some(other => other !== popup && other.contains(popup)));
      const nearby = outer.filter(popup => {
        const rect = popup.getBoundingClientRect();
        const overlapsHorizontally = rect.left < anchorRect.right && rect.right > anchorRect.left;
        return overlapsHorizontally && Math.min(Math.abs(rect.top - anchorRect.bottom), Math.abs(rect.bottom - anchorRect.top)) < 240;
      });
      if (nearby.length !== 1) return false;
      bindAssociatedPopup(element, nearby[0]);
      return true;
    }, 1200);
  }
  const stopped = interrupted(state, value);
  if (stopped) return stopped;
  if (!getAssociatedPopups(element).length) return { status: 'unsupported', reason: '控件没有可确定关联的选项列表，需要专用适配或人工选择' };
  await waitForObservation(state, () => getOptions(element).length > 0
    && getAssociatedPopups(element).every(popup => popup.getAttribute('aria-busy') !== 'true'), 1000);
  observation = observeControl(element);
  expected = expectedControl(observation, value, context);
  if (!isOutcome(expected)) return expected;
  const editor = getEditableElement(element);
  if (editor && !editor.readOnly && !editor.disabled && !context.optionRef && !context.optionRefs?.length) {
    state.searchWrite = { editor, previous: state.searchWrite?.previous ?? editor.value, written: value };
    writeText(editor, value);
    await waitForObservation(state, () => !isOutcome(expectedControl(observeControl(element), value, context)), 1500);
    expected = expectedControl(observeControl(element), value, context);
    if (!isOutcome(expected)) return expected;
  }
  // Virtual lists expose only a window. Explore a bounded number of distinct windows.
  const popups = getAssociatedPopups(element);
  const scrollables = popups.flatMap(popup => [popup, ...Array.from(popup.querySelectorAll<HTMLElement>('*'))])
    .filter(candidate => isVisibleControl(candidate) && candidate.scrollHeight > candidate.clientHeight + 1 && candidate.clientHeight > 0);
  const scrollable = scrollables[0];
  if (scrollable) {
    const originalTop = scrollable.scrollTop;
    const seen = new Set<string>();
    for (let step = 0; step < 10 && !interrupted(state, value); step++) {
      const signature = getOptions(element).map(option => `${option.id}:${option.label}`).join('|');
      const key = `${scrollable.scrollTop}:${signature}`;
      if (seen.has(key)) break;
      seen.add(key);
      const nextTop = Math.min(scrollable.scrollHeight - scrollable.clientHeight, scrollable.scrollTop + Math.max(60, scrollable.clientHeight * 0.8));
      if (nextTop <= scrollable.scrollTop) break;
      scrollable.scrollTop = nextTop;
      scrollable.dispatchEvent(new element.ownerDocument.defaultView!.Event('scroll', { bubbles: true }));
      await waitForObservation(state, () => getOptions(element).map(option => `${option.id}:${option.label}`).join('|') !== signature, 250);
      expected = expectedControl(observeControl(element), value, context);
      if (!isOutcome(expected)) return expected;
    }
    if (!state.userEdited) scrollable.scrollTop = originalTop;
  }
  return expected;
}

async function applyExpected(state: AttemptState, expected: ExpectedControl, pointerStrategy: boolean): Promise<void> {
  const { element } = state;
  const observation = observeControl(element);
  if (expected.checked !== undefined) {
    if (isOptionSelected(observation.group[0]) !== expected.checked) activate(observation.group[0], pointerStrategy);
    return;
  }
  if (isNativeSelect(element) && expected.options) {
    const targets = new Set(expected.options.map(option => option.element));
    if (element.multiple) Array.from(element.options).forEach(option => { option.selected = targets.has(option); });
    else element.selectedIndex = Array.from(element.options).findIndex(option => targets.has(option));
    dispatchInput(element);
    return;
  }
  if (expected.options) {
    if (observation.kind === 'checkbox') {
      for (const option of observation.options) {
        if (interrupted(state, expected.value)) return;
        const desired = expected.options.some(target => target.id === option.id);
        if (isOptionSelected(option.element) !== desired && !option.disabled) activate(option.element, pointerStrategy);
      }
    } else if (observation.kind === 'combobox') {
      const extraSelected = observation.options.filter(option => isOptionSelected(option.element)
        && !expected.options!.some(target => target.id === option.id || target.label === option.label));
      if (extraSelected.length && isMultipleControl(element)) {
        for (const extra of extraSelected) {
          if (interrupted(state, expected.value)) return;
          if (isVisibleControl(extra.element)) activate(extra.element, pointerStrategy);
        }
      }
      for (const target of expected.options) {
        if (interrupted(state, expected.value)) return;
        const currentSelected = getOptions(element).find(option => option.label === target.label && isOptionSelected(option.element));
        if (currentSelected && requestedParts(getControlValue(element)).some(label => normalizeOptionLabel(label) === normalizeOptionLabel(target.label))) continue;
        let currentTarget = target;
        if (!currentTarget.element.isConnected || !isVisibleControl(currentTarget.element)) {
          const refreshed = await resolveCombobox(state, target.label);
          if (isOutcome(refreshed) || !refreshed.options?.length) return;
          currentTarget = refreshed.options[0];
        }
        activate(currentTarget.element, pointerStrategy);
        await waitForObservation(state, () => getOptions(element).some(option => option.label === currentTarget.label && isOptionSelected(option.element))
          || requestedParts(getControlValue(element)).includes(currentTarget.label), 600);
      }
    } else {
      for (const target of expected.options) {
        if (interrupted(state, expected.value)) return;
        if (!isOptionSelected(target.element)) activate(target.element, pointerStrategy);
      }
    }
    return;
  }
  element.focus();
  writeText(element, expected.value);
  element.blur();
}

/** One protocol for all entry points. Unsupported controls remain explicit failures. */
export async function fillControl(element: HTMLElement, value: string, context: FillContext = {}): Promise<FillOutcome> {
  const state = beginAttempt(element, context);
  try {
    const stopped = interrupted(state, value);
    if (stopped) return stopped;
    if (!value.trim()) return outcome(state, 'needs-data', '没有可填写的答案', value);
    if (supportsDatePicker(element)) return await fillDatePicker(element, value, context);
    if (supportsUdTreeSelect(element)) return await fillUdTreeSelect(element, value, context);
    if (supportsCascader(element)) return await fillCascader(element, value, context);
    const observation = observeControl(element);
    if (observation.disabled) return outcome(state, 'unsupported', '控件当前不可操作，可能需要先完成关联字段', value);
    if (observation.kind === 'unsupported') return outcome(state, 'unsupported', '该控件需要专用适配或人工填写', value);
    if (observation.kind === 'contenteditable' && element.closest('.ProseMirror, .ql-editor, [data-slate-editor], [data-lexical-editor]')) {
      return outcome(state, 'unsupported', '此富文本编辑器需要通过专用适配写入', value);
    }
    if (observation.readOnly && observation.kind !== 'combobox') return outcome(state, 'unsupported', '只读控件需要通过选择面板操作', value);
    let expected = expectedControl(observation, value, context);
    if (!isOutcome(expected) && satisfies(element, expected, context)) {
      const verified = await stableVerification(state, expected);
      return verified.status === 'verified' ? { ...verified, status: 'unchanged', reason: '现有值已符合目标值' } : verified;
    }
    if (observation.value.trim() && !context.overwrite) return outcome(state, 'skipped-existing', '已保留网页中的现有答案', value);
    if (observation.kind === 'combobox') {
      expected = await resolveCombobox(state, value);
      if (supportsUdTreeSelect(element)) return await fillUdTreeSelect(element, value, { ...context, shouldContinue: () => !interrupted(state, value) });
    }
    if (isOutcome(expected)) return { ...outcome(state, expected.status, expected.reason, value), ...expected };
    const beforeApply = interrupted(state, value);
    if (beforeApply) return beforeApply;
    if (observeControl(element).disabled) return outcome(state, 'unsupported', '页面已将该字段禁用，需要重新读取关联状态', value);
    state.attempts++;
    await applyExpected(state, expected, false);
    let result = await stableVerification(state, expected);
    // A click-only widget may require a pointer sequence. Retry only if unchanged;
    // never toggle a committed/partially committed choice or overwrite a user's edit.
    if (result.status === 'unverified' && ['radio', 'checkbox', 'combobox'].includes(observation.kind)
      && getControlValue(element) === observation.value && !interrupted(state, value)
      && (expected.options?.every(option => option.element.isConnected && !isOptionSelected(option.element)) || expected.checked !== undefined)) {
      state.attempts++;
      await applyExpected(state, expected, true);
      result = await stableVerification(state, expected);
    }
    if (result.status === 'verified') verifiedExpectations.set(element, { requestedValue: value, optionRef: context.optionRef, optionRefs: context.optionRefs, expected });
    else verifiedExpectations.delete(element);
    return result;
  } catch (error) {
    return outcome(state, 'failed', error instanceof Error ? error.message : '控件操作失败', value);
  } finally {
    if (!state.userEdited && (!context.shouldContinue || context.shouldContinue())) {
      const search = state.searchWrite;
      if (search && !getControlValue(element) && search.editor.isConnected && search.editor.value === search.written) {
        writeText(search.editor, search.previous);
      }
      if (state.openedPopup && element.isConnected && getAssociatedPopups(element).some(isVisibleControl)) {
        const view = element.ownerDocument.defaultView!;
        (getEditableElement(element) || element).dispatchEvent(new view.KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true, composed: true }));
      }
    }
    state.stop();
  }
}

/** A later form-level sweep catches dependency updates and delayed rollbacks. */
export async function verifyControl(element: HTMLElement, value: string, context: FillContext = {}): Promise<FillOutcome> {
  const state = beginAttempt(element, context);
  try {
    const stopped = interrupted(state, value);
    if (stopped) return stopped;
    if (supportsDatePicker(element)) return await verifyDatePicker(element, value, context);
    if (supportsUdTreeSelect(element)) return await verifyUdTreeSelect(element, value, context);
    if (supportsCascader(element)) return await verifyCascader(element, value, context);
    const observation = observeControl(element);
    const expected = expectedControl(observation, value, context);
    if (isOutcome(expected)) {
      const previous = verifiedExpectations.get(element);
      if (previous && previous.requestedValue === value && previous.optionRef === context.optionRef && JSON.stringify(previous.optionRefs) === JSON.stringify(context.optionRefs)) {
        return await stableVerification(state, previous.expected);
      }
      // Committed comboboxes may remove all option nodes after selection. Require a
      // separate committed display whose label resolves unambiguously to the goal.
      if (observation.kind === 'combobox' && observation.value && !context.optionRef && !context.optionRefs?.length) {
        const multiple = isMultipleControl(element);
        const labels = multiple ? requestedParts(observation.value) : [observation.value];
        const desiredParts = multiple ? requestedParts(value) : [value];
        const options = labels.map((label, index) => ({ id: `committed-display-${index}`, label, element }));
        const matches = desiredParts.map(desired => resolveOption({ desired, semantic: context.semantic, options, completeness: 'complete' }));
        if (desiredParts.length === labels.length && matches.every(match => match.status === 'matched')) {
          return await stableVerification(state, { value, options });
        }
      }
      return outcome(state, expected.status, expected.reason, value);
    }
    return await stableVerification(state, expected);
  } finally { state.stop(); }
}

export { discoverControls, observeControl, getControlValue, getOptions } from './controlObservation.ts';
