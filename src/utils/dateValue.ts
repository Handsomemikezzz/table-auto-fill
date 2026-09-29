import type { DatePrecision } from '../shared/fillModel.ts';

export interface ParsedFlexibleDate {
  year: number;
  month?: number;
  day?: number;
  precision: DatePrecision;
}

export interface DateControlHints {
  inputType?: string;
  placeholder?: string;
  pattern?: string;
  options?: string[];
}

export function parseFlexibleDate(value: string): ParsedFlexibleDate | null {
  const compact = value.trim().replace(/\s+/g, '');
  if (!/^(?:\d{4}(?:[-./]\d{1,2}){0,2}|\d{4}年(?:\d{1,2}月(?:\d{1,2}日)?)?)$/.test(compact)) return null;
  const normalized = compact
    .replace(/[年./]/g, '-')
    .replace(/[月]/g, '-')
    .replace(/[日]/g, '')
    .replace(/-$/g, '');
  const match = normalized.match(/^(\d{4})(?:-(\d{1,2}))?(?:-(\d{1,2}))?$/);
  if (!match) return null;
  const year = Number(match[1]);
  const month = match[2] ? Number(match[2]) : undefined;
  const day = match[3] ? Number(match[3]) : undefined;
  if (year < 1) return null;
  if (month !== undefined && (month < 1 || month > 12)) return null;
  if (day !== undefined) {
    if (month === undefined) return null;
    const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
    const maxDay = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1];
    if (day < 1 || day > maxDay) return null;
  }
  return { year, month, day, precision: day !== undefined ? 'day' : month !== undefined ? 'month' : 'year' };
}

export function areEquivalentDates(left: string, right: string): boolean {
  const a = parseFlexibleDate(left);
  const b = parseFlexibleDate(right);
  return Boolean(a && b && a.precision === b.precision
    && a.year === b.year && a.month === b.month && a.day === b.day);
}

/** Projection is permitted only when a control explicitly asks for this precision. */
export function areDatesEqualAtPrecision(left: string, right: string, precision: DatePrecision): boolean {
  const a = parseFlexibleDate(left);
  const b = parseFlexibleDate(right);
  if (!a || !b || a.year !== b.year) return false;
  if (precision === 'year') return true;
  if (a.month === undefined || b.month === undefined || a.month !== b.month) return false;
  return precision === 'month' || (a.day !== undefined && b.day !== undefined && a.day === b.day);
}

export function adaptDateValue(value: string, hints: DateControlHints): string {
  const parsed = parseFlexibleDate(value);
  if (!parsed) return value;
  const yyyy = String(parsed.year).padStart(4, '0');
  const month = parsed.month;
  const day = parsed.day;
  const mm = month === undefined ? '' : String(month).padStart(2, '0');
  const dd = day === undefined ? '' : String(day).padStart(2, '0');
  const inputType = (hints.inputType || '').toLowerCase();
  if (inputType === 'month') return month === undefined ? value : `${yyyy}-${mm}`;
  if (inputType === 'date') return day === undefined ? value : `${yyyy}-${mm}-${dd}`;

  const formatHint = `${hints.placeholder || ''} ${hints.pattern || ''}`.toLowerCase();
  const explicitFormat = formatHint.match(/yyyy\s*([./年-])\s*(mm|m)(?:\s*([./月-])\s*(dd|d))?/);
  if (explicitFormat) {
    const [, separator, monthToken, daySeparator, dayToken] = explicitFormat;
    if (month === undefined || (dayToken && day === undefined)) return value;
    const formattedMonth = monthToken === 'mm' ? mm : String(month);
    const monthValue = `${yyyy}${separator}${formattedMonth}`;
    if (dayToken) return `${monthValue}${daySeparator}${dayToken === 'dd' ? dd : day}${daySeparator === '月' ? '日' : ''}`;
    return `${monthValue}${separator === '年' ? '月' : ''}`;
  }
  if (/年.*月/.test(formatHint)) {
    if (month === undefined || (/日/.test(formatHint) && day === undefined)) return value;
    return /日/.test(formatHint) ? `${yyyy}年${mm}月${dd}日` : `${yyyy}年${mm}月`;
  }
  const patternFormat = formatHint.match(/d\{4\}\\?([./-])\\?d\{2\}(?:\\?([./-])\\?d\{2\})?/);
  if (patternFormat) {
    if (month === undefined || (patternFormat[2] && day === undefined)) return value;
    return `${yyyy}${patternFormat[1]}${mm}${patternFormat[2] ? `${patternFormat[2]}${dd}` : ''}`;
  }
  if (/\byyyy\b/.test(formatHint)) return yyyy;
  return value;
}

export function findDateOptionIndex(value: string, options: string[], part?: DatePrecision): number {
  const parsed = parseFlexibleDate(value);
  if (!parsed) return -1;
  const compact = options.map(option => option.trim().replace(/\s+/g, ''));
  const meaningful = compact.filter(option => option && !/^(?:请选择|选择|pleasechoose|pleaseselect|select|choose|year|month|day)$/i.test(option));
  const uniqueMatch = (predicate: (option: string) => boolean): number => {
    const matches = compact.flatMap((option, index) => predicate(option) ? [index] : []);
    return matches.length === 1 ? matches[0] : -1;
  };
  if ((!part && meaningful.length > 0 && meaningful.every(option => /^(\d{4})(?:年)?$/.test(option))) || part === 'year') {
    const yearIndex = uniqueMatch(option => {
      const match = option.match(/^(\d{4})(?:年)?$/);
      return Boolean(match) && Number(match?.[1]) === parsed.year;
    });
    return yearIndex;
  }

  if ((!part || part === 'month') && parsed.month) {
    const monthNames = [
      'january', 'february', 'march', 'april', 'may', 'june',
      'july', 'august', 'september', 'october', 'november', 'december',
    ];
    const shortMonthNames = monthNames.map(name => name.slice(0, 3));
    const monthNumber = (option: string): number | undefined => {
      const numeric = option.match(/^(0?[1-9]|1[0-2])(?:月|月份)?$/);
      if (numeric) return Number(numeric[1]);
      const normalized = option.toLowerCase().replace(/\.$/, '');
      const index = monthNames.findIndex((name, index) => name === normalized || shortMonthNames[index] === normalized);
      return index >= 0 ? index + 1 : undefined;
    };
    if (part === 'month' || (meaningful.length > 0 && meaningful.every(option => monthNumber(option) !== undefined))) {
      return uniqueMatch(option => monthNumber(option) === parsed.month);
    }
  }
  if (part === 'day') {
    if (!parsed.day) return -1;
    return uniqueMatch(option => {
      const match = option.match(/^(0?[1-9]|[12]\d|3[01])(?:日|号)?$/);
      return Boolean(match) && Number(match?.[1]) === parsed.day;
    });
  }
  return uniqueMatch(option => areEquivalentDates(value, option));
}
