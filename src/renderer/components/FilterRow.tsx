import { FilterRule } from '../../shared/types';

const FIELD_LABELS: Record<string, string> = {
  extension: 'File extension',
  filename_glob: 'Filename (wildcard)',
  filename_regex: 'Filename (regex)',
  size: 'File size (bytes)',
  modified_date: 'Modified date',
  created_date: 'Created date',
};

const OPERATORS_BY_FIELD: Record<string, Array<[string, string]>> = {
  extension: [['equals', 'is']],
  filename_glob: [['matches', 'matches pattern']],
  filename_regex: [['matches', 'matches regex']],
  size: [['min', 'at least'], ['max', 'at most']],
  modified_date: [['before', 'before'], ['after', 'after']],
  created_date: [['before', 'before'], ['after', 'after']],
};

const VALUE_HINTS: Record<string, string> = {
  extension: 'e.g. pdf',
  filename_glob: 'e.g. *.bak',
  filename_regex: 'e.g. ^invoice_\\d+',
  size: 'bytes, e.g. 1048576',
  modified_date: 'YYYY-MM-DD',
  created_date: 'YYYY-MM-DD',
};

interface Props {
  rule: FilterRule;
  onChange: (rule: FilterRule) => void;
  onRemove: () => void;
}

export default function FilterRow({ rule, onChange, onRemove }: Props) {
  const operators = OPERATORS_BY_FIELD[rule.field] ?? [['equals', 'is']];

  const setField = (field: string) => {
    const ops = OPERATORS_BY_FIELD[field] ?? [['equals', 'is']];
    onChange({ field: field as FilterRule['field'], operator: ops[0][0] as FilterRule['operator'], value: '' });
  };

  return (
    <div className="filter-row">
      <label className="field">
        Field
        <select value={rule.field} onChange={(e) => setField(e.target.value)}>
          {Object.entries(FIELD_LABELS).map(([k, v]) => (
            <option key={k} value={k}>{v}</option>
          ))}
        </select>
      </label>
      <label className="field">
        Operator
        <select
          value={rule.operator}
          onChange={(e) => onChange({ ...rule, operator: e.target.value as FilterRule['operator'] })}
        >
          {operators.map(([k, v]) => (
            <option key={k} value={k}>{v}</option>
          ))}
        </select>
      </label>
      <label className="field grow">
        Value
        <input
          type="text"
          value={rule.value}
          placeholder={VALUE_HINTS[rule.field]}
          onChange={(e) => onChange({ ...rule, value: e.target.value })}
        />
      </label>
      <button className="text danger" onClick={onRemove} title="Remove filter">✕</button>
    </div>
  );
}
