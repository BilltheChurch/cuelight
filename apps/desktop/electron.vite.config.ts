import { resolve } from 'node:path'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'electron-vite'

// The schema package ships TypeScript source, so it is bundled rather than externalized.
const bundleSchema = { externalizeDeps: { exclude: ['@cuelight/schema'] } }

export default defineConfig({
  main: {
    build: { ...bundleSchema },
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
