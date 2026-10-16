import { execFile, spawn } from 'node:child_process'
import { constants as fsConstants } from 'node:fs'
import { lstat, mkdir, open, readdir, stat } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { ANDROID_AVD_NAME, androidDeviceId, type SimulatorDevice } from '../../shared/simulator'
import { findInLoginPath, resolveShellEnvVar } from '../exec-path'
import { platform } from '../platform'
import type { EmulatorEndpoint } from './android-grpc'

/**
 * Where the Android SDK is, which virtual devices (AVDs) it has, and which of them are running.
 * Everything is read from files the SDK and the emulator write — nothing here asks `avdmanager`,
 * which needs a JDK — and every answer degrades to "none" rather than a guess.
 *
 * MEASURED (emulator 36.6.11, macOS): a running emulator writes `pid_<pid>.ini` into its discovery
 * directory, naming its AVD (`avd.id`), console port (`port.serial`, so adb's serial is
 * `emulator-<port>`) and gRPC endpoint (`grpc.port`, `grpc.token`). The file can outlive a crashed
 * emulator, so its pid is checked.
 */

const run = promisify(execFile)

async function envVar(name: string): Promise<string | undefined> {
  const v = (await resolveShellEnvVar(name).catch(() => null)) ?? process.env[name]
  return v && path.isAbsolute(v) ? v : undefined
}

async function isDir(p: string): Promise<boolean> {
  try {
    return (await stat(p)).isDirectory()
  } catch {
    return false
  }
}

async function isFile(p: string): Promise<boolean> {
  try {
    return (await stat(p)).isFile()
  } catch {
    return false
  }
}

/** Every place the SDK may be, in order: ANDROID_HOME, ANDROID_SDK_ROOT, then where Android Studio
 *  installs it. */
async function sdkRootCandidates(): Promise<string[]> {
  const candidates = [await envVar('ANDROID_HOME'), await envVar('ANDROID_SDK_ROOT')]
  const home = os.homedir()
  if (process.platform === 'darwin') candidates.push(path.join(home, 'Library', 'Android', 'sdk'))
  else if (process.platform === 'win32') {
    const local = process.env.LOCALAPPDATA
    if (local) candidates.push(path.join(local, 'Android', 'Sdk'))
  } else candidates.push(path.join(home, 'Android', 'Sdk'))
  return candidates.filter((c): c is string => !!c)
}

/** The SDK root: the first candidate that is a directory. */
export async function androidSdkRoot(): Promise<string | null> {
  for (const c of await sdkRootCandidates()) if (await isDir(c)) return c
  return null
}

const exe = (name: string) => (process.platform === 'win32' ? `${name}.exe` : name)

/** The first candidate root that HOLDS the tool: a stale ANDROID_HOME pointing at a half-installed SDK
 *  must not hide the complete one Android Studio installed. Pure over `isFile`, for tests. */
export async function firstSdkTool(roots: string[], rel: string[], fileCheck: (p: string) => Promise<boolean> = isFile): Promise<string | null> {
  for (const root of roots) {
    const p = path.join(root, ...rel)
    if (await fileCheck(p)) return p
  }
  return null
}

export async function emulatorBinary(): Promise<string | null> {
  return (await firstSdkTool(await sdkRootCandidates(), ['emulator', exe('emulator')])) ?? findInLoginPath('emulator')
}

export async function adbBinary(): Promise<string | null> {
  return (await firstSdkTool(await sdkRootCandidates(), ['platform-tools', exe('adb')])) ?? findInLoginPath('adb')
}

/** Where AVDs live, in avdmanager's own order of precedence. */
export async function avdHome(): Promise<string> {
  const explicit = await envVar('ANDROID_AVD_HOME')
  if (explicit) return explicit
  const user = await envVar('ANDROID_USER_HOME')
  if (user) return path.join(user, 'avd')
  const legacy = await envVar('ANDROID_SDK_HOME')
  if (legacy) return path.join(legacy, '.android', 'avd')
  return path.join(os.homedir(), '.android', 'avd')
}

