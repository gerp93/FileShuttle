/**
 * Turns an error thrown across Electron's IPC boundary into something fit to
 * show a user. Electron prefixes the main-process message with
 * "Error invoking remote method 'channel': Error: " which is just noise.
 */
export function errorMessage(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  return raw
    .replace(/^Error invoking remote method '[^']*':\s*/, '')
    .replace(/^[A-Za-z]*Error:\s*/, '')
    .trim();
}
