import React from 'react';
import type { AdditionalFact } from '../autofill/contracts.ts';

export function AdditionalFactsSection({ facts, onChange }: { facts: AdditionalFact[]; onChange: (facts: AdditionalFact[]) => void }) {
  const update = (id: string, changes: Partial<AdditionalFact>) => onChange(facts.map(fact => fact.id === id ? { ...fact, ...changes, updatedAt: new Date().toISOString() } : fact));
  return <section aria-label="补充事实"><h3>补充事实</h3><p>明确字段含义、信息主体和真实答案。模型在每次填写时重新核对。</p>
    {facts.map(fact => <fieldset key={fact.id} style={{ marginBottom: 12 }}><legend>{fact.label || '新事实'}</legend>
      <label>字段含义<input value={fact.label} onChange={event => update(fact.id, { label: event.target.value })} /></label>
      <label>信息主体<input value={fact.subject} placeholder="self / emergencyContact" onChange={event => update(fact.id, { subject: event.target.value })} /></label>
      <label>类型<select value={fact.valueType} onChange={event => update(fact.id, { valueType: event.target.value as AdditionalFact['valueType'] })}><option value="text">文本</option><option value="date">日期（保留实际精度）</option></select></label>
      <label>答案<textarea value={fact.value} onChange={event => update(fact.id, { value: event.target.value })} /></label>
      <label>有效至（可选）<input type="date" value={fact.expiresAt || ''} onChange={event => update(fact.id, { expiresAt: event.target.value || undefined })} /></label>
      <small>更新于 {fact.updatedAt}</small><button type="button" onClick={() => onChange(facts.filter(item => item.id !== fact.id))}>删除</button>
    </fieldset>)}
    <button type="button" onClick={() => { const id = crypto.randomUUID(); onChange([...facts, { id, meaningId: `additional.${id}`, label: '', subject: 'self', value: '', valueType: 'text', updatedAt: new Date().toISOString() }]); }}>添加补充事实</button>
  </section>;
}
