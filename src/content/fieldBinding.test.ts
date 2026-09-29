import assert from 'node:assert/strict';
import test from 'node:test';
import type { DetectedField, UserProfile } from '../shared/types.ts';
import { bindFieldRecords, dateRangePart, educationLevel } from './fieldBinding.ts';

/** Small structural DOM fixture: no browser globals or runtime profile enums. */
class ElementFixture {
  parentElement: ElementFixture | null = null;
  ownerDocument!: {
    body: ElementFixture;
    querySelectorAll?: (selector: string) => ElementFixture[];
    getElementById?: (id: string) => ElementFixture | null;
  };
  children: ElementFixture[] = [];
  value = '';
  tagName: string;
  attributes: Record<string, string>;
  text: string;
  constructor(tagName = 'DIV', attributes: Record<string, string> = {}, text = '') {
    this.tagName = tagName; this.attributes = attributes; this.text = text;
  }
  append(...nodes: ElementFixture[]) { for (const node of nodes) { node.parentElement = this; this.children.push(node); } return this; }
  get textContent(): string { return this.text + this.children.map(child => child.textContent).join(' '); }
  getAttribute(key: string) { return this.attributes[key] ?? null; }
  hasAttribute(key: string) { return key in this.attributes; }
  contains(node: ElementFixture): boolean { return this === node || this.children.some(child => child.contains(node)); }
  matches(selector: string): boolean {
    return selector.split(',').some(part => {
      const rule = part.trim();
      const qualified = rule.match(/^([a-z]+)(\[.+\])$/i);
      if (qualified) return this.tagName.toLowerCase() === qualified[1].toLowerCase() && this.matches(qualified[2]);
      if (rule.startsWith('.')) return (this.attributes.class || '').split(/\s+/).includes(rule.slice(1));
      const attr = rule.match(/^\[([^=\]]+)(?:="([^"]+)")?\]$/);
      if (attr) return attr[2] === undefined ? this.hasAttribute(attr[1]) : this.getAttribute(attr[1]) === attr[2];
      if (rule.startsWith('input:not')) return this.tagName === 'INPUT' && this.getAttribute('type') !== 'hidden';
      return this.tagName.toLowerCase() === rule.toLowerCase();
    });
  }
  querySelectorAll(selector: string): ElementFixture[] {
    return this.children.flatMap(child => [...(child.matches(selector) ? [child] : []), ...child.querySelectorAll(selector)]);
  }
  querySelector(selector: string) { return this.querySelectorAll(selector)[0] || null; }
  closest(selector: string): ElementFixture | null {
    return this.matches(selector) ? this : this.parentElement?.closest(selector) || null;
  }
  compareDocumentPosition(other: ElementFixture): number {
    const all = (node: ElementFixture): ElementFixture[] => [node, ...node.children.flatMap(all)];
    const ordered = all(this.ownerDocument.body);
    return ordered.indexOf(this) < ordered.indexOf(other) ? 4 : 2;
  }
  asElement() { return this as unknown as HTMLElement; }
}
function attach(...nodes: ElementFixture[]): ElementFixture {
  const body = new ElementFixture('BODY').append(new ElementFixture('FORM').append(...nodes));
  const document = {
    body,
    querySelectorAll: (selector: string) => body.querySelectorAll(selector),
    getElementById: (id: string) => body.querySelectorAll('[id]').find(element => element.getAttribute('id') === id) || null,
  };
  const assign = (node: ElementFixture) => { node.ownerDocument = document; node.children.forEach(assign); };
  assign(body); return body;
}
function control(fieldType: string, attributes: Record<string, string> = {}): { node: ElementFixture; field: DetectedField } {
  const node = new ElementFixture('INPUT', attributes);
  return { node, field: { element: node.asElement(), fieldType, confidence: 1 } };
}
function record(label: string, ...children: ElementFixture[]) {
  return new ElementFixture('FIELDSET').append(new ElementFixture('LEGEND', {}, label), ...children);
}
function profile(): UserProfile {
  return {
    personal: { name: '', gender: '', birthDate: '', phone: '', email: '' },
    education: [
      { id: 'edu-bachelor', degree: '本科', school: '大学 A', major: '软件工程', startDate: '2017-09', endDate: '2021-06' },
      { id: 'edu-master', degree: '硕士', school: '大学 B', major: '计算机科学', startDate: '2021-09', endDate: '2024-06' },
    ],
    experience: [
      { id: 'job-a', company: '公司 A', position: '工程师 A', startDate: '', endDate: '', description: '' },
      { id: 'job-b', company: '公司 B', position: '工程师 B', startDate: '', endDate: '', description: '' },
    ],
    projects: [{ id: 'project-a', name: '项目 A', role: '', startDate: '', endDate: '', description: '', achievements: '' }],
    skills: [], certifications: [], customInformation: [],
  };
}

