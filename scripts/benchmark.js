import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { extname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';
import { connectCdp, findBrowserExecutable, launchTestBrowser, waitFor, delay } from './browser-test-utils.js';
import { expectedFields, canonicalValue, scoreRun, aggregate, compareReports } from '../tests/benchmark/scoring.js';

const root = fileURLToPath(new URL('..', import.meta.url));
const corpus = resolve(root, 'tests/benchmark');
const read = file => JSON.parse(readFileSync(file, 'utf8'));
const manifest = read(join(corpus, 'manifest.json'));
const gold = read(join(corpus, 'gold.json'));
const sources = Object.fromEntries(manifest.sources.map(id => [id, read(join(corpus, 'sources', id + '.json'))]));
const profiles = Object.fromEntries(manifest.profiles.map(id => [id, read(join(corpus, 'profiles', id + '.json'))]));
const args = process.argv.slice(2);
function option(name, fallback) { const index = args.indexOf(name); if (index < 0) return fallback; if (!args[index + 1] || args[index + 1].startsWith('--')) throw new Error(`Missing ${name} value`); return args[index + 1]; }
for (const arg of args.filter(value => value.startsWith('--'))) if (!['--output', '--compare', '--baseline'].includes(arg)) throw new Error(`Unknown option: ${arg}`);
const output = resolve(root, option('--output', 'artifacts/benchmark/latest.json'));
const baselineOutput = option('--baseline');
const comparisonPath = option('--compare');
if (baselineOutput && existsSync(resolve(root, baselineOutput))) throw new Error('Baseline already exists. Choose a new version; never silently overwrite a baseline.');
const extensionDir = resolve(root, 'dist');
if (!existsSync(join(extensionDir, 'manifest.json'))) throw new Error('Run npm run benchmark to build the actual extension first.');
const list = dir => readdirSync(dir, { withFileTypes: true }).flatMap(entry => entry.isDirectory() ? list(join(dir, entry.name)) : [join(dir, entry.name)]).sort();
const hash = files => { const digest = createHash('sha256'); for (const file of files) { digest.update(file.startsWith(root) ? file.slice(root.length) : file); digest.update('\0'); digest.update(readFileSync(file)); digest.update('\0'); } return digest.digest('hex'); };
const corpusFiles = [join(corpus, 'manifest.json'), join(corpus, 'gold.json'), join(corpus, 'capture-notes.json'), join(corpus, 'fixture.tsx'), join(corpus, 'fixture.css'), join(corpus, 'index.html'), ...list(join(corpus, 'sources')), ...list(join(corpus, 'profiles'))].sort();
const metadata = {
  benchmarkVersion: manifest.benchmarkVersion, referenceDate: manifest.referenceDate,
  annotationStatus: gold.annotationStatus, corpusHash: hash(corpusFiles),
  harnessHash: hash([fileURLToPath(import.meta.url), join(corpus, 'scoring.js'), resolve(root, 'scripts/browser-test-utils.js')]),
  codeCommit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
  workingTreeChanges: execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' }).trim().split('\n').filter(Boolean),
  productionSourceHash: hash(list(join(root, 'src'))), extensionHash: hash(list(extensionDir)),
  startedAt: new Date().toISOString(), environment: { platform: process.platform, arch: process.arch, node: process.version, browserExecutable: findBrowserExecutable() },
  scope: 'frozen-local-reproductions-actual-extension; not live-site accuracy',
  discoveryMethod: 'read-only probe of current production createPageObserver with DOM-node mapping; separate from extension isolated world',
};
if (comparisonPath) {
  const before = read(resolve(root, comparisonPath));
  if (before.metadata.corpusHash !== metadata.corpusHash) throw new Error('Corpus changed; create a versioned baseline rather than comparing different inputs.');
  if (before.metadata.harnessHash !== metadata.harnessHash) throw new Error('Harness changed; review scoring changes and create a versioned baseline.');
}
const fixtureDir = mkdtempSync(join(tmpdir(), 'fill-ease-benchmark-'));
let server, browser, page, background, networkTimer;
const runs = [];
const blockedNetwork = [];
try {
  await build({ configFile: false, root, logLevel: 'error', build: { outDir: fixtureDir, emptyOutDir: true, rollupOptions: { input: join(corpus, 'index.html') } } });
  // Serve only renderer schemas and compiled assets. Gold and profiles stay in Node.
  server = createServer((request, response) => {
    const pathname = new URL(request.url || '/', 'http://localhost').pathname;
    const schemaId = /^\/sources\/([a-z0-9-]+)\.json$/.exec(pathname)?.[1];
    if (schemaId) {
      if (!sources[schemaId]) { response.writeHead(404).end(); return; }
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify(sources[schemaId])); return;
    }
    const file = resolve(fixtureDir, '.' + decodeURIComponent(pathname));
    if (!file.startsWith(fixtureDir + sep) || !existsSync(file)) { response.writeHead(404).end(); return; }
    response.writeHead(200, { 'Content-Type': ({ '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json' })[extname(file)] || 'application/octet-stream' });
    response.end(readFileSync(file));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  browser = await launchTestBrowser(extensionDir, 'about:blank');
  const target = await waitFor(async () => (await browser.targets()).find(t => t.type === 'page'), 'benchmark browser');
  page = await connectCdp(target.webSocketDebuggerUrl);
  await page.send('Page.enable');
  await page.send('Runtime.enable');
  await page.send('Network.enable');
  await page.send('Fetch.enable', { patterns: [{ urlPattern: 'http://*' }, { urlPattern: 'https://*' }] });
  // The fixture cannot phone home or transmit synthetic profiles to real sites.
  // Handle paused requests through the event stream without modifying live Chrome.
  let handledEvents = 0;
  networkTimer = setInterval(() => {
    for (const event of page.events.slice(handledEvents)) if (event.method === 'Fetch.requestPaused') {
      const { requestId, request } = event.params;
      const local = request.url.startsWith(base + '/');
      if (!local) blockedNetwork.push(request.url.split('?')[0]);
      void page.send(local ? 'Fetch.continueRequest' : 'Fetch.failRequest', { requestId, ...(local ? {} : { errorReason: 'BlockedByClient' }) }).catch(() => {});
    }
    handledEvents = page.events.length;
  }, 20);
  const worker = await waitFor(async () => (await browser.targets()).find(t => t.type === 'service_worker' && t.url.endsWith('/background.js')), 'actual extension background');
  background = await connectCdp(worker.webSocketDebuggerUrl);
  await background.send('Runtime.enable');
  await waitFor(() => background.evaluate('typeof chrome !== "undefined" && Boolean(chrome.storage?.local && chrome.tabs?.query)'), 'extension APIs initialized');
  metadata.environment.browserVersion = execFileSync(findBrowserExecutable(), ['--version'], { encoding: 'utf8' }).trim();
  const send = (type, payload) => background.evaluate(`(async () => {
    const tab = (await chrome.tabs.query({url:${JSON.stringify(base + '/*')}}))[0];
    if (!tab?.id) throw new Error('No fixture tab');
    await chrome.scripting.executeScript({ target: { tabId: tab.id, allFrames: true }, files: ['content.js'] }).catch(() => {});
    return chrome.tabs.sendMessage(tab.id, ${JSON.stringify({ type, ...(payload ? { payload } : {}) })}, {frameId:0});
  })()`);
  try {
    for (const siteId of manifest.sources) for (const profileId of manifest.profiles) for (const state of manifest.states) {
      const id = `${siteId}/${profileId}/${state}`;
      const started = performance.now();
      const source = sources[siteId];
      const profile = profiles[profileId];
      let stage = 'profile storage';
      try {
        // Set synthetic data before navigation, in a fresh disposable browser profile.
        await background.evaluate(`(async () => { await chrome.storage.local.clear(); await chrome.storage.local.set({userProfile:${JSON.stringify(profile)}}); })()`);
        stage = 'fixture navigation';
        await page.send('Page.navigate', { url: `${base}/tests/benchmark/index.html?site=${siteId}&state=${state}` });
        await waitFor(() => page.evaluate('window.benchmarkFixture?.ready()'), 'fixture ready');
        stage = 'content handshake';
        await waitFor(async () => (await send('PING_CONTENT'))?.success, 'content script ready');
        stage = 'discovery';
        const observations = await page.evaluate(`window.benchmarkFixture.scan(${JSON.stringify(profile)}, ${JSON.stringify(manifest.referenceDate)})`);
        stage = 'session start';
        const response = await send('START_FILL_SESSION', { sourceId: 'default', attachmentId: null });
        if (!response.success) throw new Error(response.error || 'Fill did not start');
        stage = 'session settle';
        const result = await waitFor(async () => { const status = await send('GET_FILL_SESSION_RESULT'); return status.success && !status.data.starting && status.data.result?.settled && status.data.result; }, 'session settled', 60_000);
        // Allow independent business state to settle beyond extension's own readback.
        await delay(300);
        stage = 'independent readback';
        const snapshot = await page.evaluate(`(() => {
          const state = window.benchmarkFixture.snapshot(); const dom = {};
          const ids = ${JSON.stringify(expectedFields(source, gold, profileId, state).map(field => field.id))};
          for (const id of ids) {
            const element = document.getElementById(id);
            if (!element) { dom[id] = null; continue; }
            if (element.matches('input[type=file]')) dom[id] = element.files.length ? element.files[0].name : '';
            else if (element.matches('input[type=checkbox]')) dom[id] = element.checked ? 'true' : '';
            else if (element.matches('input,select,textarea')) dom[id] = element.value;
            else if (element.querySelector('input[type=radio]')) dom[id] = element.querySelector('input:checked')?.value || '';
            else dom[id] = element.querySelector('.ud__select__selector__selectItem')?.textContent || element.querySelector('input')?.value || '';
          }
          return {business: state.values, dom, submitted:state.submitted};
        })()`);
        const sourceFields = source.sections.flatMap(section => section.records.flatMap(record => record.fields));
        for (const field of sourceFields) {
          snapshot.dom[field.id] = canonicalValue(snapshot.dom[field.id], field);
          snapshot.business[field.id] = canonicalValue(snapshot.business[field.id], field);
        }
        const scored = scoreRun(expectedFields(source, gold, profileId, state), snapshot, observations);
        runs.push({ id, siteId, profileId, state, provenance: source.provenance, elapsedMs: Math.round(performance.now() - started), ...scored, extensionResult: result, observations });
        console.log(`${id}: ${scored.metrics.correctFilled}/${scored.metrics.eligibleFields}, wrong=${scored.metrics.incorrectWrites}, discovered=${scored.metrics.discoveredFields}/${scored.metrics.totalFields}`);
      } catch (error) {
        runs.push({ id, siteId, profileId, state, error: `${stage}: ${error.message}`, elapsedMs: Math.round(performance.now() - started) });
        console.error(`${id}: ERROR ${stage}: ${error.message}`);
      }
    }
  } finally { clearInterval(networkTimer); }
  const errors = runs.filter(run => run.error);
  const integrityErrors = [];
  if (hash(corpusFiles) !== metadata.corpusHash) integrityErrors.push('corpus changed during run');
  if (hash([fileURLToPath(import.meta.url), join(corpus, 'scoring.js'), resolve(root, 'scripts/browser-test-utils.js')]) !== metadata.harnessHash) integrityErrors.push('harness changed during run');
  if (hash(list(join(root, 'src'))) !== metadata.productionSourceHash || hash(list(extensionDir)) !== metadata.extensionHash) integrityErrors.push('production source or dist changed during run');
  const report = { metadata: { ...metadata, completedAt: new Date().toISOString() }, limitations: manifest.limitations, blockedNetwork, integrityErrors, summary: aggregate(runs.filter(run => !run.error)), sites: Object.fromEntries(manifest.sources.map(id => [id, aggregate(runs.filter(run => run.siteId === id && !run.error))])), runs, errors };
  if (comparisonPath) report.regressions = compareReports(report, read(resolve(root, comparisonPath)));
  mkdirSync(resolve(output, '..'), { recursive: true });
  writeFileSync(output, JSON.stringify(report, null, 2) + '\n');
  console.log(`Report: ${output}`);
  console.log(JSON.stringify(report.summary));
  if (baselineOutput) {
    if (errors.length || integrityErrors.length || blockedNetwork.length || report.summary.submissions) throw new Error('Refusing to establish baseline: incomplete or changing inputs, unexpected network or submission. Report kept for diagnosis.');
    const baseline = resolve(root, baselineOutput);
    mkdirSync(resolve(baseline, '..'), { recursive: true });
    writeFileSync(baseline, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
    console.log(`Baseline saved: ${baseline}`);
  }
  if (errors.length || integrityErrors.length || blockedNetwork.length || report.summary.submissions || report.regressions?.length) process.exitCode = 1;
} finally {
  clearInterval(networkTimer);
  page?.close(); background?.close();
  if (browser) await browser.close();
  if (server) await new Promise(resolve => server.close(resolve));
  rmSync(fixtureDir, { recursive: true, force: true });
}
