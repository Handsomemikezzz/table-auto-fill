import assert from 'node:assert/strict';
import test from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { DataBackupSettings } from './DataBackupSettings.tsx';

test('数据备份提供本地导入导出，不展示远端同步入口或凭据', () => {
  const html = renderToStaticMarkup(<DataBackupSettings onDataChanged={() => {}} />);
  assert.match(html, /导入完整数据/);
  assert.match(html, /导出完整数据/);
  assert.match(html, /导入或导出个人资料、简历原文件和通用设置/);
  assert.doesNotMatch(html, /AI|API Key|模型/);
  assert.doesNotMatch(html, /WebDAV|立即同步|用户名|账号密码|同步设置|远端|投递记录|CSV 副本/);
});
