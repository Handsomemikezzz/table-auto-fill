import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { prepareCase, scoreCase, rulePredictions, type EvalCase } from '../../scripts/site-eval.ts';
import type { UserProfile } from '../../src/shared/types.ts';

const profile = JSON.parse(readFileSync(new URL('./profiles/complete.json', import.meta.url), 'utf8')) as UserProfile;
const sample = JSON.parse(readFileSync(new URL('./cases/moka-deepseek-initial.json', import.meta.url), 'utf8')) as EvalCase;
test('missing detections remain in the frozen denominator and human fields cannot improve automatic coverage', () => {
  const request = prepareCase(sample, profile);
  const baseline = scoreCase(sample, 'complete', request, rulePredictions(request));
  const missing = scoreCase(sample, 'complete', { ...request, fields: [] }, []);
  assert.equal(missing.total, baseline.total);
  assert.equal(missing.eligible, baseline.eligible);
  assert.equal(missing.missed, sample.fields.length);
  assert.equal(missing.correctPrepared, 0);
});
test('invented facts, duplicate decisions, wrong records and writes to preserved answers count as errors', () => {
  const request = prepareCase(sample, profile);
  const decisions = rulePredictions(request);
  const name = decisions.find(decision => decision.meaningId === 'personal.name')!;
  for (const patch of [{ factId: 'invented' }, { recordId: 'wrong' }]) {
    const score = scoreCase(sample, 'complete', request, [{ ...name, ...patch }]);
    assert.equal(score.incorrectAttempts, 1);
  }
  assert.equal(scoreCase(sample, 'complete', request, [name, name]).incorrectAttempts, 1);
  const prefix = request.fields.find(field => field.fieldId === 'prefix')!;
  assert.equal(scoreCase(sample, 'complete', request, [{ ...name, fieldId: prefix.fieldId }]).incorrectAttempts, 1);
});
test('a missing-data decision is not an automatic prepared binding', () => {
  const request = prepareCase(sample, profile);
  const name = rulePredictions(request).find(decision => decision.meaningId === 'personal.name')!;
  assert.equal(scoreCase(sample, 'complete', request, [{ ...name, nextAction: 'requestFact' }]).correctPrepared, 0);
});
