import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createBackupDocument,
  createBackupSummary,
  MAX_BACKUP_BYTES,
  parseAndValidateBackup,
  serializeBackup,
} from './backup.ts';
import { StorageService } from './storage.ts';
import type { BackupData } from './types.ts';

const completeData: BackupData = {
  userProfile: {
    personal: {
      name: '张三',
      gender: '男',
      birthDate: '2000-01',
      phone: '13800000000',
      email: 'test@example.com',
    },
    education: [],
    experience: [],
    projects: [],
    customInformation: [],
    skills: ['TypeScript'],
    certifications: [],
    resume: {
      fileName: 'resume.pdf',
      fileData: 'data:application/pdf;base64,QUJD',
      fileType: 'pdf',
      uploadDate: '2026-01-01T00:00:00.000Z',
    },
  },
  settings: { locale: 'zh-CN' },
  applicationRecords: [
    {
      id: 'record-1',
      companyName: '字节跳动',
      jobTitle: '前端开发',
      sourceSite: 'jobs.bytedance.com',
      sourceUrl: 'https://jobs.bytedance.com/example-1',
      status: '已投递',
      notes: '一志愿',
      appliedAt: '2026-01-01',
      location: '北京',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    },
  ],
};

function installChromeStorageMock(initial: Record<string, unknown>) {
  const values = { ...initial };
  const previousChrome = Object.getOwnPropertyDescriptor(globalThis, 'chrome');
  Object.defineProperty(globalThis, 'chrome', {
    configurable: true,
    value: {
      runtime: {
        getManifest: () => ({ version: '1.0.0' }),
      },
      storage: {
        local: {
          get: async (keys: string | string[]) => {
            const selected = keys === null ? Object.keys(values) : Array.isArray(keys) ? keys : [keys];
            return Object.fromEntries(
              selected.filter(key => Object.hasOwn(values, key)).map(key => [key, values[key]]),
            );
          },
          set: async (entries: Record<string, unknown>) => Object.assign(values, entries),
          remove: async (keys: string | string[]) => {
            for (const key of Array.isArray(keys) ? keys : [keys]) delete values[key];
          },
        },
      },
    },
  });
  return {
    values,
    restore: () => {
      if (previousChrome) Object.defineProperty(globalThis, 'chrome', previousChrome);
      else delete (globalThis as { chrome?: unknown }).chrome;
    },
  };
}

function validJson() {
  return serializeBackup(createBackupDocument(
    completeData,
    '1.0.0',
    '2026-01-01T00:00:00.000Z',
  ));
}

test('合法 V1 文档完整保留简历和资料', () => {
  const result = parseAndValidateBackup(validJson());
  assert.equal(result.success, true);
  if (!result.success) return;
  assert.equal(result.document.data.userProfile?.resume?.fileData, completeData.userProfile?.resume?.fileData);
  assert.equal(result.document.data.applicationRecords?.[0]?.companyName, '字节跳动');
});

test('V1 备份可保存多份简历的分类与原文件名', () => {
  const document = JSON.parse(validJson());
  document.data.userProfile.resumes = [
    {
      id: 'resume-pm',
      category: '产品岗',
      fileName: '张三-产品经理.pdf',
      fileData: 'data:application/pdf;base64,QUJD',
      fileType: 'pdf',
      uploadDate: '2026-09-07T00:00:00.000Z',
      parsedProfile: {
        personal: { name: '张三' },
        education: [{
          id: 'edu-1', school: '新疆大学', college: '电气工程学院', educationType: '统招全日制',
          major: '能源动力', majorCategory: '动力工程及工程热物理', degree: '硕士研究生',
          academicDegree: '硕士', startDate: '2024-09', endDate: '2027-06', gpa: '', ranking: '',
        }],
        experience: [{ id: 'exp-1', company: '甲公司', position: '产品经理', startDate: '', endDate: '', description: '' }],
        projects: [],
        skills: ['原型设计'],
      },
    },
    {
      id: 'resume-data',
      category: '数据岗',
      fileName: '张三-数据分析.pdf',
      fileData: 'data:application/pdf;base64,REVG',
      fileType: 'pdf',
      uploadDate: '2026-09-07T00:00:00.000Z',
    },
  ];
  const result = parseAndValidateBackup(JSON.stringify(document));
  assert.equal(result.success, true);
  if (!result.success) return;
  assert.equal(result.document.schemaVersion, 1);
  assert.equal(result.document.data.userProfile?.resumes?.[1]?.category, '数据岗');
  assert.equal(result.document.data.userProfile?.resumes?.[1]?.fileName, '张三-数据分析.pdf');
  assert.equal(result.document.data.userProfile?.resumes?.[0]?.parsedProfile?.experience[0]?.position, '产品经理');
  assert.equal(result.document.data.userProfile?.resumes?.[0]?.parsedProfile?.education[0]?.college, '电气工程学院');
  assert.equal(result.document.data.userProfile?.resumes?.[0]?.parsedProfile?.education[0]?.majorCategory, '动力工程及工程热物理');
  assert.equal(createBackupSummary(result.document).hasResumeFile, true);
});

