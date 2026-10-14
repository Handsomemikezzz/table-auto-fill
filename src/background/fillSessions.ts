import { getPersonalAdditionalFields } from '../shared/personalFields.ts';
import { getResumeLibrary } from '../shared/resumes.ts';
import { versionOf } from '../autofill/contracts.ts';
import { StorageService } from '../shared/storage.ts';
import { createProfileSnapshot } from '../autofill/profileSnapshot.ts';
import { createFieldRegistry, registryVersion } from '../autofill/fieldRegistry.ts';
import type { FillContextData } from '../autofill/contracts.ts';

type Session = FillContextData & { origin: string; owner: string; controller: AbortController; createdAt: number; baseProfileVersion: string; attachmentId?: string; attachmentVersion?: string };
const sessions = new Map<string, Session>();
const ownerOf = (sender: chrome.runtime.MessageSender) => `${sender.tab?.id ?? 'extension'}:${sender.frameId ?? 0}`;
export async function beginFillSession(payload: { sessionId: string; sourceId: string; origin: string; attachmentId?: string | null }, sender: chrome.runtime.MessageSender): Promise<FillContextData> {
  for (const [id, session] of sessions) if (Date.now() - session.createdAt > 30 * 60_000 || session.owner === ownerOf(sender)) { session.controller.abort(); sessions.delete(id); }
  const profile = await StorageService.getUserProfile();
  if (!profile) throw new Error('请先保存个人资料');
  const registry = createFieldRegistry(getPersonalAdditionalFields(profile));
  const snapshot = createProfileSnapshot(profile, payload.sourceId, registry);
  for (const fact of snapshot.facts.filter(fact => fact.meaningId.startsWith('saved.'))) registry.push({ id: fact.meaningId, label: fact.source.replace('已保存答案：', ''), subject: fact.subject, valueType: 'text', sourceCollection: 'customInformation', key: fact.id, aliases: [], scope: 'user', version: 1, provenance: 'user-saved' });
  const baseProfileVersion = snapshot.version;
  const attachment = payload.attachmentId ? getResumeLibrary(profile).find(item => item.id === payload.attachmentId) : undefined;
  if (payload.attachmentId && !attachment) throw new Error('所选附件已不存在');
  if (attachment) {
    registry.push({ id: 'attachment.resumeFile', label: '简历附件', subject: 'self', valueType: 'text', sourceCollection: 'attachment', key: 'resumeFile', aliases: ['简历', 'resume', 'CV'], scope: 'builtin', version: 1, provenance: 'user-selected-file' });
    snapshot.facts.push({ id: `attachment:${attachment.id}`, meaningId: 'attachment.resumeFile', subject: 'self', value: attachment.fileName, source: '用户本次选择的附件' });
    snapshot.version = versionOf({ baseProfileVersion, attachment: { id: attachment.id, fileName: attachment.fileName, uploadDate: attachment.uploadDate } });
  }
  const context = { sessionId: payload.sessionId, corrections: [], saveProfileVersion: baseProfileVersion, profile: snapshot, registry, registryVersion: registryVersion(registry) };
  const origin = sender.url ? new URL(sender.url).origin : payload.origin;
  sessions.set(payload.sessionId, { ...context, origin, owner: ownerOf(sender), controller: new AbortController(), createdAt: Date.now(), baseProfileVersion, attachmentId: attachment?.id, attachmentVersion: attachment?.fileHash });
  return context;
}
export function endFillSession(id: string, sender: chrome.runtime.MessageSender) {
  const session = sessions.get(id);
  if (session?.owner === ownerOf(sender)) { session.controller.abort(); sessions.delete(id); }
}

export async function getSessionAttachment(sessionId: string, factId: string, sender: chrome.runtime.MessageSender) {
  const session = sessions.get(sessionId);
  if (!session || session.owner !== ownerOf(sender) || session.controller.signal.aborted || !session.attachmentId || factId !== `attachment:${session.attachmentId}`) throw new Error('附件选择已失效');
  const profile = await StorageService.getUserProfile();
  const attachment = profile && getResumeLibrary(profile).find(item => item.id === session.attachmentId);
  if (!attachment || attachment.fileHash !== session.attachmentVersion || attachment.fileName !== session.profile.facts.find(fact => fact.id === factId)?.value) throw new Error('附件已变化');
  const fileData = await StorageService.getResumeFile(attachment.id);
  if (!fileData) throw new Error('附件文件已丢失');
  return { ...attachment, fileData };
}
