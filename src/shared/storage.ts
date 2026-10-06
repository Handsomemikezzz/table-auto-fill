import { normalizeSupplementalRecords } from './profileCollections.ts';
import { getPersonalAdditionalFields } from './personalFields.ts';
import type {
  BackupData,
  SettingsData,
  UserProfile,
} from './types';
import type { LLMConfig } from '../services/llm/types';
import { normalizeResumeLibrary } from './resumes.ts';
import { normalizeBirthDateValue, normalizePoliticalStatusValue } from './personal.ts';

export const STORAGE_KEYS = {
  USER_PROFILE: 'userProfile',
  SETTINGS: 'settings',
  LLM_CONFIG: 'llmConfig',
  // Keep the retired key for non-destructive legacy backup compatibility.
  LEGACY_APPLICATION_RECORDS: 'applicationRecords',
} as const;

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

export class StorageService {
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
      await chrome.storage.local.set({
        [STORAGE_KEYS.USER_PROFILE]: profile
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

  // 获取 LLM 配置
  static async getLLMConfig(): Promise<LLMConfig | null> {
    try {
      const result = await chrome.storage.local.get(STORAGE_KEYS.LLM_CONFIG);
      return (result[STORAGE_KEYS.LLM_CONFIG] as LLMConfig) || null;
    } catch {
      return null;
    }
  }

  // 保存 LLM 配置
  static async saveLLMConfig(config: LLMConfig): Promise<boolean> {
    try {
      await chrome.storage.local.set({
        [STORAGE_KEYS.LLM_CONFIG]: config,
      });
      return true;
    } catch {
      return false;
    }
  }

  static async getSettings(): Promise<SettingsData | null> {
    const result = await chrome.storage.local.get(STORAGE_KEYS.SETTINGS);
    return (result[STORAGE_KEYS.SETTINGS] as SettingsData) || null;
  }

  static async saveSettings(settings: SettingsData): Promise<void> {
    await chrome.storage.local.set({ [STORAGE_KEYS.SETTINGS]: settings });
  }

  static async getBackupData(): Promise<BackupData> {
    const result = await chrome.storage.local.get([
      STORAGE_KEYS.USER_PROFILE,
      STORAGE_KEYS.LLM_CONFIG,
      STORAGE_KEYS.SETTINGS,
      STORAGE_KEYS.LEGACY_APPLICATION_RECORDS,
    ]);
    const profile = (result[STORAGE_KEYS.USER_PROFILE] as UserProfile | undefined) || null;
    return {
      userProfile: profile ? normalizeUserProfile(profile) : null,
      llmConfig: (result[STORAGE_KEYS.LLM_CONFIG] as LLMConfig | undefined) || null,
      settings: (result[STORAGE_KEYS.SETTINGS] as SettingsData | undefined) || null,
      applicationRecords: (result[STORAGE_KEYS.LEGACY_APPLICATION_RECORDS] as BackupData['applicationRecords']) ?? [],
    };
  }

  static async replaceBusinessData(data: BackupData): Promise<void> {
    const values: Record<string, unknown> = {};
    const removals: string[] = [];
    const entries = [
      [STORAGE_KEYS.USER_PROFILE, data.userProfile],
      [STORAGE_KEYS.LLM_CONFIG, data.llmConfig],
      [STORAGE_KEYS.SETTINGS, data.settings],
    ] as const;

    for (const [key, value] of entries) {
      if (value === null) removals.push(key);
      else values[key] = value;
    }

    if (Object.hasOwn(data, 'applicationRecords')) {
      if (data.applicationRecords === null) removals.push(STORAGE_KEYS.LEGACY_APPLICATION_RECORDS);
      else values[STORAGE_KEYS.LEGACY_APPLICATION_RECORDS] = data.applicationRecords;
    }

    if (Object.keys(values).length > 0) await chrome.storage.local.set(values);
    if (removals.length > 0) await chrome.storage.local.remove(removals);
  }
}
