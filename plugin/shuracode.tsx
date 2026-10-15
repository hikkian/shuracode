/** @jsxImportSource @opentui/solid */
// ShuraCode TUI plugin: branding (logo, footer, sidebar, tips, terminal title) and a live status line for
// the local model served by the Shura gateway. It uses only the engine's public TUI plugin API (slots),
// so engine updates do not overwrite it.
import type { TuiPlugin, TuiPluginApi, TuiPluginModule } from "@opencode-ai/plugin/tui"
import { RGBA, TextAttributes } from "@opentui/core"
import { createMemo, createRoot, createSignal, createEffect, For, Index, onCleanup, onMount, Show } from "solid-js"
import { spawn } from "node:child_process"
import { readdirSync, readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { createPoller, monitorUrl, viewOf, type Poller, type Reading, type Tone, type View } from "./stats"

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

// ------------------------------------------------------------------------------------------------ stats
// The numbers come from stats.tsx through one shared poller. A component asks for them only while it is mounted,
// so nothing is requested while no stats are on screen.
function toneFg(api: TuiPluginApi, tone: Tone) {
  const t = api.theme.current
  return tone === "green" ? t.success : tone === "amber" ? t.warning : tone === "red" ? t.error : t.textMuted
}

function StatsRows(props: { api: TuiPluginApi; view: () => View }) {
  const theme = () => props.api.theme.current
  return (
    <Show when={props.view().rows.length > 0} fallback={<text fg={theme().textMuted}>{props.view().line}</text>}>
      <Index each={props.view().rows}>
        {(row) => (
          <box>
            <text fg={theme().textMuted}>
              {row().label} <span style={{ fg: theme().text }}>{row().text}</span>
            </text>
            <Show when={row().bar}>{(b) => <text fg={theme().accent}>{b()}</text>}</Show>
          </box>
        )}
      </Index>
    </Show>
  )
}

function StatsLine(props: { api: TuiPluginApi; view: () => View; poller: Poller }) {
  onMount(() => props.poller.retain())
  onCleanup(() => props.poller.release())
  const theme = () => props.api.theme.current
  return (
    <box flexDirection="column" flexShrink={0}>
      <Show when={props.view().banner}>{(text) => <text fg={theme().error}>⚠ {text()}</text>}</Show>
      <text fg={theme().textMuted}>
        <span style={{ fg: toneFg(props.api, props.view().tone) }}>●</span> {props.view().line}
      </text>
    </box>
  )
}

function StatsPanel(props: { api: TuiPluginApi; view: () => View; poller: Poller }) {
  onMount(() => props.poller.retain())
  onCleanup(() => props.poller.release())
  const theme = () => props.api.theme.current
  return (
    <box gap={0}>
      <text fg={theme().textMuted}>
        <span style={{ fg: theme().accent }}>◆</span> Stats
      </text>
      <StatsRows api={props.api} view={props.view} />
    </box>
  )
}

function StatsDialog(props: { api: TuiPluginApi; view: () => View; poller: Poller; onClose: () => void }) {
  onMount(() => props.poller.retain())
  onCleanup(() => props.poller.release())
  const theme = () => props.api.theme.current
  const Dialog = props.api.ui.Dialog
  return (
    <Dialog size="medium" onClose={props.onClose}>
      <box flexDirection="column" paddingLeft={2} paddingRight={2} paddingBottom={1}>
        <text fg={theme().text}>
          <b>Shura stats</b>
        </text>
        <Show when={props.view().banner}>{(text) => <text fg={theme().error}>⚠ {text()}</text>}</Show>
        <StatsRows api={props.api} view={props.view} />
      </box>
    </Dialog>
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
  ["/guide", "lists every command and key, in English, Russian or Kazakh"],
  ["/test", "runs the project's tests and fixes what fails"],
  ["/commit", "writes a commit in your repository's style, never pushes"],
  ["/memory", "shows what ShuraCode remembers about you and your projects"],
  ["/review", "reviews your uncommitted changes"],
  ["shura unload", "frees RAM and VRAM right away (in any terminal)"],
  ["@file", "adds a file to your message"],
]

// ------------------------------------------------------------------------------------------ /guide: the command reference
// docs/commands.json is generated by scripts/build_commands.py (and checked by the tests), so this list cannot drift from the code.
type GuideItem = {
  id: string; name: string; category: string; en: string; ru: string; kk: string
  key?: string; example?: string; models?: string[]; kind?: string; source: string
}
type Lang = "en" | "ru" | "kk"
const CATEGORY_RU: Record<string, string> = {
  Help: "Справка", Model: "Модель", Memory: "Память", Work: "Работа", Session: "Сессии", View: "Вид", Input: "Ввод",
  "Shura (terminal)": "Shura (в терминале)",
}
const CATEGORY_KK: Record<string, string> = {
  Help: "Анықтама", Model: "Модель", Memory: "Жад", Work: "Жұмыс", Session: "Сессиялар", View: "Көрініс", Input: "Енгізу",
  "Shura (terminal)": "Shura (терминалда)",
}
// UI strings per language; English is the fallback.
const UI: Record<Lang, Record<string, string>> = {
  en: {
    title: "ShuraCode commands (Esc to close)", placeholder: "type to filter", tiel: " [Tiel-Coder only]",
    keys: "Keys: ", example: "Example: ", from: "From: ", cli: "the `shura` command in any terminal",
  },
  ru: {
    title: "Команды ShuraCode (Esc: закрыть)", placeholder: "начни печатать, чтобы найти", tiel: " [только Tiel-Coder]",
    keys: "Клавиши: ", example: "Пример: ", from: "Откуда: ", cli: "команда shura в терминале",
  },
  kk: {
    title: "ShuraCode командалары (Esc: жабу)", placeholder: "іздеу үшін теруді баста", tiel: " [тек Tiel-Coder]",
    keys: "Пернелер: ", example: "Мысал: ", from: "Қайдан: ", cli: "терминалдағы shura командасы",
  },
}
const categoryName = (l: Lang, c: string) => (l === "ru" ? CATEGORY_RU[c] : l === "kk" ? CATEGORY_KK[c] : c) ?? c
const loadGuide = (): GuideItem[] => {
  try {
    return JSON.parse(readFileSync(new URL("../docs/commands.json", import.meta.url).pathname, "utf8")).items as GuideItem[]
  } catch {
    return []
  }
}
// The UI language comes from the first of LC_ALL / LC_MESSAGES / LANG that is set (the usual locale precedence).
const lang = (): Lang => {
  const loc = (process.env.LC_ALL || process.env.LC_MESSAGES || process.env.LANG || "").toLowerCase()
  return loc.startsWith("ru") ? "ru" : (loc.startsWith("kk") || loc.startsWith("kz")) ? "kk" : "en"
}

// ------------------------------------------------------------------------------------------------- plugin
const tui: TuiPlugin = async (api, options) => {
  const opts = (options ?? {}) as Options
  const gateway = opts.gateway ?? "http://127.0.0.1:8080/guardian/status"
  const memoryDir = opts.memory_dir ?? join(homedir(), ".local/share/shura/memory")
  const model = watchModel(gateway)
  // Stats from the gateway's monitor: one shared poller, retained only while a status line, panel or dialog shows them.
  const [reading, setReading] = createSignal<Reading | null>(null)
  const stats = createPoller({ url: monitorUrl(gateway), onChange: setReading })
  const view = createMemo(() => viewOf(reading()))
  api.lifecycle?.onDispose(() => stats.stop())
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
  // /guide: every command, what it does, where it works; pick one for the details.
  const openGuide = () => {
    const l = lang()
    const ui = UI[l]
    const items = loadGuide()
    if (!items.length) {
      api.ui.toast({ variant: "error", message: "The command reference file is missing (docs/commands.json)." })
      return
    }
    const modelOnly = (i: GuideItem) => !!i.models && model().terseSupported === false
    api.ui.dialog.replace(() => (
      <api.ui.DialogSelect
        title={ui.title}
        placeholder={ui.placeholder}
        options={items.map((i) => ({
          title: i.name,
          value: i.id,
          description: (i[l] || i.en) + (i.models ? ui.tiel : ""),
          category: categoryName(l, i.category),
          footer: i.key ?? "",
          disabled: modelOnly(i),
        }))}
        onSelect={(o) => {
          const i = items.find((x) => x.id === o.value)
          if (!i) return
          const lines = [i[l] || i.en]
          if (i.key) lines.push(ui.keys + i.key)
          if (i.example) lines.push(ui.example + i.example)
          lines.push(ui.from + (i.kind === "cli" ? ui.cli : i.source))
          api.ui.dialog.replace(() => <api.ui.DialogAlert title={i.name} message={lines.join("\n\n")} onConfirm={openGuide} />)
        }}
      />
    ))
  }
  // /stats: the live numbers in a dialog. /stats-window and /stats-full run the Shura CLI's own monitor.
  const openStats = () => {
    api.ui.dialog.replace(() => <StatsDialog api={api} view={view} poller={stats} onClose={() => api.ui.dialog.clear()} />)
  }
  const shuraMissing = () => {
    api.ui.dialog.replace(() => (
      <api.ui.DialogAlert
        title="Shura stats"
        message="The `shura` command was not found on PATH, so the monitor did not open. Install Shura's CLI or run it from a terminal."
        onConfirm={() => api.ui.dialog.clear()}
      />
    ))
  }
  const runShura = (args: string[]) => {
    try {
      const child = spawn("shura", args, { detached: true, stdio: "ignore" })
      child.on("error", shuraMissing)
      child.unref()
    } catch {
      shuraMissing()
    }
  }
  api.command?.register(() => [
    {
      title: "Command reference",
      value: "shuracode.guide",
      description: "every command and key, what it does",
      category: "ShuraCode",
      slash: { name: "guide", aliases: ["commands"] },
      onSelect: () => openGuide(),
    },
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
    {
      title: "Stats",
      value: "shuracode.stats",
      description: "live model numbers: speed, context, VRAM, RAM, zram, temperatures",
      category: "ShuraCode",
      slash: { name: "stats" },
      onSelect: () => openStats(),
    },
    {
      title: "Stats window",
      value: "shuracode.stats.window",
      description: "open the compact monitor window (shura monitor)",
      category: "ShuraCode",
      slash: { name: "stats-window" },
      onSelect: () => runShura(["monitor"]),
    },
    {
      title: "Stats page",
      value: "shuracode.stats.full",
      description: "open the full monitor page in the browser (shura monitor --full)",
      category: "ShuraCode",
      slash: { name: "stats-full" },
      onSelect: () => runShura(["monitor", "--full"]),
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
      app_bottom() {
        return <StatsLine api={api} view={view} poller={stats} />
      },
      sidebar_content() {
        return <StatsPanel api={api} view={view} poller={stats} />
      },
    },
  })
}

const plugin: TuiPluginModule & { id: string } = { id: "shuracode", tui }
export default plugin
