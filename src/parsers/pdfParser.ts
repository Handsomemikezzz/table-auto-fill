import { createResumeOCR } from './ocrParser.ts';
import { checkExtractionCancelled, needsPageOCR, type ExtractionOptions, type ResumeExtraction } from './resumeExtraction.ts';
export async function parsePDF(base64Data: string): Promise<string> {
  return (await extractResumePDF(base64Data)).text;
}

export async function extractResumePDF(base64Data: string, options: ExtractionOptions = {}): Promise<ResumeExtraction> {
  let pdf: any;
  let loadingTask: any;
  let ocr: Awaited<ReturnType<typeof createResumeOCR>> | undefined;
  let currentPage = 1;
  const cancelLoading = () => { void loadingTask?.destroy(); };
  options.signal?.addEventListener('abort', cancelLoading, { once: true });
  try {
    console.log('[PDF Parser] Starting PDF parsing...');

    const hasDOM = typeof window !== 'undefined' && typeof document !== 'undefined';
    const runtimeGetUrl = typeof chrome !== 'undefined' && chrome.runtime?.getURL
      ? chrome.runtime.getURL.bind(chrome.runtime)
      : null;
    const pdfjsLib = await import('pdfjs-dist/legacy/build/pdf.mjs');
    console.log('[PDF Parser] PDF.js loaded, version:', pdfjsLib.version);

    // 在扩展环境且存在 DOM 时使用打包的 worker 文件
    if (hasDOM && typeof chrome !== 'undefined' && chrome.runtime?.getURL) {
      pdfjsLib.GlobalWorkerOptions.workerSrc = chrome.runtime.getURL('pdf.worker.min.js');
      console.log('[PDF Parser] Worker path set to:', pdfjsLib.GlobalWorkerOptions.workerSrc);
    } else if (hasDOM) {
      // 开发环境备用方案
      pdfjsLib.GlobalWorkerOptions.workerSrc = '/pdf.worker.min.js';
    } else {
      console.log('[PDF Parser] No DOM detected, parsing PDF without worker');
    }

    const toNodeResourcePath = (relativePath: string) => {
      const url = new URL(relativePath, import.meta.url);
      return decodeURIComponent(url.pathname);
    };

    const cMapUrl = runtimeGetUrl
      ? runtimeGetUrl('cmaps/')
      : (!hasDOM ? toNodeResourcePath('../../node_modules/pdfjs-dist/cmaps/') : undefined);
    const standardFontDataUrl = runtimeGetUrl
      ? runtimeGetUrl('standard_fonts/')
      : (!hasDOM ? toNodeResourcePath('../../node_modules/pdfjs-dist/standard_fonts/') : undefined);

    // 移除 base64 前缀
    const base64String = base64Data.includes(',')
      ? base64Data.split(',')[1]
      : base64Data;
    console.log('[PDF Parser] Base64 data length:', base64String.length);

    // 转换为 Uint8Array
    const binaryString = atob(base64String);
    const bytes = new Uint8Array(binaryString.length);
    for (let i = 0; i < binaryString.length; i++) {
      bytes[i] = binaryString.charCodeAt(i);
    }
    console.log('[PDF Parser] Converted to bytes, length:', bytes.length);

    // 加载 PDF
    console.log('[PDF Parser] Loading PDF document...');
    const documentInit = {
      data: bytes,
      ...(cMapUrl ? { cMapUrl, cMapPacked: true } : {}),
      ...(standardFontDataUrl ? { standardFontDataUrl } : {}),
      ...(hasDOM ? {} : { disableWorker: true }),
    } as any;
    loadingTask = pdfjsLib.getDocument(documentInit);
    checkExtractionCancelled(options.signal);
    pdf = await loadingTask.promise;

    console.log('[PDF Parser] PDF loaded, pages:', pdf.numPages);

    if (pdf.numPages > 20) throw new Error('简历超过 20 页，请拆分后再识别');
    const texts: string[] = [], warnings: string[] = [];
    let ocrPages = 0;
    for (let pageNum = 1; pageNum <= pdf.numPages; pageNum++) {
      currentPage = pageNum;
      checkExtractionCancelled(options.signal);
      options.onProgress?.({ stage: 'reading', page: pageNum, totalPages: pdf.numPages });
      const page = await pdf.getPage(pageNum);
      const textContent = await page.getTextContent();
      let text = itemsToText(textContent.items);
      let hasImage = false;
      if (text.replace(/\s/g, '').length < 160) {
        const operators = await page.getOperatorList();
        hasImage = operators.fnArray.some((code: number) => [pdfjsLib.OPS.paintImageXObject, pdfjsLib.OPS.paintInlineImageXObject].includes(code));
      }
      if (needsPageOCR(text, hasImage)) {
        if (typeof document === 'undefined') throw new Error('扫描简历需要在插件页面或 offscreen 中识别');
        checkExtractionCancelled(options.signal);
        options.onProgress?.({ stage: 'ocr', page: pageNum, totalPages: pdf.numPages });
        ocr ??= await createResumeOCR({ ...options, onProgress: progress => options.onProgress?.({ ...progress, page: currentPage, totalPages: pdf.numPages }) });
        const viewport = page.getViewport({ scale: 2 });
        const scale = Math.min(2, 2800 / Math.max(viewport.width / 2, viewport.height / 2));
        const renderViewport = page.getViewport({ scale });
        const canvas = document.createElement('canvas');
        canvas.width = Math.ceil(renderViewport.width); canvas.height = Math.ceil(renderViewport.height);
        try {
          // OCR also runs in hidden/offscreen pages, where display rendering can
          // wait forever for requestAnimationFrame. Print intent does not use RAF.
          await page.render({ canvas, canvasContext: canvas.getContext('2d')!, viewport: renderViewport, intent: 'print' }).promise;
          const recognized = await ocr.recognize(canvas);
          if (recognized.text) text = recognized.text;
          if (recognized.confidence < 75) warnings.push(`第 ${pageNum} 页文字较模糊，请核对识别内容。`);
          ocrPages++;
        } finally { canvas.width = 0; canvas.height = 0; }
      }
      texts.push(text);
      page.cleanup();
    }
    return { text: texts.join('\n\n').trim(), pages: pdf.numPages, ocrPages,
      method: ocrPages === 0 ? 'text' : ocrPages === pdf.numPages ? 'ocr' : 'mixed', warnings };
  } catch (error) {
    if (options.signal?.aborted || (error instanceof Error && error.name === 'AbortError')) throw new DOMException('已停止简历识别', 'AbortError');
    console.error('[PDF Parser] PDF parsing error:', error);
    // 返回详细的错误信息
    const errorMessage = error instanceof Error
      ? `${error.name}: ${error.message}\n${error.stack || ''}`
      : String(error);
    throw new Error(`Failed to parse PDF file: ${errorMessage}`);
  } finally { options.signal?.removeEventListener('abort', cancelLoading); await ocr?.close(); await loadingTask?.destroy(); }
}

