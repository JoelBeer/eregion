import type { EregionBridge, WindowControls } from '@shared/api'

declare global {
  interface Window {
    eregion: EregionBridge
    /** Only in Electron: the web preview has no window to control. */
    eregionWindow?: WindowControls
  }
}

export {}
