import type { Database } from '../database/sqlite';
import { HubToWorker, PROTOCOL_VERSION, WORKER_OFFLINE_AFTER_MS, WORKER_TO_HUB_TYPES, WorkerToHub } from '../../shared/workerProtocol';
import type { WebSocketConnection } from '../net/webSocket';
import type { Hub, HubEndpoint } from './hub';
import { BAD_CODE_MESSAGE, redeemPairingCode, verifyWorkerToken } from './pairing';

/**
 * The hub's door for remote workers: it turns an upgraded WebSocket into a `HubEndpoint` once
 * the worker has proved who it is.
 *
 * The first message must be a `hello` carrying the worker id and its token; anything else first,
 * or nothing within 10 seconds, ends the connection. The token is compared (as a hash, in
 * constant time) with the one stored when the machine was paired, and is never logged or kept.
 * A worker that speaks another protocol version is refused with a plain sentence on both sides.
 */

/** Close codes the hub uses (4000-4999 are free for applications). */
export const CLOSE_BAD_HELLO = 4000;
export const CLOSE_NOT_ACCEPTED = 4001;
export const CLOSE_PROTOCOL = 4002;
export const CLOSE_HELLO_TIMEOUT = 4003;
export const CLOSE_REPLACED = 4004;
export const CLOSE_SILENT = 4005;

export const NOT_ACCEPTED_MESSAGE = 'The hub did not accept this machine. It may have been removed; pair it again.';

export interface GatewayOptions {
  getDb: () => Database;
  hub: Hub;
  /** Where something worth reading goes (never a token or a code). */
  log?: (message: string) => void;
  helloTimeoutMs?: number;
  pingEveryMs?: number;
  silentAfterMs?: number;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** One worker's socket as the hub's endpoint. */
class SocketEndpoint implements HubEndpoint {
  private handler: ((message: WorkerToHub) => void) | null = null;

  constructor(
    private readonly connection: WebSocketConnection,
    private readonly workerId: string,
    private readonly log: (message: string) => void
  ) {}

  send(message: HubToWorker): void {
    this.connection.send(JSON.stringify(message));
  }

  onMessage(handler: (message: WorkerToHub) => void): void {
    this.handler = handler;
  }

  close(reason: string): void {
    this.connection.close(CLOSE_REPLACED, reason);
  }

  /** A text message from the worker. Returns false when it is not a message the hub understands. */
  deliver(text: string): boolean {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return false;
    }
    if (!isObject(parsed) || typeof parsed.type !== 'string') return false;
    if (!(WORKER_TO_HUB_TYPES as readonly string[]).includes(parsed.type)) return false;
    // Whatever the message says about who sent it, it came from this socket.
    if ('workerId' in parsed) parsed.workerId = this.workerId;
    try {
      this.handler?.(parsed as unknown as WorkerToHub);
    } catch (err) {
      this.log(`worker ${this.workerId}: could not handle a "${parsed.type}" message: ${err instanceof Error ? err.message : err}`);
    }
    return true;
  }
}

export class WorkerGateway {
  private readonly connections = new Set<WebSocketConnection>();
  private readonly log: (message: string) => void;

  constructor(private readonly opts: GatewayOptions) {
    this.log = opts.log ?? (() => undefined);
  }

  /** POST /api/workers/pair. */
  pair = (input: unknown): { status: number; body: unknown } => {
    if (!isObject(input) || typeof input.code !== 'string' || input.code.length > 40) {
      return { status: 400, body: { ok: false, error: 'A pairing code is required.' } };
    }
    const name = typeof input.name === 'string' ? input.name.slice(0, 100) : '';
    const platform = typeof input.platform === 'string' ? input.platform.slice(0, 30) : null;
    const result = redeemPairingCode(this.opts.getDb(), input.code, { name, platform });
    if (!result.ok) return { status: 401, body: { ok: false, error: BAD_CODE_MESSAGE } };
    this.log(`paired machine "${result.worker.name}"`);
    return { status: 200, body: { ok: true, workerId: result.worker.id, name: result.worker.name, token: result.token } };
  };

