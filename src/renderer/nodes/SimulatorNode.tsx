import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { NodeResizer, useReactFlow, type NodeProps } from '@xyflow/react'
import {
  ORIENTATION_DEGREES,
  ORIENTATION_PURPLE,
  displayLabel,
  displayToFramebuffer,
  hidUsageForCode,
  rotateOrientation,
  pointerToScreenRatio,
  type SimulatorDisplayInfo,
  type SimulatorInput,
  type SimulatorNodeConfig,
  type SimulatorOrientation,
  type SimulatorStatusEvent
} from '@shared/simulator'
import type { RunDevice } from '@shared/run-config'
import { useSession } from '../session/session'
import { NODE_MIN_SIZES } from '../lib/nodeSizing'
import type { CanvasNode } from '../state/workspace'

/**
 * The Simulator node: a live iOS simulator screen on the canvas (see @shared/simulator and
 * core/simulator). The mouse is the finger — click = tap, drag = swipe, scroll wheel = a swipe —
 * the keyboard types into the device while the screen has focus, and Home / Lock are buttons.
 *
 * Frames arrive as JPEGs (only when the screen changed) and are drawn `object-fit: contain`, so the
 * phone keeps its proportions in any node size; `pointerToScreenRatio` maps a click through the
 * letterbox. The helper streams only while this node is mounted.
 */

type Phase = 'idle' | 'starting' | 'live' | 'error'

const WHEEL_END_MS = 140
/** A wheel notch moves the synthetic finger by this fraction of the screen per 100 px of delta. */
const WHEEL_SCALE = 0.25

