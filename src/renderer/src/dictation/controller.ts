// Starts and stops dictation from the shortcut, the toolbar button and the menu.

import { AGENTS } from '@shared/agents'
import { DICTATION_MAX_MS } from '@shared/dictation'
import { useSessions } from '../store/sessions'
import { useUi } from '../store/ui'
import { bridge } from '../lib/bridge'
import { recordAudio, type ActiveRecording } from './recorder'
import { useDictation } from './store'

export const MIC_DENIED_MESSAGE =
  'Regatta needs microphone access. Allow it in System Settings > Privacy & Security > Microphone.'

/** Stop waiting for the microphone to open after this long; on some Macs getUserMedia never answers. */
export const MIC_OPEN_TIMEOUT_MS = 5000
export const MIC_OPEN_TIMEOUT_MESSAGE = 'The microphone did not open.'
/** Rejected out of openMicrophone when the limit above was hit, so the caller can tell it from a denial. */
const MIC_OPEN_TIMED_OUT = Symbol('mic open timed out')

interface BoxTarget {
  kind: 'box'
  el: HTMLTextAreaElement | HTMLInputElement
}
interface PaneTarget {
  kind: 'pane'
  id: string
}
interface NoTarget {
  kind: 'none'
}
type Target = BoxTarget | PaneTarget | NoTarget

let recording: ActiveRecording | null = null
let target: Target | null = null
let removeEsc: (() => void) | null = null
let autoStop: number | null = null
let hideTimer: number | null = null

function clearHideTimer(): void {
  if (hideTimer !== null) {
    window.clearTimeout(hideTimer)
    hideTimer = null
  }
}

function stopListeningOverhead(): void {
  if (removeEsc) {
    removeEsc()
    removeEsc = null
  }
  if (autoStop !== null) {
    window.clearTimeout(autoStop)
    autoStop = null
  }
}

function hideSoon(ms: number): void {
  clearHideTimer()
  hideTimer = window.setTimeout(() => useDictation.getState().reset(), ms)
}

function openDictationSettings(): void {
  useUi.getState().openOverlay('settings')
  window.setTimeout(() => {
    document.querySelector<HTMLButtonElement>('[data-testid="settings-nav-dictation"]')?.click()
  }, 0)
}

/** Starts dictating into whatever has focus, or stops and transcribes. Returns true when handled. */
export function toggleDictation(): boolean {
  if (recording) {
    void stopAndTranscribe()
    return true
  }
  void startDictation()
  return true
}

/** Stops listening without transcribing. Esc and the pill's Cancel button use this. */
export function cancelDictation(): void {
  const rec = recording
  recording = null
  stopListeningOverhead()
  if (!rec) return
  rec.cancel()
  target = null
  useDictation.getState().set({ phase: 'cancelled', message: 'Cancelled', keptText: null, level: 0 })
  hideSoon(1500)
}

/** Hides the pill right away. Errors otherwise stay until dismissed. */
export function dismissDictation(): void {
  clearHideTimer()
  useDictation.getState().reset()
}

/** Tries again after the microphone did not open: clears the error and starts over. */
export function retryDictation(): void {
  useDictation.getState().reset()
  void startDictation()
}

/** Copies the kept text (when nothing had focus) to the clipboard. */
export function copyKept(): void {
  const kept = useDictation.getState().keptText
  if (kept) void navigator.clipboard.writeText(kept).catch(() => undefined)
}

async function startDictation(): Promise<void> {
  if (recording) return
  clearHideTimer()
  let ready = false
  try {
    const status = await bridge.invoke('dictation:status')
    ready = Boolean(status.engine && status.model)
  } catch {
    ready = false
  }
  if (!ready) {
    openDictationSettings()
    return
  }
  let mic = 'denied'
  try {
    mic = await bridge.invoke('dictation:microphone')
  } catch {
    mic = 'denied'
  }
  if (mic !== 'granted') {
    useDictation.getState().set({ phase: 'error', message: MIC_DENIED_MESSAGE, keptText: null, retry: false })
    return
  }
  target = captureTarget()
  let rec: ActiveRecording
  try {
    rec = await openMicrophone()
  } catch (err) {
    target = null
    if (err === MIC_OPEN_TIMED_OUT) {
      useDictation.getState().set({ phase: 'error', message: MIC_OPEN_TIMEOUT_MESSAGE, keptText: null, retry: true })
    } else {
      useDictation.getState().set({ phase: 'error', message: MIC_DENIED_MESSAGE, keptText: null, retry: false })
    }
    return
  }
  recording = rec
  const onKey = (e: KeyboardEvent): void => {
    if (e.key === 'Escape') {
      e.preventDefault()
      e.stopPropagation()
      cancelDictation()
    }
  }
  window.addEventListener('keydown', onKey, true)
  removeEsc = () => window.removeEventListener('keydown', onKey, true)
  autoStop = window.setTimeout(() => {
    void stopAndTranscribe()
  }, DICTATION_MAX_MS)
  useDictation.getState().set({ phase: 'listening', startedAt: Date.now(), level: 0, message: '', keptText: null, retry: false })
}

