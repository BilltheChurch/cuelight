/** Small JSON settings file in the app's user-data folder. Written atomically. */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { Lang } from '@cuelight/schema'
import type { SelftestResult } from '../shared/types.ts'
import type { PairedBrowser } from './bridge.ts'

export type Settings = {
  lang: 'auto' | Lang
  browsers: PairedBrowser[]
  recent: string[]
  selftest: SelftestResult | null
}

const DEFAULTS: Settings = { lang: 'auto', browsers: [], recent: [], selftest: null }

export class SettingsFile {
  data: Settings
  constructor(private file: string) {
    try {
      this.data = { ...DEFAULTS, ...(JSON.parse(readFileSync(file, 'utf8')) as Partial<Settings>) }
    } catch {
      this.data = { ...DEFAULTS }
    }
  }

  static in(dir: string) {
    return new SettingsFile(join(dir, 'settings.json'))
  }

  update(patch: Partial<Settings>) {
    this.data = { ...this.data, ...patch }
    mkdirSync(dirname(this.file), { recursive: true })
    const tmp = this.file + '.tmp'
    writeFileSync(tmp, JSON.stringify(this.data, null, 2))
    renameSync(tmp, this.file)
  }
}
