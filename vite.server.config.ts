import { defineConfig } from 'vite';
import path from 'path';

// `npm run build:server`: the hub and worker as ONE CommonJS file, dist/server/fileshuttle-server.cjs, with every
// npm dependency inlined (Node built-ins such as node:sqlite stay external; no native addons). It is the input of
// KVG_Standards' release-node-deb.yml, which wraps it in a single-executable program. APP_VERSION (set by that
// workflow) is baked in; "0.0.0-dev" otherwise. Nothing in this build may import Electron (serverBundle.test.ts).
export const SERVER_ENTRY = 'src/server/entry.ts';

export function serverBuildConfig(outDir = 'dist/server', version = process.env.APP_VERSION || '0.0.0-dev') {
  return {
    configFile: false as const,
    root: __dirname,
    publicDir: false as const,
    logLevel: 'warn' as const,
    define: { 'process.env.APP_VERSION': JSON.stringify(version) },
    resolve: { alias: { '@shared': path.resolve(__dirname, './src/shared') } },
    ssr: { noExternal: true as const, target: 'node' as const },
    build: {
      ssr: SERVER_ENTRY,
      outDir,
      emptyOutDir: true,
      target: 'node22',
      minify: false,
      sourcemap: false,
      rollupOptions: {
        output: {
          format: 'cjs' as const,
          entryFileNames: 'fileshuttle-server.cjs',
          inlineDynamicImports: true,
        },
      },
    },
  };
}

export default defineConfig(serverBuildConfig());
