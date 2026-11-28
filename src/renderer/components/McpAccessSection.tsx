import { useEffect, useState } from 'react';
import type { McpTokenInfo } from '../../shared/types';
import { errorMessage } from '../utils/errors';

/** Settings > Claude access (MCP), desktop only: tokens that let Claude manage File Shuttle through its MCP server. */
export default function McpAccessSection() {
  const [tokens, setTokens] = useState<McpTokenInfo[] | null>(null);
  const [name, setName] = useState('');
  const [fresh, setFresh] = useState<{ name: string; token: string } | null>(null);
  const [copied, setCopied] = useState(false);
  const [problem, setProblem] = useState('');
  const api = window.fileshuttleAPI.mcp;

  const reload = () => api.listTokens().then(setTokens, (err) => setProblem(errorMessage(err)));
  useEffect(() => {
    void reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const create = async () => {
    setProblem('');
    setCopied(false);
    try {
      setFresh(await api.createToken(name));
      setName('');
      await reload();
    } catch (err) {
      setProblem(errorMessage(err));
    }
  };

  const revoke = async (tokenName: string) => {
    setProblem('');
    try {
      await api.revokeToken(tokenName);
      if (fresh?.name === tokenName) setFresh(null);
      await reload();
    } catch (err) {
      setProblem(errorMessage(err));
    }
  };

  const copy = async () => {
    if (!fresh) return;
    try {
      await navigator.clipboard.writeText(fresh.token);
      setCopied(true);
    } catch {
      setProblem('Could not copy; select the token and copy it by hand.');
    }
  };

  return (
    <>
      <h2 style={{ fontSize: 16 }}>Claude access (MCP)</h2>
      <p className="muted">
        Lets Claude on your computer manage File Shuttle: look at jobs and history, preview, save, and run. It is part
        of the phone-access server above (same address, <code>/mcp</code>, Tailscale only) and stays off until you make
        a token. Anything that deletes or moves files, or deletes a job or mapping, needs your confirmation first.
        Every call is written to <code>mcp-calls.log</code> in the data folder.
      </p>

      <div className="remote-form">
        <label className="field">
          New token name (for example &quot;Claude Code on laptop&quot;)
          <input type="text" value={name} maxLength={60} onChange={(e) => setName(e.target.value)} />
        </label>
        <button className="outline" disabled={!name.trim()} onClick={() => void create()}>
          Make Token
        </button>
      </div>

      {fresh && (
        <div className="muted" style={{ marginBottom: 8 }}>
          <p>
            Token for &quot;{fresh.name}&quot; (shown only now; copy it somewhere safe):
          </p>
          <p>
            <code style={{ wordBreak: 'break-all' }}>{fresh.token}</code>
          </p>
          <button className="outline" onClick={() => void copy()}>
            {copied ? 'Copied' : 'Copy Token'}
          </button>
          <p>
            Add it to Claude Code with:{' '}
            <code style={{ wordBreak: 'break-all' }}>
              claude mcp add --transport http fileshuttle https://&lt;host&gt;/mcp --header &quot;Authorization: Bearer{' '}
              {fresh.token}&quot;
            </code>
          </p>
        </div>
      )}

      {tokens && tokens.length === 0 && <p className="muted">No tokens yet, so Claude access is off.</p>}
      {tokens?.map((t) => (
        <div key={t.name} className="remote-form">
          <span>
            {t.name}{' '}
            <span className="muted">
              made {new Date(t.createdAt).toLocaleDateString()}
              {t.lastUsedAt ? `, last used ${new Date(t.lastUsedAt).toLocaleString()}` : ', never used'}
            </span>
          </span>
          <button className="outline" onClick={() => void revoke(t.name)}>
            Revoke
          </button>
        </div>
      ))}
      {problem && <p className="error-text">{problem}</p>}
    </>
  );
}
