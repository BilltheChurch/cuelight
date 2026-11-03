import { contextBridge, ipcRenderer } from 'electron'
import type { AppState, ControlApi, PickResult } from '../shared/types.ts'

const api: ControlApi = {
  getState: () => ipcRenderer.invoke('app:state'),
  onState: (cb) => {
    const h = (_e: unknown, s: AppState) => cb(s)
    ipcRenderer.on('app:state', h)
    return () => ipcRenderer.off('app:state', h)
  },
  openDialog: () => ipcRenderer.invoke('storyboard:dialog'),
  openExample: (id) => ipcRenderer.invoke('storyboard:example', id),
  openPath: (p) => ipcRenderer.invoke('storyboard:path', p),
  newDoc: (json) => ipcRenderer.invoke('storyboard:new', json),
  closeDoc: () => ipcRenderer.invoke('storyboard:close'),
  getDoc: () => ipcRenderer.invoke('storyboard:doc'),
  setDraft: (json) => ipcRenderer.invoke('storyboard:draft', json),
  save: (json, saveAs) => ipcRenderer.invoke('storyboard:save', json, saveAs),
  play: (from) => ipcRenderer.invoke('player:play', from),
  rehearse: (i) => ipcRenderer.invoke('player:rehearse', i),
  stop: () => ipcRenderer.invoke('player:stop'),
  pick: (on, where) => ipcRenderer.invoke('pick', on, where ?? 'web'),
  nativeAsk: (what) => ipcRenderer.invoke('native:ask', what),
  record: (on, typed) => ipcRenderer.invoke('record', on, !!typed),
  onPick: (cb) => {
    const h = (_e: unknown, p: PickResult | null) => cb(p)
    ipcRenderer.on('pick:result', h)
    return () => ipcRenderer.off('pick:result', h)
  },
  runSelftest: () => ipcRenderer.invoke('selftest:run'),
  setLang: (l) => ipcRenderer.invoke('settings:lang', l),
  newCode: () => ipcRenderer.invoke('bridge:code'),
  forgetBrowser: (id) => ipcRenderer.invoke('bridge:forget', id),
  revealExtension: () => ipcRenderer.invoke('extension:reveal'),
  aiSetup: (s) => ipcRenderer.invoke('ai:setup', s),
  aiTest: (s) => ipcRenderer.invoke('ai:test', s),
  aiRun: (req) => ipcRenderer.invoke('ai:run', req),
  aiCancel: () => ipcRenderer.invoke('ai:cancel'),
  onAiProgress: (cb) => {
    const h = (_e: unknown, chars: number) => cb(chars)
    ipcRenderer.on('ai:progress', h)
    return () => ipcRenderer.off('ai:progress', h)
  },
}

contextBridge.exposeInMainWorld('cuelight', api)
