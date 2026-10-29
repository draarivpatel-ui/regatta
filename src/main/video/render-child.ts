// The render process: the app binary started with --regatta-render=<job file> renders one video to
// MP4 (or runs the pixel stability check) and exits. It turns GPU acceleration off for itself only.

import { app, BrowserWindow, screen, type NativeImage } from 'electron'
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { VideoScene } from '../../shared/video'
import { frameDiff } from './compare'
import {
  captionsCheck,
  hasPicture,
  integratedLoudness,
  largestDiff,
  loadsCheck,
  notChecked,
  sampleTimes,
  sceneMiddle,
  sizeMismatch,
  stableCheck,
  thumbName,
  type Caption,
  type RenderReport,
  type SampleResult,
  type Viewport
} from './report'

export interface RenderJob {
  /** The video folder holding index.html. */
  folder: string
  width: number
  height: number
  fps: number
  /** "render" writes `out`; "check" renders sample frames twice and writes `report`. */
  kind: 'render' | 'check'
  /** MP4 path for "render". */
  out: string
  /** JSON report path: the checks, the sampled frames, scene thumbnails written, loudness, errors. */
  report: string
  ffmpeg: string | null
}

const FLAG = '--regatta-render='

/** The job named on the command line, or null for a normal app start. */
export function renderJobFromArgv(argv: string[]): string | null {
  const arg = argv.find((a) => a.startsWith(FLAG))
  return arg ? arg.slice(FLAG.length) : null
}

/** How long the page may take to load and say it is ready. */
const READY_TIMEOUT_MS = 30_000
/** How long one frame (seek, then capture) may take. A page stuck in a loop never answers. */
const FRAME_TIMEOUT_MS = 20_000
/** How long the music may take to render. */
const AUDIO_TIMEOUT_MS = 90_000
/** How long ffmpeg may refuse more frames before the render is given up. */
const DRAIN_TIMEOUT_MS = 60_000
/** Frames of the stability check are held in memory up to this much at once. */
const BATCH_BYTES = 256 * 1024 * 1024
/** Anything the page asks for from the network is refused: a video works offline. */
const NETWORK_URLS = ['http://*/*', 'https://*/*', 'ws://*/*', 'wss://*/*']

/** A job that cannot finish. `source` says whether the page (fixable by the agent) or the machine is at fault. */
class JobError extends Error {
  constructor(
    message: string,
    readonly source: 'page' | 'system'
  ) {
    super(message)
  }
}

interface Composition {
  duration: number
  /** The size and frame rate the page itself declares (its regatta-video meta tag). */
  declared: { width: number; height: number; fps: number }
  scenes: VideoScene[]
  captions: Caption[]
  errors: string[]
}

/** The page being drawn, with every call to it guarded against hangs and crashes. */
interface Page {
  win: BrowserWindow
  /** What the page asked for from the network, which was refused. */
  blocked: string[]
  run: <T>(script: string, ms: number, what: string) => Promise<T>
  capture: (t: number) => Promise<NativeImage>
  errors: () => Promise<string[]>
}

/** One line of JSON on stdout: progress for the app, and a log when run by hand. */
function log(line: Record<string, unknown>): void {
  try {
    process.stdout.write(`${JSON.stringify(line)}\n`)
  } catch {
    // Nobody is reading; the report file is what counts.
  }
}

function errorText(err: unknown): string {
  const message = err && typeof err === 'object' && 'message' in err ? String((err as Error).message) : String(err)
  return message || 'Something went wrong'
}

function lastLine(text: string): string {
  const lines = text.trim().split('\n')
  return (lines[lines.length - 1] ?? '').slice(0, 200)
}

function sceneIdAt(scenes: VideoScene[], t: number): string | null {
  for (const scene of scenes) if (t >= scene.start && t < scene.start + scene.duration) return scene.id
  return scenes[scenes.length - 1]?.id ?? null
}

// ---------------------------------------------------------------------------------------------
// Finishing: every way out goes through finish(), which stops ffmpeg and tidies up first.

