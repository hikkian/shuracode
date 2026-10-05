export type EditMatch = {
  kind: "exact" | "unique-whitespace" | "ambiguous-whitespace" | "nearby" | "none"
  matched?: string
  candidates?: string[]
  score?: number
}

const normalizeLine = (line: string) => line.replace(/\s+/g, " ").trim()

export function matchEditBlock(content: string, oldString: string): EditMatch {
  if (!oldString) return { kind: "none" }
  if (content.includes(oldString)) return { kind: "exact", matched: oldString, score: 1 }
  const source = content.replace(/\r\n/g, "\n").split("\n")
  const wanted = oldString.replace(/\r\n/g, "\n").split("\n")
  if (wanted.at(-1) === "") wanted.pop()
  const needle = wanted.map(normalizeLine)
  if (!needle.length) return { kind: "none" }
  const exact: string[] = []
  for (let start = 0; start <= source.length - needle.length; start++) {
    const window = source.slice(start, start + needle.length)
    if (window.map(normalizeLine).every((line, index) => line === needle[index])) exact.push(window.join("\n"))
  }
  if (exact.length === 1) return { kind: "unique-whitespace", matched: exact[0], candidates: exact, score: 1 }
  if (exact.length > 1) return { kind: "ambiguous-whitespace", candidates: exact.slice(0, 3), score: 1 }

  let best = ""
  let bestScore = -1
  const size = Math.min(Math.max(1, needle.length), source.length)
  for (let start = 0; start <= source.length - size; start++) {
    const window = source.slice(start, start + size)
    let equal = 0
    for (let i = 0; i < size; i++) if (normalizeLine(window[i]) === needle[i]) equal++
    const score = equal / Math.max(needle.length, size)
    if (score > bestScore) {
      bestScore = score
      best = window.join("\n")
    }
  }
  return best ? { kind: "nearby", matched: best, score: Math.max(0, bestScore) } : { kind: "none" }
}

export function stableArgs(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableArgs).join(",")}]`
  if (value && typeof value === "object") {
    const object = value as Record<string, unknown>
    return `{${Object.keys(object).sort().map(key => `${JSON.stringify(key)}:${stableArgs(object[key])}`).join(",")}}`
  }
  return JSON.stringify(value) ?? String(value)
}

export function isVerificationCommand(tool: string, args: unknown): boolean {
  if (!/^(bash|shell|terminal|command)$/i.test(tool)) return false
  const record = args && typeof args === "object" ? args as Record<string, unknown> : {}
  const command = String(record.command ?? record.cmd ?? record.script ?? "")
  return /\b(pytest|unittest|npm\s+(test|run\s+(test|build))|jest|go\s+test|cargo\s+test|gradle(w)?\s+(test|build)|cmake\s+--build|ctest|make\s+(test|check))\b/i.test(command)
}

export function isSuccessfulCheck(output: any): boolean {
  const metadata = output?.metadata ?? {}
  const code = metadata.exit ?? metadata.exitCode ?? metadata.code
  if (typeof code === "number") return code === 0
  const text = String(output?.output ?? metadata.output ?? "")
  return /\b(\d+ passed|all tests passed|build successful|build succeeded|tests? passed|ok\s+\S+\s+\d)/i.test(text)
    && !/\b(failed|error:|errors? occurred|tests? failed)\b/i.test(text)
}

export function isEditTool(name: string): boolean {
  return /^(edit|write|patch|apply_patch)$/i.test(name)
}

export function estimateTokens(text: string): number {
  // No model tokenizer is available in the hook. This conservative character estimate is surfaced in metadata.
  return Math.ceil(text.length / 4)
}

export function renderTaskCard(card: { goal: string; plan: string[]; done: string[]; next: string }): string {
  const lines = ["Task card", `Goal: ${card.goal || "not recorded"}`, "Plan:"]
  lines.push(...(card.plan.length ? card.plan.map((x, i) => `${i + 1}. ${x}`) : ["- not recorded"]))
  lines.push("Done:", ...(card.done.length ? card.done.map(x => `- ${x}`) : ["- not recorded"]), `Next: ${card.next || "not recorded"}`)
  return lines.join("\n")
}
