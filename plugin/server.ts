// ShuraCode server plugin: the engine's built-in system prompt introduces the agent by the engine's name.
// Rename only those self-references; documentation links and config paths stay as they are, because they are
// real and still correct.
import type { PluginModule } from "@opencode-ai/plugin"
import { readdir, readFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { collectSkills, dateNote, renderSkills, replaceSkillsBlock, stableDateLine, stableModelLine, type SkillFile } from "./prefix-stability.ts"
import { sessionHeader } from "./session-header.ts"

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
      },
    }
  },
}

export default plugin
