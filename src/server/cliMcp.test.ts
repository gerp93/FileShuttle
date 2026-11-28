import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeTempDir, removeDir } from '../main/engine/testUtils';
import { runCli } from './cli';

vi.mock('../main/startupLog', () => ({
  logStartupStep: () => undefined,
  setStartupLogToFile: () => undefined,
  setStartupLogQuiet: () => undefined,
}));

const linuxOnly = describe.skipIf(process.platform === 'win32');

let root: string;
let out: string[];
let err: string[];

beforeEach(() => {
  root = makeTempDir('fileshuttle-cli-');
  process.env.FILESHUTTLE_SERVER_DATA_DIR = path.join(root, 'data');
  out = [];
  err = [];
  vi.spyOn(console, 'log').mockImplementation((...a) => void out.push(a.join(' ')));
  vi.spyOn(console, 'error').mockImplementation((...a) => void err.push(a.join(' ')));
});
afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.FILESHUTTLE_SERVER_DATA_DIR;
  removeDir(root);
});

linuxOnly('mcp-token CLI', () => {
  it('creates a token (printed once, with the Claude Code hint), lists it without the token, and revokes it', async () => {
    expect(await runCli(['mcp-token', 'list'])).toBe(0);
    expect(out.join('\n')).toMatch(/No MCP tokens/);

    out.length = 0;
    expect(await runCli(['mcp-token', 'create', 'my', 'laptop'])).toBe(0);
    const token = out[0];
    expect(token).toMatch(/^fsm_[A-Za-z0-9_-]{20,}$/);
    expect(err.join('\n')).toContain('claude mcp add --transport http fileshuttle https://<host>/mcp --header "Authorization: Bearer ' + token);

    out.length = 0;
    expect(await runCli(['mcp-token', 'list'])).toBe(0);
    expect(out.join('\n')).toContain('my laptop');
    expect(out.join('\n')).toContain('never used');
    expect(out.join('\n')).not.toContain(token);

    expect(await runCli(['mcp-token', 'create', 'My Laptop'])).toBe(1); // names are unique, ignoring case
    expect(await runCli(['mcp-token', 'revoke', 'my laptop'])).toBe(0);
    expect(await runCli(['mcp-token', 'revoke', 'my laptop'])).toBe(1);
  });

  it('exits 2 on bad usage', async () => {
    expect(await runCli(['mcp-token'])).toBe(2);
    expect(await runCli(['mcp-token', 'create'])).toBe(2);
    expect(await runCli(['mcp-token', 'revoke'])).toBe(2);
    expect(await runCli(['mcp-token', 'list', 'extra'])).toBe(2);
    expect(await runCli(['mcp-token', 'frobnicate'])).toBe(2);
  });
});
