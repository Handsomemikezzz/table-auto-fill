import React, { useState } from 'react';
import type { UserProfile } from '../shared/types.ts';
import {
  getProfileRecords,
  PROFILE_RECORD_SECTIONS,
  SUPPLEMENTAL_COLLECTIONS,
  isLongProfileField,
  type ProfileRecordCollection,
} from '../shared/profileCollections.ts';

export function SupplementalProfileSection({ profile, onChange }: { profile: UserProfile; onChange: (profile: UserProfile) => void }) {
  const [newRecord, setNewRecord] = useState('');

  function add(collection: ProfileRecordCollection) {
    const id = crypto.randomUUID();
    const row = { id, ...Object.fromEntries(Object.keys(PROFILE_RECORD_SECTIONS[collection].fields).map(key => [key, ''])) };
    onChange({ ...profile, [collection]: [...getProfileRecords(profile, collection), row] });
    setNewRecord(id);
  }

  return (
    <div className="supplemental-profile">
      <h2 className="section-title">更多个人资料</h2>
      <p className="supplemental-description">获奖、论文、语言和其他经历都可以留在这里。上传简历后会预填写已识别的内容，也可以随时添加。没有的项目无需填写。</p>
      <div className="supplemental-groups">
        {SUPPLEMENTAL_COLLECTIONS.map(collection => {
          const section = PROFILE_RECORD_SECTIONS[collection];
          const records = getProfileRecords(profile, collection);
          return (
            <details key={collection} className="supplemental-group" open={records.length > 0}>
              <summary className="supplemental-group-summary">
                <span className="supplemental-group-title">{section.label}</span>
                <span className={`supplemental-count${records.length ? ' has-records' : ''}`}>{records.length} 条</span>
                <span className="supplemental-chevron" aria-hidden="true" />
              </summary>
              <div className="supplemental-group-content">
                {records.length === 0 && <p className="supplemental-empty">尚未添加{section.label}，可从简历中提取或手动补充。</p>}
                <div className="supplemental-records">
                  {records.map((record, index) => {
                    const metadata = [
                      record.venue || record.issuer || record.test || record.role,
                      record.date || (record.startDate && [record.startDate, record.endDate].filter(Boolean).join(' — ')),
                    ].filter(Boolean).join(' · ');
                    return (
                      <details key={record.id} className="supplemental-record" open={newRecord === record.id}>
                        <summary className="supplemental-record-summary">
                          <span className="supplemental-record-index" aria-hidden="true">{String(index + 1).padStart(2, '0')}</span>
                          <span className="supplemental-record-heading">
                            <strong>{record[section.titleKey] || `新${section.label} ${index + 1}`}</strong>
                            {metadata && <span className="supplemental-record-meta">{metadata}</span>}
                          </span>
                          <span className="supplemental-chevron" aria-hidden="true" />
                        </summary>
                        <div className="supplemental-record-content">
                          <div className="supplemental-fields">
                            {Object.entries(section.fields).map(([key, label]) => (
                              <label className={`supplemental-field${isLongProfileField(key) || key === 'title' ? ' supplemental-field-wide' : ''}`} key={key}>
                                <span>{label}</span>
                                {React.createElement(isLongProfileField(key) ? 'textarea' : 'input', {
                                  'aria-label': `${section.label}-${index + 1}-${label}`,
                                  value: record[key] || '',
                                  rows: isLongProfileField(key) ? 4 : undefined,
                                  placeholder: /date/i.test(key) ? '保留实际精度，如 2024 或 2024-06' : undefined,
                                  onChange: (event: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => onChange({
                                    ...profile,
                                    [collection]: records.map(row => row.id === record.id ? { ...row, [key]: event.target.value } : row),
                                  }),
                                })}
                              </label>
                            ))}
                          </div>
                          <div className="supplemental-record-actions">
                            <button type="button" className="supplemental-remove" onClick={() => onChange({ ...profile, [collection]: records.filter(row => row.id !== record.id) })}>删除此条资料</button>
                          </div>
                        </div>
                      </details>
                    );
                  })}
                </div>
                <button type="button" className="btn btn-secondary supplemental-add" onClick={() => add(collection)}>
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><path d="M12 5v14M5 12h14" /></svg>
                  添加{section.label}
                </button>
              </div>
            </details>
          );
        })}
      </div>
    </div>
  );
}
