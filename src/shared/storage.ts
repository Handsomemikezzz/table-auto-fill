import { normalizeSupplementalRecords } from './profileCollections.ts';
import { getPersonalAdditionalFields } from './personalFields.ts';
import type {
  BackupData,
  BackupUserProfile,
  ResumeFileRecord,
  SettingsData,
  UserProfile,
} from './types';
import { computeFileHash, LEGACY_RESUME_ID, normalizeResumeLibrary } from './resumes.ts';
import { normalizeBirthDateValue, normalizePoliticalStatusValue } from './personal.ts';

export const STORAGE_KEYS = {
  USER_PROFILE: 'userProfile',
  SETTINGS: 'settings',
  // Keep the retired key for non-destructive legacy backup compatibility.
  LEGACY_APPLICATION_RECORDS: 'applicationRecords',
  STORAGE_SCHEMA_VERSION: 'storageSchemaVersion',
} as const;

export const RESUME_FILE_KEY_PREFIX = 'resumeFile:';
export const STORAGE_SCHEMA_VERSION = 2;

export function resumeFileKey(id: string): string {
  return id.startsWith(RESUME_FILE_KEY_PREFIX) ? id : `${RESUME_FILE_KEY_PREFIX}${id}`;
}

export function resumeIdFromKey(key: string): string {
  return key.startsWith(RESUME_FILE_KEY_PREFIX) ? key.slice(RESUME_FILE_KEY_PREFIX.length) : key;
}

type StoredResume = { id?: string; fileHash?: string; fileData?: string };
type StoredProfile = { resume?: StoredResume; resumes?: StoredResume[] };

/** 旧版单简历可能没有 id，与 getResumeLibrary 一致地对应 LEGACY_RESUME_ID。 */
function resumeIdOf(resume: StoredResume): string {
  return resume.id || LEGACY_RESUME_ID;
}

function referencedResumeIds(profile: StoredProfile | null | undefined): Set<string> {
  const ids = new Set<string>();
  for (const item of Array.isArray(profile?.resumes) ? profile.resumes : []) if (item?.id) ids.add(item.id);
  if (profile?.resume) ids.add(resumeIdOf(profile.resume));
  return ids;
}

/** 把资料里内联的 fileData 拆成独立文件记录；rehash 时以文件内容重算哈希。 */
async function externalizeResumeFiles<T extends StoredProfile>(
  source: T,
  rehash = false,
): Promise<{ profile: T; files: Record<string, ResumeFileRecord> }> {
  const profile = structuredClone(source);
  const files: Record<string, ResumeFileRecord> = {};
  const split = async (item: StoredResume, id: string) => {
    if (!item.fileData) return;
    if (rehash || !item.fileHash) item.fileHash = await computeFileHash(item.fileData);
    files[resumeFileKey(id)] = { fileData: item.fileData };
    delete item.fileData;
  };
  if (Array.isArray(profile.resumes)) {
    for (const [index, item] of profile.resumes.entries()) {
      if (!item) continue;
      item.id ||= `resume-${index + 1}`;
      await split(item, item.id);
    }
  }
  if (profile.resume) await split(profile.resume, resumeIdOf(profile.resume));
  return { profile, files };
}

export function normalizeUserProfile(profile: UserProfile): UserProfile {
  return {
    ...profile,
    personal: {
      ...(profile.personal || {}),
      ...(profile.personal?.additionalFields || profile.additionalFacts ? { additionalFields: getPersonalAdditionalFields(profile) } : {}),
      ...(profile.personal?.politicalStatus
        ? { politicalStatus: normalizePoliticalStatusValue(profile.personal.politicalStatus) }
        : {}),
      ...(profile.personal?.birthDate
        ? { birthDate: normalizeBirthDateValue(profile.personal.birthDate) }
        : {}),
    },
    customInformation: profile.customInformation || [],
    education: (profile.education || []).map(education => ({
      ...education,
      college: education.college || '',
      educationType: education.educationType || '',
      majorCategory: education.majorCategory || '',
      academicDegree: education.academicDegree || '',
      degree: normalizeEducationLevel(education.degree),
    })),
    experience: profile.experience || [],
    projects: profile.projects || [],
    skills: profile.skills || [],
    certifications: profile.certifications || [],
    ...normalizeSupplementalRecords(profile),
    resumes: normalizeResumeLibrary(profile),
  } as UserProfile;
}

function normalizeEducationLevel(degree?: string): string {
  const value = degree || '';
  if (/博士/.test(value) && !/博士后/.test(value)) return '博士研究生';
  if (/硕士|研究生|MBA|EMBA/i.test(value)) return '硕士研究生';
  if (/本科|学士/.test(value)) return '本科';
  return value;
}

export function normalizeSettings(settings: SettingsData | null): SettingsData | null {
  if (!settings) return null;
  const { fieldRecognitionRules: _rules, controlExperiencesV1: _experiences, meaningCorrectionsV1: _corrections, learnedFieldValues: _learned, ...local } = settings;
  return local;
}

