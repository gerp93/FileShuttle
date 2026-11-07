import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import * as fs from 'fs';
import type { PermissionResult, Query, SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import type { AgentEvent } from '../../shared/agentTypes';
import { buildSystemPrompt } from './prompt';
import { assistantAvailable, claudeExecutablePath, loadSdk } from './sdk';
import { AgentContext, createFileShuttleServer, READ_ONLY_TOOLS, SERVER_NAME, WRITE_TOOLS } from './tools';

/**
 * The assistant is given NO built-in Claude Code tools at all (no Read, Bash, Write, web...): the
 * only things it can do are the FileShuttle tools, and of those only saving a mapping or job
 * changes anything, after the user approves it.
 */
const DISALLOWED_TOOLS = [
  'Bash',
  'Read',
  'Write',
  'Edit',
  'NotebookEdit',
  'Glob',
  'Grep',
  'WebFetch',
  'WebSearch',
  'Task',
  'Agent',
  'TodoWrite',
];

const MAX_TURNS = 60;
const LOGIN_TIMEOUT_MS = 5 * 60_000;

interface Pending {
  toolName: string;
  input: Record<string, unknown>;
  resolve: (result: PermissionResult) => void;
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
}

/** One-line description of what an approval is for. */
export function describeTool(toolName: string, input: Record<string, unknown>): string {
  const prefix = `mcp__${SERVER_NAME}__`;
  if (toolName.startsWith(prefix)) {
    const action = toolName.slice(prefix.length);
    if (action === 'save_mapping') {
      const mapping = asRecord(input.mapping);
      return `${mapping.id != null ? 'Update' : 'Create'} mapping: ${String(mapping.name ?? '')}`;
    }
    if (action === 'save_job') {
      const job = asRecord(input.job);
      return `${job.id != null ? 'Update' : 'Create'} job (saved switched off): ${String(job.name ?? '')}`;
    }
    return action;
  }
  return `Use ${toolName}`;
}

function toolResultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((block) => (asRecord(block).type === 'text' ? String(asRecord(block).text ?? '') : ''))
      .filter(Boolean)
      .join('\n');
  }
  return '';
}

export class AgentSession {
  private sessionId: string | undefined;
  private query: Query | null = null;
  private abort: AbortController | null = null;
  private pending = new Map<string, Pending>();
  private loginProcess: ReturnType<typeof spawn> | null = null;

  constructor(
    private readonly emit: (event: AgentEvent) => void,
    private readonly context: AgentContext,
    /** A folder for the Claude runtime to keep its conversation files in. Not a folder the user's files are in. */
    private readonly workspace: string
  ) {}

  get running(): boolean {
    return this.query != null;
  }

  async send(text: string): Promise<{ status: 'ok' } | { status: 'error'; message: string }> {
    if (this.query) return { status: 'error', message: 'The assistant is still working on the last message.' };
    const available = assistantAvailable();
    if (!available.ok) return { status: 'error', message: available.message };

    try {
      fs.mkdirSync(this.workspace, { recursive: true });
      const sdk = await loadSdk();
      this.abort = new AbortController();
      // Saving changes the app's data; tell the UI so lists reload.
      const context: AgentContext = {
        getDb: this.context.getDb,
        afterChange: () => {
          this.context.afterChange();
          this.emit({ kind: 'data_changed' });
        },
      };
      this.query = sdk.query({
        prompt: text,
        options: {
          cwd: this.workspace,
          resume: this.sessionId,
          abortController: this.abort,
          pathToClaudeCodeExecutable: claudeExecutablePath(),
          // Hermetic: ignore the user's own Claude settings, hooks and skills.
          settingSources: [],
          // Only the FileShuttle tools. Without these two, the user's own Claude account connectors
          // (mail, docs...) would be offered to the assistant too.
          strictMcpConfig: true,
          settings: { disableClaudeAiConnectors: true },
          systemPrompt: { type: 'preset', preset: 'claude_code', append: buildSystemPrompt() },
          includePartialMessages: true,
          maxTurns: MAX_TURNS,
          tools: [],
          disallowedTools: DISALLOWED_TOOLS,
          mcpServers: { [SERVER_NAME]: createFileShuttleServer(sdk, context) },
          allowedTools: READ_ONLY_TOOLS,
          permissionMode: 'default',
          canUseTool: (toolName, input, options) => this.decide(toolName, input, options.requestId, options.signal),
        },
      });
    } catch (e) {
      this.query = null;
      this.abort = null;
      return { status: 'error', message: e instanceof Error ? e.message : String(e) };
    }

    this.emit({ kind: 'running', running: true });
    void this.pump(this.query);
    return { status: 'ok' };
  }

