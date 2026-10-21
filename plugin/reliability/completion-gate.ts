import type { PluginModule } from "@opencode-ai/plugin"
import { isEditTool, isSuccessfulCheck, isVerificationCommand } from "./core.ts"

type GateState = { changed: boolean; verified: boolean; nudges: number; pending: boolean }

function userText(parts: any[]): string {
  return (parts ?? []).filter(part => part?.type === "text").map(part => String(part.text ?? "")).join("\n")
}

const plugin: PluginModule & { id: string } = {
  id: "shuracode-completion-gate",
  server: async (input, options) => {
    const enabled = (options as any)?.completionGate === true
    const state = new Map<string, GateState>()
    const get = (sessionID: string) => {
      let value = state.get(sessionID)
      if (!value) {
        value = { changed: false, verified: false, nudges: 0, pending: false }
        state.set(sessionID, value)
      }
      return value
    }
    return {
      "chat.message": async (hook, output) => {
        if (!enabled) return
        const text = userText(output.parts)
        if (text.startsWith("[Shura completion gate]")) return
        state.set(hook.sessionID, { changed: false, verified: false, nudges: 0, pending: false })
      },
      "tool.execute.after": async (hook, output) => {
        if (!enabled) return
        const value = get(hook.sessionID)
        if (isEditTool(hook.tool)) value.changed = true
        if (isVerificationCommand(hook.tool, hook.args) && isSuccessfulCheck(output)) value.verified = true
      },
      event: async ({ event }) => {
        if (!enabled || event.type !== "session.idle") return
        const sessionID = (event as any).properties?.sessionID
        if (!sessionID) return
        const value = get(sessionID)
        if (!value.changed || value.verified || value.pending || value.nudges >= 2) return
        value.nudges += 1
        value.pending = true
        try {
          await input.client.session.promptAsync({
            path: { id: sessionID },
            body: {
              parts: [{
                type: "text",
                text: `[Shura completion gate] You changed project files but no successful test/build has completed in this task. Run the most relevant verification command, inspect its full output, fix failures, and report the result. Do not claim success until it passes. Reminder ${value.nudges}/2.`,
              }],
            },
          })
        } finally {
          value.pending = false
        }
      },
    }
  },
}

export default plugin
