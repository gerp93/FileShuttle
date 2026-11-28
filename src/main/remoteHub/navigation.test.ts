import { describe, expect, it } from 'vitest';
import { decideNavigation, decideNewWindow } from './navigation';

const hub = 'https://hub.example.ts.net';

describe('remote hub window navigation', () => {
  it('allows the hub\'s exact origin only', () => {
    expect(decideNavigation(hub, 'https://hub.example.ts.net/#/jobs')).toEqual({ kind: 'allow' });
    expect(decideNavigation(hub, 'https://hub.example.ts.net:8443/')).toMatchObject({ kind: 'external' });
    expect(decideNavigation(hub, 'http://hub.example.ts.net/')).toMatchObject({ kind: 'external' });
    expect(decideNavigation(hub, 'https://hub.example.ts.net.evil.example/')).toMatchObject({ kind: 'external' });
    expect(decideNavigation(hub, 'https://evil.example/')).toEqual({ kind: 'external', url: 'https://evil.example/' });
  });

  it('never opens anything but http(s), inside or outside the app', () => {
    for (const bad of ['file:///etc/passwd', 'javascript:alert(1)', 'data:text/html,hi', 'ms-settings:privacy', 'smb://host/share', 'not a url', '']) {
      expect(decideNavigation(hub, bad), bad).toEqual({ kind: 'block' });
      expect(decideNewWindow(hub, bad), bad).toEqual({ kind: 'block' });
    }
  });

  it('sends popups to the system browser, even from the hub itself', () => {
    expect(decideNewWindow(hub, 'https://hub.example.ts.net/x')).toEqual({ kind: 'external', url: 'https://hub.example.ts.net/x' });
    expect(decideNewWindow(hub, 'https://other.example/')).toEqual({ kind: 'external', url: 'https://other.example/' });
  });

  it('works for a loopback hub on plain http', () => {
    expect(decideNavigation('http://127.0.0.1:8787', 'http://127.0.0.1:8787/api')).toEqual({ kind: 'allow' });
    expect(decideNavigation('http://127.0.0.1:8787', 'http://127.0.0.1:8788/')).toMatchObject({ kind: 'external' });
  });
});