  private async pump(query: Query): Promise<void> {
    const streamed = new Map<string, string>();
    let currentMessageId = '';
    let authFailed = false;
    let authAnnounced = false;
    const announceAuth = () => {
      if (authAnnounced) return;
      authAnnounced = true;
      this.emit({ kind: 'auth_required' });
    };

    try {
      for await (const message of query) {
        const m = message as SDKMessage;
        if (m.type === 'system' && m.subtype === 'init') {
          this.sessionId = m.session_id;
        } else if (m.type === 'stream_event' && m.parent_tool_use_id == null) {
          const event = m.event;
          if (event.type === 'message_start') {
            currentMessageId = event.message.id;
          } else if (
            event.type === 'content_block_delta' &&
            event.delta.type === 'text_delta' &&
            currentMessageId
          ) {
            const key = `${currentMessageId}:${event.index}`;
            const text = (streamed.get(key) ?? '') + event.delta.text;
            streamed.set(key, text);
            this.emit({ kind: 'text', key, text });
          }
        } else if (m.type === 'assistant' && m.parent_tool_use_id == null) {
          if (m.error === 'authentication_failed') authFailed = true;
          m.message.content.forEach((block, index) => {
            if (block.type === 'text') {
              if (m.error) return; // surfaced via auth_required / error below
              this.emit({ kind: 'text', key: `${m.message.id}:${index}`, text: block.text });
            } else if (block.type === 'tool_use') {
              this.emit({ kind: 'tool', id: block.id, name: block.name, input: block.input });
            }
          });
        } else if (m.type === 'user' && Array.isArray(m.message.content)) {
          for (const block of m.message.content) {
            if (typeof block === 'object' && block.type === 'tool_result') {
              this.emit({
                kind: 'tool_result',
                id: block.tool_use_id,
                isError: Boolean(block.is_error),
                text: toolResultText(block.content).slice(0, 4000),
              });
            }
          }
        } else if (m.type === 'result') {
          if (authFailed) announceAuth();
          else this.emit({ kind: 'done', costUsd: m.total_cost_usd ?? null, isError: m.is_error });
        }
      }
    } catch (e) {
      // The SDK throws after yielding an error result; a sign-in problem is already reported.
      if (authFailed) announceAuth();
      else if (!this.abort?.signal.aborted) {
        this.emit({ kind: 'error', message: e instanceof Error ? e.message : String(e) });
      }
    } finally {
      this.denyAllPending('The assistant stopped.');
      this.query = null;
      this.abort = null;
      this.emit({ kind: 'running', running: false });
    }
  }

  /** Reads run on their own, saves ask the user, and anything else is refused. */
  private decide(
    toolName: string,
    input: Record<string, unknown>,
    requestId: string | undefined,
    signal: AbortSignal
  ): Promise<PermissionResult> {
    if (READ_ONLY_TOOLS.includes(toolName)) {
      return Promise.resolve({ behavior: 'allow', updatedInput: input });
    }
    if (WRITE_TOOLS.includes(toolName)) return this.askUser(toolName, input, requestId, signal);
    return Promise.resolve({ behavior: 'deny', message: 'The FileShuttle assistant is not allowed to use that tool.' });
  }

