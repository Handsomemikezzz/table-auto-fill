import type { Message, MessageResponse } from '../shared/types.ts';

const CONNECTION_ERROR = /Receiving end does not exist|Could not establish connection/i;
const ENABLED_TABS_KEY = 'enabledTabIds';

export async function getEnabledTabs(): Promise<Set<number>> {
  try {
    if (!chrome.storage?.session) return new Set();
    const result = await chrome.storage.session.get(ENABLED_TABS_KEY);
    const ids = Array.isArray(result[ENABLED_TABS_KEY]) ? result[ENABLED_TABS_KEY] : [];
    return new Set(ids);
  } catch {
    return new Set();
  }
}

export async function markTabAsEnabled(tabId: number): Promise<void> {
  try {
    if (!chrome.storage?.session) return;
    const tabs = await getEnabledTabs();
    tabs.add(tabId);
    await chrome.storage.session.set({ [ENABLED_TABS_KEY]: Array.from(tabs) });
  } catch {
    // Ignore storage errors in test or restricted environments
  }
}

export async function removeEnabledTab(tabId: number): Promise<void> {
  try {
    if (!chrome.storage?.session) return;
    const tabs = await getEnabledTabs();
    if (tabs.delete(tabId)) {
      await chrome.storage.session.set({ [ENABLED_TABS_KEY]: Array.from(tabs) });
    }
  } catch {
    // Ignore storage errors
  }
}

export async function isTabEnabled(tabId: number): Promise<boolean> {
  const tabs = await getEnabledTabs();
  return tabs.has(tabId);
}

function isRestrictedPage(url: string): boolean {
  return (
    /^(chrome|edge|about|chrome-extension|edge-extension):\/\//i.test(url)
    || /^https:\/\/chromewebstore\.google\.com\//i.test(url)
    || /^https:\/\/microsoftedge\.microsoft\.com\/addons\//i.test(url)
  );
}

async function isContentReady(tabId: number, frameId: number): Promise<boolean> {
  try {
    const response = await chrome.tabs.sendMessage(tabId, {
      type: 'PING_CONTENT',
    } satisfies Message, { frameId }) as MessageResponse<{ ready?: boolean }>;
    return response.success && response.data?.ready === true;
  } catch {
    return false;
  }
}

async function getFrameIds(tabId: number): Promise<number[]> {
  const frames = await chrome.webNavigation.getAllFrames({ tabId }).catch(() => []);
  return [...new Set([0, ...(frames || []).map(frame => frame.frameId)])];
}

export interface EnsureFramesResult {
  readyFrameIds: number[];
  injectedFrameIds: number[];
}

/**
 * 确保指定 frame 已经载入并响应 content script。
 * 对未连接的 frame 补充注入，并在注入后等待就绪。
 */
export async function ensureFrames(
  tabId: number,
  frameIds: number[],
): Promise<EnsureFramesResult> {
  const readiness = await Promise.all(frameIds.map(async frameId => ({
    frameId,
    ready: await isContentReady(tabId, frameId),
  })));
  const readyFrameIds = readiness.filter(r => r.ready).map(r => r.frameId);
  const disconnectedFrameIds = readiness.filter(r => !r.ready).map(r => r.frameId);

  if (disconnectedFrameIds.length === 0) {
    return { readyFrameIds, injectedFrameIds: [] };
  }

  const injectedFrameIds = (await Promise.all(disconnectedFrameIds.map(async frameId => {
    try {
      await chrome.scripting.executeScript({
        target: { tabId, frameIds: [frameId] },
        files: ['content.js'],
      });
      return frameId;
    } catch {
      return null;
    }
  }))).filter((frameId): frameId is number => frameId !== null);

  if (injectedFrameIds.length > 0) {
    for (const delay of [100, 200, 350]) {
      await new Promise(resolve => setTimeout(resolve, delay));
      const checks = await Promise.all(injectedFrameIds.map(id => isContentReady(tabId, id)));
      if (checks.every(Boolean)) break;
    }
  }

  return { readyFrameIds, injectedFrameIds };
}

/**
 * 页面侧采用 chaunyoffer 同样的握手机制：先探测，确实缺失才注入，然后再次确认。
 * 填充指令不再承担“把脚本叫醒”的职责，避免在不同网站的 iframe 中相互干扰。
 */
export async function ensureContentScriptForTab(
  tabId: number,
): Promise<MessageResponse<{ ready: boolean }>> {
  try {
    const tab = await chrome.tabs.get(tabId);
    if (!tab.id) return { success: false, error: '没有可用的当前网页' };
    if (isRestrictedPage(tab.url || '')) {
      return { success: false, error: '浏览器内部页面、扩展商店和内置 PDF 页面不能填写' };
    }

    const frameIds = await getFrameIds(tabId);
    const { readyFrameIds, injectedFrameIds } = await ensureFrames(tabId, frameIds);
    const mainFrameWasReady = readyFrameIds.includes(0);

    if (!mainFrameWasReady && !injectedFrameIds.includes(0)) {
      return { success: false, error: '页面脚本未能启动。请刷新招聘页面后再试。' };
    }

    // 主 frame 原本已连接时，无需因为某个无关 iframe 的补注入再次等待主 frame。
    if (mainFrameWasReady) {
      await markTabAsEnabled(tabId);
      return { success: true, data: { ready: true } };
    }

    for (const delay of [100, 200, 350]) {
      if (await isContentReady(tabId, 0)) {
        await markTabAsEnabled(tabId);
        return { success: true, data: { ready: true } };
      }
      await new Promise(resolve => setTimeout(resolve, delay));
    }

    return {
      success: false,
      error: '页面脚本未能启动。请刷新招聘页面后再试。',
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (CONNECTION_ERROR.test(message)) {
      return { success: false, error: '页面脚本未连接，请刷新招聘页面后再试。' };
    }
    return { success: false, error: `当前页面暂不支持填写：${message}` };
  }
}

/**
 * 监听 webNavigation.onCommitted 与 tabs.onRemoved：
 * - 用户已启用的标签页中出现新 iframe 时自动补注入 content.js；
 * - 主页面跳转（frameId === 0）或标签页关闭时清掉启用记录。
 */
export function initContentScriptListeners(): void {
  if (typeof chrome === 'undefined') return;

  chrome.webNavigation?.onCommitted?.addListener(async (details) => {
    if (details.frameId === 0) {
      await removeEnabledTab(details.tabId);
      return;
    }
    if (await isTabEnabled(details.tabId)) {
      try {
        await chrome.scripting.executeScript({
          target: { tabId: details.tabId, frameIds: [details.frameId] },
          files: ['content.js'],
        });
      } catch {
        // 忽略受限或不支持注入的 iframe
      }
    }
  });

  chrome.tabs?.onRemoved?.addListener((tabId) => {
    void removeEnabledTab(tabId);
  });
}

