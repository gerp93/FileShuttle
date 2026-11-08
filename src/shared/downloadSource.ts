/**
 * Pure helpers for the "Download source" filter. Windows browsers record where a
 * download came from in the file's `Zone.Identifier` stream (Mark of the Web):
 *
 *   [ZoneTransfer]
 *   ZoneId=3
 *   ReferrerUrl=https://github.com/owner/repo/releases
 *   HostUrl=https://objects.githubusercontent.com/...
 *
 * No fs and no Electron in here, so the editor, the IPC layer and the engine
 * all parse and match in exactly the same way.
 */

export interface DownloadOrigin {
  /** The page the user was on when they started the download. */
  referrerUrl: string | null;
  /** The URL the file was actually fetched from (often a CDN, not the page). */
  hostUrl: string | null;
}

/** A normalized "download source" rule value: a domain, optionally with a path prefix. */
export interface SourcePattern {
  host: string;
  /** Lower-case path prefix without a leading or trailing slash; '' when the rule is domain-only. */
  path: string;
}

/** Temporary names browsers use while a download is still in progress. Never matched. */
export const PARTIAL_DOWNLOAD_EXTENSIONS: ReadonlySet<string> = new Set([
  'crdownload',
  'part',
  'partial',
  'download',
  'opdownload',
  'tmp',
]);

/** Pulls the two URLs out of the text of a Zone.Identifier stream; null when it names neither. */
export function parseZoneIdentifier(text: string): DownloadOrigin | null {
  let referrerUrl: string | null = null;
  let hostUrl: string | null = null;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    const eq = line.indexOf('=');
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim().toLowerCase();
    const value = line.slice(eq + 1).trim();
    if (!value) continue;
    if (key === 'referrerurl') referrerUrl = value;
    else if (key === 'hosturl') hostUrl = value;
  }
  return referrerUrl || hostUrl ? { referrerUrl, hostUrl } : null;
}

/**
 * Turns what the user typed ("github.com", "https://www.github.com/owner/repo/")
 * into a host and optional path prefix, or null when it can't be used.
 */
export function parseSourcePattern(value: string): SourcePattern | null {
  let text = value.trim().toLowerCase();
  text = text.replace(/^[a-z][a-z0-9+.-]*:\/\//, '');
  text = text.replace(/[?#].*$/, '');
  text = text.replace(/^\*\./, '').replace(/^www\./, '');
  const slash = text.indexOf('/');
  const host = (slash < 0 ? text : text.slice(0, slash)).replace(/:\d+$/, '');
  const pathPart = slash < 0 ? '' : text.slice(slash).replace(/^\/+|\/+$/g, '');
  if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/.test(host)) return null;
  return { host, path: pathPart };
}

/** Why a rule value can't be used, or null when it is fine. */
export function validateSourcePattern(value: string): string | null {
  return parseSourcePattern(value)
    ? null
    : 'enter a website such as github.com (optionally followed by a path, e.g. github.com/owner/repo)';
}

interface ParsedUrl {
  host: string;
  path: string;
}

function parseUrl(raw: string): ParsedUrl | null {
  // Browsers record blob: downloads as blob:https://site/uuid -- the site is what we want.
  const text = raw.trim().replace(/^blob:/i, '');
  try {
    const url = new URL(text);
    if (!url.hostname) return null;
    return { host: url.hostname.toLowerCase().replace(/^www\./, ''), path: url.pathname.toLowerCase() };
  } catch {
    return null;
  }
}

function urlMatches(raw: string | null, pattern: SourcePattern): boolean {
  if (!raw) return false;
  const url = parseUrl(raw);
  if (!url) return false;
  if (url.host !== pattern.host && !url.host.endsWith(`.${pattern.host}`)) return false;
  if (!pattern.path) return true;
  const urlPath = url.path.replace(/^\/+|\/+$/g, '');
  return urlPath === pattern.path || urlPath.startsWith(`${pattern.path}/`);
}

/**
 * True when either the page the download started from or the URL it was fetched
 * from is on the rule's website (the site itself or any of its subdomains), and
 * under the rule's path when it has one. A file with no recorded origin never matches.
 */
export function matchesDownloadSource(origin: DownloadOrigin | null | undefined, ruleValue: string): boolean {
  if (!origin) return false;
  const pattern = parseSourcePattern(ruleValue);
  if (!pattern) return false;
  return urlMatches(origin.referrerUrl, pattern) || urlMatches(origin.hostUrl, pattern);
}