test('学历顺序变化和缺失字段不会使日期与学校跨记录', () => {
  const schoolM = control('school'); const startM = control('educationStartDate');
  const schoolB = control('school'); const startB = control('educationStartDate'); const endB = control('graduationDate');
  attach(record('硕士研究生教育经历', schoolM.node, record('起止时间', startM.node)),
    record('本科教育经历', schoolB.node, record('起止时间', startB.node, endB.node)));
  const fields = [schoolM, startM, schoolB, startB, endB].map(item => item.field);
  const bound = bindFieldRecords(fields, profile());
  for (const item of [schoolM, startM]) assert.equal(bound.get(item.node.asElement())?.recordId, 'edu-master');
  for (const item of [schoolB, startB, endB]) assert.equal(bound.get(item.node.asElement())?.recordId, 'edu-bachelor');
});

test('没有重复字段可作边界时，独立的稀疏 fieldset 仍保持两条记录', () => {
  const school = control('school'); const major = control('major');
  attach(record('', school.node), record('', major.node));
  const bound = bindFieldRecords([school.field, major.field], profile());
  assert.equal(bound.get(school.node.asElement())?.recordId, 'edu-bachelor');
  assert.equal(bound.get(major.node.asElement())?.recordId, 'edu-master');
});

test('嵌套时间 fieldset 和普通字段绑定到明确的同一记录', () => {
  const school = control('school'); const start = control('educationStartDate'); const end = control('graduationDate');
  const wrapper = new ElementFixture('DIV', { 'data-entry-id': 'edu-master' }).append(school.node, record('时间范围', start.node, end.node));
  attach(wrapper);
  const bound = bindFieldRecords([school.field, start.field, end.field], profile());
  for (const item of [school, start, end]) {
    assert.equal(bound.get(item.node.asElement())?.recordId, 'edu-master');
    assert.equal(bound.get(item.node.asElement())?.container, wrapper.asElement());
  }
});

test('同一容器中的教育、工作和项目使用各自资料集合', () => {
  const school = control('school'); const company = control('company'); const project = control('projectName');
  attach(new ElementFixture('DIV', { 'data-record-id': 'website-block' }).append(school.node, company.node, project.node));
  const bound = bindFieldRecords([school.field, company.field, project.field], profile());
  assert.equal(bound.get(school.node.asElement())?.recordId, 'edu-bachelor');
  assert.equal(bound.get(company.node.asElement())?.recordId, 'job-a');
  assert.equal(bound.get(project.node.asElement())?.recordId, 'project-a');
});

test('记录上下文与字段资料类型冲突时不跨集合取日期', () => {
  const school = control('school'); const genericDate = control('startDate');
  attach(record('本科教育经历', school.node, genericDate.node));
  const bound = bindFieldRecords([school.field, genericDate.field], profile());
  assert.equal(bound.get(school.node.asElement())?.recordId, 'edu-bachelor');
  assert.equal(bound.has(genericDate.node.asElement()), false);
});

test('先为明确学历组保留记录，再给无提示组按顺序绑定', () => {
  const unknown = control('school'); const bachelor = control('school');
  attach(record('', unknown.node), record('本科教育经历', bachelor.node));
  const bound = bindFieldRecords([unknown.field, bachelor.field], profile());
  assert.equal(bound.get(unknown.node.asElement())?.recordId, 'edu-master');
  assert.equal(bound.get(bachelor.node.asElement())?.recordId, 'edu-bachelor');
});

test('已有公司名优先于资料顺序，未匹配的公司不偷用下一条经历', () => {
  const companyB = control('company'); companyB.node.value = '公司 B'; const positionB = control('position');
  const companyX = control('company'); companyX.node.value = '未收录公司'; const positionX = control('position');
  attach(record('工作经历', companyB.node, positionB.node), record('工作经历', companyX.node, positionX.node));
  const bound = bindFieldRecords([companyB, positionB, companyX, positionX].map(item => item.field), profile());
  assert.equal(bound.get(positionB.node.asElement())?.recordId, 'job-b');
  assert.equal(bound.has(positionX.node.asElement()), false);
});

