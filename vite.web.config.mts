import { builtinModules } from 'node:module'
import { resolve } from 'node:path'
import { defineConfig } from 'vite'

/** Builds the development web preview server (src/dev/web-server.ts) for plain Node. */
export default defineConfig({
  resolve: { alias: { '@shared': resolve('src/shared') } },
  build: {
    ssr: 'src/dev/web-server.ts',
    outDir: 'out/web',
    emptyOutDir: true,
    target: 'node22',
    rollupOptions: {
      external: ['better-sqlite3', 'electron', ...builtinModules, ...builtinModules.map((name) => `node:${name}`)],
      output: { format: 'cjs', entryFileNames: 'server.cjs' }
    }
  }
})
