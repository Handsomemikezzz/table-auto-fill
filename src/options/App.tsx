import { SupplementalProfileSection } from './SupplementalProfileSection.tsx';
import { PROFILE_RECORD_SECTIONS, SUPPLEMENTAL_COLLECTIONS } from '../shared/profileCollections.ts';
import { ResumeImportProgress, type ImportProgress } from './ResumeImportProgress.tsx';
import { extractResumeFile } from '../parsers/extractResumeFile.ts';
import { RESUME_FILE_TYPES, type ResumeExtraction } from '../parsers/resumeExtraction.ts';
import { mergeReviewedProfile } from '../autofill/resumeReview.ts';
import { createResumeProfileSnapshot } from '../shared/resumes.ts';
import { AdditionalFactsSection } from './AdditionalFactsSection.tsx';
import { getPersonalAdditionalFields, PERSONAL_EXTRA_FIELDS } from '../shared/personalFields.ts';
import { ProfileImportDraft } from './ProfileImportDraft.tsx';
import { applyProfileImportDraft, type ProfileImportChange } from '../autofill/profileImport.ts';
import React, { useState, useEffect, useRef } from 'react';
import { MessageService } from '../shared/message';
import type {
  UserProfile,
  PersonalInfo,
  CustomInformation,
  ParsedResumeData,
} from '../shared/types';
import { AISettings } from './AISettings';
import { EducationSection } from './EducationSection';
import { ExperienceSection } from './ExperienceSection';
import { DataSyncSettings } from './DataSyncSettings';
import { removeResumeVariant } from '../shared/resumes.ts';

interface ImportReviewState {
  parsedData: ParsedResumeData;
  fileName: string;
  requestId: string;
  resumeId?: string;
  baseProfile: UserProfile;
  extraction: ResumeExtraction;
  draft?: UserProfile;
  open: boolean;
}

const OPTION_TABS = [
  'personal',
  'education',
  'experience',
  'more',
  'custom',
  'resume',
  'ai',
  'data-sync',
] as const;

type OptionTab = typeof OPTION_TABS[number];

function getInitialActiveTab(search: string): OptionTab {
  const tab = new URLSearchParams(search).get('tab');
  return OPTION_TABS.includes(tab as OptionTab) ? tab as OptionTab : 'personal';
}

function hasChromeApis(): boolean {
  return typeof chrome !== 'undefined'
    && typeof chrome.storage !== 'undefined'
    && typeof chrome.runtime !== 'undefined';
}

/** MIME 类型到扩展名的兜底映射，用于文件名缺少扩展名的情况 */
const MIME_TO_EXT: Record<string, string> = {
  'application/json': 'json',
  'application/pdf': 'pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
  'application/msword': 'doc',
  'text/markdown': 'md',
  'text/plain': 'txt',
  'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp',
};
/**
 * 解析上传文件的类型。优先取文件名扩展名；
 * 文件名无扩展名（或含多个点导致误判）时回退到 MIME 类型。
 */
function resolveFileType(file: File): string {
  const name = file.name.trim();
  const dotIndex = name.lastIndexOf('.');
  const ext = dotIndex > 0 ? name.slice(dotIndex + 1).toLowerCase() : '';

  const known = RESUME_FILE_TYPES;
  if (known.includes(ext)) return ext;

  return MIME_TO_EXT[file.type] || ext;
}

/**
 * 汇总本次实际提取到的内容，用于上传后的提示。
 * 解析请求成功不代表提取到了字段，提示需要如实反映结果。
 */
function summarizeParsed(data: ParsedResumeData | undefined): string {
  if (!data) return '';

  const personalCount = Object.values(data.personal || {})
    .filter(value => typeof value === 'string' && value.trim()).length;

  const parts: string[] = [];
  if (personalCount > 0) parts.push(`个人信息 ${personalCount} 项`);
  if (data.education?.length) parts.push(`教育经历 ${data.education.length} 条`);
  if (data.experience?.length) parts.push(`工作/实习经历 ${data.experience.length} 条`);
  if (data.projects?.length) parts.push(`项目经历 ${data.projects.length} 条`);
  if (data.skills?.length) parts.push(`技能 ${data.skills.length} 项`);
  for (const collection of SUPPLEMENTAL_COLLECTIONS) if (data[collection]?.length) parts.push(`${PROFILE_RECORD_SECTIONS[collection].label} ${data[collection]!.length} 条`);

  return parts.join('、');
}

function resizeAutoGrowTextarea(element: HTMLTextAreaElement): void {
  const singleLineHeight = 39;
  element.style.height = 'auto';
  element.style.height = `${Math.max(singleLineHeight, element.scrollHeight)}px`;
}

