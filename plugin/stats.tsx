// ShuraCode stats: the live numbers from the Shura gateway's monitor (GET /monitor/api/state, schema 1).
// This file holds the logic only: plain TypeScript, no JSX and no imports, so tests/stats.test.mjs can load it
// with Node. The Solid components that draw these numbers are in shuracode.tsx.
// Colours come from the gateway's own `health.level`. The only numbers decided here are bar scales (how much
// tokens/s or degrees fill a bar), never warning thresholds.

export const SCHEMA = 1
export const POLL_MS = 1000 // at most one request per second, and only while something shows the numbers
export const TIMEOUT_MS = 3000 // a gateway slower than this counts as offline
const SPEED_FULL = 100 // tokens per second at a full speed bar
const TEMP_FULL = 100 // degrees Celsius at a full temperature bar

export type Tone = "green" | "amber" | "red" | "grey"
export type Monitor = Record<string, any>
export type Reading =
  | { kind: "ok"; state: Monitor }
  | { kind: "offline"; reason: string }
  | { kind: "unsupported"; reason: string }
export type Row = { label: string; text: string; bar: string | null }
export type View = { tone: Tone; line: string; banner: string | null; rows: Row[] }

const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v)
const get = (o: unknown, key: string): any => (o && typeof o === "object" ? (o as Monitor)[key] : undefined)

export function monitorUrl(gateway: string): string {
  try {
    return new URL(gateway).origin + "/monitor/api/state"
  } catch {
    return ""
  }
}

// The monitor page the gateway serves in a browser. `?view=compact` is the small layout (the page's own switch).
export function monitorPageUrl(gateway: string, compact: boolean): string {
  try {
    return new URL(gateway).origin + "/monitor" + (compact ? "?view=compact" : "")
  } catch {
    return ""
  }
}

type Child = { on(event: "error", fn: () => void): unknown; unref(): unknown }
type SpawnLike = (cmd: string, args: string[], opts: { detached: boolean; stdio: "ignore" }) => Child

// Opens a URL in the desktop's browser through xdg-open: detached, without waiting. `onFail` runs when the opener
// cannot start (for example, it is not installed); xdg-open's own exit code is not read here.
export function openInBrowser(url: string, spawnFn: SpawnLike, onFail: () => void): void {
  try {
    const child = spawnFn("xdg-open", [url], { detached: true, stdio: "ignore" })
    child.on("error", onFail)
    child.unref()
  } catch {
    onFail()
  }
}

export function toneOf(level: unknown): Tone {
  return level === "ok" ? "green" : level === "warn" ? "amber" : level === "crit" ? "red" : "grey"
}

// Any body that is not the schema-1 object becomes a reading that the view can show without throwing.
export function parseReading(ok: boolean, body: string): Reading {
  if (!ok) return { kind: "offline", reason: "HTTP error" }
  let data: unknown
  try {
    data = JSON.parse(body)
  } catch {
    return { kind: "offline", reason: "broken JSON" }
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) return { kind: "offline", reason: "not an object" }
  const state = data as Monitor
  if (state.schema !== SCHEMA) return { kind: "unsupported", reason: `schema ${String(state.schema)}` }
  return { kind: "ok", state }
}

// Text for a number. Anything that is not a finite number reads "n/a", so a missing value never shows as 0.
export function num(value: unknown, digits: number, unit: string): string {
  return finite(value) ? value.toFixed(digits) + unit : "n/a"
}

// Share of `whole` that `part` makes up, clipped to 0..1; null when either side is missing.
export function ratio(part: unknown, whole: unknown): number | null {
  return finite(part) && finite(whole) && whole > 0 ? Math.min(1, Math.max(0, part / whole)) : null
}

// A bar of block characters, or null when there is no fill to draw (the bar is then hidden, not drawn empty).
export function bar(fill: number | null, cells = 20): string | null {
  if (fill === null) return null
  const on = Math.round(fill * cells)
  return "█".repeat(on) + "░".repeat(cells - on)
}

const gb = (mib: unknown) => (finite(mib) ? (mib / 1024).toFixed(1) : null)

// Session start: requests answered before this ShuraCode started are not counted in the average.
export const SESSION_START = Date.now() / 1000

// Average answer speed over this session, weighted by tokens (sum of tokens / sum of decode time), so short
// answers do not skew it. Uses the gateway's recent-requests list; null when there is nothing to average.
export function sessionSpeed(requests: unknown, since = SESSION_START): number | null {
  if (!Array.isArray(requests)) return null
  let tokens = 0
  let seconds = 0
  for (const r of requests) {
    const at = get(r, "at")
    const n = get(r, "completion_tokens")
    const v = get(r, "decode_per_second")
    if (get(r, "status") !== 200 || !finite(at) || at < since || !finite(n) || !finite(v) || n <= 0 || v <= 0) continue
    tokens += n
    seconds += n / v
  }
  return seconds > 0 ? tokens / seconds : null
}

