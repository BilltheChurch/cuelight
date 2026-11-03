import { contextBridge, ipcRenderer } from 'electron'
import type { OverlayApi, OverlayView } from '../shared/types.ts'

const api: OverlayApi = {
  onView: (cb) => void ipcRenderer.on('overlay:view', (_e, v: OverlayView) => cb(v)),
  onCursor: (cb) => void ipcRenderer.on('overlay:cursor', (_e, p: { x: number; y: number } | null) => cb(p)),
  ready: () => ipcRenderer.send('overlay:ready'),
}

contextBridge.exposeInMainWorld('overlay', api)
