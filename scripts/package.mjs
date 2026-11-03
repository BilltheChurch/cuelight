#!/usr/bin/env node
/**
 * Packages Cuelight for macOS into dist/:
 *
 *   Cuelight-<version>-<arch>-mac.zip   the app, ad-hoc signed (no Developer ID yet, so macOS blocks
 *                                       the first launch until it is allowed in System Settings,
 *                                       Privacy & Security, Open Anyway)
 *   Cuelight-<version>-<arch>.dmg       only with --dmg; building one mounts a disk image for a moment
 *   cuelight-extension-<version>.zip    the browser extension, as the Chrome Web Store takes it
 *
 * The app is built from this Mac's Electron (no download), for this Mac's architecture. Its main
 * process is one bundle, so the package needs no node_modules: it holds the built app, the macOS
 * helper, the extension and the examples. Signing with a Developer ID and notarizing come once
 * there is an Apple developer account.
 *
 *   pnpm package [--dmg]
 */
import { execFileSync } from 'node:child_process'
import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const root = new URL('..', import.meta.url).pathname
const desktop = join(root, 'apps/desktop')
const dist = join(root, 'dist')
const run = (cmd, args, opts = {}) => execFileSync(cmd, args, { cwd: root, stdio: 'inherit', ...opts })
const pkg = JSON.parse(readFileSync(join(desktop, 'package.json'), 'utf8'))
const require = createRequire(join(desktop, 'package.json'))
const electronVersion = JSON.parse(readFileSync(require.resolve('electron/package.json'), 'utf8')).version
const electronDist = join(require.resolve('electron/package.json'), '..', 'dist')
const arch = process.arch === 'arm64' ? 'arm64' : 'x64'

if (process.platform !== 'darwin') throw new Error('Packaging is macOS only for now')
run(process.execPath, ['scripts/build-helper.mjs'])
run('pnpm', ['--filter', '@cuelight/extension', 'build'])
run('pnpm', ['--filter', '@cuelight/desktop', 'build'])

// The app as electron-builder sees it: the build and a package.json with nothing to install.
const stage = mkdtempSync(join(tmpdir(), 'cuelight-package-'))
cpSync(join(desktop, 'out'), join(stage, 'out'), { recursive: true })
writeFileSync(
  join(stage, 'package.json'),
  JSON.stringify({ name: 'cuelight', productName: pkg.productName, version: pkg.version, description: pkg.description, license: pkg.license, author: 'Tim and Cuelight contributors', type: 'module', main: pkg.main }, null, 2),
)

const config = {
  appId: 'io.github.billthechurch.cuelight',
  productName: pkg.productName,
  copyright: 'MIT License',
  directories: { app: stage, output: dist, buildResources: join(desktop, 'resources') },
  electronVersion,
  electronDist,
  npmRebuild: false,
  asar: true,
  files: ['out/**', 'package.json'],
  extraResources: [
    { from: join(root, 'apps/helper-mac/build/cuelight-helper'), to: 'cuelight-helper' },
    { from: join(root, 'apps/extension/dist'), to: 'extension' },
    { from: join(root, 'examples'), to: 'examples', filter: ['*.json'] },
  ],
  mac: {
    category: 'public.app-category.productivity',
    icon: join(desktop, 'resources/icon.png'),
    target: [{ target: 'zip', arch: [arch] }, ...(process.argv.includes('--dmg') ? [{ target: 'dmg', arch: [arch] }] : [])],
    // Ad-hoc: enough for Apple silicon to run it; Gatekeeper still blocks the first launch.
    identity: '-',
    hardenedRuntime: false,
    notarize: false,
  },
  publish: null,
}
mkdirSync(dist, { recursive: true })
const configFile = join(stage, 'electron-builder.json')
writeFileSync(configFile, JSON.stringify(config, null, 2))
run(join(root, 'node_modules/.bin/electron-builder'), ['--mac', '--config', configFile, '--publish', 'never'], {
  // Never reach for a certificate in the keychain (that can ask for a password).
  env: { ...process.env, CSC_IDENTITY_AUTO_DISCOVERY: 'false' },
})

// The extension for the Chrome Web Store: the built folder, manifest at the top.
const extZip = join(dist, `cuelight-extension-${pkg.version}.zip`)
run('zip', ['-q', '-r', '-X', '-FS', extZip, '.'], { cwd: join(root, 'apps/extension/dist') })
console.log(`package: ${dist}`)
