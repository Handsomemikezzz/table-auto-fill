import { discoverControls, observeControl, getControlIdentity, getOptions, getEditableElement, getAssociatedPopups, bindAssociatedPopup, isVisibleControl, KNOWN_POPUP_SELECTOR, KNOWN_COMBOBOX_SELECTOR } from './controlObservation.ts';
import { FieldMatcher } from '../utils/fieldMatcher.ts';
import { findFormSectionHeading } from '../utils/formContext.ts';
import { dateRangePart } from './fieldBinding.ts';
import { meaningCandidates } from '../autofill/fieldRegistry.ts';
import { versionOf, type FieldDefinition, type FieldObservation } from '../autofill/contracts.ts';

export function createPageObserver(registry: FieldDefinition[], region?: DOMRect) {
  const nodes = new Map<string, HTMLElement>();
  const groupNodes = new Map<string, HTMLElement>();
  function observe(): FieldObservation[] {
    const controls = [...discoverControls(document), ...Array.from(document.querySelectorAll<HTMLInputElement>('input[type="file"]')).filter(element => !element.closest('[data-job-applymate-ui]'))].filter(element => {
      if (!region) return true;
      const rect = element.getBoundingClientRect();
      return rect.left < region.right && rect.right > region.left && rect.top < region.bottom && rect.bottom > region.top;
    });
    return controls.map(element => {
      const observation = observeControl(element);
      const identifiers = FieldMatcher.extractIdentifiers(element);
      const group = findGroup(element, controls);
      const fieldId = getControlIdentity(element);
      const groupId = getControlIdentity(group);
      nodes.set(fieldId, element); groupNodes.set(groupId, group);
      const endpoint = dateRangePart(element);
      let dateGroupId: string | undefined;
      if (endpoint) for (let parent = element.parentElement; parent && parent !== document.body; parent = parent.parentElement) {
        if (controls.filter(control => parent.contains(control)).length === 2) { dateGroupId = getControlIdentity(parent); break; }
      }
      const label = endpoint ? `起止时间（${endpoint === 'start' ? '开始' : '结束'}）` : ['radio', 'checkbox'].includes(observation.kind) ? observation.label : identifiers.labelText || observation.label || identifiers.placeholder || identifiers.name || '未命名字段';
      const groupLabel = findFormSectionHeading(element) || group.querySelector('legend,h2,h3,h4')?.textContent?.trim().slice(0, 100) || '当前表单';
      const protectedControl = element.getAttribute('autocomplete') === 'one-time-code' || /验证码|短信验证|captcha|verification.?code|one.?time.?password/i.test(`${label} ${identifiers.name}`);
      const options = observation.options.map(({ element: _element, ...option }) => option);
      const shape = { structure: controls.filter(control => group.contains(control)).map(control => [control.getAttribute('name'), FieldMatcher.extractIdentifiers(control).labelText, observeControl(control).kind]), label, groupLabel, name: element.getAttribute('name'), kind: observation.kind, part: dateRangePart(element), options: options.map(({ id: _id, ...option }) => option) };
      const signature = versionOf(shape);
      const data = { fieldId, origin: location.origin, frameId: location.origin + location.pathname, groupId, groupLabel, dateGroupId, signature, label,
        context: `${identifiers.contextText || ''} ${dateRangePart(element) || ''} ${element.getAttribute('placeholder') || ''}`.slice(0, 600),
        kind: protectedControl ? 'unsupported' : element.matches('input[type=file]') ? 'file' : observation.kind, required: element.hasAttribute('required') || element.getAttribute('aria-required') === 'true',
        currentValue: protectedControl ? '' : element.matches('input[type=file]') ? Array.from((element as HTMLInputElement).files || []).map(file => file.name).join(', ') : observation.value, disabled: protectedControl || observation.disabled, options,
        optionsState: observation.optionsComplete ? 'complete' as const : options.length ? 'partial' as const : 'unread' as const,
        candidates: meaningCandidates(`${groupLabel} ${label}`, registry),
      };
      return { ...data, snapshotVersion: versionOf(data) };
    });
  }
  return { observe, nodes, groupNodes };
}
function findGroup(element: HTMLElement, controls: HTMLElement[]): HTMLElement {
  const explicit = element.closest<HTMLElement>('[data-record-id], [data-entry-id], .education-item, .experience-item, .project-item, [data-record], fieldset, [role="group"]');
  if (explicit) return explicit;
  // Repeated sibling containers are observations of record structure, never a choice of profile record.
  for (let parent = element.parentElement; parent && parent !== document.body; parent = parent.parentElement) {
    if (parent.tagName === 'FORM') return parent;
    if (controls.filter(control => parent.contains(control)).length < 2) continue;
    const peers = Array.from(parent.parentElement?.children || []).filter(peer => peer !== parent && peer.tagName === parent.tagName && peer.className === parent.className && controls.some(control => peer.contains(control)));
    if (peers.length || parent.matches('section, [data-section]')) return parent;
  }
  return element.closest('form') || document.body;
}

/** Opens/searches a control but never chooses an option by text similarity. */
export async function readModelOptions(element: HTMLElement, query: string | undefined, shouldContinue: () => boolean) {
  if (!shouldContinue() || !element.isConnected || observeControl(element).value) return;
  const root = element.getRootNode() as Document | ShadowRoot;
  const before = new Set(Array.from(root.querySelectorAll<HTMLElement>(KNOWN_POPUP_SELECTOR)).filter(isVisibleControl));
  const editor = getEditableElement(element);
  const trigger = element.querySelector<HTMLElement>('.ant-select-selector, .el-select__wrapper, .ud__select__selector') || editor || element;
  if (!getAssociatedPopups(element).some(isVisibleControl)) {
    trigger.focus();
    trigger.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    trigger.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    trigger.click();
  }
  for (let step = 0; step < 12 && shouldContinue(); step++) {
    await new Promise(resolve => setTimeout(resolve, 50));
    if (getAssociatedPopups(element).some(isVisibleControl)) break;
    const anchor = element.closest(KNOWN_COMBOBOX_SELECTOR) || element;
    const rect = anchor.getBoundingClientRect();
    const opened = Array.from(root.querySelectorAll<HTMLElement>(KNOWN_POPUP_SELECTOR)).filter(popup => !before.has(popup) && isVisibleControl(popup));
    const nearby = opened.filter(popup => !opened.some(other => other !== popup && other.contains(popup))).filter(popup => {
      const bounds = popup.getBoundingClientRect();
      return bounds.left < rect.right && bounds.right > rect.left && Math.min(Math.abs(bounds.top - rect.bottom), Math.abs(bounds.bottom - rect.top)) < 240;
    });
    if (nearby.length === 1) bindAssociatedPopup(element, nearby[0]);
  }
  for (let step = 0; step < 24 && shouldContinue(); step++) {
    if (getOptions(element).length && getAssociatedPopups(element).every(popup => popup.getAttribute('aria-busy') !== 'true')) break;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  if (shouldContinue() && query && editor && !editor.readOnly && !editor.disabled && !editor.value && getAssociatedPopups(element).length) {
    Object.getOwnPropertyDescriptor(editor.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype, 'value')?.set?.call(editor, query);
    editor.dispatchEvent(new Event('input', { bubbles: true }));
    await new Promise(resolve => setTimeout(resolve, 400));
  }
}
