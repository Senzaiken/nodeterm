/**
 * Which simulators THIS app started, so quitting shuts those down and nothing else.
 *
 * A Simulator node boots its device headless — the node is the only screen it has — so a device the
 * node booted keeps running invisibly after the app quits (an Android emulator started with
 * `-no-window` is a process with no UI at all). Quitting therefore shuts down what the node booted.
 * It never touches a device the user booted themselves, or one that was already running when the
 * node asked for it: ownership is recorded at boot time, from the boot's own answer, and only for a
 * boot that actually started the device.
 *
 * Ownership is dropped as soon as it is no longer provable: the node shut the device down, a listing
 * shows it shut down (someone else did, and a later boot is theirs), or — Android — the emulator
 * running under that name is a different process from the one we started.
 */

export interface DeviceOwnershipDeps {
  /** Whether the iOS simulator is booted now; null = cannot tell (never shut down on a guess). */
  iosBooted(udid: string): Promise<boolean | null>
  /** The pid of the emulator running this AVD now, or null when none is running. */
  androidPid(avd: string): Promise<number | null>
  shutdownIos(udid: string): Promise<unknown>
  shutdownAndroid(avd: string): Promise<unknown>
}

export interface DeviceOwnership {
  claimIos(udid: string): void
  claimAndroid(avd: string, pid: number): void
  /** The node shut this device down, or it was seen shut down: it is no longer ours. */
  releaseIos(udid: string): void
  releaseAndroid(avd: string): void
  ownedIos(): string[]
  ownedAndroid(): Array<{ avd: string; pid: number }>
  /**
   * Shut down every device still ours, re-checking each first. Resolves within `timeoutMs` whatever
   * the devices do (quit must never wait on a simulator); answers which ones were asked to shut down.
   */
  shutdownOwned(timeoutMs: number): Promise<{ ios: string[]; android: string[] }>
}

export function createDeviceOwnership(deps: DeviceOwnershipDeps): DeviceOwnership {
  const ios = new Set<string>()
  const android = new Map<string, number>()
  const key = (udid: string) => udid.toUpperCase()

  return {
    claimIos: (udid) => void ios.add(key(udid)),
    claimAndroid: (avd, pid) => void android.set(avd, pid),
    releaseIos: (udid) => void ios.delete(key(udid)),
    releaseAndroid: (avd) => void android.delete(avd),
    ownedIos: () => [...ios],
    ownedAndroid: () => [...android].map(([avd, pid]) => ({ avd, pid })),
    async shutdownOwned(timeoutMs) {
      const asked = { ios: [] as string[], android: [] as string[] }
      const work = Promise.allSettled([
        ...[...ios].map(async (udid) => {
          if ((await deps.iosBooted(udid)) !== true) return
          asked.ios.push(udid)
          await deps.shutdownIos(udid)
          ios.delete(udid)
        }),
        ...[...android].map(async ([avd, pid]) => {
          // Same name, different process: the user started this one after ours went away.
          if ((await deps.androidPid(avd)) !== pid) return
          asked.android.push(avd)
          await deps.shutdownAndroid(avd)
          android.delete(avd)
        })
      ])
      let timer: ReturnType<typeof setTimeout> | undefined
      await Promise.race([work, new Promise<void>((r) => (timer = setTimeout(r, timeoutMs)))])
      if (timer) clearTimeout(timer)
      return { ios: [...asked.ios], android: [...asked.android] }
    }
  }
}
