import { execFile, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, stat } from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'
import { IPC } from '../../shared/ipc'
import {
  SIMULATOR_NODE_ID,
  normalizeSimulatorInput,
  type SimulatorDisplayInfo,
  type SimulatorStartResult,
  type SimulatorStatusEvent
} from '../../shared/simulator'
import { SIMULATOR_UDID } from '../../shared/run-config'
import { renameAtomic, writeFileAtomic } from '../fs-atomic'
import { platform } from '../platform'
import { SIMBRIDGE_SOURCE, SIMBRIDGE_VERSION } from './simbridge-source'

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

interface Session {
  child: ChildProcessWithoutNullStreams
  udid: string
  stderr: string
  stopping: boolean
}

const sessions = new Map<string, Session>()

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
  const tmpBin = `${bin}.${process.pid}.${Date.now().toString(36)}.tmp`
  try {
    await run('/usr/bin/xcrun', ['swiftc', '-O', src, '-o', tmpBin], { timeout: 300_000, maxBuffer: 8 * 1024 * 1024 })
    await renameAtomic(tmpBin, bin)
    return { ok: true, path: bin }
  } catch (e) {
    const msg = String((e as { stderr?: string }).stderr || (e as Error).message)
    const first = msg.split('\n').find((l) => l.includes('error:')) ?? msg.split('\n')[0]
    return { ok: false, error: `Could not build the simulator helper with this Xcode: ${first}` }
  }
}

// ── Sessions ─────────────────────────────────────────────────────────────────────────────────────

function emitStatus(nodeId: string, event: SimulatorStatusEvent): void {
  platform().broadcast(IPC.simulatorStatus(nodeId), event)
}

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
        name: typeof d.name === 'string' ? d.name : ''
      })
    }
    return { kind: 'displays', displays, active: typeof o.active === 'number' ? o.active : 0, pinned: o.pinned === true }
  }
  if (typeof o.error === 'string') {
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

export async function startSimulator(nodeId: unknown, udid: unknown): Promise<SimulatorStartResult> {
  if (typeof nodeId !== 'string' || !SIMULATOR_NODE_ID.test(nodeId)) return { ok: false, error: 'Invalid node.' }
  if (typeof udid !== 'string' || !SIMULATOR_UDID.test(udid)) return { ok: false, error: 'Pick a simulator.' }
  const existing = sessions.get(nodeId)
  if (existing && existing.udid === udid.toUpperCase() && !existing.stopping) return { ok: true }
  stopSimulator(nodeId)
  if (sessions.size >= MAX_SESSIONS) return { ok: false, error: `At most ${MAX_SESSIONS} simulator views can stream at once.` }
  const bridge = await ensureBridge()
  if (!bridge.ok) return bridge
  const child = spawn(bridge.path, [udid.toUpperCase(), '--fps', '30', '--max-width', '900', '--quality', '0.6'], {
    stdio: ['pipe', 'pipe', 'pipe']
  })
  const session: Session = { child, udid: udid.toUpperCase(), stderr: '', stopping: false }
  sessions.set(nodeId, session)
  const parse = frameParser((f) => platform().broadcast(IPC.simulatorFrame(nodeId), f))
  child.stdout.on('data', (chunk: Buffer) => {
    if (!parse(chunk)) {
      emitStatus(nodeId, { kind: 'error', code: 'protocol', message: 'The simulator helper sent an unreadable frame.' })
      child.kill()
    }
  })
  child.stderr.on('data', (chunk: Buffer) => {
    session.stderr += chunk.toString('utf8')
    let nl: number
    while ((nl = session.stderr.indexOf('\n')) >= 0) {
      const line = session.stderr.slice(0, nl)
      session.stderr = session.stderr.slice(nl + 1)
      const event = parseBridgeStatus(line)
      if (event) emitStatus(nodeId, event)
    }
    if (session.stderr.length > 64 * 1024) session.stderr = session.stderr.slice(-8 * 1024)
  })
  child.on('error', (e) => emitStatus(nodeId, { kind: 'error', code: 'spawn', message: e.message }))
  child.on('exit', (code, signal) => {
    if (sessions.get(nodeId) === session) sessions.delete(nodeId)
    if (!session.stopping) emitStatus(nodeId, { kind: 'exited', code: code ?? null, signal: signal ?? null })
  })
  child.stdin.on('error', () => undefined) // the helper exiting closes stdin; its exit event says why
  return { ok: true }
}

export function stopSimulator(nodeId: unknown): void {
  if (typeof nodeId !== 'string') return
  const s = sessions.get(nodeId)
  if (!s) return
  s.stopping = true
  sessions.delete(nodeId)
  s.child.stdin.end() // the helper exits when stdin closes
  setTimeout(() => {
    if (s.child.exitCode === null && s.child.signalCode === null) s.child.kill('SIGTERM')
  }, 1000).unref?.()
}

export function sendSimulatorInput(nodeId: unknown, raw: unknown): boolean {
  if (typeof nodeId !== 'string') return false
  const s = sessions.get(nodeId)
  const cmd = normalizeSimulatorInput(raw)
  if (!s || !cmd || s.child.stdin.destroyed) return false
  s.child.stdin.write(JSON.stringify(cmd) + '\n')
  return true
}

export function stopAllSimulators(): void {
  for (const id of [...sessions.keys()]) stopSimulator(id)
}

export async function shutdownSimulator(udid: unknown): Promise<boolean> {
  if (process.platform !== 'darwin' || typeof udid !== 'string' || !SIMULATOR_UDID.test(udid)) return false
  try {
    await run('/usr/bin/xcrun', ['simctl', 'shutdown', udid], { timeout: 60_000 })
    return true
  } catch (e) {
    return /current state: Shutdown/i.test(String((e as { stderr?: string }).stderr ?? ''))
  }
}

export function registerSimulatorIpc(): void {
  platform().handle(IPC.simulatorStart, (nodeId: unknown, udid: unknown) => startSimulator(nodeId, udid))
  platform().handle(IPC.simulatorStop, (nodeId: unknown) => stopSimulator(nodeId))
  platform().handle(IPC.simulatorInput, (nodeId: unknown, cmd: unknown) => sendSimulatorInput(nodeId, cmd))
  platform().handle(IPC.simulatorShutdown, (udid: unknown) => shutdownSimulator(udid))
}
