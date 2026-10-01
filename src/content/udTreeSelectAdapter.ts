import type { FillOutcome, FillStatus } from '../shared/fillModel.ts';
import type { FillContext } from './fillEngine.ts';
import { resolveOption, normalizeOptionLabel } from '../utils/optionResolver.ts';
import { activateControl, isAutomatedControlAction } from './controlActivation.ts';
import { associateNearbyPopup, getAssociatedPopups, getControlIdentity, getControlValue, getEditableElement,
  getOptions, isDisabledControl, isMultipleControl, isUdTreeBranch, isVisibleControl, udTreeCheckbox, udTreePath } from './controlObservation.ts';

const committed = new WeakMap<HTMLElement, { value: string; refs: string; labels: string[]; elements: HTMLElement[]; qualified: boolean }>();
const pause = () => new Promise<void>(resolve => setTimeout(resolve, 40));
export function supportsUdTreeSelect(element: HTMLElement): boolean {
  return Boolean(element.closest('.ud__select')) && getAssociatedPopups(element).some(popup =>
    popup.matches('.ud__treeSelect__overlay') || Boolean(popup.querySelector('.ud__treeSelect__overlay, .ud__tree__node')));
}
const refsOf = (context: FillContext) => JSON.stringify(context.optionRefs || (context.optionRef ? [context.optionRef] : []));
function sameSet(actual: string[], desired: string[]) {
  const left = new Set(actual.map(normalizeOptionLabel)), right = new Set(desired.map(normalizeOptionLabel));
  return left.size === right.size && [...left].every(value => right.has(value));
}
function result(element: HTMLElement, value: string, status: FillStatus, reason: string, attempts = 0): FillOutcome {
  return { status, reason, expectedValue: value, observedValue: getControlValue(element), fieldId: getControlIdentity(element), adapterId: 'dom-ud-tree-select', attempts };
}
export async function verifyUdTreeSelect(element: HTMLElement, value: string, context: FillContext = {}): Promise<FillOutcome> {
  const stored = committed.get(element);
  const prior = stored?.value === value && stored.refs === refsOf(context) ? stored : undefined;
  let labels = prior?.labels;
  if (!labels && !context.optionRefs?.length && !context.optionRef) labels = value.split(/[,，、;；\n]+/).map(part => part.trim()).filter(Boolean);
  if (!labels) return result(element, value, 'unverified', '目标树选项身份尚未确认');
  const deadline = Date.now() + (context.timeoutMs ?? 1800);
  let stableSince: number | undefined;
  do {
    if (context.shouldContinue?.() === false) return result(element, value, 'cancelled', '树选择已停止');
    if (!element.isConnected) return result(element, value, 'stale', '树选择控件已被替换');
    const editor = getEditableElement(element);
    const selected = getControlValue(element).split('、').filter(Boolean);
    const invalid = element.getAttribute('aria-invalid') === 'true' || editor?.getAttribute('aria-invalid') === 'true';
    const identitiesValid = !prior || prior.elements.every(node => node.isConnected ? Boolean(udTreeCheckbox(node)?.checked) : !prior.qualified);
    if (sameSet(selected, labels) && !invalid && identitiesValid) {
      stableSince ??= Date.now();
      if (Date.now() - stableSince >= (context.settleMs ?? 450)) return result(element, value, 'verified', '已验证树选择的实际答案');
    } else stableSince = undefined;
    await pause();
  } while (Date.now() < deadline);
  return result(element, value, 'unverified', '未能确认网页已保留目标树选项');
}
/** Expands proven branch toggles to read options, never selects a checkbox. */
export async function expandUdTreeOptions(element: HTMLElement, shouldContinue: () => boolean, deadline = Date.now() + 1800): Promise<number> {
  let attempts = 0;
    const expanded = new WeakSet<HTMLElement>();
    for (let round = 0; round < 8 && Date.now() < deadline && shouldContinue(); round++) {
      const nodes = getAssociatedPopups(element).flatMap(popup => Array.from(popup.querySelectorAll<HTMLElement>('.ud__tree__node')));
      const branch = nodes.find(node => isVisibleControl(node) && !expanded.has(node) && !isDisabledControl(node) && isUdTreeBranch(node)
        && !Array.from(node.querySelectorAll<HTMLElement>('.ud__tree__node')).some(child => isVisibleControl(child)));
      if (!branch) break;
      const toggle = Array.from(branch.querySelectorAll<HTMLElement>('.ud__tree__node-switcher:not(.ud__tree__node-switcher-noop)'))
        .find(candidate => candidate.closest('.ud__tree__node') === branch && isVisibleControl(candidate) && !isDisabledControl(candidate));
      expanded.add(branch);
      if (!toggle) continue;
      activateControl(toggle); attempts++;
      const ready = Math.min(deadline, Date.now() + 500);
      while (Date.now() < ready && shouldContinue() && !Array.from(branch.querySelectorAll<HTMLElement>('.ud__tree__node')).some(isVisibleControl)) await pause();
    }
  return attempts;
}

