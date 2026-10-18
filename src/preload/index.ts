// The only door between the UI and the system. Channels not declared in shared/ipc.ts are refused.

import { contextBridge, ipcRenderer } from 'electron'
import { EVENT_CHANNELS, INVOKE_CHANNELS, SEND_CHANNELS, type RegattaBridge } from '../shared/ipc'

const invokeOk = new Set<string>(INVOKE_CHANNELS)
const sendOk = new Set<string>(SEND_CHANNELS)
const eventOk = new Set<string>(EVENT_CHANNELS)

const bridge: RegattaBridge = {
  invoke: (channel, ...args) => {
    if (!invokeOk.has(channel)) return Promise.reject(new Error(`Blocked channel: ${channel}`))
    return ipcRenderer.invoke(channel, ...args)
  },
  send: (channel, ...args) => {
    if (sendOk.has(channel)) ipcRenderer.send(channel, ...args)
  },
  on: (channel, listener) => {
    if (!eventOk.has(channel)) return () => undefined
    const wrapped = (_e: Electron.IpcRendererEvent, payload: unknown): void => listener(payload as never)
    ipcRenderer.on(channel, wrapped)
    return () => ipcRenderer.removeListener(channel, wrapped)
  },
  platform: process.platform
}

contextBridge.exposeInMainWorld('regatta', bridge)
