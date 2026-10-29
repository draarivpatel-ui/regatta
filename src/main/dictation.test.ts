// Unit tests for Dictation: engine lookup, transcription, downloads and model choice.

import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { DictationStatus } from '../shared/dictation'
import { Dictation, cleanTranscript } from './dictation'

const cleanup: string[] = []
let binDir = ''

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  cleanup.push(dir)
  return dir
}

// Dictation writes its temporary audio file to os.tmpdir(), which follows TMPDIR. Pointing TMPDIR at a folder
// of this file's own means the temp file checks look only at files made here, not at whatever other test runs
// leave in the shared system temp folder while they run alongside.
const ownTmp = mkdtempSync(join(tmpdir(), 'regatta-dict-own-tmp-'))
cleanup.push(ownTmp)
const savedTmpdir = process.env['TMPDIR']

beforeAll(() => {
  process.env['TMPDIR'] = ownTmp
})

afterAll(() => {
  if (savedTmpdir === undefined) delete process.env['TMPDIR']
  else process.env['TMPDIR'] = savedTmpdir
  for (const dir of cleanup) rmSync(dir, { recursive: true, force: true })
})

function makeDictation(
  dataDir: string,
  extraEnv: Record<string, string> = {}
): { dictation: Dictation; emitted: DictationStatus[] } {
  const emitted: DictationStatus[] = []
  const dictation = new Dictation({
    dataDir,
    env: () => ({ PATH: '', ...extraEnv }),
    emit: (status) => {
      emitted.push(status)
    }
  })
  return { dictation, emitted }
}

/** A fake whisper-cli driven by environment variables. Writes its argv to REGATTA_WHISPER_ARGS_FILE. */
const FAKE_ENGINE = `#!/bin/sh
if [ -n "$REGATTA_WHISPER_ARGS_FILE" ]; then printf '%s\\n' "$@" > "$REGATTA_WHISPER_ARGS_FILE"; fi
if [ "$REGATTA_WHISPER_FAIL" = "1" ]; then echo "fake engine blew up" >&2; exit 3; fi
if [ "$REGATTA_WHISPER_SLEEP" = "1" ]; then /bin/sleep 30; fi
printf 'hello [BLANK_AUDIO]\\n'
printf '(music) world\\n'
printf '\\n'
printf 'second line\\n'
`

function writeFakeEngine(dir: string): string {
  const path = join(dir, 'whisper-cli')
  writeFileSync(path, FAKE_ENGINE, { mode: 0o755 })
  chmodSync(path, 0o755)
  return path
}

function writeModel(dataDir: string, id: string): string {
  mkdirSync(join(dataDir, 'models'), { recursive: true })
  const path = join(dataDir, 'models', `ggml-${id}.bin`)
  writeFileSync(path, 'dummy-model')
  return path
}

function readArgs(argsFile: string): string[] {
  return readFileSync(argsFile, 'utf8')
    .split('\n')
    .filter((line) => line.length > 0)
}

function wavPathFromArgs(argsFile: string): string | null {
  if (!existsSync(argsFile)) return null
  const lines = readArgs(argsFile)
  const at = lines.indexOf('-f')
  if (at < 0) return null
  return lines[at + 1] ?? null
}

function tempWavs(): string[] {
  return readdirSync(ownTmp).filter((f) => f.startsWith('regatta-dictation-'))
}

beforeAll(() => {
  binDir = tempDir('regatta-dict-bin-')
  writeFakeEngine(binDir)
})

describe('cleanTranscript', () => {
  it('joins lines, removes bracketed tags and trims', () => {
    expect(cleanTranscript('hello [BLANK_AUDIO]\n(music) world\n\nsecond line\n')).toBe('hello world second line')
    expect(cleanTranscript('  spaced   out  \n\n more ')).toBe('spaced out more')
    expect(cleanTranscript('[BLANK_AUDIO]\n')).toBe('')
  })
})

describe('engine lookup', () => {
  it('finds whisper-cli on the PATH', async () => {
    const { dictation } = makeDictation(tempDir('regatta-dict-data-'), { PATH: binDir })
    expect((await dictation.status()).engine).toBe(join(binDir, 'whisper-cli'))
  })

  it('prefers REGATTA_WHISPER_CLI over the PATH', async () => {
    const missing = join(tempDir('regatta-dict-fake-'), 'whisper')
    const { dictation } = makeDictation(tempDir('regatta-dict-data-'), {
      PATH: binDir,
      REGATTA_WHISPER_CLI: missing
    })
    expect((await dictation.status()).engine).toBe(missing)
  })

  it('reports null when the engine is missing', async () => {
    const { dictation } = makeDictation(tempDir('regatta-dict-data-'))
    const status = await dictation.status()
    expect(status.engine).toBeNull()
    expect(status.model).toBeNull()
  })

  it('reports model metadata', async () => {
    const { dictation } = makeDictation(tempDir('regatta-dict-data-'))
    const status = await dictation.status()
    expect(status.models.map((m) => [m.id, m.name, m.sizeMiB, m.languages, m.installed])).toEqual([
      ['base.en', 'Base, English', 142, 'English', false],
      ['large-v3-turbo-q5_0', 'Turbo', 547, 'Many languages', false]
    ])
  })
})

