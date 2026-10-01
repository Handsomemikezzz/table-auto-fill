import type { ControlOption } from '../shared/fillModel.ts';

export type ControlKind = 'text' | 'contenteditable' | 'select' | 'radio' | 'checkbox' | 'combobox' | 'date' | 'unsupported';
export interface ObservedOption extends ControlOption { element: HTMLElement }
export interface ControlObservation {
  element: HTMLElement;
  kind: ControlKind;
  label: string;
  value: string;
  disabled: boolean;
  readOnly: boolean;
  options: ObservedOption[];
  optionsComplete: boolean;
  group: HTMLElement[];
}

const identities = new WeakMap<Element, string>();
const associatedPopup = new WeakMap<HTMLElement, HTMLElement>();
const popupOwners = new WeakMap<HTMLElement, HTMLElement>();
export const KNOWN_COMBOBOX_SELECTOR = '.ant-select, .el-select, .MuiAutocomplete-root, .react-select__control, .semi-select, .arco-select, .ud__select, .atsx-select, [class*="sd-Select-container-"], .ant-cascader, .el-cascader, .arco-cascader, .semi-cascader';
export const KNOWN_POPUP_SELECTOR = '[role="listbox"], [role="tree"], .ant-select-dropdown, .el-select-dropdown, .MuiAutocomplete-popper, .react-select__menu, .semi-select-dropdown, .arco-select-popup, .ud__select__dropdown, .ud__treeSelect__overlay, .atsx-select-dropdown';
let nextIdentity = 0;
export function getControlIdentity(element: Element): string {
  let identity = identities.get(element);
  if (!identity) { identity = `control-${++nextIdentity}`; identities.set(element, identity); }
  return identity;
}
export function cleanControlText(value: unknown): string {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}
function isPlaceholderLabel(value: string): boolean {
  return /^(?:请选择(?:\.{3}|…)?|选择|please\s+(?:select|choose)|select|choose)$/i.test(value);
}
export function isNativeInput(element: Element): element is HTMLInputElement { return element.tagName === 'INPUT'; }
export function isNativeSelect(element: Element): element is HTMLSelectElement { return element.tagName === 'SELECT'; }
export function isNativeTextArea(element: Element): element is HTMLTextAreaElement { return element.tagName === 'TEXTAREA'; }
export function isDisabledControl(element: HTMLElement): boolean {
  return element.matches(':disabled, [disabled], [aria-disabled="true"]')
    || Boolean(element.closest('[inert], [aria-disabled="true"]'));
}
export function isVisibleControl(element: HTMLElement): boolean {
  if (!element.isConnected || element.closest('[hidden], [inert], [aria-hidden="true"]')) return false;
  for (let parent = element.parentElement; parent; parent = parent.parentElement) {
    const parentStyle = element.ownerDocument.defaultView?.getComputedStyle(parent);
    if (!parentStyle || !/(hidden|clip)/.test(`${parentStyle.overflowX} ${parentStyle.overflowY}`)) continue;
    const parentRect = parent.getBoundingClientRect();
    if (parentRect.width === 0 || parentRect.height === 0) return false;
  }
  const style = element.ownerDocument.defaultView?.getComputedStyle(element);
  const rect = element.getBoundingClientRect();
  if (style?.display !== 'none' && style?.visibility !== 'hidden' && rect.width > 0 && rect.height > 0) return true;
  return isNativeInput(element) && ['radio', 'checkbox'].includes(element.type)
    && Array.from(element.labels || []).some(label => isVisibleControl(label));
}
function labelledText(element: HTMLElement): string {
  const root = element.getRootNode() as Document | ShadowRoot;
  const ids = element.getAttribute('aria-labelledby')?.split(/\s+/).filter(Boolean) || [];
  return cleanControlText(ids.map(id => root.getElementById(id)?.textContent).filter(Boolean).join(' '))
    || cleanControlText(element.getAttribute('aria-label'));
}
export function getOptionLabel(element: HTMLElement): string {
  if (element.tagName === 'OPTION') return cleanControlText((element as HTMLOptionElement).label || element.textContent);
  const accessible = labelledText(element);
  if (accessible) return accessible;
  if (isNativeInput(element)) {
    const labels = Array.from(element.labels || []).map(label => cleanControlText(label.textContent)).filter(Boolean);
    return labels.join(' ') || cleanControlText(element.closest('label')?.textContent);
  }
  if (element.matches('.ud__tree__node')) {
    const clone = element.cloneNode(true) as HTMLElement;
    clone.querySelectorAll('.ud__tree__node, .ud__tree__node-switcher').forEach(child => child.remove());
    return cleanControlText(clone.textContent);
  }
  return cleanControlText(element.textContent);
}
export function getControlKind(element: HTMLElement): ControlKind {
  const role = element.getAttribute('role');
  if (role === 'radio' || role === 'checkbox') return role;
  if (isNativeInput(element) && ['radio', 'checkbox'].includes(element.type)) return element.type as 'radio' | 'checkbox';
  if (isNativeSelect(element)) return 'select';
  if (isNativeInput(element) && ['date', 'month', 'datetime-local', 'week', 'time'].includes(element.type)) return 'date';
  if (role === 'combobox') return 'combobox';
  if (element.matches(KNOWN_COMBOBOX_SELECTOR)
    || (isNativeInput(element) && element.type !== 'hidden' && element.closest(KNOWN_COMBOBOX_SELECTOR))) return 'combobox';
  if (element.isContentEditable || element.getAttribute('contenteditable') === 'true' || element.getAttribute('contenteditable') === 'plaintext-only') return 'contenteditable';
  if (isNativeTextArea(element)) return 'text';
  if (isNativeInput(element) && !['hidden', 'password', 'button', 'submit', 'reset', 'image', 'file', 'color', 'range'].includes(element.type)) return 'text';
  return 'unsupported';
}
export function isChoiceControlElement(element: HTMLElement): boolean {
  return ['radio', 'checkbox'].includes(getControlKind(element));
}
export function getControlGroup(element: HTMLElement): HTMLElement[] {
  const kind = getControlKind(element);
  if (kind !== 'radio' && kind !== 'checkbox') return [element];
  const root = element.getRootNode() as Document | ShadowRoot;
  if (isNativeInput(element)) {
    if (!element.name) return [element];
    const localScope = element.closest('fieldset, [role="radiogroup"], [role="group"]');
    const scope = localScope || element.form || root;
    return Array.from(scope.querySelectorAll<HTMLInputElement>(`input[type="${kind}"]`))
      .filter(candidate => candidate.name === element.name && candidate.form === element.form
        && candidate.closest('fieldset, [role="radiogroup"], [role="group"]') === localScope);
  }
  const scope = element.closest(kind === 'radio' ? '[role="radiogroup"], fieldset, [role="group"]' : '[role="group"], fieldset');
  if (!scope) return [element];
  return Array.from(scope.querySelectorAll<HTMLElement>(`[role="${kind}"]`))
    .filter(candidate => candidate.closest('[role="radiogroup"], fieldset, [role="group"]') === scope);
}
export function getControlLabel(element: HTMLElement): string {
  if (isChoiceControlElement(element)) {
    const container = element.closest('fieldset, [role="radiogroup"], [role="group"], [data-form-field-id], [class*="form-item"], [class*="formItem"]') as HTMLElement | null;
    if (container) {
      const question = labelledText(container) || cleanControlText(container.querySelector(':scope > legend, :scope > label, :scope > [class*="label"]')?.textContent);
      if (question && !getControlGroup(element).some(choice => getOptionLabel(choice) === question)) return question;
    }
    if (getControlGroup(element).length > 1 && isNativeInput(element) && element.name) return element.name;
  }
  const editor = getEditableElement(element);
  const editorLabel = editor && editor !== element ? labelledText(editor)
    || Array.from(editor.labels || []).map(label => cleanControlText(label.textContent)).filter(Boolean).join(' ') : '';
  return labelledText(element)
    || editorLabel
    || ((isNativeInput(element) || isNativeTextArea(element) || isNativeSelect(element))
      ? Array.from(element.labels || []).map(label => cleanControlText(label.textContent)).filter(Boolean).join(' ') : '')
    || cleanControlText(element.closest('label')?.textContent)
    || cleanControlText(element.getAttribute('placeholder') || element.getAttribute('name'))
    || element.id;
}

