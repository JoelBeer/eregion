import { contextBridge, ipcRenderer } from 'electron'
import type { EregionApi } from '@shared/types'

const api: EregionApi = {
  appInfo: () => ipcRenderer.invoke('app:info'),
  checkTools: () => ipcRenderer.invoke('tools:check')
}

contextBridge.exposeInMainWorld('eregion', api)
