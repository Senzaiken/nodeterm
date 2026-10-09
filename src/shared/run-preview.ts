/**
 * The preview panel inside a run node: a simulator for a run that targets a phone, a browser for one
 * that targets a browser (a `chrome` / `msedge` launch configuration, a Flutter web device) or serves
 * a page (a dev server: vite, next, a Flask app…). Pure decisions, shared by the run bar and tests.
 */

// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/

/** Persisted on a run node as `data.runBrowser`: present = the browser panel is shown. */
export interface RunBrowserConfig {
  /** The page shown. Absent until the run prints one (or the person types one). */
  url?: string
  /** The URL was picked out of the run's output, so the next run (which may serve on a different
   *  port) looks again rather than keeping a stale one. */
  auto?: boolean
}

export function isPreviewUrl(v: unknown): v is string {
  return typeof v === 'string' && v.length <= 4096 && !CONTROL.test(v) && /^https?:\/\/[^\s]+$/i.test(v)
}

/** Re-validate a persisted panel (git-shared, hand-editable). Only http(s) pages load in it. */
export function normalizeRunBrowserConfig(raw: unknown): RunBrowserConfig | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const r = raw as Record<string, unknown>
  const out: RunBrowserConfig = {}
  if (isPreviewUrl(r.url)) {
    out.url = r.url
    if (r.auto === true) out.auto = true
  }
  return out
}

export type PreviewKind = 'simulator' | 'browser'

export interface PreviewTarget {
  /** The configuration takes a device (Flutter) and lets the person pick it. */
  picksDevice: boolean
  /** The picked device's id and kind, when there is one. */
  deviceId?: string
  deviceKind?: string
  /** A `chrome` / `msedge` configuration: it opens a page rather than running a process. */
  browserConfig: boolean
  /** The configuration takes a device but pins its own (`-d` in its args). */
  pinsDevice: boolean
}

const IOS_UDID = /^[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}$/

/** Which panel 📱 / 🌐 opens for a run. */
export function previewKindFor(t: PreviewTarget): PreviewKind {
  if (t.browserConfig) return 'browser'
  if (t.picksDevice) {
    if (t.deviceKind === 'web' || t.deviceId === 'chrome' || t.deviceId === 'edge' || t.deviceId === 'web-server') return 'browser'
    return 'simulator'
  }
  // A configuration that pins its own device is a phone run whose device we cannot see; anything
  // else that runs a process is most likely a server whose page is the thing to look at.
  if (t.pinsDevice) return 'simulator'
  return 'browser'
}

/** Whether a device id names a simulator the simulator panel can show by itself. */
export function isSimulatorDeviceId(id: string | undefined): boolean {
  return !!id && (IOS_UDID.test(id) || /^emulator-\d+$/.test(id))
}

/**
 * Flutter's browser devices open their OWN browser window. With the browser panel open, the run uses
 * `web-server` instead — Flutter serves the same app to any browser that opens its URL (this panel
 * included) and prints that URL. Returns the device to run on, or the same one when no swap is due.
 */
export function deviceForBrowserPanel(deviceId: string | undefined, panelOpen: boolean): string | undefined {
  if (!panelOpen) return deviceId
  return deviceId === 'chrome' || deviceId === 'edge' ? 'web-server' : deviceId
}

const LOCAL_URL = /\bhttps?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1?\])(?::\d{2,5})?(?:\/[^\s'"<>`)\]]*)?/gi
/** A line naming where the app is served — preferred over any other URL on screen. */
const SERVED_LINE = /served at|\blocal:|listening (?:on|at)|running (?:on|at)|available (?:on|at)|ready (?:on|at)|started (?:server )?on|server running/i
/** URLs that are tools, not the app (Flutter DevTools, the Dart VM service, debugger endpoints). */
const TOOL_LINE = /devtools|debugger|dart vm|vm service|observatory|inspect|profiler/i

/**
 * The page a run serves, picked out of its terminal output: the newest local http(s) URL on a line
 * that says where the app is served, else the newest local URL that is not a tool's. `0.0.0.0` (bound
 * on every interface) is opened as `localhost`. Null when the output names none yet.
 */
export function localUrlFromOutput(text: string): string | null {
  let served: string | null = null
  let other: string | null = null
  for (const line of text.split(/\r?\n/)) {
    if (TOOL_LINE.test(line)) continue
    const urls = line.match(LOCAL_URL)
    if (!urls) continue
    const url = urls[urls.length - 1].replace(/[.,;:]+$/, '').replace('://0.0.0.0', '://localhost')
    if (SERVED_LINE.test(line)) served = url
    else other = url
  }
  return served ?? other
}
