import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, basename } from 'node:path';
import { createHash } from 'node:crypto';
import type { UserProfile } from '../src/shared/types.ts';
import { assertManifest, prepareCase, rulePredictions, scoreCase, type EvalCase } from './site-eval.ts';

const args = process.argv.slice(2);
const option = (name: string) => { const index = args.indexOf(name); return index < 0 ? undefined : args[index + 1]; };
const root = resolve(option('--root') || 'tests/site-eval');
const mode = option('--mode') || 'rules';
if (mode !== 'rules') throw new Error('Only local rule evaluation is supported');
const read = (path: string) => JSON.parse(readFileSync(resolve(root, path), 'utf8'));
const manifest = read('manifest.json'); assertManifest(manifest);
const digest = createHash('sha256').update(readFileSync(resolve(root, 'manifest.json')));
for (const path of [...manifest.profiles, ...manifest.sites.flatMap(site => site.cases)]) digest.update(readFileSync(resolve(root, path)));
const runs = [];
for (const site of manifest.sites) for (const path of site.cases) for (const profilePath of manifest.profiles) {
  const sample = read(path) as EvalCase;
  if (sample.siteId !== site.id) throw new Error(`Wrong site for ${path}`);
  const profileId = basename(profilePath, '.json');
  const request = prepareCase(sample, read(profilePath) as UserProfile, manifest.referenceDate);
  const started = performance.now();
  const decisions = rulePredictions(request);
  runs.push({ ...scoreCase(sample, profileId, request, decisions), elapsedMs: Math.round(performance.now() - started) });
}
const report = { benchmarkVersion: manifest.benchmarkVersion, inputHash: digest.digest('hex'), mode,
  annotationStatus: manifest.annotationStatus, scope: 'offline-fact-binding-only',
  limitations: [...manifest.limitations, 'Prepared bindings do not measure control discovery or browser execution.'],
  unavailableSites: manifest.sites.filter(site => !site.cases.length).map(site => ({ id: site.id, status: site.status })),
  totals: { runs: runs.length, fields: runs.reduce((n, run) => n + run.total, 0), eligible: runs.reduce((n, run) => n + run.eligible, 0),
    correctPrepared: runs.reduce((n, run) => n + run.correctPrepared, 0), incorrectAttempts: runs.reduce((n, run) => n + run.incorrectAttempts, 0) }, runs };
const output = option('--output');
if (output) writeFileSync(resolve(output), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({ ...report, runs: undefined }, null, 2));
