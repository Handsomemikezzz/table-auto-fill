import assert from 'node:assert/strict';
import test from 'node:test';
import { ensureContentScriptForTab } from './contentScriptConnection.ts';

test('内容脚本失联时按握手流程注入并确认就绪', async () => {
  const originalChrome = (globalThis as { chrome?: unknown }).chrome;
  let pingCount = 0;
  const injections: unknown[] = [];
  (globalThis as { chrome?: unknown }).chrome = {
    tabs: {
      async get() { return { id: 7, url: 'https://jobs.example.com/apply' }; },
      async sendMessage() {
        pingCount += 1;
        if (pingCount === 1) throw new Error('Could not establish connection. Receiving end does not exist.');
        return { success: true, data: { ready: true } };
      },
    },
    webNavigation: {
      async getAllFrames() { return [{ frameId: 0 }]; },
    },
    scripting: {
      async executeScript(options: unknown) { injections.push(options); },
    },
  };

  try {
    const response = await ensureContentScriptForTab(7);
    assert.deepEqual(response, { success: true, data: { ready: true } });
    assert.equal(injections.length, 1);
  } finally {
    (globalThis as { chrome?: unknown }).chrome = originalChrome;
  }
});

test('浏览器内部页面不会尝试注入', async () => {
  const originalChrome = (globalThis as { chrome?: unknown }).chrome;
  let injected = false;
  (globalThis as { chrome?: unknown }).chrome = {
    tabs: { async get() { return { id: 7, url: 'chrome://extensions/' }; } },
    webNavigation: { async getAllFrames() { return [{ frameId: 0 }]; } },
    scripting: { async executeScript() { injected = true; } },
  };

  try {
    const response = await ensureContentScriptForTab(7);
    assert.equal(response.success, false);
    assert.match(response.error || '', /不能填写/);
    assert.equal(injected, false);
  } finally {
    (globalThis as { chrome?: unknown }).chrome = originalChrome;
  }
});

test('多个页面 frame 会并行探测而不是逐个等待', async () => {
  const originalChrome = (globalThis as { chrome?: unknown }).chrome;
  let activePings = 0;
  let maxActivePings = 0;
  (globalThis as { chrome?: unknown }).chrome = {
    tabs: {
      async get() { return { id: 7, url: 'https://jobs.example.com/apply' }; },
      async sendMessage() {
        activePings += 1;
        maxActivePings = Math.max(maxActivePings, activePings);
        await new Promise(resolve => setTimeout(resolve, 10));
        activePings -= 1;
        return { success: true, data: { ready: true } };
      },
    },
    webNavigation: {
      async getAllFrames() {
        return [{ frameId: 0 }, { frameId: 2 }, { frameId: 4 }];
      },
    },
    scripting: {
      async executeScript() {
        throw new Error('ready frames should not be injected');
      },
    },
  };

  try {
    const response = await ensureContentScriptForTab(7);
    assert.equal(response.success, true);
    assert.equal(maxActivePings, 3);
  } finally {
    (globalThis as { chrome?: unknown }).chrome = originalChrome;
  }
});

test('主页面已连接时只补注入失联 iframe，不会误报主页面启动失败', async () => {
  const originalChrome = (globalThis as { chrome?: unknown }).chrome;
  const injectedFrameIds: number[] = [];
  (globalThis as { chrome?: unknown }).chrome = {
    tabs: {
      async get() { return { id: 7, url: 'https://jobs.example.com/apply' }; },
      async sendMessage(_tabId: number, _message: unknown, options: { frameId: number }) {
        if (options.frameId === 0) return { success: true, data: { ready: true } };
        throw new Error('Could not establish connection. Receiving end does not exist.');
      },
    },
    webNavigation: {
      async getAllFrames() { return [{ frameId: 0 }, { frameId: 2 }]; },
    },
    scripting: {
      async executeScript(options: { target: { frameIds: number[] } }) {
        injectedFrameIds.push(...options.target.frameIds);
      },
    },
  };

  try {
    const response = await ensureContentScriptForTab(7);
    assert.deepEqual(response, { success: true, data: { ready: true } });
    assert.deepEqual(injectedFrameIds, [2]);
  } finally {
    (globalThis as { chrome?: unknown }).chrome = originalChrome;
  }
});

