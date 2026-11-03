import { contextBridge, ipcRenderer } from 'electron'
import type { Picked } from '@cuelight/schema'
import type { AppState, ControlApi } from '../shared/types.ts'

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
  pick: (on) => ipcRenderer.invoke('pick', on),
  record: (on, typed) => ipcRenderer.invoke('record', on, !!typed),
  onPick: (cb) => {
    const h = (_e: unknown, p: Picked | null) => cb(p)
    ipcRenderer.on('pick:result', h)
    return () => ipcRenderer.off('pick:result', h)
  },
  runSelftest: () => ipcRenderer.invoke('selftest:run'),
  setLang: (l) => ipcRenderer.invoke('settings:lang', l),
  newCode: () => ipcRenderer.invoke('bridge:code'),
  forgetBrowser: (id) => ipcRenderer.invoke('bridge:forget', id),
  revealExtension: () => ipcRenderer.invoke('extension:reveal'),
}

contextBridge.exposeInMainWorld('cuelight', api)
