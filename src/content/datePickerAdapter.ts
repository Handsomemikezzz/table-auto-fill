import type { DatePrecision, FillOutcome, FillStatus } from '../shared/fillModel.ts';
import { areDatesEqualAtPrecision, parseFlexibleDate, type ParsedFlexibleDate } from '../utils/dateValue.ts';
import type { FillContext } from './fillEngine.ts';
import { getAssociatedPopups, getControlIdentity, getEditableElement, isDisabledControl, isVisibleControl } from './controlObservation.ts';

const PICKER = '.ant-picker, .el-date-editor, .arco-picker, .semi-datepicker, [data-picker="year"], [data-picker="month"], [data-picker="date"], [picker="year"], [picker="month"], [picker="date"]';
const PANEL = '.ant-picker-panel, .el-picker-panel, .arco-picker-panel, .semi-datepicker-panel, [data-datepicker-panel], [role="dialog"]:has([role="grid"])';
const CELL = '.ant-picker-cell, .el-year-table td, .el-month-table td, .el-date-table td, .arco-picker-cell, .semi-datepicker-day, [role="gridcell"]';
const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
const CHINESE_MONTHS = ['一', '二', '三', '四', '五', '六', '七', '八', '九', '十', '十一', '十二'];
const pause = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

export interface DatePanelCell {
  id: string;
  year?: number;
  month?: number;
  day?: number;
  disabled?: boolean;
}
export interface DatePanelSnapshot {
  mode: DatePrecision;
  year?: number;
  month?: number;
  cells: DatePanelCell[];
  previous?: string;
  next?: string;
  openYear?: string;
  openMonth?: string;
}
export type DatePanelAction = { type: 'click'; targetId: string } | { type: 'unsupported'; reason: string };

/** Pure planner: every action must name a currently observed cell or button. */
export function planDatePanelAction(snapshot: DatePanelSnapshot, target: ParsedFlexibleDate): DatePanelAction {
  const matching = snapshot.cells.filter(cell => !cell.disabled && cell.year === target.year
    && (snapshot.mode === 'year' || (cell.month === target.month
      && (snapshot.mode === 'month' || cell.day === target.day))));
  if (matching.length === 1) return { type: 'click', targetId: matching[0].id };
  if (matching.length > 1) return { type: 'unsupported', reason: '日期面板出现多个相同候选，需要确认目标面板' };
  if (snapshot.mode === 'year') {
    const years = snapshot.cells.map(cell => cell.year).filter((year): year is number => year !== undefined);
    if (!years.length) return { type: 'unsupported', reason: '未读取到年份面板范围' };
    const direction = target.year < Math.min(...years) ? snapshot.previous : target.year > Math.max(...years) ? snapshot.next : undefined;
    return direction ? { type: 'click', targetId: direction } : { type: 'unsupported', reason: '目标年份不可选择' };
  }
  if (snapshot.year === undefined) return { type: 'unsupported', reason: '无法确定日期面板当前年份' };
  if (snapshot.year !== target.year && snapshot.openYear) return { type: 'click', targetId: snapshot.openYear };
  if (snapshot.mode === 'month') {
    const direction = target.year < snapshot.year ? snapshot.previous : target.year > snapshot.year ? snapshot.next : undefined;
    return direction ? { type: 'click', targetId: direction } : { type: 'unsupported', reason: '目标月份不可选择' };
  }
  if (target.month === undefined || target.day === undefined) return { type: 'unsupported', reason: '日历控件需要完整年月日' };
  if (snapshot.month === undefined) return { type: 'unsupported', reason: '无法确定日期面板当前月份' };
  if (snapshot.year === target.year && snapshot.month !== target.month && snapshot.openMonth) return { type: 'click', targetId: snapshot.openMonth };
  const current = snapshot.year * 12 + snapshot.month;
  const desired = target.year * 12 + target.month;
  const direction = desired < current ? snapshot.previous : desired > current ? snapshot.next : undefined;
  return direction ? { type: 'click', targetId: direction } : { type: 'unsupported', reason: '目标日期不存在或被禁用' };
}

export function supportsDatePicker(element: HTMLElement): boolean {
  return Boolean(element.closest(PICKER));
}