  private askUser(
    toolName: string,
    input: Record<string, unknown>,
    requestId: string | undefined,
    signal: AbortSignal
  ): Promise<PermissionResult> {
    const id = requestId ?? randomUUID();
    return new Promise((resolve) => {
      this.pending.set(id, { toolName, input, resolve });
      signal.addEventListener('abort', () => {
        if (this.pending.delete(id)) {
          this.emit({ kind: 'approval_done', requestId: id });
          resolve({ behavior: 'deny', message: 'Cancelled.' });
        }
      });
      this.emit({ kind: 'approval', requestId: id, toolName, title: describeTool(toolName, input), input });
    });
  }

  approve(requestId: string, allow: boolean): void {
    const pending = this.pending.get(requestId);
    if (!pending) return;
    this.pending.delete(requestId);
    this.emit({ kind: 'approval_done', requestId });
    pending.resolve(
      allow
        ? { behavior: 'allow', updatedInput: pending.input }
        : { behavior: 'deny', message: 'The user declined this action.' }
    );
  }

  private denyAllPending(message: string): void {
    for (const [id, pending] of this.pending) {
      this.emit({ kind: 'approval_done', requestId: id });
      pending.resolve({ behavior: 'deny', message });
    }
    this.pending.clear();
  }

  async interrupt(): Promise<void> {
    this.denyAllPending('Interrupted by the user.');
    try {
      await this.query?.interrupt();
    } catch {
      this.abort?.abort();
    }
  }

  async reset(): Promise<void> {
    await this.interrupt();
    this.abort?.abort();
    this.sessionId = undefined;
  }

  /** Run the bundled Claude's browser sign-in. The user finishes it in their browser. */
  login(): Promise<void> {
    if (this.loginProcess) return Promise.resolve();
    return new Promise((resolve) => {
      const child = spawn(claudeExecutablePath(), ['auth', 'login'], {
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      this.loginProcess = child;
      let output = '';
      let announced = false;
      const finish = (event: AgentEvent) => {
        this.loginProcess = null;
        clearTimeout(timer);
        this.emit(event);
        resolve();
      };
      const timer = setTimeout(() => {
        child.kill();
        finish({ kind: 'login', state: 'failed', message: 'Sign-in timed out.' });
      }, LOGIN_TIMEOUT_MS);

      this.emit({ kind: 'login', state: 'started' });
      const onData = (chunk: Buffer) => {
        output += chunk.toString();
        if (/invalid code/i.test(chunk.toString())) {
          this.emit({
            kind: 'login',
            state: 'started',
            url: output.match(/https:\/\/[^\s"'<>]+/)?.[0],
            message: "That code didn't work. Copy the whole code and try again.",
          });
        }
        const url = output.match(/https:\/\/[^\s"'<>]+/)?.[0];
        if (url && !announced) {
          announced = true;
          this.emit({ kind: 'login', state: 'started', url });
        }
      };
      child.stdout?.on('data', onData);
      child.stderr?.on('data', onData);
      child.on('error', (err) => finish({ kind: 'login', state: 'failed', message: err.message }));
      child.on('close', (code) =>
        finish(
          code === 0
            ? { kind: 'login', state: 'ok' }
            : { kind: 'login', state: 'failed', message: output.trim().slice(-300) || `Exited with code ${code}.` }
        )
      );
    });
  }

  /** The browser sign-in can't reach FileShuttle directly, so it shows a code to paste back. */
  submitLoginCode(code: string): void {
    const trimmed = code.trim();
    if (trimmed) this.loginProcess?.stdin?.write(`${trimmed}\n`);
  }

  /** Is the bundled Claude signed in? */
  authStatus(): Promise<{ loggedIn: boolean }> {
    return new Promise((resolve) => {
      const child = spawn(claudeExecutablePath(), ['auth', 'status'], {
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      let out = '';
      child.stdout?.on('data', (chunk: Buffer) => (out += chunk.toString()));
      child.on('error', () => resolve({ loggedIn: false }));
      child.on('close', () => {
        try {
          resolve({ loggedIn: Boolean(JSON.parse(out).loggedIn) });
        } catch {
          resolve({ loggedIn: false });
        }
      });
    });
  }

  dispose(): void {
    this.denyAllPending('FileShuttle is closing.');
    this.abort?.abort();
    this.loginProcess?.kill();
  }
}
