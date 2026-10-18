// Video rendering end to end: the built app binary in render mode checks the example video and
// renders it to MP4, and a handful of small pages prove the checks can fail. The app never opens a
// window; the render process is the whole test. No agent CLI is started and no network is used.

import { spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { inflateSync } from 'node:zlib'
import { repo } from './lib.mjs'

const width = 1280
const height = 720
const fps = 30
const frames = 360
const seconds = 12

// ---------------------------------------------------------------------------------------------
// Helpers

/** Runs the built app in render mode on a job file, the way the engine does, and waits for it. */
function runJob(jobFile, { timeout = 180000 } = {}) {
  const env = { ...process.env, REGATTA_TEST: '1' }
  delete env['ELECTRON_RUN_AS_NODE']
  const child = spawn(process.execPath, [join(repo, 'node_modules', 'electron', 'cli.js'), repo, `--regatta-render=${jobFile}`], {
    cwd: repo,
    env,
    stdio: ['ignore', 'pipe', 'pipe']
  })
  let stdout = ''
  let stderr = ''
  child.stdout.on('data', (chunk) => {
    stdout += chunk.toString()
  })
  child.stderr.on('data', (chunk) => {
    stderr = (stderr + chunk.toString()).slice(-4000)
  })
  const done = new Promise((resolve) => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
    }, timeout)
    child.on('close', (code, signal) => {
      clearTimeout(timer)
      resolve({ code, signal, stdout, stderr })
    })
  })
  return { child, done, output: () => stdout }
}

function onPath(name) {
  for (const dir of (process.env['PATH'] ?? '').split(':')) {
    if (!dir) continue
    const candidate = join(dir, name)
    try {
      if (statSync(candidate).isFile()) return candidate
    } catch {
      // not here
    }
  }
  return null
}

/** An executable called `name` next to another one, or else on the PATH. */
function findBeside(name, nextTo) {
  const beside = join(dirname(nextTo), name)
  return existsSync(beside) ? beside : onPath(name)
}

function sha(buffer) {
  return createHash('sha256').update(buffer).digest('hex')
}

/** Decodes an 8 bit RGB or RGBA PNG without a library. Throws when the bytes are not a PNG. */
function decodePng(buffer) {
  if (buffer.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a') throw new Error('not a PNG: the signature is wrong')
  let at = 8
  let size = null
  const parts = []
  while (at < buffer.length) {
    const length = buffer.readUInt32BE(at)
    const type = buffer.toString('ascii', at + 4, at + 8)
    const data = buffer.subarray(at + 8, at + 8 + length)
    if (type === 'IHDR') size = { width: data.readUInt32BE(0), height: data.readUInt32BE(4), depth: data[8], colorType: data[9], interlace: data[12] }
    else if (type === 'IDAT') parts.push(data)
    else if (type === 'IEND') break
    at += 12 + length
  }
  if (!size || size.depth !== 8 || size.interlace !== 0 || (size.colorType !== 6 && size.colorType !== 2)) {
    throw new Error(`a PNG this test cannot read: ${JSON.stringify(size)}`)
  }
  const channels = size.colorType === 6 ? 4 : 3
  const raw = inflateSync(Buffer.concat(parts))
  const stride = size.width * channels
  const pixels = Buffer.alloc(size.height * stride)
  for (let y = 0; y < size.height; y++) {
    const filter = raw[y * (stride + 1)]
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1))
    const above = y > 0 ? pixels.subarray((y - 1) * stride, y * stride) : null
    const row = pixels.subarray(y * stride, (y + 1) * stride)
    for (let x = 0; x < stride; x++) {
      const left = x >= channels ? row[x - channels] : 0
      const up = above ? above[x] : 0
      const upLeft = above && x >= channels ? above[x - channels] : 0
      let value = line[x]
      if (filter === 1) value += left
      else if (filter === 2) value += up
      else if (filter === 3) value += (left + up) >> 1
      else if (filter === 4) {
        const p = left + up - upLeft
        const pa = Math.abs(p - left)
        const pb = Math.abs(p - up)
        const pc = Math.abs(p - upLeft)
        value += pa <= pb && pa <= pc ? left : pb <= pc ? up : upLeft
      }
      row[x] = value & 255
    }
  }
  return {
    width: size.width,
    height: size.height,
    pixels,
    /** The [r, g, b] of one pixel. */
    at: (x, y) => {
      const i = (y * size.width + x) * channels
      return [pixels[i], pixels[i + 1], pixels[i + 2]]
    }
  }
}

