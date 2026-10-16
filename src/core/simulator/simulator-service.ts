import { execFile, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, rm, stat } from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'
import { IPC } from '../../shared/ipc'
import {
  SIMULATOR_NODE_ID,
  avdNameOf,
  normalizeDeviceId,
  normalizeSimulatorInput,
  type SimulatorDevice,
  type SimulatorDevicesResult,
  type SimulatorDisplayInfo,
  type SimulatorStartResult,
  type SimulatorStatusEvent
} from '../../shared/simulator'
import { SIMULATOR_UDID } from '../../shared/run-config'
import { bootSimulatorReport, listSimulatorsChecked } from '../run-service'
import { VM_SHUTDOWN, vmRunState } from './android-grpc'
import { androidNodeAvd, androidUnary, sendAndroidInput, startAndroid, stopAllAndroid, stopAndroid, type AndroidHooks } from './android-bridge'
import { bootAndroid, findRunning, listAndroidDevices } from './android-sdk'
import { renameAtomic, tempNameFor, writeFileAtomic } from '../fs-atomic'
import { platform } from '../platform'
import { SIMBRIDGE_SOURCE, SIMBRIDGE_VERSION } from './simbridge-source'
import { registerSimulatorActionIpc } from './simulator-actions'
import { createDeviceOwnership } from './device-ownership'

/**
 * Host side of the Simulator node: a live iOS simulator screen on the canvas, with touch, keyboard
 * and hardware buttons. macOS desktop only — the helper talks to Xcode's simulator frameworks.
 *
 * `nt-simbridge` (simbridge-source.ts) is compiled here on first use with `xcrun swiftc` into
 * `<userData>/simulator-bridge/<hash>/`, keyed by the helper's source + version + Xcode's build, so
 * an Xcode update recompiles instead of running a binary built against frameworks that moved.
 *
 * One helper per node. Its frames are pushed on `sim:frame:<nodeId>` (the JPEG as a Uint8Array,
 * structured-cloned by Electron) and its status lines on `sim:status:<nodeId>`; input arrives as
 * validated commands and is written to its stdin. A node that unmounts stops its helper; a helper
 * that dies says why.
 */

const run = promisify(execFile)
const MAX_SESSIONS = 8
const FRAME_HEADER = 20
const MAX_FRAME_BYTES = 16 * 1024 * 1024

/**
 * ONE helper per device, shared by every node showing it. MEASURED (Xcode 27): a device takes input
 * from the FIRST HID client only — a second client's touches are silently dropped — so two nodes on
 * one device, each with its own helper, would leave the second one unable to touch anything.
 */
interface Bridge {
  child: ChildProcessWithoutNullStreams
  udid: string
  nodes: Set<string>
  stderr: string
  stopping: boolean
  /** Replayed to a node that joins a running bridge, which would otherwise never hear them. */
  lastDisplays: SimulatorStatusEvent | null
  ready: boolean
}

const bridges = new Map<string, Bridge>()
/** nodeId → the device it is showing. */
const nodeDevice = new Map<string, string>()

// ── Compile ──────────────────────────────────────────────────────────────────────────────────────

let xcodeBuild: Promise<string | null> | null = null
function xcodeBuildVersion(): Promise<string | null> {
  if (!xcodeBuild) {
    xcodeBuild = run('/usr/bin/xcodebuild', ['-version'], { timeout: 20_000 })
      .then(({ stdout }) => stdout.trim().replace(/\s+/g, ' '))
      .catch(() => null)
  }
  return xcodeBuild
}

let compiling: Promise<{ ok: true; path: string } | { ok: false; error: string }> | null = null

/** The compiled helper for this Xcode, building it once if needed. A failure is not cached:
 *  installing Xcode (or fixing it) should simply work on the next try. */
export function ensureBridge(): Promise<{ ok: true; path: string } | { ok: false; error: string }> {
  if (!compiling) {
    compiling = buildBridge().then((r) => {
      if (!r.ok) compiling = null
      return r
    })
  }
  return compiling
}

