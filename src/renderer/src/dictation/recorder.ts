// Records the microphone into 16 kHz mono 16-bit PCM WAV bytes.
// Audio lives only in memory until it is sent to main for transcription.

export interface ActiveRecording {
  /** Stops the microphone, closes the audio graph and returns the WAV bytes. */
  stop: () => Promise<Uint8Array>
  /** Stops the microphone and closes the audio graph without returning audio. */
  cancel: () => void
}

/**
 * Starts recording. Resolves once the microphone is open; the caller owns the
 * recording and must call stop or cancel exactly once (calling either twice is safe).
 * Always stops the tracks and closes the context, whatever happens.
 */
export async function recordAudio(onLevel: (level: number) => void): Promise<ActiveRecording> {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true }
  })
  const teardownStream = (): void => {
    for (const track of stream.getTracks()) track.stop()
  }
  if (!window.AudioContext) {
    teardownStream()
    throw new Error('This computer cannot record audio in Regatta.')
  }
  const ctx = new window.AudioContext({ sampleRate: 16000 })
  try {
    if (ctx.state === 'suspended') await ctx.resume()
  } catch {
    // Recording still works while suspended on some systems; keep going.
  }
  const sampleRate = ctx.sampleRate
  const source = ctx.createMediaStreamSource(stream)
  const analyser = ctx.createAnalyser()
  analyser.fftSize = 512
  source.connect(analyser)
  const processor = ctx.createScriptProcessor(4096, 1, 1)
  const chunks: Float32Array[] = []
  processor.onaudioprocess = (e: AudioProcessingEvent) => {
    chunks.push(new Float32Array(e.inputBuffer.getChannelData(0)))
  }
  source.connect(processor)
  processor.connect(ctx.destination)
  const meter = window.setInterval(() => {
    const data = new Uint8Array(analyser.fftSize)
    analyser.getByteTimeDomainData(data)
    let sum = 0
    for (const value of data) {
      const centered = (value - 128) / 128
      sum += centered * centered
    }
    onLevel(Math.min(1, Math.sqrt(sum / data.length) * 3))
  }, 120)

  let done = false
  const teardown = (): void => {
    window.clearInterval(meter)
    try {
      processor.disconnect()
    } catch {
      // Already disconnected.
    }
    try {
      source.disconnect()
    } catch {
      // Already disconnected.
    }
    teardownStream()
    if (ctx.state !== 'closed') void ctx.close().catch(() => undefined)
  }

  return {
    stop: async () => {
      if (done) return encodeWav(new Float32Array(0), sampleRate)
      done = true
      teardown()
      const total = chunks.reduce((n, c) => n + c.length, 0)
      const samples = new Float32Array(total)
      let at = 0
      for (const c of chunks) {
        samples.set(c, at)
        at += c.length
      }
      return encodeWav(samples, sampleRate)
    },
    cancel: () => {
      if (done) return
      done = true
      teardown()
    }
  }
}

/** Encodes float samples as a 16-bit PCM WAV file. Exported for tests and reuse. */
export function encodeWav(samples: Float32Array, sampleRate: number): Uint8Array {
  const bytes = new Uint8Array(44 + samples.length * 2)
  const view = new DataView(bytes.buffer)
  writeText(view, 0, 'RIFF')
  view.setUint32(4, 36 + samples.length * 2, true)
  writeText(view, 8, 'WAVE')
  writeText(view, 12, 'fmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true)
  view.setUint16(22, 1, true)
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, sampleRate * 2, true)
  view.setUint16(32, 2, true)
  view.setUint16(34, 16, true)
  writeText(view, 36, 'data')
  view.setUint32(40, samples.length * 2, true)
  for (let i = 0; i < samples.length; i += 1) {
    const clamped = Math.max(-1, Math.min(1, samples[i] ?? 0))
    view.setInt16(44 + i * 2, clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff, true)
  }
  return bytes
}

function writeText(view: DataView, at: number, text: string): void {
  for (let i = 0; i < text.length; i += 1) view.setUint8(at + i, text.charCodeAt(i))
}
