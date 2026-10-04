import type { PluginModule } from "@opencode-ai/plugin"
import { stableArgs } from "./core.ts"

type SessionLoop = { previous?: string; consecutive: number; warning?: string }

const plugin: PluginModule & { id: string } = {
  id: "shuracode-loop-detector",
  server: async (_input, options) => {
    const sessions = new Map<string, SessionLoop>()
    const calls = new Map<string, { sessionID: string; repeated: boolean }>()
    const enabled = (options as any)?.loopDetector === true
    return {
      "tool.execute.before": async (input, output) => {
        if (!enabled) return
        let state = sessions.get(input.sessionID)
        if (!state) {
          state = { consecutive: 0 }
          sessions.set(input.sessionID, state)
        }
        const fingerprint = `${input.tool}\u0000${stableArgs(output.args)}`
        state.consecutive = fingerprint === state.previous ? state.consecutive + 1 : 1
        state.previous = fingerprint
        const repeated = state.consecutive >= 3
        if (repeated) {
          state.warning = `The same ${input.tool} call with identical arguments has repeated ${state.consecutive} times. Stop repeating it; inspect the latest output and choose a different approach.`
        }
        calls.set(input.callID, { sessionID: input.sessionID, repeated })
      },
      "tool.execute.after": async (input, output) => {
        if (!enabled) return
        const call = calls.get(input.callID)
        calls.delete(input.callID)
        if (!call?.repeated) return
        const warning = sessions.get(call.sessionID)?.warning
        if (!warning) return
        output.output = `${output.output ?? ""}\n\n[Shura loop detector] ${warning}`
        if (output.metadata && typeof output.metadata === "object") {
          // The 1.18.32 bash renderer reads this snapshot instead of output.output.
          if (typeof output.metadata.output === "string") output.metadata.output = output.output
        }
      },
      event: async ({ event }) => {
        if (!enabled || event.type !== "message.part.updated") return
        const part = (event as any).properties?.part
        if (part?.type !== "tool" || part.state?.status !== "error") return
        const call = calls.get(part.callID)
        if (!call?.repeated) return
        calls.delete(part.callID)
        const state = sessions.get(call.sessionID)
        if (state) state.warning = `The same ${part.tool} call with identical arguments repeated and failed. Read the error output and choose a different approach.`
      },
      "experimental.chat.system.transform": async (input, output) => {
        if (!enabled || !input.sessionID) return
        const state = sessions.get(input.sessionID)
        if (!state?.warning) return
        output.system.push(`[Shura loop detector]\n${state.warning}`)
        state.warning = undefined
      },
    }
  },
}

export default plugin
