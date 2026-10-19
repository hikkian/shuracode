/** @jsxImportSource @opentui/solid */
// ShuraCode TUI plugin: branding (logo, footer, sidebar, tips, terminal title) and a live status line for
// the local model served by the Shura gateway. It uses only the engine's public TUI plugin API (slots),
// so engine updates do not overwrite it.
import type { TuiPlugin, TuiPluginApi, TuiPluginModule } from "@opencode-ai/plugin/tui"
import { RGBA, TextAttributes } from "@opentui/core"
import { createMemo, createRoot, createSignal, createEffect, For, Show } from "solid-js"
import { readdirSync, readFileSync } from "node:fs"
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
type Context = { mode: "auto" | "extended"; window?: number; short?: number; long?: number; available: boolean }
type Switch = { to: "long" | "short"; eta: number; startedAt: number }
type Think = { level: string; effective: string | null; available: string[]; isDefault: boolean }
type Model = {
  state: "ready" | "loading" | "sleeping" | "off" | "offline" | "none"; detail: string; terse?: boolean; terseSupported?: boolean
  context?: Context; switching?: Switch; think?: Think
}
// detail: the model name when ready/loading, otherwise a hint

// SWITCHUI1 / THINK2: the context mode, the layout switch in progress and the thinking level, from GET /guardian/status.
function readExtras(s: Record<string, any>): Pick<Model, "context" | "switching" | "think"> {
  const out: Pick<Model, "context" | "switching" | "think"> = {}
  const c = s.context_mode
  if (c && typeof c === "object") {
    out.context = { mode: c.mode === "extended" ? "extended" : "auto", window: c.window ?? undefined, short: c.short_ctx ?? undefined,
      long: c.long_ctx ?? undefined, available: !!c.available }
  }
  const sw = s.layout_switch
  if (sw && sw.state === "switching") {
    out.switching = { to: sw.to === "long" ? "long" : "short", eta: Number(sw.eta_s) || 5, startedAt: Number(sw.started_at) || Date.now() / 1000 }
  }
  const t = s.think
  if (t && typeof t === "object") {
    out.think = { level: String(t.level || "medium"), effective: t.effective ?? null, available: Array.isArray(t.available) ? t.available : [],
      isDefault: !!t.default }
  }
  return out
}

// 49152 -> 48K, 200000 -> 200K
export function contextSize(n?: number): string {
  if (!n) return ""
  return n % 1024 === 0 ? `${n / 1024}K` : `${Math.round(n / 1000)}K`
}

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
      const extras = readExtras(s)
      if (s.override === "OFF") setModel({ state: "off", detail: "disabled (shura on)", terse, terseSupported, ...extras })
      else if (status === "READY") setModel({ state: "ready", detail: name, terse, terseSupported, ...extras })
      else if (status === "LOADING" || status === "STARTING") setModel({ state: "loading", detail: name, terse, terseSupported, ...extras })
      else setModel({ state: "sleeping", detail: "loads on first message", terse, terseSupported, ...extras })
    } catch {
      setModel({ state: "offline", detail: "gateway not running" })
    }
  }
  // Faster while a model loads or the layout switches, so the countdown in the chat stays live; a local GET either way.
  const loop = async () => {
    await poll()
    const m = model()
    setTimeout(loop, m.switching || m.state === "loading" ? 1000 : 2500)
  }
  loop()
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

const CHIP: Record<"en" | "ru", Record<string, string>> = {
  en: { auto: "auto", extended: "extended", toLong: "Expanding context to", toShort: "Back to the fast mode", think: "thinking",
    off: "off", low: "brief", medium: "normal", high: "deep", s: "s" },
  ru: { auto: "авто", extended: "расширенный", toLong: "Расширяю контекст до", toShort: "Возвращаюсь в быстрый режим", think: "мышление",
    off: "выкл", low: "кратко", medium: "обычно", high: "глубоко", s: "с" },
}
const chipLang = (): "en" | "ru" => (lang() === "ru" ? "ru" : "en")

