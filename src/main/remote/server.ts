import * as http from 'http';
import * as fs from 'fs';
import * as path from 'path';
import { randomBytes } from 'crypto';
import type { Handler, HandlerMap } from '../api/handlers';

/**
 * The phone-facing HTTP server. It only ever listens on 127.0.0.1 and is meant to be published
 * with `tailscale serve` (never Funnel), which proxies the tailnet HTTPS address to this port and
 * adds the `Tailscale-User-Login` header. That header is only trustworthy BECAUSE the server binds
 * to loopback behind `tailscale serve`: anything that could reach this port directly could forge it.
 *
 * Nothing here logs passwords, session ids or request bodies.
 */

export const BIND_HOST = '127.0.0.1';
export const SESSION_COOKIE = 'fs_session';
export const CSRF_HEADER = 'x-fileshuttle';

const DAY_MS = 24 * 60 * 60 * 1000;

export interface RemoteServerOptions {
  port: number;
  /** Address to listen on. Default 127.0.0.1; the headless server accepts other loopback addresses (see src/server/config.ts). */
  host?: string;
  /** The built renderer (Vite output). */
  staticDir: string;
  handlers: HandlerMap;
  /** The only channels callable over HTTP. */
  allowedChannels: readonly string[];
  isPasswordSet: () => boolean;
  checkPassword: (password: string) => Promise<boolean>;
  /** Tailscale logins allowed in; empty means no restriction. Read on every request. */
  getAllowedLogins: () => string[];
  /** The MCP endpoint (POST /mcp). It does its own auth (bearer token); null/absent leaves /mcp unserved. */
  mcp?: (req: http.IncomingMessage, res: http.ServerResponse) => Promise<void>;
  /** The door for remote workers (/worker/...). It does its own auth (pairing code, then a worker token); absent leaves /worker unserved. */
  workers?: (req: http.IncomingMessage, res: http.ServerResponse) => Promise<void>;
  onError?: (message: string) => void;
  sessionIdleMs?: number;
  maxLoginFailures?: number;
  loginFailureWindowMs?: number;
  maxBodyBytes?: number;
  heartbeatMs?: number;
  maxEventClients?: number;
  now?: () => number;
}

class SessionStore {
  private readonly sessions = new Map<string, number>();

  constructor(
    private readonly idleMs: number,
    private readonly now: () => number
  ) {}

  create(): string {
    this.prune();
    const id = randomBytes(32).toString('base64url');
    this.sessions.set(id, this.now());
    return id;
  }

  /** True while the session exists and has not idled out; `touch` slides its expiry. */
  valid(id: string | null, touch: boolean): boolean {
    if (!id) return false;
    const last = this.sessions.get(id);
    if (last === undefined) return false;
    if (this.now() - last > this.idleMs) {
      this.sessions.delete(id);
      return false;
    }
    if (touch) this.sessions.set(id, this.now());
    return true;
  }

  delete(id: string): void {
    this.sessions.delete(id);
  }

  clear(): void {
    this.sessions.clear();
  }

  private prune(): void {
    const cutoff = this.now() - this.idleMs;
    for (const [id, last] of this.sessions) if (last < cutoff) this.sessions.delete(id);
  }
}

class LoginLimiter {
  private readonly failures = new Map<string, number[]>();

  constructor(
    private readonly max: number,
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

  /** Seconds until another attempt is allowed, or 0 when not blocked. */
  blockedFor(key: string): number {
    const list = this.recent(key);
    if (list.length < this.max) return 0;
    return Math.max(1, Math.ceil((list[0] + this.windowMs - this.now()) / 1000));
  }

  recordFailure(key: string): void {
    if (this.failures.size > 1000) {
      for (const k of [...this.failures.keys()]) this.recent(k);
    }
    const list = this.recent(key);
    list.push(this.now());
    this.failures.set(key, list);
  }

  reset(key: string): void {
    this.failures.delete(key);
  }
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
};

const CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'self'",
  "manifest-src 'self'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ');

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string
  ) {
    super(message);
  }
}

function headerValue(value: string | string[] | undefined): string | null {
  if (Array.isArray(value)) return value[0] ?? null;
  return typeof value === 'string' ? value : null;
}

interface EventClient {
  res: http.ServerResponse;
  sessionId: string;
}

