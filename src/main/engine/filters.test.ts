import { describe, expect, it } from 'vitest';
import { FilterRule } from '../../shared/types';
import { evaluateFilters, matchesFilter, partitionKeepNewest } from './filters';

const DAY = 24 * 60 * 60 * 1000;
const stat = (overrides: Partial<{ size: number; mtimeMs: number; birthtimeMs: number }> = {}) => ({
  size: 100,
  mtimeMs: Date.parse('2024-06-15T12:00:00Z'),
  birthtimeMs: Date.parse('2024-06-01T12:00:00Z'),
  ...overrides,
});
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

describe('extension filter', () => {
  it('matches case-insensitively and ignores a leading dot in the rule', () => {
    expect(matchesFilter('C:\\in\\Photo.JPG', stat(), rule('extension', 'equals', 'jpg'))).toBe(true);
    expect(matchesFilter('C:\\in\\photo.jpg', stat(), rule('extension', 'equals', '.JPG'))).toBe(true);
  });

  it('does not match a different extension', () => {
    expect(matchesFilter('/in/photo.png', stat(), rule('extension', 'equals', 'jpg'))).toBe(false);
  });

  it('uses only the last extension of a multi-dot name', () => {
    expect(matchesFilter('/in/archive.tar.gz', stat(), rule('extension', 'equals', 'gz'))).toBe(true);
    expect(matchesFilter('/in/archive.tar.gz', stat(), rule('extension', 'equals', 'tar'))).toBe(false);
  });
});

describe('filename_glob filter', () => {
  it('supports * and ? wildcards, case-insensitively', () => {
    expect(matchesFilter('/in/Report-2024.pdf', stat(), rule('filename_glob', 'matches', 'report-*.PDF'))).toBe(true);
    expect(matchesFilter('/in/a1.txt', stat(), rule('filename_glob', 'matches', 'a?.txt'))).toBe(true);
    expect(matchesFilter('/in/a12.txt', stat(), rule('filename_glob', 'matches', 'a?.txt'))).toBe(false);
  });

  it('treats regex metacharacters in the pattern literally', () => {
    expect(matchesFilter('/in/a(1).txt', stat(), rule('filename_glob', 'matches', 'a(1).txt'))).toBe(true);
    expect(matchesFilter('/in/aX1X.txt', stat(), rule('filename_glob', 'matches', 'a(1).txt'))).toBe(false);
    expect(matchesFilter('/in/axtxt', stat(), rule('filename_glob', 'matches', 'a.txt'))).toBe(false);
  });

  it('only looks at the file name, not the folders above it', () => {
    expect(matchesFilter('/in/report/readme.md', stat(), rule('filename_glob', 'matches', 'report*'))).toBe(false);
  });
});

describe('filename_regex filter', () => {
  it('tests the regex against the file name', () => {
    expect(matchesFilter('/in/IMG_0042.jpg', stat(), rule('filename_regex', 'matches', '^IMG_\\d+'))).toBe(true);
    expect(matchesFilter('/in/photo.jpg', stat(), rule('filename_regex', 'matches', '^IMG_\\d+'))).toBe(false);
  });
});

describe('size filter', () => {
  it('min is inclusive', () => {
    expect(matchesFilter('/f', stat({ size: 100 }), rule('size', 'min', '100'))).toBe(true);
    expect(matchesFilter('/f', stat({ size: 99 }), rule('size', 'min', '100'))).toBe(false);
  });

  it('max is inclusive', () => {
    expect(matchesFilter('/f', stat({ size: 100 }), rule('size', 'max', '100'))).toBe(true);
    expect(matchesFilter('/f', stat({ size: 101 }), rule('size', 'max', '100'))).toBe(false);
  });
});