// Next to the prompt in the chat: the context window and the thinking level; while the gateway switches the layout,
// a short countdown instead of silence.
function ContextChip(props: { api: TuiPluginApi; model: () => Model }) {
  const theme = () => props.api.theme.current
  const [now, setNow] = createSignal(Date.now() / 1000)
  setInterval(() => setNow(Date.now() / 1000), 1000)
  const text = createMemo(() => {
    const m = props.model()
    const t = CHIP[chipLang()]
    if (m.switching) {
      const left = Math.max(1, Math.round(m.switching.eta - (now() - m.switching.startedAt)))
      const head = m.switching.to === "long" ? `${t.toLong} ${contextSize(m.context?.long)}` : t.toShort
      return { busy: true, label: `${head}… ~${left} ${t.s}` }
    }
    if (!m.context?.available) return undefined
    const mode = m.context.mode === "extended" ? t.extended : t.auto
    const thinking = m.think && m.think.effective && m.think.effective !== "medium" ? ` · ${t.think}: ${t[m.think.effective] ?? m.think.effective}` : ""
    return { busy: false, label: `${mode} · ${contextSize(m.context.window)}${thinking}` }
  })
  return (
    <Show when={text()}>
      {(c) => (
        <text fg={theme().textMuted}>
          <Show when={c().busy}><span style={{ fg: theme().warning }}>◐ </span></Show>
          {c().label}
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
  // /auto, /extended: the context mode (SWITCHUI1). The logic is in the gateway; this only switches it.
  const MODE_TEXT = {
    en: {
      auto: (s: string, l: string) => `Auto (up to ${l}): the fast mode; when a conversation outgrows ${s}, Shura expands the context to ${l} by itself (a few seconds).`,
      extended: (l: string) => `Extended context (${l}): the large window from the start, no switches; generation is slower (no MTP).`,
      failed: "Could not reach the gateway; the context mode is unchanged.",
      single: (s: string) => `This model has one context window (${s}); there is nothing to switch.`,
    },
    ru: {
      auto: (s: string, l: string) => `Авто (до ${l}): быстрый режим; когда разговор перерастает ${s}, Шура сама расширяет контекст до ${l} (несколько секунд).`,
      extended: (l: string) => `Расширенный контекст (${l}): сразу большое окно, без переключений; генерация медленнее (без MTP).`,
      failed: "Не удалось связаться со шлюзом; режим контекста не изменён.",
      single: (s: string) => `У этой модели одно окно контекста (${s}); переключать нечего.`,
    },
  }
  const setContextMode = async (mode: "auto" | "extended") => {
    const t = MODE_TEXT[chipLang()]
    try {
      const res = await fetch(guardianBase + "context-mode-" + mode, { method: "POST", signal: AbortSignal.timeout(3000) })
      if (!res.ok) throw new Error(String(res.status))
      const c = (await res.json()) as Record<string, any>
      const s = contextSize(c.short_ctx), l = contextSize(c.long_ctx)
      if (!c.available) {
        api.ui.toast({ variant: "warning", message: t.single(s) })
        return
      }
      api.ui.toast({ variant: "info", message: mode === "auto" ? t.auto(s, l) : t.extended(l) })
    } catch {
      api.ui.toast({ variant: "error", message: t.failed })
    }
  }
  // /think: the thinking level (THINK2). Brief and deep put a line at the start of the prompt, so changing to or from them
  // makes the next reply read the conversation again once; off and normal do not.
  const THINK_TEXT = {
    en: {
      title: "Thinking (Esc to close)", off: "Off", low: "Brief", medium: "Normal", high: "Deep",
      offD: "answers right away; for simple questions", lowD: "a short think", mediumD: "the default", highD: "thinks longer; for hard tasks",
      reread: "The next reply reads the conversation again once.", none: "This model has no thinking levels.",
      asLow: "this model cannot switch thinking off; it thinks briefly", failed: "Could not reach the gateway; the thinking level is unchanged.",
      set: "Thinking", current: " (current)",
    },
    ru: {
      title: "Мышление (Esc: закрыть)", off: "Выкл", low: "Кратко", medium: "Обычно", high: "Глубоко",
      offD: "ответ сразу; для простых вопросов", lowD: "немного подумать", mediumD: "по умолчанию", highD: "дольше; для сложных задач",
      reread: "Следующий ответ один раз заново прочитает разговор.", none: "У этой модели нет уровней мышления.",
      asLow: "эта модель не умеет выключать рассуждение; будет рассуждать кратко", failed: "Не удалось связаться со шлюзом; уровень мышления не изменён.",
      set: "Мышление", current: " (сейчас)",
    },
  }
  const setThink = async (level: string) => {
    const t = THINK_TEXT[chipLang()]
    const before = model().think?.effective ?? "medium"
    try {
      const res = await fetch(guardianBase + "think-" + level, { method: "POST", signal: AbortSignal.timeout(3000) })
      if (!res.ok) throw new Error(String(res.status))
      const th = (await res.json()) as Record<string, any>
      const after = String(th.effective ?? "medium")
      const prefixChanged = (before === "low" || before === "high" || after === "low" || after === "high") && before !== after
      const name = (t as Record<string, string>)[after] ?? after
      api.ui.toast({ variant: "info", title: `${t.set}: ${name}`, message: [level !== after ? t.asLow : "", prefixChanged ? t.reread : ""].filter(Boolean).join(" ") || " " })
    } catch {
      api.ui.toast({ variant: "error", message: t.failed })
    }
  }
  const openThink = () => {
    const t = THINK_TEXT[chipLang()] as Record<string, string>
    const th = model().think
    if (!th || !th.effective) {
      api.ui.toast({ variant: "warning", message: t.none })
      return
    }
    api.ui.dialog.replace(() => (
      <api.ui.DialogSelect
        title={t.title}
        options={["off", "low", "medium", "high"].map((level) => ({
          title: t[level] + (th.effective === level ? t.current : ""),
          value: level,
          description: t[level + "D"] + (!th.available.includes(level) ? ` (${t.asLow})` : ""),
          category: t.set,
        }))}
        onSelect={(o) => {
          api.ui.dialog.clear()
          void setThink(String(o.value))
        }}
      />
    ))
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
  api.command?.register(() => [
    {
      title: chipLang() === "ru" ? "Контекст: Авто" : "Context: Auto",
      value: "shuracode.context.auto",
      description: chipLang() === "ru" ? "быстрый режим; контекст расширяется сам, когда разговор растёт" : "the fast mode; the context grows by itself when the conversation does",
      category: "ShuraCode",
      slash: { name: "auto" },
      onSelect: () => void setContextMode("auto"),
    },
    {
      title: chipLang() === "ru" ? `Контекст: Расширенный (${contextSize(model().context?.long) || "200K"})` : `Context: Extended (${contextSize(model().context?.long) || "200K"})`,
      value: "shuracode.context.extended",
      description: chipLang() === "ru" ? "сразу большое окно, без переключений; генерация медленнее" : "the large window from the start, no switches; slower generation",
      category: "ShuraCode",
      slash: { name: "extended" },
      onSelect: () => void setContextMode("extended"),
    },
    {
      title: chipLang() === "ru" ? "Мышление: выкл · кратко · обычно · глубоко" : "Thinking: off · brief · normal · deep",
      value: "shuracode.think",
      description: chipLang() === "ru" ? "сколько модель рассуждает перед ответом" : "how much the model thinks before answering",
      category: "ShuraCode",
      slash: { name: "think" },
      onSelect: () => openThink(),
    },
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
  ])

  api.slots.register({
    order: 50,
    slots: {
      home_logo() {
        return <Logo api={api} />
      },
      app_bottom() {
        // its own line under the prompt, in the chat and on the home screen: the prompt's right corner is too narrow
        return (
          <box width="100%" paddingLeft={2} paddingRight={2} flexDirection="row" flexShrink={0}>
            <box flexGrow={1} />
            <ContextChip api={api} model={model} />
          </box>
        )
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
