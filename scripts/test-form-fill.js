import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
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
const fixtureServer = createServer((request, response) => {
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
    await chrome.storage.local.set({ userProfile: ${JSON.stringify(fixtureProfile)} });
  })()`);
}
async function extensionFill(scenario) {
  await prepareExtension(scenario);
  const response = await background.evaluate(`(async () => {
    const tab = (await chrome.tabs.query({ url: ${JSON.stringify(fixtureUrl + '*')} }))[0];
    const detection = await chrome.tabs.sendMessage(tab.id, { type: 'DETECT_FIELDS' }, { frameId: 0 });
    const response = await chrome.tabs.sendMessage(tab.id, { type: 'FILL_FORM', payload: { resumeId: null } }, { frameId: 0 });
    return { ...response, testDetection: detection };
  })()`, 60_000);
  assert.equal(response.success, true, JSON.stringify(response));
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
    ['cascader', 'region', '四川省 / 成都市 / 武侯区'],
    ['ant-cascader', 'region', '四川省 / 成都市 / 武侯区'],
  ]) {
    await check(`扩展 FILL_FORM：${scenario}`, async () => {
      const { response, snapshot } = await extensionFill(scenario);
      if (snapshot.state[key] !== value) console.error(JSON.stringify(await page.evaluate('window.formFixture.diagnose()')));
      assert.equal(snapshot.state[key], value, JSON.stringify({ response, snapshot }));
      assert.equal(response.data?.verifiedCount, 1, JSON.stringify(response));
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
  await check('扩展 AI 页填本地阶段终止后不再填写后续字段或上传附件', async () => {
    await prepareExtension('ai-cancel');
    const started = await background.evaluate(`(async () => {
      const tab = (await chrome.tabs.query({ url: ${JSON.stringify(fixtureUrl + '*')} }))[0];
      return chrome.tabs.sendMessage(tab.id, { type: 'START_AI_PAGE_FILL' }, { frameId: 0 });
    })()`);
    assert.equal(started.success, true);
    await waitFor(() => page.evaluate("Boolean(document.querySelector('#name')?.value)"), 'AI 本地阶段开始填写第一项');
    await page.evaluate("Array.from(document.querySelectorAll('button')).find(button => button.textContent === '终止')?.click()");
    await waitFor(() => page.evaluate("document.body.innerText.includes('AI 扫描填充已终止')"), 'AI 终止状态');
    await delay(700);
    const snapshot = await page.evaluate("({ ...window.formFixture.snapshot(), files: document.querySelector('#resume').files.length })");
    assert.equal(snapshot.state.email ?? '', '', JSON.stringify(snapshot));
    assert.equal(snapshot.files, 0, JSON.stringify(snapshot));
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
