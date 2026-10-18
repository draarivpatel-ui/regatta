// The microphone-open time limit in the dictation controller. getUserMedia is stubbed two ways with
// fake timers: one that never answers (so the 5 second limit fires and the pill offers a Retry) and
// one that answers too late to be used (so the recording is released, not left running).

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// The behavior of the fake microphone for the test in progress, swapped per case.
let openMicrophone: () => Promise<unknown>

function fakeTrack(stopped: { value: boolean }): { stop: () => void } {
  return {
    stop: () => {
      stopped.value = true
    }
  }
}

/** A media stream plus an AudioContext just complete enough for recordAudio to build a graph and resolve. */
function makeLateMic(stopped: { value: boolean }): { resolve: () => void; audioContext: unknown } {
  const stream = { getTracks: () => [fakeTrack(stopped)] }
  let opened = false
  const waiters: Array<() => void> = []
  openMicrophone = () =>
    new Promise((done) => {
      if (opened) done(stream)
      else waiters.push(() => done(stream))
    })
  const node = { connect: () => {}, disconnect: () => {} }
  const analyser = { fftSize: 512, connect: () => {}, disconnect: () => {}, getByteTimeDomainData: (arr: Uint8Array) => arr.fill(128) }
  const processor = { connect: () => {}, disconnect: () => {}, onaudioprocess: null as unknown }
  class FakeAudioContext {
    state = 'running'
    sampleRate = 16000
    destination = {}
    createMediaStreamSource = () => node
    createAnalyser = () => analyser
    createScriptProcessor = () => processor
    close = () => Promise.resolve()
  }
  const resolve = (): void => {
    opened = true
    for (const wake of waiters) wake()
    waiters.length = 0
  }
  return { resolve, audioContext: FakeAudioContext }
}

async function world() {
  vi.resetModules()
  const invoke = vi.fn(async (channel: string) => {
    if (channel === 'dictation:status') return { engine: '/bin/whisper-cli', model: 'base.en' }
    if (channel === 'dictation:microphone') return 'granted'
    return undefined
  })
  const bridge = { invoke, send: vi.fn(), on: () => () => undefined, platform: 'darwin' }
  const win = {
    regatta: bridge,
    setTimeout: (fn: () => void, ms: number) => setTimeout(fn, ms),
    clearTimeout: (id: number) => clearTimeout(id),
    setInterval: (fn: () => void, ms: number) => setInterval(fn, ms),
    clearInterval: (id: number) => clearInterval(id),
    addEventListener: () => {},
    removeEventListener: () => {},
    AudioContext: undefined as unknown
  }
  vi.stubGlobal('window', win)
  vi.stubGlobal('document', { activeElement: null, querySelector: () => null })
  vi.stubGlobal('navigator', {
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    mediaDevices: { getUserMedia: () => openMicrophone() }
  })
  const controller = await import('./controller')
  const { useDictation } = await import('./store')
  return { controller, useDictation, win, bridge, invoke }
}

beforeEach(() => {
  vi.useFakeTimers()
  // Default fake microphone: it never answers, which is the bug this limit guards against.
  openMicrophone = () => new Promise(() => {})
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('the microphone-open time limit', () => {
  it('stops waiting after five seconds and shows the timeout error with a retry', async () => {
    const { controller, useDictation } = await world()
    controller.toggleDictation()
    // Nothing has answered yet, so we are still waiting for the microphone.
    await vi.advanceTimersByTimeAsync(controller.MIC_OPEN_TIMEOUT_MS - 1)
    expect(useDictation.getState().phase).toBe('idle')
    // One millisecond later the limit is reached.
    await vi.advanceTimersByTimeAsync(1)
    const state = useDictation.getState()
    expect(state.phase).toBe('error')
    expect(state.message).toBe('The microphone did not open.')
    expect(state.retry).toBe(true)
  }, 20000)

  it('releases a microphone that opens after the limit instead of leaving it running', async () => {
    const stopped = { value: false }
    const late = makeLateMic(stopped)
    const { controller, useDictation, win } = await world()
    win.AudioContext = late.audioContext
    controller.toggleDictation()
    // Let the limit fire first, then have the microphone answer far too late.
    await vi.advanceTimersByTimeAsync(controller.MIC_OPEN_TIMEOUT_MS)
    expect(useDictation.getState().message).toBe('The microphone did not open.')
    late.resolve()
    await vi.advanceTimersByTimeAsync(0)
    // The late recording was opened and immediately closed again: its track was stopped.
    expect(stopped.value).toBe(true)
    // And the error is still what the user sees, unchanged by the late arrival.
    expect(useDictation.getState().phase).toBe('error')
    expect(useDictation.getState().retry).toBe(true)
  }, 20000)

  it('retry clears the error and waits for the microphone again', async () => {
    const { controller, useDictation } = await world()
    controller.toggleDictation()
    await vi.advanceTimersByTimeAsync(controller.MIC_OPEN_TIMEOUT_MS)
    expect(useDictation.getState().phase).toBe('error')
    controller.retryDictation()
    // The error goes away right away, back to waiting for a microphone.
    expect(useDictation.getState().phase).toBe('idle')
    expect(useDictation.getState().message).toBe('')
    // The microphone still never answers, so the limit fires again.
    await vi.advanceTimersByTimeAsync(controller.MIC_OPEN_TIMEOUT_MS)
    expect(useDictation.getState().phase).toBe('error')
    expect(useDictation.getState().retry).toBe(true)
  }, 20000)

  it('a microphone that opens in time is not cut short by the limit', async () => {
    const stopped = { value: false }
    const late = makeLateMic(stopped)
    const { controller, useDictation, win } = await world()
    win.AudioContext = late.audioContext
    controller.toggleDictation()
    // Answer before the limit, then run the remaining time: the wait must not turn into an error.
    late.resolve()
    await vi.advanceTimersByTimeAsync(10)
    expect(useDictation.getState().phase).toBe('listening')
    await vi.advanceTimersByTimeAsync(controller.MIC_OPEN_TIMEOUT_MS)
    expect(useDictation.getState().phase).toBe('listening')
    expect(useDictation.getState().retry).toBe(false)
  }, 20000)
})