export function datePickerPrecision(element: HTMLElement): DatePrecision {
  const editor = getEditableElement(element);
  const owner = element.closest('[picker], [data-picker]');
  const type = owner?.getAttribute('picker') || owner?.getAttribute('data-picker') || editor?.getAttribute('type');
  if (type === 'year') return 'year';
  if (type === 'month') return 'month';
  if (type === 'date') return 'day';
  const placeholder = (editor?.getAttribute('placeholder') || '').toLowerCase();
  if (/yyyy/.test(placeholder)) return /d/.test(placeholder) ? 'day' : /m/.test(placeholder) ? 'month' : 'year';
  const hint = `${placeholder} ${element.getAttribute('aria-label') || ''}`.toLowerCase();
  if (/dd|日期|日|date|day/.test(hint)) return 'day';
  if (/mm|月份|年月|month/.test(hint)) return 'month';
  if (/yyyy|年份|year/.test(hint)) return 'year';
  // Common picker defaults to a full date; a month-only source is not expanded.
  return 'day';
}

function valueOf(element: HTMLElement): string {
  return getEditableElement(element)?.value.trim() || element.getAttribute('aria-valuetext')?.trim() || '';
}
function valid(element: HTMLElement): boolean {
  const editor = getEditableElement(element);
  return !isDisabledControl(element) && element.getAttribute('aria-invalid') !== 'true'
    && editor?.getAttribute('aria-invalid') !== 'true' && (!editor || editor.validity.valid);
}
function result(element: HTMLElement, value: string, status: FillStatus, reason: string, attempts = 0): FillOutcome {
  return { status, reason, attempts, expectedValue: value, observedValue: valueOf(element), adapterId: 'date-picker', fieldId: getControlIdentity(element) };
}
function requiredDate(element: HTMLElement, value: string): ParsedFlexibleDate | FillOutcome {
  const parsed = parseFlexibleDate(value);
  if (!parsed) return result(element, value, 'needs-data', '资料中没有合法的年月日，日期控件不能自动填写');
  const precision = datePickerPrecision(element);
  if ((precision === 'day' && parsed.day === undefined) || (precision === 'month' && parsed.month === undefined)) {
    return result(element, value, 'needs-data', precision === 'day' ? '网站要求具体年月日，资料日期精度不足' : '网站要求年月，资料只有年份');
  }
  return parsed;
}

interface PanelObservation { snapshot: DatePanelSnapshot; targets: Map<string, HTMLElement>; fingerprint: string }
function observedPanel(panel: HTMLElement): PanelObservation {
  const targets = new Map<string, HTMLElement>();
  const idFor = (node: HTMLElement | null): string | undefined => {
    if (!node || !isVisibleControl(node) || isDisabledControl(node)) return undefined;
    const id = getControlIdentity(node); targets.set(id, node); return id;
  };
  const mode: DatePrecision = panel.querySelector('.ant-picker-year-panel, .el-year-table, [data-picker-mode="year"]')
    || panel.matches('[data-picker-mode="year"]') ? 'year'
    : panel.querySelector('.ant-picker-month-panel, .el-month-table, [data-picker-mode="month"]')
      || panel.matches('[data-picker-mode="month"]') ? 'month' : 'day';
  const headerLabels = Array.from(panel.querySelectorAll<HTMLElement>('.el-date-picker__header-label'));
  const yearButton = panel.querySelector<HTMLElement>('.ant-picker-year-btn, [data-picker-open="year"], [aria-label="Choose year"], [aria-label="选择年份"]')
    || headerLabels.find(label => /\d{4}/.test(label.textContent || '')) || null;
  const monthButton = panel.querySelector<HTMLElement>('.ant-picker-month-btn, [data-picker-open="month"], [aria-label="Choose month"], [aria-label="选择月份"]')
    || headerLabels.find(label => parseMonth(label.textContent || '') !== undefined) || null;
  const header = panel.querySelector<HTMLElement>('.ant-picker-header-view, .el-date-picker__header, .arco-picker-header, .semi-datepicker-navigation, [data-picker-header], [aria-live]');
  const headerText = `${yearButton?.textContent || ''} ${monthButton?.textContent || ''} ${header?.textContent || ''}`;
  let year = Number(headerText.match(/\b(\d{4})\b/)?.[1]) || undefined;
  let month = parseMonth(monthButton?.textContent || '')
    || Number(headerText.match(/(?:年\s*|\b\d{4}[-/.])([01]?\d)(?:月|\b)/)?.[1]) || undefined;
  const cells = Array.from(panel.querySelectorAll<HTMLElement>(CELL)).filter(isVisibleControl).map(cell => {
    const id = idFor(cell) || getControlIdentity(cell);
    const hint = cell.getAttribute('data-date') || cell.getAttribute('title') || cell.getAttribute('aria-label') || '';
    const parsed = parseFlexibleDate(hint);
    const text = (cell.textContent || '').trim();
    let cellYear = parsed?.year;
    let cellMonth = parsed?.month;
    let cellDay = parsed?.day;
    if (mode === 'year') cellYear ??= Number(text.match(/^(\d{4})年?$/)?.[1]) || undefined;
    if (mode === 'month') { cellYear ??= year; cellMonth ??= parseMonth(text); }
    if (mode === 'day' && year !== undefined && month !== undefined && /^\d{1,2}$/.test(text)
      && !cell.matches('[class*="prev-month"], [class*="next-month"], [class*="outside"], [class*="other-month"]')
      && (!cell.matches('.ant-picker-cell') || cell.matches('.ant-picker-cell-in-view'))) {
      cellYear ??= year; cellMonth ??= month; cellDay ??= Number(text);
    }
    return { id, year: cellYear, month: cellMonth, day: cellDay, disabled: isDisabledControl(cell)
      || cell.matches('[class*="disabled"], [aria-disabled="true"]') };
  });
  // Full cell dates can establish the displayed year/month without guessing from a day number.
  if (year === undefined) {
    const years = [...new Set(cells.map(cell => cell.year).filter((value): value is number => value !== undefined))];
    if (years.length === 1) year = years[0];
  }
  if (month === undefined && mode === 'day') {
    const months = [...new Set(cells.map(cell => cell.month).filter((value): value is number => value !== undefined))];
    if (months.length === 1) month = months[0];
  }
  const prevSelector = mode === 'day'
    ? '.ant-picker-header-prev-btn, .el-icon-arrow-left, [data-picker-nav="previous"], [aria-label="Previous month"]'
    : '.ant-picker-header-super-prev-btn, [data-picker-nav="previous"], [aria-label="Previous year"], [aria-label="Previous decade"]';
  const nextSelector = mode === 'day'
    ? '.ant-picker-header-next-btn, .el-icon-arrow-right, [data-picker-nav="next"], [aria-label="Next month"]'
    : '.ant-picker-header-super-next-btn, [data-picker-nav="next"], [aria-label="Next year"], [aria-label="Next decade"]';
  const snapshot: DatePanelSnapshot = {
    mode, year, month, cells,
    previous: idFor(panel.querySelector(prevSelector)), next: idFor(panel.querySelector(nextSelector)),
    openYear: idFor(yearButton), openMonth: idFor(monthButton),
  };
  return { snapshot, targets, fingerprint: JSON.stringify(snapshot) };
}

