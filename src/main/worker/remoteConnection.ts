import {
  HubToWorker,
  isDurableReport,
  MAX_REPORTS_PER_POST,
  PROTOCOL_VERSION,
  WORKER_ROUTES,
  WorkerToHub,
} from '../../shared/workerProtocol';
import { isLoopbackHost } from '../../shared/hostCheck';
import type { Outbox } from './outbox';
import type { WorkerEndpoint } from './workerRuntime';

/**
 * The network transport, worker side: it replaces the in-process link (worker/inProcess.ts) and
 * speaks the same messages. It connects OUT to the hub's https address and keeps one connection:
 *
 *   - the hub's messages arrive as server-sent events on GET /worker/stream, and the stream is
 *     re-opened after any failure, with a growing, randomised wait (1 s up to a minute);
 *   - the worker's messages leave by POST /worker/report, in batches. Reports that must not be lost
 *     (see isDurableReport) are written to the outbox first and only deleted once the hub has taken
 *     them; the rest (progress, heartbeats) are sent live and dropped when there is no connection.
 *
 * The token goes in an Authorization header, over https. It is never logged. If the hub says the token
 * is not valid (revoked), the connection stops for good: the owner must pair this computer again.
 */

export type ConnectionState = 'stopped' | 'connecting' | 'connected' | 'offline' | 'revoked' | 'incompatible';

export interface ConnectionStatus {
  state: ConnectionState;
  /** ISO time the state last changed. */
  since: string;
  /** The last problem, in words (never the token). */
  lastError: string | null;
  /** Reports waiting in the outbox. */
  queued: number;
  /** When the hub last took a report, if ever in this run. */
  lastDeliveredAt: string | null;
}

export interface RemoteConnectionOptions {
  hubUrl: string;
  token: string;
  outbox: Outbox;
  log?: (message: string) => void;
  /** For tests. */
  fetchImpl?: typeof fetch;
  minBackoffMs?: number;
  maxBackoffMs?: number;
  /** The stream is dropped and re-opened when nothing (not even a keep-alive) arrived for this long. */
  stallMs?: number;
  /** How long to gather live reports into one POST. */
  batchMs?: number;
  onStatus?: (status: ConnectionStatus) => void;
  /** Called once, when the hub refuses the token. */
  onRevoked?: () => void;
}

/** A hub address must be https (it carries a token), or plain http only to this same computer (tests, local use). */
export function normalizeHubUrl(input: string): string {
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    throw new Error('That is not a web address. Use the https address "tailscale serve" prints, for example https://holocron.example.ts.net');
  }
  const secure = url.protocol === 'https:';
  if (!secure && !(url.protocol === 'http:' && isLoopbackHost(url.hostname))) {
    throw new Error('The hub address must start with https:// (a token is sent to it). Use the address "tailscale serve" prints.');
  }
  url.hash = '';
  url.search = '';
  url.username = '';
  url.password = '';
  return url.toString().replace(/\/+$/, '');
}

export function routeUrl(hubUrl: string, route: string, query = ''): string {
  return `${hubUrl.replace(/\/+$/, '')}${route}${query}`;
}

/** Exchanges a pairing code for this computer's worker token. */
export async function pairWithHub(
  hubUrl: string,
  code: string,
  fetchImpl: typeof fetch = fetch
): Promise<{ workerId: string; name: string; token: string; hubUrl: string }> {
  const base = normalizeHubUrl(hubUrl);
  let res: Response;
  try {
    res = await fetchImpl(routeUrl(base, WORKER_ROUTES.pair), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code }),
      signal: AbortSignal.timeout(20_000),
    });
  } catch (err) {
    throw new Error(`Could not reach the hub at ${base}: ${describeNetworkError(err)}`);
  }
  interface PairReply {
    ok?: boolean;
    error?: string;
    workerId?: string;
    name?: string;
    token?: string;
  }
  const body = await res.json().then(
    (value) => value as PairReply | null,
    () => null as PairReply | null
  );
  if (!res.ok || !body?.ok || !body.token || !body.workerId) {
    throw new Error(body?.error ?? `The hub refused the pairing (HTTP ${res.status}).`);
  }
  return { workerId: body.workerId, name: body.name ?? 'This computer', token: body.token, hubUrl: base };
}

export function describeNetworkError(err: unknown): string {
  if (err instanceof Error) {
    const cause = (err as Error & { cause?: { code?: string; message?: string } }).cause;
    return cause?.code ?? cause?.message ?? err.message;
  }
  return String(err);
}

/** Parses a server-sent-event byte stream into the `data:` payloads (comments are keep-alives). */
export class SseParser {
  private buffer = '';
  private readonly decoder = new TextDecoder();

