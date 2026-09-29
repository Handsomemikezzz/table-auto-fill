import assert from 'node:assert/strict';
import test from 'node:test';
import { datePickerPrecision, planDatePanelAction, type DatePanelSnapshot } from './datePickerAdapter.ts';
import { parseFlexibleDate } from '../utils/dateValue.ts';

const desired = parseFlexibleDate('2020-06-15')!;

test('日历只选择完整日期相符且可用的单元格', () => {
  const snapshot: DatePanelSnapshot = {
    mode: 'day', year: 2020, month: 6,
    cells: [
      { id: 'other-month', year: 2020, month: 5, day: 15 },
      { id: 'target', year: 2020, month: 6, day: 15 },
      { id: 'same-day-other-year', year: 2021, month: 6, day: 15 },
    ],
  };
  assert.deepEqual(planDatePanelAction(snapshot, desired), { type: 'click', targetId: 'target' });
  snapshot.cells[1].disabled = true;
  assert.equal(planDatePanelAction(snapshot, desired).type, 'unsupported');
});

test('重复日期候选或无法确定年月时不猜一个数字格子', () => {
  assert.equal(planDatePanelAction({ mode: 'day', cells: [{ id: 'day-15', day: 15 }] }, desired).type, 'unsupported');
  assert.equal(planDatePanelAction({ mode: 'day', cells: [
    { id: 'a', year: 2020, month: 6, day: 15 }, { id: 'b', year: 2020, month: 6, day: 15 },
  ] }, desired).type, 'unsupported');
});

test('不同年份优先打开年份面板，同年不同月打开月份面板', () => {
  assert.deepEqual(planDatePanelAction({ mode: 'day', year: 2026, month: 9, cells: [], openYear: 'year', previous: 'prev' }, desired), { type: 'click', targetId: 'year' });
  assert.deepEqual(planDatePanelAction({ mode: 'day', year: 2020, month: 9, cells: [], openMonth: 'month', previous: 'prev' }, desired), { type: 'click', targetId: 'month' });
});

test('没有年份入口时只按可证明的年月方向导航', () => {
  assert.deepEqual(planDatePanelAction({ mode: 'day', year: 2021, month: 1, cells: [], previous: 'prev', next: 'next' }, desired), { type: 'click', targetId: 'prev' });
  assert.deepEqual(planDatePanelAction({ mode: 'day', year: 2019, month: 12, cells: [], previous: 'prev', next: 'next' }, desired), { type: 'click', targetId: 'next' });
  assert.equal(planDatePanelAction({ mode: 'day', year: 2020, cells: [], previous: 'prev' }, desired).type, 'unsupported');
});

test('年份网格按实际范围导航，禁用年份不会被绕过', () => {
  const years: DatePanelSnapshot = {
    mode: 'year', previous: 'prev-decade', next: 'next-decade',
    cells: Array.from({ length: 10 }, (_, index) => ({ id: `y-${2020 + index}`, year: 2020 + index })),
  };
  assert.deepEqual(planDatePanelAction(years, desired), { type: 'click', targetId: 'y-2020' });
  assert.deepEqual(planDatePanelAction(years, parseFlexibleDate('2010')!), { type: 'click', targetId: 'prev-decade' });
  assert.deepEqual(planDatePanelAction(years, parseFlexibleDate('2040')!), { type: 'click', targetId: 'next-decade' });
  years.cells[0].disabled = true;
  assert.equal(planDatePanelAction(years, desired).type, 'unsupported');
});

test('年月控件仅选择同年的月份，源日期不必虚构具体日', () => {
  const months: DatePanelSnapshot = { mode: 'month', year: 2020, cells: [{ id: 'june', year: 2020, month: 6 }] };
  assert.deepEqual(planDatePanelAction(months, parseFlexibleDate('2020-06')!), { type: 'click', targetId: 'june' });
  assert.equal(planDatePanelAction({ mode: 'day', year: 2020, month: 6, cells: [] }, parseFlexibleDate('2020-06')!).type, 'unsupported');
});

function input(hints: Record<string, string>, picker?: string): HTMLElement {
  return {
    tagName: 'INPUT',
    getAttribute: (key: string) => hints[key] ?? null,
    closest: () => picker ? { getAttribute: (key: string) => key === 'data-picker' ? picker : null } : null,
  } as unknown as HTMLElement;
}

test('控件精度由显式类型和格式确定，未知日期组件要求完整日期', () => {
  assert.equal(datePickerPrecision(input({}, 'month')), 'month');
  assert.equal(datePickerPrecision(input({}, 'year')), 'year');
  assert.equal(datePickerPrecision(input({ placeholder: 'YYYY-MM-DD' })), 'day');
  assert.equal(datePickerPrecision(input({ placeholder: 'YYYY/MM' })), 'month');
  assert.equal(datePickerPrecision(input({ placeholder: 'YYYY-MM', 'aria-label': '毕业日期' })), 'month');
  assert.equal(datePickerPrecision(input({ placeholder: '选择年份' })), 'year');
  assert.equal(datePickerPrecision(input({})), 'day');
});
