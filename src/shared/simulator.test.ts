import { describe, expect, it } from 'vitest'
import {
  displayLabel,
  hidUsageForCode,
  normalizeSimulatorConfig,
  normalizeSimulatorInput,
  pointerToScreenRatio
} from './simulator'

const UDID = '29AC4878-5509-4AAE-B3D1-AB72177B4549'

describe('normalizeSimulatorConfig', () => {
  it('keeps a valid udid (upper-cased) and its name', () => {
    expect(normalizeSimulatorConfig({ udid: UDID.toLowerCase(), name: 'iPhone Duo' })).toEqual({ udid: UDID, name: 'iPhone Duo' })
  })
  it('turns anything else into an unconfigured node', () => {
    expect(normalizeSimulatorConfig({ udid: 'x; rm -rf ~' })).toEqual({})
    expect(normalizeSimulatorConfig(null)).toEqual({})
    expect(normalizeSimulatorConfig({ udid: UDID, name: 'a\nb' })).toEqual({ udid: UDID })
  })
})

describe('normalizeSimulatorInput', () => {
  it('rebuilds touches, clamping to the screen', () => {
    expect(normalizeSimulatorInput({ t: 'down', x: 0.5, y: 1.4, extra: 'x' })).toEqual({ t: 'down', x: 0.5, y: 1 })
    expect(normalizeSimulatorInput({ t: 'move', x: 'NaN', y: 0 })).toBeNull()
  })
  it('accepts only HID usages, known buttons and display indexes', () => {
    expect(normalizeSimulatorInput({ t: 'key', usage: 4, down: true })).toEqual({ t: 'key', usage: 4, down: true })
    expect(normalizeSimulatorInput({ t: 'key', usage: 999, down: true })).toBeNull()
    expect(normalizeSimulatorInput({ t: 'button', name: 'home' })).toEqual({ t: 'button', name: 'home' })
    expect(normalizeSimulatorInput({ t: 'button', name: 'reboot' })).toBeNull()
    expect(normalizeSimulatorInput({ t: 'display', index: -1 })).toEqual({ t: 'display', index: -1 })
    expect(normalizeSimulatorInput({ t: 'shell', cmd: 'x' })).toBeNull()
  })
})

describe('pointerToScreenRatio', () => {
  // A 1000×2000 frame contained in a 400×400 box is drawn 200×400, with 100 px bars left and right.
  it('maps through the letterbox', () => {
    expect(pointerToScreenRatio(200, 200, 400, 400, 1000, 2000)).toEqual({ x: 0.5, y: 0.5 })
    expect(pointerToScreenRatio(100, 0, 400, 400, 1000, 2000)).toEqual({ x: 0, y: 0 })
    expect(pointerToScreenRatio(300, 400, 400, 400, 1000, 2000)).toEqual({ x: 1, y: 1 })
  })
  it('is null in the bars and for an unknown frame', () => {
    expect(pointerToScreenRatio(50, 200, 400, 400, 1000, 2000)).toBeNull()
    expect(pointerToScreenRatio(10, 10, 400, 400, 0, 0)).toBeNull()
  })
  it('is unit-free, so a zoomed canvas (client pixels on both sides) maps the same', () => {
    expect(pointerToScreenRatio(400, 400, 800, 800, 1000, 2000)).toEqual({ x: 0.5, y: 0.5 })
  })
})

describe('hidUsageForCode', () => {
  it('maps physical keys to HID keyboard usages', () => {
    expect(hidUsageForCode('KeyA')).toBe(0x04)
    expect(hidUsageForCode('KeyZ')).toBe(0x1d)
    expect(hidUsageForCode('Digit1')).toBe(0x1e)
    expect(hidUsageForCode('Digit0')).toBe(0x27)
    expect(hidUsageForCode('Enter')).toBe(0x28)
    expect(hidUsageForCode('Backspace')).toBe(0x2a)
    expect(hidUsageForCode('ArrowUp')).toBe(0x52)
    expect(hidUsageForCode('ShiftLeft')).toBe(0xe1)
  })
  it('knows nothing it was not given (including prototype names)', () => {
    expect(hidUsageForCode('MediaPlayPause')).toBeUndefined()
    expect(hidUsageForCode('toString')).toBeUndefined()
  })
})

describe('displayLabel', () => {
  const cover = { index: 1, width: 1398, height: 2034, name: 'LCD' }
  const inner = { index: 0, width: 2007, height: 2853, name: 'LCD-1' }
  it('names a foldable’s screens by size, and a single screen plainly', () => {
    expect(displayLabel(inner, [inner, cover])).toBe('Inner')
    expect(displayLabel(cover, [inner, cover])).toBe('Cover')
    expect(displayLabel(cover, [cover])).toBe('Screen')
  })
})
