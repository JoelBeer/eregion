import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import { API_METHODS, type EregionBridge, type EregionEvent, type WindowControls } from '@shared/api'

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

/** The title bar's window buttons. Only Electron has them; the web preview leaves this out. */
const windowControls: WindowControls = {
  minimize: () => ipcRenderer.invoke('window', 'minimize'),
  toggleMaximize: () => ipcRenderer.invoke('window', 'toggle-maximize'),
  close: () => ipcRenderer.invoke('window', 'close'),
  isMaximized: () => ipcRenderer.invoke('window', 'is-maximized'),
  onMaximizedChange: (listener) => {
    const handler = (_event: IpcRendererEvent, payload: { maximized: boolean }): void => listener(payload.maximized)
    ipcRenderer.on('window', handler)
    return () => {
      ipcRenderer.removeListener('window', handler)
    }
  }
}

contextBridge.exposeInMainWorld('eregionWindow', windowControls)
