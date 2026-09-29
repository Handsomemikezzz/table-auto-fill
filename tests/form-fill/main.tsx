import { ObservedDateRange } from './ObservedDateRange';
import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { Cascader, DatePicker, Select } from 'antd';
import dayjs from 'dayjs';

// Actual React controlled inputs: the runner checks both rendered DOM and this
// component state. A DOM-only assignment cannot make a regression test pass.
export function Fixture({ scenario }: { scenario: string }) {
  const [state, setState] = useState<Record<string, string>>({
    ...(scenario === 'existing-radio' ? { gender: 'f' } : {}),
    ...(scenario === 'existing-text' ? { name: '用户原有姓名' } : {}),
  });
  const [expanded, setExpanded] = useState(false);
  const [query, setQuery] = useState(scenario === 'search-highlight' ? '男' : '');
  const [ready, setReady] = useState(false);
  const [treeExpanded, setTreeExpanded] = useState<Record<string, boolean>>({ other: true, 'other-city': true });
  const update = (key: string, value: string) => setState(previous => ({
    ...previous, [key]: value,
    ...(scenario === 'linked' && key === 'email' ? { name: '' } : {}),
  }));
  useEffect(() => {
    if (scenario !== 'rollback' || !state.name) return;
    const timer = setTimeout(() => setState(previous => ({ ...previous, name: '' })), 180);
    return () => clearTimeout(timer);
  }, [scenario, state.name]);
  useEffect(() => {
    if (!expanded) return;
    const timer = setTimeout(() => setReady(true), 120);
    return () => clearTimeout(timer);
  }, [expanded]);

  if (scenario === 'feishu-deep-range') return <ObservedDateRange />;

  const text = (id: string, label: string, type = 'text') => <div className="field" key={id}>
    <label htmlFor={id}>{label}</label>
    <input id={id} name={id} type={type} value={state[id] || ''}
      onChange={event => update(id, event.target.value)} />
  </div>;
  const genderOptions = scenario === 'select-one'
    ? [{ label: '女', value: '0' }, { label: '男', value: '1' }]
    : [{ label: '男', value: '0' }, { label: '女', value: '1' }];
  const comboOptions = scenario === 'unrelated-popup'
    ? [{ label: '女', value: 'f' }]
    : [{ label: '女', value: 'f' }, { label: '男', value: 'm' }];
  const choose = (value: string, label: string) => {
    if (['search-rejected', 'search-highlight'].includes(scenario)) return;
    update('gender', value);
    setQuery(label);
    setExpanded(false);
  };

  return <main>
    <h1>本地表单回归：{scenario}</h1>
    <form onSubmit={event => event.preventDefault()}>
      {['react-text', 'rollback', 'user-edit', 'existing-text', 'linked', 'ai-cancel', 'personal-extra'].includes(scenario) && text('name', '姓名')}
      {['linked', 'ai-cancel'].includes(scenario) && text('email', '邮箱', 'email')}
      {scenario === 'personal-extra' && <>
        {text('age', '年龄', 'number')}{text('portfolioUrl', '作品集链接', 'url')}
        {text('preferredCities', '意向城市')}{text('languageSkills', '语言能力')}
        <fieldset><legend>推荐方式*</legend>{['内推', '大使推荐'].map((value, index) => <label key={value}><input type="radio" id={`referral-${index}`} name="referral" value={value} checked={state.referral === value} onChange={() => update('referral', value)} />{value}</label>)}</fieldset>
      </>}
      {scenario === 'ai-cancel' && <label>上传简历<input id="resume" type="file" accept=".pdf" /></label>}
      {scenario.startsWith('select-') && <div className="field">
        <label htmlFor="gender">性别</label>
        <select id="gender" name="gender" value={state.gender ?? ''}
          onChange={event => update('gender', event.target.value)}>
          <option value="">请选择</option>
          {genderOptions.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
        </select>
      </div>}
      {scenario === 'ant-select' && <div className="field">
        <label htmlFor="gender">性别</label>
        <Select id="gender" placeholder="请选择" value={state.gender || undefined}
          options={[{ value: 'f', label: '女' }, { value: 'm', label: '男' }]}
          onChange={value => update('gender', value)} />
      </div>}
      {['radio-zero', 'existing-radio'].includes(scenario) && <fieldset>
        <legend>性别</legend>
        {[
          { label: '男', value: scenario === 'radio-zero' ? '0' : 'm' },
          { label: '女', value: scenario === 'radio-zero' ? '1' : 'f' },
        ].map(option => <label key={option.value}>
          <input id={`gender-${option.value}`} type="radio" name="gender" value={option.value}
            checked={state.gender === option.value} onChange={() => update('gender', option.value)} />{option.label}
        </label>)}
      </fieldset>}
      {scenario === 'aria-radio' && <div role="radiogroup" aria-labelledby="aria-gender-label">
        <span id="aria-gender-label">性别</span>
        {['女', '男'].map((label, index) => <button key={label} type="button" role="radio"
          id={`aria-${index}`} aria-checked={state.gender === label} onClick={() => update('gender', label)}>{label}</button>)}
      </div>}
      {['aria-combobox', 'search-rejected', 'search-highlight', 'unrelated-popup'].includes(scenario) && <div className="field">
        <label id="gender-label" htmlFor="gender">性别</label>
        {scenario === 'aria-combobox' ? <button id="gender" type="button" role="combobox"
          aria-labelledby="gender-label" aria-expanded={expanded} aria-controls="gender-options"
          onClick={() => setExpanded(true)}>{state.gender === 'm' ? '男' : state.gender === 'f' ? '女' : '请选择'}</button>
          : <input id="gender" name="gender" role="combobox" aria-labelledby="gender-label"
            aria-expanded={expanded} aria-controls="gender-options" aria-autocomplete="list" value={query}
            aria-activedescendant={scenario === 'search-highlight' ? 'gender-option-m' : undefined}
            onClick={() => setExpanded(true)} onChange={event => { setQuery(event.target.value); setExpanded(true); }} />}
        <div id="gender-options" role="listbox" hidden={!expanded}>
          {ready && comboOptions.map(option => <div key={option.value} id={`gender-option-${option.value}`} role="option"
            aria-selected={state.gender === option.value || (scenario === 'search-highlight' && option.value === 'm')} data-value={option.value}
            onClick={() => choose(option.value, option.label)}>{option.label}</div>)}
        </div>
      </div>}
      {scenario === 'unrelated-popup' && <div id="unrelated-options" role="listbox">
        <div role="option" aria-selected={state.unrelated === '男'} onClick={() => update('unrelated', '男')}>男</div>
      </div>}
      {scenario === 'month' && text('birthDate', '出生年月', 'month')}
      {scenario === 'day-precision' && text('birthDate', '出生日期', 'date')}
      {['picker-day', 'picker-month'].includes(scenario) && <div className="field">
        <label htmlFor="birthDate">{scenario === 'picker-month' ? '出生年月' : '出生日期'}</label>
        <DatePicker id="birthDate" inputReadOnly picker={scenario === 'picker-month' ? 'month' : 'date'}
          placeholder={scenario === 'picker-month' ? 'YYYY-MM' : 'YYYY-MM-DD'}
          defaultPickerValue={dayjs('2000-06-15')} value={state.birthDate ? dayjs(state.birthDate) : null}
          onChange={(_value, formatted) => update('birthDate', String(formatted))} />
      </div>}
      {scenario === 'unknown-picker' && <div className="field">
        <label htmlFor="birthDate">出生日期</label>
        <input id="birthDate" readOnly value="" onClick={() => setExpanded(true)} />
        {expanded && <div>无法观察到年月含义的专有面板</div>}
      </div>}
      {scenario === 'cascader' && <div className="field">
        <label id="region-label" htmlFor="region">现居地</label>
        <button id="region" type="button" role="combobox" aria-haspopup="tree"
          aria-labelledby="region-label" aria-controls="region-tree" aria-expanded={expanded}
          aria-valuetext={state.region || ''} onClick={() => setExpanded(true)}>{state.region || '请选择'}</button>
        <div id="region-tree" role="tree" hidden={!expanded}>
          {[
            { id: 'other', label: '其他省', cityId: 'other-city' },
            { id: 'sichuan', label: '四川省', cityId: 'chengdu' },
          ].map(province => <div key={province.id} role="treeitem" aria-label={province.label}
            aria-expanded={Boolean(treeExpanded[province.id])} onClick={event => {
              event.stopPropagation(); setTreeExpanded(previous => ({ ...previous, [province.id]: true }));
            }}>
            <span>{province.label}</span>
            <div role="group" hidden={!treeExpanded[province.id]}>
              <div role="treeitem" aria-label="成都市" aria-expanded={Boolean(treeExpanded[province.cityId])}
                onClick={event => { event.stopPropagation(); setTreeExpanded(previous => ({ ...previous, [province.cityId]: true })); }}>
                <span>成都市</span>
                <div role="group" hidden={!treeExpanded[province.cityId]}>
                  <div role="treeitem" aria-label="武侯区"
                    aria-selected={state.region === `${province.label} / 成都市 / 武侯区`}
                    onClick={event => {
                      event.stopPropagation(); update('region', `${province.label} / 成都市 / 武侯区`); setExpanded(false);
                    }}>武侯区</div>
                </div>
              </div>
            </div>
          </div>)}
        </div>
      </div>}
      {scenario === 'ant-cascader' && <div className="field">
        <label htmlFor="region">现居地</label>
        <Cascader id="region" placeholder="请选择" value={state.region ? ['sc', 'cd', 'wh'] : []}
          options={[
            { value: 'other', label: '其他省', children: [{ value: 'other-city', label: '成都市', children: [{ value: 'other-district', label: '武侯区' }] }] },
            { value: 'sc', label: '四川省', children: [{ value: 'cd', label: '成都市', children: [{ value: 'wh', label: '武侯区' }] }] },
          ]}
          onChange={(_value, selected) => update('region', selected.map(option => option.label).join(' / '))} />
      </div>}
      {scenario === 'education' && <section aria-label="教育经历">
        <fieldset><legend>硕士研究生教育经历</legend>
          {text('graduate-school', '研究生学校')}
          {text('graduate-start', '研究生入学时间', 'month')}
        </fieldset>
        <fieldset><legend>本科教育经历</legend>
          {text('undergraduate-school', '本科学校')}
          {text('undergraduate-start', '本科入学时间', 'month')}
          {text('undergraduate-end', '本科毕业时间', 'month')}
        </fieldset>
      </section>}
      {scenario === 'education-range' && <fieldset><legend>本科教育经历</legend>
        {text('school', '学校名称')}
        <div className="field"><label>起止时间</label>
          <input id="range-start" type="month" value={state['range-start'] || ''} onChange={event => update('range-start', event.target.value)} />
          <span>—</span>
          <input id="range-end" type="month" value={state['range-end'] || ''} onChange={event => update('range-end', event.target.value)} />
        </div>
      </fieldset>}
      <button type="button" id="blur-target">移出字段</button>
    </form>
    <output id="react-state">{JSON.stringify(state)}</output>
  </main>;
}

const root = createRoot(document.getElementById('root')!);
let version = 0;
let sessionFiller: import('../../src/content/formFiller.ts').FormFiller | undefined;
const fixture = {
  render(scenario: string) {
    flushSync(() => root.render(<Fixture key={++version} scenario={scenario} />));
    return true;
  },
  snapshot() {
    return {
      state: JSON.parse(document.getElementById('react-state')!.textContent!),
      values: Object.fromEntries(Array.from(document.querySelectorAll<HTMLInputElement | HTMLSelectElement>('input,select'))
        .map(input => [input.id, input.type === 'radio' ? (input as HTMLInputElement).checked : input.value])),
    };
  },
  async fill(selector: string, value: string, context: Record<string, unknown> = {}) {
    const { fillControl } = await import('../../src/content/fillEngine.ts');
    const target = document.querySelector<HTMLElement>(selector);
    if (!target) throw new Error(`Fixture target missing: ${selector}`);
    return fillControl(target, value, context);
  },
  async observe() {
    const { discoverControls, observeControl } = await import('../../src/content/controlObservation.ts');
    return discoverControls(document.querySelector('form')!).map(element => {
      const observation = observeControl(element);
      return { kind: observation.kind, label: observation.label, optionLabels: observation.options.map(option => option.label) };
    });
  },
  async diagnose() {
    const { FormDetector } = await import('../../src/content/formDetector.ts');
    const detector = new FormDetector();
    const detected = detector.detectFields().map(field => ({ id: field.element.id, fieldType: field.fieldType, confidence: field.confidence }));
    return { detected, unmatched: detector.getUnmatchedFields().map(field => ({ id: field.element.id, identifiers: field.identifiers })), observations: await fixture.observe() };
  },
  async beginFiller() {
    const { FormFiller } = await import('../../src/content/formFiller.ts');
    sessionFiller = new FormFiller();
    sessionFiller.beginFillSession();
  },
  async fillViaFiller(selector: string, value: string) {
    if (!sessionFiller) throw new Error('Missing fixture fill session');
    return sessionFiller.fillElementValues([{ element: document.querySelector<HTMLElement>(selector)!, value }]);
  },
  async revalidateFiller() {
    const count = await sessionFiller!.revalidate();
    return { count, failures: sessionFiller!.getLastFailures().map(failure => ({ label: failure.label, status: failure.outcome?.status })) };
  },
  async undoFiller() { return sessionFiller!.undoLastFill(); },
};
(window as unknown as { formFixture: typeof fixture }).formFixture = fixture;
fixture.render(new URLSearchParams(location.search).get('scenario') || 'react-text');

const style = document.createElement('style');
style.textContent = `body{font:16px system-ui;padding:24px;max-width:850px}form{display:grid;gap:20px}.field,fieldset{padding:12px}label{margin-right:12px}input,select,button{font:inherit;padding:9px;margin:4px}[role=option]{padding:10px;border:1px solid #ddd;cursor:pointer}output{display:block;margin-top:30px;white-space:pre-wrap}`;
document.head.appendChild(style);
