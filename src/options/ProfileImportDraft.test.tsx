import assert from 'node:assert/strict';
import test from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ProfileImportDraft } from './ProfileImportDraft.tsx';
import { SupplementalProfileSection } from './SupplementalProfileSection.tsx';
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
  assert.match(html, /简历已为你预填写/);
  assert.match(html, /已整理 23 项信息/);
  assert.match(html, /确认并保存资料/);
  assert.match(html, /暂存草稿/);

  // 验证已提取与待补全徽标
  assert.match(html, /已预填写/);
  assert.match(html, /稍后补充/);

  // 验证提取的具体字段展示在输入框中
  assert.match(html, /value="张三"/);
  assert.match(html, /value="13800138000"/);
  assert.match(html, /value="zhangsan@example\.com"/);
  assert.match(html, /value="1998-05"/);

  // 验证未提取到的字段显示待补全状态（如微信号、期望城市等）
  assert.match(html, /微信号/);
  assert.match(html, /期望城市/);
});

test('新增资料在核对页和资料编辑页展示，空类别保持可按需添加', () => {
  const profile: UserProfile = { personal: { name: '', gender: '', birthDate: '', phone: '', email: '' }, education: [], experience: [], projects: [], customInformation: [], skills: [], certifications: [] };
  const parsedData: ParsedResumeData = { rawText: '', awards: [{ name: '国家奖学金', date: '2023' }], publications: [{ title: '示例论文', status: '已录用' }], languages: [{ language: '英语', test: 'CET-6', score: '580' }] };
  const html = renderToStaticMarkup(<ProfileImportDraft parsedData={parsedData} currentProfile={profile} onApply={async () => {}} onDismiss={() => {}} />);
  assert.match(html, /value="国家奖学金"/); assert.match(html, /value="示例论文"/); assert.match(html, /value="580"/);
  assert.match(html, /aria-label="publications-1-发表 \/ 录用状态"/);
  assert.match(html, /专利与知识产权/);
  const editor = renderToStaticMarkup(<SupplementalProfileSection profile={profile} onChange={() => {}} />);
  assert.match(editor, /添加获奖与荣誉/); assert.match(editor, /添加语言能力/); assert.match(editor, /没有的项目无需填写/);
  assert(!editor.includes('<input'), 'empty sections must not expose a wall of blank fields');
});

test('会议研究线索需要明确加入论文，并在核对页显示补充识别提示', () => {
  const html = renderToStaticMarkup(<ProfileImportDraft parsedData={{ rawText: '', publicationCandidates: [{ title: '会议研究项目', venue: '示例会议', description: '原文线索' }], parsingWarnings: ['已补充识别论文，请核对。'] }} onApply={async () => {}} onDismiss={() => {}} />);
  assert.match(html, /会议研究项目/); assert.match(html, /加入论文与著作/);
  assert.match(html, /已补充识别论文，请核对/);
  assert(!html.includes('publications-1-'), 'unconfirmed clues must not enter the publication editor as facts');
});
