import * as fs from 'fs';
import * as path from 'path';
import type { JobRecord, MappingRecord, RunResult } from '../../shared/types';
import type { HubLinkState } from '../../shared/types';
import { AllowedFolders } from './allowedFolders';
import { HubUrlError, PairResult, RemoteTransport, WebSocketFactory, pairWithHub, validateHubUrl } from './hubClient';
import { Outbox } from './outbox';
import { createTokenStore, TokenStore } from './tokenStore';
import {
  clearPairing,
  createScheduleStore,
  loadWorkerConfig,
  saveAllowedFolders,
  savePairing,
  WorkerConfig,
} from './workerConfig';
import { WorkerRuntime } from './workerRuntime';
import type { RunSettings } from '../settings/appSettings';

/**
 * The desktop app's link to a hub on another computer ("connect to a hub"). With a link, the app does not
 * run its own jobs: this computer becomes a worker for the hub (the same WorkerRuntime the headless
 * `fileshuttle-server worker` runs, with the same outbox, schedule copy and allowed folders), and the
 * mappings and jobs in the app's own database are left exactly as they were, paused. Without a link
 * nothing here runs and the app works on its own, as before.
 *
 * Everything the link keeps is in one folder (`dataDir`): worker.json (hub address, machine id, allowed
 * folders), the token (encrypted for this Windows user by DPAPI, or a 0600 file elsewhere), the hub's last
 * schedule and the outbox. No Electron import, so it is tested without the app.
 */

export interface HubLinkOptions {
  dataDir: string;
  appVersion: string;
  /** Same settings the in-app worker reads (overwrite backup, unzip limits). */
  readRunSettings: () => RunSettings;
  onBackgroundRunFinished?: (kind: 'scheduled' | 'watched folder', jobId: number, result: RunResult) => void;
  log?: (message: string) => void;
  /** For tests. */
  tokenStore?: TokenStore;
  factory?: WebSocketFactory;
  fetchImpl?: typeof fetch;
  backoffStartMs?: number;
  backoffMaxMs?: number;
  heartbeat?: boolean;
  platform?: string;
}

/** The mappings and jobs of this computer, as the hub's import expects them. */
export interface LocalDefinitions {
  mappings: MappingRecord[];
  jobs: JobRecord[];
}

export class HubLinkError extends Error {}

export class HubLink {
  private runtime: WorkerRuntime | null = null;
  private transport: RemoteTransport | null = null;
  private outbox: Outbox | null = null;
  private lastProblem: string | null = null;
  private readonly tokens: TokenStore;
  private readonly log: (message: string) => void;

  constructor(private readonly opts: HubLinkOptions) {
    this.tokens = opts.tokenStore ?? createTokenStore(opts.dataDir);
    this.log = opts.log ?? (() => undefined);
  }

  private config(): WorkerConfig {
    // Only the data folder comes from the caller: the headless worker's environment variables mean nothing here.
    return loadWorkerConfig({ FILESHUTTLE_WORKER_DATA_DIR: this.opts.dataDir });
  }

  /** True once this computer has been paired with a hub (and not disconnected since). */
  isPaired(): boolean {
    const config = this.config();
    return !!config.hubUrl && !!config.workerId;
  }

  /** True while the worker for the hub is running in this process. */
  isRunning(): boolean {
    return this.runtime !== null;
  }

  state(): HubLinkState {
    const config = this.config();
    const paired = !!config.hubUrl && !!config.workerId;
    return {
      paired,
      hubUrl: paired ? config.hubUrl : null,
      name: paired ? config.name : null,
      workerId: paired ? config.workerId : null,
      online: this.transport?.connected ?? false,
      queuedReports: this.outbox?.size ?? (paired ? new Outbox(path.join(this.opts.dataDir, 'outbox')).size : 0),
      allowedFolders: config.allowedFolders,
      problem: this.lastProblem,
    };
  }

  /** Starts the worker if this computer is paired. Resolves false when there is nothing to start (or no token to start with). */
  async start(): Promise<boolean> {
    if (this.runtime) return true;
    const config = this.config();
    if (!config.hubUrl || !config.workerId) return false;
    const token = await this.tokens.load();
    if (!token) {
      this.lastProblem = 'The saved token for this hub could not be found. Disconnect and pair again.';
      return false;
    }
    let hubUrl: string;
    try {
      hubUrl = validateHubUrl(config.hubUrl);
    } catch (err) {
      this.lastProblem = err instanceof HubUrlError ? err.message : String(err);
      return false;
    }
    this.lastProblem = null;

    const allowed = new AllowedFolders(config.allowedFolders);
    if (allowed.isEmpty) {
      this.lastProblem = 'No folders are allowed on this computer yet, so it refuses every folder. Allow the folders your jobs use.';
    }
    const outbox = new Outbox(path.join(config.dataDir, 'outbox'));
    const transport = new RemoteTransport({
      hubUrl,
      log: (message) => {
        this.log(`hub: ${message}`);
      },
      factory: this.opts.factory,
      backoffStartMs: this.opts.backoffStartMs,
      backoffMaxMs: this.opts.backoffMaxMs,
      onOpen: () => runtime.connect(),
    });
    const runtime = new WorkerRuntime({
      workerId: config.workerId,
      appVersion: this.opts.appVersion,
      token,
      platform: this.opts.platform ?? process.platform,
      endpoint: transport,
      readRunSettings: this.opts.readRunSettings,
      allowedFolders: allowed,
      outbox,
      scheduleStore: createScheduleStore(config.dataDir),
      heartbeat: this.opts.heartbeat ?? true,
      onBackgroundRunFinished: this.opts.onBackgroundRunFinished,
    });
    runtime.loadStoredSchedule();
    transport.start();
    this.runtime = runtime;
    this.transport = transport;
    this.outbox = outbox;
    return true;
  }

