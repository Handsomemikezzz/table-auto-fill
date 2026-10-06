import assert from 'node:assert/strict';
import test from 'node:test';
import { matchOptionLabel, resolveOption } from './optionResolver.ts';

test('根据可见标签选择，网站编码可以反转或使用不同类型', () => {
  for (const rawValue of ['0', '1', 'M', 0, false]) {
    const result = resolveOption({
      desired: 'male', semantic: 'gender',
      options: [{ id: 'male', label: '男', rawValue }, { id: 'female', label: '女', rawValue: 'else' }],
    });
    assert.equal(result.status, 'matched');
    if (result.status === 'matched') {
      assert.equal(result.option.id, 'male');
      assert.equal(result.option.rawValue, rawValue);
    }
  }
});

test('选项代码缺少语义时不把 0/1 或布尔编码猜成性别或是否', () => {
  for (const desired of ['男', '女', 'yes', 'no', 'true', 'false']) {
    assert.equal(resolveOption({ desired, options: [{ id: 'zero', label: '0' }, { id: 'one', label: '1' }] }).status, 'not-found');
    assert.equal(resolveOption({ desired, options: [{ id: 'blank', label: '', rawValue: true }] }).status, 'not-found');
  }
  assert.equal(resolveOption({ desired: '1', semantic: 'gender', options: [{ id: 'one', label: '1' }] }).status, 'not-found');
});

test('相同标签或同义标签对应多个身份时必须消歧', () => {
  assert.equal(resolveOption({ desired: '男', options: [{ id: 'a', label: '男' }, { id: 'b', label: '男' }] }).status, 'ambiguous');
  assert.equal(resolveOption({ desired: '本科', options: [{ id: 'a', label: '本科' }, { id: 'b', label: '大学本科' }] }).status, 'ambiguous');
});

test('层级路径有明确父节点时可以消歧', () => {
  const result = resolveOption({
    desired: '朝阳区', parentId: 'beijing',
    options: [{ id: 'a', label: '朝阳区', parentId: 'beijing' }, { id: 'b', label: '朝阳区', parentId: 'changchun' }],
  });
  assert.equal(result.status, 'matched');
  if (result.status === 'matched') assert.equal(result.option.id, 'a');
});

test('禁用选项不参与选择，已读完与尚未读完必须区分', () => {
  assert.equal(resolveOption({ desired: '男', options: [{ id: 'a', label: '男', disabled: true }] }).status, 'not-found');
  assert.equal(resolveOption({ desired: '男', options: [], completeness: 'unread' }).status, 'needs-options');
  assert.equal(resolveOption({ desired: '男', options: [{ id: 'b', label: '女' }], completeness: 'partial' }).status, 'needs-options');
  assert.equal(resolveOption({ desired: '男', options: [], completeness: 'complete' }).status, 'not-found');
});

test('别名由字段含义限定，学历和学位不混为一个事实', () => {
  assert.equal(matchOptionLabel('本科', '大学本科', 'degree'), 'alias');
  assert.equal(matchOptionLabel('本科', '学士', 'degree'), null);
  assert.equal(matchOptionLabel('本科', 'bachelor', 'academicDegree'), null);
  assert.equal(matchOptionLabel('学士', 'bachelor', 'academicDegree'), 'alias');
  assert.equal(matchOptionLabel('male', '男', 'text'), null);
  assert.equal(matchOptionLabel('高中', '中专'), null);
  assert.equal(matchOptionLabel('应届生', '在校生'), null);
  assert.equal(matchOptionLabel('研究生', '硕士'), null);
});

test('不把子串、额外约束、不同单位或日期精度误当成等价', () => {
  for (const [desired, label] of [
    ['计算机科学', '计算机科学与技术'], ['全日制', '非全日制'],
    ['本科', '本科（含专升本）'], ['1.0', '10'], ['2020', '2020-06'],
  ]) assert.equal(matchOptionLabel(desired, label), null);
});


test('布尔选择按可见标签处理反转编码，短答案不能推断额外资格', () => {
  const result = resolveOption({ desired: '是', semantic: 'boolean', options: [
    { id: 'yes', label: '是', rawValue: '0' }, { id: 'no', label: '否', rawValue: '1' },
  ] });
  assert.equal(result.status, 'matched');
  if (result.status === 'matched') assert.equal(result.option.id, 'yes');
  for (const label of ['统招全日制', '非全日制']) {
    assert.equal(resolveOption({ desired: '全日制', semantic: 'educationType', options: [{ id: 'qualification', label }] }).status, 'not-found');
  }
});
