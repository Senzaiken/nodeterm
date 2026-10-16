import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { testTmpDir } from '../test-tmp'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  BOOT_NOT_COMPLETED_MESSAGE,
  adbAt,
  emulatorSpawnOptions,
  firstSdkTool,
  lastError,
  parseDiscovery,
  parseIni,
  runningEmulators,
  waitForBootCompleted
} from './android-sdk'

// A discovery file as emulator 36.6.11 writes it (token replaced).
const DISCOVERY = `emulator.build=15507667
avd.id=Pixel_9
port.serial=5554
port.adb=5555
avd.name=Pixel 9
emulator.version=36.6.11.0
avd.dir=/Users/me/.android/avd/Pixel_9.avd
grpc.token=AbCdEf0123456789xyz
grpc.port=8554
`

describe('Android discovery', () => {
  it('reads the AVD, adb serial and gRPC endpoint', () => {
    expect(parseDiscovery(DISCOVERY, 4242)).toEqual({
      avd: 'Pixel_9',
      pid: 4242,
      serial: 'emulator-5554',
      endpoint: { port: 8554, token: 'AbCdEf0123456789xyz' }
    })
  })

  it('has no endpoint without a token, and refuses an AVD name it could not use', () => {
    expect(parseDiscovery(DISCOVERY.replace(/grpc\.token=.*\n/, ''), 1)?.endpoint).toBeUndefined()
    expect(parseDiscovery(DISCOVERY.replace('avd.id=Pixel_9', 'avd.id=../etc'), 1)).toBeNull()
  })

  it('parses ini files, skipping comments', () => {
    expect(parseIni('# c\nhw.lcd.width = 1080\n\nimage.sysdir.1=system-images/android-34/google_apis/arm64-v8a/\n')).toMatchObject({
      'hw.lcd.width': '1080',
      'image.sysdir.1': 'system-images/android-34/google_apis/arm64-v8a/'
    })
  })

  it('picks the emulator log line that says why it stopped', () => {
    const log = 'INFO | Android emulator version 36\nERROR | Running multiple emulators with the same AVD\nINFO | bye\n'
    expect(lastError(log)).toBe('Running multiple emulators with the same AVD')
    expect(lastError('INFO | only info\n')).toBe('INFO | only info')
  })
})

// The Linux discovery dir sits under the shared temp dir, where another local user can create
// `/tmp/android-<user>` first and plant a file whose grpc.port receives the user's keystrokes.
describe.skipIf(process.platform === 'win32')('runningEmulators trust', () => {
  const uid = process.getuid!()
  let base = ''
  afterEach(() => {
    vi.restoreAllMocks()
    if (base) rmSync(base, { recursive: true, force: true })
    base = ''
  })
  function plant(): { dir: string; trustedBase: string } {
    base = mkdtempSync(path.join(os.tmpdir(), 'nt-avd-'))
    const dir = path.join(base, 'android-me', 'avd', 'running')
    mkdirSync(dir, { recursive: true })
    writeFileSync(path.join(dir, `pid_${process.pid}.ini`), DISCOVERY)
    return { dir, trustedBase: base }
  }

  it('reads a discovery file in a directory chain we own', async () => {
    const found = await runningEmulators([plant()], uid)
    expect(found.map((e) => e.endpoint?.port)).toEqual([8554])
  })

  it('ignores a directory chain owned by another user', async () => {
    expect(await runningEmulators([plant()], uid + 1)).toEqual([])
  })

  it('ignores a symlinked component in the chain', async () => {
    const real = plant()
    const linked = path.join(base, 'android-link')
    symlinkSync(path.join(base, 'android-me'), linked)
    expect(await runningEmulators([{ dir: path.join(linked, 'avd', 'running'), trustedBase: base }], uid)).toEqual([])
    expect(await runningEmulators([real], uid)).toHaveLength(1)
  })

  it('ignores a symlinked discovery file', async () => {
    const d = plant()
    const target = path.join(base, 'elsewhere.ini')
    writeFileSync(target, DISCOVERY)
    rmSync(path.join(d.dir, `pid_${process.pid}.ini`))
    symlinkSync(target, path.join(d.dir, `pid_${process.pid}.ini`))
    expect(await runningEmulators([d], uid)).toEqual([])
  })

  it("treats a pid we may not signal (EPERM) as not ours", async () => {
    const d = plant()
    vi.spyOn(process, 'kill').mockImplementation(() => {
      throw Object.assign(new Error('EPERM'), { code: 'EPERM' })
    })
    expect(await runningEmulators([d], uid)).toEqual([])
  })
})

