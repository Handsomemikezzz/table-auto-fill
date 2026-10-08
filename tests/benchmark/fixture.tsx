import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { createPageObserver } from '../../src/content/pageObservation';
import { createFieldRegistry } from '../../src/autofill/fieldRegistry';
import { createProfileSnapshot } from '../../src/autofill/profileSnapshot';
import { getPersonalAdditionalFields } from '../../src/shared/personalFields';
import type { UserProfile } from '../../src/shared/types';
import './fixture.css';

type Field = { id: string; label: string; kind: string; initial?: string; existing?: string; placeholder?: string; name?: string; vendorName?: string; options?: string[]; optionValues?: string[]; readonly?: boolean; unwrappedRadio?: boolean; delayMs?: number; rejectWrites?: boolean };
type Source = { id: string; title: string; renderer: string; sections: { title: string; records: { title: string; fields: Field[] }[] }[] };
const params = new URLSearchParams(location.search);
const source: Source = await fetch(`/sources/${params.get('site')}.json`).then(r => { if (!r.ok) throw new Error('Unknown fixture'); return r.json(); });
const initial: Record<string, string> = {};
for (const section of source.sections) for (const record of section.records) for (const field of record.fields) {
  const value = params.get('state') === 'existing' ? field.existing ?? field.initial ?? '' : field.initial ?? '';
  if (['range', 'split-date'].includes(field.kind)) { initial[field.id + '-a'] = ''; initial[field.id + '-b'] = ''; }
  else initial[field.id] = value;
}
let businessState = { ...initial };
let submitted = 0;
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

export function Combo({ field, value, update }: { field: Field; value: string; update: (id: string, value: string) => void }) {
  const [open, setOpen] = useState(false);
  const [ready, setReady] = useState(false);
  const [query, setQuery] = useState('');
  useEffect(() => { if (!open) { setReady(false); return; } const timer = setTimeout(() => setReady(true), field.delayMs || 0); return () => clearTimeout(timer); }, [open, field.delayMs]);
  const moka = source.renderer === 'moka';
  return <div className={moka ? 'sd-Dropdown-container-1CigZ' : ''}>
    <div id={field.id} className={moka ? 'sd-Input-container-2S_vM sd-Select-container-1Eq4x' : 'ud__select'}>
      <div className={moka ? '' : 'ud__select__selector'} onClick={() => setOpen(previous => !previous)}>
        <input className={moka ? 'sd-Input-input-10L0t sd-Input-common-input-1XimE' : 'ud__select__selector__search__input ud__native-input'} role={moka ? undefined : 'combobox'} type={moka ? 'text' : 'search'}
          placeholder={field.placeholder} readOnly={!moka} value={moka ? (open ? query : value) : ''} onChange={event => setQuery(event.target.value)} />
        {!moka && value && <span className="ud__select__selector__selectItem">{value}</span>}
      </div>
    </div>
    {open && <div className={moka ? 'sd-Menu-content-container' : 'ud__select__dropdown'} role={moka ? undefined : 'listbox'}>
      {ready ? field.options?.map(option => <div key={option} className={moka ? 'sd-Menu-content-item-3BOO1' : 'ud__select__list__item'} onClick={() => { update(field.id, option); setQuery(''); setOpen(false); }}><div className={moka ? 'option-label-p2B4XVc4Pn' : ''}>{option}</div></div>) : <span>加载中…</span>}
    </div>}
  </div>;
}