test('最高学历摘要不会消耗重复经历所需的同一记录', () => {
  const summary = control('degree'); const school = control('school'); const degree = control('degree');
  attach(record('最高学历', summary.node), record('硕士教育经历', school.node, degree.node));
  const bound = bindFieldRecords([summary.field, school.field, degree.field], profile());
  assert.equal(bound.get(summary.node.asElement())?.recordId, 'edu-master');
  assert.equal(bound.get(school.node.asElement())?.recordId, 'edu-master');
});

test('label 指定的本科学历摘要可与本科和硕士完整记录复用来源', () => {
  const summary = control('degree', { id: 'summary-degree' });
  const schoolM = control('school'); const degreeM = control('degree');
  const schoolB = control('school'); const degreeB = control('degree');
  attach(new ElementFixture().append(new ElementFixture('LABEL', { for: 'summary-degree' }, '本科学历'), summary.node),
    record('硕士教育经历', schoolM.node, degreeM.node), record('本科教育经历', schoolB.node, degreeB.node));
  const bound = bindFieldRecords([summary, schoolM, degreeM, schoolB, degreeB].map(item => item.field), profile());
  assert.equal(bound.get(summary.node.asElement())?.recordId, 'edu-bachelor');
  assert.equal(bound.get(schoolM.node.asElement())?.recordId, 'edu-master');
  assert.equal(bound.get(schoolB.node.asElement())?.recordId, 'edu-bachelor');
});

test('没有提示的学历摘要存在多种来源学历时保留未确定', () => {
  const summary = control('degree', { id: 'summary-degree' });
  const schoolM = control('school'); const degreeM = control('degree');
  const schoolB = control('school'); const degreeB = control('degree');
  attach(new ElementFixture().append(new ElementFixture('LABEL', { for: 'summary-degree' }, '学历'), summary.node),
    record('硕士教育经历', schoolM.node, degreeM.node), record('本科教育经历', schoolB.node, degreeB.node));
  const bound = bindFieldRecords([summary, schoolM, degreeM, schoolB, degreeB].map(item => item.field), profile());
  assert.equal(bound.has(summary.node.asElement()), false);
  assert.equal(bound.get(schoolM.node.asElement())?.recordId, 'edu-master');
  assert.equal(bound.get(schoolB.node.asElement())?.recordId, 'edu-bachelor');
});

test('来源学历值唯一时普通摘要可填写且不消耗完整经历的记录', () => {
  const source = profile(); source.education[1].degree = '大学本科';
  const summary = control('degree', { 'aria-labelledby': 'summary-label' });
  const schoolA = control('school'); const degreeA = control('degree');
  const schoolB = control('school'); const degreeB = control('degree');
  attach(new ElementFixture().append(new ElementFixture('SPAN', { id: 'summary-label' }, '学历'), summary.node),
    record('教育经历', schoolA.node, degreeA.node), record('教育经历', schoolB.node, degreeB.node));
  const bound = bindFieldRecords([summary, schoolA, degreeA, schoolB, degreeB].map(item => item.field), source);
  assert.equal(bound.get(summary.node.asElement())?.recordId, 'edu-bachelor');
  assert.equal(bound.get(schoolA.node.asElement())?.recordId, 'edu-bachelor');
  assert.equal(bound.get(schoolB.node.asElement())?.recordId, 'edu-master');
});

test('aria-labelledby 的最高学历摘要提示生效，学位摘要不混同不同具体学位', () => {
  const summary = control('degree', { 'aria-labelledby': 'summary-label' });
  attach(new ElementFixture().append(new ElementFixture('SPAN', { id: 'summary-label' }, '最高学历'), summary.node));
  assert.equal(bindFieldRecords([summary.field], profile()).get(summary.node.asElement())?.recordId, 'edu-master');
  const academic = control('academicDegree'); attach(new ElementFixture().append(academic.node));
  const source = profile(); source.education[0].academicDegree = '工学学士'; source.education[1].academicDegree = '工程硕士';
  assert.equal(bindFieldRecords([academic.field], source).has(academic.node.asElement()), false);
  source.education[1].academicDegree = '工学学士';
  assert.equal(bindFieldRecords([academic.field], source).has(academic.node.asElement()), true);
});

