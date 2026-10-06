import React, { useEffect, useState } from 'react';
import { MessageService } from '../shared/message.ts';
import { getResumeLibrary } from '../shared/resumes.ts';
import type { Message, UserProfile } from '../shared/types.ts';

export default function App() {
  const [profile, setProfile] = useState<UserProfile | null>(null);
  const [loading, setLoading] = useState(typeof window !== 'undefined');
  const [sourceId, setSourceId] = useState('default');
  const [attachmentId, setAttachmentId] = useState('none');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const library = profile ? getResumeLibrary(profile) : [];
  useEffect(() => {
    void MessageService.sendMessage<UserProfile>({ type: 'GET_USER_PROFILE' }).then(response => {
      if (response.success && response.data) setProfile(response.data);
      else if (response.error) setError(response.error);
    }).finally(() => setLoading(false));
  }, []);
  const send = async (message: Message) => {
    setBusy(true); setError('');
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab.id) throw new Error('没有可用的当前页面');
      const ready = await MessageService.sendMessage({ type: 'ENSURE_CONTENT_SCRIPT', payload: { tabId: tab.id } });
      if (!ready.success) throw new Error(ready.error || '请刷新页面后重试');
      const result = await MessageService.sendMessageToTab(tab.id, message, { frameId: 0 });
      if (!result.success) throw new Error(result.error || '无法启动填写');
      window.close();
    } catch (error) { setError(error instanceof Error ? error.message : '操作失败'); }
    finally { setBusy(false); }
  };
  const fill = (region = false) => send({ type: 'START_FILL_SESSION', payload: { sourceId, attachmentId: attachmentId === 'none' ? null : attachmentId, region } });
  return <div className="popup-shell">
    <header className="popup-header"><div><h1>Job ApplyMate</h1><p>你的求职申请搭档</p></div></header>
    <div className="popup-content">
      {loading && <p>加载资料中…</p>}
      {!loading && !profile && <p>请先打开设置，导入简历或填写个人资料。</p>}
      <div className="profile-card"><div className="profile-card-heading">当前资料：{sourceId === 'default' ? '通用资料' : library.find(item => item.id === sourceId)?.category}</div><p>{profile?.personal.name || '尚未设置姓名'}</p></div>
      <div className="popup-actions">
        <label className="resume-picker"><span>附件（可选）</span>
          <select value={attachmentId} onChange={event => setAttachmentId(event.target.value)} aria-label="选择附件">
            <option value="none">不附加文件</option>
            {library.map(item => <option key={item.id} value={item.id}>{item.fileName}</option>)}
          </select><small>附件选择与当前资料分别管理</small>
        </label>
        <button className="button button-primary" disabled={!profile || busy} onClick={() => void fill()}>{busy ? '正在打开任务…' : '填写当前页面'}</button>
        <button className="button button-secondary" disabled={busy} onClick={() => void send({ type: 'OPEN_INFO_OVERLAY', payload: { resumeId: sourceId === 'default' ? null : sourceId } })}>打开资料</button>
        <details><summary>更多</summary>
          <label className="resume-picker"><span>选择岗位资料</span><select aria-label="选择本次资料" value={sourceId} onChange={event => setSourceId(event.target.value)}><option value="default">通用资料</option>{library.filter(item => item.parsedProfile).map(item => <option key={item.id} value={item.id}>{item.category}｜{item.fileName}</option>)}</select></label>
          <button className="button button-secondary" disabled={!profile || busy} onClick={() => void fill(true)}>只填某一区域</button>
        </details>
        <button className="button button-quiet" onClick={() => chrome.runtime.openOptionsPage()}>资料设置</button>
      </div>
      {error && <p role="alert">{error}</p>}
    </div>
  </div>;
}
