import * as fs from 'fs';
import * as http from 'http';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Database } from '../database/sqlite';
import * as repo from '../database/repository';
import { initDatabase } from '../database/schema';
import { makeTempDir, removeDir } from '../engine/testUtils';
import { RemoteServer } from '../remote/server';
import { CallLog } from './callLog';
import { callLogPath, createMcpHandler } from './mcpEndpoint';
import { createMcpToken, hasMcpTokens, listMcpTokens, revokeMcpToken, verifyMcpToken } from './tokens';
import { TOOLS } from './tools';

vi.mock('../dbLocation', () => ({ getEffectiveDbPath: () => '' }));
vi.mock('../startupLog', () => ({ logStartupStep: () => undefined }));

interface Reply {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: string;
  json: any; // eslint-disable-line @typescript-eslint/no-explicit-any
}

let root: string;
let db: Database;
let server: RemoteServer;
let port: number;
let logins: string[];
let token: string;

function request(method: string, urlPath: string, headers: http.OutgoingHttpHeaders, body?: string): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path: urlPath, headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json: unknown = null;
        try {
          json = text ? JSON.parse(text) : null;
        } catch {
          /* not JSON */
        }
        resolve({ status: res.statusCode ?? 0, headers: res.headers, body: text, json });
      });
    });
    req.on('error', reject);
    req.end(body);
  });
}

const auth = (t: string = token) => ({ Authorization: `Bearer ${t}`, 'Content-Type': 'application/json' });
const rpc = (message: unknown, headers: http.OutgoingHttpHeaders = auth()) =>
  request('POST', '/mcp', headers, typeof message === 'string' ? message : JSON.stringify(message));
const callTool = (name: string, args: unknown, id = 1) =>
  rpc({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } });
const logFile = () => callLogPath(root);
const logLines = () =>
  fs.existsSync(logFile()) ? fs.readFileSync(logFile(), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];

beforeEach(async () => {
  root = makeTempDir('fileshuttle-mcp-');
  db = await initDatabase(path.join(root, 'fileshuttle.db'));
  logins = [];
  token = createMcpToken(db, 'test').token;
  const hub = {
    previewMapping: vi.fn(),
    previewJob: vi.fn(),
    checkFolder: vi.fn(async () => ({ status: 'ok' })),
    runJob: vi.fn(),
    cancelJob: vi.fn(),
    getActiveRuns: vi.fn(() => []),
    connectedWorkerIds: vi.fn(() => []),
  };
  const mcp = createMcpHandler({
    context: { getDb: () => db, hub: hub as never, afterChange: () => undefined },
    getDb: () => db,
    getVersion: () => '4.5.6',
    getLogPath: () => logFile(),
  });
  server = new RemoteServer({
    port: 0,
    staticDir: path.join(root, 'www'),
    handlers: {},
    allowedChannels: [],
    mcp,
    isPasswordSet: () => true,
    checkPassword: async () => false,
    getAllowedLogins: () => logins,
  });
  port = await server.start();
});
afterEach(async () => {
  await server.stop();
  db.close();
  removeDir(root);
});

