import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { extname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';
import { connectCdp, delay, findBrowserExecutable, launchTestBrowser, waitFor } from './browser-test-utils.js';

const projectRoot = fileURLToPath(new URL('..', import.meta.url));
const extensionDir = resolve(projectRoot, 'dist');
if (!existsSync(resolve(extensionDir, 'manifest.json'))) {
  throw new Error('请先执行 npm run build；回归会加载 dist 中的实际扩展。');
}
const fixtureDir = mkdtempSync(join(tmpdir(), 'job-applymate-fixture-'));
// Build a fixed snapshot: edits to production sources must not hot-reload a
// fixture halfway through an asynchronous verification or keyboard test.
await build({
  configFile: false,
  root: projectRoot,
  logLevel: 'error',
  build: {
    outDir: fixtureDir,
    emptyOutDir: true,
    rollupOptions: { input: resolve(projectRoot, 'tests/form-fill/index.html') },
  },
});
let modelRequests = [];
let modelMode = 'normal';
let modelDelay = 0;
const fixtureServer = createServer(async (request, response) => {
  if (request.url === '/v1/chat/completions') {
    let body = '';
    for await (const chunk of request) body += chunk;
    const input = JSON.parse(body);
    const context = JSON.parse(input.messages.at(-1).content);
    modelRequests.push(context);
    if (modelDelay) await delay(modelDelay);
    if (modelMode === 'fail-first' && modelRequests.length === 1) { response.writeHead(503, { 'Content-Type': 'application/json' }); response.end(JSON.stringify({ error: { message: 'fixture module failure' } })); return; }
    const decisions = context.fields.map(field => {
      const text = `${field.groupLabel} ${field.label} ${field.context}`;
      let meaning = /姓名|怎么称呼/.test(field.label) ? 'personal.name' : /性别/.test(field.label) ? 'personal.gender' : /出生/.test(field.label) ? 'personal.birthDate' : /邮箱/.test(field.label) ? 'personal.email' : field.kind === 'file' ? 'attachment.resumeFile' : /学校/.test(field.label) ? 'education.school' : /入学|起止|毕业/.test(field.label) ? 'education.' + (/毕业|结束/.test(field.label) || /end\s*$/.test(field.context) ? 'endDate' : 'startDate') : '';
      if (field.label.startsWith('起止时间') && /工作/.test(text)) meaning = /end/.test(field.context) ? 'experience.endDate' : 'experience.startDate';
      const facts = context.profile.facts.filter(fact => fact.meaningId === meaning);
      const fact = /研究生|硕士/.test(text) ? facts.find(fact => fact.recordId === 'edu-graduate') || facts[0] : facts[0];
      const option = fact && field.options.find(option => option.label === fact.value);
      const choice = ['select', 'radio', 'checkbox', 'combobox'].includes(field.kind);
      return { fieldId: field.fieldId, snapshotVersion: field.snapshotVersion, meaningId: fact?.meaningId, subject: fact?.subject, recordId: fact?.recordId, factId: modelMode === 'invented' ? 'not-a-real-fact' : fact?.id, nextAction: !fact ? 'requestFact' : choice ? option ? 'select' : field.optionsState !== 'complete' ? 'readOptions' : 'manual' : 'write', targetOptionIds: option ? [option.id] : undefined, dependencyIds: [], evidenceIds: [], value: '模型编造值不得写入' };
    });
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ decisions }) }, finish_reason: 'stop' }] }));
    return;
  }
  const pathname = new URL(request.url || '/', 'http://127.0.0.1').pathname;
  const file = resolve(fixtureDir, `.${decodeURIComponent(pathname)}`);
  if (!file.startsWith(fixtureDir + sep) || !existsSync(file)) { response.writeHead(404).end(); return; }
  const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' };
  response.writeHead(200, { 'Content-Type': types[extname(file)] || 'application/octet-stream' });
  response.end(readFileSync(file));
});
await new Promise(resolve => fixtureServer.listen(0, '127.0.0.1', resolve));
const serverAddress = fixtureServer.address();
assert(serverAddress && typeof serverAddress !== 'string');
const fixtureUrl = `http://127.0.0.1:${serverAddress.port}/tests/form-fill/index.html`;
let browser;
let page;
let background;
let passed = 0;
const failed = [];

const profile = {
  personal: { name: '测试用户', gender: '男', birthDate: '2000-06', phone: '', email: '', currentAddress: '' },
  education: [
    { id: 'edu-undergraduate', school: '本科测试大学', college: '', major: '', degree: '本科', educationType: '', startDate: '2018-09', endDate: '2022-06', gpa: '' },
    { id: 'edu-graduate', school: '研究生测试大学', college: '', major: '', degree: '硕士研究生', educationType: '', startDate: '2022-09', endDate: '2025-06', gpa: '' },
  ],
  experience: [], projects: [], skills: [], certifications: [], customInformation: [],
};

