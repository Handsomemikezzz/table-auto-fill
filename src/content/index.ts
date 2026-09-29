import { FormFiller } from './formFiller.ts';
import { verifyControl, isAutomatedControlAction } from './fillEngine.ts';
import { observeControl, discoverControls } from './controlObservation.ts';
import { createPageObserver, readModelOptions } from './modelLedObservation.ts';
import { createFillTaskPanel } from './fillTaskPanel.ts';
import { FillSessionController } from '../autofill/fillSessionController.ts';
import { createInfoOverlayController } from './infoOverlay.ts';
import { createProfileSnapshot } from '../autofill/profileSnapshot.ts';
import { getResumeLibrary } from '../shared/resumes.ts';
import type { FillContextData, FieldObservation, FieldDecision } from '../autofill/contracts.ts';
import type { FillOutcome } from '../shared/fillModel.ts';
import type { Message, MessageResponse, UserProfile, FocusedFieldWriteResult } from '../shared/types.ts';

const formFiller = new FormFiller();
let session: FillSessionController | undefined;
let starting = false;
let localSessionId = '';
let localCancelled = false;
let localUserEdits = new WeakSet<HTMLElement>();
const watchedRoots = new WeakSet<Node>();
let observer: ReturnType<typeof createPageObserver> | undefined;
let lastFocusedControl: HTMLElement | null = null;
let selectionCancel: (() => void) | undefined;
async function send<T = any>(message: Message): Promise<MessageResponse<T>> {
  try { return await chrome.runtime.sendMessage(message); }
  catch (error) { return { success: false, error: error instanceof Error ? error.message : '无法连接插件' }; }
}
async function bridge<T = any>(payload: Record<string, unknown>): Promise<T> {
  const result = await send<T>({ type: 'FILL_PAGE_BRIDGE', payload });
  if (!result.success) throw new Error(result.error || '页面操作失败');
  return result.data as T;
}
const infoOverlay = createInfoOverlayController({
  getProfile: async sourceId => {
    const result = await send<UserProfile>({ type: 'GET_USER_PROFILE' });
    if (!result.data) return null;
    if (!sourceId || sourceId === 'default') return result.data;
    const snapshot = createProfileSnapshot(result.data, sourceId);
    const variant = getResumeLibrary(result.data).find(item => item.id === sourceId)?.parsedProfile;
    return variant ? { ...result.data, ...variant, personal: { ...variant.personal, ...Object.fromEntries(snapshot.facts.filter(fact => fact.meaningId.startsWith('personal.')).map(fact => [fact.meaningId.split('.')[1], fact.value])) } } as UserProfile : result.data;
  },
  writeValue: async value => {
    const result = await send<FocusedFieldWriteResult>({ type: 'WRITE_FOCUSED_FIELD_FROM_PAGE', payload: { value } });
    return result.data || { written: false, reason: result.error || 'VALUE_REJECTED' };
  },
  openSettings: () => { void send({ type: 'OPEN_PROFILE_SETTINGS' }); },
});
document.addEventListener('focusin', event => {
  if (event.target instanceof HTMLElement && !event.target.closest('[data-job-applymate-ui], [data-job-applymate-overlay]') && observeControl(event.target).kind !== 'unsupported') lastFocusedControl = event.target;
}, true);

async function startFill(sourceId = 'default', attachmentId?: string | null, region?: DOMRect) {
  if (window !== window.top) return;
  if (starting || session?.busy) return;
  starting = true;
  const sessionId = crypto.randomUUID();
  const oldSession = session; oldSession?.stop(); session = undefined;
  let cancelled = false;
  const regionData = region ? { x: region.x, y: region.y, width: region.width, height: region.height } : undefined;
  const stop = () => {
    cancelled = true;
    session?.stop();
    void send({ type: 'END_FILL_SESSION', payload: { sessionId } });
    void bridge({ action: 'cancel', sessionId });
    panel.status('已停止');
  };
  const panel = createFillTaskPanel(send, item => { void bridge({ action: 'locate', sessionId, field: item.observation }); }, () => bridge<number>({ action: 'undo', sessionId }), stop);
  try {
    const result = await send<FillContextData>({ type: 'BEGIN_FILL_SESSION', payload: { sessionId, sourceId, attachmentId, origin: location.origin } });
    if (cancelled) { void send({ type: 'END_FILL_SESSION', payload: { sessionId } }); return; }
    if (!result.success || !result.data) throw new Error(result.error || '暂时无法连接填写服务');
    const context = result.data;
    session = new FillSessionController(context, {
      observe: () => bridge<FieldObservation[]>({ action: 'observe', sessionId, registry: context.registry, profile: context.profile, region: regionData }),
      decide: async (fields, corrections) => {
        const response = await send<FieldDecision[]>({ type: 'DECIDE_FILL_FIELDS', payload: { sessionId, fields, corrections } });
        if (!response.success || !response.data) throw new Error(response.error || '暂时无法连接填写服务');
        return response.data;
      },
      execute: (field, decision, value, _continue, overwrite) => bridge<FillOutcome>({ action: 'execute', sessionId, field, decision, value, overwrite }),
      verify: (field, decision, value) => bridge<FillOutcome>({ action: 'verify', sessionId, field, decision, value }),
      readOptions: (field, query) => bridge({ action: 'readOptions', sessionId, field, query }),
      cancel: () => { void send({ type: 'END_FILL_SESSION', payload: { sessionId } }); void bridge({ action: 'cancel', sessionId }); },
      update: () => panel.update(),
    });
    panel.bind(session);
    starting = false;
    await session.run();
    if (!session.items.length) panel.status('当前页面未发现可操作字段。');
  } catch (error) { panel.status(error instanceof Error ? error.message : '填写失败'); }
  finally { starting = false; }
}

