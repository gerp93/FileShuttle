/**
 * Where the window that shows the remote hub's own web page may go. The page is another
 * computer's, so it is treated like any website: it stays on the hub's exact origin (scheme, host
 * and port), and every other web address is handed to the system browser instead, where it can
 * not reach this app. Nothing but http and https is ever opened outside the app.
 */

export type NavigationDecision = { kind: 'allow' } | { kind: 'external'; url: string } | { kind: 'block' };

function parse(url: string): URL | null {
  try {
    return new URL(url);
  } catch {
    return null;
  }
}

export function decideNavigation(hubOrigin: string, target: string): NavigationDecision {
  const url = parse(target);
  if (!url) return { kind: 'block' };
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return { kind: 'block' };
  if (url.origin === hubOrigin) return { kind: 'allow' };
  return { kind: 'external', url: url.toString() };
}

/** A new window the hub's page asked for (a link with target=_blank): never opened inside the app. */
export function decideNewWindow(hubOrigin: string, target: string): NavigationDecision {
  const d = decideNavigation(hubOrigin, target);
  // Even a same-origin popup is not opened as a second window; the system browser handles it.
  if (d.kind === 'allow') return { kind: 'external', url: new URL(target).toString() };
  return d;
}
