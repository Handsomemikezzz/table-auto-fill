import { recoverResumePublications } from '../parsers/researchPublications.ts';
import { bridgeFillPage } from './fillPageBridge.ts';
import { beginFillSession, endFillSession } from './fillSessions.ts';
import { createProfileSnapshot, saveConfirmedFact, savePersonalField } from '../autofill/profileSnapshot.ts';
import type {
  FocusedFieldWriteResult,
  Message,
  MessageResponse,
  UserProfile,
  ParsedResumeData,
} from '../shared/types.ts';
import { StorageService } from '../shared/storage.ts';
import {
  createBackupDocument,
  createBackupSummary,
  parseAndValidateBackup,
  serializeBackup,
} from '../shared/backup.ts';
import { parseResume, isStructuredType, parseStructuredResume } from '../parsers/index.ts';
import { NLPHelper } from '../utils/nlpHelper.ts';
import { ensureContentScriptForTab, initContentScriptListeners } from './contentScriptConnection.ts';
import {
  computeFileHash,
  createResumeProfileSnapshot,
  createResumeVariant,
  getResumeLibrary,
  upsertResumeVariant,
} from '../shared/resumes.ts';

// Background Service Worker 入口
console.log('Background service worker started');

initContentScriptListeners();

void StorageService.removeRetiredData().catch(error => {
  console.error('Failed to remove retired settings:', error);
});
// 迁移会改写 userProfile；消息处理需等它结束，避免并发保存被旧数据覆盖。
const storageReady = StorageService.migrateResumeFiles().catch(error => {
  console.error('Failed to migrate resume files:', error);
});

let personalFieldSaveQueue: Promise<unknown> = Promise.resolve();

// 监听消息
chrome.runtime.onMessage.addListener(
  (
    message: Message,
    sender: chrome.runtime.MessageSender,
    sendResponse: (response: MessageResponse) => void
  ) => {
    // 处理异步消息
    storageReady
      .then(() => handleMessage(message, sender))
      .then(sendResponse)
      .catch((error) => {
        console.error('Message handler error:', error);
        sendResponse({
          success: false,
          error: error instanceof Error ? error.message : 'Unknown error'
        });
      });

    // 返回 true 表示异步响应
    return true;
  }
);

// 处理消息
export async function handleMessage(
  message: Message,
  sender: chrome.runtime.MessageSender
): Promise<MessageResponse> {
  switch (message.type) {
    case 'FILL_PAGE_BRIDGE':
      return { success: true, data: await bridgeFillPage(message.payload, sender) };
    case 'BEGIN_FILL_SESSION':
      return { success: true, data: await beginFillSession(message.payload, sender) };
    case 'END_FILL_SESSION':
      endFillSession(message.payload.sessionId, sender);
      return { success: true };
    case 'SAVE_PERSONAL_FIELD': {
      const result = personalFieldSaveQueue.then(async () => {
        const profile = await StorageService.getUserProfile();
        if (!profile) return { success: false, error: '请先保存个人资料' };
        const updated = savePersonalField(profile, message.payload);
        const result = await handleSaveUserProfile(updated);
        return result.success ? { success: true, data: { profileVersion: createProfileSnapshot(updated).version } } : result;
      });
      personalFieldSaveQueue = result.catch(() => {});
      return result;
    }
    case 'SAVE_ADDITIONAL_FACT': {
      const profile = await StorageService.getUserProfile();
      if (!profile || createProfileSnapshot(profile).version !== message.payload.profileVersion) return { success: false, error: '资料已更新，请重新打开资料后保存' };
      const fact = message.payload.fact;
      if (!fact.id || !fact.label.trim() || !fact.value.trim() || !fact.subject.trim() || !fact.meaningId || !['text', 'date'].includes(fact.valueType)) return { success: false, error: '请确认含义、主体和答案' };
      return handleSaveUserProfile(saveConfirmedFact(profile, fact));
    }
    case 'OPEN_PROFILE_SETTINGS':
      await chrome.runtime.openOptionsPage();
      return { success: true };
    case 'GET_USER_PROFILE':
      return await handleGetUserProfile();

    case 'SAVE_USER_PROFILE':
      return await handleSaveUserProfile(message.payload);

    case 'CANCEL_RESUME_IMPORT': {
      const request = resumeImportRequests.get(message.payload.requestId);
      if (request?.owner === importOwner(sender)) request.controller.abort();
      return { success: true };
    }
    case 'PARSE_RESUME':
      return await handleParseResume(
        message.payload.file,
        message.payload.fileType,
        message.payload.fileName,
        message.payload.category,
        message.payload.rawText,
        message.payload.requestId,
        sender
      );

    case 'WRITE_FOCUSED_FIELD_FROM_PAGE':
      return sender.tab?.id
        ? await handleWriteFocusedField(sender.tab.id, message.payload.value)
        : { success: true, data: { written: false, reason: 'NO_ACTIVE_TAB' } };

    case 'ENSURE_CONTENT_SCRIPT':
      return await ensureContentScriptForTab(message.payload.tabId);

    case 'EXPORT_BACKUP':
      return await handleExportBackup();

    case 'PREVIEW_BACKUP_IMPORT':
      return handlePreviewBackup(message.payload.json);

    case 'IMPORT_BACKUP':
      return await handleImportBackup(message.payload.json);

    default:
      return {
        success: false,
        error: 'Unknown message type'
      };
  }
}

