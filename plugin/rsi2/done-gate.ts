// RSI2E mechanism 4: the "done" gate. When the agent stops after editing project files without a test command run AFTER its last edit,
// the gate sends one more user turn asking for that run (at most `doneGateNudges` times, default 2). Unlike the product's completion gate
// (any successful check in the task) this one requires the check to come after the LAST edit. Option: { doneGate: true }.
import type { PluginModule } from "@opencode-ai/plugin"
import { isEditTool, isTestCommand, logEvent, onLine } from "./lib.ts"

const NAME = "done-gate"
type S = { editsSinceTest: number; nudges: number; pending: boolean }
const plugin: PluginModule & { id: string } = {
  id: "shuracode-rsi2-done-gate",
  server: async (input, options) => {
    const enabled = (options as any)?.doneGate === true
    if (!enabled) return {}
    const maxNudges = Number((options as any)?.doneGateNudges ?? 2)
    const directory = String((input as any)?.directory ?? (input as any)?.worktree ?? process.cwd())
    const state = new Map<string, S>()
    const get = (id: string) => {
      let s = state.get(id)
      if (!s) { s = { editsSinceTest: 0, nudges: 0, pending: false }; state.set(id, s) }
      return s
    }
    return {
      "experimental.chat.system.transform": async (_in: any, output: any) => {
        output.system.push(onLine(NAME))
        output.system.push("You may not declare the task done while any edit came after your last test run: after the final edit, run the project's tests (or your probe script) once more and quote the result.")
      },
      "tool.execute.after": async (hook: any) => {
        const s = get(hook.sessionID)
        if (isEditTool(hook.tool)) s.editsSinceTest += 1
        else if (isTestCommand(hook.tool, hook.args)) s.editsSinceTest = 0
      },
      event: async ({ event }: any) => {
        if (event?.type !== "session.idle") return
        const id = event.properties?.sessionID
        if (!id) return
        const s = get(id)
        if (s.editsSinceTest === 0 || s.pending || s.nudges >= maxNudges) return
        s.nudges += 1
        s.pending = true
        await logEvent(directory, NAME, { event: "nudge", session: id, edits_since_test: s.editsSinceTest, nudge: s.nudges })
        try {
          await (input as any).client.session.promptAsync({
            path: { id },
            body: { parts: [{ type: "text", text: `[RSI2 done gate] ${s.editsSinceTest} edit(s) came after your last test run. Run the project's tests (or your probe) now, fix what fails, then finish.` }] },
          })
        } finally {
          s.pending = false
          s.editsSinceTest = 0
        }
      },
    }
  },
}
export default plugin