test('拒绝结构非法的简历独立资料', () => {
  const document = JSON.parse(validJson());
  document.data.userProfile.resumes = [{
    id: 'bad-profile', category: '产品岗', fileName: 'resume.pdf', fileData: 'data:application/pdf;base64,QUJD',
    fileType: 'pdf', uploadDate: '2026-09-07T00:00:00.000Z',
    parsedProfile: { personal: {}, education: 'not-an-array', experience: [], projects: [], skills: [] },
  }];
  const result = parseAndValidateBackup(JSON.stringify(document));
  assert.equal(result.success, false);
  if (!result.success) assert.equal(result.error.code, 'INVALID_USER_PROFILE');
});

test('多简历条目中的文件数据必须为字符串', () => {
  const document = JSON.parse(validJson());
  document.data.userProfile.resumes = [{
    id: 'bad', category: '产品岗', fileName: 'resume.pdf', fileData: 123,
    fileType: 'pdf', uploadDate: '2026-09-07T00:00:00.000Z',
  }];
  const result = parseAndValidateBackup(JSON.stringify(document));
  assert.equal(result.success, false);
  if (!result.success) assert.equal(result.error.code, 'INVALID_USER_PROFILE');
});

test('拒绝错误的用户资料数组', () => {
  const document = JSON.parse(validJson());
  document.data.userProfile.education = {};
  const result = parseAndValidateBackup(JSON.stringify(document));
  assert.equal(result.success, false);
  if (!result.success) assert.equal(result.error.code, 'INVALID_USER_PROFILE');
});

test('旧资料缺少数组字段时会补齐为空数组', () => {
  const document = JSON.parse(validJson());
  delete document.data.userProfile.education;
  delete document.data.userProfile.customInformation;
  delete document.data.applicationRecords;
  const result = parseAndValidateBackup(JSON.stringify(document));
  assert.equal(result.success, true);
  if (result.success) {
    assert.deepEqual(result.document.data.userProfile?.education, []);
    assert.deepEqual(result.document.data.userProfile?.customInformation, []);
    assert.equal('applicationRecords' in result.document.data, false);
  }
});

test('拒绝非对象类型的旧版兼容数据', () => {
  const document = JSON.parse(validJson());
  document.data.applicationRecords = [123];
  const result = parseAndValidateBackup(JSON.stringify(document));
  assert.equal(result.success, false);
  if (!result.success) assert.equal(result.error.code, 'INVALID_DATA');
});

test('拒绝非字符串简历正文', () => {
  const document = JSON.parse(validJson());
  document.data.userProfile.resume.fileData = 123;
  const result = parseAndValidateBackup(JSON.stringify(document));
  assert.equal(result.success, false);
  if (!result.success) assert.equal(result.error.code, 'INVALID_USER_PROFILE');
});

test('拒绝超过 20 MiB 的输入', () => {
  const result = parseAndValidateBackup('x'.repeat(MAX_BACKUP_BYTES + 1));
  assert.equal(result.success, false);
  if (!result.success) assert.equal(result.error.code, 'FILE_TOO_LARGE');
});

test('导入旧备份时保留本地旧版兼容数据', async () => {
  const localData: BackupData = {
    ...completeData,
    settings: { locale: 'zh-CN', source: 'local' },
    applicationRecords: [
      {
        ...completeData.applicationRecords![0]!,
        id: 'local-record',
        notes: '保留本地',
      },
    ],
  };
  const legacyDocument = JSON.parse(serializeBackup(createBackupDocument(
    { ...completeData, settings: { locale: 'en-US', source: 'imported' } },
    '1.0.0',
    '2026-02-01T00:00:00.000Z',
  )));
  delete legacyDocument.data.applicationRecords;
  const mock = installChromeStorageMock({
    userProfile: localData.userProfile,
    settings: localData.settings,
    applicationRecords: localData.applicationRecords,
  });
  try {
    const parsed = parseAndValidateBackup(JSON.stringify(legacyDocument));
    assert.ok(parsed.success);
    await StorageService.replaceBusinessData(parsed.document.data);
    assert.deepEqual(mock.values.settings, { locale: 'en-US', source: 'imported' });
    assert.deepEqual(mock.values.applicationRecords, localData.applicationRecords);
  } finally {
    mock.restore();
  }
});


