/** @jsxImportSource @opentui/solid */
// ShuraCode TUI plugin: branding (logo, footer, sidebar, tips, terminal title) and a live status line for
// the local model served by the Shura gateway. It uses only the engine's public TUI plugin API (slots),
// so engine updates do not overwrite it.
import type { TuiPlugin, TuiPluginApi, TuiPluginModule } from "@opencode-ai/plugin/tui"
import { RGBA, TextAttributes } from "@opentui/core"
import { createMemo, createRoot, createSignal, createEffect, For, Show } from "solid-js"
import { readdirSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

const VERSION = "0.1.0"

type Options = {
  gateway?: string // Shura gateway status URL; "" disables the model status
  memory_dir?: string
}

// ------------------------------------------------------------------------------------------------ logo
// Same 4-row block font as the engine's own logo. Marks: "_" shadow-filled space, "^" top half block on the
// shadow, "~" top half block drawn in the shadow colour.
const GLYPHS: Record<string, string[]> = {
  s: ["    ", "█▀▀▀", "▀▀▀█", "▀▀▀▀"],
  h: ["▄   ", "█▀▀▄", "█__█", "▀~~▀"],
  u: ["    ", "█__█", "█__█", "▀▀▀▀"],
  r: ["    ", "█▀▀▀", "█   ", "▀   "],
  a: ["    ", "█▀▀█", "█^^█", "▀~~▀"],
  c: ["    ", "█▀▀▀", "█___", "▀▀▀▀"],
  o: ["    ", "█▀▀█", "█__█", "▀▀▀▀"],
  d: ["   ▄", "█▀▀█", "█__█", "▀▀▀▀"],
  e: ["    ", "█▀▀█", "█^^^", "▀▀▀▀"],
}

function word(text: string): string[] {
  return [0, 1, 2, 3].map((row) => Array.from(text).map((ch) => GLYPHS[ch][row]).join(" "))
}

const LEFT = word("shura")
const RIGHT = word("code")

function mix(a: RGBA, b: RGBA, t: number): RGBA {
  return RGBA.fromValues(a.r + (b.r - a.r) * t, a.g + (b.g - a.g) * t, a.b + (b.b - a.b) * t, 1)
}

function Logo(props: { api: TuiPluginApi }) {
  const theme = () => props.api.theme.current
  const line = (text: string, fg: RGBA, bold: boolean) => {
    const shadow = mix(theme().background, fg, 0.25)
    const attrs = bold ? TextAttributes.BOLD : undefined
    return Array.from(text).map((ch) => {
      if (ch === "_") return <text fg={fg} bg={shadow} attributes={attrs} selectable={false}>{" "}</text>
      if (ch === "^") return <text fg={fg} bg={shadow} attributes={attrs} selectable={false}>▀</text>
      if (ch === "~") return <text fg={shadow} attributes={attrs} selectable={false}>▀</text>
      return <text fg={fg} attributes={attrs} selectable={false}>{ch}</text>
    })
  }
  return (
    <box alignItems="center">
      <For each={LEFT}>
        {(text, i) => (
          <box flexDirection="row" gap={1}>
            <box flexDirection="row">{line(text, theme().primary, false)}</box>
            <box flexDirection="row">{line(RIGHT[i()], theme().text, true)}</box>
          </box>
        )}
      </For>
      <box paddingTop={1}>
        <text fg={theme().textMuted} selectable={false}>
          your local coding council <span style={{ fg: theme().accent }}>·</span> private by design
        </text>
      </box>
    </box>
  )
}

// ------------------------------------------------------------------------------------------ live status
type Model = { state: "ready" | "loading" | "sleeping" | "off" | "offline" | "none"; detail: string; terse?: boolean; terseSupported?: boolean }
// detail: the model name when ready/loading, otherwise a hint

function watchModel(url: string) {
  const [model, setModel] = createSignal<Model>({ state: url ? "offline" : "none", detail: "" })
  if (!url) return model
  const poll = async () => {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(1500) })
      const s = (await res.json()) as Record<string, any>
      const name = String(s.model || "model")
      const status = String(s.status ?? "").toUpperCase()
      const terse = typeof s.terse === "boolean" ? s.terse : undefined
      // only some models (Tiel-Coder) have the terse prompt; an older gateway does not say, so assume yes there
      const terseSupported = typeof s.terse_supported === "boolean" ? s.terse_supported : true
      if (s.override === "OFF") setModel({ state: "off", detail: "disabled (shura on)", terse, terseSupported })
      else if (status === "READY") setModel({ state: "ready", detail: name, terse, terseSupported })
      else if (status === "LOADING" || status === "STARTING") setModel({ state: "loading", detail: name, terse, terseSupported })
      else setModel({ state: "sleeping", detail: "loads on first message", terse, terseSupported })
    } catch {
      setModel({ state: "offline", detail: "gateway not running" })
    }
  }
  poll()
  setInterval(poll, 4000)
  return model
}

