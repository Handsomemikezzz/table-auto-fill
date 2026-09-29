import React, { useState } from 'react';
import type { UserProfile, ParsedResumeData, PersonalInfo, EducationInfo, ExperienceInfo, ProjectInfo } from '../shared/types.ts';
import type { ProfileImportChange } from '../autofill/profileImport.ts';

export interface ProfileImportDraftProps {
  parsedData?: ParsedResumeData;
  fileName?: string;
  changes?: ProfileImportChange[];
  currentProfile?: UserProfile;
  onApply: (updated: UserProfile) => Promise<void>;
  onDismiss: () => void;
}

type ReviewTab = 'personal' | 'education' | 'experience' | 'projects' | 'skills';

export function ProfileImportDraft({
  parsedData,
  fileName,
  currentProfile,
  onApply,
  onDismiss,
}: ProfileImportDraftProps) {
  const [activeTab, setActiveTab] = useState<ReviewTab>('personal');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  // Initialize draft profile merging current and parsed data
  const [draft, setDraft] = useState<UserProfile>(() => {
    const base = currentProfile || {
      personal: {} as PersonalInfo,
      education: [],
      experience: [],
      projects: [],
      customInformation: [],
      skills: [],
      certifications: [],
    };

    const parsedPersonal = parsedData?.personal || {};
    const mergedPersonal: PersonalInfo = {
      ...base.personal,
      ...(Object.fromEntries(
        Object.entries(parsedPersonal).filter(([_, v]) => typeof v === 'string' && v.trim())
      ) as Partial<PersonalInfo>),
    };

    const mergedEducation: EducationInfo[] = (parsedData?.education && parsedData.education.length > 0)
      ? parsedData.education.map((e, idx) => ({
          id: e.id || `edu-${Date.now()}-${idx}`,
          school: e.school || '',
          college: e.college || '',
          major: e.major || '',
          majorCategory: e.majorCategory || '',
          degree: e.degree || '',
          academicDegree: e.academicDegree || '',
          startDate: e.startDate || '',
          endDate: e.endDate || '',
          gpa: e.gpa || '',
          ranking: e.ranking || '',
        }))
      : base.education;

    const mergedExperience: ExperienceInfo[] = (parsedData?.experience && parsedData.experience.length > 0)
      ? parsedData.experience.map((exp, idx) => ({
          id: exp.id || `exp-${Date.now()}-${idx}`,
          company: exp.company || '',
          position: exp.position || '',
          startDate: exp.startDate || '',
          endDate: exp.endDate || '',
          description: exp.description || '',
          achievements: exp.achievements || '',
        }))
      : base.experience;

    const mergedProjects: ProjectInfo[] = (parsedData?.projects && parsedData.projects.length > 0)
      ? parsedData.projects.map((p, idx) => ({
          id: p.id || `proj-${Date.now()}-${idx}`,
          name: p.name || '',
          role: p.role || '',
          startDate: p.startDate || '',
          endDate: p.endDate || '',
          description: p.description || '',
          achievements: p.achievements || '',
          technologies: p.technologies || '',
        }))
      : base.projects;

    const mergedSkills: string[] = (parsedData?.skills && parsedData.skills.length > 0)
      ? parsedData.skills
      : base.skills;

    return {
      ...base,
      personal: mergedPersonal,
      education: mergedEducation,
      experience: mergedExperience,
      projects: mergedProjects,
      skills: mergedSkills,
    };
  });

  const parsedPersonal = parsedData?.personal || {};
  const isParsed = (key: keyof PersonalInfo) => {
    const val = parsedPersonal[key];
    return typeof val === 'string' && val.trim().length > 0;
  };

  const handlePersonalFieldChange = (key: keyof PersonalInfo, value: string) => {
    setDraft(prev => ({
      ...prev,
      personal: {
        ...prev.personal,
        [key]: value,
      },
    }));
  };

  const handleEducationChange = (index: number, field: keyof EducationInfo, value: string) => {
    setDraft(prev => {
      const list = [...prev.education];
      list[index] = { ...list[index], [field]: value };
      return { ...prev, education: list };
    });
  };

  const addEducation = () => {
    setDraft(prev => ({
      ...prev,
      education: [
        ...prev.education,
        {
          id: `edu-${Date.now()}`,
          school: '',
          major: '',
          degree: '本科',
          startDate: '',
          endDate: '',
        },
      ],
    }));
  };

  const removeEducation = (index: number) => {
    setDraft(prev => ({
      ...prev,
      education: prev.education.filter((_, i) => i !== index),
    }));
  };

  const handleExperienceChange = (index: number, field: keyof ExperienceInfo, value: string) => {
    setDraft(prev => {
      const list = [...prev.experience];
      list[index] = { ...list[index], [field]: value };
      return { ...prev, experience: list };
    });
  };

  const addExperience = () => {
    setDraft(prev => ({
      ...prev,
      experience: [
        ...prev.experience,
        {
          id: `exp-${Date.now()}`,
          company: '',
          position: '',
          startDate: '',
          endDate: '',
          description: '',
        },
      ],
    }));
  };

  const removeExperience = (index: number) => {
    setDraft(prev => ({
      ...prev,
      experience: prev.experience.filter((_, i) => i !== index),
    }));
  };

  const handleProjectChange = (index: number, field: keyof ProjectInfo, value: string) => {
    setDraft(prev => {
      const list = [...prev.projects];
      list[index] = { ...list[index], [field]: value };
      return { ...prev, projects: list };
    });
  };

  const addProject = () => {
    setDraft(prev => ({
      ...prev,
      projects: [
        ...prev.projects,
        {
          id: `proj-${Date.now()}`,
          name: '',
          role: '',
          startDate: '',
          endDate: '',
          description: '',
          achievements: '',
        },
      ],
    }));
  };

  const removeProject = (index: number) => {
    setDraft(prev => ({
      ...prev,
      projects: prev.projects.filter((_, i) => i !== index),
    }));
  };

  // Calculate stats
  const totalPersonalTracked: (keyof PersonalInfo)[] = [
    'name', 'gender', 'birthDate', 'phone', 'email',
    'preferredCities', 'politicalStatus', 'age', 'portfolioUrl', 'languageSkills', 'wechat',
  ];
  const parsedCount = totalPersonalTracked.filter(isParsed).length
    + (parsedData?.education?.length || 0)
    + (parsedData?.experience?.length || 0)
    + (parsedData?.projects?.length || 0);

  const missingPersonalCount = totalPersonalTracked.filter(k => !draft.personal[k]).length;

  const handleSubmit = async () => {
    setBusy(true);
    setError('');
    try {
      await onApply(draft);
    } catch (err) {
      setError(err instanceof Error ? err.message : '保存资料库失败');
      setBusy(false);
    }
  };

  return (
    <div className="import-review-overlay">
      <div className="import-review-modal" role="dialog" aria-modal="true" aria-labelledby="review-modal-title">
        {/* Modal Header */}
        <div className="import-review-header">
          <div className="import-review-header-main">
            <div className="import-review-icon" aria-hidden="true">
              <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                <polyline points="14 2 14 8 20 8" />
                <line x1="16" y1="13" x2="8" y2="13" />
                <line x1="16" y1="17" x2="8" y2="17" />
                <polyline points="10 9 9 9 8 9" />
              </svg>
            </div>
            <div>
              <div className="import-review-badge-row">
                <span className="import-badge-primary">简历解析核对</span>
                {fileName && <span className="import-filename" title={fileName}>{fileName}</span>}
              </div>
              <h2 id="review-modal-title" className="import-review-title">
                核对并补全提取内容
              </h2>
            </div>
          </div>
          <p className="import-review-subtitle">
            系统已自动填入识别到的内容。标绿字段已预填（可直接修改），标黄字段为简历未提及内容（建议补齐），核对后点击下方按钮即可一键写入个人资料库。
          </p>

          <div className="import-stats-summary">
            <span className="stat-pill success">已提取 {parsedCount} 项信息</span>
            {missingPersonalCount > 0 ? (
              <span className="stat-pill warning">基本信息尚有 {missingPersonalCount} 项待补充</span>
            ) : (
              <span className="stat-pill success">基本信息完整</span>
            )}
          </div>

          {/* Navigation Bar in Modal */}
          <nav className="import-review-nav" aria-label="核对分类">
            <button
              type="button"
              className={activeTab === 'personal' ? 'import-nav-btn active' : 'import-nav-btn'}
              onClick={() => setActiveTab('personal')}
            >
              基本信息
              {missingPersonalCount > 0 && <span className="nav-warn-dot" title="有待补充项" />}
            </button>
            <button
              type="button"
              className={activeTab === 'education' ? 'import-nav-btn active' : 'import-nav-btn'}
              onClick={() => setActiveTab('education')}
            >
              教育经历 ({draft.education.length})
            </button>
            <button
              type="button"
              className={activeTab === 'experience' ? 'import-nav-btn active' : 'import-nav-btn'}
              onClick={() => setActiveTab('experience')}
            >
              工作与实习 ({draft.experience.length})
            </button>
            <button
              type="button"
              className={activeTab === 'projects' ? 'import-nav-btn active' : 'import-nav-btn'}
              onClick={() => setActiveTab('projects')}
            >
              项目经历 ({draft.projects.length})
            </button>
            <button
              type="button"
              className={activeTab === 'skills' ? 'import-nav-btn active' : 'import-nav-btn'}
              onClick={() => setActiveTab('skills')}
            >
              技能与自评
            </button>
          </nav>
        </div>

        {/* Modal Body */}
        <div className="import-review-body">
          {error && <div className="import-error-banner" role="alert">{error}</div>}

          {/* Tab 1: Personal */}
          {activeTab === 'personal' && (
            <div className="import-section-pane">
              <div className="import-form-grid">
                <FieldRow
                  label="姓名 *"
                  parsed={isParsed('name')}
                  value={draft.personal.name || ''}
                  onChange={v => handlePersonalFieldChange('name', v)}
                  placeholder="例如：张三"
                />
                <div className="import-field-item">
                  <div className="import-field-label-row">
                    <label>性别</label>
                    <StatusBadge parsed={isParsed('gender')} filled={Boolean(draft.personal.gender)} />
                  </div>
                  <select
                    className="import-input"
                    value={draft.personal.gender || ''}
                    onChange={e => handlePersonalFieldChange('gender', e.target.value)}
                  >
                    <option value="">请选择</option>
                    <option value="男">男</option>
                    <option value="女">女</option>
                  </select>
                </div>

                <FieldRow
                  label="出生日期"
                  parsed={isParsed('birthDate')}
                  value={draft.personal.birthDate || ''}
                  onChange={v => handlePersonalFieldChange('birthDate', v)}
                  placeholder="例如：2002-05 或 2002年5月"
                />
                <FieldRow
                  label="年龄"
                  parsed={isParsed('age')}
                  value={draft.personal.age || ''}
                  onChange={v => handlePersonalFieldChange('age', v)}
                  placeholder="例如：24"
                />

                <FieldRow
                  label="手机号码 *"
                  parsed={isParsed('phone')}
                  value={draft.personal.phone || ''}
                  onChange={v => handlePersonalFieldChange('phone', v)}
                  placeholder="例如：13800000000"
                />
                <FieldRow
                  label="电子邮箱 *"
                  parsed={isParsed('email')}
                  value={draft.personal.email || ''}
                  onChange={v => handlePersonalFieldChange('email', v)}
                  placeholder="例如：user@example.com"
                />

                <div className="import-field-item">
                  <div className="import-field-label-row">
                    <label>政治面貌</label>
                    <StatusBadge parsed={isParsed('politicalStatus')} filled={Boolean(draft.personal.politicalStatus)} />
                  </div>
                  <select
                    className="import-input"
                    value={draft.personal.politicalStatus || ''}
                    onChange={e => handlePersonalFieldChange('politicalStatus', e.target.value)}
                  >
                    <option value="">请选择（简历中常缺失）</option>
                    <option value="中共党员">中共党员</option>
                    <option value="中共预备党员">中共预备党员</option>
                    <option value="共青团员">共青团员</option>
                    <option value="群众">群众</option>
                    <option value="民主党派">民主党派</option>
                  </select>
                </div>
                <FieldRow
                  label="民族"
                  parsed={isParsed('ethnicity')}
                  value={draft.personal.ethnicity || ''}
                  onChange={v => handlePersonalFieldChange('ethnicity', v)}
                  placeholder="例如：汉族"
                />

                <FieldRow
                  label="期望城市"
                  parsed={isParsed('preferredCities')}
                  value={draft.personal.preferredCities || ''}
                  onChange={v => handlePersonalFieldChange('preferredCities', v)}
                  placeholder="例如：北京、上海、杭州（求职意向地）"
                />
                <FieldRow
                  label="微信号"
                  parsed={isParsed('wechat')}
                  value={draft.personal.wechat || ''}
                  onChange={v => handlePersonalFieldChange('wechat', v)}
                  placeholder="例如：wx_id"
                />

                <FieldRow
                  label="个人作品/主页链接"
                  parsed={isParsed('portfolioUrl')}
                  value={draft.personal.portfolioUrl || ''}
                  onChange={v => handlePersonalFieldChange('portfolioUrl', v)}
                  placeholder="https://..."
                />
                <FieldRow
                  label="语言能力 / 证书"
                  parsed={isParsed('languageSkills')}
                  value={draft.personal.languageSkills || ''}
                  onChange={v => handlePersonalFieldChange('languageSkills', v)}
                  placeholder="例如：英语 六级 (560) / 听说流利"
                />
              </div>
            </div>
          )}

          {/* Tab 2: Education */}
          {activeTab === 'education' && (
            <div className="import-section-pane">
              {draft.education.length === 0 ? (
                <div className="import-empty-state">
                  <p>未解析到教育经历</p>
                  <button type="button" className="btn-add-item" onClick={addEducation}>+ 手动添加教育经历</button>
                </div>
              ) : (
                <div className="import-cards-list">
                  {draft.education.map((edu, idx) => (
                    <div className="import-card-item" key={edu.id || idx}>
                      <div className="import-card-header">
                        <span className="card-item-title">教育经历 #{idx + 1}</span>
                        <button type="button" className="card-item-remove" onClick={() => removeEducation(idx)}>删除</button>
                      </div>
                      <div className="import-form-grid">
                        <div className="import-field-item">
                          <label>学校名称 *</label>
                          <input
                            className="import-input"
                            value={edu.school || ''}
                            onChange={e => handleEducationChange(idx, 'school', e.target.value)}
                            placeholder="例如：安徽大学"
                          />
                        </div>
                        <div className="import-field-item">
                          <label>专业 *</label>
                          <input
                            className="import-input"
                            value={edu.major || ''}
                            onChange={e => handleEducationChange(idx, 'major', e.target.value)}
                            placeholder="例如：软件工程"
                          />
                        </div>
                        <div className="import-field-item">
                          <label>学历层次 *</label>
                          <input
                            className="import-input"
                            value={edu.degree || ''}
                            onChange={e => handleEducationChange(idx, 'degree', e.target.value)}
                            placeholder="例如：本科 / 硕士研究生"
                          />
                        </div>
                        <div className="import-field-item">
                          <label>起止时间</label>
                          <div className="date-range-inputs">
                            <input
                              className="import-input"
                              value={edu.startDate || ''}
                              onChange={e => handleEducationChange(idx, 'startDate', e.target.value)}
                              placeholder="入学：2020-09"
                            />
                            <span>至</span>
                            <input
                              className="import-input"
                              value={edu.endDate || ''}
                              onChange={e => handleEducationChange(idx, 'endDate', e.target.value)}
                              placeholder="毕业：2024-06"
                            />
                          </div>
                        </div>
                      </div>
                    </div>
                  ))}
                  <button type="button" className="btn-add-item" onClick={addEducation}>+ 添加更多教育经历</button>
                </div>
              )}
            </div>
          )}

          {/* Tab 3: Experience */}
          {activeTab === 'experience' && (
            <div className="import-section-pane">
              {draft.experience.length === 0 ? (
                <div className="import-empty-state">
                  <p>未解析到工作/实习经历</p>
                  <button type="button" className="btn-add-item" onClick={addExperience}>+ 手动添加工作经历</button>
                </div>
              ) : (
                <div className="import-cards-list">
                  {draft.experience.map((exp, idx) => (
                    <div className="import-card-item" key={exp.id || idx}>
                      <div className="import-card-header">
                        <span className="card-item-title">经历 #{idx + 1}</span>
                        <button type="button" className="card-item-remove" onClick={() => removeExperience(idx)}>删除</button>
                      </div>
                      <div className="import-form-grid">
                        <div className="import-field-item">
                          <label>公司/企业名称 *</label>
                          <input
                            className="import-input"
                            value={exp.company || ''}
                            onChange={e => handleExperienceChange(idx, 'company', e.target.value)}
                            placeholder="例如：字节跳动"
                          />
                        </div>
                        <div className="import-field-item">
                          <label>职位/岗位名称 *</label>
                          <input
                            className="import-input"
                            value={exp.position || ''}
                            onChange={e => handleExperienceChange(idx, 'position', e.target.value)}
                            placeholder="例如：前端开发实习生"
                          />
                        </div>
                        <div className="import-field-item" style={{ gridColumn: 'span 2' }}>
                          <label>在职时间</label>
                          <div className="date-range-inputs">
                            <input
                              className="import-input"
                              value={exp.startDate || ''}
                              onChange={e => handleExperienceChange(idx, 'startDate', e.target.value)}
                              placeholder="开始：2023-06"
                            />
                            <span>至</span>
                            <input
                              className="import-input"
                              value={exp.endDate || ''}
                              onChange={e => handleExperienceChange(idx, 'endDate', e.target.value)}
                              placeholder="结束：2023-12（或至今）"
                            />
                          </div>
                        </div>
                        <div className="import-field-item" style={{ gridColumn: 'span 2' }}>
                          <label>工作内容与职责</label>
                          <textarea
                            className="import-textarea"
                            rows={3}
                            value={exp.description || ''}
                            onChange={e => handleExperienceChange(idx, 'description', e.target.value)}
                            placeholder="描述工作职责与业绩..."
                          />
                        </div>
                      </div>
                    </div>
                  ))}
                  <button type="button" className="btn-add-item" onClick={addExperience}>+ 添加更多工作经历</button>
                </div>
              )}
            </div>
          )}

          {/* Tab 4: Projects */}
          {activeTab === 'projects' && (
            <div className="import-section-pane">
              {draft.projects.length === 0 ? (
                <div className="import-empty-state">
                  <p>未解析到项目经历</p>
                  <button type="button" className="btn-add-item" onClick={addProject}>+ 手动添加项目经历</button>
                </div>
              ) : (
                <div className="import-cards-list">
                  {draft.projects.map((proj, idx) => (
                    <div className="import-card-item" key={proj.id || idx}>
                      <div className="import-card-header">
                        <span className="card-item-title">项目 #{idx + 1}</span>
                        <button type="button" className="card-item-remove" onClick={() => removeProject(idx)}>删除</button>
                      </div>
                      <div className="import-form-grid">
                        <div className="import-field-item">
                          <label>项目名称 *</label>
                          <input
                            className="import-input"
                            value={proj.name || ''}
                            onChange={e => handleProjectChange(idx, 'name', e.target.value)}
                            placeholder="例如：智能简历填报插件"
                          />
                        </div>
                        <div className="import-field-item">
                          <label>担任角色</label>
                          <input
                            className="import-input"
                            value={proj.role || ''}
                            onChange={e => handleProjectChange(idx, 'role', e.target.value)}
                            placeholder="例如：核心开发者 / 项目负责人"
                          />
                        </div>
                        <div className="import-field-item" style={{ gridColumn: 'span 2' }}>
                          <label>项目起止时间</label>
                          <div className="date-range-inputs">
                            <input
                              className="import-input"
                              value={proj.startDate || ''}
                              onChange={e => handleProjectChange(idx, 'startDate', e.target.value)}
                              placeholder="开始：2023-09"
                            />
                            <span>至</span>
                            <input
                              className="import-input"
                              value={proj.endDate || ''}
                              onChange={e => handleProjectChange(idx, 'endDate', e.target.value)}
                              placeholder="结束：2024-01"
                            />
                          </div>
                        </div>
                        <div className="import-field-item" style={{ gridColumn: 'span 2' }}>
                          <label>项目描述与成果</label>
                          <textarea
                            className="import-textarea"
                            rows={3}
                            value={proj.description || ''}
                            onChange={e => handleProjectChange(idx, 'description', e.target.value)}
                            placeholder="描述项目背景、所用技术栈及成果..."
                          />
                        </div>
                      </div>
                    </div>
                  ))}
                  <button type="button" className="btn-add-item" onClick={addProject}>+ 添加更多项目经历</button>
                </div>
              )}
            </div>
          )}

          {/* Tab 5: Skills & Self Evaluation */}
          {activeTab === 'skills' && (
            <div className="import-section-pane">
              <div className="import-field-item" style={{ marginBottom: '20px' }}>
                <div className="import-field-label-row">
                  <label>专业技能 (逗号或换行分隔)</label>
                  <StatusBadge parsed={Boolean(parsedData?.skills?.length)} filled={Boolean(draft.skills?.length)} />
                </div>
                <textarea
                  className="import-textarea"
                  rows={3}
                  value={draft.skills.join('、')}
                  onChange={e => {
                    const items = e.target.value.split(/[、,，\n]+/).map(s => s.trim()).filter(Boolean);
                    setDraft(prev => ({ ...prev, skills: items }));
                  }}
                  placeholder="例如：JavaScript、TypeScript、React、Node.js、Git"
                />
              </div>

              <div className="import-field-item">
                <div className="import-field-label-row">
                  <label>自我评价 / 个人优势</label>
                  <StatusBadge parsed={isParsed('selfEvaluation')} filled={Boolean(draft.personal.selfEvaluation)} />
                </div>
                <textarea
                  className="import-textarea"
                  rows={4}
                  value={draft.personal.selfEvaluation || ''}
                  onChange={e => handlePersonalFieldChange('selfEvaluation', e.target.value)}
                  placeholder="自我评价或个人简述..."
                />
              </div>
            </div>
          )}
        </div>

        {/* Modal Footer */}
        <div className="import-review-footer">
          <div className="import-footer-left">
            <span className="import-footer-hint">核对修改将直接更新至通用资料库</span>
          </div>
          <div className="import-footer-actions">
            <button
              type="button"
              className="btn-review-dismiss"
              onClick={onDismiss}
              disabled={busy}
            >
              放弃导入
            </button>
            <button
              type="button"
              className="btn-review-apply"
              onClick={handleSubmit}
              disabled={busy}
            >
              {busy ? '正在写入资料库...' : '确认写入个人资料库'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function StatusBadge({ parsed, filled }: { parsed: boolean; filled: boolean }) {
  if (parsed && filled) {
    return <span className="status-badge parsed">已提取</span>;
  }
  if (!filled) {
    return <span className="status-badge missing">待补全</span>;
  }
  return <span className="status-badge filled">已填写</span>;
}

function FieldRow({
  label,
  parsed,
  value,
  onChange,
  placeholder,
}: {
  label: string;
  parsed: boolean;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
}) {
  return (
    <div className="import-field-item">
      <div className="import-field-label-row">
        <label>{label}</label>
        <StatusBadge parsed={parsed} filled={Boolean(value.trim())} />
      </div>
      <input
        type="text"
        className={`import-input${!value.trim() ? ' need-fill' : ''}`}
        value={value}
        onChange={e => onChange(e.target.value)}
        placeholder={placeholder}
      />
    </div>
  );
}
