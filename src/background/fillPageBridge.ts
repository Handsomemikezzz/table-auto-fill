import { getSessionAttachment } from './fillSessions.ts';
import { ensureFrames } from './contentScriptConnection.ts';
import type { FieldObservation } from '../autofill/contracts.ts';
import type { MessageResponse } from '../shared/types.ts';

/** All DOM work remains inside its own frame. Only serializable observations cross the bridge. */
export async function bridgeFillPage(payload: Record<string, any>, sender: chrome.runtime.MessageSender) {
  const tabId = sender.tab?.id;
  if (tabId === undefined || sender.frameId !== 0) throw new Error('页面操作必须由主页面会话发起');
  const relay = async (frameId: number, data: Record<string, any>) => {
    const response = await chrome.tabs.sendMessage(tabId, { type: 'FILL_LOCAL_BRIDGE', payload: data }, { frameId }) as MessageResponse;
    if (!response.success) throw new Error(response.error || '页面框架无法连接');
    return response.data;
  };
  if (payload.action === 'observe' || payload.action === 'cancel' || payload.action === 'undo') {
    const frames = payload.region ? [{ frameId: 0 }] : await chrome.webNavigation.getAllFrames({ tabId }) || [{ frameId: 0 }];
    if (payload.action === 'observe') {
      await ensureFrames(tabId, frames.map(frame => frame.frameId));
    }
    const results = await Promise.allSettled(frames.map(async frame => {
      const data = await relay(frame.frameId, { ...payload, frameId: frame.frameId });
      return payload.action === 'observe' ? (data as FieldObservation[]).map(field => ({ ...field, fieldId: `${frame.frameId}/${field.fieldId}`, groupId: `${frame.frameId}/${field.groupId}`, frameId: String(frame.frameId) })) : data;
    }));
    const values = results.filter(result => result.status === 'fulfilled').map(result => result.value);
    if (!values.length) throw new Error('当前页面无法连接填写器');
    if (payload.action === 'observe') {
      const fields = values.flat() as FieldObservation[];
      // Inaccessible frames stay visible in the completion denominator.
      results.forEach((result, index) => {
        if (result.status === 'fulfilled') return;
        fields.push({ fieldId: `${frames[index].frameId}/unavailable`, groupId: `${frames[index].frameId}/unavailable`, frameId: String(frames[index].frameId), snapshotVersion: 'unavailable', signature: 'unavailable', groupLabel: '嵌入表单', label: '无法读取的页面框架', context: '', kind: 'unsupported', required: false, currentValue: '', disabled: true, options: [], optionsState: 'unread' });
      });
      return fields;
    }
    return payload.action === 'undo' ? values.reduce((sum, value) => sum + Number(value), 0) : undefined;
  }
  const [frame, ...localId] = String(payload.field?.fieldId || '').split('/');
  if (!/^\d+$/.test(frame) || !localId.length) throw new Error('目标框架无效');
  const attachment = payload.action === 'execute' && payload.field.kind === 'file' ? await getSessionAttachment(payload.sessionId, payload.decision.factId, sender) : undefined;
  return relay(Number(frame), { ...payload, attachment, field: { ...payload.field, fieldId: localId.join('/') } });
}
