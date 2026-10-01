import { createCanvas, loadImage } from 'canvas';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { deflateSync } from 'node:zlib';
import { connectCdp, launchTestBrowser, waitFor, delay } from './browser-test-utils.js';

const temp = mkdtempSync(join(tmpdir(), 'job-applymate-import-'));
let requests = [], modelDelay = 0, researchOnly = false;
const server = createServer(async (request, response) => {
  if (request.url !== '/v1/chat/completions') { response.writeHead(200, { 'Content-Type': 'text/html' }); response.end('<!doctype html><html><body>Local resume test</body></html>'); return; }
  let body = ''; for await (const chunk of request) body += chunk;
  const input = JSON.parse(body); requests.push(input);
  if (modelDelay) await delay(modelDelay);
  const data = { personal: { name: 'Alex Example', phone: '13800138000', email: 'alex@example.com', portfolioUrl: 'https://example.com' }, education: [{ school: 'Test University', degree: '本科', major: 'Computer Science', startDate: '2018-09', endDate: '2022-06' }], experience: [], projects: [], skills: ['TypeScript', 'React'], awards: [{ name: 'National Scholarship', date: '2023' }], publications: [{ title: 'Example Paper', authors: 'Alex Example', status: 'Accepted', date: '2024' }], languages: [{ language: 'English', test: 'IELTS', score: '7.5', date: '2024-06' }], certifications: [{ name: 'Teaching Certificate', issuer: 'Test Office', date: '2024', credentialId: '00123' }], patents: [{ name: 'Example Patent', patentNumber: 'CN001', status: 'Pending' }], activities: [{ organization: 'Volunteer Club', role: 'Volunteer', startDate: '2022' }], additionalInfo: [{ name: 'Driving license', content: 'C1' }] };
  const result = researchOnly ? { personal: {}, projects: [{ name: 'Mixed Research', description: input.messages.at(-1).content }], publications: [] } : data;
  response.writeHead(200, { 'Content-Type': 'application/json' });
  response.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(result) }, finish_reason: 'stop' }] }));
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
let browser, page;
function pdfFile(objects) {
  let body = Buffer.from('%PDF-1.4\n'); const offsets = [0];
  objects.forEach((object, index) => { offsets.push(body.length); body = Buffer.concat([body, Buffer.from(`${index + 1} 0 obj\n`), Buffer.isBuffer(object) ? object : Buffer.from(object), Buffer.from('\nendobj\n')]); });
  const xref = body.length;
  const table = `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.slice(1).map(offset => String(offset).padStart(10, '0') + ' 00000 n \n').join('')}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return Buffer.concat([body, Buffer.from(table)]);
}
const snapshot = () => page.evaluate("({ title: document.querySelector('[role=dialog] h2')?.textContent, name: document.querySelector('[aria-label=姓名]')?.value, email: document.querySelector('[aria-label=邮箱]')?.value, text: document.body.textContent })");
async function upload(path) {
  const { root } = await page.send('DOM.getDocument');
  const { nodeId } = await page.send('DOM.querySelector', { nodeId: root.nodeId, selector: 'input[type=file]' });
  await page.send('DOM.setFileInputFiles', { nodeId, files: [path] });
}
const click = text => page.evaluate(`Array.from(document.querySelectorAll('button')).find(button => button.textContent.trim() === ${JSON.stringify(text)}).click()`);
const stored = () => page.evaluate("chrome.storage.local.get('userProfile').then(result => result.userProfile)");
try {
  browser = await launchTestBrowser(resolve('dist'), origin);
  const worker = await waitFor(async () => (await browser.targets()).find(target => target.type === 'service_worker' && target.url.endsWith('background.js')), 'background');

  const target = await waitFor(async () => (await browser.targets()).find(target => target.type === 'page' && target.url.startsWith(origin)), 'local page');
  page = await connectCdp(target.webSocketDebuggerUrl); await page.send('Runtime.enable');
  const graphic = await page.evaluate(`(() => {
    const canvas = document.createElement('canvas'); canvas.width = 1800; canvas.height = 1800;
    const ctx = canvas.getContext('2d'); ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, 1800, 1800); ctx.fillStyle = '#111'; ctx.font = '48px Arial';
    ['RESUME', 'Alex Example', 'Phone: 13800138000', 'Email: alex@example.com', 'Education: Test University', 'Bachelor Computer Science 2018-09 - 2022-06', 'Skills: TypeScript React', 'Website: https://example.com', '姓名与联系方式请核对', 'Award: National Scholarship 2023', 'Publication: Example Paper Accepted 2024', 'Language: English IELTS 7.5 2024-06', 'Teaching Certificate Test Office 00123', 'Patent: Example Patent CN001 Pending', 'Volunteer Club 2022', 'Driving license C1'].forEach((line, i) => ctx.fillText(line, 60, 100 + i * 100));
    return { png: canvas.toDataURL('image/png') };
  })()`);
  const png = join(temp, 'synthetic-resume.png'); writeFileSync(png, Buffer.from(graphic.png.split(',')[1], 'base64'));
  const bitmap = await loadImage(Buffer.from(graphic.png.split(',')[1], 'base64'));
  const raster = createCanvas(bitmap.width, bitmap.height); raster.getContext('2d').drawImage(bitmap, 0, 0);
  const rgba = raster.getContext('2d').getImageData(0, 0, bitmap.width, bitmap.height).data; const rgb = Buffer.alloc(bitmap.width * bitmap.height * 3);
  for (let src = 0, dest = 0; src < rgba.length; src += 4) { rgb[dest++] = rgba[src]; rgb[dest++] = rgba[src + 1]; rgb[dest++] = rgba[src + 2]; }
  const image = deflateSync(rgb);
  const command = 'q 600 0 0 400 0 0 cm /Img Do Q';
  const scanned = join(temp, 'synthetic-scanned.pdf');
  writeFileSync(scanned, pdfFile(['<< /Type /Catalog /Pages 2 0 R >>','<< /Type /Pages /Kids [3 0 R] /Count 1 >>','<< /Type /Page /Parent 2 0 R /MediaBox [0 0 600 400] /Resources << /XObject << /Img 4 0 R >> >> /Contents 5 0 R >>', Buffer.concat([Buffer.from(`<< /Type /XObject /Subtype /Image /Width 1800 /Height 1200 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /FlateDecode /Length ${image.length} >>\nstream\n`), image, Buffer.from('\nendstream')]),`<< /Length ${command.length} >>\nstream\n${command}\nendstream`]));
  const textCommand = 'BT /F1 18 Tf 30 550 Td (RESUME Alex Example Phone 13800138000) Tj 0 -30 Td (Email alex@example.com Test University Computer Science) Tj 0 -30 Td (Bachelor 2018-09 - 2022-06 TypeScript React) Tj ET';
  const native = join(temp, 'synthetic-text.pdf');
  writeFileSync(native, pdfFile(['<< /Type /Catalog /Pages 2 0 R >>','<< /Type /Pages /Kids [3 0 R] /Count 1 >>','<< /Type /Page /Parent 2 0 R /MediaBox [0 0 600 600] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>','<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',`<< /Length ${textCommand.length} >>\nstream\n${textCommand}\nendstream`]));
  const id = worker.url.split('/')[2];
  await page.send('Page.navigate', { url: `chrome-extension://${id}/src/options/index.html?tab=resume` });
  await waitFor(() => page.evaluate("Boolean(document.querySelector('input[type=file]'))"), 'options mounted');
  await page.evaluate(`chrome.storage.local.set({ userProfile: { personal: { name: '', phone: '', email: '', birthDate: '', gender: '' }, education: [], experience: [], projects: [], skills: [], certifications: [], customInformation: [] }, llmConfig: { provider: 'custom', model: 'import-fixture', apiKey: 'local-fixture', baseUrl: ${JSON.stringify(origin + '/v1')} } })`);
  await upload(png);
  await waitFor(() => page.evaluate("document.querySelector('[role=dialog] h2')?.textContent.includes('预填写')"), 'image OCR and LLM review', 60000);
  assert.equal((await snapshot()).name, 'Alex Example'); assert.equal((await stored()).personal.name, '');
  assert(requests[0].messages.at(-1).content.toLowerCase().replace(/\s/g, '').includes('alex@example.com'), 'real OCR text must reach the model');
  assert.equal((await stored()).resumes.length, 1);
  console.log('✓ 本地中英文 OCR → 模型整理 → 预填写；确认前不覆盖个人资料');
  await page.evaluate("document.querySelector('[aria-label=邮箱]').focus(); document.querySelector('[aria-label=邮箱]').select()");
  await page.send('Input.insertText', { text: 'reviewed@example.com' });
  await page.evaluate("document.querySelector('[aria-label=languages-1-成绩]').closest('.resume-review-record').open = true; document.querySelector('[aria-label=languages-1-成绩]').focus(); document.querySelector('[aria-label=languages-1-成绩]').select()");
  await page.send('Input.insertText', { text: '8.0' });
  await click('暂存草稿'); await click('继续核对资料');
  assert.equal(await page.evaluate("document.querySelector('[aria-label=languages-1-成绩]').value"), '8.0');
  assert.equal((await snapshot()).email, 'reviewed@example.com');
  console.log('✓ 暂存、重新打开保留用户修正');
  const firstShot = await page.send('Page.captureScreenshot', { format: 'png' }); writeFileSync(resolve('docs/verification/2026-10-01-resume-review.png'), Buffer.from(firstShot.data, 'base64'));
  await click('确认并保存资料');
  await waitFor(async () => (await stored()).personal.email === 'reviewed@example.com', 'save reviewed profile');
  assert.equal((await stored()).resumes.length, 1); assert.equal((await stored()).resumes[0].parsedProfile.personal.email, 'reviewed@example.com');
  const saved = await stored();
  assert.equal(saved.languages[0].score, '8.0'); assert.equal(saved.resumes[0].parsedProfile.languages[0].score, '8.0');
  for (const collection of ['awards', 'publications', 'certifications', 'patents', 'activities', 'additionalInfo']) { assert.equal(saved[collection].length, 1, collection); assert.equal(saved.resumes[0].parsedProfile[collection].length, 1, collection); }
  await waitFor(() => page.evaluate("!document.querySelector('[role=dialog]') && !document.querySelector('input[type=file]').disabled"), 'review save settled');
  console.log('✓ 确认保存保留附件，并更新所选简历的已确认资料');
  await upload(scanned);
  await waitFor(() => page.evaluate("Boolean(document.querySelector('[role=dialog]'))"), 'scanned PDF OCR', 60000);
  assert.equal((await snapshot()).email, 'reviewed@example.com'); assert((await snapshot()).text.includes('含扫描文字识别'));
  const screenshot = await page.send('Page.captureScreenshot', { format: 'png' }); writeFileSync(resolve('docs/verification/2026-10-01-resume-review.png'), Buffer.from(screenshot.data, 'base64'));
  console.log('✓ 真实图片型 PDF 通过本地 OCR；冲突字段默认保留已确认值');
  await page.send('Emulation.setDeviceMetricsOverride', { width: 375, height: 812, deviceScaleFactor: 1, mobile: false });
  assert(await page.evaluate("document.querySelector('[role=dialog]').getBoundingClientRect().width <= 355 && document.querySelector('[role=dialog]').scrollWidth <= 355"), '375px review must not overflow');
  await page.send('Emulation.clearDeviceMetricsOverride');
  console.log('✓ 375px 核对界面无横向溢出');
  await click('暂存草稿');
  await upload(native); await waitFor(() => page.evaluate("Boolean(document.querySelector('[role=dialog]'))"), 'native PDF fast path', 60000);
  assert(!(await snapshot()).text.includes('含扫描文字识别'));
  console.log('✓ 文字型 PDF 不做重复 OCR');
  await click('暂存草稿');
  const beforeCancel = (await stored()).resumes.length;
  const requestCount = requests.length; modelDelay = 2500;
  await upload(png); await waitFor(() => requests.length > requestCount, 'model processing');
  await click('停止识别'); await delay(3000);
  assert(!await page.evaluate("Boolean(document.querySelector('[role=dialog]'))")); assert.equal((await stored()).resumes.length, beforeCancel);
  console.log('✓ 停止模型整理后不弹出过期草稿、不新增简历');
  await page.evaluate("Array.from(document.querySelectorAll('.options-tab')).find(button => button.textContent.trim().startsWith('更多资料')).click()");
  assert.equal(await page.evaluate("document.querySelector('[aria-label=语言能力-1-成绩]').value"), '8.0');
  await click('添加获奖与荣誉');
  await page.evaluate("document.querySelector('[aria-label=获奖与荣誉-2-奖项名称]').focus()");
  await page.send('Input.insertText', { text: 'Manual Award' });
  await click('保存设置');
  await waitFor(async () => (await stored()).awards.length === 2, 'manual award saved');
  await page.send('Page.navigate', { url: `chrome-extension://${id}/src/options/index.html?tab=more` });
  await waitFor(() => page.evaluate("Boolean(document.querySelector('[aria-label=获奖与荣誉-2-奖项名称]'))"), 'saved facts reload');
  assert.equal(await page.evaluate("document.querySelector('[aria-label=获奖与荣誉-2-奖项名称]').value"), 'Manual Award');
  const shot = await page.send('Page.captureScreenshot', { format: 'png' }); writeFileSync(resolve('docs/verification/2026-10-01-supplemental-profile.png'), Buffer.from(shot.data, 'base64'));
  await page.evaluate("document.querySelector('[aria-label=获奖与荣誉-2-奖项名称]').closest('.resume-review-record').open = true; document.querySelector('[aria-label=获奖与荣誉-2-奖项名称]').closest('.resume-review-record').querySelector('button').click()");
  await click('保存设置');
  await waitFor(async () => (await stored()).awards.length === 1, 'manual award removed');
  console.log('✓ 获奖、论文、语言、证书等预填写，修正成绩后保存；手动添加、刷新与删除可用');
  modelDelay = 0; researchOnly = true;
  await page.evaluate("chrome.storage.local.set({ userProfile: { personal: { name: '', phone: '', email: '', birthDate: '', gender: '' }, education: [], experience: [], projects: [], skills: [], certifications: [], customInformation: [] } })");
  await page.send('Page.navigate', { url: `chrome-extension://${id}/src/options/index.html?tab=resume` });
  await waitFor(() => page.evaluate("Boolean(document.querySelector('input[type=file]'))"), 'research import options mounted');
  await upload(resolve('tests/resume-fixtures/mixed-research.txt'));
  await waitFor(() => page.evaluate("Boolean(document.querySelector('.resume-review-publication-candidates'))"), 'mixed research publication repair');
  assert.equal(await page.evaluate("document.querySelectorAll('[aria-label^=publications-][aria-label$=标题]').length"), 3);
  assert.equal(await page.evaluate("document.querySelectorAll('.resume-review-publication-candidates button').length"), 3);
  assert.equal((await stored()).publications?.length || 0, 0, 'candidate papers must not save without confirmation');
  await page.evaluate("document.querySelector('.resume-review-publication-candidates').scrollIntoView({block:'center'})");
  const researchShot = await page.send('Page.captureScreenshot', { format: 'png' }); writeFileSync(resolve('docs/verification/2026-10-01-publication-review.png'), Buffer.from(researchShot.data, 'base64'));
  await click('加入论文与著作');
  assert.equal(await page.evaluate("document.querySelectorAll('.resume-review-publication-candidates button').length"), 2);
  await click('暂存草稿'); await click('继续核对资料');
  assert.equal(await page.evaluate("document.querySelectorAll('[aria-label^=publications-][aria-label$=标题]').length"), 4);
  await click('确认并保存资料');
  await waitFor(async () => (await stored()).publications?.length === 4, 'reviewed research papers saved');
  const researchSaved = await stored();
  assert.equal(researchSaved.resumes[0].parsedProfile.publications.length, 4);
  assert(researchSaved.publications.every(row => !row.status && !row.date));
  assert(!researchSaved.publications.some(row => row.title.startsWith('SavorLink')));
  console.log('✓ 项目章节内论文遗漏自动补齐，会议线索手动加入、暂存及保存；未确认条目不变成论文事实');
  const errors = page.events.filter(event => event.method === 'Runtime.exceptionThrown'); assert.equal(errors.length, 0, JSON.stringify(errors));
  console.log('简历导入浏览器验证完成。使用真实本地 OCR、合成文件和本地模型替身，无真实简历外发。');
} catch (error) {
  if (page) console.error(JSON.stringify(page.events.filter(event => event.method === 'Runtime.consoleAPICalled').map(event => event.params.args.map(arg => arg.value).filter(value => typeof value === 'string' && /OCR|PDF|Error|worker/i.test(value))).filter(args => args.length).slice(-18)));
  if (page) console.error(JSON.stringify(await page.evaluate("({ progress: document.querySelector('[aria-label=简历识别进度]')?.textContent, notice: document.querySelector('.resume-notice')?.textContent })")));
  throw error;
} finally {
  page?.close(); if (browser) await browser.close();
  await new Promise(resolve => server.close(resolve)); rmSync(temp, { recursive: true, force: true });
}