function selectRegion(sourceId: string) {
  selectionCancel?.();
  const layer = document.createElement('div'); layer.dataset.jobApplymateUi = 'true';
  layer.style.cssText = 'position:fixed;inset:0;z-index:2147483646;background:#163d5522;cursor:crosshair';
  const hint = document.createElement('div'); hint.textContent = '拖动选择填写区域 · Esc 取消'; hint.style.cssText = 'position:absolute;top:12px;left:12px;background:white;padding:12px;border-radius:8px;color:#123'; layer.append(hint);
  const box = document.createElement('div'); box.style.cssText = 'position:absolute;border:2px solid #2077a0;background:#fff3;pointer-events:none'; layer.append(box);
  let start: { x: number; y: number } | undefined;
  const cleanup = () => { layer.remove(); document.removeEventListener('keydown', onKey, true); selectionCancel = undefined; };
  const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') cleanup(); };
  selectionCancel = cleanup;
  layer.onpointerdown = event => { start = { x: event.clientX, y: event.clientY }; layer.setPointerCapture(event.pointerId); };
  layer.onpointermove = event => { if (!start) return; Object.assign(box.style, { left: `${Math.min(start.x, event.clientX)}px`, top: `${Math.min(start.y, event.clientY)}px`, width: `${Math.abs(start.x - event.clientX)}px`, height: `${Math.abs(start.y - event.clientY)}px` }); };
  layer.onpointerup = event => { if (!start) return; const rect = new DOMRect(Math.min(start.x, event.clientX), Math.min(start.y, event.clientY), Math.abs(start.x - event.clientX), Math.abs(start.y - event.clientY)); cleanup(); void startFill(sourceId, null, rect); };
  document.addEventListener('keydown', onKey, true); document.documentElement.append(layer);
}