describe('transcribe', () => {
  it('runs the engine with the right arguments, cleans tags and deletes the temp file', async () => {
    const dataDir = tempDir('regatta-dict-data-')
    const argsFile = join(tempDir('regatta-dict-args-'), 'args.txt')
    const engine = writeFakeEngine(tempDir('regatta-dict-eng-'))
    const modelPath = writeModel(dataDir, 'base.en')
    const { dictation } = makeDictation(dataDir, { REGATTA_WHISPER_CLI: engine, REGATTA_WHISPER_ARGS_FILE: argsFile })
    const before = new Set(tempWavs())
    const text = await dictation.transcribe(new Uint8Array([1, 2, 3, 4]))
    expect(text).toBe('hello world second line')
    const args = readArgs(argsFile)
    expect(args[0]).toBe('-m')
    expect(args[1]).toBe(modelPath)
    expect(args[2]).toBe('-f')
    expect(typeof args[3] === 'string' && (args[3] as string).length > 0).toBe(true)
    expect(args.slice(4)).toEqual(['-nt', '-np', '-l', 'en'])
    const wavPath = wavPathFromArgs(argsFile)
    expect(wavPath).not.toBeNull()
    // The engine was given a file inside this file's own temp folder, so looking only there is looking in the right place.
    expect((wavPath as string).startsWith(`${ownTmp}/regatta-dictation-`)).toBe(true)
    expect(existsSync(wavPath as string)).toBe(false)
    expect(tempWavs().filter((f) => !before.has(f))).toEqual([])
  })

  it('uses automatic language detection for the Turbo model', async () => {
    const dataDir = tempDir('regatta-dict-data-')
    const argsFile = join(tempDir('regatta-dict-args-'), 'args.txt')
    const engine = writeFakeEngine(tempDir('regatta-dict-eng-'))
    writeModel(dataDir, 'large-v3-turbo-q5_0')
    const { dictation } = makeDictation(dataDir, { REGATTA_WHISPER_CLI: engine, REGATTA_WHISPER_ARGS_FILE: argsFile })
    await dictation.setModel('large-v3-turbo-q5_0')
    await dictation.transcribe(new Uint8Array([9, 9]))
    expect(readArgs(argsFile).slice(-2)).toEqual(['-l', 'auto'])
  })

  it('refuses empty and oversized audio', async () => {
    const dataDir = tempDir('regatta-dict-data-')
    const engine = writeFakeEngine(tempDir('regatta-dict-eng-'))
    writeModel(dataDir, 'base.en')
    const { dictation } = makeDictation(dataDir, { REGATTA_WHISPER_CLI: engine })
    await expect(dictation.transcribe(new Uint8Array(0))).rejects.toThrow('No audio')
    await expect(dictation.transcribe(new Uint8Array(4 * 1024 * 1024 + 1))).rejects.toThrow('too long')
  })

  it('refuses when the engine is missing', async () => {
    const dataDir = tempDir('regatta-dict-data-')
    writeModel(dataDir, 'base.en')
    const { dictation } = makeDictation(dataDir)
    await expect(dictation.transcribe(new Uint8Array([1]))).rejects.toThrow('not installed')
  })

  it('refuses when no model is installed', async () => {
    const dataDir = tempDir('regatta-dict-data-')
    const engine = writeFakeEngine(tempDir('regatta-dict-eng-'))
    const { dictation } = makeDictation(dataDir, { REGATTA_WHISPER_CLI: engine })
    await expect(dictation.transcribe(new Uint8Array([1]))).rejects.toThrow('No dictation model')
  })

  it('deletes the temp file when the engine fails', async () => {
    const dataDir = tempDir('regatta-dict-data-')
    const argsFile = join(tempDir('regatta-dict-args-'), 'args.txt')
    const engine = writeFakeEngine(tempDir('regatta-dict-eng-'))
    writeModel(dataDir, 'base.en')
    const { dictation } = makeDictation(dataDir, {
      REGATTA_WHISPER_CLI: engine,
      REGATTA_WHISPER_ARGS_FILE: argsFile,
      REGATTA_WHISPER_FAIL: '1'
    })
    await expect(dictation.transcribe(new Uint8Array([5]))).rejects.toThrow('fake engine blew up')
    const wavPath = wavPathFromArgs(argsFile)
    expect(wavPath).not.toBeNull()
    expect(existsSync(wavPath as string)).toBe(false)
  })

  it('deletes the temp file when the engine times out', async () => {
    const dataDir = tempDir('regatta-dict-data-')
    const argsFile = join(tempDir('regatta-dict-args-'), 'args.txt')
    const engine = writeFakeEngine(tempDir('regatta-dict-eng-'))
    writeModel(dataDir, 'base.en')
    const { dictation } = makeDictation(dataDir, {
      REGATTA_WHISPER_CLI: engine,
      REGATTA_WHISPER_ARGS_FILE: argsFile,
      REGATTA_WHISPER_SLEEP: '1',
      REGATTA_WHISPER_TIMEOUT_MS: '300'
    })
    await expect(dictation.transcribe(new Uint8Array([6]))).rejects.toThrow('too long')
    const wavPath = wavPathFromArgs(argsFile)
    expect(wavPath).not.toBeNull()
    expect(existsSync(wavPath as string)).toBe(false)
  }, 15000)
})

