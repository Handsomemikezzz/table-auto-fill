import { extractResumePDF } from './pdfParser.ts';
import { parseResume } from './index.ts';
import { parseResumeImage } from './ocrParser.ts';
import { RESUME_IMAGE_TYPES, checkExtractionCancelled, type ExtractionOptions, type ResumeExtraction } from './resumeExtraction.ts';
export async function extractResumeFile(data: string, type: string, options: ExtractionOptions = {}): Promise<ResumeExtraction> {
  checkExtractionCancelled(options.signal);
  if (type === 'pdf') return extractResumePDF(data, options);
  if (RESUME_IMAGE_TYPES.includes(type)) return parseResumeImage(data, options);
  options.onProgress?.({ stage: 'reading' });
  const text = await parseResume(data, type);
  checkExtractionCancelled(options.signal);
  return { text, method: 'text', pages: 1, ocrPages: 0, warnings: [] };
}
