import React, { useState } from 'react';
import { adaptDateValue } from '../../src/utils/dateValue';

// Reproduces the inspected public DOM structure, without account or personal data.
export function ObservedDateRange({ mode = 'range' }: { mode?: 'range' | 'text' | 'invented-day' }) {
  const [values, setValues] = useState<Record<string, string>>({});
  const input = (id: string, dateWidget = true) => {
    const control = <input id={id} className={dateWidget ? 'ud__native-input' : undefined} value={values[id] || ''}
      onChange={event => { const incoming = event.target.value; const value = mode === 'range' ? incoming : adaptDateValue(incoming, { inputType: 'month' }) + (mode === 'invented-day' ? '-01' : ''); setValues(previous => ({ ...previous, [id]: value })); }}
      onBlur={event => { const normalized = adaptDateValue(event.currentTarget.value, { inputType: 'month' }); setValues(previous => ({ ...previous, [id]: normalized + (mode === 'invented-day' ? '-01' : '') })); }} />;
    return dateWidget ? <div className="throne-biz-date-range-picker-input"><div className="ud__input ud__input--size-lg"><label className="ud__input-input-wrap"><div className="ud__input-input__placeholder__wrapper">
      {control}
    </div></label></div></div> : <label>{control}</label>;
  };
  const range = (name: string, title: string, description: string) => <div className="applyFormModuleWrapper__observed">
    <div className="applyFormModuleWrapper-left"><p>{title}</p></div>
    <div className="applyFormModuleWrapper-right"><div className="ud-formily-item"><div className="ud-formily-item-control"><div className="ud-formily-item-control-content"><div className="ud-formily-item-control-content-component"><div className="apply-form-array-card__observed"><div className="apply-form-array-card-content__observed"><div className="register-form-group-wrapper">
      <div data-form-field-name="start_end_time" data-form-field-id="start_end_time" data-form-field-i18n-name="起止时间" className="ud-formily-item">
        <div className="ud-formily-item-label"><div><span><label>起止时间</label></span></div></div>
        <div className="ud-formily-item-label-desc">{description}</div>
        <div className="ud-formily-item-control"><div className="ud-formily-item-control-content"><div className="ud-formily-item-control-content-component"><div className="throne-biz-date-range-picker-wrapper">
          {input(`${name}-a`)}<span>—</span>{input(`${name}-b`)}
        </div></div></div></div>
      </div>
    </div></div></div></div></div></div></div></div>
  </div>;
  return <form onSubmit={event => event.preventDefault()}>
    {mode === 'range' ? <>{range('edu', '教育经历', '无准确的毕业时间可填写预计毕业时间')}{range('work', '工作经历', '')}</> : input('plain', false)}
    <output id="react-state">{JSON.stringify(values)}</output>
  </form>;
}

