// ShuraCode server plugin: the engine's built-in system prompt introduces the agent by the engine's name.
// Rename only those self-references; documentation links and config paths stay as they are, because they are
// real and still correct.
import type { PluginModule } from "@opencode-ai/plugin"
import { readdir, readFile } from "node:fs/promises"
import os, { tmpdir } from "node:os"
import path, { dirname, join } from "node:path"
import { collectSkills, dateNote, renderSkills, replaceSkillsBlock, stableDateLine, stableModelLine, type SkillFile } from "./prefix-stability.ts"
import { sessionHeader } from "./session-header.ts"
import { fileURLToPath } from "node:url"
import { execFileSync } from "node:child_process"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"

// Exact text from attached images. The vision model reads layout well but loses characters in small print (a 12-digit
// number came back with one digit missing in every run). When tesseract is installed, the text of every attached image is
// read once when the message arrives and added to that message as an extra text part. It is stored with the message, so
// the prompt stays byte-identical on later turns (prefix cache). Without tesseract nothing changes.
function ocrImage(url: string, filename?: string): string | undefined {
  let tmp: string | undefined
  try {
    let file: string
    if (url.startsWith("file://")) file = fileURLToPath(url)
    else if (url.startsWith("data:")) {
      const m = /^data:[^;,]*;base64,(.*)$/s.exec(url)
      if (!m) return undefined
      tmp = mkdtempSync(join(tmpdir(), "shura-ocr-"))
      file = join(tmp, "image")
      writeFileSync(file, Buffer.from(m[1], "base64"))
    } else return undefined
    // 2x upscale + grey + normalise before OCR: on the test page this took small digits and titles from partly wrong to all correct
    let src = file
    try {
      tmp = tmp ?? mkdtempSync(join(tmpdir(), "shura-ocr-"))
      const prepared = join(tmp, "prepared.png")
      execFileSync("magick", [file, "-resize", "200%", "-colorspace", "Gray", "-normalize", prepared], { timeout: 30000, stdio: "ignore" })
      src = prepared
    } catch {}
    const out = execFileSync("tesseract", [src, "-", "-l", "rus+eng", "--psm", "6"], { timeout: 60000, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim()
    return out ? out.slice(0, 4000) : undefined
  } catch {
    return undefined
  } finally {
    if (tmp) rmSync(tmp, { recursive: true, force: true })
  }
}

// Directory with safe `pkill` / `pgrep` wrappers (they add --ignore-ancestors). The engine runs every shell command as
// `bash -c "<command>"`, so the command text sits in that shell's own command line and `pkill -f "<pattern from the
// command>"` kills the very shell that runs it: the tool then hangs until its 120 s timeout and the model, not knowing
// why, repeats the whole check. Putting the wrappers first on PATH removes the trap for every model and every task.
const SAFE_BIN = join(dirname(fileURLToPath(import.meta.url)), "..", "safe-bin")
const REPLACEMENTS: [RegExp, string][] = [
  [/Get help with using opencode\b/g, "Get help with using ShuraCode"],
  [/https:\/\/github\.com\/anomalyco\/opencode\/issues/g, "https://github.com/hikkian/shuracode/issues"],
  [/asks about opencode \(eg 'can opencode do\.\.\.', 'does opencode have\.\.\.'\)/g,
    "asks about ShuraCode (eg 'can ShuraCode do...', 'does ShuraCode have...')"],
  [/from opencode docs at https:\/\/opencode\.ai/g, "from the engine documentation at https://opencode.ai"],
]

// ShuraCode is the agent. The model's name is not in this sentence any more: it would change the start of the prompt at
// every model switch (REPORT-CACHE1.md). The model is named in the user's message instead (see the chat.message hook).
export function rebrand(text: string): string {
  return REPLACEMENTS.reduce((out, [pattern, value]) => out.replace(pattern, value), text)
    .replace(/\bYou are opencode,/g, "You are ShuraCode,")
}

// Every SKILL.md under the skills folder, nested folders included (the engine reads the same places).
async function scanSkillFiles(root: string, depth = 0): Promise<SkillFile[]> {
  let entries
  try {
    entries = await readdir(root, { withFileTypes: true })
  } catch {
    return []
  }
  const found: SkillFile[] = []
  for (const entry of entries) {
    if (entry.isDirectory() && entry.name === ".trash") continue
    const full = path.join(root, entry.name)
    if (entry.isDirectory() && depth < 4) found.push(...(await scanSkillFiles(full, depth + 1)))
    else if (entry.isFile() && entry.name === "SKILL.md") found.push({ location: full, text: await readFile(full, "utf8").catch(() => "") })
  }
  return found
}

// Compaction: the request that writes the summary re-reads the whole old conversation on this machine
// (about 450 tokens/s), so its size is the waiting time. The summary needs decisions, state and file names, not
// the model's old reasoning or whole files it has read or written; those can be read again. The flag is set by
// the "compacting" hook and used once by the "messages.transform" call that follows it in the engine.
const KEEP_CHARS = 1500
let compactingSince = 0

function clip(text: string, keep = KEEP_CHARS): string {
  return text.length <= keep ? text : `${text.slice(0, keep)}\n[... ${text.length - keep} more characters left out of this summary request]`
}

export function slimForCompaction(messages: any[]): void {
  for (const message of messages) {
    if (!Array.isArray(message?.parts)) continue
    message.parts = message.parts.filter((part: any) => part?.type !== "reasoning")
    for (const part of message.parts) {
      if (part?.type !== "tool" || !part.state) continue
      if (typeof part.state.output === "string") part.state.output = clip(part.state.output)
      const input = part.state.input
      if (input && typeof input === "object") {
        for (const key of Object.keys(input)) if (typeof input[key] === "string") input[key] = clip(input[key])
      }
    }
  }
}

const plugin: PluginModule & { id: string } = {
  id: "shuracode-server",
  server: async (_input, options) => {
    const given = (options as { skillsRoot?: string } | undefined)?.skillsRoot
    const root = given === undefined ? path.join(os.homedir(), ".local", "share", "shura", "skills") : given.startsWith("~/") ? path.join(os.homedir(), given.slice(2)) : given
    // The skill list is read once per process, so it cannot change between turns (see prefix-stability.ts).
    let skills: Promise<string> | undefined
    // The date and the model go into a user message when they change; the message keeps them, so they never move.
    const noted = new Map<string, { date: string; model: string }>()
    // The note is added to the user's own text: the engine assigns ids to parts before this hook runs, so a new part
    // made here would not be valid (it failed with UnknownError in the bisect, REPORT-CACHE2.md).
    const note = (text: string, parts: { type: string; text?: string }[]) => {
      const first = parts.find((part) => part.type === "text")
      if (first) first.text = `${first.text ?? ""}\n${text}`
    }
    return {
      "shell.env": async (_input, output) => {
        output.env.PATH = `${SAFE_BIN}:${output.env.PATH ?? process.env.PATH ?? ""}`
      },
      "experimental.chat.system.transform": async (_input, output) => {
        skills ??= scanSkillFiles(root).then((files) => renderSkills(collectSkills(files)))
        const list = await skills
        // edit in place: the engine keeps using the same array after the hook returns
        output.system.forEach((text, i) => {
          output.system[i] = replaceSkillsBlock(stableModelLine(stableDateLine(rebrand(text))), list)
        })
      },
      // Session cache: the gateway keys its snapshot by this header (SESS2b). Set per engine session, no personal data.
      "chat.headers": async (input, output) => {
        const id = sessionHeader(String(input.sessionID ?? ""))
        if (id) output.headers["X-Shura-Session"] = id
      },
      "chat.message": async (input, output) => {
        const date = dateNote(new Date())
        // the same id the engine itself prints in its prompt: provider/model
        const model = input.model?.modelID ? `${input.model.providerID ?? ""}${input.model.providerID ? "/" : ""}${input.model.modelID}`.trim() : ""
        const before = noted.get(input.sessionID) ?? { date: "", model: "" }
        const parts: string[] = []
        if (before.date !== date) parts.push(`[${date}]`)
        if (model && before.model !== model) parts.push(`[Model: ${model}]`)
        noted.set(input.sessionID, { date, model: model || before.model })
        if (parts.length) note(parts.join(" "), output.parts as { type: string; text?: string }[])
        // OCR of attached images (added to the message, so the prefix stays stable on later turns)
        const extra: any[] = []
        for (const p of output.parts as any[]) {
          if (p.type !== "file" || !String(p.mime ?? "").startsWith("image/") || !p.url) continue
          const text = ocrImage(p.url, p.filename)
          if (!text) continue
          extra.push({
            id: `${p.id}_ocr`, sessionID: p.sessionID, messageID: p.messageID, type: "text", synthetic: true,
            text: `[Text read from the attached image${p.filename ? " " + p.filename : ""} by OCR. It is usually exact for digits, codes and names; layout and symbols such as currency signs may be off. Where it and the picture disagree, look at that spot of the picture again. The picture itself is attached too.]\n${text}`,
          })
        }
        output.parts.push(...extra)
      },
      "experimental.session.compacting": async () => {
        compactingSince = Date.now()
      },
      "experimental.chat.messages.transform": async (_input, output) => {
        if (!compactingSince) return
        const fresh = Date.now() - compactingSince < 30_000
        compactingSince = 0
        try {
          if (fresh) slimForCompaction(output.messages as any[])
        } catch {
          // never break a compaction because of the optimisation
        }
      },
    }
  },
}

export default plugin
