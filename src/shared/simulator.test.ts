import { describe, expect, it } from 'vitest'
import {
  ORIENTATION_DEGREES,
  ORIENTATION_PURPLE,
  displayLabel,
  displayToFramebuffer,
  hidUsageForCode,
  rotateOrientation,
  type SimulatorOrientation,
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

describe('orientation', () => {
  it('turns a quarter at a time and comes back round', () => {
    let o: SimulatorOrientation = 'portrait'
    const seen: SimulatorOrientation[] = []
    for (let i = 0; i < 4; i++) seen.push((o = rotateOrientation(o, 'left')))
    expect(seen).toEqual(['landscape-left', 'portrait-upside-down', 'landscape-right', 'portrait'])
    expect(rotateOrientation('portrait', 'right')).toBe('landscape-right')
    expect(rotateOrientation(rotateOrientation('landscape-left', 'right'), 'left')).toBe('landscape-left')
  })

  it('maps a click on the turned picture back to the same framebuffer point the picture was drawn from', () => {
    // The node draws framebuffer (x,y) at this canvas point (SimulatorNode.paint's transforms).
    const draw = (x: number, y: number, o: SimulatorOrientation) => {
      switch (ORIENTATION_DEGREES[o]) {
        case 90: return { u: 1 - y, v: x }
        case 180: return { u: 1 - x, v: 1 - y }
        case 270: return { u: y, v: 1 - x }
        default: return { u: x, v: y }
      }
    }
    for (const o of ['portrait', 'landscape-left', 'landscape-right', 'portrait-upside-down'] as SimulatorOrientation[]) {
      for (const [x, y] of [[0, 0], [1, 0], [0.25, 0.75], [0.9, 0.1]]) {
        const { u, v } = draw(x, y, o)
        const back = displayToFramebuffer(u, v, o)
        expect(back.x).toBeCloseTo(x)
        expect(back.y).toBeCloseTo(y)
      }
    }
  })

  it('turns the picture counter-clockwise for a device turned left (measured: Purple 3 = dock on the left edge)', () => {
    expect(ORIENTATION_PURPLE['landscape-left']).toBe(3)
    expect(ORIENTATION_DEGREES['landscape-left']).toBe(270)
    // The framebuffer's top-left corner ends up bottom-left on screen.
    expect(displayToFramebuffer(0, 1, 'landscape-left')).toEqual({ x: 0, y: 0 })
  })

  it('persists a non-portrait orientation and accepts only Purple values 1–4', () => {
    expect(normalizeSimulatorConfig({ udid: UDID, orientation: 'landscape-left' })).toEqual({ udid: UDID, orientation: 'landscape-left' })
    expect(normalizeSimulatorConfig({ udid: UDID, orientation: 'sideways' })).toEqual({ udid: UDID })
    expect(normalizeSimulatorInput({ t: 'orientation', value: 3 })).toEqual({ t: 'orientation', value: 3 })
    expect(normalizeSimulatorInput({ t: 'orientation', value: 7 })).toBeNull()
  })
})
