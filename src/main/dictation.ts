// Turns recorded speech into text with whisper.cpp, and keeps its models.
//. Audio is written to a temp file only for the moment it takes to read it.

import { execFile as execFileCb } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import {
  createWriteStream,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { DictationModel, DictationModelId, DictationStatus } from '../shared/dictation'
import { findOnPath } from './env'

const MODEL_DEFS: Array<{ id: DictationModelId; name: string; sizeMiB: number; languages: string }> = [
  { id: 'base.en', name: 'Base, English', sizeMiB: 142, languages: 'English' },
  { id: 'large-v3-turbo-q5_0', name: 'Turbo', sizeMiB: 547, languages: 'Many languages' }
]

const DEFAULT_MODEL_URL = 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main'
const MIN_MODEL_BYTES = 10 * 1024 * 1024
const MAX_AUDIO_BYTES = 4 * 1024 * 1024
const TRANSCRIBE_TIMEOUT_MS = 60_000
const PROGRESS_EMIT_MS = 250

export interface DictationDeps {
  /** App data folder: models in <dataDir>/models/, the chosen model in <dataDir>/dictation.json. */
  dataDir: string
  env: () => Record<string, string>
  emit: (status: DictationStatus) => void
}

interface ActiveDownload {
  id: DictationModelId
  controller: AbortController
  part: string
  cancelled: boolean
}

/** Removes whisper's bracketed non-speech tags and joins lines into one trimmed line. */
export function cleanTranscript(raw: string): string {
  const joined = raw
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .join(' ')
  return joined
    .replace(/\[[^\]]*\]|\([^)]*\)/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

function isKnownModel(id: string): id is DictationModelId {
  return MODEL_DEFS.some((m) => m.id === id)
}

export class Dictation {
  private downloadState: DictationStatus['download'] = null
  private active: ActiveDownload | null = null
  private lastError: string | null = null

  constructor(private readonly deps: DictationDeps) {}

  private modelsDir(): string {
    return join(this.deps.dataDir, 'models')
  }

  private enginePath(): string | null {
    const env = this.deps.env()
    const override = (env['REGATTA_WHISPER_CLI'] ?? '').trim()
    if (override.length > 0) return override
    return findOnPath('whisper-cli', env)
  }

  private modelUrl(id: DictationModelId): string {
    const base = (this.deps.env()['REGATTA_WHISPER_MODEL_URL'] ?? DEFAULT_MODEL_URL).replace(/\/+$/, '')
    return `${base}/ggml-${id}.bin`
  }

  private readChosen(): DictationModelId | null {
    try {
      const parsed = JSON.parse(readFileSync(join(this.deps.dataDir, 'dictation.json'), 'utf8')) as {
        model?: unknown
      }
      return typeof parsed.model === 'string' && isKnownModel(parsed.model) ? parsed.model : null
    } catch {
      return null
    }
  }

  private snapshot(): DictationStatus {
    const models: DictationModel[] = MODEL_DEFS.map((m) => ({
      ...m,
      installed: existsSync(join(this.modelsDir(), `ggml-${m.id}.bin`))
    }))
    const installed = models.filter((m) => m.installed).map((m) => m.id)
    const chosen = this.readChosen()
    const model = (chosen && installed.includes(chosen) ? chosen : installed[0]) ?? null
    return { engine: this.enginePath(), models, model, download: this.downloadState, error: this.lastError }
  }

  private emitSnapshot(): void {
    this.deps.emit(this.snapshot())
  }

  async status(): Promise<DictationStatus> {
    return this.snapshot()
  }

  async download(id: DictationModelId): Promise<DictationStatus> {
    if (!isKnownModel(id)) throw new Error(`Unknown dictation model: ${id}`)
    if (this.active) throw new Error('A download is already in progress.')
    mkdirSync(this.modelsDir(), { recursive: true })
    const part = join(this.modelsDir(), `ggml-${id}.bin.part`)
    const final = join(this.modelsDir(), `ggml-${id}.bin`)
    rmSync(part, { force: true })
    const controller = new AbortController()
    this.active = { id, controller, part, cancelled: false }
    this.lastError = null
    this.downloadState = { id, received: 0, total: 0 }
    this.emitSnapshot()
    try {
      await this.fetchToFile(this.modelUrl(id), part, controller.signal, (received, total) => {
        this.downloadState = { id, received, total }
        this.emitSnapshot()
      })
      if (statSync(part).size < MIN_MODEL_BYTES) {
        rmSync(part, { force: true })
        this.lastError = 'That download was too small to be a model. Try again.'
      } else {
        renameSync(part, final)
        this.lastError = null
      }
    } catch (err) {
      rmSync(part, { force: true })
      if (this.active.cancelled) this.lastError = 'The download was cancelled.'
      else this.lastError = err instanceof Error ? err.message : 'The download failed. Try again.'
    }
    this.active = null
    this.downloadState = null
    this.emitSnapshot()
    return this.snapshot()
  }

  cancelDownload(): void {
    const current = this.active
    if (!current) return
    current.cancelled = true
    current.controller.abort()
  }

  async setModel(id: DictationModelId): Promise<DictationStatus> {
    if (!isKnownModel(id)) throw new Error(`Unknown dictation model: ${id}`)
    if (!existsSync(join(this.modelsDir(), `ggml-${id}.bin`))) {
      throw new Error('That model is not installed yet. Download it first.')
    }
    mkdirSync(this.deps.dataDir, { recursive: true })
    writeFileSync(join(this.deps.dataDir, 'dictation.json'), JSON.stringify({ model: id }, null, 2))
    this.emitSnapshot()
    return this.snapshot()
  }

  /** `wav` is 16 kHz mono 16-bit PCM WAV. Returns the words, trimmed. */
  async transcribe(wav: Uint8Array): Promise<string> {
    if (wav.byteLength === 0) throw new Error('No audio was recorded. Try again.')
    if (wav.byteLength > MAX_AUDIO_BYTES) throw new Error('That recording is too long. Keep recordings under 2 minutes.')
    const engine = this.enginePath()
    if (!engine) throw new Error('whisper.cpp is not installed. Install it with: brew install whisper-cpp')
    const snapshot = this.snapshot()
    const model = snapshot.model
    if (!model || !existsSync(join(this.modelsDir(), `ggml-${model}.bin`))) {
      throw new Error('No dictation model is installed. Download one in Settings, Dictation.')
    }
    const modelPath = join(this.modelsDir(), `ggml-${model}.bin`)
    const wavPath = join(tmpdir(), `regatta-dictation-${randomUUID()}.wav`)
    writeFileSync(wavPath, Buffer.from(wav))
    try {
      const env = this.deps.env()
      const configured = Number(env['REGATTA_WHISPER_TIMEOUT_MS'] ?? TRANSCRIBE_TIMEOUT_MS)
      const timeout = Number.isFinite(configured) && configured > 0 ? configured : TRANSCRIBE_TIMEOUT_MS
      const args = ['-m', modelPath, '-f', wavPath, '-nt', '-np', '-l', model === 'base.en' ? 'en' : 'auto']
      const stdout = await new Promise<string>((resolve, reject) => {
        execFileCb(
          engine,
          args,
          { timeout, maxBuffer: 8 * 1024 * 1024, env: { ...env }, windowsHide: true },
          (err, out, errOut) => {
            if (err) {
              const detail = String(errOut ?? '')
                .trim()
                .split('\n')[0] ?? ''
              if ((err as NodeJS.ErrnoException & { killed?: boolean }).killed) {
                reject(new Error('Turning speech into text took too long. Try a shorter recording.'))
              } else if (detail) {
                reject(new Error(`Transcription failed: ${detail}`))
              } else {
                reject(new Error('Transcription failed. Try again.'))
              }
              return
            }
            resolve(String(out))
          }
        )
      })
      return cleanTranscript(stdout)
    } finally {
      rmSync(wavPath, { force: true })
    }
  }

  private fetchToFile(
    url: string,
    dest: string,
    signal: AbortSignal,
    onProgress: (received: number, total: number) => void
  ): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      if (signal.aborted) {
        reject(new Error('The download was cancelled.'))
        return
      }
      const onAbort = (): void => reject(new Error('The download was cancelled.'))
      signal.addEventListener('abort', onAbort, { once: true })
      void (async () => {
        const file = createWriteStream(dest)
        // Opening and writing report failures as events; with no listener one would crash the app.
        file.on('error', (err) => reject(err))
        try {
          const res = await fetch(url, { signal, redirect: 'follow' })
          if (!res.ok || !res.body) throw new Error(`The download failed (HTTP ${res.status}).`)
          const total = Number(res.headers.get('content-length') ?? 0)
          const reader = res.body.getReader()
          let received = 0
          let lastEmit = 0
          for (;;) {
            const { done, value } = await reader.read()
            if (done) break
            received += value.byteLength
            await new Promise<void>((resolveChunk, rejectChunk) => {
              file.write(value, (err) => {
                if (err) rejectChunk(err)
                else resolveChunk()
              })
            })
            const now = Date.now()
            if (now - lastEmit >= PROGRESS_EMIT_MS) {
              lastEmit = now
              onProgress(received, Number.isFinite(total) ? total : 0)
            }
          }
          await new Promise<void>((resolveEnd, rejectEnd) => {
            file.on('error', rejectEnd)
            file.end(() => resolveEnd())
          })
          signal.removeEventListener('abort', onAbort)
          resolve()
        } catch (err) {
          signal.removeEventListener('abort', onAbort)
          try {
            file.destroy()
          } catch {
            // The stream is already gone.
          }
          reject(err instanceof Error ? err : new Error('The download failed. Try again.'))
        }
      })()
    })
  }
}