function parseMonth(text: string): number | undefined {
  const normalized = text.trim().toLowerCase();
  const numeric = normalized.match(/^(0?[1-9]|1[0-2])月?$/);
  if (numeric) return Number(numeric[1]);
  const chinese = CHINESE_MONTHS.findIndex(name => normalized === `${name}月`);
  if (chinese >= 0) return chinese + 1;
  const english = MONTHS.findIndex(name => normalized === name || normalized === name.slice(0, 3));
  return english >= 0 ? english + 1 : undefined;
}

function visiblePanels(element: HTMLElement): HTMLElement[] {
  const root = element.getRootNode() as Document | ShadowRoot;
  return Array.from(root.querySelectorAll<HTMLElement>(PANEL)).filter(isVisibleControl)
    .filter(panel => !panel.parentElement?.closest(PANEL));
}

export async function verifyDatePicker(element: HTMLElement, value: string, context: FillContext = {}): Promise<FillOutcome> {
  const parsed = requiredDate(element, value);
  if ('status' in parsed) return parsed;
  const deadline = Date.now() + (context.timeoutMs ?? 1800);
  const settleMs = Math.max(0, context.settleMs ?? 450);
  let stableSince: number | undefined;
  while (Date.now() <= deadline) {
    if (context.shouldContinue?.() === false) return result(element, value, 'cancelled', '日期填写已取消');
    if (!element.isConnected) return result(element, value, 'stale', '日期控件已被页面替换');
    if (valid(element) && areDatesEqualAtPrecision(valueOf(element), value, datePickerPrecision(element))) {
      stableSince ??= Date.now();
      if (Date.now() - stableSince >= settleMs) return result(element, value, 'verified', '日期控件已稳定接受目标日期');
    } else stableSince = undefined;
    await pause(30);
  }
  return result(element, value, valid(element) ? 'unverified' : 'rejected', '未能验证页面已接受目标日期');
}

