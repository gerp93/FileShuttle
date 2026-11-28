import type { RunProgressEvent } from '../shared/types';

type FileShuttleAPI = Window['fileshuttleAPI'];

/** Fired when the server says the session is gone, so the page can show the sign-in form again. */
export const UNAUTHORIZED_EVENT = 'fileshuttle:unauthorized';

export const SIGN_IN_REQUIRED = 'Sign in required.';
const NOT_ON_PHONE = 'Not available from the phone.';
const unavailable = <T>(): Promise<T> => Promise.reject(new Error(NOT_ON_PHONE));

interface RpcReply<T> {
  ok: boolean;
  result?: T;
  error?: string;
}

function post(url: string, body: unknown): Promise<Response> {
  return fetch(url, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json', 'X-FileShuttle': '1' },
    body: JSON.stringify(body),
  });
}

async function rpc<T>(channel: string, ...args: unknown[]): Promise<T> {
  let res: Response;
  try {
    res = await post(`api/rpc/${encodeURIComponent(channel)}`, args);
  } catch {
    throw new Error('Can’t reach FileShuttle on your PC.');
  }
  if (res.status === 401) {
    window.dispatchEvent(new Event(UNAUTHORIZED_EVENT));
    throw new Error(SIGN_IN_REQUIRED);
  }
  const reply = (await res.json().catch(() => null)) as RpcReply<T> | null;
  if (!reply) throw new Error(`Unexpected reply from the PC (${res.status}).`);
  if (!reply.ok) throw new Error(reply.error ?? 'The request failed.');
  return reply.result as T;
}

/** Signs in with the password set on the PC. Resolves with an error message, or null on success. */
export async function webLogin(password: string): Promise<string | null> {
  let res: Response;
  try {
    res = await post('api/login', { password });
  } catch {
    return 'Can’t reach FileShuttle on your PC.';
  }
  if (res.ok) return null;
  const reply = (await res.json().catch(() => null)) as RpcReply<never> | null;
  return reply?.error ?? `Sign-in failed (${res.status}).`;
}

export async function webLogout(): Promise<void> {
  try {
    await post('api/logout', []);
  } catch {
    /* the cookie is dropped on the next 401 anyway */
  }
}

// One shared event stream for the whole page, opened while something is listening.
const progressListeners = new Set<(event: RunProgressEvent) => void>();
let source: EventSource | null = null;
let retry: ReturnType<typeof setTimeout> | null = null;

function openStream(): void {
  if (source || progressListeners.size === 0) return;
  const es = new EventSource('api/events');
  source = es;
  es.addEventListener('progress', (e) => {
    try {
      const event = JSON.parse((e as MessageEvent<string>).data) as RunProgressEvent;
      for (const listener of [...progressListeners]) listener(event);
    } catch {
      /* ignore a malformed event */
    }
  });
  es.onerror = () => {
    // EventSource retries dropped connections itself; a closed one (e.g. a 401) is retried here.
    if (es.readyState === EventSource.CLOSED) {
      source = null;
      if (!retry && progressListeners.size > 0) {
        retry = setTimeout(() => {
          retry = null;
          openStream();
        }, 3000);
      }
    }
  };
}

function closeStreamIfIdle(): void {
  if (progressListeners.size > 0) return;
  source?.close();
  source = null;
  if (retry) clearTimeout(retry);
  retry = null;
}

/** The same API the desktop preload exposes, over fetch and Server-Sent Events. */
export function createWebApi(): FileShuttleAPI {
  return {
    mappings: {
      list: () => rpc('mappings:list'),
      get: (id) => rpc('mappings:get', id),
      create: (input) => rpc('mappings:create', input),
      update: (id, input) => rpc('mappings:update', id, input),
      delete: (id) => rpc('mappings:delete', id),
      clone: (id, name) => rpc('mappings:clone', id, name),
      setEnabled: (id, enabled) => rpc('mappings:setEnabled', id, enabled),
      getStats: (id) => rpc('mappings:getStats', id),
      listJobsUsing: (id) => rpc('mappings:listJobsUsing', id),
      preview: (id) => rpc('mappings:preview', id),
      previewInput: (input) => rpc('mappings:previewInput', input),
    },
    jobs: {
      list: () => rpc('jobs:list'),
      get: (id) => rpc('jobs:get', id),
      create: (input) => rpc('jobs:create', input),
      update: (id, input) => rpc('jobs:update', id, input),
      delete: (id) => rpc('jobs:delete', id),
      setEnabled: (id, enabled) => rpc('jobs:setEnabled', id, enabled),
      getStats: (id) => rpc('jobs:getStats', id),
      preview: (id) => rpc('jobs:preview', id),
      run: (id) => rpc('jobs:run', id),
      cancel: (id) => rpc('jobs:cancel', id),
      getActive: () => rpc('jobs:getActive'),
      onProgress: (callback) => {
        progressListeners.add(callback);
        openStream();
        return () => {
          progressListeners.delete(callback);
          closeStreamIfIdle();
        };
      },
      runAll: () => rpc('jobs:runAll'),
    },
    history: {
      list: (filter) => rpc('history:list', filter),
      getDetail: (runId) => rpc('history:getDetail', runId),
      undo: (runId) => rpc('history:undo', runId),
      purgeAll: () => rpc('history:purgeAll'),
    },
    settings: {
      getTheme: () => rpc('settings:getTheme'),
      setTheme: (themeId) => rpc('settings:setTheme', themeId),
      getStartup: () => Promise.resolve({ supported: false, enabled: false }),
      setStartup: () => unavailable(),
      getLogRetention: () => rpc('settings:getLogRetention'),
      setLogRetention: (id) => rpc('settings:setLogRetention', id),
      getOverwriteBackup: () => rpc('settings:getOverwriteBackup'),
      setOverwriteBackup: (enabled) => rpc('settings:setOverwriteBackup', enabled),
      getUnzipLimits: () => rpc('settings:getUnzipLimits'),
      setUnzipLimits: (limits) => rpc('settings:setUnzipLimits', limits),
    },
    dialogs: {
      pickFolder: () => unavailable(), // the page uses its own folder browser (listFolder)
      checkFolder: (folder, role, workerId) => rpc('dialogs:checkFolder', folder, role, workerId ?? null),
      listFolder: (folder, workerId) => rpc('dialogs:listFolder', folder ?? null, workerId ?? null),
    },
    shell: {
      openPath: () => unavailable(),
    },
    dbLocation: {
      get: () => unavailable(),
      browseExisting: () => unavailable(),
      browseNew: () => unavailable(),
      set: () => unavailable(),
      resetToDefault: () => unavailable(),
    },
    app: {
      getVersion: () => rpc('app:getVersion'),
    },
    remote: {
      getSettings: () => unavailable(),
      setSettings: () => unavailable(),
      setPassword: () => unavailable(),
    },
    workers: {
      list: () => rpc('workers:list'),
      createPairCode: () => rpc('workers:createPairCode'),
      remove: (workerId) => rpc('workers:remove', workerId),
    },
    mcp: {
      listTokens: () => unavailable(),
      createToken: () => unavailable(),
      revokeToken: () => unavailable(),
    },
    hubLink: {
      getState: () => unavailable(),
      connect: () => unavailable(),
      disconnect: () => unavailable(),
      setAllowedFolders: () => unavailable(),
      suggestFolders: () => unavailable(),
      sendDefinitions: () => unavailable(),
      openHub: () => unavailable(),
    },
    updates: {
      check: () => unavailable(),
    },
  };
}
