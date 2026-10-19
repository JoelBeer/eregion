import type { EregionApi } from '@shared/types'

declare global {
  interface Window {
    eregion: EregionApi
  }
}

export {}
