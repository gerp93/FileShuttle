import * as fs from 'fs';
import * as path from 'path';
import { APP_VERSION, ConfigError, parseServerConfig } from './config';
import { prepareDataDir, startServer } from './server';
import { flushDatabase, initDatabase } from '../main/database/schema';
import { setStartupLogQuiet } from '../main/startupLog';
import { setRemotePassword } from '../main/remote/remoteSettings';
import { createMcpToken, listMcpTokens, revokeMcpToken } from '../main/mcp/tokens';
import { createPairingCode } from '../main/hub/pairing';
import { loadWorkerConfig, WorkerConfigError } from '../main/worker/workerConfig';
import { HubUrlError } from '../main/worker/hubClient';
import { pairWorker, startWorker } from './workerMode';
import { installLogon, LogonError, uninstallLogon } from './logon';

export const USAGE = `FileShuttle server ${APP_VERSION}

Usage: fileshuttle-server <command>

  all            hub and a local worker in one process (what the systemd unit runs)
  hub            the hub only (database, schedules, web UI and API); runs nothing itself
  worker         run this machine as a worker for a hub it was paired with
  worker pair --hub <address> --code <code> [--name <name>]
                 pair this machine with a hub (the code is made in the hub's Settings > Machines, or with pair-code)
  worker install-logon     (Windows) start the worker when you sign in, as you, hidden, no admin needed
  worker uninstall-logon   (Windows) stop starting it at sign-in
  pair-code      make a one-time code (valid 10 minutes) for pairing a worker; run it on the hub
  set-password   set the password for the web UI (typed twice, or one line on stdin)
  mcp-token create <name>   make an access token for the MCP server (shown once)
  mcp-token list            list the tokens (names and dates, never the tokens)
  mcp-token revoke <name>   remove a token
  --version      print the version

Settings come from the environment (see /etc/fileshuttle-server/server.env):
  FILESHUTTLE_SERVER_DATA_DIR  FILESHUTTLE_SERVER_PORT  FILESHUTTLE_SERVER_HOST  FILESHUTTLE_SERVER_WEB_DIR
A worker reads FILESHUTTLE_WORKER_DATA_DIR, FILESHUTTLE_WORKER_HUB, FILESHUTTLE_WORKER_NAME and
FILESHUTTLE_WORKER_ALLOWED_FOLDERS (folders separated by ":" , or ";" on Windows), or the same in worker.json.
The server listens on a loopback address only; publish it with "tailscale serve" (never Funnel).
`;

/** The arguments after the program name, whether run as `node file.cjs ...` or as a single executable. */
function sameFile(a: string, b: string): boolean {
  const real = (p: string): string => {
    try {
      return fs.realpathSync(path.resolve(p));
    } catch {
      return path.resolve(p);
    }
  };
  return real(a) === real(b);
}

/** True when running as a Node single executable. Electron's Node and older Node have no node:sea. */
function runningAsSea(): boolean {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return (require('node:sea') as { isSea(): boolean }).isSea();
  } catch {
    return false;
  }
}

export function userArgs(argv: string[], execPath: string = process.execPath, isSea: boolean = runningAsSea()): string[] {
  // A single executable always gets its own name again in argv[1], exactly as typed: a bare
  // `fileshuttle-server` when run from PATH, which no path comparison can match. So skip it outright.
  if (isSea) return argv.slice(2);
  const first = argv[1];
  // A single executable can see its own path again in argv[1], as typed: through the /usr/bin symlink, while
  // execPath is the real file under /usr/lib. Compare real paths, or `fileshuttle-server --version` reads the
  // symlink's path as the command.
  const skip = first !== undefined && (sameFile(first, execPath) || /\.[cm]?js$/.test(first));
  return argv.slice(skip ? 2 : 1);
}

function readLineFromStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => (data += chunk));
    process.stdin.on('end', () => resolve(data.split(/\r?\n/)[0] ?? ''));
    process.stdin.on('error', reject);
  });
}

