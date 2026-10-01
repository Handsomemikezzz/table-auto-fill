import React from 'react';
import type { ExtractionProgress } from '../parsers/resumeExtraction.ts';
export type ImportStage = 'reading' | 'ocr' | 'structuring' | 'review' | 'error' | 'cancelled';
export interface ImportProgress { stage: ImportStage; fileName: string; detail?: string; extraction?: ExtractionProgress }
export function ResumeImportProgress({ progress, onCancel, onRetry, onReview }: {
  progress: ImportProgress; onCancel: () => void; onRetry: () => void; onReview?: () => void;
}) {
  const index = progress.stage === 'reading' ? 0 : progress.stage === 'ocr' ? 1 : progress.stage === 'structuring' ? 2 : 3;
  const working = ['reading', 'ocr', 'structuring'].includes(progress.stage);
  const labels = ['读取文件', '识别文字', '整理资料', '确认使用'];
  return <section className="resume-import-progress" aria-label="简历识别进度">
    <ol className="resume-import-steps">{labels.map((label, step) => <li key={label} className={step === index ? 'current' : step < index ? 'done' : ''} aria-current={step === index ? 'step' : undefined}><span aria-hidden="true">{step + 1}</span>{label}</li>)}</ol>
    <div role="status" aria-live="polite"><strong>{progress.fileName}</strong><p>{progress.detail || (progress.stage === 'structuring' ? '正在整理为可直接使用的资料，完成后只需核对。' : '正在读取简历，请稍候。')}</p>
      {progress.extraction?.page && <small>第 {progress.extraction.page} / {progress.extraction.totalPages || 1} 页</small>}
      {working && <progress aria-label="当前识别进度" max={1} value={progress.stage === 'ocr' ? progress.extraction?.progress : undefined} />}
    </div>
    <div className="resume-import-actions">{working ? <button type="button" onClick={onCancel}>停止识别</button> : progress.stage === 'review' ? <button type="button" onClick={onReview}>继续核对资料</button> : <button type="button" onClick={onRetry}>重新识别</button>}</div>
  </section>;
}
