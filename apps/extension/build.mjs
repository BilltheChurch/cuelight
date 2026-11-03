// Bundles the extension into dist/ (load it as an unpacked extension from there).
import { cpSync, mkdirSync, rmSync } from 'node:fs'
import * as esbuild from 'esbuild'

const watch = process.argv.includes('--watch')
rmSync('dist', { recursive: true, force: true })
mkdirSync('dist')
cpSync('public', 'dist', { recursive: true })

const common = { bundle: true, target: 'chrome120', logLevel: 'info', legalComments: 'none' }
const builds = [
  { ...common, entryPoints: ['src/background.ts'], outfile: 'dist/background.js', format: 'esm' },
  // Content scripts cannot be ES modules.
  { ...common, entryPoints: ['src/content.ts'], outfile: 'dist/content.js', format: 'iife' },
  { ...common, entryPoints: ['src/popup.ts'], outfile: 'dist/popup.js', format: 'iife' },
]

if (watch) {
  for (const b of builds) await (await esbuild.context(b)).watch()
} else {
  await Promise.all(builds.map((b) => esbuild.build(b)))
}
