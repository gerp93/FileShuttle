import { describe, expect, it, vi } from 'vitest';
import { installArgs, installLogon, logonCommand, LogonError, RUN_KEY, RUN_VALUE, uninstallArgs, uninstallLogon } from './logon';

const EXE = 'C:\\Tools\\FileShuttle\\fileshuttle-server.exe';

describe('start at logon (Run key)', () => {
  it('writes the per-user Run key with an argv, never a shell string', async () => {
    const exec = vi.fn().mockResolvedValue({ stdout: '', stderr: '' });
    await installLogon({ platform: 'win32', exePath: EXE, exec });
    expect(exec).toHaveBeenCalledTimes(1);
    const [file, args] = exec.mock.calls[0];
    expect(file).toBe('reg');
    expect(args.slice(0, 5)).toEqual(['add', RUN_KEY, '/v', RUN_VALUE, '/t']);
    expect(RUN_KEY.startsWith('HKCU\\')).toBe(true);
    expect(args).toEqual(installArgs(EXE));
    expect(args[args.indexOf('/d') + 1]).toBe(logonCommand(EXE));
    expect(logonCommand(EXE)).toContain('-WindowStyle Hidden');
    expect(logonCommand(EXE)).toContain(`'${EXE}'`);
    expect(logonCommand(EXE)).toContain("-ArgumentList 'worker'");
  });

  it('escapes a quote in the exe path', () => {
    expect(logonCommand("C:\\O'Neil\\fs.exe")).toContain("'C:\\O''Neil\\fs.exe'");
  });

  it('removes the key, and reports when there was none', async () => {
    const exec = vi.fn().mockResolvedValue({ stdout: '', stderr: '' });
    expect(await uninstallLogon({ platform: 'win32', exec })).toBe(true);
    expect(exec).toHaveBeenCalledWith('reg', uninstallArgs());
    const missing = vi.fn().mockRejectedValue(Object.assign(new Error('failed'), { stderr: 'ERROR: The system was unable to find the specified registry key or value.' }));
    expect(await uninstallLogon({ platform: 'win32', exec: missing })).toBe(false);
  });

  it('refuses off Windows and when run through node, and surfaces reg failures', async () => {
    const exec = vi.fn();
    await expect(installLogon({ platform: 'linux', exePath: EXE, exec })).rejects.toThrow(LogonError);
    await expect(uninstallLogon({ platform: 'linux', exec })).rejects.toThrow(LogonError);
    await expect(installLogon({ platform: 'win32', exePath: 'C:\\node\\node.exe', exec })).rejects.toThrow(/not through node/);
    expect(exec).not.toHaveBeenCalled();
    const bad = vi.fn().mockRejectedValue(new Error('denied'));
    await expect(installLogon({ platform: 'win32', exePath: EXE, exec: bad })).rejects.toThrow(/Run key/);
  });
});
