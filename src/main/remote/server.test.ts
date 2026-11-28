import * as fs from 'fs';
import * as http from 'http';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { makeTempDir, removeDir, writeFile } from '../engine/testUtils';
import { RemoteServer, RemoteServerOptions } from './server';

const PASSWORD = 'correct horse battery';

interface Reply {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: string;
}

let root: string;
let server: RemoteServer;
let port: number;
let logins: string[];
let clock: number;

function request(
  method: string,
  urlPath: string,
  opts: { headers?: http.OutgoingHttpHeaders; body?: string | Buffer } = {}
): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path: urlPath, headers: opts.headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    req.end(opts.body);
  });
}

/** A browser-like POST: same-origin Origin header and the custom header. */
function post(urlPath: string, payload: unknown, extra: http.OutgoingHttpHeaders = {}): Promise<Reply> {
  return request('POST', urlPath, {
    headers: {
      'Content-Type': 'application/json',
      Origin: `http://127.0.0.1:${port}`,
      'X-FileShuttle': '1',
      ...extra,
    },
    body: JSON.stringify(payload),
  });
}

async function signIn(extra: http.OutgoingHttpHeaders = {}): Promise<string> {
  const res = await post('/api/login', { password: PASSWORD }, extra);
  expect(res.status).toBe(200);
  const cookie = String(res.headers['set-cookie']?.[0] ?? '');
  return cookie.split(';')[0];
}

async function start(overrides: Partial<RemoteServerOptions> = {}): Promise<void> {
  server = new RemoteServer({
    port: 0,
    staticDir: path.join(root, 'www'),
    handlers: {
      'app:getVersion': () => '1.2.3',
      echo: (...args: unknown[]) => args,
      boom: () => {
        throw new Error('it broke');
      },
      secret: () => 'should never be reachable',
    },
    allowedChannels: ['app:getVersion', 'echo', 'boom'],
    isPasswordSet: () => true,
    checkPassword: async (password) => password === PASSWORD,
    getAllowedLogins: () => logins,
    now: () => clock,
    ...overrides,
  });
  port = await server.start();
}

beforeEach(() => {
  root = makeTempDir('fileshuttle-remote-');
  writeFile(path.join(root, 'www', 'index.html'), '<!doctype html><title>FileShuttle</title>');
  writeFile(path.join(root, 'www', 'assets', 'app.js'), 'console.log(1)');
  writeFile(path.join(root, 'secret.txt'), 'TOP SECRET');
  logins = [];
  clock = 1_000_000;
});
afterEach(async () => {
  await server?.stop();
  removeDir(root);
});

