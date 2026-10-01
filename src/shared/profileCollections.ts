/** Shared labels and record identity keep parsing, review, editing and filling aligned. */
export const PROFILE_RECORD_SECTIONS = {
  education: { label: '教育经历', titleKey: 'school', identity: ['school', 'degree', 'startDate'], fields: { school: '学校', degree: '学历层次', major: '专业', college: '学院 / 院系', academicDegree: '学位', educationType: '学习形式', startDate: '入学时间', endDate: '毕业时间', gpa: 'GPA', majorCategory: '专业类别', ranking: '排名' } },
  experience: { label: '工作与实习', titleKey: 'company', identity: ['company', 'position', 'startDate'], fields: { company: '公司 / 机构', position: '职位', startDate: '开始时间', endDate: '结束时间', description: '经历说明', achievements: '成果' } },
  projects: { label: '项目经历', titleKey: 'name', identity: ['name', 'startDate'], fields: { name: '项目名称', role: '担任角色', startDate: '开始时间', endDate: '结束时间', description: '项目说明', technologies: '技术栈', achievements: '成果' } },
  awards: { label: '获奖与荣誉', titleKey: 'name', identity: ['name', 'date'], fields: { name: '奖项名称', issuer: '颁奖单位', date: '获奖时间', level: '奖项级别', ranking: '名次 / 等次', description: '获奖说明' } },
  publications: { label: '论文与著作', titleKey: 'title', identity: ['title', 'authors'], fields: { title: '论文 / 著作标题', authors: '作者与署名顺序', venue: '期刊 / 会议 / 出版社', date: '发表时间', status: '发表 / 录用状态', doi: 'DOI', url: '论文链接', description: '研究内容与贡献' } },
  languages: { label: '语言能力', titleKey: 'language', identity: ['language', 'test', 'date'], fields: { language: '语种', proficiency: '熟练程度', test: '考试 / 证书', score: '成绩', date: '考试时间', description: '听说读写 / 使用情况' } },
  certifications: { label: '证书与资格', titleKey: 'name', identity: ['name', 'issuer', 'date'], fields: { name: '证书名称', issuer: '颁发机构', date: '颁发日期', credentialId: '证书编号', expiryDate: '有效期至', description: '资格说明' } },
  patents: { label: '专利与知识产权', titleKey: 'name', identity: ['name', 'patentNumber'], fields: { name: '专利名称', inventors: '发明人与署名顺序', patentNumber: '申请 / 专利号', type: '专利类型', status: '申请 / 授权状态', date: '申请 / 授权日期', description: '专利说明' } },
  activities: { label: '校园与志愿经历', titleKey: 'organization', identity: ['organization', 'role', 'startDate'], fields: { organization: '学校 / 社团 / 组织', role: '职务 / 角色', startDate: '开始时间', endDate: '结束时间', description: '活动 / 志愿服务内容', achievements: '成果' } },
  additionalInfo: { label: '其他补充资料', titleKey: 'name', identity: ['name', 'content'], fields: { name: '信息名称', content: '具体内容' } },
} as const;
export type ProfileRecordCollection = keyof typeof PROFILE_RECORD_SECTIONS;
export const PROFILE_RECORD_COLLECTIONS = Object.keys(PROFILE_RECORD_SECTIONS) as ProfileRecordCollection[];
export const SUPPLEMENTAL_COLLECTIONS = ['awards', 'publications', 'languages', 'certifications', 'patents', 'activities', 'additionalInfo'] as const;
export type ProfileRecord = { id: string; [key: string]: string };
export function getProfileRecords(profile: object, collection: ProfileRecordCollection): ProfileRecord[] {
  return (profile as Record<string, unknown>)[collection] as ProfileRecord[] || [];
}
/** Missing sections stay absent in old snapshots; present empty sections stay explicitly empty. */
export function normalizeSupplementalRecords(source: object): Record<string, ProfileRecord[]> {
  const result: Record<string, ProfileRecord[]> = {};
  for (const collection of SUPPLEMENTAL_COLLECTIONS) {
    if ((source as Record<string, unknown>)[collection] === undefined) continue;
    result[collection] = getProfileRecords(source, collection).map((row, index) => ({
      id: row.id || `${collection}-${index + 1}`,
      ...Object.fromEntries(Object.keys(PROFILE_RECORD_SECTIONS[collection].fields).map(key => [key, typeof row[key] === 'string' ? row[key] : ''])),
    }));
  }
  return result;
}
export function isLongProfileField(key: string): boolean { return ['description', 'achievements', 'content'].includes(key); }