async function buildBridge(): Promise<{ ok: true; path: string } | { ok: false; error: string }> {
  if (process.platform !== 'darwin') return { ok: false, error: 'iOS simulators need macOS.' }
  const xcode = await xcodeBuildVersion()
  if (!xcode) return { ok: false, error: 'Xcode was not found (xcodebuild -version failed). Install Xcode to use simulators.' }
  const hash = createHash('sha256').update(`${SIMBRIDGE_VERSION}\0${xcode}\0${SIMBRIDGE_SOURCE}`).digest('hex').slice(0, 16)
  const dir = path.join(platform().userDataDir, 'simulator-bridge', hash)
  const bin = path.join(dir, 'nt-simbridge')
  try {
    if ((await stat(bin)).isFile()) return { ok: true, path: bin }
  } catch {
    /* build it */
  }
  await mkdir(dir, { recursive: true })
  const src = path.join(dir, 'nt-simbridge.swift')
  await writeFileAtomic(src, SIMBRIDGE_SOURCE)
  const tmpBin = tempNameFor(bin)
  try {
    await run('/usr/bin/xcrun', ['swiftc', '-O', src, '-o', tmpBin], { timeout: 300_000, maxBuffer: 8 * 1024 * 1024 })
    await renameAtomic(tmpBin, bin)
    return { ok: true, path: bin }
  } catch (e) {
    await rm(tmpBin, { force: true }).catch(() => undefined)
    const msg = String((e as { stderr?: string }).stderr || (e as Error).message)
    const first = msg.split('\n').find((l) => l.includes('error:')) ?? msg.split('\n')[0]
    return { ok: false, error: `Could not build the simulator helper with this Xcode: ${first}` }
  }
}

// ── Sessions ─────────────────────────────────────────────────────────────────────────────────────

function emitStatus(nodeId: string, event: SimulatorStatusEvent): void {
  platform().broadcast(IPC.simulatorStatus(nodeId), event)
}

export const NO_DISPLAY_MESSAGE =
  'This simulator booted without a working screen. Restart it from the ⋯ menu; if that does not help, use Reset Content and Settings.'

/** Turn one helper status line into an event for the node. Unknown shapes are ignored. */
export function parseBridgeStatus(line: string): SimulatorStatusEvent | null {
  let o: Record<string, unknown>
  try {
    o = JSON.parse(line) as Record<string, unknown>
  } catch {
    return null
  }
  if (o.ok === 'ready') return { kind: 'ready' }
  if (o.ok === 'displays' && Array.isArray(o.displays)) {
    const displays: SimulatorDisplayInfo[] = []
    for (const d of o.displays as Array<Record<string, unknown>>) {
      if (typeof d.index !== 'number' || typeof d.width !== 'number' || typeof d.height !== 'number') continue
      displays.push({
        index: d.index,
        width: d.width,
        height: d.height,
        name: typeof d.name === 'string' ? d.name : '',
        screenID: typeof d.screenID === 'number' ? d.screenID : 0
      })
    }
    return { kind: 'displays', displays, active: typeof o.active === 'number' ? o.active : 0, pinned: o.pinned === true }
  }
  if (typeof o.error === 'string') {
    // A device CoreSimulator reports as Booted with its display down (input alive, no framebuffer) is
    // a wedged boot: only shutting it down and booting it again brings the screen back, and an erase
    // when even that fails. Said here, because the helper's own words name only the symptom.
    if (o.error === 'no-display') return { kind: 'error', code: o.error, message: NO_DISPLAY_MESSAGE }
    return { kind: 'error', code: o.error, message: typeof o.message === 'string' ? o.message : o.error }
  }
  return null
}

