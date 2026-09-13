import * as fs from 'fs';
import * as path from 'path';
import { app } from 'electron';

// Temporary startup-diagnostics logging: a launch has been observed hanging
// indefinitely somewhere during startup on some machines, with no error and
// no other symptom besides the loading screen never going away. A normal
// double-click launch has no attached console, so console.log alone is
// useless here -- write each step to a file in userData instead, so a stuck
// launch's log says exactly which step never returned. Remove once the
// cause is found and fixed.
export function logStartupStep(label: string): void {
  const line = `[startup ${new Date().toISOString()}] ${label}`;
  console.log(line);
  try {
    const logPath = path.join(app.getPath('userData'), 'startup.log');
    fs.appendFileSync(logPath, line + '\n');
  } catch {
    // best-effort diagnostic logging; never let it break startup
  }
}