/** Reads a line from the terminal without echoing it. */
function promptHidden(question: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const stdin = process.stdin;
    process.stderr.write(question);
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');
    let value = '';
    const finish = (err?: Error) => {
      stdin.setRawMode(false);
      stdin.pause();
      stdin.removeListener('data', onData);
      process.stderr.write('\n');
      if (err) reject(err);
      else resolve(value);
    };
    const onData = (chunk: string) => {
      for (const ch of chunk) {
        if (ch === '\r' || ch === '\n' || ch === '\u0004') return finish();
        if (ch === '\u0003') return finish(new Error('cancelled'));
        if (ch === '\u007f' || ch === '\b') value = value.slice(0, -1);
        else value += ch;
      }
    };
    stdin.on('data', onData);
  });
}

async function setPasswordCommand(): Promise<number> {
  const config = parseServerConfig();
  let password: string;
  if (process.stdin.isTTY) {
    password = await promptHidden('New password: ');
    const again = await promptHidden('Repeat it: ');
    if (password !== again) {
      console.error('The two passwords do not match; nothing was changed.');
      return 1;
    }
  } else {
    password = await readLineFromStdin();
  }
  const dbPath = prepareDataDir(config);
  setStartupLogQuiet(true);
  const db = await initDatabase(dbPath);
  try {
    await setRemotePassword(db, password); // throws a readable message if too short/long
    flushDatabase(db);
  } finally {
    db.close();
  }
  console.log('Password saved. A running server uses it right away; everyone is signed out only when it restarts.');
  return 0;
}

/** `mcp-token create|list|revoke`. Exit codes: 0 done, 1 failed, 2 usage. */
async function mcpTokenCommand(args: string[]): Promise<number> {
  const action = args[0];
  const name = args.slice(1).join(' ').trim();
  const usage = (): number => {
    console.error('Usage: fileshuttle-server mcp-token create <name> | list | revoke <name>');
    return 2;
  };
  if (action === 'create' || action === 'revoke') {
    if (!name) return usage();
  } else if (action !== 'list' || args.length > 1) {
    return usage();
  }
  const config = parseServerConfig();
  const dbPath = prepareDataDir(config);
  setStartupLogQuiet(true);
  const db = await initDatabase(dbPath);
  try {
    if (action === 'create') {
      const made = createMcpToken(db, name); // throws a readable message for a bad or repeated name
      flushDatabase(db);
      console.log(made.token);
      console.error(
        `Token "${made.name}" made. It is shown only now; copy it. To use it with Claude Code:\n` +
          `  claude mcp add --transport http fileshuttle https://<host>/mcp --header "Authorization: Bearer ${made.token}"`
      );
      return 0;
    }
    if (action === 'revoke') {
      const removed = revokeMcpToken(db, name);
      flushDatabase(db);
      if (!removed) {
        console.error(`There is no token named "${name}".`);
        return 1;
      }
      console.log(`Token "${name}" revoked.`);
      return 0;
    }
    const tokens = listMcpTokens(db);
    if (tokens.length === 0) console.log('No MCP tokens. MCP is off until one is made.');
    for (const t of tokens) console.log(`${t.name}\tmade ${t.createdAt}\t${t.lastUsedAt ? `last used ${t.lastUsedAt}` : 'never used'}`);
    return 0;
  } finally {
    db.close();
  }
}

/** `pair-code`: makes a one-time code in the hub's own database (the running hub accepts it right away). */
async function pairCodeCommand(): Promise<number> {
  const config = parseServerConfig();
  const dbPath = prepareDataDir(config);
  setStartupLogQuiet(true);
  const db = await initDatabase(dbPath);
  try {
    const made = createPairingCode(db);
    flushDatabase(db);
    console.log(made.code);
    console.error(`This code works once and expires at ${made.expiresAt} (10 minutes). On the worker machine run:\n  fileshuttle-server worker pair --hub <the hub's https address> --code ${made.code}`);
    return 0;
  } finally {
    db.close();
  }
}

/** Reads `--name value` / `--name=value` options. */
function readOptions(args: string[], names: string[]): { values: Record<string, string>; rest: string[] } | null {
  const values: Record<string, string> = {};
  const rest: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    const match = /^--([a-z]+)(?:=(.*))?$/.exec(arg);
    if (!match) {
      rest.push(arg);
      continue;
    }
    if (!names.includes(match[1])) return null;
    const value = match[2] ?? args[++i];
    if (value === undefined) return null;
    values[match[1]] = value;
  }
  return { values, rest };
}

