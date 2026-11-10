// RSI2E: shared pieces of the mechanism plugins. Every mechanism (1) is off unless its own option flag is true, (2) announces itself with
// one system line `shuracode-rsi2:<name>: on` so the stand can prove delivery from the request bodies, and (3) appends an event line to
// <project>/.harness/events/<name>.jsonl every time it acts, so a run can prove the mechanism fired (RSI2D: no silent A/A again).
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises"
import path from "node:path"

export const PREFIX = "shuracode-rsi2:"

export function onLine(name: string): string {
  return `${PREFIX}${name}: on`
}

export async function logEvent(directory: string, name: string, event: Record<string, unknown>): Promise<void> {
  try {
    const dir = path.join(directory, ".harness", "events")
    await mkdir(dir, { recursive: true })
    await appendFile(path.join(dir, `${name}.jsonl`), JSON.stringify({ t: Date.now(), ...event }) + "\n")
  } catch {}
}

export async function readText(file: string): Promise<string> {
  return readFile(file, "utf8").catch(() => "")
}

export async function writeOnce(file: string, text: string): Promise<boolean> {
  const existing = await readText(file)
  if (existing) return false
  await writeFile(file, text, "utf8")
  return true
}

// The server plugin appends "[Today's date: ...] [Model: ...]" to the person's message (prefix-stability, cache);
// it is not the person's own words, so memory capture and the other readers drop it.
const SERVER_NOTE = /\n(?:\[Today's date: [^\]\n]*\])?(?: ?\[Model: [^\]\n]*\])?$/

export function userText(parts: any[]): string {
  return (parts ?? []).filter((p: any) => p?.type === "text").map((p: any) => String(p.text ?? "").replace(SERVER_NOTE, "")).join("\n")
}

const EDIT_TOOLS = new Set(["edit", "write", "patch", "multiedit", "apply_patch"])
export function isEditTool(tool: string): boolean {
  return EDIT_TOOLS.has(String(tool ?? "").toLowerCase())
}

const TEST_RE = /\b(pytest|unittest|npm test|node --test|node\s+\S*test|jest|vitest|cargo test|go test|make test|bash .*test|\.\/?\.tmp\/\S*(test|probe|check))/i
export function isTestCommand(tool: string, args: any): boolean {
  if (String(tool ?? "").toLowerCase() !== "bash") return false
  return TEST_RE.test(String(args?.command ?? ""))
}

export function targetFile(args: any): string {
  return String(args?.filePath ?? args?.file_path ?? args?.path ?? "")
}
