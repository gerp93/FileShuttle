import { groupFilters } from '../../shared/filterGroups';
import { FilterRule } from '../../shared/types';

export interface RankedFile {
  filePath: string;
  mtimeMs: number;
}

/**
 * Leave the newest `keepNewest` files in place (by mtime, then path). With
 * `perExtension`, each extension gets its own `keepNewest` instead of all files sharing one.
 */
export function partitionKeepNewest<T extends RankedFile>(
  files: T[],
  keepNewest: number | null,
  perExtension = false
): { kept: T[]; rest: T[] } {
  if (keepNewest == null || keepNewest <= 0) {
    return { kept: [], rest: files };
  }
  const sorted = [...files].sort((a, b) => {
    if (b.mtimeMs !== a.mtimeMs) return b.mtimeMs - a.mtimeMs;
    return a.filePath.localeCompare(b.filePath);
  });
  const kept: T[] = [];
  const rest: T[] = [];
  const keptPerBucket = new Map<string, number>();
  for (const file of sorted) {
    const bucket = perExtension ? extensionOf(file.filePath) : '';
    const count = keptPerBucket.get(bucket) ?? 0;
    if (count < keepNewest) {
      kept.push(file);
      keptPerBucket.set(bucket, count + 1);
    } else {
      rest.push(file);
    }
  }
  return { kept, rest };
}

export function evaluateFilters(
  filePath: string,
  stat: { size: number; mtimeMs: number; birthtimeMs: number },
  filters: FilterRule[]
): boolean {
  // Every group must be satisfied; within a group any one rule is enough.
  return groupFilters(filters).every((group) => group.some((rule) => matchesFilter(filePath, stat, rule)));
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

/**
 * Same rule as path.extname: the text after the last dot, lower-cased, but a
 * leading dot alone (.gitignore) or no dot at all (README) means no extension.
 */
function extensionOf(filePath: string): string {
  const name = pathBasename(filePath);
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : '';
}

function matchExtension(filePath: string, value: string): boolean {
  const wanted = value.trim().toLowerCase().replace(/^\./, '');
  return extensionOf(filePath) === wanted;
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
  const threshold = Number(value.trim());
  if (value.trim() === '' || Number.isNaN(threshold)) throw new Error(`Invalid size filter value: ${value}`);
  if (operator === 'min') return actualBytes >= threshold;
  if (operator === 'max') return actualBytes <= threshold;
  throw new Error(`Unknown size operator: ${operator}`);
}

function matchDate(actualMs: number, operator: string, value: string): boolean {
  const threshold = new Date(value);
  if (Number.isNaN(threshold.getTime())) throw new Error(`Invalid date filter value: ${value}`);
  const actual = new Date(actualMs);
  if (operator === 'before') return actual < threshold;
  if (operator === 'after') return actual > threshold;
  throw new Error(`Unknown date operator: ${operator}`);
}
