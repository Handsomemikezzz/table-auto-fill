export interface ExtractionProgress {
  stage: 'reading' | 'ocr';
  page?: number;
  totalPages?: number;
  progress?: number;
}
export interface ResumeExtraction {
  text: string;
  method: 'text' | 'ocr' | 'mixed';
  pages: number;
  ocrPages: number;
  warnings: string[];
}
export interface ExtractionOptions {
  signal?: AbortSignal;
  onProgress?: (progress: ExtractionProgress) => void;
}
export const RESUME_IMAGE_TYPES = ['png', 'jpg', 'jpeg', 'webp'];
export const RESUME_FILE_TYPES = ['pdf', 'doc', 'docx', 'md', 'markdown', 'txt', 'json', ...RESUME_IMAGE_TYPES];
export function checkExtractionCancelled(signal?: AbortSignal) {
  if (signal?.aborted) throw new DOMException('已停止简历识别', 'AbortError');
}
export function needsPageOCR(text: string, hasImage = false): boolean {
  const readable = text.replace(/[^\p{L}\p{N}]/gu, '').length;
  return readable < 30 || (hasImage && readable < 160) || (text.match(/\ufffd/g)?.length || 0) > 5;
}