export class RemoteServer {
  private server: http.Server | null = null;
  private readonly sessions: SessionStore;
  private readonly limiter: LoginLimiter;
  private readonly clients = new Set<EventClient>();
  private heartbeat: NodeJS.Timeout | null = null;
  private readonly channels: ReadonlySet<string>;
  private readonly now: () => number;
  private readonly maxBody: number;
  private staticRootReal: string | null = null;

  constructor(private readonly opts: RemoteServerOptions) {
    this.now = opts.now ?? Date.now;
    this.sessions = new SessionStore(opts.sessionIdleMs ?? 30 * DAY_MS, this.now);
    this.limiter = new LoginLimiter(opts.maxLoginFailures ?? 5, opts.loginFailureWindowMs ?? 15 * 60 * 1000, this.now);
    this.channels = new Set(opts.allowedChannels);
    this.maxBody = opts.maxBodyBytes ?? 1024 * 1024;
  }

  /** Starts listening on 127.0.0.1 (or `host`); resolves with the port actually bound (useful with port 0). */
  start(): Promise<number> {
    if (this.server) return Promise.reject(new Error('Remote server is already running.'));
    const server = http.createServer((req, res) => {
      void this.handle(req, res);
    });
    server.requestTimeout = 30_000;
    this.server = server;
    return new Promise<number>((resolve, reject) => {
      const onError = (err: Error) => {
        this.server = null;
        reject(err);
      };
      server.once('error', onError);
      server.listen(this.opts.port, this.opts.host ?? BIND_HOST, () => {
        server.removeListener('error', onError);
        server.on('error', (err) => this.opts.onError?.(err.message));
        const address = server.address();
        this.heartbeat = setInterval(() => this.beat(), this.opts.heartbeatMs ?? 25_000);
        this.heartbeat.unref();
        resolve(typeof address === 'object' && address ? address.port : this.opts.port);
      });
    });
  }

  /** Where the server is listening, or null when stopped. */
  address(): { address: string; port: number } | null {
    const a = this.server?.address();
    return a && typeof a === 'object' ? { address: a.address, port: a.port } : null;
  }

