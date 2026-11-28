import { createHash, randomBytes } from 'crypto';
import type * as http from 'http';
import type * as net from 'net';

/**
 * The server side of RFC 6455 (WebSocket), written by hand because the app takes no new
 * dependencies. It speaks only what the hub/worker link needs: text messages (JSON), ping/pong
 * and close. Binary messages are refused, a client frame must be masked, and a message is capped
 * in size.
 */

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

/** The largest message (after joining fragments) that is accepted. A schedule or a run's file rows can be big. */
export const MAX_MESSAGE_BYTES = 16 * 1024 * 1024;

export const OP_CONTINUATION = 0x0;
export const OP_TEXT = 0x1;
export const OP_BINARY = 0x2;
export const OP_CLOSE = 0x8;
export const OP_PING = 0x9;
export const OP_PONG = 0xa;

export function acceptKey(clientKey: string): string {
  return createHash('sha1').update(clientKey + GUID).digest('base64');
}

export interface EncodeOptions {
  /** Clients mask what they send; a server never does. */
  mask?: boolean;
  fin?: boolean;
}

/** One frame, ready to write. */
export function encodeFrame(opcode: number, payload: Buffer, options: EncodeOptions = {}): Buffer {
  const fin = options.fin ?? true;
  const masked = options.mask ?? false;
  const length = payload.length;
  let headerLength = 2;
  if (length > 0xffff) headerLength += 8;
  else if (length > 125) headerLength += 2;
  if (masked) headerLength += 4;
  const frame = Buffer.alloc(headerLength + length);
  frame[0] = (fin ? 0x80 : 0) | (opcode & 0x0f);
  let offset = 1;
  const maskBit = masked ? 0x80 : 0;
  if (length > 0xffff) {
    frame[offset++] = maskBit | 127;
    frame.writeUInt32BE(Math.floor(length / 0x100000000), offset);
    frame.writeUInt32BE(length >>> 0, offset + 4);
    offset += 8;
  } else if (length > 125) {
    frame[offset++] = maskBit | 126;
    frame.writeUInt16BE(length, offset);
    offset += 2;
  } else {
    frame[offset++] = maskBit | length;
  }
  if (masked) {
    const key = randomBytes(4);
    key.copy(frame, offset);
    offset += 4;
    for (let i = 0; i < length; i++) frame[offset + i] = payload[i] ^ key[i % 4];
  } else {
    payload.copy(frame, offset);
  }
  return frame;
}

export function encodeClose(code: number, reason: string, options: EncodeOptions = {}): Buffer {
  const text = Buffer.from(reason, 'utf8').subarray(0, 123);
  const payload = Buffer.alloc(2 + text.length);
  payload.writeUInt16BE(code, 0);
  text.copy(payload, 2);
  return encodeFrame(OP_CLOSE, payload, options);
}

export type ParsedEvent =
  | { type: 'message'; text: string }
  | { type: 'ping'; payload: Buffer }
  | { type: 'pong'; payload: Buffer }
  | { type: 'close'; code: number | null; reason: string }
  | { type: 'error'; code: number; reason: string };

export interface FrameParserOptions {
  /** True on the server: a frame from a client that is not masked is a protocol error. */
  requireMasked: boolean;
  maxMessageBytes?: number;
}

const strictUtf8 = new TextDecoder('utf-8', { fatal: true });

/** A close code that may appear on the wire (RFC 6455, 7.4). */
function closeCodeValid(code: number): boolean {
  if (code >= 3000 && code <= 4999) return true;
  return [1000, 1001, 1002, 1003, 1007, 1008, 1009, 1010, 1011].includes(code);
}

/**
 * Turns the bytes of a connection into events. After an `error` event nothing more is parsed:
 * the owner must close the connection with that code.
 */
export class FrameParser {
  private buffer: Buffer = Buffer.alloc(0);
  private fragments: Buffer[] = [];
  private fragmentBytes = 0;
  private fragmenting = false;
  private failed = false;
  private readonly max: number;

  constructor(private readonly opts: FrameParserOptions) {
    this.max = opts.maxMessageBytes ?? MAX_MESSAGE_BYTES;
  }

  push(chunk: Buffer): ParsedEvent[] {
    const events: ParsedEvent[] = [];
    if (this.failed) return events;
    this.buffer = this.buffer.length ? Buffer.concat([this.buffer, chunk]) : chunk;
    for (;;) {
      const event = this.next();
      if (event === 'more') break;
      if (event) events.push(event);
      if (this.failed) break;
    }
    return events;
  }

  private fail(code: number, reason: string): ParsedEvent {
    this.failed = true;
    this.buffer = Buffer.alloc(0);
    this.fragments = [];
    return { type: 'error', code, reason };
  }

