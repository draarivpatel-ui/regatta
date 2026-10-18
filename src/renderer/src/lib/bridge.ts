import type { RegattaBridge } from '@shared/ipc'

declare global {
  interface Window {
    regatta: RegattaBridge
  }
}

export const bridge: RegattaBridge = window.regatta