/** The largest difference in any channel between two decoded PNGs of the same size. */
function pngDistance(a, b) {
  let max = 0
  for (let i = 0; i < a.pixels.length; i++) max = Math.max(max, Math.abs(a.pixels[i] - b.pixels[i]))
  return max
}

/**
 * True when a pixel is the named pure color, judged by which channels are high and which are low.
 * It is loose on purpose: these checks are about geometry (the right color in the right place,
 * edge to edge, not cropped, not the frame before), and a wide screen's own color profile moves a
 * pure red to (234, 51, 35) without moving it anywhere near another color.
 */
function looksLike(color, name) {
  const [r, g, b] = color
  if (name === 'red') return r >= 200 && g <= 150 && b <= 150
  if (name === 'green') return g >= 200 && r <= 150 && b <= 150
  if (name === 'blue') return b >= 200 && r <= 150 && g <= 150
  if (name === 'yellow') return r >= 200 && g >= 200 && b <= 150
  return false
}

/** Integrated loudness (LUFS) from the summary ffmpeg's ebur128 filter prints at the end. */
function loudnessOf(ffmpeg, file) {
  const run = spawnSync(ffmpeg, ['-hide_banner', '-nostats', '-i', file, '-map', '0:a:0', '-af', 'ebur128', '-f', 'null', '-'], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024
  })
  const log = String(run.stderr)
  const summary = log.lastIndexOf('Summary:')
  const match = summary >= 0 ? log.slice(summary).match(/I:\s*(-?\d+(?:\.\d+)?)\s*LUFS/) : null
  return match ? Number(match[1]) : null
}

/** One value of ffprobe's output for a stream or the format. */
function probe(ffprobe, file, selectStream, entries) {
  const args = ['-v', 'error']
  if (selectStream) args.push('-select_streams', selectStream)
  args.push('-show_entries', entries, '-of', 'default=nw=1', file)
  const run = spawnSync(ffprobe, args, { encoding: 'utf8' })
  const values = {}
  for (const line of String(run.stdout).split('\n')) {
    const at = line.indexOf('=')
    if (at > 0) values[line.slice(0, at)] = line.slice(at + 1).trim()
  }
  return values
}

/** A video folder: the runtime files and an index.html. */
function makeFolder(root, name, html) {
  const folder = join(root, name)
  mkdirSync(folder, { recursive: true })
  for (const file of ['regatta-video.js', 'regatta-video.css']) cpSync(join(repo, 'resources', 'video', file), join(folder, file))
  writeFileSync(join(folder, 'index.html'), html)
  return folder
}

