import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createWebApi, SIGN_IN_REQUIRED, UNAUTHORIZED_EVENT, webLogin } from './webApi';

const fetchMock = vi.fn();
const dispatched: string[] = [];

beforeEach(() => {
  fetchMock.mockReset();
  dispatched.length = 0;
  vi.stubGlobal('fetch', fetchMock);
  vi.stubGlobal('window', { dispatchEvent: (e: Event) => dispatched.push(e.type) });
});
afterEach(() => vi.unstubAllGlobals());

function reply(status: number, body: unknown) {
  return Promise.resolve({ status, ok: status < 400, json: () => Promise.resolve(body) });
}

describe('web API', () => {
  it('posts the arguments as a JSON array with the CSRF header and returns the result', async () => {
    fetchMock.mockReturnValue(reply(200, { ok: true, result: 5 }));
    expect(await createWebApi().mappings.clone(3, 'Copy')).toBe(5);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('api/rpc/mappings%3Aclone');
    expect(init.method).toBe('POST');
    expect(init.credentials).toBe('same-origin');
    expect(init.headers['X-FileShuttle']).toBe('1');
    expect(JSON.parse(init.body)).toEqual([3, 'Copy']);
  });

  it('throws the server message, and announces a lost session', async () => {
    fetchMock.mockReturnValueOnce(reply(500, { ok: false, error: 'bad mapping' }));
    await expect(createWebApi().mappings.get(1)).rejects.toThrow('bad mapping');
    fetchMock.mockReturnValueOnce(reply(401, { ok: false, error: 'Sign in required.' }));
    await expect(createWebApi().jobs.list()).rejects.toThrow(SIGN_IN_REQUIRED);
    expect(dispatched).toEqual([UNAUTHORIZED_EVENT]);
  });

  it('keeps desktop-only calls out of the phone', async () => {
    const api = createWebApi();
    await expect(api.dialogs.pickFolder('x')).rejects.toThrow('Not available from the phone.');
    await expect(api.shell.openPath('/x')).rejects.toThrow('Not available from the phone.');
    await expect(api.dbLocation.get()).rejects.toThrow('Not available from the phone.');
    expect(await api.settings.getStartup()).toEqual({ supported: false, enabled: false });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('signs in without announcing a lost session on a wrong password', async () => {
    fetchMock.mockReturnValueOnce(reply(401, { ok: false, error: 'Wrong password.' }));
    expect(await webLogin('nope')).toBe('Wrong password.');
    fetchMock.mockReturnValueOnce(reply(200, { ok: true }));
    expect(await webLogin('right')).toBeNull();
    expect(dispatched).toEqual([]);
  });
});
