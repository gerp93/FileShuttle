import * as http from 'http';
import * as net from 'net';
import { afterEach, describe, expect, it } from 'vitest';
import {
  FrameParser,
  OP_BINARY,
  OP_CLOSE,
  OP_CONTINUATION,
  OP_PING,
  OP_PONG,
  OP_TEXT,
  ParsedEvent,
  ServerWebSocket,
  acceptKey,
  checkUpgradeRequest,
  completeUpgrade,
  encodeClose,
  encodeFrame,
  refuseUpgrade,
} from './webSocket';

const text = (s: string) => Buffer.from(s, 'utf8');
const server = () => new FrameParser({ requireMasked: true });

describe('acceptKey', () => {
  it('matches the example in RFC 6455', () => {
    expect(acceptKey('dGhlIHNhbXBsZSBub25jZQ==')).toBe('s3pPLMBiTxaQ9kYGzzhZRbK+xOo=');
  });
});

describe('FrameParser', () => {
  it('reads a masked text frame, and a frame split across chunks', () => {
    const frame = encodeFrame(OP_TEXT, text('hello'), { mask: true });
    const p = server();
    expect(p.push(frame.subarray(0, 3))).toEqual([]);
    expect(p.push(frame.subarray(3))).toEqual([{ type: 'message', text: 'hello' }]);
  });

  it('refuses an unmasked client frame, but reads an unmasked server frame', () => {
    expect(server().push(encodeFrame(OP_TEXT, text('x')))).toEqual([{ type: 'error', code: 1002, reason: 'Client frames must be masked.' }]);
    const client = new FrameParser({ requireMasked: false });
    expect(client.push(encodeFrame(OP_TEXT, text('x')))).toEqual([{ type: 'message', text: 'x' }]);
  });

  it('handles the 16-bit and 64-bit length forms', () => {
    const medium = 'm'.repeat(300);
    const large = 'l'.repeat(70_000);
    const p = server();
    expect(p.push(encodeFrame(OP_TEXT, text(medium), { mask: true }))).toEqual([{ type: 'message', text: medium }]);
    const big = encodeFrame(OP_TEXT, text(large), { mask: true });
    expect(big[1] & 0x7f).toBe(127);
    expect(p.push(big)).toEqual([{ type: 'message', text: large }]);
    const mid = encodeFrame(OP_TEXT, text(medium), { mask: true });
    expect(mid[1] & 0x7f).toBe(126);
  });

  it('joins fragments, with a ping allowed in between', () => {
    const p = server();
    const events = [
      ...p.push(encodeFrame(OP_TEXT, text('he'), { mask: true, fin: false })),
      ...p.push(encodeFrame(OP_PING, text('p'), { mask: true })),
      ...p.push(encodeFrame(OP_CONTINUATION, text('l'), { mask: true, fin: false })),
      ...p.push(encodeFrame(OP_CONTINUATION, text('lo'), { mask: true })),
    ];
    expect(events.map((e) => e.type)).toEqual(['ping', 'message']);
    expect((events[1] as { text: string }).text).toBe('hello');
  });

  it('keeps a multi-byte character that is split between fragments', () => {
    const bytes = text('é'); // two bytes
    const p = server();
    p.push(encodeFrame(OP_TEXT, bytes.subarray(0, 1), { mask: true, fin: false }));
    expect(p.push(encodeFrame(OP_CONTINUATION, bytes.subarray(1), { mask: true }))).toEqual([{ type: 'message', text: 'é' }]);
  });

  it('answers pong and close events', () => {
    const p = server();
    expect(p.push(encodeFrame(OP_PONG, Buffer.alloc(0), { mask: true }))[0].type).toBe('pong');
    expect(p.push(encodeClose(1000, 'bye', { mask: true }))).toEqual([{ type: 'close', code: 1000, reason: 'bye' }]);
  });

  const failure = (frame: Buffer, opts = { requireMasked: true } as { requireMasked: boolean; maxMessageBytes?: number }): ParsedEvent =>
    new FrameParser(opts).push(frame)[0];

  it('rejects binary, unknown opcodes, reserved bits and bad control frames', () => {
    expect(failure(encodeFrame(OP_BINARY, text('x'), { mask: true }))).toMatchObject({ type: 'error', code: 1003 });
    const unknown = encodeFrame(0x3, text('x'), { mask: true });
    expect(failure(unknown)).toMatchObject({ type: 'error', code: 1002 });
    const reserved = encodeFrame(OP_TEXT, text('x'), { mask: true });
    reserved[0] |= 0x40;
    expect(failure(reserved)).toMatchObject({ type: 'error', code: 1002 });
    expect(failure(encodeFrame(OP_PING, text('x'), { mask: true, fin: false }))).toMatchObject({ type: 'error', code: 1002 });
    expect(failure(encodeFrame(OP_PING, Buffer.alloc(126), { mask: true }))).toMatchObject({ type: 'error', code: 1002 });
  });

  it('rejects a continuation with nothing to continue, and a new message inside a fragmented one', () => {
    expect(failure(encodeFrame(OP_CONTINUATION, text('x'), { mask: true }))).toMatchObject({ type: 'error', code: 1002 });
    const p = server();
    p.push(encodeFrame(OP_TEXT, text('a'), { mask: true, fin: false }));
    expect(p.push(encodeFrame(OP_TEXT, text('b'), { mask: true }))[0]).toMatchObject({ type: 'error', code: 1002 });
  });

  it('rejects invalid UTF-8 and bad close frames', () => {
    expect(failure(encodeFrame(OP_TEXT, Buffer.from([0xff, 0xfe]), { mask: true }))).toMatchObject({ type: 'error', code: 1007 });
    expect(failure(encodeFrame(OP_CLOSE, Buffer.from([0x03]), { mask: true }))).toMatchObject({ type: 'error', code: 1002 });
    expect(failure(encodeClose(1005, '', { mask: true }))).toMatchObject({ type: 'error', code: 1002 });
  });

  it('refuses a message over the cap, even before all of it has arrived, and stops parsing afterwards', () => {
    const p = new FrameParser({ requireMasked: true, maxMessageBytes: 100 });
    const head = encodeFrame(OP_TEXT, text('x'.repeat(200)), { mask: true }).subarray(0, 10);
    expect(p.push(head)).toEqual([{ type: 'error', code: 1009, reason: 'That message is too large.' }]);
    expect(p.push(encodeFrame(OP_TEXT, text('ok'), { mask: true }))).toEqual([]);
    // Fragments count together.
    const q = new FrameParser({ requireMasked: true, maxMessageBytes: 100 });
    q.push(encodeFrame(OP_TEXT, text('x'.repeat(60)), { mask: true, fin: false }));
    expect(q.push(encodeFrame(OP_CONTINUATION, text('x'.repeat(60)), { mask: true }))[0]).toMatchObject({ code: 1009 });
  });

  it('rejects a 64-bit length with the top bit set', () => {
    const frame = Buffer.alloc(14);
    frame[0] = 0x81;
    frame[1] = 0x80 | 127;
    frame[2] = 0x80;
    expect(server().push(frame)[0]).toMatchObject({ type: 'error', code: 1002 });
  });
});

