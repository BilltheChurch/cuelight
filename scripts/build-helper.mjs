#!/usr/bin/env node
/**
 * Builds the macOS helper (apps/helper-mac/main.swift) into apps/helper-mac/build/cuelight-helper:
 * one universal binary for Apple silicon and Intel, macOS 14 or later. Needs the Xcode command
 * line tools. Does nothing on other systems, where the app runs without it.
 */
import { execFileSync } from 'node:child_process'
import { mkdirSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const src = join(root, 'apps/helper-mac/main.swift')
const out = join(root, 'apps/helper-mac/build/cuelight-helper')

if (process.platform !== 'darwin') {
  console.log('helper: macOS only, skipped')
  process.exit(0)
}
const fresh = () => {
  try {
    return statSync(out).mtimeMs > statSync(src).mtimeMs
  } catch {
    return false
  }
}
if (fresh() && !process.argv.includes('--force')) {
  console.log('helper: up to date')
  process.exit(0)
}
mkdirSync(dirname(out), { recursive: true })
// One binary per architecture next to it, then both in one file.
const parts = ['arm64', 'x86_64'].map((arch) => {
  const o = join(dirname(out), arch, 'cuelight-helper')
  mkdirSync(dirname(o), { recursive: true })
  execFileSync('xcrun', ['swiftc', '-O', '-swift-version', '5', '-target', `${arch}-apple-macos14`, src, '-o', o], { stdio: 'inherit' })
  return o
})
execFileSync('lipo', ['-create', ...parts, '-output', out], { stdio: 'inherit' })
console.log(`helper: built ${out.slice(root.length + 1)}`)