test('真正重复的单字段学历记录仍分别消耗各自来源', () => {
  const first = control('degree'); const second = control('degree');
  attach(record('', first.node), record('', second.node));
  const bound = bindFieldRecords([first.field, second.field], profile());
  assert.equal(bound.get(first.node.asElement())?.recordId, 'edu-bachelor');
  assert.equal(bound.get(second.node.asElement())?.recordId, 'edu-master');
});

test('外层 fieldset 不吞并不同的稀疏记录，未保存的学历不代填其他学历', () => {
  const bachelor = control('school'); const master = control('major'); const phd = control('graduationDate');
  attach(record('教育经历', record('本科', bachelor.node), record('硕士', master.node), record('博士', phd.node)));
  const bound = bindFieldRecords([bachelor.field, master.field, phd.field], profile());
  assert.equal(bound.get(bachelor.node.asElement())?.recordId, 'edu-bachelor');
  assert.equal(bound.get(master.node.asElement())?.recordId, 'edu-master');
  assert.equal(bound.has(phd.node.asElement()), false);
  assert.equal(educationLevel('研究生'), undefined);
  assert.equal(educationLevel('postgraduate'), undefined);
});

test('普通标签和两个无格式输入也可表示明确的起止时间', () => {
  const start = control('unknown'); const end = control('unknown');
  attach(new ElementFixture().append(new ElementFixture('SPAN', {}, '起止时间'), start.node, end.node));
  assert.equal(dateRangePart(start.node.asElement()), 'start');
  assert.equal(dateRangePart(end.node.asElement()), 'end');
});

test('日期端点跨越深层组件包装读取共享的起止字段', () => {
  const start = control('educationStartDate');
  const end = control('graduationDate');
  const wrap = (node: ElementFixture, depth: number) => {
    for (let i = 0; i < depth; i++) node = new ElementFixture().append(node);
    return node;
  };
  const pair = new ElementFixture().append(wrap(start.node, 4), wrap(end.node, 4));
  const field = new ElementFixture('DIV', { 'data-form-field-name': 'start_end_time' }).append(wrap(pair, 4));
  attach(field);
  assert.equal(dateRangePart(start.node.asElement()), 'start');
  assert.equal(dateRangePart(end.node.asElement()), 'end');
});

test('日期范围优先使用端点语义而非 DOM 顺序，重复开始字段保留未确定', () => {
  const end = control('unknown', { 'aria-label': '毕业日期' }); const start = control('unknown', { 'aria-label': '入学日期' });
  attach(record('日期范围', end.node, start.node));
  assert.equal(dateRangePart(end.node.asElement()), 'end');
  assert.equal(dateRangePart(start.node.asElement()), 'start');
  end.node.attributes['aria-label'] = '入学日期';
  assert.equal(dateRangePart(end.node.asElement()), undefined);
  assert.equal(dateRangePart(start.node.asElement()), undefined);
});

test('两个普通输入、两个出生日期、整个记录中的日期不自动当作范围', () => {
  const a = control('unknown'); const b = control('unknown');
  attach(record('填写教育经历 period', a.node, b.node));
  assert.equal(dateRangePart(a.node.asElement()), undefined);
  const birthA = control('birthDate', { name: 'birthDate', type: 'date' }); const birthB = control('birthDate', { name: 'birthDate', type: 'date' });
  attach(record('日期范围', birthA.node, birthB.node));
  assert.equal(dateRangePart(birthA.node.asElement()), undefined);
  const school = control('school'); const start = control('educationStartDate', { type: 'month' }); const end = control('graduationDate', { type: 'month' });
  attach(record('教育经历', school.node, start.node, end.node));
  assert.equal(dateRangePart(start.node.asElement()), undefined);
});

test('自定义下拉的包装节点与内部 input 共享日期端点，隐藏值不重复计数', () => {
  const start = new ElementFixture('DIV', { role: 'combobox' }).append(new ElementFixture('INPUT', { name: 'startDate' }));
  const end = new ElementFixture('DIV', { role: 'combobox' }).append(new ElementFixture('INPUT', { name: 'endDate' }));
  attach(record('起止时间', start, end, new ElementFixture('INPUT', { type: 'hidden' })));
  assert.equal(dateRangePart(start.asElement()), 'start');
  assert.equal(dateRangePart(end.asElement()), 'end');
});