function App() {
  const globalFileInputRef = useRef<HTMLInputElement>(null);
  const [importReviewData, setImportReviewData] = useState<ImportReviewState | null>(null);
  const [importDraft, setImportDraft] = useState<ProfileImportChange[] | null>(null);
  const [profile, setProfile] = useState<UserProfile>({
    personal: {} as PersonalInfo,
    education: [],
    experience: [],
    projects: [],
    customInformation: [],
    skills: [],
    certifications: []
  });
  const [loading, setLoading] = useState(hasChromeApis());
  const [saving, setSaving] = useState(false);
  const [activeTab, setActiveTab] = useState<OptionTab>(() => {
    if (typeof window === 'undefined') {
      return 'personal';
    }

    return getInitialActiveTab(window.location.search);
  });
  const [dataRevision, setDataRevision] = useState(0);
  const [parsingResume, setParsingResume] = useState(false);
  const [importProgress, setImportProgress] = useState<ImportProgress | null>(null);
  const uploadRef = useRef<{ requestId: string; controller: AbortController } | null>(null);
  const lastUploadRef = useRef<File | null>(null);
  const profileRef = useRef(profile); profileRef.current = profile;
  useEffect(() => () => { uploadRef.current?.controller.abort(); if (uploadRef.current) void MessageService.sendMessage({ type: 'CANCEL_RESUME_IMPORT', payload: { requestId: uploadRef.current.requestId } }); }, []);
  const [resumeCategory, setResumeCategory] = useState('');
  const [resumeNotice, setResumeNotice] = useState<{
    type: 'info' | 'success' | 'warning' | 'error';
    text: string;
  } | null>(null);
  const [saveNotice, setSaveNotice] = useState<{
    type: 'success' | 'error';
    text: string;
  } | null>(null);

  useEffect(() => {
    if (!saveNotice) return;
    const timer = window.setTimeout(() => setSaveNotice(null), 2400);
    return () => window.clearTimeout(timer);
  }, [saveNotice]);

  useEffect(() => {
    if (!hasChromeApis()) {
      setLoading(false);
      return;
    }

    void loadProfile();
    const handleStorageChange = (
      changes: Record<string, chrome.storage.StorageChange>,
      areaName: string,
    ) => {
      if (areaName === 'local' && changes.userProfile) {
        void loadProfile();
        setDataRevision(revision => revision + 1);
      }
    };
    chrome.storage.onChanged.addListener(handleStorageChange);
    return () => chrome.storage.onChanged.removeListener(handleStorageChange);
  }, []);

  const loadProfile = async () => {
    if (!hasChromeApis()) {
      setLoading(false);
      return;
    }

    try {
      const response = await MessageService.sendMessage<UserProfile>({
        type: 'GET_USER_PROFILE'
      });

      if (response.success && response.data) {
        setProfile(response.data);
      } else if (response.success) {
        setProfile({
          personal: {} as PersonalInfo,
          education: [],
          experience: [],
          projects: [],
          customInformation: [],
          skills: [],
          certifications: [],
        });
      }
    } catch (error) {
      console.error('Failed to load profile:', error);
    } finally {
      setLoading(false);
    }
  };

  const handleExternalDataChange = () => {
    void loadProfile();
    setDataRevision(revision => revision + 1);
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      const response = await MessageService.sendMessage({
        type: 'SAVE_USER_PROFILE',
        payload: profile
      });

      if (response.success) {
        setSaveNotice({ type: 'success', text: '保存成功' });
      } else {
        setSaveNotice({
          type: 'error',
          text: `保存失败：${response.error || '未知错误'}`,
        });
      }
    } catch (error) {
      console.error('Save error:', error);
      setSaveNotice({ type: 'error', text: '保存时出错，请稍后重试' });
    } finally {
      setSaving(false);
    }
  };

  const handleApplyImportDraft = async (updated: UserProfile, baseline?: UserProfile) => {
    setSaving(true);
    try {
      const current = await MessageService.sendMessage<UserProfile>({ type: 'GET_USER_PROFILE' });
      if (!current.success || !current.data) throw new Error(current.error || '无法读取已保存资料');
      const next = mergeReviewedProfile(baseline || profile, updated, current.data);
      if (importReviewData?.resumeId) next.resumes = next.resumes?.map(resume => resume.id === importReviewData.resumeId ? { ...resume, parsedProfile: createResumeProfileSnapshot({ ...next, rawText: importReviewData.extraction.text }) } : resume);
      const response = await MessageService.sendMessage({
        type: 'SAVE_USER_PROFILE',
        payload: next,
      });

      if (response.success) {
        setProfile(next);
        setImportReviewData(null);
        setImportDraft(null);
        setSaveNotice({ type: 'success', text: '资料已准备好，回到申请页即可一键填写' });
        setImportProgress(null);
      } else {
        throw new Error(response.error || '保存失败');
      }
    } catch (error) {
      console.error('Failed to apply imported profile:', error);
      throw error;
    } finally {
      setSaving(false);
    }
  };

  const handlePersonalChange = (field: keyof PersonalInfo, value: string) => {
    setProfile({
      ...profile,
      personal: {
        ...profile.personal,
        [field]: value
      }
    });
  };

  const addCustomInformation = () => {
    const item: CustomInformation = {
      id: `custom-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      name: '',
      content: '',
    };
    setProfile({
      ...profile,
      customInformation: [...(profile.customInformation || []), item],
    });
  };

  const updateCustomInformation = (
    id: string,
    field: 'name' | 'content',
    value: string
  ) => {
    setProfile({
      ...profile,
      customInformation: (profile.customInformation || []).map(item =>
        item.id === id ? { ...item, [field]: value } : item
      ),
    });
  };

  const removeCustomInformation = (id: string) => {
    setProfile({
      ...profile,
      customInformation: (profile.customInformation || []).filter(item => item.id !== id),
    });
  };

  const updateResumeCategory = (id: string, category: string) => {
    setProfile(current => ({
      ...current,
      resumes: (current.resumes || []).map(resume => (
        resume.id === id ? { ...resume, category } : resume
      )),
    }));
  };

  const removeResume = async (id: string) => {
    const removed = (profile.resumes || []).find(resume => resume.id === id);
    if (!removed || !window.confirm(`确认删除“${removed.category || '未分类'}｜${removed.fileName}”吗？`)) return;
    const nextProfile = removeResumeVariant(profile, id);
    setProfile(nextProfile);
    setSaving(true);
    try {
      const response = await MessageService.sendMessage({
        type: 'SAVE_USER_PROFILE',
        payload: nextProfile,
      });
      if (response.success) {
        setSaveNotice({ type: 'success', text: '简历已删除并保存' });
      } else {
        setSaveNotice({ type: 'error', text: `删除保存失败：${response.error || '未知错误'}` });
        void loadProfile();
      }
    } catch (error) {
      console.error('Remove resume error:', error);
      setSaveNotice({ type: 'error', text: '删除保存失败，请重试' });
      void loadProfile();
    } finally {
      setSaving(false);
    }
  };

  const cancelImport = () => {
    const active = uploadRef.current;
    if (!active) return;
    active.controller.abort();
    void MessageService.sendMessage({ type: 'CANCEL_RESUME_IMPORT', payload: { requestId: active.requestId } });
    uploadRef.current = null; setParsingResume(false);
    setImportProgress(previous => previous ? { ...previous, stage: 'cancelled', detail: '识别已停止，你可以重试或选择另一份简历。' } : null);
  };
  const processResumeFile = async (file: File) => {
    if (uploadRef.current) return;
    const fileType = resolveFileType(file);
    if (!RESUME_FILE_TYPES.includes(fileType) || file.size > 20 * 1024 * 1024 || file.size === 0) {
      lastUploadRef.current = null;
      setImportProgress({ stage: 'error', fileName: file.name, detail: '请上传 20 MB 以内的 PDF、Word、图片或文本简历，文件不能为空。' }); return;
    }
    const requestId = crypto.randomUUID(), controller = new AbortController();
    uploadRef.current = { requestId, controller }; lastUploadRef.current = file;
    setParsingResume(true); setResumeNotice(null); setImportReviewData(null); setImportDraft(null);
    setImportProgress({ stage: 'reading', fileName: file.name, detail: '正在读取文件，识别后会自动预填写资料。' });
    let timedOut = false;
    const timeout = setTimeout(() => { timedOut = true; controller.abort(); }, 120_000);
    try {
      const stored = await MessageService.sendMessage<UserProfile>({ type: 'GET_USER_PROFILE' });
      const baseProfile = stored.data || profileRef.current;
      const fileData = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        const stop = () => reader.abort();
        const cleanup = () => controller.signal.removeEventListener('abort', stop);
        reader.onload = () => { cleanup(); resolve(String(reader.result)); };
        reader.onerror = () => { cleanup(); reject(new Error('文件读取失败，请重新选择文件')); };
        reader.onabort = () => { cleanup(); reject(new DOMException('已停止识别', 'AbortError')); };
        controller.signal.addEventListener('abort', stop, { once: true });
        if (controller.signal.aborted) { cleanup(); reject(new DOMException('已停止识别', 'AbortError')); return; }
        reader.readAsDataURL(file);
      });
      const extraction = await extractResumeFile(fileData, fileType, { signal: controller.signal, onProgress: progress => {
        if (uploadRef.current?.requestId !== requestId) return;
        setImportProgress({ stage: progress.stage, fileName: file.name, extraction: progress,
          detail: progress.stage === 'ocr' ? '正在识别扫描文字，完成后自动整理资料。' : '正在提取简历文字。' });
      } });
      clearTimeout(timeout);
      if (controller.signal.aborted || uploadRef.current?.requestId !== requestId) return;
      if (!extraction.text.trim()) throw new Error('没有识别到文字，请上传更清晰的图片或文字版简历');
      setImportProgress({ stage: 'structuring', fileName: file.name, detail: '正在自动预填写联系方式、教育和工作经历。' });
      const response = await MessageService.sendMessage<{ parsedData: ParsedResumeData; resumeId?: string; llmError?: string; parseMethod: string }>({ type: 'PARSE_RESUME', payload: {
        file: fileData, fileType, fileName: file.name, category: resumeCategory.trim() || '未分类', rawText: extraction.text, requestId,
      } });
      if (controller.signal.aborted || uploadRef.current?.requestId !== requestId) return;
      if (!response.success || !response.data) throw new Error(response.error || '资料整理失败，请重试');
      const result = response.data;
      if (result.parseMethod === 'regex') extraction.warnings.push(result.llmError ? 'AI 整理暂时未完成，已用本地规则预填写可识别内容。' : '当前未配置 AI，已用本地规则预填写；可在 AI 设置中配置服务以识别更多内容。');
      setImportReviewData({ parsedData: result.parsedData, fileName: file.name, requestId, resumeId: result.resumeId, baseProfile,
        extraction, open: true });
      setImportProgress({ stage: 'review', fileName: file.name, detail: `已整理 ${summarizeParsed(result.parsedData) || '简历文字'}，核对后即可使用。` });
      await loadProfile(); setResumeCategory('');
    } catch (error) {
      if (uploadRef.current?.requestId !== requestId) return;
      setImportProgress({ stage: timedOut ? 'error' : controller.signal.aborted ? 'cancelled' : 'error', fileName: file.name,
        detail: timedOut ? '识别耗时较长，已停止。可以重试或上传更清晰、更短的简历。' : controller.signal.aborted ? '已停止简历识别。' : error instanceof Error ? error.message.split('\n')[0] : '识别失败，请重试。' });
    } finally {
      clearTimeout(timeout);
      if (uploadRef.current?.requestId === requestId) { uploadRef.current = null; setParsingResume(false); }
    }
  };
  const handleFileUpload = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]; event.target.value = '';
    if (file) void processResumeFile(file);
  };

  if (loading) {
    return <div className="options-loading">加载中...</div>;
  }

  return (
    <div className="options-shell">
      {saveNotice && (
        <div
          className={`save-toast ${saveNotice.type}`}
          role="status"
          aria-live="polite"
        >
          {saveNotice.text}
        </div>
      )}
      <header className="options-header">
        <div className="options-header-inner">
          <div className="options-brand-left">
            <img
              className="options-brand-mark"
              src={typeof chrome !== 'undefined' && chrome.runtime?.getURL
                ? chrome.runtime.getURL('icons/icon128.png')
                : '/icons/icon128.png'}
              alt=""
            />
            <div>
              <span className="options-brand-name">JOB APPLYMATE</span>
              <h1>建立你的申请资料库</h1>
              <p>一次整理，全网招聘站点一键自动填报与智能纠偏。</p>
            </div>
          </div>
          <div className="options-header-actions">
            <button
              type="button"
              className="header-action-btn"
              onClick={() => globalFileInputRef.current?.click()}
              disabled={parsingResume}
              title="支持文字或扫描 PDF、Word、图片、TXT、MD 简历文件"
            >
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"></polygon>
              </svg>
              <span>{parsingResume ? '正在解析简历...' : '从简历一键解析建档'}</span>
            </button>
            <input
              ref={globalFileInputRef}
              type="file"
              accept=".pdf,.doc,.docx,.png,.jpg,.jpeg,.webp,.md,.txt,.json"
              onChange={handleFileUpload}
              style={{ display: 'none' }}
              disabled={parsingResume}
            />
          </div>
        </div>
      </header>

      {importProgress && <ResumeImportProgress progress={importProgress} onCancel={cancelImport} onRetry={() => { if (lastUploadRef.current) void processResumeFile(lastUploadRef.current); else globalFileInputRef.current?.click(); }} onReview={() => setImportReviewData(previous => previous ? { ...previous, open: true } : null)} />}
      <div className="options-content">
        <nav className="options-tabs" aria-label="设置分类">
          <button
            onClick={() => setActiveTab('personal')}
            className={activeTab === 'personal' ? 'options-tab active' : 'options-tab'}
          >
            <span>基本信息</span>
          </button>
          <button
            onClick={() => setActiveTab('education')}
            className={activeTab === 'education' ? 'options-tab active' : 'options-tab'}
          >
            <span>教育经历</span>
            {(profile.education?.length ?? 0) > 0 && (
              <span className="tab-badge">{profile.education?.length}</span>
            )}
          </button>
          <button
            onClick={() => setActiveTab('experience')}
            className={activeTab === 'experience' ? 'options-tab active' : 'options-tab'}
          >
            <span>实习与项目</span>
            {((profile.experience?.length || 0) + (profile.projects?.length || 0) + (profile.skills?.length ? 1 : 0)) > 0 && (
              <span className="tab-badge">{(profile.experience?.length || 0) + (profile.projects?.length || 0)}</span>
            )}
          </button>
          <button onClick={() => setActiveTab('more')} className={activeTab === 'more' ? 'options-tab active' : 'options-tab'}>
            更多资料
            {SUPPLEMENTAL_COLLECTIONS.some(collection => profile[collection]?.length) && <span className="tab-badge">{SUPPLEMENTAL_COLLECTIONS.reduce((count, collection) => count + (profile[collection]?.length || 0), 0)}</span>}
          </button>
          <button
            onClick={() => setActiveTab('custom')}
            className={activeTab === 'custom' ? 'options-tab active' : 'options-tab'}
          >
            <span>自定义信息</span>
            {(profile.customInformation?.length ?? 0) > 0 && (
              <span className="tab-badge">{profile.customInformation?.length}</span>
            )}
          </button>
          <button
            onClick={() => setActiveTab('resume')}
            className={activeTab === 'resume' ? 'options-tab active' : 'options-tab'}
          >
            <span>简历库</span>
            {(profile.resumes?.length ?? 0) > 0 && (
              <span className="tab-badge">{profile.resumes?.length}</span>
            )}
          </button>
          <button
            onClick={() => setActiveTab('ai')}
            className={activeTab === 'ai' ? 'options-tab active' : 'options-tab'}
          >
            <span>AI设置</span>
          </button>
          <button
            onClick={() => setActiveTab('data-sync')}
            className={activeTab === 'data-sync' ? 'options-tab active' : 'options-tab'}
          >
            <span>数据与同步</span>
          </button>
        </nav>

        <div className="options-panel">
          {activeTab === 'personal' && (
            <div className="options-form">
              <div className="smart-setup-card">
                <div>
                  <span className="smart-setup-badge">⚡ 智能建档助手</span>
                  <h3 className="smart-setup-title">直接从现有简历解析资料库</h3>
                  <p className="smart-setup-desc">
                    支持直接上传 PDF、DOCX、Markdown、TXT 格式简历。系统将自动抽取个人信息、教育、工作、项目及技能，并在界面中高亮核对缺失项，一键补全建档。
                  </p>
                </div>
                <button
                  type="button"
                  className="smart-setup-btn"
                  onClick={() => globalFileInputRef.current?.click()}
                  disabled={parsingResume}
                >
                  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path>
                    <polyline points="17 8 12 3 7 8"></polyline>
                    <line x1="12" y1="3" x2="12" y2="15"></line>
                  </svg>
                  <span>{parsingResume ? '正在解析...' : '上传简历一键提取'}</span>
                </button>
              </div>

              <h2 className="section-title">个人基本信息</h2>

              <div className="form-grid-2">
                <div style={styles.formGroup}>
                  <label style={styles.label}>姓名 *</label>
                  <input
                    type="text"
                    value={profile.personal.name || ''}
                    onChange={(e) => handlePersonalChange('name', e.target.value)}
                    style={styles.input}
                    placeholder="请输入姓名"
                  />
                </div>

                <div style={styles.formGroup}>
                  <label style={styles.label}>性别</label>
                  <select
                    value={profile.personal.gender || ''}
                    onChange={(e) => handlePersonalChange('gender', e.target.value)}
                    style={styles.input}
                  >
                    <option value="">请选择</option>
                    <option value="男">男</option>
                    <option value="女">女</option>
                  </select>
                </div>

                <div style={styles.formGroup}>
                  <label style={styles.label}>出生日期</label>
                  <input
                    type="text"
                    value={profile.personal.birthDate || ''}
                    onChange={(e) => handlePersonalChange('birthDate', e.target.value)}
                    style={styles.input}
                    placeholder="如 2002年5月 或 2002-05"
                  />
                </div>

                <div style={styles.formGroup}>
                  <label style={styles.label}>政治面貌</label>
                  <select
                    value={profile.personal.politicalStatus || ''}
                    onChange={(e) => handlePersonalChange('politicalStatus', e.target.value)}
                    style={styles.input}
                  >
                    <option value="">请选择</option>
                    <option value="中共党员">中共党员</option>
                    <option value="中共预备党员">中共预备党员</option>
                    <option value="共青团员">共青团员</option>
                    <option value="群众">群众</option>
                    <option value="民主党派">民主党派</option>
                  </select>
                </div>

                <div style={styles.formGroup}>
                  <label style={styles.label}>民族</label>
                  <input
                    type="text"
                    value={profile.personal.ethnicity || ''}
                    onChange={(e) => handlePersonalChange('ethnicity', e.target.value)}
                    style={styles.input}
                    placeholder="如 汉族"
                  />
                </div>

                <div style={styles.formGroup}>
                  <label style={styles.label}>身份证号</label>
                  <input
                    type="text"
                    value={profile.personal.idCard || ''}
                    onChange={(e) => handlePersonalChange('idCard', e.target.value)}
                    style={styles.input}
                    placeholder="部分网申需要，可留空"
                    autoComplete="off"
                  />
                </div>

                <div style={styles.formGroup}>
                  <label style={styles.label}>手机号 *</label>
                  <input
                    type="tel"
                    value={profile.personal.phone || ''}
                    onChange={(e) => handlePersonalChange('phone', e.target.value)}
                    style={styles.input}
                    placeholder="请输入手机号"
                  />
                </div>

                <div style={styles.formGroup}>
                  <label style={styles.label}>邮箱 *</label>
                  <input
                    type="email"
                    value={profile.personal.email || ''}
                    onChange={(e) => handlePersonalChange('email', e.target.value)}
                    style={styles.input}
                    placeholder="请输入邮箱"
                  />
                </div>

                <div style={styles.formGroup}>
                  <label style={styles.label}>微信号</label>
                  <input
                    type="text"
                    value={profile.personal.wechat || ''}
                    onChange={(e) => handlePersonalChange('wechat', e.target.value)}
                    style={styles.input}
                    placeholder="请输入微信号"
                  />
                </div>

                <div style={styles.formGroup}>
                  <label style={styles.label}>籍贯</label>
                  <input
                    type="text"
                    value={profile.personal.hometown || ''}
                    onChange={(e) => handlePersonalChange('hometown', e.target.value)}
                    style={styles.input}
                    placeholder="如 河北省石家庄市"
                  />
                </div>
              </div>

              <div style={styles.formGroup}>
                <label style={styles.label}>现居地</label>
                <input
                  type="text"
                  value={profile.personal.currentAddress || ''}
                  onChange={(e) => handlePersonalChange('currentAddress', e.target.value)}
                  style={styles.input}
                  placeholder="如 北京市海淀区"
                />
              </div>

              <div style={styles.formGroup}>
                <label style={styles.label}>自我评价</label>
                <textarea
                  value={profile.personal.selfEvaluation || ''}
                  onChange={(e) => {
                    resizeAutoGrowTextarea(e.currentTarget);
                    handlePersonalChange('selfEvaluation', e.target.value);
                  }}
                  ref={(element) => {
                    if (element) resizeAutoGrowTextarea(element);
                  }}
                  style={{ ...styles.input, ...styles.autoGrowTextarea }}
                  placeholder="简要描述个人优势、能力特点和职业倾向，可用于网申自我评价字段"
                  rows={2}
                />
              </div>

              <h3 style={{ marginTop: '28px', marginBottom: '8px', fontSize: '16px', fontWeight: 650, color: 'var(--color-text)' }}>补充个人资料（选填）</h3>
              <p style={{ margin: '0 0 16px', fontSize: '13px', color: 'var(--color-muted)' }}>填写后可在不同招聘页面自动使用；没有的信息保持空白即可。</p>
              <div className="form-grid-2">
                {PERSONAL_EXTRA_FIELDS.map(field => (
                  <div key={field.key} style={styles.formGroup}>
                    <label style={styles.label} htmlFor={`personal-${field.key}`}>{field.label}</label>
                    <input
                      id={`personal-${field.key}`}
                      value={profile.personal[field.key] || ''}
                      onChange={event => handlePersonalChange(field.key, event.target.value)}
                      style={styles.input}
                      placeholder={`选填${field.label}`}
                    />
                  </div>
                ))}
              </div>
              <AdditionalFactsSection
                facts={getPersonalAdditionalFields(profile)}
                onChange={additionalFields => setProfile({ ...profile, personal: { ...profile.personal, additionalFields } })}
              />

              <div className="info-note">
                💡 提示：带 * 的为必填项。你也可以通过上传简历来快速填充这些信息。
                资料默认保存在本地。使用 AI 解析或辅助填写时，相关文字会发送至你配置的 AI 服务；启用同步后会保存到你的 WebDAV。
              </div>
            </div>
          )}

          {activeTab === 'education' && (
            <div className="options-form">
              <EducationSection
                items={profile.education || []}
                onChange={education => setProfile({ ...profile, education })}
              />
            </div>
          )}

          {activeTab === 'experience' && (
            <div className="options-form">
              <ExperienceSection
                experience={profile.experience || []}
                projects={profile.projects || []}
                skills={profile.skills || []}
                onChangeExperience={experience => setProfile({ ...profile, experience })}
                onChangeProjects={projects => setProfile({ ...profile, projects })}
                onChangeSkills={skills => setProfile({ ...profile, skills })}
              />
            </div>
          )}

          {activeTab === 'more' && <SupplementalProfileSection profile={profile} onChange={setProfile} />}

          {activeTab === 'custom' && (
            <div className="options-form">
              <div className="custom-information-header">
                <div>
                  <h2 className="section-title">自定义信息</h2>
                  <p className="custom-information-description">
                    添加网申中经常使用、但不属于现有分类的信息。
                  </p>
                </div>
                <button type="button" className="btn btn-secondary" onClick={addCustomInformation}>
                  添加
                </button>
              </div>

              {(profile.customInformation || []).length === 0 ? (
                <div className="custom-information-empty">
                  <p>暂无自定义信息</p>
                  <span>点击“添加”创建信息名称和信息内容。</span>
                </div>
              ) : (
                <div className="custom-information-list">
                  {(profile.customInformation || []).map((item, index) => (
                    <section className="custom-information-item" key={item.id}>
                      <div className="custom-information-item-header">
                        <h3>自定义信息 {index + 1}</h3>
                        <button
                          type="button"
                          className="custom-information-remove"
                          onClick={() => removeCustomInformation(item.id)}
                          aria-label={`删除自定义信息 ${index + 1}`}
                        >
                          删除
                        </button>
                      </div>
                      <div className="custom-information-fields">
                        <label>
                          <span>信息名称</span>
                          <input
                            type="text"
                            value={item.name}
                            onChange={event =>
                              updateCustomInformation(item.id, 'name', event.target.value)
                            }
                            placeholder="例如：期望薪资"
                          />
                        </label>
                        <label>
                          <span>信息内容</span>
                          <textarea
                            value={item.content}
                            onChange={event =>
                              updateCustomInformation(item.id, 'content', event.target.value)
                            }
                            placeholder="请输入需要快速填写或复制的内容"
                            rows={3}
                          />
                        </label>
                      </div>
                    </section>
                  ))}
                </div>
              )}
            </div>
          )}

          {importReviewData?.open && (
            <ProfileImportDraft
              key={importReviewData.requestId}
              parsedData={importReviewData.parsedData}
              initialDraft={importReviewData.draft}
              warnings={importReviewData.extraction.warnings}
              rawText={importReviewData.extraction.text}
              extractionMethod={importReviewData.extraction.method}
              fileName={importReviewData.fileName}
              currentProfile={importReviewData.baseProfile}
              onDismiss={draft => setImportReviewData(previous => previous ? { ...previous, draft, open: false } : null)}
              onApply={handleApplyImportDraft}
            />
          )}
          {!importReviewData && importDraft && importDraft.length > 0 && (
            <ProfileImportDraft
              changes={importDraft}
              currentProfile={profile}
              onDismiss={() => setImportDraft(null)}
              onApply={async (_updated) => {
                const current = await MessageService.sendMessage<UserProfile>({ type: 'GET_USER_PROFILE' });
                if (!current.success || !current.data) throw new Error(current.error || '无法读取资料');
                const next = applyProfileImportDraft(current.data, importDraft);
                const result = await MessageService.sendMessage({ type: 'SAVE_USER_PROFILE', payload: next });
                if (!result.success) throw new Error(result.error || '保存失败');
                setProfile(next);
                setImportDraft(null);
                setSaveNotice({ type: 'success', text: '已保存确认的资料更新' });
              }}
            />
          )}
          {activeTab === 'resume' && (
            <div className="options-form">
              <h2 className="section-title">简历库</h2>

              <label className="resume-category-field">
                <span>本次添加到哪个分类</span>
                <input
                  type="text"
                  value={resumeCategory}
                  onChange={event => setResumeCategory(event.target.value)}
                  placeholder="例如：产品岗、运营岗、数据分析岗"
                  maxLength={40}
                />
                <small>分类仅用于插件内区分，上传到网站时仍保留文件的原始名称。</small>
              </label>

              <div className="upload-container">
                <div className={parsingResume ? 'upload-area parsing' : 'upload-area'} onDragOver={event => event.preventDefault()} onDrop={event => { event.preventDefault(); if (event.dataTransfer.files[0]) void processResumeFile(event.dataTransfer.files[0]); }}>
                  <svg
                    width="48"
                    height="48"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                  >
                    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path>
                    <polyline points="17 8 12 3 7 8"></polyline>
                    <line x1="12" y1="3" x2="12" y2="15"></line>
                  </svg>
                  <p className="upload-title">{parsingResume ? '正在解析简历...' : '点击或拖拽文件到此处上传'}</p>
                  <p className="upload-hint">
                    {parsingResume ? '请保持当前页面打开，解析完成后会自动提示。' : '支持 PDF、Word、PNG/JPG 图片、MD、TXT、JSON，扫描简历也能识别'}
                  </p>
                  <input
                    type="file"
                    accept=".pdf,.doc,.docx,.png,.jpg,.jpeg,.webp,.md,.txt,.json"
                    onChange={handleFileUpload}
                    className="file-input"
                    disabled={parsingResume}
                  />
                </div>

                {resumeNotice && (
                  <div className={`resume-notice ${resumeNotice.type}`} role="status" aria-live="polite">
                    {resumeNotice.text}
                  </div>
                )}

                {(profile.resumes || []).length > 0 && (
                  <div className="resume-info">
                    <h3>已保存 {profile.resumes?.length || 0} 份简历</h3>
                    <div className="resume-library-list">
                      {(profile.resumes || []).map(resume => (
                        <article className="resume-library-item" key={resume.id}>
                          <div className="resume-file-icon" aria-hidden="true">
                            {resume.fileType.toUpperCase().slice(0, 4)}
                          </div>
                          <div className="resume-library-main">
                            <input
                              type="text"
                              value={resume.category}
                              onChange={event => updateResumeCategory(resume.id, event.target.value)}
                              placeholder="未分类"
                              aria-label={`${resume.fileName}的分类`}
                              maxLength={40}
                            />
                            <strong title={resume.fileName}>{resume.fileName}</strong>
                            <small>添加于 {new Date(resume.uploadDate).toLocaleDateString('zh-CN')}</small>
                          </div>
                          <button
                            type="button"
                            className="resume-remove-button"
                            onClick={() => removeResume(resume.id)}
                          >
                            删除
                          </button>
                        </article>
                      ))}
                    </div>
                  </div>
                )}

                <div className="info-note">
                  每份简历会独立保存解析资料，切换简历时悬浮窗和自动填写内容会同步切换；新增简历不会覆盖已有资料。删除后会立即保存，修改分类后请点击下方“保存设置”。
                </div>
              </div>
            </div>
          )}

          {activeTab === 'ai' && <AISettings dataRevision={dataRevision} />}

          {activeTab === 'data-sync' && (
            <DataSyncSettings onDataChanged={handleExternalDataChange} />
          )}

          {activeTab !== 'ai' && activeTab !== 'data-sync' && (
            <div className="options-actions">
            <button onClick={handleSave} disabled={saving} className="btn btn-primary">
              {saving ? '保存中...' : '保存设置'}
            </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  formGroup: {
    marginBottom: '16px',
    flex: 1
  },
  formRow: {
    display: 'flex',
    gap: '16px'
  },
  label: {
    display: 'block',
    marginBottom: '6px',
    fontSize: '13px',
    fontWeight: '600',
    color: '#334155'
  },
  input: {
    width: '100%',
    padding: '9px 12px',
    fontSize: '14px',
    border: '1px solid var(--color-border)',
    borderRadius: '8px',
    outline: 'none',
    transition: 'border-color 0.2s',
    fontFamily: 'inherit',
    boxSizing: 'border-box'
  },
  autoGrowTextarea: {
    minHeight: '44px',
    lineHeight: '1.6',
    overflowY: 'hidden',
    resize: 'none'
  }
};

export default App;
