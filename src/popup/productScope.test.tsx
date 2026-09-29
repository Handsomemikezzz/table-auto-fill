import assert from 'node:assert/strict';
import test from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import App from './App.tsx';

test('弹窗专注简历填写，使用单一填写入口并移除投递台账', () => {
  const html = renderToStaticMarkup(<App />);
  assert.match(html, /填写当前页面/);
  assert.match(html, /当前资料/);
  assert.match(html, /附件（可选）/);
  assert.match(html, /打开资料/);
  assert.doesNotMatch(html, /快速填充|AI 扫描填充|AI 框选补填/);
  assert.doesNotMatch(html, /新建投递记录|打开投递记录|application-records/);
});