export async function fillUdTreeSelect(element: HTMLElement, value: string, context: FillContext = {}): Promise<FillOutcome> {
  const deadline = Date.now() + (context.timeoutMs ?? 6000);
  const requested = value.split(/[,，、;；\n]+/).map(part => part.trim()).filter(Boolean);
  if (!requested.length) return result(element, value, 'needs-data', '没有可填写的答案');
  if (isDisabledControl(element)) return result(element, value, 'unsupported', '树控件当前不可操作');
  if (getControlValue(element) && !context.overwrite) return result(element, value, 'skipped-existing', '已保留现有树选择');
  let userEdited = false, attempts = 0;
  const root = element.getRootNode();
  const onUser = (event: Event) => {
    if (!event.isTrusted || isAutomatedControlAction(element.ownerDocument) || !(event.target instanceof Node)) return;
    if (element.contains(event.target) || getAssociatedPopups(element).some(popup => popup.contains(event.target as Node))) userEdited = true;
  };
  const events = ['pointerdown', 'keydown', 'beforeinput', 'input', 'change'];
  events.forEach(type => root.addEventListener(type, onUser, true));
  const stop = () => userEdited ? result(element, value, 'user-edited', '用户开始编辑，已停止树选择', attempts)
    : context.shouldContinue?.() === false ? result(element, value, 'cancelled', '树选择已停止', attempts)
      : !element.isConnected ? result(element, value, 'stale', '树控件已被替换', attempts)
        : Date.now() >= deadline ? result(element, value, 'failed', '树选择的操作时间已用完', attempts) : null;
  try {
    associateNearbyPopup(element);
    if (!getAssociatedPopups(element).some(isVisibleControl)) {
      activateControl(element.querySelector<HTMLElement>('.ud__select__selector') || getEditableElement(element) || element); attempts++;
    }
    while (!getAssociatedPopups(element).some(isVisibleControl) && Date.now() < deadline && !stop()) { associateNearbyPopup(element); await pause(); }
    if (stop()) return stop()!;
    if (!getAssociatedPopups(element).some(isVisibleControl)) return result(element, value, 'unsupported', '未找到归属明确的树面板', attempts);
    attempts += await expandUdTreeOptions(element, () => !stop(), deadline);
    if (stop()) return stop()!;
    const leaves = getOptions(element).filter(option => option.element.matches('.ud__tree__node') && !option.disabled && udTreeCheckbox(option.element));
    const refs = context.optionRefs || (context.optionRef ? [context.optionRef] : undefined);
    const targets = refs ? refs.map(id => leaves.find(option => option.id === id)) : requested.map(desired => {
      const qualified = /[/／>＞→›]/.test(desired);
      const match = resolveOption({ desired, options: leaves.map(option => ({ ...option, label: qualified ? udTreePath(option.element).join(' / ') : option.label })), completeness: 'partial' });
      return match.status === 'matched' ? leaves.find(option => option.id === match.option.id) : undefined;
    });
    if (targets.some(target => !target) || !targets.length || (!isMultipleControl(element) && targets.length > 1)) return result(element, value, 'needs-mapping', '未找到唯一且可选择的叶子选项，请在网页中选择', attempts);
    const labels = targets.map(target => target!.label);
    if (new Set(labels).size !== labels.length) return result(element, value, 'needs-mapping', '同名树选项需要逐项确认层级', attempts);
    if (requested.some(part => /[/／>＞→›]/.test(part)) && targets.some(target => !requested.some(part => {
      const desiredPath = part.split(/\s*[/／>＞→›]\s*/).map(normalizeOptionLabel);
      const actualPath = udTreePath(target!.element).map(normalizeOptionLabel);
      return desiredPath.length === actualPath.length && desiredPath.every((label, index) => label === actualPath[index]);
    }))) return result(element, value, 'needs-mapping', '树选项的层级与资料不一致', attempts);
    for (const target of targets) {
      if (stop()) return stop()!;
      const checkbox = udTreeCheckbox(target!.element)!;
      if (!checkbox.isConnected || !isVisibleControl(target!.element) || checkbox.disabled) return result(element, value, 'stale', '目标树节点已变化', attempts);
      if (!checkbox.checked) { activateControl(checkbox); attempts++; }
      await pause();
    }
    if (stop()) return stop()!;
    committed.set(element, { value, refs: refsOf(context), labels, elements: targets.map(target => target!.element), qualified: requested.some(part => /[/／>＞→›]/.test(part)) });
    const verified = await verifyUdTreeSelect(element, value, { ...context, timeoutMs: Math.max(0, deadline - Date.now()), shouldContinue: () => !stop() });
    if (verified.status !== 'verified') committed.delete(element);
    return { ...verified, attempts };
  } finally { events.forEach(type => root.removeEventListener(type, onUser, true)); }
}