function watchMemory(dir: string) {
  const count = () => {
    try {
      return readdirSync(dir).filter((f) => f.endsWith(".md") && f !== "MEMORY.md").length
    } catch {
      return 0
    }
  }
  const [memories, setMemories] = createSignal(count())
  setInterval(() => setMemories(count()), 10000)
  return memories
}

function ModelBadge(props: { api: TuiPluginApi; model: () => Model; compact?: boolean }) {
  const theme = () => props.api.theme.current
  const look = createMemo(() => {
    const t = theme()
    switch (props.model().state) {
      case "ready": return { dot: "●", fg: t.success, label: `${props.model().detail} ready${props.model().terse && props.model().terseSupported !== false ? " · terse" : ""}` }
      case "loading": return { dot: "◐", fg: t.warning, label: `${props.model().detail} loading` }
      case "sleeping": return { dot: "○", fg: t.textMuted, label: "model asleep" }
      case "off": return { dot: "○", fg: t.warning, label: "model off" }
      case "offline": return { dot: "●", fg: t.error, label: "gateway offline" }
      default: return undefined
    }
  })
  return (
    <Show when={look()}>
      {(l) => (
        <text fg={theme().textMuted}>
          <span style={{ fg: l().fg }}>{l().dot}</span> {l().label}
          <Show when={!props.compact && !["ready", "loading"].includes(props.model().state) && props.model().detail}>
            <span> · {props.model().detail}</span>
          </Show>
        </text>
      )}
    </Show>
  )
}

function shortPath(dir: string) {
  const home = homedir()
  return dir === home ? "~" : dir.startsWith(home + "/") ? "~" + dir.slice(home.length) : dir
}

// ------------------------------------------------------------------------------------------------- tips
const TIPS = [
  ["/remember", "saves a fact that every future session will know"],
  ["Tab", "switches Build and Plan; Plan only reads and proposes"],
  ["/test", "runs the project's tests and fixes what fails"],
  ["/commit", "writes a commit in your repository's style, never pushes"],
  ["/memory", "shows what ShuraCode remembers about you and your projects"],
  ["/review", "reviews your uncommitted changes"],
  ["shura unload", "frees RAM and VRAM right away (in any terminal)"],
  ["@file", "adds a file to your message"],
]

