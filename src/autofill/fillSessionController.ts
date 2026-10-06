import { buildRuleDecisions } from './ruleDecisions.ts';
import type { FillContextData, FieldObservation, FieldDecision, SessionItem, SessionPhase, MeaningCorrection, FillSessionResult } from './contracts.ts';
import { versionOf } from './contracts.ts';
import type { FillOutcome } from '../shared/fillModel.ts';
import { validateModule } from './decisionValidation.ts';

export interface FillSessionPorts {
  observe(): FieldObservation[] | Promise<FieldObservation[]>;
  execute(field: FieldObservation, decision: FieldDecision, value: string, shouldContinue: () => boolean, overwrite?: boolean): Promise<FillOutcome>;
  verify(field: FieldObservation, decision: FieldDecision, value: string, shouldContinue: () => boolean): Promise<FillOutcome>;
  cancel(): void;
  update(): void;
}
export class FillSessionController {
  readonly context: FillContextData;
  readonly ports: FillSessionPorts;
  items: SessionItem[] = [];
  phase: SessionPhase = 'understanding';
  stopped = false;
  busy = false;
  error = '';
  corrections: MeaningCorrection[] = [];
  constructor(context: FillContextData, ports: FillSessionPorts) { this.context = context; this.ports = ports; this.corrections = context.corrections || []; }
  stop() { this.stopped = true; this.phase = 'stopped'; this.ports.cancel(); this.ports.update(); }
  get counts() {
    return { verified: this.items.filter(item => item.status === 'verified').length, assisted: this.items.filter(item => item.status === 'assisted').length, skipped: this.items.filter(item => item.status === 'skipped').length, existing: this.items.filter(item => item.status === 'existing').length, missing: this.items.filter(item => item.status === 'missing').length, todo: this.items.filter(item => item.status === 'todo' || item.status === 'pending').length };
  }
  get result(): FillSessionResult {
    return { schemaVersion: 1, sessionId: this.context.sessionId, phase: this.phase, busy: this.busy,
      settled: !this.busy && (this.phase === 'complete' || this.phase === 'stopped'),
      counts: this.counts, fields: this.items.map(item => ({ fieldId: item.observation.fieldId, status: item.status,
        outcome: item.outcome?.status, meaningId: item.decision?.meaningId, recordId: item.decision?.recordId })) };
  }
  private canContinue = () => !this.stopped;
  private fact(decision?: FieldDecision) { return this.context.profile.facts.find(fact => fact.id === decision?.factId); }
  async run() {
    if (this.busy || this.stopped) return;
    this.busy = true;
    try {
      this.items = (await this.ports.observe()).map(observation => ({ observation, status: 'pending', reason: '', attemptedPlans: [] }));
      this.ports.update();
      let discoveries = 0;
      while (!this.stopped) {
        const next = this.items.find(item => item.status === 'pending');
        if (!next) break;
        try { await this.runGroup(next.observation.groupId); }
        catch (error) {
          if (this.stopped) break;
          const reason = error instanceof Error ? error.message : '该模块暂时无法匹配';
          this.error = `部分字段匹配失败，其他字段继续填写：${reason}`;
          for (const item of this.items.filter(item => item.observation.groupId === next.observation.groupId && item.status === 'pending')) this.fail(item, { status: 'failed', reason });
          this.ports.update();
        }
        if (this.stopped) break;
        const observed = await this.ports.observe();
        const newFields = observed.filter(field => !this.items.some(item => item.observation.fieldId === field.fieldId));
        for (const observation of newFields) {
          const replaced = this.items.filter(item => !observed.some(field => field.fieldId === item.observation.fieldId) && item.observation.signature === observation.signature && item.observation.origin === observation.origin);
          if (replaced.length === 1 && newFields.filter(field => field.signature === observation.signature).length === 1) {
            replaced[0].observation = observation;
            replaced[0].status = (replaced[0].decisionAttempts || 0) < 3 ? 'pending' : 'todo';
            replaced[0].reason = '字段已更新，需要重新识别';
          } else this.items.push({ observation, status: discoveries < 20 ? 'pending' : 'todo', reason: discoveries < 20 ? '' : '页面持续变化，请重新开始识别', attemptedPlans: [] });
        }
        for (const item of this.items.filter(item => item.status === 'todo' && (item.decisionAttempts || 0) < 3 && !['user-edited', 'cancelled', 'unverified', 'rejected'].includes(item.outcome?.status || ''))) {
          const current = observed.find(field => field.fieldId === item.observation.fieldId);
          if (current && current.snapshotVersion !== item.observation.snapshotVersion) { item.observation = current; item.status = 'pending'; }
        }
        if (newFields.length) {
          discoveries++;
          for (const groupId of new Set(newFields.map(field => field.groupId))) { if (!this.stopped) await this.runGroup(groupId); }
        }
      }
      // Verify again after dependency and framework updates have settled.
      for (const item of this.items) {
        if (this.stopped) break;
        if (item.status !== 'verified' || !item.decision) continue;
        const result = await this.ports.verify(item.observation, item.decision, this.fact(item.decision)!.value, this.canContinue).catch((error): FillOutcome => ({ status: 'stale', reason: error instanceof Error ? error.message : '字段已变化' }));
        if (result.status !== 'verified' && result.status !== 'unchanged') this.fail(item, result);
      }
      this.checkDateGroups();
    } catch (error) {
      this.error = error instanceof Error ? error.message : '填写服务不可用';
      for (const item of this.items.filter(item => item.status === 'pending')) { item.status = 'todo'; item.reason = this.error; }
    } finally { this.busy = false; this.phase = this.stopped ? 'stopped' : 'complete'; this.ports.update(); }
  }
  private leaveEmpty(item: SessionItem) {
    item.status = 'missing'; item.reason = '未找到对应资料，已留空。可按需补充个人资料。'; item.outcome = { status: 'needs-data', reason: item.reason };
  }
  private fail(item: SessionItem, result: FillOutcome) {
    item.outcome = result; item.status = 'todo'; item.reason = result.reason;
  }
  private async runGroup(groupId: string) {
    const group = this.items.filter(item => item.observation.groupId === groupId && !['verified', 'assisted', 'skipped', 'existing', 'missing'].includes(item.status));
    let previousSnapshot = '';
    for (let round = 0; round < 3 && !this.stopped; round++) {
      const observations = await this.ports.observe();
      let fields: FieldObservation[] = [];
      for (const item of group.filter(item => !['verified', 'assisted', 'existing', 'skipped', 'missing'].includes(item.status))) {
        const current = observations.find(field => field.fieldId === item.observation.fieldId);
        if (!current) { this.fail(item, { status: 'stale', reason: '字段已被页面替换，请重新开始识别该区域' }); continue; }
        if ((current.meaningVersion || current.signature) !== (item.observation.meaningVersion || item.observation.signature)) item.resolvedBinding = undefined;
        item.observation = current;
        if (current.currentValue && item.outcome && ['unverified', 'rejected', 'failed'].includes(item.outcome.status)) { item.status = 'todo'; continue; }
        if (current.disabled || current.kind === 'unsupported') { this.fail(item, { status: 'unsupported', reason: '此控件当前不可自动操作，其他项目继续填写' }); continue; }
        fields.push({ ...current, resolvedBinding: item.resolvedBinding });
      }
      for (let i = fields.length - 1; i >= 0; i--) if ((group.find(item => item.observation.fieldId === fields[i].fieldId)?.decisionAttempts || 0) >= 3) fields.splice(i, 1);
      if (!fields.length) break;
      const fingerprint = versionOf(fields.map(({ resolvedBinding: _binding, ...field }) => field));
      if (previousSnapshot === fingerprint) break;
      previousSnapshot = fingerprint;
      if (this.stopped) break;
      this.phase = 'rules'; this.ports.update();
      for (const field of fields) { const item = group.find(item => item.observation.fieldId === field.fieldId)!; item.decisionAttempts = (item.decisionAttempts || 0) + 1; }
      const establishedBindings = this.items.filter(item => item.observation.groupId === groupId
        && ['verified', 'assisted', 'existing'].includes(item.status) && item.decision?.factId && item.decision?.recordId)
        .map(item => ({ groupId, meaningId: item.decision!.meaningId!, recordId: item.decision!.recordId, factId: item.decision!.factId! }));
      const decisions = buildRuleDecisions(fields, this.context, this.corrections);
      for (const field of fields.filter(field => !decisions.some(decision => decision.fieldId === field.fieldId))) {
        const item = group.find(item => item.observation.fieldId === field.fieldId)!;
        if (field.currentValue) { item.status = 'existing'; item.reason = '已保留网页现有答案'; }
        else this.fail(item, { status: 'needs-mapping', reason: '规则无法确定此字段，请确认含义或使用资料助手填写' });
      }
      fields = fields.filter(field => decisions.some(decision => decision.fieldId === field.fieldId));
      if (!fields.length) break;
      if (this.stopped) break;
      const request = { fields, profile: this.context.profile, registry: this.context.registry, registryVersion: this.context.registryVersion, corrections: this.corrections, establishedBindings };
      const errors = validateModule(decisions, request);
      const prior = this.items.filter(item => item.observation.groupId === groupId && ['verified', 'assisted', 'existing'].includes(item.status) && item.decision?.recordId);
      for (const decision of decisions) {
        if (prior.some(item => item.decision!.meaningId?.split('.')[0] === decision.meaningId?.split('.')[0] && item.decision!.recordId !== decision.recordId)) errors.set(decision.fieldId, '同一经历组已绑定其他记录，请整体确认经历');
      }
      let recovery = false;
      for (const field of fields) {
        if (this.stopped) break;
        const item = group.find(item => item.observation.fieldId === field.fieldId)!;
        const decision = decisions.find(decision => decision.fieldId === field.fieldId);
        item.decision = decision;
        if (!decision || errors.has(field.fieldId)) { this.fail(item, { status: 'needs-mapping', reason: errors.get(field.fieldId) || '未返回字段决策' }); continue; }
        const fact = this.fact(decision);
        if (decision.nextAction === 'requestFact') {
          if (field.currentValue) { item.status = 'existing'; item.reason = '已保留网页现有答案'; }
          else this.leaveEmpty(item);
          continue;
        }
        if (fact) item.resolvedBinding = { meaningId: fact.meaningId, subject: fact.subject, recordId: fact.recordId, factId: fact.id };
        const plan = versionOf({ action: decision.nextAction, fact: decision.factId, options: decision.targetOptionIds, snapshot: field.snapshotVersion });
        if (item.attemptedPlans.includes(plan)) { this.fail(item, { status: 'unsupported', reason: '已尝试此操作，请在网页中完成后检查' }); continue; }
        item.attemptedPlans.push(plan);
        this.phase = 'writing'; this.ports.update();
        const result = await this.ports.execute(field, decision, fact!.value, this.canContinue).catch((error): FillOutcome => ({ status: 'failed', reason: error instanceof Error ? error.message : '控件操作失败' }));
        item.outcome = result;
        if (result.status === 'verified') { item.status = 'verified'; item.reason = ''; }
        else if (['unchanged', 'skipped-existing'].includes(result.status)) { item.status = 'existing'; item.reason = '已保留网页现有答案'; }
        else {
          this.fail(item, result);
          const refreshed = (await this.ports.observe()).find(current => current.fieldId === field.fieldId);
          // Only changed DOM evidence earns another rule attempt; visible values are rechecked by the user.
          if ((result.status === 'stale' || !result.observedValue) && refreshed && refreshed.snapshotVersion !== field.snapshotVersion && !['user-edited', 'cancelled'].includes(result.status)) recovery = true;
        }
        this.ports.update();
      }
      if (!recovery) break;
    }
    group.filter(item => item.status === 'pending').forEach(item => this.fail(item, { status: 'needs-mapping', reason: '需要在网页中处理' }));
  }
  private checkDateGroups() {
    for (const item of this.items.filter(item => item.status === 'verified' && (item.observation.dateGroupId || /\.(startDate|endDate)$/.test(item.decision?.meaningId || '')))) {
      const peers = this.items.filter(peer => peer.observation.groupId === item.observation.groupId && (item.observation.dateGroupId ? peer.observation.dateGroupId === item.observation.dateGroupId : peer.decision?.recordId === item.decision?.recordId && peer.decision?.meaningId?.split('.')[0] === item.decision?.meaningId?.split('.')[0] && /\.(startDate|endDate)$/.test(peer.decision?.meaningId || '')));
      if (peers.some(peer => !['verified', 'existing', 'assisted'].includes(peer.status))) this.fail(item, { status: 'unverified', reason: '同组日期尚未全部通过检查，请核对起止时间' });
    }
  }
  async recheck(item: SessionItem) {
    if (this.busy || !item.decision || !this.fact(item.decision)) return;
    this.busy = true; this.ports.update();
    try {
      const result = await this.ports.verify(item.observation, item.decision, this.fact(item.decision)!.value, () => true);
      if (result.status === 'verified' || result.status === 'unchanged') { item.status = 'assisted'; item.reason = '人工处理后已检查'; item.outcome = result; }
      else this.fail(item, result);
    } finally { this.busy = false; this.ports.update(); }
  }
  async confirmMeaning(item: SessionItem, correction: MeaningCorrection) {
    if (this.busy || this.stopped) return;
    this.corrections.push(correction);
    const group = this.items.filter(peer => peer.observation.groupId === item.observation.groupId);
    for (const peer of group) { peer.status = 'pending'; peer.attemptedPlans = []; peer.decisionAttempts = 0; peer.resolvedBinding = undefined; }
    this.busy = true;
    try { await this.runGroup(item.observation.groupId); this.checkDateGroups(); }
    catch (error) { this.error = error instanceof Error ? error.message : '重新匹配失败'; }
    finally { this.busy = false; this.phase = 'complete'; this.ports.update(); }
  }
  skip(item: SessionItem) { if (!this.busy) { item.status = 'skipped'; item.reason = '本次跳过'; this.ports.update(); } }
  async manual(item: SessionItem, value: string, optionId?: string) {
    if (this.busy) return;
    this.busy = true; this.ports.update();
    try {
      // Explicit field-level user selection is an assisted action, never a learned semantic binding.
      const decision = { ...item.decision, targetOptionIds: optionId ? [optionId] : undefined, meaningId: item.decision?.meaningId } as FieldDecision;
      const result = await this.ports.execute(item.observation, decision, value, () => true, true);
      item.outcome = result;
      if (result.status === 'verified' || result.status === 'unchanged') { item.status = 'assisted'; item.reason = '用户明确填写'; }
      else this.fail(item, result);
    } finally { this.busy = false; this.ports.update(); }
  }
}
