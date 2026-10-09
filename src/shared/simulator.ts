/**
 * The Simulator node: a live iOS simulator screen on the canvas — touch with the mouse, type with
 * the keyboard, press home / lock — without DeviceHub. Host side in core/simulator; this module is
 * the pure half both sides share: the persisted config, input validation, and the two mappings
 * (pointer → screen ratio, browser key → HID usage).
 */
import { SIMULATOR_UDID } from './run-config'

/** Persisted on a `simulator` node as `data.simulator`. */
export interface SimulatorNodeConfig {
  /** The simulator's UDID. Absent until one is picked. */
  udid?: string
  /** Its name when picked, so the node can label it before devices load. */
  name?: string
  /** How the device is held. Absent = portrait. */
  orientation?: SimulatorOrientation
}

// ── Orientation ────────────────────────────────────────────────────────────────────────────────
//
// Rotating a device is two things: the helper tells iOS (a GSEvent to PurpleWorkspacePort), and the
// node turns the picture — the framebuffer always stays portrait while iOS draws its content rotated
// inside it, exactly as a real panel does. Touches are then mapped back from the turned picture to
// framebuffer coordinates. MEASURED (Xcode 27, iPad): Purple value 3 lays the UI out upright for a
// device turned LEFT (counter-clockwise: dock on the framebuffer's left edge), 4 for one turned right.

export type SimulatorOrientation = 'portrait' | 'landscape-left' | 'landscape-right' | 'portrait-upside-down'

const ORIENTATIONS: readonly SimulatorOrientation[] = ['portrait', 'landscape-left', 'portrait-upside-down', 'landscape-right']

/** The GSEvent orientation value the helper sends for each. */
export const ORIENTATION_PURPLE: Readonly<Record<SimulatorOrientation, number>> = {
  portrait: 1,
  'portrait-upside-down': 2,
  'landscape-left': 3,
  'landscape-right': 4
}

/** How far the picture is turned on screen, clockwise, in degrees. */
export const ORIENTATION_DEGREES: Readonly<Record<SimulatorOrientation, 0 | 90 | 180 | 270>> = {
  portrait: 0,
  'landscape-right': 90,
  'portrait-upside-down': 180,
  'landscape-left': 270
}

export function isSimulatorOrientation(v: unknown): v is SimulatorOrientation {
  return typeof v === 'string' && (ORIENTATIONS as readonly string[]).includes(v)
}

/** Turn the device a quarter turn left (counter-clockwise) or right. */
export function rotateOrientation(o: SimulatorOrientation, dir: 'left' | 'right'): SimulatorOrientation {
  const i = ORIENTATIONS.indexOf(o)
  return ORIENTATIONS[(i + (dir === 'left' ? 1 : 3)) % 4]
}

/** A point on the turned picture (0..1 of what is shown) → the same point in the portrait
 *  framebuffer the digitizer expects. */
export function displayToFramebuffer(u: number, v: number, o: SimulatorOrientation): { x: number; y: number } {
  switch (o) {
    case 'landscape-left': // picture turned 90° counter-clockwise
      return { x: 1 - v, y: u }
    case 'landscape-right': // picture turned 90° clockwise
      return { x: v, y: 1 - u }
    case 'portrait-upside-down':
      return { x: 1 - u, y: 1 - v }
    default:
      return { x: u, y: v }
  }
}

// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/

/** Re-validate a persisted config (git-shared, hand-editable). Never undefined: a broken value is
 *  an unconfigured node, which asks for a device. */
export function normalizeSimulatorConfig(raw: unknown): SimulatorNodeConfig {
  if (!raw || typeof raw !== 'object') return {}
  const r = raw as Record<string, unknown>
  const out: SimulatorNodeConfig = {}
  if (typeof r.udid === 'string' && SIMULATOR_UDID.test(r.udid)) {
    out.udid = r.udid.toUpperCase()
    if (typeof r.name === 'string' && r.name.trim() && r.name.length <= 200 && !CONTROL.test(r.name)) out.name = r.name.trim()
  }
  if (isSimulatorOrientation(r.orientation) && r.orientation !== 'portrait') out.orientation = r.orientation
  return out
}