describe('binding and sign-in', () => {
  it('listens on 127.0.0.1 only', async () => {
    await start();
    expect(server.address()).toEqual({ address: '127.0.0.1', port });
    // A non-loopback address of this machine must not accept connections.
    const external = Object.values(os.networkInterfaces())
      .flat()
      .find((i) => i && i.family === 'IPv4' && !i.internal);
    if (external) {
      const refused = await new Promise<boolean>((resolve) => {
        const socket = net.connect({ host: external.address, port }, () => {
          socket.destroy();
          resolve(false);
        });
        socket.on('error', () => resolve(true));
      });
      expect(refused).toBe(true);
    }
  });

  it('answers 401 without a session and never reaches a handler', async () => {
    await start();
    const rpc = await post('/api/rpc/app:getVersion', []);
    expect(rpc.status).toBe(401);
    expect(rpc.body).not.toContain('1.2.3');
    expect((await request('GET', '/api/events')).status).toBe(401);
    expect((await post('/api/logout', [])).status).toBe(401);
  });

  it('signs in with the right password and sets a locked-down cookie', async () => {
    await start();
    const res = await post('/api/login', { password: PASSWORD });
    expect(res.status).toBe(200);
    const cookie = String(res.headers['set-cookie']?.[0]);
    expect(cookie).toMatch(/^fs_session=[A-Za-z0-9_-]{43};/);
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('Secure');
    expect(cookie).toContain('SameSite=Strict');
    expect(cookie).toContain('Path=/');
    expect(res.body).not.toContain(PASSWORD);

    const session = cookie.split(';')[0];
    const rpc = await post('/api/rpc/app:getVersion', [], { Cookie: session });
    expect(JSON.parse(rpc.body)).toEqual({ ok: true, result: '1.2.3' });
  });

  it('refuses a wrong password without a cookie', async () => {
    await start();
    const res = await post('/api/login', { password: 'nope' });
    expect(res.status).toBe(401);
    expect(res.headers['set-cookie']).toBeUndefined();
    expect((await post('/api/login', { nope: 1 })).status).toBe(400);
  });

  it('rate-limits failed sign-ins, even for the right password afterwards', async () => {
    await start();
    for (let i = 0; i < 5; i++) expect((await post('/api/login', { password: 'bad' + i })).status).toBe(401);
    const blocked = await post('/api/login', { password: PASSWORD });
    expect(blocked.status).toBe(429);
    expect(Number(blocked.headers['retry-after'])).toBeGreaterThan(0);

    clock += 16 * 60 * 1000; // the window passes
    expect((await post('/api/login', { password: PASSWORD })).status).toBe(200);
  });

  it('refuses sign-in while no password is set', async () => {
    await start({ isPasswordSet: () => false });
    expect((await post('/api/login', { password: PASSWORD })).status).toBe(503);
  });

  it('signs out, and lets an idle session expire', async () => {
    await start({ sessionIdleMs: 60_000 });
    const session = await signIn();
    expect((await post('/api/rpc/app:getVersion', [], { Cookie: session })).status).toBe(200);
    expect((await post('/api/logout', [], { Cookie: session })).status).toBe(200);
    expect((await post('/api/rpc/app:getVersion', [], { Cookie: session })).status).toBe(401);

    const second = await signIn();
    clock += 61_000;
    expect((await post('/api/rpc/app:getVersion', [], { Cookie: second })).status).toBe(401);
  });

  it('can sign everyone out', async () => {
    await start();
    const session = await signIn();
    server.clearSessions();
    expect((await post('/api/rpc/app:getVersion', [], { Cookie: session })).status).toBe(401);
  });
});

describe('Tailscale allow list', () => {
  it('refuses missing or unlisted logins before anything else, and lets listed ones in', async () => {
    await start();
    logins = ['Someone@Gmail.com'];
    expect((await request('GET', '/')).status).toBe(403);
    expect((await post('/api/login', { password: PASSWORD })).status).toBe(403);
    expect((await post('/api/login', { password: PASSWORD }, { 'Tailscale-User-Login': 'other@gmail.com' })).status).toBe(403);
    const session = await signIn({ 'Tailscale-User-Login': 'someone@gmail.com' });
    expect((await request('GET', '/', { headers: { 'Tailscale-User-Login': 'someone@gmail.com' } })).status).toBe(200);
    // The session alone is not enough once the list applies.
    expect((await post('/api/rpc/app:getVersion', [], { Cookie: session })).status).toBe(403);
  });

  it('applies no restriction when the list is empty', async () => {
    await start();
    expect((await request('GET', '/')).status).toBe(200);
  });
});