/** `key=value` lines; later keys win, comments and blank lines skipped. */
export function parseIni(text: string): Record<string, string> {
  const out: Record<string, string> = Object.create(null)
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || line.startsWith('#') || line.startsWith(';')) continue
    const eq = line.indexOf('=')
    if (eq <= 0) continue
    out[line.slice(0, eq).trim()] = line.slice(eq + 1).trim()
  }
  return out
}

/** A small regular file's text, or null. Checked and read through ONE open handle, so the file
 *  that passed the check is the file that is read (no swap in between). */
async function readSmallFile(p: string, max: number): Promise<string | null> {
  let h: Awaited<ReturnType<typeof open>> | null = null
  try {
    h = await open(p, 'r')
    const s = await h.stat()
    if (!s.isFile() || s.size > max) return null
    return await h.readFile('utf8')
  } catch {
    return null
  } finally {
    await h?.close().catch(() => undefined)
  }
}

async function readIni(p: string): Promise<Record<string, string> | null> {
  const text = await readSmallFile(p, 256 * 1024)
  return text === null ? null : parseIni(text)
}

export interface AvdInfo {
  name: string
  displayName: string
  dir: string
  /** "API 34", from the system image. */
  os?: string
  lcdWidth?: number
  lcdHeight?: number
  /** Dots per inch (hw.lcd.density): 160 is one pixel per point. */
  density?: number
}

/** The installed AVDs: `<avdHome>/<name>.ini` points at the `.avd` folder holding `config.ini`. */
export async function listAvds(): Promise<AvdInfo[]> {
  const home = await avdHome()
  let entries: string[]
  try {
    entries = await readdir(home)
  } catch {
    return []
  }
  const out: AvdInfo[] = []
  for (const file of entries) {
    if (!file.endsWith('.ini')) continue
    const name = file.slice(0, -4)
    if (!ANDROID_AVD_NAME.test(name)) continue
    const pointer = await readIni(path.join(home, file))
    if (!pointer) continue
    const dir = pointer.path && path.isAbsolute(pointer.path) ? pointer.path : path.join(home, `${name}.avd`)
    const config = await readIni(path.join(dir, 'config.ini'))
    if (!config) continue
    const api = /android-(\d+)/.exec(config['image.sysdir.1'] ?? pointer.target ?? '')?.[1]
    const w = Number(config['hw.lcd.width'])
    const h = Number(config['hw.lcd.height'])
    const dpi = Number(config['hw.lcd.density'])
    out.push({
      name,
      displayName: prettyName(cleanName(config['avd.ini.displayname']), name),
      dir,
      os: api ? `API ${api}` : undefined,
      lcdWidth: Number.isInteger(w) && w > 0 ? w : undefined,
      lcdHeight: Number.isInteger(h) && h > 0 ? h : undefined,
      density: Number.isFinite(dpi) && dpi >= 80 && dpi <= 1000 ? dpi : undefined
    })
  }
  return out.sort((a, b) => a.displayName.localeCompare(b.displayName))
}

/** The name Android Studio shows. An AVD made outside it often has its file name as display name
 *  ("Pixel_3a_API_34_extension_level_7_arm64-v8a"), so underscores become spaces there. */
function prettyName(display: string | undefined, file: string): string {
  return !display || display === file ? file.replace(/_/g, ' ') : display
}

// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/
function cleanName(v: string | undefined): string | undefined {
  if (!v) return undefined
  const s = v.trim()
  return s && s.length <= 120 && !CONTROL.test(s) ? s : undefined
}

// ── Running emulators ────────────────────────────────────────────────────────────────────────────

export interface RunningEmulator {
  avd: string
  pid: number
  /** adb's serial: `emulator-<console port>`. */
  serial?: string
  endpoint?: EmulatorEndpoint
}

/** A directory an emulator writes its discovery file into, and the directory below which nothing
 *  is trusted by location alone: under a shared temp dir another local user can create the path
 *  first, so every component from `trustedBase` (exclusive) down must be ours. */
