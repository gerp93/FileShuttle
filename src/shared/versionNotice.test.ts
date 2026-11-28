import { describe, expect, it } from 'vitest';
import { compareVersions, parseVersion, versionNotice } from './versionNotice';

describe('version notices', () => {
  it('reads plain versions and a leading v', () => {
    expect(parseVersion('1.2.3')).toEqual([1, 2, 3]);
    expect(parseVersion('v10.0.1')).toEqual([10, 0, 1]);
    expect(parseVersion('1.2.3-beta.1')).toEqual([1, 2, 3]);
  });

  it('treats dev builds and nonsense as unknown', () => {
    expect(parseVersion('0.0.0-dev')).toBeNull();
    expect(parseVersion('0.0.0')).toBeNull();
    expect(parseVersion('1.2')).toBeNull();
    expect(parseVersion('banana')).toBeNull();
    expect(parseVersion(null)).toBeNull();
  });

  it('compares numerically, not as text', () => {
    expect(compareVersions('1.9.0', '1.10.0')).toBeLessThan(0);
    expect(compareVersions('2.0.0', '1.99.99')).toBeGreaterThan(0);
    expect(compareVersions('1.2.3', '1.2.3')).toBe(0);
    expect(compareVersions('1.2.3', '0.0.0-dev')).toBeNull();
  });

  it('warns only about a machine that is older than the hub', () => {
    expect(versionNotice('1.0.0', '1.1.0')).toMatch(/older/);
    expect(versionNotice('1.1.0', '1.1.0')).toBeNull();
    expect(versionNotice('1.2.0', '1.1.0')).toBeNull();
    expect(versionNotice('0.0.0-dev', '1.1.0')).toBeNull();
    expect(versionNotice('1.0.0', '0.0.0-dev')).toBeNull();
    expect(versionNotice(null, '1.1.0')).toBeNull();
  });
});