for (const retiredConfig of [
  { enabled: true, serverUrl: 'https://dav.example.com/', username: 'user', password: 'retired-secret' },
  { enabled: 'yes', password: 123 },
  null,
]) {
  test(`旧备份中的已移除配置会被忽略：${JSON.stringify(retiredConfig)}`, async () => {
    const legacyDocument = JSON.parse(validJson());
    legacyDocument.webdavConfig = retiredConfig;
    const result = parseAndValidateBackup(JSON.stringify(legacyDocument));
    assert.ok(result.success);
    assert.equal('webdavConfig' in result.document, false);
    const mock = installChromeStorageMock({});
    try {
      await StorageService.replaceBusinessData(result.document.data);
      assert.equal('webdavConfig' in mock.values, false);
      const exported = serializeBackup(createBackupDocument(await StorageService.getBackupData(), '1.3.1'));
      assert.doesNotMatch(exported, /webdavConfig|retired-secret/);
      const restored = parseAndValidateBackup(exported);
      assert.ok(restored.success);
      assert.deepEqual(restored.document.data, result.document.data);
    } finally {
      mock.restore();
    }
  });
}

test('导出仅包含业务数据，不包含本地遗留同步凭据或状态', async () => {
  const mock = installChromeStorageMock({
    ...completeData,
    webdavConfig: { password: 'retired-secret', serverUrl: 'https://dav.example.com/' },
    syncMetadata: { status: 'synced', etag: 'retired-etag' },
  });
  try {
    const json = serializeBackup(createBackupDocument(await StorageService.getBackupData(), '1.3.1'));
    assert.doesNotMatch(json, /webdavConfig|syncMetadata|retired-secret|retired-etag/);
    const parsed = parseAndValidateBackup(json);
    assert.ok(parsed.success);
    assert.equal(parsed.document.data.userProfile?.personal.name, '张三');
  } finally {
    mock.restore();
  }
});

for (const [raw, code] of [['{', 'INVALID_JSON'], ['[]', 'INVALID_ROOT'], ['{}', 'MISSING_SCHEMA_VERSION'], ['{"schemaVersion":2}', 'UNSUPPORTED_FUTURE_VERSION']] as const) {
  test(`拒绝无效备份：${code}`, () => { const parsed = parseAndValidateBackup(raw); assert(!parsed.success); assert.equal(parsed.error.code, code); });
}

for (const llmConfig of [{ apiKey: 'retired-api-key', baseUrl: 'https://example.com' }, { invalid: true }, null]) {
  test('旧备份中的模型配置被忽略，重新导出不包含凭据', async () => {
    const legacy = JSON.parse(validJson()); legacy.data.llmConfig = llmConfig;
    legacy.data.settings.fieldRecognitionRules = 'retired-model-prompt';
    const result = parseAndValidateBackup(JSON.stringify(legacy)); assert.ok(result.success);
    assert.equal('llmConfig' in result.document.data, false);
    assert.doesNotMatch(serializeBackup(result.document), /llmConfig|retired-api-key|retired-model-prompt/);
    const mock = installChromeStorageMock({ llmConfig, settings: { locale: 'zh-CN', fieldRecognitionRules: 'retired', learnedFieldValues: { 'jobs.example': { old: { value: 'legacy cache' } } } }, fieldMatch_v4_test: { stale: true }, aiPageFill_v3_test: { stale: true }, userProfile: completeData.userProfile });
    try {
      await StorageService.removeRetiredData();
      assert.equal('llmConfig' in mock.values, false);
      assert.equal('fieldMatch_v4_test' in mock.values, false);
      assert.equal('aiPageFill_v3_test' in mock.values, false);
      assert.deepEqual(mock.values.settings, { locale: 'zh-CN' });
      assert.equal(mock.values.userProfile, completeData.userProfile);
      await StorageService.replaceBusinessData(result.document.data);
      assert.equal('llmConfig' in mock.values, false);
    } finally { mock.restore(); }
  });
}
