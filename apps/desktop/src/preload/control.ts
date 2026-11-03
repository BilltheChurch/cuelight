import { contextBridge, ipcRenderer } from 'electron'
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
  play: (from) => ipcRenderer.invoke('player:play', from),
  stop: () => ipcRenderer.invoke('player:stop'),
  runSelftest: () => ipcRenderer.invoke('selftest:run'),
  setLang: (l) => ipcRenderer.invoke('settings:lang', l),
  newCode: () => ipcRenderer.invoke('bridge:code'),
  forgetBrowser: (id) => ipcRenderer.invoke('bridge:forget', id),
  revealExtension: () => ipcRenderer.invoke('extension:reveal'),
}

contextBridge.exposeInMainWorld('cuelight', api)
