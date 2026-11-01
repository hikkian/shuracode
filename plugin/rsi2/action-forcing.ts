// RSI2E mechanism 5: force an action after long reasoning. The engine gives no per-step reasoning count to plugins, so the mechanism is
// a hard cap on the output tokens of one step (reasoning + text + tool call) through chat.params: a step that would drift into tens of
// thousands of reasoning tokens (RSI1: 14-16k before the first write) is cut at `actionForcingMaxOutput` (default 6144), and the system
// text says what to do with the budget. Option: { actionForcing: true, actionForcingMaxOutput: 6144 }.
import type { PluginModule } from "@opencode-ai/plugin"
import { logEvent, onLine } from "./lib.ts"

const NAME = "action-forcing"
const plugin: PluginModule & { id: string } = {
  id: "shuracode-rsi2-action-forcing",
  server: async (input, options) => {
    const enabled = (options as any)?.actionForcing === true
    if (!enabled) return {}
    const cap = Number((options as any)?.actionForcingMaxOutput ?? 6144)
    const directory = String((input as any)?.directory ?? (input as any)?.worktree ?? process.cwd())
    const announced = new Set<string>()
    return {
      "experimental.chat.system.transform": async (_in: any, output: any) => {
        output.system.push(onLine(NAME))
        output.system.push(`Reason only until you know the next verifiable action, then act: a step has at most ${cap} output tokens. Once you have read the files you must change, your next step is a write or edit; do not draft whole files in your reasoning, and settle open questions by running code, not by thinking longer.`)
      },
      "chat.params": async (hook: any, output: any) => {
        const before = output.maxOutputTokens
        if (before === undefined || before > cap) output.maxOutputTokens = cap
        if (!announced.has(hook.sessionID)) {
          announced.add(hook.sessionID)
          await logEvent(directory, NAME, { event: "cap", session: hook.sessionID, before, cap })
        }
      },
    }
  },
}
export default plugin
