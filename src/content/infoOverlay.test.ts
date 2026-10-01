import assert from 'node:assert/strict';
import test from 'node:test';
import { buildSections, clampOverlayPosition } from './infoOverlay.ts';
import type { UserProfile } from '../shared/types.ts';

test('获奖、论文、语言等事实在网页信息浮窗中保留独立记录与字段', () => {
  const profile: UserProfile = {
    personal: { name: '', gender: '', birthDate: '', phone: '', email: '' },
    education: [], experience: [], projects: [], skills: [], customInformation: [],
    awards: [{ id: 'a', name: '国家奖学金', date: '2023' }],
    publications: [{ id: 'p', title: '示例论文', status: '已录用' }],
    languages: [{ id: 'l', language: '英语', test: 'CET-6', score: '580' }],
    certifications: [{ id: 'c', name: '证书', issuer: '机构', date: '', expiryDate: '2029' }],
  };
  const sections = buildSections(profile);
  assert(sections.find(section => section.title === '语言能力')?.groups[0].fields.some(field => field.key === 'languages-l-score' && field.value === '580'));
  assert(sections.find(section => section.title === '论文与著作')?.groups[0].fields.some(field => field.value === '已录用'));
  assert(sections.find(section => section.title === '技能与证书')?.groups.some(group => group.fields.some(field => field.value === '2029')));
  assert(!sections.some(section => section.title === '专利与知识产权'));
});

test('悬浮窗位置始终限制在可见区域内', () => {
  assert.deepEqual(
    clampOverlayPosition({ left: 900, top: -50 }, { width: 1000, height: 700 }, { width: 420, height: 600 }),
    { left: 568, top: 12 },
  );
  assert.deepEqual(
    clampOverlayPosition({ left: -200, top: 300 }, { width: 1000, height: 700 }, { width: 420, height: 600 }),
    { left: 12, top: 88 },
  );
});

test('自动学习的缺失信息在悬浮窗中单独成栏，手动自定义信息保持原栏', () => {
  const profile: UserProfile = {
    personal: { name: '', gender: '', birthDate: '', phone: '', email: '' },
    education: [], experience: [], projects: [], skills: [], certifications: [],
    customInformation: [
      { id: 'learned-emergency', name: '紧急联系电话', content: '13800001111' },
      { id: 'custom-hobby', name: '兴趣爱好', content: '摄影' },
    ],
  };
  const sections = buildSections(profile);
  const missing = sections.find(section => section.title === '缺失信息填补');
  const custom = sections.find(section => section.title === '自定义信息');

  assert.deepEqual(missing?.groups[0]?.fields.map(field => field.label), ['紧急联系电话']);
  assert.deepEqual(custom?.groups[0]?.fields.map(field => field.label), ['兴趣爱好']);
});
