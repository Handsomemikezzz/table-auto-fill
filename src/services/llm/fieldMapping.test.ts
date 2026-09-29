import assert from 'node:assert/strict';
import test from 'node:test';
import { readFact, validateFieldMappings } from './fieldMapping.ts';
import type { UserProfile } from '../../shared/types.ts';

const profile = {
  personal: { name: '张三', gender: '男', phone: '01345678901', email: '', birthDate: '' },
  education: [
    { id: 'e1', school: 'A大学', major: '计算机', degree: '本科', startDate: '2020-09', endDate: '2024-06' },
    { id: 'e2', school: 'B大学', major: '软件工程', degree: '硕士', startDate: '2024-09', endDate: '2027-06' },
  ], experience: [], projects: [], skills: [], certifications: [], customInformation: [],
} satisfies UserProfile;

test('AI maps grounded facts to real option identities regardless of raw coding', () => {
  const field = { index: 0, label: '性别', name: 'gender', options: ['男', '女'], semantic: 'gender', optionCandidates: [
    { id: 'male', label: '男', rawValue: '0' }, { id: 'female', label: '女', rawValue: '1' },
  ] };
  assert.deepEqual(validateFieldMappings({ 0: { profilePath: 'personal.gender', value: '男', optionId: 'male' } }, [field], profile), {
    0: { profilePath: 'personal.gender', value: '男', optionId: 'male' },
  });
  assert.deepEqual(validateFieldMappings({ 0: { profilePath: 'personal.gender', value: '0' } }, [field], profile), {});
  assert.deepEqual(validateFieldMappings({ 0: { profilePath: 'personal.gender', value: '男', optionId: 'female' } }, [field], profile), {});
});

test('AI cannot mix education records within one block', () => {
  const fields = [
    { index: 0, label: '学校', name: 'school', options: [], blockId: 'education-1' },
    { index: 1, label: '专业', name: 'major', options: [], blockId: 'education-1' },
  ];
  assert.deepEqual(validateFieldMappings({
    0: { profilePath: 'education.0.school', value: 'A大学' },
    1: { profilePath: 'education.1.major', value: '软件工程' },
  }, fields, profile), {});
});

test('reject invented source values, unsafe paths and third party substitution', () => {
  const field = { index: 0, label: '紧急联系人电话', name: 'emergencyPhone', options: [] };
  assert.deepEqual(validateFieldMappings({ 0: { profilePath: 'personal.phone', value: '01345678901' } }, [field], profile), {});
  assert.equal(readFact(profile, 'personal.constructor.name'), undefined);
  assert.equal(readFact(profile, 'education.0.id'), undefined);
  assert.deepEqual(validateFieldMappings({ 0: { profilePath: 'education.0.school', value: 'C大学' } }, [{ ...field, label: '学校', name: 'school' }], profile), {});
});

test('unknown dates do not gain invented precision; identifier strings retain leading zero', () => {
  const field = { index: 0, label: '入学时间', name: 'startDate', options: [] };
  assert.deepEqual(validateFieldMappings({ 0: { profilePath: 'education.0.startDate', value: '2020-09-01' } }, [field], profile), {});
  assert.equal(readFact(profile, 'personal.phone'), '01345678901');
});

test('duplicate display labels remain ambiguous even if AI names one ID', () => {
  const field = { index: 0, label: '学校', name: 'school', options: ['A大学', 'A大学'], optionCandidates: [
    { id: 'a', label: 'A大学', rawValue: '1' }, { id: 'b', label: 'A大学', rawValue: '2' },
  ] };
  assert.deepEqual(validateFieldMappings({ 0: { profilePath: 'education.0.school', optionId: 'a' } }, [field], profile), {});
});

test('a value existing in the profile does not justify assigning it to a different known meaning', () => {
  const field = { index: 0, label: '学校', name: 'school', semantic: 'school', options: [] };
  assert.deepEqual(validateFieldMappings({ 0: { profilePath: 'education.0.major', value: '计算机' } }, [field], profile), {});
  assert.deepEqual(validateFieldMappings({ 0: { profilePath: 'education.0.school', value: 'A大学' } }, [field], profile), {
    0: { profilePath: 'education.0.school', value: 'A大学' },
  });
});

test('stable record binding survives profile reordering and rejects another record', () => {
  const field = { index: 0, label: '学校', name: 'school', semantic: 'school', options: [], recordId: 'e2', recordCollection: 'education' as const };
  assert.deepEqual(validateFieldMappings({ 0: { profilePath: 'education.0.school' } }, [field], profile), {});
  assert.equal(validateFieldMappings({ 0: { profilePath: 'education.1.school' } }, [field], profile)['0']?.value, 'B大学');
  const reordered = { ...profile, education: [...profile.education].reverse() };
  assert.equal(validateFieldMappings({ 0: { profilePath: 'education.0.school' } }, [field], reordered)['0']?.value, 'B大学');
});