export function SimulatorNode({ id, data, selected }: NodeProps<CanvasNode>) {
  const { api } = useSession()
  const { updateNodeData, deleteElements } = useReactFlow()
  const config = (data.simulator as SimulatorNodeConfig | undefined) ?? {}
  const udid = config.udid
  const orientation: SimulatorOrientation = config.orientation ?? 'portrait'
  // Read by the draw loop and the input path, which live in long-lived closures.
  const orientationRef = useRef(orientation)
  orientationRef.current = orientation
  /** The newest decoded frame, kept so a rotation can redraw it even when the device sends no new
   *  frame (an app that does not rotate leaves the framebuffer unchanged). */
  const lastBitmap = useRef<ImageBitmap | null>(null)

  const [devices, setDevices] = useState<RunDevice[] | null>(null)
  const [phase, setPhase] = useState<Phase>('idle')
  const [message, setMessage] = useState<string | null>(null)
  const [displays, setDisplays] = useState<SimulatorDisplayInfo[]>([])
  const [activeDisplay, setActiveDisplay] = useState(0)
  const [pinned, setPinned] = useState(false)
  const [frameSize, setFrameSize] = useState<{ w: number; h: number } | null>(null)
  const [booting, setBooting] = useState(false)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const screenRef = useRef<HTMLDivElement>(null)

  const sim = simulators(devices)
  const device = sim.find((d) => d.id === udid)
  const booted = device?.state === 'booted'

  const loadDevices = useCallback(
    (refresh: boolean) => {
      void api.runConfig.devices(refresh).then((r) => setDevices(r.devices))
    },
    [api]
  )
  useEffect(() => loadDevices(false), [loadDevices])

  /** Draw the newest frame, turned to match how the device is held: the framebuffer is always
   *  portrait and iOS draws rotated content into it, so the picture is turned, as on a real panel. */
  const paint = useCallback(() => {
    const canvas = canvasRef.current
    const b = lastBitmap.current
    if (!canvas || !b) return
    const deg = ORIENTATION_DEGREES[orientationRef.current]
    const w = deg % 180 ? b.height : b.width
    const h = deg % 180 ? b.width : b.height
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w
      canvas.height = h
    }
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    ctx.setTransform(1, 0, 0, 1, 0, 0)
    if (deg === 90) ctx.setTransform(0, 1, -1, 0, w, 0)
    else if (deg === 180) ctx.setTransform(-1, 0, 0, -1, w, h)
    else if (deg === 270) ctx.setTransform(0, -1, 1, 0, 0, h)
    ctx.drawImage(b, 0, 0)
    ctx.setTransform(1, 0, 0, 1, 0, 0)
    setFrameSize((s) => (s && s.w === w && s.h === h ? s : { w, h }))
  }, [])
  useEffect(() => paint(), [orientation, paint])

  // ── Stream ───────────────────────────────────────────────────────────────────────────────────
  useEffect(() => {
    if (!udid || !booted) {
      setPhase('idle')
      return
    }
    let live = true
    setPhase('starting')
    setMessage(null)
    // Frames are decoded straight to an ImageBitmap and drawn on a canvas. Not an <img> with a
    // blob: URL: the renderer's CSP allows img-src 'self' data: nt-media: only, so every frame was
    // a broken image — and a canvas needs no URL at all.
    let pending: { bitmap: ImageBitmap; w: number; h: number } | null = null
    let raf = 0
    let decoding = 0
    const offFrame = api.simulator.onFrame(id, (f) => {
      if (!live) return
      const seq = ++decoding
      void createImageBitmap(new Blob([f.jpeg as BlobPart], { type: 'image/jpeg' })).then(
        (bitmap) => {
          // A newer frame decoded first (or the node went away): this one is stale.
          if (!live || seq < decoding) {
            bitmap.close()
            return
          }
          pending?.bitmap.close()
          pending = { bitmap, w: f.width, h: f.height }
          // Draw at most once per animation frame: a burst of frames shows the newest.
          if (!raf) {
            raf = requestAnimationFrame(() => {
              raf = 0
              if (!pending) return
              const { bitmap } = pending
              pending = null
              lastBitmap.current?.close()
              lastBitmap.current = bitmap
              paint()
              setPhase('live')
            })
          }
        },
        () => undefined
      )
    })
    const offStatus = api.simulator.onStatus(id, (e: SimulatorStatusEvent) => {
      if (!live) return
      if (e.kind === 'ready') {
        // Tell the device how the node holds it: after a reboot it is portrait whatever was saved.
        void api.simulator.input(id, { t: 'orientation', value: ORIENTATION_PURPLE[orientationRef.current] })
      } else if (e.kind === 'displays') {
        setDisplays(e.displays)
        setActiveDisplay(e.active)
        setPinned(e.pinned)
      } else if (e.kind === 'error') {
        setMessage(e.message)
        if (e.code !== 'hid-send' && e.code !== 'button') setPhase('error')
      } else if (e.kind === 'exited') {
        setPhase('error')
        // The helper reports why before it exits; keep that sentence when there is one.
        setMessage((prev) => prev ?? `The simulator view stopped (exit ${e.code ?? e.signal}).`)
      }
    })
    void api.simulator.start(id, udid).then((r) => {
      if (!live) return
      if (!r.ok) {
        setPhase('error')
        setMessage(r.error)
      }
    })
    return () => {
      live = false
      offFrame()
      offStatus()
      if (raf) cancelAnimationFrame(raf)
      pending?.bitmap.close()
      lastBitmap.current?.close()
      lastBitmap.current = null
      void api.simulator.stop(id)
    }
  }, [api, id, udid, booted, paint])

  // ── Input ────────────────────────────────────────────────────────────────────────────────────
  // Touches are measured on the (turned) picture and sent in portrait framebuffer coordinates.
  const send = useCallback(
    (cmd: SimulatorInput) => {
      const out =
        cmd.t === 'down' || cmd.t === 'move' || cmd.t === 'up'
          ? { ...cmd, ...displayToFramebuffer(cmd.x, cmd.y, orientationRef.current) }
          : cmd
      void api.simulator.input(id, out)
    },
    [api, id]
  )

  const rotate = useCallback(
    (dir: 'left' | 'right') => {
      const next = rotateOrientation(orientationRef.current, dir)
      orientationRef.current = next
      updateNodeData(id, (n) => ({ simulator: { ...(n.data.simulator as SimulatorNodeConfig | undefined), orientation: next } }))
      void api.simulator.input(id, { t: 'orientation', value: ORIENTATION_PURPLE[next] })
    },
    [api, id, updateNodeData]
  )

  const ratioAt = useCallback(
    (clientX: number, clientY: number) => {
      const box = screenRef.current?.getBoundingClientRect()
      if (!box || !frameSize) return null
      // Client-space on both sides, so the canvas zoom cancels out.
      return pointerToScreenRatio(clientX - box.left, clientY - box.top, box.width, box.height, frameSize.w, frameSize.h)
    },
    [frameSize]
  )

  const pressed = useRef<{ x: number; y: number } | null>(null)
  const moveRaf = useRef(0)
  const onPointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0 || phase !== 'live') return
    const p = ratioAt(e.clientX, e.clientY)
    screenRef.current?.focus()
    if (!p) return
    e.currentTarget.setPointerCapture(e.pointerId)
    pressed.current = p
    send({ t: 'down', ...p })
    e.preventDefault()
  }
  const onPointerMove = (e: React.PointerEvent) => {
    if (!pressed.current) return
    const { clientX, clientY } = e
    if (moveRaf.current) return
    moveRaf.current = requestAnimationFrame(() => {
      moveRaf.current = 0
      const box = screenRef.current?.getBoundingClientRect()
      if (!box || !frameSize || !pressed.current) return
      // While pressed, a drag past the screen's edge pins to the edge instead of dropping out.
      const p = ratioAt(clientX, clientY) ?? clampedRatio(clientX, clientY, box, frameSize)
      pressed.current = p
      send({ t: 'move', ...p })
    })
  }
  const onPointerUp = (e: React.PointerEvent) => {
    if (!pressed.current) return
    const box = screenRef.current?.getBoundingClientRect()
    const p = ratioAt(e.clientX, e.clientY) ?? (box && frameSize ? clampedRatio(e.clientX, e.clientY, box, frameSize) : pressed.current)
    pressed.current = null
    send({ t: 'up', ...p })
  }

  // The scroll wheel becomes a swipe: a finger that goes down where the pointer is, follows the
  // wheel, and lifts once the wheel stops.
  const wheel = useRef<{ x: number; y: number; timer: ReturnType<typeof setTimeout> } | null>(null)
  const onWheel = (e: React.WheelEvent) => {
    if (phase !== 'live') return
    const box = screenRef.current?.getBoundingClientRect()
    if (!box || !frameSize) return
    if (!wheel.current) {
      const p = ratioAt(e.clientX, e.clientY)
      if (!p) return
      send({ t: 'down', ...p })
      wheel.current = { ...p, timer: setTimeout(() => undefined, 0) }
    }
    const w = wheel.current
    clearTimeout(w.timer)
    w.x = Math.min(1, Math.max(0, w.x - (e.deltaX / 100) * WHEEL_SCALE))
    w.y = Math.min(1, Math.max(0, w.y - (e.deltaY / 100) * WHEEL_SCALE))
    send({ t: 'move', x: w.x, y: w.y })
    w.timer = setTimeout(() => {
      send({ t: 'up', x: w.x, y: w.y })
      wheel.current = null
    }, WHEEL_END_MS)
  }

  // Keys go to the device as physical keys (it applies its own layout and Shift). ⌘-chords stay
  // with nodeterm so the app's own shortcuts keep working while the screen has focus.
  const onKey = (down: boolean) => (e: React.KeyboardEvent) => {
    // ⌘← / ⌘→ rotate, as they did in Simulator.app.
    if (phase === 'live' && e.metaKey && (e.code === 'ArrowLeft' || e.code === 'ArrowRight')) {
      e.preventDefault()
      e.stopPropagation()
      if (down && !e.repeat) rotate(e.code === 'ArrowLeft' ? 'left' : 'right')
      return
    }
    if (phase !== 'live' || (e.metaKey && e.code !== 'MetaLeft' && e.code !== 'MetaRight')) return
    const usage = hidUsageForCode(e.code)
    if (usage === undefined) return
    e.preventDefault()
    e.stopPropagation()
    if (down && e.repeat) return
    send({ t: 'key', usage, down })
  }

  // ── Header actions ───────────────────────────────────────────────────────────────────────────
  const pick = (value: string) => {
    const d = sim.find((x) => x.id === value)
    updateNodeData(id, (n) => ({
      simulator: { udid: value, name: d?.name },
      ...(n.data.titleAuto !== false && d ? { title: d.name } : {})
    }))
  }
  const boot = async () => {
    if (!udid) return
    setBooting(true)
    const ok = await api.runConfig.bootDevice(udid)
    setBooting(false)
    if (!ok) setMessage('Could not boot this simulator.')
    loadDevices(true)
  }
  const shutdown = async () => {
    if (!udid) return
    await api.simulator.shutdown(udid)
    loadDevices(true)
  }

  const statusText =
    booting
      ? 'Booting…'
      : phase === 'starting'
        ? 'Connecting…'
        : phase === 'live'
          ? ''
          : !udid
            ? ''
            : device && !booted
              ? 'Shut down'
              : ''

  const twins = useMemo(() => new Set(sim.filter((d, i) => sim.findIndex((o) => o.name === d.name && o.platform === d.platform) !== i).map((d) => `${d.name}|${d.platform}`)), [sim])
  const deviceLabel = (d: RunDevice) =>
    `${d.name}${d.platform ? ` · ${d.platform}` : ''}${twins.has(`${d.name}|${d.platform}`) ? ` · ${d.id.slice(0, 4)}` : ''}${d.state === 'booted' ? '' : ' (off)'}`

  return (
    <>
      <div className={`sim-node${selected ? ' selected' : ''}`}>
        <div className="sim-node__header" style={{ background: `${data.color}22` }}>
          <span className="sim-node__title" title={data.title as string}>
            {data.title as string}
          </span>
          <button className="term-node__close nodrag" title="Close" onClick={() => deleteElements({ nodes: [{ id }] })}>
            ×
          </button>
        </div>
        <div className="sim-node__bar nodrag nowheel">
          <select className="run-bar__select sim-node__device" value={udid ?? ''} onChange={(e) => pick(e.target.value)}>
            {!udid && <option value="">{devices ? 'Pick a simulator…' : 'Loading…'}</option>}
            {udid && !device && <option value={udid}>{config.name ?? udid}</option>}
            {sim.map((d) => (
              <option key={d.id} value={d.id}>
                {deviceLabel(d)}
              </option>
            ))}
          </select>
          <button className="run-bar__icon" title="Refresh simulators" onClick={() => loadDevices(true)}>
            ⟳
          </button>
          {udid && device && !booted && (
            <button className="run-bar__btn run-bar__btn--run" disabled={booting} onClick={() => void boot()}>
              Boot
            </button>
          )}
          {displays.length > 1 && (
            <select
              className="run-bar__select"
              title="Which screen to show (a foldable has two)"
              value={pinned ? String(activeDisplay) : '-1'}
              onChange={(e) => send({ t: 'display', index: Number(e.target.value) })}
            >
              <option value="-1">Auto ({displayLabel(displays[activeDisplay] ?? displays[0], displays)})</option>
              {displays.map((d) => (
                <option key={d.index} value={d.index}>
                  {displayLabel(d, displays)}
                </option>
              ))}
            </select>
          )}
          <span className="run-bar__spacer" />
          {phase === 'live' && (
            <>
              <button className="run-bar__icon" title="Rotate left (⌘←)" onClick={() => rotate('left')}>
                ↺
              </button>
              <button className="run-bar__icon" title="Rotate right (⌘→)" onClick={() => rotate('right')}>
                ↻
              </button>
              <button className="run-bar__icon" title="Home" onClick={() => send({ t: 'button', name: 'home' })}>
                ⌂
              </button>
              <button className="run-bar__icon" title="Lock / side button" onClick={() => send({ t: 'button', name: 'lock' })}>
                ⏻
              </button>
              <button className="run-bar__icon" title="Shut down this simulator" onClick={() => void shutdown()}>
                ⏏
              </button>
            </>
          )}
          {statusText && <span className="run-bar__status">{statusText}</span>}
        </div>
        <div
          ref={screenRef}
          className="sim-node__screen nodrag nowheel"
          tabIndex={0}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
          onWheel={onWheel}
          onKeyDown={onKey(true)}
          onKeyUp={onKey(false)}
        >
          <canvas ref={canvasRef} className="sim-node__frame" style={{ visibility: phase === 'live' ? 'visible' : 'hidden' }} />
          {phase !== 'live' && (
            <div className="sim-node__placeholder">
              {!udid
                ? 'Pick a simulator above.'
                : device && !booted
                  ? 'This simulator is shut down — Boot it to see its screen.'
                  : phase === 'starting'
                    ? 'Connecting to the simulator… (the first time builds a small helper with Xcode)'
                    : (message ?? '')}
            </div>
          )}
          {phase === 'live' && message && <div className="sim-node__note">{message}</div>}
        </div>
      </div>
      <NodeResizer minWidth={NODE_MIN_SIZES.simulator.width} minHeight={NODE_MIN_SIZES.simulator.height} isVisible={selected} color={data.color as string} />
    </>
  )
}

function simulators(devices: RunDevice[] | null): RunDevice[] {
  return (devices ?? []).filter((d) => d.kind === 'simulator')
}

/** A point outside the drawn screen, pinned to its nearest edge (a drag that leaves the screen). */
function clampedRatio(clientX: number, clientY: number, box: DOMRect, frame: { w: number; h: number }) {
  const scale = Math.min(box.width / frame.w, box.height / frame.h)
  const left = box.left + (box.width - frame.w * scale) / 2
  const top = box.top + (box.height - frame.h * scale) / 2
  return {
    x: Math.min(1, Math.max(0, (clientX - left) / (frame.w * scale))),
    y: Math.min(1, Math.max(0, (clientY - top) / (frame.h * scale)))
  }
}