describe('download', () => {
  let server: Server | null = null
  let baseUrl = ''
  let handler: ((req: IncomingMessage, res: ServerResponse) => void) | null = null

  beforeAll(async () => {
    server = createServer((req, res) => handler?.(req, res))
    await new Promise<void>((resolve) => server?.listen(0, '127.0.0.1', () => resolve()))
    const address = server?.address()
    const port = typeof address === 'object' && address ? address.port : 0
    baseUrl = `http://127.0.0.1:${port}`
  })

  afterAll(async () => {
    await new Promise<void>((resolve) => server?.close(() => resolve()))
    server = null
  })

  function drip(res: ServerResponse, total: number, chunkBytes: number, everyMs: number): void {
    res.writeHead(200, { 'Content-Length': String(total), 'Content-Type': 'application/octet-stream' })
    const chunk = Buffer.alloc(chunkBytes, 0x43)
    let sent = 0
    const timer = setInterval(() => {
      if (res.destroyed) {
        clearInterval(timer)
        return
      }
      res.write(chunk)
      sent += chunkBytes
      if (sent >= total) {
        clearInterval(timer)
        res.end()
      }
    }, everyMs)
  }

  it('downloads with progress, renames the .part file and resolves the model', async () => {
    const payload = Buffer.alloc(10 * 1024 * 1024 + 512, 0x41)
    handler = (_req, res) => {
      res.writeHead(200, { 'Content-Length': String(payload.byteLength), 'Content-Type': 'application/octet-stream' })
      res.end(payload)
    }
    const dataDir = tempDir('regatta-dict-data-')
    const { dictation, emitted } = makeDictation(dataDir, { REGATTA_WHISPER_MODEL_URL: baseUrl })
    const status = await dictation.download('base.en')
    expect(status.error).toBeNull()
    expect(status.download).toBeNull()
    expect(status.model).toBe('base.en')
    expect(status.models.find((m) => m.id === 'base.en')?.installed).toBe(true)
    expect(existsSync(join(dataDir, 'models', 'ggml-base.en.bin'))).toBe(true)
    expect(existsSync(join(dataDir, 'models', 'ggml-base.en.bin.part'))).toBe(false)
    const progress = emitted.filter((s) => s.download?.id === 'base.en')
    expect(progress.length).toBeGreaterThan(0)
    expect(progress[progress.length - 1]?.download?.received).toBeGreaterThan(0)
  })

  it('follows redirects', async () => {
    handler = (req, res) => {
      if (req.url === '/ggml-base.en.bin') {
        res.writeHead(302, { Location: '/files/elsewhere.bin' })
        res.end()
        return
      }
      const small = Buffer.from('too-small')
      res.writeHead(200, { 'Content-Length': String(small.byteLength) })
      res.end(small)
    }
    const dataDir = tempDir('regatta-dict-data-')
    const { dictation } = makeDictation(dataDir, { REGATTA_WHISPER_MODEL_URL: baseUrl })
    const status = await dictation.download('base.en')
    expect(status.error).toMatch(/too small/)
    expect(existsSync(join(dataDir, 'models', 'ggml-base.en.bin'))).toBe(false)
  })

  it('reports a file that cannot be written as a failed download instead of crashing (sol-loop S5)', async () => {
    const payload = Buffer.alloc(64 * 1024, 0x44)
    handler = (_req, res) => {
      res.writeHead(200, { 'Content-Length': String(payload.byteLength) })
      res.end(payload)
    }
    const dataDir = tempDir('regatta-dict-data-')
    mkdirSync(join(dataDir, 'models'))
    chmodSync(join(dataDir, 'models'), 0o555)
    try {
      const { dictation } = makeDictation(dataDir, { REGATTA_WHISPER_MODEL_URL: baseUrl })
      const status = await dictation.download('base.en')
      expect(status.error).toMatch(/EACCES/)
      expect(status.download).toBeNull()
    } finally {
      chmodSync(join(dataDir, 'models'), 0o755)
    }
  })

  it('treats a finished file under 10 MB as a failure', async () => {
    const small = Buffer.alloc(64 * 1024, 0x42)
    handler = (_req, res) => {
      res.writeHead(200, { 'Content-Length': String(small.byteLength) })
      res.end(small)
    }
    const dataDir = tempDir('regatta-dict-data-')
    const { dictation } = makeDictation(dataDir, { REGATTA_WHISPER_MODEL_URL: baseUrl })
    const status = await dictation.download('large-v3-turbo-q5_0')
    expect(status.error).toMatch(/too small/)
    expect(status.download).toBeNull()
    expect(existsSync(join(dataDir, 'models', 'ggml-large-v3-turbo-q5_0.bin'))).toBe(false)
    expect(existsSync(join(dataDir, 'models', 'ggml-large-v3-turbo-q5_0.bin.part'))).toBe(false)
  })

  it('cancels an in-flight download and deletes the .part file', async () => {
    handler = (_req, res) => drip(res, 11 * 1024 * 1024, 256 * 1024, 50)
    const dataDir = tempDir('regatta-dict-data-')
    const { dictation, emitted } = makeDictation(dataDir, { REGATTA_WHISPER_MODEL_URL: baseUrl })
    const pending = dictation.download('base.en')
    await new Promise<void>((resolve, reject) => {
      const started = Date.now()
      const poll = (): void => {
        if (emitted.some((s) => (s.download?.received ?? 0) > 0)) {
          resolve()
          return
        }
        if (Date.now() - started > 8000) {
          reject(new Error('no download progress was emitted'))
          return
        }
        setTimeout(poll, 50)
      }
      poll()
    })
    dictation.cancelDownload()
    const status = await pending
    expect(status.error).toMatch(/cancelled/)
    expect(status.download).toBeNull()
    expect(existsSync(join(dataDir, 'models', 'ggml-base.en.bin.part'))).toBe(false)
    expect(existsSync(join(dataDir, 'models', 'ggml-base.en.bin'))).toBe(false)
  })

  it('allows only one download at a time', async () => {
    handler = (_req, res) => drip(res, 11 * 1024 * 1024, 256 * 1024, 50)
    const dataDir = tempDir('regatta-dict-data-')
    const { dictation } = makeDictation(dataDir, { REGATTA_WHISPER_MODEL_URL: baseUrl })
    const pending = dictation.download('base.en')
    await expect(dictation.download('large-v3-turbo-q5_0')).rejects.toThrow('already in progress')
    dictation.cancelDownload()
    await pending
  })
})

