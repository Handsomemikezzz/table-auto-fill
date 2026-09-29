import assert from 'node:assert/strict';
import test from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ProfileImportDraft } from './ProfileImportDraft.tsx';
import type { ParsedResumeData, UserProfile } from '../shared/types.ts';

test('ProfileImportDraft 弹窗正确展示提取字段和待补全标记', () => {
  const sampleParsed: ParsedResumeData = {
    personal: {
      name: '张三',
      phone: '13800138000',
      email: 'zhangsan@example.com',
      gender: '男',
      birthDate: '1998-05',
    },
    education: [
      {
        id: 'edu-1',
        school: '北京大学',
        major: '计算机科学与技术',
        degree: '本科',
        startDate: '2016-09',
        endDate: '2020-06',
      },
    ],
    experience: [
      {
        id: 'exp-1',
        company: '某互联网大厂',
        position: '前端工程师',
        startDate: '2020-07',
        endDate: '2023-08',
        description: '负责核心业务开发',
      },
    ],
    projects: [
      {
        id: 'proj-1',
        name: '智能建档插件',
        role: '项目负责人',
        startDate: '2023-01',
        endDate: '2023-06',
        description: '自动简历解析与一键填充',
      },
    ],
    skills: ['React', 'TypeScript', 'Node.js'],
  };

  const emptyProfile: UserProfile = {
    personal: {
      name: '',
      gender: '',
      birthDate: '',
      phone: '',
      email: '',
    },
    education: [],
    experience: [],
    projects: [],
    customInformation: [],
    skills: [],
    certifications: [],
  };

  const html = renderToStaticMarkup(
    <ProfileImportDraft
      parsedData={sampleParsed}
      fileName="张三_个人简历.pdf"
      currentProfile={emptyProfile}
      onApply={async () => {}}
      onDismiss={() => {}}
    />
  );

  // 验证弹窗头部和基础信息
  assert.match(html, /张三_个人简历\.pdf/);
  assert.match(html, /核对并补全提取内容/);
  assert.match(html, /已提取 8 项信息/);
  assert.match(html, /确认写入个人资料库/);
  assert.match(html, /放弃导入/);

  // 验证已提取与待补全徽标
  assert.match(html, /已提取/);
  assert.match(html, /待补全/);

  // 验证提取的具体字段展示在输入框中
  assert.match(html, /value="张三"/);
  assert.match(html, /value="13800138000"/);
  assert.match(html, /value="zhangsan@example\.com"/);
  assert.match(html, /value="1998-05"/);

  // 验证未提取到的字段显示待补全状态（如微信号、期望城市等）
  assert.match(html, /微信号/);
  assert.match(html, /期望城市/);
});
