import type * as http from 'http';
import * as path from 'path';
import { CallLog, redactArguments } from './callLog';
import { ConfirmationStore } from './confirmations';
import { callTool, McpContext, MAX_RESULT_CHARS, toolListing, TOOLS } from './tools';
import { hasMcpTokens, verifyMcpToken } from './tokens';

/**
 * The MCP server: JSON-RPC 2.0 over the "Streamable HTTP" transport, stateless, hand-written (no SDK).
 * `POST /mcp` carries one JSON-RPC message and is answered with application/json; notifications get
 * 202. It is mounted inside RemoteServer, so it shares its loopback-only bind and the Tailscale
 * allow list, but it has its own auth (a bearer token; cookies mean nothing here) and it is OFF until
 * the owner has made a token.
 */

export const SUPPORTED_PROTOCOLS = ['2025-06-18', '2025-03-26', '2024-11-05'] as const;
export const MCP_MAX_BODY_BYTES = 1024 * 1024;

const INSTRUCTIONS =
  'File Shuttle moves, copies, zips, unzips and deletes files between folders on the owner\'s computers, on a schedule or on demand. ' +
  'A mapping is one rule (action, source folder, destination, filters); a job is an ordered list of mappings plus a schedule. ' +
  'Look first (list_jobs, list_mappings, preview_job), change second. Tools that delete, move or replace files, or delete a job or mapping, ' +
  'do nothing on the first call and return a one-time code: describe the action to the user, wait for their explicit yes, and only then call again with confirm.';

type Id = string | number | null;

export interface McpEndpointOptions {
  context: McpContext;
  getDb: () => import('../database/sqlite').Database;
  getVersion: () => string;
  /** Where mcp-calls.log goes (the data folder). */
  getLogPath: () => string;
  now?: () => number;
  /** For tests: the confirmation store and log to use. */
  confirmations?: ConfirmationStore;
  log?: CallLog;
}

function headerValue(value: string | string[] | undefined): string | null {
  if (Array.isArray(value)) return value[0] ?? null;
  return typeof value === 'string' ? value : null;
}

/** An Origin header is only ever sent by a browser; accept it only when it is this server's own host. */
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
  const text = body === undefined ? '' : JSON.stringify(body);
  res.writeHead(status, {
    ...(body === undefined ? {} : { 'Content-Type': 'application/json; charset=utf-8' }),
    'Cache-Control': 'no-store',
    ...extra,
  });
  res.end(text);
}

const rpcError = (id: Id, code: number, message: string) => ({ jsonrpc: '2.0', id, error: { code, message } });

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

export type McpHandler = (req: http.IncomingMessage, res: http.ServerResponse) => Promise<void>;

