// Zustand store for accounts.

import { create } from 'zustand'
import type { AccountInfo } from '@shared/types'
import { bridge } from '../lib/bridge'

interface AccountsState {
  accounts: AccountInfo[]
  error: string | null
  load: () => Promise<void>
  add: (cli: AccountInfo['cli'], name: string) => Promise<AccountInfo | null>
  remove: (id: string) => Promise<void>
  setDefault: (cli: AccountInfo['cli'], id: string) => Promise<void>
}

let subscribed = false

export const useAccounts = create<AccountsState>((set, get) => ({
  accounts: [],
  error: null,

  load: async () => {
    if (!subscribed) {
      subscribed = true
      bridge.on('accounts:changed', (list) => set({ accounts: list }))
    }
    try {
      const list = await bridge.invoke('accounts:list')
      set({ accounts: list, error: null })
    } catch (err) {
      set({ error: err instanceof Error ? err.message : String(err) })
    }
  },

  add: async (cli, name) => {
    try {
      return await bridge.invoke('accounts:add', cli, name)
    } catch (err) {
      set({ error: err instanceof Error ? err.message : String(err) })
      return null
    }
  },

  remove: async (id) => {
    try {
      await bridge.invoke('accounts:remove', id)
    } catch (err) {
      set({ error: err instanceof Error ? err.message : String(err) })
    }
  },

  setDefault: async (cli, id) => {
    try {
      await bridge.invoke('accounts:setDefault', cli, id)
    } catch (err) {
      set({ error: err instanceof Error ? err.message : String(err) })
    }
  }
}))