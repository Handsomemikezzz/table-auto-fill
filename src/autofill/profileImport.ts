import { PROFILE_RECORD_COLLECTIONS, PROFILE_RECORD_SECTIONS } from '../shared/profileCollections.ts';
import type { ParsedResumeData, UserProfile } from '../shared/types.ts';
import { createResumeProfileSnapshot } from '../shared/resumes.ts';
import { versionOf } from './contracts.ts';

export interface ProfileImportChange { key: string; label: string; before: unknown; after: unknown; selected: boolean }
export function createProfileImportDraft(profile: UserProfile, parsed: ParsedResumeData): ProfileImportChange[] {
  const snapshot = createResumeProfileSnapshot(parsed);
  const changes: ProfileImportChange[] = [];
  for (const [key, value] of Object.entries(snapshot.personal)) {
    if (typeof value !== 'string' || !value.trim()) continue;
    const before = profile.personal[key as keyof typeof profile.personal] || '';
    if (before !== value) changes.push({ key: `personal.${key}`, label: key, before, after: value, selected: !before });
  }
  for (const [key, label] of [...PROFILE_RECORD_COLLECTIONS.map(key => [key, PROFILE_RECORD_SECTIONS[key].label] as const), ['skills', '技能'] as const]) {
    if (!snapshot[key]?.length || versionOf(profile[key] || []) === versionOf(snapshot[key])) continue;
    changes.push({ key, label, before: profile[key] || [], after: snapshot[key], selected: !profile[key]?.length });
  }
  return changes;
}
export function applyProfileImportDraft(profile: UserProfile, changes: ProfileImportChange[]): UserProfile {
  const result = structuredClone(profile);
  for (const change of changes.filter(change => change.selected)) {
    const key = change.key.split('.')[1] as keyof UserProfile['personal'];
    const previous = key ? result.personal[key] || '' : result[change.key as keyof UserProfile] || [];
    if (versionOf(previous) !== versionOf(change.before)) throw new Error('资料已被修改，请重新生成更新草稿');
    if (key && change.key.startsWith('personal.') && typeof change.after === 'string') Object.assign(result.personal, { [key]: change.after });
    else if ([...PROFILE_RECORD_COLLECTIONS, 'skills'].includes(change.key as typeof PROFILE_RECORD_COLLECTIONS[number]) && Array.isArray(change.after)) Object.assign(result, { [change.key]: change.after });
  }
  return result;
}
