import type { FilterRule } from './types';

/**
 * Filters are a list of rules; rules that share a `group` are OR'd and the
 * groups are AND'd, i.e. (a OR b) AND (c) AND (d OR e). Pure helpers so the
 * editor, the card summary and the engine read the list the same way.
 */

/** The rules split into their groups, in order of each group's first appearance. */
export function groupFilters(filters: FilterRule[]): FilterRule[][] {
  const groups = new Map<number, FilterRule[]>();
  for (const rule of filters) {
    const members = groups.get(rule.group);
    if (members) members.push(rule);
    else groups.set(rule.group, [rule]);
  }
  return [...groups.values()];
}

/** Renumbers groups 0..n-1 and keeps each group's rules together, so what is saved is tidy. */
export function normalizeFilterGroups(filters: FilterRule[]): FilterRule[] {
  return groupFilters(filters).flatMap((members, index) => members.map((rule) => ({ ...rule, group: index })));
}

/** Short wording for a filter list on a card; empty string when there are no filters. */
export function describeFilterLogic(filters: FilterRule[]): string {
  if (!filters.length) return '';
  const groups = groupFilters(filters);
  const count = `${filters.length} filter${filters.length !== 1 ? 's' : ''}`;
  if (filters.length === 1) return count;
  if (groups.length === filters.length) return `${count} · match ALL`;
  if (groups.length === 1) return `${count} · match ANY`;
  return `${count} · ${groups.length} groups`;
}
