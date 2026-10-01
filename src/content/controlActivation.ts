const activeActions = new WeakSet<Document>();
export function isAutomatedControlAction(document: Document): boolean { return activeActions.has(document); }
/** Native clicks may emit trusted change events synchronously. */
export function activateControl(element: HTMLElement, pointerStrategy = false): void {
  activeActions.add(element.ownerDocument);
  try {
    element.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
    if (pointerStrategy) {
      const view = element.ownerDocument.defaultView!;
      for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup']) {
        const EventType = type.startsWith('pointer') ? view.PointerEvent : view.MouseEvent;
        element.dispatchEvent(new EventType(type, { bubbles: true, cancelable: true, composed: true }));
      }
    }
    element.click();
  } finally { activeActions.delete(element.ownerDocument); }
}
