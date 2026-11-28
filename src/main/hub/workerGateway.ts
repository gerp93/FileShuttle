import type * as http from 'http';
import { createHash } from 'crypto';
import type { Database } from '../database/sqlite';
import { queryOne } from '../database/dbHelpers';
import {
  HubToWorker,
  MAX_REPORTS_PER_POST,
  PROTOCOL_VERSION,
  WORKER_OFFLINE_AFTER_MS,
  WORKER_ROUTES,
  WORKER_TO_HUB_TYPES,
  WorkerToHub,
} from '../../shared/workerProtocol';
import { redeemPairing, verifyWorkerToken } from '../database/workerAccess';
import type { Hub, HubEndpoint } from './hub';

/**
 * The hub's door for remote workers: three routes under /worker, mounted inside the same loopback-only
 * HTTP server as the phone UI and MCP (so it is reached the same way, through `tailscale serve`, never
 * Funnel, and the Tailscale allow list applies). The worker always connects OUT to the hub.
 *
 *   POST /worker/pair    { code }        -> { workerId, name, token }    (no token yet; rate limited)
 *   GET  /worker/stream  (bearer token)  -> server-sent events: the hub's messages to the worker
 *   POST /worker/report  (bearer token)  { messages: [...] } -> the worker's messages to the hub
 *
 * Messages are the ones in shared/workerProtocol.ts, unchanged. A browser is never a worker: a request
 * with a foreign Origin is refused, and cookies mean nothing here. Tokens and codes are never logged.
 */

const KEEPALIVE_MS = 25_000;
const SWEEP_MS = 5_000;
const MAX_REPORT_BYTES = 32 * 1024 * 1024;
const PAIR_ATTEMPTS_PER_CLIENT = 5;
const PAIR_ATTEMPTS_OVERALL = 20;
const PAIR_WINDOW_MS = 15 * 60 * 1000;

function headerValue(value: string | string[] | undefined): string | null {
  if (Array.isArray(value)) return value[0] ?? null;
  return typeof value === 'string' ? value : null;
}

function originAllowed(req: http.IncomingMessage): boolean {
  const origin = headerValue(req.headers.origin);
  if (origin === null) return true;
  let originHost: string;
  try {
    originHost = new URL(origin).host.toLowerCase();
  } catch {
    return false;
  }
  const hosts = [headerValue(req.headers.host), headerValue(req.headers['x-forwarded-host'])]
    .filter((h): h is string => !!h)
    .map((h) => h.toLowerCase());
  return hosts.includes(originHost);
}

function bearerOf(req: http.IncomingMessage): string | null {
  const header = headerValue(req.headers.authorization);
  const match = header ? /^Bearer\s+(\S+)\s*$/i.exec(header) : null;
  return match ? match[1] : null;
}

function send(res: http.ServerResponse, status: number, body: unknown, extra: http.OutgoingHttpHeaders = {}): void {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...extra });
  res.end(JSON.stringify(body));
}

class BodyTooLarge extends Error {}

async function readBody(req: http.IncomingMessage, limit: number): Promise<Buffer> {
  const declared = Number(headerValue(req.headers['content-length']) ?? 0);
  if (Number.isFinite(declared) && declared > limit) throw new BodyTooLarge();
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    size += buf.length;
    if (size > limit) throw new BodyTooLarge();
    chunks.push(buf);
  }
  return Buffer.concat(chunks);
}

/** Counts recent failures per key; blocks a key (or everyone) at a limit. */
class AttemptLimiter {
  private readonly failures = new Map<string, number[]>();
  constructor(
    private readonly windowMs: number,
    private readonly now: () => number
  ) {}
  private recent(key: string): number[] {
    const cutoff = this.now() - this.windowMs;
    const list = (this.failures.get(key) ?? []).filter((t) => t > cutoff);
    if (list.length) this.failures.set(key, list);
    else this.failures.delete(key);
    return list;
  }
  blockedFor(key: string, max: number): number {
    const list = this.recent(key);
    if (list.length < max) return 0;
    return Math.max(1, Math.ceil((list[0] + this.windowMs - this.now()) / 1000));
  }
  record(key: string): void {
    const list = this.recent(key);
    list.push(this.now());
    this.failures.set(key, list);
  }
}

interface Connection {
  workerId: string;
  res: http.ServerResponse;
  endpoint: HubEndpoint;
  /** Hash of the token this connection was opened with: a revoked or replaced token ends the connection. */
  tokenHash: string;
  lastActivity: number;
  keepalive: NodeJS.Timeout;
  closed: boolean;
}