describe('CSRF and request validation', () => {
  it('refuses POSTs without a matching Origin or the custom header', async () => {
    await start();
    const session = await signIn();
    const base = { 'Content-Type': 'application/json', Cookie: session };
    const body = '[]';
    const noOrigin = await request('POST', '/api/rpc/app:getVersion', { headers: { ...base, 'X-FileShuttle': '1' }, body });
    expect(noOrigin.status).toBe(403);
    const wrongOrigin = await request('POST', '/api/rpc/app:getVersion', {
      headers: { ...base, 'X-FileShuttle': '1', Origin: 'https://evil.example' },
      body,
    });
    expect(wrongOrigin.status).toBe(403);
    const nullOrigin = await request('POST', '/api/rpc/app:getVersion', {
      headers: { ...base, 'X-FileShuttle': '1', Origin: 'null' },
      body,
    });
    expect(nullOrigin.status).toBe(403);
    const noHeader = await request('POST', '/api/rpc/app:getVersion', {
      headers: { ...base, Origin: `http://127.0.0.1:${port}` },
      body,
    });
    expect(noHeader.status).toBe(403);
    // A login attempt is a POST too.
    const login = await request('POST', '/api/login', { headers: { 'Content-Type': 'application/json', Origin: 'https://evil.example', 'X-FileShuttle': '1' }, body: JSON.stringify({ password: PASSWORD }) });
    expect(login.status).toBe(403);
  });

  it('accepts the forwarded host when the proxy rewrites Host', async () => {
    await start();
    const res = await request('POST', '/api/login', {
      headers: {
        'Content-Type': 'application/json',
        Host: 'internal.example',
        'X-Forwarded-Host': 'pc.tailnet.ts.net',
        Origin: 'https://pc.tailnet.ts.net',
        'X-FileShuttle': '1',
      },
      body: JSON.stringify({ password: PASSWORD }),
    });
    expect(res.status).toBe(200);
  });

  it('answers 404 for unknown or unlisted channels, even if a handler exists', async () => {
    await start();
    const session = await signIn();
    for (const channel of ['secret', 'nope', '__proto__', 'constructor', 'toString', 'mcp:createToken', 'remote:setPassword']) {
      const res = await post(`/api/rpc/${encodeURIComponent(channel)}`, [], { Cookie: session });
      expect(res.status, channel).toBe(404);
      expect(res.body).not.toContain('should never');
    }
    expect((await post('/api/unknown', [], { Cookie: session })).status).toBe(404);
  });

  it('only accepts POST for rpc, and an array body', async () => {
    await start();
    const session = await signIn();
    expect((await request('GET', '/api/rpc/app:getVersion', { headers: { Cookie: session } })).status).toBe(405);
    expect((await post('/api/rpc/echo', { not: 'an array' }, { Cookie: session })).status).toBe(400);
    const ok = await post('/api/rpc/echo', [1, 'two', { three: 3 }], { Cookie: session });
    expect(JSON.parse(ok.body)).toEqual({ ok: true, result: [1, 'two', { three: 3 }] });
  });

  it('returns a handler error as a message', async () => {
    await start();
    const session = await signIn();
    const res = await post('/api/rpc/boom', [], { Cookie: session });
    expect(res.status).toBe(500);
    expect(JSON.parse(res.body)).toEqual({ ok: false, error: 'it broke' });
  });

  it('caps the request body', async () => {
    await start({ maxBodyBytes: 1024 });
    const session = await signIn();
    const res = await post('/api/rpc/echo', ['x'.repeat(5000)], { Cookie: session });
    expect(res.status).toBe(413);
    // Still serving afterwards.
    expect((await post('/api/rpc/app:getVersion', [], { Cookie: session })).status).toBe(200);
  });
});

describe('static files', () => {
  it('serves the renderer with the security headers', async () => {
    await start();
    const res = await request('GET', '/');
    expect(res.status).toBe(200);
    expect(res.body).toContain('FileShuttle');
    expect(res.headers['content-type']).toContain('text/html');
    expect(res.headers['content-security-policy']).toContain("default-src 'none'");
    expect(res.headers['content-security-policy']).toContain("script-src 'self'");
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['referrer-policy']).toBe('no-referrer');
    expect(res.headers['x-frame-options']).toBe('DENY');
    const js = await request('GET', '/assets/app.js');
    expect(js.status).toBe(200);
    expect(js.headers['content-type']).toContain('javascript');
    expect((await request('GET', '/missing.js')).status).toBe(404);
  });

  it('blocks path traversal', async () => {
    await start();
    for (const p of ['/../secret.txt', '/%2e%2e/secret.txt', '/..%2fsecret.txt', '/assets/../../secret.txt', '/%2e%2e%2fsecret.txt', '/..\\secret.txt', '/%00']) {
      const res = await request('GET', p);
      expect(res.body, p).not.toContain('TOP SECRET');
      expect([400, 404], p).toContain(res.status);
    }
  });

  it('does not follow a symlink out of the static folder', async () => {
    await start();
    try {
      fs.symlinkSync(path.join(root, 'secret.txt'), path.join(root, 'www', 'link.txt'));
    } catch {
      return; // symlinks unavailable here
    }
    const res = await request('GET', '/link.txt');
    expect(res.status).toBe(404);
    expect(res.body).not.toContain('TOP SECRET');
  });

  it('only allows GET and HEAD', async () => {
    await start();
    expect((await request('DELETE', '/')).status).toBe(405);
  });
});