/** Things to undo on the way out. `ok` is false when the job did not finish. */
const cleanups: Array<(ok: boolean) => void> = []
let finished = false

export function finish(code: number): void {
  if (finished) return
  finished = true
  for (const fn of cleanups.splice(0).reverse()) {
    try {
      fn(code === 0)
    } catch {
      // Best effort.
    }
  }
  app.exit(code)
}

function writeReport(job: RenderJob, report: RenderReport): void {
  mkdirSync(dirname(job.report), { recursive: true })
  writeFileSync(job.report, `${JSON.stringify(report, null, 2)}\n`, 'utf8')
}

/** Writes a report that says the job failed and why, says so on stdout, and exits 1. */
function fail(job: RenderJob, error: string, source: 'page' | 'system'): void {
  try {
    writeReport(job, {
      kind: job.kind,
      ok: false,
      error,
      failure: source,
      errors: [],
      duration: 0,
      fps: job.fps,
      scenes: [],
      thumbnails: [],
      loads: { name: 'loads', passed: false, detail: source === 'page' ? error : `The checks could not run: ${error}` },
      stable: notChecked('stable', 'the page did not load.'),
      captions: notChecked('captions', 'the page did not load.'),
      samples: [],
      maxDiff: 0,
      viewport: null,
      frames: 0,
      framesDone: 0,
      sizeBytes: null,
      loudness: null,
      out: job.out
    })
  } catch {
    // Without a report the caller falls back to the exit code.
  }
  log({ error })
  finish(1)
}

// ---------------------------------------------------------------------------------------------
// The page

/** Rejects `work` when it takes longer than `ms`, and when the page's process dies. */
function guarded<T>(work: Promise<T>, crashed: Promise<never>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new JobError(what, 'page')), ms)
  })
  return Promise.race([work, timeout, crashed]).finally(() => clearTimeout(timer))
}

/**
 * Shows instant `t` and resolves once the compositor has taken the new picture.
 *
 * The runtime's own seek waits for two animation frames, and that is not enough for a picture that
 * is slow to draw (a new scene, big gradients, blurs, shadows): the capture that follows then
 * returns the frame before it. A throwaway animation made in the same task as the seek cannot
 * report ready until the compositor has the frame holding the seek's changes, so waiting for it
 * makes every capture fresh. If it ever fails to report within 3 seconds the wait is dropped for
 * the rest of the job and the runtime's own wait is all there is.
 */
function seekScript(t: number): string {
  return `(function (t) {
  var seeked = window.RegattaVideo.seek(t)
  if (window.__regattaBarrierOff) return seeked
  var bar = document.getElementById('__regatta_barrier')
  if (!bar) {
    bar = document.createElement('div')
    bar.id = '__regatta_barrier'
    bar.setAttribute('aria-hidden', 'true')
    bar.style.cssText = 'position:fixed;left:0;top:0;width:2px;height:2px;opacity:0;will-change:transform,opacity;pointer-events:none'
    ;(document.body || document.documentElement).appendChild(bar)
  }
  var anim = bar.animate([{ transform: 'translateX(0px)' }, { transform: 'translateX(1px)' }], { duration: 1000 })
  var timer
  var late = new Promise(function (resolve) {
    timer = setTimeout(function () {
      window.__regattaBarrierOff = true
      resolve()
    }, 3000)
  })
  return Promise.all([seeked, Promise.race([anim.ready, late])]).then(function () {
    clearTimeout(timer)
    anim.cancel()
  })
})(${JSON.stringify(t)})`
}

/**
 * Opens index.html in a hidden window that shows exactly `width` by `height` CSS pixels at a device
 * pixel ratio of 1, also on a Retina screen. Throws if it cannot.
 */
