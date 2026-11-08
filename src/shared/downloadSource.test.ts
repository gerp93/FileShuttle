import { describe, expect, it } from 'vitest';
import { matchesDownloadSource, parseSourcePattern, parseZoneIdentifier, validateSourcePattern } from './downloadSource';
import { validateFilterRule } from './validation';

describe('parseZoneIdentifier', () => {
  it('reads the referrer and host URLs', () => {
    const text = '[ZoneTransfer]\r\nZoneId=3\r\nReferrerUrl=https://github.com/o/r/releases\r\nHostUrl=https://objects.githubusercontent.com/x.zip\r\n';
    expect(parseZoneIdentifier(text)).toEqual({
      referrerUrl: 'https://github.com/o/r/releases',
      hostUrl: 'https://objects.githubusercontent.com/x.zip',
    });
  });

  it('accepts a stream with only one of the two URLs', () => {
    expect(parseZoneIdentifier('[ZoneTransfer]\nZoneId=3\nHostUrl=https://a.example/f.zip')).toEqual({
      referrerUrl: null,
      hostUrl: 'https://a.example/f.zip',
    });
  });

  it('returns null when the stream names no URL', () => {
    expect(parseZoneIdentifier('[ZoneTransfer]\r\nZoneId=3\r\n')).toBeNull();
    expect(parseZoneIdentifier('')).toBeNull();
  });
});

describe('parseSourcePattern', () => {
  it('reduces a typed value to a host and path', () => {
    expect(parseSourcePattern('GitHub.com')).toEqual({ host: 'github.com', path: '' });
    expect(parseSourcePattern('https://www.github.com/Owner/Repo/')).toEqual({ host: 'github.com', path: 'owner/repo' });
    expect(parseSourcePattern('*.example.org')).toEqual({ host: 'example.org', path: '' });
    expect(parseSourcePattern('localhost:3000/files?x=1#top')).toEqual({ host: 'localhost', path: 'files' });
  });

  it('rejects values that are not a website', () => {
    for (const bad of ['', '   ', 'not a site', '/just/a/path', 'bad_host.com', '-x.com', 'a..b']) {
      expect(parseSourcePattern(bad), bad).toBeNull();
      expect(validateSourcePattern(bad), bad).not.toBeNull();
    }
  });
});

describe('matchesDownloadSource', () => {
  const github = {
    referrerUrl: 'https://github.com/owner/repo/releases/tag/v1',
    hostUrl: 'https://objects.githubusercontent.com/abc/file.zip?token=1',
  };

  it('matches the page the download started on', () => {
    expect(matchesDownloadSource(github, 'github.com')).toBe(true);
  });

  it('matches the URL the file was fetched from, including subdomains', () => {
    expect(matchesDownloadSource(github, 'githubusercontent.com')).toBe(true);
    expect(matchesDownloadSource(github, 'objects.githubusercontent.com')).toBe(true);
  });

  it('is not fooled by a lookalike or a longer domain', () => {
    expect(matchesDownloadSource(github, 'hub.com')).toBe(false);
    expect(matchesDownloadSource({ referrerUrl: 'https://evilgithub.com/', hostUrl: null }, 'github.com')).toBe(false);
    expect(matchesDownloadSource({ referrerUrl: 'https://github.com.evil.io/', hostUrl: null }, 'github.com')).toBe(false);
  });

  it('ignores www on either side', () => {
    expect(matchesDownloadSource({ referrerUrl: 'https://www.example.com/a', hostUrl: null }, 'example.com')).toBe(true);
    expect(matchesDownloadSource({ referrerUrl: 'https://example.com/a', hostUrl: null }, 'www.example.com')).toBe(true);
  });

  it('applies a path prefix on whole path segments, case-insensitively', () => {
    expect(matchesDownloadSource(github, 'github.com/Owner/Repo')).toBe(true);
    expect(matchesDownloadSource(github, 'github.com/owner')).toBe(true);
    expect(matchesDownloadSource(github, 'github.com/own')).toBe(false);
    expect(matchesDownloadSource(github, 'github.com/other/repo')).toBe(false);
  });

  it('understands blob: URLs', () => {
    expect(
      matchesDownloadSource({ referrerUrl: null, hostUrl: 'blob:https://app.example.com/3f2a-uuid' }, 'example.com')
    ).toBe(true);
  });

  it('never matches a file with no recorded origin, or an unusable URL', () => {
    expect(matchesDownloadSource(null, 'github.com')).toBe(false);
    expect(matchesDownloadSource(undefined, 'github.com')).toBe(false);
    expect(matchesDownloadSource({ referrerUrl: null, hostUrl: null }, 'github.com')).toBe(false);
    expect(matchesDownloadSource({ referrerUrl: null, hostUrl: 'about:internet' }, 'github.com')).toBe(false);
    expect(matchesDownloadSource(github, 'not a site')).toBe(false);
  });
});

describe('download_source rule validation', () => {
  const rule = (value: string) => ({ field: 'download_source' as const, operator: 'matches' as const, value, group: 0 });

  it('accepts a website', () => {
    expect(validateFilterRule(rule('github.com'))).toBeNull();
    expect(validateFilterRule(rule('github.com/owner/repo'))).toBeNull();
  });

  it('rejects an empty or unusable value and a wrong operator', () => {
    expect(validateFilterRule(rule(''))).not.toBeNull();
    expect(validateFilterRule(rule('not a site'))).toMatch(/website/);
    expect(validateFilterRule({ ...rule('github.com'), operator: 'equals' })).toMatch(/isn’t valid/);
  });
});
