import assert from 'node:assert/strict';
import test from 'node:test';
import { FieldType } from '../shared/types.ts';
import { FieldMatcher } from './fieldMatcher.ts';

function match(name: string, context = ''): FieldType {
  return FieldMatcher.matchFieldType(name, '', '', '', 'text', '', context).fieldType;
}

test('共享 start_end_time 名称不能盖过明确的日期端点标签', () => {
  const identify = (label: string, context: string) => FieldMatcher.matchFieldType(
    'start_end_time', 'formily-item-start_end_time', '', label, 'text', '', context,
  ).fieldType;
  assert.equal(identify('起止时间 开始时间', '教育经历 无准确的毕业时间可填写预计毕业时间'), FieldType.EDUCATION_START_DATE);
  assert.equal(identify('起止时间 结束时间', '教育经历'), FieldType.GRADUATION_DATE);
  assert.equal(identify('起止时间 开始时间', '工作经历'), FieldType.START_DATE);
  assert.equal(identify('起止时间 结束时间', '工作经历'), FieldType.END_DATE);
  assert.equal(identify('起止时间', '教育经历'), FieldType.UNKNOWN);
});

test('字段匹配使用词边界，避免通用 id/job/contact 子串误判', () => {
  assert.equal(match('contactEmail'), FieldType.EMAIL);
  assert.equal(match('candidate_id'), FieldType.UNKNOWN);
  assert.equal(match('job_location'), FieldType.UNKNOWN);
  assert.equal(match('valid_from'), FieldType.UNKNOWN);
});

test('紧急联系人字段不会套用候选人本人的姓名或电话', () => {
  const emergencyPhone = FieldMatcher.matchFieldType(
    'emergency_phone', '', '', '紧急联系电话', 'tel', '', '紧急联系人信息',
  );
  const emergencyName = FieldMatcher.matchFieldType(
    'contact_name', '', '', '紧急联系人姓名', 'text', 'name', '紧急联系人信息',
  );
  assert.equal(emergencyPhone.fieldType, FieldType.UNKNOWN);
  assert.equal(emergencyName.fieldType, FieldType.UNKNOWN);
});

test('学校、学院与学历不再互相覆盖', () => {
  assert.equal(match('college'), FieldType.COLLEGE);
  assert.equal(match('school'), FieldType.SCHOOL);
  assert.equal(match('degree'), FieldType.DEGREE);
});

test('专业类别、学历层次与学位分别识别', () => {
  assert.equal(match('major_category'), FieldType.MAJOR_CATEGORY);
  assert.equal(match('学历层次'), FieldType.DEGREE);
  assert.equal(match('graduate_degree_level'), FieldType.DEGREE);
  assert.equal(match('academic_degree'), FieldType.ACADEMIC_DEGREE);
  assert.equal(match('授予学位'), FieldType.ACADEMIC_DEGREE);
});

test('政治面貌使用独立字段类型', () => {
  assert.equal(match('political_status'), FieldType.POLITICAL_STATUS);
  assert.equal(match('政治面貌'), FieldType.POLITICAL_STATUS);
});

test('项目经历字段映射到独立项目类型', () => {
  assert.equal(match('name', '项目经历 project'), FieldType.PROJECT_NAME);
  assert.equal(match('project_role', '项目经历'), FieldType.PROJECT_ROLE);
  assert.equal(match('start_date', '项目经历'), FieldType.PROJECT_START_DATE);
  assert.equal(match('description', '项目经历'), FieldType.PROJECT_DESCRIPTION);
});
