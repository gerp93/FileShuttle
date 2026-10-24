import { useEffect, useState } from 'react';
import { cleanFolderInput } from '../../shared/pathSafety';
import type { FolderCheck, FolderRole } from '../../shared/types';

interface Props {
  label: string;
  value: string;
  role: FolderRole;
  browseTitle: string;
  onChange: (value: string) => void;
}

const CHECK_DELAY_MS = 350;

/** A folder path you can type or paste into, check as you go, or pick with Browse (which opens at the current value). */
export default function FolderField({ label, value, role, browseTitle, onChange }: Props) {
  const [check, setCheck] = useState<FolderCheck | null>(null);

  useEffect(() => {
    if (!cleanFolderInput(value)) {
      setCheck(null);
      return;
    }
    let stale = false;
    const timer = setTimeout(() => {
      void window.fileshuttleAPI.dialogs.checkFolder(value, role).then(
        (result) => {
          if (!stale) setCheck(result);
        },
        () => {
          if (!stale) setCheck(null);
        }
      );
    }, CHECK_DELAY_MS);
    return () => {
      stale = true;
      clearTimeout(timer);
    };
  }, [value, role]);

  const browse = async () => {
    const picked = await window.fileshuttleAPI.dialogs.pickFolder(browseTitle, value);
    if (picked) onChange(picked);
  };

  const problem = check !== null && check.status !== 'ok' && check.status !== 'will_create';

  return (
    <div style={{ marginBottom: 12 }}>
      <div className="field-row">
        <label className="field grow">
          {label}
          <input
            type="text"
            value={value}
            spellCheck={false}
            aria-invalid={problem || undefined}
            onChange={(e) => onChange(e.target.value)}
            onBlur={() => {
              const cleaned = cleanFolderInput(value);
              if (cleaned !== value) onChange(cleaned);
            }}
          />
        </label>
        <button className="outline" onClick={() => void browse()}>Browse</button>
      </div>
      {check?.message && (
        <p className={problem ? 'error-text' : 'muted'} style={{ margin: '4px 0 0' }}>{check.message}</p>
      )}
    </div>
  );
}
