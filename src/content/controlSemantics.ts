import { observeControl, getOptions, getControlValue } from './controlObservation.ts';
import { scoreDropdownOption } from '../utils/dropdownOption.ts';
export type FormControl = HTMLElement;

export function isChoiceControl(element: FormControl): element is HTMLInputElement {
  return element instanceof HTMLInputElement && ['radio', 'checkbox'].includes(element.type);
}

export function getChoiceLabel(element: HTMLInputElement): string {
  const root = element.getRootNode() as Document | ShadowRoot;
  const explicit = element.id
    ? root.querySelector(`label[for="${CSS.escape(element.id)}"]`)?.textContent
    : '';
  return normalizeText(
    explicit
      || element.closest('label')?.textContent
      || element.getAttribute('aria-label')
      || element.value,
  );
}

export function getChoiceGroup(element: HTMLInputElement): HTMLInputElement[] {
  const root = element.getRootNode() as Document | ShadowRoot;
  if (!element.name) return [element];
  const selector = `input[type="${CSS.escape(element.type)}"][name="${CSS.escape(element.name)}"]`;
  const allChoices = Array.from(root.querySelectorAll<HTMLInputElement>(selector));
  const form = element.form;
  const scope = element.closest('form, fieldset, [role="group"], [role="radiogroup"]');
  const choices = allChoices.filter(choice => (
    form ? choice.form === form : choice.closest('form, fieldset, [role="group"], [role="radiogroup"]') === scope
  ));
  return choices.length > 0 ? choices : [element];
}

export function getChoiceGroupContainer(element: HTMLInputElement): HTMLElement | null {
  const group = getChoiceGroup(element);
  let current: HTMLElement | null = element.parentElement;
  let fallback: HTMLElement | null = null;
  for (let depth = 0; current && depth < 7; depth++, current = current.parentElement) {
    if (!group.every(choice => current?.contains(choice))) continue;
    fallback ||= current;
    if (
      current.matches('fieldset, [role="group"], [role="radiogroup"], [data-form-field-id], [data-form-field-name], [class*=formItem], [class*=form-item], [class*=field]')
      || current.querySelector('legend, [class*=label], [class*=title]')
    ) return current;
    if (current.querySelectorAll('input, textarea, select').length > Math.max(8, group.length + 4)) break;
  }
  return fallback;
}

export function getChoiceQuestion(element: HTMLInputElement): string {
  const root = element.getRootNode() as Document | ShadowRoot;
  const labelledBy = element.getAttribute('aria-labelledby');
  if (labelledBy) {
    const text = normalizeText(labelledBy.split(/\s+/).map(id => root.getElementById?.(id)?.textContent || '').join(' '));
    if (text) return text;
  }

  const container = getChoiceGroupContainer(element);
  const candidates = [
    container?.getAttribute('data-form-field-i18n-name'),
    container?.getAttribute('aria-label'),
    container?.querySelector('legend')?.textContent,
    container?.querySelector(':scope > [class*="label" i], :scope > label, :scope > [class*="title" i]')?.textContent,
    container?.previousElementSibling?.textContent,
  ];
  const optionTexts = new Set(getChoiceGroup(element).map(getChoiceLabel).map(normalizeComparable));
  for (const candidate of candidates) {
    const text = normalizeText(candidate);
    if (!text || optionTexts.has(normalizeComparable(text))) continue;
    if (text.length <= 180) return text;
  }

  return normalizeText(element.name || element.getAttribute('aria-label') || getChoiceLabel(element));
}

export function getControlOptions(element: FormControl): string[] {
  return getOptions(element).filter(option => !option.disabled).map(option => option.label).filter(Boolean);
}

export function getLogicalControlValue(element: FormControl): string {
  return getControlValue(element);
}

export function isLogicalChoiceRepresentative(element: FormControl): boolean {
  const observed = observeControl(element);
  if (!['radio', 'checkbox'].includes(observed.kind)) return true;
  return (observed.group.find(choice => !observeControl(choice).disabled) || observed.group[0]) === element;
}

export function normalizeComparable(value: string): string {
  return normalizeText(value).toLowerCase().replace(/[\s：:、，,。.;；()（）[\]【】]/g, '');
}

export function doesChoiceMatch(choiceValue: string, choiceLabel: string, desiredValue: string): boolean {
  // A visible label is authoritative; opaque raw codes have no global meaning.
  const label = choiceLabel.trim();
  const candidate = label || (/^[01]$/.test(choiceValue) ? '' : choiceValue);
  return scoreDropdownOption(desiredValue, candidate) >= 900;
}

function normalizeText(value: unknown): string {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}