async function openPage(job: RenderJob): Promise<Page> {
  const scale = screen.getPrimaryDisplay().scaleFactor
  if (!Number.isInteger(scale) || scale < 1) {
    throw new JobError(`The screen scale is ${scale}. Rendering needs a whole number such as 1 or 2.`, 'system')
  }
  const win = new BrowserWindow({
    width: Math.round(job.width / scale),
    height: Math.round(job.height / scale),
    useContentSize: true,
    show: false,
    frame: false,
    // Without this macOS shrinks a window taller than the screen (a 9:16 video on a 1x display).
    enableLargerThanScreen: true,
    webPreferences: { partition: 'regatta-video-render', backgroundThrottling: false }
  })
  cleanups.push(() => {
    if (!win.isDestroyed()) win.destroy()
  })

  const blocked: string[] = []
  win.webContents.session.webRequest.onBeforeRequest({ urls: NETWORK_URLS }, (details, callback) => {
    if (!blocked.includes(details.url)) blocked.push(details.url)
    callback({ cancel: true })
  })

  const crashed = new Promise<never>((_resolve, reject) => {
    win.webContents.once('render-process-gone', (_event, details) => {
      reject(new JobError(`The page crashed (${details.reason}).`, 'page'))
    })
  })
  crashed.catch(() => undefined)

  const run = <T>(script: string, ms: number, what: string): Promise<T> =>
    guarded(win.webContents.executeJavaScript(script) as Promise<T>, crashed, ms, what)

  const index = join(realpathSync(job.folder), 'index.html')
  try {
    await guarded(win.loadFile(index, { query: { mode: 'render' } }), crashed, READY_TIMEOUT_MS, 'The page took too long to load.')
  } catch (err) {
    if (err instanceof JobError) throw err
    throw new JobError(`index.html could not be loaded: ${errorText(err)}`, 'page')
  }
  // After the load, which resets it: a Retina screen draws two device pixels to a CSS pixel, and
  // zooming out by the same factor gives a page of exactly width by height at a ratio of 1.
  win.webContents.setZoomFactor(1 / scale)

  return {
    win,
    blocked,
    run,
    errors: () =>
      run<string[]>('window.RegattaVideo ? window.RegattaVideo.errors.slice() : []', FRAME_TIMEOUT_MS, 'The page stopped responding.'),
    capture: async (t) => {
      await run(seekScript(t), FRAME_TIMEOUT_MS, `The page stopped responding while drawing ${Math.round(t * 100) / 100} s. Look for a loop that never ends.`)
      return guarded(win.webContents.capturePage(), crashed, FRAME_TIMEOUT_MS, 'The page could not be captured.')
    }
  }
}

/** Waits for the page to be ready and reads what it says about itself. */
async function readComposition(page: Page): Promise<Composition> {
  const script = `(async () => {
    const rv = window.RegattaVideo
    if (!rv) return { error: 'The page did not load the video runtime. Keep the regatta-video.js script tag.' }
    const ready = await rv.ready
    if (!ready) return { error: 'The page never finished loading.' }
    return {
      duration: rv.duration,
      declared: { width: rv.width, height: rv.height, fps: rv.fps },
      scenes: rv.scenes,
      captions: rv.captions,
      errors: rv.errors.slice()
    }
  })()`
  const result = await page.run<Partial<Composition> & { error?: string }>(script, READY_TIMEOUT_MS, 'The page never finished loading.')
  if (result.error) throw new JobError(result.error, 'page')
  const declared = result.declared ?? { width: 0, height: 0, fps: 0 }
  return {
    duration: Number(result.duration) || 0,
    declared: { width: Number(declared.width), height: Number(declared.height), fps: Number(declared.fps) },
    scenes: Array.isArray(result.scenes) ? result.scenes : [],
    captions: Array.isArray(result.captions) ? result.captions : [],
    errors: Array.isArray(result.errors) ? result.errors.map(String) : []
  }
}

/**
 * Waits until the page is exactly the video's size at a device pixel ratio of 1, which is what the
 * zoom after loading is for. The renderer takes a moment to apply it. If it never does, every
 * frame would be cropped or padded, so the job fails instead.
 */