async function handleWriteFocusedField(
  tabId: number,
  value: string
): Promise<MessageResponse<FocusedFieldWriteResult>> {
  try {
    const tab = await chrome.tabs.get(tabId);
    if (!tab.id) {
      return { success: true, data: { written: false, reason: 'NO_ACTIVE_TAB' } };
    }

    const url = tab.url || '';
    if (isRestrictedPage(url)) {
      return { success: true, data: { written: false, reason: 'RESTRICTED_PAGE' } };
    }

    const frames = typeof chrome.webNavigation?.getAllFrames === 'function'
      ? (await chrome.webNavigation.getAllFrames({ tabId })) || []
      : [];
    const frameIds = frames.length > 0 ? frames.map(frame => frame.frameId) : [0];
    let fallback: MessageResponse<FocusedFieldWriteResult> | null = null;
    for (const frameId of frameIds) {
      try {
        const response = await chrome.tabs.sendMessage(tabId, {
          type: 'APPLY_FOCUSED_FIELD',
          payload: { value },
        } satisfies Message, { frameId }) as MessageResponse<FocusedFieldWriteResult>;
        fallback ||= response;
        if (response.success && response.data?.written) return response;
      } catch {
        // Continue: the focused control may live in another frame.
      }
    }
    return fallback || { success: true, data: { written: false, reason: 'NO_FOCUSED_FIELD' } };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const reason = /Receiving end does not exist|Could not establish connection/i.test(message)
      ? 'NO_CONTENT_SCRIPT'
      : 'NO_ACTIVE_TAB';
    return { success: true, data: { written: false, reason } };
  }
}

function isRestrictedPage(url: string): boolean {
  return (
    /^(chrome|edge|about|chrome-extension|edge-extension):\/\//i.test(url) ||
    /^https:\/\/chromewebstore\.google\.com\//i.test(url) ||
    /^https:\/\/microsoftedge\.microsoft\.com\/addons\//i.test(url)
  );
}

// 获取用户资料
async function handleGetUserProfile(): Promise<MessageResponse<UserProfile>> {
  try {
    const storedProfile = await StorageService.getUserProfile();
    const profile = storedProfile;
    return {
      success: true,
      data: profile || undefined
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Failed to get user profile'
    };
  }
}

// 保存用户资料
async function handleSaveUserProfile(
  profile: UserProfile
): Promise<MessageResponse> {
  try {
    const success = await StorageService.saveUserProfile(profile);
    return {
      success,
      data: success ? { localSaved: true } : undefined,
      error: success ? undefined : 'Failed to save user profile'
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Failed to save user profile'
    };
  }
}