export interface DiscoveryDir {
  dir: string
  trustedBase: string
}

/** The directories an emulator writes its discovery file into (emulator's own temp-dir rules). */
export function discoveryDirs(): DiscoveryDir[] {
  const home = os.homedir()
  if (process.platform === 'darwin') {
    return [{ dir: path.join(home, 'Library', 'Caches', 'TemporaryItems', 'avd', 'running'), trustedBase: home }]
  }
  if (process.platform === 'win32') {
    const local = process.env.LOCALAPPDATA
    return local ? [{ dir: path.join(local, 'Temp', 'avd', 'running'), trustedBase: local }] : []
  }
  const dirs: DiscoveryDir[] = []
  const xdg = process.env.XDG_RUNTIME_DIR
  if (xdg) dirs.push({ dir: path.join(xdg, 'avd', 'running'), trustedBase: xdg })
  const user = process.env.USER ?? os.userInfo().username
  const tmp = os.tmpdir()
  dirs.push({ dir: path.join(tmp, `android-${user}`, 'avd', 'running'), trustedBase: tmp })
  return dirs
}

/** Our uid, or null where the OS has none (Windows: per-user dirs, no shared temp to squat). */
function currentUid(): number | null {
  return typeof process.getuid === 'function' ? process.getuid() : null
}

/** Every component of `dir` below `trustedBase` is a real directory (not a symlink) owned by `uid`.
 *  A pre-created `/tmp/android-<user>` belonging to someone else would otherwise let them plant a
 *  discovery file whose `grpc.port` receives everything the user types into the device. */
async function dirOwnedBy(dir: string, trustedBase: string, uid: number): Promise<boolean> {
  const rel = path.relative(trustedBase, dir)
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return false
  let cur = trustedBase
  for (const part of rel.split(path.sep)) {
    cur = path.join(cur, part)
    const st = await lstat(cur).catch(() => null)
    if (!st || !st.isDirectory() || st.uid !== uid) return false
  }
  return true
}

/** Is `pid` a live process WE can signal? EPERM means it exists but belongs to another user —
 *  not our emulator, so its discovery file is not ours to trust. */
function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/** Read one discovery file into what the node needs. Pure, for tests. */
export function parseDiscovery(text: string, pid: number): RunningEmulator | null {
  const kv = parseIni(text)
  const avd = kv['avd.id']
  if (!avd || !ANDROID_AVD_NAME.test(avd)) return null
  const port = Number(kv['grpc.port'])
  const token = kv['grpc.token']
  const serialPort = Number(kv['port.serial'])
  return {
    avd,
    pid,
    serial: Number.isInteger(serialPort) && serialPort > 0 && serialPort < 65536 ? `emulator-${serialPort}` : undefined,
    endpoint:
      Number.isInteger(port) && port > 0 && port < 65536 && token && /^[A-Za-z0-9+/=._-]{8,512}$/.test(token)
        ? { port, token }
        : undefined
  }
}

export async function runningEmulators(
  dirs: DiscoveryDir[] = discoveryDirs(),
  uid: number | null = currentUid()
): Promise<RunningEmulator[]> {
  const out: RunningEmulator[] = []
  for (const { dir, trustedBase } of dirs) {
    if (uid !== null && !(await dirOwnedBy(dir, trustedBase, uid))) continue
    let names: string[]
    try {
      names = await readdir(dir)
    } catch {
      continue
    }
    for (const name of names) {
      const m = /^pid_(\d+)\.ini$/.exec(name)
      if (!m) continue
      const pid = Number(m[1])
      if (!pidAlive(pid)) continue
      const text = await readOwnedFile(path.join(dir, name), uid)
      const e = text === null ? null : parseDiscovery(text, pid)
      if (e) out.push(e)
    }
  }
  return out
}

const MAX_DISCOVERY_BYTES = 64 * 1024

/** Read a discovery file only if it is a regular file owned by `uid` (checked on the open handle,
 *  so it cannot be swapped between the check and the read; a symlink is refused at open). Null =
 *  not ours, unreadable (being written or removed), or too large. */
