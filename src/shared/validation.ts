import { validateMappingPaths } from './pathSafety';
import type { CreateMappingInput, FilterField, FilterRule } from './types';

/**
 * Save-time and run-time checks for mappings. Pure functions (no fs, no
 * Electron) so the editor, the IPC layer, and the engine all report the same
 * problems in the same words.
 */

const OPERATORS_BY_FIELD: Record<FilterField, readonly string[]> = {
  extension: ['equals'],
  filename_glob: ['matches'],
  filename_regex: ['matches'],
  size: ['min', 'max'],
  modified_date: ['before', 'after'],
  created_date: ['before', 'after'],
};

const FIELD_NAMES: Record<FilterField, string> = {
  extension: 'File extension',
  filename_glob: 'Filename (wildcard)',
  filename_regex: 'Filename (regex)',
  size: 'File size',
  modified_date: 'Modified date',
  created_date: 'Created date',
};

/** Returns what is wrong with one filter rule, or null when it is usable. */
export function validateFilterRule(rule: FilterRule): string | null {
  const allowed = OPERATORS_BY_FIELD[rule.field];
  if (!allowed) return `unknown filter field “${rule.field}”`;
  if (!allowed.includes(rule.operator)) return `“${rule.operator}” isn’t valid for ${FIELD_NAMES[rule.field]}`;

  const value = rule.value.trim();
  if (!value) return 'a value is required';

  switch (rule.field) {
    case 'filename_regex':
      try {
        new RegExp(rule.value);
      } catch (err) {
        return `not a valid regular expression (${err instanceof Error ? err.message : String(err)})`;
      }
      return null;
    case 'size':
      return /^\d+$/.test(value) && Number.isSafeInteger(Number(value))
        ? null
        : 'size must be a whole number of bytes, e.g. 1048576';
    case 'modified_date':
    case 'created_date':
      return Number.isNaN(new Date(value).getTime()) ? 'not a valid date — use YYYY-MM-DD' : null;
    default:
      return null;
  }
}

/** Checks every rule; the message names the offending rule by position and field. */
export function validateFilters(filters: FilterRule[]): string | null {
  for (let i = 0; i < filters.length; i += 1) {
    const problem = validateFilterRule(filters[i]);
    if (problem) {
      const label = FIELD_NAMES[filters[i].field] ?? filters[i].field;
      return `Filter ${i + 1} (${label}): ${problem}.`;
    }
  }
  return null;
}

/** Everything about a mapping that can be checked without touching the disk. */
export function validateMappingInput(input: CreateMappingInput): string | null {
  if (!input.name.trim()) return 'A name is required.';
  if (!input.sourcePath.trim()) return 'A source folder is required.';
  if (input.actionType !== 'delete' && !input.destPath.trim()) return 'A destination folder is required.';
  if (input.keepNewest != null && (!Number.isInteger(input.keepNewest) || input.keepNewest < 1)) {
    return 'Keep newest must be a whole number of at least 1.';
  }
  return validateFilters(input.filters) ?? validateMappingPaths(input);
}
