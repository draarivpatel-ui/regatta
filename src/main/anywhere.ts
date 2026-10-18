// Dictate anywhere (Labs): a global shortcut records speech and types the words into the app in
// front, never into a password field and never with Return.

import { execFile as execFileCb } from 'node:child_process'
import { BrowserWindow, globalShortcut, screen, shell, systemPreferences } from 'electron'
import type { DictationStatus } from '../shared/dictation'
import type { Prefs } from '../shared/types'
import type { Dictation } from './dictation'

/** The accelerator, for example "Alt+Shift+Command+Space". */
export const ANYWHERE_SHORTCUT = 'Alt+Shift+Command+Space'

/** How wide and tall the pill window is. */
const PILL_WIDTH = 380
const PILL_HEIGHT = 72
/** How long the pill shows a finished result before main hides the window. */
const RESULT_MS = 2500
/** How long the pill shows "Cancelled" before main hides the window. */
const CANCEL_MS = 1200
/** Longest System Events keystroke the pill will send in one piece. */
export const CHUNK_LIMIT = 200

export interface AnywhereStatus {
  /** Labs switch is on and the shortcut is registered. */
  enabled: boolean
  /** macOS lets Regatta control the computer (Accessibility); typing needs it. */
  trusted: boolean
  /** The accelerator, for example "Alt+Shift+Command+Space". */
  shortcut: string
  /** Why the shortcut could not be registered, when it could not. */
  error: string | null
}

export interface AnywhereResult {
  ok: boolean
  /** The app the words were meant for (the one in front when typing started), when it could be read. */
  app: string | null
  /** The words that were typed. When typing stopped part way (ok is false), only the part typed before it stopped. */
  text: string
  error: string | null
}

export interface AnywhereDeps {
  dictation: Dictation
  /** Path of the preload script, for the pill window. */
  preload: string
  /** Loads the renderer with ?view=anywhere into a window (dev server or built file). */
  load: (win: Electron.BrowserWindow, query: Record<string, string>) => void
  /**
   * Runs one AppleScript through osascript and resolves with its stdout. Injectable so tests never
   * touch macOS; when absent, the real runner calls osascript with execFile (never a shell).
   */
  runAppleScript?: (source: string, args: string[]) => Promise<string>
}

/**
 * Characters that must never reach `keystroke` as characters, because the text system behind System
 * Events gives them a key meaning (Apple's NSText.h character constants and the AppKit "Function-Key
 * Unicode Values"). Each one is replaced by a space. They are inclusive code point ranges:
 * - U+0000 to U+001F, the C0 controls. Among them U+0003 acts as Enter (it could submit dictated
 *   shell text in a terminal), U+0008 as Backspace, U+0009 as Tab, U+000A and U+000D as Return,
 *   U+0019 as Back Tab and U+001B as Escape.
 * - U+007F (Delete) and U+0080 to U+009F, the C1 controls (U+0085 is a newline).
 * - U+2028 and U+2029, the line and paragraph separators: newlines to a text view.
 * - U+F700 to U+F8FF, the private-use block AppKit reserves for the function keys (arrows, F1 and
 *   up, forward delete, Home, End, Page Up, Page Down). Speech never produces these.
 * Zero-width and bidirectional format characters are left alone: they cannot act as keys, and the
 * joiners are part of real emoji and script text. The ranges are plain numbers rather than an
 * escaped pattern, so no invisible character has to appear in this file.
 */
const KEY_LIKE_RANGES: ReadonlyArray<readonly [number, number]> = [
  [0x0000, 0x001f],
  [0x007f, 0x009f],
  [0x2028, 0x2029],
  [0xf700, 0xf8ff]
]

function isKeyLike(codePoint: number): boolean {
  return KEY_LIKE_RANGES.some(([low, high]) => codePoint >= low && codePoint <= high)
}

/**
 * The words as they will be typed: every character that could act as a key (see KEY_LIKE_RANGES,
 * which includes newlines and tabs) becomes a space, so typing never presses Return, Enter, Tab,
 * Escape, Delete or an arrow. One character becomes one space, so lengths do not change. Nothing is
 * escaped, because the words never become part of a script: they reach osascript as an argument
 * (see KEYSTROKE_SOURCE). This is the last step before the words are typed; deliver() applies it
 * to the whole text and again to every chunk it sends.
 */