/** A page with the usual head and the given scenes and script. */
function page({ meta = `width=${width},height=${height},fps=${fps}`, runtime = true, body, script = '' }) {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="regatta-video" content="${meta}">
<link rel="stylesheet" href="regatta-video.css">${runtime ? '<script src="regatta-video.js"></script>' : ''}
<style>.fill{position:absolute;left:0;top:0;width:100%;height:100%}</style></head>
<body><main id="stage">${body}</main><script>${script}</script></body></html>`
}

function writeJob(root, name, job) {
  const jobFile = join(root, `${name}-job.json`)
  writeFileSync(jobFile, JSON.stringify({ width, height, fps, out: '', ffmpeg: null, ...job, report: join(root, `${name}-report.json`) }))
  return { jobFile, reportFile: join(root, `${name}-report.json`) }
}

/** Runs a check job on a folder and returns its report, or null when the process left none. */
async function check(root, name, folder) {
  const { jobFile, reportFile } = writeJob(root, name, { folder, kind: 'check' })
  const result = await runJob(jobFile).done
  return { report: existsSync(reportFile) ? JSON.parse(readFileSync(reportFile, 'utf8')) : null, result }
}

// ---------------------------------------------------------------------------------------------
// The test

export default async function videoRender() {
  const root = mkdtempSync(join(tmpdir(), 'regatta-video-e2e-'))
  const results = []
  const verify = (label, ok, detail = '') => {
    results.push({ label, ok: Boolean(ok) })
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  (${detail})` : ''}`)
  }

  try {
    // ----- 1. The example video: the check -----------------------------------------------------
    const example = join(root, 'example')
    mkdirSync(example, { recursive: true })
    cpSync(join(repo, 'resources', 'video', 'example'), example, { recursive: true })
    for (const file of ['regatta-video.js', 'regatta-video.css']) cpSync(join(repo, 'resources', 'video', file), join(example, file))

    const first = await check(root, 'example-check', example)
    const report = first.report
    if (!report) {
      verify('the check runs', false, `no report (exit ${first.result.code}): ${first.result.stderr.slice(0, 300)}`)
      return results
    }
    verify('the check exits cleanly', report.ok === true && first.result.code === 0, `exit ${first.result.code}`)
    verify('the example loads with no script errors', report.errors.length === 0, report.errors.join('; ').slice(0, 200))
    verify('the loads check passes', report.loads.passed, report.loads.detail)
    verify('the example is 12 s with 4 scenes', report.duration === seconds && report.scenes.length === 4, `${report.duration} s`)
    verify('the page is exactly the video size at a pixel ratio of 1', report.viewport && report.viewport.width === width && report.viewport.height === height && report.viewport.ratio === 1, JSON.stringify(report.viewport))
    verify('28 frames were sampled', report.samples.length === 28, `${report.samples.length}`)
    verify('every sampled frame rendered the same twice', report.stable.passed && report.stable.detail === '28 of 28 frames rendered the same twice', report.stable.detail)
    console.log(`  NOTE  the largest difference between two draws of a sampled frame was ${report.maxDiff} of 255 levels`)
    verify('no sampled frame differs by more than 2 levels in any color channel', report.samples.every((s) => s.maxDiff <= 2) && report.maxDiff <= 2, `largest ${report.maxDiff}`)
    verify('the captions check passes', report.captions.passed, report.captions.detail)

    // The thumbnails are real, whole, different pictures.
    const thumbs = report.scenes.map((scene) => join(example, 'thumbs', `${scene.id}.png`))
    verify('a thumbnail was written for every scene', thumbs.every((file) => existsSync(file)) && report.thumbnails.length === report.scenes.length, `${report.thumbnails.length} of ${report.scenes.length}`)
    let decoded = []
    try {
      decoded = thumbs.map((file) => decodePng(readFileSync(file)))
      verify('every thumbnail is a PNG of the whole frame', decoded.every((png) => png.width === width && png.height === height), decoded.map((png) => `${png.width}x${png.height}`).join(' '))
    } catch (err) {
      verify('every thumbnail is a PNG of the whole frame', false, err.message)
    }
    const hashes = thumbs.map((file) => sha(readFileSync(file)))
    verify('the four thumbnails are four different pictures', new Set(hashes).size === hashes.length)
    verify('a thumbnail is not blank', decoded.length > 0 && decoded.every((png) => new Set(Array.from({ length: 200 }, (_, i) => png.at((i * 53) % width, (i * 29) % height).join())).size > 3))

    // ----- 2. Geometry and color: four colored quarters ----------------------------------------
    const quarters = makeFolder(
      root,
      'quarters',
      page({
        body: `<section data-scene="quarters" data-title="Quarters" data-duration="3"><div class="fill" style="background:#000">
