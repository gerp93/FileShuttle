import * as fs from 'fs';
import { spawn } from 'child_process';

// Standalone script, run via `electron.exe` with ELECTRON_RUN_AS_NODE=1 (so it
// behaves as plain Node with no Electron app bootstrap). Spawned detached by
// the main process at the very start of startup, so it survives even if the
// thing it's watching hangs on the single JS thread and never gets to run any
// of its own code again (a JS-level setTimeout watchdog *inside* the app
// can't help with that -- it would be just as stuck as everything else).
//
// Watches for startup.log never reaching "startup complete" within
// TIMEOUT_MS. If that happens, kills the hung process and relaunches once
// (up to MAX_ATTEMPTS total) so a rare, unreproducible startup hang resolves
// itself instead of silently sitting there forever with no way for the user
// to tell "still stuck" from "about to appear any second."
const [, , pidArg, logPath, attemptArg, exePath] = process.argv;
const targetPid = Number(pidArg);
const attempt = Number(attemptArg);
const TIMEOUT_MS = 25000;
const POLL_MS = 1000;
const MAX_ATTEMPTS = 2;
const WAIT_FOR_DEATH_MS = 5000;
const GRACE_AFTER_DEATH_MS = 2000;
const startedAt = Date.now();

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function log(line: string): void {
  try {
    fs.appendFileSync(logPath, `[watchdog ${new Date().toISOString()}] ${line}\n`);
  } catch {
    // best-effort; nothing else to do if this fails
  }
}

function readLog(): string {
  try {
    return fs.readFileSync(logPath, 'utf-8');
  } catch {
    return '';
  }
}

function relaunch(): void {
  log(`relaunching (attempt ${attempt + 1} of ${MAX_ATTEMPTS}): ${exePath}`);
  // spawn() returning doesn't mean the OS actually created the process --
  // success/failure only shows up later via the 'spawn'/'error' events. Wait
  // for one of those (with a hard cap so a wedged spawn call can't hang this
  // forever) before exiting, so a failed relaunch is at least visible here
  // instead of vanishing with zero trace.
  const child = spawn(exePath, [], {
    detached: true,
    stdio: 'ignore',
    env: { ...process.env, FILESHUTTLE_WATCHDOG_ATTEMPT: String(attempt + 1) },
  });
  const finish = () => process.exit(0);
  child.once('error', (err) => {
    log(`relaunch FAILED to spawn: ${err && err.stack ? err.stack : String(err)}`);
    finish();
  });
  child.once('spawn', () => {
    log(`relaunch spawned successfully, pid ${child.pid}`);
    child.unref();
    finish();
  });
  setTimeout(() => {
    log('relaunch spawn() neither errored nor confirmed spawning within 5s -- giving up waiting');
    finish();
  }, 5000).unref();
}

function killThenRelaunch(): void {
  try {
    process.kill(targetPid);
  } catch {
    // already gone
  }
  log(`startup did not complete within ${TIMEOUT_MS}ms (attempt ${attempt}); killed pid ${targetPid}`);

  if (attempt >= MAX_ATTEMPTS) {
    log(`giving up after ${attempt} retries -- leaving it stopped rather than retrying forever`);
    process.exit(0);
    return;
  }

  // Confirmed live: relaunching ~12ms after the kill meant the new process's
  // own requestSingleInstanceLock() call raced the OS still tearing down the
  // killed process's (and its GPU/renderer/utility children's) handles --
  // it lost that race, concluded another instance was already running, and
  // quietly self-terminated before ever reaching whenReady. No crash, no log
  // line, no trace: exactly what "the retry silently did nothing" looks
  // like. Wait for the PID to actually be gone, then a further grace period,
  // before spawning the replacement.
  const waitStart = Date.now();
  const waitForDeath = setInterval(() => {
    const dead = !isAlive(targetPid);
    const timedOut = Date.now() - waitStart > WAIT_FOR_DEATH_MS;
    if (!dead && !timedOut) return;

    clearInterval(waitForDeath);
    log(
      dead
        ? `pid ${targetPid} confirmed gone after ${Date.now() - waitStart}ms; waiting a further ${GRACE_AFTER_DEATH_MS}ms before relaunching`
        : `pid ${targetPid} still not confirmed gone after ${WAIT_FOR_DEATH_MS}ms; relaunching anyway`
    );
    setTimeout(relaunch, dead ? GRACE_AFTER_DEATH_MS : 0);
  }, 200);
}

const interval = setInterval(() => {
  if (!isAlive(targetPid)) {
    clearInterval(interval);
    process.exit(0);
  }

  const log = readLog();
  if (log.includes('main: startup complete') || log.includes('main: startup failed:')) {
    clearInterval(interval);
    process.exit(0);
  }

  if (Date.now() - startedAt > TIMEOUT_MS) {
    clearInterval(interval);
    killThenRelaunch();
  }
}, POLL_MS);
