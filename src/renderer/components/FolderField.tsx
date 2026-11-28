import { useEffect, useState } from 'react';
import { cleanFolderInput } from '../../shared/pathSafety';
import type { FolderCheck, FolderRole } from '../../shared/types';
import { isWebMode } from '../utils/platform';
import FolderBrowserDialog from './FolderBrowserDialog';

interface Props {
  label: string;
  value: string;
  role: FolderRole;
  browseTitle: string;
  onChange: (value: string) => void;
  /** The machine the folder is on. Absent: the one running the app. */
  workerId?: string | null;
  /** True for a machine other than this one: its folders can only be browsed in the page. */
  remote?: boolean;
}

const CHECK_DELAY_MS = 350;

/** A folder path you can type or paste into, check as you go, or pick with Browse (which opens at the current value). */
export default function FolderField({ label, value, role, browseTitle, onChange, workerId, remote }: Props) {
  const [check, setCheck] = useState<FolderCheck | null>(null);
  const [browsing, setBrowsing] = useState(false);

  useEffect(() => {
    if (!cleanFolderInput(value)) {
      setCheck(null);
      return;
    }
    let stale = false;
    const timer = setTimeout(() => {
      void window.fileshuttleAPI.dialogs.checkFolder(value, role, workerId ?? null).then(
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
  }, [value, role, workerId]);

  const browse = async () => {
    // On the phone there is no native dialog, and another machine's folders are not on this one: browse in the page.
    if (isWebMode() || remote) {
      setBrowsing(true);
      return;
    }
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
      {browsing && (
        <FolderBrowserDialog
          title={browseTitle}
          startAt={value}
          workerId={workerId}
          onCancel={() => setBrowsing(false)}
          onPick={(picked) => {
            setBrowsing(false);
            onChange(picked);
          }}
        />
      )}
      {check?.message && (
        <p className={problem ? 'error-text' : 'muted'} style={{ margin: '4px 0 0' }}>{check.message}</p>
      )}
    </div>
  );
}
