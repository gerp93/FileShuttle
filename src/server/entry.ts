// The bundle's entry point (npm run build:server -> dist/server/fileshuttle-server.cjs). No Electron here.
import { runCli, userArgs } from './cli';

runCli(userArgs(process.argv)).then(
  (code) => process.exit(code),
  (err) => {
    console.error(err instanceof Error ? (err.stack ?? err.message) : String(err));
    process.exit(1);
  }
);