test('ensureFrames 只向未连接的 frame 注入脚本', async () => {
  const originalChrome = (globalThis as { chrome?: unknown }).chrome;
  const injectedFrameIds: number[] = [];
  (globalThis as { chrome?: unknown }).chrome = {
    tabs: {
      async sendMessage(_tabId: number, _message: unknown, options: { frameId: number }) {
        if (options.frameId === 1) return { success: true, data: { ready: true } };
        throw new Error('Could not establish connection');
      },
    },
    scripting: {
      async executeScript(options: { target: { frameIds: number[] } }) {
        injectedFrameIds.push(...options.target.frameIds);
      },
    },
  };

  try {
    const { ensureFrames } = await import('./contentScriptConnection.ts');
    const result = await ensureFrames(10, [1, 2, 3]);
    assert.deepEqual(result.readyFrameIds, [1]);
    assert.deepEqual(injectedFrameIds, [2, 3]);
  } finally {
    (globalThis as { chrome?: unknown }).chrome = originalChrome;
  }
});

test('用户启用标签页后记录到 session 存储，并在主页面跳转或关闭时清理', async () => {
  const originalChrome = (globalThis as { chrome?: unknown }).chrome;
  const sessionStore: Record<string, unknown> = {};
  let committedListener: ((details: { tabId: number; frameId: number }) => Promise<void>) | undefined;
  let removedListener: ((tabId: number) => void) | undefined;
  const injectedFrames: { tabId: number; frameId: number }[] = [];

  (globalThis as { chrome?: unknown }).chrome = {
    storage: {
      session: {
        async get(key: string) { return { [key]: sessionStore[key] }; },
        async set(obj: Record<string, unknown>) { Object.assign(sessionStore, obj); },
      },
    },
    webNavigation: {
      onCommitted: {
        addListener(fn: (details: { tabId: number; frameId: number }) => Promise<void>) {
          committedListener = fn;
        },
      },
    },
    tabs: {
      onRemoved: {
        addListener(fn: (tabId: number) => void) {
          removedListener = fn;
        },
      },
    },
    scripting: {
      async executeScript(options: { target: { tabId: number; frameIds: number[] } }) {
        for (const frameId of options.target.frameIds) {
          injectedFrames.push({ tabId: options.target.tabId, frameId });
        }
      },
    },
  };

  try {
    const {
      markTabAsEnabled,
      isTabEnabled,
      initContentScriptListeners,
    } = await import('./contentScriptConnection.ts');

    initContentScriptListeners();
    assert.ok(committedListener, 'committedListener 应注册');
    assert.ok(removedListener, 'removedListener 应注册');

    // 初始状态未启用
    assert.equal(await isTabEnabled(42), false);

    // 启用 tab 42
    await markTabAsEnabled(42);
    assert.equal(await isTabEnabled(42), true);

    // 未启用的 tab 99 中产生 iframe，不应注入
    await committedListener!({ tabId: 99, frameId: 5 });
    assert.equal(injectedFrames.length, 0);

    // 启用的 tab 42 中产生新 iframe (frameId=3)，自动补注入
    await committedListener!({ tabId: 42, frameId: 3 });
    assert.deepEqual(injectedFrames, [{ tabId: 42, frameId: 3 }]);

    // 主页面发生跳转 (frameId=0)，清掉 tab 42 记录
    await committedListener!({ tabId: 42, frameId: 0 });
    assert.equal(await isTabEnabled(42), false);

    // 再次启用 tab 42，并通过 tabs.onRemoved 关闭标签页
    await markTabAsEnabled(42);
    assert.equal(await isTabEnabled(42), true);
    removedListener!(42);
    // 给异步一点时间
    await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(await isTabEnabled(42), false);
  } finally {
    (globalThis as { chrome?: unknown }).chrome = originalChrome;
  }
});

