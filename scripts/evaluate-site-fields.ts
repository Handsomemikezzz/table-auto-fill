import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, basename } from 'node:path';
import { createHash } from 'node:crypto';
import { LLMDecisionProvider } from '../src/autofill/decisionProvider.ts';
import type { LLMConfig } from '../src/services/llm/types.ts';
import type { UserProfile } from '../src/shared/types.ts';
import { assertManifest, prepareCase, rulePredictions, scoreCase, type EvalCase } from './site-eval.ts';

const args = process.argv.slice(2);
const option = (name: string) => { const index = args.indexOf(name); return index < 0 ? undefined : args[index + 1]; };
const root = resolve(option('--root') || 'tests/site-eval');
const mode = option('--mode') || 'rules';
if (!['rules', 'model'].includes(mode)) throw new Error('Use --mode rules or --mode model');
const read = (path: string) => JSON.parse(readFileSync(resolve(root, path), 'utf8'));
const manifest = read('manifest.json'); assertManifest(manifest);
let provider: LLMDecisionProvider | undefined;
if (mode === 'model') {
  const configPath = option('--config');
  if (!configPath) throw new Error('Model evaluation requires --config with an existing LLMConfig JSON. Credentials are never printed.');
  let config: LLMConfig;
  try {
    config = JSON.parse(readFileSync(resolve(configPath), 'utf8')) as LLMConfig;
    if (!config || typeof config.provider !== 'string' || typeof config.model !== 'string' || !config.model.trim()
      || typeof config.baseUrl !== 'string' || !config.baseUrl.trim() || typeof config.apiKey !== 'string') throw new Error('Invalid config');
  } catch { throw new Error('模型配置无法读取或格式无效，请提供完整的 LLMConfig JSON。'); }
  provider = new LLMDecisionProvider(config);
}
const digest = createHash('sha256').update(readFileSync(resolve(root, 'manifest.json')));
for (const path of [...manifest.profiles, ...manifest.sites.flatMap(site => site.cases)]) digest.update(readFileSync(resolve(root, path)));
const runs = [];
for (const site of manifest.sites) for (const path of site.cases) for (const profilePath of manifest.profiles) {
  const sample = read(path) as EvalCase;
  if (sample.siteId !== site.id) throw new Error(`Wrong site for ${path}`);
  const profileId = basename(profilePath, '.json');
  const request = prepareCase(sample, read(profilePath) as UserProfile, manifest.referenceDate);
  const started = performance.now();
  let decisions = rulePredictions(request);
  let requests = 0, failures = 0;
  if (provider) for (const groupId of new Set(request.fields.map(field => field.groupId))) {
    const fields = request.fields.filter(field => field.groupId === groupId && !field.currentValue && !decisions.some(decision => decision.fieldId === field.fieldId));
    if (!fields.length) continue;
    requests++;
    try { decisions.push(...await provider.decide({ ...request, fields }, AbortSignal.timeout(20_000))); }
    catch { failures++; }
  }
  runs.push({ ...scoreCase(sample, profileId, request, decisions), elapsedMs: Math.round(performance.now() - started), modelRequests: requests, modelFailures: failures });
}
const report = { benchmarkVersion: manifest.benchmarkVersion, inputHash: digest.digest('hex'), mode,
  modelId: provider?.id, annotationStatus: manifest.annotationStatus, scope: 'offline-fact-binding-only',
  limitations: [...manifest.limitations, 'Prepared bindings do not measure control discovery or browser execution.'],
  unavailableSites: manifest.sites.filter(site => !site.cases.length).map(site => ({ id: site.id, status: site.status })),
  totals: { runs: runs.length, fields: runs.reduce((n, run) => n + run.total, 0), eligible: runs.reduce((n, run) => n + run.eligible, 0),
    correctPrepared: runs.reduce((n, run) => n + run.correctPrepared, 0), incorrectAttempts: runs.reduce((n, run) => n + run.incorrectAttempts, 0) }, runs };
const output = option('--output');
if (output) writeFileSync(resolve(output), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({ ...report, runs: undefined }, null, 2));
