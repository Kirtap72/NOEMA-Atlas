import type { AtlasApi } from '@shared/types'

declare global {
  interface Window {
    noema: AtlasApi
  }
}

export {}
