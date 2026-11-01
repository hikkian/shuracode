// RSI2E mechanism 3: mechanical preservation of the contract at compaction. The engine's summary is free text; this plugin appends the
// exact REQUIREMENTS.md and TASK_STATE.md to the compaction context (so the summarizer sees them verbatim) and, after compaction, pushes
// them again as system text for the next turns. Option: { compactPreserve: true }.
import type { PluginModule } from "@opencode-ai/plugin"
import path from "node:path"
import { logEvent, onLine, readText } from "./lib.ts"

const NAME = "compact-preserve"
const plugin: PluginModule & { id: string } = {
  id: "shuracode-rsi2-compact-preserve",
  server: async (input, options) => {
    const enabled = (options as any)?.compactPreserve === true
    if (!enabled) return {}
    const directory = String((input as any)?.directory ?? (input as any)?.worktree ?? process.cwd())
    const compacted = new Set<string>()
    const contract = async () => {
      const req = await readText(path.join(directory, "REQUIREMENTS.md"))
      const state = await readText(path.join(directory, "TASK_STATE.md"))
      return { req, state }
    }
    return {
      "experimental.chat.system.transform": async (hook: any, output: any) => {
        output.system.push(onLine(NAME))
        if (hook?.sessionID && compacted.has(hook.sessionID)) {
          const { req, state } = await contract()
          if (req) output.system.push(`The context was summarized. The user's contract, verbatim (REQUIREMENTS.md):\n${req}`)
          if (state) output.system.push(`Your task state on disk (TASK_STATE.md):\n${state}`)
        }
      },
      "experimental.session.compacting": async (hook: any, output: any) => {
        const { req, state } = await contract()
        const parts: string[] = []
        if (req) parts.push(`PRESERVE EXACTLY (do not paraphrase): the user's requirements:\n${req}`)
        if (state) parts.push(`PRESERVE EXACTLY: the task state file:\n${state}`)
        if (!parts.length) parts.push("PRESERVE EXACTLY: the user's original task text, every stated error type and message, every file path already verified to exist, the tests run and their results, and the next action.")
        output.context.push(...parts)
        compacted.add(hook.sessionID)
        await logEvent(directory, NAME, { event: "compacting", session: hook.sessionID, req_chars: req.length, state_chars: state.length })
      },
    }
  },
}
export default plugin