const resumeImportRequests = new Map<string, { controller: AbortController; owner: string }>();
const importOwner = (sender: chrome.runtime.MessageSender) => `${sender.id}:${sender.url || ''}:${sender.tab?.id || ''}`;
// 解析简历
async function handleParseResume(
  fileData: string,
  fileType: string,
  fileName: string,
  category?: string,
  preParsedText?: string,
  requestId?: string,
  sender: chrome.runtime.MessageSender = {},
): Promise<MessageResponse> {
  const requestController = new AbortController();
  if (requestId) {
    if (resumeImportRequests.has(requestId)) return { success: false, error: '这份简历正在识别中' };
    resumeImportRequests.set(requestId, { controller: requestController, owner: importOwner(sender) });
  }
  const assertActive = () => { if (requestController.signal.aborted) throw new Error('已停止简历识别'); };
  let unsavedResumeId: string | undefined;
  try {
    const rawText = preParsedText ?? await parseResume(fileData, fileType);

    assertActive();
    if (!rawText.trim()) throw new Error('没有识别到文字，请上传更清晰的图片或可读取的简历');
    let parsedData: ParsedResumeData;
    let parseMethod: 'structured' | 'regex' = 'regex';

    if (isStructuredType(fileType)) {
      // JSON 简历直接映射；其他格式使用本地规则整理。
      parsedData = parseStructuredResume(rawText);
      parseMethod = 'structured';
    } else {
      parsedData = NLPHelper.parseResumeText(rawText);
    }

    assertActive();
    if (parseMethod !== 'structured') parsedData = recoverResumePublications(parsedData, rawText);
    const currentProfile = await StorageService.getUserProfile();
    assertActive();

    const fileHash = await computeFileHash(fileData);
    const currentLibrary = getResumeLibrary(currentProfile || {});
    const existing = currentLibrary.find(item => item.fileName === fileName && item.fileHash === fileHash);
    const resumeId = existing?.id || `resume-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;
    await StorageService.saveResumeFile(resumeId, fileData);
    if (!existing) unsavedResumeId = resumeId;

    const resume = createResumeVariant({
      fileName,
      fileHash,
      fileType,
      parsedText: rawText,
      uploadDate: new Date().toISOString(),
    }, {
      id: resumeId,
      category,
      parsedProfile: createResumeProfileSnapshot(parsedData),
    });
    const baseProfile: UserProfile = currentProfile || {
      personal: {} as UserProfile['personal'],
      education: [],
      experience: [],
      projects: [],
      customInformation: [],
      skills: [],
      certifications: [],
    };
    const updatedProfile: UserProfile = {
      ...baseProfile,
      // resume 继续保留为旧版本兼容入口，但不再随每次新增而改写。
      resume: baseProfile.resume || resume,
      resumes: upsertResumeVariant(currentLibrary, resume),
    };

    assertActive();
    const saved = await StorageService.saveUserProfile(updatedProfile);
    if (!saved) {
      return { success: false, error: '简历已解析，但保存个人信息失败' };
    }
    unsavedResumeId = undefined;

    return {
      success: true,
      data: {
        parsedData,
        resumeId: resume.id,
        rawText,
        parseMethod
      }
    };
  } catch (error) {
    console.error('Resume parsing error:', error);
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Failed to parse resume'
    };
  } finally {
    if (requestId) resumeImportRequests.delete(requestId);
    // 资料没有保存成功时，新写入的文件无人引用，立即删除。
    if (unsavedResumeId) await StorageService.removeResumeFiles([unsavedResumeId]).catch(() => {});
  }
}

function backupFilename(date = new Date()): string {
  const compact = date.toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
  return `fill-ease-backup-${compact}.json`;
}

async function handleExportBackup(): Promise<MessageResponse> {
  const data = await StorageService.getBackupData();
  const document = createBackupDocument(
    data,
    chrome.runtime.getManifest().version,
  );
  return {
    success: true,
    data: {
      json: serializeBackup(document),
      filename: backupFilename(),
    },
  };
}

function handlePreviewBackup(json: string): MessageResponse {
  const parsed = parseAndValidateBackup(json);
  if (!parsed.success) {
    return { success: false, error: `${parsed.error.code}: ${parsed.error.message}` };
  }
  return { success: true, data: createBackupSummary(parsed.document) };
}

async function handleImportBackup(json: string): Promise<MessageResponse> {
  const parsed = parseAndValidateBackup(json);
  if (!parsed.success) {
    return { success: false, error: `${parsed.error.code}: ${parsed.error.message}` };
  }
  await StorageService.replaceBusinessData(parsed.document.data);
  return {
    success: true,
    data: { imported: true, summary: createBackupSummary(parsed.document) },
  };
}

chrome.runtime.onInstalled.addListener((details) => {
  console.log('Extension installed:', details.reason);

  if (details.reason === 'install') {
    // 首次安装时打开选项页面
    chrome.runtime.openOptionsPage();
  }
});
