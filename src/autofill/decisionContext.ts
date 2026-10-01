import type { DecisionRequest } from './contracts.ts';

/** Full definitions, complete related record collections; no retrieval or top-K. */
export function prepareDecisionContext(request: DecisionRequest): DecisionRequest {
  const unresolved = request.fields.filter(field => !field.resolvedBinding);
  const modules = new Set<string>();
  for (const field of unresolved) {
    const title = field.groupLabel;
    const matches = [
      /教育经历|教育背景|本科|硕士|研究生/.test(title) ? 'education' : '',
      /工作经历|实习经历|工作经验/.test(title) ? 'experience' : '',
      /项目经历|项目经验/.test(title) ? 'projects' : '',
    ].filter(Boolean);
    // A generic or contradictory module cannot safely exclude any collection.
    if (matches.length !== 1) return request;
    const hints = field.candidates.filter(id => /^(education|experience|projects)\./.test(id)).map(id => id.split('.')[0]);
    if (hints.some(collection => collection !== matches[0])) return request;
    modules.add(matches[0]);
  }
  const required = new Set([
    ...request.fields.flatMap(field => field.resolvedBinding ? [field.resolvedBinding.factId] : []),
    ...(request.establishedBindings || []).map(binding => binding.factId),
  ]);
  const facts = request.profile.facts.filter(fact => required.has(fact.id)
    || (unresolved.length > 0 && (fact.meaningId.startsWith('personal.') || fact.meaningId.startsWith('saved.')
      || fact.id.startsWith('personal-extra:') || modules.has(fact.meaningId.split('.')[0])
      || (!/^(personal|education|experience|projects|certifications|skills|attachment)\./.test(fact.meaningId))))
    || (fact.meaningId === 'attachment.resumeFile' && request.fields.some(field => field.kind === 'file')));
  // Version describes the original snapshot; the view does not create new facts.
  return { ...request, profile: { ...request.profile, facts } };
}
