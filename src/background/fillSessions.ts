import { getResumeLibrary } from '../shared/resumes.ts';
import { versionOf } from '../autofill/contracts.ts';
import { StorageService } from '../shared/storage.ts';
import { createProfileSnapshot } from '../autofill/profileSnapshot.ts';
import { createFieldRegistry, registryVersion } from '../autofill/fieldRegistry.ts';
import { LLMDecisionProvider } from '../autofill/decisionProvider.ts';
import type { ControlExperience, FillContextData, MeaningCorrection, FieldObservation, DecisionProvider } from '../autofill/contracts.ts';
import { validateModule } from '../autofill/decisionValidation.ts';

type Session = FillContextData & { origin: string; owner: string; provider: DecisionProvider; controller: AbortController; createdAt: number; baseProfileVersion: string; attachmentId?: string; attachmentVersion?: string };
const sessions = new Map<string, Session>();
const CORRECTIONS_KEY = 'meaningCorrectionsV1';
const EXPERIENCES_KEY = 'controlExperiencesV1';
const ownerOf = (sender: chrome.runtime.MessageSender) => `${sender.tab?.id ?? 'extension'}:${sender.frameId ?? 0}`;
export async function getCorrections(): Promise<MeaningCorrection[]> {
  const settings = await StorageService.getSettings();
  return Array.isArray(settings?.[CORRECTIONS_KEY]) ? settings[CORRECTIONS_KEY] as MeaningCorrection[] : [];
}
export async function changeCorrection(change: { id: string; enabled?: boolean; remove?: boolean } | MeaningCorrection) {
  const settings = await StorageService.getSettings() || {};
  const existing = await getCorrections();
  const next = 'meaningId' in change ? [...existing.filter(item => item.id !== change.id), change]
    : existing.filter(item => !change.remove || item.id !== change.id).map(item => item.id === change.id && change.enabled !== undefined ? { ...item, enabled: change.enabled } : item);
  await StorageService.saveSettings({ ...settings, [CORRECTIONS_KEY]: next });
}
export async function beginFillSession(payload: { sessionId: string; sourceId: string; origin: string; attachmentId?: string | null }, sender: chrome.runtime.MessageSender): Promise<FillContextData> {
  for (const [id, session] of sessions) if (Date.now() - session.createdAt > 30 * 60_000 || session.owner === ownerOf(sender)) { session.controller.abort(); sessions.delete(id); }
  const [profile, config] = await Promise.all([StorageService.getUserProfile(), StorageService.getLLMConfig()]);
  if (!profile) throw new Error('请先保存个人资料');
  if (!config?.baseUrl?.trim() || !config.model?.trim()) throw new Error('暂时无法连接填写服务，请在设置中配置模型连接');
  const registry = createFieldRegistry(profile.additionalFacts);
  const snapshot = createProfileSnapshot(profile, payload.sourceId, registry);
  for (const fact of snapshot.facts.filter(fact => fact.meaningId.startsWith('saved.'))) registry.push({ id: fact.meaningId, label: fact.source.replace('已保存答案：', ''), subject: fact.subject, valueType: 'text', sourceCollection: 'customInformation', key: fact.id, aliases: [], allowedTransformations: [], scope: 'user', version: 1, provenance: 'user-saved' });
  const baseProfileVersion = snapshot.version;
  const attachment = payload.attachmentId ? getResumeLibrary(profile).find(item => item.id === payload.attachmentId) : undefined;
  if (payload.attachmentId && !attachment) throw new Error('所选附件已不存在');
  if (attachment) {
    registry.push({ id: 'attachment.resumeFile', label: '简历附件', subject: 'self', valueType: 'text', sourceCollection: 'attachment', key: 'resumeFile', aliases: ['简历', 'resume', 'CV'], allowedTransformations: [], scope: 'builtin', version: 1, provenance: 'user-selected-file' });
    snapshot.facts.push({ id: `attachment:${attachment.id}`, meaningId: 'attachment.resumeFile', subject: 'self', value: attachment.fileName, source: '用户本次选择的附件' });
    snapshot.version = versionOf({ baseProfileVersion, attachment: { id: attachment.id, fileName: attachment.fileName, uploadDate: attachment.uploadDate } });
  }
  const context = { sessionId: payload.sessionId, saveProfileVersion: baseProfileVersion, profile: snapshot, registry, registryVersion: registryVersion(registry) };
  const origin = sender.url ? new URL(sender.url).origin : payload.origin;
  sessions.set(payload.sessionId, { ...context, origin, owner: ownerOf(sender), provider: new LLMDecisionProvider(config), controller: new AbortController(), createdAt: Date.now(), baseProfileVersion, attachmentId: attachment?.id, attachmentVersion: attachment ? versionOf(attachment.fileData) : undefined });
  return context;
}
export async function decideFillFields(payload: { sessionId: string; fields: FieldObservation[]; corrections?: MeaningCorrection[] }, sender: chrome.runtime.MessageSender) {
  const session = sessions.get(payload.sessionId);
  if (!session || session.owner !== ownerOf(sender) || session.controller.signal.aborted) throw new Error('填写会话已停止，请重新开始');
  if (!payload.fields.length || payload.fields.length > 100) throw new Error('字段批次大小无效');
  const currentProfile = await StorageService.getUserProfile();
  if (!currentProfile || createProfileSnapshot(currentProfile, session.profile.sourceId, session.registry).version !== session.baseProfileVersion) throw new Error('资料已更新，请重新开始填写');
  const corrections = [...await getCorrections(), ...(payload.corrections || [])].filter(item => item.enabled && item.confirmedAt && payload.fields.some(field => (field.origin || session.origin) === item.origin && field.signature === item.signature) && item.profileVersion === session.profile.version && item.registryVersion === session.registryVersion && payload.fields.some(field => field.signature === item.signature));
  const executionEvidence = (await getExperiences()).filter(item => item.enabled && payload.fields.some(field => (field.origin || session.origin) === item.origin && field.signature === item.signature) && item.profileVersion === session.profile.version && item.registryVersion === session.registryVersion && payload.fields.some(field => field.signature === item.signature));
  const request = { executionEvidence, fields: payload.fields, profile: session.profile, registry: session.registry, registryVersion: session.registryVersion, corrections };
  if (session.controller.signal.aborted) throw new Error('填写已停止');
  const controller = new AbortController();
  const cancel = () => controller.abort();
  session.controller.signal.addEventListener('abort', cancel, { once: true });
  const timeout = setTimeout(cancel, 45_000);
  try {
    const decisions = await session.provider.decide(request, controller.signal);
    if (controller.signal.aborted || session.controller.signal.aborted) throw new Error('填写已停止或服务超时');
    const latestProfile = await StorageService.getUserProfile();
    if (!latestProfile || createProfileSnapshot(latestProfile, session.profile.sourceId, session.registry).version !== session.baseProfileVersion) throw new Error('资料已更新，请重新开始填写');
    if (session.controller.signal.aborted) throw new Error('填写已停止');
    // Local validation is repeated in the page immediately before each operation.
    const errors = validateModule(decisions, request);
    return decisions.map(decision => errors.has(decision.fieldId) ? { ...decision, nextAction: 'requestMeaning' as const, uncertaintyReason: errors.get(decision.fieldId) } : decision);
  } catch (error) {
    if (session.controller.signal.aborted) throw new Error('填写已停止');
    throw new Error(`暂时无法连接填写服务：${error instanceof Error ? error.message : '请求失败'}`);
  } finally { clearTimeout(timeout); session.controller.signal.removeEventListener('abort', cancel); }
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
  if (!attachment || versionOf(attachment.fileData) !== session.attachmentVersion || attachment.fileName !== session.profile.facts.find(fact => fact.id === factId)?.value) throw new Error('附件已变化');
  return attachment;
}

