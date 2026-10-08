// Independent oracle: no production matcher, registry or verification imports.
export function expectedFields(source, gold, profile, state) {
  return source.sections.flatMap(section => section.records.flatMap(record => record.fields.flatMap(field => {
    let expected = gold.fields[field.id]?.[profile];
    if (!expected) throw new Error(`Missing gold: ${field.id}/${profile}`);
    if (state === 'existing' && field.existing !== undefined) expected = { policy: 'preserve', value: field.existing };
    if (['range', 'split-date'].includes(field.kind)) return ['a', 'b'].map((part, i) => {
      const value = Array.isArray(expected.value) ? expected.value[i] : '';
      return { id: `${field.id}-${part}`, label: `${field.label} (${part})`, kind: field.kind, group: record.title, initial: '', policy: value ? 'fill' : 'leave-empty', value };
    });
    return [{ id: field.id, label: field.label, kind: field.kind, group: record.title, initial: state === 'existing' ? field.existing ?? field.initial ?? '' : field.initial ?? '', ...expected }];
  })));
}
export function canonicalValue(value, field) {
  const index = field.optionValues?.indexOf(value);
  return index !== undefined && index >= 0 ? field.options[index] : value;
}
function normalize(value, field) {
  const text = String(value ?? '').trim();
  if (['range', 'month'].includes(field.kind) && /^\d{4}[-/.]\d{1,2}$/.test(text)) {
    const [year, month] = text.split(/[-/.]/); return `${year}-${month.padStart(2, '0')}`;
  }
  return text;
}
export function scoreRun(expected, snapshot, observations) {
  const discovered = new Set(observations.map(item => item.controlId).filter(Boolean));
  const known = new Set(expected.map(field => field.id));
  const fields = expected.map(field => {
    const business = normalize(snapshot.business[field.id], field);
    const dom = normalize(snapshot.dom[field.id], field);
    const target = normalize(field.value, field);
    const initial = normalize(field.initial, field);
    const present = Object.hasOwn(snapshot.dom, field.id) && snapshot.dom[field.id] !== null;
    const accepted = [target, ...(field.acceptedValues || []).map(value => normalize(value, field))];
    const correct = present && accepted.includes(business) && accepted.includes(dom);
    const changed = business !== initial || dom !== initial;
    const status = correct ? 'correct' : changed ? 'incorrect' : 'unfilled';
    return { ...field, businessValue: business, domValue: dom, discovered: discovered.has(field.id), correct, status };
  });
  const eligible = fields.filter(field => field.policy === 'fill');
  const preservation = fields.filter(field => field.policy === 'preserve');
  const missing = fields.filter(field => field.policy === 'leave-empty');
  const groups = [...new Set(fields.map(field => field.group).filter(Boolean))].map(group => ({ group, correct: fields.filter(field => field.group === group).every(field => field.correct) }));
  return {
    metrics: {
      totalFields: fields.length, discoveredFields: fields.filter(field => field.discovered).length,
      extraDetections: observations.filter(item => !known.has(item.controlId)).length,
      eligibleFields: eligible.length, correctFilled: eligible.filter(field => field.correct).length,
      incorrectWrites: fields.filter(field => field.status === 'incorrect').length,
      unfilledEligible: eligible.filter(field => !field.correct).length,
      preservedFields: preservation.length, correctlyPreserved: preservation.filter(field => field.correct).length,
      missingFields: missing.length, correctlyLeftEmpty: missing.filter(field => field.correct).length,
      consistentGroups: groups.filter(group => group.correct).length, recordGroups: groups.length,
      submissions: snapshot.submitted,
    }, fields, groups,
  };
}
export function aggregate(runs) {
  const totals = {};
  for (const run of runs) for (const [key, value] of Object.entries(run.metrics)) totals[key] = (totals[key] || 0) + value;
  return { ...totals, completionRate: totals.eligibleFields ? totals.correctFilled / totals.eligibleFields : null, discoveryRate: totals.totalFields ? totals.discoveredFields / totals.totalFields : null };
}
export function compareReports(current, baseline) {
  if (current.metadata.corpusHash !== baseline.metadata.corpusHash) throw new Error('Corpus changed; do not compare different denominators. Create a new baseline version.');
  if (current.metadata.environment.browserVersion !== baseline.metadata.environment.browserVersion) throw new Error('Browser version changed; use the baseline browser or establish a new baseline.');
  if (current.metadata.harnessHash !== baseline.metadata.harnessHash) throw new Error('Harness changed; review scoring changes before comparing.');
  if (current.runs.length !== baseline.runs.length || new Set(current.runs.map(run => run.id)).size !== current.runs.length) throw new Error('Incomplete or duplicate runs');
  const regressions = [];
  for (const before of baseline.runs) {
    const after = current.runs.find(run => run.id === before.id);
    if (!after || after.error) { regressions.push({ runId: before.id, reason: after?.error || 'missing run' }); continue; }
    for (const field of before.fields) {
      const next = after.fields.find(candidate => candidate.id === field.id);
      if (!next) { regressions.push({ runId: before.id, fieldId: field.id, reason: 'missing oracle field' }); continue; }
      if (field.correct && !next.correct) regressions.push({ runId: before.id, fieldId: field.id, reason: 'previously correct value regressed' });
      if (field.discovered && !next.discovered) regressions.push({ runId: before.id, fieldId: field.id, reason: 'discovery regressed' });
      if (field.status !== 'incorrect' && next.status === 'incorrect') regressions.push({ runId: before.id, fieldId: field.id, reason: 'new incorrect write' });
    }
    if (after.metrics.extraDetections > before.metrics.extraDetections) regressions.push({ runId: before.id, reason: 'extra detections increased' });
  }
  return regressions;
}