/** `worker pair --hub <address> --code <code> [--name <name>]`. */
async function workerPairCommand(args: string[]): Promise<number> {
  const parsed = readOptions(args, ['hub', 'code', 'name']);
  if (!parsed || parsed.rest.length > 0 || !parsed.values.hub || !parsed.values.code) {
    console.error('Usage: fileshuttle-server worker pair --hub <address> --code <code> [--name <name>]');
    return 2;
  }
  const config = loadWorkerConfig();
  const result = await pairWorker(config, { hubUrl: parsed.values.hub, code: parsed.values.code, name: parsed.values.name });
  console.log(`Paired as "${result.name}". Allowed folders are set on this machine (FILESHUTTLE_WORKER_ALLOWED_FOLDERS or ${config.dataDir}/worker.json); until you add one it refuses every folder.`);
  console.log('Start it with: fileshuttle-server worker');
  return 0;
}

function waitForSignal(stop: () => Promise<void>): Promise<void> {
  return new Promise((resolve) => {
    let stopping = false;
    const handler = (signal: string) => {
      if (stopping) return;
      stopping = true;
      console.log(`${signal} received, shutting down`);
      stop().then(resolve, (err) => {
        console.error('error while shutting down:', err);
        resolve();
      });
    };
    process.on('SIGTERM', () => handler('SIGTERM'));
    process.on('SIGINT', () => handler('SIGINT'));
  });
}

/** Runs one subcommand and resolves with the exit code. For `hub` and `all` it resolves only after SIGTERM/SIGINT. */
export async function runCli(args: string[]): Promise<number> {
  const command = args[0];
  if (command === '--version' || command === '-v' || command === 'version') {
    console.log(APP_VERSION);
    return 0;
  }
  try {
    switch (command) {
      case 'hub':
      case 'all': {
        const config = parseServerConfig();
        const running = await startServer(command, config);
        console.log(
          `FileShuttle server ${APP_VERSION} (${command}) listening on http://${config.host}:${running.address.port} ` +
            `(data: ${config.dataDir}). Publish it with "tailscale serve", never Funnel.`
        );
        if (!running.hasPassword()) {
          console.warn('No password is set yet, so nobody can sign in. Run: fileshuttle-server set-password');
        }
        await waitForSignal(() => running.stop());
        return 0;
      }
      case 'worker': {
        if (args[1] === 'pair') return await workerPairCommand(args.slice(2));
        if ((args[1] === 'install-logon' || args[1] === 'uninstall-logon') && args.length === 2) {
          if (args[1] === 'install-logon') {
            const exe = await installLogon();
            console.log(`The worker will start at sign-in as you, with no window: ${exe} worker\nRemove it with: fileshuttle-server worker uninstall-logon`);
          } else {
            console.log((await uninstallLogon()) ? 'The worker no longer starts at sign-in.' : 'It was not set to start at sign-in.');
          }
          return 0;
        }
        if (args.length > 1) {
          console.error(USAGE);
          return 2;
        }
        const config = loadWorkerConfig();
        const running = await startWorker(config);
        console.log(`FileShuttle worker ${APP_VERSION} "${config.name}" connecting to ${config.hubUrl} (data: ${config.dataDir}).`);
        await waitForSignal(async () => running.stop());
        return 0;
      }
      case 'pair-code':
        return await pairCodeCommand();
      case 'set-password':
        return await setPasswordCommand();
      case 'mcp-token':
        return await mcpTokenCommand(args.slice(1));
      default:
        console.error(USAGE);
        return 2;
    }
  } catch (err) {
    if (err instanceof WorkerConfigError || err instanceof HubUrlError || err instanceof LogonError) {
      console.error(err.message);
      return 2;
    }
    if (err instanceof ConfigError) {
      console.error(`Configuration problem: ${err.message}`);
      return 2;
    }
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code === 'EADDRINUSE') {
      console.error('That port is already in use. Choose another with FILESHUTTLE_SERVER_PORT.');
      return 1;
    }
    console.error(err instanceof Error ? err.message : String(err));
    return 1;
  }
}
