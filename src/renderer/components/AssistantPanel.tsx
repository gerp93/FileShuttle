import { useCallback, useEffect, useRef, useState } from 'react';
import type { AgentApi, AgentEvent } from '../../shared/agentTypes';
import { groupFilters } from '../../shared/filterGroups';
import type { FilterRule, MappingRecord } from '../../shared/types';

type ChatItem =
  | { type: 'user'; id: string; text: string }
  | { type: 'text'; id: string; text: string }
  | { type: 'tool'; id: string; name: string; input: unknown; result?: { isError: boolean; text: string } }
  | { type: 'note'; id: string; text: string; error?: boolean };

interface Approval {
  requestId: string;
  toolName: string;
  title: string;
  input: unknown;
}

export interface AssistantStatus {
  running: boolean;
  needsApproval: boolean;
}

const EXAMPLES = [
  'Move PDFs from my Downloads folder to Documents\\PDFs every night',
  'Review my jobs and tell me if anything looks risky',
  'Delete files in a temp folder that are older than 30 days',
];

let counter = 0;
const nextId = () => `c${Date.now().toString(36)}-${counter++}`;

function prettyToolName(name: string): string {
  return name.replace(/^mcp__fileshuttle__/, '');
}

function asRecord(value: unknown): Record<string, any> {
  return typeof value === 'object' && value !== null ? (value as Record<string, any>) : {};
}

function describeFilter(rule: FilterRule): string {
  const op = rule.operator === 'equals' || rule.operator === 'matches' ? '' : ` ${rule.operator}`;
  return `${rule.field.replace('_', ' ')}${op} ${rule.value}`;
}

/** "a OR b, AND c" in words, using the same grouping rule as the engine. */
function describeFilters(filters: FilterRule[]): string {
  if (!filters.length) return 'every file';
  return groupFilters(filters)
    .map((group) => group.map(describeFilter).join(' OR '))
    .join('  AND  ');
}

function describeSchedule(job: Record<string, any>): string {
  switch (job.scheduleType) {
    case 'interval':
      return `every ${job.scheduleIntervalMinutes} minute(s)`;
    case 'daily_at':
      return `daily at ${(job.scheduleDailyTimes ?? []).join(', ')}`;
    case 'watch':
      return 'whenever files appear in the first step’s source folder';
    default:
      return 'manual (only when you press Run)';
  }
}

function ApprovalCard({ approval, onAnswer }: { approval: Approval; onAnswer: (allow: boolean) => void }) {
  const [mappings, setMappings] = useState<MappingRecord[]>([]);
  const isJob = approval.toolName.endsWith('save_job');
  const isMapping = approval.toolName.endsWith('save_mapping');

  useEffect(() => {
    if (isJob) void window.fileshuttleAPI.mappings.list().then(setMappings).catch(() => setMappings([]));
  }, [isJob]);

  let rows: [string, string][] = [];
  let destructive = false;
  if (isMapping) {
    const m = asRecord(asRecord(approval.input).mapping);
    destructive = m.actionType === 'delete' || m.conflictPolicy === 'overwrite';
    rows = [
      ['Action', String(m.actionType)],
      ['From', String(m.sourcePath)],
      ...(m.actionType === 'delete' ? [] : ([['To', String(m.destPath)]] as [string, string][])),
      ['Files', describeFilters(m.filters ?? [])],
      ['Subfolders', m.recursive ? 'included' : 'not included'],
      ...(m.actionType === 'delete'
        ? []
        : ([['If a file exists', String(m.conflictPolicy)]] as [string, string][])),
      ...(m.keepNewest != null
        ? ([['Keep newest', `${m.keepNewest}${m.keepNewestPerExtension ? ' per extension' : ''}`]] as [string, string][])
        : []),
    ];
  } else if (isJob) {
    const j = asRecord(asRecord(approval.input).job);
    const names = (j.mappingIds ?? []).map((id: number) => mappings.find((m) => m.id === id)?.name ?? `mapping #${id}`);
    rows = [
      ['Runs', describeSchedule(j)],
      ['Steps', names.map((n: string, i: number) => `${i + 1}. ${n}`).join('\n') || 'none'],
      ['Catch up', j.catchUp ? 'yes' : 'no'],
      ['Saved as', 'switched OFF — you turn it on'],
    ];
  }

  return (
    <div className={`assistant-approval${destructive ? ' assistant-approval-danger' : ''}`}>
      <p className="assistant-approval-title">Needs your OK: {approval.title}</p>
      {destructive && (
        <p className="assistant-approval-warn">This mapping deletes files or replaces existing ones.</p>
      )}
      {rows.length > 0 && (
        <dl className="assistant-approval-rows">
          {rows.map(([label, value]) => (
            <div key={label}>
              <dt>{label}</dt>
              <dd>{value}</dd>
            </div>
          ))}
        </dl>
      )}
      <details>
        <summary className="muted">Details</summary>
        <pre className="assistant-code">{JSON.stringify(approval.input, null, 2)}</pre>
      </details>
      <div className="assistant-btn-row">
        <button type="button" className="primary" onClick={() => onAnswer(true)}>
          Save
        </button>
        <button type="button" className="outline" onClick={() => onAnswer(false)}>
          Decline
        </button>
      </div>
    </div>
  );
}

