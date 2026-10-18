// Simulator list parsing and command building. The simctl calls themselves need a Mac, so they are
// covered by the end to end check instead.

import { describe, expect, it } from 'vitest'
import {
  bootArgs,
  compareDevices,
  listArgs,
  parseSimctlList,
  runtimeLabel,
  screenshotArgs,
  shutdownArgs
} from './device'
import type { SimDevice } from '../shared/types'

/** Trimmed down from a real `xcrun simctl list devices available -j` response. */
const SAMPLE = JSON.stringify({
  devices: {
    'com.apple.CoreSimulator.SimRuntime.iOS-26-0': [
      { udid: 'IPAD-1', name: 'iPad Pro 13-inch (M5)', state: 'Shutdown', isAvailable: true },
      { udid: 'IPHONE-17-PRO', name: 'iPhone 17 Pro', state: 'Shutdown', isAvailable: true },
      { udid: 'GONE', name: 'iPhone 16', state: 'Shutdown', isAvailable: false }
    ],
    'com.apple.CoreSimulator.SimRuntime.iOS-18-5': [
      { udid: 'SE-2', name: 'iPhone SE (3rd generation)', state: 'Booted', isAvailable: true },
      { udid: 'PAD-A', name: 'Apple TV 4K (3rd generation)', state: 'Shutdown', isAvailable: true }
    ]
  }
})

function pick(list: SimDevice[], udid: string): SimDevice {
  const found = list.find((d) => d.udid === udid)
  if (!found) throw new Error(`${udid} missing`)
  return found
}

describe('runtimeLabel', () => {
  it('reads the system name and version out of a runtime identifier', () => {
    expect(runtimeLabel('com.apple.CoreSimulator.SimRuntime.iOS-26-0')).toBe('iOS 26.0')
    expect(runtimeLabel('com.apple.CoreSimulator.SimRuntime.iOS-18-5')).toBe('iOS 18.5')
    expect(runtimeLabel('com.apple.CoreSimulator.SimRuntime.iOS-17-2-1')).toBe('iOS 17.2.1')
    expect(runtimeLabel('com.apple.CoreSimulator.SimRuntime.watchOS-11-0')).toBe('watchOS 11.0')
  })

  it('leaves anything it does not recognize as it was', () => {
    expect(runtimeLabel('com.apple.CoreSimulator.SimRuntime.tvOS')).toBe('com.apple.CoreSimulator.SimRuntime.tvOS')
  })
})

describe('parseSimctlList', () => {
  const list = parseSimctlList(SAMPLE)

  it('flattens every runtime and names each one', () => {
    expect(list.map((d) => d.udid)).toEqual(['SE-2', 'IPHONE-17-PRO', 'PAD-A', 'IPAD-1'])
    expect(pick(list, 'IPHONE-17-PRO').runtime).toBe('iOS 26.0')
    expect(pick(list, 'SE-2').runtime).toBe('iOS 18.5')
    expect(pick(list, 'SE-2').state).toBe('Booted')
    expect(pick(list, 'IPAD-1').name).toBe('iPad Pro 13-inch (M5)')
  })

  it('drops devices that are not available', () => {
    expect(list.some((d) => d.udid === 'GONE')).toBe(false)
    expect(list).toHaveLength(4)
  })

  it('puts a booted device first, then iPhones, then the rest, each by name', () => {
    const sorted = [
      ...parseSimctlList(
        JSON.stringify({
          devices: {
            'com.apple.CoreSimulator.SimRuntime.iOS-26-0': [
              { udid: 'B', name: 'iPhone Air', state: 'Shutdown', isAvailable: true },
              { udid: 'A', name: 'iPad mini', state: 'Shutdown', isAvailable: true }
            ]
          }
        })
      )
    ]
    expect(sorted.map((d) => d.udid)).toEqual(['B', 'A'])
    // The order argument is what the panel relies on, so check it directly too.
    const booted: SimDevice = { udid: 'C', name: 'iPhone 17', runtime: 'iOS 26.0', state: 'Booted' }
    expect(compareDevices(booted, pick(list, 'IPHONE-17-PRO'))).toBeLessThan(0)
    expect(compareDevices(pick(list, 'IPHONE-17-PRO'), pick(list, 'PAD-A'))).toBeLessThan(0)
    expect(compareDevices({ ...booted, state: 'Shutdown' }, pick(list, 'PAD-A'))).toBeLessThan(0)
  })

  it('handles an empty or unreadable response', () => {
    expect(parseSimctlList('{"devices":{}}')).toEqual([])
    expect(parseSimctlList('not json')).toEqual([])
    expect(parseSimctlList('')).toEqual([])
    expect(parseSimctlList(JSON.stringify({ devices: { 'x': 'no list' } }))).toEqual([])
  })

  it('keeps a device with no state field', () => {
    const one = parseSimctlList(JSON.stringify({ devices: { 'com.apple.CoreSimulator.SimRuntime.iOS-26-0': [{ udid: 'U', name: 'iPhone 17 Pro', isAvailable: true }] } }))
    expect(one[0]?.state).toBe('Shutdown')
  })
})

describe('simctl arguments', () => {
  it('lists what is available as JSON', () => {
    expect(listArgs()).toEqual(['simctl', 'list', 'devices', 'available', '-j'])
  })

  it('builds boot, shutdown and screenshot calls', () => {
    expect(bootArgs('UDID-1')).toEqual(['simctl', 'boot', 'UDID-1'])
    expect(shutdownArgs('UDID-1')).toEqual(['simctl', 'shutdown', 'UDID-1'])
    expect(screenshotArgs('UDID-1', '/tmp/s.png')).toEqual(['simctl', 'io', 'UDID-1', 'screenshot', '--type=png', '/tmp/s.png'])
  })

  it('refuses a device id that is not a plain token', async () => {
    const { bootDevice, shutdownDevice, screenshotDevice } = await import('./device')
    await expect(bootDevice('--delete-all')).rejects.toThrow('not known to this Mac')
    await expect(shutdownDevice('a b; rm -r /')).rejects.toThrow('not known to this Mac')
    await expect(screenshotDevice('')).rejects.toThrow('not known to this Mac')
  })
})
