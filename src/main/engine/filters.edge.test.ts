import { describe, expect, it } from 'vitest';
import { FilterRule } from '../../shared/types';
import { matchesFilter } from './filters';

const stat = () => ({ size: 100, mtimeMs: Date.parse('2024-06-15T12:00:00Z'), birthtimeMs: Date.parse('2024-06-01T12:00:00Z') });
const rule = (field: FilterRule['field'], operator: FilterRule['operator'], value: string): FilterRule => ({
  field,
  operator,
  value,
});

describe('extension edge cases', () => {
  it('treats a name with no dot as having no extension', () => {
    expect(matchesFilter('/in/README', stat(), rule('extension', 'equals', 'readme'))).toBe(false);
    expect(matchesFilter('/in/README', stat(), rule('extension', 'equals', ''))).toBe(true);
  });

  it('treats a leading-dot-only name as having no extension', () => {
    expect(matchesFilter('/in/.gitignore', stat(), rule('extension', 'equals', 'gitignore'))).toBe(false);
  });

  it('still finds the extension of a dotfile that has one', () => {
    expect(matchesFilter('/in/.backup.zip', stat(), rule('extension', 'equals', 'zip'))).toBe(true);
  });
});

describe('invalid filter values fail loudly instead of matching nothing', () => {
  it('throws for a size that is not a number', () => {
    expect(() => matchesFilter('/f', stat(), rule('size', 'min', '5MB'))).toThrow(/Invalid size/);
    expect(() => matchesFilter('/f', stat(), rule('size', 'min', ''))).toThrow(/Invalid size/);
  });

  it('throws for an unparseable date', () => {
    expect(() => matchesFilter('/f', stat(), rule('modified_date', 'before', 'soon'))).toThrow(/Invalid date/);
  });
});
