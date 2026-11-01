// RSI2E mechanism 1: REQUIREMENTS.md, the user's contract verbatim, written by the plugin from the first user message and never edited by
// the agent (an edit/write of it is refused). Option: { requirementsLock: true }.
import type { PluginModule } from "@opencode-ai/plugin"
import path from "node:path"
import { isEditTool, logEvent, onLine, targetFile, userText, writeOnce } from "./lib.ts"

const NAME = "requirements-lock"
const plugin: PluginModule & { id: string } = {
  id: "shuracode-rsi2-requirements-lock",
  server: async (input, options) => {
    const enabled = (options as any)?.requirementsLock === true
    if (!enabled) return {}
    const directory = String((input as any)?.directory ?? (input as any)?.worktree ?? process.cwd())
    const file = path.join(directory, "REQUIREMENTS.md")
    const seen = new Set<string>()
    return {
      "experimental.chat.system.transform": async (_in: any, output: any) => {
        output.system.push(onLine(NAME))
        output.system.push("REQUIREMENTS.md in the project root holds the user's task text verbatim. It is read-only: re-read it before you say the task is done, and check every clause in it against what you built.")
      },
      "chat.message": async (hook: any, output: any) => {
        if (seen.has(hook.sessionID)) return
        const text = userText(output.parts)
        if (!text.trim() || text.startsWith("[") ) return     // the stand's nudges start with a bracket; the first real message is the task
        seen.add(hook.sessionID)
        const written = await writeOnce(file, `# Requirements (verbatim, read-only)\n\n${text.trim()}\n`)
        await logEvent(directory, NAME, { event: "written", session: hook.sessionID, written, chars: text.length })
      },
      "tool.execute.before": async (hook: any, output: any) => {
        if (!isEditTool(hook.tool)) return
        const target = targetFile(output.args)
        if (path.resolve(directory, target) === file || target.endsWith("REQUIREMENTS.md")) {
          await logEvent(directory, NAME, { event: "refused-edit", session: hook.sessionID, tool: hook.tool })
          throw new Error("REQUIREMENTS.md is the user's contract and is read-only; keep your notes in TASK_STATE.md")
        }
      },
    }
  },
}
export default plugin