describe('JSON-RPC protocol', () => {
  it('initializes, echoing a supported protocol version and describing itself', async () => {
    const r = await rpc({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'x', version: '1' } } });
    expect(r.status).toBe(200);
    expect(r.headers['content-type']).toMatch(/application\/json/);
    expect(r.json.id).toBe(1);
    expect(r.json.result).toMatchObject({
      protocolVersion: '2025-03-26',
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: 'fileshuttle', version: '4.5.6' },
    });
    expect(r.json.result.instructions).toMatch(/confirm/);
  });

  it('falls back to 2025-06-18 for an unknown protocol version', async () => {
    const r = await rpc({ jsonrpc: '2.0', id: 'a', method: 'initialize', params: { protocolVersion: '1999-01-01' } });
    expect(r.json.result.protocolVersion).toBe('2025-06-18');
    expect(r.json.id).toBe('a');
  });

  it('answers notifications with 202 and no body, and ping with an empty result', async () => {
    const n = await rpc({ jsonrpc: '2.0', method: 'notifications/initialized' });
    expect(n.status).toBe(202);
    expect(n.body).toBe('');
    expect((await rpc({ jsonrpc: '2.0', id: 7, method: 'ping' })).json.result).toEqual({});
  });

  it('lists every tool with a JSON Schema', async () => {
    const r = await rpc({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
    const tools = r.json.result.tools as { name: string; inputSchema: { type: string }; annotations: Record<string, boolean> }[];
    expect(tools.map((t) => t.name).sort()).toEqual(TOOLS.map((t) => t.name).sort());
    for (const t of tools) expect(t.inputSchema.type).toBe('object');
    expect(tools.find((t) => t.name === 'delete_job')!.annotations.destructiveHint).toBe(true);
    expect(tools.find((t) => t.name === 'list_jobs')!.annotations.readOnlyHint).toBe(true);
  });

  it('reports unknown methods (-32601), bad JSON (-32700), batches and bad shapes (-32600), bad params (-32602)', async () => {
    expect((await rpc({ jsonrpc: '2.0', id: 1, method: 'resources/list' })).json.error.code).toBe(-32601);
    const bad = await rpc('{nope');
    expect(bad.status).toBe(400);
    expect(bad.json.error.code).toBe(-32700);
    expect((await rpc([{ jsonrpc: '2.0', id: 1, method: 'ping' }])).json.error.code).toBe(-32600);
    expect((await rpc({ id: 1, method: 'ping' })).json.error.code).toBe(-32600);
    expect((await callTool('no_such_tool', {})).json.error.code).toBe(-32602);
    expect((await callTool('get_run_history', { limit: 'many' })).json.error.code).toBe(-32602);
  });

  it('GET and DELETE answer 405; a body over 1 MB answers 413', async () => {
    expect((await request('GET', '/mcp', auth())).status).toBe(405);
    expect((await request('DELETE', '/mcp', auth())).status).toBe(405);
    const big = await rpc(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping', params: { pad: 'x'.repeat(1_100_000) } })).catch(() => null);
    if (big) expect(big.status).toBe(413);
  });

  it('returns tool results as text, and tool errors as isError results', async () => {
    const ok = await callTool('list_jobs', {});
    expect(ok.json.result.content[0].type).toBe('text');
    expect(ok.json.result.isError).toBeUndefined();
    const bad = await callTool('delete_job', { jobId: 999 });
    expect(bad.json.result.isError).toBe(true);
    expect(bad.json.result.content[0].text).toMatch(/no job with id 999/);
  });
});

describe('authentication', () => {
  it('is off (403) until a token exists', async () => {
    revokeMcpToken(db, 'test');
    expect(hasMcpTokens(db)).toBe(false);
    const r = await rpc({ jsonrpc: '2.0', id: 1, method: 'ping' });
    expect(r.status).toBe(403);
    expect(r.json.error.message).toMatch(/no MCP token has been made/);
  });

  it('refuses a missing or wrong token with 401 and WWW-Authenticate', async () => {
    for (const headers of [{ 'Content-Type': 'application/json' }, auth('fsm_wrong'), { Authorization: 'Basic abc' }]) {
      const r = await rpc({ jsonrpc: '2.0', id: 1, method: 'ping' }, headers);
      expect(r.status).toBe(401);
      expect(r.headers['www-authenticate']).toMatch(/^Bearer/);
    }
  });

  it('accepts the right token, and a revoked token stops working', async () => {
    expect((await rpc({ jsonrpc: '2.0', id: 1, method: 'ping' })).status).toBe(200);
    createMcpToken(db, 'other');
    revokeMcpToken(db, 'test');
    expect((await rpc({ jsonrpc: '2.0', id: 1, method: 'ping' })).status).toBe(401);
  });

  it('does not accept a session cookie as auth', async () => {
    const r = await rpc({ jsonrpc: '2.0', id: 1, method: 'ping' }, { 'Content-Type': 'application/json', Cookie: `fs_session=${'a'.repeat(43)}` });
    expect(r.status).toBe(401);
  });

  it('rejects a request whose Origin is not the server\'s own host, even with a good token', async () => {
    const r = await rpc({ jsonrpc: '2.0', id: 1, method: 'ping' }, { ...auth(), Origin: 'https://evil.example' });
    expect(r.status).toBe(403);
    const same = await rpc({ jsonrpc: '2.0', id: 1, method: 'ping' }, { ...auth(), Origin: `http://127.0.0.1:${port}` });
    expect(same.status).toBe(200);
  });

  it('applies the Tailscale allow list when one is configured', async () => {
    logins = ['me@example.com'];
    const msg = { jsonrpc: '2.0', id: 1, method: 'ping' };
    expect((await rpc(msg)).status).toBe(403);
    expect((await rpc(msg, { ...auth(), 'Tailscale-User-Login': 'someone@else.com' })).status).toBe(403);
    expect((await rpc(msg, { ...auth(), 'Tailscale-User-Login': 'ME@example.com' })).status).toBe(200);
  });

  it('stores only a hash of the token', () => {
    const row = db.prepare('SELECT * FROM mcp_tokens').all()[0] as Record<string, unknown>;
    expect(JSON.stringify(row)).not.toContain(token);
    expect(String(row.token_hash)).toMatch(/^[0-9a-f]{64}$/);
    expect(verifyMcpToken(db, token)).toBe('test');
    expect(verifyMcpToken(db, token + 'x')).toBeNull();
    expect(listMcpTokens(db)[0].lastUsedAt).not.toBeNull();
    expect(() => createMcpToken(db, 'TEST')).toThrow(/already/);
    expect(() => createMcpToken(db, '  ')).toThrow();
  });
});

describe('confirmation over the wire and the call log', () => {
  it('deletes a job only on the second, confirmed call; logs both without the code or the token', async () => {
    const mappingId = repo.createMapping(db, {
      name: 'M', sourcePath: path.join(root, 's'), destPath: path.join(root, 'd'), recursive: false, conflictPolicy: 'skip',
      enabled: true, scheduleType: 'manual', scheduleIntervalMinutes: null, scheduleDailyTime: null, filters: [],
      nextMappingId: null, actionType: 'copy', keepNewest: null, keepNewestPerExtension: false,
    });
    const jobId = repo.createJob(db, { name: 'J', enabled: false, catchUp: false, scheduleType: 'manual', scheduleIntervalMinutes: null, scheduleDailyTimes: [], mappingIds: [mappingId] });

    const first = await callTool('delete_job', { jobId });
    const firstText = first.json.result.content[0].text as string;
    expect(firstText).toMatch(/Ask the user to confirm this exact action before calling again with confirm\./);
    expect(repo.getJob(db, jobId)).not.toBeNull();
    const code = /confirm: "([A-Z0-9]{6})"/.exec(firstText)![1];

    const second = await callTool('delete_job', { jobId, confirm: code }, 2);
    expect(second.json.result.isError).toBeUndefined();
    expect(repo.getJob(db, jobId)).toBeNull();

    const lines = logLines().filter((l) => l.event === 'tool-call');
    expect(lines.map((l) => [l.tool, l.result])).toEqual([['delete_job', 'needs-confirmation'], ['delete_job', 'ok']]);
    expect(lines[0].token).toBe('test');
    expect(lines[1].arguments).toEqual({ jobId, confirm: '[redacted]' });
    expect(typeof lines[1].durationMs).toBe('number');
    const raw = fs.readFileSync(logFile(), 'utf8');
    expect(raw).not.toContain(code);
    expect(raw).not.toContain(token);
    expect(lines[0].time).toMatch(/^\d{4}-/);
  });

  it('logs auth failures without the presented token', async () => {
    await rpc({ jsonrpc: '2.0', id: 1, method: 'ping' }, auth('fsm_secret_guess'));
    const lines = logLines();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ event: 'auth-failed', token: null });
    expect(fs.readFileSync(logFile(), 'utf8')).not.toContain('fsm_secret_guess');
  });
});

describe('the call log', () => {
  it('rotates past its size limit and never throws', () => {
    const file = path.join(root, 'rot.log');
    const log = new CallLog(() => file, () => new Date(0), 200);
    for (let i = 0; i < 20; i += 1) log.write({ event: 'tool-call', token: 't', tool: 'list_jobs', result: 'ok' });
    expect(fs.existsSync(`${file}.1`)).toBe(true);
    expect(fs.statSync(file).size).toBeLessThan(600);
    const broken = new CallLog(() => path.join(root, 'no', 'such', 'dir', 'x.log'));
    expect(() => broken.write({ event: 'rejected', token: null })).not.toThrow();
  });
});