  /** Returns the data payloads that were completed by this chunk. */
  push(chunk: Uint8Array): string[] {
    this.buffer += this.decoder.decode(chunk, { stream: true });
    const out: string[] = [];
    let end: number;
    while ((end = this.buffer.search(/\r?\n\r?\n/)) !== -1) {
      const block = this.buffer.slice(0, end);
      this.buffer = this.buffer.slice(end).replace(/^\r?\n\r?\n/, '');
      const data = block
        .split(/\r?\n/)
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice(5).replace(/^ /, ''))
        .join('\n');
      if (data) out.push(data);
    }
    return out;
  }
}

export class RemoteConnection implements WorkerEndpoint {
  private handler: ((message: HubToWorker) => void) | null = null;
  private openHandler: (() => void) | null = null;
  private state: ConnectionState = 'stopped';
  private since = new Date().toISOString();
  private lastError: string | null = null;
  private lastDeliveredAt: string | null = null;
  private stopped = true;
  private abort: AbortController | null = null;
  private wake: (() => void) | null = null;
  private live: WorkerToHub[] = [];
  private flushTimer: NodeJS.Timeout | null = null;
  private flushing = false;
  private flushAgain = false;
  private readonly doFetch: typeof fetch;
  private readonly base: string;

  constructor(private readonly opts: RemoteConnectionOptions) {
    this.doFetch = opts.fetchImpl ?? fetch;
    this.base = normalizeHubUrl(opts.hubUrl);
  }

  // WorkerEndpoint --------------------------------------------------------

  send(message: WorkerToHub): void {
    if (isDurableReport(message)) {
      this.opts.outbox.append(message);
      this.emitStatus();
    } else if (this.state === 'connected') {
      this.live.push(message);
    } else {
      return; // a progress line or heartbeat with nobody to hear it
    }
    this.scheduleFlush();
  }

  onMessage(handler: (message: HubToWorker) => void): void {
    this.handler = handler;
  }

  /** Called every time the stream is (re)opened: the worker says hello again and is sent its schedule. */
  onOpen(handler: () => void): void {
    this.openHandler = handler;
  }

  // Status ------------------------------------------------------------------

  status(): ConnectionStatus {
    return {
      state: this.state,
      since: this.since,
      lastError: this.lastError,
      queued: this.opts.outbox.size,
      lastDeliveredAt: this.lastDeliveredAt,
    };
  }

  private setState(state: ConnectionState, error?: string | null): void {
    if (this.state !== state) {
      this.state = state;
      this.since = new Date().toISOString();
    }
    if (error !== undefined) this.lastError = error;
    this.emitStatus();
  }

  private emitStatus(): void {
    this.opts.onStatus?.(this.status());
  }