export function keystrokeText(text: string): string {
  let typed = ''
  // By code point, so an emoji (a surrogate pair) is looked at whole and kept.
  for (const char of text) typed += isKeyLike(char.codePointAt(0) ?? 0) ? ' ' : char
  return typed
}

/**
 * Splits text into pieces no longer than `max` characters. It walks by code point so a surrogate
 * pair (an emoji) is never cut in half.
 */
export function chunkForKeystroke(text: string, max: number = CHUNK_LIMIT): string[] {
  if (max < 1) return [text]
  const chars = Array.from(text)
  if (chars.length === 0) return []
  const chunks: string[] = []
  let current: string[] = []
  for (const char of chars) {
    if (current.length >= max) {
      chunks.push(current.join(''))
      current = []
    }
    current.push(char)
  }
  if (current.length > 0) chunks.push(current.join(''))
  return chunks
}

/**
 * The final typing boundary: one chunk, made safe, with the arguments the typing script gets for it
 * (the words, the app recorded at the start, and Regatta's own process id). Everything that reaches
 * `keystroke` goes through here, whatever built the chunk.
 */
export function typingRun(chunk: string, app: string): { words: string; args: string[] } {
  const words = keystrokeText(chunk)
  return { words, args: [words, app, String(process.pid)] }
}

/** What the typing script answers after it typed a chunk. */
export const TYPED = 'typed'

/** The words the typing script answers with when it refuses to type, each one a reason. */
export const REFUSAL_WORDS = ['no-app', 'regatta', 'app-changed', 'unreadable', 'secure-field'] as const

export type TypingRefusal = (typeof REFUSAL_WORDS)[number]

/**
 * Asks System Events which app is in front: its name and its process id, separated by a tab. It
 * runs once, when a delivery starts, to record which app the words are for. When it cannot read the
 * app it fails (osascript exits with an error) and nothing is typed.
 */
export const FOCUS_QUERY = [
  'tell application "System Events"',
  '\tset frontProc to first application process whose frontmost is true',
  '\treturn (name of frontProc) & "\t" & ((unix id of frontProc) as text)',
  'end tell'
].join('\n')

/**
 * Types its first argument with System Events, but only after checking, in the same script and right
 * before the keystroke, that typing is safe. deliver() runs it once per chunk, so a change of app or
 * of field in the middle of a long dictation stops the rest. Its arguments are the words (item 1),
 * the name of the app recorded when the delivery started (item 2) and Regatta's own process id
 * (item 3). The words and the other values are only ever arguments, never placed in the script, so
 * no wording can change what the script does.
 *
 * It answers with one word: "typed", or the reason it refused (see TypingRefusal). It types only
 * when the app in front is readable, is not Regatta (by name or by process id, because a
 * development build is named "Electron"), is the recorded app, and has a focused element whose
 * subrole could be read and is not AXSecureTextField. A field with no subrole at all counts as
 * readable (most fields have none), but only when the element's own attribute list says so; a read
 * that fails counts as a refusal (it fails closed).
 *
 * Checked 2026-10-15: the script compiles (osacompile, which runs nothing), and its decisions and
 * error paths were run with the System Events reads replaced by stubs. The live reads were not run
 * (that session could not query System Events or type): how System Events answers for a field that
 * has no subrole still needs a look on a real Mac, with a plain field and a password field.
 */