describe('checkUpgradeRequest', () => {
  const request = (headers: Record<string, string>, method = 'GET') =>
    checkUpgradeRequest({ method, headers } as unknown as http.IncomingMessage);
  const good = {
    upgrade: 'websocket',
    connection: 'keep-alive, Upgrade',
    'sec-websocket-version': '13',
    'sec-websocket-key': Buffer.alloc(16, 1).toString('base64'),
  };

  it('accepts a proper request', () => {
    expect(request(good)).toEqual({ ok: true, key: good['sec-websocket-key'] });
  });

  it('refuses any request that carries an Origin header, and the other defects', () => {
    expect(request({ ...good, origin: 'https://evil.example' })).toMatchObject({ ok: false, status: 403 });
    expect(request(good, 'POST')).toMatchObject({ ok: false, status: 405 });
    expect(request({ ...good, upgrade: 'h2c' })).toMatchObject({ ok: false, status: 400 });
    expect(request({ ...good, connection: 'close' })).toMatchObject({ ok: false, status: 400 });
    expect(request({ ...good, 'sec-websocket-version': '8' })).toMatchObject({ ok: false, status: 426 });
    expect(request({ ...good, 'sec-websocket-key': 'short' })).toMatchObject({ ok: false, status: 400 });
  });
});

// ---------------------------------------------------------------- over a real socket

