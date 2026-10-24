import { describe, expect, it } from 'vitest';
import { validateFilterRule, validateFilters, validateMappingInput } from './validation';
import type { CreateMappingInput, FilterRule } from './types';

const rule = (
  field: FilterRule['field'],
  operator: FilterRule['operator'],
  value: string,
  group = 0
): FilterRule => ({
  field,
  operator,
  value,
  group,
});

describe('validateFilterRule', () => {
  it('accepts well-formed rules for every field', () => {
    for (const r of [
      rule('extension', 'equals', 'pdf'),
      rule('filename_glob', 'matches', '*.bak'),
      rule('filename_regex', 'matches', '^invoice_\\d+'),
      rule('size', 'min', '1048576'),
      rule('size', 'max', '0'),
      rule('modified_date', 'before', '2024-06-15'),
      rule('created_date', 'after', '2024-06-15T08:00:00Z'),
    ]) {
      expect(validateFilterRule(r)).toBeNull();
    }
  });

  it('rejects an empty value, including whitespace', () => {
    expect(validateFilterRule(rule('extension', 'equals', ''))).toMatch(/value is required/);
    expect(validateFilterRule(rule('filename_glob', 'matches', '   '))).toMatch(/value is required/);
  });

  it('rejects an invalid regular expression with the reason', () => {
    expect(validateFilterRule(rule('filename_regex', 'matches', '([unclosed'))).toMatch(/not a valid regular expression/);
  });

  it('rejects sizes that are not whole byte counts', () => {
    for (const bad of ['5MB', '1.5', '-3', 'abc', '99999999999999999999']) {
      expect(validateFilterRule(rule('size', 'min', bad))).toMatch(/whole number of bytes/);
    }
  });

  it('rejects unparseable dates', () => {
    expect(validateFilterRule(rule('modified_date', 'before', 'last tuesday'))).toMatch(/not a valid date/);
    expect(validateFilterRule(rule('created_date', 'after', '2024-13-45'))).toMatch(/not a valid date/);
  });

  it('rejects an operator that does not belong to the field', () => {
    expect(validateFilterRule(rule('size', 'before', '10'))).toMatch(/isn’t valid for File size/);
    expect(validateFilterRule(rule('modified_date', 'min', '2024-01-01'))).toMatch(/isn’t valid/);
  });

  it('rejects an unknown field', () => {
    expect(validateFilterRule({ field: 'owner' as FilterRule['field'], operator: 'equals', value: 'x', group: 0 })).toMatch(
      /unknown filter field/
    );
  });
});

describe('validateFilters', () => {
  it('names the first bad rule by position and field', () => {
    const message = validateFilters([rule('extension', 'equals', 'pdf'), rule('size', 'min', 'huge')]);
    expect(message).toMatch(/^Filter 2 \(File size\):/);
  });

  it('accepts an empty list', () => {
    expect(validateFilters([])).toBeNull();
  });
});

describe('validateMappingInput', () => {
  const base: CreateMappingInput = {
    name: 'm',
    sourcePath: 'C:\\in',
    destPath: 'C:\\out',
    recursive: false,
    conflictPolicy: 'skip',
    enabled: true,
    scheduleType: 'manual',
    scheduleIntervalMinutes: null,
    scheduleDailyTime: null,
    filters: [],
    nextMappingId: null,
    actionType: 'move',
    keepNewest: null,
  };

  it('accepts a valid mapping', () => {
    expect(validateMappingInput(base)).toBeNull();
  });

  it('requires a name, source, and (except for delete) a destination', () => {
    expect(validateMappingInput({ ...base, name: ' ' })).toMatch(/name is required/);
    expect(validateMappingInput({ ...base, sourcePath: '' })).toMatch(/source folder is required/);
    expect(validateMappingInput({ ...base, destPath: '' })).toMatch(/destination folder is required/);
    expect(validateMappingInput({ ...base, destPath: '', actionType: 'delete' })).toBeNull();
  });

  it('validates keep-newest', () => {
    expect(validateMappingInput({ ...base, keepNewest: 0 })).toMatch(/at least 1/);
    expect(validateMappingInput({ ...base, keepNewest: 2.5 })).toMatch(/at least 1/);
    expect(validateMappingInput({ ...base, keepNewest: 3 })).toBeNull();
  });

  it('reports filter problems before path problems', () => {
    const message = validateMappingInput({
      ...base,
      destPath: base.sourcePath,
      filters: [rule('filename_regex', 'matches', '(')],
    });
    expect(message).toMatch(/^Filter 1/);
  });

  it('includes the path-safety checks', () => {
    expect(validateMappingInput({ ...base, destPath: 'c:/IN' })).toMatch(/same folder/);
  });
});
