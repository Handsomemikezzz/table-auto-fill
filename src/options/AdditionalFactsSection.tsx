import React from 'react';
import type { AdditionalFact } from '../autofill/contracts.ts';

export function AdditionalFactsSection({ facts, onChange }: { facts: AdditionalFact[]; onChange: (facts: AdditionalFact[]) => void }) {
  const update = (id: string, changes: Partial<AdditionalFact>) => onChange(facts.map(fact => fact.id === id ? { ...fact, ...changes, updatedAt: new Date().toISOString() } : fact));
  return <section className="personal-additional-facts" aria-label="其他个人资料"><h3>其他个人资料</h3><p>可添加其他信息名称和内容，保存后在不同页面复用。没有的内容可不填写。</p>
    {facts.map(fact => <fieldset key={fact.id} style={{ marginBottom: 12 }}><legend>{fact.label || '新信息'}</legend>
      <label>信息名称<input value={fact.label} onChange={event => update(fact.id, { label: event.target.value })} /></label>
      <label>这项信息属于谁<select value={fact.subject} onChange={event => update(fact.id, { subject: event.target.value })}><option value="self">本人</option><option value="emergencyContact">紧急联系人</option><option value="guardian">监护人</option>{!["self", "emergencyContact", "guardian"].includes(fact.subject) && <option value={fact.subject}>其他</option>}</select></label>
      <label>类型<select value={fact.valueType} onChange={event => update(fact.id, { valueType: event.target.value as AdditionalFact['valueType'] })}><option value="text">文本</option><option value="date">日期（保留实际精度）</option></select></label>
      <label>答案<textarea value={fact.value} onChange={event => update(fact.id, { value: event.target.value })} /></label>
      <label>有效至（可选）<input type="date" value={fact.expiresAt || ''} onChange={event => update(fact.id, { expiresAt: event.target.value || undefined })} /></label>
      <small>更新于 {fact.updatedAt}</small><button type="button" onClick={() => onChange(facts.filter(item => item.id !== fact.id))}>删除</button>
    </fieldset>)}
    <button type="button" onClick={() => { const id = crypto.randomUUID(); onChange([...facts, { id, meaningId: `additional.${id}`, label: '', subject: 'self', value: '', valueType: 'text', updatedAt: new Date().toISOString() }]); }}>添加个人信息</button>
  </section>;
}
