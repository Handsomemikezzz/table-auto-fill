import { getProfileRecords, PROFILE_RECORD_COLLECTIONS, PROFILE_RECORD_SECTIONS, isLongProfileField } from '../shared/profileCollections.ts';
import { createResumeProfileSnapshot } from '../shared/resumes.ts';
import { publicationTitleKey } from '../parsers/researchPublications.ts';
import React, { useEffect, useMemo, useRef, useState } from 'react';
import type { UserProfile, ParsedResumeData } from '../shared/types.ts';
import { createPrefilledReview, getReviewWarnings, REVIEW_PERSONAL_FIELDS } from '../autofill/resumeReview.ts';

export interface ProfileImportDraftProps {
  parsedData: ParsedResumeData; fileName?: string; currentProfile?: UserProfile;
  initialDraft?: UserProfile; warnings?: string[]; rawText?: string; extractionMethod?: string;
  onApply: (updated: UserProfile, baseline?: UserProfile) => Promise<void>;
  onDismiss: (draft?: UserProfile) => void;
}
const empty = (): UserProfile => ({ personal: { name: '', phone: '', email: '', birthDate: '', gender: '' }, education: [], experience: [], projects: [], skills: [], certifications: [], customInformation: [] });
export function ProfileImportDraft({ parsedData, fileName, currentProfile, initialDraft, warnings = [], rawText, extractionMethod, onApply, onDismiss }: ProfileImportDraftProps) {
  const [baseline] = useState(() => structuredClone(currentProfile || empty()));
  const [draft, setDraft] = useState(() => initialDraft || createPrefilledReview(baseline, parsedData));
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const differentName = Boolean(baseline.personal.name && parsedData?.personal?.name
    && baseline.personal.name.replace(/\s/g, '') !== parsedData.personal.name.replace(/\s/g, ''));
  const [identityAcknowledged, setIdentityAcknowledged] = useState(!differentName);
  const dialog = useRef<HTMLDivElement>(null), draftRef = useRef(draft);
  draftRef.current = draft;
  useEffect(() => {
    const previouslyFocused = document.activeElement as HTMLElement | null;
    dialog.current?.focus();
    return () => { previouslyFocused?.focus(); };
  }, []);
  const source = useMemo(() => parsedData ? createResumeProfileSnapshot(parsedData) : null, [parsedData]);
  const extractedCount = Object.values(parsedData?.personal || {}).filter(value => typeof value === 'string' && value.trim()).length
    + PROFILE_RECORD_COLLECTIONS.reduce((count, collection) => count + ((parsedData as unknown as Record<string, Record<string, unknown>[]> | undefined)?.[collection] || []).reduce((sum, record) => sum + Object.entries(record).filter(([key, value]) => key !== 'id' && typeof value === 'string' && value.trim()).length, 0), 0) + (parsedData?.skills?.length || 0);
  const conflicts = REVIEW_PERSONAL_FIELDS.filter(({ key }) => {
    const incoming = parsedData?.personal?.[key];
    return typeof incoming === 'string' && incoming.trim() && baseline.personal[key] && incoming !== baseline.personal[key];
  });
  const hints = [...warnings, ...(parsedData?.parsingWarnings || []), ...getReviewWarnings(draft)];
  const publicationCandidates = (parsedData?.publicationCandidates || []).filter(candidate => candidate.title && !getProfileRecords(draft, 'publications').some(row => publicationTitleKey(row.title) === publicationTitleKey(candidate.title!)));
  const personal = (key: string, value: string) => setDraft(previous => ({ ...previous, personal: { ...previous.personal, [key]: value } }));
  const dismiss = () => { if (!busy) onDismiss(draftRef.current); };
  const save = async () => {
    if (busy || !identityAcknowledged) return;
    setBusy(true); setError('');
    try { await onApply(draft, baseline); } catch (error) { setError(error instanceof Error ? error.message : '保存失败，请重试'); setBusy(false); }
  };
  const onKey = (event: React.KeyboardEvent) => {
    if (event.key === 'Escape') { event.preventDefault(); dismiss(); }
    if (event.key === 'Tab') {
      const nodes = Array.from(dialog.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input, textarea, summary, select, a[href]') || []).filter(node => node.getClientRects().length > 0);
      if (!nodes.length) return;
      const first = nodes[0], last = nodes[nodes.length - 1];
      if (event.shiftKey && (document.activeElement === first || document.activeElement === dialog.current)) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && (document.activeElement === last || document.activeElement === dialog.current)) { event.preventDefault(); first.focus(); }
    }
  };
  const renderPersonal = (keys: string[]) => REVIEW_PERSONAL_FIELDS.filter(field => keys.includes(field.key)).map(({ key, label, type }) => {
    const incoming = parsedData?.personal?.[key];
    const conflict = conflicts.some(field => field.key === key);
    const value = typeof draft.personal[key] === 'string' ? draft.personal[key] as string : '';
    return <label key={key} className="resume-review-field"><span>{label}<small>{value ? incoming === value ? '已预填写' : '已有资料' : '稍后补充'}</small></span>
      {key === 'selfEvaluation' ? <textarea aria-label={label} value={value} rows={4} onChange={event => personal(key, event.target.value)} /> : <input aria-label={label} type={type || 'text'} value={value} onChange={event => personal(key, event.target.value)} />}
      {conflict && <div className="resume-review-conflict"><span>简历识别：{String(incoming)}</span><button type="button" onClick={() => personal(key, String(incoming))}>用简历里的值</button><button type="button" onClick={() => personal(key, String(baseline.personal[key]))}>保留已有值</button></div>}
    </label>;
  });
  return <div className="import-review-overlay"><div className="import-review-modal resume-review" role="dialog" aria-modal="true" aria-labelledby="review-modal-title" tabIndex={-1} ref={dialog} onKeyDown={onKey}>
    <header className="resume-review-header"><div><span className="resume-review-eyebrow">最后确认一下</span><h2 id="review-modal-title">简历已为你预填写</h2><p>{fileName || '简历资料'} · 已整理 {extractedCount} 项信息{extractionMethod && extractionMethod !== 'text' ? ' · 含扫描文字识别' : ''}</p></div><button type="button" onClick={dismiss} disabled={busy} aria-label="暂存并关闭核对">关闭</button></header>
    <div className="import-review-body resume-review-content">
      <p className="resume-review-intro">核对已识别的内容即可。没有识别到的信息可以稍后补充，保存后就能用于申请表填写。</p>
      {error && <div role="alert" className="import-error-banner">{error}</div>}
      {hints.map((hint, index) => <p className="resume-review-warning" role="status" key={index}>{hint}</p>)}
      {conflicts.length > 0 && <p className="resume-review-warning">{conflicts.length} 项与已有资料不同，已默认保留已有值。你可以逐项改用简历里的值。</p>}
      {differentName && !identityAcknowledged && <div className="resume-review-warning">这份简历的姓名与已保存姓名不同，请先确认是否属于你。<button type="button" onClick={() => setIdentityAcknowledged(true)}>这是我的简历，继续核对</button></div>}
      <div className="resume-review-stats">{[['教育', draft.education.length], ['工作 / 实习', draft.experience.length], ['项目', draft.projects.length], ['获奖 / 论文', getProfileRecords(draft, 'awards').length + getProfileRecords(draft, 'publications').length], ['语言', getProfileRecords(draft, 'languages').length], ['技能', draft.skills.length]].map(([label, count]) => <span key={label}><strong>{count}</strong>{label}</span>)}</div>
      <section className="resume-review-card"><h3>先核对联系方式</h3><div className="resume-review-grid">{renderPersonal(['name', 'phone', 'email'])}</div></section>
      <details className="resume-review-card"><summary>其他基本资料 <span>已预填写，可按需修改</span></summary><div className="resume-review-grid">{renderPersonal(REVIEW_PERSONAL_FIELDS.filter(field => !['name', 'phone', 'email', 'selfEvaluation'].includes(field.key)).map(field => field.key))}</div></details>
      {PROFILE_RECORD_COLLECTIONS.map(collection => <details className="resume-review-card" key={collection} open={['education', 'experience', 'projects'].includes(collection) || getProfileRecords(draft, collection).length > 0 || (collection === 'publications' && publicationCandidates.length > 0)}>
        <summary>{PROFILE_RECORD_SECTIONS[collection].label} <span>{getProfileRecords(draft, collection).length} 条</span></summary>
        {!getProfileRecords(draft, collection).length && <p className="resume-review-empty">简历中未识别到此部分，可以稍后添加。</p>}
        {collection === 'publications' && publicationCandidates.length > 0 && <div className="resume-review-publication-candidates">
          <p>还发现 {publicationCandidates.length} 条会议研究线索。请确认是否属于论文；加入后可以继续修改。</p>
          {publicationCandidates.map((candidate, index) => <div className="resume-review-record" key={candidate.id || index}>
            <strong>{candidate.title}</strong><p>{candidate.venue}</p>
            <details><summary>查看原文线索</summary><pre className="resume-review-source">{candidate.description}</pre></details>
            <button type="button" disabled={busy} onClick={() => setDraft(previous => ({ ...previous, publications: [...(previous.publications || []), { ...candidate, id: `review-publication-${crypto.randomUUID()}`, title: candidate.title! }] }))}>加入论文与著作</button>
          </div>)}
        </div>}
        {getProfileRecords(draft, collection).map((record, index) => {
          const identity = PROFILE_RECORD_SECTIONS[collection].identity;
          const candidates = source ? getProfileRecords(source, collection) : [];
          const incoming = candidates.find(candidate => identity.every(key => record[key] && candidate[key] === record[key]));
          const before = getProfileRecords(baseline, collection).find(row => row.id === record.id);
          return <details className="resume-review-record" key={record.id}>
          <summary><strong>{record[PROFILE_RECORD_SECTIONS[collection].titleKey] || `${PROFILE_RECORD_SECTIONS[collection].label} ${index + 1}`}</strong><span>{[record.degree || record.position || record.role || record.test || record.venue || record.issuer || record.proficiency, record.date, record.startDate && `${record.startDate} — ${record.endDate || '未注明结束时间'}`].filter(Boolean).join(' · ')}</span></summary>
          <div className="resume-review-grid">{Object.entries(PROFILE_RECORD_SECTIONS[collection].fields).map(([key, label]) => <label className="resume-review-field" key={key}><span>{label}</span>{React.createElement(isLongProfileField(key) ? 'textarea' : 'input', { 'aria-label': `${collection}-${index + 1}-${label}`, value: record[key] || '', rows: 4, onChange: (event: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => setDraft(previous => ({ ...previous, [collection]: getProfileRecords(previous, collection).map((row, rowIndex) => rowIndex === index ? { ...row, [key]: event.target.value } : row) })) })}{incoming?.[key] && before?.[key] && incoming[key] !== before[key] && <div className="resume-review-conflict"><span>简历识别：{incoming[key]}</span><button type="button" onClick={() => setDraft(previous => ({ ...previous, [collection]: getProfileRecords(previous, collection).map((row, rowIndex) => rowIndex === index ? { ...row, [key]: incoming[key] } : row) }))}>用简历里的值</button></div>}</label>)}</div>
          <button type="button" onClick={() => setDraft(previous => ({ ...previous, [collection]: getProfileRecords(previous, collection).filter((_, rowIndex) => rowIndex !== index) }))}>不导入这条资料</button>
        </details>; })}
      </details>)}
      <details className="resume-review-card"><summary>技能与自评 <span>{draft.skills.length} 项技能</span></summary><label className="resume-review-field"><span>技能</span><textarea aria-label="技能" value={draft.skills.join('、')} onChange={event => setDraft(previous => ({ ...previous, skills: event.target.value.split(/[、,，\n]/).map(value => value.trim()).filter(Boolean) }))} /></label>{renderPersonal(['selfEvaluation'])}</details>
      {rawText && <details className="resume-review-card"><summary>查看识别原文</summary><pre className="resume-review-source">{rawText}</pre></details>}
    </div>
    <footer className="import-review-footer"><span>只保存你确认的资料，申请表仍由你检查和提交。</span><div className="import-footer-actions"><button type="button" className="btn-review-dismiss" onClick={dismiss} disabled={busy}>暂存草稿</button><button type="button" className="btn-review-apply" onClick={save} disabled={busy || !identityAcknowledged}>{busy ? '正在保存…' : '确认并保存资料'}</button></div></footer>
  </div></div>;
}