describe('date filters', () => {
  const cutoff = '2024-06-10T00:00:00Z';

  it('modified_date before/after', () => {
    expect(matchesFilter('/f', stat(), rule('modified_date', 'after', cutoff))).toBe(true);
    expect(matchesFilter('/f', stat(), rule('modified_date', 'before', cutoff))).toBe(false);
  });

  it('created_date uses the birth time, not the modified time', () => {
    expect(matchesFilter('/f', stat(), rule('created_date', 'before', cutoff))).toBe(true);
    expect(matchesFilter('/f', stat(), rule('created_date', 'after', cutoff))).toBe(false);
  });

  it('is strict at the boundary', () => {
    const exact = Date.parse(cutoff);
    expect(matchesFilter('/f', stat({ mtimeMs: exact }), rule('modified_date', 'before', cutoff))).toBe(false);
    expect(matchesFilter('/f', stat({ mtimeMs: exact }), rule('modified_date', 'after', cutoff))).toBe(false);
  });
});

describe('evaluateFilters', () => {
  const txt = rule('extension', 'equals', 'txt');
  const log = rule('extension', 'equals', 'log', 0);
  const big = rule('size', 'min', '1000', 1);

  it('matches everything when there are no filters', () => {
    expect(evaluateFilters('/f.bin', stat(), [])).toBe(true);
  });

  it('requires every group to be satisfied', () => {
    const rules = [txt, big];
    expect(evaluateFilters('/f.txt', stat({ size: 5000 }), rules)).toBe(true);
    expect(evaluateFilters('/f.txt', stat({ size: 5 }), rules)).toBe(false);
  });

  it('treats rules with their own group each as a required condition', () => {
    const rules = [rule('extension', 'equals', 'txt', 0), rule('size', 'min', '1000', 1)];
    expect(evaluateFilters('/f.bin', stat({ size: 5000 }), rules)).toBe(false);
  });

  it('needs only one rule of a group to match', () => {
    const rules = [txt, log];
    expect(evaluateFilters('/f.txt', stat(), rules)).toBe(true);
    expect(evaluateFilters('/f.log', stat(), rules)).toBe(true);
    expect(evaluateFilters('/f.bin', stat(), rules)).toBe(false);
  });

  it('combines OR groups with AND: (txt OR log) AND big', () => {
    const rules = [txt, log, big];
    expect(evaluateFilters('/f.log', stat({ size: 5000 }), rules)).toBe(true);
    expect(evaluateFilters('/f.log', stat({ size: 5 }), rules)).toBe(false);
    expect(evaluateFilters('/f.bin', stat({ size: 5000 }), rules)).toBe(false);
  });

  it('follows groups by number, not by position in the list', () => {
    const rules = [txt, big, log];
    expect(evaluateFilters('/f.log', stat({ size: 5000 }), rules)).toBe(true);
    expect(evaluateFilters('/f.log', stat({ size: 5 }), rules)).toBe(false);
  });
});

describe('partitionKeepNewest', () => {
  const files = [
    { filePath: '/a', mtimeMs: 1 * DAY },
    { filePath: '/b', mtimeMs: 3 * DAY },
    { filePath: '/c', mtimeMs: 2 * DAY },
  ];

  it('keeps nothing back when keepNewest is null or non-positive', () => {
    expect(partitionKeepNewest(files, null)).toEqual({ kept: [], rest: files });
    expect(partitionKeepNewest(files, 0)).toEqual({ kept: [], rest: files });
  });

  it('keeps the N newest by mtime and returns the rest', () => {
    const { kept, rest } = partitionKeepNewest(files, 2);
    expect(kept.map((f) => f.filePath)).toEqual(['/b', '/c']);
    expect(rest.map((f) => f.filePath)).toEqual(['/a']);
  });

  it('keeps everything when N exceeds the file count', () => {
    const { kept, rest } = partitionKeepNewest(files, 10);
    expect(kept).toHaveLength(3);
    expect(rest).toHaveLength(0);
  });

  it('breaks mtime ties by path so the result is deterministic', () => {
    const tied = [
      { filePath: '/z', mtimeMs: DAY },
      { filePath: '/a', mtimeMs: DAY },
    ];
    expect(partitionKeepNewest(tied, 1).kept[0].filePath).toBe('/a');
  });
});