// ------------------------------------------------------------------------------------------------- plugin
const tui: TuiPlugin = async (api, options) => {
  const opts = (options ?? {}) as Options
  const gateway = opts.gateway ?? "http://127.0.0.1:8080/guardian/status"
  const memoryDir = opts.memory_dir ?? join(homedir(), ".local/share/shura/memory")
  const model = watchModel(gateway)
  const memories = watchMemory(memoryDir)
  const tip = TIPS[Math.floor(Math.random() * TIPS.length)]
  const theme = () => api.theme.current
  const engine = () => api.app.version

  // The engine looks for themes only in its own folders, so install ours and select it once. A theme picked
  // later with /theme is kept.
  const themeFile = new URL("../themes/shura.json", import.meta.url).pathname
  api.theme
    .install(themeFile)
    .then(() => {
      if (!api.kv.get("shuracode.theme_selected", false) && api.theme.has("shura")) {
        api.theme.set("shura")
        api.kv.set("shuracode.theme_selected", true)
      }
    })
    .catch(() => {})

  // Terminal title (the launcher sets OPENCODE_DISABLE_TERMINAL_TITLE so the engine leaves it alone).
  createRoot(() => {
    createEffect(() => {
      const route = api.route.current
      let title = "ShuraCode"
      if (route.name === "session") {
        const s = api.state.session.get((route as { params: { sessionID: string } }).params.sessionID)
        if (s?.title && !/^New session - /.test(s.title)) title = `ShuraCode · ${s.title.slice(0, 40)}`
      }
      api.renderer.setTerminalTitle(title)
    })
  })

  // /terse: the model's built-in "be concise" system prompt, on or off. It sits at the very start of the prompt, so the
  // next reply reads the whole context again (a few minutes at 187k, unnoticeable in a short chat).
  const guardianBase = (() => {
    try {
      return new URL(gateway).origin + "/guardian/"
    } catch {
      return ""
    }
  })()
  const setTerse = async (on: boolean) => {
    if (model().terseSupported === false) {
      api.ui.toast({ variant: "warning", message: "Terse mode exists only for Tiel-Coder; the model in use does not have it." })
      return
    }
    try {
      const res = await fetch(guardianBase + (on ? "terse-on" : "terse-off"), { method: "POST", signal: AbortSignal.timeout(3000) })
      if (!res.ok) throw new Error(String(res.status))
      api.ui.toast({
        variant: "info",
        title: on ? "Terse mode on" : "Terse mode off",
        message: "The next reply reads the whole context again (slow once in a long session).",
      })
    } catch {
      api.ui.toast({ variant: "error", message: "Could not reach the gateway; terse mode unchanged." })
    }
  }
  api.command?.register(() => [
    {
      title: "Terse mode: on",
      value: "shuracode.terse.on",
      description: "short answers (the model's built-in concise prompt)",
      category: "ShuraCode",
      enabled: model().terseSupported !== false,
      hidden: model().terseSupported === false,
      slash: { name: "terse-on" },
      onSelect: () => void setTerse(true),
    },
    {
      title: "Terse mode: off",
      value: "shuracode.terse.off",
      description: "full-length answers",
      category: "ShuraCode",
      enabled: model().terseSupported !== false,
      hidden: model().terseSupported === false,
      slash: { name: "terse-off" },
      onSelect: () => void setTerse(false),
    },
  ])

  api.slots.register({
    order: 50,
    slots: {
      home_logo() {
        return <Logo api={api} />
      },
      home_prompt(_ctx, props) {
        return (
          <api.ui.Prompt
            ref={props.ref}
            right={<api.ui.Slot name="home_prompt_right" />}
            placeholders={{
              normal: [
                "Fix the failing test in this project",
                "Explain how this codebase is structured",
                "Remember that I prefer small, focused commits",
                "Find and fix the TODOs in src/",
              ],
              shell: ["git status", "ls -la", "shura status"],
            }}
          />
        )
      },
      home_bottom() {
        return (
          <box width="100%" maxWidth={75} alignItems="center" paddingTop={3} flexShrink={1}>
            <text fg={theme().textMuted}>
              <span style={{ fg: theme().accent }}>◆ </span>
              <span style={{ fg: theme().text }}>{tip[0]}</span> {tip[1]}
            </text>
          </box>
        )
      },
      home_footer() {
        const dir = () => {
          const d = shortPath(api.state.path.directory || process.cwd())
          const branch = api.state.vcs?.branch
          return branch ? `${d}:${branch}` : d
        }
        return (
          <box width="100%" paddingTop={1} paddingBottom={1} paddingLeft={2} paddingRight={2} flexDirection="row" gap={2} flexShrink={0}>
            <text fg={theme().textMuted}>{dir()}</text>
            <box flexShrink={0}><ModelBadge api={api} model={model} /></box>
            <box flexGrow={1} />
            <text fg={theme().textMuted} flexShrink={0}>
              <span style={{ fg: theme().primary }}>Shura</span>
              <span style={{ fg: theme().text }}><b>Code</b></span> {VERSION}
            </text>
          </box>
        )
      },
      sidebar_footer(_ctx, props) {
        const path = () => {
          const s = api.state.session.get(props.session_id)
          const parts = shortPath(s?.directory || api.state.path.directory || process.cwd()).split("/")
          return { parent: parts.slice(0, -1).join("/"), name: parts.at(-1) ?? "" }
        }
        return (
          <box gap={1}>
            <text>
              <span style={{ fg: theme().textMuted }}>{path().parent}/</span>
              <span style={{ fg: theme().text }}>{path().name}</span>
            </text>
            <box>
              <ModelBadge api={api} model={model} compact />
              <text fg={theme().textMuted}>
                <span style={{ fg: theme().accent }}>◆</span> {memories()} {memories() === 1 ? "memory" : "memories"}
              </text>
              <text fg={theme().textMuted}>
                <span style={{ fg: theme().primary }}>Shura</span>
                <span style={{ fg: theme().text }}><b>Code</b></span> {VERSION}
                <span> · engine {engine()}</span>
              </text>
            </box>
          </box>
        )
      },
    },
  })
}

const plugin: TuiPluginModule & { id: string } = { id: "shuracode", tui }
export default plugin