async function settleViewport(page: Page, job: RenderJob): Promise<Viewport> {
  let seen: Viewport = { width: 0, height: 0, ratio: 0 }
  for (let attempt = 0; attempt < 30; attempt++) {
    seen = await page.run<Viewport>(
      '({ width: window.innerWidth, height: window.innerHeight, ratio: window.devicePixelRatio })',
      FRAME_TIMEOUT_MS,
      'The page stopped responding.'
    )
    if (seen.width === job.width && seen.height === job.height && seen.ratio === 1) return seen
    await new Promise((resume) => setTimeout(resume, 100))
  }
  throw new JobError(
    `The render window is ${seen.width} by ${seen.height} at a pixel ratio of ${seen.ratio}, not ${job.width} by ${job.height} at 1.`,
    'system'
  )
}

/** A frame's pixels as BGRA bytes, after checking that the capture is exactly the video's size. */
function bitmapOf(image: NativeImage, job: RenderJob): Buffer {
  const size = image.getSize()
  const bitmap = image.toBitmap()
  if (size.width !== job.width || size.height !== job.height || bitmap.length !== job.width * job.height * 4) {
    throw new JobError(`A frame came out ${size.width} by ${size.height}, not ${job.width} by ${job.height}.`, 'system')
  }
  return bitmap
}

// ---------------------------------------------------------------------------------------------
// The check job

/** Script errors the runtime saw, plus anything the page tried to fetch from the network. */
async function pageErrors(page: Page): Promise<string[]> {
  const errors = await page.errors()
  for (const url of page.blocked) errors.push(`The page asked for ${url} from the network. A video must work offline: copy it into assets/.`)
  return errors
}

function writeThumbnail(job: RenderJob, scene: VideoScene, image: NativeImage): void {
  const dir = join(job.folder, 'thumbs')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, `${thumbName(scene.id)}.png`), image.toPNG())
}

/**
 * The check job: the page must load, every sampled frame must come out the same twice (within a
 * couple of levels, see compare.ts), and the captions must sit inside the video without overlapping.
 * Each scene's middle frame is kept as a thumbnail.
 */
async function runCheck(job: RenderJob, page: Page, comp: Composition, viewport: Viewport): Promise<void> {
  const mismatch = sizeMismatch(comp.declared, job)
  const draws = hasPicture(comp.duration, comp.scenes.length) && !mismatch
  const times = draws ? sampleTimes(comp.duration, job.fps, comp.scenes) : []
  const results: SampleResult[] = []
  const written: string[] = []

  // The samples are drawn in order, twice: the picture must not depend on what came before it.
  // Long videos go a batch at a time so the first draws never need more than BATCH_BYTES of memory.
  const batchSize = Math.max(2, Math.floor(BATCH_BYTES / (job.width * job.height * 4)))
  for (let from = 0; from < times.length; from += batchSize) {
    const batch = times.slice(from, from + batchSize)
    const firsts: Buffer[] = []
    for (const t of batch) {
      const image = await page.capture(t)
      firsts.push(bitmapOf(image, job))
      for (const scene of comp.scenes) {
        if (sceneMiddle(scene) === t && !written.includes(scene.id)) {
          writeThumbnail(job, scene, image)
          written.push(scene.id)
        }
      }
    }
    for (const [i, t] of batch.entries()) {
      const first = firsts[i]
      if (!first) continue
      const diff = frameDiff(first, bitmapOf(await page.capture(t), job))
      results.push({ time: t, scene: sceneIdAt(comp.scenes, t), maxDiff: diff.max, pixels: diff.pixels })
    }
  }

  // The music is rendered too, so a score that throws shows up here and not only at render time.
  if (draws) await page.run('window.RegattaVideo.renderAudio().then(function (b) { return b ? b.length : 0 })', AUDIO_TIMEOUT_MS, 'The music took too long to render.')

  const errors = await pageErrors(page)
  const stable =
    times.length > 0
      ? stableCheck(results)
      : notChecked('stable', mismatch ? 'the page is not the size of the video.' : 'there is nothing to draw yet.')
  writeReport(job, {
    kind: 'check',
    ok: true,
    errors,
    duration: comp.duration,
    fps: comp.declared.fps,
    scenes: comp.scenes,
    thumbnails: written,
    loads: loadsCheck(comp.duration, comp.scenes.length, errors, mismatch),
    stable,
    captions: captionsCheck(comp.duration, comp.captions),
    samples: results,
    maxDiff: largestDiff(results),
    viewport,
    frames: results.length * 2,
    framesDone: results.length * 2,
    sizeBytes: null,
    loudness: null,
    out: job.out
  })
  log({ check: true, samples: results.length, maxDiff: largestDiff(results) })
  finish(0)
}