export const KEYSTROKE_SOURCE = [
  'on run argv',
  '\tset facts to my readFront()',
  '\tset verdict to my decide(facts, item 2 of argv, item 3 of argv)',
  '\tif verdict is not "ok" then return verdict',
  '\tmy typeText(item 1 of argv)',
  '\treturn "typed"',
  'end run',
  '',
  '-- What is in front right now: {app name, process id, kind of focused field}. The kind stays',
  '-- "unreadable" unless every read worked, so any failure refuses.',
  'on readFront()',
  '\tset frontName to ""',
  '\tset frontPid to ""',
  '\tset fieldKind to "unreadable"',
  '\ttry',
  '\t\ttell application "System Events"',
  '\t\t\tset frontProc to first application process whose frontmost is true',
  '\t\t\tset frontName to name of frontProc',
  '\t\t\tset frontPid to (unix id of frontProc) as text',
  '\t\t\tset focusedEl to value of attribute "AXFocusedUIElement" of frontProc',
  '\t\t\tset subroleValue to missing value',
  '\t\t\tset subroleReadable to true',
  '\t\t\ttry',
  '\t\t\t\tset subroleValue to value of attribute "AXSubrole" of focusedEl',
  '\t\t\ton error',
  '\t\t\t\t-- Most fields have no subrole. Only the element\'s own attribute list can tell that apart from a failed read.',
  '\t\t\t\tif (name of attributes of focusedEl) contains "AXSubrole" then set subroleReadable to false',
  '\t\t\tend try',
  '\t\t\tif subroleReadable is false then',
  '\t\t\t\tset fieldKind to "unreadable"',
  '\t\t\telse if subroleValue is missing value then',
  '\t\t\t\tset fieldKind to "plain"',
  '\t\t\telse',
  '\t\t\t\tset fieldKind to subroleValue as text',
  '\t\t\tend if',
  '\t\tend tell',
  '\ton error',
  '\t\tset fieldKind to "unreadable"',
  '\tend try',
  '\treturn {frontName, frontPid, fieldKind}',
  'end readFront',
  '',
  '-- The checks, in order. Anything that is not "ok" is a refusal and nothing is typed.',
  'on decide(facts, wantedApp, ownPid)',
  '\tset frontName to item 1 of facts',
  '\tset frontPid to item 2 of facts',
  '\tset fieldKind to item 3 of facts',
  '\tif frontName is "" or frontPid is "" then return "no-app"',
  '\tif frontPid is ownPid or frontName is "Regatta" then return "regatta"',
  '\tconsidering case',
  '\t\tif wantedApp is "" or frontName is not wantedApp then return "app-changed"',
  '\tend considering',
  '\tif fieldKind is "unreadable" then return "unreadable"',
  '\tif fieldKind is "AXSecureTextField" then return "secure-field"',
  '\treturn "ok"',
  'end decide',
  '',
  'on typeText(spoken)',
  '\ttell application "System Events" to keystroke spoken',
  'end typeText'
].join('\n')

/**
 * osascript's arguments for a script and its own arguments. The `--` ends osascript's options, so
 * an argument that starts with a dash (for example "-e ...") stays an argument (verified 2026-10-14).
 */
export function osascriptArgs(source: string, args: string[]): string[] {
  return ['-e', source, '--', ...args]
}

function defaultRunAppleScript(source: string, args: string[]): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    execFileCb('osascript', osascriptArgs(source, args), { timeout: 8000, maxBuffer: 1024 * 1024 }, (err, stdout) => {
      if (err) reject(err)
      else resolve(String(stdout))
    })
  })
}

const NO_APP_MESSAGE = 'Regatta could not read the app in front.'
const TYPE_FAILED_MESSAGE = 'Regatta could not type into the app in front.'
const REST_NOT_TYPED = 'The rest was not typed.'

/**
 * What the pill shows when typing stops. `first` is the whole sentence for a stop before anything
 * was typed; `later` is just the reason, used when some chunks are already in the app (the rest of
 * the message then says the remaining words were not typed).
 */
const REFUSAL_TEXT: Record<TypingRefusal | 'unknown', { first: string; later: string }> = {
  'no-app': { first: NO_APP_MESSAGE, later: NO_APP_MESSAGE },
  regatta: { first: 'Use the normal Dictation feature inside Regatta.', later: 'Regatta came to the front.' },
  'app-changed': { first: 'The app in front changed, so nothing was typed.', later: 'The app in front changed.' },
  unreadable: {
    first: 'Regatta could not check the field in front, so nothing was typed.',
    later: 'Regatta could not check the field in front.'
  },
  'secure-field': { first: 'That is a password field, so nothing was typed.', later: 'A password field took the focus.' },
  // Anything the script answers that is not "typed" or a known reason (an empty answer, say).
  unknown: {
    first: 'Regatta could not confirm it was safe to type, so nothing was typed.',
    later: 'Regatta could not confirm it was safe to type.'
  }
}