/** Split the helper's stdout into frames: "NTF2" | w | h | display | len | jpeg. */
export function frameParser(onFrame: (f: { width: number; height: number; display: number; jpeg: Uint8Array }) => void) {
  let buf: Buffer = Buffer.alloc(0)
  return (chunk: Buffer): boolean => {
    buf = buf.length ? Buffer.concat([buf, chunk]) : chunk
    while (buf.length >= FRAME_HEADER) {
      if (buf.toString('latin1', 0, 4) !== 'NTF2') return false
      const len = buf.readUInt32LE(16)
      if (len > MAX_FRAME_BYTES) return false
      if (buf.length < FRAME_HEADER + len) break
      onFrame({
        width: buf.readUInt32LE(4),
        height: buf.readUInt32LE(8),
        display: buf.readUInt32LE(12),
        jpeg: new Uint8Array(buf.subarray(FRAME_HEADER, FRAME_HEADER + len))
      })
      buf = buf.subarray(FRAME_HEADER + len)
    }
    return true
  }
}

const androidHooks: AndroidHooks = {
  frame: (nodeId, f) => platform().broadcast(IPC.simulatorFrame(nodeId), f),
  status: (nodeId, e) => emitStatus(nodeId, e)
}

/** Why a node may not show a device at all (an SSH project's node), from the shell that knows which
 *  project owns a node. Null = allowed. The menus already refuse; this is the backstop for a node that
 *  arrives anyway (a hand-edited project file, a project converted to SSH). */
type NodeRefusal = (nodeId: string) => string | null
let nodeRefusal: NodeRefusal = () => null
export function setSimulatorNodeRefusal(fn: NodeRefusal | null): void {
  nodeRefusal = fn ?? (() => null)
}

/** The devices this app's Simulator nodes booted — shut down at quit, and nothing else is. */
const ownership = createDeviceOwnership({
  iosBooted: async (udid) => {
    const r = await listSimulatorsChecked()
    if (r.error) return null
    const d = r.devices.find((x) => x.id.toUpperCase() === udid.toUpperCase())
    return d ? d.state === 'booted' : false
  },
  androidPid: async (avd) => (await findRunning(avd))?.pid ?? null,
  shutdownIos: (udid) => run('/usr/bin/xcrun', ['simctl', 'shutdown', udid], { timeout: 30_000 }),
  // The emulator saves its quick-boot snapshot and exits on its own after this call; quit does not
  // wait for that (see shutdownOwnedSimulators).
  shutdownAndroid: (avd) => androidUnary(avd, 'setVmState', vmRunState(VM_SHUTDOWN), 5_000)
})

export const OWNED_SHUTDOWN_TIMEOUT_MS = 3_000

/** Quit path: shut down the devices the nodes booted, within a bounded wait. Never throws. */
export async function shutdownOwnedSimulators(timeoutMs = OWNED_SHUTDOWN_TIMEOUT_MS): Promise<void> {
  try {
    const asked = await ownership.shutdownOwned(timeoutMs)
    if (asked.ios.length || asked.android.length) {
      console.log(`[simulator] shut down at quit: ${[...asked.ios, ...asked.android.map((a) => `avd:${a}`)].join(', ')}`)
    }
  } catch (e) {
    console.warn('[simulator] shutting down booted devices at quit failed:', (e as Error).message)
  }
}