export interface WorkerGatewayOptions {
  getDb: () => Database;
  hub: Hub;
  log?: (message: string) => void;
  now?: () => number;
  /** How long a silent worker stays "connected". Default: WORKER_OFFLINE_AFTER_MS. */
  offlineAfterMs?: number;
  keepaliveMs?: number;
  sweepMs?: number;
}

export interface WorkerGateway {
  handler: (req: http.IncomingMessage, res: http.ServerResponse) => Promise<void>;
  /** Closes a worker's connection now (it was revoked). The worker is shown offline. */
  disconnect(workerId: string): void;
  /** Stops the timers and closes every connection. */
  shutdown(): void;
}

export function createWorkerGateway(opts: WorkerGatewayOptions): WorkerGateway {
  const now = opts.now ?? Date.now;
  const offlineAfter = opts.offlineAfterMs ?? WORKER_OFFLINE_AFTER_MS;
  const connections = new Map<string, Connection>();
  const limiter = new AttemptLimiter(PAIR_WINDOW_MS, now);
  const log = opts.log ?? (() => undefined);

  const tokenHashOf = (token: string): string => createHash('sha256').update(token, 'utf8').digest('hex');

  function close(connection: Connection, reason: string): void {
    if (connection.closed) return;
    connection.closed = true;
    if (connections.get(connection.workerId) === connection) connections.delete(connection.workerId);
    clearInterval(connection.keepalive);
    opts.hub.detachWorker(connection.workerId, connection.endpoint);
    if (!connection.res.writableEnded) connection.res.end();
    log(`worker ${connection.workerId}: disconnected (${reason})`);
  }

  const sweeper = setInterval(() => {
    const db = opts.getDb();
    for (const connection of [...connections.values()]) {
      if (now() - connection.lastActivity > offlineAfter) {
        close(connection, 'no heartbeat');
        continue;
      }
      // A token revoked from another process (the command line) cuts the connection here.
      const row = queryOne(db, 'SELECT token_hash FROM workers WHERE id = ?', [connection.workerId]);
      if (!row || String(row.token_hash ?? '') !== connection.tokenHash) close(connection, 'token revoked');
    }
  }, opts.sweepMs ?? SWEEP_MS);
  sweeper.unref();

  function authenticate(req: http.IncomingMessage): { workerId: string; name: string; tokenHash: string } | null {
    const presented = bearerOf(req);
    if (!presented) return null;
    const worker = verifyWorkerToken(opts.getDb(), presented);
    return worker ? { ...worker, tokenHash: tokenHashOf(presented) } : null;
  }

  function unauthorized(res: http.ServerResponse): void {
    send(res, 401, { ok: false, error: 'Unauthorized: this computer is not paired with the hub, or its pairing was revoked.' }, {
      'WWW-Authenticate': 'Bearer realm="fileshuttle-worker"',
    });
  }

  async function pair(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const client = `${headerValue(req.headers['tailscale-user-login']) ?? ''}|${req.socket.remoteAddress ?? ''}`;
    const wait = Math.max(
      limiter.blockedFor(`client:${client}`, PAIR_ATTEMPTS_PER_CLIENT),
      limiter.blockedFor('overall', PAIR_ATTEMPTS_OVERALL)
    );
    if (wait > 0) {
      return send(res, 429, { ok: false, error: 'Too many pairing attempts. Try again later.' }, { 'Retry-After': String(wait) });
    }
    let code: unknown;
    try {
      code = (JSON.parse((await readBody(req, 4096)).toString('utf8')) as { code?: unknown } | null)?.code;
    } catch (e) {
      if (e instanceof BodyTooLarge) return send(res, 413, { ok: false, error: 'Request too large.' });
      return send(res, 400, { ok: false, error: 'The body must be JSON.' });
    }
    const paired = redeemPairing(opts.getDb(), code, new Date(now()));
    if (!paired) {
      limiter.record(`client:${client}`);
      limiter.record('overall');
      return send(res, 403, { ok: false, error: 'That pairing code is wrong, already used or expired. Ask for a new one.' });
    }
    log(`worker ${paired.workerId} ("${paired.name}") paired`);
    return send(res, 200, { ok: true, workerId: paired.workerId, name: paired.name, token: paired.token });
  }

  function stream(req: http.IncomingMessage, res: http.ServerResponse, who: { workerId: string; tokenHash: string }): void {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const version = Number(url.searchParams.get('v') ?? PROTOCOL_VERSION);
    if (version !== PROTOCOL_VERSION) {
      return send(res, 426, {
        ok: false,
        error: `This hub speaks worker protocol ${PROTOCOL_VERSION}; the worker speaks ${version}. Update the older one.`,
      });
    }
    // A worker that reconnects replaces its older connection (which may only look open: the network
    // dropped but the hub has not noticed yet).
    const existing = connections.get(who.workerId);
    if (existing) close(existing, 'replaced by a new connection');

    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write(': connected\n\n');
    const endpoint: HubEndpoint = {
      send: (message: HubToWorker) => {
        if (!res.writableEnded) res.write(`data: ${JSON.stringify(message)}\n\n`);
      },
      onMessage: () => undefined, // reports arrive by POST and go to hub.receive()
    };
    const connection: Connection = {
      workerId: who.workerId,
      res,
      endpoint,
      tokenHash: who.tokenHash,
      lastActivity: now(),
      keepalive: setInterval(() => {
        if (!res.writableEnded) res.write(': ping\n\n');
      }, opts.keepaliveMs ?? KEEPALIVE_MS),
      closed: false,
    };
    connection.keepalive.unref();
    connections.set(who.workerId, connection);
    opts.hub.attachWorker(who.workerId, endpoint);
    log(`worker ${who.workerId}: connected`);
    req.on('close', () => close(connection, 'connection closed'));
  }

  async function report(req: http.IncomingMessage, res: http.ServerResponse, who: { workerId: string }): Promise<void> {
    let body: { messages?: unknown } | null;
    try {
      body = JSON.parse((await readBody(req, MAX_REPORT_BYTES)).toString('utf8')) as { messages?: unknown } | null;
    } catch (e) {
      if (e instanceof BodyTooLarge) return send(res, 413, { ok: false, error: 'Request too large.' }, { Connection: 'close' });
      return send(res, 400, { ok: false, error: 'The body must be JSON.' });
    }
    const messages = body?.messages;
    if (!Array.isArray(messages) || messages.length > MAX_REPORTS_PER_POST) {
      return send(res, 400, { ok: false, error: `"messages" must be a list of at most ${MAX_REPORTS_PER_POST}.` });
    }
    const connection = connections.get(who.workerId);
    if (connection) connection.lastActivity = now();
    let accepted = 0;
    let rejected = 0;
    for (const raw of messages) {
      const type = (raw as { type?: unknown } | null)?.type;
      if (typeof type !== 'string' || !(WORKER_TO_HUB_TYPES as readonly string[]).includes(type)) {
        rejected++;
        continue;
      }
      // The worker is whoever the token says, whatever the message claims.
      const message = { ...(raw as object), workerId: who.workerId } as WorkerToHub;
      try {
        opts.hub.receive(who.workerId, message);
        accepted++;
      } catch (err) {
        // One malformed report must not hold up the worker's whole outbox: count it, say so, move on.
        rejected++;
        log(`worker ${who.workerId}: a "${type}" report was refused: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    return send(res, 200, { ok: true, accepted, rejected });
  }

  const handler = async (req: http.IncomingMessage, res: http.ServerResponse): Promise<void> => {
    // A web page is never a worker (a DNS-rebinding page or any site sends an Origin that is not ours).
    if (!originAllowed(req)) return send(res, 403, { ok: false, error: 'Forbidden: browser requests are not accepted here.' });
    const pathname = new URL(req.url ?? '/', 'http://localhost').pathname;

    if (pathname === WORKER_ROUTES.pair) {
      if (req.method !== 'POST') return send(res, 405, { ok: false, error: 'Use POST.' }, { Allow: 'POST' });
      return pair(req, res);
    }
    const who = authenticate(req);
    if (pathname === WORKER_ROUTES.stream) {
      if (req.method !== 'GET') return send(res, 405, { ok: false, error: 'Use GET.' }, { Allow: 'GET' });
      if (!who) return unauthorized(res);
      return stream(req, res, who);
    }
    if (pathname === WORKER_ROUTES.report) {
      if (req.method !== 'POST') return send(res, 405, { ok: false, error: 'Use POST.' }, { Allow: 'POST' });
      if (!who) return unauthorized(res);
      return report(req, res, who);
    }
    return send(res, 404, { ok: false, error: 'Not found.' });
  };

  return {
    handler,
    disconnect(workerId) {
      const connection = connections.get(workerId);
      if (connection) close(connection, 'disconnected by the hub');
    },
    shutdown() {
      clearInterval(sweeper);
      for (const connection of [...connections.values()]) close(connection, 'hub stopping');
    },
  };
}