export function Fixture() {
  const [values, setValues] = useState(initial);
  businessState = values;
  const update = (id: string, value: string) => setValues(previous => ({ ...previous, [id]: value }));
  const control = (f: Field) => {
    const value = values[f.id] || '';
    const text = (id: string, type = 'text') => <input id={id} name={f.name} type={type} placeholder={f.placeholder} readOnly={f.readonly}
      className={source.renderer === 'ud' ? 'ud__native-input' : source.renderer === 'moka' ? 'sd-Input-input-10L0t sd-Input-common-input-1XimE' : undefined}
      {...(f.vendorName ? { 'data-form-field-name': f.vendorName, 'data-form-field-i18n-name': f.label } : {})}
      value={values[id] || ''} onChange={event => { if (f.rejectWrites) { setValues(previous => ({ ...previous })); return; } update(id, event.target.value); }} />;
    if (f.kind === 'combo') return <Combo field={f} value={value} update={update} />;
    if (f.kind === 'select') return <select id={f.id} name={f.name} value={value} onChange={event => update(f.id, event.target.value)}><option value="">请选择</option>{f.options?.map((label, index) => <option key={label} value={f.optionValues?.[index] || label}>{label}</option>)}</select>;
    if (f.kind === 'radio') return <div id={f.id}>{f.options?.map((label, index) => <React.Fragment key={label}><input name={f.name || f.id} type="radio" value={f.optionValues?.[index] || label} checked={value === (f.optionValues?.[index] || label)} onChange={() => update(f.id, f.optionValues?.[index] || label)} />{label}</React.Fragment>)}</div>;
    if (f.kind === 'checkbox') return <label><input id={f.id} type="checkbox" checked={value === 'true'} onChange={event => update(f.id, String(event.target.checked))} />{f.label}</label>;
    if (f.kind === 'file') return <input id={f.id} name={f.name} type="file" accept=".pdf,.docx" />;
    if (f.kind === 'range') return <div className="throne-biz-date-range-picker-wrapper">{['a', 'b'].map((part, i) => <React.Fragment key={part}>{i === 1 && <span>—</span>}<div className="throne-biz-date-range-picker-input"><div className="ud__input"><label className="ud__input-input-wrap"><div className="ud__input-input__placeholder__wrapper">{text(f.id + '-' + part)}</div></label></div></div></React.Fragment>)}</div>;
    if (f.kind === 'split-date') return <div className="split-date"><Combo field={{ ...f, id: f.id + '-a', placeholder: '年' }} value={values[f.id + '-a']} update={update} /><Combo field={{ ...f, id: f.id + '-b', placeholder: '月', options: Array.from({ length: 12 }, (_, i) => String(i + 1)) }} value={values[f.id + '-b']} update={update} /></div>;
    return text(f.id, f.kind === 'month' ? 'month' : (f as Field & { inputType?: string }).inputType || 'text');
  };
  return <main><h1>{source.title}</h1><form onSubmit={event => { event.preventDefault(); submitted++; }}>
    {source.sections.map(section => <section key={section.title} className={source.renderer === 'ud' ? 'applyFormModuleWrapper__observed' : ''}>
      <div className="applyFormModuleWrapper-left"><h2>{section.title}</h2></div>
      <div className="applyFormModuleWrapper-right">{section.records.map((record, i) => {
        const fields = record.fields.map(f => <div key={f.id} className={source.renderer === 'moka' ? 'apply-field-Q2iJ7AtQGX' : source.renderer === 'ud' ? 'ud-formily-item' : 'field'}
          {...(f.vendorName ? { 'data-form-field-name': f.vendorName, 'data-form-field-i18n-name': f.label } : {})}>
          {f.kind !== 'checkbox' && <div className={source.renderer === 'moka' ? 'title-IWWQ0Xa4L7' : source.renderer === 'ud' ? 'ud-formily-item-label' : ''}><label htmlFor={source.renderer === 'native' && f.name ? f.name : undefined}>{f.label}</label></div>}
          <div className={source.renderer === 'moka' ? 'ctrl-CICMG4Fr4_' : 'ud-formily-item-control'}>{control(f)}</div>
        </div>);
        // Repeated records belong only to the explicitly synthetic long-form case.
        return record.title ? <fieldset key={i}><legend>{record.title}</legend>{fields}</fieldset> : <div key={i} className="register-form-group-wrapper">{fields}</div>;
      })}</div>
    </section>)}
    <button type="submit">提交（仅本地计数）</button>
  </form></main>;
}
createRoot(document.getElementById('root')!).render(<Fixture />);

// Test-only, read-only probe. The filler still runs in the actual dist extension.
// No gold, expected values or semantic IDs appear in form attributes.
(window as any).benchmarkFixture = {
  snapshot: () => ({ values: { ...businessState }, submitted, files: Object.fromEntries([...document.querySelectorAll<HTMLInputElement>('input[type=file]')].map(e => [e.id, e.files?.length || 0])) }),
  scan: (profile: UserProfile, referenceDate: string) => {
    const registry = createFieldRegistry(getPersonalAdditionalFields(profile));
    const observer = createPageObserver(registry, undefined, createProfileSnapshot(profile, 'default', registry, referenceDate));
    return observer.observe().map(field => ({ label: field.label, kind: field.kind, controlId: observer.nodes.get(field.fieldId)?.closest('[id^="control-"]')?.id || null }));
  },
  ready: async () => { await delay(50); return Boolean(document.querySelector('form input')); },
};