describe('model choice', () => {
  it('uses the first installed model until one is chosen, then saves and reloads it', async () => {
    const dataDir = tempDir('regatta-dict-data-')
    writeModel(dataDir, 'base.en')
    writeModel(dataDir, 'large-v3-turbo-q5_0')
    const first = makeDictation(dataDir)
    expect((await first.dictation.status()).model).toBe('base.en')
    const afterSet = await first.dictation.setModel('large-v3-turbo-q5_0')
    expect(afterSet.model).toBe('large-v3-turbo-q5_0')
    const second = makeDictation(dataDir)
    expect((await second.dictation.status()).model).toBe('large-v3-turbo-q5_0')
  })

  it('falls back to whatever is installed', async () => {
    const dataDir = tempDir('regatta-dict-data-')
    writeModel(dataDir, 'large-v3-turbo-q5_0')
    const { dictation } = makeDictation(dataDir)
    expect((await dictation.status()).model).toBe('large-v3-turbo-q5_0')
  })

  it('refuses unknown models and models that are not installed', async () => {
    const { dictation } = makeDictation(tempDir('regatta-dict-data-'))
    await expect(dictation.setModel('base.en')).rejects.toThrow('not installed')
    await expect(dictation.setModel('nope' as 'base.en')).rejects.toThrow('Unknown')
  })
})
