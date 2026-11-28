import type { WorkerEndpoint } from './workerRuntime';
import type { HubToWorker, WorkerToHub } from '../../shared/workerProtocol';

export class HubUrlError extends Error {}

/**
 * The hub's address as a bare origin. It must be https; plain http is accepted only for this
 * computer itself (127.0.0.1, localhost, ::1), for testing. No credentials, path, query or
 * fragment: this is checked before anything is sent anywhere.
 */
export function validateHubUrl(text: string): string {
  let url: URL;
  try {
    url = new URL(text.trim());
  } catch {
    throw new HubUrlError(`"${text}" is not a web address. Use the hub's https address, for example https://hub.example.ts.net`);
  }
  const host = url.hostname.startsWith('[') ? url.hostname.slice(1, -1) : url.hostname;
  const loopback = host === '127.0.0.1' || host.toLowerCase() === 'localhost' || host === '::1';
  if (url.protocol === 'http:') {
    if (!loopback) throw new HubUrlError('The hub address must start with https://. Plain http is only accepted for this computer itself (127.0.0.1, localhost or ::1).');
  } else if (url.protocol !== 'https:') {
    throw new HubUrlError('The hub address must start with https://.');
  }
  if (url.username || url.password) throw new HubUrlError('The hub address must not contain a user name or password.');
  if ((url.pathname !== '/' && url.pathname !== '') || url.search || url.hash) {
    throw new HubUrlError('The hub address must be just the address (for example https://hub.example.ts.net), without a path or query.');
  }
  return url.origin;
}

export interface PairResult {
  workerId: string;
  name: string;
  token: string;
}

/** Trades a one-time pairing code for this machine's id and token. */
export async function pairWithHub(opts: {
  hubUrl: string;
  code: string;
  name?: string;
  platform?: string;
  fetchImpl?: typeof fetch;
}): Promise<PairResult> {
  const origin = validateHubUrl(opts.hubUrl);
  const doFetch = opts.fetchImpl ?? fetch;
  let response: Response;
  try {
    response = await doFetch(`${origin}/api/workers/pair`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code: opts.code, ...(opts.name ? { name: opts.name } : {}), ...(opts.platform ? { platform: opts.platform } : {}) }),
      redirect: 'error',
      signal: AbortSignal.timeout(20_000),
    });
  } catch {
    throw new Error(`Could not reach the hub at ${origin}. Check the address and that the hub is running.`);
  }
  let body: { ok?: boolean; error?: string; workerId?: string; name?: string; token?: string } = {};
  try {
    body = (await response.json()) as typeof body;
  } catch {
    // Not JSON: handled below.
  }
  if (!response.ok || !body.ok || !body.workerId || !body.token) {
    throw new Error(body.error || `The hub refused the pairing (HTTP ${response.status}).`);
  }
  return { workerId: body.workerId, name: body.name ?? opts.name ?? '', token: body.token };
}

// ---------------------------------------------------------------- the socket

/** The part of a WebSocket the worker uses, so tests can stand in for it. */
export interface WebSocketLike {
  readonly readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  onopen: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: ((ev: { code: number; reason: string }) => void) | null;
  onerror: ((ev: unknown) => void) | null;
}
export type WebSocketFactory = (url: string) => WebSocketLike;

const OPEN = 1;

/** Node's own WebSocket (Node 22+). It sends no Origin header, which the hub requires. */
export function nodeWebSocketFactory(): WebSocketFactory {
  const Ctor = (globalThis as unknown as { WebSocket?: new (url: string) => WebSocketLike }).WebSocket;
  if (!Ctor) throw new Error('This Node.js has no built-in WebSocket. Use Node.js 22 or newer.');
  return (url) => new Ctor(url);
}

export interface RemoteTransportOptions {
  hubUrl: string;
  /** Called each time the socket opens (the first time and after every reconnect). */
  onOpen: () => void;
  log?: (message: string) => void;
  factory?: WebSocketFactory;
  /** First wait and the longest wait between attempts. */
  backoffStartMs?: number;
  backoffMaxMs?: number;
}

/** What the hub says in its close reasons is a plain sentence meant for this log. */
function describeClose(code: number, reason: string): string {
  if (code === 4001 || code === 4002) return reason || 'The hub refused this machine.';
  if (code === 4004) return 'Another connection from this machine took its place.';
  return reason ? `The connection closed (${reason}).` : 'The connection to the hub closed.';
}

/**
 * The worker's end of the network: connects to the hub's socket, reconnects with a growing wait
 * (capped at about a minute), and drops messages while down (the outbox, not this, keeps what matters).
 */
export class RemoteTransport implements WorkerEndpoint {
  private socket: WebSocketLike | null = null;
  private handler: ((message: HubToWorker) => void) | null = null;
  private timer: NodeJS.Timeout | null = null;
  private stopped = true;
  private attempt = 0;
  private openedAt = 0;
  private readonly log: (message: string) => void;
  private readonly factory: WebSocketFactory;
  private readonly url: string;

  constructor(private readonly opts: RemoteTransportOptions) {
    this.log = opts.log ?? (() => undefined);
    this.factory = opts.factory ?? nodeWebSocketFactory();
    const origin = validateHubUrl(opts.hubUrl);
    this.url = `${origin.replace(/^http/, 'ws')}/api/workers/ws`;
  }

  get connected(): boolean {
    return this.socket?.readyState === OPEN;
  }

  onMessage(handler: (message: HubToWorker) => void): void {
    this.handler = handler;
  }

  send(message: WorkerToHub): void {
    if (this.socket?.readyState !== OPEN) return;
    try {
      this.socket.send(JSON.stringify(message));
    } catch {
      // The socket is going down; the close handler reconnects.
    }
  }

  start(): void {
    this.stopped = false;
    this.open();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    try {
      this.socket?.close(1000, 'The worker is stopping.');
    } catch {
      // Already closed.
    }
    this.socket = null;
  }

  private open(): void {
    if (this.stopped) return;
    let socket: WebSocketLike;
    try {
      socket = this.factory(this.url);
    } catch (err) {
      this.log(`Could not start a connection: ${err instanceof Error ? err.message : err}`);
      this.scheduleRetry();
      return;
    }
    this.socket = socket;
    socket.onopen = () => {
      this.openedAt = Date.now();
      this.log('Connected to the hub.');
      this.opts.onOpen();
    };
    socket.onmessage = (event) => {
      if (typeof event.data !== 'string') return;
      try {
        this.handler?.(JSON.parse(event.data) as HubToWorker);
      } catch (err) {
        this.log(`A message from the hub could not be handled: ${err instanceof Error ? err.message : err}`);
      }
    };
    socket.onerror = () => {
      // The close event follows with the details.
    };
    socket.onclose = (event) => {
      if (this.socket === socket) this.socket = null;
      if (this.stopped) return;
      this.log(this.openedAt ? describeClose(event.code, event.reason) : `Could not connect to the hub at ${this.url.replace(/\/api\/.*/, '')}.`);
      // A connection that held for a while starts the waits over.
      if (this.openedAt && Date.now() - this.openedAt > 10_000) this.attempt = 0;
      this.openedAt = 0;
      this.scheduleRetry();
    };
  }

  private scheduleRetry(): void {
    if (this.stopped) return;
    const start = this.opts.backoffStartMs ?? 1000;
    const max = this.opts.backoffMaxMs ?? 60_000;
    const wait = Math.min(max, start * 2 ** Math.min(this.attempt, 10));
    this.attempt++;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.open();
    }, wait);
    this.timer.unref?.();
  }
}