export class StorageService {
  static async removeRetiredData(): Promise<void> {
    const stored = await chrome.storage.local.get(null);
    const retired = Object.keys(stored).filter(key => ['llmConfig', 'webdavConfig', 'syncMetadata'].includes(key)
      || key.startsWith('fieldMatch_v') || key.startsWith('aiPageFill_v'));
    if (retired.length) await chrome.storage.local.remove(retired);
    if (stored.settings && typeof stored.settings === 'object') {
      const settings = normalizeSettings(stored.settings as SettingsData);
      if (JSON.stringify(settings) !== JSON.stringify(stored.settings)) await this.saveSettings(settings!);
    }
  }

  static async getResumeFile(id: string): Promise<string | undefined> {
    const key = resumeFileKey(id);
    const result = await chrome.storage.local.get(key);
    const record = result[key] as ResumeFileRecord | string | undefined;
    if (record) {
      return typeof record === 'string' ? record : record.fileData;
    }
    // Fallback for unmigrated data in userProfile
    try {
      const stored = (await chrome.storage.local.get(STORAGE_KEYS.USER_PROFILE))[STORAGE_KEYS.USER_PROFILE] as any;
      if (stored) {
        if (id === LEGACY_RESUME_ID && stored.resume?.fileData) return stored.resume.fileData;
        const found = stored.resumes?.find((r: any) => r.id === id);
        if (found?.fileData) return found.fileData;
        if (stored.resume?.id === id && stored.resume?.fileData) return stored.resume.fileData;
      }
    } catch {
      // ignore
    }
    return undefined;
  }

  static async saveResumeFile(id: string, fileData: string): Promise<void> {
    await chrome.storage.local.set({
      [resumeFileKey(id)]: { fileData } satisfies ResumeFileRecord,
    });
  }

  static async removeResumeFiles(ids: string[]): Promise<void> {
    if (!ids.length) return;
    const keys = ids.map(resumeFileKey);
    await chrome.storage.local.remove(keys);
  }

  static async cleanOrphanResumeFiles(referencedIds?: Set<string>): Promise<string[]> {
    const stored = await chrome.storage.local.get(null);
    const validIds = referencedIds ?? referencedResumeIds(stored[STORAGE_KEYS.USER_PROFILE] as StoredProfile | undefined);
    const orphanKeys = Object.keys(stored)
      .filter(k => k.startsWith(RESUME_FILE_KEY_PREFIX))
      .filter(k => !validIds.has(resumeIdFromKey(k)));
    if (orphanKeys.length > 0) {
      await chrome.storage.local.remove(orphanKeys);
    }
    return orphanKeys;
  }

  /** 只在升级后执行一次；之后 saveUserProfile / replaceBusinessData 会自行拆分文件。 */
  static async migrateResumeFiles(): Promise<void> {
    const stored = await chrome.storage.local.get([STORAGE_KEYS.STORAGE_SCHEMA_VERSION, STORAGE_KEYS.USER_PROFILE]);
    if (Number(stored[STORAGE_KEYS.STORAGE_SCHEMA_VERSION]) >= STORAGE_SCHEMA_VERSION) return;
    const rawProfile = stored[STORAGE_KEYS.USER_PROFILE] as UserProfile | undefined;
    if (rawProfile) {
      const { profile, files } = await externalizeResumeFiles(rawProfile);
      // 写入顺序必须是先写文件、再写资料，避免中途崩溃后资料引用了不存在的文件
      if (Object.keys(files).length > 0) {
        await chrome.storage.local.set(files);
        await chrome.storage.local.set({ [STORAGE_KEYS.USER_PROFILE]: profile });
      }
    }
    await this.cleanOrphanResumeFiles();
    await chrome.storage.local.set({
      [STORAGE_KEYS.STORAGE_SCHEMA_VERSION]: STORAGE_SCHEMA_VERSION,
    });
  }

  // 获取用户资料
  static async getUserProfile(): Promise<UserProfile | null> {
    try {
      const result = await chrome.storage.local.get(STORAGE_KEYS.USER_PROFILE);
      const profile = (result[STORAGE_KEYS.USER_PROFILE] as UserProfile) || null;
      return profile ? normalizeUserProfile(profile) : null;
    } catch (error) {
      console.error('Failed to get user profile:', error);
      return null;
    }
  }

  // 保存用户资料
  static async saveUserProfile(profile: UserProfile): Promise<boolean> {
    try {
      const { profile: cleanProfile, files } = await externalizeResumeFiles(profile);
      const previousProfile = (await chrome.storage.local.get(STORAGE_KEYS.USER_PROFILE))[STORAGE_KEYS.USER_PROFILE] as StoredProfile | undefined;

      // 先写文件、再写资料，最后删除不再引用的文件：中途失败最多留下孤儿文件，资料不会指向已删除的文件。
      if (Object.keys(files).length > 0) {
        await chrome.storage.local.set(files);
      }
      await chrome.storage.local.set({
        [STORAGE_KEYS.USER_PROFILE]: cleanProfile
      });
      const keptIds = referencedResumeIds(cleanProfile);
      await this.removeResumeFiles([...referencedResumeIds(previousProfile)].filter(id => !keptIds.has(id)));
      return true;
    } catch (error) {
      console.error('Failed to save user profile:', error);
      return false;
    }
  }

