import type { Database } from '../database/sqlite';
import { getLocalWorkerId } from '../database/workers';
import { Hub } from '../hub/hub';
import { runSettings } from '../settings/appSettings';
import { InProcessSystem, startInProcessWorker } from './inProcess';
import type { WorkerRuntimeOptions } from './workerRuntime';

/** Lets every message already in flight between the hub and the worker be delivered. */
export const flushMessages = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

export interface TestSystem extends InProcessSystem {
  workerId: string;
  flush: () => Promise<void>;
}

/** A hub and the `local` worker over `db`, linked in-process, already introduced to each other. */
export async function startTestSystem(
  db: Database,
  options: Partial<Omit<WorkerRuntimeOptions, 'endpoint'>> = {}
): Promise<TestSystem> {
  const hub = new Hub({ getDb: () => db });
  const workerId = getLocalWorkerId(db);
  const system = startInProcessWorker(hub, {
    workerId,
    appVersion: '0.0.0-test',
    readRunSettings: () => runSettings.read(db),
    ...options,
  });
  await flushMessages();
  return { ...system, workerId, flush: flushMessages };
}