// ---------------------------------------------------------------------------------------------
// The render job

interface FfmpegRun {
  code: number | null
  stderr: string
}

/** Runs one ffmpeg pass. It is stopped with the render: a pass still running then would outlive the app. */
export function runFfmpeg(bin: string, args: string[]): Promise<FfmpegRun> {
  return new Promise((done) => {
    if (finished) {
      done({ code: null, stderr: 'The render was stopped.' })
      return
    }
    const child = spawn(bin, args, { stdio: ['ignore', 'ignore', 'pipe'] })
    const stop = (): void => {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
    }
    cleanups.push(stop)
    const forget = (): void => {
      const at = cleanups.indexOf(stop)
      if (at >= 0) cleanups.splice(at, 1)
    }
    let stderr = ''
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString()
    })
    child.on('error', (err) => {
      forget()
      stderr += err.message
      done({ code: null, stderr })
    })
    child.on('close', (code) => {
      forget()
      done({ code, stderr })
    })
  })
}

/** The last JSON object ffmpeg printed, which is how loudnorm reports its measurements. */
function lastJson(text: string): Record<string, string> | null {
  const start = text.lastIndexOf('{')
  const end = text.lastIndexOf('}')
  if (start < 0 || end <= start) return null
  try {
    const parsed: unknown = JSON.parse(text.slice(start, end + 1))
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, string>) : null
  } catch {
    return null
  }
}

interface Music {
  file: string
  /** Something the user should know, for example that the music is not mastered. */
  note?: string
}

/**
 * Masters the music to -14 LUFS integrated, -1.5 dB true peak, with ffmpeg's two loudnorm passes:
 * the first measures, the second uses what it measured. If that cannot be done the music goes in
 * as it is, with a note saying so.
 */
async function masterMusic(ffmpeg: string, dir: string, wav: string): Promise<Music> {
  const target = 'loudnorm=I=-14:TP=-1.5:LRA=11'
  const measure = await runFfmpeg(ffmpeg, ['-hide_banner', '-nostats', '-i', wav, '-af', `${target}:print_format=json`, '-f', 'null', '-'])
  const m = lastJson(measure.stderr)
  if (!m || measure.code !== 0) return { file: wav, note: 'The music could not be measured, so it is at its original level.' }
  // Silence measures as -inf and has nothing to master.
  if (!Number.isFinite(Number(m['input_i']))) return { file: wav }
  const filter = [
    target,
    `measured_I=${m['input_i']}`,
    `measured_TP=${m['input_tp']}`,
    `measured_LRA=${m['input_lra']}`,
    `measured_thresh=${m['input_thresh']}`,
    `offset=${m['target_offset']}`,
    'linear=true'
  ].join(':')
  const mastered = join(dir, 'mastered.wav')
  // loudnorm works at 192 kHz and keeps it, so the output is brought back to the music's 48 kHz.
  const result = await runFfmpeg(ffmpeg, ['-hide_banner', '-nostats', '-y', '-i', wav, '-af', filter, '-ar', '48000', '-c:a', 'pcm_s16le', mastered])
  if (result.code !== 0 || !existsSync(mastered)) {
    return { file: wav, note: 'The music could not be mastered, so it is at its original level.' }
  }
  return { file: mastered }
}

/** The page's music as a WAV file in `dir`, mastered, or null when the page has no score. */
async function prepareMusic(page: Page, ffmpeg: string, dir: string): Promise<Music | null> {
  const base64 = await page.run<string | null>('window.RegattaVideo.renderAudio()', AUDIO_TIMEOUT_MS, 'The music took too long to render.')
  const scoreError = (await page.errors()).find((message) => message.startsWith('score:'))
  if (scoreError) throw new JobError(`The music code failed: ${scoreError}`, 'page')
  if (!base64) return null
  mkdirSync(dir, { recursive: true })
  const wav = join(dir, 'audio.wav')
  writeFileSync(wav, Buffer.from(base64, 'base64'))
  return masterMusic(ffmpeg, dir, wav)
}