function isRefusal(word: string): word is TypingRefusal {
  return (REFUSAL_WORDS as readonly string[]).includes(word)
}

/** The error for a typing script answer that was not "typed". `typed` is what went in before it ('' for nothing). */
function refusalMessage(word: string, typed: string): string {
  const text = REFUSAL_TEXT[isRefusal(word) ? word : 'unknown']
  return typed ? `${text.later} ${REST_NOT_TYPED}` : text.first
}

/** The result of a delivery that was cancelled because Dictate anywhere was turned off or disposed. */
function cancelledResult(app: string | null, typed: string): AnywhereResult {
  const error = typed
    ? `Cancelled: Dictate anywhere was turned off. ${REST_NOT_TYPED}`
    : 'Cancelled: Dictate anywhere was turned off, so nothing was typed.'
  return { ok: false, app, text: typed, error }
}

/**
 * Reads the focus query's answer, "<app name><tab><process id>". Returns null when either part is
 * missing or malformed, and the caller then types nothing. Only the final line ending is removed:
 * the name is kept exactly, because the typing script compares it exactly.
 */
function parseFront(answer: string): { app: string; pid: string } | null {
  const line = answer.replace(/\r?\n$/, '')
  const tab = line.indexOf('\t')
  if (tab === -1) return null
  const app = line.slice(0, tab)
  const pid = line.slice(tab + 1)
  return app.trim().length > 0 && /^\d+$/.test(pid) ? { app, pid } : null
}

/** True when the app in front is Regatta: named Regatta, or this very process (a development build is named "Electron"). */
function isRegatta(app: string, pid: string): boolean {
  return app.toLowerCase() === 'regatta' || pid === String(process.pid)
}

export class Anywhere {
  private pill: BrowserWindow | null = null
  private pillLoaded = false
  private readonly readyWaiters: Array<() => void> = []
  private shortcutRegistered = false
  private escapeRegistered = false
  private listening = false
  private promptedForTrust = false
  private error: string | null = null
  private hideTimer: ReturnType<typeof setTimeout> | null = null
  /**
   * Bumped whenever Dictate anywhere is turned off or disposed. A delivery or a shortcut press
   * remembers the number it started under and gives up as soon as it has changed, so nothing that
   * was pending when Labs went off can type or show the pill afterwards.
   */
  private generation = 0
  private disposed = false

  constructor(private readonly deps: AnywhereDeps) {}

  /** Registers or unregisters the shortcut to match the Labs switch. Called at start and on every prefs change. */
  apply(prefs: Prefs): void {
    if (this.disposed) return
    if (!prefs.labs.anywhere) {
      this.teardown()
      this.error = null
      return
    }
    if (this.shortcutRegistered) return
    const ok = globalShortcut.register(ANYWHERE_SHORTCUT, () => {
      void this.onPress()
    })
    if (ok) {
      this.shortcutRegistered = true
      this.error = null
    } else {
      this.shortcutRegistered = false
      this.error = 'Option+Shift+Command+Space is taken by another app.'
    }
  }

  status(): AnywhereStatus {
    let trusted = false
    try {
      trusted = systemPreferences.isTrustedAccessibilityClient(false)
    } catch {
      trusted = false
    }
    return { enabled: this.shortcutRegistered, trusted, shortcut: ANYWHERE_SHORTCUT, error: this.error }
  }

  /** Opens System Settings at Privacy & Security > Accessibility. */
  openAccessibility(): void {
    void shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility')
  }

