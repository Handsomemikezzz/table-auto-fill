import type { FillOutcome, FillStatus } from '../shared/fillModel.ts';
import type { FillContext } from './fillEngine.ts';
import { normalizeOptionLabel, resolveOption } from '../utils/optionResolver.ts';
import {
  bindAssociatedPopup, getAssociatedPopups, getControlIdentity, getEditableElement,
  isDisabledControl, isVisibleControl,
} from './controlObservation.ts';

const CASCADER = '.ant-cascader, .el-cascader, .arco-cascader, .semi-cascader, [data-cascader]';
const POPUP = '[role="tree"], .ant-cascader-menus, .ant-cascader-dropdown, .el-cascader__dropdown, .arco-cascader-popup, .semi-cascader-panel';
const COLUMN = '.ant-cascader-menu, .el-cascader-menu, .arco-cascader-panel-column, .semi-cascader-panel-list';
const ITEM = '.ant-cascader-menu-item, .el-cascader-node, .arco-cascader-panel-item, .semi-cascader-option';
const committedPaths = new WeakMap<HTMLElement, string[]>();
const pause = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

export interface CascaderNode {
  id: string;
  label: string;
  parentId?: string;
  level: number;
  disabled?: boolean;
  active?: boolean;
  expanded?: boolean;
}
export type CascaderPlan = { type: 'select'; targetId: string } | { type: 'blocked'; reason: string };

/** A path is explicit data. Never infer province/city boundaries from concatenated text. */
export function parseCascaderPath(value: string): string[] | null {
  if (!/[/／>＞→›]/.test(value)) return null;
  const path = value.split(/\s*[/／>＞→›]\s*/).map(part => part.trim());
  return path.length >= 2 && path.length <= 5 && path.every(Boolean) ? path : null;
}

/** Each choice is resolved only among siblings of the already established parent. */
export function planCascaderStep(nodes: readonly CascaderNode[], path: readonly string[], step: number): CascaderPlan {
  if (step < 0 || step >= path.length) return { type: 'blocked', reason: '层级路径不完整' };
  let parentId: string | undefined;
  for (let level = 0; level <= step; level++) {
    const siblings = nodes.filter(node => node.level === level && node.parentId === parentId);
    const match = resolveOption({ desired: path[level], options: siblings, completeness: 'complete' });
    if (match.status !== 'matched') return { type: 'blocked', reason: match.status === 'ambiguous'
      ? '同一父级中存在多个同名选项，需要人工确认' : '当前父级下尚未找到目标选项' };
    const node = siblings.find(candidate => candidate.id === match.option.id)!;
    if (level === step) return { type: 'select', targetId: node.id };
    if (!node.expanded && !node.active) return { type: 'blocked', reason: '上级选项尚未确认展开，不能填写下一级' };
    parentId = node.id;
  }
  return { type: 'blocked', reason: '层级路径不完整' };
}