/** Waits until ffmpeg's input can take more, or ffmpeg is gone. Gives up if it just sits there. */
async function waitForDrain(stdin: NodeJS.WritableStream, closed: Promise<number | null>): Promise<void> {
  let timer: NodeJS.Timeout | undefined
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new JobError('ffmpeg stopped taking frames.', 'system')), DRAIN_TIMEOUT_MS)
  })
  const drained = new Promise<void>((resume) => stdin.once('drain', resume))
  try {
    await Promise.race([drained, closed.then(() => undefined), timeout])
  } finally {
    clearTimeout(timer)
  }
}

/** The render job: every frame in order, into ffmpeg's stdin, then the mastered music muxed in. */
async function runRender(job: RenderJob, page: Page, comp: Composition, viewport: Viewport, dir: string): Promise<void> {
  const ffmpeg = job.ffmpeg
  if (!ffmpeg) throw new JobError('ffmpeg was not found on PATH.', 'system')
  const mismatch = sizeMismatch(comp.declared, job)
  if (mismatch) throw new JobError(mismatch, 'page')
  const frames = Math.round(comp.duration * job.fps)
  if (!(frames >= 1)) throw new JobError('The video has no frames to render.', 'page')
  mkdirSync(dirname(job.out), { recursive: true })

  const music = await prepareMusic(page, ffmpeg, dir)

  const args = ['-y', '-f', 'rawvideo', '-pix_fmt', 'bgra', '-s', `${job.width}x${job.height}`, '-r', String(job.fps), '-i', '-']
  if (music) args.push('-i', music.file)
  args.push('-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '18', '-preset', 'medium')
  if (music) args.push('-c:a', 'aac', '-b:a', '192k', '-shortest')
  args.push(job.out)

  const child = spawn(ffmpeg, args, { stdio: ['pipe', 'ignore', 'pipe'] })
  cleanups.push((ok) => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
    // A render that did not finish leaves no half-written file behind.
    if (!ok) rmSync(job.out, { force: true })
  })
  let tail = ''
  child.stderr?.on('data', (chunk: Buffer) => {
    tail = (tail + chunk.toString()).slice(-4000)
  })
  let spawnError = ''
  const closed = new Promise<number | null>((done) => {
    child.on('error', (err) => {
      spawnError = err.message
      done(null)
    })
    child.on('close', (code) => done(code))
  })
  const stdin = child.stdin
  if (!stdin) throw new JobError('ffmpeg did not start.', 'system')
  let broken = false
  // ffmpeg closing its end early shows up as a write error; its exit code and last words say why.
  stdin.on('error', () => {
    broken = true
  })
  log({ frames })

  let sent = 0
  for (let i = 0; i < frames; i++) {
    const bitmap = bitmapOf(await page.capture(i / job.fps), job)
    if (broken || child.exitCode !== null) break
    if (!stdin.write(bitmap)) {
      // ffmpeg reads slower than we draw, so wait for it to ask for more.
      await waitForDrain(stdin, closed)
    }
    sent++
    log({ frame: sent, of: frames })
  }
  stdin.end()
  const code = await closed
  if (code !== 0 || broken || sent < frames) {
    throw new JobError(`ffmpeg ${spawnError ? `could not run: ${spawnError}` : `exited with code ${code}`}. ${lastLine(tail)}`.trim(), 'system')
  }
  if (!existsSync(job.out) || statSync(job.out).size === 0) throw new JobError('ffmpeg wrote no video.', 'system')

  let loudness: number | null = null
  if (music) {
    const measured = await runFfmpeg(ffmpeg, ['-hide_banner', '-nostats', '-i', job.out, '-map', '0:a:0', '-af', 'ebur128', '-f', 'null', '-'])
    loudness = integratedLoudness(measured.stderr)
  }

  writeReport(job, {
    kind: 'render',
    ok: true,
    errors: comp.errors,
    duration: comp.duration,
    fps: comp.declared.fps,
    scenes: comp.scenes,
    thumbnails: [],
    loads: loadsCheck(comp.duration, comp.scenes.length, comp.errors, null),
    stable: notChecked('stable', 'a render does not run the checks.'),
    captions: captionsCheck(comp.duration, comp.captions),
    samples: [],
    maxDiff: 0,
    viewport,
    frames,
    framesDone: frames,
    sizeBytes: statSync(job.out).size,
    loudness,
    ...(music?.note ? { note: music.note } : {}),
    out: job.out
  })
  log({ done: true, frames, loudness })
  finish(0)
}