  /**
   * The pill hands over the finished recording; returns what happened. The words are typed in chunks,
   * and before each chunk the typing script checks again that the app in front is the one recorded at
   * the start and that the focused field is readable and not a password field. The first chunk that is
   * refused ends the delivery, so a change of app or field in the middle stops the rest. Turning Labs
   * off or disposing cancels a delivery that is still waiting (see `generation`).
   */
  async deliver(wav: Uint8Array): Promise<AnywhereResult> {
    const generation = this.generation
    const cancelled = (): boolean => this.generation !== generation
    // Typing only happens while Dictate anywhere is on.
    if (this.disposed || !this.shortcutRegistered) return cancelledResult(null, '')

    let text: string
    try {
      text = await this.deps.dictation.transcribe(wav)
    } catch (err) {
      if (cancelled()) return cancelledResult(null, '')
      return this.finish(generation, {
        ok: false,
        app: null,
        text: '',
        error: err instanceof Error ? err.message : 'Dictation failed. Try again.'
      })
    }
    if (cancelled()) return cancelledResult(null, '')

    // The last step before typing: no character that could act as a key goes any further. Words that
    // are only such characters are not words.
    const words = keystrokeText(text)
    if (!words.trim()) return this.finish(generation, { ok: false, app: null, text: '', error: 'Heard nothing.' })

    let front: { app: string; pid: string } | null = null
    try {
      front = parseFront(await this.run(FOCUS_QUERY))
    } catch {
      front = null
    }
    if (cancelled()) return cancelledResult(front ? front.app : null, '')
    if (!front) return this.finish(generation, { ok: false, app: null, text: '', error: NO_APP_MESSAGE })
    const { app, pid } = front
    if (isRegatta(app, pid)) {
      return this.finish(generation, { ok: false, app, text: '', error: refusalMessage('regatta', '') })
    }

    let typed = ''
    for (const chunk of chunkForKeystroke(words)) {
      if (cancelled()) return cancelledResult(app, typed)
      // Made safe again here, so whatever builds the chunks, nothing key-like is ever sent.
      const { words: toType, args } = typingRun(chunk, app)
      let answer: string
      try {
        // The script answers "typed" or the reason it refused, and checks the app and the field itself.
        answer = (await this.run(KEYSTROKE_SOURCE, args)).trim()
      } catch {
        const error = typed ? `${TYPE_FAILED_MESSAGE} ${REST_NOT_TYPED}` : TYPE_FAILED_MESSAGE
        return this.finish(generation, { ok: false, app, text: typed, error })
      }
      if (answer !== TYPED) {
        return this.finish(generation, { ok: false, app, text: typed, error: refusalMessage(answer, typed) })
      }
      typed += toType
    }
    return this.finish(generation, { ok: true, app, text: typed, error: null })
  }

  dispose(): void {
    // Nothing may type or show the pill after this: pending deliveries and shortcut presses give up.
    this.disposed = true
    this.cancelPending()
    this.teardown()
    if (this.pill && !this.pill.isDestroyed()) this.pill.destroy()
    this.pill = null
  }

  // --- internals -----------------------------------------------------------

  private run(source: string, args: string[] = []): Promise<string> {
    const custom = this.deps.runAppleScript
    return custom ? custom(source, args) : defaultRunAppleScript(source, args)
  }

  /**
   * Starts a new generation, so every delivery and shortcut press that began earlier gives up at its
   * next check, and wakes any press that is still waiting for the pill so it can see that.
   */
  private cancelPending(): void {
    this.generation += 1
    for (const resolve of this.readyWaiters.splice(0)) resolve()
  }

  /**
   * Schedules the pill to hide and returns the given result unchanged. A delivery from an older
   * generation changes nothing: the state it would reset belongs to a newer session (or to none).
   */
  private finish(generation: number, result: AnywhereResult): AnywhereResult {
    if (generation === this.generation) {
      this.listening = false
      this.unregisterEscape()
      this.hideSoon(RESULT_MS)
    }
    return result
  }

  private async onPress(): Promise<void> {
    // A press belongs to the generation it began in: if Labs goes off (or Anywhere is disposed)
    // while it waits for the dictation status or the pill, it ends without showing or recording.
    const generation = this.generation
    const cancelled = (): boolean => this.generation !== generation
    if (this.disposed) return
    if (this.listening) {
      this.stopListening()
      return
    }
    let trusted = false
    try {
      trusted = systemPreferences.isTrustedAccessibilityClient(false)
      if (!trusted && !this.promptedForTrust) {
        this.promptedForTrust = true
        // Asking with true lets macOS offer to grant Accessibility, once per app run.
        systemPreferences.isTrustedAccessibilityClient(true)
      }
    } catch {
      trusted = false
    }
    if (!trusted) {
      await this.ensurePill()
      if (cancelled()) return
      this.showPill()
      return
    }
    let status: DictationStatus | null = null
    try {
      status = await this.deps.dictation.status()
    } catch {
      status = null
    }
    if (cancelled()) return
    if (!status || !status.engine || !status.model) return
    await this.ensurePill()
    if (cancelled()) return
    this.showPill()
    this.listening = true
    this.registerEscape()
    this.send({ action: 'start' })
  }

