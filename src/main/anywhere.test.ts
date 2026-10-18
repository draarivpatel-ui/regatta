// Unit tests for Dictate anywhere. Electron is mocked so nothing registers a real shortcut, opens a
// window or touches macOS; the osascript runner is injected, so no test runs osascript, asks System
// Events anything or types a key. The fake runner answers the way the typing script does: it says
// "typed" or the reason it refused.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => {
  /** A stand-in for the pill window that remembers what main asked of it. */
  class FakeWindow {
    static all: FakeWindow[] = []
    destroyed = false
    shown = 0
    sent: Array<{ channel: string; payload: unknown }> = []
    private readonly handlers: Record<string, Array<() => void>> = {}
    readonly webContents = {
      send: (channel: string, payload: unknown): void => {
        this.sent.push({ channel, payload })
      }
    }
    constructor() {
      FakeWindow.all.push(this)
    }
    setAlwaysOnTop(): void {}
    once(event: string, handler: () => void): void {
      this.handlers[event] = [...(this.handlers[event] ?? []), handler]
    }
    on(): void {}
    isDestroyed(): boolean {
      return this.destroyed
    }
    destroy(): void {
      this.destroyed = true
    }
    setBounds(): void {}
    showInactive(): void {
      this.shown += 1
    }
    hide(): void {}
    /** The renderer finished loading: fires the 'ready-to-show' handlers, as Electron would. */
    emitReady(): void {
      for (const handler of this.handlers['ready-to-show'] ?? []) handler()
    }
  }
  return {
    register: vi.fn((_accelerator: string, _callback: () => void) => true),
    unregister: vi.fn(),
    isRegistered: vi.fn(() => false),
    isTrusted: vi.fn(() => true),
    openExternal: vi.fn(),
    FakeWindow
  }
})

vi.mock('electron', () => ({
  globalShortcut: { register: mocks.register, unregister: mocks.unregister, isRegistered: mocks.isRegistered },
  systemPreferences: { isTrustedAccessibilityClient: mocks.isTrusted },
  shell: { openExternal: mocks.openExternal },
  BrowserWindow: mocks.FakeWindow,
  screen: {
    getCursorScreenPoint: () => ({ x: 0, y: 0 }),
    getDisplayNearestPoint: () => ({ bounds: { x: 0, y: 0, width: 1440, height: 900 } })
  }
}))

import type { Dictation } from './dictation'
import type { Prefs } from '../shared/types'
import {
  ANYWHERE_SHORTCUT,
  Anywhere,
  FOCUS_QUERY,
  KEYSTROKE_SOURCE,
  REFUSAL_WORDS,
  TYPED,
  chunkForKeystroke,
  keystrokeText,
  osascriptArgs,
  typingRun,
  type AnywhereDeps
} from './anywhere'

function prefsWithAnywhere(on: boolean): Prefs {
  return {
    notifications: true,
    quietAfterSec: 60,
    confirmClosePane: true,
    theme: 'system',
    accent: null,
    labs: { video: false, board: false, anywhere: on },
    welcomeSeen: true
  }
}

const WAV = new Uint8Array([1, 2, 3])
const OWN_PID = String(process.pid)

/** The character with this code point, so no control character has to be typed into this file. */
const ch = (code: number): string => String.fromCodePoint(code)

const range = (from: number, to: number): number[] => Array.from({ length: to - from + 1 }, (_, i) => from + i)

/** Written independently of the code under test: true for every character that could act as a key. */
function actsAsKey(code: number): boolean {
  return (
    code <= 0x1f || (code >= 0x7f && code <= 0x9f) || code === 0x2028 || code === 0x2029 || (code >= 0xf700 && code <= 0xf8ff)
  )
}