describe('a connection', () => {
  let httpServer: http.Server | null = null;
  const sockets: net.Socket[] = [];
  afterEach(async () => {
    for (const s of sockets.splice(0)) s.destroy();
    await new Promise<void>((resolve) => (httpServer ? httpServer.close(() => resolve()) : resolve()));
    httpServer = null;
  });

  async function start(onConnection: (c: ServerWebSocket) => void): Promise<number> {
    httpServer = http.createServer();
    httpServer.on('upgrade', (req, socket, head) => {
      const check = checkUpgradeRequest(req);
      if (!check.ok) return refuseUpgrade(socket, check.status, check.message);
      onConnection(completeUpgrade(socket, head, check.key));
    });
    await new Promise<void>((resolve) => httpServer!.listen(0, '127.0.0.1', resolve));
    return (httpServer!.address() as net.AddressInfo).port;
  }

  /** A raw client: sends its own bytes, so a test can send what a real client never would. */
  function rawClient(port: number, extraHeaders = ''): Promise<{ socket: net.Socket; head: string; next(): Promise<Buffer> }> {
    return new Promise((resolve, reject) => {
      const socket = net.connect(port, '127.0.0.1');
      sockets.push(socket);
      const key = Buffer.alloc(16, 7).toString('base64');
      socket.write(
        `GET /ws HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n${extraHeaders}\r\n`
      );
      let buffer = Buffer.alloc(0);
      const waiters: Array<() => void> = [];
      socket.on('data', (d) => {
        buffer = Buffer.concat([buffer, d]);
        waiters.splice(0).forEach((w) => w());
      });
      socket.on('error', reject);
      const ready = () => {
        const end = buffer.indexOf('\r\n\r\n');
        if (end < 0) return false;
        const head = buffer.subarray(0, end).toString();
        buffer = buffer.subarray(end + 4);
        resolve({
          socket,
          head,
          next: async () => {
            while (buffer.length === 0) await new Promise<void>((r) => waiters.push(r));
            const out = buffer;
            buffer = Buffer.alloc(0);
            return out;
          },
        });
        return true;
      };
      if (!ready()) waiters.push(function again() { if (!ready()) waiters.push(again); });
    });
  }

  it('completes the handshake, echoes text, answers pings and closes politely', async () => {
    const received: string[] = [];
    const closed = new Promise<[number | null, string]>((resolve) => {
      start((c) => {
        c.onMessage((m) => {
          received.push(m);
          c.send(`echo:${m}`);
        });
        c.onClose((code, reason) => resolve([code, reason]));
      }).then(async (port) => {
        const client = await rawClient(port);
        expect(client.head).toContain('101 Switching Protocols');
        expect(client.head).toContain(`Sec-WebSocket-Accept: ${acceptKey(Buffer.alloc(16, 7).toString('base64'))}`);
        client.socket.write(encodeFrame(OP_TEXT, text('hi'), { mask: true }));
        const reply = new FrameParser({ requireMasked: false }).push(await client.next());
        expect(reply).toEqual([{ type: 'message', text: 'echo:hi' }]);
        client.socket.write(encodeFrame(OP_PING, text('abc'), { mask: true }));
        const pong = new FrameParser({ requireMasked: false }).push(await client.next());
        expect(pong[0]).toMatchObject({ type: 'pong' });
        client.socket.write(encodeClose(1000, 'done', { mask: true }));
      });
    });
    expect(await closed).toEqual([1000, 'done']);
    expect(received).toEqual(['hi']);
  });

  it('closes a connection that sends an unmasked frame with 1002', async () => {
    const closed = new Promise<[number | null, string]>((resolve) => {
      start((c) => c.onClose((code, reason) => resolve([code, reason]))).then(async (port) => {
        const client = await rawClient(port);
        client.socket.write(encodeFrame(OP_TEXT, text('x')));
        const events = new FrameParser({ requireMasked: false }).push(await client.next());
        expect(events[0]).toMatchObject({ type: 'close', code: 1002 });
      });
    });
    expect((await closed)[0]).toBe(1002);
  });

  it('works with Node’s own WebSocket client, for small and large messages', async () => {
    const WS = (globalThis as unknown as { WebSocket?: new (url: string) => any }).WebSocket; // eslint-disable-line @typescript-eslint/no-explicit-any
    if (!WS) return; // Node older than 22: the hub needs it only on the worker side
    const port = await start((c) => c.onMessage((m) => c.send(m)));
    const ws = new WS(`ws://127.0.0.1:${port}/ws`);
    await new Promise<void>((resolve, reject) => {
      ws.onopen = () => resolve();
      ws.onerror = () => reject(new Error('could not connect'));
    });
    for (const size of [10, 200, 70_000]) {
      const payload = 'z'.repeat(size);
      const echoed = new Promise<string>((resolve) => (ws.onmessage = (ev: { data: string }) => resolve(ev.data)));
      ws.send(payload);
      expect(await echoed).toBe(payload);
    }
    ws.close();
  });

  it('refuses an upgrade with an Origin header over HTTP', async () => {
    const port = await start(() => undefined);
    const client = await new Promise<string>((resolve) => {
      const socket = net.connect(port, '127.0.0.1');
      sockets.push(socket);
      const key = Buffer.alloc(16, 7).toString('base64');
      socket.write(
        `GET /ws HTTP/1.1\r\nHost: x\r\nOrigin: https://evil.example\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`
      );
      let data = '';
      socket.on('data', (d) => (data += d));
      socket.on('close', () => resolve(data));
    });
    expect(client).toContain('403 Forbidden');
  });
});
