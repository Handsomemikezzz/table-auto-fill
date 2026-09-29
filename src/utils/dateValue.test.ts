import assert from 'node:assert/strict';
import test from 'node:test';
import { adaptDateValue, areDatesEqualAtPrecision, areEquivalentDates, findDateOptionIndex, parseFlexibleDate } from './dateValue.ts';

test('2020.06、2020.6 与 2020-06 表示同一个月份', () => {
  assert.equal(areEquivalentDates('2020.06', '2020.6'), true);
  assert.equal(areEquivalentDates('2020.06', '2020-06'), true);
});

test('根据网站控件类型和格式提示转换日期', () => {
  assert.equal(adaptDateValue('2020.6', { inputType: 'month' }), '2020-06');
  assert.equal(adaptDateValue('2020.6', { inputType: 'date' }), '2020.6');
  assert.equal(adaptDateValue('2020-6', { placeholder: 'YYYY.MM' }), '2020.06');
  assert.equal(adaptDateValue('2020-06', { placeholder: 'YYYY/M' }), '2020/6');
});

test('日期保留精度，不默认为 1 月或 1 日', () => {
  assert.equal(parseFlexibleDate('2020')?.precision, 'year');
  assert.equal(parseFlexibleDate('2020-06')?.precision, 'month');
  assert.equal(parseFlexibleDate('2020-06-15')?.precision, 'day');
  assert.equal(adaptDateValue('2020', { inputType: 'month' }), '2020');
  assert.equal(adaptDateValue('2020', { inputType: 'date' }), '2020');
  assert.equal(adaptDateValue('2020-06', { placeholder: 'YYYY-MM-DD' }), '2020-06');
  assert.equal(areEquivalentDates('2020', '2020-06'), false);
  assert.equal(areEquivalentDates('2020-06', '2020-06-15'), false);
  assert.equal(areDatesEqualAtPrecision('2020-06-15', '2020-06', 'month'), true);
  assert.equal(areDatesEqualAtPrecision('2020-06', '2020-06-15', 'day'), false);
});

test('校验闰年和真实日历范围', () => {
  for (const invalid of ['2023-02-29', '1900-02-29', '2020-02-30', '2020-04-31', '2020-13', '2020-00', '2020-01-00', '0000', '2020--06']) {
    assert.equal(parseFlexibleDate(invalid), null, invalid);
  }
  assert.equal(parseFlexibleDate('2000-02-29')?.day, 29);
  assert.equal(parseFlexibleDate('2024年2月29日')?.day, 29);
  assert.equal(parseFlexibleDate('2020 年 6 月')?.month, 6);
});

test('完整日期格式提示保留日，中文提示保留年月日分隔', () => {
  assert.equal(adaptDateValue('2020.6.15', { inputType: 'date' }), '2020-06-15');
  assert.equal(adaptDateValue('2020.6.15', { placeholder: 'YYYY/MM/DD' }), '2020/06/15');
  assert.equal(adaptDateValue('2020.6.15', { placeholder: 'YYYY.M.D' }), '2020.6.15');
  assert.equal(adaptDateValue('2020.6.15', { placeholder: 'YYYY年MM月DD日' }), '2020年06月15日');
  assert.equal(adaptDateValue('2020.6', { placeholder: 'YYYY年MM月' }), '2020年06月');
  assert.equal(adaptDateValue('2020.6.15', { pattern: '\\d{4}-\\d{2}-\\d{2}' }), '2020-06-15');
});

test('日期选项重复或混合精度时不以第一个候选掩盖歧义', () => {
  assert.equal(findDateOptionIndex('2020-06', ['2020', '2020年']), -1);
  assert.equal(findDateOptionIndex('2020-06', ['6月', '06']), -1);
  assert.equal(findDateOptionIndex('2020-06', ['2020', '2020-06']), 1);
  assert.equal(findDateOptionIndex('2020-06-15', ['14', '15', '16'], 'day'), 1);
  assert.equal(findDateOptionIndex('2020-06', ['14', '15', '16'], 'day'), -1);
});

test('年份和月份拆分下拉框可以从完整年月选中对应项', () => {
  assert.equal(findDateOptionIndex('2020.06', ['请选择', '2019', '2020', '2021']), 2);
  assert.equal(findDateOptionIndex('2020.06', ['请选择', '5月', '6月', '7月']), 2);
  assert.equal(findDateOptionIndex('2020.06', ['请选择', '05', '06', '07']), 2);
  assert.equal(findDateOptionIndex('2020.06', ['Month', 'May', 'Jun', 'Jul']), 2);
  assert.equal(findDateOptionIndex('2020.06', ['请选择', '2019 年', '2020 年']), 2);
});
