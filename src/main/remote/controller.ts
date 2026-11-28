import type { Database } from '../database/sqlite';
import type { HandlerMap } from '../api/handlers';
import { HTTP_CHANNELS } from '../api/channels';
import { RemoteServer, BIND_HOST } from './server';
import type { McpHandler } from '../mcp/mcpEndpoint';
import {
  checkRemotePassword,
  getRemoteSettings,
  setRemotePassword,
  setRemoteSettings,
} from './remoteSettings';
import type { RemoteSettingsInput, RemoteState } from '../../shared/types';

export interface RemoteControllerDeps {
  getDb: () => Database;
  handlers: HandlerMap;
  /** The MCP endpoint, mounted at /mcp. */
  mcp?: McpHandler;
  /** The built renderer the phone is served. */
  staticDir: string;
  log?: (message: string) => void;
}

/** Owns the optional HTTP server: starts, stops and restarts it as the Remote access settings change. */
export class RemoteController {
  private server: RemoteServer | null = null;
  private boundPort: number | null = null;
  private lastError: string | null = null;

  constructor(private readonly deps: RemoteControllerDeps) {}

  state(): RemoteState {
    return {
      settings: getRemoteSettings(this.deps.getDb()),
      status: {
        listening: this.server !== null && this.boundPort !== null,
        address: this.server && this.boundPort !== null ? `http://${BIND_HOST}:${this.boundPort}` : null,
        error: this.lastError,
      },
    };
  }

  /** Brings the server in line with the saved settings (off by default). */
  async apply(): Promise<void> {
    await this.stopServer();
    this.lastError = null;
    const settings = getRemoteSettings(this.deps.getDb());
    if (!settings.enabled || !settings.hasPassword) return;

    const server = new RemoteServer({
      port: settings.port,
      staticDir: this.deps.staticDir,
      handlers: this.deps.handlers,
      mcp: this.deps.mcp,
      allowedChannels: HTTP_CHANNELS,
      isPasswordSet: () => getRemoteSettings(this.deps.getDb()).hasPassword,
      checkPassword: (password) => checkRemotePassword(this.deps.getDb(), password),
      getAllowedLogins: () => getRemoteSettings(this.deps.getDb()).allowedLogins,
      onError: (message) => this.deps.log?.(`remote: ${message}`),
    });
    try {
      this.boundPort = await server.start();
      this.server = server;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException)?.code;
      this.lastError =
        code === 'EADDRINUSE'
          ? `Port ${settings.port} is already in use. Choose another port.`
          : err instanceof Error
            ? err.message
            : String(err);
      this.deps.log?.(`remote: could not start: ${this.lastError}`);
    }
  }

  async setSettings(input: RemoteSettingsInput): Promise<RemoteState> {
    const before = getRemoteSettings(this.deps.getDb());
    setRemoteSettings(this.deps.getDb(), input);
    const after = getRemoteSettings(this.deps.getDb());
    // The allowed logins are read on every request; only these need a restart.
    if (before.enabled !== after.enabled || before.port !== after.port || (after.enabled && !this.server)) {
      await this.apply();
    }
    return this.state();
  }

  /** Saves a new password (hashed) and signs every phone out. */
  async setPassword(password: string): Promise<RemoteState> {
    await setRemotePassword(this.deps.getDb(), password);
    this.server?.clearSessions();
    return this.state();
  }

  broadcast(event: unknown): void {
    this.server?.broadcast(event);
  }

  async shutdown(): Promise<void> {
    await this.stopServer();
  }

  private async stopServer(): Promise<void> {
    const server = this.server;
    this.server = null;
    this.boundPort = null;
    await server?.stop();
  }
}
