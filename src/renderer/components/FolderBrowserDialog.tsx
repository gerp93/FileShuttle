import { useCallback, useEffect, useState } from 'react';
import type { FolderListing } from '../../shared/types';
import { errorMessage } from '../utils/errors';

interface Props {
  title: string;
  /** Where to start; empty opens the list of drives / roots. */
  startAt: string;
  onPick: (path: string) => void;
  onCancel: () => void;
  /** The machine whose folders are listed. Absent: the one running the app. */
  workerId?: string | null;
}

/** Stands in for the native folder picker when the page is open on the phone. */
export default function FolderBrowserDialog({ title, startAt, onPick, onCancel, workerId }: Props) {
  const [listing, setListing] = useState<FolderListing | null>(null);
  const [typed, setTyped] = useState(startAt);
  const [loading, setLoading] = useState(true);
  const [failure, setFailure] = useState('');

  const open = useCallback(async (target: string | null) => {
    setLoading(true);
    setFailure('');
    try {
      const result = await window.fileshuttleAPI.dialogs.listFolder(target, workerId ?? null);
      setListing(result);
      setTyped(result.path ?? '');
    } catch (err) {
      setFailure(errorMessage(err));
    } finally {
      setLoading(false);
    }
  }, [workerId]);

  useEffect(() => {
    void open(startAt.trim() ? startAt : null);
    // Only the first open uses startAt.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const current = listing?.path ?? null;
  const problem = failure || listing?.error || '';

  return (
    <div className="dialog-overlay">
      <div className="dialog folder-browser">
        <h3 style={{ marginTop: 0 }}>{title}</h3>
        <form
          className="field-row"
          onSubmit={(e) => {
            e.preventDefault();
            void open(typed.trim() ? typed : null);
          }}
        >
          <label className="field grow">
            Folder path
            <input type="text" value={typed} spellCheck={false} onChange={(e) => setTyped(e.target.value)} />
          </label>
          <button className="outline" type="submit">Go</button>
        </form>
        <div className="folder-browser-nav">
          <button className="outline" disabled={!listing || listing.parent === null || loading} onClick={() => void open(listing?.parent ?? null)}>
            ↑ Up
          </button>
          <button className="outline" disabled={loading} onClick={() => void open(null)}>Drives</button>
        </div>
        {problem && <p className="error-text">{problem}</p>}
        <div className="folder-browser-list" aria-busy={loading}>
          {loading && <p className="muted">Loading…</p>}
          {!loading && listing && listing.folders.length === 0 && !problem && (
            <p className="muted">No subfolders here.</p>
          )}
          {!loading &&
            listing?.folders.map((folder) => (
              <button key={folder.path} type="button" className="folder-browser-item" onClick={() => void open(folder.path)}>
                📁 {folder.name}
              </button>
            ))}
          {!loading && listing?.truncated && <p className="muted">Only the first folders are shown. Type the path to go further.</p>}
        </div>
        <div className="dialog-actions">
          <button className="outline" onClick={onCancel}>Cancel</button>
          <button className="primary" disabled={!current || !!listing?.error} onClick={() => current && onPick(current)}>
            Use this folder
          </button>
        </div>
      </div>
    </div>
  );
}
