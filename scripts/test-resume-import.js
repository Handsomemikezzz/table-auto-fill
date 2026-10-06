import assert from 'node:assert/strict';
import { createCanvas, loadImage } from 'canvas';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { deflateSync } from 'node:zlib';
import { connectCdp, launchTestBrowser, waitFor, delay } from './browser-test-utils.js';

const temp = mkdtempSync(join(tmpdir(), 'job-applymate-import-'));
const externalRequests = [];
const server = createServer((request, response) => {
  if (request.method !== 'GET') { externalRequests.push(request.url); response.writeHead(410).end(); return; }
  response.writeHead(200, { 'Content-Type': 'text/html' }); response.end('<!doctype html><html><body>Local resume test</body></html>');
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
let browser, page;
function pdfFile(objects) {
  let body = Buffer.from('%PDF-1.4\n'); const offsets = [0];
  objects.forEach((object, index) => { offsets.push(body.length); body = Buffer.concat([body, Buffer.from(`${index + 1} 0 obj\n`), Buffer.isBuffer(object) ? object : Buffer.from(object), Buffer.from('\nendobj\n')]); });
  const xref = body.length;
  return Buffer.concat([body, Buffer.from(`xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.slice(1).map(offset => String(offset).padStart(10, '0') + ' 00000 n \n').join('')}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`)]);
}
const click = text => page.evaluate(`Array.from(document.querySelectorAll('button')).find(button => button.textContent.trim() === ${JSON.stringify(text)}).click()`);
const stored = () => page.evaluate("chrome.storage.local.get('userProfile').then(result => result.userProfile)");
async function upload(path) {
  const { root } = await page.send('DOM.getDocument');
  const { nodeId } = await page.send('DOM.querySelector', { nodeId: root.nodeId, selector: 'input[type=file]' });
  await page.send('DOM.setFileInputFiles', { nodeId, files: [path] });
}
const waitReview = () => waitFor(() => page.evaluate("Boolean(document.querySelector('[role=dialog] h2'))"), '本地解析核对草稿', 60000);
try {
  browser = await launchTestBrowser(resolve('dist'), origin);
  const target = await waitFor(async () => (await browser.targets()).find(target => target.type === 'page' && target.url.startsWith(origin)), '测试页');
  page = await connectCdp(target.webSocketDebuggerUrl); await page.send('Runtime.enable');
  const graphic = await page.evaluate(`(() => {
    const canvas = document.createElement('canvas'); canvas.width = 1400; canvas.height = 700;
    const context = canvas.getContext('2d'); context.fillStyle = '#fff'; context.fillRect(0,0,1400,700); context.fillStyle = '#111'; context.font = '48px Arial';
    ['个人简历', '姓名：张三', '电话：13800138000', '邮箱：alex@example.com', '教育经历', '复旦大学 本科 软件工程 2018-09 - 2022-06', '技能：TypeScript React'].forEach((line, index) => context.fillText(line, 50, 90 + index * 85));
    return canvas.toDataURL('image/png');
  })()`);
  const png = join(temp, 'synthetic-resume.png'); writeFileSync(png, Buffer.from(graphic.split(',')[1], 'base64'));
  const bitmap = await loadImage(Buffer.from(graphic.split(',')[1], 'base64'));
  const raster = createCanvas(bitmap.width, bitmap.height); raster.getContext('2d').drawImage(bitmap,0,0);
  const rgba = raster.getContext('2d').getImageData(0,0,bitmap.width,bitmap.height).data;
  const rgb = Buffer.alloc(bitmap.width * bitmap.height * 3);
  for (let source = 0, destination = 0; source < rgba.length; source += 4) { rgb[destination++] = rgba[source]; rgb[destination++] = rgba[source + 1]; rgb[destination++] = rgba[source + 2]; }
  const image = deflateSync(rgb); const command = 'q 600 0 0 300 0 0 cm /Img Do Q';
  const scanned = join(temp, 'synthetic-scanned.pdf');
  writeFileSync(scanned, pdfFile(['<< /Type /Catalog /Pages 2 0 R >>','<< /Type /Pages /Kids [3 0 R] /Count 1 >>','<< /Type /Page /Parent 2 0 R /MediaBox [0 0 600 300] /Resources << /XObject << /Img 4 0 R >> >> /Contents 5 0 R >>', Buffer.concat([Buffer.from(`<< /Type /XObject /Subtype /Image /Width ${bitmap.width} /Height ${bitmap.height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /FlateDecode /Length ${image.length} >>\nstream\n`),image,Buffer.from('\nendstream')]),`<< /Length ${command.length} >>\nstream\n${command}\nendstream`]));
  const text = 'BT /F1 18 Tf 30 550 Td (Name: Alex Example) Tj 0 -30 Td (Phone: 13800138000) Tj 0 -30 Td (Email: alex@example.com) Tj 0 -30 Td (Education: Test University Computer Science Bachelor 2018-09 - 2022-06) Tj ET';
  const native = join(temp, 'synthetic-text.pdf');
  writeFileSync(native, pdfFile(['<< /Type /Catalog /Pages 2 0 R >>','<< /Type /Pages /Kids [3 0 R] /Count 1 >>','<< /Type /Page /Parent 2 0 R /MediaBox [0 0 600 600] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>','<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',`<< /Length ${text.length} >>\nstream\n${text}\nendstream`]));
  const worker = await waitFor(async () => (await browser.targets()).find(target => target.type === 'service_worker' && target.url.endsWith('background.js')), '后台');
  const id = worker.url.split('/')[2];
  await page.send('Page.navigate', { url: `chrome-extension://${id}/src/options/index.html?tab=resume` });
  await waitFor(() => page.evaluate("Boolean(document.querySelector('#personal-name'))"), '资料页');
  await page.evaluate(`chrome.storage.local.set({ userProfile: { personal: { name: '', phone: '', email: '', birthDate: '', gender: '' }, education: [], experience: [], projects: [], skills: [], certifications: [], customInformation: [] }, llmConfig: { provider: 'custom', model: 'retired', apiKey: 'retired-key', baseUrl: '${origin}/v1' } })`);
  await upload(png); await waitReview();
  assert.equal(await page.evaluate("document.querySelector('[aria-label=邮箱]').value"), 'alex@example.com');
  assert.equal((await stored()).personal.email, ''); assert.equal((await stored()).resumes.length,1);
  assert.equal(externalRequests.length,0);
  console.log('✓ 图片本地 OCR → 规则整理 → 核对草稿，确认前不覆盖个人资料且不请求模型');
  await page.evaluate("document.querySelector('[aria-label=邮箱]').focus(); document.querySelector('[aria-label=邮箱]').select()");
  await page.send('Input.insertText', { text: 'reviewed@example.com' });
  await click('暂存草稿'); await click('继续核对资料');
  assert.equal(await page.evaluate("document.querySelector('[aria-label=邮箱]').value"), 'reviewed@example.com');
  await click('确认并保存资料');
  await waitFor(async () => (await stored()).personal.email === 'reviewed@example.com', '保存确认结果');
  assert.equal((await stored()).resumes[0].parsedProfile.personal.email, 'reviewed@example.com');
  await waitFor(() => page.evaluate("!document.querySelector('[role=dialog]') && !document.querySelector('input[type=file]').disabled"), '保存完成');
  console.log('✓ 暂存与重新打开保留修改，保存同步更新该简历的资料快照');
  await upload(scanned); await waitReview();
  assert.equal(await page.evaluate("document.querySelector('[aria-label=邮箱]').value"), 'reviewed@example.com');
  assert(await page.evaluate("document.querySelector('[role=dialog]').textContent.includes('含扫描文字识别')"));
  await click('暂存草稿');
  await upload(native); await waitReview();
  assert(!await page.evaluate("document.querySelector('[role=dialog]').textContent.includes('含扫描文字识别')"));
  await page.send('Emulation.setDeviceMetricsOverride', { width: 375, height: 812, deviceScaleFactor:1, mobile:false });
  assert(await page.evaluate("document.querySelector('[role=dialog]').getBoundingClientRect().width <= 355 && document.querySelector('[role=dialog]').scrollWidth <= 355"));
  await page.send('Emulation.clearDeviceMetricsOverride'); await click('暂存草稿');
  console.log('✓ 扫描 PDF 使用本地 OCR，文字 PDF 直接提取，核对页小屏无溢出');
  const beforeCancel = (await stored()).resumes.length;
  await upload(png);
  await waitFor(() => page.evaluate("Array.from(document.querySelectorAll('button')).some(button => button.textContent.trim() === '停止识别')"), '识别中');
  await click('停止识别'); await delay(1000);
  assert(!await page.evaluate("Boolean(document.querySelector('[role=dialog]'))")); assert.equal((await stored()).resumes.length,beforeCancel);
  console.log('✓ 停止本地识别后不弹出过期草稿或新增简历');
  await upload(resolve('tests/resume-fixtures/mixed-research.txt')); await waitReview();
  assert.equal(await page.evaluate("document.querySelectorAll('[aria-label^=publications-][aria-label$=标题]').length"),3);
  await page.evaluate("Array.from(document.querySelectorAll('button')).find(button => button.textContent.trim() === '这是我的简历，继续核对')?.click()");
  await click('确认并保存资料');
  await waitFor(async () => (await stored()).publications?.length === 3, '本地论文线索恢复').catch(async error => { console.error(JSON.stringify({ publications: (await stored()).publications, personal: (await stored()).personal })); console.error(await page.evaluate("document.querySelector('[role=dialog]')?.textContent || document.body.innerText")); throw error; });
  assert.equal(externalRequests.length,0);
  assert.equal(page.events.filter(event => event.method === 'Runtime.exceptionThrown').length,0);
  console.log('✓ 本地规则恢复混合章节的论文；所有简历导入均无模型请求');
} finally {
  page?.close(); if (browser) await browser.close();
  await new Promise(resolve => server.close(resolve)); rmSync(temp, { recursive:true, force:true });
}