export default function AssistantPanel({
  agent,
  onClose,
  onStatus,
  onDataChanged,
}: {
  agent: AgentApi;
  onClose: () => void;
  onStatus: (status: AssistantStatus) => void;
  onDataChanged: () => void;
}) {
  const [items, setItems] = useState<ChatItem[]>([]);
  const [approvals, setApprovals] = useState<Approval[]>([]);
  const [running, setRunning] = useState(false);
  const [draft, setDraft] = useState('');
  const [loggedIn, setLoggedIn] = useState<boolean | null>(null);
  const [login, setLogin] = useState<{ state: 'idle' | 'started' | 'failed'; url?: string; message?: string }>({
    state: 'idle',
  });
  const [loginCode, setLoginCode] = useState('');
  const listRef = useRef<HTMLDivElement>(null);

  const handleEvent = useCallback(
    (event: AgentEvent) => {
      switch (event.kind) {
        case 'text':
          setItems((prev) => {
            const at = prev.findIndex((i) => i.type === 'text' && i.id === event.key);
            if (at === -1) return [...prev, { type: 'text', id: event.key, text: event.text }];
            const next = prev.slice();
            next[at] = { type: 'text', id: event.key, text: event.text };
            return next;
          });
          break;
        case 'tool':
          setItems((prev) =>
            prev.some((i) => i.type === 'tool' && i.id === event.id)
              ? prev
              : [...prev, { type: 'tool', id: event.id, name: event.name, input: event.input }]
          );
          break;
        case 'tool_result':
          setItems((prev) =>
            prev.map((i) =>
              i.type === 'tool' && i.id === event.id
                ? { ...i, result: { isError: event.isError, text: event.text } }
                : i
            )
          );
          break;
        case 'approval':
          setApprovals((prev) => [...prev, event]);
          break;
        case 'approval_done':
          setApprovals((prev) => prev.filter((a) => a.requestId !== event.requestId));
          break;
        case 'running':
          setRunning(event.running);
          break;
        case 'done':
          if (event.isError) {
            setItems((prev) => [...prev, { type: 'note', id: nextId(), text: 'The assistant hit an error.', error: true }]);
          }
          break;
        case 'data_changed':
          onDataChanged();
          break;
        case 'auth_required':
          setLoggedIn(false);
          break;
        case 'login':
          if (event.state === 'ok') {
            setLoggedIn(true);
            setLogin({ state: 'idle' });
            setLoginCode('');
          } else {
            setLogin({ state: event.state, url: event.url, message: event.message });
          }
          break;
        case 'error':
          setItems((prev) => [...prev, { type: 'note', id: nextId(), text: event.message, error: true }]);
          break;
      }
    },
    [onDataChanged]
  );

  useEffect(() => agent.onEvent(handleEvent), [agent, handleEvent]);

  useEffect(() => {
    void agent.authStatus().then((s) => setLoggedIn(s.loggedIn)).catch(() => setLoggedIn(null));
  }, [agent]);

  useEffect(() => {
    onStatus({ running, needsApproval: approvals.length > 0 });
  }, [running, approvals.length, onStatus]);

  useEffect(() => {
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [items, approvals]);

  async function send(text: string) {
    const trimmed = text.trim();
    if (!trimmed || running) return;
    setDraft('');
    setItems((prev) => [...prev, { type: 'user', id: nextId(), text: trimmed }]);
    const result = await agent.send(trimmed);
    if (result.status === 'error') {
      setItems((prev) => [...prev, { type: 'note', id: nextId(), text: result.message, error: true }]);
    }
  }

  async function newChat() {
    await agent.reset();
    setItems([]);
    setApprovals([]);
  }

  return (
    <section className="assistant-panel" aria-label="Assistant">
      <div className="assistant-header">
        <h2>Assistant</h2>
        <div className="assistant-btn-row">
          {items.length > 0 && (
            <button type="button" className="outline" onClick={() => void newChat()}>
              New chat
            </button>
          )}
          <button type="button" className="outline" onClick={onClose}>
            Close
          </button>
        </div>
      </div>

      <p className="muted assistant-intro">
        Describe what you want moved, copied, deleted or zipped, and when. It sets up the mapping and job for you to
        review, and asks if anything is missing.
      </p>
      <details className="assistant-scope">
        <summary>What it can and can&apos;t do</summary>
        <ul>
          <li>
            <strong>Can:</strong> look at your mappings, jobs and history; list the names, sizes and dates of files in a
            folder; preview what a mapping would do (nothing changes); and save mappings and jobs after you approve each one.
          </li>
          <li>
            <strong>Can&apos;t:</strong> run, delete, undo or switch on anything, or read what is inside your files. Every
            job it saves is <strong>switched off</strong> until you review and enable it.
          </li>
          <li>File names and folder paths it looks at are sent to Claude to answer you. File contents never are.</li>
        </ul>
      </details>

      {loggedIn === false && (
        <div className="assistant-banner">
          <p>Sign in to Claude to use the assistant. It opens your browser; FileShuttle never sees your password.</p>
          <button
            type="button"
            className="primary"
            disabled={login.state === 'started'}
            onClick={() => {
              setLogin({ state: 'started' });
              void agent.login();
            }}
          >
            {login.state === 'started' ? 'Waiting for sign-in…' : 'Sign in'}
          </button>
          {login.state === 'started' && (
            <>
              <p className="muted">After you authorize in the browser it shows a code. Paste it here:</p>
              <form
                className="assistant-form"
                onSubmit={(e) => {
                  e.preventDefault();
                  if (loginCode.trim()) void agent.submitLoginCode(loginCode);
                  setLoginCode('');
                }}
              >
                <input
                  className="assistant-input"
                  value={loginCode}
                  placeholder="Paste the code from your browser"
                  onChange={(e) => setLoginCode(e.target.value)}
                />
                <button type="submit" className="primary" disabled={!loginCode.trim()}>
                  Submit
                </button>
              </form>
              {login.message && <p className="muted">{login.message}</p>}
              {login.url && (
                <p className="muted">
                  Browser didn&apos;t open?{' '}
                  <a href={login.url} target="_blank" rel="noreferrer">
                    Open the sign-in page
                  </a>
                </p>
              )}
            </>
          )}
          {login.state === 'failed' && <p className="error-text">Sign-in failed: {login.message ?? 'unknown error'}</p>}
        </div>
      )}

      <div className="assistant-list" ref={listRef}>
        {items.length === 0 && (
          <div className="assistant-examples">
            {EXAMPLES.map((example) => (
              <button
                key={example}
                type="button"
                className="assistant-chip"
                disabled={running || loggedIn === false}
                onClick={() => void send(example)}
              >
                {example}
              </button>
            ))}
          </div>
        )}
        {items.map((item) => {
          if (item.type === 'user') {
            return (
              <div key={item.id} className="assistant-msg assistant-user">
                {item.text}
              </div>
            );
          }
          if (item.type === 'text') {
            return (
              <div key={item.id} className="assistant-msg assistant-reply">
                {item.text}
              </div>
            );
          }
          if (item.type === 'note') {
            return (
              <div key={item.id} className={`assistant-note${item.error ? ' assistant-note-error' : ''}`}>
                {item.text}
              </div>
            );
          }
          return (
            <details key={item.id} className={`assistant-tool${item.result?.isError ? ' assistant-tool-error' : ''}`}>
              <summary>
                <code>{prettyToolName(item.name)}</code>
                {!item.result && <span className="muted"> running…</span>}
                {item.result?.isError && <span className="muted"> failed</span>}
              </summary>
              <pre className="assistant-code">{JSON.stringify(item.input, null, 2)}</pre>
              {item.result && <pre className="assistant-code">{item.result.text}</pre>}
            </details>
          );
        })}
        {approvals.map((approval) => (
          <ApprovalCard
            key={approval.requestId}
            approval={approval}
            onAnswer={(allow) => void agent.approve(approval.requestId, allow)}
          />
        ))}
        {running && approvals.length === 0 && <div className="assistant-note">Working…</div>}
      </div>

      <form
        className="assistant-form"
        onSubmit={(e) => {
          e.preventDefault();
          void send(draft);
        }}
      >
        <textarea
          className="assistant-input"
          rows={3}
          value={draft}
          placeholder="e.g. Every night at 2am, move .zip files over 100 MB from Downloads to D:\Archive"
          disabled={loggedIn === false}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              void send(draft);
            }
          }}
        />
        {running ? (
          <button type="button" className="primary" onClick={() => void agent.interrupt()}>
            Stop
          </button>
        ) : (
          <button type="submit" className="primary" disabled={!draft.trim() || loggedIn === false}>
            Send
          </button>
        )}
      </form>
    </section>
  );
}