  /** A worker's WebSocket, just upgraded. */
  accept = (connection: WebSocketConnection): void => {
    this.connections.add(connection);
    let endpoint: SocketEndpoint | null = null;
    let workerId: string | null = null;
    let lastHeard = Date.now();

    const helloTimer = setTimeout(
      () => connection.close(CLOSE_HELLO_TIMEOUT, 'No hello message arrived in time.'),
      this.opts.helloTimeoutMs ?? 10_000
    );
    helloTimer.unref?.();
    const pingTimer = setInterval(() => {
      if (Date.now() - lastHeard > (this.opts.silentAfterMs ?? WORKER_OFFLINE_AFTER_MS)) {
        connection.close(CLOSE_SILENT, 'Nothing was heard from this machine for too long.');
        return;
      }
      connection.ping();
    }, this.opts.pingEveryMs ?? 30_000);
    pingTimer.unref?.();

    connection.onPong(() => {
      lastHeard = Date.now();
    });
    connection.onMessage((text) => {
      lastHeard = Date.now();
      if (endpoint) {
        if (!endpoint.deliver(text)) connection.close(1008, 'That message was not understood.');
        return;
      }
      const accepted = this.hello(connection, text);
      if (!accepted) return;
      clearTimeout(helloTimer);
      workerId = accepted.workerId;
      endpoint = new SocketEndpoint(connection, workerId, this.log);
      this.opts.hub.attachWorker(workerId, endpoint);
      endpoint.deliver(accepted.helloText);
    });
    connection.onClose(() => {
      clearTimeout(helloTimer);
      clearInterval(pingTimer);
      this.connections.delete(connection);
      if (endpoint && workerId) this.opts.hub.detachWorker(workerId, endpoint);
    });
  };

  /**
   * Checks the first message. Returns the worker id and the hello (token removed) when the worker
   * is accepted; otherwise ends the connection with a plain sentence and returns null.
   */
  private hello(connection: WebSocketConnection, text: string): { workerId: string; helloText: string } | null {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      connection.close(CLOSE_BAD_HELLO, 'The first message must be a hello.');
      return null;
    }
    if (
      !isObject(parsed) ||
      parsed.type !== 'hello' ||
      typeof parsed.workerId !== 'string' ||
      parsed.workerId.length === 0 ||
      parsed.workerId.length > 100 ||
      typeof parsed.token !== 'string' ||
      parsed.token.length === 0 ||
      parsed.token.length > 200 ||
      typeof parsed.appVersion !== 'string' ||
      parsed.appVersion.length > 60 ||
      !Number.isInteger(parsed.protocolVersion) ||
      !Number.isInteger(parsed.scheduleVersion) ||
      (parsed.platform !== undefined && (typeof parsed.platform !== 'string' || parsed.platform.length > 30))
    ) {
      connection.close(CLOSE_BAD_HELLO, 'The first message must be a valid hello.');
      return null;
    }
    const { workerId, token } = parsed as { workerId: string; token: string };
    // The same answer for an unknown machine, a removed one and a wrong token.
    if (!verifyWorkerToken(this.opts.getDb(), workerId, token)) {
      connection.close(CLOSE_NOT_ACCEPTED, NOT_ACCEPTED_MESSAGE);
      return null;
    }
    if (parsed.protocolVersion !== PROTOCOL_VERSION) {
      const older = (parsed.protocolVersion as number) < PROTOCOL_VERSION ? 'the worker' : 'the hub';
      connection.close(
        CLOSE_PROTOCOL,
        `This worker speaks protocol ${parsed.protocolVersion} and the hub speaks ${PROTOCOL_VERSION}. Update ${older} so both run the same version.`
      );
      return null;
    }
    delete parsed.token;
    return { workerId, helloText: JSON.stringify(parsed) };
  }

  /** Closes every worker connection (the server is stopping). */
  stop(): void {
    for (const connection of [...this.connections]) connection.close(1001, 'The hub is shutting down.');
  }
}