export const SIMULATOR_NODE_ID = /^[A-Za-z0-9._-]{1,128}$/

// ── Input ──────────────────────────────────────────────────────────────────────────────────────

export type SimulatorButton = 'home' | 'lock' | 'siri' | 'volup' | 'voldown'
const BUTTONS: readonly SimulatorButton[] = ['home', 'lock', 'siri', 'volup', 'voldown']

export type SimulatorInput =
  | { t: 'down' | 'move' | 'up'; x: number; y: number }
  | { t: 'key'; usage: number; down: boolean }
  | { t: 'button'; name: SimulatorButton }
  | { t: 'display'; index: number }
  | { t: 'orientation'; value: number }

/** The only commands that reach the helper, re-built field by field (renderer input is untrusted
 *  in the Server Edition and the relay; the helper also clamps). */
export function normalizeSimulatorInput(raw: unknown): SimulatorInput | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  switch (r.t) {
    case 'down':
    case 'move':
    case 'up': {
      const x = Number(r.x)
      const y = Number(r.y)
      if (!Number.isFinite(x) || !Number.isFinite(y)) return null
      return { t: r.t, x: Math.min(1, Math.max(0, x)), y: Math.min(1, Math.max(0, y)) }
    }
    case 'key': {
      const usage = Number(r.usage)
      if (!Number.isInteger(usage) || usage < 0 || usage > 255 || typeof r.down !== 'boolean') return null
      return { t: 'key', usage, down: r.down }
    }
    case 'button':
      return BUTTONS.includes(r.name as SimulatorButton) ? { t: 'button', name: r.name as SimulatorButton } : null
    case 'orientation': {
      const value = Number(r.value)
      return Number.isInteger(value) && value >= 1 && value <= 4 ? { t: 'orientation', value } : null
    }
    case 'display': {
      const index = Number(r.index)
      return Number.isInteger(index) && index >= -1 && index < 16 ? { t: 'display', index } : null
    }
    default:
      return null
  }
}

/**
 * Where a pointer landed on the device screen, as a 0..1 ratio — or null when it is in the
 * letterbox around it. The frame is drawn `object-fit: contain` inside a box of `boxW × boxH`, so
 * the picture is centred with bars on two sides; offsets are measured from the box's top-left.
 */
export function pointerToScreenRatio(
  offsetX: number,
  offsetY: number,
  boxW: number,
  boxH: number,
  frameW: number,
  frameH: number
): { x: number; y: number } | null {
  if (boxW <= 0 || boxH <= 0 || frameW <= 0 || frameH <= 0) return null
  const scale = Math.min(boxW / frameW, boxH / frameH)
  const drawnW = frameW * scale
  const drawnH = frameH * scale
  const left = (boxW - drawnW) / 2
  const top = (boxH - drawnH) / 2
  const x = (offsetX - left) / drawnW
  const y = (offsetY - top) / drawnH
  if (x < 0 || x > 1 || y < 0 || y > 1) return null
  return { x, y }
}

/**
 * Browser `KeyboardEvent.code` → USB HID keyboard usage (page 0x07), the codes the simulator's
 * keyboard service takes. Physical-key codes, not characters: the device applies its own layout
 * and Shift, exactly as a hardware keyboard attached to an iPhone does.
 */
export const HID_USAGE_BY_CODE: Readonly<Record<string, number>> = (() => {
  const m: Record<string, number> = {}
  for (let i = 0; i < 26; i++) m[`Key${String.fromCharCode(65 + i)}`] = 0x04 + i
  for (let i = 1; i <= 9; i++) m[`Digit${i}`] = 0x1e + (i - 1)
  m.Digit0 = 0x27
  Object.assign(m, {
    Enter: 0x28, NumpadEnter: 0x58, Escape: 0x29, Backspace: 0x2a, Tab: 0x2b, Space: 0x2c,
    Minus: 0x2d, Equal: 0x2e, BracketLeft: 0x2f, BracketRight: 0x30, Backslash: 0x31,
    Semicolon: 0x33, Quote: 0x34, Backquote: 0x35, Comma: 0x36, Period: 0x37, Slash: 0x38,
    CapsLock: 0x39, Delete: 0x4c, Home: 0x4a, End: 0x4d, PageUp: 0x4b, PageDown: 0x4e,
    ArrowRight: 0x4f, ArrowLeft: 0x50, ArrowDown: 0x51, ArrowUp: 0x52,
    ControlLeft: 0xe0, ShiftLeft: 0xe1, AltLeft: 0xe2, MetaLeft: 0xe3,
    ControlRight: 0xe4, ShiftRight: 0xe5, AltRight: 0xe6, MetaRight: 0xe7
  })
  for (let i = 1; i <= 12; i++) m[`F${i}`] = 0x3a + (i - 1)
  return m
})()