export async function startSimulator(nodeId: unknown, udidRaw: unknown): Promise<SimulatorStartResult> {
  if (typeof nodeId !== 'string' || !SIMULATOR_NODE_ID.test(nodeId)) return { ok: false, error: 'Invalid node.' }
  const refused = nodeRefusal(nodeId)
  if (refused) return { ok: false, error: refused }
  const id = normalizeDeviceId(udidRaw)
  if (!id) return { ok: false, error: 'Pick a simulator.' }
  const avd = avdNameOf(id)
  if (avd) {
    if (androidNodeAvd(nodeId) !== avd || nodeDevice.has(nodeId)) stopSimulator(nodeId)
    return startAndroid(nodeId, avd, androidHooks)
  }
  const udid = id
  if (nodeDevice.get(nodeId) !== udid) stopSimulator(nodeId)
  const running = bridges.get(udid)
  if (running && !running.stopping) {
    running.nodes.add(nodeId)
    nodeDevice.set(nodeId, udid)
    if (running.lastDisplays) emitStatus(nodeId, running.lastDisplays)
    if (running.ready) emitStatus(nodeId, { kind: 'ready' })
    return { ok: true }
  }
  if (bridges.size >= MAX_SESSIONS) return { ok: false, error: `At most ${MAX_SESSIONS} simulators can stream at once.` }
  const helper = await ensureBridge()
  if (!helper.ok) return helper
  const child = spawn(helper.path, [udid, '--fps', '30', '--max-width', '900', '--quality', '0.6'], { stdio: ['pipe', 'pipe', 'pipe'] })
  const bridge: Bridge = { child, udid, nodes: new Set([nodeId]), stderr: '', stopping: false, lastDisplays: null, ready: false }
  bridges.set(udid, bridge)
  nodeDevice.set(nodeId, udid)
  const each = (fn: (id: string) => void) => {
    for (const id of bridge.nodes) fn(id)
  }
  const parse = frameParser((f) => each((id) => platform().broadcast(IPC.simulatorFrame(id), f)))
  child.stdout.on('data', (chunk: Buffer) => {
    if (!parse(chunk)) {
      each((id) => emitStatus(id, { kind: 'error', code: 'protocol', message: 'The simulator helper sent an unreadable frame.' }))
      child.kill()
    }
  })
  child.stderr.on('data', (chunk: Buffer) => {
    bridge.stderr += chunk.toString('utf8')
    let nl: number
    while ((nl = bridge.stderr.indexOf('\n')) >= 0) {
      const line = bridge.stderr.slice(0, nl)
      bridge.stderr = bridge.stderr.slice(nl + 1)
      const event = parseBridgeStatus(line)
      if (!event) continue
      if (event.kind === 'displays') bridge.lastDisplays = event
      if (event.kind === 'ready') bridge.ready = true
      each((id) => emitStatus(id, event))
    }
    if (bridge.stderr.length > 64 * 1024) bridge.stderr = bridge.stderr.slice(-8 * 1024)
  })
  child.on('error', (e) => each((id) => emitStatus(id, { kind: 'error', code: 'spawn', message: e.message })))
  child.on('exit', (code, signal) => {
    if (bridges.get(udid) === bridge) bridges.delete(udid)
    if (!bridge.stopping) each((id) => emitStatus(id, { kind: 'exited', code: code ?? null, signal: signal ?? null }))
    for (const id of bridge.nodes) if (nodeDevice.get(id) === udid) nodeDevice.delete(id)
  })
  child.stdin.on('error', () => undefined) // the helper exiting closes stdin; its exit event says why
  return { ok: true }
}

export function stopSimulator(nodeId: unknown): void {
  if (typeof nodeId !== 'string') return
  stopAndroid(nodeId)
  const udid = nodeDevice.get(nodeId)
  nodeDevice.delete(nodeId)
  const b = udid ? bridges.get(udid) : undefined
  if (!b) return
  b.nodes.delete(nodeId)
  if (b.nodes.size > 0) return // another node still shows this device
  b.stopping = true
  bridges.delete(b.udid)
  b.child.stdin.end() // the helper exits when stdin closes
  setTimeout(() => {
    if (b.child.exitCode === null && b.child.signalCode === null) b.child.kill('SIGTERM')
  }, 1000).unref?.()
}

export function sendSimulatorInput(nodeId: unknown, raw: unknown): boolean {
  if (typeof nodeId !== 'string') return false
  const cmd = normalizeSimulatorInput(raw)
  if (cmd && androidNodeAvd(nodeId)) return sendAndroidInput(nodeId, cmd)
  const udid = nodeDevice.get(nodeId)
  const b = udid ? bridges.get(udid) : undefined
  if (!b || !cmd || b.child.stdin.destroyed) return false
  b.child.stdin.write(JSON.stringify(cmd) + '\n')
  return true
}

