/**
 * Which channels exist, and which of them may be called over HTTP.
 *
 * Kept free of any Electron import so tests (and the HTTP server) can use it. Every channel the
 * renderer calls is either in the shared handler table (api/handlers.ts: callable over IPC, and
 * over HTTP only if listed in HTTP_CHANNELS) or in DESKTOP_CHANNELS (IPC only, registered in
 * main.ts because they need a native dialog, the shell, or the app lifecycle).
 */

/** The only channels the phone can call. Anything not listed here answers 404 over HTTP. */
export const HTTP_CHANNELS: readonly string[] = [
  'mappings:list',
  'mappings:get',
  'mappings:create',
  'mappings:update',
  'mappings:delete',
  'mappings:clone',
  'mappings:setEnabled',
  'mappings:getStats',
  'mappings:listJobsUsing',
  'mappings:preview',
  'mappings:previewInput',
  'jobs:list',
  'jobs:get',
  'jobs:create',
  'jobs:update',
  'jobs:delete',
  'jobs:setEnabled',
  'jobs:getStats',
  'jobs:preview',
  'jobs:run',
  'jobs:cancel',
  'jobs:getActive',
  'jobs:runAll',
  'history:list',
  'history:getDetail',
  'history:undo',
  'history:purgeAll',
  'settings:getTheme',
  'settings:setTheme',
  'settings:getLogRetention',
  'settings:setLogRetention',
  'settings:getOverwriteBackup',
  'settings:setOverwriteBackup',
  'settings:getUnzipLimits',
  'settings:setUnzipLimits',
  'dialogs:checkFolder',
  'dialogs:listFolder',
  'workers:list',
  'workers:createPairCode',
  'workers:remove',
  'app:getVersion',
];

/** IPC only. Never reachable over HTTP. */
export const DESKTOP_CHANNELS: readonly string[] = [
  'dialogs:pickFolder',
  'shell:openPath',
  'settings:getStartup',
  'settings:setStartup',
  'dbLocation:get',
  'dbLocation:browseExisting',
  'dbLocation:browseNew',
  'dbLocation:set',
  'dbLocation:resetToDefault',
  'updates:check',
  // Remote access itself is configured on the PC only.
  'remote:getSettings',
  'remote:setSettings',
  'remote:setPassword',
  // MCP access tokens are made on the PC only: a phone session must never be able to mint one.
  'mcp:listTokens',
  'mcp:createToken',
  'mcp:revokeToken',
  // Connecting this computer to a hub (pairing, its allowed folders, sending its jobs) is done on the PC only.
  'hubLink:getState',
  'hubLink:connect',
  'hubLink:disconnect',
  'hubLink:setAllowedFolders',
  'hubLink:suggestFolders',
  'hubLink:sendDefinitions',
  'hubLink:openHub',
];
