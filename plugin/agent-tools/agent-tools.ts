// ShuraCode agent tools (AGTOOLS1): eyes for an agent that has no browser and no video player.
//   render — an HTML file or a URL becomes a screenshot at a chosen width plus a list of layout problems (horizontal overflow,
//            elements outside the viewport, the smallest text, the lowest contrast, tap targets under 44 px, heading and alt
//            problems, console errors, the A4 page count on request), measured in headless Chromium through the Playwright that
//            shura-qa already installed (offline, nothing is downloaded).
//   frames — a video becomes an ffprobe summary and 3–6 PNG frames at chosen times.
// The images return as tool attachments. The engine hands image attachments to the model as a follow-up user message with image
// parts ("Attached media from tool result:"), which the OpenAI-compatible provider sends as image_url — but only a model with
// vision can take them, so the plugin attaches images only when the session's model declares `modalities.input` with "image"
// in the config (option `vision`: "auto" (default) | true | false). The text summary carries the findings in every case.
// Off by default: enable with the plugin option { "agentTools": true } (or { "render": true } / { "frames": true } separately).
import type { PluginModule, ToolResult } from "@opencode-ai/plugin"
import { execFile } from "node:child_process"
import { existsSync, mkdtempSync, readFileSync, statSync } from "node:fs"
import os from "node:os"
import path from "node:path"

export type AgentToolsOptions = {
  agentTools?: boolean
  render?: boolean
  frames?: boolean
  vision?: "auto" | boolean
  python?: string          // the Python that has Playwright (default: the shura-qa venv)
  browsersPath?: string    // PLAYWRIGHT_BROWSERS_PATH (default: the shura-qa browsers)
  systemPython?: string    // the Python for frames.py (ffmpeg + optional Pillow); default python3
  timeoutMs?: number
  saveDir?: string         // where screenshots and frames are written (default: a temp folder per session)
}

const HERE = path.dirname(new URL(import.meta.url).pathname)
const QA = path.join(os.homedir(), ".local", "share", "shura-qa")

export function resolveOptions(options: unknown): Required<Omit<AgentToolsOptions, "saveDir">> & { saveDir?: string } {
  const o = (options ?? {}) as AgentToolsOptions
  const all = o.agentTools === true
  return {
    agentTools: all,
    render: o.render ?? all,
    frames: o.frames ?? all,
    vision: o.vision ?? "auto",
    python: o.python ?? process.env.SHURACODE_RENDER_PYTHON ?? path.join(QA, "venv", "bin", "python"),
    browsersPath: o.browsersPath ?? process.env.PLAYWRIGHT_BROWSERS_PATH ?? path.join(QA, "browsers"),
    systemPython: o.systemPython ?? "python3",
    timeoutMs: o.timeoutMs ?? 90_000,
    saveDir: o.saveDir,
  }
}

type Run = { code: number; out: string; err: string }

function run(cmd: string, args: string[], stdin: string, env: Record<string, string>, timeoutMs: number): Promise<Run> {
  return new Promise((resolve) => {
    const child = execFile(cmd, args, { env: { ...process.env, ...env }, maxBuffer: 64 * 1024 * 1024, timeout: timeoutMs },
      (error, stdout, stderr) => {
        const code = error ? (typeof (error as NodeJS.ErrnoException & { code?: unknown }).code === "number" ? Number((error as { code: number }).code) : 1) : 0
        resolve({ code, out: String(stdout ?? ""), err: String(stderr ?? "") + (error && code === 1 ? `\n${error.message}` : "") })
      })
    child.stdin?.end(stdin)
  })
}

function lastJson(text: string): Record<string, unknown> | null {
  const lines = text.trim().split("\n").filter((l) => l.trim())
  for (let i = lines.length - 1; i >= 0; i--) {
    try { return JSON.parse(lines[i]) } catch { /* not this line */ }
  }
  return null
}