async function check(name, action) {
  if (process.env.JOB_APPLYMATE_TEST_FILTER && !name.includes(process.env.JOB_APPLYMATE_TEST_FILTER)) return;
  try { await action(); passed++; console.log(`✓ ${name}`); }
  catch (error) {
    failed.push({ name, message: error.message });
    console.error(`✗ ${name}\n  ${error.message}`);
    if (/超时/.test(error.message)) {
      console.error(JSON.stringify(page?.events.filter(event => ['Runtime.exceptionThrown', 'Page.javascriptDialogOpening'].includes(event.method)).slice(-4)));
      throw error;
    }
  }
}
async function render(scenario) {
  await page.evaluate(`window.formFixture.render(${JSON.stringify(scenario)})`);
  await delay(30);
}
async function runEngine(scenario, selector, value, expectedStatus, stateKey, expectedValue, context = {}) {
  await render(scenario);
  const result = await page.evaluate(`window.formFixture.fill(${JSON.stringify(selector)}, ${JSON.stringify(value)}, ${JSON.stringify(context)})`);
  if (expectedStatus !== 'failure' && result.status !== expectedStatus) {
    console.error(JSON.stringify(await page.evaluate(`({
      control: document.querySelector(${JSON.stringify(selector)})?.outerHTML,
      controlRect: document.querySelector(${JSON.stringify(selector)})?.getBoundingClientRect().toJSON(),
      popups: Array.from(document.querySelectorAll('[role="listbox"], [role="tree"], .ant-cascader-dropdown, .ant-cascader-menus')).map(element => ({
        html: element.outerHTML.slice(0, 4000), rect: element.getBoundingClientRect().toJSON(), rects: element.getClientRects().length,
        display: getComputedStyle(element).display, visibility: getComputedStyle(element).visibility,
        hiddenAncestor: element.closest('[hidden], [aria-hidden="true"]')?.outerHTML.slice(0, 500),
      }))
    })`)));
  }
  if (expectedStatus === 'failure') {
    assert(!['verified', 'unchanged'].includes(result.status), JSON.stringify(result));
  } else assert.equal(result.status, expectedStatus, JSON.stringify(result));
  const snapshot = await page.evaluate('window.formFixture.snapshot()');
  assert.equal(snapshot.state[stateKey] ?? '', expectedValue, JSON.stringify({ result, snapshot }));
  return result;
}
async function prepareExtension(scenario) {
  await page.send('Page.navigate', { url: `${fixtureUrl}?scenario=${scenario}` });
  await waitFor(() => page.evaluate('Boolean(window.formFixture && document.querySelector("#react-state"))'), 'React fixture 挂载');
  await waitFor(() => background.evaluate(`(async () => {
    const tab = (await chrome.tabs.query({ url: ${JSON.stringify(fixtureUrl + '*')} }))[0];
    if (!tab?.id) return false;
    return (await chrome.tabs.sendMessage(tab.id, { type: 'PING_CONTENT' }, { frameId: 0 }))?.success;
  })()`), '扩展 content script 可接收消息');
  const fixtureProfile = {
    ...profile,
    personal: {
      ...profile.personal,
      ...(scenario === 'picker-day' ? { birthDate: '2000-06-15' } : {}),
      ...(['cascader', 'ant-cascader'].includes(scenario) ? { currentAddress: '四川省 / 成都市 / 武侯区' } : {}),
      ...(scenario === 'ai-cancel' ? { email: 'cancel@example.com' } : {}),
    },
    ...(scenario === 'feishu-deep-range' ? {
      education: [{ ...profile.education[0], startDate: '2018.8', endDate: '2022.6' }],
      experience: [{ id: 'work-1', company: '', position: '', startDate: '2022.7', endDate: '2023.9', description: '' }],
    } : {}),
    ...(scenario === 'ai-cancel' ? { resume: { fileName: 'cancel.pdf', fileData: 'data:application/pdf;base64,JVBERi0xLjQ=', fileType: 'pdf', uploadDate: '2026-09-28T00:00:00.000Z' } } : {}),
  };
  await background.evaluate(`(async () => {
    await chrome.storage.local.clear();
    await chrome.storage.local.set({ userProfile: ${JSON.stringify(fixtureProfile)}, llmConfig: { provider: 'custom', model: 'fixture-model', apiKey: 'fixture-only', baseUrl: ${JSON.stringify(fixtureUrl.split('/tests/')[0] + '/v1')} } });
  })()`);
}
async function makeNameUnknown() {
  await page.evaluate(`(() => { const input = document.querySelector('#name'); input.id = 'answer'; input.name = 'answer'; const label = document.querySelector('label[for="name"]'); label.htmlFor = 'answer'; label.textContent = '怎么称呼你'; })()`);
}
async function extensionFill(scenario) {
  modelRequests = []; modelMode = 'normal'; modelDelay = 0;
  await prepareExtension(scenario);
  const response = await background.evaluate(`(async () => {
    const tab = (await chrome.tabs.query({ url: ${JSON.stringify(fixtureUrl + '*')} }))[0];
    const detection = await chrome.tabs.sendMessage(tab.id, { type: 'DETECT_FIELDS' }, { frameId: 0 });
    const response = await chrome.tabs.sendMessage(tab.id, { type: 'FILL_FORM', payload: { resumeId: null } }, { frameId: 0 });
    return { ...response, testDetection: detection };
  })()`, 60_000);
  assert.equal(response.success, true, JSON.stringify(response));
  await waitFor(() => page.evaluate("Boolean(document.querySelector('[data-job-applymate-task]')?.shadowRoot?.textContent.includes('已填写'))"), '模型填写任务完成', 30000);
  const panel = await page.evaluate("document.querySelector('[data-job-applymate-task]').shadowRoot.textContent");
  const counts = panel.match(/已填写 (\d+) 项，(\d+) 项需处理/);
  response.data = { verifiedCount: Number(counts?.[1] || 0), failures: Number(counts?.[2]) ? Array(Number(counts[2])).fill({}) : [], panel };
  return { response, snapshot: await page.evaluate('window.formFixture.snapshot()') };
}

