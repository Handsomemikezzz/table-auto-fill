import React from 'react';
import { ObservedDateRange } from './ObservedDateRange';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { FormFiller } from '../../src/content/formFiller';
import { createPageObserver } from '../../src/content/pageObservation';
import { fillControl, verifyControl } from '../../src/content/fillEngine';
import { createProfileSnapshot } from '../../src/autofill/profileSnapshot';
import { createFieldRegistry, registryVersion } from '../../src/autofill/fieldRegistry';
import { FillSessionController } from '../../src/autofill/fillSessionController';
import type { UserProfile } from '../../src/shared/types';

const root = createRoot(document.getElementById('fixture')!);
const render = (mode: 'range' | 'text' | 'invented-day' = 'range') => flushSync(() => root.render(<ObservedDateRange key={Math.random()} mode={mode} />));
const profile: UserProfile = {
  personal: { name: '', gender: '', birthDate: '', phone: '', email: '' },
  education: [{ id: 'education-1', school: '', major: '', degree: '本科', startDate: '2018.8', endDate: '2022.6' }],
  experience: [{ id: 'work-1', company: '', position: '', startDate: '2022.7', endDate: '2023.9', description: '' }],
  projects: [], skills: [], certifications: [], customInformation: [],
};
function createSession() {
  const registry = createFieldRegistry();
  const snapshot = createProfileSnapshot(profile);
  const observer = createPageObserver(registry, undefined, snapshot);
  const filler = new FormFiller(); filler.beginFillSession();
  return { observer, session: new FillSessionController({ sessionId: 'date-regression', profile: snapshot, registry, registryVersion: registryVersion(registry) }, {
    observe: observer.observe,
    execute: (field, decision, value, shouldContinue) => filler.executeDecision(observer.nodes.get(field.fieldId)!, value, { semantic: decision.meaningId?.split('.').at(-1), shouldContinue }),
    verify: (field, decision, value, shouldContinue) => verifyControl(observer.nodes.get(field.fieldId)!, value, { semantic: decision.meaningId?.split('.').at(-1), shouldContinue, settleMs: 60 }),
    cancel: () => {}, update: () => {},
  }) };
}
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
    const { observer } = createSession();
    const fields = observer.observe();
    const meaning = (id: string) => fields.find(field => observer.nodes.get(field.fieldId)?.id === id);
    assert(meaning('edu-a')?.signature !== meaning('edu-b')?.signature, '日期端点不能共用签名');
    assert(meaning('edu-a')?.ruleBinding?.meaningId === 'education.startDate' && meaning('edu-b')?.ruleBinding?.meaningId === 'education.endDate'
      && meaning('work-a')?.ruleBinding?.meaningId === 'experience.startDate' && meaning('work-b')?.ruleBinding?.meaningId === 'experience.endDate', JSON.stringify(fields));
  });
  await check('整条经历填写：点号转横线后仍通过验证', async () => {
    render();
    const { session } = createSession();
    await session.run();
    const state = JSON.parse(document.getElementById('react-state')!.textContent!);
    assert(state['edu-a'] === '2018-08' && state['edu-b'] === '2022-06'
      && state['work-a'] === '2022-07' && state['work-b'] === '2023-09', JSON.stringify(state));
    assert(session.counts.verified === 4, JSON.stringify(session.result));
  });
  await check('单日期字段接受等精度的网页格式化', async () => {
    render('text');
    const result = await fillControl(document.getElementById('plain')!, '2018.8', { semantic: 'educationStartDate', settleMs: 80 });
    assert(result.status === 'verified', JSON.stringify(result));
  });
  await check('普通文本不能借日期等价掩盖内容改变', async () => {
    render('text');
    const result = await fillControl(document.getElementById('plain')!, '2018.8', { semantic: 'text', settleMs: 80 });
    assert(JSON.parse(document.getElementById('react-state')!.textContent!).plain === (document.getElementById('plain') as HTMLInputElement).value, '组件状态必须同步变化');
    assert(result.status !== 'verified', JSON.stringify(result));
  });
  await check('网页擅自增加日期精度不算正确填写', async () => {
    render('invented-day');
    const result = await fillControl(document.getElementById('plain')!, '2018.8', { semantic: 'educationStartDate', settleMs: 80 });
    assert(JSON.parse(document.getElementById('react-state')!.textContent!).plain === (document.getElementById('plain') as HTMLInputElement).value, '组件状态必须同步变化');
    assert(result.status !== 'verified', JSON.stringify(result));
  });
  document.getElementById('status')!.textContent = failed ? `${failed} 项失败` : '5 项全部通过';
  button.disabled = false;
});
render();
