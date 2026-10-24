import type { FilterRule } from '../../shared/types';
import FilterRow from './FilterRow';

interface Props {
  filters: FilterRule[];
  onChange: (filters: FilterRule[]) => void;
}

const NEW_RULE: Omit<FilterRule, 'group'> = { field: 'extension', operator: 'equals', value: '' };

/**
 * Edits the filter list as boxes. Rows inside a box are OR'd; the boxes are AND'd.
 * `filters` stays a flat list; a box is just the rules that share a `group`.
 */
export default function FilterGroupsEditor({ filters, onChange }: Props) {
  // Box order = order each group number first appears in the list.
  const groupIds = [...new Set(filters.map((rule) => rule.group))];

  const update = (index: number, rule: FilterRule) => onChange(filters.map((r, i) => (i === index ? rule : r)));
  const remove = (index: number) => onChange(filters.filter((_, i) => i !== index));
  const addToGroup = (group: number) => onChange([...filters, { ...NEW_RULE, group }]);
  const addGroup = () => onChange([...filters, { ...NEW_RULE, group: Math.max(-1, ...groupIds) + 1 }]);

  return (
    <div>
      {groupIds.map((group, boxIndex) => {
        const members = filters.map((rule, index) => ({ rule, index })).filter(({ rule }) => rule.group === group);
        return (
          <div key={group}>
            {boxIndex > 0 && <p className="muted filter-join">AND</p>}
            <div className="filter-group">
              {members.map(({ rule, index }, memberIndex) => (
                <div key={index}>
                  {memberIndex > 0 && <p className="muted filter-join">OR</p>}
                  <FilterRow rule={rule} onChange={(updated) => update(index, updated)} onRemove={() => remove(index)} />
                </div>
              ))}
              <button className="text" onClick={() => addToGroup(group)}>+ Or another condition</button>
            </div>
          </div>
        );
      })}
      <button className="text" onClick={addGroup}>{filters.length ? '+ And another condition' : '+ Add filter'}</button>
      {filters.length > 0 && (
        <p className="muted" style={{ margin: '8px 0 0' }}>
          A file is picked up when it satisfies every box. Within a box, matching any one row is enough.
        </p>
      )}
    </div>
  );
}
