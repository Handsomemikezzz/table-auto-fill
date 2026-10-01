import React, { useState } from 'react';

/** Native relationships read from the public form; values and state are synthetic. */
export function ObservedAvePoint() {
  const [state, setState] = useState<Record<string, string>>({ job: '网络安全工程师--IT方向' });
  const change = (name: string, value: string) => setState(previous => ({ ...previous, [name]: value }));
  const input = (name: string, label: string, type = 'text') => <div><label>{label}</label><input name={name} type={type} value={state[name] || ''} onChange={event => change(name, event.target.value)} /></div>;
  return <main><h1>企业自建原生表单结构复现</h1><form onSubmit={event => event.preventDefault()}><div className="register-wrap">
    {input('name', '姓名*')}{input('age', '年龄*')}
    <div><label>性别*</label>{['男', '女'].map(value => <React.Fragment key={value}><input type="radio" name="gender" value={value} checked={state.gender === value} onChange={() => change('gender', value)} />{value}</React.Fragment>)}</div>
    <div><label>应聘地点*</label><input type="radio" name="location" value="长春" checked={state.location === '长春'} onChange={() => change('location', '长春')} />长春</div>
    <div><label>应聘岗位</label><input name="job" readOnly value={state.job} /></div>
    <div><label>学历*</label><select name="education" value={state.education || ''} onChange={event => change('education', event.target.value)}><option value="">请选择</option>{['博士', '硕士', '本科', '大专'].map(value => <option key={value}>{value}</option>)}</select></div>
    {input('school', '毕业院校*')}{input('speciality', '专业*')}{input('tel', '手机号码*', 'tel')}{input('email', '电子邮箱*', 'email')}
    <div><label>上传简历（只支持 docx 和 pdf 文件类型）*</label><input id="file" name="file" type="file" /></div>
  </div><pre id="react-state">{JSON.stringify(state)}</pre></form></main>;
}