export function supportsCascader(element: HTMLElement): boolean {
  return Boolean(element.closest(CASCADER)) || element.getAttribute('aria-haspopup') === 'tree'
    || getEditableElement(element)?.getAttribute('aria-haspopup') === 'tree'
    || getAssociatedPopups(element).some(popup => popup.matches('[role="tree"]'));
}
function labelOf(node: HTMLElement): string {
  const root = node.getRootNode() as Document | ShadowRoot;
  const ids = node.getAttribute('aria-labelledby')?.split(/\s+/).filter(Boolean) || [];
  const accessible = ids.map(id => root.getElementById(id)?.textContent || '').join(' ').trim() || node.getAttribute('aria-label');
  if (accessible) return accessible.replace(/\s+/g, ' ').trim();
  const clone = node.cloneNode(true) as HTMLElement;
  clone.querySelectorAll('[role="group"], ul, ol, [aria-hidden="true"]').forEach(child => child.remove());
  return (clone.textContent || '').replace(/\s+/g, ' ').trim();
}
function selected(node: HTMLElement): boolean {
  return node.getAttribute('aria-selected') === 'true' || node.getAttribute('aria-checked') === 'true'
    || node.matches('.ant-cascader-menu-item-active, .in-active-path, .is-active, .is-checked, .arco-cascader-panel-item-active, .semi-cascader-option-active');
}
function disabled(node: HTMLElement): boolean {
  return isDisabledControl(node) || node.matches('.ant-cascader-menu-item-disabled, .is-disabled, .arco-cascader-panel-item-disabled, .semi-cascader-option-disabled');
}
function readNodes(popup: HTMLElement): { nodes: CascaderNode[]; elements: Map<string, HTMLElement> } {
  const elements = new Map<string, HTMLElement>();
  const treeItems = Array.from(popup.querySelectorAll<HTMLElement>('[role="treeitem"]'));
  const columns = Array.from(popup.querySelectorAll<HTMLElement>(COLUMN));
  const nodes: CascaderNode[] = [];
  if (columns.length) {
    let parentId: string | undefined;
    columns.forEach((column, level) => {
      const items = Array.from(column.querySelectorAll<HTMLElement>(`${ITEM}, [role="treeitem"]`))
        .filter(item => item.closest(COLUMN) === column);
      const active = items.filter(item => selected(item) || item.getAttribute('aria-expanded') === 'true');
      for (const item of items) {
        const id = getControlIdentity(item);
        elements.set(id, item);
        nodes.push({ id, label: labelOf(item), parentId, level, disabled: disabled(item), active: selected(item), expanded: item.getAttribute('aria-expanded') === 'true' });
      }
      // An unproven parent makes the next column unusable, never a root option.
      parentId = active.length === 1 ? getControlIdentity(active[0]) : `unconfirmed-parent-${level}`;
    });
  } else {
    for (const item of treeItems) {
      let parent = item.parentElement?.closest<HTMLElement>('[role="treeitem"]');
      if (parent && !popup.contains(parent)) parent = null;
      let level = 0;
      let ancestor = parent;
      while (ancestor) {
        level++;
        ancestor = ancestor.parentElement?.closest<HTMLElement>('[role="treeitem"]') || null;
        if (ancestor && !popup.contains(ancestor)) ancestor = null;
      }
      // Flat aria-level trees lack a proven parent relationship; leave them unsupported.
      const ariaLevel = Number(item.getAttribute('aria-level') || level + 1);
      if (!parent && ariaLevel > 1) continue;
      const id = getControlIdentity(item);
      elements.set(id, item);
      nodes.push({ id, label: labelOf(item), parentId: parent ? getControlIdentity(parent) : undefined,
        level, disabled: disabled(item), active: selected(item), expanded: item.getAttribute('aria-expanded') === 'true' });
    }
  }
  return { nodes, elements };
}
function displayPath(element: HTMLElement): string[] | null {
  const owner = element.closest(CASCADER) || element;
  const token = owner.querySelector<HTMLElement>('.ant-select-selection-item, .ant-select-content-has-value, .el-cascader__label, .arco-cascader-view-value, .semi-cascader-selection');
  const value = element.getAttribute('aria-valuetext') || token?.getAttribute('title') || token?.textContent
    || getEditableElement(element)?.value || '';
  return parseCascaderPath(value);
}
function samePath(actual: readonly string[] | null, desired: readonly string[]): boolean {
  return Boolean(actual && actual.length === desired.length && actual.every((part, index) => normalizeOptionLabel(part) === normalizeOptionLabel(desired[index])));
}
function result(element: HTMLElement, value: string, status: FillStatus, reason: string, attempts = 0): FillOutcome {
  return { status, reason, expectedValue: value, observedValue: displayPath(element)?.join(' / ') || '',
    fieldId: getControlIdentity(element), adapterId: 'dom-cascader', attempts };
}
function valid(element: HTMLElement): boolean {
  const editor = getEditableElement(element);
  return element.getAttribute('aria-invalid') !== 'true' && editor?.getAttribute('aria-invalid') !== 'true' && (!editor || editor.validity.valid);
}
function visiblePopups(element: HTMLElement): HTMLElement[] {
  const root = element.getRootNode() as Document | ShadowRoot;
  const candidates = Array.from(root.querySelectorAll<HTMLElement>(POPUP)).filter(isVisibleControl);
  return candidates.filter(popup => !candidates.some(other => other !== popup && other.contains(popup)));
}
function hasSelectedPath(element: HTMLElement, path: string[]): boolean {
  if (samePath(committedPaths.get(element) || null, path)) return true;
  return getAssociatedPopups(element).some(popup => {
    const { nodes } = readNodes(popup);
    const plan = planCascaderStep(nodes, path, path.length - 1);
    return plan.type === 'select' && nodes.some(node => node.id === plan.targetId && node.active);
  });
}

