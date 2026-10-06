import { fillControl, verifyControl, isAutomatedControlAction, type FillContext } from './fillEngine.ts';
import { getControlValue, getOptions, isOptionSelected, observeControl } from './controlObservation.ts';
import type { FillOutcome } from '../shared/fillModel.ts';

export class FormFiller {
  private previousValues = new Map<
    HTMLElement,
    { value: string; choices?: Array<{ element: HTMLElement; checked: boolean }>; selection?: Array<{ value: string; label: string }> }
  >();

  private userModified = new WeakSet<HTMLElement>();

  private watched = new WeakSet<Node>();

  private intents = new Map<HTMLElement, { value: string; context: FillContext }>();

  beginFillSession(): void {
    this.previousValues.clear();
    this.intents.clear();
  }

  async executeDecision(element: HTMLElement, value: string, context: FillContext): Promise<FillOutcome> {
    return this.fillField(element, value, context);
  }

  async undoLastFill(): Promise<number> {
    let restored = 0;
    for (const [element, snapshot] of [...this.previousValues.entries()].reverse()) {
      if (!element.isConnected || this.userModified.has(element)) continue;
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
    return restored;
  }

  async fillFocusedControl(element: HTMLElement, value: string): Promise<boolean> {
    const outcome = await this.fillField(element, value, { overwrite: true });
    return outcome.status === 'verified' || outcome.status === 'unchanged';
  }

  private wait(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  private async fillField(element: HTMLElement, value: string, context: FillContext = {}): Promise<FillOutcome> {
    const root = element.getRootNode();
    if (!this.watched.has(root)) {
      this.watched.add(root);
      const trackEdit = (event: Event) => {
        if (!event.isTrusted || isAutomatedControlAction(element.ownerDocument) || !(event.target instanceof Node)) return;
        for (const control of this.intents.keys()) {
          if (control === event.target || control.contains(event.target) || observeControl(control).group.some(member => member === event.target)) this.userModified.add(control);
        }
      };
      root.addEventListener('input', trackEdit, true);
      root.addEventListener('change', trackEdit, true);
    }
    this.userModified.delete(element);
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
    if (outcome.status === 'verified') this.intents.set(element, { value, context });
    return outcome;
  }

  private triggerEvents(element: HTMLElement): void {
    element.dispatchEvent(new Event('input', { bubbles: true }));
    element.dispatchEvent(new Event('change', { bubbles: true }));
    element.dispatchEvent(new FocusEvent('blur'));
    element.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
  }

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