describe('progress events', () => {
  function openStream(cookie: string): Promise<{ read: (needle: string) => Promise<string>; close: () => void }> {
    return new Promise((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port, path: '/api/events', headers: { Cookie: cookie } }, (res) => {
        expect(res.statusCode).toBe(200);
        expect(res.headers['content-type']).toContain('text/event-stream');
        let buffer = '';
        const waiting: { needle: string; resolve: (s: string) => void }[] = [];
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => {
          buffer += chunk;
          for (const w of [...waiting]) {
            if (buffer.includes(w.needle)) {
              waiting.splice(waiting.indexOf(w), 1);
              w.resolve(buffer);
            }
          }
        });
        resolve({
          read: (needle) =>
            new Promise((res2) => {
              if (buffer.includes(needle)) res2(buffer);
              else waiting.push({ needle, resolve: res2 });
            }),
          close: () => req.destroy(),
        });
      });
      req.on('error', (err) => {
        if ((err as NodeJS.ErrnoException).code !== 'ECONNRESET') reject(err);
      });
      req.end();
    });
  }

  it('delivers a progress event to every connected listener, with a heartbeat', async () => {
    await start({ heartbeatMs: 40 });
    const session = await signIn();
    const a = await openStream(session);
    const b = await openStream(session);
    await a.read(': connected');
    await b.read(': connected');

    server.broadcast({ jobId: 7, phase: 'running', processed: 1, total: 3 });
    for (const stream of [a, b]) {
      const text = await stream.read('"jobId":7');
      expect(text).toContain('event: progress');
      expect(text).toContain('data: {"jobId":7,"phase":"running","processed":1,"total":3}');
    }
    await a.read(': ping');
    a.close();
    b.close();
  });

  it('ends the stream once the session is gone', async () => {
    await start({ heartbeatMs: 30 });
    const session = await signIn();
    const stream = await openStream(session);
    await stream.read(': connected');
    server.clearSessions();
    await new Promise((r) => setTimeout(r, 150));
    server.broadcast({ jobId: 1 });
    await new Promise((r) => setTimeout(r, 50));
    let got = '';
    // The stream was closed by the server: nothing new arrives.
    got = await Promise.race([stream.read('"jobId":1'), new Promise<string>((r) => setTimeout(() => r('timeout'), 200))]);
    expect(got).toBe('timeout');
    stream.close();
  });
});

