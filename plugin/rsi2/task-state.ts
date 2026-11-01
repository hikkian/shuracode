// RSI2E mechanism 2: TASK_STATE.md, durable task memory on disk (goal, acceptance criteria, files touched, decisions, verification run,
// next action). The plugin seeds the file, tells the model to keep it, and counts the model's updates. Option: { taskState: true }.
import type { PluginModule } from "@opencode-ai/plugin"
import path from "node:path"
import { isEditTool, logEvent, onLine, targetFile, writeOnce } from "./lib.ts"

const NAME = "task-state"
const TEMPLATE = `# Goal
(one sentence)

# Acceptance criteria
- [ ] R1 ...

# Relevant code confirmed from disk
- 

# Decisions
- 

# Verification actually run
- 

# Remaining / unknown
- 

# Next action
(exactly one concrete action)
`
const plugin: PluginModule & { id: string } = {
  id: "shuracode-rsi2-task-state",
  server: async (input, options) => {
    const enabled = (options as any)?.taskState === true
    if (!enabled) return {}
    const directory = String((input as any)?.directory ?? (input as any)?.worktree ?? process.cwd())
    const file = path.join(directory, "TASK_STATE.md")
    const seeded = new Set<string>()
    return {
      "experimental.chat.system.transform": async (_in: any, output: any) => {
        output.system.push(onLine(NAME))
        output.system.push("TASK_STATE.md is your durable memory and overrides anything you remember from the chat. Before the first edit fill its Goal and Acceptance criteria from the task. After every completed subtask update the files changed, the decisions and the verification you actually ran, and write exactly one Next action. Re-read it after any context summary.")
      },
      "chat.message": async (hook: any) => {
        if (seeded.has(hook.sessionID)) return
        seeded.add(hook.sessionID)
        const written = await writeOnce(file, TEMPLATE)
        await logEvent(directory, NAME, { event: "seeded", session: hook.sessionID, written })
      },
      "tool.execute.after": async (hook: any) => {
        if (!isEditTool(hook.tool)) return
        if (targetFile(hook.args).endsWith("TASK_STATE.md")) await logEvent(directory, NAME, { event: "updated", session: hook.sessionID, tool: hook.tool })
      },
    }
  },
}
export default plugin