interface PDFTextItem {
  str?: string;
  hasEOL?: boolean;
  width?: number;
  height?: number;
  transform?: number[];
}

interface PositionedItem {
  str: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * 把一页的文本块还原成带换行、且符合视觉顺序的文本。
 *
 * 两个必须处理的问题：
 *
 * 1. PDF 没有「行」的概念，只有一堆带坐标的文本块。直接用空格拼接会让
 *    整页变成一行，后续按行工作的字段提取全部失效。
 * 2. 内容流顺序不等于视觉顺序。Canva 等设计工具常把章节标题放在独立
 *    图层最后绘制，于是「教育经历」「实习经历」这类标题会排到全文末尾，
 *    与各自的内容彻底脱节，规则无法判断段落归属。
 *
 * 因此这里不沿用内容流顺序，而是按坐标重排：先用 Y 坐标聚成行
 * （自上而下），行内再按 X 排序（自左而右）。
 */
function itemsToText(items: unknown[]): string {
  const positioned: PositionedItem[] = [];

  for (const raw of items) {
    const item = raw as PDFTextItem;
    // getTextContent 的结果里混有标记内容项，没有 str 字段
    if (typeof item.str !== 'string' || !item.str.trim()) continue;

    const transform = Array.isArray(item.transform) ? item.transform : null;
    if (!transform || !Number.isFinite(transform[4]) || !Number.isFinite(transform[5])) {
      continue;
    }

    positioned.push({
      str: item.str,
      x: transform[4] as number,
      y: transform[5] as number,
      width: Number.isFinite(item.width) ? (item.width as number) : 0,
      height: Number.isFinite(item.height) && (item.height as number) > 0
        ? (item.height as number)
        : 12,
    });
  }

  if (positioned.length === 0) return '';

  return groupIntoLines(positioned)
    .map(joinLine)
    .join('\n')
    .replace(/[ \t]+$/gm, '');
}

/** 按 Y 坐标把文本块聚成行，行内按 X 升序 */
function groupIntoLines(items: PositionedItem[]): PositionedItem[][] {
  // Y 降序（PDF 坐标系原点在左下，Y 大者在上）
  const sorted = [...items].sort((a, b) => b.y - a.y);

  const lines: PositionedItem[][] = [];
  let currentLine: PositionedItem[] = [];
  let lineY = sorted[0].y;
  let lineHeight = sorted[0].height;

  for (const item of sorted) {
    // 同一视觉行的基线可能有零点几的抖动（如日期块比正文高 0.8），
    // 用半个字高作容差；超出则判为新行。
    const tolerance = Math.max(lineHeight, item.height) * 0.5;

    if (currentLine.length > 0 && Math.abs(item.y - lineY) > tolerance) {
      lines.push(currentLine);
      currentLine = [];
    }

    if (currentLine.length === 0) {
      lineY = item.y;
      lineHeight = item.height;
    } else {
      // 以行内最大字高为准，避免小字块把容差压得过小
      lineHeight = Math.max(lineHeight, item.height);
    }

    currentLine.push(item);
  }

  if (currentLine.length > 0) lines.push(currentLine);

  return lines.map(line => line.sort((a, b) => a.x - b.x));
}

/**
 * 拼接一行内的文本块。中文 PDF 常把相邻字拆成多个块，
 * 无条件加空格会在词内插入空格，因此只在水平间距明显时补空格。
 */
function joinLine(line: PositionedItem[]): string {
  let text = '';
  let prevEndX: number | null = null;
  let prevHeight = 0;

  for (const item of line) {
    const gapThreshold = Math.max(item.height, prevHeight) * 0.25;

    if (
      text &&
      prevEndX !== null &&
      item.x - prevEndX > gapThreshold &&
      !/\s$/.test(text)
    ) {
      text += ' ';
    }

    text += item.str;
    prevEndX = item.x + item.width;
    prevHeight = item.height;
  }

  return text.trim();
}
