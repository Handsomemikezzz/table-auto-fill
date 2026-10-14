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
    let validIds = referencedIds;
    if (!validIds) {
      validIds = new Set<string>();
      const profile = stored[STORAGE_KEYS.USER_PROFILE] as any;
      if (profile) {
        if (profile.resumes && Array.isArray(profile.resumes)) {
          for (const r of profile.resumes) if (r?.id) validIds.add(r.id);
        }
        if (profile.resume?.id) {
          validIds.add(profile.resume.id);
        }
        if (profile.resume && !profile.resume.id && (profile.resume.fileHash || profile.resume.fileData)) {
          validIds.add(LEGACY_RESUME_ID);
        }
      }
    }
    const orphanKeys = Object.keys(stored)
      .filter(k => k.startsWith(RESUME_FILE_KEY_PREFIX))
      .filter(k => !validIds!.has(resumeIdFromKey(k)));
    if (orphanKeys.length > 0) {
      await chrome.storage.local.remove(orphanKeys);
    }
    return orphanKeys;
  }

  static async migrateResumeFiles(): Promise<void> {
    const stored = await chrome.storage.local.get(null);
    const rawProfile = stored[STORAGE_KEYS.USER_PROFILE] as any;
    if (rawProfile) {
      let needsProfileUpdate = false;
      const filesToWrite: Record<string, ResumeFileRecord> = {};
      const profile = structuredClone(rawProfile);
      if (profile.resumes && Array.isArray(profile.resumes)) {
        for (let i = 0; i < profile.resumes.length; i++) {
          const item = profile.resumes[i];
          if (item && item.fileData) {
            needsProfileUpdate = true;
            const id = item.id || `resume-${i + 1}`;
            item.id = id;
            if (!item.fileHash) {
              item.fileHash = await computeFileHash(item.fileData);
            }
            filesToWrite[resumeFileKey(id)] = { fileData: item.fileData };
            delete item.fileData;
          }
        }
      }
      if (profile.resume && profile.resume.fileData) {
        needsProfileUpdate = true;
        const id = profile.resume.id || LEGACY_RESUME_ID;
        if (!profile.resume.fileHash) {
          profile.resume.fileHash = await computeFileHash(profile.resume.fileData);
        }
        filesToWrite[resumeFileKey(id)] = { fileData: profile.resume.fileData };
        delete profile.resume.fileData;
      }
      // 写入顺序必须是先写文件、再写资料，避免中途崩溃后资料引用了不存在的文件
      if (Object.keys(filesToWrite).length > 0) {
        await chrome.storage.local.set(filesToWrite);
      }
      if (needsProfileUpdate) {
        await chrome.storage.local.set({
          [STORAGE_KEYS.USER_PROFILE]: profile,
        });
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
      const cleanProfile = structuredClone(profile) as any;
      const filesToWrite: Record<string, ResumeFileRecord> = {};

      if (cleanProfile.resumes && Array.isArray(cleanProfile.resumes)) {
        for (let i = 0; i < cleanProfile.resumes.length; i++) {
          const item = cleanProfile.resumes[i];
          if (item && item.fileData) {
            const id = item.id || `resume-${i + 1}`;
            item.id = id;
            if (!item.fileHash) {
              item.fileHash = await computeFileHash(item.fileData);
            }
            filesToWrite[resumeFileKey(id)] = { fileData: item.fileData };
            delete item.fileData;
          }
        }
      }
      if (cleanProfile.resume && cleanProfile.resume.fileData) {
        const id = cleanProfile.resume.id || LEGACY_RESUME_ID;
        if (!cleanProfile.resume.fileHash) {
          cleanProfile.resume.fileHash = await computeFileHash(cleanProfile.resume.fileData);
        }
        filesToWrite[resumeFileKey(id)] = { fileData: cleanProfile.resume.fileData };
        delete cleanProfile.resume.fileData;
      }

      // 1. 写入顺序必须是先写文件、再写资料
      if (Object.keys(filesToWrite).length > 0) {
        await chrome.storage.local.set(filesToWrite);
      }

      // 2. 删除简历时，后台要同时删掉对应的文件 key
      const currentStored = await chrome.storage.local.get(STORAGE_KEYS.USER_PROFILE);
      const previousProfile = currentStored[STORAGE_KEYS.USER_PROFILE] as any;
      if (previousProfile) {
        const previousIds = new Set<string>();
        if (previousProfile.resumes && Array.isArray(previousProfile.resumes)) {
          for (const r of previousProfile.resumes) if (r?.id) previousIds.add(r.id);
        }
        if (previousProfile.resume?.id) {
          previousIds.add(previousProfile.resume.id);
        }
        const currentIds = new Set<string>();
        if (cleanProfile.resumes && Array.isArray(cleanProfile.resumes)) {
          for (const r of cleanProfile.resumes) if (r?.id) currentIds.add(r.id);
        }
        if (cleanProfile.resume?.id) {
          currentIds.add(cleanProfile.resume.id);
        }
        const removedIds = Array.from(previousIds).filter(id => !currentIds.has(id));
        if (removedIds.length > 0) {
          await this.removeResumeFiles(removedIds);
        }
      }

      // 3. 写入去掉文件后的资料
      await chrome.storage.local.set({
        [STORAGE_KEYS.USER_PROFILE]: cleanProfile
      });
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
      const ids = new Set<string>();
      if (normalized.resumes) {
        for (const r of normalized.resumes) if (r?.id) ids.add(r.id);
      }
      if (normalized.resume && (normalized.resume as any).id) {
        ids.add((normalized.resume as any).id);
      }
      if (normalized.resume && !(normalized.resume as any).id) {
        ids.add(LEGACY_RESUME_ID);
      }
      const fileKeys = Array.from(ids).map(resumeFileKey);
      const fileRecords = fileKeys.length > 0 ? await chrome.storage.local.get(fileKeys) : {};
      const getFileData = (id?: string) => {
        if (!id) return undefined;
        const entry = fileRecords[resumeFileKey(id)] as ResumeFileRecord | string | undefined;
        if (!entry) return undefined;
        return typeof entry === 'string' ? entry : entry.fileData;
      };
      backupProfile = {
        ...normalized,
        resume: normalized.resume
          ? {
              ...normalized.resume,
              fileData: getFileData((normalized.resume as any).id) || getFileData(LEGACY_RESUME_ID) || (normalized.resume as any).fileData || '',
            }
          : undefined,
        resumes: normalized.resumes
          ? normalized.resumes.map(r => ({
              ...r,
              fileData: getFileData(r.id) || (r as any).fileData || '',
            }))
          : undefined,
      };
    }
    return {
      userProfile: backupProfile,
      settings: normalizeSettings((result[STORAGE_KEYS.SETTINGS] as SettingsData | undefined) || null),
      applicationRecords: (result[STORAGE_KEYS.LEGACY_APPLICATION_RECORDS] as BackupData['applicationRecords']) ?? [],
    };
  }

  static async replaceBusinessData(data: BackupData): Promise<void> {
    const filesToWrite: Record<string, ResumeFileRecord> = {};
    const validResumeIds = new Set<string>();
    let cleanProfile: UserProfile | null = null;

    if (data.userProfile) {
      const profileCopy = structuredClone(data.userProfile) as any;
      if (profileCopy.resumes && Array.isArray(profileCopy.resumes)) {
        for (let i = 0; i < profileCopy.resumes.length; i++) {
          const item = profileCopy.resumes[i];
          const id = item.id || `resume-${i + 1}`;
          item.id = id;
          validResumeIds.add(id);
          if (item.fileData) {
            if (!item.fileHash) item.fileHash = await computeFileHash(item.fileData);
            filesToWrite[resumeFileKey(id)] = { fileData: item.fileData };
            delete item.fileData;
          }
        }
      }
      if (profileCopy.resume) {
        const id = profileCopy.resume.id || LEGACY_RESUME_ID;
        validResumeIds.add(id);
        if (profileCopy.resume.fileData) {
          if (!profileCopy.resume.fileHash) profileCopy.resume.fileHash = await computeFileHash(profileCopy.resume.fileData);
          filesToWrite[resumeFileKey(id)] = { fileData: profileCopy.resume.fileData };
          delete profileCopy.resume.fileData;
        }
      }
      cleanProfile = profileCopy as UserProfile;
    }

    // 1. 写入顺序必须是先写文件
    if (Object.keys(filesToWrite).length > 0) {
      await chrome.storage.local.set(filesToWrite);
    }

    // 2. 清理旧的文件 key
    const allStored = await chrome.storage.local.get(null);
    const oldResumeKeys = Object.keys(allStored)
      .filter(k => k.startsWith(RESUME_FILE_KEY_PREFIX))
      .filter(k => !validResumeIds.has(resumeIdFromKey(k)));
    if (oldResumeKeys.length > 0) {
      await chrome.storage.local.remove(oldResumeKeys);
    }

    // 3. 再写业务资料
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
  }
}