async function readOwnedFile(file: string, uid: number | null): Promise<string | null> {
  // Read-only: without O_CREAT nothing is created and the mode is ignored. It is spelled out because
  // the path is under a shared temp dir, so a reader cannot tell this call apart from a create.
  const fh = await open(file, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0), 0o600).catch(() => null)
  if (!fh) return null
  try {
    const st = await fh.stat()
    if (!st.isFile() || st.size > MAX_DISCOVERY_BYTES) return null
    if (uid !== null && st.uid !== uid) return null
    return await fh.readFile('utf8')
  } catch {
    return null
  } finally {
    await fh.close().catch(() => undefined)
  }
}

export async function findRunning(avd: string): Promise<RunningEmulator | null> {
  return (await runningEmulators()).find((e) => e.avd === avd && e.endpoint) ?? null
}

// ── Listing and booting ─────────────────────────────────────────────────────────────────────────

/** Every installed AVD as a Simulator-node device. `error` says why the list is empty, when it is. */
export async function listAndroidDevices(): Promise<{ devices: SimulatorDevice[]; error?: string }> {
  const [avds, running] = await Promise.all([listAvds(), runningEmulators()])
  if (!avds.length) {
    const sdk = await androidSdkRoot()
    return {
      devices: [],
      error: sdk ? undefined : 'The Android SDK was not found (set ANDROID_HOME, or install Android Studio).'
    }
  }
  const serialOf = new Map(running.map((r) => [r.avd, r.serial]))
  return {
    devices: avds.map((a) => {
      const serial = serialOf.get(a.name)
      return {
        id: androidDeviceId(a.name),
        name: a.displayName,
        platform: 'android' as const,
        os: a.os,
        state: serialOf.has(a.name) ? ('booted' as const) : ('shutdown' as const),
        ...(serial ? { serial } : {})
      }
    })
  }
}

const BOOT_WAIT_MS = 120_000

/**
 * Start an AVD headless, as iOS simulators are: the Simulator node is its screen. Resolves once its
 * gRPC endpoint is published (Android may still be booting — the node shows the boot screen), or
 * with the emulator's own last words if it exits first.
 */
export type AndroidBootResult =
  | { ok: true; /** Set only when THIS call started the emulator: the process its discovery file names. */ started?: { pid: number; serial?: string } }
  | { ok: false; error: string }

export async function bootAndroid(avd: string): Promise<AndroidBootResult> {
  if (!ANDROID_AVD_NAME.test(avd)) return { ok: false, error: 'Invalid device.' }
  if (await findRunning(avd)) return { ok: true }
  // Checked before spawning: an unknown name would start an emulator that dies at once, and the
  // user would read its log line instead of the plain reason.
  if (!(await listAvds()).some((a) => a.name === avd)) return { ok: false, error: `"${avd}" is not an Android virtual device on this machine.` }
  const bin = await emulatorBinary()
  if (!bin) return { ok: false, error: 'The Android emulator was not found (Android SDK → emulator).' }
  const logDir = path.join(platform().userDataDir, 'android-emulator')
  await mkdir(logDir, { recursive: true })
  const logPath = path.join(logDir, `${avd}.log`)
  // The log is read back through the SAME handle the emulator writes to, never by path again, so
  // what is reported is that emulator's own output. Positional reads leave the shared offset alone.
  const log = await open(logPath, 'w+')
  try {
    let exited: { code: number | null } | null = null
    const child = spawn(bin, ['-avd', avd, '-no-window'], { ...emulatorSpawnOptions(process.platform), stdio: ['ignore', log.fd, log.fd], cwd: path.dirname(bin) })
    child.on('exit', (code) => (exited = { code }))
    child.on('error', () => (exited = { code: null }))
    child.unref()
    const deadline = Date.now() + BOOT_WAIT_MS
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 500))
      const up = await findRunning(avd)
      if (up) return { ok: true, started: { pid: up.pid, ...(up.serial ? { serial: up.serial } : {}) } }
      if (exited) {
        const tail = lastError(await readLogTail(log).catch(() => ''))
        return { ok: false, error: tail ? `The emulator stopped: ${tail}` : 'The emulator stopped while starting.' }
      }
    }
    return { ok: false, error: 'The emulator did not come up within two minutes.' }
  } finally {
    await log.close().catch(() => undefined)
  }
}

