// ShuraCode server plugin: the engine's built-in system prompt introduces the agent by the engine's name.
// Rename only those self-references; documentation links and config paths stay as they are, because they are
// real and still correct.
import type { PluginModule } from "@opencode-ai/plugin"
import { readdir, readFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { collectSkills, renderSkills, replaceSkillsBlock, type SkillFile } from "./prefix-stability.ts"

const REPLACEMENTS: [RegExp, string][] = [
  [/Get help with using opencode\b/g, "Get help with using ShuraCode"],
  [/https:\/\/github\.com\/anomalyco\/opencode\/issues/g, "https://github.com/hikkian/shuracode/issues"],
  [/asks about opencode \(eg 'can opencode do\.\.\.', 'does opencode have\.\.\.'\)/g,
    "asks about ShuraCode (eg 'can ShuraCode do...', 'does ShuraCode have...')"],
  [/from opencode docs at https:\/\/opencode\.ai/g, "from the engine documentation at https://opencode.ai"],
]

// ShuraCode is the agent; the model is what it runs on. Name both, taking the model from the config, so the
// answer to "who are you?" stays true if the model changes.
export function rebrand(text: string, model?: string): string {
  const name = (model ?? "").replace(/\s*\(.*\)\s*$/, "").trim()
  const intro = name ? `You are ShuraCode, running fully locally on the ${name} model,` : "You are ShuraCode,"
  return REPLACEMENTS.reduce((out, [pattern, value]) => out.replace(pattern, value), text)
    .replace(/\bYou are opencode,/g, intro)
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
    const full = path.join(root, entry.name)
    if (entry.isDirectory() && depth < 4) found.push(...(await scanSkillFiles(full, depth + 1)))
    else if (entry.isFile() && entry.name === "SKILL.md") found.push({ location: full, text: await readFile(full, "utf8").catch(() => "") })
  }
  return found
}

const plugin: PluginModule & { id: string } = {
  id: "shuracode-server",
  server: async (_input, options) => {
    const root = (options as { skillsRoot?: string } | undefined)?.skillsRoot ?? path.join(os.homedir(), ".agents", "skills")
    // The skill list is read once per process, so it cannot change between turns (see prefix-stability.ts).
    let skills: Promise<string> | undefined
    return {
      "experimental.chat.system.transform": async (input, output) => {
        skills ??= scanSkillFiles(root).then((files) => renderSkills(collectSkills(files)))
        const list = await skills
        // edit in place: the engine keeps using the same array after the hook returns
        output.system.forEach((text, i) => {
          output.system[i] = replaceSkillsBlock(rebrand(text, input.model?.name), list)
        })
      },
    }
  },
}

export default plugin
