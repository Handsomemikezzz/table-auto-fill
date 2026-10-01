import React, { useState } from 'react';
import type { UserProfile } from '../shared/types.ts';
import { getProfileRecords, PROFILE_RECORD_SECTIONS, SUPPLEMENTAL_COLLECTIONS, isLongProfileField, type ProfileRecordCollection } from '../shared/profileCollections.ts';

export function SupplementalProfileSection({ profile, onChange }: { profile: UserProfile; onChange: (profile: UserProfile) => void }) {
  const [newRecord, setNewRecord] = useState('');
  function add(collection: ProfileRecordCollection) {
    const id = crypto.randomUUID();
    const row = { id, ...Object.fromEntries(Object.keys(PROFILE_RECORD_SECTIONS[collection].fields).map(key => [key, ''])) };
    onChange({ ...profile, [collection]: [...getProfileRecords(profile, collection), row] });
    setNewRecord(id);
  }
  return <div className="supplemental-profile">
    <h2>更多个人资料</h2>
    <p className="resume-review-intro">获奖、论文、语言和其他经历都可以留在这里。上传简历后会预填写已识别的内容，也可以随时添加。没有的项目无需填写。</p>
    {SUPPLEMENTAL_COLLECTIONS.map(collection => {
      const section = PROFILE_RECORD_SECTIONS[collection], records = getProfileRecords(profile, collection);
      return <details key={collection} className="resume-review-card" open={records.length > 0}>
        <summary>{section.label} <span>{records.length} 条</span></summary>
        {records.length === 0 && <p className="resume-review-empty">尚未添加，可按需补充。</p>}
        {records.map((record, index) => <details key={record.id} className="resume-review-record" open={newRecord === record.id}>
          <summary><strong>{record[section.titleKey] || `新${section.label} ${index + 1}`}</strong><span>{record.date || record.startDate || ''}</span></summary>
          <div className="resume-review-grid">{Object.entries(section.fields).map(([key, label]) => <label className="resume-review-field" key={key}>
            <span>{label}</span>
            {React.createElement(isLongProfileField(key) ? 'textarea' : 'input', {
              'aria-label': `${section.label}-${index + 1}-${label}`, value: record[key] || '', rows: 4,
              placeholder: /date/i.test(key) ? '保留实际精度，如 2024 或 2024-06' : undefined,
              onChange: (event: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => onChange({ ...profile, [collection]: records.map(row => row.id === record.id ? { ...row, [key]: event.target.value } : row) }),
            })}
          </label>)}</div>
          <button type="button" className="supplemental-remove" onClick={() => onChange({ ...profile, [collection]: records.filter(row => row.id !== record.id) })}>删除此条资料</button>
        </details>)}
        <button type="button" className="btn btn-secondary" onClick={() => add(collection)}>添加{section.label}</button>
      </details>;
    })}
  </div>;
}