<div style="position:absolute;left:0;top:0;width:640px;height:360px;background:#ff0000"></div>
<div style="position:absolute;left:640px;top:0;width:640px;height:360px;background:#00ff00"></div>
<div style="position:absolute;left:0;top:360px;width:640px;height:360px;background:#0000ff"></div>
<div style="position:absolute;left:640px;top:360px;width:640px;height:360px;background:#ffff00"></div></div></section>`
      })
    )
    const quartersCheck = await check(root, 'quarters-check', quarters)
    const qReport = quartersCheck.report
    verify('a page of four colored quarters loads and is stable', qReport?.ok && qReport.loads.passed && qReport.stable.passed, qReport ? qReport.stable.detail : 'no report')
    const spots = [
      ['red', 4, 4],
      ['green', width - 5, 4],
      ['blue', 4, height - 5],
      ['yellow', width - 5, height - 5],
      ['red', 320, 180],
      ['yellow', 960, 540]
    ]
    try {
      const png = decodePng(readFileSync(join(quarters, 'thumbs', 'quarters.png')))
      const wrong = spots.filter(([color, x, y]) => !looksLike(png.at(x, y), color))
      verify('the thumbnail shows each quarter in its place and color, edge to edge', png.width === width && png.height === height && wrong.length === 0, wrong.map(([c, x, y]) => `${c}@${x},${y}=${png.at(x, y)}`).join(' '))
    } catch (err) {
      verify('the thumbnail shows each quarter in its place and color, edge to edge', false, err.message)
    }

    // ----- 3. A picture that is slow to draw is captured whole, not the frame before it ---------
    const heavyBoxes = Array.from({ length: 36 }, (_, i) => {
      const hue = (i * 37) % 360
      return `<div style="position:absolute;left:${(i * 97) % 900}px;top:${(i * 53) % 400}px;width:520px;height:340px;border-radius:40px;background:radial-gradient(circle at 30% 30%, hsl(${hue} 90% 60%), hsl(${(hue + 90) % 360} 80% 30%));filter:blur(24px);box-shadow:0 0 90px 30px hsla(${hue},90%,50%,0.5)"></div>`
    }).join('')
    const heavy = makeFolder(
      root,
      'heavy',
      page({
        // The second scene is short, so the first sample inside it is its middle: its thumbnail is the
        // very first frame drawn after the switch, which is the one that used to come out stale.
        body: `<section data-scene="calm" data-title="Calm" data-duration="3.25"><div class="fill" style="background:#123456"></div><h1 style="position:absolute;left:100px;top:100px;color:#fff;font:700 80px sans-serif">Calm</h1></section>
