import type { EregionBridge } from '@shared/api'

declare global {
  interface Window {
    eregion: EregionBridge
  }
}

export {}
