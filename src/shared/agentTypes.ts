/** Events streamed from the in-app assistant (main process) to the chat panel. */
export type AgentEvent =
  /** Upsert a text block. `key` is stable per block, so streamed deltas and the final text replace each other. */
  | { kind: 'text'; key: string; text: string }
  | { kind: 'tool'; id: string; name: string; input: unknown }
  | { kind: 'tool_result'; id: string; isError: boolean; text: string }
  /** The assistant wants to save something and needs the user's OK first. */
  | { kind: 'approval'; requestId: string; toolName: string; title: string; input: unknown }
  | { kind: 'approval_done'; requestId: string }
  | { kind: 'running'; running: boolean }
  | { kind: 'done'; costUsd: number | null; isError: boolean }
  /** The assistant saved a mapping or job: pages that list them should reload. */
  | { kind: 'data_changed' }
  /** Claude isn't signed in (or the session expired). The panel offers a Sign in button. */
  | { kind: 'auth_required' }
  | { kind: 'login'; state: 'started' | 'ok' | 'failed'; message?: string; url?: string }
  | { kind: 'error'; message: string };

export interface AgentApi {
  /** Send a user message. Resolves once the turn is accepted; progress arrives via onEvent. */
  send: (text: string) => Promise<{ status: 'ok' } | { status: 'error'; message: string }>;
  interrupt: () => Promise<void>;
  /** Forget the conversation and start fresh. */
  reset: () => Promise<void>;
  approve: (requestId: string, allow: boolean) => Promise<void>;
  /** Run the bundled Claude's browser sign-in. */
  login: () => Promise<void>;
  /** Hand the code shown in the browser back to the sign-in process. */
  submitLoginCode: (code: string) => Promise<void>;
  authStatus: () => Promise<{ loggedIn: boolean }>;
  /** Subscribe to events; returns an unsubscribe function. */
  onEvent: (listener: (event: AgentEvent) => void) => () => void;
}
