import { afterEach, describe, expect, it } from 'vitest';
import { RemoteTransport, WebSocketLike } from './hubClient';

/** A socket that behaves like Node 22's WebSocket when it cannot connect: an error event and never a close event. */
class ErrorOnlySocket implements WebSocketLike {
  readyState = 0;
  onopen: WebSocketLike['onopen'] = null;
  onmessage: WebSocketLike['onmessage'] = null;
  onclose: WebSocketLike['onclose'] = null;
  onerror: WebSocketLike['onerror'] = null;
  closed = false;
  constructor(readonly mode: 'error-only' | 'opens') {
    queueMicrotask(() => {
      if (mode === 'error-only') this.onerror?.({});
      else {
        this.readyState = 1;
        this.onopen?.({});
      }
    });
  }
  send(): void {}
  close(): void {
    this.closed = true;
    this.readyState = 3;
  }
}

let transport: RemoteTransport | null = null;
afterEach(() => {
  transport?.stop();
  transport = null;
});

describe('RemoteTransport when a connection cannot be made', () => {
  it('tries again after an error that is never followed by a close event (Node 22), and connects once the hub is back', async () => {
    const sockets: ErrorOnlySocket[] = [];
    let opened = 0;
    transport = new RemoteTransport({
      hubUrl: 'http://127.0.0.1:1',
      backoffStartMs: 20,
      backoffMaxMs: 50,
      onOpen: () => opened++,
      factory: () => {
        const socket = new ErrorOnlySocket(sockets.length < 3 ? 'error-only' : 'opens');
        sockets.push(socket);
        return socket;
      },
    });
    transport.start();
    const deadline = Date.now() + 8000;
    while (opened === 0 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
    expect(sockets.length).toBe(4); // three failures, then the one that connects
    expect(opened).toBe(1);
    expect(transport.connected).toBe(true);
    expect(sockets.slice(0, 3).every((s) => s.closed)).toBe(true); // the failed ones were let go
  });
});
