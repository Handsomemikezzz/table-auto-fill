/** Read a nearby section title without borrowing labels from another record. */
export function findFormSectionHeading(element: Element): string {
  const controlSelector = 'input,textarea,select,[role="combobox"],[role="radio"],[role="checkbox"]';
  for (let parent = element.parentElement, depth = 0; parent && depth < 24; parent = parent.parentElement, depth++) {
    if (parent.tagName === 'FORM' || parent.tagName === 'BODY') break;
    const title = [parent.getAttribute('aria-label') || '', ...Array.from(parent.children)
      .filter(child => !child.matches(controlSelector) && !child.querySelector(controlSelector))
      .map(child => (child.textContent || '').replace(/\s+/g, ' ').trim())
      .filter(text => text.length > 0 && text.length <= 100)].join(' ');
    if (/教育经历|教育背景|本科|硕士|博士|工作经历|实习经历|项目经历|基本信息|个人信息|education|employment|work experience|project experience|personal information|contact information/i.test(title)) return title;
  }
  return '';
}
