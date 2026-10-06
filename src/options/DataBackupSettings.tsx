import React, { useRef, useState } from 'react';
import { MessageService } from '../shared/message';
import type { BackupSummary } from '../shared/types';

interface Props {
  onDataChanged: () => void;
}

function Summary({ summary }: { summary: BackupSummary }) {
  return (
    <dl className="backup-summary">
      <div><dt>格式版本</dt><dd>V{summary.schemaVersion}</dd></div>
      <div><dt>导出时间</dt><dd>{new Date(summary.exportedAt).toLocaleString()}</dd></div>
      <div><dt>来源版本</dt><dd>{summary.extensionVersion}</dd></div>
      <div><dt>个人信息</dt><dd>{summary.hasUserProfile ? '包含' : '不包含'}</dd></div>
      <div><dt>简历原文件</dt><dd>{summary.hasResumeFile ? '包含' : '不包含'}</dd></div>
      <div><dt>AI 配置 / API Key</dt><dd>{summary.hasLLMConfig ? (summary.hasApiKey ? '包含（含 Key）' : '包含') : '不包含'}</dd></div>
    </dl>
  );
}

export function DataBackupSettings({ onDataChanged }: Props) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [importJson, setImportJson] = useState('');
  const [importSummary, setImportSummary] = useState<BackupSummary | null>(null);
  const [confirmingImport, setConfirmingImport] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  const run = async (key: string, action: () => Promise<void>) => {
    setBusy(key);
    setNotice(null);
    try {
      await action();
    } finally {
      setBusy(null);
    }
  };

  const exportBackup = () => run('export', async () => {
    const response = await MessageService.sendMessage<{ json: string; filename: string }>({
      type: 'EXPORT_BACKUP',
    });
    if (!response.success || !response.data) {
      setNotice({ type: 'error', text: response.error || '导出失败' });
      return;
    }
    const url = URL.createObjectURL(new Blob([response.data.json], { type: 'application/json' }));
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = response.data.filename;
    anchor.click();
    URL.revokeObjectURL(url);
    setNotice({ type: 'success', text: '完整备份已导出' });
  });

  const selectBackup = async (file?: File) => {
    setImportSummary(null);
    setImportJson('');
    setNotice(null);
    if (!file) return;
    if (file.size > 20 * 1024 * 1024) {
      setNotice({ type: 'error', text: '备份文件超过 20 MiB 上限' });
      return;
    }
    const json = await file.text();
    const response = await MessageService.sendMessage<BackupSummary>({
      type: 'PREVIEW_BACKUP_IMPORT',
      payload: { json },
    });
    if (!response.success || !response.data) {
      setNotice({ type: 'error', text: response.error || '备份预检失败' });
      return;
    }
    setImportJson(json);
    setImportSummary(response.data);
  };

  const importBackup = () => run('import', async () => {
    const response = await MessageService.sendMessage({
      type: 'IMPORT_BACKUP',
      payload: { json: importJson },
    });
    if (!response.success) {
      setNotice({ type: 'error', text: response.error || '导入失败，本地数据未更改' });
      return;
    }
    setConfirmingImport(false);
    setImportJson('');
    setImportSummary(null);
    if (fileInputRef.current) fileInputRef.current.value = '';
    onDataChanged();
    setNotice({ type: 'success', text: '备份已完整导入，本地资料已刷新' });
  });

  return (
    <div className="data-backup-settings">
      <section className="data-section">
        <div className="data-section-heading">
          <div>
            <h2 className="settings-section-title">本地 JSON 备份</h2>
            <p className="settings-description">导入或导出个人资料、简历原文件、AI 配置和通用设置。</p>
          </div>
          <div className="data-heading-actions">
            <button
              className="btn btn-primary"
              onClick={() => fileInputRef.current?.click()}
              disabled={busy !== null}
            >
              导入完整数据
            </button>
            <button className="btn btn-secondary" onClick={exportBackup} disabled={busy !== null}>
              {busy === 'export' ? '导出中…' : '导出完整数据'}
            </button>
            <input
              ref={fileInputRef}
              className="visually-hidden"
              type="file"
              accept=".json,application/json"
              onChange={event => void selectBackup(event.target.files?.[0])}
            />
          </div>
        </div>

        <div className="sensitive-warning" role="note">
          备份为明文 JSON，包含完整个人信息、简历原文件、AI API Key。请妥善保管，不要发送给他人。
        </div>

        {importSummary && (
          <div className="backup-preview">
            <h3>备份文件检查通过</h3>
            <p className="settings-hint">以下内容尚未导入，确认后才会覆盖当前数据。</p>
            <Summary summary={importSummary} />
            <button className="btn btn-secondary" onClick={() => setConfirmingImport(true)}>
              覆盖并导入
            </button>
          </div>
        )}
      </section>

      {notice && <div className={`data-notice data-notice-${notice.type}`} role="status">{notice.text}</div>}

      {confirmingImport && (
        <div className="confirm-layer" role="dialog" aria-modal="true" aria-labelledby="import-confirm-title">
          <div className="confirm-dialog">
            <h3 id="import-confirm-title">确认覆盖本地数据？</h3>
            <p>导入会整体覆盖当前个人资料、简历、AI 配置和通用设置。此操作不能撤销。</p>
            <div className="backup-actions">
              <button className="btn btn-secondary" onClick={() => setConfirmingImport(false)}>取消</button>
              <button className="btn btn-primary" onClick={importBackup} disabled={busy !== null}>
                {busy === 'import' ? '导入中…' : '确认覆盖并导入'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