export async function verifyCascader(element: HTMLElement, value: string, context: FillContext = {}): Promise<FillOutcome> {
  const path = parseCascaderPath(value);
  if (!path) return result(element, value, 'needs-mapping', '需要明确的完整层级路径，例如“省 / 市 / 区”');
  const deadline = Date.now() + (context.timeoutMs ?? 1800);
  let stableSince: number | undefined;
  do {
    if (context.shouldContinue?.() === false) return result(element, value, 'cancelled', '层级选择已取消');
    if (!element.isConnected) return result(element, value, 'stale', '层级控件已被页面替换');
    if (samePath(displayPath(element), path) && hasSelectedPath(element, path) && valid(element)) {
      stableSince ??= Date.now();
      if (Date.now() - stableSince >= (context.settleMs ?? 450)) return result(element, value, 'verified', '已验证完整层级路径');
    } else stableSince = undefined;
    await pause(40);
  } while (Date.now() < deadline);
  return result(element, value, valid(element) ? 'unverified' : 'rejected', '未能验证控件已接受完整层级路径');
}

export async function fillCascader(element: HTMLElement, value: string, context: FillContext = {}): Promise<FillOutcome> {
  const path = parseCascaderPath(value);
  if (!path) return result(element, value, 'needs-mapping', '需要明确的完整层级路径，例如“省 / 市 / 区”');
  if (isDisabledControl(element)) return result(element, value, 'unsupported', '层级控件当前不可操作');
  if (context.shouldContinue?.() === false) return result(element, value, 'cancelled', '层级选择已取消');
  if (samePath(displayPath(element), path) && hasSelectedPath(element, path)) {
    const verified = await verifyCascader(element, value, context);
    return verified.status === 'verified' ? { ...verified, status: 'unchanged' } : verified;
  }
  const owner = element.closest(CASCADER) as HTMLElement | null;
  const existing = element.getAttribute('aria-valuetext') || getEditableElement(element)?.value || displayPath(element)?.join(' / ');
  if (existing && !context.overwrite) return result(element, value, 'skipped-existing', '保留层级控件中的已有答案');
  const deadline = Date.now() + (context.timeoutMs ?? 10000);
  let popup: HTMLElement | undefined;
  let userEdited = false;
  let attempts = 0;
  const root = element.getRootNode();
  const onUserEvent = (event: Event) => {
    if (event.isTrusted && event.target instanceof Node
      && ((owner || element).contains(event.target) || popup?.contains(event.target))) userEdited = true;
  };
  const events = ['pointerdown', 'keydown', 'beforeinput'];
  events.forEach(type => root.addEventListener(type, onUserEvent, true));
  const stopped = (): FillOutcome | null => userEdited ? result(element, value, 'user-edited', '用户开始编辑，已停止层级选择', attempts)
    : context.shouldContinue?.() === false ? result(element, value, 'cancelled', '层级选择已取消', attempts)
      : !element.isConnected ? result(element, value, 'stale', '层级控件已被页面替换', attempts)
        : Date.now() >= deadline ? result(element, value, 'failed', '层级选择的操作时间已用完', attempts) : null;
  try {
    const before = new Set(visiblePopups(element));
    popup = getAssociatedPopups(element).find(isVisibleControl);
    if (!popup) {
      (getEditableElement(element) || element).focus();
      const trigger = owner?.querySelector<HTMLElement>('.ant-select-selector, .ant-select-content, .el-input, .arco-cascader-view') || element;
      // Select-based cascaders (including Ant Design 6) open on mousedown.
      // This is an ordinary DOM gesture, without framework-private handlers.
      if (owner?.matches('.ant-cascader')) {
        const view = element.ownerDocument.defaultView!;
        trigger.dispatchEvent(new view.PointerEvent('pointerdown', { bubbles: true, cancelable: true, composed: true }));
        trigger.dispatchEvent(new view.MouseEvent('mousedown', { bubbles: true, cancelable: true, composed: true }));
        trigger.dispatchEvent(new view.MouseEvent('mouseup', { bubbles: true, cancelable: true, composed: true }));
      }
      trigger.click();
      attempts++;
    }
    const openDeadline = Math.min(deadline, Date.now() + 1500);
    while (!popup && Date.now() < openDeadline && !stopped()) {
      const owned = getAssociatedPopups(element).filter(isVisibleControl);
      const rect = (owner || element).getBoundingClientRect();
      const added = visiblePopups(element).filter(candidate => {
        if (before.has(candidate)) return false;
        const candidateRect = candidate.getBoundingClientRect();
        return candidateRect.left < rect.right && candidateRect.right > rect.left
          && Math.min(Math.abs(candidateRect.top - rect.bottom), Math.abs(candidateRect.bottom - rect.top)) < 240;
      });
      const candidates = owned.length ? owned : owner ? added : [];
      if (candidates.length > 1) return result(element, value, 'unsupported', '多个层级面板出现，无法确定归属', attempts);
      popup = candidates[0];
      if (popup) bindAssociatedPopup(element, popup);
      else await pause(40);
    }
    const interruption = stopped();
    if (interruption) return interruption;
    if (!popup) return result(element, value, 'unsupported', '未找到能确定关联的层级面板', attempts);
    for (let step = 0; step < path.length; step++) {
      const interrupted = stopped();
      if (interrupted) return interrupted;
      let observation = readNodes(popup);
      let plan = planCascaderStep(observation.nodes, path, step);
      const readyDeadline = Math.min(deadline, Date.now() + 1500);
      while (plan.type !== 'select' && Date.now() < readyDeadline && !stopped()) {
        await pause(40);
        observation = readNodes(popup);
        plan = planCascaderStep(observation.nodes, path, step);
      }
      if (stopped()) return stopped()!;
      if (plan.type !== 'select') return result(element, value, 'needs-mapping', plan.reason, attempts);
      const target = observation.elements.get(plan.targetId)!;
      if (!target.isConnected || !isVisibleControl(target) || disabled(target)) return result(element, value, 'stale', '目标层级选项已变化', attempts);
      target.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
      target.click();
      attempts++;
      if (step === path.length - 1) {
        // Clicking is only an attempt. A leaf must be selected, or the popup must
        // close while the full path appears; a pre-existing search query is insufficient.
        const commitDeadline = Math.min(deadline, Date.now() + 1500);
        while (Date.now() < commitDeadline && !stopped()) {
          if (samePath(displayPath(element), path)
            && (hasSelectedPath(element, path) || !popup.isConnected || !isVisibleControl(popup))) {
            committedPaths.set(element, [...path]);
            break;
          }
          await pause(40);
        }
      } else {
        const expandDeadline = Math.min(deadline, Date.now() + 1500);
        while (Date.now() < expandDeadline && !stopped()) {
          const next = readNodes(popup);
          if (planCascaderStep(next.nodes, path, step + 1).type === 'select') break;
          await pause(40);
        }
      }
    }
    const verified = await verifyCascader(element, value, { ...context, timeoutMs: Math.max(0, deadline - Date.now()),
      shouldContinue: () => !userEdited && context.shouldContinue?.() !== false });
    if (verified.status !== 'verified') committedPaths.delete(element);
    return userEdited ? result(element, value, 'user-edited', '用户开始编辑，已停止层级选择', attempts) : { ...verified, attempts };
  } finally { events.forEach(type => root.removeEventListener(type, onUserEvent, true)); }
}