// ---------------------------------------------------------------------------------------------
// Start

async function runJob(job: RenderJob, dir: string): Promise<void> {
  try {
    const page = await openPage(job)
    const viewport = await settleViewport(page, job)
    const comp = await readComposition(page)
    if (job.kind === 'check') await runCheck(job, page, comp, viewport)
    else await runRender(job, page, comp, viewport, dir)
  } catch (err) {
    fail(job, errorText(err), err instanceof JobError ? err.source : 'system')
  }
}

function readJob(jobFile: string): RenderJob {
  const job = JSON.parse(readFileSync(jobFile, 'utf8')) as Partial<RenderJob>
  const whole = (n: unknown): n is number => typeof n === 'number' && Number.isInteger(n) && n > 0
  if (
    typeof job.folder !== 'string' ||
    typeof job.report !== 'string' ||
    typeof job.out !== 'string' ||
    !whole(job.width) ||
    !whole(job.height) ||
    !whole(job.fps) ||
    (job.kind !== 'render' && job.kind !== 'check') ||
    (job.ffmpeg !== null && typeof job.ffmpeg !== 'string')
  ) {
    throw new Error('The job file is not a render job.')
  }
  return job as RenderJob
}

/** Runs the job in the job file and quits the app. Called instead of the normal app start. */
export function runRenderJob(jobFile: string): void {
  let job: RenderJob
  try {
    job = readJob(jobFile)
  } catch (err) {
    console.error(`The render job could not be read: ${errorText(err)}`)
    app.exit(1)
    return
  }
  // This process shows nothing anyone should see, so it takes no place in the Dock either.
  if (process.platform === 'darwin') app.setActivationPolicy('accessory')
  app.disableHardwareAcceleration()
  // The same picture on every screen: no GPU compositing, no text smoothing, no hinting, sRGB.
  // On macOS the color profile switch only reaches the browser process when it is on the command
  // line the process was started with (spawnRender in src/main/index.ts can add
  // --force-color-profile=srgb); appended here it can only reach the helper processes.
  app.commandLine.appendSwitch('disable-gpu-compositing')
  app.commandLine.appendSwitch('disable-lcd-text')
  app.commandLine.appendSwitch('force-color-profile', 'srgb')
  app.commandLine.appendSwitch('font-render-hinting', 'none')
  // The profile and the scratch files live next to the job file. Whoever wrote the job file deletes
  // that folder when this process is gone, so nothing is left behind, even after a kill.
  const dir = join(dirname(jobFile), 'render-work')
  try {
    mkdirSync(join(dir, 'user-data'), { recursive: true })
    app.setPath('userData', join(dir, 'user-data'))
  } catch {
    // A profile folder that cannot be moved is not worth failing over.
  }
  // Stopping the render sends SIGTERM, which Electron turns into a quit. Stop ffmpeg and drop any
  // half-written file on the way out.
  app.on('before-quit', () => {
    if (finished) return
    finished = true
    for (const fn of cleanups.splice(0).reverse()) {
      try {
        fn(false)
      } catch {
        // Best effort.
      }
    }
    app.exit(1)
  })
  // An error nobody caught would otherwise open a dialog and wait for a click that never comes.
  process.on('uncaughtException', (err) => fail(job, errorText(err), 'system'))
  process.on('unhandledRejection', (reason) => fail(job, errorText(reason), 'system'))
  app.whenReady().then(() => {
    void runJob(job, dir)
  })
}
