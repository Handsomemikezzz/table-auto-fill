import assert from 'node:assert/strict';
import test from 'node:test';
import { parseCascaderPath, planCascaderStep, type CascaderNode } from './cascaderAdapter.ts';

test('层级路径必须有明确分隔，不能猜测拼接地名', () => {
  assert.deepEqual(parseCascaderPath('四川省 / 成都市 / 武侯区'), ['四川省', '成都市', '武侯区']);
  assert.deepEqual(parseCascaderPath('中国 → 四川省 → 成都市'), ['中国', '四川省', '成都市']);
  assert.equal(parseCascaderPath('四川省成都市武侯区'), null);
  assert.equal(parseCascaderPath('四川省//成都市'), null);
});

const nodes: CascaderNode[] = [
  { id: 'wrong-province', label: '错误省', level: 0, expanded: true },
  { id: 'right-province', label: '四川省', level: 0, expanded: true },
  { id: 'wrong-city', label: '成都市', level: 1, parentId: 'wrong-province', expanded: true },
  { id: 'right-city', label: '成都市', level: 1, parentId: 'right-province', expanded: true },
  { id: 'wrong-district', label: '武侯区', level: 2, parentId: 'wrong-city' },
  { id: 'right-district', label: '武侯区', level: 2, parentId: 'right-city' },
];

test('同名城市和区县只在明确的父级下匹配', () => {
  assert.deepEqual(planCascaderStep(nodes, ['四川省', '成都市', '武侯区'], 1), { type: 'select', targetId: 'right-city' });
  assert.deepEqual(planCascaderStep(nodes, ['四川省', '成都市', '武侯区'], 2), { type: 'select', targetId: 'right-district' });
});

test('未展开或确认的父级不能跳过直接填写其子级', () => {
  const unconfirmed = nodes.map(node => node.id === 'right-province' ? { ...node, expanded: false } : node);
  assert.equal(planCascaderStep(unconfirmed, ['四川省', '成都市'], 1).type, 'blocked');
});

test('当前父级不存在目标时不能从另一个父级借用同名节点', () => {
  assert.equal(planCascaderStep(nodes.filter(node => node.id !== 'right-city'), ['四川省', '成都市'], 1).type, 'blocked');
});

test('同一父级下重复同名节点和禁用选项需要人工处理', () => {
  const duplicate = [...nodes, { id: 'duplicate-city', label: '成都市', parentId: 'right-province', level: 1 }];
  assert.equal(planCascaderStep(duplicate, ['四川省', '成都市'], 1).type, 'blocked');
  const disabled = nodes.map(node => node.id === 'right-city' ? { ...node, disabled: true } : node);
  assert.equal(planCascaderStep(disabled, ['四川省', '成都市'], 1).type, 'blocked');
});
