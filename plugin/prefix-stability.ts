// Keeps the start of the prompt the same from one turn to the next, so the engine can reuse its cache (see
// reports/REPORT-CACHE1.md). Pure functions only: the server plugin does the file reading and the hook wiring.

export type SkillEntry = { name: string; description: string; location: string }
export type SkillFile = { location: string; text: string }

const SKILLS_BLOCK = /<available_skills>[\s\S]*?<\/available_skills>/
const DATE_LINE = /Today's date: [^\n<]*/

// Only what the skill list needs from the SKILL.md frontmatter: the name and the description.
export function frontmatter(text: string): { name?: string; description?: string } {
  const head = text.match(/^---\r?\n([\s\S]*?)\r?\n---/)
  if (!head) return {}
  const lines = head[1].split(/\r?\n/)
  const fields: Record<string, string> = {}
  for (let i = 0; i < lines.length; i++) {
    const field = lines[i].match(/^([A-Za-z_-]+):\s*(.*)$/)
    if (!field) continue
    let value = field[2].trim()
    if (/^[>|][-+]?$/.test(value)) {
      const parts: string[] = []
      while (i + 1 < lines.length && /^\s+\S/.test(lines[i + 1])) parts.push(lines[++i].trim())
      value = parts.join(value.startsWith(">") ? " " : "\n")
    } else if (value.length >= 2 && (value[0] === '"' || value[0] === "'") && value.at(-1) === value[0]) {
      value = value.slice(1, -1)
    }
    fields[field[1]] = value
  }
  return { name: fields.name, description: fields.description }
}

const inTrash = (location: string) => location.includes("/.trash/")

// One entry per skill name, sorted by name. Files under .trash are ignored (a skill that exists only there is not
// listed); between two copies the smaller path wins. The result does not depend on the order in which the files were found.
export function collectSkills(files: SkillFile[]): SkillEntry[] {
  const chosen = new Map<string, SkillEntry>()
  for (const file of files.filter((f) => !inTrash(f.location))) {
    const { name, description } = frontmatter(file.text)
    if (!name) continue
    const entry: SkillEntry = { name, description: description ?? "", location: file.location }
    const current = chosen.get(name)
    if (!current) {
      chosen.set(name, entry)
      continue
    }
    if (entry.location < current.location) chosen.set(name, entry)
  }
  return [...chosen.values()].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
}

// The same layout the engine uses for the skill list, so the model reads it the same way.
export function renderSkills(entries: SkillEntry[]): string {
  const items = entries.map(
    (e) => `  <skill>\n    <name>${e.name}</name>\n    <description>${e.description}</description>\n    <location>${e.location}</location>\n  </skill>`,
  )
  return `<available_skills>\n${items.join("\n")}\n</available_skills>`
}

// Replaces the engine's skill list inside one system text; other texts are returned unchanged.
export function replaceSkillsBlock(system: string, rendered: string): string {
  return SKILLS_BLOCK.test(system) ? system.replace(SKILLS_BLOCK, () => rendered) : system
}

// The date leaves the system text: the same wording every day, so the start of the prompt does not change at midnight.
// The real date is written into the user's message once per day (see dateNote), where it stays after that.
export function stableDateLine(system: string): string {
  return system.replace(DATE_LINE, () => "Today's date: given in the user's messages")
}

// The engine names the model in one line of its prompt ("You are powered by the model named …"). The name is kept in a
// user message instead (see the chat.message hook), so this line stays the same across model switches.
const MODEL_LINE = /You are powered by the model named [^\n]*\n/
export function stableModelLine(system: string): string {
  return system.replace(MODEL_LINE, () => "You are powered by the model named in the [Model: …] note of the conversation.\n")
}

export function dateNote(now: Date): string {
  return `Today's date: ${now.toDateString()}`
}