<section data-scene="heavy" data-title="Heavy" data-duration="0.5"><div class="fill" style="background:#000">${heavyBoxes}</div></section>`
      })
    )
    const heavyCheck = await check(root, 'heavy-check', heavy)
    const hReport = heavyCheck.report
    verify('a page with blurred, shadowed gradients loads and is stable', hReport?.ok && hReport.loads.passed && hReport.stable.passed, hReport ? hReport.stable.detail : 'no report')
    try {
      const calm = decodePng(readFileSync(join(heavy, 'thumbs', 'calm.png')))
      const slow = decodePng(readFileSync(join(heavy, 'thumbs', 'heavy.png')))
      const apart = pngDistance(calm, slow)
      verify('the first frame after a switch to a slow picture shows that picture, not the one before', apart > 60, `the two thumbnails differ by up to ${apart} levels`)
    } catch (err) {
      verify('the first frame after a switch to a slow picture shows that picture, not the one before', false, err.message)
    }

    // ----- 4. The checks can fail -------------------------------------------------------------
    const random = makeFolder(
      root,
      'random',
      page({
        body: `<section data-scene="noise" data-title="Noise" data-duration="3"><div class="fill" id="box"></div></section>`,
        script: `RegattaVideo.onSeek(function () { document.getElementById('box').style.background = 'rgb(' + ((Math.random() * 256) | 0) + ',' + ((Math.random() * 256) | 0) + ',' + ((Math.random() * 256) | 0) + ')' })`
      })
    )
    const randomCheck = await check(root, 'random-check', random)
    const rReport = randomCheck.report
    verify('a page that draws with Math.random fails the stability check', rReport?.ok && rReport.loads.passed && rReport.stable.passed === false, rReport ? rReport.stable.detail : 'no report')
    verify('and the report says how far apart the two draws were', rReport && rReport.maxDiff > 40 && /largest difference was \d+ of 255/.test(rReport.stable.detail), rReport ? `${rReport.maxDiff}` : '')

    const throws = makeFolder(
      root,
      'throws',
      page({
        body: `<section data-scene="a" data-title="A" data-duration="3"><div class="fill" style="background:#222"></div></section>`,
        script: `RegattaVideo.onSeek(function () { throw new Error('boom from onSeek') })`
      })
    )
    const throwsCheck = await check(root, 'throws-check', throws)
    verify('a page whose script throws fails the loads check, with the message', throwsCheck.report?.loads.passed === false && /boom from onSeek/.test(throwsCheck.report.loads.detail), throwsCheck.report?.loads.detail ?? 'no report')

    const badMusic = makeFolder(
      root,
      'bad-music',
      page({
        body: `<section data-scene="a" data-title="A" data-duration="3"><div class="fill" style="background:#222"></div></section>`,
        script: `RegattaVideo.score = function () { throw new Error('bad chord') }`
      })
    )
    const musicCheck = await check(root, 'bad-music-check', badMusic)
    verify('a score that throws fails the loads check, at check time and not only at render time', musicCheck.report?.loads.passed === false && /bad chord/.test(musicCheck.report.loads.detail), musicCheck.report?.loads.detail ?? 'no report')

    const offline = makeFolder(
      root,
      'offline',
      page({
        body: `<section data-scene="a" data-title="A" data-duration="3"><div class="fill" style="background:#222"></div><img src="https://regatta-offline-check.invalid/logo.png" alt=""></section>`
      })
    )
    const offlineCheck = await check(root, 'offline-check', offline)
    verify('a page that asks for something from the network fails the loads check and names it', offlineCheck.report?.loads.passed === false && /regatta-offline-check\.invalid/.test(offlineCheck.report.loads.detail), offlineCheck.report?.loads.detail ?? 'no report')

    const wrongSize = makeFolder(
      root,
      'wrong-size',
      page({
        meta: 'width=1920,height=1080,fps=60',
        body: `<section data-scene="a" data-title="A" data-duration="3"><div class="fill" style="background:#222"></div></section>`
      })
    )
    const sizeCheck = await check(root, 'wrong-size-check', wrongSize)
    verify('a page that declares another size fails the loads check', sizeCheck.report?.loads.passed === false && /1920x1080/.test(sizeCheck.report.loads.detail), sizeCheck.report?.loads.detail ?? 'no report')

    const noRuntime = makeFolder(root, 'no-runtime', page({ runtime: false, body: `<section data-scene="a" data-duration="3"></section>` }))
    const noRuntimeCheck = await check(root, 'no-runtime-check', noRuntime)
    verify(
      'a page without the runtime fails with a report that blames the page',
      noRuntimeCheck.report?.ok === false && noRuntimeCheck.report.failure === 'page' && noRuntimeCheck.result.code === 1 && /video runtime/.test(noRuntimeCheck.report.loads.detail),
      noRuntimeCheck.report ? noRuntimeCheck.report.loads.detail : 'no report'
    )

    const ffmpeg = onPath('ffmpeg')
    const ffprobe = ffmpeg ? findBeside('ffprobe', ffmpeg) : null
    if (!ffmpeg || !ffprobe) {
      console.log(`  NOTE  ${ffmpeg ? 'ffprobe was not found next to ffmpeg or on PATH' : 'ffmpeg is not on PATH'}, so the MP4 render was not run`)
      return results
    }

    // ----- 5. The example video: the render ---------------------------------------------------
    const out = join(root, 'regatta-launch.mp4')
    const { jobFile: renderJob, reportFile: renderReport } = writeJob(root, 'example-render', { folder: example, kind: 'render', out, ffmpeg })
    const started = Date.now()
    const rendered = await runJob(renderJob).done
    const took = (Date.now() - started) / 1000
    if (!existsSync(renderReport)) {
      verify('the render runs', false, `no report (exit ${rendered.code}): ${rendered.stderr.slice(0, 300)}`)
      return results
    }
    const rr = JSON.parse(readFileSync(renderReport, 'utf8'))
    verify('the render exits cleanly', rr.ok === true && rendered.code === 0, rr.error ?? `exit ${rendered.code}`)
    console.log(`  NOTE  rendered ${rr.frames} frames in ${took.toFixed(1)} s`)
    verify('progress was printed as JSON lines', /\{"frame":1,"of":360\}/.test(rendered.stdout) && /\{"frame":360,"of":360\}/.test(rendered.stdout))
    verify('the MP4 was written', existsSync(out) && statSync(out).size > 10000, `${existsSync(out) ? statSync(out).size : 0} bytes`)
    verify('the report carries the size of the file', existsSync(out) && rr.sizeBytes === statSync(out).size, `${rr.sizeBytes}`)

    const video = probe(ffprobe, out, 'v:0', 'stream=codec_name,width,height,nb_frames,r_frame_rate,pix_fmt')
    const container = probe(ffprobe, out, null, 'format=duration')
    verify('the video is H.264 at 1280x720', video['codec_name'] === 'h264' && Number(video['width']) === width && Number(video['height']) === height, `${video['codec_name']} ${video['width']}x${video['height']}`)
    verify('every frame is there: 360', Number(video['nb_frames']) === frames, `${video['nb_frames']} frames at ${video['r_frame_rate']}`)
    verify('it runs about 12 s', Math.abs(Number(container['duration']) - seconds) < 0.5, `${container['duration']} s`)
    const audio = probe(ffprobe, out, 'a:0', 'stream=codec_name,sample_rate,channels')
    verify('it has an AAC track', audio['codec_name'] === 'aac', audio['codec_name'])
    verify('the music is stereo at 48 kHz, as the page made it', audio['sample_rate'] === '48000' && audio['channels'] === '2', `${audio['sample_rate']} Hz, ${audio['channels']} channels`)
    const measured = loudnessOf(ffmpeg, out)
    verify('the music is mastered to within 1 LU of -14 LUFS (measured again here)', measured !== null && Math.abs(measured + 14) <= 1, `${measured} LUFS`)
    verify('the report carries the same loudness', rr.loudness !== null && measured !== null && Math.abs(rr.loudness - measured) <= 0.3, `${rr.loudness} LUFS in the report`)

    // ----- 6. A render with no music, and the frame it draws ---------------------------------
    const quietOut = join(root, 'quarters.mp4')
    const { jobFile: quietJob, reportFile: quietReport } = writeJob(root, 'quarters-render', { folder: quarters, kind: 'render', out: quietOut, ffmpeg })
    const quiet = await runJob(quietJob).done
    const qr = existsSync(quietReport) ? JSON.parse(readFileSync(quietReport, 'utf8')) : null
    verify('a page with no score renders, with no audio track and no loudness', qr?.ok === true && quiet.code === 0 && qr.loudness === null && probe(ffprobe, quietOut, 'a:0', 'stream=codec_name')['codec_name'] === undefined, qr ? `${qr.error ?? 'ok'}` : `exit ${quiet.code}`)
    const frame = spawnSync(ffmpeg, ['-v', 'error', '-i', quietOut, '-vf', 'select=eq(n\\,45)', '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], { maxBuffer: 16 * 1024 * 1024 })
    const raw = frame.stdout
    const pixel = (x, y) => [raw[(y * width + x) * 3], raw[(y * width + x) * 3 + 1], raw[(y * width + x) * 3 + 2]]
    if (raw && raw.length === width * height * 3) {
      const wrong = spots.filter(([color, x, y]) => !looksLike(pixel(x, y), color))
      verify('frame 45 of the MP4 shows each quarter in its place and color, edge to edge', wrong.length === 0, wrong.map(([c, x, y]) => `${c}@${x},${y}=${pixel(x, y)}`).join(' '))
    } else {
      verify('frame 45 of the MP4 shows each quarter in its place and color, edge to edge', false, `ffmpeg gave ${raw ? raw.length : 0} bytes`)
    }

    // ----- 7. Stop: the render process ends, takes ffmpeg with it and leaves no half file ------
    const stopOut = join(root, 'stopped.mp4')
    const { jobFile: stopJob } = writeJob(root, 'stopped-render', { folder: example, kind: 'render', out: stopOut, ffmpeg })
    const running = runJob(stopJob, { timeout: 60000 })
    const wait = Date.now()
    while (!/"frame":(3\d|[4-9]\d|\d{3})/.test(running.output()) && Date.now() - wait < 40000) await new Promise((resolve) => setTimeout(resolve, 100))
    const midway = /"frame":\d+/.test(running.output()) && !/"done":true/.test(running.output())
    running.child.kill('SIGTERM')
    const stopped = await running.done
    verify('Stop (SIGTERM) ends a render that is part way through, quickly', midway && stopped.signal === null && stopped.code !== 0 && Date.now() - wait < 40000, `exit ${stopped.code}, signal ${stopped.signal}`)
    const leftover = spawnSync('pgrep', ['-f', stopOut], { encoding: 'utf8' })
    if (leftover.error) console.log('  NOTE  pgrep is not available, so the check for a leftover ffmpeg was skipped')
    else verify('no ffmpeg is left running for it', leftover.status === 1, `pgrep: ${String(leftover.stdout).trim()}`)
    verify('no half-written MP4 is left', !existsSync(stopOut))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }

  return results
}