export function stopAllSimulators(): void {
  for (const id of [...nodeDevice.keys()]) stopSimulator(id)
  stopAllAndroid()
}

export async function shutdownSimulator(udid: unknown): Promise<boolean> {
  const avd = typeof udid === 'string' ? avdNameOf(udid) : null
  if (avd) {
    // SHUTDOWN is what closing the emulator window does: Android is told, then the emulator exits
    // (saving its quick-boot snapshot when the AVD keeps one).
    if (!(await findRunning(avd))) return true
    try {
      await androidUnary(avd, 'setVmState', vmRunState(VM_SHUTDOWN))
    } catch {
      return false
    }
    for (let i = 0; i < 60; i++) {
      if (!(await findRunning(avd))) {
        ownership.releaseAndroid(avd)
        return true
      }
      await new Promise((r) => setTimeout(r, 500))
    }
    return false
  }
  if (process.platform !== 'darwin' || typeof udid !== 'string' || !SIMULATOR_UDID.test(udid)) return false
  try {
    await run('/usr/bin/xcrun', ['simctl', 'shutdown', udid], { timeout: 60_000 })
    ownership.releaseIos(udid)
    return true
  } catch (e) {
    const already = /current state: Shutdown/i.test(String((e as { stderr?: string }).stderr ?? ''))
    if (already) ownership.releaseIos(udid)
    return already
  }
}

/** Every simulator the node can show: iOS simulators (macOS) and Android virtual devices. */
export async function listSimulatorDevices(): Promise<SimulatorDevicesResult> {
  const [sims, android] = await Promise.all([listSimulatorsChecked(), listAndroidDevices()])
  // A device seen shut down is no longer ours: whoever boots it next owns it.
  for (const d of sims.devices) if (d.state !== 'booted') ownership.releaseIos(d.id)
  for (const d of android.devices) if (d.state !== 'booted') ownership.releaseAndroid(avdNameOf(d.id) ?? '')
  const ios: SimulatorDevice[] = sims.devices
    .map((d) => ({ id: d.id, name: d.name, platform: 'ios' as const, os: d.platform, state: d.state === 'booted' ? 'booted' : 'shutdown' }))
  return {
    devices: [...ios, ...android.devices],
    ...(sims.error ? { iosError: sims.error } : {}),
    ...(android.error ? { androidError: android.error } : {})
  }
}

export async function bootSimulatorDevice(idRaw: unknown): Promise<{ ok: true } | { ok: false; error: string }> {
  const id = normalizeDeviceId(idRaw)
  if (!id) return { ok: false, error: 'Pick a simulator.' }
  const avd = avdNameOf(id)
  if (avd) {
    const r = await bootAndroid(avd)
    // Only an emulator THIS call started is ours to shut down at quit.
    if (r.ok && r.started) ownership.claimAndroid(avd, r.started.pid)
    return r.ok ? { ok: true } : r
  }
  // Headless: this node is the device's screen (see BootOptions.openWindow).
  const booted = await bootSimulatorReport(id, { openWindow: false })
  if (booted === 'booted') ownership.claimIos(id)
  return booted ? { ok: true } : { ok: false, error: 'Could not boot this simulator.' }
}

export function registerSimulatorIpc(): void {
  platform().handle(IPC.simulatorDevices, () => listSimulatorDevices())
  platform().handle(IPC.simulatorBoot, (id: unknown) => bootSimulatorDevice(id))
  platform().handle(IPC.simulatorStart, (nodeId: unknown, udid: unknown) => startSimulator(nodeId, udid))
  platform().handle(IPC.simulatorStop, (nodeId: unknown) => stopSimulator(nodeId))
  platform().handle(IPC.simulatorInput, (nodeId: unknown, cmd: unknown) => sendSimulatorInput(nodeId, cmd))
  platform().handle(IPC.simulatorShutdown, (udid: unknown) => shutdownSimulator(udid))
  registerSimulatorActionIpc()
}