  // Lifecycle -----------------------------------------------------------------

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    void this.loop();
  }

  stop(): void {
    this.stopped = true;
    this.abort?.abort();
    this.wake?.();
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.flushTimer = null;
    this.live = [];
    this.setState('stopped');
  }

  /** Ends the current connection (if any) so the loop opens a fresh one right away. */
  reconnectNow(): void {
    this.abort?.abort();
    this.wake?.();
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.wake = null;
        resolve();
      }, ms); // not unref'd: while the hub is away this timer is what keeps the worker process alive
      this.wake = () => {
        clearTimeout(timer);
        this.wake = null;
        resolve();
      };
    });
  }

  private async loop(): Promise<void> {
    const min = this.opts.minBackoffMs ?? 1_000;
    const max = this.opts.maxBackoffMs ?? 60_000;
    let backoff = min;
    while (!this.stopped) {
      let connectedFor = 0;
      try {
        const startedAt = Date.now();
        const reached = await this.connectOnce();
        connectedFor = reached ? Date.now() - startedAt : 0;
      } catch (err) {
        if (this.stopped) break;
        if (err instanceof HubRefused) {
          if (err.revoked) {
            this.setState('revoked', err.message);
            this.opts.log?.('The hub no longer accepts this computer\'s token. Pair it again to reconnect.');
            this.stopped = true;
            this.opts.onRevoked?.();
            return;
          }
          if (err.incompatible) {
            this.setState('incompatible', err.message);
            await this.sleep(10 * 60_000);
            continue;
          }
        }
        this.setState('offline', err instanceof Error ? err.message : String(err));
      }
      if (this.stopped) break;
      if (this.state === 'connected' || this.state === 'connecting') this.setState('offline');
      // A connection that held for a while starts the wait over; one that failed at once backs off further.
      backoff = connectedFor > 30_000 ? min : Math.min(max, backoff * 2);
      await this.sleep(Math.round(backoff * (0.75 + Math.random() * 0.5)));
    }
  }

  /** One connection. Resolves (true) when an open stream ended, or throws. */
  private async connectOnce(): Promise<boolean> {
    this.setState('connecting');
    const abort = new AbortController();
    this.abort = abort;
    let res: Response;
    try {
      res = await this.doFetch(routeUrl(this.base, WORKER_ROUTES.stream, `?v=${PROTOCOL_VERSION}`), {
        headers: { Authorization: `Bearer ${this.opts.token}`, Accept: 'text/event-stream' },
        signal: abort.signal,
      });
    } catch (err) {
      throw new Error(`Cannot reach the hub: ${describeNetworkError(err)}`);
    }
    if (res.status === 401 || res.status === 403) {
      throw new HubRefused('The hub refused this computer\'s token (revoked or not paired).', { revoked: true });
    }
    if (res.status === 426) {
      throw new HubRefused(await readError(res, 'The hub and this computer speak different versions. Update the older one.'), {
        incompatible: true,
      });
    }
    if (!res.ok || !res.body) throw new Error(`The hub answered HTTP ${res.status}.`);

    const stallMs = this.opts.stallMs ?? 75_000;
    let stallTimer: NodeJS.Timeout | null = null;
    const armStall = () => {
      if (stallTimer) clearTimeout(stallTimer);
      stallTimer = setTimeout(() => abort.abort(), stallMs);
      stallTimer.unref?.();
    };
    try {
      this.lastError = null;
      this.setState('connected');
      armStall();
      this.openHandler?.();
      this.scheduleFlush(); // anything that piled up while offline
      const reader = res.body.getReader();
      const parser = new SseParser();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) return true;
        armStall();
        for (const data of parser.push(value)) {
          let message: HubToWorker;
          try {
            message = JSON.parse(data) as HubToWorker;
          } catch {
            continue;
          }
          this.handler?.(message);
        }
      }
    } catch (err) {
      if (this.stopped) return true;
      if (abort.signal.aborted) throw new Error('The hub went quiet; reconnecting.');
      throw new Error(`The connection to the hub dropped: ${describeNetworkError(err)}`);
    } finally {
      if (stallTimer) clearTimeout(stallTimer);
      if (this.abort === abort) this.abort = null;
      abort.abort();
    }
  }

  // Delivery --------------------------------------------------------------------

  private scheduleFlush(): void {
    if (this.stopped || this.flushTimer) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      void this.flush();
    }, this.opts.batchMs ?? 100);
    this.flushTimer.unref?.();
  }

  /** Sends what is waiting: the outbox first, in order, then live reports. One flush at a time. */
  private async flush(): Promise<void> {
    if (this.flushing) {
      this.flushAgain = true;
      return;
    }
    if (this.state !== 'connected') return;
    this.flushing = true;
    try {
      do {
        this.flushAgain = false;
        for (;;) {
          const entries = this.opts.outbox.peek(MAX_REPORTS_PER_POST);
          const live = this.live.splice(0, MAX_REPORTS_PER_POST - entries.length);
          if (entries.length === 0 && live.length === 0) break;
          const delivered = await this.post([...entries.map((e) => e.message), ...live]);
          if (!delivered) {
            // The hub did not take them. The outbox keeps its part; live reports are stale by now.
            this.live = [];
            this.reconnectSoon();
            return;
          }
          if (entries.length) this.opts.outbox.ackThrough(entries[entries.length - 1].seq);
          this.lastDeliveredAt = new Date().toISOString();
          this.emitStatus();
        }
      } while (this.flushAgain);
    } finally {
      this.flushing = false;
    }
  }

  /** True when the hub took the batch (even if it refused single messages: those would never be accepted). */
  private async post(messages: WorkerToHub[]): Promise<boolean> {
    try {
      const res = await this.doFetch(routeUrl(this.base, WORKER_ROUTES.report), {
        method: 'POST',
        headers: { Authorization: `Bearer ${this.opts.token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages }),
        signal: AbortSignal.timeout(60_000),
      });
      if (res.status === 401 || res.status === 403) {
        this.setState('revoked', 'The hub refused this computer\'s token (revoked or not paired).');
        this.stop();
        this.setState('revoked');
        this.opts.onRevoked?.();
        return false;
      }
      if (!res.ok) {
        this.lastError = `The hub answered HTTP ${res.status} to a report.`;
        return false;
      }
      return true;
    } catch (err) {
      this.lastError = `A report could not be delivered: ${describeNetworkError(err)}`;
      return false;
    }
  }

  private reconnectSoon(): void {
    if (this.state === 'revoked' || this.stopped) return;
    this.setState('offline');
    this.abort?.abort();
  }
}

class HubRefused extends Error {
  readonly revoked: boolean;
  readonly incompatible: boolean;
  constructor(message: string, flags: { revoked?: boolean; incompatible?: boolean }) {
    super(message);
    this.revoked = !!flags.revoked;
    this.incompatible = !!flags.incompatible;
  }
}

async function readError(res: Response, fallback: string): Promise<string> {
  try {
    const body = (await res.json()) as { error?: string };
    return body.error ?? fallback;
  } catch {
    return fallback;
  }
}
