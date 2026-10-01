import type { ParsedResumeData, PublicationInfo } from '../shared/types.ts';

const layoutDate = /[ \t]+(?:19|20)\d{2}[./-](?:0?[1-9]|1[0-2])(?:[./-](?:0?[1-9]|[12]\d|3[01]))?[ \t]*(?=\n)/g;
export const publicationTitleKey = (title: string) => title.normalize('NFKC').replace(layoutDate, '').replace(/[《》\s]+/g, '').toLowerCase();

/** Inspect literal title/citation evidence across headings; never assert publication or acceptance. */
export function recoverResumePublications(parsed: ParsedResumeData, text: string): ParsedResumeData {
  const publications = [...(parsed.publications || [])];
  const candidates = [...(parsed.publicationCandidates || [])];
  let recovered = 0;
  for (const match of text.matchAll(/《([^》]{1,2000})》/g)) {
    const start = match.index!;
    const lineStart = text.lastIndexOf('\n', start) + 1;
    const before = text.slice(lineStart, start);
    const afterTitle = start + match[0].length;
    // A citation can be on the next line, but cannot spill into another list item/title/section.
    const following = text.slice(afterTitle, afterTitle + 2500);
    const boundary = following.search(/\n\s*(?:[•●▪*]|[-–]\s|\d+[.)]\s|#{1,6}\s)|\n[^\n《]{0,100}《|\n\s*(?:教育|工作|实习|项目|技能|语言|获奖|证书|论文|专利)(?:背景|经历|研究|能力|情况|与著作|与荣誉)?\s*(?:[A-Za-z ]+)?\s*\n/);
    const tail = boundary < 0 ? following : following.slice(0, boundary);
    const raw = `${before}${match[0]}${tail}`.trim();
    const title = match[1].replace(layoutDate, '').replace(/\s+/g, ' ').trim();
    if (!title) continue;
    const context = `${before} ${tail}`;
    const doi = context.match(/\b10\.\d{4,9}\/[^\s<>"《》]+/i)?.[0]?.replace(/[.,;，。；)）]+$/, '') || '';
    const url = context.match(/https?:\/\/[^\s<>"《》]+/i)?.[0]?.replace(/[.,;，。；)）]+$/, '') || '';
    if ([...publications, ...candidates].some(row => publicationTitleKey(row.title || '') === publicationTitleKey(title) || (doi && row.doi === doi))) continue;
    const headings = text.slice(0, lineStart).split('\n').filter(line => /^(?:#+\s*)?(?:论文(?:与著作)?|发表论文|出版物|学术成果|研究成果|项目研究|项目经历|教育背景|实习经历|工作经历)\s*(?:[A-Za-z ]+)?\s*$/.test(line.trim()));
    const heading = headings.at(-1) || '';
    const explicitPaper = /\bpaper\b|论文|著作|期刊|发表|录用/i.test(context) || (/^(?:#+\s*)?(?:论文|发表论文|出版物)/.test(heading) && !/项目|作品|工具/.test(before));
    const exhibition = /展览|设计展|exhibition|showcase/i.test(context);
    if (exhibition && !explicitPaper && !doi) continue;
    const conference = /\b(?:ACM|IEEE|CCF|Cumulus|conference)\b|会议|\b(?:19|20)\d{2}\s*[A-Z][A-Z\d-]{2,}\b/i.test(before);
    if (!explicitPaper && !doi && !conference) continue;
    const role = context.match(/(?:第[一二三四五六七八九十\d]+作者|共同[一二]作|[一二三四五六七八九十]作|通讯作者)/)?.[0] || '';
    const venue = before.replace(/^\s*[•●▪*\-–]\s*/, '').trim();
    // Dates next to a project/conference may describe the activity rather than publication.
    const dateMatch = context.match(/(?:发表于|发表时间|录用时间|出版时间)\s*[:：]?\s*((?:19|20)\d{2})(?:[./-](\d{1,2}))?(?:[./-](\d{1,2}))?/);
    const date = dateMatch ? [dateMatch[1], ...dateMatch.slice(2).filter(Boolean).map(part => part.padStart(2, '0'))].join('-') : '';
    const status = context.match(/已录用|已接收|已发表|已出版|待发表|在投|审稿中/)?.[0] || '';
    const row: Partial<PublicationInfo> = { id: `publication-${crypto.randomUUID()}`, title, authors: role, venue, date, status, doi, url, description: `原文：\n${raw}` };
    if (explicitPaper || doi) { publications.push(row); recovered++; }
    else candidates.push(row);
  }
  return {
    ...parsed,
    ...(publications.length ? { publications } : {}),
    ...(candidates.length ? { publicationCandidates: candidates } : {}),
    ...(recovered ? { parsingWarnings: [...(parsed.parsingWarnings || []), `从研究内容中补充识别了 ${recovered} 条论文线索，请核对标题、署名及发表状态。`] } : {}),
  };
}