describe('worker endpoints', () => {
  const pairCalls: unknown[] = [];
  const accepted: string[] = [];
  const workers = () => ({
    pair: (input: unknown) => {
      pairCalls.push(input);
      return (input as { code?: string })?.code === 'GOOD'
        ? { status: 200, body: { ok: true, workerId: 'w', token: 't' } }
        : { status: 401, body: { ok: false, error: 'That pairing code is not valid.' } };
    },
    accept: (conn: { onMessage(h: (t: string) => void): void; send(t: string): void }) => {
      accepted.push('connection');
      conn.onMessage((text) => conn.send(`echo:${text}`));
    },
    importSetup: (workerId: unknown, token: unknown, body: unknown) => {
      setupCalls.push({ workerId, token, body });
      return token === 'good-token'
        ? { status: 200, body: { ok: true, mappingsSent: 0, mappingsSkipped: [], jobsSent: 0, jobsSkipped: [] } }
        : { status: 401, body: { ok: false, error: 'not accepted' } };
    },
  });
  const setupCalls: { workerId: unknown; token: unknown; body: unknown }[] = [];
  beforeEach(() => {
    pairCalls.length = 0;
    accepted.length = 0;
    setupCalls.length = 0;
  });

  const sendSetup = (token: string, headers: http.OutgoingHttpHeaders = {}) =>
    request('POST', '/api/workers/import-setup', {
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, ...headers },
      body: JSON.stringify({ workerId: 'w', setup: { mappings: [], jobs: [] } }),
    });

  it('takes a paired machine\'s setup with its bearer token, never from a browser, and slows wrong tokens', async () => {
    await start({ workers: workers() });
    const ok = await sendSetup('good-token');
    expect(ok.status).toBe(200);
    expect(setupCalls[0]).toMatchObject({ workerId: 'w', token: 'good-token' });
    expect((await sendSetup('good-token', { Origin: 'https://evil.example' })).status).toBe(403);
    expect(setupCalls).toHaveLength(1);
    let last = 0;
    for (let i = 0; i < 12; i++) last = (await sendSetup('wrong')).status;
    expect(last).toBe(429);
    expect((await request('GET', '/api/workers/import-setup')).status).toBe(405);
  });

  it('applies the allowed-logins rule to the setup endpoint', async () => {
    logins = ['me@example.com'];
    await start({ workers: workers() });
    expect((await sendSetup('good-token')).status).toBe(403);
    expect((await sendSetup('good-token', { 'Tailscale-User-Login': 'me@example.com' })).status).toBe(200);
  });

  const plain = (body: unknown, headers: http.OutgoingHttpHeaders = {}) =>
    request('POST', '/api/workers/pair', { headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });

  /** An upgrade request as a program (no Origin) or a browser (with one) would make it. */
  function upgrade(headers: Record<string, string> = {}, urlPath = '/api/workers/ws'): Promise<{ head: string; socket: net.Socket }> {
    return new Promise((resolve, reject) => {
      const socket = net.connect(port, '127.0.0.1');
      const key = Buffer.alloc(16, 3).toString('base64');
      const lines = [
        `GET ${urlPath} HTTP/1.1`, 'Host: x', 'Upgrade: websocket', 'Connection: Upgrade', `Sec-WebSocket-Key: ${key}`, 'Sec-WebSocket-Version: 13',
        ...Object.entries(headers).map(([k, v]) => `${k}: ${v}`),
      ];
      socket.write(`${lines.join('\r\n')}\r\n\r\n`);
      let data = '';
      socket.on('data', (d) => {
        data += d;
        if (data.includes('\r\n\r\n')) resolve({ head: data, socket });
      });
      socket.on('error', reject);
      socket.on('close', () => resolve({ head: data, socket }));
    });
  }

  it('pairs without a session or the browser header, but never for a browser', async () => {
    await start({ workers: workers() });
    const ok = await plain({ code: 'GOOD' });
    expect(ok.status).toBe(200);
    expect(JSON.parse(ok.body)).toMatchObject({ ok: true, token: 't' });
    expect(ok.headers['cache-control']).toBe('no-store');
    // A request with an Origin header is a web page: refused before the code is even looked at.
    const fromPage = await plain({ code: 'GOOD' }, { Origin: 'https://evil.example' });
    expect(fromPage.status).toBe(403);
    expect(pairCalls).toHaveLength(1);
    expect((await request('GET', '/api/workers/pair')).status).toBe(405);
  });

  it('is not there at all without worker support', async () => {
    await start();
    expect((await plain({ code: 'GOOD' })).status).toBe(404);
    const refused = await upgrade();
    expect(refused.head).toContain('404');
    refused.socket.destroy();
  });

  it('slows down repeated wrong codes', async () => {
    await start({ workers: workers() });
    let last = 0;
    for (let i = 0; i < 12; i++) last = (await plain({ code: 'BAD' })).status;
    expect(last).toBe(429);
    expect(pairCalls.length).toBeLessThan(12);
  });

  it('applies the allowed-logins rule to pairing and to the socket', async () => {
    logins = ['me@example.com'];
    await start({ workers: workers() });
    expect((await plain({ code: 'GOOD' })).status).toBe(403);
    expect((await plain({ code: 'GOOD' }, { 'Tailscale-User-Login': 'other@example.com' })).status).toBe(403);
    expect((await plain({ code: 'GOOD' }, { 'Tailscale-User-Login': 'Me@Example.com' })).status).toBe(200);
    const blocked = await upgrade();
    expect(blocked.head).toContain('403');
    blocked.socket.destroy();
    const allowed = await upgrade({ 'Tailscale-User-Login': 'me@example.com' });
    expect(allowed.head).toContain('101 Switching Protocols');
    allowed.socket.destroy();
  });

  it('upgrades only /api/workers/ws, and refuses any upgrade that carries an Origin header', async () => {
    await start({ workers: workers() });
    const wrongPath = await upgrade({}, '/api/events');
    expect(wrongPath.head).toContain('404');
    wrongPath.socket.destroy();
    const browser = await upgrade({ Origin: `http://127.0.0.1:${port}` });
    expect(browser.head).toContain('403');
    browser.socket.destroy();
    expect(accepted).toEqual([]);
    const good = await upgrade();
    expect(good.head).toContain('101 Switching Protocols');
    expect(accepted).toEqual(['connection']);
    good.socket.destroy();
  });

  it('closes worker sockets when it stops', async () => {
    await start({ workers: workers() });
    const good = await upgrade();
    const closed = new Promise<void>((resolve) => good.socket.on('close', () => resolve()));
    await server.stop();
    await closed;
  });
});