export async function getExperiences(): Promise<ControlExperience[]> {
  const settings = await StorageService.getSettings();
  return Array.isArray(settings?.[EXPERIENCES_KEY]) ? settings[EXPERIENCES_KEY] as ControlExperience[] : [];
}
export async function saveExperiences(incoming: ControlExperience[]) {
  const settings = await StorageService.getSettings() || {};
  const next = new Map((await getExperiences()).map(item => [item.id, item]));
  for (const item of incoming) {
    const previous = next.get(item.id);
    next.set(item.id, { ...item, enabled: previous?.enabled ?? item.enabled });
  }
  await StorageService.saveSettings({ ...settings, [EXPERIENCES_KEY]: [...next.values()].slice(-500) });
}
export async function changeExperience(change: { id: string; enabled?: boolean; remove?: boolean }) {
  const settings = await StorageService.getSettings() || {};
  const next = (await getExperiences()).filter(item => !change.remove || item.id !== change.id).map(item => item.id === change.id && change.enabled !== undefined ? { ...item, enabled: change.enabled } : item);
  await StorageService.saveSettings({ ...settings, [EXPERIENCES_KEY]: next });
}

export async function isPageOrigin(origin: string, sender: chrome.runtime.MessageSender): Promise<boolean> {
  if (sender.url && new URL(sender.url).origin === origin) return true;
  if (sender.tab?.id === undefined) return false;
  const frames = await chrome.webNavigation.getAllFrames({ tabId: sender.tab.id }) || [];
  return frames.some(frame => { try { return new URL(frame.url).origin === origin; } catch { return false; } });
}