  /** The next event, null for a frame that produced none (a non-final fragment), or 'more' when bytes are missing. */
  private next(): ParsedEvent | null | 'more' {
    const buf = this.buffer;
    if (buf.length < 2) return 'more';
    const b0 = buf[0];
    const b1 = buf[1];
    const fin = (b0 & 0x80) !== 0;
    if ((b0 & 0x70) !== 0) return this.fail(1002, 'Reserved bits are not supported.');
    const opcode = b0 & 0x0f;
    const masked = (b1 & 0x80) !== 0;
    let length = b1 & 0x7f;
    let offset = 2;
    const control = opcode >= 0x8;
    if (![OP_CONTINUATION, OP_TEXT, OP_BINARY, OP_CLOSE, OP_PING, OP_PONG].includes(opcode)) {
      return this.fail(1002, 'Unknown frame type.');
    }
    if (control && (!fin || length > 125)) return this.fail(1002, 'A control frame must be short and not split.');
    if (this.opts.requireMasked && !masked) return this.fail(1002, 'Client frames must be masked.');
    if (length === 126) {
      if (buf.length < offset + 2) return 'more';
      length = buf.readUInt16BE(offset);
      offset += 2;
    } else if (length === 127) {
      if (buf.length < offset + 8) return 'more';
      const high = buf.readUInt32BE(offset);
      const low = buf.readUInt32BE(offset + 4);
      offset += 8;
      if ((high & 0x80000000) !== 0) return this.fail(1002, 'Bad frame length.');
      length = high * 0x100000000 + low;
    }
    if (!control && this.fragmentBytes + length > this.max) {
      return this.fail(1009, 'That message is too large.');
    }
    let maskKey: Buffer | null = null;
    if (masked) {
      if (buf.length < offset + 4) return 'more';
      maskKey = buf.subarray(offset, offset + 4);
      offset += 4;
    }
    if (buf.length < offset + length) return 'more';
    const payload = Buffer.from(buf.subarray(offset, offset + length));
    this.buffer = buf.subarray(offset + length);
    if (maskKey) for (let i = 0; i < payload.length; i++) payload[i] ^= maskKey[i % 4];

    switch (opcode) {
      case OP_PING:
        return { type: 'ping', payload };
      case OP_PONG:
        return { type: 'pong', payload };
      case OP_CLOSE:
        return this.parseClose(payload);
      case OP_BINARY:
        return this.fail(1003, 'Binary messages are not supported.');
      case OP_TEXT:
      case OP_CONTINUATION: {
        if (opcode === OP_TEXT) {
          if (this.fragmenting) return this.fail(1002, 'A new message began before the last one ended.');
          this.fragmenting = true;
        } else if (!this.fragmenting) {
          return this.fail(1002, 'A continuation frame arrived with nothing to continue.');
        }
        this.fragments.push(payload);
        this.fragmentBytes += payload.length;
        if (!fin) return null;
        const whole = this.fragments.length === 1 ? this.fragments[0] : Buffer.concat(this.fragments);
        this.fragments = [];
        this.fragmentBytes = 0;
        this.fragmenting = false;
        try {
          return { type: 'message', text: strictUtf8.decode(whole) };
        } catch {
          return this.fail(1007, 'The message is not valid text.');
        }
      }
    }
    return null;
  }

  private parseClose(payload: Buffer): ParsedEvent {
    if (payload.length === 0) return { type: 'close', code: null, reason: '' };
    if (payload.length === 1) return this.fail(1002, 'Bad close frame.');
    const code = payload.readUInt16BE(0);
    if (!closeCodeValid(code)) return this.fail(1002, 'Bad close code.');
    let reason = '';
    try {
      reason = strictUtf8.decode(payload.subarray(2));
    } catch {
      return this.fail(1007, 'The close reason is not valid text.');
    }
    return { type: 'close', code, reason };
  }
}

// ---------------------------------------------------------------- upgrade handshake

export type UpgradeCheck = { ok: true; key: string } | { ok: false; status: number; message: string };

/**
 * Checks a WebSocket upgrade request. A request that carries an Origin header is refused: the
 * worker is a program, not a web page, so a browser (which always sends one) is never a legitimate
 * client of this socket, and refusing it closes the cross-site WebSocket hijacking hole.
 */
export function checkUpgradeRequest(req: http.IncomingMessage): UpgradeCheck {
  const header = (name: string): string | null => {
    const v = req.headers[name];
    return Array.isArray(v) ? (v[0] ?? null) : typeof v === 'string' ? v : null;
  };
  if (req.method !== 'GET') return { ok: false, status: 405, message: 'Method not allowed.' };
  if (header('origin') !== null) return { ok: false, status: 403, message: 'Browsers cannot use this connection.' };
  if (header('upgrade')?.toLowerCase() !== 'websocket') return { ok: false, status: 400, message: 'Not a WebSocket upgrade.' };
  const connection = (header('connection') ?? '').toLowerCase().split(',').map((t) => t.trim());
  if (!connection.includes('upgrade')) return { ok: false, status: 400, message: 'Not a WebSocket upgrade.' };
  if (header('sec-websocket-version') !== '13') return { ok: false, status: 426, message: 'Only WebSocket version 13 is supported.' };
  const key = header('sec-websocket-key');
  if (!key || Buffer.from(key, 'base64').length !== 16) return { ok: false, status: 400, message: 'Bad WebSocket key.' };
  return { ok: true, key };
}

