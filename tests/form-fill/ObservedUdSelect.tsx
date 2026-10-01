import React, { useState } from 'react';

/** Minimal controlled reproduction of diagnostic markers, not the vendor runtime. */
export function ObservedUdSelect({ scenario }: { scenario: string }) {
  const tree = scenario.includes('tree');
  const multiple = scenario.includes('multiple');
  const atsx = scenario === 'atsx-selected';
  const [open, setOpen] = useState(scenario.includes('preopen') || scenario.includes('scan'));
  const [expanded, setExpanded] = useState(false);
  const [selected, setSelected] = useState<string[]>(atsx ? ['上海'] : []);
  const [foreign, setForeign] = useState('');
  const choose = (label: string) => {
    setSelected(previous => multiple ? previous.includes(label) ? previous.filter(value => value !== label) : [...previous, label] : [label]);
    if (!multiple) setOpen(false);
  };
  if (scenario === 'moka-unread') return <main><form><label>最高学历</label>
    <div className="sd-Input-container-2S_vM sd-Select-container-1Eq4x" id="moka-control"><input type="text" placeholder="请选择" value={foreign} onChange={event => setForeign(event.target.value)} /></div>
    <pre id="react-state">{JSON.stringify({ query: foreign, degree: '' })}</pre></form></main>;
  const prefix = atsx ? 'atsx-select' : 'ud__select';
  const labels = tree || multiple || atsx ? ['上海', '北京'] : ['女', '男'];
  return <main><h1>诊断结构复现 {scenario}</h1><form onSubmit={event => event.preventDefault()}>
    <div className="field" style={{ position: 'relative' }}>
      <label htmlFor="ud-editor">{tree || multiple || atsx ? '期望工作地点' : '性别'}</label>
      <div style={{ position: 'relative' }}>
      <div id="ud-control" className={prefix} style={{ width: 260, minHeight: 35, border: '1px solid #aaa' }}>
        <div className={`${prefix}__selector ${multiple ? 'ud__select__selector-multiple atsx-select-selection--multiple' : ''}`} onClick={() => { if (scenario !== 'ud-foreign-popup') setOpen(value => !value); }}>
          <input id="ud-editor" role="combobox" readOnly className="ud__select__selector__search__input" value="" />
          {selected.map(label => <span className={atsx ? 'atsx-select-selection-item' : 'ud__select__selector__selectItem'} key={label}>{atsx ? <><span className="atsx-select-selection-item-content">{label}</span><button type="button" aria-hidden="true">×</button></> : label}</span>)}
        </div>
      </div>
      {scenario === 'ud-foreign-popup' && <>
        <div className="ud__select" style={{ position: 'absolute', left: 0, top: 0, width: 260, minHeight: 35, border: '1px solid #aaa' }}><input role="combobox" readOnly value="" /></div>
      </>}
      </div>
      {scenario === 'ud-foreign-popup' && <div className="ud__select__dropdown" style={{ width: 260, minHeight: 45 }}><div className="ud__select__list__item" onClick={() => setForeign('男')}>男</div></div>}
      <div className={atsx ? 'atsx-select-dropdown' : 'ud__select__dropdown'} hidden={!open} style={{ width: 260, minHeight: 45, border: '1px solid #ddd' }}>
        {tree ? <div className="ud__treeSelect__overlay">
          <div className="ud__tree__node">
            <div className="ud__tree__node-content-wrapper">
              <button type="button" className="ud__tree__node-switcher" onClick={() => setExpanded(value => !value)}>华东地区</button>
              <label><input className="ud__checkbox__input" type="checkbox" onChange={() => choose('华东地区')} checked={selected.includes('华东地区')} />华东地区</label>
            </div>
            <div hidden={!expanded}>{labels.map(label => <div className="ud__tree__node" key={label}>
              <label><input className="ud__checkbox__input" type="checkbox" checked={selected.includes(label)} onChange={() => choose(label)} />{label}</label>
            </div>)}</div>
          </div>
        </div> : labels.map(label => <div className="ud__select__list__item" key={label} onClick={() => choose(label)} style={{ padding: 4 }}>
          <span>{label}</span>
        </div>)}
      </div>
    </div>
    <pre id="react-state">{JSON.stringify({ gender: selected[0] === '男' ? 'm' : selected[0] === '女' ? 'f' : '', region: selected.join('、'), foreign })}</pre>
  </form></main>;
}
