import { PROFILE_RECORD_SECTIONS, SUPPLEMENTAL_COLLECTIONS } from '../shared/profileCollections.ts';
import { PERSONAL_EXTRA_FIELDS } from '../shared/personalFields.ts';
import type { FieldDefinition, AdditionalFact } from './contracts.ts';
import { versionOf } from './contracts.ts';

const collections: Record<string, Record<string, string>> = {
  personal: { name: '姓名', gender: '性别', birthDate: '出生日期', phone: '联系电话', email: '电子邮箱', wechat: '微信', idCard: '身份证号', politicalStatus: '政治面貌', ethnicity: '民族', hometown: '籍贯', currentAddress: '现居住地', selfEvaluation: '自我评价', ...Object.fromEntries(PERSONAL_EXTRA_FIELDS.map(field => [field.key, field.label])) },
  education: { school: '学校', college: '学院 / 院系', educationType: '学习形式', major: '专业', majorCategory: '专业类别', degree: '学历层次', academicDegree: '学位', startDate: '入学时间', endDate: '毕业时间', gpa: 'GPA', ranking: '排名' },
  experience: { company: '公司 / 机构', position: '职位', startDate: '工作开始时间', endDate: '工作结束时间', description: '经历描述', achievements: '工作成果' },
  projects: { name: '项目名称', role: '项目角色', startDate: '项目开始时间', endDate: '项目结束时间', description: '项目描述', achievements: '项目成果', technologies: '项目技术栈' },
  ...Object.fromEntries(SUPPLEMENTAL_COLLECTIONS.map(collection => [collection, PROFILE_RECORD_SECTIONS[collection].fields])),
  skills: { skills: '技能' },
};
export function createFieldRegistry(additionalFacts: AdditionalFact[] = []): FieldDefinition[] {
  const builtin = Object.entries(collections).flatMap(([collection, fields]) => Object.entries(fields).map(([key, label]): FieldDefinition => ({
    id: `${collection}.${key}`, label, subject: 'self', key, sourceCollection: collection,
    valueType: /date/i.test(key) ? 'date' : 'text', aliases: [...(collection === 'personal' ? PERSONAL_EXTRA_FIELDS.find(field => field.key === key)?.aliases || [label, key] : [label, key])],
    scope: 'builtin', version: 1, provenance: 'registry',
  })));
  const seen = new Set(builtin.map(def => def.id));
  for (const fact of additionalFacts) {
    if (seen.has(fact.meaningId)) continue;
    seen.add(fact.meaningId);
    builtin.push({ id: fact.meaningId, label: fact.label, subject: fact.subject, key: fact.id, sourceCollection: 'additionalFacts', valueType: fact.valueType, aliases: [fact.label], scope: 'user', version: 1, provenance: 'user-confirmed' });
  }
  return builtin;
}
export const registryVersion = (registry: FieldDefinition[]) => versionOf(registry);