describe('Android SDK tools', () => {
  it('takes the tool from the first root that has it, not the first root that exists', async () => {
    const has = new Set([path.join('/studio/sdk', 'emulator', 'emulator')])
    const check = async (p: string) => has.has(p)
    expect(await firstSdkTool(['/stale/sdk', '/studio/sdk'], ['emulator', 'emulator'], check)).toBe(path.join('/studio/sdk', 'emulator', 'emulator'))
    expect(await firstSdkTool(['/stale/sdk'], ['platform-tools', 'adb'], check)).toBeNull()
  })

  it('never starts the emulator detached on Windows (it would open console windows)', () => {
    expect(emulatorSpawnOptions('win32')).toEqual({ detached: false, windowsHide: true })
    expect(emulatorSpawnOptions('darwin').detached).toBe(true)
    expect(emulatorSpawnOptions('linux').detached).toBe(true)
  })
})

describe('waiting for Android to finish booting', () => {
  /** A fake adb: answers `-s <serial> shell getprop sys.boot_completed` from a counter file, empty
   *  until the Nth call, then "1"; records its argv. */
  function fakeAdb(readyOnCall: number | null): { bin: string; argv: string } {
    const dir = testTmpDir('nt-fake-adb-')
    const bin = path.join(dir, 'adb')
    const argv = path.join(dir, 'argv')
    writeFileSync(
      bin,
      `#!/bin/sh
printf '%s\\n' "$*" >> '${argv}'
n=$(cat '${dir}/n' 2>/dev/null || echo 0); n=$((n + 1)); echo "$n" > '${dir}/n'
${readyOnCall === null ? "echo ''" : `if [ "$n" -ge ${readyOnCall} ]; then echo 1; else echo ''; fi`}
`,
      { mode: 0o755 }
    )
    return { bin, argv }
  }
  const instant = { sleep: async () => undefined, pollMs: 1000 }

  it.skipIf(process.platform === 'win32')('returns once the fake adb reports sys.boot_completed=1', async () => {
    const { bin, argv } = fakeAdb(3)
    await waitForBootCompleted(() => adbAt(bin, 'emulator-5554', ['shell', 'getprop', 'sys.boot_completed']), { ...instant, timeoutMs: 90_000 })
    const calls = readFileSync(argv, 'utf8').trim().split('\n')
    expect(calls).toEqual(Array(3).fill('-s emulator-5554 shell getprop sys.boot_completed'))
  })

  it.skipIf(process.platform === 'win32')('gives up with a plain sentence when Android never finishes', async () => {
    const { bin } = fakeAdb(null)
    let t = 0
    await expect(
      waitForBootCompleted(() => adbAt(bin, 'emulator-5554', ['shell', 'getprop', 'sys.boot_completed']), {
        timeoutMs: 5_000,
        pollMs: 1_000,
        now: () => t,
        sleep: async (ms) => {
          t += ms
        }
      })
    ).rejects.toThrow(BOOT_NOT_COMPLETED_MESSAGE)
  })

  it('treats a failing adb (device still offline) as not booted yet', async () => {
    let calls = 0
    await waitForBootCompleted(async () => {
      calls++
      if (calls < 3) throw new Error('error: device offline')
      return '1\n'
    }, instant)
    expect(calls).toBe(3)
  })
})
