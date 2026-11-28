/**
 * Comparing app versions for the "this machine runs an older version" notice. Versions are
 * `MAJOR.MINOR.PATCH` (a leading v and anything after a - or + is ignored); "0.0.0-dev" and
 * anything unreadable count as unknown, and unknown never produces a notice.
 */

export function parseVersion(text: string | null | undefined): [number, number, number] | null {
  if (!text) return null;
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(text.trim());
  if (!match) return null;
  if (/-dev\b/.test(text) || text.trim() === '0.0.0') return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

/** Negative when a < b, zero when equal, positive when a > b; null when either is unknown. */
export function compareVersions(a: string | null | undefined, b: string | null | undefined): number | null {
  const x = parseVersion(a);
  const y = parseVersion(b);
  if (!x || !y) return null;
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] - y[i];
  return 0;
}

/** The notice for a machine, or null when it is not older (or either version is unknown). */
export function versionNotice(workerVersion: string | null, hubVersion: string): string | null {
  const diff = compareVersions(workerVersion, hubVersion);
  if (diff === null || diff >= 0) return null;
  return `Runs version ${workerVersion}, older than this app (${hubVersion}). Update it on that machine.`;
}
