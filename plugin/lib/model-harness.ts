// The per-model harness (RSI): which harness folder a model id uses, and the pointer to its skills. Standard library only, so it can be
// tested on its own.
import { readdir, readFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"

export const MODEL_KEYS = ["tiel", "sage", "gemma"] as const
export type ModelKey = (typeof MODEL_KEYS)[number]

// The model ids the engine reports: the provider's model name (e.g. "tiel-coder", "sage", "gemma"). Anything else gets no harness.
export function harnessKeyFor(modelId: string | undefined): ModelKey | null {
  const id = (modelId ?? "").toLowerCase()
  for (const key of MODEL_KEYS) {
    if (id.includes(key)) return key
  }
  return null
}

// The frontmatter of a SKILL.md: `key: value` lines between two `---` lines.
export function frontmatter(text: string): Record<string, string> {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---/)
  const out: Record<string, string> = {}
  if (!m) return out
  for (const line of m[1].split(/\r?\n/)) {
    const kv = line.match(/^([A-Za-z_-]+):\s*(.*)$/)
    if (kv) out[kv[1]] = kv[2].trim()
  }
  return out
}

// The skills of one model's folder as a pointer: name, description, the SKILL.md file, and the scripts of the skill. The body of a
// skill is not in the text: the model reads the file itself when the situation comes up (as with the engine's own skills). A skill
// without `name` (equal to its directory) and `description` is not listed. The text is the same on every request while the folder is
// unchanged, so it does not move the prompt prefix between turns.
export async function skillsPointer(modelDir: string): Promise<string> {
  const skillsDir = path.join(modelDir, "skills")
  let dirs: string[] = []
  try {
    dirs = (await readdir(skillsDir, { withFileTypes: true })).filter((d) => d.isDirectory()).map((d) => d.name).sort()
  } catch {
    return ""
  }
  const lines: string[] = []
  for (const dir of dirs) {
    const file = path.join(skillsDir, dir, "SKILL.md")
    const fm = frontmatter(await readFile(file, "utf8").catch(() => ""))
    if (fm.name !== dir || !fm.description) continue
    let scripts: string[] = []
    try {
      scripts = (await readdir(path.join(skillsDir, dir, "scripts"))).sort().map((s) => path.join(skillsDir, dir, "scripts", s))
    } catch {
      scripts = []
    }
    const where = scripts.length ? `; scripts: ${scripts.join(", ")}` : ""
    lines.push(`- ${fm.name}: ${fm.description} (file: ${file}${where})`)
  }
  return lines.length ? "Skills of this model (read the SKILL.md of a skill when its situation comes up):\n" + lines.join("\n") : ""
}

// `~/x` -> the home folder (the config template names the personal layer that way).
export function expandHome(p: string): string {
  if (p === "~") return os.homedir()
  if (p.startsWith("~/")) return path.join(os.homedir(), p.slice(2))
  return p
}

// The folder of a model's personal layer: <userHarnessDir>/<model>/, or, when a CURRENT file names a version (LL4b: versions/NNN/),
// that version's folder. A CURRENT that names nothing usable falls back to the model folder itself.
export async function personalLayerDir(modelDir: string): Promise<string> {
  const current = (await readFile(path.join(modelDir, "CURRENT"), "utf8").catch(() => "")).trim()
  if (!current || current.includes("..") || path.isAbsolute(current) || current.includes("/")) return modelDir
  const versioned = path.join(modelDir, "versions", current)
  try {
    await readFile(path.join(versioned, "harness.md"), "utf8")
    return versioned
  } catch {
    return modelDir
  }
}
