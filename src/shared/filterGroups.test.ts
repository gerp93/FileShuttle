import { describe, expect, it } from 'vitest';
import { describeFilterLogic, groupFilters, normalizeFilterGroups } from './filterGroups';
import type { FilterRule } from './types';

const rule = (value: string, group: number): FilterRule => ({ field: 'extension', operator: 'equals', value, group });

describe('groupFilters', () => {
  it('collects rules by group in order of first appearance', () => {
    const groups = groupFilters([rule('a', 5), rule('b', 2), rule('c', 5)]);
    expect(groups.map((g) => g.map((r) => r.value))).toEqual([['a', 'c'], ['b']]);
  });

  it('returns nothing for an empty list', () => {
    expect(groupFilters([])).toEqual([]);
  });
});

describe('normalizeFilterGroups', () => {
  it('renumbers groups from 0 and keeps each group together', () => {
    const tidy = normalizeFilterGroups([rule('a', 7), rule('b', 3), rule('c', 7)]);
    expect(tidy.map((r) => [r.value, r.group])).toEqual([['a', 0], ['c', 0], ['b', 1]]);
  });
});

describe('describeFilterLogic', () => {
  it('says nothing without filters', () => {
    expect(describeFilterLogic([])).toBe('');
  });

  it('counts a single filter plainly', () => {
    expect(describeFilterLogic([rule('a', 0)])).toBe('1 filter');
  });

  it('reads separate groups as ALL and one shared group as ANY', () => {
    expect(describeFilterLogic([rule('a', 0), rule('b', 1)])).toBe('2 filters · match ALL');
    expect(describeFilterLogic([rule('a', 0), rule('b', 0)])).toBe('2 filters · match ANY');
  });

  it('reports a mix by group count', () => {
    expect(describeFilterLogic([rule('a', 0), rule('b', 0), rule('c', 1)])).toBe('3 filters · 2 groups');
  });
});