/**
 * Opens the microphone, but never waits longer than MIC_OPEN_TIMEOUT_MS for it. If getUserMedia
 * answers after the limit, the recording that opened late is released so no audio is left running.
 */
function openMicrophone(): Promise<ActiveRecording> {
  return new Promise((resolve, reject) => {
    let timedOut = false
    const timer = window.setTimeout(() => {
      timedOut = true
      reject(MIC_OPEN_TIMED_OUT)
    }, MIC_OPEN_TIMEOUT_MS)
    recordAudio((level) => {
      if (!timedOut) useDictation.getState().set({ level })
    })
      .then((rec) => {
        window.clearTimeout(timer)
        if (timedOut) {
          // It opened too late to be used: give the microphone straight back.
          rec.cancel()
          return
        }
        resolve(rec)
      })
      .catch((err) => {
        window.clearTimeout(timer)
        if (!timedOut) reject(err)
      })
  })
}

async function stopAndTranscribe(): Promise<void> {
  const rec = recording
  recording = null
  stopListeningOverhead()
  if (!rec) return
  useDictation.getState().set({ phase: 'transcribing', level: 0 })
  let wav: Uint8Array
  try {
    wav = await rec.stop()
  } catch (err) {
    showError(err)
    return
  }
  let text: string
  try {
    text = await bridge.invoke('dictation:transcribe', wav)
  } catch (err) {
    showError(err)
    return
  }
  if (!text.trim()) {
    showError(new Error('Nothing was heard. Try again.'))
    return
  }
  deliver(text)
}

function showError(err: unknown): void {
  recording = null
  stopListeningOverhead()
  target = null
  useDictation.getState().set({
    phase: 'error',
    message: err instanceof Error ? err.message : 'Dictation failed. Try again.',
    keptText: null,
    level: 0,
    retry: false
  })
}

function deliver(text: string): void {
  const held = target
  target = null
  const ui = useDictation.getState()
  if (held && held.kind === 'box' && held.el.isConnected) {
    insertIntoBox(held.el, text)
    ui.set({ phase: 'added', message: 'Added to your message', keptText: null, level: 0 })
  } else if (held && held.kind === 'pane') {
    const session = useSessions.getState().sessions[held.id]
    bridge.send('session:write', held.id, text.replace(/\n/g, ' '))
    ui.set({ phase: 'added', message: `Added to ${session ? AGENTS[session.agent].name : 'the terminal'}`, keptText: null, level: 0 })
  } else {
    ui.set({ phase: 'added', message: 'Here is what you said', keptText: text, level: 0 })
  }
  hideSoon(2500)
}

/** Remembers where the words should land: the focused text box, the focused pane, or nowhere. */
function captureTarget(): Target {
  const box = focusedBox()
  if (box) return { kind: 'box', el: box }
  if (useUi.getState().mode === 'code') {
    const focusedId = useSessions.getState().focusedId
    if (focusedId) return { kind: 'pane', id: focusedId }
  }
  return { kind: 'none' }
}

/** The focused textarea or text input, unless it is a terminal's own hidden field. */
function focusedBox(): HTMLTextAreaElement | HTMLInputElement | null {
  const el = document.activeElement
  if (!el || !(el instanceof HTMLElement)) return null
  // Terminals keep a hidden textarea for their own keys; typing there would go nowhere visible.
  if (el.closest('.xterm') || el.closest('.term-host')) return null
  if (el instanceof HTMLTextAreaElement) {
    if (el.readOnly || el.disabled) return null
    return el
  }
  if (el instanceof HTMLInputElement) {
    const type = el.type.toLowerCase()
    if (type === 'password' || el.readOnly || el.disabled) return null
    if (type === '' || type === 'text' || type === 'search' || type === 'url' || type === 'email' || type === 'tel') return el
  }
  return null
}

/** Inserts at the caret through the native setter plus an input event, so React state updates. */
function insertIntoBox(el: HTMLTextAreaElement | HTMLInputElement, text: string): void {
  const start = el.selectionStart ?? el.value.length
  const end = el.selectionEnd ?? el.value.length
  const before = el.value.slice(0, start)
  const after = el.value.slice(end)
  const prefix = before.length > 0 && !before.endsWith(' ') && !before.endsWith('\n') ? ' ' : ''
  const next = `${before}${prefix}${text}${after}`
  if (el instanceof HTMLTextAreaElement) {
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set
    if (setter) setter.call(el, next)
    else el.value = next
  } else {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
    if (setter) setter.call(el, next)
    else el.value = next
  }
  el.dispatchEvent(new Event('input', { bubbles: true }))
  const caret = (before + prefix + text).length
  try {
    el.setSelectionRange(caret, caret)
  } catch {
    // Some inputs refuse a caret; the text is still there.
  }
  el.focus()
}