  private stopListening(): void {
    if (!this.listening) return
    this.listening = false
    this.unregisterEscape()
    this.send({ action: 'stop' })
  }

  private cancel(): void {
    if (!this.listening) return
    this.listening = false
    this.unregisterEscape()
    this.send({ action: 'cancel' })
    this.hideSoon(CANCEL_MS)
  }

  private send(payload: { action: 'start' | 'stop' | 'cancel' }): void {
    if (this.pill && !this.pill.isDestroyed()) this.pill.webContents.send('anywhere:toggle', payload)
  }

  private registerEscape(): void {
    if (this.escapeRegistered) return
    if (globalShortcut.isRegistered('Escape')) return
    if (globalShortcut.register('Escape', () => this.cancel())) this.escapeRegistered = true
  }

  private unregisterEscape(): void {
    if (!this.escapeRegistered) return
    globalShortcut.unregister('Escape')
    this.escapeRegistered = false
  }

  private teardown(): void {
    this.cancelPending()
    this.listening = false
    this.unregisterEscape()
    if (this.shortcutRegistered) {
      globalShortcut.unregister(ANYWHERE_SHORTCUT)
      this.shortcutRegistered = false
    }
    if (this.pill && !this.pill.isDestroyed()) this.pill.destroy()
    this.pill = null
    this.pillLoaded = false
    this.clearHideTimer()
  }

  private createPill(): void {
    const win = new BrowserWindow({
      width: PILL_WIDTH,
      height: PILL_HEIGHT,
      show: false,
      frame: false,
      transparent: true,
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      focusable: false,
      skipTaskbar: true,
      hasShadow: false,
      alwaysOnTop: true,
      webPreferences: {
        preload: this.deps.preload,
        contextIsolation: true,
        sandbox: true
      }
    })
    win.setAlwaysOnTop(true, 'screen-saver')
    win.once('ready-to-show', () => {
      // Only the current pill counts: a window that was replaced or destroyed must not mark a newer one ready.
      if (this.pill !== win) return
      if (!this.pillLoaded) {
        this.pillLoaded = true
        const waiters = this.readyWaiters.splice(0)
        for (const resolve of waiters) resolve()
      }
    })
    win.on('closed', () => {
      if (this.pill === win) {
        this.pill = null
        this.pillLoaded = false
      }
    })
    this.pill = win
    this.deps.load(win, { view: 'anywhere' })
  }

  /** Creates the pill if needed and resolves once its renderer is ready to receive a toggle. */
  private async ensurePill(): Promise<void> {
    if (!this.pill || this.pill.isDestroyed()) {
      this.createPill()
    }
    if (this.pillLoaded) return
    await new Promise<void>((resolve) => {
      this.readyWaiters.push(resolve)
    })
  }

  private showPill(): void {
    if (!this.pill || this.pill.isDestroyed()) return
    const point = screen.getCursorScreenPoint()
    const { bounds } = screen.getDisplayNearestPoint(point)
    const x = Math.round(bounds.x + (bounds.width - PILL_WIDTH) / 2)
    const y = Math.round(bounds.y + bounds.height - PILL_HEIGHT - 24)
    this.pill.setBounds({ x, y, width: PILL_WIDTH, height: PILL_HEIGHT })
    this.clearHideTimer()
    this.pill.showInactive()
  }

  private hideSoon(ms: number): void {
    this.clearHideTimer()
    this.hideTimer = setTimeout(() => {
      this.hideTimer = null
      if (this.pill && !this.pill.isDestroyed()) this.pill.hide()
    }, ms)
  }

  private clearHideTimer(): void {
    if (this.hideTimer !== null) {
      clearTimeout(this.hideTimer)
      this.hideTimer = null
    }
  }
}
