import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

test('备份与同步仅展示简历资料功能', () => {
  const source = readFileSync(new URL('./DataSyncSettings.tsx', import.meta.url), 'utf8');
  assert.match(source, /导入或导出个人资料、简历原文件、AI 配置和通用设置/);
  assert.doesNotMatch(source, /投递记录|CSV 副本/);
});

test('立即同步按钮不再要求启用自动同步', () => {
  const source = readFileSync(new URL('./DataSyncSettings.tsx', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /disabled=\{busy !== null \|\| !config\.enabled\}/);
  assert.match(source, /disabled=\{busy !== null\}/);
});

test('立即同步成功后显示明确成功提示', () => {
  const source = readFileSync(new URL('./DataSyncSettings.tsx', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /操作未完成，请查看下方同步状态/);
  assert.match(source, /同步完成/);
});
