import assert from 'node:assert/strict';
import test from 'node:test';
import { scoreRun, compareReports } from './scoring.js';

const expected = [
  { id: 'a', kind: 'text', policy: 'fill', initial: '', value: '正确姓名' },
  { id: 'b', kind: 'month', policy: 'leave-empty', initial: '', value: '' },
  { id: 'c', kind: 'text', policy: 'preserve', initial: '原值', value: '原值' },
];
test('分母含未发现字段；DOM 写入但业务状态未提交不算成功', () => {
  const result = scoreRun(expected, { business: { a: '', b: '', c: '原值' }, dom: { a: '正确姓名', b: '', c: '原值' }, submitted: 0 }, [{ controlId: 'b' }, { controlId: 'c' }, { controlId: 'foreign' }]);
  assert.equal(result.metrics.eligibleFields, 1);
  assert.equal(result.metrics.correctFilled, 0);
  assert.equal(result.metrics.discoveredFields, 2);
  assert.equal(result.metrics.extraDetections, 1);
  assert.equal(result.metrics.incorrectWrites, 1);
});
test('编造日期和覆盖原值均为错误写入', () => {
  const result = scoreRun(expected, { business: { a: '正确姓名', b: '2017-01', c: '新值' }, dom: { a: '正确姓名', b: '2017-01', c: '新值' }, submitted: 0 }, []);
  assert.equal(result.metrics.correctFilled, 1);
  assert.equal(result.metrics.incorrectWrites, 2);
  assert.equal(result.metrics.correctlyLeftEmpty, 0);
  assert.equal(result.metrics.correctlyPreserved, 0);
});
test('逐字段比较发现相同总分下的倒退', () => {
  const make = fields => ({ metadata: { corpusHash: 'fixed', environment: { browserVersion: 'fixed' } }, runs: [{ id: 'run', fields, metrics: { extraDetections: 0 } }] });
  const baseline = make([{ id: 'a', correct: true, discovered: true, status: 'correct' }, { id: 'b', correct: false, discovered: true, status: 'unfilled' }]);
  const current = make([{ id: 'a', correct: false, discovered: true, status: 'unfilled' }, { id: 'b', correct: true, discovered: true, status: 'correct' }]);
  assert.equal(compareReports(current, baseline).length, 1);
  current.metadata.corpusHash = 'other';
  assert.throws(() => compareReports(current, baseline), /Corpus changed/);
});
test('缺失 DOM 不能被当作正确留空，明确标注的学历等价表达可接受', () => {
  const fields = [{ id: 'empty', kind: 'text', policy: 'leave-empty', initial: '', value: '' }, { id: 'degree', kind: 'text', policy: 'fill', initial: '', value: '硕士', acceptedValues: ['硕士研究生'] }];
  const result = scoreRun(fields, { business: { empty: '', degree: '硕士研究生' }, dom: { empty: null, degree: '硕士研究生' }, submitted: 0 }, []);
  assert.equal(result.metrics.correctFilled, 1);
  assert.equal(result.metrics.correctlyLeftEmpty, 0);
});
