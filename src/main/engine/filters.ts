import { FilterRule } from '../../shared/types';

export interface RankedFile {
  filePath: string;
  mtimeMs: number;
}

/** Leave the newest `keepNewest` files in place (by mtime, then path). */
export function partitionKeepNewest<T extends RankedFile>(
  files: T[],
  keepNewest: number | null
): { kept: T[]; rest: T[] } {
  if (keepNewest == null || keepNewest <= 0) {
    return { kept: [], rest: files };
  }
  const sorted = [...files].sort((a, b) => {
    if (b.mtimeMs !== a.mtimeMs) return b.mtimeMs - a.mtimeMs;
    return a.filePath.localeCompare(b.filePath);
  });
  return {
    kept: sorted.slice(0, keepNewest),
    rest: sorted.slice(keepNewest),
  };
}

export function evaluateFilters(
  filePath: string,
  stat: { size: number; mtimeMs: number; birthtimeMs: number },
  filters: FilterRule[],
  matchMode: 'all' | 'any' = 'all'
): boolean {
  if (!filters.length) return true;
  const results = filters.map((rule) => matchesFilter(filePath, stat, rule));
  return matchMode === 'any' ? results.some(Boolean) : results.every(Boolean);
}

export function matchesFilter(
  filePath: string,
  stat: { size: number; mtimeMs: number; birthtimeMs: number },
  rule: FilterRule
): boolean {
  const fileName = pathBasename(filePath);
  switch (rule.field) {
    case 'extension':
      return matchExtension(filePath, rule.value);
    case 'filename_glob':
      return matchGlob(fileName, rule.value);
    case 'filename_regex':
      return new RegExp(rule.value).test(fileName);
    case 'size':
      return matchSize(stat.size, rule.operator, rule.value);
    case 'modified_date':
      return matchDate(stat.mtimeMs, rule.operator, rule.value);
    case 'created_date':
      return matchDate(stat.birthtimeMs, rule.operator, rule.value);
    default:
      throw new Error(`Unknown filter field: ${rule.field}`);
  }
}

function pathBasename(filePath: string): string {
  const parts = filePath.replace(/\\/g, '/').split('/');
  return parts[parts.length - 1] ?? filePath;
}

function matchExtension(filePath: string, value: string): boolean {
  const wanted = value.toLowerCase().replace(/^\./, '');
  const ext = pathBasename(filePath).split('.').pop()?.toLowerCase().replace(/^\./, '') ?? '';
  return ext === wanted;
}

function matchGlob(fileName: string, pattern: string): boolean {
  const regex = new RegExp(
    '^' +
      pattern
        .toLowerCase()
        .replace(/[.+^${}()|[\]\\]/g, '\\$&')
        .replace(/\*/g, '.*')
        .replace(/\?/g, '.') +
      '$'
  );
  return regex.test(fileName.toLowerCase());
}

function matchSize(actualBytes: number, operator: string, value: string): boolean {
  const threshold = parseInt(value, 10);
  if (operator === 'min') return actualBytes >= threshold;
  if (operator === 'max') return actualBytes <= threshold;
  throw new Error(`Unknown size operator: ${operator}`);
}

function matchDate(actualMs: number, operator: string, value: string): boolean {
  const threshold = new Date(value);
  const actual = new Date(actualMs);
  if (operator === 'before') return actual < threshold;
  if (operator === 'after') return actual > threshold;
  throw new Error(`Unknown date operator: ${operator}`);
}
