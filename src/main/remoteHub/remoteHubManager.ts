import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { RemoteHubEnableInput, RemoteHubSetupReport, RemoteHubState } from '../../shared/types';
import type { SetupPayload } from '../hub/importSetup';
import { cleanFolderInput } from '../../shared/pathSafety';
import { PairResult, WebSocketFactory, pairWithHub, validateHubUrl } from '../worker/hubClient';
import { RunningRemoteWorker, RemoteWorkerOptions, startRemoteWorker } from '../worker/remoteWorker';
import { createTokenStore, TokenStore } from '../worker/tokenStore';

/**
 * The desktop app's "Use a remote hub" mode, without any Electron in it (so it can be tested).
 *
 * Everything this mode needs lives in its own folder (`remote-hub/` in the app's data folder):
 * a small settings file, the machine's token (DPAPI on Windows, a 0600 file elsewhere, the same
 * store the server worker uses), and the worker's copy of the schedule and its outbox. The local
 * database is never read except to build the one-time "send my setup" payload, and never written.
 *
 * Turning the mode on pairs with the hub first; only when that worked does it suspend this
 * computer's own hub and start a worker that connects to the remote one. Turning it off stops
 * the worker, deletes the token and the worker's state, revokes nothing on the hub, and resumes
 * the local hub.
 */

const SETTINGS_FILE = 'remote-hub.json';

interface StoredSettings {
  enabled: boolean;
  hubUrl: string;
  name: string;
  allowedFolders: string[];
  workerId: string | null;
  setupOffered: boolean;
}

/** What the desktop does with its own hub while the remote one is in charge. */
export interface LocalHubSwitch {
  /** Stops the scheduler and watchers, the phone server, MCP and retention. Must be safe to call twice. */
  suspend(): Promise<void>;
  /** Brings them back exactly as the settings say. */
  resume(): Promise<void>;
}

export interface RemoteHubDeps {
  dir: string;
  appVersion: string;
  localHub: LocalHubSwitch;
  /** This computer's jobs and mappings (reads the local database). */
  buildSetup: () => SetupPayload;
  log?: (message: string) => void;
  onBackgroundRunFinished?: RemoteWorkerOptions['onBackgroundRunFinished'];
  tokenStore?: TokenStore;
  fetchImpl?: typeof fetch;
  factory?: WebSocketFactory;
  backoffStartMs?: number;
  backoffMaxMs?: number;
  heartbeat?: boolean;
  platform?: string;
  hostName?: () => string;
}

export class RemoteHubError extends Error {}

export class RemoteHubManager {
  private worker: RunningRemoteWorker | null = null;
  private readonly tokens: TokenStore;
  private readonly log: (message: string) => void;

  constructor(private readonly deps: RemoteHubDeps) {
    this.tokens = deps.tokenStore ?? createTokenStore(deps.dir);
    this.log = deps.log ?? (() => undefined);
  }

  // ------------------------------------------------------------ settings file

  private read(): StoredSettings {
    const blank: StoredSettings = { enabled: false, hubUrl: '', name: '', allowedFolders: [], workerId: null, setupOffered: false };
    let parsed: unknown;
    try {
      parsed = JSON.parse(fs.readFileSync(path.join(this.deps.dir, SETTINGS_FILE), 'utf8'));
    } catch {
      return blank;
    }
    if (typeof parsed !== 'object' || parsed === null) return blank;
    const o = parsed as Record<string, unknown>;
    return {
      enabled: o.enabled === true,
      hubUrl: typeof o.hubUrl === 'string' ? o.hubUrl : '',
      name: typeof o.name === 'string' ? o.name : '',
      allowedFolders: Array.isArray(o.allowedFolders) ? o.allowedFolders.filter((f): f is string => typeof f === 'string') : [],
      workerId: typeof o.workerId === 'string' ? o.workerId : null,
      setupOffered: o.setupOffered === true,
    };
  }

