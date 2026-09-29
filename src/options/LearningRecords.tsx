import React, { useEffect, useState } from 'react';
import { MessageService } from '../shared/message.ts';
import type { ControlExperience, MeaningCorrection } from '../autofill/contracts.ts';

export function LearningRecords() {
  const [items, setItems] = useState<MeaningCorrection[]>([]);
  const [experiences, setExperiences] = useState<ControlExperience[]>([]);
  const [error, setError] = useState('');
  const load = async () => { const result = await MessageService.sendMessage<MeaningCorrection[]>({ type: 'GET_MEANING_CORRECTIONS' }); if (result.success) setItems(result.data || []); else setError(result.error || '无法读取学习记录'); };
  const loadExperiences = async () => { const response = await MessageService.sendMessage<ControlExperience[]>({ type: 'GET_CONTROL_EXPERIENCES' }); if (response.success) setExperiences(response.data || []); };
  useEffect(() => { void load(); void loadExperiences(); }, []);
  const change = async (id: string, enabled?: boolean, remove?: boolean) => { const result = await MessageService.sendMessage({ type: 'UPDATE_MEANING_CORRECTION', payload: { id, enabled, remove } }); if (!result.success) setError(result.error || '保存失败'); else await load(); };
  return <details><summary>学习记录</summary><p>仅使用你确认过的含义。网站、字段结构、选项、资料或字段定义版本变化后，旧记录不再生效。</p>
    {!items.length && <p>还没有确认过的字段含义。</p>}
    {items.map(item => <div key={item.id}><p>{item.origin} · {item.meaningId}{item.recordId ? ` · ${item.recordId}` : ''}</p><small>确认于 {item.confirmedAt} · 资料版本 {item.profileVersion}</small><label><input type="checkbox" checked={item.enabled} onChange={event => void change(item.id, event.target.checked)} />启用</label><button type="button" onClick={() => void change(item.id, undefined, true)}>删除 / 撤销</button></div>)}
    <h4>控件操作经验</h4><p>只记录验证过的操作方式，供模型参考。不会把网站编码保存为个人答案。</p>
    {experiences.map(item => <div key={item.id}><p>{item.origin} · {item.adapterId} · {item.action}</p><small>验证于 {item.verifiedAt}</small><label><input type="checkbox" checked={item.enabled} onChange={async event => { await MessageService.sendMessage({ type: 'UPDATE_CONTROL_EXPERIENCE', payload: { id: item.id, enabled: event.target.checked } }); await loadExperiences(); }} />启用</label><button type="button" onClick={async () => { await MessageService.sendMessage({ type: 'UPDATE_CONTROL_EXPERIENCE', payload: { id: item.id, remove: true } }); await loadExperiences(); }}>删除</button></div>)}
    {error && <p role="alert">{error}</p>}
  </details>;
}