export function hidUsageForCode(code: string): number | undefined {
  return Object.prototype.hasOwnProperty.call(HID_USAGE_BY_CODE, code) ? HID_USAGE_BY_CODE[code] : undefined
}

// ── Host API ───────────────────────────────────────────────────────────────────────────────────

export interface SimulatorDisplayInfo {
  index: number
  width: number
  height: number
  /** The device's own name for it: "LCD" (cover / only screen), "LCD-1" (a foldable's inner). */
  name: string
}

export type SimulatorStatusEvent =
  | { kind: 'ready' }
  | { kind: 'displays'; displays: SimulatorDisplayInfo[]; active: number; pinned: boolean }
  | { kind: 'error'; code: string; message: string }
  | { kind: 'exited'; code: number | null; signal: string | null }

export interface SimulatorFrame {
  width: number
  height: number
  display: number
  jpeg: Uint8Array
}

export type SimulatorStartResult = { ok: true } | { ok: false; error: string }

export interface SimulatorApi {
  /** Start streaming `udid` into this node (compiles the helper on first use). */
  start(nodeId: string, udid: string): Promise<SimulatorStartResult>
  stop(nodeId: string): Promise<void>
  /** Touch / key / button / display — validated again on the host. */
  input(nodeId: string, cmd: SimulatorInput): Promise<boolean>
  shutdown(udid: string): Promise<boolean>
  onFrame(nodeId: string, listener: (frame: SimulatorFrame) => void): () => void
  onStatus(nodeId: string, listener: (event: SimulatorStatusEvent) => void): () => void
}

/** A friendlier label for a display than the device's own ("LCD-1"). */
export function displayLabel(d: SimulatorDisplayInfo, all: readonly SimulatorDisplayInfo[]): string {
  if (all.length < 2) return 'Screen'
  // A foldable: the larger screen is the inner one.
  const largest = all.reduce((a, b) => (a.width * a.height >= b.width * b.height ? a : b))
  return d.index === largest.index ? 'Inner' : 'Cover'
}

// ── Fitting the node to the screen ─────────────────────────────────────────────────────────────

export interface FitInput {
  /** The screen area's current size (layout px) and the node's chrome around it. */
  screenW: number
  screenH: number
  chromeW: number
  chromeH: number
  /** The picture's width / height, as shown (after rotation). */
  aspect: number
  /** Which side keeps its length: the longer one (a shape change — rotation, first frame), or the
   *  side the user just dragged (a hand resize). */
  by: 'long' | 'width' | 'height'
  minW: number
  minH: number
}

/** The node size whose screen area has exactly the picture's shape — no letterbox bars. */
export function fitNodeToScreen(f: FitInput): { width: number; height: number } {
  const long = Math.max(f.screenW, f.screenH)
  const screenW =
    f.by === 'width'
      ? f.screenW
      : f.by === 'height'
        ? f.screenH * f.aspect
        : f.aspect >= 1
          ? long
          : long * f.aspect
  const width = Math.max(f.minW, Math.round(screenW + f.chromeW))
  // A width clamped up to the minimum still gets a screen of the right shape.
  const height = Math.max(f.minH, Math.round((width - f.chromeW) / f.aspect + f.chromeH))
  return { width, height }
}

/** Which side a hand resize was about: the one that changed more, relative to where it started. */
export function draggedSide(before: { w: number; h: number }, after: { w: number; h: number }): 'width' | 'height' {
  const dw = Math.abs(after.w - before.w) / Math.max(1, before.w)
  const dh = Math.abs(after.h - before.h) / Math.max(1, before.h)
  return dw >= dh ? 'width' : 'height'
}