export function createMcpHandler(opts: McpEndpointOptions): McpHandler {
  const confirmations = opts.confirmations ?? new ConfirmationStore(opts.now);
  const log = opts.log ?? new CallLog(opts.getLogPath);
  const now = opts.now ?? Date.now;

  return async (req, res) => {
    // 1. Browsers: never. (A DNS-rebinding page or any web page sends an Origin that is not ours.)
    if (!originAllowed(req)) {
      log.write({ event: 'rejected', token: null, reason: 'origin not allowed' });
      return send(res, 403, rpcError(null, -32001, 'Forbidden: browser requests are not accepted here.'));
    }

    // 2. Auth: a bearer token made by the owner. Off until one exists.
    const db = opts.getDb();
    if (!hasMcpTokens(db)) {
      log.write({ event: 'auth-failed', token: null, reason: 'no token has been made' });
      return send(res, 403, rpcError(null, -32001, 'MCP is off: no MCP token has been made yet. Make one in File Shuttle Settings or with "fileshuttle-server mcp-token create <name>".'));
    }
    const presented = bearerOf(req);
    const tokenName = presented ? verifyMcpToken(db, presented, now) : null;
    if (!tokenName) {
      log.write({ event: 'auth-failed', token: null, reason: presented ? 'unknown token' : 'no bearer token' });
      return send(res, 401, rpcError(null, -32001, 'Unauthorized: send "Authorization: Bearer <token>".'), {
        'WWW-Authenticate': 'Bearer realm="fileshuttle"',
      });
    }

    // 3. Only POST. (No server-initiated streams and no sessions.)
    if (req.method !== 'POST') {
      return send(res, 405, rpcError(null, -32000, 'Method not allowed. Use POST.'), { Allow: 'POST' });
    }

    let text: string;
    try {
      text = (await readBody(req, MCP_MAX_BODY_BYTES)).toString('utf8');
    } catch (e) {
      if (e instanceof BodyTooLarge) {
        res.writeHead(413, { 'Content-Type': 'application/json; charset=utf-8', Connection: 'close' });
        return void res.end(JSON.stringify(rpcError(null, -32600, 'Request too large.')), () => req.socket.destroy());
      }
      throw e;
    }

    let message: unknown;
    try {
      message = JSON.parse(text);
    } catch {
      return send(res, 400, rpcError(null, -32700, 'Parse error: the body is not valid JSON.'));
    }
    if (!message || typeof message !== 'object' || Array.isArray(message)) {
      return send(res, 400, rpcError(null, -32600, 'Invalid Request: send one JSON-RPC message (batches are not supported).'));
    }
    const msg = message as { jsonrpc?: unknown; id?: unknown; method?: unknown; params?: unknown };
    const hasId = msg.id !== undefined && msg.id !== null;
    const id: Id = hasId && (typeof msg.id === 'string' || typeof msg.id === 'number') ? msg.id : null;
    if (msg.jsonrpc !== '2.0' || typeof msg.method !== 'string' || (hasId && id === null)) {
      return send(res, 400, rpcError(id, -32600, 'Invalid Request.'));
    }
    const params = (msg.params && typeof msg.params === 'object' ? msg.params : {}) as Record<string, unknown>;

    // Notifications (no id) and stray responses: nothing to say back.
    if (!hasId) return send(res, 202, undefined);

    switch (msg.method) {
      case 'initialize': {
        const asked = typeof params.protocolVersion === 'string' ? params.protocolVersion : '';
        const version = (SUPPORTED_PROTOCOLS as readonly string[]).includes(asked) ? asked : SUPPORTED_PROTOCOLS[0];
        return send(res, 200, {
          jsonrpc: '2.0',
          id,
          result: {
            protocolVersion: version,
            capabilities: { tools: { listChanged: false } },
            serverInfo: { name: 'fileshuttle', version: opts.getVersion() },
            instructions: INSTRUCTIONS,
          },
        });
      }
      case 'ping':
        return send(res, 200, { jsonrpc: '2.0', id, result: {} });
      case 'tools/list':
        return send(res, 200, { jsonrpc: '2.0', id, result: { tools: TOOLS.map(toolListing) } });
      case 'tools/call': {
        const name = params.name;
        if (typeof name !== 'string') return send(res, 200, rpcError(id, -32602, 'Invalid params: "name" is required.'));
        const args = params.arguments;
        if (args !== undefined && (args === null || typeof args !== 'object' || Array.isArray(args))) {
          return send(res, 200, rpcError(id, -32602, 'Invalid params: "arguments" must be an object.'));
        }
        const started = now();
        const called = await callTool(opts.context, confirmations, tokenName, name, args ?? {});
        const durationMs = now() - started;
        if ('invalidParams' in called) {
          log.write({ event: 'tool-call', token: tokenName, tool: name, arguments: redactArguments(args), result: 'error', reason: 'invalid params', durationMs });
          return send(res, 200, rpcError(id, -32602, called.invalidParams));
        }
        log.write({ event: 'tool-call', token: tokenName, tool: name, arguments: redactArguments(args), result: called.outcome, durationMs });
        const out = called.output.text;
        return send(res, 200, {
          jsonrpc: '2.0',
          id,
          result: {
            content: [{ type: 'text', text: out.length > MAX_RESULT_CHARS ? `${out.slice(0, MAX_RESULT_CHARS)}\n…(cut: too long)` : out }],
            ...(called.output.isError ? { isError: true } : {}),
          },
        });
      }
      default:
        return send(res, 200, rpcError(id, -32601, `Method not found: ${msg.method}`));
    }
  };
}

/** mcp-calls.log inside a data folder. */
export function callLogPath(dataDir: string): string {
  return path.join(dataDir, 'mcp-calls.log');
}
