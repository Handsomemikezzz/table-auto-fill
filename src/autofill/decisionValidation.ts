import { RULE_PROVIDER_ID } from './ruleDecisions.ts';
import { parseFlexibleDate, areEquivalentDates } from '../utils/dateValue.ts';
import type { DecisionRequest, FieldDecision, FieldObservation, ProfileFact } from './contracts.ts';

export function validateDecision(decision: FieldDecision, field: FieldObservation, request: DecisionRequest): { fact?: ProfileFact; error?: string } {
  if (decision.fieldId !== field.fieldId || decision.snapshotVersion !== field.snapshotVersion
    || decision.profileVersion !== request.profile.version || decision.registryVersion !== request.registryVersion) return { error: '页面或资料版本已变化，需要重新决策' };
  if (!Array.isArray(decision.dependencyIds) || decision.dependencyIds.some(id => id === field.fieldId || !request.fields.some(field => field.fieldId === id))) return { error: '依赖字段无效' };
  if (!['write', 'select', 'readOptions', 'requestFact', 'requestMeaning', 'manual'].includes(decision.nextAction)) return { error: '模型返回了不支持的操作' };
  if (!['write', 'select', 'readOptions'].includes(decision.nextAction)) return {};
  if (field.disabled || field.kind === 'unsupported') return { error: '该控件当前不可自动操作，请在网页中处理' };
  if (decision.nextAction === 'readOptions' && field.kind !== 'combobox') return { error: '该控件不支持展开读取选项' };
  const fact = request.profile.facts.find(fact => fact.id === decision.factId);
  if (decision.nextAction === 'readOptions' && !decision.factId) return {};
  if (!fact || fact.meaningId !== decision.meaningId || fact.subject !== decision.subject || fact.recordId !== decision.recordId) return { error: '资料、含义、主体或经历不一致' };
  const resolved = field.resolvedBinding;
  if (resolved && (resolved.factId !== fact.id || resolved.meaningId !== fact.meaningId || resolved.subject !== fact.subject || resolved.recordId !== fact.recordId)) return { error: '选项判断不能改变已确认的资料绑定' };
  if (request.establishedBindings?.some(binding => binding.groupId === field.groupId && binding.recordId
    && binding.meaningId.split('.')[0] === fact.meaningId.split('.')[0] && binding.recordId !== fact.recordId)) return { error: '同组经历已绑定其他记录' };
  if (fact.conflict) return { error: fact.conflict };
  const confirmed = request.corrections.filter(item => item.enabled && item.signature === field.signature && item.profileVersion === request.profile.version && item.registryVersion === request.registryVersion).at(-1);
  if (confirmed && (confirmed.meaningId !== fact.meaningId || (confirmed.recordId && confirmed.recordId !== fact.recordId))) return { error: '决策与用户确认的含义或经历不一致' };
  if (field.kind === 'file' && fact.meaningId !== 'attachment.resumeFile') return { error: '文件控件只能使用本次明确选择的附件' };
  if (fact.meaningId === 'attachment.resumeFile' && field.kind !== 'file') return { error: '附件只能用于文件控件' };
  if (decision.nextAction === 'select') {
    if (!decision.targetOptionIds?.length || new Set(decision.targetOptionIds).size !== decision.targetOptionIds.length
      || decision.targetOptionIds.some(id => !field.options.some(option => option.id === id && !option.disabled))) return { error: '目标选项已变化或不可选择' };
    if (fact.precision && decision.targetOptionIds.some(id => { const label = field.options.find(option => option.id === id)!.label; return parseFlexibleDate(label) && !areEquivalentDates(fact.value, label); })) return { error: '网站日期选项改变了事实或日期精度' };
    if (!['select', 'radio', 'checkbox', 'combobox'].includes(field.kind)) return { error: '当前控件不支持选择选项' };
  }
  if (decision.nextAction === 'write' && decision.modelId !== RULE_PROVIDER_ID && ['select', 'radio', 'checkbox', 'combobox'].includes(field.kind)) return { error: '选择控件必须由模型指定真实选项' };
  return { fact };
}

export function validateModule(decisions: FieldDecision[], request: DecisionRequest): Map<string, string> {
  const errors = new Map<string, string>();
  for (const field of request.fields) {
    const matches = decisions.filter(decision => decision.fieldId === field.fieldId);
    if (matches.length !== 1) { errors.set(field.fieldId, '模型未返回唯一决策'); continue; }
    const result = validateDecision(matches[0], field, request);
    if (result.error) errors.set(field.fieldId, result.error);
  }
  // Reject every member of conflicting record bindings, not merely the last one.
  const groups = new Map<string, FieldDecision[]>();
  for (const decision of decisions) {
    const field = request.fields.find(field => field.fieldId === decision.fieldId);
    const fact = request.profile.facts.find(fact => fact.id === decision.factId);
    if (!field || !fact?.recordId || !/^(education|experience|projects|certifications)\./.test(fact.meaningId)) continue;
    const key = `${field.groupId}:${fact.meaningId.split('.')[0]}`;
    groups.set(key, [...(groups.get(key) || []), decision]);
  }
  for (const group of groups.values()) {
    if (new Set(group.map(decision => decision.recordId)).size > 1) for (const decision of group) errors.set(decision.fieldId, '同一经历组绑定了不同记录，请选择对应经历');
  }
  const visiting = new Set<string>(), visited = new Set<string>();
  function visit(id: string): boolean {
    if (visiting.has(id)) return false;
    if (visited.has(id)) return true;
    visiting.add(id);
    const valid = (decisions.find(decision => decision.fieldId === id)?.dependencyIds || []).every(visit);
    visiting.delete(id); visited.add(id);
    if (!valid) errors.set(id, '字段依赖存在循环');
    return valid;
  }
  decisions.forEach(decision => visit(decision.fieldId));
  return errors;
}
