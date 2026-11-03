import { resolve } from 'node:path'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'electron-vite'

// The schema package ships TypeScript source, so it is bundled rather than externalized.
const bundleSchema = { externalizeDeps: { exclude: ['@cuelight/schema'] } }

export default defineConfig({
  main: {
    // Everything else is bundled too, so a packaged app needs no node_modules (scripts/package.mjs).
    // ws only tries these optional native speedups and works without them.
    build: { externalizeDeps: false, rolldownOptions: { external: ['bufferutil', 'utf-8-validate', 'electron'] } },
  },
  preload: {
    build: {
      ...bundleSchema,
      rolldownOptions: {
        input: { control: resolve(import.meta.dirname, 'src/preload/control.ts'), overlay: resolve(import.meta.dirname, 'src/preload/overlay.ts') },
        output: { format: 'cjs', entryFileNames: '[name].cjs' },
      },
    },
  },
  renderer: {
    plugins: [react()],
    build: {
      rolldownOptions: {
        input: { control: resolve(import.meta.dirname, 'src/renderer/control.html'), overlay: resolve(import.meta.dirname, 'src/renderer/overlay.html') },
      },
    },
  },
})
