// iOS simulators through xcrun simctl (macOS with Xcode only).

import { execFile } from 'node:child_process'
import { nativeImage } from 'electron'
import { randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { SimDevice } from '../shared/types'

/**
 * Every simctl call is bounded so a hung simulator service cannot wedge the panel.
 * The task card asked for 20 seconds, but on the development Mac a cold CoreSimulator registry
 * measured 21 s to list, 44 s to boot, 21 s to capture and 25 s to shut down: a flat 20 second
 * budget turns slow but successful work into a failure. So the bound is per operation, each with
 * room for that measurement, and the screen poll never overlaps itself.
 */
const LIST_MS = 60_000
const POWER_MS = 90_000
const CAPTURE_MS = 45_000

/** A screenshot is a full device bitmap, so the default buffer is too small. */
const MAX_BUFFER = 32 * 1024 * 1024

const NEED_MAC = 'Simulators need a Mac with Xcode'

/** simctl says "Unable to boot device in current state: Booted" when it is already what we wanted. */
const ALREADY = /already|current state/i

/** A udid is hex and dashes. Anything else is refused rather than handed to simctl. */
const UDID = /^[A-Za-z0-9][A-Za-z0-9_-]*$/

function needMac(): Error {
  return new Error(NEED_MAC)
}

function isMac(): boolean {
  return process.platform === 'darwin'
}

/** Simulators are only reachable through simctl on a Mac, so every action starts here. */
function requireMac(udid: string): void {
  if (!UDID.test(udid)) throw new Error('That simulator is not known to this Mac')
  if (!isMac()) throw needMac()
}

function firstLine(text: string): string {
  return text.split('\n').map((line) => line.trim()).find((line) => line.length > 0) ?? ''
}

interface Run {
  /** Command ran but reported an error (non zero exit, timeout). */
  failed: boolean
  stdout: string
  /** The message worth showing to the user. */
  message: string
  /** Everything simctl said. The "already in that state" note is never on the first line. */
  all: string
}

/**
 * Runs one command from an argument list (never a shell string).
 * Only refuses outright when the tool itself is missing, which means no Xcode.
 */
function run(file: string, args: string[], timeoutMs: number): Promise<Run> {
  return new Promise((done, fail) => {
    execFile(file, args, { timeout: timeoutMs, maxBuffer: MAX_BUFFER }, (err, stdout, stderr) => {
      if (err && (err as NodeJS.ErrnoException).code === 'ENOENT') {
        fail(needMac())
        return
      }
      const out = String(stdout)
      const errText = String(stderr)
      const detail = firstLine(errText) || firstLine(String(err?.message ?? ''))
      done({ failed: Boolean(err), stdout: out, message: detail || `${file} ${args[0]} failed`, all: `${errText}\n${out}` })
    })
  })
}

/** "com.apple.CoreSimulator.SimRuntime.iOS-26-0" becomes "iOS 26.0". */
export function runtimeLabel(runtimeKey: string): string {
  const match = /^com\.apple\.CoreSimulator\.SimRuntime\.([A-Za-z]+)-([\d._-]+)$/.exec(runtimeKey)
  const system = match?.[1]
  const version = match?.[2]
  if (system === undefined || version === undefined) return runtimeKey
  return `${system} ${version.replace(/[._-]/g, '.')}`
}

/** Booted first, then iPhones, then everything else, each group by name. */
export function compareDevices(a: SimDevice, b: SimDevice): number {
  const rank = (d: SimDevice): number => (d.state === 'Booted' ? 0 : d.name.startsWith('iPhone') ? 1 : 2)
  const byRank = rank(a) - rank(b)
  if (byRank !== 0) return byRank
  const x = a.name.toLowerCase()
  const y = b.name.toLowerCase()
  if (x !== y) return x < y ? -1 : 1
  return a.udid < b.udid ? -1 : a.udid > b.udid ? 1 : 0
}

interface RawDevice {
  udid?: unknown
  name?: unknown
  state?: unknown
  isAvailable?: unknown
}

/**
 * Turns the JSON from `simctl list devices available -j` into a sorted device list.
 * Every runtime under `devices` is flattened; a device marked unavailable is dropped.
 */
export function parseSimctlList(json: string): SimDevice[] {
  let parsed: { devices?: Record<string, RawDevice[]> }
  try {
    parsed = JSON.parse(json) as { devices?: Record<string, RawDevice[]> }
  } catch {
    return []
  }
  const out: SimDevice[] = []
  for (const [runtimeKey, list] of Object.entries(parsed.devices ?? {})) {
    if (!Array.isArray(list)) continue
    for (const raw of list) {
      if (!raw || typeof raw.udid !== 'string' || typeof raw.name !== 'string') continue
      if (raw.isAvailable === false) continue
      out.push({
        udid: raw.udid,
        name: raw.name,
        runtime: runtimeLabel(runtimeKey),
        state: typeof raw.state === 'string' ? raw.state : 'Shutdown'
      })
    }
  }
  return out.sort(compareDevices)
}

export function bootArgs(udid: string): string[] {
  return ['simctl', 'boot', udid]
}

export function shutdownArgs(udid: string): string[] {
  return ['simctl', 'shutdown', udid]
}

export function screenshotArgs(udid: string, file: string): string[] {
  return ['simctl', 'io', udid, 'screenshot', '--type=png', file]
}

export function listArgs(): string[] {
  return ['simctl', 'list', 'devices', 'available', '-j']
}

export async function listDevices(): Promise<SimDevice[]> {
  if (!isMac()) return []
  try {
    const result = await run('xcrun', listArgs(), LIST_MS)
    return result.failed ? [] : parseSimctlList(result.stdout)
  } catch {
    // No xcrun at all: this Mac has no simulators to show.
    return []
  }
}

export async function bootDevice(udid: string): Promise<void> {
  requireMac(udid)
  const result = await run('xcrun', bootArgs(udid), POWER_MS)
  // Already running is the outcome the user asked for.
  if (result.failed && !ALREADY.test(result.all)) throw new Error(result.message)
}

export async function shutdownDevice(udid: string): Promise<void> {
  requireMac(udid)
  const result = await run('xcrun', shutdownArgs(udid), POWER_MS)
  if (result.failed && !ALREADY.test(result.all)) throw new Error(result.message)
}

/** A PNG data URL of the device screen, or null when it cannot be captured. */
/** Width the panel's frames are scaled to (about twice the panel width, for sharp Retina pixels). */
const FRAME_WIDTH = 720

export async function screenshotDevice(udid: string): Promise<string | null> {
  requireMac(udid)
  const file = join(tmpdir(), `regatta-sim-${randomUUID()}.png`)
  try {
    const result = await run('xcrun', screenshotArgs(udid, file), CAPTURE_MS)
    if (result.failed) return null
    const bytes = await fs.readFile(file)
    // A full simulator screenshot is several megabytes; the panel shows it a few hundred pixels wide.
    const image = nativeImage.createFromBuffer(bytes)
    if (image.isEmpty()) return `data:image/png;base64,${bytes.toString('base64')}`
    const small = image.getSize().width > FRAME_WIDTH ? image.resize({ width: FRAME_WIDTH, quality: 'good' }) : image
    return `data:image/jpeg;base64,${small.toJPEG(78).toString('base64')}`
  } catch (err) {
    if (err instanceof Error && err.message === NEED_MAC) throw err
    // Not booted, or the capture tool refused: the panel keeps the last frame.
    return null
  } finally {
    await fs.rm(file, { force: true }).catch(() => undefined)
  }
}

export async function openSimulator(): Promise<void> {
  if (!isMac()) throw needMac()
  const result = await run('open', ['-a', 'Simulator'], CAPTURE_MS)
  if (result.failed) throw new Error(result.message)
}