export async function fillDatePicker(element: HTMLElement, value: string, context: FillContext = {}): Promise<FillOutcome> {
  const parsed = requiredDate(element, value);
  if ('status' in parsed) return parsed;
  if (!supportsDatePicker(element) || isDisabledControl(element)) return result(element, value, 'unsupported', '日期控件不可操作');
  if (areDatesEqualAtPrecision(valueOf(element), value, datePickerPrecision(element)) && valid(element)) {
    const existing = await verifyDatePicker(element, value, context);
    return existing.status === 'verified' ? { ...existing, status: 'unchanged', reason: '日期已与资料一致且稳定' } : existing;
  }
  if (valueOf(element) && !context.overwrite) return result(element, value, 'skipped-existing', '保留日期控件中的已有答案');
  const deadline = Date.now() + (context.timeoutMs ?? 10000);
  let attempts = 0;
  let userEdited = false;
  let panel: HTMLElement | undefined;
  const root = element.getRootNode();
  const owner = element.closest(PICKER) || element;
  const onUserEvent = (event: Event) => {
    const target = event.target as Node | null;
    if (event.isTrusted && target && (owner.contains(target) || panel?.contains(target))) userEdited = true;
  };
  // A real user action during this bounded operation takes priority over automation.
  // Native .click() can itself emit trusted input/change events, so they are not user intent.
  const userEvents = ['pointerdown', 'keydown', 'beforeinput'];
  for (const type of userEvents) root.addEventListener(type, onUserEvent, true);
  try {
    const before = new Set(visiblePanels(element));
    element.focus();
    if (context.shouldContinue?.() === false) return result(element, value, 'cancelled', '日期填写已取消');
    element.click(); attempts++;
    while (Date.now() < deadline && attempts <= 24) {
      if (userEdited) return result(element, value, 'user-edited', '用户开始编辑，已停止日期操作', attempts);
      if (context.shouldContinue?.() === false) return result(element, value, 'cancelled', '日期填写已取消', attempts);
      if (!element.isConnected) return result(element, value, 'stale', '日期控件已被页面替换', attempts);
      if (valid(element) && areDatesEqualAtPrecision(valueOf(element), value, datePickerPrecision(element))) {
        const verified = await verifyDatePicker(element, value, { ...context, timeoutMs: Math.max(0, deadline - Date.now()), shouldContinue: () => !userEdited && context.shouldContinue?.() !== false });
        return userEdited ? result(element, value, 'user-edited', '用户开始编辑，已停止日期操作', attempts) : { ...verified, attempts };
      }
      if (!panel?.isConnected || !isVisibleControl(panel)) {
        const owned = getAssociatedPopups(element).filter(isVisibleControl)
          .flatMap(popup => popup.matches(PANEL) ? [popup] : Array.from(popup.querySelectorAll<HTMLElement>(PANEL)).filter(isVisibleControl));
        const candidates = owned.length ? owned : visiblePanels(element).filter(candidate => !before.has(candidate));
        if (candidates.length > 1) return result(element, value, 'unsupported', '无法确定当前日期控件对应的面板', attempts);
        panel = candidates[0];
        if (!panel) { await pause(40); continue; }
      }
      const observation = observedPanel(panel);
      const action = planDatePanelAction(observation.snapshot, parsed);
      if (action.type === 'unsupported') return result(element, value, 'unsupported', action.reason, attempts);
      const target = observation.targets.get(action.targetId);
      if (!target?.isConnected || isDisabledControl(target)) return result(element, value, 'stale', '日期候选已发生变化', attempts);
      target.click(); attempts++;
      const selectedFinalCell = observation.snapshot.mode === datePickerPrecision(element)
        && observation.snapshot.cells.some(cell => cell.id === action.targetId);
      if (selectedFinalCell) {
        // Some calendars keep a draft date until their explicit confirmation button is used.
        await pause(60);
        if (userEdited || context.shouldContinue?.() === false) continue;
        const confirm = Array.from(panel.querySelectorAll<HTMLElement>('.ant-picker-ok button, [data-picker-confirm], .el-picker-panel__footer button'))
          .find(button => isVisibleControl(button) && !isDisabledControl(button)
            && /^(?:确定|确认|ok|confirm)$/i.test((button.textContent || '').trim()));
        if (confirm) {
          confirm.click(); attempts++;
        }
      }
      const waitUntil = Math.min(deadline, Date.now() + 700);
      while (Date.now() < waitUntil && !userEdited && context.shouldContinue?.() !== false) {
        if (!panel.isConnected || !isVisibleControl(panel) || areDatesEqualAtPrecision(valueOf(element), value, datePickerPrecision(element))) break;
        if (observedPanel(panel).fingerprint !== observation.fingerprint) break;
        await pause(35);
      }
      if (panel.isConnected && isVisibleControl(panel) && !areDatesEqualAtPrecision(valueOf(element), value, datePickerPrecision(element))
        && observedPanel(panel).fingerprint === observation.fingerprint) return result(element, value, 'unverified', '日期面板未响应选择操作', attempts);
    }
    return result(element, value, 'unsupported', '日期面板未在操作预算内完成选择', attempts);
  } finally {
    for (const type of userEvents) root.removeEventListener(type, onUserEvent, true);
  }
}
