// The tests a project shows the agent: its own test files and nothing else. The hidden tests of the eval harness are copied into
// `hidden_tests/` after the agent has finished, so that folder is never listed. Standard library only (no plugin package here),
// so the listing can be tested on its own (tests/visible-tests.test.mjs).
import { readdir, readFile } from "node:fs/promises"
import path from "node:path"

export const TEST_NAME = /^(test_.*\.py|.*_test\.py|.*\.test\.[cm]?[jt]sx?|.*\.spec\.[cm]?[jt]sx?)$/
const CODE = /\.(py|[cm]?[jt]sx?)$/
const SKIP_DIRS = new Set(["node_modules", ".git", "hidden_tests", "__pycache__", ".venv", "venv", "dist", "build", "target", ".tmp"])
export const MAX_FILES = 40
export const MAX_CHARS_PER_FILE = 4000
export const MAX_CHARS_TOTAL = 24000

export type VisibleTest = { path: string; chars: number; text: string; truncated: boolean }
export type Listing = { tests: VisibleTest[]; more: number; total: number }

// A test file is a file whose name says so, or any code file inside a `tests` or `test` folder.
export function isTestPath(rel: string): boolean {
  const parts = rel.split("/")
  const name = parts[parts.length - 1]
  if (TEST_NAME.test(name)) return true
  return parts.slice(0, -1).some((p) => p === "tests" || p === "test") && CODE.test(name)
}

async function walk(root: string, rel: string, depth: number, out: string[]): Promise<void> {
  if (depth > 6) return
  let entries
  try {
    entries = await readdir(path.join(root, rel), { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const child = rel ? `${rel}/${entry.name}` : entry.name
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name) && !entry.name.startsWith(".")) await walk(root, child, depth + 1, out)
    } else if (entry.isFile() && isTestPath(child)) {
      out.push(child)
    }
  }
}

export async function listVisibleTests(root: string, limit = MAX_FILES): Promise<Listing> {
  const found: string[] = []
  await walk(root, "", 0, found)
  found.sort()
  const tests: VisibleTest[] = []
  let total = 0
  for (const rel of found.slice(0, limit)) {
    let full = ""
    try {
      full = await readFile(path.join(root, rel), "utf8")
    } catch {
      continue
    }
    const room = MAX_CHARS_TOTAL - total
    if (room <= 0) break
    const cap = Math.min(MAX_CHARS_PER_FILE, room)
    const text = full.slice(0, cap)
    total += text.length
    tests.push({ path: rel, chars: full.length, text, truncated: full.length > cap })
  }
  return { tests, more: Math.max(0, found.length - tests.length), total: found.length }
}

// What the agent reads back from the tool.
export function renderVisibleTests(list: Listing): string {
  if (list.tests.length === 0) return "No test files are visible in this project. Read the task description and write the checks yourself."
  const head = `${list.total} visible test file(s)${list.more ? `; ${list.more} more not shown` : ""}. Treat them as the contract to satisfy.`
  const body = list.tests.map((t) => `--- ${t.path}${t.truncated ? " (truncated)" : ""}\n${t.text}`).join("\n\n")
  return `${head}\n\n${body}`
}
