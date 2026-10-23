// Launches the real Electron main process against a throwaway data folder and
// checks that it gets all the way through startup (database open, migrations,
// IPC handlers, scheduler). Unit tests can't cover that wiring.
//
//   npm run smoke
//
// Compiles the main process first (same as `npm run dev:electron`), starts the
// app hidden, waits for "startup complete" in startup.log, then kills it.
const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const root = path.join(__dirname, '..');
const TIMEOUT_MS = 60_000;

function main() {
  console.log('Compiling main process...');
  const tsc = spawnSync(process.execPath, [require.resolve('typescript/bin/tsc'), '-p', 'tsconfig.main.json'], {
    cwd: root,
    stdio: 'inherit',
  });
  if (tsc.status !== 0) return finish(1, 'tsc failed');

  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fileshuttle-smoke-'));
  const logPath = path.join(dataDir, 'startup.log');
  const electronPath = require('electron');

  console.log(`Starting Electron (data dir: ${dataDir})...`);
  const child = spawn(electronPath, ['.', '--start-hidden'], {
    cwd: root,
    env: { ...process.env, FILESHUTTLE_USER_DATA_DIR: dataDir },
    stdio: 'ignore',
  });

  let done = false;
  const stop = (code, message) => {
    if (done) return;
    done = true;
    clearInterval(poll);
    clearTimeout(timer);
    // Electron spawns helper processes; take the whole tree down.
    if (process.platform === 'win32') {
      spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
    } else {
      child.kill('SIGKILL');
    }
    setTimeout(() => {
      try {
        fs.rmSync(dataDir, { recursive: true, force: true });
      } catch {
        // best effort
      }
      finish(code, message, logPath);
    }, 500);
  };

  const readLog = () => {
    try {
      return fs.readFileSync(logPath, 'utf8');
    } catch {
      return '';
    }
  };

  const poll = setInterval(() => {
    const log = readLog();
    if (log.includes('main: startup complete')) return stop(0, 'startup complete');
    if (log.includes('main: startup failed')) return stop(1, 'startup FAILED:\n' + log.split('\n').slice(-12).join('\n'));
  }, 250);
  const timer = setTimeout(() => stop(1, `no "startup complete" within ${TIMEOUT_MS / 1000}s`), TIMEOUT_MS);
  child.on('exit', (code) => {
    if (!done) stop(1, `Electron exited early with code ${code}`);
  });
}

function finish(code, message) {
  console.log(code === 0 ? `SMOKE OK: ${message}` : `SMOKE FAILED: ${message}`);
  process.exit(code);
}

main();
