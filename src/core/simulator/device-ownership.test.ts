import { describe, expect, it, vi } from 'vitest'
import { createDeviceOwnership, type DeviceOwnershipDeps } from './device-ownership'

function deps(over: Partial<DeviceOwnershipDeps> = {}): DeviceOwnershipDeps & {
  shutdownIos: ReturnType<typeof vi.fn>
  shutdownAndroid: ReturnType<typeof vi.fn>
} {
  return {
    iosBooted: async () => true,
    androidPid: async () => 4242,
    shutdownIos: vi.fn(async () => undefined),
    shutdownAndroid: vi.fn(async () => undefined),
    ...over
  } as never
}

describe('device ownership', () => {
  it('shuts down only the devices this app booted', async () => {
    const d = deps({ androidPid: async (avd) => (avd === 'Ours' ? 4242 : 999) })
    const own = createDeviceOwnership(d)
    own.claimIos('aaaa-ours')
    own.claimAndroid('Ours', 4242)
    const asked = await own.shutdownOwned(1000)
    expect(asked).toEqual({ ios: ['AAAA-OURS'], android: ['Ours'] })
    expect(d.shutdownIos).toHaveBeenCalledTimes(1)
    expect(d.shutdownIos).toHaveBeenCalledWith('AAAA-OURS')
    expect(d.shutdownAndroid).toHaveBeenCalledWith('Ours')
    // Nothing else was ever named, so nothing else was touched.
    expect(d.shutdownAndroid).toHaveBeenCalledTimes(1)
  })

  it('leaves a device it never claimed alone (user-booted, or already running at boot)', async () => {
    const d = deps()
    const own = createDeviceOwnership(d)
    expect(await own.shutdownOwned(1000)).toEqual({ ios: [], android: [] })
    expect(d.shutdownIos).not.toHaveBeenCalled()
    expect(d.shutdownAndroid).not.toHaveBeenCalled()
  })

  it('does not shut down an emulator running under our AVD name but a different pid', async () => {
    const d = deps({ androidPid: async () => 5555 })
    const own = createDeviceOwnership(d)
    own.claimAndroid('Pixel', 4242)
    expect((await own.shutdownOwned(1000)).android).toEqual([])
    expect(d.shutdownAndroid).not.toHaveBeenCalled()
  })

  it('never shuts down on a guess: an unknown iOS state is left alone', async () => {
    const d = deps({ iosBooted: async () => null })
    const own = createDeviceOwnership(d)
    own.claimIos('X')
    expect((await own.shutdownOwned(1000)).ios).toEqual([])
    expect(d.shutdownIos).not.toHaveBeenCalled()
  })

  it('forgets a device released by the node or seen shut down', async () => {
    const d = deps()
    const own = createDeviceOwnership(d)
    own.claimIos('a')
    own.claimAndroid('P', 4242)
    own.releaseIos('A')
    own.releaseAndroid('P')
    expect(own.ownedIos()).toEqual([])
    expect(own.ownedAndroid()).toEqual([])
    await own.shutdownOwned(1000)
    expect(d.shutdownIos).not.toHaveBeenCalled()
    expect(d.shutdownAndroid).not.toHaveBeenCalled()
  })

  it('returns within the timeout when a shutdown hangs', async () => {
    const d = deps({ shutdownIos: vi.fn(() => new Promise(() => undefined)) as never })
    const own = createDeviceOwnership(d)
    own.claimIos('slow')
    const started = Date.now()
    const asked = await own.shutdownOwned(50)
    expect(Date.now() - started).toBeLessThan(1000)
    expect(asked.ios).toEqual(['SLOW'])
  })
})
