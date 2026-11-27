import * as fs from 'fs';
import * as path from 'path';
import { getUserDataDir } from './appPaths';

// Temporary startup-diagnostics logging: a launch has been observed hanging
// indefinitely somewhere during startup on some machines, with no error and
// no other symptom besides the loading screen never going away. A normal
// double-click launch has no attached console, so console.log alone is
// useless here -- write each step to a file in userData instead, so a stuck
// launch's log says exactly which step never returned. Remove once the
// cause is found and fixed.
let writeFile = true;
let quiet = false;

/** Silences the console echo too (a one-shot command like `set-password` has no use for the step list). */
export function setStartupLogQuiet(value: boolean): void {
  quiet = value;
}

/** The headless server logs to stdout (journald) only; a startup.log that is never reset would just grow. */
export function setStartupLogToFile(enabled: boolean): void {
  writeFile = enabled;
}

export function getStartupLogPath(): string {
  return path.join(getUserDataDir(), 'startup.log');
}

// The log is append-only across a process's run, but must start empty each
// launch -- otherwise a stale "startup complete" line from a previous run
// would make the watchdog (watchdog.ts) think *this* run finished instantly
// when it's actually the one that's stuck. Call once, before the first
// logStartupStep() of a run.
export function resetStartupLog(): void {
  try {
    fs.writeFileSync(getStartupLogPath(), '');
  } catch {
    // best-effort diagnostic logging; never let it break startup
  }
}

export function logStartupStep(label: string): void {
  const line = `[startup ${new Date().toISOString()}] ${label}`;
  if (!quiet) console.log(line);
  if (!writeFile) return;
  try {
    fs.appendFileSync(getStartupLogPath(), line + '\n');
  } catch {
    // best-effort diagnostic logging; never let it break startup
  }
}
