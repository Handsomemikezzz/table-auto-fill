import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { homedir, tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';

export function findBrowserExecutable() {
  const configured = process.env.JOB_APPLYMATE_BROWSER_PATH || process.env.CHROME_PATH;
  if (configured) {
    if (!existsSync(configured)) throw new Error(`浏览器路径不存在：${configured}`);
    return configured;
  }
  const candidates = process.platform === 'darwin' ? [
    '/Applications/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    join(homedir(), 'Applications/Google Chrome.app/Contents/MacOS/Google Chrome'),
  ] : process.platform === 'win32' ? [
    ...['PROGRAMFILES', 'PROGRAMFILES(X86)', 'LOCALAPPDATA'].flatMap(name => process.env[name] ? [
      join(process.env[name], 'Google/Chrome/Application/chrome.exe'),
      join(process.env[name], 'Microsoft/Edge/Application/msedge.exe'),
    ] : []),
  ] : [
    '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium', '/usr/bin/chromium-browser', '/opt/google/chrome/chrome',
  ];
  // Reuse an existing Playwright browser without installing a browser or package.
  const cacheRoots = [
    process.env.PLAYWRIGHT_BROWSERS_PATH,
    join(homedir(), 'Library/Caches/ms-playwright'),
    join(homedir(), '.cache/ms-playwright'),
    process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, 'ms-playwright'),
  ].filter(Boolean);
  const cachedBrowsers = cacheRoots.flatMap(root => existsSync(root)
    ? readdirSync(root).filter(name => /^chromium-\d+$/.test(name))
      .sort((left, right) => Number(right.split('-')[1]) - Number(left.split('-')[1])).flatMap(name => [
      join(root, name, 'chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing'),
      join(root, name, 'chrome-mac-x64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing'),
      join(root, name, 'chrome-mac/Chromium.app/Contents/MacOS/Chromium'),
      join(root, name, 'chrome-linux/chrome'),
      join(root, name, 'chrome-linux64/chrome'),
      join(root, name, 'chrome-win/chrome.exe'),
      join(root, name, 'chrome-win64/chrome.exe'),
    ]) : []);
  candidates.unshift(...cachedBrowsers);
  for (const directory of (process.env.PATH || '').split(delimiter)) {
    for (const name of ['chrome', 'chromium', 'chromium-browser', 'google-chrome']) {
      candidates.push(join(directory, name + (process.platform === 'win32' ? '.exe' : '')));
    }
  }
  const executable = candidates.find(existsSync);
  if (!executable) throw new Error('未找到 Chrome / Chromium / Edge；请设置 JOB_APPLYMATE_BROWSER_PATH。');
  return executable;
}

export const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

export async function waitFor(predicate, description, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const value = await predicate();
      if (value) return value;
    } catch (error) { lastError = error; }
    await delay(75);
  }
  throw new Error(`等待超时：${description}${lastError ? ` (${lastError.message})` : ''}`);
}

export async function launchTestBrowser(extensionDir, pageUrl = 'about:blank') {
  const profileDir = mkdtempSync(join(tmpdir(), 'job-applymate-browser-'));
  const processHandle = spawn(findBrowserExecutable(), [
    ...(process.env.JOB_APPLYMATE_HEADED === '1' ? [] : ['--headless=new']),
    ...(process.env.CI === 'true' && process.platform === 'linux' ? ['--no-sandbox'] : []),
    '--no-first-run', '--no-default-browser-check', '--disable-gpu',
    '--disable-background-networking', '--disable-component-update', '--disable-default-apps', '--disable-sync',
    '--disable-background-timer-throttling', '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding',
    '--enable-unsafe-extension-debugging',
    '--window-size=1280,1000', '--remote-debugging-port=0',
    `--user-data-dir=${profileDir}`,
    `--disable-extensions-except=${extensionDir}`, `--load-extension=${extensionDir}`,
    pageUrl,
  ], { stdio: ['ignore', 'ignore', 'pipe'] });
  let diagnostics = '';
  processHandle.stderr.on('data', data => { diagnostics = (diagnostics + data).slice(-8000); });
  processHandle.on('error', error => { diagnostics += error.message; });
  const close = async () => {
    if (processHandle.exitCode === null && process.platform === 'win32' && processHandle.pid) {
      await new Promise(resolve => {
        const cleanup = spawn('taskkill', ['/pid', String(processHandle.pid), '/T', '/F'], { stdio: 'ignore' });
        cleanup.once('exit', resolve);
        cleanup.once('error', resolve);
      });
    } else if (processHandle.exitCode === null) processHandle.kill();
    await waitFor(() => processHandle.exitCode !== null || processHandle.signalCode !== null, '测试浏览器退出', 5000).catch(() => processHandle.kill('SIGKILL'));
    rmSync(profileDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 150 });
  };
  try {
    const port = await waitFor(() => {
      const portFile = join(profileDir, 'DevToolsActivePort');
      return existsSync(portFile) && Number(readFileSync(portFile, 'utf8').split('\n')[0]);
    }, '浏览器调试端口');
    const targets = () => fetch(`http://127.0.0.1:${port}/json/list`).then(response => response.json());
    // Recent Chrome releases ignore --load-extension. CDP provides the supported
    // equivalent for this isolated, disposable testing profile.
    const browserPath = readFileSync(join(profileDir, 'DevToolsActivePort'), 'utf8').split('\n')[1];
    const browserCdp = await connectCdp(`ws://127.0.0.1:${port}${browserPath}`);
    let extensionId;
    try {
      extensionId = (await browserCdp.send('Extensions.loadUnpacked', { path: extensionDir })).id;
    } catch (error) {
      diagnostics += `\nCDP extension loading: ${error.message}`;
    } finally { browserCdp.close(); }
    return { targets, close, extensionId, diagnostics: () => diagnostics };
  } catch (error) {
    await close();
    throw new Error(`${error.message}\n${diagnostics}`);
  }
}

export async function connectCdp(url) {
  const socket = new WebSocket(url);
  const pending = new Map();
  const events = [];
  let sequence = 0;
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true });
    socket.addEventListener('error', reject, { once: true });
  });
  socket.addEventListener('message', event => {
    const message = JSON.parse(event.data);
    if (message.method) {
      events.push(message);
      if (message.method === 'Page.javascriptDialogOpening') {
        void send('Page.handleJavaScriptDialog', { accept: true }).catch(() => {});
      }
      return;
    }
    const request = pending.get(message.id);
    if (!request) return;
    pending.delete(message.id);
    clearTimeout(request.timeout);
    if (message.error) request.reject(new Error(JSON.stringify(message.error)));
    else request.resolve(message.result);
  });
  socket.addEventListener('close', () => {
    for (const request of pending.values()) { clearTimeout(request.timeout); request.reject(new Error('浏览器调试连接已关闭')); }
    pending.clear();
  });
  const send = (method, params = {}, timeoutMs = 20_000) => new Promise((resolve, reject) => {
    if (socket.readyState !== WebSocket.OPEN) { reject(new Error('浏览器调试连接不可用')); return; }
    const id = ++sequence;
    const timeout = setTimeout(() => { pending.delete(id); reject(new Error(`CDP ${method} 超时`)); }, timeoutMs);
    pending.set(id, { resolve, reject, timeout });
    socket.send(JSON.stringify({ id, method, params }));
  });
  return {
    send,
    events,
    async evaluate(expression, timeoutMs) {
      const result = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, timeoutMs);
      if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
      return result.result?.value;
    },
    close() {
      for (const request of pending.values()) { clearTimeout(request.timeout); request.reject(new Error('CDP closed')); }
      pending.clear();
      socket.close();
    },
  };
}