async function localOperation(payload: Record<string, any>) {
  if (payload.action === 'observe') {
    if (localSessionId !== payload.sessionId) {
      localSessionId = payload.sessionId; localCancelled = false; localUserEdits = new WeakSet(); formFiller.beginFillSession();
      const region = payload.region ? new DOMRect(payload.region.x, payload.region.y, payload.region.width, payload.region.height) : undefined;
      observer = createPageObserver(payload.registry, region, payload.profile);
    }
    const fields = observer!.observe();
    for (const element of observer!.nodes.values()) {
      const root = element.getRootNode();
      if (watchedRoots.has(root)) continue;
      watchedRoots.add(root);
      const track = (event: Event) => {
        if (!event.isTrusted || isAutomatedControlAction(element.ownerDocument) || !(event.target instanceof Node)) return;
        for (const control of observer?.nodes.values() || []) if (control === event.target || control.contains(event.target) || observeControl(control).group.some(member => member === event.target)) localUserEdits.add(control);
      };
      root.addEventListener('input', track, true); root.addEventListener('change', track, true);
    }
    return fields;
  }
  if (payload.action === 'cancel') { if (localSessionId === payload.sessionId) localCancelled = true; return; }
  if (payload.action === 'undo') return formFiller.undoLastFill();
  const element = observer?.nodes.get(payload.field?.fieldId);
  if (!element?.isConnected) return { status: 'stale', reason: '字段已被页面替换，需要重新开始识别' };
  if (payload.action === 'locate') { element.scrollIntoView({ block: 'center', behavior: 'smooth' }); element.focus(); return; }
  const keepGoing = () => !localCancelled && localSessionId === payload.sessionId;
  if (!keepGoing()) return { status: 'cancelled', reason: '填写已停止' };
  if (payload.action === 'readOptions') {
    if (observer!.observe(payload.field.fieldId)[0]?.snapshotVersion !== payload.field.snapshotVersion) return;
    return readModelOptions(element, payload.query, () => keepGoing() && !localUserEdits.has(element));
  }
  const context = { semantic: payload.decision?.meaningId?.split('.').at(-1), optionRefs: payload.decision?.targetOptionIds, shouldContinue: keepGoing, overwrite: payload.overwrite === true };
  if (payload.action === 'verify' && element instanceof HTMLInputElement && element.type === 'file') return { status: element.files?.length === 1 && element.files[0].name === payload.value ? 'verified' : 'unverified', reason: '核对网页中的附件文件名' };
  if (payload.action === 'verify') return verifyControl(element, payload.value, { ...context, settleMs: 60 });
  if (payload.action === 'execute') {
    if (!payload.overwrite) {
      if (localUserEdits.has(element)) return { status: 'user-edited', reason: '用户已编辑该字段，已停止自动操作' };
      const current = observer!.observe(payload.field.fieldId)[0];
      if (current?.snapshotVersion !== payload.field.snapshotVersion) return { status: 'stale', reason: '页面已变化，需要重新匹配' };
      if (observeControl(element).value) {
        const existing = await verifyControl(element, payload.value, { ...context, settleMs: 0, timeoutMs: 200 });
        return existing.status === 'verified' ? { ...existing, status: 'unchanged' } : { status: 'skipped-existing', reason: '已保留网页现有答案' };
      }

    }
    if (element instanceof HTMLInputElement && element.type === 'file') {
      if (element.files?.length) return { status: 'skipped-existing', reason: '已保留现有附件' };
      if (!payload.attachment || !keepGoing()) return { status: 'cancelled', reason: '附件未选择或填写已停止' };
      await formFiller.uploadResume(element, payload.attachment.fileData, payload.attachment.fileName);
      await new Promise(resolve => setTimeout(resolve, 450));
      return { status: keepGoing() && element.files?.length === 1 && element.files[0].name === payload.value ? 'verified' : 'unverified', reason: '附件已交给网页，请在提交前核对' };
    }
    return formFiller.executeDecision(element, payload.value, context);
  }
}
chrome.runtime.onMessage.addListener((message: Message, _sender, respond) => {
  const run = (operation: Promise<unknown>) => { operation.then(data => respond({ success: true, data })).catch(error => respond({ success: false, error: error instanceof Error ? error.message : '操作失败' })); return true; };
  switch (message.type) {
    case 'PING_CONTENT': respond({ success: true, data: { ready: true } }); return false;
    case 'FILL_LOCAL_BRIDGE': return run(localOperation(message.payload));
    case 'START_FILL_SESSION':
      if (starting || session?.busy) { respond({ success: false, error: '已有填写任务正在运行' }); return false; }
      if (message.payload.region) selectRegion(message.payload.sourceId);
      else void startFill(message.payload.sourceId, message.payload.attachmentId);
      respond({ success: true, data: { started: true } }); return false;
    case 'FILL_FORM':
    case 'START_AI_PAGE_FILL':
      void startFill('default', message.payload?.resumeId); respond({ success: true, data: { started: true } }); return false;
    case 'START_AI_REGION_FILL': selectRegion('default'); respond({ success: true }); return false;
    case 'PREVIEW_FILL': respond({ success: true, data: { items: [], detectedCount: discoverControls(document).length } }); return false;
    case 'DETECT_FIELDS': respond({ success: true, data: { count: discoverControls(document).length } }); return false;
    case 'UNDO_LAST_FILL':
      if (starting || session?.busy) { respond({ success: false, error: '请先停止填写' }); return false; }
      return run(formFiller.undoLastFill().then(count => ({ count })));
    case 'OPEN_INFO_OVERLAY': return run(infoOverlay.open(message.payload?.resumeId));
    case 'SET_INFO_OVERLAY_RESUME': return run(infoOverlay.setResume(message.payload.resumeId));
    case 'APPLY_FOCUSED_FIELD':
      if (starting || session?.busy) { respond({ success: true, data: { written: false, reason: 'FILL_IN_PROGRESS' } }); return false; }
      if (document.activeElement instanceof HTMLIFrameElement || !lastFocusedControl?.isConnected) { respond({ success: true, data: { written: false, reason: 'NO_FOCUSED_FIELD' } }); return false; }
      return run(formFiller.fillFocusedControl(lastFocusedControl, message.payload.value).then(written => ({ written, reason: written ? undefined : 'VALUE_REJECTED' })));
  }
});
