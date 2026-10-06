import assert from 'node:assert/strict';
import test from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import App from './App.tsx';

test('资料编辑在同一页提供所有章节和统一保存入口', () => {
  const html = renderToStaticMarkup(<App />);
  for (const section of ['personal', 'education', 'experience', 'more', 'custom', 'resume']) {
    assert.match(html, new RegExp(`id="profile-${section}"`));
    assert.match(html, new RegExp(`href="#profile-${section}"`));
  }
  for (const label of ['个人基本信息', '教育经历', '实习 / 工作经历', '项目 / 校园经历', '专业技能', '更多个人资料', '自定义信息', '简历附件']) {
    assert(html.includes(label), `${label} should be present without switching views`);
  }
  assert.match(html, /aria-label="资料页内目录"/);
  assert.match(html, /保存全部资料/);
  assert.doesNotMatch(html, /options-tab|role="tab"|role="tabpanel"/);
  assert.doesNotMatch(html, /profile-ai|AI 设置|模型设置|API Key/);
  assert.match(html, /<details id="profile-data-backup"/);
  assert.doesNotMatch(html, /<details id="profile-data-backup"[^>]* open/);
});
