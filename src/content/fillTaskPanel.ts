import type { FillSessionController } from '../autofill/fillSessionController.ts';
import type { AdditionalFact, MeaningCorrection, SessionItem } from '../autofill/contracts.ts';
import type { Message, MessageResponse } from '../shared/types.ts';

type Send = <T = unknown>(message: Message) => Promise<MessageResponse<T>>;
export function createFillTaskPanel(send: Send, locate: (item: SessionItem) => void, undo: () => Promise<number>, stop: () => void) {
  document.querySelector('[data-job-applymate-task]')?.remove();
  const host = document.createElement('div');
  host.dataset.jobApplymateUi = 'true'; host.dataset.jobApplymateTask = 'true';
  host.style.cssText = 'position:fixed;right:20px;top:20px;z-index:2147483647;width:360px;max-width:calc(100vw - 32px);';
  const root = host.attachShadow({ mode: 'open' });
  const style = document.createElement('style');
  style.textContent = `:host{font:14px/1.5 system-ui;color:#172b38}*{box-sizing:border-box}section{background:#fff;border:1px solid #dbe3ea;border-radius:14px;box-shadow:0 8px 32px #172b3826;padding:16px;max-height:85vh;overflow:auto}header{display:flex;justify-content:space-between;align-items:center;gap:8px}h2{font-size:16px;margin:0}p{margin:8px 0;overflow-wrap:anywhere}small{color:#526775}button,select,input,textarea{font:inherit;max-width:100%;border:1px solid #bbcbd6;border-radius:6px;padding:6px 9px;background:#fff;color:#172b38}button{cursor:pointer;margin:4px 4px 4px 0}button:hover{background:#e9f3fa}button:disabled{opacity:.5;cursor:default}select,textarea{width:100%;margin:4px 0}label{display:block;margin:6px 0}input[type=checkbox]{margin-right:6px}details{margin-top:10px}summary{cursor:pointer}article{border-top:1px solid #e0e8ee;margin-top:12px;padding-top:10px}.reason{color:#865e17}.notice{color:#21624d}button:focus-visible,input:focus-visible,select:focus-visible{outline:2px solid #206fa2}pre{white-space:pre-wrap;overflow-wrap:anywhere}`;
  const body = document.createElement('section'); body.setAttribute('aria-label', '填写任务');
  root.append(style, body); document.documentElement.append(host);
  let session: FillSessionController | undefined;
  let message = '理解表单';
  let expanded = true;
  let previousPhase = '';

  let activeId = '';
  let actionPending = false;
  const el = <K extends keyof HTMLElementTagNameMap>(tag: K, text?: string) => { const node = document.createElement(tag); if (text) node.textContent = text; return node; };
  const action = (parent: HTMLElement, label: string, handler: () => void | Promise<void>, disabled = false) => {
    const button = el('button', label); button.type = 'button'; button.disabled = disabled;
    button.onclick = async () => { button.disabled = true; try { await handler(); } catch (error) { message = error instanceof Error ? error.message : '操作失败'; render(); } finally { if (button.isConnected) button.disabled = disabled; } };
    parent.append(button); return button;
  };
  function render() {
    body.replaceChildren();
    const header = el('header'); header.append(el('h2', '填写当前页面'));
    if (!session || session.busy || session.phase === 'understanding') action(header, '停止', stop);
    else action(header, expanded ? '收起' : '展开', () => { expanded = !expanded; render(); });
    body.append(header);
    if (!session) { body.append(el('p', message)); return; }
    const counts = session.counts;
    if (session.phase === 'complete' && previousPhase !== 'complete' && counts.todo === 0 && !session.error) expanded = false;
    previousPhase = session.phase;
    const phases = { understanding: '理解表单', matching: '匹配资料', writing: '填写并检查', complete: '填写结束', stopped: '已停止' };
    const progress = el('p', !['complete', 'stopped'].includes(session.phase) ? phases[session.phase] : `已填写 ${counts.verified} 项，${counts.todo} 项需处理`);
    progress.setAttribute('role', 'status'); progress.setAttribute('aria-live', 'polite'); body.append(progress);
    body.append(el('small', `辅助完成 ${counts.assisted} · 保留原值 ${counts.existing} · 本次跳过 ${counts.skipped}`));
    if (session.stopped) body.append(el('p', '已停止。重新点击“填写当前页面”可开始新会话。'));
    if (session.error) body.append(el('p', session.error));
    if (!expanded) return;
    body.append(el('p', `本次资料：${session.context.profile.sourceLabel}`));
    if (message !== '理解表单') { const notice = el('p', message); notice.className = 'notice'; body.append(notice); }
    const todos = session.items.filter(item => item.status === 'todo');
    const current = session.items.find(item => item.observation.fieldId === activeId && ['todo', 'existing'].includes(item.status)) || todos[0];
    if (current) {
      activeId = current.observation.fieldId;
      const chooser = el('select'); chooser.setAttribute('aria-label', '待处理队列');
      todos.forEach((item, index) => { const option = el('option', `${index + 1}. ${item.observation.groupLabel} · ${item.observation.label}`); option.value = item.observation.fieldId; chooser.append(option); });
      chooser.value = activeId; chooser.onchange = () => { activeId = chooser.value; render(); }; body.append(chooser);
      renderItem(current);
    }
    const more = el('details'); more.append(el('summary', '更多'));
    for (const item of session.items.filter(item => item.status === 'existing')) action(more, `查看保留项：${item.observation.label}`, () => { activeId = item.observation.fieldId; render(); });
    action(more, '撤销本次可恢复修改', async () => { message = `已恢复 ${await undo()} 项`; for (const item of session!.items.filter(item => item.status === 'verified')) { item.status = 'todo'; item.reason = '已请求撤销，请核对网页'; } render(); }, session.busy || actionPending);
    action(more, '导出脱敏诊断', () => {
      const data = session!.items.map(item => ({ fieldId: item.observation.fieldId, decisionId: item.decision?.decisionId, meaningId: item.decision?.meaningId, subject: item.decision?.subject, factId: item.decision?.factId, recordId: item.decision?.recordId, modelId: item.decision?.modelId, profileVersion: item.decision?.profileVersion, registryVersion: item.decision?.registryVersion, status: item.status, outcome: item.outcome?.status, adapter: item.outcome?.adapterId }));
      const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
      const link = el('a'); link.href = url; link.download = 'fill-diagnostics.json'; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
    });
    const skipped = session.items.filter(item => item.status === 'skipped');
    if (skipped.length) more.append(el('p', `本次跳过：${skipped.map(item => item.observation.label).join('、')}`));
    body.append(more);
  }
  function renderItem(item: SessionItem) {
    const controller = session!;
    const article = el('article'); article.append(el('strong', `${item.observation.groupLabel} · ${item.observation.label}`));
    const reason = el('p', item.reason); reason.className = 'reason'; article.append(reason);
    const fact = controller.context.profile.facts.find(fact => fact.id === item.decision?.factId);
    const blocked = controller.busy || controller.stopped || actionPending;
    if (fact) article.append(el('p', `资料值：${fact.value}`));
    if (item.decision?.recordId) article.append(el('small', '所属经历：' + controller.context.profile.facts.filter(fact => fact.recordId === item.decision!.recordId && /\.(school|company|name|degree)$/.test(fact.meaningId)).map(fact => fact.value).join(' · ')));
    if (item.outcome?.observedValue) article.append(el('p', `网页读回：${item.outcome.observedValue}`));
    action(article, '在网页中选择 / 定位', () => locate(item));
    if (fact) action(article, '重新检查', () => controller.recheck(item), blocked);
    if (item.observation.kind !== 'file' && (item.outcome?.status === 'needs-data' || /精度不足|只有年|具体年月日/.test(item.reason) || item.decision?.nextAction === 'requestFact')) {
      const form = el('div');
      const meaning = el('input'); meaning.placeholder = '确认字段含义'; meaning.value = controller.context.registry.find(def => def.id === item.decision?.meaningId)?.label || item.observation.label; meaning.setAttribute('aria-label', '字段含义');
      const subject = el('input'); subject.placeholder = '信息属于谁'; subject.value = item.decision?.subject || 'self'; subject.setAttribute('aria-label', '信息主体');
      const value = el('input'); value.placeholder = /日期|时间|date/i.test(item.observation.label) ? '填写真实日期，保留已知精度' : '补充本次答案'; value.setAttribute('aria-label', '补充答案');
      const saveLabel = el('label'); const save = el('input'); save.type = 'checkbox'; save.disabled = controller.context.profile.sourceId !== 'default'; saveLabel.append(save, `保存到${controller.context.profile.sourceLabel}，下次可用`);
      form.append(meaning, subject, value, saveLabel);
      action(form, '使用此答案', async () => {
        if (!value.value.trim() || !meaning.value.trim() || !subject.value.trim()) throw new Error('请确认含义、主体和答案');
        if (save.checked) {
          const id = crypto.randomUUID();
          const knownDefinition = controller.context.registry.find(def => def.id === item.decision?.meaningId && def.label === meaning.value.trim() && def.subject === subject.value.trim());
          const additional: AdditionalFact = { id, meaningId: knownDefinition?.id || `additional.${id}`, recordId: knownDefinition ? item.decision?.recordId : undefined, label: meaning.value.trim(), subject: subject.value.trim(), value: value.value.trim(), valueType: /日期|时间/.test(meaning.value) ? 'date' : 'text', updatedAt: new Date().toISOString() };
          const response = await send({ type: 'SAVE_ADDITIONAL_FACT', payload: { fact: additional, profileVersion: controller.context.saveProfileVersion || controller.context.profile.version } });
          if (!response.success) throw new Error(response.error || '保存资料失败');
          message = '资料已保存。网页填写结果单独检查；后续自动匹配请重新开始会话。';
        }
        await controller.manual(item, value.value.trim());
      }, blocked); article.append(form);
    }
    if (item.observation.kind === 'file' && !fact) article.append(el('p', '请在弹窗选择附件后重新开始，或在网页中上传。'));
    const details = el('details'); details.append(el('summary', '来源 / 更正理解'));
    details.open = item.decision?.nextAction === 'requestMeaning' || /经历.*绑定|选择对应经历/.test(item.reason);
    if (fact) details.append(el('p', `${fact.source}${fact.recordId ? ` · 经历 ${fact.recordId}` : ''}${fact.precision ? ` · 精度 ${fact.precision}` : ''}`));
    const meaning = el('select'); meaning.setAttribute('aria-label', '确认字段含义');
    for (const def of controller.context.registry) { const option = el('option', def.label + ` (${def.subject})`); option.value = def.id; meaning.append(option); }
    meaning.value = item.decision?.meaningId || item.observation.candidates[0];
    const record = el('select'); record.setAttribute('aria-label', '选择对应经历');
    const noRecord = el('option', '由模型核对对应经历'); noRecord.value = ''; record.append(noRecord);
    const ids = [...new Set(controller.context.profile.facts.map(fact => fact.recordId).filter(Boolean))];
    for (const id of ids) {
      const values = controller.context.profile.facts.filter(fact => fact.recordId === id && /\.(school|company|name|degree|startDate|endDate)$/.test(fact.meaningId));
      if (!values.length) continue;
      const option = el('option', values.map(fact => fact.value).join(' · ')); option.value = id!; record.append(option);
    }
    const rememberLabel = el('label'), remember = el('input'); remember.type = 'checkbox'; rememberLabel.append(remember, '记住本网站此字段的含义');
    details.append(meaning, record, rememberLabel);
    action(details, '确认含义并重新匹配', async () => {
      const correction: MeaningCorrection = { id: crypto.randomUUID(), origin: item.observation.origin || location.origin, signature: item.observation.signature, profileVersion: controller.context.profile.version, registryVersion: controller.context.registryVersion, meaningId: meaning.value, recordId: record.value || undefined, confirmedAt: new Date().toISOString(), enabled: true };
      if (remember.checked) {
        const response = await send({ type: 'SAVE_MEANING_CORRECTION', payload: correction });
        if (!response.success) throw new Error(response.error || '保存纠错失败');
        message = '已用于本网站，可在设置中的学习记录中禁用或删除。';
      }
      await controller.confirmMeaning(item, correction);
    }, blocked);
    if (fact && ['existing', 'todo'].includes(item.status)) action(details, '明确用此资料覆盖这个字段', () => controller.manual(item, fact.value, item.decision?.targetOptionIds?.[0]), blocked);
    const answers = el('select'); answers.setAttribute('aria-label', '手动选择已有资料');
    controller.context.profile.facts.filter(fact => !fact.conflict).forEach(fact => { const option = el('option', `${controller.context.registry.find(def => def.id === fact.meaningId)?.label || fact.source}：${fact.value.slice(0, 100)}`); option.value = fact.id; answers.append(option); });
    details.append(answers);
    action(details, '将所选资料填入此字段', async () => { const selected = controller.context.profile.facts.find(fact => fact.id === answers.value); if (selected) await controller.manual(item, selected.value); }, blocked);
    article.append(details); action(article, '本次跳过', () => controller.skip(item), blocked); body.append(article);
  }
  render();
  return { bind(controller: FillSessionController) { session = controller; render(); }, update: render, status(text: string) { message = text; render(); }, close() { host.remove(); } };
}