/** Only explicit ownership or a popup inside this control establishes association. */
export function getAssociatedPopups(element: HTMLElement): HTMLElement[] {
  const root = element.getRootNode() as Document | ShadowRoot;
  const editor = getEditableElement(element);
  const ids = new Set([element, editor].filter(Boolean).flatMap(control => (
    `${control!.getAttribute('aria-controls') || ''} ${control!.getAttribute('aria-owns') || ''}`.split(/\s+/).filter(Boolean)
  )));
  const popups = Array.from(ids).map(id => root.getElementById(id)).filter((popup): popup is HTMLElement => Boolean(popup))
    .map(popup => popup.closest<HTMLElement>('.ant-select-dropdown, .el-select-dropdown, .MuiAutocomplete-popper, .react-select__menu, .semi-select-dropdown, .arco-select-popup, .ud__select__dropdown, .atsx-select-dropdown') || popup);
  const associated = associatedPopup.get(element);
  if (!popups.length && associated?.isConnected && popupOwners.get(associated) === element) popups.push(associated);
  if (!popups.length) popups.push(...Array.from(element.querySelectorAll<HTMLElement>('[role="listbox"], [role="tree"]')));
  return [...new Set(popups)];
}
/** The executor may bind a unique, newly opened nearby popup for a known component. */
export function bindAssociatedPopup(element: HTMLElement, popup: HTMLElement): void {
  associatedPopup.set(element, popup);
  popupOwners.set(popup, element);
}
/** Unique nearby popups of the same known component can also be already open. */
export function associateNearbyPopup(element: HTMLElement): boolean {
  if (getAssociatedPopups(element).some(isVisibleControl)) return true;
  const anchor = element.closest<HTMLElement>(KNOWN_COMBOBOX_SELECTOR);
  if (!anchor) return false;
  const selectors: [string, string][] = [
    ['.ud__select', '.ud__select__dropdown, .ud__treeSelect__overlay'], ['.atsx-select', '.atsx-select-dropdown'],
    ['.ant-select', '.ant-select-dropdown'], ['.el-select', '.el-select-dropdown'],
    ['.semi-select', '.semi-select-dropdown'], ['.arco-select', '.arco-select-popup'],
    ['.MuiAutocomplete-root', '.MuiAutocomplete-popper'], ['.react-select__control', '.react-select__menu'],
  ];
  const component = selectors.find(([control]) => anchor.matches(control));
  if (!component) return false;
  const [controlSelector, selector] = component;
  const root = element.getRootNode() as Document | ShadowRoot;
  const rect = anchor.getBoundingClientRect();
  const visible = Array.from(root.querySelectorAll<HTMLElement>(selector)).filter(isVisibleControl);
  const candidates = visible.filter(popup => !visible.some(other => other !== popup && other.contains(popup))).filter(popup => {
    const owner = popupOwners.get(popup);
    if (owner && owner !== element && owner.isConnected) return false;
    const bounds = popup.getBoundingClientRect();
    const distance = Math.min(Math.abs(bounds.top - rect.bottom), Math.abs(bounds.bottom - rect.top));
    if (!(bounds.left < rect.right && bounds.right > rect.left && distance < 80)) return false;
    // An orphan popup equally close to another control has no proven owner.
    return !Array.from(root.querySelectorAll<HTMLElement>(controlSelector)).some(other => {
      if (other === anchor || anchor.contains(other) || other.contains(anchor) || !isVisibleControl(other)) return false;
      const box = other.getBoundingClientRect();
      return bounds.left < box.right && bounds.right > box.left
        && Math.min(Math.abs(bounds.top - box.bottom), Math.abs(bounds.bottom - box.top)) <= distance + 2;
    });
  });
  if (candidates.length !== 1) return false;
  bindAssociatedPopup(element, candidates[0]); return true;
}
export function isMultipleControl(element: HTMLElement): boolean {
  return getControlKind(element) === 'checkbox' || (isNativeSelect(element) && element.multiple)
    || element.getAttribute('aria-multiselectable') === 'true'
    || getAssociatedPopups(element).some(popup => popup.getAttribute('aria-multiselectable') === 'true')
    || Boolean(element.closest('.ant-select-multiple, .el-select--multiple, .semi-select-multiple, .arco-select-view-multiple, [data-multiple="true"]'))
    || Boolean(element.closest('.ud__select__selector-multiple, .atsx-select-selection--multiple'))
    || Boolean((element.closest('.ud__select, .atsx-select') || element).querySelector('.MuiAutocomplete-tag, .react-select__multi-value__label, .ud__select__selector-multiple, .atsx-select-selection--multiple'));
}
export function isUdTreeBranch(node: HTMLElement): boolean {
  return Boolean(node.querySelector('.ud__tree__node, .ud__tree__node-switcher:not(.ud__tree__node-switcher-noop)'));
}
export function udTreeCheckbox(node: HTMLElement): HTMLInputElement | undefined {
  return Array.from(node.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')).find(input => input.closest('.ud__tree__node') === node);
}
export function udTreePath(node: HTMLElement): string[] {
  const path = [getOptionLabel(node)];
  for (let parent = node.parentElement?.closest<HTMLElement>('.ud__tree__node'); parent; parent = parent.parentElement?.closest<HTMLElement>('.ud__tree__node')) path.unshift(getOptionLabel(parent));
  return path;
}
export function getEditableElement(element: HTMLElement): HTMLInputElement | HTMLTextAreaElement | null {
  if (isNativeInput(element) || isNativeTextArea(element)) return element;
  return element.querySelector<HTMLInputElement | HTMLTextAreaElement>('input:not([type="hidden"]), textarea');
}
export function isOptionSelected(element: HTMLElement): boolean {
  if (element.tagName === 'OPTION') return (element as HTMLOptionElement).selected;
  if (isNativeInput(element)) return element.checked;
  if (element.matches('.ud__tree__node')) return Boolean(udTreeCheckbox(element)?.checked);
  return element.getAttribute('aria-selected') === 'true' || element.getAttribute('aria-checked') === 'true';
}
export function getOptions(element: HTMLElement): ObservedOption[] {
  const kind = getControlKind(element);
  const candidates: HTMLElement[] = kind === 'select'
    ? Array.from((element as HTMLSelectElement).options)
    : (kind === 'radio' || kind === 'checkbox') ? getControlGroup(element)
      : kind === 'combobox' ? getAssociatedPopups(element).flatMap(popup => Array.from(popup.querySelectorAll<HTMLElement>('[role="option"], [role="treeitem"], .ant-select-item-option, .el-select-dropdown__item, .MuiAutocomplete-option, .react-select__option, .semi-select-option, .arco-select-option, .ud__select__list__item, .ud__tree__node')))
        : [];
  return [...new Set(candidates)].filter(candidate => kind !== 'combobox' || isVisibleControl(candidate)).map(candidate => ({
    id: getControlIdentity(candidate), element: candidate, label: getOptionLabel(candidate),
    rawValue: isNativeInput(candidate) || candidate.tagName === 'OPTION' ? (candidate as HTMLInputElement | HTMLOptionElement).value : candidate.getAttribute('data-value') ?? undefined,
    ...(candidate.matches('.ud__tree__node') ? { path: udTreePath(candidate), parentId: candidate.parentElement?.closest('.ud__tree__node') ? getControlIdentity(candidate.parentElement.closest('.ud__tree__node')!) : undefined } : {}),
    disabled: isDisabledControl(candidate)
      || (candidate.matches('.ud__tree__node') && (isUdTreeBranch(candidate) || Boolean(udTreeCheckbox(candidate)?.disabled)))
      || candidate.matches('.is-disabled, .ant-select-item-option-disabled, .semi-select-option-disabled, .arco-select-option-disabled')
      || (candidate.tagName === 'OPTION' && Boolean(candidate.closest('optgroup[disabled]'))),
  })).filter(option => Boolean(option.label));
}

export function getControlValue(element: HTMLElement): string {
  const kind = getControlKind(element);
  if (kind === 'radio' || kind === 'checkbox' || kind === 'select') {
    return getOptions(element).filter(option => isOptionSelected(option.element)
      && !(kind === 'select' && (isPlaceholderLabel(option.label) || (option.rawValue === '' && option.disabled))))
      .map(option => option.label).join('、');
  }
  if (kind === 'combobox') {
    const editor = getEditableElement(element);
    const explicitValue = cleanControlText(element.getAttribute('aria-valuetext') || editor?.getAttribute('aria-valuetext'));
    if (explicitValue) return explicitValue;
    // An editable combobox's input value is its query, not evidence of selection.
    const container = element.closest('.ant-select, .el-select, .MuiAutocomplete-root, .react-select__control, .semi-select, .arco-select, .ud__select, .atsx-select') || element;
    const tokenElements = Array.from(container.querySelectorAll<HTMLElement>('.ant-select-selection-item, .ant-select-content-has-value, .el-select__selected-item, .MuiChip-label, .react-select__single-value, .react-select__multi-value__label, .semi-select-selection-text, .arco-select-view-value, .ud__select__selector__selectItem, .atsx-select-selection-item, .atsx-select-selection-item-content'));
    const tokens = tokenElements.filter(token => !tokenElements.some(other => other !== token && token.contains(other)))
      .filter(token => !token.matches('.is-placeholder, .el-select__placeholder, [data-placeholder]')
        && !getAssociatedPopups(element).some(popup => popup.contains(token)))
      .map(token => {
        const clone = token.cloneNode(true) as HTMLElement;
        clone.querySelectorAll('button, [aria-hidden="true"]').forEach(node => node.remove());
        return cleanControlText(clone.textContent);
      }).filter(text => text && !isPlaceholderLabel(text));
    if (tokens.length) return [...new Set(tokens)].join('、');
    const activeDescendant = editor?.getAttribute('aria-activedescendant') || element.getAttribute('aria-activedescendant');
    const multiple = isMultipleControl(element);
    const committedOptions = getOptions(element).filter(option => option.element.getAttribute('aria-checked') === 'true'
      || (multiple && isOptionSelected(option.element) && option.element.id !== activeDescendant));
    if (committedOptions.length) return committedOptions.map(option => option.label).join('、');
    if (editor) return editor.readOnly ? editor.value.trim() : '';
    const clone = element.cloneNode(true) as HTMLElement;
    clone.querySelectorAll(`${KNOWN_POPUP_SELECTOR}, [aria-hidden="true"]`).forEach(node => node.remove());
    const displayed = cleanControlText(clone.textContent);
    if (displayed === element.getAttribute('aria-placeholder')
      || isPlaceholderLabel(displayed)) return '';
    return displayed;
  }
  if (isNativeInput(element) || isNativeTextArea(element)) return element.value;
  if (kind === 'contenteditable') return element.textContent || '';
  return '';
}
export function observeControl(element: HTMLElement): ControlObservation {
  const kind = getControlKind(element);
  const options = getOptions(element);
  const editor = getEditableElement(element);
  const popups = kind === 'combobox' ? getAssociatedPopups(element) : [];
  return {
    element, kind, label: getControlLabel(element), value: getControlValue(element),
    disabled: isDisabledControl(element) || Boolean(editor?.disabled), readOnly: Boolean(editor?.readOnly), options,
    optionsComplete: kind !== 'combobox' || (popups.length > 0 && popups.every(popup => (
      isVisibleControl(popup) &&
      popup.getAttribute('aria-busy') !== 'true'
      && !Array.from(popup.querySelectorAll<HTMLElement>('.ud__tree__node')).some(node => isVisibleControl(node) && isUdTreeBranch(node)
        && !Array.from(node.querySelectorAll<HTMLElement>('.ud__tree__node')).some(isVisibleControl))
      && !popup.querySelector('[aria-setsize], [aria-posinset], [class*="virtual"]')
      && popup.scrollHeight <= popup.clientHeight
    ))),
    group: getControlGroup(element),
  };
}

/** Includes open shadow roots; cross-origin frames run their own content script. */
export function discoverControls(root: Document | ShadowRoot | HTMLElement): HTMLElement[] {
  const pluginUi = '[data-job-applymate-ui], [data-job-applymate-overlay]';
  if (root instanceof Element && root.closest(pluginUi)) return [];
  if (root instanceof ShadowRoot && (root.host.matches(pluginUi) || root.host.closest(pluginUi))) return [];
  const selector = `input, textarea, select, [role="radio"], [role="checkbox"], [role="combobox"], [contenteditable="true"], [contenteditable="plaintext-only"], ${KNOWN_COMBOBOX_SELECTOR}`;
  const candidates = Array.from(root.querySelectorAll<HTMLElement>(selector));
  if (root instanceof Element && root.matches(selector)) candidates.unshift(root as HTMLElement);
  const result: HTMLElement[] = [];
  const seenGroups = new Set<HTMLElement>();
  for (const element of candidates) {
    if (element.closest(pluginUi)) continue;
    if (element.closest(KNOWN_POPUP_SELECTOR)) continue;
    if (!isVisibleControl(element) || getControlKind(element) === 'unsupported') continue;
    const owner = element.parentElement?.closest<HTMLElement>(`[role="combobox"], [role="radio"], [role="checkbox"], [contenteditable="true"], [contenteditable="plaintext-only"], ${KNOWN_COMBOBOX_SELECTOR}`);
    if (owner && root.contains(owner)) continue;
    if (isChoiceControlElement(element)) {
      const group = getControlGroup(element);
      const representative = group.find(candidate => !isDisabledControl(candidate) && isVisibleControl(candidate)) || element;
      if (seenGroups.has(representative)) continue;
      seenGroups.add(representative);
      result.push(representative);
    } else result.push(element);
  }
  for (const host of Array.from(root.querySelectorAll<HTMLElement>('*'))) {
    if (host.shadowRoot && !host.closest(pluginUi)) result.push(...discoverControls(host.shadowRoot));
  }
  return result;
}
