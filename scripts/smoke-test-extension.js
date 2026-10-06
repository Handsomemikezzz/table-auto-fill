import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { resolve } from 'node:path';
import { connectCdp, launchTestBrowser, waitFor } from './browser-test-utils.js';

const networkRequests = [];
const server = createServer((request, response) => {
  if (request.method !== 'GET') { networkRequests.push(request.url); response.writeHead(410).end(); return; }
  response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  response.end(request.url === '/frame'
    ? '<!doctype html><html><body><label for="email">邮箱</label><input id="email" name="email" type="email"></body></html>'
    : '<!doctype html><html><body><label for="name">姓名</label><input id="name" name="name"><label for="gender">性别</label><select id="gender" name="gender"><option value="">请选择</option><option value="m">男</option><option value="f">女</option></select><label for="unknown">其他必答题</label><input id="unknown" name="answer"><iframe src="/frame"></iframe></body></html>');
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const url = `http://127.0.0.1:${server.address().port}/`;
let browser;
const connections = [];
try {
  browser = await launchTestBrowser(resolve('dist'), url);
  const workerTarget = await waitFor(async () => (await browser.targets()).find(target => target.type === 'service_worker' && target.url.endsWith('/background.js')), '扩展后台');
  const background = await connectCdp(workerTarget.webSocketDebuggerUrl); connections.push(background);
  await background.send('Runtime.enable');
  await waitFor(() => background.evaluate('Boolean(globalThis.chrome?.storage?.local)'), '扩展 API');
  await background.evaluate(`chrome.storage.local.set({ userProfile: {
    personal: { name: '测试用户', gender: '男', birthDate: '', phone: '', email: 'local@example.com' },
    education: [], experience: [], projects: [], skills: [], certifications: [], customInformation: []
  }, llmConfig: { provider: 'custom', model: 'retired', baseUrl: '${url}v1', apiKey: 'retired-key' } })`);
  const target = await waitFor(async () => (await browser.targets()).find(target => target.type === 'page' && target.url === url), '测试页面');
  const page = await connectCdp(target.webSocketDebuggerUrl); connections.push(page); await page.send('Runtime.enable');
  await waitFor(() => background.evaluate(`(async () => {
    const tab = (await chrome.tabs.query({ url: '${url}' }))[0];
    return tab?.id && (await chrome.tabs.sendMessage(tab.id, { type: 'PING_CONTENT' }, { frameId: 0 })).success;
  })()`), 'DOM 填写器初始化');
  await waitFor(() => page.evaluate("Boolean(document.querySelector('iframe').contentDocument.querySelector('#email'))"), 'iframe');
  await background.evaluate(`(async () => {
    const tab = (await chrome.tabs.query({ url: '${url}' }))[0];
    return chrome.tabs.sendMessage(tab.id, { type: 'START_FILL_SESSION', payload: { sourceId: 'default' } }, { frameId: 0 });
  })()`);
  const result = await waitFor(() => background.evaluate(`(async () => {
    const tab = (await chrome.tabs.query({ url: '${url}' }))[0];
    const response = await chrome.tabs.sendMessage(tab.id, { type: 'GET_FILL_SESSION_RESULT' }, { frameId: 0 });
    return response.data?.result?.settled && response.data.result;
  })()`), '规则填写完成', 30000);
  assert.equal(result.counts.verified, 3); assert.equal(result.counts.todo, 1);
  const values = await page.evaluate("({ name: document.querySelector('#name').value, gender: document.querySelector('#gender').value, unknown: document.querySelector('#unknown').value, email: document.querySelector('iframe').contentDocument.querySelector('#email').value, panels: document.querySelectorAll('[data-job-applymate-task]').length })");
  assert.deepEqual(values, { name: '测试用户', gender: 'm', unknown: '', email: 'local@example.com', panels: 1 });
  console.log('✓ DOM 识别、本地规则、编码下拉和 iframe 填写，未知字段保持空白');
  await background.evaluate('chrome.runtime.openOptionsPage()');
  const optionsTarget = await waitFor(async () => (await browser.targets()).find(target => target.type === 'page' && target.url.includes('/src/options/index.html')), '设置页面');
  const options = await connectCdp(optionsTarget.webSocketDebuggerUrl); connections.push(options); await options.send('Runtime.enable');
  await waitFor(() => options.evaluate("Boolean(document.querySelector('#personal-name'))"), '资料表单');
  assert.equal(await options.evaluate("Boolean(document.querySelector('#profile-ai')) || /模型设置|API Key/.test(document.body.innerText)"), false);
  const responses = await options.evaluate(`(async () => {
    const removed = [];
    for (const type of ['GET_LLM_CONFIG', 'SAVE_LLM_CONFIG', 'TEST_LLM_CONNECTION', 'GENERATE_ANSWER', 'MATCH_FIELDS_LLM', 'AI_FILL_SECTION', 'AI_FILL_VISUAL_REGION', 'DECIDE_FILL_FIELDS']) removed.push(await chrome.runtime.sendMessage({ type, payload: {} }));
    const backup = await chrome.runtime.sendMessage({ type: 'EXPORT_BACKUP' });
    const legacy = JSON.parse(backup.data.json); legacy.data.llmConfig = { apiKey: 'retired-key' };
    const imported = await chrome.runtime.sendMessage({ type: 'IMPORT_BACKUP', payload: { json: JSON.stringify(legacy) } });
    return { removed, backup, imported };
  })()`);
  assert(responses.removed.every(response => response.success === false));
  assert.equal(responses.backup.success, true); assert.equal(responses.imported.success, true);
  assert.doesNotMatch(responses.backup.data.json, /llmConfig|retired-key/);
  assert.equal(networkRequests.length, 0);
  console.log('✓ 模型设置和旧消息接口已移除；本地备份忽略旧凭据，填写未请求模型');
  // Restart the isolated extension to exercise cleanup of credentials persisted by an older version.
  await background.evaluate('setTimeout(() => chrome.runtime.reload(), 100); true');
  const restartedTarget = await waitFor(async () => (await browser.targets()).find(target => target.type === 'service_worker' && target.id !== workerTarget.id && target.url.endsWith('/background.js')), '扩展重启');
  const restarted = await connectCdp(restartedTarget.webSocketDebuggerUrl); connections.push(restarted); await restarted.send('Runtime.enable');
  await waitFor(() => restarted.evaluate('Boolean(globalThis.chrome?.storage?.local)'), '重启后的扩展 API');
  const stored = await waitFor(async () => {
    const values = await restarted.evaluate('chrome.storage.local.get(null)');
    return !('llmConfig' in values) && values;
  }, '旧模型配置清理');
  assert.equal(stored.userProfile.personal.name, '测试用户');
  console.log('✓ 扩展启动清理旧 API Key，并保留个人资料');
} finally {
  for (const connection of connections) connection.close();
  if (browser) await browser.close();
  await new Promise(resolve => server.close(resolve));
}