  async stop(): Promise<void> {
    const server = this.server;
    this.server = null;
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = null;
    for (const client of this.clients) client.res.end();
    this.clients.clear();
    this.sessions.clear();
    if (!server) return;
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections();
    });
  }

  /** Signs everyone out (used when the password changes). */
  clearSessions(): void {
    this.sessions.clear();
  }

  /** Sends a run-progress event to every connected phone. */
  broadcast(event: unknown): void {
    if (this.clients.size === 0) return;
    const data = JSON.stringify(event);
    for (const client of this.clients) client.res.write(`event: progress\ndata: ${data}\n\n`);
  }

  private beat(): void {
    for (const client of [...this.clients]) {
      if (!this.sessions.valid(client.sessionId, false)) {
        client.res.end();
        this.clients.delete(client);
      } else {
        client.res.write(': ping\n\n');
      }
    }
  }

  // ---------------------------------------------------------------------------------------------

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    try {
      this.securityHeaders(res);

      // Tailscale allow list: refused before anything else, static files included.
      const allowed = this.opts.getAllowedLogins();
      if (allowed.length > 0) {
        const login = headerValue(req.headers['tailscale-user-login'])?.toLowerCase();
        if (!login || !allowed.some((a) => a.toLowerCase() === login)) {
          return this.json(res, 403, { ok: false, error: 'Not allowed.' });
        }
      }

      let pathname: string;
      try {
        pathname = new URL(req.url ?? '/', 'http://localhost').pathname;
      } catch {
        return this.json(res, 400, { ok: false, error: 'Bad request.' });
      }

      if (pathname === '/mcp' && this.opts.mcp) {
        await this.opts.mcp(req, res);
      } else if ((pathname === '/worker' || pathname.startsWith('/worker/')) && this.opts.workers) {
        await this.opts.workers(req, res);
      } else if (pathname === '/api' || pathname.startsWith('/api/')) {
        await this.handleApi(req, res, pathname);
      } else {
        await this.serveStatic(req, res, pathname);
      }
    } catch (err) {
      if (err instanceof HttpError) {
        if (res.headersSent) return;
        if (err.status === 413) {
          // The rest of the body was never read, so the connection can't be reused.
          res.writeHead(413, { 'Content-Type': 'application/json; charset=utf-8', Connection: 'close' });
          res.end(JSON.stringify({ ok: false, error: err.message }), () => req.socket.destroy());
          return;
        }
        this.json(res, err.status, { ok: false, error: err.message });
        return;
      }
      this.opts.onError?.(err instanceof Error ? err.message : 'Unexpected error');
      if (!res.headersSent) this.json(res, 500, { ok: false, error: 'Server error.' });
      else res.end();
    }
  }

  private securityHeaders(res: http.ServerResponse): void {
    res.setHeader('Content-Security-Policy', CSP);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Frame-Options', 'DENY');
  }

  private json(res: http.ServerResponse, status: number, body: unknown, extra: http.OutgoingHttpHeaders = {}): void {
    const text = JSON.stringify(body) ?? 'null';
    res.writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      ...extra,
    });
    res.end(text);
  }

  private clientKey(req: http.IncomingMessage): string {
    return `${headerValue(req.headers['tailscale-user-login']) ?? ''}|${req.socket.remoteAddress ?? ''}`;
  }

  private sessionIdOf(req: http.IncomingMessage): string | null {
    const cookie = headerValue(req.headers.cookie);
    if (!cookie) return null;
    for (const part of cookie.split(';')) {
      const [name, ...rest] = part.trim().split('=');
      if (name === SESSION_COOKIE) {
        const value = rest.join('=');
        return /^[A-Za-z0-9_-]{43}$/.test(value) ? value : null;
      }
    }
    return null;
  }

  private csrfOk(req: http.IncomingMessage): boolean {
    if (req.headers[CSRF_HEADER] !== '1') return false;
    const origin = headerValue(req.headers.origin);
    if (!origin) return false;
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

  private async readBody(req: http.IncomingMessage, limit: number): Promise<Buffer> {
    const declared = Number(headerValue(req.headers['content-length']) ?? 0);
    if (Number.isFinite(declared) && declared > limit) throw new HttpError(413, 'Request too large.');
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of req) {
      const buf = chunk as Buffer;
      size += buf.length;
      if (size > limit) throw new HttpError(413, 'Request too large.');
      chunks.push(buf);
    }
    return Buffer.concat(chunks);
  }

  private async readJson(req: http.IncomingMessage, limit: number): Promise<unknown> {
    const body = await this.readBody(req, limit);
    try {
      return JSON.parse(body.toString('utf8'));
    } catch {
      throw new HttpError(400, 'The request body must be JSON.');
    }
  }

  private async handleApi(req: http.IncomingMessage, res: http.ServerResponse, pathname: string): Promise<void> {
    const method = req.method ?? 'GET';

    if (method === 'GET' && pathname === '/api/events') {
      const sid = this.sessionIdOf(req);
      if (!this.sessions.valid(sid, true)) return this.json(res, 401, { ok: false, error: 'Sign in required.' });
      return this.openEvents(req, res, sid as string);
    }

    if (method !== 'POST') {
      return this.json(res, 405, { ok: false, error: 'Method not allowed.' }, { Allow: 'POST' });
    }
    if (!this.csrfOk(req)) return this.json(res, 403, { ok: false, error: 'Cross-site request refused.' });

    if (pathname === '/api/login') return this.login(req, res);

    const sid = this.sessionIdOf(req);
    if (!this.sessions.valid(sid, true)) return this.json(res, 401, { ok: false, error: 'Sign in required.' });

    if (pathname === '/api/logout') {
      this.sessions.delete(sid as string);
      return this.json(res, 200, { ok: true }, { 'Set-Cookie': this.cookie('', 0) });
    }

    if (pathname.startsWith('/api/rpc/')) {
      let channel: string;
      try {
        channel = decodeURIComponent(pathname.slice('/api/rpc/'.length));
      } catch {
        return this.json(res, 404, { ok: false, error: 'Unknown channel.' });
      }
      const handler: Handler | undefined =
        this.channels.has(channel) && Object.prototype.hasOwnProperty.call(this.opts.handlers, channel)
          ? this.opts.handlers[channel]
          : undefined;
      if (!handler) return this.json(res, 404, { ok: false, error: 'Unknown channel.' });

      const args = await this.readJson(req, this.maxBody);
      if (!Array.isArray(args)) return this.json(res, 400, { ok: false, error: 'The body must be a JSON array of arguments.' });
      try {
        const result = await handler(...args);
        return this.json(res, 200, { ok: true, result });
      } catch (err) {
        return this.json(res, 500, { ok: false, error: err instanceof Error ? err.message : String(err) });
      }
    }

    return this.json(res, 404, { ok: false, error: 'Not found.' });
  }

  private cookie(value: string, maxAgeSeconds: number): string {
    return `${SESSION_COOKIE}=${value}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=${maxAgeSeconds}`;
  }

  private async login(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const key = this.clientKey(req);
    const wait = this.limiter.blockedFor(key);
    if (wait > 0) {
      return this.json(res, 429, { ok: false, error: 'Too many failed sign-in attempts. Try again later.' }, { 'Retry-After': String(wait) });
    }
    const body = await this.readJson(req, 4096);
    const password = (body as { password?: unknown } | null)?.password;
    if (typeof password !== 'string') return this.json(res, 400, { ok: false, error: 'A password is required.' });
    if (!this.opts.isPasswordSet()) {
      return this.json(res, 503, { ok: false, error: 'No password is set on the PC.' });
    }
    const ok = await this.opts.checkPassword(password);
    if (!ok) {
      this.limiter.recordFailure(key);
      return this.json(res, 401, { ok: false, error: 'Wrong password.' });
    }
    this.limiter.reset(key);
    const sid = this.sessions.create();
    const maxAge = Math.floor((this.opts.sessionIdleMs ?? 30 * DAY_MS) / 1000);
    return this.json(res, 200, { ok: true }, { 'Set-Cookie': this.cookie(sid, maxAge) });
  }

  private openEvents(req: http.IncomingMessage, res: http.ServerResponse, sessionId: string): void {
    if (this.clients.size >= (this.opts.maxEventClients ?? 20)) {
      return this.json(res, 503, { ok: false, error: 'Too many open connections.' });
    }
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write(': connected\n\n');
    const client: EventClient = { res, sessionId };
    this.clients.add(client);
    req.on('close', () => this.clients.delete(client));
  }

  // ---------------------------------------------------------------------------------------------

  private async serveStatic(req: http.IncomingMessage, res: http.ServerResponse, pathname: string): Promise<void> {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      return this.json(res, 405, { ok: false, error: 'Method not allowed.' }, { Allow: 'GET, HEAD' });
    }
    let decoded: string;
    try {
      decoded = decodeURIComponent(pathname);
    } catch {
      return this.json(res, 400, { ok: false, error: 'Bad request.' });
    }
    if (decoded.includes('\0')) return this.json(res, 400, { ok: false, error: 'Bad request.' });

    const root = path.resolve(this.opts.staticDir);
    let candidate = path.resolve(root, '.' + path.posix.normalize('/' + decoded.replace(/\\/g, '/')));
    if (candidate !== root && !candidate.startsWith(root + path.sep)) {
      return this.json(res, 404, { ok: false, error: 'Not found.' });
    }
    try {
      if (!this.staticRootReal) this.staticRootReal = await fs.promises.realpath(root);
      let real = await fs.promises.realpath(candidate);
      if ((await fs.promises.stat(real)).isDirectory()) {
        candidate = path.join(candidate, 'index.html');
        real = await fs.promises.realpath(candidate);
      }
      if (real !== this.staticRootReal && !real.startsWith(this.staticRootReal + path.sep)) {
        return this.json(res, 404, { ok: false, error: 'Not found.' });
      }
      const stat = await fs.promises.stat(real);
      if (!stat.isFile()) return this.json(res, 404, { ok: false, error: 'Not found.' });
      const type = MIME[path.extname(real).toLowerCase()] ?? 'application/octet-stream';
      res.writeHead(200, {
        'Content-Type': type,
        'Content-Length': stat.size,
        // Hashed asset names change on every build; the page itself must be re-checked.
        'Cache-Control': real.includes(`${path.sep}assets${path.sep}`) ? 'public, max-age=3600' : 'no-cache',
      });
      if (req.method === 'HEAD') return void res.end();
      fs.createReadStream(real).on('error', () => res.destroy()).pipe(res);
    } catch {
      this.json(res, 404, { ok: false, error: 'Not found.' });
    }
  }
}
