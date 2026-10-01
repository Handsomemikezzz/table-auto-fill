import type { Worker } from 'tesseract.js';
import { checkExtractionCancelled, type ExtractionOptions } from './resumeExtraction.ts';

/** One local worker per document. All executable code and language data are bundled. */
export async function createResumeOCR(options: ExtractionOptions = {}) {
  checkExtractionCancelled(options.signal);
  const { createWorker, PSM } = await import('tesseract.js');
  const getURL = (path: string) => typeof chrome !== 'undefined' && chrome.runtime?.getURL
    ? chrome.runtime.getURL(path) : new URL(`/${path}`, window.location.origin).href;
  let worker: Worker | undefined;
  let rejectInterrupt!: (reason: Error) => void;
  const interrupted = new Promise<never>((_, reject) => { rejectInterrupt = reject; });
  // Handle cancellation before a worker has finished loading its local resources.
  const stop = () => { void worker?.terminate(); rejectInterrupt(new DOMException('已停止简历识别', 'AbortError')); };
  options.signal?.addEventListener('abort', stop, { once: true });
  const pending = createWorker(['chi_sim', 'eng'], 1, {
    workerPath: getURL('ocr/worker.min.js'), corePath: getURL('ocr/core/'), langPath: getURL('ocr/lang'),
    workerBlobURL: false, cacheMethod: 'none',
    errorHandler: error => rejectInterrupt(new Error(`文字识别无法继续：${String(error)}`)),
    logger: message => {
      if (message.status === 'recognizing text') options.onProgress?.({ stage: 'ocr', progress: message.progress });
    },
  }).then(async created => {
    worker = created;
    if (options.signal?.aborted) { await created.terminate(); throw new DOMException('已停止简历识别', 'AbortError'); }
    await created.setParameters({ tessedit_pageseg_mode: PSM.AUTO, preserve_interword_spaces: '1' });
    return created;
  });
  // The worker creation API has no abort primitive; a late result is terminated.
  pending.catch(() => {});
  try { worker = await Promise.race([pending, interrupted]); }
  catch (error) { options.signal?.removeEventListener('abort', stop); throw error; }
  return {
    async recognize(image: string | HTMLCanvasElement) {
      checkExtractionCancelled(options.signal);
      const result = await Promise.race([worker!.recognize(image), interrupted]);
      checkExtractionCancelled(options.signal);
      return { text: result.data.text.trim(), confidence: result.data.confidence };
    },
    async close() { options.signal?.removeEventListener('abort', stop); await worker?.terminate(); },
  };
}
export async function parseResumeImage(data: string, options: ExtractionOptions = {}) {
  options.onProgress?.({ stage: 'ocr', page: 1, totalPages: 1 });
  const worker = await createResumeOCR(options);
  try {
    const image = await new Promise<HTMLImageElement>((resolve, reject) => { const image = new Image(); image.onload = () => resolve(image); image.onerror = () => reject(new Error('图片无法读取，请换一张清晰的简历图片')); image.src = data; });
    checkExtractionCancelled(options.signal);
    const scale = Math.min(1, 2800 / Math.max(image.naturalWidth, image.naturalHeight));
    const canvas = document.createElement('canvas'); canvas.width = Math.ceil(image.naturalWidth * scale); canvas.height = Math.ceil(image.naturalHeight * scale);
    canvas.getContext('2d')!.drawImage(image, 0, 0, canvas.width, canvas.height);
    let result;
    try { result = await worker.recognize(canvas); } finally { canvas.width = 0; canvas.height = 0; }
    return { text: result.text, method: 'ocr' as const, pages: 1, ocrPages: 1,
      warnings: result.confidence < 75 ? ['图片文字较模糊，请重点核对姓名、电话、邮箱和日期。'] : [] };
  } finally { await worker.close(); }
}