/**
 * How the emulator is started. Off Windows it is detached (its own process group), so it outlives
 * the app like a tmux session does. On Windows `detached` gives the console-subsystem emulator NO
 * console, so it and its children open visible console windows of their own; a hidden console
 * (`windowsHide`) is what keeps a headless device headless there. `unref` lets the app exit either way.
 */
export function emulatorSpawnOptions(plat: NodeJS.Platform): { detached: boolean; windowsHide: boolean } {
  return plat === 'win32' ? { detached: false, windowsHide: true } : { detached: true, windowsHide: true }
}

/** The last 64 KB of an open log, read at explicit positions. */
async function readLogTail(h: Awaited<ReturnType<typeof open>>): Promise<string> {
  const { size } = await h.stat()
  const len = Math.min(size, 64 * 1024)
  const buf = Buffer.alloc(len)
  const { bytesRead } = await h.read(buf, 0, len, size - len)
  return buf.subarray(0, bytesRead).toString('utf8')
}

/** The most useful line of an emulator log: its last ERROR / FATAL line, else its last line. */
export function lastError(log: string): string {
  const lines = log.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)
  const bad = [...lines].reverse().find((l) => /^(ERROR|FATAL)\b/.test(l) || /\bERROR\s*\|/.test(l))
  const pick = bad ?? lines[lines.length - 1] ?? ''
  return pick.replace(/^(ERROR|FATAL)\s*\|?\s*/, '').slice(0, 300)
}

/** `adb -s <serial> <args>`, for the actions the emulator's own interface does not offer. */
export async function adb(serial: string, args: string[], timeout = 60_000): Promise<string> {
  const bin = await adbBinary()
  if (!bin) throw new Error('adb was not found (Android SDK → platform-tools).')
  return adbAt(bin, serial, args, timeout)
}

/** `adb` at a known path (tests pass a fake one). */
export async function adbAt(bin: string, serial: string, args: string[], timeout = 60_000): Promise<string> {
  const { stdout } = await run(bin, ['-s', serial, ...args], { timeout, maxBuffer: 16 * 1024 * 1024 })
  return stdout
}

export const BOOT_COMPLETED_WAIT_MS = 90_000
export const BOOT_COMPLETED_POLL_MS = 1_000
export const BOOT_NOT_COMPLETED_MESSAGE =
  'Android is still starting on this device (it has not finished booting after 90 seconds). Try again once its home screen shows.'

/**
 * Wait until Android on `serial` reports `sys.boot_completed=1`. The emulator publishes its gRPC
 * endpoint (and the node shows the boot animation) long before Android itself is up, and an `adb
 * shell` command sent in between fails or acts on a half-started system. A failed `getprop` counts
 * as "not yet" (adb says the device is offline while it boots). Throws BOOT_NOT_COMPLETED_MESSAGE
 * once `timeoutMs` has passed.
 */
export async function waitForBootCompleted(
  getprop: () => Promise<string>,
  opts: { timeoutMs?: number; pollMs?: number; sleep?: (ms: number) => Promise<void>; now?: () => number } = {}
): Promise<void> {
  const timeoutMs = opts.timeoutMs ?? BOOT_COMPLETED_WAIT_MS
  const pollMs = opts.pollMs ?? BOOT_COMPLETED_POLL_MS
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))
  const now = opts.now ?? Date.now
  const deadline = now() + timeoutMs
  for (;;) {
    const value = await getprop().then((v) => v.trim(), () => '')
    if (value === '1') return
    if (now() + pollMs > deadline) throw new Error(BOOT_NOT_COMPLETED_MESSAGE)
    await sleep(pollMs)
  }
}