try {
  console.log(`真实浏览器：${findBrowserExecutable()}`);
  browser = await launchTestBrowser(extensionDir, fixtureUrl);
  const pageTarget = await waitFor(async () => (await browser.targets()).find(target => target.type === 'page' && target.url.startsWith(fixtureUrl)), '本地 fixture 页面');
  page = await connectCdp(pageTarget.webSocketDebuggerUrl);
  await page.send('Page.bringToFront');
  await page.send('Runtime.enable');
  await page.send('Page.enable');
  await waitFor(() => page.evaluate('Boolean(window.formFixture)'), 'React fixture 初始化');
  const workerTarget = await waitFor(async () => (await browser.targets()).find(target => target.type === 'service_worker' && target.url.endsWith('/background.js')), '实际扩展后台启动');
  background = await connectCdp(workerTarget.webSocketDebuggerUrl);

  await check('React 受控文本：DOM 写入同步到组件状态', () => runEngine('react-text', '#name', '测试用户', 'verified', 'name', '测试用户'));
  await check('原生下拉：男对应 0', () => runEngine('select-zero', '#gender', '男', 'verified', 'gender', '0', { semantic: 'gender' }));
  await check('原生下拉：男对应 1，映射反转仍正确', () => runEngine('select-one', '#gender', '男', 'verified', 'gender', '1', { semantic: 'gender' }));
  await check('原生单选：男对应 0，React checked 状态正确', () => runEngine('radio-zero', '#gender-0', '男', 'verified', 'gender', '0', { semantic: 'gender' }));
  await check('纯 ARIA 单选：不依赖原生 input', () => runEngine('aria-radio', '#aria-0', '男', 'verified', 'gender', '男', { semantic: 'gender' }));
  await check('纯 ARIA 单选发现为一个逻辑字段，题目来自 radiogroup', async () => {
    await render('aria-radio');
    const observations = await page.evaluate('window.formFixture.observe()');
    assert.deepEqual(observations, [{ kind: 'radio', label: '性别', optionLabels: ['女', '男'] }]);
  });
  await check('纯 ARIA 下拉：等待异步选项并提交选择', () => runEngine('aria-combobox', '#gender', '男', 'verified', 'gender', 'm', { semantic: 'gender' }));
  await check('真实 Ant Design Select 提交组件值', () => runEngine('ant-select', '.ant-select', '男', 'verified', 'gender', 'm', { semantic: 'gender' }));
  await check('搜索词已写入但选项未提交，不能报成功', () => runEngine('search-rejected', '#gender', '男', 'failure', 'gender', '', { semantic: 'gender', timeoutMs: 1800 }));
  await check('搜索建议已高亮 selected 但业务值未提交，不能报成功', () => runEngine('search-highlight', '#gender', '男', 'failure', 'gender', '', { semantic: 'gender', timeoutMs: 1800 }));
  await check('不会点击不属于当前字段的弹层选项', () => runEngine('unrelated-popup', '#gender', '男', 'failure', 'unrelated', '', { semantic: 'gender', timeoutMs: 1800 }));
  await check('React 延迟回滚不能计成功', () => runEngine('rollback', '#name', '测试用户', 'failure', 'name', ''));
  await check('原有错误单选不会因为存在 checked 就报成功', () => runEngine('existing-radio', '#gender-m', '男', 'skipped-existing', 'gender', 'f', { semantic: 'gender' }));
  await check('年月资料可写入 month 控件', () => runEngine('month', '#birthDate', '2000.6', 'verified', 'birthDate', '2000-06', { semantic: 'date' }));
  await check('年月资料不能静默补成某一天', () => runEngine('day-precision', '#birthDate', '2000-06', 'needs-mapping', 'birthDate', '', { semantic: 'date' }));
  await check('真实 Ant Design 日期控件：readonly 输入通过日历选择', () => runEngine('picker-day', '#birthDate', '2000-06-15', 'verified', 'birthDate', '2000-06-15', { semantic: 'date' }));
  await check('真实 Ant Design 月份控件：保持年月精度', () => runEngine('picker-month', '#birthDate', '2000-06', 'verified', 'birthDate', '2000-06', { semantic: 'date' }));
  await check('未知 readonly 日期控件明确 unsupported', () => runEngine('unknown-picker', '#birthDate', '2000-06-15', 'unsupported', 'birthDate', '', { semantic: 'date' }));
  await check('级联地区只沿目标父节点选择同名子节点', () => runEngine('cascader', '#region', '四川省 / 成都市 / 武侯区', 'verified', 'region', '四川省 / 成都市 / 武侯区'));
  await check('级联地区无明确分段时不能猜测路径', () => runEngine('cascader', '#region', '四川省成都市', 'needs-mapping', 'region', ''));
  await check('真实 Ant Design Cascader 沿父级逐列选择', () => runEngine('ant-cascader', '.ant-cascader', '四川省 / 成都市 / 武侯区', 'verified', 'region', '四川省 / 成都市 / 武侯区'));
  await check('真实键盘输入中止自动填写，保留用户改动', async () => {
    await render('user-edit');
    await page.evaluate("void (window.pendingFill = window.formFixture.fill('#name', '自动填写', { settleMs: 700 }))");
    await delay(100);
    await page.evaluate("document.querySelector('#name').focus(); document.querySelector('#name').select()");
    await page.send('Input.insertText', { text: '用户手改' });
    const result = await page.evaluate('window.pendingFill');
    const snapshot = await page.evaluate('window.formFixture.snapshot()');
    assert.equal(result.status, 'user-edited', JSON.stringify(result));
    assert.equal(snapshot.state.name, '用户手改');
  });
  await check('保留已有字段后撤销，不覆盖用户原值', async () => {
    await render('existing-text');
    await page.evaluate('window.formFixture.beginFiller()');
    assert.equal(await page.evaluate("window.formFixture.fillViaFiller('#name', '自动填写')"), 0);
    assert.equal(await page.evaluate('window.formFixture.undoFiller()'), 0);
    assert.equal((await page.evaluate('window.formFixture.snapshot()')).state.name, '用户原有姓名');
  });
  await check('用户中途编辑后撤销，不覆盖用户新值', async () => {
    await render('user-edit');
    await page.evaluate('window.formFixture.beginFiller()');
    await page.evaluate("void (window.pendingFill = window.formFixture.fillViaFiller('#name', '自动填写'))");
    await delay(100);
    await page.evaluate("document.querySelector('#name').focus(); document.querySelector('#name').select()");
    await page.send('Input.insertText', { text: '用户新值' });
    assert.equal(await page.evaluate('window.pendingFill'), 0);
    assert.equal(await page.evaluate('window.formFixture.undoFiller()'), 0);
    assert.equal((await page.evaluate('window.formFixture.snapshot()')).state.name, '用户新值');
  });
  await check('原来未选择的单选无法通用清空时，撤销不能虚报恢复', async () => {
    await render('radio-zero');
    await page.evaluate('window.formFixture.beginFiller()');
    assert.equal(await page.evaluate("window.formFixture.fillViaFiller('#gender-0', '男')"), 1);
    assert.equal(await page.evaluate('window.formFixture.undoFiller()'), 0);
    assert.equal((await page.evaluate('window.formFixture.snapshot()')).state.gender, '0');
  });
  await check('后续字段联动清空前一字段时重新验证扣除成功数', async () => {
    await render('linked');
    await page.evaluate('window.formFixture.beginFiller()');
    assert.equal(await page.evaluate("window.formFixture.fillViaFiller('#name', '测试用户')"), 1);
    assert.equal(await page.evaluate("window.formFixture.fillViaFiller('#email', 'test@example.com')"), 1);
    const result = await page.evaluate('window.formFixture.revalidateFiller()');
    assert.equal(result.count, 1, JSON.stringify(result));
    assert(result.failures.some(failure => failure.label === '姓名'), JSON.stringify(result));
    assert.equal((await page.evaluate('window.formFixture.snapshot()')).state.name, '');
  });

  for (const [scenario, key, value] of [
    ['react-text', 'name', '测试用户'],
    ['select-zero', 'gender', '0'],
    ['select-one', 'gender', '1'],
    ['radio-zero', 'gender', '0'],
    ['aria-radio', 'gender', '男'],
    ['aria-combobox', 'gender', 'm'],
    ['ant-select', 'gender', 'm'],
    ['month', 'birthDate', '2000-06'],
    ['picker-day', 'birthDate', '2000-06-15'],
    ['picker-month', 'birthDate', '2000-06'],
  ]) {
    await check(`扩展 FILL_FORM：${scenario}`, async () => {
      const { response, snapshot } = await extensionFill(scenario);
      if (snapshot.state[key] !== value) console.error(JSON.stringify(await page.evaluate('window.formFixture.diagnose()')));
      assert.equal(snapshot.state[key], value, JSON.stringify({ response, snapshot }));
      assert.equal(response.data?.verifiedCount, 1, JSON.stringify(response));
      assert.equal(modelRequests.length, 0, '明确的规则匹配不应请求模型');
      assert(modelRequests.every(request => request.profile.facts && !JSON.stringify(request).includes('fileData')), '模型只接收事实，不接收附件内容');
    });
  }
  await check('扩展 FILL_FORM：飞书深层起止框与失焦日期格式化', async () => {
    const { response, snapshot } = await extensionFill('feishu-deep-range');
    assert.deepEqual(snapshot.state, { 'edu-a': '2018-08', 'edu-b': '2022-06', 'work-a': '2022-07', 'work-b': '2023-09' }, JSON.stringify({ response, snapshot }));
    assert.equal(response.data?.verifiedCount, 4, JSON.stringify(response));
  });
  await check('扩展 FILL_FORM：多条教育经历按整条记录绑定，缺字段不串行', async () => {
    const { response, snapshot } = await extensionFill('education');
    assert.deepEqual(snapshot.state, {
      'graduate-school': '研究生测试大学', 'graduate-start': '2022-09',
      'undergraduate-school': '本科测试大学', 'undergraduate-start': '2018-09', 'undergraduate-end': '2022-06',
    }, JSON.stringify({ response, snapshot }));
    assert.equal(response.data?.verifiedCount, 5, JSON.stringify(response));
  });
  await check('扩展 FILL_FORM：通用起止时间组归属同一教育记录', async () => {
    const { response, snapshot } = await extensionFill('education-range');
    assert.deepEqual(snapshot.state, { school: '本科测试大学', 'range-start': '2018-09', 'range-end': '2022-06' }, JSON.stringify({ response, snapshot }));
    assert.equal(response.data?.verifiedCount, 3, JSON.stringify(response));
  });
  for (const scenario of ['rollback', 'day-precision', 'search-rejected', 'search-highlight']) {
    await check(`扩展 FILL_FORM：${scenario} 不虚报成功`, async () => {
      const { response, snapshot } = await extensionFill(scenario);
      assert.equal(response.data?.verifiedCount, 0, JSON.stringify({ response, snapshot }));
      assert(response.data?.failures?.length > 0, JSON.stringify(response));
    });
  }
  await check('模型返回不存在的事实时不填写', async () => {
    await prepareExtension('react-text'); await makeNameUnknown(); modelMode = 'invented';
    await background.evaluate(`(async () => { const tab = (await chrome.tabs.query({ url: ${JSON.stringify(fixtureUrl + '*')} }))[0]; return chrome.tabs.sendMessage(tab.id, { type: 'START_FILL_SESSION', payload: { sourceId: 'default' } }, { frameId: 0 }); })()`);
    await waitFor(() => page.evaluate("document.querySelector('[data-job-applymate-task]')?.shadowRoot?.textContent.includes('已填写 0 项，1 项需处理')"), '虚构事实被阻止');
    assert.equal((await page.evaluate('window.formFixture.snapshot()')).state.name || '', '');
    modelMode = 'normal';
  });
  await check('未配置模型仍然完成规则填写', async () => {
    await prepareExtension('react-text');
    await background.evaluate("chrome.storage.local.remove('llmConfig')");
    await background.evaluate(`(async () => { const tab = (await chrome.tabs.query({ url: ${JSON.stringify(fixtureUrl + '*')} }))[0]; return chrome.tabs.sendMessage(tab.id, { type: 'FILL_FORM' }, { frameId: 0 }); })()`);
    await waitFor(() => page.evaluate("document.querySelector('[data-job-applymate-task]')?.shadowRoot?.textContent.includes('已填写 1 项')"), '无模型的本地填写');
    assert.equal((await page.evaluate('window.formFixture.snapshot()')).state.name, '测试用户');
  });
  await check('停止本地填写后不再填写后续字段或上传附件', async () => {
    await prepareExtension('ai-cancel'); modelRequests = []; modelDelay = 1000;
    await background.evaluate(`(async () => { const tab = (await chrome.tabs.query({ url: ${JSON.stringify(fixtureUrl + '*')} }))[0]; return chrome.tabs.sendMessage(tab.id, { type: 'START_FILL_SESSION', payload: { sourceId: 'default', attachmentId: 'legacy-resume' } }, { frameId: 0 }); })()`);
    await waitFor(() => page.evaluate("document.querySelector('#name')?.value === '测试用户'"), '本地填写首项');
    await page.evaluate("Array.from(document.querySelector('[data-job-applymate-task]').shadowRoot.querySelectorAll('button')).find(button => button.textContent === '停止').click()");
    await delay(1300);
    const snapshot = await page.evaluate("({ ...window.formFixture.snapshot(), files: document.querySelector('#resume').files.length })");
    assert.equal(snapshot.state.name, '测试用户'); assert.equal(snapshot.state.email || '', ''); assert.equal(snapshot.files, 0);
    modelDelay = 0;
  });
  await check('所选附件独立上传，仍使用通用资料', async () => {
    await prepareExtension('ai-cancel'); modelRequests = [];
    await background.evaluate(`(async () => { const tab = (await chrome.tabs.query({ url: ${JSON.stringify(fixtureUrl + '*')} }))[0]; return chrome.tabs.sendMessage(tab.id, { type: 'START_FILL_SESSION', payload: { sourceId: 'default', attachmentId: 'legacy-resume' } }, { frameId: 0 }); })()`);
    await waitFor(() => page.evaluate("document.querySelector('[data-job-applymate-task]')?.shadowRoot?.textContent.includes('已填写')"), '含附件填写完成', 30000);
    assert.equal(await page.evaluate("document.querySelector('#resume').files[0]?.name"), 'cancel.pdf');
    assert.equal((await page.evaluate('window.formFixture.snapshot()')).state.name, '测试用户');
    assert.equal(modelRequests.length, 0);
  });
  await check('跨 frame 共用单个任务面板并优先规则填写', async () => {
    await prepareExtension('react-text'); modelRequests = [];
    await page.evaluate(`(() => { const frame = document.createElement('iframe'); frame.src = ${JSON.stringify(fixtureUrl + '?scenario=react-text')}; document.body.append(frame); })()`);
    await waitFor(() => page.evaluate("Boolean(document.querySelector('iframe').contentWindow.formFixture)"), '子框架加载');
    await background.evaluate(`(async () => { const tab = (await chrome.tabs.query({ url: ${JSON.stringify(fixtureUrl + '*')} }))[0]; return chrome.tabs.sendMessage(tab.id, { type: 'START_FILL_SESSION', payload: { sourceId: 'default' } }, { frameId: 0 }); })()`);
    await waitFor(() => page.evaluate("document.querySelector('[data-job-applymate-task]')?.shadowRoot?.textContent.includes('已填写 2 项')"), '跨框架填写', 30000);
    assert.equal(await page.evaluate("document.querySelector('iframe').contentDocument.querySelectorAll('[data-job-applymate-task]').length"), 0);
    assert.equal(await page.evaluate("document.querySelector('iframe').contentWindow.formFixture.snapshot().state.name"), '测试用户');
  });
  for (const [scenario, key, expected] of [['existing-text', 'name', '用户原有姓名'], ['existing-radio', 'gender', 'f']]) {
    await check(`模型主路径保留原有答案：${scenario}`, async () => {
      const { response, snapshot } = await extensionFill(scenario);
      assert.equal(snapshot.state[key], expected);
      assert.equal(response.data.verifiedCount, 0);
      assert.match(response.data.panel, /保留原值 1/);
    });
  }
  await check('模型等待期间的用户编辑保持原样', async () => {
    await prepareExtension('react-text'); await makeNameUnknown(); modelRequests = []; modelDelay = 500;
    await background.evaluate(`(async () => { const tab = (await chrome.tabs.query({ url: ${JSON.stringify(fixtureUrl + '*')} }))[0]; return chrome.tabs.sendMessage(tab.id, { type: 'START_FILL_SESSION', payload: { sourceId: 'default' } }, { frameId: 0 }); })()`);
    await waitFor(() => modelRequests.length > 0, '模型请求开始');
    await page.evaluate("document.querySelector('#answer').focus()");
    await page.send('Input.insertText', { text: '用户决定保留的姓名' });
    await waitFor(() => page.evaluate("document.querySelector('[data-job-applymate-task]')?.shadowRoot?.textContent.includes('已填写')"), '保留用户编辑');
    assert.equal((await page.evaluate('window.formFixture.snapshot()')).state.name, '用户决定保留的姓名');
    assert.match(await page.evaluate("document.querySelector('[data-job-applymate-task]').shadowRoot.textContent"), /已填写 0 项/);
    modelDelay = 0;
    const screenshot = await page.send('Page.captureScreenshot', { format: 'png' });
    writeFileSync('/tmp/job-applymate-task-panel.png', Buffer.from(screenshot.data, 'base64'));
  });
  await check('模型兜底只接收剩余字段，失败后继续下一模块', async () => {
    await prepareExtension('react-text'); modelRequests = []; modelMode = 'fail-first';
    await page.evaluate(`(() => {
      for (const id of ['a', 'b']) {
        const group = document.createElement('fieldset'); const legend = document.createElement('legend'); legend.textContent = '模块 ' + id; group.append(legend);
        const label = document.createElement('label'); label.htmlFor = id; label.textContent = '怎么称呼你'; group.append(label);
        const input = document.createElement('input'); input.id = id; group.append(input); document.querySelector('form').append(group);
      }
    })()`);
    await background.evaluate(`(async () => { const tab = (await chrome.tabs.query({ url: ${JSON.stringify(fixtureUrl + '*')} }))[0]; return chrome.tabs.sendMessage(tab.id, { type: 'START_FILL_SESSION', payload: { sourceId: 'default' } }, { frameId: 0 }); })()`);
    await waitFor(() => page.evaluate("document.querySelector('[data-job-applymate-task]')?.shadowRoot?.textContent.includes('已填写 2 项，1 项需处理')"), '失败模块后的其他模块完成', 30000);
    assert.equal(await page.evaluate("document.querySelector('#name').value"), '测试用户');
    assert.equal(await page.evaluate("document.querySelector('#a').value"), '');
    assert.equal(await page.evaluate("document.querySelector('#b').value"), '测试用户');
    assert(modelRequests.every(request => request.fields.every(field => field.label === '怎么称呼你')));
    assert.equal(modelRequests.length, 2);
    modelMode = 'normal';
  });
  await check('补充个人资料后跨网站复用，没提供的字段保持空白', async () => {
    await prepareExtension('personal-extra'); modelRequests = []; modelMode = 'normal';
    const start = async (url = fixtureUrl) => background.evaluate(`(async () => { const tab = (await chrome.tabs.query({ url: ${JSON.stringify(url + '*')} }))[0]; return chrome.tabs.sendMessage(tab.id, { type: 'START_FILL_SESSION', payload: { sourceId: 'default' } }, { frameId: 0 }); })()`);
    await start();
    await waitFor(() => page.evaluate("document.querySelector('[data-job-applymate-task]')?.shadowRoot?.textContent.includes('已填写 1 项，0 项需处理')"), '缺资料留空', 30000);
    assert.equal(await page.evaluate("document.querySelector('#age').value"), '');
    assert.equal(await page.evaluate("document.querySelector('#preferredCities').value"), '');
    assert.equal(modelRequests.length, 1, '已知且缺失的个人字段不应请求模型，只有未知推荐方式需要匹配');
    const panelText = await page.evaluate("document.querySelector('[data-job-applymate-task]').shadowRoot.textContent");
    assert.match(panelText, /无资料留空 5/);
    assert.doesNotMatch(panelText, /本网站|registry/);
    await page.evaluate("Array.from(document.querySelector('[data-job-applymate-task]').shadowRoot.querySelectorAll('button')).find(button => button.textContent === '补充个人资料（可选）').click()");
    const saveFromPanel = async (label, value, stateKey) => {
      await page.evaluate(`(() => { const root = document.querySelector('[data-job-applymate-task]').shadowRoot; const select = root.querySelector('[aria-label="待处理队列"]'); select.value = Array.from(select.options).find(option => option.textContent.includes(${JSON.stringify(" · " + label)})).value; select.dispatchEvent(new Event('change')); })()`);
      await page.evaluate(`(() => { const root = document.querySelector('[data-job-applymate-task]').shadowRoot; const answer = root.querySelector('[aria-label="补充个人资料"]'); answer.value = ${JSON.stringify(value)}; answer.dispatchEvent(new Event('input')); Array.from(root.querySelectorAll('button')).find(button => button.textContent === '保存并填写').click(); })()`);
      await waitFor(() => page.evaluate(`window.formFixture.snapshot().state[${JSON.stringify(stateKey)}] === ${JSON.stringify(value)}`), '保存并填写 ' + label).catch(async error => { console.error(JSON.stringify(await page.evaluate("({ panel: document.querySelector('[data-job-applymate-task]').shadowRoot.textContent, state: window.formFixture.snapshot(), radios: Array.from(document.querySelectorAll('input[type=radio]')).map(input => ({ id: input.id, checked: input.checked, value: input.value })) })"))); console.error(JSON.stringify(await background.evaluate("chrome.storage.local.get('userProfile')"))); throw error; });
      await waitFor(() => page.evaluate("!Array.from(document.querySelector('[data-job-applymate-task]').shadowRoot.querySelectorAll('button')).find(button => button.textContent === '停止')"), '手动填写完成');
    };
    await saveFromPanel('年龄', '26', 'age');
    await saveFromPanel('作品集链接', 'https://portfolio.example/me', 'portfolioUrl');
    await saveFromPanel('推荐方式', '内推', 'referral');
    const stored = await background.evaluate("chrome.storage.local.get('userProfile').then(result => result.userProfile)");
    assert.equal(stored.personal.age, '26'); assert.equal(stored.personal.portfolioUrl, 'https://portfolio.example/me');
    assert.equal(stored.personal.additionalFields[0].label, '推荐方式');
    assert.equal(stored.personal.additionalFields[0].value, '内推');
    assert(!('origin' in stored.personal.additionalFields[0]));
    assert.equal(stored.personal.preferredCities, undefined);
    const secondOrigin = fixtureUrl.replace('127.0.0.1', 'localhost');
    await page.send('Page.navigate', { url: secondOrigin + '?scenario=personal-extra' });
    await waitFor(() => page.evaluate('Boolean(window.formFixture)'), '第二个网站加载');
    await waitFor(() => background.evaluate(`(async () => { const tab = (await chrome.tabs.query({ url: ${JSON.stringify(secondOrigin + '*')} }))[0]; return tab?.id && (await chrome.tabs.sendMessage(tab.id, { type: 'PING_CONTENT' }, { frameId: 0 }))?.success; })()`), '第二个网站连接');
    modelRequests = []; await start(secondOrigin);
    await waitFor(() => page.evaluate("document.querySelector('[data-job-applymate-task]')?.shadowRoot?.textContent.includes('已填写 4 项，0 项需处理')"), '跨网站自动复用', 30000);
    assert.equal(modelRequests.length, 0);
    assert.equal(await page.evaluate("document.querySelector('#age').value"), '26');
    assert.equal(await page.evaluate("window.formFixture.snapshot().state.referral"), '内推');
    assert.equal(await page.evaluate("document.querySelector('#languageSkills').value"), '');
    await page.evaluate("Array.from(document.querySelector('[data-job-applymate-task]').shadowRoot.querySelectorAll('button')).find(button => button.textContent === '补充个人资料（可选）').click()");
    const screenshot = await page.send('Page.captureScreenshot', { format: 'png' });
    writeFileSync('/tmp/job-applymate-personal-supplement.png', Buffer.from(screenshot.data, 'base64'));
    // Two pages can add different global fields concurrently without overwriting each other.
    const results = await background.evaluate(`(async () => { const tab = (await chrome.tabs.query({ url: ${JSON.stringify(secondOrigin + '*')} }))[0]; return chrome.scripting.executeScript({ target: { tabId: tab.id }, func: async () => Promise.all([
      chrome.runtime.sendMessage({ type: 'SAVE_PERSONAL_FIELD', payload: { label: '期望城市', value: '上海', expectedValue: '' } }),
      chrome.runtime.sendMessage({ type: 'SAVE_PERSONAL_FIELD', payload: { label: '语言能力', value: '英语 CET-6', expectedValue: '' } })
    ]) }); })()`);
    assert(results[0].result.every(result => result.success));
    const concurrent = await background.evaluate("chrome.storage.local.get('userProfile').then(result => result.userProfile.personal)");
    assert.equal(concurrent.preferredCities, '上海'); assert.equal(concurrent.languageSkills, '英语 CET-6');
  });
  const exceptions = page.events.filter(event => event.method === 'Runtime.exceptionThrown');
  assert.equal(exceptions.length, 0, JSON.stringify(exceptions));
  console.log(`\n浏览器回归完成：${passed} 通过，${failed.length} 失败。仅使用本地测试页面，未投递申请。`);
  if (failed.length) process.exitCode = 1;
} catch (error) {
  console.error(error.stack || error.message);
  if (browser) console.error(browser.diagnostics());
  process.exitCode = 1;
} finally {
  background?.close();
  page?.close();
  if (browser) await browser.close();
  await new Promise(resolve => fixtureServer.close(resolve));
  rmSync(fixtureDir, { recursive: true, force: true });
}
