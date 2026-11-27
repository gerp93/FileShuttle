import type { HubToWorker, WorkerToHub } from '../../shared/workerProtocol';
import type { Hub, HubEndpoint, HubOptions } from '../hub/hub';
import { WorkerEndpoint, WorkerRuntime, WorkerRuntimeOptions } from './workerRuntime';

/**
 * The in-process transport: two linked endpoints inside one process. Every message makes a real
 * JSON round trip (so nothing that would not survive a socket gets through) and is delivered on
 * a later microtask, in order, so a handler never runs inside the call that sent the message.
 *
 * A network transport replaces only this file.
 */
function roundTrip<T>(message: T): T {
  return JSON.parse(JSON.stringify(message)) as T;
}

export interface LinkedEndpoints {
  hubSide: HubEndpoint;
  workerSide: WorkerEndpoint;
  /** Stops delivering anything more (used when the app shuts down). */
  close(): void;
}

export function createLinkedEndpoints(): LinkedEndpoints {
  let closed = false;
  let hubHandler: ((message: WorkerToHub) => void) | null = null;
  let workerHandler: ((message: HubToWorker) => void) | null = null;
  const deliver = <T>(handler: () => ((message: T) => void) | null, message: T) => {
    const copy = roundTrip(message);
    queueMicrotask(() => {
      if (closed) return;
      handler()?.(copy);
    });
  };
  return {
    hubSide: {
      send: (message) => deliver(() => workerHandler, message),
      onMessage: (handler) => {
        hubHandler = handler;
      },
    },
    workerSide: {
      send: (message) => deliver(() => hubHandler, message),
      onMessage: (handler) => {
        workerHandler = handler;
      },
    },
    close: () => {
      closed = true;
    },
  };
}

export interface InProcessSystem {
  hub: Hub;
  worker: WorkerRuntime;
  stop(): void;
}

/** Wires a hub to a worker inside this process and introduces them. The worker's first schedule arrives by message. */
export function startInProcessWorker(
  hub: Hub,
  workerOptions: Omit<WorkerRuntimeOptions, 'endpoint'>
): InProcessSystem {
  const link = createLinkedEndpoints();
  hub.attachWorker(workerOptions.workerId, link.hubSide);
  const worker = new WorkerRuntime({ ...workerOptions, endpoint: link.workerSide });
  worker.connect();
  return {
    hub,
    worker,
    stop: () => {
      worker.shutdown();
      link.close();
    },
  };
}

export type { HubOptions };
