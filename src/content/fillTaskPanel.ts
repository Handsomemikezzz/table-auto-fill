import { matchSupplementDefinition, normalizePersonalFieldLabel, PERSONAL_EXTRA_FIELDS, getPersonalFieldValue } from '../shared/personalFields.ts';
import type { FillSessionController } from '../autofill/fillSessionController.ts';
import type { AdditionalFact, SessionItem, FieldDefinition, ProfileFact } from '../autofill/contracts.ts';
import type { Message, MessageResponse } from '../shared/types.ts';

type Send = <T = unknown>(message: Message) => Promise<MessageResponse<T>>;
type ViewMode = 'list' | 'single' | 'batch' | 'bar';
type FillTarget = 'both' | 'page' | 'profile';

interface DraftState {
  label: string;
  value: string;
  target: FillTarget;
  isEditing?: boolean;
  customLabel?: boolean;
  dateParts?: { year: string; month: string; day: string };
}

interface ResultState {
  webStatus: 'success' | 'failed' | 'skipped' | 'none';
  webMessage?: string;
  profileStatus: 'success' | 'failed' | 'none';
  profileMessage?: string;
  previousProfileValue?: string;
  savedProfileKey?: string;
  savedProfileLabel?: string;
}

const COMMON_CITIES = ['北京', '上海', '广州', '深圳', '杭州', '成都', '武汉', '南京'];
const COMMON_LANGUAGES = ['英语 六级', '英语 四级', '英语 流利', '日常沟通', '日语 N1', '日语 N2'];

function cleanLabel(raw: string): string {
  return raw.replace(/[＊*：:\s]+$/g, '').trim() || '未命名字段';
}

function parseDateParts(val: string): { year: string; month: string; day: string } {
  const parts = val.match(/^(\d{4})(?:[-/.](\d{1,2}))?(?:[-/.](\d{1,2}))?$/);
  if (!parts) return { year: '', month: '', day: '' };
  return {
    year: parts[1] || '',
    month: parts[2] ? parts[2].padStart(2, '0') : '',
    day: parts[3] ? parts[3].padStart(2, '0') : '',
  };
}

function formatDateParts(p: { year: string; month: string; day: string }): string {
  const y = p.year.trim();
  const m = p.month.trim().padStart(2, '0');
  const d = p.day.trim().padStart(2, '0');
  if (!y) return '';
  if (p.day.trim()) return `${y}-${m}-${d}`;
  if (p.month.trim()) return `${y}-${m}`;
  return y;
}

