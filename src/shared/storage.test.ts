import assert from 'node:assert/strict';
import test from 'node:test';
import {
  StorageService,
  STORAGE_KEYS,
} from './storage.ts';
import { computeFileHash } from './resumes.ts';
import type { UserProfile } from './types.ts';

function installChromeStorageMock(initial: Record<string, unknown> = {}) {
  const values: Record<string, unknown> = { ...initial };
  const previousChrome = Object.getOwnPropertyDescriptor(globalThis, 'chrome');
  Object.defineProperty(globalThis, 'chrome', {
    configurable: true,
    value: {
      runtime: {
        getManifest: () => ({ version: '1.3.1' }),
      },
      storage: {
        local: {
          get: async (keys: string | string[] | null) => {
            const selected = keys === null ? Object.keys(values) : Array.isArray(keys) ? keys : [keys];
            return Object.fromEntries(
              selected.filter(key => Object.hasOwn(values, key)).map(key => [key, values[key]]),
            );
          },
          set: async (entries: Record<string, unknown>) => {
            Object.assign(values, entries);
          },
          remove: async (keys: string | string[]) => {
            for (const key of Array.isArray(keys) ? keys : [keys]) delete values[key];
          },
          clear: async () => {
            for (const key of Object.keys(values)) delete values[key];
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

test('1. 旧数据迁移，跑两次结果不变', async () => {
  const mock = installChromeStorageMock({
    [STORAGE_KEYS.USER_PROFILE]: {
      personal: { name: '张三' },
      education: [],
      experience: [],
      projects: [],
      customInformation: [],
      skills: ['TS'],
      certifications: [],
      resume: {
        fileName: 'legacy.pdf',
        fileData: 'data:application/pdf;base64,QUJD',
        fileType: 'pdf',
        uploadDate: '2026-01-01T00:00:00.000Z',
      },
      resumes: [
        {
          id: 'res-1',
          category: '开发',
          fileName: 'dev.pdf',
          fileData: 'data:application/pdf;base64,REVG',
          fileType: 'pdf',
          uploadDate: '2026-01-01T00:00:00.000Z',
        },
      ],
    },
  });

  try {
    const hashLegacy = await computeFileHash('data:application/pdf;base64,QUJD');
    const hashRes1 = await computeFileHash('data:application/pdf;base64,REVG');

    // 第一次迁移
    await StorageService.migrateResumeFiles();

    assert.equal(mock.values[STORAGE_KEYS.STORAGE_SCHEMA_VERSION], 2);
    assert.deepEqual(mock.values['resumeFile:legacy-resume'], { fileData: 'data:application/pdf;base64,QUJD' });
    assert.deepEqual(mock.values['resumeFile:res-1'], { fileData: 'data:application/pdf;base64,REVG' });

    const profile = mock.values[STORAGE_KEYS.USER_PROFILE] as any;
    assert.equal('fileData' in profile.resume, false);
    assert.equal('fileData' in profile.resumes[0], false);
    assert.equal(profile.resume.fileHash, hashLegacy);
    assert.equal(profile.resumes[0].fileHash, hashRes1);

    // 跑第二次，结果严格不变
    const snapshot1 = structuredClone(mock.values);
    await StorageService.migrateResumeFiles();
    assert.deepEqual(mock.values, snapshot1);
  } finally {
    mock.restore();
  }
});

test('2. 迁移中途失败后能恢复', async () => {
  const hashLegacy = await computeFileHash('data:application/pdf;base64,QUJD');
  const hashRes1 = await computeFileHash('data:application/pdf;base64,REVG');

  // 模拟场景：文件已写入，但在写 profile 之前崩溃，storageSchemaVersion 未写入
  const mock = installChromeStorageMock({
    'resumeFile:legacy-resume': { fileData: 'data:application/pdf;base64,QUJD' },
    'resumeFile:res-1': { fileData: 'data:application/pdf;base64,REVG' },
    [STORAGE_KEYS.USER_PROFILE]: {
      personal: { name: '张三' },
      education: [],
      experience: [],
      projects: [],
      customInformation: [],
      skills: [],
      certifications: [],
      resume: {
        fileName: 'legacy.pdf',
        fileData: 'data:application/pdf;base64,QUJD',
        fileType: 'pdf',
        uploadDate: '2026-01-01T00:00:00.000Z',
      },
      resumes: [
        {
          id: 'res-1',
          category: '开发',
          fileName: 'dev.pdf',
          fileData: 'data:application/pdf;base64,REVG',
          fileType: 'pdf',
          uploadDate: '2026-01-01T00:00:00.000Z',
        },
      ],
    },
  });

  try {
    // 重新触发迁移
    await StorageService.migrateResumeFiles();

    assert.equal(mock.values[STORAGE_KEYS.STORAGE_SCHEMA_VERSION], 2);
    assert.deepEqual(mock.values['resumeFile:legacy-resume'], { fileData: 'data:application/pdf;base64,QUJD' });
    assert.deepEqual(mock.values['resumeFile:res-1'], { fileData: 'data:application/pdf;base64,REVG' });

    const profile = mock.values[STORAGE_KEYS.USER_PROFILE] as any;
    assert.equal('fileData' in profile.resume, false);
    assert.equal('fileData' in profile.resumes[0], false);
    assert.equal(profile.resume.fileHash, hashLegacy);
    assert.equal(profile.resumes[0].fileHash, hashRes1);
  } finally {
    mock.restore();
  }
});

test('3. 设置页用带 fileData 的旧对象保存，仍能正确拆分', async () => {
  const mock = installChromeStorageMock();
  try {
    const oldProfile = {
      personal: { name: '李四', gender: '男', birthDate: '', phone: '', email: 'lisi@example.com' },
      education: [],
      experience: [],
      projects: [],
      customInformation: [],
      skills: [],
      certifications: [],
      resumes: [
        {
          id: 'res-old',
          category: '产品',
          fileName: 'old-product.pdf',
          fileData: 'data:application/pdf;base64,QUJD',
          fileType: 'pdf',
          uploadDate: '2026-01-01T00:00:00.000Z',
        },
      ],
    } as unknown as UserProfile;

    const saved = await StorageService.saveUserProfile(oldProfile);
    assert.equal(saved, true);

    // 独立文件写入
    assert.deepEqual(mock.values['resumeFile:res-old'], { fileData: 'data:application/pdf;base64,QUJD' });

    // 资料中 fileData 已被去掉，保留 fileHash
    const storedProfile = mock.values[STORAGE_KEYS.USER_PROFILE] as any;
    assert.equal('fileData' in storedProfile.resumes[0], false);
    assert.equal(storedProfile.resumes[0].fileHash, 'f02f176ead0be37e809134ac30db1f346cabc07360aad260dfe65bcdc7300f64');

    // 通过 getResumeFile 可读取文件内容
    const file = await StorageService.getResumeFile('res-old');
    assert.equal(file, 'data:application/pdf;base64,QUJD');
  } finally {
    mock.restore();
  }
});

test('4. 清理孤儿文件', async () => {
  const mock = installChromeStorageMock({
    'resumeFile:orphan-1': { fileData: 'data:orphan1' },
    'resumeFile:orphan-2': { fileData: 'data:orphan2' },
    'resumeFile:res-keep': { fileData: 'data:keep' },
    [STORAGE_KEYS.USER_PROFILE]: {
      personal: { name: '王五' },
      education: [],
      experience: [],
      projects: [],
      customInformation: [],
      skills: [],
      certifications: [],
      resumes: [
        {
          id: 'res-keep',
          category: '默认',
          fileName: 'keep.pdf',
          fileHash: 'hash-keep',
          fileType: 'pdf',
          uploadDate: '2026-01-01',
        },
      ],
    },
  });

  try {
    const cleaned = await StorageService.cleanOrphanResumeFiles();
    assert.deepEqual(cleaned.sort(), ['resumeFile:orphan-1', 'resumeFile:orphan-2']);
    assert.equal('resumeFile:orphan-1' in mock.values, false);
    assert.equal('resumeFile:orphan-2' in mock.values, false);
    assert.equal('resumeFile:res-keep' in mock.values, true);

    // 测试删除简历时后台同步删掉对应的文件 key
    const profileWithoutKeep = {
      personal: { name: '王五' },
      education: [],
      experience: [],
      projects: [],
      customInformation: [],
      skills: [],
      certifications: [],
      resumes: [],
    } as unknown as UserProfile;

    await StorageService.saveUserProfile(profileWithoutKeep);
    assert.equal('resumeFile:res-keep' in mock.values, false);
  } finally {
    mock.restore();
  }
});
