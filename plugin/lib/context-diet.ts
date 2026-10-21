// ShuraCode context diet (MASK1): the outputs of old tool calls are replaced by a short stub once the dialogue passes a size threshold.
// The replacement then stays for the rest of the session: a prompt prefix that changes between turns would break the model's cache.
// Standard library only, so it can be tested on its own. The plugin (plugin/context-diet.ts) keeps the masked set per session.

export type DietOptions = { maskStartChars: number; keepLastTools: number; minChars: number }

export const DEFAULTS: DietOptions = { maskStartChars: 60000, keepLastTools: 8, minChars: 300 }

// the engine's message: {info, parts}
export type Message = { info: any; parts: any[] }

export function optionsFrom(raw: Record<string, unknown> | undefined): DietOptions {
  const num = (v: unknown, d: number) => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : d)
  return {
    maskStartChars: num(raw?.maskStartChars, DEFAULTS.maskStartChars),
    keepLastTools: Math.floor(num(raw?.keepLastTools, DEFAULTS.keepLastTools)),
    minChars: num(raw?.minChars, DEFAULTS.minChars),
  }
}

export function stubFor(chars: number): string {
  return `[tool output elided: ${chars} chars; run the tool again if needed]`
}

// only a completed tool call with a text output can be masked
function maskable(part: any): boolean {
  return part?.type === "tool" && part.state?.status === "completed" && typeof part.state.output === "string"
}

// The ids to mask now: the old, long tool outputs (older than the last `keepLastTools` tool calls, longer than `minChars`, not yet
// masked). They are masked as one batch once their total passes maskStartChars, so the prompt prefix changes once per batch, not on
// every turn. The trigger counts only what can be masked: the protected window is never masked, so counting it would mask on every
// turn once the window alone is over the threshold (found by the stand in reports/mask1/, first version).
export function newMasks(messages: Message[], masked: Set<string>, o: DietOptions): string[] {
  const tools = messages.flatMap((m) => m.parts).filter(maskable)
  const recent = new Set(tools.slice(Math.max(0, tools.length - o.keepLastTools)).map((p) => p.id))
  const candidates = tools.filter((p) => !recent.has(p.id) && !masked.has(p.id) && p.state.output.length > o.minChars)
  const removable = candidates.reduce((sum, p) => sum + p.state.output.length, 0)
  return removable > o.maskStartChars ? candidates.map((p) => p.id) : []
}

// The messages with the masked outputs replaced by the stub. The stored parts are not changed: a masked part is a new object.
export function applyMasks(messages: Message[], masked: Set<string>): Message[] {
  return messages.map((m) => ({
    info: m.info,
    parts: m.parts.map((p) =>
      maskable(p) && masked.has(p.id) ? { ...p, state: { ...p.state, output: stubFor(p.state.output.length) } } : p,
    ),
  }))
}
