import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { FilterRule } from '../../shared/types';
import FilterGroupsEditor from './FilterGroupsEditor';

const rule = (value: string, group: number): FilterRule => ({ field: 'extension', operator: 'equals', value, group });
const html = (filters: FilterRule[]) => renderToStaticMarkup(<FilterGroupsEditor filters={filters} onChange={() => undefined} />);
const count = (text: string, needle: string) => text.split(needle).length - 1;

describe('FilterGroupsEditor', () => {
  it('offers just an add button when there are no filters', () => {
    const out = html([]);
    expect(out).toContain('+ Add filter');
    expect(out).not.toContain('filter-group');
  });

  it('joins rules inside a box with OR and boxes with AND', () => {
    const out = html([rule('zip', 0), rule('bak', 0), rule('x', 1)]);
    expect(count(out, 'class="filter-group"')).toBe(2);
    expect(count(out, '>OR<')).toBe(1);
    expect(count(out, '>AND<')).toBe(1);
  });
});