  private write(settings: StoredSettings): void {
    fs.mkdirSync(this.deps.dir, { recursive: true, mode: 0o700 });
    const file = path.join(this.deps.dir, SETTINGS_FILE);
    const temp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(temp, `${JSON.stringify(settings, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(temp, file);
  }

  // ------------------------------------------------------------ state

  /** True when the app should start in remote mode (read once at launch, before anything local starts). */
  isEnabled(): boolean {
    return this.read().enabled;
  }

  /** The address of the hub the window should show, or null when the mode is off. */
  hubOrigin(): string | null {
    const s = this.read();
    if (!s.enabled || !s.hubUrl) return null;
    try {
      return validateHubUrl(s.hubUrl);
    } catch {
      return null;
    }
  }

  state(): RemoteHubState {
    const s = this.read();
    const connected = this.worker?.transport.connected ?? false;
    let problem: string | null = null;
    if (s.enabled && !connected) {
      problem = this.worker ? 'This computer is not connected to the hub right now. It keeps trying.' : 'This computer is not connected to the hub.';
    }
    return {
      enabled: s.enabled,
      hubUrl: s.hubUrl,
      name: s.name,
      allowedFolders: s.allowedFolders,
      connected,
      problem,
      setupOffered: s.setupOffered,
    };
  }

  // ------------------------------------------------------------ turning it on and off

  async enable(input: RemoteHubEnableInput): Promise<RemoteHubState> {
    const current = this.read();
    if (current.enabled) throw new RemoteHubError('This computer already uses a remote hub. Turn that off first.');
    const hubUrl = validateHubUrl(input.hubUrl); // the same check `worker pair` makes
    const code = input.code.trim();
    if (!code) throw new RemoteHubError('A pairing code is required. Make one on the hub in Settings, under Machines.');
    const name = input.name.trim() || (this.deps.hostName ?? os.hostname)();
    const allowedFolders = cleanFolders(input.allowedFolders);

    // Pair first: if the hub refuses, nothing here has changed.
    let paired: PairResult;
    try {
      paired = await pairWithHub({ hubUrl, code, name, platform: this.deps.platform ?? process.platform, fetchImpl: this.deps.fetchImpl });
    } catch (err) {
      throw new RemoteHubError(err instanceof Error ? err.message : 'Pairing failed.');
    }
    await this.tokens.save(paired.token);
    this.write({ enabled: true, hubUrl, name: paired.name || name, allowedFolders, workerId: paired.workerId, setupOffered: false });

    await this.deps.localHub.suspend();
    await this.startWorker();
    return this.state();
  }

  /** At launch in remote mode: the local hub was never started; start the worker for the remote one. */
  async resumeAtLaunch(): Promise<void> {
    if (!this.isEnabled()) return;
    await this.startWorker();
  }

  async disable(): Promise<RemoteHubState> {
    const s = this.read();
    this.stopWorker();
    // Revokes nothing on the hub: the machine stays listed there until its owner removes it.
    await this.tokens.clear();
    for (const entry of ['outbox', 'schedule.json']) fs.rmSync(path.join(this.deps.dir, entry), { recursive: true, force: true });
    this.write({ ...s, enabled: false, workerId: null });
    await this.deps.localHub.resume();
    return this.state();
  }

  async setAllowedFolders(folders: string[]): Promise<RemoteHubState> {
    const s = this.read();
    this.write({ ...s, allowedFolders: cleanFolders(folders) });
    if (s.enabled && this.worker) {
      // The worker reads its folder list once when it starts.
      this.stopWorker();
      await this.startWorker();
    }
    return this.state();
  }

  /** Records that the person has dealt with the one-time offer (sent it, or said no). */
  markSetupOffered(): void {
    this.write({ ...this.read(), setupOffered: true });
  }

  shutdown(): void {
    this.stopWorker();
  }

  // ------------------------------------------------------------ the worker

  private async startWorker(): Promise<void> {
    const s = this.read();
    if (!s.enabled || !s.workerId) throw new RemoteHubError('This computer is not paired with a hub.');
    const token = await this.tokens.load();
    if (!token) throw new RemoteHubError('The saved token for this hub is missing. Turn the setting off and pair again.');
    this.stopWorker();
    fs.mkdirSync(this.deps.dir, { recursive: true, mode: 0o700 });
    this.worker = startRemoteWorker({
      hubUrl: s.hubUrl,
      workerId: s.workerId,
      token,
      dataDir: this.deps.dir,
      allowedFolders: s.allowedFolders,
      appVersion: this.deps.appVersion,
      platform: this.deps.platform,
      log: (message) => this.log(`remote hub: ${message}`),
      onBackgroundRunFinished: this.deps.onBackgroundRunFinished,
      factory: this.deps.factory,
      backoffStartMs: this.deps.backoffStartMs,
      backoffMaxMs: this.deps.backoffMaxMs,
      heartbeat: this.deps.heartbeat,
    });
  }

  private stopWorker(): void {
    this.worker?.stop();
    this.worker = null;
  }

  /** The running worker, for tests and status. */
  get running(): RunningRemoteWorker | null {
    return this.worker;
  }

  // ------------------------------------------------------------ sending the setup

  /** Sends this computer's jobs and mappings (never history) once. The local database is only read. */
  async sendSetup(): Promise<RemoteHubSetupReport> {
    const s = this.read();
    if (!s.enabled || !s.workerId) throw new RemoteHubError('Turn on "Use a remote hub" first.');
    const token = await this.tokens.load();
    if (!token) throw new RemoteHubError('The saved token for this hub is missing. Turn the setting off and pair again.');
    const origin = validateHubUrl(s.hubUrl);
    const doFetch = this.deps.fetchImpl ?? fetch;
    let response: Response;
    try {
      response = await doFetch(`${origin}/api/workers/import-setup`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify({ workerId: s.workerId, setup: this.deps.buildSetup() }),
        redirect: 'error',
        signal: AbortSignal.timeout(60_000),
      });
    } catch {
      throw new RemoteHubError(`Could not reach the hub at ${origin}.`);
    }
    let body = null as (RemoteHubSetupReport & { ok?: boolean; error?: string }) | null;
    try {
      body = (await response.json()) as typeof body;
    } catch {
      // Not JSON: handled below.
    }
    if (!response.ok || !body?.ok) {
      throw new RemoteHubError(body?.error || `The hub did not take the setup (HTTP ${response.status}).`);
    }
    this.markSetupOffered();
    return {
      mappingsSent: body.mappingsSent,
      mappingsSkipped: body.mappingsSkipped,
      jobsSent: body.jobsSent,
      jobsSkipped: body.jobsSkipped,
    };
  }

  /** True when the hub answers at all (any HTTP answer counts). Used before loading its page. */
  async hubReachable(timeoutMs = 6000): Promise<boolean> {
    const origin = this.hubOrigin();
    if (!origin) return false;
    try {
      await (this.deps.fetchImpl ?? fetch)(`${origin}/`, { method: 'GET', redirect: 'manual', signal: AbortSignal.timeout(timeoutMs) });
      return true;
    } catch {
      return false;
    }
  }
}

function cleanFolders(folders: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of folders) {
    const folder = cleanFolderInput(String(raw ?? ''));
    if (!folder || (!path.isAbsolute(folder) && !path.win32.isAbsolute(folder))) continue;
    if (seen.has(folder)) continue;
    seen.add(folder);
    out.push(folder);
  }
  return out;
}
