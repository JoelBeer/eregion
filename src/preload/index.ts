import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import { API_METHODS, type EregionBridge, type EregionEvent } from '@shared/api'

const bridge = Object.fromEntries(API_METHODS.map((method) => [method, (...args: unknown[]) => ipcRenderer.invoke('api', method, args)])) as Record<
  string,
  unknown
>

bridge.onEvent = (listener: (event: EregionEvent) => void) => {
  const handler = (_event: IpcRendererEvent, payload: EregionEvent): void => listener(payload)
  ipcRenderer.on('event', handler)
  return () => {
    ipcRenderer.removeListener('event', handler)
  }
}

contextBridge.exposeInMainWorld('eregion', bridge as unknown as EregionBridge)