/** The focus query's reply when `app` is in front (osascript ends what it prints with a newline). */
const frontReply = (app: string, pid = '4242'): string => `${app}\t${pid}\n`

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (reason: unknown) => void } {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

/** Lets every pending promise continuation run. */
const settle = (): Promise<void> => new Promise((resolve) => setImmediate(resolve))

/**
 * What the fake typing script answers for one chunk: a word ("typed" or a refusal), an Error (osascript
 * failed), or a function that runs first and returns the word, to change the world in the middle of
 * a delivery.
 */
type Answer = string | Error | (() => string | Promise<string>)

interface FakeMac {
  run: (source: string, args: string[]) => Promise<string>
  /** Every script the fake was asked to run, with its arguments. */
  calls: Array<{ source: string; args: string[] }>
  /** The chunks that were actually typed (the script answered "typed"). */
  typed: string[]
  focusQueries: () => number
  typingRuns: () => Array<{ source: string; args: string[] }>
}

function makeMac(options: { front?: Answer; typing?: Answer[] } = {}): FakeMac {
  const front = options.front ?? frontReply('Notes')
  const answers = [...(options.typing ?? [])]
  const calls: FakeMac['calls'] = []
  const typed: string[] = []
  const run = async (source: string, args: string[]): Promise<string> => {
    calls.push({ source, args })
    if (source === FOCUS_QUERY) {
      const reply = typeof front === 'function' ? await front() : front
      if (reply instanceof Error) throw reply
      return reply
    }
    if (source !== KEYSTROKE_SOURCE) throw new Error('the fake Mac was asked to run an unexpected script')
    const next = answers.shift() ?? TYPED
    const answer = typeof next === 'function' ? await next() : next
    if (answer instanceof Error) throw answer
    if (answer === TYPED) typed.push(args[0] ?? '')
    return `${answer}\n`
  }
  return {
    run,
    calls,
    typed,
    focusQueries: () => calls.filter((call) => call.source === FOCUS_QUERY).length,
    typingRuns: () => calls.filter((call) => call.source === KEYSTROKE_SOURCE)
  }
}

const made: Anywhere[] = []

function makeAnywhere(
  options: { front?: Answer; typing?: Answer[]; enabled?: boolean } = {}
): {
  anywhere: Anywhere
  mac: FakeMac
  transcribe: ReturnType<typeof vi.fn<(wav: Uint8Array) => Promise<string>>>
  status: ReturnType<typeof vi.fn<() => Promise<{ engine: string; model: string }>>>
} {
  const mac = makeMac(options)
  const transcribe = vi.fn(async (_wav: Uint8Array) => 'hello there')
  const status = vi.fn(async () => ({ engine: '/usr/bin/whisper-cli', model: 'base.en' }))
  const dictation = { transcribe, status } as unknown as Dictation
  const deps: AnywhereDeps = {
    dictation,
    preload: '/tmp/preload.js',
    load: () => undefined,
    runAppleScript: mac.run
  }
  const anywhere = new Anywhere(deps)
  made.push(anywhere)
  // Dictate anywhere is on, as it is whenever the pill can hand over a recording.
  if (options.enabled !== false) anywhere.apply(prefsWithAnywhere(true))
  return { anywhere, mac, transcribe, status }
}

/** What main sends the pill when listening starts. */
const START_MESSAGE = { channel: 'anywhere:toggle', payload: { action: 'start' } }

/** Presses the global shortcut, the way Electron would call the callback that was registered for it. */
function pressShortcut(): void {
  const call = mocks.register.mock.calls.find(([accelerator]) => accelerator === ANYWHERE_SHORTCUT)
  if (!call) throw new Error('the shortcut was never registered')
  call[1]()
}

/** The one pill window that exists, or an error if there are none or several. */
function onlyPill(): InstanceType<typeof mocks.FakeWindow> {
  const [pill] = mocks.FakeWindow.all
  if (mocks.FakeWindow.all.length !== 1 || !pill) throw new Error(`expected one pill window, found ${mocks.FakeWindow.all.length}`)
  return pill
}

/** Fails if any character that could act as a key was ever handed to the typing script. */
function expectNothingKeyLikeWasSent(mac: FakeMac): void {
  for (const run of mac.typingRuns()) {
    for (const char of run.args[0] ?? '') {
      const code = char.codePointAt(0) ?? 0
      expect(actsAsKey(code), `U+${code.toString(16).padStart(4, '0')} reached the typing script`).toBe(false)
    }
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.register.mockReturnValue(true)
  mocks.isRegistered.mockReturnValue(false)
  mocks.isTrusted.mockReturnValue(true)
  mocks.FakeWindow.all.length = 0
})

afterEach(() => {
  for (const anywhere of made.splice(0)) anywhere.dispose()
})

describe('keystrokeText', () => {
  it('turns newlines and tabs into spaces so Return and Tab are never pressed', () => {
    expect(keystrokeText('one\ntwo')).toBe('one two')
    expect(keystrokeText('a\tb')).toBe('a b')
    expect(keystrokeText('a\r\nb')).toBe('a  b')
  })

  it('leaves quotes, backslashes and emoji exactly as said', () => {
    expect(keystrokeText('He said "hi" \\ ok 😀')).toBe('He said "hi" \\ ok 😀')
  })

  it('replaces every C0 control, Delete and every C1 control with one space', () => {
    for (const code of [...range(0x00, 0x1f), ...range(0x7f, 0x9f)]) {
      expect(keystrokeText(`a${ch(code)}b`), `U+${code.toString(16).padStart(4, '0')}`).toBe('a b')
    }
  })

  // The keys the release review named, each as a lone control character in the middle of words.
  const NAMED_CONTROLS: Array<{ name: string; code: number }> = [
    { name: 'Enter (U+0003)', code: 0x03 },
    { name: 'Back Tab (U+0019)', code: 0x19 },
    { name: 'Backspace (U+0008)', code: 0x08 },
    { name: 'Delete (U+007F)', code: 0x7f },
    { name: 'Escape (U+001B)', code: 0x1b },
    { name: 'NUL (U+0000)', code: 0x00 },
    { name: 'a C1 control, next line (U+0085)', code: 0x85 },
    { name: 'a C1 control, control sequence introducer (U+009B)', code: 0x9b }
  ]
  for (const { name, code } of NAMED_CONTROLS) {
    it(`replaces ${name} with a space`, () => {
      expect(keystrokeText(`run${ch(code)}it`)).toBe('run it')
    })
  }

  // Characters that are not controls but still mean a key or a newline to the text system.
  const KEY_LIKE_OTHERS: Array<{ name: string; code: number }> = [
    { name: 'the line separator (U+2028)', code: 0x2028 },
    { name: 'the paragraph separator (U+2029)', code: 0x2029 },
    { name: 'the up arrow function key code (U+F700)', code: 0xf700 },
    { name: 'the forward delete function key code (U+F728)', code: 0xf728 },
    { name: 'the last function key code (U+F8FF)', code: 0xf8ff }
  ]
  for (const { name, code } of KEY_LIKE_OTHERS) {
    it(`replaces ${name} with a space`, () => {
      expect(keystrokeText(`a${ch(code)}b`)).toBe('a b')
    })
  }

  it('leaves the characters next to those ranges, and format characters, alone', () => {
    // space, tilde, no-break space, first Latin-1 letter, just below the line separator, a bidi
    // embedding mark, zero-width joiner, word joiner, just below and above the function key block,
    // the byte order mark and an emoji
    for (const code of [0x20, 0x7e, 0xa0, 0xa1, 0x2027, 0x202a, 0x200d, 0x2060, 0xf6ff, 0xf900, 0xfeff, 0x1f600]) {
      expect(keystrokeText(ch(code)), `U+${code.toString(16).padStart(4, '0')}`).toBe(ch(code))
    }
  })

  it('keeps an emoji sequence whole', () => {
    const family = [0x1f468, 0x200d, 0x1f469, 0x200d, 0x1f467].map(ch).join('')
    expect(keystrokeText(`a ${family} b`)).toBe(`a ${family} b`)
  })

  it('keeps the number of characters and does nothing the second time', () => {
    const messy = ['a', ch(3), 'b', ch(0x2028), ch(0x1f600), ch(0x85), 'c'].join('')
    const once = keystrokeText(messy)
    expect(Array.from(once)).toHaveLength(Array.from(messy).length)
    expect(keystrokeText(once)).toBe(once)
  })
})

describe('osascriptArgs', () => {
  it('ends osascript options before the arguments, so "-e ..." stays an argument', () => {
    expect(osascriptArgs(KEYSTROKE_SOURCE, ['-e do shell script "x"'])).toEqual(['-e', KEYSTROKE_SOURCE, '--', '-e do shell script "x"'])
  })

  it('passes the words, the recorded app and the process id in that order', () => {
    expect(osascriptArgs(KEYSTROKE_SOURCE, ['-e hi', 'Notes', '123'])).toEqual([
      '-e',
      KEYSTROKE_SOURCE,
      '--',
      '-e hi',
      'Notes',
      '123'
    ])
  })
})

describe('chunkForKeystroke', () => {
  it('returns nothing for empty text', () => {
    expect(chunkForKeystroke('')).toEqual([])
  })

  it('splits by the limit and rejoins to the original', () => {
    const source = 'x'.repeat(450)
    const chunks = chunkForKeystroke(source)
    expect(chunks.every((c) => c.length <= 200)).toBe(true)
    expect(chunks.join('')).toBe(source)
    expect(chunks.length).toBe(3)
  })

  it('keeps a small string in one chunk', () => {
    expect(chunkForKeystroke('abc', 2)).toEqual(['ab', 'c'])
  })

  it('never cuts a surrogate pair', () => {
    const source = '😀'.repeat(205)
    const chunks = chunkForKeystroke(source)
    expect(chunks.join('')).toBe(source)
    for (const chunk of chunks) {
      // Every chunk is whole emoji, so its code units come in pairs.
      expect(chunk.length % 2).toBe(0)
      expect(Array.from(chunk).length * 2).toBe(chunk.length)
    }
  })
})

describe('typingRun', () => {
  it('makes the chunk safe and builds the script arguments: the words, the recorded app, Regatta\'s process id', () => {
    const run = typingRun(`ls${ch(3)} -la${ch(0x19)}`, 'Terminal')
    expect(run.words).toBe('ls  -la ')
    expect(run.args).toEqual(['ls  -la ', 'Terminal', OWN_PID])
  })

  it('catches every key-like character, so nothing that builds a chunk can bypass it', () => {
    const codes = [...range(0x00, 0x1f), ...range(0x7f, 0x9f), 0x2028, 0x2029, 0xf700, 0xf8ff]
    const run = typingRun(codes.map((code) => ch(code)).join(''), 'Terminal')
    expect(run.words).toBe(' '.repeat(codes.length))
    expect(run.args[0]).toBe(run.words)
  })

  it('leaves a clean chunk exactly as it is', () => {
    const run = typingRun('Hello, "world" \\ 😀', 'Notes')
    expect(run).toEqual({ words: 'Hello, "world" \\ 😀', args: ['Hello, "world" \\ 😀', 'Notes', OWN_PID] })
  })
})

describe('the scripts', () => {
  it('types exactly once, and only after the checks have passed', () => {
    expect(KEYSTROKE_SOURCE.split('keystroke').length - 1).toBe(1)
    const gate = KEYSTROKE_SOURCE.indexOf('if verdict is not "ok" then return verdict')
    const typing = KEYSTROKE_SOURCE.indexOf('my typeText(item 1 of argv)')
    const answer = KEYSTROKE_SOURCE.indexOf('return "typed"')
    expect(gate).toBeGreaterThan(-1)
    expect(typing).toBeGreaterThan(gate)
    expect(answer).toBeGreaterThan(typing)
  })

  it('takes the words, the recorded app and Regatta\'s process id as arguments only', () => {
    expect(KEYSTROKE_SOURCE).toContain('item 1 of argv')
    expect(KEYSTROKE_SOURCE).toContain('item 2 of argv')
    expect(KEYSTROKE_SOURCE).toContain('item 3 of argv')
    expect(KEYSTROKE_SOURCE).not.toContain('${')
    expect(FOCUS_QUERY).not.toContain('${')
  })

  it('can refuse with every reason that deliver() understands', () => {
    for (const word of REFUSAL_WORDS) expect(KEYSTROKE_SOURCE).toContain(`return "${word}"`)
  })

  it('checks Regatta by name and by process id, the recorded app and the password subrole', () => {
    expect(KEYSTROKE_SOURCE).toContain('frontPid is ownPid or frontName is "Regatta"')
    expect(KEYSTROKE_SOURCE).toContain('frontName is not wantedApp')
    expect(KEYSTROKE_SOURCE).toContain('fieldKind is "AXSecureTextField"')
  })

  it('refuses unless every read worked: the field kind starts out unreadable', () => {
    expect(KEYSTROKE_SOURCE).toContain('set fieldKind to "unreadable"')
    expect(KEYSTROKE_SOURCE).toContain('if fieldKind is "unreadable" then return "unreadable"')
    expect(KEYSTROKE_SOURCE).toContain('on error')
  })

  it('only reads in the focus query, which never types', () => {
    expect(FOCUS_QUERY).not.toContain('keystroke')
    expect(FOCUS_QUERY).toContain('unix id')
  })
})

describe('deliver', () => {
  it('types the words and reports the app', async () => {
    const { anywhere, mac } = makeAnywhere()
    const result = await anywhere.deliver(WAV)
    expect(result).toEqual({ ok: true, app: 'Notes', text: 'hello there', error: null })
    expect(mac.typingRuns()).toHaveLength(1)
    // The script gets the words, the app recorded at the start and Regatta's own process id.
    expect(mac.typingRuns()[0]).toEqual({ source: KEYSTROKE_SOURCE, args: ['hello there', 'Notes', OWN_PID] })
    expect(mac.focusQueries()).toBe(1)
  })

  it('reports hearing nothing when the transcript is empty', async () => {
    const { anywhere, mac, transcribe } = makeAnywhere()
    transcribe.mockResolvedValueOnce('   ')
    const result = await anywhere.deliver(WAV)
    expect(result.ok).toBe(false)
    expect(result.error).toBe('Heard nothing.')
    // Never asks macOS anything when there is nothing to type.
    expect(mac.calls).toHaveLength(0)
  })

  it('reports hearing nothing when the transcript is only characters that could act as keys', async () => {
    const { anywhere, mac, transcribe } = makeAnywhere()
    transcribe.mockResolvedValueOnce([ch(3), ch(0x19), ch(8), ch(0x7f), ch(0x1b), ch(0x85), ch(0x2028)].join(''))
    const result = await anywhere.deliver(WAV)
    expect(result).toEqual({ ok: false, app: null, text: '', error: 'Heard nothing.' })
    expect(mac.calls).toHaveLength(0)
  })

  it('reports the failure when transcribing fails', async () => {
    const { anywhere, mac, transcribe } = makeAnywhere()
    transcribe.mockRejectedValueOnce(new Error('whisper.cpp is not installed.'))
    const result = await anywhere.deliver(WAV)
    expect(result).toEqual({ ok: false, app: null, text: '', error: 'whisper.cpp is not installed.' })
    expect(mac.calls).toHaveLength(0)
  })

  it('never puts the words into the script, even when a quote lands on a chunk boundary', async () => {
    // 199 letters, then a quote at the 200 character boundary, then wording that would run a shell
    // command if it ever became part of a script.
    const attack = 'a'.repeat(199) + '" & do shell script "echo PWNED" & "' + ' -e tell app "Finder" to quit \\ ¬'
    const { anywhere, mac, transcribe } = makeAnywhere()
    transcribe.mockResolvedValueOnce(attack)
    const result = await anywhere.deliver(WAV)
    expect(result.ok).toBe(true)
    expect(mac.typingRuns().length).toBeGreaterThan(1)
    for (const call of mac.typingRuns()) {
      expect(call.source).toBe(KEYSTROKE_SOURCE)
      expect(call.args).toHaveLength(3)
      expect(call.args[1]).toBe('Notes')
      expect(call.args[2]).toBe(OWN_PID)
    }
    expect(mac.typed.join('')).toBe(attack)
  })

  it('keeps the recorded app name exactly as System Events gave it', async () => {
    const { anywhere, mac } = makeAnywhere({ front: frontReply('  Odd Name ', '77') })
    const result = await anywhere.deliver(WAV)
    expect(result.app).toBe('  Odd Name ')
    expect(mac.typingRuns()[0]?.args[1]).toBe('  Odd Name ')
  })
})

describe('deliver and characters that could act as keys', () => {
  it('types them as spaces: Enter, Back Tab, Backspace, Delete, Escape and a C1 control never reach keystroke', async () => {
    const said = ['ls', ch(3), '-la', ch(0x19), 'x', ch(8), ch(0x7f), ch(0x1b), ch(0x85), 'end', ch(0), ch(0x2028), ch(0xf700)].join('')
    const { anywhere, mac, transcribe } = makeAnywhere()
    transcribe.mockResolvedValueOnce(said)
    const result = await anywhere.deliver(WAV)
    const expected = keystrokeText(said)
    // One space for each of: Enter, Back Tab; Backspace, Delete, Escape, NEL (four in a row); NUL,
    // line separator, function key code (three at the end).
    expect(expected).toBe(['ls', ' ', '-la', ' ', 'x', '    ', 'end', '   '].join(''))
    expect(result).toEqual({ ok: true, app: 'Notes', text: expected, error: null })
    expect(mac.typed.join('')).toBe(expected)
    expectNothingKeyLikeWasSent(mac)
  })

  it('catches them on both sides of a chunk boundary', async () => {
    const said = 'a'.repeat(199) + ch(3) + ch(0x19) + 'b'.repeat(250) + ch(0x7f)
    const { anywhere, mac, transcribe } = makeAnywhere()
    transcribe.mockResolvedValueOnce(said)
    const result = await anywhere.deliver(WAV)
    expect(result.ok).toBe(true)
    expect(mac.typingRuns().length).toBeGreaterThan(2)
    expect(mac.typed.join('')).toBe('a'.repeat(199) + '  ' + 'b'.repeat(250) + ' ')
    expectNothingKeyLikeWasSent(mac)
  })

  it('does the same for every code in the C0, Delete and C1 ranges', async () => {
    const codes = [...range(0x00, 0x1f), ...range(0x7f, 0x9f)]
    const { anywhere, mac, transcribe } = makeAnywhere()
    transcribe.mockResolvedValueOnce(`start ${codes.map((code) => ch(code)).join('x')} end`)
    const result = await anywhere.deliver(WAV)
    expect(result.ok).toBe(true)
    expect(mac.typed.join('')).toBe(`start ${codes.map(() => ' ').join('x')} end`)
    expectNothingKeyLikeWasSent(mac)
  })
})

describe('deliver and a front app or field it must not type into', () => {
  for (const name of ['Regatta', 'regatta', 'REGATTA']) {
    it(`refuses when ${name} is in front and never runs the typing script`, async () => {
      const { anywhere, mac } = makeAnywhere({ front: frontReply(name, '111') })
      const result = await anywhere.deliver(WAV)
      expect(result).toEqual({ ok: false, app: name, text: '', error: 'Use the normal Dictation feature inside Regatta.' })
      expect(mac.typingRuns()).toHaveLength(0)
    })
  }

  it('refuses when this very process is in front, whatever its name (a development build is called Electron)', async () => {
    const { anywhere, mac } = makeAnywhere({ front: frontReply('Electron', OWN_PID) })
    const result = await anywhere.deliver(WAV)
    expect(result).toEqual({ ok: false, app: 'Electron', text: '', error: 'Use the normal Dictation feature inside Regatta.' })
    expect(mac.typingRuns()).toHaveLength(0)
  })

  it('refuses a password field and types nothing', async () => {
    const { anywhere, mac } = makeAnywhere({ front: frontReply('Safari'), typing: ['secure-field'] })
    const result = await anywhere.deliver(WAV)
    expect(result).toEqual({ ok: false, app: 'Safari', text: '', error: 'That is a password field, so nothing was typed.' })
    expect(mac.typed).toEqual([])
    expect(mac.typingRuns()).toHaveLength(1)
  })

  it('types nothing when the focused field or its subrole cannot be read (it fails closed)', async () => {
    const { anywhere, mac } = makeAnywhere({ typing: ['unreadable'] })
    const result = await anywhere.deliver(WAV)
    expect(result).toEqual({
      ok: false,
      app: 'Notes',
      text: '',
      error: 'Regatta could not check the field in front, so nothing was typed.'
    })
    expect(mac.typed).toEqual([])
  })

  it('types nothing when the app in front changed after it was recorded', async () => {
    const { anywhere, mac } = makeAnywhere({ typing: ['app-changed'] })
    const result = await anywhere.deliver(WAV)
    expect(result).toEqual({ ok: false, app: 'Notes', text: '', error: 'The app in front changed, so nothing was typed.' })
    expect(mac.typed).toEqual([])
  })

  it('types nothing when Regatta came to the front after the app was recorded', async () => {
    const { anywhere, mac } = makeAnywhere({ typing: ['regatta'] })
    const result = await anywhere.deliver(WAV)
    expect(result).toEqual({ ok: false, app: 'Notes', text: '', error: 'Use the normal Dictation feature inside Regatta.' })
    expect(mac.typed).toEqual([])
  })

  it('types nothing when the script cannot read the app in front', async () => {
    const { anywhere, mac } = makeAnywhere({ typing: ['no-app'] })
    const result = await anywhere.deliver(WAV)
    expect(result).toEqual({ ok: false, app: 'Notes', text: '', error: 'Regatta could not read the app in front.' })
    expect(mac.typed).toEqual([])
  })

  // The script must answer exactly "typed" (plus the newline osascript prints). Anything else, an
  // empty answer included, is a refusal, so a broken or unexpected script never types.
  for (const answer of ['', 'maybe', 'TYPED', 'typed!', 'ok', 'typed typed']) {
    it(`treats the answer ${JSON.stringify(answer)} as a refusal`, async () => {
      const { anywhere, mac } = makeAnywhere({ typing: [answer] })
      const result = await anywhere.deliver(WAV)
      expect(result).toEqual({
        ok: false,
        app: 'Notes',
        text: '',
        error: 'Regatta could not confirm it was safe to type, so nothing was typed.'
      })
      expect(mac.typed).toEqual([])
    })
  }

  it('types nothing and says so when osascript fails', async () => {
    const { anywhere, mac } = makeAnywhere({ typing: [new Error('osascript exited with 1')] })
    const result = await anywhere.deliver(WAV)
    expect(result).toEqual({ ok: false, app: 'Notes', text: '', error: 'Regatta could not type into the app in front.' })
    expect(mac.typed).toEqual([])
  })

  it('types nothing when the app in front cannot be read', async () => {
    const { anywhere, mac } = makeAnywhere({ front: new Error('osascript exited with 1') })
    const result = await anywhere.deliver(WAV)
    expect(result).toEqual({ ok: false, app: null, text: '', error: 'Regatta could not read the app in front.' })
    expect(mac.typingRuns()).toHaveLength(0)
  })

  // A reply without an app name, without a tab, or without a numeric process id is not a record of
  // the app in front, so there is nothing to compare later and nothing is typed.
  for (const reply of ['', '\n', 'Notes\n', 'Notes\tabc\n', '\t4242\n', 'Notes\t\n', 'Notes\t12 34\n', '   \t4242\n']) {
    it(`types nothing for the unusable focus reply ${JSON.stringify(reply)}`, async () => {
      const { anywhere, mac } = makeAnywhere({ front: reply })
      const result = await anywhere.deliver(WAV)
      expect(result).toEqual({ ok: false, app: null, text: '', error: 'Regatta could not read the app in front.' })
      expect(mac.typingRuns()).toHaveLength(0)
    })
  }
})

describe('deliver in three chunks', () => {
  const A = 'a'.repeat(200)
  const B = 'b'.repeat(200)
  const C = 'c'.repeat(50)
  const THREE = A + B + C

  it('types all three chunks, and the script checks the app and the field before each one', async () => {
    const { anywhere, mac, transcribe } = makeAnywhere()
    transcribe.mockResolvedValueOnce(THREE)
    const result = await anywhere.deliver(WAV)
    expect(result).toEqual({ ok: true, app: 'Notes', text: THREE, error: null })
    expect(mac.typed).toEqual([A, B, C])
    expect(mac.typingRuns().map((run) => run.args)).toEqual([
      [A, 'Notes', OWN_PID],
      [B, 'Notes', OWN_PID],
      [C, 'Notes', OWN_PID]
    ])
    // The app is recorded once, at the start; the script re-checks it against that name every time.
    expect(mac.focusQueries()).toBe(1)
  })

  // Before chunk 2 something changes. Only chunk 1 is typed and chunk 3 is never even offered.
  const CHANGES: Array<{ what: string; answer: string; error: string }> = [
    { what: 'the app in front changes', answer: 'app-changed', error: 'The app in front changed. The rest was not typed.' },
    {
      what: 'the focus moves to a password field',
      answer: 'secure-field',
      error: 'A password field took the focus. The rest was not typed.'
    },
    { what: 'Regatta comes to the front', answer: 'regatta', error: 'Regatta came to the front. The rest was not typed.' },
    {
      what: 'the field can no longer be read',
      answer: 'unreadable',
      error: 'Regatta could not check the field in front. The rest was not typed.'
    },
    {
      what: 'the app in front can no longer be read',
      answer: 'no-app',
      error: 'Regatta could not read the app in front. The rest was not typed.'
    },
    {
      what: 'the script gives an answer nobody expects',
      answer: 'surprise',
      error: 'Regatta could not confirm it was safe to type. The rest was not typed.'
    },
    {
      what: 'the script gives an empty answer',
      answer: '',
      error: 'Regatta could not confirm it was safe to type. The rest was not typed.'
    }
  ]
  for (const { what, answer, error } of CHANGES) {
    it(`stops after chunk 1 when ${what} before chunk 2`, async () => {
      const { anywhere, mac, transcribe } = makeAnywhere({ typing: [TYPED, answer] })
      transcribe.mockResolvedValueOnce(THREE)
      const result = await anywhere.deliver(WAV)
      expect(result).toEqual({ ok: false, app: 'Notes', text: A, error })
      expect(mac.typed).toEqual([A])
      expect(mac.typingRuns()).toHaveLength(2)
    })
  }

  it('stops after chunk 2 when chunk 3 is refused', async () => {
    const { anywhere, mac, transcribe } = makeAnywhere({ typing: [TYPED, TYPED, 'secure-field'] })
    transcribe.mockResolvedValueOnce(THREE)
    const result = await anywhere.deliver(WAV)
    expect(result).toEqual({
      ok: false,
      app: 'Notes',
      text: A + B,
      error: 'A password field took the focus. The rest was not typed.'
    })
    expect(mac.typed).toEqual([A, B])
  })

  it('stops, and says how far it got, when osascript fails on chunk 2', async () => {
    const { anywhere, mac, transcribe } = makeAnywhere({ typing: [TYPED, new Error('osascript exited with 1')] })
    transcribe.mockResolvedValueOnce(THREE)
    const result = await anywhere.deliver(WAV)
    expect(result).toEqual({
      ok: false,
      app: 'Notes',
      text: A,
      error: 'Regatta could not type into the app in front. The rest was not typed.'
    })
    expect(mac.typed).toEqual([A])
    expect(mac.typingRuns()).toHaveLength(2)
  })

  it('does not ask the field again after the first refusal', async () => {
    const { anywhere, mac, transcribe } = makeAnywhere({ typing: ['secure-field'] })
    transcribe.mockResolvedValueOnce(THREE)
    await anywhere.deliver(WAV)
    expect(mac.typingRuns()).toHaveLength(1)
  })
})

describe('cancelling a delivery', () => {
  const CANCELLED_NOTHING = 'Cancelled: Dictate anywhere was turned off, so nothing was typed.'
  const CANCELLED_REST = 'Cancelled: Dictate anywhere was turned off. The rest was not typed.'
  const off = prefsWithAnywhere(false)
  const on = prefsWithAnywhere(true)

  it('types nothing when Labs is turned off while the words are still being transcribed', async () => {
    const { anywhere, mac, transcribe } = makeAnywhere()
    const heard = deferred<string>()
    transcribe.mockImplementationOnce(() => heard.promise)
    const pending = anywhere.deliver(WAV)
    anywhere.apply(off)
    heard.resolve('hello there')
    const result = await pending
    expect(result).toEqual({ ok: false, app: null, text: '', error: CANCELLED_NOTHING })
    // It did not even ask which app was in front.
    expect(mac.calls).toHaveLength(0)
  })

  it('types nothing when Anywhere is disposed while the words are still being transcribed', async () => {
    const { anywhere, mac, transcribe } = makeAnywhere()
    const heard = deferred<string>()
    transcribe.mockImplementationOnce(() => heard.promise)
    const pending = anywhere.deliver(WAV)
    anywhere.dispose()
    heard.resolve('hello there')
    const result = await pending
    expect(result).toEqual({ ok: false, app: null, text: '', error: CANCELLED_NOTHING })
    expect(mac.calls).toHaveLength(0)
  })

  it('reports the cancellation, not the transcription failure, when Labs went off first', async () => {
    const { anywhere, mac, transcribe } = makeAnywhere()
    const heard = deferred<string>()
    transcribe.mockImplementationOnce(() => heard.promise)
    const pending = anywhere.deliver(WAV)
    anywhere.apply(off)
    heard.reject(new Error('Transcription failed. Try again.'))
    const result = await pending
    expect(result.error).toBe(CANCELLED_NOTHING)
    expect(mac.calls).toHaveLength(0)
  })

  it('types nothing when Labs is turned off while the app in front is being read', async () => {
    let ref!: Anywhere
    const made1 = makeAnywhere({
      front: () => {
        ref.apply(off)
        return frontReply('Notes')
      }
    })
    ref = made1.anywhere
    const result = await made1.anywhere.deliver(WAV)
    expect(result).toEqual({ ok: false, app: 'Notes', text: '', error: CANCELLED_NOTHING })
    expect(made1.mac.focusQueries()).toBe(1)
    expect(made1.mac.typingRuns()).toHaveLength(0)
  })

  it('reports the cancellation, not a refusal, when Labs went off while Regatta was found in front', async () => {
    let ref!: Anywhere
    const made1 = makeAnywhere({
      front: () => {
        ref.apply(off)
        return frontReply('Regatta')
      }
    })
    ref = made1.anywhere
    const result = await made1.anywhere.deliver(WAV)
    expect(result).toEqual({ ok: false, app: 'Regatta', text: '', error: CANCELLED_NOTHING })
    expect(made1.mac.typingRuns()).toHaveLength(0)
  })

  it('reports the cancellation, not a read failure, when Labs went off while the app in front could not be read', async () => {
    let ref!: Anywhere
    const made1 = makeAnywhere({
      front: () => {
        ref.apply(off)
        return 'no tab in this reply'
      }
    })
    ref = made1.anywhere
    const result = await made1.anywhere.deliver(WAV)
    expect(result).toEqual({ ok: false, app: null, text: '', error: CANCELLED_NOTHING })
    expect(made1.mac.typingRuns()).toHaveLength(0)
  })

  it('stops between chunks when Labs is turned off', async () => {
    let ref!: Anywhere
    const made1 = makeAnywhere({
      typing: [
        () => {
          ref.apply(off)
          return TYPED
        }
      ]
    })
    ref = made1.anywhere
    const said = 'a'.repeat(200) + 'b'.repeat(100)
    made1.transcribe.mockResolvedValueOnce(said)
    const result = await made1.anywhere.deliver(WAV)
    expect(result).toEqual({ ok: false, app: 'Notes', text: 'a'.repeat(200), error: CANCELLED_REST })
    expect(made1.mac.typed).toEqual(['a'.repeat(200)])
    expect(made1.mac.typingRuns()).toHaveLength(1)
  })

  it('stops between chunks when Anywhere is disposed during delivery', async () => {
    let ref!: Anywhere
    const made1 = makeAnywhere({
      typing: [
        () => {
          ref.dispose()
          return TYPED
        }
      ]
    })
    ref = made1.anywhere
    made1.transcribe.mockResolvedValueOnce('a'.repeat(200) + 'b'.repeat(100) + 'c'.repeat(100))
    const result = await made1.anywhere.deliver(WAV)
    expect(result).toEqual({ ok: false, app: 'Notes', text: 'a'.repeat(200), error: CANCELLED_REST })
    expect(made1.mac.typed).toEqual(['a'.repeat(200)])
    expect(made1.mac.typingRuns()).toHaveLength(1)
  })

  it('reports success when the last chunk was already typed before Labs went off', async () => {
    let ref!: Anywhere
    const made1 = makeAnywhere({
      typing: [
        () => {
          ref.dispose()
          return TYPED
        }
      ]
    })
    ref = made1.anywhere
    const result = await made1.anywhere.deliver(WAV)
    expect(result).toEqual({ ok: true, app: 'Notes', text: 'hello there', error: null })
    expect(made1.mac.typed).toEqual(['hello there'])
  })

  it('schedules no hide timer when Anywhere was disposed during the last chunk', async () => {
    const timers = vi.spyOn(globalThis, 'setTimeout')
    try {
      let ref!: Anywhere
      const made1 = makeAnywhere({
        typing: [
          () => {
            ref.dispose()
            return TYPED
          }
        ]
      })
      ref = made1.anywhere
      const result = await made1.anywhere.deliver(WAV)
      expect(result.ok).toBe(true)
      expect((timers.mock.calls as unknown[][]).filter((call) => call[1] === 2500)).toHaveLength(0)
    } finally {
      timers.mockRestore()
    }
  })

  it('does not disturb a newer session when the delivery of an older one finishes late', async () => {
    let ref!: Anywhere
    const made1 = makeAnywhere({
      typing: [
        async () => {
          // While this chunk is being typed, Labs goes off and on again and a new press starts listening.
          ref.apply(off)
          ref.apply(on)
          pressShortcut()
          await settle()
          onlyPill().emitReady()
          await settle()
          return TYPED
        }
      ]
    })
    ref = made1.anywhere
    const result = await made1.anywhere.deliver(WAV)
    // The only chunk was typed, so the old delivery really did succeed.
    expect(result.ok).toBe(true)
    const pill = onlyPill()
    expect(pill.sent).toEqual([START_MESSAGE])
    // The newer session is still listening: its Escape key was not released by the old delivery ...
    expect(mocks.unregister).not.toHaveBeenCalledWith('Escape')
    // ... and the next press stops it, where a reset session would start a new recording instead.
    pressShortcut()
    await settle()
    expect(pill.sent).toEqual([START_MESSAGE, { channel: 'anywhere:toggle', payload: { action: 'stop' } }])
  })

  it('does nothing at all when Anywhere was already disposed', async () => {
    const { anywhere, mac, transcribe } = makeAnywhere()
    anywhere.dispose()
    const result = await anywhere.deliver(WAV)
    expect(result).toEqual({ ok: false, app: null, text: '', error: CANCELLED_NOTHING })
    expect(transcribe).not.toHaveBeenCalled()
    expect(mac.calls).toHaveLength(0)
  })

  it('does nothing at all while Labs is off', async () => {
    const { anywhere, mac, transcribe } = makeAnywhere({ enabled: false })
    const result = await anywhere.deliver(WAV)
    expect(result).toEqual({ ok: false, app: null, text: '', error: CANCELLED_NOTHING })
    expect(transcribe).not.toHaveBeenCalled()
    expect(mac.calls).toHaveLength(0)
  })

  it('is not cancelled by a prefs change that leaves Labs on', async () => {
    const { anywhere, mac, transcribe } = makeAnywhere()
    const heard = deferred<string>()
    transcribe.mockImplementationOnce(() => heard.promise)
    const pending = anywhere.deliver(WAV)
    // Main calls apply() on every prefs change, for example a new theme.
    anywhere.apply(on)
    heard.resolve('hello there')
    const result = await pending
    expect(result).toEqual({ ok: true, app: 'Notes', text: 'hello there', error: null })
    expect(mac.typed).toEqual(['hello there'])
  })

  it('stays cancelled when Labs is turned off and straight back on', async () => {
    const { anywhere, mac, transcribe } = makeAnywhere()
    const heard = deferred<string>()
    transcribe.mockImplementationOnce(() => heard.promise)
    const pending = anywhere.deliver(WAV)
    anywhere.apply(off)
    anywhere.apply(on)
    heard.resolve('hello there')
    const result = await pending
    expect(result.error).toBe(CANCELLED_NOTHING)
    expect(mac.calls).toHaveLength(0)
    // The new session is untouched, and a fresh delivery works.
    expect(anywhere.status().enabled).toBe(true)
    const again = await anywhere.deliver(WAV)
    expect(again.ok).toBe(true)
  })

  it('leaves no hide timer behind when it is cancelled, but a finished delivery does schedule one', async () => {
    const timers = vi.spyOn(globalThis, 'setTimeout')
    const hideTimers = (): number => (timers.mock.calls as unknown[][]).filter((call) => call[1] === 2500).length
    try {
      const cancelled = makeAnywhere()
      const heard = deferred<string>()
      cancelled.transcribe.mockImplementationOnce(() => heard.promise)
      const pending = cancelled.anywhere.deliver(WAV)
      cancelled.anywhere.dispose()
      heard.resolve('hello there')
      await pending
      expect(hideTimers()).toBe(0)

      const finished = makeAnywhere()
      await finished.anywhere.deliver(WAV)
      expect(hideTimers()).toBe(1)
    } finally {
      timers.mockRestore()
    }
  })
})

describe('a shortcut press that is still starting', () => {
  const off = prefsWithAnywhere(false)
  const on = prefsWithAnywhere(true)

  const escapeRegistered = (): boolean => mocks.register.mock.calls.some(([accelerator]) => accelerator === 'Escape')

  it('shows the pill and starts listening when nothing is turned off', async () => {
    makeAnywhere()
    pressShortcut()
    await settle()
    const pill = onlyPill()
    pill.emitReady()
    await settle()
    expect(pill.shown).toBe(1)
    expect(pill.sent).toEqual([START_MESSAGE])
    expect(escapeRegistered()).toBe(true)
  })

  it('creates no pill when Labs is turned off while the dictation status is pending', async () => {
    const { anywhere, status } = makeAnywhere()
    const gate = deferred<{ engine: string; model: string }>()
    status.mockImplementationOnce(() => gate.promise)
    pressShortcut()
    await settle()
    anywhere.apply(off)
    gate.resolve({ engine: '/usr/bin/whisper-cli', model: 'base.en' })
    await settle()
    expect(mocks.FakeWindow.all).toHaveLength(0)
    expect(escapeRegistered()).toBe(false)
  })

  it('creates no pill when Anywhere is disposed while the dictation status is pending', async () => {
    const { anywhere, status } = makeAnywhere()
    const gate = deferred<{ engine: string; model: string }>()
    status.mockImplementationOnce(() => gate.promise)
    pressShortcut()
    await settle()
    anywhere.dispose()
    gate.resolve({ engine: '/usr/bin/whisper-cli', model: 'base.en' })
    await settle()
    expect(mocks.FakeWindow.all).toHaveLength(0)
    expect(escapeRegistered()).toBe(false)
  })

  it('shows nothing and starts nothing when Labs is turned off while the pill is loading', async () => {
    const { anywhere } = makeAnywhere()
    pressShortcut()
    await settle()
    const pill = onlyPill()
    anywhere.apply(off)
    await settle()
    expect(pill.destroyed).toBe(true)
    pill.emitReady()
    await settle()
    expect(pill.shown).toBe(0)
    expect(pill.sent).toEqual([])
    expect(escapeRegistered()).toBe(false)
  })

  it('shows nothing and starts nothing when Anywhere is disposed while the pill is loading', async () => {
    const { anywhere } = makeAnywhere()
    pressShortcut()
    await settle()
    const pill = onlyPill()
    anywhere.dispose()
    await settle()
    pill.emitReady()
    await settle()
    expect(pill.shown).toBe(0)
    expect(pill.sent).toEqual([])
    expect(escapeRegistered()).toBe(false)
  })

  it('does not wake a stale press when a later pill becomes ready', async () => {
    const { anywhere } = makeAnywhere()
    pressShortcut()
    await settle()
    const stalePill = onlyPill()
    anywhere.apply(off)
    anywhere.apply(on)
    await settle()
    // A fresh press makes a fresh pill. Only that press may start it, exactly once.
    pressShortcut()
    await settle()
    expect(mocks.FakeWindow.all).toHaveLength(2)
    const freshPill = mocks.FakeWindow.all[1]
    if (!freshPill) throw new Error('no second pill')
    stalePill.emitReady()
    freshPill.emitReady()
    await settle()
    expect(stalePill.shown).toBe(0)
    expect(stalePill.sent).toEqual([])
    expect(freshPill.shown).toBe(1)
    expect(freshPill.sent).toEqual([START_MESSAGE])
  })

  it('does not show the permission pill when Labs is turned off while it loads', async () => {
    mocks.isTrusted.mockReturnValue(false)
    const { anywhere } = makeAnywhere()
    pressShortcut()
    await settle()
    const pill = onlyPill()
    anywhere.apply(off)
    await settle()
    pill.emitReady()
    await settle()
    expect(pill.shown).toBe(0)
  })
})

describe('apply and status', () => {
  it('registers the shortcut when Labs is on', () => {
    const { anywhere } = makeAnywhere({ enabled: false })
    anywhere.apply(prefsWithAnywhere(true))
    expect(mocks.register).toHaveBeenCalledWith(ANYWHERE_SHORTCUT, expect.any(Function))
    expect(anywhere.status().enabled).toBe(true)
    expect(anywhere.status().error).toBeNull()
  })

  it('unregisters the shortcut and closes the pill when Labs is off', () => {
    const { anywhere } = makeAnywhere({ enabled: false })
    anywhere.apply(prefsWithAnywhere(true))
    mocks.register.mockClear()
    anywhere.apply(prefsWithAnywhere(false))
    expect(mocks.unregister).toHaveBeenCalledWith(ANYWHERE_SHORTCUT)
    expect(anywhere.status().enabled).toBe(false)
  })

  it('records an error when the shortcut is taken', () => {
    mocks.register.mockReturnValue(false)
    const { anywhere } = makeAnywhere({ enabled: false })
    anywhere.apply(prefsWithAnywhere(true))
    expect(anywhere.status().enabled).toBe(false)
    expect(anywhere.status().error).toBe('Option+Shift+Command+Space is taken by another app.')
  })

  it('registers the shortcut once however often prefs change while Labs stays on', () => {
    const { anywhere } = makeAnywhere({ enabled: false })
    anywhere.apply(prefsWithAnywhere(true))
    anywhere.apply(prefsWithAnywhere(true))
    anywhere.apply(prefsWithAnywhere(true))
    expect(mocks.register).toHaveBeenCalledTimes(1)
  })

  it('does not register the shortcut again once it has been disposed', () => {
    const { anywhere } = makeAnywhere({ enabled: false })
    anywhere.dispose()
    anywhere.apply(prefsWithAnywhere(true))
    expect(mocks.register).not.toHaveBeenCalled()
    expect(anywhere.status().enabled).toBe(false)
  })
})

describe('openAccessibility', () => {
  it('opens the Accessibility privacy pane', () => {
    const { anywhere } = makeAnywhere({ enabled: false })
    anywhere.openAccessibility()
    expect(mocks.openExternal).toHaveBeenCalledWith(
      'x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility'
    )
  })
})