export function createFillTaskPanel(
  send: Send,
  locate: (item: SessionItem) => void,
  undo: () => Promise<number>,
  stop: () => void
) {
  document.querySelector('[data-job-applymate-task]')?.remove();
  const host = document.createElement('div');
  host.dataset.jobApplymateUi = 'true';
  host.dataset.jobApplymateTask = 'true';
  host.style.cssText = 'position:fixed;right:20px;top:20px;z-index:2147483647;';

  const root = host.attachShadow({ mode: 'open' });
  const style = document.createElement('style');
  style.textContent = `
    :host {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif;
      font-size: 14px;
      line-height: 1.5;
      color: #0f172a;
      -webkit-font-smoothing: antialiased;
    }
    * {
      box-sizing: border-box;
    }
    .panel-card {
      background: #ffffff;
      border: 1px solid #e2e8f0;
      border-radius: 16px;
      box-shadow: 0 10px 30px rgba(15, 23, 42, 0.08);
      padding: 20px 24px;
      max-height: 85vh;
      overflow-y: auto;
      width: 380px;
      max-width: calc(100vw - 32px);
    }
    .mini-bar {
      background: #ffffff;
      border: 1px solid #cbd5e1;
      border-radius: 9999px;
      box-shadow: 0 6px 20px rgba(15, 23, 42, 0.12);
      padding: 8px 16px;
      display: flex;
      align-items: center;
      gap: 12px;
      width: max-content;
      max-width: calc(100vw - 32px);
      font-size: 13px;
    }
    .brand-row {
      display: flex;
      justify-content: space-between;
      align-items: center;
      font-size: 13px;
      color: #64748b;
      font-weight: 500;
      margin-bottom: 2px;
    }
    .brand-status {
      font-size: 12px;
      color: #94a3b8;
      display: flex;
      align-items: center;
      gap: 6px;
    }
    .main-title {
      font-size: 20px;
      font-weight: 700;
      color: #0f172a;
      margin: 4px 0 2px;
      line-height: 1.25;
    }
    .subtitle-summary {
      font-size: 13px;
      color: #64748b;
      margin: 0;
    }
    .divider {
      height: 1px;
      background: #f1f5f9;
      margin: 16px 0;
      border: none;
    }
    .section-title-row {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 6px;
    }
    .section-heading {
      font-size: 14px;
      font-weight: 600;
      color: #0f172a;
      margin: 0;
    }
    .tag-optional {
      font-size: 12px;
      color: #94a3b8;
      font-weight: 400;
      margin-left: 4px;
    }
    .link-action {
      background: none;
      border: none;
      color: #2563eb;
      font-size: 13px;
      font-weight: 500;
      cursor: pointer;
      padding: 0;
    }
    .link-action:hover {
      text-decoration: underline;
    }
    .section-desc {
      font-size: 12px;
      color: #64748b;
      margin: 0 0 10px;
    }
    .item-row {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 10px 0;
      gap: 12px;
    }
    .item-info {
      flex: 1;
      min-width: 0;
    }
    .item-title {
      font-size: 14px;
      font-weight: 600;
      color: #0f172a;
      margin: 0 0 3px;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .item-subtitle {
      font-size: 12px;
      color: #64748b;
      margin: 0;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .btn-outline {
      border: 1px solid #cbd5e1;
      background: #ffffff;
      color: #1e293b;
      border-radius: 8px;
      padding: 6px 14px;
      font-size: 13px;
      font-weight: 500;
      cursor: pointer;
      white-space: nowrap;
      transition: all 0.15s;
    }
    .btn-outline:hover {
      background: #f8fafc;
      border-color: #94a3b8;
    }
    .btn-outline:disabled {
      opacity: 0.5;
      cursor: not-allowed;
    }
    .btn-primary {
      border: none;
      background: #2563eb;
      color: #ffffff;
      border-radius: 8px;
      padding: 8px 16px;
      font-size: 13px;
      font-weight: 500;
      cursor: pointer;
      transition: background 0.15s;
      width: 100%;
    }
    .btn-primary:hover {
      background: #1d4ed8;
    }
    .btn-primary:disabled {
      opacity: 0.5;
      cursor: not-allowed;
    }
    .btn-secondary {
      border: 1px solid #e2e8f0;
      background: #f8fafc;
      color: #475569;
      border-radius: 8px;
      padding: 7px 14px;
      font-size: 13px;
      cursor: pointer;
      font-weight: 500;
    }
    .btn-secondary:hover {
      background: #f1f5f9;
    }
    .btn-secondary:disabled {
      opacity: 0.5;
      cursor: not-allowed;
    }
    .btn-text {
      background: none;
      border: none;
      color: #64748b;
      font-size: 13px;
      cursor: pointer;
      padding: 4px 6px;
    }
    .btn-text:hover {
      color: #0f172a;
    }
    .nav-back-row {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 12px;
    }
    .nav-back-btn {
      background: none;
      border: none;
      color: #2563eb;
      font-size: 13px;
      font-weight: 500;
      cursor: pointer;
      padding: 0;
      display: flex;
      align-items: center;
      gap: 4px;
    }
    .nav-back-btn:hover {
      text-decoration: underline;
    }
    .editor-title {
      font-size: 16px;
      font-weight: 600;
      color: #0f172a;
      margin: 0 0 4px;
    }
    .editor-meta {
      font-size: 12px;
      color: #64748b;
      margin: 0 0 10px;
    }
    .editor-status-badge {
      font-size: 12px;
      color: #d97706;
      background: #fffbeb;
      border: 1px solid #fef3c7;
      border-radius: 6px;
      padding: 6px 10px;
      margin: 6px 0 12px;
    }
    .info-field-box {
      background: #f8fafc;
      border: 1px solid #e2e8f0;
      border-radius: 8px;
      padding: 10px 12px;
      margin-bottom: 14px;
      font-size: 13px;
    }
    .info-field-row {
      margin: 4px 0;
      color: #334155;
    }
    .info-field-label {
      color: #64748b;
      font-size: 12px;
      margin-right: 6px;
    }
    .target-segmented {
      display: flex;
      background: #f1f5f9;
      border-radius: 8px;
      padding: 3px;
      gap: 3px;
      margin: 8px 0;
    }
    .target-option {
      flex: 1;
      text-align: center;
      padding: 6px 4px;
      font-size: 12px;
      border-radius: 6px;
      cursor: pointer;
      border: none;
      background: transparent;
      color: #64748b;
      font-weight: 500;
      transition: all 0.15s;
    }
    .target-option.active {
      background: #ffffff;
      color: #0f172a;
      font-weight: 600;
      box-shadow: 0 1px 3px rgba(15, 23, 42, 0.08);
    }
    .impact-hint {
      font-size: 12px;
      color: #64748b;
      margin: 6px 0 10px;
      text-align: center;
    }
    .chip-container {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
      margin: 6px 0 10px;
    }
    .chip {
      background: #f1f5f9;
      color: #334155;
      border: 1px solid #e2e8f0;
      border-radius: 6px;
      padding: 3px 8px;
      font-size: 12px;
      cursor: pointer;
      transition: all 0.15s;
    }
    .chip:hover {
      background: #e2e8f0;
    }
    .chip.selected {
      background: #dbeafe;
      color: #1e40af;
      border-color: #bfdbfe;
      font-weight: 500;
    }
    .feedback-banner {
      border-radius: 8px;
      padding: 10px 12px;
      margin: 10px 0 14px;
      font-size: 13px;
    }
    .feedback-success {
      background: #f0fdf4;
      border: 1px solid #bbf7d0;
      color: #166534;
    }
    .feedback-partial {
      background: #fffbeb;
      border: 1px solid #fde68a;
      color: #92400e;
    }
    .feedback-error {
      background: #fef2f2;
      border: 1px solid #fecaca;
      color: #991b1b;
    }
    .date-row {
      display: flex;
      gap: 8px;
      align-items: center;
    }
    .date-input {
      flex: 1;
    }
    input, select, textarea {
      font: inherit;
      color: #0f172a;
      border: 1px solid #cbd5e1;
      border-radius: 8px;
      padding: 7px 10px;
      font-size: 13px;
      width: 100%;
    }
    input:focus, select:focus, textarea:focus {
      outline: none;
      border-color: #2563eb;
      box-shadow: 0 0 0 2px rgba(37, 99, 235, 0.15);
    }
    .unit-input-group {
      display: flex;
      align-items: center;
      gap: 6px;
    }
    .unit-input-group input {
      flex: 1;
    }
    .unit-text {
      color: #64748b;
      font-size: 13px;
      white-space: nowrap;
    }
    .actions-stack {
      display: flex;
      flex-direction: column;
      gap: 8px;
      margin-top: 14px;
    }
    .actions-row {
      display: flex;
      gap: 8px;
    }
    details {
      margin-top: 14px;
      font-size: 12px;
      color: #64748b;
    }
    summary {
      cursor: pointer;
      user-select: none;
    }
    .notice {
      color: #059669;
      font-size: 12px;
      margin: 4px 0 8px;
    }
  `;

  const container = document.createElement('div');
  root.append(style, container);
  document.documentElement.append(host);

  let session: FillSessionController | undefined;
  let viewMode: ViewMode = 'list';
  let activeFieldId = '';
  let actionPending = false;
  let expanded = true;
  let message = '理解表单';
  let previousPhase = '';

  const drafts = new Map<string, DraftState>();
  const results = new Map<string, ResultState>();
  const savedValues = new Map<string, string>();

  const el = <K extends keyof HTMLElementTagNameMap>(tag: K, text?: string, className?: string) => {
    const node = document.createElement(tag);
    if (text) node.textContent = text;
    if (className) node.className = className;
    return node;
  };

  function getRecordSummary(recordId?: string, facts: ProfileFact[] = []): string {
    if (!recordId) return '';
    const relevant = facts.filter(f => f.recordId === recordId && /\.(school|company|name|degree)$/.test(f.meaningId));
    return relevant.map(f => f.value).join(' · ');
  }

  function getItemMeta(item: SessionItem, facts: ProfileFact[] = [], _registry: FieldDefinition[] = []) {
    const fact = facts.find(f => f.id === item.decision?.factId);
    const title = cleanLabel(item.observation.label);
    const isDropdown = item.observation.kind === 'select' || item.observation.kind === 'combobox' || /下拉|选项|select/i.test(item.reason);
    const isDatePrecision = item.outcome?.status === 'needs-data'
      || /精度不足|只有年|具体年月日|缺少具体日期/.test(item.reason)
      || Boolean(item.decision?.meaningId?.includes('Date') && fact && (!fact.precision || fact.precision === 'year' || fact.precision === 'month'));

    let subtitle = item.reason || '需要在网页中处理';
    let actionLabel = '去处理';

    if (isDatePrecision) {
      actionLabel = '补全日期';
      subtitle = '网站要求具体日期，资料只有年月';
    } else if (isDropdown && fact) {
      actionLabel = '去处理';
      subtitle = '已有答案，下拉框尚未选中';
    } else if (item.status === 'missing') {
      actionLabel = '补充';
      subtitle = '尚未提供，保持留空即可';
    }

    return { title, subtitle, actionLabel, fact, isDropdown, isDatePrecision };
  }

  function getDraft(item: SessionItem): DraftState {
    const existing = drafts.get(item.observation.fieldId);
    if (existing) return existing;
    const initialLabel = cleanLabel(item.observation.label);
    const initialDraft: DraftState = {
      label: initialLabel,
      value: '',
      target: item.status === 'missing' || /精度不足|具体年月日/.test(item.reason) ? 'both' : 'page',
    };
    drafts.set(item.observation.fieldId, initialDraft);
    return initialDraft;
  }

  function render() {
    container.replaceChildren();

    if (viewMode === 'bar' && activeFieldId && session) {
      const activeItem = session.items.find(i => i.observation.fieldId === activeFieldId);
      if (activeItem) {
        renderBar(activeItem);
        return;
      }
      viewMode = 'list';
    }

    const card = el('section', undefined, 'panel-card');
    card.setAttribute('aria-label', '填写任务');
    container.append(card);

    if (viewMode === 'single' && activeFieldId && session) {
      const activeItem = session.items.find(i => i.observation.fieldId === activeFieldId);
      if (activeItem) {
        renderSingle(card, activeItem);
        return;
      }
      viewMode = 'list';
    }

    if (viewMode === 'batch' && session) {
      renderBatch(card);
      return;
    }

    renderList(card);
  }

  function renderList(card: HTMLElement) {
    const counts = session?.counts || { verified: 0, assisted: 0, skipped: 0, existing: 0, missing: 0, todo: 0 };
    if (session && counts && session.phase === 'complete' && previousPhase !== 'complete' && counts.todo === 0 && !session.error) expanded = false;
    if (session) previousPhase = session.phase;
    const brandRow = el('div', undefined, 'brand-row');
    brandRow.append(el('span', 'Job ApplyMate'));
    const brandRight = el('div', undefined, 'brand-status');
    if (!session || session.busy || session.phase === 'understanding') {
      const stopBtn = el('button', '停止', 'btn-text');
      stopBtn.onclick = stop;
      brandRight.append(el('span', '填写中'), stopBtn);
    } else {
      const toggleBtn = el('button', expanded ? '收起' : '展开', 'btn-text');
      toggleBtn.onclick = () => { expanded = !expanded; render(); };
      brandRight.append(el('span', session.phase === 'stopped' ? '已停止' : counts.todo > 0 ? '待检查' : '填写结束'), toggleBtn);
    }
    brandRow.append(brandRight);
    card.append(brandRow);

    card.append(el('h1', '本次填写', 'main-title'));

    if (!session) {
      card.append(el('p', message, 'subtitle-summary'));
      return;
    }

    const verifiedCount = counts.verified + counts.assisted;
    const todoCount = counts.todo;
    const summaryText = session.phase !== 'complete' && session.phase !== 'stopped'
      ? (session.phase === 'understanding' ? '正在理解表单...'
        : session.phase === 'rules' ? '正在快速填写...'
        : session.phase === 'matching' ? 'AI 补充匹配中...'
        : '正在填写并检查...')
      : `网页已填写 ${verifiedCount} 项 · ${todoCount} 项待处理`;

    const summaryEl = el('p', summaryText, 'subtitle-summary');
    summaryEl.setAttribute('role', 'status');
    summaryEl.setAttribute('aria-live', 'polite');
    card.append(summaryEl);

    if (session.stopped) {
      const stoppedHint = el('p', '已停止自动填写。您可以继续人工处理下方字段。', 'section-desc');
      stoppedHint.style.marginTop = '6px';
      card.append(stoppedHint);
    }

    if (session.error) {
      const errEl = el('p', session.error, 'editor-status-badge');
      card.append(errEl);
    }

    if (!expanded) return;

    if (message && message !== '理解表单') {
      card.append(el('p', message, 'notice'));
    }

    const facts = session.context.profile.facts;
    const registry = session.context.registry;

    const todos = session.items.filter(item => item.status === 'todo');
    const missing = session.items.filter(item => item.status === 'missing');

    card.append(el('hr', undefined, 'divider'));

    // Section 1: 网页待处理
    const section1Header = el('div', undefined, 'section-title-row');
    section1Header.append(el('h2', `网页待处理 ${todos.length}`, 'section-heading'));
    card.append(section1Header);

    if (todos.length === 0) {
      card.append(el('p', '暂无待处理网页项', 'section-desc'));
    } else {
      todos.forEach((item, index) => {
        if (index > 0) card.append(el('hr', undefined, 'divider'));
        const meta = getItemMeta(item, facts, registry);
        const row = el('div', undefined, 'item-row');
        const info = el('div', undefined, 'item-info');
        info.append(el('div', meta.title, 'item-title'));
        info.append(el('div', meta.subtitle, 'item-subtitle'));
        row.append(info);

        const btn = el('button', meta.actionLabel, 'btn-outline');
        btn.onclick = () => {
          activeFieldId = item.observation.fieldId;
          viewMode = 'single';
          render();
        };
        row.append(btn);
        card.append(row);
      });
    }

    card.append(el('hr', undefined, 'divider'));

    // Section 2: 可补充资料 选填
    const section2Header = el('div', undefined, 'section-title-row');
    const titleLeft = el('div');
    titleLeft.append(el('span', '可补充资料', 'section-heading'));
    titleLeft.append(el('span', '选填', 'tag-optional'));
    section2Header.append(titleLeft);

    const batchLink = el('button', '一起补充', 'link-action');
    batchLink.type = 'button';
    batchLink.onclick = () => {
      viewMode = 'batch';
      render();
    };
    section2Header.append(batchLink);
    card.append(section2Header);

    card.append(el('p', '没提供的信息继续留空，不影响其他字段。', 'section-desc'));

    const displayMissing = missing.length > 0 ? missing : [];
    if (displayMissing.length === 0) {
      card.append(el('p', '暂无待补充资料', 'section-desc'));
    } else {
      displayMissing.forEach((item, index) => {
        if (index > 0) card.append(el('hr', undefined, 'divider'));
        const meta = getItemMeta(item, facts, registry);
        const row = el('div', undefined, 'item-row');
        const info = el('div', undefined, 'item-info');
        info.append(el('div', meta.title, 'item-title'));
        info.append(el('div', meta.subtitle, 'item-subtitle'));
        row.append(info);

        const btn = el('button', '补充', 'btn-outline');
        btn.setAttribute('aria-label', `补充${item.observation.label}`);
        btn.onclick = () => {
          activeFieldId = item.observation.fieldId;
          viewMode = 'single';
          render();
        };
        row.append(btn);
        card.append(row);
      });
    }

    // Collapsible "更多" details
    const more = el('details');
    more.append(el('summary', '更多'));
    more.append(el('p', `辅助完成 ${counts.assisted} · 保留原值 ${counts.existing} · 本次跳过 ${counts.skipped} · 无资料留空 ${counts.missing}`));

    const undoBtn = el('button', '撤销本次可恢复修改', 'btn-secondary');
    undoBtn.style.margin = '6px 4px 6px 0';
    undoBtn.onclick = async () => {
      undoBtn.disabled = true;
      try {
        const restored = await undo();
        message = `已恢复 ${restored} 项`;
        for (const item of session!.items.filter(i => i.status === 'verified')) {
          item.status = 'todo';
          item.reason = '已请求撤销，请核对网页';
        }
      } catch (err) {
        message = err instanceof Error ? err.message : '撤销失败';
      } finally {
        undoBtn.disabled = false;
        render();
      }
    };
    more.append(undoBtn);

    const diagBtn = el('button', '导出脱敏诊断', 'btn-secondary');
    diagBtn.style.margin = '6px 4px 6px 0';
    diagBtn.onclick = () => {
      const data = session!.items.map(i => ({
        fieldId: i.observation.fieldId,
        decisionId: i.decision?.decisionId,
        meaningId: i.decision?.meaningId,
        subject: i.decision?.subject,
        factId: i.decision?.factId,
        recordId: i.decision?.recordId,
        modelId: i.decision?.modelId,
        profileVersion: i.decision?.profileVersion,
        registryVersion: i.decision?.registryVersion,
        status: i.status,
        outcome: i.outcome?.status,
        adapter: i.outcome?.adapterId,
      }));
      const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
      const link = el('a');
      link.href = url;
      link.download = 'fill-diagnostics.json';
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    };
    more.append(diagBtn);

    const skipped = session.items.filter(item => item.status === 'skipped');
    if (skipped.length) {
      more.append(el('p', `本次跳过：${skipped.map(item => cleanLabel(item.observation.label)).join('、')}`));
    }
    card.append(more);
  }

  function renderSingle(card: HTMLElement, item: SessionItem) {
    const controller = session!;
    const facts = controller.context.profile.facts;
    const meta = getItemMeta(item, facts, controller.context.registry);
    const draft = getDraft(item);
    const result = results.get(item.observation.fieldId);

    // Nav back row
    const navRow = el('div', undefined, 'nav-back-row');
    const backBtn = el('button', '← 返回列表', 'nav-back-btn');
    backBtn.type = 'button';
    backBtn.onclick = () => {
      viewMode = 'list';
      render();
    };
    navRow.append(backBtn);
    card.append(navRow);

    // Title and Meta
    const titleText = item.observation.groupLabel
      ? `${item.observation.groupLabel} · ${meta.title}`
      : meta.title;
    card.append(el('h2', titleText, 'editor-title'));

    const recordSummary = getRecordSummary(item.decision?.recordId || item.observation.ruleBinding?.recordId, facts);
    if (recordSummary) {
      card.append(el('div', `所属经历：${recordSummary}`, 'editor-meta'));
    }

    if (item.reason) {
      card.append(el('div', item.reason, 'editor-status-badge'));
    }

    // Result banner if exists
    if (result) {
      renderResultBanner(card, item, result);
    }

    const hasKnownFact = Boolean(meta.fact);
    const isDatePrecisionIssue = meta.isDatePrecision;
    const isEditingAnswer = Boolean(draft.isEditing || !hasKnownFact || isDatePrecisionIssue || item.status === 'missing');

    if (!isEditingAnswer && hasKnownFact) {
      // Case A: 使用已有答案修复网页 (Section 4.2)
      renderExistingFactRepair(card, item, meta.fact!, recordSummary);
    } else {
      // Case B: 补充新信息 / 补全日期 / 修改已有答案 (Section 4.1, 4.3, 5)
      renderAnswerEditor(card, item, meta.fact);
    }
  }

  function renderResultBanner(parent: HTMLElement, item: SessionItem, result: ResultState) {
    const banner = el('div', undefined, 'feedback-banner');
    const isBothSuccess = result.webStatus === 'success' && result.profileStatus === 'success';
    const isProfileOnlySuccess = result.profileStatus === 'success' && result.webStatus === 'skipped';
    const isWebOnlySuccess = result.webStatus === 'success' && result.profileStatus === 'none';
    const isPartialFailed = (result.webStatus === 'failed' && result.profileStatus === 'success') || (result.webStatus === 'success' && result.profileStatus === 'failed');
    const isBothFailed = result.webStatus === 'failed' && result.profileStatus === 'failed';

    if (isBothSuccess || isProfileOnlySuccess || isWebOnlySuccess) {
      banner.classList.add('feedback-success');
    } else if (isPartialFailed) {
      banner.classList.add('feedback-partial');
    } else if (isBothFailed) {
      banner.classList.add('feedback-error');
    } else {
      banner.classList.add('feedback-partial');
    }

    const lines: string[] = [];
    if (result.webStatus === 'success') lines.push('网页：已填入');
    else if (result.webStatus === 'failed') lines.push(`网页还未填入（${result.webMessage || '填写未成功'}）`);
    else if (result.webStatus === 'skipped') lines.push('网页：本次未填写');

    if (result.profileStatus === 'success') lines.push('个人资料：已保存');
    else if (result.profileStatus === 'failed') lines.push(`资料尚未保存（${result.profileMessage || '保存失败'}）`);
    else if (result.profileStatus === 'none') lines.push('个人资料：未修改');

    lines.forEach(line => banner.append(el('div', line)));

    // Undo buttons (Section 10)
    const undoStack = el('div');
    undoStack.style.marginTop = '6px';
    undoStack.style.display = 'flex';
    undoStack.style.gap = '8px';

    if (result.profileStatus === 'success' && result.savedProfileLabel && result.previousProfileValue !== undefined) {
      const undoProfileBtn = el('button', '撤销这次资料更新', 'link-action');
      undoProfileBtn.onclick = async () => {
        try {
          const res = await send<{ profileVersion: string }>({
            type: 'SAVE_PERSONAL_FIELD',
            payload: {
              label: result.savedProfileLabel!,
              value: result.previousProfileValue!,
              expectedValue: savedValues.get(result.savedProfileKey!) || '',
            },
          });
          if (!res.success) throw new Error(res.error || '撤销失败');
          savedValues.set(result.savedProfileKey!, result.previousProfileValue!);
          result.profileStatus = 'none';
          result.profileMessage = '已撤销资料更新';
          render();
        } catch (err) {
          alert(err instanceof Error ? err.message : '撤销资料更新失败');
        }
      };
      undoStack.append(undoProfileBtn);
    }

    if (result.webStatus === 'success') {
      const undoWebBtn = el('button', '撤销本次填写', 'link-action');
      undoWebBtn.onclick = async () => {
        await session!.manual(item, '');
        result.webStatus = 'none';
        render();
      };
      undoStack.append(undoWebBtn);
    }

    if (undoStack.children.length > 0) banner.append(undoStack);
    parent.append(banner);

    // Navigation buttons after result
    const nextItem = findNextItem(item);
    const navStack = el('div', undefined, 'actions-row');
    navStack.style.marginBottom = '12px';

    if (nextItem && (isBothSuccess || isWebOnlySuccess)) {
      const nextBtn = el('button', '下一项', 'btn-primary');
      nextBtn.onclick = () => {
        activeFieldId = nextItem.observation.fieldId;
        render();
      };
      navStack.append(nextBtn);
    }

    const itemFact = session?.context.profile.facts.find(f => f.id === item.decision?.factId);
    if (result.webStatus === 'failed') {
      const retryWebBtn = el('button', '仅重试网页', 'btn-primary');
      retryWebBtn.onclick = async () => {
        actionPending = true;
        try {
          await session!.manual(item, drafts.get(item.observation.fieldId)?.value || itemFact?.value || '');
          result.webStatus = 'success';
          result.webMessage = undefined;
        } catch (e) {
          result.webStatus = 'failed';
          result.webMessage = e instanceof Error ? e.message : '网页重试失败';
        } finally {
          actionPending = false;
          render();
        }
      };
      navStack.append(retryWebBtn);

      const toPageBtn = el('button', '去网页选择', 'btn-secondary');
      toPageBtn.onclick = () => {
        locate(item);
        viewMode = 'bar';
        render();
      };
      navStack.append(toPageBtn);
    } else if (result.profileStatus === 'failed') {
      const retryProfileBtn = el('button', '仅重试保存资料', 'btn-primary');
      retryProfileBtn.onclick = async () => {
        actionPending = true;
        try {
          const draftVal = drafts.get(item.observation.fieldId)?.value || '';
          const res = await send<{ profileVersion: string }>({
            type: 'SAVE_PERSONAL_FIELD',
            payload: {
              label: drafts.get(item.observation.fieldId)?.label || cleanLabel(item.observation.label),
              value: draftVal,
            },
          });
          if (!res.success) throw new Error(res.error || '保存资料失败');
          result.profileStatus = 'success';
          result.profileMessage = undefined;
        } catch (e) {
          result.profileStatus = 'failed';
          result.profileMessage = e instanceof Error ? e.message : '资料保存失败';
        } finally {
          actionPending = false;
          render();
        }
      };
      navStack.append(retryProfileBtn);
    } else if (result.profileStatus === 'success' && result.webStatus === 'skipped') {
      const fillWebBtn = el('button', '填到当前网页', 'btn-secondary');
      fillWebBtn.onclick = async () => {
        actionPending = true;
        try {
          await session!.manual(item, drafts.get(item.observation.fieldId)?.value || itemFact?.value || '');
          result.webStatus = 'success';
        } catch (e) {
          result.webStatus = 'failed';
          result.webMessage = e instanceof Error ? e.message : '填入失败';
        } finally {
          actionPending = false;
          render();
        }
      };
      navStack.append(fillWebBtn);
    }

    parent.append(navStack);
  }

  function findNextItem(currentItem: SessionItem): SessionItem | undefined {
    if (!session) return undefined;
    const remainingTodos = session.items.filter(i => i.status === 'todo' && i.observation.fieldId !== currentItem.observation.fieldId);
    if (remainingTodos.length > 0) return remainingTodos[0];
    const remainingMissing = session.items.filter(i => i.status === 'missing' && i.observation.fieldId !== currentItem.observation.fieldId);
    return remainingMissing[0];
  }

  function renderExistingFactRepair(card: HTMLElement, item: SessionItem, fact: ProfileFact, recordSummary: string) {
    const controller = session!;
    const draft = getDraft(item);

    const infoBox = el('div', undefined, 'info-field-box');
    const valRow = el('div', undefined, 'info-field-row');
    valRow.append(el('span', '资料值：', 'info-field-label'), el('strong', fact.value));
    infoBox.append(valRow);

    if (recordSummary) {
      const recRow = el('div', undefined, 'info-field-row');
      recRow.append(el('span', '所属经历：', 'info-field-label'), el('span', recordSummary));
      infoBox.append(recRow);
    }

    if (item.outcome?.observedValue) {
      const obsRow = el('div', undefined, 'info-field-row');
      obsRow.append(el('span', '网页读回：', 'info-field-label'), el('span', item.outcome.observedValue));
      infoBox.append(obsRow);
    }
    card.append(infoBox);

    const isDropdown = item.observation.kind === 'select' || item.observation.kind === 'combobox' || /下拉|选项|select/i.test(item.reason);

    const actionStack = el('div', undefined, 'actions-stack');
    if (isDropdown) {
      const toPageBtn = el('button', '去网页选择', 'btn-primary');
      toPageBtn.onclick = () => {
        locate(item);
        viewMode = 'bar';
        render();
      };
      actionStack.append(toPageBtn);
    } else {
      const retryBtn = el('button', '重试填写', 'btn-primary');
      retryBtn.disabled = controller.busy || actionPending;
      retryBtn.onclick = async () => {
        actionPending = true;
        try {
          await controller.manual(item, fact.value, item.decision?.targetOptionIds?.[0]);
          results.set(item.observation.fieldId, {
            webStatus: 'success',
            profileStatus: 'none',
          });
        } catch (e) {
          results.set(item.observation.fieldId, {
            webStatus: 'failed',
            webMessage: e instanceof Error ? e.message : '填写失败',
            profileStatus: 'none',
          });
        } finally {
          actionPending = false;
          render();
        }
      };
      actionStack.append(retryBtn);

      const recheckBtn = el('button', '检查是否已填好', 'btn-secondary');
      recheckBtn.disabled = controller.busy || actionPending;
      recheckBtn.onclick = async () => {
        actionPending = true;
        try {
          await controller.recheck(item);
        } finally {
          actionPending = false;
          render();
        }
      };
      actionStack.append(recheckBtn);
    }

    // Alternative candidates (换一条资料 - Section 4.2)
    const sameCategoryFacts = controller.context.profile.facts.filter(f => f.meaningId === fact.meaningId && f.id !== fact.id);
    if (sameCategoryFacts.length > 0) {
      const switchBox = el('div');
      switchBox.style.marginTop = '8px';
      const switchSelect = el('select');
      switchSelect.append(el('option', '换一条资料...'));
      sameCategoryFacts.forEach(alt => {
        const altRecord = getRecordSummary(alt.recordId, controller.context.profile.facts);
        const opt = el('option', `${alt.value}${altRecord ? ` (${altRecord})` : ''}`);
        opt.value = alt.id;
        switchSelect.append(opt);
      });
      switchSelect.onchange = async () => {
        const chosen = sameCategoryFacts.find(f => f.id === switchSelect.value);
        if (chosen) {
          await controller.manual(item, chosen.value);
          render();
        }
      };
      switchBox.append(switchSelect);
      actionStack.append(switchBox);
    }

    const modifyBtn = el('button', '修改答案', 'btn-secondary');
    modifyBtn.onclick = () => {
      draft.isEditing = true;
      draft.value = fact.value;
      draft.target = 'page';
      render();
    };
    actionStack.append(modifyBtn);

    const skipBtn = el('button', '本次跳过', 'btn-text');
    skipBtn.onclick = () => {
      controller.skip(item);
      viewMode = 'list';
      render();
    };
    actionStack.append(skipBtn);

    card.append(actionStack);
  }

  function renderAnswerEditor(card: HTMLElement, item: SessionItem, existingFact?: ProfileFact) {
    const controller = session!;
    const draft = getDraft(item);
    const facts = controller.context.profile.facts;
    const registry = controller.context.registry;

    const knownMeaning = item.decision?.meaningId || item.observation.ruleBinding?.meaningId;
    const knownRecord = item.decision?.recordId || item.observation.ruleBinding?.recordId;
    const isRecordField = Boolean(knownRecord && /^(education|experience|projects)\./.test(knownMeaning || ''));

    const definition = matchSupplementDefinition(draft.label, registry)
      || registry.find(def => def.id === knownMeaning);

    // Save location line
    const saveLocRow = el('div', undefined, 'editor-meta');
    saveLocRow.style.display = 'flex';
    saveLocRow.style.justifyContent = 'space-between';
    saveLocRow.style.alignItems = 'center';

    const saveLocText = el('span');
    if (isRecordField) {
      const recSummary = getRecordSummary(knownRecord, facts);
      saveLocText.textContent = `保存位置：个人资料 → ${recSummary || '对应经历'} → ${draft.label}`;
    } else {
      saveLocText.textContent = `保存位置：个人资料 → ${definition?.label || draft.label}`;
    }
    saveLocRow.append(saveLocText);

    if (!isRecordField) {
      const changeNameBtn = el('button', draft.customLabel ? '完成' : '修改', 'link-action');
      changeNameBtn.onclick = () => {
        draft.customLabel = !draft.customLabel;
        render();
      };
      saveLocRow.append(changeNameBtn);
    }
    card.append(saveLocRow);

    if (draft.customLabel) {
      const nameInput = el('input');
      nameInput.value = draft.label;
      nameInput.placeholder = '字段名称';
      nameInput.setAttribute('aria-label', '修改信息名称');
      nameInput.style.marginBottom = '10px';
      nameInput.oninput = () => {
        draft.label = nameInput.value;
      };
      card.append(nameInput);
    }

    // Tailored Input Control (Section 5)
    renderTypedAnswerControl(card, item, draft, existingFact);

    // Target Selection ("应用到")
    const targetLabel = el('div', '应用到：', 'info-field-label');
    targetLabel.style.marginTop = '12px';
    card.append(targetLabel);

    const segmented = el('div', undefined, 'target-segmented');
    const targets: Array<{ id: FillTarget; label: string }> = [
      { id: 'both', label: '两处都用' },
      { id: 'page', label: '当前网页' },
      { id: 'profile', label: '个人资料' },
    ];
    targets.forEach(t => {
      const opt = el('button', t.label, `target-option${draft.target === t.id ? ' active' : ''}`);
      opt.type = 'button';
      opt.onclick = () => {
        draft.target = t.id;
        render();
      };
      segmented.append(opt);
    });
    card.append(segmented);

    // Impact prompt text
    const isReplacing = Boolean(item.observation.currentValue);
    const isUpdatingFact = Boolean(existingFact);

    let impactText = '';
    if (draft.target === 'both') {
      impactText = isUpdatingFact ? '更新个人资料，并填入当前字段' : '新增到个人资料，并填入当前字段';
    } else if (draft.target === 'page') {
      impactText = isReplacing ? '替换网页当前内容，不修改个人资料' : '仅填入当前网页，不修改个人资料';
    } else {
      impactText = isUpdatingFact ? '仅更新个人资料，当前网页保持留空' : '仅保存到个人资料，当前网页保持留空';
    }
    card.append(el('div', impactText, 'impact-hint'));

    // Primary action button
    let primaryBtnText = '';
    if (draft.target === 'both') {
      primaryBtnText = isUpdatingFact ? '更新资料并填入' : '保存并填入';
    } else if (draft.target === 'page') {
      primaryBtnText = isReplacing ? '替换网页内容' : '填入网页';
    } else {
      primaryBtnText = isUpdatingFact ? '更新个人资料' : '保存资料';
    }

    const actionStack = el('div', undefined, 'actions-stack');
    const mainActionBtn = el('button', primaryBtnText, 'btn-primary');
    mainActionBtn.disabled = controller.busy || actionPending;

    mainActionBtn.onclick = async () => {
      const val = draft.value.trim();
      if (!val) {
        alert('请输入或选择内容');
        return;
      }
      actionPending = true;
      let webSuccess = false;
      let webErrorMsg: string | undefined;
      let profileSuccess = false;
      let profileErrorMsg: string | undefined;
      let prevProfileVal: string | undefined;
      let savedKey: string | undefined;
      let savedLabel: string | undefined;

      try {
        if (draft.target === 'both' || draft.target === 'profile') {
          savedLabel = draft.label.trim();
          if (isRecordField) {
            const addId = crypto.randomUUID();
            const factPayload: AdditionalFact = {
              id: addId,
              meaningId: knownMeaning || `additional.${addId}`,
              recordId: knownRecord,
              label: savedLabel,
              subject: item.decision?.subject || 'self',
              value: val,
              valueType: /日期|时间/.test(savedLabel) ? 'date' : 'text',
              updatedAt: new Date().toISOString(),
            };
            const res = await send({
              type: 'SAVE_ADDITIONAL_FACT',
              payload: {
                fact: factPayload,
                profileVersion: controller.context.saveProfileVersion || controller.context.profile.version,
              },
            });
            if (!res.success) throw new Error(res.error || '保存资料失败');
            profileSuccess = true;
          } else {
            const def = matchSupplementDefinition(savedLabel, registry);
            savedKey = def?.id || normalizePersonalFieldLabel(savedLabel);
            const prev = facts.find(f => f.meaningId === def?.id);
            prevProfileVal = prev?.value;
            const expectedVal = savedValues.get(savedKey) ?? (prev?.value ? prev.value : '');
            const res = await send<{ profileVersion: string }>({
              type: 'SAVE_PERSONAL_FIELD',
              payload: {
                label: savedLabel,
                value: val,
                expectedValue: expectedVal,
              },
            });
            if (!res.success) throw new Error(res.error || '保存资料失败');
            savedValues.set(savedKey, val);
            if (res.data?.profileVersion) controller.context.saveProfileVersion = res.data.profileVersion;
            profileSuccess = true;
          }
        }
      } catch (err) {
        profileErrorMsg = err instanceof Error ? err.message : '保存资料失败';
      }

      if (draft.target === 'both' || draft.target === 'page') {
        try {
          await controller.manual(item, val);
          webSuccess = true;
        } catch (err) {
          webErrorMsg = err instanceof Error ? err.message : '填入网页失败';
        }
      } else {
        item.status = 'skipped';
        item.reason = '已保存到个人资料，本次留空';
      }

      results.set(item.observation.fieldId, {
        webStatus: draft.target === 'profile' ? 'skipped' : webSuccess ? 'success' : 'failed',
        webMessage: webErrorMsg,
        profileStatus: draft.target === 'page' ? 'none' : profileSuccess ? 'success' : 'failed',
        profileMessage: profileErrorMsg,
        previousProfileValue: prevProfileVal,
        savedProfileKey: savedKey,
        savedProfileLabel: savedLabel,
      });

      actionPending = false;
      render();
    };

    actionStack.append(mainActionBtn);

    const skipBtn = el('button', '本次跳过', 'btn-text');
    skipBtn.onclick = () => {
      controller.skip(item);
      viewMode = 'list';
      render();
    };
    actionStack.append(skipBtn);

    card.append(actionStack);
  }

  function renderTypedAnswerControl(parent: HTMLElement, item: SessionItem, draft: DraftState, existingFact?: ProfileFact) {
    const rawLabel = item.observation.label;
    const isAge = /年龄|周岁|age/i.test(rawLabel);
    const isUrl = /作品|链接|主页|portfolio|website|url/i.test(rawLabel);
    const isCity = /城市|地点|city|location/i.test(rawLabel);
    const isLanguage = /语言|外语|英语|language/i.test(rawLabel);
    const isDate = /日期|时间|date|year/i.test(rawLabel);
    const hasOptions = item.observation.options.length > 0;

    if (hasOptions) {
      // 真实网页选项 (Section 5)
      const select = el('select');
      select.setAttribute('aria-label', '补充个人资料');
      select.append(el('option', '请选择网页选项'));
      item.observation.options.forEach(opt => {
        const optionEl = el('option', opt.label);
        optionEl.value = opt.label;
        if (draft.value === opt.label) optionEl.selected = true;
        select.append(optionEl);
      });
      select.onchange = () => {
        draft.value = select.value === '请选择网页选项' ? '' : select.value;
      };
      parent.append(select);
      return;
    }

    if (isAge) {
      // 年龄输入 + "岁"
      const group = el('div', undefined, 'unit-input-group');
      const numInput = el('input');
      numInput.setAttribute('aria-label', '补充个人资料');
      numInput.type = 'number';
      numInput.min = '1';
      numInput.max = '120';
      numInput.placeholder = '例如 24';
      numInput.value = draft.value;
      numInput.oninput = () => { draft.value = numInput.value; };
      group.append(numInput, el('span', '岁', 'unit-text'));
      parent.append(group);
      return;
    }

    if (isUrl) {
      // URL 输入
      const urlInput = el('input');
      urlInput.setAttribute('aria-label', '补充个人资料');
      urlInput.type = 'url';
      urlInput.placeholder = 'https://...';
      urlInput.value = draft.value;
      urlInput.oninput = () => { draft.value = urlInput.value; };
      parent.append(urlInput);
      return;
    }

    if (isCity) {
      // 期望城市 + 快捷标签
      const cityInput = el('input');
      cityInput.setAttribute('aria-label', '补充个人资料');
      cityInput.placeholder = '例如 北京、上海';
      cityInput.value = draft.value;
      cityInput.oninput = () => { draft.value = cityInput.value; };
      parent.append(cityInput);

      const chips = el('div', undefined, 'chip-container');
      COMMON_CITIES.forEach(city => {
        const chip = el('button', city, 'chip');
        chip.type = 'button';
        chip.onclick = () => {
          const current = cityInput.value.trim();
          if (!current) {
            cityInput.value = city;
          } else if (current.includes(city)) {
            cityInput.value = current.replace(new RegExp(`[、,]?\\s*${city}`), '').replace(/^、/, '').trim();
          } else {
            cityInput.value = `${current}、${city}`;
          }
          draft.value = cityInput.value;
        };
        chips.append(chip);
      });
      parent.append(chips);
      return;
    }

    if (isLanguage) {
      // 语言能力 + 快捷标签
      const langInput = el('input');
      langInput.placeholder = '例如 英语 六级';
      langInput.value = draft.value;
      langInput.oninput = () => { draft.value = langInput.value; };
      parent.append(langInput);

      const chips = el('div', undefined, 'chip-container');
      COMMON_LANGUAGES.forEach(lang => {
        const chip = el('button', lang, 'chip');
        chip.type = 'button';
        chip.onclick = () => {
          langInput.value = lang;
          draft.value = lang;
        };
        chips.append(chip);
      });
      parent.append(chips);
      return;
    }

    if (isDate) {
      // 日期输入
      const existingVal = existingFact?.value || draft.value || '';
      if (!draft.dateParts) draft.dateParts = parseDateParts(existingVal);

      if (existingVal && (!draft.dateParts.day || !draft.dateParts.month)) {
        parent.append(el('div', `原资料：${existingVal}（缺少具体日期，请核对真实日期）`, 'editor-meta'));
      }

      const dateRow = el('div', undefined, 'date-row');
      const yInput = el('input', undefined, 'date-input');
      yInput.placeholder = '年 (YYYY)';
      yInput.type = 'number';
      yInput.value = draft.dateParts.year;

      const mInput = el('input', undefined, 'date-input');
      mInput.placeholder = '月 (MM)';
      mInput.type = 'number';
      mInput.min = '1';
      mInput.max = '12';
      mInput.value = draft.dateParts.month;

      const dInput = el('input', undefined, 'date-input');
      dInput.placeholder = '日 (DD)';
      dInput.type = 'number';
      dInput.min = '1';
      dInput.max = '31';
      dInput.value = draft.dateParts.day;

      const syncDate = () => {
        draft.dateParts = { year: yInput.value, month: mInput.value, day: dInput.value };
        draft.value = formatDateParts(draft.dateParts);
      };

      yInput.oninput = syncDate;
      mInput.oninput = syncDate;
      dInput.oninput = syncDate;

      dateRow.append(yInput, mInput, dInput);
      parent.append(dateRow);
      return;
    }

    // Default text or textarea
    const textInput = el('input');
    textInput.setAttribute('aria-label', '补充个人资料');
    textInput.placeholder = '输入内容';
    textInput.value = draft.value;
    textInput.oninput = () => { draft.value = textInput.value; };
    parent.append(textInput);
  }

  function renderBatch(card: HTMLElement) {
    const controller = session!;
    const navRow = el('div', undefined, 'nav-back-row');
    const backBtn = el('button', '← 返回列表', 'nav-back-btn');
    backBtn.type = 'button';
    backBtn.onclick = () => {
      viewMode = 'list';
      render();
    };
    navRow.append(backBtn);
    card.append(navRow);

    card.append(el('h2', '集中完善个人资料', 'editor-title'));
    card.append(el('p', '一次填写多个缺失项，保存后其他页面也能自动使用。留空表示本次不补充。', 'section-desc'));

    // Gather candidate fields to supplement
    const candidateFields: Array<{ label: string; fieldId?: string; isMissingSessionItem?: boolean }> = [];
    const addedLabels = new Set<string>();

    controller.items.filter(i => i.status === 'missing').forEach(item => {
      const lbl = cleanLabel(item.observation.label);
      if (!addedLabels.has(lbl)) {
        addedLabels.add(lbl);
        candidateFields.push({ label: lbl, fieldId: item.observation.fieldId, isMissingSessionItem: true });
      }
    });

    PERSONAL_EXTRA_FIELDS.forEach(field => {
      if (!addedLabels.has(field.label)) {
        const val = getPersonalFieldValue(controller.context.profile as any, {
          id: `personal.${field.key}`,
          key: field.key,
          label: field.label,
          aliases: [...field.aliases],
          sourceCollection: 'personal',
          subject: 'self',
          valueType: 'text',
          allowedTransformations: [],
          scope: 'builtin',
          version: 1,
          provenance: 'default',
        });
        if (!val) {
          addedLabels.add(field.label);
          candidateFields.push({ label: field.label });
        }
      }
    });

    const batchInputs = new Map<string, HTMLInputElement>();

    candidateFields.forEach((cf, idx) => {
      if (idx > 0) card.append(el('hr', undefined, 'divider'));
      const row = el('div');
      row.append(el('label', cf.label, 'item-title'));
      const input = el('input');
      input.placeholder = `填写${cf.label}`;
      input.style.marginTop = '4px';
      row.append(input);
      batchInputs.set(cf.label, input);
      card.append(row);
    });

    const actionStack = el('div', undefined, 'actions-stack');
    actionStack.style.marginTop = '16px';

    const saveAllBtn = el('button', '保存个人资料', 'btn-primary');
    saveAllBtn.disabled = actionPending;
    saveAllBtn.onclick = async () => {
      actionPending = true;
      const savedLabels: string[] = [];
      try {
        for (const [lbl, input] of batchInputs.entries()) {
          const val = input.value.trim();
          if (!val) continue;
          const res = await send<{ profileVersion: string }>({
            type: 'SAVE_PERSONAL_FIELD',
            payload: { label: lbl, value: val },
          });
          if (res.success) {
            savedLabels.push(lbl);
            savedValues.set(lbl, val);
          }
        }
        if (savedLabels.length > 0) {
          message = `已保存 ${savedLabels.join('、')} 到个人资料`;
          viewMode = 'list';
        } else {
          message = '未填写任何内容，已保持原样';
        }
      } catch (err) {
        message = err instanceof Error ? err.message : '保存失败';
      } finally {
        actionPending = false;
        render();
      }
    };
    actionStack.append(saveAllBtn);
    card.append(actionStack);
  }

  function renderBar(item: SessionItem) {
    const meta = getItemMeta(item, session?.context.profile.facts, session?.context.registry);
    const targetText = meta.fact?.value || meta.title;

    const bar = el('section', undefined, 'mini-bar');
    bar.setAttribute('aria-label', '网页选择提示');

    const promptText = el('span');
    promptText.append(el('span', '请选择：'), el('strong', targetText));
    bar.append(promptText);

    const recheckBtn = el('button', '我已选好，检查', 'btn-outline');
    recheckBtn.style.padding = '4px 10px';
    recheckBtn.onclick = async () => {
      recheckBtn.disabled = true;
      try {
        await session!.recheck(item);
        viewMode = 'single';
      } finally {
        render();
      }
    };
    bar.append(recheckBtn);

    const expandBtn = el('button', '展开', 'btn-text');
    expandBtn.onclick = () => {
      viewMode = 'single';
      render();
    };
    bar.append(expandBtn);

    container.append(bar);
  }

  render();

  return {
    bind(controller: FillSessionController) {
      session = controller;
      render();
    },
    update: render,
    status(text: string) {
      message = text;
      render();
    },
    close() {
      host.remove();
    },
  };
}
