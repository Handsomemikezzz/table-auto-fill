import React, { useEffect, useState } from 'react';
import { getChineseFieldLabel } from '../shared/fieldLabels.ts';
import type { ProfileImportChange } from '../autofill/profileImport.ts';

export function ProfileImportDraft({ changes, onApply, onDismiss }: { changes: ProfileImportChange[]; onApply: (changes: ProfileImportChange[]) => Promise<void>; onDismiss: () => void }) {
  const [draft, setDraft] = useState(changes);
  useEffect(() => { setDraft(changes); }, [changes]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  return <section className="settings-section" aria-label="确认资料更新"><h3>确认资料更新</h3><p>附件已保存。勾选需要写入通用资料的项目；已有资料的覆盖项默认不勾选。</p>
    {draft.length === 0 && <p>没有需要更新的资料。</p>}
    {draft.map((change, index) => <details key={change.key}><summary><label><input type="checkbox" checked={change.selected} disabled={busy} onChange={event => setDraft(draft.map((item, i) => i === index ? { ...item, selected: event.target.checked } : item))} /> {getChineseFieldLabel(change.label, change.label)}</label></summary>
      <p>当前值</p><pre style={{ whiteSpace: 'pre-wrap' }}>{typeof change.before === 'string' ? change.before || '未填写' : JSON.stringify(change.before, null, 2)}</pre>
      <p>解析值</p><pre style={{ whiteSpace: 'pre-wrap' }}>{typeof change.after === 'string' ? change.after : JSON.stringify(change.after, null, 2)}</pre>
    </details>)}
    <button disabled={busy || !draft.some(change => change.selected)} onClick={async () => { setBusy(true); try { await onApply(draft); } catch (error) { setError(error instanceof Error ? error.message : '保存失败'); } finally { setBusy(false); } }}>确认选中项并保存</button>
    <button disabled={busy} onClick={onDismiss}>只保留附件</button>{error && <p role="alert">{error}</p>}
  </section>;
}
