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
import React, { useState, useEffect, useRef } from 'react';
import { MessageService } from '../shared/message';
import type {
  UserProfile,
  PersonalInfo,
  CustomInformation,
  ParsedResumeData,
} from '../shared/types';
import { EducationSection } from './EducationSection';
import { ExperienceSection } from './ExperienceSection';
import { DataBackupSettings } from './DataBackupSettings';
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

const PROFILE_SECTIONS = [
  { id: 'personal', label: '基本信息' },
  { id: 'education', label: '教育经历' },
  { id: 'experience', label: '实习、项目与技能' },
  { id: 'more', label: '更多个人资料' },
  { id: 'custom', label: '自定义信息' },
  { id: 'resume', label: '简历附件' },
  { id: 'data-backup', label: '数据备份' },
] as const;

type ProfileSectionId = typeof PROFILE_SECTIONS[number]['id'];

function getInitialSection(): ProfileSectionId {
  if (typeof window === 'undefined') return 'personal';
  const requested = window.location.hash.replace('#profile-', '')
    || new URLSearchParams(window.location.search).get('tab');
  const section = requested === 'data-sync' ? 'data-backup' : requested;
  return PROFILE_SECTIONS.some(item => item.id === section) ? section as ProfileSectionId : 'personal';
}

function openProfileSection(id: ProfileSectionId) {
  const element = document.getElementById(`profile-${id}`);
  if (element instanceof HTMLDetailsElement) element.open = true;
  return element;
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
  const initialSectionRef = useRef(getInitialSection());
  const [activeSection, setActiveSection] = useState<ProfileSectionId>(getInitialSection);
  const [parsingResume, setParsingResume] = useState(false);
  const [importProgress, setImportProgress] = useState<ImportProgress | null>(null);
  const uploadRef = useRef<{ requestId: string; controller: AbortController } | null>(null);
  const lastUploadRef = useRef<File | null>(null);
  const profileRef = useRef(profile); profileRef.current = profile;
  useEffect(() => () => { uploadRef.current?.controller.abort(); if (uploadRef.current) void MessageService.sendMessage({ type: 'CANCEL_RESUME_IMPORT', payload: { requestId: uploadRef.current.requestId } }); }, []);
  const [resumeCategory, setResumeCategory] = useState('');
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
      }
    };
    chrome.storage.onChanged.addListener(handleStorageChange);
    return () => chrome.storage.onChanged.removeListener(handleStorageChange);
  }, []);

  useEffect(() => {
    if (loading) return;
    const initial = initialSectionRef.current;
    const frame = window.requestAnimationFrame(() => {
      if (initial !== 'personal') openProfileSection(initial)?.scrollIntoView();
    });
    return () => window.cancelAnimationFrame(frame);
  }, [loading]);

  useEffect(() => {
    if (loading) return;
    let frame = 0;
    const updateSection = () => {
      frame = 0;
      let current: ProfileSectionId = 'personal';
      for (const section of PROFILE_SECTIONS) {
        const element = document.getElementById(`profile-${section.id}`);
        if (element && element.getBoundingClientRect().top <= 160) current = section.id;
      }
      setActiveSection(current);
    };
    const onScroll = () => { if (!frame) frame = window.requestAnimationFrame(updateSection); };
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => { window.removeEventListener('scroll', onScroll); window.cancelAnimationFrame(frame); };
  }, [loading]);

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
    setParsingResume(true); setImportReviewData(null);
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
      const response = await MessageService.sendMessage<{ parsedData: ParsedResumeData; resumeId?: string; parseMethod: string }>({ type: 'PARSE_RESUME', payload: {
        file: fileData, fileType, fileName: file.name, category: resumeCategory.trim() || '未分类', rawText: extraction.text, requestId,
      } });
      if (controller.signal.aborted || uploadRef.current?.requestId !== requestId) return;
      if (!response.success || !response.data) throw new Error(response.error || '资料整理失败，请重试');
      const result = response.data;
      if (result.parseMethod === 'regex') extraction.warnings.push('已使用本地规则整理可识别内容，请核对后保存。');
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
              <span className="options-brand-name">FILLEASE · 填简</span>
              <h1>填写你的申请资料</h1>
              <p>像填写简历一样，一页整理基本信息与经历，保存后用于网申填写。</p>
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
        <aside className="profile-sidebar">
          <nav className="profile-directory" aria-label="资料页内目录">
            <p className="profile-directory-title">本页目录</p>
            {PROFILE_SECTIONS.map((section, index) => (
              <a
                key={section.id}
                href={`#profile-${section.id}`}
                aria-current={activeSection === section.id ? 'location' : undefined}
                onClick={() => {
                  setActiveSection(section.id);
                  openProfileSection(section.id)?.focus({ preventScroll: true });
                }}
              >
                <span className="profile-directory-index" aria-hidden="true">{String(index + 1).padStart(2, '0')}</span>
                <span>{section.label}</span>
              </a>
            ))}
            <p className="profile-directory-hint">可按顺序填写，也可点击目录跳到对应位置。</p>
          </nav>
        </aside>

        <main className="profile-document" aria-label="申请资料表单">
          <section id="profile-personal" className="profile-section options-form" aria-label="基本信息" tabIndex={-1}>
              <h2 className="section-title">个人基本信息</h2>

              <div className="form-grid-2">
                <div style={styles.formGroup}>
                  <label style={styles.label} htmlFor="personal-name">姓名</label>
                  <input id="personal-name"
                    type="text"
                    value={profile.personal.name || ''}
                    onChange={(e) => handlePersonalChange('name', e.target.value)}
                    style={styles.input}
                    placeholder="请输入姓名"
                  />
                </div>

                <div style={styles.formGroup}>
                  <label style={styles.label} htmlFor="personal-gender">性别</label>
                  <select id="personal-gender"
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
                  <label style={styles.label} htmlFor="personal-birthDate">出生日期</label>
                  <input id="personal-birthDate"
                    type="text"
                    value={profile.personal.birthDate || ''}
                    onChange={(e) => handlePersonalChange('birthDate', e.target.value)}
                    style={styles.input}
                    placeholder="如 2002年5月 或 2002-05"
                  />
                </div>

                <div style={styles.formGroup}>
                  <label style={styles.label} htmlFor="personal-politicalStatus">政治面貌</label>
                  <select id="personal-politicalStatus"
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
                  <label style={styles.label} htmlFor="personal-ethnicity">民族</label>
                  <input id="personal-ethnicity"
                    type="text"
                    value={profile.personal.ethnicity || ''}
                    onChange={(e) => handlePersonalChange('ethnicity', e.target.value)}
                    style={styles.input}
                    placeholder="如 汉族"
                  />
                </div>

                <div style={styles.formGroup}>
                  <label style={styles.label} htmlFor="personal-idCard">身份证号</label>
                  <input id="personal-idCard"
                    type="text"
                    value={profile.personal.idCard || ''}
                    onChange={(e) => handlePersonalChange('idCard', e.target.value)}
                    style={styles.input}
                    placeholder="部分网申需要，可留空"
                    autoComplete="off"
                  />
                </div>

                <div style={styles.formGroup}>
                  <label style={styles.label} htmlFor="personal-phone">手机号</label>
                  <input id="personal-phone"
                    type="tel"
                    value={profile.personal.phone || ''}
                    onChange={(e) => handlePersonalChange('phone', e.target.value)}
                    style={styles.input}
                    placeholder="请输入手机号"
                  />
                </div>

                <div style={styles.formGroup}>
                  <label style={styles.label} htmlFor="personal-email">邮箱</label>
                  <input id="personal-email"
                    type="email"
                    value={profile.personal.email || ''}
                    onChange={(e) => handlePersonalChange('email', e.target.value)}
                    style={styles.input}
                    placeholder="请输入邮箱"
                  />
                </div>

                <div style={styles.formGroup}>
                  <label style={styles.label} htmlFor="personal-wechat">微信号</label>
                  <input id="personal-wechat"
                    type="text"
                    value={profile.personal.wechat || ''}
                    onChange={(e) => handlePersonalChange('wechat', e.target.value)}
                    style={styles.input}
                    placeholder="请输入微信号"
                  />
                </div>

                <div style={styles.formGroup}>
                  <label style={styles.label} htmlFor="personal-hometown">籍贯</label>
                  <input id="personal-hometown"
                    type="text"
                    value={profile.personal.hometown || ''}
                    onChange={(e) => handlePersonalChange('hometown', e.target.value)}
                    style={styles.input}
                    placeholder="如 河北省石家庄市"
                  />
                </div>
              </div>

              <div style={styles.formGroup}>
                <label style={styles.label} htmlFor="personal-currentAddress">现居地</label>
                <input id="personal-currentAddress"
                  type="text"
                  value={profile.personal.currentAddress || ''}
                  onChange={(e) => handlePersonalChange('currentAddress', e.target.value)}
                  style={styles.input}
                  placeholder="如 北京市海淀区"
                />
              </div>

              <div style={styles.formGroup}>
                <label style={styles.label} htmlFor="personal-selfEvaluation">自我评价</label>
                <textarea id="personal-selfEvaluation"
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

              <details className="profile-optional" open={PERSONAL_EXTRA_FIELDS.some(field => profile.personal[field.key]) || getPersonalAdditionalFields(profile).length > 0}>
                <summary>求职偏好与其他个人信息 <span>选填</span></summary>
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

              </details>

              <div className="info-note">
                可先填写姓名与联系方式，再按需补充经历。你也可以从现有简历提取资料。
                资料保存在本地，文件识别与表单填写均在浏览器内完成。
              </div>
          </section>

          <section id="profile-education" className="profile-section options-form" aria-label="教育经历" tabIndex={-1}>
              <EducationSection
                items={profile.education || []}
                onChange={education => setProfile({ ...profile, education })}
              />
          </section>

          <section id="profile-experience" className="profile-section options-form" aria-label="实习、项目与技能" tabIndex={-1}>
              <ExperienceSection
                experience={profile.experience || []}
                projects={profile.projects || []}
                skills={profile.skills || []}
                onChangeExperience={experience => setProfile({ ...profile, experience })}
                onChangeProjects={projects => setProfile({ ...profile, projects })}
                onChangeSkills={skills => setProfile({ ...profile, skills })}
              />
          </section>

          <section id="profile-more" className="profile-section" aria-label="更多个人资料" tabIndex={-1}>
            <SupplementalProfileSection profile={profile} onChange={setProfile} />
          </section>

          <section id="profile-custom" className="profile-section options-form" aria-label="自定义信息" tabIndex={-1}>
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
          </section>

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
          <section id="profile-resume" className="profile-section options-form" aria-label="简历附件" tabIndex={-1}>
              <h2 className="section-title">简历附件</h2>

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
                  每份简历会独立保存解析资料，切换简历时悬浮窗和自动填写内容会同步切换；新增简历不会覆盖已有资料。删除后会立即保存，修改分类后请点击“保存全部资料”。
                </div>
              </div>
          </section>

          <details id="profile-data-backup" className="profile-section profile-tool" tabIndex={-1} open={initialSectionRef.current === 'data-backup'}>
            <summary><span>数据备份</span><small>导入或导出本地 JSON 备份</small></summary>
            <div className="profile-tool-content"><DataBackupSettings onDataChanged={handleExternalDataChange} /></div>
          </details>
        </main>
      </div>
      <footer className="profile-save-bar">
        <div className="profile-save-inner">
          <div><strong>所有个人资料统一保存</strong><p>资料保存在本机，修改后请保存全部资料。</p></div>
          <button type="button" onClick={handleSave} disabled={saving} className="btn btn-primary">
            {saving ? '保存中...' : '保存全部资料'}
          </button>
        </div>
      </footer>
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