  // 更新部分用户资料
  static async updateUserProfile(updates: Partial<UserProfile>): Promise<boolean> {
    try {
      const currentProfile = await this.getUserProfile();
      if (!currentProfile) {
        return false;
      }

      const updatedProfile = {
        ...currentProfile,
        ...updates
      };

      return await this.saveUserProfile(updatedProfile);
    } catch (error) {
      console.error('Failed to update user profile:', error);
      return false;
    }
  }

  // 清除所有数据
  static async clearAll(): Promise<boolean> {
    try {
      await chrome.storage.local.clear();
      return true;
    } catch (error) {
      console.error('Failed to clear storage:', error);
      return false;
    }
  }

  // 获取存储使用情况
  static async getStorageUsage(): Promise<{ used: number; quota: number }> {
    try {
      const bytesInUse = await chrome.storage.local.getBytesInUse();
      return {
        used: bytesInUse,
        quota: chrome.storage.local.QUOTA_BYTES
      };
    } catch (error) {
      console.error('Failed to get storage usage:', error);
      return { used: 0, quota: 0 };
    }
  }

  static async getSettings(): Promise<SettingsData | null> {
    const result = await chrome.storage.local.get(STORAGE_KEYS.SETTINGS);
    return normalizeSettings((result[STORAGE_KEYS.SETTINGS] as SettingsData) || null);
  }

  static async saveSettings(settings: SettingsData): Promise<void> {
    await chrome.storage.local.set({ [STORAGE_KEYS.SETTINGS]: normalizeSettings(settings) });
  }

  static async getBackupData(): Promise<BackupData> {
    const result = await chrome.storage.local.get([
      STORAGE_KEYS.USER_PROFILE,
      STORAGE_KEYS.SETTINGS,
      STORAGE_KEYS.LEGACY_APPLICATION_RECORDS,
    ]);
    const profile = (result[STORAGE_KEYS.USER_PROFILE] as UserProfile | undefined) || null;
    let backupProfile: BackupUserProfile | null = null;
    if (profile) {
      const normalized = normalizeUserProfile(profile);
      const fileKeys = [...referencedResumeIds(normalized)].map(resumeFileKey);
      const fileRecords = fileKeys.length > 0 ? await chrome.storage.local.get(fileKeys) : {};
      const withFileData = <R extends StoredResume>(item: R, id: string): R & ResumeFileRecord => {
        const entry = fileRecords[resumeFileKey(id)] as ResumeFileRecord | string | undefined;
        const fileData = typeof entry === 'string' ? entry : entry?.fileData;
        return { ...item, fileData: fileData || item.fileData || '' };
      };
      backupProfile = {
        ...normalized,
        resume: normalized.resume && withFileData(normalized.resume, resumeIdOf(normalized.resume)),
        resumes: normalized.resumes?.map(item => withFileData(item, item.id)),
      };
    }
    return {
      userProfile: backupProfile,
      settings: normalizeSettings((result[STORAGE_KEYS.SETTINGS] as SettingsData | undefined) || null),
      applicationRecords: (result[STORAGE_KEYS.LEGACY_APPLICATION_RECORDS] as BackupData['applicationRecords']) ?? [],
    };
  }

  static async replaceBusinessData(data: BackupData): Promise<void> {
    // 备份来自外部文件，哈希以文件内容为准重新计算。
    const externalized = data.userProfile ? await externalizeResumeFiles(data.userProfile, true) : null;
    const cleanProfile = (externalized?.profile ?? null) as UserProfile | null;

    // 1. 写入顺序必须是先写文件
    if (externalized && Object.keys(externalized.files).length > 0) {
      await chrome.storage.local.set(externalized.files);
    }

    // 2. 再写业务资料
    const values: Record<string, unknown> = {};
    const removals: string[] = [];
    const entries = [
      [STORAGE_KEYS.USER_PROFILE, cleanProfile],
      [STORAGE_KEYS.SETTINGS, normalizeSettings(data.settings)],
    ] as const;

    for (const [key, value] of entries) {
      if (value === null) removals.push(key);
      else values[key] = value;
    }

    if (Object.hasOwn(data, 'applicationRecords')) {
      if (data.applicationRecords === null) removals.push(STORAGE_KEYS.LEGACY_APPLICATION_RECORDS);
      else values[STORAGE_KEYS.LEGACY_APPLICATION_RECORDS] = data.applicationRecords;
    }

    values[STORAGE_KEYS.STORAGE_SCHEMA_VERSION] = STORAGE_SCHEMA_VERSION;

    if (Object.keys(values).length > 0) await chrome.storage.local.set(values);
    if (removals.length > 0) await chrome.storage.local.remove(removals);

    // 3. 资料写入后再清理旧的文件 key
    await this.cleanOrphanResumeFiles(referencedResumeIds(cleanProfile));
  }
}