  /** Stops the worker (the pairing stays: `start()` brings it back). */
  stop(): void {
    this.transport?.stop();
    this.runtime?.shutdown();
    this.transport = null;
    this.runtime = null;
    this.outbox = null;
  }

  /** Timers are unreliable across sleep. */
  resumeFromSleep(): void {
    this.runtime?.resumeFromSleep();
  }

  /** Trades a one-time code for this computer's place on the hub, saves it and starts working for it. */
  async connect(input: { hubUrl: string; code: string; name?: string }): Promise<HubLinkState> {
    if (this.isPaired()) throw new HubLinkError('This computer is already connected to a hub. Disconnect first.');
    const config = this.config();
    const hubUrl = validateHubUrl(input.hubUrl);
    const code = input.code.trim();
    if (!code) throw new HubLinkError('Enter the pairing code from the hub.');
    const result: PairResult = await pairWithHub({
      hubUrl,
      code,
      name: input.name?.trim() || config.name,
      platform: this.opts.platform ?? process.platform,
      fetchImpl: this.opts.fetchImpl,
    });
    await this.tokens.save(result.token);
    savePairing(config.dataDir, { hubUrl, workerId: result.workerId, name: result.name });
    await this.start();
    return this.state();
  }

  /**
   * Leaves the hub: stops, forgets the token, the schedule and anything still waiting to be reported. The machine
   * stays on the hub (remove it there); this app goes back to running its own jobs.
   */
  async disconnect(): Promise<void> {
    this.stop();
    await this.tokens.clear();
    clearPairing(this.opts.dataDir);
    for (const entry of ['schedule.json', 'outbox']) {
      fs.rmSync(path.join(this.opts.dataDir, entry), { recursive: true, force: true });
    }
    this.lastProblem = null;
  }

  /** Saves the folders this computer allows and restarts the worker so they apply at once. */
  async setAllowedFolders(folders: readonly string[]): Promise<HubLinkState> {
    const clean = [...new Set(folders.map((f) => f.trim()).filter((f) => f.length > 0))];
    for (const folder of clean) {
      if (!path.isAbsolute(folder) && !path.win32.isAbsolute(folder)) {
        throw new HubLinkError(`"${folder}" is not a full folder path.`);
      }
    }
    saveAllowedFolders(this.opts.dataDir, clean);
    if (this.runtime) {
      this.stop();
      await this.start();
    }
    return this.state();
  }

  /**
   * Sends this computer's own mappings and jobs to the hub, to be created there on this machine's account.
   * The hub refuses when the machine already has some, and nothing is created unless everything is accepted.
   */
  async sendDefinitions(
    definitions: LocalDefinitions,
    options: { switchOff?: boolean } = {}
  ): Promise<{ mappings: number; jobs: number }> {
    const config = this.config();
    if (!config.hubUrl || !config.workerId) throw new HubLinkError('This computer is not connected to a hub.');
    const token = await this.tokens.load();
    if (!token) throw new HubLinkError('The saved token for this hub could not be found. Disconnect and pair again.');
    const origin = validateHubUrl(config.hubUrl);
    let response: Response;
    try {
      response = await (this.opts.fetchImpl ?? fetch)(`${origin}/api/workers/import`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${token}`,
          'x-worker-id': config.workerId,
        },
        body: JSON.stringify({ ...definitions, switchOff: options.switchOff === true }),
        redirect: 'error',
        signal: AbortSignal.timeout(120_000),
      });
    } catch {
      throw new HubLinkError(`Could not reach the hub at ${origin}.`);
    }
    let body: { ok?: boolean; error?: string; mappings?: number; jobs?: number } = {};
    try {
      body = (await response.json()) as typeof body;
    } catch {
      // Not JSON: handled below.
    }
    if (!response.ok || !body.ok) throw new HubLinkError(body.error || `The hub refused the import (HTTP ${response.status}).`);
    return { mappings: body.mappings ?? 0, jobs: body.jobs ?? 0 };
  }
}