// One row per number the panel shows. A capability the gateway reports as false, or a missing number, gives
// "n/a" and no bar.
export function rowsOf(s: Monitor): Row[] {
  const caps = get(s, "capabilities")
  const has = (name: string) => get(caps, name) === true
  const gpu = get(s, "gpu")
  const mem = get(s, "memory")
  const cpu = get(s, "cpu")
  const last = get(get(s, "last_request"), "decode_per_second")
  const avg = sessionSpeed(get(s, "_requests"))
  const speed = avg ?? last
  const context = get(get(s, "context"), "used_percent")
  const gpuCaps = has("gpu_nvidia") || has("gpu_amd") || has("gpu_intel")
  const vramOk = gpuCaps && finite(get(gpu, "free_mib")) && finite(get(gpu, "total_mib"))
  const ramOk = finite(get(mem, "ram_available_mib")) && finite(get(mem, "ram_total_mib"))
  const gpuTemp = gpuCaps ? get(gpu, "temperature_c") : undefined
  const cpuTemp = has("cpu_temp") ? get(cpu, "temperature_c") : undefined
  const zram = has("zram") ? get(mem, "zram_used_percent") : undefined
  return [
    {
      label: avg !== null ? "Speed avg" : "Speed",
      text: num(speed, 1, " tok/s") + (avg !== null && finite(last) ? ` · last ${last.toFixed(1)}` : ""),
      bar: bar(ratio(speed, SPEED_FULL)),
    },
    { label: "Context", text: num(context, 0, "%"), bar: bar(ratio(context, 100)) },
    vramOk
      ? { label: "VRAM", text: `free ${gb(gpu.free_mib)} of ${gb(gpu.total_mib)} GB`, bar: bar(ratio(gpu.used_mib, gpu.total_mib)) }
      : { label: "VRAM", text: "n/a", bar: null },
    ramOk
      ? {
          label: "RAM",
          text: `free ${gb(mem.ram_available_mib)} of ${gb(mem.ram_total_mib)} GB`,
          bar: bar(ratio(mem.ram_total_mib - mem.ram_available_mib, mem.ram_total_mib)),
        }
      : { label: "RAM", text: "n/a", bar: null },
    { label: "zram", text: num(zram, 0, "%"), bar: bar(ratio(zram, 100)) },
    { label: "GPU temp", text: num(gpuTemp, 0, " °C"), bar: bar(ratio(gpuTemp, TEMP_FULL)) },
    { label: "CPU temp", text: num(cpuTemp, 0, " °C"), bar: bar(ratio(cpuTemp, TEMP_FULL)) },
  ]
}

// Everything the status line and the side panel draw, from one reading. `null` means no reply yet.
export function viewOf(reading: Reading | null): View {
  if (reading === null) return { tone: "grey", line: "…", banner: null, rows: [] }
  if (reading.kind === "offline") return { tone: "grey", line: "Offline", banner: null, rows: [] }
  if (reading.kind === "unsupported") return { tone: "grey", line: "n/a", banner: null, rows: [] }
  const s = reading.state
  const health = get(s, "health")
  const tone = toneOf(get(health, "level"))
  const model = String(get(get(s, "header"), "model") || "model")
  const rows = rowsOf(s)
  const speed = rows[0].text.split(" · ")[0]
  const context = rows[1].text
  const vram = rows[2].text === "n/a" ? "" : " · VRAM " + rows[2].text
  return {
    tone,
    line: `${model} · ${speed} · ctx ${context}${vram}`,
    banner: tone === "red" ? String(get(health, "hint") || "Health is critical") : null,
    rows,
  }
}

export type Poller = {
  retain: () => void // a visible consumer starts needing numbers
  release: () => void // a consumer went away; the last release stops all requests
  stop: () => void // dispose: stop everything
  latest: () => Reading | null
}

export type PollerOptions = {
  url: string
  onChange?: (reading: Reading) => void
  fetch?: typeof fetch
  pollMs?: number
  timeoutMs?: number
}

// One request at a time. The first retain fetches at once, then once per pollMs while anyone is retained.
// Nothing here throws: a failed or slow request becomes an offline reading.
export function createPoller(opts: PollerOptions): Poller {
  const pollMs = opts.pollMs ?? POLL_MS
  const timeoutMs = opts.timeoutMs ?? TIMEOUT_MS
  const doFetch = opts.fetch ?? fetch
  let users = 0
  let timer: ReturnType<typeof setInterval> | undefined
  let inFlight: AbortController | null = null
  let last: Reading | null = null

  const emit = (reading: Reading) => {
    last = reading
    try {
      opts.onChange?.(reading)
    } catch {
      // a broken consumer must not stop polling
    }
  }

  async function tick() {
    if (inFlight) return
    if (!opts.url) return emit({ kind: "offline", reason: "no gateway" })
    const ctl = new AbortController()
    inFlight = ctl
    const deadline = setTimeout(() => ctl.abort(), timeoutMs)
    try {
      const res = await doFetch(opts.url, { signal: ctl.signal, headers: { accept: "application/json" } })
      const body = await res.text()
      const reading = parseReading(res.ok, body)
      if (reading.kind === "ok" && opts.url.endsWith("/monitor/api/state")) {
        try {
          const r2 = await doFetch(opts.url.replace(/state$/, "requests"), { signal: ctl.signal, headers: { accept: "application/json" } })
          if (r2.ok) reading.state._requests = JSON.parse(await r2.text())
        } catch {
          // the average is optional: without the list the panel shows the last answer's speed
        }
      }
      if (inFlight === ctl) emit(reading)
    } catch {
      if (inFlight === ctl) emit({ kind: "offline", reason: "unreachable" })
    } finally {
      clearTimeout(deadline)
      if (inFlight === ctl) inFlight = null
    }
  }

  const stopTimer = () => {
    if (timer !== undefined) clearInterval(timer)
    timer = undefined
    if (inFlight) {
      const ctl = inFlight
      inFlight = null
      ctl.abort()
    }
  }

  return {
    retain() {
      users += 1
      if (users === 1) {
        void tick().catch(() => {})
        timer = setInterval(() => void tick().catch(() => {}), pollMs)
      }
    },
    release() {
      if (users === 0) return
      users -= 1
      if (users === 0) stopTimer()
    },
    stop() {
      users = 0
      stopTimer()
    },
    latest: () => last,
  }
}
