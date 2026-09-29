import React from 'react';
import { ObservedDateRange } from './ObservedDateRange';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { FormDetector } from '../../src/content/formDetector';
import { FormFiller } from '../../src/content/formFiller';
import { fillControl } from '../../src/content/fillEngine';
import type { UserProfile } from '../../src/shared/types';


const root = createRoot(document.getElementById('fixture')!);
const render = (mode: 'range' | 'text' | 'invented-day' = 'range') => flushSync(() => root.render(<ObservedDateRange key={Math.random()} mode={mode} />));
const profile: UserProfile = {
  personal: { name: '', gender: '', birthDate: '', phone: '', email: '' },
  education: [{ id: 'education-1', school: '', major: '', degree: '本科', startDate: '2018.8', endDate: '2022.6' }],
  experience: [{ id: 'work-1', company: '', position: '', startDate: '2022.7', endDate: '2023.9', description: '' }],
  projects: [], skills: [], certifications: [], customInformation: [],
};
const assert = (condition: boolean, message: string) => { if (!condition) throw new Error(message); };
document.getElementById('run')!.addEventListener('click', async () => {
  const button = document.getElementById('run') as HTMLButtonElement;
  button.disabled = true;
  document.getElementById('results')!.replaceChildren();
  document.getElementById('status')!.textContent = '运行中';
  let failed = 0;
  const check = async (name: string, run: () => Promise<void> | void) => {
    const row = document.createElement('li');
    try { await run(); row.textContent = `通过：${name}`; }
    catch (error) { failed++; row.textContent = `失败：${name} — ${String(error)}`; }
    document.getElementById('results')!.append(row);
  };
  await check('深层起止框分别识别教育与工作开始、结束日期', () => {
    render();
    const fields = new FormDetector().detectFields();
    const filler = new FormFiller();
    assert(filler.getFieldSignature(document.getElementById('edu-a')!) !== filler.getFieldSignature(document.getElementById('edu-b')!), '日期端点不能共用学习签名');
    const meanings = Object.fromEntries(fields.map(field => [field.element.id, field.fieldType]));
    assert(meanings['edu-a'] === 'educationStartDate' && meanings['edu-b'] === 'graduationDate'
      && meanings['work-a'] === 'startDate' && meanings['work-b'] === 'endDate', JSON.stringify(meanings));
  });
  await check('整条经历填写：点号转横线后仍通过验证', async () => {
    render();
    const filler = new FormFiller();
    filler.beginFillSession();
    await filler.fillForm(new FormDetector().detectFields(), profile);
    const state = JSON.parse(document.getElementById('react-state')!.textContent!);
    assert(state['edu-a'] === '2018-08' && state['edu-b'] === '2022-06'
      && state['work-a'] === '2022-07' && state['work-b'] === '2023-09', JSON.stringify(state));
    assert(await filler.revalidate() === 4, JSON.stringify(filler.getLastFailures().map(failure => failure.outcome)));
  });
  await check('单日期字段接受等精度的网页格式化', async () => {
    render('text');
    const result = await fillControl(document.getElementById('plain')!, '2018.8', { semantic: 'educationStartDate', settleMs: 80 });
    assert(result.status === 'verified', JSON.stringify(result));
  });
  await check('普通文本不能借日期等价掩盖内容改变', async () => {
    render('text');
    const result = await fillControl(document.getElementById('plain')!, '2018.8', { semantic: 'text', settleMs: 80 });
    assert(result.status !== 'verified', JSON.stringify(result));
  });
  await check('网页擅自增加日期精度不算正确填写', async () => {
    render('invented-day');
    const result = await fillControl(document.getElementById('plain')!, '2018.8', { semantic: 'educationStartDate', settleMs: 80 });
    assert(result.status !== 'verified', JSON.stringify(result));
  });
  document.getElementById('status')!.textContent = failed ? `${failed} 项失败` : '5 项全部通过';
  button.disabled = false;
});
render();