/** Ends an upgrade request with a plain HTTP answer. */
export function refuseUpgrade(socket: net.Socket, status: number, message: string): void {
  const reasons: Record<number, string> = {
    400: 'Bad Request',
    403: 'Forbidden',
    404: 'Not Found',
    405: 'Method Not Allowed',
    426: 'Upgrade Required',
    503: 'Service Unavailable',
  };
  const body = message;
  socket.end(
    `HTTP/1.1 ${status} ${reasons[status] ?? 'Error'}\r\nConnection: close\r\nContent-Type: text/plain; charset=utf-8\r\n` +
      `Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`
  );
}

// ---------------------------------------------------------------- the connection

/** What the hub and the tests need of a connection. */
export interface WebSocketConnection {
  send(text: string): void;
  ping(): void;
  /** Sends a close frame and ends the connection (it is destroyed if the peer does not answer). */
  close(code: number, reason: string): void;
  /** Drops the connection at once. */
  terminate(): void;
  onMessage(handler: (text: string) => void): void;
  onPong(handler: () => void): void;
  /** Called once when the connection is over, by whichever side ended it. */
  onClose(handler: (code: number | null, reason: string) => void): void;
  readonly remoteAddress: string | null;
}

export class ServerWebSocket implements WebSocketConnection {
  private readonly parser: FrameParser;
  private messageHandler: ((text: string) => void) | null = null;
  private pongHandler: (() => void) | null = null;
  private closeHandlers: Array<(code: number | null, reason: string) => void> = [];
  private closed = false;
  private closeSent = false;
  private lastCode: number | null = null;
  private lastReason = '';
  private closeTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly socket: net.Socket,
    opts: { maxMessageBytes?: number; head?: Buffer } = {}
  ) {
    this.parser = new FrameParser({ requireMasked: true, maxMessageBytes: opts.maxMessageBytes });
    socket.setNoDelay(true);
    socket.on('data', (chunk: Buffer) => this.receive(chunk));
    socket.on('error', () => socket.destroy());
    socket.on('close', () => this.finish());
    if (opts.head && opts.head.length > 0) this.receive(opts.head);
  }

  get remoteAddress(): string | null {
    return this.socket.remoteAddress ?? null;
  }

  onMessage(handler: (text: string) => void): void {
    this.messageHandler = handler;
  }

  onPong(handler: () => void): void {
    this.pongHandler = handler;
  }

  onClose(handler: (code: number | null, reason: string) => void): void {
    if (this.closed) handler(this.lastCode, this.lastReason);
    else this.closeHandlers.push(handler);
  }

  send(text: string): void {
    if (this.closed || this.closeSent) return;
    this.socket.write(encodeFrame(OP_TEXT, Buffer.from(text, 'utf8')));
  }

  ping(): void {
    if (this.closed || this.closeSent) return;
    this.socket.write(encodeFrame(OP_PING, Buffer.alloc(0)));
  }

  close(code: number, reason: string): void {
    if (this.closed) return;
    this.lastCode = code;
    this.lastReason = reason;
    if (!this.closeSent) {
      this.closeSent = true;
      this.socket.write(encodeClose(code, reason));
      this.socket.end();
    }
    this.closeTimer ??= setTimeout(() => this.socket.destroy(), 2000);
    this.closeTimer.unref?.();
  }

  terminate(): void {
    this.socket.destroy();
  }

  private receive(chunk: Buffer): void {
    if (this.closed) return;
    for (const event of this.parser.push(chunk)) {
      if (this.closed) return;
      switch (event.type) {
        case 'message':
          try {
            this.messageHandler?.(event.text);
          } catch {
            // A handler's own failure must never take the connection down with it.
          }
          break;
        case 'ping':
          if (!this.closeSent) this.socket.write(encodeFrame(OP_PONG, event.payload));
          break;
        case 'pong':
          this.pongHandler?.();
          break;
        case 'close':
          this.lastCode = event.code;
          this.lastReason = event.reason;
          if (!this.closeSent) {
            this.closeSent = true;
            this.socket.write(encodeClose(event.code ?? 1000, ''));
          }
          this.socket.end();
          break;
        case 'error':
          this.close(event.code, event.reason);
          return;
      }
    }
  }

  private finish(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.closeTimer) clearTimeout(this.closeTimer);
    const handlers = this.closeHandlers;
    this.closeHandlers = [];
    for (const handler of handlers) handler(this.lastCode, this.lastReason);
  }
}

/** Completes the handshake on an upgrade request that passed `checkUpgradeRequest`, and returns the connection. */
export function completeUpgrade(
  socket: net.Socket,
  head: Buffer,
  key: string,
  opts: { maxMessageBytes?: number } = {}
): ServerWebSocket {
  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n' +
      `Sec-WebSocket-Accept: ${acceptKey(key)}\r\n\r\n`
  );
  return new ServerWebSocket(socket, { maxMessageBytes: opts.maxMessageBytes, head });
}