export function resolveTarget(directory: string, file: string): { url?: string; file?: string; error?: string } {
  if (/^https?:\/\//i.test(file)) return { url: file }
  const abs = path.resolve(directory, file)
  if (!existsSync(abs)) return { error: `file not found: ${abs}` }
  if (!statSync(abs).isFile()) return { error: `not a file: ${abs}` }
  return { file: abs }
}

function dataUrl(png: string): string {
  return `data:image/png;base64,${readFileSync(png).toString("base64")}`
}

// Does the session's current model take images? Read from the config (the product declares modalities per model); unknown = no.
export async function modelHasVision(client: any, sessionID: string, cache: Map<string, boolean>): Promise<boolean> {
  const hit = cache.get(sessionID)
  if (hit !== undefined) return hit
  let value = false
  try {
    const msgs = (await client.session.messages({ path: { id: sessionID } }))?.data ?? []
    const last = [...msgs].reverse().find((m: any) => m?.info?.role === "assistant" && m?.info?.modelID)
    const providerID = last?.info?.providerID
    const modelID = last?.info?.modelID
    if (providerID && modelID) {
      const config = (await client.config.get())?.data ?? {}
      const input = config?.provider?.[providerID]?.models?.[modelID]?.modalities?.input
      if (Array.isArray(input)) value = input.includes("image")
      else {
        const providers = (await client.config.providers())?.data?.providers ?? []
        const model = providers.find((p: any) => p?.id === providerID)?.models?.[modelID]
        const modal = model?.modalities?.input
        value = Array.isArray(modal) ? modal.includes("image") : model?.capabilities?.input?.image === true
      }
    }
  } catch {
    value = false
  }
  cache.set(sessionID, value)
  return value
}

export function renderText(file: string, width: number, result: Record<string, any>, saved: string | undefined, attached: boolean): string {
  const problems: string[] = result.problems ?? []
  const m = result.metrics ?? {}
  const lines = [`render: ${file} at ${width}px — ${problems.length === 0 ? "no layout problems found" : `${problems.length} problem(s)`}`]
  for (const p of problems) lines.push(`- ${p}`)
  if (m.scrollHeight !== undefined) {
    lines.push(`Page: ${m.scrollWidth}×${m.scrollHeight}px, ${m.h1} h1, ${m.h2} h2, ${m.buttons} button(s), ${m.links} link(s), ${m.images} image(s)` +
      (m.minFont ? `, smallest text ${Math.round(m.minFont * 10) / 10}px` : "") + (m.minContrast ? `, lowest contrast ${m.minContrast}:1` : "") + ".")
  }
  if (result.pdf_pages !== undefined) lines.push(`A4 with 12 mm margins: ${result.pdf_pages} page(s).`)
  if (saved) lines.push(`Screenshot: ${saved}${result.screenshot_note ? ` (${result.screenshot_note})` : ""}${attached ? " — attached for you to look at" : " — not attached (this model has no image input); read the list above"}`)
  return lines.join("\n")
}

export function framesText(file: string, result: Record<string, any>, attached: boolean): string {
  const p = result.probe ?? {}
  const streams = (p.streams ?? []).map((s: any) => s.type === "video" ? `${s.codec} ${s.width}×${s.height} ${s.fps} fps` : s.type === "audio" ? `${s.codec} ${s.sample_rate} Hz ${s.channels}ch` : s.type).join(", ")
  const lines = [`frames: ${file} — ${p.duration}s, ${streams || "no streams"}, ${Math.round((p.size_bytes ?? 0) / 1024)} KB, container ${p.container}`]
  for (const f of result.frames ?? []) {
    lines.push(`- ${f.time}s: ${f.png}${f.width ? ` (${f.width}×${f.height})` : ""}${f.brightness !== null && f.brightness !== undefined ? `, brightness ${f.brightness}/255` : ""}`)
  }
  for (const x of result.problems ?? []) lines.push(`! ${x}`)
  if ((result.frames ?? []).length) lines.push(attached ? "Frames attached for you to look at." : "Frames saved as PNG (this model has no image input): judge by the probe facts and brightness.")
  return lines.join("\n")
}

const plugin: PluginModule & { id: string } = {
  id: "shuracode-agent-tools",
  server: async (input, options) => {
    const opt = resolveOptions(options)
    if (!opt.render && !opt.frames) return {}
    const visionCache = new Map<string, boolean>()
    const dirs = new Map<string, string>()
    const outDir = (sessionID: string) => {
      let d = opt.saveDir ?? dirs.get(sessionID)
      if (!d) {
        d = mkdtempSync(path.join(os.tmpdir(), "shura-eyes-"))
        dirs.set(sessionID, d)
      }
      return d
    }
    const attachImages = async (sessionID: string) =>
      opt.vision === true ? true : opt.vision === false ? false : modelHasVision(input.client, sessionID, visionCache)

    // Package-independent JSON Schema args, as the reliability plugins do: isolated configs may lack the plugin package's zod.
    const tools: Record<string, { description: string; args: Record<string, unknown>; execute: (args: any, context: any) => Promise<ToolResult> }> = {}
    if (opt.render) {
      tools.render = {
        description: "Render an HTML file (path in the project) or a URL in headless Chromium at a given viewport width: returns a screenshot " +
          "(attached when the model can see images) and a list of layout problems — horizontal overflow, elements outside the viewport, text smaller " +
          "than 14px, contrast below 4.5:1, tap targets under 44px, h1 count, images without alt, console errors; with pdf=true also the number of A4 pages. " +
          "Use it after writing or changing a page, at 390 (phone) and 1280 (desktop).",
        args: {
          file: { type: "string", description: "HTML file path relative to the project, or an http(s) URL" },
          width: { anyOf: [{ type: "integer", minimum: 320, maximum: 1920 }, { type: "null" }], description: "viewport width in px (default 1280); null = default" },
          full_page: { anyOf: [{ type: "boolean" }, { type: "null" }], description: "screenshot the whole page (default true, capped at 2400px tall)" },
          pdf: { anyOf: [{ type: "boolean" }, { type: "null" }], description: "also print to A4 (12 mm margins) and report the page count" },
        },
        async execute(args: any, context: any): Promise<ToolResult> {
          if (typeof args?.file !== "string" || !args.file) return { title: "render failed", output: "render: `file` (a path or URL) is required", metadata: { error: "no file" } }
          const target = resolveTarget(context.directory, args.file)
          if (target.error) return { title: "render failed", output: target.error, metadata: { error: target.error } }
          const width = Number.isFinite(Number(args.width)) && args.width !== null ? Math.max(320, Math.min(1920, Math.round(Number(args.width)))) : 1280
          const stem = (target.file ? path.basename(target.file).replace(/\.[^.]+$/, "") : "page").replace(/[^\w.-]+/g, "_")
          const png = path.join(outDir(context.sessionID), `${stem}-${width}.png`)
          const spec = { ...target, width, full_page: args.full_page ?? true, pdf: args.pdf === true, png }
          const r = await run(opt.python, ["-I", path.join(HERE, "render.py")], JSON.stringify(spec), { PLAYWRIGHT_BROWSERS_PATH: opt.browsersPath }, opt.timeoutMs)
          const result = lastJson(r.out)
          if (!result || !result.ok) {
            const why = (result?.error as string) ?? r.err.trim().slice(-400) ?? "renderer failed"
            return { title: "render failed", output: `render: could not render ${args.file}: ${why}`, metadata: { error: why } }
          }
          const vision = await attachImages(context.sessionID)
          const saved = result.png as string | undefined
          const output = renderText(args.file, width, result, saved, Boolean(saved) && vision)
          return {
            title: `render ${args.file} @${width}`,
            output,
            metadata: { problems: result.problems, metrics: result.metrics, pdf_pages: result.pdf_pages, png: saved, attached: Boolean(saved) && vision },
            attachments: saved && vision ? [{ type: "file", mime: "image/png", url: dataUrl(saved), filename: path.basename(saved) }] : undefined,
          }
        },
      }
    }
    if (opt.frames) {
      tools.frames = {
        description: "Inspect a video file: ffprobe summary (duration, streams, codecs, size) and 3–6 PNG frames at chosen times, scaled to a given width " +
          "(attached when the model can see images). Use it after cutting, scaling or converting a video to check the result.",
        args: {
          file: { type: "string", description: "video file path relative to the project" },
          times: { anyOf: [{ type: "array", items: { type: "number", minimum: 0 }, maxItems: 6 }, { type: "null" }], description: "seconds to sample; null = evenly spaced" },
          count: { anyOf: [{ type: "integer", minimum: 1, maximum: 6 }, { type: "null" }], description: "how many evenly spaced frames when times is null (default 4)" },
          width: { anyOf: [{ type: "integer", minimum: 160, maximum: 960 }, { type: "null" }], description: "frame width in px (default 480)" },
        },
        async execute(args: any, context: any): Promise<ToolResult> {
          if (typeof args?.file !== "string" || !args.file) return { title: "frames failed", output: "frames: `file` (a video path) is required", metadata: { error: "no file" } }
          const target = resolveTarget(context.directory, args.file)
          if (target.error || !target.file) return { title: "frames failed", output: target.error ?? "a local file is required", metadata: { error: target.error } }
          const times = Array.isArray(args.times) ? args.times.filter((t: unknown) => Number.isFinite(Number(t))).map(Number).slice(0, 6) : undefined
          const spec = { file: target.file, times: times && times.length ? times : undefined, count: args.count ?? undefined, width: args.width ?? undefined, dir: outDir(context.sessionID) }
          const r = await run(opt.systemPython, ["-I", path.join(HERE, "frames.py")], JSON.stringify(spec), {}, opt.timeoutMs)
          const result = lastJson(r.out)
          if (!result || !result.ok) {
            const why = (result?.error as string) ?? r.err.trim().slice(-400) ?? "frames failed"
            return { title: "frames failed", output: `frames: could not inspect ${args.file}: ${why}`, metadata: { error: why } }
          }
          const vision = await attachImages(context.sessionID)
          const frames = (result.frames ?? []) as { png: string; time: number }[]
          const output = framesText(args.file, result, vision && frames.length > 0)
          return {
            title: `frames ${args.file}`,
            output,
            metadata: { probe: result.probe, frames: frames.map((f) => ({ time: f.time, png: f.png })), attached: vision && frames.length > 0 },
            attachments: vision ? frames.map((f) => ({ type: "file" as const, mime: "image/png", url: dataUrl(f.png), filename: path.basename(f.png) })) : undefined,
          }
        },
      }
    }
    return { tool: tools }
  },
}

export default plugin
